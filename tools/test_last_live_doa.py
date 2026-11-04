#!/usr/bin/env python3
"""The last answer with a live DoA graph (tools/last_live_doa.py) and GET /api/doa/last-live on both listeners."""

from __future__ import annotations

import copy
import functools
import json
import sys
import unittest
from pathlib import Path
from typing import Any, Dict
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ground_console  # noqa: E402
import last_live_doa as lld  # noqa: E402
from test_lan_access import BASE_URL, _json, _request, _ServerCase  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "telemetry-source"


def fixture(name: str) -> Dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def stale(answer: Dict[str, Any]) -> Dict[str, Any]:
    """The same answer once its DoA went stale and the vector went with the Angular frame."""
    later = copy.deepcopy(answer)
    candidate = later["doa_candidates"]["mqtt"]
    candidate["freshness"]["fresh"] = False
    candidate.pop("angular_power_db", None)
    later["overall_state"] = "STALE"
    return later


def data_out_answer(*, xml: bool = True, comparable: bool = True, daq: str = "PASS") -> Dict[str, Any]:
    fresh = {"fresh": True, "age_ms": 500}
    candidates: Dict[str, Any] = {"csv": {"available": True, "canonical_angle_deg": 40.0, "angular_power_db": [-30.0] * 360,
                                          "freshness": dict(fresh)}}
    if xml:
        candidates["xml"] = {"available": True, "canonical_angle_deg": 40.0, "freshness": dict(fresh)}
    return {"source": {"kind": "data_out"}, "overall_state": "UNVERIFIED", "status": {"available": True, "daq_health": daq},
            "publication_gate": {"checks": {"adc_not_overdriven": True}},
            "native_consistency": {"comparable": comparable, "conflict": False}, "doa_candidates": candidates}


class ShowsLiveGraphTests(unittest.TestCase):
    def test_a_fresh_360_bin_vector_in_the_answers_view(self) -> None:
        self.assertTrue(lld.shows_live_graph(fixture("mqtt-live.json")))
        self.assertFalse(lld.shows_live_graph(fixture("mqtt-unverified.json")))
        self.assertFalse(lld.shows_live_graph(stale(fixture("mqtt-live.json"))))

    def test_what_the_page_never_draws_live_is_never_kept(self) -> None:
        # The page's overviewDoaStatus() refuses each of these, so it never remembers them either.
        for name, change in (
            ("conflict state", {"overall_state": "CONFLICT"}), ("degraded", {"overall_state": "DEGRADED"}),
            ("simulation", {"simulation": True}), ("conflict", {"native_consistency": {"conflict": True}}),
            ("no source", {"source": {"kind": "none"}}), ("DAQ unknown", {"status": {"available": True, "daq_health": "UNKNOWN"}}),
            ("no status", {"status": {"available": False}}),
            ("overdrive", {"publication_gate": {"checks": {"adc_not_overdriven": False}}}),
        ):
            with self.subTest(name):
                answer = fixture("mqtt-live.json")
                answer.update(change)
                self.assertFalse(lld.shows_live_graph(answer))
        for name, edit in (
            ("short vector", lambda c: c.update(angular_power_db=[0.0] * 359)),
            ("angle convention unknown", lambda c: (c.pop("canonical_angle_deg"), c.update(normalization_error="MQTT_ANGLE_CONVENTION_UNKNOWN"))),
            ("normalization error", lambda c: c.update(normalization_error="X")),
            ("no age", lambda c: c["freshness"].pop("age_ms")),
        ):
            with self.subTest(name):
                answer = fixture("mqtt-live.json")
                edit(answer["doa_candidates"]["mqtt"])
                self.assertFalse(lld.shows_live_graph(answer))

    def test_a_data_out_answer_needs_comparable_views_or_the_csv_alone(self) -> None:
        self.assertTrue(lld.shows_live_graph(data_out_answer()))
        self.assertFalse(lld.shows_live_graph(data_out_answer(comparable=False)))
        self.assertTrue(lld.shows_live_graph(data_out_answer(xml=False, comparable=False)))
        self.assertFalse(lld.shows_live_graph(data_out_answer(daq="UNKNOWN")))

    def test_identity(self) -> None:
        self.assertEqual(lld.answer_identity(fixture("mqtt-live.json")), ("http://127.0.0.1:8081", "227c8be2", None))
        self.assertEqual(lld.answer_identity({"status": {"safe": {"uptime_ms": 1234}}}), (None, None, 1234.0))
        self.assertEqual(lld.answer_identity({}), (None, None, None))
        self.assertTrue(lld.same_node(("a", None, None), ("a", "s1", 5.0)))
        self.assertFalse(lld.same_node(("a", "s1", None), ("a", "s2", None)))
        self.assertFalse(lld.same_node(("a", "s1", None), ("b", "s1", None)))
        self.assertFalse(lld.same_node(("a", None, 9_000.0), ("a", None, 1_000.0)))
        self.assertEqual(lld.merged_identity(("a", None, 5.0), (None, "s1", 7.0)), ("a", "s1", 7.0))


