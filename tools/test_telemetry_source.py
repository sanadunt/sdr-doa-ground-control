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

    def hello(self, *, angle: Optional[str] = "theta_mirror", sid: Optional[str] = None, cfg: int = 1,
              rf: Optional[Dict[str, Any]] = None, nav: Optional[Dict[str, Any]] = None) -> None:
        state = dict(self.state, t=self.now_ms(), cfg=cfg)
        state.pop("rf", None)
        if rf is not None:
            state["rf"] = rf
        if sid is not None:
            state.update(sid=sid, boot=f"boot-{sid}", instance=f"instance-{sid}")
            self.q.clear()
        self.state = state
        self.send("state", state)
        if angle is not None:
            capabilities = dict(fixture("capabilities.json"), sid=state["sid"], boot=state["boot"],
                                instance=state["instance"], angle=angle)
            if nav is not None:
                capabilities["nav"] = nav
            self.send("capabilities", capabilities)

    def health(self, *, daq: int = 1, q: Optional[int] = None, at: Optional[int] = None,
               nav: Optional[Dict[str, Any]] = None, why: Optional[List[str]] = None) -> Dict[str, Any]:
        t = self.now_ms() if at is None else at
        payload = dict(
            fixture("telemetry-health.json"), sid=self.state["sid"], t=t, daq=daq,
            q=self.next_q("health") if q is None else q, rev=self.state["cfg"], **(nav or {}),
        )
        if why is not None:
            payload["why"] = why
        return self.send("telemetry/health", payload, at=at)

    def detail(self, *, ovr: Any = "absent", at: Optional[int] = None) -> Dict[str, Any]:
        payload = dict(fixture("telemetry-health-detail.json"), sid=self.state["sid"], t=self.now_ms() if at is None else at)
        if ovr != "absent":
            payload["ovr"] = ovr
        return self.send("telemetry/health/detail", payload, at=at)

    def doa(self, theta: float = THETA, *, ok: int = 1, angle: str = "theta_mirror", f: int = FREQUENCY_HZ,
            q: Optional[int] = None, at: Optional[int] = None, stamp: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raw = (360.0 - theta) % 360.0
        if ok == 1:
            payload = dict(fixture("telemetry-doa.ok1.json"), a=theta if angle == "theta_mirror" else raw)
        else:
            payload = dict(fixture("telemetry-doa.ok0.json"), a=raw)
        payload.update(sid=self.state["sid"], t=self.now_ms() if at is None else at, f=f, rev=self.state["cfg"],
                       q=self.next_q("frame") if q is None else q, **(stamp or {}))
        return self.send("telemetry/doa", payload, at=at)

    def angular(self, theta: float = THETA, *, flags: int = 63, q: Optional[int] = None,
                frequency_hz: int = FREQUENCY_HZ, revision: Optional[int] = None, topic: str = "telemetry/angular",
                at: Optional[int] = None, heading: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        payload = dict(fixture("telemetry-angular.live.json"))
        payload.update(
            sid=self.state["sid"], timestamp_ms=self.now_ms() if at is None else at, flags=flags,
            q=self.q["frame"] if q is None else q, frequency_hz=frequency_hz,
            revision=self.state["cfg"] if revision is None else revision,
            raw_doa_deg=(360.0 - theta) % 360.0, values=peaked(theta), **(heading or {}),
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

    def view(self, at: Optional[int] = None, connection: str = "ready", link: Optional[str] = None) -> Dict[str, Any]:
        now = self.now_ms() if at is None else at
        # As the monitor does: the link sets the store's Angular and detail windows.
        self.store.set_link(link)
        return {"now_ms": now, "connection": connection, "node_id": NODE, "node": self.store.node_view(now), "link": link}


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


# The edge's own 1.6 example (docs/MQTT_TOPIC_SUMMARY.md of rdf-indicator-raspberry).
NAV_FIX = {"hdg": 201.1, "hs": "OK", "gs": "FIX", "fix": 3, "sat": 7, "lat": -6.20576, "lon": 106.81,
           "alt": 715.9, "sog": 0.1, "cog": None}


# state.rf of RDF Node 1.7.0 after the 103.1 MHz retune on 2 November.
RF_17 = {"f": 103_100_000, "vfo": 103_100_000, "g": 12.5, "bw": 12_500, "sq": -100}

# capabilities.nav of RDF Node 1.10 with compass and GPS on and publish_position at its default (off).
CAPS_NAV_110 = {"compass": True, "gps": True, "position": False, "heading": "compass"}


def lora_110_held(clock: "ManualMs") -> Edge:
    """Edge 1.10 over LoRa: a LIVE DoA (h=100) whose curve is a frame 15 s old taken at heading 90.

    The node turned 10 degrees since the frame, so the frame's peak (150) lies
    10 degrees off this DoA's theta_0 (160) in array degrees and on it in
    bearings (300): the curve is SAME_CONFIG, held, drawn turned by its own heading.
    """
    edge = Edge(clock)
    clock.now -= 15_000
    edge.store.set_link("lora")
    edge.hello(nav=CAPS_NAV_110)
    edge.health(nav=NAV_FIX, why=[])
    edge.doa(150.0, stamp={"h": 90.0, "hsrc": "C", "b": 300.0})
    edge.angular(150.0, heading={"heading_deg": 90.0, "heading_source": "C"})
    clock.now += 15_000
    edge.health(nav=NAV_FIX, why=[])
    edge.doa(THETA, stamp={"h": 100.0, "hsrc": "C", "b": 300.0})
    return edge


def lora_110_unverified(clock: "ManualMs") -> Edge:
    """Edge 1.10 over LoRa during a config.patch: only an ok=0 DoA, with the heading it went out with.

    theta_0 30 and h 100 make the unverified bearing 70; the edge's reason
    (CONTROL_IN_PROGRESS) comes in ``reason`` alone and health.why says the same.
    """
    edge = Edge(clock)
    edge.store.set_link("lora")
    edge.hello(nav=CAPS_NAV_110)
    edge.health(nav=NAV_FIX, why=["CONTROL_IN_PROGRESS"])
    raw = dict(fixture("telemetry-doa.ok0.json"), sid=edge.state["sid"], t=clock(), f=FREQUENCY_HZ,
               rev=edge.state["cfg"], q=edge.next_q("frame"), a=330.0, h=100.0, hsrc="C",
               reason=["CONTROL_IN_PROGRESS"])
    raw.pop("validation_reasons", None)
    edge.send("telemetry/doa", raw)
    return edge


def fixture_answers() -> Dict[str, Dict[str, Any]]:
    """The MQTT answers the frontend tests read, built at a fixed time."""
    answers: Dict[str, Dict[str, Any]] = {}

    def answer(edge: Edge, light: Optional[Dict[str, Any]], index: int, link: Optional[str] = None,
               held: Tuple[str, ...] = ()) -> Dict[str, Any]:
        built = ts.mqtt_snapshot(edge.view(link=link), light, base_url=BASE_URL, light_age_ms=None if light is None else 2_000,
                                 light_meta={"interval_s": 30.0, "reason": "light-first", "running": False, "error": None},
                                 held=held)
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
    # Over the LoRa serial link: no Data Out at all, the position from the health nav fields (contract 1.6).
    lora = Edge(ManualMs(FIXED_NOW))
    lora.hello()
    lora.health(nav=NAV_FIX)
    lora.doa()
    lora.angular()
    answers["mqtt-lora-nav.json"] = answer(lora, None, 4, link="lora")
    # Edge 1.7 over LoRa as on 2 November: the SDR settings in state.rf, the
    # overdrive in health/detail, and only an UNVERIFIED (ok=0) DoA.
    rf = Edge(ManualMs(FIXED_NOW))
    rf.hello(rf=RF_17, cfg=298)
    rf.health(nav=NAV_FIX)
    rf.detail(ovr=False)
    rf.doa(ok=0, f=103_100_000)
    rf.angular(flags=23, frequency_hz=103_100_000)
    answers["mqtt-lora-rf.json"] = answer(rf, None, 5, link="lora")
    # Edge 1.10 over LoRa: a held curve turned by its own heading, and an ok=0
    # sample with its own heading, reason, health.why and capabilities.nav.
    answers["mqtt-lora-held.json"] = answer(lora_110_held(ManualMs(FIXED_NOW)), None, 6, link="lora")
    answers["mqtt-lora-unverified-heading.json"] = answer(lora_110_unverified(ManualMs(FIXED_NOW)), None, 7, link="lora")
    # Over LoRa as on 3 November after a retune: the KrakenSDR DAQ does not
    # sync (daq 2, delay and IQ sync false) while health, compass and GPS keep coming.
    unsynced = Edge(ManualMs(FIXED_NOW))
    unsynced.store.set_link("lora")
    unsynced.hello(nav=CAPS_NAV_110)
    unsynced.health(daq=2, nav=NAV_FIX, why=["EMPTY_CSV", "NO_RECORD", "DAQ_NOT_HEALTHY", "DOA_FILE_NOT_UPDATING"])
    unsynced.send("telemetry/health/detail", dict(fixture("telemetry-health-detail.json"), sid=unsynced.state["sid"],
                                                  t=unsynced.now_ms(), sync=[True, False, False]))
    answers["mqtt-lora-daq-unhealthy.json"] = answer(unsynced, None, 8, link="lora", held=("MQTT_DAQ_NOT_HEALTHY",))
    # link_mode "lora" when the radio has brought nothing for 2 minutes: the
    # last health (compass, GPS) and the last LIVE DoA, held with their age.
    quiet_clock = ManualMs(FIXED_NOW - 120_000)
    quiet = Edge(quiet_clock)
    quiet.store.set_link("lora")
    quiet.hello(nav=CAPS_NAV_110)
    quiet.health(nav=NAV_FIX)
    quiet.doa()
    quiet.angular()
    quiet_clock.now = FIXED_NOW
    answers["mqtt-lora-held-health.json"] = answer(quiet, None, 9, link="lora", held=("MQTT_HEALTH_STALE",))
    return answers


def write_source_fixtures() -> None:
    """Rewrite tools/fixtures/telemetry-source/ after an intended change of the answer."""
    SOURCE_FIXTURES.mkdir(parents=True, exist_ok=True)
    for name, body in fixture_answers().items():
        (SOURCE_FIXTURES / name).write_text(json.dumps(body, indent=1, sort_keys=True) + "\n", encoding="utf-8")


class NavTests(unittest.TestCase):
    def build(self, nav: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        edge = Edge(ManualMs(FIXED_NOW))
        edge.hello()
        edge.health(nav=nav)
        edge.doa()
        edge.angular()
        return ts.mqtt_snapshot(edge.view(), None, base_url=BASE_URL, light_age_ms=None,
                                light_meta={"interval_s": 30.0, "reason": None, "running": False, "error": None})

    def test_no_nav_without_the_fields(self) -> None:
        self.assertIsNone(self.build(None)["nav"])

    def test_nav_from_health(self) -> None:
        nav = self.build(NAV_FIX)["nav"]
        self.assertEqual(nav, {
            "source": "telemetry/health", "t": FIXED_NOW, "age_ms": 0, "stale": False, "gps_state": "FIX", "fix": 3, "satellites": 7,
            "latitude": -6.20576, "longitude": 106.81, "altitude_m": 715.9, "speed_mps": 0.1, "course_deg": None,
            "heading_deg": 201.1, "compass_state": "OK",
        })

    def test_link_is_named_only_for_lora(self) -> None:
        edge = Edge(ManualMs(FIXED_NOW)).live()
        meta = {"interval_s": 30.0, "reason": None, "running": False, "error": None}
        for link, expected in ((None, None), ("lora", "lora"), ("ppp", None)):
            built = ts.mqtt_snapshot(edge.view(link=link), None, base_url=BASE_URL, light_age_ms=None, light_meta=meta)
            self.assertEqual(built["source"]["link"], expected)

    def test_overdrive_over_lora_is_a_property_of_the_link(self) -> None:
        edge = Edge(ManualMs(FIXED_NOW)).live()
        meta = {"interval_s": 30.0, "reason": None, "running": False, "error": None}
        for link, reason, error in ((None, ts.ADC_OVERDRIVE_UNKNOWN, "settings.json not read yet"),
                                    ("lora", ts.ADC_OVERDRIVE_NOT_OVER_LORA, "settings.json is not read over Telemetry LoRa")):
            built = ts.mqtt_snapshot(edge.view(link=link), None, base_url=BASE_URL, light_age_ms=None, light_meta=meta)
            reasons = built["publication_gate"]["reasons"]
            self.assertIn(reason, reasons)
            self.assertNotIn(ts.ADC_OVERDRIVE_NOT_OVER_LORA if link is None else ts.ADC_OVERDRIVE_UNKNOWN, reasons)
            self.assertIsNone(built["publication_gate"]["checks"]["adc_not_overdriven"])
            self.assertEqual(built["settings"]["error"], error)

    def test_compass_only(self) -> None:
        nav = self.build({"hdg": None, "hs": "NO_REPLY"})["nav"]
        self.assertEqual((nav["compass_state"], nav["heading_deg"], nav["latitude"], nav["gps_state"]), ("NO_REPLY", None, None, None))


class Edge110Tests(unittest.TestCase):
    """Contract 1.10: the heading, bearing and position on each DoA, and the position estimate."""

    META = {"interval_s": 30.0, "reason": None, "running": False, "error": None}

    def test_doa_stamp_reaches_the_candidate(self) -> None:
        edge = Edge(ManualMs(FIXED_NOW))
        edge.hello(); edge.health()
        edge.doa(stamp={"h": 84.3, "hsrc": "C", "b": 294.3, "lat": -6.92977, "lon": 107.71142})
        edge.angular()
        candidate = build(edge)["doa_candidates"]["mqtt"]
        self.assertEqual((candidate["array_heading_deg"], candidate["heading_source"], candidate["bearing_deg"],
                          candidate["sample_latitude"], candidate["sample_longitude"]),
                         (84.3, "COMPASS", 294.3, -6.92977, 107.71142))

    def test_an_older_edge_has_no_stamp_and_no_estimate(self) -> None:
        built = build(Edge(ManualMs(FIXED_NOW)).live())
        candidate = built["doa_candidates"]["mqtt"]
        self.assertIsNone(candidate["bearing_deg"])
        self.assertIsNone(candidate["array_heading_deg"])
        self.assertIsNone(built["position_estimate"])

    def test_the_estimate_passes_through(self) -> None:
        edge = Edge(ManualMs(FIXED_NOW)).live()
        view = dict(edge.view(), position_estimate={"state": "NEED_MOVEMENT", "samples": 3})
        built = ts.mqtt_snapshot(view, None, base_url=BASE_URL, light_age_ms=None, light_meta=self.META)
        self.assertEqual(built["position_estimate"], {"state": "NEED_MOVEMENT", "samples": 3})

    def lora(self, edge: Edge) -> Dict[str, Any]:
        return ts.mqtt_snapshot(edge.view(link="lora"), None, base_url=BASE_URL, light_age_ms=None, light_meta=self.META)

    def test_an_unverified_sample_carries_its_own_heading(self) -> None:
        # The edge stamps h on ok=0 too; the dashed bearing is h - theta_0 of
        # that same sample (100 - 30 = 70), never the raw angle with offset 0.
        snapshot = self.lora(lora_110_unverified(ManualMs(FIXED_NOW)))
        unverified = snapshot["mqtt"]["doa_unverified"]
        self.assertIs(snapshot["doa_candidates"]["mqtt"]["available"], False)
        self.assertEqual((unverified["canonical_angle_deg"], unverified["array_heading_deg"], unverified["heading_source"],
                          unverified["bearing_deg"]), (30.0, 100.0, "COMPASS", 70.0))
        self.assertEqual(unverified["received_at_ms"], FIXED_NOW)
        # Edge 1.10 sends this reason in reason alone: it becomes the validation reasons, and health.why says it too.
        self.assertEqual((unverified["validation_reasons"], unverified["reason"]),
                         (["CONTROL_IN_PROGRESS"], ["CONTROL_IN_PROGRESS"]))
        self.assertEqual(snapshot["mqtt"]["health"]["why"], ["CONTROL_IN_PROGRESS"])
        self.assertEqual(snapshot["source"]["mqtt"]["health_why"], ["CONTROL_IN_PROGRESS"])
        self.assertEqual(snapshot["mqtt"]["capabilities"]["nav"],
                         {"compass": True, "gps": True, "position": False, "heading": "compass"})
        # Without a heading source (h null) or from an older edge there is no bearing.
        edge = Edge(ManualMs(FIXED_NOW))
        edge.hello(); edge.health()
        edge.doa(30.0, ok=0, stamp={"h": None, "hsrc": None})
        unverified = build(edge)["mqtt"]["doa_unverified"]
        self.assertEqual((unverified["array_heading_deg"], unverified["heading_source"], unverified["bearing_deg"]),
                         (None, None, None))
        self.assertIsNone(build(edge)["mqtt"]["health"]["why"])

    def test_health_why_reaches_an_answer_mqtt_does_not_give(self) -> None:
        # Over LoRa with the DAQ down there is no MQTT answer and no Data Out:
        # the source block still says why the edge has no LIVE DoA.
        edge = Edge(ManualMs(FIXED_NOW))
        edge.hello()
        edge.health(daq=0, why=["DAQ_NOT_HEALTHY", "EMPTY_CSV"])
        view = edge.view(link="lora")
        fresh, reasons = ts.mqtt_freshness(view)
        answer = ts.with_source({"status": {"available": False}}, view, reasons, over_lora=True)
        self.assertEqual((fresh, answer["source"]["reason"]), (False, "MQTT_DAQ_NOT_HEALTHY"))
        self.assertEqual(answer["source"]["mqtt"]["health_why"], ["DAQ_NOT_HEALTHY", "EMPTY_CSV"])
        self.assertIsNone(ts.mqtt_summary(Edge(ManualMs(FIXED_NOW)).live().view(), True)["health_why"])

    def test_a_live_and_an_unverified_sample_each_keep_their_receipt_time(self) -> None:
        # During a patch the last LIVE DoA ages while ok=0 samples keep coming:
        # both views say when they arrived, so the newer one can be told apart.
        clock = ManualMs(FIXED_NOW)
        edge = Edge(clock)
        edge.hello(); edge.health()
        edge.doa(60.0, stamp={"h": 10.0, "hsrc": "C", "b": 310.0})
        clock.now += 40_000
        edge.health()
        edge.doa(200.0, ok=0, stamp={"h": 20.0, "hsrc": "C"})
        snapshot = build(edge)
        candidate = snapshot["doa_candidates"]["mqtt"]
        unverified = snapshot["mqtt"]["doa_unverified"]
        self.assertIs(candidate["freshness"]["fresh"], False)
        self.assertEqual((candidate["received_at_ms"], candidate["array_heading_deg"]), (FIXED_NOW, 10.0))
        self.assertEqual((unverified["received_at_ms"], unverified["array_heading_deg"], unverified["bearing_deg"]),
                         (FIXED_NOW + 40_000, 20.0, 180.0))
        self.assertIs(unverified["stale"], False)

    def test_over_lora_a_held_curve_counts_and_is_marked(self) -> None:
        # The bridge sends Angular at most every 20 s: over LoRa a frame counts
        # for 45 s, marked held once it is older than the 10 s of a direct link.
        clock = ManualMs(FIXED_NOW)
        edge = Edge(clock)
        edge.store.set_link("lora")
        edge.hello(); edge.health()
        edge.doa(); edge.angular()
        for second in (5, 10, 15, 30, 45):
            clock.now = FIXED_NOW + second * 1_000
            edge.health(); edge.doa()
            candidate = self.lora(edge)["doa_candidates"]["mqtt"]
            with self.subTest(second=second):
                self.assertEqual(candidate["angular_pairing"], "SAME_CONFIG")
                self.assertIn("angular_power_db", candidate)
                self.assertIs(candidate["angular_held"], second > 10)
                self.assertIs(candidate["angular_frame"]["held"], second > 10)
                self.assertEqual(candidate["angular_frame"]["max_age_ms"], 45_000)
        clock.now = FIXED_NOW + 46_000
        edge.health(); edge.doa()
        candidate = self.lora(edge)["doa_candidates"]["mqtt"]
        self.assertEqual(candidate["angular_pairing"], "NOT_LIVE")
        self.assertIs(candidate["angular_held"], False)
        # The same 15 s frame over a direct link is not LIVE: no curve.
        clock = ManualMs(FIXED_NOW)
        edge = Edge(clock)
        edge.hello(); edge.health(); edge.doa(); edge.angular()
        clock.now += 15_000
        edge.health(); edge.doa()
        candidate = build(edge)["doa_candidates"]["mqtt"]
        self.assertEqual((candidate["angular_pairing"], candidate["angular_frame"]["max_age_ms"]), ("NOT_LIVE", 10_000))
        self.assertNotIn("angular_power_db", candidate)

    def test_a_held_curve_keeps_the_pairing_guards(self) -> None:
        clock = ManualMs(FIXED_NOW)
        edge = Edge(clock)
        edge.store.set_link("lora")
        edge.hello(); edge.health()
        edge.doa(100.0); edge.angular(100.0)
        clock.now += 20_000
        edge.health()
        edge.doa(130.0)
        self.assertEqual(self.lora(edge)["doa_candidates"]["mqtt"]["angular_pairing"], "PEAK_MOVED")
        edge.doa(100.0, f=FREQUENCY_HZ + 25_000)
        self.assertEqual(self.lora(edge)["doa_candidates"]["mqtt"]["angular_pairing"], "OTHER_FREQUENCY")
        edge.hello(cfg=2)
        edge.health()
        edge.doa(100.0)
        self.assertEqual(self.lora(edge)["doa_candidates"]["mqtt"]["angular_pairing"], "OTHER_REVISION")

    def test_a_turned_node_keeps_its_curve_by_the_frames_own_heading(self) -> None:
        snapshot = self.lora(lora_110_held(ManualMs(FIXED_NOW)))
        candidate = snapshot["doa_candidates"]["mqtt"]
        # Array degrees 150 against 160, the same bearing (300): one direction, kept.
        self.assertEqual(candidate["angular_pairing"], "SAME_CONFIG")
        self.assertEqual((candidate["angular_heading_deg"], candidate["angular_heading_source"]), (90.0, "COMPASS"))
        self.assertEqual((candidate["angular_frame"]["heading_deg"], candidate["angular_frame"]["heading_turn_deg"]),
                         (90.0, 10.0))
        self.assertEqual((candidate["angular_frame"]["doa_peak_distance_deg"], candidate["angular_peak_angle_distance_deg"]),
                         (0.0, 0.0))
        self.assertIs(candidate["angular_peak_angle_consistent"], True)
        self.assertEqual(snapshot["mqtt"]["angular"]["heading_deg"], 90.0)
        # A frame from an edge before 1.10 carries no heading: the array-degree guard decides, as before.
        clock = ManualMs(FIXED_NOW)
        edge = Edge(clock)
        edge.store.set_link("lora")
        edge.hello(); edge.health()
        edge.doa(150.0, stamp={"h": 90.0, "hsrc": "C", "b": 300.0}); edge.angular(150.0)
        clock.now += 15_000
        edge.health()
        edge.doa(THETA, stamp={"h": 100.0, "hsrc": "C", "b": 300.0})
        candidate = self.lora(edge)["doa_candidates"]["mqtt"]
        self.assertEqual((candidate["angular_pairing"], candidate["angular_heading_deg"]), ("PEAK_MOVED", None))
        self.assertIsNone(candidate["angular_frame"]["heading_turn_deg"])
        # With both headings a bearing that moved is still PEAK_MOVED.
        clock = ManualMs(FIXED_NOW)
        edge = Edge(clock)
        edge.hello(); edge.health()
        edge.doa(150.0, stamp={"h": 90.0, "hsrc": "C", "b": 300.0})
        edge.angular(150.0, heading={"heading_deg": 90.0, "heading_source": "C"})
        edge.doa(THETA, stamp={"h": 90.0, "hsrc": "C", "b": 290.0})
        self.assertEqual(build(edge)["doa_candidates"]["mqtt"]["angular_pairing"], "PEAK_MOVED")


class Edge17Tests(unittest.TestCase):
    """Contract 1.7: state.rf as configured values, detail.ovr as the overdrive verdict."""

    def edge(self) -> Edge:
        edge = Edge(ManualMs(FIXED_NOW))
        edge.hello(rf=RF_17, cfg=298)
        edge.health()
        return edge

    def answer(self, edge: Edge, light: Optional[Dict[str, Any]] = None, link: Optional[str] = "lora") -> Dict[str, Any]:
        return ts.mqtt_snapshot(edge.view(link=link), light, base_url=BASE_URL, light_age_ms=None if light is None else 2_000,
                                light_meta={"interval_s": 30.0, "reason": None, "running": False, "error": None})

    def test_rf_is_its_own_block_never_settings(self) -> None:
        built = self.answer(self.edge())
        self.assertEqual(built["rf"], {
            "source": "state.rf", "cfg": 298, "t": FIXED_NOW, "received_at_ms": FIXED_NOW, "age_ms": 0,
            "center_frequency_hz": 103_100_000, "vfo0_frequency_hz": 103_100_000, "gain_db": 12.5,
            "vfo0_bandwidth_hz": 12_500, "vfo0_squelch_db": -100.0, "uca_m": None, "squelch_mode": None,
        })
        # settings is a Data Out read of settings.json; state.rf never fills it.
        self.assertFalse(built["settings"]["available"])
        self.assertNotIn("fields", built["settings"])
        edge = Edge(ManualMs(FIXED_NOW))
        edge.hello()
        edge.health()
        self.assertIsNone(self.answer(edge)["rf"])
        partial = Edge(ManualMs(FIXED_NOW))
        partial.hello(rf={"g": 12.5})
        partial.health()
        self.assertEqual((self.answer(partial)["rf"]["gain_db"], self.answer(partial)["rf"]["center_frequency_hz"]), (12.5, None))

    def test_rf_uca_is_the_uca_spacing_in_metres(self) -> None:
        # Contract 1.8 (edge 1.8.0): state.rf.uca is settings.json ant_spacing_meters.
        edge = Edge(ManualMs(FIXED_NOW))
        edge.hello(rf=dict(RF_17, uca=0.3), cfg=298)
        edge.health()
        self.assertEqual(self.answer(edge)["rf"]["uca_m"], 0.3)

    def test_rf_sqm_is_the_squelch_mode(self) -> None:
        # Contract 1.9 (edge 1.9.0): state.rf.sqm is the VFO0 squelch mode; while it is automatic
        # the edge leaves rf.sq out, so the level is null and only the mode is shown.
        for rf, mode, level in (
            (dict(RF_17, sq=-80, sqm="Manual"), "Manual", -80),
            ({key: value for key, value in RF_17.items() if key != "sq"} | {"sqm": "Auto Channel"}, "Auto Channel", None),
            ({"sqm": "Auto"}, "Auto", None),
        ):
            with self.subTest(sqm=mode):
                edge = Edge(ManualMs(FIXED_NOW))
                edge.hello(rf=rf, cfg=298)
                edge.health()
                built = self.answer(edge)["rf"]
                self.assertEqual((built["squelch_mode"], built["vfo0_squelch_db"]), (mode, level))

    def test_detail_ovr_settles_the_overdrive_over_lora(self) -> None:
        for ovr, reason, check, state, overall in (
            (False, None, True, "PASS", "STALE"),
            (True, "ADC_OVERDRIVE", False, "OVERDRIVE", "DEGRADED"),
            (None, ts.ADC_OVERDRIVE_NOT_OVER_LORA, None, "UNKNOWN", "STALE"),
            ("absent", ts.ADC_OVERDRIVE_NOT_OVER_LORA, None, "UNKNOWN", "STALE"),
        ):
            with self.subTest(ovr=ovr):
                edge = self.edge()
                edge.detail(ovr=ovr)
                built = self.answer(edge)
                reasons = built["publication_gate"]["reasons"]
                adc = [r for r in reasons if r.startswith("ADC_OVERDRIVE")]
                self.assertEqual(adc, [] if reason is None else [reason])
                self.assertIs(built["publication_gate"]["checks"]["adc_not_overdriven"], check)
                self.assertEqual(built["signal_quality"]["state"], state)
                self.assertEqual(built["overall_state"], overall)
                if isinstance(ovr, bool):
                    self.assertEqual(built["signal_quality"]["adc_overdrive_reported_by"], ["detail"])
                    self.assertEqual(built["signal_quality"]["adc_overdrive_sources"], ["detail"] if ovr else [])
                    self.assertEqual(built["signal_quality"]["adc_overdrive_detail_age_ms"], 0)

    def test_an_old_detail_no_longer_counts(self) -> None:
        clock = ManualMs(FIXED_NOW)
        edge = Edge(clock)
        edge.hello(rf=RF_17)
        edge.detail(ovr=False)
        clock.now = FIXED_NOW + ts.DETAIL_OVERDRIVE_MAX_AGE_MS
        edge.health()
        built = self.answer(edge)
        self.assertIs(built["publication_gate"]["checks"]["adc_not_overdriven"], True)
        clock.now += 1
        edge.health()
        built = self.answer(edge)
        self.assertIsNone(built["publication_gate"]["checks"]["adc_not_overdriven"])
        self.assertIn(ts.ADC_OVERDRIVE_NOT_OVER_LORA, built["publication_gate"]["reasons"])

    def test_either_report_of_an_overdrive_counts(self) -> None:
        edge = self.edge()
        edge.detail(ovr=True)
        built = self.answer(edge, light=fixed_light(), link=None)
        quality = built["signal_quality"]
        self.assertIs(quality["adc_overdrive"], True)
        self.assertEqual(quality["adc_overdrive_sources"], ["detail"])
        self.assertEqual(quality["adc_overdrive_reported_by"][-1], "detail")
        self.assertIn("ADC_OVERDRIVE", built["publication_gate"]["reasons"])
        edge = self.edge()
        edge.detail(ovr=False)
        built = self.answer(edge, light=fixed_light(), link=None)
        self.assertIs(built["signal_quality"]["adc_overdrive"], False)
        self.assertNotIn("ADC_OVERDRIVE", built["publication_gate"]["reasons"])


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
        # Without a light read the ADC overdrive is unknown, and the gate says so.
        self.assertEqual(snapshot["publication_gate"]["reasons"], ["GROUND_CLOCK_UNVERIFIED", "ADC_OVERDRIVE_UNKNOWN", *STANDING])
        self.assertIsNone(snapshot["publication_gate"]["checks"]["adc_not_overdriven"])
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
        # The LIVE DoA is still a detection: its angle is kept, without a curve.
        self.assertEqual(view["canonical_angle_deg"], THETA)
        self.assertEqual(snapshot["overall_state"], "UNVERIFIED")
        self.assertIn("MQTT_ANGULAR_UNAVAILABLE", snapshot["publication_gate"]["reasons"])
        self.assertIs(snapshot["publication_gate"]["checks"]["angular_vector_live"], False)
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
        # The bearing itself stays: the DoA is LIVE, only the curve is missing.
        self.assertEqual(snapshot["overall_state"], "UNVERIFIED")
        self.assertIn("MQTT_ANGULAR_UNAVAILABLE", snapshot["publication_gate"]["reasons"])
        # The next frame of the current record gives it back, checked as one record.
        self.edge.angular(130.0)
        snapshot = build(self.edge)
        self.assertEqual(snapshot["doa_candidates"]["mqtt"]["angular_pairing"], "SAME_FRAME")
        self.assertEqual(snapshot["doa_candidates"]["mqtt"]["angular_peak_index"], 130)
        self.assertEqual(snapshot["overall_state"], "UNVERIFIED")
        self.assertNotIn("NATIVE_ANGLE_UNCHECKED", snapshot["publication_gate"]["reasons"])

    def test_the_edges_angular_pace_never_hides_a_live_doa(self) -> None:
        # The edge's schedule (agent._schedule at 8691ad0): health and DoA every
        # second, Angular paced to the Bulk budget (about 9 s at 350 B/s) and
        # held for resume_stable_seconds (20 s) after a command or a reconnect.
        # The DoA keeps its angle and state through every gap; only the curve
        # comes and goes with the frames.
        self.edge.hello()
        states = collections.Counter()
        curves = 0
        angular_at = {0, 9, 18, 47, 56}
        for second in range(60):
            if second:
                self.clock.now += 1_000
            self.edge.health()
            self.edge.doa()
            if second in angular_at:
                self.edge.angular()
            snapshot = build(self.edge)
            view = snapshot["doa_candidates"]["mqtt"]
            states[snapshot["overall_state"]] += 1
            self.assertEqual(view["canonical_angle_deg"], THETA, second)
            curves += "angular_power_db" in view
        self.assertEqual(states, {"UNVERIFIED": 60})
        # A curve while a frame is LIVE (10 s), none in the 29 s gap.
        self.assertGreater(curves, 20)
        self.assertLess(curves, 60)

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
        self.assertNotIn("ADC_OVERDRIVE_UNKNOWN", snapshot["publication_gate"]["reasons"])
        self.assertEqual(snapshot["collection"]["settings_reused"], False)
        self.assertGreaterEqual(snapshot["collection"]["settings_age_ms"], 2_000)
        overdriven = build(self.edge, light_result(overdrive="True"), light_age_ms=2_000)
        self.assertEqual(overdriven["overall_state"], "DEGRADED")
        self.assertIs(overdriven["publication_gate"]["checks"]["adc_not_overdriven"], False)
        self.assertIn("ADC_OVERDRIVE", overdriven["publication_gate"]["reasons"])
        self.assertNotIn("ADC_OVERDRIVE_UNKNOWN", overdriven["publication_gate"]["reasons"])
        # An old light read no longer decides the overdrive: it is unknown.
        old = build(self.edge, light_result(overdrive="True"), light_age_ms=ts.LIGHT_VALUES_MAX_AGE_MS + 1)
        self.assertEqual(old["overall_state"], "UNVERIFIED")
        self.assertIsNone(old["publication_gate"]["checks"]["adc_not_overdriven"])
        self.assertIn("ADC_OVERDRIVE_UNKNOWN", old["publication_gate"]["reasons"])
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

    def lora_reader(self) -> DataOutReader:
        """The reader of a console whose node reaches the broker over the LoRa serial bridge."""
        self.offline: list = []

        def offline(base_url: str) -> Dict[str, Any]:
            self.offline.append(base_url)
            return collector.collect(base_url=base_url, fetcher=collector.not_over_lora_fetcher, allowed_hosts=["127.0.0.1"])

        return DataOutReader(
            self.full, lambda: 2, wait_timeout_s=5.0, clock=self.clock, wall_ms=lambda: 9_000_000,
            console_base_url=lambda: BASE_URL, collect_light=self.light,
            mqtt_view=lambda: dict(self.edge.view(), link="lora"), collect_offline=offline,
            run_background=lambda function: function(),
        )

    def test_no_data_out_at_all_over_lora(self) -> None:
        reader = self.lora_reader()
        self.edge.live()
        for request in (SnapshotRequest(), SnapshotRequest(refresh=True), SnapshotRequest(fresh_settings=True)):
            answer = reader.snapshot(BASE_URL, request)
            self.assertEqual((answer["source"]["kind"], answer["source"]["link"]), ("mqtt", "lora"))
            self.advance(31.0)
            self.keep_alive()
        self.assertEqual((self.full.calls, self.light.calls, self.offline), ([], [], []))

    def test_stale_mqtt_over_lora_reads_nothing(self) -> None:
        reader = self.lora_reader()
        self.edge.live()
        self.advance(9.0)
        answer = reader.snapshot(BASE_URL, SnapshotRequest())
        self.assertEqual(answer["source"]["kind"], "none")
        self.assertEqual(answer["source"]["reasons"], ["MQTT_HEALTH_STALE", "DATA_OUT_NOT_OVER_LORA"])
        self.assertEqual((answer["source"]["link"], answer["source"]["data_out"]["read"]), ("lora", "none"))
        self.assertEqual(answer["resources"]["/status.json"]["error_kind"], "skipped")
        self.assertEqual(self.full.calls, [])
        self.assertEqual(self.offline, [BASE_URL])
        # The legacy UI still asks Data Out itself.
        reader.snapshot(BASE_URL, SnapshotRequest(data_out_only=True))
        self.assertEqual(len(self.full.calls), 1)

    def test_daq_not_healthy_over_lora_still_answers_from_mqtt(self) -> None:
        # 2026-11-03: a retune left the KrakenSDR DAQ unsynced; health, compass
        # and GPS kept coming over LoRa, yet the answer was "none" and the
        # Dashboard showed no RDF-SDR at all. Now MQTT answers, DEGRADED.
        reader = self.lora_reader()
        self.edge.hello()
        self.edge.health(daq=2, nav=NAV_FIX, why=["DAQ_NOT_HEALTHY", "EMPTY_CSV"])
        answer = reader.snapshot(BASE_URL, SnapshotRequest())
        source = answer["source"]
        self.assertEqual((source["kind"], source["reason"], source["reasons"], source["link"]),
                         ("mqtt", "MQTT_DAQ_NOT_HEALTHY", ["MQTT_DAQ_NOT_HEALTHY"], "lora"))
        self.assertEqual((source["mqtt"]["fresh"], source["mqtt"]["health_daq"], source["mqtt"]["health_why"]),
                         (False, 2, ["DAQ_NOT_HEALTHY", "EMPTY_CSV"]))
        self.assertEqual(answer["overall_state"], "DEGRADED")
        self.assertIn("DAQ_HEALTH_GATE_FAILED", answer["publication_gate"]["reasons"])
        self.assertIs(answer["publication_gate"]["checks"]["daq_healthy"], False)
        self.assertNotEqual(answer["status"]["daq_health"], "PASS")
        self.assertEqual((answer["nav"]["heading_deg"], answer["nav"]["latitude"]), (201.1, -6.20576))
        self.assertFalse(answer["doa_candidates"]["mqtt"]["available"])
        # Nothing was read: no Data Out over LoRa.
        self.assertEqual((self.full.calls, self.light.calls, self.offline), ([], [], []))
        # A healthy DAQ again is the plain MQTT answer.
        self.edge.live()
        healthy = reader.snapshot(BASE_URL, SnapshotRequest())
        self.assertEqual((healthy["source"]["reason"], healthy["source"]["reasons"]), ("MQTT_FRESH", []))
        self.assertIs(healthy["publication_gate"]["checks"]["daq_healthy"], True)

    def test_daq_not_healthy_reads_data_out_first_and_falls_back_to_mqtt(self) -> None:
        self.edge.hello()
        self.edge.health(daq=0, nav=NAV_FIX)
        # Data Out answers: it has the DAQ detail, so it stays the source.
        answer = self.reader.snapshot(BASE_URL, SnapshotRequest())
        self.assertEqual((answer["source"]["kind"], answer["source"]["reasons"]), ("data_out", ["MQTT_DAQ_NOT_HEALTHY"]))
        # Data Out unreachable: MQTT's health, compass and GPS rather than nothing.
        self.full.status_available = False
        self.advance(3.0)
        self.edge.health(daq=0, nav=NAV_FIX)
        answer = self.reader.snapshot(BASE_URL, SnapshotRequest(refresh=True))
        self.assertEqual((answer["source"]["kind"], answer["source"]["reason"]), ("mqtt", "MQTT_DAQ_NOT_HEALTHY"))
        self.assertEqual(answer["overall_state"], "DEGRADED")
        self.assertEqual(answer["nav"]["heading_deg"], 201.1)
        # Stale health is still nothing: only a fresh health answers.
        self.advance(9.0)
        stale = self.reader.snapshot(BASE_URL, SnapshotRequest(refresh=True))
        self.assertEqual(stale["source"]["kind"], "none")
        # The legacy UI asks Data Out and gets it, whatever it holds.
        self.edge.health(daq=0, nav=NAV_FIX)
        legacy = self.reader.snapshot(BASE_URL, SnapshotRequest(data_out_only=True))
        self.assertEqual(legacy["source"]["kind"], "none")

    def lora_mode_reader(self, *, offline: bool = True) -> DataOutReader:
        """A reader with console.json link_mode "lora"; the view names no LoRa bridge, as before its first status."""
        self.offline = []

        def collect_offline(base_url: str) -> Dict[str, Any]:
            self.offline.append(base_url)
            return collector.collect(base_url=base_url, fetcher=collector.not_over_lora_fetcher, allowed_hosts=["127.0.0.1"])

        return DataOutReader(
            self.full, lambda: 2, wait_timeout_s=5.0, clock=self.clock, wall_ms=lambda: 9_000_000,
            console_base_url=lambda: BASE_URL, collect_light=self.light, mqtt_view=self.current_view,
            collect_offline=collect_offline if offline else None, link_mode=lambda: "lora",
            run_background=lambda function: function(),
        )

    def test_lora_mode_keeps_every_value_with_its_age(self) -> None:
        reader = self.lora_mode_reader()
        self.edge.hello()
        self.edge.health(nav=NAV_FIX)
        self.edge.doa()
        self.edge.angular()
        live = reader.snapshot(BASE_URL, SnapshotRequest(refresh=True))
        self.assertEqual((live["source"]["kind"], live["source"]["link"], live["source"]["reasons"]), ("mqtt", "lora", []))
        self.assertTrue(live["doa_candidates"]["mqtt"]["available"])
        self.assertEqual((live["nav"]["stale"], live["nav"]["age_ms"]), (False, 0))
        # Nothing more comes over the radio for 2 minutes: the answer keeps the
        # node, its compass and position, marked STALE with their age.
        self.advance(120.0)
        held = reader.snapshot(BASE_URL, SnapshotRequest())
        self.assertEqual((held["source"]["kind"], held["source"]["reason"], held["source"]["link"]),
                         ("mqtt", "MQTT_HEALTH_STALE", "lora"))
        self.assertEqual(held["overall_state"], "STALE")
        self.assertIn("MQTT_HEALTH_STALE", held["publication_gate"]["reasons"])
        self.assertIs(held["publication_gate"]["checks"]["mqtt_health_fresh"], False)
        self.assertEqual((held["nav"]["heading_deg"], held["nav"]["latitude"], held["nav"]["stale"], held["nav"]["age_ms"]),
                         (201.1, -6.20576, True, 120_000))
        # The last DoA stays readable, not fresh: the Dashboard holds it, never as a valid one.
        self.assertIs(held["doa_candidates"]["mqtt"]["freshness"]["fresh"], False)
        # The DAQ not healthy: the same, DEGRADED.
        self.edge.health(daq=0, nav=NAV_FIX)
        unsynced = reader.snapshot(BASE_URL, SnapshotRequest())
        self.assertEqual((unsynced["source"]["reason"], unsynced["overall_state"]), ("MQTT_DAQ_NOT_HEALTHY", "DEGRADED"))
        self.assertIs(unsynced["nav"]["stale"], False)
        # No Data Out read at all, not even a light one, nor for the legacy UI.
        reader.snapshot(BASE_URL, SnapshotRequest(data_out_only=True, fresh_settings=True))
        self.assertEqual((self.full.calls, self.light.calls), ([], []))

    def test_lora_mode_without_a_session_reads_nothing(self) -> None:
        reader = self.lora_mode_reader()
        answer = reader.snapshot(BASE_URL, SnapshotRequest())
        self.assertEqual((answer["source"]["kind"], answer["source"]["link"]), ("none", "lora"))
        self.assertEqual(answer["source"]["reasons"], ["MQTT_NO_SESSION", "DATA_OUT_NOT_OVER_LORA"])
        self.disabled = True
        self.assertEqual(reader.snapshot(BASE_URL, SnapshotRequest())["source"]["reasons"], ["MQTT_DISABLED", "DATA_OUT_NOT_OVER_LORA"])
        self.assertEqual((self.full.calls, self.light.calls, self.offline), ([], [], [BASE_URL, BASE_URL]))
        bare = self.lora_mode_reader(offline=False).snapshot(BASE_URL, SnapshotRequest())
        self.assertEqual(bare["source"]["kind"], "none")
        self.assertTrue(self.lora_mode_reader().lora_only())
        self.assertFalse(self.reader.lora_only())

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

    def test_a_failed_light_read_keeps_the_last_good_values_while_they_count(self) -> None:
        self.edge.live()
        first = self.reader.snapshot(BASE_URL)
        self.assertEqual(first["settings"]["fields"]["center_freq"], 433.92 + 1)
        self.assertIs(first["data_out_light"]["kept_previous"], False)
        self.light.error = collector.CollectorError("timed out")
        for _ in range(16):
            self.advance(2.0)
            self.keep_alive()
            answer = self.reader.snapshot(BASE_URL)
        # The read at 30 s failed; the values of the read at 0 s still count.
        self.assertEqual(len(self.light.calls), 2)
        self.assertEqual(answer["data_out_light"]["error"], "timed out")
        self.assertIs(answer["data_out_light"]["kept_previous"], True)
        self.assertIs(answer["data_out_light"]["expired"], False)
        self.assertEqual(answer["settings"]["fields"]["center_freq"], 433.92 + 1)
        # Past 65 s they answer as not read.
        for _ in range(20):
            self.advance(2.0)
            self.keep_alive()
            answer = self.reader.snapshot(BASE_URL)
        self.assertIs(answer["data_out_light"]["expired"], True)
        self.assertIs(answer["settings"]["available"], False)
        # A good read replaces them again.
        self.light.error = None
        for _ in range(16):
            self.advance(2.0)
            self.keep_alive()
            answer = self.reader.snapshot(BASE_URL)
        self.assertIs(answer["data_out_light"]["kept_previous"], False)
        self.assertIsNone(answer["data_out_light"]["error"])
        self.assertIs(answer["settings"]["available"], True)

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
