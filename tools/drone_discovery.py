#!/usr/bin/env python3
"""Find the SIYI drone's remote on the LAN and keep the console's link to it.

The remote gets its address from DHCP, so it moves between networks and
leases. With ``host`` "auto" the console finds it: first the last host that
answered, then every address of the /24 of each IPv4 interface of this host
(TCP 1883, 300 ms, 64 at once). A host with port 1883 open counts only when
its broker sends the bridge's retained ``bridge/link`` within 2 s with a
boolean ``fc_online`` and a string ``version``: the groundstation's own broker
and any other broker on the LAN have none. With several, the one whose FC is
online wins, then the lowest address.

``probe_bridge_link`` speaks just enough MQTT 3.1.1 (CONNECT, SUBSCRIBE,
PUBLISH) to read that one retained message; it publishes nothing.

``DroneService`` owns the ``DroneLink`` (drone_link.py): it starts it on a
fixed host, or on the host the search found, and searches again once the
link has had no broker for 15 s.
"""

from __future__ import annotations

import ipaddress
import json
import secrets
import socket
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence

if __package__:
    from .drone_link import DRONE_PORT, DroneLink
else:
    from drone_link import DRONE_PORT, DroneLink

CONNECT_TIMEOUT_S = 0.3
SCAN_PARALLEL = 64
PROBE_PARALLEL = 8
PROBE_TIMEOUT_S = 2.0
# Without a broker this long the remote may have moved: search again.
RESCAN_AFTER_DISCONNECT_MS = 15_000
# A search that found nothing is tried again after this.
RESCAN_INTERVAL_MS = 15_000
MAX_NETWORKS = 4
MAX_CANDIDATES_SHOWN = 8
PROBE_MAX_PACKET = 8192
AUTO = "auto"


def _now_ms() -> int:
    return int(time.time() * 1000)


def is_drone_host(value: Any) -> bool:
    """A fixed drone host: an IPv4 or IPv6 literal."""
    if not isinstance(value, str) or not value or len(value) > 64:
        return False
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return not (address.is_unspecified or address.is_multicast)


def interface_addresses() -> List[str]:
    """IPv4 addresses of this host's LAN interfaces."""
    found: List[str] = []
    try:
        if __package__:
            from .mdns_resolver import multicast_interface_addresses
        else:
            from mdns_resolver import multicast_interface_addresses
        found.extend(multicast_interface_addresses())
    except Exception:
        pass
    if not found:
        # Off Linux (or without the ioctls): what the host name resolves to.
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                found.append(info[4][0])
        except OSError:
            pass
    usable: List[str] = []
    for value in found:
        try:
            address = ipaddress.IPv4Address(value)
        except ValueError:
            continue
        if address.is_loopback or address.is_link_local or address.is_unspecified or value in usable:
            continue
        usable.append(value)
    return usable


def subnet_hosts(addresses: Iterable[str]) -> List[str]:
    """Every host of the /24 of each address, the addresses themselves left out."""
    own = set()
    networks: List[ipaddress.IPv4Network] = []
    for value in addresses:
        try:
            address = ipaddress.IPv4Address(value)
        except ValueError:
            continue
        own.add(address)
        network = ipaddress.IPv4Network(f"{address}/24", strict=False)
        if network not in networks and len(networks) < MAX_NETWORKS:
            networks.append(network)
    hosts: List[str] = []
    for network in networks:
        hosts.extend(str(host) for host in network.hosts() if host not in own)
    return hosts


def tcp_open(host: str, port: int = DRONE_PORT, timeout_s: float = CONNECT_TIMEOUT_S) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout_s):
            return True
    except OSError:
        return False


def _remaining_length(length: int) -> bytes:
    out = bytearray()
    while True:
        byte = length % 128
        length //= 128
        out.append(byte | (0x80 if length else 0))
        if not length:
            return bytes(out)


def _mqtt_string(value: str) -> bytes:
    raw = value.encode("utf-8")
    return struct.pack("!H", len(raw)) + raw


def _read_exact(sock: socket.socket, count: int) -> bytes:
    data = b""
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            raise OSError("closed")
        data += chunk
    return data


def _read_packet(sock: socket.socket) -> tuple:
    header = _read_exact(sock, 1)[0]
    length = 0
    for shift in range(4):
        byte = _read_exact(sock, 1)[0]
        length |= (byte & 0x7F) << (7 * shift)
        if not byte & 0x80:
            break
    else:
        raise OSError("bad remaining length")
    if length > PROBE_MAX_PACKET:
        raise OSError("packet too large")
    return header, _read_exact(sock, length)


