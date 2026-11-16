"""The newest console release on GitHub, for the Configuration page's Update card.

``GET /api/host/update`` shows it next to the installed version. The rule is
``sdr-doa-docker update``'s channel: the highest stable release (no draft, no
prerelease) of the installed major version, which is what the channel tag
(the major, ``DEFAULT_CHANNEL``) points at once its image is published.

One anonymous GET of ``/repos/<repository>/releases`` through the environment
proxy (no token is ever sent), at most 6 s and 1 MiB, no redirects. The answer
is kept 10 minutes, a failure 1 minute, and a refresh asked by the page reads
again only when the last read is 15 s old, so a page cannot make the console
call GitHub more often than that. The groundstation is often without
internet: that is the ``OFFLINE`` code, shown as such on the page, never an
error that hides the installed version or the Update button. Stdlib only.
"""

from __future__ import annotations

import json
import re
import socket
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple

DEFAULT_API = "https://api.github.com"
REPOSITORY = "sanadunt/sdr-doa-ground-control"
RELEASES_PATH = f"/repos/{REPOSITORY}/releases?per_page=30"
RELEASE_PAGE_PREFIX = f"https://github.com/{REPOSITORY}/releases/"
TIMEOUT_S = 6.0
MAX_BYTES = 1024 * 1024
OK_TTL_S = 600.0
ERROR_TTL_S = 60.0
REFRESH_MIN_S = 15.0

# Why no latest version shows: no internet (or DNS), GitHub's rate limit,
# another HTTP answer, an answer that is not the releases list, or no stable
# release of this major version.
OFFLINE = "OFFLINE"
RATE_LIMITED = "RATE_LIMITED"
HTTP_ERROR = "HTTP_ERROR"
INVALID_ANSWER = "INVALID_ANSWER"
NO_RELEASE = "NO_RELEASE"
CODES = (OFFLINE, RATE_LIMITED, HTTP_ERROR, INVALID_ANSWER, NO_RELEASE)

_VERSION_RE = re.compile(r"^v?(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(?:-([0-9A-Za-z.-]{1,40}))?$")
_TIME_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")


class ReleaseCheckError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def parse_version(text: str) -> Optional[Tuple[int, int, int, bool]]:
    """(major, minor, patch, prerelease) of ``3.23.0`` or ``v3.23.0-rc.1``; None otherwise."""
    match = _VERSION_RE.match(text) if isinstance(text, str) else None
    if match is None:
        return None
    return int(match.group(1)), int(match.group(2)), int(match.group(3)), match.group(4) is not None


def newer(candidate: str, installed: str) -> bool:
    """Whether stable ``candidate`` is above ``installed`` (a prerelease of the same number is below it)."""
    new, old = parse_version(candidate), parse_version(installed)
    if new is None or old is None:
        return False
    if new[:3] != old[:3]:
        return new[:3] > old[:3]
    return old[3] and not new[3]


def pick_release(data: Any, major: Optional[int]) -> Dict[str, Any]:
    """The highest stable release of ``major`` (any major when None) in a /releases answer."""
    if not isinstance(data, list):
        raise ReleaseCheckError(INVALID_ANSWER, "GitHub's answer is not a list of releases")
    best: Optional[Tuple[Tuple[int, int, int], Dict[str, Any]]] = None
    for item in data:
        if not isinstance(item, dict) or item.get("draft") is not False or item.get("prerelease") is not False:
            continue
        parsed = parse_version(item.get("tag_name"))
        if parsed is None or parsed[3] or not str(item.get("tag_name")).startswith("v"):
            continue
        if major is not None and parsed[0] != major:
            continue
        if best is None or parsed[:3] > best[0]:
            url = item.get("html_url")
            published = item.get("published_at")
            best = (parsed[:3], {
                "version": "%d.%d.%d" % parsed[:3],
                "url": url if isinstance(url, str) and url.startswith(RELEASE_PAGE_PREFIX) and len(url) <= 300 else None,
                "published_at": published if isinstance(published, str) and _TIME_RE.match(published) else None,
            })
    if best is None:
        raise ReleaseCheckError(NO_RELEASE, "no stable release of this major version on GitHub")
    return best[1]


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102 (urllib API)
        return None


