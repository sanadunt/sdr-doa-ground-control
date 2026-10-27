#!/usr/bin/env python3
"""Tests for packaging/docker/sdr-doa-docker, the Docker host script.

The script runs with sh against a fake docker binary (SDR_DOA_DOCKER) that
keeps its images, tags, containers and a fake registry in a JSON file and
logs every call, and a fake systemctl; units go to SDR_DOA_SYSTEMD_DIR and
the installed copy of the script to SDR_DOA_BIN_DIR. No daemon, network,
systemd or file outside the temporary directory is touched.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "packaging/docker/sdr-doa-docker"
GHCR_COMPOSE = ROOT / "docker-compose.ghcr.yml"
CONSOLE_IMAGE = "ghcr.io/sanadunt/sdr-doa-ground-console"
# The image of the RDF-SDR agent installs that sdr-doa-docker 2 wrote.
OLD_AGENT_IMAGE = "ghcr.io/sanadunt/sdr-doa-rdf-sdr-agent"
MARKER = "# Written by sdr-doa-docker"
# The default channel the script writes, so a major bump changes one place.
CHANNEL = re.search(r"(?m)^DEFAULT_CHANNEL=(\S+)$", SCRIPT.read_text(encoding="utf-8")).group(1)


def image_id(letter: str) -> str:
    return "sha256:" + letter * 64


def digest(letter: str) -> str:
    return "sha256:" + hashlib_hex(letter)


def hashlib_hex(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.encode()).hexdigest()


# The fake docker: just enough of docker, docker compose and buildx for the
# script. Behaviour per image ID decides what a container of that image
# reports on each inspect: healthy (starting, then healthy), slow (always
# starting), unhealthy, exited, restart (the restart count goes up) and none
# (no health check, running).
FAKE_DOCKER = r'''
import hashlib
import json
import os
import re
import sys

STATE = os.environ["FAKE_DOCKER_STATE"]
CALLS = os.environ["FAKE_DOCKER_CALLS"]


def load():
    with open(STATE, encoding="utf-8") as handle:
        return json.load(handle)


def save(state):
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=1, sort_keys=True)
    os.replace(tmp, STATE)


def fail(message, code=1):
    sys.stderr.write(message + "\n")
    save(state)
    sys.exit(code)


def resolve(state, name):
    if name in state["tags"]:
        return state["tags"][name]
    if name in state["images"]:
        return name
    return None


def untag(state, name):
    state["tags"].pop(name, None)


def tags_of(state, ident):
    return sorted(tag for tag, value in state["tags"].items() if value == ident)


def pull(state, ref):
    if state.get("pull_fails"):
        fail("Error response from daemon: Get \"https://ghcr.io/v2/\": dial tcp: lookup ghcr.io: no such host")
    entry = state["registry"].get(ref)
    if entry is None:
        fail(f"Error response from daemon: manifest unknown: {ref}")
    image = state["images"].setdefault(entry["id"], {"version": entry.get("version", ""), "repo_digests": []})
    repo = ref.rsplit(":", 1)[0]
    pinned = f"{repo}@{entry['digest']}"
    if pinned not in image["repo_digests"]:
        image["repo_digests"].append(pinned)
    state["tags"][ref] = entry["id"]
    return entry["id"]


def interpolate(text, env):
    def value(match):
        name, default = match.group(1), match.group(3)
        found = env.get(name)
        if found:
            return found
        return default if default is not None else ""

    return re.sub(r"\$\{([A-Z_]+)(:-([^}]*))?\}", value, text)


def dotenv(path):
    values = {}
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, val = line.partition("=")
                values[key] = val
    return values


def compose(state, args):
    project = None
    files = []
    while args and args[0].startswith("-"):
        flag = args.pop(0)
        if flag == "-p":
            project = args.pop(0)
        elif flag == "-f":
            files.append(args.pop(0))
        else:
            fail(f"fake compose: unknown flag {flag}")
    if not args:
        fail("fake compose: no subcommand")
    sub = args.pop(0)
    if sub == "version":
        if state.get("no_compose"):
            fail("docker: 'compose' is not a docker command.")
        print("2.29.7" if "--short" in args else "Docker Compose version v2.29.7")
        return
    if sub == "up" and "--help" in args:
        print("Usage:  docker compose up [OPTIONS] [SERVICE...]")
        if not state.get("compose_old"):
            print('      --pull string    Pull image before running ("always"|"missing"|"never")')
        return
    if project is None or files != ["compose.yml"]:
        fail(f"fake compose: expected -p PROJECT -f compose.yml, got {project} {files}")
    text = open(files[0], encoding="utf-8").read()
    env = {**dotenv(".env"), **{k: v for k, v in os.environ.items() if k.startswith("SDR_DOA_")}}
    services = re.findall(r"(?m)^  ([a-z]+):\s*$", text.split("\nservices:\n", 1)[1].split("\nvolumes:\n", 1)[0])
    service = services[0]
    image_line = re.search(r"(?m)^    image: (.+)$", text).group(1)
    ref = interpolate(image_line, env)
    key = f"{project}/{service}"
    if sub == "up":
        if state.get("up_fails"):
            fail("Error response from daemon: fake up failure")
        if "--pull" in args and state.get("compose_old"):
            fail("unknown flag: --pull")
        ident = resolve(state, ref)
        if ident is None:
            if "--pull" in args and args[args.index("--pull") + 1] == "never":
                fail(f"Error response from daemon: No such image: {ref}")
            ident = pull(state, ref)
        config = hashlib.sha256((text + json.dumps(sorted(env.items()))).encode()).hexdigest()
        old = state["containers"].get(key)
        if old and old["image"] == ident and old["config"] == config and not old.get("stopped"):
            return
        state["counter"] += 1
        state["containers"][key] = {
            "id": "c%062d" % state["counter"],
            "image": ident,
            "config": config,
            "inspects": 0,
            "stopped": False,
            "ref": ref,
        }
        return
    if sub == "logs":
        print("fake logs")
        return
    fail(f"fake compose: unknown subcommand {sub}")


def container_state(state, container):
    container["inspects"] += 1
    count = container["inspects"]
    if container.get("stopped"):
        return "exited", "none", 0, 0
    behaviour = state["behaviour"].get(container["image"], "healthy")
    if behaviour == "healthy":
        return "running", "starting" if count == 1 else "healthy", 0, 0
    if behaviour == "slow":
        return "running", "starting", 0, 0
    if behaviour == "unhealthy":
        return "running", "starting" if count == 1 else "unhealthy", 0, 0
    if behaviour == "exited":
        return "exited", "unhealthy", 0, 1
    if behaviour == "restart":
        return "running", "starting", 0 if count == 1 else 1, 1
    if behaviour == "none":
        return "running", "none", 0, 0
    raise SystemExit(f"unknown behaviour {behaviour}")


state = load()
argv = sys.argv[1:]
with open(CALLS, "a", encoding="utf-8") as handle:
    handle.write(json.dumps({
        "argv": argv,
        "cwd": os.getcwd(),
        "env": {k: v for k, v in os.environ.items()
                if k in ("SDR_DOA_IMAGE", "SDR_DOA_IMAGE_TAG", "SDR_DOA_PORT", "SDR_DOA_ADMIN_PASSWORD", "SDR_DOA_SEED_BASE_URL")},
    }) + "\n")

if state.get("daemon_down") and argv[:1] != ["compose"]:
    fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?")

cmd = argv[0] if argv else ""
if cmd == "info":
    print("fake docker info")
elif cmd == "compose":
    compose(state, argv[1:])
elif cmd == "pull":
    ref = [arg for arg in argv[1:] if not arg.startswith("-")][0]
    pull(state, ref)
    print(ref)
elif cmd == "tag":
    source, target = argv[1], argv[2]
    ident = resolve(state, source)
    if ident is None:
        fail(f"Error response from daemon: No such image: {source}")
    state["tags"][target] = ident
elif cmd == "image" and argv[1] == "inspect":
    fmt = argv[argv.index("--format") + 1]
    name = argv[-1]
    ident = resolve(state, name)
    if ident is None:
        fail(f"Error: No such image: {name}")
    image = state["images"][ident]
    if fmt == "{{.Id}}":
        print(ident)
    elif "org.opencontainers.image.version" in fmt:
        print(image.get("version") or "")
    elif "RepoDigests" in fmt:
        for line in image.get("repo_digests", []):
            print(line)
    else:
        fail(f"fake docker: unknown image format {fmt}")
elif cmd == "image" and argv[1] == "rm":
    name = argv[2]
    if name in state["tags"]:
        ident = state["tags"][name]
        untag(state, name)
        if tags_of(state, ident):
            print(f"Untagged: {name}")
        else:
            used = [c for c in state["containers"].values() if c["image"] == ident]
            if not used:
                state["images"].pop(ident, None)
            print(f"Untagged: {name}")
    elif name in state["images"]:
        if len(tags_of(state, name)) > 1:
            fail(f"Error response from daemon: conflict: unable to delete {name[7:19]} (must be forced) - image is referenced in multiple repositories")
        if any(c["image"] == name for c in state["containers"].values()):
            fail(f"Error response from daemon: conflict: unable to delete {name[7:19]} - image is being used by a container")
        for tag in tags_of(state, name):
            untag(state, tag)
        state["images"].pop(name)
        print(f"Deleted: {name}")
    else:
        fail(f"Error response from daemon: No such image: {name}")
elif cmd == "ps":
    labels = dict(arg.split("=", 2)[1:] for arg in argv if arg.startswith("label="))
    for key, container in sorted(state["containers"].items()):
        project, service = key.split("/")
        if labels.get("com.docker.compose.project") == project and labels.get("com.docker.compose.service") == service:
            print(container["id"])
elif cmd == "inspect":
    fmt = argv[argv.index("--format") + 1]
    if ".State.Status" not in fmt or "--type" not in argv:
        fail(f"fake docker: unknown inspect {argv}")
    wanted = argv[-1]
    for container in state["containers"].values():
        if container["id"] == wanted:
            status, health, restarts, code = container_state(state, container)
            print(f"{status}|{health}|{restarts}|{code}|{container['image']}")
            break
    else:
        fail(f"Error: No such container: {wanted}")
elif cmd == "exec":
    # docker exec CID python HEALTHCHECK --busy
    if argv[2:] != ["python", "/opt/sdr-doa-ground-console/packaging/docker/healthcheck.py", "--busy"]:
        fail(f"fake docker: unknown exec {argv}")
    if not any(c["id"] == argv[1] for c in state["containers"].values()):
        fail(f"Error response from daemon: No such container: {argv[1]}")
    if state.get("busy_unsupported"):
        print("unhealthy: invalid port '--busy'")
        save(state)
        sys.exit(1)
    print("busy" if state.get("receiver_busy") else "idle")
elif cmd == "buildx" and argv[1:3] == ["imagetools", "inspect"]:
    if state.get("no_buildx"):
        fail("docker: 'buildx' is not a docker command.")
    ref = argv[-1]
    entry = state["registry"].get(ref)
    if entry is None:
        fail(f"ERROR: {ref}: not found")
    print(json.dumps({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "digest": entry["digest"],
        "size": 1609,
        "manifests": [{"mediaType": "application/vnd.oci.image.manifest.v1+json",
                       "digest": "sha256:" + "f" * 64, "size": 1000}],
    }, indent=2))
else:
    fail(f"fake docker: unknown command {argv}")
save(state)
'''

FAKE_SYSTEMCTL = r'''#!/bin/sh
printf '%s\n' "$*" >>"$FAKE_SYSTEMCTL_CALLS"
case $1 in
  is-enabled) echo enabled ;;
  is-active) echo active ;;
esac
exit 0
'''

FAKE_ID = r'''#!/bin/sh
if [ "${1:-}" = -u ] && [ $# -eq 1 ]; then echo 1000; exit 0; fi
exec /usr/bin/id "$@"
'''
# The same for root, so the root paths (auto-update on) also run in a test
# that is not root, as on a CI runner; every path they write is redirected.
FAKE_ROOT_ID = FAKE_ID.replace("echo 1000", "echo 0")


class Harness:
    """A temporary host: fake docker, fake systemctl, the script's directories."""

    def __init__(self, base: Path):
        self.base = base
        self.bin = base / "bin"
        self.bin.mkdir()
        self.state_path = base / "docker-state.json"
        self.calls_path = base / "docker-calls.jsonl"
        self.systemctl_calls = base / "systemctl-calls"
        self.systemd = base / "systemd"
        self.installed_bin = base / "usr-local-bin"
        self.home = base / "home"
        self.home.mkdir()
        docker = self.bin / "docker"
        docker.write_text(f"#!{sys.executable}\n" + FAKE_DOCKER, encoding="utf-8")
        docker.chmod(0o755)
        systemctl = self.bin / "systemctl"
        systemctl.write_text(FAKE_SYSTEMCTL, encoding="utf-8")
        systemctl.chmod(0o755)
        self.nonroot_bin = base / "nonroot-bin"
        self.nonroot_bin.mkdir()
        fake_id = self.nonroot_bin / "id"
        fake_id.write_text(FAKE_ID, encoding="utf-8")
        fake_id.chmod(0o755)
        self.root_bin = base / "root-bin"
        self.root_bin.mkdir()
        fake_root_id = self.root_bin / "id"
        fake_root_id.write_text(FAKE_ROOT_ID, encoding="utf-8")
        fake_root_id.chmod(0o755)
        self.write_state({
            "registry": {},
            "images": {},
            "tags": {},
            "containers": {},
            "behaviour": {},
            "counter": 0,
        })
        self.publish(f"{CONSOLE_IMAGE}:{CHANNEL}", "a", "2.0.0")

    # state -------------------------------------------------------------------
    def read_state(self) -> dict:
        return json.loads(self.state_path.read_text(encoding="utf-8"))

    def write_state(self, state: dict) -> None:
        self.state_path.write_text(json.dumps(state, indent=1, sort_keys=True), encoding="utf-8")

    def update_state(self, **values) -> None:
        state = self.read_state()
        state.update(values)
        self.write_state(state)

    def publish(self, ref: str, letter: str, version: str, behaviour: str = "healthy") -> str:
        state = self.read_state()
        ident = image_id(letter)
        state["registry"][ref] = {"id": ident, "digest": digest(letter), "version": version}
        state["behaviour"][ident] = behaviour
        self.write_state(state)
        return ident

    def set_behaviour(self, letter: str, behaviour: str) -> None:
        state = self.read_state()
        state["behaviour"][image_id(letter)] = behaviour
        self.write_state(state)

    def container(self, key: str = "sdr-doa-ground-console/console") -> Optional[dict]:
        return self.read_state()["containers"].get(key)

    def tag(self, ref: str) -> Optional[str]:
        return self.read_state()["tags"].get(ref)

    def calls(self) -> List[dict]:
        if not self.calls_path.exists():
            return []
        return [json.loads(line) for line in self.calls_path.read_text(encoding="utf-8").splitlines()]

    def argvs(self) -> List[List[str]]:
        return [call["argv"] for call in self.calls()]

    def reset_calls(self) -> None:
        self.calls_path.unlink(missing_ok=True)
        self.systemctl_calls.unlink(missing_ok=True)

    # running ---------------------------------------------------------------
    def env(self, nonroot: bool = False, **extra: str) -> Dict[str, str]:
        path = os.environ.get("PATH", "/usr/bin:/bin")
        if nonroot:
            path = f"{self.nonroot_bin}:{path}"
        elif os.geteuid() != 0:
            path = f"{self.root_bin}:{path}"
        env = {
            "PATH": f"{self.bin}:{path}",
            "HOME": str(self.home),
            "SDR_DOA_DOCKER": str(self.bin / "docker"),
            "SDR_DOA_SYSTEMCTL": str(self.bin / "systemctl"),
            "SDR_DOA_SYSTEMD_DIR": str(self.systemd),
            "SDR_DOA_BIN_DIR": str(self.installed_bin),
            "SDR_DOA_HEALTH_TIMEOUT": "10",
            "SDR_DOA_HEALTH_INTERVAL": "0",
            "SDR_DOA_SETTLE": "0",
            # A test that fakes root owns its files as this user.
            "SDR_DOA_ROOT_UID": str(os.geteuid()),
            "FAKE_DOCKER_STATE": str(self.state_path),
            "FAKE_DOCKER_CALLS": str(self.calls_path),
            "FAKE_SYSTEMCTL_CALLS": str(self.systemctl_calls),
            "LC_ALL": "C",
        }
        env.pop("DOCKER_HOST", None)
        env.update(extra)
        return env

    def run(self, *args: str, nonroot: bool = False, env: Optional[Dict[str, str]] = None,
            script: Path = SCRIPT) -> subprocess.CompletedProcess:
        environment = self.env(nonroot=nonroot)
        if env:
            for key, value in env.items():
                if value is None:
                    environment.pop(key, None)
                else:
                    environment[key] = value
        return subprocess.run(
            ["sh", str(script), *args],
            capture_output=True, text=True, env=environment, stdin=subprocess.DEVNULL, timeout=120,
        )


