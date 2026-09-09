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

    def __init__(self, bind_host: str = "127.0.0.1") -> None:
        self.bind_host = bind_host
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
        config_path.write_text(json.dumps(config), encoding="utf-8")

        self.server = _new_server(
            bind_host=self.bind_host,
            branding_path=branding_path,
            config_path=config_path,
            config=config,
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


class GroundConsoleStaticRegressionTests(unittest.TestCase):
    """Regression coverage for static files, API precedence, and bind safety."""

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
