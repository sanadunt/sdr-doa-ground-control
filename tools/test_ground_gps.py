#!/usr/bin/env python3
"""The groundstation's own GNSS position (ground_gps.py) from its status to /api/snapshot.

The payloads are those the publisher (packaging/ground-gps) sends, in
tools/fixtures/ground-gps/. The monitor tests use the fake paho client of
test_sdr_doa_mqtt_monitor.py; the HTTP tests start a real GroundConsoleServer
with a fake monitor (a real RDF Node store and a real GroundGpsStore) on both
listeners. ``snapshot-lora-ground.json`` is the answer the frontend tests
read; after an intended change rewrite it with:

    .venv/bin/python -c "import tools.test_ground_gps as t; t.write_ground_fixture()"
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from unittest.mock import patch
from urllib.parse import quote

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

# ground_console resolves its admin password at import time; give it a
# test-only value so the import never reads a local .env file (and the LAN
# view, which stays closed under the default password, can open).
_SAVED_ADMIN_PASSWORD = os.environ.get("SDR_DOA_ADMIN_PASSWORD")
os.environ["SDR_DOA_ADMIN_PASSWORD"] = "ground-gps-no-secret"
try:
    import ground_console  # noqa: E402
finally:
    if _SAVED_ADMIN_PASSWORD is None:
        os.environ.pop("SDR_DOA_ADMIN_PASSWORD", None)
    else:
        os.environ["SDR_DOA_ADMIN_PASSWORD"] = _SAVED_ADMIN_PASSWORD

import sdr_doa_collector as collector  # noqa: E402
import test_sdr_doa_mqtt_monitor as monitor_tests  # noqa: E402
import test_telemetry_source as source_tests  # noqa: E402
from ground_gps import (  # noqa: E402
    GROUND_GPS_SUFFIX,
    STATUS_STALE_MS,
    GroundGpsStore,
    parse_status,
    with_ground_gps,
)
from test_data_out_reader import LoopbackNode  # noqa: E402

NODE = "uav-01"
TOPIC = f"sdr/v2/{NODE}/{GROUND_GPS_SUFFIX}"
GROUND_FIXTURES = TOOLS_DIR / "fixtures" / "ground-gps"
FIXED_NOW = source_tests.FIXED_NOW
DEVICE = "usb-u-blox_AG_-_www.u-blox.com_u-blox_7_-_GPS_GNSS_Receiver-if00"


def payload(name: str) -> bytes:
    return (GROUND_FIXTURES / name).read_bytes()


def status(**fields: Any) -> bytes:
    """The fix fixture with some fields replaced (``_ABSENT`` removes one)."""
    body = json.loads(payload("fix.json"))
    for key, value in fields.items():
        if value is _ABSENT:
            body.pop(key, None)
        else:
            body[key] = value
    return json.dumps(body, separators=(",", ":")).encode()


_ABSENT = object()


# ---------------------------------------------------------------------------
# The answer shared with the frontend tests


def ground_fixture_answer() -> Dict[str, Any]:
    """Edge 1.7 over Telemetry LoRa (mqtt-lora-rf.json) with the groundstation's fix 1 s old."""
    store = GroundGpsStore()
    assert store.ingest(payload("fix.json"), FIXED_NOW - 900)
    answer = source_tests.fixture_answers()["mqtt-lora-rf.json"]
    return with_ground_gps(answer, store.view(FIXED_NOW))


def write_ground_fixture() -> None:
    """Rewrite tools/fixtures/ground-gps/snapshot-lora-ground.json after an intended change."""
    (GROUND_FIXTURES / "snapshot-lora-ground.json").write_text(
        json.dumps(ground_fixture_answer(), indent=1, sort_keys=True) + "\n", encoding="utf-8",
    )


