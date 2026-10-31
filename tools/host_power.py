"""Restart and Shutdown of the console's own host, as a request file.

``POST /api/host/power`` (the loopback listener only; the LAN view answers
no write) writes one file named ``request`` holding exactly ``reboot`` or
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
``HOST_POWER_UNAVAILABLE`` with the reason the top bar shows.

Docker bind-mounts the host's ``/run/sdr-doa-host-power`` at the same path;
a native console reads it directly. Stdlib only.
"""

from __future__ import annotations

import json
import os
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

# Why the buttons are disabled; the top bar names each one.
NOT_CONFIGURED = "NOT_CONFIGURED"
DIR_MISSING = "DIR_MISSING"
DIR_NOT_WRITABLE = "DIR_NOT_WRITABLE"
HELPER_MISSING = "HELPER_MISSING"
REASONS = (NOT_CONFIGURED, DIR_MISSING, DIR_NOT_WRITABLE, HELPER_MISSING)

ORIGIN_REJECTED = "ORIGIN_REJECTED"
HOST_POWER_INVALID = "HOST_POWER_INVALID"
HOST_POWER_TOO_LARGE = "HOST_POWER_TOO_LARGE"
HOST_POWER_CONFIRM_REQUIRED = "HOST_POWER_CONFIRM_REQUIRED"
HOST_POWER_UNAVAILABLE = "HOST_POWER_UNAVAILABLE"
HOST_POWER_PENDING = "HOST_POWER_PENDING"
HOST_POWER_WRITE_FAILED = "HOST_POWER_WRITE_FAILED"
ERROR_CODES_HTTP: Dict[str, int] = {
    ORIGIN_REJECTED: HTTPStatus.FORBIDDEN,
    HOST_POWER_INVALID: HTTPStatus.BAD_REQUEST,
    HOST_POWER_TOO_LARGE: HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
    HOST_POWER_CONFIRM_REQUIRED: HTTPStatus.BAD_REQUEST,
    HOST_POWER_UNAVAILABLE: HTTPStatus.SERVICE_UNAVAILABLE,
    HOST_POWER_PENDING: HTTPStatus.CONFLICT,
    HOST_POWER_WRITE_FAILED: HTTPStatus.INTERNAL_SERVER_ERROR,
}

UNAVAILABLE_MESSAGES = {
    NOT_CONFIGURED: "host power requests are off in this console (--host-power-dir is empty)",
    DIR_MISSING: "the host power request directory is missing; install packaging/host-power on the host",
    DIR_NOT_WRITABLE: "the console cannot write the host power request directory; install packaging/host-power on the host for this console's user",
    HELPER_MISSING: "the host power helper is not installed on the host (packaging/host-power)",
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


class HostPower:
    """The request directory of one console; ``None`` turns requests off."""

    def __init__(self, directory: Optional[Path], clock: Any = time.time) -> None:
        self.directory = Path(directory) if directory is not None else None
        self._clock = clock

    def status(self) -> Dict[str, Any]:
        """Whether a request can be written now, and if not why (REASONS)."""
        reason = self._unavailable_reason()
        return {"available": reason is None, "reason": reason, "actions": list(ACTIONS)}

    def _unavailable_reason(self) -> Optional[str]:
        directory = self.directory
        if directory is None:
            return NOT_CONFIGURED
        if not directory.is_dir():
            return DIR_MISSING
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
        target = self.directory / REQUEST_NAME
        temporary: Optional[str] = None
        try:
            # Created 0600 and named apart from the request, so the .path unit
            # never sees it; the link below makes the whole word appear at once.
            handle, temporary = tempfile.mkstemp(prefix=".request-", suffix=".tmp", dir=str(self.directory))
            with os.fdopen(handle, "wb") as stream:
                stream.write(action.encode("ascii"))
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o644)
            try:
                os.link(temporary, target)
            except FileExistsError:
                raise HostPowerRejected(
                    HOST_POWER_PENDING,
                    "the host has not taken the previous request yet; see journalctl -t sdr-doa-host-power on the host",
                ) from None
        except HostPowerRejected:
            raise
        except OSError as exc:
            raise HostPowerRejected(
                HOST_POWER_WRITE_FAILED, f"the request could not be written ({type(exc).__name__})",
            ) from None
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
        return {"action": action, "requested_at_ms": int(self._clock() * 1000)}
