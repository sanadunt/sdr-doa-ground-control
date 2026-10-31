#!/usr/bin/env python3
"""The Receiver mirror: schema, memory store, and its routes on both listeners.

POST /api/mirror/receiver comes from the console's own page only, while the
LAN view is open; GET answers on the loopback listener and the LAN view. The
listener tests reuse the LAN view harness of test_lan_access.py, which binds
the LAN view on 127.0.0.1 and admits 127.0.0.1 through the manager's test
hook. Nothing contacts Data Out, a broker, a tile provider or a radio.
"""

from __future__ import annotations

import base64
import contextlib
import copy
import io
import json
import os
import re
import sys
import unittest
from pathlib import Path
from unittest import mock
from typing import Any, Dict, List, Optional, Tuple

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import lan_access as lan  # noqa: E402
import receiver_mirror as rm  # noqa: E402
from test_lan_access import NOBODY, PASSWORD, _json, _request, _ServerCase  # noqa: E402

SOURCE_ID = "kiosk-test-0001"
PROJECT_ROOT = TOOLS_DIR.parent
# One publish body both sides check: this file parses it, and the browser's
# Vitest (lib/receiverMirror.test.ts) reads it and builds the same shape.
FIXTURE = TOOLS_DIR / "fixtures" / "receiver-mirror" / "publish.json"
MIRROR_TS = PROJECT_ROOT / "frontend" / "src" / "lib" / "receiverMirror.ts"


def _bins(count: int, value: int = 128) -> str:
    return base64.b64encode(bytes([value]) * count).decode("ascii")


def _frame(seq: int = 1, count: int = 512) -> Dict[str, Any]:
    return {
        "seq": seq,
        "t_ms": 1_761_000_000_000 + seq,
        "kind": "rx",
        "center_hz": 433_920_000,
        "start_hz": 432_920_000,
        "stop_hz": 434_920_000,
        "bin_count": count,
        "db_min": -120,
        "db_max": -20.5,
        "bins": _bins(count),
    }


def _state(rev: int = 1) -> Dict[str, Any]:
    return {
        "rev": rev,
        "t_ms": 1_761_000_000_000,
        "connected": True,
        "running": True,
        "recording": False,
        "mock": False,
        "busy": "none",
        "center_hz": 433_920_000,
        "sample_rate_hz": 10_000_000,
        "span_hz": 2_000_000,
        "frequency_shift_hz": 0,
        "gains": {"lna_db": 16, "vga_db": 20, "amp": False},
        "vfo": {
            "index": 0,
            "enabled": True,
            "mode": "nfm",
            "frequency_hz": 433_925_000,
            "bandwidth_hz": 12_500,
            "squelch_enabled": False,
            "squelch_db": -60.5,
        },
        "scan": {
            "phase": "idle",
            "start_hz": 400_000_000,
            "stop_hz": 500_000_000,
            "resolution_hz": 4882.8125,
            "gains": {"lna_db": 24, "vga_db": 30, "amp": True},
        },
        "error": None,
    }


def _publish(seq: int = 1, *, frame: bool = True, source_id: str = SOURCE_ID) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "v": 1,
        "source": {"id": source_id, "kind": "kiosk-tab", "visible": True},
        "state": _state(seq),
    }
    if frame:
        body["frame"] = _frame(seq)
    return body


def _beyond_a_float() -> bytes:
    """A publish body whose lna_db is an integer too large for a float (a 401-digit JSON integer)."""
    body = json.dumps(_publish()).encode("utf-8")
    assert body.count(b'"lna_db": 16') == 1
    return body.replace(b'"lna_db": 16', b'"lna_db": 1' + b"0" * 400)


