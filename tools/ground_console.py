#!/usr/bin/env python3
"""Local Ground Console for staged SDR-DoA inspection.

The console is intentionally safe at this stage:

* it performs bounded read-only GETs through ``sdr_doa_collector``;
* an optional MQTT monitor subscribes only when ``--mqtt-host`` is supplied;
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
ADMIN_PASSWORD = os.environ.get("SDR_DOA_ADMIN_PASSWORD", "")
if not ADMIN_PASSWORD:
    # Branding remains readable, but admin login is disabled until the operator
    # supplies the local-only password through the environment.
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
    hostname = value.strip().lower().rstrip(".")
    if hostname in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _load_mqtt_monitor_class() -> Any:
    """Load paho only when MQTT monitoring is actually requested."""
    try:
        from sdr_doa_mqtt_monitor import MqttMonitor as monitor_class
    except ModuleNotFoundError as exc:
        if exc.name == "paho":
            raise RuntimeError("MQTT monitor dependency paho-mqtt is not installed") from exc
        raise
    return monitor_class


def _new_mqtt_monitor(host: str, port: int) -> Any:
    return _load_mqtt_monitor_class()(host, port)


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
    mqtt_host: str = "",
    mqtt_port: int = 1883,
    refresh_seconds: int = 0,
) -> Dict[str, Any]:
    return {
        "version": CONSOLE_CONFIG_VERSION,
        "base_url": base_url,
        "mqtt_host": mqtt_host,
        "mqtt_port": int(mqtt_port),
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
        raise ValueError("mqtt_host must be empty or a localhost/loopback address")
    try:
        mqtt_port = int(payload.get("mqtt_port", defaults["mqtt_port"]))
    except (TypeError, ValueError) as exc:
        raise ValueError("mqtt_port must be numeric") from exc
    if not (1 <= mqtt_port <= 65535):
        raise ValueError("mqtt_port must be between 1 and 65535")
    try:
        refresh_seconds = int(payload.get("refresh_seconds", defaults["refresh_seconds"]))
    except (TypeError, ValueError) as exc:
        raise ValueError("refresh_seconds must be numeric") from exc
    if refresh_seconds not in ALLOWED_REFRESH_INTERVALS:
        raise ValueError("refresh_seconds is not an allowed interval")
    return _default_console_config(base_url.rstrip("/"), mqtt_host.strip(), mqtt_port, refresh_seconds)


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
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'">
<title>__APP_NAME__</title>
<style>
:root {
  color-scheme: dark;
  --bg: #070b1c;
  --surface: #0d1330;
  --surface-2: #121a3d;
  --surface-3: #192451;
  --line: #293867;
  --line-soft: rgba(99, 130, 207, .22);
  --text: #edf4ff;
  --muted: #a7b7da;
  --subtle: #7081ad;
  --accent: #2de2e6;
  --accent-bright: #75f6f1;
  --blue: #4e82ff;
  --indigo: #8876ff;
  --good: #4fe0b0;
  --warn: #f0c36a;
  --bad: #ff7189;
  --shadow: 0 14px 34px rgba(0, 0, 0, .30);
}
* { box-sizing: border-box; }
html { min-width: 320px; background: var(--bg); }
body { margin: 0; min-width: 320px; background: radial-gradient(circle at 12% -10%, rgba(78,130,255,.16), transparent 34rem), radial-gradient(circle at 92% 18%, rgba(136,118,255,.10), transparent 30rem), var(--bg); color: var(--text); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
button, input, select { font: inherit; }
button { border: 1px solid transparent; border-radius: 7px; padding: 9px 13px; background: linear-gradient(135deg, var(--blue), var(--indigo)); color: #f7fbff; font-weight: 700; cursor: pointer; box-shadow: 0 4px 14px rgba(78,130,255,.22); }
button:hover { background: linear-gradient(135deg, #6b9aff, #9a8bff); }
button:disabled { opacity: .55; cursor: wait; }
button.ghost { background: rgba(18,26,61,.72); color: var(--text); border-color: var(--line); box-shadow: none; }
button.ghost:hover { background: var(--surface-3); border-color: var(--blue); }
button.danger { background: transparent; border-color: rgba(255,113,137,.55); color: var(--bad); box-shadow: none; }
button.danger:hover { background: rgba(255,113,137,.12); }
input, select { width: 100%; background: #080d23; color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 9px 10px; outline: none; }
input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(45,226,230,.16); }
main { width: min(1440px, calc(100% - 36px)); margin: 0 auto; padding: 0 0 28px; }
.app-chrome { position: sticky; top: 0; z-index: 10; margin: 0 -18px; padding: 0 18px; background: rgba(7,11,28,.90); border-bottom: 1px solid var(--line-soft); box-shadow: 0 12px 28px rgba(4,7,20,.30); backdrop-filter: blur(16px); }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 18px 0 14px; border-bottom: 1px solid var(--line-soft); }
.brand-block { display: flex; align-items: center; gap: 13px; min-width: 0; }
.logo-button { position: relative; flex: 0 0 78px; width: 78px; height: 56px; padding: 0; overflow: hidden; border: 1px dashed var(--accent); background: var(--surface-2); color: var(--accent-bright); letter-spacing: 1.4px; font-size: 10px; }
.logo-button { cursor: default; pointer-events: none; }
.logo-button img { display: block; width: 100%; height: 100%; object-fit: contain; background: var(--surface-2); }
.logo-placeholder { display: grid; place-items: center; width: 100%; height: 100%; text-align: center; padding: 5px; }
.compass-wrap { display:grid; place-items:center; padding:8px 0 0; }
.polar-frame { position:relative; width:min(100%, 600px); min-width:0; aspect-ratio:1; margin-inline:auto; }
.polar-frame canvas { display:block; width:100%; height:100%; }
.polar-overlay { position:absolute; inset:0; display:grid; place-items:center; pointer-events:none; }
.polar-center { display:grid; gap:3px; place-items:center; width:min(220px, calc(100% - 34px)); max-width:calc(100% - 24px); margin-top:0; padding:11px 13px; border:1px solid rgba(45,226,230,.20); border-radius:12px; background:rgba(7,11,28,.84); box-shadow:0 0 24px rgba(7,11,28,.24); text-align:center; }
.compass-label { fill:var(--muted); font-size:12px; font-weight:800; }
.compass-angle-label { color:var(--subtle); font-size:9px; font-weight:800; letter-spacing:.85px; line-height:1.25; text-transform:uppercase; }
.compass-angle { color:var(--text); font-size:27px; font-weight:800; letter-spacing:-.4px; line-height:1.05; }
.compass-status { color:var(--accent-bright); font-size:10px; font-weight:800; letter-spacing:1px; }
.compass-status.unavailable { color:var(--bad); }
.polar-legend { display:flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:7px 15px; max-width:600px; margin:7px auto 0; color:var(--muted); font-size:11px; line-height:1.3; }
.legend-item { display:inline-flex; min-width:0; align-items:center; gap:6px; }
.legend-swatch { display:inline-block; flex:0 0 auto; width:22px; height:3px; border-radius:99px; background:var(--accent); box-shadow:0 0 8px rgba(45,226,230,.55); }
.legend-swatch.peak { width:10px; height:10px; border:2px solid var(--blue); border-radius:50%; box-shadow:none; }
.legend-token { display:inline-grid; place-items:center; min-width:24px; height:18px; padding:0 4px; border:1px solid rgba(136,118,255,.7); border-radius:4px; color:var(--accent-bright); font-size:10px; font-weight:800; }
.polar-meta { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:8px 12px; margin-top:10px; color:var(--subtle); font-size:11px; }
.polar-meta > span { display:grid; min-width:0; gap:2px; }
.polar-meta-label { color:var(--subtle); line-height:1.25; }
.polar-meta strong { color:var(--text); font-weight:700; }
.brand-copy { min-width: 0; }
.eyebrow { margin: 0 0 5px; color: var(--accent); font-size: 10px; font-weight: 800; letter-spacing: 1.4px; text-transform: uppercase; }
h1 { margin: 0; max-width: 650px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: clamp(21px, 3vw, 30px); letter-spacing: -.3px; }
h2 { margin: 0; font-size: 16px; letter-spacing: -.1px; }
.subline { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
.top-actions, .button-row, .chip-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.top-actions { justify-content: flex-end; }
.chip { display: inline-flex; align-items: center; min-height: 27px; padding: 4px 9px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 10px; font-weight: 800; letter-spacing: .8px; text-transform: uppercase; }
.chip.safe { color: var(--good); border-color: rgba(79,224,176,.55); background: rgba(79,224,176,.06); }
.source-strip { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 11px 0 13px; }
.source-value { display: block; overflow: hidden; color: var(--text); font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
.status-line { display:flex; align-items:center; gap:7px; margin: 3px 0 0; color: var(--subtle); font-size: 11px; }
.status-dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--subtle); box-shadow:0 0 0 3px rgba(112,129,173,.12); }
.status-dot.good { background:var(--good); box-shadow:0 0 0 3px rgba(79,224,176,.14); }
.status-dot.bad { background:var(--bad); box-shadow:0 0 0 3px rgba(255,113,137,.14); }
.dashboard-head { display: flex; align-items: end; justify-content: space-between; gap: 15px; padding: 20px 0 13px; }
.dashboard-head p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
.metrics { display: grid; grid-template-columns: 1.35fr repeat(5, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
.metric { min-height: 112px; padding: 14px; border: 1px solid var(--line); border-radius: 9px; background: linear-gradient(145deg, rgba(18,26,61,.94), rgba(13,19,48,.96)); box-shadow: var(--shadow); }
.metric.primary { background: linear-gradient(145deg, rgba(24,42,91,.98), rgba(18,26,61,.98)); border-color: rgba(78,130,255,.72); }
.metric.delivery { border-color: rgba(45,226,230,.42); }
.metric-label { color: var(--muted); font-size: 10px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; }
.metric-value { margin-top: 12px; font-size: 25px; font-weight: 800; letter-spacing: -.4px; }
.metric-value.good { color: var(--good); } .metric-value.warn { color: var(--warn); } .metric-value.bad { color: var(--bad); }
.metric-note { margin-top: 4px; min-height: 18px; color: var(--subtle); font-size: 11px; }
.layout { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(300px, .75fr); gap: 14px; align-items: start; }
.stack { min-width: 0; }
.panel { margin-bottom: 14px; padding: 16px; border: 1px solid var(--line); border-radius: 9px; background: linear-gradient(145deg, rgba(13,19,48,.98), rgba(10,15,37,.98)); box-shadow: var(--shadow); }
.compass-panel { border-color: rgba(45,226,230,.34); background: radial-gradient(circle at 50% 43%, rgba(45,226,230,.055), transparent 48%), linear-gradient(145deg, rgba(18,26,61,.98), rgba(10,15,37,.98)); }
.panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 13px; }
.panel-head > div { min-width: 0; }
.panel-head h2 { color: var(--text); }
.panel-head small { max-width: 52%; color: var(--subtle); font-size: 11px; text-align: right; }
.gate-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; border: 1px solid rgba(255,113,137,.20); border-left: 3px solid var(--bad); background: rgba(255,113,137,.08); }
.gate-banner.good { border-color: rgba(79,224,176,.20); border-left-color: var(--good); background: rgba(79,224,176,.08); }
.gate-title { font-weight: 800; }
.gate-copy { margin: 3px 0 0; color: var(--muted); font-size: 12px; }
.gate-list { display: grid; gap: 7px; margin: 14px 0 0; padding: 0; list-style: none; }
.gate-list li { display: flex; gap: 8px; align-items: baseline; padding: 8px 0; border-bottom: 1px solid var(--line-soft); color: var(--muted); font-size: 12px; }
.gate-list li:last-child { border-bottom: 0; }
.gate-list li::before { content: "!"; display: inline-grid; flex: 0 0 18px; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: rgba(240,195,106,.18); color: var(--warn); font-weight: 800; }
.table { width: 100%; border-collapse: collapse; }
.table th, .table td { padding: 9px 0; border-bottom: 1px solid var(--line-soft); text-align: left; vertical-align: top; }
.table th { width: 34%; color: var(--muted); font-size: 11px; font-weight: 500; }
.table td { color: var(--text); font-size: 12px; overflow-wrap: anywhere; }
.table tr:last-child th, .table tr:last-child td { border-bottom: 0; }
.value-good { color: var(--good) !important; } .value-warn { color: var(--warn) !important; } .value-bad { color: var(--bad) !important; }
.source-table { margin-top: 4px; }
.source-table th:first-child { width: 23%; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.note { margin: 0; padding: 10px 11px; border: 1px solid var(--line); background: rgba(78,130,255,.055); color: var(--muted); font-size: 12px; }
.note strong { color: var(--accent-bright); }
details { margin-top: 12px; border-top: 1px solid var(--line-soft); padding-top: 10px; }
summary { color: var(--muted); cursor: pointer; font-size: 11px; }
pre { max-height: 300px; overflow: auto; margin: 10px 0 0; padding: 11px; border: 1px solid var(--line); border-radius: 6px; background: #080d23; color: #c5d4f5; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
.footer { padding-top: 3px; color: var(--subtle); font-size: 11px; }
.modal { position: fixed; z-index: 20; inset: 0; display: grid; place-items: center; padding: 18px; }
.modal[hidden] { display: none; }
.modal-backdrop { position: absolute; inset: 0; background: rgba(3,6,18,.82); }
.modal-card { position: relative; z-index: 1; width: min(760px, 100%); max-height: min(760px, calc(100vh - 36px)); overflow: auto; border: 1px solid var(--blue); border-radius: 9px; background: var(--surface); box-shadow: 0 24px 70px rgba(0,0,0,.58); }
.modal-head { display: flex; align-items: center; justify-content: space-between; gap: 15px; padding: 17px 18px; border-bottom: 1px solid var(--line); }
.modal-head p { margin: 3px 0 0; color: var(--muted); font-size: 12px; }
.modal-body { padding: 18px; }
.tabs { display: flex; gap: 5px; margin-bottom: 17px; border-bottom: 1px solid var(--line); }
.tab { margin-bottom: -1px; border-radius: 5px 5px 0 0; background: transparent; color: var(--muted); border-color: transparent transparent var(--line) transparent; }
.tab.active { color: var(--text); border-color: var(--blue) var(--blue) var(--surface); background: var(--surface-2); }
.tab-panel[hidden] { display: none; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.field { display: grid; gap: 5px; }
.field.full { grid-column: 1 / -1; }
.field label { color: var(--muted); font-size: 11px; }
.help { margin: 5px 0 0; color: var(--subtle); font-size: 11px; }
.form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.admin-box { padding: 13px; border: 1px solid var(--line); background: var(--surface-2); }
.admin-box + .admin-box { margin-top: 12px; }
.admin-status { min-height: 18px; margin: 9px 0 0; color: var(--muted); font-size: 12px; }
.admin-status.good { color: var(--good); } .admin-status.bad { color: var(--bad); }
.logo-preview { display: grid; place-items: center; width: 120px; height: 78px; margin-top: 8px; border: 1px dashed var(--accent); background: var(--surface); color: var(--subtle); font-size: 10px; letter-spacing: 1px; }
.logo-preview img { max-width: 100%; max-height: 100%; object-fit: contain; }
@media (max-width: 1120px) { .metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); } .metric.primary { grid-column: span 3; } }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
@media (max-width: 820px) { main { width: min(100% - 24px, 700px); } .app-chrome { margin-inline:0; padding-inline:0; } .topbar, .source-strip, .dashboard-head { align-items: stretch; flex-direction: column; } .top-actions { justify-content: flex-start; } .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .metric.primary { grid-column: span 2; } }
@media (max-width: 520px) { h1 { white-space: normal; } .metrics, .form-grid { grid-template-columns: 1fr; } .metric.primary, .field.full { grid-column: auto; } .panel { padding: 13px; } .panel-head { align-items: flex-start; flex-direction: column; } .panel-head small { max-width: 100%; text-align: left; } .polar-frame { width: 100%; } .polar-center { width:min(210px, calc(100% - 30px)); padding:10px 11px; } .polar-legend { justify-content:flex-start; gap:8px 14px; } .polar-meta { grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px 12px; } .button-row { width:100%; } .button-row button { flex:1 1 0; min-width:0; } .top-actions { width:100%; } .gate-banner { align-items:flex-start; flex-direction:column; } .gate-banner .chip { align-self:flex-start; } .modal { padding:8px; } .modal-card { max-height: calc(100vh - 16px); } }
@media (max-width: 380px) { main { width:calc(100% - 16px); } .panel { padding:11px; } .polar-legend { font-size:10px; } }
</style>
</head>
<body>
<main>
  <div class="app-chrome">
  <header class="topbar">
    <div class="brand-block">
      <div id="logo-open-settings" class="logo-button" title="Logo aplikasi" aria-label="Logo aplikasi">
        <span id="logo-placeholder" class="logo-placeholder">LOGO<br><small>atur di admin</small></span>
        <img id="logo-image" alt="Logo aplikasi" hidden>
      </div>
      <div class="brand-copy">
        <p class="eyebrow">GROUND STATION / SDR-DOA</p>
        <h1 id="app-name">__APP_NAME__</h1>
        <p class="subline">Panel operasi dan diagnosis · sumber sensor tetap digate sebelum publikasi</p>
      </div>
    </div>
    <div class="top-actions">
      <span class="chip safe">read-only</span>
      <span class="chip">loopback · GET</span>
      <button id="settings-open" class="ghost" type="button">Pengaturan</button>
    </div>
  </header>

  <section class="source-strip">
    <div>
      <p class="eyebrow">SUMBER DATA</p>
      <strong id="source-url" class="source-value">__BASE_URL__</strong>
      <p id="message" class="status-line"><span id="status-dot" class="status-dot" aria-hidden="true"></span><span>Menunggu pembacaan pertama…</span></p>
    </div>
    <div class="button-row">
      <button id="refresh" type="button">Refresh</button>
      <button id="auto-refresh" class="ghost" type="button">Auto: off</button>
    </div>
  </section>
  </div>

  <section class="dashboard-head">
    <div>
      <p class="eyebrow">RINGKASAN OPERASIONAL</p>
      <h2>Gambaran sistem saat ini</h2>
      <p>Reachability, kesehatan DAQ, freshness DoA, dan delivery ditampilkan sebagai gate terpisah.</p>
    </div>
    <span id="last-read-chip" class="chip">belum ada sample</span>
  </section>

  <section class="metrics">
    <article class="metric primary"><div class="metric-label">Status keseluruhan</div><div id="overall" class="metric-value">—</div><div id="overall-detail" class="metric-note">menunggu snapshot</div></article>
    <article class="metric"><div class="metric-label">Kesehatan DAQ</div><div id="daq" class="metric-value">—</div><div id="daq-detail" class="metric-note">sync flags</div></article>
    <article class="metric"><div class="metric-label">Usia DoA</div><div id="doa-age" class="metric-value">—</div><div id="doa-detail" class="metric-note">CSV / XML</div></article>
    <article class="metric delivery"><div class="metric-label">Delivery gate</div><div id="delivery-state" class="metric-value">BLOCKED</div><div id="delivery-detail" class="metric-note">publish ditahan</div></article>
    <article class="metric"><div class="metric-label">Frame terbuang</div><div id="drops" class="metric-value">—</div><div id="drops-detail" class="metric-note">counter status</div></article>
    <article class="metric"><div class="metric-label">MQTT monitor</div><div id="mqtt-connection" class="metric-value">OFF</div><div id="mqtt-detail" class="metric-note">subscriber-only</div></article>
  </section>

  <section class="layout">
    <div class="stack">
      <article class="panel compass-panel">
        <div class="panel-head"><div><h2>DoA estimation · polar</h2><small>gaya KrakenSDR · 360-bin display axis · 0–359°</small></div><small id="compass-source">Data Out · display-only</small></div>
        <div class="compass-wrap">
          <div class="polar-frame"><canvas id="doa-polar" role="img" aria-describedby="polar-legend compass-detail" aria-label="Polar DoA estimation"></canvas><div class="polar-overlay"><div class="polar-center"><div class="compass-angle-label">canonical source angle · θ₀</div><div id="compass-angle" class="compass-angle">—°</div><div id="compass-display-angle" class="compass-angle-label">plot peak · display —°</div><div id="compass-status" class="compass-status">menunggu data</div></div></div></div>
        </div>
        <div id="polar-legend" class="polar-legend" aria-label="Legend polar"><span class="legend-item"><span class="legend-swatch" aria-hidden="true"></span><span>360-bin vector · native shifted dB · display axis</span></span><span class="legend-item"><span class="legend-swatch peak" aria-hidden="true"></span><span>plot peak / display angle</span></span><span class="legend-item"><span class="legend-token" aria-hidden="true">θ₀</span><span>canonical source angle</span></span></div>
        <div class="polar-meta"><span><span class="polar-meta-label">Plot peak · display</span><strong id="polar-peak">—</strong></span><span><span class="polar-meta-label">Canonical source · θ₀</span><strong id="polar-canonical">—</strong></span><span><span class="polar-meta-label">Peak value · native</span><strong id="polar-peak-db">—</strong></span><span><span class="polar-meta-label">Vector bins</span><strong id="polar-bins">—</strong></span></div>
        <p id="compass-detail" class="note">Canonical source angle (θ₀) is separate from the plotted 360-bin display peak. Both are observability-only; no authority or publication decision is inferred.</p>
      </article>
      <article class="panel">
        <div class="panel-head"><h2>Gate publikasi DoA</h2><small id="gate-count">—</small></div>
        <div id="gate-banner" class="gate-banner"><div><div id="gate-title" class="gate-title">BLOCKED</div><p id="gate-copy" class="gate-copy">Belum ada keputusan.</p></div><span id="gate-pill" class="chip">BLOCKED</span></div>
        <ul id="gate-reasons" class="gate-list"><li>Menunggu snapshot</li></ul>
        <details><summary>Lihat pemeriksaan teknis</summary><pre id="gate-debug">—</pre></details>
      </article>

      <article class="panel">
        <div class="panel-head"><h2>Perbandingan sumber DoA</h2><small>diagnosis, bukan authority</small></div>
        <table class="table source-table"><tbody id="doa-rows"></tbody></table>
        <p class="note" style="margin-top:13px"><strong>Catatan:</strong> CSV dan XML adalah dua view native yang harus dikorelasikan. Console tidak memilih authority secara otomatis.</p>
      </article>

      <article class="panel">
        <div class="panel-head"><h2>MQTT monitor</h2><small>display-only</small></div>
        <table class="table"><tbody id="mqtt-rows"></tbody></table>
        <details><summary>Payload terakhir per stream</summary><pre id="mqtt-last">Belum ada pesan.</pre></details>
      </article>
    </div>

    <div class="stack">
      <article class="panel">
        <div class="panel-head"><h2>Kesehatan node</h2><small>Data Out :8081</small></div>
        <table class="table"><tbody id="status-rows"></tbody></table>
      </article>

      <article class="panel">
        <div class="panel-head"><h2>Settings efektif</h2><small>safe subset</small></div>
        <table class="table"><tbody id="settings-rows"></tbody></table>
        <p class="help">Raw settings, credentials, log tidak ditampilkan atau dikirim console. Vektor dB shifted hanya dipakai lokal untuk observability polar dan tidak diteruskan ke MQTT atau LAN agent.</p>
      </article>

      <article class="panel">
        <div class="panel-head"><h2>Maintenance boundary</h2><small>local ground</small></div>
        <p class="note"><strong>Transport:</strong> Data Out dibaca dengan HTTP GET melalui URL yang diizinkan. MQTT hanya subscriber monitor. <strong>control dry-run</strong> saja: tidak ada publish sensor, POST Raspberry, atau settings apply dari panel ini.</p>
      </article>
    </div>
  </section>
  <p class="footer">SDR-DoA Ground Console · gunakan Pengaturan untuk semua konfigurasi tampilan dan koneksi lokal.</p>
</main>

<div id="settings-modal" class="modal" hidden>
  <div class="modal-backdrop" data-close-settings></div>
  <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <header class="modal-head">
      <div><p class="eyebrow">KONFIGURASI CONSOLE</p><h2 id="settings-title">Pengaturan</h2><p>Semua pengaturan tampilan dan koneksi Ground ada di sini.</p></div>
      <button id="settings-close" class="ghost" type="button" aria-label="Tutup pengaturan">Tutup</button>
    </header>
    <div class="modal-body">
      <nav class="tabs" aria-label="Tab pengaturan">
        <button class="tab active" data-tab="connection" type="button">Data & koneksi</button>
        <button class="tab" data-tab="branding" type="button">Admin & branding</button>
      </nav>
      <section id="tab-connection" class="tab-panel">
        <p class="note"><strong>Aman untuk staging:</strong> perubahan di sini hanya mengubah sumber baca dan monitor lokal Ground Console. Tidak mengubah Raspberry.</p>
        <div class="form-grid" style="margin-top:14px">
          <div class="field full"><label for="data-url">Data Out URL</label><input id="data-url" value="__BASE_URL__" spellcheck="false"><p class="help">HTTP GET hanya ke doasdr.local, 192.168.100.100, atau loopback. Telemetry PPP tetap masuk ke broker Ground melalui MQTT.</p></div>
          <div class="field"><label for="mqtt-host">Host MQTT monitor</label><input id="mqtt-host" value="__MQTT_HOST__" placeholder="127.0.0.1" spellcheck="false"></div>
          <div class="field"><label for="mqtt-port">Port MQTT</label><input id="mqtt-port" type="number" value="__MQTT_PORT__" min="1" max="65535"></div>
          <div class="field"><label for="refresh-interval">Auto-refresh</label><select id="refresh-interval"><option value="0">Mati</option><option value="5">Setiap 5 detik</option><option value="10">Setiap 10 detik</option><option value="30">Setiap 30 detik</option></select></div>
        </div>
        <div class="form-actions"><button id="apply-connection" type="button">Terapkan & refresh</button><button id="monitor-connect" class="ghost" type="button">Sambungkan monitor MQTT</button></div>
        <p id="connection-status" class="admin-status"></p>
      </section>
      <section id="tab-branding" class="tab-panel" hidden>
        <div id="admin-login-box" class="admin-box">
          <p class="eyebrow">ADMIN LOKAL</p>
          <h2>Masuk untuk mengubah identitas aplikasi</h2>
          <p class="help">Password hanya dipakai oleh Ground Console lokal. Default saat ini mengikuti permintaan operator.</p>
          <div class="form-grid" style="margin-top:12px"><div class="field"><label for="admin-password">Password admin</label><input id="admin-password" type="password" autocomplete="current-password"></div></div>
          <div class="form-actions"><button id="admin-login" type="button">Masuk</button></div>
          <p id="admin-login-status" class="admin-status"></p>
        </div>
        <div id="admin-workspace" class="admin-box" hidden>
          <div class="panel-head"><div><p class="eyebrow">BRANDING</p><h2>Identitas aplikasi</h2></div><button id="admin-logout" class="danger" type="button">Keluar</button></div>
          <div class="form-grid">
            <div class="field full"><label for="brand-name">Nama aplikasi</label><input id="brand-name" maxlength="60" autocomplete="off"></div>
            <div class="field full"><label for="brand-logo">Logo aplikasi</label><input id="brand-logo" type="file" accept="image/png"><p class="help">PNG tervalidasi, maksimal 256 KiB. Kosongkan pilihan untuk mempertahankan logo.</p><div class="logo-preview"><span id="preview-placeholder">PREVIEW</span><img id="brand-preview" alt="Preview logo" hidden></div></div>
          </div>
          <div class="form-actions"><button id="brand-reset-logo" class="ghost" type="button">Hapus logo</button><button id="brand-save" type="button">Simpan branding</button></div>
          <p id="brand-status" class="admin-status"></p>
        </div>
      </section>
    </div>
  </section>
</div>

<script>
const initialConfig = __CONSOLE_CONFIG_JSON__;
const $ = (id) => document.getElementById(id);
if (initialConfig && initialConfig.refresh_seconds !== undefined) $('refresh-interval').value = String(initialConfig.refresh_seconds);
const state = { dataUrl: $('data-url').value, autoTimer: null, branding: null, pendingLogo: null, refreshSequence: 0, mqttSequence: 0, refreshController: null, polar: { values: null, angle: null, fresh: false, figType: 'Polar', compassOffset: 0 } };
function esc(value) { return String(value ?? '—').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;'); }
function kind(value) { const s=String(value||'').toUpperCase(); return s==='LIVE'||s==='PASS'||s==='READY'?'good':(s==='DEGRADED'||s==='STALE'||s==='BLOCKED'||s==='FAIL'?'bad':'warn'); }
function pill(value) { const cls=kind(value); return `<span class="chip ${cls==='good'?'safe':''}">${esc(value)}</span>`; }
function rows(items) { return items.map(([key,value,cls='']) => `<tr><th>${esc(key)}</th><td class="${cls}">${value}</td></tr>`).join(''); }
function safeValue(value) { return typeof value === 'object' && value !== null ? esc(JSON.stringify(value)) : esc(value); }
function formatAge(freshness) { if(!freshness) return '—'; if(freshness.age_ms===null||freshness.age_ms===undefined) return 'jam tidak terverifikasi'; return `${(Number(freshness.age_ms)/1000).toFixed(1)} s`; }
function formatNumber(value, digits=2) { return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'; }
function boolLabel(value) { return value===true?'ya':(value===false?'tidak':'—'); }
function reasonLabel(reason) { return ({
  GROUND_CLOCK_UNVERIFIED:'Jam Ground dan node belum terverifikasi',
  CANONICAL_ANGLE_NOT_CONFIGURED:'Konvensi sudut canonical belum disetujui',
  DOA_AUTHORITY_NOT_SELECTED:'Sumber authority DoA belum dipilih',
  SELECTED_UNITS_NOT_READY:'Unit contract source terpilih belum siap',
  CONFIDENCE_MAPPING_UNVERIFIED:'PAPR native belum dipetakan ke confidence MQTT 0–1',
  POWER_MAPPING_UNVERIFIED:'Power native belum dikalibrasi ke power_db contract',
  POWER_FLOOR_LOSSY:'Power XML berada di floor dan kehilangan informasi',
  NATIVE_DOA_VIEWS_CONFLICT:'View CSV dan XML berbeda setelah canonicalisasi',
  DAQ_HEALTH_GATE_FAILED:'DAQ atau sinkronisasi frame gagal',
  DOA_CANDIDATES_STALE:'Output DoA lebih tua dari batas freshness',
  STATUS_UNAVAILABLE_OR_INVALID:'Status node tidak tersedia atau tidak valid'
}[reason]||reason); }
function setStatus(id, text, cls='') { $(id).textContent=text; $(id).className=`admin-status ${cls}`; }
function setReadStatus(text, cls='') { const message=$('message'); const label=message?.querySelector('span:last-child'); if(label) label.textContent=text; else message.textContent=text; $('status-dot').className=`status-dot ${cls}`; }
function renderBranding(data) {
  state.branding=data||{app_name:'SDR-DoA Ground Console',logo_data_url:''};
  $('app-name').textContent=state.branding.app_name;
  document.title=state.branding.app_name;
  const hasLogo=Boolean(state.branding.logo_data_url);
  $('logo-image').hidden=!hasLogo; $('logo-placeholder').hidden=hasLogo;
  if(hasLogo) $('logo-image').src=state.branding.logo_data_url; else $('logo-image').removeAttribute('src');
  $('brand-name').value=state.branding.app_name;
  const preview=state.pendingLogo ?? state.branding.logo_data_url;
  $('brand-preview').hidden=!preview; $('preview-placeholder').hidden=Boolean(preview);
  if(preview) $('brand-preview').src=preview;
}
async function loadBranding() { try { const r=await fetch('/api/branding',{cache:'no-store'}); if(r.ok) renderBranding(await r.json()); } catch(e) {} }
function renderMqtt(data) {
  const enabled=Boolean(data&&data.enabled); const connection=data?.connection||'off';
  $('mqtt-connection').textContent=enabled?connection.toUpperCase():'OFF'; $('mqtt-connection').className=`metric-value ${kind(enabled&&connection==='connected'?'PASS':(enabled?'DEGRADED':'UNKNOWN'))}`;
  $('mqtt-detail').textContent=enabled?`${data.host}:${data.port} · ${data.valid||0}/${data.received||0} valid`:'subscriber-only / mati';
  if(!enabled){ $('mqtt-rows').innerHTML=rows([['Mode','Mati'],['Publish',pill('disabled')]]); $('mqtt-last').textContent='Monitor MQTT belum diaktifkan.'; return; }
  $('mqtt-rows').innerHTML=rows([
    ['Koneksi',pill(connection)],['Pesan',esc(data.received)],['Valid / invalid',esc(`${data.valid} / ${data.invalid}`)],['Bytes',esc(data.total_bytes)],['Latency terakhir',esc(data.last_latency_ms===null?'—':`${data.last_latency_ms} ms`)],['Usia pesan',esc(data.last_age_ms===null?'—':`${data.last_age_ms} ms`)],['Topic terakhir',esc(data.last_topic||'—')],['Publish',pill('false')]
  ]);
  $('mqtt-last').textContent=JSON.stringify(data.last_by_kind||{},null,2);
}
function polarSettings(figType, compassOffset) {
  const requested=String(figType||'Polar').trim();
  const safeType=requested.toLowerCase()==='compass'?'Compass':'Polar';
  const numeric=Number(compassOffset);
  return { figType:safeType, compassOffset:Number.isFinite(numeric)?numeric:0 };
}
function normalizeDegrees(deg) { return ((Number(deg)%360)+360)%360; }
function drawPolar(values, angle, fresh, figType='Polar', compassOffset=0) {
  const canvas=$('doa-polar');
  const frame=canvas?.closest('.polar-frame')||canvas?.parentElement;
  if(!canvas||!frame) return;
  const cssSize=Math.max(1,Math.floor(frame.getBoundingClientRect().width||frame.clientWidth||520));
  const dpr=Math.min(window.devicePixelRatio||1,2);
  const size=Math.max(1,Math.floor(cssSize*dpr));
  if(canvas.width!==size||canvas.height!==size){ canvas.width=size; canvas.height=size; }
  const ctx=canvas.getContext('2d');
  if(!ctx) return;
  ctx.setTransform(size/cssSize,0,0,size/cssSize,0,0);
  ctx.clearRect(0,0,cssSize,cssSize);
  const styles=getComputedStyle(document.documentElement);
  const line=styles.getPropertyValue('--line').trim()||'#293867';
  const muted=styles.getPropertyValue('--muted').trim()||'#a7b7da';
  const subtle=styles.getPropertyValue('--subtle').trim()||'#7081ad';
  const accent=styles.getPropertyValue('--accent').trim()||'#2de2e6';
  const blue=styles.getPropertyValue('--blue').trim()||'#4e82ff';
  const cx=cssSize/2, cy=cssSize/2, maxR=cssSize*.365;
  const settings=polarSettings(figType,compassOffset);
  const toDisplayAngle=deg=>normalizeDegrees(settings.figType==='Compass'?360-deg+settings.compassOffset:deg);
  const toRadians=deg=>(deg-90)*Math.PI/180;
  ctx.save();
  ctx.translate(cx,cy);
  ctx.lineWidth=1;
  ctx.strokeStyle=line;
  ctx.globalAlpha=.92;
  [.25,.5,.75,1].forEach(f=>{ ctx.beginPath(); ctx.arc(0,0,maxR*f,0,Math.PI*2); ctx.stroke(); });
  for(let deg=0;deg<360;deg+=45){
    const radians=toRadians(deg);
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(radians)*maxR,Math.sin(radians)*maxR); ctx.stroke();
  }
  ctx.globalAlpha=1;
  ctx.fillStyle=muted;
  ctx.font='700 10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  ctx.textAlign='center';
  ctx.textBaseline='middle';
  const perimeterInset=Math.max(9,cssSize*.035);
  const cardinalRadius=Math.min(maxR+Math.min(23,Math.max(15,cssSize*.06)),cssSize/2-perimeterInset);
  const degreeRadius=Math.min(maxR+Math.min(18,Math.max(12,cssSize*.045)),cssSize/2-perimeterInset);
  const directions=[['N',0],['E',90],['S',180],['W',270]];
  directions.forEach(([label,deg])=>{
    const radians=toRadians(deg);
    ctx.fillText(label,Math.cos(radians)*cardinalRadius,Math.sin(radians)*cardinalRadius);
  });
  ctx.fillStyle=subtle;
  ctx.font='10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  const diagonalDegrees=new Set([45,135,225,315]);
  for(let deg=0;deg<360;deg+=45){
    const radians=toRadians(deg);
    ctx.beginPath(); ctx.moveTo(Math.cos(radians)*maxR,Math.sin(radians)*maxR); ctx.lineTo(Math.cos(radians)*(maxR+6),Math.sin(radians)*(maxR+6)); ctx.stroke();
    if(diagonalDegrees.has(deg)) ctx.fillText(`${deg}°`,Math.cos(radians)*degreeRadius,Math.sin(radians)*degreeRadius);
  }
  const finite=Array.isArray(values)&&values.length===360?values.map(Number):null;
  const validData=Boolean(fresh&&finite&&finite.every(Number.isFinite));
  if(validData){
    const floor=Math.min(...finite), peakValue=Math.max(...finite), span=peakValue-floor;
    const yFor=value=>span>0?Math.max(0,Math.min(1,(value-floor)/span)):1;
    ctx.textAlign='left';
    ctx.fillStyle=subtle;
    ctx.font='9px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
    const precision=span<5?1:0;
    [.25,.5,.75,1].forEach(f=>{ const label=`${(floor+span*f).toFixed(precision)} dB`; const radius=maxR*f; ctx.fillText(label,radius+7,2); });
    const point=(value,index)=>{
      const radians=toRadians(toDisplayAngle(index)), radius=maxR*yFor(value);
      return [Math.cos(radians)*radius,Math.sin(radians)*radius];
    };
    const drawCurve=()=>{
      finite.forEach((value,index)=>{ const [x,y]=point(value,index); index?ctx.lineTo(x,y):ctx.moveTo(x,y); });
      const [x0,y0]=point(finite[0],0); ctx.lineTo(x0,y0);
    };
    ctx.beginPath(); drawCurve(); ctx.closePath(); ctx.fillStyle='rgba(45,226,230,.14)'; ctx.fill();
    ctx.beginPath(); drawCurve(); ctx.closePath(); ctx.strokeStyle=accent; ctx.lineWidth=2; ctx.shadowColor='rgba(45,226,230,.48)'; ctx.shadowBlur=8; ctx.stroke();
    const peakIndex=finite.indexOf(peakValue);
    if(peakIndex>=0){
      const displayPeak=toDisplayAngle(peakIndex), [px,py]=point(finite[peakIndex],peakIndex);
      ctx.shadowBlur=0; ctx.fillStyle=accent; ctx.beginPath(); ctx.arc(px,py,3.5,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle=blue; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(px,py); ctx.lineTo(Math.cos(toRadians(displayPeak))* (maxR+12),Math.sin(toRadians(displayPeak))*(maxR+12)); ctx.stroke();
      ctx.fillStyle=accent; ctx.font='700 9px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'; ctx.textAlign='center'; ctx.fillText(`PLOT ${displayPeak.toFixed(0)}°`,px,py < -maxR*.45 ? py+15 : py-11);
    }
  }
  ctx.restore();
}
function setPolarUnavailable(reason='polar unavailable', settings=polarSettings(state.polar?.figType,state.polar?.compassOffset)) {
  state.polar={values:null,angle:null,fresh:false,figType:settings.figType,compassOffset:settings.compassOffset};
  drawPolar(null,null,false,settings.figType,settings.compassOffset);
  $('polar-peak').textContent='—'; $('polar-canonical').textContent='—'; $('polar-peak-db').textContent='—'; $('polar-bins').textContent='—';
  $('compass-angle').textContent='—°'; $('compass-display-angle').textContent='plot peak · display —°'; $('compass-status').textContent='POLAR UNAVAILABLE'; $('compass-status').className='compass-status unavailable'; $('compass-source').textContent='Data Out · unavailable'; $('compass-detail').textContent=reason; $('doa-polar').setAttribute('aria-label',`Polar DoA unavailable. ${reason}`);
}
function renderPolar(snapshot,csv,dataAvailable) {
  const fields=snapshot.settings?.fields||{}; const requestedType=Object.prototype.hasOwnProperty.call(fields,'doa_fig_type')?fields.doa_fig_type:state.polar?.figType; const requestedOffset=Object.prototype.hasOwnProperty.call(fields,'compass_offset')?fields.compass_offset:state.polar?.compassOffset;
  const settings=polarSettings(requestedType,requestedOffset);
  const angle=Number(csv.canonical_angle_deg);
  const values=Array.isArray(csv.angular_power_db)?csv.angular_power_db:null;
  const fresh=Boolean(dataAvailable&&csv.freshness?.fresh===true&&values?.length===360&&values.every(value=>Number.isFinite(Number(value))));
  state.polar={values,angle:Number.isFinite(angle)?angle:null,fresh,figType:settings.figType,compassOffset:settings.compassOffset};
  if(!fresh||!Number.isFinite(angle)){ setPolarUnavailable('Kurva dihapus: data DoA stale, konflik, atau tidak lengkap.',settings); return; }
  drawPolar(values,angle,true,settings.figType,settings.compassOffset);
  const peakIndex=Number(csv.angular_peak_index);
  const peakReady=Number.isInteger(peakIndex)&&peakIndex>=0&&peakIndex<values.length;
  const displayAngle=settings.figType==='Compass'&&peakReady?normalizeDegrees(360-peakIndex+settings.compassOffset):(peakReady?peakIndex:null);
  const peakLabel=displayAngle===null?'—':`${displayAngle.toFixed(0)}° · bin ${peakIndex}`;
  const canonicalLabel=`${angle.toFixed(1)}° · θ₀`;
  $('polar-peak').textContent=peakLabel;
  $('polar-canonical').textContent=canonicalLabel;
  $('polar-peak-db').textContent=Number.isFinite(Number(csv.angular_peak_db))?`${Number(csv.angular_peak_db).toFixed(1)} dB`:'—';
  $('polar-bins').textContent=String(values.length);
  $('compass-angle').textContent=`${angle.toFixed(1)}°`; $('compass-display-angle').textContent=`plot peak · display ${displayAngle===null?'—':displayAngle.toFixed(0)+'°'} · bin ${peakReady?peakIndex:'—'}`; $('compass-status').textContent='DATA TERSEDIA'; $('compass-status').className='compass-status'; $('compass-source').textContent=`Data Out · ${settings.figType} display axis · ${formatAge(csv.freshness)}`; $('compass-detail').textContent=`Canonical source ${angle.toFixed(1)}° (θ₀) versus plotted display peak ${displayAngle===null?'—':displayAngle.toFixed(0)+'°'} (bin ${peakReady?peakIndex:'—'}). Keduanya dipertahankan sebagai metadata terpisah · display-only.`; $('doa-polar').setAttribute('aria-label',`Polar DoA. Canonical source angle ${angle.toFixed(1)} degrees. Plotted 360-bin peak display angle ${displayAngle===null?'unavailable':displayAngle.toFixed(0)+' degrees, bin '+peakIndex}. Display-only.`);
}
function render(snapshot) {
  const gate=snapshot.publication_gate||{}; const status=snapshot.status||{}; const safe=status.safe||{}; const csv=(snapshot.doa_candidates||{}).csv||{}; const xml=(snapshot.doa_candidates||{}).xml||{};
  const overall=snapshot.overall_state||'UNKNOWN'; $('overall').textContent=overall; $('overall').className=`metric-value ${kind(overall)}`; $('overall-detail').textContent=`DAQ ${status.daq_health||'—'} · native DoA ${csv.native_metrics_state||'—'} · delivery ${gate.state||'—'}`; $('gate-count').textContent=`${(gate.reasons||[]).length} gate`; $('last-read-chip').textContent=`dibaca ${new Date().toLocaleTimeString()}`;
  const daq=status.daq_health||'UNKNOWN'; const daqTop=safe.daq_status||{}; const syncFlags=[daqTop.frame_sync,daqTop.sample_delay_sync,daqTop.iq_sync]; const syncPassed=syncFlags.filter(value=>value===true).length; $('daq').textContent=daq; $('daq').className=`metric-value ${kind(daq)}`; $('daq-detail').textContent=`frame #${daqTop.data_frame_index??'—'} · sync ${syncPassed}/3`;
  const consistency=snapshot.native_consistency||{}; const authority=snapshot.authority||{};
  const freshnessItems=[csv.freshness,xml.freshness].filter(Boolean); const ages=freshnessItems.map(x=>x.age_ms); const validAges=ages.length===2&&ages.every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0); const maxAge=validAges?Math.max(...ages):null; const freshnessOk=validAges&&freshnessItems.every(x=>x.fresh===true); $('doa-age').textContent=maxAge===null?'—':`${(Number(maxAge)/1000).toFixed(1)} s`; $('doa-age').className=`metric-value ${freshnessOk&&maxAge<=5000?'good':'bad'}`; const relation=consistency.conflict===true?'CONFLICT':(consistency.comparable===true?(typeof consistency.circular_distance_deg==='number'&&consistency.circular_distance_deg<=3?'equal':'different'):'not comparable'); $('doa-detail').textContent=`canonical CSV ${formatNumber(csv.canonical_angle_deg,1)}° / XML ${formatNumber(xml.canonical_angle_deg,1)}° · ${relation}`;
  const drops=safe.daq_num_dropped_frames; $('drops').textContent=drops===undefined?'—':drops; $('drops').className=`metric-value ${drops===0?'good':'warn'}`; $('drops-detail').textContent='counter status.json';
  const dataAvailable=Boolean(csv.available&&xml.available&&csv.freshness?.fresh&&xml.freshness?.fresh&&consistency.comparable===true&&consistency.conflict!==true); const gateState=String(gate.state||'BLOCKED').toUpperCase(); $('delivery-state').textContent=gateState; $('delivery-state').className=`metric-value ${kind(gateState)}`; $('delivery-detail').textContent=gateState==='READY'?'delivery siap':'publish ditahan'; $('gate-title').textContent=gateState; $('gate-pill').innerHTML=pill(gateState); $('gate-banner').className=`gate-banner ${gateState==='READY'?'good':''}`; $('gate-copy').textContent=gateState==='READY'?'Delivery siap.':(dataAvailable?'Data DoA tersedia untuk observasi; delivery publish masih ditahan oleh gate.':'Data DoA belum cukup fresh/konsisten untuk ditampilkan sebagai usable.');
  renderPolar(snapshot,csv,dataAvailable);
  const reasons=gate.reasons||[]; $('gate-reasons').innerHTML=reasons.length?reasons.map(reason=>`<li><span>${esc(reasonLabel(reason))}</span><small class="mono">${esc(reason)}</small></li>`).join(''):'<li>Tidak ada alasan gate.</li>'; $('gate-debug').textContent=JSON.stringify({state:gateState,checks:gate.checks||{},reasons},null,2);
  const sourceRow=(label,candidate)=>[
    [label, candidate.available?pill('parsed'):pill('unavailable')],
    ['  raw angle', candidate.available?`${formatNumber(candidate.doa_raw_deg,1)}° <span class="muted">(${esc(candidate.angle_convention||'native')})</span>`:'—'],
    ['  canonical angle', candidate.available?`${formatNumber(candidate.canonical_angle_deg,1)}° <span class="muted">(${esc(candidate.canonical_angle_convention||'—')})</span>`:'—'],
    ['  freshness', candidate.available?`${formatAge(candidate.freshness)} · ${candidate.freshness?.fresh===true?'fresh':'tidak fresh'}`:'—'],
    ['  PAPR native', candidate.available?`${formatNumber(candidate.confidence_metric_db,3)} dB · ${candidate.confidence_metric_valid?'valid':'invalid'}`:'—'],
    ['  power native', candidate.available?`${formatNumber(candidate.power_native_db,2)} dB · ${candidate.power_native_valid?'valid':'invalid'}`:'—'],
    ['  frequency', candidate.available?`${esc(candidate.frequency_hz_normalized??'—')} Hz`:'—'],
    ['  contract mapping', candidate.available?`${esc(candidate.contract_mapping_state||'—')} · ${esc((candidate.unit_reasons||[]).join(', ')||'—')}`:'—']
  ];
  $('doa-rows').innerHTML=rows([
    ['Publikasi',pill(gateState)],
    ['Korelasi native',consistency.comparable?`${consistency.same_timestamp?'timestamp sama':'timestamp berbeda'} · selisih canonical ${formatNumber(consistency.circular_distance_deg,1)}°`:'belum comparable'],
    ...sourceRow('CSV',csv),
    ...sourceRow('XML',xml),
    ['Authority',esc(authority.selected||'none')],
    ['Canonical angle gate',authority.canonical_angle_ready?'ready':'belum disetujui'],
    ['Contract confidence',authority.selected_doa?.confidence===null?'belum dipetakan ke 0–1':esc(authority.selected_doa?.confidence??'—')],
    ['Catatan gate',esc((gate.reasons||[]).map(reasonLabel).join(' · ')||'—')]
  ]);
  const daqStatus=safe.daq_status||{};
  $('status-rows').innerHTML=rows([
    ['DAQ',pill(daq)],['daq_ok',boolLabel(safe.daq_ok)],['Frame index',esc(daqStatus.data_frame_index)],['Frame sync',boolLabel(daqStatus.frame_sync)],['Sample-delay sync',boolLabel(daqStatus.sample_delay_sync)],['IQ sync',boolLabel(daqStatus.iq_sync)],['ADC overdrive',boolLabel(daqStatus.adc_overdrive)],['Dropped frames',esc(safe.daq_num_dropped_frames)],['Sampling',esc(daqStatus.sampling_frequency_hz?`${daqStatus.sampling_frequency_hz} Hz`:'—')],['Station',esc(safe.station_id)],['Software',esc(safe.software_version)],['Source hash',esc(safe.software_git_short_hash)],['GPS',esc(safe.gps_status)]
  ]);
  const settings=snapshot.settings||{}; const sf=settings.fields||{}; $('settings-rows').innerHTML=Object.keys(sf).sort().map(key=>[key,safeValue(sf[key])]).map(([key,value])=>`<tr><th>${esc(key)}</th><td>${value}</td></tr>`).join('')||'<tr><td colspan="2">Tidak tersedia</td></tr>';
  $('source-url').textContent=snapshot.collector?.base_url||state.dataUrl; setReadStatus(`Snapshot berhasil dibaca · ${new Date().toLocaleTimeString()}`,'good');
}
async function refreshMqtt() { const sequence=++state.mqttSequence; try { const r=await fetch('/api/mqtt',{cache:'no-store'}); const payload=await r.json(); if(sequence!==state.mqttSequence) return; renderMqtt(payload); } catch(e) { if(sequence!==state.mqttSequence) return; renderMqtt({enabled:true,connection:'error',host:'?',port:'?',received:0,valid:0,invalid:0,total_bytes:0,last_latency_ms:null,last_age_ms:null,last_topic:null,last_by_kind:{error:'monitor tidak tersedia'}}); } }
async function refresh() {
  const sequence=++state.refreshSequence;
  if(state.refreshController) state.refreshController.abort();
  const controller=typeof AbortController==='function'?new AbortController():null;
  state.refreshController=controller;
  const button=$('refresh'); button.disabled=true; setReadStatus('Membaca Data Out…');
  try {
    const url='/api/snapshot?base_url='+encodeURIComponent(state.dataUrl); const options={cache:'no-store'}; if(controller) options.signal=controller.signal;
    const response=await fetch(url,options); const data=await response.json();
    if(sequence!==state.refreshSequence) return;
    if(!response.ok) throw new Error(data.error||'snapshot gagal');
    render(data);
  } catch(error) {
    if(sequence!==state.refreshSequence||error?.name==='AbortError') return;
    const message=error?.message||'snapshot gagal'; setPolarUnavailable(`Kurva dihapus setelah refresh gagal: ${message}`); setReadStatus('Read error: '+message,'bad');
  } finally {
    if(sequence===state.refreshSequence){ button.disabled=false; if(state.refreshController===controller) state.refreshController=null; }
  }
  if(sequence===state.refreshSequence) refreshMqtt();
}
function setAuto(seconds) { if(state.autoTimer){ clearInterval(state.autoTimer); state.autoTimer=null; } const interval=Number(seconds||0); $('refresh-interval').value=String(interval); if(interval>0){ refresh(); state.autoTimer=setInterval(refresh,interval*1000); $('auto-refresh').textContent=`Auto: ${interval}s`; } else { $('auto-refresh').textContent='Auto: off'; } }
function openSettings(tab='connection') { $('settings-modal').hidden=false; selectTab(tab); }
function closeSettings() { $('settings-modal').hidden=true; }
function selectTab(name) { document.querySelectorAll('.tab').forEach(button=>button.classList.toggle('active',button.dataset.tab===name)); document.querySelectorAll('.tab-panel').forEach(panel=>panel.hidden=panel.id!==`tab-${name}`); }
async function applyConnection() { const url=$('data-url').value.trim(); const mqttHost=$('mqtt-host').value.trim(); const mqttPort=Number($('mqtt-port').value||1883); const refreshSeconds=Number($('refresh-interval').value||0); if(!url){ setStatus('connection-status','URL kosong.','bad'); return; } try { const r=await fetch('/api/console-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base_url:url,mqtt_host:mqttHost,mqtt_port:mqttPort,refresh_seconds:refreshSeconds})}); const data=await r.json(); if(!r.ok) throw new Error(data.error||'konfigurasi ditolak'); state.dataUrl=data.base_url; $('source-url').textContent=data.base_url; setAuto(data.refresh_seconds); setStatus('connection-status','Konfigurasi tersimpan di Ground Console lokal.','good'); await refresh(); } catch(e) { setStatus('connection-status',e.message,'bad'); } }
async function connectMqtt() { const host=$('mqtt-host').value.trim(); const port=Number($('mqtt-port').value||1883); if(!host){ setStatus('connection-status','Isi host MQTT loopback terlebih dahulu.','bad'); return; } try { const r=await fetch(`/api/mqtt/connect?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}`,{method:'POST'}); const data=await r.json(); if(!r.ok) throw new Error(data.error||'monitor MQTT gagal'); renderMqtt(data); setStatus('connection-status','Monitor MQTT tersambung sebagai subscriber-only.','good'); setTimeout(refreshMqtt,700); } catch(e) { setStatus('connection-status',e.message,'bad'); } }
async function adminLogin() { const password=$('admin-password').value; try { const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})}); const data=await r.json(); if(!r.ok) throw new Error(data.error||'login gagal'); $('admin-login-box').hidden=true; $('admin-workspace').hidden=false; $('admin-password').value=''; setStatus('brand-status','Admin aktif.','good'); renderBranding(state.branding); } catch(e) { setStatus('admin-login-status',e.message,'bad'); } }
async function adminLogout() { await fetch('/api/admin/logout',{method:'POST'}); $('admin-login-box').hidden=false; $('admin-workspace').hidden=true; setStatus('admin-login-status','Sesi admin ditutup.',''); }
function readLogo(file) { if(!file) return; if(file.size>256*1024){ setStatus('brand-status','Logo melebihi 256 KiB.','bad'); $('brand-logo').value=''; return; } const reader=new FileReader(); reader.onload=()=>{ state.pendingLogo=String(reader.result||''); $('brand-preview').src=state.pendingLogo; $('brand-preview').hidden=false; $('preview-placeholder').hidden=true; }; reader.onerror=()=>setStatus('brand-status','Logo tidak dapat dibaca.','bad'); reader.readAsDataURL(file); }
function resetLogo() { state.pendingLogo=''; $('brand-logo').value=''; $('brand-preview').hidden=true; $('preview-placeholder').hidden=false; setStatus('brand-status','Logo akan dihapus setelah disimpan.',''); }
async function saveBranding() { const appName=$('brand-name').value.trim(); const logo=state.pendingLogo===null?(state.branding?.logo_data_url||''):state.pendingLogo; try { const r=await fetch('/api/admin/branding',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_name:appName,logo_data_url:logo})}); const data=await r.json(); if(!r.ok) throw new Error(data.error||'branding gagal disimpan'); state.pendingLogo=null; renderBranding(data); setStatus('brand-status','Branding tersimpan di Ground Console lokal.','good'); } catch(e) { setStatus('brand-status',e.message,'bad'); } }
$('refresh').addEventListener('click',refresh); $('auto-refresh').addEventListener('click',()=>setAuto(state.autoTimer?0:5)); $('settings-open').addEventListener('click',()=>openSettings('connection')); $('settings-close').addEventListener('click',closeSettings); document.querySelector('[data-close-settings]').addEventListener('click',closeSettings); document.querySelectorAll('.tab').forEach(button=>button.addEventListener('click',()=>selectTab(button.dataset.tab))); $('apply-connection').addEventListener('click',applyConnection); $('monitor-connect').addEventListener('click',connectMqtt); $('admin-login').addEventListener('click',adminLogin); $('admin-logout').addEventListener('click',adminLogout); $('brand-logo').addEventListener('change',event=>readLogo(event.target.files[0])); $('brand-reset-logo').addEventListener('click',resetLogo); $('brand-save').addEventListener('click',saveBranding); $('refresh-interval').addEventListener('change',event=>setAuto(event.target.value)); document.addEventListener('keydown',event=>{if(event.key==='Escape')closeSettings();});
window.addEventListener('resize',()=>drawPolar(state.polar.values,state.polar.angle,state.polar.fresh,state.polar.figType,state.polar.compassOffset),{passive:true});
loadBranding();
if (initialConfig && initialConfig.refresh_seconds > 0) setAuto(initialConfig.refresh_seconds); else refresh();
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

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
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
            self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'")
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
                port = int(query.get("port", ["1883"])[0])
            except ValueError:
                self._send_json({"error": "MQTT port must be numeric", "read_only": True}, HTTPStatus.BAD_REQUEST)
                return
            if not host or not (1 <= port <= 65535) or not _is_allowed_mqtt_host(host):
                self._send_json({"error": "MQTT monitor allows localhost/loopback only", "read_only": True}, HTTPStatus.BAD_REQUEST)
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
    ):
        if not _is_loopback_bind(address[0]):
            raise ValueError("Ground Console must bind to loopback; admin branding is local-only")
        if not _is_allowed_base_url(base_url):
            raise ValueError("base_url is outside the local SDR-DoA allowlist")
        self.config_path = Path(config_path).expanduser() if config_path else DEFAULT_CONFIG_PATH
        fallback = _default_console_config(base_url.rstrip("/"), "", 1883, 0)
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
            old_host = str(self._config.get("mqtt_host", ""))
            old_port = int(self._config.get("mqtt_port", 1883))
            new_host = str(normalized["mqtt_host"])
            new_port = int(normalized["mqtt_port"])
            monitor_changed = (
                (old_host, old_port) != (new_host, new_port)
                or bool(new_host) != (self.mqtt_monitor is not None)
            )
            replacement = None
            if monitor_changed and new_host:
                monitor_class = _load_mqtt_monitor_class()
                replacement = monitor_class(new_host, new_port)
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
    parser.add_argument("--bind", default=DEFAULT_BIND, help="local bind address")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="local console port")
    parser.add_argument("--mqtt-host", default="", help="optional local MQTT monitor host; subscriber-only")
    parser.add_argument("--mqtt-port", type=int, default=1883, help="optional local MQTT monitor port")
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
        raise SystemExit("--mqtt-host must be localhost or a loopback address")
    if not (1 <= args.mqtt_port <= 65535):
        raise SystemExit("--mqtt-port must be between 1 and 65535")
    if not _is_allowed_base_url(args.base_url):
        raise SystemExit("--base-url is outside the local SDR-DoA allowlist")
    config_path = Path(args.config_path).expanduser()
    fallback_config = _default_console_config(args.base_url, args.mqtt_host, args.mqtt_port, 0)
    config = _load_console_config(config_path, fallback_config)
    monitor = _new_mqtt_monitor(config["mqtt_host"], config["mqtt_port"]) if config["mqtt_host"] else None
    if monitor is not None:
        monitor.start()
    server = GroundConsoleServer(
        (args.bind, args.port),
        config["base_url"],
        monitor,
        args.branding_path,
        str(config_path),
        config,
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
