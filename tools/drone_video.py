#!/usr/bin/env python3
"""The drone camera through the host's video service (packaging/drone-video).

The service runs mediamtx on the groundstation host, outside Docker: path
``raw`` pulls the drone camera from the remote over RTSP/TCP, path ``drone``
is ffmpeg's H.264 of it for browsers over WebRTC (WHEP on :8889, media on UDP
8189). The console never talks to the camera itself; it

- reads the service's health from mediamtx's API on 127.0.0.1:9997
  (``video_health``), and
- proxies WHEP same-origin (``whep_offer``, ``whep_delete``), so the page's
  CSP stays ``connect-src 'self'`` and a LAN tablet needs only the console's
  address. The media still flows straight from the host on UDP 8189.

Both read the drone's picture only; nothing reaches the drone, the remote or
the RDF-SDR. stdlib only; no environment proxy is used for these loopback calls.
"""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional, Tuple

DEFAULT_API = "http://127.0.0.1:9997"
DEFAULT_WHEP_UPSTREAM = "http://127.0.0.1:8889"
VIDEO_PATH = "drone"
RAW_PATH = "raw"
WHEP_ROUTE = "/api/drone/video/whep"
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
MAX_SDP_BYTES = 64 * 1024
MAX_API_BYTES = 256 * 1024
TIMEOUT_S = 3.0
# With PULL=on-demand the camera and then ffmpeg start only when an offer comes
# (mediamtx waits up to runOnDemandStartTimeout, 20 s), so the offer waits longer.
WHEP_OFFER_TIMEOUT_S = 25.0
HEALTH_CACHE_S = 1.0

# STANDBY: the service pulls the camera only while someone watches (PULL=on-demand)
# and nobody does, so nothing is ready and that is no fault.
STATES = ("OK", "STANDBY", "NO_CAMERA", "NO_ENCODER", "DOWN", "DISABLED")
# Error codes of the video routes (sent outside the Kontrol code contract).
VIDEO_DISABLED = "DRONE_VIDEO_DISABLED"
VIDEO_UNAVAILABLE = "DRONE_VIDEO_UNAVAILABLE"
VIDEO_NO_STREAM = "DRONE_VIDEO_NO_STREAM"
VIDEO_INVALID = "DRONE_VIDEO_INVALID"
VIDEO_TOO_LARGE = "DRONE_VIDEO_TOO_LARGE"
VIDEO_UNKNOWN_SESSION = "DRONE_VIDEO_UNKNOWN_SESSION"
ORIGIN_REJECTED = "ORIGIN_REJECTED"
ERROR_CODES = (VIDEO_DISABLED, VIDEO_UNAVAILABLE, VIDEO_NO_STREAM, VIDEO_INVALID, VIDEO_TOO_LARGE, VIDEO_UNKNOWN_SESSION, ORIGIN_REJECTED)

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class VideoError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def _path_item(items: Any, name: str) -> Optional[Dict[str, Any]]:
    if not isinstance(items, list):
        return None
    for item in items:
        if isinstance(item, dict) and item.get("name") == name:
            return item
    return None


def _count(value: Any) -> Optional[int]:
    return value if type(value) is int and value >= 0 else None


