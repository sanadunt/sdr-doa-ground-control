#!/usr/bin/env python3
"""Build the Linux release tarballs of the Ground Console and the RDF-SDR agent.

Writes, in ``dist/release`` by default:

* ``sdr-doa-ground-console-<VERSION>-linux.tar.gz``: the prebuilt frontend
  (``frontend/dist`` with the embedded Receiver), the console's runtime Python
  modules, the native installer, ``Dockerfile.release`` with its compose file,
  ``docker-compose.ghcr.yml``, the Docker host script
  ``packaging/docker/sdr-doa-docker``, ``QUICKSTART.md`` and the user manual
  PDF;
* ``sdr-doa-rdf-sdr-agent-<VERSION>.tar.gz``: the edge agent's runtime
  modules, its installer and systemd unit, and ``Dockerfile.agent``;
* ``sdr-doa-docker``: the Docker host script on its own (install, update and
  roll back the GHCR images), a release asset next to the tarballs;
* ``SHA256SUMS`` for the three, in ``sha256sum -c`` format.

The runtime modules are the import closure of each entry point inside
``tools/``, so tests, fixtures and staging tools never ship. Every tree also
carries ``MANIFEST.sha256``, which the installers check. The archives are
deterministic: sorted entries, root owner, fixed modes, one mtime
(``SOURCE_DATE_EPOCH``, else the last commit time) and a gzip header without
a name or time.

Without ``--skip-build`` the script runs ``npm ci`` and ``npm run build:all``
in ``frontend/`` first, which needs Node.js and the ``vendor/BrowSDR``
submodule. ``--stage-console`` and ``--stage-agent`` only copy the runtime
tree into a directory; the Docker build and the installers use them when they
run from a repository checkout.
"""

from __future__ import annotations

import argparse
import ast
import gzip
import hashlib
import io
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Set

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "dist" / "release"
CONSOLE_ENTRY = "ground_console"
AGENT_ENTRY = "sdr_doa_lan_agent"
MANIFEST_NAME = "MANIFEST.sha256"
CHECKSUMS_NAME = "SHA256SUMS"
# The Docker host script: in the console tarball and a standalone asset.
DOCKER_SCRIPT = "packaging/docker/sdr-doa-docker"
DOCKER_SCRIPT_ASSET = "sdr-doa-docker"
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
# 1980-01-01, the earliest time every archive format can store.
FALLBACK_EPOCH = 315532800
MANUAL_PDF = "docs/manual/Panduan_Penggunaan_SDR-DoA_Ground_Console.pdf"
BROWSDR_LICENSE = "vendor/BrowSDR/LICENSE"
# Never shipped from a walked directory such as frontend/dist.
_SKIP_NAMES = frozenset({"node_modules", "__pycache__", ".git", ".DS_Store"})
_SKIP_SUFFIXES = (".pyc", ".pyo")

# (published path, source path relative to the repository, executable)
CONSOLE_APP_FILES = (
    ("packaging/console/requirements.txt", "packaging/console/requirements.txt", False),
    ("packaging/console/set_admin_password.py", "packaging/console/set_admin_password.py", True),
    ("packaging/console/update_release.py", "packaging/console/update_release.py", True),
    ("packaging/docker/console-entrypoint.sh", "packaging/docker/console-entrypoint.sh", True),
    ("packaging/docker/healthcheck.py", "packaging/docker/healthcheck.py", False),
)
CONSOLE_RELEASE_FILES = (
    ("install.sh", "packaging/console/install.sh", True),
    ("README.md", "packaging/console/README.md", False),
    ("packaging/console/sdr-doa-console", "packaging/console/sdr-doa-console", True),
    ("packaging/console/sdr-doa-ground-console.service.in", "packaging/console/sdr-doa-ground-console.service.in", False),
    ("packaging/console/sdr-doa-ground-console.desktop.in", "packaging/console/sdr-doa-ground-console.desktop.in", False),
    ("packaging/console/sdr-doa-ground-console.svg", "packaging/console/sdr-doa-ground-console.svg", False),
    ("Dockerfile.release", "Dockerfile.release", False),
    ("docker-compose.yml", "docker-compose.release.yml", False),
    ("docker-compose.ghcr.yml", "docker-compose.ghcr.yml", False),
    (DOCKER_SCRIPT, DOCKER_SCRIPT, True),
    (".env.example", ".env.example", False),
    ("QUICKSTART.md", "QUICKSTART.md", False),
    (MANUAL_PDF, MANUAL_PDF, False),
)
AGENT_APP_FILES = (
    ("packaging/agent/run-agent.sh", "packaging/agent/run-agent.sh", True),
)
AGENT_RELEASE_FILES = (
    ("install.sh", "packaging/agent/install-agent.sh", True),
    ("README.md", "packaging/agent/README.md", False),
    ("packaging/agent/uninstall-agent.sh", "packaging/agent/uninstall-agent.sh", True),
    ("packaging/agent/sdr-doa-agent.service.in", "packaging/agent/sdr-doa-agent.service.in", False),
    ("packaging/agent/agent.env.example", "packaging/agent/agent.env.example", False),
    ("Dockerfile.agent", "Dockerfile.agent", False),
    ("docker-compose.yml", "docker-compose.agent.yml", False),
)
# Inputs of a full build; a dirty copy would leak into frontend/dist.
BUILD_INPUTS = (
    "frontend/index.html",
    "frontend/package.json",
    "frontend/package-lock.json",
    "frontend/public",
    "frontend/src",
    "frontend/scripts",
    "frontend/vite.config.ts",
    "tools/build_browsdr_receiver.py",
    "tools/browsdr_receiver_overlay",
)


