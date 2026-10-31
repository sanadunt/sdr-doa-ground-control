#!/usr/bin/env python3
"""Local Ground Console for staged SDR-DoA inspection.

The console keeps a narrow boundary:

* ``/api/snapshot`` answers from MQTT while the RDF Node's health is fresh
  (``telemetry_source``), with a light Data Out read for what MQTT never
  carries, and otherwise from Data Out (the fallback): bounded read-only GETs
  through ``sdr_doa_collector``, one collection per refresh interval for
  every viewer together (``data_out_reader``);
* an optional MQTT monitor subscribes to its configured broker;
* its one remote write is Kontrol's: ``POST /api/mqtt/config-patch``, an
  admin-gated, explicitly confirmed ``config.patch`` in the RDF Node edge's
  envelope (``rdf_node_commands``), published once at QoS 1 (never retained,
  15 s lifetime) to ``sdr/v2/<node>/cmd/config/patch``. It needs a
  same-origin loopback request, the admin cookie, ``confirm: true``, the
  edge's safe fields within its rules, a node session (``state``), fresh
  ``telemetry/health`` and the base revision (``state.cfg``) the operator
  reviewed. ``POST /api/mqtt/config-get`` sends the read-only ``config.get``
  with the same Origin and admin gates, so the edge answers with
  ``settings/reported``. The edge decides whether to apply a patch and
  answers on ``ack/config``;
* the settings form's ``/api/dry-run/config-patch`` only validates a preview;
* local admin settings also change this console's branding;
* ``/api/preferences`` keeps the operator's browser preferences (theme,
  language, Overview panels, basemap, overlay, polar view, GPS/Compass source,
  listen mode, follow node, the Receiver's settings) on this host, so another
  browser or a cleared cache gets them back;
* ``/api/tiles/<source>/<z>/<x>/<y>`` serves the Dashboard basemap from a
  disk cache (``--tile-cache-dir``) and fetches a missing or stale tile from
  the fixed upstreams in ``tile_cache.py``, so the browser never contacts a
  tile provider and the map keeps every area it has shown while offline;
* ``/api/receiver/*`` keeps the Receiver's records under ``--data-dir``
  (``receiver_record_store.py``), with the Records archive routes under
  ``/api/receiver/archive/`` (``receiver_archive.py``: calendar, time line,
  table, previews, downloads, ZIP exports, delete) and a retention pass that
  runs in its own thread. Every Receiver GET must come from this console's
  own pages (Sec-Fetch-Site and a loopback Host on this port); every POST
  and DELETE needs the same-origin loopback Origin;
* ``POST /api/host/power`` (the top bar's Restart and Shutdown, confirmed in
  the page) writes a request file holding ``reboot`` or ``poweroff`` into
  ``--host-power-dir`` (``host_power.py``) for a host helper
  (``packaging/host-power``) to act on. It needs the same-origin loopback
  Origin; the console itself runs nothing on the host.

The console listens on loopback only. The one exception is the opt-in LAN
view (``lan_access`` in ``--config-path``, changed by an admin through
``POST /api/lan-access``): a second listener in this process that serves the
built UI and a read-only list of API routes to the client addresses the
operator allowed. It stays closed while the default admin password is in use
or admin login is disabled; ``lan_access.py`` holds its rules. While it is
open, the groundstation page that runs the Receiver publishes its state and
spectrum to ``POST /api/mirror/receiver`` and the LAN view reads them back
from ``GET /api/mirror/receiver`` (``receiver_mirror.py``, memory only). The
LAN view also reads the Receiver's Records: the archive list routes, a scan
preview, one record's download and the audio playback, under its own read
rule and limits (``LanConsoleHandler._lan_records_get``). Its one write is
a marker command for the groundstation Receiver (``POST
/api/mirror/receiver/markers``, ``lan.write_allowed``); every other Receiver
route and every other write, ``POST /api/host/power`` included, stays
refused there.

Admin login uses ``SDR_DOA_ADMIN_PASSWORD`` from the environment or the
``--env-file`` (default: the repository ``.env``). When the variable is absent
from both, the default password ``123456`` applies and the UI warns about it;
an explicitly empty value disables admin login.

Everything the operator saves lives in local files: ``--config-path``
(connection, MQTT, refresh interval), ``--branding-path``,
``--preferences-path`` and ``--data-dir`` (Receiver records). On the first
start, when ``--config-path`` does not exist yet, the console builds it from
``SDR_DOA_SEED_*`` variables (environment or env file) and saves it; later
starts read the file and ignore the seed. ``--base-url`` and ``--mqtt-*``
override the saved file for one run only, so a service should not pass them.

Run from the repository root, for example:

    python3 tools/ground_console.py \\
        --base-url http://192.168.100.100:8081 \\
        --bind 127.0.0.1 --port 8787 \\
        --mqtt-host 127.0.0.1 --mqtt-port 1883
"""

from __future__ import annotations

import argparse
import base64
import errno
import hmac
import http.client
import ipaddress
import json
import math
import os
import re
import secrets
import signal
import socket
import socketserver
import sqlite3
import tempfile
import threading
import time
import uuid
import zlib
from datetime import timedelta, timezone
from html import escape
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple
from urllib.parse import parse_qs, urlsplit

import lan_access as lan
import rdf_node_commands as cmds
from config_command_tracker import ConfigCommandTracker, MonitorPublishError
from data_out_reader import DataOutReader, SnapshotRequest, valid_collection_id
from mdns_resolver import MdnsResolver
from sdr_doa_collector import (
    DATA_OUT_HOST_IN_USE,
    DATA_OUT_PORT,
    DEFAULT_DATA_OUT_HOSTS,
    CollectorError,
    DataOutHostError,
    NodeProgressTracker,
    SettingsCache,
    check_data_out_url,
    collect,
    collect_light,
    data_out_url_host,
    normalize_data_out_hosts,
)
import host_power as hp
import receiver_archive as ra
import receiver_mirror as rm
from receiver_archive import ArchiveError
from receiver_record_store import (
    DEFAULT_DATA_DIR,
    STALE_RECORDING_SECONDS,
    ReceiverConflictError,
    ReceiverRecordStore,
    _utc_offset_minutes,
    resolve_time_zone,
)
from preferences_store import MAX_PREFERENCES_REQUEST_BYTES, PreferencesRejected, PreferencesStore
from tile_cache import (
    BROWSER_MAX_AGE_S,
    BROWSER_STALE_MAX_AGE_S,
    DEFAULT_TILE_CACHE_DIR,
    DEFAULT_TILE_CACHE_MAX_MB,
    MAX_TILE_CACHE_MB,
    TILE_ROUTE_PREFIX,
    TileCache,
    TileSource,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BROWSDR_SOURCE_ARCHIVE = "freq-spectrum-source.tar.gz"
# Files the built console serves from the root of frontend/dist besides
# assets/: the page and its icons (copied there from frontend/public).
FRONTEND_ROOT_FILES = frozenset({"index.html", "favicon.ico", "favicon.svg"})
DEFAULT_ENV_PATH = PROJECT_ROOT / ".env"
_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
VERSION_PATH = PROJECT_ROOT / "VERSION"
_VERSION_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}")


def _read_version(path: Path = VERSION_PATH) -> str:
    """Return the first line of the VERSION file, or "dev" without a usable one."""
    try:
        with open(path, "rb") as handle:
            text = handle.read(256).decode("utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return "dev"
    lines = text.strip().splitlines()
    first = lines[0].strip() if lines else ""
    return first if _VERSION_RE.fullmatch(first) else "dev"


CONSOLE_VERSION = _read_version()


def _query_int(query: Dict[str, list], key: str, default: Optional[int]) -> Optional[int]:
    if key not in query:
        return default
    try:
        parsed = int(query[key][0])
    except (ValueError, TypeError) as exc:
        raise ValueError(f"{key} must be an integer") from exc
    if parsed < 0:
        raise ValueError(f"{key} must be nonnegative")
    return parsed


def _query_float(query: Dict[str, list], key: str) -> Optional[float]:
    if key not in query:
        return None
    try:
        value = float(query[key][0])
    except (ValueError, TypeError) as exc:
        raise ValueError(f"{key} must be numeric") from exc
    if not (-float("inf") < value < float("inf")):
        raise ValueError(f"{key} must be finite")
    return value


def _query_bool(query: Dict[str, list], key: str, default: bool) -> bool:
    if key not in query:
        return default
    value = query[key][0].lower()
    if value not in {"true", "false"}:
        raise ValueError(f"{key} must be true or false")
    return value == "true"


def _parse_audio_byte_range(header: str, size: int) -> Optional[Tuple[int, int]]:
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip(), re.IGNORECASE)
    if match is None or size <= 0:
        return None
    start_text, end_text = match.groups()
    try:
        if not start_text:
            suffix_length = int(end_text)
            if suffix_length <= 0:
                return None
            return max(0, size - suffix_length), size - 1
        start = int(start_text)
        end = int(end_text) if end_text else size - 1
    except (ValueError, OverflowError):
        return None
    if start >= size or end < start:
        return None
    return start, min(end, size - 1)

class _DotenvUnreadable(Exception):
    """A .env file exists but cannot be read or decoded."""


def _read_dotenv(path: Path = DEFAULT_ENV_PATH, *, strict: bool = False) -> Dict[str, str]:
    """Read a small, dependency-free dotenv subset without logging values.

    Existing process environment variables always remain authoritative; this
    helper only supplies local fallback values for variables that are absent.
    With ``strict``, a file that exists but cannot be read or decoded raises
    ``_DotenvUnreadable`` instead of looking empty. A leading UTF-8 BOM, as
    some Windows editors and PowerShell write, is not part of the first key.
    """
    try:
        text = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return {}
    except OSError:
        if strict:
            raise _DotenvUnreadable(str(path)) from None
        return {}
    except UnicodeDecodeError:
        if strict:
            raise _DotenvUnreadable(str(path)) from None
        raise

    values: Dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, raw_value = line.partition("=")
        key = key.strip()
        if not separator or not _ENV_KEY_RE.fullmatch(key):
            continue
        value = raw_value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value
    return values


# Used only when SDR_DOA_ADMIN_PASSWORD is absent from both the environment
# and .env. Capabilities report that it is in use so the UI can warn; the
# console binds to loopback only and throttles failed logins.
DEFAULT_ADMIN_PASSWORD = "123456"


def _admin_password_from_sources(
    environ: Optional[Dict[str, str]] = None,
    dotenv_values: Optional[Dict[str, str]] = None,
    *,
    dotenv_path: Path = DEFAULT_ENV_PATH,
) -> Optional[str]:
    """Resolve admin password with process environment precedence.

    An explicitly empty value disables admin login (None). A variable absent
    from both sources falls back to ``DEFAULT_ADMIN_PASSWORD``. A .env that
    exists but cannot be read also disables login: it may hold the operator's
    real password, so it must never turn into the public default.
    """
    source = os.environ if environ is None else environ
    if "SDR_DOA_ADMIN_PASSWORD" in source:
        return source["SDR_DOA_ADMIN_PASSWORD"] or None
    if dotenv_values is not None:
        fallback = dotenv_values
    else:
        try:
            fallback = _read_dotenv(dotenv_path, strict=True)
        except _DotenvUnreadable:
            print(
                f"[ground-console] warning: {dotenv_path} cannot be read; admin login is disabled",
                flush=True,
            )
            return None
    if "SDR_DOA_ADMIN_PASSWORD" in fallback:
        return fallback["SDR_DOA_ADMIN_PASSWORD"] or None
    return DEFAULT_ADMIN_PASSWORD


# HTTP Data Out (the fallback) is read from a host in the saved host list,
# console.json data_out_hosts (default DEFAULT_DATA_OUT_HOSTS), on port 8081
# only. Every check here and the collector itself get that same list, so the
# console never accepts a URL the collector would refuse to read.
DEFAULT_BIND = "127.0.0.1"
DEFAULT_PORT = 8787
# Kontrol's RDF Node commands live 15 s (rdf_node_commands.COMMAND_TTL_MS, the
# edge's Ground default; the edge accepts at most 30 s).
MAX_CONFIG_PATCH_REQUEST_BYTES = 4096
CONFIG_PATCH_REQUEST_KEYS = frozenset({"changes", "base_rev", "confirm"})
# The edge refuses a second config.get from the same link within 1 s.
CONFIG_GET_MIN_INTERVAL_MS = 1_000
# Status lookups take any id the edge accepts; the console's own are gc-<hex>.
_COMMAND_ID_RE = cmds.COMMAND_ID_RE
# The node Kontrol commands when no MQTT monitor exists yet.
DEFAULT_RDF_NODE_ID = "uav-01"
DEFAULT_APP_NAME = "SDR-DoA Ground Console"
DEFAULT_BRANDING_PATH = Path.home() / ".config" / "sdr-doa-ground-console" / "branding.json"
DEFAULT_CONFIG_PATH = Path.home() / ".config" / "sdr-doa-ground-console" / "console.json"
DEFAULT_PREFERENCES_PATH = Path.home() / ".config" / "sdr-doa-ground-console" / "preferences.json"
# Process environment wins; a repository-root .env is only a local fallback.
# With neither, DEFAULT_ADMIN_PASSWORD applies and capabilities flag it.
ADMIN_PASSWORD = _admin_password_from_sources()
if not ADMIN_PASSWORD:
    # An explicitly empty SDR_DOA_ADMIN_PASSWORD disables admin login;
    # branding stays readable.
    ADMIN_PASSWORD = None
ADMIN_SESSION_COOKIE = "sdr_doa_admin"
ADMIN_SESSION_TTL_SECONDS = 30 * 60
# State-changing POSTs that need a same-origin loopback Origin before their
# body is read. Login and logout are here so a cross-site page cannot feed the
# failed-login throttle; console-config and mqtt/connect replace the MQTT
# monitor, which is also the config-patch publish channel; lan-access opens a
# listener on the LAN; preferences would otherwise let any page rewrite the
# operator's saved view.
SAME_ORIGIN_POST_PATHS = frozenset({
    "/api/admin/login",
    "/api/admin/logout",
    "/api/console-config",
    "/api/lan-access",
    "/api/mqtt/connect",
    "/api/preferences",
})
# Failed logins are counted for the whole server: after this many inside the
# window, every login is refused for the lockout period. Only same-origin
# requests reach the counter.
ADMIN_LOGIN_MAX_FAILURES = 5
ADMIN_LOGIN_FAILURE_WINDOW_S = 60.0
ADMIN_LOGIN_LOCKOUT_S = 30.0
MAX_BRANDING_NAME_LENGTH = 60
MAX_LOGO_BYTES = 256 * 1024
MAX_LOGO_DIMENSION = 4096
MAX_LOGO_PIXELS = 4_194_304
MAX_DECODED_LOGO_BYTES = 32 * 1024 * 1024
# PNG is the only logo format validated fully by the stdlib parser below.
# Keeping the contract narrow is safer than accepting formats we cannot decode.
ALLOWED_LOGO_MIME = {"image/png"}
# Intervals shorter than the 5 s DoA freshness window keep a live bearing on
# screen between reads; 0 means manual refresh.
ALLOWED_REFRESH_INTERVALS = {0, 1, 2, 5, 10, 30}
DEFAULT_REFRESH_SECONDS = 2
# One /api/snapshot collection may not take longer than this, so a slow or
# unreachable Data Out returns an explicit UNAVAILABLE well inside the
# browser's request timeout.
SNAPSHOT_TOTAL_BUDGET_S = 4.0
SNAPSHOT_WAIT_GRACE_S = 2.0
MAX_CONSOLE_CONFIG_BYTES = 64 * 1024
CONSOLE_CONFIG_VERSION = 1
ALLOWED_MQTT_TRANSPORTS = ("tcp", "websockets")
DEFAULT_MQTT_WS_PATH = "/mqtt"
# The path is written into the WebSocket request line, so keep it to plain
# unreserved path characters.
_MQTT_WS_PATH_RE = re.compile(r"/[A-Za-z0-9._~/-]{0,127}")
_MQTT_PORT_QUERY_RE = re.compile(r"[0-9]{1,5}")
MQTT_DEPENDENCY_ERROR = "MQTT monitor dependency paho-mqtt is not installed"


def _is_allowed_mqtt_host(value: str) -> bool:
    if not isinstance(value, str):
        return False
    host = value.strip()
    if host.lower().rstrip(".") == "localhost":
        return True
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def _load_rdf_node_v2_telemetry_class() -> Any:
    if __package__:
        from .rdf_node_mqtt_v2 import RdfNodeV2Telemetry
    else:
        from rdf_node_mqtt_v2 import RdfNodeV2Telemetry
    return RdfNodeV2Telemetry


def _empty_rdf_node_mqtt_snapshot() -> Dict[str, Any]:
    snapshot = _load_rdf_node_v2_telemetry_class()("uav-01").snapshot(int(time.time() * 1000))
    snapshot.update({"enabled": False, "connection": "disabled", "last_error": None})
    return snapshot


def _load_mqtt_monitor_class() -> Any:
    """Load paho only when MQTT monitoring is actually requested."""
    try:
        from sdr_doa_mqtt_monitor import MqttMonitor as monitor_class
    except ModuleNotFoundError as exc:
        if exc.name == "paho":
            raise RuntimeError(MQTT_DEPENDENCY_ERROR) from exc
        raise
    return monitor_class


class _UnavailableMqttMonitor:
    """Monitor slot that reports why no MQTT client could be created."""

    def __init__(self, host: str, port: int, transport: str, ws_path: str, error: str) -> None:
        self.host = host
        self.port = int(port)
        self.transport = transport
        self.ws_path = ws_path
        self.error = error

    def start(self) -> None:
        return None

    def stop(self) -> None:
        return None

    def snapshot(self) -> Dict[str, Any]:
        return {
            "enabled": True,
            "read_only": True,
            "publish_enabled": False,
            "host": self.host,
            "port": self.port,
            "transport": self.transport,
            "ws_path": self.ws_path,
            "now_ms": int(time.time() * 1000),
            "connection": "error",
            "last_error": self.error,
            "received": 0,
            "valid": 0,
            "invalid": 0,
            "cleared": 0,
            "last_received_at_ms": None,
            "last_age_ms": None,
        }

    def rdf_node_snapshot(self) -> Dict[str, Any]:
        snapshot = _empty_rdf_node_mqtt_snapshot()
        snapshot.update({"enabled": True, "connection": "error", "last_error": "DEPENDENCY_MISSING"})
        return snapshot

    def publish_rdf_node_command(self, _command: Any) -> Dict[str, Any]:
        raise MonitorPublishError("MQTT_DEPENDENCY_MISSING", self.error)

    def rdf_node_control_view(self) -> Dict[str, Any]:
        return {"available": False}

    def rdf_node_command_observation(self, _command_id: str) -> Dict[str, Any]:
        return {"published": False, "puback": None, "progress": None, "final": None, "reported_at_ms": None}


def _monitor_can_publish(monitor: Any) -> bool:
    """True for a real monitor that offers the Kontrol command publish path."""
    return (
        monitor is not None
        and not isinstance(monitor, _UnavailableMqttMonitor)
        and callable(getattr(monitor, "publish_rdf_node_command", None))
    )


def _monitor_node_id(monitor: Any) -> str:
    node_id = getattr(monitor, "node_id", None) if monitor is not None else None
    return node_id if isinstance(node_id, str) and node_id else DEFAULT_RDF_NODE_ID


def _config_patch_ranges() -> Dict[str, List[Any]]:
    return cmds.ranges_view()


