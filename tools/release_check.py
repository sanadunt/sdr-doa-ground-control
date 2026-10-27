#!/usr/bin/env python3
"""Checks and values for the release workflow (.github/workflows/release.yml).

Subcommands:

* ``tag``: decides whether this run may release the commit and under which
  tag. A tag push must be ``v<VERSION>`` exactly, with VERSION read from the
  tagged commit; a manual run (``workflow_dispatch``) must run on main and
  creates ``v<VERSION>`` when it is missing; either way the commit must be on
  ``origin/main``. Writes ``version``, ``tag``, ``sha``, ``create_tag`` and
  ``prerelease`` to ``$GITHUB_OUTPUT``.
* ``assets``: checks that a release directory holds exactly the release
  assets, that ``SHA256SUMS`` covers each of them, and that the console
  tarball ships the same ``sdr-doa-docker`` as the standalone asset.
* ``images``: writes the GHCR image name of the console, its reference for
  this version, the OCI labels, the channel tags this version may take and
  whether it is the newest release.
* ``channels``: the channel tags (``<MAJOR>.<MINOR>``, ``<MAJOR>``,
  ``latest``) this version may take, given the release tags that exist now.
  A channel tag moves only to the highest stable release it covers, so an
  older release built late, or a rerun of an old tag, never moves it back.
* ``revision``: the ``org.opencontainers.image.revision`` label of an image,
  read from ``docker buildx imagetools inspect --format '{{json .Image}}'``
  on stdin.

Standard library only; ``tag`` runs git. Nothing here touches the network.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

import make_release  # noqa: E402

PROJECT_ROOT = make_release.PROJECT_ROOT
MAIN_REF = "refs/remotes/origin/main"
MAIN_BRANCH_REF = "refs/heads/main"
DOCKER_SCRIPT_ASSET = "sdr-doa-docker"
DOCKER_SCRIPT_IN_CONSOLE = f"packaging/docker/{DOCKER_SCRIPT_ASSET}"
REGISTRY = "ghcr.io"
CONSOLE_IMAGE = "sdr-doa-ground-console"
EVENTS = ("push", "workflow_dispatch")
# Stricter than make_release.VERSION_RE: no leading zeros and no "+build"
# part, because every release version is also a Docker image tag.
RELEASE_VERSION_RE = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$"
)
_SHA256SUMS_LINE = re.compile(r"^([0-9a-f]{64}) [ *](\S+)$")


class CheckError(Exception):
    """This run must not release."""


@dataclass(frozen=True)
class ReleaseTag:
    version: str
    tag: str
    sha: str
    create_tag: bool

    @property
    def prerelease(self) -> bool:
        return is_prerelease(self.version)

    def outputs(self) -> Dict[str, str]:
        return {
            "version": self.version,
            "tag": self.tag,
            "sha": self.sha,
            "create_tag": "true" if self.create_tag else "false",
            "prerelease": "true" if self.prerelease else "false",
        }


def parse_release_version(version: str) -> tuple:
    """(major, minor, patch, prerelease or None) of a release version."""
    match = RELEASE_VERSION_RE.fullmatch(version)
    if match is None or not make_release.VERSION_RE.fullmatch(version):
        raise CheckError(
            f"VERSION {version!r} is not a release version: use X.Y.Z or X.Y.Z-pre "
            "(no leading zeros, no +build part, since it is also the image tag)"
        )
    major, minor, patch, pre = match.groups()
    return int(major), int(minor), int(patch), pre


def is_prerelease(version: str) -> bool:
    return parse_release_version(version)[3] is not None


def _git(root: Path, *args: str) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=False)
    except OSError as exc:
        raise CheckError(f"cannot run git: {exc}") from None


def _commit_of(root: Path, revision: str) -> Optional[str]:
    """The commit a revision names, or None when it does not exist."""
    result = _git(root, "rev-parse", "--quiet", "--verify", f"{revision}^{{commit}}")
    value = result.stdout.strip()
    return value if result.returncode == 0 and value else None


def version_at(root: Path, commit: str) -> str:
    result = _git(root, "show", f"{commit}:VERSION")
    if result.returncode != 0:
        raise CheckError(f"commit {commit[:12]} has no VERSION file")
    version = result.stdout.strip()
    parse_release_version(version)
    return version


def check_tag(
    root: Path,
    event: str,
    ref: str,
    sha: Optional[str] = None,
    main_ref: str = MAIN_REF,
) -> ReleaseTag:
    """Check that this run may release; see the module docstring."""
    if event not in EVENTS:
        raise CheckError(f"the release workflow runs on {' or '.join(EVENTS)}, not {event!r}")
    commit = _commit_of(root, sha or "HEAD")
    if commit is None:
        raise CheckError(f"{sha or 'HEAD'} is not a commit of {root}")
    version = version_at(root, commit)
    tag = f"v{version}"
    working_tree = root / "VERSION"
    if working_tree.is_file() and working_tree.read_text(encoding="utf-8").strip() != version:
        raise CheckError(f"the checked-out VERSION differs from VERSION {version} of commit {commit[:12]}")

    create_tag = False
    if event == "push":
        if not ref.startswith("refs/tags/"):
            raise CheckError(f"a release push must push a tag, not {ref}")
        pushed = ref[len("refs/tags/"):]
        if pushed != tag:
            raise CheckError(
                f"tag {pushed} does not match VERSION {version} of commit {commit[:12]}: "
                f"a release tag is v<VERSION> exactly, here {tag}"
            )
        tagged = _commit_of(root, f"refs/tags/{pushed}")
        if tagged != commit:
            raise CheckError(f"tag {pushed} points to {tagged or 'nothing'} here, not to the checked-out {commit[:12]}")
    else:
        if ref != MAIN_BRANCH_REF:
            raise CheckError(f"run the release workflow on main, not on {ref}")
        existing = _commit_of(root, f"refs/tags/{tag}")
        if existing is None:
            create_tag = True
        elif existing != commit:
            raise CheckError(
                f"tag {tag} already exists on {existing[:12]}, not on main at {commit[:12]}: "
                "bump VERSION on main for a new release, or rerun the workflow of that tag"
            )

    if _commit_of(root, main_ref) is None:
        raise CheckError(f"{main_ref} is missing; check out with fetch-depth: 0 so origin/main is known")
    ancestor = _git(root, "merge-base", "--is-ancestor", commit, main_ref)
    if ancestor.returncode == 1:
        raise CheckError(f"commit {commit[:12]} is not on origin/main; release only commits merged into main")
    if ancestor.returncode != 0:
        raise CheckError(f"git merge-base failed: {ancestor.stderr.strip()}")
    return ReleaseTag(version=version, tag=tag, sha=commit, create_tag=create_tag)


def release_assets(version: str) -> List[str]:
    """File names of the GitHub Release assets, in upload order."""
    parse_release_version(version)
    return [
        f"{make_release.console_release_name(version)}.tar.gz",
        DOCKER_SCRIPT_ASSET,
        make_release.CHECKSUMS_NAME,
    ]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def check_assets(directory: Path, version: str) -> List[Path]:
    """Check a release directory; returns the asset paths in upload order."""
    expected = release_assets(version)
    if not directory.is_dir():
        raise CheckError(f"{directory} is not a directory")
    errors = []
    present = {path.name for path in directory.iterdir()}
    missing = [name for name in expected if not (directory / name).is_file() or (directory / name).is_symlink()]
    if missing:
        errors.append(f"missing: {', '.join(missing)}")
    extra = sorted(present - set(expected))
    if extra:
        errors.append(f"not a release asset: {', '.join(extra)}")
    checksums = directory / make_release.CHECKSUMS_NAME
    if checksums.name not in missing:
        listed: Dict[str, str] = {}
        for number, line in enumerate(checksums.read_text(encoding="utf-8").splitlines(), 1):
            match = _SHA256SUMS_LINE.fullmatch(line)
            if match is None:
                errors.append(f"{checksums.name} line {number} is not '<sha256>  <name>'")
                continue
            digest, name = match.groups()
            if name in listed:
                errors.append(f"{checksums.name} lists {name} twice")
            listed[name] = digest
        covered = [name for name in expected if name != checksums.name]
        if sorted(listed) != sorted(covered):
            errors.append(f"{checksums.name} lists {sorted(listed)}, expected {sorted(covered)}")
        for name in covered:
            if name in listed and name not in missing and _sha256(directory / name) != listed[name]:
                errors.append(f"{name} does not match its {checksums.name} line")
    if not missing:
        errors += _check_console_docker_script(directory, version)
    if errors:
        raise CheckError(f"release assets in {directory}: " + "; ".join(errors))
    return [directory / name for name in expected]


def _check_console_docker_script(directory: Path, version: str) -> List[str]:
    console = directory / f"{make_release.console_release_name(version)}.tar.gz"
    member_name = f"{make_release.console_release_name(version)}/{DOCKER_SCRIPT_IN_CONSOLE}"
    try:
        with tarfile.open(console, "r:gz") as archive:
            try:
                member = archive.getmember(member_name)
            except KeyError:
                return [f"{console.name} does not ship {DOCKER_SCRIPT_IN_CONSOLE}"]
            handle = archive.extractfile(member) if member.isfile() else None
            if handle is None:
                return [f"{DOCKER_SCRIPT_IN_CONSOLE} in {console.name} is not a regular file"]
            shipped = handle.read()
    except (OSError, tarfile.TarError) as exc:
        return [f"cannot read {console.name}: {exc}"]
    if shipped != (directory / DOCKER_SCRIPT_ASSET).read_bytes():
        return [f"{DOCKER_SCRIPT_IN_CONSOLE} in {console.name} differs from the {DOCKER_SCRIPT_ASSET} asset"]
    return []


def stable_release_versions(tags: Iterable[str]) -> List[Tuple[int, int, int]]:
    """(major, minor, patch) of every stable release tag in ``tags``.

    Takes tag names or refs (``v2.0.1``, ``refs/tags/v2.0.1``, or ``git
    ls-remote`` lines); prereleases and anything that is not v<VERSION> are
    left out.
    """
    versions = set()
    for raw in tags:
        name = raw.strip().split()[-1] if raw.strip() else ""
        name = name[len("refs/tags/"):] if name.startswith("refs/tags/") else name
        if name.endswith("^{}"):
            name = name[:-3]
        if not name.startswith("v"):
            continue
        try:
            major, minor, patch, pre = parse_release_version(name[1:])
        except CheckError:
            continue
        if pre is None:
            versions.add((major, minor, patch))
    return sorted(versions)


def floating_tags(version: str, tags: Iterable[str] = ()) -> List[str]:
    """The channel tags of ``version``: <MAJOR>.<MINOR>, <MAJOR> and latest.

    Each one only when no stable release in ``tags`` that it covers is
    higher than ``version``; a prerelease gets none.
    """
    major, minor, patch, pre = parse_release_version(version)
    if pre is not None:
        return []
    own = (major, minor, patch)
    higher = [other for other in stable_release_versions(tags) if other > own]
    channels = []
    if not any(other[:2] == (major, minor) for other in higher):
        channels.append(f"{major}.{minor}")
    if not any(other[0] == major for other in higher):
        channels.append(f"{major}")
    if not higher:
        channels.append("latest")
    return channels


def image_tags(version: str, tags: Iterable[str] = ()) -> List[str]:
    """<V> and the channel tags it may take (see floating_tags)."""
    return [version] + floating_tags(version, tags)


def is_newest(version: str, tags: Iterable[str] = ()) -> bool:
    """A stable release with no higher stable release in ``tags``."""
    return "latest" in floating_tags(version, tags)


def image_revision(inspect_json: str) -> str:
    """The one revision label of ``docker buildx imagetools inspect --format '{{json .Image}}'``.

    A single-platform image prints its config; a multi-platform one a map of
    platform to config. Every platform must carry the same revision.
    """
    try:
        data = json.loads(inspect_json)
    except ValueError:
        raise CheckError("the image inspect output is not JSON") from None
    if not isinstance(data, dict):
        raise CheckError("the image inspect output is not a JSON object")
    configs = [data] if "config" in data or "architecture" in data else list(data.values())
    revisions = set()
    for image in configs:
        config = image.get("config") if isinstance(image, dict) else None
        labels = config.get("Labels") if isinstance(config, dict) else None
        revision = labels.get("org.opencontainers.image.revision") if isinstance(labels, dict) else None
        # Attestation entries carry no image config and no labels.
        if isinstance(revision, str) and revision:
            revisions.add(revision)
    if len(revisions) != 1:
        raise CheckError(f"the image has {len(revisions)} revision labels, not one: {sorted(revisions)}")
    return revisions.pop()


def image_name(owner: str, image: str, registry: str = REGISTRY) -> str:
    namespace = owner.strip().lower()
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", namespace):
        raise CheckError(f"{owner!r} is not a GitHub owner name")
    return f"{registry}/{namespace}/{image}"


def oci_labels(version: str, revision: str, source: str) -> List[str]:
    parse_release_version(version)
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise CheckError(f"{revision!r} is not a full commit SHA")
    if not re.fullmatch(r"https://[^\s/]+/[^\s/]+/[^\s/]+", source):
        raise CheckError(f"{source!r} is not a repository URL")
    return [
        f"org.opencontainers.image.version={version}",
        f"org.opencontainers.image.revision={revision}",
        f"org.opencontainers.image.source={source}",
    ]


def channel_outputs(version: str, tags: Iterable[str]) -> Dict[str, str]:
    tags = list(tags)
    return {
        "channels": " ".join(floating_tags(version, tags)),
        "newest": "true" if is_newest(version, tags) else "false",
    }


def image_outputs(owner: str, version: str, revision: str, source: str, tags: Iterable[str] = ()) -> Dict[str, str]:
    """The console image name, the <V> reference the build pushes, labels and the channels."""
    name = image_name(owner, CONSOLE_IMAGE)
    outputs = {"console_image": name, "console_ref": f"{name}:{version}"}
    outputs["labels"] = "\n".join(oci_labels(version, revision, source))
    outputs.update(channel_outputs(version, tags))
    return outputs


def read_tags(path: Optional[str]) -> List[str]:
    """Tag names or refs, one per line, from a file or stdin ("-"); none without a path."""
    if not path:
        return []
    try:
        if path == "-":
            return sys.stdin.read().splitlines()
        return Path(path).read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as exc:
        raise CheckError(f"cannot read the tag list {path}: {exc}") from None


def write_outputs(values: Dict[str, str], path: Optional[str]) -> None:
    """Append key=value pairs in the $GITHUB_OUTPUT format; print them too."""
    lines = []
    for key, value in values.items():
        if "\n" in value:
            delimiter = f"EOF_{uuid.uuid4().hex}"
            lines.append(f"{key}<<{delimiter}\n{value}\n{delimiter}\n")
        else:
            lines.append(f"{key}={value}\n")
        print(f"{key}: {value}", flush=True)
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.writelines(lines)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Checks and values for the release workflow.")
    parser.add_argument("--root", type=Path, default=PROJECT_ROOT, help="repository checkout (default: this one)")
    parser.add_argument(
        "--github-output",
        default=os.environ.get("GITHUB_OUTPUT"),
        help="file the outputs are appended to (default: $GITHUB_OUTPUT)",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    tag = commands.add_parser("tag", help="check the tag, VERSION and origin/main")
    tag.add_argument("--event", required=True, help="github.event_name: push or workflow_dispatch")
    tag.add_argument("--ref", required=True, help="github.ref: refs/tags/vX.Y.Z or refs/heads/main")
    tag.add_argument("--sha", help="commit to release (default: HEAD)")
    tag.add_argument("--main-ref", default=MAIN_REF, help=f"ref of main (default: {MAIN_REF})")
    assets = commands.add_parser("assets", help="check a release directory and print its assets")
    assets.add_argument("--dir", type=Path, required=True)
    assets.add_argument("--version", required=True)
    tags_help = "release tags or refs that exist, one per line ('-' for stdin)"
    images = commands.add_parser("images", help="the image name, its reference, OCI labels and channels")
    images.add_argument("--owner", required=True, help="github.repository_owner")
    images.add_argument("--version", required=True)
    images.add_argument("--revision", required=True, help="full commit SHA")
    images.add_argument("--source", required=True, help="repository URL")
    images.add_argument("--tags-file", help=tags_help)
    channels = commands.add_parser("channels", help="the channel tags this version may take now")
    channels.add_argument("--version", required=True)
    channels.add_argument("--tags-file", required=True, help=tags_help)
    commands.add_parser("revision", help="the revision label of 'imagetools inspect --format {{json .Image}}' on stdin")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "tag":
            result = check_tag(args.root.resolve(), args.event, args.ref, args.sha, args.main_ref)
            write_outputs(result.outputs(), args.github_output)
        elif args.command == "assets":
            for path in check_assets(args.dir, args.version):
                print(path, flush=True)
        elif args.command == "images":
            tags = read_tags(args.tags_file)
            write_outputs(image_outputs(args.owner, args.version, args.revision, args.source, tags), args.github_output)
        elif args.command == "channels":
            write_outputs(channel_outputs(args.version, read_tags(args.tags_file)), args.github_output)
        else:
            print(image_revision(sys.stdin.read()), flush=True)
    except CheckError as exc:
        # A workflow command on stdout, so the run shows it as an annotation.
        message = str(exc).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::error::{message}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
