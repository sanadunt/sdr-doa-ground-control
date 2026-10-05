#!/usr/bin/env python3
"""Stage 3 fixture, schema, and Ground Console tests.

All tests are local. Fixture HTTP responses are served from memory/disk; no
Raspberry endpoint, MQTT broker, or remote write path is contacted.
"""

from __future__ import annotations

import base64
import http.cookiejar
import json
import os
import struct
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import zlib
from pathlib import Path
from typing import Any, Dict

TOOLS = Path(__file__).resolve().parent
PROJECT = TOOLS.parent
FIXTURES = TOOLS / "fixtures"
sys.path.insert(0, str(TOOLS))

import ground_console  # noqa: E402
import sdr_doa_collector as collector  # noqa: E402


def disk_collection(name: str) -> Dict[str, Any]:
    root = FIXTURES / name
    assert root.is_dir(), f"fixture missing: {root}"

    def fetcher(base_url: str, path: str, timeout: float, max_body: int) -> collector.FetchedResource:
        file_path = root / path.lstrip("/")
        if not file_path.exists():
            return collector.FetchedResource(
                path=path,
                url=base_url.rstrip("/") + path,
                ok=False,
                http_status=404,
                content_type=None,
                body=b"",
                retrieved_at_ms=1,
                error="fixture file missing",
            )
        return collector.FetchedResource(
            path=path,
            url=base_url.rstrip("/") + path,
            ok=True,
            http_status=200,
            content_type="application/octet-stream",
            body=file_path.read_bytes(),
            retrieved_at_ms=1,
        )

    return collector.collect(
        "http://fixture:8081",
        authority="none",
        clock_source="remote_unverified",
        fetcher=fetcher,
    )


def get_json(url: str) -> Dict[str, Any]:
    with urllib.request.urlopen(url, timeout=2) as response:
        return json.loads(response.read().decode("utf-8"))


def test_dotenv_admin_password_precedence_and_parser() -> None:
    env_file = Path(tempfile.mkdtemp(prefix="sdr-doa-dotenv-test-")) / ".env"
    env_file.write_text(
        "# comment\nexport SDR_DOA_ADMIN_PASSWORD='from-dotenv'\nIGNORED LINE\n",
        encoding="utf-8",
    )
    parsed = ground_console._read_dotenv(env_file)
    assert parsed["SDR_DOA_ADMIN_PASSWORD"] == "from-dotenv"
    assert ground_console._admin_password_from_sources({}, parsed) == "from-dotenv"
    assert ground_console._admin_password_from_sources(
        {"SDR_DOA_ADMIN_PASSWORD": "from-environment"}, parsed
    ) == "from-environment"
    assert ground_console._admin_password_from_sources(
        {"SDR_DOA_ADMIN_PASSWORD": ""}, parsed
    ) is None
    env_file.unlink()
    env_file.parent.rmdir()


def test_valid_fixture_is_parsed_and_gated() -> None:
    result = disk_collection("valid")
    assert result["status"]["daq_health"] == "PASS"
    assert result["doa_candidates"]["csv"]["available"] is True
    assert result["doa_candidates"]["xml"]["available"] is True
    assert result["doa_candidates"]["csv"]["angular_bins"] == 360
    assert result["native_consistency"]["conflict"] is False
    assert result["publication_gate"]["state"] == "BLOCKED"
    assert result["settings"]["raw_fields_omitted"] is True
    assert result["settings"]["redacted"] is True
    serialized = json.dumps(result)
    assert "do-not-return" not in serialized
    assert "secret_token" not in serialized
    assert '"raw_settings":' not in serialized


def test_stale_fixture_uses_same_node_status_timestamp() -> None:
    result = disk_collection("stale")
    csv_freshness = result["doa_candidates"]["csv"]["freshness"]
    assert csv_freshness["reference_kind"] == "status_timestamp_ms"
    assert csv_freshness["fresh"] is False
    assert "DOA_CANDIDATES_STALE" in result["publication_gate"]["reasons"]


def test_unhealthy_fixture_blocks_even_when_output_parses() -> None:
    result = disk_collection("unhealthy")
    assert result["status"]["daq_health"] == "FAIL"
    assert result["publication_gate"]["checks"]["daq_healthy"] is False
    assert result["overall_state"] == "DEGRADED"


