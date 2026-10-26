#!/usr/bin/env python3
"""Tests for packaging/ground-link: t900-ground-diag, t900-ground-watchdog,
t900-link, the installer and the uninstaller.

The scripts run with sh against fake commands (systemctl, journalctl, ip,
ping, lsusb, udevadm, usbreset, uhubctl, logger, sleep, id, dmesg, pkaction
and a relay switch) that read one scenario JSON file and log every call, a
fake sysfs, a fixed clock (T900_LINK_NOW) and temporary config and state
paths. PATH holds only the fakes and an allowlist of harmless real tools, so
nothing here can restart a service, reset a USB device or read the real
journal; no systemd, network or file outside the temporary directory is
touched.
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
GROUND = ROOT / "packaging/ground-link"
DIAG = GROUND / "t900-ground-diag"
WATCHDOG = GROUND / "t900-ground-watchdog"
LINK = GROUND / "t900-link"
INSTALL = GROUND / "install.sh"
UNINSTALL = GROUND / "uninstall.sh"
SCRIPTS = (DIAG, WATCHDOG, LINK, INSTALL, UNINSTALL)
TAG = "t900-ground-watchdog"
SERVICE = "t900-ground-ppp.service"
SH = shutil.which("dash") or shutil.which("sh") or "/bin/sh"

# Real tools the scripts may use; anything else on PATH is a fake.
REAL_TOOLS = (
    "sh", "dash", "bash", "cat", "sed", "awk", "grep", "tr", "tail", "head", "date", "readlink", "mv", "rm",
    "mkdir", "chmod", "cp", "ls", "find", "timeout", "uname", "uptime", "basename", "dirname", "mktemp",
    "rmdir", "env", "sort", "wc", "cut", "touch",
)
FAKE_TOOLS = (
    "systemctl", "journalctl", "ip", "ping", "lsusb", "udevadm", "usbreset", "uhubctl", "logger", "sleep",
    "id", "dmesg", "pkaction", "relay",
)

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


def kernel_lines():
    lines = []
    for i in range(40):
        lines.append("2026-10-26T10:%02d:00+0700 ground kernel: usb 3-2: ch341-uart converter now attached to ttyUSB0 (%d)" % (i, i))
        if i % 8 == 0:
            lines.append("2026-10-26T10:%02d:30+0700 ground kernel: e1000e: eth0 NIC Link is Up" % i)
    return lines


def fix(state, action):
    if state.get("fix_on") == action:
        state["iface"] = {"ifindex": state["next_ifindex"], "addr": "10.90.0.1"}
        state["next_ifindex"] += 1
        state["ping"] = True


with open(SCENARIO, encoding="utf-8") as handle:
    state = json.load(handle)
append(os.environ["FAKE_CALLS"], [NAME] + ARGS)
iface = state.get("iface")
code = 0
words = [a for a in ARGS if not a.startswith("-")]

if NAME == "systemctl":
    verb = words[0] if words else ""
    unit = words[-1] if len(words) > 1 else ""
    if verb == "is-enabled":
        print(state["enabled"])
        code = 0 if state["enabled"] in ("enabled", "static") else 1
    elif verb == "show":
        values = {"ActiveState": state["active"], "SubState": state["sub"], "Result": "success",
                  "NRestarts": "12", "ExecMainStartTimestamp": "Mon 2026-10-26 10:44:05 WIB"}
        for i, arg in enumerate(ARGS):
            if arg == "-p":
                prop = ARGS[i + 1]
                print(values.get(prop, "") if "--value" in ARGS else "%s=%s" % (prop, values.get(prop, "")))
    elif verb == "status":
        print("* %s - T900 PPP link\n     Active: %s (%s)" % (unit, state["active"], state["sub"]))
        code = 0 if state["active"] == "active" else 3
    elif verb == "restart":
        code = state["restart_rc"]
        if code == 0:
            fix(state, "restart")
    elif verb == "start":
        code = state["start_rc"]
    elif verb == "cat":
        code = 0 if unit in state["units"] else 1
    elif verb == "list-timers":
        print("NEXT LEFT LAST PASSED UNIT ACTIVATES")
elif NAME == "ip":
    if "link" in ARGS:
        if iface:
            print("%d: ppp0: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UNKNOWN "
                  "mode DEFAULT group default qlen 3\\    link/ppp" % iface["ifindex"])
        else:
            sys.stderr.write('Device "ppp0" does not exist.\n')
            code = 1
    elif "addr" in ARGS:
        if not iface:
            sys.stderr.write('Device "ppp0" does not exist.\n')
            code = 1
        elif "-o" in ARGS:
            if iface.get("addr"):
                print("%d: ppp0    inet %s peer 10.90.0.2/32 scope global ppp0\\       valid_lft forever "
                      "preferred_lft forever" % (iface["ifindex"], iface["addr"]))
        else:
            print("%d: ppp0: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 1500" % iface["ifindex"])
            print("    link/ppp")
            if iface.get("addr"):
                print("    inet %s peer 10.90.0.2/32 scope global ppp0" % iface["addr"])
    elif "route" in ARGS:
        if iface and iface.get("addr"):
            print("10.90.0.2 dev ppp0 src %s uid 0" % iface["addr"])
        else:
            print("10.90.0.2 via 192.168.1.1 dev eth0 src 192.168.1.10 uid 0")
elif NAME == "ping":
    count = int(ARGS[ARGS.index("-c") + 1])
    ok = bool(iface and iface.get("addr") and state["ping"])
    print("--- 10.90.0.2 ping statistics ---")
    print("%d packets transmitted, %d received, %s packet loss, time 2003ms"
          % (count, count if ok else 0, "0%" if ok else "100%"))
    code = 0 if ok else 1
elif NAME == "journalctl":
    if "-k" in ARGS:
        print("\n".join(kernel_lines()))
    elif "-u" in ARGS:
        n = int(ARGS[ARGS.index("-n") + 1])
        for i in range(n):
            print("2026-10-26T10:44:%02d+0700 ground pppd[812]: LCP: timeout sending Config-Requests (%d)" % (i % 60, i))
    elif "-t" in ARGS:
        print("journal of tag %s, %s lines" % (ARGS[ARGS.index("-t") + 1], ARGS[ARGS.index("-n") + 1]))
elif NAME == "lsusb":
    if state["usb"]:
        print("Bus 003 Device 005: ID 1a86:7523 QinHeng Electronics CH340 serial converter")
    else:
        code = 1
elif NAME == "udevadm":
    print("P: /devices/pci0000:00/usb3/3-2/3-2:1.0/ttyUSB0/tty/ttyUSB0\nN: ttyUSB0\nS: t900-ground\nE: ID_VENDOR_ID=1a86")
elif NAME == "usbreset":
    code = state["usbreset_rc"]
    if code == 0:
        print("Resetting CH340 serial converter ... ok")
        fix(state, "usb")
elif NAME == "uhubctl":
    fix(state, "power")
elif NAME == "relay":
    if ARGS == ["on"]:
        fix(state, "power")
elif NAME == "logger":
    tag = ARGS[ARGS.index("-t") + 1]
    priority = ARGS[ARGS.index("-p") + 1]
    rest = [a for i, a in enumerate(ARGS) if a not in ("-t", "-p") and (i == 0 or ARGS[i - 1] not in ("-t", "-p"))]
    append(os.environ["FAKE_LOG"], {"tag": tag, "priority": priority, "message": " ".join(rest)})
elif NAME == "id":
    if ARGS == ["-u"]:
        print(state["uid"])
    elif ARGS == ["-un"]:
        print(state["user"])
    elif ARGS == ["-Gn"]:
        print(state["groups"])
    elif len(ARGS) == 1:
        code = 0 if ARGS[0] in state["users"] else 1
elif NAME == "dmesg":
    if int(state["uid"]) != 0:
        sys.stderr.write("dmesg: read kernel buffer failed: Operation not permitted\n")
        code = 1
    else:
        print("\n".join(line.split(" kernel: ", 1)[1] for line in kernel_lines()))
elif NAME == "pkaction":
    print(state["pkaction"])

tmp = SCENARIO + ".tmp"
with open(tmp, "w", encoding="utf-8") as handle:
    json.dump(state, handle)
os.replace(tmp, SCENARIO)
sys.exit(code)
'''


class Harness:
    """A temporary world: fake commands, sysfs, device node, config and state."""

    def __init__(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="test-ground-link-")
        self.base = Path(self._tmp.name)
        self.fakebin = self.base / "fakebin"
        self.realbin = self.base / "realbin"
        self.sysfs = self.base / "sys"
        self.dev = self.base / "dev"
        self.state_dir = self.base / "state"
        self.config = self.base / "link.conf"
        self.out = self.base / "out"
        self.scenario_path = self.base / "scenario.json"
        self.calls_path = self.base / "calls.jsonl"
        self.log_path = self.base / "log.jsonl"
        for directory in (self.fakebin, self.realbin, self.dev, self.out):
            directory.mkdir()
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
            "uid": os.geteuid(), "user": "root", "groups": "root", "users": ["root", "rdf"],
            "enabled": "enabled", "active": "active", "sub": "running",
            "iface": {"ifindex": 7, "addr": "10.90.0.1"}, "ping": True, "usb": True,
            "restart_rc": 0, "start_rc": 0, "usbreset_rc": 0, "fix_on": None, "next_ifindex": 20,
            "units": [SERVICE], "pkaction": "pkaction version 124",
        }
        self.save()
        self.add_usb("3-2", bus=3, num=5, tty="ttyUSB0")
        (self.dev / "ttyUSB0").write_text("", encoding="utf-8")
        (self.dev / "t900-ground").symlink_to(self.dev / "ttyUSB0")
        (self.sysfs / "bus/usb/drivers/ch341").mkdir(parents=True)
        for name in ("bind", "unbind"):
            (self.sysfs / "bus/usb/drivers/ch341" / name).write_text("", encoding="utf-8")
        self.write_config()

    def cleanup(self) -> None:
        self._tmp.cleanup()

    # -- world ---------------------------------------------------------------

    def add_usb(self, name: str, bus: int, num: int, tty: str, ids: str = "1a86:7523") -> None:
        """One CH340 the way sysfs shows a usb-serial adapter."""
        device = self.sysfs / "devices/pci0000:00/usb3" / name
        interface = device / f"{name}:1.0"
        port = interface / tty
        tty_class = port / "tty" / tty
        tty_class.mkdir(parents=True)
        vendor, product = ids.split(":")
        for key, value in (("idVendor", vendor), ("idProduct", product), ("busnum", bus), ("devnum", num)):
            (device / key).write_text(f"{value}\n", encoding="utf-8")
        (tty_class / "device").symlink_to(port)
        (interface / "driver").symlink_to(self.sysfs / "bus/usb/drivers/ch341")
        for directory in (self.sysfs / "bus/usb/devices", self.sysfs / "class/tty"):
            directory.mkdir(parents=True, exist_ok=True)
        (self.sysfs / "bus/usb/devices" / name).symlink_to(device)
        (self.sysfs / "bus/usb/devices" / f"{name}:1.0").symlink_to(interface)
        (self.sysfs / "class/tty" / tty).symlink_to(tty_class)

    def save(self) -> None:
        self.scenario_path.write_text(json.dumps(self.scenario), encoding="utf-8")

    def set(self, **values: object) -> None:
        self.scenario = json.loads(self.scenario_path.read_text(encoding="utf-8"))
        self.scenario.update(values)
        self.save()

    def write_config(self, text: Optional[str] = None, **values: object) -> None:
        settings = {
            "PPP_DEVICE": str(self.dev / "t900-ground"),
            "FAIL_AFTER": 60,
            "BACKOFF_BASE": 60,
            "BACKOFF_MAX": 240,
            "MAX_ACTIONS_PER_HOUR": 4,
        }
        settings.update(values)
        if text is None:
            text = "".join(f"{key}={value}\n" for key, value in settings.items())
        if self.config.exists():
            self.config.unlink()
        self.config.write_text(text, encoding="utf-8")
        self.config.chmod(0o644)

    def remove_tool(self, name: str) -> None:
        (self.fakebin / name).unlink()

    # -- running -------------------------------------------------------------

    def env(self, **extra: str) -> Dict[str, str]:
        environment = {
            "PATH": f"{self.fakebin}:{self.realbin}",
            "HOME": str(self.base),
            "LC_ALL": "C",
            "TZ": "UTC",
            "FAKE_SCENARIO": str(self.scenario_path),
            "FAKE_CALLS": str(self.calls_path),
            "FAKE_LOG": str(self.log_path),
            "T900_LINK_CONFIG": str(self.config),
            "T900_LINK_STATE_DIR": str(self.state_dir),
            "T900_LINK_SYSFS": str(self.sysfs),
            "T900_LINK_ROOT_UID": str(os.geteuid()),
        }
        environment.update(extra)
        return environment

    def run(self, script: Path, *args: str, now: Optional[int] = None, **extra: str) -> subprocess.CompletedProcess:
        environment = self.env(**extra)
        if now is not None:
            environment["T900_LINK_NOW"] = str(now)
        return subprocess.run([SH, str(script), *args], capture_output=True, text=True, env=environment,
                              cwd=str(self.base), timeout=120)

    def check(self, now: int, *args: str) -> subprocess.CompletedProcess:
        result = self.run(WATCHDOG, *args, "check", now=now)
        assert result.returncode == 0, result.stderr
        return result

    # -- what happened ---------------------------------------------------------

    def calls(self) -> List[List[str]]:
        if not self.calls_path.exists():
            return []
        return [json.loads(line) for line in self.calls_path.read_text(encoding="utf-8").splitlines()]

    def clear_calls(self) -> None:
        if self.calls_path.exists():
            self.calls_path.unlink()
        if self.log_path.exists():
            self.log_path.unlink()

    def actions(self) -> List[List[str]]:
        """Calls that change something: restarts, starts, USB and power."""
        changing = []
        for call in self.calls():
            name, args = call[0], call[1:]
            if name == "systemctl" and args and args[0] in ("restart", "start", "stop", "reset-failed",
                                                             "enable", "disable", "daemon-reload"):
                changing.append(call)
            elif name in ("usbreset", "uhubctl", "relay"):
                changing.append(call)
        return changing

    def logs(self) -> List[Dict[str, str]]:
        if not self.log_path.exists():
            return []
        return [json.loads(line) for line in self.log_path.read_text(encoding="utf-8").splitlines()]

    def messages(self) -> List[str]:
        return [entry["message"] for entry in self.logs()]

    def state(self, name: str = "state") -> Dict[str, str]:
        path = self.state_dir / name
        values = {}
        for line in path.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.startswith("#"):
                key, _, value = line.partition("=")
                values[key] = value
        return values


class HarnessCase(unittest.TestCase):
    def setUp(self) -> None:
        self.h = Harness()
        self.addCleanup(self.h.cleanup)

    def assert_logged(self, fragment: str) -> None:
        self.assertTrue(any(fragment in message for message in self.h.messages()),
                        f"{fragment!r} not in {self.h.messages()}")


# ---------------------------------------------------------------------------


class DiagTests(HarnessCase):
    def diag(self, *args: str) -> subprocess.CompletedProcess:
        return self.h.run(DIAG, "--no-config", "--device", str(self.h.dev / "t900-ground"), *args)

    def report(self, result: subprocess.CompletedProcess) -> str:
        self.assertEqual(result.returncode, 0, result.stderr)
        match = re.search(r"^Report: (.+)$", result.stdout, re.M)
        self.assertIsNotNone(match, result.stdout)
        path = Path(match.group(1))
        self.assertRegex(path.name, r"^t900-diag-.+-\d{8}T\d{6}Z\.txt$")
        return path.read_text(encoding="utf-8")

    def section(self, report: str, title: str) -> str:
        match = re.search(r"^== " + re.escape(title) + r"[^\n]*==\n(.*?)(?=^== |\Z)", report, re.M | re.S)
        self.assertIsNotNone(match, f"section {title!r} missing:\n{report}")
        return match.group(1)

    def test_full_report_as_root_reads_everything_and_changes_nothing(self):
        self.h.set(uid=0)
        report = self.report(self.diag("-o", str(self.h.out)))
        titles = re.findall(r"^== ([^:=]+?)(?::| ==)", report, re.M)
        self.assertEqual(titles, ["summary", "service", "pppd journal", "interface", "device", "USB", "kernel log",
                                  "ping", "udev", "watchdog"])
        self.assertRegex(report, r"(?m)^time: +\d{4}-\d\d-\d\d \d\d:\d\d:\d\d .*\(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\)$")
        self.assertIn("settings: service t900-ground-ppp.service, device", report)
        self.assertIn("peer 10.90.0.2, USB 1a86:7523", report)
        summary = self.section(report, "summary")
        self.assertIn("service:  t900-ground-ppp.service active (running), 12 automatic restarts", summary)
        self.assertIn("ppp0:     10.90.0.1 (up)", summary)
        self.assertIn("usb:      3-2, id 1a86:7523 (bus 3 device 5), ch341 on 3-2:1.0", summary)
        self.assertIn("ping:     3/3 replies from 10.90.0.2", summary)
        self.assertIn("skipped:  nothing", summary)
        journal = self.section(report, "pppd journal")
        self.assertEqual(journal.count("LCP: timeout"), 50)
        kernel = self.section(report, "kernel log").strip().splitlines()
        self.assertTrue(kernel[0].startswith("$ journalctl -k -b"), kernel[0])
        self.assertEqual(len(kernel) - 1, 30, "the last 30 matching lines")
        self.assertTrue(all("usb 3-2" in line for line in kernel[1:]))
        self.assertIn("(39)", kernel[-1])
        self.assertIn("3 received", self.section(report, "ping"))
        self.assertIn("S: t900-ground", self.section(report, "udev"))
        self.assertIn("ID 1a86:7523", self.section(report, "USB"))
        self.assertIn("state:     no check has run yet", self.section(report, "watchdog"))
        # Read-only: systemctl only reads, nothing resets or restarts.
        self.assertEqual(self.h.actions(), [])
        verbs = {call[1] for call in self.h.calls() if call[0] == "systemctl"}
        self.assertLessEqual(verbs, {"status", "show"})
        self.assertNotIn("usbreset", {call[0] for call in self.h.calls()})

    def test_without_root_skips_the_journal_and_says_so(self):
        self.h.set(uid=1000, user="rdf", groups="rdf dialout")
        result = self.diag("-o", str(self.h.out))
        report = self.report(result)
        self.assertIn("user:     rdf (uid 1000, not root)", report)
        self.assertIn("(skipped: needs root or the systemd-journal or adm group)", self.section(report, "pppd journal"))
        self.assertIn("dmesg is restricted", self.section(report, "kernel log"))
        self.assertIn("skipped:  pppd journal, kernel log (need root or the systemd-journal or adm group; "
                      "run with sudo for the full report)", report)
        self.assertIn("Skipped without root: pppd journal, kernel log", result.stdout)
        self.assertNotIn("journalctl", {call[0] for call in self.h.calls()})
        # The parts that need no root are all there.
        self.assertIn("3 received", self.section(report, "ping"))
        self.assertIn("ID 1a86:7523", self.section(report, "USB"))

    def test_journal_group_is_enough(self):
        self.h.set(uid=1000, user="rdf", groups="rdf systemd-journal")
        report = self.report(self.diag("-o", str(self.h.out)))
        self.assertIn("skipped:  nothing", report)
        self.assertEqual(self.section(report, "pppd journal").count("LCP: timeout"), 50)

    def test_link_down_and_device_missing(self):
        self.h.set(iface=None, usb=False)
        report = self.report(self.h.run(DIAG, "--no-config", "--device", str(self.h.dev / "absent"),
                                        "-o", str(self.h.out)))
        summary = self.section(report, "summary")
        self.assertIn("ppp0:     missing", summary)
        self.assertIn("ping:     skipped (ppp0 missing)", summary)
        self.assertIn("absent missing", summary)
        self.assertIn("(skipped: ppp0 does not exist)", self.section(report, "ping"))
        self.assertIn("does not exist", self.section(report, "udev"))
        self.assertIn("(exit 1)", self.section(report, "USB"))
        self.assertNotIn("ping", {call[0] for call in self.h.calls()})

    def test_address_without_reply(self):
        self.h.set(iface={"ifindex": 7, "addr": None})
        report = self.report(self.diag("-o", str(self.h.out)))
        self.assertIn("ppp0:     no IPv4 address", report)
        self.h.set(iface={"ifindex": 7, "addr": "10.90.0.1"}, ping=False)
        report = self.report(self.diag("-o", str(self.h.out)))
        self.assertIn("ping:     0/3 replies from 10.90.0.2", report)

    def test_raspberry_preset_and_overrides(self):
        result = self.h.run(DIAG, "--raspberry", "-o", "-")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("settings: service t900-ppp.service, device /dev/t900, interface ppp0, peer 10.90.0.1", result.stdout)
        self.assertIn("config:   none", result.stdout)
        self.assertIn(["ping", "-n", "-c", "3", "-W", "2", "-I", "ppp0", "10.90.0.1"], self.h.calls())
        result = self.h.run(DIAG, "--raspberry", "--peer=10.90.0.9", "--service", "x-ppp.service", "-o", "-")
        self.assertIn("settings: service x-ppp.service, device /dev/t900, interface ppp0, peer 10.90.0.9", result.stdout)

    def test_reads_the_link_settings_of_the_config(self):
        self.h.write_config(text=(
            "# comment\n"
            "PPP_SERVICE=other-ppp.service   # trailing comment\n"
            "PEER='10.90.0.5'\n"
            "PPP_DEVICE=\"%s\"\n"
            "FAIL_AFTER=300\n" % (self.h.dev / "t900-ground")
        ))
        result = self.h.run(DIAG, "--config", str(self.h.config), "-o", "-")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("settings: service other-ppp.service", result.stdout)
        self.assertIn("peer 10.90.0.5", result.stdout)
        self.assertIn(f"config:   {self.h.config}", result.stdout)
        result = self.h.run(DIAG, "--config", str(self.h.config), "--peer", "10.90.0.2", "-o", "-")
        self.assertIn("peer 10.90.0.2,", result.stdout)

    def test_prints_to_stdout_and_writes_no_file(self):
        result = self.diag("-o", "-")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.startswith("T900 link report\n"))
        self.assertEqual(list(self.h.out.iterdir()), [])

    def test_bad_arguments(self):
        for args in (["--bogus"], ["--peer", "10.0.0.1;reboot"], ["--usb-id", "1a86"], ["--device", "relative"],
                     ["--service"], ["-o", str(self.h.base / "absent")]):
            result = self.diag(*args)
            self.assertEqual(result.returncode, 2, args)
            self.assertIn("t900-ground-diag:", result.stderr)


# ---------------------------------------------------------------------------


class WatchdogTests(HarnessCase):
    def down(self, **iface: object) -> None:
        self.h.set(iface={"ifindex": 7, "addr": None, **iface}, ping=False)

    def test_healthy_link_takes_no_action(self):
        for now in (1000, 1030, 5000):
            self.h.check(now)
        self.assertEqual(self.h.actions(), [])
        self.assertEqual(self.h.messages(), [])
        self.assertEqual(self.h.state()["LAST_STATE"], "up")
        self.assertIn(["ping", "-n", "-q", "-c", "3", "-W", "2", "-I", "ppp0", "10.90.0.2"], self.h.calls())

    def test_detection_waits_fail_after(self):
        self.down()
        self.h.check(1000)
        self.assert_logged("link down: ppp0 has no IPv4 address")
        self.h.check(1030)
        self.h.check(1059)
        self.assertEqual(self.h.actions(), [])
        self.h.check(1060)
        self.assertEqual(self.h.actions(), [["systemctl", "reset-failed", SERVICE], ["systemctl", "restart", SERVICE]])
        self.assert_logged("link down 60 s (ppp0 has no IPv4 address): action 1, 1 of 4 this hour: restart t900-ground-ppp.service")
        self.assert_logged("ran: systemctl restart t900-ground-ppp.service")

    def test_each_failure_kind_is_detected(self):
        for iface, ping, text in (
            (None, False, "ppp0 is missing"),
            ({"ifindex": 7, "addr": None}, False, "ppp0 has no IPv4 address"),
            ({"ifindex": 7, "addr": "10.90.0.1"}, False, "10.90.0.2 does not answer ping on ppp0"),
        ):
            with self.subTest(text=text):
                shutil.rmtree(self.h.state_dir, ignore_errors=True)
                self.h.clear_calls()
                self.h.set(iface=iface, ping=ping)
                self.h.check(1000)
                self.assertEqual(self.h.messages(), [f"link down: {text}"])

    def test_escalation_order_backoff_and_hold(self):
        self.h.write_config(POWER_METHOD="uhubctl", UHUBCTL_LOCATION="3", UHUBCTL_PORT="2")
        self.down()
        # FAIL_AFTER 60, then BACKOFF_BASE 60 doubling to BACKOFF_MAX 240.
        schedule = {1060: "restart", 1120: "usb", 1240: "power", 1480: "restart"}
        for now in (1000, 1030, 1059, 1060, 1090, 1119, 1120, 1200, 1239, 1240, 1400, 1479, 1480, 1600, 1719, 1720):
            before = len(self.h.actions())
            self.h.check(now)
            acted = len(self.h.actions()) > before
            self.assertEqual(acted, now in schedule, f"t={now}")
        self.assertEqual(self.h.actions(), [
            ["systemctl", "reset-failed", SERVICE], ["systemctl", "restart", SERVICE],
            ["usbreset", "003/005"], ["systemctl", "reset-failed", SERVICE], ["systemctl", "restart", SERVICE],
            ["uhubctl", "-l", "3", "-p", "2", "-a", "cycle", "-d", "5"],
            ["systemctl", "reset-failed", SERVICE], ["systemctl", "restart", SERVICE],
            ["systemctl", "reset-failed", SERVICE], ["systemctl", "restart", SERVICE],
        ])
        sleeps = [call for call in self.h.calls() if call[0] == "sleep"]
        self.assertEqual(sleeps, [["sleep", "5"], ["sleep", "10"]], "USB_SETTLE and POWER_SETTLE")
        # At 1720 the fifth action is due, but four ran in the last hour.
        self.assert_logged("remote unreachable: 4 recovery actions in the last hour did not bring the link back")
        state = self.h.state()
        self.assertEqual(state["HOLD"], "1")
        self.assertEqual(state["HOLD_IFINDEX"], "", "no address at the hold: any session with one is new")
        # Held: hours later still nothing, one reminder per hour.
        self.h.clear_calls()
        for now in range(1730, 1720 + 2 * 3600 + 301, 600):
            self.h.check(now)
        self.assertEqual(self.h.actions(), [])
        reminders = [m for m in self.h.messages() if m.startswith("remote unreachable since")]
        self.assertEqual(len(reminders), 2)
        status = self.h.run(WATCHDOG, "status", now=9000)
        self.assertIn("hold:      remote unreachable since", status.stdout)
        # A new PPP session clears the hold; the link still fails ping, so a
        # new outage starts and escalates from the restart again.
        self.h.set(iface={"ifindex": 9, "addr": "10.90.0.1"}, ping=False)
        self.h.check(9000)
        self.assert_logged("new PPP session on ppp0 (10.90.0.1, ifindex 9): remote unreachable hold cleared")
        self.assertEqual(self.h.state()["HOLD"], "0")
        self.h.check(9030)
        self.assertEqual(self.h.actions(), [])
        self.h.check(9060)
        self.assertEqual(self.h.actions()[-1], ["systemctl", "restart", SERVICE])

    def test_hold_with_an_address_needs_a_new_ifindex(self):
        self.h.write_config(MAX_ACTIONS_PER_HOUR=1)
        self.h.set(iface={"ifindex": 7, "addr": "10.90.0.1"}, ping=False)
        for now in (1000, 1060, 1120):
            self.h.check(now)
        self.assertEqual(self.h.state()["HOLD"], "1")
        self.assertEqual(self.h.state()["HOLD_IFINDEX"], "7")
        self.h.check(1200)
        self.assertEqual(self.h.state()["HOLD"], "1", "the same session is not a new one")
        self.h.set(iface={"ifindex": 8, "addr": "10.90.0.1"})
        self.h.check(1230)
        self.assertEqual(self.h.state()["HOLD"], "0")

    def test_answering_peer_ends_the_outage_and_the_hold(self):
        self.h.write_config(MAX_ACTIONS_PER_HOUR=1)
        self.down()
        for now in (1000, 1060, 1120):
            self.h.check(now)
        self.assertEqual(self.h.state()["HOLD"], "1")
        self.h.set(iface={"ifindex": 7, "addr": "10.90.0.1"}, ping=True)
        self.h.check(1150)
        self.assert_logged("link up: 10.90.0.2 answers on ppp0 (10.90.0.1), down 150 s, 1 actions")
        state = self.h.state()
        self.assertEqual((state["HOLD"], state["FAIL_SINCE"], state["ACTIONS"], state["NEXT_STAGE"]), ("0", "0", "0", "restart"))

    def test_recovery_after_a_restart_starts_the_next_outage_from_the_beginning(self):
        self.down()
        self.h.set(fix_on="restart")
        for now in (1000, 1060):
            self.h.check(now)
        self.h.check(1090)
        self.assert_logged("link up:")
        self.assertEqual(self.h.state()["NEXT_STAGE"], "restart")
        self.down()
        self.h.clear_calls()
        for now in (2000, 2060):
            self.h.check(now)
        self.assertEqual(self.h.actions()[-1], ["systemctl", "restart", SERVICE])

    def test_hourly_limit_counts_only_the_last_hour(self):
        self.h.write_config(MAX_ACTIONS_PER_HOUR=2, USB_RESET_METHOD="none")
        self.down()
        for now in (1000, 1060, 1120):
            self.h.check(now)
        self.assertEqual(len([a for a in self.h.actions() if a[1] == "restart"]), 2)
        # Up, then down again within the hour: the window is full, so hold.
        self.h.set(iface={"ifindex": 7, "addr": "10.90.0.1"}, ping=True)
        self.h.check(1200)
        self.down()
        for now in (1300, 1360):
            self.h.check(now)
        self.assertEqual(self.h.state()["HOLD"], "1")
        # Recovered and down again more than an hour later: actions again.
        self.h.set(iface={"ifindex": 8, "addr": "10.90.0.1"}, ping=True)
        self.h.check(5000)
        self.down()
        self.h.clear_calls()
        for now in (5100, 5160):
            self.h.check(now)
        self.assertEqual(self.h.actions()[-1], ["systemctl", "restart", SERVICE])

    def test_usb_stage_rebinds_ch341_of_the_adapter_behind_the_device_node(self):
        self.h.write_config(USB_RESET_METHOD="unbind")
        self.h.add_usb("3-3", bus=3, num=9, tty="ttyUSB1")
        self.down()
        for now in (1000, 1060, 1120):
            self.h.check(now)
        driver = self.h.sysfs / "bus/usb/drivers/ch341"
        self.assertEqual((driver / "unbind").read_text(), "3-2:1.0")
        self.assertEqual((driver / "bind").read_text(), "3-2:1.0")
        messages = self.h.messages()
        unbind = next(i for i, m in enumerate(messages) if m.startswith("wrote 3-2:1.0 to") and m.endswith("/unbind"))
        bind = next(i for i, m in enumerate(messages) if m.startswith("wrote 3-2:1.0 to") and m.endswith("/bind"))
        self.assertLess(unbind, bind)
        self.assertEqual(self.h.actions()[-1], ["systemctl", "restart", SERVICE])

    def test_usb_stage_refuses_to_guess_between_two_adapters(self):
        self.h.add_usb("3-3", bus=3, num=9, tty="ttyUSB1")
        (self.h.dev / "t900-ground").unlink()
        self.down()
        for now in (1000, 1060, 1120):
            self.h.check(now)
        self.assertNotIn("usbreset", [call[0] for call in self.h.calls()])
        self.assert_logged("several USB devices 1a86:7523")
        self.assertEqual(self.h.actions()[-1], ["systemctl", "restart", SERVICE], "the service restart still runs")
        self.assertEqual(self.h.state()["LAST_RESULT"], "failed")

    def test_auto_uses_unbind_without_usbreset(self):
        self.h.remove_tool("usbreset")
        self.down()
        for now in (1000, 1060, 1120):
            self.h.check(now)
        self.assertEqual((self.h.sysfs / "bus/usb/drivers/ch341/bind").read_text(), "3-2:1.0")
        self.assert_logged("re-enumerate USB 1a86:7523 (unbind)")

    def test_relay_power_cycle_switches_on_after_off(self):
        self.h.write_config(USB_RESET_METHOD="none", POWER_METHOD="relay",
                            RELAY_OFF_COMMAND='"relay off"', RELAY_ON_COMMAND="'relay on'", POWER_OFF_SECONDS=7)
        self.down()
        for now in (1000, 1060, 1120):
            self.h.check(now)
        relevant = [c for c in self.h.calls() if c[0] in ("relay", "sleep") or c[:2] == ["systemctl", "restart"]]
        self.assertEqual(relevant, [["systemctl", "restart", SERVICE], ["relay", "off"], ["sleep", "7"],
                                    ["relay", "on"], ["sleep", "10"], ["systemctl", "restart", SERVICE]])
        self.assert_logged("power-cycle the T900 (relay), then restart t900-ground-ppp.service")

    def test_stage_order_without_power(self):
        self.down()
        for now in (1000, 1060, 1100, 1120, 1200, 1240, 1400, 1480):
            self.h.check(now)
        order = []
        for call in self.h.actions():
            if call[0] == "usbreset":
                order.append("usb")
            elif call[:2] == ["systemctl", "restart"] and (not order or order[-1] != "usb"):
                order.append("restart")
            elif call[:2] == ["systemctl", "restart"]:
                order[-1] = "usb+restart"
        self.assertEqual(order, ["restart", "usb+restart", "restart", "usb+restart"])

    def test_dry_run_logs_actions_and_runs_none(self):
        self.h.write_config(DRY_RUN=1, POWER_METHOD="uhubctl", UHUBCTL_LOCATION="1-1.4", UHUBCTL_PORT="3")
        self.down()
        for now in (1000, 1060, 1120, 1240):
            self.h.check(now)
        self.assertEqual(self.h.actions(), [])
        self.assertNotIn("sleep", [call[0] for call in self.h.calls()])
        self.assert_logged("dry-run: would run: systemctl restart t900-ground-ppp.service")
        self.assert_logged("dry-run: would run: usbreset 003/005")
        self.assert_logged("dry-run: would run: uhubctl -l 1-1.4 -p 3 -a cycle -d 5")
        self.assertTrue((self.h.state_dir / "state.dry-run").is_file())
        self.assertFalse((self.h.state_dir / "state").exists(), "a dry run keeps its own state")
        status = self.h.run(WATCHDOG, "status", now=1250)
        self.assertIn("mode:      dry run", status.stdout)

    def test_dry_run_flag_overrides_a_live_config(self):
        self.down()
        for now in (1000, 1060):
            result = self.h.run(WATCHDOG, "--dry-run", "check", now=now)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.h.actions(), [])
        self.assert_logged("dry-run: would run: systemctl restart")
        self.assertFalse((self.h.state_dir / "state").exists())

    def test_every_message_has_the_fixed_tag(self):
        self.h.write_config(POWER_METHOD="uhubctl", UHUBCTL_LOCATION="3", UHUBCTL_PORT="2")
        self.down()
        for now in (1000, 1060, 1120, 1240, 1480, 1720, 5400):
            self.h.check(now)
        self.h.write_config(text="FAIL_AFTR=1\n")
        self.h.run(WATCHDOG, "check", now=5500)
        self.h.write_config(POWER_METHOD="uhubctl", UHUBCTL_LOCATION="3", UHUBCTL_PORT="2")
        self.h.run(WATCHDOG, "usb-reset", now=5600)
        logs = self.h.logs()
        self.assertGreater(len(logs), 10)
        self.assertEqual({entry["tag"] for entry in logs}, {TAG})
        self.assertLessEqual({entry["priority"] for entry in logs}, {"daemon.notice", "daemon.warning", "daemon.err"})
        for unit in ("t900-ground-watchdog.service.in", "t900-ground-usbreset.service.in"):
            self.assertIn(f"SyslogIdentifier={TAG}\n", (GROUND / unit).read_text(encoding="utf-8"))

    def test_stopped_or_disabled_service_is_left_alone(self):
        for field, value, why in (("active", "inactive", "stopped"), ("enabled", "disabled", "disabled")):
            with self.subTest(why=why):
                shutil.rmtree(self.h.state_dir, ignore_errors=True)
                self.h.clear_calls()
                self.h.set(active="active", enabled="enabled")
                self.h.set(**{field: value})
                self.down()
                for now in (1000, 1100, 1500, 1900):
                    self.h.check(now)
                self.assertEqual(self.h.actions(), [])
                self.assertEqual(self.h.messages(), [f"t900-ground-ppp.service is {why}: watchdog idle until it runs again"])
                self.h.set(active="active", enabled="enabled")
                self.h.check(2000)
                self.assert_logged("t900-ground-ppp.service runs again: watching ppp0")
                self.assert_logged("link down: ppp0 has no IPv4 address")

    def test_operator_usb_reset_and_the_backoff_after_it(self):
        self.down()
        self.h.check(1000)
        result = self.h.run(WATCHDOG, "usb-reset", now=1100)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.h.actions(), [["usbreset", "003/005"], ["systemctl", "reset-failed", SERVICE],
                                            ["systemctl", "restart", SERVICE]])
        self.assert_logged("usb-reset requested: re-enumerate USB 1a86:7523 (usbreset), then restart t900-ground-ppp.service")
        self.assertEqual(self.h.state()["LAST_ACTION"], "usb-reset")
        self.h.clear_calls()
        self.h.check(1120)
        self.h.check(1150)
        self.assertEqual(self.h.actions(), [], "BACKOFF_BASE after the operator's reset")
        self.h.check(1160)
        self.assertEqual(self.h.actions()[-1], ["systemctl", "restart", SERVICE])

    def test_failed_usbreset_is_reported(self):
        self.h.set(usbreset_rc=1)
        result = self.h.run(WATCHDOG, "usb-reset", now=1000)
        self.assertEqual(result.returncode, 1)
        self.assert_logged("failed (exit 1): usbreset 003/005")
        self.assertEqual(self.h.state()["LAST_RESULT"], "failed")

    def test_lock_held_by_a_live_run_skips_the_check(self):
        lock = self.h.state_dir / "lock"
        lock.mkdir(parents=True)
        (lock / "pid").write_text(f"{os.getpid()}\n", encoding="utf-8")
        self.down()
        self.h.check(1000)
        self.assertEqual([call for call in self.h.calls() if call[0] != "id"], [], "nothing but the root check")
        (lock / "pid").write_text("999999999\n", encoding="utf-8")
        self.h.check(1000)
        self.assert_logged("link down")
        self.assertFalse(lock.exists(), "a stale lock is taken over and released")

    def test_status_and_reset(self):
        status = self.h.run(WATCHDOG, "status", now=1000)
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertIn("no check has run yet", status.stdout)
        self.down()
        for now in (1000, 1060):
            self.h.check(now)
        status = self.h.run(WATCHDOG, "status", now=1070).stdout
        self.assertIn("mode:      live", status)
        self.assertIn("link:      down since", status)
        self.assertIn("(70 s): ppp0 has no IPv4 address", status)
        self.assertIn("actions:   1 in this outage, 1 of 4 in the last hour", status)
        self.assertIn("last:      restart at", status)
        self.assertIn("next:      re-enumerate USB 1a86:7523 (usbreset), then restart t900-ground-ppp.service, not before", status)
        result = self.h.run(WATCHDOG, "reset", now=1080)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_logged("state reset by root: outage, action history and hold cleared")
        status = self.h.run(WATCHDOG, "status", now=1090).stdout
        self.assertIn("actions:   0 in this outage, 0 of 4 in the last hour", status)

    def test_acting_commands_need_root(self):
        self.h.set(uid=1000)
        for command in ("check", "usb-reset", "reset"):
            result = self.h.run(WATCHDOG, command, now=1000)
            self.assertEqual(result.returncode, 1, command)
            self.assertIn("run as root", result.stderr)
        self.assertEqual(self.h.run(WATCHDOG, "status", now=1000).returncode, 0)
        self.assertEqual(self.h.actions(), [])

    def test_config_values_and_errors(self):
        self.h.write_config(text=(
            "  # indented comment\n"
            "\n"
            "PEER=10.90.0.7   # inline comment\n"
            "RELAY_OFF_COMMAND=\"relay off # not a comment\"\n"
            "RELAY_ON_COMMAND='relay on'\n"
            "POWER_METHOD=relay\n"
            "UHUBCTL_LOCATION=\n"
        ))
        result = self.h.run(WATCHDOG, "check-config")
        self.assertEqual(result.returncode, 0, result.stderr)
        values = dict(line.split("=", 1) for line in result.stdout.splitlines())
        self.assertEqual(values["PEER"], "10.90.0.7")
        self.assertEqual(values["RELAY_OFF_COMMAND"], "relay off # not a comment")
        self.assertEqual(values["RELAY_ON_COMMAND"], "relay on")
        self.assertEqual(values["FAIL_AFTER"], "180", "the documented default")
        self.assertEqual(values["PPP_SERVICE"], SERVICE)
        for text, fragment in (
            ("FAIL_AFTR=60\n", "line 1: unknown setting FAIL_AFTR"),
            ("FAIL_AFTER=abc\n", "FAIL_AFTER must be a whole number"),
            ("FAIL_AFTER=0120\n", "FAIL_AFTER must be a whole number"),
            ("FAIL_AFTER=5\n", "FAIL_AFTER must be from 30 to 86400"),
            ("BACKOFF_BASE=600\nBACKOFF_MAX=300\n", "BACKOFF_MAX must be from 600"),
            ("DRY_RUN=yes\n", "DRY_RUN must be 0 or 1"),
            ("POWER_METHOD=uhubctl\n", "needs UHUBCTL_LOCATION"),
            ("POWER_METHOD=relay\nRELAY_OFF_COMMAND=x\n", "needs RELAY_OFF_COMMAND and RELAY_ON_COMMAND"),
            ("PEER=10.0.0.1;reboot\n", "PEER is not an IP address"),
            ("PPP_SERVICE=ppp\n", "PPP_SERVICE must end in .service"),
            ("USB_ID=1A86:7523\n", "USB_ID must look like 1a86:7523"),
            ("RELAY_ON_COMMAND='relay on\n", "line 1: RELAY_ON_COMMAND: put a value with spaces in quotes"),
            ("PEER=10.0.0.1 10.0.0.2\n", "line 1: PEER: put a value with spaces in quotes"),
            ("just words\n", "line 1: expected NAME=VALUE"),
        ):
            with self.subTest(text=text):
                self.h.clear_calls()
                self.h.write_config(text=text)
                result = self.h.run(WATCHDOG, "check", now=1000)
                self.assertEqual(result.returncode, 78)
                self.assertEqual(self.h.actions(), [])
                self.assert_logged("config error: ")
                self.assert_logged(fragment)

    def test_messages_reach_stderr_only_outside_a_unit(self):
        self.h.write_config(text="NOPE=1\n")
        outside = self.h.run(WATCHDOG, "check", now=1000)
        self.assertIn("t900-ground-watchdog: config error: ", outside.stderr)
        inside = self.h.run(WATCHDOG, "check", now=1000, INVOCATION_ID="0123abcd")
        self.assertEqual(inside.returncode, 78)
        self.assertEqual(inside.stderr, "", "the unit's stderr would repeat the journal line")
        self.assertEqual(len([m for m in self.h.messages() if m.startswith("config error")]), 2)

    def test_config_must_belong_to_root_and_stay_private(self):
        self.h.write_config()
        self.h.config.chmod(0o664)
        result = self.h.run(WATCHDOG, "check", now=1000)
        self.assertEqual(result.returncode, 78)
        self.assert_logged("must be writable only by its owner")
        self.h.config.chmod(0o644)
        link = self.h.base / "link-symlink.conf"
        link.symlink_to(self.h.config)
        result = self.h.run(WATCHDOG, "check", now=1000, T900_LINK_CONFIG=str(link))
        self.assertEqual(result.returncode, 78)
        self.assert_logged("must be a regular file, not a symlink")

    def test_missing_config_uses_the_defaults(self):
        self.h.config.unlink()
        result = self.h.run(WATCHDOG, "check-config")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PPP_DEVICE=/dev/t900-ground\n", result.stdout)
        self.assertIn("PEER=10.90.0.2\n", result.stdout)

    def test_example_config_holds_every_default(self):
        """link.conf.example documents each setting with the script's default."""
        example = self.h.base / "example.conf"
        shutil.copy(GROUND / "link.conf.example", example)
        example.chmod(0o644)
        from_example = self.h.run(WATCHDOG, "--config", str(example), "check-config")
        self.h.config.unlink()
        defaults = self.h.run(WATCHDOG, "check-config")
        self.assertEqual(from_example.returncode, 0, from_example.stderr)
        self.assertEqual(from_example.stdout, defaults.stdout)
        keys = re.findall(r"(?m)^([A-Z_]+)=", (GROUND / "link.conf.example").read_text(encoding="utf-8"))
        script_keys = re.search(r"CONFIG_KEYS='([^']*)'", WATCHDOG.read_text(encoding="utf-8")).group(1).split()
        self.assertEqual(sorted(keys), sorted(script_keys))

    def test_bad_command_line(self):
        for args, fragment in ((["frobnicate"], "unknown command"), (["--bogus"], "unknown option"),
                               (["check", "extra"], "too many arguments")):
            result = self.h.run(WATCHDOG, *args, now=1000)
            self.assertEqual(result.returncode, 1, args)
            self.assertIn(fragment, result.stderr)