def link_is_bridge(payload: Any) -> Optional[Dict[str, Any]]:
    """The fields of a SIYI Bridge ``bridge/link``, or None for anything else."""
    if not isinstance(payload, dict):
        return None
    if not isinstance(payload.get("fc_online"), bool) or not isinstance(payload.get("version"), str):
        return None
    return {"fc_online": payload["fc_online"], "version": payload["version"][:32]}


def probe_bridge_link(host: str, port: int = DRONE_PORT, timeout_s: float = PROBE_TIMEOUT_S) -> Optional[Dict[str, Any]]:
    """Read the retained ``bridge/link`` of the broker at ``host``; None when it has none."""
    deadline = time.monotonic() + timeout_s
    client_id = "gcprobe" + secrets.token_hex(4)
    try:
        with socket.create_connection((host, port), timeout=timeout_s) as sock:
            variable = _mqtt_string("MQTT") + bytes([4, 0x02]) + struct.pack("!H", 10)
            body = variable + _mqtt_string(client_id)
            sock.sendall(bytes([0x10]) + _remaining_length(len(body)) + body)
            subscribe = struct.pack("!H", 1) + _mqtt_string("bridge/link") + b"\x00"
            subscribed = False
            while time.monotonic() < deadline:
                sock.settimeout(max(0.05, deadline - time.monotonic()))
                kind, data = _read_packet(sock)
                packet = kind >> 4
                if packet == 2:  # CONNACK
                    if len(data) < 2 or data[1] != 0:
                        return None
                    sock.sendall(bytes([0x82]) + _remaining_length(len(subscribe)) + subscribe)
                    subscribed = True
                elif packet == 3 and subscribed:  # PUBLISH
                    qos = (kind >> 1) & 0x03
                    if len(data) < 2:
                        return None
                    topic_length = struct.unpack("!H", data[:2])[0]
                    topic = data[2:2 + topic_length].decode("utf-8", "replace")
                    offset = 2 + topic_length + (2 if qos else 0)
                    if topic != "bridge/link":
                        continue
                    try:
                        payload = json.loads(data[offset:].decode("utf-8"))
                    except (UnicodeDecodeError, ValueError):
                        return None
                    return link_is_bridge(payload)
    except (OSError, ValueError, struct.error):
        return None
    return None


def _address_key(host: str) -> Any:
    try:
        return (0, ipaddress.ip_address(host))
    except ValueError:
        return (1, host)


def choose(candidates: Sequence[Mapping[str, Any]]) -> Optional[str]:
    """The FC that is online first, then the lowest address."""
    if not candidates:
        return None
    best = sorted(candidates, key=lambda item: (not item.get("fc_online"), _address_key(str(item["host"]))))
    return str(best[0]["host"])


def scan(
    hosts: Sequence[str],
    *,
    connect: Callable[[str], bool] = tcp_open,
    probe: Callable[[str], Optional[Dict[str, Any]]] = probe_bridge_link,
    last_host: Optional[str] = None,
    parallel: int = SCAN_PARALLEL,
) -> Dict[str, Any]:
    """Search ``hosts`` for the bridge; ``last_host`` is tried first and wins alone."""
    if last_host:
        found = probe(last_host) if connect(last_host) else None
        if found is not None:
            return {"host": last_host, "candidates": [dict(found, host=last_host)]}
    with ThreadPoolExecutor(max_workers=max(1, parallel)) as pool:
        opened = [host for host, ok in zip(hosts, pool.map(connect, hosts)) if ok]
    candidates: List[Dict[str, Any]] = []
    if opened:
        with ThreadPoolExecutor(max_workers=min(PROBE_PARALLEL, len(opened))) as pool:
            for host, found in zip(opened, pool.map(probe, opened)):
                if found is not None:
                    candidates.append(dict(found, host=host))
    return {"host": choose(candidates), "candidates": candidates}


def drone_settings(value: Any) -> Dict[str, Any]:
    """The ``drone`` block of console.json with every field defaulted."""
    data = value if isinstance(value, dict) else {}
    host = data.get("host", AUTO)
    port = data.get("port", DRONE_PORT)
    offset = data.get("array_heading_offset_deg", 0)
    last_host = data.get("last_host")
    return {
        "enabled": data.get("enabled", True) is not False,
        "host": host if host == AUTO or is_drone_host(host) else AUTO,
        "port": port if type(port) is int and 1 <= port <= 65535 else DRONE_PORT,
        "array_heading_offset_deg": float(offset) if type(offset) in (int, float) and -180 <= offset <= 180 else 0.0,
        "video_enabled": data.get("video_enabled", True) is not False,
        "last_host": last_host if is_drone_host(last_host) else None,
    }


