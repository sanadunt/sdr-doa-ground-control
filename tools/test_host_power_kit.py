#!/usr/bin/env python3
"""Tests for packaging/host-power: the sdr-doa-host-power helper, its units,
the installer and the uninstaller.

The scripts run with sh against fake commands (systemctl, logger, id,
systemd-tmpfiles) that read one scenario JSON file and log every call, a
temporary request directory and state directory, a fixed clock
(HOST_POWER_NOW) and a fake /proc boot id. PATH holds only the fakes and an
allowlist of harmless real tools, so nothing here can reboot or power off the
machine, and no systemd unit or file outside the temporary directory is touched.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent
KIT = ROOT / "packaging/host-power"
HELPER = KIT / "sdr-doa-host-power"
INSTALL = KIT / "install.sh"
UNINSTALL = KIT / "uninstall.sh"
SCRIPTS = (HELPER, INSTALL, UNINSTALL)
TAG = "sdr-doa-host-power"
SH = shutil.which("dash") or shutil.which("sh") or "/bin/sh"
BOOT = "6f0c1a52-3b9e-4c47-9a1d-2f7e8b5c0d11"
NEXT_BOOT = "0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8"

# Real tools the scripts may use; anything else on PATH is a fake.
REAL_TOOLS = (
    "sh", "dash", "bash", "cat", "sed", "awk", "grep", "tr", "tail", "head", "date", "mv", "rm", "mkdir", "chmod",
    "cp", "ls", "dd", "wc", "mktemp", "dirname", "basename", "rmdir", "env", "touch", "find", "sort", "cut",
)
FAKE_TOOLS = ("systemctl", "logger", "id", "systemd-tmpfiles")

FAKE = r'''
import json
import os
import sys

SCENARIO = os.environ["FAKE_SCENARIO"]
NAME = os.path.basename(sys.argv[0])
ARGS = sys.argv[1:]


def append(path, item):
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(item) + "\n")


with open(SCENARIO, encoding="utf-8") as handle:
    state = json.load(handle)
append(os.environ["FAKE_CALLS"], [NAME] + ARGS)
code = 0
if NAME == "systemctl":
    verb = ARGS[0] if ARGS else ""
    if verb in ("reboot", "poweroff"):
        code = state["power_rc"]
        if code:
            print("Failed to %s system via logind: Access denied" % verb, file=sys.stderr)
    elif verb == "is-active":
        print(state["path_active"])
        code = 0 if state["path_active"] == "active" else 3
elif NAME == "logger":
    tag = ARGS[ARGS.index("-t") + 1]
    priority = ARGS[ARGS.index("-p") + 1]
    rest = [a for i, a in enumerate(ARGS) if a not in ("-t", "-p") and (i == 0 or ARGS[i - 1] not in ("-t", "-p"))]
    append(os.environ["FAKE_LOG"], {"tag": tag, "priority": priority, "message": " ".join(rest)})
elif NAME == "id":
    if ARGS == ["-u"]:
        print(state["uid"])
    elif len(ARGS) == 2 and ARGS[0] in ("-u", "-g"):
        user = state["users"].get(ARGS[1])
        if user is None:
            print("id: '%s': no such user" % ARGS[1], file=sys.stderr)
            code = 1
        else:
            print(user[0 if ARGS[0] == "-u" else 1])
sys.exit(code)
'''


class Harness:
    """A temporary world: fake commands, a request directory, state and a boot id."""

    def __init__(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="test-host-power-")
        self.base = Path(self._tmp.name)
        self.fakebin = self.base / "fakebin"
        self.realbin = self.base / "realbin"
        self.proc = self.base / "proc"
        self.request_dir = self.base / "run/sdr-doa-host-power"
        self.state_dir = self.base / "state"
        self.scenario_path = self.base / "scenario.json"
        self.calls_path = self.base / "calls.jsonl"
        self.log_path = self.base / "log.jsonl"
        for directory in (self.fakebin, self.realbin, self.request_dir):
            directory.mkdir(parents=True)
        (self.request_dir / "helper").write_text("sdr-doa-host-power", encoding="utf-8")
        dispatcher = self.base / "fake.py"
        dispatcher.write_text(f"#!{sys.executable} -IS\n{FAKE}", encoding="utf-8")
        dispatcher.chmod(0o755)
        for name in FAKE_TOOLS:
            (self.fakebin / name).symlink_to(dispatcher)
        for name in REAL_TOOLS:
            found = shutil.which(name)
            if found:
                (self.realbin / name).symlink_to(found)
        self.scenario: Dict[str, object] = {
            "uid": os.geteuid(), "power_rc": 0, "path_active": "active",
            "users": {"rdf": [1000, 1000], "root": [0, 0]},
        }
        self.save()
        self.boot(BOOT)

    def cleanup(self) -> None:
        self._tmp.cleanup()

    def boot(self, boot_id: str) -> None:
        path = self.proc / "sys/kernel/random/boot_id"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{boot_id}\n", encoding="utf-8")

    def save(self) -> None:
        self.scenario_path.write_text(json.dumps(self.scenario), encoding="utf-8")

    def set(self, **values: object) -> None:
        self.scenario.update(values)
        self.save()

    def request(self, content: bytes) -> Path:
        path = self.request_dir / "request"
        path.write_bytes(content)
        return path

    def env(self, **extra: str) -> Dict[str, str]:
        environment = {
            "PATH": f"{self.fakebin}:{self.realbin}",
            "HOME": str(self.base),
            "TMPDIR": str(self.base),
            "LC_ALL": "C",
            "TZ": "UTC",
            "FAKE_SCENARIO": str(self.scenario_path),
            "FAKE_CALLS": str(self.calls_path),
            "FAKE_LOG": str(self.log_path),
            "HOST_POWER_DIR": str(self.request_dir),
            "HOST_POWER_STATE_DIR": str(self.state_dir),
            "HOST_POWER_PROC": str(self.proc),
            "HOST_POWER_ROOT_UID": str(os.geteuid()),
        }
        environment.update(extra)
        return environment

    def run(self, script: Path, *args: str, now: Optional[int] = None, **extra: str) -> subprocess.CompletedProcess:
        environment = self.env(**extra)
        if now is not None:
            environment["HOST_POWER_NOW"] = str(now)
        return subprocess.run([SH, str(script), *args], capture_output=True, text=True, env=environment,
                              cwd=str(self.base), timeout=60)

    def handle(self, now: int = 1_700_000_000, *args: str, **extra: str) -> subprocess.CompletedProcess:
        return self.run(HELPER, *args, "handle", now=now, **extra)

    def calls(self) -> List[List[str]]:
        if not self.calls_path.exists():
            return []
        return [json.loads(line) for line in self.calls_path.read_text(encoding="utf-8").splitlines()]

    def power_calls(self) -> List[List[str]]:
        return [call for call in self.calls() if call[0] == "systemctl" and call[1:2] in (["reboot"], ["poweroff"])]

    def logs(self) -> List[Dict[str, str]]:
        if not self.log_path.exists():
            return []
        return [json.loads(line) for line in self.log_path.read_text(encoding="utf-8").splitlines()]

    def messages(self) -> List[str]:
        return [entry["message"] for entry in self.logs()]

    def clear(self) -> None:
        for path in (self.calls_path, self.log_path):
            if path.exists():
                path.unlink()


class HarnessCase(unittest.TestCase):
    def setUp(self) -> None:
        self.h = Harness()
        self.addCleanup(self.h.cleanup)

    def assert_logged(self, fragment: str) -> None:
        self.assertTrue(any(fragment in message for message in self.h.messages()),
                        f"{fragment!r} not in {self.h.messages()}")


# ---------------------------------------------------------------------------


class HelperTests(HarnessCase):
    def test_nothing_waiting_does_nothing(self):
        result = self.h.handle()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.h.calls(), [["id", "-u"]])
        self.assertEqual(self.h.logs(), [])

    def test_each_word_runs_its_systemctl_verb_after_the_delete(self):
        for index, word in enumerate(("reboot", "poweroff")):
            with self.subTest(word=word):
                self.h.clear()
                self.h.request(word.encode("ascii"))
                result = self.h.handle(now=1_700_000_000 + index * 600)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.h.power_calls(), [["systemctl", word]])
                self.assertFalse((self.h.request_dir / "request").exists())
                self.assert_logged(f"running: systemctl {word} (requested by the console)")
                state = (self.h.state_dir / "last").read_text(encoding="utf-8")
                self.assertIn(f"ACTION={word}\n", state)
                self.assertIn(f"BOOT_ID={BOOT}\n", state)
        self.assertTrue((self.h.request_dir / "helper").exists(), "the marker stays")

    def test_anything_but_the_two_words_is_deleted_and_refused(self):
        for content in (b"halt", b"reboot\n", b"REBOOT", b"", b" reboot", b"reboot poweroff", b"poweroffx",
                        b"reboot\x00", b"r" * 4096, b"systemctl reboot"):
            with self.subTest(content=content[:20]):
                self.h.clear()
                self.h.request(content)
                result = self.h.handle()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.h.power_calls(), [])
                self.assertFalse((self.h.request_dir / "request").exists())
                self.assert_logged("refused a request: it does not hold exactly reboot or poweroff")
                # The content is never logged.
                for message in self.h.messages():
                    self.assertNotIn("halt", message)
                    self.assertNotIn("rrrr", message)
        self.assertFalse((self.h.state_dir / "last").exists())

    def test_a_symlink_is_removed_and_its_target_left_alone(self):
        target = self.h.base / "precious"
        target.write_text("reboot", encoding="utf-8")
        (self.h.request_dir / "request").symlink_to(target)
        result = self.h.handle()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.h.power_calls(), [])
        self.assertFalse(os.path.lexists(self.h.request_dir / "request"))
        self.assertEqual(target.read_text(encoding="utf-8"), "reboot")
        self.assert_logged("refused a request: it is not a regular file")

    def test_a_request_that_cannot_be_deleted_is_never_acted_on(self):
        # A directory: rm -f cannot remove it, as root either.
        (self.h.request_dir / "request").mkdir()
        (self.h.request_dir / "request" / "x").write_text("reboot", encoding="utf-8")
        result = self.h.handle()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.h.power_calls(), [])
        self.assert_logged("cannot delete")
        self.assertEqual([entry["priority"] for entry in self.h.logs()], ["daemon.err"])

    def test_a_repeat_within_the_window_of_the_same_boot_is_refused(self):
        self.h.request(b"reboot")
        self.assertEqual(self.h.handle(now=1_700_000_000).returncode, 0)
        self.h.clear()
        self.h.request(b"poweroff")
        result = self.h.handle(now=1_700_000_059)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.h.power_calls(), [])
        self.assertFalse((self.h.request_dir / "request").exists(), "a refused request is deleted too")
        self.assert_logged("refused poweroff: reboot ran 59 s ago, less than 60 s")
        # At 60 s it runs.
        self.h.clear()
        self.h.request(b"poweroff")
        self.assertEqual(self.h.handle(now=1_700_000_060).returncode, 0)
        self.assertEqual(self.h.power_calls(), [["systemctl", "poweroff"]])

    def test_a_new_boot_or_a_clock_that_went_back_ends_the_window(self):
        self.h.request(b"reboot")
        self.assertEqual(self.h.handle(now=1_700_000_000).returncode, 0)
        self.h.boot(NEXT_BOOT)
        self.h.clear()
        self.h.request(b"reboot")
        self.assertEqual(self.h.handle(now=1_700_000_030).returncode, 0)
        self.assertEqual(self.h.power_calls(), [["systemctl", "reboot"]], "the machine did restart")
        self.h.clear()
        self.h.request(b"poweroff")
        self.assertEqual(self.h.handle(now=1_699_999_000).returncode, 0)
        self.assertEqual(self.h.power_calls(), [["systemctl", "poweroff"]], "a stamp later than now does not block")

    def test_a_failed_systemctl_is_reported(self):
        self.h.set(power_rc=1)
        self.h.request(b"poweroff")
        result = self.h.handle()
        self.assertEqual(result.returncode, 1)
        self.assert_logged("systemctl poweroff failed: Failed to poweroff system via logind: Access denied")

    def test_dry_run_logs_and_keeps_its_own_state(self):
        self.h.request(b"reboot")
        result = self.h.handle(1_700_000_000, "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.h.power_calls(), [])
        self.assert_logged("dry-run: would run: systemctl reboot (requested by the console)")
        self.assertFalse((self.h.request_dir / "request").exists())
        self.assertTrue((self.h.state_dir / "last.dry-run").exists())
        self.assertFalse((self.h.state_dir / "last").exists(), "a live request right after is not refused")
        self.h.request(b"reboot")
        self.assertEqual(self.h.handle(1_700_000_010).returncode, 0)
        self.assertEqual(self.h.power_calls(), [["systemctl", "reboot"]])

    def test_handle_needs_root(self):
        self.h.request(b"reboot")
        result = self.h.handle(HOST_POWER_ROOT_UID="0") if os.geteuid() != 0 else self.h.handle(HOST_POWER_ROOT_UID="12345")
        self.assertEqual(result.returncode, 1)
        self.assertIn("run as root (sudo sdr-doa-host-power handle)", result.stderr)
        self.assertEqual(self.h.power_calls(), [])
        self.assertTrue((self.h.request_dir / "request").exists(), "left for the root service")

    def test_every_message_has_the_fixed_tag_and_stays_off_stderr_in_a_unit(self):
        self.h.request(b"reboot")
        result = self.h.handle(INVOCATION_ID="0123456789abcdef")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        self.assertEqual({entry["tag"] for entry in self.h.logs()}, {TAG})
        self.h.request(b"poweroff")
        result = self.h.handle(now=1_700_000_100)
        self.assertIn(f"{TAG}: running: systemctl poweroff", result.stderr)

    def test_status(self):
        result = self.h.run(HELPER, "status")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"request directory: {self.h.request_dir}\n", result.stdout)
        self.assertIn("helper marker: present", result.stdout)
        self.assertIn("waiting request: no", result.stdout)
        self.assertIn("last action: none", result.stdout)
        self.assertIn("sdr-doa-host-power.path: active", result.stdout)
        self.h.request(b"reboot")
        self.assertEqual(self.h.handle(now=1_700_000_000).returncode, 0)
        self.h.request(b"poweroff")
        result = self.h.run(HELPER, "status")
        self.assertIn("waiting request: yes", result.stdout)
        self.assertIn("last action: reboot at ", result.stdout)
        self.assertIn("(this boot)", result.stdout)
        self.h.boot(NEXT_BOOT)
        self.assertIn("(an earlier boot)", self.h.run(HELPER, "status").stdout)
        if os.geteuid() != 0:
            # 0700 for the console's user: another user cannot see the marker.
            self.h.request_dir.chmod(0o600)
            try:
                result = self.h.run(HELPER, "status")
            finally:
                self.h.request_dir.chmod(0o700)
            self.assertIn("contents: not readable by this user (sudo sdr-doa-host-power status)", result.stdout)
            self.assertNotIn("helper marker: missing", result.stdout)
        shutil.rmtree(self.h.request_dir)
        self.assertIn("missing (sudo systemd-tmpfiles --create", self.h.run(HELPER, "status").stdout)

    def test_bad_command_line(self):
        for args, code in ((["frobnicate"], 1), ([], 64), (["--bogus", "handle"], 1), (["handle", "status"], 64)):
            with self.subTest(args=args):
                self.assertEqual(self.h.run(HELPER, *args).returncode, code)
        self.assertIn("Usage: sdr-doa-host-power", self.h.run(HELPER, "--help").stdout)


# ---------------------------------------------------------------------------


class InstallerTests(HarnessCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = self.h.base / "root"
        self.root.mkdir()
        # Root-only, as the installer requires of the tree it runs programs
        # from, whatever the umask of the test run.
        self.root.chmod(0o755)

    def install(self, *args: str) -> subprocess.CompletedProcess:
        return self.h.run(INSTALL, "--root", str(self.root), *args)

    def files(self) -> set:
        return {str(path.relative_to(self.root)) for path in self.root.rglob("*") if path.is_file()}

    def read(self, name: str) -> str:
        return (self.root / name).read_text(encoding="utf-8")

    def test_install_writes_only_its_own_files(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.files(), {
            "usr/local/sbin/sdr-doa-host-power",
            "usr/local/share/sdr-doa-host-power/README.md",
            "usr/local/share/sdr-doa-host-power/uninstall.sh",
            "usr/local/share/sdr-doa-host-power/install-info",
            "etc/systemd/system/sdr-doa-host-power.path",
            "etc/systemd/system/sdr-doa-host-power.service",
            "etc/tmpfiles.d/sdr-doa-host-power.conf",
        })
        for name in ("usr/local/sbin/sdr-doa-host-power", "usr/local/share/sdr-doa-host-power/uninstall.sh"):
            self.assertEqual(stat.S_IMODE((self.root / name).stat().st_mode), 0o755, name)
        for name in ("etc/systemd/system/sdr-doa-host-power.path", "etc/systemd/system/sdr-doa-host-power.service",
                     "etc/tmpfiles.d/sdr-doa-host-power.conf", "usr/local/share/sdr-doa-host-power/install-info"):
            self.assertEqual(stat.S_IMODE((self.root / name).stat().st_mode), 0o644, name)
        service = self.read("etc/systemd/system/sdr-doa-host-power.service")
        self.assertIn("ExecStart=/usr/local/sbin/sdr-doa-host-power handle\n", service)
        self.assertIn("Type=oneshot\n", service)
        self.assertIn("SyslogIdentifier=sdr-doa-host-power\n", service)
        self.assertNotIn("[Install]", service, "started by the path unit only")
        path_unit = self.read("etc/systemd/system/sdr-doa-host-power.path")
        self.assertIn("PathExists=/run/sdr-doa-host-power/request\n", path_unit)
        self.assertIn("Unit=sdr-doa-host-power.service\n", path_unit)
        self.assertIn("WantedBy=paths.target\n", path_unit)
        tmpfiles = self.read("etc/tmpfiles.d/sdr-doa-host-power.conf")
        self.assertIn("\nd /run/sdr-doa-host-power 0700 10001 10001 -\n", tmpfiles)
        self.assertIn("\nf /run/sdr-doa-host-power/helper 0644 root root - sdr-doa-host-power\n", tmpfiles)
        for text in (service, path_unit, tmpfiles):
            self.assertNotRegex(text, r"@[A-Z_]+@")
            self.assertIn("packaging/host-power", text)
        info = self.read("usr/local/share/sdr-doa-host-power/install-info")
        for line in ("CONSOLE_UID=10001\n", "CONSOLE_GID=10001\n", "HELPER_DRY_RUN=0\n", "REQUEST_DIR=/run/sdr-doa-host-power\n"):
            self.assertIn(line, info)
        self.assertIn("skipped (--root): systemd-tmpfiles --create /etc/tmpfiles.d/sdr-doa-host-power.conf", result.stdout)
        self.assertIn("skipped (--root): systemctl daemon-reload", result.stdout)
        self.assertIn("skipped (--root): systemctl enable --now sdr-doa-host-power.path", result.stdout)
        self.assertEqual([call for call in self.h.calls() if call[0] in ("systemctl", "systemd-tmpfiles")], [])

    def test_the_console_gets_one_directory_and_nothing_else(self):
        for path in KIT.iterdir():
            if path.name == "README.md":
                continue
            text = path.read_text(encoding="utf-8")
            for forbidden in ("docker.sock", "/etc/polkit-1", "/etc/sudoers", "dbus-send", "busctl", "ufw ", "iptables",
                              "nft ", "firewall-cmd", "chmod 0777", "chmod 777", "setcap", "0777 ", "0666 "):
                self.assertNotIn(forbidden, text, f"{path.name} names {forbidden}")
        # The helper calls systemctl only inside $(...): with the request's word
        # (reboot or poweroff, checked above it) and for a status read.
        helper = HELPER.read_text(encoding="utf-8")
        self.assertEqual(set(re.findall(r"\$\(systemctl ([^\s)]+)", helper)), {'"$word"', "is-active"})
        self.assertEqual([line for line in helper.splitlines() if re.match(r"\s*(?:if !?\s*)?systemctl\b", line)], [])

    def test_native_console_user(self):
        result = self.install("--console-user", "rdf")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("\nd /run/sdr-doa-host-power 0700 1000 1000 -\n", self.read("etc/tmpfiles.d/sdr-doa-host-power.conf"))
        self.assertIn("CONSOLE_USER=rdf\n", self.read("usr/local/share/sdr-doa-host-power/install-info"))
        for user, fragment in (("root", "must not be root"), ("0", "must not be root"), ("nobody-here", "does not exist"),
                               ("a b", "not a user name"), ("-x", "not a user name")):
            with self.subTest(user=user):
                result = self.install("--console-user", user)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(fragment, result.stderr)

    def test_helper_mode_is_kept_until_changed(self):
        self.assertEqual(self.install("--helper-dry-run").returncode, 0)
        service = "etc/systemd/system/sdr-doa-host-power.service"
        self.assertIn("ExecStart=/usr/local/sbin/sdr-doa-host-power --dry-run handle\n", self.read(service))
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--dry-run handle", self.read(service), "a re-run keeps the mode")
        self.assertIn("dry run: it logs the action and runs none", result.stdout)
        self.assertEqual(self.install("--helper-live").returncode, 0)
        self.assertIn("ExecStart=/usr/local/sbin/sdr-doa-host-power handle\n", self.read(service))
        self.assertIn("HELPER_DRY_RUN=0\n", self.read("usr/local/share/sdr-doa-host-power/install-info"))

    def test_refuses_to_replace_a_foreign_file(self):
        foreign = self.root / "etc/tmpfiles.d/sdr-doa-host-power.conf"
        foreign.parent.mkdir(parents=True)
        foreign.write_text("d /run/other 0777 root root -\n", encoding="utf-8")
        result = self.install()
        self.assertEqual(result.returncode, 1)
        self.assertIn("was not written by this installer", result.stderr)
        self.assertEqual(foreign.read_text(encoding="utf-8"), "d /run/other 0777 root root -\n")

    def test_refuses_a_prefix_others_can_change(self):
        opt = self.root / "opt"
        opt.mkdir(mode=0o755)
        opt.chmod(0o775)
        result = self.install("--prefix", "/opt/power")
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"{opt} is not owned by root or is writable by another user", result.stderr)
        self.assertFalse((opt / "power").exists(), "refused before anything was written")
        opt.chmod(0o755)
        self.assertEqual(self.install("--prefix", "/opt/power").returncode, 0)
        self.assertIn("ExecStart=/opt/power/sbin/sdr-doa-host-power handle",
                      self.read("etc/systemd/system/sdr-doa-host-power.service"))

    def test_directories_are_readable_under_a_strict_umask(self):
        previous = os.umask(0o027)
        try:
            result = self.install()
        finally:
            os.umask(previous)
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ("etc/tmpfiles.d", "usr/local/sbin", "usr/local/share/sdr-doa-host-power", "etc/systemd/system"):
            self.assertEqual(stat.S_IMODE((self.root / name).stat().st_mode), 0o755, name)

    def test_dry_run_changes_nothing_and_shows_the_refusals(self):
        self.h.set(uid=1000)
        prefix = self.h.base / "prefix"
        result = self.h.run(INSTALL, "--dry-run", "--prefix", str(prefix))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(prefix.exists())
        self.assertIn("would run: systemd-tmpfiles --create /etc/tmpfiles.d/sdr-doa-host-power.conf", result.stdout)
        self.assertIn("would run: systemctl enable --now sdr-doa-host-power.path", result.stdout)
        self.assertIn(f"ExecStart={prefix}/sbin/sdr-doa-host-power handle", result.stdout)
        self.assertIn("d /run/sdr-doa-host-power 0700 10001 10001 -", result.stdout)
        self.assertIn("Dry run: nothing was changed.\n", result.stdout)
        self.assertEqual([call for call in self.h.calls() if call[0] in ("systemctl", "systemd-tmpfiles")], [])
        foreign = self.root / "etc/systemd/system/sdr-doa-host-power.path"
        foreign.parent.mkdir(parents=True)
        foreign.write_text("[Path]\nPathExists=/tmp/x\n", encoding="utf-8")
        result = self.install("--dry-run")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("the install would stop here", result.stderr)
        self.assertIn("The install would stop: see the warnings.", result.stdout)
        self.assertEqual(self.files(), {"etc/systemd/system/sdr-doa-host-power.path"})

    def test_bad_options_and_root_check(self):
        for args, fragment in ((["--prefix", "usr"], "absolute path"), (["--prefix", "/"], "must not be /"),
                               (["--prefix", "/opt/a'b"], "may hold only"), (["--bogus"], "unknown option"),
                               (["--console-user"], "needs a value")):
            with self.subTest(args=args):
                result = self.install(*args)
                self.assertEqual(result.returncode, 1, args)
                self.assertIn(fragment, result.stderr)
        self.h.set(uid=1000)
        result = self.h.run(INSTALL)
        self.assertEqual(result.returncode, 1)
        self.assertIn("run as root", result.stderr)

    def test_uninstall_removes_only_its_files_and_the_marker(self):
        self.assertEqual(self.install().returncode, 0)
        request_dir = self.root / "run/sdr-doa-host-power"
        request_dir.mkdir(parents=True)
        (request_dir / "helper").write_text("sdr-doa-host-power", encoding="utf-8")
        (request_dir / "request").write_text("reboot", encoding="utf-8")
        state = self.root / "var/lib/sdr-doa-host-power"
        state.mkdir(parents=True)
        (state / "last").write_text("ACTION=reboot\n", encoding="utf-8")
        foreign = self.root / "usr/local/sbin/sdr-doa-host-power"
        foreign.write_text("#!/bin/sh\necho mine\n", encoding="utf-8")
        script = self.root / "usr/local/share/sdr-doa-host-power/uninstall.sh"
        result = self.h.run(script, "--root", str(self.root))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("kept /usr/local/sbin/sdr-doa-host-power: not written by the sdr-doa-host-power installer", result.stdout)
        self.assertEqual(self.files(), {"var/lib/sdr-doa-host-power/last", "usr/local/sbin/sdr-doa-host-power"})
        self.assertTrue(request_dir.is_dir(), "a container's bind mount may hold it")
        foreign.unlink()
        self.assertEqual(self.install().returncode, 0)
        result = self.h.run(script, "--root", str(self.root), "--purge")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.files(), set())

    def test_uninstall_dry_run(self):
        self.assertEqual(self.install().returncode, 0)
        before = self.files()
        script = self.root / "usr/local/share/sdr-doa-host-power/uninstall.sh"
        result = self.h.run(script, "--root", str(self.root), "--dry-run", "--purge")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("would run: systemctl disable --now sdr-doa-host-power.path", result.stdout)
        self.assertIn("would remove /etc/tmpfiles.d/sdr-doa-host-power.conf", result.stdout)
        self.assertIn("would remove /run/sdr-doa-host-power/helper", result.stdout)
        self.assertEqual(self.files(), before)

    def test_the_installed_helper_takes_a_request(self):
        """The installed copy works with the unit's own command line."""
        self.assertEqual(self.install().returncode, 0)
        service = self.read("etc/systemd/system/sdr-doa-host-power.service")
        command = next(line for line in service.splitlines() if line.startswith("ExecStart=")).split("=", 1)[1].split()
        self.assertEqual(command[0], "/usr/local/sbin/sdr-doa-host-power")
        self.h.request(b"poweroff")
        result = self.h.run(self.root / command[0].lstrip("/"), *command[1:], now=1_700_000_000)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.h.power_calls(), [["systemctl", "poweroff"]])


