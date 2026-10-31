#!/usr/bin/env python3
"""Restart and Shutdown of the console's host: host_power.py and POST /api/host/power.

The request directory is a temporary one with the host side's ``helper``
marker written by hand, so nothing here reaches /run or the real host. The
LAN view tests open the second listener on 127.0.0.1 through the manager's
test hook (test_lan_access): it must refuse the route and leave the
capability out. The last tests tie the error codes, reasons and actions to
their frontend copies and EN/ID texts.
"""

from __future__ import annotations

import json
import os
import re
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from unittest import mock

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import host_power as hp  # noqa: E402
from test_lan_access import _json, _request, _ServerCase, ground_console, lan  # noqa: E402

ROOT = TOOLS_DIR.parent
HOST_POWER_TS = (ROOT / "frontend/src/lib/hostPower.ts").read_text(encoding="utf-8")
I18N_TS = (ROOT / "frontend/src/lib/i18n.ts").read_text(encoding="utf-8")
GROUND_CONSOLE = (TOOLS_DIR / "ground_console.py").read_text(encoding="utf-8")


def _ready_dir(base: Path) -> Path:
    """A request directory as the host side leaves it: writable, with the helper marker."""
    directory = base / "sdr-doa-host-power"
    directory.mkdir(mode=0o700)
    (directory / hp.HELPER_NAME).write_text("sdr-doa-host-power\n", encoding="utf-8")
    return directory


class _TempDirCase(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-host-power-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)


class StatusTests(_TempDirCase):
    def test_reasons_in_order(self) -> None:
        self.assertEqual(hp.HostPower(None).status(), {"available": False, "reason": hp.NOT_CONFIGURED, "actions": ["reboot", "poweroff"]})
        missing = self.base / "missing"
        self.assertEqual(hp.HostPower(missing).status()["reason"], hp.DIR_MISSING)
        (self.base / "file").write_text("", encoding="utf-8")
        self.assertEqual(hp.HostPower(self.base / "file").status()["reason"], hp.DIR_MISSING)
        directory = self.base / "dir"
        directory.mkdir()
        self.assertEqual(hp.HostPower(directory).status()["reason"], hp.HELPER_MISSING)
        (directory / hp.HELPER_NAME).mkdir()
        self.assertEqual(hp.HostPower(directory).status()["reason"], hp.HELPER_MISSING, "a directory is no marker")
        ready = _ready_dir(self.base)
        self.assertEqual(hp.HostPower(ready).status(), {"available": True, "reason": None, "actions": ["reboot", "poweroff"]})

    def test_a_directory_the_console_cannot_write(self) -> None:
        """Docker creates the bind mount's source root-owned when the host side is missing."""
        ready = _ready_dir(self.base)
        # os.access, not the mode bits: a test run as root writes anywhere.
        with mock.patch.object(hp.os, "access", return_value=False) as access:
            self.assertEqual(hp.HostPower(ready).status()["reason"], hp.DIR_NOT_WRITABLE)
        access.assert_called_once_with(ready, os.W_OK | os.X_OK)


