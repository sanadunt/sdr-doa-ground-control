"""Bounded, read-only validator and store for the RDF Node MQTT contract.

The contract is ``docs/MQTT_KONTRAK.md``: the topics, field types, freshness
windows and LIVE/UNVERIFIED rules of the RDF Node edge at commit 8691ad0, as
its own Ground (``rdf_node/ground.py`` and ``codec.py``) applies them. Every
edge to ground topic under ``sdr/v2/<node>/`` is validated. Each topic keeps the
status of its latest message; only accepted values reach the node view, which
holds the session from ``state``, fresh health, LIVE DoA and Angular apart from
their UNVERIFIED and diagnostic paths, capabilities, the last ACKs and a
requested ``settings/reported``.

The store never publishes. ``expect_settings_report`` only registers the id of
a ``config.get`` the console sent, so that the answer to it is accepted.

Reading is lenient where the data stays meaningful: unknown fields are
ignored, an optional (nullable) field that is missing reads as null, 0/1 reads
as a boolean, an integral float or digit string as an integer, and a time in
seconds as milliseconds. Each such repair is a note (``CODE:field``) on the
topic entry and in the accepted payload, so the operator sees it. Only data
that cannot be read (not JSON, not an object, empty or malformed sid, another
protocol version, oversize, a core field missing) is INVALID. A message outside
its freshness window, without fresh health or with another revision is kept
and labelled; LIVE keeps its edge rules. Over the LoRa serial bridge
(``set_link``) an Angular frame counts for 45 s and the detail for 65 s, since
the bridge sends them at most every 20 s and 30 s.
"""
from __future__ import annotations

import contextvars
import copy
import json
import math
import re
from collections import OrderedDict
from typing import Any, Callable, Dict, List, Optional, Tuple

RDF_NODE_V2_SUFFIXES: Tuple[str, ...] = (
    "state",
    "capabilities",
    "availability",
    "telemetry/health",
    "telemetry/health/detail",
    "telemetry/doa",
    "telemetry/diagnostic/doa",
    "telemetry/angular",
    "telemetry/diagnostic/angular",
    "settings/reported",
    "ack/config",
    "ack/operation",
)
RETAINED_SUFFIXES = frozenset({"state", "capabilities", "availability"})
# Telemetry and settings belong to one agent session; a new sid drops them.
SESSION_SUFFIXES = frozenset({
    "telemetry/health", "telemetry/health/detail", "telemetry/doa", "telemetry/diagnostic/doa",
    "telemetry/angular", "telemetry/diagnostic/angular", "settings/reported",
})

# The edge's MQTT client refuses to publish a larger payload (Client.offer),
# and settings/reported has the same limit in the contract.
MAX_PAYLOAD_BYTES = 8192

HEALTH_FRESH_MS = 8_000
DOA_FRESH_MS = 5_000
ANGULAR_FRESH_MS = 10_000
FUTURE_TOLERANCE_MS = 1_000
DETAIL_FRESH_MS = 15_000
UNVERIFIED_DOA_FRESH_MS = 5_000
DIAGNOSTIC_DOA_FRESH_MS = 5_000
SETTINGS_FRESH_MS = 30_000
ACK_FRESH_MS = 30_000
# Over the LoRa serial bridge (``link`` "lora") the bridge sends an Angular frame
# at most every 20 s, keeps a queued one up to 8 s and loses a fragment now and
# then, and sends the detail at most every 30 s: these windows replace
# ANGULAR_FRESH_MS and DETAIL_FRESH_MS there, so a frame or detail between two
# reports still counts. The pairing guards in telemetry_source.py stay.
ANGULAR_LORA_FRESH_MS = 45_000
DETAIL_LORA_FRESH_MS = 65_000
LINK_LORA = "lora"
# A config.get lives at most 30 s and its answer expires 30 s after it is sent.
SETTINGS_REQUEST_TTL_MS = 60_000
# KrakenSDR's settings.json is one flat object; deeper nesting is refused so
# that no copy of the parsed object can run into the recursion limit.
SETTINGS_JSON_MAX_DEPTH = 16
MAX_SETTINGS_REQUESTS = 4
MAX_ACKS = 32
MAX_SESSIONS = 256

FLAG_PARSED = 1
FLAG_FRESH = 2
FLAG_DAQ = 4
FLAG_CONVENTION = 8
FLAG_CONFIG = 16
FLAG_AUTHORITY = 32
FLAGS_INTEGRITY = FLAG_PARSED | FLAG_FRESH | FLAG_DAQ | FLAG_CONFIG
FLAGS_ALL = 63

ACK_PROGRESS_STATUSES = frozenset({
    "ACCEPTED", "APPLYING", "VERIFYING", "REBOOT_SCHEDULED", "SHUTDOWN_SCHEDULED", "PPP_RESTART_REQUESTED",
})
ACK_FINAL_STATUSES = frozenset({
    "APPLIED", "FAILED", "REJECTED", "EXPIRED", "CONFLICT", "PERSISTED_UNVERIFIED", "OUTCOME_UNKNOWN", "CANCELLED",
})
ACK_STATUSES = ACK_PROGRESS_STATUSES | ACK_FINAL_STATUSES

STATE_RUN = frozenset({"RUNNING", "STOPPED", "STARTING", "STOPPING", "ERROR", "UNKNOWN"})
HEALTH_RUN = frozenset({0, 1, 2, 3, 4, 255})
UNVERIFIED_DOA_REASONS = frozenset({"SOURCE_UNVERIFIED", "ANGLE_UNVERIFIED"})
CAPABILITY_FLAGS = (
    "helper_available", "remote_commands", "remote_config_patch", "remote_processing", "remote_restart",
    "remote_reboot", "remote_shutdown", "remote_ppp_restart", "config_patch", "processing", "restart",
    "reboot", "shutdown", "ppp_restart",
)
SETTINGS_REPORT_FIELDS = frozenset({"v", "sid", "boot", "id", "rev", "t", "settings_json"})
# A sequence number this far below the last accepted one means the edge counted
# from the start again within the same session; it is accepted with a note.
SEQUENCE_RESET_GAP = 1000
# Notes longer lists are cut to this many.
MAX_NOTES = 16

# Top-level ACK result keys the edge writes (control.py, helper.py, journal.py).
# A one-time ``challenge`` is never kept.
ACK_RESULT_KEYS = frozenset({
    "revision", "proof", "persisted", "reason", "error", "profile", "scope", "desired", "accepted",
    "accepted_by_systemd", "requested_ms", "service", "valid_seconds", "prepare_id", "scheduled",
    "delay_seconds", "action", "requested", "operation", "elapsed_ms", "phase", "steps", "boot",
    "previous_boot", "boot_before", "changes", "cleared", "late",
    # Contract 1.7: how a config.patch was applied (LIVE, RESTART, FILE) and why a live retune fell back.
    "method", "live_failure",
    # Contract 1.8: the UCA radius the engine's band rule set (or required, with SPACING_SET_BY_ENGINE_BAND).
    "band_spacing_m",
    # Contract 1.9: a squelch level sent while the squelch was automatic switched it to Manual.
    "squelch_mode",
    # The edge's operator text and technical cause of an error (control.error_result), the request keys
    # it ignored (reject) and the fields the engine overrode at start (ENGINE_OVERRODE_AT_START).
    "message", "detail", "ignored", "fields",
    # Contract 1.10: at most how many ms after this progress ACK the final ACK follows.
    "final_within_ms",
})
_SECRET_KEY_WORDS = ("challenge", "secret", "password", "passwd", "token", "credential", "private")

# The edge's own safe settings (source.FIELD_MAP and safe_settings()).
SAFE_SETTINGS_MAP = {
    "center_frequency_hz": ("center_freq", 1e6),
    "gain_db": ("uniform_gain", 1),
    "vfo0_frequency_hz": ("vfo_freq_0", 1),
    "vfo0_bandwidth_hz": ("vfo_bw_0", 1),
    "vfo0_squelch_db": ("vfo_squelch_0", 1),
    # Contract 1.8: the UCA radius in metres.
    "ant_spacing_m": ("ant_spacing_meters", 1),
}
# Contract 1.9: the edge's text fields (source.STRING_FIELDS), kept only with one of its values.
SAFE_SETTINGS_TEXT = {"vfo0_squelch_mode": ("vfo_squelch_mode_0", ("Manual", "Auto", "Auto Channel", "Default"))}
SAFE_SETTINGS_SCALARS = (
    "ant_arrangement", "doa_method", "active_vfos", "output_vfo", "en_doa", "vfo_default_squelch_mode",
)

_NODE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_SID_RE = re.compile(r"^[0-9a-f]{8}$")
_IDENTITY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$")
COMMAND_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
_WORD_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,63}$")
# A short word or phrase, such as the squelch mode "Auto Channel" (state.rf.sqm).
_PHRASE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.:+-]{0,31}$")
_CODE_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_REASON_RE = re.compile(r"^[A-Z0-9_:-]{1,64}$")
_FIELD_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
_KEY_RE = re.compile(r"^[A-Za-z0-9_]{1,64}$")
_EPOCH_MS_MIN = 1_000_000_000_000
_EPOCH_MS_MAX = 9_999_999_999_999
_U32 = 0xFFFFFFFF
_COUNT_MAX = 2**53 - 1


class _Invalid(ValueError):
    """A payload that breaks the contract; ``code`` is the reported error."""

    def __init__(self, code: str, field: Optional[str] = None) -> None:
        super().__init__(code)
        self.code = code
        self.field = field


