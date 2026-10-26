"""One Data Out read shared by every viewer of ``/api/snapshot``.

The node sits behind a T900 PPP link of about 5.6 kB/s, and one collection
reads about 8 kB (status.json 650 B, settings.json 4.7 kB, DOA_value.html
2.3 kB, doa.xml 455 B). A single-flight alone only merged requests that
arrived while a collection ran, so every browser tick after it started four
new GETs and N viewers cost N times the link. This module keeps the last
collection per base URL and answers from it:

- A request is answered from the last collection while that is younger than
  the reuse window, ``max(1 s, saved refresh interval)``, counted from when
  the collection started reading the node.
- A viewer that already shows that collection (it sends its ``id`` as
  ``seen``) gets a new read once the collection is ``window - 0.25 s`` old,
  so one viewer still gets new data on every tick, and N viewers polling every
  T seconds cause one collection per T between them.
- A manual Refresh (``refresh``) reads again only when the last collection is
  at least 1 s old. ``fresh_settings`` (Kontrol's "Cek ulang") also makes the
  collector read settings.json instead of reusing its recent copy: at once
  when the last collection reused settings.json, otherwise after the same 1 s.
- Requests that arrive while a collection runs wait for it (single flight).
- A failed collection is kept the same way, so an unreachable node is not
  asked again by every viewer, never for longer than the window.

``DataOutReader.read_reason`` is the one place that decides whether a request
needs a new Data Out read. Each answer carries the reuse facts in its
``collection`` block (``id``, ``collected_at_ms``, ``age_ms``, ``shared``,
``settings_reused``, ``settings_age_ms``), so the browser can age the data
from when the node was read rather than from when the answer arrived.
"""

from __future__ import annotations

import math
import re
import secrets
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from sdr_doa_collector import CollectorError

MIN_REUSE_WINDOW_S = 1.0
# How much earlier than the window a viewer that already shows the last
# collection may read again. A browser polls one interval after its previous
# request started, so without it a viewer would land on the window edge and
# get the same collection back about half the time.
SEEN_READ_SLACK_S = 0.25
MANUAL_READ_MIN_AGE_S = 1.0
MAX_CACHED_TARGETS = 16
COLLECTION_ID_RE = re.compile(r"[0-9a-f]{8}-[0-9]{1,12}")


def reuse_window_s(refresh_seconds: Any) -> float:
    """The reuse window for a saved refresh interval: the interval, at least 1 s."""
    if isinstance(refresh_seconds, bool) or not isinstance(refresh_seconds, (int, float)):
        return MIN_REUSE_WINDOW_S
    seconds = float(refresh_seconds)
    if not math.isfinite(seconds):
        return MIN_REUSE_WINDOW_S
    return max(MIN_REUSE_WINDOW_S, seconds)


def valid_collection_id(value: Any) -> Optional[str]:
    """A ``seen`` value as the server issued it, else None."""
    if isinstance(value, str) and COLLECTION_ID_RE.fullmatch(value):
        return value
    return None


@dataclass(frozen=True)
class SnapshotRequest:
    """What one /api/snapshot request asks for."""

    refresh: bool = False
    fresh_settings: bool = False
    # The collection id the viewer already shows, if any.
    seen: Optional[str] = None


class _Collection:
    """One collection, running or done, and when it read the node."""

    def __init__(self, collection_id: str, started: float, force_settings: bool) -> None:
        self.id = collection_id
        self.started = started
        self.force_settings = force_settings
        self.done = threading.Event()
        self.completed: Optional[float] = None
        self.result: Optional[Dict[str, Any]] = None
        self.error: Optional[BaseException] = None

    @property
    def settings_reused(self) -> bool:
        collection = (self.result or {}).get("collection")
        return isinstance(collection, dict) and collection.get("settings_reused") is True


class _Target:
    """The state kept for one base URL."""

    def __init__(self) -> None:
        self.last: Optional[_Collection] = None
        self.running: Optional[_Collection] = None


