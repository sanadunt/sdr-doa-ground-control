"""The position estimate's rough state, unverified rays, ray history and recorded sessions.

doa_position_estimate.py (ROUGH, UNVERIFIED_WEIGHT, rays, the recorder hook),
the monitor's ok=0 rays (sdr_doa_mqtt_monitor.py), estimate_record_store.py
(sessions, prune, CSV and KML) and the GET routes on both listeners.
"""
from __future__ import annotations

import csv
import io
import math
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import doa_position_estimate as estimate  # noqa: E402
import estimate_record_store as ers  # noqa: E402
import lan_access as lan  # noqa: E402
from test_doa_position_estimate import bearing_to, drive, error_m, place, road  # noqa: E402
from test_lan_access import LOOPBACK, _json, _request, _ServerCase  # noqa: E402

KML = "{http://www.opengis.net/kml/2.2}"


class _ListRecorder:
    def __init__(self) -> None:
        self.calls: List[Any] = []

    def record(self, key: str, sample: Dict[str, Any], result: Dict[str, Any]) -> None:
        self.calls.append((key, sample["q"], result["state"]))


FIXTURE = TOOLS_DIR / "fixtures" / "position-estimate" / "drive.json"
CHECKPOINTS = (5, 20, 60, 120)


def fixture_drive() -> Dict[str, Any]:
    """One noisy drive with every third ray unverified, and the estimate after each checkpoint.

    lib/estimateEngine.test.ts plays the same rays through the browser's copy
    and must come to the same answers (frontend/src/lib/estimateEngine.ts).
    """
    import random

    target = place(-1500, 3000)
    rng = random.Random(7)
    samples = []
    points = road(-2500, 0, step=40) + [(0, n) for n in range(40, 1600, 40)] + road(40, 1500, north=1600, step=40)
    for k, (east, north) in enumerate(points[:120]):
        lat, lon = place(east, north)
        bearing = (bearing_to(lat, lon, target) + rng.gauss(0, 4)) % 360.0
        samples.append([1_793_070_000_000 + k * 3000, round(lat, 7), round(lon, 7), round(bearing, 2), 0 if k % 3 == 2 else 1, 433_920_000])
    est = estimate.PositionEstimator(threaded=False)
    checkpoints = []
    for k, (t_ms, lat, lon, bearing, verified, frequency) in enumerate(samples, 1):
        est.add(q=k, t_ms=t_ms, frequency_hz=frequency, bearing_deg=bearing, latitude=lat, longitude=lon, verified=bool(verified))
        if k in CHECKPOINTS:
            view = est.view(0)
            checkpoints.append({key: view[key] for key in ("state", "latitude", "longitude", "radius_m", "stations", "spread_deg",
                                                             "distance_m", "bearing_deg", "samples", "unverified_samples")}
                               | {"after": k})
    return {"samples": samples, "checkpoints": checkpoints}


def write_fixture() -> None:
    import json

    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(fixture_drive(), indent=1) + "\n", encoding="utf-8")


class FixtureTests(unittest.TestCase):
    def test_the_shared_drive_is_what_the_estimator_answers(self) -> None:
        import json

        self.assertEqual(json.loads(FIXTURE.read_text(encoding="utf-8")), fixture_drive(),
                         "rewrite with: .venv/bin/python -c \"import tools.test_estimate_history as t; t.write_fixture()\"")
        states = [point["state"] for point in fixture_drive()["checkpoints"]]
        self.assertIn(estimate.STATE_ROUGH, states)
        self.assertEqual(states[-1], estimate.STATE_ESTIMATE)


class RoughEstimateTests(unittest.TestCase):
    def test_two_places_a_little_apart_give_a_rough_estimate_that_shrinks(self) -> None:
        target = place(-1500, 3000)
        est = estimate.PositionEstimator(threaded=False)
        # 400 m of road: more than one place, a few degrees of spread.
        drive(est, target, road(0, 400))
        rough = est.view(0)
        self.assertEqual(rough["state"], estimate.STATE_ROUGH)
        self.assertGreaterEqual(rough["spread_deg"], estimate.ROUGH_SPREAD_DEG)
        self.assertLess(rough["spread_deg"], estimate.MIN_SPREAD_DEG)
        self.assertIsNotNone(rough["latitude"])
        # The whole road: an estimate, with a smaller radius than the rough one.
        drive(est, target, road(420, 2500), q0=1000)
        final = est.view(0)
        self.assertEqual(final["state"], estimate.STATE_ESTIMATE)
        self.assertLess(final["radius_m"], rough["radius_m"])
        self.assertLess(error_m(final, target), 250)

    def test_method_names_the_thresholds(self) -> None:
        method = estimate.PositionEstimator(threaded=False).view(0)["method"]
        self.assertEqual((method["min_spread_deg"], method["rough_min_stations"], method["rough_spread_deg"]),
                         (estimate.MIN_SPREAD_DEG, estimate.ROUGH_MIN_STATIONS, estimate.ROUGH_SPREAD_DEG))
        self.assertEqual(method["unverified_weight"], estimate.UNVERIFIED_WEIGHT)


