"""Bounded, read-only validator/store for RDF Node MQTT v2 telemetry."""
from __future__ import annotations

import json
import math
import re
import struct
import uuid
import copy
from dataclasses import dataclass, field
from typing import Any

RDF_NODE_V2_SUFFIXES: tuple[str, ...] = (
    "telemetry/doa", "telemetry/diagnostic/doa", "telemetry/diagnostic/angular",
    "telemetry/health", "telemetry/health/detail", "telemetry/angular",
    "state", "capabilities", "config/reported", "availability", "ack/config", "ack/operation",
)
_JSON_LIMIT = 16384
_MAX_SAFE_INTEGER = (1 << 53) - 1
_ANGULAR_LIMIT = 420
_HEADER = struct.Struct("<4sBBHIIQIIBBHffHh")
_ENVELOPE = struct.Struct("<IIBBH")
_NODE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_SID_RE = re.compile(r"^[0-9a-fA-F]{8}$")
_ACK_ERROR_CODE_RE = re.compile(r"^[A-Z0-9_]{1,64}$")
_DIAGNOSTIC_REASON_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")

_FIELDS = {
    "telemetry/doa": ("v", "sid", "q", "t", "f", "a", "c", "p", "rev", "ok"),
    "telemetry/diagnostic/doa": (
        "v", "sid", "q", "source", "source_timestamp_ms", "observed_timestamp_ms",
        "raw_doa_deg", "frequency_mhz", "trust", "validation_reasons",
    ),
    "telemetry/health": ("v", "sid", "q", "t", "run", "daq", "drop", "age", "temp", "clk", "rev"),
    "telemetry/health/detail": ("v", "sid", "t", "usb", "sync", "cpu", "mem", "disk_free", "throt", "uv", "tx", "rx", "adrop", "parse"),
    "state": ("v", "sid", "boot", "instance", "t", "run", "daq", "cfg", "profile", "clock"),
    "capabilities": ("v", "sid", "boot", "instance", "version", "mode", "codecs", "angle", "native_axis", "count", "profiles", "scope", "helper_available", "maintenance", "remote_commands", "config_patch", "processing", "restart", "reboot"),
    "config/reported": ("v", "sid", "rev", "t", "proof", "digest", "effective"),
    "availability": ("v", "sid", "online", "t", "reason"),
    "ack/config": ("v", "sid", "id", "status", "t", "rev", "result", "error"),
    "ack/operation": ("v", "sid", "id", "status", "t", "rev", "result", "error"),
}
_SAFE_EFFECTIVE_FIELDS = frozenset({
    "center_frequency_hz", "gain_db", "vfo0_frequency_hz", "vfo0_bandwidth_hz",
    "vfo0_squelch_db", "ant_arrangement", "doa_method", "active_vfos", "output_vfo", "en_doa",
})
_SAFE_ACK_RESULT_FIELDS = frozenset({
    "revision", "proof", "persisted", "operation", "valid_seconds", "prepare_id",
    "status", "id", "op", "state", "result", "error", "code", "target_id",
})
_SAFE_ACK_PROOF_VALUES = {
    "center_frequency_hz": "FRESH_DAQ_RF_CENTER",
    "vfo0_frequency_hz": "FRESH_DOA_FREQUENCY",
}


def _safe_ack_value(value: Any, depth: int = 0, field: str | None = None) -> Any:
    if depth > 4:
        return None
    if field in ("error", "code") and value is not None:
        if field == "error" and isinstance(value, dict):
            pass
        elif isinstance(value, str) and _ACK_ERROR_CODE_RE.fullmatch(value):
            return value
        else:
            raise ValueError("INVALID_FIELD")
    if value is None or type(value) is bool:
        return value
    if type(value) is int:
        if abs(value) > _MAX_SAFE_INTEGER:
            raise ValueError("INVALID_FIELD")
        return value
    if type(value) is float:
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        return value[:256]
    if isinstance(value, list):
        return [_safe_ack_value(item, depth + 1) for item in value[:32]]
    if isinstance(value, dict):
        if field == "proof":
            return {
                key: expected
                for key, expected in _SAFE_ACK_PROOF_VALUES.items()
                if value.get(key) == expected
            }
        return {
            key: _safe_ack_value(item, depth + 1, key)
            for key, item in list(value.items())[:32]
            if key in _SAFE_ACK_RESULT_FIELDS
            and not any(word in key.lower() for word in ("challenge", "secret", "password", "token", "credential", "private"))
        }
    return None



