#!/usr/bin/env python3
"""MQTT first, Data Out as the fallback, or none: the source of /api/snapshot (issue #8).

The edge payloads are the RDF Node fixtures (tools/fixtures/rdf-node/, made by
the edge's own code) with fresh times, fed through the real store
(rdf_node_mqtt_v2.py). The reader tests run on a fake clock with fake reads;
the HTTP tests start a real GroundConsoleServer with a fake monitor in front
of the store and a loopback fake Data Out that counts its GETs.
"""

from __future__ import annotations

import collections
import copy
import http.client
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from unittest.mock import patch
from urllib.parse import quote

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

# ground_console resolves its admin password at import time; give it a
# test-only value so the import never reads a local .env file.
_SAVED_ADMIN_PASSWORD = os.environ.get("SDR_DOA_ADMIN_PASSWORD")
os.environ["SDR_DOA_ADMIN_PASSWORD"] = "telemetry-source-no-secret"
try:
    import ground_console  # noqa: E402
finally:
    if _SAVED_ADMIN_PASSWORD is None:
        os.environ.pop("SDR_DOA_ADMIN_PASSWORD", None)
    else:
        os.environ["SDR_DOA_ADMIN_PASSWORD"] = _SAVED_ADMIN_PASSWORD

import data_out_reader as dor  # noqa: E402
import sdr_doa_collector as collector  # noqa: E402
import telemetry_source as ts  # noqa: E402
from data_out_reader import DataOutReader, SnapshotRequest  # noqa: E402
from rdf_node_mqtt_v2 import RdfNodeV2Telemetry  # noqa: E402
from test_data_out_reader import FakeClock, LoopbackNode  # noqa: E402
from test_sdr_doa_collector import make_status, make_xml  # noqa: E402

NODE = "uav-01"
BASE_URL = "http://127.0.0.1:8081"
FIXTURES = TOOLS_DIR / "fixtures" / "rdf-node"
THETA = 160.0
FREQUENCY_HZ = 433_920_000
POLICY = {
    "state": (1, True), "capabilities": (1, True), "availability": (1, True),
    "telemetry/health": (0, False), "telemetry/health/detail": (0, False), "telemetry/doa": (0, False),
    "telemetry/diagnostic/doa": (0, False), "telemetry/angular": (0, False),
    "telemetry/diagnostic/angular": (0, False),
}
STANDING = ["CANONICAL_ANGLE_NOT_CONFIGURED", "DOA_AUTHORITY_NOT_SELECTED"]


def fixture(name: str) -> Dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def peaked(theta: float) -> List[float]:
    """360 bins on the theta_0 grid with the peak at ``theta``, like DOA_value.html."""
    peak = int(round(theta)) % 360
    values = []
    for index in range(360):
        distance = min(abs(index - peak), 360 - abs(index - peak))
        values.append(round(-24.0 + 22.5 * 2.718281828 ** (-((distance / 11.0) ** 2)), 2))
    return values


class Edge:
    """The RDF Node edge as the console's store sees it, on a millisecond clock."""

    def __init__(self, now_ms: Callable[[], int]) -> None:
        self.now_ms = now_ms
        self.store = RdfNodeV2Telemetry(NODE)
        self.q: Dict[str, int] = collections.Counter()
        self.state = fixture("state.json")

    def send(self, suffix: str, value: Dict[str, Any], *, at: Optional[int] = None) -> Dict[str, Any]:
        qos, retained = POLICY[suffix]
        received = self.now_ms() if at is None else at
        self.store.ingest(
            f"sdr/v2/{NODE}/{suffix}", json.dumps(value, separators=(",", ":")).encode(),
            qos=qos, retained=retained, received_at_ms=received,
        )
        return self.store.snapshot(received)["topics"][suffix]

    def next_q(self, kind: str) -> int:
        self.q[kind] += 1
        return self.q[kind]

    def hello(self, *, angle: Optional[str] = "theta_mirror", sid: Optional[str] = None, cfg: int = 1) -> None:
        state = dict(self.state, t=self.now_ms(), cfg=cfg)
        if sid is not None:
            state.update(sid=sid, boot=f"boot-{sid}", instance=f"instance-{sid}")
            self.q.clear()
        self.state = state
        self.send("state", state)
        if angle is not None:
            self.send("capabilities", dict(fixture("capabilities.json"), sid=state["sid"], boot=state["boot"],
                                           instance=state["instance"], angle=angle))

    def health(self, *, daq: int = 1, q: Optional[int] = None, at: Optional[int] = None) -> Dict[str, Any]:
        t = self.now_ms() if at is None else at
        return self.send("telemetry/health", dict(
            fixture("telemetry-health.json"), sid=self.state["sid"], t=t, daq=daq,
            q=self.next_q("health") if q is None else q, rev=self.state["cfg"],
        ), at=at)

    def doa(self, theta: float = THETA, *, ok: int = 1, angle: str = "theta_mirror", f: int = FREQUENCY_HZ,
            q: Optional[int] = None, at: Optional[int] = None) -> Dict[str, Any]:
        raw = (360.0 - theta) % 360.0
        if ok == 1:
            payload = dict(fixture("telemetry-doa.ok1.json"), a=theta if angle == "theta_mirror" else raw)
        else:
            payload = dict(fixture("telemetry-doa.ok0.json"), a=raw)
        payload.update(sid=self.state["sid"], t=self.now_ms() if at is None else at, f=f, rev=self.state["cfg"],
                       q=self.next_q("frame") if q is None else q)
        return self.send("telemetry/doa", payload, at=at)

    def angular(self, theta: float = THETA, *, flags: int = 63, q: Optional[int] = None,
                frequency_hz: int = FREQUENCY_HZ, revision: Optional[int] = None, topic: str = "telemetry/angular",
                at: Optional[int] = None) -> Dict[str, Any]:
        payload = dict(fixture("telemetry-angular.live.json"))
        payload.update(
            sid=self.state["sid"], timestamp_ms=self.now_ms() if at is None else at, flags=flags,
            q=self.q["frame"] if q is None else q, frequency_hz=frequency_hz,
            revision=self.state["cfg"] if revision is None else revision,
            raw_doa_deg=(360.0 - theta) % 360.0, values=peaked(theta),
        )
        return self.send(topic, payload, at=at)

    def diagnostic_doa(self, theta: float = THETA) -> Dict[str, Any]:
        now = self.now_ms()
        return self.send("telemetry/diagnostic/doa", dict(
            fixture("telemetry-diagnostic-doa.json"), sid=self.state["sid"], q=self.next_q("diagnostic_doa"),
            source_timestamp_ms=now, observed_timestamp_ms=now, raw_doa_deg=theta,
        ))

    def live(self, theta: float = THETA) -> "Edge":
        """A healthy edge with one LIVE DoA and its LIVE Angular frame."""
        self.hello()
        self.health()
        self.doa(theta)
        self.angular(theta)
        return self

    def view(self, at: Optional[int] = None, connection: str = "ready") -> Dict[str, Any]:
        now = self.now_ms() if at is None else at
        return {"now_ms": now, "connection": connection, "node_id": NODE, "node": self.store.node_view(now)}


