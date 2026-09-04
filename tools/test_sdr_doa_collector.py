#!/usr/bin/env python3
"""Small standard-library tests for the read-only collector."""

from __future__ import annotations

import csv
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sdr_doa_collector as collector


def resource(path: str, body: bytes) -> collector.FetchedResource:
    return collector.FetchedResource(
        path=path,
        url="http://fixture" + path,
        ok=True,
        http_status=200,
        content_type="application/octet-stream",
        body=body,
        retrieved_at_ms=1_000,
    )


def make_status(timestamp: int = 100_000, daq_ok: bool = True) -> bytes:
    return json.dumps(
        {
            "timestamp_ms": timestamp,
            "station_id": "TEST",
            "hardware_id": "fixture",
            "unit_id": 0,
            "host_os_type": "Linux",
            "host_os_version": "test",
            "host_os_architecture": "aarch64",
            "software_version": "test",
            "software_git_short_hash": "fixture",
            "uptime_ms": 10,
            "gps_status": "Disabled",
            "daq_status": {
                "data_frame_index": 10,
                "frame_sync": daq_ok,
                "sample_delay_sync": daq_ok,
                "iq_sync": daq_ok,
                "noise_source_enabled": False,
                "adc_overdrive": False,
                "sampling_frequency_hz": 2_400_000,
                "bandwidth_hz": 2_400_000,
                "decimated_bandwidth_hz": 2_400_000,
                "buffer_size_ms": 1.0,
            },
            "daq_ok": daq_ok,
            "daq_num_dropped_frames": 0,
        }
    ).encode()


def make_csv(timestamp: int = 100_000, columns: int = 377) -> bytes:
    row = [str(timestamp), "149.0", "1.2", "-70.0", "416588000", "UCA", "12"]
    row.extend(["TEST", "0.0", "0.0", "0.0", "0.0", "GPS"])
    row.extend(["R"] * 4)
    row.extend(["-20.0"] * max(0, columns - len(row)))
    row[17 + 10] = "5.0"
    return (",".join(row) + "\n").encode()


def make_xml(timestamp: int = 100_000) -> bytes:
    return f"""<DATA><STATION_ID>TEST</STATION_ID><TIME>{timestamp}</TIME><GPS_TIME>0</GPS_TIME><FREQUENCY>416.588</FREQUENCY><LOCATION><LATITUDE>0</LATITUDE><LONGITUDE>0</LONGITUDE><HEADING>0</HEADING><SPEED>0</SPEED></LOCATION><DOA>211.0</DOA><PWR>22.2</PWR><CONF>135</CONF><LATENCY>10</LATENCY><PROCESSING_TIME>12</PROCESSING_TIME><ADC_OVERDRIVE>False</ADC_OVERDRIVE><NUM_CORRELATED_SOURCES>1</NUM_CORRELATED_SOURCES><SNR_DB>10.0</SNR_DB></DATA>""".encode()


def fake_collection(status_body: bytes, csv_body: bytes, xml_body: bytes):
    bodies = {
        collector.PATH_STATUS: status_body,
        collector.PATH_SETTINGS: b'{"center_freq": 415.7, "secret_token": "do-not-return"}',
        collector.PATH_CSV: csv_body,
        collector.PATH_XML: xml_body,
    }

    def fetcher(base_url, path, timeout, max_body):
        return resource(path, bodies[path])

    return collector.collect(
        "http://fixture:8081",
        authority="none",
        clock_source="local",
        status_max_age_ms=10_000,
        doa_max_age_ms=5_000,
        fetcher=fetcher,
    )


def test_valid_parsing_but_authority_blocked():
    result = fake_collection(make_status(), make_csv(), make_xml())
    assert result["status"]["daq_health"] == "PASS"
    assert result["doa_candidates"]["csv"]["angular_bins"] == 360
    assert result["publication_gate"]["state"] == "BLOCKED"
    assert "DOA_AUTHORITY_NOT_SELECTED" in result["publication_gate"]["reasons"]
    assert result["settings"]["raw_fields_omitted"] is True
    assert "secret_token" not in json.dumps(result)


def test_unhealthy_daq_blocks():
    result = fake_collection(make_status(100_000, daq_ok=False), make_csv(), make_xml())
    assert result["status"]["daq_health"] == "FAIL"
    assert result["publication_gate"]["checks"]["daq_healthy"] is False
    assert result["overall_state"] == "DEGRADED"


