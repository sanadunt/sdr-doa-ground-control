#!/usr/bin/env python3
"""Position of the groundstation from its own GNSS receiver (``ground/gps``).

The groundstation and the RDF-SDR stand in different places. A publisher on
the groundstation host (``packaging/ground-gps``, outside Docker) reads the
USB receiver's NMEA and publishes a retained status to the local broker every
2 s, on ``sdr/v2/<node>/ground/gps``. The console reads it leniently
(``docs/PRINSIP_DATA.md``): a field of the wrong type or outside its range
reads as null with a ``INVALID_FIELD:<name>`` note, unknown fields are
ignored, and only a payload that is not a ``v`` 1 JSON object of at most
512 bytes is refused.

The status's own ``t`` (the publisher's wall clock, the same host as the
console) dates it, so a retained status of a stopped publisher reads
``STALE`` after a console restart too. The position (lat, lon, alt, sog, cog)
is given only while the state is ``FIX``.
"""

from __future__ import annotations

import json
import math
from typing import Any, Dict, List, Mapping, Optional

GROUND_GPS_SUFFIX = "ground/gps"
STATUS_MAX_BYTES = 512
STATES = ("FIX", "NO_FIX", "NO_DEVICE", "NO_DATA", "ERROR", "STOPPED")
# Five missed 2 s statuses: the publisher stopped or lost the broker.
STATUS_STALE_MS = 10_000
# The publisher runs on the console's host, so its clock is the console's.
STATUS_FUTURE_MS = 2_000
FIX_TYPES = (0, 2, 3)
MAX_SATELLITES = 64
ALTITUDE_RANGE_M = (-1_000.0, 20_000.0)
HDOP_MAX = 100.0
SOG_MAX_MPS = 1_000.0
POSITION_KEYS = ("lat", "lon", "alt", "sog", "cog")


def _count(value: Any) -> Optional[int]:
    return value if type(value) is int and value >= 0 else None


def _number(value: Any) -> Optional[float]:
    if type(value) not in (int, float):
        return None
    try:
        number = float(value)
    except OverflowError:
        # A JSON integer beyond a float (400 digits) is no number either.
        return None
    return number if math.isfinite(number) else None


def _ranged(value: Any, low: float, high: float) -> Optional[float]:
    number = _number(value)
    return number if number is not None and low <= number <= high else None


def _text(value: Any, limit: int = 200) -> Optional[str]:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:limit] or None


def parse_status(payload: bytes) -> Dict[str, Any]:
    """The publisher's status as the console keeps it; raises ValueError with a code."""
    if len(payload) > STATUS_MAX_BYTES:
        raise ValueError("PAYLOAD_TOO_LARGE")
    try:
        data = json.loads(payload.decode("utf-8"), parse_constant=lambda _name: None)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise ValueError("MALFORMED_PAYLOAD") from None
    if not isinstance(data, dict):
        raise ValueError("MALFORMED_PAYLOAD")
    if type(data.get("v")) is not int or data["v"] != 1:
        raise ValueError("UNKNOWN_VERSION")
    notes: List[str] = []

    def field(name: str, value: Any) -> Any:
        # A field sent with a value the console cannot use reads as null,
        # noted; an empty text is simply no text.
        raw = data.get(name)
        if value is None and raw is not None and not (isinstance(raw, str) and not raw.strip()):
            notes.append(f"INVALID_FIELD:{name}")
        return value

    t = _number(data.get("t"))
    fix = data.get("fix")
    fix = fix if type(fix) is int and fix in FIX_TYPES else None
    sat = data.get("sat")
    sat = sat if type(sat) is int and 0 <= sat <= MAX_SATELLITES else None
    cog = _ranged(data.get("cog"), 0.0, 360.0)
    gnss_t = _number(data.get("gnss_t"))
    status = {
        "v": 1,
        "t": field("t", int(t) if t is not None and t >= 0 else None),
        "state": field("state", data.get("state") if data.get("state") in STATES else None),
        "device": field("device", _text(data.get("device"))),
        "fix": field("fix", fix),
        "sat": field("sat", sat),
        "lat": field("lat", _ranged(data.get("lat"), -90.0, 90.0)),
        "lon": field("lon", _ranged(data.get("lon"), -180.0, 180.0)),
        "alt": field("alt", _ranged(data.get("alt"), *ALTITUDE_RANGE_M)),
        "hdop": field("hdop", _ranged(data.get("hdop"), 0.0, HDOP_MAX)),
        "sog": field("sog", _ranged(data.get("sog"), 0.0, SOG_MAX_MPS)),
        "cog": field("cog", None if cog is None else cog % 360.0),
        "gnss_t": field("gnss_t", int(gnss_t) if gnss_t is not None and gnss_t >= 0 else None),
        "error": field("error", _text(data.get("error"))),
    }
    if (status["lat"] is None) != (status["lon"] is None):
        # Half a position is no position.
        status["lat"] = status["lon"] = None
        notes.append("PARTIAL_POSITION")
    status["notes"] = notes
    return status