def _strict_json(raw: bytes) -> Any:
    """JSON as the edge's strict_json reads it: no duplicate keys, no NaN or Infinity."""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise _Invalid("MALFORMED_JSON") from None

    def pairs(items: List[Tuple[str, Any]]) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise _Invalid("DUPLICATE_KEY")
            result[key] = value
        return result

    def constant(_name: str) -> Any:
        raise _Invalid("NONFINITE_JSON")

    def number(literal: str) -> float:
        value = float(literal)
        if not math.isfinite(value):
            raise _Invalid("NONFINITE_JSON")
        return value

    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=constant, parse_float=number)
    except _Invalid:
        raise
    except (ValueError, RecursionError):
        raise _Invalid("MALFORMED_JSON") from None


def _object(raw: bytes) -> Dict[str, Any]:
    value = _strict_json(raw)
    if not isinstance(value, dict):
        raise _Invalid("INVALID_ENVELOPE")
    return value


_NOTES: "contextvars.ContextVar[Optional[List[str]]]" = contextvars.ContextVar("rdf_node_notes", default=None)
_DIGITS_RE = re.compile(r"^-?[0-9]{1,19}$")


def _note(code: str, key: Optional[str] = None) -> None:
    """Record a repair the reader made, as ``CODE`` or ``CODE:field``."""
    notes = _NOTES.get()
    if notes is None:
        return
    text = code if key is None else f"{code}:{key}"
    if text not in notes and len(notes) < MAX_NOTES:
        notes.append(text)


def _present(data: Dict[str, Any], key: str, *, nullable: bool = False) -> Any:
    """The value of ``key``; a missing nullable field reads as null with a note."""
    if key not in data:
        if nullable:
            _note("MISSING_FIELD", key)
            return None
        raise _Invalid("MISSING_FIELD", key)
    return data[key]


def _as_int(value: Any, key: str) -> Any:
    """An integral float or a digit string as an int (noted); anything else unchanged."""
    if type(value) is float and math.isfinite(value) and value.is_integer():
        _note("COERCED", key)
        return int(value)
    if isinstance(value, str) and _DIGITS_RE.fullmatch(value):
        _note("COERCED", key)
        return int(value)
    return value


def _int(data: Dict[str, Any], key: str, low: int, high: int, *, nullable: bool = False) -> Optional[int]:
    value = _present(data, key, nullable=nullable)
    if value is None and nullable:
        return None
    value = _as_int(value, key)
    if type(value) is not int or not low <= value <= high:
        raise _Invalid("INVALID_FIELD", key)
    return value


def _number(data: Dict[str, Any], key: str, low: float, high: float, *, nullable: bool = False) -> Any:
    value = _present(data, key, nullable=nullable)
    if value is None and nullable:
        return None
    if isinstance(value, str):
        try:
            number = float(value)
        except ValueError:
            raise _Invalid("INVALID_FIELD", key) from None
        if math.isfinite(number):
            _note("COERCED", key)
            value = number
    if not _finite_in(value, low, high):
        raise _Invalid("INVALID_FIELD", key)
    return value


def _finite_in(value: Any, low: float, high: float) -> bool:
    """A JSON number (never a boolean) that is finite and within ``low..high``."""
    if type(value) is int:
        return low <= value <= high
    return type(value) is float and math.isfinite(value) and low <= value <= high


_BOOL_TEXT = {"0": False, "1": True, "false": False, "true": True}


def _as_bool(value: Any, key: str) -> Any:
    """0/1 (number or text) and "true"/"false" as a boolean (noted); anything else unchanged."""
    if type(value) in (int, float) and value in (0, 1):
        _note("COERCED", key)
        return bool(value)
    if isinstance(value, str) and value.strip().lower() in _BOOL_TEXT:
        _note("COERCED", key)
        return _BOOL_TEXT[value.strip().lower()]
    return value


def _bool(data: Dict[str, Any], key: str, *, nullable: bool = False) -> Optional[bool]:
    value = _present(data, key, nullable=nullable)
    if value is None and nullable:
        return None
    value = _as_bool(value, key)
    if type(value) is not bool:
        raise _Invalid("INVALID_FIELD", key)
    return value


def _text(data: Dict[str, Any], key: str, pattern: "re.Pattern[str]", *, nullable: bool = False) -> Optional[str]:
    value = _present(data, key, nullable=nullable)
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise _Invalid("INVALID_FIELD", key)
    return value


def _choice(data: Dict[str, Any], key: str, choices: frozenset) -> Any:
    value = _present(data, key)
    if any(type(item) is int for item in choices):
        if type(value) is bool:
            _note("COERCED", key)
            value = int(value)
        else:
            value = _as_int(value, key)
    if type(value) not in (int, str) or value not in choices:
        raise _Invalid("INVALID_FIELD", key)
    return value


def _epoch(data: Dict[str, Any], key: str) -> int:
    """Epoch milliseconds; whole or fractional seconds and float milliseconds are converted (noted)."""
    value = _present(data, key)
    if isinstance(value, str):
        try:
            value = float(value)
        except ValueError:
            raise _Invalid("INVALID_FIELD", key) from None
        _note("COERCED", key)
    if type(value) in (int, float) and math.isfinite(value):
        if _EPOCH_MS_MIN // 1000 <= value <= _EPOCH_MS_MAX // 1000:
            _note("TIME_SECONDS", key)
            value = int(round(value * 1000))
        elif type(value) is float:
            _note("COERCED", key)
            value = int(round(value))
    if type(value) is not int or not _EPOCH_MS_MIN <= value <= _EPOCH_MS_MAX:
        raise _Invalid("INVALID_FIELD", key)
    return value


def _words(data: Dict[str, Any], key: str, limit: int) -> List[str]:
    """A list of words; a missing list is empty and items that are not words are dropped (noted)."""
    value = _present(data, key, nullable=True)
    if value is None:
        return []
    if not isinstance(value, list):
        raise _Invalid("INVALID_FIELD", key)
    words = [item for item in value if isinstance(item, str) and _WORD_RE.fullmatch(item)]
    if len(words) != len(value) or len(words) > limit:
        _note("DROPPED_ITEMS", key)
    return words[:limit]


def _free_text(value: Any, key: str, limit: int = 64) -> Optional[str]:
    """Printable text cut to ``limit`` characters (noted when changed), or None."""
    if value is None:
        return None
    if not isinstance(value, str):
        _note("COERCED", key)
        value = str(value)
    cleaned = "".join(char for char in value if char.isprintable())[:limit]
    if cleaned != value:
        _note("TRIMMED", key)
    return cleaned


def _envelope(data: Dict[str, Any]) -> Dict[str, Any]:
    if type(data.get("v")) is not int or data["v"] != 2:
        raise _Invalid("INVALID_VERSION", "v")
    sid = data.get("sid")
    if not isinstance(sid, str) or not _SID_RE.fullmatch(sid):
        raise _Invalid("INVALID_SESSION_ID", "sid")
    return {"v": 2, "sid": sid}


def _validate_state(data: Dict[str, Any]) -> Dict[str, Any]:
    value = _envelope(data)
    value.update(
        boot=_text(data, "boot", _IDENTITY_RE),
        instance=_text(data, "instance", _IDENTITY_RE),
        t=_epoch(data, "t"),
        run=_choice(data, "run", STATE_RUN),
        daq=_bool(data, "daq"),
        cfg=_int(data, "cfg", 0, _U32, nullable=True),
        profile=_text(data, "profile", _WORD_RE),
        clock=_text(data, "clock", _WORD_RE),
    )
    rf = _state_rf(data)
    if rf:
        value["rf"] = rf
    return value


