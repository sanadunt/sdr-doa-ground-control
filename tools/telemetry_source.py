"""Which source answers /api/snapshot: MQTT first, Data Out as the fallback (issue #8).

The decision (``docs/MQTT_KONTRAK.md``, section 8):

- MQTT is fresh when the RDF Node store (``rdf_node_mqtt_v2.py``) holds a
  ``state`` session and a ``telemetry/health`` of that session received at
  most 8 s ago with ``daq=1``. The store accepts a health message only when
  its ``q`` advances and its ``t`` is inside the window, and a new ``sid``
  drops the old session's health, so "fresh" already means an advancing ``q``
  of the current session. Then the answer is built from MQTT here
  (``mqtt_snapshot``) in the TelemetrySnapshot shape the Dashboard reads.
- Otherwise the answer is the Data Out collection as before, marked
  ``data_out``, or ``none`` when that collection could not read status.json
  either (``with_source``).

The MQTT answer keeps the console's observation boundary: authority ``none``,
clock ``remote_unverified``, publication gate ``BLOCKED`` and an
``overall_state`` that is never ``LIVE``. Only LIVE values reach the DoA:
``telemetry/doa`` with ``ok=1`` gives the angle, frequency, PAPR and power,
``telemetry/angular`` with ``flags=63`` the 360-bin vector. ``ok=0``,
trust-only Angular and both diagnostic topics stay in the ``mqtt`` block as
diagnostics and never fill ``doa_candidates``.

The mapping, with its evidence in the edge's code (commit 8691ad0):

- ``telemetry/doa`` and ``telemetry/angular`` come from one DOA_value.html
  record (``source.parse_csv``): ``t``/``timestamp_ms`` is its column 0,
  ``f`` column 4, ``c`` column 2 (dB PAPR), ``p`` column 3 and ``values`` its
  360 bins (columns 17 onwards) in file order, which are exactly what the
  console's collector reads as the CSV view's ``angular_power_db``.
- Angular ``raw_doa_deg`` is column 1 modulo 360, the CSV view's raw angle,
  so theta_0 is ``(360 - raw_doa_deg) % 360`` whatever the edge's angle mode.
- DoA ``a`` with ``ok=1`` is ``(360 - raw) % 360`` (theta_0) when
  ``capabilities.angle`` is ``theta_mirror`` and the raw column 1 when it is
  ``csv_native`` (``source.Source.view``, ``config.validate_config``), so
  theta_0 comes from ``a`` only while this session's capabilities name one of
  the two; otherwise the angle is left out.
- ``q`` of a LIVE Angular frame is the ``q`` of the DoA record it belongs to
  (``agent._live_angular`` sends it only when ``r['q'] == d['q']``), so a
  same-``q`` pair is one frame and its two angles must agree.
- ``daq=1`` in health means status.json was fresh with ``daq_ok`` and all
  three sync flags true (``source.Source.view``), so the DAQ state is PASS.

MQTT never carries the station position, the settings fields or the ADC
overdrive; the light Data Out read (``sdr_doa_collector.collect_light``)
does, and ``DataOutReader`` decides when it runs.
"""

from __future__ import annotations

import copy
import math
from typing import Any, Dict, List, Mapping, Optional, Tuple

from rdf_node_mqtt_v2 import ANGULAR_FRESH_MS, DOA_FRESH_MS, HEALTH_FRESH_MS
from sdr_doa_collector import (
    ANGLE_CONSISTENCY_TOLERANCE_DEG,
    ANGULAR_PEAK_ANGLE_TOLERANCE_DEG,
    CSV_POWER_FLOOR_DB,
    NATIVE_TIMESTAMP_TOLERANCE_MS,
    SCHEMA_VERSION,
)

SOURCE_MQTT = "mqtt"
SOURCE_DATA_OUT = "data_out"
SOURCE_NONE = "none"