def http_fetch(url: str, user_agent: str) -> bytes:
    """GET ``url`` anonymously through the environment proxy; raises ReleaseCheckError."""
    # ProxyHandler() reads https_proxy/no_proxy from the environment.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(), _NoRedirects())
    request = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json", "User-Agent": user_agent, "X-GitHub-Api-Version": "2022-11-28",
    })
    try:
        with opener.open(request, timeout=TIMEOUT_S) as response:
            data = response.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as exc:
        remaining = exc.headers.get("X-RateLimit-Remaining") if exc.headers is not None else None
        exc.close()
        if exc.code == 429 or (exc.code == 403 and remaining == "0"):
            raise ReleaseCheckError(RATE_LIMITED, "GitHub's rate limit for this address is used up; try again later") from None
        raise ReleaseCheckError(HTTP_ERROR, f"GitHub answered HTTP {exc.code}") from None
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise ReleaseCheckError(OFFLINE, f"GitHub is not reachable from the console host ({type(reason).__name__})") from None
    if len(data) > MAX_BYTES:
        raise ReleaseCheckError(INVALID_ANSWER, "GitHub's answer is larger than 1 MiB")
    return data


class ReleaseChecker:
    """The latest release of the installed major version, read on demand and cached."""

    def __init__(
        self,
        installed: str,
        fetch: Optional[Callable[[str], bytes]] = None,
        api: str = DEFAULT_API,
        monotonic: Callable[[], float] = time.monotonic,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.installed = installed
        parsed = parse_version(installed)
        self.major: Optional[int] = parsed[0] if parsed else None
        user_agent = f"SDR-DoA-Ground-Console/{installed}"
        self._fetch = fetch or (lambda url: http_fetch(url, user_agent))
        self.url = api.rstrip("/") + RELEASES_PATH
        self._monotonic = monotonic
        self._clock = clock
        self._lock = threading.Lock()
        self._result: Optional[Dict[str, Any]] = None
        self._read_at: Optional[float] = None

    def view(self, refresh: bool = False) -> Dict[str, Any]:
        """{state ok|error, version, url, published_at, code, error, checked_at_ms, major}."""
        with self._lock:
            now = self._monotonic()
            age = None if self._read_at is None else now - self._read_at
            if self._result is not None and age is not None:
                ttl = OK_TTL_S if self._result["state"] == "ok" else ERROR_TTL_S
                if age < (REFRESH_MIN_S if refresh else ttl):
                    return dict(self._result)
            self._result = self._read()
            self._read_at = self._monotonic()
            return dict(self._result)

    def _read(self) -> Dict[str, Any]:
        base: Dict[str, Any] = {
            "version": None, "url": None, "published_at": None, "code": None, "error": None,
            "checked_at_ms": int(self._clock() * 1000), "major": self.major,
        }
        try:
            raw = self._fetch(self.url)
            try:
                data = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, ValueError, RecursionError):
                raise ReleaseCheckError(INVALID_ANSWER, "GitHub's answer is not JSON") from None
            release = pick_release(data, self.major)
        except ReleaseCheckError as exc:
            return {**base, "state": "error", "code": exc.code, "error": exc.message}
        return {**base, "state": "ok", **release}


def latest_view(checker: Optional[ReleaseChecker], installed: str, refresh: bool) -> Dict[str, Any]:
    """The ``latest`` block of GET /api/host/update; ``off`` without a checker (tests, no network)."""
    if checker is None:
        return {"state": "off", "version": None, "url": None, "published_at": None, "code": None, "error": None,
                "checked_at_ms": None, "major": None}
    return checker.view(refresh=refresh)


__all__: List[str] = [
    "CODES", "ReleaseCheckError", "ReleaseChecker", "latest_view", "newer", "parse_version", "pick_release",
]
