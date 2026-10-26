"""Tests for the native update path: packaging/console/update_release.py, the
options install.sh records for it, and the launcher's update and auto-update
commands.

Nothing touches the network, systemd or the real home directory. A threaded
loopback HTTP server plays the GitHub API and the asset downloads (with the
redirect GitHub answers), a second one plays a proxy, and a third one the
console's /api/health. Release tarballs are written with make_release's own
writer in temporary directories; their install.sh records its arguments and
installs VERSION. Where a shell script calls systemctl, loginctl, id or
python3, a stub on PATH answers.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import io
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from unittest import mock

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(ROOT / "packaging/console"))

import make_release  # noqa: E402
import update_release  # noqa: E402

REPO = update_release.DEFAULT_REPO
EPOCH = 1_700_000_000
PROXY_VARIABLES = {"http_proxy", "https_proxy", "all_proxy", "no_proxy", "ftp_proxy"}
TOKEN = "test-token-that-must-never-be-sent"

FAKE_INSTALL = r"""#!/bin/sh
# Stands in for install.sh: records its arguments, then installs VERSION like the real one.
set -eu
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
printf '%s\n' "$@" >"$FAKE_INSTALL_LOG"
prefix=
bin=
for arg in "$@"; do
  case $arg in
    --prefix=*) prefix=${arg#--prefix=} ;;
    --bin-dir=*) bin=${arg#--bin-dir=} ;;
  esac
done
if [ "${FAKE_INSTALL_FAIL:-0}" != 0 ]; then
  echo "fake install failed" >&2
  exit 3
fi
cp "$here/VERSION" "$prefix/VERSION"
echo new >"$prefix/program.txt"
if [ -n "${FAKE_INSTALL_SLEEP:-}" ]; then exec sleep "$FAKE_INSTALL_SLEEP"; fi
echo "# replaced by $(cat "$here/VERSION")" >>"$bin/sdr-doa-console"
"""

FAKE_LAUNCHER = """#!/bin/sh
printf '%s\\n' "$*" >>"{log}"
if [ "$1" = stop ] && [ -n "${{FAKE_LAUNCHER_STOP_SLEEP:-}}" ]; then sleep "$FAKE_LAUNCHER_STOP_SLEEP"; fi
"""


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def clean_environment(**extra: str) -> Dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key.lower() not in PROXY_VARIABLES}
    env.update(extra)
    return env


class FakeServer:
    """A loopback HTTP server answering GETs from ``routes`` (path -> answer or callable)."""

    def __init__(self, routes: Optional[dict] = None):
        self.routes: dict = routes if routes is not None else {}
        self.requests: List[Tuple[str, Dict[str, str]]] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 (http.server API)
                raw = self.path
                path = urllib.parse.urlsplit(raw).path if "://" in raw else raw.split("?", 1)[0]
                server.requests.append((raw, dict(self.headers.items())))
                answer = server.routes.get(path)
                if callable(answer):
                    answer = answer()
                if answer is None:
                    answer = (404, {"Content-Type": "application/json"}, b'{"message": "Not Found"}')
                status, headers, body = answer
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                if "Content-Length" not in headers:
                    self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    @property
    def port(self) -> int:
        return self.httpd.server_port

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def paths(self) -> List[str]:
        return [urllib.parse.urlsplit(raw).path if "://" in raw else raw for raw, _ in self.requests]


def json_answer(value: object, status: int = 200, headers: Optional[dict] = None):
    return (status, {"Content-Type": "application/json", **(headers or {})}, json.dumps(value).encode())


class FakeGitHub(FakeServer):
    """Releases at /repos/<repo>/releases/{latest,tags/v*}; assets redirect like github.com does."""

    def add_release(
        self,
        version: str,
        tarball: bytes,
        *,
        latest: bool = False,
        prerelease: bool = False,
        sums: Optional[str] = None,
        size: Optional[int] = None,
        assets: Optional[List[str]] = None,
    ) -> dict:
        tag = f"v{version}"
        name = update_release.CONSOLE_ASSET.format(version=version)
        if sums is None:
            sums = f"{hashlib.sha256(tarball).hexdigest()}  {name}\n{'0' * 64}  sdr-doa-docker\n"
        files = {name: tarball, "SHA256SUMS": sums.encode()}
        listed = []
        for asset, body in files.items():
            if assets is not None and asset not in assets:
                continue
            self.routes[f"/storage/{tag}/{asset}"] = (200, {"Content-Type": "application/octet-stream"}, body)
            self.routes[f"/{REPO}/releases/download/{tag}/{asset}"] = (
                302, {"Location": f"{self.url}/storage/{tag}/{asset}"}, b""
            )
            listed.append({
                "name": asset,
                "size": len(body) if size is None or asset != name else size,
                "browser_download_url": f"{self.url}/{REPO}/releases/download/{tag}/{asset}",
            })
        release = {
            "tag_name": tag,
            "name": tag,
            "draft": False,
            "prerelease": prerelease,
            "html_url": f"https://github.com/{REPO}/releases/tag/{tag}",
            "published_at": "2026-10-19T08:00:00Z",
            "assets": listed,
        }
        self.routes[f"/repos/{REPO}/releases/tags/{tag}"] = json_answer(release)
        if latest:
            self.routes[f"/repos/{REPO}/releases/latest"] = json_answer(release)
        return release


class FakeConsole(FakeServer):
    """/api/health with the version from ``version_file``, or a fixed one."""

    def __init__(self, version_file: Optional[Path] = None, fixed: Optional[str] = None):
        super().__init__()
        self.version_file = version_file
        self.fixed = fixed
        self.busy: Optional[bool] = None  # None: an older console without receiver_busy
        self.routes["/api/health"] = self.health

    def health(self):
        version = self.fixed or (self.version_file.read_text(encoding="utf-8").strip() if self.version_file else "dev")
        body = {"ok": True, "version": version}
        if self.busy is not None:
            body["receiver_busy"] = self.busy
        return json_answer(body)


def release_tarball(version: str, directory: Path, *, install: str = FAKE_INSTALL, extra=(), version_file: str = "") -> bytes:
    top = update_release.CONSOLE_TOP.format(version=version)
    entries = [
        make_release.Entry("VERSION", data=f"{version_file or version}\n".encode()),
        make_release.Entry("install.sh", data=install.encode(), executable=True),
        make_release.Entry("packaging/console/README.md", data=b"notes\n"),
        *extra,
    ]
    path = directory / f"{top}-{len(list(directory.iterdir()))}.tar.gz"
    make_release.write_tarball(make_release._with_manifest(entries), top, path, EPOCH)
    return path.read_bytes()


def raw_tarball(version: str, extra_members: List[Tuple[tarfile.TarInfo, bytes]]) -> bytes:
    """A tarball with a valid release tree followed by the given members, written as-is."""
    top = update_release.CONSOLE_TOP.format(version=version)
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz", format=tarfile.PAX_FORMAT) as archive:
        def add(name: str, data: bytes = b"", kind=tarfile.REGTYPE, mode=0o644, link=""):
            info = tarfile.TarInfo(name)
            info.type = kind
            info.mode = mode
            info.linkname = link
            info.size = len(data) if kind == tarfile.REGTYPE else 0
            archive.addfile(info, io.BytesIO(data) if kind == tarfile.REGTYPE else None)

        add(top, kind=tarfile.DIRTYPE, mode=0o755)
        add(f"{top}/VERSION", f"{version}\n".encode())
        add(f"{top}/install.sh", FAKE_INSTALL.encode(), mode=0o755)
        for info, data in extra_members:
            archive.addfile(info, io.BytesIO(data) if info.isfile() else None)
    return buffer.getvalue()


def member(name: str, kind=tarfile.REGTYPE, data: bytes = b"x", link: str = "") -> Tuple[tarfile.TarInfo, bytes]:
    info = tarfile.TarInfo(name)
    info.type = kind
    info.linkname = link
    info.mode = 0o644
    info.size = len(data) if kind == tarfile.REGTYPE else 0
    return info, data


class FakeInstall:
    """A console installed by install.sh, as far as the updater can see."""

    def __init__(self, base: Path, port: int, version: str = "2.0.0", options: Optional[List[str]] = None):
        self.base = base
        self.port = port
        self.app = base / "app"
        self.data = base / "data"
        self.bin = base / "bin"
        self.launcher = self.bin / "sdr-doa-console"
        self.unit_file = base / "config/systemd/user/sdr-doa-ground-console.service"
        self.desktop_file = base / "share/applications/sdr-doa-ground-console.desktop"
        self.launcher_log = base / "launcher.log"
        self.install_log = base / "install-args"
        (self.app / "venv/bin").mkdir(parents=True)
        (self.app / "venv/bin/python").symlink_to(sys.executable)
        self.data.mkdir()
        self.bin.mkdir()
        (self.app / "VERSION").write_text(f"{version}\n", encoding="utf-8")
        (self.app / ".sdr-doa-console-install").write_text(f"{version}\n", encoding="utf-8")
        (self.app / "program.txt").write_text("old\n", encoding="utf-8")
        self.launcher_text = FAKE_LAUNCHER.format(log=self.launcher_log)
        self.launcher.write_text(self.launcher_text, encoding="utf-8")
        self.launcher.chmod(0o755)
        if options is None:
            options = self.expected_options()
        (self.app / "install-options").write_text("# recorded by install.sh\n" + "".join(f"{line}\n" for line in options), encoding="utf-8")

    def expected_options(self, *flags: str) -> List[str]:
        return [f"--prefix={self.app}", f"--data-dir={self.data}", f"--bin-dir={self.bin}", f"--port={self.port}",
                *(flags or ("--no-service", "--no-desktop"))]

    def argv(self, command: str, *extra: str) -> List[str]:
        return [command, *extra, "--app-dir", str(self.app), "--data-dir", str(self.data), "--port", str(self.port),
                "--launcher", str(self.launcher), "--unit-file", str(self.unit_file), "--desktop-file", str(self.desktop_file)]

    def version(self) -> str:
        return (self.app / "VERSION").read_text(encoding="utf-8").strip()

    def state(self) -> dict:
        return json.loads((self.data / "update-state.json").read_text(encoding="utf-8"))

    def installed_args(self) -> Optional[List[str]]:
        if not self.install_log.exists():
            return None
        return self.install_log.read_text(encoding="utf-8").splitlines()


class UpdaterTestCase(unittest.TestCase):
    """Runs update_release.main() in this process against the fakes."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="console-update-")
        self.tmp = Path(self._tmp.name)
        (self.tmp / "tarballs").mkdir()
        self.github = FakeGitHub()
        self.addCleanup(self.github.close)
        self.console: Optional[FakeConsole] = None
        for name, value in (("RETRY_DELAY_S", 0.0), ("HEALTH_POLL_S", 0.05), ("RESTORE_HEALTH_TIMEOUT_S", 1.0),
                            ("LAUNCHER_TIMEOUT_S", 20.0)):
            patcher = mock.patch.object(update_release, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.env = clean_environment(
            SDR_DOA_UPDATE_API=self.github.url,
            GITHUB_TOKEN=TOKEN,
            GH_TOKEN=TOKEN,
            FAKE_INSTALL_LOG=str(self.tmp / "install-args"),
        )
        self.env.pop("SDR_DOA_UPDATE_REPO", None)
        patcher = mock.patch.dict(os.environ, self.env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        stdin = mock.patch.object(sys, "stdin", io.StringIO(""))
        stdin.start()
        self.addCleanup(stdin.stop)

    def tearDown(self):
        if self.console is not None:
            self.console.close()
        self._tmp.cleanup()

    def make_install(self, *, fixed_health: Optional[str] = None, running: bool = True, **kwargs) -> FakeInstall:
        if running:
            self.console = FakeConsole(self.tmp / "app/VERSION", fixed=fixed_health)
            port = self.console.port
        else:
            port = free_port()
        return FakeInstall(self.tmp, port, **kwargs)

    def tarball(self, version: str, **kwargs) -> bytes:
        return release_tarball(version, self.tmp / "tarballs", **kwargs)

    def run_main(self, *argv: str) -> Tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = update_release.main(list(argv))
            except SystemExit as exc:  # argparse
                code = exc.code if isinstance(exc.code, int) else 2
        return code, out.getvalue(), err.getvalue()

    def assert_untouched(self, install: FakeInstall, version: str = "2.0.0"):
        self.assertEqual(install.version(), version)
        self.assertEqual((install.app / "program.txt").read_text(encoding="utf-8"), "old\n")
        self.assertEqual(install.launcher.read_text(encoding="utf-8"), install.launcher_text)
        self.assertFalse(Path(f"{install.app}.previous").exists())
        self.assertEqual(list(install.data.glob(".update-work-*")), [])

    def assert_anonymous(self):
        self.assertTrue(self.github.requests)
        for raw, headers in self.github.requests:
            names = {name.lower() for name in headers}
            self.assertNotIn("authorization", names, raw)
            self.assertNotIn(TOKEN, " ".join(headers.values()), raw)
            self.assertTrue(headers.get("User-Agent", "").startswith("SDR-DoA-Ground-Console-Updater/"), raw)


class VersionTests(unittest.TestCase):
    def test_semver_precedence(self):
        ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2",
                   "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.2.0", "2.0.0", "2.0.1", "2.1.0", "10.0.0"]
        versions = [update_release.Version.parse(text) for text in ordered]
        self.assertTrue(all(versions))
        for earlier, later in zip(versions, versions[1:]):
            self.assertLess(earlier, later, f"{earlier} < {later}")
            self.assertFalse(later < earlier)
        self.assertEqual(update_release.Version.parse("2.0.0+build.5"), update_release.Version.parse("2.0.0"))
        self.assertTrue(update_release.Version.parse("2.1.0-rc.1").is_prerelease)
        self.assertFalse(update_release.Version.parse("2.1.0+local").is_prerelease)
        for bad in ("v2.0.0", "2.0", "02.0.0", "2.0.0-", "2.0.0-rc..1", "2.0.0 extra", ""):
            self.assertIsNone(update_release.Version.parse(bad), bad)
        self.assertEqual(update_release.Version.parse(make_release.read_version(ROOT)).text, make_release.read_version(ROOT))

    def test_checked_url(self):
        for good in ("https://api.github.com", "http://127.0.0.1:9", "http://localhost:80/x", "http://[::1]:8/"):
            self.assertEqual(update_release.checked_url(good, "x"), good)
        for bad in ("http://api.github.com", "ftp://x", "https://user:pw@api.github.com", "file:///etc/passwd", "https://"):
            with self.assertRaises(update_release.UpdateError, msg=bad):
                update_release.checked_url(bad, "x")

    def test_parse_sums(self):
        digest = "a" * 64
        self.assertEqual(update_release.parse_sums(f"{digest}  one.tar.gz\n{digest.upper()} *two\n\n"),
                         {"one.tar.gz": digest, "two": digest})
        with self.assertRaises(update_release.UpdateError):
            update_release.parse_sums("not a checksum line\n")


class UpdateFlowTests(UpdaterTestCase):
    def test_no_newer_version(self):
        install = self.make_install()
        self.github.add_release("2.0.0", self.tarball("2.0.0"), latest=True)
        code, out, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 0, err)
        self.assertIn("2.0.0 is installed and current", out)
        self.assertIsNone(install.installed_args())
        self.assert_untouched(install)
        self.assertEqual(install.state()["result"], "current")
        code, out, _ = self.run_main(*install.argv("check"))
        self.assertEqual((code, out.strip()), (0, "2.0.0 is installed and current"))
        self.assert_anonymous()

    def test_newer_patch_is_installed_with_the_recorded_options(self):
        install = self.make_install()
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True)
        code, out, _ = self.run_main(*install.argv("check"))
        self.assertEqual(code, 0)
        self.assertIn("2.0.0 is installed; 2.0.1 (2026-10-19) is available", out)
        self.assertIn("Update with: sdr-doa-console update", out)
        self.assertIsNone(install.installed_args())
        code, out, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 0, out + err)
        self.assertEqual(install.installed_args(), ["--yes", *install.expected_options()])
        self.assertEqual(install.version(), "2.0.1")
        self.assertEqual((install.app / "program.txt").read_text(encoding="utf-8"), "new\n")
        self.assertIn("Checked sdr-doa-ground-console-2.0.1-linux.tar.gz against SHA256SUMS", out)
        self.assertIn("Updated the Ground Console from 2.0.0 to 2.0.1.", out)
        self.assertFalse(Path(f"{install.app}.previous").exists(), "the copy goes once the new version answers")
        self.assertEqual(list(install.data.glob(".update-work-*")), [])
        self.assertFalse(install.launcher_log.exists(), "install.sh restarts the console, not the updater")
        state = install.state()
        self.assertEqual((state["result"], state["installed"], state["failed_version"]), ("updated", "2.0.1", None))
        downloads = [path for path in self.github.paths() if "/storage/" in path]
        self.assertEqual(sorted(downloads), ["/storage/v2.0.1/SHA256SUMS", "/storage/v2.0.1/sdr-doa-ground-console-2.0.1-linux.tar.gz"])
        self.assert_anonymous()

    def test_newer_minor_is_installed(self):
        install = self.make_install()
        self.github.add_release("2.1.0", self.tarball("2.1.0"), latest=True)
        code, out, err = self.run_main(*install.argv("apply", "-y"))
        self.assertEqual(code, 0, out + err)
        self.assertEqual(install.version(), "2.1.0")

    def test_major_version_needs_allow_major(self):
        install = self.make_install()
        self.github.add_release("3.0.0", self.tarball("3.0.0"), latest=True)
        for command in ("check", "apply"):
            code, out, err = self.run_main(*install.argv(command, "--yes"))
            self.assertEqual(code, 0, err)
            self.assertIn("3.0.0 changes the major version", out)
            self.assertIn("sdr-doa-console update --allow-major", out)
            self.assertIn(f"https://github.com/{REPO}/releases/tag/v3.0.0", out)
        self.assertIsNone(install.installed_args())
        self.assert_untouched(install)
        self.assertEqual(install.state()["result"], "major")
        code, out, err = self.run_main(*install.argv("apply", "--yes", "--allow-major"))
        self.assertEqual(code, 0, out + err)
        self.assertEqual(install.version(), "3.0.0")

    def test_prerelease_is_never_picked_as_latest(self):
        install = self.make_install()
        self.github.add_release("2.1.0-rc.1", self.tarball("2.1.0-rc.1"), latest=True, prerelease=True)
        code, out, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 0, err)
        self.assertIn("v2.1.0-rc.1 is a prerelease; nothing to do", out)
        # A '-' in the tag is a prerelease even when the flag says otherwise.
        self.github.add_release("2.2.0-beta", self.tarball("2.2.0-beta"), latest=True, prerelease=False)
        code, out, _ = self.run_main(*install.argv("apply", "--yes"))
        self.assertIn("v2.2.0-beta is a prerelease", out)
        self.assertIsNone(install.installed_args())
        self.assert_untouched(install)
        code, out, err = self.run_main(*install.argv("apply", "--yes", "--to", "2.1.0-rc.1"))
        self.assertEqual(code, 0, out + err)
        self.assertEqual(install.version(), "2.1.0-rc.1", "--to installs a prerelease on purpose")

    def test_to_installs_a_specific_version(self):
        install = self.make_install()
        self.github.add_release("2.1.0", self.tarball("2.1.0"), latest=True)
        self.github.add_release("2.0.1", self.tarball("2.0.1"))
        code, _, err = self.run_main(*install.argv("apply", "--yes", "--to", "2.0.0"))
        self.assertEqual(code, 1)
        self.assertIn(f"release v2.0.0 not found in {REPO}", err)
        code, out, err = self.run_main(*install.argv("apply", "--yes", "--to", "v2.0.1"))
        self.assertEqual(code, 0, out + err)
        self.assertEqual(install.version(), "2.0.1")
        code, out, _ = self.run_main(*install.argv("apply", "--yes", "--to", "2.0.1"))
        self.assertEqual((code, out.strip()), (0, "2.0.1 is already installed"))
        code, _, err = self.run_main(*install.argv("apply", "--yes", "--to", "two"))
        self.assertEqual(code, 1)
        self.assertIn("--to needs a version such as 2.0.1", err)

    def test_confirmation_without_yes(self):
        install = self.make_install()
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True)
        code, out, err = self.run_main(*install.argv("apply"))
        self.assertEqual(code, 1)
        self.assertIn("confirm with --yes", err)
        self.assertIsNone(install.installed_args())

        class Terminal(io.StringIO):
            def isatty(self):
                return True

        with mock.patch.object(sys, "stdin", Terminal("n\n")):
            code, out, _ = self.run_main(*install.argv("apply"))
        self.assertEqual(code, 1)
        self.assertIn("Installed: 2.0.0", out)
        self.assertIn("Update the Ground Console to 2.0.1? It restarts once. [y/N]", out)
        self.assertIn("Nothing was changed.", out)
        self.assert_untouched(install)
        with mock.patch.object(sys, "stdin", Terminal("y\n")):
            code, out, err = self.run_main(*install.argv("apply"))
        self.assertEqual(code, 0, out + err)
        self.assertEqual(install.version(), "2.0.1")

    def test_hash_mismatch_is_refused_before_anything_runs(self):
        install = self.make_install()
        name = update_release.CONSOLE_ASSET.format(version="2.0.1")
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True, sums=f"{'1' * 64}  {name}\n")
        code, out, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 1)
        self.assertIn(f"{name} does not match SHA256SUMS", err)
        self.assertIn("nothing was installed", err)
        self.assertIsNone(install.installed_args())
        self.assert_untouched(install)
        self.assertEqual(install.state()["result"], "error")

    def test_missing_checksum_entry_and_missing_assets(self):
        install = self.make_install()
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True, sums=f"{'1' * 64}  other.tar.gz\n")
        code, _, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 1)
        self.assertIn("SHA256SUMS of v2.0.1 does not list sdr-doa-ground-console-2.0.1-linux.tar.gz", err)
        self.github.add_release("2.0.2", self.tarball("2.0.2"), latest=True, assets=["SHA256SUMS"])
        code, _, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertIn("release v2.0.2 has no asset sdr-doa-ground-console-2.0.2-linux.tar.gz", err)
        self.github.add_release("2.0.3", self.tarball("2.0.3"), latest=True, assets=["sdr-doa-ground-console-2.0.3-linux.tar.gz"])
        code, _, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertIn("release v2.0.3 has no asset SHA256SUMS", err)
        self.assertIsNone(install.installed_args())
        self.assert_untouched(install)

    def test_unsafe_archive_members_are_refused(self):
        top = update_release.CONSOLE_TOP.format(version="2.0.1")
        cases = {
            "../evil": member("../evil"),
            "absolute": member(f"/{self.tmp.name}-evil"),
            "dot-dot inside": member(f"{top}/../../evil"),
            "outside the top directory": member("other/evil"),
            "symlink": member(f"{top}/link", tarfile.SYMTYPE, link="/etc/passwd"),
            "relative symlink": member(f"{top}/link", tarfile.SYMTYPE, link="VERSION"),
            "hard link": member(f"{top}/hard", tarfile.LNKTYPE, link=f"{top}/VERSION"),
            "fifo": member(f"{top}/fifo", tarfile.FIFOTYPE),
            "device": member(f"{top}/dev", tarfile.CHRTYPE),
            "duplicate": member(f"{top}/VERSION", data=b"9.9.9\n"),
        }
        install = self.make_install()
        for label, extra in cases.items():
            with self.subTest(label):
                self.github.add_release("2.0.1", raw_tarball("2.0.1", [extra]), latest=True)
                code, _, err = self.run_main(*install.argv("apply", "--yes"))
                self.assertEqual(code, 1, label)
                self.assertIn("unsafe archive", err)
                self.assertIn("nothing was installed", err)
                self.assertIsNone(install.installed_args())
                self.assert_untouched(install)
        self.assertEqual(sorted(path.name for path in self.tmp.rglob("evil*")), [])
        self.assertFalse(Path(f"/{self.tmp.name}-evil").exists())

    def test_safe_extract_writes_nothing_when_a_later_member_is_unsafe(self):
        tarball = self.tmp / "late.tar.gz"
        tarball.write_bytes(raw_tarball("2.0.1", [member("../evil")]))
        destination = self.tmp / "unpacked"
        destination.mkdir()
        with self.assertRaisesRegex(update_release.UpdateError, "unsafe archive"):
            update_release.safe_extract(tarball, destination, update_release.CONSOLE_TOP.format(version="2.0.1"))
        self.assertEqual(list(destination.iterdir()), [])

    def test_manifest_and_version_of_the_unpacked_release_are_checked(self):
        install = self.make_install()
        top = update_release.CONSOLE_TOP.format(version="2.0.1")
        self.github.add_release("2.0.1", raw_tarball("2.0.1", []), latest=True)  # no MANIFEST.sha256
        code, _, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 1)
        self.assertIn("has no MANIFEST.sha256", err)
        # A file the manifest does not list.
        with tarfile.open(fileobj=io.BytesIO(self.tarball("2.0.1")), mode="r:gz") as good:
            members = [(info, good.extractfile(info).read() if info.isfile() else b"") for info in good.getmembers()]
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            for info, data in members + [member(f"{top}/extra.sh")]:
                archive.addfile(info, io.BytesIO(data) if info.isfile() else None)
        self.github.add_release("2.0.1", buffer.getvalue(), latest=True)
        code, _, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 1)
        self.assertIn("the release does not match MANIFEST.sha256 (unlisted ['extra.sh'], missing [])", err)
        # VERSION inside differs from the tag.
        self.github.add_release("2.0.2", self.tarball("2.0.2", version_file="2.0.1"), latest=True)
        code, _, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 1)
        self.assertIn("the release 2.0.2 holds VERSION '2.0.1'", err)
        self.assertIsNone(install.installed_args())
        self.assert_untouched(install)

    def test_size_caps(self):
        install = self.make_install()
        tarball = self.tarball("2.0.1")
        self.github.add_release("2.0.1", tarball, latest=True)
        with mock.patch.object(update_release, "MAX_TARBALL_BYTES", 100):
            code, _, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 1)
        self.assertIn("larger than the limit of 100 bytes", err)
        self.assertNotIn("/storage/v2.0.1/sdr-doa-ground-console-2.0.1-linux.tar.gz", self.github.paths(),
                         "a listed size above the cap stops before the download")
        # The release lists a small size, the download is bigger: Content-Length stops it.
        self.github.add_release("2.0.1", tarball, latest=True, size=10)
        with mock.patch.object(update_release, "MAX_TARBALL_BYTES", 100):
            code, _, err = self.run_main(*install.argv("apply", "--yes"))
        size = update_release._size(len(tarball))
        self.assertIn(f"sdr-doa-ground-console-2.0.1-linux.tar.gz is {size}, larger than the limit of 100 bytes", err)
        with mock.patch.object(update_release, "MAX_JSON_BYTES", 50):
            code, _, err = self.run_main(*install.argv("check"))
        self.assertEqual(code, 1)
        self.assertRegex(err, r"the latest release is \d+ bytes, larger than the limit of 50 bytes")
        with mock.patch.object(update_release, "MAX_SUMS_BYTES", 20):
            code, _, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertRegex(err, r"SHA256SUMS is \d+ bytes, larger than the limit of 20 bytes")
        self.assertIsNone(install.installed_args())
        self.assert_untouched(install)

    def test_streamed_download_stops_at_the_cap(self):
        client = update_release.Client("test")

        class Streaming(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def do_GET(self):  # noqa: N802
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"x" * 5000)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Streaming)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        try:
            with self.assertRaisesRegex(update_release.UpdateError, "the file is larger than the limit of 2 KiB"):
                client.get(f"http://127.0.0.1:{server.server_port}/x", what="the file", accept="*/*", limit=2048)
        finally:
            server.shutdown()
            server.server_close()

    def test_not_found_and_rate_limit_messages(self):
        install = self.make_install()
        code, _, err = self.run_main(*install.argv("check"))
        self.assertEqual(code, 1)
        self.assertIn(f"{REPO} has no published release yet", err)
        code, _, err = self.run_main(*install.argv("check", "--to", "2.0.9"))
        self.assertIn(f"release v2.0.9 not found in {REPO}", err)
        reset = int(time.time()) + 600
        latest = f"/repos/{REPO}/releases/latest"
        self.github.routes[latest] = json_answer(
            {"message": "API rate limit exceeded"}, 403, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": str(reset)}
        )
        code, _, err = self.run_main(*install.argv("check"))
        self.assertEqual(code, 1)
        clock = time.strftime("%H:%M", time.localtime(reset))
        self.assertIn(f"GitHub rate limit reached (HTTP 403); try again after {clock} local time (in 10 min)", err)
        self.assertEqual(len(err.strip().splitlines()), 1, "one line")
        self.github.routes[latest] = json_answer({"message": "slow down"}, 429, {"Retry-After": "120"})
        code, _, err = self.run_main(*install.argv("check"))
        self.assertIn("GitHub rate limit reached (HTTP 429); try again after", err)
        self.assertIn("(in 2 min)", err)
        self.github.routes[latest] = json_answer({"message": "Forbidden"}, 403, {"X-RateLimit-Remaining": "55"})
        code, _, err = self.run_main(*install.argv("check"))
        self.assertIn("the latest release: access refused (HTTP 403)", err)
        self.assertNotIn("rate limit", err)

    def test_one_retry_on_a_transient_failure(self):
        install = self.make_install()
        release = self.github.add_release("2.0.0", self.tarball("2.0.0"), latest=True)
        latest = f"/repos/{REPO}/releases/latest"
        answers = [json_answer({"message": "unavailable"}, 503), json_answer(release)]
        self.github.routes[latest] = lambda: answers.pop(0) if len(answers) > 1 else answers[0]
        code, out, err = self.run_main(*install.argv("check"))
        self.assertEqual(code, 0, err)
        self.assertIn("2.0.0 is installed and current", out)
        self.assertEqual(self.github.paths().count(latest), 2)
        self.github.routes[latest] = json_answer({"message": "unavailable"}, 502)
        before = self.github.paths().count(latest)
        code, _, err = self.run_main(*install.argv("check"))
        self.assertIn("the latest release: HTTP 502", err)
        self.assertEqual(self.github.paths().count(latest) - before, 2, "retried once, not more")
        dead = free_port()
        with mock.patch.dict(os.environ, {"SDR_DOA_UPDATE_API": f"http://127.0.0.1:{dead}"}):
            code, _, err = self.run_main(*install.argv("check"))
        self.assertEqual(code, 1)
        self.assertIn(f"cannot reach 127.0.0.1:{dead}:", err)
        self.assertEqual(len(err.strip().splitlines()), 1)

    def test_environment_proxy_is_used_and_health_never_is(self):
        install = self.make_install()
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True)
        proxy = FakeServer(self.github.routes)
        self.addCleanup(proxy.close)
        dead = free_port()
        with mock.patch.dict(os.environ, {"http_proxy": proxy.url, "https_proxy": proxy.url,
                                          "SDR_DOA_UPDATE_API": f"http://127.0.0.1:{dead}"}):
            proxied = [h for h in update_release.Client("x").opener.handlers if isinstance(h, update_release.urllib.request.ProxyHandler)]
            self.assertEqual(len(proxied), 1)
            self.assertEqual(proxied[0].proxies.get("http"), proxy.url)
            code, out, err = self.run_main(*install.argv("check"))
            self.assertEqual(code, 0, err)
            self.assertIn("2.0.1 (2026-10-19) is available", out)
            self.assertEqual(proxy.requests[0][0], f"http://127.0.0.1:{dead}/repos/{REPO}/releases/latest")
            self.assertEqual(update_release.health_version(install.port), "2.0.0", "the health check bypasses the proxy")

    def test_redirect_to_plain_http_is_refused(self):
        install = self.make_install()
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True)
        self.github.routes[f"/{REPO}/releases/download/v2.0.1/SHA256SUMS"] = (302, {"Location": "http://example.com/SHA256SUMS"}, b"")
        code, _, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 1)
        self.assertIn("a redirect must be an https URL", err)
        self.assert_untouched(install)
        with mock.patch.dict(os.environ, {"SDR_DOA_UPDATE_API": "http://api.github.com"}):
            code, _, err = self.run_main(*install.argv("check"))
        self.assertIn("SDR_DOA_UPDATE_API must be an https URL", err)
        with mock.patch.dict(os.environ, {"SDR_DOA_UPDATE_REPO": "../x"}):
            code, _, err = self.run_main(*install.argv("check"))
        self.assertIn("SDR_DOA_UPDATE_REPO must look like owner/name", err)

    def test_failed_health_check_restores_the_previous_program(self):
        install = self.make_install(fixed_health="2.0.0")
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True)
        code, out, err = self.run_main(*install.argv("apply", "--yes", "--health-timeout", "0.5"))
        self.assertEqual(code, 1, out)
        self.assertIn("2.0.1 did not answer /api/health", err)
        self.assertIn("(it answered as 2.0.0)", err)
        self.assertIn("2.0.0 was restored", err)
        self.assertEqual(install.installed_args()[0], "--yes", "install.sh ran")
        self.assert_untouched(install)
        self.assertTrue((install.app / "venv/bin/python").is_symlink(), "the venv comes back as it was")
        self.assertEqual(install.launcher_log.read_text(encoding="utf-8").split(), ["stop", "start"])
        state = install.state()
        self.assertEqual((state["result"], state["failed_version"]), ("failed", "2.0.1"))
        # The rolled-back release is skipped until a newer one appears, or --to asks for it.
        install.install_log.unlink()
        for command in ("check", "apply"):
            code, out, err = self.run_main(*install.argv(command, "--yes"))
            self.assertEqual(code, 0, err)
            self.assertIn("2.0.1 did not start here before and was rolled back", out)
            self.assertIn("sdr-doa-console update --to 2.0.1", out)
        self.assertIsNone(install.installed_args())
        self.console.fixed = None
        code, out, err = self.run_main(*install.argv("apply", "--yes", "--to", "2.0.1"))
        self.assertEqual(code, 0, out + err)
        self.assertEqual(install.version(), "2.0.1")
        self.assertIsNone(install.state()["failed_version"])

    def test_failed_install_script_restores_the_previous_program(self):
        install = self.make_install()
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True)
        with mock.patch.dict(os.environ, {"FAKE_INSTALL_FAIL": "1"}):
            code, out, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 1)
        self.assertIn("fake install failed", out)
        self.assertIn("install.sh of 2.0.1 exited with 3", err)
        self.assert_untouched(install)
        self.assertEqual(install.launcher_log.read_text(encoding="utf-8").split(), ["stop", "start"])

    def test_sigterm_during_install_rolls_back_without_marking_the_release(self):
        install = self.make_install()
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True)
        handler = signal.getsignal(signal.SIGTERM)

        def terminate_once_install_runs():
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if install.install_log.exists():
                    os.kill(os.getpid(), signal.SIGTERM)  # the updater's handler runs while install.sh does
                    return
                time.sleep(0.02)

        killer = threading.Thread(target=terminate_once_install_runs, daemon=True)
        with mock.patch.dict(os.environ, {"FAKE_INSTALL_SLEEP": "30"}):
            killer.start()
            started = time.monotonic()
            code, out, err = self.run_main(*install.argv("apply", "--yes"))
        killer.join(5)
        self.assertEqual(code, 130, out + err)
        self.assertLess(time.monotonic() - started, 15, "install.sh was stopped, not waited for")
        self.assertIn("the update was interrupted; restoring 2.0.0", out)
        self.assert_untouched(install)
        self.assertEqual(install.launcher_log.read_text(encoding="utf-8").split(), ["stop", "start"])
        state = install.state()
        self.assertEqual(state["result"], "failed")
        self.assertIsNone(state.get("failed_version"), "an interrupted update does not mark the release bad")
        self.assertIs(signal.getsignal(signal.SIGTERM), handler)

    def test_second_sigterm_does_not_cut_the_rollback_short(self):
        # systemd stops the unit with SIGTERM and may send another one to what
        # is left (final-sigterm) while the rollback stops the console.
        install = self.make_install()
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True)

        def terminate_twice():
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and not install.install_log.exists():
                time.sleep(0.02)
            os.kill(os.getpid(), signal.SIGTERM)
            while time.monotonic() < deadline:
                if install.launcher_log.exists() and "stop" in install.launcher_log.read_text(encoding="utf-8"):
                    time.sleep(0.1)
                    os.kill(os.getpid(), signal.SIGTERM)
                    return
                time.sleep(0.02)

        killer = threading.Thread(target=terminate_twice, daemon=True)
        with mock.patch.dict(os.environ, {"FAKE_INSTALL_SLEEP": "30", "FAKE_LAUNCHER_STOP_SLEEP": "1"}):
            killer.start()
            code, out, err = self.run_main(*install.argv("apply", "--yes"))
        killer.join(5)
        self.assertEqual(code, 130, out + err)
        self.assertIn("the update was interrupted; restoring 2.0.0", out)
        self.assert_untouched(install)
        self.assertEqual(install.launcher_log.read_text(encoding="utf-8").split(), ["stop", "start"])

    def test_auto_waits_while_the_receiver_records(self):
        install = self.make_install()
        self.console.busy = True
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True)
        code, out, err = self.run_main(*install.argv("apply", "--auto"))
        self.assertEqual(code, 0, out + err)
        self.assertIn("deferred: Receiver recording or scan active; 2.0.1 is installed on a later run", out)
        self.assert_untouched(install)
        self.assertIsNone(install.installed_args())
        first = install.state()
        self.assertEqual(first["result"], "deferred")
        self.assertIsInstance(first["deferred_since"], int)
        code, out, _ = self.run_main(*install.argv("apply", "--auto"))
        self.assertEqual(code, 0)
        self.assertEqual(install.state()["deferred_since"], first["deferred_since"], "the first deferral counts")
        code, out, _ = self.run_main(*install.argv("status"))
        self.assertIn("deferred: Receiver recording or scan active", out)
        # After 7 days of deferrals it updates anyway.
        state = install.state()
        state["deferred_since"] -= update_release.BUSY_DEFER_MAX_S
        (install.data / "update-state.json").write_text(json.dumps(state), encoding="utf-8")
        code, out, err = self.run_main(*install.argv("apply", "--auto"))
        self.assertEqual(code, 0, out + err)
        self.assertIn("The Receiver was busy at every update run for 7 days; updating anyway", out)
        self.assertEqual(install.version(), "2.0.1")
        self.assertIsNone(install.state()["deferred_since"])

    def test_auto_updates_an_idle_or_older_console(self):
        install = self.make_install()
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True)
        # None: a console from before receiver_busy, which counts as idle.
        for busy in (False, None):
            with self.subTest(busy=busy):
                (install.app / "VERSION").write_text("2.0.0\n", encoding="utf-8")
                self.console.busy = busy
                code, out, err = self.run_main(*install.argv("apply", "--auto"))
                self.assertEqual(code, 0, out + err)
                self.assertIn("Updated the Ground Console from 2.0.0 to 2.0.1.", out)
                self.assertNotIn("deferred", out)
                self.assertNotIn("Warning", out)

    def test_manual_update_warns_while_the_receiver_records(self):
        install = self.make_install()
        self.console.busy = True
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True)
        code, out, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 0, out + err)
        self.assertIn("Warning: the Receiver is recording or archiving a scan.", out)
        self.assertEqual(install.version(), "2.0.1")
        # Without --yes it still asks, and there is no terminal here.
        self.console.busy = True
        self.github.add_release("2.0.2", self.tarball("2.0.2"), latest=True)
        code, out, err = self.run_main(*install.argv("apply"))
        self.assertEqual(code, 1)
        self.assertIn("Warning: the Receiver is recording", out)
        self.assertIn("confirm with --yes", err)

    def test_console_that_was_not_running_stays_stopped(self):
        install = self.make_install(running=False)
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True)
        code, out, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 0, out + err)
        self.assertIn("It was not running and stays stopped", out)
        self.assertEqual(install.version(), "2.0.1")

    def test_service_install_must_answer_even_when_it_was_stopped(self):
        install = self.make_install(running=False, options=None)
        (install.app / "install-options").write_text("\n".join(install.expected_options("--no-desktop")) + "\n", encoding="utf-8")
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True)
        code, out, err = self.run_main(*install.argv("apply", "--yes", "--health-timeout", "0.3"))
        self.assertEqual(code, 1)
        self.assertIn("did not answer /api/health", err)
        self.assertIn("does not answer yet; see: sdr-doa-console status", err)
        self.assert_untouched(install)

    def test_lock_stale_copy_and_install_checks(self):
        install = self.make_install()
        self.github.add_release("2.0.0", self.tarball("2.0.0"), latest=True)
        with open(install.data / ".update.lock", "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            code, _, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 1)
        self.assertIn("another update is running", err)
        # A copy left by an interrupted update goes when the install answers as itself.
        stale = Path(f"{install.app}.previous")
        (stale / "app").mkdir(parents=True)
        (stale / "backup.json").write_text('{"version": "1.9.0", "files": []}', encoding="utf-8")
        code, _, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 0, err)
        self.assertFalse(stale.exists())
        # When it does not answer, the operator gets the commands to go back.
        (stale / "app").mkdir(parents=True)
        (stale / "backup.json").write_text('{"version": "1.9.0", "files": []}', encoding="utf-8")
        self.console.fixed = "2.0.1"
        code, _, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 1)
        self.assertIn("left from an interrupted update", err)
        self.assertIn(f"mv {stale}/app {install.app}", err)
        shutil.rmtree(stale)
        (install.app / ".sdr-doa-console-install").unlink()
        code, _, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertIn("holds no console installed by install.sh", err)

    def test_install_options_are_checked_against_the_launcher(self):
        install = self.make_install()
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True)
        options = install.app / "install-options"
        options.write_text(f"--prefix={install.app}\n--port=1\n", encoding="utf-8")
        code, _, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 1)
        self.assertIn(f"records --port=1, but the launcher uses {install.port}", err)
        options.write_text("--password=secret\n", encoding="utf-8")
        code, _, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertIn("has an unexpected line '--password=secret'", err)
        self.assertIsNone(install.installed_args())
        # A path recorded with a trailing slash or "//" (install.sh kept it as
        # typed) is the launcher's path.
        options.write_text(
            f"--prefix={install.app}/\n--data-dir=/{install.data}\n--bin-dir={str(install.bin).replace('/', '//')}\n"
            f"--port={install.port}\n--no-service\n--no-desktop\n",
            encoding="utf-8",
        )
        code, out, err = self.run_main(*install.argv("check"))
        self.assertEqual(code, 0, out + err)
        self.assertEqual(update_release.install_options(update_release._install_from(
            update_release.build_parser().parse_args(install.argv("apply"))
        )), install.expected_options())
        # An install from before install-options: the flags follow what it installed.
        options.unlink()
        install.desktop_file.parent.mkdir(parents=True)
        install.desktop_file.write_text("[Desktop Entry]\n", encoding="utf-8")
        code, out, err = self.run_main(*install.argv("apply", "--yes"))
        self.assertEqual(code, 0, out + err)
        self.assertEqual(install.installed_args(), ["--yes", *install.expected_options("--no-service")])

    def test_install_env_follows_the_launcher_paths(self):
        install = self.make_install(running=False)
        env = update_release.install_env(update_release.Install(
            install.app, install.data, install.port, install.launcher, install.unit_file, install.desktop_file))
        self.assertEqual(env["XDG_CONFIG_HOME"], str(self.tmp / "config"))
        self.assertEqual(env["XDG_DATA_HOME"], str(self.tmp / "share"))

    def test_download_and_status_commands(self):
        install = self.make_install()
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True)
        code, out, _ = self.run_main(*install.argv("status"))
        self.assertEqual((code, out.strip()), (0, "No update check has run yet."))
        destination = self.tmp / "download"
        code, out, err = self.run_main("download", "--dest", str(destination))
        self.assertEqual(code, 0, err)
        tree = destination / update_release.CONSOLE_TOP.format(version="2.0.1")
        self.assertEqual(out.strip().splitlines()[-1], str(tree))
        self.assertEqual((tree / "VERSION").read_text(encoding="utf-8"), "2.0.1\n")
        self.assertEqual(sorted(path.name for path in destination.iterdir()), [tree.name])
        code, _, err = self.run_main("download", "--dest", str(destination))
        self.assertIn("must be absent or empty", err)
        self.run_main(*install.argv("check"))
        code, out, _ = self.run_main(*install.argv("status"))
        self.assertRegex(out, r"Last update run: \d{4}-\d\d-\d\d \d\d:\d\d: 2\.0\.0 is installed; 2\.0\.1")
        self.assertEqual(oct((install.data / "update-state.json").stat().st_mode & 0o777), "0o600")


