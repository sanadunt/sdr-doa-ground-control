"""Policy tests for .github/workflows/{ci,release}.yml and tools/release_check.py.

The workflow checks read the files as text, and also as YAML when PyYAML is
installed (CI installs it; the local .venv may not have it, and those checks
are then skipped). The release_check tests run git in temporary repositories
and build small fake release directories; nothing touches the network.
"""

from __future__ import annotations

import ast
import hashlib
import io
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import Dict, List
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import make_release  # noqa: E402
import release_check  # noqa: E402

try:
    import yaml
except ImportError:  # the console's .venv has no PyYAML
    yaml = None

ROOT = make_release.PROJECT_ROOT
WORKFLOWS = ROOT / ".github" / "workflows"
CI = WORKFLOWS / "ci.yml"
RELEASE = WORKFLOWS / "release.yml"
PINNED_USES = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$")
VERSION_COMMENT = re.compile(r"#\s*v[0-9]+(?:\.[0-9]+){0,2}\s*$")
CONTRACT_ASSETS = [
    "sdr-doa-ground-console-2.0.0-linux.tar.gz",
    "sdr-doa-rdf-sdr-agent-2.0.0.tar.gz",
    "sdr-doa-docker",
    "SHA256SUMS",
]
CONSOLE_PLATFORMS = "linux/amd64,linux/arm64"
AGENT_PLATFORMS = "linux/amd64,linux/arm64,linux/arm/v7"
SHA_A = "a" * 40


def run_blocks(text: str) -> List[str]:
    """The script of every run: step, without a YAML parser."""
    lines = text.splitlines()
    blocks = []
    index = 0
    while index < len(lines):
        match = re.match(r"^(\s*)(?:- )?run:\s*(.*)$", lines[index])
        index += 1
        if not match:
            continue
        indent, value = len(match.group(1)), match.group(2).strip()
        if value and value[0] not in "|>":
            blocks.append(value)
            continue
        body = []
        while index < len(lines) and (not lines[index].strip() or len(lines[index]) - len(lines[index].lstrip()) > indent):
            body.append(lines[index])
            index += 1
        blocks.append("\n".join(body))
    return blocks


def load(path: Path) -> Dict:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    # YAML 1.1 reads the key "on" as True.
    if True in data:
        data["on"] = data.pop(True)
    return data


def steps_using(job: Dict, action: str) -> List[Dict]:
    return [step for step in job.get("steps", []) if str(step.get("uses", "")).split("@")[0] == action]