class RequestFileTests(_TempDirCase):
    def setUp(self) -> None:
        super().setUp()
        self.dir = _ready_dir(self.base)
        self.power = hp.HostPower(self.dir, clock=lambda: 1_700_000_000.25)

    def entries(self) -> List[str]:
        return sorted(path.name for path in self.dir.iterdir())

    def test_exactly_one_word_without_a_newline(self) -> None:
        for action in hp.ACTIONS:
            with self.subTest(action=action):
                self.assertEqual(self.power.request(action), {"action": action, "requested_at_ms": 1_700_000_000_250})
                request = self.dir / hp.REQUEST_NAME
                self.assertEqual(request.read_bytes(), action.encode("ascii"))
                self.assertEqual(stat.S_IMODE(request.stat().st_mode), 0o644)
                self.assertEqual(self.entries(), [hp.HELPER_NAME, hp.REQUEST_NAME], "no temporary file is left")
                request.unlink()

    def test_the_word_appears_whole(self) -> None:
        """The request is linked into place from a file that already holds the word."""
        seen: List[Tuple[bytes, bool]] = []
        real_link = os.link

        def spy(source: Any, target: Any) -> None:
            seen.append((Path(source).read_bytes(), Path(target).exists()))
            self.assertNotEqual(Path(source).name, hp.REQUEST_NAME)
            real_link(source, target)

        with mock.patch.object(hp.os, "link", side_effect=spy):
            self.power.request("poweroff")
        self.assertEqual(seen, [(b"poweroff", False)])

    def test_a_request_the_host_has_not_taken_is_kept(self) -> None:
        self.power.request("reboot")
        with self.assertRaises(hp.HostPowerRejected) as refused:
            self.power.request("poweroff")
        self.assertEqual(refused.exception.code, hp.HOST_POWER_PENDING)
        self.assertEqual((self.dir / hp.REQUEST_NAME).read_bytes(), b"reboot")
        self.assertEqual(self.entries(), [hp.HELPER_NAME, hp.REQUEST_NAME])
        # Once the host took it, the next request is written.
        (self.dir / hp.REQUEST_NAME).unlink()
        self.power.request("poweroff")
        self.assertEqual((self.dir / hp.REQUEST_NAME).read_bytes(), b"poweroff")

    def test_unavailable_and_failed_writes(self) -> None:
        with self.assertRaises(hp.HostPowerRejected) as refused:
            hp.HostPower(self.base / "missing").request("reboot")
        self.assertEqual((refused.exception.code, refused.exception.extra), (hp.HOST_POWER_UNAVAILABLE, {"reason": hp.DIR_MISSING}))
        with self.assertRaises(hp.HostPowerRejected) as refused:
            hp.HostPower(None).request("reboot")
        self.assertEqual(refused.exception.extra, {"reason": hp.NOT_CONFIGURED})
        with mock.patch.object(hp.tempfile, "mkstemp", side_effect=PermissionError(13, "denied", str(self.dir))):
            with self.assertRaises(hp.HostPowerRejected) as refused:
                self.power.request("reboot")
        self.assertEqual(refused.exception.code, hp.HOST_POWER_WRITE_FAILED)
        self.assertNotIn(str(self.dir), refused.exception.message, "no path in the answer")
        with mock.patch.object(hp.os, "link", side_effect=OSError(28, "No space left on device")):
            with self.assertRaises(hp.HostPowerRejected) as refused:
                self.power.request("reboot")
        self.assertEqual(refused.exception.code, hp.HOST_POWER_WRITE_FAILED)
        self.assertEqual(self.entries(), [hp.HELPER_NAME], "the temporary file is removed")
        with self.assertRaises(hp.HostPowerRejected) as refused:
            self.power.request("halt")
        self.assertEqual(refused.exception.code, hp.HOST_POWER_INVALID)
        self.assertEqual(self.entries(), [hp.HELPER_NAME])


class DecodeTests(unittest.TestCase):
    def test_valid_bodies(self) -> None:
        for action in hp.ACTIONS:
            self.assertEqual(hp.decode_request(json.dumps({"action": action, "confirm": True}).encode()), action)
        self.assertEqual(hp.decode_request(b' {"confirm":true,"action":"reboot"} '), "reboot")

    def test_refused_bodies(self) -> None:
        invalid = [
            b"", b"reboot", b"{", b"[]", b'"reboot"', b"null", b"\xff\xfe",
            b'{"action":"reboot","confirm":true,"extra":1}',
            b'{"action":"reboot","action":"poweroff","confirm":true}',
            b'{"action":"REBOOT","confirm":true}', b'{"action":"halt","confirm":true}',
            b'{"action":"reboot ","confirm":true}', b'{"action":1,"confirm":true}', b'{"confirm":true}',
            b'{"action":null,"confirm":true}',
        ]
        for raw in invalid:
            with self.subTest(raw=raw):
                with self.assertRaises(hp.HostPowerRejected) as refused:
                    hp.decode_request(raw)
                self.assertEqual(refused.exception.code, hp.HOST_POWER_INVALID)
        for raw in (b'{"action":"reboot"}', b'{"action":"reboot","confirm":false}', b'{"action":"reboot","confirm":1}',
                    b'{"action":"reboot","confirm":"true"}', b'{"action":"poweroff","confirm":null}'):
            with self.subTest(raw=raw):
                with self.assertRaises(hp.HostPowerRejected) as refused:
                    hp.decode_request(raw)
                self.assertEqual(refused.exception.code, hp.HOST_POWER_CONFIRM_REQUIRED)


