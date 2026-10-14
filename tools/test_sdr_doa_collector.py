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


def csv_row(
    timestamp: int = 100_000,
    columns: int = 377,
    raw_angle: str = "149.0",
    peak_bin: int = 211,
    frequency_hz: str = "416588000",
    station: str = "TEST",
    power_raw: str = "-70.0",
) -> str:
    # Upstream writes 360 - theta_0 in the CSV and puts the vector peak on the
    # theta_0 bin, so raw 149.0 pairs with a peak at bin 211.
    row = [str(timestamp), raw_angle, "1.2", power_raw, frequency_hz, "UCA", "12"]
    row.extend([station, "0.0", "0.0", "0.0", "0.0", "GPS"])
    row.extend(["R"] * 4)
    row.extend(["-20.0"] * max(0, columns - len(row)))
    if columns >= 377:
        row[17 + peak_bin] = "5.0"
    return ",".join(row)


def make_csv(timestamp: int = 100_000, columns: int = 377, **kwargs) -> bytes:
    return (csv_row(timestamp, columns, **kwargs) + "\n").encode()


def make_xml(
    timestamp: int = 100_000,
    doa: str = "211.0",
    station: str = "<STATION_ID>TEST</STATION_ID>",
    frequency_mhz: str = "416.588",
    pwr: str = "22.2",
    overdrive: str = "False",
) -> bytes:
    return f"""<DATA>{station}<TIME>{timestamp}</TIME><GPS_TIME>0</GPS_TIME><FREQUENCY>{frequency_mhz}</FREQUENCY><LOCATION><LATITUDE>0</LATITUDE><LONGITUDE>0</LONGITUDE><HEADING>0</HEADING><SPEED>0</SPEED></LOCATION><DOA>{doa}</DOA><PWR>{pwr}</PWR><CONF>135</CONF><LATENCY>10</LATENCY><PROCESSING_TIME>12</PROCESSING_TIME><ADC_OVERDRIVE>{overdrive}</ADC_OVERDRIVE><NUM_CORRELATED_SOURCES>1</NUM_CORRELATED_SOURCES><SNR_DB>10.0</SNR_DB></DATA>""".encode()


