#!/usr/bin/env python3
"""HTTP contract of the admin-gated config-patch publish.

Covers POST /api/mqtt/config-patch, the command status routes, GET
/api/mqtt/config-reported, the capabilities flags, the admin password default
and the login throttle. Every server runs on loopback with temporary state and
a fake monitor, so no broker or Raspberry is contacted. One test drives the
real MqttMonitor through the fake paho client of test_sdr_doa_mqtt_monitor.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Tuple
from unittest.mock import patch

TOOLS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = TOOLS_DIR.parent
for _path in (str(TOOLS_DIR), str(PROJECT_ROOT)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

# ground_console resolves its admin password at import time; give it a
# test-only value so the import never reads a local .env file.
_SAVED_ADMIN_PASSWORD = os.environ.get("SDR_DOA_ADMIN_PASSWORD")
os.environ["SDR_DOA_ADMIN_PASSWORD"] = "config-patch-import-no-secret"
try:
    import ground_console  # noqa: E402
finally:
    if _SAVED_ADMIN_PASSWORD is None:
        os.environ.pop("SDR_DOA_ADMIN_PASSWORD", None)
    else:
        os.environ["SDR_DOA_ADMIN_PASSWORD"] = _SAVED_ADMIN_PASSWORD

import sdr_doa_mqtt as contract  # noqa: E402
from config_command_tracker import MonitorPublishError  # noqa: E402

BASE_URL = "http://doasdr.local:8081"
PASSWORD = "config-patch-test-password"
GOOD_CHANGES = {"center_frequency_hz": 433_920_000, "vfo_frequency_hz": 433_920_000}
COMMAND_ID_RE = re.compile(r"gc-[0-9a-f]{24}")


class FakeMonitor:
    """Monitor stand-in with the config-patch surface the server uses."""

    def __init__(self, host: str = "127.0.0.1", port: int = 1883, transport: str = "tcp", ws_path: str = "/mqtt") -> None:
        self.host = host
        self.port = port
        self.transport = transport
        self.ws_path = ws_path
        self.connection = "connected"
        self.base_config_rev: Optional[int] = 42
        self.base_source: Optional[str] = "config_reported"
        self.published: list[Dict[str, Any]] = []
        self.publish_error: Optional[BaseException] = None
        self.observations: Dict[str, Dict[str, Any]] = {}

    def start(self) -> None:
        return None

    def stop(self) -> None:
        return None

    def snapshot(self) -> Dict[str, Any]:
        return {"enabled": True, "read_only": True, "publish_enabled": False, "connection": self.connection}

    def rdf_node_snapshot(self) -> Dict[str, Any]:
        return {"enabled": True, "connection": "ready"}

    def publish_config_patch(self, command: Mapping[str, Any]) -> Dict[str, Any]:
        if self.publish_error is not None:
            raise self.publish_error
        self.published.append(json.loads(contract.compact_json(command)))
        return {
            "mid": len(self.published),
            "rc": 0,
            "published_at_ms": int(time.time() * 1000),
            "topic": contract.TOPICS["config_patch"],
        }

    def reported_config(self) -> Dict[str, Any]:
        return {
            "available": True,
            "connection": self.connection,
            "now_ms": int(time.time() * 1000),
            "base_config_rev": self.base_config_rev,
            "base_config_rev_source": self.base_source if self.base_config_rev is not None else None,
            "reported": {
                "config_rev": self.base_config_rev,
                "received_at_ms": 1,
                "age_ms": 1200,
                "retained": True,
                "synthetic": False,
                "source": "v1",
            },
            "values": {
                "center_frequency_hz": 416_588_000,
                "gain_db": 15.5,
                "vfo_frequency_hz": None,
                "vfo_bandwidth_hz": None,
                "vfo_squelch_db": None,
            },
            "value_sources": {
                "center_frequency_hz": "v1_config_reported",
                "gain_db": "v1_config_reported",
                "vfo_frequency_hz": None,
                "vfo_bandwidth_hz": None,
                "vfo_squelch_db": None,
            },
        }

    def config_command_observation(self, command_id: str) -> Dict[str, Any]:
        published = any(item["id"] == command_id for item in self.published)
        observed = {"published": published, "puback": None, "echoed_at_ms": None, "ack": None}
        observed.update(self.observations.get(command_id, {}))
        return observed

    def puback(self, command_id: str, reason: int = 0) -> None:
        self.observations.setdefault(command_id, {})["puback"] = {"received_at_ms": 1, "reason": reason}

    def ack(
        self,
        command_id: str,
        status: str,
        *,
        config_rev: int,
        error_code: Optional[str] = None,
        current_config_rev: Optional[int] = None,
    ) -> None:
        self.observations.setdefault(command_id, {})["ack"] = {
            "status": status,
            "config_rev": config_rev,
            "readback_ok": status == "applied",
            "error_code": error_code,
            "current_config_rev": current_config_rev,
            "changed_fields": ["center_frequency_hz"] if status == "applied" else [],
            "received_at_ms": 2,
            "retained": False,
        }


class ConfigPatchServerTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-config-patch-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        password = patch.object(ground_console, "ADMIN_PASSWORD", PASSWORD)
        password.start()
        self.addCleanup(password.stop)
        quiet = patch.object(ground_console.ConsoleHandler, "log_message", lambda *_args: None)
        quiet.start()
        self.addCleanup(quiet.stop)
        self.monitor = FakeMonitor()
        self.server = self._start_server(self.monitor)

    def _start_server(self, monitor: Any) -> Any:
        server = ground_console.GroundConsoleServer(
            ("127.0.0.1", 0),
            BASE_URL,
            mqtt_monitor=monitor,
            config_path=str(self.root / "console.json"),
            branding_path=str(self.root / "branding.json"),
            receiver_data_dir=self.root / "receiver",
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def close() -> None:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()

        self.addCleanup(close)
        return server

    # -- HTTP helpers --------------------------------------------------------

    def origin(self, server: Any = None) -> str:
        return f"http://127.0.0.1:{(server or self.server).server_address[1]}"

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        raw: Optional[bytes] = None,
        origin: Any = True,
        cookie: Optional[str] = None,
        server: Any = None,
    ) -> Tuple[int, Dict[str, str], Any]:
        target = server or self.server
        connection = http.client.HTTPConnection("127.0.0.1", target.server_address[1], timeout=10)
        try:
            headers: Dict[str, str] = {}
            data = raw if raw is not None else (None if body is None else json.dumps(body).encode("utf-8"))
            if data is not None:
                headers["Content-Type"] = "application/json"
            if origin is True:
                headers["Origin"] = self.origin(target)
            elif isinstance(origin, str):
                headers["Origin"] = origin
            if cookie:
                headers["Cookie"] = cookie
            connection.request(method, path, body=data, headers=headers)
            response = connection.getresponse()
            payload = response.read().decode("utf-8")
            return response.status, dict(response.getheaders()), json.loads(payload)
        finally:
            connection.close()

    def login(self, password: str = PASSWORD, server: Any = None) -> Tuple[int, Dict[str, str], Any]:
        return self.request("POST", "/api/admin/login", {"password": password}, server=server)

    def admin_cookie(self, server: Any = None) -> str:
        status, headers, _body = self.login(server=server)
        self.assertEqual(status, 200)
        match = re.match(r"(sdr_doa_admin=[^;]+);", headers.get("Set-Cookie", ""))
        self.assertIsNotNone(match)
        return match.group(1)

    def send_patch(
        self,
        body: Any,
        *,
        cookie: Optional[str] = None,
        origin: Any = True,
        server: Any = None,
    ) -> Tuple[int, Any]:
        status, _headers, payload = self.request(
            "POST", "/api/mqtt/config-patch", body, origin=origin, cookie=cookie, server=server,
        )
        return status, payload

    def patch_body(self, **overrides: Any) -> Dict[str, Any]:
        body: Dict[str, Any] = {"changes": dict(GOOD_CHANGES), "base_config_rev": 42, "confirm": True}
        body.update(overrides)
        return body

    def assert_error(self, result: Tuple[int, Any], status: int, code: str) -> Dict[str, Any]:
        actual_status, body = result
        self.assertEqual((actual_status, body.get("code")), (status, code), body)
        self.assertIs(body["ok"], False)
        self.assertIsInstance(body["error"], str)
        self.assertTrue(body["error"])
        return body

    # -- admin password ------------------------------------------------------

    def test_admin_password_default_applies_only_when_the_key_is_absent(self) -> None:
        resolve = ground_console._admin_password_from_sources
        self.assertEqual(ground_console.DEFAULT_ADMIN_PASSWORD, "123456")
        self.assertEqual(resolve({}, {}), "123456")
        self.assertIsNone(resolve({"SDR_DOA_ADMIN_PASSWORD": ""}, {}))
        self.assertIsNone(resolve({}, {"SDR_DOA_ADMIN_PASSWORD": ""}))
        self.assertEqual(resolve({"SDR_DOA_ADMIN_PASSWORD": "env"}, {"SDR_DOA_ADMIN_PASSWORD": "dotenv"}), "env")
        self.assertEqual(resolve({}, {"SDR_DOA_ADMIN_PASSWORD": "dotenv"}), "dotenv")
        # An empty environment value wins over a dotenv value too.
        self.assertIsNone(resolve({"SDR_DOA_ADMIN_PASSWORD": ""}, {"SDR_DOA_ADMIN_PASSWORD": "dotenv"}))

    def test_unreadable_dotenv_disables_login_instead_of_using_the_default(self) -> None:
        resolve = ground_console._admin_password_from_sources
        missing = self.root / "missing.env"
        self.assertEqual(resolve({}, dotenv_path=missing), "123456")
        other_keys = self.root / "other.env"
        other_keys.write_text("UNRELATED=1\n", encoding="utf-8")
        self.assertEqual(resolve({}, dotenv_path=other_keys), "123456")
        configured = self.root / "configured.env"
        configured.write_text("SDR_DOA_ADMIN_PASSWORD='from-file'\n", encoding="utf-8")
        self.assertEqual(resolve({}, dotenv_path=configured), "from-file")
        # A UTF-8 BOM (PowerShell 5.1 Set-Content -Encoding UTF8) before the
        # first key must not hide it and turn on the public default.
        for name, raw in (
            ("bom.env", b"\xef\xbb\xbfSDR_DOA_ADMIN_PASSWORD=my-real-secret\r\n"),
            ("bom-export.env", b"\xef\xbb\xbfexport SDR_DOA_ADMIN_PASSWORD='my-real-secret'\nOTHER=1\n"),
        ):
            bom = self.root / name
            bom.write_bytes(raw)
            self.assertEqual(ground_console._read_dotenv(bom)["SDR_DOA_ADMIN_PASSWORD"], "my-real-secret", name)
            self.assertEqual(resolve({}, dotenv_path=bom), "my-real-secret", name)
        # A .env that exists but cannot be read may hold the real password.
        directory = self.root / "directory.env"
        directory.mkdir()
        undecodable = self.root / "undecodable.env"
        undecodable.write_bytes(b"SDR_DOA_ADMIN_PASSWORD=\xff\xfe\n")
        # PowerShell 5.1 `>` writes UTF-16 LE with its own BOM.
        utf16 = self.root / "utf16.env"
        utf16.write_bytes("SDR_DOA_ADMIN_PASSWORD=my-real-secret\r\n".encode("utf-16"))
        with patch("builtins.print"):
            self.assertIsNone(resolve({}, dotenv_path=directory))
            self.assertIsNone(resolve({}, dotenv_path=undecodable))
            self.assertIsNone(resolve({}, dotenv_path=utf16))
        # The process environment still wins over an unreadable file.
        self.assertEqual(resolve({"SDR_DOA_ADMIN_PASSWORD": "env"}, dotenv_path=directory), "env")

    def test_default_password_unlocks_admin_and_is_flagged(self) -> None:
        with patch.object(ground_console, "ADMIN_PASSWORD", ground_console.DEFAULT_ADMIN_PASSWORD):
            _status, _headers, capabilities = self.request("GET", "/api/capabilities")
            self.assertIs(capabilities["admin_default_password"], True)
            self.assertNotIn("123456", json.dumps(capabilities))
            status, _headers, body = self.login("123456")
            self.assertEqual((status, body["authenticated"]), (200, True))

    # -- capabilities --------------------------------------------------------

    def test_capabilities_report_the_config_patch_path(self) -> None:
        status, _headers, capabilities = self.request("GET", "/api/capabilities")
        self.assertEqual(status, 200)
        self.assertEqual(
            {key: capabilities[key] for key in ("read_only", "mqtt_publish", "remote_post", "config_apply")},
            {"read_only": False, "mqtt_publish": True, "remote_post": False, "config_apply": False},
        )
        self.assertIs(capabilities["admin_enabled"], True)
        self.assertIs(capabilities["admin_default_password"], False)
        config_patch = capabilities["config_patch"]
        self.assertEqual(
            config_patch,
            {
                "enabled": True,
                "requires_admin": True,
                "topic": "sdr/v1/uav-01/cmd/config/patch",
                "qos": 1,
                "ttl_ms": 60_000,
                "ranges": {
                    "center_frequency_hz": [24_000_000, 1_800_000_000],
                    "gain_db": [-100, 60],
                    "vfo_frequency_hz": [24_000_000, 1_800_000_000],
                    "vfo_bandwidth_hz": [100, 2_400_000],
                    "vfo_squelch_db": [-200, 20],
                },
            },
        )
        for field, (low, high) in contract.CONFIG_RANGES.items():
            self.assertEqual(config_patch["ranges"][field], [low, high])

        unavailable = ground_console._UnavailableMqttMonitor("127.0.0.1", 1883, "tcp", "/mqtt", "missing")
        self.server.mqtt_monitor = unavailable
        _status, _headers, capabilities = self.request("GET", "/api/capabilities")
        self.assertIs(capabilities["config_patch"]["enabled"], False)
        self.server.mqtt_monitor = None
        _status, _headers, capabilities = self.request("GET", "/api/capabilities")
        self.assertIs(capabilities["config_patch"]["enabled"], False)
        self.assertIs(capabilities["mqtt_monitor"], False)

    # -- POST checks, in contract order --------------------------------------

    def test_origin_is_checked_before_admin(self) -> None:
        cookie = self.admin_cookie()
        port = self.server.server_address[1]
        for origin in (
            None,
            "https://attacker.invalid",
            f"http://192.168.1.5:{port}",
            f"http://127.0.0.1:{port + 1}",
            f"https://127.0.0.1:{port}",
            "null",
        ):
            self.assert_error(self.send_patch(self.patch_body(), cookie=cookie, origin=origin), 403, "ORIGIN_REJECTED")
        self.assert_error(self.send_patch(self.patch_body(), origin=None), 403, "ORIGIN_REJECTED")
        self.assert_error(self.send_patch(self.patch_body()), 401, "ADMIN_REQUIRED")
        self.assert_error(self.send_patch(self.patch_body(), cookie="sdr_doa_admin=forged"), 401, "ADMIN_REQUIRED")
        self.assertEqual(self.monitor.published, [])

    def test_request_shape_confirm_and_value_checks(self) -> None:
        cookie = self.admin_cookie()
        cases = [
            (["not", "an", "object"], "INVALID_REQUEST"),
            ({"changes": GOOD_CHANGES, "confirm": True}, "INVALID_REQUEST"),
            (self.patch_body(extra=1), "INVALID_REQUEST"),
            (self.patch_body(changes=[1, 2]), "INVALID_REQUEST"),
            (self.patch_body(base_config_rev="42"), "INVALID_REQUEST"),
            (self.patch_body(base_config_rev=True), "INVALID_REQUEST"),
            (self.patch_body(base_config_rev=-1), "INVALID_REQUEST"),
            (self.patch_body(confirm=False), "CONFIRM_REQUIRED"),
            (self.patch_body(confirm="true"), "CONFIRM_REQUIRED"),
            ({"changes": GOOD_CHANGES, "base_config_rev": 42}, "CONFIRM_REQUIRED"),
            (self.patch_body(changes={}), "EMPTY_CHANGES"),
            (self.patch_body(changes={"center_frequency_hz": 433_920_000, "en_remote_control": 1}), "FIELD_NOT_ALLOWED"),
            (self.patch_body(changes={"center_frequency_hz": 23_999_999}), "VALUE_OUT_OF_RANGE"),
            (self.patch_body(changes={"gain_db": 60.5}), "VALUE_OUT_OF_RANGE"),
            (self.patch_body(changes={"vfo_bandwidth_hz": "12500"}), "VALUE_OUT_OF_RANGE"),
            (self.patch_body(changes={"gain_db": True}), "VALUE_OUT_OF_RANGE"),
            (self.patch_body(changes={"vfo_squelch_db": None}), "VALUE_OUT_OF_RANGE"),
        ]
        for body, code in cases:
            with self.subTest(body=body):
                self.assert_error(self.send_patch(body, cookie=cookie), 400, code)
        # Python's JSON parser accepts NaN and Infinity; the range check refuses them.
        for literal in (b"NaN", b"Infinity", b"-Infinity", b"1e400"):
            raw = b'{"changes": {"gain_db": ' + literal + b'}, "base_config_rev": 42, "confirm": true}'
            status, _headers, body = self.request("POST", "/api/mqtt/config-patch", raw=raw, cookie=cookie)
            self.assertEqual((status, body["code"]), (400, "VALUE_OUT_OF_RANGE"), literal)
        rejected = self.assert_error(
            self.send_patch(self.patch_body(changes={"secret": 1, "center_frequency_hz": 433_920_000}), cookie=cookie),
            400,
            "FIELD_NOT_ALLOWED",
        )
        self.assertEqual(rejected["fields"], ["secret"])
        # Malformed and oversized bodies.
        status, _headers, body = self.request("POST", "/api/mqtt/config-patch", raw=b"{not json", cookie=cookie)
        self.assertEqual((status, body["code"]), (400, "INVALID_REQUEST"))
        oversized = json.dumps(self.patch_body(padding="x" * 5000)).encode("utf-8")
        status, _headers, body = self.request("POST", "/api/mqtt/config-patch", raw=oversized, cookie=cookie)
        self.assertEqual((status, body["code"]), (400, "INVALID_REQUEST"))
        self.assertEqual(self.monitor.published, [])

    def test_monitor_state_checks(self) -> None:
        cookie = self.admin_cookie()
        self.server.mqtt_monitor = None
        self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "MQTT_MONITOR_DISABLED")
        self.server.mqtt_monitor = ground_console._UnavailableMqttMonitor(
            "127.0.0.1", 1883, "tcp", "/mqtt", ground_console.MQTT_DEPENDENCY_ERROR,
        )
        self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 503, "MQTT_DEPENDENCY_MISSING")
        self.server.mqtt_monitor = self.monitor
        for connection in ("connecting", "disconnected", "error", "stopped"):
            self.monitor.connection = connection
            self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 503, "MQTT_NOT_CONNECTED")
        self.assertEqual(self.monitor.published, [])

    def test_base_revision_must_be_known_and_current(self) -> None:
        cookie = self.admin_cookie()
        self.monitor.base_config_rev = None
        self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "CONFIG_REVISION_UNKNOWN")
        self.monitor.base_config_rev = 43
        stale = self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "CONFIG_REVISION_STALE")
        self.assertEqual(stale["current_base_config_rev"], 43)
        stale = self.assert_error(
            self.send_patch(self.patch_body(base_config_rev=None), cookie=cookie), 409, "CONFIG_REVISION_STALE",
        )
        self.assertEqual(stale["current_base_config_rev"], 43)
        self.assertEqual(self.monitor.published, [])

    def test_accepted_patch_is_a_valid_contract_command(self) -> None:
        cookie = self.admin_cookie()
        status, body = self.send_patch(
            self.patch_body(changes={"center_frequency_hz": 433_920_000.0, "gain_db": 24.12345}), cookie=cookie,
        )
        self.assertEqual(status, 202, body)
        self.assertIs(body["ok"], True)
        self.assertRegex(body["command_id"], COMMAND_ID_RE)
        self.assertEqual(body["state"], "published")
        self.assertEqual((body["topic"], body["qos"], body["ttl_ms"]), ("sdr/v1/uav-01/cmd/config/patch", 1, 60_000))
        self.assertEqual(body["base_config_rev"], 42)
        self.assertEqual(body["expires_ts_ms"] - body["issued_ts_ms"], 60_000)
        self.assertEqual(body["changes"], {"center_frequency_hz": 433_920_000, "gain_db": 24.123})
        [published] = self.monitor.published
        self.assertEqual(published["id"], body["command_id"])
        self.assertEqual(published["base_config_rev"], 42)
        self.assertEqual(published["changes"], body["changes"])
        contract.validate_config_patch(published, now_ms=published["issued_ts_ms"])
        self.assertEqual(published["expires_ts_ms"] - published["issued_ts_ms"], 60_000)

    def test_one_command_in_flight_at_a_time(self) -> None:
        cookie = self.admin_cookie()
        status, first = self.send_patch(self.patch_body(), cookie=cookie)
        self.assertEqual(status, 202)
        busy = self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "COMMAND_IN_FLIGHT")
        self.assertEqual(busy["command_id"], first["command_id"])
        _status, _headers, reported = self.request("GET", "/api/mqtt/config-reported")
        self.assertEqual(reported["pending_command_id"], first["command_id"])

        self.monitor.ack(first["command_id"], "applied", config_rev=43)
        self.monitor.base_config_rev, self.monitor.base_source = 43, "ack"
        status, second = self.send_patch(self.patch_body(base_config_rev=43), cookie=cookie)
        self.assertEqual(status, 202, second)
        self.assertNotEqual(second["command_id"], first["command_id"])
        self.assertEqual(len(self.monitor.published), 2)

    def test_concurrent_sends_publish_only_once(self) -> None:
        cookie = self.admin_cookie()
        results: list[int] = []
        lock = threading.Lock()

        def send() -> None:
            status, _body = self.send_patch(self.patch_body(), cookie=cookie)
            with lock:
                results.append(status)

        threads = [threading.Thread(target=send) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        self.assertEqual(sorted(results), [202] + [409] * 5)
        self.assertEqual(len(self.monitor.published), 1)

    # -- command status --------------------------------------------------------

    def status_of(self, command_id: str) -> Dict[str, Any]:
        status, _headers, body = self.request("GET", f"/api/mqtt/config-patch/{command_id}", origin=None)
        self.assertEqual(status, 200, body)
        return body

    def test_status_follows_puback_and_ack(self) -> None:
        cookie = self.admin_cookie()
        _status, sent = self.send_patch(self.patch_body(), cookie=cookie)
        command_id = sent["command_id"]
        first = self.status_of(command_id)
        self.assertEqual((first["state"], first["final"]), ("published", False))
        self.assertEqual(first["changes"], sent["changes"])
        self.assertEqual(first["base_config_rev"], 42)
        self.assertEqual((first["issued_ts_ms"], first["expires_ts_ms"]), (sent["issued_ts_ms"], sent["expires_ts_ms"]))
        self.assertIsNone(first["puback_reason"])
        self.assertIs(first["echoed"], False)
        self.assertIs(first["monitor_restarted"], False)
        self.assertIsNone(first["ack"])

        self.monitor.puback(command_id, 0)
        self.monitor.observations[command_id]["echoed_at_ms"] = 5
        delivered = self.status_of(command_id)
        self.assertEqual((delivered["state"], delivered["puback_reason"], delivered["echoed"]), ("delivered", 0, True))

        self.monitor.ack(command_id, "received", config_rev=42)
        self.assertEqual(self.status_of(command_id)["state"], "acknowledged")
        self.monitor.ack(command_id, "applied", config_rev=43)
        acked = self.status_of(command_id)
        self.assertEqual((acked["state"], acked["final"]), ("acked", True))
        self.assertEqual(
            acked["ack"],
            {
                "status": "applied",
                "config_rev": 43,
                "readback_ok": True,
                "error_code": None,
                "current_config_rev": None,
                "changed_fields": ["center_frequency_hz"],
                "received_at_ms": 2,
            },
        )
        _status, _headers, latest = self.request("GET", "/api/mqtt/config-patch")
        self.assertEqual(latest["command"]["command_id"], command_id)
        self.assertEqual(latest["command"]["state"], "acked")

    def test_conflict_ack_carries_the_current_revision(self) -> None:
        cookie = self.admin_cookie()
        _status, sent = self.send_patch(self.patch_body(), cookie=cookie)
        self.monitor.ack(
            sent["command_id"], "conflict", config_rev=44,
            error_code="CONFIG_REVISION_CONFLICT", current_config_rev=44,
        )
        conflict = self.status_of(sent["command_id"])
        self.assertEqual((conflict["state"], conflict["final"]), ("acked", True))
        self.assertEqual(conflict["ack"]["status"], "conflict")
        self.assertEqual(conflict["ack"]["error_code"], "CONFIG_REVISION_CONFLICT")
        self.assertEqual(conflict["ack"]["current_config_rev"], 44)

    def test_no_ack_after_expiry_plus_grace(self) -> None:
        clock = [1_700_000_000_000]
        self.server.clock_ms = lambda: clock[0]
        cookie = self.admin_cookie()
        _status, sent = self.send_patch(self.patch_body(), cookie=cookie)
        self.assertEqual(sent["issued_ts_ms"], clock[0])
        command_id = sent["command_id"]
        clock[0] = sent["expires_ts_ms"]
        self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "COMMAND_IN_FLIGHT")
        clock[0] = sent["expires_ts_ms"] + 5_000
        self.assertEqual(self.status_of(command_id)["state"], "published")
        clock[0] = sent["expires_ts_ms"] + 5_001
        no_ack = self.status_of(command_id)
        self.assertEqual((no_ack["state"], no_ack["final"], no_ack["now_ms"]), ("no_ack", True, clock[0]))
        # A late final ACK is still reported; the state stays final.
        self.monitor.ack(command_id, "applied", config_rev=43)
        self.assertEqual(self.status_of(command_id)["state"], "acked")

    def test_expired_command_no_longer_blocks_a_new_one(self) -> None:
        clock = [1_700_000_000_000]
        self.server.clock_ms = lambda: clock[0]
        cookie = self.admin_cookie()
        _status, first = self.send_patch(self.patch_body(), cookie=cookie)
        clock[0] = first["expires_ts_ms"] + 1
        status, second = self.send_patch(self.patch_body(), cookie=cookie)
        self.assertEqual(status, 202, second)

    def test_publish_failures(self) -> None:
        cookie = self.admin_cookie()
        self.monitor.publish_error = MonitorPublishError("MQTT_NOT_CONNECTED", "connection closed")
        raced = self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 503, "MQTT_NOT_CONNECTED")
        self.assertEqual(self.status_of(raced["command_id"])["state"], "publish_failed")
        self.monitor.publish_error = RuntimeError("socket gone")
        failed = self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 502, "MQTT_PUBLISH_FAILED")
        failed_status = self.status_of(failed["command_id"])
        self.assertEqual((failed_status["state"], failed_status["final"]), ("publish_failed", True))
        # A refused publish is final, so it never blocks the next send.
        self.monitor.publish_error = None
        status, sent = self.send_patch(self.patch_body(), cookie=cookie)
        self.assertEqual(status, 202, sent)
        # A PUBACK failure (135, not authorized) is a publish failure too.
        self.monitor.puback(sent["command_id"], 135)
        rejected = self.status_of(sent["command_id"])
        self.assertEqual((rejected["state"], rejected["puback_reason"]), ("publish_failed", 135))

    def test_monitor_restart_keeps_tracking_the_command(self) -> None:
        cookie = self.admin_cookie()
        _status, sent = self.send_patch(self.patch_body(), cookie=cookie)
        command_id = sent["command_id"]
        self.monitor.puback(command_id, 0)
        replacement = FakeMonitor()
        self.server.mqtt_monitor = replacement
        restarted = self.status_of(command_id)
        self.assertIs(restarted["monitor_restarted"], True)
        self.assertEqual((restarted["state"], restarted["puback_reason"]), ("delivered", 0))
        replacement.ack(command_id, "applied", config_rev=43)
        acked = self.status_of(command_id)
        self.assertEqual((acked["state"], acked["monitor_restarted"]), ("acked", True))

    def test_status_routes_validate_the_id(self) -> None:
        _status, _headers, latest = self.request("GET", "/api/mqtt/config-patch")
        self.assertEqual(latest, {"command": None})
        for command_id in ("bad%20id", "x" * 65, "a.b"):
            status, _headers, body = self.request("GET", f"/api/mqtt/config-patch/{command_id}")
            self.assertEqual((status, body["code"]), (400, "INVALID_REQUEST"), command_id)
        status, _headers, body = self.request("GET", "/api/mqtt/config-patch/gc-unknown")
        self.assertEqual((status, body["code"], body["ok"]), (404, "COMMAND_UNKNOWN", False))

    # -- config-reported -----------------------------------------------------

    def test_config_reported_needs_no_admin_and_reports_why_it_is_empty(self) -> None:
        status, _headers, body = self.request("GET", "/api/mqtt/config-reported", origin=None)
        self.assertEqual(status, 200)
        self.assertIs(body["available"], True)
        self.assertIsNone(body["code"])
        self.assertEqual(body["broker"], {"host": "127.0.0.1", "port": 1883, "transport": "tcp", "connection": "connected"})
        self.assertEqual((body["base_config_rev"], body["base_config_rev_source"]), (42, "config_reported"))
        self.assertEqual(body["values"]["center_frequency_hz"], 416_588_000)
        self.assertEqual(body["value_sources"]["gain_db"], "v1_config_reported")
        self.assertIsNone(body["values"]["vfo_frequency_hz"])
        self.assertEqual(body["reported"]["source"], "v1")
        self.assertIsNone(body["pending_command_id"])
        self.assertIsInstance(body["now_ms"], int)

        self.server.mqtt_monitor = None
        _status, _headers, body = self.request("GET", "/api/mqtt/config-reported")
        self.assertEqual((body["available"], body["code"]), (False, "MQTT_MONITOR_DISABLED"))
        self.assertEqual(body["broker"]["connection"], "disabled")
        self.assertEqual(set(body["values"].values()), {None})
        self.assertIsNone(body["base_config_rev"])

        self.server.mqtt_monitor = ground_console._UnavailableMqttMonitor("127.0.0.1", 1883, "tcp", "/mqtt", "missing")
        _status, _headers, body = self.request("GET", "/api/mqtt/config-reported")
        self.assertEqual((body["available"], body["code"]), (False, "MQTT_DEPENDENCY_MISSING"))
        self.assertEqual(body["broker"]["connection"], "error")
        self.assertEqual(set(body["value_sources"].values()), {None})

    def test_dry_run_route_is_unchanged(self) -> None:
        status, _headers, body = self.request(
            "POST", "/api/dry-run/config-patch", {"base_config_rev": 3, "changes": {"gain_db": 24}}, origin=None,
        )
        self.assertEqual(status, 200)
        self.assertEqual((body["dry_run"], body["applied"], body["transport"]), (True, False, "none"))
        self.assertEqual(body["command"]["expires_ts_ms"] - body["command"]["issued_ts_ms"], 10_000)
        self.assertEqual(self.monitor.published, [])

    # -- login throttle --------------------------------------------------------

    def test_failed_logins_are_throttled(self) -> None:
        clock = [1_000.0]
        self.server.monotonic = lambda: clock[0]
        for _ in range(4):
            status, _headers, body = self.login("wrong")
            self.assertEqual((status, body["code"]), (401, "ADMIN_PASSWORD_INVALID"))
        # Failures older than the window do not count.
        clock[0] += 61
        for _ in range(4):
            status, _headers, body = self.login("wrong")
            self.assertEqual(status, 401)
        status, _headers, body = self.login("wrong")
        self.assertEqual(status, 401)
        status, headers, body = self.login()
        self.assertEqual((status, body["code"], body["ok"]), (429, "ADMIN_LOGIN_THROTTLED", False))
        self.assertEqual(headers.get("Retry-After"), "30")
        self.assertEqual(body["retry_after_s"], 30)
        clock[0] += 29
        status, headers, body = self.login()
        self.assertEqual((status, headers.get("Retry-After")), (429, "1"))
        clock[0] += 1.5
        status, _headers, body = self.login()
        self.assertEqual((status, body["authenticated"]), (200, True))

    def test_cross_origin_logins_never_reach_the_throttle(self) -> None:
        port = self.server.server_address[1]
        for origin in (None, "https://evil.example", f"http://127.0.0.1:{port + 1}", f"http://localhost:{port}"):
            for _ in range(ground_console.ADMIN_LOGIN_MAX_FAILURES + 1):
                status, headers, body = self.request("POST", "/api/admin/login", {"password": "x"}, origin=origin)
                self.assertEqual((status, body["code"], body["ok"]), (403, "ORIGIN_REJECTED", False), origin)
                self.assertNotIn("Set-Cookie", headers)
            # The right password from a foreign origin is refused too.
            status, headers, body = self.request("POST", "/api/admin/login", {"password": PASSWORD}, origin=origin)
            self.assertEqual((status, body["code"]), (403, "ORIGIN_REJECTED"), origin)
            self.assertNotIn("Set-Cookie", headers)
        status, _headers, body = self.login()
        self.assertEqual((status, body["authenticated"]), (200, True))

    def test_cross_origin_logout_keeps_the_session(self) -> None:
        cookie = self.admin_cookie()
        status, headers, body = self.request(
            "POST", "/api/admin/logout", {}, origin="https://evil.example", cookie=cookie,
        )
        self.assertEqual((status, body["code"]), (403, "ORIGIN_REJECTED"))
        self.assertNotIn("Set-Cookie", headers)
        _status, _headers, admin = self.request("GET", "/api/admin/status", origin=None, cookie=cookie)
        self.assertIs(admin["authenticated"], True)
        status, _headers, _body = self.request("POST", "/api/admin/logout", {}, cookie=cookie)
        self.assertEqual(status, 200)
        _status, _headers, admin = self.request("GET", "/api/admin/status", origin=None, cookie=cookie)
        self.assertIs(admin["authenticated"], False)

    def test_cross_origin_posts_cannot_retarget_the_publish_monitor(self) -> None:
        config_path = self.root / "console.json"
        saved = config_path.read_bytes() if config_path.exists() else None
        config = self.server.get_config()
        for path, body in (
            ("/api/console-config", {"mqtt_host": "203.0.113.9", "mqtt_port": 1883, "mqtt_transport": "tcp"}),
            ("/api/mqtt/connect?host=203.0.113.9&port=1883&transport=tcp", None),
        ):
            for origin in (None, "https://evil.example"):
                status, _headers, response = self.request("POST", path, body, origin=origin)
                self.assertEqual((status, response["code"], response["read_only"]), (403, "ORIGIN_REJECTED", True))
        self.assertIs(self.server.mqtt_monitor, self.monitor)
        self.assertEqual(self.server.get_config(), config)
        self.assertEqual(config_path.read_bytes() if config_path.exists() else None, saved)

    def test_non_ascii_password_is_a_wrong_password_not_a_dropped_connection(self) -> None:
        for raw in (
            json.dumps({"password": "kata-sandi-é"}).encode("utf-8"),
            b'{"password": "\\ud800"}',
        ):
            status, _headers, body = self.request("POST", "/api/admin/login", raw=raw)
            self.assertEqual((status, body["code"]), (401, "ADMIN_PASSWORD_INVALID"))
        with patch.object(ground_console, "ADMIN_PASSWORD", "sandi-ü-é"):
            status, _headers, body = self.login("sandi-ü-é")
            self.assertEqual(status, 200)


class RealMonitorEndToEndTests(unittest.TestCase):
    """The real MqttMonitor behind the HTTP routes, with a fake paho client."""

    def setUp(self) -> None:
        import test_sdr_doa_mqtt_monitor as monitor_tests

        self.monitor_tests = monitor_tests
        temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-config-patch-e2e-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        password = patch.object(ground_console, "ADMIN_PASSWORD", PASSWORD)
        password.start()
        self.addCleanup(password.stop)
        quiet = patch.object(ground_console.ConsoleHandler, "log_message", lambda *_args: None)
        quiet.start()
        self.addCleanup(quiet.stop)
        paho, client_class = monitor_tests.fake_paho()
        module = monitor_tests.load_monitor(paho)
        self.monitor = module.MqttMonitor("127.0.0.1", 1883, transport="tcp")
        self.monitor.start()
        self.addCleanup(self.monitor.stop)
        self.client = client_class.instances[-1]
        self.client.on_connect(self.client, None, {}, types.SimpleNamespace(value=0, is_failure=False), None)
        self.client.on_subscribe(
            self.client, None, self.client.mid, monitor_tests.successful_codes(len(self.client.subscriptions)), None,
        )
        self.client.publish_rc = 0
        self.server = ground_console.GroundConsoleServer(
            ("127.0.0.1", 0),
            BASE_URL,
            mqtt_monitor=self.monitor,
            config_path=str(root / "console.json"),
            branding_path=str(root / "branding.json"),
            receiver_data_dir=root / "receiver",
        )
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()

        def close() -> None:
            self.server.shutdown()
            thread.join(timeout=5)
            self.server.server_close()

        self.addCleanup(close)

    def deliver(self, kind: str, payload: Any, *, retained: bool = False) -> None:
        raw = payload if isinstance(payload, bytes) else contract.compact_json(payload).encode("utf-8")
        self.client.on_message(self.client, None, self.monitor_tests.message(contract.TOPICS[kind], raw, 1, retained))

    def request(self, method: str, path: str, body: Any = None, cookie: Optional[str] = None) -> Tuple[int, Dict[str, str], Any]:
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=10)
        try:
            headers = {"Origin": f"http://127.0.0.1:{self.server.server_address[1]}"}
            data = None
            if body is not None:
                data = json.dumps(body).encode("utf-8")
                headers["Content-Type"] = "application/json"
            if cookie:
                headers["Cookie"] = cookie
            connection.request(method, path, body=data, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()

    def test_publish_puback_echo_and_ack_round_trip(self) -> None:
        now = int(time.time() * 1000)
        self.deliver(
            "config_reported",
            contract.build_config_reported(
                ts_ms=now, config_rev=42, center_frequency_hz=416_588_000, gain_db=15.5,
                array="UCA", method="MUSIC", active_vfos=1,
            ),
            retained=True,
        )
        _status, _headers, reported = self.request("GET", "/api/mqtt/config-reported")
        self.assertIs(reported["available"], True)
        self.assertEqual(reported["broker"]["connection"], "connected")
        self.assertEqual((reported["base_config_rev"], reported["base_config_rev_source"]), (42, "config_reported"))
        self.assertEqual(reported["reported"]["config_rev"], 42)
        self.assertIs(reported["reported"]["retained"], True)

        status, headers, _body = self.request("POST", "/api/admin/login", {"password": PASSWORD})
        self.assertEqual(status, 200)
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        status, _headers, sent = self.request(
            "POST", "/api/mqtt/config-patch",
            {"changes": dict(GOOD_CHANGES), "base_config_rev": 42, "confirm": True},
            cookie=cookie,
        )
        self.assertEqual(status, 202, sent)
        [((topic, raw), options)] = self.client.publish_calls
        self.assertEqual(topic, "sdr/v1/uav-01/cmd/config/patch")
        self.assertEqual((options["qos"], options["retain"]), (1, False))
        self.assertEqual(options["properties"].MessageExpiryInterval, 60)
        command = json.loads(raw.decode("utf-8"))
        contract.validate_config_patch(command, now_ms=command["issued_ts_ms"])
        self.assertEqual(command["id"], sent["command_id"])
        self.assertEqual(command["expires_ts_ms"] - command["issued_ts_ms"], 60_000)
        path = f"/api/mqtt/config-patch/{sent['command_id']}"
        self.assertEqual(self.request("GET", path)[2]["state"], "published")

        self.deliver("config_patch", raw)
        self.client.on_publish(self.client, None, self.client.mid, types.SimpleNamespace(value=0), None)
        delivered = self.request("GET", path)[2]
        self.assertEqual((delivered["state"], delivered["echoed"], delivered["puback_reason"]), ("delivered", True, 0))

        def ack(status_name: str, rev: int) -> Dict[str, Any]:
            return contract.build_config_ack(
                command_id=command["id"], status=status_name, ts_ms=int(time.time() * 1000), config_rev=rev,
                readback_ok=status_name == "applied",
                changed_fields=list(command["changes"]) if status_name == "applied" else None,
            )

        self.deliver("ack_config", ack("received", 42))
        self.assertEqual(self.request("GET", path)[2]["state"], "acknowledged")
        self.deliver("ack_config", ack("applied", 43))
        acked = self.request("GET", path)[2]
        self.assertEqual((acked["state"], acked["final"]), ("acked", True))
        self.assertEqual((acked["ack"]["status"], acked["ack"]["config_rev"]), ("applied", 43))
        self.assertEqual(sorted(acked["ack"]["changed_fields"]), sorted(GOOD_CHANGES))
        reported = self.request("GET", "/api/mqtt/config-reported")[2]
        self.assertEqual((reported["base_config_rev"], reported["base_config_rev_source"]), (43, "ack"))
        self.assertIsNone(reported["pending_command_id"])
        # The Message Monitor still reports a monitor that never publishes on its own.
        snapshot = self.request("GET", "/api/mqtt")[2]
        self.assertEqual((snapshot["read_only"], snapshot["publish_enabled"]), (True, False))


if __name__ == "__main__":
    unittest.main()
