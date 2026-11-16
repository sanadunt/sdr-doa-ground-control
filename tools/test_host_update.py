#!/usr/bin/env python3
"""Configuration's Update: host_power.py's update request and state,
console_release.py's GitHub check and GET/POST /api/host/update.

The request directory is a temporary one with the host side's markers
written by hand, and GitHub is a loopback fake (or an injected fetch), so
nothing here reaches /run, the real host or the network. The LAN view tests
open the second listener on 127.0.0.1 through the manager's test hook: it
must refuse both routes. The last tests tie the codes, reasons and states to
their frontend copies and EN/ID texts.
"""

from __future__ import annotations

import http.server
import json
import os
import re
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from unittest import mock

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import console_release as cr  # noqa: E402
import host_power as hp  # noqa: E402
from test_lan_access import _json, _request, _ServerCase, lan  # noqa: E402

ROOT = TOOLS_DIR.parent
UPDATE_TS = (ROOT / "frontend/src/lib/consoleUpdate.ts").read_text(encoding="utf-8")
I18N_TS = (ROOT / "frontend/src/lib/i18n.ts").read_text(encoding="utf-8")
GROUND_CONSOLE = (TOOLS_DIR / "ground_console.py").read_text(encoding="utf-8")
NOW = 1_800_000_000


def _ready_dir(base: Path, update: bool = True) -> Path:
    """A request directory as the host side leaves it where it found sdr-doa-docker."""
    directory = base / "sdr-doa-host-power"
    directory.mkdir(mode=0o700)
    (directory / hp.HELPER_NAME).write_text("sdr-doa-host-power\n", encoding="utf-8")
    if update:
        (directory / hp.UPDATE_HELPER_NAME).write_text("sdr-doa-docker\n", encoding="utf-8")
    return directory


def _status_text(**values: Any) -> str:
    fields = {"STATE": "queued", "PHASE": "", "QUEUED": str(NOW), "STARTED": "", "FINISHED": "", "TO": "", "MESSAGE": ""}
    fields.update({key.upper(): str(value) for key, value in values.items()})
    return "# sdr-doa-host-power: the console update it ran (packaging/host-power)\n" + "".join(
        f"{key}={value}\n" for key, value in fields.items())


def _release(tag: str, *, prerelease: bool = False, draft: bool = False, url: Optional[str] = None) -> Dict[str, Any]:
    return {
        "tag_name": tag, "prerelease": prerelease, "draft": draft, "published_at": "2026-11-16T03:00:00Z",
        "html_url": url if url is not None else f"https://github.com/sanadunt/sdr-doa-ground-control/releases/tag/{tag}",
    }


class _TempDirCase(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-host-update-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)


class StatusFileTests(unittest.TestCase):
    def test_every_state_and_its_fields(self) -> None:
        status = hp.parse_update_status(_status_text(state="running", phase="pulling", started=NOW + 2, to="3.23.0"), NOW + 10)
        self.assertEqual(status, {
            "state": "running", "phase": "pulling", "queued_at_ms": NOW * 1000, "started_at_ms": (NOW + 2) * 1000,
            "finished_at_ms": None, "to": "3.23.0", "message": None, "stale": False,
        })
        for state in hp.UPDATE_STATES:
            with self.subTest(state=state):
                parsed = hp.parse_update_status(_status_text(state=state, phase="starting"), NOW)
                assert parsed is not None
                self.assertEqual(parsed["state"], state)
                # A phase belongs to an update on its way only.
                self.assertEqual(parsed["phase"], "starting" if state in hp.UPDATE_RUNNING_STATES else None)
        done = hp.parse_update_status(_status_text(state="rolled_back", finished=NOW + 60, message="FAILED: 3.23.0 (abc): unhealthy"), NOW)
        assert done is not None
        self.assertEqual((done["finished_at_ms"], done["message"]), ((NOW + 60) * 1000, "FAILED: 3.23.0 (abc): unhealthy"))

    def test_read_leniently_and_only_a_known_state(self) -> None:
        for text in ("", "STATE=\n", "STATE=exploded\n", "garbage", "STATE=OK\n"):
            with self.subTest(text=text):
                self.assertIsNone(hp.parse_update_status(text, NOW))
        lenient = hp.parse_update_status(
            "STATE=failed\nQUEUED=soon\nTO=latest\nMESSAGE=" + "x" * 301 + "\nEXTRA=1\nnoise\nSTATE=ok\n", NOW)
        assert lenient is not None
        self.assertEqual((lenient["state"], lenient["queued_at_ms"], lenient["to"], lenient["message"]), ("failed", None, None, None))
        self.assertIsNone(hp.parse_update_status("STATE=failed\nMESSAGE=tab\there\n", NOW)["message"])  # type: ignore[index]

    def test_a_queued_or_running_state_older_than_the_unit_is_stale(self) -> None:
        fresh = hp.parse_update_status(_status_text(state="running", started=NOW), NOW + hp.UPDATE_STALE_S)
        stale = hp.parse_update_status(_status_text(state="running", started=NOW), NOW + hp.UPDATE_STALE_S + 1)
        timeless = hp.parse_update_status("STATE=queued\n", NOW)
        finished = hp.parse_update_status(_status_text(state="ok"), NOW + 10 * hp.UPDATE_STALE_S)
        self.assertEqual([item["stale"] for item in (fresh, stale, timeless, finished)], [False, True, True, False])  # type: ignore[index]