class UnverifiedRayTests(unittest.TestCase):
    def test_unverified_rays_count_less_and_are_named(self) -> None:
        target = place(-1500, 3000)
        est = estimate.PositionEstimator(threaded=False)
        lat, lon = place(-2500, 0)
        est.add(q=1, t_ms=1, frequency_hz=1, bearing_deg=bearing_to(lat, lon, target), latitude=lat, longitude=lon,
                verified=False)
        est.add(q=1, t_ms=2, frequency_hz=1, bearing_deg=bearing_to(lat, lon, target), latitude=lat, longitude=lon)
        view = est.view(0)
        # ok=0 and ok=1 count their q apart at the edge, so both are kept.
        self.assertEqual((view["samples"], view["unverified_samples"]), (2, 1))
        self.assertEqual([ray[4] for ray in view["rays"]], [0, 1])
        weights = [s["weight"] for s in est._samples]
        self.assertAlmostEqual(weights[0], estimate.UNVERIFIED_WEIGHT)
        self.assertAlmostEqual(weights[1], 0.5)  # the second sample of the same place

    def test_a_drive_of_unverified_rays_still_finds_it(self) -> None:
        target = place(-1500, 3000)
        est = estimate.PositionEstimator(threaded=False)
        for k, (east, north) in enumerate(road(-2500, 2500), 1):
            lat, lon = place(east, north)
            est.add(q=k, t_ms=k, frequency_hz=1, bearing_deg=bearing_to(lat, lon, target), latitude=lat, longitude=lon,
                    verified=False)
        view = est.view(0)
        self.assertEqual(view["state"], estimate.STATE_ESTIMATE)
        self.assertLess(error_m(view, target), 200)

    def test_rays_are_the_latest_ones_oldest_first(self) -> None:
        target = place(-1500, 3000)
        est = estimate.PositionEstimator(threaded=False)
        drive(est, target, road(-2500, 2500, step=10))
        rays = est.view(0)["rays"]
        self.assertEqual(len(rays), estimate.RAYS_SENT)
        self.assertEqual([r[0] for r in rays], sorted(r[0] for r in rays))
        self.assertEqual(rays[-1][0], est._samples[-1]["t_ms"])


class RecorderTests(unittest.TestCase):
    def test_one_key_per_start(self) -> None:
        recorder = _ListRecorder()
        est = estimate.PositionEstimator(threaded=False, recorder=recorder)
        lat, lon = place(0, 0)
        est.add(q=1, t_ms=1, frequency_hz=433_000_000, bearing_deg=10, latitude=lat, longitude=lon)
        est.add(q=2, t_ms=2, frequency_hz=433_000_000, bearing_deg=10, latitude=lat, longitude=lon)
        est.reset()
        est.add(q=3, t_ms=3, frequency_hz=433_000_000, bearing_deg=10, latitude=lat, longitude=lon)
        est.add(q=4, t_ms=4, frequency_hz=434_000_000, bearing_deg=10, latitude=lat, longitude=lon)
        keys = [call[0] for call in recorder.calls]
        self.assertEqual(len(keys), 4)
        self.assertEqual(keys[0], keys[1])
        self.assertEqual(len(set(keys)), 3)
        # Another estimator (a new MQTT monitor) never shares a key.
        other = _ListRecorder()
        estimate.PositionEstimator(threaded=False, recorder=other).add(
            q=1, t_ms=1, frequency_hz=433_000_000, bearing_deg=10, latitude=lat, longitude=lon)
        self.assertNotIn(other.calls[0][0], keys)

    def test_a_failing_recorder_never_stops_the_estimate(self) -> None:
        class Broken:
            def record(self, *args: Any) -> None:
                raise RuntimeError("disk full")

        est = estimate.PositionEstimator(threaded=False, recorder=Broken())
        target = place(-1500, 3000)
        drive(est, target, road(-2500, 2500))
        self.assertEqual(est.view(0)["state"], estimate.STATE_ESTIMATE)