class SharedFixtureTests(unittest.TestCase):
    def test_the_frontend_fixture_is_what_the_server_builds(self) -> None:
        saved = json.loads((GROUND_FIXTURES / "snapshot-lora-ground.json").read_text(encoding="utf-8"))
        built = json.loads(json.dumps(ground_fixture_answer()))
        self.assertEqual(saved, built)
        gps = saved["ground_gps"]
        self.assertEqual((gps["state"], gps["lat"], gps["lon"], gps["alt"], gps["sat"], gps["hdop"], gps["fix"]),
                         ("FIX", -6.9299005, 107.7115572, 697.6, 4, 1.9, 3))
        self.assertEqual(gps["status_age_ms"], 1_000)
        self.assertEqual(saved["source"]["link"], "lora")

    def test_every_payload_fixture_is_one_the_console_reads_without_a_note(self) -> None:
        expected = {"fix.json": "FIX", "no-fix.json": "NO_FIX", "no-device.json": "NO_DEVICE", "stopped.json": "STOPPED"}
        for name, state in expected.items():
            with self.subTest(name=name):
                body = payload(name)
                self.assertLessEqual(len(body), 512)
                parsed = parse_status(body)
                self.assertEqual((parsed["state"], parsed["notes"], parsed["device"]), (state, [], DEVICE))
                store = GroundGpsStore()
                store.ingest(body, FIXED_NOW)
                self.assertEqual(store.view(FIXED_NOW)["state"], state)


# ---------------------------------------------------------------------------
# parse_status


class ParseTests(unittest.TestCase):
    def test_the_fix_reads_every_field(self) -> None:
        parsed = parse_status(payload("fix.json"))
        self.assertEqual(parsed, {
            "v": 1, "t": FIXED_NOW - 1_000, "state": "FIX", "device": DEVICE, "fix": 3, "sat": 4,
            "lat": -6.9299005, "lon": 107.7115572, "alt": 697.6, "hdop": 1.9, "sog": 0.288, "cog": None,
            "gnss_t": FIXED_NOW - 2_000, "error": None, "notes": [],
        })

    def test_a_field_the_console_cannot_use_reads_as_null_with_a_note(self) -> None:
        cases = {
            "lat": (91.0, -90.5, "6.9", True, [1]),
            "lon": (180.5, -181, "107"),
            "alt": (-1_000.5, 20_001, "697"),
            "hdop": (-0.1, 100.5, False),
            "sog": (-0.1, 1_000.5, "0"),
            "cog": (-1, 360.5, "90"),
            "sat": (-1, 65, 4.0, True, "4"),
            "fix": (1, 4, 3.0, True, "3"),
            "t": (-1, "now", True),
            "gnss_t": (-5, "x"),
            "state": ("fix", "LIVE", 1),
            "device": (7, ["a"]),
            "error": (5,),
        }
        for key, values in cases.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    parsed = parse_status(status(**{key: value}))
                    self.assertIsNone(parsed[key])
                    self.assertIn(f"INVALID_FIELD:{key}", parsed["notes"])
                    # The rest of the message stays.
                    self.assertEqual(parsed["sat" if key != "sat" else "fix"], 4 if key != "sat" else 3)

    def test_the_bounds_themselves_are_accepted(self) -> None:
        parsed = parse_status(status(lat=-90, lon=180, alt=-1_000, hdop=0, sog=0, cog=360, sat=64, fix=0))
        self.assertEqual(
            [parsed[key] for key in ("lat", "lon", "alt", "hdop", "sog", "cog", "sat", "fix")],
            [-90.0, 180.0, -1_000.0, 0.0, 0.0, 0.0, 64, 0],
        )
        self.assertEqual(parsed["notes"], [])

    def test_lenient_reading(self) -> None:
        # Unknown fields are ignored, missing ones read as null without a note,
        # NaN reads as null, a float time is a whole millisecond and text is trimmed.
        parsed = parse_status(b'{"v":1,"t":1793070139000.6,"state":"NO_FIX","extra":{"x":1},"hdop":NaN,'
                              b'"device":"  /dev/ttyACM0  ","error":"   "}')
        self.assertEqual((parsed["t"], parsed["state"], parsed["hdop"], parsed["device"], parsed["error"]),
                         (1_793_070_139_000, "NO_FIX", None, "/dev/ttyACM0", None))
        self.assertNotIn("extra", parsed)
        self.assertEqual(parsed["notes"], [])
        long_text = parse_status(json.dumps({"v": 1, "t": 1, "state": "ERROR", "error": "e" * 300}).encode())
        self.assertEqual(len(long_text["error"]), 200)

    def test_half_a_position_is_no_position(self) -> None:
        for fields in ({"lat": None}, {"lon": "x"}, {"lat": _ABSENT}):
            with self.subTest(fields=fields):
                parsed = parse_status(status(**fields))
                self.assertEqual((parsed["lat"], parsed["lon"]), (None, None))
                self.assertIn("PARTIAL_POSITION", parsed["notes"])

    def test_refused_payloads(self) -> None:
        cases = {
            b"x" * 513: "PAYLOAD_TOO_LARGE",
            b"{": "MALFORMED_PAYLOAD",
            b"\xff\xfe": "MALFORMED_PAYLOAD",
            b"[1]": "MALFORMED_PAYLOAD",
            b'"FIX"': "MALFORMED_PAYLOAD",
            b"[" * 400: "MALFORMED_PAYLOAD",
            b'{"t":1}': "UNKNOWN_VERSION",
            b'{"v":2,"t":1}': "UNKNOWN_VERSION",
            b'{"v":"1","t":1}': "UNKNOWN_VERSION",
            b'{"v":true,"t":1}': "UNKNOWN_VERSION",
            b'{"v":1.0,"t":1}': "UNKNOWN_VERSION",
        }
        for body, code in cases.items():
            with self.subTest(body=body[:20], code=code):
                with self.assertRaises(ValueError) as caught:
                    parse_status(body)
                self.assertEqual(str(caught.exception), code)