class HostUpdateTests(_TempDirCase):
    def power(self, directory: Optional[Path], *, in_container: bool = True) -> hp.HostPower:
        return hp.HostPower(directory, clock=lambda: NOW + 0.5, in_container=in_container)

    def test_reasons_in_order(self) -> None:
        self.assertEqual(self.power(None).update_status()["reason"], hp.NOT_CONFIGURED)
        ready = _ready_dir(self.base)
        # A native console is not the sdr-doa-docker install the host updates.
        self.assertEqual(self.power(ready, in_container=False).update_status()["reason"], hp.NOT_DOCKER)
        self.assertEqual(self.power(self.base / "missing").update_status()["reason"], hp.DIR_NOT_MOUNTED)
        (ready / hp.HELPER_NAME).unlink()
        self.assertEqual(self.power(ready).update_status()["reason"], hp.HELPER_MISSING)
        (ready / hp.HELPER_NAME).write_text("x", encoding="utf-8")
        (ready / hp.UPDATE_HELPER_NAME).unlink()
        # An older host side (Restart and Shutdown only), or no sdr-doa-docker install there.
        self.assertEqual(self.power(ready).update_status(), {"available": False, "reason": hp.UPDATE_HELPER_MISSING, "status": None})
        self.assertTrue(self.power(ready).status()["available"], "Restart and Shutdown work without it")
        (ready / hp.UPDATE_HELPER_NAME).write_text("x", encoding="utf-8")
        self.assertEqual(self.power(ready).update_status(), {"available": True, "reason": None, "status": None})
        with mock.patch.object(hp.os, "access", return_value=False):
            self.assertEqual(self.power(ready).update_status()["reason"], hp.DIR_NOT_WRITABLE)

    def test_the_request_is_the_word_update(self) -> None:
        ready = _ready_dir(self.base)
        power = self.power(ready)
        self.assertEqual(power.request_update(), {"requested_at_ms": NOW * 1000 + 500})
        self.assertEqual((ready / hp.REQUEST_NAME).read_bytes(), b"update")
        self.assertEqual(sorted(path.name for path in ready.iterdir()), [hp.HELPER_NAME, hp.REQUEST_NAME, hp.UPDATE_HELPER_NAME])
        with self.assertRaises(hp.HostPowerRejected) as refused:
            power.request_update()
        self.assertEqual(refused.exception.code, hp.HOST_UPDATE_PENDING)
        # A power request waiting blocks an update the same way, and the other way round.
        with self.assertRaises(hp.HostPowerRejected) as refused:
            power.request("reboot")
        self.assertEqual(refused.exception.code, hp.HOST_POWER_PENDING)
        self.assertEqual((ready / hp.REQUEST_NAME).read_bytes(), b"update")

    def test_an_update_on_its_way_refuses_another(self) -> None:
        ready = _ready_dir(self.base)
        power = self.power(ready)
        status = ready / hp.UPDATE_STATUS_NAME
        for state in hp.UPDATE_RUNNING_STATES:
            with self.subTest(state=state):
                status.write_text(_status_text(state=state, started=NOW), encoding="utf-8")
                with self.assertRaises(hp.HostPowerRejected) as refused:
                    power.request_update()
                self.assertEqual(refused.exception.code, hp.HOST_UPDATE_RUNNING)
                self.assertFalse((ready / hp.REQUEST_NAME).exists())
        # One the unit's timeout ended long ago, or a finished one, blocks nothing.
        status.write_text(_status_text(state="running", queued=NOW - hp.UPDATE_STALE_S - 10), encoding="utf-8")
        power.request_update()
        (ready / hp.REQUEST_NAME).unlink()
        status.write_text(_status_text(state="failed"), encoding="utf-8")
        power.request_update()

    def test_unavailable_requests_write_nothing(self) -> None:
        ready = _ready_dir(self.base, update=False)
        for power, reason in ((self.power(ready), hp.UPDATE_HELPER_MISSING), (self.power(ready, in_container=False), hp.NOT_DOCKER),
                              (self.power(None), hp.NOT_CONFIGURED)):
            with self.subTest(reason=reason):
                with self.assertRaises(hp.HostPowerRejected) as refused:
                    power.request_update()
                self.assertEqual((refused.exception.code, refused.exception.extra), (hp.HOST_UPDATE_UNAVAILABLE, {"reason": reason}))
        self.assertFalse((ready / hp.REQUEST_NAME).exists())
        other = self.base / "other"
        other.mkdir()
        power = self.power(_ready_dir(other))
        with mock.patch.object(hp.os, "link", side_effect=PermissionError("no")):
            with self.assertRaises(hp.HostPowerRejected) as refused:
                power.request_update()
        self.assertEqual(refused.exception.code, hp.HOST_UPDATE_WRITE_FAILED)

    def test_the_state_file_is_read_safely(self) -> None:
        ready = _ready_dir(self.base)
        power = self.power(ready)
        status = ready / hp.UPDATE_STATUS_NAME
        target = self.base / "elsewhere"
        target.write_text(_status_text(state="ok"), encoding="utf-8")
        status.symlink_to(target)
        self.assertIsNone(power.read_update_status(), "a symlink is never followed")
        status.unlink()
        status.mkdir()
        self.assertIsNone(power.read_update_status())
        status.rmdir()
        status.write_text(_status_text(state="ok", message="y" * (hp.UPDATE_STATUS_MAX_BYTES)), encoding="utf-8")
        self.assertIsNone(power.read_update_status(), "larger than 4 KiB")
        status.write_text(_status_text(state="ok", finished=NOW, to="3.23.0"), encoding="utf-8")
        self.assertEqual(power.update_status()["status"]["to"], "3.23.0")  # type: ignore[index]
        if hasattr(os, "mkfifo"):
            status.unlink()
            os.mkfifo(status)
            self.assertIsNone(power.read_update_status(), "a FIFO is not read")

    def test_decode_update_request(self) -> None:
        hp.decode_update_request(b'{"confirm": true}')
        for raw in (b"", b"[]", b"{", b'{"confirm": true, "confirm": true}', b'{"confirm": true, "version": "3.23.0"}',
                    b"\xff", b"null"):
            with self.subTest(raw=raw):
                with self.assertRaises(hp.HostPowerRejected) as refused:
                    hp.decode_update_request(raw)
                self.assertEqual(refused.exception.code, hp.HOST_UPDATE_INVALID)
        for raw in (b"{}", b'{"confirm": false}', b'{"confirm": 1}', b'{"confirm": "true"}'):
            with self.subTest(raw=raw):
                with self.assertRaises(hp.HostPowerRejected) as refused:
                    hp.decode_update_request(raw)
                self.assertEqual(refused.exception.code, hp.HOST_UPDATE_CONFIRM_REQUIRED)


