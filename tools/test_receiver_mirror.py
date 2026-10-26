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

import receiver_mirror as rm  # noqa: E402
from test_lan_access import NOBODY, _json, _request, _ServerCase  # noqa: E402

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
        "scan": {"phase": "idle", "start_hz": 400_000_000, "stop_hz": 500_000_000, "resolution_hz": 4882.8125},
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
        source, state, frame = rm.parse_publish(copy.deepcopy(body))
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
        source, state, frame = rm.parse_publish(copy.deepcopy(body))
        self.assertEqual((source, state, frame), (body["source"], body["state"], body["frame"]))

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
            "frame_stale_ms": 3000, "source_lost_ms": 10000, "heartbeat_ms": 2000,
            "max_bins": 512, "max_body_bytes": 8192, "max_posts_per_s": 12,
        })

    def test_latest_wins_and_ages_follow_the_server_clock(self) -> None:
        self.assertEqual(self.mirror.publish(*rm.parse_publish(_publish(1))), {"rev": 1, "frame_rev": 1})
        self.clock.now += 1.25
        # A state-only post (a heartbeat) keeps the frame and its age.
        self.assertEqual(self.mirror.publish(*rm.parse_publish(_publish(2, frame=False))), {"rev": 2, "frame_rev": 1})
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

    def test_clear_forgets_everything_but_the_counters(self) -> None:
        self.mirror.publish(*rm.parse_publish(_publish(1)))
        self.mirror.clear()
        view = self.mirror.view()
        self.assertEqual((view["source"], view["state"], view["frame"], view["source_age_ms"]), (None, None, None, None))
        self.assertEqual((view["rev"], view["frame_rev"]), (1, 1))


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
        self.assertEqual((status, answer), (200, {"ok": True, "rev": 1, "frame_rev": 1}))
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

    def test_served_answers_are_not_logged_and_refusals_are(self) -> None:
        self.open_lan(self.server, allowed=NOBODY)
        mark = len(self.output.getvalue())
        self.post(_publish())
        self.get()
        self.assertNotIn(rm.ROUTE, self.output.getvalue()[mark:])
        self.post({"v": 1})
        self.assertIn(f'"POST {rm.ROUTE} HTTP/1.1" 400', self.output.getvalue()[mark:])

    def test_the_receiver_read_rule_is_unchanged_on_the_lan_view(self) -> None:
        lan_port = self.open_lan(self.server)
        status, _headers, body = _request(lan_port, "GET", "/api/receiver/archive/facets")
        self.assertEqual((status, _json(body)["code"]), (403, "LAN_READ_ONLY"))


if __name__ == "__main__":
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    unittest.main()
