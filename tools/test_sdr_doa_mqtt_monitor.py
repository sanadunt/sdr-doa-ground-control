"""Tests for the single MQTT client that observes sdr/v1 and the RDF Node topics."""
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
            # None makes publish() return None, as the original fake did;
            # an int makes it return a paho-like MQTTMessageInfo (rc, mid).
            self.publish_rc: int | None = None
            self.publish_hook = None
            self._out_messages: dict[int, object] = {}
            self._out_message_mutex = threading.RLock()
            self.on_connect = None
            self.on_connect_fail = None
            self.on_disconnect = None
            self.on_subscribe = None
            self.on_message = None
            self.on_publish = None
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

        def publish(self, *args: object, **kwargs: object) -> object:
            self.publish_calls.append((args, kwargs))
            if self.publish_rc is None:
                return None
            self.mid += 1
            mid = self.mid
            if self.publish_rc == mqtt.MQTT_ERR_NO_CONN:
                # paho keeps a QoS 1 message it could not send for the next connection.
                self._out_messages[mid] = (args, kwargs)
            if self.publish_hook is not None:
                self.publish_hook(mid)
            return types.SimpleNamespace(rc=self.publish_rc, mid=mid)

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
    mqtt.MQTT_ERR_NO_CONN = 4
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
        "MQTT_ERR_SUCCESS", "MQTT_ERR_NO_CONN", "SubscribeOptions", "PacketTypes",
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

    def test_edge_payloads_reach_the_rdf_node_view_through_the_shared_connection(self) -> None:
        fixtures = TOOLS_DIR / "fixtures" / "rdf-node"
        manifest = json.loads((fixtures / "manifest.json").read_text(encoding="utf-8"))
        by_file = {entry["file"]: entry for entry in manifest["fixtures"]}
        self._connected()
        # state is the first RDF Node filter, so its retained value comes first.
        v2_topics = [topic for topic, _options in self.client.subscriptions if topic.startswith("sdr/v2/")]
        self.assertEqual(v2_topics[0], f"sdr/v2/{NODE}/state")
        clock = [manifest["generated_at_ms"]]

        def deliver(name: str) -> None:
            entry = by_file[name]
            self.client.on_message(self.client, None, message(
                f"sdr/v2/{NODE}/{entry['topic']}", (fixtures / name).read_bytes(), entry["qos"], entry["retain"],
            ))

        with patch.object(self.module, "_now_ms", lambda: clock[0]):
            for name in ("state.json", "capabilities.json", "telemetry-health.json", "telemetry-doa.ok1.json",
                         "telemetry-angular.live.json", "ack-config.config-get-applied.json"):
                deliver(name)
            report = json.loads((fixtures / "settings-reported.json").read_bytes())
            deliver("settings-reported.json")
            self.assertIsNone(self.monitor.rdf_node_settings_report())
            self.monitor.expect_rdf_node_settings_report(report["id"])
            deliver("settings-reported.json")
            snapshot = self.monitor.rdf_node_snapshot()
            session = self.monitor.rdf_node_session()
            saved = self.monitor.rdf_node_settings_report()
            ack = self.monitor.rdf_node_ack(report["id"])
        self.assertEqual(snapshot["connection"], "ready")
        self.assertEqual(snapshot["invalid"], 0)
        self.assertEqual(snapshot["topics"]["telemetry/doa"]["status"], "LIVE")
        self.assertEqual(snapshot["topics"]["telemetry/angular"]["status"], "LIVE")
        self.assertTrue(snapshot["node"]["angular"]["live"])
        self.assertEqual(snapshot["topics"]["settings/reported"]["status"], "FRESH")
        self.assertEqual((session["sid"], session["cfg"], session["health_fresh"]), (report["sid"], report["rev"], True))
        self.assertEqual(saved["settings_json"], report["settings_json"])
        self.assertEqual((ack["status"], ack["topic"]), ("APPLIED", "ack/config"))
        self.assertEqual(self.client.publish_calls, [])

    def test_rdf_node_snapshot_reports_server_time(self) -> None:
        clock = [1_700_000_000_000]
        with patch.object(self.module, "_now_ms", lambda: clock[0]):
            self.assertEqual(self.monitor.rdf_node_snapshot()["now_ms"], clock[0])

    # -- config-patch publish path ------------------------------------------

    @staticmethod
    def _patch_command(command_id: str = "gc-test-1", *, base: int = 7, ttl_ms: int = 60_000) -> dict:
        issued = int(time.time() * 1000)
        return contract.build_config_patch(
            command_id=command_id,
            base_config_rev=base,
            changes={"center_frequency_hz": 433_920_000, "gain_db": 24.5},
            issued_ts_ms=issued,
            expires_ts_ms=issued + ttl_ms,
        )

    @staticmethod
    def _ack(command_id: str, status: str, *, config_rev: int, error: dict | None = None) -> dict:
        return contract.build_config_ack(
            command_id=command_id,
            status=status,
            ts_ms=int(time.time() * 1000),
            config_rev=config_rev,
            readback_ok=status == "applied",
            error=error,
            changed_fields=["center_frequency_hz"] if status == "applied" else None,
        )

    def test_publish_config_patch_publishes_once_at_qos1_without_retain(self) -> None:
        self._connected()
        self.assertEqual(self.client.on_publish, self.monitor._on_publish)
        command = self._patch_command()
        result = self.monitor.publish_config_patch(command)

        self.assertEqual(len(self.client.publish_calls), 1)
        (topic, raw), options = self.client.publish_calls[0]
        self.assertEqual(topic, contract.TOPICS["config_patch"])
        self.assertEqual(json.loads(raw.decode("utf-8")), command)
        contract.validate_config_patch(json.loads(raw.decode("utf-8")))
        self.assertEqual(options["qos"], 1)
        self.assertIs(options["retain"], False)
        # The broker drops the command after its TTL even if paho replays it.
        self.assertEqual(options["properties"].MessageExpiryInterval, 60)
        # The fake returns None like a paho without MQTTMessageInfo: rc 0, no mid.
        self.assertEqual((result["rc"], result["mid"]), (0, None))
        self.assertEqual(result["topic"], contract.TOPICS["config_patch"])
        observation = self.monitor.config_command_observation(command["id"])
        self.assertIs(observation["published"], True)
        self.assertIsNone(observation["puback"])
        # The Message Monitor snapshot keeps saying the monitor never publishes on its own.
        snapshot = self.monitor.snapshot()
        self.assertIs(snapshot["read_only"], True)
        self.assertIs(snapshot["publish_enabled"], False)

        with self.assertRaises(Exception) as repeated:
            self.monitor.publish_config_patch(command)
        self.assertEqual(getattr(repeated.exception, "code", None), "MQTT_PUBLISH_FAILED")
        self.assertEqual(len(self.client.publish_calls), 1)

    def test_publish_config_patch_requires_a_ready_connection(self) -> None:
        command = self._patch_command()
        with self.assertRaises(Exception) as before_start:
            self.monitor.publish_config_patch(command)
        self.assertEqual(getattr(before_start.exception, "code", None), "MQTT_NOT_CONNECTED")

        self.client = self._start()
        self.client.on_connect(self.client, None, {}, types.SimpleNamespace(value=0, is_failure=False), None)
        with self.assertRaises(Exception) as before_suback:
            self.monitor.publish_config_patch(command)
        self.assertEqual(getattr(before_suback.exception, "code", None), "MQTT_NOT_CONNECTED")

        self.acknowledge()
        self.client.on_disconnect(self.client, None, None, types.SimpleNamespace(value=0), None)
        with self.assertRaises(Exception) as after_disconnect:
            self.monitor.publish_config_patch(command)
        self.assertEqual(getattr(after_disconnect.exception, "code", None), "MQTT_NOT_CONNECTED")
        self.assertEqual(self.client.publish_calls, [])

    def test_puback_is_correlated_even_when_it_beats_the_publish_return(self) -> None:
        self._connected()
        self.client.publish_rc = 0
        first = self._patch_command("gc-first")
        result = self.monitor.publish_config_patch(first)
        self.assertIsInstance(result["mid"], int)
        self.assertIsNone(self.monitor.config_command_observation("gc-first")["puback"])
        self.client.on_publish(self.client, None, result["mid"], types.SimpleNamespace(value=0), None)
        self.assertEqual(self.monitor.config_command_observation("gc-first")["puback"]["reason"], 0)

        # The PUBACK arrives on paho's thread before publish() has returned.
        self.client.publish_hook = lambda mid: self.client.on_publish(
            self.client, None, mid, types.SimpleNamespace(value=135, is_failure=True), None,
        )
        self.monitor.publish_config_patch(self._patch_command("gc-second"))
        self.assertEqual(self.monitor.config_command_observation("gc-second")["puback"]["reason"], 135)
        # A PUBACK from a retired client is ignored.
        other = self.Client("retired")
        self.monitor._on_publish(other, None, result["mid"], types.SimpleNamespace(value=0), None)
        self.assertEqual(self.monitor._early_pubacks, {})

    def test_publish_without_connection_is_withdrawn_from_the_paho_queue(self) -> None:
        self._connected()
        self.client.publish_rc = self.module.mqtt.MQTT_ERR_NO_CONN
        with self.assertRaises(Exception) as raised:
            self.monitor.publish_config_patch(self._patch_command("gc-raced"))
        self.assertEqual(getattr(raised.exception, "code", None), "MQTT_NOT_CONNECTED")
        # Nothing stays queued for a replay after the next reconnect.
        self.assertEqual(self.client._out_messages, {})
        self.assertIs(self.monitor.config_command_observation("gc-raced")["published"], False)

    def test_config_acks_are_captured_by_id_and_bounded(self) -> None:
        self._connected()
        keys_before = set(self.monitor.snapshot()["last_by_kind"])
        total = self.module.MAX_CONFIG_ACKS + 6
        for index in range(total):
            self._send("ack_config", self._ack(f"cmd-{index}", "rejected", config_rev=3,
                                               error={"code": "REMOTE_CONTROL_DISABLED"}), qos=1)
        self.assertEqual(len(self.monitor._config_acks), self.module.MAX_CONFIG_ACKS)
        self.assertIsNone(self.monitor.config_command_observation("cmd-0")["ack"])
        last = self.monitor.config_command_observation(f"cmd-{total - 1}")["ack"]
        self.assertEqual((last["status"], last["error_code"]), ("rejected", "REMOTE_CONTROL_DISABLED"))
        self.assertIsInstance(last["received_at_ms"], int)
        # The ACK store lives beside the Message Monitor data, not inside it.
        self.assertEqual(set(self.monitor.snapshot()["last_by_kind"]) - keys_before, {"ack_config"})

        # A late progress ACK never hides the final answer for the same id.
        self._send("ack_config", self._ack("cmd-final", "applied", config_rev=4), qos=1)
        self._send("ack_config", self._ack("cmd-final", "received", config_rev=4), qos=1)
        final = self.monitor.config_command_observation("cmd-final")["ack"]
        self.assertEqual((final["status"], final["config_rev"], final["changed_fields"]),
                         ("applied", 4, ["center_frequency_hz"]))

    def test_broker_echo_of_the_published_command_is_flagged(self) -> None:
        self._connected()
        command = self._patch_command("gc-echo")
        self.monitor.publish_config_patch(command)
        (_topic, raw), _options = self.client.publish_calls[0]
        tampered = dict(command, changes={"gain_db": 10})
        self._send("config_patch", tampered, qos=1)
        self.assertIsNone(self.monitor.config_command_observation("gc-echo")["echoed_at_ms"])
        self._send("config_patch", raw, qos=1)
        self.assertIsInstance(self.monitor.config_command_observation("gc-echo")["echoed_at_ms"], int)

    def test_reported_config_selects_the_v1_base_revision(self) -> None:
        self._connected()
        now = int(time.time() * 1000)
        reported = self.monitor.reported_config()
        self.assertEqual((reported["base_config_rev"], reported["base_config_rev_source"]), (None, None))
        self.assertIsNone(reported["reported"])
        self.assertEqual(reported["connection"], "connected")
        self.assertEqual(set(reported["values"]), set(contract.CONFIG_RANGES))

        def state(rev: int) -> dict:
            return contract.build_state(
                ts_ms=now, config_rev=rev, running=True, frequency_hz=433_920_000,
                gain_db=10.0, array="UCA", method="MUSIC", active_vfos=1,
            )

        def config(rev: int, source: str | None = None) -> dict:
            return contract.build_config_reported(
                ts_ms=now, config_rev=rev, center_frequency_hz=416_588_000, gain_db=15.5,
                array="UCA", method="MUSIC", active_vfos=1, source=source,
            )

        def base() -> tuple:
            data = self.monitor.reported_config()
            return data["base_config_rev"], data["base_config_rev_source"]

        self._send("state", state(5), retained=True, qos=1)
        self.assertEqual(base(), (5, "state"))
        self._send("config_reported", config(7), retained=True, qos=1)
        self.assertEqual(base(), (7, "config_reported"))
        self._send("ack_config", self._ack("a1", "applied", config_rev=8), qos=1)
        self.assertEqual(base(), (8, "ack"))
        self._send("ack_config", self._ack("a2", "conflict", config_rev=9,
                                           error={"code": "CONFIG_REVISION_CONFLICT", "current_config_rev": 9}), qos=1)
        self.assertEqual(base(), (9, "ack"))
        # A retained ACK replay has no order relative to config_reported.
        self._send("ack_config", self._ack("old", "applied", config_rev=99), retained=True, qos=1)
        self.assertEqual(base(), (9, "ack"))
        # Rejections carry the agent's revision only incidentally; they never move the base.
        self._send("config_reported", config(10), qos=1)
        self._send("ack_config", self._ack("a3", "rejected", config_rev=0,
                                           error={"code": "REMOTE_CONTROL_DISABLED"}), qos=1)
        self.assertEqual(base(), (10, "config_reported"))
        # A retained clear of config_reported falls back to state.
        self._send("config_reported", b"", qos=1)
        self.assertEqual(base(), (5, "state"))
        self._send("state", b"", qos=1)
        self.assertEqual(base(), (None, None))

        self._send("config_reported", config(11, source="synthetic"), retained=True, qos=1)
        data = self.monitor.reported_config()
        self.assertEqual(data["reported"]["config_rev"], 11)
        self.assertIs(data["reported"]["synthetic"], True)
        self.assertIs(data["reported"]["retained"], True)
        self.assertEqual(data["reported"]["source"], "v1")
        self.assertEqual(data["values"]["center_frequency_hz"], 416_588_000)
        self.assertEqual(data["values"]["gain_db"], 15.5)
        self.assertEqual(data["value_sources"]["center_frequency_hz"], "v1_config_reported")
        self.assertIsNone(data["values"]["vfo_frequency_hz"])
        self.assertIsNone(data["value_sources"]["vfo_frequency_hz"])

    def test_retained_config_report_is_aged_from_its_own_timestamp(self) -> None:
        self._connected()
        published = 1_760_000_000_000
        clock = [published + 3 * 3_600_000]

        def config(ts_ms: int, rev: int = 42) -> dict:
            return contract.build_config_reported(
                ts_ms=ts_ms, config_rev=rev, center_frequency_hz=416_588_000, gain_db=15.5,
                array="UCA", method="MUSIC", active_vfos=1,
            )

        def reported() -> dict:
            return self.monitor.reported_config()["reported"]

        with patch.object(self.module, "_now_ms", lambda: clock[0]):
            # The broker replays a report the agent published three hours ago.
            self._send("config_reported", config(published), retained=True, qos=1)
            clock[0] += 400
            replay = reported()
            self.assertIs(replay["retained"], True)
            self.assertEqual(
                (replay["age_ms"], replay["age_basis"], replay["source_ts_ms"]),
                (3 * 3_600_000 + 400, "source_ts", published),
            )
            # A small clock lead on the Raspberry is tolerated (age 0); a large
            # one, or an unsynced pre-2020 clock, leaves the age unknown.
            received = clock[0]
            for ts_ms, expected in (
                (received + 4_000, (0, "source_ts")),
                (received + 6_000, (None, None)),
                (86_400_000, (None, None)),
            ):
                self._send("config_reported", config(ts_ms), retained=True, qos=1)
                entry = reported()
                self.assertEqual((entry["age_ms"], entry["age_basis"], entry["source_ts_ms"]), (*expected, ts_ms))
            # A live report is aged from its receipt, whatever its timestamp says.
            self._send("config_reported", config(published, rev=43), qos=1)
            clock[0] += 1_500
            live = reported()
            self.assertIs(live["retained"], False)
            self.assertEqual((live["age_ms"], live["age_basis"], live["config_rev"]), (1_500, "received", 43))

    def test_retired_rdf_node_config_reported_is_not_read(self) -> None:
        # The RDF Node edge has no config/reported. A retained leftover on the
        # broker is not subscribed, so it is neither counted nor a value source.
        self._connected()
        self.assertNotIn(f"sdr/v2/{NODE}/config/reported", {topic for topic, _options in self.client.subscriptions})
        now = int(time.time() * 1000)
        leftover = json.dumps({
            "v": 2, "sid": "7a8b9c0d", "rev": 3, "t": now, "proof": "unverified", "digest": "abc",
            "effective": {"center_frequency_hz": 433_000_000, "vfo0_frequency_hz": 433_900_000},
        }).encode("utf-8")
        self.client.on_message(self.client, None, message(f"sdr/v2/{NODE}/config/reported", leftover, 1, True))
        data = self.monitor.reported_config()
        self.assertIsNone(data["reported"])
        self.assertEqual((data["base_config_rev"], data["base_config_rev_source"]), (None, None))
        self.assertEqual(set(data["values"].values()), {None})
        snapshot = self.monitor.rdf_node_snapshot()
        self.assertEqual((snapshot["received"], snapshot["invalid"]), (0, 0))
        self.assertNotIn("config/reported", snapshot["topics"])
        self.assertIsNone(snapshot["node"]["session"])

        v1 = contract.build_config_reported(
            ts_ms=now, config_rev=4, center_frequency_hz=416_588_000, gain_db=15.5,
            array="UCA", method="MUSIC", active_vfos=1,
        )
        self._send("config_reported", v1, retained=True, qos=1)
        data = self.monitor.reported_config()
        self.assertEqual(data["reported"]["source"], "v1")
        self.assertEqual((data["base_config_rev"], data["base_config_rev_source"]), (4, "config_reported"))
        self.assertEqual(data["value_sources"]["center_frequency_hz"], "v1_config_reported")
        self.assertIsNone(data["values"]["vfo_frequency_hz"])
        self.assertEqual(self.client.publish_calls, [])

    def test_reported_config_keeps_the_receipt_time_of_each_value(self) -> None:
        self._connected()
        clock = [1_760_000_000_000]
        v1 = contract.build_config_reported(
            ts_ms=clock[0], config_rev=4, center_frequency_hz=416_588_000, gain_db=15.5,
            array="UCA", method="MUSIC", active_vfos=1,
        )
        with patch.object(self.module, "_now_ms", lambda: clock[0]):
            clock[0] += 3_000
            self._send("config_reported", v1, qos=1)
            v1_at = clock[0]
            clock[0] += 500
            data = self.monitor.reported_config()
        received = data["value_received_at_ms"]
        # Each value carries the receipt time of the message it came from.
        self.assertEqual(received["center_frequency_hz"], v1_at)
        self.assertEqual(received["gain_db"], v1_at)
        self.assertIsNone(received["vfo_frequency_hz"])
        self.assertIsNone(received["vfo_squelch_db"])
        self.assertEqual(data["reported"]["received_at_ms"], v1_at)


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

    def request(self, method: str, path: str, body: object = None, origin: str | None = "same") -> tuple[int, dict]:
        if self._thread is None:
            self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
            self._thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=10)
        try:
            data = None if body is None else json.dumps(body).encode("utf-8")
            headers = {} if data is None else {"Content-Type": "application/json"}
            # Same-origin fetches from the console send Origin on POST.
            if origin == "same":
                headers["Origin"] = f"http://127.0.0.1:{self.server.server_address[1]}"
            elif origin is not None:
                headers["Origin"] = origin
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

    def test_monitor_changing_posts_require_same_loopback_origin(self) -> None:
        first = self.server.mqtt_monitor
        count = len(self.monitors)
        saved = self.config_path.read_bytes()
        config = self.server.get_config()
        port = self.server.server_address[1]
        retarget = {"mqtt_host": "203.0.113.9", "mqtt_port": 1883, "mqtt_transport": "tcp"}
        for origin in (None, "", "https://evil.example", f"http://127.0.0.1:{port + 1}", f"http://localhost:{port}", "null"):
            for path, body in (
                ("/api/console-config", retarget),
                ("/api/mqtt/connect?host=203.0.113.9&port=1883&transport=tcp", None),
            ):
                with self.subTest(origin=origin, path=path):
                    status, response = self.request("POST", path, body, origin=origin)
                    self.assertEqual(status, 403)
                    self.assertEqual(
                        (response["ok"], response["code"], response["read_only"]), (False, "ORIGIN_REJECTED", True),
                    )
        self.assertIs(self.server.mqtt_monitor, first)
        self.assertFalse(first.stopped)
        self.assertEqual(len(self.monitors), count)
        self.assertEqual(self.server.get_config(), config)
        self.assertEqual(self.config_path.read_bytes(), saved)

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
