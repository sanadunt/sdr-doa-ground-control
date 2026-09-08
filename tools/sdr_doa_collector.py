#!/usr/bin/env python3
"""Read-only SDR-DoA Data Out collector.

This module deliberately has no MQTT client and no write path to the node. It
fetches known read-only resources, parses them according to their bytes, and
returns a bounded, redacted assessment. The default authority is ``none`` so
DoA publication remains blocked until an independent source-authority decision
is made.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import sys
import time
import urllib.error
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

SCHEMA_VERSION = 1
DEFAULT_TIMEOUT_SECONDS = 5.0
DEFAULT_MAX_BODY_BYTES = 128 * 1024
DEFAULT_STATUS_MAX_AGE_MS = 10_000
DEFAULT_DOA_MAX_AGE_MS = 5_000
DEFAULT_MAX_FUTURE_SKEW_MS = 5_000
ANGLE_CONSISTENCY_TOLERANCE_DEG = 1.0
ANGULAR_PEAK_ANGLE_TOLERANCE_DEG = 3.0
# CSV and XML are separate files updated by the node. A bounded read sequence
# can observe adjacent records with different node timestamps; exact equality
# would incorrectly quarantine a healthy live pair.
NATIVE_TIMESTAMP_TOLERANCE_MS = 2_000
DEFAULT_ALLOWED_DATA_HOSTS = frozenset({
    "doasdr.local",
    "192.168.100.100",
    "127.0.0.1",
    "localhost",
})

PATH_STATUS = "/status.json"
PATH_SETTINGS = "/settings.json"
PATH_CSV = "/DOA_value.html"
PATH_XML = "/doa.xml"

STATUS_FIELDS = (
    "timestamp_ms",
    "station_id",
    "hardware_id",
    "unit_id",
    "host_os_type",
    "host_os_version",
    "host_os_architecture",
    "software_version",
    "software_git_short_hash",
    "uptime_ms",
    "gps_status",
    "daq_status",
    "daq_ok",
    "daq_num_dropped_frames",
)

DAQ_STATUS_FIELDS = (
    "data_frame_index",
    "frame_sync",
    "sample_delay_sync",
    "iq_sync",
    "noise_source_enabled",
    "adc_overdrive",
    "sampling_frequency_hz",
    "bandwidth_hz",
    "decimated_bandwidth_hz",
    "buffer_size_ms",
)

SAFE_SETTINGS_FIELDS = (
    "center_freq",
    "uniform_gain",
    "data_interface",
    "en_doa",
    "doa_method",
    "doa_decorrelation_method",
    "ant_arrangement",
    "ant_spacing_meters",
    "active_vfos",
    "output_vfo",
    "vfo_mode",
    "doa_fig_type",
    "compass_offset",
    "location_source",
    "gps_fixed_heading",
    "en_remote_control",
    "en_peak_hold",
)
EFFECTIVE_SETTINGS_FIELDS = (
    "center_freq",
    "uniform_gain",
    "ant_arrangement",
    "doa_method",
    "active_vfos",
    "output_vfo",
)


def settings_are_effective(settings: Mapping[str, Any]) -> bool:
    """Return true only when the fields needed for state/config are present."""
    return bool(
        settings.get("available") is True
        and isinstance(settings.get("fields"), Mapping)
        and all(field in settings["fields"] for field in EFFECTIVE_SETTINGS_FIELDS)
    )




class CollectorError(ValueError):
    """Raised when a resource body violates the expected bounded schema."""


@dataclass(frozen=True)
class FetchedResource:
    path: str
    url: str
    ok: bool
    http_status: Optional[int]
    content_type: Optional[str]
    body: bytes
    retrieved_at_ms: int
    error: Optional[str] = None

    def metadata(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "path": self.path,
            "url": _redact_url(self.url),
            "ok": self.ok,
            "retrieved_at_ms": self.retrieved_at_ms,
        }
        if self.http_status is not None:
            result["http_status"] = self.http_status
        if self.content_type:
            result["content_type"] = self.content_type
        if self.ok:
            result["body_bytes"] = len(self.body)
        if self.error:
            result["error"] = self.error
        return result


def now_ms() -> int:
    return int(time.time() * 1000)


def _finite_float(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise CollectorError(f"{field} must be numeric, not boolean")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise CollectorError(f"{field} is not numeric") from exc
    if not math.isfinite(parsed):
        raise CollectorError(f"{field} is not finite")
    return parsed


def _finite_int(value: Any, field: str) -> int:
    parsed = _finite_float(value, field)
    if not parsed.is_integer():
        raise CollectorError(f"{field} must be an integer")
    return int(parsed)


def _required_text(value: Any, field: str) -> str:
    if value is None:
        raise CollectorError(f"{field} is missing")
    text = str(value).strip()
    if not text:
        raise CollectorError(f"{field} is empty")
    return text


def _optional_scalar(value: Any) -> Any:
    """Keep only bounded JSON scalar values for the safe settings subset."""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return value
    return None


def _age_assessment(
    timestamp_ms: int,
    reference_ms: int,
    max_age_ms: int,
    max_future_skew_ms: int,
    reference_kind: str,
    freshness_known: bool = True,
) -> Dict[str, Any]:
    age_ms = reference_ms - timestamp_ms
    return {
        "timestamp_ms": timestamp_ms,
        "reference_ms": reference_ms,
        "reference_kind": reference_kind,
        "freshness_known": freshness_known,
        "age_ms": max(0, age_ms) if freshness_known else None,
        "raw_age_ms": age_ms if freshness_known else None,
        # A later file read can legitimately observe a newer node record than
        # the status sample read first. Treat a bounded future delta as fresh;
        # only an excessive future timestamp is rejected. Expose effective age
        # as non-negative while retaining raw_age_ms for diagnostics.
        "fresh": (-max_future_skew_ms <= age_ms <= max_age_ms) if freshness_known else None,
        "future_skew": (age_ms < -max_future_skew_ms) if freshness_known else None,
        "max_age_ms": max_age_ms,
    }


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        raise CollectorError("HTTP redirect is not allowed")


def _redact_url(url: Any) -> str:
    """Return URL metadata without userinfo, query, or fragment."""
    try:
        parsed = urllib.parse.urlsplit(str(url))
        if not parsed.scheme or not parsed.hostname:
            return "<invalid-url>"
        host = parsed.hostname
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        port = f":{parsed.port}" if parsed.port is not None else ""
        return f"{parsed.scheme}://{host}{port}"
    except (TypeError, ValueError):
        return "<invalid-url>"


def _validate_base_url(base_url: str, allowed_hosts: Set[str]) -> str:
    if not isinstance(base_url, str) or not base_url:
        raise ValueError("base_url must be a non-empty string")
    parsed = urllib.parse.urlsplit(base_url)
    if parsed.scheme != "http":
        raise ValueError("base_url must use http")
    if parsed.username or parsed.password:
        raise ValueError("base_url userinfo is not allowed")
    if parsed.query or parsed.fragment or not parsed.hostname:
        raise ValueError("base_url must not contain query/fragment and must have a host")
    hostname = parsed.hostname.lower().rstrip(".")
    if hostname not in {item.lower().rstrip(".") for item in allowed_hosts}:
        raise ValueError("base_url host is not allowlisted")
    if parsed.port not in (None, 8081):
        raise ValueError("base_url port is not allowlisted")
    return base_url.rstrip("/")


def fetch_resource(
    base_url: str,
    path: str,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
    allowed_hosts: Optional[Set[str]] = None,
) -> FetchedResource:
    """Fetch one known resource with a bounded read-only GET."""
    allowed = DEFAULT_ALLOWED_DATA_HOSTS if allowed_hosts is None else allowed_hosts
    try:
        safe_base = _validate_base_url(base_url, set(allowed))
    except ValueError as exc:
        return FetchedResource(path, str(base_url), False, None, None, b"", now_ms(), str(exc))
    if path not in {PATH_STATUS, PATH_SETTINGS, PATH_CSV, PATH_XML}:
        raise ValueError("resource path is not allowlisted")
    url = safe_base + path
    retrieved_at_ms = now_ms()
    request = urllib.request.Request(
        url,
        method="GET",
        headers={"Accept": "application/json, application/xml, text/plain, */*"},
    )
    opener = urllib.request.build_opener(_NoRedirectHandler)
    try:
        with opener.open(request, timeout=timeout_seconds) as response:
            status = getattr(response, "status", None) or response.getcode()
            content_type = response.headers.get("Content-Type")
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    if int(content_length) > max_body_bytes:
                        raise CollectorError(f"body exceeds {max_body_bytes} bytes")
                except ValueError:
                    pass
            chunks: List[bytes] = []
            total = 0
            while True:
                chunk = response.read(min(16 * 1024, max_body_bytes - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > max_body_bytes:
                    raise CollectorError(f"body exceeds {max_body_bytes} bytes")
                chunks.append(chunk)
            return FetchedResource(
                path=path,
                url=url,
                ok=200 <= int(status) < 300,
                http_status=int(status),
                content_type=content_type,
                body=b"".join(chunks),
                retrieved_at_ms=retrieved_at_ms,
            )
    except (urllib.error.URLError, TimeoutError, OSError, CollectorError) as exc:
        return FetchedResource(
            path=path,
            url=url,
            ok=False,
            http_status=None,
            content_type=None,
            body=b"",
            retrieved_at_ms=retrieved_at_ms,
            error=type(exc).__name__ if isinstance(exc, CollectorError) else "resource fetch failed",
        )


def _parse_json_body(resource: FetchedResource) -> Mapping[str, Any]:
    if not resource.ok:
        raise CollectorError(resource.error or "resource unavailable")
    try:
        value = json.loads(resource.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CollectorError(f"invalid JSON at {resource.path}") from exc
    if not isinstance(value, dict):
        raise CollectorError(f"expected JSON object at {resource.path}")
    return value


def fetch_and_parse_with_retry(
    base_url: str,
    path: str,
    parser: Any,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
    attempts: int = 3,
    retry_delay_seconds: float = 0.05,
    fetcher: Any = fetch_resource,
) -> Tuple[FetchedResource, Optional[Dict[str, Any]]]:
    """Read and parse a known resource with bounded partial-file retries."""
    if attempts < 1 or attempts > 5:
        raise ValueError("attempts must be between 1 and 5")
    last_resource: Optional[FetchedResource] = None
    last_error: Optional[Exception] = None
    for attempt in range(attempts):
        resource = fetcher(base_url, path, timeout_seconds, max_body_bytes)
        last_resource = resource
        if resource.ok:
            try:
                return resource, parser(resource)
            except (CollectorError, ValueError, TypeError, json.JSONDecodeError) as exc:
                last_error = exc
        else:
            last_error = CollectorError(resource.error or "resource unavailable")
        if attempt + 1 < attempts:
            time.sleep(max(0.0, retry_delay_seconds))
    if last_resource is None:
        raise CollectorError("resource fetch produced no result")
    if last_error is not None:
        return last_resource, {"available": False, "error": str(last_error)}
    return last_resource, {"available": False, "error": "resource parse failed"}


def parse_status(resource: FetchedResource) -> Dict[str, Any]:
    source = _parse_json_body(resource)
    timestamp_ms = _finite_int(source.get("timestamp_ms"), "status.timestamp_ms")
    if not isinstance(source.get("daq_ok"), bool):
        raise CollectorError("status.daq_ok must be boolean")
    dropped = _finite_int(source.get("daq_num_dropped_frames"), "status.daq_num_dropped_frames")
    if dropped < 0:
        raise CollectorError("status.daq_num_dropped_frames must be non-negative")

    daq_source = source.get("daq_status")
    if daq_source is None:
        daq_source = {}
    if not isinstance(daq_source, dict):
        raise CollectorError("status.daq_status must be an object")

    daq_status: Dict[str, Any] = {}
    for field in DAQ_STATUS_FIELDS:
        if field not in daq_source:
            continue
        value = daq_source[field]
        if field in {"frame_sync", "sample_delay_sync", "iq_sync", "noise_source_enabled", "adc_overdrive"}:
            if not isinstance(value, bool):
                raise CollectorError(f"status.daq_status.{field} must be boolean")
            daq_status[field] = value
        elif field == "buffer_size_ms":
            daq_status[field] = _finite_float(value, f"status.daq_status.{field}")
        else:
            daq_status[field] = _finite_int(value, f"status.daq_status.{field}")

    sync_fields = ("frame_sync", "sample_delay_sync", "iq_sync")
    failed_flags = [field for field in sync_fields if daq_status.get(field) is False]
    missing_flags = [field for field in sync_fields if field not in daq_status]
    if source["daq_ok"] is False or failed_flags:
        daq_health = "FAIL"
    elif missing_flags:
        daq_health = "UNKNOWN"
    else:
        daq_health = "PASS"

    safe: Dict[str, Any] = {}
    for field in STATUS_FIELDS:
        if field == "daq_status":
            safe[field] = daq_status
        elif field in source:
            value = source[field]
            if field in {"timestamp_ms", "unit_id", "uptime_ms", "daq_num_dropped_frames"}:
                safe[field] = _finite_int(value, f"status.{field}")
            elif field in {"station_id", "hardware_id", "host_os_type", "host_os_version", "host_os_architecture", "software_version", "software_git_short_hash", "gps_status"}:
                safe[field] = None if value is None else str(value)
            elif field == "daq_ok":
                safe[field] = bool(value)

    return {
        "available": True,
        "safe": safe,
        "daq_health": daq_health,
        "failed_sync_flags": failed_flags,
        "missing_sync_flags": missing_flags,
    }


def parse_settings(resource: FetchedResource) -> Dict[str, Any]:
    source = _parse_json_body(resource)
    safe: Dict[str, Any] = {}
    for field in SAFE_SETTINGS_FIELDS:
        if field in source:
            value = _optional_scalar(source[field])
            if value is not None:
                safe[field] = value
    return {
        "available": True,
        "redacted": True,
        "fields": safe,
        "raw_fields_omitted": True,
    }


def _parse_csv_row(resource: FetchedResource) -> List[str]:
    if not resource.ok:
        raise CollectorError(resource.error or "resource unavailable")
    try:
        text = resource.body.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CollectorError("DoA CSV is not UTF-8") from exc
    rows = [row for row in csv.reader(io.StringIO(text)) if row]
    if len(rows) != 1:
        raise CollectorError(f"expected one CSV row, found {len(rows)}")
    if len(rows[0]) != 377:
        raise CollectorError(f"expected 377 CSV fields, found {len(rows[0])}")
    return rows[0]


def parse_csv_doa(
    resource: FetchedResource,
    reference_ms: int,
    max_age_ms: int = DEFAULT_DOA_MAX_AGE_MS,
    max_future_skew_ms: int = DEFAULT_MAX_FUTURE_SKEW_MS,
    reference_kind: str = "local_observed_at",
    freshness_known: bool = True,
) -> Dict[str, Any]:
    row = _parse_csv_row(resource)
    timestamp_ms = _finite_int(row[0], "csv.timestamp_ms")
    angular_values = [_finite_float(value, f"csv.angular_power[{index}]") for index, value in enumerate(row[17:])]
    # ``DOA_plot_util`` in the node has already converted the estimator to dB
    # and the CSV writer shifts that dB vector by its minimum before writing it.
    # Preserve those values for the local plot. Applying abs()/log10() here
    # would reinterpret dB as linear power and visibly flatten/distort peaks.
    # A signed value is still a valid fixture/input: a peak is the greatest
    # signed dB value (closest to zero), never the greatest magnitude.
    peak_index = max(range(len(angular_values)), key=angular_values.__getitem__)
    angular_peak_value = angular_values[peak_index]
    angular_power_db = list(angular_values)
    return {
        "available": True,
        "source_format": "csv",
        "path": resource.path,
        "timestamp_ms": timestamp_ms,
        "freshness": _age_assessment(
            timestamp_ms,
            reference_ms,
            max_age_ms,
            max_future_skew_ms,
            reference_kind,
            freshness_known,
        ),
        "doa_raw_deg": _finite_float(row[1], "csv.doa_raw_deg"),
        "angle_convention": "csv_360_minus_theta",
        "confidence_raw": _finite_float(row[2], "csv.confidence_raw"),
        "power_raw": _finite_float(row[3], "csv.power_raw"),
        "frequency_hz": _finite_int(row[4], "csv.frequency_hz"),
        "array_type": row[5].strip(),
        "acquisition_frame_latency_ms": _finite_float(row[6], "csv.acquisition_frame_latency_ms"),
        "station_id": row[7].strip(),
        "latitude": _finite_float(row[8], "csv.latitude"),
        "longitude": _finite_float(row[9], "csv.longitude"),
        "gps_heading": _finite_float(row[10], "csv.gps_heading"),
        "compass_heading": _finite_float(row[11], "csv.compass_heading"),
        "heading_source": row[12].strip(),
        "reserved_fields": row[13:17],
        "angular_bins": len(angular_values),
        "angular_peak_index": peak_index,
        "angular_peak_value": angular_peak_value,
        # Keep peak metadata on the same signed scale as the preserved vector.
        "angular_peak_db": angular_peak_value,
        "angular_power_db": angular_power_db,
        "angular_power_min_db": min(angular_values),
        "angular_power_max_db": max(angular_values),
        "angular_power_unit": "dB_relative_to_source_floor",
        "angular_power_transform": "preserved_source_shifted_db",
        "angular_power_shifted": True,
        "angular_values_local_only": True,
    }


def _xml_text(root: ET.Element, path: str, required: bool = True) -> Optional[str]:
    value = root.findtext(path)
    if required:
        return _required_text(value, f"xml.{path}")
    return None if value is None else value.strip()


def parse_xml_doa(
    resource: FetchedResource,
    reference_ms: int,
    max_age_ms: int = DEFAULT_DOA_MAX_AGE_MS,
    max_future_skew_ms: int = DEFAULT_MAX_FUTURE_SKEW_MS,
    reference_kind: str = "local_observed_at",
    freshness_known: bool = True,
) -> Dict[str, Any]:
    if not resource.ok:
        raise CollectorError(resource.error or "resource unavailable")
    try:
        root = ET.fromstring(resource.body)
    except (UnicodeDecodeError, ET.ParseError) as exc:
        raise CollectorError("invalid DoA XML") from exc
    if root.tag != "DATA":
        raise CollectorError(f"expected XML root DATA, found {root.tag}")

    timestamp_ms = _finite_int(_xml_text(root, "TIME"), "xml.TIME")
    return {
        "available": True,
        "source_format": "xml",
        "path": resource.path,
        "timestamp_ms": timestamp_ms,
        "freshness": _age_assessment(
            timestamp_ms,
            reference_ms,
            max_age_ms,
            max_future_skew_ms,
            reference_kind,
            freshness_known,
        ),
        "doa_raw_deg": _finite_float(_xml_text(root, "DOA"), "xml.DOA"),
        "angle_convention": "xml_raw_theta",
        "confidence_raw_percent": _finite_float(_xml_text(root, "CONF"), "xml.CONF"),
        "power_transformed_raw": _finite_float(_xml_text(root, "PWR"), "xml.PWR"),
        "frequency_mhz": _finite_float(_xml_text(root, "FREQUENCY"), "xml.FREQUENCY"),
        "station_id": _required_text(_xml_text(root, "STATION_ID"), "xml.STATION_ID"),
        "gps_time": _finite_int(_xml_text(root, "GPS_TIME"), "xml.GPS_TIME"),
        "latitude": _finite_float(_xml_text(root, "LOCATION/LATITUDE"), "xml.LOCATION/LATITUDE"),
        "longitude": _finite_float(_xml_text(root, "LOCATION/LONGITUDE"), "xml.LOCATION/LONGITUDE"),
        "heading": _finite_float(_xml_text(root, "LOCATION/HEADING"), "xml.LOCATION/HEADING"),
        "speed": _finite_float(_xml_text(root, "LOCATION/SPEED"), "xml.LOCATION/SPEED"),
        "acquisition_frame_latency_ms": _finite_float(_xml_text(root, "LATENCY"), "xml.LATENCY"),
        "processing_time_ms": _finite_float(_xml_text(root, "PROCESSING_TIME"), "xml.PROCESSING_TIME"),
        "adc_overdrive": _required_text(_xml_text(root, "ADC_OVERDRIVE"), "xml.ADC_OVERDRIVE"),
        "correlated_sources": _finite_int(_xml_text(root, "NUM_CORRELATED_SOURCES"), "xml.NUM_CORRELATED_SOURCES"),
        "snr_db": _finite_float(_xml_text(root, "SNR_DB"), "xml.SNR_DB"),
    }


def _unavailable(resource: FetchedResource) -> Dict[str, Any]:
    return {
        "available": False,
        "source_format": "csv" if resource.path == PATH_CSV else "xml",
        "path": resource.path,
        "error": resource.error or "resource unavailable",
    }


def _parse_or_error(parser: Any, resource: FetchedResource, *args: Any) -> Dict[str, Any]:
    try:
        return parser(resource, *args)
    except CollectorError as exc:
        format_name = "csv" if resource.path == PATH_CSV else "xml"
        return {
            "available": False,
            "source_format": format_name,
            "path": resource.path,
            "error": str(exc),
        }


def _canonicalize_native_angle(candidate: Mapping[str, Any]) -> float:
    """Convert native output to the upstream theta-0 convention.

    The upstream writer stores ``360 - theta_0`` in the CSV-compatible view and
    stores ``theta_0`` in XML. Keeping this conversion explicit prevents the
    two native views from being silently treated as the same bearing.
    """
    raw = _finite_float(candidate.get("doa_raw_deg"), "candidate.doa_raw_deg")
    if not 0.0 <= raw <= 360.0:
        raise CollectorError("candidate.doa_raw_deg is outside [0, 360]")
    if candidate.get("angle_convention") == "csv_360_minus_theta":
        return (360.0 - raw) % 360.0
    if candidate.get("angle_convention") == "xml_raw_theta":
        return raw % 360.0
    raise CollectorError("unknown native angle convention")


def normalize_doa_candidate(
    candidate: Mapping[str, Any],
    *,
    power_mapping_ready: bool = False,
) -> Dict[str, Any]:
    """Keep native metrics lossless and expose contract readiness separately.

    The upstream confidence value is a PAPR-like metric in dB, not a probability:
    ``10*log10(max(abs(DOA))/mean(abs(DOA)))``. The XML writer multiplies that
    metric by 100 for its integer ``CONF`` field. Neither native value can be
    converted to the MQTT contract's 0..1 confidence without calibration, so the
    native metric remains available while the contract field stays unavailable.
    """
    result = dict(candidate)
    raw_angle = _finite_float(candidate.get("doa_raw_deg"), "candidate.doa_raw_deg")
    result["canonical_angle_deg"] = _canonicalize_native_angle(candidate)
    result["canonical_angle_convention"] = "upstream_theta_0"
    confidence_metric_db: float
    confidence_metric_valid: bool
    frequency_valid: bool
    power_native_db: Optional[float]
    power_native_valid: bool
    power_mapping_lossy = False

    if candidate.get("source_format") == "csv":
        confidence_metric_db = _finite_float(candidate.get("confidence_raw"), "csv.confidence_raw")
        confidence_metric_valid = math.isfinite(confidence_metric_db) and confidence_metric_db >= 0.0
        frequency_hz = _finite_int(candidate.get("frequency_hz"), "csv.frequency_hz")
        power_native_db = _finite_float(candidate.get("power_raw"), "csv.power_raw")
        frequency_valid = 0 < frequency_hz <= 6_000_000_000
        power_native_valid = math.isfinite(power_native_db)
        result.update(
            {
                "confidence": None,
                "confidence_metric_db": confidence_metric_db,
                "confidence_metric_unit": "dB_papr",
                "confidence_metric_valid": confidence_metric_valid,
                "confidence_unit": "dB_papr_unmapped",
                "confidence_valid": False,
                "confidence_contract_valid": False,
                "confidence_mapping_ready": False,
                "frequency_hz_normalized": frequency_hz,
                "frequency_unit": "Hz",
                "frequency_valid": frequency_valid,
                "power_db": power_native_db if power_mapping_ready and power_native_valid else None,
                "power_native_db": power_native_db,
                "power_native_valid": power_native_valid,
                "power_unit": "dB_spectrum_native_unverified",
                "power_valid": bool(power_mapping_ready and power_native_valid),
            }
        )
    elif candidate.get("source_format") == "xml":
        confidence_raw = _finite_float(candidate.get("confidence_raw_percent"), "xml.CONF")
        frequency_mhz = _finite_float(candidate.get("frequency_mhz"), "xml.FREQUENCY")
        transformed_power = _finite_float(candidate.get("power_transformed_raw"), "xml.PWR")
        confidence_metric_db = confidence_raw / 100.0
        confidence_metric_valid = math.isfinite(confidence_metric_db) and confidence_metric_db >= 0.0
        frequency_valid = 0.0 < frequency_mhz <= 6_000.0
        # Upstream writes max(-100, native_power_db + 100). A transformed value
        # at -100 is clipped and cannot be inverted precisely; values above the
        # floor can be represented as a traceable native estimate, not yet a
        # calibrated MQTT dB.
        power_mapping_lossy = transformed_power <= -100.0
        power_native_db = transformed_power - 100.0
        power_native_valid = math.isfinite(power_native_db) and not power_mapping_lossy
        result.update(
            {
                "confidence": None,
                "confidence_metric_db": confidence_metric_db,
                "confidence_metric_unit": "dB_papr",
                "confidence_metric_valid": confidence_metric_valid,
                "confidence_unit": "source_dB_papr_times_100",
                "confidence_valid": False,
                "confidence_contract_valid": False,
                "confidence_mapping_ready": False,
                "frequency_hz_normalized": int(round(frequency_mhz * 1_000_000.0)),
                "frequency_unit": "MHz_to_Hz",
                "frequency_valid": frequency_valid,
                "power_db": power_native_db if power_mapping_ready and power_native_valid else None,
                "power_native_db": power_native_db,
                "power_native_valid": power_native_valid,
                "power_unit": "dB_spectrum_native_unverified",
                "power_valid": bool(power_mapping_ready and power_native_valid),
                "power_transformed_raw": transformed_power,
                "power_mapping_lossy": power_mapping_lossy,
            }
        )
    else:
        raise CollectorError("unknown native angle convention")

    unit_reasons: List[str] = []
    if not confidence_metric_valid:
        unit_reasons.append("CONFIDENCE_METRIC_INVALID")
    if not result.get("confidence_mapping_ready"):
        unit_reasons.append("CONFIDENCE_MAPPING_UNVERIFIED")
    if not frequency_valid:
        unit_reasons.append("FREQUENCY_OUT_OF_RANGE")
    if not power_native_valid:
        unit_reasons.append("POWER_NATIVE_INVALID")
    if not result.get("power_valid"):
        unit_reasons.append(
            "POWER_MAPPING_UNVERIFIED" if not power_mapping_ready else "POWER_VALUE_INVALID"
        )
    if power_mapping_lossy:
        unit_reasons.append("POWER_FLOOR_LOSSY")
    result["unit_reasons"] = unit_reasons
    result["native_metrics_valid"] = bool(confidence_metric_valid and frequency_valid and power_native_valid)
    result["native_metrics_state"] = "READY" if result["native_metrics_valid"] else "NOT_READY"
    result["contract_mapping_state"] = "READY" if not unit_reasons else "NOT_READY"
    result["units_state"] = result["contract_mapping_state"]
    result["angle_raw_deg"] = raw_angle
    result["units_valid"] = not unit_reasons
    return result


def _circular_angle_distance(first: float, second: float) -> float:
    delta = abs((first - second) % 360.0)
    return min(delta, 360.0 - delta)


def assess_native_conflict(candidates: Mapping[str, Mapping[str, Any]]) -> Dict[str, Any]:
    """Compare adjacent native views without requiring byte-identical timestamps.

    CSV and XML are independent files rewritten by the node. A sequential GET
    can therefore observe two neighboring processing frames. They remain
    comparable when their node timestamps are within the bounded pair window;
    a same-timestamp pair is still treated as the strongest correlation case.
    """
    csv_candidate = candidates.get("csv", {})
    xml_candidate = candidates.get("xml", {})
    available = bool(csv_candidate.get("available")) and bool(xml_candidate.get("available"))
    csv_timestamp = csv_candidate.get("timestamp_ms")
    xml_timestamp = xml_candidate.get("timestamp_ms")
    timestamp_delta_ms: Optional[int] = None
    if available and isinstance(csv_timestamp, int) and isinstance(xml_timestamp, int):
        timestamp_delta_ms = abs(csv_timestamp - xml_timestamp)
    comparable = bool(available and timestamp_delta_ms is not None and timestamp_delta_ms <= NATIVE_TIMESTAMP_TOLERANCE_MS)
    result: Dict[str, Any] = {
        "comparable": comparable,
        "same_timestamp": bool(comparable and timestamp_delta_ms == 0),
        "timestamp_delta_ms": timestamp_delta_ms,
        "timestamp_tolerance_ms": NATIVE_TIMESTAMP_TOLERANCE_MS,
        "conflict": False,
        "tolerance_deg": ANGLE_CONSISTENCY_TOLERANCE_DEG,
    }
    if not comparable:
        return result
    try:
        csv_angle = _canonicalize_native_angle(csv_candidate)
        xml_angle = _canonicalize_native_angle(xml_candidate)
    except CollectorError as exc:
        result["error"] = str(exc)
        result["conflict"] = True
        return result
    distance = _circular_angle_distance(csv_angle, xml_angle)
    result.update({
        "csv_canonical_deg": csv_angle,
        "xml_canonical_deg": xml_angle,
        "circular_distance_deg": distance,
        "conflict": distance > ANGLE_CONSISTENCY_TOLERANCE_DEG,
    })
    return result


def collect(
    base_url: str,
    authority: str = "none",
    clock_source: str = "remote_unverified",
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
    status_max_age_ms: int = DEFAULT_STATUS_MAX_AGE_MS,
    doa_max_age_ms: int = DEFAULT_DOA_MAX_AGE_MS,
    max_future_skew_ms: int = DEFAULT_MAX_FUTURE_SKEW_MS,
    fetcher: Any = fetch_resource,
    parse_attempts: int = 3,
    retry_delay_seconds: float = 0.05,
    canonical_angle_ready: bool = False,
    power_mapping_ready: bool = False,
) -> Dict[str, Any]:
    if authority not in {"none", "csv", "xml"}:
        raise ValueError("authority must be one of: none, csv, xml")
    if clock_source not in {"local", "remote_unverified"}:
        raise ValueError("clock_source must be one of: local, remote_unverified")
    observed_at_ms = now_ms()
    resources: Dict[str, FetchedResource] = {}

    def read_parsed(path: str, parser: Any) -> Optional[Dict[str, Any]]:
        resource, parsed = fetch_and_parse_with_retry(
            base_url,
            path,
            parser,
            timeout_seconds,
            max_body_bytes,
            attempts=parse_attempts,
            retry_delay_seconds=retry_delay_seconds,
            fetcher=fetcher,
        )
        resources[path] = resource
        return parsed

    status = read_parsed(PATH_STATUS, parse_status)
    if not status or status.get("available") is not True:
        status = {
            "available": False,
            "error": (status or {}).get("error", "status parse failed"),
        }

    settings = read_parsed(PATH_SETTINGS, parse_settings)
    if not settings or settings.get("available") is not True:
        settings = {
            "available": False,
            "redacted": True,
            "error": (settings or {}).get("error", "settings parse failed"),
            "raw_fields_omitted": True,
        }

    # DoA and status timestamps originate from the same Raspberry clock. This
    # comparison remains meaningful when the collector runs on Ground, even
    # if Ground and Raspberry wall clocks are not synchronized.
    doa_reference_ms = observed_at_ms
    doa_reference_kind = "local_observed_at"
    if status.get("available"):
        doa_reference_ms = status["safe"]["timestamp_ms"]
        doa_reference_kind = "status_timestamp_ms"

    csv_candidate = read_parsed(
        PATH_CSV,
        lambda resource: parse_csv_doa(
            resource,
            doa_reference_ms,
            doa_max_age_ms,
            max_future_skew_ms,
            doa_reference_kind,
            True,
        ),
    )
    if not csv_candidate or csv_candidate.get("available") is not True:
        parse_error = (csv_candidate or {}).get("error")
        csv_candidate = _unavailable(resources[PATH_CSV])
        csv_candidate["error"] = parse_error or csv_candidate.get("error") or "CSV parse failed"

    xml_candidate = read_parsed(
        PATH_XML,
        lambda resource: parse_xml_doa(
            resource,
            doa_reference_ms,
            doa_max_age_ms,
            max_future_skew_ms,
            doa_reference_kind,
            True,
        ),
    )
    if not xml_candidate or xml_candidate.get("available") is not True:
        xml_candidate = _unavailable(resources[PATH_XML])
        xml_candidate["error"] = xml_candidate.get("error") or "XML parse failed"

    status_resource = resources[PATH_STATUS]
    settings_resource = resources[PATH_SETTINGS]
    csv_resource = resources[PATH_CSV]
    xml_resource = resources[PATH_XML]

    raw_candidates = {"csv": csv_candidate, "xml": xml_candidate}
    native_consistency = assess_native_conflict(raw_candidates)
    candidates: Dict[str, Dict[str, Any]] = {}
    for name, candidate in raw_candidates.items():
        if candidate.get("available") is not True:
            candidates[name] = candidate
            continue
        try:
            candidates[name] = normalize_doa_candidate(
                candidate,
                power_mapping_ready=power_mapping_ready,
            )
        except CollectorError as exc:
            quarantined = dict(candidate)
            quarantined["units_valid"] = False
            quarantined["normalization_error"] = type(exc).__name__
            candidates[name] = quarantined

    parsed_candidates = [candidate for candidate in candidates.values() if candidate.get("available")]
    fresh_candidates = [
        candidate
        for candidate in parsed_candidates
        if candidate.get("freshness", {}).get("fresh") is True
    ]
    selected = candidates.get(authority) if authority != "none" else None
    selected_available = bool(selected and selected.get("available"))
    selected_fresh = bool(selected_available and selected.get("freshness", {}).get("fresh"))
    selected_units_valid = bool(selected_available and selected.get("units_valid") is True)
    # Angle conversion is implemented, but publication readiness must remain an
    # explicit deployment/configuration decision after controlled validation.
    canonical_angle_ready = bool(canonical_angle_ready)

    status_available = bool(status.get("available"))
    status_age: Optional[Dict[str, Any]] = None
    if status_available and clock_source == "local":
        status_timestamp = status["safe"]["timestamp_ms"]
        status_age = _age_assessment(
            status_timestamp,
            observed_at_ms,
            status_max_age_ms,
            max_future_skew_ms,
            "local_observed_at",
            True,
        )
    elif status_available:
        status_age = _age_assessment(
            status["safe"]["timestamp_ms"],
            observed_at_ms,
            status_max_age_ms,
            max_future_skew_ms,
            "ground_observed_at",
            False,
        )
    status_fresh = bool(status_age and status_age["fresh"] is True)
    daq_healthy = status.get("daq_health") == "PASS"

    gate_checks = {
        "status_available": status_available,
        "status_fresh": status_fresh if clock_source == "local" else None,
        "daq_healthy": daq_healthy,
        "doa_candidate_parsed": bool(parsed_candidates),
        "doa_candidate_fresh": bool(fresh_candidates),
        "authority_selected": authority != "none" and selected_available,
        "selected_doa_fresh": selected_fresh,
        "selected_units_valid": selected_units_valid,
        "canonical_angle_ready": canonical_angle_ready,
        "native_views_consistent": native_consistency.get("comparable") is False
        or native_consistency.get("conflict") is False,
    }
    publication_ready = all(value is True for value in gate_checks.values())

    if not status_available:
        overall_state = "UNAVAILABLE"
    elif not daq_healthy:
        overall_state = "DEGRADED"
    elif not parsed_candidates:
        overall_state = "INVALID"
    elif not fresh_candidates:
        overall_state = "STALE"
    elif authority == "none":
        overall_state = "UNVERIFIED"
    elif not canonical_angle_ready:
        overall_state = "UNVERIFIED"
    else:
        overall_state = "LIVE" if publication_ready else "DEGRADED"

    reasons: List[str] = []
    if not status_available:
        reasons.append("STATUS_UNAVAILABLE_OR_INVALID")
    if status_available and clock_source == "local" and not status_fresh:
        reasons.append("STATUS_STALE")
    if status_available and clock_source != "local":
        reasons.append("GROUND_CLOCK_UNVERIFIED")
    if status_available and not daq_healthy:
        reasons.append("DAQ_HEALTH_GATE_FAILED")
    if not parsed_candidates:
        reasons.append("NO_VALID_DOA_CANDIDATE")
    elif not fresh_candidates:
        reasons.append("DOA_CANDIDATES_STALE")
    if not canonical_angle_ready:
        reasons.append("CANONICAL_ANGLE_NOT_CONFIGURED")
    if native_consistency.get("conflict"):
        reasons.append("NATIVE_DOA_VIEWS_CONFLICT")
    if authority == "none":
        reasons.append("DOA_AUTHORITY_NOT_SELECTED")
    elif not selected_available:
        reasons.append("SELECTED_AUTHORITY_UNAVAILABLE")
    elif not selected_fresh:
        reasons.append("SELECTED_DOA_STALE")
    elif not selected_units_valid:
        reasons.append("SELECTED_UNITS_NOT_READY")

    return {
        "schema_version": SCHEMA_VERSION,
        "collector": {
            "mode": "read_only",
            "base_url": base_url.rstrip("/"),
            "authority_config": authority,
            "clock_source": clock_source,
            "mqtt_publish": False,
            "raw_settings_omitted": True,
            "raw_angular_values_omitted": True,
            "angular_plot_local_only": True,
        },
        "observed_at_ms": observed_at_ms,
        "resources": {path: resource.metadata() for path, resource in resources.items()},
        "status": {
            **status,
            "freshness": status_age,
        },
        "settings": settings,
        "doa_candidates": candidates,
        "authority": {
            "selected": authority if authority != "none" else None,
            "selected_doa": selected if selected_available else None,
            "raw_and_canonical_separated": True,
            "canonical_angle_ready": canonical_angle_ready,
        },
        "native_consistency": native_consistency,
        "publication_gate": {
            "state": "READY" if publication_ready else "BLOCKED",
            "checks": gate_checks,
            "reasons": reasons,
        },
        "overall_state": overall_state,
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only SDR-DoA Data Out collector")
    parser.add_argument("--base-url", required=True, help="Base URL, for example http://10.90.0.2:8081")
    parser.add_argument("--authority", choices=("none", "csv", "xml"), default="none")
    parser.add_argument(
        "--clock-source",
        choices=("local", "remote_unverified"),
        default="remote_unverified",
        help="Use local node clock only when this collector runs on the Raspberry.",
    )
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--max-body-bytes", type=int, default=DEFAULT_MAX_BODY_BYTES)
    parser.add_argument("--status-max-age-ms", type=int, default=DEFAULT_STATUS_MAX_AGE_MS)
    parser.add_argument("--doa-max-age-ms", type=int, default=DEFAULT_DOA_MAX_AGE_MS)
    parser.add_argument("--max-future-skew-ms", type=int, default=DEFAULT_MAX_FUTURE_SKEW_MS)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        result = collect(
            base_url=args.base_url,
            authority=args.authority,
            clock_source=args.clock_source,
            timeout_seconds=args.timeout,
            max_body_bytes=args.max_body_bytes,
            status_max_age_ms=args.status_max_age_ms,
            doa_max_age_ms=args.doa_max_age_ms,
            max_future_skew_ms=args.max_future_skew_ms,
        )
        print(json.dumps(result, indent=2, sort_keys=True, allow_nan=False))
        return 0
    except (ValueError, OSError) as exc:
        print(json.dumps({"collector_error": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
