#!/usr/bin/env python3
"""Receiver mirror: the latest Receiver state and spectrum frame, in memory.

Issue #15, phase 2 (B1). The HackRF is read by the Receiver frame in the
groundstation's kiosk page (WebUSB). That page publishes what its Receiver
shows, and the LAN view draws it without a radio of its own:

* ``POST /api/mirror/receiver`` comes from the console's own page only (the
  same-origin loopback rule), while the LAN view is open. The body is at most
  ``MAX_BODY_BYTES``; at most ``MAX_POSTS_PER_S`` are taken in any second
  (429 beyond). The schema below is checked strictly: unknown fields, wrong
  types and values out of range are refused whole.
* ``GET /api/mirror/receiver`` answers on both listeners with the latest
  source, state and frame and their ages in the server's own clock: on the
  loopback listener under the Receiver's read rule (one loopback Host on the
  console's port; Sec-Fetch-Site absent, none or same-origin), on the LAN
  view under its own Host rule and without cross-site requests (403
  ORIGIN_REJECTED otherwise).

Nothing is written to disk: the latest POST replaces the previous one, and a
restart or a closed LAN view clears it. docs/RECEIVER_MIRROR.md is the
contract; ``frontend/src/lib/receiverMirror.ts`` holds the browser's copy of
these limits. Standard library only.
"""

from __future__ import annotations

import base64
import binascii
import json
import math
import re
import threading
import time
from collections import deque
from typing import Any, Callable, Deque, Dict, FrozenSet, Optional, Tuple

ROUTE = "/api/mirror/receiver"
VERSION = 1

# Request limits.
MAX_BODY_BYTES = 8 * 1024
MAX_POSTS_PER_S = 12
RATE_WINDOW_S = 1.0

# Stale rules for viewers (also in the GET answer): a frame older than
# FRAME_STALE_MS is stale; no POST for SOURCE_LOST_MS means the source is lost.
# The source sends its state at least every HEARTBEAT_MS.
FRAME_STALE_MS = 3_000
SOURCE_LOST_MS = 10_000
HEARTBEAT_MS = 2_000

# Spectrum frame: at most MAX_BINS bytes (u8) over [db_min, db_max].
MIN_BINS = 16
MAX_BINS = 512
DB_FLOOR = -200.0
DB_CEILING = 100.0
MIN_DB_SPAN = 1.0
# Displayed frequencies (the Receiver's Freq Shift included) and the shift itself.
MAX_ABS_FREQUENCY_HZ = 100_000_000_000
MAX_SAMPLE_RATE_HZ = 100_000_000
MAX_GAIN_DB = 200.0
MAX_VFO_INDEX = 63
MAX_REV = 2 ** 53 - 1

SOURCE_KINDS: FrozenSet[str] = frozenset({"kiosk-tab", "engine-tab"})
SOURCE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
BUSY_STATES: FrozenSet[str] = frozenset({"none", "sweep", "scan-listen"})
SCAN_PHASES: FrozenSet[str] = frozenset({"idle", "starting", "active", "stopping"})
FRAME_KINDS: FrozenSet[str] = frozenset({"rx", "sweep"})
LISTEN_MODES: FrozenSet[str] = frozenset({"nfm", "wfm", "am", "usb", "lsb", "dsb", "cw", "raw"})
ERROR_CODES: FrozenSet[str] = frozenset({"USB_LOST", "RX_ERROR", "NO_WEBUSB"})

# Error codes of the mirror routes ({ok: false, code, error}). They go through
# their own helper, so the Kontrol error-code contract never counts them.
MIRROR_INVALID = "MIRROR_INVALID"
MIRROR_TOO_LARGE = "MIRROR_TOO_LARGE"
MIRROR_RATE_LIMITED = "MIRROR_RATE_LIMITED"
MIRROR_LAN_CLOSED = "MIRROR_LAN_CLOSED"
ORIGIN_REJECTED = "ORIGIN_REJECTED"
LAN_CLOSED_MESSAGE = "the LAN view is closed; nothing is mirrored"
ERROR_CODES_HTTP = {
    ORIGIN_REJECTED: 403,
    MIRROR_INVALID: 400,
    MIRROR_TOO_LARGE: 413,
    MIRROR_RATE_LIMITED: 429,
    MIRROR_LAN_CLOSED: 409,
}


