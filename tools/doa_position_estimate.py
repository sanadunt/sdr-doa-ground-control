"""Transmitter position estimate from the bearings of a moving RDF-SDR.

Contract 1.10 stamps every ``telemetry/doa`` with the bearing ``b`` (array
heading turned into degrees from north) and the position ``lat``/``lon`` it was
taken at. One sample is a ray; the estimate is where the rays of many places
agree, the way the KrakenSDR app does it: a square grid around the first sample
(``GRID_SIZE_M``, ``GRID_CELLS`` per side) in a local east/north plane, every
cell raised by how close it lies to each ray (a Gaussian of the angle,
``BEARING_SIGMA_DEG``), the hottest cell the estimate. Bad bearings (multipath,
blocked paths) spread thin; good ones pile up where they cross.

A single place cannot give a distance: all of its rays start at one point. The
estimate counts as one only when rays from at least ``MIN_STATIONS`` places
``STATION_M`` apart cross it from directions ``MIN_SPREAD_DEG`` or more apart
(``NEED_MOVEMENT`` until then). A parked node does not outvote the drive: the
n-th sample of one place weighs 1/n.

The grid moves with the node: a sample in the outer quarter re-centres it on
that sample and replays the kept samples (``HISTORY``). Work runs on one worker
thread, so a replay never holds up the MQTT callback that feeds ``add()``.
This is an aid for finding a transmitter, not a measured position.

The RDF-SDR flies inside the drone, so the monitor takes the drone's own
position (RTK) and yaw at the sample's time first (``bearing_source`` and
``position_source`` ``drone``), and the edge's ``b`` and ``lat``/``lon`` only
where the drone has none (``rdf``). A sample with neither bearing nor position
is no ray. The monitor reports it with ``skip()``, and the view names what the
estimate waits for (``waiting_for``) until a usable sample comes.

``with_ground()`` adds the distance and bearing from the groundstation's own
GNSS (``ground_gps.py``) to the estimate, at answer time.
"""
from __future__ import annotations

import math
import queue
import threading
import time
from array import array
from collections import deque
from typing import Any, Deque, Dict, List, Mapping, Optional, Tuple

GRID_SIZE_M = 10_000.0
GRID_CELLS = 100
BEARING_SIGMA_DEG = 6.0
# Cells further than this from a ray (in angle) are not touched by it.
BEARING_CUTOFF_DEG = 3 * BEARING_SIGMA_DEG
STATION_M = 50.0
MIN_STATIONS = 3
MIN_SPREAD_DEG = 15.0
# Another target: a sample this far off the estimate's frequency starts over.
FREQUENCY_TOLERANCE_HZ = 25_000
HISTORY = 1500
# Cells sent for the map: the hottest ones, down to this share of the peak.
MAP_CELLS = 800
MAP_FLOOR = 0.2
EARTH_R = 6_371_000.0

STATE_NO_DATA = "NO_DATA"
STATE_NEED_MOVEMENT = "NEED_MOVEMENT"
STATE_ESTIMATE = "ESTIMATE"
# Why the latest LIVE sample was no ray (``waiting_for``).
WAITING_NO_BEARING = "NO_BEARING"
WAITING_NO_POSITION = "NO_POSITION"
# Where a sample's bearing and position came from.
SOURCE_DRONE = "drone"
SOURCE_RDF = "rdf"


def _east_north(lat0: float, lon0: float, lat: float, lon: float) -> Tuple[float, float]:
    """Metres east and north of (lat0, lon0); equirectangular, well under 1% over the grid's 10 km."""
    east = math.radians((lon - lon0 + 540.0) % 360.0 - 180.0) * math.cos(math.radians(lat0)) * EARTH_R
    north = math.radians(lat - lat0) * EARTH_R
    return east, north


def _lat_lon(lat0: float, lon0: float, east: float, north: float) -> Tuple[float, float]:
    lat = lat0 + math.degrees(north / EARTH_R)
    lon = lon0 + math.degrees(east / (EARTH_R * math.cos(math.radians(lat0))))
    return lat, (lon + 540.0) % 360.0 - 180.0


def _bearing(east: float, north: float) -> float:
    return math.degrees(math.atan2(east, north)) % 360.0