# ---------------------------------------------------------------------------
# The store and its view


class ViewTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = GroundGpsStore()

    def test_nothing_received_is_none(self) -> None:
        view = self.store.view(FIXED_NOW)
        self.assertEqual((view["present"], view["state"], view["status_age_ms"], view["stale_after_ms"]),
                         (False, "NONE", None, STATUS_STALE_MS))
        self.assertIsNone(view["lat"])

    def test_every_state_and_the_position_only_with_a_fix(self) -> None:
        for state in ("FIX", "NO_FIX", "NO_DEVICE", "NO_DATA", "ERROR", "STOPPED"):
            with self.subTest(state=state):
                # The position fields are sent with every state here; only FIX shows them.
                self.store.ingest(status(state=state, sog=1.5, cog=90), FIXED_NOW)
                view = self.store.view(FIXED_NOW)
                self.assertEqual((view["present"], view["state"], view["status_age_ms"]), (True, state, 1_000))
                position = [view[key] for key in ("lat", "lon", "alt", "sog", "cog")]
                if state == "FIX":
                    self.assertEqual(position, [-6.9299005, 107.7115572, 697.6, 1.5, 90.0])
                else:
                    self.assertEqual(position, [None] * 5)
                # What it says about reception stays.
                self.assertEqual((view["fix"], view["sat"], view["hdop"], view["device"]), (3, 4, 1.9, DEVICE))
                self.assertEqual(view["received_at_ms"], FIXED_NOW)

    def test_stale_by_the_payloads_own_time(self) -> None:
        # Received just now (a retained status after a console restart), dated 10 s ago.
        sent = FIXED_NOW - 1_000
        self.store.ingest(payload("fix.json"), FIXED_NOW + 9_000)
        self.assertEqual(self.store.view(sent + STATUS_STALE_MS)["state"], "FIX")
        stale = self.store.view(sent + STATUS_STALE_MS + 1)
        self.assertEqual((stale["state"], stale["status_age_ms"], stale["lat"], stale["lon"]),
                         ("STALE", STATUS_STALE_MS + 1, None, None))
        self.assertEqual((stale["sat"], stale["device"]), (4, DEVICE))

    def test_a_status_from_the_future_is_stale(self) -> None:
        sent = FIXED_NOW - 1_000
        self.store.ingest(payload("fix.json"), FIXED_NOW)
        ahead = self.store.view(sent - 2_000)
        self.assertEqual((ahead["state"], ahead["status_age_ms"]), ("FIX", 0))
        further = self.store.view(sent - 2_001)
        self.assertEqual((further["state"], further["lat"]), ("STALE", None))
        self.assertIn("SOURCE_TIME_FUTURE", further["notes"])

    def test_an_undated_status_is_stale(self) -> None:
        for t in (_ABSENT, "x"):
            with self.subTest(t=t):
                self.store.ingest(status(t=t), FIXED_NOW)
                view = self.store.view(FIXED_NOW)
                self.assertEqual((view["state"], view["status_age_ms"], view["lat"]), ("STALE", None, None))

    def test_a_fix_without_a_position_and_an_unknown_state_show_no_position(self) -> None:
        self.store.ingest(status(lat=None, lon=None), FIXED_NOW)
        view = self.store.view(FIXED_NOW)
        self.assertEqual((view["state"], view["lat"]), ("NO_FIX", None))
        self.assertIn("FIX_WITHOUT_POSITION", view["notes"])
        self.store.ingest(status(state="SEARCHING"), FIXED_NOW)
        view = self.store.view(FIXED_NOW)
        self.assertEqual((view["state"], view["lat"]), ("NO_FIX", None))
        self.assertIn("INVALID_FIELD:state", view["notes"])
        self.store.ingest(status(state=_ABSENT), FIXED_NOW)
        self.assertIn("MISSING_FIELD:state", self.store.view(FIXED_NOW)["notes"])

    def test_a_number_beyond_a_float_never_ends_the_mqtt_thread(self) -> None:
        # Any broker client may publish this; the store runs in paho's network thread.
        huge = "9" * 320  # beyond a float (about 1.8e308), still under the 512-byte cap
        for field in ("lat", "alt", "hdop", "gnss_t", "t"):
            with self.subTest(field=field):
                fields = {"t": FIXED_NOW, "lat": -6.9299, "lon": 107.7115, "alt": 697.6, "hdop": 1.9, "gnss_t": FIXED_NOW}
                fields[field] = 12345
                raw = (b'{"v":1,"state":"FIX","fix":3,"sat":4,' + json.dumps(fields, separators=(",", ":"))[1:].encode()
                       ).replace(b"12345", huge.encode(), 1)
                self.assertLessEqual(len(raw), 512)
                store = GroundGpsStore()
                store.ingest(raw, FIXED_NOW)
                view = store.view(FIXED_NOW)
                if field == "t":
                    self.assertEqual(view["state"], "STALE")
                else:
                    self.assertIsNone(view.get(field) if field in view else None)

    def test_a_refused_payload_is_counted_and_keeps_the_last_status(self) -> None:
        self.store.ingest(payload("fix.json"), FIXED_NOW)
        self.assertFalse(self.store.ingest(b'{"v":2}', FIXED_NOW))
        view = self.store.view(FIXED_NOW)
        self.assertEqual((view["state"], view["invalid"], view["last_invalid"]), ("FIX", 1, "UNKNOWN_VERSION"))

    def test_a_retained_clear_removes_the_status(self) -> None:
        self.store.ingest(payload("fix.json"), FIXED_NOW)
        self.assertTrue(self.store.ingest(b"", FIXED_NOW))
        view = self.store.view(FIXED_NOW)
        self.assertEqual((view["present"], view["state"]), (False, "NONE"))

    def test_with_ground_gps_copies_the_answer(self) -> None:
        shared = {"source": {"kind": "mqtt"}}
        view = {"state": "FIX"}
        answer = with_ground_gps(shared, view)
        self.assertEqual(answer, {"source": {"kind": "mqtt"}, "ground_gps": {"state": "FIX"}})
        self.assertNotIn("ground_gps", shared)
        self.assertIsNot(answer["ground_gps"], view)
        self.assertIsNone(with_ground_gps(shared, None)["ground_gps"])


