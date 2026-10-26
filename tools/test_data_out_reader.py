#!/usr/bin/env python3
"""Shared Data Out reads (issue #13): the reuse window, viewers, refresh and Cek ulang.

The reader tests run on a fake clock and a fake collection. The HTTP tests
start a real GroundConsoleServer against a loopback fake Data Out and count
the GETs it receives with one and with five polling viewers. The collector's
settings.json reuse is tested in test_sdr_doa_collector.py.
"""

from __future__ import annotations

import collections
import http.client
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from unittest.mock import patch
from urllib.parse import quote

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

# ground_console resolves its admin password at import time; give it a
# test-only value so the import never reads a local .env file.
_SAVED_ADMIN_PASSWORD = os.environ.get("SDR_DOA_ADMIN_PASSWORD")
os.environ["SDR_DOA_ADMIN_PASSWORD"] = "data-out-reader-no-secret"
try:
    import ground_console  # noqa: E402
finally:
    if _SAVED_ADMIN_PASSWORD is None:
        os.environ.pop("SDR_DOA_ADMIN_PASSWORD", None)
    else:
        os.environ["SDR_DOA_ADMIN_PASSWORD"] = _SAVED_ADMIN_PASSWORD

import data_out_reader as dor  # noqa: E402
import sdr_doa_collector as collector  # noqa: E402
from test_sdr_doa_collector import make_csv, make_status, make_xml  # noqa: E402
from data_out_reader import DataOutReader, SnapshotRequest  # noqa: E402

BASE_URL = "http://127.0.0.1:8081"


class FakeClock:
    def __init__(self, start: float = 1_000.0) -> None:
        self.now = start
        self.lock = threading.Lock()

    def __call__(self) -> float:
        with self.lock:
            return self.now

    def advance(self, seconds: float) -> None:
        with self.lock:
            self.now += seconds


class FakeCollect:
    """Counts collections; each takes ``duration`` seconds of the fake clock."""

    def __init__(self, clock: FakeClock, duration: float = 0.0) -> None:
        self.clock = clock
        self.duration = duration
        self.calls: List[Tuple[str, bool]] = []
        self.error: Optional[BaseException] = None
        self.settings_reused = False
        self.gate: Optional[threading.Event] = None
        self.entered = threading.Event()

    def __call__(self, base_url: str, fresh_settings: bool) -> Dict[str, Any]:
        self.calls.append((base_url, fresh_settings))
        self.entered.set()
        if self.gate is not None:
            self.gate.wait(5)
        self.clock.advance(self.duration)
        if self.error is not None:
            raise self.error
        return {
            "completed_at_ms": 5_000_000 + len(self.calls),
            "overall_state": "UNVERIFIED",
            "collection": {
                "elapsed_ms": int(self.duration * 1000),
                "settings_reused": self.settings_reused and not fresh_settings,
                "settings_age_ms": 12_000 if self.settings_reused and not fresh_settings else 0,
            },
        }


def make_reader(refresh_seconds: Any = 2, duration: float = 0.0) -> Tuple[DataOutReader, FakeClock, FakeCollect, Dict[str, Any]]:
    clock = FakeClock()
    fake = FakeCollect(clock, duration)
    config: Dict[str, Any] = {"refresh_seconds": refresh_seconds, "base_url": BASE_URL}
    reader = DataOutReader(
        fake, lambda: config["refresh_seconds"], wait_timeout_s=5.0, clock=clock, wall_ms=lambda: 9_000_000,
        console_base_url=lambda: config["base_url"],
    )
    return reader, clock, fake, config


def simulate_viewers(viewers: int, interval_s: float, duration_s: float, collect_s: float = 0.0, send_seen: bool = True) -> int:
    """Viewers poll like the browser: one interval after their previous request started."""
    reader, clock, fake, _config = make_reader(refresh_seconds=interval_s, duration=collect_s)
    start = clock()
    # Each viewer: next poll time and the collection id it shows.
    state = [{"next": start + index * interval_s / viewers, "seen": None} for index in range(viewers)]
    while True:
        viewer = min(state, key=lambda item: item["next"])
        if viewer["next"] >= start + duration_s:
            break
        clock.now = max(clock.now, viewer["next"])
        poll_started = clock()
        answer = reader.snapshot(BASE_URL, SnapshotRequest(seen=viewer["seen"] if send_seen else None))
        viewer["seen"] = answer["collection"]["id"]
        viewer["next"] = poll_started + interval_s
    return len(fake.calls)


