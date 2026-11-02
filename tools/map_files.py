#!/usr/bin/env python3
"""The offline basemap file behind ``GET /api/maps/offline.pmtiles``.

The Offline basemap style draws vector tiles from one PMTiles archive that the
operator puts into the console's maps directory (``--maps-dir``, by default
``maps`` next to ``console.json``; ``docs/PETA_OFFLINE.md`` says how to make
it). The browser reads it with HTTP range requests, so this module only has to
answer byte ranges of one fixed file name:

* the route names exactly ``offline.pmtiles``: no directory listing, no other
  name, no path from the request ever reaches the file system;
* a request needs one ``Range: bytes=`` header (the PMTiles reader always
  sends one); a response is at most ``MAX_RANGE_BYTES``, so a client that asks
  for ``bytes=0-`` gets the first block, never the whole archive;
* the file must be a regular file (a symlink or any other type is "not
  installed"), and it is read at the moment of the request, so replacing it
  needs no restart; the ETag is its size and modification time;
* at most ``MAX_CONCURRENT_READS`` reads run at once.

Nothing is fetched from the network and nothing is written here.
"""

from __future__ import annotations

import os
import re
import stat
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

MAPS_ROUTE_PREFIX = "/api/maps/"
OFFLINE_MAP_NAME = "offline.pmtiles"
OFFLINE_MAP_ROUTE = MAPS_ROUTE_PREFIX + OFFLINE_MAP_NAME
DEFAULT_MAPS_DIR_NAME = "maps"

# Vector tiles and PMTiles directories are small; this only bounds one answer.
MAX_RANGE_BYTES = 4 * 1024 * 1024
MAX_CONCURRENT_READS = 8
READ_SLOT_WAIT_S = 2.0

_RANGE_RE = re.compile(r"bytes=([0-9]{0,15})-([0-9]{0,15})")

# Codes of the route's refusals (sent outside the Kontrol code list).
MAP_ERROR_CODES = ("ORIGIN_REJECTED", "MAP_NOT_FOUND", "MAP_RANGE_REQUIRED", "MAP_RANGE_INVALID", "MAP_BUSY", "MAP_READ_FAILED")


@dataclass(frozen=True)
class MapFileInfo:
    path: Path
    size: int
    mtime_ns: int

    @property
    def etag(self) -> str:
        return f'"{self.size:x}-{self.mtime_ns:x}"'


@dataclass
class MapRead:
    """One answer: a status, the bytes and the headers that describe them."""

    status: int
    body: bytes = b""
    headers: Tuple[Tuple[str, str], ...] = ()
    code: str = ""
    error: str = ""


def parse_range(header: Optional[str], size: int) -> Tuple[Optional[Tuple[int, int]], str]:
    """``((first, last), "")`` for one satisfiable range, else ``(None, code)``.

    ``MAP_RANGE_REQUIRED``: no header. ``MAP_RANGE_INVALID``: more than one
    range, a malformed one, or one that starts past the end. An end past the
    file or past ``MAX_RANGE_BYTES`` is clamped, as HTTP allows.
    """
    if header is None or not header.strip():
        return None, "MAP_RANGE_REQUIRED"
    match = _RANGE_RE.fullmatch(header.strip())
    if match is None:
        return None, "MAP_RANGE_INVALID"
    first_text, last_text = match.groups()
    if not first_text:
        # A suffix range ("last N bytes"): the PMTiles reader never asks for one.
        if not last_text:
            return None, "MAP_RANGE_INVALID"
        count = int(last_text)
        if count <= 0 or size <= 0:
            return None, "MAP_RANGE_INVALID"
        first = max(0, size - count)
        last = size - 1
    else:
        first = int(first_text)
        last = int(last_text) if last_text else size - 1
        if last < first:
            return None, "MAP_RANGE_INVALID"
    if first >= size:
        return None, "MAP_RANGE_INVALID"
    last = min(last, size - 1, first + MAX_RANGE_BYTES - 1)
    return (first, last), ""


class MapFiles:
    """Range reads of the offline map in one directory."""

    def __init__(self, maps_dir: Path) -> None:
        self.maps_dir = Path(maps_dir).expanduser()
        self._slots = threading.BoundedSemaphore(MAX_CONCURRENT_READS)

    def info(self) -> Optional[MapFileInfo]:
        """The offline map when it is installed: a regular file that is not a symlink, and not empty."""
        path = self.maps_dir / OFFLINE_MAP_NAME
        try:
            st = os.lstat(path)
        except OSError:
            return None
        if not stat.S_ISREG(st.st_mode) or st.st_size <= 0:
            return None
        return MapFileInfo(path=path, size=int(st.st_size), mtime_ns=int(st.st_mtime_ns))

    def read(self, route_path: str, range_header: Optional[str]) -> MapRead:
        if route_path != OFFLINE_MAP_ROUTE:
            return MapRead(404, code="MAP_NOT_FOUND", error="there is no such map file")
        info = self.info()
        if info is None:
            return MapRead(404, code="MAP_NOT_FOUND", error="the offline map is not installed on this console")
        span, code = parse_range(range_header, info.size)
        if span is None:
            headers = (("Content-Range", f"bytes */{info.size}"),)
            if code == "MAP_RANGE_REQUIRED":
                return MapRead(416, headers=headers, code=code, error="the map is read with a Range header")
            return MapRead(416, headers=headers, code=code, error="that byte range cannot be served")
        first, last = span
        length = last - first + 1
        if not self._slots.acquire(timeout=READ_SLOT_WAIT_S):
            return MapRead(503, headers=(("Retry-After", "1"),), code="MAP_BUSY", error="the map is being read by too many requests")
        try:
            # The file may have been replaced since info(): the open file is
            # checked against the size just used, so a range never spans two files.
            with open(info.path, "rb") as handle:
                st = os.fstat(handle.fileno())
                if not stat.S_ISREG(st.st_mode) or st.st_size != info.size or st.st_mtime_ns != info.mtime_ns:
                    return MapRead(503, headers=(("Retry-After", "1"),), code="MAP_BUSY", error="the map file changed; try again")
                handle.seek(first)
                body = handle.read(length)
        except OSError:
            return MapRead(404, code="MAP_NOT_FOUND", error="the offline map is not installed on this console")
        finally:
            self._slots.release()
        if len(body) != length:
            return MapRead(500, code="MAP_READ_FAILED", error="the map file could not be read")
        headers = (
            ("Content-Type", "application/octet-stream"),
            ("Content-Range", f"bytes {first}-{last}/{info.size}"),
            ("Accept-Ranges", "bytes"),
            ("ETag", info.etag),
            ("Cache-Control", "private, no-cache"),
        )
        return MapRead(206, body, headers)
