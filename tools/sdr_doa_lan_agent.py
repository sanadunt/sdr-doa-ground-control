#!/usr/bin/env python3
"""LAN-stage SDR-DoA edge agent.

The agent reads the known Data Out resources, applies the collector health /
freshness / authority gates, and optionally publishes a small MQTT contract.
It is safe-by-default:

* without ``--publish`` it performs no MQTT transport;
* DoA is published only when the collector gate is READY;
* settings control is disabled unless ``--enable-config`` is explicit;
* config changes use an allowlist, revision, expiry, atomic write, read-back,
  and an ACK;
* the agent never forwards raw settings, raw logs, or the angular array;
  angular plot data is local-console observability only.

The MQTT transport uses ``sdr_doa_mqtt_stdlib`` so the Raspberry does not need
an extra Python package. The LAN deployment should still use a broker with
proper authentication, ACLs, and TLS; the local staging broker is not a
production security configuration.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import signal
import sys
import tempfile
import time
from pathlib import Path
from threading import Event
from typing import Any, Dict, List, Mapping, Optional, Sequence

import sdr_doa_collector as collector
import sdr_doa_mqtt as contract
from sdr_doa_mqtt_stdlib import IncomingMessage, Mqtt311Client, MqttProtocolError


DEFAULT_BASE_URL = "http://127.0.0.1:8081"
DEFAULT_MQTT_HOST = "127.0.0.1"
DEFAULT_MQTT_PORT = 18884
DEFAULT_STATE_DIR = ".sdr-doa-edge"
MAX_PENDING_COMMANDS = 32
MAX_COMMAND_JOURNAL = 128
DOA_MAX_QUEUE_AGE_MS = 5_000
CONFIG_RANGES = {
    "center_frequency_hz": (24_000_000.0, 1_800_000_000.0),
    "gain_db": (-100.0, 60.0),
    "vfo_frequency_hz": (24_000_000.0, 1_800_000_000.0),
    "vfo_bandwidth_hz": (100.0, 2_400_000.0),
    "vfo_squelch_db": (-200.0, 20.0),
}


def _safe_number(value: Any, default: Optional[float] = None) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _fresh_candidate(snapshot: Mapping[str, Any]) -> Optional[Mapping[str, Any]]:
    """Return only the collector-selected fresh authority candidate."""
    authority = snapshot.get("authority", {}).get("selected")
    if authority not in {"csv", "xml"}:
        return None
    candidate = (snapshot.get("doa_candidates", {}).get(authority) or {})
    freshness = candidate.get("freshness", {})
    if candidate.get("available") is True and freshness.get("fresh") is True:
        return candidate
    return None


def _safe_config_fingerprint(settings: Mapping[str, Any]) -> str:
    fields = {
        key: settings.get(key)
        for key in (
            "center_freq",
            "uniform_gain",
            "data_interface",
            "doa_method",
            "doa_decorrelation_method",
            "ant_arrangement",
            "active_vfos",
            "output_vfo",
            "vfo_mode",
        )
    }
    return json.dumps(fields, sort_keys=True, separators=(",", ":"), allow_nan=False)


def build_messages(
    snapshot: Dict[str, Any],
    now_ms: Optional[int] = None,
    config_rev: int = 0,
    telemetry_drop_count: int = 0,
) -> Dict[str, Dict[str, Any]]:
    """Build safe contract messages from a collector snapshot.

    Health/state/reported-config describe the node even when acquisition is
    degraded. A numeric DoA message is deliberately absent unless every
    collector publication gate is READY.
    """
    now = int(time.time() * 1000) if now_ms is None else int(now_ms)
    status = snapshot.get("status", {})
    safe_status = status.get("safe", {})
    daq_status = safe_status.get("daq_status") or {}
    settings = snapshot.get("settings", {}).get("fields", {})
    gate = snapshot.get("publication_gate", {})
    daq_ok = status.get("daq_health") == "PASS"
    candidate = _fresh_candidate(snapshot)
    gate_checks = gate.get("checks", {}) if isinstance(gate.get("checks"), Mapping) else {}
    doa_ready = bool(
        candidate
        and gate.get("state") == "READY"
        and gate_checks.get("selected_units_valid") is True
    )
    state_name = "ONLINE" if daq_ok and doa_ready else "DEGRADED"
    if not status.get("available"):
        state_name = "UNAVAILABLE"

    frequency_hz = int(round((_safe_number(settings.get("center_freq"), 0.0) or 0.0) * 1_000_000))
    gain_db = _safe_number(settings.get("uniform_gain"), 0.0) or 0.0
    array = str(settings.get("ant_arrangement") or "unknown")
    method = str(settings.get("doa_method") or "unknown")
    active_vfos = int(_safe_number(settings.get("active_vfos"), 0.0) or 0)
    output_vfo = int(_safe_number(settings.get("output_vfo"), 0.0) or 0)
    source_ts = safe_status.get("timestamp_ms", now)

    messages: Dict[str, Dict[str, Any]] = {}
    doa_age_ms: Optional[int] = None
    if candidate is not None:
        age = candidate.get("freshness", {}).get("age_ms")
        if isinstance(age, (int, float)) and math.isfinite(float(age)):
            doa_age_ms = int(age)

    messages["health"] = contract.build_health(
        ts_ms=int(source_ts),
        state=state_name,
        daq_ok=bool(safe_status.get("daq_ok", False)),
        dropped_frames=int(safe_status.get("daq_num_dropped_frames", 0) or 0),
        gps_status=str(safe_status.get("gps_status") or "unknown"),
        doa_valid=doa_ready,
        doa_age_ms=doa_age_ms,
        frame_sync=daq_status.get("frame_sync"),
        sample_delay_sync=daq_status.get("sample_delay_sync"),
        iq_sync=daq_status.get("iq_sync"),
        uptime_ms=safe_status.get("uptime_ms"),
        telemetry_drop_count=int(telemetry_drop_count),
        settings_available=bool(snapshot.get("settings", {}).get("available") is True),
        settings_valid=collector.settings_are_effective(snapshot.get("settings", {})),
    )
    settings_effective = collector.settings_are_effective(snapshot.get("settings", {}))
    if settings_effective:
        messages["state"] = contract.build_state(
            ts_ms=int(source_ts),
            config_rev=int(config_rev),
            running=bool(daq_ok),
            frequency_hz=frequency_hz,
            gain_db=gain_db,
            array=array,
            method=method,
            active_vfos=active_vfos,
            output_vfo=output_vfo,
        )
        messages["config_reported"] = contract.build_config_reported(
            ts_ms=int(source_ts),
            config_rev=int(config_rev),
            center_frequency_hz=frequency_hz,
            gain_db=gain_db,
            array=array,
            method=method,
            active_vfos=active_vfos,
            output_vfo=output_vfo,
        )
    else:
        # Never replace a retained effective configuration with fabricated zero
        # values after a transient settings read failure.
        messages["health"]["settings_available"] = False
        messages["health"]["settings_valid"] = False
        contract.validate_payload("health", messages["health"])

    if doa_ready and candidate is not None and candidate.get("units_valid") is True:
        canonical_angle = _safe_number(candidate.get("canonical_angle_deg"))
        confidence = _safe_number(candidate.get("confidence"))
        power_db = _safe_number(candidate.get("power_db"))
        normalized_frequency = candidate.get("frequency_hz_normalized")
        processing_ms = candidate.get(
            "processing_time_ms",
            candidate.get("acquisition_frame_latency_ms", 0.0),
        )
        if (
            canonical_angle is not None
            and confidence is not None
            and power_db is not None
            and isinstance(normalized_frequency, int)
        ):
            messages["doa"] = contract.build_doa(
                seq=int(candidate.get("timestamp_ms", now)),
                ts_ms=int(candidate["timestamp_ms"]),
                relative_doa_deg=canonical_angle,
                confidence=confidence,
                power_db=power_db,
                frequency_hz=normalized_frequency,
                processing_ms=_safe_number(processing_ms, 0.0) or 0.0,
                snr_db=_safe_number(candidate.get("snr_db")),
                config_rev=int(config_rev),
                valid=True,
            )
    return messages


class AtomicConfigApplier:
    """Apply the narrow external settings contract to a local settings file."""

    INTERNAL_FIELDS = {
        "center_frequency_hz": "center_freq",
        "gain_db": "uniform_gain",
        "vfo_frequency_hz": "vfo_freq_0",
        "vfo_bandwidth_hz": "vfo_bw_0",
        "vfo_squelch_db": "vfo_squelch_0",
    }

    def __init__(self, settings_path: str, state_dir: str) -> None:
        self.settings_path = Path(settings_path)
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.revision_path = self.state_dir / "config_revision.json"
        self.lock_path = self.state_dir / "config.lock"

    def current_revision(self) -> int:
        try:
            value = json.loads(self.revision_path.read_text(encoding="utf-8"))
            revision = int(value.get("config_rev", 0))
            return max(0, revision)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return 0

    def _write_atomic(self, path: Path, payload: Mapping[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent), text=True)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, sort_keys=True, allow_nan=False)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, path)
        except BaseException:
            try:
                os.unlink(temp_name)
            except OSError:
                pass
            raise

    def apply(self, command: Mapping[str, Any], now_ms: Optional[int] = None) -> Dict[str, Any]:
        now = int(time.time() * 1000) if now_ms is None else int(now_ms)
        command_id = str(command.get("id") or "unknown-command")
        current = self.current_revision()
        base_revision = int(command.get("base_config_rev", -1))
        if int(command.get("expires_ts_ms", 0)) < now:
            return {
                "status": "expired",
                "config_rev": current,
                "readback_ok": False,
                "error": {"code": "COMMAND_EXPIRED"},
            }
        if base_revision != current:
            return {
                "status": "conflict",
                "config_rev": current,
                "readback_ok": False,
                "error": {"code": "CONFIG_REVISION_CONFLICT", "current_config_rev": current},
            }

        changes = command.get("changes")
        if not isinstance(changes, Mapping) or not changes:
            return {
                "status": "rejected",
                "config_rev": current,
                "readback_ok": False,
                "error": {"code": "EMPTY_CHANGES"},
            }
        unknown = sorted(set(changes) - set(self.INTERNAL_FIELDS))
        if unknown:
            return {
                "status": "rejected",
                "config_rev": current,
                "readback_ok": False,
                "error": {"code": "FIELD_NOT_ALLOWED", "fields": unknown},
            }
        if not self.settings_path.is_file():
            return {
                "status": "failed",
                "config_rev": current,
                "readback_ok": False,
                "error": {"code": "SETTINGS_FILE_UNAVAILABLE"},
            }

        try:
            lock_handle = self.lock_path.open("a+", encoding="utf-8")
            try:
                # Best-effort advisory lock on POSIX; absence of fcntl on a
                # non-POSIX test host does not make the file writer unsafe in
                # production, where this agent runs on Linux.
                try:
                    import fcntl

                    fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
                except (ImportError, OSError):
                    pass
                data = json.loads(self.settings_path.read_text(encoding="utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("settings document is not an object")
                desired_internal: Dict[str, Any] = {}
                for external, value in changes.items():
                    number = float(value)
                    desired_internal[self.INTERNAL_FIELDS[external]] = number / 1_000_000 if external == "center_frequency_hz" else number
                data.update(desired_internal)
                data["ext_upd_flag"] = True
                self._write_atomic(self.settings_path, data)
                readback = json.loads(self.settings_path.read_text(encoding="utf-8"))
                readback_ok = all(
                    math.isclose(
                        float(readback.get(internal)),
                        float(value),
                        rel_tol=0.0,
                        abs_tol=1e-6,
                    )
                    for internal, value in desired_internal.items()
                )
                if not readback_ok:
                    return {
                        "status": "failed",
                        "config_rev": current,
                        "readback_ok": False,
                        "error": {"code": "READBACK_MISMATCH"},
                    }
                new_revision = current + 1
                self._write_atomic(self.revision_path, {"config_rev": new_revision, "updated_ts_ms": now})
                return {
                    "status": "applied",
                    "config_rev": new_revision,
                    "readback_ok": True,
                    "error": None,
                }
            finally:
                try:
                    import fcntl

                    fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
                except (ImportError, OSError):
                    pass
                lock_handle.close()
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            return {
                "status": "failed",
                "config_rev": current,
                "readback_ok": False,
                "error": {"code": "APPLY_ERROR", "detail": str(exc)},
            }


class AgentRuntime:
    """Continuous bounded runner for LAN or Raspberry-local operation."""

    def __init__(
        self,
        *,
        base_url: str,
        mqtt_host: str,
        mqtt_port: int,
        publish_enabled: bool,
        config_enabled: bool,
        settings_path: Optional[str],
        state_dir: str,
        clock_source: str,
        health_interval_s: float = 1.0,
        doa_rate_hz: float = 2.0,
        state_interval_s: float = 30.0,
        poll_interval_s: float = 0.05,
        authority: str = "none",
    ) -> None:
        if config_enabled and not publish_enabled:
            raise ValueError("config control requires MQTT publish mode")
        if config_enabled and not settings_path:
            raise ValueError("--settings-path is required when config control is enabled")
        if health_interval_s <= 0 or doa_rate_hz < 0 or state_interval_s <= 0 or poll_interval_s <= 0:
            raise ValueError("intervals must be positive and doa_rate_hz must be non-negative")
        self.base_url = base_url.rstrip("/")
        self.mqtt_host = mqtt_host
        self.mqtt_port = int(mqtt_port)
        self.publish_enabled = publish_enabled
        self.config_enabled = config_enabled
        self.clock_source = clock_source
        self.health_interval_s = float(health_interval_s)
        self.doa_enabled = doa_rate_hz > 0
        self.doa_interval_s = float("inf") if not self.doa_enabled else 1.0 / float(doa_rate_hz)
        self.state_interval_s = float(state_interval_s)
        self.poll_interval_s = float(poll_interval_s)
        self.authority = authority
        self.stop_event = Event()
        self.pending_commands: List[IncomingMessage] = []
        self.command_journal: Dict[str, Dict[str, Any]] = {}
        self.command_fingerprints: Dict[str, str] = {}
        self.client: Optional[Mqtt311Client] = None
        self.config_applier = AtomicConfigApplier(settings_path, state_dir) if settings_path else None
        self.config_rev = self.config_applier.current_revision() if self.config_applier else 0
        self.queue = contract.LatestValueQueue(("doa", "health", "state", "config_reported"))
        self.last_snapshot: Optional[Dict[str, Any]] = None
        self.last_config_fingerprint: Optional[str] = None
        self.last_health_at = 0.0
        self.last_doa_at = 0.0
        self.last_state_at = 0.0
        self.force_state = True
        self.last_error: Optional[str] = None
        self.doa_drop_count = 0
        self.reconnect_delay_s = 1.0
        self.next_connect_at = 0.0

    def request_stop(self, *_args: Any) -> None:
        self.stop_event.set()

    def _on_message(self, message: IncomingMessage) -> None:
        """Accept only authenticated-by-policy command metadata into the queue.

        MQTT metadata is part of the command contract. Validate it before the
        message can reach the apply path; retained commands and non-QoS-1
        deliveries are never replayed after reconnect.
        """
        if message.topic != contract.TOPICS["config_patch"]:
            return
        if not self.config_enabled:
            self.last_error = "CONTROL_DISABLED"
            return
        if message.qos != contract.COMMAND_QOS:
            self.last_error = "COMMAND_QOS_INVALID"
            return
        if message.retain:
            self.last_error = "COMMAND_RETAINED_REJECTED"
            return
        if len(message.payload) > contract.MAX_PAYLOAD_BYTES:
            self.last_error = "COMMAND_PAYLOAD_TOO_LARGE"
            return
        try:
            command = self._validate_incoming_patch(message.payload, now_ms=int(time.time() * 1000))
        except (contract.ContractError, ValueError, TypeError, json.JSONDecodeError):
            self.last_error = "INVALID_COMMAND"
            return
        command_id = command["id"]
        fingerprint = hashlib.sha256(message.payload).hexdigest()
        prior = self.command_journal.get(command_id)
        if prior is not None:
            if prior.get("fingerprint") != fingerprint:
                self.last_error = "COMMAND_REPLAY_CONFLICT"
            else:
                self.last_error = "COMMAND_DUPLICATE"
            return
        if len(self.pending_commands) >= MAX_PENDING_COMMANDS:
            self.last_error = "CONFIG_COMMAND_QUEUE_FULL"
            return
        # Store validated command metadata alongside the original bytes so the
        # apply loop does not have to trust a later mutable decode.
        self.pending_commands.append(
            IncomingMessage(
                topic=message.topic,
                payload=message.payload,
                qos=message.qos,
                retain=message.retain,
                duplicate=message.duplicate,
            )
        )
        self.command_fingerprints[command_id] = fingerprint

    def _validate_incoming_patch(self, payload: bytes, now_ms: Optional[int] = None) -> Dict[str, Any]:
        command = contract.validate_config_patch(
            contract.decode_payload("config_patch", payload),
            now_ms=int(time.time() * 1000) if now_ms is None else now_ms,
        )
        changes = command.get("changes")
        if not isinstance(changes, Mapping) or not changes:
            raise ValueError("changes must be a non-empty object")
        for field, value in changes.items():
            if field not in CONFIG_RANGES:
                raise ValueError("field not allowed")
            number = float(value)
            if not math.isfinite(number):
                raise ValueError("change must be finite")
            low, high = CONFIG_RANGES[field]
            if number < low or number > high:
                raise ValueError("change outside allowed range")
        return command

    def _connect_if_due(self, now_mono: float) -> None:
        if not self.publish_enabled or self.client is not None or now_mono < self.next_connect_at:
            return
        client = Mqtt311Client(
            self.mqtt_host,
            self.mqtt_port,
            client_id="sdr-doa-lan-agent",
            keepalive=30,
            on_message=self._on_message,
        )
        try:
            client.connect()
            if self.config_enabled:
                client.subscribe(contract.TOPICS["config_patch"], qos=1)
            self.client = client
            self.reconnect_delay_s = 1.0
            self.last_error = None
        except (OSError, TimeoutError, MqttProtocolError, ValueError) as exc:
            client.close()
            self.last_error = str(exc)
            self.next_connect_at = now_mono + self.reconnect_delay_s
            self.reconnect_delay_s = min(self.reconnect_delay_s * 2.0, 30.0)

    def _disconnect(self, error: Optional[BaseException] = None) -> None:
        if error is not None:
            self.last_error = str(error)
        if self.client is not None:
            self.client.close()
        self.client = None
        self.next_connect_at = time.monotonic() + self.reconnect_delay_s
        self.reconnect_delay_s = min(self.reconnect_delay_s * 2.0, 30.0)

    def _publish_one(self, kind: str, payload: Mapping[str, Any]) -> None:
        if not self.publish_enabled or self.client is None:
            return
        encoded = contract.compact_json(payload).encode("utf-8")
        qos = contract.STATE_QOS if kind in {"state", "config_reported", "ack_config"} else contract.TELEMETRY_QOS
        retain = kind in {"state", "config_reported"}
        topic = contract.TOPICS[kind]
        self.client.publish(topic, encoded, qos=qos, retain=retain)

    def _drop_queued_doa(self, reason: str) -> None:
        queued = self.queue.pop("doa")
        if queued is not None:
            self.doa_drop_count += 1
            self.last_error = reason

    def _doa_payload_is_current(self, payload: Mapping[str, Any]) -> bool:
        """Reject cached DoA after a disconnect or freshness/gate failure."""
        snapshot = self.last_snapshot or {}
        gate = snapshot.get("publication_gate", {})
        if gate.get("state") != "READY":
            return False
        candidate = _fresh_candidate(snapshot)
        if candidate is None or candidate.get("units_valid") is not True:
            return False
        freshness = candidate.get("freshness", {})
        if freshness.get("fresh") is not True:
            return False
        try:
            payload_ts = int(payload["ts_ms"])
            candidate_ts = int(candidate["timestamp_ms"])
        except (KeyError, TypeError, ValueError):
            return False
        return payload_ts == candidate_ts and int(time.time() * 1000) - payload_ts <= DOA_MAX_QUEUE_AGE_MS

    def _flush_queue(self) -> None:
        if not self.publish_enabled or self.client is None:
            return
        for kind in ("state", "config_reported", "health", "doa"):
            value = self.queue.peek(kind)
            if value is None:
                continue
            if kind == "doa" and not self._doa_payload_is_current(value):
                self._drop_queued_doa("DOA_DROPPED_AFTER_RECONNECT_OR_STALE")
                continue
            # Do not remove a value until the broker-facing publish succeeds.
            # If it raises, the caller disconnects and the value is retried or
            # replaced by a newer latest-value-wins sample.
            self._publish_one(kind, value)
            self.queue.pop_if_same(kind, value)

    def _process_commands(self, now_ms: int) -> None:
        if not self.pending_commands:
            return
        commands, self.pending_commands = self.pending_commands[:], []
        for message in commands:
            if message.topic != contract.TOPICS["config_patch"]:
                continue
            command_id = "unknown-command"
            decoded: Optional[Dict[str, Any]] = None
            try:
                decoded = self._validate_incoming_patch(message.payload)
                command_id = str(decoded["id"])
                if command_id in self.command_journal:
                    prior = self.command_journal[command_id]
                    if self.client is not None:
                        self._publish_one("ack_config", prior)
                    continue
                if not self.config_enabled or self.config_applier is None:
                    result = {
                        "status": "rejected",
                        "config_rev": self.config_rev,
                        "readback_ok": False,
                        "error": {"code": "CONTROL_DISABLED"},
                    }
                else:
                    result = self.config_applier.apply(decoded, now_ms=now_ms)
                    self.config_rev = int(result.get("config_rev", self.config_rev))
                    if result.get("status") == "applied":
                        self.force_state = True
                ack = contract.build_config_ack(
                    command_id=command_id,
                    status=str(result["status"]),
                    ts_ms=now_ms,
                    config_rev=self.config_rev,
                    readback_ok=bool(result.get("readback_ok", False)),
                    error=result.get("error"),
                    changed_fields=(decoded.get("changes", {}).keys() if decoded is not None else None),
                )
                self.command_journal[command_id] = ack
                while len(self.command_journal) > MAX_COMMAND_JOURNAL:
                    self.command_journal.pop(next(iter(self.command_journal)))
                self._publish_one("ack_config", ack)
            except (contract.ContractError, ValueError, TypeError, json.JSONDecodeError) as exc:
                if self.publish_enabled and self.client is not None:
                    ack = contract.build_config_ack(
                        command_id=command_id,
                        status="rejected",
                        ts_ms=now_ms,
                        config_rev=self.config_rev,
                        readback_ok=False,
                        error={"code": "INVALID_COMMAND", "detail": str(exc)},
                    )
                    self.command_journal[command_id] = ack
                    while len(self.command_journal) > MAX_COMMAND_JOURNAL:
                        self.command_journal.pop(next(iter(self.command_journal)))
                    self._publish_one("ack_config", ack)

    def collect_once(self, now_ms: Optional[int] = None) -> Dict[str, Any]:
        observed_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
        snapshot = collector.collect(
            base_url=self.base_url,
            authority=self.authority,
            clock_source=self.clock_source,
        )
        messages = build_messages(snapshot, now_ms=observed_ms, config_rev=self.config_rev)
        settings = snapshot.get("settings", {}).get("fields", {})
        fingerprint = _safe_config_fingerprint(settings)
        now_mono = time.monotonic()
        if now_mono - self.last_health_at >= self.health_interval_s:
            self.queue.put("health", messages["health"])
            self.last_health_at = now_mono
        if self.force_state or fingerprint != self.last_config_fingerprint or now_mono - self.last_state_at >= self.state_interval_s:
            if "state" in messages:
                self.queue.put("state", messages["state"])
            if "config_reported" in messages:
                self.queue.put("config_reported", messages["config_reported"])
            self.last_config_fingerprint = fingerprint
            self.last_state_at = now_mono
            self.force_state = False
        if self.doa_enabled and "doa" in messages and now_mono - self.last_doa_at >= self.doa_interval_s:
            self.queue.put("doa", messages["doa"])
            self.last_doa_at = now_mono
        self.last_snapshot = snapshot
        return {
            "overall_state": snapshot.get("overall_state"),
            "gate_state": snapshot.get("publication_gate", {}).get("state"),
            "gate_reasons": snapshot.get("publication_gate", {}).get("reasons", []),
            "queued_kinds": sorted(self.queue.snapshot()),
            "message_kinds": sorted(messages),
            "config_rev": self.config_rev,
            "publish_enabled": self.publish_enabled,
            "config_enabled": self.config_enabled,
            "raw_settings_omitted": True,
            "raw_angular_values_omitted": True,
            "angular_plot_local_only": True,
        }

    def run_once(self) -> Dict[str, Any]:
        if self.publish_enabled:
            self._connect_if_due(time.monotonic())
        result = self.collect_once()
        if self.publish_enabled:
            self._flush_queue()
        return result

    def run(self, duration_s: Optional[float] = None, max_iterations: Optional[int] = None) -> Dict[str, Any]:
        started = time.monotonic()
        iterations = 0
        last_result: Dict[str, Any] = {}
        while not self.stop_event.is_set():
            now_mono = time.monotonic()
            if duration_s is not None and now_mono - started >= duration_s:
                break
            if max_iterations is not None and iterations >= max_iterations:
                break
            try:
                self._connect_if_due(now_mono)
                if self.client is not None:
                    self.client.poll(timeout=0.0)
                last_result = self.collect_once()
                self._process_commands(int(time.time() * 1000))
                self._flush_queue()
                iterations += 1
            except (OSError, TimeoutError, MqttProtocolError, ValueError, collector.CollectorError) as exc:
                self._disconnect(exc)
            time.sleep(self.poll_interval_s)
        if self.client is not None:
            self.client.close()
            self.client = None
        last_result["iterations"] = iterations
        last_result["elapsed_s"] = round(time.monotonic() - started, 3)
        last_result["last_error"] = self.last_error
        return last_result


def run_once(base_url: str, publish: bool, mqtt_host: str, mqtt_port: int) -> Dict[str, Any]:
    """Backward-compatible one-cycle wrapper for staging callers."""
    runtime = AgentRuntime(
        base_url=base_url,
        mqtt_host=mqtt_host,
        mqtt_port=mqtt_port,
        publish_enabled=publish,
        config_enabled=False,
        settings_path=None,
        state_dir=DEFAULT_STATE_DIR,
        clock_source="remote_unverified",
        health_interval_s=1.0,
        doa_rate_hz=2.0,
        state_interval_s=30.0,
        poll_interval_s=0.05,
    )
    return runtime.run_once()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="LAN-stage SDR-DoA edge agent")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--clock-source", choices=("local", "remote_unverified"), default="local")
    parser.add_argument("--mqtt-host", default=DEFAULT_MQTT_HOST)
    parser.add_argument("--mqtt-port", type=int, default=DEFAULT_MQTT_PORT)
    parser.add_argument("--publish", action="store_true", help="publish to the explicit MQTT broker")
    parser.add_argument("--enable-config", action="store_true", help="enable config_patch apply and ACK handling")
    parser.add_argument("--settings-path", default=None)
    parser.add_argument("--state-dir", default=DEFAULT_STATE_DIR)
    parser.add_argument("--authority", choices=("none", "csv", "xml"), default="none")
    parser.add_argument("--health-interval", type=float, default=1.0)
    parser.add_argument("--doa-rate", type=float, default=2.0)
    parser.add_argument("--state-interval", type=float, default=30.0)
    parser.add_argument("--poll-interval", type=float, default=0.05)
    parser.add_argument("--duration", type=float, default=None)
    parser.add_argument("--iterations", type=int, default=None)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--json-events", action="store_true")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    if not (1 <= args.mqtt_port <= 65_535):
        raise SystemExit("--mqtt-port must be between 1 and 65535")
    if args.enable_config and not args.publish:
        raise SystemExit("--enable-config requires --publish")
    if args.enable_config and not args.settings_path:
        raise SystemExit("--settings-path is required with --enable-config")
    runtime = AgentRuntime(
        base_url=args.base_url,
        mqtt_host=args.mqtt_host,
        mqtt_port=args.mqtt_port,
        publish_enabled=args.publish,
        config_enabled=args.enable_config,
        settings_path=args.settings_path,
        state_dir=args.state_dir,
        clock_source=args.clock_source,
        health_interval_s=args.health_interval,
        doa_rate_hz=args.doa_rate,
        state_interval_s=args.state_interval,
        poll_interval_s=args.poll_interval,
        authority=args.authority,
    )
    signal.signal(signal.SIGINT, runtime.request_stop)
    signal.signal(signal.SIGTERM, runtime.request_stop)
    result = runtime.run_once() if args.once else runtime.run(args.duration, args.iterations)
    if args.json_events or args.once:
        print(json.dumps(result, sort_keys=True, allow_nan=False))
    else:
        print(json.dumps({key: result.get(key) for key in ("iterations", "elapsed_s", "last_error", "gate_state", "overall_state", "publish_enabled")}, sort_keys=True, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
