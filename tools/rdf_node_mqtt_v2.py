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
"""
from __future__ import annotations

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
# Top-level ACK result keys the edge writes (control.py, helper.py, journal.py).
# A one-time ``challenge`` is never kept.
ACK_RESULT_KEYS = frozenset({
    "revision", "proof", "persisted", "reason", "error", "profile", "scope", "desired", "accepted",
    "accepted_by_systemd", "requested_ms", "service", "valid_seconds", "prepare_id", "scheduled",
    "delay_seconds", "action", "requested", "operation", "elapsed_ms", "phase", "steps", "boot",
    "previous_boot", "boot_before", "changes", "cleared", "late",
})
_SECRET_KEY_WORDS = ("challenge", "secret", "password", "passwd", "token", "credential", "private")

# The edge's own safe settings (source.FIELD_MAP and safe_settings()).
SAFE_SETTINGS_MAP = {
    "center_frequency_hz": ("center_freq", 1e6),
    "gain_db": ("uniform_gain", 1),
    "vfo0_frequency_hz": ("vfo_freq_0", 1),
    "vfo0_bandwidth_hz": ("vfo_bw_0", 1),
    "vfo0_squelch_db": ("vfo_squelch_0", 1),
}
SAFE_SETTINGS_SCALARS = ("ant_arrangement", "doa_method", "active_vfos", "output_vfo", "en_doa")

_NODE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_SID_RE = re.compile(r"^[0-9a-f]{8}$")
_IDENTITY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$")
COMMAND_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
_WORD_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,63}$")
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


def _present(data: Dict[str, Any], key: str) -> Any:
    if key not in data:
        raise _Invalid("MISSING_FIELD", key)
    return data[key]


def _int(data: Dict[str, Any], key: str, low: int, high: int, *, nullable: bool = False) -> Optional[int]:
    value = _present(data, key)
    if value is None and nullable:
        return None
    if type(value) is not int or not low <= value <= high:
        raise _Invalid("INVALID_FIELD", key)
    return value


def _number(data: Dict[str, Any], key: str, low: float, high: float, *, nullable: bool = False) -> Any:
    value = _present(data, key)
    if value is None and nullable:
        return None
    if not _finite_in(value, low, high):
        raise _Invalid("INVALID_FIELD", key)
    return value


def _finite_in(value: Any, low: float, high: float) -> bool:
    """A JSON number (never a boolean) that is finite and within ``low..high``."""
    if type(value) is int:
        return low <= value <= high
    return type(value) is float and math.isfinite(value) and low <= value <= high


def _bool(data: Dict[str, Any], key: str, *, nullable: bool = False) -> Optional[bool]:
    value = _present(data, key)
    if value is None and nullable:
        return None
    if type(value) is not bool:
        raise _Invalid("INVALID_FIELD", key)
    return value


def _text(data: Dict[str, Any], key: str, pattern: "re.Pattern[str]", *, nullable: bool = False) -> Optional[str]:
    value = _present(data, key)
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise _Invalid("INVALID_FIELD", key)
    return value


def _choice(data: Dict[str, Any], key: str, choices: frozenset) -> Any:
    value = _present(data, key)
    if type(value) not in (int, str) or value not in choices:
        raise _Invalid("INVALID_FIELD", key)
    return value


def _epoch(data: Dict[str, Any], key: str) -> int:
    value = _int(data, key, _EPOCH_MS_MIN, _EPOCH_MS_MAX)
    assert value is not None
    return value


def _words(data: Dict[str, Any], key: str, limit: int) -> List[str]:
    value = _present(data, key)
    if (not isinstance(value, list) or len(value) > limit or
            any(not isinstance(item, str) or not _WORD_RE.fullmatch(item) for item in value)):
        raise _Invalid("INVALID_FIELD", key)
    return list(value)


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
    return value


def _validate_capabilities(data: Dict[str, Any]) -> Dict[str, Any]:
    value = _envelope(data)
    value.update(boot=_text(data, "boot", _IDENTITY_RE), instance=_text(data, "instance", _IDENTITY_RE))
    if "t" in data:
        value["t"] = _epoch(data, "t")
    value.update(
        version=_text(data, "version", _WORD_RE),
        mode=_text(data, "mode", _WORD_RE),
        codecs=_words(data, "codecs", 16),
        angle=_text(data, "angle", _WORD_RE),
        native_axis=_int(data, "native_axis", -128, 127),
        count=_int(data, "count", 1, 4096),
        profiles=_words(data, "profiles", 16),
        scope=_text(data, "scope", _WORD_RE),
    )
    for flag in CAPABILITY_FLAGS:
        value[flag] = _bool(data, flag)
    # Edges before 1.0.0-20261013 published it; it is no longer required.
    if "maintenance" in data:
        value["maintenance"] = _bool(data, "maintenance")
    return value


def _validate_availability(data: Dict[str, Any]) -> Dict[str, Any]:
    value = _envelope(data)
    value["online"] = _bool(data, "online")
    # The Last Will carries no time; an online message always does.
    if value["online"] or "t" in data:
        value["t"] = _epoch(data, "t")
    if "reason" in data:
        value["reason"] = _text(data, "reason", _CODE_RE)
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
    return value


def _validate_detail(data: Dict[str, Any]) -> Dict[str, Any]:
    value = _envelope(data)
    value.update(t=_epoch(data, "t"), usb=_int(data, "usb", 0, 1000, nullable=True))
    sync = _present(data, "sync")
    if not isinstance(sync, list) or len(sync) != 3 or any(item is not None and type(item) is not bool for item in sync):
        raise _Invalid("INVALID_FIELD", "sync")
    value["sync"] = list(sync)
    for key in ("cpu", "mem", "disk_free"):
        value[key] = _number(data, key, 0, 100, nullable=True)
    for key in ("throt", "uv"):
        value[key] = _bool(data, key, nullable=True)
    for key in ("tx", "rx"):
        value[key] = _number(data, key, 0, 1e9, nullable=True)
    for key in ("adrop", "parse"):
        value[key] = _int(data, key, 0, _COUNT_MAX)
    # PPP link fields of newer edges (after 8691ad0); absent from older ones.
    for key in ("ppp", "peer", "ppp_svc"):
        if key in data:
            value[key] = _text(data, key, _CODE_RE, nullable=True)
    if "ppp_restarts" in data:
        value["ppp_restarts"] = _int(data, "ppp_restarts", 0, _COUNT_MAX, nullable=True)
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
    if value["ok"] == 0:
        reasons = data.get("validation_reasons")
        if data.get("trust") != "UNVERIFIED":
            raise _Invalid("BAD_UNVERIFIED_DOA", "trust")
        if data.get("angle_reference") != "RAW":
            raise _Invalid("BAD_UNVERIFIED_DOA", "angle_reference")
        if (not isinstance(reasons, list) or not 1 <= len(reasons) <= 2 or
                any(not isinstance(item, str) or item not in UNVERIFIED_DOA_REASONS for item in reasons) or
                len(set(reasons)) != len(reasons)):
            raise _Invalid("BAD_UNVERIFIED_DOA", "validation_reasons")
        value.update(trust="UNVERIFIED", angle_reference="RAW", validation_reasons=list(reasons))
    return value


def _validate_diagnostic_doa(data: Dict[str, Any]) -> Dict[str, Any]:
    value = _envelope(data)
    value["q"] = _int(data, "q", 1, _U32)
    if data.get("source") != "doa.xml":
        raise _Invalid("BAD_DIAGNOSTIC_DOA", "source")
    value.update(
        source="doa.xml",
        source_timestamp_ms=_epoch(data, "source_timestamp_ms"),
        observed_timestamp_ms=_epoch(data, "observed_timestamp_ms"),
        raw_doa_deg=_number(data, "raw_doa_deg", 0, 360),
        frequency_mhz=_number(data, "frequency_mhz", 0.001, 5000),
    )
    if data.get("trust") != "UNVERIFIED":
        raise _Invalid("BAD_DIAGNOSTIC_DOA", "trust")
    reasons = data.get("validation_reasons")
    if (not isinstance(reasons, list) or not 1 <= len(reasons) <= 32 or
            any(not isinstance(item, str) or not _REASON_RE.fullmatch(item) for item in reasons) or
            "DIAGNOSTIC_UNVERIFIED" not in reasons):
        raise _Invalid("BAD_DIAGNOSTIC_DOA", "validation_reasons")
    value.update(trust="UNVERIFIED", validation_reasons=list(reasons))
    return value


def _validate_angular_frame(data: Dict[str, Any]) -> Dict[str, Any]:
    """One Angular JSON frame, as codec.decode() checks it."""
    if type(data.get("v")) is not int or data["v"] != 2:
        raise _Invalid("BAD_ANGULAR_JSON", "v")
    if data.get("encoding") != "json":
        raise _Invalid("BAD_ANGULAR_JSON", "encoding")
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
    # Missing parse, freshness, DAQ or config evidence is a reject, not a downgrade.
    if value["flags"] & FLAGS_INTEGRITY != FLAGS_INTEGRITY:
        raise _Invalid("ANGULAR_EVIDENCE_INCOMPLETE", "flags")
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
                raise _Invalid("BAD_SETTINGS_JSON", "settings_json") from None
            result[name] = int(round(number)) if name.endswith("_hz") else number
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
    if set(data) != SETTINGS_REPORT_FIELDS:
        raise _Invalid("BAD_SETTINGS_REPORT")
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
        raise _Invalid("UNKNOWN_ACK_STATUS", "status")
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
        self._settings_requests: Dict[str, int] = {}
        # Called with (suffix, record) for every ACK and settings report this
        # store accepts; the monitor uses it to follow the commands it sent.
        self.on_accepted: Optional[Callable[[str, Dict[str, Any]], None]] = None
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

    def _session_capabilities(self) -> Optional[Dict[str, bool]]:
        """The command flags of ``capabilities``, only when it belongs to the current session."""
        if self._capabilities is None or self._session is None:
            return None
        payload = self._capabilities["payload"]
        if payload["sid"] != self._session["payload"]["sid"]:
            return None
        return {flag: payload[flag] for flag in ("remote_commands", "remote_config_patch", "config_patch")}

    def expect_settings_report(self, command_id: str, now_ms: int) -> None:
        """Accept the ``settings/reported`` answer to a ``config.get`` with this id."""
        if not isinstance(command_id, str) or not COMMAND_ID_RE.fullmatch(command_id):
            raise ValueError("invalid command id")
        if type(now_ms) is not int or now_ms < 0:
            raise ValueError("invalid time")
        self._expire_settings_requests(now_ms)
        self._settings_requests.pop(command_id, None)
        while len(self._settings_requests) >= MAX_SETTINGS_REQUESTS:
            del self._settings_requests[next(iter(self._settings_requests))]
        self._settings_requests[command_id] = now_ms + SETTINGS_REQUEST_TTL_MS

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
            raise ValueError("invalid message expiry")
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
        try:
            if qos != (0 if suffix.startswith("telemetry/") else 1) or retained != (suffix in RETAINED_SUFFIXES):
                raise _Invalid("BROKER_POLICY")
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
            self._invalid += 1
            self._invalid_counts[suffix] += 1
            entry.update(status="INVALID", error=exc.code)
            if exc.field is not None and _FIELD_RE.fullmatch(exc.field):
                entry["field"] = exc.field
            return
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
        if value["q"] <= self._seq.get(kind, 0):
            self._mark(suffix, entry, "IGNORED", value, "SEQUENCE_NOT_ADVANCING")
            return False
        return True

    def _health_fresh(self, at_ms: int) -> bool:
        return self._health is not None and _within(at_ms, self._health["received_at_ms"], HEALTH_FRESH_MS)

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
            self._reset_session()
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
        problem = _source_window(value["t"], at, HEALTH_FRESH_MS)
        if problem:
            self._mark(suffix, entry, "STALE", value, problem)
            return
        if not self._advanced("health", suffix, value, entry):
            return
        self._seq["health"] = value["q"]
        self._health = {"payload": value, "received_at_ms": at}
        self._mark(suffix, entry, "FRESH", value)

    def _on_detail(self, suffix: str, value: Dict[str, Any], entry: Dict[str, Any], at: int) -> None:
        if not self._bound(suffix, value, entry):
            return
        self._detail = {"payload": value, "received_at_ms": at}
        self._mark(suffix, entry, "FRESH", value)

    def _on_doa(self, suffix: str, value: Dict[str, Any], entry: Dict[str, Any], at: int) -> None:
        if not self._bound(suffix, value, entry):
            return
        problem = _source_window(value["t"], at, DOA_FRESH_MS)
        if problem:
            self._mark(suffix, entry, "STALE", value, problem)
            return
        live = value["ok"] == 1
        kind = "doa" if live else "doa_unverified"
        if not self._advanced(kind, suffix, value, entry):
            return
        if not live:
            cfg = self._session["payload"]["cfg"] if self._session else None
            if cfg is not None and value["rev"] != cfg:
                self._mark(suffix, entry, "INCONSISTENT", value, "REVISION_MISMATCH")
                return
        if not self._health_ok(at):
            self._mark(suffix, entry, "INCONSISTENT", value, "DOA_WITHOUT_HEALTH")
            return
        self._seq[kind] = value["q"]
        if live:
            self._doa = {"payload": value, "received_at_ms": at}
            self._mark(suffix, entry, "LIVE", value)
        else:
            self._doa_unverified = {"payload": value, "received_at_ms": at}
            self._mark(suffix, entry, "UNVERIFIED", value)

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
        problem = _source_window(value["timestamp_ms"], at, ANGULAR_FRESH_MS)
        if problem:
            self._mark(suffix, entry, "STALE", value, problem)
            return
        if not self._health_ok(at):
            self._mark(suffix, entry, "INCONSISTENT", value, "ANGULAR_WITHOUT_HEALTH")
            return
        live = value["flags"] == FLAGS_ALL
        kind = "angular" if live else "angular_unverified"
        if not self._advanced(kind, suffix, value, entry):
            return
        self._seq[kind] = value["q"]
        if live:
            self._angular = {"payload": value, "received_at_ms": at}
            self._mark(suffix, entry, "LIVE", value)
        else:
            # Convention or authority evidence is missing: trust-only, kept
            # with the diagnostic candidate and never LIVE.
            self._angular_unverified = {"payload": value, "received_at_ms": at, "topic": suffix}
            self._mark(suffix, entry, "UNVERIFIED", value)

    def _on_diagnostic_angular(self, suffix: str, value: Dict[str, Any], entry: Dict[str, Any], at: int) -> None:
        if not self._bound(suffix, value, entry) or not self._advanced("diagnostic_angular", suffix, value, entry):
            return
        self._seq["diagnostic_angular"] = value["q"]
        # A stale candidate is kept; its age becomes a reason, not a reject.
        self._angular_unverified = {"payload": value, "received_at_ms": at, "topic": suffix}
        problem = _source_window(value["timestamp_ms"], at, ANGULAR_FRESH_MS)
        if problem:
            self._mark(suffix, entry, "STALE", value, problem)
        else:
            self._mark(suffix, entry, "UNVERIFIED", value)

    def _expire_settings_requests(self, now_ms: int) -> None:
        for command_id, expires_at in list(self._settings_requests.items()):
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
        reasons: List[str] = []
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
        reasons: List[str] = []
        problem = _source_window(self._angular["payload"]["timestamp_ms"], now_ms, ANGULAR_FRESH_MS)
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
        problem = _source_window(frame["timestamp_ms"], now_ms, ANGULAR_FRESH_MS)
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
            doa_unverified = timed(
                self._doa_unverified,
                source_age_ms=_age(now_ms, self._doa_unverified["payload"]["t"]),
                stale=not _within(now_ms, self._doa_unverified["received_at_ms"], UNVERIFIED_DOA_FRESH_MS),
            )
        diagnostic_doa = None
        if self._diagnostic_doa is not None:
            diagnostic_doa = timed(
                self._diagnostic_doa,
                stale=not _within(now_ms, self._diagnostic_doa["received_at_ms"], DIAGNOSTIC_DOA_FRESH_MS),
            )
        angular = None
        if self._angular is not None:
            reasons = self._angular_reasons(now_ms)
            angular = timed(self._angular, source_age_ms=_age(now_ms, self._angular["payload"]["timestamp_ms"]),
                            live=not reasons, reasons=reasons)
        angular_unverified = None
        if self._angular_unverified is not None:
            frame = self._angular_unverified
            reasons = self._unverified_angular_reasons(now_ms)
            angular_unverified = timed(
                frame, topic=frame["topic"], trust="UNVERIFIED",
                source_age_ms=_age(now_ms, frame["payload"]["timestamp_ms"]),
                stale=_source_window(frame["payload"]["timestamp_ms"], now_ms, ANGULAR_FRESH_MS) is not None,
                validation_reasons=reasons,
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
                now_ms, self._detail["received_at_ms"], DETAIL_FRESH_MS)),
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

        for suffix, limit in (("telemetry/health", HEALTH_FRESH_MS), ("telemetry/health/detail", DETAIL_FRESH_MS),
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
                problem = _source_window(payload["timestamp_ms"], now_ms, ANGULAR_FRESH_MS)
                if problem:
                    decay(suffix, "STALE", "SOURCE_TIME_FUTURE" if problem == "SOURCE_TIME_FUTURE" else "SOURCE_STALE")
        session = node["session"]
        for suffix in ("capabilities", "availability"):
            payload = topics[suffix]["payload"]
            if (topics[suffix]["status"] == "CONTEXT" and session is not None and isinstance(payload, dict) and
                    payload.get("sid") != session["sid"]):
                decay(suffix, "INCONSISTENT", "SESSION_MISMATCH")
        return {
            "node_id": self.node_id,
            "now_ms": now_ms,
            "received": self._received,
            "valid": self._valid,
            "invalid": self._invalid,
            "cleared": self._cleared,
            "last_received_at_ms": self._last_received,
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
    "COMMAND_ID_RE",
    "MAX_PAYLOAD_BYTES",
    "RDF_NODE_V2_SUFFIXES",
    "RdfNodeV2Telemetry",
    "safe_settings",
]
