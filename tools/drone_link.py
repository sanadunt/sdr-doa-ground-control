#!/usr/bin/env python3
"""Telemetry of the SIYI drone, read from the SIYI Bridge on its remote.

The RDF-SDR flies inside a SIYI drone. The drone's remote (SIYI MK32) runs
SIYI Bridge, which decodes the flight controller's MAVLink and publishes it as
retained JSON on its own MQTT broker (port 1883): ``drone/status``,
``drone/battery``, ``drone/gps``, ``drone/position``, ``drone/attitude``,
``drone/hud``, ``drone/statustext`` and its own ``bridge/link``. Field names
are the bridge's (``decode.go``).

This is a second MQTT client of the console, apart from the RDF Node monitor,
and it only subscribes: nothing is ever published to the drone's broker. It
subscribes to the eight topics by name, never ``drone/#``, because the bridge
also publishes hundreds of retained ``drone/raw/*`` and ``drone/other/*``
topics from frames it could not check.

Values are read leniently (``docs/PRINSIP_DATA.md``): a field of the wrong
type or outside its range reads as null with an ``INVALID_FIELD:<name>`` note,
and MAVLink's own "unknown" values (a heading of 655.35, an HDOP of 99.99 or
more, a position at 0/0) read as null without one. Payloads carry no
timestamp, so every topic is dated by the console's receipt time and is
stale after 10 s (the real link pauses up to about 5.5 s).

The drone's yaw is kept for 60 s, so the bearing of a DoA sample can be
turned with the yaw the drone had when the sample was taken
(``heading_at``), never with a yaw from another moment.
"""

from __future__ import annotations

import bisect
import json
import math
import secrets
import threading
import time
from collections import deque
from typing import Any, Callable, Deque, Dict, List, Mapping, Optional, Tuple

DRONE_TOPICS = (
    "drone/status",
    "drone/battery",
    "drone/gps",
    "drone/position",
    "drone/attitude",
    "drone/hud",
    "drone/statustext",
    "bridge/link",
)
DRONE_PORT = 1883
PAYLOAD_MAX_BYTES = 4096
# The real link pauses up to about 5.5 s; a topic is stale after twice that.
STALE_MS = 10_000
# A DoA sample takes the drone's yaw only from a sample this close to it.
HEADING_MATCH_MS = 1_000
HEADING_HISTORY_MS = 60_000
HEADING_HISTORY_MAX = 2_000
STATUSTEXT_MAX = 200
CLIENT_ID_PREFIX = "gcdrone"
RECONNECT_MIN_DELAY_S = 1
RECONNECT_MAX_DELAY_S = 10
GPS_FIX_NAMES = {0: "NO_GPS", 1: "NO_FIX", 2: "2D", 3: "3D", 4: "DGPS", 5: "RTK_FLOAT", 6: "RTK_FIXED", 7: "STATIC", 8: "PPP"}
# GPS_FIX_TYPE 3 and above has a usable 3D position.
POSITION_FIX_MIN = 3


def _now_ms() -> int:
    return int(time.time() * 1000)


def _number(value: Any) -> Optional[float]:
    if type(value) not in (int, float):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) else None


def _ranged(value: Any, low: float, high: float) -> Optional[float]:
    number = _number(value)
    return number if number is not None and low <= number <= high else None


def _integer(value: Any, low: int, high: int) -> Optional[int]:
    return value if type(value) is int and low <= value <= high else None


def _text(value: Any, limit: int = 64) -> Optional[str]:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:limit] or None


def _flag(value: Any) -> Optional[bool]:
    return value if isinstance(value, bool) else None


def _wrap360(deg: float) -> float:
    return deg % 360.0


class _Fields:
    """Collects one payload's fields and the notes of those it could not use."""

    def __init__(self, data: Mapping[str, Any]) -> None:
        self.data = data
        self.values: Dict[str, Any] = {}
        self.notes: List[str] = []

    def put(self, name: str, value: Any, *, unknown: bool = False) -> None:
        # A value sent but unusable is noted, unless it is MAVLink's own "unknown".
        raw = self.data.get(name)
        if value is None and raw is not None and not unknown:
            self.notes.append(f"INVALID_FIELD:{name}")
        self.values[name] = value


