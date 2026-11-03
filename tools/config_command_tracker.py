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
  ACK within ``FINAL_ACK_WAIT_MS`` of issuing it (``RESTART_FINAL_ACK_WAIT_MS``
  once any progress ACK of a contract 1.7 edge named its method, and at least
  until a contract 1.10 ``final_within_ms`` ran out); its outcome is unknown;
* ``no_report`` (final): a ``config.get`` answered ``APPLIED`` without a
  settings report within ``SETTINGS_REPORT_WAIT_MS``.

A final state stays final; a late final ACK (or a late report) still upgrades
``no_ack``, ``no_final_ack`` and ``no_report``, because it is more information
(``late_answer_possible`` says so, and ``hand_over`` passes such a command to a
new monitor, both for ``FINAL_WITHIN_MAX_WAIT_MS`` after issuing it, or until
its ``final_within_ms`` ran out when that is later). Nothing here retries a
command or sends another one.

This module has no paho dependency, so the console can import it, and raise
``MonitorPublishError``, when paho-mqtt is not installed.
"""

from __future__ import annotations

import math
import re
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
# A contract 1.7 edge that names its method (LIVE, RESTART) may restart the
# SDR engine: a live window (20 s), a stop (30 s), a start of up to its
# start_timeout_seconds (180 s by default) and the settle, plus the LoRa
# radio turn. Its final ACK, also DAQ_NOT_HEALTHY_AFTER_RESTART, comes within this.
RESTART_FINAL_ACK_WAIT_MS = 270_000
_RESTART_METHODS = frozenset({"LIVE", "RESTART"})
# Contract 1.10: a progress ACK may carry result.final_within_ms, the latest the
# edge sends its final ACK after that ACK (from its own helper and start
# timeouts). The console then waits at least until the ACK's receipt plus that
# plus FINAL_WITHIN_MARGIN_MS (the LoRa radio turn), the sum capped at
# FINAL_WITHIN_MAX_WAIT_MS; without it the waits above stay.
FINAL_WITHIN_MARGIN_MS = 30_000
FINAL_WITHIN_MAX_WAIT_MS = 900_000
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
    return {"puback": None, "progress": None, "final": None, "reported_at_ms": None,
            "restart_seen": False, "final_ack_by_ms": None}


def final_ack_deadline(ack: Optional[Mapping[str, Any]]) -> Optional[int]:
    """When a progress ACK's ``final_within_ms`` runs out, as the console waits for it; None without one.

    The receipt time plus ``final_within_ms`` plus FINAL_WITHIN_MARGIN_MS, the
    two together at most FINAL_WITHIN_MAX_WAIT_MS.
    """
    if not isinstance(ack, Mapping):
        return None
    result = ack.get("result") if isinstance(ack.get("result"), Mapping) else {}
    within = result.get("final_within_ms")
    received = ack.get("received_at_ms")
    if isinstance(within, bool) or not isinstance(within, (int, float)) or type(received) is not int:
        return None
    if not math.isfinite(within) or within < 0:
        return None
    return received + int(min(math.ceil(within) + FINAL_WITHIN_MARGIN_MS, FINAL_WITHIN_MAX_WAIT_MS))


def _later(first: Optional[int], second: Optional[int]) -> Optional[int]:
    return second if first is None else first if second is None else max(first, second)


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
    # What every progress ACK the monitor saw left, also those replaced before
    # this read: a restart method and the latest final_within_ms deadline.
    progress = result["progress"]
    method = observed.get("method_seen")
    result["restart_seen"] = method in _RESTART_METHODS or (
        progress is not None and progress["result"].get("method") in _RESTART_METHODS)
    deadline = observed.get("final_ack_by_ms")
    result["final_ack_by_ms"] = _later(deadline if type(deadline) is int else None, final_ack_deadline(progress))
    return result


def _text(value: Any, limit: int = 64) -> Optional[str]:
    return value if isinstance(value, str) and 0 < len(value) <= limit else None


def _prose(value: Any, limit: int) -> Optional[str]:
    """The edge's free text (message, detail): printable characters, cut to ``limit``; None when empty."""
    if not isinstance(value, str):
        return None
    cleaned = "".join(char for char in value if char.isprintable()).strip()[:limit]
    return cleaned or None


def _names(value: Any, pattern: "re.Pattern[str]", limit: int = 16) -> Optional[List[str]]:
    """A list of field or key names; items that are not names are left out. None without a list."""
    if not isinstance(value, list):
        return None
    return [item for item in value if isinstance(item, str) and pattern.fullmatch(item)][:limit]


# ENGINE_OVERRODE names every field the engine rewrote, comma separated:
# "LIVE_FAILED:ENGINE_OVERRODE:center_frequency_hz,vfo0_frequency_hz" is 65
# characters, and three fields reach 83.
REASON_MAX_CHARS = 160
_FIELD_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_KEY_NAME_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")


