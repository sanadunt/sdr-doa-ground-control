#!/usr/bin/env python3
"""MQTT contract helpers for staged SDR-DoA telemetry tests.

This module is deliberately transport-light. It builds and validates compact
JSON envelopes, defines the topic contract, and provides a bounded
latest-value-wins queue. It does not connect to a broker by itself.
"""

from __future__ import annotations

import json
import math
import os
import tempfile
import threading
import time
from pathlib import Path
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Mapping, Optional, Tuple

SCHEMA_VERSION = 1
TOPIC_ROOT = "sdr/v1/uav-01"
TOPICS = {
    "doa": f"{TOPIC_ROOT}/telemetry/doa",
    "nav": f"{TOPIC_ROOT}/telemetry/nav",
    "health": f"{TOPIC_ROOT}/telemetry/health",
    "angular": f"{TOPIC_ROOT}/telemetry/angular",
    "spectrum": f"{TOPIC_ROOT}/telemetry/spectrum",
    "state": f"{TOPIC_ROOT}/state",
    "config_reported": f"{TOPIC_ROOT}/config/reported",
    "config_patch": f"{TOPIC_ROOT}/cmd/config/patch",
    "config_get": f"{TOPIC_ROOT}/cmd/config/get",
    "ack_config": f"{TOPIC_ROOT}/ack/config",
    "ack_request": f"{TOPIC_ROOT}/ack/request",
}

TELEMETRY_QOS = 0
STATE_QOS = 1
COMMAND_QOS = 1
MAX_PAYLOAD_BYTES = 16_384
MAX_CONFIG_TTL_MS = 10 * 60 * 1000
MAX_CONFIG_FUTURE_SKEW_MS = 30 * 1000
ACK_ERROR_CODES = frozenset(
    {
        "COMMAND_EXPIRED",
        "COMMAND_FUTURE_DATED",
        "CONFIG_REVISION_CONFLICT",
        "EMPTY_CHANGES",
        "FIELD_NOT_ALLOWED",
        "SETTINGS_FILE_UNAVAILABLE",
        "REMOTE_CONTROL_DISABLED",
        "READBACK_MISMATCH",
        "APPLY_ERROR",
        "CONTROL_DISABLED",
        "INVALID_COMMAND",
        "COMMAND_QUEUE_FULL",
        "COMMAND_REPLAY_CONFLICT",
        "COMMAND_RETAINED",
        "COMMAND_FINGERPRINT_CONFLICT",
        "JOURNAL_UNAVAILABLE",
        "REVISION_UNAVAILABLE",
        "TRANSPORT_UNAVAILABLE",
        "UNAUTHORIZED",
        "PROTOCOL_ERROR",
        "REMOTE_CONTROL_NOT_ENABLED",
        "SETTINGS_WATCHER_UNCONFIRMED",
        "ROLLBACK_FAILED",
        "LOCK_UNAVAILABLE",
        "JOURNAL_WRITE_FAILED",
        "CONFIG_RECOVERY_REQUIRED",
        "RETAINED_COMMAND",
        "WRONG_COMMAND_QOS",
        "COMMAND_REJECTED",
    }
)
CONFIG_RANGES = {
    "center_frequency_hz": (24_000_000.0, 1_800_000_000.0),
    "gain_db": (-100.0, 60.0),
    "vfo_frequency_hz": (24_000_000.0, 1_800_000_000.0),
    "vfo_bandwidth_hz": (100.0, 2_400_000.0),
    "vfo_squelch_db": (-200.0, 20.0),
}


class ContractError(ValueError):
    """Raised when a payload violates the staged MQTT contract."""