def _position_pair(fields: _Fields, lat_key: str = "lat", lon_key: str = "lon") -> None:
    lat = _ranged(fields.data.get(lat_key), -90.0, 90.0)
    lon = _ranged(fields.data.get(lon_key), -180.0, 180.0)
    if lat == 0.0 and lon == 0.0:
        # The FC sends 0/0 until it has a fix.
        fields.put(lat_key, None, unknown=True)
        fields.put(lon_key, None, unknown=True)
        return
    if (lat is None) != (lon is None):
        if lat is None:
            fields.put(lat_key, None)
            fields.put(lon_key, None, unknown=True)
        else:
            fields.put(lat_key, None, unknown=True)
            fields.put(lon_key, None)
        return
    fields.put(lat_key, lat)
    fields.put(lon_key, lon)


def _heading(fields: _Fields, name: str) -> None:
    value = _number(fields.data.get(name))
    # 655.35 (UINT16_MAX / 100) is MAVLink's "unknown heading".
    if value is not None and 0.0 <= value < 360.0:
        fields.put(name, value)
    else:
        fields.put(name, None, unknown=value is not None and value >= 360.0)


def _parse_status(f: _Fields) -> None:
    f.put("armed", _flag(f.data.get("armed")))
    f.put("custom_mode", _integer(f.data.get("custom_mode"), 0, 2**32 - 1))
    f.put("base_mode", _integer(f.data.get("base_mode"), 0, 255))
    f.put("system_status", _integer(f.data.get("system_status"), 0, 255))
    f.put("type_name", _text(f.data.get("type_name")))
    f.put("autopilot_name", _text(f.data.get("autopilot_name")))


def _parse_battery(f: _Fields) -> None:
    f.put("voltage_v", _ranged(f.data.get("voltage_v"), 0.0, 100.0))
    f.put("current_a", _ranged(f.data.get("current_a"), -500.0, 500.0))
    # null is the FC saying it does not know.
    f.put("remaining_pct", _ranged(f.data.get("remaining_pct"), 0.0, 100.0))
    f.put("cpu_load_pct", _ranged(f.data.get("cpu_load_pct"), 0.0, 100.0))


def _parse_gps(f: _Fields) -> None:
    f.put("fix", _integer(f.data.get("fix"), 0, 8))
    f.put("fix_name", _text(f.data.get("fix_name")))
    satellites = f.data.get("satellites")
    f.put("satellites", _integer(satellites, 0, 254), unknown=satellites == 255)
    _position_pair(f)
    f.put("alt_m", _ranged(f.data.get("alt_m"), -1_000.0, 20_000.0))
    hdop = _number(f.data.get("hdop"))
    # 99.99 and 655.35 are "unknown" from GPS receivers and MAVLink.
    f.put("hdop", hdop if hdop is not None and 0.0 <= hdop < 99.99 else None, unknown=hdop is not None and hdop >= 99.99)
    f.put("speed_ms", _ranged(f.data.get("speed_ms"), 0.0, 600.0))
    _heading(f, "course_deg")


def _parse_position(f: _Fields) -> None:
    _position_pair(f)
    f.put("alt_msl_m", _ranged(f.data.get("alt_msl_m"), -1_000.0, 20_000.0))
    f.put("alt_rel_m", _ranged(f.data.get("alt_rel_m"), -10_000.0, 20_000.0))
    for name in ("vx_ms", "vy_ms", "vz_ms"):
        f.put(name, _ranged(f.data.get(name), -600.0, 600.0))
    f.put("speed_ms", _ranged(f.data.get("speed_ms"), 0.0, 600.0))
    _heading(f, "heading_deg")


def _parse_attitude(f: _Fields) -> None:
    f.put("roll_deg", _ranged(f.data.get("roll_deg"), -180.0, 180.0))
    f.put("pitch_deg", _ranged(f.data.get("pitch_deg"), -180.0, 180.0))
    yaw = _ranged(f.data.get("yaw_deg"), -360.0, 360.0)
    f.put("yaw_deg", None if yaw is None else _wrap360(yaw))
    for name in ("rollspeed_dps", "pitchspeed_dps", "yawspeed_dps"):
        f.put(name, _ranged(f.data.get(name), -10_000.0, 10_000.0))


def _parse_hud(f: _Fields) -> None:
    f.put("airspeed_ms", _ranged(f.data.get("airspeed_ms"), -600.0, 600.0))
    f.put("groundspeed_ms", _ranged(f.data.get("groundspeed_ms"), 0.0, 600.0))
    f.put("alt_m", _ranged(f.data.get("alt_m"), -10_000.0, 20_000.0))
    f.put("climb_ms", _ranged(f.data.get("climb_ms"), -600.0, 600.0))
    _heading(f, "heading_deg")
    f.put("throttle_pct", _ranged(f.data.get("throttle_pct"), 0.0, 100.0))


def _parse_statustext(f: _Fields) -> None:
    f.put("severity", _integer(f.data.get("severity"), 0, 7))
    f.put("text", _text(f.data.get("text"), STATUSTEXT_MAX))


