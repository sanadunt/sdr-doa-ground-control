#!/usr/bin/env python3
"""Bounded MQTT 3.1.1 client using only the Python standard library.

This is intentionally a small client for the SDR-DoA edge path. It supports
CONNECT, PUBLISH QoS 0/1, SUBSCRIBE QoS 1, incoming PUBLISH, PUBACK/SUBACK,
keepalive, and DISCONNECT. All broker-facing input is validated before it is
handed to the agent.
"""

from __future__ import annotations

import select
import ipaddress
import socket
import ssl
import struct
import time
from dataclasses import dataclass
from typing import Callable, List, Optional, Tuple


MAX_PACKET_REMAINING = 64 * 1024
MAX_TOPIC_BYTES = 1024
MAX_PAYLOAD_BYTES = 16 * 1024
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


class MqttProtocolError(RuntimeError):
    """Raised when a broker returns an invalid or unexpected MQTT packet."""


def is_loopback_host(host: str) -> bool:
    """Return whether *host* is an explicitly loopback endpoint.

    Hostnames other than ``localhost`` are treated as non-loopback rather than
    being resolved implicitly.  That makes an accidental DNS result unable to
    downgrade the transport security policy.
    """
    if not isinstance(host, str):
        return False
    value = host.strip().lower()
    if value.startswith("[") and value.endswith("]"):
        value = value[1:-1]
    if value in LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def _encode_remaining_length(value: int) -> bytes:
    if value < 0 or value > 268_435_455:
        raise ValueError("MQTT remaining length outside supported range")
    result = bytearray()
    remaining = value
    while True:
        digit = remaining % 128
        remaining //= 128
        if remaining:
            digit |= 128
        result.append(digit)
        if not remaining:
            return bytes(result)


def _decode_remaining_length(sock: socket.socket) -> int:
    multiplier = 1
    value = 0
    for index in range(4):
        raw = sock.recv(1)
        if not raw:
            raise ConnectionError("broker closed while reading MQTT length")
        digit = raw[0]
        value += (digit & 127) * multiplier
        if value > MAX_PACKET_REMAINING:
            raise MqttProtocolError("MQTT packet exceeds local size limit")
        if not digit & 128:
            return value
        if index == 3:
            raise MqttProtocolError("malformed MQTT remaining length")
        multiplier *= 128
    raise MqttProtocolError("malformed MQTT remaining length")


def _read_exact(sock: socket.socket, size: int) -> bytes:
    if size < 0 or size > MAX_PACKET_REMAINING:
        raise MqttProtocolError("MQTT read size outside local limit")
    chunks = bytearray()
    while len(chunks) < size:
        chunk = sock.recv(size - len(chunks))
        if not chunk:
            raise ConnectionError("broker closed while reading MQTT packet")
        chunks.extend(chunk)
    return bytes(chunks)


def _utf8(value: str, field: str = "MQTT UTF-8 field") -> bytes:
    if not isinstance(value, str) or "\x00" in value:
        raise ValueError(f"{field} is not valid MQTT UTF-8 text")
    encoded = value.encode("utf-8")
    if len(encoded) > 65_535:
        raise ValueError(f"{field} exceeds 65535 bytes")
    return struct.pack("!H", len(encoded)) + encoded


def _validate_fixed_header(packet_type: int, flags: int) -> None:
    if not 1 <= packet_type <= 14:
        raise MqttProtocolError("unsupported MQTT packet type")
    if packet_type == 3:  # PUBLISH flags are variable, checked after parsing.
        qos = (flags >> 1) & 0x03
        if qos == 3:
            raise MqttProtocolError("MQTT PUBLISH QoS 3 is invalid")
        if qos == 0 and flags & 0x08:
            raise MqttProtocolError("MQTT PUBLISH DUP must be zero for QoS 0")
        return
    expected = {
        2: 0x00,  # CONNACK
        4: 0x00,  # PUBACK
        5: 0x00,  # PUBREC
        6: 0x02,  # PUBREL
        7: 0x00,  # PUBCOMP
        9: 0x00,  # SUBACK
        11: 0x00,  # UNSUBACK
        12: 0x00,  # PINGREQ
        13: 0x00,  # PINGRESP
        14: 0x00,  # DISCONNECT
    }.get(packet_type)
    if expected is None or flags != expected:
        raise MqttProtocolError("invalid MQTT fixed-header flags")


@dataclass(frozen=True)
class PublishResult:
    topic: str
    qos: int
    retain: bool
    payload_bytes: int


