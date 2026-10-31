#!/bin/sh
# Installs the host side of the SDR-DoA Ground Console's Restart and Shutdown
# buttons (packaging/host-power) on the groundstation, outside Docker: the
# request directory /run/sdr-doa-host-power for the console's user (a
# tmpfiles.d rule), sdr-doa-host-power.path and the root oneshot
# sdr-doa-host-power.service that runs systemctl reboot or poweroff.
#
#   sudo sh install.sh                        # console in Docker (uid 10001)
#   sudo sh install.sh --console-user rdf     # native console of the user rdf
#   sudo sh install.sh --dry-run              # show what it would do
#   sudo sh install.sh --helper-dry-run       # the helper only logs what it would run
#
# It opens no port and gives the console no socket, D-Bus, polkit or sudo
# rule: the console can only write one word into one directory. Re-running it
# upgrades in place. Run it from packaging/host-power in the repository or in
# the console release.
set -eu
# The request directory and the files must be readable whatever umask sudo keeps.
umask 022

MARKER=packaging/host-power
PREFIX=/usr/local
CONSOLE_USER=10001
UNIT_DIR=/etc/systemd/system
TMPFILES_DIR=/etc/tmpfiles.d
TMPFILES_NAME=sdr-doa-host-power.conf
# Fixed: the console's --host-power-dir default and the Docker bind mount.
REQUEST_DIR=/run/sdr-doa-host-power
# Root's own: the helper takes a request here with a hard link before it checks or reads it.
TAKEN_DIR=/run/sdr-doa-host-power.taken
STATE_DIR=/var/lib/sdr-doa-host-power
# The sdr-doa-docker install whose compose.yml must mount REQUEST_DIR.
DOCKER_DIR=/opt/sdr-doa-ground-console
ROOT=
REAL_ROOT=
DRY_RUN=0
DRY_STOP=0
# Tests only: the uid whose files count as root's.
ROOT_UID=${HOST_POWER_ROOT_UID:-0}
HELPER_MODE=
WORK=

usage() {
  cat <<'EOF'
Usage: sudo sh install.sh [options]

  --console-user NAME|UID  the user the console runs as, who may write
                       /run/sdr-doa-host-power (default 10001, the Docker
                       image's uid; for a native install the operator, e.g. rdf)
  --prefix DIR         program files (default /usr/local):
                       DIR/sbin/sdr-doa-host-power, DIR/share/sdr-doa-host-power/
  --helper-dry-run     the helper logs the action without running it
  --helper-live        the helper runs systemctl reboot or poweroff (the default)
  --docker-dir DIR     the sdr-doa-docker install whose compose.yml must mount
                       /run/sdr-doa-host-power (default /opt/sdr-doa-ground-console;
                       checked only when DIR/compose.yml exists)
  --root DIR           install below DIR (test staging): no systemctl
  --dry-run            show the files and commands, change nothing; exits 1
                       when the install would stop
  -h, --help           this help

Remove with:
  sudo sh PREFIX/share/sdr-doa-host-power/uninstall.sh [--purge]
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

# Values go into sed replacements and unit files.
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
      --console-user) need_value "$@"; CONSOLE_USER=$2; shift ;;
      --prefix) need_value "$@"; PREFIX=$2; shift ;;
      --helper-dry-run) HELPER_MODE=1 ;;
      --helper-live) HELPER_MODE=0 ;;
      --docker-dir) need_value "$@"; DOCKER_DIR=$2; shift ;;
      --root) need_value "$@"; ROOT=$2; shift ;;
      --dry-run) DRY_RUN=1 ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option $1 (see --help)" ;;
    esac
    shift
  done
  case $CONSOLE_USER in
    -* | '' | *[!A-Za-z0-9._-]*) die "--console-user is not a user name or uid: $CONSOLE_USER" ;;
  esac
  check_path --prefix "$PREFIX"
  [ "$PREFIX" != / ] || die "--prefix must not be /"
  check_path --docker-dir "$DOCKER_DIR"
  if [ -n "$ROOT" ]; then
    check_path --root "$ROOT"
  fi
}

locate_source() {
  HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
  for file in sdr-doa-host-power uninstall.sh README.md sdr-doa-host-power.service.in sdr-doa-host-power.path.in \
    sdr-doa-host-power.tmpfiles.in; do
    [ -f "$HERE/$file" ] || die "$HERE/$file is missing; run install.sh from packaging/host-power"
  done
  VERSION=unknown
  if [ -f "$HERE/../../VERSION" ]; then
    VERSION=$(head -n 1 "$HERE/../../VERSION")
  fi
}

