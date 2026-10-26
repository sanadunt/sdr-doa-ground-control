"""Tests for tools/make_release.py and the packaging scripts it ships.

The release tests build both tarballs from this repository into a temporary
directory with --skip-build and a fake frontend dist, so they need neither
Node.js nor the BrowSDR submodule. The script tests run the shell scripts
with sh in temporary roots; nothing touches systemd, users or the network.
"""

from __future__ import annotations

import hashlib
import io
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import make_release  # noqa: E402

ROOT = make_release.PROJECT_ROOT
EPOCH = 1_700_000_000
CONSOLE_MODULES = {
    "ground_console.py",
    "config_command_tracker.py",
    "lan_access.py",
    "preferences_store.py",
    "rdf_node_mqtt_v2.py",
    "receiver_archive.py",
    "receiver_mirror.py",
    "receiver_record_store.py",
    "sdr_doa_collector.py",
    "sdr_doa_mqtt.py",
    "sdr_doa_mqtt_monitor.py",
    "tile_cache.py",
}
AGENT_MODULES = {"sdr_doa_lan_agent.py", "sdr_doa_collector.py", "sdr_doa_mqtt.py", "sdr_doa_mqtt_stdlib.py"}
SHELL_SCRIPTS = (
    "packaging/agent/install-agent.sh",
    "packaging/agent/uninstall-agent.sh",
    "packaging/agent/run-agent.sh",
    "packaging/console/install.sh",
    "packaging/console/sdr-doa-console",
    "packaging/docker/console-entrypoint.sh",
    "packaging/docker/check-build-context.sh",
    "packaging/docker/sdr-doa-docker",
)
# Every compose file at the repository root; the policy tests cover each one.
COMPOSE_FILES = tuple(sorted(path.name for path in ROOT.glob("docker-compose*.yml")))
# Compose files of the console (the rest is the agent's).
CONSOLE_COMPOSE_FILES = ("docker-compose.yml", "docker-compose.release.yml", "docker-compose.ghcr.yml")


def make_fake_dist(base: Path) -> Path:
    dist = base / "dist"
    files = {
        "index.html": "<!doctype html><title>console</title>",
        "assets/index-abc.js": "console.log(1)",
        "receiver/index.html": "<!doctype html><title>receiver</title>",
        "receiver/assets/app.js": "sdr-console-receiver",
        # Never shipped:
        "node_modules/left-over.js": "x",
        ".env": "SDR_DOA_ADMIN_PASSWORD=secret",
        "assets/__pycache__/x.cpython-312.pyc": "x",
        "stray.pyc": "x",
    }
    for name, text in files.items():
        path = dist / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return dist


def tar_members(path: Path):
    with tarfile.open(path, "r:gz") as archive:
        return archive.getmembers()


def tar_read(path: Path, name: str) -> bytes:
    with tarfile.open(path, "r:gz") as archive:
        handle = archive.extractfile(name)
        assert handle is not None
        return handle.read()


class ReleaseBuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="test-make-release-")
        cls.tmp = Path(cls._tmp.name)
        cls.dist = make_fake_dist(cls.tmp)
        cls.version = make_release.read_version(ROOT)
        cls.outputs = []
        for name in ("out-a", "out-b"):
            with mock.patch("sys.stderr", new=io.StringIO()):
                cls.outputs.append(
                    make_release.build_release(
                        ROOT,
                        output_dir=cls.tmp / name,
                        dist_dir=cls.dist,
                        skip_build=True,
                        allow_dirty=True,
                        epoch=EPOCH,
                    )
                )
        cls.console_tar, cls.agent_tar, cls.docker_script, cls.checksums = cls.outputs[0]
        cls.console_top = make_release.console_release_name(cls.version)
        cls.agent_top = make_release.agent_release_name(cls.version)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def names(self, tarball: Path, top: str):
        prefix = f"{top}/"
        return {member.name[len(prefix):] for member in tar_members(tarball) if member.name.startswith(prefix)}

    def test_output_names_follow_version(self):
        self.assertRegex(self.version, make_release.VERSION_RE)
        self.assertEqual(self.console_tar.name, f"sdr-doa-ground-console-{self.version}-linux.tar.gz")
        self.assertEqual(self.agent_tar.name, f"sdr-doa-rdf-sdr-agent-{self.version}.tar.gz")
        self.assertEqual(self.docker_script.name, "sdr-doa-docker")
        self.assertEqual(self.checksums.name, "SHA256SUMS")

    def test_sha256sums_match_assets(self):
        lines = self.checksums.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 3)
        assets = sorted([self.console_tar, self.agent_tar, self.docker_script], key=lambda p: p.name)
        for line, asset in zip(lines, assets):
            digest, name = re.fullmatch(r"([0-9a-f]{64})  (\S+)", line).groups()
            self.assertEqual(name, asset.name)
            self.assertEqual(digest, hashlib.sha256(asset.read_bytes()).hexdigest())

    def test_standalone_docker_script(self):
        self.assertEqual(self.docker_script.read_bytes(), (ROOT / make_release.DOCKER_SCRIPT).read_bytes())
        self.assertEqual(stat.S_IMODE(self.docker_script.stat().st_mode), 0o755)
        self.assertEqual(
            tar_read(self.console_tar, f"{self.console_top}/{make_release.DOCKER_SCRIPT}"),
            self.docker_script.read_bytes(),
        )

    def test_builds_are_byte_identical(self):
        for first, second in zip(*self.outputs):
            self.assertEqual(first.read_bytes(), second.read_bytes(), first.name)

    def test_entries_are_normalized_and_sorted(self):
        for tarball, top in ((self.console_tar, self.console_top), (self.agent_tar, self.agent_top)):
            members = tar_members(tarball)
            names = [member.name for member in members]
            self.assertEqual(names[0], top)
            self.assertEqual(names[1:], sorted(names[1:]))
            for member in members:
                self.assertTrue(member.name == top or member.name.startswith(f"{top}/"), member.name)
                self.assertNotIn("..", member.name.split("/"))
                self.assertEqual((member.uid, member.gid, member.uname, member.gname), (0, 0, "root", "root"))
                self.assertEqual(member.mtime, EPOCH)
                self.assertTrue(member.isdir() or member.isfile(), member.name)
                self.assertIn(member.mode, (0o755, 0o644), member.name)
                if member.isdir():
                    self.assertEqual(member.mode, 0o755)
        with open(self.console_tar, "rb") as handle:
            header = handle.read(10)
        self.assertEqual(int.from_bytes(header[4:8], "little"), EPOCH, "gzip header mtime")

    def test_console_tarball_contents(self):
        names = self.names(self.console_tar, self.console_top)
        for required in (
            "VERSION",
            "MANIFEST.sha256",
            "README.md",
            "install.sh",
            ".env.example",
            "Dockerfile.release",
            "docker-compose.yml",
            "QUICKSTART.md",
            make_release.MANUAL_PDF,
            "frontend/dist/index.html",
            "frontend/dist/assets/index-abc.js",
            "frontend/dist/receiver/index.html",
            "frontend/dist/receiver/assets/app.js",
            "packaging/console/requirements.txt",
            "packaging/console/set_admin_password.py",
            "packaging/console/update_release.py",
            "packaging/console/sdr-doa-console",
            "packaging/console/sdr-doa-ground-console.service.in",
            "packaging/console/sdr-doa-ground-console.desktop.in",
            "packaging/docker/console-entrypoint.sh",
            "packaging/docker/healthcheck.py",
            "packaging/docker/sdr-doa-docker",
            "docker-compose.ghcr.yml",
            "wheels",
        ):
            self.assertIn(required, names)
        tools = {name.split("/", 1)[1] for name in names if name.startswith("tools/")}
        self.assertTrue(CONSOLE_MODULES <= tools, CONSOLE_MODULES - tools)
        self.assertEqual(tools, set(make_release.runtime_modules(make_release.CONSOLE_ENTRY)))
        self.assertEqual(tar_read(self.console_tar, f"{self.console_top}/VERSION").decode().strip(), self.version)
        compose = tar_read(self.console_tar, f"{self.console_top}/docker-compose.yml").decode()
        self.assertIn("dockerfile: Dockerfile.release", compose)

    def test_agent_tarball_contents(self):
        names = self.names(self.agent_tar, self.agent_top)
        tools = {name.split("/", 1)[1] for name in names if name.startswith("tools/")}
        self.assertEqual(tools, AGENT_MODULES)
        for required in (
            "VERSION",
            "MANIFEST.sha256",
            "README.md",
            "install.sh",
            "Dockerfile.agent",
            "docker-compose.yml",
            "packaging/agent/run-agent.sh",
            "packaging/agent/uninstall-agent.sh",
            "packaging/agent/sdr-doa-agent.service.in",
            "packaging/agent/agent.env.example",
        ):
            self.assertIn(required, names)
        compose = tar_read(self.agent_tar, f"{self.agent_top}/docker-compose.yml").decode()
        self.assertIn("dockerfile: Dockerfile.agent", compose)

    def test_nothing_private_or_generated_ships(self):
        for tarball in (self.console_tar, self.agent_tar):
            for member in tar_members(tarball):
                parts = member.name.split("/")
                base = parts[-1]
                self.assertFalse(base == ".env" or base.startswith(".env.") and base != ".env.example", member.name)
                self.assertFalse(base.startswith("test_") or base.endswith((".pyc", ".pyo")), member.name)
                for forbidden in ("node_modules", "__pycache__", "fixtures", ".git", ".venv"):
                    self.assertNotIn(forbidden, parts, member.name)

    def test_executables(self):
        executables = {
            (self.console_tar, f"{self.console_top}/{name}")
            for name in ("install.sh", "packaging/console/sdr-doa-console", "packaging/console/set_admin_password.py",
                         "packaging/console/update_release.py", "packaging/docker/console-entrypoint.sh",
                         "packaging/docker/sdr-doa-docker")
        } | {
            (self.agent_tar, f"{self.agent_top}/{name}")
            for name in ("install.sh", "packaging/agent/run-agent.sh", "packaging/agent/uninstall-agent.sh")
        }
        for tarball, name in executables:
            modes = {member.name: member.mode for member in tar_members(tarball)}
            self.assertEqual(modes[name], 0o755, name)
        modes = {member.name: member.mode for member in tar_members(self.console_tar)}
        self.assertEqual(modes[f"{self.console_top}/tools/ground_console.py"], 0o644)

    def test_manifest_covers_every_file(self):
        for tarball, top in ((self.console_tar, self.console_top), (self.agent_tar, self.agent_top)):
            with tarfile.open(tarball, "r:gz") as archive:
                files = {
                    member.name[len(top) + 1:]: archive.extractfile(member).read()
                    for member in archive.getmembers()
                    if member.isfile()
                }
            manifest = files.pop("MANIFEST.sha256").decode().splitlines()
            listed = {}
            for line in manifest:
                digest, name = re.fullmatch(r"([0-9a-f]{64})  (\S+)", line).groups()
                listed[name] = digest
            self.assertEqual(set(listed), set(files))
            for name, data in files.items():
                self.assertEqual(listed[name], hashlib.sha256(data).hexdigest(), name)

    def test_stage_console_tree(self):
        target = self.tmp / "stage-console"
        make_release.stage_tree(make_release.console_app_entries(ROOT, self.dist), target)
        self.assertTrue((target / "frontend/dist/receiver/index.html").is_file())
        self.assertFalse((target / "frontend/dist/node_modules").exists())
        self.assertFalse((target / "frontend/dist/.env").exists())
        self.assertEqual({path.name for path in (target / "tools").iterdir()}, set(make_release.runtime_modules(make_release.CONSOLE_ENTRY)))
        entrypoint = target / "packaging/docker/console-entrypoint.sh"
        self.assertTrue(entrypoint.stat().st_mode & stat.S_IXUSR)
        self.assertTrue((target / "packaging/console/update_release.py").is_file(), "an install from the repository can update too")
        self.assertFalse((target / "install.sh").exists(), "the app tree holds no installer")
        with self.assertRaises(make_release.ReleaseError):
            make_release.stage_tree(make_release.console_app_entries(ROOT, self.dist), target)

    def test_stage_agent_tree(self):
        target = self.tmp / "stage-agent"
        make_release.stage_tree(make_release.agent_app_entries(ROOT), target)
        self.assertEqual({path.name for path in (target / "tools").iterdir()}, AGENT_MODULES)
        self.assertTrue((target / "packaging/agent/run-agent.sh").stat().st_mode & stat.S_IXUSR)

    def test_dist_without_receiver_is_refused(self):
        dist = self.tmp / "no-receiver"
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text("x", encoding="utf-8")
        with self.assertRaisesRegex(make_release.ReleaseError, "receiver/index.html"):
            make_release.console_app_entries(ROOT, dist)
        with self.assertRaisesRegex(make_release.ReleaseError, "index.html"):
            make_release.console_app_entries(ROOT, self.tmp / "absent")

    def test_symlink_in_dist_is_refused(self):
        dist = self.tmp / "with-link"
        shutil.copytree(self.dist, dist)
        (dist / "assets" / "link.js").symlink_to(dist / "assets" / "index-abc.js")
        with self.assertRaisesRegex(make_release.ReleaseError, "symlink"):
            make_release.console_app_entries(ROOT, dist)

    def test_build_without_skip_build_rejects_dist_dir(self):
        with self.assertRaisesRegex(make_release.ReleaseError, "--skip-build"):
            make_release.build_release(ROOT, output_dir=self.tmp / "x", dist_dir=self.dist, allow_dirty=True)

    def test_command_line_skip_build(self):
        """The CLI as the docs run it, with checksums checked by sha256sum when present."""
        out = self.tmp / "cli"
        result = subprocess.run(
            [sys.executable, str(ROOT / "tools/make_release.py"), "--skip-build", "--allow-dirty",
             "--dist-dir", str(self.dist), "--output-dir", str(out), "--source-date-epoch", str(EPOCH)],
            capture_output=True, text=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        printed = [Path(line) for line in result.stdout.splitlines()]
        self.assertEqual([path.name for path in printed],
                         [self.console_tar.name, self.agent_tar.name, "sdr-doa-docker", "SHA256SUMS"])
        self.assertEqual((out / self.console_tar.name).read_bytes(), self.console_tar.read_bytes())
        if shutil.which("sha256sum"):
            check = subprocess.run(["sha256sum", "-c", "SHA256SUMS"], cwd=out, capture_output=True, text=True)
            self.assertEqual(check.returncode, 0, check.stdout + check.stderr)
        missing = subprocess.run(
            [sys.executable, str(ROOT / "tools/make_release.py"), "--skip-build", "--allow-dirty",
             "--dist-dir", str(self.tmp / "absent"), "--output-dir", str(self.tmp / "cli-missing")],
            capture_output=True, text=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        self.assertEqual(missing.returncode, 1)
        self.assertIn("release failed", missing.stderr)
        self.assertFalse((self.tmp / "cli-missing").exists())


class ReleaseHelperTests(unittest.TestCase):
    def test_runtime_modules_follow_lazy_and_relative_imports(self):
        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp)
            (tools / "entry.py").write_text(
                "import os\nfrom . import sibling\n\ndef later():\n    from lazy_mod import thing\n", encoding="utf-8"
            )
            (tools / "sibling.py").write_text("import json\n", encoding="utf-8")
            (tools / "lazy_mod.py").write_text("try:\n    from .deep import x\nexcept ImportError:\n    from deep import x\n", encoding="utf-8")
            (tools / "deep.py").write_text("x = 1\n", encoding="utf-8")
            (tools / "unused.py").write_text("", encoding="utf-8")
            self.assertEqual(make_release.runtime_modules("entry", tools), ["deep.py", "entry.py", "lazy_mod.py", "sibling.py"])
            (tools / "sibling.py").write_text("import test_helpers\n", encoding="utf-8")
            (tools / "test_helpers.py").write_text("", encoding="utf-8")
            with self.assertRaisesRegex(make_release.ReleaseError, "test module"):
                make_release.runtime_modules("entry", tools)

    def test_repository_entry_points(self):
        self.assertTrue(CONSOLE_MODULES <= set(make_release.runtime_modules(make_release.CONSOLE_ENTRY)))
        self.assertEqual(set(make_release.runtime_modules(make_release.AGENT_ENTRY)), AGENT_MODULES)

    def test_check_clean_reports_changes(self):
        def fake_git(root, *args):
            if args[0] == "rev-parse":
                return subprocess.CompletedProcess(args, 0, "true\n", "")
            return subprocess.CompletedProcess(args, 0, " M tools/ground_console.py\n?? packaging/new.sh\n", "")

        with mock.patch.object(make_release, "_git", fake_git):
            with self.assertRaisesRegex(make_release.ReleaseError, "uncommitted"):
                make_release.check_clean(ROOT, ["tools/ground_console.py"])

        def clean_git(root, *args):
            return subprocess.CompletedProcess(args, 0, "true\n" if args[0] == "rev-parse" else "", "")

        with mock.patch.object(make_release, "_git", clean_git):
            make_release.check_clean(ROOT, ["tools/ground_console.py"])
        with mock.patch.object(make_release, "_git", lambda *args: None):
            with self.assertRaisesRegex(make_release.ReleaseError, "not a git checkout"):
                make_release.check_clean(ROOT, ["VERSION"])

    def test_source_date_epoch(self):
        self.assertEqual(make_release.source_date_epoch(ROOT, 42), 42)
        with mock.patch.dict(os.environ, {"SOURCE_DATE_EPOCH": "1234"}):
            self.assertEqual(make_release.source_date_epoch(ROOT, None), 1234)
        with mock.patch.dict(os.environ, {"SOURCE_DATE_EPOCH": ""}), mock.patch.object(make_release, "_git", lambda *a: None):
            self.assertEqual(make_release.source_date_epoch(ROOT, None), make_release.FALLBACK_EPOCH)

    def test_version_file(self):
        self.assertEqual((ROOT / "VERSION").read_text(encoding="utf-8"), f"{make_release.read_version(ROOT)}\n")
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "VERSION").write_text("v2\n", encoding="utf-8")
            with self.assertRaises(make_release.ReleaseError):
                make_release.read_version(Path(tmp))


