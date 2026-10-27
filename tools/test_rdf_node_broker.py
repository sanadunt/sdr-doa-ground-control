"""The console's MQTT monitor against a real broker, fed with the RDF Node's own payloads.

Needs a loopback staging broker (``mosquitto -c tools/mqtt_stage4.conf``,
anonymous on 127.0.0.1:18884; ``SDR_DOA_TEST_BROKER=host:port`` points
elsewhere) and paho-mqtt; without either every test is skipped. A publisher
client sends the payloads of ``tools/fixtures/rdf-node`` (made by the edge's
own code) with the QoS, retain flag and expiry the edge uses, on the topics
of a node id unique to the run, and the monitor must take them as the store
does in ``test_rdf_node_mqtt_v2``. The monitor's clock is the fixtures' clock,
so the freshness rules hold as on a live link. Retained values are removed
afterwards. Nothing leaves loopback.
"""
from __future__ import annotations

import json
import os
import secrets
import socket
import sys
import threading
import time
import unittest
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from unittest.mock import patch

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

FIXTURES = TOOLS_DIR / "fixtures" / "rdf-node"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
BY_FILE = {entry["file"]: entry for entry in MANIFEST["fixtures"]}
COMMANDS = json.loads((FIXTURES / "commands.8691ad0.json").read_text(encoding="utf-8"))
WAIT_S = 10.0

try:
    import paho.mqtt.client as mqtt
    from paho.mqtt.packettypes import PacketTypes
    from paho.mqtt.properties import Properties
except ModuleNotFoundError:  # pragma: no cover - the console starts without paho too
    mqtt = None


def _broker() -> tuple:
    host, _, port = os.environ.get("SDR_DOA_TEST_BROKER", "127.0.0.1:18884").rpartition(":")
    return host or "127.0.0.1", int(port)


def _broker_reachable() -> bool:
    try:
        socket.create_connection(_broker(), 1).close()
        return True
    except OSError:
        return False


def wait_for(condition: Callable[[], Any], what: str, timeout: float = WAIT_S) -> Any:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = condition()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


class Publisher:
    """A plain MQTT v5 client that publishes the edge's payloads, and subscribes to commands."""

    def __init__(self) -> None:
        self.client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id="brokertest" + secrets.token_hex(4),
            protocol=mqtt.MQTTv5,
        )
        self.received: List[Any] = []
        self._connected = threading.Event()
        self.client.on_connect = lambda *_args: self._connected.set()
        self.client.on_message = lambda _client, _userdata, message: self.received.append(message)
        self.client.connect(*_broker(), keepalive=15)
        self.client.loop_start()
        if not self._connected.wait(WAIT_S):
            raise AssertionError("the publisher did not connect")

    def publish(self, prefix: str, name: str) -> None:
        entry = BY_FILE[name]
        properties = None
        if entry["expiry_s"] is not None:
            properties = Properties(PacketTypes.PUBLISH)
            properties.MessageExpiryInterval = entry["expiry_s"]
        info = self.client.publish(
            prefix + entry["topic"], (FIXTURES / name).read_bytes(),
            qos=entry["qos"], retain=entry["retain"], properties=properties,
        )
        info.wait_for_publish(WAIT_S)

    def subscribe(self, topic: str) -> None:
        done = threading.Event()
        self.client.on_subscribe = lambda *_args: done.set()
        self.client.subscribe(topic, qos=1)
        if not done.wait(WAIT_S):
            raise AssertionError(f"no SUBACK for {topic}")

    def clear_retained(self, prefix: str) -> None:
        for topic in ("state", "capabilities", "availability"):
            self.client.publish(prefix + topic, b"", qos=1, retain=True).wait_for_publish(WAIT_S)

    def close(self) -> None:
        self.client.disconnect()
        self.client.loop_stop()


