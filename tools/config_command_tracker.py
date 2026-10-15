#!/usr/bin/env python3
"""Server-side state of the config patches the Ground Console published.

The browser cannot correlate an ``ack/config`` with its command: the Message
Monitor redacts payload keys that end in ``id``. The console server therefore
remembers what it published and derives each command's state from what the
MQTT monitor observed for that id (PUBACK, the broker echo, the edge agent's
ACK).

This module has no paho dependency, so the console can import it, and raise
``MonitorPublishError``, when paho-mqtt is not installed.
"""

from __future__ import annotations

import threading
import time
import weakref
from typing import Any, Callable, Dict, List, Mapping, Optional

# How long after a command's expiry the console waits for a final ACK before
# it reports ``no_ack``. The edge agent rejects an expired command itself, so
# this only covers ACK transport delay.
NO_ACK_GRACE_MS = 5_000
MAX_TRACKED_COMMANDS = 32

FINAL_ACK_STATUSES = frozenset({"applied", "rejected", "conflict", "expired", "failed"})
PROGRESS_ACK_STATUSES = frozenset({"received", "applying"})
FINAL_STATES = frozenset({"acked", "publish_failed", "no_ack"})
COMMAND_STATES = ("published", "delivered", "acknowledged", "acked", "publish_failed", "no_ack")
# MQTT v5 reason codes of 128 and above are failures (PUBACK "Not authorized"
# is 135, for example).
PUBACK_FAILURE_REASON = 128


class MonitorPublishError(RuntimeError):
    """A config patch could not be handed to the broker.

    ``code`` is one of ``MQTT_NOT_CONNECTED``, ``MQTT_DEPENDENCY_MISSING`` or
    ``MQTT_PUBLISH_FAILED``. Callers match on ``code`` rather than on the class,
    because the monitor module can be imported under two package names.
    """

    def __init__(self, code: str, detail: Optional[str] = None) -> None:
        super().__init__(detail or code)
        self.code = code


def _wall_clock_ms() -> int:
    return int(time.time() * 1000)


def _monitor_reference(monitor: Any, *, strong: bool = False) -> Callable[[], Any]:
    """Remember which monitor published a command.

    While the command is not final the reference is strong: after a reconnect
    the stopped publisher may still hold a PUBACK, echo or final ACK that has
    not been polled yet. At most MAX_TRACKED_COMMANDS entries hold one. A
    final command keeps only a weak reference, so a stopped monitor is freed.
    """
    if monitor is None:
        return lambda: None
    if not strong:
        try:
            return weakref.ref(monitor)
        except TypeError:
            pass
    return lambda: monitor


def _empty_observation() -> Dict[str, Any]:
    return {"puback": None, "echoed_at_ms": None, "ack": None}


def _observe(monitor: Any, command_id: str) -> Dict[str, Any]:
    """Read one monitor's observation for a command, tolerating any failure."""
    reader = getattr(monitor, "config_command_observation", None)
    if monitor is None or not callable(reader):
        return _empty_observation()
    try:
        observed = reader(command_id)
    except Exception:
        return _empty_observation()
    if not isinstance(observed, Mapping):
        return _empty_observation()
    result = _empty_observation()
    puback = observed.get("puback")
    if isinstance(puback, Mapping) and type(puback.get("reason")) is int:
        received = puback.get("received_at_ms")
        result["puback"] = {
            "reason": puback["reason"],
            "received_at_ms": received if type(received) is int else None,
        }
    echoed = observed.get("echoed_at_ms")
    if type(echoed) is int:
        result["echoed_at_ms"] = echoed
    ack = observed.get("ack")
    if isinstance(ack, Mapping) and isinstance(ack.get("status"), str):
        result["ack"] = dict(ack)
    return result