# Why an answer has its source. MQTT_FRESH is the only reason of an MQTT
# answer; the others say why MQTT is not the source, and DATA_OUT_UNAVAILABLE
# why there is none.
MQTT_FRESH = "MQTT_FRESH"
MQTT_DISABLED = "MQTT_DISABLED"
MQTT_NO_SESSION = "MQTT_NO_SESSION"
MQTT_NO_HEALTH = "MQTT_NO_HEALTH"
MQTT_HEALTH_STALE = "MQTT_HEALTH_STALE"
MQTT_DAQ_NOT_HEALTHY = "MQTT_DAQ_NOT_HEALTHY"
# The request asked for Data Out (the legacy UI); MQTT was not consulted.
DATA_OUT_REQUESTED = "DATA_OUT_REQUESTED"
DATA_OUT_UNAVAILABLE = "DATA_OUT_UNAVAILABLE"
SOURCE_REASONS = (
    MQTT_FRESH, MQTT_DISABLED, MQTT_NO_SESSION, MQTT_NO_HEALTH, MQTT_HEALTH_STALE, MQTT_DAQ_NOT_HEALTHY,
    DATA_OUT_REQUESTED, DATA_OUT_UNAVAILABLE,
)

# Publication-gate reasons of an MQTT answer besides the collector's own.
MQTT_NO_DOA = "MQTT_NO_DOA"
MQTT_DOA_UNVERIFIED = "MQTT_DOA_UNVERIFIED"
MQTT_ANGLE_CONVENTION_UNKNOWN = "MQTT_ANGLE_CONVENTION_UNKNOWN"
MQTT_ANGULAR_UNAVAILABLE = "MQTT_ANGULAR_UNAVAILABLE"
MQTT_DOA_ANGULAR_CONFLICT = "MQTT_DOA_ANGULAR_CONFLICT"
MQTT_GATE_REASONS = (
    MQTT_NO_DOA, MQTT_DOA_UNVERIFIED, MQTT_ANGLE_CONVENTION_UNKNOWN, MQTT_ANGULAR_UNAVAILABLE, MQTT_DOA_ANGULAR_CONFLICT,
)

# capabilities.angle values of the edge (config.validate_config).
ANGLE_THETA_MIRROR = "theta_mirror"
ANGLE_CSV_NATIVE = "csv_native"
SYNC_FLAGS = ("frame_sync", "sample_delay_sync", "iq_sync")
DAQ_HEALTH = {1: "PASS", 0: "FAIL", 2: "UNKNOWN"}

# How a LIVE Angular frame relates to the LIVE DoA. Only the first two give
# the DoA its vector: the same record, or the same VFO frequency and config
# revision.
PAIR_SAME_FRAME = "SAME_FRAME"
PAIR_SAME_CONFIG = "SAME_CONFIG"
PAIR_OTHER_FREQUENCY = "OTHER_FREQUENCY"
PAIR_OTHER_REVISION = "OTHER_REVISION"
PAIR_NOT_LIVE = "NOT_LIVE"
PAIR_NONE = "NONE"
PAIRED = (PAIR_SAME_FRAME, PAIR_SAME_CONFIG)

# The light read runs at most this often while MQTT is fresh, unless the
# node's config revision changes or Kontrol asks for settings.json.
LIGHT_READ_INTERVAL_S = 30.0
# The light read's ADC overdrive and SNR count for this long after the read:
# two intervals and a read budget. Older, they are unknown.
LIGHT_VALUES_MAX_AGE_MS = 65_000


def _record(value: Any) -> Optional[Dict[str, Any]]:
    return value if isinstance(value, dict) else None


def _int(value: Any) -> Optional[int]:
    return value if type(value) is int else None


def _number(value: Any) -> Optional[float]:
    if type(value) is int or (type(value) is float and math.isfinite(value)):
        return float(value)
    return None


def _circular_distance(first: float, second: float) -> float:
    delta = abs((first - second) % 360.0)
    return min(delta, 360.0 - delta)


def mqtt_freshness(view: Optional[Mapping[str, Any]]) -> Tuple[bool, List[str]]:
    """Whether MQTT answers the Dashboard, and when not, why (one reason)."""
    if not isinstance(view, Mapping):
        return False, [MQTT_DISABLED]
    node = _record(view.get("node")) or {}
    session = _record(node.get("session"))
    if session is None:
        return False, [MQTT_NO_SESSION]
    health = _record(node.get("health"))
    if health is None or health.get("sid") != session.get("sid"):
        return False, [MQTT_NO_HEALTH]
    if health.get("fresh") is not True:
        return False, [MQTT_HEALTH_STALE]
    if health.get("daq") != 1:
        return False, [MQTT_DAQ_NOT_HEALTHY]
    return True, []


