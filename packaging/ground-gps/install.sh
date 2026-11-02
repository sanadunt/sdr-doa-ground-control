#!/bin/sh
# Installs ground-gps-publisher (packaging/ground-gps) on the groundstation,
# outside Docker: the program, its settings /etc/ground-gps/ground-gps.conf and
# ground-gps.service, which reads the groundstation's own GNSS receiver (read
# only) and publishes its position, retained, on sdr/v2/<node>/ground/gps of
# the local MQTT broker for the SDR-DoA Ground Console.
#
#   sudo sh install.sh              # install or upgrade, enable and (re)start
#   sudo sh install.sh --dry-run    # show what it would do
#
# The service runs as a user of its own (DynamicUser) in the dialout group and
# may open USB ACM ttys only, read only. It opens no port and touches no other
# service, udev rule or firewall. Re-running it upgrades in place and keeps
# ground-gps.conf. Run it from packaging/ground-gps in the repository or in the
# console release.
set -eu
# The files must be readable whatever umask sudo keeps.
umask 022

MARKER=packaging/ground-gps
PREFIX=/usr/local
UNIT_DIR=/etc/systemd/system
CONFIG_DIR=/etc/ground-gps
ROOT=
REAL_ROOT=
DRY_RUN=0
DRY_STOP=0
# Tests only: the uid whose files count as root's.
ROOT_UID=${GROUND_GPS_ROOT_UID:-0}
WORK=

usage() {
  cat <<'EOF'
Usage: sudo sh install.sh [options]

  --prefix DIR         program files (default /usr/local):
                       DIR/bin/ground-gps-publisher, DIR/share/ground-gps/
  --root DIR           install below DIR (test staging): no systemctl
  --dry-run            show the files and commands, change nothing; exits 1
                       when the install would stop
  -h, --help           this help

Settings: /etc/ground-gps/ground-gps.conf, written from ground-gps.conf.example
on the first install and kept afterwards (DEVICE, BAUD, BROKER_HOST,
BROKER_PORT, NODE_ID, INTERVAL).

Remove with:
  sudo sh PREFIX/share/ground-gps/uninstall.sh [--purge]
EOF
}

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# refuse MESSAGE: the install stops; a dry run notes it and goes on.
refuse() {
  if [ "$DRY_RUN" = 1 ]; then
    warn "the install would stop here: $*"
    DRY_STOP=1
  else
    die "$*"
  fi
}

cleanup() {
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf "$WORK"; fi
}

# A command that changes the running system.
act() {
  if [ "$DRY_RUN" = 1 ]; then
    say "would run: $*"
  elif [ -n "$ROOT" ]; then
    say "skipped (--root): $*"
  else
    "$@"
  fi
}