# ---------------------------------------------------------------------------


class OperatorCommandTests(HarnessCase):
    def test_restart_and_usb_reset_go_through_systemctl(self):
        self.h.write_config(PPP_SERVICE="ground-ppp.service")
        result = self.h.run(LINK, "restart")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Wait 30-60 s, then check: t900-link diag", result.stdout)
        result = self.h.run(LINK, "usb-reset")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.h.actions(), [["systemctl", "restart", "ground-ppp.service"],
                                            ["systemctl", "start", "t900-ground-usbreset.service"]])

    def test_refused_restart_names_sudo(self):
        self.h.set(restart_rc=4, start_rc=4)
        result = self.h.run(LINK, "restart")
        self.assertEqual(result.returncode, 1)
        self.assertIn("sudo systemctl restart t900-ground-ppp.service", result.stderr)
        result = self.h.run(LINK, "usb-reset")
        self.assertEqual(result.returncode, 1)
        self.assertIn("sudo systemctl start t900-ground-usbreset.service", result.stderr)

    def test_status_log_and_diag(self):
        self.h.set(uid=1000, user="rdf", groups="rdf")
        result = self.h.run(LINK, "status")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Active: active (running)", result.stdout)
        self.assertIn("inet 10.90.0.1 peer 10.90.0.2/32", result.stdout)
        self.assertIn("mode:      live", result.stdout)
        result = self.h.run(LINK, "log", "20")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["journalctl", "-t", TAG, "-n", "20", "--no-pager", "-o", "short-iso"], self.h.calls())
        result = self.h.run(LINK, "diag", "--no-config", "-o", "-")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.startswith("T900 link report"))
        self.assertEqual(self.h.actions(), [])

    def test_broken_config_falls_back_to_the_default_service(self):
        self.h.write_config(text="NOPE=1\n")
        result = self.h.run(LINK, "restart")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("link.conf has an error", result.stderr)
        self.assertIn(["systemctl", "restart", SERVICE], self.h.actions())

    def test_usage(self):
        result = self.h.run(LINK)
        self.assertEqual(result.returncode, 2)
        self.assertIn("usb-reset", result.stdout)
        self.assertEqual(self.h.run(LINK, "bogus").returncode, 1)
        self.assertEqual(self.h.run(LINK, "log", "x").returncode, 1)


