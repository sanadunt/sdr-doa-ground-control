#!/usr/bin/env python3
"""Black-box regression tests for the Ground Console static web boundary.

The static checks use the checked-out ``frontend/dist`` build when it exists.
They are explicitly skipped (and reported) when that build is not available;
API and loopback-boundary checks still run so a missing build cannot make the
whole file vacuously green. A missing ``frontend/dist/receiver`` fails the
Receiver checks when ``frontend/dist`` exists and ``vendor/BrowSDR`` is checked
out, because ``npm run build`` alone deletes it.
"""

from __future__ import annotations

import http.client
import io
import inspect
import json
import os
import re
import sys
import tempfile
import tarfile
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
RECEIVER_SOURCE_ROOT = PROJECT_ROOT / "vendor" / "BrowSDR"
RECEIVER_REBUILD_HINT = (
    "rebuild with `npm run build:all` in frontend/, or run tools/build_browsdr_receiver.py "
    "after `npm run build`"
)
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
        frontend_dir: Optional[Path] = None,
    ) -> None:
        self.bind_host = bind_host
        self.frontend_dir = frontend_dir
        self._temporary: Optional[tempfile.TemporaryDirectory[str]] = None
        self.receiver_data_dir: Optional[Path] = None
        self.server: Any = None
        self.thread: Optional[threading.Thread] = None
        self.thread_error: Optional[BaseException] = None

    def __enter__(self) -> "ConsoleHTTPHarness":
        self._temporary = tempfile.TemporaryDirectory(prefix="ground-console-static-")
        root = Path(self._temporary.name)
        branding_path = root / "branding.json"
        config_path = root / "console.json"
        self.receiver_data_dir = root / "receiver-data"
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
        config_path.write_text(json.dumps(config), encoding="utf-8")

        self.server = _new_server(
            bind_host=self.bind_host,
            branding_path=branding_path,
            config_path=config_path,
            config=config,
            frontend_dir=self.frontend_dir,
            receiver_data_dir=self.receiver_data_dir,
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
            if method.upper() in {"POST", "DELETE"}:
                request_headers["Origin"] = f"http://127.0.0.1:{self.port}"
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
    receiver_data_dir: Optional[Path] = None,
    frontend_dir: Optional[Path] = None,
) -> Any:
    """Construct the current server with temporary local state."""

    server_type = _server_class()
    parameters = inspect.signature(server_type).parameters
    static_value = str(frontend_dir if frontend_dir is not None else STATIC_ROOT)
    values: Dict[str, Any] = {
        "mqtt_monitor": None,
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
        "receiver_data_dir": receiver_data_dir,
    }
    kwargs = {name: values[name] for name in parameters if name in values}

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


def _receiver_source_present() -> bool:
    # An uninitialized submodule is an empty directory.
    return (RECEIVER_SOURCE_ROOT / "package.json").is_file()


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

def _receiver_asset_references(index: Path) -> List[Tuple[str, Path]]:
    """Return same-origin Receiver assets linked by the built index."""

    document = index.read_text(encoding="utf-8")
    references: List[Tuple[str, Path]] = []
    seen: set[str] = set()
    pattern = re.compile(r"(?:src|href)\s*=\s*([\"'])(.*?)\1", re.IGNORECASE)
    receiver_root = (STATIC_ROOT / "receiver").resolve()
    for match in pattern.finditer(document):
        raw_reference = match.group(2)
        parsed = urlsplit(raw_reference)
        if not parsed.path.startswith("/receiver/"):
            continue
        relative = unquote(parsed.path[len("/receiver/"):])
        parts = relative.split("/")
        if any(not part or part.startswith(".") for part in parts):
            raise AssertionError(f"Receiver build contains an unsafe asset reference: {raw_reference!r}")
        expected = (STATIC_ROOT / "receiver").joinpath(*parts).resolve()
        try:
            expected.relative_to(receiver_root)
        except ValueError as exc:
            raise AssertionError(f"Receiver asset escapes its static root: {raw_reference!r}") from exc
        if not expected.is_file():
            raise AssertionError(f"Receiver index references missing asset: {raw_reference!r}")
        request_path = parsed.path
        if parsed.query:
            request_path += "?" + parsed.query
        if request_path not in seen:
            references.append((request_path, expected))
            seen.add(request_path)
    return references


