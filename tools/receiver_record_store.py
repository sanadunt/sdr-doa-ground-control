"""Local SQLite-backed Receiver records and audio storage."""
from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple, Union
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

TRACE_BYTES = 2048
PEAK_GROUP_ADJACENCY_HZ = 100_000
MAX_AUDIO_CHUNK_BYTES = 1024 * 1024
MAX_AUDIO_SEGMENT_BYTES = 256 * 1024 * 1024
MAX_AUDIO_SESSION_BYTES = 1024 * 1024 * 1024
DEFAULT_DATA_DIR = Path.home() / ".local" / "share" / "sdr-doa-ground-console"
# An unfinished audio session with no file activity for this long is treated as
# abandoned (browser closed or crashed) when the next recording starts.
ABANDONED_AUDIO_IDLE_SECONDS = 120
MAX_MARKER_SET_NAME = 120
MAX_MARKER_LABEL = 80
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def _id(value: Any) -> str:
    if not isinstance(value, str) or not _UUID_RE.fullmatch(value):
        raise ValueError("invalid id")
    return value.lower()


def _finite_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), allow_nan=False)


def _parse_audio_timestamp(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(timezone.utc)


def _audio_time_zone(value: Any) -> ZoneInfo:
    if not isinstance(value, str) or not value or len(value) > 64:
        raise ValueError("time_zone must be a valid IANA time zone")
    try:
        return ZoneInfo(value)
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise ValueError("time_zone must be a valid IANA time zone") from exc


class ReceiverRecordStore:
    """Owns generated-path audio files and their SQLite metadata."""

    def __init__(self, data_dir: Union[os.PathLike, str] = DEFAULT_DATA_DIR):
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.audio_dir = self.data_dir / "audio"
        self.temp_dir = self.data_dir / "tmp"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.audio_dir.mkdir(exist_ok=True)
        self.temp_dir.mkdir(exist_ok=True)
        self.db_path = self.data_dir / "receiver.sqlite3"
        self._lock = threading.RLock()
        self._initialize()
        self._recover_interrupted_scans()
        self._recover_abandoned_audio(idle_seconds=None)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.db_path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    @contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        # sqlite3's own context manager only commits or rolls back; it never
        # closes, so every request used to leave a connection behind.
        db = self._connect()
        try:
            with db:
                yield db
        finally:
            db.close()

    def _initialize(self) -> None:
        with self._lock:
            # WAL lets readers continue while audio chunks and traces are written.
            db = self._connect()
            try:
                db.execute("PRAGMA journal_mode=WAL")
            finally:
                db.close()
        with self._lock, self._db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS scans (
                    id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
                    metadata TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS candidates (
                    scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
                    candidate_id TEXT NOT NULL, payload TEXT NOT NULL,
                    frequency REAL NOT NULL DEFAULT 0, peak_hz REAL NOT NULL DEFAULT 0, low_hz REAL NOT NULL DEFAULT 0,
                    high_hz REAL NOT NULL DEFAULT 0, peak REAL NOT NULL DEFAULT 0,
                    snr REAL NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0,
                    last_seen REAL NOT NULL DEFAULT 0,
                    PRIMARY KEY(scan_id, candidate_id)
                );
                CREATE TABLE IF NOT EXISTS frames (
                    id INTEGER PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
                    sweep INTEGER NOT NULL DEFAULT 0, captured_at TEXT NOT NULL, payload BLOB NOT NULL
                );
                CREATE TABLE IF NOT EXISTS records (
                    id TEXT PRIMARY KEY, scan_id TEXT NOT NULL UNIQUE REFERENCES scans(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL, metadata TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS audio_sessions (
                    id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
                    temp_name TEXT NOT NULL, file_name TEXT, byte_count INTEGER NOT NULL DEFAULT 0,
                    metadata TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS audio_segments (
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES audio_sessions(id) ON DELETE CASCADE,
                    started_at TEXT NOT NULL, finished_at TEXT, byte_count INTEGER NOT NULL DEFAULT 0,
                    temp_name TEXT NOT NULL DEFAULT '', file_name TEXT, metadata TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS markers (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL, payload TEXT NOT NULL
                );
            """)
            db.execute("INSERT OR IGNORE INTO settings(key,value) VALUES('auto_spectrum_recording','false')")
            columns = {row["name"] for row in db.execute("PRAGMA table_info(candidates)")}
            had_peak_frequency = "peak_hz" in columns
            for column, declaration in (
                ("frequency", "REAL NOT NULL DEFAULT 0"),
                ("peak_hz", "REAL NOT NULL DEFAULT 0"),
                ("low_hz", "REAL NOT NULL DEFAULT 0"),
                ("high_hz", "REAL NOT NULL DEFAULT 0"),
                ("peak", "REAL NOT NULL DEFAULT 0"),
                ("snr", "REAL NOT NULL DEFAULT 0"),
                ("hits", "INTEGER NOT NULL DEFAULT 0"),
                ("last_seen", "REAL NOT NULL DEFAULT 0"),
            ):
                if column not in columns:
                    db.execute(f"ALTER TABLE candidates ADD COLUMN {column} {declaration}")
            if not had_peak_frequency:
                last_row_id = 0
                while True:
                    rows = db.execute(
                        "SELECT rowid AS row_id,frequency,payload FROM candidates "
                        "WHERE rowid>? ORDER BY rowid LIMIT 500",
                        (last_row_id,),
                    ).fetchall()
                    if not rows:
                        break
                    last_row_id = int(rows[-1]["row_id"])
                    updates = []
                    for row in rows:
                        payload = json.loads(row["payload"])
                        peak_value = payload.get("peakFrequencyHz", payload.get("meanPeakFrequencyHz", row["frequency"])) if isinstance(payload, dict) else row["frequency"]
                        try:
                            peak_frequency = float(peak_value)
                        except (TypeError, ValueError, OverflowError):
                            peak_frequency = float(row["frequency"])
                        if not math.isfinite(peak_frequency):
                            peak_frequency = float(row["frequency"])
                        updates.append((peak_frequency, row["row_id"]))
                    db.executemany("UPDATE candidates SET peak_hz=? WHERE rowid=?", updates)
            if "sweep" not in {row["name"] for row in db.execute("PRAGMA table_info(frames)")}:
                db.execute("ALTER TABLE frames ADD COLUMN sweep INTEGER NOT NULL DEFAULT 0")
            if "name" not in {row["name"] for row in db.execute("PRAGMA table_info(markers)")}:
                db.execute("ALTER TABLE markers ADD COLUMN name TEXT NOT NULL DEFAULT ''")
            segment_columns = {row["name"] for row in db.execute("PRAGMA table_info(audio_segments)")}
            if "temp_name" not in segment_columns:
                db.execute("ALTER TABLE audio_segments ADD COLUMN temp_name TEXT NOT NULL DEFAULT ''")
            if "file_name" not in segment_columns:
                db.execute("ALTER TABLE audio_segments ADD COLUMN file_name TEXT")
            db.executescript("""
                CREATE INDEX IF NOT EXISTS candidates_frequency_order ON candidates(scan_id,frequency,candidate_id);
                CREATE INDEX IF NOT EXISTS candidates_peak_order ON candidates(scan_id,peak DESC,candidate_id);
                CREATE INDEX IF NOT EXISTS candidates_snr_order ON candidates(scan_id,snr DESC,candidate_id);
                CREATE INDEX IF NOT EXISTS candidates_hits_order ON candidates(scan_id,hits DESC,candidate_id);
                CREATE INDEX IF NOT EXISTS candidates_interval_order ON candidates(scan_id,low_hz,high_hz,candidate_id);
                CREATE INDEX IF NOT EXISTS candidates_peak_frequency_order ON candidates(scan_id,peak_hz,candidate_id);
                CREATE INDEX IF NOT EXISTS candidates_last_seen_order ON candidates(scan_id,last_seen DESC,candidate_id);
                CREATE INDEX IF NOT EXISTS frames_scan_sweep_order ON frames(scan_id,sweep);
            """)
    def _finish_interrupted_scan(self, db: sqlite3.Connection, scan_id: str, metadata: Dict[str, Any], stamp: str) -> None:
        metadata.update({"status": "stopped", "interrupted": True})
        db.execute("UPDATE scans SET finished_at=?,metadata=? WHERE id=?", (stamp, _json(metadata), scan_id))
        db.execute(
            "INSERT INTO records(id,scan_id,created_at,metadata) VALUES(?,?,?,?) "
            "ON CONFLICT(scan_id) DO UPDATE SET metadata=excluded.metadata",
            (scan_id, scan_id, stamp, _json(metadata)),
        )

    def _recover_interrupted_scans(self) -> None:
        """Archive scans left running by a crash or closed tab become stopped records.

        Without this they never reach Records, yet their traces stay on disk.
        """
        stamp = _now()
        with self._lock, self._db() as db:
            for row in db.execute("SELECT id,metadata FROM scans WHERE finished_at IS NULL").fetchall():
                metadata = json.loads(row["metadata"])
                if metadata.get("archive"):
                    self._finish_interrupted_scan(db, row["id"], metadata, stamp)

    def _recover_abandoned_audio(self, idle_seconds: Optional[float]) -> int:
        """Finalize unfinished audio sessions so their audio shows up in Records.

        With ``idle_seconds`` None every unfinished session is recovered (used at
        startup, when no recorder can still be attached). Otherwise only sessions
        whose files have been idle that long are touched. Returns the number of
        sessions finalized or removed.
        """
        now = datetime.now(timezone.utc)
        recovered = 0
        with self._lock:
            with self._db() as db:
                sessions = db.execute("SELECT id,started_at FROM audio_sessions WHERE finished_at IS NULL").fetchall()
                segments_by_session = {
                    row["id"]: db.execute(
                        "SELECT id,started_at,finished_at,byte_count,temp_name,file_name,metadata "
                        "FROM audio_segments WHERE session_id=? ORDER BY started_at",
                        (row["id"],),
                    ).fetchall()
                    for row in sessions
                }
            for session in sessions:
                segments = segments_by_session[session["id"]]
                open_segments = [segment for segment in segments if segment["finished_at"] is None]
                last_activity = _parse_audio_timestamp(session["started_at"]) or now
                for segment in open_segments:
                    part = self.temp_dir / f"{segment['id']}.part"
                    if segment["temp_name"] == part.name and part.is_file():
                        modified = datetime.fromtimestamp(part.stat().st_mtime, timezone.utc)
                        last_activity = max(last_activity, modified)
                if idle_seconds is not None and (now - last_activity).total_seconds() < idle_seconds:
                    continue
                for segment in open_segments:
                    self._recover_audio_segment(segment)
                with self._db() as db:
                    remaining = db.execute(
                        "SELECT count(*), COALESCE(SUM(byte_count),0) FROM audio_segments WHERE session_id=?",
                        (session["id"],),
                    ).fetchone()
                    if remaining[0] == 0:
                        db.execute("DELETE FROM audio_sessions WHERE id=?", (session["id"],))
                    else:
                        db.execute(
                            "UPDATE audio_sessions SET finished_at=?,byte_count=? WHERE id=?",
                            (now.isoformat(), remaining[1], session["id"]),
                        )
                recovered += 1
        return recovered

    def _recover_audio_segment(self, segment: sqlite3.Row) -> None:
        segment_id = segment["id"]
        metadata = json.loads(segment["metadata"])
        part = self.temp_dir / f"{segment_id}.part"
        usable = segment["temp_name"] == part.name and part.is_file() and part.stat().st_size > 0
        if usable:
            size = part.stat().st_size
            byte_count = int(segment["byte_count"])
            # A crash between the file append and the metadata update leaves an
            # unacknowledged tail; drop it so file and metadata agree again.
            if byte_count and size > byte_count:
                with part.open("r+b") as target:
                    target.truncate(byte_count)
                size = byte_count
            ended = datetime.fromtimestamp(part.stat().st_mtime, timezone.utc)
            started = _parse_audio_timestamp(metadata.get("started_at")) or _parse_audio_timestamp(segment["started_at"])
            duration = max(0.0, (ended - started).total_seconds()) if started else 0.0
            metadata.update({"ended_at": ended.isoformat(), "duration_seconds": round(duration, 3), "status": "complete", "recovered": True})
            final_name = f"{segment_id}.webm"
            os.replace(part, self.audio_dir / final_name)
            with self._db() as db:
                db.execute(
                    "UPDATE audio_segments SET finished_at=?,byte_count=?,file_name=?,metadata=? WHERE id=?",
                    (ended.isoformat(), size, final_name, _json(metadata), segment_id),
                )
            return
        stamp = _now()
        metadata.update({
            "ended_at": stamp,
            "duration_seconds": 0,
            "status": "failed",
            "error": "Recording was interrupted before any audio was saved.",
        })
        with self._db() as db:
            db.execute(
                "UPDATE audio_segments SET finished_at=?,byte_count=0,file_name=NULL,metadata=? WHERE id=?",
                (stamp, _json(metadata), segment_id),
            )
        if segment["temp_name"] == part.name:
            part.unlink(missing_ok=True)

    def _exists(self, db: sqlite3.Connection, table: str, ident: str) -> bool:
        return db.execute(f"SELECT 1 FROM {table} WHERE id=?", (ident,)).fetchone() is not None

    def get_settings(self) -> Dict[str, Any]:
        with self._lock, self._db() as db:
            row = db.execute("SELECT value FROM settings WHERE key='auto_spectrum_recording'").fetchone()
        return {"auto_spectrum_recording": json.loads(row["value"]) if row else False}

    def update_settings(self, values: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(values, dict) or set(values) - {"auto_spectrum_recording"}:
            raise ValueError("unsupported setting")
        value = values.get("auto_spectrum_recording", self.get_settings()["auto_spectrum_recording"])
        if not isinstance(value, bool):
            raise ValueError("auto_spectrum_recording must be boolean")
        with self._lock, self._db() as db:
            db.execute("INSERT INTO settings(key,value) VALUES('auto_spectrum_recording',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (_json(value),))
        return self.get_settings()

    def create_scan(self, source: str = "", config: Optional[Dict[str, Any]] = None, archive: bool = False) -> Dict[str, Any]:
        if not isinstance(source, str) or not isinstance(config, dict) or not isinstance(archive, bool):
            raise ValueError("invalid scan metadata")
        ident, stamp = str(uuid.uuid4()), _now()
        metadata = {"source": source, "config": config, "archive": archive}
        with self._lock, self._db() as db:
            previous = db.execute("SELECT id,finished_at,metadata FROM scans").fetchall()
            for row in previous:
                previous_metadata = json.loads(row["metadata"])
                if not previous_metadata.get("archive", False):
                    db.execute("DELETE FROM scans WHERE id=?", (row["id"],))
                elif row["finished_at"] is None:
                    # A new scan means an earlier archive scan was abandoned
                    # without finish; keep it as a stopped record.
                    self._finish_interrupted_scan(db, row["id"], previous_metadata, stamp)
            db.execute("INSERT INTO scans(id,started_at,metadata) VALUES(?,?,?)", (ident, stamp, _json(metadata)))
        return {"id": ident, "created_at": stamp, "archive": archive}

    def _require_scan(self, db: sqlite3.Connection, scan_id: str) -> None:
        if not self._exists(db, "scans", _id(scan_id)):
            raise KeyError("scan not found")

    def upsert_candidates(self, scan_id: str, candidates: List[Dict[str, Any]]) -> int:
        scan_id = _id(scan_id)
        if not isinstance(candidates, list):
            raise ValueError("candidates must be an array")
        rows = []
        for candidate in candidates:
            if not isinstance(candidate, dict) or isinstance(candidate.get("id"), bool) or not isinstance(candidate.get("id"), int) or candidate["id"] < 0:
                raise ValueError("candidate id must be a nonnegative integer")
            frequency = candidate.get("meanPeakFrequencyHz", candidate.get("peakFrequencyHz", candidate.get("centerHz", 0)))
            peak_frequency = candidate.get("peakFrequencyHz", candidate.get("meanPeakFrequencyHz", frequency))
            low = candidate.get("startHz", candidate.get("minPeakFrequencyHz", candidate.get("occupiedStartHz", frequency)))
            high = candidate.get("endHz", candidate.get("maxPeakFrequencyHz", candidate.get("occupiedEndHz", frequency)))
            peak = candidate.get("peakDb", candidate.get("maxPeakDb", candidate.get("peakPowerDb", 0)))
            snr = candidate.get("snrDb", candidate.get("snr", 0))
            hits = candidate.get("hits", 0)
            last_seen = candidate.get("lastSeen", candidate.get("lastSeenAt", 0))
            try:
                frequency, peak_frequency, low, high, peak, snr, last_seen = map(
                    float, (frequency, peak_frequency, low, high, peak, snr, last_seen)
                )
                hits = int(hits)
            except (ValueError, TypeError, OverflowError) as exc:
                raise ValueError("candidate sort fields are invalid") from exc
            rows.append((
                scan_id, str(candidate["id"]), _json(candidate), frequency, peak_frequency,
                low, high, peak, snr, hits, last_seen,
            ))
        with self._lock, self._db() as db:
            self._require_scan(db, scan_id)
            db.executemany("""INSERT INTO candidates(scan_id,candidate_id,payload,frequency,peak_hz,low_hz,high_hz,peak,snr,hits,last_seen)
                VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scan_id,candidate_id) DO UPDATE SET
                payload=excluded.payload,frequency=excluded.frequency,peak_hz=excluded.peak_hz,
                low_hz=excluded.low_hz,high_hz=excluded.high_hz,
                peak=excluded.peak,snr=excluded.snr,hits=excluded.hits,last_seen=excluded.last_seen""", rows)
        return len(rows)

    def get_candidates(self, scan_id: str, offset: int = 0, limit: int = 100, sort: str = "frequency",
                       minimum_peak_db: Optional[float] = None, marked_only: bool = False,
                       marker_set_id: Optional[str] = None, marker_frequencies: Optional[List[float]] = None,
                       group_adjacent: bool = False) -> Dict[str, Any]:
        scan_id = _id(scan_id)
        offset, limit = _page(offset, limit, maximum=250)
        sort_columns = {"frequency": "frequency ASC", "peak": "peak DESC", "snr": "snr DESC", "hits": "hits DESC", "lastSeen": "last_seen DESC"}
        group_sort_columns = {
            "frequency": "bands.center_hz ASC",
            "peak": "representatives.peak DESC",
            "snr": "representatives.snr DESC",
            "hits": "representatives.hits DESC",
            "lastSeen": "representatives.last_seen DESC",
        }
        if sort not in sort_columns or not isinstance(marked_only, bool) or not isinstance(group_adjacent, bool):
            raise ValueError("invalid candidate filters")
        if minimum_peak_db is not None:
            try:
                minimum_peak_db = float(minimum_peak_db)
                if not math.isfinite(minimum_peak_db) or not -160 <= minimum_peak_db <= 0:
                    raise ValueError("minimum_peak_db must be finite and between -160 and 0")
            except (TypeError, ValueError) as exc:
                raise ValueError("minimum_peak_db must be finite and between -160 and 0") from exc
        marker_id = _id(marker_set_id) if marker_set_id is not None else None
        where, params = ["scan_id=?"], [scan_id]
        if minimum_peak_db is not None:
            where.append("peak>=?")
            params.append(minimum_peak_db)
        with self._lock, self._db() as db:
            self._require_scan(db, scan_id)
            marked_frequencies: List[float] = []
            if marked_only or marker_id:
                if marker_id:
                    row = db.execute("SELECT payload FROM markers WHERE id=?", (marker_id,)).fetchone()
                    if row is None:
                        raise KeyError("marker set not found")
                    marker_payloads = [json.loads(row["payload"])]
                    for marker_set in marker_payloads:
                        marked_frequencies.extend(
                            float(marker["frequency_hz"])
                            for marker in marker_set.get("markers", [])
                            if isinstance(marker, dict)
                            and isinstance(marker.get("frequency_hz"), (int, float))
                            and not isinstance(marker.get("frequency_hz"), bool)
                            and math.isfinite(marker["frequency_hz"])
                        )
                else:
                    if marker_frequencies is None:
                        marker_frequencies = []
                    if not isinstance(marker_frequencies, list) or len(marker_frequencies) > 10000:
                        raise ValueError("marker_frequencies must be a bounded array")
                    for frequency in marker_frequencies:
                        if isinstance(frequency, bool) or not isinstance(frequency, (int, float)) or not math.isfinite(frequency):
                            raise ValueError("marker frequencies must be finite numbers")
                        marked_frequencies.append(float(frequency))
            if marked_only:
                marked_frequencies = sorted(set(marked_frequencies))
                if not marked_frequencies:
                    return {"items": [], "total": 0, "offset": offset, "limit": limit}
                db.execute("CREATE TEMP TABLE active_markers(frequency REAL NOT NULL)")
                db.execute("CREATE INDEX active_markers_frequency ON active_markers(frequency)")
                db.executemany("INSERT INTO active_markers(frequency) VALUES(?)", ((frequency,) for frequency in marked_frequencies))
                where.append("EXISTS(SELECT 1 FROM active_markers WHERE active_markers.frequency BETWEEN candidates.low_hz-50000 AND candidates.high_hz+50000)")
            condition = " AND ".join(where)
            if group_adjacent:
                band_ctes = f"""
                    WITH filtered AS (
                        SELECT candidate_id,payload,frequency,peak_hz,low_hz,high_hz,peak,snr,hits,last_seen
                        FROM candidates WHERE {condition}
                    ),
                    previous_ranges AS (
                        SELECT *,
                            LAG(peak_hz) OVER (ORDER BY peak_hz,candidate_id) AS previous_peak_hz
                        FROM filtered
                    ),
                    marked_ranges AS (
                        SELECT *,
                            CASE
                                WHEN previous_peak_hz IS NULL
                                  OR peak_hz - previous_peak_hz > {PEAK_GROUP_ADJACENCY_HZ}
                                THEN 1 ELSE 0
                            END AS starts_range
                        FROM previous_ranges
                    ),
                    numbered_ranges AS (
                        SELECT *,
                            SUM(starts_range) OVER (
                                ORDER BY peak_hz,candidate_id
                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                            ) AS range_id
                        FROM marked_ranges
                    ),
                    bands AS (
                        SELECT range_id,MIN(peak_hz) AS peak_range_start_hz,
                            MAX(peak_hz) AS peak_range_end_hz,
                            (MIN(peak_hz)+MAX(peak_hz))/2 AS center_hz,
                            MIN(CAST(candidate_id AS INTEGER)) AS group_id
                        FROM numbered_ranges GROUP BY range_id
                    ),
                    representatives AS (
                        SELECT range_id,payload,peak,snr,hits,last_seen,
                            ROW_NUMBER() OVER (
                                PARTITION BY range_id
                                ORDER BY peak DESC,peak_hz ASC,CAST(candidate_id AS INTEGER) ASC
                            ) AS representative_rank
                        FROM numbered_ranges
                    )
                """
                total = db.execute(f"{band_ctes} SELECT count(*) FROM bands", params).fetchone()[0]
                rows = db.execute(
                    f"{band_ctes} SELECT bands.peak_range_start_hz,bands.peak_range_end_hz,"
                    f"bands.center_hz,bands.group_id,representatives.payload "
                    f"FROM bands JOIN representatives USING(range_id) WHERE representatives.representative_rank=1 "
                    f"ORDER BY {group_sort_columns[sort]},bands.range_id LIMIT ? OFFSET ?",
                    [*params, limit, offset],
                ).fetchall()
                items = []
                for row in rows:
                    candidate = json.loads(row["payload"])
                    peak_range_start_hz = float(row["peak_range_start_hz"])
                    peak_range_end_hz = float(row["peak_range_end_hz"])
                    candidate.update({
                        "id": int(row["group_id"]),
                        "peakRangeStartHz": peak_range_start_hz,
                        "peakRangeEndHz": peak_range_end_hz,
                        "peakRangeCenterHz": peak_range_start_hz + (peak_range_end_hz - peak_range_start_hz) / 2,
                    })
                    items.append(candidate)
                return {"items": items, "offset": offset, "limit": limit, "total": total}
            total = db.execute(f"SELECT count(*) FROM candidates WHERE {condition}", params).fetchone()[0]
            rows = db.execute(f"SELECT payload FROM candidates WHERE {condition} ORDER BY {sort_columns[sort]},candidate_id LIMIT ? OFFSET ?", [*params, limit, offset]).fetchall()
        return {"items": [json.loads(row[0]) for row in rows], "offset": offset, "limit": limit, "total": total}
    def add_trace(self, scan_id: str, sweep: int, payload: bytes) -> Optional[int]:
        import zlib
        scan_id = _id(scan_id)
        if isinstance(sweep, bool) or not isinstance(sweep, int) or sweep < 0:
            raise ValueError("sweep must be a nonnegative integer")
        if not isinstance(payload, bytes) or len(payload) != TRACE_BYTES:
            raise ValueError("trace must contain exactly 2048 bytes")
        with self._lock, self._db() as db:
            self._require_scan(db, scan_id)
            settings_enabled = json.loads(db.execute("SELECT value FROM settings WHERE key='auto_spectrum_recording'").fetchone()[0])
            metadata = json.loads(db.execute("SELECT metadata FROM scans WHERE id=?", (scan_id,)).fetchone()[0])
            if not settings_enabled and not metadata.get("archive"):
                return None
            cursor = db.execute("INSERT INTO frames(scan_id,sweep,captured_at,payload) VALUES(?,?,?,?)", (scan_id, sweep, _now(), sqlite3.Binary(zlib.compress(payload))))
            return int(cursor.lastrowid)

    def finish_scan(self, scan_id: str, status: str) -> Dict[str, Any]:
        scan_id = _id(scan_id)
        if status not in {"complete", "stopped", "failed"}:
            raise ValueError("invalid scan status")
        stamp = _now()
        with self._lock, self._db() as db:
            self._require_scan(db, scan_id)
            metadata = json.loads(db.execute("SELECT metadata FROM scans WHERE id=?", (scan_id,)).fetchone()["metadata"])
            metadata["status"] = status
            db.execute("UPDATE scans SET finished_at=?,metadata=? WHERE id=?", (stamp, _json(metadata), scan_id))
            if metadata.get("archive"):
                db.execute("INSERT INTO records(id,scan_id,created_at,metadata) VALUES(?,?,?,?) ON CONFLICT(scan_id) DO UPDATE SET metadata=excluded.metadata", (scan_id, scan_id, stamp, _json(metadata)))
        return {"id": scan_id, "scan_id": scan_id, "finished_at": stamp, "status": status, "archive": metadata.get("archive", False)}

    def nearest_candidate(self, scan_id: str, frequency_hz: float, limit: int = 1, marker_set_id: Optional[str] = None) -> Dict[str, Any]:
        scan_id = _id(scan_id)
        if not isinstance(frequency_hz, (int, float)) or isinstance(frequency_hz, bool) or not math.isfinite(frequency_hz):
            raise ValueError("near_frequency_hz must be a finite number")
        _, limit = _page(0, limit)
        with self._lock, self._db() as db:
            self._require_scan(db, scan_id)
            row = db.execute("""SELECT payload, MAX(low_hz-?, ?-high_hz, 0) AS interval_distance
                FROM candidates WHERE scan_id=? AND high_hz>=?-50000 AND low_hz<=?+50000
                ORDER BY interval_distance, candidate_id LIMIT ?""",
                (frequency_hz, frequency_hz, scan_id, frequency_hz, frequency_hz, limit)).fetchall()
        return {"items": [json.loads(item["payload"]) for item in row], "total": len(row), "offset": 0, "limit": limit}

    def scan_info(self, scan_id: str) -> Dict[str, Any]:
        scan_id = _id(scan_id)
        with self._lock, self._db() as db:
            row = db.execute("SELECT started_at,finished_at,metadata FROM scans WHERE id=?", (scan_id,)).fetchone()
            if row is None:
                raise KeyError("scan not found")
            metadata = json.loads(row["metadata"])
            candidates = db.execute("SELECT count(*) FROM candidates WHERE scan_id=?", (scan_id,)).fetchone()[0]
            traces = db.execute("SELECT count(*) FROM frames WHERE scan_id=?", (scan_id,)).fetchone()[0]
        config = metadata.get("config", {})
        return {"id": scan_id, "created_at": row["started_at"], "completed_at": row["finished_at"],
                "source": metadata.get("source", ""), "status": metadata.get("status", "running"),
                "archive": bool(metadata.get("archive")), "start_hz": config.get("start_hz", config.get("startHz")),
                "end_hz": config.get("end_hz", config.get("endHz")), "config": config,
                "candidate_count": candidates, "trace_count": traces}

    def list_traces(self, scan_id: str, offset: int = 0, limit: int = 100, order: str = "asc") -> Dict[str, Any]:
        scan_id = _id(scan_id)
        offset, limit = _page(offset, limit)
        if order not in {"asc", "desc"}:
            raise ValueError("order must be asc or desc")
        with self._lock, self._db() as db:
            self._require_scan(db, scan_id)
            total = db.execute("SELECT count(*) FROM frames WHERE scan_id=?", (scan_id,)).fetchone()[0]
            rows = db.execute(f"SELECT sweep,captured_at FROM frames WHERE scan_id=? ORDER BY sweep {order.upper()} LIMIT ? OFFSET ?", (scan_id, limit, offset)).fetchall()
        return {"items": [{"sweep": row["sweep"], "created_at": row["captured_at"]} for row in rows], "total": total, "offset": offset, "limit": limit}

    def get_trace(self, scan_id: str, sweep: int) -> bytes:
        import zlib
        scan_id = _id(scan_id)
        if isinstance(sweep, bool) or not isinstance(sweep, int) or sweep < 0:
            raise ValueError("sweep must be a nonnegative integer")
        with self._lock, self._db() as db:
            row = db.execute("SELECT payload FROM frames WHERE scan_id=? AND sweep=?", (scan_id, sweep)).fetchone()
        if row is None:
            raise KeyError("trace not found")
        payload = zlib.decompress(row["payload"])
        if len(payload) != TRACE_BYTES:
            raise OSError("stored trace is corrupt")
        return payload

    def list_records(self, offset: int = 0, limit: int = 100, record_type: Optional[str] = None) -> Dict[str, Any]:
        offset, limit = _page(offset, limit, maximum=200)
        if record_type not in (None, "scan", "audio-session"):
            raise ValueError("record type must be scan or audio-session")
        with self._lock, self._db() as db:
            if record_type == "scan":
                total = db.execute("SELECT count(*) FROM records").fetchone()[0]
            elif record_type == "audio-session":
                total = db.execute("SELECT count(*) FROM audio_sessions WHERE finished_at IS NOT NULL").fetchone()[0]
            else:
                total = db.execute("SELECT (SELECT count(*) FROM records)+(SELECT count(*) FROM audio_sessions WHERE finished_at IS NOT NULL)").fetchone()[0]
            rows_query = """SELECT type,id,created_at,completed_at,metadata,scan_id FROM (
                SELECT 'scan' AS type,r.id,s.started_at AS created_at,s.finished_at AS completed_at,s.metadata AS metadata,s.id AS scan_id
                FROM records r JOIN scans s ON s.id=r.scan_id
                UNION ALL
                SELECT 'audio-session',id,started_at,finished_at,metadata,NULL FROM audio_sessions WHERE finished_at IS NOT NULL
            )"""
            parameters: List[Any] = []
            if record_type is not None:
                rows_query += " WHERE type=?"
                parameters.append(record_type)
            rows_query += " ORDER BY created_at DESC,id LIMIT ? OFFSET ?"
            parameters.extend((limit, offset))
            rows = db.execute(rows_query, parameters).fetchall()
            results = []
            for row in rows:
                metadata = json.loads(row["metadata"])
                if row["type"] == "scan":
                    scan_id = row["scan_id"]
                    results.append({"type": "scan", "id": row["id"], "created_at": row["created_at"], "completed_at": row["completed_at"],
                        "source": metadata.get("source", ""), "status": metadata.get("status", "running"), "archive": bool(metadata.get("archive")),
                        "start_hz": metadata.get("config", {}).get("start_hz", metadata.get("config", {}).get("startHz")),
                        "end_hz": metadata.get("config", {}).get("end_hz", metadata.get("config", {}).get("endHz")),
                        "candidate_count": db.execute("SELECT count(*) FROM candidates WHERE scan_id=?", (scan_id,)).fetchone()[0],
                        "trace_count": db.execute("SELECT count(*) FROM frames WHERE scan_id=?", (scan_id,)).fetchone()[0]})
                else:
                    segments = db.execute("SELECT id,started_at,finished_at,byte_count,metadata FROM audio_segments WHERE session_id=? ORDER BY started_at", (row["id"],)).fetchall()
                    results.append({"type": "audio-session", "id": row["id"], "created_at": row["created_at"], "completed_at": row["completed_at"],
                        "segments": [{"id": seg["id"], **json.loads(seg["metadata"]), "started_at": json.loads(seg["metadata"]).get("started_at", seg["started_at"]),
                                      "ended_at": json.loads(seg["metadata"]).get("ended_at", seg["finished_at"]), "bytes": seg["byte_count"]} for seg in segments]})
        return {"items": results, "total": total, "offset": offset, "limit": limit}

    def list_audio_records(
        self,
        offset: int = 0,
        limit: int = 100,
        filters: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        offset, limit = _page(offset, limit, maximum=200)
        if filters is None:
            filter_values: Dict[str, Any] = {}
        elif isinstance(filters, dict):
            filter_values = filters
        else:
            raise ValueError("audio filters must be an object")

        allowed_filters = {
            "started_after",
            "started_before",
            "time_from",
            "time_to",
            "time_zone",
            "min_frequency_hz",
            "max_frequency_hz",
            "vfo_index",
            "mode",
            "bandwidth_hz",
        }
        if set(filter_values).difference(allowed_filters):
            raise ValueError("audio filters contain an unsupported field")

        def text_filter(name: str, maximum: int = 64) -> Optional[str]:
            value = filter_values.get(name)
            if value is None:
                return None
            if not isinstance(value, str):
                raise ValueError(f"{name} must be text")
            normalized = value.strip()
            if len(normalized) > maximum:
                raise ValueError(f"{name} must be {maximum} characters or fewer")
            return normalized or None

        def parse_bound(value: Optional[str], name: str) -> Optional[datetime]:
            if value is None:
                return None
            parsed = _parse_audio_timestamp(value)
            if parsed is None:
                raise ValueError(f"{name} must be an ISO date-time with a timezone")
            return parsed

        def parse_number(name: str) -> Optional[float]:
            value = filter_values.get(name)
            if value is None:
                return None
            if isinstance(value, bool) or not isinstance(value, (str, int, float)):
                raise ValueError(f"{name} must be numeric")
            try:
                parsed = float(value)
            except (OverflowError, ValueError) as exc:
                raise ValueError(f"{name} must be numeric") from exc
            if not math.isfinite(parsed):
                raise ValueError(f"{name} must be finite")
            return parsed

        def parse_clock(value: Optional[str], name: str) -> Optional[int]:
            if value is None:
                return None
            if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
                raise ValueError(f"{name} must use HH:MM")
            hours, minutes = (int(part) for part in value.split(":"))
            return hours * 60 + minutes

        lower_bound = parse_bound(text_filter("started_after"), "started_after")
        upper_bound = parse_bound(text_filter("started_before"), "started_before")
        if lower_bound is not None and upper_bound is not None and lower_bound >= upper_bound:
            raise ValueError("started_after must be earlier than started_before")

        time_from = parse_clock(text_filter("time_from", 5), "time_from")
        time_to = parse_clock(text_filter("time_to", 5), "time_to")
        if time_from is not None and time_to is not None and time_from > time_to:
            raise ValueError("time_from must not be later than time_to")
        time_zone_name = text_filter("time_zone")
        time_zone = _audio_time_zone(time_zone_name) if time_zone_name is not None else None
        if (time_from is not None or time_to is not None) and time_zone is None:
            raise ValueError("time_zone is required when filtering by time")

        minimum_frequency = parse_number("min_frequency_hz")
        maximum_frequency = parse_number("max_frequency_hz")
        if minimum_frequency is not None and maximum_frequency is not None and minimum_frequency > maximum_frequency:
            raise ValueError("min_frequency_hz must not exceed max_frequency_hz")

        raw_vfo_index = filter_values.get("vfo_index")
        if raw_vfo_index is None:
            vfo_index = None
        elif isinstance(raw_vfo_index, bool) or not isinstance(raw_vfo_index, (str, int)):
            raise ValueError("vfo_index must be a nonnegative integer")
        else:
            try:
                vfo_index = int(raw_vfo_index)
            except (OverflowError, ValueError) as exc:
                raise ValueError("vfo_index must be a nonnegative integer") from exc
            if vfo_index < 0 or len(str(raw_vfo_index)) > 12:
                raise ValueError("vfo_index must be a nonnegative integer")

        mode = text_filter("mode", 64)
        normalized_mode = mode.casefold() if mode else None
        bandwidth = parse_number("bandwidth_hz")
        has_filter = any(value is not None for value in (
            lower_bound,
            upper_bound,
            time_from,
            time_to,
            minimum_frequency,
            maximum_frequency,
            vfo_index,
            normalized_mode,
            bandwidth,
        ))
        if not has_filter:
            return self.list_records(offset, limit, "audio-session")

        with self._lock, self._db() as db:
            rows = db.execute(
                """SELECT a.id AS session_id,a.started_at AS session_started_at,a.finished_at AS session_finished_at,
                    g.id AS segment_id,g.started_at AS segment_started_at,g.finished_at AS segment_finished_at,
                    g.byte_count AS segment_bytes,g.metadata AS segment_metadata
                FROM audio_sessions a LEFT JOIN audio_segments g ON g.session_id=a.id
                WHERE a.finished_at IS NOT NULL
                ORDER BY a.started_at DESC,a.id,g.started_at"""
            ).fetchall()

        sessions: Dict[str, Dict[str, Any]] = {}
        session_order: List[str] = []
        for row in rows:
            session_id = row["session_id"]
            if session_id not in sessions:
                sessions[session_id] = {
                    "type": "audio-session",
                    "id": session_id,
                    "created_at": row["session_started_at"],
                    "completed_at": row["session_finished_at"],
                    "segments": [],
                }
                session_order.append(session_id)
            if row["segment_id"] is None:
                continue

            metadata = json.loads(row["segment_metadata"])
            segment_started_at = metadata.get("started_at", row["segment_started_at"])
            segment = {
                "id": row["segment_id"],
                **metadata,
                "started_at": segment_started_at,
                "ended_at": metadata.get("ended_at", row["segment_finished_at"]),
                "bytes": row["segment_bytes"],
            }
            if lower_bound is not None or upper_bound is not None or time_from is not None or time_to is not None:
                segment_time = _parse_audio_timestamp(segment_started_at)
                if segment_time is None:
                    continue
                if lower_bound is not None and segment_time < lower_bound:
                    continue
                if upper_bound is not None and segment_time >= upper_bound:
                    continue
                if time_from is not None or time_to is not None:
                    local_time = segment_time.astimezone(time_zone)
                    minute_of_day = local_time.hour * 60 + local_time.minute
                    if time_from is not None and minute_of_day < time_from:
                        continue
                    if time_to is not None and minute_of_day > time_to:
                        continue

            frequency = segment.get("frequency_hz")
            if minimum_frequency is not None or maximum_frequency is not None:
                if not _finite_number(frequency):
                    continue
                if minimum_frequency is not None and frequency < minimum_frequency:
                    continue
                if maximum_frequency is not None and frequency > maximum_frequency:
                    continue
            if vfo_index is not None:
                segment_vfo = segment.get("vfo_index")
                if isinstance(segment_vfo, bool) or segment_vfo != vfo_index:
                    continue
            if normalized_mode is not None:
                segment_mode = segment.get("mode")
                if not isinstance(segment_mode, str) or segment_mode.casefold() != normalized_mode:
                    continue
            if bandwidth is not None:
                segment_bandwidth = segment.get("bandwidth_hz")
                if not _finite_number(segment_bandwidth) or segment_bandwidth != bandwidth:
                    continue
            sessions[session_id]["segments"].append(segment)

        filtered_sessions = [
            sessions[session_id]
            for session_id in session_order
            if sessions[session_id]["segments"]
        ]
        return {
            "items": filtered_sessions[offset:offset + limit],
            "total": len(filtered_sessions),
            "offset": offset,
            "limit": limit,
        }

    def audio_record_facets(self, time_zone: str) -> Dict[str, Any]:
        zone = _audio_time_zone(time_zone)
        with self._lock, self._db() as db:
            rows = db.execute(
                """SELECT g.started_at AS segment_started_at,g.metadata AS segment_metadata
                FROM audio_sessions a JOIN audio_segments g ON g.session_id=a.id
                WHERE a.finished_at IS NOT NULL"""
            ).fetchall()

        available_dates = set()
        vfo_indices = set()
        modes = set()
        bandwidths = set()
        minimum_frequency = None
        maximum_frequency = None
        for row in rows:
            metadata = json.loads(row["segment_metadata"])
            started_at = metadata.get("started_at", row["segment_started_at"])
            timestamp = _parse_audio_timestamp(started_at)
            if timestamp is not None:
                available_dates.add(timestamp.astimezone(zone).date().isoformat())

            vfo_index = metadata.get("vfo_index")
            if isinstance(vfo_index, int) and not isinstance(vfo_index, bool):
                vfo_indices.add(vfo_index)
            mode = metadata.get("mode")
            if isinstance(mode, str) and mode.strip():
                modes.add(mode.strip().casefold())
            bandwidth = metadata.get("bandwidth_hz")
            if _finite_number(bandwidth):
                bandwidths.add(bandwidth)
            frequency = metadata.get("frequency_hz")
            if _finite_number(frequency):
                minimum_frequency = frequency if minimum_frequency is None else min(minimum_frequency, frequency)
                maximum_frequency = frequency if maximum_frequency is None else max(maximum_frequency, frequency)

        return {
            "available_dates": sorted(available_dates),
            "vfo_indices": sorted(vfo_indices),
            "modes": sorted(modes),
            "bandwidths_hz": sorted(bandwidths),
            "min_frequency_hz": minimum_frequency,
            "max_frequency_hz": maximum_frequency,
        }

    def _managed_audio_path(self, directory: Path, stored_name: Optional[str], expected_name: str) -> Optional[Path]:
        if not stored_name:
            return None
        if stored_name != expected_name:
            raise OSError("audio file metadata is invalid")
        data_root = self.data_dir.resolve()
        storage_root = directory.resolve()
        if storage_root.parent != data_root:
            raise OSError("audio storage directory is invalid")
        path = directory / stored_name
        resolved = path.resolve()
        if resolved == storage_root or resolved.parent != storage_root:
            raise OSError("audio file path is outside its storage directory")
        return path

    def delete_audio_segment(self, segment_id: str) -> bool:
        ident = _id(segment_id)
        with self._lock:
            with self._db() as db:
                row = db.execute(
                    """SELECT g.session_id,g.finished_at,g.byte_count,g.temp_name,g.file_name
                    FROM audio_segments g JOIN audio_sessions a ON a.id=g.session_id WHERE g.id=?""",
                    (ident,),
                ).fetchone()
                if row is None:
                    return False
                if row["finished_at"] is None:
                    raise ValueError("cannot delete an audio segment while it is recording")
                temp_path = self._managed_audio_path(self.temp_dir, row["temp_name"], f"{ident}.part")
                audio_path = self._managed_audio_path(self.audio_dir, row["file_name"], f"{ident}.webm")
                db.execute("DELETE FROM audio_segments WHERE id=?", (ident,))
                db.execute(
                    "UPDATE audio_sessions SET byte_count=MAX(0,byte_count-?) WHERE id=?",
                    (row["byte_count"], row["session_id"]),
                )
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
            if audio_path is not None:
                audio_path.unlink(missing_ok=True)
        return True

    def delete_record(self, record_id: str) -> bool:
        ident = _id(record_id)
        with self._lock, self._db() as db:
            scan = db.execute("SELECT scan_id FROM records WHERE id=?", (ident,)).fetchone()
            if scan is not None:
                db.execute("DELETE FROM records WHERE id=?", (ident,))
                db.execute("DELETE FROM scans WHERE id=?", (scan["scan_id"],))
                return True
            audio = db.execute("SELECT temp_name,file_name FROM audio_sessions WHERE id=?", (ident,)).fetchone()
            if audio is None:
                return False
            segment_ids = [row["id"] for row in db.execute("SELECT id FROM audio_segments WHERE session_id=?", (ident,))]
            db.execute("DELETE FROM audio_sessions WHERE id=?", (ident,))
        for segment_id in segment_ids:
            (self.temp_dir / f"{segment_id}.part").unlink(missing_ok=True)
            (self.audio_dir / f"{segment_id}.webm").unlink(missing_ok=True)
        if audio["temp_name"] == f"{ident}.part":
            (self.temp_dir / audio["temp_name"]).unlink(missing_ok=True)
        if audio["file_name"] == f"{ident}.webm":
            (self.audio_dir / audio["file_name"]).unlink(missing_ok=True)
        return True

    def create_audio_session(self, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if metadata is not None and not isinstance(metadata, dict):
            raise ValueError("audio session metadata must be an object")
        self._recover_abandoned_audio(idle_seconds=ABANDONED_AUDIO_IDLE_SECONDS)
        ident, stamp = str(uuid.uuid4()), _now()
        with self._lock, self._db() as db:
            db.execute("INSERT INTO audio_sessions(id,started_at,temp_name,metadata) VALUES(?,?,?,?)", (ident, stamp, "", _json(metadata or {})))
        return {"id": ident, "started_at": stamp}

    def create_audio_segment(self, session_id: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        session_id = _id(session_id)
        required = {"vfo_index", "frequency_hz", "mode", "bandwidth_hz", "codec", "started_at"}
        if not isinstance(metadata, dict) or not required.issubset(metadata):
            raise ValueError("audio segment metadata is incomplete")
        if (isinstance(metadata["vfo_index"], bool) or not isinstance(metadata["vfo_index"], int)
                or isinstance(metadata["frequency_hz"], bool) or not isinstance(metadata["frequency_hz"], (int, float))
                or isinstance(metadata["bandwidth_hz"], bool) or not isinstance(metadata["bandwidth_hz"], (int, float))
                or not isinstance(metadata["mode"], str) or not isinstance(metadata["codec"], str)
                or not isinstance(metadata["started_at"], str)):
            raise ValueError("audio segment metadata has invalid types")
        ident, stamp = str(uuid.uuid4()), _now()
        temp_name = f"{ident}.part"
        temp_path = self.temp_dir / temp_name
        with self._lock:
            with self._db() as db:
                row = db.execute("SELECT finished_at FROM audio_sessions WHERE id=?", (session_id,)).fetchone()
                if row is None:
                    raise KeyError("audio session not found")
                if row["finished_at"]:
                    raise ValueError("audio session is finished")
            fd = os.open(temp_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
            try:
                with self._db() as db:
                    db.execute("INSERT INTO audio_segments(id,session_id,started_at,temp_name,metadata) VALUES(?,?,?,?,?)", (ident, session_id, stamp, temp_name, _json(metadata)))
            except Exception:
                temp_path.unlink(missing_ok=True)
                raise
        return {"id": ident, "session_id": session_id, "started_at": stamp}

    def append_segment_audio(self, segment_id: str, payload: bytes) -> Dict[str, int]:
        segment_id = _id(segment_id)
        if not isinstance(payload, bytes) or not payload or len(payload) > MAX_AUDIO_CHUNK_BYTES:
            raise ValueError("audio chunk must be between 1 byte and 1 MiB")
        with self._lock:
            with self._db() as db:
                row = db.execute("""SELECT a.id AS session_id,a.byte_count AS session_bytes,a.finished_at AS session_finished,
                    g.byte_count AS segment_bytes,g.finished_at AS segment_finished,g.temp_name
                    FROM audio_segments g JOIN audio_sessions a ON a.id=g.session_id WHERE g.id=?""", (segment_id,)).fetchone()
            if row is None:
                raise KeyError("audio segment not found")
            if row["session_finished"] or row["segment_finished"]:
                raise ValueError("audio session or segment is finished")
            if row["session_bytes"] + len(payload) > MAX_AUDIO_SESSION_BYTES or row["segment_bytes"] + len(payload) > MAX_AUDIO_SEGMENT_BYTES:
                raise ValueError("audio recording size limit exceeded")
            if row["temp_name"] != f"{segment_id}.part":
                raise OSError("audio temporary file metadata is invalid")
            path = self.temp_dir / row["temp_name"]
            if path.parent != self.temp_dir or not path.is_file():
                raise OSError("audio temporary file is unavailable")
            prior_size = path.stat().st_size
            if prior_size != row["segment_bytes"]:
                raise OSError("audio temporary file size does not match metadata")
            try:
                with path.open("ab") as target:
                    target.write(payload)
                    target.flush()
                    os.fsync(target.fileno())
                with self._db() as db:
                    db.execute("UPDATE audio_sessions SET byte_count=byte_count+? WHERE id=?", (len(payload), row["session_id"]))
                    db.execute("UPDATE audio_segments SET byte_count=byte_count+? WHERE id=?", (len(payload), segment_id))
            except Exception:
                with path.open("r+b") as target:
                    target.truncate(prior_size)
                    target.flush()
                    os.fsync(target.fileno())
                raise
            return {"session_bytes": row["session_bytes"] + len(payload), "segment_bytes": row["segment_bytes"] + len(payload)}

    def finish_audio_session(self, session_id: str) -> Dict[str, Any]:
        session_id = _id(session_id)
        with self._lock, self._db() as db:
            row = db.execute("SELECT byte_count,finished_at FROM audio_sessions WHERE id=?", (session_id,)).fetchone()
            if row is None:
                raise KeyError("audio session not found")
            if row["finished_at"]:
                return {"id": session_id, "finished_at": row["finished_at"], "byte_count": row["byte_count"]}
            unfinished = db.execute("SELECT count(*) FROM audio_segments WHERE session_id=? AND finished_at IS NULL", (session_id,)).fetchone()[0]
            if unfinished:
                raise ValueError("all audio segments must be finalized before the session")
            stamp = _now()
            db.execute("UPDATE audio_sessions SET finished_at=? WHERE id=?", (stamp, session_id))
        return {"id": session_id, "finished_at": stamp, "byte_count": row["byte_count"]}

    def finish_segment(self, segment_id: str, details: Dict[str, Any]) -> Dict[str, Any]:
        segment_id = _id(segment_id)
        if not isinstance(details, dict):
            raise ValueError("segment finish body must be an object")
        ended_at, duration = details.get("ended_at"), details.get("duration_seconds")
        if not isinstance(ended_at, str) or isinstance(duration, bool) or not isinstance(duration, (int, float)) or duration < 0:
            raise ValueError("invalid segment finish metadata")
        status = details.get("status", "complete")
        error = details.get("error", "")
        if status not in {"complete", "failed"} or not isinstance(error, str) or len(error) > 2048:
            raise ValueError("invalid segment recording status")
        with self._lock:
            with self._db() as db:
                row = db.execute("""SELECT g.session_id,g.started_at,g.finished_at,g.byte_count,g.temp_name,g.file_name,
                    a.finished_at AS session_finished,g.metadata FROM audio_segments g
                    JOIN audio_sessions a ON a.id=g.session_id WHERE g.id=?""", (segment_id,)).fetchone()
            if row is None:
                raise KeyError("audio segment not found")
            if row["finished_at"]:
                metadata = json.loads(row["metadata"])
                return {"id": segment_id, "ended_at": row["finished_at"], "duration_seconds": metadata.get("duration_seconds", duration), "status": metadata.get("status", "complete")}
            if row["session_finished"]:
                raise ValueError("audio session is finished")
            if row["temp_name"] != f"{segment_id}.part":
                raise OSError("audio temporary file metadata is invalid")
            temp_path = self.temp_dir / row["temp_name"]
            final_name = f"{segment_id}.webm"
            final_path = self.audio_dir / final_name
            if status == "failed":
                metadata = json.loads(row["metadata"])
                metadata.update({
                    "ended_at": ended_at,
                    "duration_seconds": duration,
                    "status": "failed",
                    "error": error or "Audio segment recording failed.",
                })
                with self._db() as db:
                    db.execute("UPDATE audio_segments SET finished_at=?,file_name=NULL,metadata=? WHERE id=?",
                               (ended_at, _json(metadata), segment_id))
                temp_path.unlink(missing_ok=True)
                return {"id": segment_id, "ended_at": ended_at, "duration_seconds": duration, "status": "failed"}
            if not temp_path.is_file() or temp_path.stat().st_size != row["byte_count"]:
                raise OSError("audio temporary file is unavailable or has an invalid size")
            metadata = json.loads(row["metadata"])
            metadata.update({"ended_at": ended_at, "duration_seconds": duration, "status": "complete"})
            metadata.pop("error", None)
            os.replace(temp_path, final_path)
            try:
                with self._db() as db:
                    db.execute("UPDATE audio_segments SET finished_at=?,file_name=?,metadata=? WHERE id=?",
                               (ended_at, final_name, _json(metadata), segment_id))
            except Exception:
                os.replace(final_path, temp_path)
                raise
        return {"id": segment_id, "ended_at": ended_at, "duration_seconds": duration, "status": status}

    def get_segment_audio(self, segment_id: str) -> Tuple[Path, str]:
        segment_id = _id(segment_id)
        with self._lock, self._db() as db:
            row = db.execute("SELECT file_name,metadata FROM audio_segments WHERE id=? AND finished_at IS NOT NULL", (segment_id,)).fetchone()
        if row is None:
            raise KeyError("audio segment not found")
        metadata = json.loads(row["metadata"])
        if metadata.get("status", "complete") != "complete":
            raise KeyError("failed audio segment is not playable")
        name = row["file_name"]
        if name != f"{segment_id}.webm":
            raise OSError("audio file metadata is invalid")
        path = self.audio_dir / name
        if not path.is_file():
            raise KeyError("audio file not found")
        return path, "audio/webm"

    def get_markers(self, marker_id: Optional[str] = None) -> Any:
        with self._lock, self._db() as db:
            if marker_id is not None:
                ident = _id(marker_id)
                rows = db.execute("SELECT id,name,payload FROM markers WHERE id=?", (ident,)).fetchall()
            else:
                rows = db.execute("SELECT id,name,payload FROM markers ORDER BY name,id").fetchall()
        items = [{"id": row["id"], "name": row["name"], "markers": json.loads(row["payload"]).get("markers", [])} for row in rows]
        return items[0] if marker_id is not None and items else (None if marker_id is not None else items)

    def save_markers(self, payload: Dict[str, Any], marker_id: Optional[str] = None) -> Dict[str, Any]:
        if not isinstance(payload, dict) or not isinstance(payload.get("name"), str) or not payload["name"].strip():
            raise ValueError("marker set requires a name")
        if len(payload["name"].strip()) > MAX_MARKER_SET_NAME:
            raise ValueError(f"marker set name must be {MAX_MARKER_SET_NAME} characters or fewer")
        markers = payload.get("markers")
        if not isinstance(markers, list) or len(markers) > 10000:
            raise ValueError("markers must be a bounded array")
        normalized = []
        for marker in markers:
            if not isinstance(marker, dict):
                raise ValueError("marker must be an object")
            frequency, power = marker.get("frequency_hz"), marker.get("power_db")
            if not _finite_number(frequency) or frequency <= 0:
                raise ValueError("marker frequency_hz must be a positive finite number")
            if power is not None and not _finite_number(power):
                raise ValueError("marker power_db must be a finite number or null")
            label, marker_ident = marker.get("label", ""), marker.get("id")
            if label is None:
                label = ""
            if not isinstance(label, str) or len(label) > MAX_MARKER_LABEL:
                raise ValueError(f"marker label must be text of {MAX_MARKER_LABEL} characters or fewer")
            if marker_ident is not None and (not isinstance(marker_ident, str) or not 0 < len(marker_ident) <= 128):
                raise ValueError("marker id must be a short string")
            normalized.append({"id": marker_ident or str(uuid.uuid4()), "frequency_hz": frequency, "power_db": power, "label": label})
        ident = _id(payload["id"]) if payload.get("id") is not None else (str(uuid.uuid4()) if marker_id is None else _id(marker_id))
        name, stamp = payload["name"].strip(), _now()
        with self._lock, self._db() as db:
            existing = db.execute("SELECT id FROM markers WHERE name=?", (name,)).fetchone()
            if existing is not None and payload.get("id") is None and marker_id is None:
                ident = existing["id"]
            elif existing is not None and existing["id"] != ident:
                raise ValueError(f'a marker set named "{name}" already exists; choose another name')
            db.execute("""INSERT INTO markers(id,name,updated_at,payload) VALUES(?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at,payload=excluded.payload""",
                (ident, name, stamp, _json({"markers": normalized})))
        return {"id": ident, "name": name, "markers": normalized}

    def delete_markers(self, marker_id: str) -> bool:
        ident = _id(marker_id)
        with self._lock, self._db() as db:
            return db.execute("DELETE FROM markers WHERE id=?", (ident,)).rowcount > 0

    def close(self) -> None:
        """Connections are operation-scoped; included for server lifecycle symmetry."""


def _page(offset: Any, limit: Any, maximum: int = 100) -> Tuple[int, int]:
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError("offset must be a nonnegative integer")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= maximum:
        raise ValueError(f"limit must be between 1 and {maximum}")
    return offset, limit
