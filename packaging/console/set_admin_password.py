#!/usr/bin/env python3
"""Set SDR_DOA_ADMIN_PASSWORD in the Ground Console's data-directory .env.

The console reads this file through --env-file. The process environment wins
over the file. When the variable is absent, the default password 123456
applies and the console warns; an empty value disables admin login. The
console reads the password at start, so restart it after a change.

Modes (one of them; without one: --prompt on a terminal, else --stdin):

  --prompt     ask on the terminal: a password, "random", or Enter for 123456
  --stdin      read the password from the first line of standard input
  --generate   create a random password and print it once
  --default    remove the variable, so the default 123456 applies
  --status     print set, default or disabled, and change nothing

The file is rewritten atomically with mode 0600; other lines are kept.
--quiet leaves out the confirmation lines (errors and a generated password
are still printed).
"""

from __future__ import annotations

import argparse
import getpass
import os
import re
import secrets
import sys
import tempfile
from pathlib import Path
from typing import List, Optional

KEY = "SDR_DOA_ADMIN_PASSWORD"
DEFAULT_PASSWORD = "123456"
MAX_LENGTH = 256
_DEFINES_KEY = re.compile(rf"^\s*(?:export\s+)?{KEY}\s*=")
HEADER = """\
# Ground Console settings read with --env-file. Keep this file private (0600).
# SDR_DOA_ADMIN_PASSWORD unlocks admin: branding and the Kontrol config patch.
# Absent: the default password 123456 applies and the console warns.
# Empty (SDR_DOA_ADMIN_PASSWORD=): admin login is disabled.
# The process environment wins over this file. Restart the console after a change.
"""


class PasswordError(Exception):
    pass


def _default_env_file() -> Optional[str]:
    return os.environ.get("SDR_DOA_ENV_FILE") or None


def read_lines(path: Path) -> List[str]:
    try:
        return path.read_text(encoding="utf-8-sig").splitlines()
    except FileNotFoundError:
        return []


def current_value(lines: List[str]) -> Optional[str]:
    """The value the console would read from these lines, or None when absent."""
    value: Optional[str] = None
    for raw in lines:
        line = raw.strip()
        if line.startswith("#") or not _DEFINES_KEY.match(line):
            continue
        value = line.partition("=")[2].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
    return value


def status(path: Path) -> str:
    value = current_value(read_lines(path))
    if value is None or value == DEFAULT_PASSWORD:
        return "default"
    return "disabled" if value == "" else "set"


def validate(password: str) -> str:
    if not password:
        raise PasswordError("the password is empty")
    if any(char in password for char in "\r\n\0"):
        raise PasswordError("the password must be one line")
    if len(password) > MAX_LENGTH:
        raise PasswordError(f"the password is longer than {MAX_LENGTH} characters")
    return password


def write(path: Path, password: Optional[str]) -> None:
    """Replace the variable (None removes it) and keep every other line."""
    lines = read_lines(path)
    kept = [line for line in lines if not _DEFINES_KEY.match(line.strip())] if lines else HEADER.splitlines()
    if password is not None:
        # The console strips one pair of matching outer quotes and nothing else,
        # so a double-quoted value round-trips any one-line password.
        kept.append(f'{KEY}="{password}"')
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write("\n".join(kept) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def prompt() -> Optional[str]:
    """Ask on the terminal. Returns the password, or None for the default."""
    print("Admin password (unlocks branding and the Kontrol config patch).", file=sys.stderr)
    print('Type a password, "random" to generate one, or press Enter for the default 123456.', file=sys.stderr)
    for _ in range(3):
        first = getpass.getpass("Password: ")
        if first == "":
            return None
        if first == "random":
            return generate()
        try:
            validate(first)
        except PasswordError as exc:
            print(f"{exc}; try again", file=sys.stderr)
            continue
        if getpass.getpass("Repeat: ") == first:
            return first
        print("the passwords differ; try again", file=sys.stderr)
    raise PasswordError("no password confirmed")


def generate() -> str:
    password = secrets.token_urlsafe(12)
    print(f"Generated admin password: {password}", file=sys.stderr)
    return password


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Set the Ground Console admin password in its .env file.")
    parser.add_argument("--env-file", default=_default_env_file(), help="the .env passed to ground_console.py --env-file (default: $SDR_DOA_ENV_FILE)")
    mode = parser.add_mutually_exclusive_group()
    for flag in ("prompt", "stdin", "generate", "default", "status"):
        mode.add_argument(f"--{flag}", action="store_const", const=flag, dest="mode")
    parser.add_argument("--quiet", action="store_true", help="no confirmation lines")
    args = parser.parse_args(argv)
    if not args.env_file:
        parser.error("--env-file is required when SDR_DOA_ENV_FILE is not set")
    path = Path(args.env_file).expanduser()
    mode = args.mode or ("prompt" if sys.stdin.isatty() else "stdin")
    try:
        if mode == "status":
            print(status(path))
            return 0
        if mode == "prompt":
            password = prompt()
        elif mode == "stdin":
            password = validate(sys.stdin.readline().rstrip("\r\n"))
        elif mode == "generate":
            password = generate()
        else:
            password = None
        write(path, password)
    except (PasswordError, EOFError, KeyboardInterrupt) as exc:
        print(f"admin password not changed: {exc or 'cancelled'}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"admin password not changed: cannot write {path}: {exc}", file=sys.stderr)
        return 1
    if args.quiet:
        return 0
    if password is None:
        print(f"{path}: no password set; the default 123456 applies (change it before sharing this computer)", file=sys.stderr)
    else:
        print(f"{path}: admin password saved", file=sys.stderr)
    print("Restart the console to apply it.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
