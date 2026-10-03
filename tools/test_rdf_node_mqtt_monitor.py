"""Black-box lifecycle and transport contract tests for the RDF Node v2 monitor."""
from __future__ import annotations

import builtins
import importlib
import ssl
import sys
import types
import unittest
from unittest.mock import patch

from tools.rdf_node_mqtt_v2 import RDF_NODE_V2_SUFFIXES

NODE = "uav-01"
HOST = "127.0.0.1"


def fake_paho() -> tuple[types.ModuleType, type]:
    """Return isolated Paho modules and a client that records broker-facing calls."""
    class Client:
        instances: list["Client"] = []

        def __init__(self, *args: object, **kwargs: object) -> None:
            self.init_args = args
            self.init_kwargs = kwargs
            self.calls: list[tuple[str, tuple[object, ...], dict[str, object]]] = []
            self.subscriptions: list[tuple[str, object, object]] = []
            self.publish_calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
            self.on_connect = None
            self.on_disconnect = None
            self.on_subscribe = None
            self.on_message = None
            self.connect_exception: Exception | None = None
            self.mid = 0
            Client.instances.append(self)

        def _record(self, name: str, *args: object, **kwargs: object) -> None:
            self.calls.append((name, args, kwargs))

        def username_pw_set(self, username: str, password: str | None = None) -> None:
            self._record("username_pw_set", username, password)

        def tls_set(self, *args: object, **kwargs: object) -> None:
            self._record("tls_set", *args, **kwargs)

        def tls_insecure_set(self, value: bool) -> None:
            self._record("tls_insecure_set", value)

        def connect(self, *args: object, **kwargs: object) -> int:
            self._record("connect", *args, **kwargs)
            if self.connect_exception:
                raise self.connect_exception
            return 0

        def connect_async(self, *args: object, **kwargs: object) -> int:
            self._record("connect_async", *args, **kwargs)
            if self.connect_exception:
                raise self.connect_exception
            return 0

        def loop_start(self) -> None:
            self._record("loop_start")

        def loop_stop(self) -> None:
            self._record("loop_stop")

        def disconnect(self) -> int:
            self._record("disconnect")
            return 0

        def subscribe(self, topic: object, qos: object = 0, options: object = None,
                      properties: object = None) -> tuple[int, int]:
            self._record("subscribe", topic, qos, options, properties)
            self.mid += 1
            if isinstance(topic, str):
                self.subscriptions.append((topic, qos, options))
            else:
                for entry in topic:  # Paho accepts a list of (filter, qos) pairs.
                    if isinstance(entry, tuple):
                        self.subscriptions.append((entry[0], entry[1], options))
            return 0, self.mid

        def publish(self, *args: object, **kwargs: object) -> None:
            self.publish_calls.append((args, kwargs))
            self._record("publish", *args, **kwargs)

    class SubscribeOptions:
        def __init__(self, qos: int = 0, retainAsPublished: bool = False,
                     retainHandling: int = 0, **kwargs: object) -> None:
            self.qos = qos
            self.retainAsPublished = retainAsPublished
            self.retainHandling = retainHandling
    class Properties:
        def __init__(self, packet_type: object) -> None:
            self.packet_type = packet_type

    packettypes = types.ModuleType("paho.mqtt.packettypes")
    packettypes.PacketTypes = types.SimpleNamespace(CONNECT=1)
    properties = types.ModuleType("paho.mqtt.properties")
    properties.Properties = Properties

    mqtt = types.ModuleType("paho.mqtt")
    mqtt.Client = Client
    mqtt.CallbackAPIVersion = types.SimpleNamespace(VERSION2=2)
    mqtt.MQTTv5 = 5
    mqtt.MQTT_CLEAN_START_FIRST_ONLY = 3
    mqtt.MQTT_ERR_SUCCESS = 0
    mqtt.PacketTypes = packettypes.PacketTypes
    mqtt.Properties = Properties
    mqtt.SubscribeOptions = SubscribeOptions
    mqtt.packettypes = packettypes
    mqtt.properties = properties
    paho = types.ModuleType("paho")
    paho.__path__ = []
    mqtt.__path__ = []
    paho.mqtt = mqtt
    client_module = types.ModuleType("paho.mqtt.client")
    client_module.Client = Client
    client_module.CallbackAPIVersion = mqtt.CallbackAPIVersion
    client_module.MQTTv5 = mqtt.MQTTv5
    client_module.MQTT_CLEAN_START_FIRST_ONLY = mqtt.MQTT_CLEAN_START_FIRST_ONLY
    client_module.MQTT_ERR_SUCCESS = mqtt.MQTT_ERR_SUCCESS
    client_module.PacketTypes = mqtt.PacketTypes
    client_module.Properties = Properties
    client_module.SubscribeOptions = SubscribeOptions
    return paho, Client
