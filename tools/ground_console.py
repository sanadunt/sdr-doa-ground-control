#!/usr/bin/env python3
"""Local Ground Console for staged SDR-DoA inspection.

The console is intentionally safe at this stage:

* it performs bounded read-only GETs through ``sdr_doa_collector``;
* an optional MQTT monitor subscribes read-only to its configured broker;
* it exposes no MQTT publish path and no route that writes to the Raspberry;
* the settings form only validates and renders a dry-run config patch;
* local admin settings only change this console's branding.

Run from the repository root, for example:

    python3 tools/ground_console.py \\
        --base-url http://192.168.100.100:8081 \\
        --bind 127.0.0.1 --port 8787 \\
        --mqtt-host 127.0.0.1 --mqtt-port 1883
"""

from __future__ import annotations

import argparse
import base64
import hmac
import ipaddress
import json
import os
import re
import secrets
import tempfile
import threading
import time
import uuid
import zlib
from html import escape
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qs, urlsplit

from sdr_doa_collector import CollectorError, DEFAULT_ALLOWED_DATA_HOSTS, collect

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ENV_PATH = PROJECT_ROOT / ".env"
_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _read_dotenv(path: Path = DEFAULT_ENV_PATH) -> Dict[str, str]:
    """Read a small, dependency-free dotenv subset without logging values.

    Existing process environment variables always remain authoritative; this
    helper only supplies local fallback values for variables that are absent.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError:
        return {}

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


def _admin_password_from_sources(
    environ: Optional[Dict[str, str]] = None,
    dotenv_values: Optional[Dict[str, str]] = None,
) -> Optional[str]:
    """Resolve admin password with process environment precedence."""
    source = os.environ if environ is None else environ
    if "SDR_DOA_ADMIN_PASSWORD" in source:
        return source["SDR_DOA_ADMIN_PASSWORD"] or None
    fallback = dotenv_values if dotenv_values is not None else _read_dotenv()
    return fallback.get("SDR_DOA_ADMIN_PASSWORD") or None


# HTTP Data Out is the local-LAN path. PPP is reserved for MQTT transport;
# keeping this set identical to the collector prevents a UI-only route from
# advertising a target that the actual GET collector will reject.
ALLOWED_DATA_HOSTS = frozenset(DEFAULT_ALLOWED_DATA_HOSTS)
DEFAULT_BIND = "127.0.0.1"
DEFAULT_PORT = 8787
DEFAULT_COMMAND_TTL_MS = 10_000
DEFAULT_APP_NAME = "SDR-DoA Ground Console"
DEFAULT_BRANDING_PATH = Path.home() / ".config" / "sdr-doa-ground-console" / "branding.json"
DEFAULT_CONFIG_PATH = Path.home() / ".config" / "sdr-doa-ground-console" / "console.json"
# Admin authentication is opt-in; never ship a fallback credential.
# Process environment wins; a repository-root .env is only a local fallback.
ADMIN_PASSWORD = _admin_password_from_sources()
if not ADMIN_PASSWORD:
    # Branding remains readable, but admin login is disabled until the operator
    # supplies the local-only password through the environment or .env fallback.
    ADMIN_PASSWORD = None
ADMIN_SESSION_COOKIE = "sdr_doa_admin"
ADMIN_SESSION_TTL_SECONDS = 30 * 60
MAX_BRANDING_NAME_LENGTH = 60
MAX_LOGO_BYTES = 256 * 1024
MAX_LOGO_DIMENSION = 4096
MAX_LOGO_PIXELS = 4_194_304
MAX_DECODED_LOGO_BYTES = 32 * 1024 * 1024
# PNG is the only logo format validated fully by the stdlib parser below.
# Keeping the contract narrow is safer than accepting formats we cannot decode.
ALLOWED_LOGO_MIME = {"image/png"}
ALLOWED_REFRESH_INTERVALS = {0, 5, 10, 30}
CONSOLE_CONFIG_VERSION = 1


# This is deliberately narrower than the full settings document. The ordinary
# telemetry control path must not change DAQ topology, calibration, endpoints,
# credentials, or system lifecycle.
CONFIG_ALLOWLIST = {
    "center_frequency_hz": (24_000_000.0, 1_800_000_000.0),
    "gain_db": (-100.0, 60.0),
    "vfo_frequency_hz": (24_000_000.0, 1_800_000_000.0),
    "vfo_bandwidth_hz": (100.0, 2_400_000.0),
    "vfo_squelch_db": (-200.0, 20.0),
}


def _is_allowed_base_url(value: str) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlsplit(value)
    if parsed.scheme != "http" or parsed.username or parsed.password:
        return False
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        return False
    hostname = (parsed.hostname or "").lower().rstrip(".")
    try:
        port = parsed.port
    except ValueError:
        return False
    return hostname in {item.lower().rstrip(".") for item in ALLOWED_DATA_HOSTS} and port in (None, 8081)


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
            raise RuntimeError("MQTT monitor dependency paho-mqtt is not installed") from exc
        raise
    return monitor_class


def _new_mqtt_monitor(host: str, port: int, transport: str = "tcp") -> Any:
    return _load_mqtt_monitor_class()(host, port, transport=transport)


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
    refresh_seconds: int = 0,
    *,
    mqtt_transport: str = "websockets",
) -> Dict[str, Any]:
    return {
        "version": CONSOLE_CONFIG_VERSION,
        "base_url": base_url,
        "mqtt_host": mqtt_host,
        "mqtt_port": int(mqtt_port),
        "mqtt_transport": mqtt_transport,
        "refresh_seconds": int(refresh_seconds),
    }


def _validate_console_config(payload: Any, fallback: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    defaults = dict(fallback or _default_console_config())
    if not isinstance(payload, dict):
        raise ValueError("console config must be a JSON object")
    base_url = payload.get("base_url", defaults["base_url"])
    if not _is_allowed_base_url(base_url):
        raise ValueError("base_url is outside the local SDR-DoA allowlist")
    mqtt_host = payload.get("mqtt_host", defaults["mqtt_host"])
    if mqtt_host is None:
        mqtt_host = ""
    if not isinstance(mqtt_host, str) or (mqtt_host and not _is_allowed_mqtt_host(mqtt_host)):
        raise ValueError("mqtt_host must be empty, localhost, or a valid IPv4/IPv6 address")
    try:
        mqtt_port = int(payload.get("mqtt_port", defaults["mqtt_port"]))
    except (TypeError, ValueError) as exc:
        raise ValueError("mqtt_port must be numeric") from exc
    if not (1 <= mqtt_port <= 65535):
        raise ValueError("mqtt_port must be between 1 and 65535")
    mqtt_transport = payload.get("mqtt_transport", defaults.get("mqtt_transport", "websockets"))
    if not isinstance(mqtt_transport, str) or mqtt_transport not in {"tcp", "websockets"}:
        raise ValueError("mqtt_transport must be tcp or websockets")
    try:
        refresh_seconds = int(payload.get("refresh_seconds", defaults["refresh_seconds"]))
    except (TypeError, ValueError) as exc:
        raise ValueError("refresh_seconds must be numeric") from exc
    if refresh_seconds not in ALLOWED_REFRESH_INTERVALS:
        raise ValueError("refresh_seconds is not an allowed interval")
    return _default_console_config(base_url.rstrip("/"), mqtt_host.strip(), mqtt_port, refresh_seconds, mqtt_transport=mqtt_transport)


def _load_console_config(path: Path, fallback: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    defaults = dict(fallback or _default_console_config())
    try:
        payload = json.loads(path.expanduser().read_text(encoding="utf-8"))
        return _validate_console_config(payload, defaults)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return defaults


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
        else:
            if saw_idat:
                idat_closed = True
            # Unknown critical chunks are not safe to ignore. Ancillary chunks
            # are accepted only after their CRC has been checked above.
            if 65 <= chunk_type[0] <= 90:
                raise ValueError("logo PNG has an unsupported critical chunk")
            if chunk_type == b"PLTE":
                if length == 0 or length % 3 != 0 or length > 768:
                    raise ValueError("logo PNG has an invalid palette")
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
    if (
        bit_depth != 8
        or color_type not in {0, 2, 4, 6}
        or compression != 0
        or filter_method != 0
        or interlace != 0
    ):
        raise ValueError("logo PNG format is not supported; use RGB/RGBA PNG")
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[color_type]
    scanline_bytes = 1 + width * channels
    expected_scanline_bytes = height * scanline_bytes
    if expected_scanline_bytes > MAX_DECODED_LOGO_BYTES:
        raise ValueError("logo PNG decoded data is too large")
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
    if any(decoded[offset] > 4 for offset in range(0, len(decoded), scanline_bytes)):
        raise ValueError("logo PNG has an invalid scanline filter")


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
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: https://tile.openstreetmap.de https://tile.openstreetmap.org; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://tile.openstreetmap.de https://tile.openstreetmap.org">
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
        <div class="panel-body table-wrap"><table class="data-table"><tbody id="mqtt-rows"></tbody></table><details><summary>Last payload by stream</summary><pre id="mqtt-last">Monitor is disabled.</pre></details></div>
      </article>
    </aside>
  </div>
  <p class="footer">SDR-DoA Ground Console · loopback-only · bounded GET reads · no remote mutation · <span class="mono">control dry-run</span> is preview-only.</p>
</main>

<div id="settings-modal" class="modal" hidden>
  <div class="modal-backdrop" data-close-settings></div>
  <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <header class="modal-head"><div><p class="eyebrow">LOCAL CONSOLE CONFIGURATION</p><h2 id="settings-title">Settings</h2><p>Connection and branding changes stay inside the Ground Console.</p></div><button id="settings-close" class="ghost" type="button" aria-label="Close settings">Close</button></header>
    <div class="modal-body">
      <nav class="tabs" aria-label="Settings tabs"><button class="tab active" data-tab="connection" type="button">Data & connection</button><button class="tab" data-tab="branding" type="button">Admin & branding</button></nav>
      <section id="tab-connection" class="tab-panel">
        <p class="note" style="margin:0 0 13px"><strong>Staging-safe:</strong> changes only alter the Ground Console read source and local monitor. Nothing is written to the Raspberry.</p>
        <div class="form-grid"><div class="field full"><label for="data-url">Data Out URL</label><input id="data-url" value="__BASE_URL__" spellcheck="false"><p class="help">HTTP GET only to the approved SDR-DoA host allowlist. MQTT remains subscriber-only.</p></div><div class="field"><label for="mqtt-host">MQTT monitor host</label><input id="mqtt-host" value="__MQTT_HOST__" placeholder="10.90.0.1" spellcheck="false"></div><div class="field"><label for="mqtt-port">MQTT port</label><input id="mqtt-port" type="number" value="__MQTT_PORT__" min="1" max="65535"></div><div class="field"><label for="refresh-interval">Auto-refresh</label><select id="refresh-interval"><option value="0">Off</option><option value="5">Every 5 seconds</option><option value="10">Every 10 seconds</option><option value="30">Every 30 seconds</option></select></div></div>
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
const state = { dataUrl: $('data-url').value, autoTimer: null, branding: null, pendingLogo: null, refreshSequence: 0, mqttSequence: 0, refreshController: null, snapshot: null, polar: { values: null, angle: null, fresh: false, figType: 'Polar', compassOffset: 0 } };
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
  STATUS_UNAVAILABLE_OR_INVALID:'Node status is unavailable or invalid'
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
function renderMqtt(data) {
  const enabled=Boolean(data&&data.enabled); const connection=data?.connection||'off';
  $('mqtt-connection').textContent=enabled?connection.toUpperCase():'OFF'; $('mqtt-connection').className=`metric-value ${kind(enabled&&connection==='connected'?'PASS':(enabled?'DEGRADED':'UNKNOWN'))}`;
  $('mqtt-detail').textContent=enabled?`${data.host}:${data.port} · ${data.valid||0}/${data.received||0} valid`:'subscriber-only / off';
  setHealthCard('health-mqtt', enabled?connection.toUpperCase():'OFF', enabled?'subscriber-only · '+(data.valid||0)+' valid':'subscriber-only', enabled&&connection==='connected'?'good':(enabled?'warn':''));
  if(!enabled){ $('mqtt-rows').innerHTML=rows([['Mode','OFF'],['Publish',pill('disabled')]]); $('mqtt-last').textContent='MQTT monitor is not enabled.'; return; }
  $('mqtt-rows').innerHTML=rows([
    ['Connection',pill(connection)],['Messages',esc(data.received)],['Valid / invalid',esc(`${data.valid} / ${data.invalid}`)],['Bytes',esc(data.total_bytes)],['Last latency',esc(data.last_latency_ms===null?'—':`${data.last_latency_ms} ms`)],['Last age',esc(data.last_age_ms===null?'—':`${data.last_age_ms} ms`)],['Last topic',esc(data.last_topic||'—')],['Publish',pill('false')]
  ]); $('mqtt-last').textContent=JSON.stringify(data.last_by_kind||{},null,2);
}
function polarSettings(figType, compassOffset) { const requested=String(figType||'Polar').trim(); const safeType=requested.toLowerCase()==='compass'?'Compass':'Polar'; const numeric=Number(compassOffset); return { figType:safeType, compassOffset:Number.isFinite(numeric)?numeric:0 }; }
function normalizeDegrees(deg) { return ((Number(deg)%360)+360)%360; }
function drawPolar(values, angle, fresh, figType='Polar', compassOffset=0) {
  const canvas=$('doa-polar'); const frame=canvas?.closest('.polar-frame')||canvas?.parentElement; if(!canvas||!frame) return;
  const cssSize=Math.max(1,Math.floor(frame.getBoundingClientRect().width||frame.clientWidth||420)); const dpr=Math.min(window.devicePixelRatio||1,2); const size=Math.max(1,Math.floor(cssSize*dpr));
  if(canvas.width!==size||canvas.height!==size){ canvas.width=size; canvas.height=size; }
  const ctx=canvas.getContext('2d'); if(!ctx) return; ctx.setTransform(size/cssSize,0,0,size/cssSize,0,0); ctx.clearRect(0,0,cssSize,cssSize);
  const styles=getComputedStyle(document.documentElement); const line=styles.getPropertyValue('--line').trim()||'#28533b'; const muted=styles.getPropertyValue('--muted').trim()||'#a8c9ad'; const subtle=styles.getPropertyValue('--subtle').trim()||'#7fae89'; const accent=styles.getPropertyValue('--accent').trim()||'#39d98a'; const blue=styles.getPropertyValue('--blue').trim()||'#65c98a';
  const cx=cssSize/2, cy=cssSize/2, maxR=cssSize*.365; const settings=polarSettings(figType,compassOffset); const toDisplayAngle=deg=>normalizeDegrees(settings.figType==='Compass'?360-deg+settings.compassOffset:deg); const toRadians=deg=>(deg-90)*Math.PI/180;
  ctx.save(); ctx.translate(cx,cy); ctx.lineWidth=1; ctx.strokeStyle=line; ctx.globalAlpha=.92; [.25,.5,.75,1].forEach(f=>{ ctx.beginPath(); ctx.arc(0,0,maxR*f,0,Math.PI*2); ctx.stroke(); });
  for(let deg=0;deg<360;deg+=45){ const radians=toRadians(deg); ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(radians)*maxR,Math.sin(radians)*maxR); ctx.stroke(); }
  ctx.globalAlpha=1; ctx.fillStyle=muted; ctx.font='700 10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  const perimeterInset=Math.max(9,cssSize*.035); const cardinalRadius=Math.min(maxR+Math.min(23,Math.max(15,cssSize*.06)),cssSize/2-perimeterInset); const degreeRadius=Math.min(maxR+Math.min(18,Math.max(12,cssSize*.045)),cssSize/2-perimeterInset); const directions=[['N',0],['E',90],['S',180],['W',270]];
  directions.forEach(([label,deg])=>{ const radians=toRadians(deg); ctx.fillText(label,Math.cos(radians)*cardinalRadius,Math.sin(radians)*cardinalRadius); });
  ctx.fillStyle=subtle; ctx.font='10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'; const diagonalDegrees=new Set([45,135,225,315]);
  for(let deg=0;deg<360;deg+=45){ const radians=toRadians(deg); ctx.beginPath(); ctx.moveTo(Math.cos(radians)*maxR,Math.sin(radians)*maxR); ctx.lineTo(Math.cos(radians)*(maxR+6),Math.sin(radians)*(maxR+6)); ctx.stroke(); if(diagonalDegrees.has(deg)) ctx.fillText(`${deg}°`,Math.cos(radians)*degreeRadius,Math.sin(radians)*degreeRadius); }
  const finite=Array.isArray(values)&&values.length===360?values.map(Number):null; const validData=Boolean(fresh&&finite&&finite.every(Number.isFinite));
  if(validData){
    const floor=Math.min(...finite), peakValue=Math.max(...finite), span=peakValue-floor; const yFor=value=>span>0?Math.max(0,Math.min(1,(value-floor)/span)):1; ctx.textAlign='left'; ctx.fillStyle=subtle; ctx.font='9px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'; const precision=span<5?1:0;
    [.25,.5,.75,1].forEach(f=>{ const label=`${(floor+span*f).toFixed(precision)} dB`; const radialLabelY=-maxR+(maxR*2.0*f); const labelWidth=ctx.measureText(label).width; const rightEdge=Math.max(0,cssSize/2-4); const radialLabelX=Math.min(maxR+8,rightEdge-labelWidth); ctx.fillText(label,radialLabelX,radialLabelY); });
    const point=(value,index)=>{ const radians=toRadians(toDisplayAngle(index)), radius=maxR*yFor(value); return [Math.cos(radians)*radius,Math.sin(radians)*radius]; };
    const drawCurve=()=>{ finite.forEach((value,index)=>{ const [x,y]=point(value,index); index?ctx.lineTo(x,y):ctx.moveTo(x,y); }); const [x0,y0]=point(finite[0],0); ctx.lineTo(x0,y0); };
    ctx.beginPath(); drawCurve(); ctx.closePath(); ctx.fillStyle='rgba(57,217,138,.14)'; ctx.fill(); ctx.beginPath(); drawCurve(); ctx.closePath(); ctx.strokeStyle=accent; ctx.lineWidth=2; ctx.shadowColor='rgba(57,217,138,.48)'; ctx.shadowBlur=8; ctx.stroke();
    const peakIndex=finite.indexOf(peakValue); if(peakIndex>=0){ const displayPeak=toDisplayAngle(peakIndex), [px,py]=point(finite[peakIndex],peakIndex); ctx.shadowBlur=0; ctx.fillStyle=accent; ctx.beginPath(); ctx.arc(px,py,3.5,0,Math.PI*2); ctx.fill(); ctx.strokeStyle=blue; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(px,py); ctx.lineTo(Math.cos(toRadians(displayPeak))*(maxR+12),Math.sin(toRadians(displayPeak))*(maxR+12)); ctx.stroke(); ctx.fillStyle=accent; ctx.font='700 9px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'; ctx.textAlign='center'; ctx.fillText(`PLOT ${displayPeak.toFixed(0)}°`,px,py < -maxR*.45 ? py+15 : py-11); }
  }
  ctx.restore();
}
function setPolarUnavailable(reason='polar unavailable', settings=polarSettings(state.polar?.figType,state.polar?.compassOffset)) {
  state.polar={values:null,angle:null,fresh:false,figType:settings.figType,compassOffset:settings.compassOffset}; drawPolar(null,null,false,settings.figType,settings.compassOffset);
  $('polar-peak').textContent='—'; $('polar-canonical').textContent='—'; $('polar-peak-db').textContent='—'; $('polar-bins').textContent='—'; $('compass-angle').textContent='—°'; $('compass-display-angle').textContent='plot peak · display —°'; $('compass-status').textContent='POLAR UNAVAILABLE'; $('compass-status').className='compass-status unavailable'; $('compass-source').textContent='Data Out · unavailable'; $('compass-detail').innerHTML=`<strong>Unavailable:</strong> ${esc(reason)}`; $('doa-polar').setAttribute('aria-label',`Polar DoA unavailable. ${reason}`);
  $('inspector-angle').textContent='—°'; $('inspector-display-peak').textContent='—'; $('inspector-peak-db').textContent='—'; $('inspector-bins').textContent='—'; $('inspector-freshness').textContent='—'; $('inspector-angle-note').innerHTML='waiting for<br>correlated DoA'; $('inspector-provenance').textContent='No observation selected. Plot is cleared until a fresh, complete vector is available.';
}
function renderPolar(snapshot,csv,dataAvailable) {
  const fields=snapshot.settings?.fields||{}; const requestedType=Object.prototype.hasOwnProperty.call(fields,'doa_fig_type')?fields.doa_fig_type:state.polar?.figType; const requestedOffset=Object.prototype.hasOwnProperty.call(fields,'compass_offset')?fields.compass_offset:state.polar?.compassOffset; const settings=polarSettings(requestedType,requestedOffset); const angle=Number(csv.canonical_angle_deg); const values=Array.isArray(csv.angular_power_db)?csv.angular_power_db:null; const fresh=Boolean(dataAvailable&&csv.freshness?.fresh===true&&values?.length===360&&values.every(value=>Number.isFinite(Number(value))));
  state.polar={values,angle:Number.isFinite(angle)?angle:null,fresh,figType:settings.figType,compassOffset:settings.compassOffset}; if(!fresh||!Number.isFinite(angle)){ setPolarUnavailable('Curve cleared: DoA data is stale, conflicting, or incomplete.',settings); return; }
  drawPolar(values,angle,true,settings.figType,settings.compassOffset); const peakIndex=Number(csv.angular_peak_index); const peakReady=Number.isInteger(peakIndex)&&peakIndex>=0&&peakIndex<values.length; const displayAngle=settings.figType==='Compass'&&peakReady?normalizeDegrees(360-peakIndex+settings.compassOffset):(peakReady?peakIndex:null); const peakLabel=displayAngle===null?'—':`${displayAngle.toFixed(0)}° · bin ${peakIndex}`; const canonicalLabel=`${angle.toFixed(1)}° · θ₀`;
  $('polar-peak').textContent=peakLabel; $('polar-canonical').textContent=canonicalLabel; $('polar-peak-db').textContent=Number.isFinite(Number(csv.angular_peak_db))?`${Number(csv.angular_peak_db).toFixed(1)} dB`:'—'; $('polar-bins').textContent=String(values.length); $('compass-angle').textContent=`${angle.toFixed(1)}°`; $('compass-display-angle').textContent=`plot peak · display ${displayAngle===null?'—':displayAngle.toFixed(0)+'°'} · bin ${peakReady?peakIndex:'—'}`; $('compass-status').textContent='DATA AVAILABLE'; $('compass-status').className='compass-status'; $('compass-source').textContent=`Data Out · ${settings.figType} display axis · ${formatAge(csv.freshness)}`; $('compass-detail').innerHTML=`<strong>Provenance:</strong> canonical source ${angle.toFixed(1)}° (θ₀) versus plotted display peak ${displayAngle===null?'—':displayAngle.toFixed(0)+'°'} (bin ${peakReady?peakIndex:'—'}). Both remain separate metadata · display-only.`; $('doa-polar').setAttribute('aria-label',`Polar DoA. Canonical source angle ${angle.toFixed(1)} degrees. Plotted 360-bin peak display angle ${displayAngle===null?'unavailable':displayAngle.toFixed(0)+' degrees, bin '+peakIndex}. Display-only.`);
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
  const readAt=new Date(); $('last-read-chip').textContent=readAt.toISOString().slice(11,19)+'Z'; $('source-url').textContent=snapshot.collector?.base_url||state.dataUrl;
  const daq=status.daq_health||'UNKNOWN'; const daqTop=safe.daq_status||{}; const syncFlags=[daqTop.frame_sync,daqTop.sample_delay_sync,daqTop.iq_sync]; const syncPassed=syncFlags.filter(value=>value===true).length; $('daq').textContent=daq; $('daq').className=`metric-value ${kind(daq)}`; $('daq-detail').textContent=`frame #${daqTop.data_frame_index??'—'} · sync ${syncPassed}/3`;
  const freshnessItems=[csv.freshness,xml.freshness].filter(Boolean); const ages=freshnessItems.map(x=>x.age_ms); const validAges=ages.length===2&&ages.every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0); const maxAge=validAges?Math.max(...ages):null; const freshnessOk=validAges&&freshnessItems.every(x=>x.fresh===true); $('doa-age').textContent=maxAge===null?'—':`${(Number(maxAge)/1000).toFixed(1)} s`; $('doa-age').className=`metric-value ${freshnessOk&&maxAge<=5000?'good':'bad'}`; const relation=consistency.conflict===true?'CONFLICT':(consistency.comparable===true?(typeof consistency.circular_distance_deg==='number'&&consistency.circular_distance_deg<=3?'EQUAL':'DIFFERENT'):'NOT COMPARABLE'); $('doa-detail').textContent=`CSV ${formatNumber(csv.canonical_angle_deg,1)}° / XML ${formatNumber(xml.canonical_angle_deg,1)}° · ${relation}`;
  const drops=safe.daq_num_dropped_frames; $('drops').textContent=drops===undefined?'—':drops; $('drops').className=`metric-value ${drops===0?'good':'warn'}`; $('drops-detail').textContent='status.json counter';
  const dataAvailable=Boolean(csv.available&&xml.available&&csv.freshness?.fresh&&xml.freshness?.fresh&&consistency.comparable===true&&consistency.conflict!==true); const gateState=String(gate.state||'BLOCKED').toUpperCase(); $('delivery-summary').textContent=gateState; $('delivery-summary').className=`metric-value ${kind(gateState)}`; $('delivery-state').textContent=gateState; $('delivery-state').className=kind(gateState); $('delivery-detail').textContent=gateState==='READY'?'delivery ready':'publish held'; $('gate-title').textContent=gateState; $('gate-pill').innerHTML=pill(gateState); $('gate-banner').className=`gate-banner ${gateState==='READY'?'good':''}`; $('gate-copy').textContent=gateState==='READY'?'Delivery gate is ready.':(dataAvailable?'DoA data is observable; delivery remains held by the publication gate.':'DoA data is not sufficiently fresh or consistent for usable delivery.');
  renderPolar(snapshot,csv,dataAvailable); renderMap(snapshot,csv,xml); renderHealthCards(snapshot,csv,xml,consistency); renderEvents(snapshot,gate,consistency);
  const reasons=gate.reasons||[]; $('gate-count').textContent=`${reasons.length} GATES`; $('gate-reasons').innerHTML=reasons.length?reasons.map(reason=>`<li><span>${esc(reasonLabel(reason))}</span><small class="mono">${esc(reason)}</small></li>`).join(''):'<li>No active gate reasons.</li>'; $('gate-debug').textContent=JSON.stringify({state:gateState,checks:gate.checks||{},reasons},null,2);
  const candidates=[{label:'CSV',candidate:csv},{label:'XML',candidate:xml}]; $('doa-rows').innerHTML=signalRows(candidates); $('signal-contract-state').textContent=`${candidates.filter(item=>item.candidate?.available===true).length}/2 NATIVE VIEWS`;
  const sourceRow=(label,candidate)=>[['Source',`${esc(label)} · ${candidate.available?pill('PARSED'):pill('UNAVAILABLE')}`],['  raw angle',candidate.available?`${formatNumber(candidate.doa_raw_deg,1)}° <span class="muted">(${esc(candidate.angle_convention||'native')})</span>`:'—'],['  canonical angle',candidate.available?`${formatNumber(candidate.canonical_angle_deg,1)}° <span class="muted">(${esc(candidate.canonical_angle_convention||'—')})</span>`:'—'],['  freshness',candidate.available?`${formatAge(candidate.freshness)} · ${candidate.freshness?.fresh===true?'fresh':'not fresh'}`:'—'],['  PAPR native',candidate.available?`${formatNumber(candidate.confidence_metric_db,3)} dB · ${candidate.confidence_metric_valid?'valid':'invalid'}`:'—'],['  power native',candidate.available?`${formatNumber(candidate.power_native_db,2)} dB · ${candidate.power_native_valid?'valid':'invalid'}`:'—'],['  frequency',candidate.available?`${esc(candidate.frequency_hz_normalized??'—')} Hz`:'—'],['  contract mapping',candidate.available?`${esc(candidate.contract_mapping_state||'—')} · ${esc((candidate.unit_reasons||[]).join(', ')||'—')}`:'—']];
  $('source-rows').innerHTML=rows([['Publication',pill(gateState)],['Native correlation',consistency.comparable?`${consistency.same_timestamp?'same timestamp':'adjacent timestamps'} · canonical delta ${formatNumber(consistency.circular_distance_deg,1)}°`:'not comparable'],...sourceRow('CSV',csv),...sourceRow('XML',xml),['Authority',esc(authority.selected||'none')],['Canonical angle gate',authority.canonical_angle_ready?'ready':'not approved'],['Contract confidence',authority.selected_doa?.confidence===null?'not mapped to 0–1':esc(authority.selected_doa?.confidence??'—')],['Gate note',esc((gate.reasons||[]).map(reasonLabel).join(' · ')||'—')]]);
  const daqStatus=safe.daq_status||{}; $('status-rows').innerHTML=rows([['DAQ',pill(daq)],['daq_ok',boolLabel(safe.daq_ok)],['Frame index',esc(daqStatus.data_frame_index)],['Frame sync',boolLabel(daqStatus.frame_sync)],['Sample-delay sync',boolLabel(daqStatus.sample_delay_sync)],['IQ sync',boolLabel(daqStatus.iq_sync)],['ADC overdrive',boolLabel(daqStatus.adc_overdrive)],['Dropped frames',esc(safe.daq_num_dropped_frames)],['Sampling',esc(daqStatus.sampling_frequency_hz?`${daqStatus.sampling_frequency_hz} Hz`:'—')],['Station',esc(safe.station_id)],['Software',esc(safe.software_version)],['Source hash',esc(safe.software_git_short_hash)],['GPS',esc(safe.gps_status)]]);
  const settings=snapshot.settings||{}; const sf=settings.fields||{}; $('settings-rows').innerHTML=Object.keys(sf).sort().map(key=>[key,safeValue(sf[key])]).map(([key,value])=>`<tr><th>${esc(key)}</th><td>${value}</td></tr>`).join('')||'<tr><td colspan="2">Not available</td></tr>';
  setReadStatus(`Snapshot read successfully · ${readAt.toISOString().slice(11,19)}Z`,'good');
}
async function refreshMqtt() { const sequence=++state.mqttSequence; try { const r=await fetch('/api/mqtt',{cache:'no-store'}); const payload=await r.json(); if(sequence!==state.mqttSequence) return; renderMqtt(payload); } catch(e) { if(sequence!==state.mqttSequence) return; renderMqtt({enabled:true,connection:'error',host:'?',port:'?',received:0,valid:0,invalid:0,total_bytes:0,last_latency_ms:null,last_age_ms:null,last_topic:null,last_by_kind:{error:'monitor unavailable'}}); } }
async function refresh() {
  const sequence=++state.refreshSequence; if(state.refreshController) state.refreshController.abort(); const controller=typeof AbortController==='function'?new AbortController():null; state.refreshController=controller; const button=$('refresh'); button.disabled=true; setReadStatus('Reading Data Out…');
  try { const url='/api/snapshot?base_url='+encodeURIComponent(state.dataUrl); const options={cache:'no-store'}; if(controller) options.signal=controller.signal; const response=await fetch(url,options); const data=await response.json(); if(sequence!==state.refreshSequence) return; if(!response.ok) throw new Error(data.error||'snapshot failed'); render(data); }
  catch(error) { if(sequence!==state.refreshSequence||error?.name==='AbortError') return; const message=error?.message||'snapshot failed'; setSnapshotUnavailable(message); setReadStatus('Read error: '+message,'bad'); }
  finally { if(sequence===state.refreshSequence){ button.disabled=false; if(state.refreshController===controller) state.refreshController=null; } }
  if(sequence===state.refreshSequence) refreshMqtt();
}
function setAuto(seconds) { if(state.autoTimer){ clearInterval(state.autoTimer); state.autoTimer=null; } const interval=Number(seconds||0); $('refresh-interval').value=String(interval); if(interval>0){ refresh(); state.autoTimer=setInterval(refresh,interval*1000); $('auto-refresh').textContent=`Auto: ${interval}s`; } else $('auto-refresh').textContent='Auto: off'; }
function openSettings(tab='connection') { $('settings-modal').hidden=false; selectTab(tab); }
function closeSettings() { $('settings-modal').hidden=true; }
function selectTab(name) { document.querySelectorAll('.tab').forEach(button=>button.classList.toggle('active',button.dataset.tab===name)); document.querySelectorAll('.tab-panel').forEach(panel=>panel.hidden=panel.id!==`tab-${name}`); }
async function applyConnection() { const url=$('data-url').value.trim(); const mqttHost=$('mqtt-host').value.trim(); const mqttPort=Number($('mqtt-port').value||9001); const refreshSeconds=Number($('refresh-interval').value||0); if(!url){ setStatus('connection-status','URL is empty.','bad'); return; } try { const r=await fetch('/api/console-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base_url:url,mqtt_host:mqttHost,mqtt_port:mqttPort,refresh_seconds:refreshSeconds})}); const data=await r.json(); if(!r.ok) throw new Error(data.error||'configuration rejected'); state.dataUrl=data.base_url; $('source-url').textContent=data.base_url; setAuto(data.refresh_seconds); setStatus('connection-status','Configuration saved locally in Ground Console.','good'); await refresh(); } catch(e) { setStatus('connection-status',e.message,'bad'); } }
async function connectMqtt() { const host=$('mqtt-host').value.trim(); const port=Number($('mqtt-port').value||9001); if(!host){ setStatus('connection-status','Enter an MQTT broker IP address or localhost first.','bad'); return; } try { const r=await fetch(`/api/mqtt/connect?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}`,{method:'POST'}); const data=await r.json(); if(!r.ok) throw new Error(data.error||'MQTT monitor failed'); renderMqtt(data); setStatus('connection-status','MQTT monitor connected as subscriber-only.','good'); setTimeout(refreshMqtt,700); } catch(e) { setStatus('connection-status',e.message,'bad'); } }
async function adminLogin() { const password=$('admin-password').value; try { const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})}); const data=await r.json(); if(!r.ok) throw new Error(data.error||'login failed'); $('admin-login-box').hidden=true; $('admin-workspace').hidden=false; $('admin-password').value=''; setStatus('brand-status','Admin active.','good'); renderBranding(state.branding); } catch(e) { setStatus('admin-login-status',e.message,'bad'); } }
async function adminLogout() { await fetch('/api/admin/logout',{method:'POST'}); $('admin-login-box').hidden=false; $('admin-workspace').hidden=true; setStatus('admin-login-status','Admin session closed.',''); }
function readLogo(file) { if(!file) return; if(file.size>256*1024){ setStatus('brand-status','Logo exceeds 256 KiB.','bad'); $('brand-logo').value=''; return; } const reader=new FileReader(); reader.onload=()=>{ state.pendingLogo=String(reader.result||''); $('brand-preview').src=state.pendingLogo; $('brand-preview').hidden=false; $('preview-placeholder').hidden=true; }; reader.onerror=()=>setStatus('brand-status','Logo could not be read.','bad'); reader.readAsDataURL(file); }
function resetLogo() { state.pendingLogo=''; $('brand-logo').value=''; $('brand-preview').hidden=true; $('preview-placeholder').hidden=false; setStatus('brand-status','Logo will be removed when saved.',''); }
async function saveBranding() { const appName=$('brand-name').value.trim(); const logo=state.pendingLogo===null?(state.branding?.logo_data_url||''):state.pendingLogo; try { const r=await fetch('/api/admin/branding',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_name:appName,logo_data_url:logo})}); const data=await r.json(); if(!r.ok) throw new Error(data.error||'branding save failed'); state.pendingLogo=null; const verify=await fetch('/api/branding',{cache:'no-store'}); const verified=await verify.json(); if(!verify.ok) throw new Error(verified.error||'branding read-back failed'); renderBranding(verified); setStatus('brand-status','Branding saved and verified from Ground Console local storage.','good'); } catch(e) { setStatus('brand-status',e.message,'bad'); } }
document.querySelectorAll('[data-nav]').forEach(item=>item.addEventListener('click',()=>{ document.querySelectorAll('.nav-item').forEach(nav=>nav.classList.toggle('active',nav===item)); document.querySelectorAll('.nav-item').forEach(nav=>nav.removeAttribute('aria-current')); item.setAttribute('aria-current','page'); }));
$('refresh').addEventListener('click',refresh); $('auto-refresh').addEventListener('click',()=>setAuto(state.autoTimer?0:5)); $('settings-open').addEventListener('click',()=>openSettings('connection')); $('settings-close').addEventListener('click',closeSettings); document.querySelector('[data-close-settings]').addEventListener('click',closeSettings); document.querySelectorAll('.tab').forEach(button=>button.addEventListener('click',()=>selectTab(button.dataset.tab))); $('apply-connection').addEventListener('click',applyConnection); $('monitor-connect').addEventListener('click',connectMqtt); $('admin-login').addEventListener('click',adminLogin); $('admin-logout').addEventListener('click',adminLogout); $('brand-logo').addEventListener('change',event=>readLogo(event.target.files[0])); $('brand-reset-logo').addEventListener('click',resetLogo); $('brand-save').addEventListener('click',saveBranding); $('refresh-interval').addEventListener('change',event=>setAuto(event.target.value)); document.addEventListener('keydown',event=>{if(event.key==='Escape')closeSettings();});
window.addEventListener('resize',()=>drawPolar(state.polar.values,state.polar.angle,state.polar.fresh,state.polar.figType,state.polar.compassOffset),{passive:true});
renderClock(); setInterval(renderClock,1000); loadBranding(); if (initialConfig && initialConfig.refresh_seconds > 0) setAuto(initialConfig.refresh_seconds); else refresh();
</script>
</body>
</html>
"""


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be numeric")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be numeric") from exc
    if number != number or number in (float("inf"), float("-inf")):
        raise ValueError(f"{field} must be finite")
    return number


