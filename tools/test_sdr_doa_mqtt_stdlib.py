#!/usr/bin/env python3
"""Tests for the stdlib-only MQTT client.

The ``test_*`` functions use a local socket pair and need no broker. ``main``
runs them and then an integration check against the staging broker on
127.0.0.1:18884.
"""

from __future__ import annotations

import socket
import struct
import sys
import time
from pathlib import Path
from typing import List, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sdr_doa_mqtt_stdlib as stdlib
from sdr_doa_mqtt_stdlib import IncomingMessage, Mqtt311Client, WillMessage


ROOT = "sdr/v1/test-stdlib"


class FakeClock:
    def __init__(self, start: float = 1_000.0) -> None:
        self.now = start

    def monotonic(self) -> float:
        return self.now


def _read_packet(sock: socket.socket) -> Tuple[int, bytes]:
    first = sock.recv(1)
    multiplier, length = 1, 0
    while True:
        digit = sock.recv(1)[0]
        length += (digit & 127) * multiplier
        if not digit & 128:
            break
        multiplier *= 128
    body = b""
    while len(body) < length:
        body += sock.recv(length - len(body))
    return first[0], body


def _publish_packet(topic: str, payload: bytes) -> bytes:
    body = struct.pack("!H", len(topic)) + topic.encode() + payload
    return bytes((0x30, len(body))) + body


def _connected_pair(client: Mqtt311Client) -> socket.socket:
    local, remote = socket.socketpair()
    client._sock = local
    return remote


def test_connect_packet_carries_retained_will() -> None:
    will = WillMessage(topic=ROOT + "/availability", payload=b'{"online":false}', qos=1, retain=True)
    client = Mqtt311Client("127.0.0.1", 18884, "will-test", keepalive=30, will=will, username="agent", password="pw")
    packet = client._build_connect_packet()
    assert packet[0] == 0x10
    body = packet[2:]
    flags = body[7]
    assert flags & 0x02, "clean session"
    assert flags & 0x04, "will flag"
    assert (flags >> 3) & 0x03 == 1, "will QoS 1"
    assert flags & 0x20, "will retain"
    assert flags & 0xC0 == 0xC0, "username and password"
    cursor = 10
    for expected in (b"will-test", will.topic.encode(), will.payload, b"agent", b"pw"):
        size = struct.unpack("!H", body[cursor:cursor + 2])[0]
        assert body[cursor + 2:cursor + 2 + size] == expected
        cursor += 2 + size
    assert cursor == len(body)

    for bad in (
        WillMessage(topic=ROOT + "/#", payload=b"x"),
        WillMessage(topic=ROOT + "/availability", payload=b"x", qos=2),
    ):
        try:
            Mqtt311Client("127.0.0.1", 18884, "will-test", will=bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid will accepted: {bad}")


def test_keepalive_pings_even_while_receiving() -> None:
    clock = FakeClock()
    original = stdlib.time
    stdlib.time = clock  # type: ignore[assignment]
    remote = None
    client = Mqtt311Client("127.0.0.1", 18884, "keepalive-test", keepalive=4)
    try:
        remote = _connected_pair(client)
        client._last_sent = clock.now
        received: List[bytes] = []
        # Inbound QoS 0 traffic every second must not count as client activity.
        for _ in range(3):
            clock.now += 1.0
            remote.sendall(_publish_packet(ROOT + "/qos0", b"x"))
            message = client.poll(timeout=1.0)
            assert message is not None
            received.append(message.payload)
        remote.setblocking(False)
        try:
            sent = remote.recv(16)
        except BlockingIOError:
            sent = b""
        assert sent == b"\xC0\x00", f"expected PINGREQ after keepalive/2 of client silence, got {sent!r}"
        assert received == [b"x", b"x", b"x"]
    finally:
        stdlib.time = original  # type: ignore[assignment]
        client.close(graceful=False)
        if remote is not None:
            remote.close()


def test_ungraceful_close_skips_disconnect() -> None:
    for graceful, expected in ((True, b"\xE0\x00"), (False, b"")):
        client = Mqtt311Client("127.0.0.1", 18884, "close-test")
        remote = _connected_pair(client)
        try:
            client.close(graceful=graceful)
            remote.settimeout(1.0)
            assert remote.recv(16) == expected
        finally:
            remote.close()


def broker_integration() -> None:
    received: list[IncomingMessage] = []

    def on_message(message: IncomingMessage) -> None:
        received.append(message)

    subscriber = Mqtt311Client(
        "127.0.0.1",
        18884,
        "stdlib-test-subscriber",
        keepalive=10,
        on_message=on_message,
    )
    publisher = Mqtt311Client("127.0.0.1", 18884, "stdlib-test-publisher", keepalive=10)
    try:
        subscriber.connect()
        subscriber.subscribe(ROOT + "/#", qos=1)
        publisher.connect()
        publisher.publish(ROOT + "/qos0", b"qos0", qos=0, retain=False)
        publisher.publish(ROOT + "/qos1", b"qos1", qos=1, retain=False)

        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and len(received) < 2:
            subscriber.poll(timeout=0.1)
        assert sorted(message.topic for message in received) == [ROOT + "/qos0", ROOT + "/qos1"]
        assert {message.payload for message in received} == {b"qos0", b"qos1"}
        assert {message.qos for message in received} == {0, 1}
        assert all(message.retain is False for message in received)
        print("PASS stdlib MQTT CONNECT/SUBSCRIBE/PUBLISH QoS0/QoS1")
        print("2 stdlib MQTT integration assertions passed")
    finally:
        publisher.close()
        subscriber.close()


def main() -> int:
    tests = [value for name, value in globals().items() if name.startswith("test_")]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)} stdlib MQTT unit tests passed")
    broker_integration()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
