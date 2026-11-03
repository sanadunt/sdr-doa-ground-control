#!/usr/bin/env python3
"""The drone in the console: /api/drone, the video service's health, the WHEP proxy,
the drone block of /api/snapshot and console.json, on both listeners."""

from __future__ import annotations

import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import drone_video as dv  # noqa: E402
import ground_console  # noqa: E402
import lan_access as lan  # noqa: E402
from drone_link import DroneStore  # noqa: E402
from test_lan_access import BASE_URL, _json, _request, _ServerCase  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "drone" / "bridge-payloads.json"
OFFER = b"v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n"
ANSWER = b"v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=answer\r\n"
PATHS_OK = {"items": [
    {"name": "raw", "ready": True, "tracks": ["H265"], "bytesReceived": 1000, "readers": [{"type": "rtspSession"}]},
    {"name": "drone", "ready": True, "tracks": ["H264"], "bytesReceived": 900, "readers": [{"type": "webRTCSession"}, {"type": "webRTCSession"}]},
]}


class FakeMediamtx:
    """mediamtx's API and WHEP endpoint on one loopback port."""

    def __init__(self) -> None:
        self.paths: Any = PATHS_OK
        self.whep_status = 201
        self.requests: List[Dict[str, Any]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def _reply(self, status: int, body: bytes, headers: Optional[Dict[str, str]] = None) -> None:
                self.send_response(status)
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:
                outer.requests.append({"method": "GET", "path": self.path})
                if self.path == "/v3/paths/list":
                    self._reply(200, json.dumps(outer.paths).encode())
                else:
                    self._reply(404, b"")

            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                outer.requests.append({"method": "POST", "path": self.path, "body": body,
                                       "type": self.headers.get("Content-Type")})
                if self.path == "/drone/whep" and outer.whep_status == 201:
                    self._reply(201, ANSWER, {"Content-Type": "application/sdp", "Location": "/drone/whep/abc-123", "ETag": '"x1"'})
                else:
                    self._reply(outer.whep_status if self.path == "/drone/whep" else 404, b"no stream")

            def do_DELETE(self) -> None:
                outer.requests.append({"method": "DELETE", "path": self.path})
                self._reply(200 if self.path == "/drone/whep/abc-123" else 404, b"")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class FakeService:
    """A DroneService with a filled store and a fixed yaw history."""

    def __init__(self, settings: Dict[str, Any], on_found: Any = None) -> None:
        self.settings = settings
        self.on_found = on_found
        self.started = False
        self.stopped = False
        self.store = DroneStore()
        payloads = json.loads(FIXTURE.read_text(encoding="utf-8"))
        payloads.pop("_comment")
        for topic, payload in payloads.items():
            self.store.ingest(topic, json.dumps(payload).encode(), 1_000)

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.stopped = True

    def heading_at(self, t_ms: int) -> Optional[Dict[str, Any]]:
        return {"deg": 87.3, "offset_ms": abs(t_ms - 1_000), "source": "attitude"} if abs(t_ms - 1_000) <= 1_000 else None

    def view(self, now_ms: Optional[int] = None) -> Dict[str, Any]:
        view = self.store.view(1_200)
        view.update({"enabled": True, "host": "192.168.1.162", "port": 1883, "connection": "connected",
                     "last_error": None, "discovery": {"mode": "auto", "scanning": False, "last_scan_at_ms": 5,
                                                         "candidates": []},
                     "array_heading_offset_deg": 0.0, "video_enabled": True})
        return view


class DroneServerCase(_ServerCase):
    def setUp(self) -> None:
        super().setUp()
        self.mediamtx = FakeMediamtx()
        self.addCleanup(self.mediamtx.close)
        self.services: List[FakeService] = []

    def start_drone_server(self, drone: Optional[Dict[str, Any]] = None) -> Any:
        config: Dict[str, Any] = {"version": 1, "base_url": BASE_URL, "mqtt_host": ""}
        if drone is not None:
            config["drone"] = drone
        (self.root / "console.json").write_text(json.dumps(config), encoding="utf-8")

        def factory(settings: Dict[str, Any], on_found: Any = None) -> FakeService:
            service = FakeService(settings, on_found)
            self.services.append(service)
            return service

        server = ground_console.GroundConsoleServer(
            ("127.0.0.1", 0),
            BASE_URL,
            config_path=str(self.root / "console.json"),
            branding_path=str(self.root / "branding.json"),
            frontend_dir=self.frontend,
            receiver_data_dir=self.root / "receiver",
            tile_cache_dir=self.root / "tiles",
            drone_service_factory=factory,
            drone_video=dv.VideoService(self.mediamtx.url, self.mediamtx.url),
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def close() -> None:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()

        self.addCleanup(close)
        return server

    def sdp_request(self, port: int, method: str, path: str, body: Optional[bytes] = OFFER, *,
                    origin: Optional[str] = "default", content_type: str = "application/sdp", host: str = "default"):
        headers = []
        if origin == "default":
            origin = f"http://127.0.0.1:{port}"
        if origin is not None:
            headers.append(("Origin", origin))
        if body is not None:
            headers.append(("Content-Type", content_type))
        return _request(port, method, path, headers, body, host=host)


class DroneRouteTests(DroneServerCase):
    def test_api_drone_on_loopback(self) -> None:
        server = self.start_drone_server()
        self.assertTrue(self.services[0].started)
        status, body = self.main_request(server, "GET", "/api/drone", origin=False)
        self.assertEqual(status, 200)
        self.assertEqual(body["state"], "LIVE")
        self.assertEqual(body["gps"]["rtk"], "FIXED")
        self.assertEqual(body["host"], "192.168.1.162")
        self.assertIsNone(body["heading_at_doa"])

    def test_snapshot_carries_drone_with_the_yaw_at_the_doa_sample(self) -> None:
        server = self.start_drone_server()
        answer = {"doa_candidates": {"mqtt": {"available": True, "timestamp_ms": 1_400}}}
        with mock.patch.object(server.data_out, "snapshot", return_value=answer):
            body = server.collect_snapshot(BASE_URL)
        self.assertEqual(body["drone"]["heading_at_doa"], {
            "deg": 87.3, "offset_ms": 400, "source": "attitude", "doa_timestamp_ms": 1_400, "candidate": "mqtt",
        })
        self.assertIn("ground_gps", body)
        self.assertNotIn("drone", answer)
        # A DoA too far from every yaw sample gets none.
        with mock.patch.object(server.data_out, "snapshot", return_value={"doa_candidates": {"mqtt": {"available": True, "timestamp_ms": 9_000}}}):
            self.assertIsNone(server.collect_snapshot(BASE_URL)["drone"]["heading_at_doa"])
        # The CSV view's sample when MQTT has none.
        csv = {"doa_candidates": {"mqtt": {"available": False}, "csv": {"available": True, "timestamp_ms": 1_000}}}
        with mock.patch.object(server.data_out, "snapshot", return_value=csv):
            self.assertEqual(server.collect_snapshot(BASE_URL)["drone"]["heading_at_doa"]["candidate"], "csv")

    def test_without_a_factory_the_drone_is_off(self) -> None:
        server = self.start_server()
        status, body = self.main_request(server, "GET", "/api/drone", origin=False)
        self.assertEqual(status, 200)
        self.assertEqual((body["state"], body["connection"], body["enabled"]), ("DISABLED", "disabled", False))
        status, body = self.main_request(server, "GET", "/api/drone/video", origin=False)
        self.assertEqual((body["state"], body["reason"]), ("DISABLED", "NOT_CONFIGURED"))

    def test_config_has_the_drone_block_and_a_save_restarts_the_link(self) -> None:
        server = self.start_drone_server()
        status, config = self.main_request(server, "GET", "/api/console-config", origin=False)
        self.assertEqual(config["drone"], {"enabled": True, "host": "auto", "port": 1883,
                                           "array_heading_offset_deg": 0.0, "video_enabled": True, "last_host": None})
        status, body = self.main_request(server, "POST", "/api/console-config", {"drone": {"host": "192.168.1.162"}})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["drone"]["host"], "192.168.1.162")
        for _ in range(50):
            if len(self.services) == 2:
                break
            threading.Event().wait(0.02)
        self.assertEqual(self.services[1].settings["host"], "192.168.1.162")
        self.assertTrue(self.services[0].stopped)
        saved = json.loads((self.root / "console.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["drone"]["host"], "192.168.1.162")
        # The offset alone changes no link.
        status, body = self.main_request(server, "POST", "/api/console-config", {"drone": {"array_heading_offset_deg": -12.5}})
        self.assertEqual(body["drone"]["array_heading_offset_deg"], -12.5)
        threading.Event().wait(0.1)
        self.assertEqual(len(self.services), 2)

    def test_bad_drone_settings_are_refused(self) -> None:
        server = self.start_drone_server()
        for drone in ({"host": "remote.local"}, {"port": 0}, {"array_heading_offset_deg": 200},
                      {"enabled": "yes"}, {"colour": "red"}, "auto"):
            status, body = self.main_request(server, "POST", "/api/console-config", {"drone": drone})
            self.assertEqual(status, 400, drone)
            self.assertIn("drone", body["error"])

    def test_found_host_is_saved(self) -> None:
        server = self.start_drone_server()
        self.services[0].on_found("10.139.8.61")
        saved = json.loads((self.root / "console.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["drone"]["last_host"], "10.139.8.61")
        self.assertEqual(server.get_config()["drone"]["last_host"], "10.139.8.61")
        self.assertEqual(len(self.services), 1)

    def test_invalid_saved_drone_block_loads_as_the_default(self) -> None:
        server = self.start_drone_server(drone={"host": 5})
        self.assertEqual(server.get_config()["drone"]["host"], "auto")


class VideoHealthTests(DroneServerCase):
    def test_states(self) -> None:
        server = self.start_drone_server()
        port = server.server_address[1]
        status, _headers, raw = _request(port, "GET", "/api/drone/video")
        body = _json(raw)
        self.assertEqual((status, body["state"], body["readers"], body["tracks"]), (200, "OK", 2, ["H264"]))
        server.drone_video._cached = None
        self.mediamtx.paths = {"items": [{"name": "raw", "ready": True}, {"name": "drone", "ready": False}]}
        self.assertEqual(server.drone_video.health()["state"], "NO_ENCODER")
        server.drone_video._cached = None
        self.mediamtx.paths = {"items": [{"name": "raw", "ready": False}]}
        self.assertEqual(server.drone_video.health()["state"], "NO_CAMERA")
        server.drone_video._cached = None
        self.mediamtx.paths = "garbage"
        self.assertEqual(server.drone_video.health()["state"], "NO_CAMERA")

    def test_service_down(self) -> None:
        service = dv.VideoService("http://127.0.0.1:9", "http://127.0.0.1:9")
        view = service.health()
        self.assertEqual((view["state"], view["reason"]), ("DOWN", "SERVICE_UNREACHABLE"))
        with self.assertRaises(dv.VideoError) as caught:
            service.whep_offer(OFFER)
        self.assertEqual((caught.exception.status, caught.exception.code), (502, dv.VIDEO_UNAVAILABLE))

    def test_turned_off(self) -> None:
        server = self.start_drone_server(drone={"video_enabled": False})
        port = server.server_address[1]
        body = _json(_request(port, "GET", "/api/drone/video")[2])
        self.assertEqual((body["state"], body["reason"]), ("DISABLED", "TURNED_OFF"))
        status, _h, raw = self.sdp_request(port, "POST", dv.WHEP_ROUTE)
        self.assertEqual((status, _json(raw)["code"]), (503, dv.VIDEO_DISABLED))

    def test_health_is_read_at_most_once_a_second(self) -> None:
        now = [0.0]
        service = dv.VideoService(self.mediamtx.url, self.mediamtx.url, clock=lambda: now[0])
        service.health()
        service.health()
        now[0] = 1.5
        service.health()
        self.assertEqual(len([r for r in self.mediamtx.requests if r["path"] == "/v3/paths/list"]), 2)


class WhepProxyTests(DroneServerCase):
    def test_offer_is_passed_on_and_location_rewritten(self) -> None:
        server = self.start_drone_server()
        port = server.server_address[1]
        status, headers, raw = self.sdp_request(port, "POST", dv.WHEP_ROUTE)
        self.assertEqual(status, 201)
        self.assertEqual(raw, ANSWER)
        self.assertEqual(headers["content-type"], "application/sdp")
        self.assertEqual(headers["location"], "/api/drone/video/whep/abc-123")
        self.assertEqual(headers["etag"], '"x1"')
        sent = [r for r in self.mediamtx.requests if r["method"] == "POST"][0]
        self.assertEqual((sent["path"], sent["body"], sent["type"]), ("/drone/whep", OFFER, "application/sdp"))
        status, _h, raw = self.sdp_request(port, "DELETE", "/api/drone/video/whep/abc-123", body=None)
        self.assertEqual((status, _json(raw)), (200, {"ok": True}))
        status, _h, raw = self.sdp_request(port, "DELETE", "/api/drone/video/whep/gone-1", body=None)
        self.assertEqual((status, _json(raw)["code"]), (404, dv.VIDEO_UNKNOWN_SESSION))

    def test_no_stream_yet(self) -> None:
        server = self.start_drone_server()
        self.mediamtx.whep_status = 404
        status, _h, raw = self.sdp_request(server.server_address[1], "POST", dv.WHEP_ROUTE)
        self.assertEqual((status, _json(raw)["code"]), (503, dv.VIDEO_NO_STREAM))

    def test_refusals(self) -> None:
        server = self.start_drone_server()
        port = server.server_address[1]
        status, _h, raw = self.sdp_request(port, "POST", dv.WHEP_ROUTE, origin="http://example.com")
        self.assertEqual((status, _json(raw)["code"]), (403, dv.ORIGIN_REJECTED))
        status, _h, raw = self.sdp_request(port, "POST", dv.WHEP_ROUTE, origin=None)
        self.assertEqual(status, 403)
        status, _h, raw = self.sdp_request(port, "POST", dv.WHEP_ROUTE, content_type="application/json")
        self.assertEqual((status, _json(raw)["code"]), (415, dv.VIDEO_INVALID))
        status, _h, raw = self.sdp_request(port, "POST", dv.WHEP_ROUTE, body=b"hello")
        self.assertEqual((status, _json(raw)["code"]), (400, dv.VIDEO_INVALID))
        status, _h, raw = self.sdp_request(port, "POST", dv.WHEP_ROUTE, body=b"v=0" + b"x" * (dv.MAX_SDP_BYTES + 1))
        self.assertEqual((status, _json(raw)["code"]), (413, dv.VIDEO_TOO_LARGE))
        self.assertEqual([r for r in self.mediamtx.requests if r["method"] == "POST"], [])


class LanViewTests(DroneServerCase):
    def test_lan_view_reads_and_plays_the_drone(self) -> None:
        server = self.start_drone_server()
        port = self.open_lan(server)
        status, _h, raw = _request(port, "GET", "/api/drone")
        self.assertEqual((status, _json(raw)["state"]), (200, "LIVE"))
        status, _h, raw = _request(port, "GET", "/api/drone/video")
        self.assertEqual((status, _json(raw)["state"]), (200, "OK"))
        status, headers, raw = self.sdp_request(port, "POST", dv.WHEP_ROUTE)
        self.assertEqual((status, raw, headers["location"]), (201, ANSWER, "/api/drone/video/whep/abc-123"))
        status, _h, raw = self.sdp_request(port, "DELETE", "/api/drone/video/whep/abc-123", body=None)
        self.assertEqual(status, 200)

    def test_lan_view_refuses_another_origin_and_every_other_write(self) -> None:
        server = self.start_drone_server()
        port = self.open_lan(server)
        status, _h, raw = self.sdp_request(port, "POST", dv.WHEP_ROUTE, origin="http://127.0.0.1:1")
        self.assertEqual((status, _json(raw)["code"]), (403, dv.ORIGIN_REJECTED))
        status, _h, raw = self.sdp_request(port, "DELETE", "/api/drone/video/whep/bad%20id", body=None)
        self.assertEqual((status, _json(raw)["code"]), (405, lan.LAN_READ_ONLY))
        status, _h, raw = self.sdp_request(port, "POST", "/api/console-config", body=b"{}", content_type="application/json")
        self.assertEqual(status, 405)
        status, _h, raw = self.sdp_request(port, "PUT", dv.WHEP_ROUTE)
        self.assertEqual(status, 405)

    def test_write_rule(self) -> None:
        self.assertTrue(lan.write_allowed("POST", dv.WHEP_ROUTE))
        self.assertTrue(lan.write_allowed("DELETE", dv.WHEP_ROUTE + "/abc-123"))
        self.assertFalse(lan.write_allowed("DELETE", dv.WHEP_ROUTE))
        self.assertFalse(lan.write_allowed("DELETE", dv.WHEP_ROUTE + "/a/b"))
        self.assertFalse(lan.write_allowed("POST", dv.WHEP_ROUTE + "/abc"))
        self.assertEqual(lan.DRONE_WHEP_ROUTE, dv.WHEP_ROUTE)


if __name__ == "__main__":
    unittest.main()
