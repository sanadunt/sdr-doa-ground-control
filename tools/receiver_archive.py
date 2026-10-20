"""Receiver Records archive: limits, request parsing, exports, ZIP writer, retention timer.

Everything here is standard library only and touches no row directly: the
record store (``receiver_record_store``) and the console (``ground_console``)
import this module, and it imports neither of them.

Limits:

* a ZIP export holds at most 1000 downloadable records and an estimated
  4 GiB (audio: its bytes + 1 KiB; scan: 16 KiB per trace + 1 KiB per
  candidate + 8 KiB); at most 2 ZIPs stream at once; at most 8 prepared
  exports wait for their download, each for 120 s and only once;
* one delete takes at most 2000 records;
* the retention setting is Off or one of 1, 3, 7, 14, 30, 60, 90 days.

The browser passes record ids and filters only, never a path: the server
resolves every selection itself and builds every file name.
"""
from __future__ import annotations

import bisect
import io
import json
import math
import os
import re
import secrets
import threading
import time
import zipfile
import zlib
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone, tzinfo
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

# --- error codes -------------------------------------------------------------

ORIGIN_REJECTED = "ORIGIN_REJECTED"
ARCHIVE_INVALID_REQUEST = "ARCHIVE_INVALID_REQUEST"
ARCHIVE_NOT_FOUND = "ARCHIVE_NOT_FOUND"
ARCHIVE_FILE_MISSING = "ARCHIVE_FILE_MISSING"
ARCHIVE_ITEM_ACTIVE = "ARCHIVE_ITEM_ACTIVE"
ARCHIVE_SELECTION_CHANGED = "ARCHIVE_SELECTION_CHANGED"
ARCHIVE_TOO_MANY_ITEMS = "ARCHIVE_TOO_MANY_ITEMS"
ARCHIVE_EXPORT_TOO_LARGE = "ARCHIVE_EXPORT_TOO_LARGE"
ARCHIVE_EXPORT_BUSY = "ARCHIVE_EXPORT_BUSY"
RETENTION_INVALID = "RETENTION_INVALID"
RETENTION_CONFIRM_REQUIRED = "RETENTION_CONFIRM_REQUIRED"
ARCHIVE_STORAGE_ERROR = "ARCHIVE_STORAGE_ERROR"
ARCHIVE_ERROR_CODES = (
    ORIGIN_REJECTED,
    ARCHIVE_INVALID_REQUEST,
    ARCHIVE_NOT_FOUND,
    ARCHIVE_FILE_MISSING,
    ARCHIVE_ITEM_ACTIVE,
    ARCHIVE_SELECTION_CHANGED,
    ARCHIVE_TOO_MANY_ITEMS,
    ARCHIVE_EXPORT_TOO_LARGE,
    ARCHIVE_EXPORT_BUSY,
    RETENTION_INVALID,
    RETENTION_CONFIRM_REQUIRED,
    ARCHIVE_STORAGE_ERROR,
)
# The operator text of each code. The Receiver shows its own copy
# (records-archive-format.ts ARCHIVE_ERROR_TEXT); a skipped delete carries this.
ARCHIVE_ERROR_MESSAGES = {
    ORIGIN_REJECTED: "Open the Receiver from this console.",
    ARCHIVE_INVALID_REQUEST: "Check the filter values.",
    ARCHIVE_NOT_FOUND: "Record not found. Refresh the list.",
    ARCHIVE_FILE_MISSING: "The audio file is missing.",
    ARCHIVE_ITEM_ACTIVE: "Stop the recording or scan before deleting it.",
    ARCHIVE_SELECTION_CHANGED: "The results changed. Check the selection and try again.",
    ARCHIVE_TOO_MANY_ITEMS: "Too many records selected.",
    ARCHIVE_EXPORT_TOO_LARGE: "The selection is too large for one ZIP.",
    ARCHIVE_EXPORT_BUSY: "Another download is running. Try again when it finishes.",
    RETENTION_INVALID: "Retention value is not supported.",
    RETENTION_CONFIRM_REQUIRED: "Confirm the retention change.",
    ARCHIVE_STORAGE_ERROR: "Receiver storage error.",
}
READ_REJECTED_MESSAGE = "Receiver data is served to this console's own pages only"
MUTATION_REJECTED_MESSAGE = "Receiver mutation requires a same-origin loopback request"

# --- limits ------------------------------------------------------------------

MAX_MS = 253_402_300_799_999  # 9999-12-31T23:59:59.999Z; keeps SQLite integers far below 2**63
MAX_ITEMS_SPAN_MS = 31_622_400_000  # 366 days
MAX_WINDOWS = 62
MAX_WINDOW_MS = 90_000_000  # 25 h
MAX_WINDOWS_TEXT = 2048
MAX_TIMELINE_SPAN_MS = 180_000_000  # 50 h
CALENDAR_MIN_BOUNDS = 2
CALENDAR_MAX_BOUNDS = 43  # 6x7 grid
CALENDAR_MIN_STEP_MS = 3_600_000
CALENDAR_MAX_STEP_MS = 180_000_000
CALENDAR_MAX_TEXT = 1024
CALENDAR_ROW_CAP = 200_000
CALENDAR_MAX_DAYS_PER_ITEM = 42
TIMELINE_ROW_CAP = 100_000
TIMELINE_MAX_INTERVALS = 1500
TIMELINE_MERGE_GAP_MS = 60_000
ITEMS_DEFAULT_LIMIT = 50
ITEMS_MAX_LIMIT = 200
ITEMS_MAX_OFFSET = 1_000_000_000
MAX_SEARCH_TEXT = 64
MAX_FREQUENCY_HZ = 1e12
MAX_BANDWIDTH_HZ = 1e9
MAX_VFO_INDEX = 63
FACET_LIMIT = 64
EXPORT_MAX_ITEMS = 1000
EXPORT_MAX_BYTES = 4 * 1024 ** 3
EXPORT_SLOTS = 2
EXPORT_MAX_PENDING = 8
EXPORT_TTL_S = 120
DELETE_MAX_ITEMS = 2000
DELETE_BATCH_ITEMS = 50
SKIPPED_REPORT_LIMIT = 50
SELECTION_BODY_MAX_BYTES = 256 * 1024
SETTINGS_BODY_MAX_BYTES = 4096
STREAM_WRITE_TIMEOUT_S = 60
STREAM_CHUNK_BYTES = 64 * 1024
# Rows each transaction of a scan delete removes; the store lock is released
# between them so live audio chunk uploads are not stalled.
SCAN_DELETE_BATCH_ROWS = 2000
# Pause between those transactions. Python locks are not fair: without it the
# deleting thread takes the lock straight back and a waiting upload starves.
SCAN_DELETE_PAUSE_S = 0.002
# Export size estimate; records-archive-format.ts uses the same numbers.
ESTIMATE_AUDIO_EXTRA_BYTES = 1024
ESTIMATE_SCAN_TRACE_BYTES = 16 * 1024
ESTIMATE_SCAN_CANDIDATE_BYTES = 1024
ESTIMATE_SCAN_EXTRA_BYTES = 8 * 1024
# An entry whose estimate passes this is opened as ZIP64: zipfile cannot switch
# an entry to ZIP64 after its local header went to an unseekable stream.
ZIP64_ENTRY_THRESHOLD_BYTES = 1024 ** 3