class ReleasePickTests(unittest.TestCase):
    def test_the_highest_stable_release_of_the_major(self) -> None:
        data = [_release("v4.0.0"), _release("v3.23.0-rc.1", prerelease=True), _release("v3.24.0", draft=True),
                _release("v3.22.1"), _release("v3.23.0"), _release("v3.9.9"), _release("3.30.0"), _release("v3.25.0-rc.2"),
                {"tag_name": "v3.40.0"}, "noise", _release("v2.99.0")]
        self.assertEqual(cr.pick_release(data, 3), {
            "version": "3.23.0", "published_at": "2026-11-16T03:00:00Z",
            "url": "https://github.com/sanadunt/sdr-doa-ground-control/releases/tag/v3.23.0",
        })
        self.assertEqual(cr.pick_release(data, None)["version"], "4.0.0")
        self.assertIsNone(cr.pick_release([_release("v3.1.0", url="https://evil.example/x")], 3)["url"])
        with self.assertRaises(cr.ReleaseCheckError) as missing:
            cr.pick_release([_release("v4.0.0")], 3)
        self.assertEqual(missing.exception.code, cr.NO_RELEASE)
        with self.assertRaises(cr.ReleaseCheckError) as invalid:
            cr.pick_release({"message": "Not Found"}, 3)
        self.assertEqual(invalid.exception.code, cr.INVALID_ANSWER)

    def test_newer(self) -> None:
        for candidate, installed, expected in (
            ("3.23.0", "3.22.0", True), ("3.22.0", "3.22.0", False), ("3.21.9", "3.22.0", False), ("3.22.0", "3.22.0-rc.1", True),
            ("4.0.0", "3.22.0", True), ("3.22.0", "dev", False), ("x", "3.22.0", False), ("3.10.0", "3.9.0", True),
        ):
            with self.subTest(candidate=candidate, installed=installed):
                self.assertEqual(cr.newer(candidate, installed), expected)


