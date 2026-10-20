#!/usr/bin/env python3
"""Update a native Ground Console install from its GitHub release.

``sdr-doa-console update`` and the daily ``sdr-doa-console-update`` timer of
``sdr-doa-console auto-update on`` run this script with the paths install.sh
wrote into the launcher. Commands:

check     compare the installed version with the latest release (or --to)
download  fetch, verify and unpack a release into --dest; installs nothing
apply     check, then download and verify the release, keep a copy of the
          program as APP_DIR.previous, run the release's install.sh with the
          options of the current install, and wait until /api/health reports
          the new version; when it does not within 60 s, put the copy back,
          start it again and exit 1
status    print the result of the last check or update

Requests are anonymous (no token is ever sent, even when GITHUB_TOKEN is set)
and go through the environment proxy: GET {api}/repos/{repo}/releases/latest,
or /releases/tags/v{X.Y.Z} for --to, then SHA256SUMS and the console tarball
from that release's asset URLs. The API is https://api.github.com and the
repository sanadunt/sdr-doa-ground-control unless SDR_DOA_UPDATE_API and
SDR_DOA_UPDATE_REPO say otherwise. Nothing from the download runs before its
SHA-256 matches SHA256SUMS. A latest-release update stays within the
installed major version unless --allow-major is given, never picks a
prerelease, and skips a release that was rolled back here before until a
newer one appears (``--to`` tries it again).

Standard library only, Python 3.9 or newer, Linux.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import http.client
import ipaddress
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Sequence, Tuple

PROG = "sdr-doa-console update"
DEFAULT_API = "https://api.github.com"
DEFAULT_REPO = "sanadunt/sdr-doa-ground-control"
API_ENV = "SDR_DOA_UPDATE_API"
REPO_ENV = "SDR_DOA_UPDATE_REPO"
CONSOLE_ASSET = "sdr-doa-ground-console-{version}-linux.tar.gz"
CONSOLE_TOP = "sdr-doa-ground-console-{version}-linux"
SUMS_ASSET = "SHA256SUMS"
MANIFEST_NAME = "MANIFEST.sha256"
INSTALL_MARKER = ".sdr-doa-console-install"
OPTIONS_NAME = "install-options"
STATE_NAME = "update-state.json"
LOCK_NAME = ".update.lock"
BACKUP_SUFFIX = ".previous"
WORK_PREFIX = ".update-work-"

MIB = 1 << 20
MAX_JSON_BYTES = MIB
MAX_SUMS_BYTES = 64 * 1024
MAX_TARBALL_BYTES = 200 * MIB
MAX_UNPACKED_BYTES = 1024 * MIB
MAX_MEMBERS = 50_000
HTTP_TIMEOUT_S = 20.0
DOWNLOAD_DEADLINE_S = 15 * 60.0
RETRY_DELAY_S = 2.0
HEALTH_TIMEOUT_S = 60.0
HEALTH_POLL_S = 1.0
RESTORE_HEALTH_TIMEOUT_S = 30.0
INSTALL_TIMEOUT_S = 30 * 60.0
LAUNCHER_TIMEOUT_S = 90.0
TRANSIENT_HTTP = frozenset({500, 502, 503, 504})

_IDENT = r"[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*"
VERSION_RE = re.compile(rf"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-({_IDENT}))?(?:\+({_IDENT}))?")
REPO_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+")
SUMS_LINE_RE = re.compile(r"([0-9a-fA-F]{64}) [ *](.+)")
MANIFEST_LINE_RE = re.compile(r"([0-9a-f]{64})  (.+)")
# What install.sh's check_path accepts: absolute, no spaces, quotes or shell characters.
SAFE_PATH_RE = re.compile(r"/[^\s'\"\\`$%|&]*")
PATH_OPTIONS = ("--prefix", "--data-dir", "--bin-dir")
FLAG_OPTIONS = ("--no-service", "--no-desktop")


class UpdateError(Exception):
    """The one-line reason a command stopped."""


def say(text: str = "") -> None:
    print(text, flush=True)


def _size(count: int) -> str:
    if count >= MIB:
        return f"{count / MIB:.1f} MiB"
    return f"{count / 1024:.0f} KiB" if count >= 1024 else f"{count} bytes"


class Version:
    """A semantic version: MAJOR.MINOR.PATCH with an optional -prerelease and +build."""

    __slots__ = ("text", "major", "minor", "patch", "prerelease")

    def __init__(self, text: str, major: int, minor: int, patch: int, prerelease: Tuple[str, ...]):
        self.text = text
        self.major = major
        self.minor = minor
        self.patch = patch
        self.prerelease = prerelease

    @classmethod
    def parse(cls, text: str) -> Optional["Version"]:
        match = VERSION_RE.fullmatch(text.strip())
        if match is None:
            return None
        major, minor, patch, pre, _build = match.groups()
        return cls(match.group(0), int(major), int(minor), int(patch), tuple(pre.split(".")) if pre else ())

    @property
    def is_prerelease(self) -> bool:
        return bool(self.prerelease)

    def _key(self) -> tuple:
        # A release ranks above its prereleases; numeric identifiers below alphanumeric ones.
        if not self.prerelease:
            pre: tuple = (1,)
        else:
            pre = (0,) + tuple((0, int(part), "") if part.isdigit() else (1, 0, part) for part in self.prerelease)
        return (self.major, self.minor, self.patch, pre)

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Version) and self._key() == other._key()

    def __lt__(self, other: "Version") -> bool:
        return self._key() < other._key()

    def __le__(self, other: "Version") -> bool:
        return self._key() <= other._key()

    def __hash__(self) -> int:
        return hash(self._key())

    def __str__(self) -> str:
        return self.text

    def __repr__(self) -> str:
        return f"Version({self.text!r})"


# --- HTTP ---------------------------------------------------------------


def _loopback(host: Optional[str]) -> bool:
    if not host:
        return False
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def checked_url(url: str, what: str) -> str:
    """``url`` when it is https (plain http only on a loopback host) and carries no credentials."""
    try:
        parts = urllib.parse.urlsplit(url)
        host = parts.hostname
        credentials = parts.username is not None or parts.password is not None
    except ValueError:
        raise UpdateError(f"{what} is not a URL: {url!r}") from None
    if not credentials and host and (parts.scheme == "https" or (parts.scheme == "http" and _loopback(host))):
        return url
    raise UpdateError(f"{what} must be an https URL without credentials, not {url!r}")


class _Redirects(urllib.request.HTTPRedirectHandler):
    """Asset downloads redirect to a storage host; follow at most 5, to https only."""

    max_redirections = 5

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102 (urllib API)
        checked_url(newurl, "a redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _reason(exc: BaseException) -> str:
    reason = getattr(exc, "reason", None) or exc
    text = str(reason).strip() or type(reason).__name__
    return "timed out" if isinstance(reason, TimeoutError) or text == "timed out" else text


def _rate_limit_reset(headers) -> Optional[str]:
    now = time.time()
    retry_after = (headers.get("Retry-After") or "").strip()
    reset = (headers.get("X-RateLimit-Reset") or "").strip()
    if retry_after.isdigit():
        at = now + int(retry_after)
    elif reset.isdigit():
        at = float(reset)
    else:
        return None
    minutes = max(0, int((at - now + 59) // 60))
    wait = "in under a minute" if minutes <= 1 else f"in {minutes} min"
    return f"{time.strftime('%H:%M', time.localtime(at))} local time ({wait})"


def http_error(exc: urllib.error.HTTPError, what: str, not_found: Optional[str]) -> UpdateError:
    code = exc.code
    headers = exc.headers if exc.headers is not None else {}
    # GitHub sends X-RateLimit-* on every answer; a 403 is a rate limit only when none remain
    # (primary limit) or it carries Retry-After (secondary limit).
    if code == 429 or code == 403 and (headers.get("X-RateLimit-Remaining") == "0" or headers.get("Retry-After")):
        when = _rate_limit_reset(headers)
        hint = f"; try again after {when}" if when else "; try again later"
        return UpdateError(f"GitHub rate limit reached (HTTP {code}){hint}")
    if code == 403:
        return UpdateError(f"{what}: access refused (HTTP 403)")
    if code == 404:
        return UpdateError(not_found or f"{what} not found (HTTP 404)")
    return UpdateError(f"{what}: HTTP {code} {exc.reason}")


class Client:
    """Anonymous GETs with bounded size, time and one retry on a transient failure."""

    def __init__(self, user_agent: str):
        # ProxyHandler() reads http_proxy/https_proxy/no_proxy from the environment.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler(), _Redirects())
        self.user_agent = user_agent

    def get(
        self,
        url: str,
        *,
        what: str,
        accept: str,
        limit: int,
        not_found: Optional[str] = None,
        destination: Optional[Path] = None,
        deadline_s: Optional[float] = None,
    ) -> Tuple[bytes, str]:
        """Body (empty when written to ``destination``) and its SHA-256."""
        checked_url(url, what)
        host = urllib.parse.urlsplit(url).netloc
        for attempt in (1, 2):
            try:
                return self._get_once(url, what, accept, limit, destination, deadline_s)
            except urllib.error.HTTPError as exc:
                exc.close()
                if exc.code in TRANSIENT_HTTP and attempt == 1:
                    time.sleep(RETRY_DELAY_S)
                    continue
                raise http_error(exc, what, not_found) from None
            except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
                if attempt == 1:
                    time.sleep(RETRY_DELAY_S)
                    continue
                raise UpdateError(f"cannot reach {host}: {_reason(exc)}") from None
        raise AssertionError("unreachable")

    def _get_once(self, url, what, accept, limit, destination, deadline_s) -> Tuple[bytes, str]:
        request = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": self.user_agent})
        started = time.monotonic()
        digest = hashlib.sha256()
        chunks: List[bytes] = []
        received = 0
        with self.opener.open(request, timeout=HTTP_TIMEOUT_S) as response:
            length = (response.headers.get("Content-Length") or "").strip()
            if length.isdigit() and int(length) > limit:
                raise UpdateError(f"{what} is {_size(int(length))}, larger than the limit of {_size(limit)}")
            out = _open_destination(destination, what)
            try:
                while True:
                    block = response.read(64 * 1024)
                    if not block:
                        break
                    received += len(block)
                    if received > limit:
                        raise UpdateError(f"{what} is larger than the limit of {_size(limit)}")
                    if deadline_s is not None and time.monotonic() - started > deadline_s:
                        raise UpdateError(f"{what} took longer than {deadline_s / 60:.0f} minutes to download")
                    digest.update(block)
                    if out is None:
                        chunks.append(block)
                    else:
                        try:
                            out.write(block)
                        except OSError as exc:
                            raise UpdateError(f"cannot write {destination}: {exc.strerror or exc}") from None
            finally:
                if out is not None:
                    out.close()
        return b"".join(chunks), digest.hexdigest()

    def get_json(self, url: str, *, what: str, not_found: str) -> object:
        data, _ = self.get(url, what=what, accept="application/vnd.github+json", limit=MAX_JSON_BYTES, not_found=not_found)
        try:
            return json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise UpdateError(f"{what} is not valid JSON") from None


def _open_destination(destination: Optional[Path], what: str):
    if destination is None:
        return None
    try:
        return open(destination, "wb")
    except OSError as exc:
        raise UpdateError(f"cannot write {destination} for {what}: {exc.strerror or exc}") from None


# --- Releases -----------------------------------------------------------


@dataclass(frozen=True)
class Asset:
    name: str
    url: str
    size: int


@dataclass(frozen=True)
class Release:
    tag: str
    version: Version
    prerelease: bool
    page: str
    published: str
    assets: Dict[str, Asset]

    def asset(self, name: str) -> Asset:
        found = self.assets.get(name)
        if found is None:
            raise UpdateError(f"release {self.tag} has no asset {name}")
        return found

    def label(self) -> str:
        day = self.published[:10]
        return f"{self.version} ({day})" if re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) else str(self.version)


def parse_release(data: object) -> Release:
    if not isinstance(data, dict):
        raise UpdateError("the release answer is not a JSON object")
    tag = data.get("tag_name")
    version = Version.parse(tag[1:]) if isinstance(tag, str) and tag.startswith("v") else None
    if version is None or tag != f"v{version.text}":
        raise UpdateError(f"the release tag {tag!r} is not v<MAJOR.MINOR.PATCH>")
    if data.get("draft") is True:
        raise UpdateError(f"release {tag} is a draft")
    raw_assets = data.get("assets", [])
    if not isinstance(raw_assets, list):
        raise UpdateError(f"release {tag} lists no assets")
    assets: Dict[str, Asset] = {}
    for item in raw_assets:
        if not isinstance(item, dict):
            continue
        name, url, size = item.get("name"), item.get("browser_download_url"), item.get("size")
        if isinstance(name, str) and isinstance(url, str) and isinstance(size, int) and not isinstance(size, bool) and size >= 0:
            assets[name] = Asset(name, url, size)
    page = data.get("html_url")
    published = data.get("published_at")
    return Release(
        tag=tag,
        version=version,
        prerelease=data.get("prerelease") is True or version.is_prerelease,
        page=page if isinstance(page, str) else "",
        published=published if isinstance(published, str) else "",
        assets=assets,
    )


def endpoint() -> Tuple[str, str]:
    api = os.environ.get(API_ENV, "").strip() or DEFAULT_API
    repo = os.environ.get(REPO_ENV, "").strip() or DEFAULT_REPO
    checked_url(api, API_ENV)
    if not REPO_RE.fullmatch(repo):
        raise UpdateError(f"{REPO_ENV} must look like owner/name, not {repo!r}")
    return api.rstrip("/"), repo


def fetch_release(client: Client, requested: Optional[Version]) -> Release:
    api, repo = endpoint()
    if requested is None:
        url = f"{api}/repos/{repo}/releases/latest"
        release = parse_release(client.get_json(url, what="the latest release", not_found=f"{repo} has no published release yet"))
    else:
        url = f"{api}/repos/{repo}/releases/tags/v{urllib.parse.quote(requested.text, safe='')}"
        release = parse_release(client.get_json(url, what=f"release v{requested}", not_found=f"release v{requested} not found in {repo}"))
        if release.version.text != requested.text:
            raise UpdateError(f"asked for v{requested}, the answer was {release.tag}")
    return release


def parse_sums(text: str) -> Dict[str, str]:
    sums: Dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = SUMS_LINE_RE.fullmatch(line)
        if match is None:
            raise UpdateError("SHA256SUMS has a line that is not '<sha256>  <file>'")
        sums[match.group(2).strip()] = match.group(1).lower()
    return sums


def download_verified(client: Client, release: Release, work: Path) -> Path:
    """The console tarball in ``work``, only once its SHA-256 matches SHA256SUMS."""
    name = CONSOLE_ASSET.format(version=release.version.text)
    tarball = release.asset(name)
    sums_asset = release.asset(SUMS_ASSET)
    if tarball.size > MAX_TARBALL_BYTES:
        raise UpdateError(f"{name} is {_size(tarball.size)}, larger than the limit of {_size(MAX_TARBALL_BYTES)}")
    say(f"Downloading {SUMS_ASSET}")
    data, _ = client.get(sums_asset.url, what=SUMS_ASSET, accept="application/octet-stream", limit=MAX_SUMS_BYTES)
    try:
        sums = parse_sums(data.decode("utf-8"))
    except UnicodeDecodeError:
        raise UpdateError("SHA256SUMS is not text") from None
    expected = sums.get(name)
    if expected is None:
        raise UpdateError(f"SHA256SUMS of {release.tag} does not list {name}")
    path = work / name
    say(f"Downloading {name} ({_size(tarball.size)})")
    try:
        _, actual = client.get(
            tarball.url, what=name, accept="application/octet-stream", limit=MAX_TARBALL_BYTES,
            destination=path, deadline_s=DOWNLOAD_DEADLINE_S,
        )
    except UpdateError:
        path.unlink(missing_ok=True)
        raise
    if actual != expected:
        path.unlink(missing_ok=True)
        raise UpdateError(f"{name} does not match SHA256SUMS (sha256 {actual[:16]}…, listed {expected[:16]}…); nothing was installed")
    say(f"Checked {name} against SHA256SUMS")
    return path


def _member_parts(name: str, top: str) -> List[str]:
    parts = name.split("/")
    if parts and parts[-1] == "":
        parts = parts[:-1]
    if name.startswith("/") or not parts or any(part in ("", ".", "..") for part in parts) or "\\" in name:
        raise UpdateError(f"unsafe archive: member {name!r} has an absolute or relative path; nothing was installed")
    if parts[0] != top:
        raise UpdateError(f"unsafe archive: member {name!r} is outside {top}/; nothing was installed")
    return parts


def safe_extract(tarball: Path, destination: Path, top: str) -> Path:
    """Unpack plain files and directories under ``top/``; refuse anything else before writing."""
    try:
        with tarfile.open(tarball, "r:gz") as archive:
            members = []
            seen = set()
            unpacked = 0
            for member in archive:
                if len(members) >= MAX_MEMBERS:
                    raise UpdateError(f"unsafe archive: more than {MAX_MEMBERS} members; nothing was installed")
                parts = _member_parts(member.name, top)
                key = "/".join(parts)
                if key in seen:
                    raise UpdateError(f"unsafe archive: {member.name!r} appears twice; nothing was installed")
                seen.add(key)
                if member.isfile():
                    unpacked += member.size
                    if unpacked > MAX_UNPACKED_BYTES:
                        raise UpdateError(f"unsafe archive: it unpacks to more than {_size(MAX_UNPACKED_BYTES)}; nothing was installed")
                elif not member.isdir():
                    kind = "link" if member.issym() or member.islnk() else "special file"
                    raise UpdateError(f"unsafe archive: {member.name!r} is a {kind}; nothing was installed")
                members.append((member, parts))
            for member, parts in members:
                target = destination.joinpath(*parts)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    target.chmod(0o755)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    raise UpdateError(f"cannot read {member.name!r} from the archive")
                with source, open(target, "xb") as out:
                    shutil.copyfileobj(source, out, 1 << 20)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
    except (tarfile.TarError, EOFError, OSError) as exc:
        raise UpdateError(f"cannot unpack {tarball.name}: {exc}") from None
    tree = destination / top
    if not tree.is_dir():
        raise UpdateError(f"{tarball.name} holds no {top}/ directory")
    return tree


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_tree(tree: Path, version: Version) -> None:
    """Every file listed in MANIFEST.sha256 with its hash, nothing more, and the expected VERSION."""
    manifest = tree / MANIFEST_NAME
    if not manifest.is_file():
        raise UpdateError(f"the release has no {MANIFEST_NAME}")
    listed: Dict[str, str] = {}
    for line in manifest.read_text(encoding="utf-8").splitlines():
        match = MANIFEST_LINE_RE.fullmatch(line)
        if match is None or any(part in ("", ".", "..") for part in match.group(2).split("/")):
            raise UpdateError(f"{MANIFEST_NAME} has an invalid line {line[:80]!r}")
        listed[match.group(2)] = match.group(1)
    present = {path.relative_to(tree).as_posix() for path in tree.rglob("*") if path.is_file()} - {MANIFEST_NAME}
    if present != set(listed):
        extra = sorted(present - set(listed))[:3]
        missing = sorted(set(listed) - present)[:3]
        raise UpdateError(f"the release does not match {MANIFEST_NAME} (unlisted {extra}, missing {missing})")
    for name, digest in sorted(listed.items()):
        if sha256_file(tree / name) != digest:
            raise UpdateError(f"{name} does not match {MANIFEST_NAME}")
    found = (tree / "VERSION").read_text(encoding="utf-8").strip() if (tree / "VERSION").is_file() else ""
    if found != version.text:
        raise UpdateError(f"the release {version} holds VERSION {found!r}")
    if not (tree / "install.sh").is_file():
        raise UpdateError("the release has no install.sh")


def fetch_tree(client: Client, release: Release, work: Path) -> Path:
    tarball = download_verified(client, release, work)
    tree = safe_extract(tarball, work / "unpacked", CONSOLE_TOP.format(version=release.version.text))
    tarball.unlink(missing_ok=True)
    verify_tree(tree, release.version)
    say(f"Unpacked and checked against {MANIFEST_NAME}")
    return tree


# --- The installed console ----------------------------------------------


@dataclass(frozen=True)
class Install:
    app_dir: Path
    data_dir: Path
    port: int
    launcher: Path
    unit_file: Path
    desktop_file: Path

    @property
    def backup(self) -> Path:
        return self.app_dir.with_name(self.app_dir.name + BACKUP_SUFFIX)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/"


def installed_version(install: Install) -> Optional[Version]:
    try:
        return Version.parse((install.app_dir / "VERSION").read_text(encoding="utf-8"))
    except OSError:
        return None


def _same_path(first: str, second: str) -> bool:
    """Equal once repeated slashes are collapsed (normpath keeps a leading "//") and a trailing "/" is dropped."""
    return os.path.normpath(re.sub("/{2,}", "/", first)) == os.path.normpath(re.sub("/{2,}", "/", second))


def install_options(install: Install) -> List[str]:
    """The options for the next install.sh: the recorded ones, checked against the launcher's paths."""
    expected = {
        "--prefix": str(install.app_dir),
        "--data-dir": str(install.data_dir),
        "--bin-dir": str(install.launcher.parent),
        "--port": str(install.port),
    }
    for name in PATH_OPTIONS:
        if not SAFE_PATH_RE.fullmatch(expected[name]):
            raise UpdateError(f"{name} {expected[name]} is not a path install.sh accepts")
    path = install.app_dir / OPTIONS_NAME
    flags: List[str] = []
    if path.is_file():
        recorded: Dict[str, str] = {}
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            name, sep, value = line.partition("=")
            if name in FLAG_OPTIONS and not sep:
                if name not in flags:
                    flags.append(name)
            elif sep and (name in PATH_OPTIONS and SAFE_PATH_RE.fullmatch(value) or name == "--port" and value.isdigit()):
                recorded[name] = value
            else:
                raise UpdateError(f"{path} has an unexpected line {line[:60]!r}; run install.sh of the new release by hand")
        for name, value in recorded.items():
            # install.sh records a path as typed; an older one kept "//" or a
            # trailing "/", which the launcher's (pathlib) paths do not have.
            same = _same_path(value, expected[name]) if name in PATH_OPTIONS else value == expected[name]
            if not same:
                raise UpdateError(f"{path} records {name}={value}, but the launcher uses {expected[name]}; run install.sh by hand")
    else:
        # An install from before install-options existed: read the choices from what it installed.
        if not install.unit_file.is_file():
            flags.append("--no-service")
        if not install.desktop_file.is_file():
            flags.append("--no-desktop")
    return [f"{name}={expected[name]}" for name in ("--prefix", "--data-dir", "--bin-dir", "--port")] + [
        flag for flag in FLAG_OPTIONS if flag in flags
    ]