def mqtt_mark(view: Optional[Mapping[str, Any]]) -> Tuple[Optional[str], Optional[int]]:
    """The session id and config revision (``state.cfg``) of the MQTT view."""
    node = _record((view or {}).get("node")) or {}
    session = _record(node.get("session")) or {}
    sid = session.get("sid")
    return (sid if isinstance(sid, str) else None, _int(session.get("cfg")))


def mqtt_summary(view: Optional[Mapping[str, Any]], fresh: bool) -> Dict[str, Any]:
    """The MQTT side of an answer's ``source`` block."""
    node = _record((view or {}).get("node")) or {}
    session = _record(node.get("session")) or {}
    health = _record(node.get("health")) or {}
    connection = (view or {}).get("connection")
    return {
        "fresh": fresh,
        "connection": connection if isinstance(connection, str) else "disabled",
        "sid": session.get("sid") if isinstance(session.get("sid"), str) else None,
        "health_age_ms": _int(health.get("age_ms")),
        "health_daq": _int(health.get("daq")),
        "health_fresh_ms": HEALTH_FRESH_MS,
    }


def with_source(answer: Dict[str, Any], view: Optional[Mapping[str, Any]], reasons: List[str]) -> Dict[str, Any]:
    """Mark a Data Out answer: ``data_out`` when it read status.json, else ``none``."""
    status = _record(answer.get("status")) or {}
    available = status.get("available") is True
    reasons = list(reasons) or [MQTT_DISABLED]
    if not available:
        reasons.append(DATA_OUT_UNAVAILABLE)
    answer["source"] = {
        "kind": SOURCE_DATA_OUT if available else SOURCE_NONE,
        "reason": reasons[0],
        "reasons": reasons,
        "mqtt": mqtt_summary(view, False),
        "data_out": {"read": "full", "available": available},
    }
    return answer


def angle_convention(node: Mapping[str, Any]) -> Optional[str]:
    """``capabilities.angle`` of the current session, when it is one the console can map."""
    capabilities = _record(node.get("capabilities"))
    if capabilities is None or capabilities.get("session_match") is not True:
        return None
    angle = capabilities.get("angle")
    return angle if angle in (ANGLE_THETA_MIRROR, ANGLE_CSV_NATIVE) else None


def theta0_from_doa(a: Any, convention: Optional[str]) -> Optional[float]:
    """theta_0 from a LIVE ``telemetry/doa`` ``a``, or None when the convention is unknown."""
    value = _number(a)
    if value is None:
        return None
    if convention == ANGLE_THETA_MIRROR:
        return value % 360.0
    if convention == ANGLE_CSV_NATIVE:
        return (360.0 - value) % 360.0
    return None


def theta0_from_angular(raw_doa_deg: Any) -> Optional[float]:
    """theta_0 from an Angular frame's ``raw_doa_deg`` (DOA_value.html column 1)."""
    value = _number(raw_doa_deg)
    return None if value is None else (360.0 - value) % 360.0


def angular_pairing(doa: Optional[Mapping[str, Any]], angular: Optional[Mapping[str, Any]]) -> str:
    if angular is None:
        return PAIR_NONE
    if angular.get("live") is not True or doa is None:
        return PAIR_NOT_LIVE
    if angular.get("frequency_hz") != doa.get("f"):
        return PAIR_OTHER_FREQUENCY
    if angular.get("revision") != doa.get("rev"):
        return PAIR_OTHER_REVISION
    return PAIR_SAME_FRAME if angular.get("q") == doa.get("q") else PAIR_SAME_CONFIG


