"""Tests for the single MQTT client that observes v1 and RDF Node v2."""
from __future__ import annotations

import importlib
import json
import sys
import time
import types
import unittest
from unittest.mock import patch

from tools import sdr_doa_mqtt as contract
from tools.rdf_node_mqtt_v2 import RDF_NODE_V2_SUFFIXES

NODE = "uav-01"


def fake_paho() -> tuple[types.ModuleType, type]:
    class Client:
        instances: list["Client"] = []

        def __init__(self, *args: object, **kwargs: object) -> None:
            self.args = args
            self.kwargs = kwargs
            self.calls: list[tuple[str, tuple[object, ...], dict[str, object]]] = []
            self.subscriptions: list[tuple[str, object]] = []
            self.publish_calls: list[object] = []
            self.on_connect = None
            self.on_connect_fail = None
            self.on_disconnect = None
            self.on_subscribe = None
            self.on_message = None
            self.mid = 0
            Client.instances.append(self)

        def record(self, name: str, *args: object, **kwargs: object) -> None:
            self.calls.append((name, args, kwargs))

        def username_pw_set(self, *args: object) -> None:
            self.record("username_pw_set", *args)

        def ws_set_options(self, **kwargs: object) -> None:
            self.record("ws_set_options", **kwargs)

        def connect_async(self, *args: object, **kwargs: object) -> int:
            self.record("connect_async", *args, **kwargs)
            return 0

        def loop_start(self) -> None:
            self.record("loop_start")

        def loop_stop(self) -> None:
            self.record("loop_stop")

        def disconnect(self) -> int:
            self.record("disconnect")
            return 0

        def subscribe(self, topics: object, *args: object, **kwargs: object) -> tuple[int, int]:
            self.record("subscribe", topics, *args, **kwargs)
            self.mid += 1
            entries = [topics] if isinstance(topics, str) else list(topics)
            for entry in entries:
                if isinstance(entry, tuple) and len(entry) == 2:
                    self.subscriptions.append((str(entry[0]), entry[1]))
                else:
                    self.subscriptions.append((str(entry), kwargs.get("options")))
            return 0, self.mid

        def publish(self, *args: object, **kwargs: object) -> None:
            self.publish_calls.append((args, kwargs))

    class SubscribeOptions:
        def __init__(self, qos: int = 0, **kwargs: object) -> None:
            self.qos = qos
            self.noLocal = kwargs.get("noLocal", False)
            self.retainAsPublished = kwargs.get("retainAsPublished", False)
            self.retainHandling = kwargs.get("retainHandling", 0)

    class Properties:
        def __init__(self, packet_type: object) -> None:
            self.packet_type = packet_type
            self.SessionExpiryInterval = None

    packettypes = types.ModuleType("paho.mqtt.packettypes")
    packettypes.PacketTypes = types.SimpleNamespace(CONNECT=1)
    properties = types.ModuleType("paho.mqtt.properties")
    properties.Properties = Properties
    mqtt = types.ModuleType("paho.mqtt")
    mqtt.__path__ = []
    mqtt.Client = Client
    mqtt.CallbackAPIVersion = types.SimpleNamespace(VERSION2=2)
    mqtt.MQTTv5 = 5
    mqtt.MQTT_CLEAN_START_FIRST_ONLY = 3
    mqtt.MQTT_ERR_SUCCESS = 0
    mqtt.SubscribeOptions = SubscribeOptions
    mqtt.PacketTypes = packettypes.PacketTypes
    mqtt.packettypes = packettypes
    mqtt.properties = properties
    paho = types.ModuleType("paho")
    paho.__path__ = []
    paho.mqtt = mqtt
    return paho, Client


def load_monitor(paho: types.ModuleType) -> types.ModuleType:
    mqtt = paho.mqtt
    client_module = types.ModuleType("paho.mqtt.client")
    for name in (
        "Client", "CallbackAPIVersion", "MQTTv5", "MQTT_CLEAN_START_FIRST_ONLY",
        "MQTT_ERR_SUCCESS", "SubscribeOptions", "PacketTypes",
    ):
        setattr(client_module, name, getattr(mqtt, name))
    with patch.dict(sys.modules, {
        "paho": paho,
        "paho.mqtt": mqtt,
        "paho.mqtt.client": client_module,
        "paho.mqtt.packettypes": mqtt.packettypes,
        "paho.mqtt.properties": mqtt.properties,
        "sdr_doa_mqtt": contract,
    }):
        module = importlib.import_module("tools.sdr_doa_mqtt_monitor")
        return importlib.reload(module)


def successful_codes(count: int) -> list[object]:
    return [types.SimpleNamespace(value=1, is_failure=False) for _ in range(count)]


def start_connected(monitor: object, client: object) -> None:
    monitor.start()
    client.on_connect(client, None, {}, types.SimpleNamespace(value=0, is_failure=False), None)


