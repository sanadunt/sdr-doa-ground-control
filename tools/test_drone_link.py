#!/usr/bin/env python3
"""The SIYI drone's telemetry: parsing, staleness, yaw history and the subscribe-only client."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import drone_link  # noqa: E402
from drone_link import DRONE_TOPICS, DroneLink, DroneStore, parse_payload, with_drone  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "drone" / "bridge-payloads.json"


def payloads():
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    data.pop("_comment", None)
    return data


def encode(value) -> bytes:
    return json.dumps(value).encode("utf-8")


def filled_store(at_ms: int = 1_000) -> DroneStore:
    store = DroneStore()
    for topic, payload in payloads().items():
        assert store.ingest(topic, encode(payload), at_ms), topic
    return store


class ParseTests(unittest.TestCase):
    def test_every_fixture_topic_parses_without_notes(self):
        for topic, payload in payloads().items():
            parsed = parse_payload(topic, encode(payload))
            self.assertEqual(parsed["notes"], [], topic)
        self.assertEqual(set(payloads()), set(DRONE_TOPICS))

    def test_mavlink_unknowns_read_as_null_without_a_note(self):
        gps = dict(payloads()["drone/gps"], hdop=655.35, course_deg=655.35, satellites=255, lat=0, lon=0)
        parsed = parse_payload("drone/gps", encode(gps))
        for key in ("hdop", "course_deg", "satellites", "lat", "lon"):
            self.assertIsNone(parsed["values"][key], key)
        self.assertEqual(parsed["notes"], [])
        position = dict(payloads()["drone/position"], heading_deg=655.35)
        self.assertIsNone(parse_payload("drone/position", encode(position))["values"]["heading_deg"])

    def test_wrong_fields_read_as_null_with_a_note(self):
        attitude = dict(payloads()["drone/attitude"], roll_deg="8", yaw_deg=float("inf"))
        raw = json.dumps(attitude).replace("Infinity", "1e999").encode()
        parsed = parse_payload("drone/attitude", raw)
        self.assertIsNone(parsed["values"]["roll_deg"])
        self.assertIn("INVALID_FIELD:roll_deg", parsed["notes"])
        self.assertIn("INVALID_FIELD:yaw_deg", parsed["notes"])

    def test_yaw_is_turned_into_0_to_360(self):
        attitude = dict(payloads()["drone/attitude"], yaw_deg=-90.0)
        self.assertEqual(parse_payload("drone/attitude", encode(attitude))["values"]["yaw_deg"], 270.0)

    def test_refusals(self):
        with self.assertRaisesRegex(ValueError, "PAYLOAD_TOO_LARGE"):
            parse_payload("drone/statustext", b"{" + b" " * 5000 + b"}")
        with self.assertRaisesRegex(ValueError, "MALFORMED_PAYLOAD"):
            parse_payload("drone/gps", b"[1, 2]")
        with self.assertRaisesRegex(ValueError, "MALFORMED_PAYLOAD"):
            parse_payload("drone/gps", b"\xff")
        with self.assertRaisesRegex(ValueError, "UNKNOWN_TOPIC"):
            parse_payload("drone/other/7/12", b"{}")

    def test_half_a_position_is_no_position(self):
        gps = dict(payloads()["drone/gps"], lon="east")
        parsed = parse_payload("drone/gps", encode(gps))
        self.assertIsNone(parsed["values"]["lat"])
        self.assertIsNone(parsed["values"]["lon"])
        self.assertIn("INVALID_FIELD:lon", parsed["notes"])


class StoreTests(unittest.TestCase):
    def test_view_of_a_live_drone(self):
        view = filled_store(1_000).view(1_500)
        self.assertEqual(view["state"], "LIVE")
        self.assertEqual(view["position"]["lat"], -6.9321)
        self.assertEqual(view["position"]["age_ms"], 500)
        self.assertFalse(view["position"]["stale"])
        self.assertEqual(view["gps"]["rtk"], "FIXED")
        self.assertEqual(view["gps"]["fix_label"], "RTK_FIXED")
        self.assertEqual(view["heading"], {"deg": 87.3, "source": "attitude", "age_ms": 500})
        self.assertTrue(view["link"]["fc_online"])
        self.assertEqual(view["link"]["version"], "0.1.0")
        self.assertIsNone(view["battery"]["remaining_pct"])
        self.assertEqual(view["invalid"], 0)

    def test_rtk_float_and_plain_fix(self):
        store = DroneStore()
        store.ingest("drone/gps", encode(dict(payloads()["drone/gps"], fix=5)), 0)
        self.assertEqual(store.view(0)["gps"]["rtk"], "FLOAT")
        store.ingest("drone/gps", encode(dict(payloads()["drone/gps"], fix=3)), 0)
        self.assertEqual(store.view(0)["gps"]["rtk"], "NONE")

    def test_stale_after_ten_seconds(self):
        store = filled_store(0)
        self.assertEqual(store.view(10_000)["state"], "LIVE")
        view = store.view(10_001)
        self.assertEqual(view["state"], "STALE")
        self.assertTrue(view["position"]["stale"])
        self.assertIsNone(view["heading"])

    def test_no_data(self):
        view = DroneStore().view(0)
        self.assertEqual(view["state"], "NO_DATA")
        self.assertIsNone(view["position"])
        self.assertIsNone(view["link"])

    def test_link_alone_is_no_drone_data(self):
        store = DroneStore()
        store.ingest("bridge/link", encode(payloads()["bridge/link"]), 0)
        self.assertEqual(store.view(0)["state"], "NO_DATA")

    def test_bad_payload_is_counted_and_keeps_the_last_value(self):
        store = filled_store(0)
        self.assertFalse(store.ingest("drone/position", b"not json", 100))
        view = store.view(200)
        self.assertEqual(view["invalid"], 1)
        self.assertEqual(view["last_invalid"], "drone/position:MALFORMED_PAYLOAD")
        self.assertEqual(view["position"]["lat"], -6.9321)

    def test_retained_clear_forgets_the_topic(self):
        store = filled_store(0)
        store.ingest("drone/position", b"", 10)
        self.assertIsNone(store.view(20)["position"])

    def test_unknown_topic_is_ignored(self):
        store = DroneStore()
        self.assertFalse(store.ingest("drone/raw/242", b"{}", 0))
        self.assertEqual(store.view(0)["received"], 0)


class PickHeadingTests(unittest.TestCase):
    """One heading for every view, as the SIYI fix of 2026-11-04 (pickHeading()): yaw, then VFR_HUD, then position."""

    def ingest(self, store, topic, t, **fields):
        store.ingest(topic, encode(dict(payloads()[topic], **fields)), t)

    def test_the_yaw_wins_over_the_reversed_hud_heading(self):
        # Measured on the real FC: ATTITUDE yaw 139.3 while VFR_HUD says 220 and GLOBAL_POSITION_INT 0.
        store = DroneStore()
        self.ingest(store, "drone/attitude", 0, yaw_deg=139.3)
        self.ingest(store, "drone/hud", 0, heading_deg=220)
        self.ingest(store, "drone/position", 0, heading_deg=0)
        self.assertEqual(store.view(0)["heading"], {"deg": 139.3, "source": "attitude", "age_ms": 0})
        self.assertEqual(store.heading_at(0), {"deg": 139.3, "offset_ms": 0, "source": "attitude"})

    def test_a_negative_yaw_reads_0_to_360(self):
        store = DroneStore()
        self.ingest(store, "drone/attitude", 0, yaw_deg=-45.0)
        self.assertEqual(store.view(0)["heading"]["deg"], 315.0)
        self.assertEqual(store.heading_at(0)["deg"], 315.0)

    def test_fallback_order_hud_then_position(self):
        store = DroneStore()
        self.ingest(store, "drone/position", 0, heading_deg=0)
        self.assertEqual(store.view(0)["heading"]["source"], "position")
        self.ingest(store, "drone/hud", 0, heading_deg=220)
        self.assertEqual(store.view(0)["heading"], {"deg": 220.0, "source": "hud", "age_ms": 0})
        self.assertEqual(store.heading_at(0)["source"], "hud")
        self.ingest(store, "drone/attitude", 0, yaw_deg=139.3)
        self.assertEqual(store.view(0)["heading"]["source"], "attitude")
        # A stale yaw gives way to a current HUD heading.
        self.ingest(store, "drone/hud", 20_000, heading_deg=221)
        self.assertEqual(store.view(20_000)["heading"], {"deg": 221.0, "source": "hud", "age_ms": 0})

    def test_the_gps_course_never_counts_as_the_nose(self):
        store = DroneStore()
        self.ingest(store, "drone/gps", 0, course_deg=33.0)
        self.assertIsNone(store.view(0)["heading"])
        self.assertIsNone(store.heading_at(0))


class HeadingHistoryTests(unittest.TestCase):
    def store_with_yaw(self, samples):
        store = DroneStore()
        for t, yaw in samples:
            store.ingest("drone/attitude", encode(dict(payloads()["drone/attitude"], yaw_deg=yaw)), t)
        return store

    def test_heading_at_interpolates(self):
        store = self.store_with_yaw([(0, 10.0), (200, 20.0)])
        self.assertEqual(store.heading_at(50), {"deg": 12.5, "offset_ms": 50, "source": "attitude"})

    def test_heading_at_wraps(self):
        store = self.store_with_yaw([(0, 359.0), (200, 1.0)])
        self.assertEqual(store.heading_at(100)["deg"], 0.0)
        store = self.store_with_yaw([(0, -1.0), (200, -179.0)])
        self.assertEqual(store.heading_at(100)["deg"], 270.0)

    def test_heading_at_needs_a_sample_within_one_second(self):
        store = self.store_with_yaw([(0, 10.0), (5_000, 20.0)])
        self.assertEqual(store.heading_at(900), {"deg": 10.0, "offset_ms": 900, "source": "attitude"})
        self.assertIsNone(store.heading_at(2_500))
        self.assertEqual(store.heading_at(5_400)["deg"], 20.0)
        self.assertIsNone(store.heading_at(6_001))

    def test_heading_at_falls_back_to_the_position_heading(self):
        store = DroneStore()
        store.ingest("drone/position", encode(payloads()["drone/position"]), 1_000)
        self.assertEqual(store.heading_at(1_200), {"deg": 87.0, "offset_ms": 200, "source": "position"})

    def test_history_keeps_sixty_seconds(self):
        store = self.store_with_yaw([(0, 10.0), (61_000, 20.0)])
        self.assertIsNone(store.heading_at(0))

    def test_clock_going_back_drops_the_history(self):
        store = self.store_with_yaw([(10_000, 10.0), (5_000, 20.0)])
        self.assertIsNone(store.heading_at(10_000))
        self.assertEqual(store.heading_at(5_000)["deg"], 20.0)


class FakeClient:
    def __init__(self, client_id):
        self.client_id = client_id
        self.subscribed = None
        self.published = []
        self.connected_to = None
        self.looping = False

    def reconnect_delay_set(self, min_delay, max_delay):
        self.delays = (min_delay, max_delay)

    def connect_async(self, host, port, keepalive):
        self.connected_to = (host, port, keepalive)

    def loop_start(self):
        self.looping = True

    def loop_stop(self):
        self.looping = False

    def disconnect(self):
        pass

    def subscribe(self, topics):
        self.subscribed = topics
        return (0, 1)

    def publish(self, *args, **kwargs):  # pragma: no cover - must never be called
        self.published.append((args, kwargs))


class Message:
    def __init__(self, topic, payload):
        self.topic = topic
        self.payload = payload


class LinkTests(unittest.TestCase):
    def setUp(self):
        self.now = [1_000]
        self.clients = []

        def factory(client_id):
            client = FakeClient(client_id)
            self.clients.append(client)
            return client

        self.link = DroneLink("192.168.1.162", client_factory=factory, clock=lambda: self.now[0])
        self.link.start()
        self.client = self.clients[0]

    def test_subscribes_to_the_eight_topics_only_and_never_publishes(self):
        self.assertEqual(self.client.connected_to, ("192.168.1.162", 1883, 15))
        self.assertEqual(self.link.connection, "connecting")
        self.link._on_connect(self.client, None, None, 0)
        self.assertEqual(self.client.subscribed, [(topic, 0) for topic in DRONE_TOPICS])
        self.assertNotIn("drone/#", [topic for topic, _qos in self.client.subscribed])
        self.assertEqual(self.link.connection, "connected")
        for topic, payload in payloads().items():
            self.link._on_message(self.client, None, Message(topic, encode(payload)))
        self.assertEqual(self.client.published, [])
        self.assertFalse(hasattr(DroneLink, "publish"))
        view = self.link.view()
        self.assertEqual(view["state"], "LIVE")
        self.assertEqual(view["host"], "192.168.1.162")
        self.assertEqual(view["connection"], "connected")

    def test_disconnected_time(self):
        self.assertEqual(self.link.disconnected_for_ms(), 0)
        self.now[0] = 4_000
        self.assertEqual(self.link.disconnected_for_ms(), 3_000)
        self.link._on_connect(self.client, None, None, 0)
        self.assertEqual(self.link.disconnected_for_ms(), 0)
        self.link._on_disconnect(self.client, None, 0)
        self.now[0] = 20_000
        self.assertEqual(self.link.disconnected_for_ms(), 16_000)
        self.assertEqual(self.link.connection, "disconnected")

    def test_refused_connect(self):
        self.link._on_connect(self.client, None, None, 5)
        self.assertEqual(self.link.connection, "error")
        self.assertIsNone(self.client.subscribed)

    def test_messages_of_a_replaced_client_are_ignored(self):
        self.link.stop()
        self.link._on_message(self.client, None, Message("drone/gps", encode(payloads()["drone/gps"])))
        self.assertEqual(self.link.view()["state"], "NO_DATA")
        self.assertEqual(self.link.connection, "stopped")
        self.assertFalse(self.client.looping)

    def test_client_id_is_short_enough_for_any_broker(self):
        self.assertLessEqual(len(self.link.client_id), 23)
        self.assertTrue(self.link.client_id.isalnum())


class WithDroneTests(unittest.TestCase):
    def test_copy_keeps_the_shared_answer(self):
        answer = {"source": {"kind": "mqtt"}}
        copy = with_drone(answer, {"state": "LIVE"})
        self.assertEqual(copy["drone"], {"state": "LIVE"})
        self.assertNotIn("drone", answer)
        self.assertIsNone(with_drone(answer, None)["drone"])


if __name__ == "__main__":
    unittest.main()