def test_upstream_confidence_and_power_semantics_stay_explicit():
    result = fake_collection(make_status(), make_csv(), make_xml())
    csv_candidate = result["doa_candidates"]["csv"]
    xml_candidate = result["doa_candidates"]["xml"]

    assert csv_candidate["confidence_metric_unit"] == "dB_papr"
    assert csv_candidate["confidence_metric_db"] == 1.2
    assert csv_candidate["confidence"] is None
    assert "CONFIDENCE_MAPPING_UNVERIFIED" in csv_candidate["unit_reasons"]
    assert csv_candidate["power_native_db"] == -70.0

    assert abs(xml_candidate["confidence_metric_db"] - 1.35) < 1e-9
    assert xml_candidate["confidence"] is None
    assert xml_candidate["confidence_unit"] == "source_dB_papr_times_100"
    assert abs(xml_candidate["power_native_db"] - (-77.8)) < 1e-9
    assert xml_candidate["power_valid"] is False
    assert "POWER_MAPPING_UNVERIFIED" in xml_candidate["unit_reasons"]


def test_xml_power_floor_remains_lossy():
    candidate = collector.parse_xml_doa(resource(collector.PATH_XML, make_xml()), 100_000)
    candidate["power_transformed_raw"] = -100.0
    normalized = collector.normalize_doa_candidate(candidate)
    assert normalized["power_mapping_lossy"] is True
    assert normalized["power_native_valid"] is False
    assert "POWER_FLOOR_LOSSY" in normalized["unit_reasons"]


def test_stale_doa_uses_node_status_reference():
    result = fake_collection(make_status(110_000), make_csv(100_000), make_xml(100_000))
    assert result["doa_candidates"]["csv"]["freshness"]["age_ms"] == 10_000
    assert result["doa_candidates"]["csv"]["freshness"]["fresh"] is False
    assert "DOA_CANDIDATES_STALE" in result["publication_gate"]["reasons"]


def test_malformed_csv_is_rejected():
    result = fake_collection(make_status(), b"1,2,3\n", make_xml())
    assert result["doa_candidates"]["csv"]["available"] is False
    assert "expected 377 CSV fields" in result["doa_candidates"]["csv"]["error"]


def test_authority_never_bypasses_angle_gate():
    result = fake_collection(make_status(), make_csv(), make_xml())
    result = collector.collect(
        "http://fixture:8081",
        authority="csv",
        clock_source="local",
        fetcher=lambda base, path, timeout, max_body: resource(
            path,
            {
                collector.PATH_STATUS: make_status(),
                collector.PATH_SETTINGS: b'{"center_freq": 415.7}',
                collector.PATH_CSV: make_csv(),
                collector.PATH_XML: make_xml(),
            }[path],
        ),
    )
    assert result["publication_gate"]["state"] == "BLOCKED"
    assert result["publication_gate"]["checks"]["canonical_angle_ready"] is False
    assert "CANONICAL_ANGLE_NOT_CONFIGURED" in result["publication_gate"]["reasons"]


def test_selected_authority_exposes_units_gate_reason():
    result = collector.collect(
        "http://fixture:8081",
        authority="csv",
        clock_source="local",
        fetcher=lambda base, path, timeout, max_body: resource(
            path,
            {
                collector.PATH_STATUS: make_status(),
                collector.PATH_SETTINGS: b'{"center_freq": 415.7}',
                collector.PATH_CSV: make_csv(),
                collector.PATH_XML: make_xml(),
            }[path],
        ),
    )
    assert result["publication_gate"]["checks"]["authority_selected"] is True
    assert result["publication_gate"]["checks"]["selected_units_valid"] is False
    assert "SELECTED_UNITS_NOT_READY" in result["publication_gate"]["reasons"]


def test_partial_read_recovers_on_bounded_retry():
    bodies = {
        collector.PATH_STATUS: make_status(),
        collector.PATH_SETTINGS: b'{"center_freq": 415.7}',
        collector.PATH_CSV: make_csv(),
        collector.PATH_XML: make_xml(),
    }
    calls = {path: 0 for path in bodies}

    def fetcher(base, path, timeout, max_body):
        calls[path] += 1
        body = bodies[path]
        if path == collector.PATH_STATUS and calls[path] == 1:
            body = body[:10]
        return resource(path, body)

    result = collector.collect(
        "http://fixture:8081",
        authority="none",
        clock_source="local",
        parse_attempts=2,
        retry_delay_seconds=0,
        fetcher=fetcher,
    )
    assert result["status"]["available"] is True
    assert calls[collector.PATH_STATUS] == 2


if __name__ == "__main__":
    tests = [value for name, value in globals().items() if name.startswith("test_")]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)} tests passed")
