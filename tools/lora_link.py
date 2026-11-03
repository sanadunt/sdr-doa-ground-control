#!/usr/bin/env python3
"""Status of the LoRa serial bridge (RDF Node ``lora-bridge``, protocol RLS1).

The bridge on each end of the LoRa link publishes a retained status to its own
broker every 5 s: ``sdr/v2/<node>/lora/ground`` on the groundstation's broker
(``lora/edge`` stays on the Raspberry's: the bridge's topic table does not carry
it over the radio, so ``edge`` in the view is filled only while the console is
connected straight to the Raspberry's broker, never on a LoRa-only
groundstation). The bridge's ``docs/LORA_SERIAL.md``
("Status jembatan", ``v`` 1) is the shape; the console reads it leniently
(``docs/PRINSIP_DATA.md``): a field of the wrong type reads as null, unknown
fields are ignored, and only a payload that is not a JSON object is refused.

From two successive statuses of one bridge the view adds per-second rates, and
from those the data-in indicator: ``DATA`` while delivered messages arrive,
``LINK_ONLY`` while only heartbeats do, ``NONE`` when nothing arrives. The
status's own ``t`` (the bridge's wall clock, the same host as the console on
the groundstation) dates it, so a retained status of a stopped bridge reads
``STALE`` after a console restart too.
"""

from __future__ import annotations

import json
import math
from typing import Any, Dict, Mapping, Optional

LORA_SUFFIXES = ("lora/ground", "lora/edge")
STATUS_MAX_BYTES = 4096
# Three missed 5 s statuses: the bridge stopped or lost its broker.
STATUS_STALE_MS = 15_000
# A heartbeat comes every 5 s on an UP link, so a longer silence means no RX.
RX_ACTIVE_MS = 6_000
# Above this the console's freshness windows refuse the edge's timestamps
# (SOURCE_TIMESTAMP_NOT_FRESH).
CLOCK_OFFSET_WARN_MS = 1_000
# Successive statuses further apart than this give no rate.
RATE_MAX_GAP_MS = 60_000
# A status whose t is this far from the console clock is dated by its receipt.
CLOCK_PLAUSIBLE_MS = 24 * 3600 * 1000

# peer_restarts (edge 1.10.2): times the other end restarted and its duplicate
# memory was cleared; null from an older bridge.
RX_KEYS = ("frames", "crc_errors", "bad_frames", "lost_frames", "messages", "duplicates", "incomplete", "heartbeats",
           "peer_restarts")
TX_KEYS = ("queued", "superseded", "expired", "sent_messages", "sent_frames", "sent_bytes", "too_large")
PEER_KEYS = ("uptime_s", "rx_frames", "crc_errors", "lost_frames")
RATE_KEYS = ("frames", "messages", "heartbeats", "crc_errors", "lost_frames")


def _count(value: Any) -> Optional[int]:
    return value if type(value) is int and value >= 0 else None


def _integer(value: Any) -> Optional[int]:
    if type(value) is int:
        return value
    if type(value) is float and math.isfinite(value):
        return round(value)
    return None


def _token(value: Any, allowed: tuple) -> Optional[str]:
    return value if isinstance(value, str) and value in allowed else None


def _text(value: Any, limit: int = 200) -> Optional[str]:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:limit] or None


def _counts(value: Any, keys: tuple) -> Dict[str, Optional[int]]:
    source = value if isinstance(value, Mapping) else {}
    return {key: _count(source.get(key)) for key in keys}


def parse_status(payload: bytes) -> Dict[str, Any]:
    """The bridge status as the console keeps it; raises ValueError with a code."""
    if len(payload) > STATUS_MAX_BYTES:
        raise ValueError("PAYLOAD_TOO_LARGE")
    try:
        data = json.loads(payload.decode("utf-8"), parse_constant=lambda _name: None)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise ValueError("MALFORMED_PAYLOAD") from None
    if not isinstance(data, dict):
        raise ValueError("MALFORMED_PAYLOAD")
    notes = []
    version = _count(data.get("v"))
    if version != 1:
        notes.append("UNKNOWN_VERSION")
    peer_source = data.get("peer")
    peer = None
    if isinstance(peer_source, Mapping):
        peer = _counts(peer_source, PEER_KEYS)
        peer["clock_offset_ms"] = _integer(peer_source.get("clock_offset_ms"))
    return {
        "v": version,
        "t": _count(data.get("t")),
        "link": _token(data.get("link"), ("UP", "DOWN")),
        "last_rx_ms": _count(data.get("last_rx_ms")),
        "port": _token(data.get("port"), ("OPEN", "ERROR")),
        "port_error": _text(data.get("port_error")),
        "mqtt": _token(data.get("mqtt"), ("CONNECTED", "DISCONNECTED")),
        "rx": _counts(data.get("rx"), RX_KEYS),
        "tx": _counts(data.get("tx"), TX_KEYS),
        "queue": _count(data.get("queue")),
        "peer": peer,
        "mqtt_dropped": _count(data.get("mqtt_dropped")),
        "link_changes": _count(data.get("link_changes")),
        "notes": notes,
    }