def _angle_diff(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


class _Grid:
    """Activation grid around (lat0, lon0)."""

    def __init__(self, lat0: float, lon0: float) -> None:
        self.lat0 = lat0
        self.lon0 = lon0
        self.cell = GRID_SIZE_M / GRID_CELLS
        half = GRID_SIZE_M / 2.0
        # Cell centres, east then north, row-major by north.
        self.centres = [(-half + (i + 0.5) * self.cell, -half + (j + 0.5) * self.cell)
                        for j in range(GRID_CELLS) for i in range(GRID_CELLS)]
        self.values = array("d", bytes(8 * GRID_CELLS * GRID_CELLS))

    def contains_inner(self, east: float, north: float) -> bool:
        limit = GRID_SIZE_M / 4.0  # beyond it the sample is within a quarter of the grid's size from the edge
        return abs(east) <= limit and abs(north) <= limit

    def add_ray(self, east: float, north: float, bearing: float, weight: float) -> None:
        sigma2 = 2.0 * BEARING_SIGMA_DEG * BEARING_SIGMA_DEG
        values = self.values
        near = self.cell
        b = math.radians(bearing)
        sin_b, cos_b = math.sin(b), math.cos(b)
        cutoff = math.radians(BEARING_CUTOFF_DEG)
        for index, (cx, cy) in enumerate(self.centres):
            dx = cx - east
            dy = cy - north
            # Along the ray (behind it the angle is over 90 degrees) and not the ray's own cell.
            along = dx * sin_b + dy * cos_b
            if along <= near:
                continue
            across = dx * cos_b - dy * sin_b
            angle = math.atan2(abs(across), along)
            if angle > cutoff:
                continue
            degrees = math.degrees(angle)
            values[index] += weight * math.exp(-degrees * degrees / sigma2)


class PositionEstimator:
    """Bearings in (``add``), one estimate out (``view``); safe to call from any thread."""

    def __init__(self, *, threaded: bool = True) -> None:
        self._lock = threading.Lock()
        self._queue: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue(maxsize=600)
        self._threaded = threaded
        self._worker: Optional[threading.Thread] = None
        self._generation = 0
        self._dropped = 0
        self._waiting_for: Optional[str] = None
        self._skipped = 0
        self._skipped_at_ms: Optional[int] = None
        self._clear("STARTED")

    # -- input ------------------------------------------------------------

    def add(self, *, q: int, t_ms: int, frequency_hz: int, bearing_deg: float, latitude: float, longitude: float,
            confidence_db: Optional[float] = None, heading_source: Optional[str] = None,
            bearing_source: str = SOURCE_RDF, position_source: str = SOURCE_RDF) -> None:
        """Queue one LIVE sample; the worker scores it."""
        sample = {"q": q, "t_ms": t_ms, "frequency_hz": frequency_hz, "bearing_deg": bearing_deg % 360.0,
                  "latitude": latitude, "longitude": longitude, "confidence_db": confidence_db,
                  "heading_source": heading_source, "bearing_source": bearing_source,
                  "position_source": position_source, "generation": self._generation}
        with self._lock:
            self._waiting_for = None
        if not self._threaded:
            self._process(sample)
            return
        self._ensure_worker()
        try:
            self._queue.put_nowait(sample)
        except queue.Full:
            with self._lock:
                self._dropped += 1

    def skip(self, reason: str) -> None:
        """A LIVE sample that is no ray: ``WAITING_NO_BEARING`` or ``WAITING_NO_POSITION``."""
        with self._lock:
            self._waiting_for = reason
            self._skipped += 1
            self._skipped_at_ms = int(time.time() * 1000)

    def reset(self, reason: str = "OPERATOR_RESET") -> None:
        with self._lock:
            self._generation += 1
            # Skips are counted since the last reset; what samples lack stays.
            self._skipped = 0
            self._clear(reason)

    # -- output -----------------------------------------------------------

    def view(self, now_ms: int) -> Dict[str, Any]:
        with self._lock:
            result = dict(self._result)
            result["pending"] = self._queue.qsize()
            result["dropped"] = self._dropped
            # What the latest LIVE sample lacked (null once one is used), how
            # many were skipped and when the last one was.
            result["waiting_for"] = self._waiting_for
            result["skipped"] = self._skipped
            result["skipped_at_ms"] = self._skipped_at_ms
            result["age_ms"] = None if result.get("updated_at_ms") is None else max(0, now_ms - result["updated_at_ms"])
            return result

    # -- worker -----------------------------------------------------------

    def _ensure_worker(self) -> None:
        if self._worker is not None and self._worker.is_alive():
            return
        self._worker = threading.Thread(target=self._run, name="doa-position-estimate", daemon=True)
        self._worker.start()

    def _run(self) -> None:
        while True:
            sample = self._queue.get()
            if sample is None:
                return
            try:
                self._process(sample)
            except Exception as exc:  # a bad sample never stops the estimate
                with self._lock:
                    self._result["error"] = type(exc).__name__

    def _clear(self, reason: str) -> None:
        self._grid: Optional[_Grid] = None
        self._samples: Deque[Dict[str, Any]] = deque(maxlen=HISTORY)
        self._stations: Dict[Tuple[int, int], int] = {}
        self._frequency: Optional[int] = None
        self._last_q: Optional[int] = None
        self._result: Dict[str, Any] = {
            "state": STATE_NO_DATA, "reset_reason": reason, "reset_at_ms": int(time.time() * 1000),
            "frequency_hz": None, "samples": 0, "stations": 0, "spread_deg": None,
            "latitude": None, "longitude": None, "radius_m": None, "peak_share": None,
            "node_latitude": None, "node_longitude": None, "distance_m": None, "bearing_deg": None,
            "bearing_source": None, "position_source": None, "drone_samples": 0,
            "grid": None, "updated_at_ms": None, "error": None,
            "method": {"grid_size_m": GRID_SIZE_M, "grid_cells": GRID_CELLS, "bearing_sigma_deg": BEARING_SIGMA_DEG,
                       "min_stations": MIN_STATIONS, "min_spread_deg": MIN_SPREAD_DEG, "station_m": STATION_M},
        }

    def _process(self, sample: Dict[str, Any]) -> None:
        with self._lock:
            if sample["generation"] != self._generation:
                return  # queued before a reset
            if self._last_q is not None and sample["q"] == self._last_q:
                return
            if (self._frequency is not None and
                    abs(sample["frequency_hz"] - self._frequency) > FREQUENCY_TOLERANCE_HZ):
                self._generation += 1
                self._clear("FREQUENCY_CHANGED")
                sample["generation"] = self._generation
            self._last_q = sample["q"]
            if self._frequency is None:
                self._frequency = sample["frequency_hz"]
            grid = self._grid
            if grid is None:
                grid = _Grid(sample["latitude"], sample["longitude"])
            east, north = _east_north(grid.lat0, grid.lon0, sample["latitude"], sample["longitude"])
            replay = not grid.contains_inner(east, north)
            if replay:
                grid = _Grid(sample["latitude"], sample["longitude"])
            history = list(self._samples) if replay else []
            weight = self._weight(sample)
            sample["weight"] = weight
            self._samples.append(sample)
        # Scoring happens outside the lock, so view() never waits on it.
        for old in history:
            ox, oy = _east_north(grid.lat0, grid.lon0, old["latitude"], old["longitude"])
            grid.add_ray(ox, oy, old["bearing_deg"], old["weight"])
        sx, sy = _east_north(grid.lat0, grid.lon0, sample["latitude"], sample["longitude"])
        grid.add_ray(sx, sy, sample["bearing_deg"], weight)
        with self._lock:
            if sample["generation"] != self._generation:
                return
            if replay or self._grid is None:
                # The replay ran on a new grid; samples that came meanwhile are
                # scored on it by the worker after this one, in order.
                self._grid = grid
            self._result = self._summarize(grid, sample)

    def _weight(self, sample: Dict[str, Any]) -> float:
        # Stations on a fixed lattice (STATION_M), independent of where the grid sits.
        lat, lon = sample["latitude"], sample["longitude"]
        key_lat = round(math.radians(lat) * EARTH_R / STATION_M)
        key_lon = round(math.radians(lon) * EARTH_R * math.cos(math.radians(lat)) / STATION_M)
        key = (key_lat, key_lon)
        count = self._stations.get(key, 0) + 1
        self._stations[key] = count
        return 1.0 / count

    def _summarize(self, grid: _Grid, latest: Dict[str, Any]) -> Dict[str, Any]:
        values = grid.values
        result = dict(self._result)
        result.update(frequency_hz=self._frequency, samples=len(self._samples), stations=len(self._stations),
                      node_latitude=latest["latitude"], node_longitude=latest["longitude"],
                      bearing_source=latest.get("bearing_source"), position_source=latest.get("position_source"),
                      drone_samples=sum(1 for s in self._samples if s.get("bearing_source") == SOURCE_DRONE),
                      updated_at_ms=int(time.time() * 1000), error=None, reset_reason=None)
        peak_index = max(range(len(values)), key=values.__getitem__)
        peak = values[peak_index]
        if peak <= 0.0:
            result.update(state=STATE_NO_DATA, grid=None, latitude=None, longitude=None, radius_m=None,
                          distance_m=None, bearing_deg=None, spread_deg=None, peak_share=None)
            return result
        # Weighted centre of the cells near the peak that are within 80% of it.
        px, py = grid.centres[peak_index]
        total = sx = sy = 0.0
        hot = 0
        for index, value in enumerate(values):
            if value >= 0.5 * peak:
                hot += 1
            if value >= 0.8 * peak:
                cx, cy = grid.centres[index]
                if abs(cx - px) <= 3 * grid.cell and abs(cy - py) <= 3 * grid.cell:
                    total += value
                    sx += value * cx
                    sy += value * cy
        ex, ey = sx / total, sy / total
        lat, lon = _lat_lon(grid.lat0, grid.lon0, ex, ey)
        # How far apart the places that saw it are, as seen from the estimate.
        directions: List[float] = []
        seen = set()
        for sample in self._samples:
            ox, oy = _east_north(grid.lat0, grid.lon0, sample["latitude"], sample["longitude"])
            key = (round(ox / STATION_M), round(oy / STATION_M))
            if key in seen:
                continue
            seen.add(key)
            directions.append(_bearing(ox - ex, oy - ey))
        spread = _circular_span(directions)
        nx, ny = _east_north(grid.lat0, grid.lon0, latest["latitude"], latest["longitude"])
        ready = len(seen) >= MIN_STATIONS and spread >= MIN_SPREAD_DEG
        cells = sorted(((value, index) for index, value in enumerate(values) if value >= MAP_FLOOR * peak),
                       reverse=True)[:MAP_CELLS]
        half = GRID_SIZE_M / 2.0
        south_west = _lat_lon(grid.lat0, grid.lon0, -half, -half)
        north_east = _lat_lon(grid.lat0, grid.lon0, half, half)
        result.update(
            state=STATE_ESTIMATE if ready else STATE_NEED_MOVEMENT,
            stations=len(seen),
            spread_deg=round(spread, 1),
            latitude=round(lat, 6), longitude=round(lon, 6),
            radius_m=round(math.sqrt(hot * grid.cell * grid.cell / math.pi)),
            peak_share=round(peak / max(1e-9, sum(s["weight"] for s in self._samples)), 3),
            distance_m=round(math.hypot(ex - nx, ey - ny)),
            bearing_deg=round(_bearing(ex - nx, ey - ny), 1),
            grid={
                "cells": GRID_CELLS, "cell_m": grid.cell,
                "south": round(south_west[0], 6), "west": round(south_west[1], 6),
                "north": round(north_east[0], 6), "east": round(north_east[1], 6),
                # [column east, row north, share of the peak]
                "hot": [[index % GRID_CELLS, index // GRID_CELLS, round(value / peak, 3)] for value, index in cells],
            },
        )
        return result


def with_ground(estimate: Dict[str, Any], ground: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    """The estimate with the distance and bearing from the groundstation (``ground_*``), null without a fix."""
    result = dict(estimate)
    result.update(ground_latitude=None, ground_longitude=None, ground_distance_m=None, ground_bearing_deg=None)
    lat, lon = estimate.get("latitude"), estimate.get("longitude")
    if ground is None or ground.get("state") != "FIX" or lat is None or lon is None:
        return result
    glat, glon = ground.get("lat"), ground.get("lon")
    if not isinstance(glat, (int, float)) or not isinstance(glon, (int, float)):
        return result
    east, north = _east_north(glat, glon, lat, lon)
    result.update(ground_latitude=glat, ground_longitude=glon, ground_distance_m=round(math.hypot(east, north)),
                  ground_bearing_deg=round(_bearing(east, north), 1))
    return result


def _circular_span(directions: List[float]) -> float:
    """Smallest arc (degrees) that holds every direction; 0 for fewer than two."""
    if len(directions) < 2:
        return 0.0
    ordered = sorted(d % 360.0 for d in directions)
    gaps = [ordered[i + 1] - ordered[i] for i in range(len(ordered) - 1)] + [360.0 - ordered[-1] + ordered[0]]
    return 360.0 - max(gaps)


__all__ = [
    "PositionEstimator", "SOURCE_DRONE", "SOURCE_RDF", "STATE_ESTIMATE", "STATE_NEED_MOVEMENT", "STATE_NO_DATA",
    "WAITING_NO_BEARING", "WAITING_NO_POSITION", "with_ground",
]
