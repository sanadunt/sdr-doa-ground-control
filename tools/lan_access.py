#!/usr/bin/env python3
"""Rules of the opt-in LAN view listener.

The console's own listener binds loopback only. The ``lan_access`` block of
``console.json`` can open a second, separate listener in the same process so a
tablet or another computer on the LAN can watch the console. That listener:

* is off by default, and opens only while admin login has a password of its
  own (not the built-in default, not disabled);
* admits only client addresses listed in ``allowed_clients`` (IPv4/IPv6
  addresses or networks, at most 32, none broader than /16 or /48, none
  loopback only); an empty list admits nobody. Another address gets a bare
  403 from the accept thread, without a handler thread and without its
  request being read;
* runs at most ``MAX_CONNECTIONS`` requests at once (a bare 503 beyond), and
  each must send its request line and headers within ``REQUEST_DEADLINE_S``;
* answers GET and HEAD of the built UI and of a fixed list of read-only API
  routes; every other method and path is refused with ``LAN_READ_ONLY``, and
  an admin cookie is never honoured;
* refuses a Host that is not an IP literal, this machine's host name or
  ``<host name>.local`` (DNS rebinding), and a cross-site Sec-Fetch-Site.

This module holds the settings validation, the request rules and the socket
helpers of the listener (``AnsweredSockets``, ``request_reader``); the
listener itself lives in ``ground_console.py``. Standard library only.
"""

from __future__ import annotations

import io
import ipaddress
import selectors
import socket
import threading
import time
from collections import OrderedDict
from typing import Any, Callable, Dict, FrozenSet, Iterable, List, Optional, Sequence, Tuple, Union
from urllib.parse import urlsplit

Network = Union[ipaddress.IPv4Network, ipaddress.IPv6Network]
Address = Union[ipaddress.IPv4Address, ipaddress.IPv6Address]

DEFAULT_PORT = 8788
MIN_PORT = 1024
MAX_PORT = 65535
DEFAULT_BIND = "0.0.0.0"
WILDCARD_BINDS = ("0.0.0.0", "::")
MAX_ALLOWED_CLIENTS = 32
MAX_CLIENT_ENTRY_CHARS = 64
# The broadest network one entry may name: a /16 is a large site LAN, a /48
# an IPv6 site prefix. Anything broader is closer to "everyone".
MIN_IPV4_PREFIX = 16
MIN_IPV6_PREFIX = 48
FIELDS = ("enabled", "port", "bind", "allowed_clients")

# A refused address is logged at most once per interval; the record of
# addresses is bounded so a scan of the LAN cannot grow it without limit.
REFUSAL_LOG_INTERVAL_S = 60.0
REFUSAL_LOG_MAX_ADDRESSES = 1024
# Resource bounds of the LAN listener. An allowed client gets a handler
# thread while fewer than MAX_CONNECTIONS requests are open (a bare 503
# otherwise); its request line and headers must arrive within
# REQUEST_DEADLINE_S in all, and REQUEST_TIMEOUT_S bounds each single read and
# write, which leaves room for a slow Data Out read. A refused or busy answer
# is sent from the accept thread; its socket stays open after that only to
# drop the request bytes still arriving (AnsweredSockets): at most
# ANSWERED_MAX_SOCKETS sockets, each for ANSWERED_LINGER_S and
# ANSWERED_MAX_BYTES at most.
MAX_CONNECTIONS = 32
REQUEST_DEADLINE_S = 10.0
REQUEST_TIMEOUT_S = 30.0
ANSWERED_MAX_SOCKETS = 64
ANSWERED_LINGER_S = 2.0
ANSWERED_MAX_BYTES = 64 * 1024
# A refused write's body (405) up to this size is read and dropped before the
# answer, so the client gets the 405 rather than a connection reset.
MAX_DISCARDED_BODY_BYTES = 64 * 1024

