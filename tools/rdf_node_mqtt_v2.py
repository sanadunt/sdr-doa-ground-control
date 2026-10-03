"""Bounded, read-only validator/store for RDF Node MQTT v2 telemetry."""
from __future__ import annotations

import json
import math
import re
import struct
import uuid
from dataclasses import dataclass, field
from typing import Any

RDF_NODE_V2_SUFFIXES: tuple[str, ...] = (
    "telemetry/doa", "telemetry/health", "telemetry/health/detail", "telemetry/angular",
    "state", "capabilities", "config/reported", "availability", "ack/config", "ack/operation",
)
_JSON_LIMIT = 16384
_ANGULAR_LIMIT = 420
_HEADER = struct.Struct("<4sBBHIIQIIBBHffHh")
_ENVELOPE = struct.Struct("<IIBBH")
_NODE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_SID_RE = re.compile(r"^[0-9a-fA-F]{8}$")

_FIELDS = {
    "telemetry/doa": ("v", "sid", "q", "t", "f", "a", "c", "p", "rev", "ok"),
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


def _safe_ack_value(value: Any, depth: int = 0) -> Any:
    if depth > 4:
        return None
    if value is None or type(value) in (bool, int, float):
        return value if not isinstance(value, float) or math.isfinite(value) else None
    if isinstance(value, str):
        return value[:256]
    if isinstance(value, list):
        return [_safe_ack_value(item, depth + 1) for item in value[:32]]
    if isinstance(value, dict):
        return {key: _safe_ack_value(item, depth + 1) for key, item in list(value.items())[:32]
                if key in _SAFE_ACK_RESULT_FIELDS and not any(word in key.lower() for word in ("challenge", "secret", "password", "token", "credential", "private"))}
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
        self._assemblies: dict[tuple[int, int], _Assembly] = {}
        self._angular_last_q: int | None = None

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {"status": "UNAVAILABLE", "received_at_ms": None, "qos": None,
                "retained": None, "payload": None, "error": None}

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
        if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError("INVALID_FIELD")
        return value

    @staticmethod
    def _uuid(data: dict[str, Any], key: str) -> None:
        try:
            if str(uuid.UUID(data.get(key, ""))) != data[key].lower():
                raise ValueError
        except (ValueError, AttributeError, TypeError):
            raise ValueError("INVALID_IDENTITY") from None

    def _validate_json(self, suffix: str, raw: bytes) -> dict[str, Any]:
        try:
            value = json.loads(raw.decode("utf-8"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError("NONFINITE")))
        except Exception as exc:
            raise ValueError("NONFINITE" if str(exc) == "NONFINITE" else "MALFORMED_JSON") from None
        if not isinstance(value, dict):
            raise ValueError("INVALID_ENVELOPE")
        try:
            data = self._safe(value)
        except RecursionError:
            raise ValueError("INVALID_DEPTH") from None
        except ValueError as exc:
            raise ValueError(str(exc) if str(exc) == "NONFINITE" else "INVALID_VALUE") from None
        if type(data.get("v")) is not int or data["v"] != 2:
            raise ValueError("INVALID_VERSION")
        if not isinstance(data.get("sid"), str) or not _SID_RE.fullmatch(data["sid"]):
            raise ValueError("INVALID_IDENTITY")
        if suffix == "capabilities":
            if "t" in data:
                self._integer(data, "t", 1)
        else:
            self._integer(data, "t", 1)
        if suffix in ("telemetry/doa", "telemetry/health"):
            self._integer(data, "q", 0, 0xffffffff)
        if suffix == "telemetry/doa":
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
            if sync is not None and (not isinstance(sync, list) or len(sync) != 3 or any(x is not None and type(x) is not bool for x in sync)):
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
            for item in effective.values():
                if item is not None and type(item) not in (str, bool, int, float):
                    raise ValueError("INVALID_FIELD")
                if isinstance(item, str) and len(item) > 128:
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
        normalized = {key: data[key] for key in _FIELDS[suffix] if key in data}
        if suffix == "config/reported":
            normalized["effective"] = {key: data["effective"][key] for key in _SAFE_EFFECTIVE_FIELDS if key in data["effective"]}
        if suffix in ("ack/config", "ack/operation"):
            for key in ("result", "error"):
                if key in data:
                    normalized[key] = _safe_ack_value(data[key])
        return normalized

    def _clear_session_telemetry(self, *, reset_sequences: bool = False) -> None:
        for suffix in ("telemetry/health", "telemetry/doa", "telemetry/angular"):
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

    def _angular(self, raw: bytes, received_at_ms: int) -> tuple[dict[str, Any] | None, str | None, bool]:
        if len(raw) > _ANGULAR_LIMIT:
            return None, "PAYLOAD_TOO_LARGE", False
        if len(raw) < _ENVELOPE.size:
            return None, "INVALID_CHUNK", False
        sid, q, index, count, total = _ENVELOPE.unpack_from(raw)
        body = raw[_ENVELOPE.size:]
        if count == 0 or count > 16 or index >= count or total < _HEADER.size or total > 768 or not body or len(body) > total:
            return None, "INVALID_CHUNK", False
        key = (sid, q)
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
            if magic != b"RDF2" or version != 2 or encoding not in (1, 2) or flags != 31 or fsid != sid or fq != q or sample_count != 360:
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
            if any(not math.isfinite(x) for x in values) or not 0 <= frequency <= 10**12 or timestamp <= 0 or vfo > 255 or convention > 255:
                raise ValueError
            return ({"encoding": "q16" if encoding == 1 else "u8", "sid": sid, "q": q,
                     "timestamp_ms": timestamp, "frequency_hz": frequency,
                     "revision": None if revision == 0xffffffff else revision,
                     "vfo": vfo, "convention": convention,
                     "raw_doa_deg": None if raw_doa == 65535 else raw_doa / 100,
                     "confidence_native_db": None if confidence == -32768 else confidence / 100,
                     "values": values}, None, False)
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

        def store(status: str, value: Any = None, error: str | None = None) -> None:
            self._topics[suffix] = {"status": status, "received_at_ms": received_at_ms,
                                    "qos": qos, "retained": retained, "payload": value, "error": error}

        if qos != expected_qos or retained != should_retain:
            self._invalid += 1
            store("INVALID", error="BROKER_POLICY")
            return
        if suffix == "telemetry/angular":
            value, error, pending = self._angular(payload, received_at_ms)
            if error:
                self._invalid += 1
                store("INVALID", error=error)
                return
            if pending or value is None:
                return
            self._valid += 1
            if self._angular_last_q is not None and value["q"] <= self._angular_last_q:
                store("INCONSISTENT", value, "SEQUENCE_REGRESSION")
                return
            self._angular_last_q = value["q"]
            sid_text = f"{value['sid']:08x}"
            health = self._topics["telemetry/health"]["payload"]
            session_ok = self._session is None or self._session[0] == sid_text
            revision_ok = not self._revision_known or value["revision"] == self._revision
            if not session_ok or not revision_ok:
                store("INCONSISTENT", value, "IDENTITY_MISMATCH")
                return
            self._set_session({"sid": sid_text})
            if not isinstance(health, dict) or not self._health_fresh(received_at_ms) or health.get("daq") != 1 or health.get("sid", "").lower() != sid_text or health.get("rev") != value["revision"]:
                store("INCONSISTENT", value, "HEALTH_MISMATCH")
                return
            age = received_at_ms - value["timestamp_ms"]
            store("FRESH" if 0 <= age <= 10000 else "STALE", value, None if 0 <= age <= 10000 else "SOURCE_STALE")
            return
        if len(payload) > _JSON_LIMIT:
            self._invalid += 1
            store("INVALID", error="PAYLOAD_TOO_LARGE")
            return
        try:
            value = self._validate_json(suffix, payload)
        except ValueError as exc:
            self._invalid += 1
            store("INVALID", error=str(exc) if re.fullmatch(r"[A-Z_]{1,32}", str(exc)) else "INVALID_PAYLOAD")
            return
        self._valid += 1
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
            doa = self._topics["telemetry/doa"]["payload"]
            if ((not self._revision_known and isinstance(doa, dict) and doa.get("rev") != revision) or
                    (self._revision_known and revision != self._revision)):
                self._clear_session_telemetry()
            self._revision, self._revision_known = revision, True
        elif suffix == "state" and self._revision_known and value.get("cfg") != self._revision:
            self._clear_session_telemetry()
        if suffix in ("telemetry/health", "telemetry/doa"):
            sequence = value["q"]
            previous = self._seq.get(suffix)
            if previous is not None and sequence <= previous:
                store("INCONSISTENT", value, "SEQUENCE_REGRESSION")
                return
            self._seq[suffix] = sequence
        if suffix == "telemetry/health":
            age = received_at_ms - value["t"]
            if retained:
                store("CONTEXT", value)
            else:
                store("FRESH" if 0 <= age <= 8000 else "STALE", value, None if 0 <= age <= 8000 else "SOURCE_STALE")
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
        topics = {suffix: dict(entry) for suffix, entry in self._topics.items()}
        for suffix in ("telemetry/health", "telemetry/doa", "telemetry/angular"):
            entry = topics[suffix]
            received = entry["received_at_ms"]
            if entry["status"] != "FRESH" or received is None:
                continue
            max_age = 8000 if suffix == "telemetry/health" else 5000 if suffix == "telemetry/doa" else 10000
            data = entry["payload"]
            source = data.get("t", data.get("timestamp_ms")) if isinstance(data, dict) else None
            if (now_ms < received or now_ms - received > max_age or not isinstance(source, int) or
                    now_ms < source or now_ms - source > max_age):
                entry["status"], entry["error"] = "STALE", "SOURCE_STALE"
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
                    (self._revision_known and self._revision != revision)):
                entry["status"], entry["error"] = "INCONSISTENT", "HEALTH_MISMATCH"
        return {"node_id": self.node_id, "received": self._received, "valid": self._valid,
                "invalid": self._invalid, "last_received_at_ms": self._last_received,
                "topic_counts": dict(self._counts), "topics": topics}
