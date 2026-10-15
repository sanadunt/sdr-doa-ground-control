#!/usr/bin/env python3
"""LAN-stage SDR-DoA edge agent.

The agent reads the known Data Out resources, applies the collector health /
freshness / authority gates, and optionally publishes a small MQTT contract.
It is safe-by-default:

* without ``--publish`` it performs no MQTT transport;
* DoA is published only when the collector gate is READY;
* settings control is disabled unless ``--enable-config`` is explicit; with
  ``--publish`` alone the agent still subscribes to ``cmd/config/patch`` and
  answers every patch with a ``REMOTE_CONTROL_DISABLED`` rejection ACK;
* config changes use an allowlist, revision, expiry, atomic write, read-back,
  and an ACK (rejected commands are ACKed with a contract error code);
* the agent never forwards raw settings, raw logs, or the angular array;
  angular plot data is local-console observability only.

Node health (``health.state``) describes the node itself: ONLINE, STALE,
DEGRADED or UNAVAILABLE, with bounded reason codes. DoA publication readiness
is reported separately in ``health.doa_valid``.

The MQTT transport uses ``sdr_doa_mqtt_stdlib`` so the Raspberry does not need
an extra Python package. A non-loopback broker requires TLS and a username
(``--mqtt-cafile``/``--mqtt-tls``, ``--mqtt-username``, password in the
``SDR_DOA_MQTT_PASSWORD`` environment variable). The local staging broker is
not a production security configuration.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import signal
import ssl
import sys
import tempfile
import time
from pathlib import Path
from threading import Event
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, TextIO, Tuple

import sdr_doa_collector as collector
import sdr_doa_mqtt as contract
from sdr_doa_mqtt_stdlib import (
    IncomingMessage,
    Mqtt311Client,
    MqttProtocolError,
    WillMessage,
    create_default_tls_context,
)


DEFAULT_BASE_URL = "http://127.0.0.1:8081"
DEFAULT_MQTT_HOST = "127.0.0.1"
DEFAULT_MQTT_PORT = 18884
DEFAULT_STATE_DIR = ".sdr-doa-edge"
MQTT_CLIENT_ID = "sdr-doa-lan-agent"
MQTT_KEEPALIVE_S = 30
MQTT_PASSWORD_ENV = "SDR_DOA_MQTT_PASSWORD"
# One collection must finish well inside keepalive/2, because the MQTT
# connection is not serviced while Data Out is being read.
DEFAULT_COLLECT_BUDGET_S = 2.0
MAX_COLLECT_BUDGET_S = 10.0
MAX_PENDING_COMMANDS = 32
MAX_PENDING_ACKS = 32
MAX_COMMAND_JOURNAL = 128
MAX_COMMAND_ID_CHARS = 128
DOA_MAX_QUEUE_AGE_MS = 5_000
ERROR_LOG_REPEAT_S = 60.0
DOA_VIEW_PATHS = frozenset({collector.PATH_CSV, collector.PATH_XML})
TELEMETRY_STREAMS = ("doa", "health")
CONFIG_RANGES = {
    "center_frequency_hz": (24_000_000.0, 1_800_000_000.0),
    "gain_db": (-100.0, 60.0),
    "vfo_frequency_hz": (24_000_000.0, 1_800_000_000.0),
    "vfo_bandwidth_hz": (100.0, 2_400_000.0),
    "vfo_squelch_db": (-200.0, 20.0),
}

PAYLOAD_ERRORS = (contract.ContractError, ValueError, TypeError, OverflowError)
TRANSPORT_ERRORS = (OSError, MqttProtocolError)


def _safe_number(value: Any, default: Optional[float] = None) -> Optional[float]:
    if isinstance(value, bool):
        return default
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return number if math.isfinite(number) else default


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _non_negative_int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value >= 0 else None


def _bounded_text(value: Any, default: str = "unknown", limit: int = 64) -> str:
    text = str(value).strip() if value is not None else ""
    return text[:limit] if text else default


def _fresh_candidate(snapshot: Mapping[str, Any]) -> Optional[Mapping[str, Any]]:
    """Return only the collector-selected fresh authority candidate."""
    authority = _mapping(snapshot.get("authority")).get("selected")
    if authority not in {"csv", "xml"}:
        return None
    candidate = _mapping(_mapping(snapshot.get("doa_candidates")).get(authority))
    freshness = _mapping(candidate.get("freshness"))
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
    return json.dumps(fields, sort_keys=True, separators=(",", ":"), allow_nan=False, default=str)


def node_health(snapshot: Mapping[str, Any]) -> Tuple[str, List[str]]:
    """Classify the node from status.json alone, independent of DoA readiness.

    UNAVAILABLE: status.json could not be read or parsed.
    STALE: status is older than the freshness limit, or the node's counters
    stopped advancing (a frozen DSP loop keeps serving its last files).
    DEGRADED: DAQ health failed, ADC overdrive, or freshness cannot be shown.
    ONLINE: fresh status with a passing DAQ.
    """
    status = _mapping(snapshot.get("status"))
    checks = _mapping(_mapping(snapshot.get("publication_gate")).get("checks"))
    progress = _mapping(snapshot.get("node_progress"))
    collection = _mapping(snapshot.get("collection"))
    reasons: List[str] = []
    if status.get("available") is not True:
        reasons.append("STATUS_UNAVAILABLE_OR_INVALID")
        if collection.get("deadline_exceeded") is True:
            reasons.append("COLLECTION_DEADLINE_EXCEEDED")
        return "UNAVAILABLE", reasons
    stale = False
    if checks.get("status_fresh") is False:
        reasons.append("STATUS_STALE")
        stale = True
    if progress.get("stalled") is True:
        reasons.append("NODE_CLOCK_STALLED")
        stale = True
    degraded = False
    if status.get("daq_health") != "PASS":
        reasons.append("DAQ_HEALTH_GATE_FAILED")
        degraded = True
    if checks.get("adc_not_overdriven") is False:
        reasons.append("ADC_OVERDRIVE")
        degraded = True
    freshness_shown = checks.get("status_fresh") is True or progress.get("state") == "ADVANCING"
    if not stale and not freshness_shown:
        reasons.append("STATUS_FRESHNESS_UNVERIFIED")
    if collection.get("deadline_exceeded") is True:
        reasons.append("COLLECTION_DEADLINE_EXCEEDED")
    if stale:
        return "STALE", reasons
    if degraded or not freshness_shown:
        return "DEGRADED", reasons
    return "ONLINE", reasons


def build_messages_with_errors(
    snapshot: Dict[str, Any],
    now_ms: Optional[int] = None,
    config_rev: int = 0,
    telemetry_drop_count: int = 0,
) -> Tuple[Dict[str, Dict[str, Any]], List[str]]:
    """Build contract messages; return them with payload-build errors.

    Each kind is built on its own, so a setting the contract cannot carry
    never suppresses health. Health then reports ``settings_valid: false``
    and ``SETTINGS_PAYLOAD_INVALID``.
    """
    now = int(time.time() * 1000) if now_ms is None else int(now_ms)
    errors: List[str] = []
    status = _mapping(snapshot.get("status"))
    safe_status = _mapping(status.get("safe"))
    daq_status = _mapping(safe_status.get("daq_status"))
    settings_view = _mapping(snapshot.get("settings"))
    settings = _mapping(settings_view.get("fields"))
    gate = _mapping(snapshot.get("publication_gate"))
    gate_checks = _mapping(gate.get("checks"))
    daq_ok = status.get("daq_health") == "PASS"
    candidate = _fresh_candidate(snapshot)
    doa_ready = bool(
        candidate
        and gate.get("state") == "READY"
        and gate_checks.get("selected_units_valid") is True
    )
    state_name, reasons = node_health(snapshot)
    source_ts = _non_negative_int(safe_status.get("timestamp_ms"))
    ts_ms = now if source_ts is None else source_ts

    messages: Dict[str, Dict[str, Any]] = {}
    settings_effective = collector.settings_are_effective(settings_view)
    if settings_effective:
        try:
            frequency_hz = int(round((_safe_number(settings.get("center_freq"), 0.0) or 0.0) * 1_000_000))
            gain_db = _safe_number(settings.get("uniform_gain"), 0.0) or 0.0
            array = _bounded_text(settings.get("ant_arrangement"))
            method = _bounded_text(settings.get("doa_method"))
            active_vfos = int(_safe_number(settings.get("active_vfos"), 0.0) or 0)
            output_vfo = int(_safe_number(settings.get("output_vfo"), 0.0) or 0)
            state = contract.build_state(
                ts_ms=ts_ms,
                config_rev=int(config_rev),
                running=bool(daq_ok),
                frequency_hz=frequency_hz,
                gain_db=gain_db,
                array=array,
                method=method,
                active_vfos=active_vfos,
                output_vfo=output_vfo,
            )
            reported = contract.build_config_reported(
                ts_ms=ts_ms,
                config_rev=int(config_rev),
                center_frequency_hz=frequency_hz,
                gain_db=gain_db,
                array=array,
                method=method,
                active_vfos=active_vfos,
                output_vfo=output_vfo,
            )
        except PAYLOAD_ERRORS as exc:
            errors.append(f"STATE_PAYLOAD_INVALID: {exc}")
            reasons.append("SETTINGS_PAYLOAD_INVALID")
            settings_effective = False
        else:
            messages["state"] = state
            messages["config_reported"] = reported
    # Without effective settings no state/config is built: never replace a
    # retained effective configuration with fabricated values after a
    # transient settings read failure.

    doa_age_ms: Optional[int] = None
    if candidate is not None:
        age = _safe_number(_mapping(candidate.get("freshness")).get("age_ms"))
        if age is not None:
            doa_age_ms = max(0, int(age))

    health_reasons = list(dict.fromkeys(reasons))[: contract.MAX_HEALTH_REASONS]
    try:
        messages["health"] = contract.build_health(
            ts_ms=ts_ms,
            state=state_name,
            daq_ok=safe_status.get("daq_ok") is True,
            dropped_frames=_non_negative_int(safe_status.get("daq_num_dropped_frames")) or 0,
            gps_status=_bounded_text(safe_status.get("gps_status")),
            doa_valid=doa_ready,
            doa_age_ms=doa_age_ms,
            frame_sync=daq_status.get("frame_sync") if isinstance(daq_status.get("frame_sync"), bool) else None,
            sample_delay_sync=(
                daq_status.get("sample_delay_sync") if isinstance(daq_status.get("sample_delay_sync"), bool) else None
            ),
            iq_sync=daq_status.get("iq_sync") if isinstance(daq_status.get("iq_sync"), bool) else None,
            uptime_ms=_non_negative_int(safe_status.get("uptime_ms")),
            telemetry_drop_count=max(0, int(telemetry_drop_count)),
            settings_available=settings_view.get("available") is True,
            settings_valid=settings_effective,
            reasons=health_reasons,
        )
    except PAYLOAD_ERRORS as exc:
        errors.append(f"HEALTH_PAYLOAD_INVALID: {exc}")
        messages["health"] = contract.build_health(
            ts_ms=now,
            state=state_name if state_name in {"UNAVAILABLE", "STALE"} else "DEGRADED",
            daq_ok=False,
            dropped_frames=0,
            gps_status="unknown",
            doa_valid=False,
            doa_age_ms=None,
            settings_valid=False,
            reasons=list(dict.fromkeys(health_reasons + ["HEALTH_PAYLOAD_INVALID"]))[: contract.MAX_HEALTH_REASONS],
        )

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
            try:
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
            except (KeyError,) + PAYLOAD_ERRORS as exc:
                errors.append(f"DOA_PAYLOAD_INVALID: {exc}")
    return messages, errors


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
    messages, _errors = build_messages_with_errors(
        snapshot,
        now_ms=now_ms,
        config_rev=config_rev,
        telemetry_drop_count=telemetry_drop_count,
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



def _command_id_from(payload: bytes) -> Optional[str]:
    """Best-effort command id for ACKing a command that failed validation."""
    if len(payload) > contract.MAX_PAYLOAD_BYTES:
        return None
    try:
        decoded = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        return None
    if not isinstance(decoded, dict):
        return None
    command_id = decoded.get("id")
    if isinstance(command_id, str) and command_id.strip() and len(command_id) <= MAX_COMMAND_ID_CHARS:
        return command_id
    return None


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
        collect_budget_s: float = DEFAULT_COLLECT_BUDGET_S,
        mqtt_username: Optional[str] = None,
        mqtt_password: Optional[str] = None,
        mqtt_tls_context: Optional[ssl.SSLContext] = None,
        fetcher: Any = None,
        client_factory: Optional[Callable[..., Any]] = None,
        log_stream: Optional[TextIO] = None,
    ) -> None:
        if config_enabled and not publish_enabled:
            raise ValueError("config control requires MQTT publish mode")
        if config_enabled and not settings_path:
            raise ValueError("--settings-path is required when config control is enabled")
        if health_interval_s <= 0 or doa_rate_hz < 0 or state_interval_s <= 0 or poll_interval_s <= 0:
            raise ValueError("intervals must be positive and doa_rate_hz must be non-negative")
        if (
            isinstance(collect_budget_s, bool)
            or not isinstance(collect_budget_s, (int, float))
            or not math.isfinite(collect_budget_s)
            or not 0 < collect_budget_s <= MAX_COLLECT_BUDGET_S
        ):
            raise ValueError(f"collect budget must be within (0, {MAX_COLLECT_BUDGET_S:g}] seconds")
        if authority not in {"none", "csv", "xml"}:
            raise ValueError("authority must be one of: none, csv, xml")
        self.base_url = base_url.rstrip("/")
        self.mqtt_host = mqtt_host
        self.mqtt_port = int(mqtt_port)
        self.mqtt_username = mqtt_username
        self.mqtt_password = mqtt_password
        self.mqtt_tls_context = mqtt_tls_context
        self.publish_enabled = publish_enabled
        self.config_enabled = config_enabled
        self.clock_source = clock_source
        self.health_interval_s = float(health_interval_s)
        self.doa_enabled = doa_rate_hz > 0
        self.doa_interval_s = float("inf") if not self.doa_enabled else 1.0 / float(doa_rate_hz)
        self.state_interval_s = float(state_interval_s)
        self.poll_interval_s = float(poll_interval_s)
        self.authority = authority
        self.collect_budget_s = float(collect_budget_s)
        # CSV/XML only feed the selected-authority DoA candidate. Without an
        # authority nothing derived from them is published, so they are not
        # read and the node serves two GETs per cycle instead of four.
        self.doa_views_needed = authority != "none"
        # Collection follows the publish schedule; the poll interval only
        # paces MQTT I/O.
        intervals = [self.health_interval_s, self.state_interval_s]
        if self.doa_enabled and self.doa_views_needed:
            intervals.append(self.doa_interval_s)
        self.collect_interval_s = min(intervals)
        self.fetcher = fetcher if fetcher is not None else collector.fetch_resource
        self.client_factory = client_factory if client_factory is not None else Mqtt311Client
        self.log_stream = log_stream if log_stream is not None else sys.stderr
        self.progress_tracker = collector.NodeProgressTracker()
        self.stop_event = Event()
        self.pending_commands: List[IncomingMessage] = []
        self.pending_acks: List[Dict[str, Any]] = []
        self.command_journal: Dict[str, Dict[str, Any]] = {}
        self.command_fingerprints: Dict[str, str] = {}
        self.client: Optional[Any] = None
        self.config_applier = AtomicConfigApplier(settings_path, state_dir) if settings_path else None
        self.config_rev = self.config_applier.current_revision() if self.config_applier else 0
        self.queue = contract.LatestValueQueue(("doa", "health", "state", "config_reported"))
        self.last_snapshot: Optional[Dict[str, Any]] = None
        self.last_config_fingerprint: Optional[str] = None
        self.last_health_at = float("-inf")
        self.last_doa_at = float("-inf")
        self.last_state_at = float("-inf")
        self.next_collect_at = float("-inf")
        self.force_state = True
        self.last_error: Optional[str] = None
        self.doa_drop_count = 0
        self.reconnect_delay_s = 1.0
        self.next_connect_at = 0.0
        self.connections = 0
        self.published_counts: Dict[str, int] = {}
        self._logged_errors: Dict[str, float] = {}
        if self.publish_enabled:
            # Builds (does not connect) a client so that a configuration the
            # transport refuses, such as a non-loopback broker without TLS and
            # credentials, fails at startup instead of being retried forever.
            self._new_client()

    def request_stop(self, *_args: Any) -> None:
        self.stop_event.set()

    def _log_error(self, message: str) -> None:
        """Record the latest error and log it, repeating a persistent one at most once a minute."""
        self.last_error = message
        now = time.monotonic()
        last = self._logged_errors.get(message)
        if last is not None and now - last < ERROR_LOG_REPEAT_S:
            return
        if len(self._logged_errors) >= 64:
            self._logged_errors.clear()
        self._logged_errors[message] = now
        try:
            self.log_stream.write(
                json.dumps({"event": "agent_error", "error": message, "ts_ms": int(time.time() * 1000)}, sort_keys=True)
                + "\n"
            )
            self.log_stream.flush()
        except (OSError, ValueError):
            pass

    def telemetry_drop_count(self) -> int:
        """DoA dropped as stale plus telemetry superseded before it was sent."""
        replaced = self.queue.stats.replaced_by_stream
        return self.doa_drop_count + sum(int(replaced.get(stream, 0)) for stream in TELEMETRY_STREAMS)

    def _availability_payload(self, online: bool, reason: Optional[str] = None) -> bytes:
        payload = contract.build_availability(ts_ms=int(time.time() * 1000), online=online, reason=reason)
        return contract.compact_json(payload).encode("utf-8")

    def _new_client(self) -> Any:
        return self.client_factory(
            self.mqtt_host,
            self.mqtt_port,
            client_id=MQTT_CLIENT_ID,
            keepalive=MQTT_KEEPALIVE_S,
            on_message=self._on_message,
            username=self.mqtt_username,
            password=self.mqtt_password,
            tls_context=self.mqtt_tls_context,
            will=WillMessage(
                topic=contract.TOPICS["availability"],
                payload=self._availability_payload(False, "CONNECTION_LOST"),
                qos=contract.STATE_QOS,
                retain=True,
            ),
        )

    # -- command intake -------------------------------------------------

    def _queue_ack(self, ack: Mapping[str, Any]) -> None:
        if not self.publish_enabled:
            return
        if len(self.pending_acks) >= MAX_PENDING_ACKS:
            self.pending_acks.pop(0)
        self.pending_acks.append(dict(ack))

    def _reject_command(
        self,
        command_id: Optional[str],
        code: str,
        now_ms: int,
        status: str = "rejected",
    ) -> None:
        """ACK a command refused before it reached the apply path.

        These ACKs are not journaled: the same id may be sent again once the
        sender has corrected the QoS, the clock or the field list.
        """
        self.last_error = code
        if command_id is None:
            return
        try:
            ack = contract.build_config_ack(
                command_id=command_id,
                status=status,
                ts_ms=now_ms,
                config_rev=self.config_rev,
                readback_ok=False,
                error={"code": code},
            )
        except contract.ContractError:
            return
        self._queue_ack(ack)

    def _journal_ack(self, command_id: str, ack: Dict[str, Any]) -> None:
        self.command_journal.pop(command_id, None)
        self.command_journal[command_id] = ack
        while len(self.command_journal) > MAX_COMMAND_JOURNAL:
            oldest = next(iter(self.command_journal))
            self.command_journal.pop(oldest)
            self.command_fingerprints.pop(oldest, None)

    def _on_message(self, message: IncomingMessage) -> None:
        """Accept only authenticated-by-policy command metadata into the queue.

        MQTT metadata is part of the command contract. Validate it before the
        message can reach the apply path; retained commands and non-QoS-1
        deliveries are never replayed after reconnect. A refused command whose
        id can be read gets a rejected or expired ACK with the contract code.
        """
        if message.topic != contract.TOPICS["config_patch"]:
            return
        now_ms = int(time.time() * 1000)
        if len(message.payload) > contract.MAX_PAYLOAD_BYTES:
            self.last_error = "COMMAND_PAYLOAD_TOO_LARGE"
            return
        command_id = _command_id_from(message.payload)
        if not self.config_enabled:
            # The agent listens with --publish alone so the console gets an
            # explicit answer instead of waiting out the command's TTL.
            self._reject_command(command_id, "REMOTE_CONTROL_DISABLED", now_ms)
            return
        if message.qos != contract.COMMAND_QOS:
            self._reject_command(command_id, "WRONG_COMMAND_QOS", now_ms)
            return
        if message.retain:
            self._reject_command(command_id, "RETAINED_COMMAND", now_ms)
            return
        try:
            command = contract.decode_payload("config_patch", message.payload)
        except contract.ContractError:
            raw = json.loads(message.payload.decode("utf-8")) if command_id is not None else None
            changes = raw.get("changes") if isinstance(raw, dict) else None
            disallowed = isinstance(changes, Mapping) and any(field not in CONFIG_RANGES for field in changes)
            self._reject_command(command_id, "FIELD_NOT_ALLOWED" if disallowed else "INVALID_COMMAND", now_ms)
            return
        command_id = str(command["id"])
        fingerprint = hashlib.sha256(message.payload).hexdigest()
        known = self.command_fingerprints.get(command_id)
        if known is not None:
            if known != fingerprint:
                self._reject_command(command_id, "COMMAND_REPLAY_CONFLICT", now_ms)
                return
            # Same command again: the sender probably lost the ACK. Repeat the
            # journaled one; a command still pending gets its ACK when applied.
            self.last_error = "COMMAND_DUPLICATE"
            prior = self.command_journal.get(command_id)
            if prior is not None:
                self._queue_ack(prior)
            return
        if int(command["issued_ts_ms"]) > now_ms + contract.MAX_CONFIG_FUTURE_SKEW_MS:
            self._reject_command(command_id, "COMMAND_FUTURE_DATED", now_ms)
            return
        if int(command["expires_ts_ms"]) <= now_ms:
            self._reject_command(command_id, "COMMAND_EXPIRED", now_ms, status="expired")
            return
        try:
            self._check_changes(command)
        except ValueError:
            self._reject_command(command_id, "INVALID_COMMAND", now_ms)
            return
        if len(self.pending_commands) >= MAX_PENDING_COMMANDS:
            self._reject_command(command_id, "COMMAND_QUEUE_FULL", now_ms)
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

    @staticmethod
    def _check_changes(command: Mapping[str, Any]) -> None:
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

    def _validate_incoming_patch(self, payload: bytes, now_ms: Optional[int] = None) -> Dict[str, Any]:
        command = contract.validate_config_patch(
            contract.decode_payload("config_patch", payload),
            now_ms=int(time.time() * 1000) if now_ms is None else now_ms,
        )
        self._check_changes(command)
        return command

    def _process_commands(self, now_ms: int) -> None:
        if not self.pending_commands:
            return
        commands, self.pending_commands = self.pending_commands[:], []
        for message in commands:
            if message.topic != contract.TOPICS["config_patch"]:
                continue
            command_id = _command_id_from(message.payload) or "unknown-command"
            decoded: Optional[Dict[str, Any]] = None
            try:
                # Expiry is decided by the applier below, so it can answer
                # with an "expired" ACK rather than a schema rejection.
                decoded = contract.validate_config_patch(contract.decode_payload("config_patch", message.payload))
                self._check_changes(decoded)
                command_id = str(decoded["id"])
                if command_id in self.command_journal:
                    self._queue_ack(self.command_journal[command_id])
                    continue
                if not self.config_enabled or self.config_applier is None:
                    result: Dict[str, Any] = {
                        "status": "rejected",
                        "config_rev": self.config_rev,
                        "readback_ok": False,
                        "error": {"code": "REMOTE_CONTROL_DISABLED"},
                    }
                else:
                    result = self.config_applier.apply(decoded, now_ms=now_ms)
                    self.config_rev = int(result.get("config_rev", self.config_rev))
                    if result.get("status") == "applied":
                        self.force_state = True
                        self.next_collect_at = float("-inf")
                applied = result.get("status") == "applied"
                ack = contract.build_config_ack(
                    command_id=command_id,
                    status=str(result["status"]),
                    ts_ms=now_ms,
                    config_rev=self.config_rev,
                    readback_ok=bool(result.get("readback_ok", False)),
                    error=result.get("error"),
                    changed_fields=(decoded.get("changes", {}).keys() if applied else None),
                )
            except PAYLOAD_ERRORS as exc:
                self._log_error(f"INVALID_COMMAND: {exc}")
                ack = contract.build_config_ack(
                    command_id=command_id,
                    status="rejected",
                    ts_ms=now_ms,
                    config_rev=self.config_rev,
                    readback_ok=False,
                    error={"code": "INVALID_COMMAND"},
                )
            self._journal_ack(command_id, ack)
            self._queue_ack(ack)

    # -- MQTT transport -------------------------------------------------

    def _connect_if_due(self, now_mono: float) -> None:
        if not self.publish_enabled or self.client is not None or now_mono < self.next_connect_at:
            return
        try:
            client = self._new_client()
        except ValueError as exc:
            self._log_error(f"MQTT_CONFIG_INVALID: {exc}")
            self.next_connect_at = now_mono + 30.0
            return
        try:
            client.connect()
            # Subscribed whenever publishing, also without --enable-config:
            # a patch then gets a REMOTE_CONTROL_DISABLED rejection ACK.
            client.subscribe(contract.TOPICS["config_patch"], qos=1)
            client.publish(
                contract.TOPICS["availability"],
                self._availability_payload(True),
                qos=contract.STATE_QOS,
                retain=True,
            )
        except TRANSPORT_ERRORS + (ValueError,) as exc:
            client.close(graceful=False)
            self._log_error(f"MQTT_CONNECT_FAILED: {exc}")
            self.next_connect_at = now_mono + self.reconnect_delay_s
            self.reconnect_delay_s = min(self.reconnect_delay_s * 2.0, 30.0)
            return
        self.client = client
        self.connections += 1
        self.reconnect_delay_s = 1.0
        self.last_error = None
        # The broker may have restarted without persistence; send state and
        # reported config again now instead of at the next state interval.
        self.force_state = True
        self.next_collect_at = float("-inf")

    def _disconnect(self, error: Optional[BaseException] = None) -> None:
        if error is not None:
            self._log_error(f"MQTT_TRANSPORT_ERROR: {error}")
        if self.client is not None:
            # No DISCONNECT: the broker publishes the OFFLINE will.
            self.client.close(graceful=False)
        self.client = None
        self.next_connect_at = time.monotonic() + self.reconnect_delay_s
        self.reconnect_delay_s = min(self.reconnect_delay_s * 2.0, 30.0)

    def close(self) -> None:
        """Mark the agent offline and send DISCONNECT."""
        client, self.client = self.client, None
        if client is None:
            return
        try:
            client.publish(
                contract.TOPICS["availability"],
                self._availability_payload(False, "SHUTDOWN"),
                qos=contract.STATE_QOS,
                retain=True,
            )
        except TRANSPORT_ERRORS + (ValueError,) as exc:
            self._log_error(f"MQTT_TRANSPORT_ERROR: {exc}")
            client.close(graceful=False)
            return
        client.close()

    def _publish_one(self, kind: str, payload: Mapping[str, Any]) -> None:
        """Publish one contract payload; transport errors propagate."""
        if not self.publish_enabled or self.client is None:
            return
        encoded = contract.compact_json(payload).encode("utf-8")
        qos = contract.STATE_QOS if kind in {"state", "config_reported", "ack_config"} else contract.TELEMETRY_QOS
        retain = kind in {"state", "config_reported"}
        self.client.publish(contract.TOPICS[kind], encoded, qos=qos, retain=retain)
        self.published_counts[kind] = self.published_counts.get(kind, 0) + 1

    def _drop_queued_doa(self, reason: str) -> None:
        queued = self.queue.pop("doa")
        if queued is not None:
            self.doa_drop_count += 1
            self.last_error = reason

    def _doa_payload_is_current(self, payload: Mapping[str, Any]) -> bool:
        """Reject cached DoA after a disconnect or freshness/gate failure."""
        snapshot = self.last_snapshot or {}
        gate = _mapping(snapshot.get("publication_gate"))
        if gate.get("state") != "READY":
            return False
        candidate = _fresh_candidate(snapshot)
        if candidate is None or candidate.get("units_valid") is not True:
            return False
        freshness = _mapping(candidate.get("freshness"))
        if freshness.get("fresh") is not True:
            return False
        try:
            payload_ts = int(payload["ts_ms"])
            candidate_ts = int(candidate["timestamp_ms"])
        except (KeyError, TypeError, ValueError):
            return False
        return payload_ts == candidate_ts and int(time.time() * 1000) - payload_ts <= DOA_MAX_QUEUE_AGE_MS

    def _flush_queue(self) -> None:
        """Publish queued values; transport errors propagate to the caller."""
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
            try:
                self._publish_one(kind, value)
            except (ValueError, TypeError) as exc:
                self.queue.pop_if_same(kind, value)
                self._log_error(f"{kind.upper()}_PAYLOAD_INVALID: {exc}")
                continue
            self.queue.pop_if_same(kind, value)
        while self.pending_acks and self.client is not None:
            ack = self.pending_acks.pop(0)
            try:
                self._publish_one("ack_config", ack)
            except (ValueError, TypeError) as exc:
                self._log_error(f"ACK_PAYLOAD_INVALID: {exc}")
            except TRANSPORT_ERRORS:
                self.pending_acks.insert(0, ack)
                raise

    def _poll_mqtt(self) -> None:
        if self.client is None:
            return
        try:
            self.client.poll(timeout=0.0)
        except TRANSPORT_ERRORS + (ValueError,) as exc:
            self._disconnect(exc)

    def _flush_or_disconnect(self) -> None:
        try:
            self._flush_queue()
        except TRANSPORT_ERRORS as exc:
            self._disconnect(exc)

    # -- collection -----------------------------------------------------

    def _fetch(self, base_url: str, path: str, timeout: float, max_body: int) -> Any:
        if path in DOA_VIEW_PATHS and not self.doa_views_needed:
            return collector.FetchedResource(
                path=path,
                url=str(base_url).rstrip("/") + path,
                ok=False,
                http_status=None,
                content_type=None,
                body=b"",
                retrieved_at_ms=collector.now_ms(),
                error="not read: no DoA authority selected",
                error_kind="skipped",
                elapsed_ms=0,
                attempts=0,
            )
        return self.fetcher(base_url, path, timeout, max_body)

    def collect_once(self, now_ms: Optional[int] = None, now_mono: Optional[float] = None) -> Dict[str, Any]:
        observed_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
        cycle_mono = time.monotonic() if now_mono is None else float(now_mono)
        snapshot = collector.collect(
            base_url=self.base_url,
            authority=self.authority,
            clock_source=self.clock_source,
            timeout_seconds=self.collect_budget_s,
            fetcher=self._fetch,
            total_budget_s=self.collect_budget_s,
            progress_tracker=self.progress_tracker,
        )
        messages, errors = build_messages_with_errors(
            snapshot,
            now_ms=observed_ms,
            config_rev=self.config_rev,
            telemetry_drop_count=self.telemetry_drop_count(),
        )
        for error in errors:
            self._log_error(error)
        settings = _mapping(_mapping(snapshot.get("settings")).get("fields"))
        fingerprint = _safe_config_fingerprint(settings)
        if cycle_mono - self.last_health_at >= self.health_interval_s:
            self.queue.put("health", messages["health"])
            self.last_health_at = cycle_mono
        if (
            self.force_state
            or fingerprint != self.last_config_fingerprint
            or cycle_mono - self.last_state_at >= self.state_interval_s
        ):
            if "state" in messages:
                self.queue.put("state", messages["state"])
            if "config_reported" in messages:
                self.queue.put("config_reported", messages["config_reported"])
            self.last_config_fingerprint = fingerprint
            self.last_state_at = cycle_mono
            self.force_state = False
        if self.doa_enabled and "doa" in messages and cycle_mono - self.last_doa_at >= self.doa_interval_s:
            self.queue.put("doa", messages["doa"])
            self.last_doa_at = cycle_mono
        self.last_snapshot = snapshot
        collection = _mapping(snapshot.get("collection"))
        return {
            "overall_state": snapshot.get("overall_state"),
            "gate_state": _mapping(snapshot.get("publication_gate")).get("state"),
            "gate_reasons": _mapping(snapshot.get("publication_gate")).get("reasons", []),
            "health_state": messages["health"].get("state"),
            "health_reasons": messages["health"].get("reasons", []),
            "payload_errors": errors,
            "queued_kinds": sorted(self.queue.snapshot()),
            "message_kinds": sorted(messages),
            "collection_elapsed_ms": collection.get("elapsed_ms"),
            "doa_views_read": self.doa_views_needed,
            "config_rev": self.config_rev,
            "publish_enabled": self.publish_enabled,
            "config_enabled": self.config_enabled,
            "raw_settings_omitted": True,
            "raw_angular_values_omitted": True,
            "angular_plot_local_only": True,
        }

    def _collect_cycle(self, now_mono: float) -> Optional[Dict[str, Any]]:
        try:
            return self.collect_once(now_mono=now_mono)
        except PAYLOAD_ERRORS as exc:
            # A collector or payload failure is not a broker failure: keep the
            # MQTT session and try again at the next collection.
            self._log_error(f"COLLECT_FAILED: {exc}")
            return None

    def _transport_summary(self) -> Dict[str, Any]:
        return {
            "connected": self.client is not None,
            "connections": self.connections,
            "published_counts": dict(sorted(self.published_counts.items())),
            "published_kinds": sorted(self.published_counts),
            "telemetry_drop_count": self.telemetry_drop_count(),
            "last_error": self.last_error,
        }

    def run_once(self) -> Dict[str, Any]:
        """One connect/collect/publish cycle, reporting what reached the broker."""
        try:
            if self.publish_enabled:
                self._connect_if_due(time.monotonic())
            result = self._collect_cycle(time.monotonic()) or {}
            if self.publish_enabled:
                self._flush_or_disconnect()
            result.update(self._transport_summary())
            result["queued_kinds"] = sorted(self.queue.snapshot())
            return result
        finally:
            self.close()

    def run(self, duration_s: Optional[float] = None, max_iterations: Optional[int] = None) -> Dict[str, Any]:
        """Run until stopped; ``max_iterations`` counts collection cycles."""
        started = time.monotonic()
        iterations = 0
        last_result: Dict[str, Any] = {}
        try:
            while not self.stop_event.is_set():
                now_mono = time.monotonic()
                if duration_s is not None and now_mono - started >= duration_s:
                    break
                if max_iterations is not None and iterations >= max_iterations:
                    break
                self._connect_if_due(now_mono)
                self._poll_mqtt()
                if now_mono >= self.next_collect_at:
                    self.next_collect_at = now_mono + self.collect_interval_s
                    result = self._collect_cycle(now_mono)
                    if result is not None:
                        last_result = result
                    iterations += 1
                self._process_commands(int(time.time() * 1000))
                self._flush_or_disconnect()
                self.stop_event.wait(self.poll_interval_s)
            summary = self._transport_summary()
        finally:
            self.close()
        last_result.update(summary)
        last_result["iterations"] = iterations
        last_result["elapsed_s"] = round(time.monotonic() - started, 3)
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
    parser.add_argument(
        "--mqtt-username",
        default=None,
        help=f"broker username; the password is read from the {MQTT_PASSWORD_ENV} environment variable",
    )
    parser.add_argument("--mqtt-tls", action="store_true", help="use TLS verified against the system CA store")
    parser.add_argument("--mqtt-cafile", default=None, help="use TLS verified against this CA file")
    parser.add_argument("--publish", action="store_true", help="publish to the explicit MQTT broker")
    parser.add_argument("--enable-config", action="store_true", help="enable config_patch apply and ACK handling")
    parser.add_argument("--settings-path", default=None)
    parser.add_argument("--state-dir", default=DEFAULT_STATE_DIR)
    parser.add_argument("--authority", choices=("none", "csv", "xml"), default="none")
    parser.add_argument("--health-interval", type=float, default=1.0)
    parser.add_argument("--doa-rate", type=float, default=2.0)
    parser.add_argument("--state-interval", type=float, default=30.0)
    parser.add_argument("--poll-interval", type=float, default=0.05, help="MQTT service interval in seconds")
    parser.add_argument(
        "--collect-budget",
        type=float,
        default=DEFAULT_COLLECT_BUDGET_S,
        help=f"maximum seconds for one Data Out collection (at most {MAX_COLLECT_BUDGET_S:g})",
    )
    parser.add_argument("--duration", type=float, default=None)
    parser.add_argument("--iterations", type=int, default=None, help="stop after this many collection cycles")
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
    tls_context: Optional[ssl.SSLContext] = None
    if args.mqtt_tls or args.mqtt_cafile:
        try:
            tls_context = create_default_tls_context(args.mqtt_cafile)
        except (OSError, ssl.SSLError) as exc:
            raise SystemExit(f"--mqtt-cafile could not be loaded: {exc}") from None
    password: Optional[str] = None
    if args.mqtt_username:
        password = os.environ.get(MQTT_PASSWORD_ENV) or None
    try:
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
            collect_budget_s=args.collect_budget,
            mqtt_username=args.mqtt_username or None,
            mqtt_password=password,
            mqtt_tls_context=tls_context,
        )
    except ValueError as exc:
        raise SystemExit(f"invalid agent configuration: {exc}") from None
    signal.signal(signal.SIGINT, runtime.request_stop)
    signal.signal(signal.SIGTERM, runtime.request_stop)
    result = runtime.run_once() if args.once else runtime.run(args.duration, args.iterations)
    if args.json_events or args.once:
        print(json.dumps(result, sort_keys=True, allow_nan=False))
    else:
        print(
            json.dumps(
                {
                    key: result.get(key)
                    for key in (
                        "iterations",
                        "elapsed_s",
                        "last_error",
                        "gate_state",
                        "overall_state",
                        "health_state",
                        "publish_enabled",
                        "published_counts",
                    )
                },
                sort_keys=True,
                allow_nan=False,
            )
        )
    if args.publish and not result.get("published_kinds"):
        # Nothing reached the broker: make smoke checks and service managers
        # see a failure instead of a clean exit.
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
