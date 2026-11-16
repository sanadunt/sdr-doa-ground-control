"""Restart and Shutdown of the console's own host, as a request file.

``POST /api/host/power`` (the loopback listener only; the LAN view's one
write is a marker command, and it refuses this route) writes one file named ``request`` holding exactly ``reboot`` or
``poweroff`` into the request directory, atomically: the bytes go to a
temporary name first and are hard-linked into place, so the host never sees
a partial word and a second request cannot replace one the host has not taken
yet (409 ``HOST_POWER_PENDING``).

The console runs nothing on the host. The host side (``packaging/host-power``)
owns the rest: a tmpfiles.d rule creates the directory for the console's user
and puts the ``helper`` marker in it, a systemd ``.path`` unit sees the
request, and a root oneshot service takes only those two words, deletes the
request, refuses a repeat within a short window and runs ``systemctl reboot``
or ``systemctl poweroff``. Without that host side the directory is missing,
not writable for the console (Docker creates an empty root-owned one for the
bind mount) or has no marker, and the route answers 503
``HOST_POWER_UNAVAILABLE`` with the reason the top bar shows. In a container
without the directory the reason is ``DIR_NOT_MOUNTED``: its ``compose.yml``
predates the mount, and ``sdr-doa-docker update`` never rewrites that file
nor replaces the installed script, so the 3.3.0 script is installed first
and its ``install`` run once.

Docker bind-mounts the host's ``/run/sdr-doa-host-power`` at the same path;
a native console reads it directly. Stdlib only.

The Configuration page's Update (``POST /api/host/update``, the owner's
decision of 2026-11-16) uses the same directory: the request holds ``update``,
and the helper starts ``sdr-doa-host-power-update.service``, which runs the
host's ``sdr-doa-docker update --dir DIR --yes`` apart from this container
(the update restarts it). That only works where the installer found the
console's sdr-doa-docker install; it then puts the ``update-helper`` marker
next to ``helper``. The helper keeps ``update-status`` current (a root-owned
file linked into the directory), which ``GET /api/host/update`` reads back
for the page. A native console has no update here: ``NOT_DOCKER``
(``sdr-doa-console update`` updates it).
"""

from __future__ import annotations

import json
import os
import re
import stat
import tempfile
import time
from http import HTTPStatus
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

ROUTE = "/api/host/power"
DEFAULT_DIR = "/run/sdr-doa-host-power"
REQUEST_NAME = "request"
# Written by the host side's tmpfiles.d rule, never by the console.
HELPER_NAME = "helper"
ACTIONS = ("reboot", "poweroff")
MAX_BODY_BYTES = 256

UPDATE_ROUTE = "/api/host/update"
UPDATE_WORD = "update"
# Written by the host side's tmpfiles.d rule where it found the sdr-doa-docker install.
UPDATE_HELPER_NAME = "update-helper"
# Written by the helper (root-owned, linked into the directory); read here.
UPDATE_STATUS_NAME = "update-status"
UPDATE_MAX_BODY_BYTES = 64
UPDATE_STATUS_MAX_BYTES = 4096
# The helper's states: queued and running while an update is on its way.
UPDATE_STATES = ("queued", "running", "ok", "up_to_date", "not_updated", "rolled_back", "failed", "dry_run")
UPDATE_RUNNING_STATES = ("queued", "running")
UPDATE_PHASES = ("preparing", "pulling", "starting", "rolling_back")
# The update unit stops at 45 min; a queued or running state older than this
# was cut short (a reboot in between, a killed unit) and blocks nothing.
UPDATE_STALE_S = 3600
UPDATE_MESSAGE_MAX = 300

# Why the buttons are disabled; the top bar names each one.
NOT_CONFIGURED = "NOT_CONFIGURED"
DIR_NOT_MOUNTED = "DIR_NOT_MOUNTED"
DIR_MISSING = "DIR_MISSING"
DIR_NOT_WRITABLE = "DIR_NOT_WRITABLE"
HELPER_MISSING = "HELPER_MISSING"
REASONS = (NOT_CONFIGURED, DIR_NOT_MOUNTED, DIR_MISSING, DIR_NOT_WRITABLE, HELPER_MISSING)
# Why Update is disabled: those, a console outside Docker, or a host side
# without the update (an older packaging/host-power, or no sdr-doa-docker install).
NOT_DOCKER = "NOT_DOCKER"
UPDATE_HELPER_MISSING = "UPDATE_HELPER_MISSING"
UPDATE_REASONS = REASONS + (NOT_DOCKER, UPDATE_HELPER_MISSING)
# What a container runtime puts in every container (Docker, Podman).
CONTAINER_MARKERS = ("/.dockerenv", "/run/.containerenv")