# ---------------------------------------------------------------------------


class ScriptLintTests(unittest.TestCase):
    def test_shell_syntax_and_modes(self):
        shells = [shell for shell in ("sh", "bash", "dash") if shutil.which(shell)]
        self.assertTrue(shells)
        for script in SCRIPTS:
            for shell in shells:
                result = subprocess.run([shell, "-n", str(script)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, f"{shell} -n {script.name}: {result.stderr}")
            self.assertTrue(os.access(script, os.X_OK), f"{script.name} is not executable")
            self.assertTrue(script.read_text(encoding="utf-8").startswith("#!/bin/sh\n"), script.name)
        for name in ("sdr-doa-host-power.path.in", "sdr-doa-host-power.service.in", "sdr-doa-host-power.tmpfiles.in", "README.md"):
            self.assertFalse(os.access(KIT / name, os.X_OK), name)

    def test_shellcheck(self):
        shellcheck = os.environ.get("SHELLCHECK") or shutil.which("shellcheck")
        if not shellcheck:
            self.skipTest("shellcheck is not installed (CI lints the scripts in its lint step)")
        result = subprocess.run([shellcheck, "-s", "sh", *map(str, SCRIPTS)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_ci_and_docs_lint_every_script(self):
        ci = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        claude = (ROOT / "CLAUDE.md").read_text(encoding="utf-8")
        line = next(text for text in ci.splitlines() if text.strip().startswith("shellcheck -s sh"))
        docs = next(text for text in claude.splitlines() if text.startswith("shellcheck -s sh"))
        for script in SCRIPTS:
            name = str(script.relative_to(ROOT))
            self.assertIn(name, line)
            self.assertIn(name, docs)


if __name__ == "__main__":
    unittest.main()