_EXPECTED_MIMES: Dict[str, frozenset[str]] = {
    ".webmanifest": frozenset({"application/manifest+json"}),
    ".mp3": frozenset({"audio/mpeg"}),
    ".wav": frozenset({"audio/wav"}),
    ".ogg": frozenset({"audio/ogg"}),
    ".txt": frozenset({"text/plain"}),
    ".gz": frozenset({"application/gzip"}),
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


class GroundConsoleStaticRegressionTests(unittest.TestCase):
    """Regression coverage for static files, API precedence, and bind safety."""

    def test_v1_mqtt_defaults_to_ground_ip_websocket(self) -> None:
        config = ground_console._default_console_config()
        self.assertEqual(
            (config["mqtt_host"], config["mqtt_port"], config["mqtt_transport"]),
            ("10.90.0.1", 9001, "websockets"),
        )
        args = ground_console._build_parser().parse_args([])
        self.assertEqual(
            (args.mqtt_host, args.mqtt_port, args.mqtt_transport),
            ("10.90.0.1", 9001, "websockets"),
        )
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
        for host in (
            "10.90.0.1",
            "192.168.1.50",
            "8.8.8.8",
            "127.0.0.1",
            "2001:4860:4860::8888",
            "2001:db8::1",
            "::1",
            "localhost",
        ):
            with self.subTest(host=host):
                validated = ground_console._validate_console_config({**config, "mqtt_host": host})
                self.assertEqual(validated["mqtt_host"], host)
        for host in ("broker.example", "999.0.0.1", "[2001:db8::1]"):
            with self.subTest(host=host):
                with self.assertRaises(ValueError):
                    ground_console._validate_console_config({**config, "mqtt_host": host})

    def test_integer_config_fields_are_not_truncated_or_coerced(self) -> None:
        """AUD-41: a fractional, boolean or string port is rejected, not saved as int()."""
        config = ground_console._default_console_config()
        for field, value in (("mqtt_port", 1883), ("mqtt_port", 1883.0), ("refresh_seconds", 10), ("refresh_seconds", 0.0)):
            with self.subTest(field=field, value=value):
                validated = ground_console._validate_console_config({**config, field: value})
                self.assertEqual(validated[field], int(value))
                self.assertIs(type(validated[field]), int)
        rejected = (1883.9, 0.5, True, False, "1883", "1_883", " 1883", None, [1883], float("nan"), float("inf"))
        for field in ("mqtt_port", "refresh_seconds"):
            for value in rejected:
                with self.subTest(field=field, value=value):
                    with self.assertRaisesRegex(ValueError, f"{field} must be an integer"):
                        ground_console._validate_console_config({**config, field: value})

        warnings: list = []
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "console.json"
            path.write_text(json.dumps({**config, "mqtt_port": 1883.9, "refresh_seconds": 10}), encoding="utf-8")
            loaded = ground_console._load_console_config(path, log=warnings.append)
        self.assertEqual((loaded["mqtt_port"], loaded["refresh_seconds"]), (config["mqtt_port"], 10))
        self.assertTrue(any("mqtt_port" in message for message in warnings), warnings)

        with ConsoleHTTPHarness() as console:
            before = json.loads(console.request("GET", "/api/console-config").body)
            for body in ({"mqtt_port": 1883.9}, {"mqtt_port": True}, {"mqtt_port": "1884"}, {"refresh_seconds": True}, {"refresh_seconds": 2.5}):
                with self.subTest(body=body):
                    result = console.request(
                        "POST",
                        "/api/console-config",
                        json.dumps(body).encode("utf-8"),
                        {"Content-Type": "application/json"},
                    )
                    self.assertEqual(result.status, 400)
                    self.assertIn("must be an integer", json.loads(result.body)["error"])
            self.assertEqual(json.loads(console.request("GET", "/api/console-config").body), before)
            for port in ("1883.5", "1_883", "+1883", "0", "65536", "%E0%A5%A7"):
                with self.subTest(port=port):
                    result = console.request("POST", f"/api/mqtt/connect?host=127.0.0.1&port={port}")
                    self.assertEqual(result.status, 400)
                    self.assertIn("MQTT port must be an integer", json.loads(result.body)["error"])
            accepted = console.request(
                "POST",
                "/api/console-config",
                json.dumps({"mqtt_port": 1884, "refresh_seconds": 5}).encode("utf-8"),
                {"Content-Type": "application/json"},
            )
            self.assertEqual(accepted.status, 200)
            self.assertEqual(
                (json.loads(accepted.body)["mqtt_port"], json.loads(accepted.body)["refresh_seconds"]),
                (1884, 5),
            )

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
        # Basemap tiles come from the console's own /api/tiles route, so the
        # page may contact no remote host at all.
        self.assertIn("connect-src 'self';", csp)
        self.assertIn("img-src 'self' data: blob:;", csp)
        self.assertNotRegex(csp, r"https?://|\*", "the main app CSP lists no remote or wildcard source")
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

    def test_built_page_links_its_own_favicons_and_they_are_served(self) -> None:
        index = self._require_static_build()
        html = index.read_text(encoding="utf-8")
        links = re.findall(r"<link\b[^>]*\brel=\"icon\"[^>]*>", html)
        hrefs = sorted(re.search(r'href="([^"]+)"', link).group(1) for link in links)
        # Without a declared icon the browser asks for /favicon.ico on every load.
        self.assertEqual(hrefs, ["/favicon.ico", "/favicon.svg"])
        with ConsoleHTTPHarness() as console:
            results = {href: console.request("GET", href) for href in hrefs}
        for href, mime in (("/favicon.ico", "image/x-icon"), ("/favicon.svg", "image/svg+xml")):
            with self.subTest(href=href):
                result = results[href]
                self.assertEqual(result.status, 200, href)
                self.assertEqual(_content_type(result), mime)
                self.assertEqual(result.body, (STATIC_ROOT / href.lstrip("/")).read_bytes())
                self.assertNotRegex(result.headers.get("content-security-policy", ""), r"https?://|\*")
        self.assertEqual(results["/favicon.ico"].body[:4], b"\x00\x00\x01\x00", "favicon.ico must be an ICO file")

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
        # The console has one publish path (the admin-gated config patch), so
        # it no longer claims to be read-only. It still never POSTs to the
        # Raspberry or applies settings itself.
        self.assertFalse(capabilities["read_only"])
        self.assertTrue(capabilities["mqtt_publish"])
        self.assertFalse(capabilities["remote_post"])
        self.assertFalse(capabilities["config_apply"])
        self.assertFalse(capabilities["mqtt_monitor"])
        self.assertTrue(capabilities["admin_branding"])
        self.assertTrue(capabilities["admin_auth_required"])
        self.assertIsInstance(capabilities["config_allowlist"], list)
        # ADMIN_PASSWORD is forced to None above, so login is off and the
        # default-password warning does not apply.
        self.assertIs(capabilities["admin_enabled"], False)
        self.assertIs(capabilities["admin_default_password"], False)
        config_patch = capabilities["config_patch"]
        self.assertIs(config_patch["enabled"], False, "no MQTT monitor means no publish path")
        self.assertIs(config_patch["requires_admin"], True)
        self.assertEqual(config_patch["topic"], "sdr/v1/uav-01/cmd/config/patch")
        self.assertEqual((config_patch["qos"], config_patch["ttl_ms"]), (1, 60_000))
        self.assertEqual(config_patch["ranges"]["center_frequency_hz"], [24_000_000, 1_800_000_000])

        self.assertEqual(config_result.status, 200)
        config = _decode_json(self, config_result, "console config")
        self.assertEqual(config["version"], 1)
        self.assertEqual(config["base_url"], BASE_URL)
        self.assertEqual(config["mqtt_host"], "")
        self.assertEqual(config["mqtt_port"], 1883)
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

    def test_receiver_mutations_require_same_loopback_origin(self) -> None:
        with ConsoleHTTPHarness() as console:
            rejected_create = console.request(
                "POST",
                "/api/receiver/audio-sessions",
                headers={"Origin": "https://attacker.invalid"},
            )
            self.assertEqual(rejected_create.status, 403)
            self.assertEqual(console.server.receiver_store.list_records()["total"], 0)

            rejected_missing_origin = console.request(
                "POST",
                "/api/receiver/audio-sessions",
                headers={"Origin": ""},
            )
            self.assertEqual(rejected_missing_origin.status, 403)
            self.assertEqual(console.server.receiver_store.list_records()["total"], 0)

            marker = console.server.receiver_store.save_markers({
                "name": "Protected marker",
                "markers": [{"frequency_hz": 1_070_000, "power_db": None}],
            })
            rejected_delete = console.request(
                "DELETE",
                f"/api/receiver/marker-sets/{marker['id']}",
                headers={"Origin": "https://attacker.invalid"},
            )
            self.assertEqual(rejected_delete.status, 403)
            marker_sets = _decode_json(self, console.request("GET", "/api/receiver/marker-sets"), "protected marker set")
            self.assertEqual([item["id"] for item in marker_sets["items"]], [marker["id"]])

    def test_receiver_records_routes_page_markers_and_delete_archives(self) -> None:
        json_headers = {"Content-Type": "application/json"}

        def post_json(console: ConsoleHTTPHarness, path: str, payload: Any) -> HTTPResult:
            return console.request("POST", path, json.dumps(payload).encode("utf-8"), json_headers)

        with ConsoleHTTPHarness() as console:
            settings = _decode_json(self, console.request("GET", "/api/receiver/settings"), "Receiver settings")
            self.assertFalse(settings["auto_spectrum_recording"])
            saved_settings = _decode_json(
                self,
                post_json(console, "/api/receiver/settings", {"auto_spectrum_recording": True}),
                "saved Receiver settings",
            )
            self.assertTrue(saved_settings["auto_spectrum_recording"])
            self.assertEqual(console.server.receiver_store.data_dir, console.receiver_data_dir.resolve())
            malformed = console.request(
                "POST",
                "/api/receiver/settings",
                b"{",
                {"Content-Type": "application/json"},
            )
            self.assertEqual(malformed.status, 400)
            self.assertEqual(set(_decode_json(self, malformed, "malformed JSON")), {"error"})
            oversized = console.request(
                "POST",
                "/api/receiver/settings",
                b" " * 4097,
                {"Content-Type": "application/json"},
            )
            self.assertEqual(oversized.status, 400)
            self.assertEqual(set(_decode_json(self, oversized, "oversized JSON")), {"error"})

            marker = _decode_json(
                self,
                post_json(console, "/api/receiver/marker-sets", {
                    "name": "Local markers",
                    "markers": [{"frequency_hz": 1_070_000, "power_db": None, "label": "beacon"}],
                }),
                "saved marker set",
            )
            marker_sets = _decode_json(self, console.request("GET", "/api/receiver/marker-sets"), "marker sets")
            self.assertEqual([item["id"] for item in marker_sets["items"]], [marker["id"]])
            self.assertEqual(marker_sets["items"][0]["markers"][0]["label"], "beacon")

            scan = _decode_json(
                self,
                post_json(console, "/api/receiver/scans", {
                    "source": "manual",
                    "config": {"startHz": 1_000_000, "endHz": 2_000_000, "fftSize": 4096},
                    "archive": True,
                }),
                "created Receiver scan",
            )
            candidate = {
                "id": 1,
                "startHz": 1_000_000,
                "endHz": 1_020_000,
                "centerHz": 1_010_000,
                "peakFrequencyHz": 1_010_000,
                "meanPeakFrequencyHz": 1_010_000,
                "minPeakFrequencyHz": 1_000_000,
                "maxPeakFrequencyHz": 1_020_000,
                "bandwidthHz": 20_000,
                "peakDb": -50,
                "noiseFloorDb": -90,
                "snrDb": 40,
                "firstSeen": 1,
                "lastSeen": 2,
                "hits": 2,
            }
            candidates_path = f"/api/receiver/scans/{scan['id']}/candidates"
            self.assertEqual(post_json(console, candidates_path, {"candidates": [candidate]}).status, 200)
            filtered = _decode_json(
                self,
                post_json(console, candidates_path + "/query", {
                    "offset": 0,
                    "limit": 25,
                    "sort": "frequency",
                    "minimum_peak_db": -60,
                    "marked_only": True,
                    "marker_frequencies": [1_070_000],
                }),
                "marked candidate page",
            )
            self.assertEqual(filtered["total"], 1)
            self.assertEqual([row["id"] for row in filtered["items"]], [1])
            empty = _decode_json(
                self,
                post_json(console, candidates_path + "/query", {
                    "offset": 0,
                    "limit": 25,
                    "sort": "frequency",
                    "minimum_peak_db": -60,
                    "marked_only": True,
                    "marker_frequencies": [],
                }),
                "empty marker filter",
            )
            self.assertEqual(empty["total"], 0)

            # Grouping is by band overlap, so this band starts inside the first one.
            adjacent = {
                **candidate,
                "id": 2,
                "startHz": 1_015_000,
                "endHz": 1_060_000,
                "centerHz": 1_050_000,
                "peakFrequencyHz": 1_050_000,
                "meanPeakFrequencyHz": 1_050_000,
                "minPeakFrequencyHz": 1_040_000,
                "maxPeakFrequencyHz": 1_060_000,
            }
            self.assertEqual(post_json(console, candidates_path, {"candidates": [adjacent]}).status, 200)
            grouped_post = _decode_json(
                self,
                post_json(console, candidates_path + "/query", {
                    "offset": 0,
                    "limit": 25,
                    "sort": "frequency",
                    "group_adjacent": True,
                }),
                "grouped candidate page",
            )
            self.assertEqual(grouped_post["total"], 1)
            self.assertEqual(grouped_post["items"][0]["peakRangeCenterHz"], 1_030_000)
            grouped_get = _decode_json(
                self,
                console.request("GET", candidates_path + "?group_adjacent=true&limit=25"),
                "grouped candidate query",
            )
            self.assertEqual(grouped_get["total"], 1)
            self.assertEqual(grouped_get["items"][0]["peakRangeCenterHz"], 1_030_000)

            trace = bytes(range(256)) * 8
            trace_path = f"/api/receiver/scans/{scan['id']}/trace?sweep=1"
            oversized_trace = console.request(
                "POST",
                trace_path,
                b"x" * 2049,
                {"Content-Type": "application/octet-stream"},
            )
            self.assertEqual(oversized_trace.status, 400)
            self.assertEqual(set(_decode_json(self, oversized_trace, "oversized trace")), {"error"})
            self.assertEqual(
                console.request("POST", trace_path, trace, {"Content-Type": "application/octet-stream"}).status,
                200,
            )
            archived_trace = console.request("GET", trace_path)
            self.assertEqual(archived_trace.status, 200)
            self.assertEqual(archived_trace.body, trace)
            self.assertEqual(
                post_json(console, f"/api/receiver/scans/{scan['id']}/finish", {"status": "complete"}).status,
                200,
            )
            records = _decode_json(self, console.request("GET", "/api/receiver/records"), "Receiver records")
            scans = _decode_json(
                self,
                console.request("GET", "/api/receiver/records?type=scan&offset=0&limit=1"),
                "spectrum scan records",
            )
            self.assertEqual(scans["total"], 1)
            self.assertEqual([item["type"] for item in scans["items"]], ["scan"])
            audio_sessions = _decode_json(
                self,
                console.request("GET", "/api/receiver/records?type=audio-session"),
                "VFO audio records",
            )
            self.assertEqual(audio_sessions["total"], 0)
            invalid_type = console.request("GET", "/api/receiver/records?type=other")
            self.assertEqual(invalid_type.status, 400)
            self.assertEqual(set(_decode_json(self, invalid_type, "invalid record type")), {"error"})
            self.assertEqual(records["items"][0]["candidate_count"], 2)
            self.assertEqual(records["items"][0]["trace_count"], 1)
            self.assertEqual(
                _decode_json(self, console.request("DELETE", f"/api/receiver/records/{scan['id']}"), "record deletion"),
                {"deleted": True},
            )
            self.assertEqual(
                _decode_json(self, console.request("GET", "/api/receiver/records"), "records after deletion")["total"],
                0,
            )
            missing_scan = console.request(
                "GET",
                "/api/receiver/scans/00000000-0000-0000-0000-000000000000",
            )
            self.assertEqual(missing_scan.status, 404)
            self.assertEqual(set(_decode_json(self, missing_scan, "missing scan")), {"error"})
            invalid_scan = console.request("GET", "/api/receiver/scans/not-a-uuid")
            self.assertEqual(invalid_scan.status, 400)
            self.assertEqual(set(_decode_json(self, invalid_scan, "invalid scan ID")), {"error"})

    def test_receiver_audio_routes_stream_completed_files_and_expose_failures(self) -> None:
        json_headers = {"Content-Type": "application/json"}

        def post_json(console: ConsoleHTTPHarness, path: str, payload: Any) -> HTTPResult:
            return console.request("POST", path, json.dumps(payload).encode("utf-8"), json_headers)

        metadata = {
            "vfo_index": 0,
            "frequency_hz": 144_500_000,
            "mode": "nfm",
            "bandwidth_hz": 12_500,
            "codec": "audio/webm;codecs=opus",
            "started_at": "2026-09-29T00:00:00Z",
        }
        with ConsoleHTTPHarness() as console:
            session = _decode_json(self, post_json(console, "/api/receiver/audio-sessions", {}), "audio session")
            segment = _decode_json(
                self,
                post_json(console, f"/api/receiver/audio-sessions/{session['id']}/segments", metadata),
                "audio segment",
            )
            audio = b"independent VFO audio file"
            self.assertEqual(
                console.request("POST", f"/api/receiver/audio-segments/{segment['id']}/chunk", audio).status,
                200,
            )
            self.assertEqual(
                post_json(console, f"/api/receiver/audio-segments/{segment['id']}/finish", {
                    "ended_at": "2026-09-29T00:00:03Z",
                    "duration_seconds": 3,
                    "status": "complete",
                }).status,
                200,
            )
            self.assertEqual(post_json(console, f"/api/receiver/audio-sessions/{session['id']}/finish", {}).status, 200)
            records = _decode_json(self, console.request("GET", "/api/receiver/records"), "audio records")
            audio_sessions = _decode_json(
                self,
                console.request("GET", "/api/receiver/records?type=audio-session"),
                "filtered audio records",
            )
            self.assertEqual(audio_sessions["total"], 1)
            self.assertEqual([item["type"] for item in audio_sessions["items"]], ["audio-session"])
            scans = _decode_json(self, console.request("GET", "/api/receiver/records?type=scan"), "filtered spectrum records")
            self.assertEqual(scans["total"], 0)
            self.assertEqual(records["total"], 1)
            saved_segment = records["items"][0]["segments"][0]
            self.assertEqual(saved_segment["status"], "complete")
            self.assertEqual(saved_segment["frequency_hz"], metadata["frequency_hz"])
            playback = console.request("GET", f"/api/receiver/audio-segments/{segment['id']}/audio")
            self.assertEqual(playback.status, 200)
            self.assertEqual(playback.headers["content-type"], "audio/webm")
            self.assertEqual(playback.body, audio)
            partial = console.request(
                "GET",
                f"/api/receiver/audio-segments/{segment['id']}/audio",
                headers={"Range": "bytes=0-4"},
            )
            self.assertEqual(partial.status, 206)
            self.assertEqual(partial.headers["content-range"], f"bytes 0-4/{len(audio)}")
            self.assertEqual(partial.body, audio[:5])
            unsatisfiable = console.request(
                "GET",
                f"/api/receiver/audio-segments/{segment['id']}/audio",
                headers={"Range": f"bytes={len(audio)}-"},
            )
            self.assertEqual(unsatisfiable.status, 416)
            self.assertEqual(unsatisfiable.headers["content-range"], f"bytes */{len(audio)}")

            failed_session = _decode_json(self, post_json(console, "/api/receiver/audio-sessions", {}), "failed audio session")
            failed_segment = _decode_json(
                self,
                post_json(console, f"/api/receiver/audio-sessions/{failed_session['id']}/segments", metadata),
                "failed audio segment",
            )
            self.assertEqual(
                post_json(console, f"/api/receiver/audio-segments/{failed_segment['id']}/finish", {
                    "ended_at": "2026-09-29T00:00:00Z",
                    "duration_seconds": 0,
                    "status": "failed",
                    "error": "Unsupported MediaRecorder codec",
                }).status,
                200,
            )
            self.assertEqual(post_json(console, f"/api/receiver/audio-sessions/{failed_session['id']}/finish", {}).status, 200)
            records = _decode_json(self, console.request("GET", "/api/receiver/records"), "audio records with failure")
            failed = next(item for item in records["items"] if item["id"] == failed_session["id"])
            self.assertEqual(failed["segments"][0]["status"], "failed")
            self.assertEqual(failed["segments"][0]["error"], "Unsupported MediaRecorder codec")
            self.assertEqual(console.request("GET", f"/api/receiver/audio-segments/{failed_segment['id']}/audio").status, 404)
            self.assertEqual(console.request("DELETE", f"/api/receiver/records/{session['id']}").status, 200)
            self.assertEqual(console.request("GET", f"/api/receiver/audio-segments/{segment['id']}/audio").status, 404)

    def test_receiver_audio_segment_delete_preserves_siblings_and_rejects_active_segment(self) -> None:
        json_headers = {"Content-Type": "application/json"}

        def post_json(console: ConsoleHTTPHarness, path: str, payload: Any) -> HTTPResult:
            return console.request("POST", path, json.dumps(payload).encode("utf-8"), json_headers)

        with ConsoleHTTPHarness() as console:
            session = _decode_json(self, post_json(console, "/api/receiver/audio-sessions", {}), "audio session")
            segments = []
            for index, frequency_hz in enumerate((144_500_000, 145_000_000)):
                metadata = {
                    "vfo_index": index,
                    "frequency_hz": frequency_hz,
                    "mode": "nfm",
                    "bandwidth_hz": 12_500,
                    "codec": "audio/webm;codecs=opus",
                    "started_at": f"2026-09-29T00:00:0{index}Z",
                }
                segment = _decode_json(
                    self,
                    post_json(console, f"/api/receiver/audio-sessions/{session['id']}/segments", metadata),
                    "audio segment",
                )
                if index == 0:
                    active_delete = console.request("DELETE", f"/api/receiver/audio-segments/{segment['id']}")
                    self.assertEqual(active_delete.status, 400)
                    self.assertEqual(set(_decode_json(self, active_delete, "active segment deletion")), {"error"})
                audio = f"segment {index}".encode("ascii")
                self.assertEqual(console.request("POST", f"/api/receiver/audio-segments/{segment['id']}/chunk", audio).status, 200)
                self.assertEqual(
                    post_json(console, f"/api/receiver/audio-segments/{segment['id']}/finish", {
                        "ended_at": f"2026-09-29T00:00:0{index + 2}Z",
                        "duration_seconds": 2,
                        "status": "complete",
                    }).status,
                    200,
                )
                segments.append((segment["id"], audio))
            self.assertEqual(post_json(console, f"/api/receiver/audio-sessions/{session['id']}/finish", {}).status, 200)

            deleted = console.request("DELETE", f"/api/receiver/audio-segments/{segments[0][0]}")
            self.assertEqual(deleted.status, 200)
            self.assertEqual(_decode_json(self, deleted, "audio segment deletion"), {"deleted": True})
            self.assertEqual(console.request("GET", f"/api/receiver/audio-segments/{segments[0][0]}/audio").status, 404)
            remaining_audio = console.request("GET", f"/api/receiver/audio-segments/{segments[1][0]}/audio")
            self.assertEqual(remaining_audio.status, 200)
            self.assertEqual(remaining_audio.body, segments[1][1])

            records = _decode_json(
                self,
                console.request("GET", "/api/receiver/records?type=audio-session"),
                "remaining audio session",
            )
            self.assertEqual(records["total"], 1)
            self.assertEqual(records["items"][0]["id"], session["id"])
            self.assertEqual([segment["id"] for segment in records["items"][0]["segments"]], [segments[1][0]])

    def test_receiver_audio_facets_and_record_filters_use_completed_segments(self) -> None:
        json_headers = {"Content-Type": "application/json"}

        def post_json(console: ConsoleHTTPHarness, path: str, payload: Any) -> HTTPResult:
            return console.request("POST", path, json.dumps(payload).encode("utf-8"), json_headers)

        with ConsoleHTTPHarness() as console:
            session = _decode_json(self, post_json(console, "/api/receiver/audio-sessions", {}), "audio session")
            segments = []
            for metadata in (
                {
                    "vfo_index": 0,
                    "frequency_hz": 144_500_000,
                    "mode": "nfm",
                    "bandwidth_hz": 12_500,
                    "started_at": "2026-09-29T06:30:00Z",
                },
                {
                    "vfo_index": 1,
                    "frequency_hz": 147_000_000,
                    "mode": "wfm",
                    "bandwidth_hz": 150_000,
                    "started_at": "2026-09-29T07:30:00Z",
                },
            ):
                segment = _decode_json(
                    self,
                    post_json(console, f"/api/receiver/audio-sessions/{session['id']}/segments", {
                        **metadata,
                        "codec": "audio/webm;codecs=opus",
                    }),
                    "audio segment",
                )
                self.assertEqual(console.request("POST", f"/api/receiver/audio-segments/{segment['id']}/chunk", b"x").status, 200)
                self.assertEqual(
                    post_json(console, f"/api/receiver/audio-segments/{segment['id']}/finish", {
                        "ended_at": "2026-09-29T12:00:01Z",
                        "duration_seconds": 1,
                        "status": "complete",
                    }).status,
                    200,
                )
                segments.append(segment)
            self.assertEqual(post_json(console, f"/api/receiver/audio-sessions/{session['id']}/finish", {}).status, 200)

            facets = _decode_json(
                self,
                console.request("GET", "/api/receiver/audio-facets?time_zone=America%2FLos_Angeles"),
                "audio filter facets",
            )
            self.assertEqual(facets["available_dates"], ["2026-09-28", "2026-09-29"])
            self.assertEqual(facets["vfo_indices"], [0, 1])
            self.assertEqual(facets["modes"], ["nfm", "wfm"])
            self.assertEqual(facets["bandwidths_hz"], [12_500, 150_000])
            self.assertEqual(facets["min_frequency_hz"], 144_500_000)
            self.assertEqual(facets["max_frequency_hz"], 147_000_000)

            filtered = _decode_json(
                self,
                console.request(
                    "GET",
                    "/api/receiver/records?type=audio-session&vfo_index=1&mode=WFM"
                    "&min_frequency_hz=146000000&max_frequency_hz=148000000"
                    "&time_zone=America%2FLos_Angeles&time_from=00%3A00&time_to=01%3A00",
                ),
                "filtered audio records",
            )
            self.assertEqual(filtered["total"], 1)
            self.assertEqual([segment["id"] for segment in filtered["items"][0]["segments"]], [segments[1]["id"]])

            self.assertEqual(console.request("DELETE", f"/api/receiver/audio-segments/{segments[0]['id']}").status, 200)
            refreshed = _decode_json(
                self,
                console.request("GET", "/api/receiver/audio-facets?time_zone=America%2FLos_Angeles"),
                "refreshed audio filter facets",
            )
            self.assertEqual(refreshed["available_dates"], ["2026-09-29"])
            self.assertEqual(refreshed["vfo_indices"], [1])
            invalid_timezone = console.request("GET", "/api/receiver/audio-facets?time_zone=Not%2FAZone")
            self.assertEqual(invalid_timezone.status, 400)
            self.assertEqual(set(_decode_json(self, invalid_timezone, "invalid time zone")), {"error"})

    def test_receiver_data_dir_cli_option(self) -> None:
        parsed = ground_console._build_parser().parse_args(["--data-dir", "/tmp/receiver-data"])
        self.assertEqual(parsed.data_dir, "/tmp/receiver-data")


    def _require_receiver_build(self) -> Path:
        """Return the built Receiver index; fail when a checkout should have one."""
        receiver_index = STATIC_ROOT / "receiver" / "index.html"
        if receiver_index.is_file():
            return receiver_index
        if _static_index() is not None and _receiver_source_present():
            self.fail(
                f"{receiver_index} is missing although frontend/dist exists and vendor/BrowSDR is "
                f"checked out. `npm run build` empties frontend/dist; {RECEIVER_REBUILD_HINT}."
            )
        self.skipTest(
            "embedded BrowSDR receiver is absent and vendor/BrowSDR is not checked out; "
            "run `git submodule update --init --recursive`, then " + RECEIVER_REBUILD_HINT
        )

    def test_receiver_bundle_is_built_alongside_the_console(self) -> None:
        self._require_receiver_build()

    def test_missing_receiver_bundle_fails_instead_of_skipping(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            dist = Path(temporary) / "dist"
            dist.mkdir()
            (dist / "index.html").write_text("<!doctype html>\n", encoding="utf-8")
            vendor = Path(temporary) / "BrowSDR"
            vendor.mkdir()
            with mock.patch.dict(globals(), {"STATIC_ROOT": dist, "RECEIVER_SOURCE_ROOT": vendor}):
                with self.assertRaises(unittest.SkipTest):
                    self._require_receiver_build()

                (vendor / "package.json").write_text("{}\n", encoding="utf-8")
                with self.assertRaises(self.failureException) as missing:
                    self._require_receiver_build()
                self.assertIn("npm run build:all", str(missing.exception))
                self.assertIn("build_browsdr_receiver.py", str(missing.exception))

                (dist / "receiver").mkdir()
                (dist / "receiver" / "index.html").write_text("<!doctype html>\n", encoding="utf-8")
                self.assertEqual(self._require_receiver_build(), dist / "receiver" / "index.html")

    def test_receiver_is_same_origin_scoped_and_serves_source(self) -> None:
        receiver_index = self._require_receiver_build()

        receiver_root = receiver_index.parent
        receiver_manifest = receiver_root / "manifest.webmanifest"
        receiver_source = receiver_root / ground_console.BROWSDR_SOURCE_ARCHIVE
        self.assertTrue(receiver_manifest.is_file())
        self.assertTrue(receiver_source.is_file())

        with ConsoleHTTPHarness() as console:
            root_result = console.request("GET", "/receiver/")
            short_result = console.request("GET", "/receiver")
            manifest_result = console.request("GET", "/receiver/manifest.webmanifest")
            source_result = console.request("GET", f"/receiver/{ground_console.BROWSDR_SOURCE_ARCHIVE}")
            wasm_module_result = console.request("GET", "/receiver/hackrf-web/pkg/hackrf_web.js")
            wasm_binary_result = console.request("GET", "/receiver/hackrf-web/pkg/hackrf_web_bg.wasm")
            silence_result = console.request("GET", "/receiver/30-seconds-of-silence.mp3")
            icon_results = {
                size: console.request("GET", f"/receiver/icon-{size}.png")
                for size in (96, 192, 512)
            }
            references = _receiver_asset_references(receiver_index)
            for request_path, expected_file in references:
                expected_mimes = _EXPECTED_MIMES.get(expected_file.suffix.lower())
                self.assertIsNotNone(
                    expected_mimes,
                    f"add an explicit MIME expectation for Receiver asset {expected_file.name!r}",
                )
                if expected_mimes is None:
                    raise AssertionError(f"no MIME expectation for Receiver asset {expected_file.name!r}")
                asset_result = console.request("GET", request_path)
                self.assertEqual(asset_result.status, 200, request_path)
                self.assertIn(_content_type(asset_result), expected_mimes, request_path)

        self.assertEqual(root_result.status, 200)
        self.assertEqual(short_result.status, 200)
        self.assertEqual(_content_type(root_result), "text/html")
        self.assertEqual(root_result.headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(root_result.headers.get("permissions-policy"), "usb=(self), autoplay=(self)")
        receiver_csp = root_result.headers.get("content-security-policy", "")
        self.assertIn("frame-ancestors 'self'", receiver_csp)
        self.assertIn("script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net", receiver_csp)
        self.assertIn("connect-src 'self' https://cdn.jsdelivr.net", receiver_csp)
        self.assertIn("https://*.huggingface.co", receiver_csp)
        self.assertIn("https://*.hf.co", receiver_csp)
        self.assertNotIn("peerjs.com", receiver_csp)
        self.assertTrue(references, "Receiver index must link to same-origin built assets")
        self.assertEqual(manifest_result.status, 200)
        self.assertEqual(_content_type(manifest_result), "application/manifest+json")
        manifest = json.loads(manifest_result.body.decode("utf-8"))
        self.assertEqual(manifest.get("start_url"), "/receiver/")
        self.assertEqual(manifest.get("scope"), "/receiver/")
        self.assertEqual(wasm_module_result.status, 200)
        self.assertEqual(_content_type(wasm_module_result), "text/javascript")
        self.assertEqual(wasm_binary_result.status, 200)
        self.assertEqual(_content_type(wasm_binary_result), "application/wasm")
        self.assertEqual(silence_result.status, 200)
        self.assertEqual(_content_type(silence_result), "audio/mpeg")
        for size, result in icon_results.items():
            with self.subTest(icon_size=size):
                self.assertEqual(result.status, 200)
                self.assertEqual(_content_type(result), "image/png")
                self.assertEqual(result.body, (receiver_root / f"icon-{size}.png").read_bytes())
        self.assertEqual(source_result.status, 200)
        self.assertEqual(_content_type(source_result), "application/gzip")
        self.assertEqual(
            source_result.headers.get("content-disposition"),
            f'attachment; filename="{ground_console.BROWSDR_SOURCE_ARCHIVE}"',
        )
        with tarfile.open(fileobj=io.BytesIO(source_result.body), mode="r:gz") as archive:
            source_names = set(archive.getnames())
        self.assertIn("BrowSDR/LICENSE", source_names)
        self.assertIn("BrowSDR/src/client/index.html", source_names)

    def test_receiver_static_boundary_blocks_traversal_and_unknown_extensions(self) -> None:
        self._require_receiver_build()
        blocked_paths = (
            "/receiver/../.env",
            "/receiver/%2e%2e/.env",
            "/receiver/%2e%2e/index.html",
            "/receiver/.env",
            "/receiver%2f..%2f.env",
            "/receiver/not-in-build.unknown-extension",
        )
        with ConsoleHTTPHarness() as console:
            for path in blocked_paths:
                result = console.request("GET", path)
                with self.subTest(path=path):
                    self.assertEqual(result.status, 404, path)
    def test_receiver_fixture_static_serving_uses_receiver_policy(self) -> None:
        with tempfile.TemporaryDirectory(prefix="receiver-static-fixture-") as temporary:
            root = Path(temporary)
            (root / "assets").mkdir()
            receiver_assets = root / "receiver" / "assets"
            receiver_assets.mkdir(parents=True)
            ground_html = b"<!doctype html><main>ground fixture</main>"
            receiver_html = (
                b'<!doctype html><script type="module" '
                b'src="/receiver/assets/receiver.mjs"></script>'
            )
            receiver_module = b"export const receiverFixture = true;"
            source_archive = b"receiver source archive"
            (root / "index.html").write_bytes(ground_html)
            (root / "assets" / "console.js").write_bytes(b"window.consoleFixture = true;")
            (root / "assets" / "receiver.mjs").write_bytes(receiver_module)
            (root / "receiver" / "index.html").write_bytes(receiver_html)
            (receiver_assets / "receiver.mjs").write_bytes(receiver_module)
            (root / "receiver" / "freq-spectrum-source.tar.gz").write_bytes(source_archive)

            with ConsoleHTTPHarness(frontend_dir=root) as console:
                ground = console.request("GET", "/")
                receiver = console.request("GET", "/receiver")
                receiver_slash = console.request("GET", "/receiver/")
                asset = console.request("GET", "/receiver/assets/receiver.mjs")
                root_mjs = console.request("GET", "/assets/receiver.mjs")
                archive = console.request("GET", "/receiver/freq-spectrum-source.tar.gz")

        self.assertEqual(ground.status, 200)
        self.assertEqual(ground.body, ground_html)
        self.assertEqual(
            ground.headers.get("content-security-policy"),
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; "
            "connect-src 'self'; "
            "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        )
        self.assertNotIn("permissions-policy", ground.headers)
        self.assertEqual(receiver.status, 200)
        self.assertEqual(receiver.body, receiver_html)
        self.assertEqual(receiver_slash.status, 200)
        self.assertEqual(receiver_slash.body, receiver_html)
        self.assertEqual(receiver.headers.get("content-type"), "text/html; charset=utf-8")
        self.assertEqual(receiver.headers.get("permissions-policy"), "usb=(self), autoplay=(self)")
        receiver_csp = receiver.headers.get("content-security-policy", "")
        self.assertIn("script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net", receiver_csp)
        self.assertIn("connect-src 'self' https://cdn.jsdelivr.net", receiver_csp)
        self.assertEqual(asset.status, 200)
        self.assertEqual(root_mjs.status, 404)
        self.assertEqual(asset.headers.get("content-type"), "text/javascript; charset=utf-8")
        self.assertEqual(asset.body, receiver_module)
        self.assertEqual(archive.status, 200)
        self.assertEqual(archive.headers.get("content-type"), "application/gzip")
        self.assertEqual(archive.headers.get("content-disposition"), 'attachment; filename="freq-spectrum-source.tar.gz"')
        self.assertEqual(archive.body, source_archive)

    def test_receiver_fixture_static_boundary_rejects_escape_paths(self) -> None:
        with tempfile.TemporaryDirectory(prefix="receiver-static-boundary-") as temporary:
            root = Path(temporary)
            (root / "index.html").write_text("<!doctype html>ground", encoding="utf-8")
            (root / "assets").mkdir()
            (root / "assets" / "ground.js").write_text("window.ground = true;", encoding="utf-8")
            receiver_root = root / "receiver"
            receiver_assets = receiver_root / "assets"
            receiver_assets.mkdir(parents=True)
            (receiver_root / "index.html").write_text("<!doctype html>receiver", encoding="utf-8")
            (receiver_assets / "valid.mjs").write_text("export default true;", encoding="utf-8")
            (receiver_assets / ".hidden.mjs").write_text("export default false;", encoding="utf-8")
            outside = root / "outside.mjs"
            outside.write_text("export default 'outside';", encoding="utf-8")
            (receiver_assets / "linked.mjs").symlink_to(outside)

            with ConsoleHTTPHarness(frontend_dir=root) as console:
                valid = console.request("GET", "/receiver/assets/valid.mjs")
                blocked_paths = (
                    "/receiver/../assets/ground.js",
                    "/receiver/%2e%2e/.env",
                    "/receiver/assets%2f..%2fground.js",
                    "/receiver/.private/index.html",
                    "/receiver/assets/.hidden.mjs",
                    "/receiver/assets/linked.mjs",
                    "/receiver/assets/not-supported.bin",
                )
                blocked = [(path, console.request("GET", path)) for path in blocked_paths]

        self.assertEqual(valid.status, 200)
        for path, result in blocked:
            with self.subTest(path=path):
                self.assertEqual(result.status, 404, path)
    def test_root_favicons_are_served_and_the_receiver_keeps_its_own(self) -> None:
        with tempfile.TemporaryDirectory(prefix="favicon-static-fixture-") as temporary:
            root = Path(temporary)
            (root / "assets").mkdir()
            (root / "receiver").mkdir()
            console_ico = b"\x00\x00\x01\x00console"
            console_svg = b'<svg xmlns="http://www.w3.org/2000/svg"/>'
            receiver_ico = b"\x00\x00\x01\x00receiver"
            (root / "index.html").write_text("<!doctype html>ground", encoding="utf-8")
            (root / "favicon.ico").write_bytes(console_ico)
            (root / "favicon.svg").write_bytes(console_svg)
            (root / "favicon.png").write_bytes(b"png")
            (root / "robots.svg").write_bytes(console_svg)
            (root / "receiver" / "index.html").write_text("<!doctype html>receiver", encoding="utf-8")
            (root / "receiver" / "favicon.ico").write_bytes(receiver_ico)

            with ConsoleHTTPHarness(frontend_dir=root) as console:
                ico = console.request("GET", "/favicon.ico")
                svg = console.request("GET", "/favicon.svg")
                receiver = console.request("GET", "/receiver/favicon.ico")
                others = [(path, console.request("GET", path)) for path in ("/favicon.png", "/robots.svg", "/FAVICON.ICO", "/assets/../favicon.ico")]

        self.assertEqual(ico.status, 200)
        self.assertEqual(ico.headers.get("content-type"), "image/x-icon")
        self.assertEqual(ico.body, console_ico)
        self.assertEqual(svg.status, 200)
        self.assertEqual(svg.headers.get("content-type"), "image/svg+xml")
        self.assertEqual(svg.body, console_svg)
        # The console icons carry the console's own CSP, unchanged.
        for result in (ico, svg):
            self.assertEqual(
                result.headers.get("content-security-policy"),
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data: blob:; "
                "connect-src 'self'; "
                "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            )
        self.assertEqual(receiver.status, 200)
        self.assertEqual(receiver.body, receiver_ico)
        self.assertEqual(receiver.headers.get("permissions-policy"), "usb=(self), autoplay=(self)")
        # Only the two named icons join index.html at the root.
        for path, result in others:
            with self.subTest(path=path):
                self.assertEqual(result.status, 404, path)

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
    elif not (STATIC_ROOT / "receiver" / "index.html").is_file():
        state = "FAILED" if _receiver_source_present() else "skipped (vendor/BrowSDR not checked out)"
        print(f"STATIC BUILD REPORT: Receiver checks {state}: frontend/dist/receiver is absent; {RECEIVER_REBUILD_HINT}", flush=True)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