# The console's uid and gid: a number is the Docker image's user and group
# (10001:10001); a name is a user of this host.
resolve_console_user() {
  case $CONSOLE_USER in
    *[!0-9]*)
      if ! CONSOLE_UID=$(id -u "$CONSOLE_USER" 2>/dev/null) || ! CONSOLE_GID=$(id -g "$CONSOLE_USER" 2>/dev/null); then
        die "user $CONSOLE_USER does not exist; give the console's user or uid with --console-user"
      fi
      ;;
    *)
      CONSOLE_UID=$CONSOLE_USER
      CONSOLE_GID=$CONSOLE_USER
      ;;
  esac
  case $CONSOLE_UID in '' | *[!0-9]*) die "cannot read the uid of $CONSOLE_USER" ;; esac
  if [ "$CONSOLE_UID" -eq 0 ] || [ "$CONSOLE_UID" -gt 4294967294 ]; then
    die "--console-user must not be root: the console never runs as root"
  fi
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
# replace or run as root.
check_targets() {
  for target in "$1$PREFIX/sbin/sdr-doa-host-power" "$1$UNIT_DIR/sdr-doa-host-power.service" \
    "$1$UNIT_DIR/sdr-doa-host-power.path" "$1$TMPFILES_DIR/$TMPFILES_NAME"; do
    check_ours "$target"
  done
  if [ -e "$1$SHARE_DIR" ] && [ ! -f "$1$SHARE_DIR/install-info" ] && [ -n "$(ls -A "$1$SHARE_DIR")" ]; then
    refuse "$SHARE_DIR is not empty and holds no sdr-doa-host-power install"
  fi
  # Root's service runs sbin/sdr-doa-host-power, and root runs uninstall.sh:
  # a user who can change one of these directories could run anything as root.
  for dir in "$1$PREFIX/sbin" "$1$SHARE_DIR"; do
    if ! root_only_chain "$dir"; then
      refuse "$UNSAFE is not owned by root or is writable by another user, so root must not run programs from $dir; choose another --prefix, or: sudo chown root:root $UNSAFE && sudo chmod go-w $UNSAFE"
    fi
  done
}