class ReleaseError(Exception):
    """The release cannot be built from the current tree."""


@dataclass(frozen=True)
class Entry:
    """One file or directory of a release tree, relative to its top directory."""

    arcname: str
    source: Optional[Path] = None
    data: Optional[bytes] = None
    executable: bool = False
    is_dir: bool = False

    def read(self) -> bytes:
        if self.data is not None:
            return self.data
        assert self.source is not None
        return self.source.read_bytes()


def read_version(root: Path = PROJECT_ROOT) -> str:
    path = root / "VERSION"
    try:
        version = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise ReleaseError(f"cannot read {path}: {exc}") from None
    if not VERSION_RE.fullmatch(version):
        raise ReleaseError(f"{path} must hold one version such as 2.0.0, found {version!r}")
    return version


def console_release_name(version: str) -> str:
    return f"sdr-doa-ground-console-{version}-linux"


def agent_release_name(version: str) -> str:
    return f"sdr-doa-rdf-sdr-agent-{version}"


def _imported_names(path: Path) -> Set[str]:
    """Top-level names a module imports anywhere, including lazy and relative imports."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    names: Set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                names.add(node.module.split(".")[0])
            elif node.level:
                names.update(alias.name for alias in node.names)
    return names


def runtime_modules(entry: str, tools_dir: Path = PROJECT_ROOT / "tools") -> List[str]:
    """File names of ``entry`` and every ``tools/`` module it imports, transitively."""
    pending = [entry]
    seen: Set[str] = set()
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        if name.startswith("test_"):
            raise ReleaseError(f"{entry} imports the test module {name}")
        path = tools_dir / f"{name}.py"
        if not path.is_file():
            raise ReleaseError(f"runtime module {path} not found")
        seen.add(name)
        pending.extend(
            imported
            for imported in sorted(_imported_names(path))
            if imported not in seen and (tools_dir / f"{imported}.py").is_file()
        )
    return sorted(f"{name}.py" for name in seen)


def _skipped(name: str) -> bool:
    return name in _SKIP_NAMES or name == ".env" or name.startswith(".env.") or name.endswith(_SKIP_SUFFIXES)


def _walk_files(directory: Path) -> Iterable[Path]:
    for current, dirs, files in os.walk(directory, followlinks=False):
        current_path = Path(current)
        for name in list(dirs):
            if (current_path / name).is_symlink():
                raise ReleaseError(f"refusing to package the symlink {current_path / name}")
        dirs[:] = sorted(name for name in dirs if not _skipped(name))
        for name in sorted(files):
            path = current_path / name
            if path.is_symlink():
                raise ReleaseError(f"refusing to package the symlink {path}")
            if not _skipped(name):
                yield path


def check_dist(dist_dir: Path) -> None:
    for required in ("index.html", "receiver/index.html"):
        if not (dist_dir / required).is_file():
            hint = (
                "build the Receiver with tools/build_browsdr_receiver.py (or npm run build:all; "
                "it needs git submodule update --init --recursive)"
                if required.startswith("receiver/")
                else "run npm run build:all in frontend/"
            )
            raise ReleaseError(f"{dist_dir / required} is missing; {hint}")


def _file_entries(root: Path, files: Sequence[tuple]) -> List[Entry]:
    entries = []
    for arcname, relative, executable in files:
        source = root / relative
        if not source.is_file():
            raise ReleaseError(f"release input {source} is missing")
        entries.append(Entry(arcname, source=source, executable=executable))
    return entries


def _module_entries(root: Path, entry: str) -> List[Entry]:
    tools_dir = root / "tools"
    return [Entry(f"tools/{name}", source=tools_dir / name) for name in runtime_modules(entry, tools_dir)]


def console_app_entries(root: Path, dist_dir: Path) -> List[Entry]:
    """The installed console: what Docker copies and the native installer installs."""
    check_dist(dist_dir)
    entries = [Entry("VERSION", data=f"{read_version(root)}\n".encode())]
    entries += _module_entries(root, CONSOLE_ENTRY)
    entries += [
        Entry(f"frontend/dist/{path.relative_to(dist_dir).as_posix()}", source=path)
        for path in _walk_files(dist_dir)
    ]
    entries += _file_entries(root, CONSOLE_APP_FILES)
    return entries


def agent_app_entries(root: Path) -> List[Entry]:
    entries = [Entry("VERSION", data=f"{read_version(root)}\n".encode())]
    entries += _module_entries(root, AGENT_ENTRY)
    entries += _file_entries(root, AGENT_APP_FILES)
    return entries


def console_release_entries(root: Path, dist_dir: Path, wheels: Sequence[Path] = ()) -> List[Entry]:
    entries = console_app_entries(root, dist_dir) + _file_entries(root, CONSOLE_RELEASE_FILES)
    license_path = root / BROWSDR_LICENSE
    if license_path.is_file():
        entries.append(Entry("licenses/BrowSDR-LICENSE", source=license_path))
    else:
        print(f"warning: {license_path} not found; the release ships without the BrowSDR license", file=sys.stderr)
    # Always present, so Dockerfile.release can COPY it; holds wheels with --with-wheels.
    entries.append(Entry("wheels", is_dir=True))
    entries += [Entry(f"wheels/{wheel.name}", source=wheel) for wheel in sorted(wheels)]
    return _with_manifest(entries)


def agent_release_entries(root: Path) -> List[Entry]:
    return _with_manifest(agent_app_entries(root) + _file_entries(root, AGENT_RELEASE_FILES))


def _with_manifest(entries: List[Entry]) -> List[Entry]:
    names = [entry.arcname for entry in entries]
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        raise ReleaseError(f"duplicate release paths: {', '.join(duplicates)}")
    lines = [
        f"{hashlib.sha256(entry.read()).hexdigest()}  {entry.arcname}\n"
        for entry in sorted(entries, key=lambda item: item.arcname)
        if not entry.is_dir
    ]
    return entries + [Entry(MANIFEST_NAME, data="".join(lines).encode())]


def _members(entries: Sequence[Entry]) -> Dict[str, Entry]:
    """Every path of the tree, with an Entry for each parent directory."""
    members: Dict[str, Entry] = {}
    for entry in entries:
        parts = entry.arcname.split("/")
        if entry.arcname.startswith("/") or ".." in parts or "" in parts:
            raise ReleaseError(f"unsafe release path {entry.arcname!r}")
        for index in range(1, len(parts)):
            parent = "/".join(parts[:index])
            members.setdefault(parent, Entry(parent, is_dir=True))
        members[entry.arcname] = entry
    return members


def write_tarball(entries: Sequence[Entry], top: str, destination: Path, mtime: int) -> Path:
    members = _members(entries)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.tmp")
    try:
        with open(temporary, "wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=mtime, compresslevel=9) as compressed:
                with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                    for name in [""] + sorted(members):
                        entry = members[name] if name else Entry("", is_dir=True)
                        info = tarfile.TarInfo(f"{top}/{name}" if name else top)
                        info.mtime = mtime
                        info.uid = info.gid = 0
                        info.uname = info.gname = "root"
                        if entry.is_dir:
                            info.type = tarfile.DIRTYPE
                            info.mode = 0o755
                            archive.addfile(info)
                            continue
                        data = entry.read()
                        info.size = len(data)
                        info.mode = 0o755 if entry.executable else 0o644
                        archive.addfile(info, io.BytesIO(data))
        os.replace(temporary, destination)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return destination


def stage_tree(entries: Sequence[Entry], destination: Path) -> Path:
    """Copy a tree into ``destination``, which must be absent or empty."""
    if destination.is_symlink() or (destination.exists() and (not destination.is_dir() or any(destination.iterdir()))):
        raise ReleaseError(f"stage directory {destination} must be absent or empty")
    for name, entry in sorted(_members(entries).items()):
        target = destination / name
        if entry.is_dir:
            target.mkdir(parents=True, exist_ok=True)
            target.chmod(0o755)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(entry.read())
        target.chmod(0o755 if entry.executable else 0o644)
    destination.chmod(0o755)
    return destination


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def write_asset(source: Path, destination: Path, executable: bool = False) -> Path:
    """Copy one standalone release asset, atomically, with a fixed mode."""
    if not source.is_file():
        raise ReleaseError(f"release input {source} is missing")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.tmp")
    try:
        temporary.write_bytes(source.read_bytes())
        temporary.chmod(0o755 if executable else 0o644)
        os.replace(temporary, destination)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return destination


def write_checksums(paths: Sequence[Path], destination: Path) -> Path:
    lines = "".join(f"{sha256_file(path)}  {path.name}\n" for path in sorted(paths, key=lambda item: item.name))
    temporary = destination.with_name(f".{destination.name}.tmp")
    temporary.write_text(lines, encoding="utf-8")
    os.replace(temporary, destination)
    return destination


def _git(root: Path, *args: str) -> Optional[subprocess.CompletedProcess]:
    git = shutil.which("git")
    if git is None:
        return None
    try:
        return subprocess.run([git, "-C", str(root), *args], capture_output=True, text=True, check=False)
    except OSError:
        return None


def _is_git_checkout(root: Path) -> bool:
    result = _git(root, "rev-parse", "--is-inside-work-tree")
    return result is not None and result.returncode == 0 and result.stdout.strip() == "true"


def check_clean(root: Path, paths: Sequence[str]) -> None:
    """Refuse release inputs with uncommitted changes or untracked files."""
    if not _is_git_checkout(root):
        raise ReleaseError(f"{root} is not a git checkout; pass --allow-dirty to build from it anyway")
    result = _git(root, "status", "--porcelain", "--untracked-files=all", "--", *sorted(set(paths)))
    if result is None or result.returncode != 0:
        raise ReleaseError("git status failed; pass --allow-dirty to skip the clean-tree check")
    if result.stdout.strip():
        raise ReleaseError(
            "release inputs have uncommitted changes; commit them or pass --allow-dirty:\n" + result.stdout.rstrip()
        )


def source_date_epoch(root: Path, explicit: Optional[int]) -> int:
    if explicit is not None:
        return explicit
    environment = os.environ.get("SOURCE_DATE_EPOCH", "").strip()
    if environment:
        try:
            return max(0, int(environment))
        except ValueError:
            raise ReleaseError("SOURCE_DATE_EPOCH must be an integer") from None
    result = _git(root, "log", "-1", "--format=%ct")
    if result is not None and result.returncode == 0 and result.stdout.strip().isdigit():
        return int(result.stdout.strip())
    return FALLBACK_EPOCH


def build_frontend(root: Path) -> None:
    npm = shutil.which("npm")
    if npm is None:
        raise ReleaseError("npm was not found on PATH; install Node.js 22.12 or later, or pass --skip-build")
    if not (root / "vendor/BrowSDR/package.json").is_file():
        raise ReleaseError("vendor/BrowSDR is empty; run git submodule update --init --recursive first")
    frontend = root / "frontend"
    for command in ([npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], [npm, "run", "build:all"]):
        print(f"$ npm {' '.join(command[1:])}", flush=True)
        try:
            subprocess.run(command, cwd=frontend, check=True)
        except subprocess.CalledProcessError as exc:
            raise ReleaseError(f"npm {command[1]} failed with exit code {exc.returncode}") from None


def download_wheels(root: Path, destination: Path) -> List[Path]:
    requirements = root / "packaging/console/requirements.txt"
    command = [
        sys.executable, "-m", "pip", "download", "--disable-pip-version-check", "--only-binary=:all:",
        "--no-deps", "--dest", str(destination), "-r", str(requirements),
    ]
    try:
        subprocess.run(command, check=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ReleaseError(f"pip download failed: {exc}") from None
    wheels = sorted(destination.glob("*.whl"))
    impure = [wheel.name for wheel in wheels if not wheel.name.endswith("-none-any.whl")]
    if impure or not wheels:
        raise ReleaseError(f"expected pure-Python wheels only, found {impure or 'none'}")
    return wheels


def _release_input_paths(root: Path, entries: Sequence[Entry], dist_dir: Path) -> List[str]:
    """Repository files the release copies, without the build output and the submodule."""
    root = root.resolve()
    skipped = (dist_dir.resolve(), root / "vendor")
    paths = ["VERSION"]
    for entry in entries:
        if entry.source is None:
            continue
        source = entry.source.resolve()
        if any(source.is_relative_to(directory) for directory in skipped) or not source.is_relative_to(root):
            continue
        paths.append(source.relative_to(root).as_posix())
    return paths


def build_release(
    root: Path = PROJECT_ROOT,
    *,
    output_dir: Path = DEFAULT_OUTPUT_DIR,
    dist_dir: Optional[Path] = None,
    skip_build: bool = False,
    allow_dirty: bool = False,
    with_wheels: bool = False,
    epoch: Optional[int] = None,
) -> List[Path]:
    """Build both tarballs, the standalone Docker script and SHA256SUMS; returns their paths."""
    root = root.resolve()
    version = read_version(root)
    dist = (dist_dir or root / "frontend" / "dist").resolve()
    if not skip_build:
        if dist_dir is not None:
            raise ReleaseError("--dist-dir needs --skip-build; a build always writes frontend/dist")
        if not allow_dirty:
            check_clean(root, BUILD_INPUTS)
        build_frontend(root)
    mtime = source_date_epoch(root, epoch)
    with tempfile.TemporaryDirectory(prefix="sdr-doa-wheels-") as wheel_dir:
        wheels = download_wheels(root, Path(wheel_dir)) if with_wheels else []
        console = console_release_entries(root, dist, wheels)
        agent = agent_release_entries(root)
        if not allow_dirty:
            check_clean(root, _release_input_paths(root, console + agent, dist))
        output_dir = output_dir.resolve()
        console_name = console_release_name(version)
        agent_name = agent_release_name(version)
        assets = [
            write_tarball(console, console_name, output_dir / f"{console_name}.tar.gz", mtime),
            write_tarball(agent, agent_name, output_dir / f"{agent_name}.tar.gz", mtime),
            write_asset(root / DOCKER_SCRIPT, output_dir / DOCKER_SCRIPT_ASSET, executable=True),
        ]
    checksums = write_checksums(assets, output_dir / CHECKSUMS_NAME)
    return assets + [checksums]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build the Ground Console and RDF-SDR agent release tarballs.")
    parser.add_argument("--skip-build", action="store_true", help="use the existing frontend/dist instead of npm ci + npm run build:all")
    parser.add_argument("--dist-dir", type=Path, help="prebuilt frontend dist to package (with --skip-build or --stage-console)")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help="where the tarballs go (default: dist/release)")
    parser.add_argument("--allow-dirty", action="store_true", help="skip the clean-tree check of the release inputs")
    parser.add_argument("--with-wheels", action="store_true", help="bundle the pure-Python wheels of requirements.txt for offline installs")
    parser.add_argument("--source-date-epoch", type=int, help="mtime of every archive entry (default: SOURCE_DATE_EPOCH or the last commit)")
    stage = parser.add_mutually_exclusive_group()
    stage.add_argument("--stage-console", type=Path, metavar="DIR", help="only copy the console runtime tree into DIR")
    stage.add_argument("--stage-agent", type=Path, metavar="DIR", help="only copy the agent runtime tree into DIR")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.stage_console is not None:
            dist = (args.dist_dir or PROJECT_ROOT / "frontend" / "dist").resolve()
            path = stage_tree(console_app_entries(PROJECT_ROOT, dist), args.stage_console)
            print(f"Console runtime staged in {path}", flush=True)
            return 0
        if args.stage_agent is not None:
            path = stage_tree(agent_app_entries(PROJECT_ROOT), args.stage_agent)
            print(f"Agent runtime staged in {path}", flush=True)
            return 0
        outputs = build_release(
            PROJECT_ROOT,
            output_dir=args.output_dir,
            dist_dir=args.dist_dir,
            skip_build=args.skip_build,
            allow_dirty=args.allow_dirty,
            with_wheels=args.with_wheels,
            epoch=args.source_date_epoch,
        )
    except (OSError, ReleaseError) as exc:
        print(f"release failed: {exc}", file=sys.stderr)
        return 1
    for path in outputs:
        print(path, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
