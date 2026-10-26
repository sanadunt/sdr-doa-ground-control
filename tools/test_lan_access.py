#!/usr/bin/env python3
"""The opt-in LAN view: settings, request rules and the second listener.

The listener tests bind the LAN view on 127.0.0.1 and admit or refuse
127.0.0.1 through the manager's test hook, so both sides of the client rule
run without another host. The tests of POST /api/lan-access and of the start
go through the saved setting, which refuses a loopback bind: they bind
0.0.0.0 on a free port with a TEST-NET allowlist, so the listener refuses
every client while it is open. Nothing contacts Data Out, a broker or a tile
provider.
"""

from __future__ import annotations

import contextlib
import http.client
import io
import ipaddress
import json
import os
import re
import signal
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple
from unittest.mock import patch

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

# ground_console resolves its admin password at import time; give it a
# test-only value so the import never reads a local .env file.
_SAVED_ADMIN_PASSWORD = os.environ.get("SDR_DOA_ADMIN_PASSWORD")
os.environ["SDR_DOA_ADMIN_PASSWORD"] = "lan-access-import-no-secret"
try:
    import ground_console  # noqa: E402
finally:
    if _SAVED_ADMIN_PASSWORD is None:
        os.environ.pop("SDR_DOA_ADMIN_PASSWORD", None)
    else:
        os.environ["SDR_DOA_ADMIN_PASSWORD"] = _SAVED_ADMIN_PASSWORD

import lan_access as lan  # noqa: E402
from tile_cache import TILE_ROUTE_PREFIX  # noqa: E402

BASE_URL = "http://doasdr.local:8081"
PASSWORD = "lan-access-test-password"
TEST_NET = "192.0.2.0/24"  # RFC 5737: never a real client
LOOPBACK = [ipaddress.ip_network("127.0.0.1/32")]
NOBODY = [ipaddress.ip_network(TEST_NET)]
FAKE_SNAPSHOT = {"overall_state": "UNVERIFIED", "source": "fake"}

Headers = Sequence[Tuple[str, str]]


def _free_port(host: str = "127.0.0.1") -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((host, 0))
        return int(probe.getsockname()[1])