class MirrorRejected(ValueError):
    """A refused POST: the error code and a message naming the first bad field."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    @property
    def status(self) -> int:
        return ERROR_CODES_HTTP[self.code]


def _invalid(message: str) -> MirrorRejected:
    return MirrorRejected(MIRROR_INVALID, message)


def _object(value: Any, field: str, required: FrozenSet[str], optional: FrozenSet[str] = frozenset()) -> Dict[str, Any]:
    """A JSON object with exactly the required keys and some of the optional ones."""
    if not isinstance(value, dict):
        raise _invalid(f"{field} must be an object")
    unknown = sorted(str(key) for key in value if key not in required and key not in optional)
    if unknown:
        raise _invalid(f"{field} has unknown field(s): {', '.join(unknown)}")
    missing = sorted(key for key in required if key not in value)
    if missing:
        raise _invalid(f"{field} lacks {', '.join(missing)}")
    return value


def _boolean(value: Any, field: str) -> bool:
    if not isinstance(value, bool):
        raise _invalid(f"{field} must be true or false")
    return value


def _integer(value: Any, field: str, low: int, high: int, *, nullable: bool = False) -> Optional[int]:
    """A JSON integer without coercion: no booleans, fractions or strings."""
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise _invalid(f"{field} must be an integer")
    if not low <= value <= high:
        raise _invalid(f"{field} is out of range")
    return value


def _number(value: Any, field: str, low: float, high: float, *, nullable: bool = False) -> Optional[float]:
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _invalid(f"{field} must be a finite number")
    # A JSON integer is always finite and is compared exactly below;
    # math.isfinite() would raise OverflowError on one beyond a float.
    if isinstance(value, float) and not math.isfinite(value):
        raise _invalid(f"{field} must be a finite number")
    if not low <= value <= high:
        raise _invalid(f"{field} is out of range")
    return value


def _token(value: Any, field: str, allowed: FrozenSet[str], *, nullable: bool = False) -> Optional[str]:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or value not in allowed:
        raise _invalid(f"{field} must be one of {', '.join(sorted(allowed))}")
    return value


def _hz(value: Any, field: str, *, nullable: bool = False) -> Optional[int]:
    return _integer(value, field, -MAX_ABS_FREQUENCY_HZ, MAX_ABS_FREQUENCY_HZ, nullable=nullable)


def _positive_hz(value: Any, field: str, high: int, *, nullable: bool = True) -> Optional[int]:
    return _integer(value, field, 1, high, nullable=nullable)


def _source(value: Any) -> Dict[str, Any]:
    raw = _object(value, "source", frozenset({"id", "kind", "visible"}))
    source_id = raw["id"]
    if not isinstance(source_id, str) or not SOURCE_ID_PATTERN.match(source_id):
        raise _invalid("source.id must be 8 to 64 letters, digits, '-' or '_'")
    return {
        "id": source_id,
        "kind": _token(raw["kind"], "source.kind", SOURCE_KINDS),
        "visible": _boolean(raw["visible"], "source.visible"),
    }


def _gains(value: Any, field: str = "state.gains") -> Dict[str, Any]:
    raw = _object(value, field, frozenset({"lna_db", "vga_db", "amp"}))
    return {
        "lna_db": _number(raw["lna_db"], f"{field}.lna_db", 0, MAX_GAIN_DB, nullable=True),
        "vga_db": _number(raw["vga_db"], f"{field}.vga_db", 0, MAX_GAIN_DB, nullable=True),
        "amp": _boolean(raw["amp"], f"{field}.amp"),
    }


def _vfo(value: Any) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    raw = _object(value, "state.vfo", frozenset({
        "index", "enabled", "mode", "frequency_hz", "bandwidth_hz", "squelch_enabled", "squelch_db",
    }))
    return {
        "index": _integer(raw["index"], "state.vfo.index", 0, MAX_VFO_INDEX),
        "enabled": _boolean(raw["enabled"], "state.vfo.enabled"),
        "mode": _token(raw["mode"], "state.vfo.mode", LISTEN_MODES, nullable=True),
        "frequency_hz": _hz(raw["frequency_hz"], "state.vfo.frequency_hz", nullable=True),
        "bandwidth_hz": _positive_hz(raw["bandwidth_hz"], "state.vfo.bandwidth_hz", MAX_SAMPLE_RATE_HZ),
        "squelch_enabled": _boolean(raw["squelch_enabled"], "state.vfo.squelch_enabled"),
        "squelch_db": _number(raw["squelch_db"], "state.vfo.squelch_db", DB_FLOOR, DB_CEILING, nullable=True),
    }


def _scan(value: Any) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    # gains is the scan's own LNA, VGA and amp. A page loaded before it was
    # mirrored sends none; it is kept as null (unknown), so such a page keeps
    # publishing until it reloads.
    raw = _object(value, "state.scan", frozenset({"phase", "start_hz", "stop_hz", "resolution_hz"}), frozenset({"gains"}))
    start = _hz(raw["start_hz"], "state.scan.start_hz", nullable=True)
    stop = _hz(raw["stop_hz"], "state.scan.stop_hz", nullable=True)
    if start is not None and stop is not None and stop <= start:
        raise _invalid("state.scan.stop_hz must be above start_hz")
    gains = raw.get("gains")
    return {
        "phase": _token(raw["phase"], "state.scan.phase", SCAN_PHASES),
        "start_hz": start,
        "stop_hz": stop,
        "resolution_hz": _number(raw["resolution_hz"], "state.scan.resolution_hz", 0.001, MAX_SAMPLE_RATE_HZ, nullable=True),
        "gains": None if gains is None else _gains(gains, "state.scan.gains"),
    }


STATE_FIELDS = frozenset({
    "rev", "t_ms", "connected", "running", "recording", "mock", "busy", "center_hz", "sample_rate_hz", "span_hz",
    "frequency_shift_hz", "gains", "vfo", "scan", "error",
})


def _state(value: Any) -> Dict[str, Any]:
    raw = _object(value, "state", STATE_FIELDS)
    return {
        "rev": _integer(raw["rev"], "state.rev", 0, MAX_REV),
        "t_ms": _integer(raw["t_ms"], "state.t_ms", 0, MAX_REV),
        "connected": _boolean(raw["connected"], "state.connected"),
        "running": _boolean(raw["running"], "state.running"),
        "recording": _boolean(raw["recording"], "state.recording"),
        "mock": _boolean(raw["mock"], "state.mock"),
        "busy": _token(raw["busy"], "state.busy", BUSY_STATES),
        "center_hz": _hz(raw["center_hz"], "state.center_hz", nullable=True),
        "sample_rate_hz": _positive_hz(raw["sample_rate_hz"], "state.sample_rate_hz", MAX_SAMPLE_RATE_HZ),
        "span_hz": _positive_hz(raw["span_hz"], "state.span_hz", MAX_SAMPLE_RATE_HZ),
        "frequency_shift_hz": _hz(raw["frequency_shift_hz"], "state.frequency_shift_hz"),
        "gains": _gains(raw["gains"]),
        "vfo": _vfo(raw["vfo"]),
        "scan": _scan(raw["scan"]),
        "error": _token(raw["error"], "state.error", ERROR_CODES, nullable=True),
    }


def _bins(value: Any, count: int) -> str:
    """The base64 text of exactly ``count`` bytes, in its canonical form."""
    if not isinstance(value, str) or len(value) != 4 * ((count + 2) // 3):
        raise _invalid(f"frame.bins must be the base64 of {count} bytes")
    try:
        raw = base64.b64decode(value.encode("ascii"), validate=True)
    except (binascii.Error, UnicodeEncodeError) as exc:
        raise _invalid("frame.bins must be the base64 of the bin bytes") from exc
    if len(raw) != count:
        raise _invalid(f"frame.bins must be the base64 of {count} bytes")
    return value


FRAME_FIELDS = frozenset({"seq", "t_ms", "kind", "center_hz", "start_hz", "stop_hz", "bin_count", "db_min", "db_max", "bins"})


def _frame(value: Any) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    raw = _object(value, "frame", FRAME_FIELDS)
    start = _hz(raw["start_hz"], "frame.start_hz")
    stop = _hz(raw["stop_hz"], "frame.stop_hz")
    center = _hz(raw["center_hz"], "frame.center_hz")
    assert start is not None and stop is not None and center is not None
    if stop <= start:
        raise _invalid("frame.stop_hz must be above start_hz")
    if not start <= center <= stop:
        raise _invalid("frame.center_hz must lie between start_hz and stop_hz")
    db_min = _number(raw["db_min"], "frame.db_min", DB_FLOOR, DB_CEILING)
    db_max = _number(raw["db_max"], "frame.db_max", DB_FLOOR, DB_CEILING)
    assert db_min is not None and db_max is not None
    if db_max - db_min < MIN_DB_SPAN:
        raise _invalid(f"frame.db_max must be at least {MIN_DB_SPAN:g} dB above db_min")
    count = _integer(raw["bin_count"], "frame.bin_count", MIN_BINS, MAX_BINS)
    assert count is not None
    return {
        "seq": _integer(raw["seq"], "frame.seq", 0, MAX_REV),
        "t_ms": _integer(raw["t_ms"], "frame.t_ms", 0, MAX_REV),
        "kind": _token(raw["kind"], "frame.kind", FRAME_KINDS),
        "center_hz": center,
        "start_hz": start,
        "stop_hz": stop,
        "bin_count": count,
        "db_min": db_min,
        "db_max": db_max,
        "bins": _bins(raw["bins"], count),
    }


def parse_publish(payload: Any) -> Tuple[Dict[str, Any], Dict[str, Any], Optional[Dict[str, Any]]]:
    """Source, state and frame (or None) of a POST body; MirrorRejected names the first bad field."""
    raw = _object(payload, "body", frozenset({"v", "source", "state"}), frozenset({"frame"}))
    if isinstance(raw["v"], bool) or raw["v"] != VERSION:
        raise _invalid(f"v must be {VERSION}")
    return _source(raw["source"]), _state(raw["state"]), _frame(raw.get("frame"))


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def decode_publish(raw: bytes) -> Tuple[Dict[str, Any], Dict[str, Any], Optional[Dict[str, Any]]]:
    """parse_publish of a raw POST body (UTF-8 JSON; NaN and Infinity are refused).

    Every refusal is a MirrorRejected: a body nested too deeply for the JSON
    decoder (RecursionError up to Python 3.11) is invalid JSON here too.
    """
    if len(raw) > MAX_BODY_BYTES:
        raise MirrorRejected(MIRROR_TOO_LARGE, f"the body must be at most {MAX_BODY_BYTES} bytes")
    try:
        payload = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise _invalid("the body is not valid JSON") from exc
    return parse_publish(payload)


def limits() -> Dict[str, int]:
    """The contract's numbers, as the GET answer carries them."""
    return {
        "frame_stale_ms": FRAME_STALE_MS,
        "source_lost_ms": SOURCE_LOST_MS,
        "heartbeat_ms": HEARTBEAT_MS,
        "max_bins": MAX_BINS,
        "max_body_bytes": MAX_BODY_BYTES,
        "max_posts_per_s": MAX_POSTS_PER_S,
    }