class DockerAndComposeTests(unittest.TestCase):
    """Static invariants: loopback-only console, host network, saved-settings paths."""

    def read(self, name: str) -> str:
        return (ROOT / name).read_text(encoding="utf-8")

    def test_dockerfile_agent_copies_the_agent_closure(self):
        copies = re.findall(r"^COPY (tools/\S+(?: tools/\S+)*) /opt/sdr-doa-agent/tools/$", self.read("Dockerfile.agent"), re.M)
        self.assertEqual(len(copies), 1)
        self.assertEqual({path.split("/", 1)[1] for path in copies[0].split()}, AGENT_MODULES)
        self.assertNotRegex(self.read("Dockerfile.agent"), r"(?m)^RUN ", "the agent image must cross-build without emulation")

    def test_compose_tags_follow_version(self):
        version = make_release.read_version(ROOT)
        for name in ("docker-compose.yml", "docker-compose.release.yml", "docker-compose.agent.yml"):
            tags = re.findall(r"^\s+image: \S+:(\S+)$", self.read(name), re.M)
            self.assertEqual(tags, [version], name)
        self.assertIn(f"sdr-doa-agent:{version}", self.read("Dockerfile.agent"))
        # The GHCR compose follows the major version's channel by default.
        major = version.split(".")[0]
        images = re.findall(r"(?m)^    image: (\S+)$", self.read("docker-compose.ghcr.yml"))
        self.assertEqual(images, ["${SDR_DOA_IMAGE:-ghcr.io/sanadunt/sdr-doa-ground-console}:${SDR_DOA_IMAGE_TAG:-%s}" % major])
        self.assertNotRegex(self.read("docker-compose.ghcr.yml"), r"(?m)^\s+build:")

    def test_every_compose_file_is_covered(self):
        self.assertEqual(
            set(COMPOSE_FILES),
            {"docker-compose.yml", "docker-compose.release.yml", "docker-compose.agent.yml", "docker-compose.ghcr.yml"},
            "a new compose file needs its place in these policy tests",
        )

    def test_compose_uses_host_network_and_no_published_ports(self):
        for name in COMPOSE_FILES:
            text = self.read(name)
            self.assertRegex(text, r"(?m)^    network_mode: host$", name)
            self.assertRegex(text, r"(?m)^    restart: unless-stopped$", name)
            self.assertNotRegex(text, r"(?m)^\s+ports:", name)
            # An empty value would disable admin login; pass-through stays unset when not given.
            self.assertNotRegex(text, r"(?m)^\s+(- )?SDR_DOA_ADMIN_PASSWORD[=:]", name)
        for name in CONSOLE_COMPOSE_FILES:
            self.assertRegex(self.read(name), r"(?m)^name: sdr-doa-ground-console$", name)
            self.assertRegex(self.read(name), r"(?m)^      - SDR_DOA_ADMIN_PASSWORD$", name)
            self.assertRegex(self.read(name), r"(?m)^      - sdr-doa-data:/data$", name)
            self.assertNotIn("0.0.0.0", self.read(name), name)
        environment = [re.findall(r"(?m)^      - (SDR_DOA_\w+)", self.read(name)) for name in CONSOLE_COMPOSE_FILES]
        self.assertTrue(all(names == environment[0] for names in environment), environment)

    def test_console_images(self):
        for name in ("Dockerfile", "Dockerfile.release"):
            text = self.read(name)
            self.assertIn("USER 10001:10001", text)
            self.assertIn('VOLUME ["/data"]', text)
            self.assertIn("packaging/docker/healthcheck.py", text)
            self.assertIn('ENTRYPOINT ["/opt/sdr-doa-ground-console/packaging/docker/console-entrypoint.sh"]', text)
            self.assertNotIn("0.0.0.0", text)

    def test_every_launch_path_uses_the_data_directory_and_loopback(self):
        flags = ("--bind 127.0.0.1", "--config-path", "--branding-path", "--preferences-path", "--data-dir", "--tile-cache-dir", "--env-file")
        sources = {
            "packaging/docker/console-entrypoint.sh": self.read("packaging/docker/console-entrypoint.sh").replace("\\\n", " "),
            "packaging/console/sdr-doa-ground-console.service.in": self.read("packaging/console/sdr-doa-ground-console.service.in"),
            "packaging/console/sdr-doa-console": self.read("packaging/console/sdr-doa-console").replace("\\\n", " "),
        }
        for name, text in sources.items():
            code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
            compact = re.sub(r"\s+", " ", code)
            for flag in flags:
                self.assertIn(flag, compact, f"{name} lacks {flag}")
            for override in ("--base-url", "--mqtt-host", "--mqtt-port", "--mqtt-transport", "--mqtt-ws-path"):
                self.assertNotIn(override, compact, f"{name} must not override saved settings with {override}")

    def test_dockerignore_keeps_secrets_and_the_submodule_metadata(self):
        lines = self.read(".dockerignore").splitlines()
        for pattern in (".env", ".git", "!.git/modules/vendor/BrowSDR", "**/node_modules", "frontend/dist", "data", "agent.env"):
            self.assertIn(pattern, lines)
        self.assertNotIn("vendor", lines)