ORIGIN_REJECTED = "ORIGIN_REJECTED"
HOST_POWER_INVALID = "HOST_POWER_INVALID"
HOST_POWER_TOO_LARGE = "HOST_POWER_TOO_LARGE"
HOST_POWER_CONFIRM_REQUIRED = "HOST_POWER_CONFIRM_REQUIRED"
HOST_POWER_UNAVAILABLE = "HOST_POWER_UNAVAILABLE"
HOST_POWER_PENDING = "HOST_POWER_PENDING"
HOST_POWER_WRITE_FAILED = "HOST_POWER_WRITE_FAILED"
HOST_UPDATE_INVALID = "HOST_UPDATE_INVALID"
HOST_UPDATE_TOO_LARGE = "HOST_UPDATE_TOO_LARGE"
HOST_UPDATE_CONFIRM_REQUIRED = "HOST_UPDATE_CONFIRM_REQUIRED"
HOST_UPDATE_UNAVAILABLE = "HOST_UPDATE_UNAVAILABLE"
HOST_UPDATE_PENDING = "HOST_UPDATE_PENDING"
HOST_UPDATE_RUNNING = "HOST_UPDATE_RUNNING"
HOST_UPDATE_WRITE_FAILED = "HOST_UPDATE_WRITE_FAILED"
POWER_ERROR_CODES = (
    ORIGIN_REJECTED, HOST_POWER_INVALID, HOST_POWER_TOO_LARGE, HOST_POWER_CONFIRM_REQUIRED, HOST_POWER_UNAVAILABLE,
    HOST_POWER_PENDING, HOST_POWER_WRITE_FAILED,
)
UPDATE_ERROR_CODES = (
    ORIGIN_REJECTED, HOST_UPDATE_INVALID, HOST_UPDATE_TOO_LARGE, HOST_UPDATE_CONFIRM_REQUIRED, HOST_UPDATE_UNAVAILABLE,
    HOST_UPDATE_PENDING, HOST_UPDATE_RUNNING, HOST_UPDATE_WRITE_FAILED,
)
ERROR_CODES_HTTP: Dict[str, int] = {
    ORIGIN_REJECTED: HTTPStatus.FORBIDDEN,
    HOST_POWER_INVALID: HTTPStatus.BAD_REQUEST,
    HOST_POWER_TOO_LARGE: HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
    HOST_POWER_CONFIRM_REQUIRED: HTTPStatus.BAD_REQUEST,
    HOST_POWER_UNAVAILABLE: HTTPStatus.SERVICE_UNAVAILABLE,
    HOST_POWER_PENDING: HTTPStatus.CONFLICT,
    HOST_POWER_WRITE_FAILED: HTTPStatus.INTERNAL_SERVER_ERROR,
    HOST_UPDATE_INVALID: HTTPStatus.BAD_REQUEST,
    HOST_UPDATE_TOO_LARGE: HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
    HOST_UPDATE_CONFIRM_REQUIRED: HTTPStatus.BAD_REQUEST,
    HOST_UPDATE_UNAVAILABLE: HTTPStatus.SERVICE_UNAVAILABLE,
    HOST_UPDATE_PENDING: HTTPStatus.CONFLICT,
    HOST_UPDATE_RUNNING: HTTPStatus.CONFLICT,
    HOST_UPDATE_WRITE_FAILED: HTTPStatus.INTERNAL_SERVER_ERROR,
}

UNAVAILABLE_MESSAGES = {
    NOT_CONFIGURED: "host power requests are off in this console (--host-power-dir is empty)",
    DIR_NOT_MOUNTED: (
        "the request directory is not mounted into this container: install the sdr-doa-docker script of 3.3.0 "
        "or later (sdr-doa-docker update replaces neither itself nor compose.yml), then run its install once"
    ),
    DIR_MISSING: "the host power request directory is missing; install packaging/host-power on the host",
    DIR_NOT_WRITABLE: "the console cannot write the host power request directory; install packaging/host-power on the host for this console's user",
    HELPER_MISSING: "the host power helper is not installed on the host (packaging/host-power)",
    NOT_DOCKER: "this console does not run from sdr-doa-docker; update it with sdr-doa-console update",
    UPDATE_HELPER_MISSING: (
        "the host helper has no update: install packaging/host-power of 3.23.0 or later on the host "
        "(it sets the update up where it finds the sdr-doa-docker install)"
    ),
}


