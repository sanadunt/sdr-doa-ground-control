#!/usr/bin/env python3
"""HTTP contract of Kontrol's RDF Node commands.

Covers POST /api/mqtt/config-patch and POST /api/mqtt/config-get (every check
in order), the command status routes, GET /api/mqtt/config-reported, the
dry-run preview, the capabilities flags, the admin password default and the
login throttle. Every server runs on loopback with temporary state and a fake
monitor, so no broker or Raspberry is contacted. The end-to-end tests drive
the real MqttMonitor through the fake paho client of test_sdr_doa_mqtt_monitor
with the edge's own payloads from tools/fixtures/rdf-node/commands.json.
"""

from __future__ import annotations

import gc
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
import weakref
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

import rdf_node_commands as cmds  # noqa: E402
from config_command_tracker import FINAL_ACK_WAIT_MS, NO_ACK_GRACE_MS, SETTINGS_REPORT_WAIT_MS, MonitorPublishError  # noqa: E402

BASE_URL = "http://doasdr.local:8081"
PASSWORD = "config-patch-test-password"
COMMANDS = json.loads((TOOLS_DIR / "fixtures" / "rdf-node" / "commands.json").read_text(encoding="utf-8"))
CASES = {case["name"]: case for case in COMMANDS["cases"]}
STATE = json.loads(COMMANDS["session"]["state"])
NODE = COMMANDS["node_id"]
GOOD_CHANGES = {"center_frequency_hz": 433_920_000, "vfo0_frequency_hz": 433_920_000}
COMMAND_ID_RE = re.compile(r"gc-[0-9a-f]{24}")
PATCH_TOPIC = f"sdr/v2/{NODE}/cmd/config/patch"
GET_TOPIC = f"sdr/v2/{NODE}/cmd/config/get"
SETTINGS = json.loads(json.loads(CASES["config-get"]["edge"]["settings_reported"])["settings_json"])


def _now_ms() -> int:
    return int(time.time() * 1000)


