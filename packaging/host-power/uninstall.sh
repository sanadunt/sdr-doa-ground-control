#!/bin/sh
# Removes the sdr-doa-host-power install of install.sh (packaging/host-power).
#
#   sudo sh /usr/local/share/sdr-doa-host-power/uninstall.sh            # keep the state
#   sudo sh /usr/local/share/sdr-doa-host-power/uninstall.sh --purge    # remove it too
#
# It removes only the files the installer wrote and the helper marker, so the
# console's Restart and Shutdown buttons show "not installed" at once. The
# request directory under /run goes with the next boot.
set -eu

MARKER=packaging/host-power
PREFIX=
PURGE=0
ROOT=
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: sudo sh uninstall.sh [--prefix DIR] [--purge] [--dry-run] [--root DIR]

Stops and disables sdr-doa-host-power.path, then removes the units, the
tmpfiles.d rule, the helper marker and the program files. The state in
/var/lib/sdr-doa-host-power stays unless --purge is given.
EOF
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
    printf 'kept %s: not written by the sdr-doa-host-power installer\n' "$1"
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
    info=$ROOT/usr/local/share/sdr-doa-host-power/install-info
  fi
else
  info=$ROOT$PREFIX/share/sdr-doa-host-power/install-info
fi
[ -f "$info" ] || die "$info not found; pass --prefix of the install"
if [ -z "$ROOT" ] && [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then
  die "run as root: sudo sh $0"
fi

# install-info is written by the installer: KEY=VALUE lines without quoting.
value() { sed -n "s/^$1=//p" "$info" | tail -n 1; }
PREFIX=$(value PREFIX)
UNIT_DIR=$(value UNIT_DIR)
TMPFILES_DIR=$(value TMPFILES_DIR)
REQUEST_DIR=$(value REQUEST_DIR)
# The first unreleased install-info had no TAKEN_DIR.
TAKEN_DIR=$(value TAKEN_DIR)
TAKEN_DIR=${TAKEN_DIR:-$REQUEST_DIR.taken}
STATE_DIR=$(value STATE_DIR)
for path in "$PREFIX" "$UNIT_DIR" "$TMPFILES_DIR" "$REQUEST_DIR" "$TAKEN_DIR" "$STATE_DIR"; do
  case $path in /?*) ;; *) die "$info is damaged: unexpected path '$path'" ;; esac
done
SHARE_DIR=$PREFIX/share/sdr-doa-host-power

# No request is taken from here on.
act systemctl disable --now sdr-doa-host-power.path
for unit in sdr-doa-host-power.path sdr-doa-host-power.service; do
  remove "$UNIT_DIR/$unit"
done
act systemctl daemon-reload
remove "$TMPFILES_DIR/sdr-doa-host-power.conf"
# Without the marker the console disables its buttons. The directory may be
# a running container's bind mount, so it stays until the next boot empties /run.
if [ "$DRY_RUN" = 1 ]; then
  printf 'would remove %s/helper, a waiting request and %s\n' "$REQUEST_DIR" "$TAKEN_DIR"
else
  rm -f "$ROOT$REQUEST_DIR/helper" "$ROOT$REQUEST_DIR/request"
  rm -rf "$ROOT$TAKEN_DIR"
fi
remove "$PREFIX/sbin/sdr-doa-host-power"
if [ "$DRY_RUN" = 1 ]; then
  printf 'would remove %s\n' "$SHARE_DIR"
else
  rm -f "$ROOT$SHARE_DIR/README.md" "$ROOT$SHARE_DIR/uninstall.sh" "$ROOT$SHARE_DIR/install-info"
  rmdir "$ROOT$SHARE_DIR" 2>/dev/null || true
  echo "Removed sdr-doa-host-power from $PREFIX"
fi

if [ "$PURGE" = 1 ]; then
  if [ "$DRY_RUN" = 1 ]; then
    printf 'would remove %s\n' "$STATE_DIR"
  else
    rm -rf "$ROOT$STATE_DIR"
    echo "Removed the state in $STATE_DIR"
  fi
elif [ "$DRY_RUN" = 0 ]; then
  echo "Kept $STATE_DIR (remove it with --purge)"
fi