need_value() {
  if [ $# -lt 2 ] || [ -z "$2" ]; then
    die "$1 needs a value"
  fi
}

# Values go into sed replacements and the unit file.
check_path() {
  case $2 in
    /*) ;;
    *) die "$1 must be an absolute path: $2" ;;
  esac
  case $2 in
    *[!A-Za-z0-9/._+-]*) die "$1 may hold only letters, digits and / . _ + -: $2" ;;
  esac
}

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --*=*)
        opt=${1%%=*}
        value=${1#*=}
        shift
        set -- "$opt" "$value" "$@"
        continue
        ;;
    esac
    case $1 in
      --prefix) need_value "$@"; PREFIX=$2; shift ;;
      --root) need_value "$@"; ROOT=$2; shift ;;
      --dry-run) DRY_RUN=1 ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option $1 (see --help)" ;;
    esac
    shift
  done
  check_path --prefix "$PREFIX"
  [ "$PREFIX" != / ] || die "--prefix must not be /"
  if [ -n "$ROOT" ]; then
    check_path --root "$ROOT"
  fi
}

locate_source() {
  HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
  for file in ground-gps-publisher uninstall.sh README.md ground-gps.service.in ground-gps.conf.example; do
    [ -f "$HERE/$file" ] || die "$HERE/$file is missing; run install.sh from packaging/ground-gps"
  done
  VERSION=unknown
  if [ -f "$HERE/../../VERSION" ]; then
    VERSION=$(head -n 1 "$HERE/../../VERSION")
  fi
}

# The python3 the service runs the publisher with: an absolute path.
find_python() {
  PYTHON=$(command -v python3 2>/dev/null) || PYTHON=
  case $PYTHON in
    /*) ;;
    *) die "python3 was not found; install it (sudo apt install python3)" ;;
  esac
  check_path python3 "$PYTHON"
}

# Refuse to replace a file this installer did not write.
check_ours() {
  if [ -e "$1" ] && ! grep -q "$MARKER" "$1" 2>/dev/null; then
    refuse "$1 exists and was not written by this installer; move it away or choose another --prefix"
  fi
}

# root_only PATH: owned by root and writable by no one else; a group- or
# world-writable directory only with the sticky bit (/tmp).
root_only() {
  # shellcheck disable=SC2012 # ls -n is the portable way to read owner and mode
  ls -nd -- "$1" 2>/dev/null | awk -v root="$ROOT_UID" '
    NR == 1 {
      mode = $1
      if ($3 != 0 && $3 != root) exit 1
      if (substr(mode, 1, 1) == "l") exit 1
      writable = substr(mode, 6, 1) == "w" || substr(mode, 9, 1) == "w"
      if (writable && !(substr(mode, 1, 1) == "d" && substr(mode, 10, 1) ~ /[tT]/)) exit 1
      ok = 1
    }
    END { exit ok ? 0 : 1 }'
}

# root_only_chain PATH: the nearest existing directory of PATH (the installer
# creates the rest as root) and every directory above it, by physical path.
# Sets UNSAFE to the first one that is not root-only.
root_only_chain() {
  UNSAFE=$1
  while [ ! -d "$UNSAFE" ]; do UNSAFE=$(dirname -- "$UNSAFE"); done
  ro_path=$(cd -P -- "$UNSAFE" 2>/dev/null && pwd -P) || return 1
  while :; do
    UNSAFE=$ro_path
    root_only "$ro_path" || return 1
    [ "$ro_path" != / ] || return 0
    ro_path=$(dirname -- "$ro_path")
  done
}

# check_targets TREE: what the install below TREE ("" for the system) would
# replace or have systemd run.
check_targets() {
  for target in "$1$PREFIX/bin/ground-gps-publisher" "$1$UNIT_DIR/ground-gps.service"; do
    check_ours "$target"
  done
  if [ -e "$1$SHARE_DIR" ] && [ ! -f "$1$SHARE_DIR/install-info" ] && [ -n "$(ls -A "$1$SHARE_DIR")" ]; then
    refuse "$SHARE_DIR is not empty and holds no ground-gps install"
  fi
  # systemd runs bin/ground-gps-publisher and root runs uninstall.sh: a user
  # who can change one of these directories could run code there.
  for dir in "$1$PREFIX/bin" "$1$SHARE_DIR"; do
    if ! root_only_chain "$dir"; then
      refuse "$UNSAFE is not owned by root or is writable by another user, so the service must not run programs from $dir; choose another --prefix, or: sudo chown root:root $UNSAFE && sudo chmod go-w $UNSAFE"
    fi
  done
}

# render TEMPLATE TARGET: replace the @NAME@ placeholders.
render() {
  sed -e "s|@BIN_DIR@|$PREFIX/bin|g" -e "s|@SHARE_DIR@|$SHARE_DIR|g" -e "s|@CONFIG@|$CONFIG_DIR/ground-gps.conf|g" \
    -e "s|@PYTHON@|$PYTHON|g" "$1" >"$2.new"
  if grep -q '@[A-Z_]*@' "$2.new"; then
    rm -f "$2.new"
    die "unreplaced placeholders in $1"
  fi
  chmod 0644 "$2.new"
  mv -f "$2.new" "$2"
}

copy() {
  # copy SOURCE TARGET MODE
  cp "$1" "$2.new"
  chmod "$3" "$2.new"
  mv -f "$2.new" "$2"
}

# The settings that will be in effect, checked by the publisher itself.
read_config() {
  values=$("$PYTHON" -I "$HERE/ground-gps-publisher" check-config --config "$1" 2>&1) ||
    refuse "$CONFIG_DIR/ground-gps.conf: $(printf '%s' "$values" | tail -n 1)"
  DEVICE=$(printf '%s\n' "$values" | sed -n 's/^DEVICE=//p')
  TOPIC=$(printf '%s\n' "$values" | sed -n 's/^TOPIC=//p')
  BROKER=$(printf '%s\n' "$values" | sed -n 's/^BROKER_HOST=//p'):$(printf '%s\n' "$values" | sed -n 's/^BROKER_PORT=//p')
}

# Read-only checks of the running system; --root (test staging) skips them.
preflight() {
  if [ -n "$ROOT" ] && [ "$DRY_RUN" = 0 ]; then
    return 0
  fi
  if [ ! -d /run/systemd/system ]; then
    warn "systemd is not running: ground-gps.service needs it"
  fi
  if ! grep -q '^dialout:' /etc/group 2>/dev/null; then
    warn "the group dialout does not exist here; the service cannot open the receiver until the group that owns its tty is set (systemctl edit ground-gps: SupplementaryGroups=)"
  fi
}

# check_device: the receiver of the config in effect, seen from the running system.
check_device() {
  if [ -n "$ROOT" ] && [ "$DRY_RUN" = 0 ]; then
    return 0
  fi
  [ -n "${DEVICE:-}" ] || return 0
  if [ ! -e "$DEVICE" ]; then
    warn "$DEVICE does not exist (receiver unplugged, or another name: ls -l /dev/serial/by-id/); the service reports NO_DEVICE until it appears"
    return 0
  fi
  real=$(readlink -f -- "$DEVICE" 2>/dev/null || printf '%s' "$DEVICE")
  case ${real##*/} in
    ttyACM*) ;;
    *) warn "$DEVICE is $real, not a USB ACM tty: the service may open ttyACM* only; allow it with a drop-in (systemctl edit ground-gps)" ;;
  esac
}

