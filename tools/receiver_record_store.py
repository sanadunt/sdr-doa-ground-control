"""Local SQLite-backed Receiver records and audio storage."""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import sqlite3
import struct
import threading
import time
import uuid
import zlib
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone, tzinfo
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple, Union
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

TRACE_BYTES = 2048
MAX_AUDIO_CHUNK_BYTES = 1024 * 1024
MAX_AUDIO_SEGMENT_BYTES = 256 * 1024 * 1024
MAX_AUDIO_SESSION_BYTES = 1024 * 1024 * 1024
MINIMUM_PEAK_DB_RANGE = (-160.0, 60.0)
# A live recorder uploads a chunk every second and a live archived scan writes
# candidates or traces every sweep, so two quiet minutes means the browser is gone.
STALE_RECORDING_SECONDS = 120
RECOVERY_INTERVAL_SECONDS = 15
PLAYABLE_AUDIO_STATUSES = frozenset({"complete", "partial", "interrupted"})
DEFAULT_DATA_DIR = Path.home() / ".local" / "share" / "sdr-doa-ground-console"
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_MANAGED_FILE_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:part|webm|duration)$")
_TIME_ZONE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_+\-]*(?:/[A-Za-z0-9_+\-]+)*$")
_UTC_TIME_ZONES = frozenset({
    "UTC", "UCT", "GMT", "Zulu", "Universal", "Greenwich",
    "Etc/UTC", "Etc/UCT", "Etc/GMT", "Etc/Zulu", "Etc/Universal", "Etc/Greenwich",
})
# Chromium still reports some pre-2014 names that distro tzdata builds without
# the "backward" links do not ship; each pair is tried in both directions.
_LEGACY_TIME_ZONES = {
    "Asia/Calcutta": "Asia/Kolkata",
    "Asia/Saigon": "Asia/Ho_Chi_Minh",
    "Europe/Kiev": "Europe/Kyiv",
    "Asia/Katmandu": "Asia/Kathmandu",
    "Asia/Rangoon": "Asia/Yangon",
    "Asia/Dacca": "Asia/Dhaka",
    "Asia/Ulan_Bator": "Asia/Ulaanbaatar",
    "Asia/Thimbu": "Asia/Thimphu",
    "Asia/Macao": "Asia/Macau",
    "Asia/Ujung_Pandang": "Asia/Makassar",
    "Asia/Chungking": "Asia/Chongqing",
    "Atlantic/Faeroe": "Atlantic/Faroe",
    "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
    "America/Indianapolis": "America/Indiana/Indianapolis",
    "America/Louisville": "America/Kentucky/Louisville",
    "America/Godthab": "America/Nuuk",
    "Pacific/Truk": "Pacific/Chuuk",
    "Pacific/Ponape": "Pacific/Pohnpei",
    "Pacific/Enderbury": "Pacific/Kanton",
}


class ReceiverConflictError(ValueError):
    """A write would silently replace or collide with another stored item."""


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


