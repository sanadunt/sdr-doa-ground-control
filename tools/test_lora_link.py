"""Tests for the LoRa serial bridge status the console reads (tools/lora_link.py)."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from tools.lora_link import (
    CLOCK_OFFSET_WARN_MS,
    LORA_SUFFIXES,
    STATUS_MAX_BYTES,
    STATUS_STALE_MS,
    LoraLinkStore,
    parse_status,
)

T0 = 1_793_500_000_000
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "lora-link" / "views.json"


def status(t: int = T0, *, link: str = "UP", last_rx_ms: int | None = 400, frames: int = 100, messages: int = 50,
           heartbeats: int = 10, port: str = "OPEN", offset: int = -35, **extra: object) -> bytes:
    body = {
        "v": 1, "role": "ground", "t": t, "link": link, "last_rx_ms": last_rx_ms, "port": port,
        "port_error": None if port == "OPEN" else "ENOENT", "mqtt": "CONNECTED",
        "rx": {"frames": frames, "crc_errors": 1, "bad_frames": 0, "lost_frames": 3, "messages": messages,
               "duplicates": 12, "incomplete": 0, "heartbeats": heartbeats},
        "tx": {"queued": 20, "superseded": 0, "expired": 0, "sent_messages": 20, "sent_frames": 200,
               "sent_bytes": 2400, "too_large": 0},
        "queue": 0,
        "peer": {"uptime_s": 812, "rx_frames": 198, "crc_errors": 0, "lost_frames": 2, "clock_offset_ms": offset},
        "mqtt_dropped": 0, "ignored": 0, "link_changes": 1,
    }
    body.update(extra)
    return json.dumps(body).encode("utf-8")


class ParseTests(unittest.TestCase):
    def test_documented_status_is_read_in_full(self) -> None:
        parsed = parse_status(status())
        self.assertEqual((parsed["v"], parsed["t"], parsed["link"], parsed["last_rx_ms"]), (1, T0, "UP", 400))
        self.assertEqual(parsed["rx"]["messages"], 50)
        # Edge 1.10.2 counts the other end's restarts; an older bridge sends none.
        self.assertIsNone(parsed["rx"]["peer_restarts"])
        rx = dict(json.loads(status())["rx"], peer_restarts=2)
        self.assertEqual(parse_status(status(rx=rx))["rx"]["peer_restarts"], 2)
        self.assertEqual(parsed["tx"]["sent_bytes"], 2400)
        self.assertEqual(parsed["peer"]["clock_offset_ms"], -35)
        self.assertEqual(parsed["notes"], [])

    def test_lenient_fields_read_as_null(self) -> None:
        parsed = parse_status(status(link="MAYBE", last_rx_ms=None, rx="oops", peer=None, queue=-1, v=2))
        self.assertIsNone(parsed["link"])
        self.assertIsNone(parsed["last_rx_ms"])
        self.assertEqual(set(parsed["rx"].values()), {None})
        self.assertIsNone(parsed["peer"])
        self.assertIsNone(parsed["queue"])
        self.assertEqual(parsed["notes"], ["UNKNOWN_VERSION"])

    def test_refused_payloads(self) -> None:
        for payload, code in ((b"[1]", "MALFORMED_PAYLOAD"), (b"{", "MALFORMED_PAYLOAD"), (b"\xff", "MALFORMED_PAYLOAD"),
                              (b"{" + b" " * STATUS_MAX_BYTES + b"}", "PAYLOAD_TOO_LARGE")):
            with self.subTest(payload=payload[:8]):
                with self.assertRaisesRegex(ValueError, code):
                    parse_status(payload)

    def test_nan_reads_as_null(self) -> None:
        parsed = parse_status(b'{"v":1,"t":NaN,"link":"UP","peer":{"clock_offset_ms":NaN}}')
        self.assertIsNone(parsed["t"])
        self.assertIsNone(parsed["peer"]["clock_offset_ms"])


class StoreTests(unittest.TestCase):
    def test_suffixes(self) -> None:
        self.assertEqual(LORA_SUFFIXES, ("lora/ground", "lora/edge"))

    def test_absent_until_a_bridge_reports(self) -> None:
        view = LoraLinkStore().view(T0)
        self.assertFalse(view["present"])
        self.assertIsNone(view["ground"])

    def test_data_indicator_follows_message_rate(self) -> None:
        store = LoraLinkStore()
        store.ingest("ground", status(T0, frames=100, messages=50, heartbeats=10), T0)
        first = store.view(T0)["ground"]
        self.assertEqual((first["state"], first["data"], first["rates"]), ("UP", "UNKNOWN", None))
        store.ingest("ground", status(T0 + 5000, frames=130, messages=70, heartbeats=11), T0 + 5000)
        view = store.view(T0 + 5200)["ground"]
        self.assertEqual(view["data"], "DATA")
        self.assertEqual(view["rates"]["frames"], 6.0)
        self.assertEqual(view["rates"]["messages"], 4.0)
        self.assertEqual(view["status_age_ms"], 200)
        self.assertEqual(view["since_rx_ms"], 600)
        store.ingest("ground", status(T0 + 10000, frames=131, messages=70, heartbeats=12), T0 + 10000)
        self.assertEqual(store.view(T0 + 10000)["ground"]["data"], "LINK_ONLY")

    def test_no_rx_and_down_link(self) -> None:
        store = LoraLinkStore()
        store.ingest("ground", status(T0, last_rx_ms=7000), T0)
        self.assertEqual(store.view(T0)["ground"]["data"], "NONE")
        store.ingest("ground", status(T0 + 5000, link="DOWN", last_rx_ms=None), T0 + 5000)
        view = store.view(T0 + 5000)["ground"]
        self.assertEqual((view["state"], view["data"], view["since_rx_ms"]), ("DOWN", "NONE", None))

    def test_port_error(self) -> None:
        store = LoraLinkStore()
        store.ingest("ground", status(port="ERROR", link="DOWN"), T0)
        self.assertEqual(store.view(T0)["ground"]["state"], "PORT_ERROR")

    def test_stale_by_the_status_clock_also_for_a_retained_replay(self) -> None:
        store = LoraLinkStore()
        # A console restart gets the retained status of a bridge that stopped a minute ago.
        store.ingest("ground", status(T0 - 60_000), T0)
        view = store.view(T0)["ground"]
        self.assertEqual(view["state"], "STALE")
        self.assertEqual(view["data"], "NONE")
        store.ingest("ground", status(T0), T0)
        self.assertEqual(store.view(T0 + STATUS_STALE_MS)["ground"]["state"], "UP")
        self.assertEqual(store.view(T0 + STATUS_STALE_MS + 1)["ground"]["state"], "STALE")

    def test_implausible_clock_dates_by_receipt(self) -> None:
        store = LoraLinkStore()
        store.ingest("ground", status(1000), T0)
        self.assertEqual(store.view(T0 + 2000)["ground"]["status_age_ms"], 2000)

    def test_counter_reset_gives_no_rate(self) -> None:
        store = LoraLinkStore()
        store.ingest("ground", status(T0, frames=500, messages=400), T0)
        store.ingest("ground", status(T0 + 5000, frames=10, messages=5), T0 + 5000)
        self.assertIsNone(store.view(T0 + 5000)["ground"]["rates"])

    def test_clock_warning(self) -> None:
        store = LoraLinkStore()
        store.ingest("ground", status(offset=CLOCK_OFFSET_WARN_MS), T0)
        self.assertFalse(store.view(T0)["ground"]["clock_warning"])
        store.ingest("ground", status(T0 + 5000, offset=-CLOCK_OFFSET_WARN_MS - 1), T0 + 5000)
        self.assertTrue(store.view(T0 + 5000)["ground"]["clock_warning"])

    def test_invalid_counted_and_clear_removes(self) -> None:
        store = LoraLinkStore()
        self.assertFalse(store.ingest("ground", b"not json", T0))
        self.assertEqual((store.invalid, store.last_invalid), (1, "MALFORMED_PAYLOAD"))
        self.assertFalse(store.ingest("relay", status(), T0))
        store.ingest("ground", status(), T0)
        store.ingest("edge", status(), T0)
        self.assertIsNotNone(store.view(T0)["edge"])
        store.ingest("ground", b"", T0)
        view = store.view(T0)
        self.assertIsNone(view["ground"])
        self.assertTrue(view["present"])


def fixture_views() -> dict:
    """Views of the bridge states lib/loraLink.test.ts reads (the `lora` block of /api/mqtt)."""
    views = {"absent": LoraLinkStore().view(T0)}
    store = LoraLinkStore()
    store.ingest("ground", status(T0, frames=100, messages=50, heartbeats=10), T0)
    store.ingest("ground", status(T0 + 5000, frames=130, messages=70, heartbeats=11), T0 + 5000)
    views["receiving"] = store.view(T0 + 5200)
    store.ingest("ground", status(T0 + 10000, frames=131, messages=70, heartbeats=12), T0 + 10000)
    views["idle"] = store.view(T0 + 10000)
    store.ingest("ground", status(T0 + 15000, link="DOWN", last_rx_ms=16000, frames=131, messages=70, heartbeats=12), T0 + 15000)
    views["down"] = store.view(T0 + 15000)
    views["stale"] = store.view(T0 + 15000 + 40_000)
    store = LoraLinkStore()
    store.ingest("ground", status(T0, port="ERROR", link="DOWN", last_rx_ms=None), T0)
    views["port_error"] = store.view(T0)
    store = LoraLinkStore()
    store.ingest("ground", status(T0, offset=-2400), T0)
    store.ingest("ground", status(T0 + 5000, frames=120, messages=60, offset=-2400), T0 + 5000)
    views["clock"] = store.view(T0 + 5000)
    return views


def write_fixture() -> None:
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(fixture_views(), indent=2, sort_keys=True) + "\n", encoding="utf-8")


class FixtureTests(unittest.TestCase):
    def test_shared_fixture_is_what_the_store_builds(self) -> None:
        # After a deliberate change: python3 -c "import tools.test_lora_link as t; t.write_fixture()"
        self.assertEqual(json.loads(FIXTURE.read_text(encoding="utf-8")), fixture_views())


if __name__ == "__main__":
    unittest.main()