def test_malformed_nonfinite_partial_and_missing_status_are_rejected() -> None:
    malformed = disk_collection("malformed")
    assert malformed["doa_candidates"]["csv"]["available"] is False
    assert malformed["doa_candidates"]["xml"]["available"] is False

    nonfinite = disk_collection("nonfinite")
    assert nonfinite["doa_candidates"]["csv"]["available"] is False or nonfinite["doa_candidates"]["xml"]["available"] is False

    partial = disk_collection("partial")
    assert partial["doa_candidates"]["csv"]["available"] is False
    assert partial["doa_candidates"]["xml"]["available"] is False

    missing = disk_collection("missing-status")
    assert missing["status"]["available"] is False
    assert missing["publication_gate"]["state"] == "BLOCKED"


def test_conflicting_native_views_are_quarantined() -> None:
    result = disk_collection("conflict")
    consistency = result["native_consistency"]
    assert consistency["same_timestamp"] is True
    assert consistency["conflict"] is True
    assert "NATIVE_DOA_VIEWS_CONFLICT" in result["publication_gate"]["reasons"]


def test_dry_run_settings_validation_has_no_apply_path() -> None:
    result = ground_console.validate_config_patch(
        {
            "base_config_rev": 7,
            "changes": {
                "center_frequency_hz": 433_920_000,
                "gain_db": 24,
                "vfo_bandwidth_hz": 12_500,
            },
        },
        now_ms=1_000,
    )
    assert result["dry_run"] is True
    assert result["transport"] == "none"
    assert result["applied"] is False
    assert result["command"]["expires_ts_ms"] == 11_000

    for payload in (
        {"changes": {"external_url": "http://not-allowed"}},
        {"changes": {"gain_db": 999}},
        {"changes": {"gain_db": "NaN"}},
    ):
        try:
            ground_console.validate_config_patch(payload, now_ms=1_000)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid patch accepted: {payload}")