def _utc_offset_minutes(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ValueError("utc_offset_minutes must be an integer")
    try:
        minutes = int(value)
    except (OverflowError, ValueError) as exc:
        raise ValueError("utc_offset_minutes must be an integer") from exc
    if not -18 * 60 <= minutes <= 18 * 60:
        raise ValueError("utc_offset_minutes must be between -1080 and 1080")
    return minutes


_TZ_DATABASE_AVAILABLE: Optional[bool] = None


def _tz_database_available() -> bool:
    global _TZ_DATABASE_AVAILABLE
    if _TZ_DATABASE_AVAILABLE is None:
        try:
            ZoneInfo("Europe/London")
            _TZ_DATABASE_AVAILABLE = True
        except (ValueError, ZoneInfoNotFoundError, OSError):
            _TZ_DATABASE_AVAILABLE = False
    return _TZ_DATABASE_AVAILABLE


def _audio_time_zone(value: Any, utc_offset_minutes: Any = None) -> Tuple[tzinfo, bool]:
    """Resolve the browser's zone; the flag is True when a fallback zone was used.

    Without a tz database (Python on Windows without the tzdata package) or for a
    name this database does not know, the browser's current UTC offset is used.
    """
    if not isinstance(value, str) or not value or len(value) > 64 or not _TIME_ZONE_RE.fullmatch(value):
        raise ValueError("time_zone must be a valid IANA time zone")
    offset = _utc_offset_minutes(utc_offset_minutes)
    if value in _UTC_TIME_ZONES:
        return timezone.utc, False
    names = [value]
    if value in _LEGACY_TIME_ZONES:
        names.append(_LEGACY_TIME_ZONES[value])
    names.extend(legacy for legacy, current in _LEGACY_TIME_ZONES.items() if current == value)
    for name in names:
        try:
            return ZoneInfo(name), False
        except (ValueError, ZoneInfoNotFoundError, OSError):
            continue
    if offset is not None:
        return timezone(timedelta(minutes=offset)), True
    if _tz_database_available():
        raise ValueError("time_zone must be a valid IANA time zone")
    return timezone.utc, True


def _overlaps_time_of_day(start: datetime, end: datetime, zone: tzinfo,
                          time_from: Optional[int], time_to: Optional[int]) -> bool:
    """True when [start, end] covers any local minute of the daily window.

    A window whose start is later than its end wraps past midnight (22:00-02:00).
    """
    if (end - start).total_seconds() >= 24 * 3600:
        return True
    window_start = 0 if time_from is None else time_from
    window_end = 24 * 60 - 1 if time_to is None else time_to
    windows = [(window_start, window_end)] if window_start <= window_end else [(window_start, 24 * 60 - 1), (0, window_end)]
    local_start, local_end = start.astimezone(zone), end.astimezone(zone)
    first = local_start.hour * 60 + local_start.minute
    last = local_end.hour * 60 + local_end.minute
    covered = [(first, last)] if local_start.date() == local_end.date() and first <= last else [(first, 24 * 60 - 1), (0, last)]
    return any(a <= d and c <= b for a, b in windows for c, d in covered)


def _segment_interval(segment: Dict[str, Any], now: datetime) -> Optional[Tuple[datetime, datetime]]:
    start = _parse_audio_timestamp(segment.get("started_at"))
    if start is None:
        return None
    ended_at = segment.get("ended_at")
    end = _parse_audio_timestamp(ended_at) if ended_at else now
    if end is None or end < start:
        end = start
    return start, end


# Matroska/WebM element IDs used to give MediaRecorder output a Duration.
_EBML_HEADER_ID = 0x1A45DFA3
_SEGMENT_ID = 0x18538067
_SEEK_HEAD_ID = 0x114D9B74
_CUES_ID = 0x1C53BB6B
_INFO_ID = 0x1549A966
_TIMECODE_SCALE_ID = 0x2AD7B1
_DURATION_ID = 0x4489
_CLUSTER_ID = 0x1F43B675
_CLUSTER_TIMECODE_ID = 0xE7
_SIMPLE_BLOCK_ID = 0xA3
_BLOCK_GROUP_ID = 0xA0
_BLOCK_ID = 0xA1
_SKIPPABLE_STREAM_IDS = frozenset({
    0xA7, 0xAB, 0xAF, 0xBF, 0xEC, 0x5854,  # Position, PrevSize, EncryptedBlock, CRC-32, Void, SilentTracks
    _CUES_ID, 0x1254C367, 0x1043A770, 0x1941A469,  # Cues, Tags, Chapters, Attachments
})
_WEBM_HEAD_BYTES = 1024 * 1024
_WEBM_TAIL_BYTES = 512 * 1024


def _ebml_id(data: bytes, pos: int) -> Tuple[int, int]:
    if pos >= len(data) or data[pos] == 0:
        raise ValueError("invalid EBML element ID")
    length = 9 - data[pos].bit_length()
    if length > 4 or pos + length > len(data):
        raise ValueError("invalid EBML element ID")
    return int.from_bytes(data[pos:pos + length], "big"), length


def _ebml_size(data: bytes, pos: int) -> Tuple[Optional[int], int]:
    if pos >= len(data) or data[pos] == 0:
        raise ValueError("invalid EBML size")
    length = 9 - data[pos].bit_length()
    if pos + length > len(data):
        raise ValueError("invalid EBML size")
    value = data[pos] & ((1 << (8 - length)) - 1)
    for byte in data[pos + 1:pos + length]:
        value = (value << 8) | byte
    return (None if value == (1 << (7 * length)) - 1 else value), length


def _ebml_size_bytes(value: int, length: int) -> bytes:
    if not 1 <= length <= 8 or not 0 <= value < (1 << (7 * length)) - 1:
        raise ValueError("EBML size does not fit")
    return ((1 << (7 * length)) | value).to_bytes(length, "big")


def _webm_info_layout(head: bytes) -> Dict[str, Any]:
    element_id, id_length = _ebml_id(head, 0)
    if element_id != _EBML_HEADER_ID:
        raise ValueError("not a WebM file")
    size, size_length = _ebml_size(head, id_length)
    if size is None:
        raise ValueError("EBML header has no size")
    pos = id_length + size_length + size
    element_id, id_length = _ebml_id(head, pos)
    if element_id != _SEGMENT_ID:
        raise ValueError("WebM Segment not found")
    segment_size_pos = pos + id_length
    segment_size, segment_size_length = _ebml_size(head, segment_size_pos)
    pos = segment_size_pos + segment_size_length
    while pos < len(head):
        element_id, id_length = _ebml_id(head, pos)
        size, size_length = _ebml_size(head, pos + id_length)
        data_start = pos + id_length + size_length
        if element_id in (_SEEK_HEAD_ID, _CUES_ID):
            raise ValueError("indexed WebM files are left unchanged")
        if element_id == _CLUSTER_ID or size is None:
            break
        if element_id == _INFO_ID:
            end = data_start + size
            if end > len(head):
                raise ValueError("WebM Info element is truncated")
            layout: Dict[str, Any] = {
                "segment_size_pos": segment_size_pos,
                "segment_size": segment_size,
                "segment_size_length": segment_size_length,
                "info_size_pos": pos + id_length,
                "info_size_length": size_length,
                "info_size": size,
                "info_data_start": data_start,
                "info_end": end,
                "timecode_scale": 1_000_000,
                "duration_pos": None,
                "duration_length": 0,
            }
            child = data_start
            while child < end:
                child_id, child_id_length = _ebml_id(head, child)
                child_size, child_size_length = _ebml_size(head, child + child_id_length)
                if child_size is None:
                    raise ValueError("WebM Info child has no size")
                child_data = child + child_id_length + child_size_length
                if child_data + child_size > end:
                    raise ValueError("WebM Info child is truncated")
                if child_id == _TIMECODE_SCALE_ID and 0 < child_size <= 8:
                    scale = int.from_bytes(head[child_data:child_data + child_size], "big")
                    if scale > 0:
                        layout["timecode_scale"] = scale
                elif child_id == _DURATION_ID and child_size in (4, 8):
                    layout["duration_pos"] = child_data
                    layout["duration_length"] = child_size
                child = child_data + child_size
            return layout
        pos = data_start + size
    raise ValueError("WebM Info element not found")


def _webm_last_block_timecode(tail: bytes) -> Optional[int]:
    """Latest block timecode in the file tail, in TimecodeScale units."""
    marker = _CLUSTER_ID.to_bytes(4, "big")
    search_end = len(tail)
    while True:
        start = tail.rfind(marker, 0, search_end)
        if start < 0:
            return None
        latest = _webm_cluster_tail_timecode(tail, start)
        if latest is not None:
            return latest
        search_end = start


def _webm_cluster_tail_timecode(data: bytes, start: int) -> Optional[int]:
    pos, cluster_timecode, latest = start, None, None
    try:
        while pos < len(data):
            element_id, id_length = _ebml_id(data, pos)
            size, size_length = _ebml_size(data, pos + id_length)
            data_start = pos + id_length + size_length
            if element_id == _CLUSTER_ID:
                cluster_timecode = None
                pos = data_start
                continue
            if size is None:
                return None
            end = data_start + size
            if end > len(data):
                break
            if element_id == _CLUSTER_TIMECODE_ID:
                cluster_timecode = int.from_bytes(data[data_start:end], "big")
            elif element_id in (_SIMPLE_BLOCK_ID, _BLOCK_GROUP_ID):
                block = data[data_start:end]
                if element_id == _BLOCK_GROUP_ID:
                    group, block, child = block, b"", 0
                    while child < len(group):
                        child_id, child_id_length = _ebml_id(group, child)
                        child_size, child_size_length = _ebml_size(group, child + child_id_length)
                        if child_size is None:
                            return None
                        child_data = child + child_id_length + child_size_length
                        if child_id == _BLOCK_ID:
                            block = group[child_data:child_data + child_size]
                            break
                        child = child_data + child_size
                if block:
                    if cluster_timecode is None:
                        return None
                    _, track_length = _ebml_size(block, 0)
                    if track_length + 2 > len(block):
                        return None
                    relative = int.from_bytes(block[track_length:track_length + 2], "big", signed=True)
                    timecode = cluster_timecode + relative
                    latest = timecode if latest is None else max(latest, timecode)
            elif element_id not in _SKIPPABLE_STREAM_IDS:
                return None
            pos = end
    except ValueError:
        return latest
    return latest


def _apply_webm_duration(path: Path, duration_seconds: float, scratch_path: Path) -> Optional[float]:
    """Give a MediaRecorder WebM file a Duration so players show its length and can seek.

    The duration comes from the last block timestamp when the file tail can be
    parsed, otherwise from the recorder's wall-clock duration. Returns the
    duration written, or None when the file was left unchanged.
    """
    size = path.stat().st_size
    with path.open("rb") as source:
        head = source.read(min(size, _WEBM_HEAD_BYTES))
        source.seek(max(0, size - _WEBM_TAIL_BYTES))
        tail = source.read()
    layout = _webm_info_layout(head)
    scale = layout["timecode_scale"]
    last_timecode = _webm_last_block_timecode(tail)
    if last_timecode is not None and last_timecode >= 0:
        # The last Opus frame lasts about 20 ms beyond its own timestamp.
        duration_seconds = last_timecode * scale / 1e9 + 0.02
    if not isinstance(duration_seconds, (int, float)) or not math.isfinite(duration_seconds) or duration_seconds <= 0:
        return None
    duration_units = duration_seconds * 1e9 / scale
    if layout["duration_pos"] is not None:
        packed = struct.pack(">d" if layout["duration_length"] == 8 else ">f", duration_units)
        with path.open("r+b") as target:
            target.seek(layout["duration_pos"])
            target.write(packed)
            target.flush()
            os.fsync(target.fileno())
        return float(duration_seconds)
    duration_element = _DURATION_ID.to_bytes(2, "big") + _ebml_size_bytes(8, 1) + struct.pack(">d", duration_units)
    new_info_size = layout["info_size"] + len(duration_element)
    try:
        info_size = _ebml_size_bytes(new_info_size, layout["info_size_length"])
    except ValueError:
        info_size = _ebml_size_bytes(new_info_size, 8)
    prefix = bytearray(head[:layout["info_size_pos"]])
    if layout["segment_size"] is not None:
        growth = len(duration_element) + len(info_size) - layout["info_size_length"]
        segment_size = _ebml_size_bytes(layout["segment_size"] + growth, layout["segment_size_length"])
        position = layout["segment_size_pos"]
        prefix[position:position + len(segment_size)] = segment_size
    try:
        with scratch_path.open("wb") as target, path.open("rb") as source:
            target.write(bytes(prefix))
            target.write(info_size)
            target.write(head[layout["info_data_start"]:layout["info_end"]])
            target.write(duration_element)
            source.seek(layout["info_end"])
            shutil.copyfileobj(source, target, 1024 * 1024)
            target.flush()
            os.fsync(target.fileno())
        os.replace(scratch_path, path)
    finally:
        scratch_path.unlink(missing_ok=True)
    return float(duration_seconds)


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
        self._last_recovery = 0.0
        self._initialize()
        with self._lock:
            self.recover_interrupted_recordings()
            self._remove_unreferenced_files()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.db_path, timeout=10)
        try:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            with db:
                yield db
        finally:
            db.close()

    def _initialize(self) -> None:
        with self._lock, self._connect() as db:
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
            for table in ("scans", "audio_sessions"):
                if "last_activity" not in {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN last_activity TEXT")
            db.executescript("""
                CREATE INDEX IF NOT EXISTS candidates_frequency_order ON candidates(scan_id,frequency,candidate_id);
                CREATE INDEX IF NOT EXISTS candidates_peak_order ON candidates(scan_id,peak DESC,candidate_id);
                CREATE INDEX IF NOT EXISTS candidates_snr_order ON candidates(scan_id,snr DESC,candidate_id);
                CREATE INDEX IF NOT EXISTS candidates_hits_order ON candidates(scan_id,hits DESC,candidate_id);
                CREATE INDEX IF NOT EXISTS candidates_interval_order ON candidates(scan_id,low_hz,high_hz,candidate_id);
                CREATE INDEX IF NOT EXISTS candidates_peak_frequency_order ON candidates(scan_id,peak_hz,candidate_id);
                CREATE INDEX IF NOT EXISTS candidates_last_seen_order ON candidates(scan_id,last_seen DESC,candidate_id);
                CREATE INDEX IF NOT EXISTS frames_scan_sweep_order ON frames(scan_id,sweep);
                CREATE INDEX IF NOT EXISTS audio_segments_session_order ON audio_segments(session_id,started_at);
            """)

    def _exists(self, db: sqlite3.Connection, table: str, ident: str) -> bool:
        return db.execute(f"SELECT 1 FROM {table} WHERE id=?", (ident,)).fetchone() is not None

    def _maybe_recover(self) -> None:
        if time.monotonic() - self._last_recovery >= RECOVERY_INTERVAL_SECONDS:
            self.recover_interrupted_recordings()

    def recover_interrupted_recordings(self, stale_seconds: float = STALE_RECORDING_SECONDS,
                                       now: Optional[datetime] = None) -> Dict[str, int]:
        """Finalize audio sessions and archived scans whose browser stopped writing.

        Saved audio is kept and marked "interrupted"; an archived scan gets its
        Records entry with status "interrupted".
        """
        now = now or datetime.now(timezone.utc)
        cutoff = now - timedelta(seconds=stale_seconds)
        recovered = {"audio_sessions": 0, "audio_segments": 0, "scans": 0}
        with self._lock:
            self._last_recovery = time.monotonic()
            with self._connect() as db:
                sessions = db.execute(
                    "SELECT id,started_at,last_activity FROM audio_sessions WHERE finished_at IS NULL"
                ).fetchall()
                scans = db.execute(
                    "SELECT id,started_at,last_activity,metadata FROM scans WHERE finished_at IS NULL"
                ).fetchall()
            for session in sessions:
                activity = _parse_audio_timestamp(session["last_activity"]) or _parse_audio_timestamp(session["started_at"])
                with self._connect() as db:
                    open_segments = db.execute(
                        "SELECT id FROM audio_segments WHERE session_id=? AND finished_at IS NULL", (session["id"],)
                    ).fetchall()
                for segment in open_segments:
                    part = self.temp_dir / f"{segment['id']}.part"
                    try:
                        modified = datetime.fromtimestamp(part.stat().st_mtime, timezone.utc)
                    except OSError:
                        continue
                    activity = modified if activity is None else max(activity, modified)
                if activity is not None and activity > cutoff:
                    continue
                try:
                    recovered["audio_segments"] += self._finalize_open_segments(
                        session["id"],
                        "Recording was interrupted (the Receiver page closed or the console stopped); "
                        "audio was kept up to the last saved chunk.",
                    )
                    with self._connect() as db:
                        db.execute(
                            "UPDATE audio_sessions SET finished_at=?,last_activity=? WHERE id=? AND finished_at IS NULL",
                            (now.isoformat(), now.isoformat(), session["id"]),
                        )
                except (sqlite3.Error, ValueError, OSError):
                    # One damaged session must not stop the console from starting.
                    continue
                recovered["audio_sessions"] += 1
            for scan in scans:
                try:
                    metadata = json.loads(scan["metadata"])
                except (TypeError, ValueError):
                    continue
                if not isinstance(metadata, dict) or not metadata.get("archive"):
                    continue
                activity = _parse_audio_timestamp(scan["last_activity"]) or _parse_audio_timestamp(scan["started_at"])
                if activity is not None and activity > cutoff:
                    continue
                try:
                    with self._connect() as db:
                        self._finish_scan(db, scan["id"], "interrupted", now.isoformat())
                except (sqlite3.Error, ValueError):
                    continue
                recovered["scans"] += 1
        return recovered

    def _remove_unreferenced_files(self) -> None:
        """Delete managed audio files that no database row points to any more."""
        with self._lock:
            with self._connect() as db:
                referenced = {
                    row[0] for row in db.execute(
                        "SELECT temp_name FROM audio_segments WHERE finished_at IS NULL "
                        "UNION SELECT file_name FROM audio_segments WHERE file_name IS NOT NULL "
                        "UNION SELECT temp_name FROM audio_sessions "
                        "UNION SELECT file_name FROM audio_sessions WHERE file_name IS NOT NULL"
                    )
                    if row[0]
                }
            for directory in (self.temp_dir, self.audio_dir):
                for path in directory.iterdir():
                    if path.name in referenced or not _MANAGED_FILE_RE.fullmatch(path.name):
                        continue
                    if path.is_symlink() or not path.is_file():
                        continue
                    try:
                        path.unlink()
                    except OSError:
                        continue

    def _settle_segment_file(self, segment_id: str, temp_name: str, playable_status: str,
                             duration: float) -> Tuple[str, Optional[str], int, float]:
        """Move a segment's temporary file into audio storage.

        Returns (status, file name, bytes, duration). A segment with no saved
        audio becomes "failed"; anything else stays playable.
        """
        temp_path = self._managed_audio_path(self.temp_dir, temp_name, f"{segment_id}.part")
        size = temp_path.stat().st_size if temp_path is not None and temp_path.is_file() else 0
        if size <= 0:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
            return "failed", None, 0, duration
        final_name = f"{segment_id}.webm"
        final_path = self.audio_dir / final_name
        os.replace(temp_path, final_path)
        try:
            written = _apply_webm_duration(final_path, duration, self.temp_dir / f"{segment_id}.duration")
        except (OSError, ValueError, IndexError, OverflowError, struct.error):
            written = None
        return playable_status, final_name, final_path.stat().st_size, duration if written is None else written

    def _finalize_open_segments(self, session_id: str, error: str) -> int:
        """Close every unfinished segment of a session from its saved bytes."""
        with self._connect() as db:
            rows = db.execute(
                "SELECT id,started_at,temp_name,byte_count,metadata FROM audio_segments WHERE session_id=? AND finished_at IS NULL",
                (session_id,),
            ).fetchall()
        for row in rows:
            metadata = json.loads(row["metadata"])
            started = _parse_audio_timestamp(metadata.get("started_at")) or _parse_audio_timestamp(row["started_at"])
            ended = datetime.now(timezone.utc)
            part = self.temp_dir / f"{row['id']}.part"
            try:
                ended = datetime.fromtimestamp(part.stat().st_mtime, timezone.utc)
            except OSError:
                pass
            if started is not None and ended < started:
                ended = started
            duration = (ended - started).total_seconds() if started is not None else 0.0
            try:
                status, file_name, size, duration = self._settle_segment_file(row["id"], row["temp_name"], "interrupted", duration)
                message = error if status != "failed" else "Recording was interrupted before any audio was saved."
            except (OSError, ValueError) as exc:
                status, file_name, size = "failed", None, 0
                message = f"Recording was interrupted and its audio could not be recovered: {exc}"
            metadata.update({
                "ended_at": ended.isoformat(),
                "duration_seconds": duration,
                "status": status,
                "error": message,
            })
            with self._connect() as db:
                db.execute(
                    "UPDATE audio_segments SET finished_at=?,file_name=?,byte_count=?,metadata=? WHERE id=?",
                    (ended.isoformat(), file_name, size, _json(metadata), row["id"]),
                )
                db.execute(
                    "UPDATE audio_sessions SET byte_count=MAX(0,byte_count+?) WHERE id=?",
                    (size - row["byte_count"], session_id),
                )
        return len(rows)

    def get_settings(self) -> Dict[str, Any]:
        with self._lock, self._connect() as db:
            row = db.execute("SELECT value FROM settings WHERE key='auto_spectrum_recording'").fetchone()
        return {"auto_spectrum_recording": json.loads(row["value"]) if row else False}

    def update_settings(self, values: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(values, dict) or set(values) - {"auto_spectrum_recording"}:
            raise ValueError("unsupported setting")
        value = values.get("auto_spectrum_recording", self.get_settings()["auto_spectrum_recording"])
        if not isinstance(value, bool):
            raise ValueError("auto_spectrum_recording must be boolean")
        with self._lock, self._connect() as db:
            db.execute("INSERT INTO settings(key,value) VALUES('auto_spectrum_recording',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (_json(value),))
        return self.get_settings()

    def create_scan(self, source: str = "", config: Optional[Dict[str, Any]] = None, archive: bool = False) -> Dict[str, Any]:
        if not isinstance(source, str) or not isinstance(config, dict) or not isinstance(archive, bool):
            raise ValueError("invalid scan metadata")
        ident, stamp = str(uuid.uuid4()), _now()
        metadata = {"source": source, "config": config, "archive": archive}
        with self._lock, self._connect() as db:
            previous = db.execute("SELECT id,metadata FROM scans").fetchall()
            for row in previous:
                if not json.loads(row["metadata"]).get("archive", False):
                    db.execute("DELETE FROM scans WHERE id=?", (row["id"],))
            db.execute("INSERT INTO scans(id,started_at,metadata,last_activity) VALUES(?,?,?,?)", (ident, stamp, _json(metadata), stamp))
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
        with self._lock, self._connect() as db:
            self._require_scan(db, scan_id)
            db.execute("UPDATE scans SET last_activity=? WHERE id=?", (_now(), scan_id))
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
            low, high = MINIMUM_PEAK_DB_RANGE
            message = f"minimum_peak_db must be finite and between {low:g} and {high:g}"
            if isinstance(minimum_peak_db, bool):
                raise ValueError(message)
            try:
                minimum_peak_db = float(minimum_peak_db)
            except (TypeError, ValueError, OverflowError) as exc:
                raise ValueError(message) from exc
            if not math.isfinite(minimum_peak_db) or not low <= minimum_peak_db <= high:
                raise ValueError(message)
        marker_id = _id(marker_set_id) if marker_set_id is not None else None
        where, params = ["scan_id=?"], [scan_id]
        if minimum_peak_db is not None:
            where.append("peak>=?")
            params.append(minimum_peak_db)
        with self._lock, self._connect() as db:
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
                            MAX(high_hz) OVER (
                                ORDER BY low_hz,CAST(candidate_id AS INTEGER)
                                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                            ) AS previous_end_hz
                        FROM filtered
                    ),
                    marked_ranges AS (
                        SELECT *,
                            CASE
                                WHEN previous_end_hz IS NULL OR low_hz > previous_end_hz
                                THEN 1 ELSE 0
                            END AS starts_range
                        FROM previous_ranges
                    ),
                    numbered_ranges AS (
                        SELECT *,
                            SUM(starts_range) OVER (
                                ORDER BY low_hz,CAST(candidate_id AS INTEGER)
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
        scan_id = _id(scan_id)
        if isinstance(sweep, bool) or not isinstance(sweep, int) or sweep < 0:
            raise ValueError("sweep must be a nonnegative integer")
        if not isinstance(payload, bytes) or len(payload) != TRACE_BYTES:
            raise ValueError("trace must contain exactly 2048 bytes")
        with self._lock, self._connect() as db:
            self._require_scan(db, scan_id)
            settings_enabled = json.loads(db.execute("SELECT value FROM settings WHERE key='auto_spectrum_recording'").fetchone()[0])
            metadata = json.loads(db.execute("SELECT metadata FROM scans WHERE id=?", (scan_id,)).fetchone()[0])
            if not settings_enabled and not metadata.get("archive"):
                return None
            stamp = _now()
            cursor = db.execute("INSERT INTO frames(scan_id,sweep,captured_at,payload) VALUES(?,?,?,?)", (scan_id, sweep, stamp, sqlite3.Binary(zlib.compress(payload))))
            db.execute("UPDATE scans SET last_activity=? WHERE id=?", (stamp, scan_id))
            return int(cursor.lastrowid)

    def finish_scan(self, scan_id: str, status: str, trace_upload_failures: Any = None) -> Dict[str, Any]:
        scan_id = _id(scan_id)
        if status not in {"complete", "stopped", "failed"}:
            raise ValueError("invalid scan status")
        if trace_upload_failures is not None and (
            isinstance(trace_upload_failures, bool) or not isinstance(trace_upload_failures, int)
            or not 0 <= trace_upload_failures <= 1_000_000_000
        ):
            raise ValueError("trace_upload_failures must be a nonnegative integer")
        stamp = _now()
        with self._lock, self._connect() as db:
            self._require_scan(db, scan_id)
            metadata = self._finish_scan(db, scan_id, status, stamp, trace_upload_failures)
        return {"id": scan_id, "scan_id": scan_id, "finished_at": stamp, "status": status, "archive": metadata.get("archive", False)}

    def _finish_scan(self, db: sqlite3.Connection, scan_id: str, status: str, stamp: str,
                     trace_upload_failures: Optional[int] = None) -> Dict[str, Any]:
        metadata = json.loads(db.execute("SELECT metadata FROM scans WHERE id=?", (scan_id,)).fetchone()["metadata"])
        metadata["status"] = status
        if trace_upload_failures is not None:
            metadata["trace_upload_failures"] = trace_upload_failures
        db.execute("UPDATE scans SET finished_at=?,metadata=?,last_activity=? WHERE id=?", (stamp, _json(metadata), stamp, scan_id))
        if metadata.get("archive"):
            db.execute("INSERT INTO records(id,scan_id,created_at,metadata) VALUES(?,?,?,?) ON CONFLICT(scan_id) DO UPDATE SET metadata=excluded.metadata", (scan_id, scan_id, stamp, _json(metadata)))
        return metadata

    def nearest_candidate(self, scan_id: str, frequency_hz: float, limit: int = 1, marker_set_id: Optional[str] = None) -> Dict[str, Any]:
        scan_id = _id(scan_id)
        if not isinstance(frequency_hz, (int, float)) or isinstance(frequency_hz, bool) or not math.isfinite(frequency_hz):
            raise ValueError("near_frequency_hz must be a finite number")
        _, limit = _page(0, limit)
        with self._lock, self._connect() as db:
            self._require_scan(db, scan_id)
            row = db.execute("""SELECT payload, MAX(low_hz-?, ?-high_hz, 0) AS interval_distance
                FROM candidates WHERE scan_id=? AND high_hz>=?-50000 AND low_hz<=?+50000
                ORDER BY interval_distance, candidate_id LIMIT ?""",
                (frequency_hz, frequency_hz, scan_id, frequency_hz, frequency_hz, limit)).fetchall()
        return {"items": [json.loads(item["payload"]) for item in row], "total": len(row), "offset": 0, "limit": limit}

    def scan_info(self, scan_id: str) -> Dict[str, Any]:
        scan_id = _id(scan_id)
        with self._lock, self._connect() as db:
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
                "candidate_count": candidates, "trace_count": traces,
                "trace_upload_failures": int(metadata.get("trace_upload_failures", 0) or 0)}

    def list_traces(self, scan_id: str, offset: int = 0, limit: int = 100, order: str = "asc") -> Dict[str, Any]:
        scan_id = _id(scan_id)
        offset, limit = _page(offset, limit)
        if order not in {"asc", "desc"}:
            raise ValueError("order must be asc or desc")
        with self._lock, self._connect() as db:
            self._require_scan(db, scan_id)
            total = db.execute("SELECT count(*) FROM frames WHERE scan_id=?", (scan_id,)).fetchone()[0]
            rows = db.execute(f"SELECT sweep,captured_at FROM frames WHERE scan_id=? ORDER BY sweep {order.upper()} LIMIT ? OFFSET ?", (scan_id, limit, offset)).fetchall()
        return {"items": [{"sweep": row["sweep"], "created_at": row["captured_at"]} for row in rows], "total": total, "offset": offset, "limit": limit}

    def get_trace(self, scan_id: str, sweep: int) -> bytes:
        scan_id = _id(scan_id)
        if isinstance(sweep, bool) or not isinstance(sweep, int) or sweep < 0:
            raise ValueError("sweep must be a nonnegative integer")
        with self._lock, self._connect() as db:
            row = db.execute("SELECT payload FROM frames WHERE scan_id=? AND sweep=?", (scan_id, sweep)).fetchone()
        if row is None:
            raise KeyError("trace not found")
        payload = zlib.decompress(row["payload"])
        if len(payload) != TRACE_BYTES:
            raise OSError("stored trace is corrupt")
        return payload

    @staticmethod
    def _segment_record(segment_id: str, started_at: str, finished_at: Optional[str], byte_count: int,
                        raw_metadata: str) -> Dict[str, Any]:
        metadata = json.loads(raw_metadata)
        record = {
            "id": segment_id,
            **metadata,
            "started_at": metadata.get("started_at", started_at),
            "ended_at": metadata.get("ended_at", finished_at) if finished_at else None,
            "bytes": byte_count,
        }
        if finished_at is None:
            record["status"] = "recording"
            record["duration_seconds"] = None
        return record

    def list_records(self, offset: int = 0, limit: int = 100, record_type: Optional[str] = None) -> Dict[str, Any]:
        offset, limit = _page(offset, limit, maximum=200)
        if record_type not in (None, "scan", "audio-session"):
            raise ValueError("record type must be scan or audio-session")
        self._maybe_recover()
        with self._lock, self._connect() as db:
            if record_type == "scan":
                total = db.execute("SELECT count(*) FROM records").fetchone()[0]
            elif record_type == "audio-session":
                total = db.execute("SELECT count(*) FROM audio_sessions").fetchone()[0]
            else:
                total = db.execute("SELECT (SELECT count(*) FROM records)+(SELECT count(*) FROM audio_sessions)").fetchone()[0]
            rows_query = """SELECT type,id,created_at,completed_at,metadata,scan_id FROM (
                SELECT 'scan' AS type,r.id,s.started_at AS created_at,s.finished_at AS completed_at,s.metadata AS metadata,s.id AS scan_id
                FROM records r JOIN scans s ON s.id=r.scan_id
                UNION ALL
                SELECT 'audio-session',id,started_at,finished_at,metadata,NULL FROM audio_sessions
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
                    config = metadata.get("config", {})
                    results.append({"type": "scan", "id": row["id"], "created_at": row["created_at"], "completed_at": row["completed_at"],
                        "source": metadata.get("source", ""), "status": metadata.get("status", "running"), "archive": bool(metadata.get("archive")),
                        "start_hz": config.get("start_hz", config.get("startHz")),
                        "end_hz": config.get("end_hz", config.get("endHz")),
                        "candidate_count": db.execute("SELECT count(*) FROM candidates WHERE scan_id=?", (scan_id,)).fetchone()[0],
                        "trace_count": db.execute("SELECT count(*) FROM frames WHERE scan_id=?", (scan_id,)).fetchone()[0],
                        "trace_upload_failures": int(metadata.get("trace_upload_failures", 0) or 0)})
                else:
                    segments = db.execute("SELECT id,started_at,finished_at,byte_count,metadata FROM audio_segments WHERE session_id=? ORDER BY started_at", (row["id"],)).fetchall()
                    results.append({"type": "audio-session", "id": row["id"], "created_at": row["created_at"], "completed_at": row["completed_at"],
                        "segments": [
                            self._segment_record(seg["id"], seg["started_at"], seg["finished_at"], seg["byte_count"], seg["metadata"])
                            for seg in segments
                        ]})
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
            "utc_offset_minutes",
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
        time_zone_name = text_filter("time_zone")
        time_zone = (
            _audio_time_zone(time_zone_name, filter_values.get("utc_offset_minutes"))[0]
            if time_zone_name is not None else None
        )
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

        self._maybe_recover()
        now = datetime.now(timezone.utc)
        with self._lock, self._connect() as db:
            rows = db.execute(
                """SELECT a.id AS session_id,a.started_at AS session_started_at,a.finished_at AS session_finished_at,
                    g.id AS segment_id,g.started_at AS segment_started_at,g.finished_at AS segment_finished_at,
                    g.byte_count AS segment_bytes,g.metadata AS segment_metadata
                FROM audio_sessions a LEFT JOIN audio_segments g ON g.session_id=a.id
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

            segment = self._segment_record(
                row["segment_id"], row["segment_started_at"], row["segment_finished_at"],
                row["segment_bytes"], row["segment_metadata"],
            )
            if lower_bound is not None or upper_bound is not None or time_from is not None or time_to is not None:
                interval = _segment_interval(segment, now)
                if interval is None:
                    continue
                segment_start, segment_end = interval
                if lower_bound is not None and segment_end < lower_bound:
                    continue
                if upper_bound is not None and segment_start >= upper_bound:
                    continue
                if (time_from is not None or time_to is not None) and time_zone is not None and not _overlaps_time_of_day(
                    segment_start, segment_end, time_zone, time_from, time_to,
                ):
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

    def audio_record_facets(self, time_zone: str, utc_offset_minutes: Any = None) -> Dict[str, Any]:
        zone, fallback = _audio_time_zone(time_zone, utc_offset_minutes)
        self._maybe_recover()
        now = datetime.now(timezone.utc)
        with self._lock, self._connect() as db:
            rows = db.execute(
                """SELECT g.started_at AS segment_started_at,g.finished_at AS segment_finished_at,g.metadata AS segment_metadata
                FROM audio_sessions a JOIN audio_segments g ON g.session_id=a.id"""
            ).fetchall()

        available_dates = set()
        vfo_indices = set()
        modes = set()
        bandwidths = set()
        minimum_frequency = None
        maximum_frequency = None
        for row in rows:
            metadata = json.loads(row["segment_metadata"])
            interval = _segment_interval({
                "started_at": metadata.get("started_at", row["segment_started_at"]),
                "ended_at": metadata.get("ended_at", row["segment_finished_at"]) if row["segment_finished_at"] else None,
            }, now)
            if interval is not None:
                day = interval[0].astimezone(zone).date()
                last_day = interval[1].astimezone(zone).date()
                for _ in range(62):
                    available_dates.add(day.isoformat())
                    if day >= last_day:
                        break
                    day += timedelta(days=1)

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
            "time_zone_fallback": fallback,
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

    @staticmethod
    def _unlink_audio_files(paths: List[Path]) -> None:
        """Delete files before their rows so a failed delete never orphans audio."""
        for path in paths:
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                raise OSError(
                    f"could not delete audio file {path.name} ({exc.strerror or exc}); the record was kept, try again"
                ) from exc

    def delete_audio_segment(self, segment_id: str) -> bool:
        ident = _id(segment_id)
        with self._lock:
            with self._connect() as db:
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
            self._unlink_audio_files([path for path in (temp_path, audio_path) if path is not None])
            with self._connect() as db:
                db.execute("DELETE FROM audio_segments WHERE id=?", (ident,))
                db.execute(
                    "UPDATE audio_sessions SET byte_count=MAX(0,byte_count-?) WHERE id=?",
                    (row["byte_count"], row["session_id"]),
                )
        return True

    def delete_record(self, record_id: str) -> bool:
        ident = _id(record_id)
        with self._lock:
            with self._connect() as db:
                scan = db.execute("SELECT scan_id FROM records WHERE id=?", (ident,)).fetchone()
                if scan is not None:
                    db.execute("DELETE FROM records WHERE id=?", (ident,))
                    db.execute("DELETE FROM scans WHERE id=?", (scan["scan_id"],))
                    return True
                # A scan that never reached finish has no records row; it is still deletable.
                if db.execute("DELETE FROM scans WHERE id=?", (ident,)).rowcount:
                    return True
                audio = db.execute("SELECT finished_at,temp_name,file_name FROM audio_sessions WHERE id=?", (ident,)).fetchone()
                if audio is None:
                    return False
                if audio["finished_at"] is None:
                    raise ValueError("stop the VFO audio recording before deleting its session")
                segments = db.execute("SELECT id,temp_name,file_name FROM audio_segments WHERE session_id=?", (ident,)).fetchall()
            paths: List[Path] = []
            for segment in segments:
                for directory, stored, expected in (
                    (self.temp_dir, segment["temp_name"], f"{segment['id']}.part"),
                    (self.audio_dir, segment["file_name"], f"{segment['id']}.webm"),
                ):
                    if stored == expected:
                        paths.append(directory / expected)
            if audio["temp_name"] == f"{ident}.part":
                paths.append(self.temp_dir / audio["temp_name"])
            if audio["file_name"] == f"{ident}.webm":
                paths.append(self.audio_dir / audio["file_name"])
            self._unlink_audio_files(paths)
            with self._connect() as db:
                db.execute("DELETE FROM audio_sessions WHERE id=?", (ident,))
        return True

    def create_audio_session(self, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if metadata is not None and not isinstance(metadata, dict):
            raise ValueError("audio session metadata must be an object")
        ident, stamp = str(uuid.uuid4()), _now()
        with self._lock, self._connect() as db:
            db.execute(
                "INSERT INTO audio_sessions(id,started_at,temp_name,metadata,last_activity) VALUES(?,?,?,?,?)",
                (ident, stamp, "", _json(metadata or {}), stamp),
            )
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
            with self._connect() as db:
                row = db.execute("SELECT finished_at FROM audio_sessions WHERE id=?", (session_id,)).fetchone()
                if row is None:
                    raise KeyError("audio session not found")
                if row["finished_at"]:
                    raise ValueError("audio session is finished")
            fd = os.open(temp_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
            try:
                with self._connect() as db:
                    db.execute("INSERT INTO audio_segments(id,session_id,started_at,temp_name,metadata) VALUES(?,?,?,?,?)", (ident, session_id, stamp, temp_name, _json(metadata)))
                    db.execute("UPDATE audio_sessions SET last_activity=? WHERE id=?", (stamp, session_id))
            except Exception:
                temp_path.unlink(missing_ok=True)
                raise
        return {"id": ident, "session_id": session_id, "started_at": stamp}

    def append_segment_audio(self, segment_id: str, payload: bytes) -> Dict[str, int]:
        segment_id = _id(segment_id)
        if not isinstance(payload, bytes) or not payload or len(payload) > MAX_AUDIO_CHUNK_BYTES:
            raise ValueError("audio chunk must be between 1 byte and 1 MiB")
        with self._lock:
            with self._connect() as db:
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
                with self._connect() as db:
                    db.execute("UPDATE audio_sessions SET byte_count=byte_count+?,last_activity=? WHERE id=?", (len(payload), _now(), row["session_id"]))
                    db.execute("UPDATE audio_segments SET byte_count=byte_count+? WHERE id=?", (len(payload), segment_id))
            except Exception:
                with path.open("r+b") as target:
                    target.truncate(prior_size)
                    target.flush()
                    os.fsync(target.fileno())
                raise
            return {
                "session_bytes": row["session_bytes"] + len(payload),
                "segment_bytes": row["segment_bytes"] + len(payload),
                "max_session_bytes": MAX_AUDIO_SESSION_BYTES,
                "max_segment_bytes": MAX_AUDIO_SEGMENT_BYTES,
            }

    def finish_audio_session(self, session_id: str, finalize_open_segments: bool = False) -> Dict[str, Any]:
        """Finish a session; with finalize_open_segments, still-open segments are
        closed from their saved bytes first (used when the Receiver page unloads)."""
        session_id = _id(session_id)
        if not isinstance(finalize_open_segments, bool):
            raise ValueError("finalize_open_segments must be boolean")
        with self._lock:
            with self._connect() as db:
                row = db.execute("SELECT byte_count,finished_at FROM audio_sessions WHERE id=?", (session_id,)).fetchone()
                if row is None:
                    raise KeyError("audio session not found")
                if row["finished_at"]:
                    return {"id": session_id, "finished_at": row["finished_at"], "byte_count": row["byte_count"]}
                unfinished = db.execute("SELECT count(*) FROM audio_segments WHERE session_id=? AND finished_at IS NULL", (session_id,)).fetchone()[0]
            if unfinished:
                if not finalize_open_segments:
                    raise ValueError("all audio segments must be finalized before the session")
                self._finalize_open_segments(
                    session_id,
                    "Recording ended before this segment was closed (page closed or console unreachable); "
                    "audio was kept up to the last saved chunk.",
                )
            stamp = _now()
            with self._connect() as db:
                db.execute("UPDATE audio_sessions SET finished_at=?,last_activity=? WHERE id=?", (stamp, stamp, session_id))
                byte_count = db.execute("SELECT byte_count FROM audio_sessions WHERE id=?", (session_id,)).fetchone()[0]
        return {"id": session_id, "finished_at": stamp, "byte_count": byte_count}

    def finish_segment(self, segment_id: str, details: Dict[str, Any]) -> Dict[str, Any]:
        """Close a segment. A "failed" upload keeps whatever audio was saved as a
        playable "partial" segment; only a segment with no audio is "failed"."""
        segment_id = _id(segment_id)
        if not isinstance(details, dict):
            raise ValueError("segment finish body must be an object")
        ended_at, duration = details.get("ended_at"), details.get("duration_seconds")
        if (not isinstance(ended_at, str) or isinstance(duration, bool) or not isinstance(duration, (int, float))
                or not math.isfinite(duration) or duration < 0):
            raise ValueError("invalid segment finish metadata")
        status = details.get("status", "complete")
        error = details.get("error", "")
        if status not in {"complete", "failed"} or not isinstance(error, str) or len(error) > 2048:
            raise ValueError("invalid segment recording status")
        with self._lock:
            with self._connect() as db:
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
            final_path = self.audio_dir / f"{segment_id}.webm"
            outcome, file_name, size, duration = self._settle_segment_file(
                segment_id, row["temp_name"], "complete" if status == "complete" else "partial", float(duration),
            )
            metadata = json.loads(row["metadata"])
            metadata.update({"ended_at": ended_at, "duration_seconds": duration, "status": outcome})
            if outcome == "complete":
                metadata.pop("error", None)
            elif outcome == "partial":
                metadata["error"] = error or "Audio upload failed; the recording was kept up to the last saved chunk."
            else:
                metadata["error"] = error or "Audio segment recording failed before any audio was saved."
            try:
                with self._connect() as db:
                    db.execute("UPDATE audio_segments SET finished_at=?,file_name=?,byte_count=?,metadata=? WHERE id=?",
                               (ended_at, file_name, size, _json(metadata), segment_id))
                    db.execute("UPDATE audio_sessions SET byte_count=MAX(0,byte_count+?),last_activity=? WHERE id=?",
                               (size - row["byte_count"], _now(), row["session_id"]))
            except Exception:
                if file_name is not None:
                    os.replace(final_path, temp_path)
                raise
        return {"id": segment_id, "ended_at": ended_at, "duration_seconds": duration, "status": outcome}

    def get_segment_audio(self, segment_id: str) -> Tuple[Path, str]:
        segment_id = _id(segment_id)
        with self._lock, self._connect() as db:
            row = db.execute("SELECT file_name,metadata FROM audio_segments WHERE id=? AND finished_at IS NOT NULL", (segment_id,)).fetchone()
        if row is None:
            raise KeyError("audio segment not found")
        metadata = json.loads(row["metadata"])
        if metadata.get("status", "complete") not in PLAYABLE_AUDIO_STATUSES:
            raise KeyError("failed audio segment is not playable")
        name = row["file_name"]
        if name != f"{segment_id}.webm":
            raise OSError("audio file metadata is invalid")
        path = self.audio_dir / name
        if not path.is_file():
            raise KeyError("audio file not found")
        return path, "audio/webm"

    def get_markers(self, marker_id: Optional[str] = None) -> Any:
        with self._lock, self._connect() as db:
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
            normalized.append({"id": marker.get("id") or str(uuid.uuid4()), "frequency_hz": frequency, "power_db": power, "label": marker.get("label", "")})
        overwrite = payload.get("overwrite", False)
        if not isinstance(overwrite, bool):
            raise ValueError("overwrite must be boolean")
        ident = _id(payload["id"]) if payload.get("id") is not None else (str(uuid.uuid4()) if marker_id is None else _id(marker_id))
        name, stamp = payload["name"].strip(), _now()
        with self._lock, self._connect() as db:
            existing = db.execute("SELECT id FROM markers WHERE name=?", (name,)).fetchone()
            if existing is not None and existing["id"] != ident:
                if payload.get("id") is not None or marker_id is not None:
                    raise ReceiverConflictError(f"another marker set is already named {name!r}")
                if not overwrite:
                    raise ReceiverConflictError(f"a marker set named {name!r} already exists")
                ident = existing["id"]
            try:
                db.execute("""INSERT INTO markers(id,name,updated_at,payload) VALUES(?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at,payload=excluded.payload""",
                    (ident, name, stamp, _json({"markers": normalized})))
            except sqlite3.IntegrityError as exc:
                raise ReceiverConflictError(f"another marker set is already named {name!r}") from exc
        return {"id": ident, "name": name, "markers": normalized}

    def delete_markers(self, marker_id: str) -> bool:
        ident = _id(marker_id)
        with self._lock, self._connect() as db:
            return db.execute("DELETE FROM markers WHERE id=?", (ident,)).rowcount > 0

    def close(self) -> None:
        """Connections are operation-scoped; included for server lifecycle symmetry."""


def _page(offset: Any, limit: Any, maximum: int = 100) -> Tuple[int, int]:
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError("offset must be a nonnegative integer")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= maximum:
        raise ValueError(f"limit must be between 1 and {maximum}")
    return offset, limit