class HostPowerRejected(Exception):
    """A refused request: its code, the operator text and extra body fields."""

    def __init__(self, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.extra = extra


def _no_duplicates(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise HostPowerRejected(HOST_POWER_INVALID, f"the body names {key!r} twice")
        result[key] = value
    return result


def decode_request(raw: bytes) -> str:
    """The action of a POST body ``{"action": "reboot"|"poweroff", "confirm": true}``.

    Strict: UTF-8 JSON, one object, exactly those two keys, the action one of
    ACTIONS and confirm the JSON true (not 1 or "true").
    """
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_no_duplicates)
    except HostPowerRejected:
        raise
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise HostPowerRejected(HOST_POWER_INVALID, "the body must be a JSON object") from None
    if not isinstance(value, dict):
        raise HostPowerRejected(HOST_POWER_INVALID, "the body must be a JSON object")
    unknown = sorted(set(value) - {"action", "confirm"})
    if unknown:
        raise HostPowerRejected(HOST_POWER_INVALID, f"unknown field {unknown[0]!r}")
    action = value.get("action")
    if action not in ACTIONS:
        raise HostPowerRejected(HOST_POWER_INVALID, "action must be reboot or poweroff")
    if value.get("confirm") is not True:
        raise HostPowerRejected(HOST_POWER_CONFIRM_REQUIRED, "a host power request needs confirm: true")
    return str(action)


def decode_update_request(raw: bytes) -> None:
    """A POST /api/host/update body: exactly ``{"confirm": true}``."""
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_no_duplicates)
    except HostPowerRejected as exc:
        raise HostPowerRejected(HOST_UPDATE_INVALID, exc.message) from None
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise HostPowerRejected(HOST_UPDATE_INVALID, "the body must be a JSON object") from None
    if not isinstance(value, dict):
        raise HostPowerRejected(HOST_UPDATE_INVALID, "the body must be a JSON object")
    unknown = sorted(set(value) - {"confirm"})
    if unknown:
        raise HostPowerRejected(HOST_UPDATE_INVALID, f"unknown field {unknown[0]!r}")
    if value.get("confirm") is not True:
        raise HostPowerRejected(HOST_UPDATE_CONFIRM_REQUIRED, "an update request needs confirm: true")


_VERSION_RE = re.compile(r"^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(?:-[0-9A-Za-z.-]{1,40})?$")
_SECONDS_RE = re.compile(r"^[0-9]{1,12}$")
_PRINTABLE_RE = re.compile(r"^[\x20-\x7e]*$")


def parse_update_status(text: str, now_s: float) -> Optional[Dict[str, Any]]:
    """The helper's update-status (KEY=VALUE lines); None for anything else.

    Read leniently: an unknown key is skipped, a bad time, version or message
    reads as null; only the state must be one of UPDATE_STATES.
    """
    values: Dict[str, str] = {}
    for line in text.splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key in ("STATE", "PHASE", "QUEUED", "STARTED", "FINISHED", "TO", "MESSAGE") and key not in values:
            values[key] = value
    state = values.get("STATE")
    if state not in UPDATE_STATES:
        return None

    def seconds(key: str) -> Optional[int]:
        value = values.get(key, "")
        return int(value) if _SECONDS_RE.match(value) else None

    queued, started, finished = seconds("QUEUED"), seconds("STARTED"), seconds("FINISHED")
    phase = values.get("PHASE")
    to = values.get("TO", "")
    message = values.get("MESSAGE", "")
    since = max((value for value in (queued, started) if value is not None), default=None)
    running = state in UPDATE_RUNNING_STATES
    return {
        "state": state,
        "phase": phase if running and phase in UPDATE_PHASES else None,
        "queued_at_ms": queued * 1000 if queued is not None else None,
        "started_at_ms": started * 1000 if started is not None else None,
        "finished_at_ms": finished * 1000 if finished is not None else None,
        "to": to if _VERSION_RE.match(to) else None,
        "message": message if message and len(message) <= UPDATE_MESSAGE_MAX and _PRINTABLE_RE.match(message) else None,
        # A queued or running state that outlived the update unit's timeout.
        "stale": running and (since is None or now_s - since > UPDATE_STALE_S),
    }


def running_in_container(markers: Tuple[str, ...] = CONTAINER_MARKERS) -> bool:
    return any(os.path.exists(marker) for marker in markers)