def test_ground_console_http_smoke_and_target_allowlist() -> None:
    server = ground_console.GroundConsoleServer(("127.0.0.1", 0), "http://doasdr.local:8081")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with urllib.request.urlopen(base + "/", timeout=2) as response:
            html = response.read().decode("utf-8")
            assert response.status == 200
            assert "SDR-DoA Ground Console" in html
            assert "control dry-run" in html
            assert 'id="doa-polar"' in html
            assert "function drawPolar" in html
            assert 'class="app-chrome"' in html
            assert "--bg: #07140d" in html
            assert "--accent: #39d98a" in html
            assert "--good: #55e38c" in html
            assert 'id="delivery-state"' in html
            assert "refreshSequence" in html
            assert "AbortController" in html
            assert "setPolarUnavailable" in html
            assert "state.polar.figType,state.polar.compassOffset" in html
            assert "native shifted dB" in html
            assert "canonical source angle · θ₀" in html
            assert "plot peak / display angle" in html
            assert "Canonical source angle (θ₀) is separate" in html
            assert "Plotted 360-bin peak display angle" in html
            assert "const directions=[['N',0],['E',90],['S',180],['W',270]]" in html
            assert "const diagonalDegrees=new Set([45,135,225,315])" in html
            assert "aria-describedby=\"polar-legend compass-detail\"" in html
            assert "grid-template-columns: repeat(2, minmax(0, 1fr));" in html
            assert 'id="doa-compass"' not in html
            # Mission-control shell and safe OSM readiness state.
            assert 'class="nav-rail"' in html
            assert 'id="logo-open-settings"' not in html
            assert "logo-open-settings" not in html
            assert "Branding saved and verified from Ground Console local storage." in html
            assert "const verify=await fetch('/api/branding'" in html
            assert "function setSnapshotUnavailable" in html
            assert "Previous signal rows cleared." in html
            assert "Previous native views cleared." in html
            assert "Previous node health cleared." in html
            assert "Previous map coordinates cleared after read failure." in html
            assert 'data-nav="overview"' in html
            assert 'data-nav="live-doa"' in html
            assert 'data-nav="tracks-targets"' in html
            assert 'data-nav="spectrum"' in html
            assert 'data-nav="events"' in html
            assert 'data-nav="system-health"' in html
            assert 'data-nav="configuration"' in html
            assert 'id="map-panel"' in html
            assert 'data-map-state="waiting"' in html
            assert "MAP NOT CONFIGURED" in html
            assert "WAITING FOR COORDINATES" in html
            assert 'id="map-state-badge"' in html
            assert "UNAVAILABLE · NO POSITION FIX" in html
            assert "REAL COORDINATES · NO MARKER" in html
            assert "© OpenStreetMap contributors" in html
            assert "function renderMap" in html
            assert "if(latitude===0&&longitude===0) return null" in html
            assert "gpsDisabled" in html
            assert "freshnessReady" in html
            assert "coordinateConflict" in html
            assert "WAITING FOR CONSISTENT COORDINATES" in html
            assert "No fresh, valid, mutually consistent latitude / longitude fields" in html
            assert "GPS is disabled; 0/0 is treated as unset" in html
            assert "no synthetic marker" in html
            assert ".inspector-column .table-wrap .data-table { width: 100%; min-width: 0;" in html
            assert ".inspector-column .table-wrap { overflow-x: visible; }" in html
            assert "minmax(286px, 300px)" in html
            assert "minmax(276px, 288px)" in html
            assert 'class="detail-side-stack"' in html
            assert "minmax(0, 1.45fr) minmax(270px, .85fr)" in html
            assert "--subtle: #7fae89" in html
            assert 'id="tracks-targets"' in html
            assert 'id="event-log"' in html
            assert 'id="health-grid"' in html
            assert 'class="inspector-column"' in html
            assert "@media (max-width: 700px)" in html
            assert ".spatial-grid { grid-template-columns: 1fr; }" in html

        capabilities = get_json(base + "/api/capabilities")
        assert capabilities["read_only"] is True
        assert capabilities["mqtt_publish"] is False
        assert capabilities["config_apply"] is False

        request = urllib.request.Request(
            base + "/api/dry-run/config-patch",
            data=json.dumps({"changes": {"gain_db": 24}}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        dry_run = get_json(request)  # type: ignore[arg-type]
        assert dry_run["dry_run"] is True
        assert dry_run["applied"] is False
        assert dry_run["transport"] == "none"

        external = base + "/api/snapshot?base_url=http%3A%2F%2Fexample.com%3A8081"
        try:
            urllib.request.urlopen(external, timeout=2)
        except urllib.error.HTTPError as exc:
            assert exc.code == 400
        else:
            raise AssertionError("console accepted an external snapshot target")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _minimal_png() -> bytes:
    signature = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    ihdr_data = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    scanline = bytes([0x00, 0x10, 0x20, 0x30, 0xFF])
    return signature + chunk(b"IHDR", ihdr_data) + chunk(b"IDAT", zlib.compress(scanline)) + chunk(b"IEND", b"")


def test_branding_validation_and_console_config_reload() -> None:
    for corrupt in ("[]", "null", '"text"', '{"app_name": 12}'):
        fd, path = tempfile.mkstemp(prefix="sdr-doa-branding-corrupt-", suffix=".json")
        os.close(fd)
        Path(path).write_text(corrupt, encoding="utf-8")
        assert ground_console._load_branding(Path(path)) == ground_console._default_branding()
        os.unlink(path)

    fake = "data:image/png;base64," + base64.b64encode(b"not-an-image").decode("ascii")
    try:
        ground_console._normalize_logo_data_url(fake)
    except ValueError:
        pass
    else:
        raise AssertionError("fake PNG bytes were accepted")
    valid = "data:image/png;base64," + base64.b64encode(_minimal_png()).decode("ascii")
    assert ground_console._normalize_logo_data_url(valid).startswith("data:image/png;base64,")
    for mime, raw in (
        ("image/jpeg", b"\xff\xd8\xff\xd9"),
        ("image/gif", b"GIF89a" + b"\x01\x00\x01\x00" + b"\x00"),
        ("image/webp", b"RIFF" + b"\x16\x00\x00\x00WEBPVP8X" + b"\x00" * 10),
    ):
        unsupported = f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")
        try:
            ground_console._normalize_logo_data_url(unsupported)
        except ValueError:
            pass
        else:
            raise AssertionError(f"unsupported {mime} was accepted")

    # A PNG-shaped payload with an invalid compressed scanline must be rejected.
    broken_png = bytearray(_minimal_png())
    idat = broken_png.find(b"IDAT")
    broken_png[idat + 4] ^= 0x01
    broken_data_url = "data:image/png;base64," + base64.b64encode(broken_png).decode("ascii")
    try:
        ground_console._normalize_logo_data_url(broken_data_url)
    except ValueError:
        pass
    else:
        raise AssertionError("corrupt PNG image data was accepted")

    fd, config_path = tempfile.mkstemp(prefix="sdr-doa-console-config-", suffix=".json")
    os.close(fd)
    os.unlink(config_path)
    first = ground_console.GroundConsoleServer(
        ("127.0.0.1", 0),
        "http://doasdr.local:8081",
        config_path=config_path,
    )
    try:
        saved = first.update_config({
            "base_url": "http://192.168.100.100:8081",
            "mqtt_host": "127.0.0.1",
            "mqtt_port": 1883,
            "refresh_seconds": 10,
        })
        assert saved["base_url"] == "http://192.168.100.100:8081"
        assert ground_console._load_console_config(Path(config_path))["refresh_seconds"] == 10
    finally:
        first.server_close()
    second = ground_console.GroundConsoleServer(
        ("127.0.0.1", 0),
        "http://doasdr.local:8081",
        config_path=config_path,
    )
    try:
        assert second.get_config()["base_url"] == "http://192.168.100.100:8081"
        assert second.get_config()["mqtt_host"] == "127.0.0.1"
        assert second.get_config()["refresh_seconds"] == 10
    finally:
        second.server_close()
        os.unlink(config_path)
    print("PASS branding validation and console config reload")


def test_mqtt_topic_map_is_bounded() -> None:
    try:
        from sdr_doa_mqtt_monitor import MqttMonitor
    except ModuleNotFoundError:
        print("SKIP MQTT topic bound; paho-mqtt unavailable")
        return

    class Message:
        qos = 0
        retain = False

        def __init__(self, topic: str) -> None:
            self.topic = topic
            self.payload = b"x"

    monitor = MqttMonitor("127.0.0.1", 1883)
    client = object()
    monitor._client = client
    monitor._started = True
    for index in range(300):
        monitor._on_message(client, None, Message(f"sdr/v1/uav-01/unknown/{index}"))
    counts = monitor.snapshot()["topic_counts"]
    assert len(counts) <= 128
    assert counts.get("__other__", 0) > 0
    print("PASS MQTT topic map is bounded")


def test_local_mqtt_restore_transition() -> None:
    class FakeMonitor:
        def __init__(self, host: str, port: int, transport: str = "tcp") -> None:
            self.host = host
            self.port = port
            self.transport = transport
            self.started = False
            self.stopped = False

        def start(self) -> None:
            self.started = True

        def stop(self) -> None:
            self.stopped = True

    original_loader = ground_console._load_mqtt_monitor_class
    ground_console._load_mqtt_monitor_class = lambda: FakeMonitor
    try:
        with tempfile.TemporaryDirectory(prefix="sdr-doa-mqtt-restore-") as td:
            config_path = Path(td) / "console.json"
            initial = ground_console._default_console_config(
                "http://doasdr.local:8081", "127.0.0.1", 1883, 0
            )
            server = ground_console.GroundConsoleServer(
                ("127.0.0.1", 0),
                initial["base_url"],
                config_path=str(config_path),
                config=initial,
            )
            try:
                saved = server.apply_config(initial)
                assert saved["mqtt_host"] == "127.0.0.1"
                assert isinstance(server.mqtt_monitor, FakeMonitor)
                assert server.mqtt_monitor.started
                assert server.mqtt_monitor.transport == "websockets"
            finally:
                if server.mqtt_monitor is not None:
                    server.mqtt_monitor.stop()
                server.server_close()
    finally:
        ground_console._load_mqtt_monitor_class = original_loader
    print("PASS local MQTT restore transition")


def test_local_mqtt_disable_transition() -> None:
    class FakeMonitor:
        host = "127.0.0.1"
        port = 1883

        def __init__(self) -> None:
            self.stopped = False

        def stop(self) -> None:
            self.stopped = True

    with tempfile.TemporaryDirectory(prefix="sdr-doa-mqtt-transition-") as td:
        config_path = Path(td) / "console.json"
        old = FakeMonitor()
        initial = ground_console._default_console_config(
            "http://doasdr.local:8081", "127.0.0.1", 1883, 0
        )
        server = ground_console.GroundConsoleServer(
            ("127.0.0.1", 0),
            initial["base_url"],
            mqtt_monitor=old,
            config_path=str(config_path),
            config=initial,
        )
        try:
            saved = server.apply_config({**server.get_config(), "mqtt_host": ""})
            assert saved["mqtt_host"] == ""
            assert server.mqtt_monitor is None
            assert old.stopped
            assert ground_console._load_console_config(config_path)["mqtt_host"] == ""
        finally:
            server.server_close()
    print("PASS local MQTT disable transition")


def test_local_admin_branding_session_and_loopback_guard() -> None:
    fd, branding_path = tempfile.mkstemp(prefix="sdr-doa-branding-test-", suffix=".json")
    os.close(fd)
    os.unlink(branding_path)
    previous_admin_password = os.environ.get("SDR_DOA_ADMIN_PASSWORD")
    previous_module_password = ground_console.ADMIN_PASSWORD
    os.environ["SDR_DOA_ADMIN_PASSWORD"] = "test-only-admin-password"
    ground_console.ADMIN_PASSWORD = os.environ["SDR_DOA_ADMIN_PASSWORD"]
    try:
        server = ground_console.GroundConsoleServer(
            ("127.0.0.1", 0),
            "http://doasdr.local:8081",
            branding_path=branding_path,
        )
    except BaseException:
        if previous_admin_password is None:
            os.environ.pop("SDR_DOA_ADMIN_PASSWORD", None)
        else:
            os.environ["SDR_DOA_ADMIN_PASSWORD"] = previous_admin_password
        ground_console.ADMIN_PASSWORD = previous_module_password
        raise
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    try:
        thread.start()
    except BaseException:
        server.server_close()
        try:
            os.unlink(branding_path)
        except FileNotFoundError:
            pass
        if previous_admin_password is None:
            os.environ.pop("SDR_DOA_ADMIN_PASSWORD", None)
        else:
            os.environ["SDR_DOA_ADMIN_PASSWORD"] = previous_admin_password
        ground_console.ADMIN_PASSWORD = previous_module_password
        raise
    base = f"http://127.0.0.1:{server.server_address[1]}"

    def post_json(path: str, payload: Dict[str, Any], opener: Any = None) -> tuple[int, Dict[str, Any]]:
        request = urllib.request.Request(
            base + path,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            open_url = opener.open if opener is not None else urllib.request.urlopen
            with open_url(request, timeout=2) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))

    try:
        assert post_json("/api/admin/branding", {"app_name": "must-not-save"})[0] == 401
        assert post_json("/api/admin/login", {"password": "wrong"})[0] == 401

        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        assert post_json("/api/admin/login", {"password": "test-only-admin-password"}, opener)[0] == 200
        assert post_json(
            "/api/admin/branding",
            {"app_name": "Pos Komando SDR", "logo_data_url": ""},
            opener,
        )[0] == 200
        assert get_json(base + "/api/branding")["app_name"] == "Pos Komando SDR"
        assert post_json("/api/admin/branding", {"app_name": "x", "logo_data_url": "data:text/plain;base64,eA=="}, opener)[0] == 400
        assert post_json("/api/admin/logout", {}, opener)[0] == 200
        assert post_json("/api/admin/branding", {"app_name": "after-logout"}, opener)[0] == 401
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        try:
            os.unlink(branding_path)
        except FileNotFoundError:
            pass
        if previous_admin_password is None:
            os.environ.pop("SDR_DOA_ADMIN_PASSWORD", None)
        else:
            os.environ["SDR_DOA_ADMIN_PASSWORD"] = previous_admin_password
        ground_console.ADMIN_PASSWORD = previous_module_password

    try:
        ground_console.GroundConsoleServer(("0.0.0.0", 0), "http://doasdr.local:8081")
    except ValueError as exc:
        assert "loopback" in str(exc)
    else:
        raise AssertionError("Ground Console accepted a non-loopback bind")


if __name__ == "__main__":
    tests = [value for name, value in globals().items() if name.startswith("test_")]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)} stage-3 tests passed")