class WorkflowTextTests(unittest.TestCase):
    """Checks that need no YAML parser."""

    texts = {path.name: path.read_text(encoding="utf-8") for path in (CI, RELEASE)}

    def test_every_action_is_pinned_to_a_commit_with_its_version(self):
        for name, text in self.texts.items():
            uses = re.findall(r"^\s*(?:- )?uses:\s*(\S+)(.*)$", text, flags=re.M)
            self.assertTrue(uses, name)
            for target, rest in uses:
                if target.startswith("./"):
                    self.assertEqual(target, "./.github/workflows/ci.yml", name)
                    continue
                self.assertRegex(target, PINNED_USES, f"{name}: {target} is not pinned to a full commit SHA")
                self.assertRegex(rest, VERSION_COMMENT, f"{name}: {target} needs its version in a comment")

    def test_same_action_same_commit(self):
        pins: Dict[str, set] = {}
        for text in self.texts.values():
            for target in re.findall(r"uses:\s*([^\s@]+/[^\s@]+)@([0-9a-f]{40})", text):
                pins.setdefault(target[0], set()).add(target[1])
        for action, shas in pins.items():
            self.assertEqual(len(shas), 1, f"{action} is pinned to several commits: {shas}")

    def test_no_secret_other_than_github_token(self):
        for name, text in self.texts.items():
            self.assertEqual(set(re.findall(r"secrets\.([A-Za-z0-9_]+)", text)) - {"GITHUB_TOKEN"}, set(), name)
            self.assertNotIn("secrets[", text, name)
            self.assertNotIn("pull_request_target", text, name)

    def test_no_expression_inside_a_run_script(self):
        for name, text in self.texts.items():
            blocks = run_blocks(text)
            self.assertGreater(len(blocks), 5, name)
            for block in blocks:
                self.assertNotIn("${{", block, f"{name}: pass expressions through env:, not into run:\n{block}")

    def test_run_block_extractor(self):
        sample = "steps:\n  - run: echo one\n  - name: x\n    run: |\n      echo ${{ github.ref }}\n\n      echo two\n    env:\n      A: b\n"
        self.assertEqual(run_blocks(sample), ["echo one", "      echo ${{ github.ref }}\n\n      echo two"])

    def test_workflow_permissions_are_read_only(self):
        for name, text in self.texts.items():
            self.assertRegex(text, r"(?m)^permissions:\n  contents: read\n(?!  )", name)
        self.assertEqual(self.texts["ci.yml"].count("write"), 0)
        self.assertEqual(len(re.findall(r"(?m)^\s+contents: write$", self.texts["release.yml"])), 1)
        self.assertEqual(len(re.findall(r"(?m)^\s+packages: write$", self.texts["release.yml"])), 1)

    def test_ci_runs_the_verification_sequence(self):
        text = self.texts["ci.yml"]
        for command in (
            "npm ci --ignore-scripts --no-audit --no-fund",
            "run: npm test",
            "run: npm run check",
            "run: npm run build:all",
            "-m unittest discover -s tools -p 'test_*.py'",
            "node --test tools/test_receiver_*.mjs",
            "tools/make_release.py --skip-build --output-dir",
            "sha256sum -c SHA256SUMS",
            "git diff --check",
            "mosquitto -c tools/mqtt_stage4.conf -d",
            "paho-mqtt==2.1.0",
            # Without PyYAML the YAML checks of this file would be skipped in CI.
            "PyYAML==",
            # The lint lines of the verification sequence (CLAUDE.md).
            "actionlint-py==",
            ".venv/bin/actionlint .github/workflows/*.yml",
            "shellcheck -s sh packaging/docker/sdr-doa-docker packaging/console/sdr-doa-console packaging/console/install.sh",
            'python-version: "3.12"',
            'python-version: "3.9"',
            'node-version: "22"',
            "submodules: recursive",
            "cache: npm",
        ):
            self.assertIn(command, text)
        # The standalone runner tells the two kinds of test files apart this way.
        self.assertIn("grep -q 'unittest\\.TestCase' \"$script\"", text)
        self.assertIn("tools/test_sdr_doa_mqtt_stdlib.py)", text)
        self.assertIn("::warning file=$script::Skipped", text)

    def test_release_checks_tag_and_assets(self):
        text = self.texts["release.yml"]
        for snippet in (
            "tools/release_check.py tag --event \"$EVENT_NAME\" --ref \"$GIT_REF\"",
            "tools/release_check.py assets --dir dist/release",
            "tools/release_check.py images --owner",
            "tools/make_release.py --with-wheels",
            "--verify-tag",
            "--generate-notes",
            "--clobber",
            "--prerelease",
            'SDR-DoA Ground Console $VERSION',
            "repos/$GH_REPO/git/refs",
            "docker logout ghcr.io",
            "docker manifest inspect",
            "::warning::",
            "Public",
            "fetch-depth: 0",
        ):
            self.assertIn(snippet, text)
        for asset in (
            'release/sdr-doa-ground-console-${VERSION}-linux.tar.gz',
            'release/sdr-doa-rdf-sdr-agent-${VERSION}.tar.gz',
            'release/sdr-doa-docker',
            'release/SHA256SUMS',
        ):
            self.assertIn(f'"{asset}"', text)
        self.assertEqual(text.count("platforms: linux/amd64,linux/arm64\n"), 1)
        self.assertEqual(text.count(f"platforms: {AGENT_PLATFORMS}\n"), 1)

    def test_checkouts_keep_no_credentials(self):
        for name, text in self.texts.items():
            checkouts = text.count("uses: actions/checkout@")
            self.assertGreater(checkouts, 0, name)
            self.assertEqual(text.count("persist-credentials: false"), checkouts, name)