def _parse_link(f: _Fields) -> None:
    f.put("fc_online", _flag(f.data.get("fc_online")))
    f.put("fc_last_seen_s", _ranged(f.data.get("fc_last_seen_s"), -1.0, 1e9))
    f.put("frames_per_s", _ranged(f.data.get("frames_per_s"), 0.0, 100_000.0))
    f.put("camera_online", _flag(f.data.get("camera_online")))
    f.put("camera", _text(f.data.get("camera"), 200))
    f.put("telemetry", _text(f.data.get("telemetry"), 200))
    f.put("uptime_s", _ranged(f.data.get("uptime_s"), 0.0, 1e10))
    f.put("version", _text(f.data.get("version"), 32))


_PARSERS: Dict[str, Callable[[_Fields], None]] = {
    "drone/status": _parse_status,
    "drone/battery": _parse_battery,
    "drone/gps": _parse_gps,
    "drone/position": _parse_position,
    "drone/attitude": _parse_attitude,
    "drone/hud": _parse_hud,
    "drone/statustext": _parse_statustext,
    "bridge/link": _parse_link,
}


def parse_payload(topic: str, payload: bytes) -> Dict[str, Any]:
    """One topic's fields as the console keeps them; raises ValueError with a code."""
    parser = _PARSERS.get(topic)
    if parser is None:
        raise ValueError("UNKNOWN_TOPIC")
    if len(payload) > PAYLOAD_MAX_BYTES:
        raise ValueError("PAYLOAD_TOO_LARGE")
    try:
        data = json.loads(payload.decode("utf-8"), parse_constant=lambda _name: None)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise ValueError("MALFORMED_PAYLOAD") from None
    if not isinstance(data, dict):
        raise ValueError("MALFORMED_PAYLOAD")
    fields = _Fields(data)
    parser(fields)
    if topic != "bridge/link":
        fields.put("sysid", _integer(data.get("sysid"), 0, 255))
    return {"values": fields.values, "notes": fields.notes}


def _signed_turn(deg: float) -> float:
    """The shortest turn, -180..180, that is ``deg`` degrees."""
    return (deg + 180.0) % 360.0 - 180.0


class _HeadingHistory:
    """Yaw samples by receipt time, for the yaw at a DoA sample's moment."""

    def __init__(self) -> None:
        self._times: Deque[int] = deque()
        self._values: Deque[float] = deque()

    def add(self, t_ms: int, deg: float) -> None:
        if self._times and t_ms < self._times[-1]:
            # The wall clock went back: older samples no longer line up.
            self._times.clear()
            self._values.clear()
        self._times.append(t_ms)
        self._values.append(deg)
        while self._times and (t_ms - self._times[0] > HEADING_HISTORY_MS or len(self._times) > HEADING_HISTORY_MAX):
            self._times.popleft()
            self._values.popleft()

    def at(self, t_ms: int) -> Optional[Tuple[float, int]]:
        times = list(self._times)
        if not times:
            return None
        values = list(self._values)
        index = bisect.bisect_left(times, t_ms)
        before = index - 1 if index > 0 else None
        after = index if index < len(times) else None
        if before is not None and after is not None:
            gap_before = t_ms - times[before]
            gap_after = times[after] - t_ms
            if gap_before <= HEADING_MATCH_MS and gap_after <= HEADING_MATCH_MS:
                span = times[after] - times[before]
                share = 0.0 if span <= 0 else gap_before / span
                turn = _signed_turn(values[after] - values[before])
                return _wrap360(values[before] + turn * share), min(gap_before, gap_after)
        nearest = min(
            (i for i in (before, after) if i is not None),
            key=lambda i: abs(times[i] - t_ms),
        )
        gap = abs(times[nearest] - t_ms)
        if gap > HEADING_MATCH_MS:
            return None
        return values[nearest], gap


def _rtk(fix: Optional[int]) -> str:
    return {5: "FLOAT", 6: "FIXED"}.get(fix if fix is not None else -1, "NONE")


