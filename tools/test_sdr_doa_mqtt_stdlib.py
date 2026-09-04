#!/usr/bin/env python3
"""Integration test for the stdlib-only MQTT client on a staging broker."""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sdr_doa_mqtt_stdlib import IncomingMessage, Mqtt311Client


ROOT = "sdr/v1/test-stdlib"


def main() -> int:
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
        return 0
    finally:
        publisher.close()
        subscriber.close()


if __name__ == "__main__":
    raise SystemExit(main())