class ManualMs:
    def __init__(self, start: int = 1_793_070_140_000) -> None:
        self.now = start

    def __call__(self) -> int:
        return self.now


def build(edge: Edge, light: Optional[Dict[str, Any]] = None, light_age_ms: Optional[int] = None) -> Dict[str, Any]:
    return ts.mqtt_snapshot(edge.view(), light, base_url=BASE_URL, light_age_ms=light_age_ms,
                            light_meta={"interval_s": 30.0, "reason": None, "running": False, "error": None})


def light_result(*, overdrive: str = "False", center_freq: float = 433.92, gps: str = "Disabled") -> Dict[str, Any]:
    """collect_light against fixed bodies, read at the node's own time."""
    now = collector.now_ms()
    status = json.loads(make_status(now).decode())
    status["gps_status"] = gps
    bodies = {
        collector.PATH_STATUS: json.dumps(status).encode(),
        collector.PATH_SETTINGS: json.dumps({"center_freq": center_freq, "compass_offset": 12}).encode(),
        collector.PATH_XML: make_xml(now, overdrive=overdrive),
    }

    def fetcher(base_url: str, path: str, timeout: float, max_body: int) -> collector.FetchedResource:
        body = bodies[path]
        return collector.FetchedResource(path, base_url + path, True, 200, "application/json", body, collector.now_ms())

    return collector.collect_light(BASE_URL, fetcher=fetcher, total_budget_s=4.0)


# ---------------------------------------------------------------------------
# Answers shared with the frontend tests (tools/fixtures/telemetry-source/)

SOURCE_FIXTURES = TOOLS_DIR / "fixtures" / "telemetry-source"
FIXED_NOW = 1_793_070_140_000
I18N = TOOLS_DIR.parent / "frontend" / "src" / "lib" / "i18n.ts"
SOURCE_TS = TOOLS_DIR.parent / "frontend" / "src" / "lib" / "telemetrySource.ts"


def fixed_light(*, reachable: bool = True) -> Dict[str, Any]:
    """A light read 2 s before FIXED_NOW: a GPS fix, doa.xml with a position, or a refused node."""
    at = FIXED_NOW - 2_000
    status = json.loads(make_status(at).decode())
    status["gps_status"] = "Fixed"
    bodies = {
        collector.PATH_STATUS: json.dumps(status).encode(),
        collector.PATH_SETTINGS: json.dumps({
            "center_freq": 433.92, "uniform_gain": 15.7, "vfo_freq_0": 433_920_000, "compass_offset": 12,
            "doa_fig_type": "Compass", "en_remote_control": False,
        }).encode(),
        collector.PATH_XML: make_xml(at).replace(
            b"<LATITUDE>0</LATITUDE><LONGITUDE>0</LONGITUDE>", b"<LATITUDE>-6.2</LATITUDE><LONGITUDE>106.8</LONGITUDE>",
        ),
    }

    def fetcher(base_url: str, path: str, timeout: float, max_body: int) -> collector.FetchedResource:
        if not reachable:
            return collector.FetchedResource(path, base_url + path, False, None, None, b"", at,
                                             error="connection refused", error_kind="connection_refused")
        return collector.FetchedResource(path, base_url + path, True, 200, "application/json", bodies[path], at)

    with patch.object(collector, "now_ms", lambda: at):
        return collector.collect_light(BASE_URL, fetcher=fetcher, total_budget_s=4.0, monotonic_clock=lambda: 50.0)


def fixture_answers() -> Dict[str, Dict[str, Any]]:
    """The MQTT answers the frontend tests read, built at a fixed time."""
    answers: Dict[str, Dict[str, Any]] = {}

    def answer(edge: Edge, light: Optional[Dict[str, Any]], index: int) -> Dict[str, Any]:
        built = ts.mqtt_snapshot(edge.view(), light, base_url=BASE_URL, light_age_ms=None if light is None else 2_000,
                                 light_meta={"interval_s": 30.0, "reason": "light-first", "running": False, "error": None})
        # The reader's own fields, with fixed values.
        built["collection"].update({"id": f"0f1e2d3c-{index}", "collected_at_ms": FIXED_NOW, "age_ms": 0,
                                    "shared": False, "refresh_seconds": 2, "console_base_url": BASE_URL})
        return built

    live = Edge(ManualMs(FIXED_NOW)).live()
    # The edge also sends doa.xml every 3 s, and the Angular frame on the
    # diagnostic topic while Bulk waits for a stable link: both UNVERIFIED.
    live.diagnostic_doa()
    live.angular(topic="telemetry/diagnostic/angular", q=1)
    answers["mqtt-live.json"] = answer(live, fixed_light(), 1)
    answers["mqtt-data-out-dead.json"] = answer(live, fixed_light(reachable=False), 2)
    unverified = Edge(ManualMs(FIXED_NOW))
    unverified.hello()
    unverified.health()
    unverified.doa(ok=0)
    unverified.angular(flags=23)
    answers["mqtt-unverified.json"] = answer(unverified, fixed_light(), 3)
    return answers


def write_source_fixtures() -> None:
    """Rewrite tools/fixtures/telemetry-source/ after an intended change of the answer."""
    SOURCE_FIXTURES.mkdir(parents=True, exist_ok=True)
    for name, body in fixture_answers().items():
        (SOURCE_FIXTURES / name).write_text(json.dumps(body, indent=1, sort_keys=True) + "\n", encoding="utf-8")