def validate_config_patch(payload: Any, now_ms: Optional[int] = None) -> Dict[str, Any]:
    """Validate a narrow settings patch without applying or transmitting it."""
    if not isinstance(payload, dict):
        raise ValueError("request must be a JSON object")
    changes = payload.get("changes")
    if not isinstance(changes, dict) or not changes:
        raise ValueError("changes must be a non-empty object")
    unknown = sorted(set(changes) - set(CONFIG_ALLOWLIST))
    if unknown:
        raise ValueError("fields not allowed: " + ", ".join(unknown))

    normalized: Dict[str, Any] = {}
    for field, value in changes.items():
        number = _finite_number(value, field)
        low, high = CONFIG_ALLOWLIST[field]
        if number < low or number > high:
            raise ValueError(f"{field} outside allowed range [{low:g}, {high:g}]")
        normalized[field] = int(number) if number.is_integer() else number

    base_revision = payload.get("base_config_rev")
    if base_revision is not None:
        revision = _finite_number(base_revision, "base_config_rev")
        if revision < 0 or not revision.is_integer():
            raise ValueError("base_config_rev must be a non-negative integer")
        base_revision = int(revision)

    issued = int(time.time() * 1000) if now_ms is None else int(now_ms)
    command: Dict[str, Any] = {
        "v": 1,
        "id": "dryrun-" + uuid.uuid4().hex[:12],
        "type": "config_patch",
        "issued_ts_ms": issued,
        "expires_ts_ms": issued + DEFAULT_COMMAND_TTL_MS,
        "changes": normalized,
    }
    if base_revision is not None:
        command["base_config_rev"] = base_revision
    return {
        "dry_run": True,
        "transport": "none",
        "applied": False,
        "ok": True,
        "validation": "passed",
        "command": command,
        "note": "Preview only; no MQTT, HTTP POST, file write, or Raspberry mutation was performed.",
    }


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
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.de https://tile.openstreetmap.org; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://tile.openstreetmap.de https://tile.openstreetmap.org")
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

    def _send_frontend(self, request_path: str) -> None:
        """Serve only built UI assets, never source, dotfiles or symlinks."""
        root = self.console_server.frontend_dir
        relative = "index.html" if request_path == "/" else request_path.lstrip("/")
        parts = relative.split("/")
        mime = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon"}
        if root is None or any(not part or part.startswith(".") for part in parts) or "%" in relative or "\\" in relative:
            self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return
        path = root.joinpath(*parts)
        if any(root.joinpath(*parts[:i]).is_symlink() for i in range(1, len(parts) + 1)) or path.suffix not in mime or (relative != "index.html" and not relative.startswith("assets/")):
            self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            path.resolve().relative_to(root.resolve())
            body = path.read_bytes()
        except (OSError, ValueError):
            self._send_json({"error": "Frontend build unavailable. Run npm ci and npm run build in frontend, or use --legacy-ui."}, HTTPStatus.NOT_FOUND)
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime[path.suffix])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Cache-Control", "no-store" if path.suffix == ".html" else "public, max-age=3600")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.de https://tile.openstreetmap.org; connect-src 'self' https://tile.openstreetmap.de https://tile.openstreetmap.org; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
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
            body = body.replace("__CONSOLE_CONFIG_JSON__", _safe_config_json(config))
            body = body.replace("__APP_NAME__", escape(branding["app_name"], quote=True))
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.de https://tile.openstreetmap.org; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://tile.openstreetmap.de https://tile.openstreetmap.org")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body.encode("utf-8"))))
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))
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
            if not _is_allowed_base_url(base_url):
                self._send_json(
                    {"error": "base_url is outside the local SDR-DoA allowlist", "read_only": True},
                    HTTPStatus.BAD_REQUEST,
                )
                return
            try:
                snapshot = collect(
                    base_url=base_url,
                    authority="none",
                    clock_source="remote_unverified",
                )
                self._send_json(snapshot)
            except (CollectorError, ValueError, OSError) as exc:
                self._send_json({"error": str(exc), "read_only": True}, HTTPStatus.BAD_GATEWAY)
            return
        if parsed.path == "/api/capabilities":
            self._send_json({
                "read_only": True,
                "mqtt_publish": False,
                "remote_post": False,
                "config_apply": False,
                "mqtt_monitor": self.console_server.mqtt_monitor is not None,
                "admin_branding": True,
                "admin_auth_required": True,
                "config_allowlist": sorted(CONFIG_ALLOWLIST),
            })
            return
        if parsed.path == "/api/console-config":
            self._send_json(self.console_server.get_config())
            return
        if parsed.path == "/api/mqtt":
            if self.console_server.mqtt_monitor is None:
                self._send_json({"enabled": False, "read_only": True, "publish_enabled": False})
            else:
                self._send_json(self.console_server.mqtt_monitor.snapshot())
            return
        if parsed.path == "/api/mqtt/rdf-node":
            monitor = self.console_server.mqtt_monitor
            if monitor is None:
                self._send_json(_empty_rdf_node_mqtt_snapshot())
            else:
                self._send_json(monitor.rdf_node_snapshot())
            return
        self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        if parsed.path == "/api/console-config":
            try:
                payload = self._read_json(16 * 1024)
                if not isinstance(payload, dict):
                    raise ValueError("request must be a JSON object")
                current = self.console_server.get_config()
                config = self.console_server.apply_config({**current, **payload})
                self._send_json(config)
            except (ValueError, OSError) as exc:
                self._send_json({"ok": False, "error": str(exc), "read_only": True}, HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/api/admin/login":
            try:
                payload = self._read_json(4096)
                password = payload.get("password") if isinstance(payload, dict) else None
                token = self.console_server.create_admin_session(password)
                if not token:
                    self._send_json({"ok": False, "error": "password admin salah"}, HTTPStatus.UNAUTHORIZED)
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
        if parsed.path == "/api/mqtt/connect":
            query = parse_qs(parsed.query, keep_blank_values=False)
            host = query.get("host", [""])[0].strip()
            try:
                port = int(query.get("port", ["9001"])[0])
            except ValueError:
                self._send_json({"error": "MQTT port must be numeric", "read_only": True}, HTTPStatus.BAD_REQUEST)
                return
            if not host or not (1 <= port <= 65535) or not _is_allowed_mqtt_host(host):
                self._send_json({"error": "MQTT monitor host must be localhost or a valid IPv4/IPv6 address", "read_only": True}, HTTPStatus.BAD_REQUEST)
                return
            try:
                self.console_server.enable_mqtt_monitor(host, port)
                self._send_json(self.console_server.mqtt_monitor.snapshot())
            except Exception as exc:  # pragma: no cover - broker-dependent
                self._send_json({"error": str(exc), "read_only": True}, HTTPStatus.BAD_GATEWAY)
            return
        if parsed.path != "/api/dry-run/config-patch":
            self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            payload = self._read_json()
            result = validate_config_patch(payload)
            self._send_json(result)
        except ValueError as exc:
            self._send_json(
                {"dry_run": True, "transport": "none", "applied": False, "ok": False, "error": str(exc)},
                HTTPStatus.BAD_REQUEST,
            )


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
    ):
        self.frontend_dir = Path(frontend_dir).resolve() if frontend_dir is not None else None
        if not _is_loopback_bind(address[0]):
            raise ValueError("Ground Console must bind to loopback; admin branding is local-only")
        if not _is_allowed_base_url(base_url):
            raise ValueError("base_url is outside the local SDR-DoA allowlist")
        self.config_path = Path(config_path).expanduser() if config_path else DEFAULT_CONFIG_PATH
        fallback = _default_console_config(base_url.rstrip("/"), refresh_seconds=0)
        self._config = _validate_console_config(config, fallback) if config is not None else _load_console_config(self.config_path, fallback)
        self._config_lock = threading.RLock()
        self.mqtt_monitor = mqtt_monitor
        if mqtt_monitor is not None:
            self._config["mqtt_host"] = str(getattr(mqtt_monitor, "host", ""))
            self._config["mqtt_port"] = int(getattr(mqtt_monitor, "port", 1883))
        self.branding_path = Path(branding_path).expanduser() if branding_path else DEFAULT_BRANDING_PATH
        self._branding_lock = threading.RLock()
        self._branding = _load_branding(self.branding_path)
        self._session_lock = threading.RLock()
        self._admin_sessions: Dict[str, float] = {}
        super().__init__(address, ConsoleHandler)

    @property
    def base_url(self) -> str:
        return str(self._config["base_url"])

    def get_config(self) -> Dict[str, Any]:
        with self._config_lock:
            return dict(self._config)

    def update_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        with self._config_lock:
            normalized = _validate_console_config(config, self._config)
            _save_console_config(self.config_path, normalized)
            self._config = normalized
            return dict(self._config)

    def apply_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Persist local console config and reconcile its local MQTT monitor."""
        with self._config_lock:
            normalized = _validate_console_config(config, self._config)
            old_connection = (
                str(self._config.get("mqtt_host", "")),
                int(self._config.get("mqtt_port", 9001)),
                str(self._config.get("mqtt_transport", "websockets")),
            )
            new_host = str(normalized["mqtt_host"])
            new_connection = (
                new_host,
                int(normalized["mqtt_port"]),
                str(normalized["mqtt_transport"]),
            )
            monitor_changed = (
                old_connection != new_connection
                or bool(new_host) != (self.mqtt_monitor is not None)
            )
            replacement = None
            if monitor_changed and new_host:
                replacement = _new_mqtt_monitor(
                    new_host,
                    int(normalized["mqtt_port"]),
                    str(normalized["mqtt_transport"]),
                )
                replacement.start()
            previous = self.mqtt_monitor
            try:
                _save_console_config(self.config_path, normalized)
            except Exception:
                if replacement is not None:
                    replacement.stop()
                raise
            if monitor_changed:
                if previous is not None:
                    previous.stop()
                self.mqtt_monitor = replacement
            self._config = normalized
            return dict(self._config)

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
        if (
            not isinstance(password, str)
            or not isinstance(ADMIN_PASSWORD, str)
            or not ADMIN_PASSWORD
            or not hmac.compare_digest(password, ADMIN_PASSWORD)
        ):
            return None
        token = secrets.token_urlsafe(32)
        with self._session_lock:
            now = time.time()
            self._admin_sessions = {key: expiry for key, expiry in self._admin_sessions.items() if expiry > now}
            self._admin_sessions[token] = now + ADMIN_SESSION_TTL_SECONDS
        return token

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

    def enable_mqtt_monitor(self, host: str, port: int) -> None:
        # Use the same validated/reconciled path as the Settings form.
        self.apply_config({
            **self.get_config(),
            "mqtt_host": host,
            "mqtt_port": port,
        })


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Local read-only SDR-DoA Ground Console")
    parser.add_argument("--base-url", default="http://doasdr.local:8081", help="SDR-DoA Data Out base URL")
    parser.add_argument("--legacy-ui", action="store_true", help="use the previous embedded UI instead of the frontend build")
    parser.add_argument("--bind", default=DEFAULT_BIND, help="local bind address")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="local console port")
    parser.add_argument("--mqtt-host", default="10.90.0.1", help="MQTT broker IPv4/IPv6 address or localhost; subscriber-only")
    parser.add_argument("--mqtt-port", type=int, default=9001, help="MQTT broker port")
    parser.add_argument(
        "--mqtt-transport",
        choices=("tcp", "websockets"),
        default="websockets",
        help="MQTT transport for the subscriber-only monitor",
    )
    parser.add_argument("--branding-path", default=str(DEFAULT_BRANDING_PATH), help="local branding JSON path")
    parser.add_argument("--config-path", default=str(DEFAULT_CONFIG_PATH), help="local console connection config path")
    return parser


def main() -> int:
    args = _build_parser().parse_args()
    if not (1 <= args.port <= 65535):
        raise SystemExit("port must be between 1 and 65535")
    if not _is_loopback_bind(args.bind):
        raise SystemExit("--bind must be localhost or a loopback address; admin branding is local-only")
    if args.mqtt_host and not _is_allowed_mqtt_host(args.mqtt_host):
        raise SystemExit("--mqtt-host must be empty, localhost, or a valid IPv4/IPv6 address")
    if not (1 <= args.mqtt_port <= 65535):
        raise SystemExit("--mqtt-port must be between 1 and 65535")
    if not _is_allowed_base_url(args.base_url):
        raise SystemExit("--base-url is outside the local SDR-DoA allowlist")
    config_path = Path(args.config_path).expanduser()
    fallback_config = _default_console_config(args.base_url, args.mqtt_host, args.mqtt_port, 0, mqtt_transport=args.mqtt_transport)
    config = _load_console_config(config_path, fallback_config)
    monitor = _new_mqtt_monitor(config["mqtt_host"], config["mqtt_port"], config["mqtt_transport"]) if config["mqtt_host"] else None
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
    )
    print(f"Ground Console: http://{args.bind}:{args.port}/", flush=True)
    print(f"Read-only Data Out: {config['base_url']}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nGround Console stopped", flush=True)
    finally:
        if server.mqtt_monitor is not None:
            server.mqtt_monitor.stop()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