class ReuseWindowTests(unittest.TestCase):
    def test_window_is_the_saved_interval_and_at_least_one_second(self) -> None:
        self.assertEqual(dor.reuse_window_s(0), 1.0)
        self.assertEqual(dor.reuse_window_s(1), 1.0)
        self.assertEqual(dor.reuse_window_s(2), 2.0)
        self.assertEqual(dor.reuse_window_s(30), 30.0)
        for bad in (None, "5", True, float("nan"), float("inf"), -3):
            self.assertEqual(dor.reuse_window_s(bad), 1.0, bad)

    def test_read_reason_is_the_single_decision(self) -> None:
        reader, _clock, _fake, _config = make_reader()
        last = dor._Collection("0badc0de-1", 0.0, False)
        last.result = {"collection": {"settings_reused": True}}
        reason = reader.read_reason
        plain = SnapshotRequest()
        self.assertEqual(reason(None, plain, 0.0, 2.0), "first")
        self.assertIsNone(reason(last, plain, 1.99, 2.0))
        self.assertEqual(reason(last, plain, 2.0, 2.0), "expired")
        # A viewer that already shows the collection reads again 0.25 s early.
        self.assertIsNone(reason(last, SnapshotRequest(seen="0badc0de-1"), 1.74, 2.0))
        self.assertEqual(reason(last, SnapshotRequest(seen="0badc0de-1"), 1.75, 2.0), "seen")
        self.assertIsNone(reason(last, SnapshotRequest(seen="0badc0de-9"), 1.9, 2.0))
        self.assertIsNone(reason(last, SnapshotRequest(refresh=True), 0.99, 30.0))
        self.assertEqual(reason(last, SnapshotRequest(refresh=True), 1.0, 30.0), "refresh")
        # Cek ulang reads settings.json again unless the last collection just did.
        self.assertEqual(reason(last, SnapshotRequest(refresh=True, fresh_settings=True), 0.2, 30.0), "fresh_settings")
        last.result = {"collection": {"settings_reused": False}}
        self.assertIsNone(reason(last, SnapshotRequest(refresh=True, fresh_settings=True), 0.2, 30.0))
        self.assertEqual(reason(last, SnapshotRequest(refresh=True, fresh_settings=True), 1.0, 30.0), "fresh_settings")

    def test_valid_collection_id(self) -> None:
        self.assertEqual(dor.valid_collection_id("0badc0de-12"), "0badc0de-12")
        for bad in ("", "x", "0badc0de-", "0BADC0DE-1", "0badc0de-1 ", None, 7, "0badc0de-1234567890123"):
            self.assertIsNone(dor.valid_collection_id(bad), bad)


