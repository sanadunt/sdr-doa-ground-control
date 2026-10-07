#!/usr/bin/env python3
"""Contract tests for the local USB and PPP health monitor."""

from __future__ import annotations

import importlib
import subprocess
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Optional

try:
    MONITOR_MODULE = importlib.import_module("tools.system_health_monitor")
except ModuleNotFoundError as exc:
    if exc.name != "tools.system_health_monitor":
        raise
    MONITOR_MODULE = None

PING_ARGS = ["ping", "-n", "-c", "1", "-W", "1", "-I", "ppp0", "10.90.0.2"]


class TestMonitorModulePresence(unittest.TestCase):
    def test_monitor_module_is_available(self) -> None:
        self.assertIsNotNone(
            MONITOR_MODULE,
            "tools.system_health_monitor must implement the tested contract",
        )


class _FakeClock:
    def __init__(self) -> None:
        self.value = 100.0

    def __call__(self) -> float:
        return self.value


class _CommandRunner:
    def __init__(
        self,
        *,
        returncode: int = 0,
        exception: Optional[BaseException] = None,
    ) -> None:
        self.returncode = returncode
        self.exception = exception
        self.calls: list[tuple[list[str], dict[str, Any]]] = []
        self.lock = threading.Lock()

    def __call__(self, args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        with self.lock:
            self.calls.append((list(args), dict(kwargs)))
        if args != PING_ARGS:
            raise AssertionError(f"unexpected command: {args!r}")
        if self.exception is not None:
            raise self.exception
        return subprocess.CompletedProcess(args, self.returncode, stdout="", stderr="")


@unittest.skipIf(MONITOR_MODULE is None, "monitor module is not implemented yet")
class TestSystemHealthMonitor(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="system-health-monitor-")
        self.root = Path(self.temporary.name)
        self.usb_root = self.root / "usb"
        self.net_root = self.root / "net"
        self.usb_root.mkdir()
        self.net_root.mkdir()
        self.runner = _CommandRunner()
        self.clock = _FakeClock()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def new_monitor(
        self,
        *,
        usb_root: Optional[Path] = None,
        net_root: Optional[Path] = None,
        runner: Optional[_CommandRunner] = None,
        clock: Optional[_FakeClock] = None,
    ) -> Any:
        assert MONITOR_MODULE is not None
        return MONITOR_MODULE.SystemHealthMonitor(
            command_runner=runner or self.runner,
            monotonic_clock=clock or self.clock,
            usb_devices_root=usb_root or self.usb_root,
            net_devices_root=net_root or self.net_root,
        )

    def add_usb_device(
        self,
        name: str,
        *,
        vendor: str = "1a86",
        product: str = "7523",
    ) -> None:
        device = self.usb_root / name
        device.mkdir()
        (device / "idVendor").write_text(vendor + "\n", encoding="ascii")
        (device / "idProduct").write_text(product + "\n", encoding="ascii")

    def set_ppp_flags(self, value: str = "0x1001\n") -> None:
        interface = self.net_root / "ppp0"
        interface.mkdir(exist_ok=True)
        (interface / "flags").write_text(value, encoding="ascii")

    def test_usb_no_matching_device_is_not_found(self) -> None:
        self.add_usb_device("1-1", vendor="1234", product="5678")

        snapshot = self.new_monitor().snapshot()

        self.assertEqual(snapshot["usb_telemetry"], "NOT_FOUND")

    def test_usb_one_matching_device_is_present(self) -> None:
        self.add_usb_device("1-2")

        snapshot = self.new_monitor().snapshot()

        self.assertEqual(snapshot["usb_telemetry"], "PRESENT")

    def test_usb_multiple_matching_devices_are_ambiguous(self) -> None:
        self.add_usb_device("1-2")
        self.add_usb_device("2-1")

        snapshot = self.new_monitor().snapshot()

        self.assertEqual(snapshot["usb_telemetry"], "AMBIGUOUS")

    def test_unavailable_or_unreadable_usb_sysfs_is_unknown(self) -> None:
        missing = self.root / "missing-usb"
        unreadable = self.root / "not-a-directory"
        unreadable.write_text("not sysfs", encoding="ascii")

        self.assertEqual(self.new_monitor(usb_root=missing).snapshot()["usb_telemetry"], "UNKNOWN")
        self.assertEqual(self.new_monitor(usb_root=unreadable).snapshot()["usb_telemetry"], "UNKNOWN")

    def test_ppp_down_skips_ping(self) -> None:
        snapshot = self.new_monitor().snapshot()

        self.assertEqual(snapshot["ppp_interface"], "DOWN")
        self.assertEqual(snapshot["raspberry_peer"], "NOT_PROBED")
        self.assertEqual(self.runner.calls, [])

    def test_unknown_ppp_interface_skips_ping(self) -> None:
        missing = self.root / "missing-net"

        snapshot = self.new_monitor(net_root=missing).snapshot()

        self.assertEqual(snapshot["ppp_interface"], "UNKNOWN")
        self.assertEqual(snapshot["raspberry_peer"], "UNKNOWN")
        self.assertEqual(self.runner.calls, [])

    def test_malformed_ppp_flags_are_unknown_and_skip_ping(self) -> None:
        self.set_ppp_flags("not-hex\n")

        snapshot = self.new_monitor().snapshot()

        self.assertEqual(snapshot["ppp_interface"], "UNKNOWN")
        self.assertEqual(snapshot["raspberry_peer"], "UNKNOWN")
        self.assertEqual(self.runner.calls, [])

    def test_ping_reply_and_fixed_route_are_reported(self) -> None:
        self.set_ppp_flags()

        snapshot = self.new_monitor().snapshot()

        self.assertEqual(snapshot["ppp_interface"], "UP")
        self.assertEqual(snapshot["raspberry_peer"], "REACHABLE")
        self.assertEqual([call[0] for call in self.runner.calls], [PING_ARGS])
        kwargs = self.runner.calls[0][1]
        self.assertIs(kwargs["shell"], False)
        self.assertGreater(kwargs["timeout"], 0)
        self.assertLessEqual(kwargs["timeout"], 2)

    def test_ping_no_reply_is_distinct_from_interface_down(self) -> None:
        self.set_ppp_flags()
        runner = _CommandRunner(returncode=1)

        snapshot = self.new_monitor(runner=runner).snapshot()

        self.assertEqual(snapshot["ppp_interface"], "UP")
        self.assertEqual(snapshot["raspberry_peer"], "NO_REPLY")

    def test_ping_error_and_missing_command_are_unknown(self) -> None:
        self.set_ppp_flags()

        error_snapshot = self.new_monitor(runner=_CommandRunner(returncode=2)).snapshot()
        missing_snapshot = self.new_monitor(
            runner=_CommandRunner(exception=FileNotFoundError("ping"))
        ).snapshot()

        self.assertEqual(error_snapshot["raspberry_peer"], "UNKNOWN")
        self.assertEqual(missing_snapshot["raspberry_peer"], "UNKNOWN")

    def test_cache_reuses_snapshot_until_five_seconds_have_elapsed(self) -> None:
        self.set_ppp_flags()
        monitor = self.new_monitor()

        first = monitor.snapshot()
        first_call_count = len(self.runner.calls)
        self.clock.value += 4.999
        cached = monitor.snapshot()
        self.assertEqual(cached, first)
        self.assertEqual(len(self.runner.calls), first_call_count)

        self.clock.value += 0.001
        monitor.snapshot()
        self.assertEqual(len(self.runner.calls), first_call_count + 1)

    def test_slow_snapshot_cannot_bypass_ping_rate_limit(self) -> None:
        self.set_ppp_flags()
        clock_values = [100.0, 106.0, 106.1, 106.1]

        def slow_pre_ping_clock() -> float:
            return clock_values.pop(0) if clock_values else 106.1

        monitor = self.new_monitor(clock=slow_pre_ping_clock)

        monitor.snapshot()
        monitor.snapshot()

        self.assertEqual([call[0] for call in self.runner.calls], [PING_ARGS])

    def test_concurrent_reads_share_one_probe(self) -> None:
        self.set_ppp_flags()
        monitor = self.new_monitor()
        readers = 8
        barrier = threading.Barrier(readers)

        def read_snapshot() -> dict[str, Any]:
            barrier.wait(timeout=3)
            return monitor.snapshot()

        with ThreadPoolExecutor(max_workers=readers) as executor:
            snapshots = list(executor.map(lambda _: read_snapshot(), range(readers)))

        self.assertTrue(all(snapshot == snapshots[0] for snapshot in snapshots))
        self.assertEqual([call[0] for call in self.runner.calls], [PING_ARGS])
        self.assertEqual(set(snapshots[0]), {
            "checked_at_ms",
            "usb_telemetry",
            "ppp_interface",
            "raspberry_peer",
        })
        self.assertIsInstance(snapshots[0]["checked_at_ms"], int)