class SharedFixtureTests(unittest.TestCase):
    def test_the_frontend_fixtures_are_what_the_server_builds(self) -> None:
        for name, body in fixture_answers().items():
            with self.subTest(name=name):
                saved = json.loads((SOURCE_FIXTURES / name).read_text(encoding="utf-8"))
                self.assertEqual(saved, json.loads(json.dumps(body)))

    def test_every_source_and_gate_code_has_a_label_in_both_languages(self) -> None:
        # The frontend names every code this module sends: the source reasons
        # in its source.reason.* keys, the gate reasons in both gate tables.
        i18n = I18N.read_text(encoding="utf-8")
        source_ts = SOURCE_TS.read_text(encoding="utf-8")
        for reason in ts.SOURCE_REASONS:
            self.assertEqual(i18n.count(f"'source.reason.{reason}':"), 2, reason)
            self.assertIn(f"'{reason}'", source_ts, reason)
        id_table = i18n.split("const GATE_REASON_LABELS_ID", 1)[1].split("};", 1)[0]
        en_table = i18n.split("const GATE_REASON_LABELS_EN_EXTRA", 1)[1].split("};", 1)[0]
        for reason in ts.MQTT_GATE_REASONS:
            self.assertIn(f"  {reason}:", id_table, reason)
            self.assertIn(f"  {reason}:", en_table, reason)


# ---------------------------------------------------------------------------
# The decision


class FreshnessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = ManualMs()
        self.edge = Edge(self.clock)

    def fresh(self) -> Tuple[bool, List[str]]:
        return ts.mqtt_freshness(self.edge.view())

    def test_mqtt_is_fresh_with_a_session_and_a_healthy_fresh_health(self) -> None:
        self.assertEqual(ts.mqtt_freshness(None), (False, ["MQTT_DISABLED"]))
        self.assertEqual(self.fresh(), (False, ["MQTT_NO_SESSION"]))
        self.edge.hello()
        self.assertEqual(self.fresh(), (False, ["MQTT_NO_HEALTH"]))
        self.edge.health()
        self.assertEqual(self.fresh(), (True, []))
        # 8 s after it arrived the health is stale; MQTT connected is no substitute.
        self.clock.now += 8_001
        self.assertEqual(self.fresh(), (False, ["MQTT_HEALTH_STALE"]))
        self.edge.health()
        self.assertEqual(self.fresh(), (True, []))

    def test_the_daq_must_be_healthy(self) -> None:
        self.edge.hello()
        for daq in (0, 2):
            self.edge.health(daq=daq)
            self.assertEqual(self.fresh(), (False, ["MQTT_DAQ_NOT_HEALTHY"]), daq)
        self.edge.health(daq=1)
        self.assertEqual(self.fresh(), (True, []))

    def test_health_q_must_advance(self) -> None:
        self.edge.hello()
        self.edge.health(q=5)
        self.clock.now += 5_000
        # The same q again is IGNORED, so it does not keep MQTT fresh.
        self.assertEqual(self.edge.health(q=5)["error"], "SEQUENCE_NOT_ADVANCING")
        self.clock.now += 3_500
        self.assertEqual(self.fresh(), (False, ["MQTT_HEALTH_STALE"]))

    def test_a_new_session_drops_the_old_health(self) -> None:
        self.edge.hello()
        self.edge.health()
        self.assertTrue(self.fresh()[0])
        self.edge.hello(sid="0badcafe")
        self.assertEqual(self.fresh(), (False, ["MQTT_NO_HEALTH"]))
        self.edge.health()
        self.assertEqual(self.fresh(), (True, []))
        self.assertEqual(ts.mqtt_mark(self.edge.view()), ("0badcafe", 1))


# ---------------------------------------------------------------------------
# The answer built from MQTT


class MqttSnapshotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = ManualMs()
        self.edge = Edge(self.clock)

    def test_live_doa_and_angular_fill_the_snapshot_shape(self) -> None:
        snapshot = build(self.edge.live())
        self.assertEqual(snapshot["source"]["kind"], "mqtt")
        self.assertEqual(snapshot["source"]["reason"], "MQTT_FRESH")
        self.assertEqual(list(snapshot["doa_candidates"]), ["mqtt"])
        view = snapshot["doa_candidates"]["mqtt"]
        self.assertTrue(view["available"])
        self.assertEqual(view["canonical_angle_deg"], THETA)
        self.assertEqual(view["canonical_angle_convention"], "upstream_theta_0")
        self.assertEqual(view["frequency_hz_normalized"], FREQUENCY_HZ)
        self.assertEqual((view["confidence_metric_db"], view["power_native_db"]), (8.27, -54.2))
        self.assertIsNone(view["confidence"])
        self.assertIsNone(view["power_db"])
        self.assertEqual(view["freshness"]["fresh"], True)
        self.assertEqual(view["freshness"]["max_age_ms"], 5_000)
        self.assertGreaterEqual(view["freshness"]["age_ms"], 0)
        self.assertEqual(len(view["angular_power_db"]), 360)
        self.assertEqual(view["angular_peak_index"], 160)
        self.assertIs(view["angular_peak_angle_consistent"], True)
        self.assertEqual(view["angular_pairing"], "SAME_FRAME")
        consistency = snapshot["native_consistency"]
        self.assertEqual((consistency["comparable"], consistency["frame_relation"]), (True, "SAME_FRAME"))
        self.assertEqual((consistency["angle_checked"], consistency["conflict"]), (True, False))
        # The observation boundary holds: never LIVE, never READY.
        self.assertEqual(snapshot["overall_state"], "UNVERIFIED")
        self.assertEqual(snapshot["publication_gate"]["state"], "BLOCKED")
        self.assertEqual(snapshot["publication_gate"]["reasons"], ["GROUND_CLOCK_UNVERIFIED", *STANDING])
        self.assertEqual(snapshot["authority"]["selected"], None)
        self.assertEqual(snapshot["collector"]["clock_source"], "remote_unverified")
        self.assertEqual(snapshot["collector"]["authority_config"], "none")
        status = snapshot["status"]
        self.assertEqual((status["available"], status["daq_health"]), (True, "PASS"))
        self.assertEqual(status["safe"]["daq_status"], {"frame_sync": True, "sample_delay_sync": True, "iq_sync": True})
        self.assertFalse(snapshot["node_progress"]["stalled"])
        # Without a light read nothing claims settings.
        self.assertIs(snapshot["settings"]["available"], False)

    def test_the_angle_follows_the_sessions_angle_mode(self) -> None:
        # csv_native sends DOA_value.html's column 1, 360 - theta_0.
        self.edge.hello(angle="csv_native")
        self.edge.health()
        self.assertEqual(self.edge.doa(angle="csv_native")["payload"]["a"], 200.0)
        self.edge.angular()
        snapshot = build(self.edge)
        self.assertEqual(snapshot["doa_candidates"]["mqtt"]["canonical_angle_deg"], THETA)
        self.assertFalse(snapshot["native_consistency"]["conflict"])
        self.assertEqual(snapshot["overall_state"], "UNVERIFIED")

    def test_an_unknown_angle_mode_keeps_the_angle_out(self) -> None:
        self.edge.hello(angle=None)
        self.edge.health()
        self.edge.doa()
        self.edge.angular()
        snapshot = build(self.edge)
        view = snapshot["doa_candidates"]["mqtt"]
        self.assertNotIn("canonical_angle_deg", view)
        self.assertEqual(view["normalization_error"], "MQTT_ANGLE_CONVENTION_UNKNOWN")
        self.assertEqual(snapshot["overall_state"], "INCOMPLETE")
        self.assertIn("MQTT_ANGLE_CONVENTION_UNKNOWN", snapshot["publication_gate"]["reasons"])
        # Capabilities of another session do not count either.
        other = dict(fixture("capabilities.json"), sid="0badcafe", boot="b", instance="i")
        self.edge.send("capabilities", other)
        self.assertNotIn("canonical_angle_deg", build(self.edge)["doa_candidates"]["mqtt"])

    def test_a_wrong_angle_mapping_shows_as_a_conflict(self) -> None:
        # The capabilities say csv_native while the DoA carries theta_0: the
        # same frame's Angular raw angle disagrees, so nothing is shown.
        self.edge.hello(angle="csv_native")
        self.edge.health()
        self.edge.doa(angle="theta_mirror")
        self.edge.angular()
        snapshot = build(self.edge)
        self.assertTrue(snapshot["native_consistency"]["conflict"])
        self.assertEqual(snapshot["overall_state"], "CONFLICT")
        self.assertIn("MQTT_DOA_ANGULAR_CONFLICT", snapshot["publication_gate"]["reasons"])
        self.assertIs(snapshot["publication_gate"]["checks"]["native_views_consistent"], False)

    def test_ok0_is_never_a_doa_candidate(self) -> None:
        self.edge.hello()
        self.edge.health()
        self.assertEqual(self.edge.doa(ok=0)["status"], "UNVERIFIED")
        snapshot = build(self.edge)
        self.assertIs(snapshot["doa_candidates"]["mqtt"]["available"], False)
        self.assertNotIn("angular_power_db", snapshot["doa_candidates"]["mqtt"])
        self.assertEqual(snapshot["overall_state"], "UNVERIFIED")
        self.assertIn("MQTT_DOA_UNVERIFIED", snapshot["publication_gate"]["reasons"])
        diagnostic = snapshot["mqtt"]["doa_unverified"]
        self.assertEqual((diagnostic["trust"], diagnostic["angle_reference"]), ("UNVERIFIED", "RAW"))
        self.assertEqual(diagnostic["canonical_angle_deg"], THETA)
        # Once it is old there is no current DoA at all.
        self.clock.now += 5_001
        self.edge.health()
        snapshot = build(self.edge)
        self.assertEqual(snapshot["overall_state"], "STALE")
        self.assertIn("MQTT_NO_DOA", snapshot["publication_gate"]["reasons"])

    def test_flags_other_than_63_never_give_the_vector(self) -> None:
        self.edge.hello()
        self.edge.health()
        self.edge.doa()
        self.assertEqual(self.edge.angular(flags=23)["status"], "UNVERIFIED")
        snapshot = build(self.edge)
        view = snapshot["doa_candidates"]["mqtt"]
        self.assertNotIn("angular_power_db", view)
        self.assertEqual(view["angular_pairing"], "NONE")
        self.assertEqual(snapshot["overall_state"], "INCOMPLETE")
        self.assertIn("MQTT_ANGULAR_UNAVAILABLE", snapshot["publication_gate"]["reasons"])
        self.assertEqual(snapshot["mqtt"]["angular_unverified"]["flags"], 23)
        self.assertNotIn("values", snapshot["mqtt"]["angular_unverified"])
        # The diagnostic topic is the same: UNVERIFIED, kept apart.
        self.edge.angular(topic="telemetry/diagnostic/angular", q=1)
        self.edge.diagnostic_doa()
        snapshot = build(self.edge)
        self.assertNotIn("angular_power_db", snapshot["doa_candidates"]["mqtt"])
        self.assertEqual(snapshot["mqtt"]["angular_unverified"]["topic"], "telemetry/diagnostic/angular")
        self.assertEqual(snapshot["mqtt"]["diagnostic_doa"]["canonical_angle_deg"], THETA)

    def test_the_vector_belongs_to_the_same_tuning(self) -> None:
        self.edge.hello()
        self.edge.health()
        self.edge.doa()
        self.edge.angular(frequency_hz=FREQUENCY_HZ + 25_000)
        view = build(self.edge)["doa_candidates"]["mqtt"]
        self.assertEqual(view["angular_pairing"], "OTHER_FREQUENCY")
        self.assertNotIn("angular_power_db", view)
        self.edge.doa()
        self.edge.angular(revision=7)
        self.assertEqual(build(self.edge)["doa_candidates"]["mqtt"]["angular_pairing"], "OTHER_REVISION")
        # A frame older than the DoA, of the same tuning, is drawn without an angle check.
        self.edge.doa()
        self.edge.angular()
        self.edge.doa(theta=162.0)
        snapshot = build(self.edge)
        self.assertEqual(snapshot["doa_candidates"]["mqtt"]["angular_pairing"], "SAME_CONFIG")
        self.assertIn("angular_power_db", snapshot["doa_candidates"]["mqtt"])
        self.assertEqual(snapshot["native_consistency"]["angle_checked"], False)
        self.assertEqual(snapshot["native_consistency"]["frame_relation"], "ADJACENT_FRAMES")
        self.assertEqual(snapshot["doa_candidates"]["mqtt"]["canonical_angle_deg"], 162.0)
        # The peak is checked against the theta_0 drawn with it, the DoA's.
        self.assertEqual(snapshot["doa_candidates"]["mqtt"]["angular_peak_angle_distance_deg"], 2.0)
        self.assertIn("NATIVE_ANGLE_UNCHECKED", snapshot["publication_gate"]["reasons"])
        self.assertEqual(snapshot["overall_state"], "UNVERIFIED")

    def test_an_older_frame_pointing_elsewhere_gives_no_vector(self) -> None:
        # The edge sends Angular every 4 s and DoA every second: the newest DoA
        # usually belongs to a later record than the newest Angular frame.
        self.edge.hello()
        self.edge.health()
        self.edge.doa(100.0)
        self.edge.angular(100.0)
        for theta in (110.0, 120.0, 130.0):
            self.clock.now += 1_000
            self.edge.health()
            self.edge.doa(theta)
        snapshot = build(self.edge)
        view = snapshot["doa_candidates"]["mqtt"]
        self.assertEqual(view["canonical_angle_deg"], 130.0)
        self.assertEqual(view["angular_pairing"], "PEAK_MOVED")
        self.assertEqual(view["angular_frame"]["doa_peak_distance_deg"], 30.0)
        self.assertEqual(snapshot["mqtt"]["angular"]["pairing"], "PEAK_MOVED")
        # No curve, lobe or display peak from the frame, so the bearing is not
        # drawn under a curve that points 30 degrees away.
        self.assertNotIn("angular_power_db", view)
        self.assertNotIn("angular_peak_index", view)
        self.assertEqual(snapshot["native_consistency"]["frame_relation"], "INCOMPLETE")
        self.assertEqual(snapshot["overall_state"], "INCOMPLETE")
        self.assertIn("MQTT_ANGULAR_UNAVAILABLE", snapshot["publication_gate"]["reasons"])
        # The next frame of the current record gives it back, checked as one record.
        self.edge.angular(130.0)
        snapshot = build(self.edge)
        self.assertEqual(snapshot["doa_candidates"]["mqtt"]["angular_pairing"], "SAME_FRAME")
        self.assertEqual(snapshot["doa_candidates"]["mqtt"]["angular_peak_index"], 130)
        self.assertEqual(snapshot["overall_state"], "UNVERIFIED")
        self.assertNotIn("NATIVE_ANGLE_UNCHECKED", snapshot["publication_gate"]["reasons"])

    def test_an_old_doa_is_stale(self) -> None:
        self.edge.live()
        self.clock.now += 5_001
        self.edge.health()
        snapshot = build(self.edge)
        self.assertIs(snapshot["doa_candidates"]["mqtt"]["freshness"]["fresh"], False)
        self.assertEqual(snapshot["overall_state"], "STALE")
        self.assertIn("DOA_CANDIDATES_STALE", snapshot["publication_gate"]["reasons"])

    def test_the_light_read_supplies_settings_position_and_overdrive(self) -> None:
        self.edge.live()
        light = light_result(gps="Fixed")
        snapshot = build(self.edge, light, light_age_ms=2_000)
        self.assertEqual(snapshot["settings"]["fields"]["center_freq"], 433.92)
        self.assertEqual(snapshot["status"]["safe"]["gps_status"], "Fixed")
        self.assertEqual(snapshot["data_out_light"]["xml"]["available"], True)
        self.assertEqual(snapshot["data_out_light"]["age_ms"], 2_000)
        self.assertEqual(snapshot["signal_quality"]["adc_overdrive"], False)
        self.assertEqual(snapshot["collection"]["settings_reused"], False)
        self.assertGreaterEqual(snapshot["collection"]["settings_age_ms"], 2_000)
        overdriven = build(self.edge, light_result(overdrive="True"), light_age_ms=2_000)
        self.assertEqual(overdriven["overall_state"], "DEGRADED")
        self.assertIs(overdriven["publication_gate"]["checks"]["adc_not_overdriven"], False)
        # An old light read no longer decides the overdrive.
        old = build(self.edge, light_result(overdrive="True"), light_age_ms=ts.LIGHT_VALUES_MAX_AGE_MS + 1)
        self.assertEqual(old["overall_state"], "UNVERIFIED")
        self.assertIsNone(old["publication_gate"]["checks"]["adc_not_overdriven"])
        # Nor anything else of it: settings, gps_status, position and resources
        # answer as not read, so an old centre or LOCATION never looks current.
        old = build(self.edge, light_result(gps="Fixed"), light_age_ms=ts.LIGHT_VALUES_MAX_AGE_MS + 1)
        self.assertIs(old["settings"]["available"], False)
        self.assertEqual(old["settings"]["error"], "last settings.json read is too old")
        self.assertNotIn("gps_status", old["status"]["safe"])
        self.assertIsNone(old["data_out_light"]["xml"])
        self.assertIsNone(old["data_out_light"]["status"])
        self.assertEqual(old["data_out_light"]["resources"], {})
        self.assertEqual(old["resources"], {})
        self.assertIs(old["data_out_light"]["expired"], True)
        self.assertEqual(old["data_out_light"]["age_ms"], ts.LIGHT_VALUES_MAX_AGE_MS + 1)
        self.assertIs(old["source"]["data_out"]["available"], False)
        self.assertIsNone(old["collection"]["settings_age_ms"])
        current = build(self.edge, light_result(gps="Fixed"), light_age_ms=ts.LIGHT_VALUES_MAX_AGE_MS)
        self.assertIs(current["data_out_light"]["expired"], False)
        self.assertEqual(current["settings"]["fields"]["center_freq"], 433.92)

    def test_with_source_marks_data_out_answers(self) -> None:
        answer = ts.with_source({"status": {"available": True}}, None, ["MQTT_HEALTH_STALE"])
        self.assertEqual((answer["source"]["kind"], answer["source"]["reason"]), ("data_out", "MQTT_HEALTH_STALE"))
        none = ts.with_source({"status": {"available": False}}, None, [])
        self.assertEqual(none["source"]["kind"], "none")
        self.assertEqual(none["source"]["reasons"], ["MQTT_DISABLED", "DATA_OUT_UNAVAILABLE"])