class RouteTests(_ServerCase):
    def setUp(self) -> None:
        super().setUp()
        self.server = self.start_server()
        self.port = self.server.server_address[1]
        self.dir = _ready_dir(self.root)
        self.server.host_power = hp.HostPower(self.dir)

    def post(self, body: Any = None, *, origin: Optional[str] = "default", raw: Optional[bytes] = None,
             port: Optional[int] = None) -> Tuple[int, Dict[str, Any]]:
        target = self.port if port is None else port
        headers = [("Content-Type", "application/json")]
        if origin == "default":
            headers.append(("Origin", f"http://127.0.0.1:{target}"))
        elif origin is not None:
            headers.append(("Origin", origin))
        data = raw if raw is not None else json.dumps(body).encode("utf-8")
        status, _headers, answer = _request(target, "POST", hp.ROUTE, headers, data)
        return status, _json(answer)

    def assert_code(self, result: Tuple[int, Dict[str, Any]], status: int, code: str) -> Dict[str, Any]:
        self.assertEqual(result[0], status, result[1])
        self.assertEqual((result[1]["ok"], result[1]["code"]), (False, code))
        self.assertIsInstance(result[1]["error"], str)
        return result[1]

    def entries(self) -> List[str]:
        return sorted(path.name for path in self.dir.iterdir())

    def capabilities(self, port: Optional[int] = None) -> Dict[str, Any]:
        status, _headers, raw = _request(self.port if port is None else port, "GET", "/api/capabilities")
        self.assertEqual(status, 200)
        return _json(raw)

    def test_a_confirmed_request_writes_one_word(self) -> None:
        status, answer = self.post({"action": "reboot", "confirm": True})
        self.assertEqual(status, 202, answer)
        self.assertEqual((answer["ok"], answer["action"]), (True, "reboot"))
        self.assertIsInstance(answer["requested_at_ms"], int)
        self.assertEqual((self.dir / hp.REQUEST_NAME).read_bytes(), b"reboot")
        self.assertIn("host power: reboot requested", self.output.getvalue())
        # The host has not taken it yet: a second request is refused and the first kept.
        self.assert_code(self.post({"action": "poweroff", "confirm": True}), 409, hp.HOST_POWER_PENDING)
        self.assertEqual((self.dir / hp.REQUEST_NAME).read_bytes(), b"reboot")
        self.assertEqual(self.entries(), [hp.HELPER_NAME, hp.REQUEST_NAME])

    def test_only_this_console_s_own_page_may_ask(self) -> None:
        for origin in (None, "null", f"http://localhost:{self.port + 1}", f"https://127.0.0.1:{self.port}",
                       "http://192.168.1.20:8787", f"http://127.0.0.1:{self.port}/path", "http://evil.example"):
            with self.subTest(origin=origin):
                self.assert_code(self.post({"action": "poweroff", "confirm": True}, origin=origin), 403, hp.ORIGIN_REJECTED)
        self.assertEqual(self.entries(), [hp.HELPER_NAME])

    def test_the_origin_is_checked_before_the_body(self) -> None:
        self.assert_code(self.post(origin=None, raw=b"not json at all"), 403, hp.ORIGIN_REJECTED)
        self.assertEqual(self.entries(), [hp.HELPER_NAME])

    def test_the_body_is_strict_and_small(self) -> None:
        compact = b'{"action":"reboot","confirm":true}'
        self.assert_code(self.post(raw=compact + b" " * (hp.MAX_BODY_BYTES - len(compact) + 1)), 413, hp.HOST_POWER_TOO_LARGE)
        self.assert_code(self.post(raw=b" " * 70_000), 413, hp.HOST_POWER_TOO_LARGE)
        self.assert_code(self.post(raw=b""), 400, hp.HOST_POWER_INVALID)
        self.assert_code(self.post(raw=b"{not json"), 400, hp.HOST_POWER_INVALID)
        self.assert_code(self.post({"action": "halt", "confirm": True}), 400, hp.HOST_POWER_INVALID)
        self.assert_code(self.post({"action": "reboot", "confirm": True, "delay": 5}), 400, hp.HOST_POWER_INVALID)
        self.assert_code(self.post({"action": "reboot"}), 400, hp.HOST_POWER_CONFIRM_REQUIRED)
        self.assert_code(self.post({"action": "reboot", "confirm": 1}), 400, hp.HOST_POWER_CONFIRM_REQUIRED)
        self.assertEqual(self.entries(), [hp.HELPER_NAME])
        # At the limit it is taken.
        status, _answer = self.post(raw=compact + b" " * (hp.MAX_BODY_BYTES - len(compact)))
        self.assertEqual(status, 202)

    def test_a_missing_host_side_is_503_with_its_reason(self) -> None:
        cases = (
            (hp.HostPower(self.root / "missing"), hp.DIR_MISSING),
            (hp.HostPower(None), hp.NOT_CONFIGURED),
        )
        (self.dir / hp.HELPER_NAME).unlink()
        for power, reason in cases + ((hp.HostPower(self.dir), hp.HELPER_MISSING),):
            with self.subTest(reason=reason):
                self.server.host_power = power
                answer = self.assert_code(self.post({"action": "reboot", "confirm": True}), 503, hp.HOST_POWER_UNAVAILABLE)
                self.assertEqual(answer["reason"], reason)
                capability = self.capabilities()["host_power"]
                self.assertEqual(capability, {"available": False, "reason": reason, "actions": ["reboot", "poweroff"]})
        self.assertEqual(self.entries(), [])
        self.assertFalse((self.root / "missing").exists())

    def test_capabilities_say_whether_the_buttons_work(self) -> None:
        self.assertEqual(self.capabilities()["host_power"], {"available": True, "reason": None, "actions": ["reboot", "poweroff"]})

    def test_the_lan_view_never_reaches_the_route(self) -> None:
        lan_port = self.open_lan(self.server)
        self.assertIsNone(lan.lan_route(hp.ROUTE))
        for origin in ("default", None):
            with self.subTest(origin=origin):
                status, answer = self.post({"action": "poweroff", "confirm": True}, origin=origin, port=lan_port)
                self.assertEqual((status, answer["code"]), (405, lan.LAN_READ_ONLY))
        # A loopback Origin from a tablet's page changes nothing either.
        status, answer = self.post({"action": "poweroff", "confirm": True}, origin=f"http://127.0.0.1:{self.port}", port=lan_port)
        self.assertEqual((status, answer["code"]), (405, lan.LAN_READ_ONLY))
        status, _headers, raw = _request(lan_port, "GET", hp.ROUTE)
        self.assertEqual((status, _json(raw)["code"]), (403, lan.LAN_READ_ONLY))
        self.assertEqual(self.entries(), [hp.HELPER_NAME])
        # Not even the state: the LAN capabilities leave it out, the loopback ones keep it.
        self.assertNotIn("host_power", self.capabilities(lan_port))
        self.assertEqual(self.capabilities(lan_port)["access"], "lan-view")
        self.assertIn("host_power", self.capabilities())


