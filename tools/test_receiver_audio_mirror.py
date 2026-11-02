#!/usr/bin/env python3
"""The Receiver audio mirror: chunk format, memory store, and its routes on both listeners.

POST /api/mirror/receiver/audio comes from the console's own page only, from
the page that publishes the mirror, while the LAN view is open; GET is a
stream of chunks on the loopback listener and the LAN view. The listener
tests reuse the LAN view harness of test_lan_access.py (the LAN view on
127.0.0.1, admitting 127.0.0.1 through the manager's test hook). Nothing
contacts Data Out, a broker or a radio.
"""

from __future__ import annotations

import http.client
import json
import re
import socket
import struct
import sys
import threading
import time
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import lan_access as lan  # noqa: E402
import receiver_audio_mirror as ram  # noqa: E402
import receiver_mirror as rm  # noqa: E402
from test_lan_access import _json, _request, _ServerCase  # noqa: E402
from test_receiver_mirror import SOURCE_ID, _Clock, _publish  # noqa: E402

PROJECT_ROOT = TOOLS_DIR.parent
AUDIO_TS = PROJECT_ROOT / "frontend" / "src" / "lib" / "receiverMirrorAudio.ts"


def _samples(count: int = 3200, value: int = 1000) -> bytes:
    return struct.pack(f"<{count}h", *([value] * count))


def _chunk(seq: int = 1, *, flags: int = 0, samples: Optional[bytes] = None, rate: int = ram.SAMPLE_RATE,
           magic: bytes = ram.MAGIC, version: int = ram.FORMAT_VERSION, reserved: int = 0, length: Optional[int] = None) -> bytes:
    body = _samples() if samples is None else samples
    return struct.pack("<4sBBHIII", magic, version, flags, reserved, seq, rate, len(body) if length is None else length) + body


class ChunkFormatTests(unittest.TestCase):
    def test_a_valid_chunk_parses(self) -> None:
        chunk = ram.parse_chunk(_chunk(7, flags=ram.FLAG_GAP))
        self.assertEqual((chunk.seq, chunk.flags, len(chunk.samples)), (7, ram.FLAG_GAP, 6400))
        self.assertEqual(ram.HEADER_BYTES, 20)

    def test_every_bad_field_is_refused(self) -> None:
        cases = {
            "short": b"SDRA",
            "magic": _chunk(magic=b"RIFF"),
            "version": _chunk(version=2),
            "flags": _chunk(flags=0x02),
            "reserved": _chunk(reserved=1),
            "rate": _chunk(rate=48_000),
            "odd": _chunk(samples=b"\x00" * 1601),
            "too few": _chunk(samples=b"\x00" * 1598),
            "too many": _chunk(samples=b"\x00" * 16_002),
            "length": _chunk(length=6402),
            "trailing": _chunk() + b"\x00\x00",
        }
        for name, raw in cases.items():
            with self.subTest(name=name), self.assertRaises(ValueError):
                ram.parse_chunk(raw)

    def test_the_bounds_are_taken(self) -> None:
        for size in (ram.MIN_SAMPLE_BYTES, ram.MAX_SAMPLE_BYTES):
            with self.subTest(size=size):
                self.assertEqual(len(ram.parse_chunk(_chunk(samples=b"\x00" * size)).samples), size)
        self.assertLessEqual(ram.HEADER_BYTES + ram.MAX_SAMPLE_BYTES, ram.MAX_AUDIO_BODY_BYTES)

    def test_encode_round_trips_and_a_keepalive_has_no_samples(self) -> None:
        self.assertEqual(ram.encode_chunk(3, 0, _samples()), _chunk(3))
        keepalive = ram.encode_chunk(0, 0, b"")
        self.assertEqual(len(keepalive), ram.HEADER_BYTES)
        self.assertEqual(struct.unpack_from("<I", keepalive, 16)[0], 0)
        self.assertEqual(ram.chunk_ms(6400), 200)

    def test_shared_codes_equal_the_mirror_s(self) -> None:
        self.assertEqual(ram.MIRROR_LAN_CLOSED, rm.MIRROR_LAN_CLOSED)
        self.assertEqual(ram.MIRROR_NO_SOURCE, rm.MIRROR_NO_SOURCE)
        self.assertEqual(ram.LAN_CLOSED_MESSAGE, rm.LAN_CLOSED_MESSAGE)
        self.assertEqual(ram.SOURCE_LOST_MS, rm.SOURCE_LOST_MS)
        self.assertEqual(rm.ERROR_CODES_HTTP[ram.MIRROR_AUDIO_BUSY], 429)


class AudioStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = _Clock()
        self.mirror = rm.ReceiverMirror(self.clock)
        self.audio = self.mirror.audio
        self.mirror.open()

    def publish_state(self, source_id: str = SOURCE_ID) -> Dict[str, Any]:
        return self.mirror.publish(*rm.parse_publish(_publish(1, source_id=source_id)))

    def test_nothing_is_taken_without_the_mirror_s_source(self) -> None:
        with self.assertRaises(ram.AudioRejected) as caught:
            self.audio.publish(SOURCE_ID, ram.parse_chunk(_chunk()))
        self.assertEqual(caught.exception.code, ram.MIRROR_NO_SOURCE)
        self.publish_state()
        with self.assertRaises(ram.AudioRejected) as caught:
            self.audio.publish("kiosk-another-01", ram.parse_chunk(_chunk()))
        self.assertEqual(caught.exception.code, ram.MIRROR_NO_SOURCE)
        self.assertEqual(self.audio.publish(SOURCE_ID, ram.parse_chunk(_chunk())), 0)
        # A source that has not posted for SOURCE_LOST_MS is lost.
        self.clock.now += ram.SOURCE_LOST_MS / 1000 + 0.01
        with self.assertRaises(ram.AudioRejected) as caught:
            self.audio.publish(SOURCE_ID, ram.parse_chunk(_chunk()))
        self.assertEqual(caught.exception.code, ram.MIRROR_NO_SOURCE)

    def test_the_rate_is_at_most_ten_a_second(self) -> None:
        self.assertTrue(all(self.audio.admit() for _ in range(ram.MAX_CHUNKS_PER_S)))
        self.assertFalse(self.audio.admit())
        self.clock.now += ram.RATE_WINDOW_S
        self.assertTrue(self.audio.admit())

    def test_a_listener_gets_the_newest_chunk_then_every_new_one(self) -> None:
        self.publish_state()
        self.audio.publish(SOURCE_ID, ram.parse_chunk(_chunk(1)))
        self.audio.publish(SOURCE_ID, ram.parse_chunk(_chunk(2)))
        listener = self.audio.attach("192.0.2.10")
        self.assertEqual(self.mirror.publish(*rm.parse_publish(_publish(2)))["audio_listeners"], 1)
        self.assertEqual(self.audio.next_chunk(listener, 0), _chunk(2))
        self.assertEqual(self.audio.publish(SOURCE_ID, ram.parse_chunk(_chunk(3))), 1)
        self.assertEqual(self.audio.next_chunk(listener, 0), _chunk(3))
        # Nothing new: a keepalive.
        self.assertEqual(self.audio.next_chunk(listener, 0), ram.encode_chunk(0, 0, b""))
        self.assertEqual(self.mirror.view()["audio"]["listeners"], 1)
        self.assertEqual(self.mirror.view()["audio"]["chunk_ms"], 200)

    def test_an_old_chunk_is_not_where_a_listener_starts(self) -> None:
        self.publish_state()
        self.audio.publish(SOURCE_ID, ram.parse_chunk(_chunk(1)))
        self.clock.now += ram.START_CHUNK_MAX_AGE_MS / 1000 + 0.01
        listener = self.audio.attach("192.0.2.10")
        self.assertEqual(self.audio.next_chunk(listener, 0), ram.encode_chunk(0, 0, b""))

    def test_a_slow_listener_loses_its_oldest_chunks_and_sees_a_gap(self) -> None:
        self.publish_state()
        listener = self.audio.attach("192.0.2.10")
        for seq in range(1, ram.MAX_QUEUED_CHUNKS + 3):
            self.audio.publish(SOURCE_ID, ram.parse_chunk(_chunk(seq)))
        first = self.audio.next_chunk(listener, 0)
        assert first is not None
        self.assertEqual(struct.unpack_from("<I", first, 8)[0], 3)
        self.assertEqual(first[5] & ram.FLAG_GAP, ram.FLAG_GAP)
        second = self.audio.next_chunk(listener, 0)
        assert second is not None
        self.assertEqual(second[5] & ram.FLAG_GAP, 0)

    def test_at_most_four_listeners_and_one_per_client(self) -> None:
        self.publish_state()
        listeners = [self.audio.attach(f"192.0.2.{n}") for n in range(1, ram.MAX_LISTENERS + 1)]
        with self.assertRaises(ram.AudioRejected) as caught:
            self.audio.attach("192.0.2.99")
        self.assertEqual(caught.exception.code, ram.MIRROR_AUDIO_BUSY)
        # The same client again replaces its own stream, never another's.
        again = self.audio.attach("192.0.2.1")
        self.assertIsNone(self.audio.next_chunk(listeners[0], 0))
        self.assertIsNotNone(self.audio.next_chunk(again, 0))
        self.assertEqual(self.audio.listener_count(), ram.MAX_LISTENERS)
        self.audio.detach(listeners[1])
        self.audio.attach("192.0.2.99")
        self.assertEqual(self.audio.listener_count(), ram.MAX_LISTENERS)

    def test_closing_the_mirror_ends_every_stream_and_forgets_the_audio(self) -> None:
        self.publish_state()
        self.audio.publish(SOURCE_ID, ram.parse_chunk(_chunk(1)))
        listener = self.audio.attach("192.0.2.10")
        self.mirror.close()
        self.assertIsNone(self.audio.next_chunk(listener, 0))
        self.assertEqual(self.mirror.view()["audio"], {
            "listeners": 0, "max_listeners": ram.MAX_LISTENERS, "age_ms": None, "sample_rate": ram.SAMPLE_RATE, "chunk_ms": 200,
        })
        with self.assertRaises(ram.AudioRejected) as caught:
            self.audio.attach("192.0.2.10")
        self.assertEqual(caught.exception.code, ram.MIRROR_LAN_CLOSED)
        with self.assertRaises(ram.AudioRejected) as caught:
            self.audio.publish(SOURCE_ID, ram.parse_chunk(_chunk(2)))
        self.assertEqual(caught.exception.code, ram.MIRROR_LAN_CLOSED)

    def test_a_lost_source_ends_the_stream_and_another_page_starts_afresh(self) -> None:
        self.publish_state()
        self.audio.publish(SOURCE_ID, ram.parse_chunk(_chunk(1)))
        listener = self.audio.attach("192.0.2.10")
        self.publish_state("kiosk-another-01")
        # The previous page's audio is gone; the next chunk is marked as a gap.
        self.audio.publish("kiosk-another-01", ram.parse_chunk(_chunk(1)))
        chunk = self.audio.next_chunk(listener, 0)
        assert chunk is not None
        self.assertEqual(chunk[5] & ram.FLAG_GAP, ram.FLAG_GAP)
        self.clock.now += ram.SOURCE_LOST_MS / 1000 + 0.01
        self.assertIsNone(self.audio.next_chunk(listener, 0))
        with self.assertRaises(ram.AudioRejected) as caught:
            self.audio.attach("192.0.2.11")
        self.assertEqual(caught.exception.code, ram.MIRROR_NO_SOURCE)

    def test_a_waiting_listener_wakes_for_a_chunk(self) -> None:
        mirror = rm.ReceiverMirror()
        mirror.open()
        mirror.publish(*rm.parse_publish(_publish(1)))
        listener = mirror.audio.attach("192.0.2.10")
        got: List[Optional[bytes]] = []
        thread = threading.Thread(target=lambda: got.append(mirror.audio.next_chunk(listener, 5.0)))
        thread.start()
        time.sleep(0.05)
        mirror.audio.publish(SOURCE_ID, ram.parse_chunk(_chunk(4)))
        thread.join(2)
        self.assertEqual(got, [_chunk(4)])