@unittest.skipIf(mqtt is None, "paho-mqtt is not installed")
@unittest.skipUnless(_broker_reachable(), "no staging MQTT broker (mosquitto -c tools/mqtt_stage4.conf)")
class MonitorThroughBrokerTests(unittest.TestCase):
    def setUp(self) -> None:
        import sdr_doa_mqtt_monitor as monitor_module

        self.module = monitor_module
        self.node = "brokertest-" + secrets.token_hex(4)
        self.prefix = f"sdr/v2/{self.node}/"
        # The fixtures' clock, moving with the real one from here on.
        self.base_ms = MANIFEST["generated_at_ms"]
        started = time.time()
        clock = patch.object(
            monitor_module, "_now_ms", lambda: self.base_ms + int((time.time() - started) * 1000),
        )
        clock.start()
        self.addCleanup(clock.stop)
        self.publisher = Publisher()
        self.addCleanup(self.publisher.close)
        self.addCleanup(self.publisher.clear_retained, self.prefix)
        self.monitors: List[Any] = []

    def monitor(self) -> Any:
        host, port = _broker()
        monitor = self.module.MqttMonitor(host, port, transport="tcp", node_id=self.node)
        self.monitors.append(monitor)
        self.addCleanup(monitor.stop)
        monitor.start()
        wait_for(lambda: monitor.snapshot()["connection"] == "connected", "the monitor's SUBACKs")
        return monitor

    def topic(self, monitor: Any, suffix: str) -> Dict[str, Any]:
        return monitor.rdf_node_snapshot()["topics"][suffix]

    def test_the_edge_payloads_reach_the_node_view_and_the_one_status(self) -> None:
        monitor = self.monitor()
        for name in ("state.json", "capabilities.json"):
            self.publisher.publish(self.prefix, name)
        wait_for(lambda: monitor.rdf_node_session().get("known"), "the node session from state")
        for name in ("telemetry-health.json", "telemetry-doa.ok1.json", "telemetry-angular.live.json"):
            self.publisher.publish(self.prefix, name)
        wait_for(lambda: self.topic(monitor, "telemetry/angular")["status"] == "LIVE", "a LIVE Angular frame")

        snapshot = monitor.rdf_node_snapshot()
        self.assertEqual(self.topic(monitor, "telemetry/doa")["status"], "LIVE")
        self.assertTrue(snapshot["node"]["health"]["fresh"])
        # Retain As Published: the live retained state keeps the publisher's flag.
        self.assertIs(self.topic(monitor, "state")["retained"], True)
        self.assertIs(self.topic(monitor, "telemetry/health")["retained"], False)
        view = monitor.rdf_node_view()
        self.assertTrue(view["node"]["doa"]["live"])
        self.assertEqual(len(view["node"]["angular"]["values"]), 360)
        status = monitor.snapshot()
        self.assertEqual((status["received"], status["valid"], status["invalid"]), (5, 5, 0))
        self.assertEqual((status["root"], status["connection"]), (self.prefix.rstrip("/"), "connected"))

    def test_a_new_monitor_gets_the_retained_session_from_the_broker(self) -> None:
        for name in ("state.json", "capabilities.json", "availability.online.json"):
            self.publisher.publish(self.prefix, name)
        monitor = self.monitor()
        wait_for(lambda: monitor.snapshot()["received"] >= 3, "the three retained values")
        session = monitor.rdf_node_session()
        state = json.loads((FIXTURES / "state.json").read_bytes())
        self.assertEqual((session["known"], session["sid"], session["cfg"]), (True, state["sid"], state["cfg"]))
        for suffix in ("state", "capabilities", "availability"):
            self.assertIs(self.topic(monitor, suffix)["retained"], True, suffix)
        # A retained clear from the edge removes the value without counting a bad message.
        self.publisher.client.publish(self.prefix + "availability", b"", qos=1, retain=True).wait_for_publish(WAIT_S)
        wait_for(lambda: monitor.snapshot()["cleared"] == 1, "the retained clear")
        self.assertEqual(monitor.snapshot()["invalid"], 0)

    def test_kontrol_publishes_one_command_at_qos1_without_retain_and_sees_its_ack(self) -> None:
        import rdf_node_commands as commands

        self.base_ms = COMMANDS["generated_at_ms"]
        monitor = self.monitor()
        state = json.loads(COMMANDS["session"]["state"])
        self.publisher.client.publish(
            self.prefix + "state", COMMANDS["session"]["state"].encode("utf-8"), qos=1, retain=True,
        ).wait_for_publish(WAIT_S)
        wait_for(lambda: monitor.rdf_node_session().get("known"), "the node session")
        self.publisher.subscribe(self.prefix + "cmd/config/get")
        command = commands.build_command(
            commands.OP_CONFIG_GET, command_id="gc-broker-1", sid=state["sid"], boot=state["boot"],
            base_rev=state["cfg"], issued_ms=self.module._now_ms(), ttl_ms=15_000,
        )
        result = monitor.publish_rdf_node_command(command)
        self.assertEqual(result["topic"], self.prefix + "cmd/config/get")
        message = wait_for(lambda: self.publisher.received[0] if self.publisher.received else None, "the command")
        self.assertEqual(message.payload, commands.encode_command(command))
        self.assertEqual((message.qos, message.retain), (1, False))
        self.assertEqual(message.properties.MessageExpiryInterval, 15)
        wait_for(lambda: monitor.rdf_node_command_observation("gc-broker-1")["puback"], "the PUBACK")
        self.assertEqual(monitor.rdf_node_command_observation("gc-broker-1")["puback"]["reason"], 0)
        # The edge's answer: an ACK with the command's id, then the report it asked for.
        ack = json.loads((FIXTURES / "ack-config.config-get-applied.json").read_bytes())
        ack.update(sid=state["sid"], id="gc-broker-1", t=self.module._now_ms(), rev=state["cfg"])
        self.publisher.client.publish(
            self.prefix + "ack/config", json.dumps(ack, separators=(",", ":")).encode("utf-8"), qos=1,
        ).wait_for_publish(WAIT_S)
        final = wait_for(lambda: monitor.rdf_node_command_observation("gc-broker-1")["final"], "the final ACK")
        self.assertEqual(final["status"], "APPLIED")
        self.assertEqual(len(self.publisher.received), 1, "one publish, never a replay")


if __name__ == "__main__":
    unittest.main()