class _FakeGitHub(http.server.BaseHTTPRequestHandler):
    status = 200
    body = b"[]"
    headers_out: Dict[str, str] = {}
    seen: List[Tuple[str, Dict[str, str]]] = []

    def do_GET(self) -> None:  # noqa: N802
        type(self).seen.append((self.path, dict(self.headers)))
        self.send_response(type(self).status)
        for key, value in type(self).headers_out.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(type(self).body)))
        self.end_headers()
        self.wfile.write(type(self).body)

    def log_message(self, *args: Any) -> None:
        pass


class ReleaseCheckerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.proxy = mock.patch.dict(os.environ, {"NO_PROXY": "*", "no_proxy": "*"})
        self.proxy.start()
        self.addCleanup(self.proxy.stop)
        for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
            os.environ.pop(key, None)
        _FakeGitHub.status, _FakeGitHub.body, _FakeGitHub.headers_out, _FakeGitHub.seen = 200, b"[]", {}, []
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _FakeGitHub)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.api = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.mono = [100.0]

    def checker(self, installed: str = "3.22.0") -> cr.ReleaseChecker:
        return cr.ReleaseChecker(installed, api=self.api, monotonic=lambda: self.mono[0], clock=lambda: NOW)

    def test_one_anonymous_read_of_the_releases(self) -> None:
        _FakeGitHub.body = json.dumps([_release("v3.23.0"), _release("v3.22.0")]).encode()
        view = self.checker().view()
        self.assertEqual((view["state"], view["version"], view["major"], view["checked_at_ms"]), ("ok", "3.23.0", 3, NOW * 1000))
        path, headers = _FakeGitHub.seen[0]
        self.assertEqual(path, "/repos/sanadunt/sdr-doa-ground-control/releases?per_page=30")
        self.assertEqual(headers["User-Agent"], "SDR-DoA-Ground-Console/3.22.0")
        self.assertEqual(headers["Accept"], "application/vnd.github+json")
        self.assertNotIn("Authorization", headers)
        self.assertNotIn("Cookie", headers)

    def test_failures_have_their_codes(self) -> None:
        cases = (
            (403, {"X-RateLimit-Remaining": "0"}, b"{}", cr.RATE_LIMITED),
            (429, {}, b"{}", cr.RATE_LIMITED),
            (403, {"X-RateLimit-Remaining": "12"}, b"{}", cr.HTTP_ERROR),
            (500, {}, b"oops", cr.HTTP_ERROR),
            (302, {"Location": "https://example.com/"}, b"", cr.HTTP_ERROR),
            (200, {}, b"<html>", cr.INVALID_ANSWER),
            (200, {}, b"[" + b" " * cr.MAX_BYTES + b"]", cr.INVALID_ANSWER),
            (200, {}, json.dumps([_release("v4.1.0")]).encode(), cr.NO_RELEASE),
        )
        for status, headers, body, code in cases:
            with self.subTest(status=status, code=code):
                _FakeGitHub.status, _FakeGitHub.headers_out, _FakeGitHub.body = status, headers, body
                view = self.checker().view()
                self.assertEqual((view["state"], view["code"], view["version"]), ("error", code, None))
                self.assertIsInstance(view["error"], str)
        self.assertEqual(len([path for path, _ in _FakeGitHub.seen if path.startswith("/repos/")]), len(cases), "no redirect followed")

    def test_no_network_is_offline(self) -> None:
        checker = cr.ReleaseChecker("3.22.0", api="http://127.0.0.1:9", monotonic=lambda: self.mono[0])
        view = checker.view()
        self.assertEqual((view["state"], view["code"]), ("error", cr.OFFLINE))
        self.assertIn("not reachable", view["error"])

    def test_answers_are_kept_and_a_refresh_is_bounded(self) -> None:
        calls: List[str] = []
        answers = [json.dumps([_release("v3.23.0")]).encode()]

        def fetch(url: str) -> bytes:
            calls.append(url)
            if not answers:
                raise cr.ReleaseCheckError(cr.OFFLINE, "down")
            return answers[0]

        checker = cr.ReleaseChecker("3.22.0", fetch=fetch, monotonic=lambda: self.mono[0], clock=lambda: NOW)
        checker.view()
        self.mono[0] += cr.REFRESH_MIN_S - 1
        checker.view(refresh=True)
        self.assertEqual(len(calls), 1, "a refresh within 15 s reads nothing")
        self.mono[0] += 1
        checker.view(refresh=True)
        self.assertEqual(len(calls), 2)
        self.mono[0] += cr.OK_TTL_S - 1
        checker.view()
        self.assertEqual(len(calls), 2, "an answer is kept 10 minutes")
        answers.clear()
        self.mono[0] += 1
        self.assertEqual(checker.view()["code"], cr.OFFLINE)
        self.mono[0] += cr.ERROR_TTL_S - 1
        checker.view()
        self.assertEqual(len(calls), 3, "a failure is kept a minute")
        self.mono[0] += 1
        checker.view()
        self.assertEqual(len(calls), 4)

    def test_a_console_without_a_version_takes_any_major(self) -> None:
        checker = cr.ReleaseChecker("dev", fetch=lambda url: json.dumps([_release("v4.0.0"), _release("v3.9.0")]).encode())
        self.assertEqual((checker.view()["version"], checker.major), ("4.0.0", None))
        self.assertEqual(cr.latest_view(None, "3.22.0", True)["state"], "off")