def _closed(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            return False
    except ConnectionRefusedError:
        return True


def _request(
    port: int,
    method: str,
    path: str,
    headers: Optional[Headers] = None,
    body: Optional[bytes] = None,
    *,
    host: Optional[str] = "default",
) -> Tuple[int, Dict[str, str], bytes]:
    """One request with exactly the headers given (Host included, or twice)."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        if host == "default":
            connection.putheader("Host", f"127.0.0.1:{port}")
        elif host is not None:
            connection.putheader("Host", host)
        for name, value in headers or ():
            connection.putheader(name, value)
        if body is not None:
            connection.putheader("Content-Length", str(len(body)))
        connection.endheaders(body)
        response = connection.getresponse()
        return response.status, {key.lower(): value for key, value in response.getheaders()}, response.read()
    finally:
        connection.close()


def _json(body: bytes) -> Dict[str, Any]:
    value = json.loads(body.decode("utf-8"))
    assert isinstance(value, dict)
    return value


def _write_frontend(root: Path) -> Path:
    dist = root / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "receiver").mkdir()
    (dist / "index.html").write_text("<!doctype html><title>console</title>", encoding="utf-8")
    (dist / "favicon.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>", encoding="utf-8")
    (dist / "favicon.ico").write_bytes(b"\x00\x00\x01\x00")
    (dist / "assets" / "app.js").write_text("console.log('app');", encoding="utf-8")
    (dist / "receiver" / "index.html").write_text("<!doctype html><title>receiver</title>", encoding="utf-8")
    return dist


class _ServerCase(unittest.TestCase):
    """A loopback console with temporary state; Data Out is a fake."""

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-lan-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.frontend = _write_frontend(self.root)
        self.password = patch.object(ground_console, "ADMIN_PASSWORD", PASSWORD)
        self.password.start()
        self.addCleanup(self.password.stop)
        self.output = io.StringIO()
        quiet = contextlib.redirect_stdout(self.output)
        quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)
        self.snapshot_targets: List[str] = []

    def start_server(self, config: Optional[Dict[str, Any]] = None) -> Any:
        # No MQTT host: a config save would otherwise start a real monitor.
        saved = config if config is not None else {"version": 1, "base_url": BASE_URL, "mqtt_host": ""}
        (self.root / "console.json").write_text(json.dumps(saved), encoding="utf-8")
        server = ground_console.GroundConsoleServer(
            ("127.0.0.1", 0),
            BASE_URL,
            config_path=str(self.root / "console.json"),
            branding_path=str(self.root / "branding.json"),
            frontend_dir=self.frontend,
            receiver_data_dir=self.root / "receiver",
            tile_cache_dir=self.root / "tiles",
        )

        def fake_collect(base_url: str) -> Dict[str, Any]:
            self.snapshot_targets.append(base_url)
            return dict(FAKE_SNAPSHOT)

        server.collect_snapshot = fake_collect  # type: ignore[method-assign]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def close() -> None:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()

        self.addCleanup(close)
        return server

    def main_request(
        self,
        server: Any,
        method: str,
        path: str,
        payload: Any = None,
        *,
        origin: bool = True,
        cookie: Optional[str] = None,
        headers: Optional[Headers] = None,
    ) -> Tuple[int, Dict[str, Any]]:
        port = server.server_address[1]
        extra: List[Tuple[str, str]] = list(headers or ())
        if origin:
            extra.append(("Origin", f"http://127.0.0.1:{port}"))
        if cookie:
            extra.append(("Cookie", cookie))
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        if body is not None:
            extra.append(("Content-Type", "application/json"))
        status, _headers, raw = _request(port, method, path, extra, body)
        return status, _json(raw)

    def admin_cookie(self, server: Any, password: str = PASSWORD) -> str:
        port = server.server_address[1]
        body = json.dumps({"password": password}).encode("utf-8")
        status, headers, _raw = _request(
            port, "POST", "/api/admin/login",
            [("Origin", f"http://127.0.0.1:{port}"), ("Content-Type", "application/json")], body,
        )
        self.assertEqual(status, 200)
        match = re.match(r"(sdr_doa_admin=[^;]+);", headers.get("set-cookie", ""))
        assert match is not None
        return match.group(1)

    def open_lan(self, server: Any, allowed: Sequence[Any] = LOOPBACK) -> int:
        status = server.lan.apply(
            {"enabled": True, "port": 0, "bind": "127.0.0.1", "allowed_clients": []},
            allowed=allowed,
        )
        self.assertEqual(status["state"], "open", status)
        return int(server.lan._server.server_address[1])


class LanSettingsTests(unittest.TestCase):
    def test_the_default_is_off_on_8788_for_nobody(self) -> None:
        self.assertEqual(
            ground_console._default_console_config()["lan_access"],
            {"enabled": False, "port": 8788, "bind": "0.0.0.0", "allowed_clients": []},
        )

    def test_valid_settings_are_normalized(self) -> None:
        settings = lan.validate_settings({
            "enabled": True,
            "port": 9000.0,
            "bind": "0:0::0",
            "allowed_clients": [
                " 192.168.1.20 ", "192.168.1.5/24", "192.168.1.7/32", "fd00:1::/64", "192.168.1.20", "2001:db8::5",
            ],
        })
        self.assertEqual(settings, {
            "enabled": True,
            "port": 9000,
            "bind": "::",
            "allowed_clients": ["192.168.1.20", "192.168.1.0/24", "192.168.1.7", "fd00:1::/64", "2001:db8::5"],
        })
        self.assertEqual(lan.validate_settings({"bind": "192.168.1.10"})["bind"], "192.168.1.10")
        self.assertEqual(lan.validate_settings({"bind": "0.0.0.0"})["bind"], "0.0.0.0")
        # Fields left out keep the fallback's.
        fallback = lan.validate_settings({"enabled": True, "allowed_clients": ["10.1.0.0/16"]})
        self.assertEqual(lan.validate_settings({"port": 9100}, fallback)["allowed_clients"], ["10.1.0.0/16"])
        self.assertIs(lan.validate_settings({"port": 9100}, fallback)["enabled"], True)

    def test_broad_loopback_and_malformed_clients_are_refused(self) -> None:
        refused = [
            "0.0.0.0/0", "::/0", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/15", "fd00::/32", "2001:db8::/47",
            "127.0.0.1", "127.0.0.0/16", "::1", "0.0.0.0", "::", "::ffff:192.168.1.5", "224.0.0.1", "ff02::1",
            "fe80::1%eth0", "groundstation.local", "192.168.1.300", "", "   ", 42, None, "x" * 80,
        ]
        for entry in refused:
            with self.subTest(entry=entry):
                with self.assertRaises(ValueError):
                    lan.validate_settings({"allowed_clients": [entry]})
        # The narrowest allowed networks pass.
        self.assertEqual(lan.validate_settings({"allowed_clients": ["10.20.0.0/16", "fd00:1:2::/48"]})["allowed_clients"],
                         ["10.20.0.0/16", "fd00:1:2::/48"])
        with self.assertRaises(ValueError):
            lan.validate_settings({"allowed_clients": [f"192.168.1.{index}" for index in range(33)]})
        self.assertEqual(len(lan.validate_settings({"allowed_clients": [f"192.168.1.{index}" for index in range(32)]})["allowed_clients"]), 32)
        with self.assertRaises(ValueError):
            lan.validate_settings({"allowed_clients": "192.168.1.5"})

    def test_port_bind_and_shape_rules(self) -> None:
        for port in (0, 80, 1023, 65536, True, "8788", 8788.5, None):
            with self.subTest(port=port), self.assertRaises(ValueError):
                lan.validate_settings({"port": port})
        self.assertEqual(lan.validate_settings({"port": 1024})["port"], 1024)
        self.assertEqual(lan.validate_settings({"port": 65535})["port"], 65535)
        with self.assertRaisesRegex(ValueError, "console port 8787"):
            lan.validate_settings({"port": 8787}, console_port=8787)
        for bind in ("127.0.0.1", "127.1.2.3", "::1", "224.0.0.1", "fe80::1", "::ffff:192.168.1.10", "eth0", "", None, 5):
            with self.subTest(bind=bind), self.assertRaises(ValueError):
                lan.validate_settings({"bind": bind})
        for enabled in ("true", 1, None):
            with self.subTest(enabled=enabled), self.assertRaises(ValueError):
                lan.validate_settings({"enabled": enabled})
        with self.assertRaisesRegex(ValueError, "unknown field"):
            lan.validate_settings({"allowed_client": []})
        with self.assertRaises(ValueError):
            lan.validate_settings(["enabled"])

    def test_console_config_keeps_lan_access_and_refuses_a_bad_block(self) -> None:
        good = {"enabled": True, "port": 9001, "bind": "0.0.0.0", "allowed_clients": ["192.168.1.0/24"]}
        config = ground_console._validate_console_config({"lan_access": good})
        self.assertEqual(config["lan_access"], good)
        # Another field's change keeps the saved block.
        self.assertEqual(ground_console._validate_console_config({"refresh_seconds": 5}, config)["lan_access"], good)
        with self.assertRaises(ValueError):
            ground_console._validate_console_config({"lan_access": {**good, "allowed_clients": ["0.0.0.0/0"]}})
        self.assertNotIn("lan_access", ground_console._public_config(config))

    def test_an_invalid_saved_block_falls_back_to_off_and_keeps_the_rest(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sdr-doa-lan-load-") as temporary:
            path = Path(temporary) / "console.json"
            path.write_text(json.dumps({
                "version": 1,
                "base_url": "http://192.168.100.100:8081",
                "refresh_seconds": 5,
                "lan_access": {"enabled": True, "port": 8788, "bind": "0.0.0.0", "allowed_clients": ["0.0.0.0/0"]},
            }), encoding="utf-8")
            warnings: List[str] = []
            loaded = ground_console._load_console_config(path, log=warnings.append)
        self.assertEqual(loaded["base_url"], "http://192.168.100.100:8081")
        self.assertEqual(loaded["refresh_seconds"], 5)
        self.assertEqual(loaded["lan_access"], lan.default_settings())
        self.assertTrue(any("lan_access" in line for line in warnings), warnings)


class LanRequestRuleTests(unittest.TestCase):
    def test_host_rule(self) -> None:
        names = frozenset({"groundstation"})
        allowed = [
            "192.168.1.10:8788", "[fd00::1]:8788", "[::1]:8788", "groundstation.local:8788",
            "GroundStation.Local.:8788", "rdf-ground.lan.local:8788", "groundstation:8788",
        ]
        for host in allowed:
            with self.subTest(host=host):
                self.assertTrue(lan.host_allowed([host], 8788, names))
        refused = [
            "evil.example:8788", "localhost:8788", "192.168.1.10", "192.168.1.10:8787", "groundstation.local",
            "user@192.168.1.10:8788", "192.168.1.10:8788/x", "", "local:8788", "-bad.local:8788", "[fd00::1]",
            "192.168.1.10:notaport",
        ]
        for host in refused:
            with self.subTest(host=host):
                self.assertFalse(lan.host_allowed([host], 8788, names))
        self.assertFalse(lan.host_allowed([], 8788, names))
        self.assertFalse(lan.host_allowed(["192.168.1.10:8788", "192.168.1.10:8788"], 8788, names))
        self.assertNotIn("localhost", lan.own_host_names())

    def test_fetch_site_rule(self) -> None:
        for value in (None, "", "none", "same-origin", "same-site", "Same-Origin"):
            self.assertTrue(lan.fetch_site_allowed(value), value)
        for value in ("cross-site", " Cross-Site "):
            self.assertFalse(lan.fetch_site_allowed(value), value)

    def test_routes(self) -> None:
        self.assertEqual(lan.TILE_PREFIX, TILE_ROUTE_PREFIX)
        for path in ("/", "/index.html", "/favicon.ico", "/favicon.svg", "/assets/index-abc.js", "/assets/x/y.css"):
            self.assertEqual(lan.lan_route(path), lan.ROUTE_UI, path)
        self.assertEqual(lan.lan_route("/api/tiles/osm/1/0/0"), lan.ROUTE_TILE)
        for path in sorted(lan.API_ROUTES):
            self.assertEqual(lan.lan_route(path), path)
        self.assertEqual(lan.API_ROUTES, frozenset({
            "/api/health", "/api/capabilities", "/api/snapshot", "/api/console-config", "/api/mqtt",
            "/api/mqtt/rdf-node", "/api/preferences", "/api/branding", "/api/admin/status",
        }))
        for path in (
            "/receiver", "/receiver/", "/receiver/index.html", "/api/receiver/settings", "/api/lan-access",
            "/api/admin/login", "/api/admin/branding", "/api/mqtt/config-patch", "/api/mqtt/config-patch/abc",
            "/api/mqtt/config-reported", "/api/mqtt/connect", "/api/dry-run/config-patch", "/assets/", "/assets",
            "/api/health/", "/api/", "/.env", "/tools/ground_console.py",
        ):
            self.assertIsNone(lan.lan_route(path), path)

    def test_client_addresses(self) -> None:
        allowed = [ipaddress.ip_network("192.168.1.0/24"), ipaddress.ip_network("fd00:1::/64")]
        self.assertTrue(lan.client_allowed(allowed, "192.168.1.44"))
        self.assertTrue(lan.client_allowed(allowed, "::ffff:192.168.1.44"))
        self.assertTrue(lan.client_allowed(allowed, "fd00:1::9"))
        self.assertTrue(lan.client_allowed(allowed, "fd00:1::9%eth0"))
        for address in ("192.168.2.1", "127.0.0.1", "::1", "fd00:2::1", "garbage", ""):
            self.assertFalse(lan.client_allowed(allowed, address), address)
        self.assertFalse(lan.client_allowed([], "192.168.1.44"))

    def test_refusal_log_is_once_a_minute_per_address_and_bounded(self) -> None:
        lines: List[str] = []
        now = [100.0]
        log = lan.RefusalLog(lines.append, clock=lambda: now[0], max_addresses=4)
        self.assertTrue(log.note("192.0.2.1"))
        self.assertFalse(log.note("192.0.2.1"))
        now[0] += 59.0
        self.assertFalse(log.note("192.0.2.1"))
        self.assertTrue(log.note("192.0.2.2"))
        now[0] += 1.5
        self.assertTrue(log.note("192.0.2.1"))
        self.assertEqual(len(lines), 3)
        self.assertIn("192.0.2.1", lines[0])
        for index in range(20):
            log.note(f"198.51.100.{index}")
        self.assertLessEqual(len(log._last), 4)


class LanListenerTests(_ServerCase):
    def setUp(self) -> None:
        super().setUp()
        self.server = self.start_server()
        self.port = self.open_lan(self.server)

    def get(self, path: str, headers: Optional[Headers] = None, **kwargs: Any) -> Tuple[int, Dict[str, str], bytes]:
        return _request(self.port, "GET", path, headers, **kwargs)

    def assert_refused(self, result: Tuple[int, Dict[str, str], bytes], status: int, code: str) -> None:
        actual, _headers, body = result
        self.assertEqual(actual, status, body)
        payload = _json(body)
        self.assertEqual((payload["ok"], payload["code"]), (False, code))

    def test_the_read_only_routes_answer(self) -> None:
        for path in ("/api/health", "/api/capabilities", "/api/console-config", "/api/mqtt", "/api/mqtt/rdf-node",
                     "/api/preferences", "/api/branding", "/api/admin/status", "/api/snapshot"):
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertEqual(status, 200, body)
                self.assertEqual(headers["content-type"], "application/json; charset=utf-8")
                self.assertEqual(headers["x-content-type-options"], "nosniff")
                self.assertEqual(headers["cache-control"], "no-store")
        config = _json(self.get("/api/console-config")[2])
        self.assertNotIn("lan_access", config)
        self.assertEqual(config["base_url"], BASE_URL)
        preferences = _json(self.get("/api/preferences")[2])
        self.assertIs(preferences["read_only"], True)
        health = _json(self.get("/api/health")[2])
        self.assertEqual(health["lan_access"], {"enabled": True, "state": "open", "reason": None})

    def test_capabilities_say_lan_view_and_nothing_writable(self) -> None:
        caps = _json(self.get("/api/capabilities")[2])
        self.assertEqual(caps["access"], "lan-view")
        self.assertIs(caps["read_only"], True)
        self.assertIs(caps["mqtt_publish"], False)
        self.assertIs(caps["admin_enabled"], False)
        self.assertIs(caps["admin_branding"], False)
        self.assertIs(caps["config_patch"]["enabled"], False)
        self.assertIs(caps["preferences_read_only"], True)
        self.assertEqual(caps["lan_access"], {"enabled": True, "state": "open", "reason": None})
        local = self.main_request(self.server, "GET", "/api/capabilities", origin=False)[1]
        self.assertEqual(local["access"], "local")
        self.assertEqual(local["lan_access"]["state"], "open")
        self.assertEqual(local["lan_access"]["address"], f"127.0.0.1:{self.port}")

    def test_the_snapshot_reads_only_the_configured_data_out(self) -> None:
        status, _headers, body = self.get("/api/snapshot?base_url=http%3A%2F%2F127.0.0.1%3A8081")
        self.assertEqual(status, 200)
        self.assertEqual(_json(body), FAKE_SNAPSHOT)
        self.assertEqual(self.snapshot_targets, [BASE_URL])

    def test_the_built_ui_is_served_with_the_console_headers(self) -> None:
        main_port = self.server.server_address[1]
        for path in ("/", "/index.html", "/favicon.svg", "/favicon.ico", "/assets/app.js"):
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertEqual(status, 200)
                main_status, main_headers, main_body = _request(main_port, "GET", path)
                self.assertEqual((main_status, main_body), (200, body))
                for name in ("content-security-policy", "content-type", "x-content-type-options", "referrer-policy", "cache-control"):
                    self.assertEqual(headers[name], main_headers[name], name)
        self.assertIn("frame-ancestors 'none'", self.get("/")[1]["content-security-policy"])

    def test_head_answers_without_a_body(self) -> None:
        for path in ("/", "/api/health", "/assets/app.js"):
            with self.subTest(path=path):
                status, headers, body = _request(self.port, "HEAD", path)
                self.assertEqual(status, 200)
                self.assertEqual(body, b"")
                self.assertGreater(int(headers["content-length"]), 0)
        status, _headers, body = _request(self.port, "HEAD", "/api/lan-access")
        self.assertEqual((status, body), (403, b""))

    def test_tiles_reach_the_tile_route(self) -> None:
        # An unknown source answers from the tile cache without any upstream.
        status, _headers, body = self.get("/api/tiles/nosuch/0/0/0")
        self.assertEqual(status, 404)
        self.assertEqual(_json(body)["error"], "unknown tile source")
        status, _headers, _body = self.get("/api/tiles/nosuch/0/0/0", [("Sec-Fetch-Site", "same-site")])
        self.assertEqual(status, 403)

    def test_every_other_path_is_refused(self) -> None:
        for path in (
            "/receiver", "/receiver/", "/receiver/index.html", "/api/receiver/settings", "/api/receiver/records",
            "/api/receiver/archive/items", "/api/receiver/scans", "/api/lan-access", "/api/mqtt/config-reported",
            "/api/mqtt/config-patch", "/api/mqtt/config-patch/gc-0123", "/api/mqtt/connect", "/api/admin/login",
            "/api/admin/logout", "/api/admin/branding", "/api/dry-run/config-patch", "/api/unknown", "/.env",
            "/tools/ground_console.py", "/assets", "/api/health/",
        ):
            with self.subTest(path=path):
                self.assert_refused(self.get(path), 403, "LAN_READ_ONLY")

    def test_every_write_method_is_refused(self) -> None:
        cookie = self.admin_cookie(self.server)
        before = (self.root / "console.json").read_bytes()
        lan_origin = ("Origin", f"http://127.0.0.1:{self.port}")
        for method, path, body in (
            ("POST", "/api/admin/login", {"password": PASSWORD}),
            ("POST", "/api/admin/logout", {}),
            ("POST", "/api/console-config", {"refresh_seconds": 30}),
            ("POST", "/api/lan-access", {"enabled": False}),
            ("POST", "/api/mqtt/config-patch", {"changes": {}, "base_config_rev": 1, "confirm": True}),
            ("POST", "/api/mqtt/connect?host=127.0.0.1&port=1883", None),
            ("POST", "/api/preferences", {"values": {"sdr-console-theme": "light"}}),
            ("PUT", "/api/preferences", {"values": {"sdr-console-theme": "light"}}),
            ("POST", "/api/admin/branding", {"app_name": "LAN"}),
            ("POST", "/api/receiver/sessions", {}),
            ("DELETE", "/api/receiver/scans/abc", None),
            ("POST", "/api/dry-run/config-patch", {"changes": {}}),
            ("PATCH", "/", None),
            ("OPTIONS", "/api/health", None),
            ("TRACE", "/", None),
        ):
            with self.subTest(method=method, path=path):
                raw = None if body is None else json.dumps(body).encode("utf-8")
                status, headers, answer = _request(
                    self.port, method, path, [lan_origin, ("Cookie", cookie), ("Content-Type", "application/json")], raw,
                )
                self.assertEqual(status, 405, answer)
                self.assertEqual(headers["allow"], "GET, HEAD")
                self.assertNotIn("set-cookie", headers)
                self.assertEqual(_json(answer)["code"], "LAN_READ_ONLY")
        self.assertEqual((self.root / "console.json").read_bytes(), before)
        self.assertEqual(self.server.preferences.snapshot()["values"], {})
        self.assertEqual(self.server.get_branding()["app_name"], ground_console.DEFAULT_APP_NAME)

    def test_an_admin_cookie_is_never_honoured(self) -> None:
        cookie = self.admin_cookie(self.server)
        self.assertIs(self.main_request(self.server, "GET", "/api/admin/status", origin=False, cookie=cookie)[1]["authenticated"], True)
        status, _headers, body = self.get("/api/admin/status", [("Cookie", cookie)])
        self.assertEqual((status, _json(body)), (200, {"authenticated": False}))

    def test_host_and_fetch_site_rules(self) -> None:
        port = self.port
        for host in (f"evil.example:{port}", f"localhost:{port}", "127.0.0.1", f"127.0.0.1:{port + 1}", f"user@127.0.0.1:{port}"):
            with self.subTest(host=host):
                self.assert_refused(self.get("/api/health", host=host), 403, "ORIGIN_REJECTED")
        self.assert_refused(self.get("/api/health", host=None), 403, "ORIGIN_REJECTED")
        self.assert_refused(
            _request(port, "GET", "/api/health", [("Host", f"127.0.0.1:{port}")]), 403, "ORIGIN_REJECTED",
        )
        for host in (f"groundstation.local:{port}", f"[::1]:{port}", f"192.168.1.10:{port}"):
            with self.subTest(host=host):
                self.assertEqual(self.get("/api/health", host=host)[0], 200)
        names = sorted(lan.own_host_names())
        if names:
            self.assertEqual(self.get("/api/health", host=f"{names[0]}:{port}")[0], 200)
        self.assert_refused(self.get("/api/health", [("Sec-Fetch-Site", "cross-site")]), 403, "ORIGIN_REJECTED")
        for site in ("same-origin", "same-site", "none"):
            self.assertEqual(self.get("/api/health", [("Sec-Fetch-Site", site)])[0], 200, site)

    def test_a_client_not_allowed_gets_403_without_a_body(self) -> None:
        self.port = self.open_lan(self.server, NOBODY)
        before = self.output.getvalue().count("LAN view refused 127.0.0.1")
        for method, path in (("GET", "/"), ("GET", "/api/health"), ("POST", "/api/admin/login"), ("HEAD", "/"), ("BREW", "/")):
            with self.subTest(method=method, path=path):
                body = b"{}" if method == "POST" else None
                status, headers, answer = _request(self.port, method, path, body=body)
                self.assertEqual((status, answer), (403, b""))
                self.assertEqual(headers["content-length"], "0")
                self.assertNotIn("content-type", headers)
        # A malformed request line gets the same bare answer.
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as raw:
            raw.sendall(b"GET / HTTP/9\r\n\r\n")
            self.assertTrue(raw.recv(4096).startswith(b"HTTP/1.0 403 Forbidden\r\nContent-Length: 0\r\n"))
        self.assertEqual(self.output.getvalue().count("LAN view refused 127.0.0.1") - before, 1)
        self.assertNotIn('lan 127.0.0.1 "GET', self.output.getvalue())

    def test_the_listener_moves_and_closes_live(self) -> None:
        first = self.port
        second = self.open_lan(self.server)
        self.assertNotEqual(first, second)
        self.assertTrue(_closed(first))
        self.assertEqual(_request(second, "GET", "/api/health")[0], 200)
        status = self.server.lan.apply({**lan.default_settings(), "enabled": False})
        self.assertEqual((status["state"], status["reason"]), ("closed", "DISABLED"))
        self.assertTrue(_closed(second))

    def test_server_close_closes_the_lan_view(self) -> None:
        self.server.server_close()
        self.assertTrue(_closed(self.port))
        self.assertEqual(self.server.lan.status()["reason"], "STOPPED")


class LanStartTests(_ServerCase):
    def enabled_config(self, port: int) -> Dict[str, Any]:
        return {
            "version": 1,
            "base_url": BASE_URL,
            "mqtt_host": "",
            "lan_access": {"enabled": True, "port": port, "bind": "0.0.0.0", "allowed_clients": [TEST_NET]},
        }

    def test_the_default_password_keeps_it_closed_and_says_why(self) -> None:
        port = _free_port("0.0.0.0")
        with patch.object(ground_console, "ADMIN_PASSWORD", ground_console.DEFAULT_ADMIN_PASSWORD):
            server = self.start_server(self.enabled_config(port))
            self.assertTrue(_closed(port))
            health = self.main_request(server, "GET", "/api/health", origin=False)[1]
            caps = self.main_request(server, "GET", "/api/capabilities", origin=False)[1]
        self.assertEqual(health["lan_access"], {"enabled": True, "state": "closed", "reason": "ADMIN_PASSWORD_DEFAULT"})
        self.assertEqual(caps["lan_access"]["reason"], "ADMIN_PASSWORD_DEFAULT")
        self.assertIn("LAN view stays closed: the default admin password is in use", self.output.getvalue())

    def test_disabled_admin_login_keeps_it_closed(self) -> None:
        port = _free_port("0.0.0.0")
        with patch.object(ground_console, "ADMIN_PASSWORD", None):
            server = self.start_server(self.enabled_config(port))
            self.assertTrue(_closed(port))
            self.assertEqual(server.lan.status()["reason"], "ADMIN_DISABLED")
        self.assertIn("admin login is disabled", self.output.getvalue())

    def test_an_enabled_setting_opens_at_start(self) -> None:
        port = _free_port("0.0.0.0")
        server = self.start_server(self.enabled_config(port))
        status = server.lan.status()
        self.assertEqual((status["state"], status["address"]), ("open", f"0.0.0.0:{port}"))
        # 127.0.0.1 is not in the TEST-NET allowlist.
        self.assertEqual(_request(port, "GET", "/api/health")[0::2], (403, b""))
        self.assertIn(f"LAN view (read only) open on http://0.0.0.0:{port}/ for 1 allowed client entry", self.output.getvalue())

    def test_sigterm_closes_the_lan_view(self) -> None:
        port = _free_port("0.0.0.0")
        data = self.root / "data"
        data.mkdir()
        (data / "console.json").write_text(json.dumps(self.enabled_config(port)), encoding="utf-8")
        (data / ".env").write_text(f"SDR_DOA_ADMIN_PASSWORD={PASSWORD}\n", encoding="utf-8")
        seen: List[bool] = []

        def serve(_self: Any) -> None:
            seen.append(not _closed(port))
            os.kill(os.getpid(), signal.SIGTERM)

        argv = [
            "--port", str(_free_port()),
            "--config-path", str(data / "console.json"),
            "--branding-path", str(data / "branding.json"),
            "--preferences-path", str(data / "preferences.json"),
            "--data-dir", str(data / "receiver"),
            "--tile-cache-dir", str(data / "tiles"),
            "--env-file", str(data / ".env"),
            "--legacy-ui",
        ]
        clean_env = {key: value for key, value in os.environ.items() if not key.startswith("SDR_DOA_")}
        with patch.dict(os.environ, clean_env, clear=True), \
                patch.object(ground_console.GroundConsoleServer, "serve_forever", serve):
            self.assertEqual(ground_console.main(argv), 0)
        self.assertEqual(seen, [True])
        self.assertTrue(_closed(port))


class LanAccessRouteTests(_ServerCase):
    def setUp(self) -> None:
        super().setUp()
        self.server = self.start_server()
        self.cookie = self.admin_cookie(self.server)

    def post(self, payload: Any, **kwargs: Any) -> Tuple[int, Dict[str, Any]]:
        kwargs.setdefault("cookie", self.cookie)
        return self.main_request(self.server, "POST", "/api/lan-access", payload, **kwargs)

    def saved(self) -> Dict[str, Any]:
        return json.loads((self.root / "console.json").read_text(encoding="utf-8"))

    def test_reading_needs_no_admin_but_this_console_s_own_page(self) -> None:
        status, body = self.main_request(self.server, "GET", "/api/lan-access", origin=False)
        self.assertEqual(status, 200)
        self.assertEqual(body["config"], lan.default_settings())
        self.assertEqual((body["status"]["state"], body["status"]["reason"]), ("closed", "DISABLED"))
        port = self.server.server_address[1]
        for headers, host in (([("Sec-Fetch-Site", "cross-site")], "default"), ([], f"evil.example:{port}")):
            status, _headers, raw = _request(port, "GET", "/api/lan-access", headers, host=host)
            self.assertEqual((status, _json(raw)["code"]), (403, "ORIGIN_REJECTED"))

    def test_checks_run_in_order(self) -> None:
        status, body = self.post({"enabled": False}, origin=False)
        self.assertEqual((status, body["code"]), (403, "ORIGIN_REJECTED"))
        status, body = self.post({"enabled": False}, cookie=None)
        self.assertEqual((status, body["code"]), (401, "ADMIN_REQUIRED"))
        console_port = self.server.server_address[1]
        for payload in (
            {"allowed_clients": ["0.0.0.0/0"]},
            {"allowed_clients": ["127.0.0.1"]},
            {"allowed_clients": ["10.0.0.0/8"]},
            {"port": console_port},
            {"port": 80},
            {"bind": "127.0.0.1"},
            {"enabled": "yes"},
            {"surprise": 1},
            ["enabled"],
        ):
            with self.subTest(payload=payload):
                status, body = self.post(payload)
                self.assertEqual((status, body["code"], body["ok"]), (400, "LAN_ACCESS_INVALID", False))
                self.assertTrue(body["error"])
        self.assertNotIn("lan_access", self.saved())

    def test_the_default_password_cannot_enable_it(self) -> None:
        with patch.object(ground_console, "ADMIN_PASSWORD", ground_console.DEFAULT_ADMIN_PASSWORD):
            cookie = self.admin_cookie(self.server, ground_console.DEFAULT_ADMIN_PASSWORD)
            status, body = self.post({"enabled": True, "port": _free_port("0.0.0.0"), "allowed_clients": [TEST_NET]}, cookie=cookie)
            self.assertEqual((status, body["code"]), (409, "LAN_ADMIN_PASSWORD_DEFAULT"))
            status, body = self.post({"enabled": False, "allowed_clients": [TEST_NET]}, cookie=cookie)
            self.assertEqual(status, 200)
        self.assertIs(self.saved()["lan_access"]["enabled"], False)

    def test_enable_move_and_disable_live(self) -> None:
        first = _free_port("0.0.0.0")
        status, body = self.post({"enabled": True, "port": first, "bind": "0.0.0.0", "allowed_clients": [TEST_NET, "fd00:1::/64"]})
        self.assertEqual(status, 200, body)
        self.assertIs(body["ok"], True)
        self.assertEqual(body["config"], {"enabled": True, "port": first, "bind": "0.0.0.0", "allowed_clients": [TEST_NET, "fd00:1::/64"]})
        self.assertEqual((body["status"]["state"], body["status"]["address"], body["status"]["allowed_client_count"]),
                         ("open", f"0.0.0.0:{first}", 2))
        self.assertEqual(self.saved()["lan_access"], body["config"])
        self.assertEqual(_request(first, "GET", "/api/health")[0::2], (403, b""))
        view = self.main_request(self.server, "GET", "/api/lan-access", origin=False)[1]
        self.assertEqual(view, {"config": body["config"], "status": body["status"]})
        self.assertEqual(self.main_request(self.server, "GET", "/api/health", origin=False)[1]["lan_access"]["state"], "open")

        second = _free_port("0.0.0.0")
        status, body = self.post({"port": second})
        self.assertEqual((status, body["status"]["address"]), (200, f"0.0.0.0:{second}"))
        self.assertEqual(body["config"]["allowed_clients"], [TEST_NET, "fd00:1::/64"])
        self.assertTrue(_closed(first))
        self.assertEqual(_request(second, "GET", "/")[0], 403)

        status, body = self.post({"enabled": False})
        self.assertEqual((status, body["status"]["state"], body["status"]["reason"]), (200, "closed", "DISABLED"))
        self.assertTrue(_closed(second))
        self.assertIs(self.saved()["lan_access"]["enabled"], False)

    def test_a_port_in_use_leaves_it_closed_with_the_reason(self) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as holder:
            holder.bind(("0.0.0.0", 0))
            holder.listen(1)
            busy = holder.getsockname()[1]
            status, body = self.post({"enabled": True, "port": busy, "allowed_clients": [TEST_NET]})
        self.assertEqual(status, 200)
        self.assertEqual((body["status"]["state"], body["status"]["reason"], body["status"]["detail"]),
                         ("closed", "BIND_FAILED", "EADDRINUSE"))
        self.assertIs(self.saved()["lan_access"]["enabled"], True)
        self.assertIn("could not bind", self.output.getvalue())

    def test_console_config_never_shows_or_changes_lan_access(self) -> None:
        port = _free_port("0.0.0.0")
        self.assertEqual(self.post({"enabled": True, "port": port, "allowed_clients": [TEST_NET]})[0], 200)
        status, body = self.main_request(self.server, "GET", "/api/console-config", origin=False)
        self.assertEqual(status, 200)
        self.assertNotIn("lan_access", body)
        status, body = self.main_request(self.server, "POST", "/api/console-config", {"lan_access": {"enabled": False}})
        self.assertEqual(status, 400)
        self.assertIn("/api/lan-access", body["error"])
        status, body = self.main_request(self.server, "POST", "/api/console-config", {"refresh_seconds": 5})
        self.assertEqual(status, 200)
        self.assertNotIn("lan_access", body)
        saved = self.saved()
        self.assertEqual((saved["refresh_seconds"], saved["lan_access"]["enabled"], saved["lan_access"]["port"]), (5, True, port))
        self.assertEqual(self.server.lan.status()["state"], "open")


if __name__ == "__main__":
    unittest.main()