class ConfigPatchRejected(Exception):
    """A config-patch request refused with an HTTP status and a stable code."""

    def __init__(self, status: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status = int(status)
        self.code = code
        self.message = message
        self.extra = extra

    def body(self) -> Dict[str, Any]:
        return {**self.extra, "ok": False, "code": self.code, "error": self.message}


def _parse_config_patch_request(payload: Any) -> Tuple[Dict[str, Any], Optional[int]]:
    """Request shape, confirm and the edge's field rules; the first failure wins."""
    if (
        not isinstance(payload, dict)
        or "changes" not in payload
        or "base_rev" not in payload
        or set(payload) - CONFIG_PATCH_REQUEST_KEYS
    ):
        raise ConfigPatchRejected(
            HTTPStatus.BAD_REQUEST,
            "INVALID_REQUEST",
            "request must be a JSON object with changes, base_rev and confirm only",
        )
    changes = payload["changes"]
    base_rev = payload["base_rev"]
    if not isinstance(changes, dict):
        raise ConfigPatchRejected(HTTPStatus.BAD_REQUEST, "INVALID_REQUEST", "changes must be a JSON object")
    if base_rev is not None and (isinstance(base_rev, bool) or not isinstance(base_rev, int) or base_rev < 0):
        raise ConfigPatchRejected(
            HTTPStatus.BAD_REQUEST, "INVALID_REQUEST", "base_rev must be a non-negative integer or null",
        )
    if payload.get("confirm") is not True:
        raise ConfigPatchRejected(
            HTTPStatus.BAD_REQUEST, "CONFIRM_REQUIRED", "confirm must be true after the change has been reviewed",
        )
    try:
        normalized = cmds.validate_patch_changes(changes)
    except cmds.CommandRefused as refused:
        raise ConfigPatchRejected(HTTPStatus.BAD_REQUEST, refused.code, refused.message, **refused.extra) from refused
    return normalized, base_rev


def _monitor_control_view(monitor: Any) -> Optional[Dict[str, Any]]:
    """The monitor's rdf_node_control_view(), or None when it has none or fails."""
    reader = getattr(monitor, "rdf_node_control_view", None)
    if monitor is None or not callable(reader):
        return None
    try:
        data = reader()
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _finite_or_none(value: Any) -> Any:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _int_or_none(value: Any, minimum: int = 0) -> Optional[int]:
    return value if type(value) is int and value >= minimum else None


def _session_or_none(view: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The node session a command can name: known, with a sid and a boot."""
    session = view.get("session")
    if not isinstance(session, dict) or session.get("known") is not True:
        return None
    if not isinstance(session.get("sid"), str) or not isinstance(session.get("boot"), str):
        return None
    return session


def _node_view(session: Optional[Dict[str, Any]], now_ms: int) -> Optional[Dict[str, Any]]:
    """What Kontrol shows of the node session; never the boot or instance ids."""
    if session is None:
        return None
    received = _int_or_none(session.get("health_received_at_ms"))
    capabilities = session.get("capabilities") if isinstance(session.get("capabilities"), dict) else {}

    def flag(name: str) -> Optional[bool]:
        value = capabilities.get(name)
        return value if isinstance(value, bool) else None

    return {
        "sid": session["sid"],
        "cfg": _int_or_none(session.get("cfg")),
        "health_fresh": session.get("health_fresh") is True,
        "health_age_ms": None if received is None else max(0, now_ms - received),
        "remote_commands": flag("remote_commands"),
        "remote_config_patch": flag("remote_config_patch"),
    }


def _settings_view(report: Any, now_ms: int) -> Optional[Dict[str, Any]]:
    """The latest settings/reported without its native text; safe values only while current."""
    if not isinstance(report, dict) or not isinstance(report.get("id"), str):
        return None
    received = _int_or_none(report.get("received_at_ms"))
    current = report.get("matches_state_cfg") is True
    safe = report.get("safe_settings") if current and isinstance(report.get("safe_settings"), dict) else {}
    return {
        "id": report["id"],
        "rev": _int_or_none(report.get("rev")),
        "received_at_ms": received,
        "age_ms": None if received is None else max(0, now_ms - received),
        "matches_state_cfg": current,
        "values": {field: _finite_or_none(safe.get(field)) for field in cmds.PATCH_FIELDS},
    }


def _is_allowed_mqtt_ws_path(value: Any) -> bool:
    return isinstance(value, str) and _MQTT_WS_PATH_RE.fullmatch(value) is not None


def _new_mqtt_monitor(
    host: str,
    port: int,
    transport: str = "tcp",
    ws_path: str = DEFAULT_MQTT_WS_PATH,
) -> Any:
    try:
        monitor_class = _load_mqtt_monitor_class()
    except RuntimeError as exc:
        return _UnavailableMqttMonitor(host, port, transport, ws_path, str(exc))
    options: Dict[str, Any] = {"transport": transport}
    if ws_path != DEFAULT_MQTT_WS_PATH:
        options["ws_path"] = ws_path
    return monitor_class(host, port, **options)


def _safe_config_json(config: Dict[str, Any]) -> str:
    """Embed trusted, server-validated config safely in the page script."""
    return (
        json.dumps(config, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace("\\u2028", "\\u2028")
        .replace("\\u2029", "\\u2029")
    )


def _default_console_config(
    base_url: str = "http://doasdr.local:8081",
    mqtt_host: str = "10.90.0.1",
    mqtt_port: int = 9001,
    refresh_seconds: int = DEFAULT_REFRESH_SECONDS,
    *,
    mqtt_transport: str = "websockets",
    mqtt_ws_path: str = DEFAULT_MQTT_WS_PATH,
    data_out_hosts: Optional[Sequence[str]] = None,
    lan_access: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return {
        "version": CONSOLE_CONFIG_VERSION,
        "base_url": base_url,
        # Hosts Data Out may be read from (port 8081); base_url's host is one of them.
        "data_out_hosts": list(DEFAULT_DATA_OUT_HOSTS if data_out_hosts is None else data_out_hosts),
        "mqtt_host": mqtt_host,
        "mqtt_port": int(mqtt_port),
        "mqtt_transport": mqtt_transport,
        "mqtt_ws_path": mqtt_ws_path,
        "refresh_seconds": int(refresh_seconds),
        # The opt-in LAN view (lan_access.py). It is saved here with the
        # rest, but only POST /api/lan-access (admin) changes it, and the
        # console-config routes never show it.
        "lan_access": dict(lan_access) if lan_access is not None else lan.default_settings(),
    }


def _public_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """The console config as /api/console-config shows it: without lan_access."""
    return {key: value for key, value in config.items() if key != "lan_access"}


def _snapshot_request(
    query: Dict[str, List[str]], *, fresh_settings: bool = True, refresh: bool = True, data_out_only: bool = True
) -> SnapshotRequest:
    """The read flags of one /api/snapshot query (data_out_reader.py).

    refresh=1 is the operator's Refresh and fresh_settings=1 Kontrol's "Cek
    ulang" (both read again only when the last read is 1 s old); seen is the
    collection id the viewer already shows; source=data_out (the legacy UI)
    reads Data Out even while MQTT is fresh. ``fresh_settings=False``,
    ``refresh=False`` and ``data_out_only=False`` ignore those flags.
    """
    return SnapshotRequest(
        refresh=refresh and query.get("refresh", [""])[0] == "1",
        fresh_settings=fresh_settings and query.get("fresh_settings", [""])[0] == "1",
        seen=valid_collection_id(query.get("seen", [""])[0]),
        data_out_only=data_out_only and query.get("source", [""])[0] == "data_out",
    )


def _config_integer(value: Any, field: str) -> int:
    """Return a JSON integer field without truncating or coercing it.

    ``int()`` would turn 1883.9 into 1883, ``True`` into 1 and "1_883" into
    1883, so the console would save a value the operator never entered.
    """
    if isinstance(value, bool):
        raise ValueError(f"{field} must be an integer")
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    raise ValueError(f"{field} must be an integer")


def _validate_data_out(payload: Dict[str, Any], defaults: Dict[str, Any]) -> Tuple[str, List[str]]:
    """Return the Data Out URL and host list, or raise DataOutHostError.

    The list is checked first, then the URL against it. A list that drops the
    host of an unchanged URL is DATA_OUT_HOST_IN_USE; a URL whose host is not
    in the list is DATA_OUT_URL_NOT_ALLOWED. Both errors carry the list.
    """
    hosts = normalize_data_out_hosts(
        payload.get("data_out_hosts", defaults.get("data_out_hosts", list(DEFAULT_DATA_OUT_HOSTS)))
    )
    base_url = payload.get("base_url", defaults["base_url"])
    url_host = data_out_url_host(base_url)
    if url_host is not None and url_host in hosts:
        return str(base_url).rstrip("/"), hosts
    previous = data_out_url_host(defaults.get("base_url"))
    if "data_out_hosts" in payload and url_host is not None and url_host == previous:
        raise DataOutHostError(
            DATA_OUT_HOST_IN_USE,
            f"data_out_hosts must keep {url_host}, the host of the Data Out URL "
            f"({', '.join(hosts)} given; port {DATA_OUT_PORT})",
            host=url_host,
            hosts=hosts,
        )
    return check_data_out_url(base_url, hosts), hosts


def _validate_console_config(payload: Any, fallback: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    defaults = dict(fallback or _default_console_config())
    if not isinstance(payload, dict):
        raise ValueError("console config must be a JSON object")
    base_url, data_out_hosts = _validate_data_out(payload, defaults)
    mqtt_host = payload.get("mqtt_host", defaults["mqtt_host"])
    if mqtt_host is None:
        mqtt_host = ""
    if not isinstance(mqtt_host, str) or (mqtt_host and not _is_allowed_mqtt_host(mqtt_host)):
        raise ValueError("mqtt_host must be empty, localhost, or a valid IPv4/IPv6 address")
    mqtt_port = _config_integer(payload.get("mqtt_port", defaults["mqtt_port"]), "mqtt_port")
    if not (1 <= mqtt_port <= 65535):
        raise ValueError("mqtt_port must be between 1 and 65535")
    mqtt_transport = payload.get("mqtt_transport", defaults.get("mqtt_transport", "websockets"))
    if not isinstance(mqtt_transport, str) or mqtt_transport not in ALLOWED_MQTT_TRANSPORTS:
        raise ValueError("mqtt_transport must be tcp or websockets")
    mqtt_ws_path = payload.get("mqtt_ws_path", defaults.get("mqtt_ws_path", DEFAULT_MQTT_WS_PATH))
    if not _is_allowed_mqtt_ws_path(mqtt_ws_path):
        raise ValueError("mqtt_ws_path must start with / and use only letters, digits, and ._~/- (max 128)")
    refresh_seconds = _config_integer(payload.get("refresh_seconds", defaults["refresh_seconds"]), "refresh_seconds")
    if refresh_seconds not in ALLOWED_REFRESH_INTERVALS:
        raise ValueError("refresh_seconds is not an allowed interval")
    fallback_lan = defaults.get("lan_access")
    if not isinstance(fallback_lan, dict):
        fallback_lan = lan.default_settings()
    lan_access = lan.validate_settings(payload.get("lan_access", fallback_lan), fallback_lan)
    return _default_console_config(
        base_url,
        mqtt_host.strip(),
        mqtt_port,
        refresh_seconds,
        mqtt_transport=mqtt_transport,
        mqtt_ws_path=mqtt_ws_path,
        data_out_hosts=data_out_hosts,
        lan_access=lan_access,
    )


def _mqtt_connection(config: Dict[str, Any]) -> Tuple[str, int, str, str]:
    return (
        str(config.get("mqtt_host", "")),
        int(config.get("mqtt_port", 9001)),
        str(config.get("mqtt_transport", "websockets")),
        str(config.get("mqtt_ws_path", DEFAULT_MQTT_WS_PATH)),
    )


def _log_warning(message: str) -> None:
    print("[ground-console] warning: " + message, flush=True)


def _backup_invalid_console_config(path: Path, raw: bytes, log: Callable[[str], None]) -> None:
    """Keep the operator's invalid file before a later save replaces it."""
    backup = path.with_name(path.name + ".invalid.bak")
    try:
        if backup.is_file() and backup.read_bytes() == raw:
            return
        fd, temporary = tempfile.mkstemp(prefix=".console-invalid-", dir=str(path.parent))
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
        log(f"a copy of the invalid file was kept at {backup}")
    except OSError as exc:
        log(f"could not back up the invalid console config ({type(exc).__name__})")


def _load_console_config(
    path: Path,
    fallback: Optional[Dict[str, Any]] = None,
    *,
    log: Callable[[str], None] = _log_warning,
) -> Dict[str, Any]:
    """Load saved connection settings, keeping every field that is still valid.

    One bad field falls back to its default on its own, with a warning naming
    the field, instead of silently discarding every saved setting. An
    unreadable file is backed up before any later save can overwrite it.
    """
    defaults = dict(fallback or _default_console_config())
    path = path.expanduser()
    try:
        if path.stat().st_size > MAX_CONSOLE_CONFIG_BYTES:
            log(f"console config {path} exceeds {MAX_CONSOLE_CONFIG_BYTES} bytes; using defaults")
            return defaults
        raw = path.read_bytes()
    except FileNotFoundError:
        return defaults
    except OSError as exc:
        log(f"console config {path} is unreadable ({type(exc).__name__}); using defaults")
        return defaults
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        position = f" at line {exc.lineno} column {exc.colno}" if isinstance(exc, json.JSONDecodeError) else ""
        log(f"console config {path} is not valid JSON{position}; using defaults")
        _backup_invalid_console_config(path, raw, log)
        return defaults
    if not isinstance(payload, dict):
        log(f"console config {path} is not a JSON object; using defaults")
        _backup_invalid_console_config(path, raw, log)
        return defaults
    try:
        return _validate_console_config(payload, defaults)
    except (ValueError, TypeError):
        pass
    accepted: Dict[str, Any] = {}
    rejected: List[str] = []
    # The URL is checked against the host list, so the two are taken
    # together first; failing that, the list on its own (with the default
    # URL), then the URL against whichever list was kept.
    data_out = {field: payload[field] for field in DATA_OUT_FIELDS if field in payload}
    try:
        _validate_console_config(data_out, defaults)
        accepted.update(data_out)
    except (ValueError, TypeError):
        if "data_out_hosts" in data_out:
            try:
                _validate_console_config({"data_out_hosts": data_out["data_out_hosts"]}, defaults)
                accepted["data_out_hosts"] = data_out["data_out_hosts"]
            except (ValueError, TypeError):
                rejected.append("data_out_hosts")
        if "base_url" in data_out:
            try:
                _validate_console_config({**accepted, "base_url": data_out["base_url"]}, defaults)
                accepted["base_url"] = data_out["base_url"]
            except (ValueError, TypeError):
                rejected.append("base_url")
    for field in sorted(key for key in payload if key in defaults and key not in ("version", *DATA_OUT_FIELDS)):
        try:
            _validate_console_config({field: payload[field]}, defaults)
        except (ValueError, TypeError):
            rejected.append(field)
        else:
            accepted[field] = payload[field]
    log(
        f"console config {path}: invalid field(s) {', '.join(rejected) or 'unknown'} "
        "replaced by defaults; other saved fields are kept"
    )
    _backup_invalid_console_config(path, raw, log)
    try:
        return _validate_console_config(accepted, defaults)
    except (ValueError, TypeError):
        return defaults


# Connection fields that a command-line flag of the same name can set.
CLI_CONFIG_FIELDS = ("base_url", "mqtt_host", "mqtt_port", "mqtt_transport", "mqtt_ws_path")
# Validated together: base_url's host must be in data_out_hosts.
DATA_OUT_FIELDS = ("data_out_hosts", "base_url")


def _explicit_cli_options(argv: Optional[Sequence[str]]) -> Set[str]:
    """Return the destinations the operator actually typed on the command line."""
    parser = _build_parser()
    unset = object()
    # argparse only fills defaults for attributes the namespace lacks, so a
    # pre-filled marker survives exactly for the options that were not typed.
    namespace = argparse.Namespace(**{name: unset for name in vars(parser.parse_args([]))})
    parsed = parser.parse_args(argv, namespace=namespace)
    return {name for name, value in vars(parsed).items() if value is not unset}


def _apply_cli_overrides(
    config: Dict[str, Any],
    args: argparse.Namespace,
    explicit: Set[str],
    log: Callable[[str], None] = _log_warning,
) -> Dict[str, Any]:
    """Let an explicit flag win over the saved console.json for this run."""
    overrides = {
        field: getattr(args, field)
        for field in CLI_CONFIG_FIELDS
        if field in explicit and field in config and hasattr(args, field)
    }
    if not overrides:
        return config
    merged = _validate_console_config({**config, **overrides}, config)
    for field in sorted(overrides):
        if merged.get(field) != config.get(field):
            log(f"--{field.replace('_', '-')} from the command line overrides the saved console config for this run")
    return merged


# First-start seed for console.json: environment variable, config field and
# whether the value is an integer. Read from the process environment first,
# then the env file; validated like a saved config. The host list is comma
# separated and replaces the default list; base_url is checked against the
# list that applies (seeded or default).
SEED_ENV_FIELDS: Tuple[Tuple[str, str, bool], ...] = (
    ("SDR_DOA_SEED_DATA_OUT_HOSTS", "data_out_hosts", False),
    ("SDR_DOA_SEED_BASE_URL", "base_url", False),
    ("SDR_DOA_SEED_MQTT_HOST", "mqtt_host", False),
    ("SDR_DOA_SEED_MQTT_PORT", "mqtt_port", True),
    ("SDR_DOA_SEED_MQTT_TRANSPORT", "mqtt_transport", False),
    ("SDR_DOA_SEED_MQTT_WS_PATH", "mqtt_ws_path", False),
    ("SDR_DOA_SEED_REFRESH_SECONDS", "refresh_seconds", True),
)
_SEED_INTEGER_RE = re.compile(r"[0-9]{1,5}")


def _seed_console_config(
    environ: Optional[Dict[str, str]] = None,
    dotenv_values: Optional[Dict[str, str]] = None,
    *,
    log: Callable[[str], None] = _log_warning,
) -> Dict[str, Any]:
    """Build the first console config from SDR_DOA_SEED_* over the defaults.

    An empty variable counts as unset, so a compose file can pass an unset
    variable through. An invalid value is ignored with a warning that names
    the variable only; the other seed values still apply.
    """
    source = os.environ if environ is None else environ
    fallback = dotenv_values or {}
    defaults = _default_console_config()
    accepted: Dict[str, Any] = {}
    seeded_hosts: Optional[str] = None
    for variable, field, integer in SEED_ENV_FIELDS:
        raw = source.get(variable)
        if raw is None or not raw.strip():
            raw = fallback.get(variable)
        if raw is None or not raw.strip():
            continue
        text = raw.strip()
        value: Any = text
        if field == "data_out_hosts":
            value = [part.strip() for part in text.split(",")]
            # On its own the list is checked with base_url left out, so a
            # list without the default URL's host waits for the URL seed.
            try:
                normalize_data_out_hosts(value)
            except DataOutHostError:
                log(f"{variable} is not a valid {field}; ignored")
                continue
            accepted[field] = value
            seeded_hosts = variable
            continue
        if field == "base_url":
            try:
                _validate_data_out({**accepted, field: value}, defaults)
            except (ValueError, TypeError):
                if data_out_url_host(value) is not None:
                    log(f"{variable} names a host outside the Data Out host list; ignored")
                else:
                    log(f"{variable} is not a valid {field}; ignored")
                continue
            accepted[field] = value
            continue
        if integer:
            if _SEED_INTEGER_RE.fullmatch(text) is None:
                log(f"{variable} is not a valid {field}; ignored")
                continue
            value = int(text)
        try:
            _validate_console_config({field: value}, defaults)
        except (ValueError, TypeError):
            log(f"{variable} is not a valid {field}; ignored")
            continue
        accepted[field] = value
    if seeded_hosts is not None and "base_url" not in accepted:
        try:
            _validate_data_out({"data_out_hosts": accepted["data_out_hosts"]}, defaults)
        except (ValueError, TypeError):
            # The list would leave the default Data Out URL outside it.
            log(f"{seeded_hosts} does not include the host of the Data Out URL; ignored")
            del accepted["data_out_hosts"]
    return _validate_console_config(accepted, defaults)


def _initial_console_config(
    path: Path,
    environ: Optional[Dict[str, str]] = None,
    dotenv_values: Optional[Dict[str, str]] = None,
    *,
    log: Callable[[str], None] = _log_warning,
) -> Dict[str, Any]:
    """Load console.json, or on the first start seed it and save it.

    Once the file exists (even an unreadable or invalid one) the seed is never
    used again, so later changes from the UI are what the next start reads.
    """
    path = path.expanduser()
    if os.path.lexists(path):
        return _load_console_config(path, _default_console_config(), log=log)
    config = _seed_console_config(environ, dotenv_values, log=log)
    try:
        _save_console_config(path, config)
    except OSError as exc:
        log(f"could not save the initial console config {path} ({type(exc).__name__}); it applies to this run only")
    else:
        print(f"[ground-console] saved the initial console config to {path}", flush=True)
    return config


def _read_env_file(path: Path) -> Tuple[Dict[str, str], bool]:
    """Return the env file's values and whether it could be read."""
    try:
        return _read_dotenv(path, strict=True), True
    except _DotenvUnreadable:
        return {}, False


def _is_loopback_bind(value: str) -> bool:
    hostname = value.strip().lower().rstrip(".")
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _default_branding() -> Dict[str, str]:
    return {"app_name": DEFAULT_APP_NAME, "logo_data_url": ""}


def _normalize_app_name(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("app_name must be text")
    name = value.strip()
    if not name or len(name) > MAX_BRANDING_NAME_LENGTH:
        raise ValueError(f"app_name must be 1-{MAX_BRANDING_NAME_LENGTH} characters")
    if any(ord(char) < 32 for char in name) or any(char in '<>\"\'' for char in name):
        raise ValueError("app_name contains unsupported characters")
    return name


def _normalize_logo_data_url(value: Any) -> str:
    if value in (None, ""):
        return ""
    if not isinstance(value, str) or len(value) > (MAX_LOGO_BYTES * 2):
        raise ValueError("logo must be a small local PNG")
    match = re.fullmatch(
        r"data:(image/png);base64,([A-Za-z0-9+/=\s]+)",
        value,
    )
    if not match or match.group(1) not in ALLOWED_LOGO_MIME:
        raise ValueError("logo must be a PNG data URL")
    try:
        raw = base64.b64decode(match.group(2), validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise ValueError("logo data is invalid") from exc
    if not raw or len(raw) > MAX_LOGO_BYTES:
        raise ValueError("logo exceeds the 256 KiB limit")
    _validate_logo_bytes(match.group(1), raw)
    # Re-encode the validated bytes so whitespace and duplicate encodings do not
    # become part of the persisted branding record.
    return f"data:{match.group(1)};base64,{base64.b64encode(raw).decode('ascii')}"


def _valid_logo_dimensions(width: int, height: int) -> bool:
    return (
        0 < width <= MAX_LOGO_DIMENSION
        and 0 < height <= MAX_LOGO_DIMENSION
        and width * height <= MAX_LOGO_PIXELS
    )


def _validate_logo_bytes(mime: str, raw: bytes) -> None:
    if mime != "image/png":
        raise ValueError("logo format is not supported; use PNG")
    signature = b"\x89PNG\r\n\x1a\n"
    if len(raw) < 33 or raw[:8] != signature:
        raise ValueError("logo bytes are not a valid PNG")

    dimensions: Optional[Tuple[int, int]] = None
    index = 8
    saw_ihdr = False
    saw_idat = False
    saw_iend = False
    idat_closed = False
    palette_entries = 0
    ihdr_data: Optional[bytes] = None
    idat_chunks: list[bytes] = []
    while index < len(raw):
        if index + 12 > len(raw):
            raise ValueError("logo PNG is incomplete")
        length = int.from_bytes(raw[index:index + 4], "big")
        chunk_type = raw[index + 4:index + 8]
        if len(chunk_type) != 4 or any(
            not (65 <= byte <= 90 or 97 <= byte <= 122) for byte in chunk_type
        ):
            raise ValueError("logo PNG has an invalid chunk type")
        data_start = index + 8
        data_end = data_start + length
        crc_end = data_end + 4
        if length > MAX_LOGO_BYTES or crc_end > len(raw):
            raise ValueError("logo PNG has an invalid chunk")
        data = raw[data_start:data_end]
        expected_crc = int.from_bytes(raw[data_end:crc_end], "big")
        if (zlib.crc32(chunk_type + data) & 0xFFFFFFFF) != expected_crc:
            raise ValueError("logo PNG has an invalid checksum")
        if chunk_type == b"IHDR":
            if saw_ihdr or index != 8 or length != 13:
                raise ValueError("logo PNG has an invalid header")
            ihdr_data = data
            dimensions = (
                int.from_bytes(data[0:4], "big"),
                int.from_bytes(data[4:8], "big"),
            )
            saw_ihdr = True
        elif not saw_ihdr:
            raise ValueError("logo PNG is missing IHDR")
        elif chunk_type == b"IDAT":
            if idat_closed:
                raise ValueError("logo PNG IDAT chunks are not contiguous")
            saw_idat = True
            idat_chunks.append(data)
        elif chunk_type == b"IEND":
            if not saw_idat or length != 0:
                raise ValueError("logo PNG has an invalid IEND")
            saw_iend = True
            index = crc_end
            break
        elif chunk_type == b"PLTE":
            # PLTE is critical, so it is handled before the generic branch
            # that rejects unknown critical chunks.
            if palette_entries or saw_idat:
                raise ValueError("logo PNG has a misplaced or repeated palette")
            if length == 0 or length % 3 != 0 or length > 768:
                raise ValueError("logo PNG has an invalid palette")
            palette_entries = length // 3
        else:
            if saw_idat:
                idat_closed = True
            # Unknown critical chunks are not safe to ignore. Ancillary chunks
            # are accepted only after their CRC has been checked above.
            if 65 <= chunk_type[0] <= 90:
                raise ValueError("logo PNG has an unsupported critical chunk")
        index = crc_end

    if not saw_ihdr or not saw_idat or not saw_iend or index != len(raw):
        raise ValueError("logo PNG is incomplete")
    width, height = dimensions or (0, 0)
    if dimensions is None or not _valid_logo_dimensions(width, height):
        raise ValueError("logo dimensions are invalid or too large")
    header = ihdr_data or b""
    bit_depth = header[8]
    color_type = header[9]
    compression = header[10]
    filter_method = header[11]
    interlace = header[12]
    allowed_depths = PNG_BIT_DEPTHS.get(color_type)
    if allowed_depths is None or bit_depth not in allowed_depths:
        raise ValueError(
            "logo PNG color type or bit depth is not valid; use a standard grayscale, RGB, RGBA or palette PNG"
        )
    if compression != 0 or filter_method != 0 or interlace not in {0, 1}:
        raise ValueError("logo PNG compression, filter or interlace method is not valid")
    if color_type == 3 and not palette_entries:
        raise ValueError("logo PNG palette image is missing its palette")
    if color_type in {0, 4} and palette_entries:
        raise ValueError("logo PNG grayscale image must not carry a palette")
    if color_type == 3 and palette_entries > (1 << bit_depth):
        raise ValueError("logo PNG palette is larger than its bit depth allows")
    bits_per_pixel = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type] * bit_depth
    scanline_starts: List[int] = []
    expected_scanline_bytes = 0
    for pass_width, pass_height in _png_pass_sizes(width, height, interlace == 1):
        if not pass_width or not pass_height:
            continue
        row_bytes = 1 + (pass_width * bits_per_pixel + 7) // 8
        if expected_scanline_bytes + pass_height * row_bytes > MAX_DECODED_LOGO_BYTES:
            raise ValueError("logo PNG decoded data is too large")
        scanline_starts.extend(expected_scanline_bytes + row * row_bytes for row in range(pass_height))
        expected_scanline_bytes += pass_height * row_bytes
    try:
        decompressor = zlib.decompressobj()
        compressed = b"".join(idat_chunks)
        decoded = decompressor.decompress(compressed, MAX_DECODED_LOGO_BYTES + 1)
        decoded += decompressor.flush()
    except zlib.error as exc:
        raise ValueError("logo PNG image data is invalid") from exc
    if (
        decompressor.unconsumed_tail
        or decompressor.unused_data
        or not decompressor.eof
        or len(decoded) > MAX_DECODED_LOGO_BYTES
    ):
        raise ValueError("logo PNG image data is invalid")
    if len(decoded) != expected_scanline_bytes:
        raise ValueError("logo PNG image data is incomplete")
    if any(decoded[offset] > 4 for offset in scanline_starts):
        raise ValueError("logo PNG has an invalid scanline filter")


# Valid PNG bit depths per color type (PNG spec, IHDR).
PNG_BIT_DEPTHS = {
    0: {1, 2, 4, 8, 16},
    2: {8, 16},
    3: {1, 2, 4, 8},
    4: {8, 16},
    6: {8, 16},
}
# Adam7 passes as (x start, y start, x step, y step).
_ADAM7_PASSES = (
    (0, 0, 8, 8),
    (4, 0, 8, 8),
    (0, 4, 4, 8),
    (2, 0, 4, 4),
    (0, 2, 2, 4),
    (1, 0, 2, 2),
    (0, 1, 1, 2),
)


def _png_pass_sizes(width: int, height: int, interlaced: bool) -> List[Tuple[int, int]]:
    if not interlaced:
        return [(width, height)]
    return [
        (
            (width - x0 + dx - 1) // dx if width > x0 else 0,
            (height - y0 + dy - 1) // dy if height > y0 else 0,
        )
        for x0, y0, dx, dy in _ADAM7_PASSES
    ]


def _load_branding(path: Path) -> Dict[str, str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("branding root must be an object")
        return {
            "app_name": _normalize_app_name(payload.get("app_name", DEFAULT_APP_NAME)),
            "logo_data_url": _normalize_logo_data_url(payload.get("logo_data_url", "")),
        }
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return _default_branding()


def _save_json_atomic(path: Path, payload: Any, prefix: str) -> None:
    path = path.expanduser()
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(parent, 0o700)
    except OSError:
        pass
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    fd, temporary = tempfile.mkstemp(prefix=prefix, dir=str(parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(serialized)
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


def _save_branding(path: Path, branding: Dict[str, str]) -> None:
    _save_json_atomic(path, branding, ".branding-")


def _save_console_config(path: Path, config: Dict[str, Any]) -> None:
    _save_json_atomic(path, config, ".console-config-")


HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'">
<title>__APP_NAME__</title>
<style>
:root {
  color-scheme: dark;
  --bg: #07140d;
  --surface: #0c1f15;
  --surface-2: #10291c;
  --surface-3: #163a27;
  --surface-4: #1d4a31;
  --line: #28533b;
  --line-soft: rgba(111, 170, 123, .18);
  --text: #ecfff1;
  --muted: #a8c9ad;
  --subtle: #7fae89;
  --accent: #39d98a;
  --accent-bright: #8cffb6;
  --blue: #65c98a;
  --good: #55e38c;
  --warn: #f0c36a;
  --bad: #ff7189;
  --shadow: 0 14px 34px rgba(0, 0, 0, .26);
}
* { box-sizing: border-box; }
html { min-width: 320px; background: var(--bg); }
body {
  min-width: 320px;
  margin: 0;
  background: radial-gradient(circle at 72% -20%, rgba(57,217,138,.13), transparent 34rem), var(--bg);
  color: var(--text);
  font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
button, input, select { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: wait; opacity: .55; }
button.ghost {
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 7px 10px;
  background: rgba(16,41,28,.84);
  color: var(--muted);
  font-weight: 700;
  letter-spacing: .35px;
}
button.ghost:hover { border-color: var(--accent); color: var(--text); background: var(--surface-3); }
button.danger { border: 1px solid rgba(255,113,137,.55); border-radius: 4px; padding: 7px 10px; background: transparent; color: var(--bad); }
button.danger:hover { background: rgba(255,113,137,.10); }
input, select {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 8px 9px;
  outline: none;
  background: #081a10;
  color: var(--text);
}
input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(57,217,138,.14); }
.console-shell { width: min(1680px, calc(100% - 40px)); margin: 0 auto; padding-bottom: 28px; }
.app-chrome {
  position: sticky;
  top: 0;
  z-index: 20;
  margin: 0 0 12px;
  padding: 0;
  border-bottom: 1px solid var(--line);
  background: rgba(7,11,28,.92);
  box-shadow: 0 12px 28px rgba(4,7,20,.34);
  backdrop-filter: blur(16px);
}
.topbar { display: grid; grid-template-columns: minmax(250px, 1fr) auto auto; align-items: center; gap: 18px; min-height: 76px; padding: 11px 0 10px; }
.brand-block { display: flex; align-items: center; gap: 11px; min-width: 0; }
.brand-mark {
  position: relative;
  display: grid;
  flex: 0 0 48px;
  place-items: center;
  width: 48px;
  height: 48px;
  overflow: hidden;
  border: 1px solid rgba(57,217,138,.65);
  border-radius: 5px;
  background: linear-gradient(145deg, rgba(57,217,138,.10), rgba(57,217,138,.08));
  color: var(--accent-bright);
  font: 800 9px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 1px;
  text-align: center;
}
.brand-mark::before, .brand-mark::after { position: absolute; content: ""; background: rgba(57,217,138,.55); }
.brand-mark::before { top: 7px; bottom: 7px; left: 50%; width: 1px; }
.brand-mark::after { top: 50%; right: 7px; left: 7px; height: 1px; }
.brand-mark img { position: relative; z-index: 1; display: block; width: 100%; height: 100%; object-fit: contain; background: var(--surface-2); }
[hidden] { display: none !important; }
.logo-placeholder { position: relative; z-index: 1; display: grid; place-items: center; width: 100%; height: 100%; padding: 4px; }
.logo-placeholder small { color: var(--subtle); font-size: 7px; letter-spacing: 0; }
.brand-copy { min-width: 0; }
.eyebrow { margin: 0 0 3px; color: var(--accent); font: 800 9px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 1.25px; text-transform: uppercase; }
h1 { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: clamp(18px, 2.1vw, 25px); letter-spacing: -.25px; }
h2 { margin: 0; font-size: 14px; letter-spacing: .05px; }
h3 { margin: 0; font-size: 12px; }
.subline { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin: 4px 0 0; color: var(--muted); font-size: 11px; }
.live-beacon { display: inline-flex; align-items: center; gap: 5px; color: var(--good); font: 800 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .8px; text-transform: uppercase; }
.live-beacon::before { width: 6px; height: 6px; border-radius: 50%; background: var(--good); box-shadow: 0 0 0 3px rgba(85,227,140,.12); content: ""; }
.header-state-grid { display: grid; grid-template-columns: repeat(5, minmax(74px, 1fr)); border: 1px solid var(--line); background: rgba(13,19,39,.75); }
.header-state { min-width: 0; padding: 7px 9px; border-left: 1px solid var(--line); }
.header-state:first-child { border-left: 0; }
.header-state span { display: block; margin-bottom: 3px; color: var(--subtle); font: 800 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .9px; }
.header-state strong { display: block; overflow: hidden; color: var(--text); font: 800 11px ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
.header-state strong.good, .metric-value.good, .value-good { color: var(--good) !important; }
.header-state strong.warn, .metric-value.warn, .value-warn { color: var(--warn) !important; }
.header-state strong.bad, .metric-value.bad, .value-bad { color: var(--bad) !important; }
.source-state strong { max-width: 158px; }
.top-actions { display: flex; align-items: center; justify-content: flex-end; gap: 7px; }
.chip, .state-chip {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 3px 7px;
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--muted);
  font: 800 9px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .75px;
  text-transform: uppercase;
  white-space: nowrap;
}
.chip.safe, .state-chip.good { border-color: rgba(85,227,140,.48); background: rgba(85,227,140,.07); color: var(--good); }
.chip.warn, .state-chip.warn { border-color: rgba(240,195,106,.48); background: rgba(240,195,106,.06); color: var(--warn); }
.chip.bad, .state-chip.bad { border-color: rgba(255,113,137,.50); background: rgba(255,113,137,.07); color: var(--bad); }
.source-strip { display: flex; align-items: center; justify-content: space-between; gap: 13px; padding: 7px 0 9px; border-top: 1px solid var(--line-soft); }
.read-status { display: flex; align-items: center; min-width: 0; gap: 7px; color: var(--muted); font-size: 11px; }
.status-dot { display: inline-block; flex: 0 0 7px; width: 7px; height: 7px; border-radius: 50%; background: var(--subtle); box-shadow: 0 0 0 3px rgba(102,125,167,.13); }
.status-dot.good { background: var(--good); box-shadow: 0 0 0 3px rgba(85,227,140,.13); }
.status-dot.bad { background: var(--bad); box-shadow: 0 0 0 3px rgba(255,113,137,.13); }
.status-dot.warn { background: var(--warn); box-shadow: 0 0 0 3px rgba(240,195,106,.13); }
#message { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-value { overflow: hidden; color: var(--text); font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
.read-actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 7px; }
.read-actions .button-row { display: flex; gap: 7px; }
.primary-button { border: 1px solid rgba(57,217,138,.65); border-radius: 4px; padding: 7px 11px; background: rgba(57,217,138,.11); color: var(--accent-bright); font-weight: 800; }
.primary-button:hover { background: rgba(57,217,138,.19); }
.app-layout { display: grid; grid-template-columns: 166px minmax(0, 1fr) minmax(286px, 300px); gap: 12px; align-items: start; }
.nav-rail { position: sticky; top: 112px; min-width: 0; padding: 10px 7px; border: 1px solid var(--line); background: rgba(13,19,39,.82); box-shadow: var(--shadow); }
.rail-kicker { padding: 2px 8px 9px; color: var(--subtle); font: 800 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 1px; text-transform: uppercase; }
.nav-group { display: grid; gap: 2px; }
.nav-group + .nav-group { margin-top: 14px; padding-top: 11px; border-top: 1px solid var(--line-soft); }
.nav-item { display: flex; align-items: center; min-width: 0; gap: 8px; padding: 8px 8px; border-left: 2px solid transparent; color: var(--muted); font-size: 11px; text-decoration: none; }
.nav-item:hover { background: rgba(57,217,138,.08); color: var(--text); }
.nav-item.active { border-left-color: var(--accent); background: linear-gradient(90deg, rgba(57,217,138,.13), transparent); color: var(--text); font-weight: 800; }
.nav-icon { display: inline-grid; flex: 0 0 18px; place-items: center; width: 18px; height: 18px; border: 1px solid currentColor; border-radius: 3px; color: var(--subtle); font: 800 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
.nav-item.active .nav-icon { color: var(--accent); }
.nav-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-footer { display: grid; gap: 5px; margin-top: 18px; padding: 10px 8px 2px; border-top: 1px solid var(--line-soft); }
.rail-footer span { color: var(--subtle); font: 800 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .85px; }
.rail-footer strong { color: var(--good); font: 800 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
.workspace, .inspector-column, .stack { min-width: 0; }
.workspace-heading { display: flex; align-items: end; justify-content: space-between; gap: 12px; margin: 2px 0 10px; }
.workspace-heading h2 { font-size: 18px; letter-spacing: -.15px; }
.workspace-heading p { margin: 3px 0 0; color: var(--muted); font-size: 11px; }
.workspace-code { color: var(--subtle); font: 800 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .8px; text-transform: uppercase; text-align: right; }
.panel { min-width: 0; margin-bottom: 12px; border: 1px solid var(--line); background: linear-gradient(145deg, rgba(13,19,39,.98), rgba(9,14,30,.98)); box-shadow: var(--shadow); }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.panel-head > div { min-width: 0; }
.panel-title { display: flex; align-items: center; min-width: 0; gap: 8px; }
.panel-index { display: inline-grid; flex: 0 0 22px; place-items: center; width: 22px; height: 22px; border: 1px solid var(--line); color: var(--accent); font: 800 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
.panel-kicker { margin: 0 0 2px; color: var(--subtle); font: 800 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 1px; text-transform: uppercase; }
.panel-head > .panel-title { flex: 1 1 auto; }
.panel-head small, .panel-code { max-width: 48%; min-width: 0; overflow: visible; overflow-wrap: anywhere; color: var(--subtle); font: 9.5px ui-monospace, SFMono-Regular, Menlo, monospace; text-align: right; text-overflow: clip; white-space: normal; }
.panel-tools { display: flex; align-items: center; justify-content: flex-end; min-width: 0; flex-wrap: wrap; gap: 7px; }
.panel-body { padding: 12px; }
.spatial-grid { display: grid; grid-template-columns: minmax(0, 1.28fr) minmax(320px, .82fr); gap: 12px; align-items: stretch; }
.spatial-grid > .panel { margin-bottom: 0; }
.map-panel { border-color: rgba(57,217,138,.48); }
.map-viewport {
  position: relative;
  display: grid;
  min-height: 360px;
  height: clamp(330px, 34vw, 475px);
  place-items: center;
  overflow: hidden;
  background-color: #0b2114;
  background-image: linear-gradient(rgba(80,140,96,.10) 1px, transparent 1px), linear-gradient(90deg, rgba(80,140,96,.10) 1px, transparent 1px), radial-gradient(circle at 50% 50%, rgba(57,217,138,.055), transparent 51%);
  background-size: 42px 42px, 42px 42px, auto;
}
.map-viewport::before, .map-viewport::after { position: absolute; inset: 12%; border: 1px solid rgba(57,217,138,.14); content: ""; transform: rotate(-5deg); }
.map-viewport::after { inset: 21% 8%; border-color: rgba(57,217,138,.10); transform: rotate(11deg); }
.map-grid { position: absolute; inset: 0; opacity: .65; background: linear-gradient(18deg, transparent 49.7%, rgba(57,217,138,.13) 50%, transparent 50.3%), linear-gradient(147deg, transparent 49.7%, rgba(57,217,138,.13) 50%, transparent 50.3%); }
.map-axis { position: absolute; color: rgba(154,175,209,.58); font: 800 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .7px; }
.map-axis.n { top: 10px; left: 50%; transform: translateX(-50%); }
.map-axis.e { top: 50%; right: 10px; transform: translateY(-50%); }
.map-axis.s { bottom: 10px; left: 50%; transform: translateX(-50%); }
.map-axis.w { top: 50%; left: 10px; transform: translateY(-50%); }
.map-panel[data-map-state="waiting"], .map-panel[data-map-state="unavailable"] { border-color: rgba(240,195,106,.55); }
.map-panel[data-map-state="waiting"] .map-viewport, .map-panel[data-map-state="unavailable"] .map-viewport {
  background-image: repeating-linear-gradient(135deg, rgba(240,195,106,.045) 0, rgba(240,195,106,.045) 1px, transparent 1px, transparent 12px), linear-gradient(rgba(80,140,96,.10) 1px, transparent 1px), linear-gradient(90deg, rgba(80,140,96,.10) 1px, transparent 1px), radial-gradient(circle at 50% 50%, rgba(240,195,106,.06), transparent 51%);
  background-size: auto, 42px 42px, 42px 42px, auto;
}
.map-panel[data-map-state="waiting"] .map-state-card, .map-panel[data-map-state="unavailable"] .map-state-card { border-color: rgba(240,195,106,.58); }
.map-panel[data-map-state="waiting"] .map-state-icon, .map-panel[data-map-state="unavailable"] .map-state-icon { border-color: rgba(240,195,106,.82); color: var(--warn); }
.map-state-card { position: relative; z-index: 1; width: min(360px, calc(100% - 34px)); padding: 22px 19px; border: 1px solid rgba(57,217,138,.33); background: rgba(7,11,28,.88); box-shadow: 0 16px 38px rgba(0,0,0,.34); text-align: center; }
.map-state-icon { position: relative; width: 46px; height: 46px; margin: 0 auto 12px; border: 1px solid rgba(57,217,138,.7); border-radius: 50%; color: var(--accent); }
.map-state-icon::before, .map-state-icon::after { position: absolute; content: ""; background: currentColor; }
.map-state-icon::before { top: 11px; bottom: 11px; left: 50%; width: 1px; }
.map-state-icon::after { top: 50%; right: 11px; left: 11px; height: 1px; }
.map-state-icon span { position: absolute; top: 18px; left: 18px; width: 8px; height: 8px; border: 1px solid currentColor; border-radius: 50%; }
.map-state-title { margin: 0; color: var(--text); font: 800 16px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .45px; }
.map-state-copy { margin: 7px 0 0; color: var(--warn); font: 800 10px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 1px; }
.map-state-badge { display: inline-flex; align-items: center; gap: 6px; margin: 13px auto 0; padding: 4px 7px; border: 1px solid rgba(240,195,106,.55); color: var(--warn); font: 800 9px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .65px; }
.map-state-badge::before { width: 6px; height: 6px; border: 1px solid currentColor; border-radius: 50%; content: ""; }
.map-state-badge.ready { border-color: rgba(85,227,140,.48); color: var(--good); }
.map-state-detail { margin: 11px 0 0; color: var(--muted); font-size: 11px; }
.map-footer { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 9px 15px; padding: 9px 12px 10px; border-top: 1px solid var(--line); }
.map-footer-item { display: grid; min-width: 0; gap: 2px; }
.map-footer-item span { color: var(--subtle); font: 800 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .8px; }
.map-footer-item strong { overflow: hidden; color: var(--text); font: 800 10px ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
.map-attribution { grid-column: 1 / -1; margin: 0; color: var(--subtle); font-size: 10px; }
.polar-panel { border-color: rgba(57,217,138,.42); background: radial-gradient(circle at 50% 42%, rgba(57,217,138,.065), transparent 49%), linear-gradient(145deg, rgba(16,41,28,.98), rgba(9,14,30,.98)); }
.compass-wrap { display: grid; place-items: center; padding: 10px 12px 0; }
.polar-frame { position: relative; width: min(100%, 520px); min-width: 0; aspect-ratio: 1; margin-inline: auto; }
.polar-frame canvas { display: block; width: 100%; height: 100%; }
.polar-overlay { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
.polar-center { display: grid; gap: 3px; place-items: center; width: min(205px, calc(100% - 30px)); max-width: calc(100% - 20px); padding: 10px 12px; border: 1px solid rgba(57,217,138,.22); border-radius: 4px; background: rgba(7,11,28,.88); box-shadow: 0 0 26px rgba(7,11,28,.30); text-align: center; }
.compass-angle-label { color: var(--subtle); font: 800 8px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .65px; text-transform: uppercase; }
.compass-angle { color: var(--text); font-size: clamp(22px, 3vw, 29px); font-weight: 800; letter-spacing: -.4px; line-height: 1.05; }
.compass-status { color: var(--accent-bright); font: 800 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .85px; }
.compass-status.unavailable { color: var(--bad); }
.polar-legend { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 6px 13px; max-width: 560px; margin: 4px auto 0; padding: 0 12px; color: var(--muted); font-size: 10px; line-height: 1.3; }
.legend-item { display: inline-flex; min-width: 0; align-items: center; gap: 5px; }
.legend-swatch { display: inline-block; flex: 0 0 auto; width: 20px; height: 2px; background: var(--accent); box-shadow: 0 0 8px rgba(57,217,138,.55); }
.legend-swatch.peak { width: 9px; height: 9px; border: 2px solid var(--blue); border-radius: 50%; background: transparent; box-shadow: none; }
.legend-token { display: inline-grid; place-items: center; min-width: 22px; height: 17px; border: 1px solid rgba(57,217,138,.7); border-radius: 3px; color: var(--accent-bright); font: 800 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
.polar-meta { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px 10px; margin: 9px 12px 0; padding-top: 8px; border-top: 1px solid var(--line-soft); }
.polar-meta > span { display: grid; min-width: 0; gap: 2px; }
.polar-meta-label { color: var(--subtle); font: 800 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .35px; }
.polar-meta strong { overflow: hidden; color: var(--text); font: 800 10px ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
.note { margin: 10px 12px 12px; padding: 8px 9px; border: 1px solid var(--line-soft); background: rgba(57,217,138,.045); color: var(--muted); font-size: 10px; }
.note strong { color: var(--accent-bright); }
.inspector-column .panel { margin-bottom: 12px; }
.inspector-readout { border-color: rgba(57,217,138,.45); }
.readout-body { padding: 14px 13px 13px; }
.readout-label { margin: 0; color: var(--subtle); font: 800 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .9px; text-transform: uppercase; }
.readout-angle { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-top: 7px; }
.readout-angle strong { color: var(--accent-bright); font-size: 32px; letter-spacing: -1px; line-height: 1; }
.readout-angle span { min-width: 0; flex: 1 1 0; padding-bottom: 3px; color: var(--muted); font: 800 9px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; text-align: right; }
.readout-divider { height: 1px; margin: 12px 0 10px; background: var(--line-soft); }
.readout-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 9px; }
.readout-grid span { display: block; color: var(--subtle); font: 800 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .4px; }
.readout-grid strong { display: block; margin-top: 2px; overflow: hidden; color: var(--text); font: 800 10px ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
.metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; padding: 8px 10px 10px; }
.metric { min-width: 0; padding: 9px; border: 1px solid var(--line-soft); background: rgba(16,41,28,.66); }
.metric.primary { grid-column: 1 / -1; border-color: rgba(57,217,138,.48); background: linear-gradient(145deg, rgba(24,67,43,.68), rgba(16,41,28,.72)); }
.metric.delivery { border-color: rgba(57,217,138,.38); }
.metric-label { color: var(--subtle); font: 800 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .7px; text-transform: uppercase; }
.metric-value { margin-top: 5px; overflow: hidden; color: var(--text); font: 800 18px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
.metric.primary .metric-value { font-size: 22px; }
.metric-note { min-height: 15px; margin-top: 3px; overflow: hidden; color: var(--muted); font-size: 9.5px; text-overflow: ellipsis; white-space: nowrap; }
.gate-banner { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 10px 11px 0; padding: 9px; border: 1px solid rgba(255,113,137,.23); border-left: 2px solid var(--bad); background: rgba(255,113,137,.07); }
.gate-banner.good { border-color: rgba(85,227,140,.23); border-left-color: var(--good); background: rgba(85,227,140,.07); }
.gate-title { font: 800 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
.gate-copy { margin: 3px 0 0; color: var(--muted); font-size: 10px; }
.gate-list { display: grid; gap: 0; margin: 9px 11px 10px; padding: 0; list-style: none; }
.gate-list li { display: flex; align-items: baseline; gap: 6px; padding: 6px 0; border-bottom: 1px solid var(--line-soft); color: var(--muted); font-size: 10px; }
.gate-list li:last-child { border-bottom: 0; }
.gate-list li::before { display: inline-grid; flex: 0 0 15px; place-items: center; width: 15px; height: 15px; border-radius: 50%; background: rgba(240,195,106,.16); color: var(--warn); content: "!"; font: 800 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
.gate-list small { color: var(--subtle); font-size: 8px; }
details { margin: 0 11px 11px; padding-top: 8px; border-top: 1px solid var(--line-soft); }
summary { color: var(--muted); cursor: pointer; font: 800 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { max-height: 260px; overflow: auto; margin: 8px 0 0; padding: 9px; border: 1px solid var(--line); border-radius: 3px; background: #081a10; color: #c6d6f6; font: 10px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
.data-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.data-table th, .data-table td { padding: 7px 8px; border-bottom: 1px solid var(--line-soft); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.data-table th { color: var(--muted); font-size: 10.5px; font-weight: 500; }
.data-table td { color: var(--text); font-size: 10.5px; }
.data-table tr:last-child th, .data-table tr:last-child td { border-bottom: 0; }
.data-table thead th { color: var(--subtle); font: 800 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .65px; text-transform: uppercase; }
.data-table thead tr { background: rgba(57,217,138,.045); }
.table-wrap { overflow-x: auto; }
.table-wrap .data-table { min-width: 430px; }
.inspector-column .table-wrap { overflow-x: visible; }
.inspector-column .table-wrap .data-table { width: 100%; min-width: 0; table-layout: fixed; }
.inspector-column .data-table th { width: 39%; }
.inspector-column .data-table td { overflow: visible; overflow-wrap: anywhere; white-space: normal; }
.source-table th:first-child { width: 24%; }
.source-table td { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dense-grid { display: grid; grid-template-columns: minmax(0, 1.38fr) minmax(0, .87fr) minmax(0, .87fr); gap: 12px; margin-top: 12px; align-items: start; }
.dense-grid > .panel, .detail-grid > .panel { margin-bottom: 0; }
.detail-side-stack { display: grid; min-width: 0; gap: 12px; align-content: start; }
.detail-side-stack > .panel { margin-bottom: 0; }
.dense-panel-body { padding: 0; }
.panel-empty { margin: 0; padding: 13px 12px; border-top: 1px solid var(--line-soft); color: var(--subtle); font-size: 10px; }
.panel-empty strong { color: var(--warn); }
.signal-table th:first-child { width: 17%; }
.signal-table th:nth-child(2) { width: 22%; }
.signal-table th:nth-child(3) { width: 23%; }
.signal-table th:nth-child(4) { width: 19%; }
.signal-table th:nth-child(5) { width: 19%; }
.event-log { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.event-log li { display: grid; grid-template-columns: 45px minmax(0,1fr); gap: 7px; padding: 8px 11px; border-bottom: 1px solid var(--line-soft); }
.event-log li:last-child { border-bottom: 0; }
.event-time { color: var(--subtle); font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
.event-copy { display: grid; gap: 2px; min-width: 0; }
.event-copy strong { color: var(--text); font: 800 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .4px; }
.event-copy span { color: var(--muted); font-size: 10px; overflow-wrap: anywhere; }
.health-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; padding: 10px; }
.health-card { min-width: 0; padding: 8px; border: 1px solid var(--line-soft); background: rgba(16,41,28,.62); }
.health-card span { display: block; color: var(--subtle); font: 800 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .65px; text-transform: uppercase; }
.health-card strong { display: block; margin-top: 5px; overflow: hidden; color: var(--text); font: 800 12px ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
.health-card small { display: block; margin-top: 3px; overflow: hidden; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.health-card.good { border-color: rgba(85,227,140,.32); } .health-card.good strong { color: var(--good); }
.health-card.warn { border-color: rgba(240,195,106,.32); } .health-card.warn strong { color: var(--warn); }
.health-card.bad { border-color: rgba(255,113,137,.32); } .health-card.bad strong { color: var(--bad); }
.detail-grid { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(270px, .85fr); gap: 12px; margin-top: 12px; align-items: start; }
.detail-grid .panel-body { padding: 0 12px 11px; }
.inspector-column .readout-grid strong, .inspector-column .metric-note { overflow: visible; overflow-wrap: anywhere; text-overflow: clip; white-space: normal; }
.inspector-column .gate-list li { display: grid; grid-template-columns: 15px minmax(0, 1fr); align-items: start; }
.inspector-column .gate-list li::before { grid-column: 1; grid-row: 1; }
.inspector-column .gate-list li > span, .inspector-column .gate-list li > small { min-width: 0; overflow-wrap: anywhere; }
.inspector-column .gate-list li > span { grid-column: 2; }
.inspector-column .gate-list li > small { grid-column: 2; font-size: 9px; }
.help { margin: 6px 0 0; color: var(--subtle); font-size: 10.5px; }
.footer { margin: 13px 0 0 178px; color: var(--subtle); font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
.modal { position: fixed; z-index: 50; inset: 0; display: grid; place-items: center; padding: 15px; }
.modal[hidden] { display: none; }
.modal-backdrop { position: absolute; inset: 0; background: rgba(3,6,18,.84); }
.modal-card { position: relative; z-index: 1; width: min(720px, 100%); max-height: min(760px, calc(100vh - 30px)); overflow: auto; border: 1px solid var(--blue); border-radius: 5px; background: var(--surface); box-shadow: 0 24px 70px rgba(0,0,0,.58); }
.modal-head { display: flex; align-items: center; justify-content: space-between; gap: 15px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.modal-head p { margin: 3px 0 0; color: var(--muted); font-size: 11px; }
.modal-body { padding: 15px 16px 17px; }
.tabs { display: flex; gap: 4px; margin-bottom: 14px; border-bottom: 1px solid var(--line); }
.tab { margin-bottom: -1px; border: 1px solid transparent; border-bottom-color: var(--line); border-radius: 3px 3px 0 0; padding: 7px 9px; background: transparent; color: var(--muted); font-weight: 700; }
.tab.active { border-color: var(--blue) var(--blue) var(--surface); background: var(--surface-2); color: var(--text); }
.tab-panel[hidden] { display: none; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px; }
.field { display: grid; gap: 5px; }
.field.full { grid-column: 1 / -1; }
.field label { color: var(--muted); font-size: 10px; }
.form-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 7px; margin-top: 14px; }
.admin-box { padding: 12px; border: 1px solid var(--line); background: var(--surface-2); }
.admin-box + .admin-box { margin-top: 11px; }
.admin-status { min-height: 17px; margin: 8px 0 0; color: var(--muted); font-size: 11px; }
.admin-status.good { color: var(--good); } .admin-status.bad { color: var(--bad); }
.logo-preview { display: grid; place-items: center; width: 120px; height: 72px; margin-top: 7px; border: 1px dashed var(--accent); background: var(--surface); color: var(--subtle); font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 1px; }
.logo-preview img { max-width: 100%; max-height: 100%; object-fit: contain; }
@media (max-width: 1320px) {
  .app-layout { grid-template-columns: 154px minmax(0, 1fr) minmax(276px, 288px); }
  .header-state-grid { grid-template-columns: repeat(4, minmax(70px, 1fr)); }
  .header-state.source-state { display: none; }
  .footer { margin-left: 166px; }
}
@media (max-width: 1120px) {
  .topbar { grid-template-columns: minmax(210px, 1fr) auto; }
  .header-state-grid { grid-column: 1 / -1; grid-row: 2; justify-self: stretch; grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .header-state.source-state { display: block; }
  .app-layout { grid-template-columns: 150px minmax(0, 1fr); }
  .inspector-column { grid-column: 2; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; }
  .inspector-column .panel { margin-bottom: 0; }
  .inspector-column .inspector-readout { grid-row: span 2; }
  .dense-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dense-grid > .panel:first-child { grid-column: 1 / -1; }
  .detail-grid { grid-template-columns: minmax(0, 1.45fr) minmax(270px, .85fr); }
}
@media (max-width: 900px) {
  .console-shell { width: min(100% - 24px, 720px); }
  .app-chrome { margin-inline: 0; padding-inline: 0; }
  .topbar { grid-template-columns: 1fr; align-items: stretch; }
  .top-actions { justify-content: flex-start; }
  .header-state-grid { grid-column: auto; grid-row: auto; grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .app-layout { display: block; }
  .nav-rail { position: static; display: flex; align-items: center; gap: 7px; overflow-x: auto; margin-bottom: 12px; padding: 7px; }
  .rail-kicker, .rail-footer, .nav-group + .nav-group { display: none; }
  .nav-group { display: flex; flex: 0 0 auto; gap: 2px; }
  .nav-item { flex: 0 0 auto; border-left: 0; border-bottom: 2px solid transparent; padding: 7px 8px; }
  .nav-item.active { border-bottom-color: var(--accent); background: rgba(57,217,138,.10); }
  .inspector-column { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); margin-top: 12px; }
  .inspector-column .inspector-readout { grid-row: auto; }
  .footer { margin-left: 0; }
}
@media (max-width: 700px) {
  .spatial-grid { grid-template-columns: 1fr; }
  .map-viewport { height: 340px; }
  .dense-grid, .detail-grid, .inspector-column { grid-template-columns: 1fr; }
  .dense-grid > .panel:first-child, .detail-grid > .panel:first-child { grid-column: auto; }
  .header-state-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }
  .header-state { border-top: 1px solid var(--line); }
  .header-state:nth-child(odd) { border-left: 0; }
  .header-state.source-state { display: block; }
  .workspace-heading { align-items: flex-start; flex-direction: column; }
  .workspace-code { text-align: left; }
}
@media (max-width: 520px) {
  .console-shell { width: calc(100% - 24px); }
  h1 { white-space: normal; }
  .brand-mark { flex-basis: 42px; width: 42px; height: 42px; }
  .source-strip { align-items: stretch; flex-direction: column; }
  .read-actions { justify-content: flex-start; }
  .read-actions .button-row { width: 100%; }
  .read-actions .button-row button { flex: 1 1 0; min-width: 0; }
  .panel-head { align-items: flex-start; flex-direction: column; }
  .panel-head small, .panel-code { max-width: 100%; text-align: left; }
  .panel-tools { justify-content: flex-start; }
  .map-viewport { min-height: 300px; height: 300px; }
  .map-state-card { width: calc(100% - 26px); padding: 17px 12px; }
  .polar-meta { grid-template-columns: repeat(2, minmax(0,1fr)); }
  .polar-legend { justify-content: flex-start; }
  .metrics { grid-template-columns: 1fr; }
  .metric.primary { grid-column: auto; }
  .form-grid { grid-template-columns: 1fr; }
  .field.full { grid-column: auto; }
  .modal { padding: 7px; }
  .modal-card { max-height: calc(100vh - 14px); }
}
@media (max-width: 380px) {
  .header-state-grid { grid-template-columns: 1fr 1fr; }
  .panel-head, .panel-body, .readout-body { padding-left: 9px; padding-right: 9px; }
  .map-footer { grid-template-columns: 1fr; }
  .map-attribution { grid-column: auto; }
  .event-log li { grid-template-columns: 38px minmax(0,1fr); padding-inline: 9px; }
}
</style>
</head>
<body>
<main class="console-shell" id="overview">
  <div class="app-chrome">
    <header class="topbar">
      <div class="brand-block">
        <div class="brand-mark" title="Application identity" aria-label="Application identity">
          <span id="logo-placeholder" class="logo-placeholder">SDR<br><small>LOCAL</small></span>
          <img id="logo-image" alt="Application logo" hidden>
        </div>
        <div class="brand-copy">
          <p class="eyebrow">GROUND STATION / SDR-DOA</p>
          <h1 id="app-name">__APP_NAME__</h1>
          <p class="subline"><span class="live-beacon">LOCAL CONTROL PLANE</span><span>observability shell · no remote mutation</span></p>
        </div>
      </div>
      <div class="header-state-grid" aria-label="Console status">
        <div class="header-state"><span>UTC</span><strong id="utc-clock">--:--:--Z</strong></div>
        <div class="header-state"><span>LAST READ</span><strong id="last-read-chip">WAITING</strong></div>
        <div class="header-state source-state"><span>SOURCE</span><strong id="source-url">__BASE_URL__</strong></div>
        <div class="header-state"><span>SYSTEM</span><strong id="system-state" class="warn">WAITING</strong></div>
        <div class="header-state"><span>DELIVERY</span><strong id="delivery-state" class="bad">BLOCKED</strong></div>
      </div>
      <div class="top-actions">
        <span class="chip safe">READ ONLY</span>
        <span class="chip">LOOPBACK · GET</span>
        <button id="settings-open" class="ghost" type="button">Settings</button>
      </div>
    </header>
    <section class="source-strip">
      <p id="message" class="read-status"><span id="status-dot" class="status-dot" aria-hidden="true"></span><span>Awaiting first Data Out read…</span></p>
      <div class="read-actions">
        <span class="chip">SOURCE <span class="mono">/status + /doa</span></span>
        <div class="button-row"><button id="refresh" class="primary-button" type="button">Refresh snapshot</button><button id="auto-refresh" class="ghost" type="button">Auto: off</button></div>
      </div>
    </section>
  </div>

  <div class="app-layout">
    <aside class="nav-rail" aria-label="Primary navigation">
      <div class="rail-kicker">Console map</div>
      <nav id="primary-nav">
        <div class="nav-group">
          <a class="nav-item active" data-nav="overview" aria-current="page" href="#overview"><span class="nav-icon">01</span><span class="nav-label">Overview</span></a>
          <a class="nav-item" data-nav="live-doa" href="#live-doa"><span class="nav-icon">02</span><span class="nav-label">Live DoA</span></a>
          <a class="nav-item" data-nav="tracks-targets" href="#tracks-targets"><span class="nav-icon">03</span><span class="nav-label">Tracks / Targets</span></a>
          <a class="nav-item" data-nav="spectrum" href="#spectrum"><span class="nav-icon">04</span><span class="nav-label">Spectrum</span></a>
        </div>
        <div class="nav-group">
          <a class="nav-item" data-nav="events" href="#events"><span class="nav-icon">05</span><span class="nav-label">Events</span></a>
          <a class="nav-item" data-nav="system-health" href="#system-health"><span class="nav-icon">06</span><span class="nav-label">System Health</span></a>
          <a class="nav-item" data-nav="configuration" href="#configuration"><span class="nav-icon">07</span><span class="nav-label">Configuration</span></a>
        </div>
      </nav>
      <div class="rail-footer"><span>OPERATING MODE</span><strong>READ-ONLY / LOCAL</strong><span>REMOTE WRITE</span><strong style="color:var(--bad)">DISABLED</strong></div>
    </aside>

    <section class="workspace" id="live-doa">
      <header class="workspace-heading">
        <div><p class="eyebrow">MISSION CONTROL / OVERVIEW</p><h2>Telemetry operations workspace</h2><p>Spatial readiness, angular observability, and data gates stay visible in one compact shell.</p></div>
        <div class="workspace-code">SNAPSHOT · BOUNDED READ<br>NO SYNTHETIC TELEMETRY</div>
      </header>

      <section class="spatial-grid" aria-label="Spatial workspace">
        <article id="map-panel" class="panel map-panel" data-map-state="waiting">
          <header class="panel-head"><div class="panel-title"><span class="panel-index">01</span><div><p class="panel-kicker">SPATIAL WORKSPACE</p><h2>Map / OSM</h2></div></div><div class="panel-tools"><span id="map-state-chip" class="state-chip warn">NOT CONFIGURED</span><span class="panel-code">BASE LAYER · OSM</span></div></header>
          <div id="map-viewport" class="map-viewport" role="img" aria-label="OSM-ready map unavailable until valid coordinates are present">
            <div class="map-grid" aria-hidden="true"></div>
            <span class="map-axis n" aria-hidden="true">N</span><span class="map-axis e" aria-hidden="true">E</span><span class="map-axis s" aria-hidden="true">S</span><span class="map-axis w" aria-hidden="true">W</span>
            <div class="map-state-card">
              <div class="map-state-icon" aria-hidden="true"><span></span></div>
              <p id="map-status-title" class="map-state-title">MAP NOT CONFIGURED</p>
              <p id="map-status-copy" class="map-state-copy">WAITING FOR COORDINATES</p>
              <p id="map-state-badge" class="map-state-badge unavailable">UNAVAILABLE · NO POSITION FIX</p>
              <p id="map-coordinates" class="map-state-detail">No valid latitude / longitude fields in the current snapshot.</p>
            </div>
          </div>
          <footer class="map-footer">
            <div class="map-footer-item"><span>POSITION CONTRACT</span><strong id="map-source">NOT PRESENT</strong></div>
            <div class="map-footer-item"><span>VIEW</span><strong id="map-view">OSM / READINESS</strong></div>
            <p id="map-attribution" class="map-attribution">© OpenStreetMap contributors · raster tiles intentionally not loaded until coordinates are valid.</p>
          </footer>
        </article>

        <article id="polar-panel" class="panel polar-panel compass-panel">
          <header class="panel-head"><div class="panel-title"><span class="panel-index">02</span><div><p class="panel-kicker">ANGULAR OBSERVABILITY</p><h2>Polar DoA</h2></div></div><small id="compass-source">Data Out · display-only</small></header>
          <div class="compass-wrap">
            <div class="polar-frame"><canvas id="doa-polar" role="img" aria-describedby="polar-legend compass-detail" aria-label="Polar DoA estimation"></canvas><div class="polar-overlay"><div class="polar-center"><div class="compass-angle-label">canonical source angle · θ₀</div><div id="compass-angle" class="compass-angle">—°</div><div id="compass-display-angle" class="compass-angle-label">plot peak · display —°</div><div id="compass-status" class="compass-status">WAITING FOR DATA</div></div></div></div>
          </div>
          <div id="polar-legend" class="polar-legend" aria-label="Polar legend"><span class="legend-item"><span class="legend-swatch" aria-hidden="true"></span><span>360-bin vector · native shifted dB · display axis</span></span><span class="legend-item"><span class="legend-swatch peak" aria-hidden="true"></span><span>plot peak / display angle</span></span><span class="legend-item"><span class="legend-token" aria-hidden="true">θ₀</span><span>canonical source angle</span></span></div>
          <div class="polar-meta"><span><span class="polar-meta-label">Plot peak · display</span><strong id="polar-peak">—</strong></span><span><span class="polar-meta-label">Canonical source · θ₀</span><strong id="polar-canonical">—</strong></span><span><span class="polar-meta-label">Peak value · native</span><strong id="polar-peak-db">—</strong></span><span><span class="polar-meta-label">Vector bins</span><strong id="polar-bins">—</strong></span></div>
          <p id="compass-detail" class="note"><strong>Provenance:</strong> Canonical source angle (θ₀) is separate from the plotted 360-bin display peak. Both are observability-only; no authority or publication decision is inferred.</p>
        </article>
      </section>

      <section id="tracks-targets" class="dense-grid" aria-label="Lower telemetry panels">
        <article class="panel" aria-labelledby="signals-title">
          <header class="panel-head"><div class="panel-title"><span class="panel-index">03</span><div><p class="panel-kicker">DETECTION LEDGER</p><h2 id="signals-title">Detected signals / track feed</h2></div></div><span id="signal-contract-state" class="panel-code">NO TRACK CONTRACT</span></header>
          <div class="dense-panel-body table-wrap"><table class="data-table signal-table"><thead><tr><th>Source</th><th>Native DoA</th><th>Frequency</th><th>Freshness</th><th>State</th></tr></thead><tbody id="doa-rows"><tr><td colspan="5" class="panel-empty">Waiting for snapshot.</td></tr></tbody></table></div>
          <p id="track-empty" class="panel-empty"><strong>No track objects rendered.</strong> Range, target identity, and target coordinates are not part of the current Data Out contract.</p>
        </article>

        <article id="events" class="panel" aria-labelledby="events-title">
          <header class="panel-head"><div class="panel-title"><span class="panel-index">04</span><div><p class="panel-kicker">OPERATOR LOG</p><h2 id="events-title">Event log</h2></div></div><span id="event-log-state" class="panel-code">WAITING</span></header>
          <ol id="event-log" class="event-log"><li><span class="event-time">--:--</span><span class="event-copy"><strong>CONSOLE</strong><span>Awaiting first snapshot.</span></span></li></ol>
        </article>

        <article id="system-health" class="panel" aria-labelledby="health-title">
          <header class="panel-head"><div class="panel-title"><span class="panel-index">05</span><div><p class="panel-kicker">SUBSYSTEM STATUS</p><h2 id="health-title">Subsystem health</h2></div></div><span class="panel-code">READ-ONLY</span></header>
          <div id="health-grid" class="health-grid">
            <div class="health-card"><span>DAQ</span><strong id="health-daq">—</strong><small id="health-daq-detail">waiting</small></div>
            <div class="health-card"><span>DoA output</span><strong id="health-doa">—</strong><small id="health-doa-detail">waiting</small></div>
            <div class="health-card"><span>Ground clock</span><strong id="health-clock">—</strong><small id="health-clock-detail">waiting</small></div>
            <div class="health-card"><span>MQTT monitor</span><strong id="health-mqtt">OFF</strong><small id="health-mqtt-detail">subscriber-only</small></div>
          </div>
        </article>
      </section>

      <section class="detail-grid" aria-label="Technical details">
        <article class="panel">
          <header class="panel-head"><div class="panel-title"><span class="panel-index">06</span><div><p class="panel-kicker">SOURCE CORRELATION</p><h2>Native DoA views</h2></div></div><span class="panel-code">DIAGNOSTIC · NOT AUTHORITY</span></header>
          <div class="panel-body table-wrap"><table class="data-table source-table"><tbody id="source-rows"></tbody></table></div>
          <p class="note"><strong>Native views stay separate:</strong> CSV and XML are correlated for diagnosis. The console does not select authority automatically.</p>
        </article>

        <div class="detail-side-stack">
          <article id="spectrum" class="panel">
            <header class="panel-head"><div class="panel-title"><span class="panel-index">07</span><div><p class="panel-kicker">RF OBSERVABILITY</p><h2>Spectrum / waterfall</h2></div></div><span class="state-chip warn">UNAVAILABLE</span></header>
            <div class="panel-body"><p class="note" style="margin:0"><strong>NO SPECTRUM CONTRACT.</strong> The current Data Out snapshot has no validated spectrum or waterfall stream. No live-looking plot is rendered.</p></div>
          </article>

          <article id="configuration" class="panel">
            <header class="panel-head"><div class="panel-title"><span class="panel-index">08</span><div><p class="panel-kicker">EFFECTIVE CONFIG</p><h2>Read-only settings view</h2></div></div><span class="panel-code">SAFE SUBSET</span></header>
            <div class="panel-body table-wrap"><table class="data-table"><tbody id="settings-rows"></tbody></table><p class="help">Raw settings, credentials, and logs are omitted. Local <span class="mono">control dry-run</span> only validates a preview and never applies it.</p></div>
          </article>
        </div>
      </section>
    </section>

    <aside class="inspector-column" aria-label="Inspector and status">
      <article class="panel inspector-readout">
        <header class="panel-head"><div class="panel-title"><span class="panel-index">I</span><div><p class="panel-kicker">INSPECTOR</p><h2>Selected observation</h2></div></div><span class="panel-code">DISPLAY-ONLY</span></header>
        <div class="readout-body">
          <p class="readout-label">Canonical source angle · θ₀</p>
          <div class="readout-angle"><strong id="inspector-angle">—°</strong><span id="inspector-angle-note">waiting for<br>correlated DoA</span></div>
          <div class="readout-divider"></div>
          <div class="readout-grid"><span>DISPLAY PEAK<strong id="inspector-display-peak">—</strong></span><span>NATIVE PEAK<strong id="inspector-peak-db">—</strong></span><span>BINS<strong id="inspector-bins">—</strong></span><span>FRESHNESS<strong id="inspector-freshness">—</strong></span></div>
          <p id="inspector-provenance" class="help">No observation selected. Plot is cleared until a fresh, complete vector is available.</p>
        </div>
      </article>

      <article class="panel">
        <header class="panel-head"><div class="panel-title"><span class="panel-index">S</span><div><p class="panel-kicker">SYSTEM SUMMARY</p><h2>Operational state</h2></div></div><span class="panel-code">LIVE READ</span></header>
        <section class="metrics">
          <div class="metric primary"><div class="metric-label">Overall state</div><div id="overall" class="metric-value warn">WAITING</div><div id="overall-detail" class="metric-note">awaiting snapshot</div></div>
          <div class="metric"><div class="metric-label">DAQ health</div><div id="daq" class="metric-value">—</div><div id="daq-detail" class="metric-note">sync flags</div></div>
          <div class="metric"><div class="metric-label">DoA age</div><div id="doa-age" class="metric-value">—</div><div id="doa-detail" class="metric-note">CSV / XML</div></div>
          <div class="metric delivery"><div class="metric-label">Delivery gate</div><div id="delivery-summary" class="metric-value bad">BLOCKED</div><div id="delivery-detail" class="metric-note">publish held</div></div>
          <div class="metric"><div class="metric-label">Dropped frames</div><div id="drops" class="metric-value">—</div><div id="drops-detail" class="metric-note">counter status</div></div>
          <div class="metric"><div class="metric-label">MQTT monitor</div><div id="mqtt-connection" class="metric-value">OFF</div><div id="mqtt-detail" class="metric-note">subscriber-only</div></div>
        </section>
      </article>

      <article class="panel">
        <header class="panel-head"><div class="panel-title"><span class="panel-index">G</span><div><p class="panel-kicker">PUBLICATION GATE</p><h2>DoA delivery gate</h2></div></div><small id="gate-count">—</small></header>
        <div id="gate-banner" class="gate-banner"><div><div id="gate-title" class="gate-title">BLOCKED</div><p id="gate-copy" class="gate-copy">No gate decision yet.</p></div><span id="gate-pill" class="chip bad">BLOCKED</span></div>
        <ul id="gate-reasons" class="gate-list"><li>Waiting for snapshot</li></ul>
        <details><summary>Technical checks</summary><pre id="gate-debug">—</pre></details>
      </article>

      <article class="panel">
        <header class="panel-head"><div class="panel-title"><span class="panel-index">N</span><div><p class="panel-kicker">NODE INSPECTOR</p><h2>System health detail</h2></div></div><span class="panel-code">DATA OUT :8081</span></header>
        <div class="panel-body table-wrap"><table class="data-table"><tbody id="status-rows"></tbody></table></div>
      </article>

      <article class="panel">
        <header class="panel-head"><div class="panel-title"><span class="panel-index">M</span><div><p class="panel-kicker">MESSAGE MONITOR</p><h2>MQTT subscriber</h2></div></div><span class="panel-code">NO PUBLISH</span></header>
        <div class="panel-body table-wrap"><table class="data-table"><tbody id="mqtt-rows"></tbody></table><details><summary>MQTT status</summary><pre id="mqtt-last">Monitor is disabled.</pre></details></div>
      </article>
    </aside>
  </div>
  <p class="footer">SDR-DoA Ground Console · loopback-only · bounded GET reads · this view sends no commands · <span class="mono">control dry-run</span> is preview-only.</p>
</main>

<div id="settings-modal" class="modal" hidden>
  <div class="modal-backdrop" data-close-settings></div>
  <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <header class="modal-head"><div><p class="eyebrow">LOCAL CONSOLE CONFIGURATION</p><h2 id="settings-title">Settings</h2><p>Connection and branding changes stay inside the Ground Console.</p></div><button id="settings-close" class="ghost" type="button" aria-label="Close settings">Close</button></header>
    <div class="modal-body">
      <nav class="tabs" aria-label="Settings tabs"><button class="tab active" data-tab="connection" type="button">Data & connection</button><button class="tab" data-tab="branding" type="button">Admin & branding</button></nav>
      <section id="tab-connection" class="tab-panel">
        <p class="note" style="margin:0 0 13px"><strong>Staging-safe:</strong> changes only alter the Ground Console read source and local monitor. Nothing is written to RDF-SDR.</p>
        <div class="form-grid"><div class="field full"><label for="data-url">Data Out URL</label><input id="data-url" value="__BASE_URL__" spellcheck="false"><p class="help">HTTP GET only to the approved SDR-DoA host allowlist. This view only subscribes to MQTT; an admin-confirmed config patch is sent from the main console only.</p></div><div class="field"><label for="mqtt-host">MQTT monitor host</label><input id="mqtt-host" value="__MQTT_HOST__" placeholder="10.90.0.1" spellcheck="false"></div><div class="field"><label for="mqtt-port">MQTT port</label><input id="mqtt-port" type="number" value="__MQTT_PORT__" min="1" max="65535"></div><div class="field"><label for="refresh-interval">Auto-refresh</label><select id="refresh-interval"><option value="0">Off</option><option value="1">Every 1 second</option><option value="2">Every 2 seconds</option><option value="5">Every 5 seconds</option><option value="10">Every 10 seconds</option><option value="30">Every 30 seconds</option></select></div></div>
        <div class="form-actions"><button id="apply-connection" class="primary-button" type="button">Apply & refresh</button><button id="monitor-connect" class="ghost" type="button">Connect MQTT monitor</button></div><p id="connection-status" class="admin-status"></p>
      </section>
      <section id="tab-branding" class="tab-panel" hidden>
        <div id="admin-login-box" class="admin-box"><p class="eyebrow">LOCAL ADMIN</p><h2>Change application identity</h2><p class="help">Admin login is disabled until the operator supplies the local password.</p><div class="form-grid" style="margin-top:11px"><div class="field"><label for="admin-password">Admin password</label><input id="admin-password" type="password" autocomplete="current-password"></div></div><div class="form-actions"><button id="admin-login" class="primary-button" type="button">Sign in</button></div><p id="admin-login-status" class="admin-status"></p></div>
        <div id="admin-workspace" class="admin-box" hidden><div class="panel-head" style="padding:0 0 10px;border:0"><div><p class="eyebrow">BRANDING</p><h2>Application identity</h2></div><button id="admin-logout" class="danger" type="button">Sign out</button></div><div class="form-grid"><div class="field full"><label for="brand-name">Application name</label><input id="brand-name" maxlength="60" autocomplete="off"></div><div class="field full"><label for="brand-logo">Application logo</label><input id="brand-logo" type="file" accept="image/png"><p class="help">Validated PNG, maximum 256 KiB. Leave empty to keep the current logo.</p><div class="logo-preview"><span id="preview-placeholder">PREVIEW</span><img id="brand-preview" alt="Logo preview" hidden></div></div></div><div class="form-actions"><button id="brand-reset-logo" class="ghost" type="button">Remove logo</button><button id="brand-save" class="primary-button" type="button">Save branding</button></div><p id="brand-status" class="admin-status"></p></div>
      </section>
    </div>
  </section>
</div>

<script>
const initialConfig = __CONSOLE_CONFIG_JSON__;
const $ = (id) => document.getElementById(id);
if (initialConfig && initialConfig.refresh_seconds !== undefined) $('refresh-interval').value = String(initialConfig.refresh_seconds);
const state = { dataUrl: $('data-url').value, autoTimer: null, autoSeconds: 0, collectionId: null, consoleSeconds: Number(initialConfig?.refresh_seconds)||0, branding: null, pendingLogo: null, refreshSequence: 0, mqttSequence: 0, refreshController: null, expiryTimer: null, snapshot: null, polar: { values: null, angle: null, fresh: false, figType: 'Compass', compassOffset: 0, localAxis: true } };
function esc(value) { return String(value ?? '—').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;'); }
function kind(value) { const s=String(value||'').toUpperCase(); return s==='LIVE'||s==='PASS'||s==='READY'||s==='CONNECTED'?'good':(s==='DEGRADED'||s==='STALE'||s==='BLOCKED'||s==='FAIL'||s==='ERROR'?'bad':'warn'); }
function pill(value) { const cls=kind(value); return `<span class="chip ${cls==='good'?'safe':(cls==='bad'?'bad':'warn')}">${esc(value)}</span>`; }
function rows(items) { return items.map(([key,value,cls='']) => `<tr><th>${esc(key)}</th><td class="${cls}">${value}</td></tr>`).join(''); }
function safeValue(value) { return typeof value === 'object' && value !== null ? esc(JSON.stringify(value)) : esc(value); }
function formatAge(freshness) { if(!freshness) return '—'; if(freshness.age_ms===null||freshness.age_ms===undefined) return 'clock unverified'; return `${(Number(freshness.age_ms)/1000).toFixed(1)} s`; }
function formatNumber(value, digits=2) { return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'; }
function boolLabel(value) { return value===true?'yes':(value===false?'no':'—'); }
function reasonLabel(reason) { return ({
  GROUND_CLOCK_UNVERIFIED:'Ground and node clocks are not verified',
  CANONICAL_ANGLE_NOT_CONFIGURED:'Canonical angle convention is not approved',
  DOA_AUTHORITY_NOT_SELECTED:'DoA authority source is not selected',
  SELECTED_UNITS_NOT_READY:'Selected source unit contract is not ready',
  CONFIDENCE_MAPPING_UNVERIFIED:'Native PAPR is not mapped to confidence 0–1',
  POWER_MAPPING_UNVERIFIED:'Native power is not calibrated to power_db contract',
  POWER_FLOOR_LOSSY:'XML power is at floor and information is lossy',
  NATIVE_DOA_VIEWS_CONFLICT:'CSV and XML views differ after canonicalization',
  DAQ_HEALTH_GATE_FAILED:'DAQ or frame synchronization gate failed',
  DOA_CANDIDATES_STALE:'DoA output is older than the freshness window',
  STATUS_UNAVAILABLE_OR_INVALID:'Node status is unavailable or invalid',
  NO_VALID_DOA_CANDIDATE:'No valid DoA candidate was parsed',
  STATUS_STALE:'Node status is older than the freshness window',
  SELECTED_AUTHORITY_UNAVAILABLE:'Selected authority source is unavailable',
  SELECTED_DOA_STALE:'Selected DoA source is stale',
  NODE_CLOCK_STALLED:'Node status counters stopped advancing; Data Out files are frozen',
  ADC_OVERDRIVE:'ADC overdrive reported; reduce receiver gain',
  COLLECTION_DEADLINE_EXCEEDED:'Data Out read did not finish within the collection deadline',
  CSV_VIEW_UNAVAILABLE:'CSV view (DOA_value.html) is unavailable',
  XML_VIEW_UNAVAILABLE:'XML view (doa.xml) is unavailable',
  NATIVE_ANGLE_INVALID:'A native DoA angle is out of range or not finite',
  NATIVE_ANGLE_UNCHECKED:'CSV and XML came from different frames, so their angles were not cross-checked',
  ANGULAR_PEAK_ANGLE_MISMATCH:'CSV vector peak does not match theta_0'
}[reason]||reason); }
function setStatus(id, text, cls='') { $(id).textContent=text; $(id).className=`admin-status ${cls}`; }
function setReadStatus(text, cls='') { const message=$('message'); const label=message?.querySelector('span:last-child'); if(label) label.textContent=text; else message.textContent=text; $('status-dot').className=`status-dot ${cls}`; }
function renderClock() { const now=new Date(); $('utc-clock').textContent=now.toISOString().slice(11,19)+'Z'; }
function renderBranding(data) {
  state.branding=data||{app_name:'SDR-DoA Ground Console',logo_data_url:''};
  $('app-name').textContent=state.branding.app_name; document.title=state.branding.app_name;
  const hasLogo=Boolean(state.branding.logo_data_url); $('logo-image').hidden=!hasLogo; $('logo-placeholder').hidden=hasLogo;
  if(hasLogo) $('logo-image').src=state.branding.logo_data_url; else $('logo-image').removeAttribute('src');
  $('brand-name').value=state.branding.app_name; const preview=state.pendingLogo ?? state.branding.logo_data_url;
  $('brand-preview').hidden=!preview; $('preview-placeholder').hidden=Boolean(preview); if(preview) $('brand-preview').src=preview;
}
async function loadBranding() { try { const r=await fetch('/api/branding',{cache:'no-store'}); if(r.ok) renderBranding(await r.json()); } catch(e) {} }
function setHealthCard(id, value, detail, tone='') { const card=$(id)?.closest('.health-card'); if(!card) return; $(id).textContent=value; $(id).className=''; card.className=`health-card ${tone}`; const detailNode=$(id+'-detail'); if(detailNode) detailNode.textContent=detail; }
function mqttCount(value) { return Number.isInteger(value)&&value>=0?value:0; }
function mqttMs(value) { return Number.isFinite(value)?`${value} ms`:'—'; }
function mqttTransport(data) { return data.transport==='tcp'?'MQTT over TCP':(data.transport==='websockets'?`MQTT over WebSocket ${data.ws_path||'/mqtt'}`:'—'); }
function renderMqtt(data) {
  const enabled=Boolean(data&&data.enabled); const connection=data?.connection||'off';
  const valid=mqttCount(data?.valid), invalid=mqttCount(data?.invalid), cleared=mqttCount(data?.cleared);
  $('mqtt-connection').textContent=enabled?connection.toUpperCase():'OFF'; $('mqtt-connection').className=`metric-value ${kind(enabled&&connection==='connected'?'PASS':(enabled?'DEGRADED':'UNKNOWN'))}`;
  $('mqtt-detail').textContent=enabled?`${data.host}:${data.port} · ${valid} valid · ${invalid} invalid${cleared?` · ${cleared} cleared`:''}`:'subscriber-only / off';
  setHealthCard('health-mqtt', enabled?connection.toUpperCase():'OFF', enabled?'subscriber-only · '+valid+' valid':'subscriber-only', enabled&&connection==='connected'?'good':(enabled?'warn':''));
  if(!enabled){ $('mqtt-rows').innerHTML=rows([['Mode','OFF'],['Publish',pill('disabled')]]); $('mqtt-last').textContent='MQTT monitor is not enabled.'; return; }
  $('mqtt-rows').innerHTML=rows([
    ['Connection',pill(connection)],['Transport',esc(mqttTransport(data))],['Topics',esc(data.root?`${data.root}/…`:'—')],['Messages',esc(mqttCount(data.received))],['Valid / invalid',esc(`${valid} / ${invalid}`)],['Retained clears',esc(cleared)],['Last age',esc(mqttMs(data.last_age_ms))],['Publish',pill('false')]
  ]);
  $('mqtt-last').textContent=JSON.stringify({connection,last_error:data.last_error??null,received:mqttCount(data.received),valid,invalid,cleared,last_age_ms:data.last_age_ms??null},null,2);
}
// Mirrors frontend/src/lib/polar.ts: Polar is theta_0 counter-clockwise (KrakenSDR Polar plot); Linear has no polar axis, so its compass_offset gets a local Compass axis.
function polarSettings(figType, compassOffset) { const requested=String(figType??'').trim().toLowerCase(); const numeric=typeof compassOffset==='number'?compassOffset:(typeof compassOffset==='string'&&compassOffset.trim()!==''?Number(compassOffset.trim()):NaN); return { figType:requested==='polar'?'Polar':'Compass', compassOffset:Number.isFinite(numeric)?numeric:0, localAxis:requested!=='polar'&&requested!=='compass' }; }
function normalizeDegrees(deg) { return ((Number(deg)%360)+360)%360; }
function polarDisplayAngle(bin, settings) { return normalizeDegrees(settings.figType==='Compass'?360-bin+settings.compassOffset:bin); }
function polarScreenAngle(bin, settings) { return settings.figType==='Compass'?polarDisplayAngle(bin,settings):normalizeDegrees(360-bin); }
function drawPolar(values, angle, fresh, figType='Compass', compassOffset=0) {
  const canvas=$('doa-polar'); const frame=canvas?.closest('.polar-frame')||canvas?.parentElement; if(!canvas||!frame) return;
  const cssSize=Math.max(1,Math.floor(frame.getBoundingClientRect().width||frame.clientWidth||420)); const dpr=Math.min(window.devicePixelRatio||1,2); const size=Math.max(1,Math.floor(cssSize*dpr));
  if(canvas.width!==size||canvas.height!==size){ canvas.width=size; canvas.height=size; }
  const ctx=canvas.getContext('2d'); if(!ctx) return; ctx.setTransform(size/cssSize,0,0,size/cssSize,0,0); ctx.clearRect(0,0,cssSize,cssSize);
  const styles=getComputedStyle(document.documentElement); const line=styles.getPropertyValue('--line').trim()||'#28533b'; const muted=styles.getPropertyValue('--muted').trim()||'#a8c9ad'; const subtle=styles.getPropertyValue('--subtle').trim()||'#7fae89'; const accent=styles.getPropertyValue('--accent').trim()||'#39d98a'; const blue=styles.getPropertyValue('--blue').trim()||'#65c98a';
  const cx=cssSize/2, cy=cssSize/2, maxR=cssSize*.365; const settings=polarSettings(figType,compassOffset); const compass=settings.figType==='Compass'; const labelPosition=deg=>compass?deg:normalizeDegrees(360-deg); const toRadians=deg=>(deg-90)*Math.PI/180;
  ctx.save(); ctx.translate(cx,cy); ctx.lineWidth=1; ctx.strokeStyle=line; ctx.globalAlpha=.92; [.25,.5,.75,1].forEach(f=>{ ctx.beginPath(); ctx.arc(0,0,maxR*f,0,Math.PI*2); ctx.stroke(); });
  for(let deg=0;deg<360;deg+=45){ const radians=toRadians(deg); ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(radians)*maxR,Math.sin(radians)*maxR); ctx.stroke(); }
  ctx.globalAlpha=1; ctx.fillStyle=muted; ctx.font='700 10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  const perimeterInset=Math.max(9,cssSize*.035); const cardinalRadius=Math.min(maxR+Math.min(23,Math.max(15,cssSize*.06)),cssSize/2-perimeterInset); const degreeRadius=Math.min(maxR+Math.min(18,Math.max(12,cssSize*.045)),cssSize/2-perimeterInset); const directions=[['N',0],['E',90],['S',180],['W',270]]; const axisLabels=compass?directions:[['0°',0],['90°',90],['180°',180],['270°',270]];
  axisLabels.forEach(([label,deg])=>{ const radians=toRadians(labelPosition(deg)); ctx.fillText(label,Math.cos(radians)*cardinalRadius,Math.sin(radians)*cardinalRadius); });
  ctx.fillStyle=subtle; ctx.font='10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'; const diagonalDegrees=new Set([45,135,225,315]);
  for(let deg=0;deg<360;deg+=45){ const radians=toRadians(deg); ctx.beginPath(); ctx.moveTo(Math.cos(radians)*maxR,Math.sin(radians)*maxR); ctx.lineTo(Math.cos(radians)*(maxR+6),Math.sin(radians)*(maxR+6)); ctx.stroke(); if(diagonalDegrees.has(deg)){ const labelRadians=toRadians(labelPosition(deg)); ctx.fillText(`${deg}°`,Math.cos(labelRadians)*degreeRadius,Math.sin(labelRadians)*degreeRadius); } }
  const finite=Array.isArray(values)&&values.length===360?values.map(Number):null; const validData=Boolean(fresh&&finite&&finite.every(Number.isFinite));
  if(validData){
    const floor=Math.min(...finite), peakValue=Math.max(...finite), span=peakValue-floor; const yFor=value=>span>0?Math.max(0,Math.min(1,(value-floor)/span)):1; ctx.textAlign='left'; ctx.fillStyle=subtle; ctx.font='9px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'; const precision=span<5?1:0;
    [.25,.5,.75,1].forEach(f=>{ const label=`${(floor+span*f).toFixed(precision)} dB`; const radialLabelY=-maxR+(maxR*2.0*f); const labelWidth=ctx.measureText(label).width; const rightEdge=Math.max(0,cssSize/2-4); const radialLabelX=Math.min(maxR+8,rightEdge-labelWidth); ctx.fillText(label,radialLabelX,radialLabelY); });
    const point=(value,index)=>{ const radians=toRadians(polarScreenAngle(index,settings)), radius=maxR*yFor(value); return [Math.cos(radians)*radius,Math.sin(radians)*radius]; };
    const drawCurve=()=>{ finite.forEach((value,index)=>{ const [x,y]=point(value,index); index?ctx.lineTo(x,y):ctx.moveTo(x,y); }); const [x0,y0]=point(finite[0],0); ctx.lineTo(x0,y0); };
    ctx.beginPath(); drawCurve(); ctx.closePath(); ctx.fillStyle='rgba(57,217,138,.14)'; ctx.fill(); ctx.beginPath(); drawCurve(); ctx.closePath(); ctx.strokeStyle=accent; ctx.lineWidth=2; ctx.shadowColor='rgba(57,217,138,.48)'; ctx.shadowBlur=8; ctx.stroke();
    const peakIndex=finite.indexOf(peakValue); if(peakIndex>=0){ const displayPeak=polarDisplayAngle(peakIndex,settings), peakScreen=polarScreenAngle(peakIndex,settings), [px,py]=point(finite[peakIndex],peakIndex); ctx.shadowBlur=0; ctx.fillStyle=accent; ctx.beginPath(); ctx.arc(px,py,3.5,0,Math.PI*2); ctx.fill(); ctx.strokeStyle=blue; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(px,py); ctx.lineTo(Math.cos(toRadians(peakScreen))*(maxR+12),Math.sin(toRadians(peakScreen))*(maxR+12)); ctx.stroke(); ctx.fillStyle=accent; ctx.font='700 9px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'; ctx.textAlign='center'; ctx.fillText(`PLOT ${displayPeak.toFixed(0)}°`,px,py < -maxR*.45 ? py+15 : py-11); }
  }
  ctx.restore();
}
function setPolarUnavailable(reason='polar unavailable', settings=polarSettings(state.polar?.localAxis?null:state.polar?.figType,state.polar?.compassOffset)) {
  state.polar={values:null,angle:null,fresh:false,figType:settings.figType,compassOffset:settings.compassOffset,localAxis:settings.localAxis}; drawPolar(null,null,false,settings.figType,settings.compassOffset);
  $('polar-peak').textContent='—'; $('polar-canonical').textContent='—'; $('polar-peak-db').textContent='—'; $('polar-bins').textContent='—'; $('compass-angle').textContent='—°'; $('compass-display-angle').textContent='plot peak · display —°'; $('compass-status').textContent='POLAR UNAVAILABLE'; $('compass-status').className='compass-status unavailable'; $('compass-source').textContent='Data Out · unavailable'; $('compass-detail').innerHTML=`<strong>Unavailable:</strong> ${esc(reason)}`; $('doa-polar').setAttribute('aria-label',`Polar DoA unavailable. ${reason}`);
  $('inspector-angle').textContent='—°'; $('inspector-display-peak').textContent='—'; $('inspector-peak-db').textContent='—'; $('inspector-bins').textContent='—'; $('inspector-freshness').textContent='—'; $('inspector-angle-note').innerHTML='waiting for<br>correlated DoA'; $('inspector-provenance').textContent='No observation selected. Plot is cleared until a fresh, complete vector is available.';
}
function renderPolar(snapshot,csv,dataAvailable) {
  const fields=snapshot.settings?.fields||{}; const requestedType=Object.prototype.hasOwnProperty.call(fields,'doa_fig_type')?fields.doa_fig_type:(state.polar?.localAxis?null:state.polar?.figType); const requestedOffset=Object.prototype.hasOwnProperty.call(fields,'compass_offset')?fields.compass_offset:state.polar?.compassOffset; const settings=polarSettings(requestedType,requestedOffset); const angle=Number(csv.canonical_angle_deg); const values=Array.isArray(csv.angular_power_db)?csv.angular_power_db:null; const fresh=Boolean(dataAvailable&&csv.freshness?.fresh===true&&values?.length===360&&values.every(value=>Number.isFinite(Number(value))));
  state.polar={values,angle:Number.isFinite(angle)?angle:null,fresh,figType:settings.figType,compassOffset:settings.compassOffset,localAxis:settings.localAxis}; if(!fresh||!Number.isFinite(angle)){ setPolarUnavailable('Curve cleared: DoA data is stale, conflicting, or incomplete.',settings); return; }
  drawPolar(values,angle,true,settings.figType,settings.compassOffset); const peakIndex=Number(csv.angular_peak_index); const peakReady=Number.isInteger(peakIndex)&&peakIndex>=0&&peakIndex<values.length; const displayAngle=peakReady?polarDisplayAngle(peakIndex,settings):null; const axisSource=settings.localAxis?'Data Out offset · local Compass axis':`Data Out · ${settings.figType} display axis`; const peakLabel=displayAngle===null?'—':`${displayAngle.toFixed(0)}° · bin ${peakIndex}`; const canonicalLabel=`${angle.toFixed(1)}° · θ₀`;
  $('polar-peak').textContent=peakLabel; $('polar-canonical').textContent=canonicalLabel; $('polar-peak-db').textContent=Number.isFinite(Number(csv.angular_peak_db))?`${Number(csv.angular_peak_db).toFixed(1)} dB`:'—'; $('polar-bins').textContent=String(values.length); $('compass-angle').textContent=`${angle.toFixed(1)}°`; $('compass-display-angle').textContent=`plot peak · display ${displayAngle===null?'—':displayAngle.toFixed(0)+'°'} · bin ${peakReady?peakIndex:'—'}`; $('compass-status').textContent='DATA AVAILABLE'; $('compass-status').className='compass-status'; $('compass-source').textContent=`${axisSource} · ${formatAge(csv.freshness)}`; $('compass-detail').innerHTML=`<strong>Provenance:</strong> canonical source ${angle.toFixed(1)}° (θ₀) versus plotted display peak ${displayAngle===null?'—':displayAngle.toFixed(0)+'°'} (bin ${peakReady?peakIndex:'—'}). Both remain separate metadata · display-only.`; $('doa-polar').setAttribute('aria-label',`Polar DoA. Canonical source angle ${angle.toFixed(1)} degrees. Plotted 360-bin peak display angle ${displayAngle===null?'unavailable':displayAngle.toFixed(0)+' degrees, bin '+peakIndex}. Display-only.`);
  $('inspector-angle').textContent=`${angle.toFixed(1)}°`; $('inspector-display-peak').textContent=peakLabel; $('inspector-peak-db').textContent=Number.isFinite(Number(csv.angular_peak_db))?`${Number(csv.angular_peak_db).toFixed(1)} dB`:'—'; $('inspector-bins').textContent=String(values.length); $('inspector-freshness').textContent=formatAge(csv.freshness); $('inspector-angle-note').innerHTML='canonical source<br>not authority'; $('inspector-provenance').textContent=`CSV native view · ${settings.figType} display axis · source vector preserved as shifted dB.`;
}
function finiteCoordinate(value, lower, upper) { const number=Number(value); return Number.isFinite(number)&&number>=lower&&number<=upper; }
function coordinateFromCandidate(candidate,label) {
  if(!candidate||candidate.available!==true) return null; const latitude=Number(candidate.latitude), longitude=Number(candidate.longitude);
  if(!finiteCoordinate(latitude,-90,90)||!finiteCoordinate(longitude,-180,180)) return null;
  // 0/0 is the common unset/Null-Island placeholder in this contract. Never map it as a live position.
  if(latitude===0&&longitude===0) return null;
  return { latitude, longitude, source: label };
}
function renderMap(snapshot,csv,xml) {
  const gpsStatus=String(snapshot?.status?.safe?.gps_status||'').trim().toLowerCase(); const gpsDisabled=['disabled','off','none','unavailable','not fixed','no fix'].includes(gpsStatus); const freshnessReady=candidate=>candidate?.available===true&&candidate?.freshness?.fresh===true&&typeof candidate.freshness.age_ms==='number'&&Number.isFinite(candidate.freshness.age_ms)&&candidate.freshness.age_ms>=0; const csvCoordinate=!gpsDisabled&&freshnessReady(csv)?coordinateFromCandidate(csv,'CSV'):null; const xmlCoordinate=!gpsDisabled&&freshnessReady(xml)?coordinateFromCandidate(xml,'XML'):null; const coordinateConflict=csvCoordinate&&xmlCoordinate&&(Math.abs(csvCoordinate.latitude-xmlCoordinate.latitude)>1e-7||Math.abs(csvCoordinate.longitude-xmlCoordinate.longitude)>1e-7); const coordinate=coordinateConflict?null:(csvCoordinate||xmlCoordinate); const panel=$('map-panel'); const chip=$('map-state-chip');
  if(!coordinate){
    const reason=coordinateConflict?'CSV / XML coordinate conflict: map held until views agree.':(gpsDisabled?'No live coordinate fix: GPS is disabled; 0/0 is treated as unset.':'No fresh, valid, mutually consistent latitude / longitude fields in the current snapshot.'); panel.dataset.mapState='unavailable'; chip.textContent=coordinateConflict?'CONFLICT':'NOT CONFIGURED'; chip.className=`state-chip ${coordinateConflict?'bad':'warn'}`; $('map-status-title').textContent=coordinateConflict?'MAP HELD · COORDINATE CONFLICT':'MAP NOT CONFIGURED'; $('map-status-copy').textContent=coordinateConflict?'WAITING FOR CONSISTENT COORDINATES':'WAITING FOR FRESH COORDINATES'; $('map-state-badge').textContent=coordinateConflict?'UNAVAILABLE · COORDINATE CONFLICT':'UNAVAILABLE · NO POSITION FIX'; $('map-state-badge').className=`map-state-badge ${coordinateConflict?'conflict':'unavailable'}`; $('map-coordinates').textContent=reason; $('map-source').textContent=coordinateConflict?'CONFLICT':'NOT PRESENT'; $('map-view').textContent='OSM / READINESS'; $('map-attribution').textContent='© OpenStreetMap contributors · raster tiles intentionally not loaded until fresh, consistent coordinates are valid.'; $('map-viewport').setAttribute('aria-label',coordinateConflict?'OSM-ready map held because CSV and XML coordinates conflict':'OSM-ready map unavailable until fresh valid coordinates are present'); return;
  }
  panel.dataset.mapState='ready'; chip.textContent='COORDINATES AVAILABLE'; chip.className='state-chip good'; $('map-status-title').textContent='COORDINATES AVAILABLE'; $('map-status-copy').textContent='OSM READY · NO TILE REQUEST'; $('map-state-badge').textContent='REAL COORDINATES · NO MARKER'; $('map-state-badge').className='map-state-badge ready'; $('map-coordinates').textContent=`${coordinate.latitude.toFixed(5)}°, ${coordinate.longitude.toFixed(5)}° · ${coordinate.source} fields · fresh`; $('map-source').textContent=`${coordinate.source} LAT / LON`; $('map-view').textContent='OSM / SHELL READY'; $('map-attribution').textContent='© OpenStreetMap contributors · shell is ready; no synthetic marker or track overlay is rendered.'; $('map-viewport').setAttribute('aria-label',`OSM-ready map shell with fresh real ${coordinate.source} coordinate fields; no marker rendered.`);
}
function renderHealthCards(snapshot,csv,xml,consistency) {
  const status=snapshot.status||{}; const safe=status.safe||{}; const daq=status.daq_health||'UNKNOWN'; const daqStatus=safe.daq_status||{}; const sync=[daqStatus.frame_sync,daqStatus.sample_delay_sync,daqStatus.iq_sync].filter(value=>value===true).length; setHealthCard('health-daq',daq,`sync ${sync}/3 · dropped ${safe.daq_num_dropped_frames??'—'}`,daq==='PASS'?'good':(daq==='FAIL'?'bad':'warn'));
  const doaReady=Boolean(csv.available&&xml.available&&csv.freshness?.fresh===true&&xml.freshness?.fresh===true&&consistency.comparable===true&&!consistency.conflict); setHealthCard('health-doa',doaReady?'AVAILABLE':'DEGRADED',doaReady?'CSV + XML correlated':'freshness / correlation gate',doaReady?'good':'warn');
  const clockReady=status.freshness?.fresh===true; setHealthCard('health-clock',clockReady?'VERIFIED':'UNVERIFIED',status.freshness?formatAge(status.freshness):'remote clock basis',clockReady?'good':'warn');
}
function renderEvents(snapshot,gate,consistency) {
  const time=new Date().toISOString().slice(11,16)+'Z'; const overall=snapshot.overall_state||'UNKNOWN'; const gateState=String(gate.state||'BLOCKED').toUpperCase(); const relation=consistency.conflict?'CONFLICT':(consistency.comparable?'CORRELATED':'NOT COMPARABLE'); const items=[['SNAPSHOT',`${overall} · Data Out read complete`],['DOA VIEWS',`${relation} · CSV / XML kept separate`],['DELIVERY',`${gateState} · publish path disabled`]]; (gate.reasons||[]).slice(0,3).forEach(reason=>items.push(['GATE',reasonLabel(reason)])); $('event-log-state').textContent=`${items.length} EVENTS`; $('event-log').innerHTML=items.map(([label,copy])=>`<li><span class="event-time">${esc(time)}</span><span class="event-copy"><strong>${esc(label)}</strong><span>${esc(copy)}</span></span></li>`).join('');
}
function signalRows(candidates) {
  const available=candidates.filter(item=>item.candidate?.available===true); if(!available.length) return '<tr><td colspan="5" class="panel-empty">No parsed signal record. Waiting for a valid Data Out snapshot.</td></tr>';
  return available.map(({label,candidate})=>{ const fresh=candidate.freshness?.fresh===true; const doa=Number.isFinite(Number(candidate.canonical_angle_deg))?`${Number(candidate.canonical_angle_deg).toFixed(1)}°`:'—'; const frequency=candidate.frequency_hz_normalized!==undefined?`${esc(candidate.frequency_hz_normalized)} Hz`:'—'; return `<tr><th scope="row">${esc(label)}</th><td>${esc(doa)}<br><span class="help">canonical θ₀</span></td><td>${frequency}</td><td>${esc(formatAge(candidate.freshness))}</td><td>${pill(fresh?'READY':'STALE')}</td></tr>`; }).join('');
}
function setSnapshotUnavailable(reason='snapshot unavailable') {
  const detail=String(reason||'snapshot unavailable'); const stamp=new Date().toISOString().slice(11,19)+'Z'; state.snapshot=null;
  $('last-read-chip').textContent='STALE'; $('last-read-chip').className='bad'; $('system-state').textContent='STALE'; $('system-state').className='bad'; $('overall').textContent='STALE'; $('overall').className='metric-value bad'; $('overall-detail').textContent=`snapshot unavailable · ${detail}`;
  $('daq').textContent='STALE'; $('daq').className='metric-value bad'; $('daq-detail').textContent='snapshot unavailable'; $('doa-age').textContent='—'; $('doa-age').className='metric-value bad'; $('doa-detail').textContent='CSV / XML unavailable'; $('drops').textContent='—'; $('drops').className='metric-value bad'; $('drops-detail').textContent='snapshot unavailable';
  $('delivery-summary').textContent='BLOCKED'; $('delivery-summary').className='metric-value bad'; $('delivery-state').textContent='BLOCKED'; $('delivery-state').className='bad'; $('delivery-detail').textContent='publish held'; $('gate-title').textContent='BLOCKED'; $('gate-pill').innerHTML=pill('BLOCKED'); $('gate-banner').className='gate-banner'; $('gate-copy').textContent='Snapshot is stale; delivery remains held.'; $('gate-count').textContent='1 GATE'; $('gate-reasons').innerHTML=`<li><span>Snapshot unavailable</span><small class="mono">${esc(detail)}</small></li>`; $('gate-debug').textContent=JSON.stringify({state:'BLOCKED',reasons:[detail]},null,2);
  $('signal-contract-state').textContent='STALE · NO SNAPSHOT'; $('doa-rows').innerHTML=`<tr><td colspan="5" class="panel-empty">Snapshot unavailable. Previous signal rows cleared.</td></tr>`; $('source-rows').innerHTML=`<tr><td colspan="2" class="panel-empty">Snapshot unavailable. Previous native views cleared.</td></tr>`; $('status-rows').innerHTML=`<tr><td colspan="2" class="panel-empty">Snapshot unavailable. Previous node health cleared.</td></tr>`; $('settings-rows').innerHTML=`<tr><td colspan="2" class="panel-empty">Snapshot unavailable. Previous settings cleared.</td></tr>`;
  setHealthCard('health-daq','STALE','snapshot unavailable','bad'); setHealthCard('health-doa','STALE','snapshot unavailable','bad'); setHealthCard('health-clock','STALE','snapshot unavailable','bad'); $('event-log-state').textContent='STALE'; $('event-log').innerHTML=`<li><span class="event-time">${esc(stamp)}</span><span class="event-copy"><strong>SNAPSHOT</strong><span>Unavailable · previous telemetry cleared</span></span></li>`;
  setPolarUnavailable(`Snapshot unavailable: ${detail}`); renderMap({}, {}, {}); $('map-state-chip').textContent='STALE'; $('map-state-chip').className='state-chip bad'; $('map-status-title').textContent='MAP DATA STALE'; $('map-status-copy').textContent='WAITING FOR FRESH SNAPSHOT'; $('map-state-badge').textContent='STALE · NO POSITION FIX'; $('map-state-badge').className='map-state-badge unavailable'; $('map-coordinates').textContent='Previous map coordinates cleared after read failure.'; $('map-attribution').textContent='© OpenStreetMap contributors · raster tiles remain unloaded.';
}
function render(snapshot) {
  state.snapshot=snapshot; const gate=snapshot.publication_gate||{}; const status=snapshot.status||{}; const safe=status.safe||{}; const csv=(snapshot.doa_candidates||{}).csv||{}; const xml=(snapshot.doa_candidates||{}).xml||{}; const consistency=snapshot.native_consistency||{}; const authority=snapshot.authority||{};
  const overall=snapshot.overall_state||'UNKNOWN'; $('overall').textContent=overall; $('overall').className=`metric-value ${kind(overall)}`; $('system-state').textContent=overall; $('system-state').className=kind(overall); $('overall-detail').textContent=`DAQ ${status.daq_health||'—'} · native DoA ${csv.native_metrics_state||'—'} · delivery ${gate.state||'—'}`;
  const collectedAt=Number(snapshot.collection?.collected_at_ms); const readAt=new Date(Number.isFinite(collectedAt)&&collectedAt>0?collectedAt:Date.now()); $('last-read-chip').textContent=readAt.toISOString().slice(11,19)+'Z'; $('source-url').textContent=snapshot.collector?.base_url||state.dataUrl;
  const daq=status.daq_health||'UNKNOWN'; const daqTop=safe.daq_status||{}; const syncFlags=[daqTop.frame_sync,daqTop.sample_delay_sync,daqTop.iq_sync]; const syncPassed=syncFlags.filter(value=>value===true).length; $('daq').textContent=daq; $('daq').className=`metric-value ${kind(daq)}`; $('daq-detail').textContent=`frame #${daqTop.data_frame_index??'—'} · sync ${syncPassed}/3`;
  const freshnessItems=[csv.freshness,xml.freshness].filter(Boolean); const ages=freshnessItems.map(x=>x.age_ms); const validAges=ages.length===2&&ages.every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0); const maxAge=validAges?Math.max(...ages)+servedAgeMs(snapshot):null; const freshnessOk=validAges&&freshnessItems.every(x=>x.fresh===true); $('doa-age').textContent=maxAge===null?'—':`${(Number(maxAge)/1000).toFixed(1)} s`; $('doa-age').className=`metric-value ${freshnessOk&&maxAge<=5000?'good':'bad'}`; const relation=consistency.conflict===true?'CONFLICT':(consistency.comparable===true?(typeof consistency.circular_distance_deg==='number'&&consistency.circular_distance_deg<=3?'EQUAL':'DIFFERENT'):'NOT COMPARABLE'); $('doa-detail').textContent=`CSV ${formatNumber(csv.canonical_angle_deg,1)}° / XML ${formatNumber(xml.canonical_angle_deg,1)}° · ${relation}`;
  const drops=safe.daq_num_dropped_frames; $('drops').textContent=drops===undefined?'—':drops; $('drops').className=`metric-value ${drops===0?'good':'warn'}`; $('drops-detail').textContent='status.json counter';
  const dataAvailable=Boolean(csv.available&&xml.available&&csv.freshness?.fresh&&xml.freshness?.fresh&&consistency.comparable===true&&consistency.conflict!==true); const gateState=String(gate.state||'BLOCKED').toUpperCase(); $('delivery-summary').textContent=gateState; $('delivery-summary').className=`metric-value ${kind(gateState)}`; $('delivery-state').textContent=gateState; $('delivery-state').className=kind(gateState); $('delivery-detail').textContent=gateState==='READY'?'delivery ready':'publish held'; $('gate-title').textContent=gateState; $('gate-pill').innerHTML=pill(gateState); $('gate-banner').className=`gate-banner ${gateState==='READY'?'good':''}`; $('gate-copy').textContent=gateState==='READY'?'Delivery gate is ready.':(dataAvailable?'DoA data is observable; delivery remains held by the publication gate.':'DoA data is not sufficiently fresh or consistent for usable delivery.');
  renderPolar(snapshot,csv,dataAvailable); renderMap(snapshot,csv,xml); renderHealthCards(snapshot,csv,xml,consistency); renderEvents(snapshot,gate,consistency);
  const reasons=gate.reasons||[]; $('gate-count').textContent=`${reasons.length} GATES`; $('gate-reasons').innerHTML=reasons.length?reasons.map(reason=>`<li><span>${esc(reasonLabel(reason))}</span><small class="mono">${esc(reason)}</small></li>`).join(''):'<li>No active gate reasons.</li>'; $('gate-debug').textContent=JSON.stringify({state:gateState,checks:gate.checks||{},reasons},null,2);
  const candidates=[{label:'CSV',candidate:csv},{label:'XML',candidate:xml}]; $('doa-rows').innerHTML=signalRows(candidates); $('signal-contract-state').textContent=`${candidates.filter(item=>item.candidate?.available===true).length}/2 NATIVE VIEWS`;
  const sourceRow=(label,candidate)=>[['Source',`${esc(label)} · ${candidate.available?pill('PARSED'):pill('UNAVAILABLE')}`],['  raw angle',candidate.available?`${formatNumber(candidate.doa_raw_deg,1)}° <span class="muted">(${esc(candidate.angle_convention||'native')})</span>`:'—'],['  canonical angle',candidate.available?`${formatNumber(candidate.canonical_angle_deg,1)}° <span class="muted">(${esc(candidate.canonical_angle_convention||'—')})</span>`:'—'],['  freshness',candidate.available?`${formatAge(candidate.freshness)} · ${candidate.freshness?.fresh===true?'fresh':'not fresh'}`:'—'],['  PAPR native',candidate.available?`${formatNumber(candidate.confidence_metric_db,3)} dB · ${candidate.confidence_metric_valid?'valid':'invalid'}`:'—'],['  power native',candidate.available?`${formatNumber(candidate.power_native_db,2)} dB · ${candidate.power_native_valid?'valid':'invalid'}`:'—'],['  frequency',candidate.available?`${esc(candidate.frequency_hz_normalized??'—')} Hz`:'—'],['  contract mapping',candidate.available?`${esc(candidate.contract_mapping_state||'—')} · ${esc((candidate.unit_reasons||[]).join(', ')||'—')}`:'—']];
  $('source-rows').innerHTML=rows([['Publication',pill(gateState)],['Native correlation',consistency.comparable?`${consistency.same_timestamp?'same timestamp':'adjacent frames, angles not cross-checked'} · canonical delta ${formatNumber(consistency.circular_distance_deg,1)}°`:'not comparable'],...sourceRow('CSV',csv),...sourceRow('XML',xml),['Authority',esc(authority.selected||'none')],['Canonical angle gate',authority.canonical_angle_ready?'ready':'not approved'],['Contract confidence',authority.selected_doa?.confidence===null?'not mapped to 0–1':esc(authority.selected_doa?.confidence??'—')],['Gate note',esc((gate.reasons||[]).map(reasonLabel).join(' · ')||'—')]]);
  const daqStatus=safe.daq_status||{}; $('status-rows').innerHTML=rows([['DAQ',pill(daq)],['daq_ok',boolLabel(safe.daq_ok)],['Frame index',esc(daqStatus.data_frame_index)],['Frame sync',boolLabel(daqStatus.frame_sync)],['Sample-delay sync',boolLabel(daqStatus.sample_delay_sync)],['IQ sync',boolLabel(daqStatus.iq_sync)],['ADC overdrive',boolLabel(daqStatus.adc_overdrive)],['Dropped frames',esc(safe.daq_num_dropped_frames)],['Sampling',esc(daqStatus.sampling_frequency_hz?`${daqStatus.sampling_frequency_hz} Hz`:'—')],['Station',esc(safe.station_id)],['Software',esc(safe.software_version)],['Source hash',esc(safe.software_git_short_hash)],['GPS',esc(safe.gps_status)]]);
  const settings=snapshot.settings||{}; const sf=settings.fields||{}; $('settings-rows').innerHTML=Object.keys(sf).sort().map(key=>[key,safeValue(sf[key])]).map(([key,value])=>`<tr><th>${esc(key)}</th><td>${value}</td></tr>`).join('')||'<tr><td colspan="2">Not available</td></tr>';
  setReadStatus(`Snapshot read successfully · ${readAt.toISOString().slice(11,19)}Z`,'good');
}
async function refreshMqtt() { const sequence=++state.mqttSequence; try { const r=await fetch('/api/mqtt',{cache:'no-store'}); const payload=await r.json(); if(sequence!==state.mqttSequence) return; renderMqtt(payload); } catch(e) { if(sequence!==state.mqttSequence) return; renderMqtt({enabled:true,connection:'error',last_error:'monitor unavailable',host:'?',port:'?',received:0,valid:0,invalid:0,cleared:0,last_age_ms:null}); } }
const REQUEST_TIMEOUT_MS=8000;
function localExpiryMs(snapshot) {
  // Same rule as the React console: the read keeps only the time still left in the collector's freshness window.
  if(snapshot?.status?.available!==true) return 0; const windows=[];
  for(const candidate of Object.values(snapshot.doa_candidates||{})){ const f=candidate?.freshness; if(!f||typeof f!=='object'||f.freshness_known===false) continue; if(f.fresh!==true) return 0; const maxAge=Number(f.max_age_ms); const age=Number(f.age_ms); if(!Number.isFinite(maxAge)||!Number.isFinite(age)||age<0) return 0; windows.push(maxAge-age); }
  // A shared read can be older than the answer (collection.age_ms); that time counts too.
  const waited=servedAgeMs(snapshot);
  return windows.length?Math.max(0,Math.min(...windows)-waited):Math.max(0,5000-waited);
}
// How long before the answer its shared Data Out read completed, as the React console bounds it.
function servedAgeMs(snapshot) { const served=Number(snapshot?.collection?.age_ms); return Number.isFinite(served)&&served>0?Math.min(served,120000):0; }
// A running auto-refresh follows the console's saved interval, which every answer reports, so this page polls when the console reads Data Out.
function followConsoleUrl(url) { if(typeof url!=='string'||!url||url.length>512) return false; url=url.replace(/\/+$/,''); if(url===state.dataUrl) return false; state.dataUrl=url; state.collectionId=null; $('data-url').value=url; $('source-url').textContent=url; setTimeout(()=>refresh(),0); return true; }
async function followSavedUrl() { try { const r=await fetch('/api/console-config',{cache:'no-store'}); if(r.ok) followConsoleUrl((await r.json())?.base_url); } catch(e) {} }
function followConsoleInterval(snapshot) { const seconds=snapshot?.collection?.refresh_seconds; if(!Number.isInteger(seconds)||seconds<0) return; state.consoleSeconds=seconds; if(state.autoTimer&&seconds>0&&seconds!==state.autoSeconds) setAuto(seconds,false); }
function scheduleLocalExpiry(snapshot) { if(state.expiryTimer){ clearTimeout(state.expiryTimer); state.expiryTimer=null; } const remaining=localExpiryMs(snapshot); if(remaining<=0) return; state.expiryTimer=setTimeout(()=>{ state.expiryTimer=null; if(state.snapshot!==snapshot) return; setSnapshotUnavailable('local freshness window expired; awaiting a new Data Out read'); setReadStatus('Data expired locally · awaiting a new read','bad'); },remaining); }
async function refresh(options) {
  const auto=options?.auto===true; const manual=options?.manual===true; if(auto&&state.refreshController) return;
  const sequence=++state.refreshSequence; if(state.refreshController) state.refreshController.abort(); const controller=typeof AbortController==='function'?new AbortController():null; state.refreshController=controller; const button=$('refresh'); button.disabled=true; setReadStatus('Reading Data Out…');
  let timedOut=false; const timer=controller?setTimeout(()=>{ timedOut=true; controller.abort(); },REQUEST_TIMEOUT_MS):null;
  try { const url='/api/snapshot?source=data_out&base_url='+encodeURIComponent(state.dataUrl)+(manual?'&refresh=1':'')+(state.collectionId?'&seen='+encodeURIComponent(state.collectionId):''); const init={cache:'no-store'}; if(controller) init.signal=controller.signal; const response=await fetch(url,init); const data=await response.json(); if(sequence!==state.refreshSequence) return; if(!response.ok){ if(data.code==='DATA_OUT_URL_NOT_ALLOWED') followSavedUrl(); throw new Error(data.error||'snapshot failed'); } const id=data.collection?.id; state.collectionId=typeof id==='string'&&/^[0-9a-f]{8}-[0-9]{1,12}$/.test(id)?id:null; render(data); scheduleLocalExpiry(data); followConsoleInterval(data); followConsoleUrl(data.collection?.console_base_url); }
  catch(error) { if(sequence!==state.refreshSequence||(error?.name==='AbortError'&&!timedOut)) return; const message=timedOut?`request timed out after ${REQUEST_TIMEOUT_MS/1000} s`:(error?.message||'snapshot failed'); setSnapshotUnavailable(message); setReadStatus('Read error: '+message,'bad'); }
  finally { if(timer) clearTimeout(timer); if(sequence===state.refreshSequence){ button.disabled=false; if(state.refreshController===controller) state.refreshController=null; } }
  if(sequence===state.refreshSequence) refreshMqtt();
}
function setAuto(seconds,readNow=true) { if(state.autoTimer){ clearInterval(state.autoTimer); state.autoTimer=null; } const interval=Number(seconds||0); state.autoSeconds=interval; $('refresh-interval').value=String(interval); if(interval>0){ if(readNow) refresh(); state.autoTimer=setInterval(()=>refresh({auto:true}),interval*1000); $('auto-refresh').textContent=`Auto: ${interval}s`; } else $('auto-refresh').textContent='Auto: off'; }
function openSettings(tab='connection') { $('settings-modal').hidden=false; selectTab(tab); }
function closeSettings() { $('settings-modal').hidden=true; }
function selectTab(name) { document.querySelectorAll('.tab').forEach(button=>button.classList.toggle('active',button.dataset.tab===name)); document.querySelectorAll('.tab-panel').forEach(panel=>panel.hidden=panel.id!==`tab-${name}`); }
async function applyConnection() { const url=$('data-url').value.trim(); const mqttHost=$('mqtt-host').value.trim(); const mqttPort=Number($('mqtt-port').value||9001); const refreshSeconds=Number($('refresh-interval').value||0); if(!url){ setStatus('connection-status','URL is empty.','bad'); return; } try { const r=await fetch('/api/console-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base_url:url,mqtt_host:mqttHost,mqtt_port:mqttPort,refresh_seconds:refreshSeconds})}); const data=await r.json(); if(!r.ok) throw new Error(data.error||'configuration rejected'); state.dataUrl=data.base_url; $('source-url').textContent=data.base_url; state.consoleSeconds=Number(data.refresh_seconds)||0; setAuto(data.refresh_seconds); setStatus('connection-status','Configuration saved locally in Ground Console.','good'); await refresh({manual:true}); } catch(e) { setStatus('connection-status',e.message,'bad'); } }
async function connectMqtt() { const host=$('mqtt-host').value.trim(); const port=Number($('mqtt-port').value||9001); if(!host){ setStatus('connection-status','Enter an MQTT broker IP address or localhost first.','bad'); return; } try { const r=await fetch(`/api/mqtt/connect?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}`,{method:'POST'}); const data=await r.json(); if(!r.ok) throw new Error(data.error||'MQTT monitor failed'); renderMqtt(data); setStatus('connection-status','MQTT monitor connected; this view only subscribes.','good'); setTimeout(refreshMqtt,700); } catch(e) { setStatus('connection-status',e.message,'bad'); } }
async function adminLogin() { const password=$('admin-password').value; try { const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})}); const data=await r.json(); if(!r.ok) throw new Error(data.error||'login failed'); $('admin-login-box').hidden=true; $('admin-workspace').hidden=false; $('admin-password').value=''; setStatus('brand-status','Admin active.','good'); renderBranding(state.branding); } catch(e) { setStatus('admin-login-status',e.message,'bad'); } }
async function adminLogout() { await fetch('/api/admin/logout',{method:'POST'}); $('admin-login-box').hidden=false; $('admin-workspace').hidden=true; setStatus('admin-login-status','Admin session closed.',''); }
function readLogo(file) { if(!file) return; if(file.size>256*1024){ setStatus('brand-status','Logo exceeds 256 KiB.','bad'); $('brand-logo').value=''; return; } const reader=new FileReader(); reader.onload=()=>{ state.pendingLogo=String(reader.result||''); $('brand-preview').src=state.pendingLogo; $('brand-preview').hidden=false; $('preview-placeholder').hidden=true; }; reader.onerror=()=>setStatus('brand-status','Logo could not be read.','bad'); reader.readAsDataURL(file); }
function resetLogo() { state.pendingLogo=''; $('brand-logo').value=''; $('brand-preview').hidden=true; $('preview-placeholder').hidden=false; setStatus('brand-status','Logo will be removed when saved.',''); }
async function saveBranding() { const appName=$('brand-name').value.trim(); const logo=state.pendingLogo===null?(state.branding?.logo_data_url||''):state.pendingLogo; try { const r=await fetch('/api/admin/branding',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_name:appName,logo_data_url:logo})}); const data=await r.json(); if(!r.ok) throw new Error(data.error||'branding save failed'); state.pendingLogo=null; const verify=await fetch('/api/branding',{cache:'no-store'}); const verified=await verify.json(); if(!verify.ok) throw new Error(verified.error||'branding read-back failed'); renderBranding(verified); setStatus('brand-status','Branding saved and verified from Ground Console local storage.','good'); } catch(e) { setStatus('brand-status',e.message,'bad'); } }
document.querySelectorAll('[data-nav]').forEach(item=>item.addEventListener('click',()=>{ document.querySelectorAll('.nav-item').forEach(nav=>nav.classList.toggle('active',nav===item)); document.querySelectorAll('.nav-item').forEach(nav=>nav.removeAttribute('aria-current')); item.setAttribute('aria-current','page'); }));
$('refresh').addEventListener('click',()=>refresh({manual:true})); $('auto-refresh').addEventListener('click',()=>setAuto(state.autoTimer?0:(state.consoleSeconds>0?state.consoleSeconds:2))); $('settings-open').addEventListener('click',()=>openSettings('connection')); $('settings-close').addEventListener('click',closeSettings); document.querySelector('[data-close-settings]').addEventListener('click',closeSettings); document.querySelectorAll('.tab').forEach(button=>button.addEventListener('click',()=>selectTab(button.dataset.tab))); $('apply-connection').addEventListener('click',applyConnection); $('monitor-connect').addEventListener('click',connectMqtt); $('admin-login').addEventListener('click',adminLogin); $('admin-logout').addEventListener('click',adminLogout); $('brand-logo').addEventListener('change',event=>readLogo(event.target.files[0])); $('brand-reset-logo').addEventListener('click',resetLogo); $('brand-save').addEventListener('click',saveBranding); document.addEventListener('keydown',event=>{if(event.key==='Escape')closeSettings();});
window.addEventListener('resize',()=>drawPolar(state.polar.values,state.polar.angle,state.polar.fresh,state.polar.figType,state.polar.compassOffset),{passive:true});
renderClock(); setInterval(renderClock,1000); loadBranding(); if (initialConfig && initialConfig.refresh_seconds > 0) setAuto(initialConfig.refresh_seconds); else refresh();
</script>
</body>
</html>
"""


def validate_config_patch(
    payload: Any,
    now_ms: Optional[int] = None,
    session: Optional[Dict[str, Any]] = None,
    node_id: str = DEFAULT_RDF_NODE_ID,
) -> Dict[str, Any]:
    """Validate a settings patch as Kontrol would send it, without sending it.

    The changes go through the RDF Node edge's own field rules
    (rdf_node_commands), and the preview is the config.patch envelope Kontrol
    would publish now: sid, boot and base_rev come from the node's latest
    state when the MQTT monitor has one (``session_known``), else they are
    null. Nothing is published, posted or written.
    """
    if not isinstance(payload, dict):
        raise ValueError("request must be a JSON object")
    if set(payload) - {"changes"}:
        raise ValueError("only changes is accepted; sid, boot and base_rev come from the node's state")
    try:
        changes = cmds.validate_patch_changes(payload.get("changes"))
    except cmds.CommandRefused as refused:
        raise ValueError(f"{refused.code}: {refused.message}") from refused
    issued = int(time.time() * 1000) if now_ms is None else int(now_ms)
    known = session is not None
    command = cmds.build_command(
        cmds.OP_CONFIG_PATCH,
        command_id="dryrun-" + uuid.uuid4().hex[:12],
        sid=session["sid"] if session else None,
        boot=session["boot"] if session else None,
        base_rev=_int_or_none(session.get("cfg")) if session else None,
        issued_ms=issued,
        changes=changes,
    )
    if known and command["base_rev"] is not None:
        try:
            cmds.validate_command(command, now_ms=issued)
        except cmds.CommandRefused as refused:
            raise ValueError(f"{refused.code}: {refused.message}") from refused
    return {
        "dry_run": True,
        "transport": "none",
        "applied": False,
        "ok": True,
        "validation": "passed",
        "contract": "RDF Node config.patch",
        "topic": cmds.command_topic(node_id, cmds.OP_CONFIG_PATCH),
        "session_known": known,
        "command": command,
        "note": "Preview only; no MQTT, HTTP POST, file write, or RDF-SDR mutation was performed.",
    }


def _header_values(headers: Any, name: str) -> List[str]:
    """Every value of one request header; none for an HTTP/0.9 request (Python 3.13 leaves a plain dict)."""
    get_all = getattr(headers, "get_all", None)
    if not callable(get_all):
        return []
    return [str(value) for value in get_all(name) or []]


class ConsoleHandler(BaseHTTPRequestHandler):
    server_version = "SDRDoAGroundConsole/0.2"

    def handle(self) -> None:  # noqa: D401
        """Treat a client disconnect during response write as normal."""
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep logs bounded and avoid echoing request bodies/settings.
        print("[ground-console] " + (fmt % args), flush=True)

    def log_request(self, code: Any = "-", size: Any = "-") -> None:
        # Docker and the launcher poll /api/health every few seconds; a healthy
        # answer would bury the service log. Failures are still logged.
        path = urlsplit(self.path).path
        status = str(getattr(code, "value", code))
        if path == "/api/health" and status == "200":
            return
        # A map view asks for dozens of tiles. A served tile is not logged, and
        # neither is a 504 for an uncached tile while the upstream is down: the
        # tile cache logs that outage once, when it starts and when it ends.
        if path.startswith(TILE_ROUTE_PREFIX) and status in {"200", "504"}:
            return
        # The Receiver mirror is posted and polled several times a second. A
        # served answer and a rate refusal are not logged (the mirror counts
        # refusals); every other refusal is.
        if path == rm.ROUTE and status in {"200", "429"}:
            return
        # A viewer polls its marker command's status while it waits; the
        # command itself (POST .../markers) is logged with the client address.
        if path.startswith(rm.MARKERS_ROUTE + "/") and status == "200":
            return
        super().log_request(code, size)

    @property
    def console_server(self) -> "GroundConsoleServer":
        return self.server  # type: ignore[return-value]

    def _send_json(
        self,
        payload: Dict[str, Any],
        status: int = HTTPStatus.OK,
        headers: Optional[Dict[str, str]] = None,
    ) -> None:
        body = json.dumps(payload, sort_keys=True, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if headers:
            for key, value in headers.items():
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, body: str) -> None:
        raw = body.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self, max_bytes: int = 16 * 1024) -> Any:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("request body length is invalid") from exc
        if length <= 0 or length > max_bytes:
            raise ValueError(f"request body must be between 1 and {max_bytes} bytes")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("request body is not valid JSON") from exc

    def _read_binary(self, max_bytes: int) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError as exc:
            raise ValueError("request body length is invalid") from exc
        if length < 1 or length > max_bytes:
            raise ValueError(f"request body must be between 1 and {max_bytes} bytes")
        payload = self.rfile.read(length)
        if len(payload) != length:
            raise ValueError("request body is incomplete")
        return payload

    def _read_optional_json(self) -> Any:
        if self.headers.get("Content-Length", "0") in {"", "0"}:
            return {}
        return self._read_json(4096)

    def _receiver_mutation_origin_is_valid(self) -> bool:
        origin_header = self.headers.get("Origin")
        host_header = self.headers.get("Host")
        if not origin_header or not host_header:
            return False
        try:
            origin = urlsplit(origin_header)
            target = urlsplit(f"http://{host_header}")
            origin_port = origin.port or 80
            target_port = target.port or 80
        except ValueError:
            return False
        origin_host = (origin.hostname or "").lower().rstrip(".")
        target_host = (target.hostname or "").lower().rstrip(".")
        expected_port = self.console_server.server_address[1]
        return (
            origin.scheme == "http"
            and origin.username is None
            and origin.password is None
            and not origin.path
            and not origin.query
            and not origin.fragment
            and target.username is None
            and target.password is None
            and not target.path
            and not target.query
            and not target.fragment
            and origin_host == target_host
            and _is_loopback_bind(origin_host)
            and origin_port == expected_port
            and target_port == expected_port
        )

    # Receiver mutations, the config-patch publish and SAME_ORIGIN_POST_PATHS
    # share this port-exact, same-origin loopback rule.
    _same_origin_loopback_request = _receiver_mutation_origin_is_valid

    def _send_config_patch_error(self, status: int, code: str, message: str, **extra: Any) -> None:
        self._send_json({**extra, "ok": False, "code": code, "error": message}, status)

    def _receiver_error(self, exc: Exception) -> None:
        if isinstance(exc, ReceiverConflictError):
            status = HTTPStatus.CONFLICT
        elif isinstance(exc, KeyError):
            status = HTTPStatus.NOT_FOUND
        elif isinstance(exc, ValueError):
            status = HTTPStatus.BAD_REQUEST
        else:
            status = HTTPStatus.INTERNAL_SERVER_ERROR
        if isinstance(exc, KeyError) and exc.args and isinstance(exc.args[0], str):
            message = exc.args[0]
        elif isinstance(exc, (sqlite3.Error, zlib.error)):
            message = f"Receiver storage error: {exc}"
        else:
            message = str(exc) or exc.__class__.__name__
        self._send_json({"error": message}, status)

    def _receiver_read_is_allowed(self) -> bool:
        """Receiver GETs come from this console's own pages only.

        Sec-Fetch-Site must be absent (curl, http.client, older browsers),
        "none" (a typed URL) or "same-origin", as for /api/tiles; another site
        or another localhost port (same-site) is refused. The Host must be a
        loopback name on this console's port, which also stops DNS rebinding:
        a rebinding page sends its own host name.
        """
        site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        if site not in ("", "none", "same-origin"):
            return False
        hosts = _header_values(self.headers, "Host")
        if len(hosts) != 1:
            return False
        host = hosts[0].strip()
        if not host or len(host) > 255:
            return False
        try:
            target = urlsplit(f"http://{host}")
            port = target.port or 80
        except ValueError:
            return False
        if target.username is not None or target.password is not None or target.path or target.query or target.fragment:
            return False
        hostname = (target.hostname or "").lower().rstrip(".")
        return bool(hostname) and _is_loopback_bind(hostname) and port == self.console_server.server_address[1]

    def _send_archive_error(self, status: int, code: str, message: str, **extra: Any) -> None:
        # Archive codes go through this helper, never the Kontrol error helper,
        # so the config-patch error-code contract does not count them.
        self._send_json({**extra, "ok": False, "code": code, "error": message}, status)

    def _archive_failure(self, exc: Exception) -> None:
        """Archive and extended settings routes: ArchiveError, then ValueError, KeyError, storage errors."""
        if isinstance(exc, ArchiveError):
            self._send_archive_error(exc.status, exc.code, exc.message, **exc.extra)
        elif isinstance(exc, ValueError):
            message = str(exc) or ra.ARCHIVE_ERROR_MESSAGES[ra.ARCHIVE_INVALID_REQUEST]
            self._send_archive_error(HTTPStatus.BAD_REQUEST, ra.ARCHIVE_INVALID_REQUEST, message[:200])
        elif isinstance(exc, KeyError):
            self._send_archive_error(HTTPStatus.NOT_FOUND, ra.ARCHIVE_NOT_FOUND, ra.ARCHIVE_ERROR_MESSAGES[ra.ARCHIVE_NOT_FOUND])
        else:
            self._send_archive_error(
                HTTPStatus.INTERNAL_SERVER_ERROR, ra.ARCHIVE_STORAGE_ERROR, ra.ARCHIVE_ERROR_MESSAGES[ra.ARCHIVE_STORAGE_ERROR],
            )

    def _stream_body(self, write: Callable[[], None]) -> None:
        """Streaming rule: called right after send_response and the headers are queued.

        A stalled or paused client is cut off by the write timeout, and once
        the status line has gone out no exception may produce a second
        response: the connection is closed and one line is logged.
        """
        try:
            self.connection.settimeout(ra.STREAM_WRITE_TIMEOUT_S)
            write()
        except Exception as exc:  # noqa: BLE001 - nothing may follow a started body
            self.close_connection = True
            print(f"[ground-console] receiver download aborted: {type(exc).__name__}", flush=True)

    @staticmethod
    def _archive_zone(time_zone: Any, utc_offset_minutes: Any) -> Tuple[Any, str, bool]:
        """(tzinfo, name, fallback) for file names; UTC without a zone."""
        if time_zone is None or time_zone == "":
            if utc_offset_minutes in (None, ""):
                return timezone.utc, "UTC", False
            # Only the browser's current offset: a fixed zone, marked as a fallback.
            minutes = _utc_offset_minutes(utc_offset_minutes)
            return timezone(timedelta(minutes=minutes)), "UTC", True
        zone, fallback = resolve_time_zone(time_zone, utc_offset_minutes)
        return zone, str(time_zone), fallback

    def _archive_get(self, parsed: Any) -> None:
        path = parsed.path
        store = self.console_server.receiver_store
        query = parse_qs(parsed.query, keep_blank_values=False)

        def first(key: str) -> Optional[str]:
            values = query.get(key)
            return values[0] if values else None

        parts = path.strip("/").split("/")[3:]
        if parts == ["facets"]:
            self._send_json(store.archive_facets())
        elif parts == ["calendar"]:
            bounds = ra.parse_calendar_bounds(first("bounds"))
            self._send_json(store.archive_calendar(bounds, ra.parse_calendar_type(first("type"))))
        elif parts == ["timeline"]:
            from_ms, to_ms, archive_filter = ra.parse_timeline_query(query)
            self._send_json(store.archive_timeline(from_ms, to_ms, archive_filter))
        elif parts == ["items"]:
            archive_filter = ra.parse_filter_query(query)
            sort, order, offset, limit = ra.parse_paging_query(query)
            self._send_json(store.archive_items(archive_filter, sort, order, offset, limit))
        elif parts == ["retention-preview"]:
            self._send_json(store.retention_preview(ra.parse_retention_query(first("days"))))
        elif len(parts) == 3 and parts[0] == "scans" and parts[2] == "preview":
            self._send_json(store.archive_scan_preview(ra.parse_item_id(parts[1])))
        elif len(parts) == 3 and parts[0] == "audio" and parts[2] == "download":
            self._archive_audio_download(ra.parse_item_id(parts[1]), first("time_zone"), first("utc_offset_minutes"))
        elif len(parts) == 3 and parts[0] == "scans" and parts[2] == "download":
            self._archive_scan_download(ra.parse_item_id(parts[1]), first("time_zone"), first("utc_offset_minutes"))
        elif len(parts) == 2 and parts[0] == "exports":
            self._archive_export_download(parts[1])
        else:
            raise ArchiveError(HTTPStatus.NOT_FOUND, ra.ARCHIVE_NOT_FOUND, "unknown Receiver archive route")

    def _archive_audio_download(self, segment_id: str, time_zone: Any, utc_offset_minutes: Any) -> None:
        """GET archive/audio/<id>/download: the stored .webm as an attachment, never a Range."""
        store = self.console_server.receiver_store
        zone, _, _ = self._archive_zone(time_zone, utc_offset_minutes)
        item = store.archive_audio_entry(segment_id)
        if not item["downloadable"]:
            raise ArchiveError(HTTPStatus.NOT_FOUND, ra.ARCHIVE_FILE_MISSING)
        try:
            audio_path, _content_type = store.get_segment_audio(segment_id)
            source = audio_path.open("rb")
        except (KeyError, OSError) as exc:
            raise ArchiveError(HTTPStatus.NOT_FOUND, ra.ARCHIVE_FILE_MISSING) from exc
        with source:
            size = os.fstat(source.fileno()).st_size
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "audio/webm")
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", f'attachment; filename="{ra.audio_download_name(item, zone)}"')
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")

            def write() -> None:
                self.end_headers()
                remaining = size
                while remaining > 0:
                    chunk = source.read(min(ra.STREAM_CHUNK_BYTES, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)

            self._stream_body(write)

    def _archive_scan_download(self, scan_id: str, time_zone: Any, utc_offset_minutes: Any,
                               slots: Optional[threading.BoundedSemaphore] = None) -> None:
        """GET archive/scans/<id>/download: one scan's ZIP in one of ``slots`` (the console's two by default)."""
        store = self.console_server.receiver_store
        zone, zone_name, fallback = self._archive_zone(time_zone, utc_offset_minutes)
        scan = store.archive_scan_entry(scan_id)
        if not scan["downloadable"]:
            raise ArchiveError(HTTPStatus.NOT_FOUND, ra.ARCHIVE_NOT_FOUND)
        if slots is None:
            slots = self.console_server.archive_export_slots
        if not slots.acquire(blocking=False):
            raise ArchiveError(HTTPStatus.SERVICE_UNAVAILABLE, ra.ARCHIVE_EXPORT_BUSY)
        try:
            self._stream_zip((("scan", scan_id),), zone, zone_name, fallback, ra.scan_download_name(scan, zone), ())
        finally:
            slots.release()

    def _archive_export_download(self, token: str) -> None:
        """GET archive/exports/<id>: a prepared ZIP, once; the slot is taken before the token."""
        if not ra.EXPORT_ID_RE.fullmatch(token):
            raise ArchiveError(HTTPStatus.NOT_FOUND, ra.ARCHIVE_NOT_FOUND, "this download expired or was used; prepare it again")
        slots = self.console_server.archive_export_slots
        if not slots.acquire(blocking=False):
            raise ArchiveError(HTTPStatus.SERVICE_UNAVAILABLE, ra.ARCHIVE_EXPORT_BUSY)
        try:
            export = self.console_server.archive_exports.take(token)
            if export is None:
                raise ArchiveError(HTTPStatus.NOT_FOUND, ra.ARCHIVE_NOT_FOUND, "this download expired or was used; prepare it again")
            self._stream_zip(export.entries, export.zone, export.time_zone_name, export.time_zone_fallback,
                             export.filename, export.missing)
        finally:
            slots.release()

    def _stream_zip(self, entries: Sequence[Tuple[str, str]], zone: Any, zone_name: str, fallback: bool,
                    filename: str, missing: Sequence[Dict[str, Any]]) -> None:
        """A streamed ZIP. HTTP/1.1 gets chunked framing on this handler only, then the connection closes."""
        chunked = self.request_version == "HTTP/1.1"
        if chunked:
            # The class stays HTTP/1.0; this response alone is HTTP/1.1, so a
            # broken stream (no final 0-chunk) shows as a failed download.
            self.protocol_version = "HTTP/1.1"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if chunked:
            self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Connection", "close")
        server = self.console_server

        def write() -> None:
            self.end_headers()
            writer = ra.ChunkedWriter(self.wfile, chunked=chunked)
            try:
                ra.write_archive_zip(
                    server.receiver_store, entries, writer, zone,
                    time_zone_name=zone_name, time_zone_fallback=fallback, console_version=server.version,
                    created_ms=server.receiver_store._now_ms(), missing=missing,
                )
                writer.finish()
            except BaseException:
                writer.abort()
                raise

        self._stream_body(write)

    def _archive_post(self, parsed: Any) -> None:
        server = self.console_server
        store = server.receiver_store
        parts = parsed.path.strip("/").split("/")[3:]
        if parts == ["exports"]:
            payload = self._read_json(ra.SELECTION_BODY_MAX_BYTES)
            selection = ra.parse_selection(payload, ra.EXPORT_MAX_ITEMS)
            zone, zone_name, fallback = self._archive_zone(selection.time_zone, selection.utc_offset_minutes)
            rows, missing, total = store.resolve_selection(selection, ra.EXPORT_MAX_ITEMS, downloadable_only=True)
            if selection.items is not None and total == 0:
                raise ArchiveError(HTTPStatus.NOT_FOUND, ra.ARCHIVE_NOT_FOUND)
            if not rows:
                raise ArchiveError(HTTPStatus.NOT_FOUND, ra.ARCHIVE_FILE_MISSING, "nothing in this selection can be downloaded")
            estimate = sum(int(row["estimated_bytes"]) for row in rows)
            if estimate > ra.EXPORT_MAX_BYTES:
                raise ArchiveError(
                    HTTPStatus.REQUEST_ENTITY_TOO_LARGE, ra.ARCHIVE_EXPORT_TOO_LARGE,
                    f"the selection is estimated above {ra.EXPORT_MAX_BYTES} bytes",
                    estimated_bytes=estimate, limit_bytes=ra.EXPORT_MAX_BYTES,
                )
            # Advisory: the download itself takes the slot.
            if not server.archive_export_slots.acquire(blocking=False):
                raise ArchiveError(HTTPStatus.SERVICE_UNAVAILABLE, ra.ARCHIVE_EXPORT_BUSY)
            server.archive_export_slots.release()
            filename = ra.selection_download_name(store._now_ms(), zone)
            token = server.archive_exports.create(ra.PendingExport(
                entries=tuple((row["kind"], row["id"]) for row in rows), zone=zone, time_zone_name=zone_name,
                time_zone_fallback=fallback, filename=filename, missing=tuple(missing),
            ))
            missing_count = len(missing) if selection.items is not None else total - len(rows)
            self._send_json({
                "export_id": token,
                "url": f"/api/receiver/archive/exports/{token}",
                "filename": filename,
                "count": {
                    "audio": sum(1 for row in rows if row["kind"] == "audio"),
                    "scan": sum(1 for row in rows if row["kind"] == "scan"),
                },
                "missing": missing_count,
                "estimated_bytes": estimate,
                "expires_in_s": int(server.archive_exports.ttl_s),
            }, HTTPStatus.CREATED)
        elif parts == ["delete"]:
            payload = self._read_json(ra.SELECTION_BODY_MAX_BYTES)
            selection = ra.parse_selection(payload, ra.DELETE_MAX_ITEMS)
            if selection.time_zone is not None or selection.utc_offset_minutes is not None:
                self._archive_zone(selection.time_zone, selection.utc_offset_minutes)
            rows, missing, _ = store.resolve_selection(selection, ra.DELETE_MAX_ITEMS)
            entries = [(row["kind"], row["id"]) for row in rows] + [(item["kind"], item["id"]) for item in missing]
            self._send_json(store.archive_delete(entries))
        else:
            raise ArchiveError(HTTPStatus.NOT_FOUND, ra.ARCHIVE_NOT_FOUND, "unknown Receiver archive route")

    def _receiver_settings_post(self) -> None:
        """POST settings: a confirmed new retention value runs one pass here, with a time budget."""
        server = self.console_server
        store = server.receiver_store
        payload = self._read_json(ra.SETTINGS_BODY_MAX_BYTES)
        try:
            settings, changed = store.save_settings(payload)
        except ArchiveError as exc:
            self._archive_failure(exc)
            return
        if changed:
            result = store.apply_retention(budget_s=ra.RETENTION_SYNC_BUDGET_S)
            settings = store.get_settings()
            if result is None:
                server.wake_retention()
                settings["retention_running"] = True
            else:
                if result.get("more"):
                    server.wake_retention()
                    settings["retention_running"] = True
                settings["retention_result"] = result
        self._send_json(settings)

    def _receiver_segment_audio(self, segment_id: str) -> None:
        """GET audio-segments/<id>/audio: a stored segment for playback, with Range.

        The file is opened before it is sized, so a delete or a retention pass
        that removes it after the store's check is a missing file (KeyError),
        never an OSError naming its path.
        """
        audio_path, content_type = self.console_server.receiver_store.get_segment_audio(segment_id)
        try:
            source = audio_path.open("rb")
        except OSError as exc:
            raise KeyError("audio file not found") from exc
        with source:
            size = os.fstat(source.fileno()).st_size
            range_header = self.headers.get("Range")
            byte_range = _parse_audio_byte_range(range_header, size) if range_header else None
            if range_header and byte_range is None:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", "0")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            start, end = byte_range if byte_range is not None else (0, size - 1)
            content_length = max(0, end - start + 1)
            self.send_response(HTTPStatus.PARTIAL_CONTENT if byte_range is not None else HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(content_length))
            self.send_header("Accept-Ranges", "bytes")
            if byte_range is not None:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")

            def write() -> None:
                # A paused <audio> reconnects with Range after the write timeout.
                self.end_headers()
                source.seek(start)
                remaining = content_length
                while remaining:
                    chunk = source.read(min(ra.STREAM_CHUNK_BYTES, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)

            self._stream_body(write)

    def _receiver_get(self, parsed: Any) -> bool:
        if not self._receiver_read_is_allowed():
            self._send_archive_error(HTTPStatus.FORBIDDEN, ra.ORIGIN_REJECTED, ra.READ_REJECTED_MESSAGE)
            return True
        path = parsed.path
        store = self.console_server.receiver_store
        query = parse_qs(parsed.query, keep_blank_values=False)
        if path.startswith("/api/receiver/archive/"):
            try:
                self._archive_get(parsed)
            except (BrokenPipeError, ConnectionResetError):
                raise
            except (ArchiveError, ValueError, KeyError, OSError, sqlite3.Error, zlib.error) as exc:
                self._archive_failure(exc)
            return True
        try:
            if path == "/api/receiver/settings":
                self._send_json(store.get_settings())
            elif path == "/api/receiver/audio-facets":
                self._send_json(store.audio_record_facets(
                    query.get("time_zone", [None])[0],
                    query.get("utc_offset_minutes", [None])[0],
                ))
            elif path == "/api/receiver/records":
                offset = _query_int(query, "offset", 0)
                limit = _query_int(query, "limit", 100)
                record_type = query.get("type", [None])[0]
                if record_type == "audio-session":
                    audio_filter_keys = (
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
                    )
                    audio_filters = {key: query[key][0] for key in audio_filter_keys if key in query}
                    result = store.list_audio_records(offset, limit, audio_filters)
                else:
                    result = store.list_records(offset, limit, record_type)
                self._send_json(result)
            elif path == "/api/receiver/marker-sets":
                self._send_json({"items": store.get_markers()})
            else:
                parts = path.strip("/").split("/")
                if len(parts) == 4 and parts[:3] == ["api", "receiver", "scans"]:
                    self._send_json(store.scan_info(parts[3]))
                elif len(parts) == 5 and parts[:3] == ["api", "receiver", "scans"] and parts[4] == "candidates":
                    params = {
                        "offset": _query_int(query, "offset", 0),
                        "limit": _query_int(query, "limit", 100),
                        "sort": query.get("sort", ["frequency"])[0],
                        "minimum_peak_db": _query_float(query, "minimum_peak_db"),
                        "marked_only": _query_bool(query, "marked_only", False),
                        "marker_set_id": query.get("marker_set_id", [None])[0],
                        "group_adjacent": _query_bool(query, "group_adjacent", False),
                    }
                    nearby = _query_float(query, "near_frequency_hz")
                    if nearby is not None:
                        result = store.nearest_candidate(parts[3], nearby, params["limit"], params["marker_set_id"])
                    else:
                        result = store.get_candidates(parts[3], **params)
                    self._send_json(result)
                elif len(parts) == 5 and parts[:3] == ["api", "receiver", "scans"] and parts[4] == "traces":
                    self._send_json(store.list_traces(
                        parts[3],
                        _query_int(query, "offset", 0),
                        _query_int(query, "limit", 100),
                        query.get("order", ["asc"])[0],
                    ))
                elif len(parts) == 5 and parts[:3] == ["api", "receiver", "scans"] and parts[4] == "trace":
                    sweep = _query_int(query, "sweep", None)
                    if sweep is None:
                        raise ValueError("sweep query parameter is required")
                    data = store.get_trace(parts[3], sweep)
                    self.send_response(HTTPStatus.OK)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(data)
                elif len(parts) == 5 and parts[:3] == ["api", "receiver", "audio-segments"] and parts[4] == "audio":
                    self._receiver_segment_audio(parts[3])
                else:
                    return False
            return True
        except (BrokenPipeError, ConnectionResetError):
            # The browser cancelled the read, as it does for an audio range it no longer
            # needs; handle() closes the connection without logging an error response.
            raise
        except (ValueError, KeyError, OSError, sqlite3.Error, zlib.error) as exc:
            self._receiver_error(exc)
            return True

    def _receiver_post(self, parsed: Any) -> bool:
        path = parsed.path
        store = self.console_server.receiver_store
        activity = self.console_server.receiver_activity
        if path.startswith("/api/receiver/archive/"):
            try:
                self._archive_post(parsed)
            except (BrokenPipeError, ConnectionResetError):
                raise
            except (ArchiveError, ValueError, KeyError, OSError, sqlite3.Error, zlib.error) as exc:
                self._archive_failure(exc)
            return True
        try:
            if path == "/api/receiver/settings":
                self._receiver_settings_post()
            elif path == "/api/receiver/scans":
                payload = self._read_json(64 * 1024)
                if not isinstance(payload, dict) or not {"source", "config", "archive"}.issubset(payload):
                    raise ValueError("scan body requires source, config, and archive")
                result = store.create_scan(payload["source"], payload["config"], payload["archive"])
                activity.wrote(opened=f"scan:{result['id']}")
                self._send_json(result, HTTPStatus.CREATED)
            elif path == "/api/receiver/marker-sets":
                payload = self._read_json(256 * 1024)
                self._send_json(store.save_markers(payload), HTTPStatus.CREATED)
            else:
                parts = path.strip("/").split("/")
                if len(parts) == 6 and parts[:3] == ["api", "receiver", "scans"] and parts[4:] == ["candidates", "query"]:
                    payload = self._read_json(2 * 1024 * 1024)
                    if not isinstance(payload, dict):
                        raise ValueError("candidate query must be a JSON object")
                    self._send_json(store.get_candidates(
                        parts[3],
                        offset=payload.get("offset", 0),
                        limit=payload.get("limit", 100),
                        sort=payload.get("sort", "frequency"),
                        minimum_peak_db=payload.get("minimum_peak_db"),
                        marked_only=payload.get("marked_only", False),
                        marker_set_id=payload.get("marker_set_id"),
                        marker_frequencies=payload.get("marker_frequencies"),
                        group_adjacent=payload.get("group_adjacent", False),
                    ))
                elif len(parts) == 5 and parts[:3] == ["api", "receiver", "scans"] and parts[4] == "candidates":
                    payload = self._read_json(2 * 1024 * 1024)
                    if not isinstance(payload, dict) or not isinstance(payload.get("candidates"), list):
                        raise ValueError("candidates must be an array")
                    upserted = store.upsert_candidates(parts[3], payload["candidates"])
                    activity.wrote()
                    self._send_json({"upserted": upserted})
                elif len(parts) == 5 and parts[:3] == ["api", "receiver", "scans"] and parts[4] == "trace":
                    sweep = _query_int(parse_qs(parsed.query), "sweep", None)
                    if sweep is None:
                        raise ValueError("sweep query parameter is required")
                    raw = self._read_binary(2048)
                    frame_id = store.add_trace(parts[3], sweep, raw)
                    activity.wrote()
                    self._send_json({"stored": frame_id is not None, "id": frame_id})
                elif len(parts) == 5 and parts[:3] == ["api", "receiver", "scans"] and parts[4] == "finish":
                    payload = self._read_json(4096)
                    if not isinstance(payload, dict):
                        raise ValueError("request must be a JSON object")
                    finished = store.finish_scan(parts[3], payload.get("status"), payload.get("trace_upload_failures"))
                    activity.wrote(closed=f"scan:{parts[3]}")
                    self._send_json(finished)
                elif path == "/api/receiver/audio-sessions":
                    self._read_optional_json()
                    session_id = store.create_audio_session()["id"]
                    activity.wrote(opened=f"audio:{session_id}")
                    self._send_json({"id": session_id}, HTTPStatus.CREATED)
                elif len(parts) == 5 and parts[:3] == ["api", "receiver", "audio-sessions"] and parts[4] == "segments":
                    payload = self._read_json(16 * 1024)
                    segment_id = store.create_audio_segment(parts[3], payload)["id"]
                    activity.wrote()
                    self._send_json({"id": segment_id}, HTTPStatus.CREATED)
                elif len(parts) == 5 and parts[:3] == ["api", "receiver", "audio-sessions"] and parts[4] == "finish":
                    payload = self._read_optional_json()
                    if not isinstance(payload, dict):
                        raise ValueError("request must be a JSON object")
                    finished = store.finish_audio_session(parts[3], payload.get("finalize_open_segments", False))
                    activity.wrote(closed=f"audio:{parts[3]}")
                    self._send_json(finished)
                elif len(parts) == 5 and parts[:3] == ["api", "receiver", "audio-segments"] and parts[4] == "chunk":
                    raw = self._read_binary(1024 * 1024)
                    appended = store.append_segment_audio(parts[3], raw)
                    activity.wrote()
                    self._send_json(appended)
                elif len(parts) == 5 and parts[:3] == ["api", "receiver", "audio-segments"] and parts[4] == "finish":
                    payload = self._read_json(4096)
                    finished = store.finish_segment(parts[3], payload)
                    activity.wrote()
                    self._send_json(finished)
                else:
                    return False
            return True
        except (ValueError, KeyError, OSError, sqlite3.Error, zlib.error) as exc:
            self._receiver_error(exc)
            return True

    def _receiver_delete(self, parsed: Any) -> bool:
        parts = parsed.path.strip("/").split("/")
        store = self.console_server.receiver_store
        try:
            if len(parts) == 4 and parts[:3] == ["api", "receiver", "records"]:
                deleted = store.delete_record(parts[3])
            elif len(parts) == 4 and parts[:3] == ["api", "receiver", "audio-segments"]:
                deleted = store.delete_audio_segment(parts[3])
            elif len(parts) == 4 and parts[:3] == ["api", "receiver", "marker-sets"]:
                deleted = store.delete_markers(parts[3])
            else:
                return False
            if not deleted:
                raise KeyError("record not found")
            self._send_json({"deleted": True})
            return True
        except (ValueError, KeyError, OSError, sqlite3.Error, zlib.error) as exc:
            self._receiver_error(exc)
            return True

    def _admin_token(self) -> str:
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return ""
        morsel = cookie.get(ADMIN_SESSION_COOKIE)
        return morsel.value if morsel else ""

    def _is_admin(self) -> bool:
        return self.console_server.is_admin_token(self._admin_token())

    def _send_receiver_build_missing(self) -> None:
        """Explain the missing embedded Receiver instead of a raw JSON 404 inside the iframe."""
        body = (
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            "<title>Receiver not built</title><style>"
            "body{margin:0;padding:24px;font:14px/1.5 system-ui,sans-serif;background:#0f141b;color:#dce3ea}"
            "code{background:#1d2630;padding:1px 5px;border-radius:3px}"
            "@media (prefers-color-scheme: light){body{background:#fafbf9;color:#202824}code{background:#e2e6e1}}"
            "</style></head><body><h1>Receiver is not built</h1>"
            "<p>The embedded Receiver is built separately from the console. "
            "<code>npm run build</code> in <code>frontend</code> clears it, so build it again afterwards, "
            "from the repository root:</p>"
            "<pre><code>git submodule update --init --recursive\n"
            "python tools/build_browsdr_receiver.py</code></pre>"
            "<p>Then reload this page.</p></body></html>"
        ).encode("utf-8")
        self.send_response(HTTPStatus.NOT_FOUND)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'",
        )
        self.end_headers()
        self.wfile.write(body)

    def _send_frontend(self, request_path: str) -> None:
        """Serve only allowlisted built UI assets, never source, dotfiles or symlinks."""
        root = self.console_server.frontend_dir
        receiver_prefix = "/receiver"
        is_receiver = request_path == receiver_prefix or request_path.startswith(receiver_prefix + "/")
        if is_receiver:
            if request_path in {receiver_prefix, receiver_prefix + "/"}:
                relative = "receiver/index.html"
            else:
                relative = "receiver/" + request_path[len(receiver_prefix + "/"):]
        else:
            relative = "index.html" if request_path == "/" else request_path.lstrip("/")
        parts = relative.split("/")
        ground_console_mime = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css",
            ".png": "image/png",
            ".svg": "image/svg+xml",
            ".woff2": "font/woff2",
            ".ico": "image/x-icon",
        }
        receiver_mime = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".mjs": "text/javascript; charset=utf-8",
            ".css": "text/css",
            ".json": "application/json",
            ".map": "application/json",
            ".webmanifest": "application/manifest+json",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".svg": "image/svg+xml",
            ".woff": "font/woff",
            ".woff2": "font/woff2",
            ".ttf": "font/ttf",
            ".otf": "font/otf",
            ".ico": "image/x-icon",
            ".wasm": "application/wasm",
            ".mp3": "audio/mpeg",
            ".wav": "audio/wav",
            ".ogg": "audio/ogg",
            ".txt": "text/plain; charset=utf-8",
            ".gz": "application/gzip",
        }
        mime = receiver_mime if is_receiver else ground_console_mime
        allowed_root_path = (
            relative.startswith("receiver/")
            if is_receiver
            else relative in FRONTEND_ROOT_FILES or relative.startswith("assets/")
        )
        suffix = Path(relative).suffix.lower() if is_receiver else Path(relative).suffix
        if (
            root is None
            or not allowed_root_path
            or any(not part or part.startswith(".") for part in parts)
            or "%" in relative
            or "\\" in relative
            or suffix not in mime
        ):
            self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return
        path = root.joinpath(*parts)
        if any(root.joinpath(*parts[:index]).is_symlink() for index in range(1, len(parts) + 1)):
            self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            path.resolve().relative_to(root.resolve())
            body = path.read_bytes()
        except (OSError, ValueError):
            if is_receiver and relative == "receiver/index.html":
                self._send_receiver_build_missing()
                return
            self._send_json(
                {"error": "Frontend build unavailable. Run npm ci and npm run build in frontend, or use --legacy-ui."},
                HTTPStatus.NOT_FOUND,
            )
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime[suffix])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Cache-Control", "no-store" if suffix == ".html" else "public, max-age=3600")
        if is_receiver:
            content_security_policy = (
                "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; "
                "style-src 'self' 'unsafe-inline'; "
                "font-src 'self' data:; img-src 'self' data: blob:; "
                "media-src 'self' blob: data:; worker-src 'self' blob:; "
                "connect-src 'self' https://cdn.jsdelivr.net https://huggingface.co https://*.huggingface.co "
                "https://hf.co https://*.hf.co; object-src 'none'; "
                "base-uri 'self'; frame-ancestors 'self'; form-action 'self'"
            )
            self.send_header("Permissions-Policy", "usb=(self), autoplay=(self)")
            if relative == f"receiver/{BROWSDR_SOURCE_ARCHIVE}":
                self.send_header("Content-Disposition", f'attachment; filename="{BROWSDR_SOURCE_ARCHIVE}"')
        else:
            content_security_policy = (
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                # blob: lets Plotly's "Download plot as a PNG" rasterize the
                # plot it just serialized in this page. Basemap tiles come
                # from this console (/api/tiles), so no tile host is listed.
                "img-src 'self' data: blob:; "
                "connect-src 'self'; "
                "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
            )
        self.send_header("Content-Security-Policy", content_security_policy)
        self.end_headers()
        self.wfile.write(body)

    def _send_tile(self, path: str) -> None:
        """GET /api/tiles/<source>/<z>/<x>/<y>: a basemap tile from the cache or its upstream."""
        # Another page, even one on another localhost port (same-site), could
        # embed these URLs as images and make the console fetch and cache
        # tiles of any area. The console's own map is same-origin, a typed URL
        # is "none", and curl or a test client sends no Sec-Fetch-Site at all.
        if self.headers.get("Sec-Fetch-Site", "").strip().lower() not in ("", "none", "same-origin"):
            self._send_json({"ok": False, "code": "ORIGIN_REJECTED", "error": "tiles are served to this console's own pages only"}, HTTPStatus.FORBIDDEN)
            return
        result = self.console_server.tile_cache.get_path(path)
        if result.status != HTTPStatus.OK:
            self._send_json({"error": result.error or "tile unavailable"}, result.status)
            return
        max_age = BROWSER_STALE_MAX_AGE_S if result.cache == "stale" else BROWSER_MAX_AGE_S
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", result.content_type)
        self.send_header("Content-Length", str(len(result.body)))
        self.send_header("Cache-Control", f"private, max-age={max_age}")
        self.send_header("X-Tile-Cache", result.cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(result.body)

    def _capabilities_body(self) -> Dict[str, Any]:
        """Body of GET /api/capabilities on the loopback listener."""
        monitor = self.console_server.mqtt_monitor
        node_id = _monitor_node_id(monitor)
        return {
            # The console has one publish path, Kontrol's RDF Node commands
            # below (the admin-gated config.patch and its read-only
            # config.get). It never POSTs to the Raspberry or applies
            # settings itself; the edge does.
            "read_only": False,
            "mqtt_publish": True,
            "remote_post": False,
            "config_apply": False,
            "mqtt_monitor": monitor is not None,
            "admin_branding": True,
            "admin_auth_required": True,
            "admin_enabled": bool(ADMIN_PASSWORD),
            "admin_default_password": ADMIN_PASSWORD == DEFAULT_ADMIN_PASSWORD,
            "config_allowlist": list(cmds.PATCH_FIELDS),
            "config_patch": {
                "enabled": _monitor_can_publish(monitor),
                "requires_admin": True,
                "topic": cmds.command_topic(node_id, cmds.OP_CONFIG_PATCH),
                "get_topic": cmds.command_topic(node_id, cmds.OP_CONFIG_GET),
                "ack_topic": f"sdr/v2/{node_id}/{cmds.ACK_SUFFIX}",
                "settings_topic": f"sdr/v2/{node_id}/{cmds.SETTINGS_SUFFIX}",
                "qos": cmds.COMMAND_QOS,
                "ttl_ms": cmds.COMMAND_TTL_MS,
                "ranges": _config_patch_ranges(),
                "gain_table_db": list(cmds.GAIN_TABLE_DB),
                "requires_fresh_health": True,
            },
            "refresh_intervals_s": sorted(ALLOWED_REFRESH_INTERVALS),
            "snapshot_budget_ms": int(SNAPSHOT_TOTAL_BUDGET_S * 1000),
            # Browser preferences are kept on this host (/api/preferences).
            "preferences": True,
            "version": self.console_server.version,
            # Which listener answered: "local" here, "lan-view" on the LAN
            # view (LanConsoleHandler), and the LAN view's state.
            "access": lan.ACCESS_LOCAL,
            "lan_access": self.console_server.lan.status(),
            # Restart and Shutdown of this host; the LAN view drops it.
            "host_power": self.console_server.host_power.status(),
        }

    def _health_body(self) -> Dict[str, Any]:
        """Body of GET /api/health.

        For container and service health checks: no Data Out read, no broker
        call, no file access. receiver_busy tells the updaters to wait while
        the Receiver records or archives a scan; lan_access says whether the
        LAN view is open and, when it is enabled but closed, why.
        """
        return {
            "ok": True,
            "version": self.console_server.version,
            "receiver_busy": self.console_server.receiver_activity.busy(),
            "lan_access": self.console_server.lan.brief_status(),
        }

    def _send_snapshot(self, base_url: str, request: SnapshotRequest) -> None:
        try:
            snapshot = self.console_server.collect_snapshot(base_url, request)
        except (CollectorError, ValueError, OSError, http.client.HTTPException) as exc:
            self._send_json({"error": str(exc) or type(exc).__name__, "read_only": True}, HTTPStatus.BAD_GATEWAY)
            return
        self._send_json(snapshot)

    def _send_lan_error(self, status: int, code: str, message: str, **extra: Any) -> None:
        # LAN view and /api/lan-access codes go through this helper, never the
        # Kontrol error helper, so the config-patch code contract does not
        # count them.
        self._send_json({**extra, "ok": False, "code": code, "error": message}, status)

    # The Receiver's read rule also guards GET /api/lan-access: this
    # console's own pages only (Sec-Fetch-Site, a loopback Host on this port).
    def _local_read_is_allowed(self) -> bool:
        return self._receiver_read_is_allowed()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        if parsed.path.startswith("/api/receiver/") and self._receiver_get(parsed):
            return
        if parsed.path.startswith(TILE_ROUTE_PREFIX):
            # The query is never forwarded; only the path names a tile.
            self._send_tile(parsed.path)
            return
        if self.console_server.frontend_dir is not None and not parsed.path.startswith("/api/"):
            self._send_frontend(parsed.path)
            return
        if parsed.path == "/":
            branding = self.console_server.get_branding()
            config = self.console_server.get_config()
            body = HTML.replace("__BASE_URL__", escape(config["base_url"], quote=True))
            body = body.replace("__MQTT_HOST__", escape(config["mqtt_host"], quote=True))
            body = body.replace("__MQTT_PORT__", str(config["mqtt_port"]))
            body = body.replace("__REFRESH_SECONDS__", str(config["refresh_seconds"]))
            body = body.replace("__CONSOLE_CONFIG_JSON__", _safe_config_json(_public_config(config)))
            body = body.replace("__APP_NAME__", escape(branding["app_name"], quote=True))
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body.encode("utf-8"))))
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))
            return
        if parsed.path == "/api/health":
            self._send_json(self._health_body())
            return
        if parsed.path == "/api/preferences":
            self._send_json(self.console_server.preferences.snapshot())
            return
        if parsed.path == "/api/branding":
            self._send_json(self.console_server.get_branding())
            return
        if parsed.path == "/api/admin/status":
            self._send_json({"authenticated": self._is_admin()})
            return
        if parsed.path == "/api/snapshot":
            query = parse_qs(parsed.query, keep_blank_values=False)
            base_url = query.get("base_url", [self.console_server.base_url])[0]
            try:
                check_data_out_url(base_url, self.console_server.data_out_hosts)
            except DataOutHostError as exc:
                self._send_data_out_error(exc)
                return
            self._send_snapshot(base_url, _snapshot_request(query))
            return
        if parsed.path == "/api/capabilities":
            self._send_json(self._capabilities_body())
            return
        if parsed.path == "/api/console-config":
            self._send_json(_public_config(self.console_server.get_config()))
            return
        if parsed.path == "/api/lan-access":
            # Readable from this console's own pages without admin (the
            # Configuration card); changing it needs admin (POST).
            if not self._local_read_is_allowed():
                self._send_lan_error(
                    HTTPStatus.FORBIDDEN, lan.ORIGIN_REJECTED, "/api/lan-access is read from this console's own pages only",
                )
                return
            self._send_json(self.console_server.lan_access_view())
            return
        if parsed.path == rm.ROUTE:
            self._get_mirror()
            return
        if parsed.path.startswith(rm.MARKERS_ROUTE + "/"):
            self._get_mirror_marker(parsed.path[len(rm.MARKERS_ROUTE) + 1:])
            return
        if parsed.path == "/api/mqtt":
            monitor = self.console_server.mqtt_monitor
            if monitor is None:
                self._send_json({"enabled": False, "read_only": True, "publish_enabled": False})
            else:
                self._send_json(monitor.snapshot())
            return
        if parsed.path == "/api/mqtt/rdf-node":
            monitor = self.console_server.mqtt_monitor
            if monitor is None:
                self._send_json(_empty_rdf_node_mqtt_snapshot())
            else:
                self._send_json(monitor.rdf_node_snapshot())
            return
        if parsed.path == "/api/mqtt/config-reported":
            self._send_json(self.console_server.config_reported())
            return
        if parsed.path == "/api/mqtt/config-patch":
            self._send_json({"command": self.console_server.config_commands.latest(self.console_server.mqtt_monitor)})
            return
        if parsed.path.startswith("/api/mqtt/config-patch/"):
            command_id = parsed.path[len("/api/mqtt/config-patch/"):]
            if _COMMAND_ID_RE.fullmatch(command_id) is None:
                self._send_config_patch_error(
                    HTTPStatus.BAD_REQUEST, "INVALID_REQUEST", "command id must match [A-Za-z0-9_.:-]{1,80}",
                )
                return
            status = self.console_server.config_commands.status(command_id, self.console_server.mqtt_monitor)
            if status is None:
                self._send_config_patch_error(
                    HTTPStatus.NOT_FOUND, "COMMAND_UNKNOWN", "this console has no record of that command id",
                )
                return
            self._send_json(status)
            return
        self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def _send_data_out_error(self, exc: DataOutHostError) -> None:
        # The code is a variable, so the Kontrol error-code contract does not
        # count these; the Configuration page translates them with the list.
        body: Dict[str, Any] = {
            "ok": False,
            "code": exc.code,
            "error": str(exc),
            "read_only": True,
            "data_out_hosts": list(exc.hosts),
            "port": DATA_OUT_PORT,
        }
        if exc.host:
            body["host"] = exc.host
        self._send_json(body, HTTPStatus.BAD_REQUEST)

    def _send_preferences_error(self, status: int, code: str, message: str) -> None:
        # Same body shape as the config-patch errors; the browser sync only
        # logs these, Kontrol never shows them.
        self._send_json({"ok": False, "code": code, "error": message}, status)

    def _write_preferences(self) -> None:
        """PUT or POST /api/preferences: merge known keys, no admin needed."""
        if not self._same_origin_loopback_request():
            self._send_preferences_error(
                HTTPStatus.FORBIDDEN,
                "ORIGIN_REJECTED",
                "/api/preferences requires a same-origin loopback request",
            )
            return
        try:
            payload = self._read_json(MAX_PREFERENCES_REQUEST_BYTES)
        except ValueError as exc:
            self._send_preferences_error(HTTPStatus.BAD_REQUEST, "INVALID_REQUEST", str(exc))
            return
        try:
            snapshot = self.console_server.preferences.update(payload)
        except PreferencesRejected as exc:
            self._send_preferences_error(exc.status, exc.code, str(exc))
            return
        except OSError as exc:
            self._send_preferences_error(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "PREFERENCES_WRITE_FAILED",
                f"preferences could not be saved ({type(exc).__name__})",
            )
            return
        self._send_json({"ok": True, **snapshot})

    def _send_mirror_error(self, code: str, message: str) -> None:
        # Mirror codes go through this helper, never the Kontrol error helper,
        # so the config-patch code contract does not count them.
        self._send_json({"ok": False, "code": code, "error": message}, rm.ERROR_CODES_HTTP[code])

    def _discard_body(self, max_bytes: int) -> None:
        """Read and drop a refused request's body up to ``max_bytes``, so the client sees the answer, not a reset."""
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            return
        if 0 < length <= max_bytes:
            try:
                self.rfile.read(length)
            except OSError:
                pass

    def _mirror_read_is_allowed(self) -> bool:
        """GET /api/mirror/receiver on this listener: the Receiver's read rule.

        The mirror carries what the Receiver shows (frequencies, mode, gains,
        recording, the spectrum), so it is read like /api/receiver/*: one
        loopback Host on this port, which stops a DNS rebinding page, and no
        other site or localhost port. LanConsoleHandler has its own rule.
        """
        return self._receiver_read_is_allowed()

    def _get_mirror(self) -> None:
        """GET /api/mirror/receiver (both listeners): the latest mirrored state and frame with their ages."""
        if not self._mirror_read_is_allowed():
            self._send_mirror_error(rm.ORIGIN_REJECTED, "the Receiver mirror is read by this console's pages only")
            return
        self._send_json(self.console_server.receiver_mirror.view())

    def _post_mirror(self) -> None:
        """POST /api/mirror/receiver: the kiosk page publishes its Receiver's state and latest frame.

        In order: the same-origin loopback Origin (403), the body length
        (413), the rate (429), an open LAN view (409), then the schema (400).
        A body of at most MAX_BODY_BYTES is read before every answer, also a
        refusal, so the client reads its answer rather than a reset.
        """
        mirror = self.console_server.receiver_mirror
        if not self._same_origin_loopback_request():
            self._discard_body(rm.MAX_BODY_BYTES)
            self._send_mirror_error(rm.ORIGIN_REJECTED, f"{rm.ROUTE} requires a same-origin loopback request")
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = -1
        if length > rm.MAX_BODY_BYTES:
            self.close_connection = True
            self._discard_body(lan.MAX_DISCARDED_BODY_BYTES)
            self._send_mirror_error(rm.MIRROR_TOO_LARGE, f"the body must be at most {rm.MAX_BODY_BYTES} bytes")
            return
        if length < 1:
            self._send_mirror_error(rm.MIRROR_INVALID, "the body must be JSON with a Content-Length")
            return
        raw = self.rfile.read(length)
        if not mirror.admit():
            self._send_mirror_error(rm.MIRROR_RATE_LIMITED, f"at most {rm.MAX_POSTS_PER_S} posts a second")
            return
        # is_open() waits while the LAN view is being opened, moved or closed.
        if not self.console_server.lan.is_open():
            self._send_mirror_error(rm.MIRROR_LAN_CLOSED, rm.LAN_CLOSED_MESSAGE)
            return
        try:
            if len(raw) != length:
                raise rm.MirrorRejected(rm.MIRROR_INVALID, "the body is incomplete")
            # Refused as MIRROR_LAN_CLOSED when the LAN view closed since the check above.
            # The answer hands the page the viewers' queued marker commands.
            result = mirror.publish(*rm.decode_publish(raw))
        except rm.MirrorRejected as exc:
            self._send_mirror_error(exc.code, exc.message)
            return
        self._send_json({"ok": True, **result})

    def _mirror_marker_origin_is_valid(self) -> bool:
        """POST /api/mirror/receiver/markers on this listener: the console's own page (parity and tests)."""
        return self._same_origin_loopback_request()

    def _queue_mirror_marker(self, command: Dict[str, Any]) -> Dict[str, Any]:
        """Queue a marker command; LanConsoleHandler queues only while its own listener is the open one."""
        return self.console_server.receiver_mirror.queue_marker_command(command)

    def _post_mirror_marker(self) -> None:
        """POST /api/mirror/receiver/markers: a viewer adds or removes one of the Receiver's markers.

        In order: the listener's own Origin (403), the body length (413), at
        most rm.MARKER_COMMANDS_PER_S from this client address (429), an open
        LAN view (409), the schema (400), on the LAN view a listener that is
        still the open one (409 MIRROR_LAN_CLOSED), then a page that publishes
        (409 MIRROR_NO_SOURCE), a new id (409) and room in the queue (429
        MIRROR_MARKER_BUSY). 202 with the command's status; the publishing
        page runs it through the bridge and reports its result. No cookie is
        read.
        """
        mirror = self.console_server.receiver_mirror
        if not self._mirror_marker_origin_is_valid():
            self._discard_body(rm.MAX_MARKER_BODY_BYTES)
            self._send_mirror_error(rm.ORIGIN_REJECTED, f"{rm.MARKERS_ROUTE} takes commands from this console's own pages only")
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = -1
        if length > rm.MAX_MARKER_BODY_BYTES:
            self.close_connection = True
            self._discard_body(lan.MAX_DISCARDED_BODY_BYTES)
            self._send_mirror_error(rm.MIRROR_TOO_LARGE, f"the body must be at most {rm.MAX_MARKER_BODY_BYTES} bytes")
            return
        if length < 1:
            self._send_mirror_error(rm.MIRROR_INVALID, "the body must be JSON with a Content-Length")
            return
        raw = self.rfile.read(length)
        client = str(lan.client_address(self.client_address[0]) or self.client_address[0])
        if not mirror.admit_marker_command(client):
            self._send_mirror_error(rm.MIRROR_RATE_LIMITED, f"at most {rm.MARKER_COMMANDS_PER_S} marker commands a second")
            return
        if not self.console_server.lan.is_open():
            self._send_mirror_error(rm.MIRROR_LAN_CLOSED, rm.LAN_CLOSED_MESSAGE)
            return
        try:
            if len(raw) != length:
                raise rm.MirrorRejected(rm.MIRROR_INVALID, "the body is incomplete")
            view = self._queue_mirror_marker(rm.decode_marker_command(raw))
        except rm.MirrorRejected as exc:
            self._send_mirror_error(exc.code, exc.message)
            return
        self._send_json(view, HTTPStatus.ACCEPTED)

    def _get_mirror_marker(self, command_id: str) -> None:
        """GET /api/mirror/receiver/markers/<id> (both listeners, the mirror's read rule): one marker command's status."""
        if not self._mirror_read_is_allowed():
            self._send_mirror_error(rm.ORIGIN_REJECTED, "the Receiver mirror is read by this console's pages only")
            return
        view = self.console_server.receiver_mirror.marker_command(command_id)
        if view is None:
            self._send_mirror_error(rm.MIRROR_UNKNOWN_COMMAND, "no marker command with this id is held")
            return
        self._send_json(view)

    def _send_host_power_error(self, code: str, message: str, **extra: Any) -> None:
        # Host power codes go through this helper, never the Kontrol error
        # helper, so the config-patch code contract does not count them.
        self._send_json({**extra, "ok": False, "code": code, "error": message}, hp.ERROR_CODES_HTTP[code])

    def _post_host_power(self) -> None:
        """POST /api/host/power: Restart or Shutdown of this host, confirmed in the page.

        In order: the same-origin loopback Origin (403, decided before the
        body is read), the body length (413), the body (400), the request
        directory and its helper (503), a request the host has not taken yet
        (409), the write (500). The LAN view never gets here: the one POST
        it passes on is a marker command (lan.write_allowed).
        """
        if not self._same_origin_loopback_request():
            self._discard_body(hp.MAX_BODY_BYTES)
            self._send_host_power_error(hp.ORIGIN_REJECTED, f"{hp.ROUTE} requires a same-origin loopback request")
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = -1
        if length > hp.MAX_BODY_BYTES:
            self.close_connection = True
            self._discard_body(lan.MAX_DISCARDED_BODY_BYTES)
            self._send_host_power_error(hp.HOST_POWER_TOO_LARGE, f"the body must be at most {hp.MAX_BODY_BYTES} bytes")
            return
        if length < 1:
            self._send_host_power_error(hp.HOST_POWER_INVALID, "the body must be JSON with a Content-Length")
            return
        raw = self.rfile.read(length)
        try:
            if len(raw) != length:
                raise hp.HostPowerRejected(hp.HOST_POWER_INVALID, "the body is incomplete")
            action = hp.decode_request(raw)
            result = self.console_server.host_power.request(action)
        except hp.HostPowerRejected as exc:
            self._send_host_power_error(exc.code, exc.message, **exc.extra)
            return
        self.log_message("host power: %s requested", action)
        self._send_json({"ok": True, **result}, HTTPStatus.ACCEPTED)

    def _post_lan_access(self) -> None:
        """POST /api/lan-access: change the LAN view and open, move or close it at once.

        The same-origin loopback Origin was checked before (SAME_ORIGIN_POST_PATHS);
        then admin, the body, the settings, the admin password rule, the save.
        """
        if not self._is_admin():
            self._send_lan_error(HTTPStatus.UNAUTHORIZED, lan.ADMIN_REQUIRED, "admin authentication required")
            return
        try:
            payload = self._read_json(4096)
        except ValueError as exc:
            self._send_lan_error(HTTPStatus.BAD_REQUEST, lan.LAN_ACCESS_INVALID, str(exc))
            return
        try:
            body = self.console_server.set_lan_access(payload)
        except LanAccessRejected as exc:
            self._send_lan_error(exc.status, exc.code, exc.message)
            return
        self._send_json({"ok": True, **body})

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        if parsed.path == "/api/preferences":
            self._write_preferences()
            return
        self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        if parsed.path.startswith("/api/receiver/") and not self._receiver_mutation_origin_is_valid():
            self._send_archive_error(HTTPStatus.FORBIDDEN, ra.ORIGIN_REJECTED, ra.MUTATION_REJECTED_MESSAGE)
            return
        if parsed.path.startswith("/api/receiver/") and self._receiver_post(parsed):
            return
        if parsed.path == rm.ROUTE:
            self._post_mirror()
            return
        if parsed.path == rm.MARKERS_ROUTE:
            self._post_mirror_marker()
            return
        if parsed.path == hp.ROUTE:
            self._post_host_power()
            return
        if parsed.path in SAME_ORIGIN_POST_PATHS and not self._same_origin_loopback_request():
            # Rejected before the body is read, the login throttle or any
            # config or monitor change.
            extra = {"read_only": True} if parsed.path in {"/api/console-config", "/api/mqtt/connect"} else {}
            self._send_config_patch_error(
                HTTPStatus.FORBIDDEN,
                "ORIGIN_REJECTED",
                f"{parsed.path} requires a same-origin loopback request",
                **extra,
            )
            return
        if parsed.path == "/api/preferences":
            self._write_preferences()
            return
        if parsed.path == "/api/console-config":
            try:
                payload = self._read_json(16 * 1024)
                if not isinstance(payload, dict):
                    raise ValueError("request must be a JSON object")
                if "lan_access" in payload:
                    # No admin is needed here, so the LAN view never changes
                    # through this route.
                    raise ValueError("lan_access is changed through POST /api/lan-access (admin)")
                current = self.console_server.get_config()
                config = self.console_server.apply_config({**current, **payload})
                self._send_json(_public_config(config))
            except DataOutHostError as exc:
                self._send_data_out_error(exc)
            except (ValueError, OSError) as exc:
                self._send_json({"ok": False, "error": str(exc), "read_only": True}, HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/api/lan-access":
            self._post_lan_access()
            return
        if parsed.path == "/api/admin/login":
            try:
                payload = self._read_json(4096)
                password = payload.get("password") if isinstance(payload, dict) else None
                if not ADMIN_PASSWORD:
                    self._send_json(
                        {
                            "ok": False,
                            "error": "admin login disabled: set SDR_DOA_ADMIN_PASSWORD",
                            "code": "ADMIN_DISABLED",
                        },
                        HTTPStatus.SERVICE_UNAVAILABLE,
                    )
                    return
                token, retry_after_s = self.console_server.attempt_admin_login(password)
                if retry_after_s > 0:
                    seconds = max(1, math.ceil(retry_after_s))
                    self._send_json(
                        {
                            "ok": False,
                            "error": f"too many failed admin logins; try again in {seconds} s",
                            "code": "ADMIN_LOGIN_THROTTLED",
                            "retry_after_s": seconds,
                        },
                        HTTPStatus.TOO_MANY_REQUESTS,
                        headers={"Retry-After": str(seconds)},
                    )
                    return
                if not token:
                    self._send_json(
                        {"ok": False, "error": "admin password is incorrect", "code": "ADMIN_PASSWORD_INVALID"},
                        HTTPStatus.UNAUTHORIZED,
                    )
                    return
                self._send_json(
                    {"ok": True, "authenticated": True},
                    headers={
                        "Set-Cookie": f"{ADMIN_SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={ADMIN_SESSION_TTL_SECONDS}"
                    },
                )
            except ValueError as exc:
                self._send_json({"ok": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/api/admin/logout":
            self.console_server.revoke_admin_session(self._admin_token())
            self._send_json(
                {"ok": True},
                headers={"Set-Cookie": f"{ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"},
            )
            return
        if parsed.path == "/api/admin/branding":
            if not self._is_admin():
                self._send_json({"ok": False, "error": "admin authentication required"}, HTTPStatus.UNAUTHORIZED)
                return
            try:
                payload = self._read_json(MAX_LOGO_BYTES * 2)
                if not isinstance(payload, dict):
                    raise ValueError("request must be a JSON object")
                current = self.console_server.get_branding()
                branding = {
                    "app_name": _normalize_app_name(payload.get("app_name", current["app_name"])),
                    "logo_data_url": _normalize_logo_data_url(payload.get("logo_data_url", current["logo_data_url"])),
                }
                self.console_server.update_branding(branding)
                self._send_json({"ok": True, **branding})
            except (ValueError, OSError) as exc:
                self._send_json({"ok": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        if parsed.path in ("/api/mqtt/config-patch", "/api/mqtt/config-get"):
            # Kontrol's RDF Node commands. Origin and admin are checked before
            # the body is read; the other checks live on the server.
            if not self._same_origin_loopback_request():
                self._send_config_patch_error(
                    HTTPStatus.FORBIDDEN,
                    "ORIGIN_REJECTED",
                    "Kontrol commands require a same-origin loopback request",
                )
                return
            if not self._is_admin():
                self._send_config_patch_error(
                    HTTPStatus.UNAUTHORIZED, "ADMIN_REQUIRED", "admin authentication required",
                )
                return
            try:
                payload = self._read_json(MAX_CONFIG_PATCH_REQUEST_BYTES)
            except ValueError as exc:
                self._send_config_patch_error(HTTPStatus.BAD_REQUEST, "INVALID_REQUEST", str(exc))
                return
            if parsed.path == "/api/mqtt/config-patch":
                status, body = self.console_server.submit_config_patch(payload)
            else:
                status, body = self.console_server.submit_config_get(payload)
            self._send_json(body, status)
            return
        if parsed.path == "/api/mqtt/connect":
            query = parse_qs(parsed.query, keep_blank_values=False)
            host = query.get("host", [""])[0].strip()
            port_text = query.get("port", ["9001"])[0]
            if _MQTT_PORT_QUERY_RE.fullmatch(port_text) is None or not (1 <= int(port_text) <= 65535):
                self._send_json({"error": "MQTT port must be an integer from 1 to 65535", "read_only": True}, HTTPStatus.BAD_REQUEST)
                return
            port = int(port_text)
            if not host or not _is_allowed_mqtt_host(host):
                self._send_json({"error": "MQTT monitor host must be localhost or a valid IPv4/IPv6 address", "read_only": True}, HTTPStatus.BAD_REQUEST)
                return
            transport = query.get("transport", [None])[0]
            if transport is not None and transport not in ALLOWED_MQTT_TRANSPORTS:
                self._send_json({"error": "MQTT transport must be tcp or websockets", "read_only": True}, HTTPStatus.BAD_REQUEST)
                return
            ws_path = query.get("ws_path", [None])[0]
            if ws_path is not None and not _is_allowed_mqtt_ws_path(ws_path):
                self._send_json({"error": "MQTT WebSocket path must start with / and use only letters, digits, and ._~/-", "read_only": True}, HTTPStatus.BAD_REQUEST)
                return
            try:
                monitor = self.console_server.enable_mqtt_monitor(host, port, transport, ws_path)
            except ValueError as exc:
                self._send_json({"error": str(exc), "read_only": True}, HTTPStatus.BAD_REQUEST)
                return
            except Exception as exc:  # pragma: no cover - broker-dependent
                self._send_json({"error": str(exc), "read_only": True}, HTTPStatus.BAD_GATEWAY)
                return
            if isinstance(monitor, _UnavailableMqttMonitor):
                self._send_json({"error": monitor.error, "read_only": True}, HTTPStatus.BAD_GATEWAY)
            else:
                self._send_json(monitor.snapshot())
            return
        if parsed.path != "/api/dry-run/config-patch":
            self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            payload = self._read_json()
            monitor = self.console_server.mqtt_monitor
            view = _monitor_control_view(monitor) if _monitor_can_publish(monitor) else None
            result = validate_config_patch(
                payload,
                session=_session_or_none(view) if view and view.get("available") is True else None,
                node_id=_monitor_node_id(monitor),
            )
            self._send_json(result)
        except ValueError as exc:
            self._send_json(
                {"dry_run": True, "transport": "none", "applied": False, "ok": False, "error": str(exc)},
                HTTPStatus.BAD_REQUEST,
            )


    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        if parsed.path.startswith("/api/receiver/") and not self._receiver_mutation_origin_is_valid():
            self._send_archive_error(HTTPStatus.FORBIDDEN, ra.ORIGIN_REJECTED, ra.MUTATION_REJECTED_MESSAGE)
            return
        if parsed.path.startswith("/api/receiver/") and self._receiver_delete(parsed):
            return
        self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)


class LanAccessRejected(Exception):
    """A refused POST /api/lan-access: HTTP status, code and message."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class _HeadBody:
    """wfile of a HEAD request: the status line and headers go out, the body does not."""

    def __init__(self, raw: Any) -> None:
        self.raw = raw
        self.headers_sent = False

    def write(self, data: bytes) -> int:
        if self.headers_sent:
            return len(data)
        return self.raw.write(data)

    def flush(self) -> None:
        self.raw.flush()


class LanConsoleHandler(ConsoleHandler):
    """One request of an allowed client on the LAN view listener; lan_access.py holds the rules.

    LanViewServer has admitted the client address already (any other gets a
    bare 403 from the accept thread). In order: an HTTP/0.9 request, which
    has no Host (403 ORIGIN_REJECTED), the method (GET and HEAD only, and
    POST of the one write, lan.WRITE_ROUTES; else 405 LAN_READ_ONLY), Host
    and Sec-Fetch-Site (403 ORIGIN_REJECTED), then the path: the built UI, a
    fixed list of read-only API routes, the Records read routes
    (_lan_records_get) and a marker command's status, else 403
    LAN_READ_ONLY. The one write, a marker command to the groundstation
    Receiver (_post_mirror_marker), needs this listener's own Origin. The
    request line and headers must arrive within lan.REQUEST_DEADLINE_S. An
    admin cookie is never read here.
    """

    timeout = lan.REQUEST_TIMEOUT_S

    @property
    def console_server(self) -> "GroundConsoleServer":
        return self.server.console  # type: ignore[attr-defined,no-any-return]

    def setup(self) -> None:
        super().setup()
        # Every read of this connection ends by one deadline, so a client
        # that sends its request a byte at a time cannot keep the thread.
        buffered = self.rfile
        self.rfile = lan.request_reader(
            self.connection,
            deadline_s=self.server.request_deadline_s,  # type: ignore[attr-defined]
            timeout_s=lan.REQUEST_TIMEOUT_S,
        )
        buffered.close()

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[ground-console] lan {self.client_address[0]} " + (fmt % args), flush=True)

    def _discard_small_body(self) -> None:
        """Read and drop a small body of a refused write, so the client sees the answer, not a reset."""
        headers = getattr(self, "headers", None)
        if headers is None or (headers.get("Expect") or "").strip().lower() == "100-continue":
            return
        try:
            length = int(headers.get("Content-Length") or "0")
        except ValueError:
            return
        if 0 < length <= lan.MAX_DISCARDED_BODY_BYTES:
            try:
                self.rfile.read(length)
            except OSError:
                pass

    def _refuse_method(self) -> None:
        # The connection closes after the answer; a large body is never read.
        self.close_connection = True
        self._discard_small_body()
        self._send_json(
            {"ok": False, "code": lan.LAN_READ_ONLY, "error": "the LAN view is read only"},
            HTTPStatus.METHOD_NOT_ALLOWED,
            headers={"Allow": ", ".join(lan.READ_METHODS)},
        )

    def _method_allowed(self) -> bool:
        """GET and HEAD, and POST of the one write (a marker command)."""
        return self.command in lan.READ_METHODS or lan.write_allowed(self.command, urlsplit(self.path).path)

    def handle_expect_100(self) -> bool:
        if not self._method_allowed():
            return True  # refused right after, without a 100 Continue
        return super().handle_expect_100()

    def parse_request(self) -> bool:
        if not super().parse_request():
            return False
        host_message = "the LAN view answers a Host that is an IP address, this host's name or <host name>.local, on its own port"
        if self.request_version == "HTTP/0.9":
            # No headers, so no Host (Python 3.13 leaves self.headers a plain
            # dict). Answered with a status line, which HTTP/0.9 leaves out.
            self.request_version = "HTTP/1.0"
            message = host_message
        elif not self._method_allowed():
            self._refuse_method()
            return False
        elif not lan.host_allowed(
            _header_values(self.headers, "Host"),
            self.server.server_address[1],
            self.server.own_names,  # type: ignore[attr-defined]
        ):
            message = host_message
        elif not lan.fetch_site_allowed(self.headers.get("Sec-Fetch-Site")):
            message = "the LAN view refuses cross-site requests"
        else:
            return True
        self.close_connection = True
        self._send_lan_error(HTTPStatus.FORBIDDEN, lan.ORIGIN_REJECTED, message)
        return False

    def end_headers(self) -> None:
        super().end_headers()
        if isinstance(self.wfile, _HeadBody):
            self.wfile.headers_sent = True

    def _admin_token(self) -> str:
        return ""

    def _is_admin(self) -> bool:
        return False

    def _mirror_read_is_allowed(self) -> bool:
        # The LAN view's own Host rule (an IP literal or this machine's own
        # names, on this port) and no cross-site request; parse_request
        # refused anything else already, this repeats it next to the route.
        return lan.host_allowed(
            _header_values(self.headers, "Host"),
            self.server.server_address[1],
            self.server.own_names,  # type: ignore[attr-defined]
        ) and lan.fetch_site_allowed(self.headers.get("Sec-Fetch-Site"))

    def _mirror_marker_origin_is_valid(self) -> bool:
        # The LAN view's own page: one Origin equal to http:// and the Host
        # that parse_request admitted. Another site, LAN host or port of
        # this host sends its own origin; no cookie is read.
        return lan.origin_matches_host(_header_values(self.headers, "Origin"), _header_values(self.headers, "Host"))

    def _queue_mirror_marker(self, command: Dict[str, Any]) -> Dict[str, Any]:
        # The listener that admitted this client may have been replaced (new
        # allowed_clients, port or bind) while its body arrived: queued only
        # while that listener is still the open one.
        return self.console_server.lan.queue_marker_command(self.server, command)

    def _capabilities_body(self) -> Dict[str, Any]:
        body = super()._capabilities_body()
        body.update({
            # Nothing is written from the LAN but a marker command to the
            # groundstation Receiver (mirror_markers): no admin, no Kontrol,
            # no preference writes, no other Receiver control; Records are
            # read only.
            "read_only": True,
            "mirror_markers": True,
            "mqtt_publish": False,
            "admin_branding": False,
            "admin_enabled": False,
            "admin_default_password": False,
            "config_patch": {**body["config_patch"], "enabled": False},
            "preferences_read_only": True,
            "access": lan.ACCESS_LAN_VIEW,
            "lan_access": self.console_server.lan.brief_status(),
        })
        # Restart and Shutdown are the groundstation's own: not even their state.
        body.pop("host_power", None)
        return body

    def do_HEAD(self) -> None:  # noqa: N802
        raw = self.wfile
        self.wfile = _HeadBody(raw)
        try:
            self.do_GET()
        finally:
            self.wfile = raw

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        route = lan.lan_route(parsed.path)
        if route is None:
            self._send_lan_error(HTTPStatus.FORBIDDEN, lan.LAN_READ_ONLY, "the LAN view answers the console's read-only pages only")
            return
        if route == lan.ROUTE_UI:
            # The built UI only, never the legacy page or /receiver/.
            self._send_frontend(parsed.path)
            return
        if route == lan.ROUTE_TILE:
            self._send_tile(parsed.path)
            return
        if route == lan.ROUTE_RECORDS:
            self._lan_records_get(parsed)
            return
        if route == "/api/snapshot":
            # Only the configured Data Out; a base_url in the query is ignored.
            # seen shares the read like a loopback viewer. refresh is ignored,
            # so LAN clients never read Data Out more often than the saved
            # interval over the radio link; fresh_settings is Kontrol's, which
            # the LAN view does not have.
            query = parse_qs(parsed.query, keep_blank_values=False)
            self._send_snapshot(
                self.console_server.base_url,
                _snapshot_request(query, fresh_settings=False, refresh=False, data_out_only=False),
            )
            return
        if route == "/api/preferences":
            # Read only: the page keeps its own changes in this browser. Only
            # the keys the LAN view's screens read; the Receiver's settings and
            # bookmarks stay on this host, like every /api/receiver/* route.
            self._send_json({**self.console_server.preferences.lan_view_snapshot(), "read_only": True})
            return
        if route == "/api/admin/status":
            self._send_json({"authenticated": False})
            return
        # health, capabilities, console-config, mqtt, mqtt/rdf-node, branding,
        # mirror/receiver and a marker command's status: the loopback
        # listener's answer (capabilities through the override).
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if lan.write_allowed("POST", urlsplit(self.path).path):
            self._post_mirror_marker()
            return
        self._refuse_method()

    def do_PUT(self) -> None:  # noqa: N802
        self._refuse_method()

    do_DELETE = do_PUT

    def _lan_records_read_is_allowed(self) -> bool:
        """The Receiver's read rule on this listener: the LAN Host rule and Sec-Fetch-Site absent, none or same-origin."""
        return lan.host_allowed(
            _header_values(self.headers, "Host"),
            self.server.server_address[1],
            self.server.own_names,  # type: ignore[attr-defined]
        ) and lan.records_fetch_site_allowed(self.headers.get("Sec-Fetch-Site"))

    def _lan_records_get(self, parsed: Any) -> None:
        """GET of a Records read route (lan.records_route): its read rule, its limits, then the route.

        Its own dispatch, so no other Receiver route is reachable from here
        whatever the loopback handler answers. Every refusal to a GET is
        {ok, code, error} and none names a path (a Range the file cannot
        satisfy is the bodiless 416); do_HEAD drops every body, so a HEAD of
        a download is a bare 405 with Allow: GET. The LAN codes keep their
        own texts (403 LAN_READ_ONLY, 429 LAN_RECORDS_BUSY, and 403
        ORIGIN_REJECTED for a same-site request: parse_request already
        refused a foreign Host and a cross-site request). The routes answer
        with archive codes through _archive_failure, the playback route's
        too: a failed open of its file is ARCHIVE_FILE_MISSING.
        """
        kind = lan.records_route(parsed.path)
        if kind is None:
            self._send_lan_error(HTTPStatus.FORBIDDEN, lan.LAN_READ_ONLY, "the LAN view answers the console's read-only pages only")
            return
        if not self._lan_records_read_is_allowed():
            self._send_archive_error(HTTPStatus.FORBIDDEN, ra.ORIGIN_REJECTED, "Receiver Records are read by the LAN view's own pages only")
            return
        stream = kind in lan.RECORDS_STREAM_ROUTES
        if stream and self.command != "GET":
            self._send_json(
                {"ok": False, "code": lan.LAN_READ_ONLY, "error": "Records downloads and playback answer GET only"},
                HTTPStatus.METHOD_NOT_ALLOWED,
                headers={"Allow": "GET"},
            )
            return
        address = str(lan.client_address(self.client_address[0]) or self.client_address[0])
        slots: lan.ClientSlots = self.server.records_streams if stream else self.server.records_reads  # type: ignore[attr-defined]
        if not slots.acquire(address, 0.0 if stream else lan.RECORDS_READ_WAIT_S):
            message = (f"at most {lan.RECORDS_STREAMS_PER_CLIENT} Records downloads at once" if stream
                       else "one Records read at a time; try again")
            self._send_json(
                {"ok": False, "code": lan.LAN_RECORDS_BUSY, "error": message},
                HTTPStatus.TOO_MANY_REQUESTS,
                headers={"Retry-After": "1"},
            )
            return
        try:
            try:
                if kind == lan.RECORDS_AUDIO_PLAYBACK:
                    try:
                        self._receiver_segment_audio(parsed.path.split("/")[4])
                    except KeyError as exc:
                        # Unknown, unfinished, failed or vanished: the archive's fixed text, no path.
                        raise ArchiveError(HTTPStatus.NOT_FOUND, ra.ARCHIVE_FILE_MISSING) from exc
                else:
                    self._lan_archive_get(kind, parsed)
            except (BrokenPipeError, ConnectionResetError):
                raise
            except (ArchiveError, ValueError, KeyError, OSError, sqlite3.Error, zlib.error) as exc:
                self._archive_failure(exc)
        finally:
            slots.release(address)

    def _lan_archive_get(self, kind: str, parsed: Any) -> None:
        """One archive read route. Lists leave stale sessions to the next local read (no write from the LAN)."""
        store = self.console_server.receiver_store
        query = parse_qs(parsed.query, keep_blank_values=False)

        def first(key: str) -> Optional[str]:
            values = query.get(key)
            return values[0] if values else None

        parts = parsed.path.split("/")
        if kind == lan.RECORDS_FACETS:
            self._send_json(store.archive_facets(recover=False))
        elif kind == lan.RECORDS_CALENDAR:
            bounds = ra.parse_calendar_bounds(first("bounds"))
            self._send_json(store.archive_calendar(bounds, ra.parse_calendar_type(first("type"))))
        elif kind == lan.RECORDS_TIMELINE:
            from_ms, to_ms, archive_filter = ra.parse_timeline_query(query)
            self._send_json(store.archive_timeline(from_ms, to_ms, archive_filter))
        elif kind == lan.RECORDS_ITEMS:
            archive_filter = ra.parse_filter_query(query)
            sort, order, offset, limit = ra.parse_paging_query(query)
            if limit > lan.RECORDS_PAGE_MAX:
                raise ArchiveError(
                    HTTPStatus.BAD_REQUEST, ra.ARCHIVE_INVALID_REQUEST,
                    f"limit must be at most {lan.RECORDS_PAGE_MAX} on the LAN view",
                )
            self._send_json(store.archive_items(archive_filter, sort, order, offset, limit, recover=False))
        elif kind == lan.RECORDS_SCAN_PREVIEW:
            self._send_json(store.archive_scan_preview(ra.parse_item_id(parts[5])))
        elif kind == lan.RECORDS_AUDIO_DOWNLOAD:
            self._archive_audio_download(ra.parse_item_id(parts[5]), first("time_zone"), first("utc_offset_minutes"))
        elif kind == lan.RECORDS_SCAN_DOWNLOAD:
            self._archive_scan_download(
                ra.parse_item_id(parts[5]), first("time_zone"), first("utc_offset_minutes"),
                slots=self.console_server.lan_records_zip_slots,
            )
        else:
            raise ArchiveError(HTTPStatus.NOT_FOUND, ra.ARCHIVE_NOT_FOUND, "unknown Receiver archive route")


class LanViewServer(ThreadingHTTPServer):
    """The LAN view listener: a second socket of the same console.

    Admission is decided on the accept thread, before a handler thread
    exists: a client address outside allowed_clients gets the bare 403 there
    without its request being read, and an allowed client finds at most
    lan.MAX_CONNECTIONS requests running (a bare 503 beyond). So the LAN
    costs the console at most that many threads and lan.ANSWERED_MAX_SOCKETS
    answered sockets, whatever other hosts send.
    """

    daemon_threads = True
    # Closing (a move, disable or console stop) does not wait for requests
    # in flight; they end on their own.
    block_on_close = False

    def __init__(
        self,
        console: "GroundConsoleServer",
        address: Tuple[str, int],
        allowed: Sequence[lan.Network],
        refusals: lan.RefusalLog,
    ) -> None:
        self.console = console
        self.allowed = tuple(allowed)
        self.own_names = lan.own_host_names()
        self.refusals = refusals
        # Set before the bind, whose failure calls server_close.
        self.answered = lan.AnsweredSockets(
            max_sockets=lan.ANSWERED_MAX_SOCKETS, linger_s=lan.ANSWERED_LINGER_S, max_bytes=lan.ANSWERED_MAX_BYTES,
        )
        self.max_connections = lan.MAX_CONNECTIONS
        self.request_deadline_s = lan.REQUEST_DEADLINE_S
        self._slots = threading.BoundedSemaphore(self.max_connections)
        self._busy_logged_at: Optional[float] = None
        # Records reads per client address (lan_access.py); a move starts afresh.
        self.records_reads = lan.ClientSlots(1)
        self.records_streams = lan.ClientSlots(lan.RECORDS_STREAMS_PER_CLIENT)
        self.address_family = socket.AF_INET6 if ":" in address[0] else socket.AF_INET
        super().__init__(address, LanConsoleHandler)

    def process_request(self, request: Any, client_address: Any) -> None:
        address = str(client_address[0])
        if not self.admits(address):
            self.refusals.note(address)
            self.answered.answer(request, lan.REFUSED_ANSWER)
            return
        if not self._slots.acquire(blocking=False):
            self._note_busy(address)
            self.answered.answer(request, lan.BUSY_ANSWER)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            # The thread did not start (it releases the slot when it ends).
            self._slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def _note_busy(self, address: str) -> None:
        now = time.monotonic()
        if self._busy_logged_at is not None and now - self._busy_logged_at < lan.REFUSAL_LOG_INTERVAL_S:
            return
        self._busy_logged_at = now
        print(
            f"[ground-console] LAN view busy: {self.max_connections} requests open, "
            f"answered {address} with 503 (logged once a minute)",
            flush=True,
        )

    def service_actions(self) -> None:
        # serve_forever calls this at least every poll interval (0.5 s).
        super().service_actions()
        self.answered.sweep()

    def server_close(self) -> None:
        try:
            super().server_close()
        finally:
            self.answered.close()

    def server_bind(self) -> None:
        if self.address_family == socket.AF_INET6:
            # "::" also takes IPv4 clients (as IPv4-mapped peers); a literal
            # IPv6 address takes only its own family.
            try:
                self.socket.setsockopt(
                    socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0 if self.server_address[0] == "::" else 1,
                )
            except (AttributeError, OSError):
                pass
        # HTTPServer.server_bind would also resolve a host name (getfqdn),
        # which can wait on DNS inside a request that applies the setting.
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = port

    def admits(self, address: Any) -> bool:
        return lan.client_allowed(self.allowed, address)


# A bind that fails because the address is not on this host yet (a literal
# LAN address the network brings up after the console started at boot) or the
# port is still held is tried again while the setting stays enabled: after
# these delays, the last one repeating. Other errors stay closed until a save.
LAN_BIND_RETRY_ERRNOS = frozenset({errno.EADDRNOTAVAIL, errno.EADDRINUSE})
LAN_BIND_RETRY_DELAYS_S: Tuple[float, ...] = (5.0, 10.0, 20.0, 40.0, 60.0)


class LanAccessManager:
    """Opens, moves and closes the LAN view listener of one console."""

    def __init__(self, console: "GroundConsoleServer") -> None:
        self.console = console
        self._lock = threading.RLock()
        self._server: Optional[LanViewServer] = None
        self._thread: Optional[threading.Thread] = None
        self._settings: Dict[str, Any] = lan.default_settings()
        self._reason: Optional[str] = lan.CLOSED_DISABLED
        self._detail: Optional[str] = None
        self.refusals = lan.RefusalLog(lambda message: print(f"[ground-console] {message}", flush=True))
        # Bind retries: every apply() and close() starts a new generation,
        # which a pending retry of an older one ignores.
        self.retry_delays_s: Sequence[float] = LAN_BIND_RETRY_DELAYS_S
        self._generation = 0
        self._retry_timer: Optional[threading.Timer] = None
        self._retry_attempt = 0
        self._allowed_networks: List[lan.Network] = []

    def _closed_reason(self, settings: Dict[str, Any]) -> Optional[str]:
        if not settings.get("enabled"):
            return lan.CLOSED_DISABLED
        if not ADMIN_PASSWORD:
            return lan.CLOSED_ADMIN_DISABLED
        if ADMIN_PASSWORD == DEFAULT_ADMIN_PASSWORD:
            return lan.CLOSED_ADMIN_PASSWORD_DEFAULT
        if settings.get("port") == self.console.server_address[1]:
            return lan.CLOSED_PORT_CONFLICT
        return None

    def apply(self, settings: Dict[str, Any], *, allowed: Optional[Sequence[lan.Network]] = None) -> Dict[str, Any]:
        """Close the listener, then open it again for these settings when they allow it.

        ``settings`` is a validated lan_access block. ``allowed`` replaces the
        parsed allowed_clients; only tests pass it, to admit a loopback client.
        """
        with self._lock:
            self._new_generation_locked()
            self._close_locked()
            self._settings = dict(settings)
            self._detail = None
            reason = self._closed_reason(settings)
            if reason is not None:
                self._reason = reason
                if reason != lan.CLOSED_DISABLED:
                    _log_warning(f"lan_access is enabled but the LAN view stays closed: {lan.CLOSED_REASON_TEXT[reason]}")
                return self.status()
            self._allowed_networks = list(allowed) if allowed is not None else lan.networks(settings)
            return self._open_locked()

    def _open_locked(self) -> Dict[str, Any]:
        settings = self._settings
        allowed_networks = self._allowed_networks
        retry = self._retry_attempt > 0
        try:
            server = LanViewServer(self.console, (str(settings["bind"]), int(settings["port"])), allowed_networks, self.refusals)
        except OSError as exc:
            detail = (errno.errorcode.get(exc.errno) if exc.errno else None) or type(exc).__name__
            retryable = exc.errno in LAN_BIND_RETRY_ERRNOS
            if not retry or detail != self._detail:
                _log_warning(
                    f"the LAN view could not bind {settings['bind']}:{settings['port']} ({detail}); "
                    + ("it stays closed and the bind is tried again" if retryable else "it stays closed")
                )
            self._reason = lan.CLOSED_BIND_FAILED
            self._detail = detail
            if retryable:
                self._schedule_retry_locked()
            return self.status()
        self._retry_attempt = 0
        thread = threading.Thread(target=server.serve_forever, name="lan-view", daemon=True)
        thread.start()
        self._server = server
        self._thread = thread
        self._reason = None
        self._mirror_open(True)
        status = self.status()
        print(
            f"[ground-console] LAN view (read only) open on http://{status['address']}/ "
            f"for {len(allowed_networks)} allowed client entr{'y' if len(allowed_networks) == 1 else 'ies'}"
            + (" after a failed bind" if retry else ""),
            flush=True,
        )
        return status

    def _new_generation_locked(self) -> None:
        """Forget a pending bind retry; apply() and close() start afresh."""
        self._generation += 1
        self._retry_attempt = 0
        timer, self._retry_timer = self._retry_timer, None
        if timer is not None:
            timer.cancel()

    def _schedule_retry_locked(self) -> None:
        delays = list(self.retry_delays_s) or list(LAN_BIND_RETRY_DELAYS_S)
        delay = delays[min(self._retry_attempt, len(delays) - 1)]
        self._retry_attempt += 1
        timer = threading.Timer(delay, self._retry_bind, args=(self._generation,))
        timer.daemon = True
        timer.name = "lan-view-bind-retry"
        self._retry_timer = timer
        timer.start()

    def _retry_bind(self, generation: int) -> None:
        with self._lock:
            # A save or a stop in between owns the listener now.
            if generation != self._generation or self._server is not None:
                return
            self._retry_timer = None
            self._open_locked()

    def retry_pending(self) -> bool:
        """A failed bind waits to be tried again."""
        with self._lock:
            return self._retry_timer is not None

    def _close_locked(self) -> None:
        server, thread = self._server, self._thread
        self._server = None
        self._thread = None
        if server is None:
            return
        # Nothing mirrored outlives the LAN view it was published for: the
        # mirror refuses posts and forgets what it holds before the listener
        # stops, also a POST that found the view open a moment ago.
        self._mirror_open(False)
        try:
            server.shutdown()
        finally:
            server.server_close()
        if thread is not None:
            thread.join(timeout=5)
        print("[ground-console] LAN view closed", flush=True)

    def _mirror_open(self, opened: bool) -> None:
        mirror = getattr(self.console, "receiver_mirror", None)
        if mirror is None:
            return
        if opened:
            mirror.open()
        else:
            mirror.close()

    def is_open(self) -> bool:
        """The listener is open (the Receiver mirror is published only then)."""
        with self._lock:
            return self._server is not None

    def queue_marker_command(self, server: Any, command: Dict[str, Any]) -> Dict[str, Any]:
        """Queue a LAN viewer's marker command while ``server``, the listener that admitted it, is the open one.

        apply() replaces the listener on every change (allowed_clients, port,
        bind) and close() drops it, while a handler of the old one may still
        be reading its body (block_on_close is False). Such a command is
        refused as MIRROR_LAN_CLOSED, so a client the new settings no longer
        admit never gets a marker in. Under the manager's lock, so no apply()
        runs between the check and the queue (the same lock order as
        apply() closing the mirror).
        """
        with self._lock:
            if server is None or server is not self._server:
                raise rm.MirrorRejected(rm.MIRROR_LAN_CLOSED, rm.LAN_CLOSED_MESSAGE)
            return self.console.receiver_mirror.queue_marker_command(command)

    def close(self) -> None:
        """Close the listener for good (console stop)."""
        with self._lock:
            retrying = self._retry_timer is not None
            self._new_generation_locked()
            was_open = self._server is not None
            self._close_locked()
            if was_open or retrying:
                self._reason = lan.CLOSED_STOPPED
                self._detail = None

    def status(self) -> Dict[str, Any]:
        """The LAN view's state for /api/lan-access and the loopback capabilities."""
        with self._lock:
            server = self._server
            settings = self._settings
            address = None
            if server is not None:
                host, port = server.server_address[:2]
                address = f"[{host}]:{port}" if ":" in str(host) else f"{host}:{port}"
            return {
                "enabled": bool(settings.get("enabled")),
                "state": lan.STATE_OPEN if server is not None else lan.STATE_CLOSED,
                "reason": None if server is not None else self._reason,
                "detail": None if server is not None else self._detail,
                "bind": settings.get("bind"),
                "port": settings.get("port"),
                "address": address,
                "allowed_client_count": len(settings.get("allowed_clients") or []),
            }

    def brief_status(self) -> Dict[str, Any]:
        """The state without addresses, for /api/health and the LAN view's capabilities."""
        full = self.status()
        return {key: full[key] for key in ("enabled", "state", "reason")}


# /api/health reports receiver_busy while the Receiver writes records, so the
# updaters do not restart the console in the middle of a recording or scan:
# any Receiver write in the last RECEIVER_BUSY_WRITE_S, or an audio session or
# scan still open with a write in the store's stale window (after that a
# restart would close it as Interrupted anyway).
RECEIVER_BUSY_WRITE_S = 30.0
RECEIVER_BUSY_OPEN_S = float(STALE_RECORDING_SECONDS)


class ReceiverActivity:
    """In-memory record of Receiver writes for /api/health; reads no file."""

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self.clock = clock
        self._lock = threading.Lock()
        self._last_write: Optional[float] = None
        self._open: Set[str] = set()

    def wrote(self, opened: Optional[str] = None, closed: Optional[str] = None) -> None:
        """A Receiver write; ``opened``/``closed`` name a session or scan that starts or ends with it."""
        with self._lock:
            self._last_write = self.clock()
            if opened:
                self._open.add(opened)
            if closed:
                self._open.discard(closed)

    def busy(self) -> bool:
        with self._lock:
            if self._last_write is None:
                return False
            age = self.clock() - self._last_write
            if age < RECEIVER_BUSY_WRITE_S:
                return True
            return bool(self._open) and age < RECEIVER_BUSY_OPEN_S


class GroundConsoleServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        address: Tuple[str, int],
        base_url: str,
        mqtt_monitor: Optional[Any] = None,
        branding_path: Optional[str] = None,
        config_path: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None,
        frontend_dir: Optional[Path] = None,
        receiver_data_dir: Optional[Path] = None,
        preferences_path: Optional[str] = None,
        tile_cache_dir: Optional[Path] = None,
        tile_cache_max_mb: int = DEFAULT_TILE_CACHE_MAX_MB,
        tile_sources: Optional[Dict[str, TileSource]] = None,
        retention_interval_s: float = ra.RETENTION_INTERVAL_S,
        retention_start_delay_s: float = ra.RETENTION_START_DELAY_S,
        data_out_fetcher: Optional[Callable[..., Any]] = None,
        saved_config: Optional[Dict[str, Any]] = None,
        host_power_dir: Optional[Path] = None,
    ):
        self.frontend_dir = Path(frontend_dir).resolve() if frontend_dir is not None else None
        if not _is_loopback_bind(address[0]):
            raise ValueError("Ground Console must bind to loopback; admin branding is local-only")
        if not isinstance(base_url, str):
            raise ValueError("base_url must be a string")
        self.config_path = Path(config_path).expanduser() if config_path else DEFAULT_CONFIG_PATH
        fallback = _default_console_config(base_url.rstrip("/"), refresh_seconds=DEFAULT_REFRESH_SECONDS)
        self._config = _validate_console_config(config, fallback) if config is not None else _load_console_config(self.config_path, fallback)
        # base_url is the fallback URL; it has to be in the host list in use.
        check_data_out_url(base_url, self._config["data_out_hosts"])
        # One-shot mDNS for a .local Data Out host the system resolver cannot
        # answer (the Docker image has no nss-mdns). Tests replace it.
        self.mdns_resolver: Any = MdnsResolver()
        self._config_lock = threading.RLock()
        self.mqtt_monitor = mqtt_monitor
        if mqtt_monitor is not None:
            self._config["mqtt_host"] = str(getattr(mqtt_monitor, "host", ""))
            self._config["mqtt_port"] = int(getattr(mqtt_monitor, "port", 1883))
            transport = getattr(mqtt_monitor, "transport", None)
            if transport in ALLOWED_MQTT_TRANSPORTS:
                self._config["mqtt_transport"] = transport
            ws_path = getattr(mqtt_monitor, "ws_path", None)
            if _is_allowed_mqtt_ws_path(ws_path):
                self._config["mqtt_ws_path"] = ws_path
        # console.json as saved, without the --base-url/--mqtt-* flags main()
        # merged into ``config`` for this run. A save writes only the fields
        # it changes into this copy (_saved_copy_locked), so a flag never
        # reaches the file. Without it the active config is the saved one.
        self._saved_config = (
            _validate_console_config(saved_config, self._config) if saved_config is not None else dict(self._config)
        )
        self.branding_path = Path(branding_path).expanduser() if branding_path else DEFAULT_BRANDING_PATH
        self._branding_lock = threading.RLock()
        self._branding = _load_branding(self.branding_path)
        # Without an explicit path the preferences sit next to console.json,
        # so a server with a temporary config never touches the real home.
        if preferences_path:
            resolved_preferences = Path(preferences_path).expanduser()
        elif config_path:
            resolved_preferences = self.config_path.with_name(DEFAULT_PREFERENCES_PATH.name)
        else:
            resolved_preferences = DEFAULT_PREFERENCES_PATH
        self.preferences = PreferencesStore(resolved_preferences)
        self.version = CONSOLE_VERSION
        # Like the preferences: without an explicit directory the tiles sit
        # next to console.json, so a test server never fills the real cache.
        # tile_sources replaces the fixed upstreams only for tests and local
        # QA launchers (a loopback fake); the command line cannot change them.
        if tile_cache_dir is not None:
            resolved_tiles = Path(tile_cache_dir).expanduser()
        elif config_path:
            resolved_tiles = self.config_path.with_name("tiles")
        else:
            resolved_tiles = DEFAULT_TILE_CACHE_DIR
        if not isinstance(tile_cache_max_mb, int) or not 0 <= tile_cache_max_mb <= MAX_TILE_CACHE_MB:
            raise ValueError(f"tile cache size must be 0..{MAX_TILE_CACHE_MB} MB")
        self.tile_cache = TileCache(
            resolved_tiles,
            tile_cache_max_mb * 1024 * 1024,
            sources=tile_sources,
            user_agent=f"SDR-DoA-Ground-Console/{CONSOLE_VERSION}",
            log=lambda message: print(f"[ground-console] {message}", flush=True),
        )
        self._session_lock = threading.RLock()
        self._admin_sessions: Dict[str, float] = {}
        # Failed-login throttle, global to this server and kept under
        # _session_lock. Tests may replace the clock.
        self.monotonic: Callable[[], float] = time.monotonic
        self._login_failures: List[float] = []
        self._login_locked_until = 0.0
        # Wall clock for Kontrol command issue and expiry times; tests may
        # replace it to step past a command's expiry.
        self.clock_ms: Callable[[], int] = lambda: int(time.time() * 1000)
        self.config_commands = ConfigCommandTracker(clock_ms=lambda: self.clock_ms())
        # One Kontrol command is checked and published at a time, so two
        # requests cannot both pass the in-flight check.
        self._config_patch_lock = threading.Lock()
        self.node_progress = NodeProgressTracker()
        # One Data Out read serves every viewer (data_out_reader.py); the
        # collector reuses settings.json through settings_cache.
        # data_out_fetcher replaces the HTTP GETs only for tests (a loopback
        # fake node); the command line cannot set it.
        self.settings_cache = SettingsCache()
        self._data_out_fetcher = data_out_fetcher
        # MQTT first (issue #8): while the RDF Node's health is fresh the
        # answers come from the monitor and only a light Data Out read runs.
        self.data_out = DataOutReader(
            self._collect_data_out,
            refresh_seconds=lambda: self._config.get("refresh_seconds"),
            wait_timeout_s=SNAPSHOT_TOTAL_BUDGET_S + SNAPSHOT_WAIT_GRACE_S,
            console_base_url=lambda: self._config.get("base_url"),
            collect_light=self._collect_light_data_out,
            mqtt_view=self._mqtt_view,
        )
        self.receiver_store = ReceiverRecordStore(
            receiver_data_dir if receiver_data_dir is not None else DEFAULT_DATA_DIR,
            log=lambda message: print(message, flush=True),
        )
        self.receiver_activity = ReceiverActivity()
        # Prepared Records ZIPs (single use, 120 s) and the two stream slots
        # shared by selection and single-scan ZIPs.
        self.archive_exports = ra.ArchiveExports()
        self.archive_export_slots = threading.BoundedSemaphore(ra.EXPORT_SLOTS)
        # The LAN view's own scan ZIP slot, so a tablet never takes the groundstation's two.
        self.lan_records_zip_slots = threading.BoundedSemaphore(lan.RECORDS_ZIP_SLOTS)
        self._retention_scheduler: Optional[ra.RetentionScheduler] = None
        # The Receiver mirror (receiver_mirror.py): the kiosk page's latest
        # Receiver state and frame for the LAN view, in memory only.
        self.receiver_mirror = rm.ReceiverMirror()
        # Restart and Shutdown of this host (host_power.py): request files for
        # the host helper; None (the default here, and in tests) turns them off.
        self.host_power = hp.HostPower(host_power_dir)
        # The opt-in LAN view: a second listener of this process
        # (lan_access.py). It opens below, once this loopback socket is bound.
        self.lan = LanAccessManager(self)
        # One lan_access change is saved and applied at a time, so the saved
        # setting and the open listener always agree.
        self._lan_apply_lock = threading.Lock()
        super().__init__(address, ConsoleHandler)
        # Only once the socket is bound: a failed bind leaves no thread. The
        # first pass waits, so it never delays the first answer or the
        # healthcheck, and a clock that NTP corrects right after boot is in use.
        self._retention_scheduler = ra.RetentionScheduler(
            self.run_retention,
            interval_s=retention_interval_s,
            start_delay_s=retention_start_delay_s,
            log=lambda message: print(message, flush=True),
        )
        self._retention_scheduler.start()
        # An enabled LAN view opens now, unless the admin password is the
        # default or admin login is disabled; the status and the log say why.
        self.lan.apply(self._config["lan_access"])

    def run_retention(self) -> Optional[Dict[str, Any]]:
        """One background retention pass (no time budget beyond the per-pass item bound)."""
        return self.receiver_store.apply_retention()

    def wake_retention(self) -> None:
        scheduler = self._retention_scheduler
        if scheduler is not None:
            scheduler.wake()

    def stop_retention(self) -> None:
        scheduler = getattr(self, "_retention_scheduler", None)
        if scheduler is not None:
            scheduler.stop()

    def server_close(self) -> None:
        try:
            # The LAN view closes with the console (server_close, SIGTERM).
            lan_manager = getattr(self, "lan", None)
            if lan_manager is not None:
                lan_manager.close()
            # The scheduler stops before the store closes. TCPServer calls this
            # on a failed bind too, before the scheduler exists.
            scheduler = getattr(self, "_retention_scheduler", None)
            if scheduler is not None:
                scheduler.stop()
            store = getattr(self, "receiver_store", None)
            if store is not None:
                store.close()
        finally:
            super().server_close()

    def collect_snapshot(self, base_url: str, request: Optional[SnapshotRequest] = None) -> Dict[str, Any]:
        """Answer /api/snapshot: from MQTT while it is fresh, else Data Out.

        While MQTT is fresh only a light Data Out read runs (at most every
        30 s); otherwise every viewer gets the last collection while it is
        younger than the reuse window (the saved refresh interval, at least
        1 s) and concurrent misses share one collection. See
        data_out_reader.py and telemetry_source.py.
        """
        return self.data_out.snapshot(base_url, request or SnapshotRequest())

    def _mqtt_view(self) -> Optional[Dict[str, Any]]:
        """The monitor's RDF Node view for the telemetry source, or None without one."""
        reader = getattr(self.mqtt_monitor, "rdf_node_view", None)
        if reader is None:
            return None
        view = reader()
        return view if isinstance(view, dict) else None

    def _collect_light_data_out(self, base_url: str, fresh_settings: bool) -> Dict[str, Any]:
        """status.json, settings.json and doa.xml while MQTT carries the DoA."""
        options: Dict[str, Any] = {}
        if self._data_out_fetcher is not None:
            options["fetcher"] = self._data_out_fetcher
        return collect_light(
            base_url=base_url,
            total_budget_s=SNAPSHOT_TOTAL_BUDGET_S,
            settings_cache=self.settings_cache,
            fresh_settings=fresh_settings,
            allowed_hosts=self.data_out_hosts,
            mdns_resolver=self.mdns_resolver,
            **options,
        )

    def _collect_data_out(self, base_url: str, fresh_settings: bool) -> Dict[str, Any]:
        options: Dict[str, Any] = {}
        if self._data_out_fetcher is not None:
            options["fetcher"] = self._data_out_fetcher
        return collect(
            base_url=base_url,
            authority="none",
            clock_source="remote_unverified",
            total_budget_s=SNAPSHOT_TOTAL_BUDGET_S,
            progress_tracker=self.node_progress,
            settings_cache=self.settings_cache,
            fresh_settings=fresh_settings,
            allowed_hosts=self.data_out_hosts,
            mdns_resolver=self.mdns_resolver,
            **options,
        )

    @property
    def base_url(self) -> str:
        return str(self._config["base_url"])

    @property
    def data_out_hosts(self) -> List[str]:
        with self._config_lock:
            return list(self._config["data_out_hosts"])

    def get_config(self) -> Dict[str, Any]:
        with self._config_lock:
            return dict(self._config)

    def update_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        with self._config_lock:
            # lan_access changes only through set_lan_access().
            normalized = _validate_console_config({**config, "lan_access": self._config["lan_access"]}, self._config)
            saved = self._saved_copy_locked(normalized)
            _save_console_config(self.config_path, saved)
            self._saved_config = saved
            self._config = normalized
            return dict(self._config)

    def _saved_copy_locked(self, active: Dict[str, Any]) -> Dict[str, Any]:
        """Return console.json for the new active config ``active``.

        Only the fields ``active`` changes go into the saved copy; a field it
        leaves alone keeps its saved value, so a --base-url or --mqtt-* flag of
        this run is never written by a save of another field (the LAN access
        card, the refresh interval, the MQTT form). A field the save does
        change is saved as given and ends that flag's override. When the host
        list no longer has the saved Data Out URL's host, the URL in use is
        saved with it, the only one that fits the list.
        """
        saved = dict(self._saved_config)
        for field, value in active.items():
            if value != self._config.get(field):
                saved[field] = value
        try:
            return _validate_console_config(saved, self._saved_config)
        except DataOutHostError:
            _log_warning(
                f"the saved Data Out URL {self._saved_config['base_url']} has no host in the new list; "
                f"saving the URL in use, {active['base_url']}"
            )
            saved["base_url"] = active["base_url"]
            return _validate_console_config(saved, self._saved_config)

    def lan_access_view(self) -> Dict[str, Any]:
        """Body of GET /api/lan-access: the saved setting and the listener's state."""
        with self._config_lock:
            settings = dict(self._config["lan_access"])
        return {"config": settings, "status": self.lan.status()}

    def set_lan_access(self, payload: Any) -> Dict[str, Any]:
        """Validate, save and apply a lan_access change (POST /api/lan-access).

        Fields the payload leaves out keep their saved value. Enabling is
        refused while the default admin password is in use. The listener
        opens, moves or closes at once; a bind that fails leaves it closed
        with the reason in the returned status.
        """
        with self._lan_apply_lock:
            with self._config_lock:
                current = self._config["lan_access"]
                try:
                    settings = lan.validate_settings(payload, current, console_port=self.server_address[1])
                except ValueError as exc:
                    raise LanAccessRejected(HTTPStatus.BAD_REQUEST, lan.LAN_ACCESS_INVALID, str(exc)) from exc
                if settings["enabled"] and ADMIN_PASSWORD == DEFAULT_ADMIN_PASSWORD:
                    raise LanAccessRejected(
                        HTTPStatus.CONFLICT,
                        lan.LAN_ADMIN_PASSWORD_DEFAULT,
                        "the LAN view stays off while the default admin password is in use; set SDR_DOA_ADMIN_PASSWORD and restart the console",
                    )
                config = {**self._config, "lan_access": settings}
                saved = self._saved_copy_locked(config)
                try:
                    _save_console_config(self.config_path, saved)
                except OSError as exc:
                    raise LanAccessRejected(
                        HTTPStatus.INTERNAL_SERVER_ERROR,
                        lan.LAN_ACCESS_SAVE_FAILED,
                        f"lan_access could not be saved ({type(exc).__name__})",
                    ) from exc
                self._saved_config = saved
                self._config = config
            status = self.lan.apply(settings)
        return {"config": dict(settings), "status": status}

    def apply_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Persist local console config and reconcile its local MQTT monitor."""
        return self._apply_config(config, restart_monitor=False)[0]

    def _apply_config(
        self,
        config: Dict[str, Any],
        *,
        restart_monitor: bool,
    ) -> Tuple[Dict[str, Any], Optional[Any]]:
        """Return the saved config and the monitor it selected.

        ``restart_monitor`` replaces the monitor even when its target is
        unchanged, so an operator reconnect does not wait for paho's backoff.
        """
        retired: Optional[Any] = None
        try:
            with self._config_lock:
                # lan_access changes only through set_lan_access(); a config
                # read before a concurrent change must not put the old one back.
                normalized = _validate_console_config({**config, "lan_access": self._config["lan_access"]}, self._config)
                old_connection = _mqtt_connection(self._config)
                new_connection = _mqtt_connection(normalized)
                new_host = new_connection[0]
                monitor_changed = (
                    restart_monitor
                    or old_connection != new_connection
                    or bool(new_host) != (self.mqtt_monitor is not None)
                )
                saved = self._saved_copy_locked(normalized)
                replacement = None
                if monitor_changed and new_host:
                    replacement = _new_mqtt_monitor(*new_connection)
                    # Before start(), so no ACK or settings report of a
                    # pending command reaches the new client unasked.
                    self.config_commands.hand_over(self.mqtt_monitor, replacement)
                    replacement.start()
                try:
                    _save_console_config(self.config_path, saved)
                except Exception:
                    retired = replacement
                    raise
                if monitor_changed:
                    # Again under the command lock, for a command published
                    # since: none can slip in before the swap. The ACKs of a
                    # pending command reach only the new client.
                    with self._config_patch_lock:
                        self.config_commands.hand_over(self.mqtt_monitor, replacement)
                        retired = self.mqtt_monitor
                        self.mqtt_monitor = replacement
                self._saved_config = saved
                self._config = normalized
                return dict(self._config), self.mqtt_monitor
        finally:
            # stop() joins the paho thread, which can take seconds while it is
            # connecting to an unreachable broker; never hold the config lock.
            if retired is not None:
                retired.stop()

    def get_branding(self) -> Dict[str, str]:
        with self._branding_lock:
            return dict(self._branding)

    def update_branding(self, branding: Dict[str, str]) -> None:
        normalized = {
            "app_name": _normalize_app_name(branding.get("app_name")),
            "logo_data_url": _normalize_logo_data_url(branding.get("logo_data_url", "")),
        }
        _save_branding(self.branding_path, normalized)
        with self._branding_lock:
            self._branding = normalized

    def create_admin_session(self, password: Any) -> Optional[str]:
        if not isinstance(password, str) or not isinstance(ADMIN_PASSWORD, str) or not ADMIN_PASSWORD:
            return None
        try:
            # Bytes, because compare_digest refuses non-ASCII str; a lone
            # surrogate from JSON cannot be encoded and is simply wrong.
            matches = hmac.compare_digest(password.encode("utf-8"), ADMIN_PASSWORD.encode("utf-8"))
        except (TypeError, ValueError):
            return None
        if not matches:
            return None
        token = secrets.token_urlsafe(32)
        with self._session_lock:
            now = time.time()
            self._admin_sessions = {key: expiry for key, expiry in self._admin_sessions.items() if expiry > now}
            self._admin_sessions[token] = now + ADMIN_SESSION_TTL_SECONDS
        return token

    def attempt_admin_login(self, password: Any) -> Tuple[Optional[str], float]:
        """Return (token, 0) on success, (None, 0) for a wrong password, or
        (None, seconds) while failed logins are throttled.

        After ADMIN_LOGIN_MAX_FAILURES failures inside the window, every login
        is refused for ADMIN_LOGIN_LOCKOUT_S, the correct password included.
        """
        with self._session_lock:
            now = self.monotonic()
            if self._login_locked_until > now:
                return None, self._login_locked_until - now
            try:
                token = self.create_admin_session(password)
            except (TypeError, ValueError):
                token = None
            if token is not None:
                self._login_failures.clear()
                return token, 0.0
            self._login_failures = [
                failed_at for failed_at in self._login_failures
                if now - failed_at < ADMIN_LOGIN_FAILURE_WINDOW_S
            ]
            self._login_failures.append(now)
            if len(self._login_failures) >= ADMIN_LOGIN_MAX_FAILURES:
                self._login_failures.clear()
                self._login_locked_until = now + ADMIN_LOGIN_LOCKOUT_S
            return None, 0.0

    def is_admin_token(self, token: str) -> bool:
        if not token:
            return False
        with self._session_lock:
            expiry = self._admin_sessions.get(token)
            if expiry is None:
                return False
            if expiry <= time.time():
                self._admin_sessions.pop(token, None)
                return False
            return True

    def revoke_admin_session(self, token: str) -> None:
        if token:
            with self._session_lock:
                self._admin_sessions.pop(token, None)

    def config_reported(self) -> Dict[str, Any]:
        """Body of GET /api/mqtt/config-reported; always a 200 payload.

        Kontrol's view of the node: the MQTT connection, the node session
        (``state.sid``, ``state.cfg`` as ``base_rev``, health freshness), the
        latest ``settings/reported`` (its safe values only while its ``rev``
        is ``state.cfg``), the patch in flight and the latest ``config.get``.
        """
        monitor = self.mqtt_monitor
        config = self.get_config()
        now = self.clock_ms()
        empty = {field: None for field in cmds.PATCH_FIELDS}
        body: Dict[str, Any] = {
            "available": False,
            "code": None,
            "now_ms": now,
            "broker": {
                "host": getattr(monitor, "host", None) if monitor is not None else (config.get("mqtt_host") or None),
                "port": getattr(monitor, "port", None) if monitor is not None else config.get("mqtt_port"),
                "transport": getattr(monitor, "transport", None) if monitor is not None else config.get("mqtt_transport"),
                "connection": "disabled",
            },
            "node": None,
            "base_rev": None,
            "settings": None,
            "values": dict(empty),
            "value_sources": dict(empty),
            "value_received_at_ms": dict(empty),
            "pending_command_id": self.config_commands.in_flight(monitor),
            "settings_request": self.config_commands.latest(monitor, op=cmds.OP_CONFIG_GET),
        }
        if monitor is None:
            body["code"] = "MQTT_MONITOR_DISABLED"
            return body
        view = _monitor_control_view(monitor) if _monitor_can_publish(monitor) else None
        if view is None or view.get("available") is not True:
            body["code"] = "MQTT_DEPENDENCY_MISSING"
            body["broker"]["connection"] = "error"
            return body
        connection = view.get("connection")
        body["broker"]["connection"] = connection if isinstance(connection, str) and connection else "unknown"
        view_now = _int_or_none(view.get("now_ms")) or now
        session = _session_or_none(view)
        node = _node_view(session, view_now)
        settings = _settings_view(view.get("settings"), view_now)
        body.update(available=True, node=node, base_rev=None if node is None else node["cfg"], settings=settings)
        if settings is not None and settings["matches_state_cfg"]:
            for field, value in settings["values"].items():
                if value is not None:
                    body["values"][field] = value
                    body["value_sources"][field] = "settings_reported"
                    body["value_received_at_ms"][field] = settings["received_at_ms"]
        return body

    def submit_config_patch(self, payload: Any) -> Tuple[int, Dict[str, Any]]:
        """POST /api/mqtt/config-patch after Origin and admin; returns (status, body)."""
        try:
            changes, requested_rev = _parse_config_patch_request(payload)
            with self._config_patch_lock:
                return self._publish_command_locked(cmds.OP_CONFIG_PATCH, changes=changes, requested_rev=requested_rev)
        except ConfigPatchRejected as rejected:
            return rejected.status, rejected.body()

    def submit_config_get(self, payload: Any) -> Tuple[int, Dict[str, Any]]:
        """POST /api/mqtt/config-get after Origin and admin; returns (status, body)."""
        try:
            if not isinstance(payload, dict) or payload:
                raise ConfigPatchRejected(
                    HTTPStatus.BAD_REQUEST, "INVALID_REQUEST", "request must be an empty JSON object",
                )
            with self._config_patch_lock:
                return self._publish_command_locked(cmds.OP_CONFIG_GET)
        except ConfigPatchRejected as rejected:
            return rejected.status, rejected.body()

    def _publish_command_locked(
        self,
        op: str,
        *,
        changes: Optional[Dict[str, Any]] = None,
        requested_rev: Optional[int] = None,
    ) -> Tuple[int, Dict[str, Any]]:
        """The monitor, node and in-flight checks, then the publish; the first failure wins."""
        monitor = self.mqtt_monitor
        if monitor is None:
            raise ConfigPatchRejected(
                HTTPStatus.CONFLICT, "MQTT_MONITOR_DISABLED", "the MQTT monitor is off; set an MQTT host first",
            )
        view = _monitor_control_view(monitor) if _monitor_can_publish(monitor) else None
        if view is None or view.get("available") is not True:
            raise ConfigPatchRejected(
                HTTPStatus.SERVICE_UNAVAILABLE, "MQTT_DEPENDENCY_MISSING", MQTT_DEPENDENCY_ERROR,
            )
        if view.get("connection") != "connected":
            raise ConfigPatchRejected(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "MQTT_NOT_CONNECTED",
                "the MQTT monitor is not connected with its subscriptions acknowledged",
            )
        session = _session_or_none(view)
        if session is None:
            raise ConfigPatchRejected(
                HTTPStatus.CONFLICT,
                "NODE_SESSION_UNAVAILABLE",
                "no RDF Node state (sid, boot) has been received; a command must name the node session",
            )
        base_rev = _int_or_none(session.get("cfg"))
        if op == cmds.OP_CONFIG_PATCH:
            if session.get("health_fresh") is not True:
                raise ConfigPatchRejected(
                    HTTPStatus.CONFLICT,
                    "NODE_NOT_FRESH",
                    "the RDF Node sent no fresh telemetry/health; a config patch needs a live node",
                )
            if base_rev is None:
                raise ConfigPatchRejected(
                    HTTPStatus.CONFLICT,
                    "CONFIG_REVISION_UNKNOWN",
                    "the RDF Node state carries no config revision (state.cfg) yet",
                )
            if requested_rev != base_rev:
                raise ConfigPatchRejected(
                    HTTPStatus.CONFLICT,
                    "CONFIG_REVISION_STALE",
                    "the reviewed base revision is no longer the node's; read the values again",
                    current_base_rev=base_rev,
                )
            pending = self.config_commands.in_flight(monitor, cmds.OP_CONFIG_PATCH)
            if pending is not None:
                raise ConfigPatchRejected(
                    HTTPStatus.CONFLICT,
                    "COMMAND_IN_FLIGHT",
                    "another config patch is still waiting for its result",
                    command_id=pending,
                )
        else:
            pending = self.config_commands.in_flight(monitor, cmds.OP_CONFIG_GET)
            if pending is not None:
                raise ConfigPatchRejected(
                    HTTPStatus.CONFLICT,
                    "SETTINGS_REQUEST_PENDING",
                    "the last settings request is still waiting for its answer",
                    command_id=pending,
                )
            last = self.config_commands.last_issued_at(cmds.OP_CONFIG_GET)
            if last is not None and self.clock_ms() - last < CONFIG_GET_MIN_INTERVAL_MS:
                raise ConfigPatchRejected(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    "CONFIG_GET_TOO_SOON",
                    "the RDF Node answers at most one settings request a second",
                )
        issued = int(self.clock_ms())
        command = cmds.build_command(
            op,
            command_id=cmds.new_command_id(),
            sid=session["sid"],
            boot=session["boot"],
            base_rev=base_rev,
            issued_ms=issued,
            changes=changes,
        )
        try:
            cmds.validate_command(command, now_ms=issued)
        except cmds.CommandRefused as refused:
            raise ConfigPatchRejected(HTTPStatus.BAD_REQUEST, "INVALID_REQUEST", refused.message) from refused
        topic = cmds.command_topic(_monitor_node_id(monitor), op)
        try:
            result = monitor.publish_rdf_node_command(command)
        except Exception as exc:
            # Match on the code, not the class: the monitor module may be
            # loaded under another package name than this one.
            code = getattr(exc, "code", None)
            self.config_commands.record(command, monitor, topic=topic, publish_failed=True)
            if code in {"MQTT_NOT_CONNECTED", "MQTT_DEPENDENCY_MISSING"}:
                raise ConfigPatchRejected(
                    HTTPStatus.SERVICE_UNAVAILABLE, code, str(exc) or code, command_id=command["id"],
                ) from exc
            raise ConfigPatchRejected(
                HTTPStatus.BAD_GATEWAY,
                "MQTT_PUBLISH_FAILED",
                f"MQTT publish failed: {exc}" if str(exc) else "MQTT publish failed",
                command_id=command["id"],
            ) from exc
        published_at = result.get("published_at_ms") if isinstance(result, dict) else None
        published_topic = result.get("topic") if isinstance(result, dict) else None
        if isinstance(published_topic, str):
            topic = published_topic
        self.config_commands.record(
            command,
            monitor,
            topic=topic,
            published_at_ms=published_at if type(published_at) is int else issued,
        )
        return HTTPStatus.ACCEPTED, {
            "ok": True,
            "command_id": command["id"],
            "op": op,
            "state": "published",
            "topic": topic,
            "qos": cmds.COMMAND_QOS,
            "base_rev": command["base_rev"],
            "issued_ms": command["issued_ms"],
            "expires_ms": command["expires_ms"],
            "ttl_ms": cmds.COMMAND_TTL_MS,
            "changes": dict(command.get("changes") or {}),
        }

    def enable_mqtt_monitor(
        self,
        host: str,
        port: int,
        transport: Optional[str] = None,
        ws_path: Optional[str] = None,
    ) -> Any:
        """Start a fresh monitor for this target and return it."""
        # Use the same validated/reconciled path as the Settings form.
        update: Dict[str, Any] = {"mqtt_host": host, "mqtt_port": port}
        if transport is not None:
            update["mqtt_transport"] = transport
        if ws_path is not None:
            update["mqtt_ws_path"] = ws_path
        return self._apply_config({**self.get_config(), **update}, restart_monitor=True)[1]


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Local SDR-DoA Ground Console: read-only Data Out, an MQTT monitor, "
            "and Kontrol's admin-confirmed RDF Node config patch"
        )
    )
    parser.add_argument(
        "--base-url",
        default="http://doasdr.local:8081",
        help="SDR-DoA Data Out base URL for this run (port 8081, a host in the saved Data Out host list)",
    )
    parser.add_argument("--legacy-ui", action="store_true", help="use the previous embedded UI instead of the frontend build")
    parser.add_argument("--bind", default=DEFAULT_BIND, help="local bind address")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="local console port")
    parser.add_argument(
        "--mqtt-host",
        default="10.90.0.1",
        help=(
            "MQTT broker IPv4/IPv6 address or localhost; the monitor subscribes and publishes "
            "only an admin-confirmed config patch"
        ),
    )
    parser.add_argument("--mqtt-port", type=int, default=9001, help="MQTT broker port")
    parser.add_argument(
        "--mqtt-transport",
        choices=ALLOWED_MQTT_TRANSPORTS,
        default="websockets",
        help="MQTT transport for the monitor (no TLS or credentials)",
    )
    parser.add_argument("--mqtt-ws-path", default=DEFAULT_MQTT_WS_PATH, help="MQTT WebSocket path when --mqtt-transport is websockets")
    parser.add_argument("--branding-path", default=str(DEFAULT_BRANDING_PATH), help="local branding JSON path")
    parser.add_argument(
        "--config-path",
        default=str(DEFAULT_CONFIG_PATH),
        help="local console connection config path; created from SDR_DOA_SEED_* on the first start",
    )
    parser.add_argument(
        "--preferences-path",
        default=str(DEFAULT_PREFERENCES_PATH),
        help="local JSON file that keeps the operator's browser preferences",
    )
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR), help="local Receiver records and audio directory")
    parser.add_argument(
        "--tile-cache-dir",
        default=str(DEFAULT_TILE_CACHE_DIR),
        help="local directory for cached basemap tiles (kept so the map works offline)",
    )
    parser.add_argument(
        "--tile-cache-max-mb",
        type=int,
        default=DEFAULT_TILE_CACHE_MAX_MB,
        help="size limit of the tile cache in MB; the least recently used tiles go first (0 keeps none)",
    )
    parser.add_argument(
        "--env-file",
        default=str(DEFAULT_ENV_PATH),
        help="dotenv file for SDR_DOA_ADMIN_PASSWORD and SDR_DOA_SEED_* (the process environment wins)",
    )
    parser.add_argument(
        "--host-power-dir",
        default=hp.DEFAULT_DIR,
        help="directory for the top bar's Restart and Shutdown requests, which packaging/host-power acts on (empty: off)",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    global ADMIN_PASSWORD
    args = _build_parser().parse_args(argv)
    if not (1 <= args.port <= 65535):
        raise SystemExit("port must be between 1 and 65535")
    if not _is_loopback_bind(args.bind):
        raise SystemExit("--bind must be localhost or a loopback address; admin branding is local-only")
    if args.mqtt_host and not _is_allowed_mqtt_host(args.mqtt_host):
        raise SystemExit("--mqtt-host must be empty, localhost, or a valid IPv4/IPv6 address")
    if not (1 <= args.mqtt_port <= 65535):
        raise SystemExit("--mqtt-port must be between 1 and 65535")
    if not _is_allowed_mqtt_ws_path(args.mqtt_ws_path):
        raise SystemExit("--mqtt-ws-path must start with / and use only letters, digits, and ._~/-")
    if not (0 <= args.tile_cache_max_mb <= MAX_TILE_CACHE_MB):
        raise SystemExit(f"--tile-cache-max-mb must be between 0 and {MAX_TILE_CACHE_MB}")
    env_path = Path(args.env_file).expanduser()
    env_values, env_readable = _read_env_file(env_path)
    if env_path.resolve() != DEFAULT_ENV_PATH.resolve():
        # The import resolved the password from the default .env; this run
        # names another file. An unreadable one disables login, as before.
        ADMIN_PASSWORD = _admin_password_from_sources(
            dotenv_values=env_values if env_readable else None,
            dotenv_path=env_path,
        ) or None
    config_path = Path(args.config_path).expanduser()
    # Saved settings first (seeded and saved on the first start); a typed
    # --base-url or --mqtt-* flag then overrides them for this run only.
    saved_config = _initial_console_config(config_path, dotenv_values=env_values)
    try:
        # A typed --base-url is checked against the saved host list (on a
        # first start the one just seeded, which is the defaults without a seed).
        config = _apply_cli_overrides(saved_config, args, _explicit_cli_options(argv))
    except DataOutHostError as exc:
        raise SystemExit(f"--base-url: {exc}; the list is data_out_hosts in {config_path} (Konfigurasi)") from None
    monitor = _new_mqtt_monitor(*_mqtt_connection(config)) if config["mqtt_host"] else None
    if isinstance(monitor, _UnavailableMqttMonitor):
        print(f"MQTT monitor unavailable: {monitor.error}", flush=True)
    if monitor is not None:
        monitor.start()
    server = GroundConsoleServer(
        (args.bind, args.port),
        config["base_url"],
        monitor,
        args.branding_path,
        str(config_path),
        config,
        frontend_dir=None if args.legacy_ui else PROJECT_ROOT / "frontend" / "dist",
        receiver_data_dir=Path(args.data_dir).expanduser(),
        preferences_path=str(Path(args.preferences_path).expanduser()),
        tile_cache_dir=Path(args.tile_cache_dir).expanduser(),
        tile_cache_max_mb=args.tile_cache_max_mb,
        saved_config=saved_config,
        host_power_dir=Path(args.host_power_dir).expanduser() if args.host_power_dir else None,
    )
    print(f"Ground Console: http://{args.bind}:{args.port}/", flush=True)
    print(f"Version: {server.version}", flush=True)
    print(f"Saved settings: {config_path}, {server.branding_path}, {server.preferences.path}", flush=True)
    print(f"Tile cache: {server.tile_cache.cache_dir} (at most {args.tile_cache_max_mb} MB)", flush=True)
    power = server.host_power.status()
    print(f"Host power: {args.host_power_dir or 'off'} ({'ready' if power['available'] else power['reason']})", flush=True)
    print(f"Read-only Data Out: {config['base_url']}", flush=True)
    if ADMIN_PASSWORD == DEFAULT_ADMIN_PASSWORD:
        print(
            "Warning: the default admin password is in use. Admin unlocks the config-patch send "
            f"to the Raspberry; set your own SDR_DOA_ADMIN_PASSWORD in {env_path}.",
            flush=True,
        )
    # docker stop and systemctl stop send SIGTERM. Python as PID 1 in the
    # container would ignore it without a handler, and natively its default
    # ends the process at once; both cut a Receiver write in half. A second
    # SIGTERM during the stop is ignored.
    def _terminate(signum: int, frame: Any) -> None:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise KeyboardInterrupt

    previous_sigterm = signal.signal(signal.SIGTERM, _terminate)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nGround Console stopped", flush=True)
    finally:
        if server.mqtt_monitor is not None:
            server.mqtt_monitor.stop()
        server.stop_retention()
        # Wait for a Receiver write in progress (an audio chunk is fsynced,
        # then counted in the database) and let none start after it, so the
        # stop never leaves a segment file longer than its metadata. Request
        # threads are daemons and end with the process.
        with server.receiver_store._lock:
            server.server_close()
        signal.signal(signal.SIGTERM, previous_sigterm)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