def _doa_candidate(node: Mapping[str, Any], convention: Optional[str]) -> Dict[str, Any]:
    """``doa_candidates.mqtt``: the LIVE DoA with the vector of its LIVE Angular frame."""
    doa = _record(node.get("doa"))
    if doa is None:
        return {
            "available": False,
            "source_format": SOURCE_MQTT,
            "path": "telemetry/doa",
            "error": "no LIVE telemetry/doa (ok=1) in this session",
        }
    reasons = [reason for reason in doa.get("reasons") or [] if isinstance(reason, str)]
    received_age = max(0, _int(doa.get("age_ms")) or 0)
    source_age = _int(doa.get("source_age_ms"))
    age = max(received_age, source_age if source_age is not None else 0)
    a = _number(doa.get("a"))
    c = _number(doa.get("c"))
    p = _number(doa.get("p"))
    f = _int(doa.get("f"))
    confidence_valid = c is not None and c >= 0.0
    frequency_valid = f is not None and 0 < f <= 6_000_000_000
    # DOA_value.html floors its native power at -100 dB; a value there is clipped.
    power_lossy = p is not None and p <= CSV_POWER_FLOOR_DB
    power_valid = p is not None and not power_lossy
    unit_reasons = []
    if not confidence_valid:
        unit_reasons.append("CONFIDENCE_METRIC_INVALID")
    unit_reasons.append("CONFIDENCE_MAPPING_UNVERIFIED")
    if not frequency_valid:
        unit_reasons.append("FREQUENCY_OUT_OF_RANGE")
    if not power_valid:
        unit_reasons.append("POWER_NATIVE_INVALID")
    unit_reasons.append("POWER_MAPPING_UNVERIFIED")
    if power_lossy:
        unit_reasons.append("POWER_FLOOR_LOSSY")
    native_valid = confidence_valid and frequency_valid and power_valid
    candidate: Dict[str, Any] = {
        "available": True,
        "source_format": SOURCE_MQTT,
        "path": "telemetry/doa",
        "q": _int(doa.get("q")),
        "rev": _int(doa.get("rev")),
        "timestamp_ms": _int(doa.get("t")),
        "received_at_ms": _int(doa.get("received_at_ms")),
        "freshness": {
            "timestamp_ms": _int(doa.get("t")),
            "reference_kind": "mqtt_received_at",
            "freshness_known": True,
            # The larger of the age since receipt and since the source time,
            # as the store's LIVE rule bounds both.
            "age_ms": age,
            "raw_age_ms": source_age,
            "received_age_ms": received_age,
            "fresh": doa.get("live") is True,
            "future_skew": "SOURCE_TIME_FUTURE" in reasons,
            "max_age_ms": DOA_FRESH_MS,
            "reasons": reasons,
        },
        "doa_raw_deg": a,
        "angle_convention": f"mqtt_{convention}" if convention else None,
        "angle_raw_deg": a,
        "confidence": None,
        "confidence_metric_db": c,
        "confidence_metric_unit": "dB_papr",
        "confidence_metric_valid": confidence_valid,
        "confidence_unit": "dB_papr_unmapped",
        "confidence_valid": False,
        "confidence_contract_valid": False,
        "confidence_mapping_ready": False,
        "frequency_hz": f,
        "frequency_hz_normalized": f,
        "frequency_unit": "Hz",
        "frequency_valid": frequency_valid,
        "power_db": None,
        "power_native_db": p,
        "power_native_valid": power_valid,
        "power_unit": "dB_spectrum_native_unverified",
        "power_valid": False,
        "power_mapping_lossy": power_lossy,
        "unit_reasons": unit_reasons,
        "native_metrics_valid": native_valid,
        "native_metrics_state": "READY" if native_valid else "NOT_READY",
        "contract_mapping_state": "NOT_READY",
        "units_state": "NOT_READY",
        "units_valid": False,
    }
    theta = theta0_from_doa(a, convention)
    if theta is None:
        candidate["normalization_error"] = MQTT_ANGLE_CONVENTION_UNKNOWN
        candidate["normalization_error_detail"] = "capabilities.angle of this session is not theta_mirror or csv_native"
    else:
        candidate["canonical_angle_deg"] = theta
        candidate["canonical_angle_convention"] = "upstream_theta_0"

    angular = _record(node.get("angular"))
    pairing = angular_pairing(doa, angular)
    candidate["angular_pairing"] = pairing
    if angular is not None:
        candidate["angular_frame"] = _angular_meta(angular, pairing)
    values = angular.get("values") if angular is not None else None
    if pairing in PAIRED and isinstance(values, list) and len(values) == 360:
        vector = [float(value) for value in values]
        peak_index = max(range(360), key=vector.__getitem__)
        peak = vector[peak_index]
        candidate.update({
            "angular_bins": 360,
            "angular_peak_index": peak_index,
            "angular_peak_value": peak,
            "angular_peak_db": peak,
            "angular_power_db": vector,
            "angular_power_min_db": min(vector),
            "angular_power_max_db": max(vector),
            "angular_power_unit": "dB_relative_to_source_floor",
            "angular_power_transform": "preserved_source_shifted_db",
            "angular_power_shifted": True,
            "angular_values_local_only": True,
        })
        # The frame's own peak against its own theta_0: always one record.
        frame_theta = theta0_from_angular(angular.get("raw_doa_deg"))
        distance = None if frame_theta is None else _circular_distance(float(peak_index), frame_theta)
        candidate.update({
            "angular_peak_angle_distance_deg": distance,
            "angular_peak_angle_consistent": None if distance is None else distance <= ANGULAR_PEAK_ANGLE_TOLERANCE_DEG,
            "angular_peak_angle_tolerance_deg": ANGULAR_PEAK_ANGLE_TOLERANCE_DEG,
        })
    return candidate