# The whole answer to a client address the LAN view does not admit: no body,
# no server name, nothing about the console.
REFUSED_ANSWER = (
    b"HTTP/1.0 403 Forbidden\r\n"
    b"Content-Length: 0\r\n"
    b"Cache-Control: no-store\r\n"
    b"Connection: close\r\n"
    b"\r\n"
)
# The answer to an allowed client while MAX_CONNECTIONS requests are open.
BUSY_ANSWER = (
    b"HTTP/1.0 503 Service Unavailable\r\n"
    b"Content-Length: 0\r\n"
    b"Retry-After: 1\r\n"
    b"Cache-Control: no-store\r\n"
    b"Connection: close\r\n"
    b"\r\n"
)

# /api/capabilities "access": the loopback listener or the LAN view.
ACCESS_LOCAL = "local"
ACCESS_LAN_VIEW = "lan-view"

# Error codes of the LAN view and of POST /api/lan-access. They are sent
# through their own helper, so the Kontrol error-code contract never counts
# them.
LAN_READ_ONLY = "LAN_READ_ONLY"
LAN_ACCESS_INVALID = "LAN_ACCESS_INVALID"
LAN_ADMIN_PASSWORD_DEFAULT = "LAN_ADMIN_PASSWORD_DEFAULT"
LAN_ACCESS_SAVE_FAILED = "LAN_ACCESS_SAVE_FAILED"
ORIGIN_REJECTED = "ORIGIN_REJECTED"
ADMIN_REQUIRED = "ADMIN_REQUIRED"

# The listener's state, and why it is closed ("reason" in the status).
STATE_OPEN = "open"
STATE_CLOSED = "closed"
CLOSED_DISABLED = "DISABLED"
CLOSED_ADMIN_PASSWORD_DEFAULT = "ADMIN_PASSWORD_DEFAULT"
CLOSED_ADMIN_DISABLED = "ADMIN_DISABLED"
CLOSED_PORT_CONFLICT = "PORT_CONFLICT"
CLOSED_BIND_FAILED = "BIND_FAILED"
CLOSED_STOPPED = "STOPPED"
CLOSED_REASON_TEXT = {
    CLOSED_DISABLED: "lan_access.enabled is false",
    CLOSED_ADMIN_PASSWORD_DEFAULT: "the default admin password is in use; set SDR_DOA_ADMIN_PASSWORD first",
    CLOSED_ADMIN_DISABLED: "admin login is disabled (SDR_DOA_ADMIN_PASSWORD is empty or the env file is unreadable)",
    CLOSED_PORT_CONFLICT: "lan_access.port is the console's own port",
    CLOSED_BIND_FAILED: "the address could not be bound",
    CLOSED_STOPPED: "the console is stopping",
}

# GET/HEAD routes the LAN view answers. The UI is the built frontend only
# (never /receiver/), and every other /api/ path is refused.
UI_ROOT_PATHS = frozenset({"/", "/index.html", "/favicon.ico", "/favicon.svg"})
UI_ASSET_PREFIX = "/assets/"
TILE_PREFIX = "/api/tiles/"
API_ROUTES = frozenset({
    "/api/health",
    "/api/capabilities",
    "/api/snapshot",
    "/api/console-config",
    "/api/mqtt",
    "/api/mqtt/rdf-node",
    "/api/preferences",
    "/api/branding",
    "/api/admin/status",
    # The Receiver mirror (receiver_mirror.py): the kiosk's Receiver, view only.
    "/api/mirror/receiver",
})
ROUTE_UI = "ui"
ROUTE_TILE = "tile"
READ_METHODS = ("GET", "HEAD")


def default_settings() -> Dict[str, Any]:
    return {"enabled": False, "port": DEFAULT_PORT, "bind": DEFAULT_BIND, "allowed_clients": []}


def _integer(value: Any, field: str) -> int:
    """A JSON integer without coercion: no booleans, no fractions, no strings."""
    if isinstance(value, bool):
        raise ValueError(f"{field} must be an integer")
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    raise ValueError(f"{field} must be an integer")