@dataclass(frozen=True)
class IncomingMessage:
    topic: str
    payload: bytes
    qos: int
    retain: bool
    duplicate: bool


class Mqtt311Client:
    """Small reconnectable MQTT client for one edge-agent connection."""

    def __init__(
        self,
        host: str,
        port: int,
        client_id: str,
        connect_timeout: float = 5.0,
        keepalive: int = 30,
        on_message: Optional[Callable[[IncomingMessage], None]] = None,
        *,
        username: Optional[str] = None,
        password: Optional[str] = None,
        tls_context: Optional[ssl.SSLContext] = None,
        require_secure: bool = False,
    ) -> None:
        if not isinstance(host, str) or not host.strip() or any(ch.isspace() for ch in host):
            raise ValueError("MQTT host is required and must not contain whitespace")
        if not 1 <= int(port) <= 65_535:
            raise ValueError("MQTT port must be between 1 and 65535")
        if not isinstance(client_id, str) or not client_id or len(client_id.encode("utf-8")) > 128:
            raise ValueError("MQTT client_id must be non-empty and bounded")
        if keepalive < 0 or keepalive > 65_535:
            raise ValueError("MQTT keepalive must be between 0 and 65535")
        if password is not None and username is None:
            raise ValueError("MQTT password requires a username")
        if username is not None:
            if not username:
                raise ValueError("MQTT username must not be empty")
            _utf8(username, "MQTT username")
        if password is not None:
            _utf8(password, "MQTT password")
        secure_required = bool(require_secure) or not is_loopback_host(host)
        if secure_required and (tls_context is None or username is None):
            raise ValueError("non-loopback MQTT requires TLS and broker authentication")
        self.host = host.strip()
        self.port = int(port)
        self.client_id = client_id
        self.connect_timeout = float(connect_timeout)
        self.keepalive = int(keepalive)
        self.on_message = on_message
        self.username = username
        self.password = password
        self.tls_context = tls_context
        self.require_secure = secure_required
        self._sock: Optional[socket.socket] = None
        self._packet_id = 0
        self._last_activity = 0.0
        self._ping_sent_at: Optional[float] = None
        self._subscriptions: List[Tuple[str, int]] = []

    @property
    def connected(self) -> bool:
        return self._sock is not None

    def _build_connect_packet(self) -> bytes:
        connect_flags = 0x02  # clean session
        payload = bytearray(_utf8(self.client_id, "MQTT client_id"))
        if self.username is not None:
            connect_flags |= 0x80
            payload.extend(_utf8(self.username, "MQTT username"))
            if self.password is not None:
                connect_flags |= 0x40
                payload.extend(_utf8(self.password, "MQTT password"))
        variable = _utf8("MQTT", "MQTT protocol name") + bytes((4, connect_flags))
        variable += struct.pack("!H", self.keepalive)
        packet = variable + bytes(payload)
        return b"\x10" + _encode_remaining_length(len(packet)) + packet

    def connect(self) -> None:
        self.close()
        sock: Optional[socket.socket] = None
        try:
            sock = socket.create_connection((self.host, self.port), timeout=self.connect_timeout)
            sock.settimeout(self.connect_timeout)
            if self.tls_context is not None:
                sock = self.tls_context.wrap_socket(sock, server_hostname=self.host)
                sock.settimeout(self.connect_timeout)
            # Assign before any read so every CONNECT failure is cleaned up by
            # close(), including malformed CONNACK and TLS/read failures.
            self._sock = sock
            sock.sendall(self._build_connect_packet())
            packet_type, flags, payload = self._read_packet(sock)
            if packet_type != 2 or flags != 0 or len(payload) != 2:
                raise MqttProtocolError("invalid MQTT CONNACK")
            if payload[0] & 0xFE:
                raise MqttProtocolError("invalid MQTT CONNACK session-present flag")
            if payload[0] & 0x01:
                raise MqttProtocolError("clean-session CONNACK unexpectedly has a session")
            if payload[1] != 0:
                raise MqttProtocolError(f"MQTT CONNACK refused: {payload[1]}")
            self._last_activity = time.monotonic()
            self._ping_sent_at = None
            # Re-subscribe after every clean reconnect.
            for topic, qos in list(self._subscriptions):
                self._subscribe_once(topic, qos)
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        sock, self._sock = self._sock, None
        self._ping_sent_at = None
        if sock is not None:
            try:
                sock.sendall(b"\xE0\x00")
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass

    def _next_packet_id(self) -> int:
        self._packet_id = (self._packet_id % 65_535) + 1
        return self._packet_id

    @staticmethod
    def _read_packet(sock: socket.socket) -> Tuple[int, int, bytes]:
        first = _read_exact(sock, 1)[0]
        packet_type, flags = first >> 4, first & 0x0F
        _validate_fixed_header(packet_type, flags)
        remaining = _decode_remaining_length(sock)
        return packet_type, flags, _read_exact(sock, remaining)

    def _ensure_socket(self) -> socket.socket:
        if self._sock is None:
            raise ConnectionError("MQTT client is not connected")
        return self._sock

    def _send_ping_if_due(self) -> None:
        if self.keepalive == 0:
            return
        sock = self._ensure_socket()
        now = time.monotonic()
        if self._ping_sent_at is not None:
            if now - self._ping_sent_at > self.keepalive / 2:
                raise TimeoutError("MQTT broker did not answer PINGRESP")
            return
        if now - self._last_activity >= self.keepalive / 2:
            sock.sendall(b"\xC0\x00")
            self._last_activity = now
            self._ping_sent_at = now

    def _parse_incoming_publish(self, flags: int, payload: bytes) -> IncomingMessage:
        if len(payload) < 2:
            raise MqttProtocolError("short MQTT PUBLISH")
        topic_size = struct.unpack("!H", payload[:2])[0]
        if topic_size == 0 or topic_size > MAX_TOPIC_BYTES:
            raise MqttProtocolError("invalid MQTT PUBLISH topic length")
        cursor = 2 + topic_size
        if len(payload) < cursor:
            raise MqttProtocolError("truncated MQTT PUBLISH topic")
        try:
            topic = payload[2:cursor].decode("utf-8")
        except UnicodeDecodeError as exc:
            raise MqttProtocolError("MQTT PUBLISH topic is not UTF-8") from exc
        if "#" in topic or "+" in topic or "\x00" in topic:
            raise MqttProtocolError("wildcard MQTT PUBLISH topic is invalid")
        qos = (flags >> 1) & 0x03
        retain = bool(flags & 0x01)
        duplicate = bool(flags & 0x08)
        packet_id: Optional[int] = None
        if qos == 1:
            if len(payload) < cursor + 2:
                raise MqttProtocolError("truncated MQTT PUBLISH packet id")
            packet_id = struct.unpack("!H", payload[cursor:cursor + 2])[0]
            if packet_id == 0:
                raise MqttProtocolError("MQTT PUBLISH packet id must be non-zero")
            cursor += 2
        elif qos == 2:
            raise MqttProtocolError("incoming MQTT QoS 2 is not supported")
        body = payload[cursor:]
        if len(body) > MAX_PAYLOAD_BYTES:
            raise MqttProtocolError("incoming MQTT PUBLISH payload exceeds local limit")
        if qos == 1 and packet_id is not None:
            sock = self._ensure_socket()
            ack = struct.pack("!H", packet_id)
            sock.sendall(b"\x40" + _encode_remaining_length(2) + ack)
            self._last_activity = time.monotonic()
        return IncomingMessage(topic, body, qos, retain, duplicate)

    def _handle_packet(self, packet_type: int, flags: int, payload: bytes) -> Optional[IncomingMessage]:
        if packet_type == 13:  # PINGRESP
            if flags != 0 or payload:
                raise MqttProtocolError("invalid MQTT PINGRESP")
            self._ping_sent_at = None
            return None
        if packet_type == 14:  # broker-initiated DISCONNECT
            raise ConnectionError("MQTT broker requested disconnect")
        if packet_type == 3:
            message = self._parse_incoming_publish(flags, payload)
            if self.on_message is not None:
                self.on_message(message)
            return message
        if packet_type in {4, 9}:
            # These are consumed by _wait_for. Receiving them from poll() is
            # harmless but they must still have their fixed-header validated.
            return None
        raise MqttProtocolError(f"unexpected MQTT packet type {packet_type}")

    def poll(self, timeout: float = 0.0) -> Optional[IncomingMessage]:
        sock = self._ensure_socket()
        self._send_ping_if_due()
        readable, _writeable, exceptional = select.select([sock], [], [sock], max(0.0, float(timeout)))
        if exceptional:
            raise ConnectionError("MQTT socket entered an exceptional state")
        if not readable:
            return None
        packet_type, flags, payload = self._read_packet(sock)
        self._last_activity = time.monotonic()
        return self._handle_packet(packet_type, flags, payload)

    def _read_packet_with_timeout(self, timeout: float) -> Tuple[int, int, bytes]:
        sock = self._ensure_socket()
        previous = sock.gettimeout()
        sock.settimeout(max(0.01, timeout))
        try:
            result = self._read_packet(sock)
            self._last_activity = time.monotonic()
            return result
        finally:
            sock.settimeout(previous)

    def _wait_for(self, expected_type: int, expected_id: int, timeout: float = 5.0) -> bytes:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            packet_type, flags, payload = self._read_packet_with_timeout(max(0.01, deadline - time.monotonic()))
            if packet_type == 3:
                self._handle_packet(packet_type, flags, payload)
                continue
            if packet_type == 13:
                self._handle_packet(packet_type, flags, payload)
                continue
            if packet_type != expected_type:
                raise MqttProtocolError(f"unexpected MQTT packet type {packet_type} while waiting")
            if expected_type == 4 and len(payload) != 2:
                raise MqttProtocolError("invalid MQTT PUBACK")
            if expected_type == 9 and len(payload) < 3:
                raise MqttProtocolError("invalid MQTT SUBACK")
            if len(payload) < 2 or struct.unpack("!H", payload[:2])[0] != expected_id:
                raise MqttProtocolError("MQTT packet id did not match request")
            return payload
        raise TimeoutError(f"timed out waiting for MQTT packet type {expected_type}")

    def _subscribe_once(self, topic: str, qos: int) -> None:
        sock = self._ensure_socket()
        packet_id = self._next_packet_id()
        body = struct.pack("!H", packet_id) + _utf8(topic, "MQTT subscription topic") + bytes((qos,))
        sock.sendall(b"\x82" + _encode_remaining_length(len(body)) + body)
        self._last_activity = time.monotonic()
        payload = self._wait_for(9, packet_id)
        grants = payload[2:]
        if not grants or any(grant not in (0, 1) for grant in grants):
            raise MqttProtocolError("MQTT SUBACK rejected subscription")

    def subscribe(self, topic: str, qos: int = 1) -> None:
        if qos != 1:
            raise ValueError("the edge agent uses QoS 1 subscriptions")
        if not isinstance(topic, str) or not topic or "\x00" in topic:
            raise ValueError("subscription topic is invalid")
        _utf8(topic, "MQTT subscription topic")
        self._subscribe_once(topic, qos)
        if (topic, qos) not in self._subscriptions:
            self._subscriptions.append((topic, qos))

    def publish(self, topic: str, payload: bytes, qos: int = 0, retain: bool = False) -> PublishResult:
        if qos not in (0, 1):
            raise ValueError("only MQTT QoS 0 and 1 are supported")
        if not isinstance(topic, str) or not topic or any(ch in topic for ch in ("#", "+", "\x00")):
            raise ValueError("MQTT publish topic is invalid")
        topic_bytes = _utf8(topic, "MQTT publish topic")
        if not isinstance(payload, bytes):
            raise TypeError("payload must be bytes")
        if len(payload) > MAX_PAYLOAD_BYTES:
            raise ValueError("MQTT publish payload exceeds local limit")
        sock = self._ensure_socket()
        self._send_ping_if_due()
        packet_id = self._next_packet_id() if qos == 1 else None
        variable = topic_bytes
        if packet_id is not None:
            variable += struct.pack("!H", packet_id)
        body = variable + payload
        flags = (qos << 1) | (1 if retain else 0)
        sock.sendall(bytes((0x30 | flags,)) + _encode_remaining_length(len(body)) + body)
        self._last_activity = time.monotonic()
        if packet_id is not None:
            self._wait_for(4, packet_id)
        return PublishResult(topic, qos, retain, len(payload))

    def __enter__(self) -> "Mqtt311Client":
        self.connect()
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        self.close()


# Backward-compatible alias for the first staging implementation.
Mqtt311Publisher = Mqtt311Client


def create_default_tls_context(cafile: Optional[str] = None) -> ssl.SSLContext:
    """Create a verifying TLS context for a secured broker."""
    context = ssl.create_default_context(ssl.Purpose.SERVER_AUTH, cafile=cafile)
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    return context


__all__ = [
    "IncomingMessage",
    "Mqtt311Client",
    "Mqtt311Publisher",
    "MqttProtocolError",
    "PublishResult",
    "create_default_tls_context",
    "is_loopback_host",
]
