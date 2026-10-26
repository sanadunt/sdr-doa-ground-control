#!/usr/bin/env python3
"""Read-only SDR-DoA Data Out collector.

This module deliberately has no MQTT client and no write path to the node. It
fetches known read-only resources, parses them according to their bytes, and
returns a bounded, redacted assessment. The default authority is ``none`` so
DoA publication remains blocked until an independent source-authority decision
is made.
"""

from __future__ import annotations

import argparse
import csv
import dataclasses
import errno
import functools
import http.client
import io
import ipaddress
import json
import math
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

SCHEMA_VERSION = 1
DEFAULT_TIMEOUT_SECONDS = 5.0
DEFAULT_MAX_BODY_BYTES = 128 * 1024
DEFAULT_STATUS_MAX_AGE_MS = 10_000
DEFAULT_DOA_MAX_AGE_MS = 5_000
DEFAULT_MAX_FUTURE_SKEW_MS = 5_000
MAX_TOTAL_BUDGET_SECONDS = 300.0
# A worker that finishes right at the deadline still gets its result recorded.
DEADLINE_GRACE_SECONDS = 0.1
ANGLE_CONSISTENCY_TOLERANCE_DEG = 1.0
ANGULAR_PEAK_ANGLE_TOLERANCE_DEG = 3.0
# CSV and XML are separate files updated by the node. A bounded read sequence
# can observe adjacent records with different node timestamps; exact equality
# would incorrectly quarantine a healthy live pair.
NATIVE_TIMESTAMP_TOLERANCE_MS = 2_000
# Adjacent-frame pairs are re-read at most this many times to obtain a
# same-frame pair; the angle consistency test only applies to same-frame pairs.
NATIVE_PAIR_REREADS = 2
# ROOT-MUSIC plus array_offset can leave the upstream angle outside [0, 360).
NATIVE_ANGLE_MIN_DEG = -360.0
NATIVE_ANGLE_MAX_DEG = 720.0
CSV_HEADER_FIELDS = 17
CSV_VECTOR_BINS = 360
CSV_FIELDS = CSV_HEADER_FIELDS + CSV_VECTOR_BINS
CSV_STATION_INDEX = 7
MAX_CSV_STATION_EXTRA_FIELDS = 16
# Output VFO = ALL writes one row per VFO that passes squelch.
MAX_CSV_ROWS = 16
CSV_XML_FREQUENCY_MATCH_HZ = 1_000
# Upstream XML writes max(0, native_power_db + 100); CSV floors native power
# at -100 dB.
XML_POWER_CLIP_FLOOR = 0.0
CSV_POWER_FLOOR_DB = -100.0
NODE_PROGRESS_COUNTERS = ("timestamp_ms", "uptime_ms", "data_frame_index")
TRANSPORT_ERROR_KINDS = frozenset({"timeout", "connection_refused", "unreachable"})
# Data Out answers on this port only; the hosts are a saved console setting
# (console.json data_out_hosts), these four are its default.
DATA_OUT_PORT = 8081
DEFAULT_DATA_OUT_HOSTS: Tuple[str, ...] = ("doasdr.local", "192.168.100.100", "127.0.0.1", "localhost")
DEFAULT_ALLOWED_DATA_HOSTS = frozenset(DEFAULT_DATA_OUT_HOSTS)
MAX_DATA_OUT_HOSTS = 16
# Error codes of the Data Out address rules; the console sends them with
# the hosts and the port, and the Configuration page translates them.
DATA_OUT_HOST_INVALID = "DATA_OUT_HOST_INVALID"
DATA_OUT_HOSTS_EMPTY = "DATA_OUT_HOSTS_EMPTY"
DATA_OUT_HOSTS_TOO_MANY = "DATA_OUT_HOSTS_TOO_MANY"
DATA_OUT_HOST_IN_USE = "DATA_OUT_HOST_IN_USE"
DATA_OUT_URL_NOT_ALLOWED = "DATA_OUT_URL_NOT_ALLOWED"
_DNS_LABEL_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
_ASCII_SPACE = " \t\n\r\x0b\x0c"
_IPV6_CHARS_RE = re.compile(r"[0-9A-Fa-f:]+")
# http://NETLOC with no path or "/"; NETLOC is checked further on its own.
_DATA_OUT_URL_RE = re.compile(r"[Hh][Tt][Tt][Pp]://([^/]*)/?")
_IPV4_RE = re.compile(r"(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}")

PATH_STATUS = "/status.json"
PATH_SETTINGS = "/settings.json"
PATH_CSV = "/DOA_value.html"
PATH_XML = "/doa.xml"

STATUS_FIELDS = (
    "timestamp_ms",
    "station_id",
    "hardware_id",
    "unit_id",
    "host_os_type",
    "host_os_version",
    "host_os_architecture",
    "software_version",
    "software_git_short_hash",
    "uptime_ms",
    "gps_status",
    "daq_status",
    "daq_ok",
    "daq_num_dropped_frames",
)

DAQ_STATUS_FIELDS = (
    "data_frame_index",
    "frame_sync",
    "sample_delay_sync",
    "iq_sync",
    "noise_source_enabled",
    "adc_overdrive",
    "sampling_frequency_hz",
    "bandwidth_hz",
    "decimated_bandwidth_hz",
    "buffer_size_ms",
)

SAFE_SETTINGS_FIELDS = (
    "center_freq",
    "uniform_gain",
    "data_interface",
    "en_doa",
    "doa_method",
    "doa_decorrelation_method",
    "ant_arrangement",
    "ant_spacing_meters",
    "active_vfos",
    "output_vfo",
    "vfo_mode",
    "doa_fig_type",
    "compass_offset",
    "location_source",
    "gps_fixed_heading",
    "en_remote_control",
    "en_peak_hold",
    "vfo_freq_0",
    "vfo_bw_0",
    "vfo_squelch_0",
)
# VFO 0 as the edge agent writes it for a config patch (Hz, Hz, dB). Kontrol
# compares them with what it sent, so only finite numbers pass.
NUMERIC_SETTINGS_FIELDS = frozenset({"vfo_freq_0", "vfo_bw_0", "vfo_squelch_0"})
EFFECTIVE_SETTINGS_FIELDS = (
    "center_freq",
    "uniform_gain",
    "ant_arrangement",
    "doa_method",
    "active_vfos",
    "output_vfo",
)


def settings_are_effective(settings: Mapping[str, Any]) -> bool:
    """Return true only when the fields needed for state/config are present."""
    return bool(
        settings.get("available") is True
        and isinstance(settings.get("fields"), Mapping)
        and all(field in settings["fields"] for field in EFFECTIVE_SETTINGS_FIELDS)
    )




class CollectorError(ValueError):
    """Raised when a resource body violates the expected bounded schema."""


class DataOutHostError(ValueError):
    """A Data Out host list or URL that breaks the address rules.

    ``code`` is one of the DATA_OUT_* codes. ``hosts`` is the list a URL was
    checked against, so the message and the console's answer can name it
    together with the port.
    """

    def __init__(self, code: str, message: str, *, host: Optional[str] = None, hosts: Sequence[str] = ()) -> None:
        super().__init__(message)
        self.code = code
        self.host = host
        self.hosts = tuple(hosts)


def normalize_data_out_host(value: Any) -> str:
    """Return one Data Out host in its saved form, or raise DataOutHostError.

    A host is a DNS name (RFC 1123 labels of letters, digits and inner
    hyphens, lowercased, one trailing dot removed) or an IPv4 or IPv6 address
    (IPv6 may be in brackets; saved in its compressed form). A name whose
    last label is all digits must be a dotted-quad IPv4 address without
    leading zeros. Wildcards, schemes, ports, paths, userinfo, IPv6 zone ids,
    IPv4-in-IPv6 notation, IPv4-mapped addresses (``::ffff:0:0/96``; the
    IPv4 address is the host to list) and the unspecified address are
    refused.
    frontend/src/lib/dataOutHosts.ts applies the same rules; the cases in
    tools/fixtures/data_out_hosts.json pin both.
    """
    if not isinstance(value, str):
        raise DataOutHostError(DATA_OUT_HOST_INVALID, "a Data Out host must be text")
    text = value.strip(_ASCII_SPACE)
    shown = text[:80]

    def invalid() -> DataOutHostError:
        return DataOutHostError(DATA_OUT_HOST_INVALID, f"{shown!r} is not a host name or IP address", host=shown)

    if not text or len(text) > 255 or not text.isascii():
        raise invalid()
    bracketed = text.startswith("[") and text.endswith("]")
    candidate = text[1:-1] if bracketed else text
    if ":" in candidate:
        if _IPV6_CHARS_RE.fullmatch(candidate) is None:
            raise invalid()
        try:
            address = ipaddress.IPv6Address(candidate)
        except ValueError:
            raise invalid() from None
        # Some Python releases write a mapped address's compressed form as a
        # dotted quad, which neither this function nor dataOutHosts.ts reads
        # back, so a saved list would break the next load.
        if address.is_unspecified or address.ipv4_mapped is not None:
            raise invalid()
        return address.compressed
    if bracketed:
        raise invalid()
    name = candidate.lower()
    if name.endswith("."):
        name = name[:-1]
    labels = name.split(".")
    if labels[-1].isdigit():
        if _IPV4_RE.fullmatch(name) is None or name == "0.0.0.0":
            raise invalid()
        return name
    if len(name) > 253 or not all(_DNS_LABEL_RE.fullmatch(label) for label in labels):
        raise invalid()
    return name


def data_out_host_key(value: Any) -> Optional[str]:
    """The saved form of a host for comparison, or None when it is not a valid host."""
    try:
        return normalize_data_out_host(value)
    except DataOutHostError:
        return None


def normalize_data_out_hosts(values: Any) -> List[str]:
    """Validate a Data Out host list: 1..MAX_DATA_OUT_HOSTS hosts, duplicates removed, order kept."""
    if not isinstance(values, (list, tuple)):
        raise DataOutHostError(DATA_OUT_HOST_INVALID, "data_out_hosts must be a list of host names or IP addresses")
    if len(values) > 4 * MAX_DATA_OUT_HOSTS:
        raise DataOutHostError(DATA_OUT_HOSTS_TOO_MANY, f"data_out_hosts allows at most {MAX_DATA_OUT_HOSTS} hosts")
    hosts: List[str] = []
    for value in values:
        host = normalize_data_out_host(value)
        if host not in hosts:
            hosts.append(host)
    if not hosts:
        raise DataOutHostError(DATA_OUT_HOSTS_EMPTY, "data_out_hosts needs at least one host")
    if len(hosts) > MAX_DATA_OUT_HOSTS:
        raise DataOutHostError(DATA_OUT_HOSTS_TOO_MANY, f"data_out_hosts allows at most {MAX_DATA_OUT_HOSTS} hosts")
    return hosts