def normalize_bind(value: Any) -> str:
    """0.0.0.0, :: or the literal address of one of this host's LAN interfaces."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("lan_access.bind must be 0.0.0.0, :: or an IP address of this host")
    text = value.strip()
    try:
        address = ipaddress.ip_address(text)
    except ValueError as exc:
        raise ValueError("lan_access.bind must be 0.0.0.0, :: or an IP address of this host") from exc
    if address.is_unspecified:
        return WILDCARD_BINDS[0] if address.version == 4 else WILDCARD_BINDS[1]
    if address.is_loopback:
        raise ValueError("lan_access.bind must not be a loopback address; the console itself listens there")
    if address.is_multicast:
        raise ValueError("lan_access.bind must not be a multicast address")
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            raise ValueError("lan_access.bind: write the IPv4 address in its IPv4 form")
        if address.is_link_local:
            raise ValueError("lan_access.bind must not be an IPv6 link-local address")
    return str(address)


def parse_client(entry: Any) -> Network:
    """One allowed_clients entry as a network; a plain address is a /32 or /128."""
    if not isinstance(entry, str) or not entry.strip() or len(entry) > MAX_CLIENT_ENTRY_CHARS:
        raise ValueError(f"allowed_clients entries must be IPv4/IPv6 addresses or networks of at most {MAX_CLIENT_ENTRY_CHARS} characters")
    text = entry.strip()
    if "%" in text:
        raise ValueError(f"allowed_clients: {text!r} carries a zone; write the address without it")
    try:
        network = ipaddress.ip_network(text, strict=False)
    except ValueError as exc:
        raise ValueError(f"allowed_clients: {text!r} is not an IPv4/IPv6 address or network") from exc
    if network.prefixlen == 0:
        raise ValueError(f"allowed_clients: {text!r} would admit every address")
    minimum = MIN_IPV4_PREFIX if network.version == 4 else MIN_IPV6_PREFIX
    if network.prefixlen < minimum:
        raise ValueError(f"allowed_clients: {text!r} is broader than /{minimum}")
    if network.is_loopback:
        raise ValueError(f"allowed_clients: {text!r} is loopback only; the LAN view is for other hosts")
    if network.network_address.is_unspecified:
        raise ValueError(f"allowed_clients: {text!r} is the unspecified address")
    if network.is_multicast:
        raise ValueError(f"allowed_clients: {text!r} is a multicast network")
    if isinstance(network, ipaddress.IPv6Network) and network.network_address.ipv4_mapped is not None:
        raise ValueError(f"allowed_clients: write {text!r} in its IPv4 form")
    return network


def client_text(network: Network) -> str:
    """The stored form: a bare address for one host, otherwise address/prefix."""
    if network.prefixlen == network.max_prefixlen:
        return str(network.network_address)
    return network.with_prefixlen


def validate_settings(
    value: Any,
    fallback: Optional[Dict[str, Any]] = None,
    *,
    console_port: Optional[int] = None,
) -> Dict[str, Any]:
    """Normalize a lan_access block; fields it leaves out come from ``fallback``.

    Raises ValueError naming the first bad field. ``console_port``, when
    known, may not be reused by the LAN view.
    """
    if not isinstance(value, dict):
        raise ValueError("lan_access must be a JSON object")
    unknown = sorted(str(key) for key in value if key not in FIELDS)
    if unknown:
        raise ValueError(f"lan_access has unknown field(s): {', '.join(unknown)}")
    merged = {**(fallback if fallback is not None else default_settings()), **value}
    enabled = merged.get("enabled")
    if not isinstance(enabled, bool):
        raise ValueError("lan_access.enabled must be true or false")
    port = _integer(merged.get("port"), "lan_access.port")
    if not MIN_PORT <= port <= MAX_PORT:
        raise ValueError(f"lan_access.port must be between {MIN_PORT} and {MAX_PORT}")
    if console_port is not None and port == console_port:
        raise ValueError(f"lan_access.port must not be the console port {console_port}")
    bind = normalize_bind(merged.get("bind"))
    clients = merged.get("allowed_clients")
    if not isinstance(clients, list):
        raise ValueError("lan_access.allowed_clients must be a list")
    if len(clients) > MAX_ALLOWED_CLIENTS:
        raise ValueError(f"lan_access.allowed_clients holds at most {MAX_ALLOWED_CLIENTS} entries")
    normalized: List[str] = []
    for entry in clients:
        text = client_text(parse_client(entry))
        if text not in normalized:
            normalized.append(text)
    return {"enabled": enabled, "port": port, "bind": bind, "allowed_clients": normalized}


def networks(settings: Dict[str, Any]) -> List[Network]:
    return [parse_client(entry) for entry in settings.get("allowed_clients", [])]


def client_address(address: Any) -> Optional[Address]:
    """The peer address of a socket, an IPv4-mapped IPv6 peer as IPv4, no zone."""
    text = str(address).split("%", 1)[0]
    try:
        parsed = ipaddress.ip_address(text)
    except ValueError:
        return None
    if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped is not None:
        return parsed.ipv4_mapped
    return parsed


def client_allowed(allowed: Sequence[Network], address: Any) -> bool:
    parsed = client_address(address)
    return parsed is not None and any(parsed in network for network in allowed)


def own_host_names() -> FrozenSet[str]:
    """The names a LAN Host may carry: this machine's host name, its first label and ``<first label>.local``.

    In lower case; avahi publishes the first label under ``.local``.
    """
    try:
        name = socket.gethostname()
    except OSError:
        return frozenset()
    name = name.strip().lower().rstrip(".")
    first = name.split(".", 1)[0]
    names = {name, first} - {"", "localhost"}
    if first and first != "localhost":
        names.add(f"{first}.local")
    return frozenset(names)


def host_allowed(values: Sequence[str], port: int, own_names: Iterable[str]) -> bool:
    """Exactly one Host on ``port``: an IP literal or one of ``own_names`` (own_host_names()).

    A DNS rebinding page sends its own host name. Any other name, a ``.local``
    one included, may be answered by another host (on the LAN anyone can
    answer mDNS for a free name), so only this machine's own names pass.
    """
    if len(values) != 1:
        return False
    host = values[0].strip()
    if not host or len(host) > 255:
        return False
    try:
        target = urlsplit(f"http://{host}")
        target_port = target.port
    except ValueError:
        return False
    if target.username is not None or target.password is not None or target.path or target.query or target.fragment:
        return False
    if target_port != port:
        return False
    hostname = (target.hostname or "").lower().rstrip(".")
    if not hostname:
        return False
    try:
        ipaddress.ip_address(hostname)
        return True
    except ValueError:
        pass
    return hostname in set(own_names)


def fetch_site_allowed(value: Optional[str]) -> bool:
    """Sec-Fetch-Site: a cross-site request is refused; absent, none, same-origin and same-site pass."""
    return (value or "").strip().lower() != "cross-site"


def lan_route(path: str) -> Optional[str]:
    """ROUTE_UI, ROUTE_TILE or the API path for a route the LAN view answers; None otherwise."""
    if path in UI_ROOT_PATHS or (path.startswith(UI_ASSET_PREFIX) and len(path) > len(UI_ASSET_PREFIX)):
        return ROUTE_UI
    if path.startswith(TILE_PREFIX):
        return ROUTE_TILE
    if path in API_ROUTES:
        return path
    return None


class RefusalLog:
    """Log a refused client address at most once per interval."""

    def __init__(
        self,
        log: Callable[[str], None],
        *,
        interval_s: float = REFUSAL_LOG_INTERVAL_S,
        max_addresses: int = REFUSAL_LOG_MAX_ADDRESSES,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._log = log
        self._interval_s = interval_s
        self._max_addresses = max_addresses
        self._clock = clock
        self._lock = threading.Lock()
        self._last: Dict[str, float] = {}

    def note(self, address: str) -> bool:
        """Record one refusal; True when it was logged."""
        with self._lock:
            now = self._clock()
            last = self._last.get(address)
            if last is not None and now - last < self._interval_s:
                return False
            if address not in self._last and len(self._last) >= self._max_addresses:
                self._last = {key: seen for key, seen in self._last.items() if now - seen < self._interval_s}
                if len(self._last) >= self._max_addresses:
                    # Every slot is recent: drop the oldest half rather than grow.
                    keep = sorted(self._last.items(), key=lambda item: item[1])[len(self._last) // 2:]
                    self._last = dict(keep)
            self._last[address] = now
        self._log(f"LAN view refused {address}: not in lan_access.allowed_clients (logged once a minute per address)")
        return True


class _DeadlineReader(io.RawIOBase):
    """The reads of one connection: each waits ``timeout_s`` at most, all together end at ``deadline``.

    A socket timeout alone bounds each read only, so a client that sends a
    byte every few seconds could hold the connection for ever.
    """

    def __init__(self, sock: socket.socket, deadline: float, timeout_s: float, clock: Callable[[], float]) -> None:
        super().__init__()
        self._sock = sock
        self._deadline = deadline
        self._timeout_s = timeout_s
        self._clock = clock

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: Any) -> int:
        remaining = self._deadline - self._clock()
        if remaining <= 0:
            raise socket.timeout("the request did not arrive in time")
        self._sock.settimeout(min(self._timeout_s, remaining))
        try:
            return self._sock.recv_into(buffer)
        finally:
            # Writes keep the full timeout.
            self._sock.settimeout(self._timeout_s)


def request_reader(
    sock: socket.socket,
    *,
    deadline_s: float,
    timeout_s: float,
    clock: Callable[[], float] = time.monotonic,
) -> io.BufferedReader:
    """A buffered reader of ``sock`` whose reads all end ``deadline_s`` from now (socket.timeout)."""
    return io.BufferedReader(_DeadlineReader(sock, clock() + deadline_s, timeout_s, clock))


def _close_quietly(sock: socket.socket) -> None:
    try:
        sock.close()
    except OSError:
        pass


class AnsweredSockets:
    """Connections the LAN listener answered on its accept thread, kept until their peer closes.

    ``answer`` sends a fixed answer without blocking and shuts the write side
    (FIN); the request is never parsed. The socket stays open so the request
    bytes that arrive after the answer are read and dropped: closing a socket
    with unread bytes sends a reset, which can make the client lose the
    answer. ``sweep`` reads what arrived and closes a socket when its peer
    closes, after ``linger_s`` or after ``max_bytes``; beyond ``max_sockets``
    a socket closes right after its answer. Nothing here blocks. Every call
    runs on the listener's serve_forever thread, ``close`` after it ended.
    """

    def __init__(
        self,
        *,
        max_sockets: int,
        linger_s: float,
        max_bytes: int,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_sockets = max_sockets
        self._linger_s = linger_s
        self._max_bytes = max_bytes
        self._clock = clock
        self._selector = selectors.DefaultSelector()
        # socket -> (close deadline, bytes read); insertion order is deadline order.
        self._open: "OrderedDict[socket.socket, Tuple[float, int]]" = OrderedDict()

    def __len__(self) -> int:
        return len(self._open)

    def answer(self, sock: socket.socket, response: bytes) -> None:
        try:
            sock.setblocking(False)
            sent = sock.send(response)
            sock.shutdown(socket.SHUT_WR)
        except OSError:
            _close_quietly(sock)
            return
        if sent != len(response) or len(self._open) >= self._max_sockets:
            _close_quietly(sock)
            return
        try:
            self._selector.register(sock, selectors.EVENT_READ)
        except (OSError, ValueError):
            _close_quietly(sock)
            return
        self._open[sock] = (self._clock() + self._linger_s, 0)

    def sweep(self) -> None:
        if not self._open:
            return
        for key, _events in self._selector.select(0):
            self._read(key.fileobj)  # type: ignore[arg-type]
        now = self._clock()
        while self._open:
            sock, (deadline, _used) = next(iter(self._open.items()))
            if deadline > now:
                break
            self._drop(sock)

    def _read(self, sock: socket.socket) -> None:
        entry = self._open.get(sock)
        if entry is None:
            return
        deadline, used = entry
        try:
            data = sock.recv(self._max_bytes - used)
        except (BlockingIOError, InterruptedError):
            return
        except OSError:
            data = b""
        used += len(data)
        if not data or used >= self._max_bytes:
            self._drop(sock)
        else:
            self._open[sock] = (deadline, used)

    def _drop(self, sock: socket.socket) -> None:
        self._open.pop(sock, None)
        try:
            self._selector.unregister(sock)
        except (KeyError, ValueError, OSError):
            pass
        _close_quietly(sock)

    def close(self) -> None:
        for sock in list(self._open):
            self._drop(sock)
        self._selector.close()