class GroundGpsStore:
    """The latest status of the groundstation's GNSS publisher."""

    def __init__(self) -> None:
        self._latest: Optional[Dict[str, Any]] = None
        self.invalid = 0
        self.last_invalid: Optional[str] = None

    def ingest(self, payload: bytes, received_at_ms: int) -> bool:
        if not payload:
            # A retained clear: the publisher was removed.
            self._latest = None
            return True
        try:
            status = parse_status(payload)
        except ValueError as error:
            self.invalid += 1
            self.last_invalid = str(error)
            return False
        except Exception:
            # Called from the MQTT client's network thread: nothing a payload
            # holds may end it, so any other fault is a malformed payload.
            self.invalid += 1
            self.last_invalid = "MALFORMED_PAYLOAD"
            return False
        status["received_at_ms"] = received_at_ms
        self._latest = status
        return True

    def view(self, now_ms: int) -> Dict[str, Any]:
        """The ``ground_gps`` block of ``GET /api/mqtt`` and every ``/api/snapshot``."""
        status = self._latest
        view: Dict[str, Any] = {
            "present": status is not None,
            "state": "NONE",
            "lat": None,
            "lon": None,
            "alt": None,
            "fix": None,
            "sat": None,
            "hdop": None,
            "sog": None,
            "cog": None,
            "device": None,
            "error": None,
            "status_age_ms": None,
            "received_at_ms": None,
            "stale_after_ms": STATUS_STALE_MS,
            "notes": [],
            "invalid": self.invalid,
            "last_invalid": self.last_invalid,
        }
        if status is None:
            return view
        notes = list(status["notes"])
        for key in ("lat", "lon", "alt", "fix", "sat", "hdop", "sog", "cog", "device", "error"):
            view[key] = status[key]
        view["received_at_ms"] = status["received_at_ms"]
        t = status["t"]
        state = status["state"]
        if state is None:
            # A state this console does not know: no claim of a position.
            state = "NO_FIX"
            if "INVALID_FIELD:state" not in notes:
                notes.append("MISSING_FIELD:state")
        if t is None:
            # Undated, so its age is unknown: never shown as current.
            state = "STALE"
        else:
            age = now_ms - t
            view["status_age_ms"] = max(0, age)
            if age > STATUS_STALE_MS:
                state = "STALE"
            elif age < -STATUS_FUTURE_MS:
                state = "STALE"
                notes.append("SOURCE_TIME_FUTURE")
        if state == "FIX" and (view["lat"] is None or view["lon"] is None):
            state = "NO_FIX"
            notes.append("FIX_WITHOUT_POSITION")
        if state != "FIX":
            for key in POSITION_KEYS:
                view[key] = None
        view["state"] = state
        view["notes"] = notes
        return view


def with_ground_gps(answer: Mapping[str, Any], view: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    """A copy of one /api/snapshot answer with ``ground_gps`` (answers are shared between viewers)."""
    result = dict(answer)
    result["ground_gps"] = None if view is None else dict(view)
    return result


__all__ = ["GROUND_GPS_SUFFIX", "GroundGpsStore", "STATUS_STALE_MS", "parse_status", "with_ground_gps"]
