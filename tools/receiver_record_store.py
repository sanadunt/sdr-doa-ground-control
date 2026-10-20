"""Local SQLite-backed Receiver records and audio storage.

Schema version 1 (PRAGMA user_version) adds the Records archive columns:
start_ms/end_ms, normalised frequency, VFO, mode, bandwidth and status,
search text, and exact trace, candidate and byte counts per scan. They are
written with every row and backfilled at start for rows an older console
wrote, so the archive queries never parse JSON. Limits, request parsing and
the ZIP writer live in receiver_archive.py.
"""
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
from dataclasses import replace
from datetime import datetime, timedelta, timezone, tzinfo
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple, Union
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import receiver_archive as ra
from receiver_archive import ArchiveError, ArchiveFilter

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
# Operator text stored in an audio segment's "error". The Receiver's Indonesian text
# matches these exact sentences (browsdr_receiver_overlay/src/client/app/i18n.ts);
# tools/test_receiver_i18n.mjs fails when one has no translation.
SEGMENT_INTERRUPTED_ERROR = (
    "Recording was interrupted (the Receiver page closed or the console stopped); "
    "audio was kept up to the last saved chunk."
)
SEGMENT_UNCLOSED_ERROR = (
    "Recording ended before this segment was closed (page closed or console unreachable); "
    "audio was kept up to the last saved chunk."
)
SEGMENT_INTERRUPTED_EMPTY_ERROR = "Recording was interrupted before any audio was saved."
SEGMENT_UNRECOVERABLE_ERROR = "Recording was interrupted and its audio could not be recovered: {}"
SEGMENT_PARTIAL_ERROR = "Audio upload failed; the recording was kept up to the last saved chunk."
SEGMENT_FAILED_ERROR = "Audio segment recording failed before any audio was saved."
AUDIO_SEGMENT_ERROR_MESSAGES = (
    SEGMENT_INTERRUPTED_ERROR,
    SEGMENT_UNCLOSED_ERROR,
    SEGMENT_INTERRUPTED_EMPTY_ERROR,
    SEGMENT_UNRECOVERABLE_ERROR,
    SEGMENT_PARTIAL_ERROR,
    SEGMENT_FAILED_ERROR,
)
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


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


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


def resolve_time_zone(value: Any, utc_offset_minutes: Any = None) -> Tuple[tzinfo, bool]:
    """The browser's zone for file names and filters; see _audio_time_zone."""
    return _audio_time_zone(value, utc_offset_minutes)


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


# Archive columns added by schema version 1, guarded by PRAGMA table_info.
_SEGMENT_ARCHIVE_COLUMNS = (
    ("start_ms", "INTEGER"),
    ("end_ms", "INTEGER"),
    ("frequency_hz", "REAL"),
    ("vfo_index", "INTEGER"),
    ("mode", "TEXT"),
    ("bandwidth_hz", "REAL"),
    ("status", "TEXT"),
    ("duration_s", "REAL"),
    ("search_text", "TEXT NOT NULL DEFAULT ''"),
)
_SCAN_ARCHIVE_COLUMNS = (
    ("start_ms", "INTEGER"),
    ("end_ms", "INTEGER"),
    ("start_hz", "REAL"),
    ("end_hz", "REAL"),
    ("fft_size", "INTEGER"),
    ("source", "TEXT NOT NULL DEFAULT ''"),
    ("status", "TEXT NOT NULL DEFAULT 'running'"),
    ("archived", "INTEGER NOT NULL DEFAULT 0"),
    ("trace_count", "INTEGER NOT NULL DEFAULT 0"),
    ("candidate_count", "INTEGER NOT NULL DEFAULT 0"),
    ("byte_count", "INTEGER NOT NULL DEFAULT 0"),
    ("search_text", "TEXT NOT NULL DEFAULT ''"),
)
SCHEMA_VERSION = 1
_BACKFILL_BATCH = 500
_FINISHED_AUDIO_STATUSES = ("complete", "partial", "interrupted", "failed")
_FINISHED_SCAN_STATUSES = ("complete", "stopped", "failed", "interrupted")
_MAX_SEGMENT_DURATION_S = 604_800
_MAX_FFT_SIZE = 1_048_576
# Segment and session predicates shared by the retention pass and its preview.
_RETENTION_SEGMENT_SQL = (
    "a.finished_at IS NOT NULL AND g.finished_at IS NOT NULL AND g.end_ms IS NOT NULL AND g.end_ms < :cutoff"
)
_RETENTION_SCAN_SQL = (
    "s.archived=1 AND s.finished_at IS NOT NULL AND s.end_ms IS NOT NULL AND s.end_ms < :cutoff AND s.status!='deleting'"
)
_AUDIO_DOWNLOADABLE_SQL = (
    "g.finished_at IS NOT NULL AND g.file_name IS NOT NULL AND g.byte_count > 0 "
    "AND g.status IN ('complete','partial','interrupted')"
)
_AUDIO_LEG_COLUMNS = (
    "'audio' AS kind, g.id AS id, g.start_ms AS start_ms, g.end_ms AS end_ms, g.duration_s AS duration_s, "
    "g.byte_count AS bytes, g.status AS status, g.frequency_hz AS low_hz, "
    f"(CASE WHEN {_AUDIO_DOWNLOADABLE_SQL} THEN 1 ELSE 0 END) AS downloadable, "
    f"g.byte_count + {ra.ESTIMATE_AUDIO_EXTRA_BYTES} AS estimated_bytes"
)
_SCAN_LEG_COLUMNS = (
    "'scan' AS kind, s.id AS id, s.start_ms AS start_ms, s.end_ms AS end_ms, "
    "(CASE WHEN s.end_ms IS NULL OR s.start_ms IS NULL THEN NULL ELSE (s.end_ms - s.start_ms) / 1000.0 END) AS duration_s, "
    "s.byte_count AS bytes, s.status AS status, s.start_hz AS low_hz, "
    "(CASE WHEN s.finished_at IS NOT NULL THEN 1 ELSE 0 END) AS downloadable, "
    f"s.trace_count * {ra.ESTIMATE_SCAN_TRACE_BYTES} + s.candidate_count * {ra.ESTIMATE_SCAN_CANDIDATE_BYTES} "
    f"+ {ra.ESTIMATE_SCAN_EXTRA_BYTES} AS estimated_bytes"
)
_SORT_COLUMNS = {
    "start": "start_ms",
    "end": "COALESCE(end_ms, :now)",
    "duration": "duration_s",
    "frequency": "low_hz",
    "size": "bytes",
    "type": "kind",
    "status": "status",
}


def _stamp_ms(value: Any) -> Optional[int]:
    """Epoch ms of an ISO stamp with a zone, or None."""
    parsed = _parse_audio_timestamp(value)
    if parsed is None:
        return None
    milliseconds = ra.ms_from_datetime(parsed)
    return milliseconds if 0 <= milliseconds <= ra.MAX_MS else None


def _loads_dict(raw: Any) -> Dict[str, Any]:
    try:
        value = json.loads(raw) if isinstance(raw, (str, bytes)) else None
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _finite_float(value: Any) -> Optional[float]:
    return float(value) if _finite_number(value) else None


def _segment_archive_values(ident: str, started_at: Any, finished_at: Any, metadata: Dict[str, Any],
                            has_file: bool, fallback_ms: int) -> Dict[str, Any]:
    """Archive columns of a segment, normalised the same way for new rows and the backfill."""
    start = _stamp_ms(started_at)
    if start is None:
        start = _stamp_ms(metadata.get("started_at"))
    if start is None:
        # No parseable time: the migration time, so retention never removes the row early.
        start = fallback_ms
    duration = metadata.get("duration_seconds")
    duration_valid = _finite_number(duration) and duration >= 0
    if finished_at is None:
        end = None
        status = "recording"
    else:
        if duration_valid and duration <= _MAX_SEGMENT_DURATION_S:
            end = start + round(duration * 1000)
        else:
            finished = _stamp_ms(finished_at)
            end = max(start, finished) if finished is not None else start
        raw_status = metadata.get("status")
        if raw_status is None:
            status = "complete" if has_file else "failed"
        else:
            status = raw_status if raw_status in _FINISHED_AUDIO_STATUSES else "failed"
    if finished_at is None:
        duration_s = None
    elif duration_valid:
        duration_s = float(duration)
    else:
        duration_s = (end - start) / 1000
    vfo_index = ra.normalize_vfo_index(metadata.get("vfo_index"))
    mode = ra.normalize_mode(metadata.get("mode"))
    frequency = _finite_float(metadata.get("frequency_hz"))
    return {
        "start_ms": start,
        "end_ms": end,
        "frequency_hz": frequency,
        "vfo_index": vfo_index,
        "mode": mode,
        "bandwidth_hz": _finite_float(metadata.get("bandwidth_hz")),
        "status": status,
        "duration_s": duration_s,
        "search_text": ra.audio_search_text(ident, vfo_index, mode, frequency),
    }


def _scan_config_values(ident: str, metadata: Dict[str, Any]) -> Dict[str, Any]:
    config = metadata.get("config")
    if not isinstance(config, dict):
        config = {}

    def first_finite(*keys: str) -> Optional[float]:
        for key in keys:
            value = _finite_float(config.get(key))
            if value is not None:
                return value
        return None

    start_hz, end_hz = first_finite("startHz", "start_hz"), first_finite("endHz", "end_hz")
    fft_size = config.get("fftSize")
    if isinstance(fft_size, bool) or not isinstance(fft_size, int) or not 1 <= fft_size <= _MAX_FFT_SIZE:
        fft_size = None
    source = ra.normalize_source(metadata.get("source"))
    return {
        "start_hz": start_hz,
        "end_hz": end_hz,
        "fft_size": fft_size,
        "source": source,
        "search_text": ra.scan_search_text(ident, source, start_hz, end_hz),
    }


