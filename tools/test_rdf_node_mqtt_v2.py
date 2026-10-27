"""Contract tests for the RDF Node MQTT parser (docs/MQTT_KONTRAK.md).

Real payloads come from tools/fixtures/rdf-node/, written by the edge's own
agent at commit 8691ad0 (and 20713ff for the PPP detail fields). Variations of
them check each rule, and hostile payloads check that nothing but a status
comes out of a bad message.
"""
from __future__ import annotations

import copy
import json
import random
import struct
import unittest
from pathlib import Path
from typing import Any, Dict, Optional, Union
from unittest.mock import patch

from tools import rdf_node_mqtt_v2
from tools.rdf_node_mqtt_v2 import (
    ACK_FINAL_STATUSES,
    ACK_STATUSES,
    MAX_PAYLOAD_BYTES,
    RDF_NODE_V2_SUFFIXES,
    RdfNodeV2Telemetry,
)

NODE = "uav-01"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "rdf-node"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
BY_FILE = {entry["file"]: entry for entry in MANIFEST["fixtures"]}
# The fixtures were written within a second, just before this time.
NOW = MANIFEST["generated_at_ms"]
POLICY = {
    "state": (1, True), "capabilities": (1, True), "availability": (1, True),
    "telemetry/health": (0, False), "telemetry/health/detail": (0, False), "telemetry/doa": (0, False),
    "telemetry/diagnostic/doa": (0, False), "telemetry/angular": (0, False),
    "telemetry/diagnostic/angular": (0, False), "settings/reported": (1, False),
    "ack/config": (1, False), "ack/operation": (1, False),
}
# A healthy edge, in the order a console sees it after subscribing.
HEALTHY_SEQUENCE = (
    "state.json", "capabilities.json", "availability.online.json", "telemetry-health.json",
    "telemetry-health-detail.json", "telemetry-doa.ok1.json", "telemetry-diagnostic-doa.json",
    "telemetry-diagnostic-angular.wait-stable.json", "telemetry-angular.live.json",
)