def install_env(install: Install) -> Dict[str, str]:
    """The environment for install.sh, with the XDG homes the launcher's unit and menu paths came from."""
    env = dict(os.environ)
    unit = install.unit_file
    if unit.parent.name == "user" and unit.parent.parent.name == "systemd":
        env["XDG_CONFIG_HOME"] = str(unit.parent.parent.parent)
    desktop = install.desktop_file
    if desktop.parent.name == "applications":
        env["XDG_DATA_HOME"] = str(desktop.parent.parent)
    return env


def health_version(port: int) -> Optional[str]:
    """The version /api/health reports on 127.0.0.1, never through a proxy; None when it does not answer ok."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}/api/health", timeout=4) as response:
            body = json.loads(response.read(4096).decode("utf-8"))
    except Exception:  # any failure means "not answering"
        return None
    if isinstance(body, dict) and body.get("ok") is True:
        version = body.get("version")
        return version if isinstance(version, str) else ""
    return None


def wait_for_version(port: int, version: str, timeout_s: float) -> Tuple[bool, Optional[str]]:
    deadline = time.monotonic() + timeout_s
    while True:
        seen = health_version(port)
        if seen == version:
            return True, seen
        if time.monotonic() >= deadline:
            return False, seen
        time.sleep(HEALTH_POLL_S)


def _sh() -> str:
    return shutil.which("sh") or "/bin/sh"


def _stream(command: Sequence[str], *, timeout_s: float, cwd: Optional[Path] = None, env: Optional[Dict[str, str]] = None) -> int:
    """Run ``command``, print its output indented, and kill it after ``timeout_s``."""
    try:
        process = subprocess.Popen(
            list(command), cwd=str(cwd) if cwd else None, env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace",
        )
    except OSError as exc:
        say(f"  cannot run {command[0]}: {exc}")
        return 127
    timer = threading.Timer(timeout_s, process.kill)
    timer.daemon = True
    timer.start()
    try:
        assert process.stdout is not None
        for line in process.stdout:
            say("  " + line.rstrip("\n"))
        return process.wait()
    except KeyboardInterrupt:
        # Stop the child before anything is rolled back under it.
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        raise
    finally:
        timer.cancel()


def run_launcher(install: Install, command: str) -> int:
    if not install.launcher.is_file():
        return 127
    return _stream([_sh(), str(install.launcher), command], timeout_s=LAUNCHER_TIMEOUT_S)


def systemd_reload(install: Install) -> None:
    systemctl = shutil.which("systemctl")
    if systemctl and install.unit_file.is_file():
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            subprocess.run([systemctl, "--user", "daemon-reload"], stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=False)


# --- Backup -------------------------------------------------------------


def make_backup(install: Install, version: str) -> Path:
    """Copy the program, the launcher, the unit and the menu entry to APP_DIR.previous."""
    root = install.backup
    partial = root.with_name(root.name + ".partial")
    shutil.rmtree(partial, ignore_errors=True)
    try:
        partial.mkdir(mode=0o700)
        shutil.copytree(install.app_dir, partial / "app", symlinks=True)
        (partial / "files").mkdir()
        files = []
        for index, path in enumerate((install.launcher, install.unit_file, install.desktop_file)):
            copy = None
            if path.is_file():
                copy = f"{index}-{path.name}"
                shutil.copy2(path, partial / "files" / copy)
            files.append({"path": str(path), "copy": copy})
        (partial / "backup.json").write_text(json.dumps({"version": version, "files": files}, indent=2) + "\n", encoding="utf-8")
        os.rename(partial, root)
    except (OSError, shutil.Error) as exc:
        shutil.rmtree(partial, ignore_errors=True)
        raise UpdateError(f"cannot copy the current program to {root}: {exc}; nothing was installed") from None
    return root


def restore_backup(install: Install) -> None:
    root = install.backup
    meta = json.loads((root / "backup.json").read_text(encoding="utf-8"))
    failed = install.app_dir.with_name(install.app_dir.name + ".failed")
    shutil.rmtree(failed, ignore_errors=True)
    if install.app_dir.exists() or install.app_dir.is_symlink():
        os.rename(install.app_dir, failed)
    os.rename(root / "app", install.app_dir)
    for item in meta["files"]:
        target = Path(item["path"])
        if item.get("copy"):
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(f".{target.name}.restore")
            shutil.copy2(root / "files" / item["copy"], temporary)
            os.replace(temporary, target)
        else:
            with contextlib.suppress(FileNotFoundError):
                target.unlink()
    shutil.rmtree(failed, ignore_errors=True)
    shutil.rmtree(root, ignore_errors=True)


def backup_version(install: Install) -> str:
    try:
        return str(json.loads((install.backup / "backup.json").read_text(encoding="utf-8")).get("version") or "unknown")
    except (OSError, ValueError, AttributeError):
        return "unknown"


# --- State and lock -----------------------------------------------------


def read_state(data_dir: Path) -> dict:
    try:
        state = json.loads((data_dir / STATE_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return state if isinstance(state, dict) else {}


def write_state(data_dir: Path, **values) -> None:
    state = read_state(data_dir)
    state.update(values)
    state["at"] = int(time.time())
    temporary = data_dir / f".{STATE_NAME}.tmp"
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, data_dir / STATE_NAME)
    except OSError as exc:
        print(f"{PROG}: warning: cannot save {data_dir / STATE_NAME}: {exc.strerror or exc}", file=sys.stderr)


@contextlib.contextmanager
def update_lock(data_dir: Path) -> Iterator[None]:
    try:
        fd = os.open(data_dir / LOCK_NAME, os.O_RDWR | os.O_CREAT, 0o600)
    except OSError as exc:
        raise UpdateError(f"cannot open {data_dir / LOCK_NAME}: {exc.strerror or exc}") from None
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise UpdateError("another update is running") from None
        yield
    finally:
        os.close(fd)


@contextlib.contextmanager
def work_dir(base: Path) -> Iterator[Path]:
    for stale in base.glob(WORK_PREFIX + "*"):
        shutil.rmtree(stale, ignore_errors=True)
    path = Path(tempfile.mkdtemp(prefix=WORK_PREFIX, dir=base))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


# --- Decisions ----------------------------------------------------------


@dataclass(frozen=True)
class Plan:
    action: str  # update, current, skip, major
    message: str


def plan_update(
    installed: Optional[Version],
    release: Release,
    *,
    requested: Optional[Version],
    allow_major: bool,
    failed_version: Optional[str],
) -> Plan:
    new = release.version
    to = f" --to {new}" if requested is not None else ""
    if requested is None and release.prerelease:
        return Plan("skip", f"the latest release {release.tag} is a prerelease; nothing to do")
    if installed is None:
        if requested is None:
            raise UpdateError("the installed version is unknown; choose one with --to X.Y.Z")
        return Plan("update", f"Installing {new}")
    if new == installed:
        return Plan("current", f"{installed} is installed and current" if requested is None else f"{installed} is already installed")
    if requested is None and new < installed:
        return Plan("current", f"{installed} is installed; the latest release is {new}")
    if new.major != installed.major and not allow_major:
        notes = f" at {release.page}" if release.page else ""
        return Plan(
            "major",
            f"{installed} is installed; {new} changes the major version. Read its release notes{notes}, "
            f"then run: sdr-doa-console update{to} --allow-major",
        )
    if requested is None and failed_version == new.text:
        return Plan("skip", f"{new} did not start here before and was rolled back; to try it again run: sdr-doa-console update --to {new}")
    change = "downgrade" if new < installed else "update"
    return Plan("update", f"{installed} -> {new} ({change})")


def _install_from(args) -> Install:
    install = Install(
        app_dir=args.app_dir.absolute(),
        data_dir=args.data_dir.absolute(),
        port=args.port,
        launcher=args.launcher.absolute(),
        unit_file=args.unit_file.absolute(),
        desktop_file=args.desktop_file.absolute(),
    )
    if not 1 <= install.port <= 65535:
        raise UpdateError(f"--port {install.port} is not between 1 and 65535")
    return install


def _requested(args) -> Optional[Version]:
    if args.to is None:
        return None
    version = Version.parse(args.to.removeprefix("v"))
    if version is None:
        raise UpdateError(f"--to needs a version such as 2.0.1, not {args.to!r}")
    return version


def _client(installed: Optional[Version]) -> Client:
    return Client(f"SDR-DoA-Ground-Console-Updater/{installed or 'unknown'}")


# --- Commands -----------------------------------------------------------


def cmd_check(args) -> int:
    install = _install_from(args)
    requested = _requested(args)
    installed = installed_version(install)
    release = fetch_release(_client(installed), requested)
    state = read_state(install.data_dir)
    plan = plan_update(installed, release, requested=requested, allow_major=args.allow_major,
                       failed_version=state.get("failed_version"))
    if plan.action == "update":
        to = f" --to {release.version}" if requested is not None else ""
        major = " --allow-major" if installed and release.version.major != installed.major else ""
        message = f"{installed or 'unknown'} is installed; {release.label()} is available"
        say(message + (f": {release.page}" if release.page else ""))
        say(f"Update with: sdr-doa-console update{to}{major}")
        write_state(install.data_dir, command="check", result="available", message=message,
                    installed=str(installed or ""), release=release.version.text)
    else:
        say(plan.message)
        write_state(install.data_dir, command="check", result=plan.action, message=plan.message,
                    installed=str(installed or ""), release=release.version.text)
    return 0


def cmd_download(args) -> int:
    requested = _requested(args)
    destination = args.dest.absolute()
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise UpdateError(f"--dest {destination} must be absent or empty")
    destination.mkdir(parents=True, exist_ok=True)
    client = _client(None)
    release = fetch_release(client, requested)
    if requested is None and release.prerelease:
        raise UpdateError(f"the latest release {release.tag} is a prerelease; choose it with --to")
    with work_dir(destination) as work:
        tree = fetch_tree(client, release, work)
        final = destination / tree.name
        os.rename(tree, final)
    say(str(final))
    return 0


def _confirm(question: str) -> bool:
    if not sys.stdin or not sys.stdin.isatty():
        raise UpdateError("there is no terminal to ask; confirm with --yes")
    try:
        answer = input(question)
    except EOFError:
        return False
    return answer.strip().lower() in ("y", "yes")


def _clear_stale_backup(install: Install, installed: Optional[Version]) -> None:
    partial = install.backup.with_name(install.backup.name + ".partial")
    shutil.rmtree(partial, ignore_errors=True)
    if not install.backup.exists():
        return
    if installed is not None and health_version(install.port) == installed.text:
        shutil.rmtree(install.backup, ignore_errors=True)
        return
    old = backup_version(install)
    raise UpdateError(
        f"{install.backup} is left from an interrupted update and {install.url} does not answer as "
        f"{installed or 'the installed version'}. To go back to {old}: sdr-doa-console stop; "
        f"mv {install.app_dir} {install.app_dir}.broken; mv {install.backup}/app {install.app_dir}; "
        f"rm -r {install.backup}; sdr-doa-console start"
    )


def cmd_apply(args) -> int:
    install = _install_from(args)
    requested = _requested(args)
    if not (install.app_dir / INSTALL_MARKER).is_file():
        raise UpdateError(f"{install.app_dir} holds no console installed by install.sh")
    try:
        owner = install.app_dir.stat().st_uid
    except OSError as exc:
        raise UpdateError(f"cannot read {install.app_dir}: {exc.strerror or exc}") from None
    if owner != os.geteuid():
        raise UpdateError(f"{install.app_dir} belongs to another user; run the update as the user who installed it")
    # What a manual install.sh run gets; the private files set their own modes.
    umask = os.umask(0o022)
    with _sigterm_interrupts(), update_lock(install.data_dir):
        installed = installed_version(install)
        try:
            return _apply(args, install, requested, installed)
        except UpdateError as exc:
            if not getattr(exc, "recorded", False):
                write_state(install.data_dir, command="apply", result="error", message=str(exc), installed=str(installed or ""))
            raise
        finally:
            os.umask(umask)


@contextlib.contextmanager
def _sigterm_interrupts() -> Iterator[None]:
    """Turn SIGTERM (a stopped or timed-out update unit) into KeyboardInterrupt, so a running install is rolled back."""

    def interrupt(signum, frame):
        raise KeyboardInterrupt

    try:
        previous = signal.signal(signal.SIGTERM, interrupt)
    except ValueError:  # not the main thread
        yield
        return
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)


def _apply(args, install: Install, requested: Optional[Version], installed: Optional[Version]) -> int:
    _clear_stale_backup(install, installed)
    client = _client(installed)
    release = fetch_release(client, requested)
    state = read_state(install.data_dir)
    plan = plan_update(installed, release, requested=requested, allow_major=args.allow_major,
                       failed_version=state.get("failed_version"))
    if plan.action != "update":
        say(plan.message)
        write_state(install.data_dir, command="apply", result=plan.action, message=plan.message,
                    installed=str(installed or ""), release=release.version.text)
        return 0
    new = release.version
    options = install_options(install)
    say(f"Installed: {installed or 'unknown'}")
    say(f"Release:   {release.label()}" + (f"  {release.page}" if release.page else ""))
    if not args.yes and not _confirm(f"Update the Ground Console to {new}? It restarts once. [y/N] "):
        say("Nothing was changed.")
        return 1
    with work_dir(install.data_dir) as work:
        tree = fetch_tree(client, release, work)
        was_running = health_version(install.port) is not None
        expect_running = was_running or "--no-service" not in options
        old = str(installed or "unknown")
        make_backup(install, old)
        say(f"Saved the current program as {install.backup}")
        try:
            failure = _install_and_wait(args, install, tree, options, new, expect_running)
        except KeyboardInterrupt:
            _roll_back(install, old, new, "the update was interrupted", expect_running, release_failed=False)
            raise
        if failure is None:
            shutil.rmtree(install.backup, ignore_errors=True)
            message = f"Updated the Ground Console from {old} to {new}."
            if not expect_running:
                message += " It was not running and stays stopped; start it with: sdr-doa-console start"
            say(message)
            write_state(install.data_dir, command="apply", result="updated", message=message,
                        installed=new.text, release=new.text, failed_version=None)
            return 0
        error = UpdateError(_roll_back(install, old, new, failure, expect_running))
        error.recorded = True  # type: ignore[attr-defined]
        raise error


def _install_and_wait(args, install: Install, tree: Path, options: List[str], new: Version, expect_running: bool) -> Optional[str]:
    """Run the release's install.sh and wait for the new version; the reason it failed, or None."""
    say("Running install.sh --yes " + " ".join(options))
    status = _stream([_sh(), str(tree / "install.sh"), "--yes", *options],
                     timeout_s=INSTALL_TIMEOUT_S, cwd=tree, env=install_env(install))
    if status != 0:
        return f"install.sh of {new} exited with {status}"
    if not expect_running:
        return None
    say(f"Waiting for {new} to answer on {install.url} (up to {args.health_timeout:.0f} s)")
    ok, seen = wait_for_version(install.port, new.text, args.health_timeout)
    if ok:
        return None
    answered = f" (it answered as {seen})" if seen else ""
    return f"{new} did not answer /api/health on port {install.port} within {args.health_timeout:.0f} s{answered}"


