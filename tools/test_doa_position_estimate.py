"""The transmitter position estimate from a moving node's bearings (tools/doa_position_estimate.py)."""
from __future__ import annotations

import math
import random
import time
import unittest

try:
    from . import doa_position_estimate as estimate
except ImportError:  # pragma: no cover - run from tools/
    import doa_position_estimate as estimate

START = (-6.9298, 107.7114)


def place(east: float, north: float):
    return estimate._lat_lon(START[0], START[1], east, north)


def bearing_to(lat: float, lon: float, target) -> float:
    return estimate._bearing(*estimate._east_north(lat, lon, target[0], target[1]))


def error_m(view, target) -> float:
    return math.hypot(*estimate._east_north(target[0], target[1], view["latitude"], view["longitude"]))


def drive(est, target, points, *, noise=0.0, multipath=0.0, seed=1, frequency=433_000_000, q0=0):
    rng = random.Random(seed)
    for k, (east, north) in enumerate(points, 1):
        lat, lon = place(east, north)
        b = bearing_to(lat, lon, target) + rng.gauss(0, noise)
        if rng.random() < multipath:
            b = rng.uniform(0, 360)
        est.add(q=q0 + k, t_ms=k * 1000, frequency_hz=frequency, bearing_deg=b, latitude=lat, longitude=lon)


def road(start_east, end_east, north=0.0, step=20.0):
    count = int(abs(end_east - start_east) / step)
    return [(start_east + math.copysign(step, end_east - start_east) * k, north) for k in range(count + 1)]