# Bodies within the size limit that once escaped the schema check as an
# exception other than MirrorRejected: an integer beyond a float in a float
# field (OverflowError) and a nesting deeper than the JSON decoder's
# recursion limit (RecursionError on Python 3.9 to 3.11).
BODIES_BEYOND_THE_DECODER = (_beyond_a_float(), b"[" * 5000)


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class MirrorSchemaTests(unittest.TestCase):
    def test_a_full_publish_parses_unchanged(self) -> None:
        body = _publish()
        source, state, frame = rm.parse_publish(copy.deepcopy(body))[:3]
        self.assertEqual(source, body["source"])
        self.assertEqual(state, body["state"])
        self.assertEqual(frame, body["frame"])

    def test_the_frame_is_optional_and_may_be_null(self) -> None:
        self.assertIsNone(rm.parse_publish(_publish(frame=False))[2])
        self.assertIsNone(rm.parse_publish({**_publish(frame=False), "frame": None})[2])

    def test_nullable_state_parts(self) -> None:
        body = _publish(frame=False)
        body["state"].update({
            "center_hz": None, "sample_rate_hz": None, "span_hz": None, "vfo": None, "scan": None, "error": "USB_LOST",
            "gains": {"lna_db": None, "vga_db": None, "amp": True},
        })
        state = rm.parse_publish(body)[1]
        self.assertIsNone(state["vfo"])
        self.assertEqual(state["error"], "USB_LOST")
        # A shift moves displayed frequencies below zero on a downconverter.
        body["state"]["frequency_shift_hz"] = -9_750_000_000
        self.assertEqual(rm.parse_publish(body)[1]["frequency_shift_hz"], -9_750_000_000)
        # The minimum frame, a scan frame.
        frame = {**_frame(count=16), "kind": "sweep", "db_min": -200, "db_max": -199}
        self.assertEqual(rm.parse_publish({**body, "frame": frame})[2]["bin_count"], 16)

    def test_the_scan_carries_its_own_gains(self) -> None:
        body = _publish(frame=False)
        state = rm.parse_publish(copy.deepcopy(body))[1]
        self.assertEqual(state["scan"]["gains"], {"lna_db": 24, "vga_db": 30, "amp": True})
        self.assertEqual(state["gains"], {"lna_db": 16, "vga_db": 20, "amp": False})
        body["state"]["scan"]["gains"] = {"lna_db": None, "vga_db": None, "amp": False}
        self.assertEqual(rm.parse_publish(copy.deepcopy(body))[1]["scan"]["gains"], {"lna_db": None, "vga_db": None, "amp": False})
        # A groundstation page loaded before the scan's gains were mirrored still
        # publishes; its scan reads as gains unknown (null), never the RX gains.
        for older in (None, "absent"):
            with self.subTest(older=older):
                if older == "absent":
                    del body["state"]["scan"]["gains"]
                else:
                    body["state"]["scan"]["gains"] = None
                self.assertIsNone(rm.parse_publish(copy.deepcopy(body))[1]["scan"]["gains"])

    def test_every_bad_field_is_refused_whole(self) -> None:
        def mutate(path: Tuple[Any, ...], value: Any, *, delete: bool = False) -> Dict[str, Any]:
            body = _publish()
            target: Any = body
            for key in path[:-1]:
                target = target[key]
            if delete:
                del target[path[-1]]
            else:
                target[path[-1]] = value
            return body

        cases: List[Tuple[str, Dict[str, Any]]] = [
            ("unknown top field", {**_publish(), "audio": True}),
            ("version 2", mutate(("v",), 2)),
            ("version true", mutate(("v",), True)),
            ("no state", mutate(("state",), None, delete=True)),
            ("no source", mutate(("source",), None, delete=True)),
            ("short source id", mutate(("source", "id"), "k1")),
            ("source id with a space", mutate(("source", "id"), "kiosk tab 1")),
            ("unknown source kind", mutate(("source", "kind"), "tablet")),
            ("visible as a number", mutate(("source", "visible"), 1)),
            ("unknown state field", mutate(("state", "audio"), "on")),
            ("rev as a boolean", mutate(("state", "rev"), True)),
            ("rev as a fraction", mutate(("state", "rev"), 1.5)),
            ("rev below zero", mutate(("state", "rev"), -1)),
            ("centre as text", mutate(("state", "center_hz"), "433920000")),
            ("centre beyond 100 GHz", mutate(("state", "center_hz"), 100_000_000_001)),
            ("sample rate zero", mutate(("state", "sample_rate_hz"), 0)),
            ("unknown busy", mutate(("state", "busy"), "listen")),
            ("unknown error code", mutate(("state", "error"), "BOOM")),
            ("gain above the limit", mutate(("state", "gains", "lna_db"), 500)),
            ("extra gain field", mutate(("state", "gains", "if_db"), 10)),
            ("vfo index 64", mutate(("state", "vfo", "index"), 64)),
            ("unknown mode", mutate(("state", "vfo", "mode"), "fm")),
            ("vfo field missing", mutate(("state", "vfo", "squelch_db"), None, delete=True)),
            ("scan reversed", mutate(("state", "scan", "stop_hz"), 300_000_000)),
            ("unknown scan phase", mutate(("state", "scan", "phase"), "done")),
            ("scan gain above the limit", mutate(("state", "scan", "gains", "lna_db"), 500)),
            ("scan VGA below zero", mutate(("state", "scan", "gains", "vga_db"), -2)),
            ("scan amp as a number", mutate(("state", "scan", "gains", "amp"), 1)),
            ("extra scan gain field", mutate(("state", "scan", "gains", "if_db"), 10)),
            ("scan gain field missing", mutate(("state", "scan", "gains", "amp"), None, delete=True)),
            ("scan gains as a list", mutate(("state", "scan", "gains"), [24, 30, True])),
            ("unknown frame kind", mutate(("frame", "kind"), "audio")),
            ("frame reversed", mutate(("frame", "stop_hz"), 432_000_000)),
            ("centre outside the frame", mutate(("frame", "center_hz"), 500_000_000)),
            ("513 bins", mutate(("frame", "bin_count"), 513)),
            ("15 bins", mutate(("frame", "bin_count"), 15)),
            ("bins shorter than the count", mutate(("frame", "bins"), _bins(511))),
            ("bins not base64", mutate(("frame", "bins"), "!" * 684)),
            ("bins as a list", mutate(("frame", "bins"), [1, 2, 3])),
            ("dB span below 1 dB", mutate(("frame", "db_max"), -119.5)),
            ("dB below the floor", mutate(("frame", "db_min"), -201)),
            ("frame field missing", mutate(("frame", "db_max"), None, delete=True)),
            ("body as a list", [_publish()]),  # type: ignore[list-item]
            # Integers beyond a float: refused as out of range, never an OverflowError.
            ("gain beyond a float", mutate(("state", "gains", "lna_db"), 10 ** 400)),
            ("VGA beyond a float", mutate(("state", "gains", "vga_db"), 10 ** 400)),
            ("squelch beyond a float", mutate(("state", "vfo", "squelch_db"), -(10 ** 400))),
            ("resolution beyond a float", mutate(("state", "scan", "resolution_hz"), 10 ** 400)),
            ("scan gain beyond a float", mutate(("state", "scan", "gains", "lna_db"), 10 ** 400)),
            ("dB floor beyond a float", mutate(("frame", "db_min"), -(10 ** 400))),
            ("dB ceiling beyond a float", mutate(("frame", "db_max"), 10 ** 400)),
            ("centre beyond a float", mutate(("state", "center_hz"), 10 ** 400)),
        ]
        for name, body in cases:
            with self.subTest(name), self.assertRaises(rm.MirrorRejected) as caught:
                rm.parse_publish(body)
            self.assertEqual(caught.exception.code, rm.MIRROR_INVALID)
            self.assertEqual(caught.exception.status, 400)

    def test_raw_bodies(self) -> None:
        good = json.dumps(_publish()).encode("utf-8")
        self.assertEqual(rm.decode_publish(good)[0]["id"], SOURCE_ID)
        for raw in (b"\xff\xfe", b"{", b"[]", good.replace(b'"db_max": -20.5', b'"db_max": NaN'),
                    good.replace(b'"db_max": -20.5', b'"db_max": Infinity'), *BODIES_BEYOND_THE_DECODER):
            with self.subTest(raw=raw[:20]), self.assertRaises(rm.MirrorRejected) as caught:
                rm.decode_publish(raw)
            self.assertEqual(caught.exception.code, rm.MIRROR_INVALID)
        # Python 3.12 and later decode the deep body to a ValueError; the
        # RecursionError of 3.9 to 3.11 is refused the same way.
        with mock.patch.object(rm.json, "loads", side_effect=RecursionError("maximum recursion depth exceeded")):
            with self.assertRaises(rm.MirrorRejected) as caught:
                rm.decode_publish(good)
        self.assertEqual(caught.exception.code, rm.MIRROR_INVALID)
        with self.assertRaises(rm.MirrorRejected) as caught:
            rm.decode_publish(good + b" " * rm.MAX_BODY_BYTES)
        self.assertEqual((caught.exception.code, caught.exception.status), (rm.MIRROR_TOO_LARGE, 413))

    def test_a_full_publish_fits_the_body_limit(self) -> None:
        body = json.dumps(_publish(), separators=(",", ":")).encode("utf-8")
        self.assertLess(len(body), rm.MAX_BODY_BYTES // 2)


def _ts_number(text: str) -> float:
    """A TypeScript numeric literal or a product of them (8 * 1024)."""
    value = 1.0
    for factor in text.replace("_", "").split("*"):
        value *= float(factor.strip())
    return value


class MirrorContractTests(unittest.TestCase):
    """The browser's copy (frontend/src/lib/receiverMirror.ts) and the shared fixture."""

    def test_the_shared_fixture_parses_unchanged(self) -> None:
        body = json.loads(FIXTURE.read_text(encoding="utf-8"))
        post = rm.parse_publish(copy.deepcopy(body))
        self.assertEqual(
            (post.source, post.state, post.frame, post.markers, list(post.results)),
            (body["source"], body["state"], body["frame"], body["markers"], body["results"]),
        )
        self.assertLess(len(json.dumps(body, separators=(",", ":"))), rm.MAX_BODY_BYTES)

    def test_the_browser_limits_match(self) -> None:
        text = MIRROR_TS.read_text(encoding="utf-8")
        block = re.search(r"export const MIRROR_LIMITS = \{(.*?)\} as const;", text, re.S)
        assert block is not None, "MIRROR_LIMITS not found"
        values = {name: _ts_number(number) for name, number in re.findall(r"(\w+): ([-0-9_ *.]+),", block.group(1))}
        self.assertEqual(values, {
            "minBins": rm.MIN_BINS,
            "maxBins": rm.MAX_BINS,
            "maxBodyBytes": rm.MAX_BODY_BYTES,
            "maxPostsPerS": rm.MAX_POSTS_PER_S,
            "frameStaleMs": rm.FRAME_STALE_MS,
            "sourceLostMs": rm.SOURCE_LOST_MS,
            "heartbeatMs": rm.HEARTBEAT_MS,
            "dbFloor": rm.DB_FLOOR,
            "dbCeiling": rm.DB_CEILING,
            "minDbSpan": rm.MIN_DB_SPAN,
            "maxAbsFrequencyHz": rm.MAX_ABS_FREQUENCY_HZ,
            "maxSampleRateHz": rm.MAX_SAMPLE_RATE_HZ,
            "maxMarkers": rm.MAX_MARKERS,
            "maxMarkerLabelChars": rm.MAX_MARKER_LABEL_CHARS,
            "maxMarkerBodyBytes": rm.MAX_MARKER_BODY_BYTES,
            "markerCommandsPerS": rm.MARKER_COMMANDS_PER_S,
            "maxPendingMarkerCommands": rm.MAX_PENDING_MARKER_COMMANDS,
            "markerCommandTtlMs": rm.MARKER_COMMAND_TTL_MS,
        })
        self.assertIn(f"export const MIRROR_ROUTE = '{rm.ROUTE}';", text)
        self.assertIn(f"export const MIRROR_VERSION = {rm.VERSION};", text)
        kinds = re.search(r"export const MIRROR_SOURCE_KINDS = \[([^\]]*)\]", text)
        assert kinds is not None
        self.assertEqual(set(re.findall(r"'([a-z-]+)'", kinds.group(1))), set(rm.SOURCE_KINDS))
        # The publisher's pace stays under the server's rate limit.
        interval = re.search(r"export const MIRROR_POST_INTERVAL_MS = (\d+);", text)
        assert interval is not None
        self.assertLessEqual(1000 / int(interval.group(1)), rm.MAX_POSTS_PER_S)


class MirrorStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = _Clock()
        self.mirror = rm.ReceiverMirror(clock=self.clock)
        self.mirror.open()

    def test_at_most_twelve_posts_in_any_second(self) -> None:
        self.assertEqual([self.mirror.admit() for _ in range(rm.MAX_POSTS_PER_S)], [True] * rm.MAX_POSTS_PER_S)
        self.assertFalse(self.mirror.admit())
        self.clock.now += 0.5
        self.assertFalse(self.mirror.admit())
        self.assertEqual(self.mirror.refused, 2)
        # Refused posts do not count: one second after the first, a slot is free again.
        self.clock.now += 0.5
        self.assertEqual([self.mirror.admit() for _ in range(rm.MAX_POSTS_PER_S)], [True] * rm.MAX_POSTS_PER_S)
        self.assertFalse(self.mirror.admit())

    def test_nothing_before_the_first_post(self) -> None:
        view = self.mirror.view()
        self.assertEqual(
            {key: view[key] for key in ("ok", "v", "rev", "frame_rev", "source", "state", "frame", "source_age_ms", "state_age_ms", "frame_age_ms")},
            {"ok": True, "v": 1, "rev": 0, "frame_rev": 0, "source": None, "state": None, "frame": None,
             "source_age_ms": None, "state_age_ms": None, "frame_age_ms": None},
        )
        self.assertEqual(view["limits"], {
            "frame_stale_ms": 3000, "source_lost_ms": 10000, "heartbeat_ms": 500,
            "max_bins": 512, "max_body_bytes": 8192, "max_posts_per_s": 12,
        })

    def test_latest_wins_and_ages_follow_the_server_clock(self) -> None:
        self.assertEqual(self.mirror.publish(*rm.parse_publish(_publish(1))), {"rev": 1, "frame_rev": 1, "commands": []})
        self.clock.now += 1.25
        # A state-only post (a heartbeat) keeps the frame and its age.
        self.assertEqual(self.mirror.publish(*rm.parse_publish(_publish(2, frame=False))), {"rev": 2, "frame_rev": 1, "commands": []})
        self.clock.now += 0.5
        view = self.mirror.view()
        self.assertEqual(view["state"]["rev"], 2)
        self.assertEqual(view["frame"]["seq"], 1)
        self.assertEqual((view["source_age_ms"], view["state_age_ms"], view["frame_age_ms"]), (500, 500, 1750))
        self.mirror.publish(*rm.parse_publish(_publish(3)))
        view = self.mirror.view()
        self.assertEqual((view["frame"]["seq"], view["frame_rev"], view["frame_age_ms"]), (3, 2, 0))

    def test_another_source_replaces_everything_of_the_previous_one(self) -> None:
        self.mirror.publish(*rm.parse_publish(_publish(1)))
        self.mirror.publish(*rm.parse_publish(_publish(1, frame=False, source_id="kiosk-test-0002")))
        view = self.mirror.view()
        self.assertEqual(view["source"]["id"], "kiosk-test-0002")
        self.assertIsNone(view["frame"])
        self.assertIsNone(view["frame_age_ms"])

    def test_close_forgets_everything_but_the_counters(self) -> None:
        self.mirror.publish(*rm.parse_publish(_publish(1)))
        self.mirror.close()
        view = self.mirror.view()
        self.assertEqual((view["source"], view["state"], view["frame"], view["source_age_ms"]), (None, None, None, None))
        self.assertEqual((view["rev"], view["frame_rev"]), (1, 1))

    def test_posts_are_taken_only_while_open(self) -> None:
        closed = rm.ReceiverMirror(clock=self.clock)
        self.assertFalse(closed.is_open())
        for mirror in (closed, self.mirror):
            if mirror is self.mirror:
                mirror.close()
            with self.subTest(opened_before=mirror is self.mirror):
                with self.assertRaises(rm.MirrorRejected) as refused:
                    mirror.publish(*rm.parse_publish(_publish(2)))
                self.assertEqual((refused.exception.code, refused.exception.status), (rm.MIRROR_LAN_CLOSED, 409))
                view = mirror.view()
                self.assertEqual((view["source"], view["state"], view["frame"]), (None, None, None))
        # Opened again (the LAN view moved or was enabled again), it takes posts.
        self.mirror.open()
        self.assertTrue(self.mirror.is_open())
        self.assertEqual(self.mirror.publish(*rm.parse_publish(_publish(3))), {"rev": 1, "frame_rev": 1, "commands": []})


class MirrorRouteTests(_ServerCase):
    def setUp(self) -> None:
        super().setUp()
        self.server = self.start_server()
        self.main_port = self.server.server_address[1]

    def post(self, body: Any, *, origin: Optional[str] = "default", raw: Optional[bytes] = None,
             port: Optional[int] = None) -> Tuple[int, Dict[str, Any]]:
        target = self.main_port if port is None else port
        headers = [("Content-Type", "application/json")]
        if origin == "default":
            headers.append(("Origin", f"http://127.0.0.1:{target}"))
        elif origin is not None:
            headers.append(("Origin", origin))
        data = raw if raw is not None else json.dumps(body).encode("utf-8")
        status, _headers, answer = _request(target, "POST", rm.ROUTE, headers, data)
        return status, _json(answer)

    def get(self, port: Optional[int] = None, headers: Optional[List[Tuple[str, str]]] = None) -> Tuple[int, Dict[str, Any]]:
        status, _headers, answer = _request(self.main_port if port is None else port, "GET", rm.ROUTE, headers)
        return status, _json(answer)

    def assert_code(self, result: Tuple[int, Dict[str, Any]], status: int, code: str) -> None:
        self.assertEqual(result[0], status, result[1])
        self.assertEqual((result[1]["ok"], result[1]["code"]), (False, code))

    def test_nothing_is_taken_while_the_lan_view_is_closed(self) -> None:
        self.assert_code(self.post(_publish()), 409, rm.MIRROR_LAN_CLOSED)
        self.assertIsNone(self.get()[1]["source"])

    def test_the_kiosk_page_publishes_and_both_listeners_read_it(self) -> None:
        lan_port = self.open_lan(self.server)
        status, answer = self.post(_publish(7))
        self.assertEqual((status, answer), (200, {"ok": True, "rev": 1, "frame_rev": 1, "commands": []}))
        for port in (self.main_port, lan_port):
            with self.subTest(port=port):
                status, view = self.get(port)
                self.assertEqual(status, 200)
                self.assertEqual(view["source"], {"id": SOURCE_ID, "kind": "kiosk-tab", "visible": True})
                self.assertEqual(view["state"], _state(7))
                self.assertEqual(view["frame"], _frame(7))
                self.assertGreaterEqual(view["frame_age_ms"], 0)
                self.assertLess(view["frame_age_ms"], 5000)
        # HEAD on the LAN view answers without a body.
        status, headers, body = _request(lan_port, "HEAD", rm.ROUTE)
        self.assertEqual((status, body), (200, b""))
        self.assertEqual(headers["content-type"], "application/json; charset=utf-8")

    def test_only_the_console_s_own_page_may_publish(self) -> None:
        self.open_lan(self.server)
        for origin in (None, "http://127.0.0.1:1", "http://localhost:8787", "https://127.0.0.1", "http://192.168.1.20"):
            with self.subTest(origin=origin):
                self.assert_code(self.post(_publish(), origin=origin), 403, rm.ORIGIN_REJECTED)
        self.assertIsNone(self.get()[1]["source"])

    def test_the_lan_view_can_never_publish(self) -> None:
        lan_port = self.open_lan(self.server)
        status, answer = self.post(_publish(), port=lan_port)
        self.assertEqual((status, answer["code"]), (405, "LAN_READ_ONLY"))
        self.assertIsNone(self.get()[1]["source"])

    def test_the_body_is_at_most_8_kib(self) -> None:
        self.open_lan(self.server)
        compact = json.dumps(_publish(), separators=(",", ":")).encode("utf-8")
        at_limit = compact + b" " * (rm.MAX_BODY_BYTES - len(compact))
        self.assertEqual(self.post(None, raw=at_limit)[0], 200)
        self.assert_code(self.post(None, raw=at_limit + b" "), 413, rm.MIRROR_TOO_LARGE)
        self.assert_code(self.post(None, raw=b" " * 70_000), 413, rm.MIRROR_TOO_LARGE)

    def test_the_schema_is_checked_strictly(self) -> None:
        self.open_lan(self.server)
        self.assert_code(self.post(None, raw=b"{not json"), 400, rm.MIRROR_INVALID)
        self.assert_code(self.post({**_publish(), "extra": 1}), 400, rm.MIRROR_INVALID)
        bad = _publish()
        bad["frame"]["bins"] = _bins(100)
        status, answer = self.post(bad)
        self.assertEqual(status, 400)
        self.assertIn("frame.bins", answer["error"])
        self.assertIsNone(self.get()[1]["source"])

    def test_a_body_beyond_the_decoder_is_answered_400(self) -> None:
        # Once an OverflowError or RecursionError escaped the handler: a
        # traceback in the log and a reset instead of the answer.
        self.open_lan(self.server)
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            for raw in BODIES_BEYOND_THE_DECODER:
                with self.subTest(raw=raw[:20]):
                    self.assert_code(self.post(None, raw=raw), 400, rm.MIRROR_INVALID)
        self.assertNotIn("Traceback", errors.getvalue() + self.output.getvalue())
        self.assertIsNone(self.get()[1]["source"])

    def test_at_most_twelve_posts_a_second(self) -> None:
        self.open_lan(self.server)
        frozen = _Clock()
        self.server.receiver_mirror._clock = frozen  # type: ignore[attr-defined]
        statuses = [self.post(_publish(seq))[0] for seq in range(1, rm.MAX_POSTS_PER_S + 3)]
        self.assertEqual(statuses, [200] * rm.MAX_POSTS_PER_S + [429, 429])
        self.assert_code(self.post(_publish(99)), 429, rm.MIRROR_RATE_LIMITED)
        self.assertEqual(self.get()[1]["state"]["rev"], rm.MAX_POSTS_PER_S)
        frozen.now += rm.RATE_WINDOW_S
        self.assertEqual(self.post(_publish(100))[0], 200)

    def test_a_cross_site_page_cannot_read_it(self) -> None:
        lan_port = self.open_lan(self.server)
        self.post(_publish())
        for port in (self.main_port, lan_port):
            with self.subTest(port=port):
                self.assert_code(self.get(port, [("Sec-Fetch-Site", "cross-site")]), 403, rm.ORIGIN_REJECTED)
                self.assertEqual(self.get(port, [("Sec-Fetch-Site", "same-origin")])[0], 200)

    def test_the_loopback_listener_reads_it_under_the_receiver_rule(self) -> None:
        # The mirror carries what the Receiver shows, so on the loopback
        # listener it is read like /api/receiver/*: one loopback Host on the
        # console's port (a DNS rebinding page sends its own host name) and
        # no other site or localhost port.
        lan_port = self.open_lan(self.server)
        self.post(_publish())
        port = self.main_port
        for host in (f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}", f"LOCALHOST.:{port}"):
            with self.subTest(host=host):
                status, _headers, body = _request(port, "GET", rm.ROUTE, [("Sec-Fetch-Site", "same-origin")], host=host)
                self.assertEqual(status, 200, body)
                self.assertEqual(_json(body)["state"]["center_hz"], _state()["center_hz"])
        refused: List[Tuple[Optional[str], List[Tuple[str, str]]]] = [
            (f"attacker.example:{port}", [("Sec-Fetch-Site", "same-origin")]),
            (f"attacker.example:{port}", []),
            (f"192.168.1.20:{port}", []),
            (f"127.0.0.1:{lan_port}", []),
            ("127.0.0.1", []),
            (None, []),
            (f"127.0.0.1:{port}", [("Host", f"127.0.0.1:{port}")]),
            (f"127.0.0.1:{port}", [("Sec-Fetch-Site", "same-site")]),
            (f"127.0.0.1:{port}", [("Sec-Fetch-Site", "cross-site")]),
        ]
        for host, headers in refused:
            with self.subTest(host=host, headers=headers):
                status, _headers, body = _request(port, "GET", rm.ROUTE, headers, host=host)
                self.assert_code((status, _json(body)), 403, rm.ORIGIN_REJECTED)
        # The LAN view keeps its own rule: an IP literal on its port, and a
        # same-site page (another port of the tablet's site) may read it.
        status, _headers, body = _request(lan_port, "GET", rm.ROUTE, [("Sec-Fetch-Site", "same-site")])
        self.assertEqual(status, 200, body)
        status, _headers, body = _request(lan_port, "GET", rm.ROUTE, host=f"attacker.example:{lan_port}")
        self.assert_code((status, _json(body)), 403, rm.ORIGIN_REJECTED)

    def test_memory_only_and_cleared_with_the_lan_view(self) -> None:
        self.open_lan(self.server)
        before = sorted(str(path.relative_to(self.root)) for path in self.root.rglob("*"))
        for seq in range(1, 6):
            self.assertEqual(self.post(_publish(seq))[0], 200)
        after = sorted(str(path.relative_to(self.root)) for path in self.root.rglob("*"))
        self.assertEqual(after, before)
        self.assertEqual(self.get()[1]["frame"]["seq"], 5)
        # Closing the LAN view drops what was mirrored for it.
        self.server.lan.apply({"enabled": False, "port": 0, "bind": "127.0.0.1", "allowed_clients": []})
        view = self.get()[1]
        self.assertEqual((view["source"], view["state"], view["frame"]), (None, None, None))
        self.assert_code(self.post(_publish(6)), 409, rm.MIRROR_LAN_CLOSED)

    def test_a_post_in_flight_when_the_lan_view_closes_is_not_kept(self) -> None:
        # The POST found the LAN view open; the view closes while its body is
        # decoded. Its state must not be stored after the close cleared the
        # mirror, or the loopback GET would serve it, and a LAN view enabled
        # hours later would show it at once.
        self.open_lan(self.server)
        self.assertEqual(self.post(_publish(1))[0], 200)
        decode = rm.decode_publish

        def close_then_decode(raw: bytes) -> Any:
            self.server.lan.apply({"enabled": False, "port": 0, "bind": "127.0.0.1", "allowed_clients": []})
            return decode(raw)

        with mock.patch.object(rm, "decode_publish", side_effect=close_then_decode):
            self.assert_code(self.post(_publish(2)), 409, rm.MIRROR_LAN_CLOSED)
        view = self.get()[1]
        self.assertEqual((view["source"], view["state"], view["frame"]), (None, None, None))
        self.assertEqual((view["rev"], view["frame_rev"]), (1, 1))
        # Opened again, the next post is taken.
        self.open_lan(self.server)
        self.assertEqual(self.post(_publish(3)), (200, {"ok": True, "rev": 2, "frame_rev": 2, "commands": []}))

    def test_moving_the_lan_view_keeps_taking_posts(self) -> None:
        self.open_lan(self.server)
        self.assertEqual(self.post(_publish(1))[0], 200)
        self.open_lan(self.server)
        self.assertIsNone(self.get()[1]["source"])
        self.assertEqual(self.post(_publish(2))[0], 200)
        self.assertEqual(self.get()[1]["state"]["rev"], 2)

    def test_served_answers_are_not_logged_and_refusals_are(self) -> None:
        self.open_lan(self.server, allowed=NOBODY)
        mark = len(self.output.getvalue())
        self.post(_publish())
        self.get()
        self.assertNotIn(rm.ROUTE, self.output.getvalue()[mark:])
        self.post({"v": 1})
        self.assertIn(f'"POST {rm.ROUTE} HTTP/1.1" 400', self.output.getvalue()[mark:])

    def test_the_receiver_read_rule_is_unchanged_on_the_lan_view(self) -> None:
        # The /api/mirror/ prefix opens nothing under /api/receiver/; only the
        # Records read routes answer there (tools/test_receiver_archive.py).
        lan_port = self.open_lan(self.server)
        for path in ("/api/receiver/settings", "/api/receiver/marker-sets", "/api/receiver/records"):
            with self.subTest(path=path):
                status, _headers, body = _request(lan_port, "GET", path)
                self.assertEqual((status, _json(body)["code"]), (403, "LAN_READ_ONLY"))


# ---------------------------------------------------------------------------
# Spectrum markers from the LAN view (owner's decision of 2026-10-31).
# ---------------------------------------------------------------------------

COMMAND_ID = "tab-cmd-0001"


def _marker(index: int = 1, **overrides: Any) -> Dict[str, Any]:
    marker = {"id": f"m-{index}", "frequency_hz": 433_000_000 + index * 10_000, "power_db": -52.5, "label": f"M{index}"}
    marker.update(overrides)
    return marker


def _markers(count: int = 2, *, total: Optional[int] = None, saved: bool = True) -> Dict[str, Any]:
    return {"rev": 3, "saved": saved, "total": count if total is None else total, "markers": [_marker(i) for i in range(1, count + 1)]}


def _add(command_id: str = COMMAND_ID, hz: int = 433_920_000) -> Dict[str, Any]:
    return {"v": 1, "id": command_id, "op": "add", "frequency_hz": hz}


def _remove(command_id: str = COMMAND_ID, marker_id: str = "m-1") -> Dict[str, Any]:
    return {"v": 1, "id": command_id, "op": "remove", "marker_id": marker_id}


class MarkerSchemaTests(unittest.TestCase):
    def test_a_publish_with_markers_and_results(self) -> None:
        body = {**_publish(frame=False), "markers": _markers(), "results": [{"id": COMMAND_ID, "code": "OK", "marker_id": "m-9"}]}
        post = rm.parse_publish(copy.deepcopy(body))
        self.assertEqual(post.markers, body["markers"])
        self.assertEqual(post.results, ({"id": COMMAND_ID, "code": "OK", "marker_id": "m-9"},))
        # No markers part: the stored list stays; null clears it.
        self.assertIs(rm.parse_publish(_publish()).markers, rm.UNCHANGED)
        self.assertEqual(rm.parse_publish(_publish()).results, ())
        self.assertIsNone(rm.parse_publish({**_publish(), "markers": None}).markers)
        # A marker the console cannot address has no id; it is drawn, never removed from a viewer.
        body["markers"]["markers"][0].update({"id": None, "power_db": None})
        self.assertIsNone(rm.parse_publish(copy.deepcopy(body)).markers["markers"][0]["id"])
        # At most 64, labels of up to 32 characters (code points, not bytes).
        full = {"rev": 0, "saved": False, "total": 9000, "markers": [_marker(i, label="é" * 32) for i in range(rm.MAX_MARKERS)]}
        self.assertEqual(len(rm.parse_publish({**_publish(), "markers": full}).markers["markers"]), rm.MAX_MARKERS)

    def test_every_bad_marker_part_is_refused_whole(self) -> None:
        cases: List[Tuple[str, Any]] = [
            ("markers as a list", [_marker()]),
            ("unknown field", {**_markers(), "set_name": "Bandung"}),
            ("rev missing", {key: value for key, value in _markers().items() if key != "rev"}),
            ("saved as a number", {**_markers(), "saved": 1}),
            ("65 markers", _markers(rm.MAX_MARKERS + 1)),
            ("total below the markers sent", _markers(2, total=1)),
            ("label of 33 characters", {**_markers(1), "markers": [_marker(label="x" * 33)]}),
            ("label with a newline", {**_markers(1), "markers": [_marker(label="M1\nx")]}),
            ("label as a number", {**_markers(1), "markers": [_marker(label=1)]}),
            ("id with a space", {**_markers(1), "markers": [_marker(id="m 1")]}),
            ("id of 65 characters", {**_markers(1), "markers": [_marker(id="m" * 65)]}),
            ("frequency as text", {**_markers(1), "markers": [_marker(frequency_hz="433")]}),
            ("frequency as a fraction", {**_markers(1), "markers": [_marker(frequency_hz=433.5)]}),
            ("power below the floor", {**_markers(1), "markers": [_marker(power_db=-201)]}),
            ("power beyond a float", {**_markers(1), "markers": [_marker(power_db=10 ** 400)]}),
            ("marker field missing", {**_markers(1), "markers": [{"id": "m-1", "frequency_hz": 1, "label": ""}]}),
            ("extra marker field", {**_markers(1), "markers": [_marker(color="red")]}),
        ]
        for name, markers in cases:
            with self.subTest(name), self.assertRaises(rm.MirrorRejected) as caught:
                rm.parse_publish({**_publish(), "markers": markers})
            self.assertEqual(caught.exception.code, rm.MIRROR_INVALID)

    def test_every_bad_result_is_refused_whole(self) -> None:
        good = {"id": COMMAND_ID, "code": "MARKER_SAVE_FAILED", "marker_id": "m-1"}
        cases: List[Tuple[str, Any]] = [
            ("results as an object", good),
            ("17 results", [good] * (rm.MAX_RESULTS_PER_POST + 1)),
            ("unknown code", [{**good, "code": "SWEEP_BUSY"}]),
            ("short id", [{**good, "id": "abc"}]),
            ("bad marker id", [{**good, "marker_id": "m/1"}]),
            ("marker id missing", [{"id": COMMAND_ID, "code": "OK"}]),
            ("extra field", [{**good, "message": "saved"}]),
        ]
        for name, results in cases:
            with self.subTest(name), self.assertRaises(rm.MirrorRejected) as caught:
                rm.parse_publish({**_publish(), "results": results})
            self.assertEqual(caught.exception.code, rm.MIRROR_INVALID)
        for code in sorted(rm.MARKER_RESULT_CODES):
            self.assertEqual(rm.parse_publish({**_publish(), "results": [{**good, "code": code}]}).results[0]["code"], code)

    def test_marker_commands(self) -> None:
        self.assertEqual(rm.parse_marker_command(_add()), {"id": COMMAND_ID, "op": "add", "frequency_hz": 433_920_000})
        self.assertEqual(rm.parse_marker_command(_remove()), {"id": COMMAND_ID, "op": "remove", "marker_id": "m-1"})
        # The frame checks the marker range (with the Freq Shift); the console checks the shape only.
        self.assertEqual(rm.parse_marker_command(_add(hz=-9_000_000_000))["frequency_hz"], -9_000_000_000)
        cases: List[Tuple[str, Any]] = [
            ("a list", [_add()]),
            ("version 2", {**_add(), "v": 2}),
            ("no version", {key: value for key, value in _add().items() if key != "v"}),
            ("unknown op", {**_add(), "op": "tune"}),
            ("add without a frequency", {"v": 1, "id": COMMAND_ID, "op": "add"}),
            ("add with a marker id", {**_add(), "marker_id": "m-1"}),
            ("remove without a marker id", {"v": 1, "id": COMMAND_ID, "op": "remove"}),
            ("remove with a frequency", {**_remove(), "frequency_hz": 433_920_000}),
            ("frequency as text", _add(hz="433920000")),  # type: ignore[arg-type]
            ("frequency as a fraction", _add(hz=433_920_000.5)),  # type: ignore[arg-type]
            ("frequency as a boolean", _add(hz=True)),  # type: ignore[arg-type]
            ("frequency beyond 100 GHz", _add(hz=100_000_000_001)),
            ("frequency beyond a float", _add(hz=10 ** 400)),
            ("id of 7 characters", _add("tab-cmd")),
            ("id with a slash", _add("tab/cmd/0001")),
            ("marker id with a dot", _remove(marker_id="m.1")),
            ("extra field", {**_add(), "label": "here"}),
        ]
        for name, body in cases:
            with self.subTest(name), self.assertRaises(rm.MirrorRejected) as caught:
                rm.parse_marker_command(body)
            self.assertEqual(caught.exception.code, rm.MIRROR_INVALID)

    def test_raw_marker_commands(self) -> None:
        good = json.dumps(_add()).encode("utf-8")
        self.assertEqual(rm.decode_marker_command(good)["op"], "add")
        for raw in (b"\xff", b"{", b"[" * 400, good.replace(b"433920000", b"NaN")):
            with self.subTest(raw=raw[:20]), self.assertRaises(rm.MirrorRejected) as caught:
                rm.decode_marker_command(raw)
            self.assertEqual(caught.exception.code, rm.MIRROR_INVALID)
        with self.assertRaises(rm.MirrorRejected) as caught:
            rm.decode_marker_command(good + b" " * rm.MAX_MARKER_BODY_BYTES)
        self.assertEqual((caught.exception.code, caught.exception.status), (rm.MIRROR_TOO_LARGE, 413))


class MarkerStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = _Clock()
        self.mirror = rm.ReceiverMirror(clock=self.clock)
        self.mirror.open()

    def post(self, *, results: Any = (), markers: Any = rm.UNCHANGED, source_id: str = SOURCE_ID) -> Dict[str, Any]:
        return self.mirror.publish(*rm.parse_publish(_publish(frame=False, source_id=source_id))[:3], markers, results)

    def queue(self, body: Dict[str, Any]) -> Dict[str, Any]:
        return self.mirror.queue_marker_command(rm.parse_marker_command(body))

    def assert_refused(self, body: Dict[str, Any], code: str) -> None:
        with self.assertRaises(rm.MirrorRejected) as caught:
            self.queue(body)
        self.assertEqual(caught.exception.code, code)

    def test_a_command_needs_a_page_that_publishes(self) -> None:
        self.assert_refused(_add(), rm.MIRROR_NO_SOURCE)
        self.post()
        self.assertEqual(self.queue(_add())["status"], rm.COMMAND_QUEUED)
        self.clock.now += rm.SOURCE_LOST_MS / 1000 + 0.001
        self.assert_refused(_add("tab-cmd-0002"), rm.MIRROR_NO_SOURCE)

    def test_queued_handed_out_once_then_settled_by_its_result(self) -> None:
        self.post()
        queued = self.queue(_add())
        self.assertEqual(
            {key: queued[key] for key in ("ok", "id", "op", "frequency_hz", "marker_id", "status", "code", "age_ms")},
            {"ok": True, "id": COMMAND_ID, "op": "add", "frequency_hz": 433_920_000, "marker_id": None, "status": "queued", "code": None, "age_ms": 0},
        )
        self.queue(_remove("tab-cmd-0002", "m-7"))
        answer = self.post()
        self.assertEqual(answer["commands"], [
            {"id": COMMAND_ID, "op": "add", "frequency_hz": 433_920_000},
            {"id": "tab-cmd-0002", "op": "remove", "marker_id": "m-7"},
        ])
        self.assertEqual(self.mirror.marker_command(COMMAND_ID)["status"], rm.COMMAND_SENT)
        # Nothing is handed out twice, also when the next post carries no result.
        self.assertEqual(self.post()["commands"], [])
        self.clock.now += 0.4
        self.post(results=[
            {"id": COMMAND_ID, "code": "MARKER_SAVE_FAILED", "marker_id": "m-8"},
            {"id": "tab-cmd-0002", "code": "OK", "marker_id": None},
            # A result for a command never held is ignored.
            {"id": "tab-cmd-9999", "code": "OK", "marker_id": None},
        ])
        added = self.mirror.marker_command(COMMAND_ID)
        self.assertEqual((added["status"], added["code"], added["marker_id"], added["age_ms"]), ("done", "MARKER_SAVE_FAILED", "m-8", 400))
        removed = self.mirror.marker_command("tab-cmd-0002")
        self.assertEqual((removed["status"], removed["code"], removed["marker_id"]), ("done", "OK", "m-7"))
        self.assertIsNone(self.mirror.marker_command("tab-cmd-9999"))
        # A second result does not change a settled command.
        self.post(results=[{"id": COMMAND_ID, "code": "OK", "marker_id": "m-1"}])
        self.assertEqual(self.mirror.marker_command(COMMAND_ID)["code"], "MARKER_SAVE_FAILED")

    def test_a_result_before_the_command_was_handed_out_is_ignored(self) -> None:
        self.post()
        self.queue(_add())
        # The same post reports a result and gets the command: the result came first.
        answer = self.post(results=[{"id": COMMAND_ID, "code": "OK", "marker_id": "m-1"}])
        self.assertEqual([command["id"] for command in answer["commands"]], [COMMAND_ID])
        self.assertEqual(self.mirror.marker_command(COMMAND_ID)["status"], rm.COMMAND_SENT)

    def test_commands_expire_and_a_late_result_still_settles(self) -> None:
        self.post()
        self.queue(_add())
        ttl = rm.MARKER_COMMAND_TTL_MS / 1000
        # No post takes it in time: it expires unseen.
        self.clock.now += ttl
        self.assertEqual(self.mirror.marker_command(COMMAND_ID)["status"], rm.COMMAND_EXPIRED)
        self.assertEqual(self.post()["commands"], [])
        # A result for a command never handed out does not settle it.
        self.post(results=[{"id": COMMAND_ID, "code": "OK", "marker_id": "m-1"}])
        self.assertEqual(self.mirror.marker_command(COMMAND_ID)["status"], rm.COMMAND_EXPIRED)
        # Handed out, then not answered in time; a late result settles it.
        self.post()
        self.queue(_add("tab-cmd-0002"))
        self.assertEqual(len(self.post()["commands"]), 1)
        self.clock.now += ttl - 0.001
        self.assertEqual(self.mirror.marker_command("tab-cmd-0002")["status"], rm.COMMAND_SENT)
        self.clock.now += 0.001
        self.assertEqual(self.mirror.marker_command("tab-cmd-0002")["status"], rm.COMMAND_EXPIRED)
        self.post(results=[{"id": "tab-cmd-0002", "code": "OK", "marker_id": "m-2"}])
        late = self.mirror.marker_command("tab-cmd-0002")
        self.assertEqual((late["status"], late["code"], late["marker_id"]), ("done", "OK", "m-2"))

    def test_at_most_sixteen_wait_and_settled_ones_make_room(self) -> None:
        self.post()
        for index in range(rm.MAX_PENDING_MARKER_COMMANDS):
            self.queue(_add(f"tab-cmd-{index:04d}"))
        self.assert_refused(_add("tab-cmd-0100"), rm.MIRROR_MARKER_BUSY)
        handed = self.post()["commands"]
        self.assertEqual(len(handed), rm.MAX_PENDING_MARKER_COMMANDS)
        # Handed out but not answered still counts.
        self.assert_refused(_add("tab-cmd-0100"), rm.MIRROR_MARKER_BUSY)
        self.post(results=[{"id": handed[0]["id"], "code": "OK", "marker_id": "m-1"}])
        self.assertEqual(self.queue(_add("tab-cmd-0100"))["status"], rm.COMMAND_QUEUED)
        # Expired ones make room too (the page still posts).
        self.clock.now += rm.MARKER_COMMAND_TTL_MS / 1000
        self.post()
        self.assertEqual(self.queue(_add("tab-cmd-0101"))["status"], rm.COMMAND_QUEUED)

    def test_at_most_64_commands_are_kept_for_status_reads(self) -> None:
        for index in range(rm.MAX_KEPT_MARKER_COMMANDS + 10):
            self.post()
            command_id = f"tab-cmd-{index:04d}"
            self.queue(_add(command_id))
            self.post()
            self.post(results=[{"id": command_id, "code": "OK", "marker_id": f"m-{index}"}])
        self.assertEqual(len(self.mirror._commands), rm.MAX_KEPT_MARKER_COMMANDS)
        self.assertIsNone(self.mirror.marker_command("tab-cmd-0000"))
        self.assertEqual(self.mirror.marker_command(f"tab-cmd-{rm.MAX_KEPT_MARKER_COMMANDS + 9:04d}")["status"], "done")

    def test_an_id_is_taken_once(self) -> None:
        self.post()
        self.queue(_add())
        self.assert_refused(_remove(), rm.MIRROR_DUPLICATE_ID)

    def test_four_commands_a_second_per_client(self) -> None:
        taken = [self.mirror.admit_marker_command("192.168.1.20") for _ in range(rm.MARKER_COMMANDS_PER_S + 1)]
        self.assertEqual(taken, [True] * rm.MARKER_COMMANDS_PER_S + [False])
        # Another tablet has its own count.
        self.assertTrue(self.mirror.admit_marker_command("192.168.1.21"))
        self.clock.now += rm.RATE_WINDOW_S
        self.assertTrue(self.mirror.admit_marker_command("192.168.1.20"))
        # The record of clients holds only those of the last second, at most MAX_RATE_CLIENTS.
        self.clock.now += rm.RATE_WINDOW_S
        for index in range(rm.MAX_RATE_CLIENTS):
            self.assertTrue(self.mirror.admit_marker_command(f"10.0.{index // 256}.{index % 256}"))
        self.assertFalse(self.mirror.admit_marker_command("192.168.1.22"))
        self.clock.now += rm.RATE_WINDOW_S
        self.assertTrue(self.mirror.admit_marker_command("192.168.1.22"))
        self.assertEqual(len(self.mirror._command_taken), 1)

    def test_the_marker_list_follows_its_page(self) -> None:
        self.assertIsNone(self.mirror.view()["markers"])
        self.post(markers=_markers(2))
        self.assertEqual(self.mirror.view()["markers"], _markers(2))
        # A post without a list keeps it; null clears it.
        self.post()
        self.assertEqual(self.mirror.view()["markers"]["total"], 2)
        self.post(markers=None)
        self.assertIsNone(self.mirror.view()["markers"])
        # Another page's state never shows the previous page's list.
        self.post(markers=_markers(1))
        self.post(source_id="kiosk-test-0002")
        self.assertIsNone(self.mirror.view()["markers"])

    def test_close_forgets_the_commands_and_the_list(self) -> None:
        self.post(markers=_markers(2))
        self.queue(_add())
        self.mirror.admit_marker_command("192.168.1.20")
        self.mirror.close()
        self.assertIsNone(self.mirror.marker_command(COMMAND_ID))
        self.assertIsNone(self.mirror.view()["markers"])
        self.assertEqual(self.mirror._command_taken, {})
        self.assert_refused(_add("tab-cmd-0002"), rm.MIRROR_LAN_CLOSED)
        self.mirror.open()
        # Opened again, a page must post before anything is queued.
        self.assert_refused(_add("tab-cmd-0002"), rm.MIRROR_NO_SOURCE)


class MarkerContractTests(unittest.TestCase):
    """The browser's copies and the LAN view's rules name the same route, ids, codes and limits."""

    def test_the_browser_copy_matches(self) -> None:
        text = MIRROR_TS.read_text(encoding="utf-8")
        self.assertIn(f"export const MIRROR_MARKERS_ROUTE = '{rm.MARKERS_ROUTE}';", text)
        codes = re.search(r"export const MIRROR_MARKER_RESULT_CODES = \[([^\]]*)\]", text)
        assert codes is not None, "MIRROR_MARKER_RESULT_CODES not found"
        self.assertEqual(set(re.findall(r"'([A-Z_]+)'", codes.group(1))), set(rm.MARKER_RESULT_CODES))
        errors = re.search(r"export const MIRROR_MARKER_ERROR_CODES = \[([^\]]*)\]", text)
        assert errors is not None, "MIRROR_MARKER_ERROR_CODES not found"
        self.assertEqual(set(re.findall(r"'([A-Z_]+)'", errors.group(1))), set(rm.ERROR_CODES_HTTP))
        self.assertIn("const MARKER_COMMAND_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u;", text)

    def test_the_lan_view_rules_name_the_same_route(self) -> None:
        self.assertEqual(lan.MIRROR_MARKERS_ROUTE, rm.MARKERS_ROUTE)
        self.assertEqual(lan.MIRROR_MARKER_COMMAND_ID_RE.pattern, rm.MARKER_COMMAND_ID_PATTERN.pattern)
        self.assertEqual(lan.WRITE_ROUTES, frozenset({("POST", rm.MARKERS_ROUTE)}))
        # A command id fits the GET path rule.
        self.assertEqual(lan.lan_route(f"{rm.MARKERS_ROUTE}/{COMMAND_ID}"), lan.ROUTE_MIRROR_MARKER)

    def test_the_bridge_names_every_result_code(self) -> None:
        protocol = (PROJECT_ROOT / "frontend" / "src" / "lib" / "receiverBridgeProtocol.ts").read_text(encoding="utf-8")
        block = re.search(r"export const RESULT_CODES = \[(.*?)\] as const;", protocol, re.S)
        assert block is not None
        self.assertLessEqual(set(rm.MARKER_RESULT_CODES), set(re.findall(r"'([A-Z_]+)'", block.group(1))))


class MarkerRouteTests(_ServerCase):
    def setUp(self) -> None:
        super().setUp()
        self.server = self.start_server()
        self.main_port = self.server.server_address[1]

    def publish(self, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raw = json.dumps(body if body is not None else _publish(frame=False)).encode("utf-8")
        status, _headers, answer = _request(
            self.main_port, "POST", rm.ROUTE, [("Origin", f"http://127.0.0.1:{self.main_port}"), ("Content-Type", "application/json")], raw,
        )
        self.assertEqual(status, 200, answer)
        return _json(answer)

    def command(self, body: Any, *, port: int, origin: Optional[str] = "default", raw: Optional[bytes] = None,
                headers: Optional[List[Tuple[str, str]]] = None) -> Tuple[int, Dict[str, str], Dict[str, Any]]:
        sent: List[Tuple[str, str]] = [("Content-Type", "application/json"), *(headers or [])]
        if origin == "default":
            sent.append(("Origin", f"http://127.0.0.1:{port}"))
        elif origin is not None:
            sent.append(("Origin", origin))
        data = raw if raw is not None else json.dumps(body).encode("utf-8")
        status, answer_headers, answer = _request(port, "POST", rm.MARKERS_ROUTE, sent, data)
        return status, answer_headers, _json(answer) if answer else {}

    def status_of(self, command_id: str, *, port: int, headers: Optional[List[Tuple[str, str]]] = None) -> Tuple[int, Dict[str, Any]]:
        status, _headers, answer = _request(port, "GET", f"{rm.MARKERS_ROUTE}/{command_id}", headers)
        return status, _json(answer)

    def assert_code(self, result: Tuple[Any, ...], status: int, code: str) -> None:
        self.assertEqual(result[0], status, result[-1])
        self.assertEqual((result[-1]["ok"], result[-1]["code"]), (False, code))

    def test_a_tablet_marks_through_the_groundstation_page(self) -> None:
        lan_port = self.open_lan(self.server)
        self.publish()
        status, _headers, queued = self.command(_add(), port=lan_port)
        self.assertEqual(status, 202, queued)
        self.assertEqual((queued["id"], queued["status"], queued["op"]), (COMMAND_ID, "queued", "add"))
        status, _headers, removal = self.command(_remove("tab-cmd-0002", "m-4"), port=lan_port)
        self.assertEqual(status, 202, removal)
        # The page gets both in the answer to its next post, and reports the results in a later one.
        answer = self.publish()
        self.assertEqual(answer["commands"], [
            {"id": COMMAND_ID, "op": "add", "frequency_hz": 433_920_000},
            {"id": "tab-cmd-0002", "op": "remove", "marker_id": "m-4"},
        ])
        self.assertEqual(self.status_of(COMMAND_ID, port=lan_port)[1]["status"], "sent")
        listed = {**_markers(1), "markers": [_marker(9, id="m-9", frequency_hz=433_920_000)]}
        self.publish({**_publish(frame=False), "markers": listed, "results": [
            {"id": COMMAND_ID, "code": "OK", "marker_id": "m-9"},
            {"id": "tab-cmd-0002", "code": "MARKER_NOT_FOUND", "marker_id": None},
        ]})
        for port in (lan_port, self.main_port):
            with self.subTest(port=port):
                status, done = self.status_of(COMMAND_ID, port=port)
                self.assertEqual((status, done["status"], done["code"], done["marker_id"]), (200, "done", "OK", "m-9"))
                self.assertEqual(self.status_of("tab-cmd-0002", port=port)[1]["code"], "MARKER_NOT_FOUND")
                status, _headers, raw = _request(port, "GET", rm.ROUTE)
                self.assertEqual(_json(raw)["markers"], listed)

    def test_the_loopback_listener_takes_the_same_command(self) -> None:
        self.open_lan(self.server)
        self.publish()
        status, _headers, queued = self.command(_add(), port=self.main_port)
        self.assertEqual((status, queued["status"]), (202, "queued"))
        self.assertEqual(self.publish()["commands"][0]["id"], COMMAND_ID)
        for origin in (None, "http://127.0.0.1:1", "http://192.168.1.20:8788"):
            with self.subTest(origin=origin):
                self.assert_code(self.command(_add("tab-cmd-0003"), port=self.main_port, origin=origin), 403, rm.ORIGIN_REJECTED)

    def test_only_the_lan_view_s_own_page_may_send(self) -> None:
        lan_port = self.open_lan(self.server)
        self.publish()
        refused = [
            None,
            f"http://127.0.0.1:{lan_port + 1}",
            f"https://127.0.0.1:{lan_port}",
            f"http://192.168.1.20:{lan_port}",
            f"http://127.0.0.1:{self.main_port}",
            f"http://127.0.0.1:{lan_port}/page",
            "null",
        ]
        for origin in refused:
            with self.subTest(origin=origin):
                self.assert_code(self.command(_add(), port=lan_port, origin=origin), 403, rm.ORIGIN_REJECTED)
        # Two Origins are one too many.
        self.assert_code(
            self.command(_add(), port=lan_port, headers=[("Origin", f"http://127.0.0.1:{lan_port}")]), 403, rm.ORIGIN_REJECTED,
        )
        # A cross-site request is refused before the route, with the LAN view's own code.
        status, _headers, answer = self.command(_add(), port=lan_port, headers=[("Sec-Fetch-Site", "cross-site")])
        self.assertEqual((status, answer["code"]), (403, "ORIGIN_REJECTED"))
        self.assertIsNone(self.server.receiver_mirror.marker_command(COMMAND_ID))
        # The Host may be any name the LAN view admits, with the Origin that page sends.
        status, _headers, raw = _request(
            lan_port, "POST", rm.MARKERS_ROUTE,
            [("Origin", f"http://[::1]:{lan_port}"), ("Content-Type", "application/json")],
            json.dumps(_add()).encode("utf-8"), host=f"[::1]:{lan_port}",
        )
        self.assertEqual(status, 202, raw)

    def test_no_cookie_is_read(self) -> None:
        lan_port = self.open_lan(self.server)
        self.publish()
        cookie = self.admin_cookie(self.server)
        self.assertEqual(PASSWORD in cookie, False)
        status, headers, _answer = self.command(_add(), port=lan_port, headers=[("Cookie", cookie)])
        self.assertEqual(status, 202)
        self.assertNotIn("set-cookie", headers)
        status, _headers, _answer = self.command(_add("tab-cmd-0002"), port=lan_port)
        self.assertEqual(status, 202)

    def test_the_body_is_at_most_512_bytes(self) -> None:
        lan_port = self.open_lan(self.server)
        self.publish()
        compact = json.dumps(_add(), separators=(",", ":")).encode("utf-8")
        at_limit = compact + b" " * (rm.MAX_MARKER_BODY_BYTES - len(compact))
        self.assertEqual(self.command(None, port=lan_port, raw=at_limit)[0], 202)
        self.assert_code(self.command(None, port=lan_port, raw=at_limit + b" "), 413, rm.MIRROR_TOO_LARGE)
        self.assert_code(self.command(None, port=lan_port, raw=b" " * 70_000), 413, rm.MIRROR_TOO_LARGE)

    def test_the_schema_is_checked_strictly(self) -> None:
        lan_port = self.open_lan(self.server)
        self.publish()
        self.assert_code(self.command(None, port=lan_port, raw=b"{not json"), 400, rm.MIRROR_INVALID)
        status, _headers, answer = self.command({**_add(), "op": "tune"}, port=lan_port)
        self.assertEqual(status, 400)
        self.assertIn("op", answer["error"])
        self.assert_code(self.command(None, port=lan_port, raw=b""), 400, rm.MIRROR_INVALID)

    def test_four_commands_a_second_from_one_tablet(self) -> None:
        lan_port = self.open_lan(self.server)
        self.publish()
        frozen = _Clock()
        frozen.now = self.server.receiver_mirror._clock()
        self.server.receiver_mirror._clock = frozen  # type: ignore[attr-defined]
        statuses = [self.command(_add(f"tab-cmd-{index:04d}"), port=lan_port)[0] for index in range(rm.MARKER_COMMANDS_PER_S + 1)]
        self.assertEqual(statuses, [202] * rm.MARKER_COMMANDS_PER_S + [429])
        frozen.now += rm.RATE_WINDOW_S
        self.assertEqual(self.command(_add("tab-cmd-0100"), port=lan_port)[0], 202)

    def test_at_most_sixteen_wait_and_each_expires(self) -> None:
        lan_port = self.open_lan(self.server)
        self.publish()
        frozen = _Clock()
        frozen.now = self.server.receiver_mirror._clock()
        self.server.receiver_mirror._clock = frozen  # type: ignore[attr-defined]
        for index in range(rm.MAX_PENDING_MARKER_COMMANDS):
            frozen.now += 0.3  # under the rate limit
            self.assertEqual(self.command(_add(f"tab-cmd-{index:04d}"), port=lan_port)[0], 202)
        frozen.now += 0.3
        status, headers, answer = self.command(_add("tab-cmd-0100"), port=lan_port)
        self.assert_code((status, answer), 429, rm.MIRROR_MARKER_BUSY)
        # The page did not post: the source is lost after 10 s and nothing more is taken.
        frozen.now += rm.SOURCE_LOST_MS / 1000
        self.assert_code(self.command(_add("tab-cmd-0101"), port=lan_port), 409, rm.MIRROR_NO_SOURCE)
        frozen.now += rm.MARKER_COMMAND_TTL_MS / 1000
        self.assertEqual(self.status_of("tab-cmd-0000", port=lan_port)[1]["status"], "expired")
        # Expired commands are never handed to a page that posts again.
        self.assertEqual(self.publish()["commands"], [])
        self.assertEqual(self.command(_add("tab-cmd-0102"), port=lan_port)[0], 202)

    def test_nothing_is_queued_without_a_page_or_an_open_lan_view(self) -> None:
        self.assert_code(self.command(_add(), port=self.main_port), 409, rm.MIRROR_LAN_CLOSED)
        lan_port = self.open_lan(self.server)
        self.assert_code(self.command(_add(), port=lan_port), 409, rm.MIRROR_NO_SOURCE)
        self.publish()
        self.assertEqual(self.command(_add(), port=lan_port)[0], 202)
        self.assert_code(self.command(_add(), port=lan_port), 409, rm.MIRROR_DUPLICATE_ID)

    def test_closing_the_lan_view_clears_the_queue(self) -> None:
        lan_port = self.open_lan(self.server)
        self.publish({**_publish(frame=False), "markers": _markers(2)})
        self.assertEqual(self.command(_add(), port=lan_port)[0], 202)
        self.server.lan.apply({"enabled": False, "port": 0, "bind": "127.0.0.1", "allowed_clients": []})
        self.assert_code(self.status_of(COMMAND_ID, port=self.main_port), 404, rm.MIRROR_UNKNOWN_COMMAND)
        status, _headers, raw = _request(self.main_port, "GET", rm.ROUTE)
        self.assertIsNone(_json(raw)["markers"])
        self.assert_code(self.command(_add("tab-cmd-0002"), port=self.main_port), 409, rm.MIRROR_LAN_CLOSED)
        # Opened again, nothing of before is handed out.
        self.open_lan(self.server)
        self.assertEqual(self.publish()["commands"], [])

    def test_status_reads_follow_the_mirror_s_read_rules(self) -> None:
        lan_port = self.open_lan(self.server)
        self.publish()
        self.command(_add(), port=lan_port)
        for port in (lan_port, self.main_port):
            with self.subTest(port=port):
                self.assert_code(self.status_of("tab-cmd-9999", port=port), 404, rm.MIRROR_UNKNOWN_COMMAND)
                self.assert_code(self.status_of(COMMAND_ID, port=port, headers=[("Sec-Fetch-Site", "cross-site")]), 403, rm.ORIGIN_REJECTED)
        # On loopback, the Receiver's read rule: a rebinding page's Host is refused.
        status, _headers, raw = _request(self.main_port, "GET", f"{rm.MARKERS_ROUTE}/{COMMAND_ID}", host=f"attacker.example:{self.main_port}")
        self.assert_code((status, _json(raw)), 403, rm.ORIGIN_REJECTED)
        # An id outside the command id rule is not a LAN route.
        status, _headers, raw = _request(lan_port, "GET", f"{rm.MARKERS_ROUTE}/short")
        self.assertEqual((status, _json(raw)["code"]), (403, "LAN_READ_ONLY"))

    def test_nothing_else_becomes_writable_on_the_lan_view(self) -> None:
        lan_port = self.open_lan(self.server)
        self.publish()
        origin = ("Origin", f"http://127.0.0.1:{lan_port}")
        for method, path in (
            ("PUT", rm.MARKERS_ROUTE), ("DELETE", rm.MARKERS_ROUTE), ("PATCH", rm.MARKERS_ROUTE),
            ("POST", f"{rm.MARKERS_ROUTE}/{COMMAND_ID}"), ("POST", rm.MARKERS_ROUTE + "/"), ("POST", rm.ROUTE),
            ("POST", "/api/mirror/receiver/commands"), ("POST", "/api/receiver/marker-sets"), ("DELETE", f"{rm.MARKERS_ROUTE}/{COMMAND_ID}"),
        ):
            with self.subTest(method=method, path=path):
                status, headers, answer = _request(lan_port, method, path, [origin, ("Content-Type", "application/json")], json.dumps(_add()).encode("utf-8"))
                self.assertEqual((status, _json(answer)["code"]), (405, "LAN_READ_ONLY"))
                self.assertEqual(headers["allow"], "GET, HEAD")
        # GET of the bare route is not a read route either.
        status, _headers, answer = _request(lan_port, "GET", rm.MARKERS_ROUTE)
        self.assertEqual((status, _json(answer)["code"]), (403, "LAN_READ_ONLY"))
        self.assertEqual(self.publish()["commands"], [])

    def test_the_lan_view_says_it_takes_marker_commands(self) -> None:
        lan_port = self.open_lan(self.server)
        status, _headers, raw = _request(lan_port, "GET", "/api/capabilities")
        body = _json(raw)
        self.assertEqual((status, body["read_only"], body["mirror_markers"], body["access"]), (200, True, True, "lan-view"))

    def test_commands_are_logged_and_status_reads_are_not(self) -> None:
        lan_port = self.open_lan(self.server)
        self.publish()
        mark = len(self.output.getvalue())
        self.command(_add(), port=lan_port)
        self.status_of(COMMAND_ID, port=lan_port)
        logged = self.output.getvalue()[mark:]
        self.assertIn(f'lan 127.0.0.1 "POST {rm.MARKERS_ROUTE} HTTP/1.1" 202', logged)
        self.assertNotIn(f"GET {rm.MARKERS_ROUTE}/", logged)


if __name__ == "__main__":
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    unittest.main()