def _recorded_store(root: Path, **kwargs: Any) -> ers.EstimateRecordStore:
    store = ers.EstimateRecordStore(root, **kwargs)
    est = estimate.PositionEstimator(threaded=False, recorder=store)
    target = place(-1500, 3000)
    drive(est, target, road(-2500, 2500, step=100), frequency=433_920_000)
    return store


class StoreTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_a_session_keeps_every_ray_and_the_last_estimate(self) -> None:
        store = _recorded_store(self.root)
        self.addCleanup(store.close)
        listed = store.sessions()
        self.assertTrue(listed["available"])
        self.assertEqual(len(listed["sessions"]), 1)
        row = listed["sessions"][0]
        self.assertEqual((row["samples"], row["frequency_hz"], row["estimate"]["state"]), (51, 433_920_000, "ESTIMATE"))
        self.assertEqual(listed["current_id"], row["id"])
        session = store.session(row["id"])
        assert session is not None
        self.assertEqual(len(session["samples"]), 51)
        self.assertEqual(session["samples"][0][4], 1)
        self.assertEqual(session["sources"], {"bearing": ["rdf"], "position": ["rdf"]})
        self.assertIsNone(store.session("0" * 32))
        self.assertIsNone(store.session("../etc"))

    def test_sessions_survive_a_restart(self) -> None:
        _recorded_store(self.root).close()
        store = ers.EstimateRecordStore(self.root)
        self.addCleanup(store.close)
        self.assertEqual(store.sessions()["sessions"][0]["samples"], 51)
        self.assertIsNone(store.sessions()["current_id"])

    def test_the_oldest_sessions_go_beyond_the_limit(self) -> None:
        store = ers.EstimateRecordStore(self.root, max_samples=60)
        self.addCleanup(store.close)
        old_prune = ers.PRUNE_EVERY
        ers.PRUNE_EVERY = 10
        self.addCleanup(setattr, ers, "PRUNE_EVERY", old_prune)
        target = place(-1500, 3000)
        for run in range(3):
            est = estimate.PositionEstimator(threaded=False, recorder=store)
            drive(est, target, road(-2500, 2500, step=100), q0=run * 1000)
        sessions = store.sessions()["sessions"]
        self.assertLess(len(sessions), 3)
        self.assertEqual(sessions[0]["samples"], 51)  # the current one is never dropped

    def test_an_unwritable_directory_leaves_the_store_unavailable(self) -> None:
        blocker = self.root / "file"
        blocker.write_text("x")
        logged: List[str] = []
        store = ers.EstimateRecordStore(blocker / "sub", log=logged.append)
        self.assertFalse(store.available)
        store.record("k", {"t_ms": 1, "frequency_hz": 1, "bearing_deg": 1, "latitude": 1, "longitude": 1}, {})
        self.assertEqual(store.sessions(), {"available": False, "sessions": [], "current_id": None})
        self.assertTrue(logged)

    def test_csv_and_kml(self) -> None:
        store = _recorded_store(self.root)
        self.addCleanup(store.close)
        session = store.session(store.sessions()["sessions"][0]["id"])
        assert session is not None
        text = ers.session_csv(session).decode("utf-8")
        rows = list(csv.reader(io.StringIO("\n".join(line for line in text.splitlines() if not line.startswith("#")))))
        self.assertEqual(rows[0][:3], ["time_utc", "t_ms", "frequency_hz"])
        self.assertEqual(len(rows), 52)
        self.assertIn("# estimate_state,ESTIMATE", text)
        root = ET.fromstring(ers.session_kml(session))
        placemarks = root.findall(f".//{KML}Placemark")
        stamps = root.findall(f".//{KML}TimeStamp")
        self.assertEqual(len(stamps), 51)
        names = [p.findtext(f"{KML}name") for p in placemarks]
        self.assertIn("Jalur", names)
        self.assertTrue(any(name and name.startswith("Estimasi ±") for name in names))
        self.assertIn("Radius", names)
        self.assertTrue(ers.export_name(session, "kml").endswith("-433.920MHz.kml"))

    def test_routes(self) -> None:
        sid = "a" * 32
        self.assertEqual(ers.session_route(f"{ers.ROUTE}/{sid}"), {"id": sid, "kind": "session"})
        self.assertEqual(ers.session_route(f"{ers.ROUTE}/{sid}/export.kml"), {"id": sid, "kind": "export.kml"})
        for bad in (f"{ers.ROUTE}/{sid}/export.zip", f"{ers.ROUTE}/{sid[:-1]}", f"{ers.ROUTE}/{sid}/", f"{ers.ROUTE}/A" * 1):
            self.assertIsNone(ers.session_route(bad), bad)
        self.assertEqual(lan.lan_route(ers.ROUTE), lan.ROUTE_ESTIMATE_SESSION)
        self.assertEqual(lan.lan_route(f"{ers.ROUTE}/{sid}/export.csv"), lan.ROUTE_ESTIMATE_SESSION)
        self.assertIsNone(lan.lan_route(f"{ers.ROUTE}/{sid}/delete"))
        self.assertEqual(lan.ESTIMATE_SESSIONS_ROUTE, ers.ROUTE)