class EstimateTests(unittest.TestCase):
    def test_a_drive_past_the_transmitter_finds_it(self) -> None:
        target = place(-1500, 3000)
        for noise, multipath, limit in ((3, 0.0, 150), (6, 0.15, 250), (10, 0.3, 400)):
            with self.subTest(noise=noise, multipath=multipath):
                est = estimate.PositionEstimator(threaded=False)
                drive(est, target, road(-2500, 2500), noise=noise, multipath=multipath, seed=2)
                view = est.view(0)
                self.assertEqual(view["state"], estimate.STATE_ESTIMATE)
                self.assertLess(error_m(view, target), limit)
                self.assertGreaterEqual(view["spread_deg"], estimate.MIN_SPREAD_DEG)
                # Distance and bearing from the last sample to the estimate.
                last = place(2500, 0)
                self.assertAlmostEqual(view["distance_m"], math.hypot(4000, 3000), delta=limit + 50)
                self.assertAlmostEqual(view["bearing_deg"], bearing_to(*last, target), delta=5)
                self.assertTrue(view["grid"]["hot"])
                self.assertEqual(max(cell[2] for cell in view["grid"]["hot"]), 1.0)

    def test_one_place_gives_no_estimate(self) -> None:
        est = estimate.PositionEstimator(threaded=False)
        lat, lon = place(0, 0)
        for q in range(1, 300):
            est.add(q=q, t_ms=q, frequency_hz=1, bearing_deg=40.0, latitude=lat, longitude=lon)
        view = est.view(0)
        self.assertEqual((view["state"], view["stations"]), (estimate.STATE_NEED_MOVEMENT, 1))

    def test_driving_straight_at_it_is_not_enough(self) -> None:
        target = place(0, 6000)
        est = estimate.PositionEstimator(threaded=False)
        drive(est, target, [(0, n) for n in range(0, 2000, 20)])
        self.assertEqual(est.view(0)["state"], estimate.STATE_NEED_MOVEMENT)

    def test_a_parked_node_does_not_outvote_the_drive(self) -> None:
        target = place(-1500, 3000)
        est = estimate.PositionEstimator(threaded=False)
        # Parked for 10 minutes with a 20 degree wrong bearing (multipath at the parking spot) ...
        lat, lon = place(-2500, 0)
        for q in range(1, 601):
            est.add(q=q, t_ms=q, frequency_hz=1, bearing_deg=bearing_to(lat, lon, target) + 20, latitude=lat, longitude=lon)
        # ... then one pass along the road.
        drive(est, target, road(-2500, 2500), noise=3, frequency=1, q0=1000)
        self.assertLess(error_m(est.view(0), target), 250)

    def test_another_frequency_starts_over(self) -> None:
        target = place(-1500, 3000)
        est = estimate.PositionEstimator(threaded=False)
        drive(est, target, road(-2500, 2500))
        lat, lon = place(0, 0)
        est.add(q=9999, t_ms=1, frequency_hz=433_000_000 + 100_000, bearing_deg=10, latitude=lat, longitude=lon)
        view = est.view(0)
        self.assertEqual((view["samples"], view["state"], view["frequency_hz"]), (1, estimate.STATE_NEED_MOVEMENT, 433_100_000))
        # Within the tolerance it is the same target.
        est.add(q=10000, t_ms=2, frequency_hz=433_100_000 + 20_000, bearing_deg=10, latitude=lat, longitude=lon)
        self.assertEqual(est.view(0)["samples"], 2)

    def test_reset_and_repeated_sample(self) -> None:
        est = estimate.PositionEstimator(threaded=False)
        lat, lon = place(0, 0)
        est.add(q=1, t_ms=1, frequency_hz=1, bearing_deg=10, latitude=lat, longitude=lon)
        est.add(q=1, t_ms=1, frequency_hz=1, bearing_deg=10, latitude=lat, longitude=lon)
        self.assertEqual(est.view(0)["samples"], 1)
        est.reset()
        view = est.view(0)
        self.assertEqual((view["state"], view["samples"], view["reset_reason"], view["grid"]),
                         (estimate.STATE_NO_DATA, 0, "OPERATOR_RESET", None))

    def test_a_skipped_sample_names_what_the_estimate_waits_for(self) -> None:
        est = estimate.PositionEstimator(threaded=False)
        view = est.view(0)
        self.assertEqual((view["waiting_for"], view["skipped"], view["skipped_at_ms"]), (None, 0, None))
        est.skip(estimate.WAITING_NO_BEARING)
        est.skip(estimate.WAITING_NO_POSITION)
        view = est.view(0)
        self.assertEqual((view["waiting_for"], view["skipped"], view["state"]), ("NO_POSITION", 2, estimate.STATE_NO_DATA))
        self.assertIsInstance(view["skipped_at_ms"], int)
        # A reset starts the estimate over, not what the samples lack.
        # The skip count starts over with it.
        est.reset()
        self.assertEqual((est.view(0)["waiting_for"], est.view(0)["skipped"]), ("NO_POSITION", 0))
        est.skip(estimate.WAITING_NO_BEARING)
        self.assertEqual(est.view(0)["skipped"], 1)
        lat, lon = place(0, 0)
        est.add(q=1, t_ms=1, frequency_hz=1, bearing_deg=10, latitude=lat, longitude=lon)
        self.assertEqual((est.view(0)["waiting_for"], est.view(0)["skipped"]), (None, 1))

    def test_the_grid_follows_a_long_drive(self) -> None:
        # The target lies beyond the first grid; driving towards and past it re-centres the grid
        # and the replayed bearings still find it.
        target = place(-9000, 2500)
        est = estimate.PositionEstimator(threaded=False)
        drive(est, target, road(0, -11000, step=40), noise=3)
        view = est.view(0)
        self.assertEqual(view["state"], estimate.STATE_ESTIMATE)
        self.assertLess(error_m(view, target), 250)
        south, west, north, east = (view["grid"][key] for key in ("south", "west", "north", "east"))
        self.assertTrue(south < target[0] < north and west < target[1] < east)

    def test_worker_thread_scores_in_the_background(self) -> None:
        target = place(-1500, 3000)
        est = estimate.PositionEstimator()
        drive(est, target, road(-2500, 2500, step=50))
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and (est.view(0)["pending"] or est.view(0)["samples"] < 101):
            time.sleep(0.05)
        view = est.view(0)
        self.assertEqual((view["samples"], view["state"], view["error"]), (101, estimate.STATE_ESTIMATE, None))
        self.assertLess(error_m(view, target), 300)

    def test_circular_span(self) -> None:
        self.assertEqual(estimate._circular_span([]), 0.0)
        self.assertEqual(estimate._circular_span([350, 10]), 20.0)
        self.assertEqual(estimate._circular_span([0, 90, 180]), 180.0)


if __name__ == "__main__":
    unittest.main()
