#!/usr/bin/env python3
"""Server-side preferences, first-start seeding, /api/health and the version.

Covers tools/preferences_store.py, the /api/preferences routes (same-origin
loopback Origin, bounds, unknown keys), recovery from a corrupt preferences
file, console.json seeding from SDR_DOA_SEED_* (written once, validated),
--env-file, GET /api/health and the version in /api/capabilities. Every
server runs on loopback with temporary files; nothing outside the temporary
directory is read or written.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from unittest.mock import patch

TOOLS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = TOOLS_DIR.parent
for _path in (str(TOOLS_DIR), str(PROJECT_ROOT)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

# ground_console resolves its admin password at import time; give it a
# test-only value so the import never reads a local .env file.
_SAVED_ADMIN_PASSWORD = os.environ.get("SDR_DOA_ADMIN_PASSWORD")
os.environ["SDR_DOA_ADMIN_PASSWORD"] = "preferences-import-no-secret"
try:
    import ground_console  # noqa: E402
finally:
    if _SAVED_ADMIN_PASSWORD is None:
        os.environ.pop("SDR_DOA_ADMIN_PASSWORD", None)
    else:
        os.environ["SDR_DOA_ADMIN_PASSWORD"] = _SAVED_ADMIN_PASSWORD

import preferences_store  # noqa: E402
from preferences_store import (  # noqa: E402
    MAX_PREFERENCE_VALUE_BYTES,
    MAX_PREFERENCES_BYTES,
    PREFERENCE_KEYS,
    PreferencesRejected,
    PreferencesStore,
)

BASE_URL = "http://doasdr.local:8081"
PREFERENCE_STORE_TS = PROJECT_ROOT / "frontend" / "src" / "lib" / "preferenceStore.ts"
PANELS = json.dumps({"layers": True, "polar": False, "spectrum": True, "control": False, "nodeCollapsed": False})


class Logs:
    def __init__(self) -> None:
        self.lines: List[str] = []

    def __call__(self, message: str) -> None:
        self.lines.append(message)


class PreferencesStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-preferences-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / "preferences.json"
        self.logs = Logs()
        self.now = 1_000

    def store(self) -> PreferencesStore:
        return PreferencesStore(self.path, log=self.logs, clock_ms=lambda: self.now)

    def test_starts_empty_without_a_file(self) -> None:
        snapshot = self.store().snapshot()
        self.assertEqual(snapshot, {"version": 1, "updated_at_ms": None, "values": {}})
        self.assertFalse(self.path.exists())
        self.assertEqual(self.logs.lines, [])

    def test_update_merges_saves_and_reloads(self) -> None:
        store = self.store()
        first = store.update({"values": {"sdr-console-theme": "light", "sdr-console-overview-panels-v1": PANELS}})
        self.assertEqual(first["updated_at_ms"], 1_000)
        self.now = 2_000
        second = store.update({"values": {"sdr-console-lang": "id"}})
        self.assertEqual(second["values"], {
            "sdr-console-theme": "light",
            "sdr-console-overview-panels-v1": PANELS,
            "sdr-console-lang": "id",
        })
        self.assertEqual(second["updated_at_ms"], 2_000)
        on_disk = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(on_disk["version"], 1)
        self.assertEqual(on_disk["values"], second["values"])
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["preferences.json"], "no temporary file is left")
        reloaded = self.store().snapshot()
        self.assertEqual(reloaded, second)

    def test_null_removes_a_key(self) -> None:
        store = self.store()
        store.update({"values": {"sdr-console-theme": "light", "sdr-console-lang": "en"}})
        self.now = 1_500
        after = store.update({"values": {"sdr-console-theme": None}})
        self.assertEqual(after["values"], {"sdr-console-lang": "en"})

    def test_unchanged_update_does_not_write(self) -> None:
        store = self.store()
        store.update({"values": {"sdr-console-theme": "light"}})
        before = self.path.stat()
        self.now = 9_000
        snapshot = store.update({"values": {"sdr-console-theme": "light"}})
        self.assertEqual(snapshot["updated_at_ms"], 1_000, "an unchanged update keeps the stamp")
        after = self.path.stat()
        # An atomic replace would give the file a new inode.
        self.assertEqual((after.st_ino, after.st_mtime_ns), (before.st_ino, before.st_mtime_ns))
        other = PreferencesStore(self.root / "other.json", log=self.logs)
        other.update({"values": {"sdr-console-theme": None}})
        self.assertFalse((self.root / "other.json").exists(), "removing an absent key writes nothing")

    def test_updated_at_is_monotonic(self) -> None:
        store = self.store()
        store.update({"values": {"sdr-console-theme": "light"}})
        self.now = 10  # the wall clock stepped back
        snapshot = store.update({"values": {"sdr-console-theme": "dark"}})
        self.assertEqual(snapshot["updated_at_ms"], 1_001)

    def test_rejects_unknown_keys_and_bad_shapes_without_writing(self) -> None:
        store = self.store()
        cases: List[Tuple[Any, str]] = [
            ({"values": {"sdr-console-theme": "light", "not-a-preference": "x"}}, "PREFERENCE_KEY_UNKNOWN"),
            ({"values": {"browsdr-device-id": "abc"}}, "PREFERENCE_KEY_UNKNOWN"),
            ({"values": {"sdr-console-theme": 1}}, "PREFERENCE_VALUE_INVALID"),
            ({"values": {"sdr-console-theme": "light mode"}}, "PREFERENCE_VALUE_INVALID"),
            ({"values": {"sdr-console-theme": ""}}, "PREFERENCE_VALUE_INVALID"),
            ({"values": {"sdr-console-overview-panels-v1": "[1, 2]"}}, "PREFERENCE_VALUE_INVALID"),
            ({"values": {"sdr-console-overview-panels-v1": "{broken"}}, "PREFERENCE_VALUE_INVALID"),
            ({"values": {"sdr-doa-polar-view-v1": '{"head": NaN}'}}, "PREFERENCE_VALUE_INVALID"),
            ({"values": {"sdr-web-bookmarks": "{}"}}, "PREFERENCE_VALUE_INVALID"),
            ({"values": []}, "INVALID_REQUEST"),
            ({"values": {}, "extra": 1}, "INVALID_REQUEST"),
            ([], "INVALID_REQUEST"),
        ]
        for payload, code in cases:
            with self.subTest(payload=str(payload)[:80]):
                with self.assertRaises(PreferencesRejected) as raised:
                    store.update(payload)
                self.assertEqual(raised.exception.code, code)
                self.assertEqual(raised.exception.status, 400)
        self.assertFalse(self.path.exists())
        self.assertEqual(store.snapshot()["values"], {})

    def test_value_and_document_bounds(self) -> None:
        store = self.store()
        oversized = json.dumps(["x" * MAX_PREFERENCE_VALUE_BYTES])
        with self.assertRaises(PreferencesRejected) as raised:
            store.update({"values": {"sdr-web-bookmarks": oversized}})
        self.assertEqual((raised.exception.code, raised.exception.status), ("PREFERENCE_VALUE_TOO_LARGE", 413))
        # Several values each under the per-key bound, together over the total.
        near = MAX_PREFERENCE_VALUE_BYTES - 100
        big = {key: json.dumps({"pad": "y" * near}) for key in ("SDRSetting", "ReceiverSweepSettings", "sdr-doa-overlay-settings-v4", "sdr-doa-polar-view-v1")}
        big["sdr-web-bookmarks"] = json.dumps(["z" * near])
        self.assertGreater(sum(len(k) + len(v) for k, v in big.items()), MAX_PREFERENCES_BYTES)
        with self.assertRaises(PreferencesRejected) as raised:
            store.update({"values": big})
        self.assertEqual((raised.exception.code, raised.exception.status), ("PREFERENCES_TOO_LARGE", 413))
        self.assertFalse(self.path.exists())

    def test_corrupt_file_is_backed_up_and_the_store_starts_empty(self) -> None:
        raw = b'{"version": 1, "values": {"sdr-console-theme": "light"'
        self.path.write_bytes(raw)
        store = self.store()
        self.assertEqual(store.snapshot()["values"], {})
        backup = self.root / "preferences.json.invalid.bak"
        self.assertEqual(backup.read_bytes(), raw)
        self.assertTrue(any("not valid JSON" in line for line in self.logs.lines), self.logs.lines)
        # The next save replaces the corrupt file; the backup stays.
        store.update({"values": {"sdr-console-theme": "dark"}})
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["values"], {"sdr-console-theme": "dark"})
        self.assertEqual(backup.read_bytes(), raw)

    def test_other_unusable_files_start_empty(self) -> None:
        cases: Dict[str, bytes] = {
            "not an object": b"[1, 2, 3]",
            "no values": b'{"version": 1}',
            "not utf-8": b"\xff\xfe\x00{}",
            "oversized": b'{"values": {}, "pad": "' + b"x" * (preferences_store.MAX_PREFERENCES_FILE_BYTES + 10) + b'"}',
        }
        for label, raw in cases.items():
            with self.subTest(label):
                self.path.write_bytes(raw)
                (self.root / "preferences.json.invalid.bak").unlink(missing_ok=True)
                store = self.store()
                self.assertEqual(store.snapshot(), {"version": 1, "updated_at_ms": None, "values": {}})
                self.assertTrue((self.root / "preferences.json.invalid.bak").exists())

    def test_invalid_entries_are_dropped_and_valid_ones_kept(self) -> None:
        document = {
            "version": 1,
            "updated_at_ms": 5,
            "values": {
                "sdr-console-theme": "light",
                "sdr-console-lang": 7,
                "unknown-key": "x",
                "sdr-console-overview-panels-v1": PANELS,
            },
        }
        raw = json.dumps(document).encode("utf-8")
        self.path.write_bytes(raw)
        snapshot = self.store().snapshot()
        self.assertEqual(snapshot["values"], {"sdr-console-theme": "light", "sdr-console-overview-panels-v1": PANELS})
        self.assertEqual(snapshot["updated_at_ms"], 5)
        self.assertEqual((self.root / "preferences.json.invalid.bak").read_bytes(), raw)
        self.assertTrue(any("sdr-console-lang" in line and "unknown-key" in line for line in self.logs.lines), self.logs.lines)

    def test_unreadable_file_starts_empty(self) -> None:
        self.path.mkdir()
        store = self.store()
        self.assertEqual(store.snapshot()["values"], {})
        self.assertTrue(any("unreadable" in line for line in self.logs.lines), self.logs.lines)

    def test_keys_match_the_frontend_list(self) -> None:
        source = PREFERENCE_STORE_TS.read_text(encoding="utf-8")
        match = re.search(r"PREFERENCE_KEYS\s*=\s*\[(.*?)\]\s*as const", source, re.S)
        self.assertIsNotNone(match, "PREFERENCE_KEYS not found in preferenceStore.ts")
        frontend = re.findall(r"'([^']+)'", match.group(1))  # type: ignore[union-attr]
        self.assertEqual(len(frontend), len(set(frontend)))
        self.assertEqual(set(frontend), set(PREFERENCE_KEYS))

    def test_the_lan_view_gets_only_its_own_keys(self) -> None:
        self.assertLess(set(preferences_store.LAN_VIEW_PREFERENCE_KEYS), set(PREFERENCE_KEYS))
        for key in ("SDRSetting", "ReceiverSweepSettings", "sdr-web-bookmarks"):
            self.assertNotIn(key, preferences_store.LAN_VIEW_PREFERENCE_KEYS)
        store = self.store()
        store.update({"values": {"sdr-console-theme": "light", "sdr-web-bookmarks": "[]", "SDRSetting": "{}"}})
        lan_view = store.lan_view_snapshot()
        self.assertEqual(lan_view["values"], {"sdr-console-theme": "light"})
        self.assertEqual(lan_view["updated_at_ms"], store.snapshot()["updated_at_ms"])
        self.assertEqual(len(store.snapshot()["values"]), 3)

    def test_every_key_is_a_storage_key_in_the_sources(self) -> None:
        roots = [PROJECT_ROOT / "frontend" / "src", PROJECT_ROOT / "tools" / "browsdr_receiver_overlay" / "src"]
        texts = []
        for root in roots:
            for path in root.rglob("*"):
                if path.suffix not in {".ts", ".tsx", ".js"} or ".test." in path.name or path.name == "preferenceStore.ts":
                    continue
                texts.append(path.read_text(encoding="utf-8"))
        # The theme key lives in preferenceStore.ts; the Receiver's boot script reads it too.
        corpus = "\n".join(texts)
        for key in PREFERENCE_KEYS:
            with self.subTest(key):
                self.assertTrue(f"'{key}'" in corpus or f'"{key}"' in corpus, f"{key} is not used by any storage code")


class _Harness:
    """A GroundConsoleServer on loopback with temporary files."""

    def __init__(self, test: unittest.TestCase, root: Path, **kwargs: Any) -> None:
        self.server = ground_console.GroundConsoleServer(
            ("127.0.0.1", 0),
            BASE_URL,
            config_path=str(root / "console.json"),
            branding_path=str(root / "branding.json"),
            receiver_data_dir=root / "receiver",
            **kwargs,
        )
        self.port = self.server.server_address[1]
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()

        def close() -> None:
            self.server.shutdown()
            thread.join(timeout=5)
            self.server.server_close()

        test.addCleanup(close)

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        origin: Optional[str] = "same",
        raw: Optional[bytes] = None,
    ) -> Tuple[int, Any]:
        headers: Dict[str, str] = {}
        if origin == "same":
            headers["Origin"] = self.origin
        elif origin is not None:
            headers["Origin"] = origin
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode("utf-8"))
        if data is not None:
            headers["Content-Type"] = "application/json"
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, body=data, headers=headers)
            response = connection.getresponse()
            payload = response.read()
        finally:
            connection.close()
        try:
            decoded = json.loads(payload.decode("utf-8")) if payload else None
        except ValueError:
            decoded = payload
        return response.status, decoded


class PreferencesHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-preferences-http-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        quiet = patch.object(ground_console.ConsoleHandler, "log_message", lambda *_args: None)
        quiet.start()
        self.addCleanup(quiet.stop)

    def harness(self, **kwargs: Any) -> _Harness:
        return _Harness(self, self.root, **kwargs)

    def test_get_and_put_round_trip(self) -> None:
        console = self.harness(preferences_path=str(self.root / "prefs" / "preferences.json"))
        status, body = console.request("GET", "/api/preferences", origin=None)
        self.assertEqual((status, body), (200, {"version": 1, "updated_at_ms": None, "values": {}}))
        status, body = console.request("PUT", "/api/preferences", {"values": {"sdr-console-theme": "light"}})
        self.assertEqual(status, 200, body)
        self.assertIs(body["ok"], True)
        self.assertEqual(body["values"], {"sdr-console-theme": "light"})
        self.assertIsInstance(body["updated_at_ms"], int)
        status, body = console.request("POST", "/api/preferences", {"values": {"sdr-console-lang": "id"}})
        self.assertEqual(status, 200, body)
        status, body = console.request("GET", "/api/preferences", origin=None)
        self.assertEqual(body["values"], {"sdr-console-theme": "light", "sdr-console-lang": "id"})
        stored = json.loads((self.root / "prefs" / "preferences.json").read_text(encoding="utf-8"))
        self.assertEqual(stored["values"], body["values"])

    def test_default_path_sits_next_to_the_console_config(self) -> None:
        console = self.harness()
        self.assertEqual(console.server.preferences.path, self.root / "preferences.json")

    def test_writes_need_a_same_origin_loopback_origin(self) -> None:
        console = self.harness()
        bad_origins = [None, "http://evil.example", "null", f"http://localhost:{console.port}", f"http://127.0.0.1:{console.port + 1}", f"https://127.0.0.1:{console.port}"]
        for method in ("PUT", "POST"):
            for origin in bad_origins:
                with self.subTest(method=method, origin=origin):
                    status, body = console.request(method, "/api/preferences", {"values": {"sdr-console-theme": "light"}}, origin=origin)
                    self.assertEqual(status, 403)
                    self.assertEqual(body["code"], "ORIGIN_REJECTED")
        self.assertFalse((self.root / "preferences.json").exists())
        self.assertEqual(console.server.preferences.snapshot()["values"], {})

    def test_rejections_are_reported_with_codes(self) -> None:
        console = self.harness()
        cases = [
            ({"values": {"unknown": "x"}}, 400, "PREFERENCE_KEY_UNKNOWN"),
            ({"values": {"sdr-console-theme": "<script>"}}, 400, "PREFERENCE_VALUE_INVALID"),
            ({"theme": "light"}, 400, "INVALID_REQUEST"),
            ({"values": {"sdr-web-bookmarks": json.dumps(["x" * MAX_PREFERENCE_VALUE_BYTES])}}, 413, "PREFERENCE_VALUE_TOO_LARGE"),
        ]
        for body, expected_status, code in cases:
            with self.subTest(code=code):
                status, answer = console.request("PUT", "/api/preferences", body)
                self.assertEqual(status, expected_status, answer)
                self.assertEqual(answer["code"], code)
                self.assertIs(answer["ok"], False)
        status, answer = console.request("PUT", "/api/preferences", raw=b"{not json")
        self.assertEqual((status, answer["code"]), (400, "INVALID_REQUEST"))
        oversized = b'{"values": {}, "pad": "' + b"x" * (ground_console.MAX_PREFERENCES_REQUEST_BYTES + 1) + b'"}'
        status, answer = console.request("PUT", "/api/preferences", raw=oversized)
        self.assertEqual((status, answer["code"]), (400, "INVALID_REQUEST"))
        self.assertFalse((self.root / "preferences.json").exists())

    def test_write_failure_is_a_server_error(self) -> None:
        console = self.harness()
        with patch.object(preferences_store, "_write_atomic", side_effect=PermissionError("read-only")):
            status, body = console.request("PUT", "/api/preferences", {"values": {"sdr-console-theme": "light"}})
        self.assertEqual((status, body["code"]), (500, "PREFERENCES_WRITE_FAILED"))
        self.assertEqual(console.server.preferences.snapshot()["values"], {})

    def test_corrupt_file_does_not_stop_the_server(self) -> None:
        (self.root / "preferences.json").write_text("{", encoding="utf-8")
        with patch("builtins.print"):
            console = self.harness()
        status, body = console.request("GET", "/api/preferences", origin=None)
        self.assertEqual((status, body["values"]), (200, {}))
        self.assertTrue((self.root / "preferences.json.invalid.bak").exists())

    def test_unknown_put_path_is_not_found(self) -> None:
        console = self.harness()
        status, _ = console.request("PUT", "/api/console-config", {"values": {}})
        self.assertEqual(status, 404)

    def test_health_and_capabilities_report_the_version(self) -> None:
        console = self.harness()
        console.server.version = "2.0.0"
        status, body = console.request("GET", "/api/health", origin=None)
        self.assertEqual((status, body), (200, {
            "ok": True,
            "version": "2.0.0",
            "receiver_busy": False,
            "lan_access": {"enabled": False, "state": "closed", "reason": "DISABLED"},
        }))
        status, capabilities = console.request("GET", "/api/capabilities", origin=None)
        self.assertEqual(status, 200)
        self.assertEqual(capabilities["version"], "2.0.0")
        self.assertIs(capabilities["preferences"], True)

    def test_health_does_not_read_data_out(self) -> None:
        console = self.harness()
        with patch.object(ground_console.GroundConsoleServer, "collect_snapshot", side_effect=AssertionError("no Data Out read")):
            status, body = console.request("GET", "/api/health", origin=None)
        self.assertEqual(status, 200)
        self.assertIs(body["ok"], True)

    def test_health_reports_receiver_busy_while_it_records(self) -> None:
        console = self.harness()
        now = [1000.0]
        console.server.receiver_activity.clock = lambda: now[0]

        def busy() -> bool:
            status, body = console.request("GET", "/api/health", origin=None)
            self.assertEqual(status, 200)
            return body["receiver_busy"]

        self.assertIs(busy(), False)
        status, created = console.request("POST", "/api/receiver/audio-sessions", {})
        self.assertEqual(status, 201)
        self.assertIs(busy(), True)
        # An open session with a write in the stale window keeps it busy.
        now[0] += ground_console.RECEIVER_BUSY_WRITE_S + 1
        self.assertIs(busy(), True)
        now[0] += ground_console.RECEIVER_BUSY_OPEN_S
        self.assertIs(busy(), False, "an abandoned session does not hold updates back")
        status, _ = console.request("POST", f"/api/receiver/audio-sessions/{created['id']}/finish", {})
        self.assertEqual(status, 200)
        self.assertIs(busy(), True, "the finish is a write")
        now[0] += ground_console.RECEIVER_BUSY_WRITE_S + 1
        self.assertIs(busy(), False, "no open session after the finish")

    def test_healthcheck_busy_flag(self) -> None:
        console = self.harness()
        script = PROJECT_ROOT / "packaging" / "docker" / "healthcheck.py"

        def check(*args: str) -> Tuple[int, str]:
            result = subprocess.run(
                [sys.executable, "-I", str(script), str(console.port), *args],
                capture_output=True, text=True, timeout=30,
                env={key: value for key, value in os.environ.items() if not key.lower().endswith("_proxy")},
            )
            return result.returncode, result.stdout.strip()

        self.assertEqual(check("--busy"), (0, "idle"))
        status, _ = console.request("POST", "/api/receiver/audio-sessions", {})
        self.assertEqual(status, 201)
        self.assertEqual(check("--busy"), (0, "busy"))
        code, out = check()
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("healthy: version"), out)
        closed = _free_port()
        result = subprocess.run([sys.executable, "-I", str(script), str(closed), "--busy"],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertTrue(result.stdout.startswith("unhealthy:"), result.stdout)

    def test_receiver_activity_counts_scans_and_writes(self) -> None:
        now = [0.0]
        activity = ground_console.ReceiverActivity(clock=lambda: now[0])
        self.assertIs(activity.busy(), False)
        activity.wrote(opened="scan:1")
        now[0] = ground_console.RECEIVER_BUSY_OPEN_S - 1
        self.assertIs(activity.busy(), True)
        activity.wrote()
        activity.wrote(closed="scan:1")
        now[0] += ground_console.RECEIVER_BUSY_WRITE_S - 1
        self.assertIs(activity.busy(), True)
        now[0] += 2
        self.assertIs(activity.busy(), False)

    def test_healthy_health_checks_are_not_logged(self) -> None:
        console = self.harness()
        lines: List[str] = []
        record = lambda _handler, fmt, *args: lines.append(fmt % args)  # noqa: E731
        with patch.object(ground_console.ConsoleHandler, "log_message", record):
            status, _ = console.request("GET", "/api/health", origin=None)
            self.assertEqual(status, 200)
            console.request("GET", "/api/preferences", origin=None)
        self.assertFalse(any("/api/health" in line for line in lines), lines)
        self.assertTrue(any("GET /api/preferences" in line for line in lines), lines)


class VersionTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-version-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_reads_the_first_line(self) -> None:
        path = self.root / "VERSION"
        path.write_text("2.0.0\n", encoding="utf-8")
        self.assertEqual(ground_console._read_version(path), "2.0.0")
        path.write_bytes(b"\xef\xbb\xbf2.1.0-rc1\nnotes\n")
        self.assertEqual(ground_console._read_version(path), "2.1.0-rc1")

    def test_missing_or_unusable_is_dev(self) -> None:
        self.assertEqual(ground_console._read_version(self.root / "missing"), "dev")
        for content in (b"", b"\n\n", b"2.0.0 beta\n", b"<script>\n", b"\xff\xfe"):
            path = self.root / "VERSION"
            path.write_bytes(content)
            with self.subTest(content=content):
                self.assertEqual(ground_console._read_version(path), "dev")
        directory = self.root / "dir"
        directory.mkdir()
        self.assertEqual(ground_console._read_version(directory), "dev")

    def test_repository_version_is_reported(self) -> None:
        expected = ground_console._read_version(PROJECT_ROOT / "VERSION")
        self.assertEqual(ground_console.CONSOLE_VERSION, expected)


SEED_ENV = {
    "SDR_DOA_SEED_BASE_URL": "http://192.168.100.100:8081",
    "SDR_DOA_SEED_MQTT_HOST": "127.0.0.1",
    "SDR_DOA_SEED_MQTT_PORT": "18884",
    "SDR_DOA_SEED_MQTT_TRANSPORT": "tcp",
    "SDR_DOA_SEED_MQTT_WS_PATH": "/ws",
    "SDR_DOA_SEED_REFRESH_SECONDS": "5",
}


class SeedTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-seed-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / "config" / "console.json"
        self.logs = Logs()
        quiet = patch("builtins.print")
        quiet.start()
        self.addCleanup(quiet.stop)

    def initial(self, environ: Dict[str, str], dotenv: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        return ground_console._initial_console_config(self.path, environ, dotenv or {}, log=self.logs)

    def saved(self) -> Dict[str, Any]:
        return json.loads(self.path.read_text(encoding="utf-8"))

    def test_first_start_saves_the_seeded_config(self) -> None:
        config = self.initial(SEED_ENV)
        expected = {
            "version": 1,
            "base_url": "http://192.168.100.100:8081",
            "data_out_hosts": ["doasdr.local", "192.168.100.100", "127.0.0.1", "localhost"],
            "mqtt_host": "127.0.0.1",
            "mqtt_port": 18884,
            "mqtt_transport": "tcp",
            "mqtt_ws_path": "/ws",
            "refresh_seconds": 5,
            # The LAN view has no seed: it starts off, for nobody.
            "lan_access": {"enabled": False, "port": 8788, "bind": "0.0.0.0", "allowed_clients": []},
        }
        self.assertEqual(config, expected)
        self.assertEqual(self.saved(), expected)
        self.assertEqual(self.logs.lines, [])

    def test_first_start_without_seed_saves_the_defaults(self) -> None:
        config = self.initial({})
        self.assertEqual(config, ground_console._default_console_config())
        self.assertEqual(self.saved(), config)

    def test_later_starts_ignore_the_seed(self) -> None:
        self.initial({"SDR_DOA_SEED_REFRESH_SECONDS": "10"})
        # The operator changes the interval in the UI; the seed changes too.
        saved = self.saved()
        saved["refresh_seconds"] = 30
        self.path.write_text(json.dumps(saved), encoding="utf-8")
        config = self.initial({**SEED_ENV, "SDR_DOA_SEED_REFRESH_SECONDS": "1"})
        self.assertEqual(config["refresh_seconds"], 30)
        self.assertEqual(config["base_url"], "http://doasdr.local:8081")
        self.assertEqual(self.saved()["refresh_seconds"], 30)

    def test_invalid_seed_values_are_ignored_with_a_warning(self) -> None:
        environ = {
            "SDR_DOA_SEED_BASE_URL": "http://evil.example:8081",
            "SDR_DOA_SEED_MQTT_HOST": "broker.example",
            "SDR_DOA_SEED_MQTT_PORT": "70000",
            "SDR_DOA_SEED_MQTT_TRANSPORT": "udp",
            "SDR_DOA_SEED_MQTT_WS_PATH": "no-slash",
            "SDR_DOA_SEED_REFRESH_SECONDS": "3",
        }
        config = self.initial(environ)
        self.assertEqual(config, ground_console._default_console_config())
        self.assertEqual(len(self.logs.lines), 6, self.logs.lines)
        for variable in environ:
            self.assertTrue(any(variable in line for line in self.logs.lines), variable)
        self.assertFalse(any("evil.example" in line for line in self.logs.lines), "values are not echoed")
        partial = self.root / "partial.json"
        config = ground_console._initial_console_config(
            partial, {"SDR_DOA_SEED_MQTT_PORT": "1883.5", "SDR_DOA_SEED_REFRESH_SECONDS": "10"}, {}, log=self.logs,
        )
        self.assertEqual((config["mqtt_port"], config["refresh_seconds"]), (9001, 10))

    def test_env_file_supplies_seed_and_the_environment_wins(self) -> None:
        dotenv = {"SDR_DOA_SEED_MQTT_HOST": "10.0.0.5", "SDR_DOA_SEED_MQTT_PORT": "1884"}
        config = self.initial({"SDR_DOA_SEED_MQTT_PORT": "1885", "SDR_DOA_SEED_MQTT_HOST": "  "}, dotenv)
        self.assertEqual((config["mqtt_host"], config["mqtt_port"]), ("10.0.0.5", 1885))

    def test_existing_invalid_file_is_not_replaced_by_the_seed(self) -> None:
        self.path.parent.mkdir(parents=True)
        self.path.write_text("{", encoding="utf-8")
        config = self.initial(SEED_ENV)
        self.assertEqual(config, ground_console._default_console_config())
        self.assertEqual(self.path.read_text(encoding="utf-8"), "{")

    def test_unwritable_location_still_starts(self) -> None:
        blocker = self.root / "blocker"
        blocker.write_text("file", encoding="utf-8")
        path = blocker / "console.json"
        config = ground_console._initial_console_config(path, SEED_ENV, {}, log=self.logs)
        self.assertEqual(config["refresh_seconds"], 5)
        self.assertTrue(any("could not save the initial console config" in line for line in self.logs.lines), self.logs.lines)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


class _StubMonitor:
    def __init__(self, host: str, port: int, transport: str = "tcp", ws_path: str = "/mqtt") -> None:
        self.host, self.port, self.transport, self.ws_path = host, port, transport, ws_path

    def start(self) -> None:
        return None

    def stop(self) -> None:
        return None


class MainWiringTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-main-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        clean_env = {key: value for key, value in os.environ.items() if not key.startswith("SDR_DOA_")}
        environ = patch.dict(os.environ, clean_env, clear=True)
        environ.start()
        self.addCleanup(environ.stop)
        password = patch.object(ground_console, "ADMIN_PASSWORD", "before-main")
        password.start()
        self.addCleanup(password.stop)
        for target, value in (
            ("_new_mqtt_monitor", lambda *args: _StubMonitor(*args)),
        ):
            patcher = patch.object(ground_console, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.servers: List[Any] = []
        original_init = ground_console.GroundConsoleServer.__init__
        servers = self.servers

        def capture(server: Any, *args: Any, **kwargs: Any) -> None:
            original_init(server, *args, **kwargs)
            servers.append(server)

        for patcher in (
            patch.object(ground_console.GroundConsoleServer, "__init__", capture),
            patch.object(ground_console.GroundConsoleServer, "serve_forever", side_effect=KeyboardInterrupt),
            patch("builtins.print"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_main(self, *extra: str) -> Any:
        data = self.root / "data"
        argv = [
            "--port", str(_free_port()),
            "--config-path", str(data / "console.json"),
            "--branding-path", str(data / "branding.json"),
            "--preferences-path", str(data / "preferences.json"),
            "--data-dir", str(data / "receiver"),
            "--env-file", str(data / ".env"),
            *extra,
        ]
        self.assertEqual(ground_console.main(argv), 0)
        return self.servers[-1]

    def test_env_file_sets_password_and_seed(self) -> None:
        data = self.root / "data"
        data.mkdir()
        (data / ".env").write_text(
            "SDR_DOA_ADMIN_PASSWORD=from-env-file\nSDR_DOA_SEED_BASE_URL=http://127.0.0.1:8081\nSDR_DOA_SEED_MQTT_HOST=127.0.0.1\n",
            encoding="utf-8",
        )
        server = self.run_main()
        self.assertEqual(ground_console.ADMIN_PASSWORD, "from-env-file")
        self.assertEqual(server.preferences.path, data / "preferences.json")
        saved = json.loads((data / "console.json").read_text(encoding="utf-8"))
        self.assertEqual((saved["base_url"], saved["mqtt_host"]), ("http://127.0.0.1:8081", "127.0.0.1"))
        self.assertEqual(server.get_config()["base_url"], "http://127.0.0.1:8081")

    def test_missing_env_file_uses_the_default_password(self) -> None:
        self.run_main()
        self.assertEqual(ground_console.ADMIN_PASSWORD, ground_console.DEFAULT_ADMIN_PASSWORD)

    def test_sigterm_stops_cleanly_behind_the_receiver_store_lock(self) -> None:
        held: List[bool] = []
        original_close = ground_console.GroundConsoleServer.server_close

        def close(server: Any) -> None:
            held.append(server.receiver_store._lock._is_owned())
            original_close(server)

        before = signal.getsignal(signal.SIGTERM)
        with patch.object(ground_console.GroundConsoleServer, "serve_forever",
                          side_effect=lambda: os.kill(os.getpid(), signal.SIGTERM)), \
                patch.object(ground_console.GroundConsoleServer, "server_close", close):
            self.run_main()
        self.assertEqual(held, [True], "server_close runs once, holding the store lock")
        self.assertIs(signal.getsignal(signal.SIGTERM), before, "main puts the previous handler back")

    def test_cli_override_is_not_saved(self) -> None:
        server = self.run_main("--base-url", "http://192.168.100.100:8081")
        saved = json.loads((self.root / "data" / "console.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["base_url"], "http://doasdr.local:8081")
        self.assertEqual(server.get_config()["base_url"], "http://192.168.100.100:8081")


if __name__ == "__main__":
    unittest.main()
