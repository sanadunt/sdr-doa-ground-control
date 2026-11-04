"""The last /api/snapshot answer that carried a live DoA graph, for pages that open later.

A page keeps the last live DoA overlay and polar curve in its own memory
(``rememberOverlay()``, ``heldCurve()``) and draws them held, marked STALE with
their time, while the DoA is stale. That memory starts empty with every page
load, and over Telemetry LoRa an Angular frame comes rarely, so a tablet that
opens (or the kiosk after a reload) showed no graph at all until the next
frame. The console keeps the last answer whose DoA view had a fresh 360-bin
vector, and serves it through ``GET /api/doa/last-live``; the page derives the
held overlay from it exactly as it derives a live one.

It lives in memory only. Another Data Out URL or another RDF Node MQTT session
(``sid``) forgets it, as the page's own memory does.
"""
from __future__ import annotations

import math
import threading
import time
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

ROUTE = "/api/doa/last-live"

# An answer in one of these states draws no live graph in the page.
_NOT_SHOWN_STATES = frozenset({"UNAVAILABLE", "DEGRADED", "INVALID", "CONFLICT", "STALE"})
_VIEW_BY_SOURCE = {"mqtt": "mqtt", "data_out": "csv"}


def _record(value: Any) -> Optional[Mapping[str, Any]]:
    return value if isinstance(value, Mapping) else None


Identity = Tuple[Optional[str], Optional[str], Optional[float]]


def answer_identity(answer: Mapping[str, Any]) -> Identity:
    """The node an answer came from: the console's Data Out URL, the MQTT session id and the Data Out uptime."""
    collection = _record(answer.get("collection")) or {}
    base_url = collection.get("console_base_url")
    sid = None
    for block in (_record(answer.get("mqtt")), _record((_record(answer.get("source")) or {}).get("mqtt"))):
        if block is not None and isinstance(block.get("sid"), str) and block["sid"]:
            sid = block["sid"]
            break
    safe = _record((_record(answer.get("status")) or {}).get("safe")) or {}
    uptime = safe.get("uptime_ms")
    uptime_ms = float(uptime) if _finite(uptime) and uptime >= 0 else None
    return (base_url if isinstance(base_url, str) and base_url else None, sid, uptime_ms)


def same_node(previous: Identity, current: Identity) -> bool:
    """The page's sameOverlayNode(): another URL or session, or an uptime that went back, is another node.

    A field one of them does not carry decides nothing.
    """
    (url_a, sid_a, up_a), (url_b, sid_b, up_b) = previous, current
    if url_a is not None and url_b is not None and url_a != url_b:
        return False
    if sid_a is not None and sid_b is not None and sid_a != sid_b:
        return False
    return up_a is None or up_b is None or up_b >= up_a


def merged_identity(previous: Identity, current: Identity) -> Identity:
    """The page's mergeIdentity(): what the newer answer names, else what was known, so a later change is seen."""
    return tuple(b if b is not None else a for a, b in zip(previous, current))  # type: ignore[return-value]


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _fresh_parsed(candidate: Optional[Mapping[str, Any]]) -> bool:
    """The page's freshCandidate(): parsed (no normalization_error, a finite theta_0) and fresh."""
    if candidate is None or candidate.get("available") is not True or "normalization_error" in candidate:
        return False
    freshness = _record(candidate.get("freshness")) or {}
    age = freshness.get("age_ms")
    return _finite(candidate.get("canonical_angle_deg")) and freshness.get("fresh") is True and _finite(age) and age >= 0


def shows_live_graph(answer: Mapping[str, Any]) -> bool:
    """Whether the page draws a live graph from this answer (its overviewDoaStatus().shown with a vector).

    A healthy DAQ (daq_health PASS, which an MQTT answer has with daq=1), no
    ADC overdrive, a parsed and fresh DoA view with a 360-bin vector, no
    conflict; a Data Out answer also needs its XML view comparable, or no XML
    view at all (the page's partialCsvReady()). Anything else the page shows
    held, dimmed or not at all, so it is never kept as the last live graph.
    """
    if answer.get("simulation") is True or answer.get("overall_state") in _NOT_SHOWN_STATES:
        return False
    status = _record(answer.get("status")) or {}
    if status.get("available") is not True or status.get("daq_health") != "PASS":
        return False
    checks = _record((_record(answer.get("publication_gate")) or {}).get("checks")) or {}
    if checks.get("adc_not_overdriven") is False:
        return False
    kind = (_record(answer.get("source")) or {}).get("kind")
    view = _VIEW_BY_SOURCE.get(kind)
    candidates = _record(answer.get("doa_candidates")) or {}
    candidate = _record(candidates.get(view)) if view else None
    if not _fresh_parsed(candidate):
        return False
    vector = candidate.get("angular_power_db")  # type: ignore[union-attr]
    if not (isinstance(vector, list) and len(vector) == 360 and all(_finite(value) for value in vector)):
        return False
    consistency = _record(answer.get("native_consistency")) or {}
    if consistency.get("conflict") is True:
        return False
    if kind == "data_out":
        xml = _record(candidates.get("xml"))
        if xml is not None and xml.get("available") is True:
            return _fresh_parsed(xml) and consistency.get("comparable") is True
    return True


class LastLiveDoa:
    """Thread-safe holder of the last answer with a live DoA graph."""

    def __init__(self, clock_ms: Callable[[], int] = lambda: int(time.time() * 1000)) -> None:
        self._lock = threading.Lock()
        self._clock_ms = clock_ms
        self._answer: Optional[Mapping[str, Any]] = None
        self._identity: Identity = (None, None, None)
        self._captured_at_ms: Optional[int] = None

    def observe(self, answer: Mapping[str, Any]) -> None:
        """Look at one composed answer: keep it when it draws a live graph; forget another node's."""
        identity = answer_identity(answer)
        live = shows_live_graph(answer)
        with self._lock:
            if self._answer is not None and not same_node(self._identity, identity):
                self._answer, self._identity, self._captured_at_ms = None, (None, None, None), None
            if live:
                # Answers are never changed once composed (every answer-time block is added to a copy).
                self._answer, self._identity, self._captured_at_ms = answer, identity, self._clock_ms()
            elif self._answer is not None:
                # As the page merges: a session or uptime named later still forgets it when it changes.
                self._identity = merged_identity(self._identity, identity)

    def view(self) -> Dict[str, Any]:
        with self._lock:
            return {"ok": True, "captured_at_ms": self._captured_at_ms, "snapshot": self._answer}

    def clear(self) -> None:
        with self._lock:
            self._answer, self._identity, self._captured_at_ms = None, (None, None, None), None


__all__ = ["LastLiveDoa", "ROUTE", "answer_identity", "merged_identity", "same_node", "shows_live_graph"]
