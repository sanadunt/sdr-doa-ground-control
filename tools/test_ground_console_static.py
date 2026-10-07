#!/usr/bin/env python3
"""Black-box regression tests for the Ground Console static web boundary.

The static checks use the checked-out ``frontend/dist`` build when it exists.
They are explicitly skipped (and reported) when that build is not available;
API and loopback-boundary checks still run so a missing build cannot make the
whole file vacuously green.
"""

from __future__ import annotations

import http.client
import inspect
import json
import os
import re
import sys
import tempfile
import threading
import unittest
from contextlib import ExitStack
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple
from unittest import mock
from urllib.parse import quote, unquote, urlsplit


TOOLS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = TOOLS_DIR.parent
STATIC_ROOT = PROJECT_ROOT / "frontend" / "dist"
BASE_URL = "http://doasdr.local:8081"
_TEST_ADMIN_PASSWORD = "ground-console-static-test-no-secret"

# ground_console resolves its optional dotenv fallback at import time. Supply a
# deterministic test-only value before importing it so this file never reads a
# repository or user .env for a credential.
_HAD_ADMIN_PASSWORD = "SDR_DOA_ADMIN_PASSWORD" in os.environ
_SAVED_ADMIN_PASSWORD = os.environ.get("SDR_DOA_ADMIN_PASSWORD")
os.environ["SDR_DOA_ADMIN_PASSWORD"] = _TEST_ADMIN_PASSWORD
sys.path.insert(0, str(TOOLS_DIR))
try:
    import ground_console
    import sdr_doa_collector as collector
finally:
    if _HAD_ADMIN_PASSWORD:
        os.environ["SDR_DOA_ADMIN_PASSWORD"] = _SAVED_ADMIN_PASSWORD or ""
    else:
        os.environ.pop("SDR_DOA_ADMIN_PASSWORD", None)

# Do not let a pre-imported module make a test accidentally depend on a real
# local credential. The tests do not exercise a successful admin login.
ground_console.ADMIN_PASSWORD = None


@dataclass(frozen=True)
class HTTPResult:
    status: int
    headers: Mapping[str, str]
    body: bytes


class ConsoleHTTPHarness:
    """Run one console instance with only temporary local state."""

    def __init__(
        self,
        bind_host: str = "127.0.0.1",
        system_health_monitor: Optional[Any] = None,
        mqtt_monitor: Optional[Any] = None,
        legacy_rdf_node_mqtt_config: Optional[Mapping[str, Any]] = None,
    ) -> None:
        self.bind_host = bind_host
        self.system_health_monitor = system_health_monitor
        self.mqtt_monitor = mqtt_monitor
        self.legacy_rdf_node_mqtt_config = dict(legacy_rdf_node_mqtt_config or {})
        self._temporary: Optional[tempfile.TemporaryDirectory[str]] = None
        self.server: Any = None
        self.thread: Optional[threading.Thread] = None
        self.thread_error: Optional[BaseException] = None

    def __enter__(self) -> "ConsoleHTTPHarness":
        self._temporary = tempfile.TemporaryDirectory(prefix="ground-console-static-")
        root = Path(self._temporary.name)
        branding_path = root / "branding.json"
        config_path = root / "console.json"
        branding_path.write_text(
            json.dumps({"app_name": "Static Test Console", "logo_data_url": ""}),
            encoding="utf-8",
        )
        config = {
            "version": 1,
            "base_url": BASE_URL,
            "mqtt_host": "",
            "mqtt_port": 1883,
            "refresh_seconds": 0,
        }
        if self.legacy_rdf_node_mqtt_config:
            config["rdf_node_mqtt"] = self.legacy_rdf_node_mqtt_config
        config_path.write_text(json.dumps(config), encoding="utf-8")

        self.server = _new_server(
            bind_host=self.bind_host,
            branding_path=branding_path,
            config_path=config_path,
            config=config,
            receiver_data_dir=root / "receiver-data",
            mqtt_monitor=self.mqtt_monitor,
            system_health_monitor=self.system_health_monitor,
        )

        def serve() -> None:
            try:
                self.server.serve_forever()
            except BaseException as exc:  # surfaced by the first failed request
                self.thread_error = exc

        self.thread = threading.Thread(
            target=serve,
            name="ground-console-static-test",
            daemon=True,
        )
        self.thread.start()
        return self

    @property
    def port(self) -> int:
        if self.server is None:
            raise RuntimeError("console harness is not running")
        return int(self.server.server_address[1])

    def request(
        self,
        method: str,
        path: str,
        body: Optional[bytes] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> HTTPResult:
        if self.thread_error is not None:
            raise AssertionError("console server thread failed") from self.thread_error
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=4)
        try:
            request_headers = {"Connection": "close"}
            if headers:
                request_headers.update(headers)
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            payload = response.read()
            response_headers: Dict[str, str] = {}
            for key, value in response.getheaders():
                response_headers[key.lower()] = value
            return HTTPResult(response.status, response_headers, payload)
        finally:
            connection.close()

    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> None:
        if self.server is not None:
            self.server.shutdown()
        if self.thread is not None:
            self.thread.join(timeout=5)
        if self.server is not None:
            self.server.server_close()
        if self._temporary is not None:
            self._temporary.cleanup()
        self.server = None
        self.thread = None
        self._temporary = None