def data_out_url_host(base_url: Any) -> Optional[str]:
    """The host of ``http://HOST[:8081][/]`` in its saved form, or None for any other URL.

    The URL is printable ASCII without spaces, userinfo, query, fragment or a
    path other than "/"; the port, when given, is exactly 8081. An IPv6 host
    is in brackets.
    """
    if not isinstance(base_url, str) or not base_url or not base_url.isascii():
        return None
    if any(ord(char) <= 32 or ord(char) == 127 for char in base_url) or "?" in base_url or "#" in base_url:
        return None
    match = _DATA_OUT_URL_RE.fullmatch(base_url)
    if match is None:
        return None
    netloc = match.group(1)
    if "@" in netloc:
        return None
    if netloc.startswith("["):
        host, closed, rest = netloc[1:].partition("]")
        if not closed or ":" not in host or (rest and not rest.startswith(":")):
            return None
        port: Optional[str] = rest[1:] if rest else None
    else:
        host, colon, port_text = netloc.partition(":")
        port = port_text if colon else None
    if port is not None and port != str(DATA_OUT_PORT):
        return None
    return data_out_host_key(host)


def data_out_url_message(hosts: Iterable[str]) -> str:
    """The rule a Data Out URL breaks, naming the allowed hosts and the port."""
    return (
        f"the Data Out URL must be http://HOST:{DATA_OUT_PORT} with HOST in the Data Out host list "
        f"({', '.join(hosts)})"
    )


def check_data_out_url(base_url: Any, hosts: Iterable[str]) -> str:
    """Return ``base_url`` without a trailing slash, or raise DataOutHostError.

    The URL must be plain http on port 8081 (or no port), without userinfo,
    path, query or fragment, and its host must be in ``hosts``.
    """
    allowed = [key for key in (data_out_host_key(host) for host in hosts) if key is not None]
    host = data_out_url_host(base_url)
    if host is None or host not in allowed:
        raise DataOutHostError(DATA_OUT_URL_NOT_ALLOWED, data_out_url_message(allowed), host=host, hosts=allowed)
    return str(base_url).rstrip("/")


@dataclass(frozen=True)
class FetchedResource:
    path: str
    url: str
    ok: bool
    http_status: Optional[int]
    content_type: Optional[str]
    body: bytes
    retrieved_at_ms: int
    error: Optional[str] = None
    error_kind: Optional[str] = None
    elapsed_ms: Optional[int] = None
    attempts: int = 1
    # How the host became an address: "literal" (an IP address), "system"
    # (the system resolver, address of the connected peer) or "mdns".
    resolved_via: Optional[str] = None
    resolved_address: Optional[str] = None

    def metadata(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "path": self.path,
            "url": _redact_url(self.url),
            "ok": self.ok,
            "retrieved_at_ms": self.retrieved_at_ms,
            "attempts": self.attempts,
        }
        if self.http_status is not None:
            result["http_status"] = self.http_status
        if self.content_type:
            result["content_type"] = self.content_type
        if self.ok:
            result["body_bytes"] = len(self.body)
        if self.error:
            result["error"] = self.error
        if self.error_kind:
            result["error_kind"] = self.error_kind
        if self.elapsed_ms is not None:
            result["elapsed_ms"] = self.elapsed_ms
        return result


def now_ms() -> int:
    return int(time.time() * 1000)


def _elapsed_ms(started_monotonic: float) -> int:
    return max(0, int(round((time.monotonic() - started_monotonic) * 1000)))


def _not_fetched(base_url: Any, path: str, error: str, error_kind: str) -> FetchedResource:
    return FetchedResource(
        path=path,
        url=str(base_url).rstrip("/") + path,
        ok=False,
        http_status=None,
        content_type=None,
        body=b"",
        retrieved_at_ms=now_ms(),
        error=error,
        error_kind=error_kind,
        elapsed_ms=0,
        attempts=0,
    )


def _transport_error(exc: BaseException) -> Tuple[str, str]:
    """Map a transport exception to a bounded message and error kind."""
    reason: Any = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    if isinstance(reason, (socket.timeout, TimeoutError)):
        return "timed out", "timeout"
    if isinstance(reason, ConnectionRefusedError):
        return "connection refused", "connection_refused"
    if isinstance(reason, socket.gaierror):
        return "host name resolution failed", "unreachable"
    if isinstance(reason, OSError) and reason.errno in {
        errno.EHOSTUNREACH,
        errno.ENETUNREACH,
        errno.EHOSTDOWN,
        errno.ENETDOWN,
        errno.EADDRNOTAVAIL,
    }:
        return "host unreachable", "unreachable"
    if isinstance(reason, BaseException):
        return f"network error ({type(reason).__name__})", "network"
    return "network error", "network"