def _roll_back(install: Install, old: str, new: Version, failure: str, expect_running: bool, *, release_failed: bool = True) -> str:
    """Put the copy back and start it; ``release_failed`` makes later latest-release updates skip ``new``."""
    say(f"{failure}; restoring {old}")
    skipped = {"failed_version": new.text} if release_failed else {}
    run_launcher(install, "stop")
    try:
        restore_backup(install)
    except (OSError, ValueError, KeyError) as exc:
        message = f"the update to {new} failed ({failure}) and restoring {old} failed too: {exc}; the copy is in {install.backup}"
        write_state(install.data_dir, command="apply", result="failed", message=message, **skipped)
        return message
    systemd_reload(install)
    back = True
    if expect_running:
        run_launcher(install, "start")
        back, _ = wait_for_version(install.port, old, RESTORE_HEALTH_TIMEOUT_S)
    message = f"the update to {new} failed ({failure}); {old} was restored"
    if not back:
        message += " but does not answer yet; see: sdr-doa-console status"
    write_state(install.data_dir, command="apply", result="failed", message=message,
                installed=old, release=new.text, **skipped)
    return message


def cmd_status(args) -> int:
    state = read_state(args.data_dir.absolute())
    if not state:
        say("No update check has run yet.")
        return 0
    at = state.get("at")
    when = time.strftime("%Y-%m-%d %H:%M", time.localtime(at)) if isinstance(at, int) else "unknown time"
    say(f"Last update run: {when}: {state.get('message') or state.get('result') or 'no result'}")
    failed = state.get("failed_version")
    if failed and state.get("result") != "failed":
        say(f"Skipped until a newer release: {failed} (rolled back here)")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="update_release.py", description="Update the native Ground Console from its GitHub release.")
    commands = parser.add_subparsers(dest="command", metavar="COMMAND")
    commands.required = True
    paths = argparse.ArgumentParser(add_help=False)
    paths.add_argument("--app-dir", type=Path, required=True, help="the program directory (install.sh --prefix)")
    paths.add_argument("--data-dir", type=Path, required=True, help="the data directory (install.sh --data-dir)")
    paths.add_argument("--port", type=int, required=True, help="the console port on 127.0.0.1")
    paths.add_argument("--launcher", type=Path, required=True, help="the installed sdr-doa-console")
    paths.add_argument("--unit-file", type=Path, required=True, help="the console's systemd user unit")
    paths.add_argument("--desktop-file", type=Path, required=True, help="the menu entry")
    choice = argparse.ArgumentParser(add_help=False)
    choice.add_argument("--to", metavar="X.Y.Z", help="this release instead of the latest one")
    choice.add_argument("--allow-major", action="store_true", help="allow a different major version")

    check = commands.add_parser("check", parents=[paths, choice], help="show whether a newer release exists")
    check.add_argument("--yes", "-y", action="store_true", help=argparse.SUPPRESS)
    check.set_defaults(handler=cmd_check)
    apply = commands.add_parser("apply", parents=[paths, choice], help="install the newer release")
    apply.add_argument("--yes", "-y", action="store_true", help="do not ask before installing")
    apply.add_argument("--health-timeout", type=float, default=HEALTH_TIMEOUT_S, metavar="S",
                       help=f"seconds the new version has to answer /api/health (default {HEALTH_TIMEOUT_S:.0f})")
    apply.set_defaults(handler=cmd_apply)
    download = commands.add_parser("download", parents=[choice], help="download, verify and unpack a release only")
    download.add_argument("--dest", type=Path, required=True, help="empty directory for the unpacked release")
    download.set_defaults(handler=cmd_download)
    status = commands.add_parser("status", parents=[paths], help="show the result of the last run")
    status.set_defaults(handler=cmd_status)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.handler(args)
    except UpdateError as exc:
        print(f"{PROG}: {exc}", file=sys.stderr, flush=True)
        return 1
    except KeyboardInterrupt:
        print(f"{PROG}: interrupted", file=sys.stderr, flush=True)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