def _state_rf(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The optional ``rf`` of contract 1.7: the SDR settings of revision ``cfg`` (settings.json, not runtime proof).

    Each field is read on its own; a bad one is dropped with an ``rf.<key>``
    note and never refuses the state, which anchors the session.
    """
    if "rf" not in data:
        return None
    rf = data["rf"]
    if not isinstance(rf, dict):
        _note("INVALID_FIELD", "rf")
        return None
    # Read under rf.<key>, so a COERCED note names the field where it is.
    named = {f"rf.{key}": item for key, item in rf.items()}
    readers = (
        ("f", lambda: _int(named, "rf.f", 1, _U32)),
        ("vfo", lambda: _int(named, "rf.vfo", 1, _U32)),
        ("g", lambda: _number(named, "rf.g", -100, 100)),
        ("bw", lambda: _int(named, "rf.bw", 1, _U32)),
        ("sq", lambda: _number(named, "rf.sq", -1000, 1000)),
        # Contract 1.8: the UCA radius (ant_spacing_meters) in metres.
        ("uca", lambda: _number(named, "rf.uca", 0, 100)),
        # Contract 1.9: the VFO0 squelch mode (Manual, Auto, Auto Channel, Default); the edge leaves
        # rf.sq out while it is automatic. Read as a short phrase, so a future mode is shown, not dropped.
        ("sqm", lambda: _text(named, "rf.sqm", _PHRASE_RE)),
    )
    value: Dict[str, Any] = {}
    for key, read in readers:
        if key not in rf:
            continue
        try:
            value[key] = read()
        except _Invalid:
            _note("INVALID_FIELD", f"rf.{key}")
    return value or None


def _validate_capabilities(data: Dict[str, Any]) -> Dict[str, Any]:
    value = _envelope(data)
    value.update(boot=_text(data, "boot", _IDENTITY_RE), instance=_text(data, "instance", _IDENTITY_RE))
    if "t" in data:
        value["t"] = _epoch(data, "t")
    value.update(
        version=_text(data, "version", _WORD_RE, nullable=True),
        mode=_text(data, "mode", _WORD_RE, nullable=True),
        codecs=_words(data, "codecs", 16),
        # A missing angle convention is "unknown" downstream (no θ₀), not a reject.
        angle=_text(data, "angle", _WORD_RE, nullable=True),
        native_axis=_int(data, "native_axis", -128, 127, nullable=True),
        count=_int(data, "count", 1, 4096, nullable=True),
        profiles=_words(data, "profiles", 16),
        scope=_text(data, "scope", _WORD_RE, nullable=True),
    )
    for flag in CAPABILITY_FLAGS:
        # A flag the edge did not send grants nothing: it reads as false.
        if flag in data:
            value[flag] = _bool(data, flag)
        else:
            _note("DEFAULTED", flag)
            value[flag] = False
    # Contract 1.8: the fields config.patch takes. Without the list (an older edge) it stays
    # out, and Ground sends only the five fields before ant_spacing_m; a bad list is noted.
    if "config_fields" in data:
        try:
            value["config_fields"] = _words(data, "config_fields", 16)
        except _Invalid:
            _note("INVALID_FIELD", "config_fields")
    # Edges before 1.0.0-20261013 published it; it is no longer required.
    if "maintenance" in data:
        value["maintenance"] = _bool(data, "maintenance")
    nav = _capabilities_nav(data)
    if nav is not None:
        value["nav"] = nav
    return value


def _capabilities_nav(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Contract 1.10: the sensors behind the nav fields, or None from an older edge.

    ``compass`` and ``gps`` say which sensors the edge reads, ``position``
    whether it sends ``lat``/``lon`` (``nav.gps.publish_position``) and
    ``heading`` its heading source setting (null with nav off). Each key is read
    on its own; a bad one reads as null (noted), never refusing the capabilities.
    """
    if "nav" not in data:
        return None
    nav = data["nav"]
    if not isinstance(nav, dict):
        _note("INVALID_FIELD", "nav")
        return None
    named = {f"nav.{key}": item for key, item in nav.items()}
    value: Dict[str, Any] = {}
    for key in ("compass", "gps", "position"):
        present, item = _optional(named, f"nav.{key}", lambda key=key: _bool(named, f"nav.{key}", nullable=True))
        value[key] = item if present else None
    present, item = _optional(named, "nav.heading", lambda: _text(named, "nav.heading", _WORD_RE, nullable=True))
    value["heading"] = item if present else None
    return value


def _validate_availability(data: Dict[str, Any]) -> Dict[str, Any]:
    value = _envelope(data)
    value["online"] = _bool(data, "online")
    # The Last Will carries no time; an online message always does.
    if value["online"] or "t" in data:
        value["t"] = _epoch(data, "t")
    if "reason" in data:
        value["reason"] = _free_text(data["reason"], "reason")
    return value


def _validate_health(data: Dict[str, Any]) -> Dict[str, Any]:
    value = _envelope(data)
    value.update(
        q=_int(data, "q", 1, _U32),
        t=_epoch(data, "t"),
        run=_choice(data, "run", HEALTH_RUN),
        daq=_choice(data, "daq", frozenset({0, 1, 2})),
        drop=_int(data, "drop", 0, _COUNT_MAX, nullable=True),
        age=_int(data, "age", 0, _COUNT_MAX, nullable=True),
        temp=_number(data, "temp", -100, 200, nullable=True),
        clk=_choice(data, "clk", frozenset({0, 1})),
        rev=_int(data, "rev", 0, _U32, nullable=True),
    )
    # Contract 1.10: why DoA is not LIVE at the edge (empty while it is), the
    # one channel for it while the edge sends no DoA. Older edges send none.
    present, why = _optional_reasons(data, "why")
    if present:
        value["why"] = why
    value.update(_health_nav(data))
    return value


_NAV_STATE_RE = re.compile(r"[A-Z_]{1,16}")


def _optional(data: Dict[str, Any], key: str, read: Any) -> Tuple[bool, Any]:
    """An optional field: (present, value). A bad value reads as absent, noted, never refusing the message."""
    if key not in data:
        return False, None
    try:
        return True, read()
    except _Invalid:
        _note("INVALID_FIELD", key)
        return False, None


def _optional_reasons(data: Dict[str, Any], key: str) -> Tuple[bool, List[str]]:
    """An optional list of reason codes: (present, codes). Null reads as absent; not a list as absent with a note."""
    value = data.get(key)
    if value is None:
        return False, []
    if not isinstance(value, list):
        _note("INVALID_FIELD", key)
        return False, []
    return True, _reasons(value, key, 32)


def _health_nav(data: Dict[str, Any]) -> Dict[str, Any]:
    """The optional nav fields of contract 1.6 (compass and GPS): only those present, each read on its own."""
    readers = (
        ("hdg", lambda: _number(data, "hdg", 0, 360, nullable=True)),
        ("hs", lambda: _text(data, "hs", _NAV_STATE_RE)),
        ("gs", lambda: _text(data, "gs", _NAV_STATE_RE)),
        ("fix", lambda: _choice(data, "fix", frozenset({0, 2, 3}))),
        ("sat", lambda: _int(data, "sat", 0, 255, nullable=True)),
        ("lat", lambda: _number(data, "lat", -90, 90)),
        ("lon", lambda: _number(data, "lon", -180, 180)),
        ("alt", lambda: _number(data, "alt", -1000, 100000, nullable=True)),
        ("sog", lambda: _number(data, "sog", 0, 1000, nullable=True)),
        ("cog", lambda: _number(data, "cog", 0, 360, nullable=True)),
    )
    nav: Dict[str, Any] = {}
    for key, read in readers:
        present, value = _optional(data, key, read)
        if present:
            nav[key] = value
    if ("lat" in nav) != ("lon" in nav):
        # A position needs both; one alone is dropped with its partner's note.
        _note("INVALID_FIELD", "lon" if "lat" in nav else "lat")
        nav.pop("lat", None)
        nav.pop("lon", None)
    return nav


def _validate_detail(data: Dict[str, Any]) -> Dict[str, Any]:
    value = _envelope(data)
    value.update(t=_epoch(data, "t"), usb=_int(data, "usb", 0, 1000, nullable=True))
    sync = _present(data, "sync", nullable=True)
    if sync is None:
        sync = [None, None, None]
    if not isinstance(sync, list) or len(sync) != 3:
        raise _Invalid("INVALID_FIELD", "sync")
    sync = [None if item is None else _as_bool(item, "sync") for item in sync]
    if any(item is not None and type(item) is not bool for item in sync):
        raise _Invalid("INVALID_FIELD", "sync")
    value["sync"] = sync
    # The edge computes cpu from /proc/stat idle+iowait without a clamp
    # (monitor.probe), and iowait may step back, so a busy Pi can report a
    # little over 100. Any finite value >= 0 is the edge's; mem and disk_free
    # come from ratios that stay inside 0..100.
    value["cpu"] = _number(data, "cpu", 0, math.inf, nullable=True)
    for key in ("mem", "disk_free"):
        value[key] = _number(data, key, 0, 100, nullable=True)
    for key in ("throt", "uv"):
        value[key] = _bool(data, key, nullable=True)
    for key in ("tx", "rx"):
        value[key] = _number(data, key, 0, 1e9, nullable=True)
    for key in ("adrop", "parse"):
        value[key] = _int(data, key, 0, _COUNT_MAX, nullable=True)
    # PPP link fields of newer edges (after 8691ad0); absent from older ones.
    for key in ("ppp", "peer", "ppp_svc"):
        if key in data:
            value[key] = _free_text(data[key], key)
    if "ppp_restarts" in data:
        value["ppp_restarts"] = _int(data, "ppp_restarts", 0, _COUNT_MAX, nullable=True)
    # Contract 1.7: the KrakenSDR ADC overdrive (null when the edge does not know it).
    present, ovr = _optional(data, "ovr", lambda: _bool(data, "ovr", nullable=True))
    if present:
        value["ovr"] = ovr
    return value


def _validate_doa(data: Dict[str, Any]) -> Dict[str, Any]:
    value = _envelope(data)
    value.update(
        q=_int(data, "q", 1, _U32),
        t=_epoch(data, "t"),
        f=_int(data, "f", 1, _U32),
        a=_number(data, "a", 0, 360),
        c=_number(data, "c", -327.67, 327.67),
        p=_number(data, "p", -1e6, 1e6),
        rev=_int(data, "rev", 0, _U32, nullable=True),
        ok=_choice(data, "ok", frozenset({0, 1})),
    )
    # Contract 1.10: the edge's reasons for this sample (empty on ok=1).
    has_reason, reason = _optional_reasons(data, "reason")
    if has_reason:
        value["reason"] = reason
    if value["ok"] == 0:
        # ok=0 is UNVERIFIED and RAW whatever the labels say; other labels or
        # reason codes are kept as notes, not refused.
        if data.get("trust") != "UNVERIFIED":
            _note("UNEXPECTED_VALUE", "trust")
        if data.get("angle_reference") != "RAW":
            _note("UNEXPECTED_VALUE", "angle_reference")
        # Edge 1.10 sends validation_reasons only when every reason is
        # SOURCE_UNVERIFIED or ANGLE_UNVERIFIED and every other list once, in
        # reason; an edge before 1.10 sends only validation_reasons.
        if "validation_reasons" in data or not has_reason:
            reasons = _reasons(data.get("validation_reasons"), "validation_reasons", 32)
        else:
            reasons = list(reason)
        value.update(trust="UNVERIFIED", angle_reference="RAW", validation_reasons=reasons)
    value.update(_doa_nav(data))
    return value


def _doa_nav(data: Dict[str, Any]) -> Dict[str, Any]:
    """Contract 1.10: the array heading, bearing and position stamped on a DoA sample, only those present.

    ``h`` is where the array reference pointed (null without a heading source),
    ``hsrc`` where that came from (C compass, G GPS course, H held course),
    ``b`` the bearing to the transmitter from north and ``lat``/``lon`` where
    the sample was taken. A bad one is dropped (noted); the sample stays.
    """
    readers = (
        ("h", lambda: _number(data, "h", 0, 360, nullable=True)),
        ("hsrc", lambda: None if data.get("hsrc") is None else _choice(data, "hsrc", frozenset({"C", "G", "H"}))),
        ("b", lambda: _number(data, "b", 0, 360)),
        ("lat", lambda: _number(data, "lat", -90, 90)),
        ("lon", lambda: _number(data, "lon", -180, 180)),
    )
    nav: Dict[str, Any] = {}
    for key, read in readers:
        present, value = _optional(data, key, read)
        if present:
            nav[key] = value
    if ("lat" in nav) != ("lon" in nav):
        _note("INVALID_FIELD", "lat" if "lat" not in nav else "lon")
        nav.pop("lat", None)
        nav.pop("lon", None)
    if "b" in nav and nav.get("h") is None:
        # A bearing needs the heading it was made with.
        _note("INVALID_FIELD", "b")
        nav.pop("b")
    return nav


def _reasons(value: Any, key: str, limit: int) -> List[str]:
    """Reason codes as a list; codes that are not codes are dropped (noted)."""
    if not isinstance(value, list):
        _note("MISSING_FIELD" if value is None else "INVALID_FIELD", key)
        return []
    kept: List[str] = []
    for item in value:
        if isinstance(item, str) and _REASON_RE.fullmatch(item) and item not in kept:
            kept.append(item)
    if len(kept) != len(value) or len(kept) > limit:
        _note("DROPPED_ITEMS", key)
    return kept[:limit]


def _validate_diagnostic_doa(data: Dict[str, Any]) -> Dict[str, Any]:
    value = _envelope(data)
    value["q"] = _int(data, "q", 1, _U32)
    if data.get("source") != "doa.xml":
        _note("UNEXPECTED_VALUE", "source")
    value.update(
        source=_free_text(data.get("source"), "source") or "doa.xml",
        source_timestamp_ms=_epoch(data, "source_timestamp_ms"),
        observed_timestamp_ms=_epoch(data, "observed_timestamp_ms"),
        raw_doa_deg=_number(data, "raw_doa_deg", 0, 360),
        frequency_mhz=_number(data, "frequency_mhz", 0.001, 5000),
    )
    if data.get("trust") != "UNVERIFIED":
        _note("UNEXPECTED_VALUE", "trust")
    value.update(trust="UNVERIFIED", validation_reasons=_reasons(data.get("validation_reasons"), "validation_reasons", 32))
    return value


def _validate_angular_frame(data: Dict[str, Any]) -> Dict[str, Any]:
    """One Angular JSON frame; the edge sends no other encoding (RDF2 is retired)."""
    encoding = data.get("encoding", "json")
    if "encoding" not in data:
        _note("MISSING_FIELD", "encoding")
    if encoding != "json":
        raise _Invalid("ENCODING_UNSUPPORTED", "encoding")
    value = _envelope(data)
    value.update(
        encoding="json",
        q=_int(data, "q", 1, _U32),
        timestamp_ms=_epoch(data, "timestamp_ms"),
        frequency_hz=_int(data, "frequency_hz", 1, _U32),
        revision=_int(data, "revision", 0, _U32 - 1, nullable=True),
        vfo=_int(data, "vfo", 0, 15),
        convention=_choice(data, "convention", frozenset({0, 1})),
        flags=_int(data, "flags", 0, FLAGS_ALL),
        raw_doa_deg=_number(data, "raw_doa_deg", 0, 360, nullable=True),
        confidence_native_db=_number(data, "confidence_native_db", -327.67, 327.67, nullable=True),
    )
    # Edge 1.10: the heading the latest DoA sample went out with when the frame
    # was built (C, G, H as hsrc), so each bin turns into a bearing with the
    # frame's own heading. Only those present; a bad one is dropped (noted).
    for key, read in (
        ("heading_deg", lambda: _number(data, "heading_deg", 0, 360, nullable=True)),
        ("heading_source", lambda: None if data.get("heading_source") is None
         else _choice(data, "heading_source", frozenset({"C", "G", "H"}))),
    ):
        present, item = _optional(data, key, read)
        if present:
            value[key] = item
    samples = data.get("values")
    if not isinstance(samples, list) or len(samples) != 360:
        raise _Invalid("EXPECTED_360_SAMPLES", "values")
    if not all(_finite_in(sample, -1e8, 1e8) for sample in samples):
        raise _Invalid("INVALID_FIELD", "values")
    value["values"] = list(samples)
    value["peak_index"] = max(range(360), key=samples.__getitem__)
    return value


def _validate_angular(data: Dict[str, Any]) -> Dict[str, Any]:
    value = _validate_angular_frame(data)
    # Missing parse, freshness, DAQ or config evidence makes the frame
    # UNVERIFIED (the store keeps it apart from LIVE), not a reject.
    if value["flags"] & FLAGS_INTEGRITY != FLAGS_INTEGRITY:
        _note("EVIDENCE_INCOMPLETE", "flags")
    return value


def _edge_finite(value: Any, low: float, high: float) -> float:
    """``util.finite`` of the edge: numbers or numeric text, never a boolean."""
    if isinstance(value, bool):
        raise ValueError
    number = float(value)
    if not math.isfinite(number) or not low <= number <= high:
        raise ValueError
    return number


def safe_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    """The edge's ``source.safe_settings``: the form fields of a native settings object."""
    result: Dict[str, Any] = {}
    for name, (key, scale) in SAFE_SETTINGS_MAP.items():
        if key in settings:
            try:
                number = _edge_finite(settings[key], -1e6, 5e9) * scale
            except (TypeError, ValueError, OverflowError):
                # One unreadable value leaves only that field out.
                _note("DROPPED_FIELD", name)
                continue
            result[name] = int(round(number)) if name.endswith("_hz") else number
    for name, (key, choices) in SAFE_SETTINGS_TEXT.items():
        if key in settings:
            if settings[key] in choices:
                result[name] = settings[key]
            else:
                _note("DROPPED_FIELD", name)
    for key in SAFE_SETTINGS_SCALARS:
        item = settings.get(key)
        if isinstance(item, (str, int, bool)) and len(str(item)) < 64:
            result[key] = item
    return result


def _depth_within(value: Any, limit: int) -> bool:
    """True when objects and arrays nest at most ``limit`` levels (iterative, no recursion)."""
    stack: List[Tuple[Any, int]] = [(value, 1)]
    while stack:
        item, depth = stack.pop()
        if isinstance(item, dict):
            children: Any = item.values()
        elif isinstance(item, list):
            children = item
        else:
            continue
        if depth > limit:
            return False
        stack.extend((child, depth + 1) for child in children)
    return True


def _validate_settings_report(data: Dict[str, Any]) -> Dict[str, Any]:
    # Extra fields are ignored; every field of the contract must be there.
    for key in sorted(SETTINGS_REPORT_FIELDS):
        _present(data, key)
    value = _envelope(data)
    value.update(
        boot=_text(data, "boot", _IDENTITY_RE),
        id=_text(data, "id", COMMAND_ID_RE),
        rev=_int(data, "rev", 0, _U32),
        t=_epoch(data, "t"),
    )
    raw = data["settings_json"]
    if not isinstance(raw, str):
        raise _Invalid("BAD_SETTINGS_JSON", "settings_json")
    try:
        # A lone surrogate escape (\ud800) is valid JSON but no UTF-8 text.
        parsed = _strict_json(raw.encode("utf-8"))
    except (_Invalid, UnicodeEncodeError):
        raise _Invalid("BAD_SETTINGS_JSON", "settings_json") from None
    if not isinstance(parsed, dict) or not _depth_within(parsed, SETTINGS_JSON_MAX_DEPTH):
        raise _Invalid("BAD_SETTINGS_JSON", "settings_json")
    value["safe_settings"] = safe_settings(parsed)
    value["settings_json"] = raw
    value["settings"] = parsed
    return value


def _secret_key(key: str) -> bool:
    lowered = key.lower()
    return lowered == "pin" or any(word in lowered for word in _SECRET_KEY_WORDS)


def _bounded(value: Any, depth: int = 0) -> Any:
    """A bounded copy of an ACK result value without credential-like keys."""
    if depth > 4:
        return None
    if value is None or type(value) in (bool, int, float):
        return value
    if isinstance(value, str):
        return value[:256]
    if isinstance(value, list):
        return [_bounded(item, depth + 1) for item in value[:32]]
    if isinstance(value, dict):
        return {key: _bounded(item, depth + 1) for key, item in list(value.items())[:32]
                if isinstance(key, str) and _KEY_RE.fullmatch(key) and not _secret_key(key)}
    return None


def _validate_ack(data: Dict[str, Any]) -> Dict[str, Any]:
    value = _envelope(data)
    value["id"] = _text(data, "id", COMMAND_ID_RE)
    status = _present(data, "status")
    if not isinstance(status, str) or not _CODE_RE.fullmatch(status):
        raise _Invalid("INVALID_FIELD", "status")
    if status not in ACK_STATUSES:
        # A status this console does not know is kept as progress, never as a result.
        _note("UNKNOWN_STATUS", "status")
    value.update(status=status, t=_epoch(data, "t"), rev=_int(data, "rev", 0, _U32, nullable=True))
    result = _present(data, "result")
    if not isinstance(result, dict):
        raise _Invalid("INVALID_FIELD", "result")
    value["result"] = {key: _bounded(item, 1) for key, item in result.items() if key in ACK_RESULT_KEYS}
    return value


_VALIDATORS: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]] = {
    "state": _validate_state,
    "capabilities": _validate_capabilities,
    "availability": _validate_availability,
    "telemetry/health": _validate_health,
    "telemetry/health/detail": _validate_detail,
    "telemetry/doa": _validate_doa,
    "telemetry/diagnostic/doa": _validate_diagnostic_doa,
    "telemetry/angular": _validate_angular,
    "telemetry/diagnostic/angular": _validate_angular_frame,
    "settings/reported": _validate_settings_report,
    "ack/config": _validate_ack,
    "ack/operation": _validate_ack,
}