def message(topic: str, payload: bytes, qos: int, retained: bool) -> object:
    return types.SimpleNamespace(
        topic=topic,
        payload=payload,
        qos=qos,
        retain=retained,
        properties=types.SimpleNamespace(MessageExpiryInterval=None),
    )


class SharedMqttMonitorTests(unittest.TestCase):
    def setUp(self) -> None:
        paho, self.Client = fake_paho()
        self.module = load_monitor(paho)
        self.monitor = self.module.MqttMonitor(
            "10.90.0.1", 9001, transport="websockets", ws_path="/mqtt",
        )
        self.client = None

    def _start(self) -> object:
        self.monitor.start()
        return self.Client.instances[-1]

    def acknowledge(self, codes: list[object] | None = None) -> None:
        calls = [call for call in self.client.calls if call[0] == "subscribe"]
        self.assertEqual(len(calls), 1)
        count = len(self.client.subscriptions)
        answers = codes if codes is not None else successful_codes(count)
        self.client.on_subscribe(self.client, None, self.client.mid, answers, None)

    def test_one_websocket_client_subscribes_to_v1_and_default_v2_prefix(self) -> None:
        self.client = self._start()
        self.client.on_connect(self.client, None, {}, types.SimpleNamespace(value=0, is_failure=False), None)

        connect_call = next(call for call in self.client.calls if call[0] == "connect_async")
        self.assertTrue(connect_call[2]["clean_start"])
        self.assertEqual(connect_call[2]["properties"].SessionExpiryInterval, 0)
        self.assertEqual(len(self.Client.instances), 1)
        self.assertEqual(self.client.kwargs.get("protocol"), 5)
        self.assertEqual(self.client.kwargs.get("transport"), "websockets")
        self.assertIn(("ws_set_options", (), {"path": "/mqtt"}), self.client.calls)
        expected = {f"sdr/v2/{NODE}/{suffix}" for suffix in RDF_NODE_V2_SUFFIXES}
        expected.add(f"{contract.TOPIC_ROOT}/#")
        self.assertEqual({topic for topic, _options in self.client.subscriptions}, expected)
        self.assertEqual(len(self.client.subscriptions), len(expected))
        for _topic, options in self.client.subscriptions:
            self.assertEqual(options.qos, 1)
            self.assertIs(options.retainAsPublished, True)
            self.assertEqual(options.retainHandling, 0)
        self.assertEqual(self.monitor.rdf_node_snapshot()["connection"], "connecting")

        self.acknowledge()
        self.assertEqual(self.monitor.rdf_node_snapshot()["connection"], "ready")

    def test_custom_node_id_changes_only_the_v2_subscription_namespace(self) -> None:
        paho, client_type = fake_paho()
        module = load_monitor(paho)
        monitor = module.MqttMonitor("127.0.0.1", 1883, node_id="node_02")
        monitor.start()
        client = client_type.instances[-1]
        client.on_connect(
            client, None, {}, types.SimpleNamespace(value=0, is_failure=False), None,
        )

        subscribed = {topic for topic, _options in client.subscriptions}
        expected = {f"sdr/v2/node_02/{suffix}" for suffix in RDF_NODE_V2_SUFFIXES}
        expected.add(f"{contract.TOPIC_ROOT}/#")
        self.assertEqual(len(RDF_NODE_V2_SUFFIXES), 12)
        self.assertEqual(subscribed, expected)
        self.assertEqual(
            {topic for topic in subscribed if topic.startswith("sdr/v2/")},
            {f"sdr/v2/node_02/{suffix}" for suffix in RDF_NODE_V2_SUFFIXES},
        )
        self.assertIn("sdr/v1/uav-01/#", subscribed)
        self.assertEqual(client.publish_calls, [])


    def test_v1_and_v2_messages_use_only_their_schema_specific_snapshots(self) -> None:
        self.client = self._start()
        self.client.on_connect(self.client, None, {}, types.SimpleNamespace(value=0, is_failure=False), None)
        self.acknowledge()
        now_ms = int(time.time() * 1000)
        v1_health = contract.build_health(
            ts_ms=now_ms, state="PASS", daq_ok=True, dropped_frames=0,
            gps_status="Disabled", doa_valid=False, doa_age_ms=None,
            frame_sync=True, sample_delay_sync=True, iq_sync=True,
        )
        self.client.on_message(
            self.client, None,
            message(contract.TOPICS["health"], contract.compact_json(v1_health).encode("utf-8"), 0, False),
        )
        v2_availability = json.dumps({
            "v": 2, "sid": "7a8b9c0d", "online": True, "t": now_ms,
        }).encode("utf-8")
        self.client.on_message(
            self.client, None,
            message(f"sdr/v2/{NODE}/availability", v2_availability, 1, True),
        )

        v1_snapshot = self.monitor.snapshot()
        v2_snapshot = self.monitor.rdf_node_snapshot()
        self.assertEqual((v1_snapshot["received"], v1_snapshot["valid"], v1_snapshot["invalid"]), (1, 1, 0))
        self.assertEqual((v2_snapshot["received"], v2_snapshot["valid"], v2_snapshot["invalid"]), (1, 1, 0))
        self.assertEqual(v2_snapshot["topics"]["availability"]["status"], "CONTEXT")
        self.assertEqual(v2_snapshot["topic_counts"]["availability"], 1)

        self.client.on_message(
            self.client, None,
            message(contract.TOPICS["health"], b'{"v":2}', 0, False),
        )
        self.client.on_message(
            self.client, None,
            message(
                f"sdr/v2/{NODE}/availability",
                b'{"v":1,"sid":"7a8b9c0d","online":true,"t":1}',
                1,
                True,
            ),
        )

        v1_snapshot = self.monitor.snapshot()
        v2_snapshot = self.monitor.rdf_node_snapshot()
        self.assertEqual((v1_snapshot["received"], v1_snapshot["valid"], v1_snapshot["invalid"]), (2, 1, 1))
        self.assertEqual((v2_snapshot["received"], v2_snapshot["valid"], v2_snapshot["invalid"]), (2, 1, 1))
        self.assertEqual(v2_snapshot["topics"]["availability"]["status"], "INVALID")
        self.assertEqual(v2_snapshot["topic_counts"]["availability"], 2)
        self.assertEqual(self.client.publish_calls, [])

    def test_client_construction_failure_surfaces_shared_connection_error(self) -> None:
        def unavailable_client(*_args: object, **_kwargs: object) -> None:
            raise OSError("offline")

        self.module.mqtt.Client = unavailable_client
        self.monitor.start()

        self.assertEqual(self.monitor.snapshot()["connection"], "error")
        self.assertEqual(self.monitor.rdf_node_snapshot()["last_error"], "CONNECTION_ERROR")

    def test_stop_disables_both_snapshots_and_ignores_late_connect(self) -> None:
        self.client = self._start()
        self.monitor.stop()

        client_calls = [call[0] for call in self.client.calls]
        self.assertIn("disconnect", client_calls)
        self.assertIn("loop_stop", client_calls)
        self.assertEqual(self.monitor.snapshot()["connection"], "stopped")
        self.assertEqual(self.monitor.rdf_node_snapshot()["connection"], "disabled")

        self.client.on_connect(
            self.client, None, {}, types.SimpleNamespace(value=0, is_failure=False), None,
        )
        self.assertFalse(any(call[0] == "subscribe" for call in self.client.calls))

    def test_denied_subscription_does_not_report_v2_ready(self) -> None:
        self.client = self._start()
        self.client.on_connect(self.client, None, {}, types.SimpleNamespace(value=0, is_failure=False), None)
        denied = types.SimpleNamespace(value=0x87, is_failure=True)
        self.acknowledge(successful_codes(len(self.client.subscriptions) - 1) + [denied])
        snapshot = self.monitor.rdf_node_snapshot()
        self.assertEqual(snapshot["connection"], "error")
        self.assertEqual(snapshot["last_error"], "SUBSCRIPTION_DENIED")

    def test_diagnostic_suback_denial_does_not_fail_v1_monitor(self) -> None:
        self.client = self._start()
        self.client.on_connect(
            self.client, None, {}, types.SimpleNamespace(value=0, is_failure=False), None,
        )
        codes = successful_codes(len(self.client.subscriptions))
        denied = types.SimpleNamespace(value=0x87, is_failure=True)
        diagnostic_topic = f"sdr/v2/{NODE}/telemetry/diagnostic/doa"
        denied_index = next(
            index for index, (topic, _options) in enumerate(self.client.subscriptions)
            if topic == diagnostic_topic
        )
        codes[denied_index] = denied
        self.acknowledge(codes)

        v1_snapshot = self.monitor.snapshot()
        v2_snapshot = self.monitor.rdf_node_snapshot()
        self.assertEqual(v1_snapshot["connection"], "connected")
        self.assertIsNone(v1_snapshot["last_error"])
        self.assertEqual(v2_snapshot["connection"], "error")
        self.assertEqual(v2_snapshot["last_error"], "SUBSCRIPTION_DENIED")


    def test_v1_suback_denial_does_not_fail_v2_monitor(self) -> None:
        self.client = self._start()
        self.client.on_connect(
            self.client, None, {}, types.SimpleNamespace(value=0, is_failure=False), None,
        )
        codes = successful_codes(len(self.client.subscriptions))
        codes[0] = types.SimpleNamespace(value=0x87, is_failure=True)
        self.acknowledge(codes)

        v1_snapshot = self.monitor.snapshot()
        v2_snapshot = self.monitor.rdf_node_snapshot()
        self.assertEqual(v1_snapshot["connection"], "error")
        self.assertEqual(v1_snapshot["last_error"], "SUBSCRIPTION_DENIED")
        self.assertEqual(v2_snapshot["connection"], "ready")
        self.assertIsNone(v2_snapshot["last_error"])

if __name__ == "__main__":
    unittest.main()
