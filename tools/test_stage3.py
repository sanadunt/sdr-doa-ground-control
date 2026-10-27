#!/usr/bin/env python3
"""Stage 3 fixture, schema, and Ground Console tests.

All tests are local. Fixture HTTP responses are served from memory/disk; no
Raspberry endpoint, MQTT broker, or remote write path is contacted.
"""

from __future__ import annotations

import atexit
import base64
import contextlib
import http.client
import http.cookiejar
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional
from unittest import mock

TOOLS = Path(__file__).resolve().parent
PROJECT = TOOLS.parent
FIXTURES = TOOLS / "fixtures"
sys.path.insert(0, str(TOOLS))

import ground_console  # noqa: E402
import sdr_doa_collector as collector  # noqa: E402


@contextlib.contextmanager
def isolated_server(
    base_url: str = "http://doasdr.local:8081",
    *,
    serve: bool = False,
    **kwargs: Any,
) -> Iterator[Any]:
    """Run a console whose config, branding and Receiver data stay in a temp dir.

    Without explicit paths the server would read and create state under the
    developer's real ~/.config and ~/.local/share.
    """
    with tempfile.TemporaryDirectory(prefix="sdr-doa-stage3-") as temporary:
        root = Path(temporary)
        kwargs.setdefault("config_path", str(root / "console.json"))
        kwargs.setdefault("branding_path", str(root / "branding.json"))
        kwargs.setdefault("receiver_data_dir", root / "receiver-data")
        server = ground_console.GroundConsoleServer(("127.0.0.1", 0), base_url, **kwargs)
        thread = threading.Thread(target=server.serve_forever, daemon=True) if serve else None
        try:
            if thread is not None:
                thread.start()
            yield server
        finally:
            if thread is not None:
                server.shutdown()
                thread.join(timeout=5)
            server.server_close()


def scratch_dir(label: str) -> Path:
    """Temporary state directory removed when the test process exits."""
    path = tempfile.mkdtemp(prefix=f"sdr-doa-stage3-{label}-")
    atexit.register(shutil.rmtree, path, True)
    return Path(path)


def fixture_fetcher(name: str) -> Any:
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

    return fetcher


def disk_collection(name: str) -> Dict[str, Any]:
    return collector.collect(
        "http://fixture:8081",
        authority="none",
        clock_source="remote_unverified",
        fetcher=fixture_fetcher(name),
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
    # Absent from both sources: the documented default applies (the UI warns).
    assert ground_console._admin_password_from_sources({}, {}) == "123456"
    assert ground_console.DEFAULT_ADMIN_PASSWORD == "123456"
    # An explicitly empty .env value still disables login.
    assert ground_console._admin_password_from_sources({}, {"SDR_DOA_ADMIN_PASSWORD": ""}) is None
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
            "changes": {
                "center_frequency_hz": 433_920_000,
                "vfo0_frequency_hz": 433_920_000,
                "gain_db": 20.7,
                "vfo0_bandwidth_hz": 12_500,
            },
        },
        now_ms=1_000,
    )
    assert result["dry_run"] is True
    assert result["transport"] == "none"
    assert result["applied"] is False
    assert result["command"]["expires_ms"] == 16_000

    for payload in (
        {"changes": {"external_url": "http://not-allowed"}},
        {"changes": {"gain_db": 999}},
        {"changes": {"gain_db": "NaN"}},
        {"changes": {"gain_db": 24}},
        {"changes": {"center_frequency_hz": 433_920_000}},
    ):
        try:
            ground_console.validate_config_patch(payload, now_ms=1_000)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid patch accepted: {payload}")


def test_ground_console_http_smoke_and_target_allowlist() -> None:
    with isolated_server(serve=True) as server:
        _http_smoke_and_target_allowlist(f"http://127.0.0.1:{server.server_address[1]}")


