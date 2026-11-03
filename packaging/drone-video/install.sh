#!/bin/sh
# Installs drone-video-supervisor (packaging/drone-video) on the groundstation,
# outside Docker: the program, its settings /etc/drone-video/drone-video.conf and
# drone-video.service, which runs mediamtx and ffmpeg to serve the drone camera
# (HEVC over RTSP/TCP) as H.264 over WebRTC for the SDR-DoA Ground Console.
#
#   sudo sh install.sh              # install or upgrade, enable and (re)start
#   sudo sh install.sh --dry-run    # show what it would do
#
# The service runs as a user of its own (DynamicUser) in the render and video
# groups. mediamtx listens on TCP 8889 and UDP 8189 (WebRTC) and on loopback
# 8654 (RTSP) and 9997 (API). The installer downloads nothing: mediamtx and
# ffmpeg come from their own packages (see README.md); it only warns when they
# are missing. It touches no other service, udev rule or firewall. Re-running
# it upgrades in place and keeps drone-video.conf. Run it from
# packaging/drone-video in the repository or in the console release.
set -eu
# The files must be readable whatever umask sudo keeps.
umask 022

MARKER=packaging/drone-video
PREFIX=/usr/local
UNIT_DIR=/etc/systemd/system
CONFIG_DIR=/etc/drone-video
ROOT=
REAL_ROOT=
DRY_RUN=0
DRY_STOP=0
# Tests only: the uid whose files count as root's.
ROOT_UID=${DRONE_VIDEO_ROOT_UID:-0}
WORK=

usage() {
  cat <<'EOF'
Usage: sudo sh install.sh [options]

  --prefix DIR         program files (default /usr/local):
                       DIR/bin/drone-video-supervisor, DIR/share/drone-video/
  --root DIR           install below DIR (test staging): no systemctl
  --dry-run            show the files and commands, change nothing; exits 1
                       when the install would stop
  -h, --help           this help

Settings: /etc/drone-video/drone-video.conf, written from drone-video.conf.example
on the first install and kept afterwards (CAMERA_URL, CONSOLE_URL, ENCODER,
BITRATE, WEBRTC_ADDITIONAL_HOSTS, MEDIAMTX_BIN, FFMPEG_BIN, RUNTIME_DIR).

Needs mediamtx (https://github.com/bluenviron/mediamtx/releases) and ffmpeg
(sudo apt install ffmpeg) on the PATH of the service, or their paths in the
settings.

Remove with:
  sudo sh PREFIX/share/drone-video/uninstall.sh [--purge]
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
  for file in drone-video-supervisor uninstall.sh README.md drone-video.service.in drone-video.conf.example; do
    [ -f "$HERE/$file" ] || die "$HERE/$file is missing; run install.sh from packaging/drone-video"
  done
  VERSION=unknown
  if [ -f "$HERE/../../VERSION" ]; then
    VERSION=$(head -n 1 "$HERE/../../VERSION")
  fi
}

# The python3 the service runs the supervisor with: an absolute path.
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
  for target in "$1$PREFIX/bin/drone-video-supervisor" "$1$UNIT_DIR/drone-video.service"; do
    check_ours "$target"
  done
  if [ -e "$1$SHARE_DIR" ] && [ ! -f "$1$SHARE_DIR/install-info" ] && [ -n "$(ls -A "$1$SHARE_DIR")" ]; then
    refuse "$SHARE_DIR is not empty and holds no drone-video install"
  fi
  # systemd runs bin/drone-video-supervisor and root runs uninstall.sh: a user
  # who can change one of these directories could run code there.
  for dir in "$1$PREFIX/bin" "$1$SHARE_DIR"; do
    if ! root_only_chain "$dir"; then
      refuse "$UNSAFE is not owned by root or is writable by another user, so the service must not run programs from $dir; choose another --prefix, or: sudo chown root:root $UNSAFE && sudo chmod go-w $UNSAFE"
    fi
  done
}