def health_from_paths(body: Any, on_demand: bool = False) -> Dict[str, Any]:
    """The service's state from mediamtx's ``/v3/paths/list`` answer.

    ``on_demand``: the video path runs ffmpeg only while it has readers
    (runOnDemand), so an idle path with no reader is STANDBY.
    """
    items = body.get("items") if isinstance(body, dict) else None
    raw = _path_item(items, RAW_PATH)
    drone = _path_item(items, VIDEO_PATH)
    camera_ready = bool(raw and raw.get("ready") is True)
    video_ready = bool(drone and drone.get("ready") is True)
    watched = bool(drone and isinstance(drone.get("readers"), list) and drone["readers"])
    if on_demand and not video_ready and not watched:
        state = "STANDBY"
    elif not camera_ready:
        state = "NO_CAMERA"
    elif not video_ready:
        state = "NO_ENCODER"
    else:
        state = "OK"
    readers = drone.get("readers") if drone else None
    tracks = drone.get("tracks") if drone else None
    return {
        "state": state,
        "on_demand": on_demand,
        "camera_ready": camera_ready,
        "video_ready": video_ready,
        "camera_bytes": _count(raw.get("bytesReceived")) if raw else None,
        "video_bytes": _count(drone.get("bytesReceived")) if drone else None,
        "readers": len(readers) if isinstance(readers, list) else None,
        "tracks": [str(track)[:32] for track in tracks[:4]] if isinstance(tracks, list) else [],
    }