# ---------------------------------------------------------------------------
# The monitor


class MonitorTests(unittest.TestCase):
    def setUp(self) -> None:
        paho, self.Client = monitor_tests.fake_paho()
        self.module = monitor_tests.load_monitor(paho)
        self.monitor = self.module.MqttMonitor("127.0.0.1", 1883)
        self.monitor.start()
        self.addCleanup(self.monitor.stop)
        self.client = self.Client.instances[-1]
        self.client.on_connect(self.client, None, {}, types.SimpleNamespace(value=0, is_failure=False), None)
        count = len(self.client.subscriptions)
        self.client.on_subscribe(self.client, None, self.client.mid, monitor_tests.successful_codes(count), None)

    def test_it_subscribes_to_the_ground_gps_status_after_the_lora_status(self) -> None:
        topics = [topic for topic, _options in self.client.subscriptions]
        self.assertEqual(topics[-3:], [f"sdr/v2/{NODE}/lora/ground", f"sdr/v2/{NODE}/lora/edge", TOPIC])
        self.assertEqual(topics.count(TOPIC), 1)

    def test_the_status_reaches_api_mqtt_and_the_view_without_counting_as_rdf_node_traffic(self) -> None:
        clock = [FIXED_NOW]
        with patch.object(self.module, "_now_ms", lambda: clock[0]):
            self.assertEqual(self.monitor.snapshot()["ground_gps"]["state"], "NONE")
            self.assertEqual(self.monitor.ground_gps_view()["present"], False)
            self.client.on_message(self.client, None, monitor_tests.message(TOPIC, payload("fix.json"), 0, True))
            snapshot = self.monitor.snapshot()
            rdf = self.monitor.rdf_node_snapshot()
            view = self.monitor.ground_gps_view()
        gps = snapshot["ground_gps"]
        self.assertEqual((gps["state"], gps["lat"], gps["lon"], gps["status_age_ms"]),
                         ("FIX", -6.9299005, 107.7115572, 1_000))
        self.assertEqual(view, gps)
        self.assertEqual((snapshot["received"], snapshot["valid"], snapshot["invalid"]), (0, 0, 0))
        self.assertNotIn(GROUND_GPS_SUFFIX, rdf["topics"])
        self.assertEqual(self.monitor.ground_gps_view(FIXED_NOW + STATUS_STALE_MS)["state"], "STALE")
        self.assertEqual(self.client.publish_calls, [])

    def test_a_ground_gps_status_of_another_node_is_ignored(self) -> None:
        self.client.on_message(self.client, None, monitor_tests.message(
            f"sdr/v2/uav-02/{GROUND_GPS_SUFFIX}", payload("fix.json"), 0, True))
        self.assertFalse(self.monitor.ground_gps_view()["present"])