# render TEMPLATE TARGET: replace the @NAME@ placeholders.
render() {
  sed -e "s|@SBIN_DIR@|$PREFIX/sbin|g" -e "s|@SHARE_DIR@|$SHARE_DIR|g" -e "s|@REQUEST_DIR@|$REQUEST_DIR|g" \
    -e "s|@CONSOLE_UID@|$CONSOLE_UID|g" -e "s|@CONSOLE_GID@|$CONSOLE_GID|g" -e "s|@HANDLE@|$HANDLE|g" "$1" >"$2.new"
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

# The helper mode of an earlier install, kept when no --helper-* option is given.
previous_mode() {
  info=$1$SHARE_DIR/install-info
  if [ -f "$info" ]; then
    sed -n 's/^HELPER_DRY_RUN=\([01]\)$/\1/p' "$info" | tail -n 1
  fi
}

# check_docker_mount TREE: the console in Docker sees requests only through
# the bind mount that sdr-doa-docker 3.3.0 and later write into compose.yml,
# and sdr-doa-docker update never rewrites that file.
check_docker_mount() {
  compose=$1$DOCKER_DIR/compose.yml
  [ -f "$compose" ] || return 0
  if grep -q "^ *- $REQUEST_DIR:$REQUEST_DIR\$" "$compose" 2>/dev/null; then
    return 0
  fi
  script=$(CDPATH='' cd -- "$HERE/../docker" 2>/dev/null && pwd)/sdr-doa-docker
  if [ ! -f "$script" ]; then
    script="SCRIPT (the sdr-doa-docker of 3.3.0 or later)"
  fi
  warn "$DOCKER_DIR/compose.yml does not mount $REQUEST_DIR, so the console shows \"Request directory not mounted\": sdr-doa-docker update rewrites neither compose.yml nor the installed script. Install the script of this release first, then run its install once, while no recording runs: sudo install -m 0755 $script /usr/local/bin/sdr-doa-docker && sudo /usr/local/bin/sdr-doa-docker install --dir $DOCKER_DIR (it keeps .env, the channel, the sdr-doa-data volume and the update timer, and recreates the container)"
}

# Read-only checks of the running system; --root (test staging) skips them.
preflight() {
  if [ -n "$ROOT" ] && [ "$DRY_RUN" = 0 ]; then
    return 0
  fi
  if [ ! -d /run/systemd/system ]; then
    warn "systemd is not running: the path unit and the tmpfiles rule need it"
  fi
  if ! command -v systemd-tmpfiles >/dev/null 2>&1; then
    warn "systemd-tmpfiles was not found: the request directory is created at the next boot only"
  fi
}

install_files() {
  sbin=$ROOT$PREFIX/sbin
  share=$ROOT$SHARE_DIR
  units=$ROOT$UNIT_DIR
  tmpfiles=$ROOT$TMPFILES_DIR
  # A dry run checked the real paths before it switched to its scratch tree.
  if [ "$DRY_RUN" = 0 ]; then
    check_targets "$ROOT"
  fi

  mkdir -p "$sbin" "$share" "$units" "$tmpfiles"
  copy "$HERE/sdr-doa-host-power" "$sbin/sdr-doa-host-power" 0755
  copy "$HERE/uninstall.sh" "$share/uninstall.sh" 0755
  copy "$HERE/README.md" "$share/README.md" 0644
  render "$HERE/sdr-doa-host-power.service.in" "$units/sdr-doa-host-power.service"
  render "$HERE/sdr-doa-host-power.path.in" "$units/sdr-doa-host-power.path"
  render "$HERE/sdr-doa-host-power.tmpfiles.in" "$tmpfiles/$TMPFILES_NAME"

  cat >"$share/install-info" <<EOF
# sdr-doa-host-power install record (packaging/host-power), read by uninstall.sh and install.sh
PREFIX=$PREFIX
UNIT_DIR=$UNIT_DIR
TMPFILES_DIR=$TMPFILES_DIR
REQUEST_DIR=$REQUEST_DIR
TAKEN_DIR=$TAKEN_DIR
STATE_DIR=$STATE_DIR
CONSOLE_USER=$CONSOLE_USER
CONSOLE_UID=$CONSOLE_UID
CONSOLE_GID=$CONSOLE_GID
HELPER_DRY_RUN=$HELPER_DRY_RUN
VERSION=$VERSION
EOF
  chmod 0644 "$share/install-info"
}

enable_units() {
  if [ -z "$ROOT" ] && [ "$DRY_RUN" = 0 ] && [ ! -d /run/systemd/system ]; then
    warn "systemd is not running; units written but not enabled"
    return 0
  fi
  # Creates the request directory now, or gives a directory Docker created
  # for the bind mount (root-owned) to the console's user, with the marker.
  act systemd-tmpfiles --create "$TMPFILES_DIR/$TMPFILES_NAME"
  act systemctl daemon-reload
  act systemctl enable --now sdr-doa-host-power.path
}

show_dry_run() {
  for file in "$TMPFILES_DIR/$TMPFILES_NAME" "$UNIT_DIR/sdr-doa-host-power.path" "$UNIT_DIR/sdr-doa-host-power.service"; do
    say "--- $file"
    cat "$ROOT$file"
  done
  say "--- program files"
  say "$PREFIX/sbin/sdr-doa-host-power"
  say "$SHARE_DIR/{README.md,uninstall.sh,install-info}"
}

main() {
  WORK=$(mktemp -d)
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  parse_args "$@"
  SHARE_DIR=$PREFIX/share/sdr-doa-host-power
  locate_source
  if [ "$DRY_RUN" = 1 ]; then
    REAL_ROOT=$ROOT
    ROOT=$WORK/root
  elif [ -z "$ROOT" ] && [ "$(id -u)" != 0 ]; then
    die "run as root: sudo sh $0 $*"
  fi
  resolve_console_user
  # A dry run reads the mode of the install it checks, not of its scratch tree.
  if [ "$DRY_RUN" = 1 ]; then info_root=$REAL_ROOT; else info_root=$ROOT; fi
  HELPER_DRY_RUN=${HELPER_MODE:-$(previous_mode "$info_root")}
  HELPER_DRY_RUN=${HELPER_DRY_RUN:-0}
  if [ "$HELPER_DRY_RUN" = 1 ]; then
    HANDLE="--dry-run handle"
  else
    HANDLE=handle
  fi
  preflight

  if [ "$DRY_RUN" = 1 ]; then
    say "Dry run of the sdr-doa-host-power install into $PREFIX (console user $CONSOLE_USER, uid $CONSOLE_UID)"
    check_targets "$REAL_ROOT"
  else
    say "Installing sdr-doa-host-power into $ROOT$PREFIX (console user $CONSOLE_USER, uid $CONSOLE_UID)"
  fi
  install_files
  enable_units
  check_docker_mount "$info_root"
  if [ "$DRY_RUN" = 1 ]; then
    show_dry_run
    if [ "$DRY_STOP" = 1 ]; then
      say "Dry run: nothing was changed. The install would stop: see the warnings."
      return 1
    fi
    say "Dry run: nothing was changed."
    return 0
  fi
  if [ "$HELPER_DRY_RUN" = 1 ]; then
    mode="dry run: it logs the action and runs none (switch: sudo sh install.sh --helper-live)"
  else
    mode="live: it runs systemctl reboot or poweroff"
  fi
  say "Helper: $mode"
  say "Requests: $REQUEST_DIR/request, written by the console (uid $CONSOLE_UID)"
  say "Console: reload the console page; Restart and Shutdown are in its top bar"
  say "Status:  sudo sdr-doa-host-power status    Journal: journalctl -t sdr-doa-host-power"
  say "Remove:  sudo sh $SHARE_DIR/uninstall.sh [--purge]"
}

main "$@"