def write_stub(directory: Path, name: str, text: str) -> Path:
    path = directory / name
    path.write_text(text, encoding="utf-8")
    path.chmod(0o755)
    return path


def sh() -> str:
    return shutil.which("sh") or "/bin/sh"


SYSTEMCTL_STUB = """#!/bin/sh
printf '%s\\n' "$*" >>"$STUB_LOG"
case "$*" in
  "--user show-environment") [ "${STUB_NO_SYSTEMD:-0}" = 1 ] && exit 1; echo HOME=/x ;;
  "--user is-enabled "*) echo enabled ;;
  "--user is-active "*) echo active ;;
  "--user show "*) echo "Wed 2026-10-21 03:52:11 UTC" ;;
esac
exit 0
"""


class LauncherTests(UpdaterTestCase):
    """The launcher's update and auto-update commands over a rendered launcher and stubs."""

    def render(self) -> Tuple[Path, Dict[str, str]]:
        base = self.tmp
        app, data = base / "app", base / "data"
        (app / "packaging/console").mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / "packaging/console/update_release.py", app / "packaging/console/")
        launcher = base / "bin/sdr-doa-console"
        launcher.parent.mkdir(exist_ok=True)
        unit = base / "xdg/systemd/user/sdr-doa-ground-console.service"
        text = (ROOT / "packaging/console/sdr-doa-console").read_text(encoding="utf-8")
        for name, value in (("APP_DIR", app), ("DATA_DIR", data), ("PORT", self.port), ("BIN_PATH", launcher),
                            ("UNIT_FILE", unit), ("DESKTOP_FILE", base / "share/applications/sdr-doa-ground-console.desktop")):
            text = text.replace(f"@{name}@", str(value))
        self.assertNotRegex(text, r"@[A-Z_]+@")
        launcher.write_text(text, encoding="utf-8")
        launcher.chmod(0o755)
        stubs = base / "stubs"
        stubs.mkdir(exist_ok=True)
        write_stub(stubs, "systemctl", SYSTEMCTL_STUB)
        write_stub(stubs, "loginctl", "#!/bin/sh\necho no\n")
        (stubs / "python3").symlink_to(sys.executable)
        env = clean_environment(PATH=f"{stubs}:/usr/bin:/bin", HOME=str(base), STUB_LOG=str(base / "systemctl.log"),
                                SDR_DOA_UPDATE_API=self.github.url)
        return launcher, env

    def launcher_run(self, launcher: Path, env: Dict[str, str], *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sh(), str(launcher), *args], capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=60)

    def setUp(self):
        super().setUp()
        install = self.make_install()
        self.port = install.port
        self.install = install
        self.launcher, self.launcher_env = self.render()
        self.unit_dir = self.tmp / "xdg/systemd/user"

    def systemctl_calls(self) -> List[str]:
        log = self.tmp / "systemctl.log"
        return [line for line in log.read_text(encoding="utf-8").splitlines() if line != "--user show-environment"] if log.exists() else []

    def test_auto_update_on_status_off(self):
        launcher, env = self.launcher, self.launcher_env
        self.unit_dir.mkdir(parents=True)
        (self.unit_dir / "sdr-doa-ground-console.service").write_text("[Unit]\n", encoding="utf-8")
        result = self.launcher_run(launcher, env, "auto-update", "on")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Auto-update on: daily at 03:45 local time", result.stdout)
        self.assertIn("lingering is off", result.stderr)
        service = (self.unit_dir / "sdr-doa-console-update.service").read_text(encoding="utf-8")
        timer = (self.unit_dir / "sdr-doa-console-update.timer").read_text(encoding="utf-8")
        self.assertIn("Type=oneshot", service)
        self.assertIn(f"ExecStart={launcher} update --auto", service)
        self.assertIn("TimeoutStopSec=5min", service.splitlines())
        for line in ("OnCalendar=*-*-* 03:45:00", "RandomizedDelaySec=15min", "Persistent=true", "WantedBy=timers.target"):
            self.assertIn(line, timer.splitlines())
        self.assertEqual(oct((self.unit_dir / "sdr-doa-console-update.timer").stat().st_mode & 0o777), "0o644")
        self.assertEqual(self.systemctl_calls(), ["--user daemon-reload", "--user enable --now sdr-doa-console-update.timer"])

        result = self.launcher_run(launcher, env, "auto-update", "on", "--time", "04:10")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("OnCalendar=*-*-* 04:10:00", (self.unit_dir / "sdr-doa-console-update.timer").read_text(encoding="utf-8"))
        status = self.launcher_run(launcher, env, "auto-update", "status")
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertIn("Auto-update: on, daily at 04:10 local time", status.stdout)
        self.assertIn("Timer:       enabled, active; next run Wed 2026-10-21 03:52:11 UTC", status.stdout)
        self.assertIn("No update check has run yet.", status.stdout)
        info = self.launcher_run(launcher, env, "info")
        self.assertIn("Updates:  daily at 04:10", info.stdout)

        for bad in (["on", "--time", "24:00"], ["on", "--time", "7:30"], ["on", "--time"], ["sometimes"], ["on", "--bogus"]):
            result = self.launcher_run(launcher, env, "auto-update", *bad)
            self.assertEqual(result.returncode, 64, bad)
        self.assertIn("OnCalendar=*-*-* 04:10:00", (self.unit_dir / "sdr-doa-console-update.timer").read_text(encoding="utf-8"))

        result = self.launcher_run(launcher, env, "auto-update", "off")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.unit_dir / "sdr-doa-console-update.timer").exists())
        self.assertFalse((self.unit_dir / "sdr-doa-console-update.service").exists())
        self.assertIn("--user disable --now sdr-doa-console-update.timer", self.systemctl_calls())
        status = self.launcher_run(launcher, env, "auto-update", "status")
        self.assertIn("Auto-update: off", status.stdout)

    def test_auto_update_without_systemd_or_service_prints_a_cron_line(self):
        launcher, env = self.launcher, self.launcher_env
        result = self.launcher_run(launcher, {**env, "STUB_NO_SYSTEMD": "1"}, "auto-update", "on", "--time", "05:07")
        self.assertEqual(result.returncode, 1)
        self.assertIn("no systemd user session", result.stderr)
        self.assertIn(f"7 5 * * * {launcher} update --auto >>{self.tmp / 'data/update.log'} 2>&1", result.stderr)
        result = self.launcher_run(launcher, env, "auto-update", "on")
        self.assertEqual(result.returncode, 1)
        self.assertIn("needs the systemd user service of the console", result.stderr)
        self.assertIn("45 3 * * *", result.stderr)
        self.assertFalse(self.unit_dir.exists())

    def test_uninstall_removes_the_update_units_and_copy(self):
        launcher, env = self.launcher, self.launcher_env
        self.unit_dir.mkdir(parents=True)
        (self.unit_dir / "sdr-doa-ground-console.service").write_text("[Unit]\n", encoding="utf-8")
        self.assertEqual(self.launcher_run(launcher, env, "auto-update", "on").returncode, 0)
        Path(f"{self.install.app}.previous").mkdir()
        (self.install.data / "update-state.json").write_text("{}", encoding="utf-8")
        result = self.launcher_run(launcher, env, "uninstall", "--purge", "--yes")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.unit_dir / "sdr-doa-console-update.timer").exists())
        self.assertFalse(Path(f"{self.install.app}.previous").exists())
        self.assertFalse((self.install.data / "update-state.json").exists())

    def test_update_arguments_reach_the_updater(self):
        launcher, env = self.launcher, self.launcher_env
        (self.tmp / "app/VERSION").write_text("2.0.0\n", encoding="utf-8")
        self.github.add_release("2.0.1", self.tarball("2.0.1"), latest=True)
        self.github.add_release("2.0.0", self.tarball("2.0.0"))
        result = self.launcher_run(launcher, env, "update", "--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("2.0.0 is installed; 2.0.1 (2026-10-19) is available", result.stdout)
        result = self.launcher_run(launcher, env, "update", "--check", "--to", "2.0.0")
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "2.0.0 is already installed"), result.stderr)
        result = self.launcher_run(launcher, env, "update", "--check", "--to=2.0.0", "--allow-major")
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.launcher_run(launcher, env, "update")
        self.assertEqual(result.returncode, 1)
        self.assertIn("confirm with --yes", result.stderr)
        for bad in (["--bogus"], ["--to"], ["--check", "--auto"]):
            self.assertEqual(self.launcher_run(launcher, env, "update", *bad).returncode, 64, bad)
        # --auto reaches the updater as the timer's run, which asks nothing.
        result = self.launcher_run(launcher, env, "update", "--auto")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Updated the Ground Console from 2.0.0 to 2.0.1.", result.stdout)
        self.assertIn("auto-update on [--time HH:MM]", self.launcher_run(launcher, env, "help").stdout)