class VideoService:
    """Health and WHEP proxy of one host video service; None URLs turn it off (tests, no service)."""

    def __init__(
        self,
        api: Optional[str] = None,
        whep_upstream: Optional[str] = None,
        *,
        opener: Any = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.api = api.rstrip("/") if api else None
        self.whep_upstream = whep_upstream.rstrip("/") if whep_upstream else None
        self._opener = opener or _OPENER
        self._clock = clock
        self._lock = threading.Lock()
        self._cached: Optional[Tuple[float, Dict[str, Any]]] = None

    @property
    def configured(self) -> bool:
        return self.api is not None and self.whep_upstream is not None

    def _path_config(self, name: str) -> Optional[Dict[str, Any]]:
        """mediamtx's configuration of one path, or None (an older mediamtx, no answer)."""
        try:
            with self._opener.open(f"{self.api}/v3/config/paths/get/{name}", timeout=TIMEOUT_S) as response:
                raw = response.read(MAX_API_BYTES + 1)
            config = json.loads(raw.decode("utf-8")) if len(raw) <= MAX_API_BYTES else None
        except (OSError, ValueError, urllib.error.URLError):
            return None
        return config if isinstance(config, dict) else None

    def _on_demand(self) -> bool:
        """Whether the video path runs ffmpeg on demand (the supervisor's PULL=on-demand)."""
        config = self._path_config(VIDEO_PATH)
        return config is not None and isinstance(config.get("runOnDemand"), str) and bool(config["runOnDemand"].strip())

    def _camera_unknown(self) -> bool:
        """The supervisor knows no camera yet (CAMERA_URL=auto before the console found the remote)."""
        config = self._path_config(RAW_PATH)
        return config is not None and config.get("source") in (None, "", "publisher")

    def health(self, enabled: bool = True) -> Dict[str, Any]:
        """GET /api/drone/video: the service's state, read at most once a second."""
        if not enabled or not self.configured:
            return {
                "state": "DISABLED",
                "reason": "TURNED_OFF" if not enabled else "NOT_CONFIGURED",
                "on_demand": False, "camera_ready": False, "video_ready": False, "camera_bytes": None, "video_bytes": None,
                "readers": None, "tracks": [], "error": None,
            }
        now = self._clock()
        with self._lock:
            if self._cached is not None and now - self._cached[0] < HEALTH_CACHE_S:
                return dict(self._cached[1])
        try:
            with self._opener.open(f"{self.api}/v3/paths/list", timeout=TIMEOUT_S) as response:
                raw = response.read(MAX_API_BYTES + 1)
            if len(raw) > MAX_API_BYTES:
                raise ValueError("answer too large")
            view = health_from_paths(json.loads(raw.decode("utf-8")), self._on_demand())
            view.update({"reason": None, "error": None})
            if view["state"] == "STANDBY" and self._camera_unknown():
                # No remote found yet: an offer would only start ffmpeg on a camera that is not there.
                view.update(state="NO_CAMERA", reason="CAMERA_UNKNOWN")
        except (OSError, ValueError, urllib.error.URLError) as exc:
            view = {
                "state": "DOWN", "reason": "SERVICE_UNREACHABLE", "on_demand": False,
                "camera_ready": False, "video_ready": False, "camera_bytes": None, "video_bytes": None,
                "readers": None, "tracks": [], "error": (str(exc) or type(exc).__name__)[:200],
            }
        with self._lock:
            self._cached = (now, view)
        return dict(view)

    def _require(self) -> str:
        if self.whep_upstream is None:
            raise VideoError(503, VIDEO_DISABLED, "the drone video service is not configured on this console")
        return self.whep_upstream

    def whep_offer(self, sdp: bytes) -> Tuple[int, bytes, Dict[str, str]]:
        """POST an SDP offer to the service; the answer, its status and the headers to pass on."""
        upstream = self._require()
        if not sdp or len(sdp) > MAX_SDP_BYTES:
            raise VideoError(413 if sdp else 400, VIDEO_TOO_LARGE if sdp else VIDEO_INVALID, "the offer must be 1 byte to 64 KiB of SDP")
        try:
            text = sdp.decode("utf-8")
        except UnicodeDecodeError:
            raise VideoError(400, VIDEO_INVALID, "the offer is not UTF-8 SDP") from None
        if not text.startswith("v=0"):
            raise VideoError(400, VIDEO_INVALID, "the offer is not SDP")
        request = urllib.request.Request(
            f"{upstream}/{VIDEO_PATH}/whep",
            data=sdp,
            method="POST",
            headers={"Content-Type": "application/sdp"},
        )
        try:
            with self._opener.open(request, timeout=WHEP_OFFER_TIMEOUT_S) as response:
                status = response.status
                body = response.read(MAX_SDP_BYTES + 1)
                location = response.headers.get("Location") or ""
                etag = response.headers.get("ETag")
        except urllib.error.HTTPError as exc:
            if exc.code in (400, 404):
                # mediamtx answers 404 while the path has no stream yet.
                raise VideoError(503, VIDEO_NO_STREAM, "the drone video has no picture yet (camera or encoder not ready)") from None
            raise VideoError(502, VIDEO_UNAVAILABLE, f"the video service answered {exc.code}") from None
        except (OSError, urllib.error.URLError):
            raise VideoError(502, VIDEO_UNAVAILABLE, "the drone video service does not answer") from None
        if len(body) > MAX_SDP_BYTES:
            raise VideoError(502, VIDEO_UNAVAILABLE, "the video service's answer is too large")
        session = location.rstrip("/").rsplit("/", 1)[-1] if location else ""
        headers = {"Content-Type": "application/sdp"}
        if SESSION_ID_RE.fullmatch(session):
            headers["Location"] = f"{WHEP_ROUTE}/{session}"
        if etag:
            headers["ETag"] = etag[:128]
        return status, body, headers

    def whep_delete(self, session: str) -> int:
        """End one WHEP session (the page closed its player)."""
        upstream = self._require()
        if SESSION_ID_RE.fullmatch(session) is None:
            raise VideoError(400, VIDEO_UNKNOWN_SESSION, "unknown video session")
        request = urllib.request.Request(f"{upstream}/{VIDEO_PATH}/whep/{session}", method="DELETE")
        try:
            with self._opener.open(request, timeout=TIMEOUT_S) as response:
                return response.status
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise VideoError(404, VIDEO_UNKNOWN_SESSION, "unknown video session") from None
            raise VideoError(502, VIDEO_UNAVAILABLE, f"the video service answered {exc.code}") from None
        except (OSError, urllib.error.URLError):
            raise VideoError(502, VIDEO_UNAVAILABLE, "the drone video service does not answer") from None


__all__ = [
    "DEFAULT_API",
    "DEFAULT_WHEP_UPSTREAM",
    "ERROR_CODES",
    "MAX_SDP_BYTES",
    "VideoError",
    "VideoService",
    "WHEP_ROUTE",
    "health_from_paths",
]
