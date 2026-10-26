#!/usr/bin/env python3
"""Server-side copy of the console's per-operator browser preferences.

The browser keeps its preferences (theme, language, Overview panels, basemap,
map overlay, polar view, GPS and Compass source, listen mode, follow node, the
spectrum dock's last-known dB scale, and the embedded Receiver's own settings
and bookmarks) in ``localStorage``. This store
keeps the same strings on the console host, so they survive another browser, a
cleared cache or a new container that mounts the same data directory.

Only the allowlisted keys below are stored, each as the exact string the
frontend writes. JSON-valued keys must parse to the JSON type the frontend
stores; the browser still validates every value with its own loader. Live data
never goes through here.

A corrupt or oversized file never stops the console: it is copied to
``<name>.invalid.bak``, the store starts empty and a warning is logged.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

PREFERENCES_VERSION = 1

# Kinds a value may have. "token" is a short plain word ("dark", "id", "nfm",
# "true"); the JSON kinds must parse to that JSON type.
TOKEN = "token"
JSON_OBJECT = "json-object"
JSON_ARRAY = "json-array"

# Exactly the localStorage keys that hold per-operator preferences. The same
# list is PREFERENCE_KEYS in frontend/src/lib/preferenceStore.ts; the
# contract test in test_preferences_store.py keeps them equal. Identifiers the
# Receiver keeps per device (browsdr-device-id, browsdr-share-code) are not
# preferences and stay in the browser.
PREFERENCE_KEYS: Dict[str, str] = {
    # Console shell and language.
    "sdr-console-theme": TOKEN,
    "sdr-console-lang": TOKEN,
    # Overview dashboard.
    "sdr-console-overview-panels-v1": JSON_OBJECT,
    "sdr-console-basemap": TOKEN,
    "sdr-doa-overlay-settings-v4": JSON_OBJECT,
    "sdr-doa-polar-view-v1": JSON_OBJECT,
    "sdr-console-listen-mode": TOKEN,
    "sdr-console-follow-node": TOKEN,
    "sdr-console-spectrum-dock-v1": JSON_OBJECT,
    # GPS and Compass source choice (Configuration page and polar dock).
    "sdr-doa-gps-source-v1": JSON_OBJECT,
    "sdr-doa-compass-source-v1": JSON_OBJECT,
    # Embedded Receiver (same origin, so the same localStorage).
    "SDRSetting": JSON_OBJECT,
    "ReceiverSweepSettings": JSON_OBJECT,
    "sdr-web-bookmarks": JSON_ARRAY,
}

# The keys the LAN view (lan_access) gets from GET /api/preferences: what its
# screens read, that is the shell, the Overview panels and map, the polar view
# and the GPS and Compass source. The groundstation's spectrum dock (listen
# mode, follow node, the dock's mode and scale) and the embedded Receiver's own
# keys (its VFOs, scan settings and named bookmarks) are left out: the LAN view
# shows the Receiver mirror instead and refuses every /api/receiver/* route. A
# key added to PREFERENCE_KEYS stays off the LAN until it is listed here.
LAN_VIEW_PREFERENCE_KEYS = frozenset({
    "sdr-console-theme",
    "sdr-console-lang",
    "sdr-console-overview-panels-v1",
    "sdr-console-basemap",
    "sdr-doa-overlay-settings-v4",
    "sdr-doa-polar-view-v1",
    "sdr-doa-gps-source-v1",
    "sdr-doa-compass-source-v1",
})

# Bounds, in UTF-8 bytes. One value (the Receiver bookmarks are the largest)
# and the whole stored document, so the file and a browser keepalive flush
# stay small.
MAX_PREFERENCE_VALUE_BYTES = 32 * 1024
MAX_PREFERENCES_BYTES = 128 * 1024
# A request carries the values as JSON strings, so escaping can make it larger
# than the stored values.
MAX_PREFERENCES_REQUEST_BYTES = 2 * MAX_PREFERENCES_BYTES
MAX_PREFERENCES_FILE_BYTES = 2 * MAX_PREFERENCES_BYTES

_TOKEN_RE = re.compile(r"[A-Za-z0-9_.-]{1,32}")


class PreferencesRejected(ValueError):
    """A preferences update the store refuses; ``code`` is stable for clients."""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _log_warning(message: str) -> None:
    print("[ground-console] warning: " + message, flush=True)


def _reject_constant(name: str) -> Any:
    # JSON.parse in the browser refuses NaN and Infinity; so does the store.
    raise ValueError(f"{name} is not valid JSON")


def _utf8_size(text: str) -> int:
    return len(text.encode("utf-8", "surrogatepass"))


def validate_preference_value(key: str, value: Any) -> str:
    """Return ``value`` when it is an acceptable string for ``key``."""
    kind = PREFERENCE_KEYS.get(key)
    if kind is None:
        raise PreferencesRejected("PREFERENCE_KEY_UNKNOWN", f"unknown preference key: {key[:64]!r}")
    if not isinstance(value, str):
        raise PreferencesRejected("PREFERENCE_VALUE_INVALID", f"{key} must be a string")
    if _utf8_size(value) > MAX_PREFERENCE_VALUE_BYTES:
        raise PreferencesRejected(
            "PREFERENCE_VALUE_TOO_LARGE",
            f"{key} is larger than {MAX_PREFERENCE_VALUE_BYTES} bytes",
            413,
        )
    if kind == TOKEN:
        if _TOKEN_RE.fullmatch(value) is None:
            raise PreferencesRejected("PREFERENCE_VALUE_INVALID", f"{key} must be a short plain word")
        return value
    try:
        parsed = json.loads(value, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        raise PreferencesRejected("PREFERENCE_VALUE_INVALID", f"{key} is not valid JSON") from None
    expected = dict if kind == JSON_OBJECT else list
    if not isinstance(parsed, expected):
        raise PreferencesRejected(
            "PREFERENCE_VALUE_INVALID",
            f"{key} must be a JSON {'object' if expected is dict else 'array'}",
        )
    return value


def _document_size(values: Dict[str, str]) -> int:
    return sum(_utf8_size(key) + _utf8_size(value) for key, value in values.items())


def parse_preferences_update(payload: Any) -> Dict[str, Optional[str]]:
    """Validate ``{"values": {key: string | null}}``; null removes a key.

    The whole update is refused when any entry is invalid, so a request never
    half-applies.
    """
    if not isinstance(payload, dict) or set(payload) != {"values"}:
        raise PreferencesRejected("INVALID_REQUEST", 'request must be {"values": {...}}')
    values = payload["values"]
    if not isinstance(values, dict):
        raise PreferencesRejected("INVALID_REQUEST", "values must be a JSON object")
    changes: Dict[str, Optional[str]] = {}
    for key, value in values.items():
        if key not in PREFERENCE_KEYS:
            raise PreferencesRejected("PREFERENCE_KEY_UNKNOWN", f"unknown preference key: {str(key)[:64]!r}")
        changes[key] = None if value is None else validate_preference_value(key, value)
    return changes


def _write_atomic(path: Path, text: str, prefix: str) -> None:
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=prefix, dir=str(parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        os.replace(temporary, path)
        try:
            directory_fd = os.open(str(parent), os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


class PreferencesStore:
    """Thread-safe, file-backed preference strings for one console."""

    def __init__(
        self,
        path: Path,
        *,
        log: Callable[[str], None] = _log_warning,
        clock_ms: Optional[Callable[[], int]] = None,
    ) -> None:
        self.path = Path(path).expanduser()
        self._log = log
        self._clock_ms = clock_ms or (lambda: int(time.time() * 1000))
        self._lock = threading.Lock()
        self._values, self._updated_at_ms = self._load()

    # -- loading -----------------------------------------------------------

    def _backup(self, raw: bytes) -> None:
        """Keep the unreadable file before a later save replaces it."""
        backup = self.path.with_name(self.path.name + ".invalid.bak")
        try:
            if backup.is_file() and backup.read_bytes() == raw:
                return
            fd, temporary = tempfile.mkstemp(prefix=".preferences-invalid-", dir=str(self.path.parent))
            try:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(raw)
                os.chmod(temporary, 0o600)
                os.replace(temporary, backup)
            except BaseException:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
                raise
            self._log(f"a copy of the invalid preferences file was kept at {backup}")
        except OSError as exc:
            self._log(f"could not back up the invalid preferences file ({type(exc).__name__})")

    def _load(self) -> Tuple[Dict[str, str], Optional[int]]:
        try:
            if self.path.stat().st_size > MAX_PREFERENCES_FILE_BYTES:
                self._log(f"preferences {self.path} exceed {MAX_PREFERENCES_FILE_BYTES} bytes; starting empty")
                with open(self.path, "rb") as handle:
                    self._backup(handle.read(MAX_PREFERENCES_FILE_BYTES + 1))
                return {}, None
            raw = self.path.read_bytes()
        except FileNotFoundError:
            return {}, None
        except OSError as exc:
            self._log(f"preferences {self.path} are unreadable ({type(exc).__name__}); starting empty")
            return {}, None
        try:
            payload = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
        except (UnicodeDecodeError, ValueError, RecursionError):
            self._log(f"preferences {self.path} are not valid JSON; starting empty")
            self._backup(raw)
            return {}, None
        stored = payload.get("values") if isinstance(payload, dict) else None
        if not isinstance(stored, dict):
            self._log(f"preferences {self.path} have no values object; starting empty")
            self._backup(raw)
            return {}, None
        values: Dict[str, str] = {}
        dropped = []
        for key, value in stored.items():
            try:
                values[key] = validate_preference_value(key, value)
            except PreferencesRejected:
                dropped.append(str(key)[:64])
        if _document_size(values) > MAX_PREFERENCES_BYTES:
            self._log(f"preferences {self.path} exceed {MAX_PREFERENCES_BYTES} bytes; starting empty")
            self._backup(raw)
            return {}, None
        if dropped:
            self._log(f"preferences {self.path}: dropped invalid or unknown key(s) {', '.join(sorted(dropped))}")
            self._backup(raw)
        updated = payload.get("updated_at_ms")
        updated_at_ms = updated if isinstance(updated, int) and not isinstance(updated, bool) and updated >= 0 else None
        if values and updated_at_ms is None:
            updated_at_ms = 0
        return values, updated_at_ms

    # -- API ---------------------------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return self._snapshot_locked()

    def lan_view_snapshot(self) -> Dict[str, Any]:
        """The snapshot with only the LAN view's keys (``LAN_VIEW_PREFERENCE_KEYS``)."""
        with self._lock:
            snapshot = self._snapshot_locked()
        snapshot["values"] = {
            key: value for key, value in snapshot["values"].items() if key in LAN_VIEW_PREFERENCE_KEYS
        }
        return snapshot

    def _snapshot_locked(self) -> Dict[str, Any]:
        return {
            "version": PREFERENCES_VERSION,
            "updated_at_ms": self._updated_at_ms,
            "values": dict(self._values),
        }

    def update(self, payload: Any) -> Dict[str, Any]:
        """Merge a validated update; nothing is written when nothing changes."""
        changes = parse_preferences_update(payload)
        with self._lock:
            merged = dict(self._values)
            for key, value in changes.items():
                if value is None:
                    merged.pop(key, None)
                else:
                    merged[key] = value
            if merged == self._values:
                return self._snapshot_locked()
            if _document_size(merged) > MAX_PREFERENCES_BYTES:
                raise PreferencesRejected(
                    "PREFERENCES_TOO_LARGE",
                    f"stored preferences would exceed {MAX_PREFERENCES_BYTES} bytes",
                    413,
                )
            updated_at_ms = max(self._clock_ms(), (self._updated_at_ms or 0) + 1)
            document = {"version": PREFERENCES_VERSION, "updated_at_ms": updated_at_ms, "values": merged}
            _write_atomic(
                self.path,
                json.dumps(document, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
                ".preferences-",
            )
            self._values = merged
            self._updated_at_ms = updated_at_ms
            return self._snapshot_locked()