class InstallScriptTests(unittest.TestCase):
    """The real install.sh from a release tree, with python3, id and pip stubbed, then updated by the real updater."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="console-install-")
        cls.tmp = Path(cls._tmp.name)
        dist = cls.tmp / "dist"
        for name, text in (("index.html", "<!doctype html>"), ("receiver/index.html", "<!doctype html>")):
            (dist / name).parent.mkdir(parents=True, exist_ok=True)
            (dist / name).write_text(text, encoding="utf-8")
        with mock.patch("sys.stderr", new=io.StringIO()):
            entries = make_release.console_release_entries(ROOT, dist)
        cls.base_entries = [entry for entry in entries if entry.arcname not in ("VERSION", make_release.MANIFEST_NAME, make_release.MANUAL_PDF)]

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def release_tree(self, version: str, base: Path) -> Path:
        entries = make_release._with_manifest(self.base_entries + [make_release.Entry("VERSION", data=f"{version}\n".encode())])
        return make_release.stage_tree(entries, base / f"release-{version}")

    def release_tarball(self, version: str, base: Path) -> bytes:
        entries = make_release._with_manifest(self.base_entries + [make_release.Entry("VERSION", data=f"{version}\n".encode())])
        top = update_release.CONSOLE_TOP.format(version=version)
        path = base / f"{top}.tar.gz"
        make_release.write_tarball(entries, top, path, EPOCH)
        return path.read_bytes()

    def environment(self, base: Path) -> Dict[str, str]:
        stubs = base / "stubs"
        stubs.mkdir()
        real = sys.executable
        write_stub(stubs, "id", '#!/bin/sh\ncase "$1" in -u) echo 1000 ;; -un) echo tester ;; *) exec /usr/bin/id "$@" ;; esac\n')
        # python3 -m venv makes a venv whose python skips pip and runs everything else for real.
        write_stub(stubs, "python3", f"""#!/bin/sh