class HolderTests(unittest.TestCase):
    def test_keeps_the_last_live_answer_through_stale_ones(self) -> None:
        clock = [1_000]
        holder = lld.LastLiveDoa(clock_ms=lambda: clock[0])
        self.assertEqual(holder.view(), {"ok": True, "captured_at_ms": None, "snapshot": None})
        live = fixture("mqtt-live.json")
        holder.observe(live)
        clock[0] = 9_000
        holder.observe(stale(live))
        self.assertEqual(holder.view(), {"ok": True, "captured_at_ms": 1_000, "snapshot": live})
        newer = fixture("mqtt-live.json")
        newer["doa_candidates"]["mqtt"]["canonical_angle_deg"] = 12.0
        holder.observe(newer)
        self.assertEqual((holder.view()["captured_at_ms"], holder.view()["snapshot"]), (9_000, newer))

    def test_another_session_or_data_out_url_forgets_it(self) -> None:
        holder = lld.LastLiveDoa(clock_ms=lambda: 1)
        holder.observe(fixture("mqtt-live.json"))
        other = stale(fixture("mqtt-live.json"))
        other["mqtt"]["sid"] = other["source"]["mqtt"]["sid"] = "99999999"
        holder.observe(other)
        self.assertIsNone(holder.view()["snapshot"])
        holder.observe(fixture("mqtt-live.json"))
        moved = stale(fixture("mqtt-live.json"))
        moved["collection"]["console_base_url"] = "http://10.90.0.2:8081"
        holder.observe(moved)
        self.assertIsNone(holder.view()["snapshot"])
        # An answer that names no node keeps it.
        holder.observe(fixture("mqtt-live.json"))
        holder.observe({"source": {"kind": "none"}})
        self.assertIsNotNone(holder.view()["snapshot"])
        holder.clear()
        self.assertIsNone(holder.view()["snapshot"])

    def test_a_session_named_later_still_forgets_it_when_it_changes(self) -> None:
        # Kept from Data Out (no session), then MQTT names S1 without a graph, then the edge restarts as S2.
        holder = lld.LastLiveDoa(clock_ms=lambda: 1)
        kept = data_out_answer()
        kept["collection"] = {"console_base_url": "http://u:8081"}
        holder.observe(kept)
        for sid in ("s1", "s2"):
            later = stale(fixture("mqtt-live.json"))
            later["collection"]["console_base_url"] = "http://u:8081"
            later["mqtt"]["sid"] = later["source"]["mqtt"]["sid"] = sid
            holder.observe(later)
            if sid == "s1":
                self.assertIsNotNone(holder.view()["snapshot"])
        self.assertIsNone(holder.view()["snapshot"])

    def test_an_uptime_that_went_back_forgets_it(self) -> None:
        holder = lld.LastLiveDoa(clock_ms=lambda: 1)
        kept = data_out_answer()
        kept["status"]["safe"] = {"uptime_ms": 90_000}
        holder.observe(kept)
        restarted = data_out_answer(xml=False)
        restarted["doa_candidates"]["csv"]["freshness"]["fresh"] = False
        restarted["status"]["safe"] = {"uptime_ms": 4_000}
        holder.observe(restarted)
        self.assertIsNone(holder.view()["snapshot"])


class RouteTests(_ServerCase):
    def test_both_listeners_serve_the_last_live_answer(self) -> None:
        server = self.start_server()
        # The harness replaces collect_snapshot on the instance; the class's own composes and keeps.
        collect = functools.partial(ground_console.GroundConsoleServer.collect_snapshot, server)
        status, body = self.main_request(server, "GET", lld.ROUTE, origin=False)
        self.assertEqual((status, body), (200, {"ok": True, "captured_at_ms": None, "snapshot": None}))
        live = fixture("mqtt-live.json")
        with mock.patch.object(server.data_out, "snapshot", return_value=live):
            collect(BASE_URL)
        with mock.patch.object(server.data_out, "snapshot", return_value=stale(live)):
            collect(BASE_URL)
        status, body = self.main_request(server, "GET", lld.ROUTE, origin=False)
        self.assertEqual(status, 200)
        self.assertIsInstance(body["captured_at_ms"], int)
        # The composed answer: the answer-time blocks are part of it.
        snapshot = body["snapshot"]
        self.assertEqual(snapshot["doa_candidates"]["mqtt"]["angular_power_db"], live["doa_candidates"]["mqtt"]["angular_power_db"])
        self.assertIn("ground_gps", snapshot)
        self.assertIn("drone", snapshot)
        port = self.open_lan(server)
        status, _headers, raw = _request(port, "GET", lld.ROUTE)
        self.assertEqual(status, 200)
        self.assertEqual(_json(raw)["snapshot"]["doa_candidates"]["mqtt"]["canonical_angle_deg"],
                         live["doa_candidates"]["mqtt"]["canonical_angle_deg"])
        status, _headers, _raw = _request(port, "POST", lld.ROUTE, [("Origin", f"http://127.0.0.1:{port}")], b"{}")
        self.assertEqual(status, 405)


if __name__ == "__main__":
    unittest.main()