class CollectLightTests(unittest.TestCase):
    def test_light_read_reads_status_settings_and_xml_only(self) -> None:
        gets: List[str] = []
        now = collector.now_ms()
        bodies = {
            collector.PATH_STATUS: make_status(now),
            collector.PATH_SETTINGS: json.dumps({"center_freq": 433.92}).encode(),
            collector.PATH_XML: make_xml(now),
        }

        def fetcher(base_url: str, path: str, timeout: float, max_body: int) -> collector.FetchedResource:
            gets.append(path)
            return collector.FetchedResource(path, base_url + path, True, 200, None, bodies[path], collector.now_ms())

        cache = collector.SettingsCache()
        result = collector.collect_light(BASE_URL, fetcher=fetcher, settings_cache=cache, total_budget_s=4.0)
        self.assertEqual(sorted(gets), sorted(bodies))
        self.assertTrue(result["status"]["available"])
        self.assertEqual(result["settings"]["fields"]["center_freq"], 433.92)
        self.assertIs(result["xml"]["freshness"]["fresh"], True)
        self.assertEqual(result["xml"]["canonical_angle_deg"], 211.0)
        self.assertNotIn(collector.PATH_CSV, result["resources"])
        # settings.json is reused like a full collection's.
        gets.clear()
        again = collector.collect_light(BASE_URL, fetcher=fetcher, settings_cache=cache, total_budget_s=4.0)
        self.assertNotIn(collector.PATH_SETTINGS, gets)
        self.assertTrue(again["settings"]["reused"])
        gets.clear()
        collector.collect_light(BASE_URL, fetcher=fetcher, settings_cache=cache, fresh_settings=True, total_budget_s=4.0)
        self.assertIn(collector.PATH_SETTINGS, gets)

    def test_a_retune_shown_by_doa_xml_reads_settings_again(self) -> None:
        gets: List[str] = []
        now = collector.now_ms()
        bodies = {
            collector.PATH_STATUS: make_status(now),
            collector.PATH_SETTINGS: json.dumps({"center_freq": 416.588}).encode(),
            collector.PATH_XML: make_xml(now),
        }

        def fetcher(base_url: str, path: str, timeout: float, max_body: int) -> collector.FetchedResource:
            gets.append(path)
            return collector.FetchedResource(path, base_url + path, True, 200, None, bodies[path], collector.now_ms())

        cache = collector.SettingsCache()
        first = collector.collect_light(BASE_URL, fetcher=fetcher, settings_cache=cache, total_budget_s=4.0)
        self.assertEqual(first["settings"]["fields"]["center_freq"], 416.588)
        # The node is retuned: settings.json and doa.xml FREQUENCY move, the
        # status.json values the cache checks do not.
        bodies[collector.PATH_SETTINGS] = json.dumps({"center_freq": 433.92}).encode()
        bodies[collector.PATH_XML] = make_xml(now, frequency_mhz="433.92")
        gets.clear()
        second = collector.collect_light(BASE_URL, fetcher=fetcher, settings_cache=cache, total_budget_s=4.0)
        self.assertEqual(second["xml"]["frequency_mhz"], 433.92)
        self.assertEqual(second["settings"]["fields"]["center_freq"], 433.92)
        self.assertIs(second["settings"]["reused"], False)
        self.assertEqual(gets.count(collector.PATH_SETTINGS), 1)
        # The new copy is cached with the new view: the next read reuses it.
        gets.clear()
        third = collector.collect_light(BASE_URL, fetcher=fetcher, settings_cache=cache, total_budget_s=4.0)
        self.assertNotIn(collector.PATH_SETTINGS, gets)
        self.assertEqual(third["settings"]["fields"]["center_freq"], 433.92)

    def test_an_unreachable_node_costs_one_get(self) -> None:
        gets: List[str] = []

        def fetcher(base_url: str, path: str, timeout: float, max_body: int) -> collector.FetchedResource:
            gets.append(path)
            return collector.FetchedResource(path, base_url + path, False, None, None, b"", collector.now_ms(),
                                             error="connection refused", error_kind="connection_refused")

        result = collector.collect_light(BASE_URL, fetcher=fetcher, total_budget_s=4.0)
        self.assertEqual(gets, [collector.PATH_STATUS])
        self.assertFalse(result["status"]["available"])
        self.assertFalse(result["settings"]["available"])
        self.assertTrue(result["collection"]["status_transport_failed"])