if [ "$1" = -m ] && [ "$2" = venv ]; then
  mkdir -p "$3/bin"
  cat >"$3/bin/python" <<'STUB'
#!/bin/sh
if [ "$1" = -m ] && [ "$2" = pip ]; then echo "pip $*" >>"$PIP_LOG"; exit 0; fi
exec {real} "$@"
STUB
  chmod 755 "$3/bin/python"
  exit 0
fi
exec {real} "$@"
""")
        return clean_environment(PATH=f"{stubs}:/usr/bin:/bin", HOME=str(base / "home"), PIP_LOG=str(base / "pip.log"),
                                 XDG_CONFIG_HOME=str(base / "home/.config"), XDG_DATA_HOME=str(base / "home/.local/share"))

    def test_install_records_its_options_and_reruns_the_same_way(self):
        with tempfile.TemporaryDirectory(prefix="install-", dir=self.tmp) as tmp:
            base = Path(tmp)
            env = self.environment(base)
            tree = self.release_tree("2.0.0", base)
            app, data, bin_dir, port = base / "app", base / "data", base / "bin", free_port()
            first = subprocess.run(
                [sh(), str(tree / "install.sh"), "--yes", "--prefix", str(app), f"--data-dir={data}", "--bin-dir", str(bin_dir),
                 "--port", str(port), "--no-service", "--no-desktop", "--password", "s3cret-value",
                 "--base-url", "http://192.168.100.100:8081", "--data-out-hosts", "rdf.local,192.168.100.100",
                 "--mqtt-host", "10.90.0.1"],
                capture_output=True, text=True, env=env, timeout=120,
            )
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            options_file = app / "install-options"
            text = options_file.read_text(encoding="utf-8")
            options = [line for line in text.splitlines() if not line.startswith("#")]
            self.assertEqual(options, [f"--prefix={app}", f"--data-dir={data}", f"--bin-dir={bin_dir}", f"--port={port}",
                                       "--no-service", "--no-desktop"])
            self.assertNotIn("s3cret", text)
            self.assertNotIn("192.168", text)
            self.assertNotIn("10.90.0.1", text)
            self.assertNotIn("rdf.local", text)
            self.assertTrue((app / "packaging/console/update_release.py").is_file())
            seeds = (data / "seed.env").read_text(encoding="utf-8")
            self.assertIn("SDR_DOA_SEED_BASE_URL=http://192.168.100.100:8081", seeds)
            self.assertIn("SDR_DOA_SEED_DATA_OUT_HOSTS=rdf.local,192.168.100.100", seeds)
            env_file = (data / ".env").read_text(encoding="utf-8")
            self.assertIn("s3cret-value", env_file)
            self.assertIn("sdr-doa-console auto-update on", first.stdout)

            # What the updater runs: the recorded options and --yes. Data, password and seeds stay.
            again = subprocess.run([sh(), str(tree / "install.sh"), "--yes", *options], capture_output=True, text=True, env=env, timeout=120)
            self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
            self.assertEqual((data / ".env").read_text(encoding="utf-8"), env_file)
            self.assertIn("Keeping the admin password", again.stdout)
            self.assertEqual(options_file.read_text(encoding="utf-8"), text)
            self.assertIn("SDR_DOA_SEED_BASE_URL", (data / "seed.env").read_text(encoding="utf-8"))

    def test_install_records_one_spelling_of_each_path(self):
        with tempfile.TemporaryDirectory(prefix="install-", dir=self.tmp) as tmp:
            base = Path(tmp)
            env = self.environment(base)
            tree = self.release_tree("2.0.0", base)
            data, bin_dir, port = base / "data", base / "bin", free_port()
            # A trailing slash from tab completion and a doubled one; the prefix defaults to DATA/app.
            result = subprocess.run(
                [sh(), str(tree / "install.sh"), "--yes", "--data-dir", f"{data}/", "--bin-dir", str(bin_dir).replace("/", "//"),
                 "--port", str(port), "--no-service", "--no-desktop"],
                capture_output=True, text=True, env=env, timeout=120,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            options = [line for line in (data / "app/install-options").read_text(encoding="utf-8").splitlines() if not line.startswith("#")]
            self.assertEqual(options[:3], [f"--prefix={data}/app", f"--data-dir={data}", f"--bin-dir={bin_dir}"])
            for option, value in (("--bin-dir", f"{base}/./bin"), ("--prefix", f"{base}/x/../app"), ("--data-dir", f"{base}/..")):
                refused = subprocess.run([sh(), str(tree / "install.sh"), "--yes", option, value, "--no-service", "--no-desktop"],
                                         capture_output=True, text=True, env=env, timeout=60)
                self.assertNotEqual(refused.returncode, 0, option)
                self.assertIn("must not contain . or .. components", refused.stderr + refused.stdout, option)

    def test_update_through_the_installed_launcher(self):
        with tempfile.TemporaryDirectory(prefix="install-", dir=self.tmp) as tmp:
            base = Path(tmp)
            env = self.environment(base)
            tree = self.release_tree("2.0.0", base)
            app, data, bin_dir = base / "app", base / "data", base / "bin"
            console = FakeConsole(app / "VERSION")
            self.addCleanup(console.close)
            installed = subprocess.run(
                [sh(), str(tree / "install.sh"), "--yes", "--prefix", str(app), "--data-dir", str(data), "--bin-dir", str(bin_dir),
                 "--port", str(console.port), "--no-service", "--no-desktop"],
                capture_output=True, text=True, env=env, timeout=120,
            )
            self.assertEqual(installed.returncode, 0, installed.stdout + installed.stderr)
            github = FakeGitHub()
            self.addCleanup(github.close)
            github.add_release("2.0.1", self.release_tarball("2.0.1", base), latest=True)
            result = subprocess.run(
                [sh(), str(bin_dir / "sdr-doa-console"), "update", "--yes"], capture_output=True, text=True,
                env={**env, "SDR_DOA_UPDATE_API": github.url}, timeout=180, stdin=subprocess.DEVNULL,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("Running install.sh --yes --prefix=", result.stdout)
            self.assertIn("Installing the SDR-DoA Ground Console 2.0.1", result.stdout)
            self.assertIn("Updated the Ground Console from 2.0.0 to 2.0.1.", result.stdout)
            self.assertEqual((app / "VERSION").read_text(encoding="utf-8"), "2.0.1\n")
            self.assertEqual((app / ".sdr-doa-console-install").read_text(encoding="utf-8"), "2.0.1\n")
            self.assertFalse(Path(f"{app}.previous").exists())
            info = subprocess.run([sh(), str(bin_dir / "sdr-doa-console"), "info"], capture_output=True, text=True, env=env)
            self.assertIn("SDR-DoA Ground Console 2.0.1", info.stdout)


if __name__ == "__main__":
    unittest.main()