class _FakeChecker:
    def __init__(self, view: Dict[str, Any]) -> None:
        self.answer = view
        self.refreshes: List[bool] = []

    def view(self, refresh: bool = False) -> Dict[str, Any]:
        self.refreshes.append(refresh)
        return dict(self.answer)


class RouteTests(_ServerCase):
    def setUp(self) -> None:
        super().setUp()
        self.server = self.start_server()
        self.port = self.server.server_address[1]
        self.dir = _ready_dir(self.root)
        self.server.host_power = hp.HostPower(self.dir, in_container=True)
        self.server.version = "3.22.0"

    def post(self, body: Any = None, *, origin: Optional[str] = "default", raw: Optional[bytes] = None,
             port: Optional[int] = None) -> Tuple[int, Dict[str, Any]]:
        target = self.port if port is None else port
        headers = [("Content-Type", "application/json")]
        if origin == "default":
            headers.append(("Origin", f"http://127.0.0.1:{target}"))
        elif origin is not None:
            headers.append(("Origin", origin))
        data = raw if raw is not None else json.dumps(body).encode("utf-8")
        status, _headers, answer = _request(target, "POST", hp.UPDATE_ROUTE, headers, data)
        return status, _json(answer)

    def get(self, path: str = hp.UPDATE_ROUTE, headers: Optional[List[Tuple[str, str]]] = None, **kwargs: Any) -> Tuple[int, Dict[str, Any]]:
        status, _headers, answer = _request(self.port, "GET", path, headers or [], **kwargs)
        return status, _json(answer)

    def assert_code(self, result: Tuple[int, Dict[str, Any]], status: int, code: str) -> Dict[str, Any]:
        self.assertEqual(result[0], status, result[1])
        self.assertEqual((result[1]["ok"], result[1]["code"]), (False, code))
        return result[1]

    def entries(self) -> List[str]:
        return sorted(path.name for path in self.dir.iterdir())

    def test_the_view_without_network_access(self) -> None:
        self.assertIsNone(self.server.release_checker, "tests never read GitHub")
        status, body = self.get()
        self.assertEqual(status, 200, body)
        self.assertEqual({key: body[key] for key in ("ok", "installed", "update_available", "helper", "status")}, {
            "ok": True, "installed": "3.22.0", "update_available": False,
            "helper": {"available": True, "reason": None}, "status": None,
        })
        self.assertEqual(body["latest"]["state"], "off")
        self.assertIsInstance(body["now_ms"], int)

    def test_the_view_with_a_newer_release_and_the_last_update(self) -> None:
        checker = _FakeChecker({"state": "ok", "version": "3.23.0", "url": None, "published_at": None, "code": None,
                                "error": None, "checked_at_ms": NOW * 1000, "major": 3})
        self.server.release_checker = checker
        (self.dir / hp.UPDATE_STATUS_NAME).write_text(_status_text(state="rolled_back", message="FAILED: x"), encoding="utf-8")
        status, body = self.get(hp.UPDATE_ROUTE + "?refresh=1")
        self.assertEqual(status, 200)
        self.assertEqual((body["update_available"], body["latest"]["version"]), (True, "3.23.0"))
        self.assertEqual((body["status"]["state"], body["status"]["message"]), ("rolled_back", "FAILED: x"))
        self.get()
        self.assertEqual(checker.refreshes, [True, False])
        checker.answer = {**checker.answer, "version": "3.22.0"}
        self.assertFalse(self.get()[1]["update_available"])
        checker.answer = {**checker.answer, "state": "error", "version": None, "code": cr.OFFLINE, "error": "not reachable"}
        status, body = self.get()
        self.assertEqual((status, body["update_available"], body["latest"]["code"]), (200, False, cr.OFFLINE))

    def test_only_this_console_s_own_pages_read_it(self) -> None:
        for headers, host in (([("Sec-Fetch-Site", "cross-site")], "default"), ([("Sec-Fetch-Site", "same-site")], "default"),
                              ([], f"evil.example:{self.port}"), ([], f"127.0.0.1:{self.port + 1}")):
            with self.subTest(headers=headers, host=host):
                self.assert_code(self.get(headers=headers, host=host), 403, hp.ORIGIN_REJECTED)

    def test_a_confirmed_request_writes_update(self) -> None:
        status, answer = self.post({"confirm": True})
        self.assertEqual(status, 202, answer)
        self.assertEqual(answer["ok"], True)
        self.assertIsInstance(answer["requested_at_ms"], int)
        self.assertEqual((self.dir / hp.REQUEST_NAME).read_bytes(), b"update")
        self.assertIn("host update: requested (installed 3.22.0)", self.output.getvalue())
        self.assert_code(self.post({"confirm": True}), 409, hp.HOST_UPDATE_PENDING)
        (self.dir / hp.REQUEST_NAME).unlink()
        (self.dir / hp.UPDATE_STATUS_NAME).write_text(_status_text(state="running", queued=int(time.time())), encoding="utf-8")
        self.assert_code(self.post({"confirm": True}), 409, hp.HOST_UPDATE_RUNNING)
        self.assertNotIn(hp.REQUEST_NAME, self.entries())

    def test_the_origin_first_then_a_strict_small_body(self) -> None:
        for origin in (None, "null", f"http://localhost:{self.port + 1}", "http://192.168.1.20:8787", "http://evil.example"):
            with self.subTest(origin=origin):
                self.assert_code(self.post({"confirm": True}, origin=origin), 403, hp.ORIGIN_REJECTED)
        self.assert_code(self.post(origin=None, raw=b"not json"), 403, hp.ORIGIN_REJECTED)
        self.assert_code(self.post(raw=b'{"confirm":true}' + b" " * hp.UPDATE_MAX_BODY_BYTES), 413, hp.HOST_UPDATE_TOO_LARGE)
        self.assert_code(self.post(raw=b""), 400, hp.HOST_UPDATE_INVALID)
        self.assert_code(self.post({"confirm": True, "to": "3.23.0"}), 400, hp.HOST_UPDATE_INVALID)
        self.assert_code(self.post({}), 400, hp.HOST_UPDATE_CONFIRM_REQUIRED)
        self.assertNotIn(hp.REQUEST_NAME, self.entries())

    def test_unavailable_is_503_with_its_reason(self) -> None:
        (self.dir / hp.UPDATE_HELPER_NAME).unlink()
        for power, reason in ((hp.HostPower(self.dir, in_container=True), hp.UPDATE_HELPER_MISSING),
                              (hp.HostPower(self.dir, in_container=False), hp.NOT_DOCKER), (hp.HostPower(None), hp.NOT_CONFIGURED)):
            with self.subTest(reason=reason):
                self.server.host_power = power
                answer = self.assert_code(self.post({"confirm": True}), 503, hp.HOST_UPDATE_UNAVAILABLE)
                self.assertEqual(answer["reason"], reason)
                self.assertEqual(self.get()[1]["helper"], {"available": False, "reason": reason})
        self.assertNotIn(hp.REQUEST_NAME, self.entries())

    def test_the_lan_view_never_reaches_either_route(self) -> None:
        lan_port = self.open_lan(self.server)
        self.assertIsNone(lan.lan_route(hp.UPDATE_ROUTE))
        self.assertFalse(lan.write_allowed("POST", hp.UPDATE_ROUTE))
        for origin in ("default", None, f"http://127.0.0.1:{self.port}"):
            with self.subTest(origin=origin):
                status, answer = self.post({"confirm": True}, origin=origin, port=lan_port)
                self.assertEqual((status, answer["code"]), (405, lan.LAN_READ_ONLY))
        status, _headers, raw = _request(lan_port, "GET", hp.UPDATE_ROUTE)
        self.assertEqual((status, _json(raw)["code"]), (403, lan.LAN_READ_ONLY))
        self.assertNotIn(hp.REQUEST_NAME, self.entries())