def non_comment_lines(text: str) -> List[str]:
    return [line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def read_env_file(path: Path) -> Dict[str, str]:
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            values[key] = value
    return values


class DockerScriptTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="test-docker-update-")
        self.base = Path(self._tmp.name)
        self.h = Harness(self.base)
        self.dir = self.base / "install"

    def tearDown(self):
        self._tmp.cleanup()

    def ok(self, result: subprocess.CompletedProcess, code: int = 0) -> subprocess.CompletedProcess:
        self.assertEqual(result.returncode, code, f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        return result

    def install(self, *args: str, **kwargs) -> subprocess.CompletedProcess:
        return self.ok(self.h.run("install", "--dir", str(self.dir), *args, **kwargs))

    def update(self, *args: str, code: int = 0, **kwargs) -> subprocess.CompletedProcess:
        return self.ok(self.h.run("update", "--dir", str(self.dir), *args, **kwargs), code)

    def up_calls(self) -> List[List[str]]:
        return [argv for argv in self.h.argvs() if argv[:1] == ["compose"] and "up" in argv and "--help" not in argv]


class InstallTests(DockerScriptTestCase):
    def test_install_writes_files_and_starts_the_console(self):
        result = self.install()
        compose = self.dir / "compose.yml"
        env_file = self.dir / ".env"
        self.assertTrue(compose.read_text().startswith(f"{MARKER} (console)."))
        self.assertEqual(stat.S_IMODE(compose.stat().st_mode), 0o644)
        self.assertEqual(stat.S_IMODE(env_file.stat().st_mode), 0o600)
        values = read_env_file(env_file)
        self.assertEqual(values["SDR_DOA_IMAGE"], CONSOLE_IMAGE)
        self.assertEqual(values["SDR_DOA_IMAGE_TAG"], CHANNEL)
        self.assertEqual(values["SDR_DOA_PORT"], "8787")
        copy = self.h.installed_bin / "sdr-doa-docker"
        self.assertEqual(copy.read_bytes(), SCRIPT.read_bytes())
        self.assertEqual(stat.S_IMODE(copy.stat().st_mode), 0o755)
        container = self.h.container()
        self.assertEqual(container["image"], image_id("a"))
        self.assertEqual(container["ref"], f"{CONSOLE_IMAGE}:{CHANNEL}")
        argvs = self.h.argvs()
        self.assertIn(["pull", "-q", f"{CONSOLE_IMAGE}:{CHANNEL}"], argvs)
        self.assertIn(["compose", "-p", "sdr-doa-ground-console", "-f", "compose.yml", "up", "-d"], argvs)
        for call in self.h.calls():
            if call["argv"][:1] == ["compose"] and "-p" in call["argv"]:
                self.assertEqual(call["cwd"], str(self.dir))
        self.assertIn("http://127.0.0.1:8787/", result.stdout)
        self.assertIn("docker compose exec console sdr-doa-set-admin-password", result.stdout)
        self.assertIn("docker compose restart console", result.stdout)
        log = (self.dir / "update.log").read_text()
        self.assertRegex(log, r"(?m)^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ install: pulling ")
        self.assertIn("OK: console runs 2.0.0 (aaaaaaaaaaaa) and is healthy", log)
        self.assertFalse((self.dir / ".sdr-doa-docker.lock").exists())
        self.assertFalse(list(self.dir.glob("*.tmp.*")))

    def test_rerun_keeps_env_lines_and_applies_options(self):
        self.h.publish(f"{CONSOLE_IMAGE}:{CHANNEL}.0", "a", "2.0.0")
        self.install("--port", "8790", "--channel", f"{CHANNEL}.0")
        env_file = self.dir / ".env"
        env_file.write_text(env_file.read_text() + "SDR_DOA_ADMIN_PASSWORD=s3cret\n")
        self.h.reset_calls()
        result = self.install()
        values = read_env_file(env_file)
        self.assertEqual(values["SDR_DOA_PORT"], "8790")
        self.assertEqual(values["SDR_DOA_IMAGE_TAG"], f"{CHANNEL}.0")
        self.assertEqual(values["SDR_DOA_ADMIN_PASSWORD"], "s3cret")
        self.assertEqual(stat.S_IMODE(env_file.stat().st_mode), 0o600)
        self.assertIn("http://127.0.0.1:8790/", result.stdout)
        self.assertIn(["pull", "-q", f"{CONSOLE_IMAGE}:{CHANNEL}.0"], self.h.argvs())
        compose_env = [call["env"] for call in self.h.calls() if "up" in call["argv"] and "--help" not in call["argv"]]
        self.assertEqual(compose_env[-1], {"SDR_DOA_IMAGE": CONSOLE_IMAGE, "SDR_DOA_IMAGE_TAG": f"{CHANNEL}.0", "SDR_DOA_PORT": "8790"})
        self.assertNotIn("s3cret", result.stdout + result.stderr)

    def test_install_applies_a_changed_port_with_the_same_image(self):
        self.install()
        first = self.h.container()["id"]
        self.install("--port", "8791")
        self.assertNotEqual(self.h.container()["id"], first, "a new port recreates the container")
        self.assertEqual(self.h.container()["image"], image_id("a"))

    def test_shell_environment_does_not_override_env_file(self):
        self.install()
        self.h.reset_calls()
        self.update(env={"SDR_DOA_IMAGE_TAG": "9", "SDR_DOA_PORT": "1"})
        self.assertIn(["pull", "-q", f"{CONSOLE_IMAGE}:{CHANNEL}"], self.h.argvs())

    def test_refuses_a_compose_file_it_did_not_write(self):
        self.dir.mkdir()
        foreign = "services:\n  web:\n    image: nginx\n"
        (self.dir / "compose.yml").write_text(foreign)
        result = self.h.run("install", "--dir", str(self.dir))
        self.assertEqual(result.returncode, 1)
        self.assertIn("--force", result.stderr)
        self.assertEqual((self.dir / "compose.yml").read_text(), foreign)
        self.assertEqual(self.up_calls(), [])
        self.install("--force")
        self.assertTrue((self.dir / "compose.yml").read_text().startswith(MARKER))

    def write_old_agent_install(self) -> None:
        """The files sdr-doa-docker 2 wrote for 'install --agent'."""
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "compose.yml").write_text(
            f"{MARKER} (agent). 'sdr-doa-docker install --agent' rewrites this file;\n"
            "name: sdr-doa-agent\nservices:\n  agent:\n    image: ${SDR_DOA_IMAGE}:${SDR_DOA_IMAGE_TAG}\n"
        )
        (self.dir / ".env").write_text(f"SDR_DOA_IMAGE={OLD_AGENT_IMAGE}\nSDR_DOA_IMAGE_TAG=2\n")
        (self.dir / ".env").chmod(0o600)
        (self.dir / "agent.env").write_text("MQTT_HOST=127.0.0.1\n")

    def test_an_agent_install_of_version_2_is_named_not_managed(self):
        self.write_old_agent_install()
        compose = (self.dir / "compose.yml").read_text()
        for args in (("update",), ("status",), ("rollback",), ("install",)):
            result = self.h.run(*args, "--dir", str(self.dir))
            self.assertEqual(result.returncode, 1, (args, result.stdout, result.stderr))
            self.assertIn("RDF-SDR agent install of sdr-doa-docker 2", result.stderr, args)
            self.assertIn("docker compose down", result.stderr, args)
        self.assertEqual((self.dir / "compose.yml").read_text(), compose)
        # Nothing pulled, started or stopped.
        self.assertEqual([argv for argv in self.h.argvs() if argv[:1] in (["pull"], ["stop"]) or "up" in argv[:3] and "--help" not in argv], [])
        # --force puts the console there, with the console image.
        self.install("--force", "--channel", CHANNEL)
        text = (self.dir / "compose.yml").read_text()
        self.assertTrue(text.startswith(f"{MARKER} (console)."))
        values = read_env_file(self.dir / ".env")
        self.assertEqual(values["SDR_DOA_IMAGE"], CONSOLE_IMAGE)
        self.assertEqual(self.h.container()["image"], image_id("a"))

    def test_switch_from_a_build_based_install_keeps_project_and_volume(self):
        state = self.h.read_state()
        old = image_id("0")
        state["images"][old] = {"version": "", "repo_digests": []}
        state["tags"]["sdr-doa-ground-console:2.0.0"] = old
        state["behaviour"][old] = "healthy"
        state["containers"]["sdr-doa-ground-console/console"] = {
            "id": "c" + "9" * 63, "image": old, "config": "build", "inspects": 0, "stopped": False,
            "ref": "sdr-doa-ground-console:2.0.0",
        }
        self.h.write_state(state)
        self.install()
        self.assertEqual(self.h.container()["image"], image_id("a"))
        self.assertEqual(self.h.tag(f"{CONSOLE_IMAGE}:sdr-doa-previous"), old)
        text = (self.dir / "compose.yml").read_text()
        self.assertRegex(text, r"(?m)^name: sdr-doa-ground-console$")
        self.assertRegex(text, r"(?m)^      - sdr-doa-data:/data$")

    def test_failed_fresh_install_reports_and_exits(self):
        self.h.set_behaviour("a", "unhealthy")
        result = self.h.run("install", "--dir", str(self.dir))
        self.assertEqual(result.returncode, 1)
        self.assertIn("health check reports unhealthy", result.stdout)
        self.assertIn("no previous image to go back to", result.stdout)
        self.assertIn("docker compose logs console", result.stdout)

    def test_usage_errors(self):
        for args, message in (
            (("frobnicate",), "unknown command"),
            (("install", "--channel", "2 0"), "channel"),
            (("install", "--channel", "sdr-doa-previous"), "previous image"),
            (("install", "--port", "70000"), "1 to 65535"),
            (("install", "--agent"), "RDF-SDR agent option"),
            (("install", "--enable-config"), "RDF-SDR agent option"),
            (("install", "--share-dir", "/x"), "RDF-SDR agent option"),
            (("install", "--dir", "/x y"), "letters, digits"),
            (("install", "--time", "25:00", "--auto-update"), "HH:MM"),
            (("install", "--time", "03:00"), "--auto-update"),
            (("auto-update", "sideways"), "on, off or status"),
            (("update", "--bogus"), "does not take"),
        ):
            result = self.h.run(*args)
            self.assertEqual(result.returncode, 2, (args, result.stdout, result.stderr))
            self.assertIn(message, result.stderr, args)
        self.assertEqual(self.h.argvs(), [], "usage errors never reach docker")
        self.assertIn("Usage: sdr-doa-docker", self.h.run("help").stdout)

    def test_unreachable_daemon(self):
        self.h.update_state(daemon_down=True)
        result = self.h.run("install", "--dir", str(self.dir))
        self.assertEqual(result.returncode, 1)
        self.assertIn("cannot reach the Docker daemon", result.stderr)
        self.assertFalse((self.dir / "compose.yml").exists())