RETENTION_DAY_OPTIONS = (1, 3, 7, 14, 30, 60, 90)
RETENTION_MAX_ITEMS_PER_PASS = 10_000
RETENTION_SYNC_BUDGET_S = 5.0
RETENTION_INTERVAL_S = 3600.0
RETENTION_START_DELAY_S = 60.0
RETENTION_CANDIDATE_BATCH = 100
DAY_MS = 86_400_000

# --- archived traces (sweep-waterfall.ts decodeArchivedTrace) -----------------

TRACE_BYTES = 2048
TRACE_FORMAT_TAG = 1
TRACE_MIN_DB = -160.0
TRACE_MAX_DB = 60.0
LEGACY_TRACE_MAX_DB = 0.0
PREVIEW_BINS = 512
PREVIEW_MAX_TRACES = 256
PREVIEW_BATCH = 32
PREVIEW_MAX_CANDIDATES = 10
TAGGED_DB = tuple(TRACE_MIN_DB + level * (TRACE_MAX_DB - TRACE_MIN_DB) / 255 for level in range(256))
LEGACY_DB = tuple(TRACE_MIN_DB + level * (LEGACY_TRACE_MAX_DB - TRACE_MIN_DB) / 255 for level in range(256))
TAGGED_DB_TEXT = tuple(f"{value:.1f}" for value in TAGGED_DB)
LEGACY_DB_TEXT = tuple(f"{value:.1f}" for value in LEGACY_DB)

# --- records -----------------------------------------------------------------

AUDIO_STATUSES = ("complete", "partial", "interrupted", "failed", "recording")
PLAYABLE_AUDIO_STATUSES = ("complete", "partial", "interrupted")
SCAN_STATUSES = ("complete", "stopped", "failed", "interrupted", "running")
STATUS_FILTERS = ("complete", "partial", "interrupted", "failed", "recording", "stopped", "running")
SCAN_SOURCES = ("native", "manual", "simulated", "receiver")
ITEM_KINDS = ("audio", "scan")
TYPE_FILTERS = ("all", "audio", "scan")
SORT_KEYS = ("start", "end", "duration", "frequency", "size", "type", "status")
SORT_ORDERS = ("asc", "desc")
MODE_RE = re.compile(r"^[a-z0-9_-]{1,16}$")
EXPORT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{32}$")
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_INT_TEXT_RE = re.compile(r"^[0-9]{1,16}$")
_NUMBER_TEXT_RE = re.compile(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]{1,3})?$")
_WINDOW_TEXT_RE = re.compile(r"^([0-9]{1,16})-([0-9]{1,16})$")
_NAME_CHAR_RE = re.compile(r"[^A-Za-z0-9._+-]")
FILTER_KEYS = (
    "from_ms", "to_ms", "windows", "type", "status", "min_frequency_hz", "max_frequency_hz",
    "vfo_index", "mode", "bandwidth_hz", "q",
)

# candidates.csv: exportSweepCandidatesCsv in sweep-session.ts, column and payload key.
CANDIDATE_CSV_COLUMNS = (
    ("start_hz", "startHz"),
    ("end_hz", "endHz"),
    ("center_hz", "centerHz"),
    ("peak_frequency_hz", "peakFrequencyHz"),
    ("mean_peak_frequency_hz", "meanPeakFrequencyHz"),
    ("min_peak_frequency_hz", "minPeakFrequencyHz"),
    ("max_peak_frequency_hz", "maxPeakFrequencyHz"),
    ("bandwidth_hz", "bandwidthHz"),
    ("peak_db", "peakDb"),
    ("noise_floor_db", "noiseFloorDb"),
    ("snr_db", "snrDb"),
    ("first_seen_ms", "firstSeen"),
    ("last_seen_ms", "lastSeen"),
    ("hits", "hits"),
)
MAX_NAME_PART = 32
MAX_ENTRY_NAME = 120


class ArchiveError(Exception):
    """A refused archive request: HTTP status, code and operator text.

    Not a ValueError, so the legacy Receiver error mapping never turns it
    into a bare 400.
    """

    def __init__(self, status: int, code: str, message: Optional[str] = None, **extra: Any) -> None:
        self.status = int(status)
        self.code = code
        self.message = message or ARCHIVE_ERROR_MESSAGES.get(code, "Receiver archive request refused.")
        self.extra = extra
        super().__init__(self.message)

    def body(self) -> Dict[str, Any]:
        return {**self.extra, "ok": False, "code": self.code, "error": self.message}


class ArchiveItemGone(Exception):
    """The rows of a record disappeared while it was being exported."""


def invalid(message: str) -> ArchiveError:
    return ArchiveError(400, ARCHIVE_INVALID_REQUEST, message)


def finite_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def utc_from_ms(ms: int) -> datetime:
    return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=int(ms))


def ms_from_datetime(value: datetime) -> int:
    delta = value.astimezone(timezone.utc) - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (delta.days * 86_400 + delta.seconds) * 1000 + delta.microseconds // 1000


def iso_from_ms(ms: Optional[int]) -> Optional[str]:
    if ms is None:
        return None
    stamp = utc_from_ms(ms)
    return f"{stamp.year:04d}-{stamp.month:02d}-{stamp.day:02d}T{stamp.hour:02d}:{stamp.minute:02d}:{stamp.second:02d}.{stamp.microsecond // 1000:03d}Z"