class _Stream:
    """An open audio stream read a chunk at a time."""

    def __init__(self, port: int, headers: Optional[List[Tuple[str, str]]] = None) -> None:
        self.connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        self.connection.putrequest("GET", ram.AUDIO_ROUTE, skip_host=True, skip_accept_encoding=True)
        self.connection.putheader("Host", f"127.0.0.1:{port}")
        for name, value in headers or ():
            self.connection.putheader(name, value)
        self.connection.endheaders()
        self.response = self.connection.getresponse()

    def chunk(self) -> Tuple[int, int, bytes]:
        """(seq, flags, samples) of the next chunk; raises when the stream ended."""
        header = self.response.read(ram.HEADER_BYTES)
        if len(header) != ram.HEADER_BYTES:
            raise EOFError("the stream ended")
        magic, _version, flags, _reserved, seq, _rate, length = struct.unpack("<4sBBHIII", header)
        assert magic == ram.MAGIC
        return seq, flags, self.response.read(length)

    def audio_chunk(self) -> Tuple[int, int, bytes]:
        """The next chunk with samples, skipping keepalives."""
        while True:
            seq, flags, samples = self.chunk()
            if samples:
                return seq, flags, samples

    def close(self) -> None:
        self.connection.close()


class AudioRouteTests(_ServerCase):
    def setUp(self) -> None:
        super().setUp()
        self.server = self.start_server()
        self.main_port = self.server.server_address[1]

    def post_state(self, source_id: str = SOURCE_ID) -> Dict[str, Any]:
        headers = [("Content-Type", "application/json"), ("Origin", f"http://127.0.0.1:{self.main_port}")]
        status, _headers, answer = _request(self.main_port, "POST", rm.ROUTE, headers, json.dumps(_publish(1, source_id=source_id)).encode())
        self.assertEqual(status, 200)
        return _json(answer)

    def post_chunk(self, raw: bytes, *, source: Optional[str] = SOURCE_ID, origin: Optional[str] = "default",
                   port: Optional[int] = None) -> Tuple[int, Dict[str, Any]]:
        target = self.main_port if port is None else port
        headers = [("Content-Type", "application/octet-stream")]
        if origin == "default":
            headers.append(("Origin", f"http://127.0.0.1:{target}"))
        elif origin is not None:
            headers.append(("Origin", origin))
        path = ram.AUDIO_ROUTE + ("" if source is None else f"?source={source}")
        status, _headers, answer = _request(target, "POST", path, headers, raw)
        return status, _json(answer)

    def stream(self, port: int, headers: Optional[List[Tuple[str, str]]] = None) -> _Stream:
        stream = _Stream(port, headers)
        self.addCleanup(stream.close)
        return stream

    def assert_code(self, result: Tuple[int, Dict[str, Any]], status: int, code: str) -> None:
        self.assertEqual(result[0], status, result[1])
        self.assertEqual((result[1]["ok"], result[1]["code"]), (False, code))

    def wait_listeners(self, count: int) -> None:
        deadline = time.monotonic() + 3
        while self.server.receiver_mirror.audio.listener_count() != count:
            self.assertLess(time.monotonic(), deadline, "listener count")
            time.sleep(0.01)

    def test_a_tablet_hears_what_the_page_posts(self) -> None:
        lan_port = self.open_lan(self.server)
        self.assertEqual(self.post_state()["audio_listeners"], 0)
        stream = self.stream(lan_port)
        self.assertEqual(stream.response.status, 200)
        self.assertEqual(stream.response.getheader("Content-Type"), "application/octet-stream")
        self.assertEqual(stream.response.getheader("Cache-Control"), "no-store")
        self.assertIsNone(stream.response.getheader("Content-Length"))
        self.wait_listeners(1)
        # The page learns that somebody listens from its next mirror POST.
        self.assertEqual(self.post_state()["audio_listeners"], 1)
        self.assertEqual(self.post_chunk(_chunk(5, samples=_samples(3200, 42))), (200, {"ok": True, "listeners": 1}))
        self.assertEqual(stream.audio_chunk(), (5, 0, _samples(3200, 42)))
        status, view = _json_get(lan_port, rm.ROUTE)
        self.assertEqual(status, 200)
        self.assertEqual(view["audio"]["listeners"], 1)
        self.assertEqual(view["audio"]["sample_rate"], 16_000)
        self.assertIn(f'"GET {ram.AUDIO_ROUTE} HTTP/1.1" 200', self.output.getvalue())

    def test_a_stream_ends_when_the_lan_view_closes(self) -> None:
        self.open_lan(self.server)
        self.post_state()
        loopback = self.stream(self.main_port)
        self.assertEqual(loopback.response.status, 200)
        self.wait_listeners(1)
        self.server.lan.close()
        with self.assertRaises(EOFError):
            while True:
                loopback.chunk()
        self.wait_listeners(0)
        self.assertIn("audio stream closed after", self.output.getvalue())

    def test_a_keepalive_comes_without_audio(self) -> None:
        self.open_lan(self.server)
        self.post_state()
        stream = self.stream(self.main_port)
        self.assertEqual(stream.chunk(), (0, 0, b""))

    def test_the_same_client_replaces_its_stream(self) -> None:
        lan_port = self.open_lan(self.server)
        self.post_state()
        first = self.stream(lan_port)
        self.wait_listeners(1)
        second = self.stream(lan_port)
        self.assertEqual(second.response.status, 200)
        with self.assertRaises(EOFError):
            while True:
                first.chunk()
        self.wait_listeners(1)

    def test_a_fifth_listener_gets_429_with_retry_after(self) -> None:
        lan_port = self.open_lan(self.server)
        self.post_state()
        audio = self.server.receiver_mirror.audio
        for n in range(ram.MAX_LISTENERS):
            audio.attach(f"192.0.2.{n}")
        status, headers, answer = _request(lan_port, "GET", ram.AUDIO_ROUTE)
        self.assertEqual((status, _json(answer)["code"]), (429, ram.MIRROR_AUDIO_BUSY))
        self.assertEqual(headers["retry-after"], str(ram.AUDIO_BUSY_RETRY_AFTER_S))

    def test_no_stream_without_a_source_or_an_open_lan_view(self) -> None:
        status, _headers, answer = _request(self.main_port, "GET", ram.AUDIO_ROUTE)
        self.assertEqual((status, _json(answer)["code"]), (409, rm.MIRROR_LAN_CLOSED))
        lan_port = self.open_lan(self.server)
        status, _headers, answer = _request(lan_port, "GET", ram.AUDIO_ROUTE)
        self.assertEqual((status, _json(answer)["code"]), (409, rm.MIRROR_NO_SOURCE))

    def test_the_read_rules(self) -> None:
        lan_port = self.open_lan(self.server)
        self.post_state()
        # The LAN view: like Records, a same-site page (another port of this host) is refused too.
        for site in ("same-site", "cross-site"):
            with self.subTest(site=site):
                status, _headers, answer = _request(lan_port, "GET", ram.AUDIO_ROUTE, [("Sec-Fetch-Site", site)])
                self.assertEqual((status, _json(answer)["code"]), (403, rm.ORIGIN_REJECTED))
        status, _headers, answer = _request(lan_port, "GET", ram.AUDIO_ROUTE, host="evil.example")
        self.assertEqual(status, 403)
        # The loopback listener: the Receiver's read rule.
        for host in ("evil.example", f"127.0.0.1:{lan_port}"):
            with self.subTest(host=host):
                status, _headers, answer = _request(self.main_port, "GET", ram.AUDIO_ROUTE, host=host)
                self.assertEqual((status, _json(answer)["code"]), (403, rm.ORIGIN_REJECTED))
        status, _headers, answer = _request(self.main_port, "GET", ram.AUDIO_ROUTE, [("Sec-Fetch-Site", "same-site")])
        self.assertEqual(status, 403)
        # HEAD is a bare 405 on the LAN view (do_HEAD drops the body).
        status, headers, body = _request(lan_port, "HEAD", ram.AUDIO_ROUTE)
        self.assertEqual((status, body, headers["allow"]), (405, b"", "GET"))
        self.assertEqual(self.server.receiver_mirror.audio.listener_count(), 0)

    def test_only_the_console_s_own_page_posts_and_never_from_the_lan(self) -> None:
        lan_port = self.open_lan(self.server)
        self.post_state()
        for origin in (None, "http://127.0.0.1:1", "http://192.168.1.20"):
            with self.subTest(origin=origin):
                self.assert_code(self.post_chunk(_chunk(), origin=origin), 403, rm.ORIGIN_REJECTED)
        status, answer = self.post_chunk(_chunk(), port=lan_port)
        self.assertEqual((status, answer["code"]), (405, lan.LAN_READ_ONLY))

    def test_post_checks_in_order(self) -> None:
        self.assert_code(self.post_chunk(_chunk()), 409, rm.MIRROR_LAN_CLOSED)
        self.open_lan(self.server)
        self.assert_code(self.post_chunk(_chunk()), 409, rm.MIRROR_NO_SOURCE)
        self.post_state()
        self.assert_code(self.post_chunk(b"\x00" * (ram.MAX_AUDIO_BODY_BYTES + 1)), 413, rm.MIRROR_TOO_LARGE)
        self.assert_code(self.post_chunk(_chunk(rate=8000)), 400, rm.MIRROR_INVALID)
        for source in (None, "bad%20id", "short"):
            with self.subTest(source=source):
                self.assert_code(self.post_chunk(_chunk(), source=source), 400, rm.MIRROR_INVALID)
        self.assert_code(self.post_chunk(_chunk(), source="kiosk-another-01"), 409, rm.MIRROR_NO_SOURCE)
        self.assertEqual(self.post_chunk(_chunk())[0], 200)

    def test_the_rate_and_quiet_log(self) -> None:
        self.open_lan(self.server)
        self.post_state()
        answers = [self.post_chunk(_chunk(n))[0] for n in range(ram.MAX_CHUNKS_PER_S + 2)]
        self.assertIn(429, answers)
        self.assertEqual(answers.count(200) + answers.count(429), len(answers))
        log = self.output.getvalue()
        self.assertNotIn(f'"POST {ram.AUDIO_ROUTE}', log)