@dataclass
class _Assembly:
    created_ms: int
    count: int
    total: int
    parts: dict[int, bytes] = field(default_factory=dict)


class RdfNodeV2Telemetry:
    """Validate one node's observations and retain bounded latest state."""

    def __init__(self, node_id: str):
        if not isinstance(node_id, str) or not _NODE_RE.fullmatch(node_id) or node_id in (".", ".."):
            raise ValueError("invalid node id")
        self.node_id = node_id
        self.prefix = f"sdr/v2/{node_id}/"
        self._topics = {suffix: self._empty() for suffix in RDF_NODE_V2_SUFFIXES}
        self._counts = {suffix: 0 for suffix in RDF_NODE_V2_SUFFIXES}
        self._received = self._valid = self._invalid = 0
        self._last_received: int | None = None
        self._seq: dict[str, int] = {}
        self._session: tuple[str, str | None, str | None] | None = None
        self._revision: int | None = None
        self._revision_known = False
        self._state_revision: int | None = None
        self._state_revision_known = False
        self._assemblies: dict[tuple[str, int, int], _Assembly] = {}
        self._angular_last_q: int | None = None

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {"status": "UNAVAILABLE", "received_at_ms": None, "qos": None,
                "retained": None, "payload": None, "candidate_payload": None, "error": None}
    @staticmethod
    def _safe(value: Any) -> Any:
        if value is None or isinstance(value, (str, bool, int)):
            return value
        if isinstance(value, float):
            if not math.isfinite(value):
                raise ValueError("NONFINITE")
            return value
        if isinstance(value, list):
            return [RdfNodeV2Telemetry._safe(item) for item in value]
        if isinstance(value, dict) and all(isinstance(key, str) for key in value):
            return {key: RdfNodeV2Telemetry._safe(item) for key, item in value.items()}
        raise ValueError("INVALID_VALUE")

    @staticmethod
    def _integer(data: dict[str, Any], key: str, low: int = 0, high: int = 2**53 - 1) -> int:
        value = data.get(key)
        if type(value) is not int or not low <= value <= high:
            raise ValueError("INVALID_FIELD")
        return value

    @staticmethod
    def _number(data: dict[str, Any], key: str, low: float, high: float, nullable: bool = False) -> Any:
        value = data.get(key)
        if nullable and value is None:
            return None
        if type(value) is int:
            if not low <= value <= high:
                raise ValueError("INVALID_FIELD")
        elif type(value) is float:
            if not math.isfinite(value) or not low <= value <= high:
                raise ValueError("INVALID_FIELD")
        else:
            raise ValueError("INVALID_FIELD")
        return value

    @staticmethod
    def _uuid(data: dict[str, Any], key: str) -> None:
        try:
            if str(uuid.UUID(data.get(key, ""))) != data[key].lower():
                raise ValueError
        except (ValueError, AttributeError, TypeError):
            raise ValueError("INVALID_IDENTITY") from None

    @staticmethod
    def _decode_json(raw: bytes) -> dict[str, Any]:
        try:
            value = json.loads(raw.decode("utf-8"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError("NONFINITE")))
        except Exception as exc:
            raise ValueError("NONFINITE" if str(exc) == "NONFINITE" else "MALFORMED_JSON") from None
        if not isinstance(value, dict):
            raise ValueError("INVALID_ENVELOPE")
        try:
            data = RdfNodeV2Telemetry._safe(value)
        except RecursionError:
            raise ValueError("INVALID_DEPTH") from None
        except ValueError as exc:
            raise ValueError(str(exc) if str(exc) == "NONFINITE" else "INVALID_VALUE") from None
        return data

    def _validate_json(self, suffix: str, data: dict[str, Any]) -> dict[str, Any]:
        if type(data.get("v")) is not int or data["v"] != 2:
            raise ValueError("INVALID_VERSION")
        if not isinstance(data.get("sid"), str) or not _SID_RE.fullmatch(data["sid"]):
            raise ValueError("INVALID_IDENTITY")
        if suffix == "availability" and data.get("online") is False:
            if "t" in data:
                self._integer(data, "t", 1)
        elif suffix == "capabilities":
            if "t" in data:
                self._integer(data, "t", 1)
        elif suffix != "telemetry/diagnostic/doa":
            self._integer(data, "t", 1)
        if suffix in ("telemetry/doa", "telemetry/health", "telemetry/diagnostic/doa"):
            self._integer(data, "q", 0, 0xffffffff)
        if suffix == "telemetry/diagnostic/doa":
            if data.get("source") != "doa.xml":
                raise ValueError("INVALID_FIELD")
            self._integer(data, "source_timestamp_ms", 1, _MAX_SAFE_INTEGER)
            self._integer(data, "observed_timestamp_ms", 1, _MAX_SAFE_INTEGER)
            self._number(data, "raw_doa_deg", -_MAX_SAFE_INTEGER, _MAX_SAFE_INTEGER)
            self._number(data, "frequency_mhz", -_MAX_SAFE_INTEGER, _MAX_SAFE_INTEGER)
            if data.get("trust") != "UNVERIFIED":
                raise ValueError("INVALID_FIELD")
            reasons = data.get("validation_reasons")
            if (not isinstance(reasons, list) or len(reasons) > 32 or
                    any(not isinstance(reason, str) or not _DIAGNOSTIC_REASON_RE.fullmatch(reason)
                        for reason in reasons) or
                    "DIAGNOSTIC_UNVERIFIED" not in reasons):
                raise ValueError("INVALID_FIELD")
        elif suffix == "telemetry/doa":
            self._number(data, "f", 0, 10**12)
            self._number(data, "a", -180, 180)
            self._number(data, "c", -200, 200)
            self._number(data, "p", -200, 200)
            self._integer(data, "rev", 0, 0xffffffff)
            if type(data.get("ok")) is not int or data["ok"] not in (0, 1):
                raise ValueError("INVALID_FIELD")
        elif suffix == "telemetry/health":
            if type(data.get("run")) is not int or data["run"] not in (0, 1, 2, 3, 4, 255):
                raise ValueError("INVALID_FIELD")
            if type(data.get("daq")) is not int or data["daq"] not in (0, 1, 2):
                raise ValueError("INVALID_FIELD")
            if type(data.get("clk")) is not int or data["clk"] not in (0, 1):
                raise ValueError("INVALID_FIELD")
            for key in ("drop", "age"):
                if data.get(key) is not None:
                    self._integer(data, key, 0, 0xffffffff)
            self._number(data, "temp", -100, 200, True)
            if data.get("rev") is not None:
                self._integer(data, "rev", 0, 0xffffffff)
        elif suffix == "telemetry/health/detail":
            if data.get("usb") is not None:
                self._integer(data, "usb", 0, 255)
            sync = data.get("sync")
            if "sync" not in data or not isinstance(sync, list) or len(sync) != 3 or any(x is not None and type(x) is not bool for x in sync):
                raise ValueError("INVALID_FIELD")
            for key in ("cpu", "mem", "disk_free"):
                self._number(data, key, 0, 100, True)
            for key in ("throt", "uv"):
                if data.get(key) is not None and type(data[key]) is not bool:
                    raise ValueError("INVALID_FIELD")
            for key in ("tx", "rx"):
                self._number(data, key, 0, 1e9, True)
            for key in ("adrop", "parse"):
                self._integer(data, key, 0, 0xffffffff)
        elif suffix == "state":
            self._uuid(data, "boot")
            self._uuid(data, "instance")
            if data.get("run") not in ("RUNNING", "STOPPED", "STARTING", "STOPPING", "ERROR", "UNKNOWN"):
                raise ValueError("INVALID_FIELD")
            if type(data.get("daq")) is not bool:
                raise ValueError("INVALID_FIELD")
            self._integer(data, "cfg", 0, 0xffffffff)
            if not isinstance(data.get("profile"), str) or not isinstance(data.get("clock"), str):
                raise ValueError("INVALID_FIELD")
        elif suffix == "capabilities":
            self._uuid(data, "boot")
            self._uuid(data, "instance")
            for key in ("version", "mode", "angle", "scope"):
                if not isinstance(data.get(key), str):
                    raise ValueError("INVALID_FIELD")
            for key in ("codecs", "profiles"):
                if not isinstance(data.get(key), list) or any(not isinstance(x, str) for x in data[key]):
                    raise ValueError("INVALID_FIELD")
            self._integer(data, "native_axis", -128, 127)
            self._integer(data, "count", 0, 4096)
            for key in ("helper_available", "maintenance", "remote_commands", "config_patch", "processing", "restart", "reboot"):
                if type(data.get(key)) is not bool:
                    raise ValueError("INVALID_FIELD")
        elif suffix == "config/reported":
            if data.get("rev") is not None:
                self._integer(data, "rev", 0, 0xffffffff)
            if data.get("proof") not in ("unverified", "source_correlated", "runtime", "persisted_unverified"):
                raise ValueError("INVALID_FIELD")
            if not isinstance(data.get("digest"), str) or len(data["digest"]) > 128 or not isinstance(data.get("effective"), dict):
                raise ValueError("INVALID_FIELD")
            effective = data["effective"]
            if any(key not in _SAFE_EFFECTIVE_FIELDS for key in effective):
                raise ValueError("INVALID_FIELD")
            integer_fields = {"center_frequency_hz", "vfo0_frequency_hz", "vfo0_bandwidth_hz", "active_vfos", "output_vfo"}
            float_fields = {"gain_db", "vfo0_squelch_db"}
            string_fields = {"ant_arrangement", "doa_method"}
            for key, item in effective.items():
                if item is None:
                    continue
                if key in integer_fields and (
                    type(item) is not int or abs(item) > _MAX_SAFE_INTEGER
                ):
                    raise ValueError("INVALID_FIELD")
                if key in float_fields and (
                    type(item) not in (int, float)
                    or (type(item) is int and abs(item) > _MAX_SAFE_INTEGER)
                    or (type(item) is float and not math.isfinite(item))
                ):
                    raise ValueError("INVALID_FIELD")
                if key in string_fields and (not isinstance(item, str) or len(item) > 128):
                    raise ValueError("INVALID_FIELD")
                if key == "en_doa" and type(item) is not bool:
                    raise ValueError("INVALID_FIELD")
        elif suffix == "availability":
            if type(data.get("online")) is not bool:
                raise ValueError("INVALID_FIELD")
            if "reason" in data and (not isinstance(data["reason"], str) or len(data["reason"]) > 64):
                raise ValueError("INVALID_FIELD")
        else:
            if not isinstance(data.get("id"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", data["id"]):
                raise ValueError("INVALID_FIELD")
            if not isinstance(data.get("status"), str) or not re.fullmatch(r"[A-Z_]{1,32}", data["status"]):
                raise ValueError("INVALID_FIELD")
            if data.get("rev") is not None:
                self._integer(data, "rev", 0, 0xffffffff)
            if suffix in ("ack/config", "ack/operation"):
                for key in ("result", "error"):
                    if key in data and data[key] is not None and not isinstance(data[key], dict):
                        raise ValueError("INVALID_FIELD")
        normalized = {key: data[key] for key in _FIELDS[suffix] if key in data}
        if suffix == "config/reported":
            normalized["effective"] = {key: data["effective"][key] for key in _SAFE_EFFECTIVE_FIELDS if key in data["effective"]}
        if suffix in ("ack/config", "ack/operation"):
            for key in ("result", "error"):
                if key in data:
                    normalized[key] = _safe_ack_value(data[key], field=key)
        return normalized

    @staticmethod
    def _candidate_value(value: Any) -> tuple[bool, Any]:
        if value is None or type(value) in (str, bool):
            return True, value
        if type(value) is int:
            return abs(value) <= _MAX_SAFE_INTEGER, value
        if type(value) is float:
            return math.isfinite(value), value
        if isinstance(value, list):
            result = []
            for item in value:
                if isinstance(item, (dict, list)):
                    return False, None
                safe, item_value = RdfNodeV2Telemetry._candidate_value(item)
                if not safe:
                    return False, None
                result.append(item_value)
            return True, result
        return False, None

    @staticmethod
    def _candidate_payload(suffix: str, data: dict[str, Any]) -> dict[str, Any] | None:
        candidate: dict[str, Any] = {}
        for key in _FIELDS[suffix]:
            if key not in data:
                continue
            value = data[key]
            if suffix == "config/reported" and key == "effective":
                if not isinstance(value, dict):
                    continue
                effective = {}
                for field_name in _SAFE_EFFECTIVE_FIELDS:
                    if field_name not in value:
                        continue
                    safe, item = RdfNodeV2Telemetry._candidate_value(value[field_name])
                    if safe:
                        effective[field_name] = item
                candidate[key] = effective
            elif suffix in ("ack/config", "ack/operation") and key in ("result", "error"):
                if value is not None and not isinstance(value, dict):
                    continue
                try:
                    candidate[key] = _safe_ack_value(value, field=key)
                except ValueError:
                    continue
            else:
                safe, item = RdfNodeV2Telemetry._candidate_value(value)
                if safe:
                    candidate[key] = item
        return candidate or None

    def _clear_session_telemetry(self, *, reset_sequences: bool = False) -> None:
        for suffix in ("telemetry/health", "telemetry/health/detail", "telemetry/doa", "telemetry/angular"):
            self._topics[suffix] = self._empty()
        self._assemblies.clear()
        if reset_sequences:
            self._seq.clear()
            self._angular_last_q = None

    def _set_session(self, data: dict[str, Any]) -> bool:
        sid = data["sid"].lower()
        if "boot" in data:
            boot, instance = data["boot"], data["instance"]
            old = self._session
            if old is None:
                self._session = (sid, boot, instance)
            elif old[0] != sid or (old[1] is not None and old[1] != boot) or (old[2] is not None and old[2] != instance):
                self._clear_session_telemetry(reset_sequences=True)
                self._state_revision, self._state_revision_known = None, False
                self._session = (sid, boot, instance)
            else:
                self._session = (sid, old[1] or boot, old[2] or instance)
        elif self._session is None:
            self._session = (sid, None, None)
        return self._session[0] == sid

    def _health_fresh(self, now_ms: int) -> bool:
        entry = self._topics["telemetry/health"]
        health, received = entry["payload"], entry["received_at_ms"]
        return (entry["status"] == "FRESH" and entry["retained"] is False and
                isinstance(health, dict) and isinstance(received, int) and
                0 <= now_ms - received <= 8000 and 0 <= now_ms - health.get("t", 0) <= 8000)

    def _angular(self, raw: bytes, received_at_ms: int, suffix: str) -> tuple[dict[str, Any] | None, str | None, bool]:
        diagnostic = suffix == "telemetry/diagnostic/angular"
        if len(raw) > _ANGULAR_LIMIT:
            return None, "PAYLOAD_TOO_LARGE", False
        if len(raw) < _ENVELOPE.size:
            return None, "INVALID_CHUNK", False
        sid, q, index, count, total = _ENVELOPE.unpack_from(raw)
        body = raw[_ENVELOPE.size:]
        if count == 0 or count > 16 or index >= count or total < _HEADER.size or total > 768 or not body or len(body) > total:
            return None, "INVALID_CHUNK", False
        key = (suffix, sid, q)
        for old_key, assembly in list(self._assemblies.items()):
            if received_at_ms - assembly.created_ms > 3000:
                del self._assemblies[old_key]
        assembly = self._assemblies.get(key)
        if assembly is None:
            if len(self._assemblies) >= 2:
                oldest = min(self._assemblies, key=lambda k: self._assemblies[k].created_ms)
                del self._assemblies[oldest]
            assembly = _Assembly(received_at_ms, count, total)
            self._assemblies[key] = assembly
        if assembly.count != count or assembly.total != total or index in assembly.parts:
            del self._assemblies[key]
            return None, "INVALID_CHUNK", False
        assembly.parts[index] = body
        if len(assembly.parts) != count:
            return None, None, True
        frame = b"".join(assembly.parts[i] for i in range(count))
        del self._assemblies[key]
        if len(frame) != total or len(frame) < _HEADER.size:
            return None, "INVALID_FRAME", False
        try:
            (magic, version, encoding, flags, fsid, fq, timestamp, frequency, revision,
             vfo, convention, sample_count, scale, offset, raw_doa, confidence) = _HEADER.unpack_from(frame)
            flags_invalid = bool(flags & ~0x1f) if diagnostic else flags != 31
            if (magic != b"RDF2" or version != 2 or encoding not in (1, 2) or flags_invalid or
                    fsid != sid or fq != q or sample_count != 360):
                raise ValueError
            width = 2 if encoding == 1 else 1
            if len(frame) != _HEADER.size + 360 * width or not math.isfinite(scale) or not math.isfinite(offset):
                raise ValueError
            if encoding == 1:
                if not math.isclose(scale, .01, rel_tol=0, abs_tol=1e-7) or offset != 0:
                    raise ValueError
                raw_values = struct.unpack_from("<360h", frame, _HEADER.size)
                if any(x == -32768 for x in raw_values):
                    raise ValueError
                values = [x * .01 for x in raw_values]
            else:
                if not 0 <= scale <= 1e6 or not -1e6 <= offset <= 1e6:
                    raise ValueError
                values = [offset + x * scale for x in frame[_HEADER.size:]]
            if any(not math.isfinite(x) for x in values) or not 0 <= frequency <= 10**12 or not 0 < timestamp <= _MAX_SAFE_INTEGER or vfo > 255 or convention > 255:
                raise ValueError
            value = {"encoding": "q16" if encoding == 1 else "u8", "sid": sid, "q": q,
                     "frequency_hz": frequency, "revision": None if revision == 0xffffffff else revision,
                     "vfo": vfo, "convention": convention,
                     "raw_doa_deg": None if raw_doa == 65535 else raw_doa / 100,
                     "confidence_native_db": None if confidence == -32768 else confidence / 100,
                     "values": values}
            if diagnostic:
                reasons = ["DIAGNOSTIC_UNVERIFIED"]
                for bit, reason in (
                    (0, "SOURCE_PARSE_UNVERIFIED"),
                    (1, "CLOCK_FRESHNESS_UNVERIFIED"),
                    (2, "DAQ_UNVERIFIED"),
                    (3, "ANGLE_CONVENTION_UNVERIFIED"),
                    (4, "CONFIG_ATTRIBUTION_UNVERIFIED"),
                ):
                    if (flags & (1 << bit)) == 0:
                        reasons.append(reason)
                value.update({"source_timestamp_ms": timestamp, "flags": flags,
                              "trust": "UNVERIFIED", "validation_reasons": reasons})
            else:
                value["timestamp_ms"] = timestamp
            return value, None, False
        except (ValueError, struct.error, OverflowError):
            return None, "INVALID_FRAME", False

    def ingest(self, topic: str, payload: bytes, *, qos: int, retained: bool,
               received_at_ms: int, message_expiry_s: int | None = None) -> None:
        if not isinstance(topic, str) or not topic.startswith(self.prefix):
            raise ValueError("topic outside node prefix")
        suffix = topic[len(self.prefix):]
        if suffix not in RDF_NODE_V2_SUFFIXES:
            raise ValueError("unsupported topic")
        if type(qos) is not int or qos not in (0, 1) or type(retained) is not bool or type(received_at_ms) is not int or received_at_ms < 0:
            raise ValueError("invalid broker metadata")
        if message_expiry_s is not None and (type(message_expiry_s) is not int or not 0 <= message_expiry_s <= 0xffffffff):
            raise ValueError("invalid message expiry")
        if not isinstance(payload, bytes):
            raise ValueError("payload must be bytes")
        expected_qos = 0 if suffix.startswith("telemetry/") else 1
        should_retain = suffix in ("state", "capabilities", "config/reported", "availability")
        self._received += 1
        self._counts[suffix] += 1
        self._last_received = received_at_ms

        def store(
            status: str,
            value: Any = None,
            error: str | None = None,
            candidate_payload: dict[str, Any] | None = None,
        ) -> None:
            self._topics[suffix] = {
                "status": status,
                "received_at_ms": received_at_ms,
                "qos": qos,
                "retained": retained,
                "payload": value,
                "candidate_payload": candidate_payload,
                "error": error,
            }

        decoded_json: dict[str, Any] | None = None
        decode_error: ValueError | None = None
        if suffix not in ("telemetry/angular", "telemetry/diagnostic/angular") and len(payload) <= _JSON_LIMIT:
            try:
                decoded_json = self._decode_json(payload)
            except ValueError as exc:
                decode_error = exc

        if qos != expected_qos or retained != should_retain:
            self._invalid += 1
            candidate_payload = (
                self._candidate_payload(suffix, decoded_json)
                if decoded_json is not None
                else None
            )
            store("INVALID", error="BROKER_POLICY", candidate_payload=candidate_payload)
            return
        if suffix in ("telemetry/angular", "telemetry/diagnostic/angular"):
            value, error, pending = self._angular(payload, received_at_ms, suffix)
            if error:
                self._invalid += 1
                store("INVALID", error=error)
                return
            if pending or value is None:
                return
            self._valid += 1
            if suffix == "telemetry/diagnostic/angular":
                age = received_at_ms - value["source_timestamp_ms"]
                if 0 <= age <= 10000 and value["flags"] & 2:
                    store("FRESH", value)
                elif age < 0 or age > 10000:
                    store("STALE", value, "SOURCE_STALE")
                else:
                    store("STALE", value, "CLOCK_FRESHNESS_UNVERIFIED")
                return
            if self._angular_last_q is not None and value["q"] <= self._angular_last_q:
                store("INCONSISTENT", value, "SEQUENCE_REGRESSION")
                return
            self._angular_last_q = value["q"]
            sid_text = f"{value['sid']:08x}"
            health = self._topics["telemetry/health"]["payload"]
            if value["revision"] is None:
                store("INCONSISTENT", value, "REVISION_MISMATCH")
                return
            session_ok = self._session is None or self._session[0] == sid_text
            revision_ok = ((not self._revision_known or value["revision"] == self._revision) and
                           (not self._state_revision_known or value["revision"] == self._state_revision))
            if not session_ok:
                store("INCONSISTENT", value, "IDENTITY_MISMATCH")
                return
            if not revision_ok:
                store("INCONSISTENT", value, "REVISION_MISMATCH")
                return
            self._set_session({"sid": sid_text})
            if (not isinstance(health, dict) or not self._health_fresh(received_at_ms) or
                    health.get("daq") != 1 or health.get("sid", "").lower() != sid_text):
                store("INCONSISTENT", value, "HEALTH_MISMATCH")
                return
            if health.get("rev") is None or health.get("rev") != value["revision"]:
                store("INCONSISTENT", value, "REVISION_MISMATCH")
                return
            age = received_at_ms - value["timestamp_ms"]
            store("FRESH" if 0 <= age <= 10000 else "STALE", value, None if 0 <= age <= 10000 else "SOURCE_STALE")
            return
        if len(payload) > _JSON_LIMIT:
            self._invalid += 1
            store("INVALID", error="PAYLOAD_TOO_LARGE")
            return
        if decode_error is not None or decoded_json is None:
            self._invalid += 1
            error = decode_error or ValueError("MALFORMED_JSON")
            store(
                "INVALID",
                error=str(error) if re.fullmatch(r"[A-Z_]{1,32}", str(error)) else "INVALID_PAYLOAD",
            )
            return
        try:
            value = self._validate_json(suffix, decoded_json)
        except ValueError as exc:
            self._invalid += 1
            candidate_payload = self._candidate_payload(suffix, decoded_json)
            store(
                "INVALID",
                error=str(exc) if re.fullmatch(r"[A-Z_]{1,32}", str(exc)) else "INVALID_PAYLOAD",
                candidate_payload=candidate_payload,
            )
            return
        self._valid += 1
        if suffix == "telemetry/diagnostic/doa":
            age = received_at_ms - value["source_timestamp_ms"]
            store("FRESH" if 0 <= age <= 5000 else "STALE", value,
                  None if 0 <= age <= 5000 else "SOURCE_STALE")
            return
        if suffix in ("state", "capabilities"):
            if not self._set_session(value):
                store("INCONSISTENT", value, "IDENTITY_MISMATCH")
                return
        elif self._session is None:
            self._set_session(value)
        elif self._session[0] != value["sid"].lower():
            store("INCONSISTENT", value, "IDENTITY_MISMATCH")
            return
        if suffix == "config/reported":
            revision = value.get("rev")
            if revision is None:
                self._revision, self._revision_known = None, False
            else:
                cached = (
                    (self._topics["telemetry/health"]["payload"], "rev"),
                    (self._topics["telemetry/doa"]["payload"], "rev"),
                    (self._topics["telemetry/angular"]["payload"], "revision"),
                )
                cached_mismatch = any(
                    isinstance(payload, dict) and payload.get(field) != revision
                    for payload, field in cached
                )
                if (self._revision_known and revision != self._revision) or cached_mismatch:
                    self._clear_session_telemetry()
                self._revision, self._revision_known = revision, True
        elif suffix == "state":
            revision = value["cfg"]
            if self._state_revision_known and revision != self._state_revision:
                self._clear_session_telemetry()
            elif not self._state_revision_known:
                cached = (self._topics["telemetry/health"]["payload"],
                          self._topics["telemetry/doa"]["payload"],
                          self._topics["telemetry/angular"]["payload"])
                revisions = (cached[0].get("rev") if isinstance(cached[0], dict) else None,
                             cached[1].get("rev") if isinstance(cached[1], dict) else None,
                             cached[2].get("revision") if isinstance(cached[2], dict) else None)
                if any(old is not None and old != revision for old in revisions):
                    self._clear_session_telemetry()
            self._state_revision, self._state_revision_known = revision, True
        if suffix in ("telemetry/health", "telemetry/doa"):
            sequence = value["q"]
            previous = self._seq.get(suffix)
            if previous is not None and sequence <= previous:
                store("INCONSISTENT", value, "SEQUENCE_REGRESSION")
                return
            self._seq[suffix] = sequence
        if suffix == "telemetry/health":
            if retained:
                store("CONTEXT", value)
            elif ((self._revision_known and value.get("rev") != self._revision) or
                  (self._state_revision_known and value.get("rev") != self._state_revision)):
                store("INCONSISTENT", value, "REVISION_MISMATCH")
            else:
                age = received_at_ms - value["t"]
                store("FRESH" if 0 <= age <= 8000 else "STALE", value,
                      None if 0 <= age <= 8000 else "SOURCE_STALE")
        elif suffix == "telemetry/doa":
            health = self._topics["telemetry/health"]["payload"]
            age = received_at_ms - value["t"]
            if retained:
                store("CONTEXT", value)
            elif age < 0 or age > 5000:
                store("STALE", value, "SOURCE_STALE")
            elif (value["ok"] != 1 or not isinstance(health, dict) or not self._health_fresh(received_at_ms) or
                  health.get("daq") != 1 or health.get("sid", "").lower() != value["sid"].lower() or health.get("rev") != value["rev"]):
                store("INCONSISTENT", value, "HEALTH_MISMATCH")
            elif self._revision_known and self._revision != value["rev"]:
                store("INCONSISTENT", value, "REVISION_MISMATCH")
            elif self._state_revision_known and self._state_revision != value["rev"]:
                store("INCONSISTENT", value, "REVISION_MISMATCH")
            else:
                store("FRESH", value)
        elif suffix == "telemetry/health/detail":
            store("CONTEXT" if retained else "FRESH", value)
        elif suffix in ("state", "capabilities", "config/reported", "availability"):
            store("CONTEXT", value)
        else:
            store("CONTEXT" if retained else "FRESH", value)

    def snapshot(self, now_ms: int) -> dict[str, object]:
        if type(now_ms) is not int or now_ms < 0:
            raise ValueError("invalid snapshot time")
        topics = {suffix: copy.deepcopy(entry) for suffix, entry in self._topics.items()}
        max_ages = {
            "telemetry/health": 8000,
            "telemetry/doa": 5000,
            "telemetry/angular": 10000,
            "telemetry/health/detail": 15000,
            "ack/config": 30000,
            "ack/operation": 30000,
        }
        for suffix, max_age in max_ages.items():
            entry = topics[suffix]
            received = entry["received_at_ms"]
            if entry["status"] != "FRESH" or received is None:
                continue
            data = entry["payload"]
            source = data.get("t", data.get("timestamp_ms")) if isinstance(data, dict) else None
            if (now_ms < received or now_ms - received > max_age or not isinstance(source, int) or
                    now_ms < source or now_ms - source > max_age):
                entry["status"], entry["error"] = "STALE", "SOURCE_STALE"
        for suffix, receive_limit, source_limit in (
            ("telemetry/diagnostic/doa", 3000, 5000),
            ("telemetry/diagnostic/angular", 3000, 10000),
        ):
            entry = topics[suffix]
            if entry["status"] != "FRESH":
                continue
            received = entry["received_at_ms"]
            data = entry["payload"]
            source = data.get("source_timestamp_ms") if isinstance(data, dict) else None
            if (not isinstance(received, int) or now_ms < received or now_ms - received > receive_limit or
                    type(source) is not int or now_ms < source or now_ms - source > source_limit):
                entry["status"], entry["error"] = "STALE", "SOURCE_STALE"
            elif suffix == "telemetry/diagnostic/angular" and (data["flags"] & 2) == 0:
                entry["status"], entry["error"] = "STALE", "CLOCK_FRESHNESS_UNVERIFIED"
        health_entry = topics["telemetry/health"]
        health = health_entry["payload"]
        for suffix in ("telemetry/doa", "telemetry/angular"):
            entry = topics[suffix]
            if entry["status"] != "FRESH":
                continue
            data = entry["payload"]
            if health_entry["status"] != "FRESH" or health_entry["retained"] is not False or not isinstance(health, dict):
                entry["status"], entry["error"] = "STALE", "HEALTH_STALE"
                continue
            sid = data["sid"].lower() if suffix == "telemetry/doa" else f"{data['sid']:08x}"
            revision = data["rev"] if suffix == "telemetry/doa" else data["revision"]
            if (health.get("daq") != 1 or health.get("sid", "").lower() != sid or
                    health.get("rev") != revision or
                    (self._revision_known and self._revision != revision) or
                    (self._state_revision_known and self._state_revision != revision)):
                entry["status"], entry["error"] = "INCONSISTENT", "HEALTH_MISMATCH"
        return {"node_id": self.node_id, "received": self._received, "valid": self._valid,
                "invalid": self._invalid, "last_received_at_ms": self._last_received,
                "topic_counts": dict(self._counts), "topics": topics}