def normalize_mode(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    mode = value.strip().casefold()
    return mode if MODE_RE.fullmatch(mode) else None


def normalize_vfo_index(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_VFO_INDEX:
        return None
    return value


def normalize_source(value: Any) -> str:
    return value if isinstance(value, str) and value in SCAN_SOURCES else ""


def audio_search_text(ident: str, vfo_index: Optional[int], mode: Optional[str], frequency_hz: Optional[float]) -> str:
    parts = ["audio", f"vfo{vfo_index + 1}" if vfo_index is not None else "vfo"]
    if mode:
        parts.append(mode)
    if frequency_hz is not None:
        parts.append(f"{frequency_hz / 1e6:.6f}")
    parts.append(ident[:8])
    return " ".join(parts).lower()


def scan_search_text(ident: str, source: str, start_hz: Optional[float], end_hz: Optional[float]) -> str:
    parts = ["scan", "pindai"]
    if source:
        parts.append(source)
    if start_hz is not None and end_hz is not None:
        parts.append(f"{start_hz / 1e6:.3f}-{end_hz / 1e6:.3f}")
    parts.append(ident[:8])
    return " ".join(parts).lower()


def export_estimate(kind: str, byte_count: int, trace_count: int = 0, candidate_count: int = 0) -> int:
    if kind == "audio":
        return int(byte_count) + ESTIMATE_AUDIO_EXTRA_BYTES
    return int(trace_count) * ESTIMATE_SCAN_TRACE_BYTES + int(candidate_count) * ESTIMATE_SCAN_CANDIDATE_BYTES + ESTIMATE_SCAN_EXTRA_BYTES


# --- request parsing ---------------------------------------------------------


@dataclass(frozen=True)
class ArchiveFilter:
    from_ms: Optional[int] = None
    to_ms: Optional[int] = None
    windows: Tuple[Tuple[int, int], ...] = ()
    kind: str = "all"
    status: Optional[str] = None
    min_frequency_hz: Optional[float] = None
    max_frequency_hz: Optional[float] = None
    vfo_index: Optional[int] = None
    mode: Optional[str] = None
    bandwidth_hz: Optional[float] = None
    q: Optional[str] = None

    @property
    def audio_only(self) -> bool:
        """VFO, mode and bandwidth describe audio only, so they exclude scans."""
        return self.vfo_index is not None or self.mode is not None or self.bandwidth_hz is not None

    @property
    def includes_audio(self) -> bool:
        return self.kind in ("all", "audio")

    @property
    def includes_scans(self) -> bool:
        return self.kind in ("all", "scan") and not self.audio_only

    @property
    def has_frequency(self) -> bool:
        return self.min_frequency_hz is not None or self.max_frequency_hz is not None

    def without_time(self) -> "ArchiveFilter":
        return replace(self, from_ms=None, to_ms=None, windows=())


def _ms_text(name: str, text: str) -> int:
    if not _INT_TEXT_RE.fullmatch(text):
        raise invalid(f"{name} must be an integer between 0 and {MAX_MS}")
    value = int(text)
    if value > MAX_MS:
        raise invalid(f"{name} must be an integer between 0 and {MAX_MS}")
    return value


def _ms_json(name: str, value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_MS:
        raise invalid(f"{name} must be an integer between 0 and {MAX_MS}")
    return value


def _number_text(name: str, text: str, maximum: float) -> float:
    if len(text) > 32 or not _NUMBER_TEXT_RE.fullmatch(text):
        raise invalid(f"{name} must be a number between 0 and {maximum:g}")
    return _number_json(name, float(text), maximum)


def _number_json(name: str, value: Any, maximum: float) -> float:
    if not finite_number(value):
        raise invalid(f"{name} must be a number between 0 and {maximum:g}")
    number = float(value)
    if not 0 <= number <= maximum:
        raise invalid(f"{name} must be a number between 0 and {maximum:g}")
    return number


def _check_time_range(from_ms: int, to_ms: int, maximum_span: int, label: str = "from_ms and to_ms") -> None:
    if from_ms >= to_ms:
        raise invalid("from_ms must be earlier than to_ms")
    if to_ms - from_ms > maximum_span:
        raise invalid(f"{label} may span at most {maximum_span} ms")


def _check_windows(pairs: List[Tuple[int, int]]) -> Tuple[Tuple[int, int], ...]:
    if not 1 <= len(pairs) <= MAX_WINDOWS:
        raise invalid(f"windows must hold 1 to {MAX_WINDOWS} ranges")
    previous_end = -1
    for start, end in pairs:
        if not 0 <= start < end <= MAX_MS:
            raise invalid("each window must have a start earlier than its end")
        if end - start > MAX_WINDOW_MS:
            raise invalid(f"each window may span at most {MAX_WINDOW_MS} ms")
        if start < previous_end:
            raise invalid("windows must be in increasing order and must not overlap")
        previous_end = end
    return tuple(pairs)


def _text_value(name: str, value: Any) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        raise invalid(f"{name} must be text")
    return value


def _build_filter(values: Mapping[str, Any], typed: bool, include_time: bool) -> ArchiveFilter:
    """Validate filter values: query text when typed is False, JSON values otherwise."""

    def ms(name: str) -> Optional[int]:
        value = values.get(name)
        if value is None:
            return None
        return _ms_json(name, value) if typed else _ms_text(name, str(value))

    def number(name: str, maximum: float) -> Optional[float]:
        value = values.get(name)
        if value is None:
            return None
        return _number_json(name, value, maximum) if typed else _number_text(name, str(value), maximum)

    from_ms = to_ms = None
    windows: Tuple[Tuple[int, int], ...] = ()
    if include_time:
        from_ms, to_ms = ms("from_ms"), ms("to_ms")
        raw_windows = values.get("windows")
        if (from_ms is None) != (to_ms is None):
            raise invalid("from_ms and to_ms must be given together")
        if raw_windows is not None:
            if from_ms is not None:
                raise invalid("windows cannot be combined with from_ms and to_ms")
            windows = _parse_windows_json(raw_windows) if typed else parse_windows_text(raw_windows)
        if from_ms is not None and to_ms is not None:
            _check_time_range(from_ms, to_ms, MAX_ITEMS_SPAN_MS)

    kind = _text_value("type", values.get("type"))
    if kind is None:
        kind = "all"
    if kind not in TYPE_FILTERS:
        raise invalid("type must be all, audio or scan")
    status = _text_value("status", values.get("status"))
    if status is not None and status not in STATUS_FILTERS:
        raise invalid("status must be one of " + ", ".join(STATUS_FILTERS))
    minimum = number("min_frequency_hz", MAX_FREQUENCY_HZ)
    maximum = number("max_frequency_hz", MAX_FREQUENCY_HZ)
    if minimum is not None and maximum is not None and minimum > maximum:
        raise invalid("min_frequency_hz must not exceed max_frequency_hz")

    raw_vfo = values.get("vfo_index")
    vfo_index = None
    if raw_vfo is not None:
        if typed:
            if isinstance(raw_vfo, bool) or not isinstance(raw_vfo, int):
                raise invalid(f"vfo_index must be an integer between 0 and {MAX_VFO_INDEX}")
            vfo_index = raw_vfo
        else:
            if not re.fullmatch(r"[0-9]{1,3}", str(raw_vfo)):
                raise invalid(f"vfo_index must be an integer between 0 and {MAX_VFO_INDEX}")
            vfo_index = int(raw_vfo)
        if not 0 <= vfo_index <= MAX_VFO_INDEX:
            raise invalid(f"vfo_index must be an integer between 0 and {MAX_VFO_INDEX}")

    raw_mode = _text_value("mode", values.get("mode"))
    mode = None
    if raw_mode is not None:
        mode = raw_mode.strip().casefold()
        if not MODE_RE.fullmatch(mode):
            raise invalid("mode must be 1 to 16 letters, digits, '_' or '-'")
    bandwidth = number("bandwidth_hz", MAX_BANDWIDTH_HZ)

    raw_q = _text_value("q", values.get("q"))
    q = None
    if raw_q is not None:
        q = raw_q.strip()
        if len(q) > MAX_SEARCH_TEXT:
            raise invalid(f"q must be at most {MAX_SEARCH_TEXT} characters")
        q = q.lower() or None
    return ArchiveFilter(
        from_ms=from_ms, to_ms=to_ms, windows=windows, kind=kind, status=status,
        min_frequency_hz=minimum, max_frequency_hz=maximum, vfo_index=vfo_index,
        mode=mode, bandwidth_hz=bandwidth, q=q,
    )


def _first(query: Mapping[str, Sequence[str]], key: str) -> Optional[str]:
    values = query.get(key)
    if not values:
        return None
    return values[0]


def parse_windows_text(text: Any) -> Tuple[Tuple[int, int], ...]:
    if not isinstance(text, str) or len(text) > MAX_WINDOWS_TEXT:
        raise invalid(f"windows must be at most {MAX_WINDOWS_TEXT} characters")
    pairs = []
    for part in text.split(","):
        match = _WINDOW_TEXT_RE.fullmatch(part)
        if match is None:
            raise invalid("windows must be comma-separated start-end pairs in ms")
        start, end = (_ms_text("windows", value) for value in match.groups())
        pairs.append((start, end))
    return _check_windows(pairs)


def _parse_windows_json(value: Any) -> Tuple[Tuple[int, int], ...]:
    if not isinstance(value, list):
        raise invalid("windows must be an array of [start_ms, end_ms] pairs")
    pairs = []
    for pair in value[:MAX_WINDOWS + 1]:
        if not isinstance(pair, list) or len(pair) != 2:
            raise invalid("windows must be an array of [start_ms, end_ms] pairs")
        pairs.append((_ms_json("windows", pair[0]), _ms_json("windows", pair[1])))
    if len(value) > MAX_WINDOWS:
        raise invalid(f"windows must hold 1 to {MAX_WINDOWS} ranges")
    return _check_windows(pairs)


def parse_filter_query(query: Mapping[str, Sequence[str]], include_time: bool = True) -> ArchiveFilter:
    """Filter parameters of a query (parse_qs); unknown parameters are ignored."""
    return _build_filter({key: _first(query, key) for key in FILTER_KEYS}, typed=False, include_time=include_time)


def parse_filter_json(value: Any) -> ArchiveFilter:
    """The filter object of an export or delete body; any other key is refused."""
    if not isinstance(value, dict):
        raise invalid("filter must be an object")
    unknown = sorted(set(value) - set(FILTER_KEYS))
    if unknown:
        raise invalid(f"filter has an unsupported field: {unknown[0][:32]}")
    return _build_filter(value, typed=True, include_time=True)


def parse_paging_query(query: Mapping[str, Sequence[str]]) -> Tuple[str, str, int, int]:
    sort = _first(query, "sort") or "start"
    if sort not in SORT_KEYS:
        raise invalid("sort must be one of " + ", ".join(SORT_KEYS))
    order = _first(query, "order") or "desc"
    if order not in SORT_ORDERS:
        raise invalid("order must be asc or desc")
    offset_text = _first(query, "offset")
    offset = 0
    if offset_text is not None:
        if not re.fullmatch(r"[0-9]{1,10}", offset_text) or int(offset_text) > ITEMS_MAX_OFFSET:
            raise invalid(f"offset must be an integer between 0 and {ITEMS_MAX_OFFSET}")
        offset = int(offset_text)
    limit_text = _first(query, "limit")
    limit = ITEMS_DEFAULT_LIMIT
    if limit_text is not None:
        if not re.fullmatch(r"[0-9]{1,4}", limit_text) or not 1 <= int(limit_text) <= ITEMS_MAX_LIMIT:
            raise invalid(f"limit must be an integer between 1 and {ITEMS_MAX_LIMIT}")
        limit = int(limit_text)
    return sort, order, offset, limit


def parse_timeline_query(query: Mapping[str, Sequence[str]]) -> Tuple[int, int, ArchiveFilter]:
    from_text, to_text = _first(query, "from_ms"), _first(query, "to_ms")
    if from_text is None or to_text is None:
        raise invalid("from_ms and to_ms are required")
    from_ms, to_ms = _ms_text("from_ms", from_text), _ms_text("to_ms", to_text)
    _check_time_range(from_ms, to_ms, MAX_TIMELINE_SPAN_MS)
    return from_ms, to_ms, parse_filter_query(query, include_time=False)


def parse_calendar_bounds(text: Any) -> List[int]:
    """The browser's local midnights of the visible calendar grid."""
    if not isinstance(text, str) or not text or len(text) > CALENDAR_MAX_TEXT:
        raise invalid(f"bounds must be 2 to {CALENDAR_MAX_BOUNDS} comma-separated ms values")
    parts = text.split(",")
    if not CALENDAR_MIN_BOUNDS <= len(parts) <= CALENDAR_MAX_BOUNDS:
        raise invalid(f"bounds must be 2 to {CALENDAR_MAX_BOUNDS} comma-separated ms values")
    bounds = [_ms_text("bounds", part) for part in parts]
    for previous, current in zip(bounds, bounds[1:]):
        step = current - previous
        if not CALENDAR_MIN_STEP_MS <= step <= CALENDAR_MAX_STEP_MS:
            raise invalid("bounds must increase by 1 to 50 hours per day")
    return bounds


def parse_calendar_type(text: Optional[str]) -> str:
    kind = text or "all"
    if kind not in TYPE_FILTERS:
        raise invalid("type must be all, audio or scan")
    return kind


def parse_item_id(value: Any) -> str:
    if not isinstance(value, str) or not _UUID_RE.fullmatch(value):
        raise invalid("id must be a record UUID")
    return value.lower()


@dataclass(frozen=True)
class Selection:
    items: Optional[Tuple[Tuple[str, str], ...]] = None
    filter: Optional[ArchiveFilter] = None
    expected_count: Optional[int] = None
    time_zone: Optional[str] = None
    utc_offset_minutes: Optional[int] = None


def parse_selection(payload: Any, max_items: int) -> Selection:
    """An export or delete body: explicit ids, or a filter with the total the table showed."""
    if not isinstance(payload, dict):
        raise invalid("request body must be a JSON object")
    unknown = sorted(set(payload) - {"items", "filter", "expected_count", "time_zone", "utc_offset_minutes"})
    if unknown:
        raise invalid(f"request has an unsupported field: {unknown[0][:32]}")
    has_items, has_filter = "items" in payload, "filter" in payload
    if has_items == has_filter:
        raise invalid("send either items or filter")
    time_zone = payload.get("time_zone")
    if time_zone is not None and (not isinstance(time_zone, str) or not time_zone or len(time_zone) > 64):
        raise invalid("time_zone must be a valid IANA time zone")
    offset = payload.get("utc_offset_minutes")
    if offset is not None and (isinstance(offset, bool) or not isinstance(offset, int) or not -1080 <= offset <= 1080):
        raise invalid("utc_offset_minutes must be an integer between -1080 and 1080")
    if has_items:
        if "expected_count" in payload:
            raise invalid("expected_count goes with filter only")
        raw = payload["items"]
        if not isinstance(raw, list) or not raw:
            raise invalid("items must be a non-empty array")
        seen: Dict[Tuple[str, str], None] = {}
        for entry in raw:
            if not isinstance(entry, dict):
                raise invalid("each item must be an object with kind and id")
            kind = entry.get("kind")
            if kind not in ITEM_KINDS:
                raise invalid("item kind must be audio or scan")
            seen[(kind, parse_item_id(entry.get("id")))] = None
            if len(seen) > max_items:
                raise ArchiveError(413, ARCHIVE_TOO_MANY_ITEMS, f"at most {max_items} records per request", count=_unique_count(raw), limit=max_items)
        return Selection(items=tuple(seen), time_zone=time_zone, utc_offset_minutes=offset)
    archive_filter = parse_filter_json(payload["filter"])
    expected = payload.get("expected_count")
    if isinstance(expected, bool) or not isinstance(expected, int) or expected < 0:
        raise invalid("expected_count must be a nonnegative integer")
    return Selection(filter=archive_filter, expected_count=expected, time_zone=time_zone, utc_offset_minutes=offset)


def _unique_count(raw: List[Any]) -> int:
    keys = set()
    for entry in raw:
        if isinstance(entry, dict):
            keys.add((entry.get("kind"), str(entry.get("id")).lower()))
    return len(keys)


def parse_retention_days(value: Any) -> Optional[int]:
    """Off (None) or one of RETENTION_DAY_OPTIONS; a bool is refused although True is an int."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value not in RETENTION_DAY_OPTIONS:
        raise ArchiveError(400, RETENTION_INVALID, "retention_days must be null or one of " + ", ".join(map(str, RETENTION_DAY_OPTIONS)))
    return value


def parse_retention_query(text: Optional[str]) -> int:
    if text is None or not re.fullmatch(r"[0-9]{1,3}", text) or int(text) not in RETENTION_DAY_OPTIONS:
        raise ArchiveError(400, RETENTION_INVALID, "days must be one of " + ", ".join(map(str, RETENTION_DAY_OPTIONS)))
    return int(text)


# --- time line and calendar helpers -------------------------------------------


def bucket_days(bounds: Sequence[int], intervals: Iterable[Tuple[int, int]]) -> List[int]:
    """Count the intervals that overlap each day [bounds[i], bounds[i+1])."""
    counts = [0] * (len(bounds) - 1)
    for start, end in intervals:
        index = max(0, bisect.bisect_right(bounds, start) - 1)
        for day in range(index, min(len(counts), index + CALENDAR_MAX_DAYS_PER_ITEM)):
            if bounds[day] >= end:
                break
            if start < bounds[day + 1] and end > bounds[day]:
                counts[day] += 1
    return counts


def merge_intervals(intervals: Iterable[Tuple[int, int]], from_ms: int, to_ms: int) -> Tuple[List[List[int]], bool]:
    """Clip to [from_ms, to_ms], sort, merge gaps up to a minute and keep at most 1500."""
    clipped = sorted(
        (max(from_ms, start), min(to_ms, end)) for start, end in intervals
        if start < to_ms and max(start, end) >= from_ms
    )
    merged: List[List[int]] = []
    for start, end in clipped:
        if merged and start - merged[-1][1] <= TIMELINE_MERGE_GAP_MS:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    truncated = len(merged) > TIMELINE_MAX_INTERVALS
    return merged[:TIMELINE_MAX_INTERVALS], truncated


# --- names -------------------------------------------------------------------


def name_part(value: Any, limit: int = MAX_NAME_PART, fallback: str = "unknown") -> str:
    """ASCII [A-Za-z0-9._+-] only, never '..', never a leading dot, at most limit characters."""
    text = _NAME_CHAR_RE.sub("-", str(value))
    text = re.sub(r"\.{2,}", "-", text)[:limit]
    if text.startswith("."):
        text = "-" + text[1:]
    return text or fallback


def _fit(prefix: str, stem: str, suffix: str, limit: int = MAX_ENTRY_NAME) -> str:
    room = limit - len(prefix) - len(suffix)
    return stem[:max(1, room)]


def local_time(ms: int, zone: tzinfo) -> datetime:
    stamp = utc_from_ms(ms)
    try:
        return stamp.astimezone(zone)
    except (OverflowError, ValueError):
        return stamp


def timestamp_text(ms: int, zone: tzinfo) -> str:
    """YYYYMMDD-HHMMSS+HHMM in the request zone."""
    local = local_time(ms, zone)
    offset = local.utcoffset() or timedelta(0)
    minutes = int(offset.total_seconds() // 60)
    sign = "+" if minutes >= 0 else "-"
    minutes = abs(minutes)
    return (
        f"{local.year:04d}{local.month:02d}{local.day:02d}-{local.hour:02d}{local.minute:02d}{local.second:02d}"
        f"{sign}{minutes // 60:02d}{minutes % 60:02d}"
    )


def date_text(ms: int, zone: tzinfo) -> str:
    local = local_time(ms, zone)
    return f"{local.year:04d}-{local.month:02d}-{local.day:02d}"


def zip_date_time(ms: Optional[int], zone: tzinfo) -> Tuple[int, int, int, int, int, int]:
    if ms is None:
        return (1980, 1, 1, 0, 0, 0)
    local = local_time(ms, zone)
    value = (local.year, local.month, local.day, local.hour, local.minute, local.second)
    return max((1980, 1, 1, 0, 0, 0), min((2107, 12, 31, 23, 59, 58), value))


def _mhz(value: Optional[float], digits: int) -> Optional[str]:
    if not finite_number(value):
        return None
    return f"{value / 1e6:.{digits}f}"


def audio_stem(item: Mapping[str, Any], zone: tzinfo) -> str:
    vfo = item.get("vfo_index")
    frequency = _mhz(item.get("frequency_hz"), 6)
    mode = item.get("raw_mode")
    mode_text = mode.casefold() if isinstance(mode, str) and mode.strip() else "unknown"
    parts = [
        name_part(timestamp_text(item["start_ms"], zone)),
        name_part(f"vfo{vfo + 1}" if isinstance(vfo, int) else "vfo-"),
        name_part(f"{frequency}MHz" if frequency else "unknown-freq"),
        name_part(mode_text),
        name_part(item["id"][:8]),
    ]
    return "_".join(parts)


def audio_download_name(item: Mapping[str, Any], zone: tzinfo) -> str:
    return _fit("", audio_stem(item, zone), ".webm") + ".webm"


def scan_stem(item: Mapping[str, Any], zone: tzinfo) -> str:
    start, end = _mhz(item.get("start_hz"), 3), _mhz(item.get("end_hz"), 3)
    span = f"{start}-{end}MHz" if start is not None and end is not None else "unknown-range"
    return "_".join([
        name_part(timestamp_text(item["start_ms"], zone)),
        name_part(span),
        name_part(item["id"][:8]),
    ])


def scan_download_name(item: Mapping[str, Any], zone: tzinfo) -> str:
    stem = "scan_" + scan_stem(item, zone)
    return _fit("", stem, ".zip") + ".zip"


def selection_download_name(now_ms: int, zone: tzinfo) -> str:
    return f"receiver-records_{name_part(timestamp_text(now_ms, zone))}.zip"


class _Names:
    """Unique entry names; a repeated one gets -2, -3, ...

    The whole entry path (prefix, name and the longest suffix or reserve)
    stays within MAX_ENTRY_NAME characters.
    """

    def __init__(self) -> None:
        self._used: set = set()

    def claim(self, prefix: str, stem: str, suffixes: Sequence[str], reserve: int = 0) -> str:
        room = max([len(suffix) for suffix in suffixes] + [reserve])
        base = stem[:max(1, MAX_ENTRY_NAME - len(prefix) - room)]
        candidate, number = base, 1
        while any((prefix + candidate + suffix) in self._used for suffix in suffixes):
            number += 1
            tag = f"-{number}"
            candidate = base[:max(1, MAX_ENTRY_NAME - len(prefix) - room - len(tag))] + tag
        for suffix in suffixes:
            self._used.add(prefix + candidate + suffix)
        return candidate


# --- CSV ---------------------------------------------------------------------


def csv_number(value: Any) -> str:
    """A finite number as text (integral without a decimal point); anything else is empty."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return ""
    if isinstance(value, int):
        return str(value)
    if not math.isfinite(value):
        return ""
    if value.is_integer():
        return str(int(value))
    return repr(value)


def candidate_csv_header() -> str:
    return ",".join(column for column, _ in CANDIDATE_CSV_COLUMNS) + "\r\n"


def candidate_csv_row(payload: Any) -> str:
    if not isinstance(payload, dict):
        payload = {}
    return ",".join(csv_number(payload.get(key)) for _, key in CANDIDATE_CSV_COLUMNS) + "\r\n"


def trace_frequencies(start_hz: float, end_hz: float) -> List[int]:
    step = (end_hz - start_hz) / TRACE_BYTES
    return [round(start_hz + (index + 0.5) * step) for index in range(TRACE_BYTES)]


def trace_format_of(config: Any) -> Tuple[Optional[int], bool]:
    """(format, supported): config.traceFormat when it is an int, else None (detect per trace)."""
    value = config.get("traceFormat") if isinstance(config, dict) else None
    trace_format = value if isinstance(value, int) and not isinstance(value, bool) else None
    return trace_format, trace_format in (None, TRACE_FORMAT_TAG)


def trace_is_tagged(payload: bytes, trace_format: Optional[int]) -> bool:
    return trace_format == TRACE_FORMAT_TAG or (trace_format is None and len(payload) > 1 and payload[0] == TRACE_FORMAT_TAG)


def decode_trace(payload: bytes, trace_format: Optional[int] = None) -> List[float]:
    """Levels in dB, exactly as decodeArchivedTrace in sweep-waterfall.ts."""
    if trace_format not in (None, TRACE_FORMAT_TAG):
        raise ValueError(f"archived trace format {trace_format} is not supported")
    tagged = trace_is_tagged(payload, trace_format)
    levels = list(map((TAGGED_DB if tagged else LEGACY_DB).__getitem__, payload))
    if tagged and len(levels) > 1:
        levels[0] = levels[1]
    return levels


def trace_csv_values(payload: bytes, trace_format: Optional[int]) -> str:
    tagged = trace_is_tagged(payload, trace_format)
    values = list(map((TAGGED_DB_TEXT if tagged else LEGACY_DB_TEXT).__getitem__, payload))
    if tagged and len(values) > 1:
        values[0] = values[1]
    return ",".join(values)


def inflate_trace(blob: Any) -> Optional[bytes]:
    """A stored frame, decompressed with a bound; None when it is damaged or not 2048 bytes."""
    try:
        payload = zlib.decompressobj().decompress(bytes(blob), TRACE_BYTES + 1)
    except (zlib.error, TypeError, ValueError):
        return None
    return payload if len(payload) == TRACE_BYTES else None


# --- streaming ---------------------------------------------------------------


class ChunkedWriter:
    """A non-seekable response body for zipfile.

    With chunked=True (HTTP/1.1) every 64 KiB is framed as one chunk and
    finish() writes the final 0-chunk, so a broken stream shows as a failed
    download instead of a silently short file. With chunked=False (HTTP/1.0)
    the bytes go out raw and the closed connection ends the body. After
    abort() or a failed write, nothing more is written.
    """

    def __init__(self, raw: Any, chunked: bool = True, chunk_size: int = STREAM_CHUNK_BYTES) -> None:
        self._raw = raw
        self.chunked = chunked
        self._chunk_size = chunk_size
        self._buffer = bytearray()
        self.aborted = False
        self.finished = False
        self.bytes_written = 0

    def writable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return False

    def tell(self) -> int:
        raise io.UnsupportedOperation("the response body is not seekable")

    def write(self, data: Any) -> int:
        if not isinstance(data, (bytes, bytearray)):
            data = bytes(data)
        size = len(data)
        if self.aborted:
            return size
        if self.finished:
            raise ValueError("the response body is already finished")
        self._buffer += data
        while len(self._buffer) >= self._chunk_size:
            chunk = bytes(self._buffer[:self._chunk_size])
            del self._buffer[:self._chunk_size]
            self._emit(chunk)
        return size

    def flush(self) -> None:
        """zipfile flushes after the central directory; finish() sends what is left."""

    def _emit(self, chunk: bytes) -> None:
        if not chunk:
            return
        try:
            if self.chunked:
                self._raw.write(b"%X\r\n" % len(chunk) + chunk + b"\r\n")
            else:
                self._raw.write(chunk)
        except BaseException:
            self.aborted = True
            self._buffer.clear()
            raise
        self.bytes_written += len(chunk)

    def finish(self) -> None:
        if self.aborted:
            raise ValueError("the response body was aborted")
        if self.finished:
            return
        chunk = bytes(self._buffer)
        self._buffer.clear()
        self._emit(chunk)
        if self.chunked:
            try:
                self._raw.write(b"0\r\n\r\n")
            except BaseException:
                self.aborted = True
                raise
        self.finished = True
        flush = getattr(self._raw, "flush", None)
        if callable(flush):
            flush()

    def abort(self) -> None:
        self.aborted = True
        self._buffer.clear()


class _ArchiveZip:
    """zipfile on a ChunkedWriter; abort() stops every later byte, then closes quietly."""

    def __init__(self, writer: ChunkedWriter) -> None:
        self.writer = writer
        self.zip = zipfile.ZipFile(writer, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True)
        self.handle: Any = None

    def open(self, name: str, date_time: Tuple[int, int, int, int, int, int], compress: int = zipfile.ZIP_DEFLATED,
             size: Optional[int] = None, force_zip64: bool = False) -> Any:
        info = zipfile.ZipInfo(name, date_time=date_time)
        info.compress_type = compress
        info.external_attr = 0o644 << 16
        if size is not None:
            info.file_size = size
        self.handle = self.zip.open(info, "w", force_zip64=force_zip64)
        return self.handle

    def close_entry(self) -> None:
        handle, self.handle = self.handle, None
        if handle is not None:
            handle.close()

    def write_entry(self, name: str, date_time: Tuple[int, int, int, int, int, int], data: bytes) -> None:
        self.open(name, date_time, size=len(data))
        self.handle.write(data)
        self.close_entry()

    def finish(self) -> None:
        self.zip.close()

    def abort(self) -> None:
        self.writer.abort()
        try:
            if self.handle is not None:
                self.handle.close()
        except Exception:
            pass
        self.handle = None
        try:
            self.zip.close()
        except Exception:
            pass


class _BatchedText:
    """Text written to a zip entry in batches of about 64 KiB."""

    def __init__(self, handle: Any) -> None:
        self.handle = handle
        self.parts: List[str] = []
        self.size = 0

    def write(self, text: str) -> None:
        self.parts.append(text)
        self.size += len(text)
        if self.size >= STREAM_CHUNK_BYTES:
            self.flush()

    def flush(self) -> None:
        if self.parts:
            self.handle.write("".join(self.parts).encode("utf-8"))
            self.parts, self.size = [], 0


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=False, allow_nan=False, ensure_ascii=True) + "\n").encode("utf-8")


def write_archive_zip(store: Any, entries: Sequence[Tuple[str, str]], writer: ChunkedWriter, zone: tzinfo, *,
                      time_zone_name: str = "UTC", time_zone_fallback: bool = False, console_version: str = "dev",
                      created_ms: int = 0, missing: Sequence[Mapping[str, Any]] = ()) -> Dict[str, Any]:
    """Stream a Records ZIP; manifest.json is always the last entry.

    The store is duck-typed: archive_audio_entry, get_segment_audio,
    archive_scan_entry, iter_scan_candidates and iter_scan_frames. A record
    whose rows are gone is listed in manifest.missing; one deleted while it
    streamed is marked truncated. Any other error aborts the body, so the
    browser shows a failed download (no final chunk, no appended text).
    """
    archive = _ArchiveZip(writer)
    names = _Names()
    items: List[Dict[str, Any]] = []
    missing_items: List[Dict[str, Any]] = [dict(entry) for entry in missing]
    try:
        for kind, ident in entries:
            if kind == "audio":
                _write_audio_item(archive, store, ident, zone, names, items, missing_items)
            else:
                _write_scan_item(archive, store, ident, zone, names, items, missing_items)
        manifest = {
            "format": "sdr-doa-receiver-archive",
            "version": 1,
            "created_at": iso_from_ms(created_ms),
            "console_version": console_version,
            "time_zone": time_zone_name,
            "time_zone_fallback": bool(time_zone_fallback),
            "items": items,
            "missing": missing_items,
        }
        archive.write_entry("manifest.json", zip_date_time(created_ms, zone), _json_bytes(manifest))
        archive.finish()
    except BaseException:
        archive.abort()
        raise
    return {"items": len(items), "missing": len(missing_items)}


def _write_audio_item(archive: _ArchiveZip, store: Any, ident: str, zone: tzinfo, names: _Names,
                      items: List[Dict[str, Any]], missing: List[Dict[str, Any]]) -> None:
    try:
        item = store.archive_audio_entry(ident)
    except (KeyError, ArchiveError):
        missing.append({"kind": "audio", "id": ident, "reason": "deleted"})
        return
    if not item.get("downloadable"):
        missing.append({"kind": "audio", "id": ident, "reason": "not_downloadable"})
        return
    try:
        path, _ = store.get_segment_audio(ident)
        source = open(path, "rb")
    except (KeyError, OSError, ArchiveError):
        missing.append({"kind": "audio", "id": ident, "reason": "file_missing"})
        return
    with source:
        size = os.fstat(source.fileno()).st_size
        prefix = f"audio/{date_text(item['start_ms'], zone)}/"
        stem = names.claim(prefix, audio_stem(item, zone), (".webm", ".json"))
        date_time = zip_date_time(item["start_ms"], zone)
        audio_name = prefix + stem + ".webm"
        handle = archive.open(audio_name, date_time, compress=zipfile.ZIP_STORED, size=size,
                              force_zip64=size > ZIP64_ENTRY_THRESHOLD_BYTES)
        while True:
            chunk = source.read(STREAM_CHUNK_BYTES)
            if not chunk:
                break
            handle.write(chunk)
        archive.close_entry()
    vfo = item.get("vfo_index")
    details = {
        "format": "sdr-doa-receiver-audio",
        "version": 1,
        "id": item["id"],
        "session_id": item.get("session_id"),
        "vfo": vfo + 1 if isinstance(vfo, int) else None,
        "vfo_index": vfo,
        "frequency_hz": item.get("frequency_hz"),
        "frequency_reference": "displayed",
        "mode": item.get("raw_mode"),
        "bandwidth_hz": item.get("bandwidth_hz"),
        "codec": item.get("codec"),
        "start": iso_from_ms(item["start_ms"]),
        "end": iso_from_ms(item.get("end_ms")),
        "duration_s": item.get("duration_s"),
        "bytes": size,
        "status": item.get("status"),
        "error": item.get("error") or "",
        "file": stem + ".webm",
    }
    json_name = prefix + stem + ".json"
    archive.write_entry(json_name, date_time, _json_bytes(details))
    items.append({"kind": "audio", "id": ident, "files": [audio_name, json_name]})


def _stream_text_entry(archive: _ArchiveZip, name: str, date_time: Tuple[int, int, int, int, int, int],
                       force_zip64: bool, header: str, rows: Iterable[str], footer: str = "") -> None:
    """One streamed text entry. When the record disappears mid-way the entry is
    closed as it stands (footer included) and ArchiveItemGone goes on; any
    other error leaves it open for the abort."""
    text = _BatchedText(archive.open(name, date_time, force_zip64=force_zip64))
    text.write(header)
    try:
        for row in rows:
            text.write(row)
    except ArchiveItemGone:
        text.write(footer)
        text.flush()
        archive.close_entry()
        raise
    text.write(footer)
    text.flush()
    archive.close_entry()


_CAPTURED_AT_RE = re.compile(r"[^0-9A-Za-z:.+-]")


def _candidate_csv_rows(store: Any, ident: str) -> Iterable[str]:
    for raw in store.iter_scan_candidates(ident):
        try:
            payload = json.loads(raw)
        except (TypeError, ValueError):
            payload = None
        yield candidate_csv_row(payload)


def _candidate_json_rows(store: Any, ident: str) -> Iterable[str]:
    first = True
    for raw in store.iter_scan_candidates(ident):
        if not isinstance(raw, str):
            continue
        yield ("\n" if first else ",\n") + raw
        first = False


def _write_scan_item(archive: _ArchiveZip, store: Any, ident: str, zone: tzinfo, names: _Names,
                     items: List[Dict[str, Any]], missing: List[Dict[str, Any]]) -> None:
    try:
        scan = store.archive_scan_entry(ident)
    except (KeyError, ArchiveError):
        missing.append({"kind": "scan", "id": ident, "reason": "deleted"})
        return
    if not scan.get("downloadable"):
        missing.append({"kind": "scan", "id": ident, "reason": "not_downloadable"})
        return
    date_time = zip_date_time(scan["start_ms"], zone)
    day = f"scans/{date_text(scan['start_ms'], zone)}/"
    folder = names.claim(day, scan_stem(scan, zone), ("/",), reserve=len("/candidates.json"))
    prefix = f"{day}{folder}/"
    files: List[str] = []
    omitted: List[Dict[str, str]] = []
    truncated = False
    counters = {"written": 0, "skipped": 0}

    def entry(name: str) -> str:
        files.append(prefix + name)
        return prefix + name

    def trace_rows(trace_format: Optional[int]) -> Iterable[str]:
        for sweep, captured_at, payload in store.iter_scan_frames(ident):
            if payload is None:
                counters["skipped"] += 1
                continue
            stamp = _CAPTURED_AT_RE.sub("", str(captured_at))[:40]
            counters["written"] += 1
            yield f"{int(sweep)},{stamp}," + trace_csv_values(payload, trace_format) + "\r\n"

    candidate_count = int(scan.get("candidate_count") or 0)
    candidate_bytes = int(scan.get("candidate_bytes") or 0)
    try:
        _stream_text_entry(
            archive, entry("candidates.csv"), date_time,
            candidate_count * ESTIMATE_SCAN_CANDIDATE_BYTES > ZIP64_ENTRY_THRESHOLD_BYTES,
            candidate_csv_header(), _candidate_csv_rows(store, ident),
        )
        _stream_text_entry(
            archive, entry("candidates.json"), date_time,
            candidate_bytes + candidate_count * 4 > ZIP64_ENTRY_THRESHOLD_BYTES,
            "[", _candidate_json_rows(store, ident), "\n]\n",
        )
        trace_format, supported = scan["trace_format"], scan["trace_format_supported"]
        start_hz, end_hz = scan.get("start_hz"), scan.get("end_hz")
        if not supported:
            omitted.append({"file": "traces.csv", "reason": "unsupported_trace_format"})
        elif not (finite_number(start_hz) and finite_number(end_hz)):
            omitted.append({"file": "traces.csv", "reason": "unknown_range"})
        else:
            trace_count = int(scan.get("trace_count") or 0)
            header = "sweep,captured_at," + ",".join(map(str, trace_frequencies(float(start_hz), float(end_hz)))) + "\r\n"
            _stream_text_entry(
                archive, entry("traces.csv"), date_time,
                trace_count * ESTIMATE_SCAN_TRACE_BYTES > ZIP64_ENTRY_THRESHOLD_BYTES,
                header, trace_rows(trace_format),
            )
    except ArchiveItemGone:
        truncated = True
    details = {
        "format": "sdr-doa-receiver-scan",
        "version": 1,
        "id": scan["id"],
        "source": scan.get("source") or "",
        "status": scan.get("status"),
        "start": iso_from_ms(scan["start_ms"]),
        "end": iso_from_ms(scan.get("end_ms")),
        "start_hz": scan.get("start_hz"),
        "end_hz": scan.get("end_hz"),
        "frequency_reference": "device",
        "config": scan.get("config") or {},
        "trace_format": scan.get("trace_format"),
        "trace_count": scan.get("trace_count"),
        "traces_written": counters["written"],
        "traces_skipped": counters["skipped"],
        "candidate_count": scan.get("candidate_count"),
        "trace_upload_failures": scan.get("trace_upload_failures"),
        "files": [name[len(prefix):] for name in files] + ["scan.json"],
    }
    if truncated:
        details["truncated"] = True
    if omitted:
        details["omitted"] = omitted
    archive.write_entry(entry("scan.json"), date_time, _json_bytes(details))
    record: Dict[str, Any] = {"kind": "scan", "id": ident, "files": files}
    if truncated:
        record["truncated"] = True
    if omitted:
        record["omitted"] = omitted
    items.append(record)


# --- exports -----------------------------------------------------------------


@dataclass
class PendingExport:
    entries: Tuple[Tuple[str, str], ...]
    zone: tzinfo
    time_zone_name: str
    time_zone_fallback: bool
    filename: str
    missing: Tuple[Dict[str, Any], ...] = ()
    created: float = 0.0


class ArchiveExports:
    """Prepared ZIP exports: in memory only, single use, at most 8, each for 120 s."""

    def __init__(self, clock: Callable[[], float] = time.monotonic, max_pending: int = EXPORT_MAX_PENDING,
                 ttl_s: float = EXPORT_TTL_S) -> None:
        self.clock = clock
        self.max_pending = max_pending
        self.ttl_s = ttl_s
        self._lock = threading.Lock()
        self._pending: Dict[str, PendingExport] = {}

    def _prune(self, now: float) -> None:
        for token in [token for token, export in self._pending.items() if now - export.created >= self.ttl_s]:
            del self._pending[token]

    def create(self, export: PendingExport) -> str:
        token = secrets.token_urlsafe(24)
        with self._lock:
            now = self.clock()
            self._prune(now)
            export.created = now
            self._pending[token] = export
            while len(self._pending) > self.max_pending:
                oldest = min(self._pending, key=lambda key: self._pending[key].created)
                del self._pending[oldest]
        return token

    def take(self, token: str) -> Optional[PendingExport]:
        if not isinstance(token, str) or not EXPORT_ID_RE.fullmatch(token):
            return None
        with self._lock:
            self._prune(self.clock())
            return self._pending.pop(token, None)

    def __len__(self) -> int:
        with self._lock:
            self._prune(self.clock())
            return len(self._pending)


# --- retention ---------------------------------------------------------------


def retention_log_line(days: int, result: Mapping[str, Any]) -> str:
    mib = (result.get("bytes") or 0) / (1024 * 1024)
    return (
        f"[ground-console] receiver retention {days} d: removed {result.get('audio', 0)} audio, "
        f"{result.get('scans', 0)} scans ({mib:.1f} MiB), {result.get('failed', 0)} failed"
    )


class RetentionScheduler:
    """Runs the retention pass in its own daemon thread.

    The first pass runs start_delay_s after start(), then every interval_s;
    wake() runs one at once and stop() ends the thread. A pass that reports
    more (and removed something) is followed at once by the next one.
    """

    def __init__(self, apply: Callable[[], Optional[Mapping[str, Any]]], interval_s: float = RETENTION_INTERVAL_S,
                 start_delay_s: float = RETENTION_START_DELAY_S, log: Optional[Callable[[str], None]] = None) -> None:
        self._apply = apply
        self.interval_s = float(interval_s)
        self.start_delay_s = float(start_delay_s)
        self._log = log
        self._event = threading.Event()
        self._stopping = False
        self._thread = threading.Thread(target=self._run, name="receiver-retention", daemon=True)
        self.passes = 0

    def start(self) -> None:
        self._thread.start()

    def wake(self) -> None:
        self._event.set()

    def stop(self, timeout: float = 5.0) -> None:
        self._stopping = True
        self._event.set()
        if self._thread.is_alive():
            self._thread.join(timeout)

    def is_alive(self) -> bool:
        return self._thread.is_alive()

    def _run(self) -> None:
        delay = self.start_delay_s
        while True:
            self._event.wait(delay)
            if self._stopping:
                return
            self._event.clear()
            try:
                result = self._apply()
            except Exception as exc:  # one failed pass must not end the timer
                result = None
                if self._log is not None:
                    self._log(f"[ground-console] receiver retention pass failed: {type(exc).__name__}")
            self.passes += 1
            if self._stopping:
                return
            removed = 0
            if result:
                removed = int(result.get("audio", 0)) + int(result.get("scans", 0)) + int(result.get("sessions", 0))
            delay = 0.0 if result and result.get("more") and removed > 0 else self.interval_s