def _json_get(port: int, path: str) -> Tuple[int, Dict[str, Any]]:
    status, _headers, answer = _request(port, "GET", path)
    return status, _json(answer)


class AudioContractTests(unittest.TestCase):
    """The browser's copy names the same route, format and limits."""

    def test_the_browser_copy_matches(self) -> None:
        text = AUDIO_TS.read_text(encoding="utf-8")
        self.assertIn(f"export const MIRROR_AUDIO_ROUTE = '{ram.AUDIO_ROUTE}';", text)
        expected = {
            "headerBytes": ram.HEADER_BYTES,
            "sampleRate": ram.SAMPLE_RATE,
            "minSampleBytes": ram.MIN_SAMPLE_BYTES,
            "maxSampleBytes": ram.MAX_SAMPLE_BYTES,
            "maxBodyBytes": ram.MAX_AUDIO_BODY_BYTES,
            "maxChunksPerS": ram.MAX_CHUNKS_PER_S,
            "maxListeners": ram.MAX_LISTENERS,
            "keepaliveMs": ram.KEEPALIVE_MS,
            "formatVersion": ram.FORMAT_VERSION,
            "flagGap": ram.FLAG_GAP,
        }
        block = re.search(r"export const MIRROR_AUDIO_LIMITS = \{([^}]*)\}", text)
        assert block is not None, "MIRROR_AUDIO_LIMITS not found"
        found = {name: int(value.replace("_", ""), 0) for name, value in re.findall(r"(\w+): ([0-9_x]+)", block.group(1))}
        self.assertEqual(found, expected)
        self.assertIn(f"export const MIRROR_AUDIO_MAGIC = '{ram.MAGIC.decode()}';", text)

    def test_the_lan_view_lists_the_route_for_get_only(self) -> None:
        self.assertEqual(lan.lan_route(ram.AUDIO_ROUTE), ram.AUDIO_ROUTE)
        self.assertFalse(lan.write_allowed("POST", ram.AUDIO_ROUTE))


if __name__ == "__main__":
    unittest.main()
