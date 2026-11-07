"""Map annotations: areas (geofences) and point markers the operators draw.

The owner's decisions of 2026-11-06 and 2026-11-07
(docs/superpowers/specs/2026-11-07-map-annotations-design.md): anyone on
the groundstation page or a LAN view tablet adds, changes or removes an area
or a marker with a name, a note, a category and a colour; they are kept on
the console host in one JSON file, so every page sees the same set and it
survives a restart. Standard library only.

``GET ROUTE`` answers ``{ok, rev, items, limits}`` (``?since=<rev>``:
``{ok, rev, unchanged: true}`` while nothing changed). ``POST ROUTE`` takes
``{v: 1, op, id?, rev?, item?}``; ``update`` and ``delete`` carry the rev the
page last saw of that item, and a different one is a conflict, never a
silent overwrite.
"""

from __future__ import annotations

import json
import math
import os
import tempfile
import threading
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Any, Callable, Deque, Dict, List, Mapping, Optional, Tuple

ROUTE = "/api/map/annotations"
FILE_NAME = "map-annotations.json"
SCHEMA_VERSION = 1

MAX_ITEMS = 500
MAX_BODY_BYTES = 16 * 1024
MAX_FILE_BYTES = 2 * 1024 * 1024
NAME_MAX = 64
NOTE_MAX = 500
AREA_MIN_VERTICES = 3
AREA_MAX_VERTICES = 200
WRITES_PER_S = 5
COORDINATE_DECIMALS = 7

KINDS = ("point", "area")
CATEGORIES = ("suspect", "nogo", "safe", "info")
# The palette the pages offer; a category's own colour comes first.
COLORS = ("#f08a24", "#e5484d", "#30a46c", "#3e8ed0", "#a78bfa", "#f5d90a", "#14b8a6", "#ffffff")
CATEGORY_COLORS = {"suspect": "#f08a24", "nogo": "#e5484d", "safe": "#30a46c", "info": "#3e8ed0"}
OPS = ("create", "update", "delete")

ORIGIN_REJECTED = "ORIGIN_REJECTED"
ANNOTATION_INVALID = "ANNOTATION_INVALID"
ANNOTATION_TOO_LARGE = "ANNOTATION_TOO_LARGE"
ANNOTATION_RATE_LIMITED = "ANNOTATION_RATE_LIMITED"
ANNOTATION_NOT_FOUND = "ANNOTATION_NOT_FOUND"
ANNOTATION_CONFLICT = "ANNOTATION_CONFLICT"
ANNOTATION_LIMIT = "ANNOTATION_LIMIT"
ANNOTATION_STORE_FAILED = "ANNOTATION_STORE_FAILED"
LAN_CLOSED = "MIRROR_LAN_CLOSED"

ERROR_CODES_HTTP = {
    ORIGIN_REJECTED: 403,
    ANNOTATION_INVALID: 400,
    ANNOTATION_TOO_LARGE: 413,
    ANNOTATION_RATE_LIMITED: 429,
    ANNOTATION_NOT_FOUND: 404,
    ANNOTATION_CONFLICT: 409,
    ANNOTATION_LIMIT: 409,
    ANNOTATION_STORE_FAILED: 500,
    LAN_CLOSED: 409,
}

ITEM_FIELDS = ("kind", "category", "color", "name", "note", "geometry")
REQUEST_FIELDS = ("v", "op", "id", "rev", "item")


