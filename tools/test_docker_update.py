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
AGENT_IMAGE = "ghcr.io/sanadunt/sdr-doa-rdf-sdr-agent"
MARKER = "# Written by sdr-doa-docker"


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
        "env": {k: v for k, v in os.environ.items() if k in ("SDR_DOA_IMAGE", "SDR_DOA_IMAGE_TAG", "SDR_DOA_PORT")},
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
        self.publish(CONSOLE_IMAGE + ":2", "a", "2.0.0")

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
            "SDR_DOA_AGENT_SETTLE": "0",
            "FAKE_DOCKER_STATE": str(self.state_path),
            "FAKE_DOCKER_CALLS": str(self.calls_path),
            "FAKE_SYSTEMCTL_CALLS": str(self.systemctl_calls),
            "LC_ALL": "C",
        }
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
        self.assertEqual(values["SDR_DOA_IMAGE_TAG"], "2")
        self.assertEqual(values["SDR_DOA_PORT"], "8787")
        copy = self.h.installed_bin / "sdr-doa-docker"
        self.assertEqual(copy.read_bytes(), SCRIPT.read_bytes())
        self.assertEqual(stat.S_IMODE(copy.stat().st_mode), 0o755)
        container = self.h.container()
        self.assertEqual(container["image"], image_id("a"))
        self.assertEqual(container["ref"], f"{CONSOLE_IMAGE}:2")
        argvs = self.h.argvs()
        self.assertIn(["pull", "-q", f"{CONSOLE_IMAGE}:2"], argvs)
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
        self.h.publish(f"{CONSOLE_IMAGE}:2.0", "a", "2.0.0")
        self.install("--port", "8790", "--channel", "2.0")
        env_file = self.dir / ".env"
        env_file.write_text(env_file.read_text() + "SDR_DOA_ADMIN_PASSWORD=s3cret\n")
        self.h.reset_calls()
        result = self.install()
        values = read_env_file(env_file)
        self.assertEqual(values["SDR_DOA_PORT"], "8790")
        self.assertEqual(values["SDR_DOA_IMAGE_TAG"], "2.0")
        self.assertEqual(values["SDR_DOA_ADMIN_PASSWORD"], "s3cret")
        self.assertEqual(stat.S_IMODE(env_file.stat().st_mode), 0o600)
        self.assertIn("http://127.0.0.1:8790/", result.stdout)
        self.assertIn(["pull", "-q", f"{CONSOLE_IMAGE}:2.0"], self.h.argvs())
        compose_env = [call["env"] for call in self.h.calls() if "up" in call["argv"] and "--help" not in call["argv"]]
        self.assertEqual(compose_env[-1], {"SDR_DOA_IMAGE": CONSOLE_IMAGE, "SDR_DOA_IMAGE_TAG": "2.0", "SDR_DOA_PORT": "8790"})
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
        self.assertIn(["pull", "-q", f"{CONSOLE_IMAGE}:2"], self.h.argvs())

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

    def test_refuses_the_other_variant_without_force(self):
        self.install()
        result = self.h.run("install", "--agent", "--dir", str(self.dir))
        self.assertEqual(result.returncode, 1)
        self.assertIn("holds the console install", result.stderr)

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

    def test_agent_variant(self):
        self.h.publish(f"{AGENT_IMAGE}:2", "b", "2.0.0", behaviour="none")
        result = self.install("--agent")
        text = (self.dir / "compose.yml").read_text()
        self.assertTrue(text.startswith(f"{MARKER} (agent)."))
        self.assertRegex(text, r"(?m)^name: sdr-doa-agent$")
        self.assertIn("image: ${SDR_DOA_IMAGE:-%s}:${SDR_DOA_IMAGE_TAG:-2}" % AGENT_IMAGE, text)
        self.assertRegex(text, r"(?m)^      - agent\.env$")
        self.assertRegex(text, r"(?m)^      - agent-state:/state$")
        self.assertRegex(text, r"(?m)^      STATE_DIR: /state$")
        self.assertRegex(text, r"(?m)^      SETTINGS_PATH: /krakensdr/_share/settings\.json$")
        self.assertNotIn("user:", text)
        values = read_env_file(self.dir / ".env")
        self.assertEqual(values["SDR_DOA_IMAGE"], AGENT_IMAGE)
        self.assertNotIn("SDR_DOA_PORT", values)
        agent_env = self.dir / "agent.env"
        self.assertEqual(stat.S_IMODE(agent_env.stat().st_mode), 0o600)
        self.assertEqual(self.h.container("sdr-doa-agent/agent")["image"], image_id("b"))
        self.assertIn(["compose", "-p", "sdr-doa-agent", "-f", "compose.yml", "up", "-d"], self.h.argvs())
        self.assertNotIn("127.0.0.1:8787", result.stdout)
        self.assertIn("agent.env", result.stdout)
        # A re-run keeps agent.env.
        agent_env.write_text(agent_env.read_text().replace("MQTT_HOST=127.0.0.1", "MQTT_HOST=10.90.0.1"))
        self.install("--agent")
        self.assertEqual(read_env_file(agent_env)["MQTT_HOST"], "10.90.0.1")

    def test_agent_env_template_follows_the_example(self):
        self.h.publish(f"{AGENT_IMAGE}:2", "b", "2.0.0", behaviour="none")
        self.install("--agent")
        written = read_env_file(self.dir / "agent.env")
        example = read_env_file(ROOT / "packaging/agent/agent.env.example")
        for key in ("STATE_DIR", "SETTINGS_PATH"):
            example.pop(key)
        self.assertEqual(written, example)

    @unittest.skipUnless(hasattr(os, "geteuid") and os.geteuid() == 0, "needs root to chown")
    def test_agent_enable_and_disable_config(self):
        self.h.publish(f"{AGENT_IMAGE}:2", "b", "2.0.0", behaviour="none")
        share = self.base / "share"
        share.mkdir()
        os.chown(share, 1234, 1235)
        self.install("--agent", "--enable-config", "--share-dir", str(share))
        text = (self.dir / "compose.yml").read_text()
        self.assertIn('    user: "1234:1235"', text)
        self.assertRegex(text, r"(?m)^      - \./state:/state$")
        self.assertIn(f"      - {share}:/krakensdr/_share", text)
        state_dir = self.dir / "state"
        self.assertEqual((state_dir.stat().st_uid, state_dir.stat().st_gid), (1234, 1235))
        self.assertEqual(stat.S_IMODE(state_dir.stat().st_mode), 0o700)
        self.assertEqual(read_env_file(self.dir / "agent.env")["ENABLE_CONFIG"], "1")
        self.assertEqual(read_env_file(self.dir / ".env")["SDR_DOA_AGENT_CONFIG"], "1")
        # A plain re-run keeps the mode.
        self.install("--agent")
        self.assertIn('user: "1234:1235"', (self.dir / "compose.yml").read_text())
        self.install("--agent", "--disable-config")
        text = (self.dir / "compose.yml").read_text()
        self.assertNotIn("user:", text)
        self.assertRegex(text, r"(?m)^      - agent-state:/state$")
        self.assertEqual(read_env_file(self.dir / "agent.env")["ENABLE_CONFIG"], "0")
        refused = self.h.run("install", "--agent", "--dir", str(self.dir), "--enable-config",
                             "--share-dir", str(share), "--user", "0:0")
        self.assertEqual(refused.returncode, 1)
        self.assertIn("must not run as root", refused.stderr)

    def test_usage_errors(self):
        for args, message in (
            (("frobnicate",), "unknown command"),
            (("install", "--channel", "2 0"), "channel"),
            (("install", "--channel", "sdr-doa-previous"), "previous image"),
            (("install", "--port", "70000"), "1 to 65535"),
            (("install", "--agent", "--port", "8790"), "console option"),
            (("install", "--enable-config"), "need --agent"),
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
        self.ref = f"{CONSOLE_IMAGE}:2"
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

    def assert_rolled_back(self, result: subprocess.CompletedProcess, reason: str) -> None:
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(reason, result.stdout)
        self.assertIn("rolling back to 2.0.0 (aaaaaaaaaaaa)", result.stdout)
        self.assertIn("rolled back: console runs 2.0.0 (aaaaaaaaaaaa) again", result.stdout)
        self.assertEqual(self.h.container()["image"], image_id("a"))
        self.assertEqual(self.h.tag(self.ref), image_id("a"))
        self.assertIsNone(self.h.tag(self.prev), "the previous tag is as before the update")
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
        self.assert_rolled_back(result, "not healthy within 1 s (state running, health starting)")

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
        self.assertIn(f"install:     {self.dir} (console, compose project sdr-doa-ground-console)", out)
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

    def test_needs_root(self):
        self.h.reset_calls()
        for args in (("auto-update", "on", "--dir", str(self.dir)), ("install", "--dir", str(self.dir), "--auto-update")):
            result = self.h.run(*args, nonroot=True)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn("needs root", result.stderr)
        self.assertFalse(self.timer.exists())
        self.assertEqual(self.h.argvs(), [], "install --auto-update stops before docker")
        self.ok(self.h.run("auto-update", "on", "--dir", str(self.dir)))
        result = self.h.run("auto-update", "off", nonroot=True)
        self.assertEqual(result.returncode, 2)
        self.assertTrue(self.timer.exists())
        self.assertIn("auto-update: on", self.ok(self.h.run("auto-update", "status", nonroot=True)).stdout)

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
        agent_dir = self.base / "agent"
        self.h.publish(f"{AGENT_IMAGE}:2", "b", "2.0.0", behaviour="none")
        self.ok(self.h.run("install", "--agent", "--dir", str(agent_dir)))
        agent = (agent_dir / "compose.yml").read_text()
        for text in (console, agent):
            self.assertRegex(text, r"(?m)^    network_mode: host$")
            self.assertRegex(text, r"(?m)^    restart: unless-stopped$")
            self.assertNotRegex(text, r"(?m)^\s+ports:")
            self.assertNotIn("0.0.0.0", text)
            self.assertNotIn("build:", text)
        self.assertRegex(console, r"(?m)^name: sdr-doa-ground-console$")
        self.assertRegex(console, r"(?m)^      - sdr-doa-data:/data$")
        self.assertRegex(console, r"(?m)^  sdr-doa-data:$")
        self.assertRegex(console, r"(?m)^      - SDR_DOA_ADMIN_PASSWORD$")
        self.assertIn("image: ${SDR_DOA_IMAGE:-%s}:${SDR_DOA_IMAGE_TAG:-2}" % CONSOLE_IMAGE, console)
        repo_env = re.findall(r"(?m)^      - (SDR_DOA_[A-Z_]+)", (ROOT / "docker-compose.yml").read_text())
        self.assertEqual(re.findall(r"(?m)^      - (SDR_DOA_[A-Z_]+)", console), repo_env)
        self.assertRegex(agent, r"(?m)^name: sdr-doa-agent$")
        self.assertRegex(agent, r"(?m)^  agent-state:$")

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
        for pattern in (r"\[\[\s", r"(?m)^\s*local\s", r"\bfunction\s+\w+", r"\$\{[A-Za-z_]+//", r"<<<", r"\bsource\s"):
            self.assertNotRegex(code, pattern)

    def test_runs_under_dash(self):
        dash = shutil.which("dash")
        if dash is None:
            self.skipTest("dash is not installed")
        environment = self.h.env()
        result = subprocess.run([dash, str(SCRIPT), "install", "--dir", str(self.dir)],
                                capture_output=True, text=True, env=environment, stdin=subprocess.DEVNULL)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.h.publish(f"{CONSOLE_IMAGE}:2", "b", "2.0.1", behaviour="unhealthy")
        result = subprocess.run([dash, str(SCRIPT), "update", "--dir", str(self.dir)],
                                capture_output=True, text=True, env=environment, stdin=subprocess.DEVNULL)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("rolled back", result.stdout)


if __name__ == "__main__":
    unittest.main()