@unittest.skipIf(yaml is None, "PyYAML is not installed; the text checks still ran")
class WorkflowStructureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ci = load(CI)
        cls.release = load(RELEASE)

    def all_steps(self, workflow: Dict):
        for job_id, job in workflow["jobs"].items():
            for step in job.get("steps", []):
                yield job_id, step

    def test_ci_triggers(self):
        on = self.ci["on"]
        self.assertEqual(set(on), {"pull_request", "push", "workflow_call"})
        self.assertEqual(on["push"], {"branches": ["main"]})

    def test_release_triggers_and_concurrency(self):
        on = self.release["on"]
        self.assertEqual(set(on), {"push", "workflow_dispatch"})
        self.assertEqual(on["push"], {"tags": ["v*"]})
        self.assertIn("github.ref", self.release["concurrency"]["group"])
        self.assertIs(self.release["concurrency"]["cancel-in-progress"], False)

    def test_ci_concurrency_differs_from_the_release_group(self):
        # A called workflow evaluates github.* in the caller's context.
        self.assertTrue(self.ci["concurrency"]["group"].startswith("ci-"))
        self.assertTrue(self.release["concurrency"]["group"].startswith("release-"))

    def test_permissions(self):
        for workflow in (self.ci, self.release):
            self.assertEqual(workflow["permissions"], {"contents": "read"})
        for job_id, job in self.ci["jobs"].items():
            self.assertNotIn("permissions", job, job_id)
        expected = {
            "test": {"contents": "read"},
            "build": None,
            "release": {"contents": "write"},
            "images": {"contents": "read", "packages": "write"},
        }
        self.assertEqual(set(self.release["jobs"]), set(expected))
        for job_id, permissions in expected.items():
            self.assertEqual(self.release["jobs"][job_id].get("permissions"), permissions, job_id)

    def test_release_job_graph(self):
        jobs = self.release["jobs"]
        self.assertEqual(jobs["test"]["uses"], "./.github/workflows/ci.yml")
        self.assertEqual(jobs["build"]["needs"], "test")
        self.assertEqual(jobs["release"]["needs"], "build")
        self.assertEqual(jobs["images"]["needs"], "build")

    def test_every_step_pinned_and_scripts_take_expressions_through_env(self):
        for workflow in (self.ci, self.release):
            for job_id, step in self.all_steps(workflow):
                if "uses" in step:
                    self.assertRegex(step["uses"], PINNED_USES, job_id)
                if "run" in step:
                    self.assertNotIn("${{", step["run"], f"{job_id}: {step.get('name')}")
                for value in (step.get("env") or {}).values():
                    for expression in re.findall(r"\$\{\{(.*?)\}\}", str(value)):
                        self.assertNotRegex(expression, r"secrets\.(?!GITHUB_TOKEN\b)", job_id)

    def test_runners_and_timeouts(self):
        for workflow in (self.ci, self.release):
            for job_id, job in workflow["jobs"].items():
                if "uses" in job:
                    continue
                self.assertEqual(job["runs-on"], "ubuntu-24.04", job_id)
                self.assertIsInstance(job.get("timeout-minutes"), int, job_id)

    def test_ci_jobs(self):
        jobs = self.ci["jobs"]
        self.assertEqual(set(jobs), {"verify", "python-minimum"})
        verify = jobs["verify"]
        (node,) = steps_using(verify, "actions/setup-node")
        self.assertEqual(node["with"]["node-version"], "22")
        self.assertEqual(node["with"]["cache"], "npm")
        self.assertIn("frontend/package-lock.json", node["with"]["cache-dependency-path"])
        (python,) = steps_using(verify, "actions/setup-python")
        self.assertEqual(python["with"]["python-version"], "3.12")
        (minimum,) = steps_using(jobs["python-minimum"], "actions/setup-python")
        self.assertEqual(minimum["with"]["python-version"], "3.9")
        minimum_runs = " ".join(step.get("run", "") for step in jobs["python-minimum"]["steps"])
        self.assertIn("unittest discover -s tools", minimum_runs)
        self.assertNotIn("npm", minimum_runs)
        for job in jobs.values():
            (checkout,) = steps_using(job, "actions/checkout")
            self.assertEqual(checkout["with"]["submodules"], "recursive")
            self.assertIs(checkout["with"]["persist-credentials"], False)
        runs = [step.get("run", "") for step in verify["steps"]]
        order = [
            "npm ci --ignore-scripts",
            "npm test",
            "npm run check",
            "npm run build:all",
            "unittest discover",
            "tools/test_*.py",
            "node --test",
            "make_release.py --skip-build",
            ".venv/bin/actionlint",
            "git diff --check",
        ]
        positions = [next(i for i, run in enumerate(runs) if needle in run) for needle in order]
        self.assertEqual(positions, sorted(positions), "the verification runs in the documented order")

    def test_build_job(self):
        build = self.release["jobs"]["build"]
        (checkout,) = steps_using(build, "actions/checkout")
        self.assertEqual(checkout["with"]["fetch-depth"], 0)
        self.assertEqual(checkout["with"]["submodules"], "recursive")
        names = [step.get("id") for step in build["steps"]]
        self.assertLess(names.index("tag"), next(i for i, s in enumerate(build["steps"]) if "make_release.py" in s.get("run", "")))
        tag_step = build["steps"][names.index("tag")]
        self.assertEqual(tag_step["env"], {"EVENT_NAME": "${{ github.event_name }}", "GIT_REF": "${{ github.ref }}"})
        (upload,) = steps_using(build, "actions/upload-artifact")
        self.assertEqual(upload["with"]["path"], "dist/release/")
        self.assertEqual(upload["with"]["if-no-files-found"], "error")
        for output in ("version", "tag", "sha", "create_tag", "prerelease", "console_tags", "agent_tags", "labels"):
            self.assertIn(output, build["outputs"])

    def test_release_job(self):
        release = self.release["jobs"]["release"]
        (download,) = steps_using(release, "actions/download-artifact")
        self.assertEqual(download["with"]["name"], "release-assets")
        create_tag = next(step for step in release["steps"] if "git/refs" in step.get("run", ""))
        self.assertEqual(create_tag["if"], "needs.build.outputs.create_tag == 'true'")
        publish = next(step for step in release["steps"] if "gh release create" in step.get("run", ""))
        self.assertEqual(publish["env"]["GH_TOKEN"], "${{ secrets.GITHUB_TOKEN }}")
        script = publish["run"]
        self.assertIn('gh release upload "$TAG" "${assets[@]}" --clobber', script)
        self.assertIn('--title "SDR-DoA Ground Console $VERSION"', script)
        self.assertIn('if [ "$PRERELEASE" = true ]', script)

    def test_images_job(self):
        images = self.release["jobs"]["images"]
        (login,) = steps_using(images, "docker/login-action")
        self.assertEqual(login["with"]["registry"], "ghcr.io")
        self.assertEqual(login["with"]["password"], "${{ secrets.GITHUB_TOKEN }}")
        self.assertEqual(len(steps_using(images, "docker/setup-qemu-action")), 1)
        self.assertEqual(len(steps_using(images, "docker/setup-buildx-action")), 1)
        console, agent = steps_using(images, "docker/build-push-action")
        self.assertTrue(console["with"]["file"].endswith("/Dockerfile.release"))
        self.assertEqual(console["with"]["context"], "${{ steps.unpack.outputs.console_dir }}")
        self.assertEqual(console["with"]["platforms"], CONSOLE_PLATFORMS)
        self.assertEqual(console["with"]["tags"], "${{ needs.build.outputs.console_tags }}")
        self.assertTrue(agent["with"]["file"].endswith("/Dockerfile.agent"))
        self.assertEqual(agent["with"]["context"], "${{ steps.unpack.outputs.agent_dir }}")
        self.assertEqual(agent["with"]["platforms"], AGENT_PLATFORMS)
        self.assertEqual(agent["with"]["tags"], "${{ needs.build.outputs.agent_tags }}")
        for step in (console, agent):
            self.assertIs(step["with"]["push"], True)
            self.assertEqual(step["with"]["labels"], "${{ needs.build.outputs.labels }}")
        unpack = next(step for step in images["steps"] if step.get("id") == "unpack")
        self.assertIn("sha256sum -c SHA256SUMS", unpack["run"])
        self.assertEqual(unpack["run"].count("MANIFEST.sha256"), 2)
        names = [step.get("name", "") for step in images["steps"]]
        logout = next(i for i, step in enumerate(images["steps"]) if step.get("run") == "docker logout ghcr.io")
        check = next(i for i, step in enumerate(images["steps"]) if "docker manifest inspect" in step.get("run", ""))
        self.assertLess(names.index(console["name"]), logout)
        self.assertLess(names.index(agent["name"]), logout)
        self.assertLess(logout, check)
        self.assertIn("::warning::", images["steps"][check]["run"])
        self.assertNotIn("exit 1", images["steps"][check]["run"])