def _add_note(value: Dict[str, Any], note: str) -> None:
    """Add a note to an accepted payload after validation."""
    notes = value.setdefault("notes", [])
    if note not in notes and len(notes) < MAX_NOTES:
        notes.append(note)


def progress_ack_older(t: Any, previous_t: Any) -> bool:
    """True when a progress ACK belongs before the progress ACK already held for its command.

    Only the edge's ``t`` decides, never the stage: the edge stamps every ACK
    when it sends it, and the LoRa bridge's second send (0.5 s later) is the
    same bytes, so a late copy of ACCEPTED is older than the APPLYING that
    overtook it. Stages do go back: a config.patch whose live retune fails
    sends VERIFYING {method: LIVE}, then APPLYING and VERIFYING {method: RESTART}.
    """
    return type(t) is int and type(previous_t) is int and t < previous_t


def _source_window(source_ms: int, at_ms: int, max_age_ms: int) -> Optional[str]:
    """Why a source timestamp is outside its window at ``at_ms``, or None."""
    if source_ms > at_ms + FUTURE_TOLERANCE_MS:
        return "SOURCE_TIME_FUTURE"
    if at_ms - source_ms > max_age_ms:
        return "SOURCE_TIMESTAMP_NOT_FRESH"
    return None


def _age(now_ms: int, then_ms: int) -> int:
    return now_ms - then_ms


