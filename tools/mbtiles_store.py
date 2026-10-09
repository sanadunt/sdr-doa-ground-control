"""Read-only access to local raster MBTiles files for the offline basemap.

Files are discovered only in the configured directories (by default the
``tiles`` folder inside the Ground Console data directory) plus explicit
command-line paths. Browser requests select a file by its catalog id and never
supply a path, so the endpoint cannot be used to read other files.
"""
from __future__ import annotations

import re
import sqlite3
import threading
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

RASTER_FORMATS = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
}
MAX_TILE_ZOOM = 24
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_SLUG_RE = re.compile(r"[^A-Za-z0-9_-]+")


def _slug(stem: str) -> str:
    slug = _SLUG_RE.sub("-", stem).strip("-_")[:64]
    return slug if slug and _ID_RE.fullmatch(slug) else ""


def _sniff_format(data: bytes) -> Optional[str]:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def _finite_float(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if number == number and abs(number) != float("inf") else None


class MbtilesCatalog:
    """Lists raster MBTiles files and serves their tiles in XYZ order."""

    def __init__(self, directories: Iterable[Path] = (), files: Iterable[Path] = ()):
        self.directories = [Path(directory).expanduser() for directory in directories]
        self.files = [Path(path).expanduser() for path in files]
        self._lock = threading.Lock()
        self._entries: Dict[str, Dict[str, Any]] = {}

    def _open(self, path: Path) -> sqlite3.Connection:
        # mode=ro keeps a stray write from ever touching the tile file.
        db = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=5, check_same_thread=False)
        db.row_factory = sqlite3.Row
        return db

    def _describe(self, path: Path) -> Optional[Dict[str, Any]]:
        try:
            db = self._open(path)
        except sqlite3.Error:
            return None
        try:
            metadata = {str(row["name"]): str(row["value"]) for row in db.execute("SELECT name,value FROM metadata")}
            sample = db.execute("SELECT tile_data FROM tiles LIMIT 1").fetchone()
            declared_zooms = (_finite_float(metadata.get("minzoom")), _finite_float(metadata.get("maxzoom")))
            # Prefer the declared range; scanning a large tile table is slow.
            zooms = declared_zooms if None not in declared_zooms else db.execute("SELECT MIN(zoom_level),MAX(zoom_level) FROM tiles").fetchone()
        except sqlite3.Error:
            return None
        finally:
            db.close()
        declared = metadata.get("format", "").strip().lower()
        tile_format = declared if declared in RASTER_FORMATS else (_sniff_format(bytes(sample[0])) if sample else None)
        if tile_format is None:
            # Vector tiles (pbf) need a style and glyphs the console does not ship.
            return None
        minzoom = int(zooms[0]) if zooms and zooms[0] is not None else 0
        maxzoom = int(zooms[1]) if zooms and zooms[1] is not None else minzoom
        bounds = None
        parts = [_finite_float(part) for part in metadata.get("bounds", "").split(",")]
        if len(parts) == 4 and all(part is not None for part in parts):
            west, south, east, north = parts  # type: ignore[misc]
            if -180 <= west < east <= 180 and -90 <= south < north <= 90:
                bounds = [west, south, east, north]
        name = metadata.get("name", "").strip()[:80] or path.stem[:80]
        return {
            "name": name,
            "format": tile_format,
            "minzoom": max(0, min(MAX_TILE_ZOOM, minzoom)),
            "maxzoom": max(0, min(MAX_TILE_ZOOM, maxzoom)),
            "bounds": bounds,
            "attribution": metadata.get("attribution", "").strip()[:300],
            "path": path.resolve(),
        }

    def _candidates(self) -> List[Path]:
        paths: List[Path] = []
        for directory in self.directories:
            if directory.is_dir():
                paths.extend(sorted(path for path in directory.glob("*.mbtiles") if path.is_file()))
        paths.extend(path for path in self.files if path.is_file() and path.suffix.lower() == ".mbtiles")
        return paths

    def refresh(self) -> List[Dict[str, Any]]:
        entries: Dict[str, Dict[str, Any]] = {}
        seen = set()
        for path in self._candidates():
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            slug = _slug(path.stem)
            if not slug:
                continue
            description = self._describe(path)
            if description is None:
                continue
            ident, counter = slug, 2
            while ident in entries:
                ident = f"{slug[:60]}-{counter}"
                counter += 1
            entries[ident] = description
        with self._lock:
            self._entries = entries
        return self.list(refresh=False)

    def list(self, refresh: bool = True) -> List[Dict[str, Any]]:
        if refresh:
            return self.refresh()
        with self._lock:
            entries = dict(self._entries)
        return [
            {key: value for key, value in entry.items() if key != "path"} | {"id": ident}
            for ident, entry in sorted(entries.items(), key=lambda item: item[1]["name"].lower())
        ]

    def tile(self, ident: str, z: int, x: int, y: int) -> Optional[Tuple[bytes, str]]:
        """Return one tile in XYZ addressing, or None when it is not stored."""
        if not isinstance(ident, str) or not _ID_RE.fullmatch(ident):
            raise ValueError("invalid tile set id")
        if not (0 <= z <= MAX_TILE_ZOOM) or not (0 <= x < 2 ** z) or not (0 <= y < 2 ** z):
            raise ValueError("tile coordinates are out of range")
        with self._lock:
            entry = self._entries.get(ident)
        if entry is None:
            self.refresh()
            with self._lock:
                entry = self._entries.get(ident)
        if entry is None:
            raise KeyError("tile set not found")
        db = self._open(entry["path"])
        try:
            # MBTiles stores rows in TMS order (origin at the bottom).
            row = db.execute(
                "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                (z, x, (2 ** z - 1) - y),
            ).fetchone()
        finally:
            db.close()
        if row is None:
            return None
        return bytes(row[0]), RASTER_FORMATS[entry["format"]]