class DroneService:
    """The drone link of the console: on a fixed host, or on the one the search found."""

    def __init__(
        self,
        settings: Mapping[str, Any],
        *,
        link_factory: Callable[..., Any] = DroneLink,
        search: Optional[Callable[[Optional[str]], Dict[str, Any]]] = None,
        on_found: Optional[Callable[[str], None]] = None,
        clock: Callable[[], int] = _now_ms,
    ) -> None:
        self.settings = drone_settings(dict(settings))
        self._link_factory = link_factory
        self._search = search or self._default_search
        self._on_found = on_found
        self._clock = clock
        self._lock = threading.RLock()
        self._link: Any = None
        self._scanning = False
        self._last_scan_at_ms: Optional[int] = None
        self._candidates: List[Dict[str, Any]] = []
        self._last_host = self.settings["last_host"]
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def _default_search(self, last_host: Optional[str]) -> Dict[str, Any]:
        port = self.settings["port"]
        return scan(
            subnet_hosts(interface_addresses()),
            connect=lambda host: tcp_open(host, port),
            probe=lambda host: probe_bridge_link(host, port),
            last_host=last_host,
        )

    @property
    def auto(self) -> bool:
        return self.settings["host"] == AUTO

    def start(self) -> None:
        if not self.settings["enabled"]:
            return
        if not self.auto:
            self._use_host(self.settings["host"])
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="drone-discovery", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5)
        self._thread = None
        with self._lock:
            link, self._link = self._link, None
        if link is not None:
            link.stop()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.step()
            except Exception:
                pass
            self._stop.wait(1.0)

    def _use_host(self, host: str) -> None:
        with self._lock:
            current = self._link
            if current is not None and current.host == host:
                return
            link = self._link_factory(host, self.settings["port"])
            self._link = link
        if current is not None:
            current.stop()
        link.start()

    def step(self) -> None:
        """One round of the search loop: search when there is no link or it has been down 15 s."""
        now = self._clock()
        with self._lock:
            link = self._link
            last_scan = self._last_scan_at_ms
        if link is not None and link.disconnected_for_ms(now) <= RESCAN_AFTER_DISCONNECT_MS:
            return
        if last_scan is not None and now - last_scan < RESCAN_INTERVAL_MS:
            return
        with self._lock:
            self._scanning = True
        try:
            result = self._search(self._last_host)
        finally:
            with self._lock:
                self._scanning = False
                self._last_scan_at_ms = self._clock()
        with self._lock:
            self._candidates = [dict(item) for item in result.get("candidates", [])][:MAX_CANDIDATES_SHOWN]
        host = result.get("host")
        if not host or self._stop.is_set():
            return
        changed = host != self._last_host
        self._last_host = host
        self._use_host(host)
        if changed and self._on_found is not None:
            self._on_found(host)

    def heading_at(self, t_ms: int) -> Optional[Dict[str, Any]]:
        with self._lock:
            link = self._link
        return None if link is None else link.heading_at(t_ms)

    def host(self) -> Optional[str]:
        with self._lock:
            return None if self._link is None else self._link.host

    def view(self, now_ms: Optional[int] = None) -> Dict[str, Any]:
        now = self._clock() if now_ms is None else now_ms
        with self._lock:
            link = self._link
            discovery = {
                "mode": AUTO if self.auto else "fixed",
                "scanning": self._scanning,
                "last_scan_at_ms": self._last_scan_at_ms,
                "candidates": [dict(item) for item in self._candidates],
            }
        if link is not None:
            view = link.view(now)
        else:
            view = {
                "state": "DISABLED" if not self.settings["enabled"] else "NO_DATA",
                "position": None, "gps": None, "attitude": None, "battery": None, "status": None,
                "hud": None, "statustext": None, "link": None, "heading": None,
                "received": 0, "invalid": 0, "last_invalid": None, "notes": [],
                "host": None, "port": self.settings["port"],
                "connection": "disabled" if not self.settings["enabled"] else "searching",
                "last_error": None,
            }
        view.update({
            "enabled": self.settings["enabled"],
            "discovery": discovery,
            "array_heading_offset_deg": self.settings["array_heading_offset_deg"],
            "video_enabled": self.settings["video_enabled"],
        })
        return view


__all__ = [
    "AUTO",
    "DroneService",
    "choose",
    "drone_settings",
    "interface_addresses",
    "is_drone_host",
    "link_is_bridge",
    "probe_bridge_link",
    "scan",
    "subnet_hosts",
]