def _server_class() -> type:
    for name in ("GroundConsoleServer", "ConsoleServer"):
        candidate = getattr(ground_console, name, None)
        if candidate is not None:
            return candidate
    raise AssertionError("ground_console does not expose its existing ConsoleServer")


def _new_server(
    *,
    bind_host: str,
    branding_path: Path,
    config_path: Path,
    config: Mapping[str, Any],
    receiver_data_dir: Path,
    mqtt_monitor: Optional[Any] = None,
    system_health_monitor: Optional[Any] = None,
) -> Any:
    """Construct the current server while adapting to an in-flight static API.

    The builder may call the injected build directory ``static_dir``,
    ``static_root``, or ``frontend_dist``. Passing it only when the current
    constructor advertises that keyword keeps these tests black-box compatible
    with both the pre-static and new server shapes.
    """

    server_type = _server_class()
    parameters = inspect.signature(server_type).parameters
    static_value = str(STATIC_ROOT)
    values: Dict[str, Any] = {
        "mqtt_monitor": mqtt_monitor,
        "receiver_data_dir": str(receiver_data_dir),
        "system_health_monitor": system_health_monitor,
        "branding_path": str(branding_path),
        "branding_file": str(branding_path),
        "config_path": str(config_path),
        "config_file": str(config_path),
        "config": dict(config),
        "console_config": dict(config),
        "static_dir": static_value,
        "static_root": static_value,
        "frontend_dist": static_value,
        "frontend_dir": static_value,
        "web_root": static_value,
        "dist_dir": static_value,
    }
    kwargs = {name: values[name] for name in parameters if name in values}

    # These constants are fallbacks in the existing implementation. Point them
    # at the same temporary files as an additional guard if a builder removes
    # one of the explicit constructor keywords.
    patches = []
    for constant, value in (
        ("DEFAULT_BRANDING_PATH", branding_path),
        ("DEFAULT_CONFIG_PATH", config_path),
    ):
        if hasattr(ground_console, constant):
            patches.append(mock.patch.object(ground_console, constant, value))
    with ExitStack() as stack:
        for patcher in patches:
            stack.enter_context(patcher)
        return server_type((bind_host, 0), BASE_URL, **kwargs)


def _static_index() -> Optional[Path]:
    index = STATIC_ROOT / "index.html"
    return index if index.is_file() else None


def _asset_references(index: Path) -> List[Tuple[str, Path]]:
    """Return ``(request_path, expected_file)`` pairs linked by the build."""

    document = index.read_text(encoding="utf-8")
    references: List[Tuple[str, Path]] = []
    seen: set[str] = set()
    pattern = re.compile(r"(?:src|href)\s*=\s*([\"'])(.*?)\1", re.IGNORECASE)
    root = STATIC_ROOT.resolve()
    for match in pattern.finditer(document):
        raw_reference = match.group(2)
        parsed = urlsplit(raw_reference)
        decoded_path = unquote(parsed.path)
        if decoded_path.startswith("/"):
            relative = decoded_path.lstrip("/")
        else:
            relative = decoded_path
            while relative.startswith("./"):
                relative = relative[2:]
        if not relative.startswith("assets/"):
            continue
        if any(part == ".." for part in relative.split("/")):
            raise AssertionError(f"build contains a traversal asset reference: {raw_reference!r}")
        expected = (STATIC_ROOT / relative).resolve()
        try:
            expected.relative_to(root)
        except ValueError as exc:
            raise AssertionError(f"asset escapes frontend/dist: {raw_reference!r}") from exc
        if not expected.is_file():
            raise AssertionError(f"index.html references missing asset: {raw_reference!r}")
        request_path = "/" + relative
        if parsed.query:
            request_path += "?" + parsed.query
        if request_path not in seen:
            references.append((request_path, expected))
            seen.add(request_path)
    return references


_EXPECTED_MIMES: Dict[str, frozenset[str]] = {
    ".js": frozenset({"text/javascript", "application/javascript"}),
    ".mjs": frozenset({"text/javascript", "application/javascript"}),
    ".css": frozenset({"text/css"}),
    ".json": frozenset({"application/json"}),
    ".map": frozenset({"application/json", "application/octet-stream"}),
    ".svg": frozenset({"image/svg+xml"}),
    ".png": frozenset({"image/png"}),
    ".jpg": frozenset({"image/jpeg"}),
    ".jpeg": frozenset({"image/jpeg"}),
    ".gif": frozenset({"image/gif"}),
    ".webp": frozenset({"image/webp"}),
    ".ico": frozenset({"image/x-icon", "image/vnd.microsoft.icon"}),
    ".woff": frozenset({"font/woff", "application/font-woff"}),
    ".woff2": frozenset({"font/woff2"}),
    ".ttf": frozenset({"font/ttf"}),
    ".otf": frozenset({"font/otf"}),
    ".wasm": frozenset({"application/wasm"}),
}


def _content_type(result: HTTPResult) -> str:
    return result.headers.get("content-type", "").split(";", 1)[0].strip().lower()