def _sh() -> str:
    return shutil.which("sh") or "/bin/sh"


class PackagingScriptTests(unittest.TestCase):
    def test_shell_syntax(self):
        shells = [shell for shell in ("sh", "bash", "dash") if shutil.which(shell)]
        self.assertTrue(shells)
        for script in SHELL_SCRIPTS:
            for shell in shells:
                result = subprocess.run([shell, "-n", str(ROOT / script)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, f"{shell} -n {script}: {result.stderr}")
            self.assertTrue(os.access(ROOT / script, os.X_OK), f"{script} is not executable")

    def run_agent(self, env: dict, *args: str) -> subprocess.CompletedProcess:
        environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "SDR_DOA_AGENT_PRINT_COMMAND": "1", **env}
        return subprocess.run(
            [_sh(), str(ROOT / "packaging/agent/run-agent.sh"), *args],
            capture_output=True,
            text=True,
            env=environment,
        )

    def test_run_agent_builds_flags_from_agent_env(self):
        result = self.run_agent(
            {
                "BASE_URL": "http://127.0.0.1:8081",
                "MQTT_HOST": "10.90.0.2",
                "MQTT_PORT": "8883",
                "MQTT_CAFILE": "/etc/ca.crt",
                "MQTT_USERNAME": "agent",
                "PUBLISH": "1",
                "ENABLE_CONFIG": "1",
                "SETTINGS_PATH": "/srv/_share/settings.json",
                "STATE_DIR": "/var/lib/x",
                "DOA_RATE": "0",
            },
            "--once",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        words = result.stdout.split()
        self.assertTrue(words[1].endswith("tools/sdr_doa_lan_agent.py"))
        command = " ".join(words[2:])
        for expected in (
            "--base-url http://127.0.0.1:8081",
            "--mqtt-host 10.90.0.2 --mqtt-port 8883",
            "--state-dir /var/lib/x",
            "--mqtt-cafile /etc/ca.crt",
            "--mqtt-username agent",
            "--publish",
            "--enable-config",
            "--settings-path /srv/_share/settings.json",
            "--doa-rate 0",
        ):
            self.assertIn(expected, command)
        self.assertNotIn("--mqtt-tls", command)
        self.assertEqual(words[-1], "--once", "explicit arguments come after the generated flags")

    def test_run_agent_defaults_and_errors(self):
        result = self.run_agent({})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--publish", result.stdout)
        self.assertNotIn("--enable-config", result.stdout)
        self.assertIn("--mqtt-host 127.0.0.1 --mqtt-port 1883", result.stdout)
        self.assertNotIn("--publish", self.run_agent({"PUBLISH": "0"}).stdout)
        missing = self.run_agent({"ENABLE_CONFIG": "1"})
        self.assertEqual(missing.returncode, 78)
        self.assertIn("SETTINGS_PATH", missing.stderr)
        self.assertEqual(self.run_agent({"PUBLISH": "maybe"}).returncode, 78)

    def test_agent_runner_accepts_its_own_flags(self):
        """Every flag run-agent can emit exists in sdr_doa_lan_agent.py."""
        sys.path.insert(0, str(ROOT / "tools"))
        import sdr_doa_lan_agent

        known = set()
        for action in sdr_doa_lan_agent._build_parser()._actions:
            known.update(action.option_strings)
        emitted = set(re.findall(r'set -- "\$@" (--[a-z-]+)', (ROOT / "packaging/agent/run-agent.sh").read_text()))
        emitted |= set(re.findall(r'"\$@" --[a-z-]+ "[^"]*" (--[a-z-]+)', (ROOT / "packaging/agent/run-agent.sh").read_text()))
        self.assertTrue(emitted)
        self.assertEqual(emitted - known, set())

    def test_install_agent_into_a_root_and_uninstall(self):
        with tempfile.TemporaryDirectory(prefix="agent-root-") as tmp:
            root = Path(tmp)
            env = {**os.environ, "SDR_DOA_MQTT_PASSWORD": "p4ss"}
            result = subprocess.run(
                [_sh(), str(ROOT / "packaging/agent/install-agent.sh"), "--root", str(root), "--user", "nobody",
                 "--mqtt-host", "10.90.0.2", "--mqtt-port=8883", "--mqtt-tls", "--mqtt-username", "agent", "--enable-config",
                 "--set", "DOA_RATE=0", "--set=HEALTH_INTERVAL=2"],
                capture_output=True, text=True, env=env,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            prefix = root / "opt/sdr-doa-agent"
            self.assertEqual({path.name for path in (prefix / "tools").iterdir()}, AGENT_MODULES)
            self.assertTrue(os.access(prefix / "bin/run-agent", os.X_OK))
            self.assertTrue((prefix / "uninstall.sh").is_file())
            agent_env = root / "etc/sdr-doa-agent/agent.env"
            self.assertEqual(stat.S_IMODE(agent_env.stat().st_mode), 0o640)
            values = dict(line.split("=", 1) for line in agent_env.read_text().splitlines() if line and not line.startswith("#"))
            self.assertEqual(values["MQTT_HOST"], "10.90.0.2")
            self.assertEqual(values["MQTT_PORT"], "8883")
            self.assertEqual(values["MQTT_TLS"], "1")
            self.assertEqual(values["ENABLE_CONFIG"], "1")
            self.assertEqual(values["PUBLISH"], "1")
            self.assertEqual(values["SDR_DOA_MQTT_PASSWORD"], "p4ss")
            self.assertEqual(values["STATE_DIR"], "/var/lib/sdr-doa-agent")
            self.assertEqual(values["BASE_URL"], "http://127.0.0.1:8081")
            self.assertEqual(values["DOA_RATE"], "0")
            self.assertEqual(values["HEALTH_INTERVAL"], "2")
            unit_path = root / "etc/systemd/system/sdr-doa-agent.service"
            unit = unit_path.read_text()
            self.assertIn("ExecStart=/opt/sdr-doa-agent/bin/run-agent", unit)
            self.assertIn("EnvironmentFile=/etc/sdr-doa-agent/agent.env", unit)
            self.assertIn("User=nobody", unit)
            self.assertIn("ReadWritePaths=-/home/doasdr/doasdr/_share", unit)
            self.assertIn("Restart=on-failure", unit)
            self.assertIn("WantedBy=multi-user.target", unit)
            self.assertNotRegex(unit, r"@[A-Z_]+@")
            self.assertTrue((root / "var/lib/sdr-doa-agent").is_dir())
            self.assertNotIn("p4ss", result.stdout + result.stderr)

            # Upgrade: agent.env is kept, only given flags change.
            agent_env.write_text(agent_env.read_text().replace("BASE_URL=http://127.0.0.1:8081", "BASE_URL=http://127.0.0.1:9999"))
            again = subprocess.run(
                [_sh(), str(ROOT / "packaging/agent/install-agent.sh"), "--root", str(root), "--user", "nobody", "--disable-config"],
                capture_output=True, text=True, env={k: v for k, v in os.environ.items() if k != "SDR_DOA_MQTT_PASSWORD"},
            )
            self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
            values = dict(line.split("=", 1) for line in agent_env.read_text().splitlines() if line and not line.startswith("#"))
            self.assertEqual(values["BASE_URL"], "http://127.0.0.1:9999")
            self.assertEqual(values["ENABLE_CONFIG"], "0")
            self.assertEqual(values["MQTT_HOST"], "10.90.0.2")
            self.assertEqual(values["SDR_DOA_MQTT_PASSWORD"], "p4ss")
            self.assertEqual(values["DOA_RATE"], "0")
            unit = unit_path.read_text()
            self.assertNotRegex(unit, r"(?m)^ReadWritePaths=-/home/doasdr", "settings stay read-only without config")
            self.assertIn("ReadWritePaths=/var/lib/sdr-doa-agent", unit)

            removed = subprocess.run(
                [_sh(), str(prefix / "uninstall.sh"), "--root", str(root)], capture_output=True, text=True
            )
            self.assertEqual(removed.returncode, 0, removed.stdout + removed.stderr)
            self.assertFalse(prefix.exists())
            self.assertFalse((root / "etc/systemd/system/sdr-doa-agent.service").exists())
            self.assertTrue(agent_env.is_file(), "agent.env stays without --purge")

    def test_install_agent_dry_run_changes_nothing(self):
        with tempfile.TemporaryDirectory(prefix="agent-dry-") as tmp:
            result = subprocess.run(
                [_sh(), str(ROOT / "packaging/agent/install-agent.sh"), "--dry-run", "--user", "nobody",
                 "--prefix", f"{tmp}/opt", "--config-dir", f"{tmp}/etc", "--state-dir", f"{tmp}/state"],
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(list(Path(tmp).iterdir()), [])
        self.assertIn("would run: systemctl enable sdr-doa-agent.service", result.stdout)
        self.assertIn("PUBLISH=1", result.stdout)
        self.assertIn("ENABLE_CONFIG=0", result.stdout)
        self.assertIn("tools/sdr_doa_lan_agent.py --base-url http://127.0.0.1:8081", result.stdout)
        self.assertIn("Dry run: nothing was changed.", result.stdout)

    def test_install_agent_set_only_takes_known_variables(self):
        for value, message in (("NOPE=1", "does not know NOPE"), ("STATE_DIR=/x", "--state-dir"),
                               ("SDR_DOA_MQTT_PASSWORD=x", "SDR_DOA_MQTT_PASSWORD"), ("DOA_RATE", "NAME=VALUE")):
            result = subprocess.run(
                [_sh(), str(ROOT / "packaging/agent/install-agent.sh"), "--dry-run", "--set", value],
                capture_output=True, text=True,
            )
            self.assertNotEqual(result.returncode, 0, value)
            self.assertIn(message, result.stderr, value)

    def test_run_agent_stops_when_config_cannot_write_settings(self):
        with tempfile.TemporaryDirectory(prefix="agent-settings-") as tmp:
            settings = Path(tmp) / "missing" / "settings.json"
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "ENABLE_CONFIG": "1", "SETTINGS_PATH": str(settings),
                   "PUBLISH": "1", "SDR_DOA_AGENT_PYTHON": "/bin/false"}
            result = subprocess.run([_sh(), str(ROOT / "packaging/agent/run-agent.sh")], capture_output=True, text=True, env=env)
        self.assertEqual(result.returncode, 78, result.stderr)
        self.assertIn("cannot write", result.stderr)
        self.assertIn("--enable-config", result.stderr)

    def test_install_agent_refuses_a_root_service_user(self):
        result = subprocess.run(
            [_sh(), str(ROOT / "packaging/agent/install-agent.sh"), "--dry-run", "--user", "root"],
            capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must not run as root", result.stderr)

    def test_install_agent_rejects_unsafe_values(self):
        result = subprocess.run(
            [_sh(), str(ROOT / "packaging/agent/install-agent.sh"), "--dry-run", "--mqtt-host", "1.2.3.4; rm"],
            capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must not contain", result.stderr)

    def test_console_entrypoint(self):
        with tempfile.TemporaryDirectory(prefix="entrypoint-") as tmp:
            app = Path(tmp) / "app"
            (app / "tools").mkdir(parents=True)
            (app / "tools/ground_console.py").write_text("import sys\nprint(' '.join(sys.argv[1:]))\n", encoding="utf-8")
            env = {
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "SDR_DOA_APP_DIR": str(app),
                "SDR_DOA_DATA_DIR": f"{tmp}/data",
                "SDR_DOA_PYTHON": sys.executable,
                "SDR_DOA_PORT": "8790",
            }
            script = str(ROOT / "packaging/docker/console-entrypoint.sh")
            result = subprocess.run([_sh(), script, "--legacy-ui"], capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = f"{tmp}/data"
            self.assertEqual(
                result.stdout.split(),
                ["--bind", "127.0.0.1", "--port", "8790", "--config-path", f"{data}/console.json",
                 "--branding-path", f"{data}/branding.json", "--preferences-path", f"{data}/preferences.json",
                 "--data-dir", f"{data}/receiver", "--tile-cache-dir", f"{data}/tiles", "--env-file", f"{data}/.env",
                 "--legacy-ui"],
            )
            self.assertTrue(Path(data, "receiver").is_dir())
            bad = subprocess.run([_sh(), script], capture_output=True, text=True, env={**env, "SDR_DOA_PORT": "80a"})
            self.assertEqual(bad.returncode, 64)

    def render_launcher(self, base: Path) -> Path:
        """The sdr-doa-console launcher over a fake install whose health check logs each call."""
        app, data = base / "app", base / "data"
        (app / "venv/bin").mkdir(parents=True)
        (app / "venv/bin/python").symlink_to(sys.executable)
        (app / "packaging/console").mkdir(parents=True)
        shutil.copy(ROOT / "packaging/console/set_admin_password.py", app / "packaging/console/")
        (app / "packaging/docker").mkdir(parents=True)
        (app / "packaging/docker/healthcheck.py").write_text(
            f"open({str(base / 'health-calls')!r}, 'a').write('x')\n", encoding="utf-8"
        )
        (app / "VERSION").write_text("9.9.9\n", encoding="utf-8")
        launcher = base / "sdr-doa-console"
        text = (ROOT / "packaging/console/sdr-doa-console").read_text(encoding="utf-8")
        for name, value in (("APP_DIR", app), ("DATA_DIR", data), ("PORT", "8791"), ("BIN_PATH", launcher),
                            ("UNIT_FILE", base / "no.service"), ("DESKTOP_FILE", base / "no.desktop")):
            text = text.replace(f"@{name}@", str(value))
        self.assertNotRegex(text, r"@[A-Z_]+@")
        launcher.write_text(text, encoding="utf-8")
        launcher.chmod(0o755)
        return launcher

    def test_launcher_password_status_does_not_restart(self):
        with tempfile.TemporaryDirectory(prefix="launcher-") as tmp:
            base = Path(tmp)
            launcher = self.render_launcher(base)
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": tmp}
            status = subprocess.run([_sh(), str(launcher), "password", "--status"], capture_output=True, text=True, env=env)
            self.assertEqual(status.returncode, 0, status.stderr)
            self.assertEqual(status.stdout.strip(), "default")
            self.assertFalse((base / "health-calls").exists(), "--status must not touch the running console")
            # A change restarts a console that answers; this fake one answers but was not
            # started by the launcher, so the restart refuses to start a second one.
            changed = subprocess.run([_sh(), str(launcher), "password", "--default"], capture_output=True, text=True, env=env)
            self.assertTrue((base / "health-calls").exists())
            self.assertIn("already answers", changed.stderr)
            info = subprocess.run([_sh(), str(launcher), "info"], capture_output=True, text=True, env=env)
            self.assertIn("9.9.9", info.stdout)
            self.assertIn("none (sdr-doa-console start)", info.stdout)

    def test_launcher_uninstall_purge_removes_every_data_file(self):
        with tempfile.TemporaryDirectory(prefix="launcher-") as tmp:
            base = Path(tmp)
            launcher = self.render_launcher(base)
            (base / "app/.sdr-doa-console-install").write_text("", encoding="utf-8")
            data = base / "data"
            for name in ("console.json", "branding.json", "preferences.json", ".env", "receiver/receiver.sqlite3",
                         "tiles/osm/1/0/0.png"):
                (data / name).parent.mkdir(parents=True, exist_ok=True)
                (data / name).write_text("x", encoding="utf-8")
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": tmp}
            result = subprocess.run([_sh(), str(launcher), "uninstall", "--purge", "--yes"],
                                    capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(data.exists(), "--purge leaves nothing behind, the tile cache included")
            self.assertFalse((base / "app").exists())
            self.assertFalse(launcher.exists())

    def test_console_installer_help_and_root_refusal(self):
        result = subprocess.run([_sh(), str(ROOT / "packaging/console/install.sh"), "--help"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn("--no-service", result.stdout)
        bad = subprocess.run(
            [_sh(), str(ROOT / "packaging/console/install.sh"), "--prefix", "relative/path"], capture_output=True, text=True
        )
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn("absolute", bad.stderr)


class AdminPasswordHelperTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(ROOT / "packaging/console"))
        import set_admin_password

        self.helper = set_admin_password
        self._tmp = tempfile.TemporaryDirectory(prefix="admin-env-")
        self.env_file = Path(self._tmp.name) / "data" / ".env"

    def tearDown(self):
        self._tmp.cleanup()

    def run_helper(self, *args: str, stdin: str = ""):
        return subprocess.run(
            [sys.executable, str(ROOT / "packaging/console/set_admin_password.py"), "--env-file", str(self.env_file), *args],
            input=stdin, capture_output=True, text=True, encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )

    def console_reads(self) -> dict:
        import ground_console

        reader = getattr(ground_console, "_read_dotenv", None)
        if reader is None:
            self.skipTest("ground_console has no _read_dotenv")
        return reader(self.env_file)

    def test_round_trip_through_the_console_parser(self):
        for password in ("plain", 'with "quotes" inside', "'single'", '"double"', "  spaced  ", "x=y#z", "ünï"):
            result = self.run_helper("--stdin", stdin=password + "\n")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.console_reads().get("SDR_DOA_ADMIN_PASSWORD"), password)
            self.assertEqual(stat.S_IMODE(self.env_file.stat().st_mode), 0o600)
            self.assertEqual(self.helper.status(self.env_file), "set")

    def test_default_keeps_other_lines_and_removes_the_password(self):
        self.env_file.parent.mkdir(parents=True)
        self.env_file.write_text("# mine\nOTHER=1\nexport SDR_DOA_ADMIN_PASSWORD=old\n", encoding="utf-8")
        self.assertEqual(self.helper.status(self.env_file), "set")
        self.assertEqual(self.run_helper("--default").returncode, 0)
        text = self.env_file.read_text(encoding="utf-8")
        self.assertIn("# mine\nOTHER=1\n", text)
        self.assertNotIn("old", text)
        self.assertEqual(self.helper.status(self.env_file), "default")
        self.assertNotIn("SDR_DOA_ADMIN_PASSWORD", self.console_reads())

    def test_generate_and_status(self):
        self.assertEqual(self.run_helper("--status").stdout.strip(), "default")
        result = self.run_helper("--generate", "--quiet")
        self.assertEqual(result.returncode, 0)
        generated = re.search(r"Generated admin password: (\S+)", result.stderr).group(1)
        self.assertGreaterEqual(len(generated), 16)
        self.assertEqual(self.console_reads()["SDR_DOA_ADMIN_PASSWORD"], generated)
        self.env_file.write_text("SDR_DOA_ADMIN_PASSWORD=\n", encoding="utf-8")
        self.assertEqual(self.run_helper("--status").stdout.strip(), "disabled")

    def test_rejects_empty_and_multiline(self):
        self.assertNotEqual(self.run_helper("--stdin", stdin="\n").returncode, 0)
        self.assertFalse(self.env_file.exists())
        with self.assertRaises(self.helper.PasswordError):
            self.helper.validate("a\rb")


if __name__ == "__main__":
    unittest.main()
