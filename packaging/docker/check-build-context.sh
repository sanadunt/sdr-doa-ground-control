#!/bin/sh
# Build-stage check of Dockerfile: the Receiver needs the pinned vendor/BrowSDR
# submodule and its git metadata in the build context.
set -eu

if [ ! -f vendor/BrowSDR/package.json ]; then
  cat >&2 <<'EOF'
error: vendor/BrowSDR is empty, so the embedded Receiver cannot be built.
Fetch the pinned submodule on the host, then build again:
  git submodule update --init --recursive
  docker compose build
EOF
  exit 1
fi

if ! git -C vendor/BrowSDR rev-parse HEAD >/dev/null 2>&1; then
  cat >&2 <<'EOF'
error: vendor/BrowSDR has no usable git metadata in the build context, so the
Receiver builder cannot check the pinned commit. This happens in a git
worktree or a source export, where the submodule's git directory is not at
.git/modules/vendor/BrowSDR. Either build from a regular clone
(git clone --recursive), or build a release on the host with
  python3 tools/make_release.py
and build the image from the unpacked tarball with Dockerfile.release.
EOF
  exit 1
fi