class HostPower:
    """The request directory of one console; ``None`` turns requests off."""

    def __init__(self, directory: Optional[Path], clock: Any = time.time, in_container: Optional[bool] = None) -> None:
        self.directory = Path(directory) if directory is not None else None
        self._clock = clock
        # A missing directory in a container is a missing bind mount.
        self.in_container = running_in_container() if in_container is None else in_container

    def status(self) -> Dict[str, Any]:
        """Whether a request can be written now, and if not why (REASONS)."""
        reason = self._unavailable_reason()
        return {"available": reason is None, "reason": reason, "actions": list(ACTIONS)}

    def _unavailable_reason(self) -> Optional[str]:
        directory = self.directory
        if directory is None:
            return NOT_CONFIGURED
        if not directory.is_dir():
            return DIR_NOT_MOUNTED if self.in_container else DIR_MISSING
        if not os.access(directory, os.W_OK | os.X_OK):
            return DIR_NOT_WRITABLE
        if not (directory / HELPER_NAME).is_file():
            return HELPER_MISSING
        return None

    def request(self, action: str) -> Dict[str, Any]:
        """Write the request for ``action``; raises HostPowerRejected."""
        if action not in ACTIONS:
            raise HostPowerRejected(HOST_POWER_INVALID, "action must be reboot or poweroff")
        reason = self._unavailable_reason()
        if reason is not None or self.directory is None:
            raise HostPowerRejected(HOST_POWER_UNAVAILABLE, UNAVAILABLE_MESSAGES[reason or NOT_CONFIGURED], reason=reason)
        self._write_request(action, HOST_POWER_PENDING, HOST_POWER_WRITE_FAILED)
        return {"action": action, "requested_at_ms": int(self._clock() * 1000)}

    # --- Update -------------------------------------------------------------

    def _update_unavailable_reason(self) -> Optional[str]:
        if self.directory is None:
            return NOT_CONFIGURED
        # The host's update runs sdr-doa-docker; a native console is not that install.
        if not self.in_container:
            return NOT_DOCKER
        reason = self._unavailable_reason()
        if reason is not None:
            return reason
        if not (self.directory / UPDATE_HELPER_NAME).is_file():
            return UPDATE_HELPER_MISSING
        return None

    def read_update_status(self) -> Optional[Dict[str, Any]]:
        """The helper's update-status, or None when there is none (yet) or it cannot be read."""
        if self.directory is None:
            return None
        path = self.directory / UPDATE_STATUS_NAME
        try:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
            handle = os.open(str(path), flags)
        except OSError:
            return None
        try:
            if not stat.S_ISREG(os.fstat(handle).st_mode):
                return None
            raw = os.read(handle, UPDATE_STATUS_MAX_BYTES + 1)
        except OSError:
            return None
        finally:
            os.close(handle)
        if len(raw) > UPDATE_STATUS_MAX_BYTES:
            return None
        return parse_update_status(raw.decode("ascii", errors="replace"), self._clock())

    def update_status(self) -> Dict[str, Any]:
        """Whether Update can be asked for now (and if not why), and the last update's state."""
        reason = self._update_unavailable_reason()
        return {"available": reason is None, "reason": reason, "status": self.read_update_status()}

    def request_update(self) -> Dict[str, Any]:
        """Write the update request; raises HostPowerRejected."""
        reason = self._update_unavailable_reason()
        if reason is not None or self.directory is None:
            raise HostPowerRejected(HOST_UPDATE_UNAVAILABLE, UNAVAILABLE_MESSAGES[reason or NOT_CONFIGURED], reason=reason)
        status = self.read_update_status()
        if status is not None and status["state"] in UPDATE_RUNNING_STATES and not status["stale"]:
            raise HostPowerRejected(HOST_UPDATE_RUNNING, "an update is already on its way; its state is in GET /api/host/update")
        self._write_request(UPDATE_WORD, HOST_UPDATE_PENDING, HOST_UPDATE_WRITE_FAILED)
        return {"requested_at_ms": int(self._clock() * 1000)}

    def _write_request(self, word: str, pending: str, failed: str) -> None:
        assert self.directory is not None
        target = self.directory / REQUEST_NAME
        temporary: Optional[str] = None
        try:
            # Created 0600 and named apart from the request, so the .path unit
            # never sees it; the link below makes the whole word appear at once.
            handle, temporary = tempfile.mkstemp(prefix=".request-", suffix=".tmp", dir=str(self.directory))
            with os.fdopen(handle, "wb") as stream:
                stream.write(word.encode("ascii"))
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o644)
            try:
                os.link(temporary, target)
            except FileExistsError:
                raise HostPowerRejected(
                    pending,
                    "the host has not taken the previous request yet; see journalctl -t sdr-doa-host-power on the host",
                ) from None
        except HostPowerRejected:
            raise
        except OSError as exc:
            raise HostPowerRejected(failed, f"the request could not be written ({type(exc).__name__})") from None
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
