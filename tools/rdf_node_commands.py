"""Commands the console sends to the RDF Node edge: ``config.get`` and ``config.patch``.

The contract is ``docs/MQTT_KONTRAK.md`` section 5, taken from the edge at
commit 8691ad0 (``rdf_node/control.py`` ``CommandManager.submit``, and the
field rules of ``rdf_node/helper.py`` ``validate_changes`` and ``patch_file``).
Every command is one compact JSON object on ``sdr/v2/<node>/cmd/config/get``
or ``.../cmd/config/patch``, QoS 1, never retained, with the envelope

    {"v": 2, "id", "sid", "boot", "issued_ms", "expires_ms", "base_rev", "op", ...}

``sid`` and ``boot`` come from the node's latest ``state``, ``base_rev`` from
``state.cfg``, and the command lives 15 s (the edge accepts at most 30 s).
This module only builds and checks; it publishes nothing and imports no
edge code. Its checks are the edge's, so a command the console refuses here
is one the edge would refuse too, and the console's own error codes reuse the
edge's names where the rule is the same.
"""

from __future__ import annotations

import json
import math
import re
import uuid
from typing import Any, Dict, Mapping, Optional, Tuple

PROTOCOL_VERSION = 2
COMMAND_QOS = 1
# The edge's Ground default; control.py refuses a lifetime above 30 s.
COMMAND_TTL_MS = 15_000
MAX_COMMAND_TTL_MS = 30_000
# control.py: issued_ms may be at most 1 s ahead of the edge clock.
MAX_ISSUED_AHEAD_MS = 1_000

OP_CONFIG_GET = "config.get"
OP_CONFIG_PATCH = "config.patch"
COMMAND_SUFFIXES: Dict[str, str] = {
    OP_CONFIG_GET: "cmd/config/get",
    OP_CONFIG_PATCH: "cmd/config/patch",
}
ACK_SUFFIX = "ack/config"
SETTINGS_SUFFIX = "settings/reported"

COMMAND_ID_PREFIX = "gc-"
COMMAND_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
_SID_RE = re.compile(r"^[0-9a-f]{8}$")
_IDENTITY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$")
_NODE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_U32 = 0xFFFFFFFF

# The edge's safe fields (source.FIELD_MAP) in its own order, and the helper's
# default policy limits (helper.DEFAULT_POLICY, validate_changes). Deliberately
# narrower than the settings document: no DAQ topology, calibration,
# endpoints, credentials or lifecycle. A node whose helper policy is narrower
# answers FAILED with INTEGER_OUT_OF_RANGE.
PATCH_FIELDS: Tuple[str, ...] = (
    "center_frequency_hz",
    "gain_db",
    "vfo0_frequency_hz",
    "vfo0_bandwidth_hz",
    "vfo0_squelch_db",
)
FREQUENCY_RANGE_HZ = (24_000_000, 1_766_000_000)
PATCH_RANGES: Dict[str, Tuple[float, float]] = {
    "center_frequency_hz": FREQUENCY_RANGE_HZ,
    "gain_db": (-10, 100),
    "vfo0_frequency_hz": FREQUENCY_RANGE_HZ,
    "vfo0_bandwidth_hz": (100, 2_400_000),
    "vfo0_squelch_db": (-200, 50),
}
INTEGER_FIELDS = frozenset({"center_frequency_hz", "vfo0_frequency_hz", "vfo0_bandwidth_hz"})
# The helper accepts a gain only within 0.001 dB of one of these.
GAIN_TABLE_DB: Tuple[float, ...] = (
    0.0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9, 25.4,
    28.0, 29.7, 32.8, 33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5, 48.0, 49.6,
)
GAIN_TABLE_TOLERANCE_DB = 0.001
# control.py: every value must be finite in -200..5e9 before the helper sees it.
SUBMIT_VALUE_RANGE = (-200.0, 5e9)

# Envelope fields control.py allows, and the fields each op of this module sends.
ENVELOPE_FIELDS = ("v", "id", "sid", "boot", "issued_ms", "expires_ms", "base_rev", "op")
_OP_FIELDS = {OP_CONFIG_GET: frozenset(), OP_CONFIG_PATCH: frozenset({"changes"})}


