"""Recorded position-estimate sessions: every ray the estimate took, for replay and reports.

The position estimate (doa_position_estimate.py) hands every sample it scored
to ``record()`` with its key (one key per estimator and start: a reset, a new
frequency or a new MQTT monitor starts another session) and the estimate after
it. Sessions and their rays are kept in ``estimates.sqlite3`` next to the
Receiver records (``--data-dir``), so they survive a restart; the oldest
sessions go once more than ``MAX_SAMPLES`` rays are kept.

Reads are ``sessions()`` (the list, newest first, each with its last
estimate), ``session()`` (one session with its rays, for the browser's replay)
and the exports ``session_csv()`` and ``session_kml()`` (Google Earth: the
drone's path, every ray with its time, and the last estimate with its radius).
Nothing here is sent anywhere; the console serves it on GET routes only.
Stdlib only.
"""
from __future__ import annotations

import csv
import io
import math
import re
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional
from xml.sax.saxutils import escape

FILE_NAME = "estimates.sqlite3"
ROUTE = "/api/position-estimate/sessions"
MAX_SAMPLES = 500_000
MAX_SESSIONS_LISTED = 200
MAX_SESSION_SAMPLES = 20_000
PRUNE_EVERY = 500
SESSION_ID_RE = re.compile(r"[0-9a-f]{32}")
EXPORTS = ("export.csv", "export.kml")
EARTH_R = 6_371_000.0
# A ray in the KML reaches past the estimate (or this far without one).
KML_RAY_DEFAULT_M = 3000.0
KML_RAY_MIN_M = 1000.0
KML_RAY_MAX_M = 10_000.0

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_ms INTEGER NOT NULL,
    last_ms INTEGER NOT NULL,
    frequency_hz INTEGER,
    samples INTEGER NOT NULL DEFAULT 0,
    unverified INTEGER NOT NULL DEFAULT 0,
    state TEXT,
    latitude REAL,
    longitude REAL,
    radius_m REAL,
    stations INTEGER,
    spread_deg REAL,
    distance_m REAL
);
CREATE TABLE IF NOT EXISTS samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    t_ms INTEGER NOT NULL,
    frequency_hz INTEGER,
    bearing_deg REAL NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    verified INTEGER NOT NULL,
    bearing_source TEXT,
    position_source TEXT,
    confidence_db REAL
);
CREATE INDEX IF NOT EXISTS samples_session ON samples (session_id, id);
"""


def session_route(path: str) -> Optional[Dict[str, str]]:
    """``{"id", "kind"}`` for ROUTE/<id>, ROUTE/<id>/export.csv or .kml; None otherwise."""
    prefix = ROUTE + "/"
    if not path.startswith(prefix):
        return None
    parts = path[len(prefix):].split("/")
    if not SESSION_ID_RE.fullmatch(parts[0]):
        return None
    if len(parts) == 1:
        return {"id": parts[0], "kind": "session"}
    if len(parts) == 2 and parts[1] in EXPORTS:
        return {"id": parts[0], "kind": parts[1]}
    return None


def _number(value: Any) -> Optional[float]:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


class EstimateRecordStore:
    """SQLite store of estimate sessions; safe to call from any thread."""

    def __init__(self, data_dir: Path, *, clock: Callable[[], float] = time.time,
                 max_samples: int = MAX_SAMPLES, log: Optional[Callable[[str], None]] = None) -> None:
        self._lock = threading.Lock()
        self._clock = clock
        self._max_samples = max_samples
        self._log = log
        self._keys: Dict[str, str] = {}
        self._since_prune = 0
        self._failed = False
        self._db: Optional[sqlite3.Connection] = None
        try:
            Path(data_dir).mkdir(parents=True, exist_ok=True)
            self._db = sqlite3.connect(str(Path(data_dir) / FILE_NAME), check_same_thread=False, isolation_level=None)
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.executescript(_SCHEMA)
        except (OSError, sqlite3.Error) as exc:
            self._report(f"estimate records unavailable: {type(exc).__name__}: {exc}")
            self._db = None

    def _report(self, message: str) -> None:
        if self._log is not None:
            self._log(message)

    @property
    def available(self) -> bool:
        return self._db is not None

    def close(self) -> None:
        with self._lock:
            if self._db is not None:
                self._db.close()
                self._db = None

    # -- writes -----------------------------------------------------------

    def record(self, key: str, sample: Mapping[str, Any], estimate: Mapping[str, Any]) -> None:
        """One scored sample of the estimator session ``key`` and the estimate after it."""
        with self._lock:
            db = self._db
            if db is None:
                return
            try:
                session_id = self._keys.get(key)
                t_ms = int(sample["t_ms"])
                if session_id is None:
                    session_id = uuid.uuid4().hex
                    self._keys = {key: session_id}  # an older key never comes back
                    db.execute("INSERT INTO sessions (id, started_ms, last_ms, frequency_hz) VALUES (?, ?, ?, ?)",
                               (session_id, t_ms, t_ms, int(sample["frequency_hz"])))
                verified = 1 if sample.get("verified", True) else 0
                db.execute("BEGIN")
                db.execute(
                    "INSERT INTO samples (session_id, t_ms, frequency_hz, bearing_deg, latitude, longitude, verified,"
                    " bearing_source, position_source, confidence_db) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (session_id, t_ms, int(sample["frequency_hz"]), float(sample["bearing_deg"]),
                     float(sample["latitude"]), float(sample["longitude"]), verified,
                     sample.get("bearing_source"), sample.get("position_source"), _number(sample.get("confidence_db"))))
                db.execute(
                    "UPDATE sessions SET last_ms = MAX(last_ms, ?), samples = samples + 1, unverified = unverified + ?,"
                    " state = ?, latitude = ?, longitude = ?, radius_m = ?, stations = ?, spread_deg = ?, distance_m = ?"
                    " WHERE id = ?",
                    (t_ms, 1 - verified, estimate.get("state"), _number(estimate.get("latitude")),
                     _number(estimate.get("longitude")), _number(estimate.get("radius_m")),
                     estimate.get("stations"), _number(estimate.get("spread_deg")),
                     _number(estimate.get("distance_m")), session_id))
                db.execute("COMMIT")
                self._failed = False
                self._since_prune += 1
                if self._since_prune >= PRUNE_EVERY:
                    self._since_prune = 0
                    self._prune_locked(db, session_id)
            except (sqlite3.Error, KeyError, TypeError, ValueError) as exc:
                try:
                    db.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                if not self._failed:  # one line per outage, not one per sample
                    self._failed = True
                    self._report(f"estimate record failed: {type(exc).__name__}: {exc}")

    def _prune_locked(self, db: sqlite3.Connection, current: str) -> None:
        """Drop the oldest sessions (never the current one) while more than max_samples rays are kept."""
        total = db.execute("SELECT COUNT(*) FROM samples").fetchone()[0]
        while total > self._max_samples:
            row = db.execute("SELECT id, samples FROM sessions WHERE id != ? ORDER BY started_ms LIMIT 1",
                             (current,)).fetchone()
            if row is None:
                return
            db.execute("BEGIN")
            db.execute("DELETE FROM samples WHERE session_id = ?", (row[0],))
            db.execute("DELETE FROM sessions WHERE id = ?", (row[0],))
            db.execute("COMMIT")
            total -= row[1]

    # -- reads ------------------------------------------------------------

    @staticmethod
    def _session_row(row: sqlite3.Row) -> Dict[str, Any]:
        (sid, started, last, frequency, samples, unverified, state, lat, lon, radius, stations, spread, distance) = row
        return {
            "id": sid, "started_ms": started, "last_ms": last, "frequency_hz": frequency,
            "samples": samples, "unverified": unverified,
            "estimate": {"state": state, "latitude": lat, "longitude": lon, "radius_m": radius,
                         "stations": stations, "spread_deg": spread, "distance_m": distance},
        }

    _COLUMNS = ("id, started_ms, last_ms, frequency_hz, samples, unverified, state, latitude, longitude, radius_m,"
                " stations, spread_deg, distance_m")

    def sessions(self, limit: int = MAX_SESSIONS_LISTED) -> Dict[str, Any]:
        with self._lock:
            if self._db is None:
                return {"available": False, "sessions": [], "current_id": None}
            rows = self._db.execute(f"SELECT {self._COLUMNS} FROM sessions ORDER BY started_ms DESC LIMIT ?",
                                    (int(limit),)).fetchall()
            current = next(iter(self._keys.values()), None)
        return {"available": True, "sessions": [self._session_row(row) for row in rows], "current_id": current}

    def session(self, session_id: str) -> Optional[Dict[str, Any]]:
        """One session with its rays (oldest first), or None."""
        with self._lock:
            if self._db is None or not SESSION_ID_RE.fullmatch(session_id):
                return None
            row = self._db.execute(f"SELECT {self._COLUMNS} FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if row is None:
                return None
            samples = self._db.execute(
                "SELECT t_ms, frequency_hz, bearing_deg, latitude, longitude, verified, bearing_source, position_source,"
                " confidence_db FROM samples WHERE session_id = ? ORDER BY id LIMIT ?",
                (session_id, MAX_SESSION_SAMPLES)).fetchall()
        result = self._session_row(row)
        # [t_ms, latitude, longitude, bearing_deg, verified 1/0, frequency_hz]: compact for the replay.
        result["samples"] = [[t, round(lat, 7), round(lon, 7), round(bearing, 2), verified, frequency]
                             for t, frequency, bearing, lat, lon, verified, _bs, _ps, _c in samples]
        result["truncated"] = len(samples) >= MAX_SESSION_SAMPLES
        result["sources"] = {"bearing": sorted({s[6] for s in samples if s[6]}),
                             "position": sorted({s[7] for s in samples if s[7]})}
        return result


# -- exports ----------------------------------------------------------------

def _iso(t_ms: int) -> str:
    return datetime.fromtimestamp(t_ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def export_name(session: Mapping[str, Any], extension: str) -> str:
    started = datetime.fromtimestamp(session["started_ms"] / 1000.0, tz=timezone.utc).strftime("%Y%m%d-%H%M%S")
    frequency = session.get("frequency_hz")
    mhz = f"-{frequency / 1e6:.3f}MHz" if isinstance(frequency, (int, float)) else ""
    return f"estimasi-{started}Z{mhz}.{extension}"


def session_csv(session: Mapping[str, Any]) -> bytes:
    """One row per ray, then the last estimate as comment lines; UTF-8 with a header."""
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(["time_utc", "t_ms", "frequency_hz", "latitude", "longitude", "bearing_deg", "verified"])
    for t_ms, lat, lon, bearing, verified, frequency in session["samples"]:
        writer.writerow([_iso(t_ms), t_ms, frequency, f"{lat:.7f}", f"{lon:.7f}", f"{bearing:.2f}", verified])
    estimate = session["estimate"]
    out.write(f"# estimate_state,{estimate.get('state') or ''}\n")
    if estimate.get("latitude") is not None and estimate.get("longitude") is not None:
        out.write(f"# estimate_latitude,{estimate['latitude']:.6f}\n# estimate_longitude,{estimate['longitude']:.6f}\n")
        if estimate.get("radius_m") is not None:
            out.write(f"# estimate_radius_m,{estimate['radius_m']:.0f}\n")
    out.write(f"# stations,{estimate.get('stations') or 0}\n# rays,{len(session['samples'])}\n")
    return out.getvalue().encode("utf-8")


def _destination(lat: float, lon: float, bearing: float, distance_m: float) -> List[float]:
    phi, lam = math.radians(lat), math.radians(lon)
    theta, delta = math.radians(bearing), distance_m / EARTH_R
    phi2 = math.asin(math.sin(phi) * math.cos(delta) + math.cos(phi) * math.sin(delta) * math.cos(theta))
    lam2 = lam + math.atan2(math.sin(theta) * math.sin(delta) * math.cos(phi), math.cos(delta) - math.sin(phi) * math.sin(phi2))
    return [math.degrees(phi2), (math.degrees(lam2) + 540.0) % 360.0 - 180.0]


def _distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(a)))


def _coords(points: List[List[float]]) -> str:
    return " ".join(f"{lon:.7f},{lat:.7f},0" for lat, lon in points)


def session_kml(session: Mapping[str, Any]) -> bytes:
    """Google Earth: the drone's path, every ray with its time (the time slider replays them) and the last estimate."""
    estimate = session["estimate"]
    est_lat, est_lon = estimate.get("latitude"), estimate.get("longitude")
    located = isinstance(est_lat, (int, float)) and isinstance(est_lon, (int, float))
    frequency = session.get("frequency_hz")
    title = "Estimasi posisi pemancar" + (f" {frequency / 1e6:.3f} MHz" if isinstance(frequency, (int, float)) else "")
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
        f"<name>{escape(title)} · {_iso(session['started_ms'])}</name>",
        "<description>Garis sudut DoA dan estimasi posisi dari SDR-DoA Ground Console. Estimasi ini prediksi,"
        " bukan posisi terukur.</description>",
        '<Style id="ray"><LineStyle><color>c0dcc83c</color><width>1.5</width></LineStyle></Style>',
        '<Style id="ray-unverified"><LineStyle><color>80a0a0a0</color><width>1</width></LineStyle></Style>',
        '<Style id="path"><LineStyle><color>ff2c8cff</color><width>3</width></LineStyle></Style>',
        '<Style id="estimate"><IconStyle><color>ff3c3cff</color><scale>1.2</scale></IconStyle>'
        '<LineStyle><color>ff3c3cff</color><width>2</width></LineStyle><PolyStyle><color>403c3cff</color></PolyStyle></Style>',
    ]
    samples = session["samples"]
    if samples:
        path = []
        for _t, lat, lon, _b, _v, _f in samples:
            if not path or path[-1] != [lat, lon]:
                path.append([lat, lon])
        parts.append("<Folder><name>Jalur drone</name><Placemark><name>Jalur</name><styleUrl>#path</styleUrl>"
                     f"<LineString><tessellate>1</tessellate><coordinates>{_coords(path)}</coordinates></LineString>"
                     "</Placemark></Folder>")
        parts.append("<Folder><name>Garis sudut</name>")
        for t_ms, lat, lon, bearing, verified, _f in samples:
            length = KML_RAY_DEFAULT_M
            if located:
                length = min(KML_RAY_MAX_M, max(KML_RAY_MIN_M, 1.3 * _distance_m(lat, lon, est_lat, est_lon)))
            end = _destination(lat, lon, bearing, length)
            label = f"{bearing:.1f}°" + ("" if verified else " (belum valid)")
            parts.append(f"<Placemark><name>{escape(label)}</name><TimeStamp><when>{_iso(t_ms)}</when></TimeStamp>"
                         f"<styleUrl>#{'ray' if verified else 'ray-unverified'}</styleUrl>"
                         f"<LineString><tessellate>1</tessellate><coordinates>{_coords([[lat, lon], end])}</coordinates>"
                         "</LineString></Placemark>")
        parts.append("</Folder>")
    if located:
        radius = estimate.get("radius_m")
        label = "Estimasi" + (f" ±{radius:.0f} m" if isinstance(radius, (int, float)) else "")
        if estimate.get("state") == "ROUGH":
            label += " (kasar)"
        parts.append(f"<Folder><name>Estimasi</name><Placemark><name>{escape(label)}</name><styleUrl>#estimate</styleUrl>"
                     f"<Point><coordinates>{est_lon:.7f},{est_lat:.7f},0</coordinates></Point></Placemark>")
        if isinstance(radius, (int, float)) and radius > 0:
            ring = [_destination(est_lat, est_lon, k * 360.0 / 72, radius) for k in range(73)]
            parts.append("<Placemark><name>Radius</name><styleUrl>#estimate</styleUrl><Polygon><outerBoundaryIs>"
                         f"<LinearRing><coordinates>{_coords(ring)}</coordinates></LinearRing></outerBoundaryIs>"
                         "</Polygon></Placemark>")
        parts.append("</Folder>")
    parts.append("</Document></kml>")
    return "\n".join(parts).encode("utf-8")


__all__ = ["EXPORTS", "EstimateRecordStore", "ROUTE", "export_name", "session_csv", "session_kml", "session_route"]