def _number(value: Any, field: str, *, integer: bool = False) -> float | int:
    """Accept JSON numbers only; never coerce strings or booleans."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ContractError(f"{field} must be a JSON number")
    if isinstance(value, int):
        number: float | int = value
    else:
        if not math.isfinite(value):
            raise ContractError(f"{field} must be finite")
        number = value
    if isinstance(number, float) and not math.isfinite(number):
        raise ContractError(f"{field} must be finite")
    if integer:
        if isinstance(number, int):
            return number
        if not number.is_integer():
            raise ContractError(f"{field} must be an integer")
        return int(number)
    return number


def _bounded(value: Any, field: str, low: float, high: float) -> float:
    number = float(_number(value, field))
    if number < low or number > high:
        raise ContractError(f"{field} outside [{low:g}, {high:g}]")
    return number


def compact_json(payload: Mapping[str, Any]) -> str:
    """Serialize a bounded contract payload without non-finite numbers."""
    try:
        encoded = json.dumps(dict(payload), separators=(",", ":"), allow_nan=False, sort_keys=True)
    except (TypeError, ValueError) as exc:
        raise ContractError(f"payload is not compact JSON-safe: {exc}") from exc
    if len(encoded.encode("utf-8")) > MAX_PAYLOAD_BYTES:
        raise ContractError("payload exceeds maximum size")
    return encoded


def _safe_ack_error(error: Optional[Mapping[str, Any]]) -> Optional[Dict[str, Any]]:
    """Reduce command errors to bounded code-only ACK data."""
    if error is None:
        return None
    raw_code = error.get("code") if isinstance(error, Mapping) else None
    code = raw_code if isinstance(raw_code, str) and raw_code in ACK_ERROR_CODES else "COMMAND_REJECTED"
    safe: Dict[str, Any] = {"code": code}
    current = error.get("current_config_rev") if isinstance(error, Mapping) else None
    if isinstance(current, int) and not isinstance(current, bool) and current >= 0:
        safe["current_config_rev"] = current
    return safe


def _base(ts_ms: Optional[int] = None) -> Dict[str, Any]:
    timestamp = int(time.time() * 1000) if ts_ms is None else int(_number(ts_ms, "ts_ms", integer=True))
    return {"v": SCHEMA_VERSION, "ts_ms": timestamp}


def build_doa(
    *,
    seq: int,
    ts_ms: int,
    relative_doa_deg: float,
    confidence: float,
    power_db: float,
    frequency_hz: int,
    processing_ms: float,
    snr_db: Optional[float] = None,
    config_rev: Optional[int] = None,
    valid: bool = True,
) -> Dict[str, Any]:
    payload = _base(ts_ms)
    payload.update(
        {
            "seq": int(_number(seq, "seq", integer=True)),
            "valid": bool(valid),
            "relative_doa_deg": round(_bounded(relative_doa_deg, "relative_doa_deg", 0.0, 360.0), 3),
            "confidence": round(_bounded(confidence, "confidence", 0.0, 1.0), 6),
            "power_db": round(float(_number(power_db, "power_db")), 3),
            "frequency_hz": int(_number(frequency_hz, "frequency_hz", integer=True)),
            "processing_ms": round(float(_number(processing_ms, "processing_ms")), 3),
        }
    )
    if snr_db is not None:
        payload["snr_db"] = round(float(_number(snr_db, "snr_db")), 3)
    if config_rev is not None:
        payload["config_rev"] = int(_number(config_rev, "config_rev", integer=True))
    validate_payload("doa", payload)
    return payload


def build_nav(
    *,
    seq: int,
    ts_ms: int,
    lat: float,
    lon: float,
    heading_deg: Optional[float] = None,
    speed_mps: Optional[float] = None,
    altitude_m: Optional[float] = None,
    source: str = "unknown",
) -> Dict[str, Any]:
    payload = _base(ts_ms)
    payload.update(
        {
            "seq": int(_number(seq, "seq", integer=True)),
            "lat": round(_bounded(lat, "lat", -90.0, 90.0), 7),
            "lon": round(_bounded(lon, "lon", -180.0, 180.0), 7),
            "source": str(source),
        }
    )
    if heading_deg is not None:
        payload["heading_deg"] = round(_bounded(heading_deg, "heading_deg", 0.0, 360.0), 3)
    if speed_mps is not None:
        payload["speed_mps"] = round(_bounded(speed_mps, "speed_mps", 0.0, 2000.0), 3)
    if altitude_m is not None:
        payload["altitude_m"] = round(float(_number(altitude_m, "altitude_m")), 3)
    validate_payload("nav", payload)
    return payload


def build_health(
    *,
    ts_ms: int,
    state: str,
    daq_ok: bool,
    dropped_frames: int,
    gps_status: str,
    doa_valid: bool,
    doa_age_ms: Optional[int],
    frame_sync: Optional[bool] = None,
    sample_delay_sync: Optional[bool] = None,
    iq_sync: Optional[bool] = None,
    uptime_ms: Optional[int] = None,
    telemetry_drop_count: Optional[int] = None,
    settings_available: Optional[bool] = None,
    settings_valid: Optional[bool] = None,
) -> Dict[str, Any]:
    payload = _base(ts_ms)
    payload.update(
        {
            "state": str(state),
            "daq_ok": bool(daq_ok),
            "dropped_frames": int(_number(dropped_frames, "dropped_frames", integer=True)),
            "gps_status": str(gps_status),
            "doa_valid": bool(doa_valid),
            "doa_age_ms": None if doa_age_ms is None else int(_number(doa_age_ms, "doa_age_ms", integer=True)),
        }
    )
    for field, value in (
        ("frame_sync", frame_sync),
        ("sample_delay_sync", sample_delay_sync),
        ("iq_sync", iq_sync),
    ):
        if value is not None:
            payload[field] = bool(value)
    if uptime_ms is not None:
        payload["uptime_ms"] = int(_number(uptime_ms, "uptime_ms", integer=True))
    if telemetry_drop_count is not None:
        payload["telemetry_drop_count"] = int(_number(telemetry_drop_count, "telemetry_drop_count", integer=True))
    for field, value in (("settings_available", settings_available), ("settings_valid", settings_valid)):
        if value is not None:
            if not isinstance(value, bool):
                raise ContractError(f"{field} must be boolean")
            payload[field] = value
    validate_payload("health", payload)
    return payload


def build_state(
    *,
    ts_ms: int,
    config_rev: int,
    running: bool,
    frequency_hz: int,
    gain_db: float,
    array: str,
    method: str,
    active_vfos: int,
    output_vfo: int = 0,
) -> Dict[str, Any]:
    payload = _base(ts_ms)
    payload.update(
        {
            "config_rev": int(_number(config_rev, "config_rev", integer=True)),
            "running": bool(running),
            "frequency_hz": int(_number(frequency_hz, "frequency_hz", integer=True)),
            "gain_db": round(float(_number(gain_db, "gain_db")), 3),
            "array": str(array),
            "method": str(method),
            "active_vfos": int(_number(active_vfos, "active_vfos", integer=True)),
            "output_vfo": int(_number(output_vfo, "output_vfo", integer=True)),
        }
    )
    validate_payload("state", payload)
    return payload


def build_config_reported(
    *,
    ts_ms: int,
    config_rev: int,
    center_frequency_hz: int,
    gain_db: float,
    array: str,
    method: str,
    active_vfos: int,
    output_vfo: int = 0,
) -> Dict[str, Any]:
    """Build the safe, redacted effective-configuration snapshot."""
    payload = _base(ts_ms)
    payload.update(
        {
            "config_rev": int(_number(config_rev, "config_rev", integer=True)),
            "center_frequency_hz": int(_number(center_frequency_hz, "center_frequency_hz", integer=True)),
            "gain_db": round(float(_number(gain_db, "gain_db")), 3),
            "array": str(array),
            "method": str(method),
            "active_vfos": int(_number(active_vfos, "active_vfos", integer=True)),
            "output_vfo": int(_number(output_vfo, "output_vfo", integer=True)),
        }
    )
    validate_payload("config_reported", payload)
    return payload


def build_config_patch(
    *,
    command_id: str,
    base_config_rev: int,
    changes: Mapping[str, Any],
    issued_ts_ms: int,
    expires_ts_ms: int,
) -> Dict[str, Any]:
    if not command_id or not isinstance(command_id, str) or len(command_id) > 128:
        raise ContractError("id must be a non-empty string")
    if not isinstance(changes, Mapping) or not changes:
        raise ContractError("changes must be a non-empty object")
    normalized: Dict[str, Any] = {}
    for field, value in changes.items():
        if field not in CONFIG_RANGES:
            raise ContractError(f"field not allowed: {field}")
        number = _bounded(value, field, *CONFIG_RANGES[field])
        normalized[field] = int(number) if number.is_integer() else round(number, 3)
    issued = int(_number(issued_ts_ms, "issued_ts_ms", integer=True))
    expires = int(_number(expires_ts_ms, "expires_ts_ms", integer=True))
    if expires <= issued:
        raise ContractError("expires_ts_ms must be after issued_ts_ms")
    if expires - issued > MAX_CONFIG_TTL_MS:
        raise ContractError("config patch TTL exceeds maximum")
    base_revision = int(_number(base_config_rev, "base_config_rev", integer=True))
    if base_revision < 0:
        raise ContractError("base_config_rev must be non-negative")
    payload = {
        "v": SCHEMA_VERSION,
        "id": command_id,
        "type": "config_patch",
        "base_config_rev": base_revision,
        "issued_ts_ms": issued,
        "expires_ts_ms": expires,
        "changes": normalized,
    }
    validate_payload("config_patch", payload)
    return payload


def build_config_ack(
    *,
    command_id: str,
    status: str,
    ts_ms: int,
    config_rev: int,
    readback_ok: bool,
    error: Optional[Mapping[str, Any]] = None,
    changed_fields: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    """Build an explicit settings-command acknowledgement."""
    allowed_statuses = {"received", "rejected", "expired", "conflict", "applying", "applied", "failed"}
    if status not in allowed_statuses:
        raise ContractError(f"invalid config ACK status: {status}")
    if not isinstance(command_id, str) or not command_id:
        raise ContractError("ack id must be a non-empty string")
    payload = _base(ts_ms)
    payload.update(
        {
            "id": command_id,
            "status": status,
            "config_rev": int(_number(config_rev, "config_rev", integer=True)),
            "readback_ok": bool(readback_ok),
            "error": _safe_ack_error(error),
        }
    )
    # Never echo command values into an ACK. Field names are sufficient for
    # operator observability and cannot disclose a supplied secret-like value.
    if changed_fields is not None:
        raw_fields = list(changed_fields)
        if len(raw_fields) > 16 or any(not isinstance(field, str) or not field for field in raw_fields):
            raise ContractError("changed_fields is invalid")
        fields = sorted(set(raw_fields))
        if any(field not in CONFIG_RANGES for field in fields):
            raise ContractError("changed_fields contains an unknown field")
        payload["changed_fields"] = fields
    validate_payload("ack_config", payload)
    return payload


def validate_payload(kind: str, payload: Mapping[str, Any]) -> None:
    if not isinstance(payload, Mapping):
        raise ContractError(f"{kind} payload must be an object")
    if payload.get("v") != SCHEMA_VERSION:
        raise ContractError(f"{kind}.v must be {SCHEMA_VERSION}")
    required = {
        "doa": ("seq", "ts_ms", "relative_doa_deg", "confidence", "power_db", "frequency_hz", "processing_ms"),
        "nav": ("seq", "ts_ms", "lat", "lon", "source"),
        "health": ("ts_ms", "state", "daq_ok", "dropped_frames", "gps_status", "doa_valid", "doa_age_ms"),
        "state": ("ts_ms", "config_rev", "running", "frequency_hz", "gain_db", "array", "method", "active_vfos", "output_vfo"),
        "config_reported": ("ts_ms", "config_rev", "center_frequency_hz", "gain_db", "array", "method", "active_vfos", "output_vfo"),
        "config_patch": ("v", "id", "type", "base_config_rev", "issued_ts_ms", "expires_ts_ms", "changes"),
        "ack_config": ("ts_ms", "id", "status", "config_rev", "readback_ok", "error"),
    }
    if kind not in required:
        raise ContractError(f"unknown payload kind: {kind}")
    missing = [field for field in required[kind] if field not in payload]
    if missing:
        raise ContractError(f"{kind} missing fields: {','.join(missing)}")
    allowed = {
        "doa": {"v", "ts_ms", "seq", "valid", "relative_doa_deg", "confidence", "power_db", "frequency_hz", "processing_ms", "snr_db", "config_rev"},
        "nav": {"v", "ts_ms", "seq", "lat", "lon", "source", "heading_deg", "speed_mps", "altitude_m"},
        "health": {"v", "ts_ms", "state", "daq_ok", "dropped_frames", "gps_status", "doa_valid", "doa_age_ms", "frame_sync", "sample_delay_sync", "iq_sync", "uptime_ms", "telemetry_drop_count", "settings_available", "settings_valid"},
        "state": {"v", "ts_ms", "config_rev", "running", "frequency_hz", "gain_db", "array", "method", "active_vfos", "output_vfo"},
        "config_reported": {"v", "ts_ms", "config_rev", "center_frequency_hz", "gain_db", "array", "method", "active_vfos", "output_vfo"},
        "config_patch": {"v", "id", "type", "base_config_rev", "issued_ts_ms", "expires_ts_ms", "changes"},
        "ack_config": {"v", "ts_ms", "id", "status", "config_rev", "readback_ok", "error", "changed_fields"},
    }
    unknown = sorted(set(payload) - allowed[kind])
    if unknown:
        raise ContractError(f"{kind} unknown fields: {','.join(unknown)}")
    def require_int(field: str, minimum: Optional[int] = None) -> int:
        value = payload[field]
        if isinstance(value, bool) or not isinstance(value, int):
            raise ContractError(f"{kind}.{field} must be an integer")
        if minimum is not None and value < minimum:
            raise ContractError(f"{kind}.{field} is below minimum")
        return value
    def require_bool(field: str) -> None:
        if not isinstance(payload[field], bool):
            raise ContractError(f"{kind}.{field} must be boolean")
    def require_text(field: str) -> None:
        value = payload[field]
        if not isinstance(value, str) or not value or len(value) > 256:
            raise ContractError(f"{kind}.{field} must be a bounded non-empty string")
    if kind != "config_patch":
        require_int("ts_ms", 0)
    if kind in {"doa", "nav"}:
        require_int("seq", 0)
    if kind == "doa":
        require_bool("valid")
        _bounded(payload["relative_doa_deg"], "relative_doa_deg", 0.0, 360.0)
        _bounded(payload["confidence"], "confidence", 0.0, 1.0)
        _number(payload["power_db"], "power_db")
        require_int("frequency_hz", 0)
        _bounded(payload["processing_ms"], "processing_ms", 0.0, 86_400_000.0)
        if "snr_db" in payload:
            _number(payload["snr_db"], "snr_db")
        if "config_rev" in payload:
            require_int("config_rev", 0)
    elif kind == "nav":
        _bounded(payload["lat"], "lat", -90.0, 90.0)
        _bounded(payload["lon"], "lon", -180.0, 180.0)
        require_text("source")
        if "heading_deg" in payload:
            _bounded(payload["heading_deg"], "heading_deg", 0.0, 360.0)
        if "speed_mps" in payload:
            _bounded(payload["speed_mps"], "speed_mps", 0.0, 2000.0)
        if "altitude_m" in payload:
            _number(payload["altitude_m"], "altitude_m")
    elif kind == "health":
        require_text("state")
        require_bool("daq_ok")
        require_int("dropped_frames", 0)
        require_text("gps_status")
        require_bool("doa_valid")
        age = payload["doa_age_ms"]
        if age is not None:
            if isinstance(age, bool) or not isinstance(age, int) or age < 0:
                raise ContractError("health.doa_age_ms must be null or a non-negative integer")
        for field in ("frame_sync", "sample_delay_sync", "iq_sync"):
            if field in payload:
                require_bool(field)
        if "uptime_ms" in payload:
            require_int("uptime_ms", 0)
    elif kind in {"state", "config_reported"}:
        require_int("config_rev", 0)
        require_int("frequency_hz" if kind == "state" else "center_frequency_hz", 0)
        _number(payload["gain_db"], "gain_db")
        require_text("array")
        require_text("method")
        require_int("active_vfos", 0)
        require_int("output_vfo", 0)
        if kind == "state":
            require_bool("running")
    elif kind == "config_patch":
        require_text("id")
        if len(payload["id"]) > 128:
            raise ContractError("config_patch.id is too long")
        if not isinstance(payload["type"], str) or payload["type"] != "config_patch":
            raise ContractError("config_patch.type must be config_patch")
        require_int("base_config_rev", 0)
        issued = require_int("issued_ts_ms", 0)
        expires = require_int("expires_ts_ms", 0)
        if expires <= issued:
            raise ContractError("config_patch expiry must be after issue time")
        if expires - issued > MAX_CONFIG_TTL_MS:
            raise ContractError("config_patch TTL exceeds maximum")
        changes = payload["changes"]
        if not isinstance(changes, Mapping) or not changes:
            raise ContractError("config_patch.changes must be a non-empty object")
        if len(changes) > len(CONFIG_RANGES):
            raise ContractError("config_patch has too many fields")
        for field, value in changes.items():
            if field not in CONFIG_RANGES:
                raise ContractError(f"field not allowed: {field}")
            _bounded(value, field, *CONFIG_RANGES[field])
    elif kind == "ack_config":
        require_text("id")
        if payload["status"] not in {"received", "rejected", "expired", "conflict", "applying", "applied", "failed"}:
            raise ContractError("ack_config.status is invalid")
        require_int("config_rev", 0)
        require_bool("readback_ok")
        if payload["error"] is not None and not isinstance(payload["error"], Mapping):
            raise ContractError("ack_config.error must be null or an object")
        if payload["error"] is not None:
            error = payload["error"]
            if set(error) - {"code", "current_config_rev"}:
                raise ContractError("ack_config.error has unsupported fields")
            code = error.get("code")
            if not isinstance(code, str) or code not in ACK_ERROR_CODES:
                raise ContractError("ack_config.error.code is invalid")
            if "current_config_rev" in error:
                current = error["current_config_rev"]
                if isinstance(current, bool) or not isinstance(current, int) or current < 0:
                    raise ContractError("ack_config.error.current_config_rev is invalid")
        if "changed_fields" in payload:
            fields = payload["changed_fields"]
            if (
                not isinstance(fields, list)
                or len(fields) > 16
                or len(set(fields)) != len(fields)
                or any(not isinstance(field, str) or field not in CONFIG_RANGES for field in fields)
            ):
                raise ContractError("ack_config.changed_fields is invalid")
    compact_json(payload)


def decode_payload(kind: str, raw: bytes | str) -> Dict[str, Any]:
    if isinstance(raw, bytes) and len(raw) > MAX_PAYLOAD_BYTES:
        raise ContractError("payload exceeds maximum size")
    if isinstance(raw, str) and len(raw.encode("utf-8")) > MAX_PAYLOAD_BYTES:
        raise ContractError("payload exceeds maximum size")
    if not isinstance(raw, (bytes, str)):
        raise ContractError("payload must be bytes or text")
    try:
        payload = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError("invalid JSON") from exc
    validate_payload(kind, payload)
    return dict(payload)


def validate_config_patch(payload: Mapping[str, Any], now_ms: Optional[int] = None) -> Dict[str, Any]:
    """Validate a config patch, including its clock-bound lifetime."""
    validate_payload("config_patch", payload)
    result = dict(payload)
    if now_ms is None:
        return result
    now = int(_number(now_ms, "now_ms", integer=True))
    issued = int(result["issued_ts_ms"])
    expires = int(result["expires_ts_ms"])
    if issued > now + MAX_CONFIG_FUTURE_SKEW_MS:
        raise ContractError("config patch issued time is too far in the future")
    if expires <= now:
        raise ContractError("config patch has expired")
    return result


@dataclass
class QueueStats:
    accepted: int = 0
    replaced: int = 0
    popped: int = 0


class LatestValueQueue:
    """One-slot-per-stream queue that replaces old telemetry values."""

    def __init__(self, streams: Iterable[str]) -> None:
        self._values: Dict[str, Any] = {}
        self.stats = QueueStats()
        self._streams = set(streams)
        self._lock = threading.RLock()

    def put(self, stream: str, value: Any) -> None:
        with self._lock:
            if stream not in self._streams:
                raise KeyError(stream)
            if stream in self._values:
                self.stats.replaced += 1
            self._values[stream] = value
            self.stats.accepted += 1

    def peek(self, stream: str) -> Any:
        with self._lock:
            if stream not in self._streams:
                raise KeyError(stream)
            return self._values.get(stream)

    def pop(self, stream: str) -> Any:
        with self._lock:
            if stream not in self._streams:
                raise KeyError(stream)
            value = self._values.pop(stream, None)
            if value is not None:
                self.stats.popped += 1
            return value

    def pop_if_same(self, stream: str, expected: Any) -> bool:
        with self._lock:
            if stream not in self._streams:
                raise KeyError(stream)
            if stream not in self._values or self._values[stream] != expected:
                return False
            self._values.pop(stream)
            self.stats.popped += 1
            return True

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self._values)

    def __len__(self) -> int:
        with self._lock:
            return len(self._values)


KIND_BY_TOPIC_SUFFIX = {
    "/telemetry/doa": "doa",
    "/telemetry/nav": "nav",
    "/telemetry/health": "health",
    "/state": "state",
    "/config/reported": "config_reported",
    "/cmd/config/patch": "config_patch",
    "/ack/config": "ack_config",
}


def kind_for_topic(topic: str) -> Optional[str]:
    for suffix, kind in KIND_BY_TOPIC_SUFFIX.items():
        if topic.endswith(suffix):
            return kind
    return None


if __name__ == "__main__":
    sample = build_doa(
        seq=1,
        ts_ms=1_000,
        relative_doa_deg=137.4,
        confidence=0.923,
        power_db=-54.2,
        frequency_hz=433_920_000,
        processing_ms=12,
    )
    print(compact_json(sample))