class AnnotationRejected(Exception):
    """A request the store refuses, with its code; ``item`` is the current one for a conflict."""

    def __init__(self, code: str, message: str, item: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.item = item


def limits_view() -> Dict[str, Any]:
    """The numbers the pages repeat (lib/mapAnnotations.ts MAP_ANNOTATION_LIMITS; tools/test_map_annotations.py compares)."""
    return {
        "max_items": MAX_ITEMS,
        "max_body_bytes": MAX_BODY_BYTES,
        "name_max": NAME_MAX,
        "note_max": NOTE_MAX,
        "area_min_vertices": AREA_MIN_VERTICES,
        "area_max_vertices": AREA_MAX_VERTICES,
        "writes_per_s": WRITES_PER_S,
        "categories": list(CATEGORIES),
        "colors": list(COLORS),
    }


def _reject_constant(value: str) -> Any:
    raise ValueError(f"{value} is not a number")


def _no_duplicates(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate key")
    return dict(pairs)


def _text(value: Any, field: str, limit: int) -> str:
    if not isinstance(value, str):
        raise AnnotationRejected(ANNOTATION_INVALID, f"{field} must be text")
    text = value.strip()
    if len(text) > limit:
        raise AnnotationRejected(ANNOTATION_INVALID, f"{field} must be at most {limit} characters")
    if any(ord(char) < 32 and char not in "\n\t" for char in text):
        raise AnnotationRejected(ANNOTATION_INVALID, f"{field} must not hold control characters")
    return text


def _coordinate(value: Any) -> List[float]:
    if not isinstance(value, list) or len(value) != 2:
        raise AnnotationRejected(ANNOTATION_INVALID, "a position is [longitude, latitude]")
    lon, lat = value
    for number in (lon, lat):
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number):
            raise AnnotationRejected(ANNOTATION_INVALID, "a position holds two finite numbers")
    if not -180 <= lon <= 180 or not -90 <= lat <= 90:
        raise AnnotationRejected(ANNOTATION_INVALID, "a position must be within ±180° longitude and ±90° latitude")
    return [round(float(lon), COORDINATE_DECIMALS), round(float(lat), COORDINATE_DECIMALS)]


def validate_item(value: Any) -> Dict[str, Any]:
    """The drawn fields of one annotation, checked and normalised; AnnotationRejected otherwise."""
    if not isinstance(value, dict):
        raise AnnotationRejected(ANNOTATION_INVALID, "item must be a JSON object")
    unknown = sorted(set(value) - set(ITEM_FIELDS))
    if unknown:
        raise AnnotationRejected(ANNOTATION_INVALID, f"unknown item field: {unknown[0][:32]}")
    missing = [field for field in ITEM_FIELDS if field not in value]
    if missing:
        raise AnnotationRejected(ANNOTATION_INVALID, f"item needs {missing[0]}")
    kind = value["kind"]
    if kind not in KINDS:
        raise AnnotationRejected(ANNOTATION_INVALID, "kind must be point or area")
    category = value["category"]
    if category not in CATEGORIES:
        raise AnnotationRejected(ANNOTATION_INVALID, "category must be suspect, nogo, safe or info")
    color = value["color"]
    if color not in COLORS:
        raise AnnotationRejected(ANNOTATION_INVALID, "color must be one of the palette's colours")
    name = _text(value["name"], "name", NAME_MAX)
    if not name:
        raise AnnotationRejected(ANNOTATION_INVALID, "name must not be empty")
    note = _text(value["note"], "note", NOTE_MAX)
    geometry = value["geometry"]
    if kind == "point":
        coordinates: Any = _coordinate(geometry)
    else:
        if not isinstance(geometry, list) or not AREA_MIN_VERTICES <= len(geometry) <= AREA_MAX_VERTICES:
            raise AnnotationRejected(ANNOTATION_INVALID, f"an area has {AREA_MIN_VERTICES} to {AREA_MAX_VERTICES} corners")
        coordinates = [_coordinate(point) for point in geometry]
    return {"kind": kind, "category": category, "color": color, "name": name, "note": note, "geometry": coordinates}


def decode_request(raw: bytes) -> Dict[str, Any]:
    """One POST body: strict JSON (no NaN, no duplicate keys), only the request fields; AnnotationRejected otherwise."""
    try:
        payload = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant, object_pairs_hook=_no_duplicates)
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise AnnotationRejected(ANNOTATION_INVALID, f"the body must be JSON ({type(exc).__name__})") from None
    if not isinstance(payload, dict):
        raise AnnotationRejected(ANNOTATION_INVALID, "the body must be a JSON object")
    unknown = sorted(set(payload) - set(REQUEST_FIELDS))
    if unknown:
        raise AnnotationRejected(ANNOTATION_INVALID, f"unknown field: {unknown[0][:32]}")
    if payload.get("v") != SCHEMA_VERSION or isinstance(payload.get("v"), bool):
        raise AnnotationRejected(ANNOTATION_INVALID, f"v must be {SCHEMA_VERSION}")
    op = payload.get("op")
    if op not in OPS:
        raise AnnotationRejected(ANNOTATION_INVALID, "op must be create, update or delete")
    request: Dict[str, Any] = {"op": op}
    if op == "create":
        if "id" in payload or "rev" in payload:
            raise AnnotationRejected(ANNOTATION_INVALID, "create takes no id or rev")
        request["item"] = validate_item(payload.get("item"))
        return request
    item_id = payload.get("id")
    if not isinstance(item_id, str) or len(item_id) != 32 or any(char not in "0123456789abcdef" for char in item_id):
        raise AnnotationRejected(ANNOTATION_INVALID, "id must be 32 hexadecimal characters")
    rev = payload.get("rev")
    if isinstance(rev, bool) or not isinstance(rev, int) or rev < 1:
        raise AnnotationRejected(ANNOTATION_INVALID, "rev must be the item's revision, a whole number from 1")
    request.update({"id": item_id, "rev": rev})
    if op == "update":
        request["item"] = validate_item(payload.get("item"))
    elif "item" in payload:
        raise AnnotationRejected(ANNOTATION_INVALID, "delete takes no item")
    return request


