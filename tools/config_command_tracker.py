#!/usr/bin/env python3
"""Server-side state of the RDF Node commands Kontrol published.

Kontrol sends ``config.patch`` and ``config.get`` to the RDF Node edge
(``tools/rdf_node_commands.py``). The console server remembers each command it
published and derives its state from what the MQTT monitor observed for that
id: the broker's PUBACK, the edge's ACKs on ``ack/config`` and, for a
``config.get``, the ``settings/reported`` answer. The browser only polls the
state; it never sees the payload ids it would need to match ACKs itself.

States (``COMMAND_STATES``):

* ``published``: handed to the broker, no PUBACK yet;
* ``delivered``: the broker answered PUBACK below 128;
* ``acknowledged``: a progress ACK (``ACCEPTED``, ``APPLYING``, ``VERIFYING``),
  or a ``config.get`` the edge answered ``APPLIED`` whose settings report has
  not arrived yet;
* ``acked`` (final): the edge's final ACK, whatever it says (``APPLIED``,
  ``PERSISTED_UNVERIFIED``, ``OUTCOME_UNKNOWN``, ``REJECTED``, ``CONFLICT``,
  ``EXPIRED``, ``FAILED``, ``CANCELLED``); the ACK itself is in the status;
* ``reported`` (final): a ``config.get`` whose ``settings/reported`` arrived;
* ``publish_failed`` (final): the publish failed or the PUBACK was 128 or above;
* ``no_ack`` (final): no ACK at all by ``expires_ms`` plus ``NO_ACK_GRACE_MS``;
* ``no_final_ack`` (final): the edge acknowledged the command but sent no final
  ACK within ``FINAL_ACK_WAIT_MS`` of issuing it; its outcome is unknown;
* ``no_report`` (final): a ``config.get`` answered ``APPLIED`` without a
  settings report within ``SETTINGS_REPORT_WAIT_MS``.

A final state stays final; a late final ACK (or a late report) still upgrades
``no_ack``, ``no_final_ack`` and ``no_report``, because it is more information.
Nothing here retries a command or sends another one.

This module has no paho dependency, so the console can import it, and raise
``MonitorPublishError``, when paho-mqtt is not installed.
"""

from __future__ import annotations

import threading
import time
import weakref
from typing import Any, Callable, Dict, List, Mapping, Optional

# How long after a command's expiry the console waits for a first ACK. The
# edge refuses an expired command itself, so this only covers ACK transport.
NO_ACK_GRACE_MS = 5_000
# After a progress ACK the edge may verify for up to its verify_seconds (at
# most 60 s, default 12 s) behind an 8 s helper call before its final ACK.
FINAL_ACK_WAIT_MS = 90_000
# The edge keeps one settings request; the console keeps its id for 60 s
# (command TTL at most 30 s plus the report's 30 s expiry).
SETTINGS_REPORT_WAIT_MS = 60_000
MAX_TRACKED_COMMANDS = 32

FINAL_ACK_STATUSES = frozenset({
    "APPLIED", "FAILED", "REJECTED", "EXPIRED", "CONFLICT", "PERSISTED_UNVERIFIED", "OUTCOME_UNKNOWN", "CANCELLED",
})
PROGRESS_ACK_STATUSES = frozenset({
    "ACCEPTED", "APPLYING", "VERIFYING", "REBOOT_SCHEDULED", "SHUTDOWN_SCHEDULED", "PPP_RESTART_REQUESTED",
})
COMMAND_STATES = (
    "published", "delivered", "acknowledged", "acked", "reported",
    "publish_failed", "no_ack", "no_final_ack", "no_report",
)
FINAL_STATES = frozenset({"acked", "reported", "publish_failed", "no_ack", "no_final_ack", "no_report"})
# Final states a later observation may still replace with a better one.
_TIMEOUT_STATES = frozenset({"no_ack", "no_final_ack", "no_report"})
# MQTT v5 reason codes of 128 and above are failures (PUBACK "Not authorized"
# is 135, for example).
PUBACK_FAILURE_REASON = 128

OP_CONFIG_GET = "config.get"
OP_CONFIG_PATCH = "config.patch"


