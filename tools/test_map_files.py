#!/usr/bin/env python3
"""The offline basemap archive: tools/map_files.py and GET /api/maps/offline.pmtiles.

Every console runs on loopback with temporary files; the archive is a small
file of known bytes, so each range can be compared byte for byte.
"""

from __future__ import annotations

import http.client
import ipaddress
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from unittest.mock import patch

TOOLS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = TOOLS_DIR.parent
for _path in (str(TOOLS_DIR), str(PROJECT_ROOT)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

_SAVED_ADMIN_PASSWORD = os.environ.get("SDR_DOA_ADMIN_PASSWORD")
os.environ["SDR_DOA_ADMIN_PASSWORD"] = "map-files-import-no-secret"
try:
    import ground_console  # noqa: E402
finally:
    if _SAVED_ADMIN_PASSWORD is None:
        os.environ.pop("SDR_DOA_ADMIN_PASSWORD", None)
    else:
        os.environ["SDR_DOA_ADMIN_PASSWORD"] = _SAVED_ADMIN_PASSWORD

import lan_access as lan  # noqa: E402
import map_files  # noqa: E402
from map_files import MAX_RANGE_BYTES, OFFLINE_MAP_ROUTE, MapFiles, parse_range  # noqa: E402

BASE_URL = "http://127.0.0.1:8081"
LOOPBACK = [ipaddress.ip_network("127.0.0.1/32")]


def archive_bytes(size: int = 3000) -> bytes:
    # A repeating, position-dependent pattern: a wrong offset shows at once.
    return bytes((index * 7 + index // 251) % 256 for index in range(size))


class RangeParserTests(unittest.TestCase):
    def test_one_range(self) -> None:
        self.assertEqual(parse_range("bytes=0-99", 1000), ((0, 99), ""))
        self.assertEqual(parse_range("bytes=500-", 1000), ((500, 999), ""))
        self.assertEqual(parse_range("bytes=990-5000", 1000), ((990, 999), ""))
        self.assertEqual(parse_range("bytes=-100", 1000), ((900, 999), ""))
        self.assertEqual(parse_range("bytes=-5000", 1000), ((0, 999), ""))

    def test_an_open_range_is_clamped_to_one_block(self) -> None:
        size = MAX_RANGE_BYTES * 3
        self.assertEqual(parse_range("bytes=0-", size), ((0, MAX_RANGE_BYTES - 1), ""))
        self.assertEqual(parse_range("bytes=10-999999999", size), ((10, 10 + MAX_RANGE_BYTES - 1), ""))

    def test_refusals(self) -> None:
        self.assertEqual(parse_range(None, 1000), (None, "MAP_RANGE_REQUIRED"))
        self.assertEqual(parse_range("  ", 1000), (None, "MAP_RANGE_REQUIRED"))
        for header in ["bytes=0-1,5-6", "bytes=", "bytes=-", "items=0-5", "bytes=5-2", "bytes=1000-", "bytes=2000-3000",
                       "bytes=-0", "bytes=a-b", "bytes=0-5 ", "bytes=0--5", "bytes=" + "9" * 40 + "-"]:
            span, code = parse_range(header, 1000)
            if header == "bytes=0-5 ":
                # Surrounding whitespace is stripped, the range itself is fine.
                self.assertEqual((span, code), ((0, 5), ""))
                continue
            self.assertIsNone(span, header)
            self.assertEqual(code, "MAP_RANGE_INVALID", header)
        self.assertEqual(parse_range("bytes=0-5", 0), (None, "MAP_RANGE_INVALID"))


class MapFilesTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name) / "maps"
        self.maps = MapFiles(self.dir)

    def put(self, data: bytes = b"") -> Path:
        self.dir.mkdir(parents=True, exist_ok=True)
        path = self.dir / "offline.pmtiles"
        path.write_bytes(data or archive_bytes())
        return path

    def test_not_installed(self) -> None:
        self.assertIsNone(self.maps.info())
        result = self.maps.read(OFFLINE_MAP_ROUTE, "bytes=0-9")
        self.assertEqual((result.status, result.code), (404, "MAP_NOT_FOUND"))

    def test_an_empty_file_or_a_directory_or_a_symlink_is_not_installed(self) -> None:
        self.dir.mkdir(parents=True)
        (self.dir / "offline.pmtiles").write_bytes(b"")
        self.assertIsNone(self.maps.info())
        (self.dir / "offline.pmtiles").unlink()
        (self.dir / "offline.pmtiles").mkdir()
        self.assertIsNone(self.maps.info())
        (self.dir / "offline.pmtiles").rmdir()
        target = Path(self._tmp.name) / "elsewhere.pmtiles"
        target.write_bytes(archive_bytes())
        try:
            os.symlink(target, self.dir / "offline.pmtiles")
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are not available here")
        self.assertIsNone(self.maps.info())

    def test_a_range_is_the_file_bytes(self) -> None:
        data = archive_bytes()
        self.put(data)
        result = self.maps.read(OFFLINE_MAP_ROUTE, "bytes=100-299")
        self.assertEqual(result.status, 206)
        self.assertEqual(result.body, data[100:300])
        headers = dict(result.headers)
        self.assertEqual(headers["Content-Range"], f"bytes 100-299/{len(data)}")
        self.assertEqual(headers["Accept-Ranges"], "bytes")
        self.assertTrue(headers["ETag"].startswith('"') and headers["ETag"].endswith('"'))
        tail = self.maps.read(OFFLINE_MAP_ROUTE, f"bytes={len(data) - 10}-")
        self.assertEqual(tail.body, data[-10:])

    def test_other_names_never_reach_the_file_system(self) -> None:
        self.put()
        for route in ["/api/maps/other.pmtiles", "/api/maps/../offline.pmtiles", "/api/maps/offline.pmtiles/", "/api/maps/", "/api/maps",
                      "/api/maps/%2e%2e/offline.pmtiles", "/api/maps/offline.pmtiles%00"]:
            result = self.maps.read(route, "bytes=0-9")
            self.assertEqual((result.status, result.code), (404, "MAP_NOT_FOUND"), route)

    def test_a_replaced_file_has_a_new_etag(self) -> None:
        path = self.put()
        first = self.maps.info()
        path.write_bytes(archive_bytes(5000))
        os.utime(path, ns=(first.mtime_ns + 5_000_000_000, first.mtime_ns + 5_000_000_000))
        second = self.maps.info()
        self.assertNotEqual(first.etag, second.etag)
        self.assertEqual(second.size, 5000)

    def test_a_busy_map_answers_503(self) -> None:
        self.put()
        slots = [self.maps._slots.acquire() for _ in range(map_files.MAX_CONCURRENT_READS)]
        self.addCleanup(lambda: [self.maps._slots.release() for _ in slots])
        original = map_files.READ_SLOT_WAIT_S
        map_files.READ_SLOT_WAIT_S = 0.05
        self.addCleanup(setattr, map_files, "READ_SLOT_WAIT_S", original)
        result = self.maps.read(OFFLINE_MAP_ROUTE, "bytes=0-9")
        self.assertEqual((result.status, result.code), (503, "MAP_BUSY"))


class ConsoleMapRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.data = archive_bytes(9000)

    def start(self, **kwargs: Any) -> Any:
        server = ground_console.GroundConsoleServer(
            ("127.0.0.1", 0),
            BASE_URL,
            config_path=str(self.root / "console.json"),
            branding_path=str(self.root / "branding.json"),
            receiver_data_dir=self.root / "receiver",
            **kwargs,
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def close() -> None:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()

        self.addCleanup(close)
        return server

    def install(self, maps_dir: Optional[Path] = None) -> None:
        directory = maps_dir or (self.root / "maps")
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "offline.pmtiles").write_bytes(self.data)

    @staticmethod
    def get(port: int, path: str, headers: Optional[Dict[str, str]] = None, method: str = "GET") -> Tuple[int, Dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
        try:
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            body = response.read()
            return response.status, {key.lower(): value for key, value in response.getheaders()}, body
        finally:
            connection.close()

    def test_the_default_directory_is_next_to_console_json(self) -> None:
        server = self.start()
        self.assertEqual(server.map_files.maps_dir, self.root / "maps")
        explicit = self.start(maps_dir=self.root / "elsewhere")
        self.assertEqual(explicit.map_files.maps_dir, self.root / "elsewhere")

    def test_a_range_on_loopback(self) -> None:
        self.install()
        server = self.start()
        port = server.server_address[1]
        status, headers, body = self.get(port, OFFLINE_MAP_ROUTE, {"Range": "bytes=1000-1999"})
        self.assertEqual(status, 206)
        self.assertEqual(body, self.data[1000:2000])
        self.assertEqual(headers["content-range"], f"bytes 1000-1999/{len(self.data)}")
        self.assertEqual(headers["content-length"], "1000")
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        self.assertIn("etag", headers)

    def test_refusals_are_json_with_a_code(self) -> None:
        server = self.start()
        port = server.server_address[1]
        status, _headers, body = self.get(port, OFFLINE_MAP_ROUTE, {"Range": "bytes=0-9"})
        self.assertEqual(status, 404)
        self.assertIn(b'"MAP_NOT_FOUND"', body)
        self.install()
        status, headers, body = self.get(port, OFFLINE_MAP_ROUTE)
        self.assertEqual(status, 416)
        self.assertIn(b'"MAP_RANGE_REQUIRED"', body)
        self.assertEqual(headers["content-range"], f"bytes */{len(self.data)}")
        status, _headers, body = self.get(port, OFFLINE_MAP_ROUTE, {"Range": "bytes=0-1,4-5"})
        self.assertEqual(status, 416)
        self.assertIn(b'"MAP_RANGE_INVALID"', body)

    def test_a_cross_site_page_cannot_read_it(self) -> None:
        self.install()
        server = self.start()
        port = server.server_address[1]
        for site in ["cross-site", "same-site"]:
            status, _headers, body = self.get(port, OFFLINE_MAP_ROUTE, {"Range": "bytes=0-9", "Sec-Fetch-Site": site})
            self.assertEqual(status, 403, site)
            self.assertIn(b'"ORIGIN_REJECTED"', body)
        for site in ["same-origin", "none"]:
            status, _headers, _body = self.get(port, OFFLINE_MAP_ROUTE, {"Range": "bytes=0-9", "Sec-Fetch-Site": site})
            self.assertEqual(status, 206, site)

    def test_the_lan_view_serves_it_read_only(self) -> None:
        # The LAN view stays closed while admin login is off or the default.
        patcher = patch.object(ground_console, "ADMIN_PASSWORD", "map-files-test-password")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.install()
        server = self.start()
        status = server.lan.apply({"enabled": True, "port": 0, "bind": "127.0.0.1", "allowed_clients": []}, allowed=LOOPBACK)
        self.assertEqual(status["state"], "open", status)
        port = int(server.lan._server.server_address[1])
        status, headers, body = self.get(port, OFFLINE_MAP_ROUTE, {"Range": "bytes=10-19"})
        self.assertEqual(status, 206)
        self.assertEqual(body, self.data[10:20])
        # Nothing else under /api/maps/ and no write.
        status, _headers, _body = self.get(port, "/api/maps/other.pmtiles", {"Range": "bytes=0-9"})
        self.assertEqual(status, 403)
        status, _headers, _body = self.get(port, "/api/maps/", {"Range": "bytes=0-9"})
        self.assertEqual(status, 403)
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
        try:
            connection.request("PUT", OFFLINE_MAP_ROUTE, body=b"x", headers={"Range": "bytes=0-9"})
            self.assertEqual(connection.getresponse().status, 405)
        finally:
            connection.close()
        # A cross-site request is refused by the LAN view's own Host/Fetch rules.
        status, _headers, _body = self.get(port, OFFLINE_MAP_ROUTE, {"Range": "bytes=0-9", "Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 403)

    def test_the_lan_route_table(self) -> None:
        self.assertEqual(lan.lan_route("/api/maps/offline.pmtiles"), lan.ROUTE_MAP)
        for path in ["/api/maps", "/api/maps/", "/api/maps/offline.pmtiles/", "/api/maps/other.pmtiles", "/api/maps/../x", "/api/maps/offline.pmtiles/x"]:
            self.assertIsNone(lan.lan_route(path), path)
        self.assertEqual(lan.MAP_ROUTE, map_files.OFFLINE_MAP_ROUTE)

    def test_a_served_range_is_not_logged(self) -> None:
        self.install()
        server = self.start()
        port = server.server_address[1]
        handler = ground_console.ConsoleHandler  # type: ignore[attr-defined]
        logged = []
        original = handler.log_message
        handler.log_message = lambda self, fmt, *args: logged.append(fmt % args)  # type: ignore[method-assign]
        try:
            self.get(port, OFFLINE_MAP_ROUTE, {"Range": "bytes=0-9"})
            self.get(port, OFFLINE_MAP_ROUTE)
        finally:
            handler.log_message = original  # type: ignore[method-assign]
        self.assertEqual(len([line for line in logged if "206" in line]), 0, logged)
        self.assertEqual(len([line for line in logged if "416" in line]), 1, logged)

    def test_the_glyph_files_are_served_as_assets(self) -> None:
        frontend = self.root / "dist"
        font = frontend / "assets" / "map-fonts" / "NotoSans-Regular"
        font.mkdir(parents=True)
        (font / "0-255.pbf").write_bytes(b"\x0a\x03abc")
        (frontend / "index.html").write_text("<!doctype html>", encoding="utf-8")
        server = self.start(frontend_dir=frontend)
        port = server.server_address[1]
        status, headers, body = self.get(port, "/assets/map-fonts/NotoSans-Regular/0-255.pbf")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"\x0a\x03abc")
        self.assertEqual(headers["content-type"], "application/x-protobuf")


if __name__ == "__main__":
    unittest.main()
