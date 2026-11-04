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


class ShowsLiveGraphTests(unittest.TestCase):
    def test_a_fresh_360_bin_vector_in_the_answers_view(self) -> None:
        self.assertTrue(lld.shows_live_graph(fixture("mqtt-live.json")))
        self.assertFalse(lld.shows_live_graph(fixture("mqtt-unverified.json")))
        self.assertFalse(lld.shows_live_graph(stale(fixture("mqtt-live.json"))))

    def test_states_and_conflicts_that_draw_no_live_graph(self) -> None:
        for change in (
            {"overall_state": "CONFLICT"}, {"overall_state": "DEGRADED"}, {"simulation": True},
            {"native_consistency": {"conflict": True}}, {"source": {"kind": "none"}},
        ):
            with self.subTest(change=change):
                answer = fixture("mqtt-live.json")
                answer.update(change)
                self.assertFalse(lld.shows_live_graph(answer))
        short = fixture("mqtt-live.json")
        short["doa_candidates"]["mqtt"]["angular_power_db"] = [0.0] * 359
        self.assertFalse(lld.shows_live_graph(short))
        # A Data Out answer reads its CSV view.
        csv = {"source": {"kind": "data_out"}, "overall_state": "UNVERIFIED",
               "doa_candidates": {"csv": {"angular_power_db": [0.0] * 360, "freshness": {"fresh": True}}}}
        self.assertTrue(lld.shows_live_graph(csv))

    def test_identity(self) -> None:
        self.assertEqual(lld.answer_identity(fixture("mqtt-live.json")), ("http://127.0.0.1:8081", "227c8be2"))
        self.assertEqual(lld.answer_identity({}), (None, None))
        self.assertTrue(lld.same_node(("a", None), ("a", "s1")))
        self.assertFalse(lld.same_node(("a", "s1"), ("a", "s2")))
        self.assertFalse(lld.same_node(("a", "s1"), ("b", "s1")))


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