def _decode_json(test: unittest.TestCase, result: HTTPResult, label: str) -> Any:
    test.assertIn("application/json", result.headers.get("content-type", "").lower(), label)
    test.assertNotIn(b"<!doctype", result.body.lower(), label)
    try:
        return json.loads(result.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AssertionError(f"{label} did not return valid JSON") from exc

def diagnostic_candidate_snapshot(
    now_ms: int,
    *,
    enabled: bool = True,
    connection: str = "ready",
    status: str = "FRESH",
    received_at_ms: Optional[int] = None,
    source_timestamp_ms: Optional[int] = None,
    flags: int = 31,
    error: Optional[str] = None,
) -> Dict[str, Any]:
    received = now_ms if received_at_ms is None else received_at_ms
    source = now_ms if source_timestamp_ms is None else source_timestamp_ms
    reasons = ["DIAGNOSTIC_UNVERIFIED"]
    if (flags & 2) == 0:
        reasons.append("CLOCK_FRESHNESS_UNVERIFIED")
    return {
        "enabled": enabled,
        "connection": connection,
        "node_id": "node_02",
        "topics": {
            "telemetry/diagnostic/angular": {
                "status": status,
                "received_at_ms": received,
                "payload": {
                    "encoding": "q16",
                    "source_timestamp_ms": source,
                    "flags": flags,
                    "trust": "UNVERIFIED",
                    "validation_reasons": reasons,
                    "values": list(range(360)),
                },
                "error": error,
            },
        },
    }



class GroundConsoleStaticRegressionTests(unittest.TestCase):
    """Regression coverage for static files, API precedence, and bind safety."""

    def test_v1_mqtt_defaults_to_ground_ip_websocket(self) -> None:
        config = ground_console._default_console_config()
        self.assertEqual(
            (
                config["mqtt_host"],
                config["mqtt_port"],
                config["mqtt_transport"],
                config["mqtt_ws_path"],
            ),
            ("10.90.0.1", 9001, "websockets", "/mqtt"),
        )
        args = ground_console._build_parser().parse_args([])
        self.assertEqual((args.mqtt_host, args.mqtt_port, args.mqtt_transport), ("10.90.0.1", 9001, "websockets"))
        tcp_args = ground_console._build_parser().parse_args(["--mqtt-transport", "tcp"])
        self.assertEqual(tcp_args.mqtt_transport, "tcp")

    def test_server_uses_mqtt_defaults_without_saved_config(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.object(
                ground_console,
                "DEFAULT_DATA_DIR",
                Path(temporary) / "receiver-data",
                create=True,
            ):
                server = ground_console.GroundConsoleServer(
                    ("127.0.0.1", 0),
                    BASE_URL,
                    config_path=str(Path(temporary) / "console.json"),
                )
                try:
                    config = server.get_config()
                finally:
                    server.server_close()
        self.assertEqual(
            (config["mqtt_host"], config["mqtt_port"], config["mqtt_transport"]),
            ("10.90.0.1", 9001, "websockets"),
        )

    def test_v1_mqtt_accepts_any_ip_literal_and_rejects_dns(self) -> None:
        config = ground_console._default_console_config()
        for host in ("192.168.4.10", "8.8.8.8", "2001:4860:4860::8888", "localhost", "127.0.0.1", "::1"):
            with self.subTest(host=host):
                validated = ground_console._validate_console_config({**config, "mqtt_host": host})
                self.assertEqual(validated["mqtt_host"], host)
        for host in ("broker.example.com", "192.0.2.999", "2001:db8::not-an-address"):
            with self.subTest(host=host):
                with self.assertRaises(ValueError):
                    ground_console._validate_console_config({**config, "mqtt_host": host})

    def test_rdf_node_id_defaults_old_config_and_validation(self) -> None:
        defaults = ground_console._default_console_config()
        self.assertEqual(defaults["rdf_node_id"], "uav-01")
        old_config = {key: value for key, value in defaults.items() if key != "rdf_node_id"}
        self.assertEqual(
            ground_console._validate_console_config(old_config)["rdf_node_id"],
            "uav-01",
        )
        with tempfile.TemporaryDirectory() as temporary:
            old_path = Path(temporary) / "console.json"
            old_path.write_text(json.dumps(old_config), encoding="utf-8")
            self.assertEqual(
                ground_console._load_console_config(old_path)["rdf_node_id"],
                "uav-01",
            )

        for node_id in ("node_2", "node-2", "A" * 64):
            with self.subTest(node_id=node_id):
                self.assertEqual(
                    ground_console._validate_console_config(
                        {**defaults, "rdf_node_id": node_id},
                    )["rdf_node_id"],
                    node_id,
                )
        for node_id in (".", "..", "", "node.part", "node/part", "x" * 65, None, 7, "naïve"):
            with self.subTest(node_id=node_id):
                with self.assertRaises(ValueError):
                    ground_console._validate_console_config(
                        {**defaults, "rdf_node_id": node_id},
                    )


    def test_invalid_rdf_node_id_is_rejected_before_monitor_creation(self) -> None:
        headers = {"Content-Type": "application/json"}
        with ConsoleHTTPHarness() as console:
            with mock.patch.object(ground_console, "_new_mqtt_monitor") as create_monitor:
                result = console.request(
                    "POST",
                    "/api/console-config",
                    json.dumps({
                        "mqtt_host": "127.0.0.1",
                        "rdf_node_id": "invalid.node",
                    }).encode("utf-8"),
                    headers,
                )

        self.assertEqual(result.status, 400)
        create_monitor.assert_not_called()

    def test_rdf_node_id_change_replaces_the_shared_monitor(self) -> None:
        class FakeMonitor:
            def __init__(self, node_id: str) -> None:
                self.host = "127.0.0.1"
                self.port = 1883
                self.node_id = node_id
                self.started = False
                self.stopped = False

            def start(self) -> None:
                self.started = True

            def stop(self) -> None:
                self.stopped = True

        old_monitor = FakeMonitor("uav-01")
        replacements: List[FakeMonitor] = []

        def create_monitor(*_args: Any, **kwargs: Any) -> FakeMonitor:
            monitor = FakeMonitor(kwargs["node_id"])
            replacements.append(monitor)
            return monitor

        with ConsoleHTTPHarness(mqtt_monitor=old_monitor) as console:
            with mock.patch.object(
                ground_console,
                "_new_mqtt_monitor",
                side_effect=create_monitor,
            ) as monitor_factory:
                current = console.server._get_stored_config()
                readback = console.server.apply_config({
                    **current,
                    "rdf_node_id": "node_02",
                })
                monitor_after_update = console.server.mqtt_monitor

        monitor_factory.assert_called_once()
        self.assertEqual(monitor_factory.call_args.kwargs["node_id"], "node_02")
        self.assertEqual(len(replacements), 1)
        self.assertTrue(old_monitor.stopped)
        self.assertTrue(replacements[0].started)
        self.assertIs(monitor_after_update, replacements[0])
        self.assertEqual(readback["rdf_node_id"], "node_02")


    def _require_static_build(self) -> Path:
        index = _static_index()
        if index is None:
            self.skipTest(
                "frontend/dist/index.html is absent; static-serving checks are explicitly skipped "
                "until the real frontend build is available"
            )
        return index

    def test_root_serves_built_html_with_hardened_csp(self) -> None:
        index = self._require_static_build()
        expected = index.read_bytes()
        with ConsoleHTTPHarness() as console:
            result = console.request("GET", "/")

        self.assertEqual(result.status, 200)
        self.assertEqual(_content_type(result), "text/html")
        self.assertEqual(result.headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(result.body, expected, "root must be the built frontend/dist index.html")

        html = result.body.decode("utf-8")
        self.assertRegex(
            html,
            r"<script\b[^>]+\bsrc\s*=",
            "built root must load JavaScript as an external asset",
        )
        csp = result.headers.get("content-security-policy", "")
        self.assertTrue(csp, "built root must send a Content-Security-Policy header")
        self.assertIn("connect-src 'self' https://tile.openstreetmap.de https://tile.openstreetmap.org", csp)
        self.assertIn("https://tile.openstreetmap.de", csp)
        self.assertIn("https://tile.openstreetmap.org", csp)
        script_directives = []
        for raw_directive in csp.split(";"):
            directive = raw_directive.strip().lower()
            if directive and directive.split(None, 1)[0].startswith("script-src"):
                script_directives.append(directive)
        self.assertTrue(script_directives, "CSP must define a script-src directive")
        self.assertTrue(
            any("'self'" in directive for directive in script_directives),
            "CSP must permit same-origin built JavaScript assets",
        )
        for directive in script_directives:
            self.assertNotIn("'unsafe-inline'", directive)

    def test_referenced_assets_have_expected_mime_and_bytes(self) -> None:
        index = self._require_static_build()
        references = _asset_references(index)
        self.assertTrue(references, "built index must reference at least one /assets/ file")
        extensions = {expected.suffix.lower() for _, expected in references}
        self.assertTrue(
            any(extension in {".js", ".mjs"} for extension in extensions),
            "built index must reference a JavaScript asset",
        )
        self.assertIn(".css", extensions, "built index must reference a CSS asset")

        with ConsoleHTTPHarness() as console:
            for request_path, expected_file in references:
                extension = expected_file.suffix.lower()
                expected_mimes = _EXPECTED_MIMES.get(extension)
                self.assertIsNotNone(
                    expected_mimes,
                    f"add an explicit MIME expectation for linked asset {expected_file.name!r}",
                )
                if expected_mimes is None:
                    raise AssertionError(f"no MIME expectation for linked asset {expected_file.name!r}")
                result = console.request("GET", request_path)
                self.assertEqual(result.status, 200, request_path)
                self.assertIn(_content_type(result), expected_mimes, request_path)
                self.assertEqual(result.body, expected_file.read_bytes(), request_path)

    def test_static_path_boundary_blocks_traversal_dotenv_and_unknown_extensions(self) -> None:
        self._require_static_build()
        blocked_paths = (
            "/../.env",
            "/%2e%2e/.env",
            "/%2E%2E%2F.env",
            "/assets/../.env",
            "/assets/%2e%2e/.env",
            "/assets%2f..%2f.env",
            "/assets/../index.html",
            "/assets/%2e%2e/index.html",
            "/assets%2f..%2findex.html",
            "/.env",
            "/%2eenv",
            "/assets/.env?static_test=1",
            "/assets/not-in-build.unknown-extension",
            "/not-in-build.unknown-extension",
        )
        with ConsoleHTTPHarness() as console:
            for path in blocked_paths:
                result = console.request("GET", path)
                self.assertIn(
                    result.status,
                    {int(HTTPStatus.BAD_REQUEST), int(HTTPStatus.FORBIDDEN), int(HTTPStatus.NOT_FOUND)},
                    f"static boundary did not block {path!r}: HTTP {result.status}",
                )
                self.assertNotEqual(result.status, int(HTTPStatus.OK), path)

    def test_system_health_get_returns_fixed_contract(self) -> None:
        expected = {
            "checked_at_ms": 1750000000000,
            "usb_telemetry": "PRESENT",
            "ppp_interface": "UP",
            "raspberry_peer": "NO_REPLY",
        }

        class FixedHealthMonitor:
            def __init__(self) -> None:
                self.calls = 0

            def snapshot(self) -> Dict[str, Any]:
                self.calls += 1
                return dict(expected)

        monitor = FixedHealthMonitor()
        with mock.patch.object(ground_console, "collect") as collect_mock:
            with ConsoleHTTPHarness(system_health_monitor=monitor) as console:
                result = console.request("GET", "/api/system-health")
                parameterized_result = console.request(
                    "GET",
                    "/api/system-health?target=192.0.2.99&interface=eth0",
                )

        self.assertEqual(result.status, 200)
        self.assertEqual(parameterized_result.status, 200)
        self.assertEqual(_decode_json(self, result, "system health"), expected)
        self.assertEqual(
            _decode_json(self, parameterized_result, "parameterized system health"),
            expected,
        )
        self.assertEqual(monitor.calls, 2)
        collect_mock.assert_not_called()

    def test_existing_api_routes_remain_json_and_precede_static_files(self) -> None:
        fixture_snapshot = {
            "fixture": True,
            "overall_state": "FIXTURE",
            "collector": {"base_url": BASE_URL},
        }
        collect_calls: List[Tuple[Tuple[Any, ...], Dict[str, Any]]] = []

        def fake_collect(*args: Any, **kwargs: Any) -> Dict[str, Any]:
            collect_calls.append((args, kwargs))
            return dict(fixture_snapshot)

        with ConsoleHTTPHarness() as console, \
            mock.patch.object(ground_console, "collect", side_effect=fake_collect), \
            mock.patch.object(collector, "collect", side_effect=fake_collect):
            branding_result = console.request("GET", "/api/branding")
            status_result = console.request("GET", "/api/admin/status")
            capabilities_result = console.request("GET", "/api/capabilities")
            config_result = console.request("GET", "/api/console-config")
            mqtt_result = console.request("GET", "/api/mqtt")
            snapshot_result = console.request(
                "GET",
                "/api/snapshot?base_url=" + quote(BASE_URL, safe=""),
            )
            missing_result = console.request("GET", "/api/this-route-does-not-exist")

        self.assertEqual(branding_result.status, 200)
        self.assertEqual(
            _decode_json(self, branding_result, "branding"),
            {"app_name": "Static Test Console", "logo_data_url": ""},
        )

        self.assertEqual(status_result.status, 200)
        self.assertEqual(
            _decode_json(self, status_result, "admin status"),
            {"authenticated": False},
        )

        self.assertEqual(capabilities_result.status, 200)
        capabilities = _decode_json(self, capabilities_result, "capabilities")
        self.assertTrue(capabilities["read_only"])
        self.assertFalse(capabilities["mqtt_publish"])
        self.assertFalse(capabilities["remote_post"])
        self.assertFalse(capabilities["config_apply"])
        self.assertFalse(capabilities["mqtt_monitor"])
        self.assertTrue(capabilities["admin_branding"])
        self.assertTrue(capabilities["admin_auth_required"])
        self.assertIsInstance(capabilities["config_allowlist"], list)

        self.assertEqual(config_result.status, 200)
        config = _decode_json(self, config_result, "console config")
        self.assertEqual(config["version"], 1)
        self.assertEqual(config["base_url"], BASE_URL)
        self.assertEqual(config["mqtt_host"], "")
        self.assertEqual(config["mqtt_port"], 1883)
        self.assertEqual(config["mqtt_transport"], "websockets")
        self.assertEqual(config["mqtt_ws_path"], "/mqtt")
        self.assertEqual(config["mqtt_username"], "")
        self.assertFalse(config["mqtt_password_set"])
        self.assertEqual(config["refresh_seconds"], 0)

        self.assertEqual(mqtt_result.status, 200)
        self.assertEqual(
            _decode_json(self, mqtt_result, "mqtt snapshot"),
            {"enabled": False, "read_only": True, "publish_enabled": False},
        )

        self.assertEqual(snapshot_result.status, 200)
        self.assertEqual(_decode_json(self, snapshot_result, "snapshot"), fixture_snapshot)
        self.assertEqual(len(collect_calls), 1, "snapshot test must use only the local fixture collector")

        self.assertEqual(missing_result.status, 404)
        self.assertEqual(_decode_json(self, missing_result, "missing API"), {"error": "not found"})


    def test_rdf_node_disabled_get_has_stable_unavailable_topics(self) -> None:
        suffixes = (
            "telemetry/doa",
            "telemetry/diagnostic/doa",
            "telemetry/diagnostic/angular",
            "telemetry/health",
            "telemetry/health/detail",
            "telemetry/angular",
            "state",
            "capabilities",
            "config/reported",
            "availability",
            "ack/config",
            "ack/operation",
        )
        with ConsoleHTTPHarness() as console:
            result = console.request("GET", "/api/mqtt/rdf-node")

        self.assertEqual(result.status, 200)
        snapshot = _decode_json(self, result, "disabled RDF Node MQTT snapshot")
        self.assertEqual(
            set(snapshot),
            {
                "enabled",
                "connection",
                "node_id",
                "last_error",
                "received",
                "valid",
                "invalid",
                "last_received_at_ms",
                "topic_counts",
                "topics",
            },
        )
        self.assertFalse(snapshot["enabled"])
        self.assertEqual(snapshot["connection"], "disabled")
        self.assertEqual(snapshot["node_id"], "uav-01")
        self.assertEqual(set(snapshot["topics"]), set(suffixes))
        self.assertEqual(set(snapshot["topic_counts"]), set(suffixes))
        self.assertEqual(snapshot["topic_counts"], dict.fromkeys(suffixes, 0))
        for topic in snapshot["topics"].values():
            self.assertEqual(
                set(topic),
                {"status", "received_at_ms", "qos", "retained", "payload", "candidate_payload", "error"},
            )
            self.assertEqual(topic["status"], "UNAVAILABLE")
            self.assertIsNone(topic["candidate_payload"])

    def test_rdf_node_id_round_trips_to_disabled_snapshots_and_diagnostic_endpoint(self) -> None:
        headers = {"Content-Type": "application/json"}
        with ConsoleHTTPHarness() as console:
            old_config_result = console.request("GET", "/api/console-config")
            old_snapshot_result = console.request("GET", "/api/mqtt/rdf-node")
            saved = console.request(
                "POST",
                "/api/console-config",
                json.dumps({"rdf_node_id": "node_02"}).encode("utf-8"),
                headers,
            )
            readback = console.request("GET", "/api/console-config")
            snapshot_result = console.request("GET", "/api/mqtt/rdf-node")
            diagnostic_result = console.request(
                "GET",
                "/api/v2/angular/diagnostic/latest",
            )

        self.assertEqual(old_config_result.status, 200)
        old_config = _decode_json(self, old_config_result, "old config defaults")
        self.assertEqual(old_config["rdf_node_id"], "uav-01")
        self.assertEqual(
            _decode_json(self, old_snapshot_result, "old disabled snapshot")["node_id"],
            "uav-01",
        )
        self.assertEqual(saved.status, 200)
        self.assertEqual(
            _decode_json(self, readback, "custom node ID readback")["rdf_node_id"],
            "node_02",
        )
        self.assertEqual(
            _decode_json(self, snapshot_result, "custom disabled snapshot")["node_id"],
            "node_02",
        )
        diagnostic = _decode_json(self, diagnostic_result, "disabled diagnostic endpoint")
        self.assertEqual(diagnostic["node_id"], "node_02")
        self.assertEqual(diagnostic["status"], "UNAVAILABLE")
        self.assertFalse(diagnostic["stale"])

    def test_diagnostic_angular_latest_unavailable_and_invalid_shapes(self) -> None:
        now_ms = 1_800_000_000_000
        unavailable = {
            "enabled": False,
            "connection": "disabled",
            "node_id": "node_02",
            "topics": {
                "telemetry/diagnostic/angular": {
                    "status": "UNAVAILABLE",
                    "received_at_ms": None,
                    "payload": None,
                    "error": None,
                },
            },
        }
        result = ground_console._diagnostic_angular_latest(unavailable, now_ms)
        self.assertEqual(
            set(result),
            {
                "enabled", "connection", "node_id", "status", "stale", "trust",
                "encoding", "source_timestamp_ms", "source_age_ms", "received_age_ms",
                "flags", "validation_reasons", "values", "error",
            },
        )
        self.assertEqual(result["status"], "UNAVAILABLE")
        self.assertFalse(result["stale"])
        self.assertEqual(result["node_id"], "node_02")
        self.assertIsNone(result["trust"])
        self.assertIsNone(result["values"])
        self.assertEqual(result["validation_reasons"], [])
        self.assertIsNone(result["error"])

        invalid = diagnostic_candidate_snapshot(
            now_ms,
            status="INVALID",
            error="INVALID_FRAME",
        )
        invalid["topics"]["telemetry/diagnostic/angular"]["payload"] = None
        invalid["topics"]["telemetry/diagnostic/angular"]["error"] = "raw payload detail"
        rejected = ground_console._diagnostic_angular_latest(invalid, now_ms)
        self.assertEqual(rejected["status"], "INVALID")
        self.assertFalse(rejected["stale"])
        self.assertIsNone(rejected["values"])
        self.assertEqual(rejected["error"], "INVALID_PAYLOAD")

    def test_diagnostic_angular_latest_enforces_age_boundaries_and_retains_stale_values(self) -> None:
        now_ms = 1_800_000_000_000
        cases = (
            (3000, 10000, "FRESH"),
            (3001, 5000, "STALE"),
            (0, 10001, "STALE"),
        )
        for received_age_ms, source_age_ms, expected in cases:
            with self.subTest(received_age_ms=received_age_ms, source_age_ms=source_age_ms):
                snapshot = diagnostic_candidate_snapshot(
                    now_ms,
                    received_at_ms=now_ms - received_age_ms,
                    source_timestamp_ms=now_ms - source_age_ms,
                )
                result = ground_console._diagnostic_angular_latest(snapshot, now_ms)
                self.assertEqual(result["status"], expected)
                self.assertEqual(result["stale"], expected == "STALE")
                self.assertEqual(result["received_age_ms"], received_age_ms)
                self.assertEqual(result["source_age_ms"], source_age_ms)
                self.assertEqual(result["values"], list(range(360)))

    def test_diagnostic_angular_latest_requires_clock_and_ready_connection(self) -> None:
        now_ms = 1_800_000_000_000
        missing_clock = diagnostic_candidate_snapshot(now_ms, flags=1)
        clock_result = ground_console._diagnostic_angular_latest(missing_clock, now_ms)
        self.assertEqual(clock_result["status"], "STALE")
        self.assertTrue(clock_result["stale"])
        self.assertIn("CLOCK_FRESHNESS_UNVERIFIED", clock_result["validation_reasons"])
        self.assertEqual(clock_result["values"], list(range(360)))

        for enabled, connection in ((True, "disconnected"), (False, "disabled")):
            with self.subTest(enabled=enabled, connection=connection):
                snapshot = diagnostic_candidate_snapshot(
                    now_ms,
                    enabled=enabled,
                    connection=connection,
                )
                result = ground_console._diagnostic_angular_latest(snapshot, now_ms)
                self.assertEqual(result["status"], "STALE")
                self.assertTrue(result["stale"])
                self.assertEqual(result["values"], list(range(360)))

    def test_diagnostic_angular_latest_future_times_have_null_ages(self) -> None:
        now_ms = 1_800_000_000_000
        future_source = diagnostic_candidate_snapshot(
            now_ms,
            source_timestamp_ms=now_ms + 1,
        )
        source_result = ground_console._diagnostic_angular_latest(future_source, now_ms)
        self.assertEqual(source_result["status"], "STALE")
        self.assertIsNone(source_result["source_age_ms"])
        self.assertEqual(source_result["received_age_ms"], 0)
        self.assertEqual(source_result["values"], list(range(360)))

        future_receive = diagnostic_candidate_snapshot(
            now_ms,
            received_at_ms=now_ms + 1,
            source_timestamp_ms=now_ms,
        )
        receive_result = ground_console._diagnostic_angular_latest(future_receive, now_ms)
        self.assertEqual(receive_result["status"], "STALE")
        self.assertIsNone(receive_result["received_age_ms"])
        self.assertEqual(receive_result["source_age_ms"], 0)

    def test_diagnostic_angular_latest_http_route_uses_the_shared_monitor(self) -> None:
        now_ms = int(time.time() * 1000)
        snapshot = diagnostic_candidate_snapshot(now_ms)

        class SharedMonitor:
            host = "127.0.0.1"
            port = 1883
            rdf_node_calls = 0

            def snapshot(self) -> Dict[str, Any]:
                raise AssertionError("endpoint must not create or read a second monitor")

            def rdf_node_snapshot(self) -> Dict[str, Any]:
                self.rdf_node_calls += 1
                return snapshot

        monitor = SharedMonitor()
        with ConsoleHTTPHarness(mqtt_monitor=monitor) as console:
            result = console.request("GET", "/api/v2/angular/diagnostic/latest")

        self.assertEqual(result.status, 200)
        response = _decode_json(self, result, "diagnostic Angular endpoint")
        self.assertEqual(response["status"], "FRESH")
        self.assertEqual(response["node_id"], "node_02")
        self.assertEqual(len(response["values"]), 360)
        self.assertEqual(monitor.rdf_node_calls, 1)



    def test_rdf_node_snapshot_uses_the_shared_v1_v2_monitor(self) -> None:
        v1_snapshot = {"connection": "connected", "read_only": True}
        v2_snapshot = {
            "enabled": True,
            "connection": "ready",
            "node_id": "uav-01",
            "last_error": None,
            "received": 1,
            "valid": 1,
            "invalid": 0,
            "last_received_at_ms": 1_790_668_800_000,
            "topic_counts": {"availability": 1},
            "topics": {"availability": {"status": "CONTEXT"}},
        }

        class SharedMonitor:
            host = "10.90.0.1"
            port = 9001

            def snapshot(self) -> Dict[str, Any]:
                return v1_snapshot

            def rdf_node_snapshot(self) -> Dict[str, Any]:
                return v2_snapshot

        with ConsoleHTTPHarness(mqtt_monitor=SharedMonitor()) as console:
            v1_result = console.request("GET", "/api/mqtt")
            v2_result = console.request("GET", "/api/mqtt/rdf-node")

        self.assertEqual(_decode_json(self, v1_result, "shared v1 monitor snapshot"), v1_snapshot)
        self.assertEqual(_decode_json(self, v2_result, "shared v2 monitor snapshot"), v2_snapshot)

    def test_legacy_rdf_node_profile_is_ignored_and_dropped_on_save(self) -> None:
        profile = {
            "enabled": True,
            "host": "127.0.0.1",
            "port": 8883,
            "node_id": "uav-01",
            "username": "old-viewer",
            "password": "old-viewer-password",
            "ca_file": "/tmp/old-viewer-ca.pem",
        }
        headers = {"Content-Type": "application/json"}
        with ConsoleHTTPHarness(legacy_rdf_node_mqtt_config=profile) as console:
            update_result = console.request(
                "POST",
                "/api/console-config",
                json.dumps({"refresh_seconds": 5}).encode("utf-8"),
                headers,
            )
            config_result = console.request("GET", "/api/console-config")
            snapshot_result = console.request("GET", "/api/mqtt/rdf-node")
            saved_config = json.loads(
                Path(console.server.config_path).read_text(encoding="utf-8"),
            )

        public_config = _decode_json(self, config_result, "shared MQTT console config")
        snapshot = _decode_json(self, snapshot_result, "shared RDF Node v2 snapshot")
        self.assertEqual(update_result.status, 200)
        self.assertNotIn("rdf_node_mqtt", public_config)
        self.assertNotIn("rdf_node_mqtt", saved_config)
        self.assertNotIn(profile["password"], config_result.body.decode("utf-8"))
        self.assertFalse(snapshot["enabled"])
        self.assertEqual(snapshot["connection"], "disabled")
        self.assertEqual(snapshot["node_id"], "uav-01")

    def test_diagnostic_and_rdf_node_posts_are_not_publish_routes(self) -> None:
        paths = (
            "/api/mqtt/rdf-node",
            "/api/v2/angular/diagnostic/latest",
        )
        with ConsoleHTTPHarness() as console:
            results = [console.request("POST", path, b"{}") for path in paths]

        self.assertEqual([result.status for result in results], [404, 404])

    def test_mqtt_broker_password_is_private_and_only_cleared_explicitly(self) -> None:
        secret = "test-broker-password"
        json_headers = {"Content-Type": "application/json"}
        with ConsoleHTTPHarness() as console:
            saved = console.request(
                "POST",
                "/api/console-config",
                json.dumps({
                    "mqtt_host": "",
                    "mqtt_transport": "websockets",
                    "mqtt_ws_path": "/rdf-doa",
                    "mqtt_username": "admin",
                    "mqtt_password": secret,
                }).encode("utf-8"),
                json_headers,
            )
            readback = console.request("GET", "/api/console-config")
            config_path = Path(console.server.config_path)
            persisted = json.loads(config_path.read_text(encoding="utf-8"))
            mode = config_path.stat().st_mode & 0o777

            unrelated_update = console.request(
                "POST",
                "/api/console-config",
                json.dumps({"refresh_seconds": 5}).encode("utf-8"),
                json_headers,
            )
            preserved = console.request("GET", "/api/console-config")
            cleared = console.request(
                "POST",
                "/api/console-config",
                json.dumps({"clear_mqtt_password": True}).encode("utf-8"),
                json_headers,
            )
            after_clear = console.request("GET", "/api/console-config")
            cleared_password = json.loads(config_path.read_text(encoding="utf-8"))["mqtt_password"]

        self.assertEqual(saved.status, 200)
        self.assertEqual(readback.status, 200)
        saved_config = _decode_json(self, saved, "saved MQTT config")
        public_config = _decode_json(self, readback, "MQTT config readback")
        self.assertEqual(saved_config["mqtt_transport"], "websockets")
        self.assertEqual(public_config["mqtt_ws_path"], "/rdf-doa")
        self.assertTrue(public_config["mqtt_password_set"])
        self.assertNotIn("mqtt_password", saved_config)
        self.assertNotIn("mqtt_password", public_config)
        self.assertNotIn(secret, saved.body.decode("utf-8"))
        self.assertNotIn(secret, readback.body.decode("utf-8"))
        self.assertEqual(persisted["mqtt_password"], secret)
        self.assertEqual(mode, 0o600)
        self.assertEqual(unrelated_update.status, 200)
        self.assertTrue(_decode_json(self, preserved, "preserved MQTT config")["mqtt_password_set"])
        self.assertEqual(cleared.status, 200)
        self.assertFalse(_decode_json(self, after_clear, "cleared MQTT config")["mqtt_password_set"])
        self.assertEqual(cleared_password, "")
    def test_non_loopback_bind_is_refused(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ground-console-bind-test-") as temporary:
            root = Path(temporary)
            branding_path = root / "branding.json"
            config_path = root / "console.json"
            branding_path.write_text(
                json.dumps({"app_name": "Bind Test", "logo_data_url": ""}),
                encoding="utf-8",
            )
            config = {
                "version": 1,
                "base_url": BASE_URL,
                "mqtt_host": "",
                "mqtt_port": 1883,
                "refresh_seconds": 0,
            }
            for bind_host in ("0.0.0.0", "192.0.2.44", "::"):
                try:
                    server = _new_server(
                        bind_host=bind_host,
                        branding_path=branding_path,
                        config_path=config_path,
                        config=config,
                    )
                except ValueError:
                    continue
                except Exception as exc:
                    self.fail(
                        f"non-loopback bind {bind_host!r} raised {type(exc).__name__}, "
                        "not the explicit refusal ValueError"
                    )
                else:
                    server.server_close()
                    self.fail(f"non-loopback bind {bind_host!r} was accepted")


def main() -> int:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(GroundConsoleStaticRegressionTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if _static_index() is None:
        print(
            "STATIC BUILD REPORT: skipped static-serving checks because "
            f"{STATIC_ROOT / 'index.html'} is absent",
            flush=True,
        )
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
