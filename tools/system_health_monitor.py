#!/usr/bin/env python3
"""Read-only local USB and PPP reachability checks for System Health."""

from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional

USB_DEVICES_ROOT = Path("/sys/bus/usb/devices")
NET_DEVICES_ROOT = Path("/sys/class/net")
USB_VENDOR_ID = "1a86"
USB_PRODUCT_ID = "7523"
PPP_INTERFACE = "ppp0"
RASPBERRY_PEER = "10.90.0.2"
IFF_UP = 0x1
CACHE_SECONDS = 5.0
PING_TIMEOUT_SECONDS = 2.0
PING_COMMAND = ("ping", "-n", "-c", "1", "-W", "1", "-I", PPP_INTERFACE, RASPBERRY_PEER)


class SystemHealthMonitor:
    """Cache sanitized local status while enforcing a five-second probe gap."""

    def __init__(
        self,
        *,
        command_runner: Optional[Callable[..., Any]] = None,
        monotonic_clock: Optional[Callable[[], float]] = None,
        usb_devices_root: Path = USB_DEVICES_ROOT,
        net_devices_root: Path = NET_DEVICES_ROOT,
    ) -> None:
        self._command_runner = command_runner if command_runner is not None else subprocess.run
        self._monotonic_clock = monotonic_clock if monotonic_clock is not None else time.monotonic
        self._usb_devices_root = Path(usb_devices_root)
        self._net_devices_root = Path(net_devices_root)
        self._lock = threading.Lock()
        self._last_probe_started: Optional[float] = None
        self._cached_snapshot: Optional[Dict[str, Any]] = None
        self._last_ping_started: Optional[float] = None
        self._cached_peer_state: Optional[str] = None

    def snapshot(self) -> Dict[str, Any]:
        """Return the latest observation, probing no more often than every five seconds."""
        with self._lock:
            now = self._monotonic_clock()
            if (
                self._cached_snapshot is not None
                and self._last_probe_started is not None
                and now - self._last_probe_started < CACHE_SECONDS
            ):
                return dict(self._cached_snapshot)

            # Start-time accounting keeps concurrent callers from launching a
            # second ping until a full interval has elapsed, even if a probe is slow.
            self._last_probe_started = now
            usb_state = self._usb_telemetry_state()
            ppp_state = self._ppp_interface_state()
            if ppp_state == "DOWN":
                peer_state = "NOT_PROBED"
            elif ppp_state == "UNKNOWN":
                peer_state = "UNKNOWN"
            else:
                peer_state = self._raspberry_peer_state()

            snapshot = {
                "checked_at_ms": int(time.time() * 1000),
                "usb_telemetry": usb_state,
                "ppp_interface": ppp_state,
                "raspberry_peer": peer_state,
            }
            self._cached_snapshot = snapshot
            return dict(snapshot)

    def _usb_telemetry_state(self) -> str:
        matches = 0
        try:
            for device in self._usb_devices_root.iterdir():
                try:
                    vendor_id = (device / "idVendor").read_text(encoding="ascii").strip().lower()
                except FileNotFoundError:
                    # USB interface entries do not have device-level IDs.
                    continue
                except (OSError, UnicodeError):
                    return "UNKNOWN"

                try:
                    product_id = (device / "idProduct").read_text(encoding="ascii").strip().lower()
                except (OSError, UnicodeError):
                    return "UNKNOWN"

                if vendor_id == USB_VENDOR_ID and product_id == USB_PRODUCT_ID:
                    matches += 1
                    if matches > 1:
                        return "AMBIGUOUS"
        except OSError:
            return "UNKNOWN"

        if matches == 0:
            return "NOT_FOUND"
        return "PRESENT"

    def _ppp_interface_state(self) -> str:
        try:
            self._net_devices_root.stat()
        except OSError:
            return "UNKNOWN"

        interface_path = self._net_devices_root / PPP_INTERFACE
        try:
            interface_path.stat()
        except FileNotFoundError:
            return "DOWN"
        except OSError:
            return "UNKNOWN"

        try:
            flags_text = (interface_path / "flags").read_text(encoding="ascii").strip()
            flags = int(flags_text, 16)
        except (OSError, UnicodeError, ValueError):
            return "UNKNOWN"

        return "UP" if flags & IFF_UP else "DOWN"

    def _raspberry_peer_state(self) -> str:
        now = self._monotonic_clock()
        if (
            self._last_ping_started is not None
            and now - self._last_ping_started < CACHE_SECONDS
        ):
            return self._cached_peer_state or "UNKNOWN"

        # Guard the ICMP send itself: USB/sysfs work before this point must not
        # shorten the required interval between echo requests.
        self._last_ping_started = now
        try:
            result = self._command_runner(
                list(PING_COMMAND),
                capture_output=True,
                check=False,
                shell=False,
                text=True,
                timeout=PING_TIMEOUT_SECONDS,
            )
        except (OSError, subprocess.SubprocessError):
            peer_state = "UNKNOWN"
        else:
            if result.returncode == 0:
                peer_state = "REACHABLE"
            elif result.returncode == 1:
                peer_state = "NO_REPLY"
            else:
                peer_state = "UNKNOWN"

        self._cached_peer_state = peer_state
        return peer_state