class LoraLinkStore:
    """Latest status of each bridge role and the rates between its last two."""

    def __init__(self) -> None:
        self._latest: Dict[str, Dict[str, Any]] = {}
        self._rates: Dict[str, Optional[Dict[str, float]]] = {}
        self.invalid = 0
        self.last_invalid: Optional[str] = None

    def ingest(self, role: str, payload: bytes, received_at_ms: int) -> bool:
        if role not in ("ground", "edge"):
            return False
        if not payload:
            # A retained clear: the bridge was removed.
            self._latest.pop(role, None)
            self._rates.pop(role, None)
            return True
        try:
            status = parse_status(payload)
        except ValueError as error:
            self.invalid += 1
            self.last_invalid = str(error)
            return False
        status["received_at_ms"] = received_at_ms
        previous = self._latest.get(role)
        self._rates[role] = self._rate(previous, status)
        self._latest[role] = status
        return True

    @staticmethod
    def _stamp(status: Mapping[str, Any]) -> int:
        t = status.get("t")
        return t if t is not None else status["received_at_ms"]

    def _rate(self, previous: Optional[Mapping[str, Any]], status: Mapping[str, Any]) -> Optional[Dict[str, float]]:
        if previous is None:
            return None
        gap = self._stamp(status) - self._stamp(previous)
        if gap <= 0 or gap > RATE_MAX_GAP_MS:
            return None
        rates: Dict[str, float] = {}
        for key in RATE_KEYS:
            now, before = status["rx"].get(key), previous["rx"].get(key)
            if now is None or before is None or now < before:
                # A counter went back: the bridge restarted between the two.
                return None
            rates[key] = round((now - before) * 1000 / gap, 2)
        return rates

    def _role_view(self, role: str, now_ms: int) -> Dict[str, Any]:
        status = self._latest[role]
        t = status.get("t")
        if t is not None and abs(now_ms - t) <= CLOCK_PLAUSIBLE_MS:
            age = max(0, now_ms - t)
        else:
            age = max(0, now_ms - status["received_at_ms"])
        last_rx = status.get("last_rx_ms")
        since_rx = None if last_rx is None else last_rx + age
        rates = self._rates.get(role)
        if age > STATUS_STALE_MS:
            state = "STALE"
        elif status.get("port") == "ERROR":
            state = "PORT_ERROR"
        elif status.get("link") == "UP":
            state = "UP"
        else:
            state = "DOWN"
        if state != "UP" or since_rx is None or since_rx > RX_ACTIVE_MS:
            data = "NONE"
        elif rates is None:
            data = "UNKNOWN"
        elif rates["messages"] > 0:
            data = "DATA"
        else:
            data = "LINK_ONLY"
        peer = status.get("peer")
        offset = peer.get("clock_offset_ms") if peer else None
        view = {key: value for key, value in status.items() if key != "received_at_ms"}
        view.update({
            "role": role,
            "state": state,
            "status_age_ms": age,
            "since_rx_ms": since_rx,
            "rates": rates,
            "data": data,
            "clock_warning": offset is not None and abs(offset) > CLOCK_OFFSET_WARN_MS,
        })
        return view

    def has_role(self, role: str) -> bool:
        """A status of this bridge role is held (retained, so also while its link is down)."""
        return role in self._latest

    def view(self, now_ms: int) -> Dict[str, Any]:
        """The ``lora`` block of ``GET /api/mqtt``: ``present`` once a bridge reported.

        ``edge`` stays null over the radio (see the module docstring); the
        Raspberry's side of the link reaches the groundstation only as the
        heartbeat ``peer`` block of ``ground``.
        """
        return {
            "present": bool(self._latest),
            "ground": self._role_view("ground", now_ms) if "ground" in self._latest else None,
            "edge": self._role_view("edge", now_ms) if "edge" in self._latest else None,
            "invalid": self.invalid,
            "last_invalid": self.last_invalid,
            "stale_after_ms": STATUS_STALE_MS,
            "clock_warn_ms": CLOCK_OFFSET_WARN_MS,
        }