class ServerWiringTests(_TempDirCase):
    def test_constructor_and_flag(self) -> None:
        directory = _ready_dir(self.base)
        (self.base / "console.json").write_text(json.dumps({"version": 1, "mqtt_host": ""}), encoding="utf-8")
        with mock.patch("sys.stdout"):
            server = ground_console.GroundConsoleServer(
                ("127.0.0.1", 0), "http://doasdr.local:8081",
                config_path=str(self.base / "console.json"), branding_path=str(self.base / "branding.json"),
                receiver_data_dir=self.base / "receiver", tile_cache_dir=self.base / "tiles",
                host_power_dir=directory,
            )
        try:
            self.assertEqual(server.host_power.status()["available"], True)
        finally:
            server.server_close()
        parser = ground_console._build_parser()
        self.assertEqual(parser.parse_args([]).host_power_dir, hp.DEFAULT_DIR)
        self.assertEqual(parser.parse_args(["--host-power-dir", ""]).host_power_dir, "")

    def test_off_without_a_directory(self) -> None:
        (self.base / "console.json").write_text(json.dumps({"version": 1, "mqtt_host": ""}), encoding="utf-8")
        with mock.patch("sys.stdout"):
            server = ground_console.GroundConsoleServer(
                ("127.0.0.1", 0), "http://doasdr.local:8081",
                config_path=str(self.base / "console.json"), branding_path=str(self.base / "branding.json"),
                receiver_data_dir=self.base / "receiver", tile_cache_dir=self.base / "tiles",
            )
        try:
            self.assertEqual(server.host_power.status()["reason"], hp.NOT_CONFIGURED)
        finally:
            server.server_close()