def load_monitor(paho: types.ModuleType) -> types.ModuleType:
    """Load the implementation with a controlled Paho import, regardless of installation."""
    mqtt = paho.mqtt
    client_module = types.ModuleType("paho.mqtt.client")
    client_module.Client = mqtt.Client
    client_module.CallbackAPIVersion = mqtt.CallbackAPIVersion
    client_module.MQTTv5 = mqtt.MQTTv5
    client_module.MQTT_CLEAN_START_FIRST_ONLY = mqtt.MQTT_CLEAN_START_FIRST_ONLY
    client_module.MQTT_ERR_SUCCESS = mqtt.MQTT_ERR_SUCCESS
    client_module.PacketTypes = mqtt.PacketTypes
    client_module.Properties = mqtt.Properties
    client_module.SubscribeOptions = mqtt.SubscribeOptions
    with patch.dict(sys.modules, {
        "paho": paho,
        "paho.mqtt": mqtt,
        "paho.mqtt.client": client_module,
        "paho.mqtt.packettypes": mqtt.packettypes,
        "paho.mqtt.properties": mqtt.properties,
    }):
        module = importlib.import_module("tools.rdf_node_mqtt_monitor")
        importlib.reload(module)
    return module


try:
    _initial_paho, _InitialClient = fake_paho()
    monitor_module = load_monitor(_initial_paho)
    Monitor = monitor_module.RdfNodeMqttMonitor
except ModuleNotFoundError as exc:
    if exc.name != "tools.rdf_node_mqtt_monitor":
        raise
    monitor_module = None
    Monitor = None


class MissingMonitorTests(unittest.TestCase):
    def test_monitor_implementation_is_available(self) -> None:
        self.assertIsNotNone(Monitor, "RdfNodeMqttMonitor implementation module is missing")




def start_connected(monitor: object, client: object) -> None:
    monitor.start()
    if client.on_connect is not None:
        client.on_connect(client, None, {}, 0, None)


def success_code() -> object:
    return types.SimpleNamespace(value=0, is_failure=False)


def denied_code() -> object:
    return types.SimpleNamespace(value=0x87, is_failure=True)


def filters_in_call(call: tuple[str, tuple[object, ...], dict[str, object]]) -> list[str]:
    topic = call[1][0]
    if isinstance(topic, str):
        return [topic]
    return [entry[0] for entry in topic if isinstance(entry, tuple)]


def acknowledge_subscriptions(client: object, codes: list[object] | None = None) -> None:
    calls = [call for call in client.calls if call[0] == "subscribe"]
    total = sum(len(filters_in_call(call)) for call in calls)
    answers = codes or [success_code()] * total
    offset = 0
    for mid, call in enumerate(calls, 1):
        count = len(filters_in_call(call))
        client.on_subscribe(client, None, mid, answers[offset:offset + count], None)
        offset += count