def _finite_float(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise CollectorError(f"{field} must be numeric, not boolean")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise CollectorError(f"{field} is not numeric") from exc
    if not math.isfinite(parsed):
        raise CollectorError(f"{field} is not finite")
    return parsed


def _finite_int(value: Any, field: str) -> int:
    parsed = _finite_float(value, field)
    if not parsed.is_integer():
        raise CollectorError(f"{field} must be an integer")
    return int(parsed)


def _required_text(value: Any, field: str) -> str:
    if value is None:
        raise CollectorError(f"{field} is missing")
    text = str(value).strip()
    if not text:
        raise CollectorError(f"{field} is empty")
    return text


def _optional_scalar(value: Any) -> Any:
    """Keep only bounded JSON scalar values for the safe settings subset."""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return value
    return None


def _age_assessment(
    timestamp_ms: int,
    reference_ms: int,
    max_age_ms: int,
    max_future_skew_ms: int,
    reference_kind: str,
    freshness_known: bool = True,
) -> Dict[str, Any]:
    age_ms = reference_ms - timestamp_ms
    return {
        "timestamp_ms": timestamp_ms,
        "reference_ms": reference_ms,
        "reference_kind": reference_kind,
        "freshness_known": freshness_known,
        "age_ms": max(0, age_ms) if freshness_known else None,
        "raw_age_ms": age_ms if freshness_known else None,
        # A later file read can legitimately observe a newer node record than
        # the status sample read first. Treat a bounded future delta as fresh;
        # only an excessive future timestamp is rejected. Expose effective age
        # as non-negative while retaining raw_age_ms for diagnostics.
        "fresh": (-max_future_skew_ms <= age_ms <= max_age_ms) if freshness_known else None,
        "future_skew": (age_ms < -max_future_skew_ms) if freshness_known else None,
        "max_age_ms": max_age_ms,
    }


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        raise CollectorError("HTTP redirect is not allowed")


def _redact_url(url: Any) -> str:
    """Return URL metadata without userinfo, query, or fragment."""
    try:
        parsed = urllib.parse.urlsplit(str(url))
        if not parsed.scheme or not parsed.hostname:
            return "<invalid-url>"
        host = parsed.hostname
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        port = f":{parsed.port}" if parsed.port is not None else ""
        return f"{parsed.scheme}://{host}{port}"
    except (TypeError, ValueError):
        return "<invalid-url>"


def _validate_base_url(base_url: str, allowed_hosts: Iterable[str]) -> str:
    if not isinstance(base_url, str) or not base_url:
        raise ValueError("base_url must be a non-empty string")
    return check_data_out_url(base_url, allowed_hosts)


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """An HTTP connection to a fixed address; the URL and the Host header keep the name."""

    def __init__(self, host: str, *args: Any, pinned_address: str, **kwargs: Any) -> None:
        super().__init__(host, *args, **kwargs)

        def connect_pinned(address: Tuple[str, int], timeout: Any, source_address: Any) -> socket.socket:
            return socket.create_connection((pinned_address, address[1]), timeout, source_address)

        self._create_connection = connect_pinned


class _PinnedHTTPHandler(urllib.request.HTTPHandler):
    """Replaces the opener's HTTP handler so the connect goes to an mDNS address."""

    def __init__(self, address: str) -> None:
        super().__init__()
        self._address = address

    def http_open(self, req: Any) -> Any:
        return self.do_open(functools.partial(_PinnedHTTPConnection, pinned_address=self._address), req)


class _HostNotResolved(Exception):
    """The system resolver could not resolve a host that mDNS may answer."""


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def _goes_direct(request: urllib.request.Request) -> bool:
    """True when the opener's environment proxy does not take this request.

    Through a proxy, the proxy resolves the name; mDNS is only for direct
    connections, so the proxy behaviour stays exactly as it was.
    """
    if not urllib.request.getproxies().get(request.type):
        return True
    return bool(urllib.request.proxy_bypass(request.host))


def _name_resolution_failed(exc: BaseException) -> bool:
    reason: Any = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    return isinstance(reason, socket.gaierror)


def _peer_address(response: Any) -> Optional[str]:
    """Address of the connected peer of a response (or of an HTTPError's response)."""
    for candidate in (response, getattr(response, "fp", None)):
        sock = getattr(getattr(getattr(candidate, "fp", None), "raw", None), "_sock", None)
        if sock is None:
            continue
        try:
            return str(sock.getpeername()[0])
        except (OSError, IndexError, TypeError):
            return None
    return None


def fetch_resource(
    base_url: str,
    path: str,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
    allowed_hosts: Optional[Iterable[str]] = None,
    mdns_resolver: Any = None,
) -> FetchedResource:
    """Fetch one known resource with a bounded read-only GET.

    ``timeout_seconds`` bounds every socket operation, and the body read as a
    whole, so a server that trickles body bytes cannot hold the read open.
    The status line and headers are bounded per socket operation only.

    ``allowed_hosts`` is the Data Out host list (default: the four default
    hosts); the port is always 8081. ``mdns_resolver`` (an
    ``mdns_resolver.MdnsResolver``, which the console passes) answers a
    ``.local`` host that the system resolver cannot, for a request that goes
    to Data Out directly rather than through a proxy. It is asked only after
    the system resolver failed for the host; while it caches an address for
    the host, the request connects there at once. Either way the URL and the
    Host header keep the name, and every other rule stays: no redirects, the
    size and time bounds, the path allowlist.
    """
    allowed = DEFAULT_DATA_OUT_HOSTS if allowed_hosts is None else allowed_hosts
    try:
        safe_base = _validate_base_url(base_url, allowed)
    except ValueError as exc:
        return FetchedResource(
            path, str(base_url), False, None, None, b"", now_ms(), str(exc), error_kind="invalid_target", elapsed_ms=0
        )
    if path not in {PATH_STATUS, PATH_SETTINGS, PATH_CSV, PATH_XML}:
        raise ValueError("resource path is not allowlisted")
    url = safe_base + path
    retrieved_at_ms = now_ms()
    started = time.monotonic()
    budget = max(0.001, float(timeout_seconds))
    request_deadline = started + budget
    request = urllib.request.Request(
        url,
        method="GET",
        headers={"Accept": "application/json, application/xml, text/plain, */*"},
    )
    host = (urllib.parse.urlsplit(safe_base).hostname or "").lower().rstrip(".")
    literal = _is_ip_literal(host)
    mdns = mdns_resolver if (
        mdns_resolver is not None and not literal and host.endswith(".local") and _goes_direct(request)
    ) else None

    def failure(
        error: str,
        kind: str,
        http_status: Optional[int] = None,
        via: Optional[str] = None,
        address: Optional[str] = None,
    ) -> FetchedResource:
        return FetchedResource(
            path=path,
            url=url,
            ok=False,
            http_status=http_status,
            content_type=None,
            body=b"",
            retrieved_at_ms=retrieved_at_ms,
            error=error,
            error_kind=kind,
            elapsed_ms=_elapsed_ms(started),
            resolved_via=via,
            resolved_address=address,
        )

    def attempt(pinned: Optional[str]) -> FetchedResource:
        if pinned is not None:
            opener = urllib.request.build_opener(_NoRedirectHandler, _PinnedHTTPHandler(pinned))
            via: Optional[str] = "mdns"
            known: Optional[str] = pinned
        else:
            opener = urllib.request.build_opener(_NoRedirectHandler)
            via = "literal" if literal else None
            known = host if literal else None
        remaining = request_deadline - time.monotonic()
        if remaining <= 0:
            return failure("timed out", "timeout", via=via, address=known)
        try:
            return read(opener, remaining, via, known)
        except urllib.error.HTTPError as exc:
            # HTTPError is a URLError subclass; keep the status code instead of
            # reporting a 404 like a refused connection.
            if via is None:
                via, known = "system", _peer_address(exc)
            try:
                code: Optional[int] = int(exc.code)
            except (TypeError, ValueError):
                code = None
            try:
                exc.close()
            except Exception:
                pass
            return failure(f"HTTP {code}" if code is not None else "HTTP error", "http_status", code, via, known)
        except CollectorError as exc:
            message = str(exc)
            return failure(message, "redirect" if "redirect" in message else "body_too_large", via=via, address=known)
        except http.client.HTTPException as exc:
            # BadStatusLine, LineTooLong and IncompleteRead are not OSError.
            return failure(f"invalid HTTP response ({type(exc).__name__})", "protocol", via=via, address=known)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if pinned is None and mdns is not None and _name_resolution_failed(exc):
                raise _HostNotResolved() from None
            message, kind = _transport_error(exc)
            return failure(message, kind, via=via, address=known)

    def read(opener: Any, timeout: float, via: Optional[str], known: Optional[str]) -> FetchedResource:
        with opener.open(request, timeout=timeout) as response:
            if via is None:
                via, known = "system", _peer_address(response)
            status = getattr(response, "status", None) or response.getcode()
            content_type = response.headers.get("Content-Type")
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    if int(content_length) > max_body_bytes:
                        raise CollectorError(f"body exceeds {max_body_bytes} bytes")
                except ValueError:
                    pass
            chunks: List[bytes] = []
            total = 0
            # read() keeps calling recv() until it has n bytes, so a server
            # sending one byte at a time never reaches the deadline check.
            # read1() returns after one recv().
            read_some = getattr(response, "read1", None) or response.read
            while True:
                remaining = request_deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("request time budget exhausted")
                _limit_socket_timeout(response, remaining)
                chunk = read_some(min(16 * 1024, max_body_bytes - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > max_body_bytes:
                    raise CollectorError(f"body exceeds {max_body_bytes} bytes")
                chunks.append(chunk)
            return FetchedResource(
                path=path,
                url=url,
                ok=200 <= int(status) < 300,
                http_status=int(status),
                content_type=content_type,
                body=b"".join(chunks),
                retrieved_at_ms=retrieved_at_ms,
                elapsed_ms=_elapsed_ms(started),
                resolved_via=via,
                resolved_address=known,
            )

    if mdns is not None:
        cached = mdns.cached(host)
        if cached is not None:
            return attempt(cached)
    try:
        return attempt(None)
    except _HostNotResolved:
        pass
    remaining = request_deadline - time.monotonic()
    address = mdns.resolve(host, remaining) if mdns is not None and remaining > 0 else None
    if address is None:
        return failure(f"{host} could not be resolved (system and mDNS); use an IP address", "unreachable")
    return attempt(address)


def _limit_socket_timeout(response: Any, remaining_seconds: float) -> None:
    """Shrink the per-read socket timeout to the request's remaining budget."""
    sock = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
    if sock is None:
        return
    try:
        sock.settimeout(max(0.001, remaining_seconds))
    except OSError:
        pass


def _parse_json_body(resource: FetchedResource) -> Mapping[str, Any]:
    if not resource.ok:
        raise CollectorError(resource.error or "resource unavailable")
    try:
        value = json.loads(resource.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CollectorError(f"invalid JSON at {resource.path}") from exc
    if not isinstance(value, dict):
        raise CollectorError(f"expected JSON object at {resource.path}")
    return value


def fetch_and_parse_with_retry(
    base_url: str,
    path: str,
    parser: Any,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
    attempts: int = 3,
    retry_delay_seconds: float = 0.05,
    fetcher: Any = fetch_resource,
    deadline: Optional[float] = None,
) -> Tuple[FetchedResource, Optional[Dict[str, Any]]]:
    """Read and parse a known resource with bounded partial-file retries.

    Only a body that arrived but did not parse (a file caught mid-rewrite) is
    retried. Transport and HTTP failures return at once: retrying them only
    multiplies the wait when Data Out is down or slow. ``deadline`` is a
    ``time.monotonic()`` value that caps every attempt's timeout.
    """
    if attempts < 1 or attempts > 5:
        raise ValueError("attempts must be between 1 and 5")
    last_resource: Optional[FetchedResource] = None
    last_error: Optional[Exception] = None
    for attempt in range(attempts):
        timeout = timeout_seconds
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if last_resource is None:
                    last_resource = _not_fetched(base_url, path, "collection deadline exceeded", "deadline")
                    last_error = CollectorError("collection deadline exceeded")
                break
            timeout = min(float(timeout_seconds), remaining)
        resource = fetcher(base_url, path, timeout, max_body_bytes)
        if isinstance(resource, FetchedResource):
            resource = dataclasses.replace(resource, attempts=attempt + 1)
        last_resource = resource
        if not resource.ok:
            last_error = CollectorError(resource.error or "resource unavailable")
            break
        try:
            return resource, parser(resource)
        except (CollectorError, ValueError, TypeError, json.JSONDecodeError) as exc:
            last_error = exc
        if attempt + 1 < attempts:
            delay = max(0.0, retry_delay_seconds)
            if deadline is not None and time.monotonic() + delay >= deadline:
                break
            time.sleep(delay)
    if last_resource is None:
        raise CollectorError("resource fetch produced no result")
    if last_error is not None:
        return last_resource, {"available": False, "error": str(last_error)}
    return last_resource, {"available": False, "error": "resource parse failed"}


def parse_status(resource: FetchedResource) -> Dict[str, Any]:
    source = _parse_json_body(resource)
    timestamp_ms = _finite_int(source.get("timestamp_ms"), "status.timestamp_ms")
    if not isinstance(source.get("daq_ok"), bool):
        raise CollectorError("status.daq_ok must be boolean")
    dropped = _finite_int(source.get("daq_num_dropped_frames"), "status.daq_num_dropped_frames")
    if dropped < 0:
        raise CollectorError("status.daq_num_dropped_frames must be non-negative")

    daq_source = source.get("daq_status")
    if daq_source is None:
        daq_source = {}
    if not isinstance(daq_source, dict):
        raise CollectorError("status.daq_status must be an object")

    daq_status: Dict[str, Any] = {}
    for field in DAQ_STATUS_FIELDS:
        if field not in daq_source:
            continue
        value = daq_source[field]
        if field in {"frame_sync", "sample_delay_sync", "iq_sync", "noise_source_enabled", "adc_overdrive"}:
            if not isinstance(value, bool):
                raise CollectorError(f"status.daq_status.{field} must be boolean")
            daq_status[field] = value
        elif field == "buffer_size_ms":
            daq_status[field] = _finite_float(value, f"status.daq_status.{field}")
        else:
            daq_status[field] = _finite_int(value, f"status.daq_status.{field}")

    sync_fields = ("frame_sync", "sample_delay_sync", "iq_sync")
    failed_flags = [field for field in sync_fields if daq_status.get(field) is False]
    missing_flags = [field for field in sync_fields if field not in daq_status]
    if source["daq_ok"] is False or failed_flags:
        daq_health = "FAIL"
    elif missing_flags:
        daq_health = "UNKNOWN"
    else:
        daq_health = "PASS"

    safe: Dict[str, Any] = {}
    for field in STATUS_FIELDS:
        if field == "daq_status":
            safe[field] = daq_status
        elif field in source:
            value = source[field]
            if field in {"timestamp_ms", "unit_id", "uptime_ms", "daq_num_dropped_frames"}:
                safe[field] = _finite_int(value, f"status.{field}")
            elif field in {"station_id", "hardware_id", "host_os_type", "host_os_version", "host_os_architecture", "software_version", "software_git_short_hash", "gps_status"}:
                safe[field] = None if value is None else str(value)
            elif field == "daq_ok":
                safe[field] = bool(value)

    return {
        "available": True,
        "safe": safe,
        "daq_health": daq_health,
        "failed_sync_flags": failed_flags,
        "missing_sync_flags": missing_flags,
    }


def parse_settings(resource: FetchedResource) -> Dict[str, Any]:
    source = _parse_json_body(resource)
    safe: Dict[str, Any] = {}
    for field in SAFE_SETTINGS_FIELDS:
        if field in source:
            value = _optional_scalar(source[field])
            if field in NUMERIC_SETTINGS_FIELDS and (isinstance(value, bool) or not isinstance(value, (int, float))):
                continue
            if value is not None:
                safe[field] = value
    return {
        "available": True,
        "redacted": True,
        "fields": safe,
        "raw_fields_omitted": True,
    }


def _normalize_csv_fields(row: List[str]) -> List[str]:
    """Return the 377 upstream fields, re-joining a station ID that held commas.

    The KrakenSDR UI flags a comma in the station ID as invalid but writes it
    unescaped, which shifts every later column. The fields before the station
    ID and the fixed block after it are unambiguous, so the station ID is the
    span between them.
    """
    if len(row) == CSV_FIELDS:
        return row
    extra = len(row) - CSV_FIELDS
    if 0 < extra <= MAX_CSV_STATION_EXTRA_FIELDS:
        station_end = CSV_STATION_INDEX + 1 + extra
        return row[:CSV_STATION_INDEX] + [",".join(row[CSV_STATION_INDEX:station_end])] + row[station_end:]
    raise CollectorError(f"expected {CSV_FIELDS} CSV fields, found {len(row)}")


def _parse_csv_rows(resource: FetchedResource) -> List[List[str]]:
    if not resource.ok:
        raise CollectorError(resource.error or "resource unavailable")
    try:
        text = resource.body.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CollectorError("DoA CSV is not UTF-8") from exc
    if text.lstrip().startswith("<"):
        raise CollectorError(
            "DOA_value.html contains XML, not the CSV view (Kerberos App data format is not supported)"
        )
    rows = [row for row in csv.reader(io.StringIO(text)) if any(field.strip() for field in row)]
    if not rows:
        raise CollectorError("expected at least one CSV row, found 0")
    if len(rows) > MAX_CSV_ROWS:
        raise CollectorError(f"expected at most {MAX_CSV_ROWS} CSV rows, found {len(rows)}")
    return [_normalize_csv_fields(row) for row in rows]


def _parse_csv_row(resource: FetchedResource) -> List[str]:
    rows = _parse_csv_rows(resource)
    if len(rows) != 1:
        raise CollectorError(f"expected one CSV row, found {len(rows)}")
    return rows[0]


def parse_csv_doa(
    resource: FetchedResource,
    reference_ms: int,
    max_age_ms: int = DEFAULT_DOA_MAX_AGE_MS,
    max_future_skew_ms: int = DEFAULT_MAX_FUTURE_SKEW_MS,
    reference_kind: str = "local_observed_at",
    freshness_known: bool = True,
) -> Dict[str, Any]:
    row = _parse_csv_row(resource)
    return _csv_row_candidate(row, 0, resource, reference_ms, max_age_ms, max_future_skew_ms, reference_kind, freshness_known)


def parse_csv_doa_rows(
    resource: FetchedResource,
    reference_ms: int,
    max_age_ms: int = DEFAULT_DOA_MAX_AGE_MS,
    max_future_skew_ms: int = DEFAULT_MAX_FUTURE_SKEW_MS,
    reference_kind: str = "local_observed_at",
    freshness_known: bool = True,
) -> List[Dict[str, Any]]:
    """Parse every CSV row (one per VFO when Output VFO = ALL)."""
    return [
        _csv_row_candidate(row, index, resource, reference_ms, max_age_ms, max_future_skew_ms, reference_kind, freshness_known)
        for index, row in enumerate(_parse_csv_rows(resource))
    ]


def _csv_row_candidate(
    row: List[str],
    row_index: int,
    resource: FetchedResource,
    reference_ms: int,
    max_age_ms: int,
    max_future_skew_ms: int,
    reference_kind: str,
    freshness_known: bool,
) -> Dict[str, Any]:
    timestamp_ms = _finite_int(row[0], "csv.timestamp_ms")
    angular_values = [
        _finite_float(value, f"csv.angular_power[{index}]")
        for index, value in enumerate(row[CSV_HEADER_FIELDS:])
    ]
    # ``DOA_plot_util`` in the node has already converted the estimator to dB
    # and the CSV writer shifts that dB vector by its minimum before writing it.
    # Preserve those values for the local plot. Applying abs()/log10() here
    # would reinterpret dB as linear power and visibly flatten/distort peaks.
    # A signed value is still a valid fixture/input: a peak is the greatest
    # signed dB value (closest to zero), never the greatest magnitude.
    peak_index = max(range(len(angular_values)), key=angular_values.__getitem__)
    angular_peak_value = angular_values[peak_index]
    angular_power_db = list(angular_values)
    return {
        "available": True,
        "source_format": "csv",
        "path": resource.path,
        "timestamp_ms": timestamp_ms,
        "freshness": _age_assessment(
            timestamp_ms,
            reference_ms,
            max_age_ms,
            max_future_skew_ms,
            reference_kind,
            freshness_known,
        ),
        "doa_raw_deg": _finite_float(row[1], "csv.doa_raw_deg"),
        "angle_convention": "csv_360_minus_theta",
        "confidence_raw": _finite_float(row[2], "csv.confidence_raw"),
        "power_raw": _finite_float(row[3], "csv.power_raw"),
        "frequency_hz": _finite_int(row[4], "csv.frequency_hz"),
        "array_type": row[5].strip(),
        "acquisition_frame_latency_ms": _finite_float(row[6], "csv.acquisition_frame_latency_ms"),
        "station_id": row[CSV_STATION_INDEX].strip(),
        "csv_row_index": row_index,
        "latitude": _finite_float(row[8], "csv.latitude"),
        "longitude": _finite_float(row[9], "csv.longitude"),
        "gps_heading": _finite_float(row[10], "csv.gps_heading"),
        "compass_heading": _finite_float(row[11], "csv.compass_heading"),
        "heading_source": row[12].strip(),
        "reserved_fields": row[13:17],
        "angular_bins": len(angular_values),
        "angular_peak_index": peak_index,
        "angular_peak_value": angular_peak_value,
        # Keep peak metadata on the same signed scale as the preserved vector.
        "angular_peak_db": angular_peak_value,
        "angular_power_db": angular_power_db,
        "angular_power_min_db": min(angular_values),
        "angular_power_max_db": max(angular_values),
        "angular_power_unit": "dB_relative_to_source_floor",
        "angular_power_transform": "preserved_source_shifted_db",
        "angular_power_shifted": True,
        "angular_values_local_only": True,
    }


def _xml_text(root: ET.Element, path: str, required: bool = True) -> Optional[str]:
    value = root.findtext(path)
    if required:
        return _required_text(value, f"xml.{path}")
    return None if value is None else value.strip()


def parse_xml_doa(
    resource: FetchedResource,
    reference_ms: int,
    max_age_ms: int = DEFAULT_DOA_MAX_AGE_MS,
    max_future_skew_ms: int = DEFAULT_MAX_FUTURE_SKEW_MS,
    reference_kind: str = "local_observed_at",
    freshness_known: bool = True,
) -> Dict[str, Any]:
    if not resource.ok:
        raise CollectorError(resource.error or "resource unavailable")
    try:
        root = ET.fromstring(resource.body)
    except (UnicodeDecodeError, ET.ParseError) as exc:
        raise CollectorError("invalid DoA XML") from exc
    if root.tag != "DATA":
        raise CollectorError(f"expected XML root DATA, found {root.tag}")

    timestamp_ms = _finite_int(_xml_text(root, "TIME"), "xml.TIME")
    overdrive_text = _required_text(_xml_text(root, "ADC_OVERDRIVE"), "xml.ADC_OVERDRIVE")
    overdrive_active, overdrive_mask = _parse_overdrive_text(overdrive_text)
    station_id = _xml_text(root, "STATION_ID", required=False)
    return {
        "available": True,
        "source_format": "xml",
        "path": resource.path,
        "timestamp_ms": timestamp_ms,
        "freshness": _age_assessment(
            timestamp_ms,
            reference_ms,
            max_age_ms,
            max_future_skew_ms,
            reference_kind,
            freshness_known,
        ),
        "doa_raw_deg": _finite_float(_xml_text(root, "DOA"), "xml.DOA"),
        "angle_convention": "xml_raw_theta",
        "confidence_raw_percent": _finite_float(_xml_text(root, "CONF"), "xml.CONF"),
        "power_transformed_raw": _finite_float(_xml_text(root, "PWR"), "xml.PWR"),
        "frequency_mhz": _finite_float(_xml_text(root, "FREQUENCY"), "xml.FREQUENCY"),
        # The station ID is descriptive only; an empty one must not discard
        # an otherwise valid record.
        "station_id": station_id or None,
        "gps_time": _finite_int(_xml_text(root, "GPS_TIME"), "xml.GPS_TIME"),
        "latitude": _finite_float(_xml_text(root, "LOCATION/LATITUDE"), "xml.LOCATION/LATITUDE"),
        "longitude": _finite_float(_xml_text(root, "LOCATION/LONGITUDE"), "xml.LOCATION/LONGITUDE"),
        "heading": _finite_float(_xml_text(root, "LOCATION/HEADING"), "xml.LOCATION/HEADING"),
        "speed": _finite_float(_xml_text(root, "LOCATION/SPEED"), "xml.LOCATION/SPEED"),
        "acquisition_frame_latency_ms": _finite_float(_xml_text(root, "LATENCY"), "xml.LATENCY"),
        "processing_time_ms": _finite_float(_xml_text(root, "PROCESSING_TIME"), "xml.PROCESSING_TIME"),
        "adc_overdrive": overdrive_text,
        "adc_overdrive_active": overdrive_active,
        "adc_overdrive_channel_mask": overdrive_mask,
        "correlated_sources": _finite_int(_xml_text(root, "NUM_CORRELATED_SOURCES"), "xml.NUM_CORRELATED_SOURCES"),
        "snr_db": _finite_float(_xml_text(root, "SNR_DB"), "xml.SNR_DB"),
        "snr_unit": "dB_native_unverified",
    }


def _parse_overdrive_text(text: str) -> Tuple[Optional[bool], Optional[int]]:
    """Read XML ADC_OVERDRIVE as a boolean or a per-channel integer bitmask."""
    value = text.strip()
    if value.lower() in {"true", "false"}:
        return value.lower() == "true", None
    try:
        mask = int(value, 10)
    except ValueError:
        return None, None
    if mask < 0 or mask > 0xFFFF:
        return None, None
    return mask != 0, mask


def _unavailable(resource: FetchedResource) -> Dict[str, Any]:
    return {
        "available": False,
        "source_format": "csv" if resource.path == PATH_CSV else "xml",
        "path": resource.path,
        "error": resource.error or "resource unavailable",
    }


def _parse_or_error(parser: Any, resource: FetchedResource, *args: Any) -> Dict[str, Any]:
    try:
        return parser(resource, *args)
    except CollectorError as exc:
        format_name = "csv" if resource.path == PATH_CSV else "xml"
        return {
            "available": False,
            "source_format": format_name,
            "path": resource.path,
            "error": str(exc),
        }


def _canonicalize_native_angle(candidate: Mapping[str, Any]) -> float:
    """Convert native output to the upstream theta-0 convention.

    The upstream writer stores ``360 - theta_0`` in the CSV-compatible view and
    stores ``theta_0`` in XML. Keeping this conversion explicit prevents the
    two native views from being silently treated as the same bearing.
    """
    raw = _finite_float(candidate.get("doa_raw_deg"), "candidate.doa_raw_deg")
    # Upstream ROOT-MUSIC adds array_offset without a modulo, so a valid
    # bearing can arrive above 360 or below 0. Only an implausible magnitude
    # is rejected; both views are then reduced with the same modulo.
    if not NATIVE_ANGLE_MIN_DEG <= raw <= NATIVE_ANGLE_MAX_DEG:
        raise CollectorError(
            f"candidate.doa_raw_deg is outside [{NATIVE_ANGLE_MIN_DEG:g}, {NATIVE_ANGLE_MAX_DEG:g}]"
        )
    if candidate.get("angle_convention") == "csv_360_minus_theta":
        return (360.0 - raw) % 360.0
    if candidate.get("angle_convention") == "xml_raw_theta":
        return raw % 360.0
    raise CollectorError("unknown native angle convention")


def normalize_doa_candidate(
    candidate: Mapping[str, Any],
    *,
    power_mapping_ready: bool = False,
) -> Dict[str, Any]:
    """Keep native metrics lossless and expose contract readiness separately.

    The upstream confidence value is a PAPR-like metric in dB, not a probability:
    ``10*log10(max(abs(DOA))/mean(abs(DOA)))``. The XML writer multiplies that
    metric by 100 for its integer ``CONF`` field. Neither native value can be
    converted to the MQTT contract's 0..1 confidence without calibration, so the
    native metric remains available while the contract field stays unavailable.
    """
    result = dict(candidate)
    raw_angle = _finite_float(candidate.get("doa_raw_deg"), "candidate.doa_raw_deg")
    result["canonical_angle_deg"] = _canonicalize_native_angle(candidate)
    result["canonical_angle_convention"] = "upstream_theta_0"
    confidence_metric_db: float
    confidence_metric_valid: bool
    frequency_valid: bool
    power_native_db: Optional[float]
    power_native_valid: bool
    power_mapping_lossy = False

    if candidate.get("source_format") == "csv":
        confidence_metric_db = _finite_float(candidate.get("confidence_raw"), "csv.confidence_raw")
        confidence_metric_valid = math.isfinite(confidence_metric_db) and confidence_metric_db >= 0.0
        frequency_hz = _finite_int(candidate.get("frequency_hz"), "csv.frequency_hz")
        power_native_db = _finite_float(candidate.get("power_raw"), "csv.power_raw")
        frequency_valid = 0 < frequency_hz <= 6_000_000_000
        # A value at the CSV floor is clipped and does not identify the power.
        power_mapping_lossy = power_native_db <= CSV_POWER_FLOOR_DB
        power_native_valid = math.isfinite(power_native_db) and not power_mapping_lossy
        peak_distance: Optional[float] = None
        peak_consistent: Optional[bool] = None
        peak_index = candidate.get("angular_peak_index")
        if isinstance(peak_index, int) and not isinstance(peak_index, bool) and candidate.get("angular_bins") == CSV_VECTOR_BINS:
            # Upstream writes the vector on the theta_0 grid, so the peak bin
            # equals theta_0 for the same frame.
            peak_distance = _circular_angle_distance(float(peak_index), result["canonical_angle_deg"])
            peak_consistent = peak_distance <= ANGULAR_PEAK_ANGLE_TOLERANCE_DEG
        result.update(
            {
                "angular_peak_angle_distance_deg": peak_distance,
                "angular_peak_angle_consistent": peak_consistent,
                "angular_peak_angle_tolerance_deg": ANGULAR_PEAK_ANGLE_TOLERANCE_DEG,
                "power_mapping_lossy": power_mapping_lossy,
            }
        )
        result.update(
            {
                "confidence": None,
                "confidence_metric_db": confidence_metric_db,
                "confidence_metric_unit": "dB_papr",
                "confidence_metric_valid": confidence_metric_valid,
                "confidence_unit": "dB_papr_unmapped",
                "confidence_valid": False,
                "confidence_contract_valid": False,
                "confidence_mapping_ready": False,
                "frequency_hz_normalized": frequency_hz,
                "frequency_unit": "Hz",
                "frequency_valid": frequency_valid,
                "power_db": power_native_db if power_mapping_ready and power_native_valid else None,
                "power_native_db": power_native_db,
                "power_native_valid": power_native_valid,
                "power_unit": "dB_spectrum_native_unverified",
                "power_valid": bool(power_mapping_ready and power_native_valid),
            }
        )
    elif candidate.get("source_format") == "xml":
        confidence_raw = _finite_float(candidate.get("confidence_raw_percent"), "xml.CONF")
        frequency_mhz = _finite_float(candidate.get("frequency_mhz"), "xml.FREQUENCY")
        transformed_power = _finite_float(candidate.get("power_transformed_raw"), "xml.PWR")
        confidence_metric_db = confidence_raw / 100.0
        confidence_metric_valid = math.isfinite(confidence_metric_db) and confidence_metric_db >= 0.0
        frequency_valid = 0.0 < frequency_mhz <= 6_000.0
        # Upstream writes max(0, native_power_db + 100). A transformed value
        # at the floor is clipped and cannot be inverted precisely; values above
        # the floor can be represented as a traceable native estimate, not yet a
        # calibrated MQTT dB.
        power_mapping_lossy = transformed_power <= XML_POWER_CLIP_FLOOR
        power_native_db = transformed_power - 100.0
        power_native_valid = math.isfinite(power_native_db) and not power_mapping_lossy
        result.update(
            {
                "confidence": None,
                "confidence_metric_db": confidence_metric_db,
                "confidence_metric_unit": "dB_papr",
                "confidence_metric_valid": confidence_metric_valid,
                "confidence_unit": "source_dB_papr_times_100",
                "confidence_valid": False,
                "confidence_contract_valid": False,
                "confidence_mapping_ready": False,
                "frequency_hz_normalized": int(round(frequency_mhz * 1_000_000.0)),
                "frequency_unit": "MHz_to_Hz",
                "frequency_valid": frequency_valid,
                "power_db": power_native_db if power_mapping_ready and power_native_valid else None,
                "power_native_db": power_native_db,
                "power_native_valid": power_native_valid,
                "power_unit": "dB_spectrum_native_unverified",
                "power_valid": bool(power_mapping_ready and power_native_valid),
                "power_transformed_raw": transformed_power,
                "power_mapping_lossy": power_mapping_lossy,
            }
        )
    else:
        raise CollectorError("unknown native angle convention")

    unit_reasons: List[str] = []
    if not confidence_metric_valid:
        unit_reasons.append("CONFIDENCE_METRIC_INVALID")
    if not result.get("confidence_mapping_ready"):
        unit_reasons.append("CONFIDENCE_MAPPING_UNVERIFIED")
    if not frequency_valid:
        unit_reasons.append("FREQUENCY_OUT_OF_RANGE")
    if not power_native_valid:
        unit_reasons.append("POWER_NATIVE_INVALID")
    if not result.get("power_valid"):
        unit_reasons.append(
            "POWER_MAPPING_UNVERIFIED" if not power_mapping_ready else "POWER_VALUE_INVALID"
        )
    if power_mapping_lossy:
        unit_reasons.append("POWER_FLOOR_LOSSY")
    result["unit_reasons"] = unit_reasons
    result["native_metrics_valid"] = bool(confidence_metric_valid and frequency_valid and power_native_valid)
    result["native_metrics_state"] = "READY" if result["native_metrics_valid"] else "NOT_READY"
    result["contract_mapping_state"] = "READY" if not unit_reasons else "NOT_READY"
    result["units_state"] = result["contract_mapping_state"]
    result["angle_raw_deg"] = raw_angle
    result["units_valid"] = not unit_reasons
    return result


def _circular_angle_distance(first: float, second: float) -> float:
    delta = abs((first - second) % 360.0)
    return min(delta, 360.0 - delta)


def assess_native_conflict(candidates: Mapping[str, Mapping[str, Any]]) -> Dict[str, Any]:
    """Compare adjacent native views without requiring byte-identical timestamps.

    CSV and XML are independent files rewritten by the node. A GET pair can
    therefore observe two neighboring processing frames. They remain
    comparable when their node timestamps are within the bounded pair window,
    but the angle tolerance is meant for one frame: a bearing that moved
    between frames is not a convention error. The angle test therefore runs
    only on same-timestamp pairs; adjacent pairs report their distance for
    diagnostics without a conflict verdict.
    """
    csv_candidate = candidates.get("csv", {})
    xml_candidate = candidates.get("xml", {})
    available = bool(csv_candidate.get("available")) and bool(xml_candidate.get("available"))
    csv_timestamp = csv_candidate.get("timestamp_ms")
    xml_timestamp = xml_candidate.get("timestamp_ms")
    timestamp_delta_ms: Optional[int] = None
    if available and isinstance(csv_timestamp, int) and isinstance(xml_timestamp, int):
        timestamp_delta_ms = abs(csv_timestamp - xml_timestamp)
    comparable = bool(available and timestamp_delta_ms is not None and timestamp_delta_ms <= NATIVE_TIMESTAMP_TOLERANCE_MS)
    if timestamp_delta_ms is None:
        frame_relation = "INCOMPLETE"
    elif timestamp_delta_ms == 0:
        frame_relation = "SAME_FRAME"
    elif comparable:
        frame_relation = "ADJACENT_FRAMES"
    else:
        frame_relation = "OUT_OF_WINDOW"
    result: Dict[str, Any] = {
        "comparable": comparable,
        "same_timestamp": bool(comparable and timestamp_delta_ms == 0),
        "timestamp_delta_ms": timestamp_delta_ms,
        "timestamp_tolerance_ms": NATIVE_TIMESTAMP_TOLERANCE_MS,
        "frame_relation": frame_relation,
        "angle_checked": False,
        "angle_invalid": False,
        "conflict": False,
        "tolerance_deg": ANGLE_CONSISTENCY_TOLERANCE_DEG,
    }
    if not comparable:
        return result
    try:
        csv_angle = _canonicalize_native_angle(csv_candidate)
        xml_angle = _canonicalize_native_angle(xml_candidate)
    except CollectorError as exc:
        # An unusable angle is invalid data, not a disagreement between views.
        result.update({
            "error": str(exc),
            "angle_invalid": True,
            "comparable": False,
            "same_timestamp": False,
        })
        return result
    distance = _circular_angle_distance(csv_angle, xml_angle)
    result.update({
        "csv_canonical_deg": csv_angle,
        "xml_canonical_deg": xml_angle,
        "circular_distance_deg": distance,
    })
    if frame_relation == "SAME_FRAME":
        result["angle_checked"] = True
        result["conflict"] = distance > ANGLE_CONSISTENCY_TOLERANCE_DEG
    return result


class NodeProgressTracker:
    """Remember per-node counters across reads to detect a frozen DSP loop.

    The node writes status.json, DOA_value.html and doa.xml from one DSP loop
    while port 8081 is served by a separate process. When the loop stops, the
    files freeze with mutually consistent timestamps, so comparing them with
    each other cannot reveal it. Comparing how long a counter has stayed
    unchanged against Ground monotonic time needs no clock synchronization.
    """

    def __init__(self, max_keys: int = 16) -> None:
        self._lock = threading.Lock()
        self._entries: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self._max_keys = max(1, int(max_keys))

    def observe(
        self,
        key: str,
        counters: Mapping[str, int],
        observed_monotonic: float,
        max_stall_ms: int,
    ) -> Tuple[Dict[str, Any], Dict[str, float]]:
        """Record one sample; return the public assessment and change times."""
        with self._lock:
            entry = self._entries.pop(key, None)
            first_sample = entry is None
            if entry is None:
                entry = {"values": {}, "changed_at": {}, "samples": 0}
            regressed: List[str] = []
            changed: List[str] = []
            for name, value in counters.items():
                previous = entry["values"].get(name)
                if previous is None or value != previous:
                    if previous is not None:
                        changed.append(name)
                        if value < previous:
                            regressed.append(name)
                    entry["values"][name] = value
                    entry["changed_at"][name] = observed_monotonic
            for name in [name for name in entry["values"] if name not in counters]:
                entry["values"].pop(name, None)
                entry["changed_at"].pop(name, None)
            entry["samples"] = min(int(entry["samples"]) + 1, 1_000_000)
            self._entries[key] = entry
            while len(self._entries) > self._max_keys:
                self._entries.popitem(last=False)
            changed_at = dict(entry["changed_at"])
            samples = int(entry["samples"])
        unchanged_for_ms = {
            name: max(0, int(round((observed_monotonic - changed) * 1000)))
            for name, changed in changed_at.items()
        }
        stalled = sorted(name for name, age in unchanged_for_ms.items() if age > max_stall_ms)
        # UNCHANGED: nothing moved since the previous read, but not for long
        # enough to call the node stalled. It is not evidence of freshness.
        if first_sample:
            state = "FIRST_SAMPLE"
        elif stalled:
            state = "STALLED"
        else:
            state = "ADVANCING" if changed else "UNCHANGED"
        return (
            {
                "state": state,
                "stalled": bool(stalled),
                "stalled_counters": stalled,
                "changed_counters": sorted(changed),
                "unchanged_for_ms": unchanged_for_ms,
                "regressed_counters": sorted(regressed),
                "max_stall_ms": int(max_stall_ms),
                "samples": samples,
            },
            changed_at,
        )


def _progress_counters(status: Mapping[str, Any]) -> Dict[str, int]:
    safe = status.get("safe") if isinstance(status.get("safe"), Mapping) else {}
    daq_status = safe.get("daq_status") if isinstance(safe.get("daq_status"), Mapping) else {}
    sources = {"timestamp_ms": safe, "uptime_ms": safe, "data_frame_index": daq_status}
    values = {name: sources[name].get(name) for name in NODE_PROGRESS_COUNTERS}
    return {
        name: value
        for name, value in values.items()
        if isinstance(value, int) and not isinstance(value, bool)
    }


def _untracked_progress(state: str, max_stall_ms: int) -> Dict[str, Any]:
    return {
        "state": state,
        "stalled": False,
        "stalled_counters": [],
        "changed_counters": [],
        "unchanged_for_ms": {},
        "regressed_counters": [],
        "max_stall_ms": int(max_stall_ms),
        "samples": 0,
    }


class _Worker:
    """Run one read in a daemon thread so a deadline can abandon it."""

    def __init__(self, function: Callable[[], Any]) -> None:
        self.done = threading.Event()
        self.result: Any = None
        self.error: Optional[BaseException] = None
        self._thread = threading.Thread(target=self._run, args=(function,), name="sdr-doa-collect", daemon=True)

    def _run(self, function: Callable[[], Any]) -> None:
        try:
            self.result = function()
        except BaseException as exc:  # re-raised in the collecting thread
            self.error = exc
        finally:
            self.done.set()

    def start(self) -> None:
        self._thread.start()


def _run_reads(
    reads: Mapping[str, Callable[[], Any]],
    deadline: Optional[float],
) -> Dict[str, Any]:
    """Run reads concurrently; a read still running at the deadline maps to None."""
    if deadline is None and len(reads) == 1:
        key, function = next(iter(reads.items()))
        return {key: function()}
    workers = {key: _Worker(function) for key, function in reads.items()}
    for worker in workers.values():
        worker.start()
    results: Dict[str, Any] = {}
    for key, worker in workers.items():
        if deadline is None:
            worker.done.wait()
        else:
            worker.done.wait(max(0.0, deadline - time.monotonic()) + DEADLINE_GRACE_SECONDS)
        if not worker.done.is_set():
            results[key] = None
            continue
        if worker.error is not None:
            raise worker.error
        results[key] = worker.result
    return results


def _vfo_row_summary(candidate: Mapping[str, Any]) -> Dict[str, Any]:
    try:
        canonical: Optional[float] = _canonicalize_native_angle(candidate)
    except CollectorError:
        canonical = None
    return {
        "row_index": candidate.get("csv_row_index"),
        "timestamp_ms": candidate.get("timestamp_ms"),
        "frequency_hz": candidate.get("frequency_hz"),
        "doa_raw_deg": candidate.get("doa_raw_deg"),
        "canonical_angle_deg": canonical,
        "confidence_raw": candidate.get("confidence_raw"),
        "power_raw": candidate.get("power_raw"),
    }


def _select_csv_row(
    parsed: Optional[Mapping[str, Any]],
    resource: FetchedResource,
    xml_candidate: Mapping[str, Any],
) -> Dict[str, Any]:
    """Pick the CSV row that belongs to the XML view's VFO.

    One row is the normal case. Output VFO = ALL writes one row per VFO; the
    row is then chosen by the XML frequency, and the others stay visible as
    additional VFO rows instead of rejecting the whole view.
    """
    if not parsed or parsed.get("available") is not True:
        candidate = _unavailable(resource)
        candidate["error"] = (parsed or {}).get("error") or candidate.get("error") or "CSV parse failed"
        return candidate
    rows: List[Dict[str, Any]] = list(parsed.get("rows") or [])
    summaries = [_vfo_row_summary(row) for row in rows]
    if len(rows) == 1:
        selected = dict(rows[0])
        selection = "single_row"
    else:
        matches: List[Dict[str, Any]] = []
        xml_hz: Optional[int] = None
        if xml_candidate.get("available") is True:
            frequency_mhz = xml_candidate.get("frequency_mhz")
            if isinstance(frequency_mhz, (int, float)) and not isinstance(frequency_mhz, bool) and math.isfinite(frequency_mhz):
                xml_hz = int(round(float(frequency_mhz) * 1_000_000.0))
        if xml_hz is not None:
            matches = [
                row for row in rows
                if isinstance(row.get("frequency_hz"), int)
                and abs(int(row["frequency_hz"]) - xml_hz) <= CSV_XML_FREQUENCY_MATCH_HZ
            ]
        if len(matches) != 1:
            if xml_hz is None:
                detail = "the XML view is unavailable to select one"
            elif not matches:
                detail = "none matches the XML frequency"
            else:
                detail = "several match the XML frequency"
            candidate = _unavailable(resource)
            candidate["error"] = f"{len(rows)} CSV rows (multi-VFO output); {detail}"
            candidate["csv_rows_total"] = len(rows)
            candidate["additional_vfo_rows"] = summaries
            return candidate
        selected = dict(matches[0])
        selection = "matched_xml_frequency"
    selected["csv_rows_total"] = len(rows)
    selected["csv_row_selection"] = selection
    selected["additional_vfo_rows"] = [
        summary for summary in summaries if summary["row_index"] != selected.get("csv_row_index")
    ]
    return selected


def _finite_or_none(value: Any) -> Optional[float]:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    return None


def _signal_quality(status: Mapping[str, Any], candidates: Mapping[str, Mapping[str, Any]]) -> Dict[str, Any]:
    """Summarize ADC overdrive, SNR and native PAPR without remapping units.

    Upstream rewrites the DoA files only when a signal passes squelch, so a
    parsed view can hold an old frame. Only fresh views count here; a stale
    view's values are reported under ``last_doa_record`` and never set the
    state, so status.json alone decides overdrive between DoA records.
    """
    active: List[str] = []
    reported: List[str] = []
    safe = status.get("safe") if status.get("available") is True and isinstance(status.get("safe"), Mapping) else {}
    daq_status = safe.get("daq_status") if isinstance(safe.get("daq_status"), Mapping) else {}
    status_flag = daq_status.get("adc_overdrive")
    if isinstance(status_flag, bool):
        reported.append("status")
        if status_flag:
            active.append("status")

    current: Dict[str, Mapping[str, Any]] = {}
    last_doa_record: Dict[str, Dict[str, Any]] = {}
    for name in ("csv", "xml"):
        candidate = candidates.get(name, {})
        if candidate.get("available") is not True:
            continue
        freshness = candidate.get("freshness") if isinstance(candidate.get("freshness"), Mapping) else {}
        if freshness.get("fresh") is True:
            current[name] = candidate
            continue
        record: Dict[str, Any] = {
            "timestamp_ms": candidate.get("timestamp_ms"),
            "age_ms": freshness.get("age_ms"),
            "fresh": freshness.get("fresh"),
            "confidence_metric_db": _finite_or_none(candidate.get("confidence_metric_db")),
        }
        if name == "xml":
            flag = candidate.get("adc_overdrive_active")
            record["adc_overdrive_active"] = flag if isinstance(flag, bool) else None
            record["snr_db"] = _finite_or_none(candidate.get("snr_db"))
        last_doa_record[name] = record

    xml_candidate = current.get("xml", {})
    channel_mask: Optional[int] = None
    if xml_candidate:
        xml_flag = xml_candidate.get("adc_overdrive_active")
        if isinstance(xml_flag, bool):
            reported.append("xml")
            if xml_flag:
                active.append("xml")
        mask = xml_candidate.get("adc_overdrive_channel_mask")
        channel_mask = mask if isinstance(mask, int) and not isinstance(mask, bool) else None
    snr_db = _finite_or_none(xml_candidate.get("snr_db"))

    noise_source = daq_status.get("noise_source_enabled")
    dropped = safe.get("daq_num_dropped_frames")
    return {
        "state": "OVERDRIVE" if active else ("PASS" if reported else "UNKNOWN"),
        "adc_overdrive": True if active else (False if reported else None),
        "adc_overdrive_sources": active,
        "adc_overdrive_reported_by": reported,
        "adc_overdrive_channel_mask": channel_mask,
        "snr_db": snr_db,
        "snr_source": "xml" if snr_db is not None else None,
        "snr_unit": "dB_native_unverified",
        "confidence_metric_db": {
            name: _finite_or_none(current.get(name, {}).get("confidence_metric_db")) for name in ("csv", "xml")
        },
        "confidence_metric_unit": "dB_papr_unmapped",
        "last_doa_record": last_doa_record,
        "noise_source_enabled": noise_source if isinstance(noise_source, bool) else None,
        "daq_num_dropped_frames": dropped if isinstance(dropped, int) and not isinstance(dropped, bool) else None,
    }


def _host_resolution(base_url: str, resources: Iterable[FetchedResource]) -> Dict[str, Any]:
    """How the Data Out host became an address in this collection.

    ``method`` is "literal" (the URL holds an IP address), "system" (the
    system resolver; ``address`` is the connected peer), "mdns" (the
    one-shot mDNS fallback for a .local name) or None when no read got that
    far. The first resource that knows it decides (status.json is read first).
    """
    try:
        host: Optional[str] = (urllib.parse.urlsplit(str(base_url)).hostname or "").lower().rstrip(".") or None
    except ValueError:
        host = None
    for resource in resources:
        via = getattr(resource, "resolved_via", None)
        if via:
            return {"host": host, "method": via, "address": getattr(resource, "resolved_address", None)}
    return {"host": host, "method": None, "address": None}


def collect(
    base_url: str,
    authority: str = "none",
    clock_source: str = "remote_unverified",
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
    status_max_age_ms: int = DEFAULT_STATUS_MAX_AGE_MS,
    doa_max_age_ms: int = DEFAULT_DOA_MAX_AGE_MS,
    max_future_skew_ms: int = DEFAULT_MAX_FUTURE_SKEW_MS,
    fetcher: Any = fetch_resource,
    parse_attempts: int = 3,
    retry_delay_seconds: float = 0.05,
    canonical_angle_ready: bool = False,
    power_mapping_ready: bool = False,
    *,
    total_budget_s: Optional[float] = None,
    progress_tracker: Optional[NodeProgressTracker] = None,
    monotonic_clock: Callable[[], float] = time.monotonic,
    allowed_hosts: Optional[Iterable[str]] = None,
    mdns_resolver: Any = None,
) -> Dict[str, Any]:
    """Read the four Data Out resources once and assess them.

    ``total_budget_s`` bounds the whole collection; a read still running when
    it expires is reported as unavailable instead of holding the caller.
    ``progress_tracker`` remembers node counters across calls so a frozen
    node is detected (``NODE_CLOCK_STALLED``). ``monotonic_clock`` measures
    Ground elapsed time for ages and progress; it exists for deterministic
    tests and does not affect the deadline. ``allowed_hosts`` (the saved
    Data Out host list) and ``mdns_resolver`` go to ``fetch_resource`` when
    it is the fetcher; ``collection.host_resolution`` reports how the host
    became an address.
    """
    if authority not in {"none", "csv", "xml"}:
        raise ValueError("authority must be one of: none, csv, xml")
    if clock_source not in {"local", "remote_unverified"}:
        raise ValueError("clock_source must be one of: local, remote_unverified")
    if total_budget_s is not None:
        if (
            isinstance(total_budget_s, bool)
            or not isinstance(total_budget_s, (int, float))
            or not math.isfinite(total_budget_s)
            or not 0 < total_budget_s <= MAX_TOTAL_BUDGET_SECONDS
        ):
            raise ValueError(f"total_budget_s must be within (0, {MAX_TOTAL_BUDGET_SECONDS:g}]")
    if fetcher is fetch_resource and (allowed_hosts is not None or mdns_resolver is not None):
        fetcher = functools.partial(fetch_resource, allowed_hosts=allowed_hosts, mdns_resolver=mdns_resolver)
    started_real = time.monotonic()
    started_mono = monotonic_clock()
    deadline = started_real + float(total_budget_s) if total_budget_s is not None else None
    observed_at_ms = now_ms()
    resources: Dict[str, FetchedResource] = {}

    def reader(path: str, parser: Any) -> Callable[[], Tuple[FetchedResource, Optional[Dict[str, Any]]]]:
        def read() -> Tuple[FetchedResource, Optional[Dict[str, Any]]]:
            return fetch_and_parse_with_retry(
                base_url,
                path,
                parser,
                timeout_seconds,
                max_body_bytes,
                attempts=parse_attempts,
                retry_delay_seconds=retry_delay_seconds,
                fetcher=fetcher,
                deadline=deadline,
            )
        return read

    def read_all(reads: Mapping[str, Callable[[], Any]]) -> Dict[str, Tuple[FetchedResource, Optional[Dict[str, Any]]]]:
        results = _run_reads(reads, deadline)
        completed: Dict[str, Tuple[FetchedResource, Optional[Dict[str, Any]]]] = {}
        for path, result in results.items():
            if result is None:
                resource = _not_fetched(base_url, path, "collection deadline exceeded", "deadline")
                completed[path] = (resource, {"available": False, "error": "collection deadline exceeded"})
            else:
                completed[path] = result
        return completed

    # Candidates are parsed against a provisional reference; their freshness
    # is assessed again once the whole collection has finished.
    def parse_csv_rows_wrapper(resource: FetchedResource) -> Dict[str, Any]:
        return {"available": True, "rows": parse_csv_doa_rows(resource, observed_at_ms, doa_max_age_ms, max_future_skew_ms)}

    def parse_xml_wrapper(resource: FetchedResource) -> Dict[str, Any]:
        return parse_xml_doa(resource, observed_at_ms, doa_max_age_ms, max_future_skew_ms)

    status_started_mono = monotonic_clock()
    status_resource, status = read_all({PATH_STATUS: reader(PATH_STATUS, parse_status)})[PATH_STATUS]
    resources[PATH_STATUS] = status_resource
    if not status or status.get("available") is not True:
        status = {
            "available": False,
            "error": (status or {}).get("error", "status parse failed"),
        }
    status_available = bool(status.get("available"))
    # Every resource lives on the same host and port. When status.json could
    # not even be reached, the other three GETs would wait out the same
    # failure and add load to a node that is already struggling.
    status_transport_failed = getattr(status_resource, "error_kind", None) in TRANSPORT_ERROR_KINDS

    if progress_tracker is None:
        node_progress = _untracked_progress("UNTRACKED", status_max_age_ms)
        status_first_seen_mono = status_started_mono
    elif not status_available:
        node_progress = _untracked_progress("UNAVAILABLE", status_max_age_ms)
        status_first_seen_mono = status_started_mono
    else:
        node_progress, changed_at = progress_tracker.observe(
            _redact_url(base_url),
            _progress_counters(status),
            status_started_mono,
            status_max_age_ms,
        )
        status_first_seen_mono = changed_at.get("timestamp_ms", status_started_mono)
    node_stalled = node_progress.get("stalled") is True

    if status_transport_failed:
        skipped = "skipped: status.json transport failure"
        first_reads = {
            path: (_not_fetched(base_url, path, skipped, "skipped"), {"available": False, "error": skipped})
            for path in (PATH_SETTINGS, PATH_CSV, PATH_XML)
        }
    else:
        first_reads = read_all({
            PATH_SETTINGS: reader(PATH_SETTINGS, parse_settings),
            PATH_CSV: reader(PATH_CSV, parse_csv_rows_wrapper),
            PATH_XML: reader(PATH_XML, parse_xml_wrapper),
        })

    settings_resource, settings = first_reads[PATH_SETTINGS]
    resources[PATH_SETTINGS] = settings_resource
    if not settings or settings.get("available") is not True:
        settings = {
            "available": False,
            "redacted": True,
            "error": (settings or {}).get("error", "settings parse failed"),
            "raw_fields_omitted": True,
        }

    def native_pair(
        csv_read: Tuple[FetchedResource, Optional[Dict[str, Any]]],
        xml_read: Tuple[FetchedResource, Optional[Dict[str, Any]]],
    ) -> Tuple[FetchedResource, Dict[str, Any], FetchedResource, Dict[str, Any]]:
        csv_res, csv_parsed = csv_read
        xml_res, xml_parsed = xml_read
        if not xml_parsed or xml_parsed.get("available") is not True:
            parse_error = (xml_parsed or {}).get("error")
            xml_view = _unavailable(xml_res)
            xml_view["error"] = parse_error or xml_view.get("error") or "XML parse failed"
        else:
            xml_view = dict(xml_parsed)
        csv_view = _select_csv_row(csv_parsed, csv_res, xml_view)
        return csv_res, csv_view, xml_res, xml_view

    csv_resource, csv_candidate, xml_resource, xml_candidate = native_pair(first_reads[PATH_CSV], first_reads[PATH_XML])
    pair_reads = 1
    while pair_reads <= NATIVE_PAIR_REREADS:
        if csv_candidate.get("available") is not True or xml_candidate.get("available") is not True:
            break
        csv_ts = csv_candidate.get("timestamp_ms")
        xml_ts = xml_candidate.get("timestamp_ms")
        if not isinstance(csv_ts, int) or not isinstance(xml_ts, int):
            break
        delta = abs(csv_ts - xml_ts)
        if delta == 0 or delta > NATIVE_TIMESTAMP_TOLERANCE_MS:
            break
        if deadline is not None and time.monotonic() >= deadline:
            break
        # The pair straddles a frame boundary. A second pair read normally
        # lands inside one frame and makes the angle test meaningful.
        reread = read_all({
            PATH_CSV: reader(PATH_CSV, parse_csv_rows_wrapper),
            PATH_XML: reader(PATH_XML, parse_xml_wrapper),
        })
        pair_reads += 1
        next_pair = native_pair(reread[PATH_CSV], reread[PATH_XML])
        if next_pair[1].get("available") is not True or next_pair[3].get("available") is not True:
            break
        csv_resource, csv_candidate, xml_resource, xml_candidate = next_pair
    resources[PATH_CSV] = csv_resource
    resources[PATH_XML] = xml_resource

    completed_mono = monotonic_clock()
    completed_at_ms = now_ms()
    elapsed_ms = max(0, int(round((completed_mono - started_mono) * 1000)))
    deadline_exceeded = any(getattr(resource, "error_kind", None) == "deadline" for resource in resources.values())

    # DoA and status timestamps originate from the same Raspberry clock, so
    # their difference stays meaningful on Ground without clock sync. The
    # node's "now" is at least the status timestamp plus the Ground time since
    # that timestamp was first seen: this counts collection time and the time
    # a frozen node has kept repeating the same status.
    if status_available:
        status_timestamp: Optional[int] = status["safe"]["timestamp_ms"]
        ground_elapsed_ms = max(0, int(round((completed_mono - status_first_seen_mono) * 1000)))
        doa_reference_ms = int(status_timestamp) + ground_elapsed_ms
        doa_reference_kind = "status_timestamp_ms"
        doa_freshness_known = True
    else:
        # Without status.json the only reference is the Ground clock, which is
        # meaningful only when the collector runs on the node itself.
        status_timestamp = None
        ground_elapsed_ms = 0
        doa_reference_ms = completed_at_ms
        doa_reference_kind = "local_observed_at"
        doa_freshness_known = clock_source == "local"

    raw_candidates = {"csv": csv_candidate, "xml": xml_candidate}
    for candidate in raw_candidates.values():
        timestamp = candidate.get("timestamp_ms")
        if candidate.get("available") is not True or not isinstance(timestamp, int):
            continue
        freshness = _age_assessment(
            timestamp,
            doa_reference_ms,
            doa_max_age_ms,
            max_future_skew_ms,
            doa_reference_kind,
            doa_freshness_known,
        )
        freshness["ground_elapsed_ms"] = ground_elapsed_ms
        freshness["status_timestamp_ms"] = status_timestamp
        freshness["node_stalled"] = node_stalled
        if node_stalled:
            freshness["fresh"] = False
        candidate["freshness"] = freshness

    native_consistency = assess_native_conflict(raw_candidates)
    native_consistency["pair_reads"] = pair_reads
    candidates: Dict[str, Dict[str, Any]] = {}
    for name, candidate in raw_candidates.items():
        if candidate.get("available") is not True:
            candidates[name] = candidate
            continue
        try:
            candidates[name] = normalize_doa_candidate(
                candidate,
                power_mapping_ready=power_mapping_ready,
            )
        except CollectorError as exc:
            quarantined = dict(candidate)
            quarantined["units_valid"] = False
            quarantined["normalization_error"] = type(exc).__name__
            quarantined["normalization_error_detail"] = str(exc)
            candidates[name] = quarantined

    # A quarantined view parsed but carries no usable angle, so it does not
    # count as a valid candidate.
    parsed_candidates = [
        candidate
        for candidate in candidates.values()
        if candidate.get("available") and "normalization_error" not in candidate
    ]
    fresh_candidates = [
        candidate
        for candidate in parsed_candidates
        if candidate.get("freshness", {}).get("fresh") is True
    ]
    selected = candidates.get(authority) if authority != "none" else None
    selected_available = bool(selected and selected.get("available") and "normalization_error" not in selected)
    selected_fresh = bool(selected_available and selected.get("freshness", {}).get("fresh"))
    selected_units_valid = bool(selected_available and selected.get("units_valid") is True)
    # Angle conversion is implemented, but publication readiness must remain an
    # explicit deployment/configuration decision after controlled validation.
    canonical_angle_ready = bool(canonical_angle_ready)

    status_age: Optional[Dict[str, Any]] = None
    if status_available and clock_source == "local":
        status_timestamp_local = status["safe"]["timestamp_ms"]
        status_age = _age_assessment(
            status_timestamp_local,
            observed_at_ms,
            status_max_age_ms,
            max_future_skew_ms,
            "local_observed_at",
            True,
        )
    elif status_available:
        status_age = _age_assessment(
            status["safe"]["timestamp_ms"],
            observed_at_ms,
            status_max_age_ms,
            max_future_skew_ms,
            "ground_observed_at",
            False,
        )
    status_fresh = bool(status_age and status_age["fresh"] is True)
    daq_healthy = status.get("daq_health") == "PASS"
    signal_quality = _signal_quality(status, candidates)
    adc_overdriven = signal_quality["adc_overdrive"] is True
    csv_view = candidates.get("csv", {})
    angular_peak_consistent = not (
        csv_view.get("available") is True and csv_view.get("angular_peak_angle_consistent") is False
    )
    angle_invalid = native_consistency.get("angle_invalid") is True or any(
        "normalization_error" in candidate for candidate in candidates.values()
    )
    # Both views were read, but from different frames (or outside the pair
    # window), so their angles were never cross-checked. Display may still use
    # such a pair; publication may not rely on views that were not compared.
    both_views_parsed = all(
        candidates.get(view, {}).get("available") is True and "normalization_error" not in candidates.get(view, {})
        for view in ("csv", "xml")
    )
    native_angle_unchecked = (
        both_views_parsed
        and not angle_invalid
        and native_consistency.get("angle_checked") is not True
    )

    gate_checks = {
        "status_available": status_available,
        "status_fresh": status_fresh if clock_source == "local" else None,
        "daq_healthy": daq_healthy,
        "adc_not_overdriven": not adc_overdriven,
        "node_not_stalled": not node_stalled,
        "doa_candidate_parsed": bool(parsed_candidates),
        "doa_candidate_fresh": bool(fresh_candidates),
        "authority_selected": authority != "none" and selected_available,
        "selected_doa_fresh": selected_fresh,
        "selected_units_valid": selected_units_valid,
        "canonical_angle_ready": canonical_angle_ready,
        "native_views_consistent": native_consistency.get("comparable") is False
        or native_consistency.get("conflict") is False,
        "angular_peak_consistent": angular_peak_consistent,
        "native_angle_checked": not native_angle_unchecked,
    }
    publication_ready = all(value is True for value in gate_checks.values())
    # overall_state describes the data. An unchecked frame pair only blocks
    # publication; it does not make healthy data DEGRADED.
    data_ready = all(value is True for key, value in gate_checks.items() if key != "native_angle_checked")

    if not status_available:
        overall_state = "UNAVAILABLE"
    elif not daq_healthy or adc_overdriven:
        overall_state = "DEGRADED"
    elif not parsed_candidates:
        overall_state = "INVALID"
    elif native_consistency.get("conflict") is True:
        overall_state = "CONFLICT"
    elif not fresh_candidates:
        overall_state = "STALE"
    elif native_consistency.get("comparable") is not True:
        overall_state = "INCOMPLETE"
    elif authority == "none":
        overall_state = "UNVERIFIED"
    elif not canonical_angle_ready:
        overall_state = "UNVERIFIED"
    else:
        overall_state = "LIVE" if data_ready else "DEGRADED"

    reasons: List[str] = []
    if not status_available:
        reasons.append("STATUS_UNAVAILABLE_OR_INVALID")
    if deadline_exceeded:
        reasons.append("COLLECTION_DEADLINE_EXCEEDED")
    if status_available and clock_source == "local" and not status_fresh:
        reasons.append("STATUS_STALE")
    if status_available and clock_source != "local":
        reasons.append("GROUND_CLOCK_UNVERIFIED")
    if node_stalled:
        reasons.append("NODE_CLOCK_STALLED")
    if status_available and not daq_healthy:
        reasons.append("DAQ_HEALTH_GATE_FAILED")
    if adc_overdriven:
        reasons.append("ADC_OVERDRIVE")
    if not parsed_candidates:
        reasons.append("NO_VALID_DOA_CANDIDATE")
    elif not fresh_candidates and doa_freshness_known:
        reasons.append("DOA_CANDIDATES_STALE")
    if parsed_candidates:
        if candidates.get("csv", {}).get("available") is not True:
            reasons.append("CSV_VIEW_UNAVAILABLE")
        if candidates.get("xml", {}).get("available") is not True:
            reasons.append("XML_VIEW_UNAVAILABLE")
    if not canonical_angle_ready:
        reasons.append("CANONICAL_ANGLE_NOT_CONFIGURED")
    if native_consistency.get("conflict"):
        reasons.append("NATIVE_DOA_VIEWS_CONFLICT")
    if angle_invalid:
        reasons.append("NATIVE_ANGLE_INVALID")
    if native_angle_unchecked:
        reasons.append("NATIVE_ANGLE_UNCHECKED")
    if not angular_peak_consistent:
        reasons.append("ANGULAR_PEAK_ANGLE_MISMATCH")
    if authority == "none":
        reasons.append("DOA_AUTHORITY_NOT_SELECTED")
    elif not selected_available:
        reasons.append("SELECTED_AUTHORITY_UNAVAILABLE")
    elif not selected_fresh:
        reasons.append("SELECTED_DOA_STALE")
    elif not selected_units_valid:
        reasons.append("SELECTED_UNITS_NOT_READY")

    return {
        "schema_version": SCHEMA_VERSION,
        "collector": {
            "mode": "read_only",
            "base_url": base_url.rstrip("/"),
            "authority_config": authority,
            "clock_source": clock_source,
            "mqtt_publish": False,
            "raw_settings_omitted": True,
            "raw_angular_values_omitted": True,
            "angular_plot_local_only": True,
        },
        "observed_at_ms": observed_at_ms,
        "completed_at_ms": completed_at_ms,
        "collection": {
            "elapsed_ms": elapsed_ms,
            "budget_ms": int(round(float(total_budget_s) * 1000)) if total_budget_s is not None else None,
            "deadline_exceeded": deadline_exceeded,
            "pair_reads": pair_reads,
            "status_transport_failed": status_transport_failed,
            "host_resolution": _host_resolution(base_url, resources.values()),
        },
        "resources": {path: resource.metadata() for path, resource in resources.items()},
        "status": {
            **status,
            "freshness": status_age,
        },
        "settings": settings,
        "doa_candidates": candidates,
        "authority": {
            "selected": authority if authority != "none" else None,
            "selected_doa": selected if selected_available else None,
            "raw_and_canonical_separated": True,
            "canonical_angle_ready": canonical_angle_ready,
        },
        "native_consistency": native_consistency,
        "node_progress": node_progress,
        "signal_quality": signal_quality,
        "publication_gate": {
            "state": "READY" if publication_ready else "BLOCKED",
            "checks": gate_checks,
            "reasons": reasons,
        },
        "overall_state": overall_state,
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only SDR-DoA Data Out collector")
    allowed = ", ".join(DEFAULT_DATA_OUT_HOSTS)
    parser.add_argument(
        "--base-url",
        required=True,
        help=(
            f"Data Out base URL on port {DATA_OUT_PORT}, for example http://192.168.100.100:{DATA_OUT_PORT} "
            f"(default hosts: {allowed})"
        ),
    )
    parser.add_argument(
        "--data-out-host",
        action="append",
        default=None,
        metavar="HOST",
        help=f"allow this Data Out host instead of the defaults (repeatable, at most {MAX_DATA_OUT_HOSTS})",
    )
    parser.add_argument("--authority", choices=("none", "csv", "xml"), default="none")
    parser.add_argument(
        "--clock-source",
        choices=("local", "remote_unverified"),
        default="remote_unverified",
        help="Use local node clock only when this collector runs on the Raspberry.",
    )
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--total-budget", type=float, default=None, help="overall collection budget in seconds")
    parser.add_argument("--max-body-bytes", type=int, default=DEFAULT_MAX_BODY_BYTES)
    parser.add_argument("--status-max-age-ms", type=int, default=DEFAULT_STATUS_MAX_AGE_MS)
    parser.add_argument("--doa-max-age-ms", type=int, default=DEFAULT_DOA_MAX_AGE_MS)
    parser.add_argument("--max-future-skew-ms", type=int, default=DEFAULT_MAX_FUTURE_SKEW_MS)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        hosts = normalize_data_out_hosts(args.data_out_host) if args.data_out_host else None
        result = collect(
            base_url=args.base_url,
            authority=args.authority,
            clock_source=args.clock_source,
            timeout_seconds=args.timeout,
            max_body_bytes=args.max_body_bytes,
            status_max_age_ms=args.status_max_age_ms,
            doa_max_age_ms=args.doa_max_age_ms,
            max_future_skew_ms=args.max_future_skew_ms,
            total_budget_s=args.total_budget,
            allowed_hosts=hosts,
        )
        print(json.dumps(result, indent=2, sort_keys=True, allow_nan=False))
        return 0
    except (ValueError, OSError) as exc:
        print(json.dumps({"collector_error": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