class ReceiverMirror:
    """The latest published source, state and frame; latest wins, memory only.

    ``admit`` is the rate rule (at most MAX_POSTS_PER_S taken in any
    RATE_WINDOW_S; a refused POST does not count). Ages use ``clock``
    (monotonic seconds), so the kiosk's and the viewers' clocks never matter.

    The mirror takes posts only between ``open()`` and ``close()``, which the
    LAN view's manager calls with its listener under its own lock. ``close()``
    forgets everything in the same step, so a POST that found the LAN view
    open and is still decoding when it closes is refused by ``publish()``
    instead of storing its state after the clear.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._taken: Deque[float] = deque()
        self._source: Optional[Dict[str, Any]] = None
        self._state: Optional[Dict[str, Any]] = None
        self._frame: Optional[Dict[str, Any]] = None
        self._seen_at: Optional[float] = None
        self._state_at: Optional[float] = None
        self._frame_at: Optional[float] = None
        self._open = False
        # Server-side counters: every accepted POST, and every accepted frame.
        self._rev = 0
        self._frame_rev = 0
        self.refused = 0

    def admit(self) -> bool:
        with self._lock:
            now = self._clock()
            while self._taken and now - self._taken[0] >= RATE_WINDOW_S:
                self._taken.popleft()
            if len(self._taken) >= MAX_POSTS_PER_S:
                self.refused += 1
                return False
            self._taken.append(now)
            return True

    def open(self) -> None:
        """Take posts from now on (the LAN view opened)."""
        with self._lock:
            self._open = True

    def close(self) -> None:
        """Refuse posts and forget everything (the LAN view closed, moved or was disabled)."""
        with self._lock:
            self._open = False
            self._source = None
            self._state = None
            self._frame = None
            self._seen_at = None
            self._state_at = None
            self._frame_at = None

    def is_open(self) -> bool:
        with self._lock:
            return self._open

    def publish(self, source: Dict[str, Any], state: Dict[str, Any], frame: Optional[Dict[str, Any]]) -> Dict[str, int]:
        """Keep this POST as the latest; a frame of another source than the stored one is not kept.

        Raises MirrorRejected (MIRROR_LAN_CLOSED) while the mirror is closed.
        """
        with self._lock:
            if not self._open:
                raise MirrorRejected(MIRROR_LAN_CLOSED, LAN_CLOSED_MESSAGE)
            now = self._clock()
            if self._source is not None and self._source["id"] != source["id"]:
                # Another page took over: nothing of the previous one stays.
                self._frame = None
                self._frame_at = None
            self._source = source
            self._state = state
            self._seen_at = now
            self._state_at = now
            self._rev += 1
            if frame is not None:
                self._frame = frame
                self._frame_at = now
                self._frame_rev += 1
            return {"rev": self._rev, "frame_rev": self._frame_rev}

    def _age_ms(self, at: Optional[float], now: float) -> Optional[int]:
        return None if at is None else max(0, int(round((now - at) * 1000)))

    def view(self) -> Dict[str, Any]:
        """Body of GET /api/mirror/receiver."""
        with self._lock:
            now = self._clock()
            return {
                "ok": True,
                "v": VERSION,
                "rev": self._rev,
                "frame_rev": self._frame_rev,
                "source": dict(self._source) if self._source is not None else None,
                "source_age_ms": self._age_ms(self._seen_at, now),
                "state": self._state,
                "state_age_ms": self._age_ms(self._state_at, now),
                "frame": self._frame,
                "frame_age_ms": self._age_ms(self._frame_at, now),
                "limits": limits(),
            }