# ---------------------------------------------------------------------------
# /api/snapshot on both listeners


class GroundMonitor(source_tests.FakeMonitor):
    """The fake monitor of test_telemetry_source.py with the groundstation's GNSS status."""

    def __init__(self) -> None:
        super().__init__()
        self.ground = GroundGpsStore()

    def publish(self, body: bytes) -> None:
        with self.lock:
            self.ground.ingest(body, collector.now_ms())

    def ground_gps_view(self) -> Dict[str, Any]:
        with self.lock:
            return self.ground.view(collector.now_ms())


def fresh(name: str, **fields: Any) -> bytes:
    body = json.loads(payload(name))
    body.update(t=collector.now_ms(), **fields)
    return json.dumps(body, separators=(",", ":")).encode()


class SnapshotHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        for handler in (ground_console.ConsoleHandler, ground_console.LanConsoleHandler):
            quiet = patch.object(handler, "log_message", lambda *_args: None)
            quiet.start()
            self.addCleanup(quiet.stop)
        self.node = LoopbackNode()
        self.addCleanup(self.node.close)

    def start_console(self, monitor: Optional[Any]) -> Tuple[Any, int]:
        # The LAN view stays closed under the default password; another test's
        # main() may have left the module's ADMIN_PASSWORD at None or the default.
        password = patch.object(ground_console, "ADMIN_PASSWORD", "ground-gps-no-secret")
        password.start()
        self.addCleanup(password.stop)
        temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-ground-gps-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        server = ground_console.GroundConsoleServer(
            ("127.0.0.1", 0),
            source_tests.BASE_URL,
            mqtt_monitor=monitor,
            config_path=str(root / "console.json"),
            branding_path=str(root / "branding.json"),
            receiver_data_dir=root / "receiver",
            tile_cache_dir=root / "tiles",
            data_out_fetcher=self.node.fetcher,
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
    def get(port: int, path: str) -> Dict[str, Any]:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            connection.request("GET", path)
            response = connection.getresponse()
            body = response.read()
            if response.status != 200:
                raise AssertionError(f"HTTP {response.status}: {body[:200]!r}")
            return json.loads(body)
        finally:
            connection.close()

    def snapshot_path(self, query: str = "") -> str:
        return "/api/snapshot?base_url=" + quote(source_tests.BASE_URL, safe="") + query

    def test_every_answer_carries_the_view_at_answer_time_on_both_listeners(self) -> None:
        monitor = GroundMonitor()
        server, port = self.start_console(monitor)
        monitor.publish(fresh("fix.json"))
        status = server.lan.apply(
            {"enabled": True, "port": 0, "bind": "127.0.0.1", "allowed_clients": []},
            allowed=[ipaddress.ip_network("127.0.0.1/32")],
        )
        self.assertEqual(status["state"], "open", status)
        lan_port = int(server.lan._server.server_address[1])

        # No MQTT session: a Data Out answer, the legacy UI's and the LAN view's.
        local = self.get(port, self.snapshot_path())
        self.assertEqual(local["source"]["kind"], "data_out")
        self.assertEqual((local["ground_gps"]["state"], local["ground_gps"]["lat"]), ("FIX", -6.9299005))
        legacy = self.get(port, self.snapshot_path("&source=data_out"))
        self.assertEqual(legacy["ground_gps"]["state"], "FIX")
        remote = self.get(lan_port, "/api/snapshot")
        self.assertEqual(remote["ground_gps"]["lon"], 107.7115572)

        # The shared Data Out read is reused, while the position is the one at answer time.
        monitor.publish(fresh("no-device.json"))
        again = self.get(port, self.snapshot_path(f"&seen={quote(local['collection']['id'])}"))
        self.assertEqual(again["collection"]["id"], local["collection"]["id"])
        self.assertEqual((again["ground_gps"]["state"], again["ground_gps"]["lat"]), ("NO_DEVICE", None))
        self.assertEqual(self.get(lan_port, "/api/snapshot")["ground_gps"]["state"], "NO_DEVICE")

        # From MQTT too.
        with monitor.lock:
            monitor.edge.live()
        mqtt = self.get(port, self.snapshot_path())
        self.assertEqual((mqtt["source"]["kind"], mqtt["ground_gps"]["state"]), ("mqtt", "NO_DEVICE"))
        self.assertEqual(self.get(lan_port, "/api/snapshot")["source"]["kind"], "mqtt")

    def test_the_shared_answer_is_never_changed(self) -> None:
        monitor = GroundMonitor()
        server, _port = self.start_console(monitor)
        monitor.publish(fresh("fix.json"))
        shared = {"source": {"kind": "none"}}
        with patch.object(server.data_out, "snapshot", lambda *_args, **_kwargs: shared):
            first = server.collect_snapshot(source_tests.BASE_URL)
            monitor.publish(fresh("stopped.json"))
            second = server.collect_snapshot(source_tests.BASE_URL)
        self.assertEqual(shared, {"source": {"kind": "none"}})
        self.assertEqual((first["ground_gps"]["state"], second["ground_gps"]["state"]), ("FIX", "STOPPED"))

    def test_without_a_monitor_it_is_null(self) -> None:
        _server, port = self.start_console(None)
        answer = self.get(port, self.snapshot_path())
        self.assertIn("ground_gps", answer)
        self.assertIsNone(answer["ground_gps"])

    def test_a_monitor_without_the_reader_gives_null(self) -> None:
        _server, port = self.start_console(source_tests.FakeMonitor())
        self.assertIsNone(self.get(port, self.snapshot_path())["ground_gps"])


if __name__ == "__main__":
    unittest.main()