# ---------------------------------------------------------------------------


class InstallerTests(HarnessCase):
    PRESENT = {
        "etc/ppp/peers/t900-ground": "/dev/t900-ground 57600\nlocal\nnoauth\npersist\nmaxfail 0\n",
        "etc/udev/rules.d/99-t900-ground.rules": 'SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", SYMLINK+="t900-ground"\n',
        "etc/systemd/system/t900-ground-ppp.service": "[Service]\nExecStart=/usr/sbin/pppd call t900-ground nodetach\n",
    }

    def setUp(self) -> None:
        super().setUp()
        self.root = self.h.base / "root"
        self.before = {}
        for name, text in self.PRESENT.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            os.utime(path, (1_600_000_000, 1_600_000_000))
            self.before[name] = (text, path.stat().st_mtime)

    def install(self, *args: str) -> subprocess.CompletedProcess:
        return self.h.run(INSTALL, "--root", str(self.root), *args)

    def files(self) -> set:
        return {str(path.relative_to(self.root)) for path in self.root.rglob("*") if path.is_file()}

    def assert_untouched(self) -> None:
        for name, (text, mtime) in self.before.items():
            path = self.root / name
            self.assertEqual(path.read_text(encoding="utf-8"), text, name)
            self.assertEqual(path.stat().st_mtime, mtime, name)

    def test_install_writes_only_its_own_files(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.files() - set(self.PRESENT), {
            "usr/local/bin/t900-link",
            "usr/local/bin/t900-ground-diag",
            "usr/local/sbin/t900-ground-watchdog",
            "usr/local/share/t900-ground-link/README.md",
            "usr/local/share/t900-ground-link/link.conf.example",
            "usr/local/share/t900-ground-link/uninstall.sh",
            "usr/local/share/t900-ground-link/install-info",
            "etc/t900-ground-link/link.conf",
            "etc/systemd/system/t900-ground-watchdog.service",
            "etc/systemd/system/t900-ground-watchdog.timer",
            "etc/systemd/system/t900-ground-usbreset.service",
            "etc/polkit-1/rules.d/50-t900-ground-link.rules",
        })
        self.assert_untouched()
        for name in ("usr/local/bin/t900-link", "usr/local/bin/t900-ground-diag",
                     "usr/local/sbin/t900-ground-watchdog", "usr/local/share/t900-ground-link/uninstall.sh"):
            self.assertEqual(stat.S_IMODE((self.root / name).stat().st_mode), 0o755, name)
        for name in ("etc/t900-ground-link/link.conf", "etc/systemd/system/t900-ground-watchdog.service",
                     "etc/polkit-1/rules.d/50-t900-ground-link.rules"):
            self.assertEqual(stat.S_IMODE((self.root / name).stat().st_mode), 0o644, name)
        self.assertEqual((self.root / "etc/t900-ground-link/link.conf").read_bytes(),
                         (GROUND / "link.conf.example").read_bytes())
        service = (self.root / "etc/systemd/system/t900-ground-watchdog.service").read_text(encoding="utf-8")
        self.assertIn("ExecStart=/usr/local/sbin/t900-ground-watchdog check\n", service)
        self.assertIn("Type=oneshot\n", service)
        self.assertIn("After=t900-ground-ppp.service\n", service)
        self.assertIn("Documentation=file:///usr/local/share/t900-ground-link/README.md\n", service)
        usbreset = (self.root / "etc/systemd/system/t900-ground-usbreset.service").read_text(encoding="utf-8")
        self.assertIn("ExecStart=/usr/local/sbin/t900-ground-watchdog usb-reset\n", usbreset)
        self.assertNotIn("[Install]", usbreset, "started on demand only")
        rule = (self.root / "etc/polkit-1/rules.d/50-t900-ground-link.rules").read_text(encoding="utf-8")
        self.assertIn('subject.user !== "rdf"', rule)
        self.assertIn('unit === "t900-ground-ppp.service" && verb === "restart"', rule)
        self.assertIn('unit === "t900-ground-usbreset.service" && verb === "start"', rule)
        for text in (service, usbreset, rule):
            self.assertNotRegex(text, r"@[A-Z_]+@")
        info = (self.root / "usr/local/share/t900-ground-link/install-info").read_text(encoding="utf-8")
        self.assertIn("POLKIT_RULE=/etc/polkit-1/rules.d/50-t900-ground-link.rules\n", info)
        self.assertIn("OP_USER=rdf\n", info)
        self.assertIn("skipped (--root): systemctl daemon-reload", result.stdout)
        self.assertIn("skipped (--root): systemctl enable --now t900-ground-watchdog.timer", result.stdout)
        self.assertEqual(self.h.actions(), [])

    def test_installer_opens_no_port_and_edits_no_link_file(self):
        text = INSTALL.read_text(encoding="utf-8") + UNINSTALL.read_text(encoding="utf-8")
        for forbidden in ("ufw", "iptables", "nft ", "firewall-cmd", "/etc/ppp", "/etc/udev", "udevadm control"):
            self.assertNotIn(forbidden, text)

    def test_rerun_keeps_the_config_and_switches_the_mode(self):
        self.assertEqual(self.install().returncode, 0)
        config = self.root / "etc/t900-ground-link/link.conf"
        config.write_text(config.read_text(encoding="utf-8").replace("FAIL_AFTER=180", "FAIL_AFTER=300"), encoding="utf-8")
        result = self.install("--watchdog-dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Keeping /etc/t900-ground-link/link.conf", result.stdout)
        text = config.read_text(encoding="utf-8")
        self.assertIn("FAIL_AFTER=300\n", text)
        self.assertIn("\nDRY_RUN=1\n", text)
        self.assertIn("dry run: it logs its actions and runs none", result.stdout)
        self.assertEqual(self.install("--watchdog-live").returncode, 0)
        self.assertIn("\nDRY_RUN=0\n", config.read_text(encoding="utf-8"))
        self.assert_untouched()

    def test_service_name_comes_from_the_config(self):
        config = self.root / "etc/t900-ground-link/link.conf"
        config.parent.mkdir(parents=True)
        config.write_text("PPP_SERVICE=gs-ppp.service\n", encoding="utf-8")
        config.chmod(0o644)
        result = self.install("--user", "operator")
        self.assertEqual(result.returncode, 0, result.stderr)
        rule = (self.root / "etc/polkit-1/rules.d/50-t900-ground-link.rules").read_text(encoding="utf-8")
        self.assertIn('unit === "gs-ppp.service"', rule)
        self.assertIn('subject.user !== "operator"', rule)
        self.assertIn("After=gs-ppp.service", (self.root / "etc/systemd/system/t900-ground-watchdog.service").read_text())
        config.write_text("PPP_SERVICE=gs-ppp.service\nFAIL_AFTR=1\n", encoding="utf-8")
        result = self.install()
        self.assertEqual(result.returncode, 1)
        self.assertIn("unknown setting FAIL_AFTR", result.stderr)

    def test_refuses_to_replace_a_foreign_file(self):
        foreign = self.root / "etc/systemd/system/t900-ground-watchdog.service"
        foreign.write_text("[Service]\nExecStart=/opt/other\n", encoding="utf-8")
        result = self.install()
        self.assertEqual(result.returncode, 1)
        self.assertIn("was not written by this installer", result.stderr)
        self.assertEqual(foreign.read_text(encoding="utf-8"), "[Service]\nExecStart=/opt/other\n")

    def test_no_polkit_and_no_watchdog(self):
        self.assertEqual(self.install().returncode, 0)
        result = self.install("--no-polkit", "--no-watchdog")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / "etc/polkit-1/rules.d/50-t900-ground-link.rules").exists())
        self.assertIn("POLKIT_RULE=\n", (self.root / "usr/local/share/t900-ground-link/install-info").read_text())
        self.assertIn("skipped (--root): systemctl disable --now t900-ground-watchdog.timer", result.stdout)
        self.assertIn("timer off", result.stdout)

    def test_custom_prefix(self):
        result = self.install("--prefix", "/opt/t900")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / "opt/t900/sbin/t900-ground-watchdog").is_file())
        self.assertIn("ExecStart=/opt/t900/sbin/t900-ground-watchdog check",
                      (self.root / "etc/systemd/system/t900-ground-watchdog.service").read_text())

    def test_bad_options_and_root_check(self):
        for args, fragment in ((["--user", "a b"], "not a user name"), (["--prefix", "usr"], "absolute path"),
                               (["--prefix", "/"], "must not be /"), (["--prefix", "/opt/a'b"], "may hold only"),
                               (["--bogus"], "unknown option")):
            result = self.install(*args)
            self.assertEqual(result.returncode, 1, args)
            self.assertIn(fragment, result.stderr)
        self.h.set(uid=1000)
        result = self.h.run(INSTALL)
        self.assertEqual(result.returncode, 1)
        self.assertIn("run as root", result.stderr)

    def test_dry_run_changes_nothing(self):
        self.h.set(uid=1000)
        prefix = self.h.base / "prefix"
        result = self.h.run(INSTALL, "--dry-run", "--prefix", str(prefix))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(prefix.exists())
        self.assertIn("would run: systemctl daemon-reload", result.stdout)
        self.assertIn("would run: systemctl enable --now t900-ground-watchdog.timer", result.stdout)
        self.assertIn(f"ExecStart={prefix}/sbin/t900-ground-watchdog check", result.stdout)
        self.assertIn('subject.user !== "rdf"', result.stdout)
        self.assertIn("Dry run: nothing was changed.", result.stdout)
        self.assertEqual(self.h.actions(), [])

    def test_uninstall_removes_only_its_files(self):
        self.assertEqual(self.install().returncode, 0)
        state = self.root / "var/lib/t900-ground-link"
        state.mkdir(parents=True)
        (state / "state").write_text("HOLD=0\n", encoding="utf-8")
        foreign = self.root / "usr/local/bin/t900-link"
        foreign.write_text("#!/bin/sh\necho mine\n", encoding="utf-8")
        script = self.root / "usr/local/share/t900-ground-link/uninstall.sh"
        result = self.h.run(script, "--root", str(self.root))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("kept /usr/local/bin/t900-link: not written by the t900-ground-link installer", result.stdout)
        self.assertEqual(self.files(), set(self.PRESENT) | {
            "etc/t900-ground-link/link.conf", "var/lib/t900-ground-link/state", "usr/local/bin/t900-link"})
        self.assert_untouched()
        foreign.unlink()
        self.assertEqual(self.install().returncode, 0)
        result = self.h.run(script, "--root", str(self.root), "--purge")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.files(), set(self.PRESENT))
        self.assert_untouched()

    def test_uninstall_dry_run(self):
        self.assertEqual(self.install().returncode, 0)
        before = self.files()
        script = self.root / "usr/local/share/t900-ground-link/uninstall.sh"
        result = self.h.run(script, "--root", str(self.root), "--dry-run", "--purge")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("would run: systemctl disable --now t900-ground-watchdog.timer", result.stdout)
        self.assertIn("would remove /etc/polkit-1/rules.d/50-t900-ground-link.rules", result.stdout)
        self.assertEqual(self.files(), before)

    def test_polkit_rule_is_valid_javascript(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node is not installed")
        self.assertEqual(self.install().returncode, 0)
        rule = self.h.base / "rule.js"
        shutil.copy(self.root / "etc/polkit-1/rules.d/50-t900-ground-link.rules", rule)
        check = subprocess.run([node, "--check", str(rule)], capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stderr)


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