def _http_smoke_and_target_allowlist(base: str) -> None:
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
    # One admin-gated publish path exists; the console still never applies
    # settings or POSTs to the Raspberry, and the dry run below stays a preview.
    assert capabilities["read_only"] is False
    assert capabilities["mqtt_publish"] is True
    assert capabilities["config_apply"] is False
    assert capabilities["remote_post"] is False
    assert capabilities["config_patch"]["requires_admin"] is True
    assert capabilities["config_patch"]["enabled"] is False  # no MQTT monitor here

    request = urllib.request.Request(
        base + "/api/dry-run/config-patch",
        data=json.dumps({"changes": {"gain_db": 20.7}}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    dry_run = get_json(request)  # type: ignore[arg-type]
    assert dry_run["dry_run"] is True
    assert dry_run["applied"] is False
    assert dry_run["transport"] == "none"
    # No MQTT monitor here, so no node session to name.
    assert dry_run["session_known"] is False
    assert dry_run["command"]["base_rev"] is None

    off_table = urllib.request.Request(
        base + "/api/dry-run/config-patch",
        data=json.dumps({"changes": {"gain_db": 24}}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(off_table, timeout=2)
    except urllib.error.HTTPError as exc:
        assert exc.code == 400
        body = json.loads(exc.read().decode("utf-8"))
        assert body["ok"] is False and "GAIN_NOT_IN_APPROVED_TABLE" in body["error"]
    else:
        raise AssertionError("dry-run accepted a gain the edge's helper refuses")

    external = base + "/api/snapshot?base_url=http%3A%2F%2Fexample.com%3A8081"
    try:
        urllib.request.urlopen(external, timeout=2)
    except urllib.error.HTTPError as exc:
        assert exc.code == 400
    else:
        raise AssertionError("console accepted an external snapshot target")


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
    state = scratch_dir("config-reload")
    first = ground_console.GroundConsoleServer(
        ("127.0.0.1", 0),
        "http://doasdr.local:8081",
        config_path=config_path,
        branding_path=str(state / "branding.json"),
        receiver_data_dir=state / "receiver-data",
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
        branding_path=str(state / "branding.json"),
        receiver_data_dir=state / "receiver-data",
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
                branding_path=str(Path(td) / "branding.json"),
                receiver_data_dir=Path(td) / "receiver-data",
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
            branding_path=str(Path(td) / "branding.json"),
            receiver_data_dir=Path(td) / "receiver-data",
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
        state = scratch_dir("admin")
        server = ground_console.GroundConsoleServer(
            ("127.0.0.1", 0),
            "http://doasdr.local:8081",
            branding_path=branding_path,
            config_path=str(state / "console.json"),
            receiver_data_dir=state / "receiver-data",
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

    def post_json(
        path: str, payload: Dict[str, Any], opener: Any = None, origin: Optional[str] = base,
    ) -> tuple[int, Dict[str, Any]]:
        headers = {"Content-Type": "application/json"}
        if origin is not None:
            headers["Origin"] = origin
        request = urllib.request.Request(
            base + path,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
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
        wrong_status, wrong_body = post_json("/api/admin/login", {"password": "wrong"})
        assert wrong_status == 401
        assert wrong_body["code"] == "ADMIN_PASSWORD_INVALID"
        assert get_json(base + "/api/capabilities")["admin_enabled"] is True

        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        for origin in (None, "https://evil.example"):
            status, body = post_json("/api/admin/login", {"password": "test-only-admin-password"}, opener, origin)
            assert (status, body["code"]) == (403, "ORIGIN_REJECTED")
        assert not list(jar)
        assert post_json("/api/admin/login", {"password": "test-only-admin-password"}, opener)[0] == 200
        assert post_json(
            "/api/admin/branding",
            {"app_name": "Pos Komando SDR", "logo_data_url": ""},
            opener,
        )[0] == 200
        assert get_json(base + "/api/branding")["app_name"] == "Pos Komando SDR"
        assert post_json("/api/admin/branding", {"app_name": "x", "logo_data_url": "data:text/plain;base64,eA=="}, opener)[0] == 400
        # A cross-site logout is refused and leaves the session in place.
        assert post_json("/api/admin/logout", {}, opener, "https://evil.example")[0] == 403
        with opener.open(base + "/api/admin/status", timeout=2) as response:
            assert json.loads(response.read().decode("utf-8")) == {"authenticated": True}
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


def test_fixture_vectors_follow_upstream_peak_convention() -> None:
    """AUD-73: fixtures put the vector peak on theta_0; one fixture keeps a mismatch."""
    valid = disk_collection("valid")
    csv_candidate = valid["doa_candidates"]["csv"]
    assert csv_candidate["angular_peak_index"] == 211
    assert csv_candidate["canonical_angle_deg"] == 211.0
    assert csv_candidate["angular_peak_angle_consistent"] is True
    assert "ANGULAR_PEAK_ANGLE_MISMATCH" not in valid["publication_gate"]["reasons"]

    conflict = disk_collection("conflict")
    assert conflict["doa_candidates"]["csv"]["angular_peak_angle_consistent"] is True
    assert conflict["overall_state"] == "CONFLICT"

    mismatch = disk_collection("peak-mismatch")
    assert mismatch["doa_candidates"]["csv"]["angular_peak_index"] == 10
    assert mismatch["doa_candidates"]["csv"]["angular_peak_angle_consistent"] is False
    assert "ANGULAR_PEAK_ANGLE_MISMATCH" in mismatch["publication_gate"]["reasons"]


def test_dry_run_uses_the_edge_command_validator() -> None:
    """AUD-74: a passed preview is the config.patch envelope Kontrol would send the edge."""
    import rdf_node_commands

    session = {"sid": "7a8b9c0d", "boot": "10aa2345-6789-4abc-9def-1234567890ab", "cfg": 0}
    result = ground_console.validate_config_patch(
        {"changes": {"center_frequency_hz": 433_920_000.0, "vfo0_frequency_hz": 433_920_000, "gain_db": 20.7004}},
        now_ms=1_790_000_000_000,
        session=session,
    )
    assert result["validation"] == "passed"
    assert result["contract"] == "RDF Node config.patch"
    assert result["topic"] == "sdr/v2/uav-01/cmd/config/patch"
    command = result["command"]
    assert (command["sid"], command["boot"], command["base_rev"]) == (session["sid"], session["boot"], 0)
    assert command["changes"] == {"center_frequency_hz": 433_920_000, "gain_db": 20.7, "vfo0_frequency_hz": 433_920_000}
    rdf_node_commands.validate_command(command, now_ms=1_790_000_000_000)
    for payload in (
        {"changes": {"gain_db": 24}},
        {"base_config_rev": 7, "changes": {"gain_db": 20.7}},
        {"base_rev": 7, "changes": {"gain_db": 20.7}},
        {"changes": {"gain_db": "20.7"}},
        {"changes": {"gain_db": True}},
        {"changes": {"vfo_frequency_hz": 433_920_000}},
        {"changes": {"center_frequency_hz": 433_920_000, "vfo0_frequency_hz": 433_930_000}},
    ):
        try:
            ground_console.validate_config_patch(payload, now_ms=5_000)
        except ValueError:
            continue
        raise AssertionError(f"dry-run accepted {payload!r}")


def test_snapshot_requests_share_one_collection() -> None:
    """AUD-09: concurrent /api/snapshot calls do not pile up collections."""
    calls: List[Dict[str, Any]] = []
    release = threading.Event()

    def slow_collect(**kwargs: Any) -> Dict[str, Any]:
        calls.append(kwargs)
        release.wait(5)
        return {"overall_state": "FIXTURE", "call": len(calls)}

    results: List[Any] = []

    def fetch(base: str) -> None:
        try:
            results.append(get_json(base + "/api/snapshot"))
        except Exception as exc:  # surfaced by the assertions below
            results.append(exc)

    with mock.patch.object(ground_console, "collect", side_effect=slow_collect), isolated_server(serve=True) as server:
        base = f"http://127.0.0.1:{server.server_address[1]}"
        threads = [threading.Thread(target=fetch, args=(base,)) for _ in range(5)]
        for thread in threads:
            thread.start()
        deadline = time.monotonic() + 3
        while not calls and time.monotonic() < deadline:
            time.sleep(0.01)
        time.sleep(0.2)
        release.set()
        for thread in threads:
            thread.join(timeout=10)
    assert len(calls) == 1, len(calls)
    assert calls[0]["total_budget_s"] == ground_console.SNAPSHOT_TOTAL_BUDGET_S
    assert isinstance(calls[0]["progress_tracker"], collector.NodeProgressTracker)
    assert isinstance(calls[0]["settings_cache"], collector.SettingsCache)
    assert calls[0]["fresh_settings"] is False
    collections = [result.pop("collection") for result in results]
    # No MQTT monitor and no status.json in the fixture: every answer names no source (#8).
    sources = [result.pop("source") for result in results]
    assert [(entry["kind"], entry["reasons"]) for entry in sources] == [("none", ["MQTT_DISABLED", "DATA_OUT_UNAVAILABLE"])] * 5, sources
    assert results == [{"overall_state": "FIXTURE", "call": 1}] * 5, results
    # One request started the collection; the other four shared it (#13).
    assert len({entry["id"] for entry in collections}) == 1, collections
    assert sorted(entry["shared"] for entry in collections) == [False, True, True, True, True], collections


def test_snapshot_reports_malformed_http_as_json() -> None:
    """AUD-77: a protocol error becomes a JSON 502, not a dropped connection."""
    with mock.patch.object(ground_console, "collect", side_effect=http.client.BadStatusLine("garbage")), isolated_server(serve=True) as server:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{server.server_address[1]}/api/snapshot", timeout=5)
        except urllib.error.HTTPError as exc:
            assert exc.code == 502
            assert json.loads(exc.read().decode("utf-8"))["read_only"] is True
        else:
            raise AssertionError("protocol error was reported as success")


def test_snapshot_tracks_node_progress_across_requests() -> None:
    """AUD-02: the server keeps one tracker, so a frozen node turns STALLED."""
    clock = [1_000.0]
    fetcher = fixture_fetcher("valid")

    def frozen_collect(**kwargs: Any) -> Dict[str, Any]:
        return collector.collect(fetcher=fetcher, monotonic_clock=lambda: clock[0], **kwargs)

    with mock.patch.object(ground_console, "collect", side_effect=frozen_collect), isolated_server(serve=True) as server:
        # The shared Data Out read (#13) keeps a collection for the refresh
        # interval; on the same clock the second request is 11 s later.
        server.data_out.clock = lambda: clock[0]
        base = f"http://127.0.0.1:{server.server_address[1]}"
        first = get_json(base + "/api/snapshot")
        assert first["node_progress"]["state"] == "FIRST_SAMPLE"
        assert first["doa_candidates"]["csv"]["freshness"]["fresh"] is True
        clock[0] += 11
        stalled = get_json(base + "/api/snapshot")
    assert stalled["node_progress"]["state"] == "STALLED"
    assert "NODE_CLOCK_STALLED" in stalled["publication_gate"]["reasons"]
    assert stalled["doa_candidates"]["csv"]["freshness"]["fresh"] is False
    assert stalled["overall_state"] == "STALE"


def test_admin_login_reports_disabled_state() -> None:
    """AUD-81: no configured password is a disabled login, not a wrong password."""
    previous = ground_console.ADMIN_PASSWORD
    ground_console.ADMIN_PASSWORD = None
    try:
        with isolated_server(serve=True) as server:
            base = f"http://127.0.0.1:{server.server_address[1]}"
            request = urllib.request.Request(
                base + "/api/admin/login",
                data=json.dumps({"password": "anything"}).encode("utf-8"),
                headers={"Content-Type": "application/json", "Origin": base},
                method="POST",
            )
            try:
                urllib.request.urlopen(request, timeout=2)
            except urllib.error.HTTPError as exc:
                assert exc.code == 503
                body = json.loads(exc.read().decode("utf-8"))
                assert body["code"] == "ADMIN_DISABLED"
                assert "SDR_DOA_ADMIN_PASSWORD" in body["error"]
            else:
                raise AssertionError("login succeeded without a configured password")
            capabilities = get_json(base + "/api/capabilities")
            assert capabilities["admin_enabled"] is False
            assert capabilities["refresh_intervals_s"] == [0, 1, 2, 5, 10, 30]
            assert capabilities["snapshot_budget_ms"] == 4_000
    finally:
        ground_console.ADMIN_PASSWORD = previous


def test_refresh_intervals_include_sub_window_values() -> None:
    """AUD-24: 1 s and 2 s are shorter than the 5 s DoA window; 2 s is the new default."""
    base = ground_console._default_console_config()
    assert base["refresh_seconds"] == 2
    for seconds in (0, 1, 2, 5, 10, 30):
        assert ground_console._validate_console_config({**base, "refresh_seconds": seconds})["refresh_seconds"] == seconds
    for seconds in (3, 4, -1, 60):
        try:
            ground_console._validate_console_config({**base, "refresh_seconds": seconds})
        except ValueError:
            continue
        raise AssertionError(f"refresh interval accepted: {seconds}")
    with isolated_server() as server:
        assert server.get_config()["refresh_seconds"] == 2


def test_console_config_keeps_valid_fields_and_backs_up_invalid_file() -> None:
    """AUD-84: one bad field no longer discards every saved setting."""
    warnings: List[str] = []
    state = scratch_dir("config-fields")
    path = state / "console.json"
    path.write_text(json.dumps({
        "version": 1,
        "base_url": "http://192.168.100.100:8081",
        "mqtt_host": "not a host",
        "mqtt_port": 1883,
        "refresh_seconds": 10,
    }), encoding="utf-8")
    loaded = ground_console._load_console_config(path, log=warnings.append)
    assert loaded["base_url"] == "http://192.168.100.100:8081"
    assert loaded["mqtt_port"] == 1883
    assert loaded["refresh_seconds"] == 10
    assert loaded["mqtt_host"] == ground_console._default_console_config()["mqtt_host"]
    assert any("mqtt_host" in message and "not a host" not in message for message in warnings), warnings
    backup = state / "console.json.invalid.bak"
    assert backup.read_text(encoding="utf-8") == path.read_text(encoding="utf-8")

    warnings.clear()
    path.write_text('{"base_url": "http://192.168.100.100:8081",}', encoding="utf-8")
    assert ground_console._load_console_config(path, log=warnings.append) == ground_console._default_console_config()
    assert any("not valid JSON at line 1" in message for message in warnings), warnings
    assert backup.read_text(encoding="utf-8") == path.read_text(encoding="utf-8")

    warnings.clear()
    missing = ground_console._load_console_config(state / "absent.json", log=warnings.append)
    assert missing == ground_console._default_console_config()
    assert warnings == []


def test_explicit_cli_flags_override_saved_console_config() -> None:
    """AUD-82: a typed --base-url wins over console.json for this run."""
    saved = ground_console._default_console_config("http://doasdr.local:8081", "127.0.0.1", 1883, 10)
    argv = ["--base-url", "http://192.168.100.100:8081", "--mqtt-host", ""]
    args = ground_console._build_parser().parse_args(argv)
    explicit = ground_console._explicit_cli_options(argv)
    assert {"base_url", "mqtt_host"} <= explicit
    assert "mqtt_port" not in explicit
    notices: List[str] = []
    merged = ground_console._apply_cli_overrides(saved, args, explicit, log=notices.append)
    assert merged["base_url"] == "http://192.168.100.100:8081"
    assert merged["mqtt_host"] == ""
    assert merged["mqtt_port"] == 1883
    assert merged["refresh_seconds"] == 10
    assert len(notices) == 2, notices
    untouched = ground_console._apply_cli_overrides(saved, ground_console._build_parser().parse_args([]), ground_console._explicit_cli_options([]))
    assert untouched == saved


def test_legacy_ui_bounds_requests_and_expires_locally() -> None:
    """AUD-28/AUD-85/AUD-24: legacy page times out, ages out data, hides empty logos."""
    html = ground_console.HTML
    assert "const REQUEST_TIMEOUT_MS=8000;" in html
    assert "function scheduleLocalExpiry(snapshot)" in html
    assert "render(data); scheduleLocalExpiry(data);" in html
    assert "if(auto&&state.refreshController) return;" in html
    assert "setInterval(()=>refresh({auto:true}),interval*1000)" in html
    assert "[hidden] { display: none !important; }" in html
    assert '<option value="1">Every 1 second</option><option value="2">Every 2 seconds</option>' in html


def test_legacy_ui_follows_the_shared_data_out_read() -> None:
    """#13: Refresh asks for a new read, reads name the shown one, ages count the shared read."""
    html = ground_console.HTML
    assert "$('refresh').addEventListener('click',()=>refresh({manual:true}));" in html
    assert "await refresh({manual:true}); }" in html, "Apply & refresh is the operator's read too"
    assert "(manual?'&refresh=1':'')+(state.collectionId?'&seen='+encodeURIComponent(state.collectionId):'')" in html
    assert "render(data); scheduleLocalExpiry(data); followConsoleInterval(data);" in html
    assert "const maxAge=validAges?Math.max(...ages)+servedAgeMs(snapshot):null;" in html
    # The interval select is saved with Apply like the other connection fields.
    assert "$('refresh-interval').addEventListener('change'" not in html
    assert "setAuto(state.autoTimer?0:(state.consoleSeconds>0?state.consoleSeconds:2))" in html
    node = shutil.which("node")
    if node is None:
        print("SKIP test_legacy_ui_follows_the_shared_data_out_read (node part): node not found")
        return
    sources = []
    for name in ("localExpiryMs", "servedAgeMs", "followConsoleInterval"):
        start = html.index(f"function {name}(")
        end = html.index("\n}", start) + 2 if name == "localExpiryMs" else html.index("\n", start)
        sources.append(html[start:end])
    script = "\n".join(sources) + r"""
const calls = [];
const state = { autoTimer: 1, autoSeconds: 2, consoleSeconds: 2 };
function setAuto(seconds, readNow) { calls.push([seconds, readNow]); state.autoSeconds = seconds; }
const live = (age, served) => ({ status: { available: true }, collection: { age_ms: served },
  doa_candidates: { csv: { freshness: { fresh: true, age_ms: age, max_age_ms: 5000 } } } });
const expiry = [localExpiryMs(live(400, 0)), localExpiryMs(live(400, 3500)), localExpiryMs(live(400, 9000)),
  servedAgeMs(live(0, 1e9)), servedAgeMs(live(0, -5)), servedAgeMs({})];
followConsoleInterval({ collection: { refresh_seconds: 30 } });
followConsoleInterval({ collection: { refresh_seconds: 30 } });
followConsoleInterval({ collection: { refresh_seconds: 0 } });
const afterManual = state.consoleSeconds;
followConsoleInterval({ collection: { refresh_seconds: 'x' } });
state.autoTimer = null;
followConsoleInterval({ collection: { refresh_seconds: 5 } });
process.stdout.write(JSON.stringify({ expiry, calls, afterManual, consoleSeconds: state.consoleSeconds }));
"""
    result = subprocess.run([node, "-e", script], capture_output=True, text=True, timeout=20, check=True)
    out = json.loads(result.stdout)
    # The time the answer waited on the console comes off the DoA window; the bound is the React one.
    assert out["expiry"] == [4600, 1100, 0, 120000, 0, 0], out
    # A running auto-refresh moves to the console's interval once, without an extra read;
    # manual mode on the console and a stopped auto-refresh leave the timer alone.
    assert out["calls"] == [[30, False]], out
    assert out["afterManual"] == 0 and out["consoleSeconds"] == 5, out


def test_legacy_ui_follows_the_console_data_out_url() -> None:
    """#11/#13 review: a legacy page on the old URL follows the URL the console reads."""
    html = ground_console.HTML
    assert "followConsoleInterval(data); followConsoleUrl(data.collection?.console_base_url); }" in html
    assert "if(data.code==='DATA_OUT_URL_NOT_ALLOWED') followSavedUrl();" in html
    node = shutil.which("node")
    if node is None:
        print("SKIP test_legacy_ui_follows_the_console_data_out_url (node part): node not found")
        return
    start = html.index("function followConsoleUrl(")
    script = html[start:html.index("\n", start)] + r"""
const reads = [];
const fields = { 'data-url': { value: '' }, 'source-url': { textContent: '' } };
const $ = (id) => fields[id];
const state = { dataUrl: 'http://doasdr.local:8081', collectionId: '0badc0de-4' };
function refresh() { reads.push(state.dataUrl); }
function setTimeout(fn) { fn(); }
const results = [
  followConsoleUrl('http://doasdr.local:8081'),
  followConsoleUrl('http://doasdr.local:8081/'),
  followConsoleUrl(undefined), followConsoleUrl(''), followConsoleUrl(8081),
  followConsoleUrl('http://192.168.100.100:8081/'),
  followConsoleUrl('http://192.168.100.100:8081'),
];
process.stdout.write(JSON.stringify({ results, reads, state, fields }));
"""
    result = subprocess.run([node, "-e", script], capture_output=True, text=True, timeout=20, check=True)
    out = json.loads(result.stdout)
    # Only another URL switches the page, once, with one read of the new URL.
    assert out["results"] == [False, False, False, False, False, True, False], out
    assert out["reads"] == ["http://192.168.100.100:8081"], out
    assert out["state"] == {"dataUrl": "http://192.168.100.100:8081", "collectionId": None}, out
    assert out["fields"]["data-url"]["value"] == "http://192.168.100.100:8081", out
    assert out["fields"]["source-url"]["textContent"] == "http://192.168.100.100:8081", out


def test_legacy_ui_reads_cleared_mqtt_entries_and_new_gate_reasons() -> None:
    """A retained clear (valid:false, cleared:true) is CLEARED, not INVALID, on the legacy page."""
    html = ground_console.HTML
    assert "function mqttContract(entry) { return entry.cleared===true?'CLEARED':(entry.valid===true?'VALID':'INVALID'); }" in html
    assert "['Retained clears',esc(cleared)]" in html
    assert "cleared=mqttCount(data?.cleared)" in html
    for reason in ("NODE_CLOCK_STALLED", "ADC_OVERDRIVE", "NATIVE_ANGLE_INVALID", "NATIVE_ANGLE_UNCHECKED"):
        assert f"  {reason}:'" in html, reason
    assert "adjacent frames, angles not cross-checked" in html


def test_legacy_polar_orientation_matches_the_react_renderer() -> None:
    """Legacy Polar runs counter-clockwise; Linear keeps compass_offset on a Compass axis."""
    node = shutil.which("node")
    if node is None:
        print("SKIP test_legacy_polar_orientation_matches_the_react_renderer: node not found")
        return
    html = ground_console.HTML
    sources = []
    for name in ("polarSettings", "normalizeDegrees", "polarDisplayAngle", "polarScreenAngle"):
        start = html.index(f"function {name}(")
        sources.append(html[start:html.index("\n", start)])
    script = "\n".join(sources) + r"""
const cases = [['Polar', 30], ['polar', 0], ['Compass', 30], ['Linear', 30], ['', 0], [undefined, 'x'], ['Compass', true]];
const out = cases.map(([type, offset]) => {
  const settings = polarSettings(type, offset);
  return { settings, screen: polarScreenAngle(60, settings), display: polarDisplayAngle(60, settings) };
});
process.stdout.write(JSON.stringify(out));
"""
    result = subprocess.run([node, "-e", script], capture_output=True, text=True, timeout=20, check=True)
    polar, polar_lower, compass, linear, empty, junk, boolean = json.loads(result.stdout)
    # React screenAngleForBin/displayAngleForBin for theta_0 bin 60.
    assert polar == {"settings": {"figType": "Polar", "compassOffset": 30, "localAxis": False}, "screen": 300, "display": 60}
    assert polar_lower["settings"]["figType"] == "Polar" and polar_lower["screen"] == 300
    assert compass == {"settings": {"figType": "Compass", "compassOffset": 30, "localAxis": False}, "screen": 330, "display": 330}
    assert linear == {"settings": {"figType": "Compass", "compassOffset": 30, "localAxis": True}, "screen": 330, "display": 330}
    assert empty["settings"] == {"figType": "Compass", "compassOffset": 0, "localAxis": True} and empty["screen"] == 300
    assert junk["settings"]["compassOffset"] == 0 and boolean["settings"]["compassOffset"] == 0
    assert "const point=(value,index)=>{ const radians=toRadians(polarScreenAngle(index,settings))" in html
    assert "ctx.lineTo(Math.cos(toRadians(peakScreen))*(maxR+12)" in html
    assert "const axisLabels=compass?directions:[['0°',0],['90°',90],['180°',180],['270°',270]]" in html
    assert "'Data Out offset · local Compass axis'" in html


def _png(width: int, height: int, bit_depth: int, color_type: int, interlace: int = 0, palette: bytes = b"") -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    bits = channels * bit_depth
    raw = b""
    for pass_width, pass_height in ground_console._png_pass_sizes(width, height, interlace == 1):
        if pass_width and pass_height:
            raw += (b"\x00" + b"\x01" * ((pass_width * bits + 7) // 8)) * pass_height
    ihdr = struct.pack(">IIBBBBB", width, height, bit_depth, color_type, 0, 0, interlace)
    body = chunk(b"IHDR", ihdr)
    if palette:
        body += chunk(b"PLTE", palette)
    body += chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    return b"\x89PNG\r\n\x1a\n" + body


def test_logo_validator_accepts_standard_png_variants() -> None:
    """AUD-80: palette, 16-bit and interlaced PNGs are valid logos."""
    accepted = {
        "palette": _png(5, 3, 8, 3, palette=bytes(range(6))),
        "palette-2bit": _png(9, 2, 2, 3, palette=bytes(12)),
        "rgba16": _png(4, 4, 16, 6),
        "gray1": _png(9, 1, 1, 0),
        "interlaced-rgb": _png(9, 7, 8, 2, interlace=1),
        "interlaced-palette": _png(3, 3, 4, 3, interlace=1, palette=bytes(9)),
    }
    for name, png in accepted.items():
        data_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
        try:
            ground_console._normalize_logo_data_url(data_url)
        except ValueError as exc:
            raise AssertionError(f"{name} rejected: {exc}") from exc
    rejected = {
        "palette-missing": _png(2, 2, 8, 3),
        "palette-too-large": _png(2, 2, 1, 3, palette=bytes(9)),
        "gray-with-palette": _png(2, 2, 8, 0, palette=bytes(3)),
        "rgb-4bit": _png(2, 2, 4, 2),
    }
    for name, png in rejected.items():
        data_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
        try:
            ground_console._normalize_logo_data_url(data_url)
        except ValueError:
            continue
        raise AssertionError(f"{name} accepted")


if __name__ == "__main__":
    tests = [value for name, value in globals().items() if name.startswith("test_")]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)} stage-3 tests passed")