@unittest.skipIf(Monitor is None, "behavior tests run once the monitor module exists")
class RdfNodeMqttMonitorTests(unittest.TestCase):
    def setUp(self) -> None:
        paho, self.Client = fake_paho()
        mqtt = paho.mqtt
        client_module = types.ModuleType("paho.mqtt.client")
        client_module.Client = mqtt.Client
        client_module.CallbackAPIVersion = mqtt.CallbackAPIVersion
        client_module.MQTTv5 = mqtt.MQTTv5
        client_module.MQTT_CLEAN_START_FIRST_ONLY = mqtt.MQTT_CLEAN_START_FIRST_ONLY
        client_module.MQTT_ERR_SUCCESS = mqtt.MQTT_ERR_SUCCESS
        client_module.PacketTypes = mqtt.PacketTypes
        client_module.Properties = mqtt.Properties
        client_module.SubscribeOptions = mqtt.SubscribeOptions
        paho_patch = patch.dict(sys.modules, {
            "paho": paho, "paho.mqtt": mqtt, "paho.mqtt.client": client_module,
            "paho.mqtt.packettypes": mqtt.packettypes,
            "paho.mqtt.properties": mqtt.properties,
        })
        paho_patch.start()
        self.addCleanup(paho_patch.stop)
        self.module = load_monitor(paho)
        self.monitor = self.module.RdfNodeMqttMonitor(
            HOST, 8883, NODE, "viewer-user", "viewer-secret", ca_file="/tmp/ground-ca.pem"
        )
        self.client: object | None = None

    def snapshot(self) -> dict[str, object]:
        return self.monitor.snapshot()
    def start_monitor(self) -> object:
        self.monitor.start()
        self.client = self.Client.instances[-1]
        return self.client

    def test_uses_mqtt_v5_callback_api_v2_and_node_specific_client_id(self) -> None:
        self.start_monitor()
        client = self.client
        api_version = client.init_kwargs.get("callback_api_version")
        if api_version is None and client.init_args:
            api_version = client.init_args[0]
        self.assertEqual(api_version, 2)
        self.assertEqual(client.init_kwargs.get("client_id"), f"ground-console-rdf-v2-{NODE}")
        self.assertIn(5, client.init_args + tuple(client.init_kwargs.values()))

    def test_connect_uses_clean_start_and_zero_session_expiry(self) -> None:
        self.start_monitor()
        connect = next(call for call in self.client.calls if call[0] in {"connect", "connect_async"})
        kwargs = connect[2]
        self.assertIn(kwargs.get("clean_start"), (True, 1))
        properties = kwargs.get("properties")
        if properties is None and len(connect[1]) > 3:
            properties = connect[1][3]
        self.assertEqual(getattr(properties, "SessionExpiryInterval", None), 0)

    def test_tls_uses_configured_ca_without_disabling_verification(self) -> None:
        self.start_monitor()
        tls = [call for call in self.client.calls if call[0] == "tls_set"]
        self.assertEqual(len(tls), 1)
        self.assertEqual(tls[0][2].get("ca_certs"), "/tmp/ground-ca.pem")
        self.assertEqual(tls[0][2].get("cert_reqs"), ssl.CERT_REQUIRED)
        self.assertFalse(any(call[0] == "tls_insecure_set" and call[1] != (False,)
                             for call in self.client.calls))

    def test_subscribes_only_to_exact_ten_filters_with_retained_options(self) -> None:
        start_connected(self.monitor, self.start_monitor())
        actual = self.client.subscriptions
        expected = {f"sdr/v2/{NODE}/{suffix}" for suffix in RDF_NODE_V2_SUFFIXES}
        self.assertEqual({entry[0] for entry in actual}, expected)
        self.assertEqual(len(actual), len(expected))
        for _topic, qos, options in actual:
            self.assertEqual(qos, 1)
            self.assertEqual(getattr(options, "qos", qos), 1)
            self.assertEqual(getattr(options, "retainHandling", None), 0)
            self.assertIs(getattr(options, "retainAsPublished", None), True)

    def test_readiness_waits_for_every_successful_suback(self) -> None:
        start_connected(self.monitor, self.start_monitor())
        self.assertNotEqual(self.snapshot()["connection"], "ready")
        calls = [call for call in self.client.calls if call[0] == "subscribe"]
        if len(calls) == 1:
            count = len(filters_in_call(calls[0]))
            self.client.on_subscribe(self.client, None, 1,
                                     [success_code()] * (count - 1), None)
        else:
            for mid, call in enumerate(calls[:-1], 1):
                self.client.on_subscribe(self.client, None, mid,
                                         [success_code()] * len(filters_in_call(call)), None)
        self.assertNotEqual(self.snapshot()["connection"], "ready")
        acknowledge_subscriptions(self.client)
        self.assertEqual(self.snapshot()["connection"], "ready")

    def test_denied_suback_never_marks_monitor_ready(self) -> None:
        start_connected(self.monitor, self.start_monitor())
        calls = [call for call in self.client.calls if call[0] == "subscribe"]
        total_filters = sum(len(filters_in_call(call)) for call in calls)
        acknowledge_subscriptions(self.client, [success_code()] * (total_filters - 1) + [denied_code()])
        snapshot = self.snapshot()
        self.assertNotEqual(snapshot["connection"], "ready")
        self.assertIsInstance(snapshot["last_error"], str)
        self.assertNotIn("viewer-secret", str(snapshot))

    def test_connect_failure_and_disconnect_are_sanitized_states(self) -> None:
        self.start_monitor()
        self.client.on_connect(self.client, None, {}, denied_code(), None)
        failed = self.snapshot()
        self.assertEqual(failed["connection"], "error")
        self.assertIsInstance(failed["last_error"], str)
        self.assertNotIn("viewer-secret", str(failed))
        self.client.on_disconnect(self.client, None, None, 0, None)
        self.assertEqual(self.snapshot()["connection"], "disconnected")
        self.assertNotIn("viewer-secret", str(self.snapshot()))

    def test_tls_setup_failure_is_sanitized_before_network_connect(self) -> None:
        with patch.object(self.Client, "tls_set", side_effect=ssl.SSLError("private TLS detail")):
            self.start_monitor()
        snapshot = self.snapshot()
        self.assertEqual(snapshot["connection"], "error")
        self.assertEqual(snapshot["last_error"], "TLS_ERROR")
        self.assertNotIn("private TLS detail", str(snapshot))
        self.assertFalse(any(call[0] in {"connect", "connect_async", "loop_start"}
                             for call in self.client.calls))

    def test_connection_exception_is_reported_without_exception_text(self) -> None:
        with patch.object(self.Client, "connect_async",
                          side_effect=RuntimeError("viewer-secret broker-password")):
            self.start_monitor()
        snapshot = self.snapshot()
        self.assertEqual(snapshot["connection"], "error")
        self.assertIsInstance(snapshot["last_error"], str)
        self.assertNotIn("viewer-secret", str(snapshot))
        self.assertNotIn("broker-password", str(snapshot))

    def test_topic_message_updates_validated_telemetry_snapshot(self) -> None:
        start_connected(self.monitor, self.start_monitor())
        acknowledge_subscriptions(self.client)
        body = b'{"v":2,"sid":"7a8b9c0d","online":true,"t":1790668800000}'
        message = types.SimpleNamespace(topic=f"sdr/v2/{NODE}/availability", payload=body,
                                        qos=1, retain=True, properties=None)
        self.client.on_message(self.client, None, message)
        observation = self.snapshot()["topics"]["availability"]
        self.assertEqual(observation["status"], "CONTEXT")
        self.assertTrue(observation["retained"])
        self.assertEqual(observation["payload"]["online"], True)
        self.assertEqual(self.snapshot()["topic_counts"]["availability"], 1)

    def test_stop_disconnects_and_stops_loop_without_publishing(self) -> None:
        self.start_monitor()
        self.monitor.stop()
        names = [call[0] for call in self.client.calls]
        self.assertIn("disconnect", names)
        self.assertIn("loop_stop", names)
        self.assertEqual(self.client.publish_calls, [])

    def test_invalid_non_loopback_host_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            self.module.RdfNodeMqttMonitor("broker.example", 8883, NODE,
                                            "viewer-user", "viewer-secret")


@unittest.skipIf(Monitor is None, "behavior tests run once the monitor module exists")
class OptionalPahoTests(unittest.TestCase):
    def test_missing_optional_paho_becomes_dependency_unavailable_snapshot(self) -> None:
        original_import = builtins.__import__

        def without_paho(name: str, *args: object, **kwargs: object) -> object:
            if name == "paho" or name.startswith("paho."):
                raise ModuleNotFoundError("No module named 'paho'", name="paho")
            return original_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=without_paho), patch.dict(
            sys.modules, {"paho": None, "paho.mqtt": None, "paho.mqtt.client": None}
        ):
            monitor = monitor_module.RdfNodeMqttMonitor(HOST, 8883, NODE,
                                                        "viewer-user", "viewer-secret")
            monitor.start()
        snapshot = monitor.snapshot()
        self.assertEqual(snapshot["connection"], "error")
        self.assertEqual(snapshot["last_error"], "DEPENDENCY_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()
