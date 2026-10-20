#!/usr/bin/env python3
"""Basemap tile cache: tools/tile_cache.py and GET /api/tiles/<source>/<z>/<x>/<y>.

Every console runs on loopback with temporary files. The upstream is a
loopback fake tile server injected through the GroundConsoleServer
constructor (``tile_sources``); the command line has no way to change the
upstreams, and nothing here contacts a real tile provider.
"""

from __future__ import annotations

import contextlib
import http.client
import io
import json
import os
import stat
import struct
import sys
import tempfile
import threading
import time
import unittest
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from unittest.mock import patch

TOOLS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = TOOLS_DIR.parent
for _path in (str(TOOLS_DIR), str(PROJECT_ROOT)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

# ground_console resolves its admin password at import time; give it a
# test-only value so the import never reads a local .env file.
_SAVED_ADMIN_PASSWORD = os.environ.get("SDR_DOA_ADMIN_PASSWORD")
os.environ["SDR_DOA_ADMIN_PASSWORD"] = "tile-cache-import-no-secret"
try:
    import ground_console  # noqa: E402
finally:
    if _SAVED_ADMIN_PASSWORD is None:
        os.environ.pop("SDR_DOA_ADMIN_PASSWORD", None)
    else:
        os.environ["SDR_DOA_ADMIN_PASSWORD"] = _SAVED_ADMIN_PASSWORD

import tile_cache  # noqa: E402
from tile_cache import TileCache, TileSource  # noqa: E402

BASE_URL = "http://doasdr.local:8081"
DAY = 24 * 3600


def png(seed: int = 0, size: int = 1) -> bytes:
    """A small valid PNG; seed changes its colour, size its byte count."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    row = b"\x00" + bytes(((seed * 37 + index) % 256 for index in range(size * 3)))
    raw = row * size
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 0))
        + chunk(b"IEND", b"")
    )


class FakeUpstream:
    """A loopback tile server. ``mode`` decides every answer; requests are recorded."""

    def __init__(self) -> None:
        self.mode = "ok"
        self.delay_s = 0.0
        self.cache_control: Optional[str] = "max-age=3600"
        self.etag: Optional[str] = None
        self.body = png(1)
        self.requests: List[Tuple[str, Dict[str, str]]] = []
        self.active = 0
        self.max_active = 0
        self._lock = threading.Lock()
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                pass

            def do_GET(self) -> None:  # noqa: N802
                with upstream._lock:
                    upstream.requests.append((self.path, {key.lower(): value for key, value in self.headers.items()}))
                    upstream.active += 1
                    upstream.max_active = max(upstream.max_active, upstream.active)
                try:
                    if upstream.delay_s:
                        time.sleep(upstream.delay_s)
                    upstream.answer(self)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # the console stopped reading an oversized body
                finally:
                    with upstream._lock:
                        upstream.active -= 1

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def port(self) -> int:
        return int(self.server.server_address[1])

    def template(self, prefix: str = "a") -> str:
        return f"http://127.0.0.1:{self.port}/{prefix}/{{z}}/{{x}}/{{y}}.png"

    def paths(self) -> List[str]:
        with self._lock:
            return [path for path, _headers in self.requests]

    def answer(self, handler: BaseHTTPRequestHandler) -> None:
        mode = self.mode
        if callable(mode):
            mode = mode(handler.path)
        if mode == "ok" or mode == "etag":
            if mode == "etag" and self.etag and handler.headers.get("If-None-Match") == self.etag:
                handler.send_response(304)
                handler.send_header("ETag", self.etag)
                if self.cache_control:
                    handler.send_header("Cache-Control", self.cache_control)
                handler.end_headers()
                return
            handler.send_response(200)
            handler.send_header("Content-Type", "image/png")
            handler.send_header("Content-Length", str(len(self.body)))
            if self.cache_control:
                handler.send_header("Cache-Control", self.cache_control)
            if self.etag:
                handler.send_header("ETag", self.etag)
            handler.end_headers()
            handler.wfile.write(self.body)
            return
        if mode == "error":
            body = b"upstream exploded"
            handler.send_response(500)
            handler.send_header("Content-Type", "image/png")
            handler.send_header("Content-Length", str(len(body)))
            handler.end_headers()
            handler.wfile.write(body)
            return
        if mode == "missing":
            handler.send_response(404)
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return
        if mode == "html":
            body = b"<html>captive portal</html>"
            handler.send_response(200)
            handler.send_header("Content-Type", "text/html")
            handler.send_header("Content-Length", str(len(body)))
            handler.end_headers()
            handler.wfile.write(body)
            return
        if mode == "mismatch":
            body = b"<html>not really a png</html>"
            handler.send_response(200)
            handler.send_header("Content-Type", "image/png")
            handler.send_header("Content-Length", str(len(body)))
            handler.end_headers()
            handler.wfile.write(body)
            return
        if mode == "oversize":
            body = png(2) + b"\x00" * (tile_cache.MAX_TILE_BYTES + 1)
            handler.send_response(200)
            handler.send_header("Content-Type", "image/png")
            handler.end_headers()
            handler.wfile.write(body)
            return
        if mode == "trickle":
            # Headers at once, then the body a few bytes at a time, each well
            # inside the socket timeout.
            body = self.body
            handler.send_response(200)
            handler.send_header("Content-Type", "image/png")
            handler.send_header("Content-Length", str(len(body)))
            handler.end_headers()
            handler.wfile.flush()
            for start in range(0, len(body), 8):
                handler.wfile.write(body[start:start + 8])
                handler.wfile.flush()
                time.sleep(0.05)
            return
        if mode == "redirect":
            handler.send_response(302)
            handler.send_header("Location", f"http://127.0.0.1:{self.port}/redirected/0/0/0.png")
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return
        raise AssertionError(f"unknown fake upstream mode {mode!r}")

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class ConsoleWithTiles:
    """A GroundConsoleServer on loopback whose tile sources point at fake upstreams."""

    def __init__(self, test: unittest.TestCase, root: Path, sources: Dict[str, TileSource], **kwargs: Any) -> None:
        self.server = ground_console.GroundConsoleServer(
            ("127.0.0.1", 0),
            BASE_URL,
            config_path=str(root / "console.json"),
            branding_path=str(root / "branding.json"),
            receiver_data_dir=root / "receiver",
            tile_sources=sources,
            **kwargs,
        )
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

        def close() -> None:
            self.server.shutdown()
            self.thread.join(timeout=5)
            self.server.server_close()

        test.addCleanup(close)

    @property
    def cache(self) -> TileCache:
        return self.server.tile_cache

    def get(self, path: str, headers: Optional[Dict[str, str]] = None) -> Tuple[int, Dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            connection.request("GET", path, headers={"Cookie": "sdr_doa_admin=secret", "Referer": "http://127.0.0.1/", **(headers or {})})
            response = connection.getresponse()
            body = response.read()
            return response.status, {key.lower(): value for key, value in response.getheaders()}, body
        finally:
            connection.close()


class TileCacheTestCase(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-tile-cache-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.tiles = self.root / "tiles"
        quiet = patch.object(ground_console.ConsoleHandler, "log_message", lambda *_args: None)
        quiet.start()
        self.addCleanup(quiet.stop)
        self.upstream = FakeUpstream()
        self.addCleanup(self.upstream.close)
        self.logs: List[str] = []

    def console(self, *templates: str, maxzoom: int = 19, **kwargs: Any) -> ConsoleWithTiles:
        chosen = templates or (self.upstream.template("a"),)
        kwargs.setdefault("tile_cache_dir", self.tiles)
        console = ConsoleWithTiles(self, self.root, {"osm": TileSource("osm", tuple(chosen), maxzoom)}, **kwargs)
        console.cache.log = self.logs.append
        return console


class TileRouteTests(TileCacheTestCase):
    def test_miss_then_hit_without_another_upstream_request(self) -> None:
        console = self.console()
        status, headers, body = console.get("/api/tiles/osm/3/2/5?forward=me")
        self.assertEqual(status, 200)
        self.assertEqual(body, self.upstream.body)
        self.assertEqual(headers["content-type"], "image/png")
        self.assertEqual(headers["x-tile-cache"], "miss")
        self.assertEqual(headers["cache-control"], f"private, max-age={tile_cache.BROWSER_MAX_AGE_S}")
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        status, headers, body = console.get("/api/tiles/osm/3/2/5")
        self.assertEqual((status, headers["x-tile-cache"], body), (200, "hit", self.upstream.body))
        self.assertEqual(self.upstream.paths(), ["/a/3/2/5.png"], "no query is forwarded and a fresh tile needs no request")

    def test_upstream_request_identifies_the_console_and_forwards_nothing(self) -> None:
        console = self.console()
        console.get("/api/tiles/osm/1/0/1")
        (_path, headers), = self.upstream.requests
        self.assertEqual(headers["user-agent"], f"SDR-DoA-Ground-Console/{ground_console.CONSOLE_VERSION}")
        for forbidden in ("cookie", "referer", "origin", "authorization"):
            self.assertNotIn(forbidden, headers)

    def test_cross_site_requests_are_refused(self) -> None:
        console = self.console()
        # same-site is another page on this host, e.g. a dev server on another localhost port.
        for site in ("cross-site", "same-site", "Cross-Site"):
            with self.subTest(site):
                status, _headers, body = console.get("/api/tiles/osm/1/0/0", {"Sec-Fetch-Site": site})
                self.assertEqual((status, json.loads(body)["code"]), (403, "ORIGIN_REJECTED"))
        self.assertEqual(self.upstream.requests, [])
        for site in ("same-origin", "none"):
            with self.subTest(site):
                self.assertEqual(console.get("/api/tiles/osm/1/0/0", {"Sec-Fetch-Site": site})[0], 200)

    def test_invalid_paths_are_404_and_never_reach_the_upstream(self) -> None:
        console = self.console(maxzoom=17)
        for path in (
            "/api/tiles/unknown/1/0/0",
            "/api/tiles/osm/18/0/0",
            "/api/tiles/osm/2/4/0",
            "/api/tiles/osm/2/0/4",
            "/api/tiles/osm/02/0/0",
            "/api/tiles/osm/2/00/0",
            "/api/tiles/osm/-1/0/0",
            "/api/tiles/osm/1/0",
            "/api/tiles/osm/1/0/0/0",
            "/api/tiles/osm/1/0/0.png",
            "/api/tiles/osm/a/0/0",
            "/api/tiles/OSM/1/0/0",
            "/api/tiles/osm/1/0/0%2e",
            "/api/tiles/../osm/1/0/0",
            "/api/tiles/",
        ):
            with self.subTest(path):
                status, headers, _body = console.get(path)
                self.assertEqual(status, 404)
                self.assertNotIn("x-tile-cache", headers)
        self.assertEqual(self.upstream.requests, [])

    def test_second_host_is_used_and_remembered_when_the_first_fails(self) -> None:
        second = FakeUpstream()
        self.addCleanup(second.close)
        self.upstream.mode = "error"
        console = self.console(self.upstream.template("a"), second.template("b"))
        status, headers, _body = console.get("/api/tiles/osm/2/1/1")
        self.assertEqual((status, headers["x-tile-cache"]), (200, "miss"))
        status, _headers, _body = console.get("/api/tiles/osm/2/1/2")
        self.assertEqual(status, 200)
        # The failed host is not asked again; the working one is tried first from now on.
        self.assertEqual(self.upstream.paths(), ["/a/2/1/1.png"])
        self.assertEqual(second.paths(), ["/b/2/1/1.png", "/b/2/1/2.png"])
        self.upstream.mode = "ok"
        console.cache._host_down_until.clear()
        console.get("/api/tiles/osm/2/0/2")
        self.assertEqual(second.paths()[-1], "/b/2/0/2.png")
        self.assertEqual(len(self.upstream.requests), 1)

    def test_offline_serves_cached_tiles_and_fails_fast_for_uncached_ones(self) -> None:
        console = self.console()
        self.assertEqual(console.get("/api/tiles/osm/4/3/3")[0], 200)
        self.upstream.mode = "error"
        # Fresh: served without asking the dead upstream.
        status, headers, body = console.get("/api/tiles/osm/4/3/3")
        self.assertEqual((status, headers["x-tile-cache"], body), (200, "hit", self.upstream.body))
        # Stale: the upstream is asked once, fails, and the old copy is served.
        now = time.time()
        console.cache.clock = lambda: now + 8 * DAY
        status, headers, body = console.get("/api/tiles/osm/4/3/3")
        self.assertEqual((status, headers["x-tile-cache"], body), (200, "stale", self.upstream.body))
        self.assertEqual(headers["cache-control"], f"private, max-age={tile_cache.BROWSER_STALE_MAX_AGE_S}")
        # Uncached while the host backs off: 504 at once, no upstream request.
        before = len(self.upstream.requests)
        started = time.monotonic()
        status, headers, body = console.get("/api/tiles/osm/4/0/0")
        self.assertEqual(status, 504)
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertEqual(len(self.upstream.requests), before)
        self.assertEqual(json.loads(body)["error"], "tile not cached and every upstream host is backing off")
        self.assertEqual(len([line for line in self.logs if "upstream unavailable" in line]), 1, self.logs)

    def test_unreachable_upstream_answers_504_and_backs_off(self) -> None:
        self.upstream.close()
        console = self.console()
        status, _headers, _body = console.get("/api/tiles/osm/5/1/1")
        self.assertEqual(status, 504)
        self.assertTrue(console.cache._host_backing_off(f"127.0.0.1:{self.upstream.port}"))
        # After the backoff the host is tried again.
        start = time.monotonic()
        console.cache.monotonic = lambda: start + tile_cache.HOST_BACKOFF_S + 1
        self.assertFalse(console.cache._host_backing_off(f"127.0.0.1:{self.upstream.port}"))

    def test_recovery_is_logged_once(self) -> None:
        self.upstream.mode = "error"
        console = self.console()
        self.assertEqual(console.get("/api/tiles/osm/1/1/1")[0], 504)
        self.upstream.mode = "ok"
        console.cache._host_down_until.clear()
        self.assertEqual(console.get("/api/tiles/osm/1/1/1")[0], 200)
        self.assertEqual(console.get("/api/tiles/osm/1/1/0")[0], 200)
        self.assertEqual([line.split(":", 1)[1].strip().split(" (")[0] for line in self.logs], ["upstream unavailable", "upstream reachable again"])

    def test_upstream_404_is_a_404_without_backoff(self) -> None:
        self.upstream.mode = "missing"
        console = self.console()
        self.assertEqual(console.get("/api/tiles/osm/1/1/1")[0], 404)
        self.assertEqual(console.get("/api/tiles/osm/1/0/1")[0], 404)
        self.assertEqual(len(self.upstream.requests), 2)
        self.assertEqual(list(self.tiles.rglob("*.tile")), [])


class FreshnessTests(TileCacheTestCase):
    def age_and_get(self, console: ConsoleWithTiles, path: str, days: float) -> str:
        now = time.time()
        console.cache.clock = lambda: now + days * DAY
        status, headers, _body = console.get(path)
        self.assertEqual(status, 200)
        return headers["x-tile-cache"]

    def test_short_max_age_still_keeps_tiles_for_seven_days(self) -> None:
        self.upstream.cache_control = "max-age=60"
        console = self.console()
        console.get("/api/tiles/osm/2/2/2")
        self.assertEqual(self.age_and_get(console, "/api/tiles/osm/2/2/2", 6.9), "hit")
        self.assertEqual(len(self.upstream.requests), 1)
        self.assertEqual(self.age_and_get(console, "/api/tiles/osm/2/2/2", 7.1), "miss")
        self.assertEqual(len(self.upstream.requests), 2)

    def test_long_max_age_is_capped_at_thirty_days(self) -> None:
        self.upstream.cache_control = f"public, max-age={90 * DAY}"
        console = self.console()
        console.get("/api/tiles/osm/2/1/0")
        self.assertEqual(self.age_and_get(console, "/api/tiles/osm/2/1/0", 29), "hit")
        self.assertEqual(self.age_and_get(console, "/api/tiles/osm/2/1/0", 31), "miss")

    def test_stale_tile_is_revalidated_with_its_etag(self) -> None:
        self.upstream.mode = "etag"
        self.upstream.etag = '"v1"'
        console = self.console()
        console.get("/api/tiles/osm/3/3/3")
        self.assertEqual(self.age_and_get(console, "/api/tiles/osm/3/3/3", 8), "hit")
        path, headers = self.upstream.requests[-1]
        self.assertEqual(headers.get("if-none-match"), '"v1"')
        # The 304 renewed the copy: a day later it is fresh without a request.
        count = len(self.upstream.requests)
        self.assertEqual(self.age_and_get(console, "/api/tiles/osm/3/3/3", 9), "hit")
        self.assertEqual(len(self.upstream.requests), count)

    def test_fresh_seconds(self) -> None:
        self.assertEqual(tile_cache.fresh_seconds(None), 7 * DAY)
        self.assertEqual(tile_cache.fresh_seconds("no-cache"), 7 * DAY)
        self.assertEqual(tile_cache.fresh_seconds("max-age=0"), 7 * DAY)
        self.assertEqual(tile_cache.fresh_seconds(f"max-age={10 * DAY}"), 10 * DAY)
        self.assertEqual(tile_cache.fresh_seconds(f"s-maxage={20 * DAY}"), 7 * DAY)
        self.assertEqual(tile_cache.fresh_seconds(f"public, max-age={365 * DAY}"), 30 * DAY)


class RefusedAnswerTests(TileCacheTestCase):
    def test_bad_answers_are_never_stored(self) -> None:
        for mode in ("error", "html", "mismatch", "oversize", "redirect"):
            with self.subTest(mode):
                self.upstream.mode = mode
                self.upstream.requests.clear()
                console = self.console()
                status, headers, _body = console.get("/api/tiles/osm/6/1/1")
                self.assertEqual(status, 504)
                self.assertNotIn("x-tile-cache", headers)
                self.assertEqual(list(self.tiles.rglob("*.tile")), [])
                self.assertEqual(list(self.tiles.rglob("*.tmp")), [])
                self.assertNotIn("/redirected/0/0/0.png", self.upstream.paths(), "redirects are not followed")

    def test_a_trickling_upstream_gives_up_at_the_deadline(self) -> None:
        # Every write arrives well inside the socket timeout, so only the
        # per-host deadline stops the download.
        self.upstream.body = png(3, size=24)
        self.upstream.mode = "trickle"
        console = self.console()
        with patch.object(tile_cache, "UPSTREAM_DEADLINE_S", 0.4):
            started = time.monotonic()
            status, _headers, _body = console.get("/api/tiles/osm/6/2/2")
            elapsed = time.monotonic() - started
        self.assertEqual(status, 504)
        self.assertLess(elapsed, 2.0, "the download stops near the deadline, not when the body is complete")
        self.assertEqual(list(self.tiles.rglob("*.tile")), [])
        self.assertTrue(any("tile download too slow" in line for line in self.logs), self.logs)

    def test_corrupt_cache_file_is_discarded(self) -> None:
        console = self.console()
        console.get("/api/tiles/osm/2/0/0")
        (path,) = list(self.tiles.rglob("*.tile"))
        path.write_bytes(b"SDRTILE1\n{not json}\n" + png())
        status, headers, _body = console.get("/api/tiles/osm/2/0/0")
        self.assertEqual((status, headers["x-tile-cache"]), (200, "miss"))
        self.assertEqual(len(self.upstream.requests), 2)


class DiskTests(TileCacheTestCase):
    def test_writes_are_atomic_files_only_the_owner_reads(self) -> None:
        console = self.console()
        console.get("/api/tiles/osm/7/10/20")
        path = self.tiles / "osm" / "7" / "10" / "20.tile"
        self.assertTrue(path.is_file())
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(list(self.tiles.rglob("*.tmp")), [])
        self.assertTrue(path.read_bytes().endswith(self.upstream.body))

    def test_lru_eviction_keeps_recently_used_tiles(self) -> None:
        self.upstream.body = png(3, size=64)
        console = self.console(tile_cache_max_mb=1)
        cache = console.cache
        # Room for six tiles; eviction goes down to 90 %, so two go at once.
        cache.max_bytes = (len(self.upstream.body) + 200) * 6
        now = time.time()
        clock = {"t": now}
        cache.clock = lambda: clock["t"]
        for x in range(4):
            clock["t"] = now + x * 1000
            console.get(f"/api/tiles/osm/3/{x}/0")
        # Use tile 0 again: a hit moves it to the end of the LRU order.
        clock["t"] = now + 10_000
        self.assertEqual(console.get("/api/tiles/osm/3/0/0")[1]["x-tile-cache"], "hit")
        for x in range(4, 8):
            clock["t"] = now + 20_000 + x
            console.get(f"/api/tiles/osm/3/{x}/0")
        self.assertLessEqual(cache.size_bytes(), cache.max_bytes)
        kept = {int(path.parent.name) for path in self.tiles.rglob("*.tile")}
        self.assertEqual(kept, {0, 3, 4, 5, 6, 7})

    def test_zero_size_keeps_nothing_on_disk(self) -> None:
        console = self.console(tile_cache_max_mb=0)
        self.assertEqual(console.get("/api/tiles/osm/1/1/1")[1]["x-tile-cache"], "miss")
        self.assertEqual(console.get("/api/tiles/osm/1/1/1")[1]["x-tile-cache"], "miss")
        self.assertFalse(self.tiles.exists())

    def test_cache_directory_defaults_next_to_console_json(self) -> None:
        server = ground_console.GroundConsoleServer(
            ("127.0.0.1", 0), BASE_URL,
            config_path=str(self.root / "cfg" / "console.json"),
            branding_path=str(self.root / "branding.json"),
            receiver_data_dir=self.root / "receiver",
        )
        self.addCleanup(server.server_close)
        self.assertEqual(server.tile_cache.cache_dir, self.root / "cfg" / "tiles")
        self.assertEqual(server.tile_cache.max_bytes, tile_cache.DEFAULT_TILE_CACHE_MAX_MB * 1024 * 1024)
        self.assertFalse((self.root / "cfg" / "tiles").exists(), "the directory is created on the first stored tile")

    def test_unwritable_cache_still_serves_tiles(self) -> None:
        blocker = self.root / "blocked"
        blocker.write_text("a file, not a directory", encoding="utf-8")
        console = self.console(tile_cache_dir=blocker / "tiles")
        self.assertEqual(console.get("/api/tiles/osm/1/0/0")[0], 200)
        self.assertEqual(console.get("/api/tiles/osm/1/0/1")[0], 200)
        self.assertEqual(len([line for line in self.logs if "not writable" in line]), 1)


class ConcurrencyTests(TileCacheTestCase):
    def test_concurrent_requests_for_one_tile_share_one_fetch(self) -> None:
        self.upstream.delay_s = 0.4
        console = self.console()
        results: List[int] = []

        def fetch() -> None:
            results.append(console.get("/api/tiles/osm/8/5/5")[0])

        threads = [threading.Thread(target=fetch) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        self.assertEqual(results, [200] * 6)
        self.assertEqual(self.upstream.paths(), ["/a/8/5/5.png"])

    def test_upstream_fetches_are_bounded(self) -> None:
        self.upstream.delay_s = 0.3
        console = self.console()
        threads = [threading.Thread(target=console.get, args=(f"/api/tiles/osm/8/{x}/1",)) for x in range(10)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)
        self.assertEqual(len(self.upstream.requests), 10)
        self.assertLessEqual(self.upstream.max_active, tile_cache.MAX_CONCURRENT_FETCHES)


class LoggingTests(TileCacheTestCase):
    def test_tile_answers_are_not_logged_but_bad_paths_are(self) -> None:
        console = self.console()
        output = io.StringIO()
        with patch.object(ground_console.ConsoleHandler, "log_message", lambda handler, fmt, *args: output.write((fmt % args) + "\n")):
            console.get("/api/tiles/osm/1/0/0")
            console.get("/api/tiles/osm/1/0/0")
            self.upstream.mode = "error"
            console.get("/api/tiles/osm/1/1/1")
            console.get("/api/tiles/osm/99/0/0")
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 1, lines)
        self.assertIn("/api/tiles/osm/99/0/0", lines[0])
        self.assertIn("404", lines[0])


class SourceTableTests(unittest.TestCase):
    def test_built_in_sources_are_https_with_at_most_two_hosts(self) -> None:
        self.assertEqual(set(tile_cache.TILE_SOURCES), {"osm", "hot", "imagery", "imagery-labels", "topo"})
        for source in tile_cache.TILE_SOURCES.values():
            with self.subTest(source.id):
                self.assertIn(len(source.templates), (1, 2))
                for template in source.templates:
                    self.assertTrue(template.startswith("https://"), template)
                    self.assertNotRegex(template.lower(), r"key|token|access")
                tile_cache.validate_sources({source.id: source})
        self.assertIn("tile.openstreetmap.de", tile_cache.TILE_SOURCES["osm"].templates[0], "the .de host is tried first")
        self.assertEqual({source.id: source.maxzoom for source in tile_cache.TILE_SOURCES.values()},
                         {"osm": 19, "hot": 19, "imagery": 18, "imagery-labels": 18, "topo": 17})

    def test_unsafe_templates_are_refused(self) -> None:
        for template in (
            "http://tile.example.org/{z}/{x}/{y}.png",
            "http://10.0.0.1/{z}/{x}/{y}.png",
            "ftp://tile.example.org/{z}/{x}/{y}.png",
            "https://tile.example.org/{z}/{x}/{y}.png?key=1",
            "https://tile.example.org/{z}/{x}/{y}.png#x",
            "https://user:pass@tile.example.org/{z}/{x}/{y}.png",
            "https://tile.example.org/{z}/{x}.png",
            "https://tile.example.org/{z}/{x}/{y}/{s}.png",
            "https://tile.example.org/{z}/{z}/{x}/{y}.png",
        ):
            with self.subTest(template):
                with self.assertRaises(ValueError):
                    tile_cache.validate_template(template)
        self.assertTrue(tile_cache.validate_template("http://127.0.0.1:9/{z}/{x}/{y}.png"))
        self.assertTrue(tile_cache.validate_template("http://[::1]:9/{z}/{x}/{y}.png"))
        with self.assertRaises(ValueError):
            tile_cache.validate_sources({"osm": TileSource("osm", ("https://a/{z}/{x}/{y}", "https://b/{z}/{x}/{y}", "https://c/{z}/{x}/{y}"), 19)})
        with self.assertRaises(ValueError):
            tile_cache.validate_sources({"other": TileSource("osm", ("https://a/{z}/{x}/{y}",), 19)})

    def test_upstream_opener_uses_the_environment_proxy_except_for_loopback(self) -> None:
        # urllib keeps a ProxyHandler only when the environment names a proxy,
        # so give it one: a CI runner usually has none.
        proxy = "http://proxy.invalid:3128"
        with patch.dict(os.environ, {"https_proxy": proxy, "HTTPS_PROXY": proxy}):
            cache = TileCache(Path(tempfile.gettempdir()) / "unused-tile-cache", 0)
        proxied = [type(handler).__name__ for handler in cache._proxy_opener.handlers]
        direct = [handler for handler in cache._direct_opener.handlers if getattr(handler, "proxies", None)]
        self.assertIn("ProxyHandler", proxied)
        self.assertEqual(direct, [])
        self.assertTrue(any(isinstance(handler, tile_cache._NoRedirect) for handler in cache._proxy_opener.handlers))


class CommandLineTests(unittest.TestCase):
    def test_flags_and_defaults(self) -> None:
        args = ground_console._build_parser().parse_args([])
        self.assertEqual(Path(args.tile_cache_dir), tile_cache.DEFAULT_TILE_CACHE_DIR)
        self.assertEqual(args.tile_cache_max_mb, 512)
        args = ground_console._build_parser().parse_args(["--tile-cache-dir", "/srv/tiles", "--tile-cache-max-mb", "64"])
        self.assertEqual((args.tile_cache_dir, args.tile_cache_max_mb), ("/srv/tiles", 64))

    def test_no_flag_changes_the_upstreams(self) -> None:
        options = {option for action in ground_console._build_parser()._actions for option in action.option_strings}
        self.assertEqual({option for option in options if "tile" in option}, {"--tile-cache-dir", "--tile-cache-max-mb"})

    def test_out_of_range_size_is_refused(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                ground_console.main(["--tile-cache-max-mb", "-1"])


if __name__ == "__main__":
    unittest.main()