class DataOutReader:
    """Shared, rate-limited Data Out collections for /api/snapshot."""

    def __init__(
        self,
        collect: Callable[[str, bool], Dict[str, Any]],
        refresh_seconds: Callable[[], Any],
        wait_timeout_s: float,
        clock: Callable[[], float] = time.monotonic,
        wall_ms: Callable[[], int] = lambda: int(time.time() * 1000),
    ) -> None:
        """``collect(base_url, fresh_settings)`` runs one collection."""
        self._collect = collect
        self._refresh_seconds = refresh_seconds
        self._wait_timeout_s = float(wait_timeout_s)
        self.clock = clock
        self.wall_ms = wall_ms
        self._lock = threading.Lock()
        self._targets: "OrderedDict[str, _Target]" = OrderedDict()
        self._boot = secrets.token_hex(4)
        self._count = 0

    def window_s(self) -> float:
        return reuse_window_s(self._refresh_seconds())

    def read_reason(self, last: Optional[_Collection], request: SnapshotRequest, age_s: float, window_s: float) -> Optional[str]:
        """Why this request needs a new Data Out read, or None to answer from ``last``.

        This is the single place that decides when Data Out is read. Issue #8
        (MQTT first, Data Out as the fallback) adds its rule here, so the
        console stops reading Data Out while MQTT is fresh.
        """
        if last is None:
            return "first"
        if request.fresh_settings and (age_s >= MANUAL_READ_MIN_AGE_S or last.settings_reused):
            return "fresh_settings"
        if request.refresh:
            return "refresh" if age_s >= MANUAL_READ_MIN_AGE_S else None
        if request.seen is not None and request.seen == last.id:
            return "seen" if age_s >= window_s - SEEN_READ_SLACK_S else None
        return "expired" if age_s >= window_s else None

    def snapshot(self, base_url: str, request: SnapshotRequest = SnapshotRequest()) -> Dict[str, Any]:
        """Answer one request, reading Data Out only when ``read_reason`` asks for it."""
        key = base_url.rstrip("/")
        # A collection that runs is newer than anything kept, so a request
        # waits for it. Kontrol's "Cek ulang" waits for one that may reuse
        # settings.json and then decides again; two rounds are enough.
        for _ in range(2):
            with self._lock:
                target = self._targets.get(key)
                if target is None:
                    target = _Target()
                    self._targets[key] = target
                    while len(self._targets) > MAX_CACHED_TARGETS:
                        oldest_key, oldest = next(iter(self._targets.items()))
                        if oldest.running is not None:
                            break
                        self._targets.pop(oldest_key)
                self._targets.move_to_end(key)
                now = self.clock()
                running = target.running
                if running is None:
                    last = target.last
                    age_s = now - last.started if last is not None else 0.0
                    reason = self.read_reason(last, request, age_s, self.window_s())
                    if reason is None and last is not None:
                        return self._answer(last, shared=True)
                    self._count += 1
                    running = _Collection(f"{self._boot}-{self._count}", now, request.fresh_settings)
                    target.running = running
                    leader = True
                else:
                    leader = False
            if leader:
                return self._lead(base_url, target, running)
            if not running.done.wait(self._wait_timeout_s):
                raise CollectorError("snapshot collection is still in progress")
            if request.fresh_settings and not running.force_settings and running.settings_reused:
                continue
            return self._answer(running, shared=True)
        return self._answer(running, shared=True)

    def _lead(self, base_url: str, target: _Target, running: _Collection) -> Dict[str, Any]:
        try:
            result = self._collect(base_url, running.force_settings)
        except Exception as exc:
            running.error = exc
            self._finish(target, running, keep=True)
            raise
        except BaseException as exc:
            running.error = exc
            self._finish(target, running, keep=False)
            raise
        running.result = result
        self._finish(target, running, keep=True)
        return self._answer(running, shared=False)

    def _finish(self, target: _Target, running: _Collection, keep: bool) -> None:
        with self._lock:
            running.completed = self.clock()
            if target.running is running:
                target.running = None
            if keep:
                target.last = running
        running.done.set()

    def _answer(self, collection: _Collection, shared: bool) -> Dict[str, Any]:
        if collection.error is not None:
            raise CollectorError(str(collection.error) or type(collection.error).__name__)
        result = dict(collection.result or {})
        block = dict(result.get("collection") or {})
        completed = collection.completed if collection.completed is not None else self.clock()
        age_ms = max(0, int(round((self.clock() - completed) * 1000)))
        collected_at_ms = result.get("completed_at_ms")
        if isinstance(collected_at_ms, bool) or not isinstance(collected_at_ms, int):
            collected_at_ms = self.wall_ms() - age_ms
        block.update({
            "id": collection.id,
            "collected_at_ms": collected_at_ms,
            "age_ms": age_ms,
            "shared": shared,
        })
        settings_age = block.get("settings_age_ms")
        if isinstance(settings_age, int) and not isinstance(settings_age, bool):
            block["settings_age_ms"] = settings_age + age_ms
        block.setdefault("settings_reused", False)
        result["collection"] = block
        return result