def _log_warning(message: str) -> None:
    print(f"Warning: map annotations: {message}", flush=True)


class AnnotationStore:
    """Thread-safe, file-backed annotations of one console."""

    def __init__(
        self,
        path: Path,
        *,
        log: Callable[[str], None] = _log_warning,
        clock_ms: Optional[Callable[[], int]] = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.path = Path(path).expanduser()
        self._log = log
        self._clock_ms = clock_ms or (lambda: int(time.time() * 1000))
        self._monotonic = monotonic
        self._lock = threading.Lock()
        self._writes: Dict[str, Deque[float]] = {}
        self._items, self._rev = self._load()

    # -- loading -----------------------------------------------------------

    def _backup(self, raw: bytes) -> None:
        backup = self.path.with_name(self.path.name + ".invalid.bak")
        try:
            fd, temporary = tempfile.mkstemp(prefix=".map-annotations-invalid-", dir=str(self.path.parent))
            with os.fdopen(fd, "wb") as handle:
                handle.write(raw)
            os.chmod(temporary, 0o600)
            os.replace(temporary, backup)
            self._log(f"a copy of the invalid annotations file was kept at {backup}")
        except OSError as exc:
            self._log(f"could not back up the invalid annotations file ({type(exc).__name__})")

    def _load(self) -> Tuple[Dict[str, Dict[str, Any]], int]:
        try:
            raw = self.path.read_bytes()
        except FileNotFoundError:
            return {}, 0
        except OSError as exc:
            self._log(f"cannot read {self.path} ({type(exc).__name__}); starting empty")
            return {}, 0
        try:
            if len(raw) > MAX_FILE_BYTES:
                raise ValueError("the file is too large")
            data = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
            if not isinstance(data, dict) or data.get("version") != SCHEMA_VERSION or not isinstance(data.get("items"), list):
                raise ValueError("not an annotations file")
            rev = data.get("rev")
            if isinstance(rev, bool) or not isinstance(rev, int) or rev < 0:
                raise ValueError("rev")
            items: Dict[str, Dict[str, Any]] = {}
            for entry in data["items"][:MAX_ITEMS]:
                item = self._stored_item(entry)
                items[item["id"]] = item
            return items, rev
        except (UnicodeDecodeError, ValueError, AnnotationRejected, KeyError, TypeError) as exc:
            self._log(f"{self.path} is not a valid annotations file ({type(exc).__name__}); starting empty")
            self._backup(raw)
            return {}, 0

    @staticmethod
    def _stored_item(entry: Any) -> Dict[str, Any]:
        if not isinstance(entry, dict):
            raise ValueError("item")
        drawn = validate_item({field: entry.get(field) for field in ITEM_FIELDS})
        item_id = entry.get("id")
        if not isinstance(item_id, str) or len(item_id) != 32:
            raise ValueError("id")
        meta = {}
        for field in ("rev", "created_ms", "updated_ms"):
            number = entry.get(field)
            if isinstance(number, bool) or not isinstance(number, int) or number < (1 if field == "rev" else 0):
                raise ValueError(field)
            meta[field] = number
        by = entry.get("by")
        return {"id": item_id, **drawn, **meta, "by": by if isinstance(by, str) and len(by) <= 80 else ""}

    # -- saving --------------------------------------------------------------

    def _save_locked(self, items: Dict[str, Dict[str, Any]], rev: int) -> None:
        text = json.dumps({"version": SCHEMA_VERSION, "rev": rev, "items": list(items.values())}, ensure_ascii=False, separators=(",", ":"))
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".map-annotations-", dir=str(parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            try:
                os.chmod(temporary, 0o600)
            except OSError:
                pass
            os.replace(temporary, self.path)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    # -- reading and writing ---------------------------------------------------

    def snapshot(self, since: Optional[int] = None) -> Dict[str, Any]:
        """Every annotation (oldest first) with the collection's rev, or ``unchanged`` when ``since`` is that rev."""
        with self._lock:
            if since is not None and since == self._rev:
                return {"ok": True, "rev": self._rev, "unchanged": True}
            return {"ok": True, "rev": self._rev, "items": [dict(item) for item in self._items.values()], "limits": limits_view()}

    def admit_write(self, client: str) -> bool:
        """At most WRITES_PER_S writes in any second from one client address."""
        now = self._monotonic()
        with self._lock:
            window = self._writes.setdefault(client, deque())
            while window and now - window[0] >= 1.0:
                window.popleft()
            if len(window) >= WRITES_PER_S:
                return False
            window.append(now)
            if len(self._writes) > 256:
                # Forget quiet clients so the table stays small.
                for key in [key for key, times in self._writes.items() if not times or now - times[-1] >= 1.0]:
                    self._writes.pop(key, None)
            return True

    def apply(self, request: Mapping[str, Any], by: str) -> Dict[str, Any]:
        """Run one decoded request; ``{ok, rev, op, item, id}`` on success, AnnotationRejected otherwise.

        The file is written before the change is kept in memory, so a failed
        write leaves both as they were.
        """
        op = request["op"]
        with self._lock:
            items = dict(self._items)
            now = self._clock_ms()
            if op == "create":
                if len(items) >= MAX_ITEMS:
                    raise AnnotationRejected(ANNOTATION_LIMIT, f"at most {MAX_ITEMS} annotations are kept; remove one first")
                item_id = uuid.uuid4().hex
                item = {"id": item_id, **request["item"], "rev": 1, "created_ms": now, "updated_ms": now, "by": by[:80]}
                items[item_id] = item
            else:
                current = items.get(request["id"])
                if current is None:
                    raise AnnotationRejected(ANNOTATION_NOT_FOUND, "no annotation with this id; another page may have removed it")
                if current["rev"] != request["rev"]:
                    raise AnnotationRejected(ANNOTATION_CONFLICT, "the annotation changed on another page; look at it again", dict(current))
                if op == "update":
                    item = {**current, **request["item"], "rev": current["rev"] + 1, "updated_ms": now, "by": by[:80]}
                    items[current["id"]] = item
                else:
                    item = None
                    del items[current["id"]]
            rev = self._rev + 1
            try:
                self._save_locked(items, rev)
            except OSError as exc:
                self._log(f"cannot write {self.path} ({type(exc).__name__})")
                raise AnnotationRejected(ANNOTATION_STORE_FAILED, "the annotation could not be saved on the console host") from None
            self._items, self._rev = items, rev
            return {"ok": True, "rev": rev, "op": op, "id": request.get("id") or (item or {}).get("id"), "item": dict(item) if item else None}


__all__ = [
    "ANNOTATION_CONFLICT",
    "ANNOTATION_INVALID",
    "ANNOTATION_LIMIT",
    "ANNOTATION_NOT_FOUND",
    "ANNOTATION_RATE_LIMITED",
    "ANNOTATION_STORE_FAILED",
    "ANNOTATION_TOO_LARGE",
    "AnnotationRejected",
    "AnnotationStore",
    "CATEGORIES",
    "CATEGORY_COLORS",
    "COLORS",
    "ERROR_CODES_HTTP",
    "FILE_NAME",
    "LAN_CLOSED",
    "MAX_BODY_BYTES",
    "ORIGIN_REJECTED",
    "ROUTE",
    "decode_request",
    "limits_view",
    "validate_item",
]