def raw(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def obj(name: str, **changes: Any) -> Dict[str, Any]:
    value = json.loads(raw(name))
    value.update(changes)
    return value


def encode(value: Union[Dict[str, Any], bytes]) -> bytes:
    if isinstance(value, bytes):
        return value
    return json.dumps(value, separators=(",", ":"), allow_nan=True).encode("utf-8")


def put(store: RdfNodeV2Telemetry, suffix: str, value: Union[Dict[str, Any], bytes], *, at: int = NOW,
        qos: Optional[int] = None, retained: Optional[bool] = None, expiry: Optional[int] = None) -> Dict[str, Any]:
    policy_qos, policy_retained = POLICY[suffix]
    store.ingest(f"sdr/v2/{NODE}/{suffix}", encode(value), qos=policy_qos if qos is None else qos,
                 retained=policy_retained if retained is None else retained, received_at_ms=at,
                 message_expiry_s=expiry)
    return store.snapshot(at)["topics"][suffix]


def feed(store: RdfNodeV2Telemetry, name: str, *, at: int = NOW) -> Dict[str, Any]:
    meta = BY_FILE[name]
    store.ingest(f"sdr/v2/{NODE}/{meta['topic']}", raw(name), qos=meta["qos"], retained=meta["retain"],
                 received_at_ms=at, message_expiry_s=meta["expiry_s"])
    return store.snapshot(at)["topics"][meta["topic"]]


def topic(store: RdfNodeV2Telemetry, suffix: str, at: int = NOW) -> Dict[str, Any]:
    return store.snapshot(at)["topics"][suffix]


def node(store: RdfNodeV2Telemetry, at: int = NOW) -> Dict[str, Any]:
    return store.snapshot(at)["node"]


def session_store(*, health: bool = True, at: int = NOW, **health_changes: Any) -> RdfNodeV2Telemetry:
    """A store that has the fixture session and, by default, one fresh health message."""
    store = RdfNodeV2Telemetry(NODE)
    feed(store, "state.json", at=at)
    if health:
        put(store, "telemetry/health", obj("telemetry-health.json", t=at, **health_changes), at=at)
    return store


SID = obj("state.json")["sid"]
BOOT = obj("state.json")["boot"]
CFG = obj("state.json")["cfg"]
API_SNAPSHOT = FIXTURES / "api-snapshot.json"


def api_snapshot() -> Dict[str, Any]:
    """GET /api/mqtt/rdf-node after a healthy edge sent every topic once (lib/mqttMonitor.test.ts reads it)."""
    store = RdfNodeV2Telemetry(NODE)
    for name in HEALTHY_SEQUENCE:
        feed(store, name)
    store.expect_settings_report(obj("settings-reported.json")["id"], NOW)
    for name in ("ack-config.config-get-applied.json", "settings-reported.json", "telemetry-doa.ok0.json",
                 "telemetry-diagnostic-doa.degraded.json", "ack-operation.stream-set-accepted.json",
                 "ack-operation.stream-set-applied.json", "ack-operation.service-restart-unknown.json"):
        feed(store, name)
    snapshot = store.snapshot(NOW + 400)
    snapshot.update(enabled=True, connection="ready", node_id=NODE, last_error=None)
    return snapshot


def write_api_snapshot() -> None:
    """Rewrite api-snapshot.json after a deliberate change of the snapshot shape."""
    API_SNAPSHOT.write_text(json.dumps(api_snapshot(), indent=1, sort_keys=True) + "\n", encoding="utf-8")


class FixtureTests(unittest.TestCase):
    """The edge's own payloads, as published by release 1.0.0-20261013194717."""

    def test_manifest_names_the_edge_commit_and_covers_every_topic(self) -> None:
        self.assertEqual(MANIFEST["edge_commit"], "8691ad0")
        self.assertEqual({entry["topic"] for entry in MANIFEST["fixtures"]}, set(RDF_NODE_V2_SUFFIXES))
        for entry in MANIFEST["fixtures"]:
            with self.subTest(file=entry["file"]):
                self.assertTrue((FIXTURES / entry["file"]).is_file())
                self.assertEqual((entry["qos"], entry["retain"]), POLICY[entry["topic"]])
                self.assertLessEqual(len(raw(entry["file"])), MAX_PAYLOAD_BYTES)
                self.assertIn(entry["edge_commit"], ("8691ad0", "20713ff"))
        self.assertEqual(len(RDF_NODE_V2_SUFFIXES), 12)
        self.assertNotIn("config/reported", RDF_NODE_V2_SUFFIXES)

    def test_a_healthy_edge_leaves_no_topic_invalid(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        for name in HEALTHY_SEQUENCE:
            feed(store, name)
        ack = obj("ack-config.config-get-applied.json")
        store.expect_settings_report(ack["id"], NOW)
        for name in ("ack-config.config-get-applied.json", "settings-reported.json", "telemetry-doa.ok0.json",
                     "telemetry-angular.unverified.json", "ack-config.config-patch-rejected.json",
                     "ack-operation.stream-set-accepted.json", "ack-operation.stream-set-applied.json",
                     "ack-operation.operation-get.json", "ack-operation.service-restart-unknown.json",
                     "ack-operation.reboot-prepare-applied.json", "ack-operation.ppp-restart-requested.json",
                     "telemetry-diagnostic-doa.degraded.json", "telemetry-diagnostic-angular.json"):
            feed(store, name)
        snapshot = store.snapshot(NOW)
        self.assertEqual((snapshot["invalid"], snapshot["valid"]), (0, snapshot["received"]))
        statuses = {suffix: entry["status"] for suffix, entry in snapshot["topics"].items()}
        self.assertNotIn("INVALID", statuses.values())
        self.assertEqual(statuses, {
            "state": "CONTEXT", "capabilities": "CONTEXT", "availability": "CONTEXT",
            "telemetry/health": "FRESH", "telemetry/health/detail": "FRESH",
            "telemetry/doa": "UNVERIFIED", "telemetry/diagnostic/doa": "UNVERIFIED",
            "telemetry/angular": "UNVERIFIED", "telemetry/diagnostic/angular": "UNVERIFIED",
            "settings/reported": "FRESH", "ack/config": "FRESH", "ack/operation": "FRESH",
        })
        json.dumps(snapshot, allow_nan=False)

    def test_live_doa_and_angular_from_the_edge(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        for name in HEALTHY_SEQUENCE:
            feed(store, name)
        self.assertEqual(topic(store, "telemetry/doa")["status"], "LIVE")
        self.assertEqual(topic(store, "telemetry/angular")["status"], "LIVE")
        view = node(store)
        self.assertTrue(view["doa"]["live"])
        self.assertEqual(view["doa"]["reasons"], [])
        self.assertEqual((view["doa"]["a"], view["doa"]["ok"], view["doa"]["f"]), (160.0, 1, 433920000))
        frame = obj("telemetry-angular.live.json")
        self.assertTrue(view["angular"]["live"])
        self.assertEqual(view["angular"]["values"], frame["values"])
        self.assertEqual((view["angular"]["flags"], view["angular"]["peak_index"]), (63, 200))
        # The topic entry shows the frame's metadata, never its 360 values.
        shown = topic(store, "telemetry/angular")["payload"]
        self.assertNotIn("values", shown)
        self.assertEqual(shown["values_count"], 360)
        # The wait-stable candidate carried flags 63, yet it stays UNVERIFIED.
        self.assertEqual(view["angular_unverified"]["topic"], "telemetry/diagnostic/angular")
        self.assertEqual(view["angular_unverified"]["trust"], "UNVERIFIED")
        session = store.session_view(NOW)
        self.assertEqual((session["sid"], session["boot"], session["cfg"]), (SID, BOOT, CFG))
        self.assertTrue(session["health_fresh"])
        self.assertEqual(session["health_daq"], 1)

    def test_trust_only_payloads_never_become_live(self) -> None:
        store = session_store()
        entry = feed(store, "telemetry-doa.ok0.json")
        self.assertEqual((entry["status"], entry["error"]), ("UNVERIFIED", None))
        entry = feed(store, "telemetry-angular.unverified.json")
        self.assertEqual(entry["status"], "UNVERIFIED")
        view = node(store)
        self.assertIsNone(view["doa"])
        self.assertIsNone(view["angular"])
        self.assertEqual(view["doa_unverified"]["a"], 200.0)
        self.assertEqual(view["doa_unverified"]["angle_reference"], "RAW")
        self.assertEqual(view["doa_unverified"]["validation_reasons"], ["SOURCE_UNVERIFIED", "ANGLE_UNVERIFIED"])
        unverified = view["angular_unverified"]
        self.assertEqual((unverified["topic"], unverified["flags"]), ("telemetry/angular", 23))
        self.assertIn("SOURCE_AUTHORITY_UNVERIFIED_AT_EDGE", unverified["validation_reasons"])
        self.assertIn("ANGLE_UNVERIFIED_AT_EDGE", unverified["validation_reasons"])

    def test_diagnostic_topics_stay_apart_and_unverified(self) -> None:
        store = session_store()
        for name in ("telemetry-diagnostic-doa.json", "telemetry-diagnostic-doa.degraded.json"):
            self.assertEqual(feed(store, name)["status"], "UNVERIFIED")
        entry = feed(store, "telemetry-diagnostic-angular.json")
        self.assertEqual(entry["status"], "UNVERIFIED")
        view = node(store)
        self.assertIsNone(view["doa"])
        self.assertIsNone(view["angular"])
        self.assertEqual(view["diagnostic_doa"]["validation_reasons"], ["DIAGNOSTIC_UNVERIFIED", "DAQ_NOT_HEALTHY"])
        self.assertEqual(view["diagnostic_doa"]["source"], "doa.xml")
        self.assertEqual(view["angular_unverified"]["flags"], 59)
        self.assertIn("DAQ_NOT_HEALTHY_AT_EDGE", view["angular_unverified"]["validation_reasons"])
        self.assertEqual(len(view["angular_unverified"]["values"]), 360)

    def test_capabilities_without_maintenance_keep_the_booleans_as_published(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        entry = feed(store, "capabilities.json")
        self.assertEqual(entry["status"], "CONTEXT")
        published = obj("capabilities.json")
        self.assertNotIn("maintenance", published)
        self.assertNotIn("t", published)
        self.assertEqual(entry["payload"], published)
        self.assertIsNone(node(store)["capabilities"]["session_match"])
        feed(store, "state.json")
        self.assertIs(node(store)["capabilities"]["session_match"], True)
        # An older edge's maintenance flag is still read when it is a boolean.
        self.assertEqual(put(store, "capabilities", obj("capabilities.json", maintenance=False))["status"], "CONTEXT")
        for change in ({"maintenance": "no"}, {"remote_ppp_restart": 1}, {"codecs": "json"}):
            with self.subTest(change=change):
                self.assertEqual(put(store, "capabilities", obj("capabilities.json", **change))["status"], "INVALID")
        missing = obj("capabilities.json")
        del missing["remote_shutdown"]
        entry = put(store, "capabilities", missing)
        self.assertEqual((entry["status"], entry["error"], entry["field"]), ("INVALID", "MISSING_FIELD", "remote_shutdown"))

    def test_availability_and_its_last_will(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        self.assertEqual(feed(store, "availability.online.json")["status"], "CONTEXT")
        entry = feed(store, "availability.offline-will.json")
        self.assertEqual(entry["status"], "CONTEXT")
        self.assertEqual(entry["payload"], {"v": 2, "sid": obj("availability.online.json")["sid"], "online": False,
                                            "reason": "CONNECTION_LOST"})
        online = obj("availability.online.json")
        del online["t"]
        self.assertEqual(put(store, "availability", online)["status"], "INVALID")

    def test_newer_edge_detail_with_ppp_fields(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        feed(store, "state.ppp-session.json")
        entry = feed(store, "telemetry-health-detail.ppp.json")
        self.assertEqual(entry["status"], "FRESH")
        detail = node(store)["detail"]
        self.assertEqual((detail["ppp"], detail["peer"], detail["ppp_svc"], detail["ppp_restarts"]), ("UP", "REPLY", "ACTIVE", 0))
        self.assertEqual(put(store, "telemetry/health/detail", obj("telemetry-health-detail.ppp.json", ppp=None))["status"], "FRESH")
        for change in ({"ppp": "up"}, {"ppp_restarts": -1}, {"peer": 5}):
            with self.subTest(change=change):
                self.assertEqual(put(store, "telemetry/health/detail", obj("telemetry-health-detail.ppp.json", **change))["status"], "INVALID")
        # The detail of 8691ad0 has none of them.
        store = RdfNodeV2Telemetry(NODE)
        feed(store, "state.json")
        self.assertEqual(feed(store, "telemetry-health-detail.json")["status"], "FRESH")
        self.assertNotIn("ppp", node(store)["detail"])

    def test_doa_angles_past_180_degrees_are_valid(self) -> None:
        # 2026-10-26: the console of v2.0.0 rejected telemetry/doa with
        # INVALID_FIELD because it allowed a in -180..180 only; the edge sends
        # 0..360 (a RAW 200 degree angle with ok=0, theta_mirror with ok=1).
        store = session_store()
        self.assertEqual(feed(store, "telemetry-doa.ok0.json")["status"], "UNVERIFIED")
        for q, angle in ((50, 260.0), (51, 359.99), (52, 0.0), (53, 360.0)):
            with self.subTest(angle=angle):
                entry = put(store, "telemetry/doa", obj("telemetry-doa.ok1.json", q=q, t=NOW, a=angle))
                self.assertEqual(entry["status"], "LIVE")
        entry = put(store, "telemetry/doa", obj("telemetry-doa.ok1.json", q=54, t=NOW, a=360.01))
        self.assertEqual((entry["status"], entry["error"], entry["field"]), ("INVALID", "INVALID_FIELD", "a"))
        self.assertEqual(put(store, "telemetry/doa", obj("telemetry-doa.ok1.json", q=55, t=NOW, rev=None))["status"], "LIVE")


class SessionTests(unittest.TestCase):
    def test_telemetry_before_state_is_ignored(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        for name in ("telemetry-health.json", "telemetry-doa.ok1.json", "telemetry-angular.live.json",
                     "ack-config.config-get-applied.json", "telemetry-health-detail.json"):
            with self.subTest(name=name):
                entry = feed(store, name)
                self.assertEqual((entry["status"], entry["error"]), ("IGNORED", "NO_SESSION"))
        view = node(store)
        self.assertEqual((view["health"], view["doa"], view["angular"], view["acks"]), (None, None, None, []))
        self.assertFalse(store.session_view(NOW)["known"])
        self.assertEqual(store.snapshot(NOW)["invalid"], 0)

    def test_other_session_is_inconsistent(self) -> None:
        store = session_store()
        for suffix, name in (("telemetry/health", "telemetry-health.json"), ("telemetry/doa", "telemetry-doa.ok1.json"),
                             ("telemetry/angular", "telemetry-angular.live.json"), ("ack/operation", "ack-operation.stream-set-accepted.json")):
            with self.subTest(suffix=suffix):
                entry = put(store, suffix, obj(name, sid="01020304", q=99) if "q" in obj(name) else obj(name, sid="01020304"))
                self.assertEqual((entry["status"], entry["error"]), ("INCONSISTENT", "SESSION_MISMATCH"))
        feed(store, "capabilities.json")
        put(store, "capabilities", obj("capabilities.json", sid="01020304"))
        self.assertEqual(topic(store, "capabilities")["status"], "INCONSISTENT")
        self.assertIs(node(store)["capabilities"]["session_match"], False)

    def test_new_sid_drops_the_old_session(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        for name in HEALTHY_SEQUENCE:
            feed(store, name)
        command_id = "g01-request-1"
        store.expect_settings_report(command_id, NOW)
        new_state = obj("state.json", sid="0a0b0c0d", boot="boot-2", instance="instance-2", t=NOW)
        self.assertEqual(put(store, "state", new_state)["status"], "CONTEXT")
        view = node(store)
        for key in ("health", "detail", "doa", "doa_unverified", "diagnostic_doa", "angular", "angular_unverified", "settings"):
            self.assertIsNone(view[key], key)
        self.assertEqual(view["settings_requests"], [])
        self.assertEqual(view["session"]["sid"], "0a0b0c0d")
        for suffix in ("telemetry/health", "telemetry/doa", "telemetry/angular"):
            self.assertEqual(topic(store, suffix)["status"], "UNAVAILABLE")
        # Sequences start again in the new session.
        entry = put(store, "telemetry/health", obj("telemetry-health.json", sid="0a0b0c0d", q=1, t=NOW))
        self.assertEqual(entry["status"], "FRESH")

    def test_known_sid_with_another_identity_is_refused(self) -> None:
        store = session_store()
        for field in ("boot", "instance"):
            with self.subTest(field=field):
                entry = put(store, "state", obj("state.json", **{field: "someone-else"}))
                self.assertEqual((entry["status"], entry["error"]), ("INCONSISTENT", "SESSION_ALIAS_COLLISION"))
                self.assertEqual(store.session_view(NOW)["boot"], BOOT)
                self.assertTrue(node(store)["health"]["fresh"])

    def test_state_revision_change_keeps_the_session(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        for name in HEALTHY_SEQUENCE:
            feed(store, name)
        put(store, "state", obj("state.json", cfg=CFG + 1))
        view = node(store)
        self.assertTrue(view["doa"]["live"])
        self.assertTrue(view["angular"]["live"])
        self.assertEqual(store.session_view(NOW)["cfg"], CFG + 1)


class HealthTests(unittest.TestCase):
    def test_timestamp_window_at_receipt(self) -> None:
        for offset, status, error in ((-8000, "FRESH", None), (-8001, "STALE", "SOURCE_TIMESTAMP_NOT_FRESH"),
                                      (1000, "FRESH", None), (1001, "STALE", "SOURCE_TIME_FUTURE")):
            with self.subTest(offset=offset):
                store = session_store(health=False)
                entry = put(store, "telemetry/health", obj("telemetry-health.json", t=NOW + offset))
                self.assertEqual((entry["status"], entry["error"]), (status, error))
                self.assertEqual(node(store)["health"] is not None, status == "FRESH")

    def test_fresh_for_eight_seconds_after_receipt(self) -> None:
        store = session_store()
        self.assertEqual(topic(store, "telemetry/health", NOW + 8000)["status"], "FRESH")
        self.assertTrue(store.session_view(NOW + 8000)["health_fresh"])
        entry = topic(store, "telemetry/health", NOW + 8001)
        self.assertEqual((entry["status"], entry["error"]), ("STALE", "SOURCE_STALE"))
        self.assertFalse(node(store, NOW + 8001)["health"]["fresh"])

    def test_sequence_must_advance(self) -> None:
        store = session_store()
        for q in (1, 0):
            entry = put(store, "telemetry/health", obj("telemetry-health.json", q=q, t=NOW, daq=0))
            if q == 0:
                self.assertEqual((entry["status"], entry["field"]), ("INVALID", "q"))
            else:
                self.assertEqual((entry["status"], entry["error"]), ("IGNORED", "SEQUENCE_NOT_ADVANCING"))
        self.assertEqual(node(store)["health"]["daq"], 1)
        self.assertEqual(put(store, "telemetry/health", obj("telemetry-health.json", q=2, t=NOW))["status"], "FRESH")

    def test_fields(self) -> None:
        store = session_store()
        q = 10
        nulls = {"drop": None, "age": None, "temp": None, "rev": None}
        self.assertEqual(put(store, "telemetry/health", obj("telemetry-health.json", q=q, t=NOW, **nulls))["status"], "FRESH")
        for change in ({"daq": 3}, {"run": 5}, {"run": "1"}, {"clk": True}, {"drop": -1}, {"temp": 1e6},
                       {"q": True}, {"t": 1_000}, {"rev": 1.5}):
            q += 1
            with self.subTest(change=change):
                self.assertEqual(put(store, "telemetry/health", obj("telemetry-health.json", **{"q": q, "t": NOW, **change}))["status"], "INVALID")
        degraded = put(store, "telemetry/health", obj("telemetry-health.daq-degraded.json", q=q + 1, t=NOW))
        self.assertEqual(degraded["status"], "FRESH")
        self.assertEqual(store.session_view(NOW)["health_daq"], 0)

    def test_detail_is_fresh_for_fifteen_seconds_and_never_a_gate(self) -> None:
        store = session_store(health=False)
        feed(store, "telemetry-health-detail.json")
        self.assertEqual(topic(store, "telemetry/health/detail", NOW + 15000)["status"], "FRESH")
        self.assertEqual(topic(store, "telemetry/health/detail", NOW + 15001)["status"], "STALE")
        self.assertTrue(node(store, NOW + 15001)["detail"]["stale"])
        self.assertEqual(feed(store, "telemetry-doa.ok1.json")["error"], "DOA_WITHOUT_HEALTH")
        for change in ({"sync": [True, True]}, {"sync": None}, {"cpu": -0.1}, {"cpu": "50"}, {"mem": 101},
                       {"disk_free": -1}, {"adrop": None}, {"throt": 0}):
            with self.subTest(change=change):
                self.assertEqual(put(store, "telemetry/health/detail", obj("telemetry-health-detail.json", **change))["status"], "INVALID")
        # The edge's cpu has no clamp: an iowait counter that steps back on a
        # busy Pi gives a little over 100 (monitor.probe), still the edge's value.
        for cpu in (100.4, 0, None):
            with self.subTest(cpu=cpu):
                entry = put(store, "telemetry/health/detail", obj("telemetry-health-detail.json", t=NOW, cpu=cpu))
                self.assertEqual(entry["status"], "FRESH")
                self.assertEqual(node(store, NOW)["detail"]["cpu"], cpu)


class DoaTests(unittest.TestCase):
    def test_live_needs_a_fresh_source_and_fresh_healthy_health(self) -> None:
        for offset, status in ((-5000, "LIVE"), (-5001, "STALE"), (1000, "LIVE"), (1001, "STALE")):
            with self.subTest(offset=offset):
                store = session_store()
                self.assertEqual(put(store, "telemetry/doa", obj("telemetry-doa.ok1.json", t=NOW + offset))["status"], status)
        store = session_store(health=False)
        entry = put(store, "telemetry/doa", obj("telemetry-doa.ok1.json", t=NOW))
        self.assertEqual((entry["status"], entry["error"]), ("INCONSISTENT", "DOA_WITHOUT_HEALTH"))
        store = session_store(daq=0)
        self.assertEqual(put(store, "telemetry/doa", obj("telemetry-doa.ok1.json", t=NOW))["error"], "DOA_WITHOUT_HEALTH")
        store = session_store(daq=2)
        self.assertEqual(put(store, "telemetry/doa", obj("telemetry-doa.ok1.json", t=NOW))["error"], "DOA_WITHOUT_HEALTH")

    def test_revision_is_metadata_for_live(self) -> None:
        store = session_store()
        entry = put(store, "telemetry/doa", obj("telemetry-doa.ok1.json", t=NOW, rev=CFG + 5))
        self.assertEqual(entry["status"], "LIVE")
        self.assertTrue(node(store)["doa"]["live"])

    def test_live_ends_with_the_source_or_the_health(self) -> None:
        store = session_store()
        put(store, "telemetry/doa", obj("telemetry-doa.ok1.json", t=NOW))
        self.assertTrue(node(store, NOW + 5000)["doa"]["live"])
        stale = node(store, NOW + 5001)["doa"]
        self.assertEqual((stale["live"], stale["reasons"]), (False, ["SOURCE_STALE"]))
        self.assertEqual(topic(store, "telemetry/doa", NOW + 5001)["status"], "STALE")
        # Health turning degraded ends LIVE at once.
        put(store, "telemetry/health", obj("telemetry-health.json", q=2, t=NOW, daq=0))
        self.assertEqual(node(store)["doa"]["reasons"], ["DAQ_NOT_HEALTHY"])
        self.assertEqual(topic(store, "telemetry/doa")["error"], "DAQ_NOT_HEALTHY")

    def test_unverified_variant(self) -> None:
        store = session_store()
        self.assertEqual(feed(store, "telemetry-doa.ok0.json")["status"], "UNVERIFIED")
        entry = put(store, "telemetry/doa", obj("telemetry-doa.ok0.json", q=10, t=NOW, rev=CFG + 1))
        self.assertEqual((entry["status"], entry["error"]), ("INCONSISTENT", "REVISION_MISMATCH"))
        # Without a known state.cfg the revision cannot be compared.
        unknown = RdfNodeV2Telemetry(NODE)
        put(unknown, "state", obj("state.json", cfg=None))
        put(unknown, "telemetry/health", obj("telemetry-health.json", t=NOW))
        self.assertEqual(put(unknown, "telemetry/doa", obj("telemetry-doa.ok0.json", t=NOW, rev=77))["status"], "UNVERIFIED")
        bad = (
            {"trust": "VERIFIED"}, {"angle_reference": "RELATIVE"}, {"validation_reasons": []},
            {"validation_reasons": ["SOURCE_UNVERIFIED", "SOURCE_UNVERIFIED"]},
            {"validation_reasons": ["NO_FRESH_DOA"]}, {"validation_reasons": "SOURCE_UNVERIFIED"},
        )
        for q, change in enumerate(bad, start=20):
            with self.subTest(change=change):
                entry = put(store, "telemetry/doa", obj("telemetry-doa.ok0.json", q=q, t=NOW, **change))
                self.assertEqual((entry["status"], entry["error"]), ("INVALID", "BAD_UNVERIFIED_DOA"))
        self.assertEqual(put(store, "telemetry/doa", obj("telemetry-doa.ok1.json", t=NOW, ok=2))["status"], "INVALID")
        self.assertEqual(put(store, "telemetry/doa", obj("telemetry-doa.ok0.json", q=40, t=NOW))["status"], "UNVERIFIED")
        self.assertEqual(topic(store, "telemetry/doa", NOW + 5000)["status"], "UNVERIFIED")
        self.assertEqual(topic(store, "telemetry/doa", NOW + 5001)["status"], "STALE")
        self.assertTrue(node(store, NOW + 5001)["doa_unverified"]["stale"])

    def test_live_and_unverified_keep_their_own_sequences(self) -> None:
        store = session_store()
        ok1 = obj("telemetry-doa.ok1.json", t=NOW)
        ok0 = obj("telemetry-doa.ok0.json", t=NOW)
        self.assertEqual(put(store, "telemetry/doa", dict(ok1, q=5))["status"], "LIVE")
        self.assertEqual(put(store, "telemetry/doa", dict(ok0, q=3))["status"], "UNVERIFIED")
        self.assertEqual(put(store, "telemetry/doa", dict(ok1, q=5))["error"], "SEQUENCE_NOT_ADVANCING")
        self.assertEqual(put(store, "telemetry/doa", dict(ok0, q=3))["error"], "SEQUENCE_NOT_ADVANCING")

    def test_diagnostic_doa(self) -> None:
        store = session_store(health=False)
        feed(store, "telemetry-diagnostic-doa.json")
        later = obj("telemetry-diagnostic-doa.json", q=5)
        later["source_timestamp_ms"] -= 1
        entry = put(store, "telemetry/diagnostic/doa", later)
        self.assertEqual((entry["status"], entry["error"]), ("INCONSISTENT", "SOURCE_TIME_REGRESSED"))
        self.assertEqual(put(store, "telemetry/diagnostic/doa", obj("telemetry-diagnostic-doa.json", q=6))["status"], "UNVERIFIED")
        self.assertEqual(topic(store, "telemetry/diagnostic/doa", NOW + 5001)["status"], "STALE")
        for change in ({"validation_reasons": ["EMPTY_CSV"]}, {"source": "DOA_value.html"}, {"trust": "VERIFIED"},
                       {"frequency_mhz": 0}, {"validation_reasons": ["bad reason"]}):
            with self.subTest(change=change):
                self.assertEqual(put(store, "telemetry/diagnostic/doa", obj("telemetry-diagnostic-doa.json", q=9, **change))["status"], "INVALID")


class AngularTests(unittest.TestCase):
    def frame(self, name: str = "telemetry-angular.live.json", **changes: Any) -> Dict[str, Any]:
        return obj(name, **{"timestamp_ms": NOW, **changes})

    def test_flags_decide_live_unverified_or_reject(self) -> None:
        for flags, status in ((63, "LIVE"), (31, "UNVERIFIED"), (23, "UNVERIFIED"), (55, "UNVERIFIED")):
            with self.subTest(flags=flags):
                store = session_store()
                self.assertEqual(put(store, "telemetry/angular", self.frame(flags=flags))["status"], status)
                self.assertEqual(node(store)["angular"] is not None, status == "LIVE")
        for flags in (0, 27, 19, 59, 62):
            with self.subTest(flags=flags):
                store = session_store()
                entry = put(store, "telemetry/angular", self.frame(flags=flags))
                self.assertEqual((entry["status"], entry["error"]), ("INVALID", "ANGULAR_EVIDENCE_INCOMPLETE"))

    def test_source_age_window(self) -> None:
        for offset, status in ((-10000, "LIVE"), (-10001, "STALE"), (1000, "LIVE"), (1001, "STALE")):
            with self.subTest(offset=offset):
                store = session_store()
                self.assertEqual(put(store, "telemetry/angular", self.frame(timestamp_ms=NOW + offset))["status"], status)

    def test_live_needs_fresh_health_with_daq_and_ignores_revision(self) -> None:
        store = session_store(health=False)
        self.assertEqual(put(store, "telemetry/angular", self.frame())["error"], "ANGULAR_WITHOUT_HEALTH")
        store = session_store(daq=0)
        self.assertEqual(put(store, "telemetry/angular", self.frame())["error"], "ANGULAR_WITHOUT_HEALTH")
        store = session_store()
        self.assertEqual(put(store, "telemetry/angular", self.frame(revision=CFG + 9))["status"], "LIVE")
        self.assertEqual(put(store, "telemetry/angular", self.frame(revision=None, q=2))["status"], "LIVE")

    def test_live_ends_with_source_age_health_daq_or_processing(self) -> None:
        store = session_store()
        put(store, "telemetry/angular", self.frame())
        self.assertTrue(node(store, NOW + 8000)["angular"]["live"])
        self.assertEqual(node(store, NOW + 8001)["angular"]["reasons"], ["HEALTH_STALE"])
        self.assertEqual(node(store, NOW + 10001)["angular"]["reasons"], ["SOURCE_STALE", "HEALTH_STALE"])
        self.assertEqual(topic(store, "telemetry/angular", NOW + 10001)["status"], "STALE")
        put(store, "telemetry/health", obj("telemetry-health.json", q=2, t=NOW, run=0))
        self.assertEqual(node(store)["angular"]["reasons"], ["PROCESSING_NOT_RUNNING"])
        put(store, "telemetry/health", obj("telemetry-health.json", q=3, t=NOW, daq=0))
        self.assertEqual(node(store)["angular"]["reasons"], ["DAQ_NOT_HEALTHY"])

    def test_sequences(self) -> None:
        store = session_store()
        self.assertEqual(put(store, "telemetry/angular", self.frame(q=4))["status"], "LIVE")
        self.assertEqual(put(store, "telemetry/angular", self.frame(q=4))["error"], "SEQUENCE_NOT_ADVANCING")
        self.assertEqual(put(store, "telemetry/angular", self.frame(q=2, flags=23))["status"], "UNVERIFIED")
        self.assertEqual(put(store, "telemetry/diagnostic/angular", self.frame(q=1))["status"], "UNVERIFIED")
        self.assertEqual(put(store, "telemetry/diagnostic/angular", self.frame(q=1))["error"], "SEQUENCE_NOT_ADVANCING")

    def test_diagnostic_candidate_is_kept_when_stale(self) -> None:
        store = session_store()
        entry = put(store, "telemetry/diagnostic/angular", self.frame("telemetry-diagnostic-angular.json", timestamp_ms=NOW - 30_000))
        self.assertEqual((entry["status"], entry["error"]), ("STALE", "SOURCE_TIMESTAMP_NOT_FRESH"))
        candidate = node(store)["angular_unverified"]
        self.assertTrue(candidate["stale"])
        self.assertIn("SOURCE_STALE", candidate["validation_reasons"])
        self.assertIsNone(node(store)["angular"])
        put(store, "state", obj("state.json", cfg=CFG + 1))
        self.assertIn("PREVIOUS_CONFIG", node(store)["angular_unverified"]["validation_reasons"])
        # A candidate never needs health.
        store = session_store(health=False)
        self.assertEqual(put(store, "telemetry/diagnostic/angular", self.frame("telemetry-diagnostic-angular.json"))["status"], "UNVERIFIED")
        self.assertIn("HEALTH_STALE", node(store)["angular_unverified"]["validation_reasons"])

    def test_each_angular_topic_row_ages_by_its_own_frame(self) -> None:
        """Both topics share the candidate; a row whose frame lost it still turns STALE after 10 s."""

        def trust_only_every_4_s(store: RdfNodeV2Telemetry, first_q: int, until: int) -> None:
            for step in range(1, until // 4000 + 1):
                at = NOW + 4000 * step
                put(store, "telemetry/health", obj("telemetry-health.json", q=first_q + step, t=at), at=at)
                put(store, "telemetry/angular", self.frame("telemetry-angular.unverified.json", q=step, timestamp_ms=at), at=at)

        # Start-up: a diagnostic frame while Bulk waits for a stable link, then trust-only Bulk.
        store = session_store()
        put(store, "telemetry/diagnostic/angular", self.frame("telemetry-diagnostic-angular.wait-stable.json"))
        trust_only_every_4_s(store, 1, 60_000)
        self.assertEqual(node(store, NOW + 60_000)["angular_unverified"]["topic"], "telemetry/angular")
        self.assertEqual(topic(store, "telemetry/diagnostic/angular", NOW + 10_000)["status"], "UNVERIFIED")
        entry = topic(store, "telemetry/diagnostic/angular", NOW + 10_001)
        self.assertEqual((entry["status"], entry["error"]), ("STALE", "SOURCE_STALE"))
        entry = topic(store, "telemetry/diagnostic/angular", NOW + 60_000)
        self.assertEqual((entry["status"], entry["error"]), ("STALE", "SOURCE_STALE"))
        self.assertEqual(topic(store, "telemetry/angular", NOW + 60_000)["status"], "UNVERIFIED")
        # The reverse: trust-only Bulk, then only diagnostic frames once the DAQ turns unhealthy.
        store = session_store()
        put(store, "telemetry/angular", self.frame("telemetry-angular.unverified.json"))
        for step in range(1, 6):
            at = NOW + 6000 * step
            put(store, "telemetry/diagnostic/angular",
                self.frame("telemetry-diagnostic-angular.json", q=step, timestamp_ms=at), at=at)
        self.assertEqual(node(store, NOW + 30_000)["angular_unverified"]["topic"], "telemetry/diagnostic/angular")
        self.assertEqual(topic(store, "telemetry/angular", NOW + 10_000)["status"], "UNVERIFIED")
        entry = topic(store, "telemetry/angular", NOW + 30_000)
        self.assertEqual((entry["status"], entry["error"]), ("STALE", "SOURCE_STALE"))
        self.assertEqual(topic(store, "telemetry/diagnostic/angular", NOW + 30_000)["status"], "UNVERIFIED")
        self.assertEqual(topic(store, "telemetry/diagnostic/angular", NOW + 40_001)["status"], "STALE")

    def test_json_frame_shape(self) -> None:
        store = session_store()
        values = self.frame()["values"]
        cases = (
            ({"encoding": "q16"}, "BAD_ANGULAR_JSON"),
            ({"v": 1}, "BAD_ANGULAR_JSON"),
            ({"values": values[:359]}, "EXPECTED_360_SAMPLES"),
            ({"values": values + [0.0]}, "EXPECTED_360_SAMPLES"),
            ({"values": "AAAA"}, "EXPECTED_360_SAMPLES"),
            ({"values": values[:359] + [1e9]}, "INVALID_FIELD"),
            ({"values": values[:359] + [True]}, "INVALID_FIELD"),
            ({"values": values[:359] + ["1.0"]}, "INVALID_FIELD"),
            ({"sid": "7A8B9C0D"}, "INVALID_SESSION_ID"),
            ({"vfo": 16}, "INVALID_FIELD"),
            ({"revision": 0xFFFFFFFF}, "INVALID_FIELD"),
            ({"raw_doa_deg": 360.5}, "INVALID_FIELD"),
            ({"flags": 64}, "INVALID_FIELD"),
            ({"frequency_hz": 0}, "INVALID_FIELD"),
        )
        for change, error in cases:
            with self.subTest(change=str(change)[:40]):
                self.assertEqual(put(store, "telemetry/angular", self.frame(**change))["error"], error)
        missing = self.frame()
        del missing["confidence_native_db"]
        self.assertEqual(put(store, "telemetry/angular", missing)["error"], "MISSING_FIELD")

    def test_the_retired_binary_chunks_are_rejected(self) -> None:
        store = session_store()
        header = struct.pack("<4sBBHIIQIIBBHffHh", b"RDF2", 2, 1, 31, 0x7A8B9C0D, 1, NOW, 433920000, 1, 0, 1, 360, .01, 0.0, 13740, 827)
        chunk = struct.pack("<IIBBH", 0x7A8B9C0D, 1, 0, 2, len(header) + 720) + header + bytes(300)
        entry = put(store, "telemetry/angular", chunk)
        self.assertEqual((entry["status"], entry["error"]), ("INVALID", "MALFORMED_JSON"))


class SettingsReportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = session_store()
        self.report = obj("settings-reported.json")
        self.store.expect_settings_report(self.report["id"], NOW)

    def put(self, value: Union[Dict[str, Any], bytes], **options: Any) -> Dict[str, Any]:
        return put(self.store, "settings/reported", value, **options)

    def test_requested_report_keeps_the_exact_text_server_side(self) -> None:
        entry = self.put(self.report)
        self.assertEqual(entry["status"], "FRESH")
        self.assertNotIn("settings_json", entry["payload"])
        self.assertEqual(entry["payload"]["bytes"], len(self.report["settings_json"].encode("utf-8")))
        saved = self.store.settings_report()
        self.assertEqual(saved["settings_json"], self.report["settings_json"])
        self.assertEqual(saved["settings"], json.loads(self.report["settings_json"]))
        self.assertEqual((saved["rev"], saved["state_cfg"], saved["matches_state_cfg"]), (CFG, CFG, True))
        view = node(self.store)["settings"]
        self.assertEqual((view["id"], view["rev"], view["matches_state_cfg"]), (self.report["id"], CFG, True))
        self.assertEqual(saved["safe_settings"], view["safe_settings"])
        self.assertEqual(view["safe_settings"], {
            "center_frequency_hz": 433920000, "gain_db": 15.7, "vfo0_frequency_hz": 433920000,
            "vfo0_bandwidth_hz": 12500, "vfo0_squelch_db": -80, "ant_arrangement": "UCA", "doa_method": "MUSIC",
            "active_vfos": 1, "output_vfo": 0, "en_doa": True,
        })
        self.assertEqual(view["settings_requests"] if "settings_requests" in view else node(self.store)["settings_requests"], [])
        # The native text (station name, coordinates) never leaves the server.
        self.assertNotIn("fixture-station", json.dumps(self.store.snapshot(NOW)))
        # A second answer to the same request is not expected any more.
        self.assertEqual(self.put(self.report)["error"], "UNREQUESTED_SETTINGS_REPORT")

    def test_safe_settings_only_for_the_current_revision(self) -> None:
        put(self.store, "state", obj("state.json", cfg=CFG + 1))
        self.store.expect_settings_report(self.report["id"], NOW)
        self.assertEqual(self.put(self.report)["status"], "FRESH")
        view = node(self.store)["settings"]
        self.assertEqual((view["matches_state_cfg"], view["safe_settings"]), (False, {}))
        saved = self.store.settings_report()
        self.assertEqual(saved["settings_json"], self.report["settings_json"])
        self.assertEqual((saved["matches_state_cfg"], saved["state_cfg"], saved["safe_settings"]), (False, CFG + 1, {}))

    def test_a_later_revision_withdraws_the_safe_settings_on_every_read(self) -> None:
        self.assertEqual(self.put(self.report)["status"], "FRESH")
        self.assertEqual(self.store.settings_report()["safe_settings"]["center_frequency_hz"], 433920000)
        # Another ground or the edge panel patches the node: state.cfg moves on, the session stays.
        put(self.store, "state", obj("state.json", cfg=CFG + 1))
        saved = self.store.settings_report()
        self.assertEqual((saved["rev"], saved["state_cfg"], saved["matches_state_cfg"]), (CFG, CFG + 1, False))
        self.assertEqual(saved["safe_settings"], {})
        self.assertEqual(node(self.store)["settings"]["safe_settings"], {})
        # The report is current again once state.cfg is back at its revision.
        put(self.store, "state", obj("state.json", cfg=CFG))
        self.assertTrue(self.store.settings_report()["matches_state_cfg"])
        self.assertEqual(self.store.settings_report()["safe_settings"], node(self.store)["settings"]["safe_settings"])

    def test_only_a_pending_request_of_this_session_is_answered(self) -> None:
        other = RdfNodeV2Telemetry(NODE)
        feed(other, "state.json")
        self.assertEqual(put(other, "settings/reported", self.report)["error"], "UNREQUESTED_SETTINGS_REPORT")
        self.assertEqual(self.put(dict(self.report, boot="another-boot"))["error"], "SESSION_MISMATCH")
        self.assertEqual(self.put(dict(self.report, sid="01020304"))["error"], "SESSION_MISMATCH")
        self.assertEqual(self.put(dict(self.report, id="g01-not-asked"))["error"], "UNREQUESTED_SETTINGS_REPORT")
        self.assertEqual(self.put(dict(self.report, t=NOW - 30_001))["status"], "STALE")
        self.assertEqual(self.put(dict(self.report, t=NOW + 1_001))["error"], "SOURCE_TIME_FUTURE")
        self.assertIsNone(self.store.settings_report())

    def test_a_request_naming_its_session_survives_that_sessions_first_state(self) -> None:
        # A monitor that took over a pending config.get has seen no state yet.
        sid = obj("state.json")["sid"]
        fresh = RdfNodeV2Telemetry(NODE)
        fresh.expect_settings_report(self.report["id"], NOW, sid=sid)
        fresh.expect_settings_report("g01-unbound", NOW)
        fresh.expect_settings_report("g01-other", NOW, sid="01020304")
        feed(fresh, "state.json")
        self.assertEqual(node(fresh)["settings_requests"], [self.report["id"]])
        self.assertEqual(put(fresh, "settings/reported", self.report)["status"], "FRESH")
        # A new session still forgets it.
        fresh.expect_settings_report(self.report["id"], NOW, sid=sid)
        put(fresh, "state", obj("state.json", sid="01020304"))
        self.assertEqual(node(fresh)["settings_requests"], [])
        with self.assertRaises(ValueError):
            fresh.expect_settings_report(self.report["id"], NOW, sid="not-a-sid")

    def test_request_expires_or_ends_with_a_failed_ack(self) -> None:
        late = NOW + 60_001
        self.assertEqual(put(self.store, "settings/reported", self.report, at=late)["error"], "UNREQUESTED_SETTINGS_REPORT")
        store = session_store()
        store.expect_settings_report(self.report["id"], NOW)
        ack = obj("ack-config.config-get-applied.json", id=self.report["id"], status="REJECTED", result={"error": "TLS_REQUIRED_FOR_SETTINGS_REPORT"})
        put(store, "ack/config", ack)
        self.assertEqual(node(store)["settings_requests"], [])
        self.assertEqual(put(store, "settings/reported", self.report)["error"], "UNREQUESTED_SETTINGS_REPORT")
        with self.assertRaises(ValueError):
            store.expect_settings_report("bad id with spaces", NOW)
        for index in range(6):
            store.expect_settings_report(f"g01-{index}", NOW)
        self.assertEqual(node(store)["settings_requests"], ["g01-2", "g01-3", "g01-4", "g01-5"])

    def test_shape(self) -> None:
        extra = dict(self.report, proof="x")
        self.assertEqual(self.put(extra)["error"], "BAD_SETTINGS_REPORT")
        missing = dict(self.report)
        del missing["boot"]
        self.assertEqual(self.put(missing)["error"], "BAD_SETTINGS_REPORT")
        for change, error in (({"settings_json": "[1,2]"}, "BAD_SETTINGS_JSON"), ({"settings_json": "{"}, "BAD_SETTINGS_JSON"),
                              ({"settings_json": '{"center_freq": NaN}'}, "BAD_SETTINGS_JSON"),
                              ({"settings_json": '{"a":1,"a":2}'}, "BAD_SETTINGS_JSON"),
                              ({"settings_json": '{"center_freq": "fast"}'}, "BAD_SETTINGS_JSON"),
                              ({"settings_json": {"center_freq": 1}}, "BAD_SETTINGS_JSON"),
                              ({"settings_json": "\ud800" + self.report["settings_json"]}, "BAD_SETTINGS_JSON"),
                              ({"settings_json": '{"station":"\\udc00"}'}, None),
                              ({"settings_json": '{"x":' + "[" * 15 + "]" * 15 + "}"}, None),
                              ({"settings_json": '{"x":' + "[" * 16 + "]" * 16 + "}"}, "BAD_SETTINGS_JSON"),
                              ({"settings_json": '{"x":' + "[" * 600 + "]" * 600 + "}"}, "BAD_SETTINGS_JSON"),
                              ({"rev": None}, "INVALID_FIELD"), ({"id": ""}, "INVALID_FIELD")):
            with self.subTest(change=str(change)[:60]):
                self.store.expect_settings_report(self.report["id"], NOW)
                entry = self.put(dict(self.report, **change))
                self.assertEqual((entry["status"], entry["error"]), ("FRESH" if error is None else "INVALID", error))
                json.dumps(self.store.snapshot(NOW), allow_nan=False)
                if error is None:
                    self.assertIsNotNone(self.store.settings_report())
        self.assertEqual(self.put(self.report, retained=True)["error"], "BROKER_POLICY")
        padded = dict(self.report, settings_json=self.report["settings_json"] + " " * MAX_PAYLOAD_BYTES)
        self.assertEqual(self.put(padded)["error"], "PAYLOAD_TOO_LARGE")
        self.assertEqual(self.put(self.report)["status"], "FRESH")


class AckTests(unittest.TestCase):
    ACKS = ("ack-config.config-get-applied.json", "ack-config.config-patch-rejected.json",
            "ack-operation.stream-set-accepted.json", "ack-operation.stream-set-applied.json",
            "ack-operation.operation-get.json", "ack-operation.service-restart-unknown.json",
            "ack-operation.reboot-prepare-applied.json", "ack-operation.ppp-restart-requested.json")

    def test_edge_acks(self) -> None:
        store = session_store(health=False)
        for name in self.ACKS:
            with self.subTest(name=name):
                self.assertEqual(feed(store, name)["status"], "FRESH")
        acks = node(store)["acks"]
        self.assertEqual(len(acks), 7)
        latest = {record["id"]: record for record in acks}
        stream = obj("ack-operation.stream-set-applied.json")
        self.assertEqual(latest[stream["id"]]["status"], "APPLIED")
        self.assertTrue(latest[stream["id"]]["final"])
        operation = store.ack(obj("ack-operation.operation-get.json")["id"])
        self.assertEqual(operation["result"]["operation"]["result"], {"profile": "balanced", "proof": "SCHEDULER_PROFILE_ACTIVE"})
        ppp = store.ack(obj("ack-operation.ppp-restart-requested.json")["id"])
        self.assertEqual((ppp["status"], ppp["final"], ppp["result"]["service"]), ("PPP_RESTART_REQUESTED", False, "t900-ppp.service"))
        self.assertIsNone(store.ack("g01-unknown"))
        self.assertEqual(topic(store, "ack/operation", NOW + 30_000)["status"], "FRESH")
        self.assertEqual(topic(store, "ack/operation", NOW + 30_001)["status"], "STALE")

    def test_the_one_time_challenge_is_never_kept(self) -> None:
        store = session_store(health=False)
        prepared = obj("ack-operation.reboot-prepare-applied.json")
        self.assertIn("challenge", prepared["result"])
        feed(store, "ack-operation.reboot-prepare-applied.json")
        rendered = json.dumps(store.snapshot(NOW))
        self.assertNotIn(prepared["result"]["challenge"], rendered)
        result = store.ack(prepared["id"])["result"]
        self.assertEqual(result, {"valid_seconds": 30, "prepare_id": prepared["id"]})
        nested = obj("ack-operation.operation-get.json", result={"operation": {"id": "x", "result": {
            "challenge": "secret-challenge-1", "broker_password": "pw-2", "api_token": "tok-3", "proof": "ok"}}})
        put(store, "ack/operation", nested)
        self.assertNotIn("secret-challenge-1", json.dumps(store.snapshot(NOW)))
        self.assertNotIn("pw-2", json.dumps(store.snapshot(NOW)))
        self.assertNotIn("tok-3", json.dumps(store.snapshot(NOW)))
        self.assertEqual(store.ack(nested["id"])["result"]["operation"]["result"], {"proof": "ok"})
        unknown = obj("ack-operation.stream-set-applied.json", id="g01-unknown-keys", result={"surprise": 1, "error": "X"})
        put(store, "ack/operation", unknown)
        self.assertEqual(store.ack("g01-unknown-keys")["result"], {"error": "X"})

    def test_every_journal_status_and_final_order(self) -> None:
        self.assertEqual(len(ACK_STATUSES), 14)
        store = session_store(health=False)
        for status in sorted(ACK_STATUSES):
            with self.subTest(status=status):
                entry = put(store, "ack/operation", obj("ack-operation.stream-set-accepted.json", id=f"op.{status}:1", status=status))
                self.assertEqual(entry["status"], "FRESH")
                self.assertEqual(store.ack(f"op.{status}:1")["final"], status in ACK_FINAL_STATUSES)
        for status, error in (("DONE", "UNKNOWN_ACK_STATUS"), ("applied", "INVALID_FIELD"), (5, "INVALID_FIELD")):
            with self.subTest(status=status):
                entry = put(store, "ack/operation", obj("ack-operation.stream-set-accepted.json", status=status))
                self.assertEqual((entry["status"], entry["error"]), ("INVALID", error))
        ack = obj("ack-operation.stream-set-accepted.json", id="g01-order")
        put(store, "ack/operation", dict(ack, status="APPLIED"))
        entry = put(store, "ack/operation", dict(ack, status="APPLYING"))
        self.assertEqual((entry["status"], entry["error"]), ("IGNORED", "ACK_AFTER_FINAL"))
        self.assertEqual(store.ack("g01-order")["status"], "APPLIED")
        self.assertEqual(put(store, "ack/operation", dict(ack, status="OUTCOME_UNKNOWN"))["status"], "FRESH")
        for index in range(40):
            put(store, "ack/operation", dict(ack, id=f"g01-many-{index}"))
        acks = node(store)["acks"]
        self.assertEqual(len(acks), 32)
        self.assertEqual((acks[0]["id"], acks[-1]["id"]), ("g01-many-39", "g01-many-8"))
        self.assertIsNone(store.ack("g01-order"))
        for change in ({"id": "x" * 81}, {"id": "has space"}, {"result": None}, {"rev": -1}):
            with self.subTest(change=change):
                self.assertEqual(put(store, "ack/operation", dict(ack, **change))["status"], "INVALID")


class MessageRuleTests(unittest.TestCase):
    def test_suffix_and_node_are_exact(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        for path in (f"sdr/v2/{NODE}/telemetry/health/extra", "sdr/v2/other/telemetry/health",
                     f"sdr/demo/v2/{NODE}/telemetry/health", f"sdr/v2/{NODE}/config/reported",
                     f"sdr/v3/{NODE}/telemetry/health", f"sdr/v2/{NODE}/cmd/config/get"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                store.ingest(path, raw("telemetry-health.json"), qos=0, retained=False, received_at_ms=NOW)
        self.assertEqual(store.snapshot(NOW)["received"], 0)
        for node_id in ("", "two/segments", "..", "bad+node", "bad#node", "x" * 65):
            with self.subTest(node_id=node_id), self.assertRaises(ValueError):
                RdfNodeV2Telemetry(node_id)
        with self.assertRaises(ValueError):
            store.ingest(f"sdr/v2/{NODE}/state", "text", qos=1, retained=True, received_at_ms=NOW)  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            store.ingest(f"sdr/v2/{NODE}/state", b"{}", qos=2, retained=True, received_at_ms=NOW)

    def test_qos_and_retain_follow_the_contract(self) -> None:
        for suffix, (qos, retained) in POLICY.items():
            name = next(entry["file"] for entry in MANIFEST["fixtures"] if entry["topic"] == suffix)
            for wrong_qos, wrong_retained in ((1 - qos, retained), (qos, not retained)):
                with self.subTest(suffix=suffix, qos=wrong_qos, retained=wrong_retained):
                    store = session_store()
                    entry = put(store, suffix, raw(name), qos=wrong_qos, retained=wrong_retained)
                    self.assertEqual((entry["status"], entry["error"]), ("INVALID", "BROKER_POLICY"))
                    self.assertEqual(store.snapshot(NOW)["invalid_counts"][suffix], 1)

    def test_retained_clear_removes_the_value_and_is_not_invalid(self) -> None:
        for suffix in RDF_NODE_V2_SUFFIXES:
            with self.subTest(suffix=suffix):
                store = RdfNodeV2Telemetry(NODE)
                for name in HEALTHY_SEQUENCE:
                    feed(store, name)
                before = store.snapshot(NOW)
                entry = put(store, suffix, b"", at=NOW + 10, qos=0, retained=True)
                after = store.snapshot(NOW + 10)
                self.assertEqual((entry["status"], entry["error"], entry["payload"]), ("UNAVAILABLE", "RETAINED_CLEARED", None))
                self.assertIs(entry["cleared"], True)
                self.assertEqual((after["cleared"], after["invalid"]), (1, before["invalid"]))
                self.assertEqual(after["received"], before["received"] + 1)
        store = RdfNodeV2Telemetry(NODE)
        for name in HEALTHY_SEQUENCE:
            feed(store, name)
        put(store, "state", b"", qos=1, retained=True)
        self.assertIsNone(node(store)["session"])
        self.assertIsNone(node(store)["angular"])
        self.assertEqual(feed(store, "telemetry-health.json")["error"], "NO_SESSION")
        store = RdfNodeV2Telemetry(NODE)
        for name in HEALTHY_SEQUENCE:
            feed(store, name)
        put(store, "telemetry/health", b"", qos=0, retained=True)
        self.assertEqual(node(store)["doa"]["reasons"], ["HEALTH_STALE"])

    def test_live_empty_payload_is_invalid(self) -> None:
        store = session_store()
        entry = put(store, "telemetry/health", b"")
        self.assertEqual((entry["status"], entry["error"]), ("INVALID", "EMPTY_PAYLOAD"))
        self.assertNotIn("cleared", entry)
        entry = put(store, "state", b"", retained=False)
        self.assertEqual((entry["status"], entry["error"]), ("INVALID", "BROKER_POLICY"))

    def test_unknown_fields_are_ignored_and_not_shown(self) -> None:
        store = session_store()
        entry = put(store, "telemetry/health", obj("telemetry-health.json", q=2, t=NOW, newer_field={"x": 1}, password="p"))
        self.assertEqual(entry["status"], "FRESH")
        self.assertNotIn("newer_field", entry["payload"])
        self.assertNotIn("password", json.dumps(store.snapshot(NOW)))

    def test_size_limit_is_exact(self) -> None:
        for length, status in ((MAX_PAYLOAD_BYTES, "FRESH"), (MAX_PAYLOAD_BYTES + 1, "INVALID")):
            store = session_store(health=False)
            base = encode(obj("telemetry-health.json", t=NOW))
            padded = base + b" " * (length - len(base))
            self.assertEqual(len(padded), length)
            self.assertEqual(put(store, "telemetry/health", padded)["status"], status)

    def test_hostile_payloads_only_produce_an_invalid_status(self) -> None:
        cases = (
            (b"{", "MALFORMED_JSON"),
            (b"[]", "INVALID_ENVELOPE"),
            (b'"text"', "INVALID_ENVELOPE"),
            (b"\xff\xfe{}", "MALFORMED_JSON"),
            (b'{"v":2,"sid":"7a8b9c0d","v":2}', "DUPLICATE_KEY"),
            (b'{"v":2,"temp":NaN}', "NONFINITE_JSON"),
            (b'{"v":2,"temp":Infinity}', "NONFINITE_JSON"),
            (b'{"v":2,"temp":1e999}', "NONFINITE_JSON"),
            (b'{"v":2.0,"sid":"7a8b9c0d"}', "INVALID_VERSION"),
            (b'{"v":true,"sid":"7a8b9c0d"}', "INVALID_VERSION"),
            (b'{"v":2,"sid":"7a8b9c0"}', "INVALID_SESSION_ID"),
            (b'{"v":2,"sid":null}', "INVALID_SESSION_ID"),
        )
        for payload, error in cases:
            with self.subTest(payload=payload[:30]):
                store = session_store()
                entry = put(store, "telemetry/health", payload)
                self.assertEqual((entry["status"], entry["error"]), ("INVALID", error))
                self.assertIsNone(entry["payload"])
                self.assertTrue(node(store)["health"]["fresh"])
        # Deep nesting: a RecursionError on some Pythons, a list on others; never a crash.
        entry = put(session_store(), "telemetry/health", b"[" * 4000 + b"]" * 4000)
        self.assertEqual(entry["status"], "INVALID")
        self.assertIn(entry["error"], ("MALFORMED_JSON", "INVALID_ENVELOPE"))
        huge = encode(obj("telemetry-health.json")).replace(b'"q":1', b'"q":' + b"9" * 500)
        store = session_store()
        self.assertEqual(put(store, "telemetry/health", huge)["status"], "INVALID")
        big_float = dict(obj("telemetry-doa.ok1.json", t=NOW), p=10 ** 400)
        self.assertEqual(put(store, "telemetry/doa", big_float)["error"], "INVALID_FIELD")
        # A lone surrogate in settings_json, with no config.get registered: the
        # validator runs first, and the message is counted as invalid.
        store = session_store()
        report = obj("settings-reported.json")
        entry = put(store, "settings/reported", dict(report, settings_json="\ud800" + report["settings_json"]))
        self.assertEqual((entry["status"], entry["error"], entry.get("field")), ("INVALID", "BAD_SETTINGS_JSON", "settings_json"))
        snapshot = store.snapshot(NOW)
        self.assertEqual((snapshot["received"], snapshot["valid"], snapshot["invalid"]), (3, 2, 1))

    def test_a_case_no_validator_names_is_still_one_invalid_message(self) -> None:
        def broken(_data: Dict[str, Any]) -> Dict[str, Any]:
            raise TypeError("unexpected")

        store = session_store()
        with patch.dict(rdf_node_mqtt_v2._VALIDATORS, {"telemetry/health": broken}):
            entry = put(store, "telemetry/health", obj("telemetry-health.json", q=2, t=NOW))
        self.assertEqual((entry["status"], entry["error"], entry["payload"]), ("INVALID", "MALFORMED_PAYLOAD", None))
        snapshot = store.snapshot(NOW)
        self.assertEqual(snapshot["valid"] + snapshot["invalid"] + snapshot["cleared"], snapshot["received"])
        self.assertEqual(snapshot["invalid_counts"]["telemetry/health"], 1)
        self.assertTrue(snapshot["node"]["health"]["fresh"])

    def test_mutated_edge_payloads_never_raise(self) -> None:
        rng = random.Random(7)
        names = [entry["file"] for entry in MANIFEST["fixtures"]]
        store = RdfNodeV2Telemetry(NODE)
        for name in HEALTHY_SEQUENCE:
            feed(store, name)
        for _ in range(1500):
            name = rng.choice(names)
            data = bytearray(raw(name))
            for _flip in range(rng.randint(1, 4)):
                position = rng.randrange(len(data))
                data[position] = rng.choice(b'{}[]":,0123456789-.eE ntfaluNI\x00\xff')
            meta = BY_FILE[name]
            store.ingest(f"sdr/v2/{NODE}/{meta['topic']}", bytes(data), qos=meta["qos"], retained=meta["retain"],
                         received_at_ms=NOW)
            # The catch-all code means a validator met a case it does not name.
            self.assertNotEqual(store.snapshot(NOW)["topics"][meta["topic"]]["error"], "MALFORMED_PAYLOAD")
        snapshot = store.snapshot(NOW)
        json.dumps(snapshot, allow_nan=False)
        self.assertEqual(snapshot["received"], len(HEALTHY_SEQUENCE) + 1500)
        self.assertEqual(snapshot["valid"] + snapshot["invalid"] + snapshot["cleared"], snapshot["received"])


class ViewTests(unittest.TestCase):
    def test_snapshot_shape_and_copies(self) -> None:
        store = RdfNodeV2Telemetry(NODE)
        for name in HEALTHY_SEQUENCE:
            feed(store, name)
        snapshot = store.snapshot(NOW + 2500)
        self.assertEqual(snapshot["now_ms"], NOW + 2500)
        self.assertEqual(set(snapshot["topics"]), set(RDF_NODE_V2_SUFFIXES))
        self.assertEqual(set(snapshot["node"]), {
            "session", "health", "detail", "doa", "doa_unverified", "diagnostic_doa", "angular",
            "angular_unverified", "capabilities", "availability", "settings", "settings_requests", "acks",
        })
        self.assertEqual(snapshot["node"]["health"]["age_ms"], 2500)
        snapshot["node"]["angular"]["values"][0] = 999.0
        snapshot["topics"]["state"]["payload"]["sid"] = "mutated"
        again = store.snapshot(NOW)
        self.assertNotEqual(again["node"]["angular"]["values"][0], 999.0)
        self.assertEqual(again["topics"]["state"]["payload"]["sid"], SID)
        self.assertEqual(store.session_view(NOW)["sid"], SID)
        with self.assertRaises(ValueError):
            store.snapshot(-1)

    def test_the_shared_api_snapshot_is_what_the_store_serves(self) -> None:
        # Rewrite it with write_api_snapshot() when the shape changes on purpose.
        self.assertEqual(json.loads(API_SNAPSHOT.read_text(encoding="utf-8")), api_snapshot())

    def test_empty_store(self) -> None:
        snapshot = RdfNodeV2Telemetry(NODE).snapshot(NOW)
        self.assertEqual({entry["status"] for entry in snapshot["topics"].values()}, {"UNAVAILABLE"})
        self.assertEqual(snapshot["node"]["acks"], [])
        self.assertIsNone(snapshot["node"]["session"])
        self.assertEqual(copy.deepcopy(snapshot), snapshot)


if __name__ == "__main__":
    unittest.main()