class DroneStore:
    """The latest value of every drone topic, with the yaw history."""

    def __init__(self) -> None:
        self._latest: Dict[str, Dict[str, Any]] = {}
        self._attitude_yaw = _HeadingHistory()
        self._position_heading = _HeadingHistory()
        self.invalid = 0
        self.last_invalid: Optional[str] = None
        self.received = 0

    def ingest(self, topic: str, payload: bytes, received_at_ms: int) -> bool:
        if topic not in _PARSERS:
            return False
        self.received += 1
        if not payload:
            # A retained clear: the bridge forgot the value.
            self._latest.pop(topic, None)
            return True
        try:
            parsed = parse_payload(topic, payload)
        except ValueError as error:
            self.invalid += 1
            self.last_invalid = f"{topic}:{error}"
            return False
        except Exception:
            # Called from the MQTT network thread: nothing a payload holds may end it.
            self.invalid += 1
            self.last_invalid = f"{topic}:MALFORMED_PAYLOAD"
            return False
        parsed["received_at_ms"] = received_at_ms
        self._latest[topic] = parsed
        values = parsed["values"]
        if topic == "drone/attitude" and values.get("yaw_deg") is not None:
            self._attitude_yaw.add(received_at_ms, values["yaw_deg"])
        elif topic == "drone/position" and values.get("heading_deg") is not None:
            self._position_heading.add(received_at_ms, values["heading_deg"])
        return True

    def heading_at(self, t_ms: int) -> Optional[Dict[str, Any]]:
        """The drone's yaw at ``t_ms`` (console clock), or None when no sample is within 1 s."""
        for source, history in (("attitude", self._attitude_yaw), ("position", self._position_heading)):
            found = history.at(t_ms)
            if found is not None:
                return {"deg": round(found[0], 3), "offset_ms": int(found[1]), "source": source}
        return None

    def _topic(self, topic: str, now_ms: int, keys: Tuple[str, ...]) -> Optional[Dict[str, Any]]:
        entry = self._latest.get(topic)
        if entry is None:
            return None
        age = max(0, now_ms - entry["received_at_ms"])
        block = {key: entry["values"].get(key) for key in keys}
        block["age_ms"] = age
        block["stale"] = age > STALE_MS
        return block

    def view(self, now_ms: int) -> Dict[str, Any]:
        position = self._topic(
            "drone/position", now_ms,
            ("lat", "lon", "alt_msl_m", "alt_rel_m", "vx_ms", "vy_ms", "vz_ms", "speed_ms", "heading_deg"),
        )
        gps = self._topic("drone/gps", now_ms, ("fix", "fix_name", "satellites", "hdop", "lat", "lon", "alt_m", "speed_ms", "course_deg"))
        if gps is not None:
            gps["fix_label"] = GPS_FIX_NAMES.get(gps["fix"]) if gps["fix"] is not None else None
            gps["rtk"] = _rtk(gps["fix"])
        attitude = self._topic("drone/attitude", now_ms, ("roll_deg", "pitch_deg", "yaw_deg", "yawspeed_dps"))
        battery = self._topic("drone/battery", now_ms, ("voltage_v", "current_a", "remaining_pct"))
        status = self._topic("drone/status", now_ms, ("armed", "custom_mode", "system_status", "type_name", "autopilot_name"))
        hud = self._topic("drone/hud", now_ms, ("groundspeed_ms", "airspeed_ms", "climb_ms", "throttle_pct", "alt_m"))
        statustext = self._topic("drone/statustext", now_ms, ("severity", "text"))
        if statustext is not None:
            statustext.pop("stale", None)
        link = self._topic("bridge/link", now_ms, ("fc_online", "fc_last_seen_s", "frames_per_s", "camera_online", "uptime_s", "version"))
        heading = None
        for source, block, key in (("attitude", attitude, "yaw_deg"), ("position", position, "heading_deg")):
            if block is not None and not block["stale"] and block.get(key) is not None:
                heading = {"deg": block[key], "source": source, "age_ms": block["age_ms"]}
                break
        drone_topics = [
            entry for topic, entry in self._latest.items() if topic.startswith("drone/") and topic != "drone/statustext"
        ]
        if not drone_topics:
            state = "NO_DATA"
        elif any(
            block is not None and not block["stale"] for block in (position, attitude, gps)
        ):
            state = "LIVE"
        else:
            state = "STALE"
        notes: List[str] = []
        for topic in DRONE_TOPICS:
            entry = self._latest.get(topic)
            if entry is not None:
                notes.extend(f"{topic}:{note}" for note in entry["notes"])
        return {
            "state": state,
            "position": position,
            "gps": gps,
            "attitude": attitude,
            "battery": battery,
            "status": status,
            "hud": hud,
            "statustext": statustext,
            "link": None if link is None else dict(link, present=True),
            "heading": heading,
            "received": self.received,
            "invalid": self.invalid,
            "last_invalid": self.last_invalid,
            "notes": notes[:32],
        }


