#!/usr/bin/env python3
"""Contract and local-broker tests for staged SDR-DoA MQTT telemetry."""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

import paho.mqtt.client as mqtt

import sdr_doa_mqtt as contract


ROOT = contract.TOPIC_ROOT


def test_payload_contracts_and_sizes() -> None:
    doa = contract.build_doa(
        seq=7,
        ts_ms=1_000,
        relative_doa_deg=137.4,
        confidence=0.923,
        power_db=-54.2,
        frequency_hz=433_920_000,
        processing_ms=12,
        snr_db=14.5,
        config_rev=3,
    )
    nav = contract.build_nav(
        seq=2,
        ts_ms=1_000,
        lat=-6.9147,
        lon=107.6098,
        heading_deg=121.5,
        speed_mps=12.2,
        source="gps",
    )
    health = contract.build_health(
        ts_ms=1_000,
        state="DEGRADED",
        daq_ok=False,
        dropped_frames=4,
        gps_status="Disabled",
        doa_valid=False,
        doa_age_ms=None,
        frame_sync=True,
        sample_delay_sync=False,
        iq_sync=False,
    )
    state = contract.build_state(
        ts_ms=1_000,
        config_rev=3,
        running=True,
        frequency_hz=433_920_000,
        gain_db=24,
        array="UCA",
        method="MUSIC",
        active_vfos=1,
    )
    reported = contract.build_config_reported(
        ts_ms=1_000,
        config_rev=3,
        center_frequency_hz=433_920_000,
        gain_db=24,
        array="UCA",
        method="MUSIC",
        active_vfos=1,
    )
    for kind, payload in (("doa", doa), ("nav", nav), ("health", health), ("state", state), ("config_reported", reported)):
        encoded = contract.compact_json(payload)
        decoded = contract.decode_payload(kind, encoded)
        assert decoded == payload
        assert len(encoded.encode("utf-8")) < 300


def test_invalid_contract_values_are_rejected() -> None:
    try:
        contract.build_doa(
            seq=1,
            ts_ms=1,
            relative_doa_deg=361,
            confidence=0.5,
            power_db=-1,
            frequency_hz=433_920_000,
            processing_ms=1,
        )
    except contract.ContractError:
        pass
    else:
        raise AssertionError("out-of-range DoA was accepted")

    try:
        contract.build_config_patch(
            command_id="cmd-bad",
            base_config_rev=1,
            changes={"reboot": True},
            issued_ts_ms=1,
            expires_ts_ms=2,
        )
    except contract.ContractError:
        pass
    else:
        raise AssertionError("forbidden command field was accepted")


def test_latest_value_wins() -> None:
    queue = contract.LatestValueQueue(("doa", "health"))
    for seq in range(1, 6):
        queue.put("doa", {"seq": seq})
    assert queue.snapshot() == {"doa": {"seq": 5}}
    assert queue.pop("doa") == {"seq": 5}
    assert queue.stats.accepted == 5
    assert queue.stats.replaced == 4
    assert queue.stats.popped == 1


class Capture:
    def __init__(self, broker_host: str, broker_port: int) -> None:
        self.events: List[Tuple[str, bytes, bool, int]] = []
        self.connected = threading.Event()
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="stage4-capture")
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message
        self.client.connect(broker_host, broker_port, keepalive=10)
        self.client.loop_start()
        if not self.connected.wait(5):
            raise AssertionError("subscriber did not connect")

    def on_connect(self, client: mqtt.Client, userdata: Any, flags: Any, reason_code: Any, properties: Any) -> None:
        reason_value = getattr(reason_code, "value", reason_code)
        if int(reason_value) == 0:
            client.subscribe(ROOT + "/#", qos=1)
            self.connected.set()

    def on_message(self, client: mqtt.Client, userdata: Any, message: mqtt.MQTTMessage) -> None:
        self.events.append((message.topic, bytes(message.payload), bool(message.retain), int(message.qos)))

    def clear(self) -> None:
        self.events.clear()

    def stop(self) -> None:
        self.client.loop_stop()
        self.client.disconnect()