# render TEMPLATE TARGET: replace the @NAME@ placeholders.
render() {
  sed -e "s|@BIN_DIR@|$PREFIX/bin|g" -e "s|@SHARE_DIR@|$SHARE_DIR|g" -e "s|@CONFIG@|$CONFIG_DIR/drone-video.conf|g" \
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

# The settings that will be in effect, checked by the supervisor itself.
read_config() {
  values=$("$PYTHON" -I "$HERE/drone-video-supervisor" check-config --config "$1" 2>&1) ||
    refuse "$CONFIG_DIR/drone-video.conf: $(printf '%s' "$values" | tail -n 1)"
  CAMERA=$(printf '%s\n' "$values" | sed -n 's/^CAMERA_URL=//p')
  ENCODER=$(printf '%s\n' "$values" | sed -n 's/^ENCODER=//p')
  MEDIAMTX_BIN=$(printf '%s\n' "$values" | sed -n 's/^MEDIAMTX_BIN=//p')
  FFMPEG_BIN=$(printf '%s\n' "$values" | sed -n 's/^FFMPEG_BIN=//p')
}

# Read-only checks of the running system; --root (test staging) skips them.
preflight() {
  if [ -n "$ROOT" ] && [ "$DRY_RUN" = 0 ]; then
    return 0
  fi
  if [ ! -d /run/systemd/system ]; then
    warn "systemd is not running: drone-video.service needs it"
  fi
  for group in render video; do
    if ! grep -q "^$group:" /etc/group 2>/dev/null; then
      warn "the group $group does not exist here; systemd will not start the service with SupplementaryGroups=render video until it does, or until a drop-in sets the groups that exist (systemctl edit drone-video: SupplementaryGroups=)"
    fi
  done
}

# check_program NAME VALUE HINT: warn when the program of the settings is missing.
check_program() {
  case $2 in
    /*) [ -x "$2" ] && return 0 ;;
    *) command -v "$2" >/dev/null 2>&1 && return 0 ;;
  esac
  warn "$1 $2 was not found; the service cannot serve video until it is installed: $3"
}

# check_programs: mediamtx and ffmpeg of the config in effect, on this PATH.
check_programs() {
  [ -n "${MEDIAMTX_BIN:-}" ] || return 0
  check_program MEDIAMTX_BIN "$MEDIAMTX_BIN" "the linux_amd64 (or arm64) tarball of https://github.com/bluenviron/mediamtx/releases, its mediamtx in /usr/local/bin"
  check_program FFMPEG_BIN "$FFMPEG_BIN" "sudo apt install ffmpeg"
}

install_files() {
  bin=$ROOT$PREFIX/bin
  share=$ROOT$SHARE_DIR
  config=$ROOT$CONFIG_DIR/drone-video.conf
  units=$ROOT$UNIT_DIR
  # A dry run checked the real paths before it switched to its scratch tree.
  if [ "$DRY_RUN" = 0 ]; then
    check_targets "$ROOT"
  fi

  mkdir -p "$bin" "$share" "$units" "$ROOT$CONFIG_DIR"
  copy "$HERE/drone-video-supervisor" "$bin/drone-video-supervisor" 0755
  copy "$HERE/uninstall.sh" "$share/uninstall.sh" 0755
  copy "$HERE/README.md" "$share/README.md" 0644
  copy "$HERE/drone-video.conf.example" "$share/drone-video.conf.example" 0644

  if [ -f "$config" ]; then
    say "Keeping $CONFIG_DIR/drone-video.conf"
  else
    copy "$HERE/drone-video.conf.example" "$config" 0644
    say "Wrote $CONFIG_DIR/drone-video.conf"
  fi
  # A config the supervisor cannot use stops the install here.
  read_config "$config"

  render "$HERE/drone-video.service.in" "$units/drone-video.service"

  cat >"$share/install-info" <<EOF
# drone-video install record (packaging/drone-video), read by uninstall.sh
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
  act systemctl enable drone-video.service
  # A re-run is an upgrade: the running supervisor takes the new program.
  act systemctl restart drone-video.service
}

show_dry_run() {
  for file in "$UNIT_DIR/drone-video.service" "$CONFIG_DIR/drone-video.conf"; do
    say "--- $file"
    cat "$ROOT$file"
  done
  say "--- program files"
  say "$PREFIX/bin/drone-video-supervisor"
  say "$SHARE_DIR/{README.md,uninstall.sh,drone-video.conf.example,install-info}"
}

main() {
  WORK=$(mktemp -d)
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  parse_args "$@"
  SHARE_DIR=$PREFIX/share/drone-video
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
    say "Dry run of the drone-video install into $PREFIX"
    check_targets "$REAL_ROOT"
    # The config of the tree it checks, when there is one.
    if [ -f "$REAL_ROOT$CONFIG_DIR/drone-video.conf" ]; then
      mkdir -p "$ROOT$CONFIG_DIR"
      cp "$REAL_ROOT$CONFIG_DIR/drone-video.conf" "$ROOT$CONFIG_DIR/drone-video.conf"
    fi
  else
    say "Installing drone-video into $ROOT$PREFIX"
  fi
  install_files
  check_programs
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
  say "Camera:  $CAMERA    Encoder: $ENCODER"
  say "WebRTC:  TCP 8889 and UDP 8189 (open them in the host firewall for LAN tablets)"
  say "Status:  systemctl status drone-video    Journal: journalctl -u drone-video"
  say "Check:   curl -s http://127.0.0.1:9997/v3/paths/list"
  say "Remove:  sudo sh $SHARE_DIR/uninstall.sh [--purge]"
}

main "$@"