# ---------------------------------------------------------------------------
# The reader: when Data Out is read


class FakeLight:
    def __init__(self, clock: FakeClock) -> None:
        self.clock = clock
        self.calls: List[Tuple[str, bool]] = []
        self.error: Optional[BaseException] = None

    def __call__(self, base_url: str, fresh_settings: bool) -> Dict[str, Any]:
        self.calls.append((base_url, fresh_settings))
        if self.error is not None:
            raise self.error
        return {
            "completed_at_ms": 7_000_000 + len(self.calls),
            "status": {"available": True, "safe": {"gps_status": "Disabled"}},
            "settings": {"available": True, "fields": {"center_freq": 433.92 + len(self.calls)}, "reused": False,
                         "read_at_ms": 7_000_000 + len(self.calls)},
            "collection": {"settings_reused": False, "settings_age_ms": 0},
            "resources": {},
            "xml": {"available": False},
            "signal_quality": None,
        }


class FakeFull:
    def __init__(self) -> None:
        self.calls: List[Tuple[str, bool]] = []
        self.status_available = True

    def __call__(self, base_url: str, fresh_settings: bool) -> Dict[str, Any]:
        self.calls.append((base_url, fresh_settings))
        return {"completed_at_ms": 5_000_000, "status": {"available": self.status_available},
                "overall_state": "UNVERIFIED", "collection": {}}


class ReaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = FakeClock()
        self.ms = ManualMs()
        self.edge = Edge(self.ms)
        self.full = FakeFull()
        self.light = FakeLight(self.clock)
        self.disabled = False
        self.reader = DataOutReader(
            self.full, lambda: 2, wait_timeout_s=5.0, clock=self.clock, wall_ms=lambda: 9_000_000,
            console_base_url=lambda: BASE_URL, collect_light=self.light, mqtt_view=self.current_view,
            run_background=lambda function: function(),
        )

    def current_view(self) -> Optional[Dict[str, Any]]:
        return None if self.disabled else self.edge.view()

    def advance(self, seconds: float) -> None:
        self.clock.advance(seconds)
        self.ms.now += int(seconds * 1000)

    def keep_alive(self) -> None:
        self.edge.health()
        self.edge.doa()
        self.edge.angular()

    def test_no_full_collection_while_mqtt_is_fresh(self) -> None:
        self.edge.live()
        kinds = []
        for _ in range(60):
            answer = self.reader.snapshot(BASE_URL, SnapshotRequest())
            kinds.append(answer["source"]["kind"])
            self.assertEqual(answer["collection"]["age_ms"], 0)
            self.advance(2.0)
            self.keep_alive()
        self.assertEqual(set(kinds), {"mqtt"})
        self.assertEqual(self.full.calls, [])
        # 120 s at 2 s polls: a light read at 0, 30, 60 and 90 s.
        self.assertEqual(len(self.light.calls), 4)

    def test_read_reason_decides_light_reads(self) -> None:
        reason = self.reader.read_reason
        mark = ("227c8be2", 1)
        plain = SnapshotRequest()
        self.assertEqual(reason(None, plain, 0.0, 2.0, mqtt=mark), "light-first")
        last = dor._Collection("0badc0de-1", 0.0, False, mark, "light-first")
        last.result = {"collection": {"settings_reused": False}}
        self.assertIsNone(reason(last, plain, 29.9, 2.0, mqtt=mark))
        self.assertEqual(reason(last, plain, 30.0, 2.0, mqtt=mark), "light-interval")
        # A Refresh reads no Data Out while MQTT is fresh.
        self.assertIsNone(reason(last, SnapshotRequest(refresh=True), 5.0, 2.0, mqtt=mark))
        self.assertEqual(reason(last, SnapshotRequest(fresh_settings=True), 1.0, 2.0, mqtt=mark), "light-fresh_settings")
        self.assertIsNone(reason(last, SnapshotRequest(fresh_settings=True), 0.5, 2.0, mqtt=mark))
        # A new config revision or session reads settings once a second at most.
        self.assertEqual(reason(last, plain, 1.0, 2.0, mqtt=("227c8be2", 2)), "light-config")
        self.assertIsNone(reason(last, plain, 0.5, 2.0, mqtt=("227c8be2", 2)))
        self.assertEqual(reason(last, plain, 1.0, 2.0, mqtt=("0badcafe", 1)), "light-config")
        # Without MQTT the Data Out rules are unchanged.
        self.assertEqual(reason(None, plain, 0.0, 2.0), "first")

    def test_a_config_change_reads_settings_once(self) -> None:
        self.edge.live()
        self.reader.snapshot(BASE_URL)
        self.assertEqual(len(self.light.calls), 1)
        self.advance(3.0)
        self.edge.hello(cfg=2)
        self.keep_alive()
        answer = self.reader.snapshot(BASE_URL)
        self.assertEqual(len(self.light.calls), 2)
        self.assertEqual(answer["data_out_light"]["reason"], "light-config")
        # It reads settings.json, never the copy from before the change.
        self.assertEqual(self.light.calls, [(BASE_URL, False), (BASE_URL, True)])
        self.advance(2.0)
        self.keep_alive()
        self.reader.snapshot(BASE_URL)
        self.assertEqual(len(self.light.calls), 2)

    def test_cek_ulang_waits_for_settings_over_the_light_read(self) -> None:
        self.edge.live()
        self.reader.snapshot(BASE_URL)
        self.advance(2.0)
        self.keep_alive()
        answer = self.reader.snapshot(BASE_URL, SnapshotRequest(refresh=True, fresh_settings=True))
        self.assertEqual(self.light.calls[-1], (BASE_URL, True))
        self.assertEqual(answer["settings"]["fields"]["center_freq"], 433.92 + 2)
        self.assertEqual(answer["source"]["kind"], "mqtt")
        self.assertEqual(self.full.calls, [])

    def test_stale_mqtt_falls_back_to_a_full_read_and_back(self) -> None:
        self.edge.live()
        self.assertEqual(self.reader.snapshot(BASE_URL)["source"]["kind"], "mqtt")
        self.advance(9.0)
        answer = self.reader.snapshot(BASE_URL)
        self.assertEqual((answer["source"]["kind"], answer["source"]["reason"]), ("data_out", "MQTT_HEALTH_STALE"))
        self.assertEqual(len(self.full.calls), 1)
        self.assertEqual(answer["source"]["data_out"]["read"], "full")
        # Data Out keeps its own reuse window meanwhile.
        self.reader.snapshot(BASE_URL)
        self.assertEqual(len(self.full.calls), 1)
        self.advance(2.0)
        self.reader.snapshot(BASE_URL)
        self.assertEqual(len(self.full.calls), 2)
        # MQTT is fresh again: no more full reads.
        self.keep_alive()
        self.advance(2.0)
        self.keep_alive()
        self.assertEqual(self.reader.snapshot(BASE_URL)["source"]["kind"], "mqtt")
        self.assertEqual(len(self.full.calls), 2)

    def test_neither_source_is_none(self) -> None:
        self.disabled = True
        self.full.status_available = False
        answer = self.reader.snapshot(BASE_URL)
        self.assertEqual(answer["source"]["kind"], "none")
        self.assertEqual(answer["source"]["reasons"], ["MQTT_DISABLED", "DATA_OUT_UNAVAILABLE"])
        self.assertEqual(self.light.calls, [])

    def test_the_legacy_ui_reads_data_out(self) -> None:
        self.edge.live()
        answer = self.reader.snapshot(BASE_URL, SnapshotRequest(data_out_only=True))
        self.assertEqual((answer["source"]["kind"], answer["source"]["reason"]), ("data_out", "DATA_OUT_REQUESTED"))
        self.assertEqual(len(self.full.calls), 1)

    def test_a_failed_light_read_waits_for_the_interval(self) -> None:
        self.edge.live()
        self.light.error = collector.CollectorError("boom")
        answer = self.reader.snapshot(BASE_URL)
        self.assertEqual(answer["source"]["kind"], "mqtt")
        self.assertEqual(answer["data_out_light"]["error"], "boom")
        self.assertIs(answer["settings"]["available"], False)
        for _ in range(10):
            self.advance(2.0)
            self.keep_alive()
            self.reader.snapshot(BASE_URL)
        self.assertEqual(len(self.light.calls), 1)

    def test_a_light_read_from_before_a_fallback_is_not_current(self) -> None:
        pending: List[Callable[[], None]] = []
        self.reader = DataOutReader(
            self.full, lambda: 2, wait_timeout_s=5.0, clock=self.clock, wall_ms=lambda: 9_000_000,
            console_base_url=lambda: BASE_URL, collect_light=self.light, mqtt_view=self.current_view,
            run_background=pending.append,
        )
        self.edge.live()
        self.reader.snapshot(BASE_URL)
        pending.pop()()
        answer = self.reader.snapshot(BASE_URL)
        self.assertIs(answer["settings"]["available"], True)
        # An hour on Data Out, then MQTT is fresh again.
        self.advance(3_600.0)
        self.assertEqual(self.reader.snapshot(BASE_URL)["source"]["kind"], "data_out")
        self.keep_alive()
        answer = self.reader.snapshot(BASE_URL)
        self.assertEqual(answer["source"]["kind"], "mqtt")
        self.assertIs(answer["settings"]["available"], False)
        self.assertIs(answer["data_out_light"]["expired"], True)
        self.assertIs(answer["data_out_light"]["running"], True)
        self.assertIsNone(answer["data_out_light"]["xml"])
        pending.pop()()
        answer = self.reader.snapshot(BASE_URL)
        self.assertIs(answer["data_out_light"]["expired"], False)
        self.assertEqual(answer["settings"]["fields"]["center_freq"], 433.92 + 2)

    def test_answers_carry_the_read_facts(self) -> None:
        self.edge.live()
        answer = self.reader.snapshot(BASE_URL)
        collection = answer["collection"]
        self.assertTrue(dor.valid_collection_id(collection["id"]))
        self.assertEqual((collection["refresh_seconds"], collection["console_base_url"]), (2, BASE_URL))
        again = self.reader.snapshot(BASE_URL)
        self.assertNotEqual(again["collection"]["id"], collection["id"])


# ---------------------------------------------------------------------------
# HTTP: a real console with a fake monitor and a loopback Data Out