def _within(now_ms: int, then_ms: int, limit_ms: int) -> bool:
    """True while ``then_ms`` is at most ``limit_ms`` old and not in the future."""
    return 0 <= now_ms - then_ms <= limit_ms


def _public_payload(suffix: str, value: Dict[str, Any]) -> Dict[str, Any]:
    """What a topic entry shows: never the 360 values or the native settings text."""
    if suffix in ("telemetry/angular", "telemetry/diagnostic/angular"):
        shown = {key: item for key, item in value.items() if key != "values"}
        shown["values_count"] = len(value["values"])
        return shown
    if suffix == "settings/reported":
        shown = {key: value[key] for key in ("v", "sid", "boot", "id", "rev", "t")}
        shown["bytes"] = len(value["settings_json"].encode("utf-8"))
        if value.get("notes"):
            shown["notes"] = list(value["notes"])
        return shown
    return dict(value)


class RdfNodeV2Telemetry:
    """Validate one node's messages and keep the latest accepted state per role."""

    def __init__(self, node_id: str) -> None:
        if not isinstance(node_id, str) or not _NODE_RE.fullmatch(node_id) or node_id in (".", ".."):
            raise ValueError("invalid node id")
        self.node_id = node_id
        self.prefix = f"sdr/v2/{node_id}/"
        self._topics: Dict[str, Dict[str, Any]] = {suffix: self._empty() for suffix in RDF_NODE_V2_SUFFIXES}
        self._counts = {suffix: 0 for suffix in RDF_NODE_V2_SUFFIXES}
        self._invalid_counts = {suffix: 0 for suffix in RDF_NODE_V2_SUFFIXES}
        self._received = self._valid = self._invalid = self._cleared = 0
        self._last_received: Optional[int] = None
        self._identities: Dict[str, Tuple[str, str]] = {}
        self._session: Optional[Dict[str, Any]] = None
        self._capabilities: Optional[Dict[str, Any]] = None
        self._availability: Optional[Dict[str, Any]] = None
        self._acks: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        # config.get id -> (expiry, sid the command named or None).
        self._settings_requests: Dict[str, Tuple[int, Optional[str]]] = {}
        # Called with (suffix, record) for every ACK and settings report this
        # store accepts; the monitor uses it to follow the commands it sent.
        self.on_accepted: Optional[Callable[[str, Dict[str, Any]], None]] = None
        # Called with the payload of every LIVE DoA accepted without a receipt
        # problem; the monitor feeds the position estimate from it.
        self.on_live_doa: Optional[Callable[[Dict[str, Any]], None]] = None
        # How the node reaches the broker (set_link): "lora" widens the Angular and detail windows.
        self._link: Optional[str] = None
        self._reset_session()

    @staticmethod
    def _empty() -> Dict[str, Any]:
        return {"status": "UNAVAILABLE", "received_at_ms": None, "qos": None, "retained": None,
                "expiry_s": None, "payload": None, "error": None}

    def _reset_session(self) -> None:
        """Forget everything the previous agent session sent."""
        self._health: Optional[Dict[str, Any]] = None
        self._detail: Optional[Dict[str, Any]] = None
        self._doa: Optional[Dict[str, Any]] = None
        self._doa_unverified: Optional[Dict[str, Any]] = None
        self._diagnostic_doa: Optional[Dict[str, Any]] = None
        self._angular: Optional[Dict[str, Any]] = None
        self._angular_unverified: Optional[Dict[str, Any]] = None
        self._settings: Optional[Dict[str, Any]] = None
        self._settings_requests.clear()
        self._seq: Dict[str, int] = {}
        self._diagnostic_source_ms = 0
        for suffix in SESSION_SUFFIXES:
            self._topics[suffix] = self._empty()

    def set_link(self, link: Optional[str]) -> None:
        """How the node reaches this broker: ``"lora"`` (the LoRa serial bridge) or None.

        Over LoRa an Angular frame counts for ANGULAR_LORA_FRESH_MS and the
        detail for DETAIL_LORA_FRESH_MS, at receipt and in every later view.
        """
        self._link = LINK_LORA if link == LINK_LORA else None

    @property
    def link(self) -> Optional[str]:
        return self._link

    def _angular_fresh_ms(self) -> int:
        return ANGULAR_LORA_FRESH_MS if self._link == LINK_LORA else ANGULAR_FRESH_MS

    def _detail_fresh_ms(self) -> int:
        return DETAIL_LORA_FRESH_MS if self._link == LINK_LORA else DETAIL_FRESH_MS

    # -- public reads ---------------------------------------------------------

    def session_view(self, now_ms: int) -> Dict[str, Any]:
        """``state.sid``, ``state.boot``, ``state.cfg`` and health freshness, for commands."""
        state = self._session["payload"] if self._session else None
        health = self._health
        fresh = self._health_fresh(now_ms)
        return {
            "known": state is not None,
            "sid": state["sid"] if state else None,
            "boot": state["boot"] if state else None,
            "instance": state["instance"] if state else None,
            "cfg": state["cfg"] if state else None,
            "state_received_at_ms": self._session["received_at_ms"] if self._session else None,
            "health_fresh": fresh,
            "health_daq": health["payload"]["daq"] if health else None,
            "health_q": health["payload"]["q"] if health else None,
            "health_t": health["payload"]["t"] if health else None,
            "health_received_at_ms": health["received_at_ms"] if health else None,
            "capabilities": self._session_capabilities(),
        }

    def _session_capabilities(self) -> Optional[Dict[str, Any]]:
        """The command flags of ``capabilities``, only when it belongs to the current session.

        ``config_fields`` (contract 1.8) is the list of fields ``config.patch``
        takes, or None from an older edge that sends no list.
        """
        if self._capabilities is None or self._session is None:
            return None
        payload = self._capabilities["payload"]
        if payload["sid"] != self._session["payload"]["sid"]:
            return None
        flags: Dict[str, Any] = {flag: payload[flag] for flag in ("remote_commands", "remote_config_patch", "config_patch")}
        fields = payload.get("config_fields")
        flags["config_fields"] = list(fields) if isinstance(fields, list) else None
        return flags

    def expect_settings_report(self, command_id: str, now_ms: int, sid: Optional[str] = None) -> None:
        """Accept the ``settings/reported`` answer to a ``config.get`` with this id.

        ``sid`` is the session the command named. Such a request survives the
        store's first ``state`` of that session, so a new monitor that takes
        over a pending ``config.get`` before it has seen ``state`` keeps it.
        """
        if not isinstance(command_id, str) or not COMMAND_ID_RE.fullmatch(command_id):
            raise ValueError("invalid command id")
        if type(now_ms) is not int or now_ms < 0:
            raise ValueError("invalid time")
        if sid is not None and (not isinstance(sid, str) or not _SID_RE.fullmatch(sid)):
            raise ValueError("invalid sid")
        self._expire_settings_requests(now_ms)
        self._settings_requests.pop(command_id, None)
        while len(self._settings_requests) >= MAX_SETTINGS_REQUESTS:
            del self._settings_requests[next(iter(self._settings_requests))]
        self._settings_requests[command_id] = (now_ms + SETTINGS_REQUEST_TTL_MS, sid)

    def settings_report(self) -> Optional[Dict[str, Any]]:
        """The latest accepted settings report with its exact native text, server side only.

        ``settings_json`` and ``settings`` are the node's file at revision
        ``rev``. As in ``node_view`` (and the edge's ``Ground.config_view``),
        ``safe_settings`` is given only while ``rev`` equals ``state.cfg``
        (``matches_state_cfg``); a later revision makes the report history,
        not the node's current values.
        """
        if self._settings is None:
            return None
        value = self._settings["value"]
        cfg = self._session["payload"]["cfg"] if self._session else None
        current = cfg is not None and value["rev"] == cfg
        return copy.deepcopy({
            "id": value["id"], "sid": value["sid"], "boot": value["boot"], "rev": value["rev"],
            "t": value["t"], "received_at_ms": self._settings["received_at_ms"],
            "settings_json": value["settings_json"], "settings": value["settings"],
            "state_cfg": cfg, "matches_state_cfg": current,
            "safe_settings": value["safe_settings"] if current else {},
        })

    def ack(self, command_id: str) -> Optional[Dict[str, Any]]:
        """The latest ACK for one command id, or None."""
        record = self._acks.get(command_id) if isinstance(command_id, str) else None
        return copy.deepcopy(record) if record is not None else None

    # -- ingest ---------------------------------------------------------------

    def ingest(self, topic: str, payload: bytes, *, qos: int, retained: bool,
               received_at_ms: int, message_expiry_s: Optional[int] = None) -> None:
        if not isinstance(topic, str) or not topic.startswith(self.prefix):
            raise ValueError("topic outside node prefix")
        suffix = topic[len(self.prefix):]
        if suffix not in RDF_NODE_V2_SUFFIXES:
            raise ValueError("unsupported topic")
        if (type(qos) is not int or qos not in (0, 1) or type(retained) is not bool or
                type(received_at_ms) is not int or received_at_ms < 0):
            raise ValueError("invalid broker metadata")
        if message_expiry_s is not None and (type(message_expiry_s) is not int or not 0 <= message_expiry_s <= _U32):
            # A broker property outside MQTT's range says nothing about the payload.
            message_expiry_s = None
        if not isinstance(payload, bytes):
            raise ValueError("payload must be bytes")
        self._received += 1
        self._counts[suffix] += 1
        self._last_received = received_at_ms
        entry = self._empty()
        entry.update(received_at_ms=received_at_ms, qos=qos, retained=retained, expiry_s=message_expiry_s)
        self._topics[suffix] = entry

        if not payload and retained:
            # A zero-length retained publish removes the broker's retained
            # value: "no current value", not malformed data. Whatever this
            # topic alone provided goes with it.
            self._cleared += 1
            self._forget(suffix)
            self._topics[suffix] = entry
            entry.update(error="RETAINED_CLEARED", cleared=True)
            return
        notes: List[str] = []
        token = _NOTES.set(notes)
        try:
            # QoS and retain other than the edge's (a bridge without Retain As
            # Published, another publisher) are labelled, not refused.
            if qos != (0 if suffix.startswith("telemetry/") else 1) or retained != (suffix in RETAINED_SUFFIXES):
                _note("BROKER_POLICY")
            if not payload:
                raise _Invalid("EMPTY_PAYLOAD")
            if len(payload) > MAX_PAYLOAD_BYTES:
                raise _Invalid("PAYLOAD_TOO_LARGE")
            try:
                value = _VALIDATORS[suffix](_object(payload))
            except _Invalid:
                raise
            except (ArithmeticError, LookupError, TypeError, ValueError, RecursionError):
                # A case no validator names: still one INVALID message, never
                # an exception that leaves it uncounted.
                raise _Invalid("MALFORMED_PAYLOAD") from None
        except _Invalid as exc:
            _NOTES.reset(token)
            self._invalid += 1
            self._invalid_counts[suffix] += 1
            entry.update(status="INVALID", error=exc.code)
            if exc.field is not None and _FIELD_RE.fullmatch(exc.field):
                entry["field"] = exc.field
            return
        _NOTES.reset(token)
        if notes:
            value["notes"] = list(notes)
        self._valid += 1
        _HANDLERS[suffix](self, suffix, value, entry, received_at_ms)

    def _forget(self, suffix: str) -> None:
        if suffix == "state":
            self._session = None
            self._reset_session()
        elif suffix == "capabilities":
            self._capabilities = None
        elif suffix == "availability":
            self._availability = None
        elif suffix == "telemetry/health":
            self._health = None
        elif suffix == "telemetry/health/detail":
            self._detail = None
        elif suffix == "telemetry/doa":
            self._doa = self._doa_unverified = None
        elif suffix == "telemetry/diagnostic/doa":
            self._diagnostic_doa = None
        elif suffix == "telemetry/angular":
            self._angular = None
            if self._angular_unverified is not None and self._angular_unverified["topic"] == suffix:
                self._angular_unverified = None
        elif suffix == "telemetry/diagnostic/angular":
            if self._angular_unverified is not None and self._angular_unverified["topic"] == suffix:
                self._angular_unverified = None
        elif suffix == "settings/reported":
            self._settings = None

    @staticmethod
    def _mark(suffix: str, entry: Dict[str, Any], status: str, value: Dict[str, Any], error: Optional[str] = None) -> None:
        entry.update(status=status, payload=_public_payload(suffix, value), error=error)

    def _bound(self, suffix: str, value: Dict[str, Any], entry: Dict[str, Any]) -> bool:
        """True when the message belongs to the current session."""
        if self._session is None:
            self._mark(suffix, entry, "IGNORED", value, "NO_SESSION")
            return False
        if value["sid"] != self._session["payload"]["sid"]:
            self._mark(suffix, entry, "INCONSISTENT", value, "SESSION_MISMATCH")
            return False
        return True

    def _advanced(self, kind: str, suffix: str, value: Dict[str, Any], entry: Dict[str, Any]) -> bool:
        last = self._seq.get(kind, 0)
        if value["q"] > last:
            return True
        if last - value["q"] >= SEQUENCE_RESET_GAP:
            # The edge counted from the start again within the same session.
            _add_note(value, "SEQUENCE_RESET")
            return True
        self._mark(suffix, entry, "IGNORED", value, "SEQUENCE_NOT_ADVANCING")
        return False

    def _health_fresh(self, at_ms: int) -> bool:
        """Health received at most 8 s ago whose own time was inside its window when it came."""
        return (self._health is not None and self._health.get("in_window", True) and
                _within(at_ms, self._health["received_at_ms"], HEALTH_FRESH_MS))

    def _health_ok(self, at_ms: int) -> bool:
        return self._health_fresh(at_ms) and self._health is not None and self._health["payload"]["daq"] == 1

    def _on_state(self, suffix: str, value: Dict[str, Any], entry: Dict[str, Any], at: int) -> None:
        sid = value["sid"]
        identity = (value["boot"], value["instance"])
        known = self._identities.get(sid)
        if known is not None and known != identity:
            self._mark(suffix, entry, "INCONSISTENT", value, "SESSION_ALIAS_COLLISION")
            return
        if known is None:
            if len(self._identities) >= MAX_SESSIONS:
                self._identities.clear()
            self._identities[sid] = identity
        if self._session is None or self._session["payload"]["sid"] != sid:
            kept = {key: request for key, request in self._settings_requests.items() if request[1] == sid}
            self._reset_session()
            self._settings_requests.update(kept)
        self._session = {"payload": value, "received_at_ms": at}
        self._mark(suffix, entry, "CONTEXT", value)

    def _on_capabilities(self, suffix: str, value: Dict[str, Any], entry: Dict[str, Any], at: int) -> None:
        self._capabilities = {"payload": value, "received_at_ms": at}
        self._mark(suffix, entry, "CONTEXT", value)

    def _on_availability(self, suffix: str, value: Dict[str, Any], entry: Dict[str, Any], at: int) -> None:
        self._availability = {"payload": value, "received_at_ms": at}
        self._mark(suffix, entry, "CONTEXT", value)

    def _on_health(self, suffix: str, value: Dict[str, Any], entry: Dict[str, Any], at: int) -> None:
        if not self._bound(suffix, value, entry):
            return
        if not self._advanced("health", suffix, value, entry):
            return
        problem = _source_window(value["t"], at, HEALTH_FRESH_MS)
        self._seq["health"] = value["q"]
        # Health outside its window is kept and shown, but it never makes
        # health fresh, so it never lets DoA or Angular become LIVE.
        self._health = {"payload": value, "received_at_ms": at, "in_window": problem is None}
        if problem:
            self._mark(suffix, entry, "STALE", value, problem)
        else:
            self._mark(suffix, entry, "FRESH", value)

    def _on_detail(self, suffix: str, value: Dict[str, Any], entry: Dict[str, Any], at: int) -> None:
        if not self._bound(suffix, value, entry):
            return
        self._detail = {"payload": value, "received_at_ms": at}
        self._mark(suffix, entry, "FRESH", value)

    def _on_doa(self, suffix: str, value: Dict[str, Any], entry: Dict[str, Any], at: int) -> None:
        if not self._bound(suffix, value, entry):
            return
        live = value["ok"] == 1
        kind = "doa" if live else "doa_unverified"
        if not self._advanced(kind, suffix, value, entry):
            return
        # Every DoA is kept; what was wrong when it came is a reason that
        # keeps it from being LIVE, shown with it instead of dropping it.
        problems: List[str] = []
        window = _source_window(value["t"], at, DOA_FRESH_MS)
        if window:
            problems.append(window)
        if not live:
            cfg = self._session["payload"]["cfg"] if self._session else None
            if cfg is not None and value["rev"] != cfg:
                _add_note(value, "REVISION_MISMATCH")
        if not live and self._health_fresh(at) and not self._health_ok(at):
            # Fresh health with daq 0 or 2: the edge's own reason for an ok=0
            # sample, not a missing health. LIVE still needs daq=1.
            problems.append("DAQ_NOT_HEALTHY")
        elif not self._health_ok(at):
            problems.append("DOA_WITHOUT_HEALTH")
        self._seq[kind] = value["q"]
        record = {"payload": value, "received_at_ms": at, "receipt_reasons": problems}
        if live:
            self._doa = record
        else:
            self._doa_unverified = record
        if window:
            self._mark(suffix, entry, "STALE", value, window)
        elif problems == ["DAQ_NOT_HEALTHY"]:
            self._mark(suffix, entry, "UNVERIFIED", value, problems[0])
        elif problems:
            self._mark(suffix, entry, "INCONSISTENT", value, problems[0])
        else:
            self._mark(suffix, entry, "LIVE" if live else "UNVERIFIED", value)
            if live and self.on_live_doa is not None:
                self.on_live_doa(copy.deepcopy(value))

    def _on_diagnostic_doa(self, suffix: str, value: Dict[str, Any], entry: Dict[str, Any], at: int) -> None:
        if not self._bound(suffix, value, entry) or not self._advanced("diagnostic_doa", suffix, value, entry):
            return
        if value["source_timestamp_ms"] < self._diagnostic_source_ms:
            self._mark(suffix, entry, "INCONSISTENT", value, "SOURCE_TIME_REGRESSED")
            return
        self._seq["diagnostic_doa"] = value["q"]
        self._diagnostic_source_ms = value["source_timestamp_ms"]
        self._diagnostic_doa = {"payload": value, "received_at_ms": at}
        self._mark(suffix, entry, "UNVERIFIED", value)

    def _on_angular(self, suffix: str, value: Dict[str, Any], entry: Dict[str, Any], at: int) -> None:
        if not self._bound(suffix, value, entry):
            return
        live = value["flags"] == FLAGS_ALL
        kind = "angular" if live else "angular_unverified"
        if not self._advanced(kind, suffix, value, entry):
            return
        problems: List[str] = []
        window = _source_window(value["timestamp_ms"], at, self._angular_fresh_ms())
        if window:
            problems.append(window)
        if not self._health_ok(at):
            problems.append("ANGULAR_WITHOUT_HEALTH")
        self._seq[kind] = value["q"]
        if live:
            self._angular = {"payload": value, "received_at_ms": at, "receipt_reasons": problems}
        else:
            # Convention or authority evidence is missing: trust-only, kept
            # with the diagnostic candidate and never LIVE.
            self._angular_unverified = {"payload": value, "received_at_ms": at, "topic": suffix}
        if window:
            self._mark(suffix, entry, "STALE", value, window)
        elif problems:
            self._mark(suffix, entry, "INCONSISTENT", value, problems[0])
        else:
            self._mark(suffix, entry, "LIVE" if live else "UNVERIFIED", value)

    def _on_diagnostic_angular(self, suffix: str, value: Dict[str, Any], entry: Dict[str, Any], at: int) -> None:
        if not self._bound(suffix, value, entry) or not self._advanced("diagnostic_angular", suffix, value, entry):
            return
        self._seq["diagnostic_angular"] = value["q"]
        # A stale candidate is kept; its age becomes a reason, not a reject.
        self._angular_unverified = {"payload": value, "received_at_ms": at, "topic": suffix}
        problem = _source_window(value["timestamp_ms"], at, self._angular_fresh_ms())
        if problem:
            self._mark(suffix, entry, "STALE", value, problem)
        else:
            self._mark(suffix, entry, "UNVERIFIED", value)

    def _expire_settings_requests(self, now_ms: int) -> None:
        for command_id, (expires_at, _sid) in list(self._settings_requests.items()):
            if now_ms > expires_at:
                del self._settings_requests[command_id]

    def _on_settings(self, suffix: str, value: Dict[str, Any], entry: Dict[str, Any], at: int) -> None:
        if not self._bound(suffix, value, entry):
            return
        if value["boot"] != self._session["payload"]["boot"]:  # type: ignore[index]
            self._mark(suffix, entry, "INCONSISTENT", value, "SESSION_MISMATCH")
            return
        self._expire_settings_requests(at)
        if value["id"] not in self._settings_requests:
            self._mark(suffix, entry, "IGNORED", value, "UNREQUESTED_SETTINGS_REPORT")
            return
        problem = _source_window(value["t"], at, SETTINGS_FRESH_MS)
        if problem:
            self._mark(suffix, entry, "STALE", value, problem)
            return
        del self._settings_requests[value["id"]]
        self._settings = {"value": value, "received_at_ms": at}
        self._mark(suffix, entry, "FRESH", value)
        self._notify(suffix, {"id": value["id"], "rev": value["rev"], "t": value["t"], "received_at_ms": at})

    def _on_ack(self, suffix: str, value: Dict[str, Any], entry: Dict[str, Any], at: int) -> None:
        if not self._bound(suffix, value, entry):
            return
        status = value["status"]
        final = status in ACK_FINAL_STATUSES
        previous = self._acks.get(value["id"])
        if previous is not None and previous["final"] and not final:
            self._mark(suffix, entry, "IGNORED", value, "ACK_AFTER_FINAL")
            return
        if (previous is not None and not previous["final"] and not final and
                progress_ack_older(value["t"], previous["t"])):
            # A resent copy of an earlier ACK (the LoRa bridge's second send).
            self._mark(suffix, entry, "IGNORED", value, "ACK_OUT_OF_ORDER")
            return
        self._acks.pop(value["id"], None)
        self._acks[value["id"]] = {
            "id": value["id"], "topic": suffix, "status": status, "final": final, "sid": value["sid"],
            "t": value["t"], "rev": value["rev"], "result": value["result"], "received_at_ms": at,
        }
        while len(self._acks) > MAX_ACKS:
            self._acks.popitem(last=False)
        # A config.get that ends without APPLIED will get no settings report.
        if suffix == "ack/config" and final and status != "APPLIED":
            self._settings_requests.pop(value["id"], None)
        self._mark(suffix, entry, "FRESH", value)
        self._notify(suffix, self._acks[value["id"]])

    def _notify(self, suffix: str, record: Dict[str, Any]) -> None:
        listener = self.on_accepted
        if listener is None:
            return
        try:
            listener(suffix, copy.deepcopy(record))
        except Exception:
            # A listener's failure never changes what the store accepted.
            pass

    # -- views ----------------------------------------------------------------

    def _doa_reasons(self, now_ms: int) -> List[str]:
        assert self._doa is not None
        reasons: List[str] = [reason for reason in self._doa.get("receipt_reasons", ())
                              if reason == "DOA_WITHOUT_HEALTH"]
        t = self._doa["payload"]["t"]
        if t > now_ms + FUTURE_TOLERANCE_MS:
            reasons.append("SOURCE_TIME_FUTURE")
        elif not _within(now_ms, self._doa["received_at_ms"], DOA_FRESH_MS) or now_ms - t > DOA_FRESH_MS:
            reasons.append("SOURCE_STALE")
        if not self._health_fresh(now_ms):
            reasons.append("HEALTH_STALE")
        elif self._health is not None and self._health["payload"]["daq"] != 1:
            reasons.append("DAQ_NOT_HEALTHY")
        return reasons

    def _angular_reasons(self, now_ms: int) -> List[str]:
        assert self._angular is not None
        reasons: List[str] = [reason for reason in self._angular.get("receipt_reasons", ())
                              if reason == "ANGULAR_WITHOUT_HEALTH"]
        problem = _source_window(self._angular["payload"]["timestamp_ms"], now_ms, self._angular_fresh_ms())
        if problem:
            reasons.append("SOURCE_TIME_FUTURE" if problem == "SOURCE_TIME_FUTURE" else "SOURCE_STALE")
        if not self._health_fresh(now_ms):
            reasons.append("HEALTH_STALE")
        elif self._health is not None:
            if self._health["payload"]["daq"] != 1:
                reasons.append("DAQ_NOT_HEALTHY")
            if self._health["payload"]["run"] != 1:
                reasons.append("PROCESSING_NOT_RUNNING")
        return reasons

    def _unverified_angular_reasons(self, now_ms: int) -> List[str]:
        """Why the diagnostic candidate is not LIVE, as the edge's Ground lists them."""
        assert self._angular_unverified is not None
        frame = self._angular_unverified["payload"]
        flags = frame["flags"]
        reasons: List[str] = []
        for bit, reason in (
            (FLAG_PARSED, "SOURCE_PARSE_UNVERIFIED"),
            (FLAG_FRESH, "SOURCE_FRESHNESS_UNVERIFIED"),
            (FLAG_AUTHORITY, "SOURCE_AUTHORITY_UNVERIFIED_AT_EDGE"),
            (FLAG_DAQ, "DAQ_NOT_HEALTHY_AT_EDGE"),
            (FLAG_CONVENTION, "ANGLE_UNVERIFIED_AT_EDGE"),
            (FLAG_CONFIG, "CONFIG_ATTRIBUTION_UNVERIFIED"),
        ):
            if not flags & bit:
                reasons.append(reason)
        problem = _source_window(frame["timestamp_ms"], now_ms, self._angular_fresh_ms())
        if problem:
            reasons.append("SOURCE_TIME_FUTURE" if problem == "SOURCE_TIME_FUTURE" else "SOURCE_STALE")
        if not self._health_fresh(now_ms):
            reasons.append("HEALTH_STALE")
        elif self._health is not None:
            if self._health["payload"]["daq"] != 1:
                reasons.append("DAQ_NOT_HEALTHY")
            if self._health["payload"]["run"] != 1:
                reasons.append("PROCESSING_NOT_RUNNING")
        cfg = self._session["payload"]["cfg"] if self._session else None
        if frame["revision"] is not None and cfg is not None and frame["revision"] != cfg:
            reasons.append("PREVIOUS_CONFIG")
        return reasons

    def node_view(self, now_ms: int) -> Dict[str, Any]:
        """The node as the console may use it: accepted values only, aged at ``now_ms``."""
        if type(now_ms) is not int or now_ms < 0:
            raise ValueError("invalid snapshot time")
        session_sid = self._session["payload"]["sid"] if self._session else None

        def timed(record: Optional[Dict[str, Any]], **extra: Any) -> Optional[Dict[str, Any]]:
            if record is None:
                return None
            value = copy.deepcopy(record["payload"])
            value.update(received_at_ms=record["received_at_ms"], age_ms=_age(now_ms, record["received_at_ms"]))
            value.update(extra)
            return value

        def matched(record: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
            if record is None:
                return None
            return timed(record, session_match=None if session_sid is None else record["payload"]["sid"] == session_sid)

        doa = None
        if self._doa is not None:
            reasons = self._doa_reasons(now_ms)
            doa = timed(self._doa, source_age_ms=_age(now_ms, self._doa["payload"]["t"]), live=not reasons, reasons=reasons)
        doa_unverified = None
        if self._doa_unverified is not None:
            unverified_t = self._doa_unverified["payload"]["t"]
            doa_unverified = timed(
                self._doa_unverified,
                source_age_ms=_age(now_ms, unverified_t),
                stale=(not _within(now_ms, self._doa_unverified["received_at_ms"], UNVERIFIED_DOA_FRESH_MS) or
                       _source_window(unverified_t, now_ms, UNVERIFIED_DOA_FRESH_MS) is not None),
                reasons=list(self._doa_unverified.get("receipt_reasons", ())),
            )
        diagnostic_doa = None
        if self._diagnostic_doa is not None:
            diagnostic_doa = timed(
                self._diagnostic_doa,
                stale=not _within(now_ms, self._diagnostic_doa["received_at_ms"], DIAGNOSTIC_DOA_FRESH_MS),
            )
        angular_window = self._angular_fresh_ms()
        angular = None
        if self._angular is not None:
            reasons = self._angular_reasons(now_ms)
            angular = timed(self._angular, source_age_ms=_age(now_ms, self._angular["payload"]["timestamp_ms"]),
                            live=not reasons, reasons=reasons, max_age_ms=angular_window)
        angular_unverified = None
        if self._angular_unverified is not None:
            frame = self._angular_unverified
            reasons = self._unverified_angular_reasons(now_ms)
            angular_unverified = timed(
                frame, topic=frame["topic"], trust="UNVERIFIED",
                source_age_ms=_age(now_ms, frame["payload"]["timestamp_ms"]),
                stale=_source_window(frame["payload"]["timestamp_ms"], now_ms, angular_window) is not None,
                validation_reasons=reasons, max_age_ms=angular_window,
            )
        settings = None
        if self._settings is not None:
            value = self._settings["value"]
            cfg = self._session["payload"]["cfg"] if self._session else None
            current = cfg is not None and value["rev"] == cfg
            settings = {
                "id": value["id"], "rev": value["rev"], "t": value["t"],
                "received_at_ms": self._settings["received_at_ms"],
                "age_ms": _age(now_ms, self._settings["received_at_ms"]),
                "bytes": len(value["settings_json"].encode("utf-8")),
                "matches_state_cfg": current,
                # Safe fields only while the report's revision is the node's.
                "safe_settings": copy.deepcopy(value["safe_settings"]) if current else {},
            }
        self._expire_settings_requests(now_ms)
        return {
            "session": None if self._session is None else timed(self._session),
            "health": timed(self._health, fresh=self._health_fresh(now_ms)),
            "detail": timed(self._detail, stale=self._detail is not None and not _within(
                now_ms, self._detail["received_at_ms"], self._detail_fresh_ms()), max_age_ms=self._detail_fresh_ms()),
            "doa": doa,
            "doa_unverified": doa_unverified,
            "diagnostic_doa": diagnostic_doa,
            "angular": angular,
            "angular_unverified": angular_unverified,
            "capabilities": matched(self._capabilities),
            "availability": matched(self._availability),
            "settings": settings,
            "settings_requests": list(self._settings_requests),
            "acks": [copy.deepcopy(record) for record in reversed(self._acks.values())],
        }

    def counters(self) -> Dict[str, Any]:
        """Message counts of every subscribed topic, for the one MQTT status (``/api/mqtt``)."""
        return {
            "received": self._received,
            "valid": self._valid,
            "invalid": self._invalid,
            "cleared": self._cleared,
            "last_received_at_ms": self._last_received,
        }

    def snapshot(self, now_ms: int) -> Dict[str, Any]:
        if type(now_ms) is not int or now_ms < 0:
            raise ValueError("invalid snapshot time")
        node = self.node_view(now_ms)
        topics = {suffix: copy.deepcopy(entry) for suffix, entry in self._topics.items()}

        def decay(suffix: str, status: str, error: Optional[str]) -> None:
            entry = topics[suffix]
            entry["status"], entry["error"] = status, error

        def aged(suffix: str, limit_ms: int) -> bool:
            received = topics[suffix]["received_at_ms"]
            return isinstance(received, int) and not _within(now_ms, received, limit_ms)

        for suffix, limit in (("telemetry/health", HEALTH_FRESH_MS),
                              ("telemetry/health/detail", self._detail_fresh_ms()),
                              ("settings/reported", SETTINGS_FRESH_MS), ("ack/config", ACK_FRESH_MS),
                              ("ack/operation", ACK_FRESH_MS)):
            if topics[suffix]["status"] == "FRESH" and aged(suffix, limit):
                decay(suffix, "STALE", "SOURCE_STALE")
        if topics["telemetry/doa"]["status"] == "LIVE" and node["doa"] and not node["doa"]["live"]:
            decay("telemetry/doa", "STALE", node["doa"]["reasons"][0])
        if topics["telemetry/doa"]["status"] == "UNVERIFIED" and aged("telemetry/doa", UNVERIFIED_DOA_FRESH_MS):
            decay("telemetry/doa", "STALE", "SOURCE_STALE")
        if topics["telemetry/diagnostic/doa"]["status"] == "UNVERIFIED" and aged(
                "telemetry/diagnostic/doa", DIAGNOSTIC_DOA_FRESH_MS):
            decay("telemetry/diagnostic/doa", "STALE", "SOURCE_STALE")
        if topics["telemetry/angular"]["status"] == "LIVE" and node["angular"] and not node["angular"]["live"]:
            decay("telemetry/angular", "STALE", node["angular"]["reasons"][0])
        # Both Angular topics share one candidate in the node view, so each
        # row ages by its own frame, whichever topic holds the candidate.
        for suffix in ("telemetry/angular", "telemetry/diagnostic/angular"):
            payload = topics[suffix]["payload"]
            if topics[suffix]["status"] == "UNVERIFIED" and isinstance(payload, dict):
                problem = _source_window(payload["timestamp_ms"], now_ms, self._angular_fresh_ms())
                if problem:
                    decay(suffix, "STALE", "SOURCE_TIME_FUTURE" if problem == "SOURCE_TIME_FUTURE" else "SOURCE_STALE")
        session = node["session"]
        for suffix in ("capabilities", "availability"):
            payload = topics[suffix]["payload"]
            if (topics[suffix]["status"] == "CONTEXT" and session is not None and isinstance(payload, dict) and
                    payload.get("sid") != session["sid"]):
                decay(suffix, "INCONSISTENT", "SESSION_MISMATCH")
        # A retained online:true means nothing once health stops: an edge that
        # stopped without its STOPPED farewell (older than 1.10.2, or the LoRa
        # bridge went down first) leaves it behind.
        payload = topics["availability"]["payload"]
        if (topics["availability"]["status"] == "CONTEXT" and isinstance(payload, dict) and payload.get("online") is True
                and aged("availability", HEALTH_FRESH_MS) and not self._health_fresh(now_ms)):
            decay("availability", "STALE", "HEALTH_STALE")
        return {
            "node_id": self.node_id,
            "now_ms": now_ms,
            **self.counters(),
            "topic_counts": dict(self._counts),
            "invalid_counts": dict(self._invalid_counts),
            "topics": topics,
            "node": node,
        }


_HANDLERS: Dict[str, Callable[[RdfNodeV2Telemetry, str, Dict[str, Any], Dict[str, Any], int], None]] = {
    "state": RdfNodeV2Telemetry._on_state,
    "capabilities": RdfNodeV2Telemetry._on_capabilities,
    "availability": RdfNodeV2Telemetry._on_availability,
    "telemetry/health": RdfNodeV2Telemetry._on_health,
    "telemetry/health/detail": RdfNodeV2Telemetry._on_detail,
    "telemetry/doa": RdfNodeV2Telemetry._on_doa,
    "telemetry/diagnostic/doa": RdfNodeV2Telemetry._on_diagnostic_doa,
    "telemetry/angular": RdfNodeV2Telemetry._on_angular,
    "telemetry/diagnostic/angular": RdfNodeV2Telemetry._on_diagnostic_angular,
    "settings/reported": RdfNodeV2Telemetry._on_settings,
    "ack/config": RdfNodeV2Telemetry._on_ack,
    "ack/operation": RdfNodeV2Telemetry._on_ack,
}

__all__ = [
    "ACK_FINAL_STATUSES",
    "ACK_STATUSES",
    "ANGULAR_LORA_FRESH_MS",
    "COMMAND_ID_RE",
    "DETAIL_LORA_FRESH_MS",
    "MAX_PAYLOAD_BYTES",
    "RDF_NODE_V2_SUFFIXES",
    "RdfNodeV2Telemetry",
    "progress_ack_older",
    "safe_settings",
]