def _angular_meta(angular: Mapping[str, Any], pairing: str) -> Dict[str, Any]:
    """An Angular frame without its 360 values."""
    return {
        "q": _int(angular.get("q")),
        "timestamp_ms": _int(angular.get("timestamp_ms")),
        "received_at_ms": _int(angular.get("received_at_ms")),
        "age_ms": _int(angular.get("age_ms")),
        "source_age_ms": _int(angular.get("source_age_ms")),
        "max_age_ms": ANGULAR_FRESH_MS,
        "frequency_hz": _int(angular.get("frequency_hz")),
        "revision": _int(angular.get("revision")),
        "vfo": _int(angular.get("vfo")),
        "flags": _int(angular.get("flags")),
        "raw_doa_deg": _number(angular.get("raw_doa_deg")),
        "canonical_angle_deg": theta0_from_angular(angular.get("raw_doa_deg")),
        "peak_index": _int(angular.get("peak_index")),
        "live": angular.get("live") is True,
        "reasons": [reason for reason in angular.get("reasons") or [] if isinstance(reason, str)],
        "pairing": pairing,
    }


def _consistency(candidate: Mapping[str, Any]) -> Dict[str, Any]:
    """DoA against its Angular frame, in the shape of the Data Out CSV/XML check."""
    result: Dict[str, Any] = {
        "source": SOURCE_MQTT,
        "views": ["telemetry/doa", "telemetry/angular"],
        "comparable": False,
        "same_timestamp": False,
        "timestamp_delta_ms": None,
        "timestamp_tolerance_ms": NATIVE_TIMESTAMP_TOLERANCE_MS,
        "frame_relation": "INCOMPLETE",
        "angle_checked": False,
        "angle_invalid": False,
        "conflict": False,
        "tolerance_deg": ANGLE_CONSISTENCY_TOLERANCE_DEG,
    }
    frame = _record(candidate.get("angular_frame"))
    pairing = candidate.get("angular_pairing")
    if frame is None or pairing not in PAIRED or "angular_power_db" not in candidate:
        return result
    doa_t = _int(candidate.get("timestamp_ms"))
    frame_t = _int(frame.get("timestamp_ms"))
    if doa_t is None or frame_t is None:
        return result
    delta = abs(doa_t - frame_t)
    same = pairing == PAIR_SAME_FRAME
    result.update({
        "comparable": True,
        "same_timestamp": delta == 0,
        "timestamp_delta_ms": delta,
        "frame_relation": "SAME_FRAME" if same else "ADJACENT_FRAMES" if delta <= NATIVE_TIMESTAMP_TOLERANCE_MS else "OUT_OF_WINDOW",
    })
    doa_theta = _number(candidate.get("canonical_angle_deg"))
    frame_theta = _number(frame.get("canonical_angle_deg"))
    if doa_theta is not None and frame_theta is not None:
        distance = _circular_distance(doa_theta, frame_theta)
        result.update({"doa_canonical_deg": doa_theta, "angular_canonical_deg": frame_theta, "circular_distance_deg": distance})
        if same:
            # One record: the two angles must agree, or the angle mapping is wrong.
            result["angle_checked"] = True
            result["conflict"] = distance > ANGLE_CONSISTENCY_TOLERANCE_DEG
    return result


def _light_current(light: Optional[Mapping[str, Any]], light_age_ms: Optional[int]) -> Optional[Mapping[str, Any]]:
    """The light read's result while its values still count, else None."""
    if light is None or light_age_ms is None or light_age_ms > LIGHT_VALUES_MAX_AGE_MS:
        return None
    return light


