#!/bin/sh
# Removes t900-ground-link installed by install.sh (packaging/ground-link).
#
#   sudo sh /usr/local/share/t900-ground-link/uninstall.sh            # keep link.conf and the state
#   sudo sh /usr/local/share/t900-ground-link/uninstall.sh --purge    # remove them too
#
# It removes only the files the installer wrote; the PPP service, its peer
# file and the udev rule stay as they are.
set -eu

MARKER=t900-ground-link
PREFIX=
PURGE=0
ROOT=
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: sudo sh uninstall.sh [--prefix DIR] [--purge] [--dry-run] [--root DIR]

Stops and disables the watchdog timer, then removes the units, the polkit
rule and the program files. /etc/t900-ground-link/link.conf and the
watchdog state in /var/lib/t900-ground-link stay unless --purge is given.
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
    printf 'kept %s: not written by the t900-ground-link installer\n' "$1"
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
    info=$ROOT/usr/local/share/t900-ground-link/install-info
  fi
else
  info=$ROOT$PREFIX/share/t900-ground-link/install-info
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
STATE_DIR=$(value STATE_DIR)
POLKIT_RULE=$(value POLKIT_RULE)
for path in "$PREFIX" "$CONFIG_DIR" "$UNIT_DIR" "$STATE_DIR"; do
  case $path in /?*) ;; *) die "$info is damaged: unexpected path '$path'" ;; esac
done
SHARE_DIR=$PREFIX/share/t900-ground-link

# No new checks from here on. A check or usb-reset already running is left to
# finish: stopping it between an unbind and a bind would leave the T900 tty gone.
act systemctl disable --now t900-ground-watchdog.timer
for unit in t900-ground-watchdog.service t900-ground-watchdog.timer t900-ground-usbreset.service; do
  remove "$UNIT_DIR/$unit"
done
act systemctl daemon-reload
if [ -n "$POLKIT_RULE" ]; then
  remove "$POLKIT_RULE"
fi
remove "$PREFIX/bin/t900-link"
remove "$PREFIX/bin/t900-ground-diag"
remove "$PREFIX/sbin/t900-ground-watchdog"
if [ "$DRY_RUN" = 1 ]; then
  printf 'would remove %s\n' "$SHARE_DIR"
else
  rm -f "$ROOT$SHARE_DIR/README.md" "$ROOT$SHARE_DIR/link.conf.example" "$ROOT$SHARE_DIR/uninstall.sh" \
    "$ROOT$SHARE_DIR/install-info"
  rmdir "$ROOT$SHARE_DIR" 2>/dev/null || true
  echo "Removed t900-ground-link from $PREFIX"
fi

if [ "$PURGE" = 1 ]; then
  if [ "$DRY_RUN" = 1 ]; then
    printf 'would remove %s/link.conf and %s\n' "$CONFIG_DIR" "$STATE_DIR"
  else
    rm -f "$ROOT$CONFIG_DIR/link.conf"
    rmdir "$ROOT$CONFIG_DIR" 2>/dev/null || true
    rm -rf "$ROOT$STATE_DIR"
    echo "Removed $CONFIG_DIR/link.conf and the watchdog state in $STATE_DIR"
  fi
elif [ "$DRY_RUN" = 0 ]; then
  echo "Kept $CONFIG_DIR/link.conf and $STATE_DIR (remove them with --purge)"
fi