class ConfigCommandTracker:
    """Bounded, thread-safe record of published config patches."""

    def __init__(
        self,
        clock_ms: Optional[Callable[[], int]] = None,
        *,
        max_entries: int = MAX_TRACKED_COMMANDS,
    ) -> None:
        self._clock_ms = clock_ms or _wall_clock_ms
        self._max_entries = max(1, int(max_entries))
        self._lock = threading.RLock()
        self._entries: Dict[str, Dict[str, Any]] = {}

    def now_ms(self) -> int:
        return int(self._clock_ms())

    def record(
        self,
        command: Mapping[str, Any],
        monitor: Any,
        *,
        published_at_ms: Optional[int] = None,
        publish_failed: bool = False,
    ) -> None:
        """Remember a command handed to ``monitor`` (or refused by it)."""
        command_id = str(command["id"])
        changes = command.get("changes")
        entry = {
            "command_id": command_id,
            "issued_ts_ms": int(command["issued_ts_ms"]),
            "expires_ts_ms": int(command["expires_ts_ms"]),
            "base_config_rev": int(command["base_config_rev"]),
            "changes": dict(changes) if isinstance(changes, Mapping) else {},
            "published_at_ms": published_at_ms if published_at_ms is not None else self.now_ms(),
            "monitor": _monitor_reference(monitor, strong=not publish_failed),
            "publish_failed": bool(publish_failed),
            "observed": _empty_observation(),
            "final_state": "publish_failed" if publish_failed else None,
        }
        with self._lock:
            self._entries.pop(command_id, None)
            self._entries[command_id] = entry
            while len(self._entries) > self._max_entries:
                self._entries.pop(next(iter(self._entries)))

    def status(self, command_id: str, current_monitor: Any) -> Optional[Dict[str, Any]]:
        with self._lock:
            entry = self._entries.get(command_id)
            if entry is None:
                return None
            return self._status_locked(entry, current_monitor, self.now_ms())

    def latest(self, current_monitor: Any) -> Optional[Dict[str, Any]]:
        with self._lock:
            if not self._entries:
                return None
            entry = self._entries[next(reversed(self._entries))]
            return self._status_locked(entry, current_monitor, self.now_ms())

    def in_flight(self, current_monitor: Any, now_ms: Optional[int] = None) -> Optional[str]:
        """Return the id of a command that is neither final nor expired."""
        now = self.now_ms() if now_ms is None else int(now_ms)
        with self._lock:
            for entry in reversed(list(self._entries.values())):
                if now > entry["expires_ts_ms"]:
                    continue
                status = self._status_locked(entry, current_monitor, now)
                if not status["final"]:
                    return entry["command_id"]
        return None

    def ids(self) -> List[str]:
        with self._lock:
            return list(self._entries)

    def _merge_observations_locked(self, entry: Dict[str, Any], current_monitor: Any) -> bool:
        """Fold what both monitors saw into the entry; return monitor_restarted."""
        publisher = entry["monitor"]()
        # A collected publisher is gone, so it was replaced too.
        restarted = publisher is None or publisher is not current_monitor
        sources = [current_monitor]
        if restarted and publisher is not None:
            # PUBACK and echo were seen by the publishing client; the ACK may
            # arrive on either, so the current monitor is consulted first.
            sources.append(publisher)
        observed = entry["observed"]
        for monitor in sources:
            fresh = _observe(monitor, entry["command_id"])
            if observed["puback"] is None and fresh["puback"] is not None:
                observed["puback"] = fresh["puback"]
            if observed["echoed_at_ms"] is None and fresh["echoed_at_ms"] is not None:
                observed["echoed_at_ms"] = fresh["echoed_at_ms"]
            ack = fresh["ack"]
            if ack is not None and not self._ack_is_final(observed["ack"]):
                # A progress ACK from the current monitor replaces an older
                # one; the retired monitor only fills a gap or adds a final.
                if self._ack_is_final(ack) or observed["ack"] is None or monitor is current_monitor:
                    observed["ack"] = ack
        return restarted

    @staticmethod
    def _ack_is_final(ack: Optional[Mapping[str, Any]]) -> bool:
        return isinstance(ack, Mapping) and ack.get("status") in FINAL_ACK_STATUSES

    def _status_locked(self, entry: Dict[str, Any], current_monitor: Any, now: int) -> Dict[str, Any]:
        restarted = self._merge_observations_locked(entry, current_monitor)
        observed = entry["observed"]
        puback = observed["puback"]
        ack = observed["ack"]
        state = entry["final_state"]
        # A final state stays final. The one upgrade is a late final ACK after
        # no_ack, which is more information and still final.
        if state is None or (state == "no_ack" and self._ack_is_final(ack)):
            if entry["publish_failed"]:
                state = "publish_failed"
            elif puback is not None and puback["reason"] >= PUBACK_FAILURE_REASON:
                state = "publish_failed"
            elif self._ack_is_final(ack):
                state = "acked"
            elif now > entry["expires_ts_ms"] + NO_ACK_GRACE_MS:
                state = "no_ack"
            elif ack is not None and ack.get("status") in PROGRESS_ACK_STATUSES:
                state = "acknowledged"
            elif puback is not None:
                state = "delivered"
            else:
                state = "published"
            if state in FINAL_STATES:
                if entry["final_state"] is None:
                    entry["monitor"] = _monitor_reference(entry["monitor"]())
                entry["final_state"] = state
        return {
            "command_id": entry["command_id"],
            "state": state,
            "final": state in FINAL_STATES,
            "now_ms": now,
            "issued_ts_ms": entry["issued_ts_ms"],
            "expires_ts_ms": entry["expires_ts_ms"],
            "published_at_ms": entry["published_at_ms"],
            "base_config_rev": entry["base_config_rev"],
            "changes": dict(entry["changes"]),
            "puback_reason": None if puback is None else puback["reason"],
            "echoed": observed["echoed_at_ms"] is not None,
            "monitor_restarted": restarted,
            "ack": None if ack is None else _public_ack(ack),
        }


def _public_ack(ack: Mapping[str, Any]) -> Dict[str, Any]:
    changed = ack.get("changed_fields")
    return {
        "status": ack.get("status"),
        "config_rev": ack.get("config_rev") if type(ack.get("config_rev")) is int else None,
        "readback_ok": ack.get("readback_ok") if isinstance(ack.get("readback_ok"), bool) else None,
        "error_code": ack.get("error_code") if isinstance(ack.get("error_code"), str) else None,
        "current_config_rev": (
            ack.get("current_config_rev") if type(ack.get("current_config_rev")) is int else None
        ),
        "changed_fields": [field for field in changed if isinstance(field, str)] if isinstance(changed, list) else [],
        "received_at_ms": ack.get("received_at_ms") if type(ack.get("received_at_ms")) is int else None,
    }


__all__ = [
    "COMMAND_STATES",
    "ConfigCommandTracker",
    "FINAL_ACK_STATUSES",
    "MonitorPublishError",
    "NO_ACK_GRACE_MS",
]
