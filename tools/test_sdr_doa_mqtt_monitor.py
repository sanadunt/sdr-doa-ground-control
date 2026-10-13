"""Tests for the single MQTT client that observes v1 and RDF Node v2."""
from __future__ import annotations

import http.client
import importlib
import json
import os
import re
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from tools import sdr_doa_mqtt as contract
from tools.rdf_node_mqtt_v2 import RDF_NODE_V2_SUFFIXES

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))
# ground_console resolves its admin password at import time; give it a
# test-only value so the import never falls back to a local .env file.
_SAVED_ADMIN_PASSWORD = os.environ.get("SDR_DOA_ADMIN_PASSWORD")
os.environ["SDR_DOA_ADMIN_PASSWORD"] = "mqtt-monitor-test-no-secret"
try:
    import ground_console  # noqa: E402
finally:
    if _SAVED_ADMIN_PASSWORD is None:
        os.environ.pop("SDR_DOA_ADMIN_PASSWORD", None)
    else:
        os.environ["SDR_DOA_ADMIN_PASSWORD"] = _SAVED_ADMIN_PASSWORD

NODE = "uav-01"
BASE_URL = "http://doasdr.local:8081"


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

        def reconnect_delay_set(self, **kwargs: object) -> None:
            self.record("reconnect_delay_set", **kwargs)

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
        v2_filters = {f"sdr/v2/{NODE}/{suffix}" for suffix in RDF_NODE_V2_SUFFIXES}
        v1_filter = f"{contract.TOPIC_ROOT}/#"
        expected = {v1_filter, *v2_filters}
        self.assertEqual({topic for topic, _options in self.client.subscriptions}, expected)
        self.assertEqual(len(self.client.subscriptions), len(expected))
        for topic, options in self.client.subscriptions:
            self.assertEqual(options.qos, 1)
            # v1 retain marks a broker replay; v2 needs the publisher's flag.
            self.assertIs(options.retainAsPublished, topic in v2_filters)
            self.assertEqual(options.retainHandling, 0)
        self.assertEqual(self.monitor.rdf_node_snapshot()["connection"], "connecting")

        self.acknowledge()
        self.assertEqual(self.monitor.rdf_node_snapshot()["connection"], "ready")

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

    def _connected(self) -> None:
        self.client = self._start()
        self.client.on_connect(self.client, None, {}, types.SimpleNamespace(value=0, is_failure=False), None)
        self.acknowledge()

    def _send(self, kind: str, payload: object, *, retained: bool = False, qos: int = 0) -> None:
        raw = payload if isinstance(payload, bytes) else contract.compact_json(payload).encode("utf-8")
        self.client.on_message(self.client, None, message(contract.TOPICS[kind], raw, qos, retained))

    @staticmethod
    def _doa(ts_ms: int, *, valid: bool = True) -> dict:
        return contract.build_doa(
            seq=1, ts_ms=ts_ms, relative_doa_deg=137.4, confidence=0.9,
            power_db=-54.2, frequency_hz=433_920_000, processing_ms=12, valid=valid,
        )

    @staticmethod
    def _health(ts_ms: int, *, doa_valid: bool = True) -> dict:
        return contract.build_health(
            ts_ms=ts_ms, state="PASS", daq_ok=True, dropped_frames=0,
            gps_status="Disabled", doa_valid=doa_valid, doa_age_ms=None,
        )

    def test_each_monitor_uses_a_unique_bounded_client_id(self) -> None:
        other = self.module.MqttMonitor("10.90.0.1", 9001)
        self.monitor.start()
        other.start()
        first, second = self.Client.instances[-2:]
        ids = [first.kwargs.get("client_id"), second.kwargs.get("client_id")]
        self.assertEqual(ids, [self.monitor.client_id, other.client_id])
        self.assertNotEqual(ids[0], ids[1])
        for client_id in ids:
            # MQTT servers must accept 1-23 alphanumeric characters.
            self.assertRegex(client_id, r"^[0-9A-Za-z]{1,23}$")
            self.assertTrue(client_id.startswith("groundconsole"))
        other.stop()

    def test_reconnect_backoff_is_capped(self) -> None:
        self.client = self._start()
        delays = [call[2] for call in self.client.calls if call[0] == "reconnect_delay_set"]
        self.assertEqual(delays, [{"min_delay": 1, "max_delay": 10}])

    def test_snapshot_reports_transport_and_ws_path(self) -> None:
        snapshot = self.monitor.snapshot()
        self.assertEqual((snapshot["transport"], snapshot["ws_path"]), ("websockets", "/mqtt"))
        tcp = self.module.MqttMonitor("127.0.0.1", 1883, transport="tcp").snapshot()
        self.assertEqual(tcp["transport"], "tcp")

    def test_kind_counts_are_keyed_by_kind(self) -> None:
        self._connected()
        now_ms = int(time.time() * 1000)
        self._send("doa", self._doa(now_ms))
        self._send("doa", self._doa(now_ms))
        self._send("health", self._health(now_ms))
        self.client.on_message(
            self.client, None, message(f"{contract.TOPIC_ROOT}/telemetry/angular", b"x", 0, False),
        )
        snapshot = self.monitor.snapshot()
        self.assertEqual(snapshot["kind_counts"], {"doa": 2, "health": 1, "unknown": 1})
        self.assertEqual(set(snapshot["kind_counts"]), set(snapshot["last_by_kind"]))
        self.assertEqual(snapshot["topic_counts"][contract.TOPICS["doa"]], 2)

    def test_each_kind_reports_its_own_age(self) -> None:
        self._connected()
        clock = [1_700_000_000_000]
        with patch.object(self.module, "_now_ms", lambda: clock[0]):
            self._send("doa", self._doa(clock[0]))
            for _ in range(600):
                clock[0] += 1000
                self._send("health", self._health(clock[0]))
            snapshot = self.monitor.snapshot()
        self.assertEqual(snapshot["now_ms"], clock[0])
        self.assertEqual(snapshot["last_age_ms"], 0)
        doa = snapshot["last_by_kind"]["doa"]
        self.assertEqual(doa["age_ms"], 600_000)
        self.assertEqual(doa["source_ts_ms"], clock[0] - 600_000)
        self.assertEqual(snapshot["last_by_kind"]["health"]["age_ms"], 0)
        self.assertNotIn("age_ms", self.monitor._last_by_kind["doa"])

    def test_retained_replay_reports_age_not_latency(self) -> None:
        self._connected()
        clock = [1_700_000_000_000]
        state = contract.build_state(
            ts_ms=clock[0] - 7_200_000, config_rev=3, running=True, frequency_hz=433_920_000,
            gain_db=10.0, array="UCA", method="MUSIC", active_vfos=1,
        )
        with patch.object(self.module, "_now_ms", lambda: clock[0]):
            self._send("doa", self._doa(clock[0] - 25))
            self._send("state", state, retained=True, qos=1)
            snapshot = self.monitor.snapshot()
            replay = snapshot["last_by_kind"]["state"]
            self.assertIs(replay["retained"], True)
            self.assertIsNone(replay["latency_ms"])
            self.assertEqual(clock[0] - replay["source_ts_ms"], 7_200_000)
            self.assertEqual(snapshot["last_latency_ms"], 25)

            clock[0] += 1000
            self._send("state", {**state, "ts_ms": clock[0] - 40}, retained=False, qos=1)
            snapshot = self.monitor.snapshot()
        self.assertEqual(snapshot["last_by_kind"]["state"]["latency_ms"], 40)
        self.assertEqual(snapshot["last_latency_ms"], 40)

    def test_config_ack_is_decoded_against_the_contract(self) -> None:
        self._connected()
        now_ms = int(time.time() * 1000)
        self._send("ack_config", b"not json at all")
        entry = self.monitor.snapshot()["last_by_kind"]["ack_config"]
        self.assertIs(entry["valid"], False)
        self.assertIn("invalid JSON", entry["error"])

        ack = contract.build_config_ack(
            command_id="cmd-1", status="rejected", ts_ms=now_ms, config_rev=7,
            readback_ok=False, error={"code": "CONFIG_CONFLICT", "current_config_rev": 8},
        )
        self._send("ack_config", ack, qos=1)
        snapshot = self.monitor.snapshot()
        entry = snapshot["last_by_kind"]["ack_config"]
        self.assertIs(entry["valid"], True)
        self.assertEqual(entry["payload"]["status"], "rejected")
        self.assertEqual(entry["payload"]["error"]["code"], ack["error"]["code"])
        self.assertEqual(entry["payload"]["config_rev"], 7)
        self.assertEqual((snapshot["valid"], snapshot["invalid"]), (1, 1))

    def test_payload_validity_flags_are_reported_beside_contract_validity(self) -> None:
        self._connected()
        now_ms = int(time.time() * 1000)
        self._send("doa", self._doa(now_ms, valid=False))
        self._send("health", {**self._health(now_ms, doa_valid=False), "settings_valid": True})
        snapshot = self.monitor.snapshot()
        doa = snapshot["last_by_kind"]["doa"]
        self.assertIs(doa["valid"], True)
        self.assertEqual(doa["validity_flags"], {"valid": False})
        health = snapshot["last_by_kind"]["health"]
        self.assertEqual(health["validity_flags"], {"doa_valid": False, "settings_valid": True})
        self._send("doa", b"{}")
        self.assertNotIn("validity_flags", self.monitor.snapshot()["last_by_kind"]["doa"])

    def test_retained_clear_is_counted_as_cleared_not_invalid(self) -> None:
        self._connected()
        now_ms = int(time.time() * 1000)
        state = contract.build_state(
            ts_ms=now_ms, config_rev=3, running=True, frequency_hz=433_920_000,
            gain_db=10.0, array="UCA", method="MUSIC", active_vfos=1, source="synthetic",
        )
        self._send("state", state, retained=True, qos=1)
        self._send("state", b"", qos=1)
        self._send("config_reported", b"", qos=1)
        snapshot = self.monitor.snapshot()
        self.assertEqual(
            (snapshot["received"], snapshot["valid"], snapshot["invalid"], snapshot["cleared"]),
            (3, 1, 0, 2),
        )
        entry = snapshot["last_by_kind"]["state"]
        self.assertIs(entry["cleared"], True)
        self.assertIs(entry["valid"], False)
        self.assertNotIn("payload", entry)
        self.assertNotIn("source", entry)
        self.assertNotIn("error", entry)
        self.assertEqual((entry["bytes"], entry["latency_ms"], entry["source_ts_ms"]), (0, None, None))
        self.assertEqual(snapshot["kind_counts"], {"state": 2, "config_reported": 1})

    def test_empty_publish_on_a_non_retained_topic_is_invalid_not_cleared(self) -> None:
        self._connected()
        self._send("doa", b"")
        self._send("health", b"")
        self._send("ack_config", b"", qos=1)
        self._send("availability", b"", qos=1)
        snapshot = self.monitor.snapshot()
        self.assertEqual(
            (snapshot["received"], snapshot["valid"], snapshot["invalid"], snapshot["cleared"]),
            (4, 0, 3, 1),
        )
        doa = snapshot["last_by_kind"]["doa"]
        self.assertNotIn("cleared", doa)
        self.assertIs(doa["valid"], False)
        self.assertEqual(doa["error"], "empty payload")
        self.assertEqual((doa["bytes"], doa["latency_ms"], doa["source_ts_ms"]), (0, None, None))
        self.assertEqual(snapshot["last_by_kind"]["ack_config"]["error"], "empty payload")
        self.assertIs(snapshot["last_by_kind"]["availability"]["cleared"], True)

    def test_v2_retained_clear_clears_the_topic_without_counting_invalid(self) -> None:
        self._connected()
        topic = f"sdr/v2/{NODE}/availability"
        online = json.dumps({"v": 2, "sid": "7a8b9c0d", "online": True, "t": int(time.time() * 1000)})
        self.client.on_message(self.client, None, message(topic, online.encode("utf-8"), 1, True))
        # Retain As Published keeps the publisher's retain flag on the live clear.
        self.client.on_message(self.client, None, message(topic, b"", 1, True))
        snapshot = self.monitor.rdf_node_snapshot()
        self.assertEqual(
            (snapshot["received"], snapshot["valid"], snapshot["invalid"], snapshot["cleared"]),
            (2, 1, 0, 1),
        )
        entry = snapshot["topics"]["availability"]
        self.assertEqual((entry["status"], entry["error"], entry["payload"]), ("UNAVAILABLE", "RETAINED_CLEARED", None))
        self.assertEqual(self.monitor.snapshot()["received"], 0)

    def test_source_marker_and_health_reasons_are_reported(self) -> None:
        self._connected()
        now_ms = int(time.time() * 1000)
        doa = contract.build_doa(
            seq=1, ts_ms=now_ms, relative_doa_deg=137.4, confidence=0.9, power_db=-54.2,
            frequency_hz=433_920_000, processing_ms=12, valid=True, source="synthetic",
        )
        self._send("doa", doa)
        health = contract.build_health(
            ts_ms=now_ms, state="STALE", daq_ok=True, dropped_frames=0, gps_status="Disabled",
            doa_valid=False, doa_age_ms=None, reasons=["STATUS_STALE", "NODE_CLOCK_STALLED"],
        )
        self._send("health", health)
        last = self.monitor.snapshot()["last_by_kind"]
        self.assertEqual(last["doa"]["source"], "synthetic")
        self.assertNotIn("source", last["health"])
        self.assertEqual(last["health"]["payload"]["reasons"], ["STATUS_STALE", "NODE_CLOCK_STALLED"])
        self.assertEqual(last["health"]["payload"]["state"], "STALE")

    def test_availability_is_decoded_and_its_will_time_is_not_latency(self) -> None:
        self._connected()
        clock = [1_700_000_000_000]
        with patch.object(self.module, "_now_ms", lambda: clock[0]):
            self._send("doa", self._doa(clock[0] - 30))
            will = contract.build_availability(
                ts_ms=clock[0] - 3_600_000, online=False, reason="CONNECTION_LOST",
            )
            self._send("availability", will, qos=1)
            snapshot = self.monitor.snapshot()
        entry = snapshot["last_by_kind"]["availability"]
        self.assertIs(entry["valid"], True)
        self.assertEqual(entry["payload"]["online"], False)
        self.assertEqual(entry["payload"]["reason"], "CONNECTION_LOST")
        self.assertIsNone(entry["latency_ms"])
        self.assertEqual(snapshot["last_latency_ms"], 30)
        self.assertEqual(snapshot["kind_counts"]["availability"], 1)
        self._send("availability", b'{"v":1,"ts_ms":1}', qos=1)
        self.assertIs(self.monitor.snapshot()["last_by_kind"]["availability"]["valid"], False)

    def test_rdf_node_snapshot_reports_server_time(self) -> None:
        clock = [1_700_000_000_000]
        with patch.object(self.module, "_now_ms", lambda: clock[0]):
            self.assertEqual(self.monitor.rdf_node_snapshot()["now_ms"], clock[0])


