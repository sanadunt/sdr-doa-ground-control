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

import threading
import time
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

ROUTE = "/api/doa/last-live"

# An answer in one of these states draws no live graph in the page.
_NOT_SHOWN_STATES = frozenset({"UNAVAILABLE", "DEGRADED", "INVALID", "CONFLICT", "STALE"})
_VIEW_BY_SOURCE = {"mqtt": "mqtt", "data_out": "csv"}


def _record(value: Any) -> Optional[Mapping[str, Any]]:
    return value if isinstance(value, Mapping) else None


def answer_identity(answer: Mapping[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    """The node an answer came from: the console's Data Out URL and the MQTT session id."""
    collection = _record(answer.get("collection")) or {}
    base_url = collection.get("console_base_url")
    sid = None
    for block in (_record(answer.get("mqtt")), _record((_record(answer.get("source")) or {}).get("mqtt"))):
        if block is not None and isinstance(block.get("sid"), str) and block["sid"]:
            sid = block["sid"]
            break
    return (base_url if isinstance(base_url, str) and base_url else None, sid)


def same_node(previous: Tuple[Optional[str], Optional[str]], current: Tuple[Optional[str], Optional[str]]) -> bool:
    """A field one of them does not carry decides nothing (the page's sameOverlayNode())."""
    return all(a is None or b is None or a == b for a, b in zip(previous, current))


def shows_live_graph(answer: Mapping[str, Any]) -> bool:
    """Whether the page draws a live graph from this answer: a fresh 360-bin vector in its DoA view."""
    if answer.get("simulation") is True or answer.get("overall_state") in _NOT_SHOWN_STATES:
        return False
    view = _VIEW_BY_SOURCE.get((_record(answer.get("source")) or {}).get("kind"))
    candidates = _record(answer.get("doa_candidates")) or {}
    candidate = _record(candidates.get(view)) if view else None
    if candidate is None:
        return False
    vector = candidate.get("angular_power_db")
    freshness = _record(candidate.get("freshness")) or {}
    consistency = _record(answer.get("native_consistency")) or {}
    return (isinstance(vector, list) and len(vector) == 360 and freshness.get("fresh") is True
            and consistency.get("conflict") is not True)


class LastLiveDoa:
    """Thread-safe holder of the last answer with a live DoA graph."""

    def __init__(self, clock_ms: Callable[[], int] = lambda: int(time.time() * 1000)) -> None:
        self._lock = threading.Lock()
        self._clock_ms = clock_ms
        self._answer: Optional[Mapping[str, Any]] = None
        self._identity: Tuple[Optional[str], Optional[str]] = (None, None)
        self._captured_at_ms: Optional[int] = None

    def observe(self, answer: Mapping[str, Any]) -> None:
        """Look at one composed answer: keep it when it draws a live graph; forget another node's."""
        identity = answer_identity(answer)
        live = shows_live_graph(answer)
        with self._lock:
            if self._answer is not None and not same_node(self._identity, identity):
                self._answer, self._identity, self._captured_at_ms = None, (None, None), None
            if live:
                # Answers are never changed once composed (every answer-time block is added to a copy).
                self._answer, self._identity, self._captured_at_ms = answer, identity, self._clock_ms()

    def view(self) -> Dict[str, Any]:
        with self._lock:
            return {"ok": True, "captured_at_ms": self._captured_at_ms, "snapshot": self._answer}

    def clear(self) -> None:
        with self._lock:
            self._answer, self._identity, self._captured_at_ms = None, (None, None), None


__all__ = ["LastLiveDoa", "ROUTE", "answer_identity", "same_node", "shows_live_graph"]