class SharedReadTests(unittest.TestCase):
    def test_one_and_five_viewers_cause_the_same_reads(self) -> None:
        for interval in (1, 2, 5, 30):
            duration = interval * 20
            one = simulate_viewers(1, interval, duration)
            five = simulate_viewers(5, interval, duration)
            self.assertEqual(one, 20, interval)
            self.assertEqual(five, one, interval)

    def test_slow_reads_are_shared_too(self) -> None:
        # A PPP read of about 1.5 s: requests during it wait for it.
        self.assertEqual(simulate_viewers(5, 2, 40, collect_s=1.5), simulate_viewers(1, 2, 40, collect_s=1.5))

    def test_viewers_without_seen_read_at_most_once_per_window(self) -> None:
        # The legacy UI or curl: plain window reuse.
        self.assertLessEqual(simulate_viewers(5, 2, 40, send_seen=False), 21)

    def test_answer_from_the_last_collection_inside_the_window(self) -> None:
        reader, clock, fake, _config = make_reader(refresh_seconds=2)
        first = reader.snapshot(BASE_URL)
        self.assertFalse(first["collection"]["shared"])
        self.assertEqual(first["collection"]["age_ms"], 0)
        clock.advance(1.5)
        second = reader.snapshot(BASE_URL)
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(second["collection"]["id"], first["collection"]["id"])
        self.assertTrue(second["collection"]["shared"])
        self.assertEqual(second["collection"]["age_ms"], 1500)
        self.assertEqual(second["collection"]["collected_at_ms"], first["completed_at_ms"])
        # The kept result itself is not changed by an answer.
        self.assertNotIn("id", reader._targets[BASE_URL].last.result["collection"])
        clock.advance(0.5)
        third = reader.snapshot(BASE_URL + "/")
        self.assertEqual(len(fake.calls), 2)
        self.assertNotEqual(third["collection"]["id"], first["collection"]["id"])

    def test_window_follows_the_saved_interval(self) -> None:
        reader, clock, fake, config = make_reader(refresh_seconds=0)
        reader.snapshot(BASE_URL)
        clock.advance(0.9)
        reader.snapshot(BASE_URL)
        self.assertEqual(len(fake.calls), 1, "manual mode still shares for 1 s")
        clock.advance(0.1)
        reader.snapshot(BASE_URL)
        self.assertEqual(len(fake.calls), 2)
        config["refresh_seconds"] = 10
        clock.advance(9.9)
        reader.snapshot(BASE_URL)
        self.assertEqual(len(fake.calls), 2)

    def test_answers_report_the_saved_interval_now(self) -> None:
        reader, clock, _fake, config = make_reader(refresh_seconds=2)
        self.assertEqual(reader.snapshot(BASE_URL)["collection"]["refresh_seconds"], 2)
        # Another page saves 30 s: the next answer, still the same read, says so.
        config["refresh_seconds"] = 30
        clock.advance(0.5)
        shared = reader.snapshot(BASE_URL)
        self.assertTrue(shared["collection"]["shared"])
        self.assertEqual(shared["collection"]["refresh_seconds"], 30)
        self.assertEqual(dor.saved_refresh_seconds(0), 0)
        for bad in (None, "5", True, 2.5, -1, float("nan")):
            self.assertIsNone(dor.saved_refresh_seconds(bad), bad)

    def test_answers_report_the_console_url_now(self) -> None:
        reader, clock, _fake, config = make_reader(refresh_seconds=2)
        self.assertEqual(reader.snapshot(BASE_URL)["collection"]["console_base_url"], BASE_URL)
        # Another page moves Data Out: a page still reading the old URL is told.
        config["base_url"] = "http://192.168.100.100:8081/"
        clock.advance(0.5)
        self.assertEqual(reader.snapshot(BASE_URL)["collection"]["console_base_url"], "http://192.168.100.100:8081")
        for bad in (None, "", 8081):
            config["base_url"] = bad
            clock.advance(0.1)
            self.assertIsNone(reader.snapshot(BASE_URL)["collection"]["console_base_url"], bad)
        # A reader without the callable reports none.
        plain = DataOutReader(lambda _url, _fresh: {"collection": {}}, lambda: 2, wait_timeout_s=1.0)
        self.assertIsNone(plain.snapshot(BASE_URL)["collection"]["console_base_url"])

    def test_targets_are_kept_apart(self) -> None:
        reader, _clock, fake, _config = make_reader()
        reader.snapshot(BASE_URL)
        reader.snapshot("http://doasdr.local:8081")
        reader.snapshot(BASE_URL)
        self.assertEqual([call[0] for call in fake.calls], [BASE_URL, "http://doasdr.local:8081"])

    def test_manual_refresh_reads_once_the_last_read_is_one_second_old(self) -> None:
        reader, clock, fake, _config = make_reader(refresh_seconds=30)
        reader.snapshot(BASE_URL)
        clock.advance(0.5)
        reader.snapshot(BASE_URL, SnapshotRequest(refresh=True))
        self.assertEqual(len(fake.calls), 1)
        clock.advance(0.5)
        refreshed = reader.snapshot(BASE_URL, SnapshotRequest(refresh=True))
        self.assertEqual(len(fake.calls), 2)
        self.assertFalse(refreshed["collection"]["shared"])

    def test_fresh_settings_is_passed_to_the_collector_and_rate_limited(self) -> None:
        reader, clock, fake, _config = make_reader(refresh_seconds=2)
        fake.settings_reused = True
        reader.snapshot(BASE_URL)
        self.assertEqual(fake.calls[-1], (BASE_URL, False))
        clock.advance(0.3)
        # The last read reused settings.json: Cek ulang reads it now.
        checked = reader.snapshot(BASE_URL, SnapshotRequest(refresh=True, fresh_settings=True))
        self.assertEqual(fake.calls[-1], (BASE_URL, True))
        self.assertFalse(checked["collection"]["settings_reused"])
        clock.advance(0.3)
        reader.snapshot(BASE_URL, SnapshotRequest(refresh=True, fresh_settings=True))
        self.assertEqual(len(fake.calls), 2, "a second Cek ulang within 1 s is answered from the first")
        clock.advance(0.7)
        reader.snapshot(BASE_URL, SnapshotRequest(refresh=True, fresh_settings=True))
        self.assertEqual(len(fake.calls), 3)

    def test_settings_age_counts_the_time_since_the_collection(self) -> None:
        reader, clock, fake, _config = make_reader(refresh_seconds=5)
        fake.settings_reused = True
        reader.snapshot(BASE_URL)
        clock.advance(2.0)
        answer = reader.snapshot(BASE_URL)
        self.assertTrue(answer["collection"]["settings_reused"])
        self.assertEqual(answer["collection"]["settings_age_ms"], 14_000)

    def test_errors_are_kept_for_the_window(self) -> None:
        reader, clock, fake, _config = make_reader(refresh_seconds=2)
        fake.error = collector.CollectorError("boom")
        with self.assertRaises(collector.CollectorError):
            reader.snapshot(BASE_URL)
        clock.advance(1.0)
        with self.assertRaisesRegex(collector.CollectorError, "boom"):
            reader.snapshot(BASE_URL, SnapshotRequest(seen="0badc0de-1"))
        self.assertEqual(len(fake.calls), 1, "an unreachable node is not asked again by every viewer")
        fake.error = None
        clock.advance(1.0)
        self.assertEqual(reader.snapshot(BASE_URL)["overall_state"], "UNVERIFIED")
        self.assertEqual(len(fake.calls), 2)

    def test_an_error_is_retried_by_refresh_after_one_second(self) -> None:
        reader, clock, fake, _config = make_reader(refresh_seconds=30)
        fake.error = ValueError("bad")
        with self.assertRaises(ValueError):
            reader.snapshot(BASE_URL)
        clock.advance(1.0)
        fake.error = None
        reader.snapshot(BASE_URL, SnapshotRequest(refresh=True))
        self.assertEqual(len(fake.calls), 2)

    def test_concurrent_misses_share_one_collection(self) -> None:
        reader, _clock, fake, _config = make_reader(refresh_seconds=2)
        fake.gate = threading.Event()
        answers: List[Dict[str, Any]] = []
        errors: List[BaseException] = []

        def request(options: SnapshotRequest) -> None:
            try:
                answers.append(reader.snapshot(BASE_URL, options))
            except BaseException as exc:  # pragma: no cover - reported below
                errors.append(exc)

        threads = [threading.Thread(target=request, args=(SnapshotRequest(refresh=index % 2 == 0),)) for index in range(8)]
        threads[0].start()
        self.assertTrue(fake.entered.wait(5))
        for thread in threads[1:]:
            thread.start()
        time.sleep(0.1)
        fake.gate.set()
        for thread in threads:
            thread.join(5)
        self.assertEqual(errors, [])
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual({answer["collection"]["id"] for answer in answers}, {answers[0]["collection"]["id"]})
        self.assertEqual(sorted(answer["collection"]["shared"] for answer in answers), [False] + [True] * 7)

    def test_cek_ulang_waits_for_a_read_that_reuses_settings_and_reads_again(self) -> None:
        reader, _clock, fake, _config = make_reader(refresh_seconds=2)
        fake.settings_reused = True
        fake.gate = threading.Event()
        answers: List[Dict[str, Any]] = []
        poll = threading.Thread(target=lambda: answers.append(reader.snapshot(BASE_URL)))
        poll.start()
        self.assertTrue(fake.entered.wait(5))
        check = threading.Thread(target=lambda: answers.append(reader.snapshot(BASE_URL, SnapshotRequest(refresh=True, fresh_settings=True))))
        check.start()
        time.sleep(0.1)
        fake.gate.set()
        poll.join(5)
        check.join(5)
        self.assertEqual(fake.calls, [(BASE_URL, False), (BASE_URL, True)])
        self.assertEqual(sorted(answer["collection"]["settings_reused"] for answer in answers), [False, True])

    def test_a_waiting_request_times_out(self) -> None:
        clock = FakeClock()
        fake = FakeCollect(clock)
        fake.gate = threading.Event()
        reader = DataOutReader(fake, lambda: 2, wait_timeout_s=0.1, clock=clock)
        leader = threading.Thread(target=lambda: reader.snapshot(BASE_URL))
        leader.start()
        self.assertTrue(fake.entered.wait(5))
        with self.assertRaisesRegex(collector.CollectorError, "still in progress"):
            reader.snapshot(BASE_URL)
        fake.gate.set()
        leader.join(5)


