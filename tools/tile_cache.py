#!/usr/bin/env python3
"""Same-origin raster tile cache for the Dashboard basemap.

The browser never contacts a tile provider. Every basemap style requests
``GET /api/tiles/<source>/<z>/<x>/<y>`` from the console, and this module
answers from a disk cache or fetches the tile once from the source's upstream:

* the upstream URL templates are fixed in ``TILE_SOURCES`` below: at most two
  HTTPS hosts per source, tried one at a time, no redirects, a 5 s socket
  timeout, a 1 MiB body cap and only ``image/png``, ``image/jpeg`` or
  ``image/webp`` bodies whose bytes match that type. Nothing from the browser
  request (query, cookies, referrer) is forwarded;
* a cached tile is fresh for ``max(upstream max-age, 7 days)``, capped at 30
  days, and is served without any network request while fresh. A stale tile
  is fetched again (conditionally when the upstream sent an ETag or
  Last-Modified) and, when the upstream cannot be reached, served stale, so a
  console that lost its uplink keeps every area it has shown before. A tile
  that was never cached answers 504;
* a host that fails is skipped for ``HOST_BACKOFF_S``, so an offline console
  answers uncached tiles at once instead of waiting on timeouts. At most
  ``MAX_CONCURRENT_FETCHES`` upstream requests run at a time, and concurrent
  requests for one tile share one fetch;
* writes are atomic (temporary file, then rename), error bodies are never
  stored, and the cache stays under its size limit by removing the least
  recently used tiles. Tiles are cached as they are viewed; there is no bulk
  or area download, which the providers' tile usage policies forbid.

Outbound requests use the standard environment proxy (``HTTPS_PROXY``,
``NO_PROXY``) through ``urllib``, like any other command-line HTTP client on
the host, and identify themselves as ``SDR-DoA-Ground-Console/<version>``.
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import math
import os
import re
import ssl
import tempfile
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple
from urllib.parse import urlsplit

TILE_ROUTE_PREFIX = "/api/tiles/"
DEFAULT_TILE_CACHE_DIR = Path.home() / ".cache" / "sdr-doa-ground-console" / "tiles"
DEFAULT_TILE_CACHE_MAX_MB = 512
MAX_TILE_CACHE_MB = 1024 * 1024

TILE_FRESH_MIN_S = 7 * 24 * 3600
TILE_FRESH_MAX_S = 30 * 24 * 3600
UPSTREAM_TIMEOUT_S = 5.0
# One host gets at most this long in total, so a host that trickles bytes
# cannot hold a request open past the socket timeout.
UPSTREAM_DEADLINE_S = 10.0
MAX_TILE_BYTES = 1024 * 1024
HOST_BACKOFF_S = 30.0
MAX_CONCURRENT_FETCHES = 4
# A request waits this long for a free upstream slot before it gives up.
FETCH_SLOT_WAIT_S = 10.0
# What the browser may keep. The disk cache is the real one; a short browser
# lifetime lets a map that was offline pick up fresh tiles soon after.
BROWSER_MAX_AGE_S = 600
BROWSER_STALE_MAX_AGE_S = 60
# A cache hit moves the file's mtime (the LRU clock) at most this often.
TOUCH_INTERVAL_S = 300.0
# Eviction removes tiles until the cache is this fraction of its limit.
EVICT_TO_FRACTION = 0.9

ALLOWED_CONTENT_TYPES = ("image/png", "image/jpeg", "image/webp")
_FILE_MAGIC = b"SDRTILE1\n"
_MAX_HEADER_BYTES = 2048
_SOURCE_ID_RE = re.compile(r"[a-z][a-z0-9-]{0,31}")
# Canonical decimal numbers only, so one tile has one cache file.
_TILE_PATH_RE = re.compile(
    r"/api/tiles/([a-z][a-z0-9-]{0,31})/(0|[1-9][0-9]?)/(0|[1-9][0-9]{0,6})/(0|[1-9][0-9]{0,6})"
)
_MAX_AGE_RE = re.compile(r"(?:^|[,\s])max-age\s*=\s*\"?([0-9]{1,12})", re.IGNORECASE)
_VALIDATOR_RE = re.compile(r"[\x21-\x7e][\x20-\x7e]{0,254}")


@dataclass(frozen=True)
class TileSource:
    """One upstream tile set: its id in the route and up to two URL templates."""

    id: str
    templates: Tuple[str, ...]
    maxzoom: int


# The only upstreams the console contacts. Ids and maxzoom must match
# TILE_SOURCES in frontend/src/lib/basemaps.ts (tools/test_basemap_contract.py).
# Each source lists its hosts in the order they are tried. Esri's MapServer
# tiles are addressed {z}/{y}/{x}.
TILE_SOURCES: Dict[str, TileSource] = {
    source.id: source
    for source in (
        TileSource(
            "osm",
            (
                # Tried first: some networks refuse tile.openstreetmap.org.
                "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
                "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
            ),
            19,
        ),
        TileSource(
            "hot",
            (
                "https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
                "https://b.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
            ),
            19,
        ),
        TileSource(
            "imagery",
            (
                "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
                "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            ),
            18,
        ),
        TileSource(
            "imagery-labels",
            (
                "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
                "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
            ),
            18,
        ),
        TileSource(
            "topo",
            (
                "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
                "https://b.tile.opentopomap.org/{z}/{x}/{y}.png",
            ),
            17,
        ),
    )
}


def _is_loopback_literal(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def validate_template(template: str) -> str:
    """Refuse anything but a plain HTTPS tile template.

    Plain HTTP is accepted only for a loopback IP literal, which is how the
    tests and a local QA launcher put a fake upstream behind the console.
    """
    if not isinstance(template, str) or len(template) > 512:
        raise ValueError("tile template must be a string of at most 512 characters")
    parts = urlsplit(template)
    host = parts.hostname or ""
    if parts.scheme == "https" and host:
        pass
    elif parts.scheme == "http" and _is_loopback_literal(host):
        pass
    else:
        raise ValueError(f"tile template must use https: {template!r}")
    if parts.username or parts.password or parts.query or parts.fragment or "?" in template or "#" in template:
        raise ValueError(f"tile template must not carry credentials, a query or a fragment: {template!r}")
    for name in ("{z}", "{x}", "{y}"):
        if parts.path.count(name) != 1:
            raise ValueError(f"tile template needs exactly one {name}: {template!r}")
    if re.search(r"\{(?![zxy]\})", parts.path) or any(ch.isspace() for ch in template):
        raise ValueError(f"tile template has an unknown placeholder: {template!r}")
    return template


def validate_sources(sources: Mapping[str, TileSource]) -> Dict[str, TileSource]:
    checked: Dict[str, TileSource] = {}
    for key, source in sources.items():
        if not isinstance(source, TileSource) or key != source.id or _SOURCE_ID_RE.fullmatch(key) is None:
            raise ValueError(f"tile source {key!r} is not a TileSource with the same id")
        if not 1 <= len(source.templates) <= 2:
            raise ValueError(f"tile source {key!r} needs one or two templates")
        if not isinstance(source.maxzoom, int) or not 0 <= source.maxzoom <= 22:
            raise ValueError(f"tile source {key!r} maxzoom must be 0..22")
        for template in source.templates:
            validate_template(template)
        checked[key] = source
    return checked


def parse_tile_path(path: str) -> Optional[Tuple[str, int, int, int]]:
    """``(source, z, x, y)`` for a well-formed route path, else None (no range check)."""
    match = _TILE_PATH_RE.fullmatch(path)
    if match is None:
        return None
    return match.group(1), int(match.group(2)), int(match.group(3)), int(match.group(4))


def fresh_seconds(cache_control: Optional[str]) -> int:
    """How long a tile stays fresh: max(upstream max-age, 7 days), at most 30 days."""
    max_age = 0
    if cache_control:
        match = _MAX_AGE_RE.search(cache_control)
        if match:
            max_age = int(match.group(1))
    return min(max(max_age, TILE_FRESH_MIN_S), TILE_FRESH_MAX_S)


def _body_matches(content_type: str, body: bytes) -> bool:
    if content_type == "image/png":
        return body.startswith(b"\x89PNG\r\n\x1a\n")
    if content_type == "image/jpeg":
        return body.startswith(b"\xff\xd8\xff")
    if content_type == "image/webp":
        return len(body) >= 12 and body[:4] == b"RIFF" and body[8:12] == b"WEBP"
    return False


def _validator(value: Optional[str]) -> str:
    """An ETag or Last-Modified value that is safe to send back, or ''."""
    if not value:
        return ""
    value = value.strip()
    return value if _VALIDATOR_RE.fullmatch(value) else ""


@dataclass
class TileResult:
    status: int
    body: bytes = b""
    content_type: str = ""
    # hit (from disk, no upstream body), miss (fetched now) or stale (old copy, upstream unreachable).
    cache: str = ""
    error: str = ""


@dataclass
class _Entry:
    path: Path
    content_type: str
    fetched_at: float
    fresh_s: float
    etag: str
    last_modified: str
    body: bytes

    def fresh(self, now: float) -> bool:
        return 0 <= now - self.fetched_at < self.fresh_s


@dataclass
class _Fetched:
    """One upstream answer. kind: ok, not_modified, not_found or failed."""

    kind: str
    body: bytes = b""
    content_type: str = ""
    fresh_s: int = TILE_FRESH_MIN_S
    etag: str = ""
    last_modified: str = ""
    reason: str = ""


class _Flight:
    def __init__(self) -> None:
        self.done = threading.Event()
        self.result: Optional[TileResult] = None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is an answer, not an instruction: it ends the attempt on that host."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:  # noqa: D401
        return None


def _build_opener(use_proxy: bool) -> urllib.request.OpenerDirector:
    handlers: List[Any] = [
        _NoRedirect(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
    ]
    # Without an explicit ProxyHandler urllib adds one that reads the
    # environment proxy; a loopback upstream never goes through a proxy.
    if not use_proxy:
        handlers.append(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers)


class TileCache:
    """Disk cache plus bounded upstream fetches behind ``/api/tiles/``."""

    def __init__(
        self,
        cache_dir: Path,
        max_bytes: int,
        *,
        sources: Optional[Mapping[str, TileSource]] = None,
        user_agent: str = "SDR-DoA-Ground-Console/dev",
        log: Callable[[str], None] = lambda message: print(f"[tile-cache] {message}", flush=True),
    ) -> None:
        self.cache_dir = Path(cache_dir).expanduser()
        if not isinstance(max_bytes, int) or max_bytes < 0:
            raise ValueError("tile cache size must be a non-negative number of bytes")
        self.max_bytes = max_bytes
        self.sources = validate_sources(TILE_SOURCES if sources is None else sources)
        self.user_agent = user_agent
        self.log = log
        # Wall clock for tile age, monotonic clock for host backoff; tests replace them.
        self.clock: Callable[[], float] = time.time
        self.monotonic: Callable[[], float] = time.monotonic
        self._slots = threading.BoundedSemaphore(MAX_CONCURRENT_FETCHES)
        self._lock = threading.Lock()
        self._flights: Dict[Tuple[str, int, int, int], _Flight] = {}
        self._host_down_until: Dict[str, float] = {}
        self._preferred: Dict[str, int] = {}
        self._source_down: Dict[str, bool] = {}
        self._size_lock = threading.Lock()
        self._total_bytes: Optional[int] = None
        self._write_error_logged = False
        self._proxy_opener = _build_opener(use_proxy=True)
        self._direct_opener = _build_opener(use_proxy=False)

    # -- request entry point -------------------------------------------------

    def get_path(self, path: str) -> TileResult:
        parsed = parse_tile_path(path)
        if parsed is None:
            return TileResult(404, error="tile path must be /api/tiles/<source>/<z>/<x>/<y>")
        return self.get(*parsed)

    def get(self, source_id: str, z: int, x: int, y: int) -> TileResult:
        source = self.sources.get(source_id)
        if source is None:
            return TileResult(404, error="unknown tile source")
        if not 0 <= z <= source.maxzoom or not (0 <= x < 2 ** z and 0 <= y < 2 ** z):
            return TileResult(404, error="tile is outside the source's zoom levels or grid")
        entry = self._read(self._tile_path(source_id, z, x, y))
        if entry is not None and entry.fresh(self.clock()):
            self._touch(entry.path)
            return TileResult(200, entry.body, entry.content_type, "hit")
        key = (source_id, z, x, y)
        with self._lock:
            flight = self._flights.get(key)
            owner = flight is None
            if owner:
                flight = _Flight()
                self._flights[key] = flight
        assert flight is not None
        if not owner:
            flight.done.wait(FETCH_SLOT_WAIT_S + 2 * UPSTREAM_DEADLINE_S)
            if flight.result is not None:
                return flight.result
            return self._fallback(entry, "tile fetch did not finish")
        try:
            flight.result = self._refresh(source, z, x, y, entry)
        except Exception as exc:  # never let one tile break the handler
            flight.result = self._fallback(entry, f"tile fetch failed: {type(exc).__name__}")
        finally:
            with self._lock:
                self._flights.pop(key, None)
            flight.done.set()
        return flight.result

    # -- upstream ------------------------------------------------------------

    def _refresh(self, source: TileSource, z: int, x: int, y: int, entry: Optional[_Entry]) -> TileResult:
        candidates = self._hosts_to_try(source)
        if not candidates:
            return self._fallback(entry, "every upstream host is backing off")
        if not self._slots.acquire(timeout=FETCH_SLOT_WAIT_S):
            return self._fallback(entry, "no free upstream slot")
        try:
            reasons: List[str] = []
            for index in candidates:
                # Another request may have put this host into backoff meanwhile.
                template = source.templates[index]
                host = urlsplit(template).netloc
                if self._host_backing_off(host):
                    continue
                url = template.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
                fetched = self._fetch(url, entry)
                if fetched.kind == "failed":
                    reasons.append(fetched.reason)
                    self._mark_host_down(host)
                    continue
                self._preferred[source.id] = index
                self._mark_source_up(source.id)
                if fetched.kind == "not_found":
                    return TileResult(404, error="the upstream has no such tile")
                if fetched.kind == "not_modified" and entry is not None:
                    entry.fetched_at = self.clock()
                    entry.fresh_s = fetched.fresh_s
                    entry.etag = fetched.etag or entry.etag
                    entry.last_modified = fetched.last_modified or entry.last_modified
                    self._store(entry.path, entry.content_type, entry.body, entry.fresh_s, entry.etag, entry.last_modified)
                    return TileResult(200, entry.body, entry.content_type, "hit")
                if fetched.kind == "ok":
                    path = self._tile_path(source.id, z, x, y)
                    self._store(path, fetched.content_type, fetched.body, fetched.fresh_s, fetched.etag, fetched.last_modified)
                    return TileResult(200, fetched.body, fetched.content_type, "miss")
                reasons.append("unexpected upstream answer")
            self._mark_source_down(source.id, "; ".join(reasons) or "every upstream host is backing off")
            return self._fallback(entry, "upstream unavailable")
        finally:
            self._slots.release()

    def _hosts_to_try(self, source: TileSource) -> List[int]:
        count = len(source.templates)
        first = self._preferred.get(source.id, 0) % count
        order = [(first + offset) % count for offset in range(count)]
        return [index for index in order if not self._host_backing_off(urlsplit(source.templates[index]).netloc)]

    def _host_backing_off(self, host: str) -> bool:
        with self._lock:
            until = self._host_down_until.get(host)
            if until is None:
                return False
            if self.monotonic() >= until:
                self._host_down_until.pop(host, None)
                return False
            return True

    def _mark_host_down(self, host: str) -> None:
        with self._lock:
            self._host_down_until[host] = self.monotonic() + HOST_BACKOFF_S

    def _mark_source_down(self, source_id: str, reason: str) -> None:
        with self._lock:
            was_down = self._source_down.get(source_id, False)
            self._source_down[source_id] = True
        if not was_down:
            self.log(f"tiles {source_id}: upstream unavailable ({reason}); serving cached tiles only")

    def _mark_source_up(self, source_id: str) -> None:
        with self._lock:
            was_down = self._source_down.pop(source_id, False)
        if was_down:
            self.log(f"tiles {source_id}: upstream reachable again")

    def _fetch(self, url: str, entry: Optional[_Entry]) -> _Fetched:
        headers = {"User-Agent": self.user_agent, "Accept": "image/webp,image/png,image/jpeg"}
        if entry is not None:
            if entry.etag:
                headers["If-None-Match"] = entry.etag
            if entry.last_modified:
                headers["If-Modified-Since"] = entry.last_modified
        request = urllib.request.Request(url, headers=headers, method="GET")
        host = urlsplit(url).hostname or ""
        opener = self._direct_opener if _is_loopback_literal(host) else self._proxy_opener
        deadline = self.monotonic() + UPSTREAM_DEADLINE_S
        try:
            with opener.open(request, timeout=UPSTREAM_TIMEOUT_S) as response:
                status = int(getattr(response, "status", 0) or 0)
                if status != 200:
                    return _Fetched("failed", reason=f"HTTP {status}")
                return self._read_body(response, deadline)
        except urllib.error.HTTPError as exc:
            code = int(exc.code)
            exc.close()
            if code == 304 and entry is not None:
                return _Fetched(
                    "not_modified",
                    fresh_s=fresh_seconds(exc.headers.get("Cache-Control") if exc.headers else None),
                    etag=_validator(exc.headers.get("ETag") if exc.headers else None),
                    last_modified=_validator(exc.headers.get("Last-Modified") if exc.headers else None),
                )
            if code in (404, 410):
                return _Fetched("not_found")
            if 300 <= code < 400:
                return _Fetched("failed", reason=f"redirect {code} refused")
            return _Fetched("failed", reason=f"HTTP {code}")
        except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as exc:
            reason = getattr(exc, "reason", None) or exc
            return _Fetched("failed", reason=type(reason).__name__ if not str(reason) else str(reason)[:120])

    def _read_body(self, response: Any, deadline: float) -> _Fetched:
        content_type = str(response.headers.get("Content-Type", "")).split(";", 1)[0].strip().lower()
        if content_type not in ALLOWED_CONTENT_TYPES:
            return _Fetched("failed", reason=f"content type {content_type or 'missing'} refused")
        declared = response.headers.get("Content-Length")
        if declared is not None:
            try:
                if int(declared) > MAX_TILE_BYTES:
                    return _Fetched("failed", reason="tile larger than 1 MiB")
            except ValueError:
                return _Fetched("failed", reason="invalid Content-Length")
        chunks: List[bytes] = []
        size = 0
        # read() would wait until the whole chunk arrived, however slowly;
        # read1() returns after one socket read, so the deadline is checked
        # between reads of at most UPSTREAM_TIMEOUT_S each.
        read = getattr(response, "read1", None) or response.read
        while True:
            if self.monotonic() > deadline:
                return _Fetched("failed", reason="tile download too slow")
            chunk = read(64 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_TILE_BYTES:
                return _Fetched("failed", reason="tile larger than 1 MiB")
            chunks.append(chunk)
        body = b"".join(chunks)
        if not body or not _body_matches(content_type, body):
            return _Fetched("failed", reason=f"body is not {content_type}")
        return _Fetched(
            "ok",
            body=body,
            content_type=content_type,
            fresh_s=fresh_seconds(response.headers.get("Cache-Control")),
            etag=_validator(response.headers.get("ETag")),
            last_modified=_validator(response.headers.get("Last-Modified")),
        )

    def _fallback(self, entry: Optional[_Entry], reason: str) -> TileResult:
        if entry is not None:
            return TileResult(200, entry.body, entry.content_type, "stale")
        return TileResult(504, error=f"tile not cached and {reason}")

    # -- disk ------------------------------------------------------------------

    def _tile_path(self, source_id: str, z: int, x: int, y: int) -> Path:
        return self.cache_dir / source_id / str(z) / str(x) / f"{y}.tile"

    def _read(self, path: Path) -> Optional[_Entry]:
        try:
            with path.open("rb") as handle:
                if handle.read(len(_FILE_MAGIC)) != _FILE_MAGIC:
                    raise ValueError("bad magic")
                header = handle.readline(_MAX_HEADER_BYTES)
                if not header.endswith(b"\n"):
                    raise ValueError("header too long")
                meta = json.loads(header.decode("utf-8"))
                body = handle.read(MAX_TILE_BYTES + 1)
        except FileNotFoundError:
            return None
        except (OSError, ValueError, UnicodeDecodeError):
            self._discard(path)
            return None
        if not isinstance(meta, dict):
            self._discard(path)
            return None
        content_type = meta.get("ct")
        fetched_at = meta.get("fetched")
        fresh_s = meta.get("fresh_s")
        if (
            content_type not in ALLOWED_CONTENT_TYPES
            or not isinstance(fetched_at, (int, float))
            or not isinstance(fresh_s, (int, float))
            or isinstance(fetched_at, bool)
            or isinstance(fresh_s, bool)
            or not math.isfinite(fetched_at)
            or not math.isfinite(fresh_s)
            or len(body) > MAX_TILE_BYTES
            or not _body_matches(content_type, body)
        ):
            self._discard(path)
            return None
        return _Entry(
            path=path,
            content_type=content_type,
            fetched_at=float(fetched_at),
            fresh_s=float(min(max(fresh_s, 0), TILE_FRESH_MAX_S)),
            etag=_validator(meta.get("etag") if isinstance(meta.get("etag"), str) else ""),
            last_modified=_validator(meta.get("lm") if isinstance(meta.get("lm"), str) else ""),
            body=body,
        )

    def _discard(self, path: Path) -> None:
        try:
            size = path.stat().st_size
            path.unlink()
        except OSError:
            return
        self._account(-size)

    def _touch(self, path: Path) -> None:
        # The file's mtime is the LRU clock, kept in this cache's own clock.
        now = self.clock()
        try:
            if now - path.stat().st_mtime >= TOUCH_INTERVAL_S:
                os.utime(path, (now, now))
        except OSError:
            pass

    def _store(self, path: Path, content_type: str, body: bytes, fresh_s: float, etag: str, last_modified: str) -> None:
        if self.max_bytes == 0 or len(body) > self.max_bytes:
            return
        now = self.clock()
        meta = {"ct": content_type, "fetched": now, "fresh_s": fresh_s}
        if etag:
            meta["etag"] = etag
        if last_modified:
            meta["lm"] = last_modified
        header = json.dumps(meta, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        data = _FILE_MAGIC + header + b"\n" + body
        try:
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            try:
                previous = path.stat().st_size
            except FileNotFoundError:
                previous = 0
            descriptor, temporary = tempfile.mkstemp(prefix=".tile-", suffix=".tmp", dir=str(path.parent))
            try:
                with os.fdopen(descriptor, "wb") as handle:
                    handle.write(data)
                os.utime(temporary, (now, now))
                os.replace(temporary, path)
            except BaseException:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
                raise
        except OSError as exc:
            if not self._write_error_logged:
                self._write_error_logged = True
                self.log(f"tile cache {self.cache_dir} is not writable ({type(exc).__name__}); tiles are not kept")
            return
        self._account(len(data) - previous)

    def _account(self, delta: int) -> None:
        with self._size_lock:
            if self._total_bytes is None:
                self._total_bytes = self._scan_size()
            else:
                self._total_bytes = max(0, self._total_bytes + delta)
            if self._total_bytes > self.max_bytes:
                self._evict_locked()

    def _scan(self) -> List[Tuple[float, int, Path]]:
        files: List[Tuple[float, int, Path]] = []
        if not self.cache_dir.is_dir():
            return files
        now = self.clock()
        for root, _dirs, names in os.walk(self.cache_dir):
            for name in names:
                path = Path(root) / name
                try:
                    stat = path.lstat()
                except OSError:
                    continue
                if name.endswith(".tile"):
                    files.append((stat.st_mtime, stat.st_size, path))
                elif name.startswith(".tile-") and name.endswith(".tmp") and now - stat.st_mtime > 3600:
                    # Left behind by a process that stopped mid-write.
                    try:
                        path.unlink()
                    except OSError:
                        pass
        return files

    def _scan_size(self) -> int:
        return sum(size for _mtime, size, _path in self._scan())

    def _evict_locked(self) -> None:
        files = sorted(self._scan(), key=lambda item: item[0])
        total = sum(size for _mtime, size, _path in files)
        target = int(self.max_bytes * EVICT_TO_FRACTION)
        for _mtime, size, path in files:
            if total <= target:
                break
            try:
                path.unlink()
            except OSError:
                continue
            total -= size
        self._total_bytes = total

    def size_bytes(self) -> int:
        """Bytes the cache holds now (scans the directory on first use)."""
        with self._size_lock:
            if self._total_bytes is None:
                self._total_bytes = self._scan_size()
            return self._total_bytes
