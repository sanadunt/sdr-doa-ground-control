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
from when the node was read rather than from when the answer arrived, the
saved interval the window comes from (``refresh_seconds``), so a page that
loaded another interval polls at the console's and re-reads its config, and
the console's Data Out URL (``console_base_url``), so a page that loaded
another URL (another page saved a new one) re-reads its config too instead of
keeping a second read of the old target.

MQTT first (issue #8, ``telemetry_source.py``): while MQTT is fresh (a
``telemetry/health`` of the current session at most 8 s old with ``daq=1``)
every answer is built from MQTT and no full collection runs. Only a light
read (status.json, settings.json and doa.xml, about 5.8 kB) refreshes what
MQTT never carries: the station position, the settings fields and the ADC
overdrive. It runs in the background at most every ``LIGHT_READ_INTERVAL_S``
(30 s), at once when the node's config revision (``state.cfg``) or session
changes (at most once a second), and for Kontrol's "Cek ulang"
(``fresh_settings``), which waits for it. A manual Refresh reads no Data Out
while MQTT is fresh. When MQTT stops being fresh the next request reads Data
Out fully, as before. Every answer says which source it came from and why
(``source``).
"""

from __future__ import annotations

import functools
import math
import re
import secrets
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

import telemetry_source as ts
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
LIGHT_READ_INTERVAL_S = ts.LIGHT_READ_INTERVAL_S


def _start_thread(function: Callable[[], None]) -> None:
    threading.Thread(target=function, name="sdr-doa-light-read", daemon=True).start()


def reuse_window_s(refresh_seconds: Any) -> float:
    """The reuse window for a saved refresh interval: the interval, at least 1 s."""
    if isinstance(refresh_seconds, bool) or not isinstance(refresh_seconds, (int, float)):
        return MIN_REUSE_WINDOW_S
    seconds = float(refresh_seconds)
    if not math.isfinite(seconds):
        return MIN_REUSE_WINDOW_S
    return max(MIN_REUSE_WINDOW_S, seconds)


def saved_refresh_seconds(refresh_seconds: Any) -> Optional[int]:
    """The saved refresh interval as answers report it: a whole number of seconds, else None."""
    if isinstance(refresh_seconds, bool) or not isinstance(refresh_seconds, int) or refresh_seconds < 0:
        return None
    return refresh_seconds


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
    # Data Out even while MQTT is fresh: the legacy UI (--legacy-ui), which
    # renders only the CSV and XML views (source=data_out).
    data_out_only: bool = False


class _Collection:
    """One collection, running or done, and when it read the node."""

    def __init__(
        self, collection_id: str, started: float, force_settings: bool,
        mark: Tuple[Optional[str], Optional[int]] = (None, None), reason: Optional[str] = None,
    ) -> None:
        self.id = collection_id
        self.started = started
        self.force_settings = force_settings
        # A light read: the MQTT session id and config revision it started
        # under, and why it ran.
        self.mark = mark
        self.reason = reason
        self.done = threading.Event()
        self.completed: Optional[float] = None
        self.result: Optional[Dict[str, Any]] = None
        self.error: Optional[BaseException] = None

    @property
    def settings_reused(self) -> bool:
        collection = (self.result or {}).get("collection")
        return isinstance(collection, dict) and collection.get("settings_reused") is True


def _console_url(value: Any) -> Optional[str]:
    return value.rstrip("/") if isinstance(value, str) and value else None


class _Target:
    """The state kept for one base URL."""

    def __init__(self) -> None:
        self.last: Optional[_Collection] = None
        self.running: Optional[_Collection] = None
        # The light reads that run while MQTT is fresh.
        self.light: Optional[_Collection] = None
        self.light_running: Optional[_Collection] = None


class DataOutReader:
    """Shared, rate-limited Data Out collections for /api/snapshot, after MQTT."""

    def __init__(
        self,
        collect: Callable[[str, bool], Dict[str, Any]],
        refresh_seconds: Callable[[], Any],
        wait_timeout_s: float,
        clock: Callable[[], float] = time.monotonic,
        wall_ms: Callable[[], int] = lambda: int(time.time() * 1000),
        console_base_url: Callable[[], Any] = lambda: None,
        *,
        collect_light: Optional[Callable[[str, bool], Dict[str, Any]]] = None,
        mqtt_view: Callable[[], Optional[Mapping[str, Any]]] = lambda: None,
        light_interval_s: float = LIGHT_READ_INTERVAL_S,
        run_background: Callable[[Callable[[], None]], None] = _start_thread,
    ) -> None:
        """``collect(base_url, fresh_settings)`` runs one collection.

        ``mqtt_view()`` returns the RDF Node view of the MQTT monitor (or None
        without one), and ``collect_light(base_url, fresh_settings)`` runs one
        light read while MQTT is fresh; ``run_background`` starts it off the
        request (tests run it in place).
        """
        self._collect = collect
        self._collect_light = collect_light
        self._mqtt_view = mqtt_view
        self._light_interval_s = float(light_interval_s)
        self._run_background = run_background
        self._refresh_seconds = refresh_seconds
        self._console_base_url = console_base_url
        self._wait_timeout_s = float(wait_timeout_s)
        self.clock = clock
        self.wall_ms = wall_ms
        self._lock = threading.Lock()
        self._targets: "OrderedDict[str, _Target]" = OrderedDict()
        self._boot = secrets.token_hex(4)
        self._count = 0

    def window_s(self) -> float:
        return reuse_window_s(self._refresh_seconds())

    def read_reason(
        self,
        last: Optional[_Collection],
        request: SnapshotRequest,
        age_s: float,
        window_s: float,
        mqtt: Optional[Tuple[Optional[str], Optional[int]]] = None,
    ) -> Optional[str]:
        """Why this request needs a new Data Out read, or None to answer from ``last``.

        This is the single place that decides when Data Out is read. While
        MQTT is fresh (issue #8) ``mqtt`` is its session id and config
        revision, ``last`` and ``age_s`` describe the last light read, and no
        full collection runs: the reason is one for a light read
        ("light-first", "light-fresh_settings", "light-config" when the
        session or ``state.cfg`` moved since the last light read started,
        "light-interval") or None. A manual Refresh reads nothing then.
        """
        if mqtt is not None:
            if last is None:
                return "light-first"
            if request.fresh_settings and (age_s >= MANUAL_READ_MIN_AGE_S or last.settings_reused):
                return "light-fresh_settings"
            if last.mark != mqtt and age_s >= MANUAL_READ_MIN_AGE_S:
                return "light-config"
            return "light-interval" if age_s >= self._light_interval_s else None
        if last is None:
            return "first"
        if request.fresh_settings and (age_s >= MANUAL_READ_MIN_AGE_S or last.settings_reused):
            return "fresh_settings"
        if request.refresh:
            return "refresh" if age_s >= MANUAL_READ_MIN_AGE_S else None
        if request.seen is not None and request.seen == last.id:
            return "seen" if age_s >= window_s - SEEN_READ_SLACK_S else None
        return "expired" if age_s >= window_s else None

    def _read_mqtt_view(self) -> Optional[Mapping[str, Any]]:
        try:
            view = self._mqtt_view()
        except Exception:
            return None
        return view if isinstance(view, Mapping) else None

    def _target_locked(self, key: str) -> _Target:
        target = self._targets.get(key)
        if target is None:
            target = _Target()
            self._targets[key] = target
            while len(self._targets) > MAX_CACHED_TARGETS:
                oldest_key, oldest = next(iter(self._targets.items()))
                if oldest.running is not None or oldest.light_running is not None:
                    break
                self._targets.pop(oldest_key)
        self._targets.move_to_end(key)
        return target

    def snapshot(self, base_url: str, request: SnapshotRequest = SnapshotRequest()) -> Dict[str, Any]:
        """Answer one request: from MQTT while it is fresh, else from Data Out.

        Data Out is read only when ``read_reason`` asks for it. The answer's
        ``source`` says which source it came from and why.
        """
        view = self._read_mqtt_view()
        fresh, reasons = ts.mqtt_freshness(view)
        if fresh and request.data_out_only:
            fresh, reasons = False, [ts.DATA_OUT_REQUESTED]
        if fresh and view is not None:
            answer = self._mqtt_snapshot(base_url, request, view)
            if answer is not None:
                return answer
            # MQTT went stale while Kontrol's "Cek ulang" waited for settings.
            view = self._read_mqtt_view()
            fresh, reasons = ts.mqtt_freshness(view)
        return ts.with_source(self._data_out_snapshot(base_url, request), view, reasons)

    def _mqtt_snapshot(self, base_url: str, request: SnapshotRequest, view: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
        key = base_url.rstrip("/")
        mark = ts.mqtt_mark(view)
        waited = False
        # A light read starts in the background, except for Kontrol's "Cek
        # ulang", which waits for settings.json as it does for a full read;
        # one that may reuse settings.json makes it decide again.
        for _ in range(2):
            start: Optional[_Collection] = None
            wait_for: Optional[_Collection] = None
            with self._lock:
                target = self._target_locked(key)
                if self._collect_light is None:
                    break
                running = target.light_running
                if running is None:
                    last = target.light
                    now = self.clock()
                    age_s = now - last.started if last is not None else 0.0
                    reason = self.read_reason(last, request, age_s, self.window_s(), mqtt=mark)
                    if reason is not None:
                        self._count += 1
                        running = _Collection(f"{self._boot}-{self._count}", now, request.fresh_settings, mark, reason)
                        target.light_running = running
                        start = running
                if request.fresh_settings:
                    wait_for = running
            if start is not None:
                if wait_for is start:
                    self._lead_light(base_url, target, start)
                else:
                    self._run_background(functools.partial(self._lead_light, base_url, target, start))
            if wait_for is None:
                break
            waited = True
            if wait_for is not start:
                if not wait_for.done.wait(self._wait_timeout_s):
                    break
                if not wait_for.force_settings and wait_for.settings_reused:
                    continue
            break
        if waited:
            fresher = self._read_mqtt_view()
            if fresher is None or not ts.mqtt_freshness(fresher)[0]:
                return None
            view = fresher
        return self._mqtt_answer(base_url, key, view)

    def _lead_light(self, base_url: str, target: _Target, running: _Collection) -> None:
        try:
            if self._collect_light is None:
                raise CollectorError("no light read configured")
            running.result = self._collect_light(base_url, running.force_settings)
        except Exception as exc:
            running.error = exc
        finally:
            with self._lock:
                running.completed = self.clock()
                if target.light_running is running:
                    target.light_running = None
                target.light = running
            running.done.set()

    def _mqtt_answer(self, base_url: str, key: str, view: Mapping[str, Any]) -> Dict[str, Any]:
        with self._lock:
            target = self._target_locked(key)
            light = target.light
            running = target.light_running is not None
            self._count += 1
            answer_id = f"{self._boot}-{self._count}"
            now = self.clock()
        result: Optional[Dict[str, Any]] = None
        age_ms: Optional[int] = None
        error: Optional[str] = None
        if light is not None:
            if light.error is not None:
                error = str(light.error) or type(light.error).__name__
            else:
                result = light.result
            if light.completed is not None:
                age_ms = max(0, int(round((now - light.completed) * 1000)))
        meta = {
            "interval_s": self._light_interval_s,
            "reason": light.reason if light is not None else None,
            "running": running,
            "error": error,
        }
        answer = ts.mqtt_snapshot(
            view, result, base_url=base_url, light_age_ms=age_ms if result is not None else None, light_meta=meta,
        )
        answer["collection"].update({
            "id": answer_id,
            "collected_at_ms": answer["completed_at_ms"],
            # Built from the MQTT store now: nothing waited on the console.
            "age_ms": 0,
            "shared": False,
            "refresh_seconds": saved_refresh_seconds(self._refresh_seconds()),
            "console_base_url": _console_url(self._console_base_url()),
        })
        return answer

    def _data_out_snapshot(self, base_url: str, request: SnapshotRequest) -> Dict[str, Any]:
        key = base_url.rstrip("/")
        # A collection that runs is newer than anything kept, so a request
        # waits for it. Kontrol's "Cek ulang" waits for one that may reuse
        # settings.json and then decides again; two rounds are enough.
        for _ in range(2):
            with self._lock:
                target = self._target_locked(key)
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
            # The saved interval now, which sets the window: a page polling at
            # another interval (it loaded the config before another page
            # changed it) follows the console's.
            "refresh_seconds": saved_refresh_seconds(self._refresh_seconds()),
            # The console's Data Out URL now: a page still reading the URL it
            # loaded before another page saved a new one re-reads the config.
            "console_base_url": _console_url(self._console_base_url()),
        })
        settings_age = block.get("settings_age_ms")
        if isinstance(settings_age, int) and not isinstance(settings_age, bool):
            block["settings_age_ms"] = settings_age + age_ms
        block.setdefault("settings_reused", False)
        result["collection"] = block
        return result