class TestFileKindTests(unittest.TestCase):
    """ci.yml runs files without 'unittest.TestCase' as standalone scripts."""

    def test_each_test_file_is_discovered_or_a_script(self):
        for path in sorted((ROOT / "tools").glob("test_*.py")):
            text = path.read_text(encoding="utf-8")
            tree = ast.parse(text, filename=str(path))
            has_case = any(
                isinstance(node, ast.ClassDef)
                and any(ast.unparse(base).endswith("TestCase") for base in node.bases)
                for node in ast.walk(tree)
            )
            self.assertEqual(has_case, "unittest.TestCase" in text, f"{path.name}: spell the base unittest.TestCase")
            if not has_case:
                self.assertIn('if __name__ == "__main__":', text, path.name)


class VersionTests(unittest.TestCase):
    def test_release_versions(self):
        self.assertEqual(release_check.parse_release_version("2.0.0"), (2, 0, 0, None))
        self.assertEqual(release_check.parse_release_version("2.1.0-rc.1"), (2, 1, 0, "rc.1"))
        self.assertEqual(release_check.parse_release_version("10.20.30"), (10, 20, 30, None))
        for bad in ("2.0", "v2.0.0", "02.0.0", "2.0.0+build.1", "2.0.0-", "2.0.0-.rc", "2.0.0 ", "", "2.0.0-rc_1"):
            with self.assertRaises(release_check.CheckError, msg=bad):
                release_check.parse_release_version(bad)

    def test_repository_version_is_a_release_version(self):
        release_check.parse_release_version(make_release.read_version(ROOT))

    def test_image_tags(self):
        self.assertEqual(release_check.image_tags("2.0.0"), ["2.0.0", "2.0", "2", "latest"])
        self.assertEqual(release_check.image_tags("3.12.4"), ["3.12.4", "3.12", "3", "latest"])
        self.assertEqual(release_check.image_tags("2.1.0-rc.1"), ["2.1.0-rc.1"])
        for version in ("2.0.0", "2.1.0-rc.1"):
            for tag in release_check.image_tags(version):
                self.assertRegex(tag, r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")

    def test_image_outputs_follow_the_contract(self):
        outputs = release_check.image_outputs(
            "Sanadunt", "2.0.0", SHA_A, "https://github.com/sanadunt/sdr-doa-ground-control"
        )
        self.assertEqual(outputs["console_image"], "ghcr.io/sanadunt/sdr-doa-ground-console")
        self.assertEqual(outputs["agent_image"], "ghcr.io/sanadunt/sdr-doa-rdf-sdr-agent")
        self.assertEqual(
            outputs["console_tags"].splitlines(),
            [f"ghcr.io/sanadunt/sdr-doa-ground-console:{tag}" for tag in ("2.0.0", "2.0", "2", "latest")],
        )
        self.assertEqual(
            outputs["agent_tags"].splitlines(),
            [f"ghcr.io/sanadunt/sdr-doa-rdf-sdr-agent:{tag}" for tag in ("2.0.0", "2.0", "2", "latest")],
        )
        self.assertEqual(
            outputs["labels"].splitlines(),
            [
                "org.opencontainers.image.version=2.0.0",
                f"org.opencontainers.image.revision={SHA_A}",
                "org.opencontainers.image.source=https://github.com/sanadunt/sdr-doa-ground-control",
            ],
        )
        pre = release_check.image_outputs("sanadunt", "2.1.0-rc.1", SHA_A, "https://github.com/sanadunt/x")
        self.assertEqual(pre["console_tags"], "ghcr.io/sanadunt/sdr-doa-ground-console:2.1.0-rc.1")

    def test_image_inputs_are_checked(self):
        source = "https://github.com/sanadunt/sdr-doa-ground-control"
        for owner, revision, src in (
            ("bad owner", SHA_A, source),
            ("-x", SHA_A, source),
            ("sanadunt", "abc", source),
            ("sanadunt", SHA_A, "http://github.com/a/b"),
            ("sanadunt", SHA_A, "https://github.com/a/b c"),
        ):
            with self.assertRaises(release_check.CheckError):
                release_check.image_outputs(owner, "2.0.0", revision, src)

    def test_release_assets_follow_the_contract(self):
        self.assertEqual(release_check.release_assets("2.0.0"), CONTRACT_ASSETS)


def write_tarball(path: Path, top: str, files: Dict[str, bytes]) -> None:
    with tarfile.open(path, "w:gz") as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(f"{top}/{name}")
            info.size = len(data)
            info.mode = 0o755
            archive.addfile(info, io.BytesIO(data))


def write_sums(directory: Path, names: List[str]) -> None:
    lines = "".join(f"{hashlib.sha256((directory / n).read_bytes()).hexdigest()}  {n}\n" for n in sorted(names))
    (directory / "SHA256SUMS").write_text(lines, encoding="utf-8")


class AssetCheckTests(unittest.TestCase):
    VERSION = "2.0.0"
    SCRIPT = b"#!/bin/sh\necho sdr-doa-docker\n"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="test-release-assets-")
        self.dir = Path(self._tmp.name) / "release"
        self.dir.mkdir()
        console_top = make_release.console_release_name(self.VERSION)
        write_tarball(self.dir / f"{console_top}.tar.gz", console_top, {"VERSION": b"2.0.0\n", "packaging/docker/sdr-doa-docker": self.SCRIPT})
        agent_top = make_release.agent_release_name(self.VERSION)
        write_tarball(self.dir / f"{agent_top}.tar.gz", agent_top, {"VERSION": b"2.0.0\n"})
        (self.dir / "sdr-doa-docker").write_bytes(self.SCRIPT)
        write_sums(self.dir, CONTRACT_ASSETS[:3])

    def tearDown(self):
        self._tmp.cleanup()

    def check(self):
        return release_check.check_assets(self.dir, self.VERSION)

    def assertRefused(self, fragment: str):
        with self.assertRaises(release_check.CheckError) as caught:
            self.check()
        self.assertIn(fragment, str(caught.exception))

    def test_complete_release_passes_in_upload_order(self):
        self.assertEqual([path.name for path in self.check()], CONTRACT_ASSETS)

    def test_missing_docker_script(self):
        (self.dir / "sdr-doa-docker").unlink()
        self.assertRefused("missing: sdr-doa-docker")

    def test_extra_file(self):
        (self.dir / "sdr-doa-ground-console-1.9.0-linux.tar.gz").write_bytes(b"old")
        self.assertRefused("not a release asset: sdr-doa-ground-console-1.9.0-linux.tar.gz")

    def test_checksum_mismatch(self):
        (self.dir / "sdr-doa-docker").write_bytes(self.SCRIPT + b"# changed\n")
        self.assertRefused("sdr-doa-docker does not match its SHA256SUMS line")

    def test_sums_must_cover_every_asset(self):
        write_sums(self.dir, CONTRACT_ASSETS[:2])
        self.assertRefused("SHA256SUMS lists")

    def test_malformed_sums(self):
        (self.dir / "SHA256SUMS").write_text("not a checksum line\n", encoding="utf-8")
        self.assertRefused("line 1")

    def test_console_tarball_must_ship_the_same_script(self):
        console_top = make_release.console_release_name(self.VERSION)
        write_tarball(self.dir / f"{console_top}.tar.gz", console_top, {"VERSION": b"2.0.0\n"})
        write_sums(self.dir, CONTRACT_ASSETS[:3])
        self.assertRefused("does not ship packaging/docker/sdr-doa-docker")
        write_tarball(self.dir / f"{console_top}.tar.gz", console_top, {"packaging/docker/sdr-doa-docker": b"other"})
        write_sums(self.dir, CONTRACT_ASSETS[:3])
        self.assertRefused("differs from the sdr-doa-docker asset")

    def test_command_line_prints_the_assets(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = release_check.main(["assets", "--dir", str(self.dir), "--version", self.VERSION])
        self.assertEqual(code, 0)
        self.assertEqual([Path(line).name for line in out.getvalue().splitlines()], CONTRACT_ASSETS)
        (self.dir / "SHA256SUMS").unlink()
        out = io.StringIO()
        with redirect_stdout(out):
            code = release_check.main(["assets", "--dir", str(self.dir), "--version", self.VERSION])
        self.assertEqual(code, 1)
        self.assertTrue(out.getvalue().startswith("::error::release assets in"), out.getvalue())

    def test_make_release_output_passes_the_check(self):
        dist = Path(self._tmp.name) / "dist"
        for name in ("index.html", "receiver/index.html"):
            (dist / name).parent.mkdir(parents=True, exist_ok=True)
            (dist / name).write_text("<!doctype html>", encoding="utf-8")
        out = Path(self._tmp.name) / "out"
        version = make_release.read_version(ROOT)
        with mock.patch("sys.stderr", new=io.StringIO()):
            make_release.build_release(ROOT, output_dir=out, dist_dir=dist, skip_build=True, allow_dirty=True, epoch=1_700_000_000)
        self.assertEqual([p.name for p in release_check.check_assets(out, version)], release_check.release_assets(version))


@unittest.skipUnless(shutil.which("git"), "git is not installed")
class TagCheckTests(unittest.TestCase):
    """release_check.check_tag against temporary repositories."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="test-release-tag-")
        base = Path(self._tmp.name)
        self.repo = base / "repo"
        self.repo.mkdir()
        environment = {
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "HOME": str(base),
            "GIT_AUTHOR_NAME": "Test",
            "GIT_AUTHOR_EMAIL": "test@example.invalid",
            "GIT_COMMITTER_NAME": "Test",
            "GIT_COMMITTER_EMAIL": "test@example.invalid",
        }
        patcher = mock.patch.dict(os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.git("init", "-q", "-b", "main")
        self.first = self.commit("2.0.0")
        self.set_main(self.first)

    def tearDown(self):
        self._tmp.cleanup()

    def git(self, *args: str) -> str:
        result = subprocess.run(
            ["git", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-C", str(self.repo), *args],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()

    def commit(self, version: str, message: str = "change") -> str:
        (self.repo / "VERSION").write_text(f"{version}\n", encoding="utf-8")
        (self.repo / "notes.txt").write_text(f"{message} {version} {os.urandom(4).hex()}\n", encoding="utf-8")
        self.git("add", "VERSION", "notes.txt")
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")

    def set_main(self, commit: str) -> None:
        self.git("update-ref", "refs/remotes/origin/main", commit)

    def check(self, event: str, ref: str, sha=None) -> release_check.ReleaseTag:
        return release_check.check_tag(self.repo, event, ref, sha)

    def assertRefused(self, fragment: str, event: str, ref: str, sha=None):
        with self.assertRaises(release_check.CheckError) as caught:
            self.check(event, ref, sha)
        self.assertIn(fragment, str(caught.exception))

    def test_tag_push_of_version_on_main(self):
        self.git("tag", "v2.0.0")
        result = self.check("push", "refs/tags/v2.0.0")
        self.assertEqual(result, release_check.ReleaseTag("2.0.0", "v2.0.0", self.first, False))
        self.assertEqual(
            result.outputs(),
            {"version": "2.0.0", "tag": "v2.0.0", "sha": self.first, "create_tag": "false", "prerelease": "false"},
        )

    def test_annotated_tag(self):
        self.git("tag", "-a", "-m", "release", "v2.0.0")
        self.assertEqual(self.check("push", "refs/tags/v2.0.0").sha, self.first)

    def test_tag_must_equal_version(self):
        self.git("tag", "v2.0.1")
        self.assertRefused("tag v2.0.1 does not match VERSION 2.0.0", "push", "refs/tags/v2.0.1")
        self.git("tag", "2.0.0")
        self.assertRefused("a release tag is v<VERSION> exactly, here v2.0.0", "push", "refs/tags/2.0.0")

    def test_push_must_be_a_tag(self):
        self.assertRefused("a release push must push a tag", "push", "refs/heads/main")

    def test_tagged_commit_must_be_on_main(self):
        self.git("checkout", "-q", "-b", "feature")
        side = self.commit("2.1.0")
        self.git("tag", "v2.1.0")
        self.assertRefused(f"commit {side[:12]} is not on origin/main", "push", "refs/tags/v2.1.0")
        self.set_main(side)
        self.assertEqual(self.check("push", "refs/tags/v2.1.0").version, "2.1.0")

    def test_older_commit_on_main_may_be_released(self):
        self.git("tag", "v2.0.0")
        self.set_main(self.commit("2.1.0"))
        self.git("checkout", "-q", "v2.0.0")
        self.assertEqual(self.check("push", "refs/tags/v2.0.0").sha, self.first)

    def test_dispatch_on_main_creates_a_missing_tag(self):
        result = self.check("workflow_dispatch", "refs/heads/main")
        self.assertEqual(result, release_check.ReleaseTag("2.0.0", "v2.0.0", self.first, True))

    def test_dispatch_reuses_the_tag_of_the_same_commit(self):
        self.git("tag", "v2.0.0")
        self.assertIs(self.check("workflow_dispatch", "refs/heads/main").create_tag, False)

    def test_dispatch_refuses_a_tag_on_another_commit(self):
        self.git("tag", "v2.0.0")
        later = self.commit("2.0.0", "no version bump")
        self.set_main(later)
        self.assertRefused(f"tag v2.0.0 already exists on {self.first[:12]}", "workflow_dispatch", "refs/heads/main")

    def test_dispatch_only_on_main(self):
        self.assertRefused("run the release workflow on main, not on refs/heads/feature", "workflow_dispatch", "refs/heads/feature")
        self.assertRefused("run the release workflow on main", "workflow_dispatch", "refs/tags/v2.0.0")

    def test_other_events_are_refused(self):
        self.assertRefused("not 'pull_request'", "pull_request", "refs/pull/1/merge")

    def test_origin_main_must_be_known(self):
        self.git("update-ref", "-d", "refs/remotes/origin/main")
        self.git("tag", "v2.0.0")
        self.assertRefused("refs/remotes/origin/main is missing", "push", "refs/tags/v2.0.0")

    def test_prerelease(self):
        self.set_main(self.commit("2.1.0-rc.1"))
        self.git("tag", "v2.1.0-rc.1")
        result = self.check("push", "refs/tags/v2.1.0-rc.1")
        self.assertTrue(result.prerelease)
        self.assertEqual(result.outputs()["prerelease"], "true")

    def test_version_must_be_a_release_version(self):
        self.set_main(self.commit("2.1.0+build.7"))
        self.assertRefused("is not a release version", "workflow_dispatch", "refs/heads/main")

    def test_working_tree_version_must_match_the_commit(self):
        self.git("tag", "v2.0.0")
        (self.repo / "VERSION").write_text("2.0.1\n", encoding="utf-8")
        self.assertRefused("the checked-out VERSION differs", "push", "refs/tags/v2.0.0")

    def test_command_line_writes_github_output(self):
        self.git("tag", "v2.0.0")
        output = Path(self._tmp.name) / "github_output"
        out = io.StringIO()
        with redirect_stdout(out):
            code = release_check.main(
                ["--root", str(self.repo), "--github-output", str(output), "tag", "--event", "push", "--ref", "refs/tags/v2.0.0"]
            )
        self.assertEqual(code, 0)
        self.assertEqual(
            output.read_text(encoding="utf-8"),
            f"version=2.0.0\ntag=v2.0.0\nsha={self.first}\ncreate_tag=false\nprerelease=false\n",
        )
        with redirect_stdout(io.StringIO()) as refused:
            code = release_check.main(
                ["--root", str(self.repo), "--github-output", str(output), "tag", "--event", "push", "--ref", "refs/tags/v9.9.9"]
            )
        self.assertEqual(code, 1)
        self.assertIn("::error::tag v9.9.9 does not match VERSION 2.0.0", refused.getvalue())


def _dockerfile_copy_sources(text: str) -> List[str]:
    """The source paths of every COPY line (flags such as --chmod left out)."""
    sources = []
    for line in re.findall(r"(?m)^COPY (.+)$", text):
        words = [word for word in line.split() if not word.startswith("--")]
        sources += words[:-1]
    return sources


class CrossTrackContractTests(unittest.TestCase):
    """The workflow, make_release.py, sdr-doa-docker and the native updater
    must name the same repository, assets, tarball layout and images."""

    REPOSITORY = "sanadunt/sdr-doa-ground-control"

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(ROOT / "packaging" / "console"))
        try:
            import update_release  # noqa: E402
        finally:
            sys.path.remove(str(ROOT / "packaging" / "console"))
        cls.updater = update_release
        cls.version = make_release.read_version(ROOT)
        cls.script = (ROOT / release_check.DOCKER_SCRIPT_IN_CONSOLE).read_text(encoding="utf-8")
        cls.owner = cls.REPOSITORY.split("/")[0]

    def script_value(self, name: str) -> str:
        match = re.search(r"(?m)^%s=(\S+)$" % name, self.script)
        self.assertIsNotNone(match, name)
        return match.group(1)

    def test_docker_script_pulls_the_images_the_workflow_pushes(self):
        self.assertEqual(self.script_value("CONSOLE_IMAGE"), release_check.image_name(self.owner, release_check.CONSOLE_IMAGE))
        self.assertEqual(self.script_value("AGENT_IMAGE"), release_check.image_name(self.owner, release_check.AGENT_IMAGE))
        # Its default channel is one of the tags a release of this VERSION pushes.
        self.assertIn(self.script_value("DEFAULT_CHANNEL"), release_check.image_tags(self.version))

    def test_ghcr_compose_uses_the_console_image(self):
        text = (ROOT / "docker-compose.ghcr.yml").read_text(encoding="utf-8")
        self.assertIn("${SDR_DOA_IMAGE:-%s}" % self.script_value("CONSOLE_IMAGE"), text)

    def test_native_updater_reads_the_assets_make_release_writes(self):
        updater = self.updater
        assets = release_check.release_assets(self.version)
        self.assertEqual(updater.DEFAULT_REPO, self.REPOSITORY)
        self.assertEqual(updater.CONSOLE_ASSET.format(version=self.version), assets[0])
        self.assertEqual(updater.SUMS_ASSET, assets[-1])
        self.assertEqual(updater.SUMS_ASSET, make_release.CHECKSUMS_NAME)
        self.assertEqual(updater.CONSOLE_TOP.format(version=self.version), make_release.console_release_name(self.version))
        self.assertEqual(updater.MANIFEST_NAME, make_release.MANIFEST_NAME)

    def test_repository_url_is_the_same_everywhere(self):
        url = f"https://github.com/{self.REPOSITORY}"
        for name in ("Dockerfile", "Dockerfile.release", "Dockerfile.agent"):
            sources = re.findall(r'org\.opencontainers\.image\.source="([^"]+)"', (ROOT / name).read_text(encoding="utf-8"))
            self.assertEqual(sources, [url], name)
        quickstart = (ROOT / "QUICKSTART.md").read_text(encoding="utf-8")
        downloads = set(re.findall(r"https://github\.com/([^/\s]+/[^/\s]+)/releases/", quickstart))
        self.assertEqual(downloads, {self.REPOSITORY})

    def test_release_tarballs_hold_what_the_images_and_the_updater_need(self):
        with tempfile.TemporaryDirectory(prefix="test-release-contract-") as tmp:
            dist = Path(tmp) / "dist"
            for name in ("index.html", "receiver/index.html"):
                (dist / name).parent.mkdir(parents=True, exist_ok=True)
                (dist / name).write_text("<!doctype html>", encoding="utf-8")
            out = Path(tmp) / "out"
            with mock.patch("sys.stderr", new=io.StringIO()):
                paths = make_release.build_release(
                    ROOT, output_dir=out, dist_dir=dist, skip_build=True, allow_dirty=True, epoch=1_700_000_000
                )
            self.assertEqual([path.name for path in paths], release_check.release_assets(self.version))
            members = {}
            for path, top in (
                (paths[0], make_release.console_release_name(self.version)),
                (paths[1], make_release.agent_release_name(self.version)),
            ):
                with tarfile.open(path, "r:gz") as archive:
                    names = archive.getnames()
                self.assertTrue(all(name == top or name.startswith(top + "/") for name in names), path.name)
                members[path.name] = {name[len(top) + 1:] for name in names if name != top}
        console, agent = members[paths[0].name], members[paths[1].name]
        for required in (
            "install.sh", "VERSION", make_release.MANIFEST_NAME, "Dockerfile.release", "docker-compose.yml",
            "docker-compose.ghcr.yml", release_check.DOCKER_SCRIPT_IN_CONSOLE, "packaging/console/update_release.py",
            "packaging/docker/healthcheck.py", "packaging/docker/console-entrypoint.sh",
        ):
            self.assertIn(required, console)
        for required in ("install.sh", "VERSION", make_release.MANIFEST_NAME, "Dockerfile.agent", "docker-compose.yml"):
            self.assertIn(required, agent)
        # release.yml builds each image with the tarball's own Dockerfile and
        # the unpacked tarball as the context, so every COPY source must be in it.
        for tree, dockerfile in ((console, "Dockerfile.release"), (agent, "Dockerfile.agent")):
            for source in _dockerfile_copy_sources((ROOT / dockerfile).read_text(encoding="utf-8")):
                source = source.rstrip("/")
                self.assertTrue(
                    source in tree or any(name.startswith(source + "/") for name in tree),
                    f"{dockerfile} copies {source}, which its tarball does not hold",
                )


class OutputFormatTests(unittest.TestCase):
    def test_multiline_values_use_a_delimiter(self):
        with tempfile.TemporaryDirectory(prefix="test-release-output-") as tmp:
            path = Path(tmp) / "out"
            with redirect_stdout(io.StringIO()):
                release_check.main(
                    [
                        "--github-output", str(path), "images", "--owner", "sanadunt", "--version", "2.0.0",
                        "--revision", SHA_A, "--source", "https://github.com/sanadunt/sdr-doa-ground-control",
                    ]
                )
            text = path.read_text(encoding="utf-8")
        values = {}
        lines = iter(text.splitlines())
        for line in lines:
            if "<<" in line:
                key, delimiter = line.split("<<", 1)
                body = []
                for inner in lines:
                    if inner == delimiter:
                        break
                    body.append(inner)
                values[key] = body
            else:
                key, value = line.split("=", 1)
                values[key] = value
        self.assertEqual(values["console_image"], "ghcr.io/sanadunt/sdr-doa-ground-console")
        self.assertEqual(values["agent_tags"][-1], "ghcr.io/sanadunt/sdr-doa-rdf-sdr-agent:latest")
        self.assertEqual(len(values["labels"]), 3)


if __name__ == "__main__":
    unittest.main()