# ---------------------------------------------------------------------------
# HTTP: a real console against a loopback fake Data Out


class LoopbackNode:
    """A fake Data Out HTTP server on an ephemeral loopback port."""

    def __init__(self) -> None:
        self.gets: collections.Counter = collections.Counter()
        self.center_freq = 416.588
        self.lock = threading.Lock()
        node = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def do_GET(self) -> None:  # noqa: N802
                now = int(time.time() * 1000)
                bodies = {
                    collector.PATH_STATUS: make_status(now),
                    collector.PATH_SETTINGS: json.dumps({"center_freq": node.center_freq, "pad": "x" * 4500}).encode(),
                    collector.PATH_CSV: make_csv(now),
                    collector.PATH_XML: make_xml(now),
                }
                with node.lock:
                    node.gets[self.path] += 1
                body = bodies.get(self.path)
                if body is None:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def fetcher(self, base_url: str, path: str, timeout: float, max_body: int) -> collector.FetchedResource:
        """Send the console's GET to this server instead of port 8081."""
        started = time.monotonic()
        retrieved_at = collector.now_ms()
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            connection.request("GET", path)
            response = connection.getresponse()
            body = response.read()
            return collector.FetchedResource(
                path, base_url + path, 200 <= response.status < 300, response.status,
                response.getheader("Content-Type"), body, retrieved_at,
                elapsed_ms=int((time.monotonic() - started) * 1000),
            )
        finally:
            connection.close()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)


class SnapshotHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        quiet = patch.object(ground_console.ConsoleHandler, "log_message", lambda *_args: None)
        quiet.start()
        self.addCleanup(quiet.stop)
        self.node = LoopbackNode()
        self.addCleanup(self.node.close)

    def start_console(self, refresh_seconds: int) -> Tuple[ground_console.GroundConsoleServer, int]:
        temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-data-out-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        config_path = root / "console.json"
        server = ground_console.GroundConsoleServer(
            ("127.0.0.1", 0),
            BASE_URL,
            config_path=str(config_path),
            branding_path=str(root / "branding.json"),
            receiver_data_dir=root / "receiver",
            data_out_fetcher=self.node.fetcher,
        )
        config = server.get_config()
        config["refresh_seconds"] = refresh_seconds
        server.update_config(config)
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

    def poll(self, port: int, viewers: int, interval_s: float, duration_s: float) -> None:
        """Viewers poll like the browser: every interval, sending the id they show."""
        errors: List[BaseException] = []

        def viewer(phase: float) -> None:
            seen: Optional[str] = None
            time.sleep(phase)
            end = time.monotonic() + duration_s
            try:
                while time.monotonic() < end:
                    started = time.monotonic()
                    answer = self.get(port, "" if seen is None else "&seen=" + seen)
                    seen = answer["collection"]["id"]
                    time.sleep(max(0.0, interval_s - (time.monotonic() - started)))
            except BaseException as exc:  # pragma: no cover - reported below
                errors.append(exc)

        threads = [threading.Thread(target=viewer, args=(index * interval_s / viewers,)) for index in range(viewers)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(duration_s + 10)
        self.assertEqual(errors, [])

    def test_one_and_five_viewers_read_data_out_equally_often(self) -> None:
        counts = {}
        for viewers in (1, 5):
            _server, port = self.start_console(refresh_seconds=1)
            self.node.gets.clear()
            self.poll(port, viewers, interval_s=1.0, duration_s=3.0)
            counts[viewers] = self.node.gets[collector.PATH_STATUS]
        # Three polls each: one collection per interval whatever the viewers.
        self.assertIn(counts[1], (3, 4), counts)
        self.assertLessEqual(abs(counts[5] - counts[1]), 1, counts)
        # settings.json was read once per console start and then reused.
        self.assertEqual(self.node.gets[collector.PATH_SETTINGS], 1)

    def test_snapshot_query_flags(self) -> None:
        server, port = self.start_console(refresh_seconds=30)
        clock = FakeClock(time.monotonic())
        server.data_out.clock = clock
        first = self.get(port)
        collection = first["collection"]
        for key in ("id", "collected_at_ms", "age_ms", "shared", "settings_reused", "settings_age_ms", "elapsed_ms", "budget_ms",
                    "refresh_seconds", "console_base_url"):
            self.assertIn(key, collection)
        self.assertEqual(collection["refresh_seconds"], 30)
        self.assertEqual(collection["console_base_url"], BASE_URL)
        self.assertEqual((collection["shared"], collection["settings_reused"]), (False, False))
        self.assertIsInstance(first["settings"]["read_at_ms"], int)
        # Inside the window the same collection is shared; a bad seen is ignored.
        clock.advance(5)
        again = self.get(port, "&seen=not-an-id")
        self.assertEqual(again["collection"]["id"], collection["id"])
        self.assertEqual(again["collection"]["age_ms"], 5000)
        self.assertTrue(again["collection"]["shared"])
        self.assertEqual(self.node.gets[collector.PATH_STATUS], 1)
        # Refresh reads again (the last read is older than 1 s) and reuses settings.json.
        refreshed = self.get(port, "&refresh=1")
        self.assertNotEqual(refreshed["collection"]["id"], collection["id"])
        self.assertTrue(refreshed["collection"]["settings_reused"])
        self.assertEqual(self.node.gets[collector.PATH_SETTINGS], 1)
        # Cek ulang reads settings.json at once because that read reused it.
        self.node.center_freq = 433.92
        checked = self.get(port, "&refresh=1&fresh_settings=1")
        self.assertFalse(checked["collection"]["settings_reused"])
        self.assertEqual(checked["settings"]["fields"]["center_freq"], 433.92)
        self.assertEqual(self.node.gets[collector.PATH_SETTINGS], 2)
        # ... and only once a second.
        self.get(port, "&refresh=1&fresh_settings=1")
        self.assertEqual(self.node.gets[collector.PATH_SETTINGS], 2)
        self.assertEqual(self.node.gets[collector.PATH_STATUS], 3)

    def test_a_page_on_the_old_url_learns_the_saved_one(self) -> None:
        # #11/#13 review: a page loaded before another page moved Data Out kept
        # its URL; the answer now names the console's, so the page re-reads
        # its config instead of keeping a second read of the old target.
        server, port = self.start_console(refresh_seconds=2)
        config = server.get_config()
        server.update_config({**config, "base_url": "http://localhost:8081"})
        old = self.get(port)
        self.assertEqual(old["collector"]["base_url"], BASE_URL)
        self.assertEqual(old["collection"]["console_base_url"], "http://localhost:8081")


if __name__ == "__main__":
    unittest.main()