class WiringTests(unittest.TestCase):
    def test_main_reads_github_and_tests_never_do(self) -> None:
        self.assertIn("release_checker=cr.ReleaseChecker(CONSOLE_VERSION),", GROUND_CONSOLE)
        self.assertIn("release_checker: Optional[cr.ReleaseChecker] = None,", GROUND_CONSOLE)

    def test_codes_stay_out_of_the_kontrol_contract(self) -> None:
        for code in hp.UPDATE_ERROR_CODES:
            if code == hp.ORIGIN_REJECTED:
                continue
            self.assertNotIn(f'"{code}"', GROUND_CONSOLE, "update codes come from host_power.py only")


def _ts_list(name: str) -> List[str]:
    match = re.search(rf"export const {name} = \[([^\]]*)\] as const;", UPDATE_TS)
    assert match is not None, name
    return re.findall(r"'([A-Za-z_]+)'", match.group(1))


def _dictionary_keys(lang_marker: str) -> set:
    if lang_marker == "en":
        block = I18N_TS.split("const en = {", 1)[1].split("\n};", 1)[0]
    else:
        block = I18N_TS.split("const id: Dictionary = {", 1)[1].split("\n};", 1)[0]
    return set(re.findall(r"^  '([^']+)':", block, re.M))


class FrontendContractTests(unittest.TestCase):
    def test_the_frontend_copies_match(self) -> None:
        self.assertEqual(tuple(_ts_list("CONSOLE_UPDATE_REASONS")), hp.UPDATE_REASONS)
        self.assertEqual(tuple(_ts_list("CONSOLE_UPDATE_ERROR_CODES")), hp.UPDATE_ERROR_CODES)
        self.assertEqual(tuple(_ts_list("CONSOLE_UPDATE_STATES")), hp.UPDATE_STATES)
        self.assertEqual(tuple(_ts_list("CONSOLE_UPDATE_PHASES")), hp.UPDATE_PHASES)
        self.assertEqual(tuple(_ts_list("RELEASE_CHECK_CODES")), cr.CODES)
        self.assertIn(f"CONSOLE_UPDATE_ROUTE = '{hp.UPDATE_ROUTE}'", UPDATE_TS)
        self.assertIn(f"UPDATE_STALE_MS = {hp.UPDATE_STALE_S * 1000:_};", UPDATE_TS)

    def test_every_code_reason_and_state_has_en_and_id_text(self) -> None:
        for lang_marker in ("en", "id"):
            keys = _dictionary_keys(lang_marker)
            for code in hp.UPDATE_ERROR_CODES:
                self.assertIn(f"update.error.{code}", keys, lang_marker)
            for reason in hp.UPDATE_REASONS:
                self.assertIn(f"update.reason.{reason}", keys, lang_marker)
            for state in hp.UPDATE_STATES:
                self.assertIn(f"update.state.{state}", keys, lang_marker)
            for phase in hp.UPDATE_PHASES:
                self.assertIn(f"update.phase.{phase}", keys, lang_marker)
            for code in cr.CODES:
                self.assertIn(f"update.latestError.{code}", keys, lang_marker)


if __name__ == "__main__":
    unittest.main()