def _publisher(broker_host: str, broker_port: int) -> mqtt.Client:
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="stage4-publisher")
    client.connect(broker_host, broker_port, keepalive=10)
    client.loop_start()
    return client


def wait_for_events(capture: Capture, count: int, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while len(capture.events) < count and time.monotonic() < deadline:
        time.sleep(0.02)
    assert len(capture.events) >= count, f"expected {count} MQTT events, got {len(capture.events)}"


def test_local_broker_publish_subscribe_and_flags(host: str, port: int) -> None:
    capture = Capture(host, port)
    publisher = _publisher(host, port)
    try:
        state = contract.build_state(
            ts_ms=1_000,
            config_rev=3,
            running=True,
            frequency_hz=433_920_000,
            gain_db=24,
            array="UCA",
            method="MUSIC",
            active_vfos=1,
        )
        doa = contract.build_doa(
            seq=1,
            ts_ms=1_000,
            relative_doa_deg=137.4,
            confidence=0.923,
            power_db=-54.2,
            frequency_hz=433_920_000,
            processing_ms=12,
        )
        command = contract.build_config_patch(
            command_id="stage4-cmd-1",
            base_config_rev=3,
            changes={"gain_db": 24},
            issued_ts_ms=1_000,
            expires_ts_ms=11_000,
        )
        publisher.publish(ROOT + "/state", contract.compact_json(state), qos=1, retain=True).wait_for_publish()
        publisher.publish(ROOT + "/telemetry/doa", contract.compact_json(doa), qos=0, retain=False).wait_for_publish()
        publisher.publish(ROOT + "/cmd/config/patch", contract.compact_json(command), qos=1, retain=False).wait_for_publish()
        wait_for_events(capture, 3)

        state_events = [event for event in capture.events if event[0] == ROOT + "/state"]
        doa_events = [event for event in capture.events if event[0] == ROOT + "/telemetry/doa"]
        command_events = [event for event in capture.events if event[0] == ROOT + "/cmd/config/patch"]
        assert state_events and doa_events and command_events
        current_state = next(event for event in reversed(state_events) if json.loads(event[1])["config_rev"] == 3)
        state_event = current_state
        command_event = command_events[-1]
        # The publisher is already subscribed before this live delivery; retain
        # is verified separately by a fresh subscriber below.
        assert state_event[2] is False
        assert state_event[3] == 1
        assert command_event[2] is False
        assert command_event[3] == 1
        assert json.loads(state_event[1])["config_rev"] == 3
        assert json.loads(command_event[1])["type"] == "config_patch"

        capture.client.loop_stop()
        capture.client.disconnect()
        capture.clear()
        capture.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="stage4-capture-reconnect")
        capture.client.on_connect = capture.on_connect
        capture.client.on_message = capture.on_message
        capture.connected.clear()
        capture.client.connect(host, port, keepalive=10)
        capture.client.loop_start()
        assert capture.connected.wait(5)
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            retained_state = [
                event
                for event in capture.events
                if event[0] == ROOT + "/state"
                and event[2] is True
                and json.loads(event[1])["config_rev"] == 3
            ]
            if retained_state:
                break
            time.sleep(0.02)
        assert retained_state, "fresh subscriber did not receive retained state"
        assert ROOT + "/cmd/config/patch" not in [topic for topic, _, _, _ in capture.events]
    finally:
        try:
            capture.stop()
        finally:
            publisher.loop_stop()
            publisher.disconnect()


def test_json_rejects_nonfinite() -> None:
    try:
        contract.compact_json({"v": 1, "x": float("nan")})
    except contract.ContractError:
        pass
    else:
        raise AssertionError("non-finite JSON value was accepted")


def main() -> int:
    tests = [
        test_payload_contracts_and_sizes,
        test_invalid_contract_values_are_rejected,
        test_latest_value_wins,
        test_json_rejects_nonfinite,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")

    if len(sys.argv) == 3:
        test_local_broker_publish_subscribe_and_flags(sys.argv[1], int(sys.argv[2]))
        print("PASS test_local_broker_publish_subscribe_and_flags")
    print(f"{len(tests) + (1 if len(sys.argv) == 3 else 0)} MQTT tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