class MonitorPublishError(RuntimeError):
    """A command could not be handed to the broker.

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
    the stopped publisher may still hold a PUBACK or ACK that has not been
    polled yet. At most MAX_TRACKED_COMMANDS entries hold one. A final command
    keeps only a weak reference, so a stopped monitor is freed.
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
    return {"puback": None, "progress": None, "final": None, "reported_at_ms": None}


def _ack_or_none(value: Any, final: bool) -> Optional[Dict[str, Any]]:
    if not isinstance(value, Mapping) or not isinstance(value.get("status"), str):
        return None
    if (value["status"] in FINAL_ACK_STATUSES) is not final:
        return None
    result = value.get("result")
    return {
        "status": value["status"],
        "t": value.get("t") if type(value.get("t")) is int else None,
        "rev": value.get("rev") if type(value.get("rev")) is int else None,
        "result": dict(result) if isinstance(result, Mapping) else {},
        "received_at_ms": value.get("received_at_ms") if type(value.get("received_at_ms")) is int else None,
    }


def _observe(monitor: Any, command_id: str) -> Dict[str, Any]:
    """Read one monitor's observation for a command, tolerating any failure."""
    reader = getattr(monitor, "rdf_node_command_observation", None)
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
    result["progress"] = _ack_or_none(observed.get("progress"), final=False)
    result["final"] = _ack_or_none(observed.get("final"), final=True)
    reported = observed.get("reported_at_ms")
    if type(reported) is int:
        result["reported_at_ms"] = reported
    return result


def _text(value: Any, limit: int = 64) -> Optional[str]:
    return value if isinstance(value, str) and 0 < len(value) <= limit else None


def public_ack(ack: Optional[Mapping[str, Any]]) -> Optional[Dict[str, Any]]:
    """What Kontrol shows of an ACK: status, error, reason, revision, proof."""
    if ack is None:
        return None
    result = ack.get("result") if isinstance(ack.get("result"), Mapping) else {}
    revision = result.get("revision")
    proof = result.get("proof")
    persisted = result.get("persisted")
    return {
        "status": ack["status"],
        "final": ack["status"] in FINAL_ACK_STATUSES,
        "error": _text(result.get("error")),
        "reason": _text(result.get("reason")),
        "revision": revision if type(revision) is int else ack.get("rev"),
        # config.patch: field -> FRESH_* evidence; config.get: "runtime", "persisted_unverified", ...
        "proof": (
            {str(key): value for key, value in proof.items() if isinstance(key, str) and _text(value)}
            if isinstance(proof, Mapping) else _text(proof)
        ),
        "persisted": persisted if isinstance(persisted, bool) else None,
        "t": ack.get("t"),
        "received_at_ms": ack.get("received_at_ms"),
    }