def _scan_archive_values(ident: str, started_at: Any, finished_at: Any, last_activity: Any,
                         metadata: Dict[str, Any], has_record: bool, fallback_ms: int) -> Dict[str, Any]:
    start = _stamp_ms(started_at)
    if start is None:
        start = fallback_ms
    if finished_at is None:
        status, end = "running", None
    else:
        raw_status = metadata.get("status")
        status = raw_status if raw_status in _FINISHED_SCAN_STATUSES else "complete"
        # Recovery stamps finished_at when it runs, which can be days after the
        # last trace; an interrupted scan ends at its last activity.
        candidates = (last_activity, finished_at) if status == "interrupted" else (finished_at,)
        end = None
        for candidate in candidates:
            end = _stamp_ms(candidate)
            if end is not None:
                break
        end = start if end is None else max(start, end)
    return {
        "start_ms": start,
        "end_ms": end,
        "status": status,
        "archived": 1 if has_record or metadata.get("archive") is True else 0,
        **_scan_config_values(ident, metadata),
    }


def _like_pattern(text: str) -> str:
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _chunks(values: Sequence[Any], size: int) -> Iterator[Sequence[Any]]:
    for index in range(0, len(values), size):
        yield values[index:index + size]


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

    def __init__(self, data_dir: Union[os.PathLike, str] = DEFAULT_DATA_DIR,
                 clock: Optional[Callable[[], datetime]] = None,
                 log: Optional[Callable[[str], None]] = None):
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.audio_dir = self.data_dir / "audio"
        self.temp_dir = self.data_dir / "tmp"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.audio_dir.mkdir(exist_ok=True)
        self.temp_dir.mkdir(exist_ok=True)
        self.db_path = self.data_dir / "receiver.sqlite3"
        # Every time the store writes or compares goes through this clock (an
        # aware UTC datetime), so a test clock moves stamps and recovery alike.
        self.clock: Callable[[], datetime] = clock or _utc_now
        # Monotonic time for the retention pass budget; tests may replace it.
        self.monotonic: Callable[[], float] = time.monotonic
        self.log = log
        self._lock = threading.RLock()
        # One retention pass at a time; a second caller returns at once.
        self._retention_mutex = threading.Lock()
        self._last_recovery = 0.0
        self._initialize()
        self._migrate()
        self._backfill_archive_columns()
        self._finish_interrupted_scan_deletes()
        with self._lock:
            self.recover_interrupted_recordings()
            self._remove_unreferenced_files()

    def _now(self) -> str:
        return self.clock().astimezone(timezone.utc).isoformat()

    def _now_ms(self) -> int:
        return ra.ms_from_datetime(self.clock())

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

    def _migrate(self) -> None:
        """Schema version 0 to 1 in one transaction; a failure rolls back and the next start retries."""
        with self._lock:
            db = sqlite3.connect(self.db_path, timeout=10, isolation_level=None)
            try:
                if db.execute("PRAGMA user_version").fetchone()[0] >= SCHEMA_VERSION:
                    return
                db.execute("BEGIN IMMEDIATE")
                try:
                    for table, columns in (("audio_segments", _SEGMENT_ARCHIVE_COLUMNS), ("scans", _SCAN_ARCHIVE_COLUMNS)):
                        existing = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
                        for name, declaration in columns:
                            if name not in existing:
                                db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")
                    for statement in (
                        "CREATE INDEX IF NOT EXISTS audio_segments_start_ms ON audio_segments(start_ms)",
                        "CREATE INDEX IF NOT EXISTS audio_segments_end_ms ON audio_segments(end_ms)",
                        "CREATE INDEX IF NOT EXISTS scans_start_ms ON scans(start_ms)",
                        "CREATE INDEX IF NOT EXISTS scans_end_ms ON scans(end_ms)",
                        "INSERT OR IGNORE INTO settings(key,value) VALUES('retention_days','null')",
                        "INSERT OR IGNORE INTO settings(key,value) VALUES('retention_last_run','null')",
                        f"PRAGMA user_version={SCHEMA_VERSION}",
                    ):
                        db.execute(statement)
                    db.execute("COMMIT")
                except BaseException:
                    try:
                        db.execute("ROLLBACK")
                    except sqlite3.Error:
                        pass
                    raise
            finally:
                db.close()

    def _backfill_archive_columns(self) -> None:
        """Fill the archive columns of rows an older console wrote (start_ms NULL), 500 per transaction.

        Runs at every start, so rows written after a downgrade are caught too.
        """
        fallback_ms = self._now_ms()
        last_row_id = 0
        while True:
            with self._lock, self._connect() as db:
                rows = db.execute(
                    "SELECT rowid AS row_id,id,started_at,finished_at,file_name,metadata FROM audio_segments "
                    "WHERE rowid>? AND (start_ms IS NULL OR (finished_at IS NOT NULL AND end_ms IS NULL)) "
                    "ORDER BY rowid LIMIT ?",
                    (last_row_id, _BACKFILL_BATCH),
                ).fetchall()
                if not rows:
                    break
                last_row_id = int(rows[-1]["row_id"])
                updates = []
                for row in rows:
                    values = _segment_archive_values(
                        row["id"], row["started_at"], row["finished_at"], _loads_dict(row["metadata"]),
                        row["file_name"] is not None, fallback_ms,
                    )
                    updates.append({**values, "row_id": row["row_id"]})
                db.executemany(
                    "UPDATE audio_segments SET start_ms=:start_ms,end_ms=:end_ms,frequency_hz=:frequency_hz,"
                    "vfo_index=:vfo_index,mode=:mode,bandwidth_hz=:bandwidth_hz,status=:status,"
                    "duration_s=:duration_s,search_text=:search_text WHERE rowid=:row_id",
                    updates,
                )
        last_row_id = 0
        while True:
            with self._lock, self._connect() as db:
                rows = db.execute(
                    "SELECT rowid AS row_id,id,started_at,finished_at,last_activity,metadata FROM scans "
                    "WHERE rowid>? AND status!='deleting' AND (start_ms IS NULL OR (finished_at IS NOT NULL AND end_ms IS NULL)) "
                    "ORDER BY rowid LIMIT ?",
                    (last_row_id, _BACKFILL_BATCH),
                ).fetchall()
                if not rows:
                    break
                last_row_id = int(rows[-1]["row_id"])
                ids = [row["id"] for row in rows]
                marks = ",".join("?" * len(ids))
                frames = {
                    item[0]: (item[1], item[2]) for item in db.execute(
                        f"SELECT scan_id,count(*),coalesce(sum(length(payload)),0) FROM frames WHERE scan_id IN ({marks}) GROUP BY scan_id",
                        ids,
                    )
                }
                candidates = {
                    item[0]: (item[1], item[2]) for item in db.execute(
                        f"SELECT scan_id,count(*),coalesce(sum(length(payload)),0) FROM candidates WHERE scan_id IN ({marks}) GROUP BY scan_id",
                        ids,
                    )
                }
                records = {item[0] for item in db.execute(f"SELECT scan_id FROM records WHERE scan_id IN ({marks})", ids)}
                updates = []
                for row in rows:
                    values = _scan_archive_values(
                        row["id"], row["started_at"], row["finished_at"], row["last_activity"],
                        _loads_dict(row["metadata"]), row["id"] in records, fallback_ms,
                    )
                    trace_count, frame_bytes = frames.get(row["id"], (0, 0))
                    candidate_count, candidate_bytes = candidates.get(row["id"], (0, 0))
                    updates.append({
                        **values,
                        "trace_count": trace_count,
                        "candidate_count": candidate_count,
                        "byte_count": frame_bytes + candidate_bytes,
                        "row_id": row["row_id"],
                    })
                db.executemany(
                    "UPDATE scans SET start_ms=:start_ms,end_ms=:end_ms,start_hz=:start_hz,end_hz=:end_hz,"
                    "fft_size=:fft_size,source=:source,status=:status,archived=:archived,trace_count=:trace_count,"
                    "candidate_count=:candidate_count,byte_count=:byte_count,search_text=:search_text WHERE rowid=:row_id",
                    updates,
                )

    def _finish_interrupted_scan_deletes(self) -> None:
        """A crash during a scan delete leaves it 'deleting'; finish it off."""
        with self._lock, self._connect() as db:
            pending = [row[0] for row in db.execute("SELECT id FROM scans WHERE status='deleting'")]
        for scan_id in pending:
            try:
                self._purge_scan(scan_id)
            except sqlite3.Error:
                continue

    def _begin_scan_delete(self, db: sqlite3.Connection, scan_id: str,
                           check: Optional[Callable[[sqlite3.Row], Optional[str]]] = None) -> Tuple[Optional[str], int]:
        """Mark a scan 'deleting' and drop its records row in the caller's transaction.

        Returns (refusal code or None, byte_count). Listings, previews,
        downloads and retention ignore 'deleting' scans from then on.
        """
        row = db.execute(
            "SELECT id,status,finished_at,archived,end_ms,byte_count FROM scans WHERE id=?", (scan_id,),
        ).fetchone()
        if row is None or row["status"] == "deleting":
            return ra.ARCHIVE_NOT_FOUND, 0
        if check is not None:
            code = check(row)
            if code is not None:
                return code, 0
        db.execute("UPDATE scans SET status='deleting' WHERE id=?", (scan_id,))
        db.execute("DELETE FROM records WHERE scan_id=?", (scan_id,))
        return None, int(row["byte_count"] or 0)

    def _purge_scan(self, scan_id: str) -> None:
        """Delete a 'deleting' scan's frames, then candidates, in short transactions, then the scan.

        The lock is released between batches, so a 300 000-frame delete never
        stalls a live recording's chunk uploads for the whole cascade.
        """
        for table in ("frames", "candidates"):
            while True:
                batch = max(1, int(ra.SCAN_DELETE_BATCH_ROWS))
                with self._lock, self._connect() as db:
                    removed = db.execute(
                        f"DELETE FROM {table} WHERE rowid IN (SELECT rowid FROM {table} WHERE scan_id=? LIMIT ?)",
                        (scan_id, batch),
                    ).rowcount
                if removed < batch:
                    break
        with self._lock, self._connect() as db:
            db.execute("DELETE FROM scans WHERE id=? AND status='deleting'", (scan_id,))

    def _delete_scan(self, scan_id: str,
                     check: Optional[Callable[[sqlite3.Row], Optional[str]]] = None) -> Tuple[Optional[str], int]:
        """The one scan delete path: mark, then purge in batches. Returns (refusal code or None, bytes)."""
        with self._lock, self._connect() as db:
            code, size = self._begin_scan_delete(db, scan_id, check)
        if code is None:
            self._purge_scan(scan_id)
        return code, size

    def _recount_scan(self, db: sqlite3.Connection, scan_id: str) -> None:
        traces, frame_bytes = db.execute(
            "SELECT count(*),coalesce(sum(length(payload)),0) FROM frames WHERE scan_id=?", (scan_id,),
        ).fetchone()
        candidates, candidate_bytes = db.execute(
            "SELECT count(*),coalesce(sum(length(payload)),0) FROM candidates WHERE scan_id=?", (scan_id,),
        ).fetchone()
        db.execute(
            "UPDATE scans SET trace_count=?,candidate_count=?,byte_count=? WHERE id=?",
            (traces, candidates, frame_bytes + candidate_bytes, scan_id),
        )

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
        now = (now or self.clock()).astimezone(timezone.utc)
        cutoff = now - timedelta(seconds=stale_seconds)
        recovered = {"audio_sessions": 0, "audio_segments": 0, "scans": 0}
        with self._lock:
            self._last_recovery = time.monotonic()
            with self._connect() as db:
                sessions = db.execute(
                    "SELECT id,started_at,last_activity FROM audio_sessions WHERE finished_at IS NULL"
                ).fetchall()
                scans = db.execute(
                    "SELECT id,started_at,last_activity FROM scans "
                    "WHERE finished_at IS NULL AND archived=1 AND status!='deleting'"
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
                    recovered["audio_segments"] += self._finalize_open_segments(session["id"], SEGMENT_INTERRUPTED_ERROR)
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
                activity = _parse_audio_timestamp(scan["last_activity"]) or _parse_audio_timestamp(scan["started_at"])
                if activity is not None and activity > cutoff:
                    continue
                try:
                    with self._connect() as db:
                        # The scan ends at its last activity, not at this recovery.
                        self._finish_scan(
                            db, scan["id"], "interrupted", now.isoformat(),
                            end_ms=ra.ms_from_datetime(activity) if activity is not None else None,
                        )
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
                "SELECT id,started_at,start_ms,temp_name,byte_count,metadata FROM audio_segments "
                "WHERE session_id=? AND finished_at IS NULL",
                (session_id,),
            ).fetchall()
        for row in rows:
            metadata = json.loads(row["metadata"])
            started = _parse_audio_timestamp(metadata.get("started_at")) or _parse_audio_timestamp(row["started_at"])
            ended = self.clock().astimezone(timezone.utc)
            end_ms = ra.ms_from_datetime(ended)
            part = self.temp_dir / f"{row['id']}.part"
            try:
                modified = part.stat().st_mtime
            except OSError:
                pass
            else:
                ended = datetime.fromtimestamp(modified, timezone.utc)
                end_ms = int(modified * 1000)
            if row["start_ms"] is not None:
                end_ms = max(int(row["start_ms"]), end_ms)
            if started is not None and ended < started:
                ended = started
            duration = (ended - started).total_seconds() if started is not None else 0.0
            try:
                status, file_name, size, duration = self._settle_segment_file(row["id"], row["temp_name"], "interrupted", duration)
                message = error if status != "failed" else SEGMENT_INTERRUPTED_EMPTY_ERROR
            except (OSError, ValueError) as exc:
                status, file_name, size = "failed", None, 0
                message = SEGMENT_UNRECOVERABLE_ERROR.format(exc)
            metadata.update({
                "ended_at": ended.isoformat(),
                "duration_seconds": duration,
                "status": status,
                "error": message,
            })
            with self._connect() as db:
                db.execute(
                    "UPDATE audio_segments SET finished_at=?,file_name=?,byte_count=?,metadata=?,"
                    "end_ms=?,status=?,duration_s=? WHERE id=?",
                    (ended.isoformat(), file_name, size, _json(metadata), end_ms, status, duration, row["id"]),
                )
                db.execute(
                    "UPDATE audio_sessions SET byte_count=MAX(0,byte_count+?) WHERE id=?",
                    (size - row["byte_count"], session_id),
                )
        return len(rows)

    def _setting(self, db: sqlite3.Connection, key: str) -> Any:
        row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        if row is None:
            return None
        try:
            return json.loads(row["value"])
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _put_setting(db: sqlite3.Connection, key: str, value: Any) -> None:
        db.execute(
            "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, _json(value)),
        )

    @staticmethod
    def _valid_retention_days(value: Any) -> Optional[int]:
        if isinstance(value, bool) or not isinstance(value, int) or value not in ra.RETENTION_DAY_OPTIONS:
            return None
        return value

    def get_settings(self) -> Dict[str, Any]:
        with self._lock, self._connect() as db:
            auto = self._setting(db, "auto_spectrum_recording")
            days = self._setting(db, "retention_days")
            last = self._setting(db, "retention_last_run")
        removed = None
        last_ms = None
        if isinstance(last, dict) and isinstance(last.get("ms"), int):
            last_ms = last["ms"]
            removed = {
                key: (bool(last.get(key)) if key == "more" else int(last.get(key) or 0))
                for key in ("audio", "sessions", "scans", "bytes", "failed", "more")
            }
        return {
            "auto_spectrum_recording": auto if isinstance(auto, bool) else False,
            "retention_days": self._valid_retention_days(days),
            "retention_options": list(ra.RETENTION_DAY_OPTIONS),
            "retention_last_run_ms": last_ms,
            "retention_last_removed": removed,
            "retention_running": self._retention_mutex.locked(),
        }

    def save_settings(self, values: Dict[str, Any]) -> Tuple[Dict[str, Any], bool]:
        """Save settings; returns (settings, whether a new non-null retention value was saved).

        A non-null retention_days that differs from the saved one needs
        confirm: true; the same value, Off (null) or no retention_days needs none.
        """
        if not isinstance(values, dict) or set(values) - {"auto_spectrum_recording", "retention_days", "confirm"}:
            raise ValueError("unsupported setting")
        if "confirm" in values:
            if values["confirm"] is not True:
                raise ValueError("confirm must be true")
            if "retention_days" not in values:
                raise ValueError("confirm goes with retention_days")
        if "auto_spectrum_recording" in values and not isinstance(values["auto_spectrum_recording"], bool):
            raise ValueError("auto_spectrum_recording must be boolean")
        days = ra.parse_retention_days(values["retention_days"]) if "retention_days" in values else None
        changed = False
        with self._lock, self._connect() as db:
            if "retention_days" in values:
                current = self._valid_retention_days(self._setting(db, "retention_days"))
                if days is not None and days != current and values.get("confirm") is not True:
                    raise ArchiveError(
                        400, ra.RETENTION_CONFIRM_REQUIRED,
                        "a new retention_days value needs confirm: true",
                    )
                changed = days is not None and days != current
            if "auto_spectrum_recording" in values:
                self._put_setting(db, "auto_spectrum_recording", values["auto_spectrum_recording"])
            if "retention_days" in values:
                self._put_setting(db, "retention_days", days)
        return self.get_settings(), changed

    def update_settings(self, values: Dict[str, Any]) -> Dict[str, Any]:
        return self.save_settings(values)[0]

    def create_scan(self, source: str = "", config: Optional[Dict[str, Any]] = None, archive: bool = False) -> Dict[str, Any]:
        if not isinstance(source, str) or not isinstance(config, dict) or not isinstance(archive, bool):
            raise ValueError("invalid scan metadata")
        ident, stamp = str(uuid.uuid4()), self._now()
        metadata = {"source": source, "config": config, "archive": archive}
        values = _scan_archive_values(ident, stamp, None, None, metadata, False, self._now_ms())
        with self._lock, self._connect() as db:
            # The previous unarchived scan is Spectrum working data; it goes
            # through the batched delete once the new scan exists.
            previous = [
                row["id"] for row in db.execute("SELECT id FROM scans WHERE archived=0 AND status!='deleting'")
            ]
            for scan_id in previous:
                self._begin_scan_delete(db, scan_id)
            db.execute(
                "INSERT INTO scans(id,started_at,metadata,last_activity,start_ms,start_hz,end_hz,fft_size,source,"
                "status,archived,search_text) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (ident, stamp, _json(metadata), stamp, values["start_ms"], values["start_hz"], values["end_hz"],
                 values["fft_size"], values["source"], "running", 1 if archive else 0, values["search_text"]),
            )
        for scan_id in previous:
            self._purge_scan(scan_id)
        return {"id": ident, "created_at": stamp, "archive": archive}

    def _require_scan(self, db: sqlite3.Connection, scan_id: str) -> sqlite3.Row:
        row = db.execute(
            "SELECT id,archived,finished_at FROM scans WHERE id=? AND status!='deleting'", (_id(scan_id),),
        ).fetchone()
        if row is None:
            raise KeyError("scan not found")
        return row

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
            scan = self._require_scan(db, scan_id)
            db.execute("UPDATE scans SET last_activity=? WHERE id=?", (self._now(), scan_id))
            db.executemany("""INSERT INTO candidates(scan_id,candidate_id,payload,frequency,peak_hz,low_hz,high_hz,peak,snr,hits,last_seen)
                VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scan_id,candidate_id) DO UPDATE SET
                payload=excluded.payload,frequency=excluded.frequency,peak_hz=excluded.peak_hz,
                low_hz=excluded.low_hz,high_hz=excluded.high_hz,
                peak=excluded.peak,snr=excluded.snr,hits=excluded.hits,last_seen=excluded.last_seen""", rows)
            if scan["finished_at"] is not None:
                # A late upload after finish; running scans are counted at finish.
                self._recount_scan(db, scan_id)
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
            scan = self._require_scan(db, scan_id)
            settings_enabled = self._setting(db, "auto_spectrum_recording") is True
            if not settings_enabled and not scan["archived"]:
                return None
            stamp = self._now()
            cursor = db.execute("INSERT INTO frames(scan_id,sweep,captured_at,payload) VALUES(?,?,?,?)", (scan_id, sweep, stamp, sqlite3.Binary(zlib.compress(payload))))
            db.execute("UPDATE scans SET last_activity=? WHERE id=?", (stamp, scan_id))
            if scan["finished_at"] is not None:
                self._recount_scan(db, scan_id)
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
        stamp = self._now()
        with self._lock, self._connect() as db:
            self._require_scan(db, scan_id)
            metadata = self._finish_scan(db, scan_id, status, stamp, trace_upload_failures)
        return {"id": scan_id, "scan_id": scan_id, "finished_at": stamp, "status": status, "archive": metadata.get("archive", False)}

    def _finish_scan(self, db: sqlite3.Connection, scan_id: str, status: str, stamp: str,
                     trace_upload_failures: Optional[int] = None, end_ms: Optional[int] = None) -> Dict[str, Any]:
        row = db.execute("SELECT metadata,start_ms,archived FROM scans WHERE id=?", (scan_id,)).fetchone()
        metadata = json.loads(row["metadata"])
        metadata["status"] = status
        if trace_upload_failures is not None:
            metadata["trace_upload_failures"] = trace_upload_failures
        if end_ms is None:
            end_ms = _stamp_ms(stamp)
        if end_ms is None:
            end_ms = self._now_ms()
        if row["start_ms"] is not None:
            end_ms = max(int(row["start_ms"]), end_ms)
        db.execute(
            "UPDATE scans SET finished_at=?,metadata=?,last_activity=?,end_ms=?,status=? WHERE id=?",
            (stamp, _json(metadata), stamp, end_ms, status, scan_id),
        )
        self._recount_scan(db, scan_id)
        if row["archived"] or metadata.get("archive"):
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
            row = db.execute(
                "SELECT started_at,finished_at,metadata FROM scans WHERE id=? AND status!='deleting'", (scan_id,),
            ).fetchone()
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
        now = self.clock().astimezone(timezone.utc)
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
        now = self.clock().astimezone(timezone.utc)
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
        """Delete one finished segment; its session goes too when it is finished and left empty."""
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
            try:
                self._delete_session_if_empty(row["session_id"])
            except OSError:
                # A legacy session file that cannot go now; retention retries the empty session.
                pass
        return True

    def _session_files(self, db: sqlite3.Connection, ident: str, session: sqlite3.Row) -> List[Path]:
        paths: List[Path] = []
        for segment in db.execute("SELECT id,temp_name,file_name FROM audio_segments WHERE session_id=?", (ident,)):
            for directory, stored, expected in (
                (self.temp_dir, segment["temp_name"], f"{segment['id']}.part"),
                (self.audio_dir, segment["file_name"], f"{segment['id']}.webm"),
            ):
                if stored == expected:
                    paths.append(directory / expected)
        # Sessions written before segments existed kept one session-level file.
        if session["temp_name"] == f"{ident}.part":
            paths.append(self.temp_dir / session["temp_name"])
        if session["file_name"] == f"{ident}.webm":
            paths.append(self.audio_dir / session["file_name"])
        return paths

    def _delete_session(self, ident: str) -> bool:
        """The session delete path: files first (segments and legacy session files), then the rows."""
        with self._lock:
            with self._connect() as db:
                session = db.execute(
                    "SELECT finished_at,temp_name,file_name FROM audio_sessions WHERE id=?", (ident,),
                ).fetchone()
                if session is None:
                    return False
                if session["finished_at"] is None:
                    raise ValueError("stop the VFO audio recording before deleting its session")
                paths = self._session_files(db, ident, session)
            self._unlink_audio_files(paths)
            with self._connect() as db:
                db.execute("DELETE FROM audio_sessions WHERE id=?", (ident,))
        return True

    def _delete_session_if_empty(self, ident: str) -> bool:
        with self._lock:
            with self._connect() as db:
                row = db.execute(
                    "SELECT finished_at FROM audio_sessions a WHERE id=? AND finished_at IS NOT NULL "
                    "AND NOT EXISTS(SELECT 1 FROM audio_segments g WHERE g.session_id=a.id)",
                    (ident,),
                ).fetchone()
            if row is None:
                return False
            return self._delete_session(ident)

    def delete_record(self, record_id: str) -> bool:
        ident = _id(record_id)
        with self._lock:
            with self._connect() as db:
                record = db.execute("SELECT scan_id FROM records WHERE id=?", (ident,)).fetchone()
                # A scan that never reached finish has no records row; it is still deletable.
                scan_id = record["scan_id"] if record is not None else ident
                is_scan = db.execute("SELECT 1 FROM scans WHERE id=?", (scan_id,)).fetchone() is not None
            if is_scan:
                code, _ = self._delete_scan(scan_id)
                return code is None
            return self._delete_session(ident)

    def create_audio_session(self, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if metadata is not None and not isinstance(metadata, dict):
            raise ValueError("audio session metadata must be an object")
        ident, stamp = str(uuid.uuid4()), self._now()
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
        ident, stamp = str(uuid.uuid4()), self._now()
        values = _segment_archive_values(ident, stamp, None, metadata, False, self._now_ms())
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
                    db.execute(
                        "INSERT INTO audio_segments(id,session_id,started_at,temp_name,metadata,start_ms,frequency_hz,"
                        "vfo_index,mode,bandwidth_hz,status,search_text) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                        (ident, session_id, stamp, temp_name, _json(metadata), values["start_ms"], values["frequency_hz"],
                         values["vfo_index"], values["mode"], values["bandwidth_hz"], "recording", values["search_text"]),
                    )
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
                    db.execute("UPDATE audio_sessions SET byte_count=byte_count+?,last_activity=? WHERE id=?", (len(payload), self._now(), row["session_id"]))
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
                self._finalize_open_segments(session_id, SEGMENT_UNCLOSED_ERROR)
            stamp = self._now()
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
                row = db.execute("""SELECT g.session_id,g.started_at,g.start_ms,g.finished_at,g.byte_count,g.temp_name,g.file_name,
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
                metadata["error"] = error or SEGMENT_PARTIAL_ERROR
            else:
                metadata["error"] = error or SEGMENT_FAILED_ERROR
            # finished_at keeps the browser's ended_at (a retried finish answers it
            # again); end_ms is the server clock, never before the server start.
            end_ms = self._now_ms()
            if row["start_ms"] is not None:
                end_ms = max(int(row["start_ms"]), end_ms)
            try:
                with self._connect() as db:
                    db.execute("UPDATE audio_segments SET finished_at=?,file_name=?,byte_count=?,metadata=?,"
                               "end_ms=?,status=?,duration_s=? WHERE id=?",
                               (ended_at, file_name, size, _json(metadata), end_ms, outcome, duration, segment_id))
                    db.execute("UPDATE audio_sessions SET byte_count=MAX(0,byte_count+?),last_activity=? WHERE id=?",
                               (size - row["byte_count"], self._now(), row["session_id"]))
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

    # --- Records archive -------------------------------------------------

    @staticmethod
    def _common_conditions(alias: str, archive_filter: ArchiveFilter, params: Dict[str, Any]) -> List[str]:
        """Time, status and search conditions; an open item ends at :now."""
        conditions = []
        if archive_filter.from_ms is not None and archive_filter.to_ms is not None:
            params["from_ms"], params["to_ms"] = archive_filter.from_ms, archive_filter.to_ms
            conditions.append(
                f"{alias}.start_ms < :to_ms AND ({alias}.end_ms > :from_ms OR ({alias}.end_ms IS NULL AND :now > :from_ms))"
            )
        elif archive_filter.windows:
            parts = []
            for index, (start, end) in enumerate(archive_filter.windows):
                params[f"wa{index}"], params[f"wb{index}"] = start, end
                parts.append(
                    f"({alias}.start_ms < :wb{index} AND ({alias}.end_ms > :wa{index} "
                    f"OR ({alias}.end_ms IS NULL AND :now > :wa{index})))"
                )
            conditions.append("(" + " OR ".join(parts) + ")")
        if archive_filter.status is not None:
            params["status"] = archive_filter.status
            conditions.append(f"{alias}.status = :status")
        if archive_filter.q:
            params["q"] = _like_pattern(archive_filter.q)
            conditions.append(f"{alias}.search_text LIKE :q ESCAPE '\\'")
        return conditions

    def _archive_leg(self, kind: str, archive_filter: ArchiveFilter, params: Dict[str, Any],
                     downloadable_only: bool = False, extra: Sequence[str] = ()) -> Optional[str]:
        """One leg of the archive union, or None when the filter excludes that kind.

        Every value is a bound parameter; only allowlisted SQL text is joined.
        """
        if kind == "audio":
            if not archive_filter.includes_audio:
                return None
            conditions = self._common_conditions("g", archive_filter, params)
            if archive_filter.has_frequency:
                conditions.append("g.frequency_hz IS NOT NULL")
            if archive_filter.min_frequency_hz is not None:
                params["fmin"] = archive_filter.min_frequency_hz
                conditions.append("g.frequency_hz >= :fmin")
            if archive_filter.max_frequency_hz is not None:
                params["fmax"] = archive_filter.max_frequency_hz
                conditions.append("g.frequency_hz <= :fmax")
            if archive_filter.vfo_index is not None:
                params["vfo"] = archive_filter.vfo_index
                conditions.append("g.vfo_index = :vfo")
            if archive_filter.mode is not None:
                params["mode"] = archive_filter.mode
                conditions.append("g.mode = :mode")
            if archive_filter.bandwidth_hz is not None:
                params["bandwidth"] = archive_filter.bandwidth_hz
                conditions.append("g.bandwidth_hz = :bandwidth")
            if downloadable_only:
                conditions.append(_AUDIO_DOWNLOADABLE_SQL)
            conditions.extend(extra)
            where = " WHERE " + " AND ".join(conditions) if conditions else ""
            return f"SELECT {_AUDIO_LEG_COLUMNS} FROM audio_segments g{where}"
        if not archive_filter.includes_scans:
            return None
        # Unarchived scans are Spectrum working data and never listed.
        conditions = ["s.archived=1", "s.status!='deleting'"] + self._common_conditions("s", archive_filter, params)
        if archive_filter.has_frequency:
            conditions.append("s.start_hz IS NOT NULL AND s.end_hz IS NOT NULL")
        if archive_filter.min_frequency_hz is not None:
            params["fmin"] = archive_filter.min_frequency_hz
            conditions.append("s.end_hz >= :fmin")
        if archive_filter.max_frequency_hz is not None:
            params["fmax"] = archive_filter.max_frequency_hz
            conditions.append("s.start_hz <= :fmax")
        if downloadable_only:
            conditions.append("s.finished_at IS NOT NULL")
        conditions.extend(extra)
        return f"SELECT {_SCAN_LEG_COLUMNS} FROM scans s WHERE " + " AND ".join(conditions)

    def _archive_legs(self, archive_filter: ArchiveFilter, now_ms: int,
                      downloadable_only: bool = False) -> Tuple[str, Dict[str, Any]]:
        params: Dict[str, Any] = {"now": now_ms}
        legs = [
            leg for leg in (
                self._archive_leg("audio", archive_filter, params, downloadable_only),
                self._archive_leg("scan", archive_filter, params, downloadable_only),
            ) if leg is not None
        ]
        if not legs:
            legs = [f"SELECT {_AUDIO_LEG_COLUMNS} FROM audio_segments g WHERE 0"]
        return " UNION ALL ".join(legs), params

    @staticmethod
    def _counts(db: sqlite3.Connection, union: str, params: Dict[str, Any]) -> Dict[str, int]:
        totals = {"audio": 0, "scan": 0, "bytes": 0, "estimated_bytes": 0}
        for row in db.execute(
            f"SELECT kind,count(*),coalesce(sum(bytes),0),coalesce(sum(estimated_bytes),0) FROM ({union}) GROUP BY kind",
            params,
        ):
            totals[row[0]] = int(row[1])
            totals["bytes"] += int(row[2])
            totals["estimated_bytes"] += int(row[3])
        return totals

    @staticmethod
    def _audio_item(row: sqlite3.Row) -> Dict[str, Any]:
        metadata = _loads_dict(row["metadata"])
        finished = row["finished_at"] is not None
        playable = bool(
            finished and row["file_name"] is not None and row["byte_count"] > 0
            and row["status"] in ra.PLAYABLE_AUDIO_STATUSES
        )
        error = metadata.get("error")
        codec = metadata.get("codec")
        return {
            "kind": "audio",
            "id": row["id"],
            "session_id": row["session_id"],
            "start": ra.iso_from_ms(row["start_ms"]),
            "end": ra.iso_from_ms(row["end_ms"]),
            "start_ms": row["start_ms"],
            "end_ms": row["end_ms"],
            "duration_s": row["duration_s"],
            "bytes": int(row["byte_count"]),
            "estimated_bytes": ra.export_estimate("audio", row["byte_count"]),
            "status": row["status"],
            "error": error if isinstance(error, str) else "",
            "playable": playable,
            "previewable": playable,
            "downloadable": playable,
            "deletable": finished,
            "vfo_index": row["vfo_index"],
            "frequency_hz": row["frequency_hz"],
            "mode": row["mode"],
            "bandwidth_hz": row["bandwidth_hz"],
            "codec": codec if isinstance(codec, str) else None,
            "source": None,
            "start_hz": None,
            "end_hz": None,
            "fft_size": None,
            "trace_count": None,
            "candidate_count": None,
            "trace_upload_failures": None,
        }

    @staticmethod
    def _scan_item(row: sqlite3.Row) -> Dict[str, Any]:
        metadata = _loads_dict(row["metadata"])
        finished = row["finished_at"] is not None
        failures = metadata.get("trace_upload_failures")
        if isinstance(failures, bool) or not isinstance(failures, int) or failures < 0:
            failures = 0
        error = metadata.get("error")
        duration = None
        if finished and row["end_ms"] is not None and row["start_ms"] is not None:
            duration = (row["end_ms"] - row["start_ms"]) / 1000
        return {
            "kind": "scan",
            "id": row["id"],
            "session_id": None,
            "start": ra.iso_from_ms(row["start_ms"]),
            "end": ra.iso_from_ms(row["end_ms"]),
            "start_ms": row["start_ms"],
            "end_ms": row["end_ms"],
            "duration_s": duration,
            "bytes": int(row["byte_count"]),
            "estimated_bytes": ra.export_estimate("scan", 0, row["trace_count"], row["candidate_count"]),
            "status": row["status"],
            "error": error if isinstance(error, str) else "",
            "playable": False,
            "previewable": bool(finished and row["trace_count"] > 0),
            "downloadable": finished,
            "deletable": finished,
            "vfo_index": None,
            "frequency_hz": None,
            "mode": None,
            "bandwidth_hz": None,
            "codec": None,
            "source": row["source"],
            "start_hz": row["start_hz"],
            "end_hz": row["end_hz"],
            "fft_size": row["fft_size"],
            "trace_count": int(row["trace_count"]),
            "candidate_count": int(row["candidate_count"]),
            "trace_upload_failures": failures,
        }

    def _archive_rows(self, db: sqlite3.Connection, keys: Sequence[Tuple[str, str]]) -> Dict[Tuple[str, str], Dict[str, Any]]:
        """ArchiveItem dicts of the listed (kind, id) pairs that still exist."""
        found: Dict[Tuple[str, str], Dict[str, Any]] = {}
        audio = [ident for kind, ident in keys if kind == "audio"]
        scans = [ident for kind, ident in keys if kind == "scan"]
        for batch in _chunks(audio, 500):
            marks = ",".join("?" * len(batch))
            for row in db.execute(
                "SELECT id,session_id,start_ms,end_ms,duration_s,byte_count,status,frequency_hz,vfo_index,mode,"
                f"bandwidth_hz,metadata,finished_at,file_name FROM audio_segments WHERE id IN ({marks})",
                list(batch),
            ):
                found[("audio", row["id"])] = self._audio_item(row)
        for batch in _chunks(scans, 500):
            marks = ",".join("?" * len(batch))
            for row in db.execute(
                "SELECT id,start_ms,end_ms,byte_count,status,start_hz,end_hz,fft_size,trace_count,candidate_count,"
                f"source,metadata,finished_at FROM scans WHERE id IN ({marks}) AND archived=1 AND status!='deleting'",
                list(batch),
            ):
                found[("scan", row["id"])] = self._scan_item(row)
        return found

    def archive_items(self, archive_filter: ArchiveFilter, sort: str = "start", order: str = "desc",
                      offset: int = 0, limit: int = ra.ITEMS_DEFAULT_LIMIT) -> Dict[str, Any]:
        if sort not in _SORT_COLUMNS or order not in ra.SORT_ORDERS:
            raise ra.invalid("sort or order is not supported")
        if isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= ra.ITEMS_MAX_OFFSET:
            raise ra.invalid(f"offset must be an integer between 0 and {ra.ITEMS_MAX_OFFSET}")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= ra.ITEMS_MAX_LIMIT:
            raise ra.invalid(f"limit must be an integer between 1 and {ra.ITEMS_MAX_LIMIT}")
        self._maybe_recover()
        now_ms = self._now_ms()
        union, params = self._archive_legs(archive_filter, now_ms)
        direction = "ASC" if order == "asc" else "DESC"
        with self._lock, self._connect() as db:
            totals = self._counts(db, union, params)
            page = [
                (row[0], row[1]) for row in db.execute(
                    f"SELECT kind,id FROM ({union}) ORDER BY {_SORT_COLUMNS[sort]} {direction},kind,id "
                    "LIMIT :limit OFFSET :offset",
                    {**params, "limit": limit, "offset": offset},
                )
            ]
            details = self._archive_rows(db, page)
        return {
            "items": [details[key] for key in page if key in details],
            "total": totals["audio"] + totals["scan"],
            "totals": totals,
            "offset": offset,
            "limit": limit,
            "now_ms": now_ms,
        }

    def archive_count(self, archive_filter: ArchiveFilter, downloadable_only: bool = False) -> Dict[str, int]:
        union, params = self._archive_legs(archive_filter, self._now_ms(), downloadable_only)
        with self._lock, self._connect() as db:
            return self._counts(db, union, params)

    def archive_facets(self) -> Dict[str, Any]:
        self._maybe_recover()
        now_ms = self._now_ms()
        limit = ra.FACET_LIMIT
        scans_sql = "FROM scans WHERE archived=1 AND status!='deleting'"
        with self._lock, self._connect() as db:
            vfo_indices = [row[0] for row in db.execute(
                "SELECT DISTINCT vfo_index FROM audio_segments WHERE vfo_index IS NOT NULL ORDER BY vfo_index LIMIT ?", (limit,))]
            modes = [row[0] for row in db.execute(
                "SELECT DISTINCT mode FROM audio_segments WHERE mode IS NOT NULL ORDER BY mode LIMIT ?", (limit,))]
            bandwidths = [row[0] for row in db.execute(
                "SELECT DISTINCT bandwidth_hz FROM audio_segments WHERE bandwidth_hz IS NOT NULL ORDER BY bandwidth_hz LIMIT ?", (limit,))]
            sources = [row[0] for row in db.execute(
                f"SELECT DISTINCT source {scans_sql} AND source!='' ORDER BY source LIMIT ?", (limit,))]
            statuses = [row[0] for row in db.execute(
                f"SELECT status FROM (SELECT status FROM audio_segments UNION SELECT status {scans_sql}) "
                "WHERE status IS NOT NULL ORDER BY status LIMIT ?", (limit,))]
            audio = db.execute(
                "SELECT count(*),coalesce(sum(byte_count),0),min(frequency_hz),max(frequency_hz),min(start_ms),"
                "max(coalesce(end_ms,?)) FROM audio_segments", (now_ms,),
            ).fetchone()
            scan = db.execute(
                f"SELECT count(*),coalesce(sum(byte_count),0),min(start_hz),max(end_hz),min(start_ms),"
                f"max(coalesce(end_ms,?)) {scans_sql}", (now_ms,),
            ).fetchone()
        try:
            free_bytes: Optional[int] = int(shutil.disk_usage(self.data_dir).free)
        except OSError:
            free_bytes = None

        def pick(values: Sequence[Any], choose: Callable[..., Any]) -> Any:
            present = [value for value in values if value is not None]
            return choose(present) if present else None

        return {
            "vfo_indices": vfo_indices,
            "modes": modes,
            "bandwidths_hz": bandwidths,
            "sources": sources,
            "statuses": statuses,
            "min_frequency_hz": pick((audio[2], scan[2]), min),
            "max_frequency_hz": pick((audio[3], scan[3]), max),
            "totals": {"audio": int(audio[0]), "scan": int(scan[0]), "bytes": int(audio[1]) + int(scan[1])},
            "first_ms": pick((audio[4], scan[4]), min),
            "last_ms": pick((audio[5] if audio[0] else None, scan[5] if scan[0] else None), max),
            "free_bytes": free_bytes,
            "now_ms": now_ms,
        }

    def archive_calendar(self, bounds: Sequence[int], kind: str = "all") -> Dict[str, Any]:
        """Per-day counts for the browser's local midnights; an item counts on every day it overlaps."""
        if kind not in ra.TYPE_FILTERS:
            raise ra.invalid("type must be all, audio or scan")
        now_ms = self._now_ms()
        cap = max(1, int(ra.CALENDAR_ROW_CAP))
        archive_filter = ArchiveFilter(from_ms=bounds[0], to_ms=bounds[-1], kind=kind)
        days = {"audio": [0] * (len(bounds) - 1), "scan": [0] * (len(bounds) - 1)}
        truncated = False
        first_ms = last_ms = None
        with self._lock, self._connect() as db:
            for leg_kind in ("audio", "scan"):
                params: Dict[str, Any] = {"now": now_ms}
                leg = self._archive_leg(leg_kind, archive_filter, params)
                if leg is None:
                    continue
                rows = db.execute(
                    f"SELECT start_ms,COALESCE(end_ms,:now) FROM ({leg}) LIMIT :cap", {**params, "cap": cap + 1},
                ).fetchall()
                truncated = truncated or len(rows) > cap
                days[leg_kind] = ra.bucket_days(bounds, ((row[0], row[1]) for row in rows[:cap]))
                span_params: Dict[str, Any] = {"now": now_ms}
                span_leg = self._archive_leg(leg_kind, ArchiveFilter(kind=kind), span_params)
                low, high = db.execute(
                    f"SELECT min(start_ms),max(COALESCE(end_ms,:now)) FROM ({span_leg})", span_params,
                ).fetchone()
                if low is not None:
                    first_ms = low if first_ms is None else min(first_ms, low)
                    last_ms = high if last_ms is None else max(last_ms, high)
        return {
            "days": [{"audio": audio, "scan": scan} for audio, scan in zip(days["audio"], days["scan"])],
            "first_ms": first_ms,
            "last_ms": last_ms,
            "now_ms": now_ms,
            "truncated": truncated,
        }

    def archive_timeline(self, from_ms: int, to_ms: int, archive_filter: ArchiveFilter) -> Dict[str, Any]:
        """Merged busy intervals per kind for one day strip; the filter's own time is ignored."""
        now_ms = self._now_ms()
        cap = max(1, int(ra.TIMELINE_ROW_CAP))
        day_filter = replace(archive_filter.without_time(), from_ms=from_ms, to_ms=to_ms)
        result: Dict[str, Any] = {"from_ms": from_ms, "to_ms": to_ms, "now_ms": now_ms, "audio": [], "scan": [],
                                  "counts": {"audio": 0, "scan": 0}, "truncated": False}
        with self._lock, self._connect() as db:
            for kind in ("audio", "scan"):
                params: Dict[str, Any] = {"now": now_ms}
                leg = self._archive_leg(kind, day_filter, params)
                if leg is None:
                    continue
                rows = db.execute(
                    f"SELECT start_ms,COALESCE(end_ms,:now) FROM ({leg}) ORDER BY start_ms LIMIT :cap",
                    {**params, "cap": cap + 1},
                ).fetchall()
                cut = len(rows) > cap
                count = len(rows) if not cut else int(db.execute(f"SELECT count(*) FROM ({leg})", params).fetchone()[0])
                merged, merged_cut = ra.merge_intervals(((row[0], row[1]) for row in rows[:cap]), from_ms, to_ms)
                result[kind] = merged
                result["counts"][kind] = count
                result["truncated"] = result["truncated"] or cut or merged_cut
        return result

    def resolve_selection(self, selection: "ra.Selection", cap: int,
                          downloadable_only: bool = False) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], int]:
        """Rows of an export or delete selection: (rows, missing, matching total).

        Explicit ids: unknown ones go to missing ('not_found'), and with
        downloadable_only so do ones that cannot be downloaded. A filter must
        still match expected_count, and at most cap rows may be selected.
        """
        now_ms = self._now_ms()
        if selection.items is not None:
            with self._lock, self._connect() as db:
                found = self._archive_rows(db, selection.items)
            rows, missing = [], []
            for kind, ident in selection.items:
                item = found.get((kind, ident))
                if item is None:
                    missing.append({"kind": kind, "id": ident, "reason": "not_found"})
                elif downloadable_only and not item["downloadable"]:
                    missing.append({"kind": kind, "id": ident, "reason": "not_downloadable"})
                else:
                    rows.append(item)
            return rows, missing, len(found)
        archive_filter = selection.filter
        union, params = self._archive_legs(archive_filter, now_ms)
        with self._lock, self._connect() as db:
            totals = self._counts(db, union, params)
            total = totals["audio"] + totals["scan"]
            if total != selection.expected_count:
                raise ArchiveError(409, ra.ARCHIVE_SELECTION_CHANGED, "the matching records changed", count=total)
            if downloadable_only:
                union, params = self._archive_legs(archive_filter, now_ms, downloadable_only=True)
                downloadable = self._counts(db, union, params)
                selected = downloadable["audio"] + downloadable["scan"]
            else:
                selected = total
            if selected > cap:
                raise ArchiveError(413, ra.ARCHIVE_TOO_MANY_ITEMS, f"at most {cap} records per request",
                                   count=selected, limit=cap)
            keys = [
                (row[0], row[1]) for row in db.execute(
                    f"SELECT kind,id FROM ({union}) ORDER BY start_ms,kind,id LIMIT :cap", {**params, "cap": cap + 1},
                )
            ]
            found = self._archive_rows(db, keys)
        return [found[key] for key in keys if key in found], [], total

    def _delete_segment_batch(self, ids: Sequence[str], cutoff_ms: Optional[int] = None) -> Dict[str, Any]:
        """Delete finished segments: re-checked under the lock, files first, then the rows in one transaction.

        With cutoff_ms (retention) a row that no longer matches the retention
        predicate is left alone silently. An emptied finished session goes too.
        """
        outcome: Dict[str, Any] = {"deleted": [], "bytes": 0, "sessions": 0, "skipped": [], "failed": 0}
        with self._lock:
            with self._connect() as db:
                marks = ",".join("?" * len(ids)) or "NULL"
                rows = {
                    row["id"]: row for row in db.execute(
                        "SELECT g.id,g.session_id,g.finished_at,g.end_ms,g.byte_count,g.temp_name,g.file_name,"
                        "a.finished_at AS session_finished FROM audio_segments g JOIN audio_sessions a "
                        f"ON a.id=g.session_id WHERE g.id IN ({marks})",
                        list(ids),
                    )
                }
            removable = []
            for ident in ids:
                row = rows.get(ident)
                if row is None:
                    if cutoff_ms is None:
                        outcome["skipped"].append(("audio", ident, ra.ARCHIVE_NOT_FOUND))
                    continue
                if row["finished_at"] is None:
                    if cutoff_ms is None:
                        outcome["skipped"].append(("audio", ident, ra.ARCHIVE_ITEM_ACTIVE))
                    continue
                if cutoff_ms is not None and not (
                    row["session_finished"] is not None and row["end_ms"] is not None and row["end_ms"] < cutoff_ms
                ):
                    continue
                try:
                    paths = [
                        path for path in (
                            self._managed_audio_path(self.temp_dir, row["temp_name"], f"{ident}.part"),
                            self._managed_audio_path(self.audio_dir, row["file_name"], f"{ident}.webm"),
                        ) if path is not None
                    ]
                    self._unlink_audio_files(paths)
                except OSError:
                    outcome["failed"] += 1
                    outcome["skipped"].append(("audio", ident, ra.ARCHIVE_STORAGE_ERROR))
                    continue
                removable.append(row)
            if removable:
                try:
                    with self._connect() as db:
                        db.executemany("DELETE FROM audio_segments WHERE id=?", [(row["id"],) for row in removable])
                        for row in removable:
                            db.execute(
                                "UPDATE audio_sessions SET byte_count=MAX(0,byte_count-?) WHERE id=?",
                                (row["byte_count"], row["session_id"]),
                            )
                except sqlite3.Error:
                    outcome["failed"] += len(removable)
                    outcome["skipped"].extend(("audio", row["id"], ra.ARCHIVE_STORAGE_ERROR) for row in removable)
                    return outcome
            outcome["deleted"] = [row["id"] for row in removable]
            outcome["bytes"] = sum(int(row["byte_count"]) for row in removable)
            for session_id in dict.fromkeys(row["session_id"] for row in removable):
                try:
                    if self._delete_session_if_empty(session_id):
                        outcome["sessions"] += 1
                except (OSError, sqlite3.Error, ValueError):
                    outcome["failed"] += 1
        return outcome

    @staticmethod
    def _archive_scan_check(row: sqlite3.Row) -> Optional[str]:
        if not row["archived"]:
            return ra.ARCHIVE_NOT_FOUND
        if row["finished_at"] is None:
            return ra.ARCHIVE_ITEM_ACTIVE
        return None

    def archive_delete(self, entries: Sequence[Tuple[str, str]]) -> Dict[str, Any]:
        """Delete records by id: audio first, then scans, 50 per batch. Marker sets and settings stay."""
        result: Dict[str, Any] = {
            "deleted": {"audio": 0, "scan": 0}, "deleted_scan_ids": [], "sessions": 0, "bytes": 0,
            "skipped": [], "skipped_count": 0,
        }
        skipped: List[Tuple[str, str, str]] = []
        audio = [ident for kind, ident in entries if kind == "audio"]
        scans = [ident for kind, ident in entries if kind == "scan"]
        for batch in _chunks(audio, max(1, int(ra.DELETE_BATCH_ITEMS))):
            try:
                outcome = self._delete_segment_batch(batch)
            except sqlite3.Error:
                skipped.extend(("audio", ident, ra.ARCHIVE_STORAGE_ERROR) for ident in batch)
                continue
            result["deleted"]["audio"] += len(outcome["deleted"])
            result["bytes"] += outcome["bytes"]
            result["sessions"] += outcome["sessions"]
            skipped.extend(outcome["skipped"])
        for batch in _chunks(scans, max(1, int(ra.DELETE_BATCH_ITEMS))):
            for scan_id in batch:
                try:
                    code, size = self._delete_scan(scan_id, self._archive_scan_check)
                except sqlite3.Error:
                    code, size = ra.ARCHIVE_STORAGE_ERROR, 0
                if code is not None:
                    skipped.append(("scan", scan_id, code))
                    continue
                result["deleted"]["scan"] += 1
                result["deleted_scan_ids"].append(scan_id)
                result["bytes"] += size
        result["skipped_count"] = len(skipped)
        result["skipped"] = [
            {"kind": kind, "id": ident, "code": code, "error": ra.ARCHIVE_ERROR_MESSAGES[code]}
            for kind, ident, code in skipped[:ra.SKIPPED_REPORT_LIMIT]
        ]
        return result

    def archive_audio_entry(self, segment_id: str) -> Dict[str, Any]:
        ident = _id(segment_id)
        with self._lock, self._connect() as db:
            row = db.execute(
                "SELECT id,session_id,start_ms,end_ms,duration_s,byte_count,status,frequency_hz,vfo_index,mode,"
                "bandwidth_hz,metadata,finished_at,file_name FROM audio_segments WHERE id=?",
                (ident,),
            ).fetchone()
        if row is None:
            raise ArchiveError(404, ra.ARCHIVE_NOT_FOUND)
        item = self._audio_item(row)
        raw_mode = _loads_dict(row["metadata"]).get("mode")
        item["raw_mode"] = raw_mode if isinstance(raw_mode, str) else None
        return item

    def archive_scan_entry(self, scan_id: str) -> Dict[str, Any]:
        """An archived scan that is not being deleted, with what its export needs."""
        ident = _id(scan_id)
        with self._lock, self._connect() as db:
            row = db.execute(
                "SELECT id,start_ms,end_ms,byte_count,status,start_hz,end_hz,fft_size,trace_count,candidate_count,"
                "source,metadata,finished_at FROM scans WHERE id=? AND archived=1 AND status!='deleting'",
                (ident,),
            ).fetchone()
            if row is None:
                raise ArchiveError(404, ra.ARCHIVE_NOT_FOUND)
            candidate_bytes = db.execute(
                "SELECT coalesce(sum(length(payload)),0) FROM candidates WHERE scan_id=?", (ident,),
            ).fetchone()[0]
        item = self._scan_item(row)
        metadata = _loads_dict(row["metadata"])
        config = metadata.get("config") if isinstance(metadata.get("config"), dict) else {}
        trace_format, supported = ra.trace_format_of(config)
        item.update({
            "config": config,
            "trace_format": trace_format,
            "trace_format_supported": supported,
            "candidate_bytes": int(candidate_bytes),
        })
        return item

    def _scan_alive(self, db: sqlite3.Connection, scan_id: str) -> bool:
        return db.execute("SELECT 1 FROM scans WHERE id=? AND status!='deleting'", (scan_id,)).fetchone() is not None

    def iter_scan_frames(self, scan_id: str, batch: int = 100) -> Iterator[Tuple[int, str, Optional[bytes]]]:
        """(sweep, captured_at, 2048 bytes or None when damaged) in sweep order, 100 rows per locked read.

        Raises ArchiveItemGone when the scan is deleted between batches.
        """
        ident = _id(scan_id)
        last_sweep, last_id = -1, 0
        while True:
            with self._lock, self._connect() as db:
                if not self._scan_alive(db, ident):
                    raise ra.ArchiveItemGone(ident)
                rows = db.execute(
                    "SELECT id,sweep,captured_at,payload FROM frames WHERE scan_id=? "
                    "AND (sweep>? OR (sweep=? AND id>?)) ORDER BY sweep,id LIMIT ?",
                    (ident, last_sweep, last_sweep, last_id, batch),
                ).fetchall()
            for row in rows:
                yield int(row["sweep"]), row["captured_at"], ra.inflate_trace(row["payload"])
            if len(rows) < batch:
                return
            last_sweep, last_id = int(rows[-1]["sweep"]), int(rows[-1]["id"])

    def iter_scan_candidates(self, scan_id: str, batch: int = 500) -> Iterator[str]:
        """Stored candidate payloads (JSON text) in frequency order, 500 rows per locked read."""
        ident = _id(scan_id)
        key: Optional[Tuple[float, str]] = None
        while True:
            with self._lock, self._connect() as db:
                if not self._scan_alive(db, ident):
                    raise ra.ArchiveItemGone(ident)
                if key is None:
                    rows = db.execute(
                        "SELECT frequency,candidate_id,payload FROM candidates WHERE scan_id=? "
                        "ORDER BY frequency,candidate_id LIMIT ?",
                        (ident, batch),
                    ).fetchall()
                else:
                    rows = db.execute(
                        "SELECT frequency,candidate_id,payload FROM candidates WHERE scan_id=? "
                        "AND (frequency>? OR (frequency=? AND candidate_id>?)) ORDER BY frequency,candidate_id LIMIT ?",
                        (ident, key[0], key[0], key[1], batch),
                    ).fetchall()
            for row in rows:
                yield row["payload"]
            if len(rows) < batch:
                return
            key = (rows[-1]["frequency"], rows[-1]["candidate_id"])

    def archive_scan_preview(self, scan_id: str) -> Dict[str, Any]:
        """Max and mean of at most 256 evenly spaced traces, reduced to 512 bins, and the top candidates."""
        ident = _id(scan_id)
        with self._lock, self._connect() as db:
            row = db.execute(
                "SELECT start_hz,end_hz,metadata FROM scans WHERE id=? AND archived=1 AND finished_at IS NOT NULL "
                "AND status!='deleting'",
                (ident,),
            ).fetchone()
            if row is None:
                raise ArchiveError(404, ra.ARCHIVE_NOT_FOUND)
            trace_count = int(db.execute("SELECT count(*) FROM frames WHERE scan_id=?", (ident,)).fetchone()[0])
            candidate_rows = db.execute(
                "SELECT payload,peak_hz FROM candidates WHERE scan_id=? ORDER BY peak DESC,candidate_id LIMIT ?",
                (ident, ra.PREVIEW_MAX_CANDIDATES),
            ).fetchall()
        config = _loads_dict(row["metadata"]).get("config")
        trace_format, supported = ra.trace_format_of(config)
        picked: List[int] = []
        if supported and trace_count:
            wanted = min(trace_count, ra.PREVIEW_MAX_TRACES)
            positions = sorted({round(index * (trace_count - 1) / max(1, wanted - 1)) for index in range(wanted)})
            targets = iter(positions)
            target = next(targets, None)
            with self._lock, self._connect() as db:
                # (id, sweep) only, through frames_scan_sweep_order.
                for position, (frame_id,) in enumerate(db.execute(
                    "SELECT id FROM frames WHERE scan_id=? ORDER BY sweep,id", (ident,),
                )):
                    if target is None:
                        break
                    if position == target:
                        picked.append(int(frame_id))
                        target = next(targets, None)
        maximum: Optional[List[float]] = None
        total: Optional[List[float]] = None
        used = skipped = 0
        for batch in _chunks(picked, ra.PREVIEW_BATCH):
            marks = ",".join("?" * len(batch))
            with self._lock, self._connect() as db:
                blobs = [item[0] for item in db.execute(f"SELECT payload FROM frames WHERE id IN ({marks})", list(batch))]
            for blob in blobs:
                payload = ra.inflate_trace(blob)
                if payload is None:
                    skipped += 1
                    continue
                levels = ra.decode_trace(payload, trace_format)
                if maximum is None or total is None:
                    maximum, total = list(levels), list(levels)
                else:
                    maximum = list(map(max, maximum, levels))
                    total = [a + b for a, b in zip(total, levels)]
                used += 1
        max_db: List[float] = []
        mean_db: List[float] = []
        if maximum is not None and total is not None and used:
            group = ra.TRACE_BYTES // ra.PREVIEW_BINS
            for bin_index in range(ra.PREVIEW_BINS):
                low = bin_index * group
                max_db.append(round(max(maximum[low:low + group]), 1))
                mean_db.append(round(sum(total[low:low + group]) / (group * used), 1))

        def number(value: Any) -> Optional[float]:
            return float(value) if _finite_number(value) else None

        candidates = []
        for candidate in candidate_rows:
            payload = _loads_dict(candidate["payload"])
            frequency = number(payload.get("peakFrequencyHz"))
            candidates.append({
                "frequency_hz": frequency if frequency is not None else number(candidate["peak_hz"]),
                "peak_db": number(payload.get("peakDb")),
                "snr_db": number(payload.get("snrDb")),
                "bandwidth_hz": number(payload.get("bandwidthHz")),
            })
        return {
            "id": ident,
            "start_hz": row["start_hz"],
            "end_hz": row["end_hz"],
            "bins": ra.PREVIEW_BINS,
            "trace_format": trace_format,
            "trace_count": trace_count,
            "traces_used": used,
            "traces_skipped": skipped,
            "max_db": max_db,
            "mean_db": mean_db,
            "candidates": candidates,
        }

    # --- retention ----------------------------------------------------------

    def _retention_days(self) -> Optional[int]:
        with self._lock, self._connect() as db:
            return self._valid_retention_days(self._setting(db, "retention_days"))

    @staticmethod
    def _empty_old_sessions(rows: Iterable[sqlite3.Row], cutoff_ms: int) -> List[str]:
        old = []
        for row in rows:
            finished = _stamp_ms(row["finished_at"])
            if finished is not None and finished < cutoff_ms:
                old.append(row["id"])
        return old

    def retention_preview(self, days: int, now: Optional[datetime] = None) -> Dict[str, Any]:
        """What apply_retention would remove right now with this limit."""
        if isinstance(days, bool) or not isinstance(days, int) or days not in ra.RETENTION_DAY_OPTIONS:
            raise ArchiveError(400, ra.RETENTION_INVALID)
        now_ms = ra.ms_from_datetime(now or self.clock())
        cutoff = now_ms - days * ra.DAY_MS
        params = {"cutoff": cutoff}
        with self._lock, self._connect() as db:
            audio, audio_bytes = db.execute(
                "SELECT count(*),coalesce(sum(g.byte_count),0) FROM audio_segments g JOIN audio_sessions a "
                f"ON a.id=g.session_id WHERE {_RETENTION_SEGMENT_SQL}", params,
            ).fetchone()
            emptied = db.execute(
                "SELECT count(*) FROM audio_sessions a WHERE a.finished_at IS NOT NULL "
                "AND EXISTS(SELECT 1 FROM audio_segments g WHERE g.session_id=a.id) "
                "AND NOT EXISTS(SELECT 1 FROM audio_segments g WHERE g.session_id=a.id "
                "AND NOT (g.finished_at IS NOT NULL AND g.end_ms IS NOT NULL AND g.end_ms < :cutoff))", params,
            ).fetchone()[0]
            empty_rows = db.execute(
                "SELECT id,finished_at FROM audio_sessions a WHERE a.finished_at IS NOT NULL "
                "AND NOT EXISTS(SELECT 1 FROM audio_segments g WHERE g.session_id=a.id)"
            ).fetchall()
            scans, scan_bytes = db.execute(
                f"SELECT count(*),coalesce(sum(s.byte_count),0) FROM scans s WHERE {_RETENTION_SCAN_SQL}", params,
            ).fetchone()
        return {
            "days": days,
            "cutoff_ms": cutoff,
            "audio": int(audio),
            "sessions": int(emptied) + len(self._empty_old_sessions(empty_rows, cutoff)),
            "scans": int(scans),
            "bytes": int(audio_bytes) + int(scan_bytes),
        }

    def _retention_remaining(self, cutoff: int) -> bool:
        params = {"cutoff": cutoff}
        with self._lock, self._connect() as db:
            if db.execute(
                "SELECT 1 FROM audio_segments g JOIN audio_sessions a ON a.id=g.session_id "
                f"WHERE {_RETENTION_SEGMENT_SQL} LIMIT 1", params,
            ).fetchone() is not None:
                return True
            if db.execute(f"SELECT 1 FROM scans s WHERE {_RETENTION_SCAN_SQL} LIMIT 1", params).fetchone() is not None:
                return True
            empty_rows = db.execute(
                "SELECT id,finished_at FROM audio_sessions a WHERE a.finished_at IS NOT NULL "
                "AND NOT EXISTS(SELECT 1 FROM audio_segments g WHERE g.session_id=a.id)"
            ).fetchall()
        return bool(self._empty_old_sessions(empty_rows, cutoff))

    def apply_retention(self, now: Optional[datetime] = None, budget_s: Optional[float] = None) -> Optional[Dict[str, Any]]:
        """One retention pass: finished items whose end is older than the limit.

        Order: finished segments of finished sessions (an emptied session goes
        with its last segment), then finished sessions already empty before
        the cutoff, then finished archived scans. Never: marker sets, settings,
        open sessions and their segments, running or unarchived scans. Returns
        None when Off or when another pass is running.
        """
        if not self._retention_mutex.acquire(blocking=False):
            return None
        try:
            days = self._retention_days()
            if days is None:
                return None
            now_ms = ra.ms_from_datetime(now or self.clock())
            cutoff = now_ms - days * ra.DAY_MS
            started = self.monotonic()
            limit = max(1, int(ra.RETENTION_MAX_ITEMS_PER_PASS))
            batch_size = max(1, int(ra.RETENTION_CANDIDATE_BATCH))
            result: Dict[str, Any] = {"audio": 0, "sessions": 0, "scans": 0, "bytes": 0, "failed": 0, "more": False}
            handled = 0
            stopped = False

            def exhausted() -> bool:
                return handled >= limit or (budget_s is not None and self.monotonic() - started >= budget_s)

            params: Dict[str, Any] = {"cutoff": cutoff}
            last_end, last_id = -1, ""
            while not stopped:
                if exhausted():
                    stopped = True
                    break
                with self._lock, self._connect() as db:
                    rows = db.execute(
                        "SELECT g.id,g.end_ms FROM audio_segments g JOIN audio_sessions a ON a.id=g.session_id "
                        f"WHERE {_RETENTION_SEGMENT_SQL} AND (g.end_ms>:last_end OR (g.end_ms=:last_end AND g.id>:last_id)) "
                        "ORDER BY g.end_ms,g.id LIMIT :batch",
                        {**params, "last_end": last_end, "last_id": last_id, "batch": batch_size},
                    ).fetchall()
                if not rows:
                    break
                last_end, last_id = int(rows[-1]["end_ms"]), rows[-1]["id"]
                ids = [row["id"] for row in rows][:limit - handled]
                try:
                    outcome = self._delete_segment_batch(ids, cutoff_ms=cutoff)
                except (OSError, sqlite3.Error):
                    result["failed"] += len(ids)
                else:
                    result["audio"] += len(outcome["deleted"])
                    result["bytes"] += outcome["bytes"]
                    result["sessions"] += outcome["sessions"]
                    result["failed"] += outcome["failed"]
                handled += len(ids)

            last_session = ""
            while not stopped:
                if exhausted():
                    stopped = True
                    break
                with self._lock, self._connect() as db:
                    rows = db.execute(
                        "SELECT id,finished_at FROM audio_sessions a WHERE a.finished_at IS NOT NULL "
                        "AND NOT EXISTS(SELECT 1 FROM audio_segments g WHERE g.session_id=a.id) AND a.id>? "
                        "ORDER BY a.id LIMIT ?",
                        (last_session, batch_size),
                    ).fetchall()
                if not rows:
                    break
                last_session = rows[-1]["id"]
                for session_id in self._empty_old_sessions(rows, cutoff):
                    if exhausted():
                        stopped = True
                        break
                    try:
                        if self._delete_session_if_empty(session_id):
                            result["sessions"] += 1
                    except (OSError, sqlite3.Error, ValueError):
                        result["failed"] += 1
                    handled += 1

            last_end, last_id = -1, ""
            while not stopped:
                if exhausted():
                    stopped = True
                    break
                with self._lock, self._connect() as db:
                    rows = db.execute(
                        f"SELECT s.id,s.end_ms FROM scans s WHERE {_RETENTION_SCAN_SQL} "
                        "AND (s.end_ms>:last_end OR (s.end_ms=:last_end AND s.id>:last_id)) ORDER BY s.end_ms,s.id LIMIT :batch",
                        {**params, "last_end": last_end, "last_id": last_id, "batch": batch_size},
                    ).fetchall()
                if not rows:
                    break
                last_end, last_id = int(rows[-1]["end_ms"]), rows[-1]["id"]
                for row in rows:
                    if exhausted():
                        stopped = True
                        break

                    def still_expired(scan: sqlite3.Row) -> Optional[str]:
                        if scan["archived"] and scan["finished_at"] is not None and scan["end_ms"] is not None \
                                and scan["end_ms"] < cutoff:
                            return None
                        return "kept"

                    try:
                        code, size = self._delete_scan(row["id"], still_expired)
                    except sqlite3.Error:
                        result["failed"] += 1
                    else:
                        if code is None:
                            result["scans"] += 1
                            result["bytes"] += size
                    handled += 1
            if stopped:
                result["more"] = self._retention_remaining(cutoff)
            with self._lock, self._connect() as db:
                self._put_setting(db, "retention_last_run", {"ms": now_ms, "days": days, **result})
            if self.log is not None and (result["audio"] or result["scans"] or result["sessions"] or result["failed"]):
                self.log(ra.retention_log_line(days, result))
            return result
        finally:
            self._retention_mutex.release()

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
        name, stamp = payload["name"].strip(), self._now()
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