def _ts_list(name: str) -> List[str]:
    match = re.search(rf"export const {name} = \[([^\]]*)\] as const;", HOST_POWER_TS)
    assert match is not None, name
    return re.findall(r"'([A-Za-z_]+)'", match.group(1))


def _dictionary_keys(lang_marker: str) -> set:
    """Keys of the en or id dictionary in lib/i18n.ts."""
    if lang_marker == "en":
        block = I18N_TS.split("const en = {", 1)[1].split("\n};", 1)[0]
    else:
        block = I18N_TS.split("const id: Dictionary = {", 1)[1].split("\n};", 1)[0]
    return set(re.findall(r"^  '([^']+)':", block, re.M))


class FrontendContractTests(unittest.TestCase):
    def test_the_frontend_copies_match(self) -> None:
        self.assertEqual(tuple(_ts_list("HOST_POWER_ACTIONS")), hp.ACTIONS)
        self.assertEqual(tuple(_ts_list("HOST_POWER_REASONS")), hp.REASONS)
        self.assertEqual(set(_ts_list("HOST_POWER_ERROR_CODES")), set(hp.ERROR_CODES_HTTP))
        self.assertIn(f"HOST_POWER_ROUTE = '{hp.ROUTE}'", HOST_POWER_TS)

    def test_every_code_and_reason_has_en_and_id_text(self) -> None:
        for lang_marker in ("en", "id"):
            keys = _dictionary_keys(lang_marker)
            for code in hp.ERROR_CODES_HTTP:
                self.assertIn(f"power.error.{code}", keys, lang_marker)
            for reason in hp.REASONS:
                self.assertIn(f"power.reason.{reason}", keys, lang_marker)

    def test_codes_stay_out_of_the_kontrol_contract(self) -> None:
        for code in hp.ERROR_CODES_HTTP:
            if code == hp.ORIGIN_REJECTED:
                continue
            self.assertNotRegex(GROUND_CONSOLE, rf"_send_config_patch_error\([^)]*\"{code}\"")
            self.assertNotIn(f'"{code}"', GROUND_CONSOLE, "host power codes come from host_power.py only")


if __name__ == "__main__":
    unittest.main()