class CommandRefused(ValueError):
    """A command the edge would refuse; ``code`` is the console's error code."""

    def __init__(self, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.extra = extra


def _plain(value: float) -> Any:
    return int(value) if float(value).is_integer() else value


def ranges_view() -> Dict[str, list]:
    """[min, max] per field, as capabilities report them."""
    return {field: [_plain(low), _plain(high)] for field, (low, high) in PATCH_RANGES.items()}


def command_topic(node_id: str, op: str) -> str:
    if not isinstance(node_id, str) or not _NODE_RE.fullmatch(node_id) or node_id in (".", ".."):
        raise ValueError("invalid node id")
    if op not in COMMAND_SUFFIXES:
        raise ValueError("unsupported operation")
    return f"sdr/v2/{node_id}/{COMMAND_SUFFIXES[op]}"


def new_command_id() -> str:
    """A fresh id: ``gc-`` and 24 hex digits, inside the edge's ``[A-Za-z0-9_.:-]{1,80}``."""
    return COMMAND_ID_PREFIX + uuid.uuid4().hex[:24]


def _number(field: str, value: Any) -> float:
    low, high = PATCH_RANGES[field]
    whole = field in INTEGER_FIELDS
    unit = "Hz" if field.endswith("_hz") else "dB"
    message = (
        f"{field} must be a whole number of {unit} from {_plain(low)} to {_plain(high)}"
        if whole else f"{field} must be a finite number of {unit} from {_plain(low)} to {_plain(high)}"
    )
    if type(value) not in (int, float) or (type(value) is float and not math.isfinite(value)):
        raise CommandRefused("VALUE_OUT_OF_RANGE", message, field=field, range=[_plain(low), _plain(high)])
    if whole and float(value) != int(value):
        raise CommandRefused("VALUE_OUT_OF_RANGE", message, field=field, range=[_plain(low), _plain(high)])
    if not low <= value <= high:
        raise CommandRefused("VALUE_OUT_OF_RANGE", message, field=field, range=[_plain(low), _plain(high)])
    return int(value) if whole else value


def validate_patch_changes(changes: Any) -> Dict[str, Any]:
    """The ``changes`` of a ``config.patch`` as the edge checks them, normalized.

    Hz fields become integers, a gain becomes its table value, and the fields
    keep the edge's order. Raises ``CommandRefused`` with the first failure:
    ``INVALID_REQUEST``, ``EMPTY_CHANGES``, ``FIELD_NOT_ALLOWED``,
    ``VALUE_OUT_OF_RANGE``, ``GAIN_NOT_IN_APPROVED_TABLE``,
    ``CENTER_CHANGE_REQUIRES_VFO0_TARGET`` or ``MVP_CENTER_MUST_EQUAL_VFO0``.
    """
    if not isinstance(changes, Mapping):
        raise CommandRefused("INVALID_REQUEST", "changes must be a JSON object")
    if not changes:
        raise CommandRefused("EMPTY_CHANGES", "changes must contain at least one field")
    unknown = sorted(str(key) for key in changes if key not in PATCH_RANGES)
    if unknown:
        raise CommandRefused(
            "FIELD_NOT_ALLOWED", "fields not allowed: " + ", ".join(unknown), fields=unknown,
            allowed=list(PATCH_FIELDS),
        )
    normalized: Dict[str, Any] = {}
    for field in PATCH_FIELDS:
        if field not in changes:
            continue
        value = _number(field, changes[field])
        if field == "gain_db":
            table = [gain for gain in GAIN_TABLE_DB if abs(value - gain) < GAIN_TABLE_TOLERANCE_DB]
            if not table:
                raise CommandRefused(
                    "GAIN_NOT_IN_APPROVED_TABLE",
                    "gain_db must be one of the RDF-SDR gain table values",
                    field=field, gains=list(GAIN_TABLE_DB),
                )
            value = table[0]
        normalized[field] = value
    # helper.patch_file: a centre change must take VFO0 along, to the same frequency.
    if "center_frequency_hz" in normalized:
        if "vfo0_frequency_hz" not in normalized:
            raise CommandRefused(
                "CENTER_CHANGE_REQUIRES_VFO0_TARGET",
                "a center_frequency_hz change needs vfo0_frequency_hz with the same value",
                field="vfo0_frequency_hz",
            )
        if normalized["vfo0_frequency_hz"] != normalized["center_frequency_hz"]:
            raise CommandRefused(
                "MVP_CENTER_MUST_EQUAL_VFO0",
                "center_frequency_hz and vfo0_frequency_hz must be equal when the center changes",
                field="vfo0_frequency_hz",
            )
    return normalized


def build_command(
    op: str,
    *,
    command_id: str,
    sid: Optional[str],
    boot: Optional[str],
    base_rev: Optional[int],
    issued_ms: int,
    ttl_ms: int = COMMAND_TTL_MS,
    changes: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """The envelope in the edge's field order; no checks (see ``validate_command``)."""
    command: Dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "id": command_id,
        "sid": sid,
        "boot": boot,
        "issued_ms": int(issued_ms),
        "expires_ms": int(issued_ms) + int(ttl_ms),
        "base_rev": base_rev,
        "op": op,
    }
    if op == OP_CONFIG_PATCH:
        command["changes"] = dict(changes or {})
    return command


def validate_command(command: Any, *, now_ms: Optional[int] = None) -> Dict[str, Any]:
    """Check an envelope the way control.py ``submit`` does before it acts.

    ``now_ms``, when given, also checks the deadline against that clock.
    Returns the command; raises ``CommandRefused`` (code ``INVALID_REQUEST``
    for a malformed envelope, or a field code from ``validate_patch_changes``).
    """
    def bad(message: str) -> CommandRefused:
        return CommandRefused("INVALID_REQUEST", message)

    if not isinstance(command, Mapping):
        raise bad("command must be a JSON object")
    op = command.get("op")
    if op not in _OP_FIELDS:
        raise bad("op must be config.get or config.patch")
    expected = set(ENVELOPE_FIELDS) | _OP_FIELDS[op]
    if set(command) != expected:
        raise bad("command fields must be exactly " + ", ".join(sorted(expected)))
    if type(command["v"]) is not int or command["v"] != PROTOCOL_VERSION:
        raise bad("v must be 2")
    if not isinstance(command["id"], str) or not COMMAND_ID_RE.fullmatch(command["id"]):
        raise bad("id must match [A-Za-z0-9_.:-]{1,80}")
    if not isinstance(command["sid"], str) or not _SID_RE.fullmatch(command["sid"]):
        raise bad("sid must be the node session from state")
    if not isinstance(command["boot"], str) or not _IDENTITY_RE.fullmatch(command["boot"]):
        raise bad("boot must be the node boot from state")
    issued, expires = command["issued_ms"], command["expires_ms"]
    if type(issued) is not int or type(expires) is not int or issued < 1:
        raise bad("issued_ms and expires_ms must be integers")
    if not 0 < expires - issued <= MAX_COMMAND_TTL_MS:
        raise bad(f"the command must live 1 to {MAX_COMMAND_TTL_MS} ms")
    if now_ms is not None and (expires <= now_ms or issued > now_ms + MAX_ISSUED_AHEAD_MS):
        raise bad("the command deadline is not current")
    base_rev = command["base_rev"]
    if base_rev is not None and (type(base_rev) is not int or not 0 <= base_rev <= _U32):
        raise bad("base_rev must be state.cfg: an integer or null")
    if op == OP_CONFIG_PATCH:
        if base_rev is None:
            raise bad("a config.patch needs the node's revision as base_rev")
        normalized = validate_patch_changes(command["changes"])
        given = dict(command["changes"])
        if list(normalized) != list(given) or any(
            type(value) is not type(given[field]) or value != given[field] for field, value in normalized.items()
        ):
            raise bad("changes must be normalized: whole Hz as integers, gains from the table, the edge's field order")
        for value in normalized.values():
            if not SUBMIT_VALUE_RANGE[0] <= value <= SUBMIT_VALUE_RANGE[1]:
                raise bad("a value is outside -200..5e9")
    return dict(command)


def encode_command(command: Mapping[str, Any]) -> bytes:
    """Compact JSON, ASCII only, no NaN: the bytes that are published."""
    return json.dumps(dict(command), separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("utf-8")


__all__ = [
    "ACK_SUFFIX",
    "COMMAND_QOS",
    "COMMAND_SUFFIXES",
    "COMMAND_TTL_MS",
    "CommandRefused",
    "GAIN_TABLE_DB",
    "MAX_COMMAND_TTL_MS",
    "OP_CONFIG_GET",
    "OP_CONFIG_PATCH",
    "PATCH_FIELDS",
    "PATCH_RANGES",
    "SETTINGS_SUFFIX",
    "build_command",
    "command_topic",
    "encode_command",
    "new_command_id",
    "ranges_view",
    "validate_command",
    "validate_patch_changes",
]