install_files() {
  bin=$ROOT$PREFIX/bin
  share=$ROOT$SHARE_DIR
  config=$ROOT$CONFIG_DIR/ground-gps.conf
  units=$ROOT$UNIT_DIR
  # A dry run checked the real paths before it switched to its scratch tree.
  if [ "$DRY_RUN" = 0 ]; then
    check_targets "$ROOT"
  fi

  mkdir -p "$bin" "$share" "$units" "$ROOT$CONFIG_DIR"
  copy "$HERE/ground-gps-publisher" "$bin/ground-gps-publisher" 0755
  copy "$HERE/uninstall.sh" "$share/uninstall.sh" 0755
  copy "$HERE/README.md" "$share/README.md" 0644
  copy "$HERE/ground-gps.conf.example" "$share/ground-gps.conf.example" 0644

  if [ -f "$config" ]; then
    say "Keeping $CONFIG_DIR/ground-gps.conf"
  else
    copy "$HERE/ground-gps.conf.example" "$config" 0644
    say "Wrote $CONFIG_DIR/ground-gps.conf"
  fi
  # A config the publisher cannot use stops the install here.
  read_config "$config"

  render "$HERE/ground-gps.service.in" "$units/ground-gps.service"

  cat >"$share/install-info" <<EOF
# ground-gps install record (packaging/ground-gps), read by uninstall.sh
PREFIX=$PREFIX
CONFIG_DIR=$CONFIG_DIR
UNIT_DIR=$UNIT_DIR
VERSION=$VERSION
EOF
  chmod 0644 "$share/install-info"
}

enable_units() {
  if [ -z "$ROOT" ] && [ "$DRY_RUN" = 0 ] && [ ! -d /run/systemd/system ]; then
    warn "systemd is not running; unit written but not enabled"
    return 0
  fi
  act systemctl daemon-reload
  act systemctl enable ground-gps.service
  # A re-run is an upgrade: the running publisher takes the new program.
  act systemctl restart ground-gps.service
}

show_dry_run() {
  for file in "$UNIT_DIR/ground-gps.service" "$CONFIG_DIR/ground-gps.conf"; do
    say "--- $file"
    cat "$ROOT$file"
  done
  say "--- program files"
  say "$PREFIX/bin/ground-gps-publisher"
  say "$SHARE_DIR/{README.md,uninstall.sh,ground-gps.conf.example,install-info}"
}

main() {
  WORK=$(mktemp -d)
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  parse_args "$@"
  SHARE_DIR=$PREFIX/share/ground-gps
  locate_source
  if [ "$DRY_RUN" = 1 ]; then
    REAL_ROOT=$ROOT
    ROOT=$WORK/root
  elif [ -z "$ROOT" ] && [ "$(id -u)" != 0 ]; then
    die "run as root: sudo sh $0 $*"
  fi
  find_python
  preflight

  if [ "$DRY_RUN" = 1 ]; then
    say "Dry run of the ground-gps install into $PREFIX"
    check_targets "$REAL_ROOT"
    # The config of the tree it checks, when there is one.
    if [ -f "$REAL_ROOT$CONFIG_DIR/ground-gps.conf" ]; then
      mkdir -p "$ROOT$CONFIG_DIR"
      cp "$REAL_ROOT$CONFIG_DIR/ground-gps.conf" "$ROOT$CONFIG_DIR/ground-gps.conf"
    fi
  else
    say "Installing ground-gps into $ROOT$PREFIX"
  fi
  install_files
  check_device
  enable_units
  if [ "$DRY_RUN" = 1 ]; then
    show_dry_run
    if [ "$DRY_STOP" = 1 ]; then
      say "Dry run: nothing was changed. The install would stop: see the warnings."
      return 1
    fi
    say "Dry run: nothing was changed."
    return 0
  fi
  say "Receiver: $DEVICE (read only)"
  say "Publishes: $TOPIC on $BROKER (retained)"
  say "Status:  systemctl status ground-gps    Journal: journalctl -u ground-gps"
  say "Check:   ground-gps-publisher print --config $CONFIG_DIR/ground-gps.conf   (stop the service first: the receiver is read by one program at a time)"
  say "Remove:  sudo sh $SHARE_DIR/uninstall.sh [--purge]"
}

main "$@"