class MonitorRayTests(unittest.TestCase):
    def setUp(self) -> None:
        try:
            import sdr_doa_mqtt_monitor as monitor_module
        except ModuleNotFoundError as exc:  # pragma: no cover - without paho
            self.skipTest(str(exc))
        self.monitor = monitor_module.MqttMonitor("127.0.0.1", 1883)
        self.monitor._estimate = estimate.PositionEstimator(threaded=False)

    def doa(self, **fields: Any) -> Dict[str, Any]:
        value = {"q": 7, "t": 1_793_070_000_000, "f": 433_920_000, "a": 200.0, "ok": 0, "h": 30.0,
                 "lat": -6.93, "lon": 107.71, "validation_reasons": ["SOURCE_UNVERIFIED", "ANGLE_UNVERIFIED"]}
        value.update(fields)
        return value

    def test_an_ok0_sample_is_a_weaker_ray_with_h_plus_raw_a(self) -> None:
        self.monitor._on_unverified_doa(self.doa())
        view = self.monitor._estimate.view(0)
        self.assertEqual((view["samples"], view["unverified_samples"]), (1, 1))
        self.assertAlmostEqual(view["rays"][0][3], (30.0 + 200.0) % 360.0)

    def test_other_reasons_are_no_ray(self) -> None:
        for reasons in (["CONTROL_IN_PROGRESS"], ["SOURCE_UNVERIFIED", "DAQ_NOT_HEALTHY"], []):
            self.monitor._on_unverified_doa(self.doa(validation_reasons=reasons))
        self.assertEqual(self.monitor._estimate.view(0)["samples"], 0)

    def test_an_ok0_sample_without_position_is_no_skip_note(self) -> None:
        self.monitor._on_unverified_doa(self.doa(lat=None, lon=None))
        view = self.monitor._estimate.view(0)
        self.assertEqual((view["samples"], view["waiting_for"]), (0, None))


class RouteTests(_ServerCase):
    def test_sessions_on_both_listeners(self) -> None:
        server = self.start_server()
        recorder = server.estimate_records
        est = estimate.PositionEstimator(threaded=False, recorder=recorder)
        drive(est, place(-1500, 3000), road(-2500, 2500, step=100), frequency=433_920_000)
        port = server.server_address[1]
        status, _headers, body = _request(port, "GET", ers.ROUTE)
        self.assertEqual(status, 200)
        sid = _json(body)["sessions"][0]["id"]
        lan_port = self.open_lan(server, LOOPBACK)
        for listener in (port, lan_port):
            status, _headers, body = _request(listener, "GET", f"{ers.ROUTE}/{sid}")
            self.assertEqual(status, 200)
            self.assertEqual(len(_json(body)["samples"]), 51)
            status, headers, body = _request(listener, "GET", f"{ers.ROUTE}/{sid}/export.kml")
            self.assertEqual(status, 200)
            self.assertEqual(headers["content-type"], "application/vnd.google-earth.kml+xml")
            self.assertIn("attachment;", headers["content-disposition"])
            ET.fromstring(body)
            status, headers, _body = _request(listener, "GET", f"{ers.ROUTE}/{sid}/export.csv")
            self.assertEqual((status, headers["content-type"]), (200, "text/csv; charset=utf-8"))
            status, _headers, body = _request(listener, "GET", f"{ers.ROUTE}/{'0' * 32}")
            self.assertEqual((status, _json(body)["code"]), (404, "ESTIMATE_SESSION_NOT_FOUND"))
        # The LAN view writes nothing here.
        status, _headers, _body = _request(lan_port, "POST", f"{ers.ROUTE}/{sid}", body=b"{}")
        self.assertEqual(status, 405)


if __name__ == "__main__":
    unittest.main()
