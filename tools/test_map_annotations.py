"""Map annotations: the store, its strict request schema, and the route on both listeners."""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List, Tuple
from unittest import mock

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import lan_access as lan  # noqa: E402
import map_annotations as man  # noqa: E402
from test_lan_access import _json, _request, _ServerCase  # noqa: E402

AREA = [[107.66, -6.93], [107.67, -6.93], [107.67, -6.94]]


def _item(**overrides: Any) -> Dict[str, Any]:
    item = {"kind": "area", "category": "nogo", "color": "#e5484d", "name": "Sungai", "note": "Jangan lewat", "geometry": AREA}
    item.update(overrides)
    return item


def _body(payload: Dict[str, Any]) -> bytes:
    return json.dumps(payload).encode("utf-8")


class SchemaTests(unittest.TestCase):
    def test_a_create_is_normalised(self) -> None:
        request = man.decode_request(_body({"v": 1, "op": "create", "item": _item(name="  Sungai  ", geometry=[[107.123456789, -6.9], [107.2, -6.9], [107.2, -7]])}))
        self.assertEqual(request["op"], "create")
        self.assertEqual(request["item"]["name"], "Sungai")
        self.assertEqual(request["item"]["geometry"][0], [107.1234568, -6.9])
        point = man.decode_request(_body({"v": 1, "op": "create", "item": _item(kind="point", category="suspect", color="#f08a24", geometry=[107.66, -6.93])}))
        self.assertEqual(point["item"]["geometry"], [107.66, -6.93])

    def test_every_bad_request_is_refused_by_name(self) -> None:
        cases = [
            b"not json", b"[]", b'{"v":1,"op":"create","item":{},"item":{}}', b'{"v":1,"op":"create","item":NaN}',
            _body({"v": 2, "op": "create", "item": _item()}),
            _body({"v": True, "op": "create", "item": _item()}),
            _body({"v": 1, "op": "move", "item": _item()}),
            _body({"v": 1, "op": "create", "item": _item(), "extra": 1}),
            _body({"v": 1, "op": "create", "id": "a" * 32, "item": _item()}),
            _body({"v": 1, "op": "create", "item": _item(kind="line")}),
            _body({"v": 1, "op": "create", "item": _item(category="enemy")}),
            _body({"v": 1, "op": "create", "item": _item(color="#123456")}),
            _body({"v": 1, "op": "create", "item": _item(name="")}),
            _body({"v": 1, "op": "create", "item": _item(name="x" * 65)}),
            _body({"v": 1, "op": "create", "item": _item(note="x" * 501)}),
            _body({"v": 1, "op": "create", "item": _item(name="a\x01b")}),
            _body({"v": 1, "op": "create", "item": _item(geometry=AREA[:2])}),
            _body({"v": 1, "op": "create", "item": _item(geometry=[[107, -6]] * 201)}),
            _body({"v": 1, "op": "create", "item": _item(geometry=[[181, 0], [0, 0], [0, 1]])}),
            _body({"v": 1, "op": "create", "item": _item(geometry=[[True, 0], [0, 0], [0, 1]])}),
            _body({"v": 1, "op": "create", "item": _item(kind="point", geometry=[107])}),
            _body({"v": 1, "op": "create", "item": {**_item(), "rev": 3}}),
            _body({"v": 1, "op": "update", "id": "xyz", "rev": 1, "item": _item()}),
            _body({"v": 1, "op": "update", "id": "a" * 32, "rev": 0, "item": _item()}),
            _body({"v": 1, "op": "update", "id": "a" * 32, "rev": True, "item": _item()}),
            _body({"v": 1, "op": "delete", "id": "a" * 32, "rev": 1, "item": _item()}),
            "{\"v\":1,\"op\":\"create\",\"item\":\"\udcff\"}".encode("utf-8", "surrogatepass"),
        ]
        for raw in cases:
            with self.subTest(raw=raw[:80]):
                with self.assertRaises(man.AnnotationRejected) as caught:
                    man.decode_request(raw)
                self.assertEqual(caught.exception.code, man.ANNOTATION_INVALID)


class StoreTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="sdr-doa-annotations-")
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / man.FILE_NAME
        self.logs: List[str] = []
        self.now = [1_000]
        self.mono = [10.0]
        self.store = self.make()

    def make(self) -> man.AnnotationStore:
        return man.AnnotationStore(self.path, log=self.logs.append, clock_ms=lambda: self.now[0], monotonic=lambda: self.mono[0])

    def create(self, store: man.AnnotationStore, **overrides: Any) -> Dict[str, Any]:
        return store.apply(man.decode_request(_body({"v": 1, "op": "create", "item": _item(**overrides)})), "groundstation")

    def test_create_update_delete_with_revisions(self) -> None:
        created = self.create(self.store)
        item = created["item"]
        self.assertEqual((created["rev"], item["rev"], item["by"], item["created_ms"]), (1, 1, "groundstation", 1_000))
        self.assertRegex(item["id"], r"^[0-9a-f]{32}$")
        self.now[0] = 2_000
        updated = self.store.apply(man.decode_request(_body({"v": 1, "op": "update", "id": item["id"], "rev": 1, "item": _item(name="Sungai Cikapundung", color="#ffffff")})), "tablet 192.168.1.20")
        self.assertEqual((updated["rev"], updated["item"]["rev"], updated["item"]["name"], updated["item"]["by"]), (2, 2, "Sungai Cikapundung", "tablet 192.168.1.20"))
        self.assertEqual((updated["item"]["created_ms"], updated["item"]["updated_ms"]), (1_000, 2_000))
        deleted = self.store.apply(man.decode_request(_body({"v": 1, "op": "delete", "id": item["id"], "rev": 2})), "groundstation")
        self.assertEqual((deleted["rev"], deleted["item"], deleted["id"]), (3, None, item["id"]))
        self.assertEqual(self.store.snapshot()["items"], [])

    def test_a_stale_revision_is_a_conflict_with_the_current_item(self) -> None:
        item = self.create(self.store)["item"]
        self.store.apply(man.decode_request(_body({"v": 1, "op": "update", "id": item["id"], "rev": 1, "item": _item(name="B")})), "groundstation")
        for payload in ({"v": 1, "op": "update", "id": item["id"], "rev": 1, "item": _item(name="C")}, {"v": 1, "op": "delete", "id": item["id"], "rev": 1}):
            with self.assertRaises(man.AnnotationRejected) as caught:
                self.store.apply(man.decode_request(_body(payload)), "tablet")
            self.assertEqual(caught.exception.code, man.ANNOTATION_CONFLICT)
            self.assertEqual(caught.exception.item["name"], "B")
        with self.assertRaises(man.AnnotationRejected) as caught:
            self.store.apply(man.decode_request(_body({"v": 1, "op": "delete", "id": "b" * 32, "rev": 1})), "tablet")
        self.assertEqual(caught.exception.code, man.ANNOTATION_NOT_FOUND)

    def test_since_answers_unchanged_and_the_set_is_bounded(self) -> None:
        self.assertEqual(self.store.snapshot(0), {"ok": True, "rev": 0, "unchanged": True})
        self.create(self.store)
        self.assertEqual(len(self.store.snapshot(0)["items"]), 1)
        self.assertTrue(self.store.snapshot(1)["unchanged"])
        with mock.patch.object(man, "MAX_ITEMS", 1):
            with self.assertRaises(man.AnnotationRejected) as caught:
                self.create(self.store)
        self.assertEqual(caught.exception.code, man.ANNOTATION_LIMIT)

    def test_it_survives_a_restart_in_a_0600_file(self) -> None:
        item = self.create(self.store, kind="point", category="suspect", color="#f08a24", geometry=[107.66, -6.93])["item"]
        reloaded = self.make()
        self.assertEqual(reloaded.snapshot()["items"], [item])
        self.assertEqual(reloaded.snapshot()["rev"], 1)
        if os.name == "posix":
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_a_corrupt_file_is_kept_aside_and_the_store_starts_empty(self) -> None:
        self.path.write_text("{broken", encoding="utf-8")
        store = self.make()
        self.assertEqual(store.snapshot()["items"], [])
        self.assertEqual((self.path.parent / (man.FILE_NAME + ".invalid.bak")).read_text(encoding="utf-8"), "{broken")
        self.assertTrue(any("not a valid annotations file" in line for line in self.logs))

    def test_a_failed_write_changes_nothing(self) -> None:
        item = self.create(self.store)["item"]
        with mock.patch.object(man.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(man.AnnotationRejected) as caught:
                self.create(self.store)
        self.assertEqual(caught.exception.code, man.ANNOTATION_STORE_FAILED)
        self.assertEqual(self.store.snapshot()["items"], [item])
        self.assertEqual(self.store.snapshot()["rev"], 1)

    def test_writes_are_limited_per_client_and_second(self) -> None:
        for _ in range(man.WRITES_PER_S):
            self.assertTrue(self.store.admit_write("192.168.1.20"))
        self.assertFalse(self.store.admit_write("192.168.1.20"))
        self.assertTrue(self.store.admit_write("192.168.1.21"))
        self.mono[0] += 1.0
        self.assertTrue(self.store.admit_write("192.168.1.20"))


class RouteTests(_ServerCase):
    def lan_call(self, port: int, method: str, path: str, payload: Any = None, *, origin: bool = True) -> Tuple[int, Dict[str, Any]]:
        headers = [("Origin", f"http://127.0.0.1:{port}")] if origin else []
        body = None if payload is None else _body(payload)
        status, _headers, raw = _request(port, method, path, headers, body)
        return status, (_json(raw) if raw else {})

    def test_the_groundstation_page_creates_reads_and_conflicts(self) -> None:
        server = self.start_server()
        status, created = self.main_request(server, "POST", man.ROUTE, {"v": 1, "op": "create", "item": _item()})
        self.assertEqual(status, 200, created)
        self.assertEqual(created["item"]["by"], "groundstation")
        self.assertTrue((self.root / man.FILE_NAME).is_file())
        status, listing = self.main_request(server, "GET", man.ROUTE, origin=False)
        self.assertEqual((status, listing["rev"], len(listing["items"])), (200, 1, 1))
        self.assertEqual(listing["limits"], man.limits_view())
        status, unchanged = self.main_request(server, "GET", f"{man.ROUTE}?since=1", origin=False)
        self.assertEqual(unchanged, {"ok": True, "rev": 1, "unchanged": True})
        item = created["item"]
        self.main_request(server, "POST", man.ROUTE, {"v": 1, "op": "update", "id": item["id"], "rev": 1, "item": _item(name="B")})
        status, conflict = self.main_request(server, "POST", man.ROUTE, {"v": 1, "op": "delete", "id": item["id"], "rev": 1})
        self.assertEqual((status, conflict["code"], conflict["item"]["name"]), (409, man.ANNOTATION_CONFLICT, "B"))
        status, capabilities = self.main_request(server, "GET", "/api/capabilities", origin=False)
        self.assertIs(capabilities["map_annotations"], True)

    def test_the_loopback_rules_hold(self) -> None:
        server = self.start_server()
        port = server.server_address[1]
        status, refused = self.main_request(server, "POST", man.ROUTE, {"v": 1, "op": "create", "item": _item()}, origin=False)
        self.assertEqual((status, refused["code"]), (403, man.ORIGIN_REJECTED))
        status, _headers, raw = _request(port, "POST", man.ROUTE, [("Origin", "http://evil.example")], _body({"v": 1, "op": "create", "item": _item()}))
        self.assertEqual(status, 403)
        status, _headers, raw = _request(port, "GET", man.ROUTE, [("Sec-Fetch-Site", "cross-site")])
        self.assertEqual((status, _json(raw)["code"]), (403, man.ORIGIN_REJECTED))
        status, _headers, raw = _request(port, "GET", man.ROUTE, host="attacker.example:80")
        self.assertEqual(status, 403)
        big = _body({"v": 1, "op": "create", "item": _item(note="x" * 400)}) + b" " * man.MAX_BODY_BYTES
        status, _headers, raw = _request(port, "POST", man.ROUTE, [("Origin", f"http://127.0.0.1:{port}")], big)
        self.assertEqual((status, _json(raw)["code"]), (413, man.ANNOTATION_TOO_LARGE))
        status, bad = self.main_request(server, "POST", man.ROUTE, {"v": 1, "op": "create", "item": _item(color="red")})
        self.assertEqual((status, bad["code"]), (400, man.ANNOTATION_INVALID))
        for _ in range(man.WRITES_PER_S):
            self.main_request(server, "POST", man.ROUTE, {"v": 1, "op": "create", "item": _item()})
        status, limited = self.main_request(server, "POST", man.ROUTE, {"v": 1, "op": "create", "item": _item()})
        self.assertEqual((status, limited["code"]), (429, man.ANNOTATION_RATE_LIMITED))

    def test_a_tablet_reads_and_writes_on_the_lan_view(self) -> None:
        server = self.start_server()
        lan_port = self.open_lan(server)
        status, created = self.lan_call(lan_port, "POST", man.ROUTE, {"v": 1, "op": "create", "item": _item(kind="point", category="suspect", color="#f08a24", geometry=[107.66, -6.93])})
        self.assertEqual(status, 200, created)
        self.assertEqual(created["item"]["by"], "tablet 127.0.0.1")
        status, listing = self.lan_call(lan_port, "GET", man.ROUTE, origin=False)
        self.assertEqual((status, len(listing["items"])), (200, 1))
        # The groundstation page sees the tablet's marker and can remove it.
        item = created["item"]
        status, deleted = self.main_request(server, "POST", man.ROUTE, {"v": 1, "op": "delete", "id": item["id"], "rev": item["rev"]})
        self.assertEqual((status, deleted["item"]), (200, None))
        status, capabilities = self.lan_call(lan_port, "GET", "/api/capabilities", origin=False)
        self.assertIs(capabilities["map_annotations"], True)

    def test_the_lan_view_opens_nothing_else(self) -> None:
        server = self.start_server()
        lan_port = self.open_lan(server)
        status, refused = self.lan_call(lan_port, "POST", man.ROUTE, {"v": 1, "op": "create", "item": _item()}, origin=False)
        self.assertEqual((status, refused["code"]), (403, man.ORIGIN_REJECTED))
        status, _headers, _raw = _request(lan_port, "POST", man.ROUTE, [("Origin", "http://192.168.1.99:8788")], _body({"v": 1, "op": "create", "item": _item()}))
        self.assertEqual(status, 403)
        for method in ("PUT", "DELETE"):
            status, _headers, _raw = _request(lan_port, method, man.ROUTE, [("Origin", f"http://127.0.0.1:{lan_port}")], _body({}))
            self.assertEqual(status, 405, method)
        status, _headers, _raw = _request(lan_port, "POST", man.ROUTE + "/x", [("Origin", f"http://127.0.0.1:{lan_port}")], _body({}))
        self.assertEqual(status, 405)
        self.assertIn(("POST", man.ROUTE), lan.WRITE_ROUTES)
        self.assertEqual(lan.MAP_ANNOTATIONS_ROUTE, man.ROUTE)
        self.assertIn(man.ROUTE, lan.API_ROUTES)

    def test_a_tablet_dropped_by_a_save_writes_nothing(self) -> None:
        server = self.start_server()
        lan_port = self.open_lan(server)
        old_listener = server.lan._server
        self.open_lan(server)  # a save replaces the listener
        with self.assertRaises(man.AnnotationRejected) as caught:
            server.lan.while_open(old_listener, lambda: None)
        self.assertEqual(caught.exception.code, man.LAN_CLOSED)
        self.assertIsNot(old_listener, server.lan._server)
        self.assertGreater(lan_port, 0)


class BrowserContractTests(unittest.TestCase):
    def test_the_page_repeats_the_server_limits_and_codes(self) -> None:
        source = (TOOLS.parent / "frontend" / "src" / "lib" / "mapAnnotations.ts").read_text(encoding="utf-8")
        block = re.search(r"export const MAP_ANNOTATION_LIMITS = \{(.*?)\} as const;", source, re.S)
        assert block is not None
        numbers = dict(re.findall(r"(\w+): (\d+),", block.group(1)))
        expected = {key: value for key, value in man.limits_view().items() if isinstance(value, int)}
        self.assertEqual({key: int(value) for key, value in numbers.items()}, {
            "maxItems": expected["max_items"], "maxBodyBytes": expected["max_body_bytes"], "nameMax": expected["name_max"],
            "noteMax": expected["note_max"], "areaMinVertices": expected["area_min_vertices"],
            "areaMaxVertices": expected["area_max_vertices"], "writesPerS": expected["writes_per_s"],
        })
        self.assertEqual(re.findall(r"'(#[0-9a-f]{6})'", re.search(r"export const MAP_ANNOTATION_COLORS = \[(.*?)\]", source, re.S).group(1)), list(man.COLORS))
        for category, color in man.CATEGORY_COLORS.items():
            self.assertRegex(source, rf"{category}: '{color}'")
        for code in man.ERROR_CODES_HTTP:
            self.assertIn(f"'{code}'", source, code)


if __name__ == "__main__":
    unittest.main()