class ConfigCommandTracker:
    """Bounded, thread-safe record of the commands this console published."""

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
        topic: Optional[str] = None,
        published_at_ms: Optional[int] = None,
        publish_failed: bool = False,
    ) -> None:
        """Remember a command envelope handed to ``monitor`` (or refused by it)."""
        command_id = str(command["id"])
        changes = command.get("changes")
        base_rev = command.get("base_rev")
        sid = command.get("sid")
        entry = {
            "command_id": command_id,
            "op": str(command["op"]),
            "sid": sid if isinstance(sid, str) else None,
            "topic": topic,
            "issued_ms": int(command["issued_ms"]),
            "expires_ms": int(command["expires_ms"]),
            "base_rev": base_rev if type(base_rev) is int else None,
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
            self._evict_locked(command_id, monitor)

    def _evict_locked(self, keep: str, monitor: Any) -> None:
        """Drop the oldest final commands beyond the bound, never one that is not final.

        config.get and config.patch share the list, so evicting by age alone
        let a run of quick config.get commands push out a config.patch still
        waiting for its final ACK: in_flight() would miss it, a second patch
        would pass COMMAND_IN_FLIGHT and its status would answer 404. A
        command that is not final stays; the server's guards keep those few
        (one patch, one get), and each turns final by its own timeout, after
        which a later record() drops it.
        """
        excess = len(self._entries) - self._max_entries
        if excess <= 0:
            return
        now = self.now_ms()
        final_ids = [
            command_id for command_id, entry in self._entries.items()
            if command_id != keep and self._status_locked(entry, monitor, now)["final"]
        ]
        for command_id in final_ids[:excess]:
            self._entries.pop(command_id, None)

    def status(self, command_id: str, current_monitor: Any) -> Optional[Dict[str, Any]]:
        with self._lock:
            entry = self._entries.get(command_id)
            if entry is None:
                return None
            return self._status_locked(entry, current_monitor, self.now_ms())

    def latest(self, current_monitor: Any, op: Optional[str] = OP_CONFIG_PATCH) -> Optional[Dict[str, Any]]:
        """The newest command of ``op`` (any op with None), or None."""
        with self._lock:
            for entry in reversed(list(self._entries.values())):
                if op is None or entry["op"] == op:
                    return self._status_locked(entry, current_monitor, self.now_ms())
        return None

    def in_flight(self, current_monitor: Any, op: str = OP_CONFIG_PATCH, now_ms: Optional[int] = None) -> Optional[str]:
        """The id of a command of ``op`` that is not final yet, or None."""
        now = self.now_ms() if now_ms is None else int(now_ms)
        with self._lock:
            for entry in reversed(list(self._entries.values())):
                if entry["op"] != op:
                    continue
                status = self._status_locked(entry, current_monitor, now)
                if not status["final"]:
                    return entry["command_id"]
        return None

    def last_issued_at(self, op: str) -> Optional[int]:
        """When the newest command of ``op`` that reached the broker was issued (tracker clock)."""
        with self._lock:
            times = [entry["issued_ms"] for entry in self._entries.values()
                     if entry["op"] == op and not entry["publish_failed"]]
        return max(times) if times else None

    def hand_over(self, current_monitor: Any, replacement: Any) -> int:
        """Have ``replacement`` follow every command that is not final yet.

        Called before the server swaps in a new monitor. The edge's ACKs, and
        a ``config.get``'s settings report, reach only the client that is
        connected, and a monitor follows only ids it published or adopted, so
        without this a reconnect would leave a pending command to time out.
        Returns how many the replacement took; a monitor without the method
        (no paho) takes none.
        """
        adopt = getattr(replacement, "adopt_rdf_node_commands", None)
        if replacement is None or not callable(adopt):
            return 0
        now = self.now_ms()
        with self._lock:
            pending = [
                {"command_id": entry["command_id"], "op": entry["op"], "sid": entry["sid"]}
                for entry in self._entries.values()
                if not entry["publish_failed"] and not self._status_locked(entry, current_monitor, now)["final"]
            ]
        if not pending:
            return 0
        try:
            taken = adopt(pending)
        except Exception:
            return 0
        return taken if type(taken) is int else 0

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
            # The PUBACK was seen by the publishing client; an ACK may arrive
            # on either, so the current monitor is consulted first.
            sources.append(publisher)
        observed = entry["observed"]
        for monitor in sources:
            fresh = _observe(monitor, entry["command_id"])
            if observed["puback"] is None and fresh["puback"] is not None:
                observed["puback"] = fresh["puback"]
            if observed["final"] is None and fresh["final"] is not None:
                observed["final"] = fresh["final"]
            if fresh["progress"] is not None and (observed["progress"] is None or monitor is current_monitor):
                observed["progress"] = fresh["progress"]
            if observed["reported_at_ms"] is None and fresh["reported_at_ms"] is not None:
                observed["reported_at_ms"] = fresh["reported_at_ms"]
        return restarted

    def _derive_locked(self, entry: Dict[str, Any], now: int) -> str:
        observed = entry["observed"]
        puback = observed["puback"]
        final = observed["final"]
        if entry["publish_failed"] or (puback is not None and puback["reason"] >= PUBACK_FAILURE_REASON):
            return "publish_failed"
        if final is not None:
            if entry["op"] == OP_CONFIG_GET and final["status"] == "APPLIED":
                if observed["reported_at_ms"] is not None:
                    return "reported"
                if now > entry["issued_ms"] + SETTINGS_REPORT_WAIT_MS:
                    return "no_report"
                return "acknowledged"
            return "acked"
        if observed["progress"] is not None:
            return "no_final_ack" if now > entry["issued_ms"] + FINAL_ACK_WAIT_MS else "acknowledged"
        if now > entry["expires_ms"] + NO_ACK_GRACE_MS:
            return "no_ack"
        return "delivered" if puback is not None else "published"

    def _status_locked(self, entry: Dict[str, Any], current_monitor: Any, now: int) -> Dict[str, Any]:
        restarted = self._merge_observations_locked(entry, current_monitor)
        state = self._derive_locked(entry, now)
        previous = entry["final_state"]
        # A final state never goes back to a waiting one; a timeout may still
        # give way to the answer that arrived late.
        if previous is not None and (state not in FINAL_STATES or previous not in _TIMEOUT_STATES):
            state = previous
        if state in FINAL_STATES and previous is None:
            entry["monitor"] = _monitor_reference(entry["monitor"]())
        if state in FINAL_STATES:
            entry["final_state"] = state
        observed = entry["observed"]
        ack = observed["final"] or observed["progress"]
        return {
            "command_id": entry["command_id"],
            "op": entry["op"],
            "topic": entry["topic"],
            "state": state,
            "final": state in FINAL_STATES,
            "now_ms": now,
            "issued_ms": entry["issued_ms"],
            "expires_ms": entry["expires_ms"],
            "published_at_ms": entry["published_at_ms"],
            "base_rev": entry["base_rev"],
            "changes": dict(entry["changes"]),
            "puback_reason": None if observed["puback"] is None else observed["puback"]["reason"],
            "monitor_restarted": restarted,
            "ack": public_ack(ack),
            "settings_reported_at_ms": observed["reported_at_ms"],
        }


__all__ = [
    "COMMAND_STATES",
    "ConfigCommandTracker",
    "FINAL_ACK_STATUSES",
    "FINAL_ACK_WAIT_MS",
    "FINAL_STATES",
    "MonitorPublishError",
    "NO_ACK_GRACE_MS",
    "PROGRESS_ACK_STATUSES",
    "SETTINGS_REPORT_WAIT_MS",
    "public_ack",
]