def _spacing(value: Any) -> Optional[float]:
    """A UCA radius in metres (0 < value <= 100), or None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or not 0 < value <= 100:
        return None
    return float(value)


def public_ack(ack: Optional[Mapping[str, Any]]) -> Optional[Dict[str, Any]]:
    """What Kontrol shows of an ACK: status, error, reason, revision, proof, method, squelch mode, the edge's text."""
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
        "reason": _text(result.get("reason"), REASON_MAX_CHARS),
        "revision": revision if type(revision) is int else ack.get("rev"),
        # config.patch: field -> FRESH_* evidence; config.get: "runtime", "persisted_unverified", ...
        "proof": (
            {str(key): value for key, value in proof.items() if isinstance(key, str) and _text(value)}
            if isinstance(proof, Mapping) else _text(proof)
        ),
        "persisted": persisted if isinstance(persisted, bool) else None,
        # Contract 1.7: LIVE (retuned in place), RESTART (engine restarted) or FILE
        # (only settings.json, the engine was not running), and why a live retune fell back.
        "method": _text(result.get("method"), 16),
        "live_failure": _text(result.get("live_failure"), REASON_MAX_CHARS),
        # Contract 1.8: the UCA radius the engine's band rule set with this patch, or the one
        # it requires (FAILED SPACING_SET_BY_ENGINE_BAND); null when the edge named none.
        "band_spacing_m": _spacing(result.get("band_spacing_m")),
        # Contract 1.9: "Manual" when a squelch level sent while the squelch was automatic
        # switched it to Manual; null otherwise.
        "squelch_mode": _text(result.get("squelch_mode"), 32),
        # The edge's operator sentence for its error and the technical cause
        # (exception and text, cut to 200 by the edge); null when it sent none.
        "message": _prose(result.get("message"), 256),
        "detail": _prose(result.get("detail"), 256),
        # The fields the engine rewrote at start (ENGINE_OVERRODE_AT_START) and
        # the request keys the edge ignored (REJECTED); null without a list.
        "fields": _names(result.get("fields"), _FIELD_NAME_RE),
        "ignored": _names(result.get("ignored"), _KEY_NAME_RE),
        # Contract 1.10, progress ACKs: at most this many ms until the final ACK.
        "final_within_ms": _within_ms(result.get("final_within_ms")),
        "t": ack.get("t"),
        "received_at_ms": ack.get("received_at_ms"),
    }


def _within_ms(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    return int(math.ceil(value))


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
                if not entry["publish_failed"] and self._still_answerable_locked(entry, current_monitor, now)
            ]
        if not pending:
            return 0
        try:
            taken = adopt(pending)
        except Exception:
            return 0
        return taken if type(taken) is int else 0

    def _still_answerable_locked(self, entry: Dict[str, Any], current_monitor: Any, now: int) -> bool:
        """Not final yet, or ended by a timeout recently enough that a late answer may still come."""
        status = self._status_locked(entry, current_monitor, now)
        return not status["final"] or status["late_answer_possible"]

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
            # Once seen, these stay: a later ACK (or a resent ACCEPTED) never shortens the wait.
            observed["restart_seen"] = observed["restart_seen"] or fresh["restart_seen"]
            observed["final_ack_by_ms"] = _later(observed["final_ack_by_ms"], fresh["final_ack_by_ms"])
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
            return "no_final_ack" if now > self._final_ack_deadline_locked(entry) else "acknowledged"
        if now > entry["expires_ms"] + NO_ACK_GRACE_MS:
            return "no_ack"
        return "delivered" if puback is not None else "published"

    @staticmethod
    def _late_answer_until_locked(entry: Dict[str, Any]) -> int:
        """Until when an answer to a timed-out command may still come (tracker clock).

        FINAL_WITHIN_MAX_WAIT_MS after issuing it, or later while a contract
        1.10 ``final_within_ms`` has not run out; no edge answers after that.
        """
        return max(entry["issued_ms"] + FINAL_WITHIN_MAX_WAIT_MS, entry["observed"]["final_ack_by_ms"] or 0)

    @staticmethod
    def _final_ack_deadline_locked(entry: Dict[str, Any]) -> int:
        """Until when a command with a progress ACK waits for its final ACK (tracker clock)."""
        observed = entry["observed"]
        wait = RESTART_FINAL_ACK_WAIT_MS if observed["restart_seen"] else FINAL_ACK_WAIT_MS
        return _later(entry["issued_ms"] + wait, observed["final_ack_by_ms"])  # type: ignore[return-value]

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
            # While a progress ACK waits for the final one: until when (tracker clock), else null.
            "final_ack_deadline_ms": (
                self._final_ack_deadline_locked(entry)
                if observed["progress"] is not None and observed["final"] is None else None
            ),
            # A timeout (no_ack, no_final_ack, no_report) that a late answer may still replace:
            # keep polling, slowly. False once no edge answer can come any more.
            "late_answer_possible": state in _TIMEOUT_STATES and now <= self._late_answer_until_locked(entry),
        }


__all__ = [
    "COMMAND_STATES",
    "ConfigCommandTracker",
    "FINAL_ACK_STATUSES",
    "FINAL_ACK_WAIT_MS",
    "FINAL_STATES",
    "FINAL_WITHIN_MARGIN_MS",
    "FINAL_WITHIN_MAX_WAIT_MS",
    "MonitorPublishError",
    "NO_ACK_GRACE_MS",
    "PROGRESS_ACK_STATUSES",
    "RESTART_FINAL_ACK_WAIT_MS",
    "SETTINGS_REPORT_WAIT_MS",
    "final_ack_deadline",
    "public_ack",
]