class FakeClock:
    """Deterministic Ground monotonic clock for age and progress checks."""

    def __init__(self, start: float = 1_000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def fake_collection(status_body: bytes, csv_body: bytes, xml_body: bytes, **kwargs):
    bodies = {
        collector.PATH_STATUS: status_body,
        collector.PATH_SETTINGS: b'{"center_freq": 415.7, "secret_token": "do-not-return"}',
        collector.PATH_CSV: csv_body,
        collector.PATH_XML: xml_body,
    }

    def fetcher(base_url, path, timeout, max_body):
        return resource(path, bodies[path])

    options = {
        "authority": "none",
        "clock_source": "local",
        "status_max_age_ms": 10_000,
        "doa_max_age_ms": 5_000,
        "fetcher": fetcher,
        "monotonic_clock": FakeClock(),
    }
    options.update(kwargs)
    return collector.collect("http://fixture:8081", **options)


def test_valid_parsing_but_authority_blocked():
    result = fake_collection(make_status(), make_csv(), make_xml())
    assert result["status"]["daq_health"] == "PASS"
    assert result["doa_candidates"]["csv"]["angular_bins"] == 360
    csv_candidate = result["doa_candidates"]["csv"]
    assert len(csv_candidate["angular_power_db"]) == 360
    assert csv_candidate["angular_power_db"][0] == -20.0
    assert csv_candidate["angular_power_db"][211] == 5.0
    assert csv_candidate["angular_peak_index"] == 211
    assert csv_candidate["angular_peak_angle_consistent"] is True
    assert csv_candidate["angular_peak_value"] == 5.0
    assert csv_candidate["angular_peak_db"] == 5.0
    assert csv_candidate["angular_power_min_db"] == -20.0
    assert csv_candidate["angular_power_max_db"] == 5.0
    assert result["doa_candidates"]["csv"]["angular_power_unit"] == "dB_relative_to_source_floor"
    assert csv_candidate["angular_power_transform"] == "preserved_source_shifted_db"
    assert csv_candidate["angular_power_shifted"] is True
    assert result["doa_candidates"]["csv"]["angular_values_local_only"] is True
    assert result["publication_gate"]["state"] == "BLOCKED"
    assert "DOA_AUTHORITY_NOT_SELECTED" in result["publication_gate"]["reasons"]
    assert result["settings"]["raw_fields_omitted"] is True
    assert "secret_token" not in json.dumps(result)


def test_vfo_settings_are_kept_only_as_finite_numbers():
    """Kontrol checks a sent VFO patch against these Data Out values."""
    body = json.dumps({
        "center_freq": 433.92,
        "uniform_gain": 15.7,
        "vfo_freq_0": 433_920_000,
        "vfo_bw_0": 12_500.0,
        "vfo_squelch_0": -80,
        "vfo_demod_0": "FM",
    }).encode()
    fields = collector.parse_settings(resource(collector.PATH_SETTINGS, body))["fields"]
    assert fields["vfo_freq_0"] == 433_920_000
    assert fields["vfo_bw_0"] == 12_500.0
    assert fields["vfo_squelch_0"] == -80
    assert "vfo_demod_0" not in fields

    bad = b'{"vfo_freq_0": "433920000", "vfo_bw_0": true, "vfo_squelch_0": NaN, "uniform_gain": "15.7"}'
    fields = collector.parse_settings(resource(collector.PATH_SETTINGS, bad))["fields"]
    assert "vfo_freq_0" not in fields
    assert "vfo_bw_0" not in fields
    assert "vfo_squelch_0" not in fields
    # The older fields keep their scalar rule.
    assert fields["uniform_gain"] == "15.7"

    fixture = json.loads((Path(__file__).resolve().parent / "fixtures" / "valid" / "settings.json").read_text())
    fields = collector.parse_settings(resource(collector.PATH_SETTINGS, json.dumps(fixture).encode()))["fields"]
    assert fields["vfo_freq_0"] == fixture["vfo_freq_0"]
    assert fields["vfo_bw_0"] == fixture["vfo_bw_0"]
    assert fields["vfo_squelch_0"] == fixture["vfo_squelch_0"]


def test_unhealthy_daq_blocks():
    result = fake_collection(make_status(100_000, daq_ok=False), make_csv(), make_xml())
    assert result["status"]["daq_health"] == "FAIL"
    assert result["publication_gate"]["checks"]["daq_healthy"] is False
    assert result["overall_state"] == "DEGRADED"


def test_adjacent_native_views_within_bounded_timestamp_window_are_comparable():
    result = fake_collection(
        make_status(100_000),
        make_csv(101_700),
        make_xml(102_500),
    )
    consistency = result["native_consistency"]
    assert consistency["comparable"] is True
    assert consistency["same_timestamp"] is False
    assert consistency["timestamp_delta_ms"] == 800
    assert consistency["conflict"] is False


def test_native_views_outside_timestamp_window_are_not_comparable():
    result = fake_collection(
        make_status(100_000),
        make_csv(100_000),
        make_xml(102_500),
    )
    consistency = result["native_consistency"]
    assert consistency["comparable"] is False
    assert consistency["timestamp_delta_ms"] == 2_500
    assert consistency["conflict"] is False


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



def _bodies(status=None, csv_body=None, xml_body=None, settings=b'{"center_freq": 415.7}'):
    return {
        collector.PATH_STATUS: make_status() if status is None else status,
        collector.PATH_SETTINGS: settings,
        collector.PATH_CSV: make_csv() if csv_body is None else csv_body,
        collector.PATH_XML: make_xml() if xml_body is None else xml_body,
    }


def make_status_with(timestamp: int = 100_000, uptime: int = 10, frame: int = 10, **daq) -> bytes:
    payload = json.loads(make_status(timestamp).decode())
    payload["uptime_ms"] = uptime
    payload["daq_status"]["data_frame_index"] = frame
    payload["daq_status"].update(daq)
    return json.dumps(payload).encode()


def test_frozen_node_is_reported_as_stalled_and_not_fresh():
    """AUD-02: identical node counters across reads must not stay CURRENT."""
    tracker = collector.NodeProgressTracker()
    clock = FakeClock()
    frozen = _bodies(make_status_with(100_000), make_csv(100_000), make_xml(100_000))

    def fetcher(base, path, timeout, max_body):
        return resource(path, frozen[path])

    def read():
        return collector.collect(
            "http://fixture:8081",
            clock_source="remote_unverified",
            fetcher=fetcher,
            progress_tracker=tracker,
            monotonic_clock=clock,
        )

    first = read()
    assert first["node_progress"]["state"] == "FIRST_SAMPLE"
    assert first["doa_candidates"]["csv"]["freshness"]["fresh"] is True
    assert "NODE_CLOCK_STALLED" not in first["publication_gate"]["reasons"]

    clock.advance(11)
    stalled = read()
    progress = stalled["node_progress"]
    assert progress["state"] == "STALLED"
    assert progress["stalled"] is True
    assert set(progress["stalled_counters"]) == {"timestamp_ms", "uptime_ms", "data_frame_index"}
    assert progress["unchanged_for_ms"]["timestamp_ms"] == 11_000
    assert "NODE_CLOCK_STALLED" in stalled["publication_gate"]["reasons"]
    assert stalled["publication_gate"]["checks"]["node_not_stalled"] is False
    for name in ("csv", "xml"):
        freshness = stalled["doa_candidates"][name]["freshness"]
        assert freshness["fresh"] is False
        assert freshness["node_stalled"] is True
        assert freshness["age_ms"] >= 11_000
    assert stalled["overall_state"] == "STALE"

    frozen.update(_bodies(make_status_with(111_000, uptime=11_010, frame=55), make_csv(111_000), make_xml(111_000)))
    clock.advance(1)
    resumed = read()
    assert resumed["node_progress"]["state"] == "ADVANCING"
    assert resumed["node_progress"]["changed_counters"] == ["data_frame_index", "timestamp_ms", "uptime_ms"]
    assert resumed["doa_candidates"]["csv"]["freshness"]["fresh"] is True
    assert "NODE_CLOCK_STALLED" not in resumed["publication_gate"]["reasons"]


def test_unchanged_status_timestamp_ages_doa_before_stall_threshold():
    """AUD-02/AUD-23: Ground time since the status timestamp was first seen counts."""
    tracker = collector.NodeProgressTracker()
    clock = FakeClock()
    bodies = _bodies(make_status_with(100_000), make_csv(100_000), make_xml(100_000))

    def read():
        return collector.collect(
            "http://fixture:8081",
            fetcher=lambda base, path, timeout, max_body: resource(path, bodies[path]),
            progress_tracker=tracker,
            monotonic_clock=clock,
        )

    read()
    clock.advance(6)
    result = read()
    freshness = result["doa_candidates"]["csv"]["freshness"]
    assert freshness["ground_elapsed_ms"] == 6_000
    assert freshness["age_ms"] == 6_000
    assert freshness["fresh"] is False
    progress = result["node_progress"]
    assert progress["state"] == "UNCHANGED"
    assert progress["stalled"] is False
    assert progress["changed_counters"] == []
    assert progress["unchanged_for_ms"]["timestamp_ms"] == 6_000
    assert "DOA_CANDIDATES_STALE" in result["publication_gate"]["reasons"]

    bodies[collector.PATH_STATUS] = make_status_with(100_000, uptime=2_010)
    clock.advance(1)
    partial = read()["node_progress"]
    assert partial["state"] == "ADVANCING"
    assert partial["changed_counters"] == ["uptime_ms"]


def test_collection_time_is_added_to_doa_age():
    """AUD-23: a slow read must not reset the DoA age to the status timestamp."""
    clock = FakeClock()
    bodies = _bodies()

    def fetcher(base, path, timeout, max_body):
        if path == collector.PATH_XML:
            clock.advance(4.5)
        return resource(path, bodies[path])

    result = collector.collect("http://fixture:8081", fetcher=fetcher, monotonic_clock=clock)
    csv_freshness = result["doa_candidates"]["csv"]["freshness"]
    assert csv_freshness["ground_elapsed_ms"] == 4_500
    assert csv_freshness["age_ms"] == 4_500
    assert csv_freshness["reference_ms"] == 104_500
    assert result["collection"]["elapsed_ms"] == 4_500


def test_adc_overdrive_snr_and_papr_are_exposed_and_gated():
    """AUD-05: overdrive degrades the snapshot with an explicit reason."""
    result = fake_collection(make_status_with(adc_overdrive=True), make_csv(), make_xml(overdrive="5"))
    quality = result["signal_quality"]
    assert quality["state"] == "OVERDRIVE"
    assert quality["adc_overdrive"] is True
    assert quality["adc_overdrive_sources"] == ["status", "xml"]
    assert quality["adc_overdrive_channel_mask"] == 5
    assert quality["snr_db"] == 10.0
    assert abs(quality["confidence_metric_db"]["xml"] - 1.35) < 1e-9
    assert quality["confidence_metric_db"]["csv"] == 1.2
    assert result["status"]["daq_health"] == "PASS"
    assert result["overall_state"] == "DEGRADED"
    assert "ADC_OVERDRIVE" in result["publication_gate"]["reasons"]
    assert result["publication_gate"]["checks"]["adc_not_overdriven"] is False

    clean = fake_collection(make_status(), make_csv(), make_xml())
    assert clean["signal_quality"]["state"] == "PASS"
    assert clean["signal_quality"]["adc_overdrive"] is False
    assert "ADC_OVERDRIVE" not in clean["publication_gate"]["reasons"]
    assert clean["signal_quality"]["last_doa_record"] == {}


def test_stale_xml_overdrive_flag_does_not_degrade_the_current_snapshot():
    """doa.xml keeps its last frame between squelch hits; status.json decides overdrive."""
    result = fake_collection(
        make_status(160_000), make_csv(100_000), make_xml(100_000, overdrive="1"), clock_source="remote_unverified"
    )
    assert result["doa_candidates"]["xml"]["freshness"]["fresh"] is False
    assert result["doa_candidates"]["xml"]["adc_overdrive_active"] is True
    quality = result["signal_quality"]
    assert quality["state"] == "PASS"
    assert quality["adc_overdrive"] is False
    assert quality["adc_overdrive_sources"] == []
    assert quality["adc_overdrive_reported_by"] == ["status"]
    assert quality["adc_overdrive_channel_mask"] is None
    assert quality["snr_db"] is None and quality["snr_source"] is None
    assert quality["confidence_metric_db"] == {"csv": None, "xml": None}
    last = quality["last_doa_record"]
    assert last["xml"]["adc_overdrive_active"] is True
    assert last["xml"]["snr_db"] == 10.0
    assert last["xml"]["age_ms"] == 60_000 and last["xml"]["fresh"] is False
    assert last["csv"]["confidence_metric_db"] == 1.2 and "adc_overdrive_active" not in last["csv"]
    assert result["publication_gate"]["checks"]["adc_not_overdriven"] is True
    assert "ADC_OVERDRIVE" not in result["publication_gate"]["reasons"]
    assert "DOA_CANDIDATES_STALE" in result["publication_gate"]["reasons"]
    assert result["overall_state"] == "STALE"

    live_status = fake_collection(
        make_status_with(160_000, adc_overdrive=True), make_csv(100_000), make_xml(100_000),
        clock_source="remote_unverified",
    )
    assert live_status["signal_quality"]["adc_overdrive_sources"] == ["status"]
    assert live_status["overall_state"] == "DEGRADED"
    assert "ADC_OVERDRIVE" in live_status["publication_gate"]["reasons"]


def test_transport_failure_is_not_retried_and_skips_the_other_reads():
    """AUD-09: an unreachable node costs one GET, not twelve."""
    calls = []

    def fetcher(base, path, timeout, max_body):
        calls.append(path)
        return collector.FetchedResource(
            path, base + path, False, None, None, b"", 1, "connection refused", error_kind="connection_refused"
        )

    result = collector.collect("http://fixture:8081", fetcher=fetcher, retry_delay_seconds=0)
    assert calls == [collector.PATH_STATUS]
    assert result["collection"]["status_transport_failed"] is True
    assert result["resources"][collector.PATH_CSV]["error_kind"] == "skipped"
    assert result["resources"][collector.PATH_STATUS]["attempts"] == 1
    assert result["overall_state"] == "UNAVAILABLE"


def test_total_budget_bounds_a_hanging_read():
    """AUD-09: one stuck resource cannot hold the snapshot past its budget."""
    import time as _time

    bodies = _bodies()

    def fetcher(base, path, timeout, max_body):
        if path == collector.PATH_CSV:
            _time.sleep(min(2.0, timeout + 0.5))
        return resource(path, bodies[path])

    started = _time.monotonic()
    result = collector.collect("http://fixture:8081", fetcher=fetcher, total_budget_s=0.3)
    elapsed = _time.monotonic() - started
    assert elapsed < 1.0, elapsed
    assert result["resources"][collector.PATH_CSV]["error_kind"] == "deadline"
    assert result["doa_candidates"]["csv"]["available"] is False
    assert result["collection"]["deadline_exceeded"] is True
    assert result["collection"]["budget_ms"] == 300
    assert "COLLECTION_DEADLINE_EXCEEDED" in result["publication_gate"]["reasons"]
    assert "CSV_VIEW_UNAVAILABLE" in result["publication_gate"]["reasons"]


def _serve_once(handler):
    """Serve one raw HTTP exchange on an ephemeral loopback port."""
    import socket
    import threading

    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    server.settimeout(5)

    def run():
        try:
            conn, _ = server.accept()
        except OSError:
            return
        with conn:
            conn.settimeout(5)
            try:
                conn.recv(4096)
                handler(conn)
            except OSError:
                pass

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return server, thread, server.getsockname()[1]


def _fetch_from(port, timeout_seconds):
    from unittest import mock

    with mock.patch.object(collector, "_validate_base_url", return_value=f"http://127.0.0.1:{port}"):
        return collector.fetch_resource("http://doasdr.local:8081", collector.PATH_STATUS, timeout_seconds)


def test_request_budget_bounds_a_trickling_body():
    """A body sent one byte at a time cannot hold the read past timeout_seconds."""
    import time as _time

    stop = []

    def trickle(conn):
        conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n")
        for _ in range(60):
            if stop:
                return
            conn.sendall(b" ")
            _time.sleep(0.1)

    server, thread, port = _serve_once(trickle)
    try:
        started = _time.monotonic()
        fetched = _fetch_from(port, 0.5)
        elapsed = _time.monotonic() - started
    finally:
        stop.append(True)
        server.close()
        thread.join(5)
    assert elapsed < 1.5, elapsed
    assert fetched.ok is False
    assert fetched.error_kind == "timeout", fetched.error_kind

    body = b'{"value": "' + b"x" * 40_000 + b'"}'

    def whole(conn):
        conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n" % len(body))
        for start in range(0, len(body), 7_000):
            conn.sendall(body[start:start + 7_000])

    def chunked(conn):
        conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n")
        for start in range(0, len(body), 9_000):
            part = body[start:start + 9_000]
            conn.sendall(b"%x\r\n%s\r\n" % (len(part), part))
        conn.sendall(b"0\r\n\r\n")

    for handler in (whole, chunked):
        server, thread, port = _serve_once(handler)
        try:
            fetched = _fetch_from(port, 2.0)
        finally:
            server.close()
            thread.join(5)
        assert fetched.ok is True, (handler.__name__, fetched.error)
        assert fetched.body == body, handler.__name__


def test_budget_must_be_positive_and_finite():
    for budget in (0, -1, float("nan"), float("inf"), True, 10_000):
        try:
            collector.collect("http://fixture:8081", fetcher=lambda *a: None, total_budget_s=budget)
        except ValueError:
            continue
        raise AssertionError(f"budget accepted: {budget!r}")


def test_adjacent_frame_motion_is_not_a_conflict():
    """AUD-18: a bearing that moved between frames is not a convention error."""
    bodies = _bodies(make_status(), make_csv(100_000), make_xml(100_289, doa="213.0"))
    calls = []

    def fetcher(base, path, timeout, max_body):
        calls.append(path)
        return resource(path, bodies[path])

    result = collector.collect("http://fixture:8081", fetcher=fetcher)
    consistency = result["native_consistency"]
    assert consistency["frame_relation"] == "ADJACENT_FRAMES"
    assert consistency["comparable"] is True
    assert consistency["angle_checked"] is False
    assert consistency["conflict"] is False
    assert consistency["circular_distance_deg"] == 2.0
    assert consistency["pair_reads"] == 1 + collector.NATIVE_PAIR_REREADS
    assert calls.count(collector.PATH_CSV) == 1 + collector.NATIVE_PAIR_REREADS
    assert "NATIVE_DOA_VIEWS_CONFLICT" not in result["publication_gate"]["reasons"]
    assert "NATIVE_ANGLE_UNCHECKED" in result["publication_gate"]["reasons"]
    assert result["publication_gate"]["checks"]["native_angle_checked"] is False


def test_adjacent_pair_is_reread_until_same_frame():
    """AUD-18: a re-read that lands in one frame runs the angle test."""
    reads = {collector.PATH_CSV: 0, collector.PATH_XML: 0}
    bodies = _bodies()

    def fetcher(base, path, timeout, max_body):
        if path in reads:
            reads[path] += 1
            if path == collector.PATH_XML and reads[path] == 1:
                return resource(path, make_xml(100_250, doa="215.0"))
        return resource(path, bodies[path])

    result = collector.collect("http://fixture:8081", fetcher=fetcher)
    consistency = result["native_consistency"]
    assert consistency["pair_reads"] == 2
    assert consistency["frame_relation"] == "SAME_FRAME"
    assert consistency["angle_checked"] is True
    assert consistency["conflict"] is False


def _forced_units_ready(run):
    """Run with the selected unit contract forced ready, so READY is reachable.

    Upstream confidence is never mapped to 0..1, so ``units_valid`` is always
    false and the gate never reaches READY on real parsing.
    """
    original = collector.normalize_doa_candidate

    def units_ready(*args, **kwargs):
        result = original(*args, **kwargs)
        result["units_valid"] = True
        return result

    collector.normalize_doa_candidate = units_ready
    try:
        return run()
    finally:
        collector.normalize_doa_candidate = original


def ready_path_collection(csv_age_ms: int, xml_age_ms: int, xml_doa: str = "211.0"):
    now = collector.now_ms()
    bodies = _bodies(make_status(now), make_csv(now - csv_age_ms), make_xml(now - xml_age_ms, doa=xml_doa))
    return _forced_units_ready(lambda: collector.collect(
        "http://fixture:8081",
        authority="csv",
        clock_source="local",
        canonical_angle_ready=True,
        retry_delay_seconds=0,
        fetcher=lambda base, path, timeout, max_body: resource(path, bodies[path]),
    ))


def failing_checks(result):
    return sorted(name for name, value in result["publication_gate"]["checks"].items() if value is not True)


def test_unchecked_native_pair_blocks_publication_but_not_display():
    """AUD-18 follow-up: views from different frames were never angle-checked."""
    same = ready_path_collection(300, 300)
    assert same["native_consistency"]["angle_checked"] is True
    assert same["publication_gate"]["state"] == "READY", same["publication_gate"]
    assert same["publication_gate"]["checks"]["native_angle_checked"] is True
    assert "NATIVE_ANGLE_UNCHECKED" not in same["publication_gate"]["reasons"]
    assert same["overall_state"] == "LIVE"

    adjacent = ready_path_collection(400, 150, xml_doa="213.0")
    consistency = adjacent["native_consistency"]
    assert (consistency["frame_relation"], consistency["angle_checked"], consistency["conflict"]) == (
        "ADJACENT_FRAMES", False, False,
    )
    assert adjacent["publication_gate"]["state"] == "BLOCKED"
    assert failing_checks(adjacent) == ["native_angle_checked"]
    assert adjacent["publication_gate"]["reasons"] == ["NATIVE_ANGLE_UNCHECKED"]
    # Display semantics stay as before: the data itself is LIVE.
    assert adjacent["overall_state"] == "LIVE"

    apart = ready_path_collection(2_800, 300)
    assert apart["native_consistency"]["frame_relation"] == "OUT_OF_WINDOW"
    assert failing_checks(apart) == ["native_angle_checked"]
    assert "NATIVE_ANGLE_UNCHECKED" in apart["publication_gate"]["reasons"]
    assert apart["overall_state"] == "INCOMPLETE"


def test_angle_unchecked_is_not_reported_for_a_missing_or_invalid_view():
    now = collector.now_ms()
    missing = fake_collection(make_status(now), b"1,2,3\n", make_xml(now - 300))
    assert missing["publication_gate"]["checks"]["native_angle_checked"] is True
    assert "NATIVE_ANGLE_UNCHECKED" not in missing["publication_gate"]["reasons"]
    invalid = fake_collection(make_status(now), make_csv(now - 300), make_xml(now - 300, doa="9999"))
    assert "NATIVE_ANGLE_INVALID" in invalid["publication_gate"]["reasons"]
    assert "NATIVE_ANGLE_UNCHECKED" not in invalid["publication_gate"]["reasons"]
    assert invalid["publication_gate"]["checks"]["native_angle_checked"] is True


def test_same_frame_disagreement_is_still_a_conflict():
    result = fake_collection(make_status(), make_csv(raw_angle="120.0", peak_bin=240), make_xml())
    consistency = result["native_consistency"]
    assert consistency["frame_relation"] == "SAME_FRAME"
    assert consistency["conflict"] is True
    assert result["overall_state"] == "CONFLICT"
    assert "NATIVE_DOA_VIEWS_CONFLICT" in result["publication_gate"]["reasons"]


def test_multi_vfo_csv_selects_the_row_matching_xml():
    """AUD-22: Output VFO = ALL writes one CSV row per VFO."""
    rows = "\n".join([
        csv_row(frequency_hz="433920000", raw_angle="10.0", peak_bin=350),
        csv_row(frequency_hz="416588000"),
    ]) + "\n"
    result = fake_collection(make_status(), rows.encode(), make_xml())
    csv_candidate = result["doa_candidates"]["csv"]
    assert csv_candidate["available"] is True
    assert csv_candidate["csv_rows_total"] == 2
    assert csv_candidate["csv_row_index"] == 1
    assert csv_candidate["csv_row_selection"] == "matched_xml_frequency"
    assert csv_candidate["canonical_angle_deg"] == 211.0
    assert [row["row_index"] for row in csv_candidate["additional_vfo_rows"]] == [0]
    assert csv_candidate["additional_vfo_rows"][0]["canonical_angle_deg"] == 350.0
    assert "angular_power_db" not in csv_candidate["additional_vfo_rows"][0]
    assert result["native_consistency"]["conflict"] is False

    unmatched = fake_collection(make_status(), rows.encode(), make_xml(frequency_mhz="145.000"))
    csv_unmatched = unmatched["doa_candidates"]["csv"]
    assert csv_unmatched["available"] is False
    assert "multi-VFO" in csv_unmatched["error"]
    assert csv_unmatched["csv_rows_total"] == 2
    assert "CSV_VIEW_UNAVAILABLE" in unmatched["publication_gate"]["reasons"]
    assert unmatched["overall_state"] == "INCOMPLETE"


def test_kerberos_xml_in_csv_view_is_explained():
    result = fake_collection(make_status(), b"<DATA><DOA>211</DOA></DATA>", make_xml())
    assert result["doa_candidates"]["csv"]["available"] is False
    assert "Kerberos App" in result["doa_candidates"]["csv"]["error"]
    assert "CSV_VIEW_UNAVAILABLE" in result["publication_gate"]["reasons"]


def test_native_angle_outside_0_360_is_normalized_not_conflict():
    """AUD-69: ROOT-MUSIC + array_offset can exceed 360 upstream."""
    result = fake_collection(make_status(), make_csv(raw_angle="-10.0", peak_bin=10), make_xml(doa="370.0"))
    assert result["doa_candidates"]["csv"]["canonical_angle_deg"] == 10.0
    assert result["doa_candidates"]["xml"]["canonical_angle_deg"] == 10.0
    assert result["native_consistency"]["conflict"] is False
    assert "NATIVE_ANGLE_INVALID" not in result["publication_gate"]["reasons"]

    invalid = fake_collection(make_status(), make_csv(), make_xml(doa="9999.0"))
    consistency = invalid["native_consistency"]
    assert consistency["conflict"] is False
    assert consistency["angle_invalid"] is True
    assert consistency["comparable"] is False
    assert "NATIVE_ANGLE_INVALID" in invalid["publication_gate"]["reasons"]
    assert "NATIVE_DOA_VIEWS_CONFLICT" not in invalid["publication_gate"]["reasons"]
    assert invalid["doa_candidates"]["xml"]["normalization_error_detail"].startswith("candidate.doa_raw_deg")
    assert invalid["overall_state"] == "INCOMPLETE"


def test_xml_parse_error_and_http_status_are_kept():
    """AUD-70: the XML view keeps its parse error; HTTP errors keep their status."""
    result = fake_collection(make_status(), make_csv(), b"<DATA><TIME>bad</TIME></DATA>")
    assert result["doa_candidates"]["xml"]["available"] is False
    assert "xml.TIME" in result["doa_candidates"]["xml"]["error"]
    assert "XML_VIEW_UNAVAILABLE" in result["publication_gate"]["reasons"]

    import urllib.error
    from unittest import mock

    class Opener:
        def __init__(self, error):
            self.error = error

        def open(self, request, timeout):
            raise self.error

    cases = [
        (urllib.error.HTTPError("http://doasdr.local:8081/doa.xml", 404, "Not Found", None, None), "http_status", "HTTP 404", 404),
        (urllib.error.URLError(ConnectionRefusedError(111, "refused")), "connection_refused", "connection refused", None),
        (urllib.error.URLError(TimeoutError("timed out")), "timeout", "timed out", None),
        (__import__("http.client").client.BadStatusLine("garbage"), "protocol", "invalid HTTP response (BadStatusLine)", None),
    ]
    for error, kind, message, status in cases:
        with mock.patch.object(collector.urllib.request, "build_opener", return_value=Opener(error)):
            fetched = collector.fetch_resource("http://doasdr.local:8081", collector.PATH_XML, 0.5)
        assert fetched.ok is False
        assert fetched.error_kind == kind, (fetched.error_kind, kind)
        assert fetched.error == message, fetched.error
        assert fetched.http_status == status
        assert fetched.metadata()["error_kind"] == kind


def test_station_id_is_optional_and_may_contain_commas():
    """AUD-71: an empty XML STATION_ID or a comma in the CSV ID keeps the record."""
    result = fake_collection(make_status(), make_csv(station="POS,1"), make_xml(station=""))
    csv_candidate = result["doa_candidates"]["csv"]
    xml_candidate = result["doa_candidates"]["xml"]
    assert csv_candidate["available"] is True
    assert csv_candidate["station_id"] == "POS,1"
    assert csv_candidate["angular_bins"] == 360
    assert csv_candidate["angular_peak_index"] == 211
    assert xml_candidate["available"] is True
    assert xml_candidate["station_id"] is None
    empty = fake_collection(make_status(), make_csv(), make_xml(station="<STATION_ID></STATION_ID>"))
    assert empty["doa_candidates"]["xml"]["available"] is True


def test_power_floor_is_lossy_for_both_views():
    """AUD-72: upstream clips XML PWR at 0.0 and CSV power at -100 dB."""
    result = fake_collection(make_status(), make_csv(power_raw="-100.0"), make_xml(pwr="0.0"))
    for name in ("csv", "xml"):
        candidate = result["doa_candidates"][name]
        assert candidate["power_mapping_lossy"] is True, name
        assert candidate["power_native_valid"] is False, name
        assert "POWER_FLOOR_LOSSY" in candidate["unit_reasons"], name
    above = fake_collection(make_status(), make_csv(), make_xml(pwr="0.5"))
    assert above["doa_candidates"]["xml"]["power_mapping_lossy"] is False
    assert above["doa_candidates"]["csv"]["power_mapping_lossy"] is False


def test_vector_peak_must_match_theta_0():
    """AUD-73: a mirrored or offset vector is reported, not silently plotted."""
    result = fake_collection(make_status(), make_csv(peak_bin=10), make_xml())
    csv_candidate = result["doa_candidates"]["csv"]
    assert csv_candidate["angular_peak_angle_consistent"] is False
    assert csv_candidate["angular_peak_angle_distance_deg"] == 159.0
    assert "ANGULAR_PEAK_ANGLE_MISMATCH" in result["publication_gate"]["reasons"]
    assert result["publication_gate"]["checks"]["angular_peak_consistent"] is False
    near = fake_collection(make_status(), make_csv(peak_bin=213), make_xml())
    assert near["doa_candidates"]["csv"]["angular_peak_angle_consistent"] is True


def test_overall_state_reports_missing_view_as_incomplete():
    """AUD-75: a missing native view is not reported as UNVERIFIED."""
    result = fake_collection(make_status(), make_csv(), b"")
    assert result["overall_state"] == "INCOMPLETE"
    assert "XML_VIEW_UNAVAILABLE" in result["publication_gate"]["reasons"]
    healthy = fake_collection(make_status(), make_csv(), make_xml())
    assert healthy["overall_state"] == "UNVERIFIED"


def test_missing_status_in_remote_mode_leaves_doa_freshness_unknown():
    """AUD-76: without status.json the Ground clock is not a node reference."""
    result = fake_collection(b"{}", make_csv(), make_xml(), clock_source="remote_unverified")
    freshness = result["doa_candidates"]["csv"]["freshness"]
    assert freshness["freshness_known"] is False
    assert freshness["age_ms"] is None
    assert freshness["fresh"] is None
    assert "DOA_CANDIDATES_STALE" not in result["publication_gate"]["reasons"]
    assert "STATUS_UNAVAILABLE_OR_INVALID" in result["publication_gate"]["reasons"]
    local = fake_collection(b"{}", make_csv(), make_xml(), clock_source="local")
    assert local["doa_candidates"]["csv"]["freshness"]["freshness_known"] is True


def test_cli_help_example_uses_an_allowlisted_host():
    """AUD-78: the documented example must pass the allowlist."""
    help_text = collector._build_parser().format_help()
    assert "10.90.0.2" not in help_text
    assert "192.168.100.100:8081" in help_text
    for host in collector.DEFAULT_ALLOWED_DATA_HOSTS:
        assert host in help_text


if __name__ == "__main__":
    tests = [value for name, value in globals().items() if name.startswith("test_")]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)} tests passed")