class DroneLink:
    """The console's subscribe-only MQTT client for the drone's remote."""

    def __init__(self, host: str, port: int = DRONE_PORT, *, client_factory: Optional[Callable[..., Any]] = None,
                 clock: Callable[[], int] = _now_ms) -> None:
        self.host = host
        self.port = int(port)
        self.client_id = CLIENT_ID_PREFIX + secrets.token_hex(6)
        self._client_factory = client_factory
        self._clock = clock
        self._store = DroneStore()
        self._lock = threading.RLock()
        self._client: Any = None
        self._started = False
        self._connection = "stopped"
        self._last_error: Optional[str] = None
        self._down_since_ms: Optional[int] = None

    @property
    def connection(self) -> str:
        with self._lock:
            return self._connection

    def _new_client(self) -> Any:
        if self._client_factory is not None:
            return self._client_factory(client_id=self.client_id)
        import paho.mqtt.client as mqtt  # imported late: the console starts without paho

        return mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=self.client_id,
            protocol=mqtt.MQTTv311,
            clean_session=True,
        )

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            self._started = True
            self._connection = "connecting"
            self._down_since_ms = self._clock()
        try:
            client = self._new_client()
            client.on_connect = self._on_connect
            client.on_disconnect = self._on_disconnect
            client.on_message = self._on_message
            if hasattr(client, "on_connect_fail"):
                client.on_connect_fail = self._on_connect_fail
            client.reconnect_delay_set(min_delay=RECONNECT_MIN_DELAY_S, max_delay=RECONNECT_MAX_DELAY_S)
            with self._lock:
                self._client = client
            client.connect_async(self.host, self.port, keepalive=15)
            client.loop_start()
        except Exception as exc:
            with self._lock:
                self._connection = "error"
                self._last_error = str(exc) or type(exc).__name__

    def stop(self) -> None:
        with self._lock:
            client = self._client
            self._client = None
            self._started = False
            self._connection = "stopped"
        if client is None:
            return
        for call in ("disconnect", "loop_stop"):
            try:
                getattr(client, call)()
            except Exception:
                pass

    def _on_connect(self, client: Any, _userdata: Any, _flags: Any, reason_code: Any, _properties: Any = None) -> None:
        with self._lock:
            if client is not self._client:
                return
            code = getattr(reason_code, "value", reason_code)
            try:
                failed = int(code) != 0
            except (TypeError, ValueError):
                failed = bool(getattr(reason_code, "is_failure", False))
            if failed:
                self._connection = "error"
                self._last_error = f"connect refused: {reason_code}"
                return
            try:
                client.subscribe([(topic, 0) for topic in DRONE_TOPICS])
            except Exception as exc:
                self._connection = "error"
                self._last_error = f"subscribe failed: {exc}"
                return
            self._connection = "connected"
            self._last_error = None
            self._down_since_ms = None

    def _on_connect_fail(self, client: Any, _userdata: Any = None) -> None:
        with self._lock:
            if client is self._client:
                self._connection = "error"
                self._last_error = "connect failed"

    def _on_disconnect(self, client: Any, _userdata: Any, *_args: Any) -> None:
        with self._lock:
            if client is not self._client or not self._started:
                return
            self._connection = "disconnected"
            self._last_error = "disconnected"
            if self._down_since_ms is None:
                self._down_since_ms = self._clock()

    def _on_message(self, client: Any, _userdata: Any, message: Any) -> None:
        payload = getattr(message, "payload", None)
        if not isinstance(payload, bytes):
            return
        received = self._clock()
        with self._lock:
            if client is not self._client:
                return
            self._store.ingest(str(getattr(message, "topic", "")), payload, received)

    def disconnected_for_ms(self, now_ms: Optional[int] = None) -> int:
        """How long the link has been without a broker connection (0 while connected)."""
        with self._lock:
            if self._down_since_ms is None:
                return 0
            return max(0, (self._clock() if now_ms is None else now_ms) - self._down_since_ms)

    def heading_at(self, t_ms: int) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self._store.heading_at(t_ms)

    def view(self, now_ms: Optional[int] = None) -> Dict[str, Any]:
        now = self._clock() if now_ms is None else now_ms
        with self._lock:
            view = self._store.view(now)
            view.update({
                "host": self.host,
                "port": self.port,
                "connection": self._connection,
                "last_error": self._last_error,
            })
        return view


def with_drone(answer: Mapping[str, Any], view: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    """A copy of one /api/snapshot answer with ``drone`` (answers are shared between viewers)."""
    result = dict(answer)
    result["drone"] = None if view is None else dict(view)
    return result


__all__ = [
    "DRONE_PORT",
    "DRONE_TOPICS",
    "DroneLink",
    "DroneStore",
    "HEADING_MATCH_MS",
    "STALE_MS",
    "parse_payload",
    "with_drone",
]