def _status(node: Mapping[str, Any], light: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    health = _record(node.get("health")) or {}
    daq = _int(health.get("daq"))
    daq_health = DAQ_HEALTH.get(daq, "UNKNOWN") if daq is not None else "UNKNOWN"
    detail = _record(node.get("detail"))
    sync = detail.get("sync") if detail is not None and detail.get("stale") is not True else None
    daq_status: Dict[str, Any] = {}
    failed: List[str] = []
    missing: List[str] = []
    for index, name in enumerate(SYNC_FLAGS):
        value = sync[index] if isinstance(sync, list) and len(sync) == 3 else None
        if value is None and daq == 1:
            # daq=1 is the edge's own verdict that all three were true.
            value = True
        if value is None:
            missing.append(name)
            continue
        daq_status[name] = bool(value)
        if value is False:
            failed.append(name)
    safe: Dict[str, Any] = {"timestamp_ms": _int(health.get("t")), "daq_status": daq_status}
    if _int(health.get("drop")) is not None:
        safe["daq_num_dropped_frames"] = health["drop"]
    light_status = _record((light or {}).get("status"))
    if light_status is not None and light_status.get("available") is True:
        gps = (_record(light_status.get("safe")) or {}).get("gps_status")
        if isinstance(gps, str):
            safe["gps_status"] = gps
    return {
        "available": True,
        "source": SOURCE_MQTT,
        "daq_health": daq_health,
        "failed_sync_flags": failed,
        "missing_sync_flags": missing,
        "safe": safe,
        "freshness": None,
    }


def _signal_quality(light: Optional[Mapping[str, Any]], candidate: Mapping[str, Any]) -> Dict[str, Any]:
    quality = copy.deepcopy(_record((light or {}).get("signal_quality"))) if light is not None else None
    if quality is None:
        quality = {
            "state": "UNKNOWN",
            "adc_overdrive": None,
            "adc_overdrive_sources": [],
            "adc_overdrive_reported_by": [],
            "adc_overdrive_channel_mask": None,
            "snr_db": None,
            "snr_source": None,
            "snr_unit": "dB_native_unverified",
            "last_doa_record": {},
            "noise_source_enabled": None,
            "daq_num_dropped_frames": None,
        }
    quality["confidence_metric_db"] = {"mqtt": _number(candidate.get("confidence_metric_db"))}
    quality["confidence_metric_unit"] = "dB_papr_unmapped"
    quality["source"] = "data_out_light" if light is not None else None
    return quality


def _diagnostics(node: Mapping[str, Any], convention: Optional[str]) -> Dict[str, Any]:
    """What MQTT carries besides the LIVE DoA: kept visible, never a valid DoA."""
    def pick(record: Optional[Mapping[str, Any]], keys: Tuple[str, ...]) -> Optional[Dict[str, Any]]:
        if record is None:
            return None
        return {key: copy.deepcopy(record.get(key)) for key in keys}

    unverified = pick(_record(node.get("doa_unverified")), (
        "q", "t", "f", "a", "c", "p", "rev", "trust", "angle_reference", "validation_reasons",
        "received_at_ms", "age_ms", "source_age_ms", "stale",
    ))
    if unverified is not None:
        # ok=0 sends the RAW column 1 (agent.py), which is 360 - theta_0.
        unverified["canonical_angle_deg"] = theta0_from_angular(unverified.get("a"))
    diagnostic_doa = pick(_record(node.get("diagnostic_doa")), (
        "q", "source", "source_timestamp_ms", "observed_timestamp_ms", "raw_doa_deg", "frequency_mhz", "trust",
        "validation_reasons", "received_at_ms", "age_ms", "stale",
    ))
    if diagnostic_doa is not None:
        # doa.xml DOA is theta_0 (the collector's xml_raw_theta).
        raw = _number(diagnostic_doa.get("raw_doa_deg"))
        diagnostic_doa["canonical_angle_deg"] = None if raw is None else raw % 360.0
    angular_unverified = pick(_record(node.get("angular_unverified")), (
        "topic", "q", "timestamp_ms", "frequency_hz", "revision", "vfo", "flags", "raw_doa_deg", "peak_index", "trust",
        "validation_reasons", "received_at_ms", "age_ms", "source_age_ms", "stale",
    ))
    if angular_unverified is not None:
        angular_unverified["canonical_angle_deg"] = theta0_from_angular(angular_unverified.get("raw_doa_deg"))
    session = _record(node.get("session")) or {}
    health = _record(node.get("health")) or {}
    capabilities = _record(node.get("capabilities"))
    angular = _record(node.get("angular"))
    doa = _record(node.get("doa"))
    return {
        "sid": session.get("sid"),
        "cfg": _int(session.get("cfg")),
        "run": session.get("run"),
        "profile": session.get("profile"),
        "clock": session.get("clock"),
        "health": pick(health, ("q", "t", "run", "daq", "clk", "drop", "age", "temp", "rev", "received_at_ms", "age_ms", "fresh")),
        "capabilities": pick(capabilities, ("angle", "native_axis", "count", "profiles", "version", "session_match")),
        "angle_convention": convention,
        "doa": pick(doa, ("q", "t", "f", "rev", "live", "reasons", "received_at_ms", "age_ms", "source_age_ms")),
        "angular": None if angular is None else _angular_meta(angular, angular_pairing(doa, angular)),
        "doa_unverified": unverified,
        "diagnostic_doa": diagnostic_doa,
        "angular_unverified": angular_unverified,
    }


def _overall_and_gate(
    candidate: Mapping[str, Any],
    consistency: Mapping[str, Any],
    diagnostics: Mapping[str, Any],
    overdrive: Optional[bool],
) -> Tuple[str, Dict[str, Any]]:
    parsed = candidate.get("available") is True and "canonical_angle_deg" in candidate
    fresh = parsed and (_record(candidate.get("freshness")) or {}).get("fresh") is True
    vector = "angular_power_db" in candidate
    conflict = consistency.get("conflict") is True
    peak_consistent = candidate.get("angular_peak_angle_consistent")
    unverified = _record(diagnostics.get("doa_unverified"))
    unverified_current = unverified is not None and unverified.get("stale") is not True

    reasons: List[str] = ["GROUND_CLOCK_UNVERIFIED"]
    if overdrive is True:
        reasons.append("ADC_OVERDRIVE")
    if candidate.get("available") is not True:
        reasons.append(MQTT_DOA_UNVERIFIED if unverified_current else MQTT_NO_DOA)
    else:
        if not parsed:
            reasons.append(MQTT_ANGLE_CONVENTION_UNKNOWN)
        if not (_record(candidate.get("freshness")) or {}).get("fresh"):
            reasons.append("DOA_CANDIDATES_STALE")
        if not vector:
            reasons.append(MQTT_ANGULAR_UNAVAILABLE)
    if conflict:
        reasons.append(MQTT_DOA_ANGULAR_CONFLICT)
    if peak_consistent is False:
        reasons.append("ANGULAR_PEAK_ANGLE_MISMATCH")
    reasons.extend(["CANONICAL_ANGLE_NOT_CONFIGURED", "DOA_AUTHORITY_NOT_SELECTED"])
    checks = {
        "mqtt_health_fresh": True,
        "daq_healthy": True,
        "adc_not_overdriven": None if overdrive is None else not overdrive,
        "node_not_stalled": True,
        "doa_candidate_parsed": parsed,
        "doa_candidate_fresh": fresh,
        "angular_vector_live": vector,
        "authority_selected": False,
        "selected_doa_fresh": False,
        "selected_units_valid": False,
        "canonical_angle_ready": False,
        "native_views_consistent": not conflict,
        "angular_peak_consistent": peak_consistent is not False,
    }
    # The collector's order: DEGRADED, CONFLICT, STALE, INCOMPLETE, then
    # UNVERIFIED, which is as far as the console ever goes.
    if overdrive is True:
        state = "DEGRADED"
    elif conflict:
        state = "CONFLICT"
    elif candidate.get("available") is True:
        state = "STALE" if not (_record(candidate.get("freshness")) or {}).get("fresh") else (
            "INCOMPLETE" if not parsed or not vector else "UNVERIFIED")
    else:
        state = "UNVERIFIED" if unverified_current else "STALE"
    return state, {"state": "BLOCKED", "checks": checks, "reasons": reasons}


def mqtt_snapshot(
    view: Mapping[str, Any],
    light: Optional[Mapping[str, Any]],
    *,
    base_url: str,
    light_age_ms: Optional[int],
    light_meta: Mapping[str, Any],
) -> Dict[str, Any]:
    """The /api/snapshot answer from MQTT, in the TelemetrySnapshot shape.

    ``light`` is the last light Data Out read (``collect_light``) or None,
    ``light_age_ms`` how long ago it completed, and ``light_meta`` what the
    reader says about it (interval, reason, running, error).
    """
    node = _record(view.get("node")) or {}
    now_ms = _int(view.get("now_ms")) or 0
    convention = angle_convention(node)
    candidate = _doa_candidate(node, convention)
    consistency = _consistency(candidate)
    diagnostics = _diagnostics(node, convention)
    current_light = _light_current(light, light_age_ms)
    quality = _signal_quality(current_light, candidate)
    overdrive = quality.get("adc_overdrive")
    overall, gate = _overall_and_gate(candidate, consistency, diagnostics, overdrive if isinstance(overdrive, bool) else None)
    health = _record(node.get("health")) or {}

    settings: Dict[str, Any]
    light_settings = _record((light or {}).get("settings"))
    if light_settings is not None:
        settings = copy.deepcopy(light_settings)
    else:
        settings = {"available": False, "redacted": True, "raw_fields_omitted": True, "reused": False, "read_at_ms": None,
                    "error": "settings.json not read yet"}
    light_collection = _record((light or {}).get("collection")) or {}
    settings_age = _int(light_collection.get("settings_age_ms"))
    if settings_age is not None and light_age_ms is not None:
        settings_age += light_age_ms

    data_out_light = {
        **dict(light_meta),
        "age_ms": light_age_ms,
        "read_at_ms": _int((light or {}).get("completed_at_ms")),
        "status": copy.deepcopy(_record((light or {}).get("status"))),
        "xml": copy.deepcopy(_record((light or {}).get("xml"))),
        "resources": copy.deepcopy(_record((light or {}).get("resources")) or {}),
        "host_resolution": copy.deepcopy(light_collection.get("host_resolution")),
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "source": {
            "kind": SOURCE_MQTT,
            "reason": MQTT_FRESH,
            "reasons": [],
            "mqtt": mqtt_summary(view, True),
            "data_out": {
                "read": "light",
                "available": (_record((light or {}).get("status")) or {}).get("available") is True,
                "interval_s": light_meta.get("interval_s"),
                "age_ms": light_age_ms,
            },
        },
        "collector": {
            "mode": "read_only",
            "source": SOURCE_MQTT,
            "base_url": base_url.rstrip("/"),
            "node_id": view.get("node_id"),
            "authority_config": "none",
            "clock_source": "remote_unverified",
            "mqtt_publish": False,
            "raw_settings_omitted": True,
            "raw_angular_values_omitted": True,
            "angular_plot_local_only": True,
        },
        "observed_at_ms": now_ms,
        "completed_at_ms": now_ms,
        "collection": {
            "source": SOURCE_MQTT,
            "elapsed_ms": 0,
            "budget_ms": None,
            "deadline_exceeded": False,
            "status_transport_failed": False,
            "settings_reused": settings.get("reused") is True,
            "settings_age_ms": settings_age,
            "host_resolution": copy.deepcopy(light_collection.get("host_resolution")),
        },
        "resources": copy.deepcopy(_record((light or {}).get("resources")) or {}),
        "status": _status(node, light),
        "settings": settings,
        "doa_candidates": {SOURCE_MQTT: candidate},
        "authority": {
            "selected": None,
            "selected_doa": None,
            "raw_and_canonical_separated": True,
            "canonical_angle_ready": False,
        },
        "native_consistency": consistency,
        "node_progress": {
            "source": SOURCE_MQTT,
            "state": "ADVANCING",
            "stalled": False,
            "stalled_counters": [],
            "changed_counters": [],
            "unchanged_for_ms": {},
            "regressed_counters": [],
            "max_stall_ms": HEALTH_FRESH_MS,
            "samples": 0,
            "health_q": _int(health.get("q")),
        },
        "signal_quality": quality,
        "publication_gate": gate,
        "overall_state": overall,
        "mqtt": diagnostics,
        "data_out_light": data_out_light,
    }


__all__ = [
    "DATA_OUT_REQUESTED",
    "DATA_OUT_UNAVAILABLE",
    "LIGHT_READ_INTERVAL_S",
    "MQTT_FRESH",
    "SOURCE_DATA_OUT",
    "SOURCE_MQTT",
    "SOURCE_NONE",
    "mqtt_freshness",
    "mqtt_mark",
    "mqtt_snapshot",
    "with_source",
]