class FakeMonitor:
    """The monitor slot of the console, answering from a real RDF Node store."""

    host = "127.0.0.1"
    port = 1883
    transport = "tcp"
    ws_path = "/mqtt"

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.edge = Edge(collector.now_ms)

    def start(self) -> None:
        return None

    def stop(self) -> None:
        return None

    def rdf_node_view(self) -> Dict[str, Any]:
        with self.lock:
            return self.edge.view()


class DeadNode:
    """Data Out that refuses every connection, counting the attempts."""

    def __init__(self) -> None:
        self.gets: collections.Counter = collections.Counter()

    def fetcher(self, base_url: str, path: str, timeout: float, max_body: int) -> collector.FetchedResource:
        self.gets[path] += 1
        return collector.FetchedResource(path, base_url + path, False, None, None, b"", collector.now_ms(),
                                         error="connection refused", error_kind="connection_refused", elapsed_ms=0)


class SourceHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        quiet = patch.object(ground_console.ConsoleHandler, "log_message", lambda *_args: None)
        quiet.start()
        self.addCleanup(quiet.stop)
        self.monitor = FakeMonitor()

    def start_console(self, fetcher: Callable[..., collector.FetchedResource]) -> Tuple[ground_console.GroundConsoleServer, int]:
        temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-telemetry-source-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        server = ground_console.GroundConsoleServer(
            ("127.0.0.1", 0),
            BASE_URL,
            mqtt_monitor=self.monitor,
            config_path=str(root / "console.json"),
            branding_path=str(root / "branding.json"),
            receiver_data_dir=root / "receiver",
            data_out_fetcher=fetcher,
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def close() -> None:
            server.shutdown()
            thread.join(5)
            server.server_close()

        self.addCleanup(close)
        return server, server.server_address[1]

    @staticmethod
    def get(port: int, query: str = "") -> Dict[str, Any]:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            connection.request("GET", "/api/snapshot?base_url=" + quote(BASE_URL, safe="") + query)
            response = connection.getresponse()
            body = response.read()
            if response.status != 200:
                raise AssertionError(f"HTTP {response.status}: {body[:200]!r}")
            return json.loads(body)
        finally:
            connection.close()

    def live_edge(self) -> None:
        with self.monitor.lock:
            self.monitor.edge.live()

    @staticmethod
    def wait_for(condition: Callable[[], bool], timeout: float = 5.0) -> None:
        end = time.monotonic() + timeout
        while not condition():
            if time.monotonic() > end:
                raise AssertionError("condition not met in time")
            time.sleep(0.02)

    def test_data_out_dead_and_mqtt_healthy_shows_doa_with_the_mqtt_badge(self) -> None:
        node = DeadNode()
        _server, port = self.start_console(node.fetcher)
        self.live_edge()
        answer = self.get(port)
        self.assertEqual(answer["source"]["kind"], "mqtt")
        view = answer["doa_candidates"]["mqtt"]
        self.assertEqual(view["canonical_angle_deg"], THETA)
        self.assertIs(view["freshness"]["fresh"], True)
        self.assertEqual(len(view["angular_power_db"]), 360)
        self.assertEqual(answer["overall_state"], "UNVERIFIED")
        self.assertEqual(answer["publication_gate"]["state"], "BLOCKED")
        # The light read tried status.json once and skipped the rest.
        self.wait_for(lambda: self.get(port)["data_out_light"]["read_at_ms"] is not None)
        later = self.get(port)
        self.assertEqual(later["source"]["kind"], "mqtt")
        self.assertIs(later["data_out_light"]["status"]["available"], False)
        self.assertEqual(sum(node.gets.values()), 1)
        self.assertEqual(node.gets[collector.PATH_CSV], 0)

    def test_mqtt_stale_and_data_out_healthy_falls_back(self) -> None:
        node = LoopbackNode()
        self.addCleanup(node.close)
        _server, port = self.start_console(node.fetcher)
        with self.monitor.lock:
            # The last health arrived 9 s ago.
            old = collector.now_ms() - 9_000
            self.monitor.edge.hello()
            self.monitor.edge.health(at=old)
        answer = self.get(port)
        self.assertEqual((answer["source"]["kind"], answer["source"]["reason"]), ("data_out", "MQTT_HEALTH_STALE"))
        self.assertEqual(sorted(answer["doa_candidates"]), ["csv", "xml"])
        self.assertTrue(answer["doa_candidates"]["csv"]["available"])
        self.assertGreaterEqual(node.gets[collector.PATH_CSV], 1)

    def test_the_light_read_stays_within_its_interval(self) -> None:
        node = LoopbackNode()
        self.addCleanup(node.close)
        server, port = self.start_console(node.fetcher)
        clock = FakeClock(time.monotonic())
        server.data_out.clock = clock
        self.live_edge()
        self.get(port)
        self.wait_for(lambda: self.get(port)["settings"].get("available") is True)
        answer = self.get(port)
        self.assertEqual(answer["settings"]["fields"]["center_freq"], node.center_freq)
        # 29 s of 2 s polls: no other Data Out read, DOA_value.html never.
        for _ in range(14):
            clock.advance(2.0)
            with self.monitor.lock:
                self.monitor.edge.health()
            self.assertEqual(self.get(port)["source"]["kind"], "mqtt")
        self.assertEqual(dict(node.gets), {collector.PATH_STATUS: 1, collector.PATH_SETTINGS: 1, collector.PATH_XML: 1})
        # At 30 s the next light read runs.
        clock.advance(2.0)
        with self.monitor.lock:
            self.monitor.edge.health()
        self.get(port)
        self.wait_for(lambda: node.gets[collector.PATH_STATUS] == 2)
        self.assertEqual(node.gets[collector.PATH_CSV], 0)
        # A Refresh reads nothing; Kontrol's Cek ulang reads settings.json at once.
        self.get(port, "&refresh=1")
        node.center_freq = 433.92
        checked = self.get(port, "&refresh=1&fresh_settings=1")
        self.assertEqual(checked["settings"]["fields"]["center_freq"], 433.92)
        self.assertEqual(node.gets[collector.PATH_STATUS], 3)
        self.assertEqual(node.gets[collector.PATH_CSV], 0)

    def test_the_lan_view_reads_the_same_source(self) -> None:
        node = DeadNode()
        server, _port = self.start_console(node.fetcher)
        self.live_edge()
        answer = server.collect_snapshot(BASE_URL, ground_console._snapshot_request(
            {"refresh": ["1"], "fresh_settings": ["1"], "source": ["data_out"]},
            fresh_settings=False, refresh=False, data_out_only=False,
        ))
        self.assertEqual(answer["source"]["kind"], "mqtt")


if __name__ == "__main__":
    unittest.main()
