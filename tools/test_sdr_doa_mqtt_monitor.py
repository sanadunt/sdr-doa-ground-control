"""Tests for the console's one MQTT client: the RDF Node topics, its status and Kontrol's publish."""
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

from tools import rdf_node_commands as commands
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

    def test_one_websocket_client_subscribes_to_the_rdf_node_topics_only(self) -> None:
        self.client = self._start()
        self.client.on_connect(self.client, None, {}, types.SimpleNamespace(value=0, is_failure=False), None)

        connect_call = next(call for call in self.client.calls if call[0] == "connect_async")
        self.assertTrue(connect_call[2]["clean_start"])
        self.assertEqual(connect_call[2]["properties"].SessionExpiryInterval, 0)
        self.assertEqual(len(self.Client.instances), 1)
        self.assertEqual(self.client.kwargs.get("protocol"), 5)
        self.assertEqual(self.client.kwargs.get("transport"), "websockets")
        self.assertIn(("ws_set_options", (), {"path": "/mqtt"}), self.client.calls)
        expected = [f"sdr/v2/{NODE}/{suffix}" for suffix in RDF_NODE_V2_SUFFIXES]
        self.assertEqual([topic for topic, _options in self.client.subscriptions], expected)
        for topic, options in self.client.subscriptions:
            self.assertEqual(options.qos, 1)
            # The contract's validation needs the publisher's retain flag.
            self.assertIs(options.retainAsPublished, True)
            self.assertEqual(options.retainHandling, 0)
            self.assertNotIn("#", topic)
        self.assertEqual(self.monitor.rdf_node_snapshot()["connection"], "connecting")
        self.assertEqual(self.monitor.snapshot()["connection"], "connecting")

        self.acknowledge()
        self.assertEqual(self.monitor.rdf_node_snapshot()["connection"], "ready")
        self.assertEqual(self.monitor.snapshot()["connection"], "connected")

    def test_status_counts_the_rdf_node_topics_and_nothing_else(self) -> None:
        self.client = self._start()
        self.client.on_connect(self.client, None, {}, types.SimpleNamespace(value=0, is_failure=False), None)
        self.acknowledge()
        clock = [1_700_000_000_000]
        availability = json.dumps({"v": 2, "sid": "7a8b9c0d", "online": True, "t": clock[0]}).encode("utf-8")
        with patch.object(self.module, "_now_ms", lambda: clock[0]):
            self.client.on_message(self.client, None, message(f"sdr/v2/{NODE}/availability", availability, 1, True))
            # A topic outside the subscribed node topics is neither counted nor stored.
            for topic in ("sdr/legacy/uav-01/telemetry/health", f"sdr/v2/{NODE}/config/reported",
                          f"sdr/v2/{NODE}/cmd/config/patch", "sdr/v2/uav-02/availability"):
                self.client.on_message(self.client, None, message(topic, availability, 1, False))
            clock[0] += 1_500
            self.client.on_message(self.client, None, message(
                f"sdr/v2/{NODE}/availability", b'{"v":1,"sid":"7a8b9c0d","online":true,"t":1}', 1, True,
            ))
            clock[0] += 2_000
            status = self.monitor.snapshot()
            rdf = self.monitor.rdf_node_snapshot()

        self.assertEqual((status["received"], status["valid"], status["invalid"], status["cleared"]), (2, 1, 1, 0))
        self.assertEqual(
            {key: status[key] for key in ("received", "valid", "invalid", "cleared", "last_received_at_ms")},
            {key: rdf[key] for key in ("received", "valid", "invalid", "cleared", "last_received_at_ms")},
        )
        self.assertEqual((status["last_received_at_ms"], status["last_age_ms"]), (clock[0] - 2_000, 2_000))
        self.assertEqual((status["node_id"], status["root"]), (NODE, f"sdr/v2/{NODE}"))
        self.assertEqual((status["read_only"], status["publish_enabled"]), (True, False))
        self.assertEqual(rdf["topics"]["availability"]["status"], "INVALID")
        self.assertEqual(rdf["topic_counts"]["availability"], 2)
        # The status holds no per-topic or per-message detail; that is rdf_node_snapshot's.
        for key in ("last_by_kind", "kind_counts", "topic_counts", "last_topic", "total_bytes", "last_latency_ms"):
            self.assertNotIn(key, status)
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
        status = self.monitor.snapshot()
        self.assertEqual((status["received"], status["valid"], status["invalid"], status["cleared"]), (2, 1, 0, 1))

    def test_edge_payloads_reach_the_rdf_node_view_through_the_shared_connection(self) -> None:
        fixtures = TOOLS_DIR / "fixtures" / "rdf-node"
        manifest = json.loads((fixtures / "manifest.json").read_text(encoding="utf-8"))
        by_file = {entry["file"]: entry for entry in manifest["fixtures"]}
        self._connected()
        # state is the first filter, so its retained value comes first.
        self.assertEqual(self.client.subscriptions[0][0], f"sdr/v2/{NODE}/state")
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
        self.assertEqual((saved["matches_state_cfg"], saved["safe_settings"]["center_frequency_hz"]), (True, 433920000))
        self.assertEqual((ack["status"], ack["topic"]), ("APPLIED", "ack/config"))
        self.assertEqual(self.client.publish_calls, [])

    def test_rdf_node_snapshot_reports_server_time(self) -> None:
        clock = [1_700_000_000_000]
        with patch.object(self.module, "_now_ms", lambda: clock[0]):
            self.assertEqual(self.monitor.rdf_node_snapshot()["now_ms"], clock[0])

    def test_rdf_node_view_feeds_the_telemetry_source(self) -> None:
        # Issue #8: the Dashboard's source reads the node view with the LIVE
        # Angular values, and nothing while the monitor is stopped.
        self.assertIsNone(self.monitor.rdf_node_view())
        fixtures = TOOLS_DIR / "fixtures" / "rdf-node"
        manifest = json.loads((fixtures / "manifest.json").read_text(encoding="utf-8"))
        by_file = {entry["file"]: entry for entry in manifest["fixtures"]}
        self._connected()
        with patch.object(self.module, "_now_ms", lambda: manifest["generated_at_ms"]):
            for name in ("state.json", "telemetry-health.json", "telemetry-doa.ok1.json", "telemetry-angular.live.json"):
                entry = by_file[name]
                self.client.on_message(self.client, None, message(
                    f"sdr/v2/{NODE}/{entry['topic']}", (fixtures / name).read_bytes(), entry["qos"], entry["retain"],
                ))
            view = self.monitor.rdf_node_view()
        self.assertEqual((view["connection"], view["node_id"], view["now_ms"]), ("ready", NODE, manifest["generated_at_ms"]))
        self.assertTrue(view["node"]["health"]["fresh"])
        self.assertTrue(view["node"]["doa"]["live"])
        self.assertEqual(len(view["node"]["angular"]["values"]), 360)
        self.monitor.stop()
        self.assertIsNone(self.monitor.rdf_node_view())

    # -- Kontrol command publish path ----------------------------------------

    COMMANDS = json.loads((TOOLS_DIR / "fixtures" / "rdf-node" / "commands.json").read_text(encoding="utf-8"))

    def _rdf(self, suffix: str, payload: object, *, qos: int = 1, retained: bool = False) -> None:
        raw = payload if isinstance(payload, bytes) else json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.client.on_message(self.client, None, message(f"sdr/v2/{NODE}/{suffix}", raw, qos, retained))

    def _node_state(self) -> dict:
        state = json.loads(self.COMMANDS["session"]["state"])
        self._rdf("state", self.COMMANDS["session"]["state"].encode("utf-8"), retained=True)
        return state

    def _command(self, command_id: str = "gc-test-1", *, op: str = "config.patch", changes: dict | None = None,
                 ttl_ms: int = 15_000) -> dict:
        state = json.loads(self.COMMANDS["session"]["state"])
        return commands.build_command(
            op, command_id=command_id, sid=state["sid"], boot=state["boot"], base_rev=state["cfg"],
            issued_ms=int(time.time() * 1000), ttl_ms=ttl_ms,
            changes=commands.validate_patch_changes(changes or {"gain_db": 20.7}) if op == "config.patch" else None,
        )

    def _edge_ack(self, command_id: str, status: str, result: dict | None = None) -> dict:
        state = json.loads(self.COMMANDS["session"]["state"])
        return {"v": 2, "sid": state["sid"], "id": command_id, "status": status, "t": int(time.time() * 1000),
                "rev": state["cfg"], "result": result or {}}

    def test_publish_rdf_node_command_publishes_once_at_qos1_without_retain(self) -> None:
        self._connected()
        self.assertEqual(self.client.on_publish, self.monitor._on_publish)
        command = self._command()
        result = self.monitor.publish_rdf_node_command(command)

        self.assertEqual(len(self.client.publish_calls), 1)
        (topic, raw), options = self.client.publish_calls[0]
        self.assertEqual(topic, f"sdr/v2/{NODE}/cmd/config/patch")
        self.assertEqual(raw, commands.encode_command(command))
        self.assertEqual(options["qos"], 1)
        self.assertIs(options["retain"], False)
        # The broker drops the command after its lifetime even if paho replays it.
        self.assertEqual(options["properties"].MessageExpiryInterval, 15)
        # The fake returns None like a paho without MQTTMessageInfo: rc 0, no mid.
        self.assertEqual((result["rc"], result["mid"], result["topic"]), (0, None, topic))
        observation = self.monitor.rdf_node_command_observation(command["id"])
        self.assertEqual(observation, {
            "published": True, "adopted": False, "puback": None, "progress": None, "final": None, "reported_at_ms": None,
        })
        # The Message Monitor snapshot keeps saying the monitor never publishes on its own.
        snapshot = self.monitor.snapshot()
        self.assertIs(snapshot["read_only"], True)
        self.assertIs(snapshot["publish_enabled"], False)

        with self.assertRaises(Exception) as repeated:
            self.monitor.publish_rdf_node_command(command)
        self.assertEqual(getattr(repeated.exception, "code", None), "MQTT_PUBLISH_FAILED")
        self.monitor.publish_rdf_node_command(self._command("gc-get-1", op="config.get"))
        self.assertEqual(self.client.publish_calls[1][0][0], f"sdr/v2/{NODE}/cmd/config/get")
        self.assertEqual(len(self.client.publish_calls), 2)

    def test_publish_refuses_a_command_the_edge_would_refuse(self) -> None:
        self._connected()
        good = self._command()
        for bad in (
            dict(good, expires_ms=good["issued_ms"] + 30_001),
            dict(good, sid=None),
            dict(good, base_rev=None),
            dict(good, changes={"center_frequency_hz": 434_000_000}),
            dict(good, op="stream.set"),
            dict(good, extra=1),
        ):
            with self.subTest(command=bad), self.assertRaises(Exception) as raised:
                self.monitor.publish_rdf_node_command(bad)
            self.assertEqual(getattr(raised.exception, "code", None), "MQTT_PUBLISH_FAILED")
        self.assertEqual(self.client.publish_calls, [])

    def test_publish_requires_a_ready_connection(self) -> None:
        command = self._command()
        with self.assertRaises(Exception) as before_start:
            self.monitor.publish_rdf_node_command(command)
        self.assertEqual(getattr(before_start.exception, "code", None), "MQTT_NOT_CONNECTED")

        self.client = self._start()
        self.client.on_connect(self.client, None, {}, types.SimpleNamespace(value=0, is_failure=False), None)
        with self.assertRaises(Exception) as before_suback:
            self.monitor.publish_rdf_node_command(command)
        self.assertEqual(getattr(before_suback.exception, "code", None), "MQTT_NOT_CONNECTED")

        self.acknowledge()
        self.client.on_disconnect(self.client, None, None, types.SimpleNamespace(value=0), None)
        with self.assertRaises(Exception) as after_disconnect:
            self.monitor.publish_rdf_node_command(command)
        self.assertEqual(getattr(after_disconnect.exception, "code", None), "MQTT_NOT_CONNECTED")
        self.assertEqual(self.client.publish_calls, [])

    def test_puback_is_correlated_even_when_it_beats_the_publish_return(self) -> None:
        self._connected()
        self.client.publish_rc = 0
        result = self.monitor.publish_rdf_node_command(self._command("gc-first"))
        self.assertIsInstance(result["mid"], int)
        self.assertIsNone(self.monitor.rdf_node_command_observation("gc-first")["puback"])
        self.client.on_publish(self.client, None, result["mid"], types.SimpleNamespace(value=0), None)
        self.assertEqual(self.monitor.rdf_node_command_observation("gc-first")["puback"]["reason"], 0)

        # The PUBACK arrives on paho's thread before publish() has returned.
        self.client.publish_hook = lambda mid: self.client.on_publish(
            self.client, None, mid, types.SimpleNamespace(value=135, is_failure=True), None,
        )
        self.monitor.publish_rdf_node_command(self._command("gc-second"))
        self.assertEqual(self.monitor.rdf_node_command_observation("gc-second")["puback"]["reason"], 135)
        # A PUBACK from a retired client is ignored.
        other = self.Client("retired")
        self.monitor._on_publish(other, None, result["mid"], types.SimpleNamespace(value=0), None)
        self.assertEqual(self.monitor._early_pubacks, {})

    def test_publish_without_connection_is_withdrawn_from_the_paho_queue(self) -> None:
        self._connected()
        self.client.publish_rc = self.module.mqtt.MQTT_ERR_NO_CONN
        with self.assertRaises(Exception) as raised:
            self.monitor.publish_rdf_node_command(self._command("gc-raced"))
        self.assertEqual(getattr(raised.exception, "code", None), "MQTT_NOT_CONNECTED")
        # Nothing stays queued for a replay after the next reconnect.
        self.assertEqual(self.client._out_messages, {})
        self.assertIs(self.monitor.rdf_node_command_observation("gc-raced")["published"], False)

    def test_acks_of_published_commands_are_kept_by_id_and_bounded(self) -> None:
        self._connected()
        self._node_state()
        self.monitor.publish_rdf_node_command(self._command("gc-ours"))
        # ACKs of commands this client did not send (rdf-ground.service, say) are not followed.
        self._rdf("ack/config", self._edge_ack("ground-0123456789abcdef0123", "APPLIED"))
        self.assertNotIn("ground-0123456789abcdef0123", self.monitor._commands)
        self._rdf("ack/config", self._edge_ack("gc-ours", "ACCEPTED"))
        observed = self.monitor.rdf_node_command_observation("gc-ours")
        self.assertEqual((observed["progress"]["status"], observed["final"]), ("ACCEPTED", None))
        self._rdf("ack/config", self._edge_ack("gc-ours", "PERSISTED_UNVERIFIED", {
            "revision": 3, "persisted": True, "proof": {}, "reason": "NATIVE_RUNTIME_EVIDENCE_INCOMPLETE"}))
        final = self.monitor.rdf_node_command_observation("gc-ours")["final"]
        self.assertEqual((final["status"], final["result"]["reason"]), ("PERSISTED_UNVERIFIED", "NATIVE_RUNTIME_EVIDENCE_INCOMPLETE"))
        self.assertIsInstance(final["received_at_ms"], int)
        # A later ACK for the same id never replaces the final answer.
        self._rdf("ack/config", self._edge_ack("gc-ours", "APPLIED"))
        self.assertEqual(self.monitor.rdf_node_command_observation("gc-ours")["final"]["status"], "PERSISTED_UNVERIFIED")
        # An ACK of another node session is not counted.
        foreign = dict(self._edge_ack("gc-ours", "FAILED"), sid="0badc0de")
        self.monitor.publish_rdf_node_command(self._command("gc-other"))
        self._rdf("ack/config", dict(foreign, id="gc-other"))
        self.assertIsNone(self.monitor.rdf_node_command_observation("gc-other")["final"])

        for index in range(self.module.MAX_COMMAND_RECORDS + 3):
            self.monitor.publish_rdf_node_command(self._command(f"gc-bulk-{index}"))
        self.assertEqual(len(self.monitor._commands), self.module.MAX_COMMAND_RECORDS)
        self.assertIs(self.monitor.rdf_node_command_observation("gc-ours")["published"], False)

    def test_config_get_accepts_only_its_own_settings_report(self) -> None:
        self._connected()
        case = next(item for item in self.COMMANDS["cases"] if item["name"] == "config-get")
        report = json.loads(case["edge"]["settings_reported"])
        clock = [report["t"]]
        with patch.object(self.module, "_now_ms", lambda: clock[0]):
            state = self._node_state()
            # Unrequested: the store ignores it.
            self._rdf("settings/reported", dict(report, id="gc-get-1"))
            self.assertIsNone(self.monitor.rdf_node_control_view()["settings"])
            command = commands.build_command(
                "config.get", command_id="gc-get-1", sid=state["sid"], boot=state["boot"], base_rev=state["cfg"],
                issued_ms=clock[0],
            )
            self.monitor.publish_rdf_node_command(command)
            self._rdf("ack/config", self._edge_ack("gc-get-1", "APPLIED", {"revision": state["cfg"], "proof": "source_correlated"}))
            self._rdf("settings/reported", dict(report, id="gc-get-1"))
            view = self.monitor.rdf_node_control_view()
        observed = self.monitor.rdf_node_command_observation("gc-get-1")
        self.assertEqual((observed["final"]["status"], observed["reported_at_ms"]), ("APPLIED", clock[0]))
        self.assertEqual(view["connection"], "connected")
        self.assertEqual(view["node_id"], NODE)
        self.assertEqual((view["session"]["sid"], view["session"]["cfg"]), (state["sid"], state["cfg"]))
        self.assertEqual(view["settings"]["id"], "gc-get-1")
        self.assertIs(view["settings"]["matches_state_cfg"], True)
        self.assertEqual(view["settings"]["safe_settings"]["vfo0_frequency_hz"], 433_920_000)
        self.assertEqual(view["settings"]["settings_json"], report["settings_json"])

    def test_a_replacement_monitor_follows_the_pending_commands(self) -> None:
        # Reconnect or an MQTT settings save replaces the monitor while a patch
        # and a config.get wait. Their ACKs and the settings report reach only
        # the new client, so the server hands the pending ids over first.
        from config_command_tracker import ConfigCommandTracker

        case = next(item for item in self.COMMANDS["cases"] if item["name"] == "config-get")
        report = json.loads(case["edge"]["settings_reported"])
        clock = [report["t"]]
        tracker = ConfigCommandTracker(clock_ms=lambda: clock[0])
        with patch.object(self.module, "_now_ms", lambda: clock[0]):
            self._connected()
            state = self._node_state()
            session = {"sid": state["sid"], "boot": state["boot"], "base_rev": state["cfg"], "issued_ms": clock[0]}
            patch_command = commands.build_command(
                "config.patch", command_id="gc-restart-1", changes=commands.validate_patch_changes({"gain_db": 20.7}),
                **session,
            )
            get_command = commands.build_command("config.get", command_id="gc-restart-get", **session)
            done_command = commands.build_command(
                "config.patch", command_id="gc-restart-done", changes=commands.validate_patch_changes({"gain_db": 15.7}),
                **session,
            )
            for command in (patch_command, get_command, done_command):
                self.monitor.publish_rdf_node_command(command)
                tracker.record(command, self.monitor, published_at_ms=clock[0])
            self._rdf("ack/config", self._edge_ack("gc-restart-done", "APPLIED"))
            self.assertEqual(tracker.status("gc-restart-done", self.monitor)["state"], "acked")

            replacement = self.module.MqttMonitor("10.90.0.1", 9001, transport="websockets", ws_path="/mqtt")
            # Only the two commands that are not final move over.
            self.assertEqual(tracker.hand_over(self.monitor, replacement), 2)
            self.assertEqual(tracker.hand_over(self.monitor, replacement), 0)
            self.assertEqual(
                {key: replacement.rdf_node_command_observation(key)["adopted"] for key in
                 ("gc-restart-1", "gc-restart-get", "gc-restart-done")},
                {"gc-restart-1": True, "gc-restart-get": True, "gc-restart-done": False},
            )
            retired, self.monitor = self.monitor, replacement
            self._connected()
            retired.stop()
            # The new client's first state of the same session keeps the
            # adopted settings request.
            self._node_state()
            self._rdf("ack/config", self._edge_ack("gc-restart-1", "ACCEPTED"))
            waiting = tracker.status("gc-restart-1", replacement)
            self.assertEqual((waiting["state"], waiting["monitor_restarted"], waiting["ack"]["status"]),
                             ("acknowledged", True, "ACCEPTED"))
            self._rdf("ack/config", self._edge_ack("gc-restart-1", "APPLIED", {"revision": 43, "persisted": True}))
            self._rdf("ack/config", self._edge_ack("gc-restart-get", "APPLIED", {"revision": state["cfg"], "proof": "runtime"}))
            self._rdf("settings/reported", dict(report, id="gc-restart-get"))
            applied = tracker.status("gc-restart-1", replacement)
            reported = tracker.status("gc-restart-get", replacement)
            view = replacement.rdf_node_control_view()
        self.assertEqual((applied["state"], applied["ack"]["status"], applied["ack"]["revision"]), ("acked", "APPLIED", 43))
        self.assertEqual((reported["state"], reported["settings_reported_at_ms"]), ("reported", clock[0]))
        self.assertEqual(view["settings"]["id"], "gc-restart-get")
        # The replacement never published anything itself.
        self.assertEqual(self.client.publish_calls, [])
        observed = replacement.rdf_node_command_observation("gc-restart-1")
        self.assertEqual((observed["published"], observed["adopted"], observed["puback"]), (False, True, None))

    def test_adopting_takes_what_the_store_already_accepted(self) -> None:
        self._connected()
        self._node_state()
        # The edge answered before the hand-over reached this monitor.
        self._rdf("ack/config", self._edge_ack("gc-early", "REJECTED", {"error": "CONFIG_REVISION_CONFLICT"}))
        self.assertIsNone(self.monitor.rdf_node_command_observation("gc-early")["final"])
        taken = self.monitor.adopt_rdf_node_commands([
            {"command_id": "gc-early", "op": "config.patch", "sid": "7a8b9c0d"},
            {"command_id": "bad id", "op": "config.patch", "sid": None},
            {"command_id": "gc-op", "op": "stream.set", "sid": None},
            "not a mapping",
        ])
        self.assertEqual(taken, 1)
        final = self.monitor.rdf_node_command_observation("gc-early")["final"]
        self.assertEqual((final["status"], final["result"]["error"]), ("REJECTED", "CONFIG_REVISION_CONFLICT"))
        self.assertEqual(self.monitor.adopt_rdf_node_commands([{"command_id": "gc-early", "op": "config.patch"}]), 0)
        self.assertEqual(self.client.publish_calls, [])

    def test_control_view_follows_the_connection_and_the_session(self) -> None:
        self.assertEqual(self.monitor.rdf_node_control_view()["connection"], "disabled")
        self._connected()
        view = self.monitor.rdf_node_control_view()
        self.assertEqual((view["available"], view["connection"]), (True, "connected"))
        self.assertIs(view["session"]["known"], False)
        self.assertIsNone(view["settings"])
        state = self._node_state()
        capabilities = json.loads((TOOLS_DIR / "fixtures" / "rdf-node" / "capabilities.json").read_text(encoding="utf-8"))
        # Capabilities of another session are not the node's.
        self._rdf("capabilities", capabilities, retained=True)
        self.assertIsNone(self.monitor.rdf_node_control_view()["session"]["capabilities"])
        self._rdf("capabilities", dict(capabilities, sid=state["sid"], boot=state["boot"]), retained=True)
        self.assertEqual(
            self.monitor.rdf_node_control_view()["session"]["capabilities"],
            {"remote_commands": capabilities["remote_commands"], "remote_config_patch": capabilities["remote_config_patch"],
             "config_patch": capabilities["config_patch"]},
        )

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
        view = self.monitor.rdf_node_control_view()
        self.assertIs(view["session"]["known"], False)
        self.assertIsNone(view["settings"])
        snapshot = self.monitor.rdf_node_snapshot()
        self.assertEqual((snapshot["received"], snapshot["invalid"]), (0, 0))
        self.assertNotIn("config/reported", snapshot["topics"])
        self.assertIsNone(snapshot["node"]["session"])
        self.assertEqual(self.client.publish_calls, [])


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
