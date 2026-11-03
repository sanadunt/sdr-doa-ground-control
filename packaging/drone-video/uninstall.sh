#!/bin/sh
# Removes the drone-video install of install.sh (packaging/drone-video).
#
#   sudo sh /usr/local/share/drone-video/uninstall.sh            # keep drone-video.conf
#   sudo sh /usr/local/share/drone-video/uninstall.sh --purge    # remove it too
#
# It stops drone-video.service (the supervisor stops mediamtx and its ffmpeg
# with it) and removes only the files the installer wrote. mediamtx and ffmpeg
# themselves stay installed.
set -eu

MARKER=packaging/drone-video
PREFIX=
PURGE=0
ROOT=
DRY_RUN=0

usage() {
  cat <<'EOF_USAGE'
Usage: sudo sh uninstall.sh [--prefix DIR] [--purge] [--dry-run] [--root DIR]

Stops and disables drone-video.service, then removes the unit and the program
files. /etc/drone-video/drone-video.conf stays unless --purge is given.
EOF_USAGE
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

have_systemd() {
  [ -z "$ROOT" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

act() {
  if [ "$DRY_RUN" = 1 ]; then
    printf 'would run: %s\n' "$*"
  elif have_systemd; then
    "$@" || true
  fi
}

# remove PATH: only a file this installer wrote.
remove() {
  target=$ROOT$1
  [ -e "$target" ] || return 0
  if ! grep -q "$MARKER" "$target" 2>/dev/null; then
    printf 'kept %s: not written by the drone-video installer\n' "$1"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    printf 'would remove %s\n' "$1"
  else
    rm -f "$target"
  fi
}

while [ $# -gt 0 ]; do
  case $1 in
    --prefix) [ $# -ge 2 ] || die "--prefix needs a value"; PREFIX=$2; shift ;;
    --root) [ $# -ge 2 ] || die "--root needs a value"; ROOT=$2; shift ;;
    --purge) PURGE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

if [ -z "$PREFIX" ]; then
  here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
  if [ -f "$here/install-info" ]; then
    info=$here/install-info
  else
    info=$ROOT/usr/local/share/drone-video/install-info
  fi
else
  info=$ROOT$PREFIX/share/drone-video/install-info
fi
[ -f "$info" ] || die "$info not found; pass --prefix of the install"
if [ -z "$ROOT" ] && [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then
  die "run as root: sudo sh $0"
fi

# install-info is written by the installer: KEY=VALUE lines without quoting.
value() { sed -n "s/^$1=//p" "$info" | tail -n 1; }
PREFIX=$(value PREFIX)
CONFIG_DIR=$(value CONFIG_DIR)
UNIT_DIR=$(value UNIT_DIR)
for path in "$PREFIX" "$CONFIG_DIR" "$UNIT_DIR"; do
  case $path in /?*) ;; *) die "$info is damaged: unexpected path '$path'" ;; esac
done
SHARE_DIR=$PREFIX/share/drone-video

act systemctl disable --now drone-video.service
remove "$UNIT_DIR/drone-video.service"
act systemctl daemon-reload
remove "$PREFIX/bin/drone-video-supervisor"
if [ "$DRY_RUN" = 1 ]; then
  printf 'would remove %s\n' "$SHARE_DIR"
else
  rm -f "$ROOT$SHARE_DIR/README.md" "$ROOT$SHARE_DIR/drone-video.conf.example" "$ROOT$SHARE_DIR/uninstall.sh" \
    "$ROOT$SHARE_DIR/install-info"
  rmdir "$ROOT$SHARE_DIR" 2>/dev/null || true
  echo "Removed drone-video from $PREFIX"
fi

if [ "$PURGE" = 1 ]; then
  if [ "$DRY_RUN" = 1 ]; then
    printf 'would remove %s/drone-video.conf\n' "$CONFIG_DIR"
  else
    rm -f "$ROOT$CONFIG_DIR/drone-video.conf"
    rmdir "$ROOT$CONFIG_DIR" 2>/dev/null || true
    echo "Removed $CONFIG_DIR/drone-video.conf"
  fi
elif [ "$DRY_RUN" = 0 ]; then
  echo "Kept $CONFIG_DIR/drone-video.conf (remove it with --purge)"
fi