class GroundConsoleMqttApplyTests(unittest.TestCase):
    """Monitor lifecycle through the Ground Console config and connect paths."""

    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory(prefix="sdr-doa-mqtt-apply-")
        self.addCleanup(self._temp.cleanup)
        self.root = Path(self._temp.name)
        self.monitors: list[Any] = []
        monitors = self.monitors

        class FakeMonitor:
            def __init__(self, host: str, port: int, transport: str = "tcp", ws_path: str = "/mqtt") -> None:
                self.host = host
                self.port = port
                self.transport = transport
                self.ws_path = ws_path
                self.started = False
                self.stopped = False
                self.on_stop = None
                monitors.append(self)

            def start(self) -> None:
                self.started = True

            def stop(self) -> None:
                if self.on_stop is not None:
                    self.on_stop()
                self.stopped = True

            def snapshot(self) -> dict:
                return {
                    "enabled": True, "read_only": True, "publish_enabled": False,
                    "host": self.host, "port": self.port, "transport": self.transport,
                    "ws_path": self.ws_path, "connection": "connecting",
                }

            def rdf_node_snapshot(self) -> dict:
                return {"enabled": True, "connection": "connecting"}

        self.FakeMonitor = FakeMonitor
        loader = patch.object(ground_console, "_load_mqtt_monitor_class", lambda: FakeMonitor)
        loader.start()
        self.addCleanup(loader.stop)
        quiet = patch.object(ground_console.ConsoleHandler, "log_message", lambda *_args: None)
        quiet.start()
        self.addCleanup(quiet.stop)
        self.config_path = self.root / "console.json"
        initial = ground_console._default_console_config(BASE_URL, "127.0.0.1", 1883, 0)
        self.server = ground_console.GroundConsoleServer(
            ("127.0.0.1", 0),
            BASE_URL,
            config_path=str(self.config_path),
            config=initial,
            receiver_data_dir=self.root / "receiver",
        )
        self.addCleanup(self._close_server)
        self.server.apply_config(initial)
        self._thread: threading.Thread | None = None

    def _close_server(self) -> None:
        if self._thread is not None:
            self.server.shutdown()
            self._thread.join(timeout=5)
        if self.server.mqtt_monitor is not None:
            self.server.mqtt_monitor.stop()
        self.server.server_close()

    def request(self, method: str, path: str, body: object = None) -> tuple[int, dict]:
        if self._thread is None:
            self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
            self._thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=10)
        try:
            data = None if body is None else json.dumps(body).encode("utf-8")
            headers = {} if data is None else {"Content-Type": "application/json"}
            connection.request(method, path, body=data, headers=headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()

    def test_reconnect_with_unchanged_target_replaces_the_monitor(self) -> None:
        first = self.server.mqtt_monitor
        self.assertIsInstance(first, self.FakeMonitor)
        self.assertTrue(first.started)

        monitor = self.server.enable_mqtt_monitor("127.0.0.1", 1883)

        self.assertIsNot(monitor, first)
        self.assertIs(self.server.mqtt_monitor, monitor)
        self.assertTrue(first.stopped)
        self.assertTrue(monitor.started)
        self.assertEqual((monitor.host, monitor.port, monitor.transport), ("127.0.0.1", 1883, "websockets"))

    def test_plain_save_with_unchanged_target_keeps_the_monitor(self) -> None:
        first = self.server.mqtt_monitor
        saved = self.server.apply_config({**self.server.get_config(), "refresh_seconds": 10})
        self.assertEqual(saved["refresh_seconds"], 10)
        self.assertIs(self.server.mqtt_monitor, first)
        self.assertFalse(first.stopped)

    def test_connect_endpoint_restarts_and_accepts_transport_and_ws_path(self) -> None:
        first = self.server.mqtt_monitor
        status, body = self.request("POST", "/api/mqtt/connect?host=127.0.0.1&port=1883")
        self.assertEqual(status, 200)
        self.assertTrue(first.stopped)
        self.assertEqual(body["transport"], "websockets")

        status, body = self.request("POST", "/api/mqtt/connect?host=127.0.0.1&port=18884&transport=tcp")
        self.assertEqual(status, 200)
        self.assertEqual((body["port"], body["transport"]), (18884, "tcp"))
        status, body = self.request("POST", "/api/mqtt/connect?host=127.0.0.1&port=9001&transport=websockets&ws_path=/ws")
        self.assertEqual(status, 200)
        self.assertEqual((body["transport"], body["ws_path"]), ("websockets", "/ws"))
        status, config = self.request("GET", "/api/console-config")
        self.assertEqual(status, 200)
        self.assertEqual(
            (config["mqtt_port"], config["mqtt_transport"], config["mqtt_ws_path"]),
            (9001, "websockets", "/ws"),
        )

        count = len(self.monitors)
        for query in ("transport=udp", "transport=", "ws_path=mqtt", "ws_path=/a%20b", "ws_path=/a%3Fb", "ws_path=/a%0D%0AX:1"):
            status, body = self.request("POST", f"/api/mqtt/connect?host=127.0.0.1&port=1883&{query}")
            if query == "transport=":
                self.assertEqual(status, 200, query)
                continue
            self.assertEqual(status, 400, query)
            self.assertIn("error", body)
        self.assertEqual(len(self.monitors), count + 1)

    def test_config_contract_validates_transport_and_ws_path(self) -> None:
        config = ground_console._default_console_config()
        self.assertEqual((config["mqtt_transport"], config["mqtt_ws_path"]), ("websockets", "/mqtt"))
        legacy = {key: value for key, value in config.items() if key != "mqtt_ws_path"}
        self.assertEqual(ground_console._validate_console_config(legacy)["mqtt_ws_path"], "/mqtt")
        for path in ("/", "/mqtt", "/ws/v1", "/a.b~c_d-e", "/" + "x" * 127):
            self.assertEqual(
                ground_console._validate_console_config({**config, "mqtt_ws_path": path})["mqtt_ws_path"], path,
            )
        for path in ("mqtt", "", "/a b", "/a?b", "/a#b", "/a\r\nHost: x", "/" + "x" * 128, None, 5, ["/mqtt"]):
            with self.assertRaises(ValueError, msg=repr(path)):
                ground_console._validate_console_config({**config, "mqtt_ws_path": path})
        for transport in ("udp", "", None, "TCP"):
            with self.assertRaises(ValueError, msg=repr(transport)):
                ground_console._validate_console_config({**config, "mqtt_transport": transport})

    def test_transport_or_path_change_restarts_monitor_with_new_options(self) -> None:
        first = self.server.mqtt_monitor
        self.server.apply_config({**self.server.get_config(), "mqtt_transport": "tcp"})
        second = self.server.mqtt_monitor
        self.assertTrue(first.stopped)
        self.assertEqual(second.transport, "tcp")
        self.server.apply_config({**self.server.get_config(), "mqtt_transport": "websockets", "mqtt_ws_path": "/ws"})
        third = self.server.mqtt_monitor
        self.assertTrue(second.stopped)
        self.assertEqual((third.transport, third.ws_path), ("websockets", "/ws"))
        self.assertEqual(ground_console._load_console_config(self.config_path)["mqtt_ws_path"], "/ws")

    def test_post_console_config_carries_mqtt_fields(self) -> None:
        status, body = self.request("POST", "/api/console-config", {"mqtt_transport": "tcp", "mqtt_port": 18884})
        self.assertEqual(status, 200)
        self.assertEqual((body["mqtt_transport"], body["mqtt_ws_path"], body["mqtt_port"]), ("tcp", "/mqtt", 18884))
        self.assertEqual(self.server.mqtt_monitor.transport, "tcp")
        status, body = self.request("POST", "/api/console-config", {"mqtt_ws_path": "no-slash"})
        self.assertEqual(status, 400)
        self.assertNotIn("password", json.dumps(self.server.get_config()).lower())

    def test_old_monitor_is_stopped_outside_the_config_lock(self) -> None:
        first = self.server.mqtt_monitor
        lock_free: list[bool] = []

        def probe() -> None:
            result: list[bool] = []

            def acquire() -> None:
                acquired = self.server._config_lock.acquire(timeout=1.0)
                result.append(acquired)
                if acquired:
                    self.server._config_lock.release()

            worker = threading.Thread(target=acquire)
            worker.start()
            worker.join()
            lock_free.extend(result)

        first.on_stop = probe
        self.server.enable_mqtt_monitor("127.0.0.1", 1883)
        self.assertEqual(lock_free, [True])
        self.assertTrue(first.stopped)

        second = self.server.mqtt_monitor
        lock_free.clear()
        second.on_stop = probe
        self.server.apply_config({**self.server.get_config(), "mqtt_host": ""})
        self.assertEqual(lock_free, [True])
        self.assertIsNone(self.server.mqtt_monitor)

    def test_missing_paho_saves_config_and_reports_monitor_error(self) -> None:
        def missing() -> Any:
            raise RuntimeError(ground_console.MQTT_DEPENDENCY_ERROR)

        with patch.object(ground_console, "_load_mqtt_monitor_class", missing):
            status, body = self.request(
                "POST", "/api/console-config", {"mqtt_host": "127.0.0.2", "refresh_seconds": 10},
            )
            self.assertEqual(status, 200)
            self.assertEqual((body["mqtt_host"], body["refresh_seconds"]), ("127.0.0.2", 10))
            self.assertEqual(ground_console._load_console_config(self.config_path)["refresh_seconds"], 10)

            status, snapshot = self.request("GET", "/api/mqtt")
            self.assertEqual(status, 200)
            self.assertEqual(snapshot["connection"], "error")
            self.assertEqual(snapshot["last_error"], ground_console.MQTT_DEPENDENCY_ERROR)
            self.assertEqual(snapshot["host"], "127.0.0.2")
            self.assertIs(snapshot["publish_enabled"], False)

            status, rdf = self.request("GET", "/api/mqtt/rdf-node")
            self.assertEqual(status, 200)
            self.assertEqual((rdf["connection"], rdf["last_error"]), ("error", "DEPENDENCY_MISSING"))

            status, body = self.request("POST", "/api/mqtt/connect?host=127.0.0.1&port=1883")
            self.assertEqual(status, 502)
            self.assertEqual(body["error"], ground_console.MQTT_DEPENDENCY_ERROR)

    def test_real_monitor_receives_configured_ws_path(self) -> None:
        paho, client_class = fake_paho()
        module = load_monitor(paho)
        with patch.object(ground_console, "_load_mqtt_monitor_class", lambda: module.MqttMonitor):
            monitor = ground_console._new_mqtt_monitor("127.0.0.1", 9001, "websockets", "/ws")
            monitor.start()
            self.addCleanup(monitor.stop)
        client = client_class.instances[-1]
        self.assertIn(("ws_set_options", (), {"path": "/ws"}), client.calls)
        self.assertEqual(client.kwargs.get("transport"), "websockets")
        self.assertTrue(re.fullmatch(r"groundconsole[0-9a-f]{10}", monitor.client_id))


if __name__ == "__main__":
    unittest.main()