class FakeMonitor:
    """Monitor stand-in with the Kontrol surface the server uses."""

    def __init__(self, host: str = "127.0.0.1", port: int = 1883, transport: str = "tcp", ws_path: str = "/mqtt") -> None:
        self.host = host
        self.port = port
        self.transport = transport
        self.ws_path = ws_path
        self.node_id = NODE
        self.connection = "connected"
        self.session: Dict[str, Any] = {
            "known": True,
            "sid": STATE["sid"],
            "boot": STATE["boot"],
            "instance": STATE["instance"],
            "cfg": 42,
            "state_received_at_ms": 1,
            "health_fresh": True,
            "health_daq": 1,
            "health_q": 7,
            "health_t": _now_ms(),
            "health_received_at_ms": _now_ms() - 400,
            "capabilities": {"remote_commands": True, "remote_config_patch": True, "config_patch": False},
        }
        self.settings: Optional[Dict[str, Any]] = None
        self.published: list[Dict[str, Any]] = []
        self.publish_error: Optional[BaseException] = None
        self.observations: Dict[str, Dict[str, Any]] = {}
        self.adopted: list[Dict[str, Any]] = []

    def start(self) -> None:
        return None

    def stop(self) -> None:
        return None

    def snapshot(self) -> Dict[str, Any]:
        return {"enabled": True, "read_only": True, "publish_enabled": False, "connection": self.connection}

    def rdf_node_snapshot(self) -> Dict[str, Any]:
        return {"enabled": True, "connection": "ready"}

    def rdf_node_control_view(self) -> Dict[str, Any]:
        return {
            "available": True,
            "connection": self.connection,
            "node_id": self.node_id,
            "now_ms": _now_ms(),
            "session": dict(self.session),
            "settings": None if self.settings is None else dict(self.settings),
        }

    def publish_rdf_node_command(self, command: Mapping[str, Any]) -> Dict[str, Any]:
        if self.publish_error is not None:
            raise self.publish_error
        cmds.validate_command(command)
        self.published.append(json.loads(cmds.encode_command(command)))
        return {
            "mid": len(self.published),
            "rc": 0,
            "published_at_ms": _now_ms(),
            "topic": cmds.command_topic(self.node_id, command["op"]),
        }

    def adopt_rdf_node_commands(self, pending: Any) -> int:
        known = {item["id"] for item in self.published} | {item["command_id"] for item in self.adopted}
        fresh = [dict(item) for item in pending if item["command_id"] not in known]
        self.adopted.extend(fresh)
        return len(fresh)

    def rdf_node_command_observation(self, command_id: str) -> Dict[str, Any]:
        # As the real monitor: only ids this monitor published or adopted.
        published = any(item["id"] == command_id for item in self.published)
        adopted = any(item["command_id"] == command_id for item in self.adopted)
        observed = {"published": published, "adopted": adopted, "puback": None, "progress": None, "final": None,
                    "reported_at_ms": None}
        if published or adopted:
            observed.update(self.observations.get(command_id, {}))
        return observed

    def puback(self, command_id: str, reason: int = 0) -> None:
        self.observations.setdefault(command_id, {})["puback"] = {"received_at_ms": 1, "reason": reason}

    def ack(self, command_id: str, status: str, *, rev: int = 43, result: Optional[Dict[str, Any]] = None) -> None:
        ack = {"status": status, "t": _now_ms(), "rev": rev, "result": dict(result or {}), "received_at_ms": 2}
        slot = "final" if status in {
            "APPLIED", "FAILED", "REJECTED", "EXPIRED", "CONFLICT", "PERSISTED_UNVERIFIED", "OUTCOME_UNKNOWN", "CANCELLED",
        } else "progress"
        self.observations.setdefault(command_id, {})[slot] = ack

    def report(self, command_id: str, *, rev: int = 42, matches: bool = True, received_at_ms: int = 3) -> None:
        self.observations.setdefault(command_id, {})["reported_at_ms"] = received_at_ms
        self.settings = {
            "id": command_id, "sid": STATE["sid"], "boot": STATE["boot"], "rev": rev, "t": _now_ms(),
            "received_at_ms": received_at_ms, "settings_json": json.dumps(SETTINGS), "settings": SETTINGS,
            "state_cfg": 42, "matches_state_cfg": matches,
            "safe_settings": {
                "center_frequency_hz": 433_920_000, "gain_db": 15.7, "vfo0_frequency_hz": 433_920_000,
                "vfo0_bandwidth_hz": 12_500, "vfo0_squelch_db": -80, "ant_arrangement": "UCA",
            } if matches else {},
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

    def send_get(self, body: Any = None, *, cookie: Optional[str] = None, origin: Any = True) -> Tuple[int, Any]:
        status, _headers, payload = self.request(
            "POST", "/api/mqtt/config-get", {} if body is None else body, origin=origin, cookie=cookie,
        )
        return status, payload

    def patch_body(self, **overrides: Any) -> Dict[str, Any]:
        body: Dict[str, Any] = {"changes": dict(GOOD_CHANGES), "base_rev": 42, "confirm": True}
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

    def test_capabilities_report_the_command_path(self) -> None:
        status, _headers, capabilities = self.request("GET", "/api/capabilities")
        self.assertEqual(status, 200)
        self.assertEqual(
            {key: capabilities[key] for key in ("read_only", "mqtt_publish", "remote_post", "config_apply")},
            {"read_only": False, "mqtt_publish": True, "remote_post": False, "config_apply": False},
        )
        self.assertIs(capabilities["admin_enabled"], True)
        self.assertIs(capabilities["admin_default_password"], False)
        self.assertEqual(
            capabilities["config_allowlist"],
            ["center_frequency_hz", "gain_db", "vfo0_frequency_hz", "vfo0_bandwidth_hz", "vfo0_squelch_db"],
        )
        self.assertEqual(
            capabilities["config_patch"],
            {
                "enabled": True,
                "requires_admin": True,
                "topic": PATCH_TOPIC,
                "get_topic": GET_TOPIC,
                "ack_topic": f"sdr/v2/{NODE}/ack/config",
                "settings_topic": f"sdr/v2/{NODE}/settings/reported",
                "qos": 1,
                "ttl_ms": 15_000,
                "ranges": {
                    "center_frequency_hz": [24_000_000, 1_766_000_000],
                    "gain_db": [-10, 100],
                    "vfo0_frequency_hz": [24_000_000, 1_766_000_000],
                    "vfo0_bandwidth_hz": [100, 2_400_000],
                    "vfo0_squelch_db": [-200, 50],
                },
                "gain_table_db": list(cmds.GAIN_TABLE_DB),
                "requires_fresh_health": True,
            },
        )

        unavailable = ground_console._UnavailableMqttMonitor("127.0.0.1", 1883, "tcp", "/mqtt", "missing")
        self.server.mqtt_monitor = unavailable
        _status, _headers, capabilities = self.request("GET", "/api/capabilities")
        self.assertIs(capabilities["config_patch"]["enabled"], False)
        self.server.mqtt_monitor = None
        _status, _headers, capabilities = self.request("GET", "/api/capabilities")
        self.assertIs(capabilities["config_patch"]["enabled"], False)
        self.assertEqual(capabilities["config_patch"]["topic"], PATCH_TOPIC)
        self.assertIs(capabilities["mqtt_monitor"], False)

    # -- POST checks, in contract order --------------------------------------

    def test_origin_is_checked_before_admin(self) -> None:
        cookie = self.admin_cookie()
        port = self.server.server_address[1]
        for path, body in (("/api/mqtt/config-patch", self.patch_body()), ("/api/mqtt/config-get", {})):
            for origin in (
                None,
                "https://attacker.invalid",
                f"http://192.168.1.5:{port}",
                f"http://127.0.0.1:{port + 1}",
                f"https://127.0.0.1:{port}",
                "null",
            ):
                with self.subTest(path=path, origin=origin):
                    status, _headers, response = self.request("POST", path, body, origin=origin, cookie=cookie)
                    self.assert_error((status, response), 403, "ORIGIN_REJECTED")
            status, _headers, response = self.request("POST", path, body)
            self.assert_error((status, response), 401, "ADMIN_REQUIRED")
            status, _headers, response = self.request("POST", path, body, cookie="sdr_doa_admin=forged")
            self.assert_error((status, response), 401, "ADMIN_REQUIRED")
        self.assertEqual(self.monitor.published, [])

    def test_request_shape_confirm_and_field_rules(self) -> None:
        cookie = self.admin_cookie()
        cases = [
            (["not", "an", "object"], "INVALID_REQUEST"),
            ({"changes": GOOD_CHANGES, "confirm": True}, "INVALID_REQUEST"),
            # The former request field is refused, not read as the new one.
            ({"changes": GOOD_CHANGES, "base_config_rev": 42, "confirm": True}, "INVALID_REQUEST"),
            (self.patch_body(extra=1), "INVALID_REQUEST"),
            (self.patch_body(changes=[1, 2]), "INVALID_REQUEST"),
            (self.patch_body(base_rev="42"), "INVALID_REQUEST"),
            (self.patch_body(base_rev=True), "INVALID_REQUEST"),
            (self.patch_body(base_rev=-1), "INVALID_REQUEST"),
            (self.patch_body(confirm=False), "CONFIRM_REQUIRED"),
            (self.patch_body(confirm="true"), "CONFIRM_REQUIRED"),
            ({"changes": GOOD_CHANGES, "base_rev": 42}, "CONFIRM_REQUIRED"),
            (self.patch_body(changes={}), "EMPTY_CHANGES"),
            (self.patch_body(changes={"gain_db": 20.7, "en_remote_control": 1}), "FIELD_NOT_ALLOWED"),
            (self.patch_body(changes={"vfo_frequency_hz": 433_920_000}), "FIELD_NOT_ALLOWED"),
            (self.patch_body(changes={"vfo0_frequency_hz": 23_999_999}), "VALUE_OUT_OF_RANGE"),
            (self.patch_body(changes={"vfo0_frequency_hz": 1_766_000_001}), "VALUE_OUT_OF_RANGE"),
            (self.patch_body(changes={"vfo0_frequency_hz": 433_920_000.5}), "VALUE_OUT_OF_RANGE"),
            (self.patch_body(changes={"gain_db": 100.5}), "VALUE_OUT_OF_RANGE"),
            (self.patch_body(changes={"vfo0_bandwidth_hz": "12500"}), "VALUE_OUT_OF_RANGE"),
            (self.patch_body(changes={"gain_db": True}), "VALUE_OUT_OF_RANGE"),
            (self.patch_body(changes={"vfo0_squelch_db": None}), "VALUE_OUT_OF_RANGE"),
            (self.patch_body(changes={"vfo0_squelch_db": 50.5}), "VALUE_OUT_OF_RANGE"),
            (self.patch_body(changes={"gain_db": 24.5}), "GAIN_NOT_IN_APPROVED_TABLE"),
            (self.patch_body(changes={"center_frequency_hz": 433_920_000}), "CENTER_CHANGE_REQUIRES_VFO0_TARGET"),
            (self.patch_body(changes={"center_frequency_hz": 433_920_000, "vfo0_frequency_hz": 433_930_000}),
             "MVP_CENTER_MUST_EQUAL_VFO0"),
        ]
        for body, code in cases:
            with self.subTest(body=body):
                self.assert_error(self.send_patch(body, cookie=cookie), 400, code)
        # Python's JSON parser accepts NaN and Infinity; the range check refuses them.
        for literal in (b"NaN", b"Infinity", b"-Infinity", b"1e400"):
            raw = b'{"changes": {"vfo0_squelch_db": ' + literal + b'}, "base_rev": 42, "confirm": true}'
            status, _headers, body = self.request("POST", "/api/mqtt/config-patch", raw=raw, cookie=cookie)
            self.assertEqual((status, body["code"]), (400, "VALUE_OUT_OF_RANGE"), literal)
        rejected = self.assert_error(
            self.send_patch(self.patch_body(changes={"secret": 1, "gain_db": 20.7}), cookie=cookie),
            400,
            "FIELD_NOT_ALLOWED",
        )
        self.assertEqual(rejected["fields"], ["secret"])
        gain = self.assert_error(self.send_patch(self.patch_body(changes={"gain_db": 20.0}), cookie=cookie),
                                 400, "GAIN_NOT_IN_APPROVED_TABLE")
        self.assertEqual(gain["gains"], list(cmds.GAIN_TABLE_DB))
        # Malformed and oversized bodies.
        status, _headers, body = self.request("POST", "/api/mqtt/config-patch", raw=b"{not json", cookie=cookie)
        self.assertEqual((status, body["code"]), (400, "INVALID_REQUEST"))
        oversized = json.dumps(self.patch_body(padding="x" * 5000)).encode("utf-8")
        status, _headers, body = self.request("POST", "/api/mqtt/config-patch", raw=oversized, cookie=cookie)
        self.assertEqual((status, body["code"]), (400, "INVALID_REQUEST"))
        for body in ([], {"confirm": True}, {"op": "config.get"}):
            self.assert_error(self.send_get(body, cookie=cookie), 400, "INVALID_REQUEST")
        self.assertEqual(self.monitor.published, [])

    def test_monitor_state_checks(self) -> None:
        cookie = self.admin_cookie()
        for send in (lambda: self.send_patch(self.patch_body(), cookie=cookie), lambda: self.send_get(cookie=cookie)):
            self.server.mqtt_monitor = None
            self.assert_error(send(), 409, "MQTT_MONITOR_DISABLED")
            self.server.mqtt_monitor = ground_console._UnavailableMqttMonitor(
                "127.0.0.1", 1883, "tcp", "/mqtt", ground_console.MQTT_DEPENDENCY_ERROR,
            )
            self.assert_error(send(), 503, "MQTT_DEPENDENCY_MISSING")
            self.server.mqtt_monitor = self.monitor
            for connection in ("connecting", "disconnected", "error", "stopped"):
                self.monitor.connection = connection
                self.assert_error(send(), 503, "MQTT_NOT_CONNECTED")
            self.monitor.connection = "connected"
        self.assertEqual(self.monitor.published, [])

    def test_node_session_and_fresh_health(self) -> None:
        cookie = self.admin_cookie()
        for session in ({"known": False, "sid": None, "boot": None}, {"sid": None}, {"boot": None}):
            saved = dict(self.monitor.session)
            self.monitor.session.update(session)
            self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "NODE_SESSION_UNAVAILABLE")
            self.assert_error(self.send_get(cookie=cookie), 409, "NODE_SESSION_UNAVAILABLE")
            self.monitor.session = saved
        # A patch needs a fresh telemetry/health, as the edge's Ground requires; a get does not.
        self.monitor.session["health_fresh"] = False
        self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "NODE_NOT_FRESH")
        self.assertEqual(self.monitor.published, [])
        status, sent = self.send_get(cookie=cookie)
        self.assertEqual(status, 202, sent)
        self.assertEqual([item["op"] for item in self.monitor.published], ["config.get"])

    def test_base_revision_must_be_known_and_current(self) -> None:
        cookie = self.admin_cookie()
        self.monitor.session["cfg"] = None
        self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "CONFIG_REVISION_UNKNOWN")
        self.monitor.session["cfg"] = 43
        stale = self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "CONFIG_REVISION_STALE")
        self.assertEqual(stale["current_base_rev"], 43)
        stale = self.assert_error(self.send_patch(self.patch_body(base_rev=None), cookie=cookie), 409, "CONFIG_REVISION_STALE")
        self.assertEqual(stale["current_base_rev"], 43)
        self.assertEqual(self.monitor.published, [])

    def test_the_first_failing_check_wins(self) -> None:
        cookie = self.admin_cookie()
        # Everything wrong at once: the request itself is reported first.
        self.monitor.connection = "disconnected"
        self.monitor.session.update(health_fresh=False, cfg=None)
        self.assert_error(self.send_patch(self.patch_body(changes={"gain_db": 24.5}), cookie=cookie),
                          400, "GAIN_NOT_IN_APPROVED_TABLE")
        self.assert_error(self.send_patch(self.patch_body(confirm=False, changes={}), cookie=cookie), 400, "CONFIRM_REQUIRED")
        self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 503, "MQTT_NOT_CONNECTED")
        self.monitor.connection = "connected"
        self.monitor.session.update(known=False)
        self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "NODE_SESSION_UNAVAILABLE")
        self.monitor.session.update(known=True)
        self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "NODE_NOT_FRESH")
        self.monitor.session.update(health_fresh=True)
        self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "CONFIG_REVISION_UNKNOWN")
        self.monitor.session.update(cfg=41)
        self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "CONFIG_REVISION_STALE")
        self.monitor.session.update(cfg=42)
        status, first = self.send_patch(self.patch_body(), cookie=cookie)
        self.assertEqual(status, 202, first)
        self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "COMMAND_IN_FLIGHT")
        self.monitor.publish_error = RuntimeError("socket gone")
        self.monitor.ack(first["command_id"], "APPLIED")
        self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 502, "MQTT_PUBLISH_FAILED")

    def test_accepted_patch_is_the_edge_envelope(self) -> None:
        cookie = self.admin_cookie()
        before = _now_ms()
        status, body = self.send_patch(
            self.patch_body(changes={"vfo0_squelch_db": -70, "gain_db": 20.7004, "center_frequency_hz": 433_920_000.0,
                                     "vfo0_frequency_hz": 433_920_000}),
            cookie=cookie,
        )
        self.assertEqual(status, 202, body)
        self.assertIs(body["ok"], True)
        self.assertRegex(body["command_id"], COMMAND_ID_RE)
        self.assertEqual((body["op"], body["state"]), ("config.patch", "published"))
        self.assertEqual((body["topic"], body["qos"], body["ttl_ms"]), (PATCH_TOPIC, 1, 15_000))
        self.assertEqual(body["base_rev"], 42)
        self.assertEqual(body["expires_ms"] - body["issued_ms"], 15_000)
        self.assertGreaterEqual(body["issued_ms"], before)
        expected = {"center_frequency_hz": 433_920_000, "gain_db": 20.7, "vfo0_frequency_hz": 433_920_000, "vfo0_squelch_db": -70}
        self.assertEqual(body["changes"], expected)
        [published] = self.monitor.published
        self.assertEqual(list(published), ["v", "id", "sid", "boot", "issued_ms", "expires_ms", "base_rev", "op", "changes"])
        self.assertEqual(
            {key: published[key] for key in ("v", "id", "sid", "boot", "base_rev", "op")},
            {"v": 2, "id": body["command_id"], "sid": STATE["sid"], "boot": STATE["boot"], "base_rev": 42, "op": "config.patch"},
        )
        self.assertEqual(published["changes"], expected)
        self.assertEqual(list(published["changes"]), list(expected))
        self.assertEqual(type(published["changes"]["center_frequency_hz"]), int)
        cmds.validate_command(published, now_ms=published["issued_ms"])

    def test_one_command_in_flight_at_a_time(self) -> None:
        cookie = self.admin_cookie()
        status, first = self.send_patch(self.patch_body(), cookie=cookie)
        self.assertEqual(status, 202)
        busy = self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "COMMAND_IN_FLIGHT")
        self.assertEqual(busy["command_id"], first["command_id"])
        _status, _headers, reported = self.request("GET", "/api/mqtt/config-reported")
        self.assertEqual(reported["pending_command_id"], first["command_id"])
        # A read is not a mutation: config.get still goes out while the patch waits.
        status, get = self.send_get(cookie=cookie)
        self.assertEqual(status, 202, get)

        self.monitor.ack(first["command_id"], "ACCEPTED", rev=42)
        self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "COMMAND_IN_FLIGHT")
        self.monitor.ack(first["command_id"], "APPLIED", rev=43)
        self.monitor.session["cfg"] = 43
        status, second = self.send_patch(self.patch_body(base_rev=43), cookie=cookie)
        self.assertEqual(status, 202, second)
        self.assertNotEqual(second["command_id"], first["command_id"])
        self.assertEqual([item["op"] for item in self.monitor.published], ["config.patch", "config.get", "config.patch"])

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

    def test_status_follows_puback_and_acks(self) -> None:
        cookie = self.admin_cookie()
        _status, sent = self.send_patch(self.patch_body(), cookie=cookie)
        command_id = sent["command_id"]
        first = self.status_of(command_id)
        self.assertEqual((first["state"], first["final"], first["op"]), ("published", False, "config.patch"))
        self.assertEqual((first["topic"], first["changes"], first["base_rev"]), (PATCH_TOPIC, sent["changes"], 42))
        self.assertEqual((first["issued_ms"], first["expires_ms"]), (sent["issued_ms"], sent["expires_ms"]))
        self.assertIsNone(first["puback_reason"])
        self.assertIs(first["monitor_restarted"], False)
        self.assertIsNone(first["ack"])

        self.monitor.puback(command_id, 0)
        delivered = self.status_of(command_id)
        self.assertEqual((delivered["state"], delivered["puback_reason"]), ("delivered", 0))
        for progress in ("ACCEPTED", "APPLYING", "VERIFYING"):
            self.monitor.ack(command_id, progress, rev=42)
            seen = self.status_of(command_id)
            self.assertEqual((seen["state"], seen["final"], seen["ack"]["status"]), ("acknowledged", False, progress))
        self.monitor.ack(command_id, "APPLIED", rev=43, result={
            "revision": 43, "persisted": True,
            "proof": {"center_frequency_hz": "FRESH_DAQ_RF_CENTER", "vfo0_frequency_hz": "FRESH_DOA_FREQUENCY"},
            "challenge": "never-shown",
        })
        acked = self.status_of(command_id)
        self.assertEqual((acked["state"], acked["final"]), ("acked", True))
        self.assertEqual(acked["ack"], {
            "status": "APPLIED", "final": True, "error": None, "reason": None, "revision": 43,
            "proof": {"center_frequency_hz": "FRESH_DAQ_RF_CENTER", "vfo0_frequency_hz": "FRESH_DOA_FREQUENCY"},
            "persisted": True, "t": acked["ack"]["t"], "received_at_ms": 2,
        })
        self.assertNotIn("never-shown", json.dumps(acked))
        _status, _headers, latest = self.request("GET", "/api/mqtt/config-patch")
        self.assertEqual((latest["command"]["command_id"], latest["command"]["state"]), (command_id, "acked"))

    def test_every_final_edge_status_ends_the_command(self) -> None:
        cookie = self.admin_cookie()
        finals = {
            "APPLIED": {"revision": 43, "persisted": True, "proof": {"gain_db": "FRESH_DAQ_GAIN"}},
            "PERSISTED_UNVERIFIED": {"revision": 43, "persisted": True, "proof": {}, "reason": "NATIVE_RUNTIME_EVIDENCE_INCOMPLETE"},
            "OUTCOME_UNKNOWN": {"error": "HELPER_CLOSED"},
            "REJECTED": {"error": "CONFIG_REVISION_CONFLICT"},
            "CONFLICT": {"error": "COMMAND_ID_CONFLICT"},
            "EXPIRED": {"error": "EXPIRED_OR_INVALID_DEADLINE"},
            "FAILED": {"error": "CONFIG_CHANGED_BEFORE_WRITE"},
            "CANCELLED": {"reason": "OPERATOR_CANCELLED"},
        }
        for status_name, result in finals.items():
            with self.subTest(status=status_name):
                status, sent = self.send_patch(self.patch_body(changes={"gain_db": 20.7}), cookie=cookie)
                self.assertEqual(status, 202, sent)
                self.monitor.ack(sent["command_id"], status_name, result=result)
                done = self.status_of(sent["command_id"])
                self.assertEqual((done["state"], done["final"], done["ack"]["status"]), ("acked", True, status_name))
                self.assertEqual((done["ack"]["error"], done["ack"]["reason"]), (result.get("error"), result.get("reason")))

    def test_no_ack_after_expiry_plus_grace(self) -> None:
        clock = [1_700_000_000_000]
        self.server.clock_ms = lambda: clock[0]
        cookie = self.admin_cookie()
        _status, sent = self.send_patch(self.patch_body(), cookie=cookie)
        self.assertEqual(sent["issued_ms"], clock[0])
        command_id = sent["command_id"]
        clock[0] = sent["expires_ms"]
        self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "COMMAND_IN_FLIGHT")
        clock[0] = sent["expires_ms"] + NO_ACK_GRACE_MS
        self.assertEqual(self.status_of(command_id)["state"], "published")
        clock[0] = sent["expires_ms"] + NO_ACK_GRACE_MS + 1
        no_ack = self.status_of(command_id)
        self.assertEqual((no_ack["state"], no_ack["final"], no_ack["now_ms"]), ("no_ack", True, clock[0]))
        # Nothing is sent again; a late final ACK is still reported.
        self.assertEqual(len(self.monitor.published), 1)
        self.monitor.ack(command_id, "APPLIED")
        self.assertEqual(self.status_of(command_id)["state"], "acked")

    def test_a_command_the_edge_accepted_waits_for_its_final_ack(self) -> None:
        clock = [1_700_000_000_000]
        self.server.clock_ms = lambda: clock[0]
        cookie = self.admin_cookie()
        _status, sent = self.send_patch(self.patch_body(), cookie=cookie)
        self.monitor.ack(sent["command_id"], "ACCEPTED", rev=42)
        clock[0] = sent["issued_ms"] + FINAL_ACK_WAIT_MS
        self.assertEqual(self.status_of(sent["command_id"])["state"], "acknowledged")
        self.assert_error(self.send_patch(self.patch_body(), cookie=cookie), 409, "COMMAND_IN_FLIGHT")
        clock[0] += 1
        lost = self.status_of(sent["command_id"])
        self.assertEqual((lost["state"], lost["final"]), ("no_final_ack", True))
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

    def replace_monitor(self) -> Tuple[FakeMonitor, "weakref.ReferenceType[FakeMonitor]"]:
        """Reconnect as Message Monitor does and drop the test's own reference to the old monitor."""
        retired = weakref.ref(self.monitor)
        with patch.object(ground_console, "_new_mqtt_monitor", lambda *_args: FakeMonitor()):
            status, _headers, body = self.request("POST", "/api/mqtt/connect?host=127.0.0.1&port=1883&transport=tcp")
        self.assertEqual(status, 200, body)
        replacement = self.server.mqtt_monitor
        self.assertIsInstance(replacement, FakeMonitor)
        self.assertIsNot(replacement, retired())
        del self.monitor
        gc.collect()
        return replacement, retired

    def test_monitor_restart_keeps_tracking_the_command(self) -> None:
        cookie = self.admin_cookie()
        _status, sent = self.send_patch(self.patch_body(), cookie=cookie)
        command_id = sent["command_id"]
        self.monitor.puback(command_id, 0)
        replacement, retired = self.replace_monitor()
        # The new monitor follows the pending command; only it hears the edge now.
        self.assertEqual([item["command_id"] for item in replacement.adopted], [command_id])
        # Only the tracker holds the stopped publisher now, as in production.
        self.assertIsNotNone(retired())
        restarted = self.status_of(command_id)
        self.assertIs(restarted["monitor_restarted"], True)
        self.assertEqual((restarted["state"], restarted["puback_reason"]), ("delivered", 0))
        replacement.ack(command_id, "APPLIED")
        acked = self.status_of(command_id)
        self.assertEqual((acked["state"], acked["monitor_restarted"]), ("acked", True))
        # A final command no longer keeps the stopped monitor alive.
        gc.collect()
        self.assertIsNone(retired())
        self.assertEqual(self.status_of(command_id)["state"], "acked")

    def test_final_ack_seen_only_by_the_retired_monitor_is_kept(self) -> None:
        cookie = self.admin_cookie()
        _status, sent = self.send_patch(self.patch_body(), cookie=cookie)
        command_id = sent["command_id"]
        # The ACK reaches the old monitor, which is replaced before any poll.
        self.monitor.puback(command_id, 0)
        self.monitor.ack(command_id, "PERSISTED_UNVERIFIED", result={"revision": 43, "persisted": True})
        _replacement, retired = self.replace_monitor()
        acked = self.status_of(command_id)
        self.assertEqual(
            (acked["state"], acked["final"], acked["puback_reason"], acked["ack"]["status"], acked["ack"]["revision"]),
            ("acked", True, 0, "PERSISTED_UNVERIFIED", 43),
        )
        self.assertEqual(self.status_of(command_id)["state"], "acked")
        gc.collect()
        self.assertIsNone(retired())

    def test_a_pending_config_get_gets_its_report_after_a_reconnect(self) -> None:
        cookie = self.admin_cookie()
        _status, sent = self.send_get(cookie=cookie)
        command_id = sent["command_id"]
        replacement, _retired = self.replace_monitor()
        self.assertEqual(replacement.adopted, [{"command_id": command_id, "op": "config.get", "sid": STATE["sid"]}])
        replacement.ack(command_id, "APPLIED", rev=42, result={"revision": 42, "proof": "runtime"})
        self.assertEqual(self.status_of(command_id)["state"], "acknowledged")
        replacement.report(command_id)
        reported = self.status_of(command_id)
        self.assertEqual((reported["state"], reported["monitor_restarted"]), ("reported", True))

    def test_a_final_command_is_not_handed_over(self) -> None:
        cookie = self.admin_cookie()
        _status, sent = self.send_patch(self.patch_body(), cookie=cookie)
        self.monitor.ack(sent["command_id"], "REJECTED", result={"error": "CONFIG_REVISION_CONFLICT"})
        self.assertEqual(self.status_of(sent["command_id"])["state"], "acked")
        replacement, _retired = self.replace_monitor()
        self.assertEqual(replacement.adopted, [])

    def test_status_routes_validate_the_id(self) -> None:
        _status, _headers, latest = self.request("GET", "/api/mqtt/config-patch")
        self.assertEqual(latest, {"command": None})
        for command_id in ("bad%20id", "x" * 81, "a%2Fb"):
            status, _headers, body = self.request("GET", f"/api/mqtt/config-patch/{command_id}")
            self.assertEqual((status, body["code"]), (400, "INVALID_REQUEST"), command_id)
        for command_id in ("gc-unknown", "a.b:c"):
            status, _headers, body = self.request("GET", f"/api/mqtt/config-patch/{command_id}")
            self.assertEqual((status, body["code"], body["ok"]), (404, "COMMAND_UNKNOWN", False))

    # -- config.get and the reported values ----------------------------------

    def test_config_get_is_the_edge_envelope_and_waits_for_its_report(self) -> None:
        clock = [_now_ms()]
        self.server.clock_ms = lambda: clock[0]
        cookie = self.admin_cookie()
        status, sent = self.send_get(cookie=cookie)
        self.assertEqual(status, 202, sent)
        self.assertEqual((sent["op"], sent["topic"], sent["qos"], sent["ttl_ms"], sent["changes"]),
                         ("config.get", GET_TOPIC, 1, 15_000, {}))
        [published] = self.monitor.published
        self.assertEqual(list(published), ["v", "id", "sid", "boot", "issued_ms", "expires_ms", "base_rev", "op"])
        self.assertEqual((published["op"], published["base_rev"], published["sid"]), ("config.get", 42, STATE["sid"]))
        cmds.validate_command(published, now_ms=published["issued_ms"])
        # One settings request at a time; a patch is not blocked by it.
        pending = self.assert_error(self.send_get(cookie=cookie), 409, "SETTINGS_REQUEST_PENDING")
        self.assertEqual(pending["command_id"], sent["command_id"])
        _status, _headers, reported = self.request("GET", "/api/mqtt/config-reported")
        self.assertEqual(reported["settings_request"]["command_id"], sent["command_id"])
        self.assertEqual(reported["settings_request"]["state"], "published")
        self.assertIsNone(reported["pending_command_id"])

        self.monitor.ack(sent["command_id"], "APPLIED", rev=42, result={"revision": 42, "proof": "source_correlated"})
        waiting = self.request("GET", "/api/mqtt/config-reported")[2]["settings_request"]
        self.assertEqual((waiting["state"], waiting["final"], waiting["ack"]["proof"]), ("acknowledged", False, "source_correlated"))
        self.monitor.report(sent["command_id"])
        reported = self.request("GET", "/api/mqtt/config-reported")[2]
        self.assertEqual((reported["settings_request"]["state"], reported["settings_request"]["final"]), ("reported", True))
        # The edge answers one request a second; the console waits as long.
        clock[0] = sent["issued_ms"] + 999
        self.assert_error(self.send_get(cookie=cookie), 429, "CONFIG_GET_TOO_SOON")
        clock[0] += 1
        status, again = self.send_get(cookie=cookie)
        self.assertEqual(status, 202, again)

    def test_config_get_refused_by_the_edge_reports_its_error(self) -> None:
        clock = [1_700_000_000_000]
        self.server.clock_ms = lambda: clock[0]
        cookie = self.admin_cookie()
        _status, sent = self.send_get(cookie=cookie)
        self.monitor.ack(sent["command_id"], "REJECTED", result={"error": "TLS_REQUIRED_FOR_SETTINGS_REPORT"})
        request = self.request("GET", "/api/mqtt/config-reported")[2]["settings_request"]
        self.assertEqual((request["state"], request["ack"]["error"]), ("acked", "TLS_REQUIRED_FOR_SETTINGS_REPORT"))
        clock[0] += 1_000
        _status, silent = self.send_get(cookie=cookie)
        self.monitor.ack(silent["command_id"], "APPLIED", result={"revision": 42})
        clock[0] = silent["issued_ms"] + SETTINGS_REPORT_WAIT_MS + 1
        request = self.request("GET", "/api/mqtt/config-reported")[2]["settings_request"]
        self.assertEqual((request["state"], request["final"]), ("no_report", True))

    def test_config_reported_needs_no_admin_and_gives_safe_values_only(self) -> None:
        status, _headers, body = self.request("GET", "/api/mqtt/config-reported", origin=None)
        self.assertEqual(status, 200)
        self.assertIs(body["available"], True)
        self.assertIsNone(body["code"])
        self.assertEqual(body["broker"], {"host": "127.0.0.1", "port": 1883, "transport": "tcp", "connection": "connected"})
        self.assertEqual(body["base_rev"], 42)
        node = body["node"]
        self.assertEqual(
            {key: node[key] for key in ("sid", "cfg", "health_fresh", "remote_commands", "remote_config_patch")},
            {"sid": STATE["sid"], "cfg": 42, "health_fresh": True, "remote_commands": True, "remote_config_patch": True},
        )
        self.assertGreaterEqual(node["health_age_ms"], 0)
        self.assertNotIn("boot", node)
        self.assertIsNone(body["settings"])
        self.assertEqual(set(body["values"].values()), {None})
        self.assertIsNone(body["pending_command_id"])
        self.assertIsNone(body["settings_request"])
        self.assertIsInstance(body["now_ms"], int)

        self.monitor.report("gc-" + "1" * 24, received_at_ms=1_234)
        body = self.request("GET", "/api/mqtt/config-reported")[2]
        self.assertEqual(body["values"], {
            "center_frequency_hz": 433_920_000, "gain_db": 15.7, "vfo0_frequency_hz": 433_920_000,
            "vfo0_bandwidth_hz": 12_500, "vfo0_squelch_db": -80,
        })
        self.assertEqual(set(body["value_sources"].values()), {"settings_reported"})
        self.assertEqual(set(body["value_received_at_ms"].values()), {1_234})
        self.assertEqual(
            {key: body["settings"][key] for key in ("id", "rev", "received_at_ms", "matches_state_cfg")},
            {"id": "gc-" + "1" * 24, "rev": 42, "received_at_ms": 1_234, "matches_state_cfg": True},
        )
        # The node's settings.json text never leaves the server.
        self.assertNotIn("settings_json", json.dumps(body))
        self.assertNotIn("ant_arrangement", json.dumps(body))
        # A report of another revision is history, not the node's values.
        self.monitor.report("gc-" + "2" * 24, rev=41, matches=False)
        body = self.request("GET", "/api/mqtt/config-reported")[2]
        self.assertIs(body["settings"]["matches_state_cfg"], False)
        self.assertEqual(set(body["values"].values()), {None})
        self.assertEqual(set(body["value_sources"].values()), {None})

        self.monitor.session.update(known=False)
        body = self.request("GET", "/api/mqtt/config-reported")[2]
        self.assertEqual((body["node"], body["base_rev"]), (None, None))

        self.server.mqtt_monitor = None
        _status, _headers, body = self.request("GET", "/api/mqtt/config-reported")
        self.assertEqual((body["available"], body["code"]), (False, "MQTT_MONITOR_DISABLED"))
        self.assertEqual(body["broker"]["connection"], "disabled")
        self.assertEqual(set(body["values"].values()), {None})
        self.assertIsNone(body["base_rev"])

        self.server.mqtt_monitor = ground_console._UnavailableMqttMonitor("127.0.0.1", 1883, "tcp", "/mqtt", "missing")
        _status, _headers, body = self.request("GET", "/api/mqtt/config-reported")
        self.assertEqual((body["available"], body["code"]), (False, "MQTT_DEPENDENCY_MISSING"))
        self.assertEqual(body["broker"]["connection"], "error")

    def test_dry_run_previews_the_edge_envelope_without_sending(self) -> None:
        status, _headers, body = self.request(
            "POST", "/api/dry-run/config-patch", {"changes": {"gain_db": 20.7}}, origin=None,
        )
        self.assertEqual(status, 200, body)
        self.assertEqual((body["dry_run"], body["applied"], body["transport"]), (True, False, "none"))
        self.assertEqual((body["contract"], body["topic"], body["session_known"]), ("RDF Node config.patch", PATCH_TOPIC, True))
        command = body["command"]
        self.assertEqual((command["op"], command["sid"], command["boot"], command["base_rev"]),
                         ("config.patch", STATE["sid"], STATE["boot"], 42))
        self.assertEqual(command["expires_ms"] - command["issued_ms"], 15_000)
        self.assertEqual(command["changes"], {"gain_db": 20.7})
        self.assertTrue(command["id"].startswith("dryrun-"))
        self.monitor.session.update(known=False)
        _status, _headers, body = self.request("POST", "/api/dry-run/config-patch", {"changes": {"gain_db": 20.7}})
        self.assertIs(body["session_known"], False)
        self.assertEqual((body["command"]["sid"], body["command"]["boot"], body["command"]["base_rev"]), (None, None, None))
        for payload, fragment in (
            ({"changes": {"gain_db": 24}}, "GAIN_NOT_IN_APPROVED_TABLE"),
            ({"changes": {"center_frequency_hz": 433_920_000}}, "CENTER_CHANGE_REQUIRES_VFO0_TARGET"),
            ({"changes": {"vfo_frequency_hz": 433_920_000}}, "FIELD_NOT_ALLOWED"),
            ({"changes": {"gain_db": 20.7}, "base_config_rev": 3}, "only changes"),
        ):
            status, _headers, body = self.request("POST", "/api/dry-run/config-patch", payload)
            self.assertEqual((status, body["ok"], body["dry_run"]), (400, False, True), payload)
            self.assertIn(fragment, body["error"])
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
    """The real MqttMonitor behind the HTTP routes, with a fake paho client.

    The node's messages are the edge's own (commands.json), with the id of
    the command this console published put in, and fresh times.
    """

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
        self.health_q = json.loads(COMMANDS["session"]["health"])["q"]

    def deliver(self, suffix: str, payload: Any, *, qos: int = 1, retained: bool = False) -> None:
        raw = payload if isinstance(payload, bytes) else json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.client.on_message(self.client, None, self.monitor_tests.message(f"sdr/v2/{NODE}/{suffix}", raw, qos, retained))

    def fresh_state(self) -> None:
        self.deliver("state", COMMANDS["session"]["state"].encode("utf-8"), retained=True)

    def fresh_health(self) -> None:
        self.health_q += 1
        health = dict(json.loads(COMMANDS["session"]["health"]), t=_now_ms(), q=self.health_q)
        self.deliver("telemetry/health", health, qos=0)

    def edge_answer(self, case: str, index: int, command_id: str) -> Dict[str, Any]:
        ack = json.loads(CASES[case]["edge"]["acks"][index]["payload"])
        ack.update(id=command_id, t=_now_ms())
        return ack

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

    def cookie(self) -> str:
        status, headers, _body = self.request("POST", "/api/admin/login", {"password": PASSWORD})
        self.assertEqual(status, 200)
        return headers["Set-Cookie"].split(";", 1)[0]

    def test_config_get_publishes_to_the_edge_and_its_report_fills_kontrol(self) -> None:
        cookie = self.cookie()
        # Without a node state there is nothing to address the command to.
        status, _headers, body = self.request("POST", "/api/mqtt/config-get", {}, cookie=cookie)
        self.assertEqual((status, body["code"]), (409, "NODE_SESSION_UNAVAILABLE"))
        self.fresh_state()
        reported = self.request("GET", "/api/mqtt/config-reported")[2]
        self.assertEqual((reported["broker"]["connection"], reported["base_rev"]), ("connected", STATE["cfg"]))
        self.assertIs(reported["node"]["health_fresh"], False)

        status, _headers, sent = self.request("POST", "/api/mqtt/config-get", {}, cookie=cookie)
        self.assertEqual(status, 202, sent)
        [((topic, raw), options)] = self.client.publish_calls
        self.assertEqual(topic, GET_TOPIC)
        self.assertEqual((options["qos"], options["retain"]), (1, False))
        self.assertEqual(options["properties"].MessageExpiryInterval, 15)
        command = json.loads(raw.decode("utf-8"))
        self.assertEqual(raw, cmds.encode_command(command))
        self.assertEqual((command["id"], command["sid"], command["boot"], command["base_rev"], command["op"]),
                         (sent["command_id"], STATE["sid"], STATE["boot"], STATE["cfg"], "config.get"))

        self.client.on_publish(self.client, None, self.client.mid, types.SimpleNamespace(value=0), None)
        self.deliver("ack/config", self.edge_answer("config-get", 0, command["id"]))
        report = json.loads(CASES["config-get"]["edge"]["settings_reported"])
        report.update(id=command["id"], t=_now_ms())
        self.deliver("settings/reported", report)
        reported = self.request("GET", "/api/mqtt/config-reported")[2]
        self.assertEqual(reported["settings_request"]["state"], "reported")
        self.assertEqual(reported["settings"]["matches_state_cfg"], True)
        self.assertEqual(reported["values"]["center_frequency_hz"], 433_920_000)
        self.assertEqual(reported["values"]["vfo0_bandwidth_hz"], 12_500)
        self.assertEqual(reported["value_sources"]["gain_db"], "settings_reported")
        # Another console's settings report is not ours.
        other = dict(report, id="ground-0123456789abcdef0123")
        self.deliver("settings/reported", other)
        self.assertEqual(self.request("GET", "/api/mqtt/config-reported")[2]["settings"]["id"], command["id"])

    def test_config_patch_round_trip_with_the_edge_answers(self) -> None:
        cookie = self.cookie()
        self.fresh_state()
        status, _headers, body = self.request(
            "POST", "/api/mqtt/config-patch",
            {"changes": {"center_frequency_hz": 434_000_000, "vfo0_frequency_hz": 434_000_000}, "base_rev": STATE["cfg"],
             "confirm": True},
            cookie=cookie,
        )
        self.assertEqual((status, body["code"]), (409, "NODE_NOT_FRESH"))
        self.fresh_health()
        status, _headers, sent = self.request(
            "POST", "/api/mqtt/config-patch",
            {"changes": {"center_frequency_hz": 434_000_000, "vfo0_frequency_hz": 434_000_000}, "base_rev": STATE["cfg"],
             "confirm": True},
            cookie=cookie,
        )
        self.assertEqual(status, 202, sent)
        [((topic, raw), options)] = self.client.publish_calls
        self.assertEqual(topic, PATCH_TOPIC)
        self.assertEqual((options["qos"], options["retain"]), (1, False))
        self.assertEqual(options["properties"].MessageExpiryInterval, 15)
        command = json.loads(raw.decode("utf-8"))
        # Byte for byte the envelope shape the edge accepted in commands.json.
        judged = json.loads(CASES["retune"]["console"]["payload"])
        self.assertEqual(list(command), list(judged))
        self.assertEqual(command["changes"], judged["changes"])
        path = f"/api/mqtt/config-patch/{sent['command_id']}"
        self.assertEqual(self.request("GET", path)[2]["state"], "published")

        self.client.on_publish(self.client, None, self.client.mid, types.SimpleNamespace(value=0), None)
        self.assertEqual(self.request("GET", path)[2]["state"], "delivered")
        self.deliver("ack/config", self.edge_answer("retune", 0, command["id"]))
        progress = self.request("GET", path)[2]
        self.assertEqual((progress["state"], progress["ack"]["status"]), ("acknowledged", "ACCEPTED"))
        self.deliver("ack/config", self.edge_answer("retune", 1, command["id"]))
        acked = self.request("GET", path)[2]
        self.assertEqual((acked["state"], acked["final"], acked["ack"]["status"]), ("acked", True, "APPLIED"))
        self.assertEqual(acked["ack"]["proof"], {
            "center_frequency_hz": "FRESH_DAQ_RF_CENTER", "vfo0_frequency_hz": "FRESH_DOA_FREQUENCY",
        })
        reported = self.request("GET", "/api/mqtt/config-reported")[2]
        self.assertIsNone(reported["pending_command_id"])
        # The Message Monitor still reports a monitor that never publishes on its own.
        snapshot = self.request("GET", "/api/mqtt")[2]
        self.assertEqual((snapshot["read_only"], snapshot["publish_enabled"]), (True, False))

    def test_a_stale_base_rev_is_answered_with_the_edge_conflict(self) -> None:
        cookie = self.cookie()
        self.fresh_state()
        self.fresh_health()
        status, _headers, sent = self.request(
            "POST", "/api/mqtt/config-patch", {"changes": {"gain_db": 15.7}, "base_rev": STATE["cfg"], "confirm": True},
            cookie=cookie,
        )
        self.assertEqual(status, 202, sent)
        self.deliver("ack/config", self.edge_answer("stale-base-rev", 0, sent["command_id"]))
        done = self.request("GET", f"/api/mqtt/config-patch/{sent['command_id']}")[2]
        self.assertEqual((done["state"], done["ack"]["status"], done["ack"]["error"]),
                         ("acked", "REJECTED", "CONFIG_REVISION_CONFLICT"))
        # Nothing is retried with a new id.
        self.assertEqual(len(self.client.publish_calls), 1)


if __name__ == "__main__":
    unittest.main()