class UpdateTests(DockerScriptTestCase):
    def setUp(self):
        super().setUp()
        self.install()
        self.h.reset_calls()
        self.ref = f"{CONSOLE_IMAGE}:{CHANNEL}"
        self.prev = f"{CONSOLE_IMAGE}:sdr-doa-previous"

    def test_no_change(self):
        result = self.update()
        self.assertIn("up to date: console runs 2.0.0 (aaaaaaaaaaaa)", result.stdout)
        self.assertEqual(self.up_calls(), [])
        self.assertIsNone(self.h.tag(self.prev))

    def test_healthy_update_keeps_the_previous_image_and_removes_the_one_before(self):
        self.h.publish(self.ref, "b", "2.0.1")
        result = self.update()
        self.assertIn("new image: 2.0.1 (bbbbbbbbbbbb), running 2.0.0 (aaaaaaaaaaaa)", result.stdout)
        self.assertIn("OK: console runs 2.0.1 (bbbbbbbbbbbb) and is healthy", result.stdout)
        self.assertEqual(self.h.container()["image"], image_id("b"))
        self.assertEqual(self.h.tag(self.ref), image_id("b"))
        self.assertEqual(self.h.tag(self.prev), image_id("a"))
        self.h.publish(self.ref, "c", "2.1.0")
        result = self.update()
        self.assertEqual(self.h.container()["image"], image_id("c"))
        self.assertEqual(self.h.tag(self.prev), image_id("b"))
        self.assertIn(["image", "rm", image_id("a")], self.h.argvs())
        self.assertNotIn(image_id("a"), self.h.read_state()["images"])
        self.assertIn("removed the image before the previous one (aaaaaaaaaaaa)", result.stdout)

    def assert_rolled_back(self, result: subprocess.CompletedProcess, reason: str, marked: bool = True) -> None:
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(reason, result.stdout)
        self.assertIn("rolling back to 2.0.0 (aaaaaaaaaaaa)", result.stdout)
        self.assertIn("rolled back: console runs 2.0.0 (aaaaaaaaaaaa) again", result.stdout)
        self.assertEqual(self.h.container()["image"], image_id("a"))
        self.assertEqual(self.h.tag(self.ref), image_id("a"))
        self.assertIsNone(self.h.tag(self.prev), "the previous tag is as before the update")
        if not marked:
            self.assertFalse((self.dir / ".bad-images").exists(), "a slow host or a compose error is no image fault")
            self.assertIn("so the next run tries it again", result.stdout)
            return
        bad = (self.dir / ".bad-images").read_text()
        self.assertRegex(bad, r"^%s \S+Z 2\.0\.1\n$" % re.escape(image_id("b")))
        rollback_up = self.up_calls()[-1]
        self.assertEqual(rollback_up[-3:], ["-d", "--pull", "never"])
        log = (self.dir / "update.log").read_text()
        self.assertIn("update: FAILED: 2.0.1 (bbbbbbbbbbbb)", log)

    def test_unhealthy_image_is_rolled_back_and_recorded(self):
        self.h.publish(self.ref, "b", "2.0.1", behaviour="unhealthy")
        self.assert_rolled_back(self.h.run("update", "--dir", str(self.dir)), "the health check reports unhealthy")

    def test_exited_image_is_rolled_back(self):
        self.h.publish(self.ref, "b", "2.0.1", behaviour="exited")
        self.assert_rolled_back(self.h.run("update", "--dir", str(self.dir)), "the container exited with exit code 1")

    def test_restarting_image_is_rolled_back(self):
        self.h.publish(self.ref, "b", "2.0.1", behaviour="restart")
        self.assert_rolled_back(self.h.run("update", "--dir", str(self.dir)), "the container restarted")

    def test_slow_image_times_out_and_is_rolled_back(self):
        self.h.publish(self.ref, "b", "2.0.1", behaviour="slow")
        result = self.h.run("update", "--dir", str(self.dir), env={"SDR_DOA_HEALTH_TIMEOUT": "1"})
        self.assert_rolled_back(result, "not healthy within 1 s (state running, health starting)", marked=False)
        # Not recorded, so the timer tries it again; a faster start succeeds.
        self.h.set_behaviour("b", "healthy")
        self.update("--auto")
        self.assertEqual(self.h.container()["image"], image_id("b"))

    def test_compose_error_is_rolled_back_without_marking_the_image(self):
        self.h.publish(self.ref, "b", "2.0.1")
        self.h.update_state(up_fails=True)
        result = self.update(code=1)
        self.assertIn("compose up failed: Error response from daemon: fake up failure", result.stdout)
        self.assertIn("so the next run tries it again", result.stdout)
        self.assertFalse((self.dir / ".bad-images").exists())
        self.assertEqual(self.h.container()["image"], image_id("a"))
        self.h.update_state(up_fails=False)
        self.update("--auto")
        self.assertEqual(self.h.container()["image"], image_id("b"))

    def test_rollback_without_pull_never_on_old_compose(self):
        self.h.update_state(compose_old=True)
        self.h.publish(self.ref, "b", "2.0.1", behaviour="unhealthy")
        result = self.h.run("update", "--dir", str(self.dir))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.up_calls()[-1][-2:], ["up", "-d"])
        self.assertEqual(self.h.container()["image"], image_id("a"))

    def test_auto_skips_a_bad_image_and_takes_a_newer_one(self):
        self.h.publish(self.ref, "b", "2.0.1", behaviour="unhealthy")
        self.update(code=1)
        self.h.reset_calls()
        result = self.update("--auto")
        self.assertIn("skipped: 2.0.1 (bbbbbbbbbbbb) failed its health check before", result.stdout)
        self.assertEqual(self.up_calls(), [])
        self.assertEqual(self.h.tag(self.ref), image_id("a"), "the channel tag points at the running image again")
        self.assertIn("update --auto: skipped", (self.dir / "update.log").read_text())
        self.h.publish(self.ref, "c", "2.0.2")
        self.update("--auto")
        self.assertEqual(self.h.container()["image"], image_id("c"))
        self.assertEqual(self.h.tag(self.prev), image_id("a"))

    def test_manual_update_tries_a_bad_image_again(self):
        self.h.publish(self.ref, "b", "2.0.1", behaviour="unhealthy")
        self.update(code=1)
        self.h.set_behaviour("b", "healthy")
        result = self.update()
        self.assertIn("trying 2.0.1 (bbbbbbbbbbbb) again", result.stdout)
        self.assertEqual(self.h.container()["image"], image_id("b"))
        self.assertEqual((self.dir / ".bad-images").read_text(), "", "a healthy image leaves the list")

    def test_auto_leaves_a_stopped_container_alone(self):
        state = self.h.read_state()
        state["containers"]["sdr-doa-ground-console/console"]["stopped"] = True
        self.h.write_state(state)
        self.h.publish(self.ref, "b", "2.0.1")
        result = self.update("--auto")
        self.assertIn("skipped: the console container is exited", result.stdout)
        self.assertNotIn(["pull", "-q", self.ref], self.h.argvs())
        result = self.update()
        self.assertEqual(self.h.container()["image"], image_id("b"))
        self.assertFalse(self.h.container()["stopped"])

    def test_manual_update_starts_a_stopped_container(self):
        state = self.h.read_state()
        state["containers"]["sdr-doa-ground-console/console"]["stopped"] = True
        self.h.write_state(state)
        result = self.update()
        self.assertIn("starting the exited container", result.stdout)
        self.assertFalse(self.h.container()["stopped"])

    def test_pull_failure_changes_nothing(self):
        self.h.update_state(pull_fails=True)
        first = self.h.container()["id"]
        result = self.update(code=1)
        self.assertIn("FAILED: pull of", result.stdout)
        self.assertIn("no such host", result.stdout)
        self.assertEqual(self.h.container()["id"], first)
        self.assertEqual(self.up_calls(), [])

    def test_check_with_buildx(self):
        result = self.update("--check")
        self.assertIn("up to date: console runs 2.0.0 (aaaaaaaaaaaa)", result.stdout)
        self.h.publish(self.ref, "b", "2.0.1")
        result = self.update("--check")
        self.assertIn(f"update available: {self.ref} is {digest('b')}", result.stdout)
        self.assertNotIn("pull", [argv[0] for argv in self.h.argvs()])
        self.assertEqual(self.h.container()["image"], image_id("a"))
        self.assertFalse((self.dir / ".sdr-doa-docker.lock").exists())

    def test_check_without_buildx_pulls_and_restores_the_tag(self):
        self.h.update_state(no_buildx=True)
        self.h.publish(self.ref, "b", "2.0.1")
        result = self.update("--check")
        self.assertIn(f"update available: {self.ref} is 2.0.1 (bbbbbbbbbbbb); console runs 2.0.0 (aaaaaaaaaaaa)", result.stdout)
        self.assertEqual(self.h.tag(self.ref), image_id("a"))
        self.assertEqual(self.h.container()["image"], image_id("a"))
        self.assertEqual(self.up_calls(), [])

    def test_rollback(self):
        self.h.publish(self.ref, "b", "2.0.1")
        self.update()
        self.h.reset_calls()
        result = self.ok(self.h.run("rollback", "--dir", str(self.dir)))
        self.assertIn("going back from 2.0.1 (bbbbbbbbbbbb) to 2.0.0 (aaaaaaaaaaaa)", result.stdout)
        self.assertIn("OK: console runs 2.0.0 (aaaaaaaaaaaa) and is healthy", result.stdout)
        self.assertEqual(self.h.container()["image"], image_id("a"))
        self.assertEqual(self.h.tag(self.ref), image_id("a"))
        self.assertEqual(self.h.tag(self.prev), image_id("b"))
        self.assertIn(image_id("b"), (self.dir / ".bad-images").read_text())
        self.assertEqual(self.up_calls()[-1][-3:], ["-d", "--pull", "never"])
        self.assertIn("rollback: OK", (self.dir / "update.log").read_text())
        # The timer does not bring the rolled-back image back.
        self.update("--auto")
        self.assertEqual(self.h.container()["image"], image_id("a"))

    def test_rollback_without_a_previous_image(self):
        result = self.h.run("rollback", "--dir", str(self.dir))
        self.assertEqual(result.returncode, 1)
        self.assertIn("no previous image", result.stdout)

    def test_failed_rollback_returns_to_the_current_image(self):
        self.h.publish(self.ref, "b", "2.0.1")
        self.update()
        self.h.set_behaviour("a", "unhealthy")
        result = self.h.run("rollback", "--dir", str(self.dir))
        self.assertEqual(result.returncode, 1)
        self.assertIn("back on 2.0.1 (bbbbbbbbbbbb)", result.stdout)
        self.assertEqual(self.h.container()["image"], image_id("b"))
        self.assertEqual(self.h.tag(self.ref), image_id("b"))
        self.assertEqual(self.h.tag(self.prev), image_id("a"))

    def test_lock(self):
        lock = self.dir / ".sdr-doa-docker.lock"
        lock.mkdir()
        (lock / "pid").write_text(f"{os.getpid()}\n")
        result = self.h.run("update", "--dir", str(self.dir))
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"another sdr-doa-docker run (pid {os.getpid()})", result.stderr)
        self.assertTrue(lock.is_dir(), "a live lock stays")
        # A lock left by a process that is gone is taken over.
        dead = subprocess.Popen(["sh", "-c", "exit 0"])
        dead.wait()
        (lock / "pid").write_text(f"{dead.pid}\n")
        self.update()
        self.assertFalse(lock.exists())

    def test_log_is_trimmed(self):
        log = self.dir / "update.log"
        log.write_text("".join(f"old line {n}\n" for n in range(600)))
        self.update()
        lines = log.read_text().splitlines()
        self.assertEqual(len(lines), 500)
        self.assertIn("up to date", lines[-1])

    def test_status(self):
        self.h.publish(self.ref, "b", "2.0.1")
        self.update()
        result = self.ok(self.h.run("status", "--dir", str(self.dir)))
        out = result.stdout
        self.assertIn(f"install:     {self.dir} (compose project sdr-doa-ground-console)", out)
        self.assertIn(f"image:       {self.ref}", out)
        self.assertIn(f"image ID:    {image_id('b')}, version 2.0.1", out)
        self.assertRegex(out, r"container:   running, health \w+, restarts 0, image 2\.0\.1 \(bbbbbbbbbbbb\)")
        self.assertIn("previous:    2.0.0 (aaaaaaaaaaaa)", out)
        self.assertIn("auto-update: off", out)
        self.assertRegex(out, r"last update: \S+Z update: OK: console runs 2\.0\.1")
        self.assertIn("URL:         http://127.0.0.1:8787/", out)
        self.h.update_state(daemon_down=True)
        result = self.ok(self.h.run("status", "--dir", str(self.dir)))
        self.assertIn("the daemon is not reachable", result.stdout)

    def test_auto_skips_an_older_image_and_update_installs_it(self):
        # A channel tag that moved back (an old release built late, a rerun).
        self.h.publish(self.ref, "b", "1.9.0")
        result = self.update("--auto")
        self.assertIn(f"skipped: {self.ref} points to older 1.9.0 than the running 2.0.0; run sdr-doa-docker update to install it",
                      result.stdout)
        self.assertEqual(self.h.container()["image"], image_id("a"))
        self.assertEqual(self.h.tag(self.ref), image_id("a"), "the tag points at the running image again")
        self.assertEqual(self.up_calls(), [])
        # By hand without a terminal it goes ahead, with a log line.
        result = self.update()
        self.assertIn("installing 1.9.0, older than the running 2.0.0", result.stdout)
        self.assertEqual(self.h.container()["image"], image_id("b"))

    def test_install_takes_an_older_image_of_the_chosen_channel(self):
        self.h.publish(f"{CONSOLE_IMAGE}:{CHANNEL}.0.0", "z", "1.0.0")
        result = self.install("--channel", f"{CHANNEL}.0.0")
        self.assertIn(f"installing 1.0.0, older than the running 2.0.0 (channel {CHANNEL}.0.0)", result.stdout)
        self.assertEqual(self.h.container()["image"], image_id("z"))

    def test_versions_are_compared_only_when_both_are_labelled(self):
        for letter, running, new, installed in (
            ("e", "2.0.0", "", True),         # an image without a version label is not compared
            ("f", "2.0.9", "2.0.10", True),   # numbers, not strings
            ("g", "2.1.0-rc.1", "2.1.0", True),
            ("h", "2.1.0", "2.1.0-rc.2", False),
            ("i", "2.1.0-rc.10", "2.1.0-rc.9", False),
        ):
            with self.subTest(running=running, new=new):
                state = self.h.read_state()
                running_id = state["containers"]["sdr-doa-ground-console/console"]["image"]
                state["images"][running_id]["version"] = running
                self.h.write_state(state)
                self.h.publish(self.ref, letter, new)
                self.update("--auto")
                self.assertEqual(self.h.container()["image"] == image_id(letter), installed)

    def test_version_cmp(self):
        text = SCRIPT.read_text(encoding="utf-8")
        function = re.search(r"(?ms)^version_cmp\(\) \{\n.*?^\}\n", text).group(0)
        for a, b, expected in (
            ("2.0.0", "2.0.0", "0"), ("2.0.1", "2.0.0", "1"), ("2.0.9", "2.0.10", "-1"), ("10.0.0", "9.9.9", "1"),
            ("2.1.0-rc.1", "2.1.0", "-1"), ("2.1.0", "2.1.0-rc.1", "1"), ("2.1.0-rc.2", "2.1.0-rc.10", "-1"),
            ("2.1.0-rc.1", "2.1.0-beta", "1"), ("2.1.0-1", "2.1.0-alpha", "-1"), ("2.1.0-rc", "2.1.0-rc.1", "-1"),
            ("2.0", "2.0.0", ""), ("", "2.0.0", ""), ("v2.0.0", "2.0.0", ""),
        ):
            result = subprocess.run(["sh", "-c", function + 'version_cmp "$1" "$2"', "sh", a, b], capture_output=True, text=True)
            self.assertEqual((result.returncode, result.stdout.strip()), (0, expected), (a, b))

    def test_auto_waits_while_the_receiver_records(self):
        self.h.update_state(receiver_busy=True)
        self.h.publish(self.ref, "b", "2.0.1")
        result = self.update("--auto")
        self.assertIn("deferred: Receiver recording or scan active; the next run tries 2.0.1 (bbbbbbbbbbbb) again", result.stdout)
        self.assertEqual(self.h.container()["image"], image_id("a"))
        self.assertEqual(self.h.tag(self.ref), image_id("a"))
        since_file = self.dir / ".deferred-since"
        since = since_file.read_text().strip()
        self.assertRegex(since, r"^\d+$")
        self.assertIn(["exec", self.h.container()["id"], "python",
                       "/opt/sdr-doa-ground-console/packaging/docker/healthcheck.py", "--busy"], self.h.argvs())
        self.update("--auto")
        self.assertEqual(since_file.read_text().strip(), since, "the first deferral counts")
        self.assertIn("deferred:    since", self.ok(self.h.run("status", "--dir", str(self.dir))).stdout)
        # After 7 days of deferrals the update goes ahead.
        since_file.write_text(f"{int(since) - 7 * 86400}\n")
        result = self.update("--auto")
        self.assertIn("busy at every run for 7 days; updating anyway", result.stdout)
        self.assertEqual(self.h.container()["image"], image_id("b"))
        self.assertFalse(since_file.exists())

    def test_idle_or_older_console_is_updated(self):
        for state, letter in (({"receiver_busy": False}, "b"), ({"receiver_busy": True, "busy_unsupported": True}, "c")):
            with self.subTest(state=state):
                self.h.update_state(**state)
                self.h.publish(self.ref, letter, "2.0.%d" % (ord(letter) - ord("a")))
                result = self.update("--auto")
                self.assertNotIn("deferred", result.stdout)
                self.assertEqual(self.h.container()["image"], image_id(letter))

    def test_manual_update_over_a_recording_needs_yes(self):
        self.h.update_state(receiver_busy=True)
        self.h.publish(self.ref, "b", "2.0.1")
        result = self.update(code=1)
        self.assertIn("not updated: the Receiver records or archives a scan; run 'sdr-doa-docker update --yes'", result.stdout)
        self.assertEqual(self.h.container()["image"], image_id("a"))
        self.assertEqual(self.h.tag(self.ref), image_id("a"))
        result = self.update("--yes")
        self.assertIn("warning: the Receiver records or archives a scan; the restart interrupts it", result.stdout)
        self.assertEqual(self.h.container()["image"], image_id("b"))
        self.assertEqual(self.h.run("update", "--dir", str(self.dir), "--auto", "--yes").returncode, 2)

    def test_an_image_without_a_health_check_settles(self):
        # A custom image without a health check counts as healthy once it ran
        # SDR_DOA_SETTLE seconds (0 here) without restarting.
        self.h.publish(self.ref, "f", "2.0.1", behaviour="none")
        self.update()
        self.assertEqual(self.h.container()["image"], image_id("f"))

    def test_unhealthy_current_image_goes_back_to_the_previous_one(self):
        # An update cut short (SIGKILL, power loss) or a broken image that
        # turned unhealthy later: the next run must not call it up to date.
        self.h.publish(self.ref, "b", "2.0.1")
        self.update()
        self.h.set_behaviour("b", "unhealthy")
        state = self.h.read_state()
        state["containers"]["sdr-doa-ground-console/console"]["inspects"] = 5
        self.h.write_state(state)
        result = self.update("--auto", code=1)
        self.assertIn("up to date: 2.0.1 (bbbbbbbbbbbb), but its health is unhealthy; waiting for it", result.stdout)
        self.assertIn("going back to the previous image 2.0.0 (aaaaaaaaaaaa)", result.stdout)
        self.assertIn("rolled back: console runs 2.0.0 (aaaaaaaaaaaa) again", result.stdout)
        self.assertEqual(self.h.container()["image"], image_id("a"))
        self.assertEqual(self.h.tag(self.ref), image_id("a"))
        self.assertIn(image_id("b"), (self.dir / ".bad-images").read_text())
        # The next run stays there.
        self.update("--auto")
        self.assertEqual(self.h.container()["image"], image_id("a"))

    def test_slow_current_image_goes_back_without_marking_it(self):
        self.h.publish(self.ref, "b", "2.0.1")
        self.update()
        self.h.set_behaviour("b", "slow")
        result = self.h.run("update", "--auto", "--dir", str(self.dir), env={"SDR_DOA_HEALTH_TIMEOUT": "1"})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("waiting for it", result.stdout)
        self.assertIn("going back to the previous image 2.0.0", result.stdout)
        self.assertFalse((self.dir / ".bad-images").exists())

    def test_unhealthy_current_image_without_a_previous_one(self):
        self.h.set_behaviour("a", "unhealthy")
        state = self.h.read_state()
        state["containers"]["sdr-doa-ground-console/console"]["inspects"] = 5
        self.h.write_state(state)
        result = self.update("--auto", code=1)
        self.assertIn("FAILED: 2.0.0 (aaaaaaaaaaaa): the health check reports unhealthy", result.stdout)
        self.assertIn("see 'docker compose logs console'", result.stdout)
        self.assertEqual(self.h.container()["image"], image_id("a"))

    def test_offline_install_applies_compose_yml_with_the_local_image(self):
        first = self.h.container()["id"]
        self.h.update_state(pull_fails=True)
        result = self.install("--port", "9000")
        self.assertIn(f"pull of {self.ref} failed", result.stdout)
        self.assertIn("using the image on this host", result.stdout)
        self.assertNotEqual(self.h.container()["id"], first, "the new port recreates the container")
        self.assertIn("http://127.0.0.1:9000/", result.stdout)
        # A channel this host never pulled cannot be installed offline.
        result = self.h.run("install", "--dir", str(self.dir), "--channel", f"{CHANNEL}.9")
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAILED: pull of", result.stdout)
        # update stays strict.
        self.assertIn("FAILED: pull of", self.update(code=1).stdout)

    def test_dollar_outside_single_quotes_is_reported_by_name(self):
        env_file = self.dir / ".env"
        base = env_file.read_text()
        for line, warned in (
            ("SDR_DOA_ADMIN_PASSWORD=Xk9$q2!aB", True),
            ('SDR_DOA_ADMIN_PASSWORD="Xk9$q2!aB"', True),
            ("export SDR_DOA_SEED_BASE_URL=http://$host:8081", True),
            ("SDR_DOA_ADMIN_PASSWORD='Xk9$q2!aB'", False),
            ("SDR_DOA_ADMIN_PASSWORD=plain", False),
            ("OTHER_VALUE=$x", False),
        ):
            with self.subTest(line=line):
                env_file.write_text(base + line + "\n")
                for result in (self.update(), self.ok(self.h.run("status", "--dir", str(self.dir)))):
                    out = result.stdout
                    self.assertEqual("has a $ outside single quotes" in out, warned, out)
                    self.assertNotIn("Xk9", out + result.stderr)
                    self.assertNotIn("$host", out + result.stderr)
        self.assertIn("SDR_DOA_SEED_BASE_URL in", (self.dir / "update.log").read_text())

    def test_shell_values_of_the_console_variables_do_not_reach_compose(self):
        self.h.publish(self.ref, "b", "2.0.1")
        self.h.reset_calls()
        self.update(env={"SDR_DOA_ADMIN_PASSWORD": "fromshell", "SDR_DOA_SEED_BASE_URL": "http://127.0.0.1:8081"})
        up = [call for call in self.h.calls() if "up" in call["argv"] and "--help" not in call["argv"]]
        self.assertTrue(up)
        for call in up:
            self.assertNotIn("SDR_DOA_ADMIN_PASSWORD", call["env"])
            self.assertNotIn("SDR_DOA_SEED_BASE_URL", call["env"])

    @unittest.skipIf(os.geteuid() == 0, "root reads a 0600 file anyway; CI runs this as a user")
    def test_unreadable_env_file_is_an_error_not_the_defaults(self):
        env_file = self.dir / ".env"
        env_file.chmod(0)
        try:
            result = self.h.run("status", "--dir", str(self.dir), nonroot=True)
        finally:
            env_file.chmod(0o600)
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"cannot read {env_file} (mode 0600); run with sudo", result.stderr)
        self.assertNotIn("URL:", result.stdout)

    def test_env_header_explains_quotes_and_how_a_change_applies(self):
        header = (self.dir / ".env").read_text()
        self.assertIn("wrap the value in", header)
        self.assertIn("single quotes", header)
        self.assertIn("docker compose up -d here", header)
        self.assertIn("sdr-doa-set-admin-password", header)
        self.assertNotIn("may go here too", header)

    def test_default_dir_as_a_user(self):
        user_dir = self.h.home / "sdr-doa-ground-console"
        result = self.h.run("install", nonroot=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((user_dir / "compose.yml").is_file())
        self.ok(self.h.run("status", nonroot=True))


class AutoUpdateTests(DockerScriptTestCase):
    def setUp(self):
        super().setUp()
        self.install()
        self.service = self.h.systemd / "sdr-doa-docker-update.service"
        self.timer = self.h.systemd / "sdr-doa-docker-update.timer"

    def systemctl(self) -> List[str]:
        if not self.h.systemctl_calls.exists():
            return []
        return self.h.systemctl_calls.read_text().splitlines()

    def test_on_status_off(self):
        result = self.ok(self.h.run("auto-update", "on", "--dir", str(self.dir), "--time", "04:15"))
        self.assertIn("daily at 04:15", result.stdout)
        service = self.service.read_text()
        timer = self.timer.read_text()
        self.assertTrue(service.startswith(MARKER) and timer.startswith(MARKER))
        self.assertIn("Type=oneshot", service)
        self.assertIn(f"ExecStart={self.h.installed_bin}/sdr-doa-docker update --auto --dir {self.dir}\n", service)
        self.assertIn("After=network-online.target docker.service", service)
        self.assertIn("OnCalendar=*-*-* 04:15:00\n", timer)
        self.assertIn("RandomizedDelaySec=15min\n", timer)
        self.assertIn("Persistent=true\n", timer)
        self.assertIn("WantedBy=timers.target", timer)
        self.assertEqual(stat.S_IMODE(self.timer.stat().st_mode), 0o644)
        self.assertEqual(self.systemctl(), ["daemon-reload", "enable --now sdr-doa-docker-update.timer"])
        status = self.ok(self.h.run("auto-update", "status", "--dir", str(self.dir)))
        self.assertIn(f"auto-update: on: daily at 04:15 (up to 15 min later) for {self.dir}, timer enabled, active",
                      status.stdout)
        other = self.ok(self.h.run("auto-update", "status", "--dir", str(self.base / "elsewhere")))
        self.assertIn("(another install)", other.stdout)
        self.assertIn("auto-update: on: daily at 04:15", self.ok(self.h.run("status", "--dir", str(self.dir))).stdout)
        self.h.reset_calls()
        self.ok(self.h.run("auto-update", "off"))
        self.assertFalse(self.service.exists() or self.timer.exists())
        self.assertEqual(self.systemctl(), ["disable --now sdr-doa-docker-update.timer", "daemon-reload"])
        self.assertIn("auto-update: off", self.ok(self.h.run("auto-update", "status")).stdout)
        self.assertIn("already off", self.ok(self.h.run("auto-update", "off")).stdout)

    def test_default_time_and_install_flag(self):
        self.ok(self.h.run("install", "--dir", str(self.dir), "--auto-update"))
        self.assertIn("OnCalendar=*-*-* 03:30:00\n", self.timer.read_text())
        self.ok(self.h.run("install", "--dir", str(self.dir), "--auto-update", "--time", "22:05"))
        self.assertIn("OnCalendar=*-*-* 22:05:00\n", self.timer.read_text())

    def test_a_user_gets_a_crontab_line_not_sudo(self):
        self.h.reset_calls()
        result = self.ok(self.h.run("auto-update", "on", "--dir", str(self.dir), "--time", "04:15", nonroot=True))
        self.assertIn("crontab -e as the user that owns", result.stdout)
        self.assertIn(f"15 04 * * * {self.h.installed_bin}/sdr-doa-docker update --auto --dir {self.dir} >/dev/null 2>&1",
                      result.stdout)
        self.assertIn("With rootless Docker, put DOCKER_HOST=", result.stdout)
        self.assertNotIn("sudo", result.stdout + result.stderr)
        self.assertFalse(self.timer.exists() or self.service.exists())
        # The line carries the user's DOCKER_HOST (rootless Docker).
        result = self.ok(self.h.run("auto-update", "on", "--dir", str(self.dir), nonroot=True,
                                    env={"DOCKER_HOST": "unix:///run/user/1000/docker.sock"}))
        self.assertIn(f"30 03 * * * DOCKER_HOST=unix:///run/user/1000/docker.sock {self.h.installed_bin}/sdr-doa-docker update",
                      result.stdout)
        # install --auto-update as a user installs and prints the same line.
        result = self.ok(self.h.run("install", "--dir", str(self.dir), "--auto-update", nonroot=True))
        self.assertIn("update --auto --dir", result.stdout)
        self.assertFalse(self.timer.exists())
        self.assertIn("daily: sdr-doa-docker auto-update on", self.ok(self.h.run("install", "--dir", str(self.dir), nonroot=True)).stdout)
        # Removing root's timer still needs root.
        self.ok(self.h.run("auto-update", "on", "--dir", str(self.dir)))
        result = self.h.run("auto-update", "off", nonroot=True)
        self.assertEqual(result.returncode, 2)
        self.assertTrue(self.timer.exists())
        self.assertIn("auto-update: on", self.ok(self.h.run("auto-update", "status", nonroot=True)).stdout)

    def refuse_owner(self, path: Path) -> Dict[str, str]:
        """Make root's timer see ``path`` as owned by another user."""
        if os.geteuid() == 0:
            os.chown(path, 12345, 12345)
            return {}
        return {"SDR_DOA_ROOT_UID": "0"}  # the test user's files are then not root's

    def test_root_timer_refuses_a_directory_another_user_can_change(self):
        for case in ("owner", "mode"):
            with self.subTest(case=case):
                env: Dict[str, str] = {}
                if case == "owner":
                    env = self.refuse_owner(self.dir)
                else:
                    self.dir.chmod(0o777)
                result = self.h.run("auto-update", "on", "--dir", str(self.dir), env=env)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn("is not owned by root or is writable by another user", result.stderr)
                self.assertIn("$HOME/.local/bin/sdr-doa-docker update --auto --dir", result.stdout)
                self.assertFalse(self.timer.exists() or self.service.exists())
                refused = self.h.run("install", "--dir", str(self.dir), "--auto-update", env=env)
                self.assertEqual(refused.returncode, 2, refused.stdout + refused.stderr)
                if os.geteuid() == 0:
                    os.chown(self.dir, 0, 0)
                self.dir.chmod(0o755)

    def test_root_timer_runs_only_a_root_only_copy_of_the_script(self):
        # Run from a download elsewhere: the unit runs the installed copy, never $0.
        download = self.base / "downloads" / "sdr-doa-docker"
        download.parent.mkdir()
        shutil.copy(SCRIPT, download)
        self.ok(self.h.run("auto-update", "on", "--dir", str(self.dir), script=download))
        self.assertIn(f"ExecStart={self.h.installed_bin}/sdr-doa-docker update --auto --dir {self.dir}\n", self.service.read_text())
        self.assertNotIn(str(download), self.service.read_text())
        self.ok(self.h.run("auto-update", "off"))
        copy = self.h.installed_bin / "sdr-doa-docker"
        # A copy others may write is refused (run from that copy, so it is not replaced).
        copy.chmod(0o777)
        result = self.h.run("auto-update", "on", "--dir", str(self.dir), script=copy)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("root's timer must not run it", result.stderr)
        copy.chmod(0o755)
        self.h.installed_bin.chmod(0o777)
        result = self.h.run("auto-update", "on", "--dir", str(self.dir), script=copy)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.h.installed_bin.chmod(0o755)
        env = self.refuse_owner(copy)
        result = self.h.run("auto-update", "on", "--dir", str(self.dir), script=copy, env=env)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertFalse(self.timer.exists())

    def test_one_auto_update_install_per_host(self):
        self.ok(self.h.run("auto-update", "on", "--dir", str(self.dir)))
        # A second console install, copied so it shares no container with the first.
        other = self.base / "other"
        other.mkdir()
        for name in ("compose.yml", ".env"):
            shutil.copy2(self.dir / name, other / name)
        result = self.h.run("auto-update", "on", "--dir", str(other))
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn(f"the timer updates {self.dir} (one auto-update install per host)", result.stderr)
        self.h.reset_calls()
        result = self.h.run("install", "--dir", str(other), "--auto-update")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual(self.h.argvs(), [], "refused before docker")
        self.assertIn(f"--dir {self.dir}\n", self.service.read_text())
        self.ok(self.h.run("auto-update", "on", "--dir", str(other), "--force"))
        self.assertIn(f"--dir {other}\n", self.service.read_text())
        self.ok(self.h.run("install", "--dir", str(self.dir), "--auto-update", "--force"))
        self.assertIn(f"--dir {self.dir}\n", self.service.read_text())
        for args in (("auto-update", "off", "--force"), ("auto-update", "status", "--time", "04:00")):
            self.assertEqual(self.h.run(*args).returncode, 2, args)

    def test_install_hints_use_sudo_only_for_a_root_install(self):
        result = self.ok(self.h.run("install", "--dir", str(self.dir)))
        self.assertIn("  sudo docker compose exec console sdr-doa-set-admin-password", result.stdout)
        self.assertIn(f"Update: sudo sdr-doa-docker update --dir {self.dir}; daily: sudo sdr-doa-docker auto-update on", result.stdout)
        user_dir = self.h.home / "sdr-doa-ground-console"
        result = self.ok(self.h.run("install", "--dir", str(user_dir), nonroot=True))
        self.assertIn("\n  docker compose exec console sdr-doa-set-admin-password", result.stdout)
        self.assertNotIn("sudo", result.stdout)

    def test_without_systemd_prints_a_cron_line(self):
        env = {"SDR_DOA_SYSTEMCTL": str(self.base / "no-systemctl"), "SDR_DOA_SYSTEMD_DIR": None}
        result = self.ok(self.h.run("auto-update", "on", "--dir", str(self.dir), "--time", "04:15", env=env))
        self.assertIn("systemd was not found", result.stdout)
        self.assertIn(f"15 04 * * * {self.h.installed_bin}/sdr-doa-docker update --auto --dir {self.dir} >/dev/null 2>&1",
                      result.stdout)
        self.assertFalse(self.timer.exists())


class ComposePolicyTests(DockerScriptTestCase):
    def test_console_compose_matches_docker_compose_ghcr(self):
        self.install()
        written = (self.dir / "compose.yml").read_text()
        self.assertEqual(non_comment_lines(written), non_comment_lines(GHCR_COMPOSE.read_text()))

    def test_written_compose_files_keep_the_policy(self):
        self.install()
        console = (self.dir / "compose.yml").read_text()
        self.assertRegex(console, r"(?m)^    network_mode: host$")
        self.assertRegex(console, r"(?m)^    restart: unless-stopped$")
        self.assertNotRegex(console, r"(?m)^\s+ports:")
        self.assertNotIn("0.0.0.0", console)
        self.assertNotIn("build:", console)
        self.assertRegex(console, r"(?m)^name: sdr-doa-ground-console$")
        self.assertRegex(console, r"(?m)^      - sdr-doa-data:/data$")
        self.assertRegex(console, r"(?m)^  sdr-doa-data:$")
        self.assertRegex(console, r"(?m)^      - SDR_DOA_ADMIN_PASSWORD$")
        self.assertIn("image: ${SDR_DOA_IMAGE:-%s}:${SDR_DOA_IMAGE_TAG:-%s}" % (CONSOLE_IMAGE, CHANNEL), console)
        repo_env = re.findall(r"(?m)^      - (SDR_DOA_[A-Z_]+)", (ROOT / "docker-compose.yml").read_text())
        self.assertEqual(re.findall(r"(?m)^      - (SDR_DOA_[A-Z_]+)", console), repo_env)
        self.assertNotIn("agent", console)

    def test_default_channel_follows_the_major_version(self):
        major = (ROOT / "VERSION").read_text().strip().split(".")[0]
        self.assertRegex(SCRIPT.read_text(), r"(?m)^DEFAULT_CHANNEL=%s$" % major)
        self.assertIn("${SDR_DOA_IMAGE_TAG:-%s}" % major, GHCR_COMPOSE.read_text())

    def test_shell_syntax_and_mode(self):
        self.assertTrue(os.access(SCRIPT, os.X_OK))
        for shell in ("sh", "dash", "bash", "busybox"):
            path = shutil.which(shell)
            if path is None:
                continue
            command = [path, "sh", "-n", str(SCRIPT)] if shell == "busybox" else [path, "-n", str(SCRIPT)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, f"{shell}: {result.stderr}")
        shellcheck = shutil.which("shellcheck")
        if shellcheck:
            result = subprocess.run([shellcheck, "-s", "sh", str(SCRIPT)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout)

    def test_no_bashisms_that_dash_would_miss(self):
        text = SCRIPT.read_text()
        code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
        # A shell "function name {" (awk programs have "function name(args) {").
        for pattern in (r"\[\[\s", r"(?m)^\s*local\s", r"(?m)^\s*function\s+\w+\s*(\(\s*\)\s*)?\{\s*$",
                        r"\$\{[A-Za-z_]+//", r"<<<", r"\bsource\s"):
            self.assertNotRegex(code, pattern)

    def test_runs_under_dash(self):
        dash = shutil.which("dash")
        if dash is None:
            self.skipTest("dash is not installed")
        environment = self.h.env()
        result = subprocess.run([dash, str(SCRIPT), "install", "--dir", str(self.dir)],
                                capture_output=True, text=True, env=environment, stdin=subprocess.DEVNULL)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.h.publish(f"{CONSOLE_IMAGE}:{CHANNEL}", "b", "2.0.1", behaviour="unhealthy")
        result = subprocess.run([dash, str(SCRIPT), "update", "--dir", str(self.dir)],
                                capture_output=True, text=True, env=environment, stdin=subprocess.DEVNULL)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("rolled back", result.stdout)


if __name__ == "__main__":
    unittest.main()
