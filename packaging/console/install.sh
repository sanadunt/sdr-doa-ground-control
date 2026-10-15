#!/bin/sh
# Installs the SDR-DoA Ground Console for the current Linux user:
#   - the program and a Python venv (paho-mqtt) in ~/.local/share/sdr-doa-ground-console/app
#   - saved data in ~/.local/share/sdr-doa-ground-console (console.json,
#     branding.json, preferences.json, receiver/, .env with the admin password)
#   - a systemd user service that starts at boot (with lingering) and restarts
#     on failure, the sdr-doa-console command and a menu entry
#
#   sh install.sh            # asks for the admin password
#   sh install.sh --yes      # no questions
#
# Re-running it upgrades the program and keeps the saved data. Run it from the
# unpacked release, or from a repository checkout after npm run build:all.
set -eu

DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
DATA_DIR=$DATA_HOME/sdr-doa-ground-console
APP_DIR=
BIN_DIR=$HOME/.local/bin
PORT=8787
PASSWORD_MODE=ask
PASSWORD_VALUE=
YES=0
SERVICE_ON=1
DESKTOP_ON=1
WORK=
UNIT=sdr-doa-ground-console.service
MARKER=.sdr-doa-console-install

usage() {
  cat <<'EOF'
Usage: sh install.sh [options]

  --prefix DIR           program directory (default ~/.local/share/sdr-doa-ground-console/app)
  --data-dir DIR         saved settings and records (default ~/.local/share/sdr-doa-ground-console)
  --bin-dir DIR          where sdr-doa-console goes (default ~/.local/bin)
  --port PORT            console port on 127.0.0.1 (default 8787)
  --password VALUE       admin password (otherwise asked; Enter keeps the default 123456)
  --generate-password    set a random admin password and print it once
  --yes, -y              no questions: keep the saved password, else the default 123456
  --no-service           no systemd user service; start with: sdr-doa-console start
  --no-desktop           no menu entry

First start only (the console writes console.json from these when it does
not exist yet; change them later in Konfigurasi):
  --base-url URL         Data Out, e.g. http://192.168.100.100:8081
  --mqtt-host HOST       MQTT broker IPv4/IPv6 address or localhost
  --mqtt-port PORT
  --mqtt-transport T     websockets or tcp
  --mqtt-ws-path PATH    WebSocket path, e.g. /mqtt
  --refresh-seconds N    0 (manual), 1, 2, 5, 10 or 30
EOF
}

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf "$WORK"; fi
}

# Paths go unquoted into the systemd unit and through sed.
check_path() {
  case $2 in
    /*) ;;
    *) die "$1 must be an absolute path: $2" ;;
  esac
  case $2 in
    *[[:space:]]* | *[\'\"\\\`\$%\|\&]*) die "$1 must not contain spaces or any of ' \" \\ \` \$ % | &: $2" ;;
  esac
}

# First-start values, written to seed.env as SDR_DOA_SEED_* variables.
seed() {
  case $2 in
    '' | *[[:space:]]* | *[\'\"\\\`\$]*) die "$3 needs a value without spaces or quotes" ;;
  esac
  printf 'SDR_DOA_SEED_%s=%s\n' "$1" "$2" >>"$WORK/seeds"
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
      --prefix | --data-dir | --bin-dir | --port | --password | --base-url | --mqtt-host | --mqtt-port | \
        --mqtt-transport | --mqtt-ws-path | --refresh-seconds)
        [ $# -ge 2 ] || die "$1 needs a value"
        ;;
    esac
    case $1 in
      --prefix) APP_DIR=$2; shift ;;
      --data-dir) DATA_DIR=$2; shift ;;
      --bin-dir) BIN_DIR=$2; shift ;;
      --port) PORT=$2; shift ;;
      --password) PASSWORD_MODE=value; PASSWORD_VALUE=$2; shift ;;
      --generate-password) PASSWORD_MODE=generate ;;
      --yes | -y) YES=1 ;;
      --no-service) SERVICE_ON=0 ;;
      --no-desktop) DESKTOP_ON=0 ;;
      --base-url) seed BASE_URL "$2" "$1"; shift ;;
      --mqtt-host) seed MQTT_HOST "$2" "$1"; shift ;;
      --mqtt-port) seed MQTT_PORT "$2" "$1"; shift ;;
      --mqtt-transport) seed MQTT_TRANSPORT "$2" "$1"; shift ;;
      --mqtt-ws-path) seed MQTT_WS_PATH "$2" "$1"; shift ;;
      --refresh-seconds) seed REFRESH_SECONDS "$2" "$1"; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option $1 (see --help)" ;;
    esac
    shift
  done
  APP_DIR=${APP_DIR:-$DATA_DIR/app}
  check_path --prefix "$APP_DIR"
  check_path --data-dir "$DATA_DIR"
  check_path --bin-dir "$BIN_DIR"
  case $PORT in '' | *[!0-9]*) die "--port must be a number" ;; esac
  if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then die "--port must be between 1 and 65535"; fi
  case $APP_DIR in "$HOME" | "$DATA_DIR" | /) die "--prefix must be a directory of its own" ;; esac
}

check_python() {
  command -v python3 >/dev/null 2>&1 || die "python3 is required (Debian/Ubuntu: sudo apt install python3 python3-venv)"
  python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' ||
    die "Python 3.9 or newer is required, found $(python3 -V 2>&1)"
  python3 -c 'import venv, ensurepip' 2>/dev/null ||
    die "the Python venv module is missing (Debian/Ubuntu: sudo apt install python3-venv)"
}

# Sets SRC (the console tree to install) and ASSETS (installer templates).
locate_source() {
  here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
  if [ -f "$here/MANIFEST.sha256" ] && [ -f "$here/tools/ground_console.py" ]; then
    SRC=$here
    ASSETS=$here/packaging/console
    README=$here/README.md
    WHEELS=$here/wheels
    if command -v sha256sum >/dev/null 2>&1; then
      say "Checking the release files"
      (cd "$SRC" && sha256sum --check --quiet MANIFEST.sha256) ||
        die "the release files do not match MANIFEST.sha256; unpack the tarball again"
    fi
  elif [ -f "$here/../../tools/make_release.py" ]; then
    repo=$(CDPATH='' cd -- "$here/../.." && pwd)
    SRC=$WORK/stage
    ASSETS=$repo/packaging/console
    README=$repo/packaging/console/README.md
    WHEELS=
    python3 "$repo/tools/make_release.py" --stage-console "$SRC" >/dev/null ||
      die "frontend/dist is not complete; run: cd frontend && npm ci && npm run build:all"
  else
    die "run install.sh from the unpacked release, or packaging/console/install.sh from the repository"
  fi
  VERSION=$(cat "$SRC/VERSION")
}

render() {
  # $1 template, $2 target, $3 mode; placeholders hold paths checked by check_path.
  sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@DATA_DIR@|$DATA_DIR|g" -e "s|@PORT@|$PORT|g" \
    -e "s|@BIN_PATH@|$BIN_DIR/sdr-doa-console|g" -e "s|@UNIT_FILE@|$UNIT_FILE|g" \
    -e "s|@DESKTOP_FILE@|$DESKTOP_FILE|g" "$1" >"$2.tmp"
  if grep -q '@[A-Z_]*@' "$2.tmp"; then
    rm -f "$2.tmp"
    die "unreplaced placeholder in $1"
  fi
  chmod "$3" "$2.tmp"
  mv "$2.tmp" "$2"
}

have_user_systemd() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

port_busy() {
  python3 - "$PORT" <<'EOF'
import socket
import sys

with socket.socket() as probe:
    probe.settimeout(1)
    sys.exit(0 if probe.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
EOF
}

stop_previous() {
  if [ -f "$UNIT_FILE" ] && have_user_systemd; then
    systemctl --user stop "$UNIT" 2>/dev/null || true
  elif [ -x "$BIN_DIR/sdr-doa-console" ]; then
    "$BIN_DIR/sdr-doa-console" stop >/dev/null 2>&1 || true
  fi
}

install_app() {
  if [ -d "$APP_DIR" ] && [ ! -f "$APP_DIR/$MARKER" ] && [ -n "$(ls -A "$APP_DIR")" ]; then
    die "$APP_DIR is not empty and holds no console install; choose another --prefix"
  fi
  mkdir -p "$APP_DIR"
  rm -rf "$APP_DIR/tools" "$APP_DIR/frontend" "$APP_DIR/packaging"
  cp -R "$SRC/tools" "$SRC/frontend" "$SRC/packaging" "$APP_DIR/"
  cp "$SRC/VERSION" "$APP_DIR/VERSION"
  cp "$README" "$APP_DIR/README.md"
  cp "$ASSETS/sdr-doa-ground-console.svg" "$APP_DIR/packaging/console/"
  printf '%s\n' "$VERSION" >"$APP_DIR/$MARKER"

  venv=$APP_DIR/venv
  if [ -x "$venv/bin/python" ] && "$venv/bin/python" -c '' 2>/dev/null &&
    [ "$("$venv/bin/python" -c 'import sys; print(sys.version_info[:2])')" = "$(python3 -c 'import sys; print(sys.version_info[:2])')" ]; then
    :
  else
    rm -rf "$venv"
    say "Creating the Python environment"
    python3 -m venv "$venv" || die "python3 -m venv failed (Debian/Ubuntu: sudo apt install python3-venv)"
  fi
  say "Installing paho-mqtt and tzdata"
  if [ -n "$WHEELS" ] && [ -n "$(ls "$WHEELS" 2>/dev/null)" ]; then
    set -- --find-links "$WHEELS"
  else
    set --
  fi
  "$venv/bin/python" -m pip install --quiet --disable-pip-version-check --no-input "$@" \
    -r "$APP_DIR/packaging/console/requirements.txt" ||
    die "pip could not install packaging/console/requirements.txt (network or proxy?)"
}

# Settings saved by a console run from the repository with default paths.
migrate_old_data() {
  if [ ! -f "$DATA_DIR/console.json" ] && [ ! -s "$WORK/seeds" ] && [ -f "$CONFIG_HOME/sdr-doa-ground-console/console.json" ]; then
    cp "$CONFIG_HOME/sdr-doa-ground-console/console.json" "$DATA_DIR/console.json"
    say "Copied the saved connection settings from $CONFIG_HOME/sdr-doa-ground-console"
  fi
  if [ ! -f "$DATA_DIR/branding.json" ] && [ -f "$CONFIG_HOME/sdr-doa-ground-console/branding.json" ]; then
    cp "$CONFIG_HOME/sdr-doa-ground-console/branding.json" "$DATA_DIR/branding.json"
    say "Copied the saved branding from $CONFIG_HOME/sdr-doa-ground-console"
  fi
  if [ -f "$DATA_DIR/receiver.sqlite3" ] && [ ! -e "$DATA_DIR/receiver/receiver.sqlite3" ]; then
    if port_busy; then
      warn "Receiver records in $DATA_DIR stay where they are: a console still runs on port $PORT. Stop it and run install.sh again to move them into $DATA_DIR/receiver"
      return
    fi
    mkdir -p "$DATA_DIR/receiver"
    for name in receiver.sqlite3 receiver.sqlite3-wal receiver.sqlite3-shm audio tmp; do
      if [ -e "$DATA_DIR/$name" ]; then
        # An empty directory left by an earlier start would swallow the move.
        rmdir "$DATA_DIR/receiver/$name" 2>/dev/null || true
        [ ! -e "$DATA_DIR/receiver/$name" ] || die "both $DATA_DIR/$name and $DATA_DIR/receiver/$name exist; merge them by hand"
        mv "$DATA_DIR/$name" "$DATA_DIR/receiver/$name"
      fi
    done
    say "Moved the Receiver records into $DATA_DIR/receiver"
  fi
}

setup_data() {
  mkdir -p "$DATA_DIR/receiver"
  chmod 0700 "$DATA_DIR"
  migrate_old_data
  if [ -s "$WORK/seeds" ]; then
    if [ -f "$DATA_DIR/console.json" ]; then
      warn "$DATA_DIR/console.json exists, so --base-url/--mqtt-*/--refresh-seconds are ignored; change them in Konfigurasi"
      rm -f "$DATA_DIR/seed.env"
    else
      (umask 077 && cp "$WORK/seeds" "$DATA_DIR/seed.env")
    fi
  fi

  state=$(password_tool --status)
  case $PASSWORD_MODE in
    value) printf '%s\n' "$PASSWORD_VALUE" | password_tool --stdin --quiet || die "the admin password was not saved" ;;
    generate) password_tool --generate --quiet || die "the admin password was not saved" ;;
    ask)
      if [ "$state" = set ] || [ "$state" = disabled ]; then
        say "Keeping the admin password in $DATA_DIR/.env (change it with: sdr-doa-console password)"
      elif [ "$YES" = 0 ] && [ -t 0 ]; then
        password_tool --prompt --quiet || die "the admin password was not saved"
      elif [ ! -f "$DATA_DIR/.env" ]; then
        password_tool --default --quiet
      fi
      ;;
  esac
  case $(password_tool --status) in
    default) warn "the admin password is the default 123456; set your own with: sdr-doa-console password" ;;
    disabled) warn "SDR_DOA_ADMIN_PASSWORD is empty in $DATA_DIR/.env, so admin login is disabled" ;;
  esac
}

password_tool() {
  "$APP_DIR/venv/bin/python" "$APP_DIR/packaging/console/set_admin_password.py" --env-file "$DATA_DIR/.env" "$@"
}

install_launcher() {
  mkdir -p "$BIN_DIR"
  render "$ASSETS/sdr-doa-console" "$BIN_DIR/sdr-doa-console" 0755
  if [ "$DESKTOP_ON" = 1 ]; then
    mkdir -p "$(dirname "$DESKTOP_FILE")"
    render "$ASSETS/sdr-doa-ground-console.desktop.in" "$DESKTOP_FILE" 0644
    if command -v update-desktop-database >/dev/null 2>&1; then
      update-desktop-database "$(dirname "$DESKTOP_FILE")" >/dev/null 2>&1 || true
    fi
  else
    rm -f "$DESKTOP_FILE"
  fi
}

# Returns 0 with the service enabled, 1 for --no-service, 2 without systemd.
install_service() {
  if [ "$SERVICE_ON" = 0 ]; then
    if [ -f "$UNIT_FILE" ]; then
      if have_user_systemd; then systemctl --user disable "$UNIT" >/dev/null 2>&1 || true; fi
      rm -f "$UNIT_FILE"
      if have_user_systemd; then systemctl --user daemon-reload || true; fi
    fi
    return 1
  fi
  if ! have_user_systemd; then
    warn "no systemd user session here, so the console will not start at boot"
    return 2
  fi
  mkdir -p "$(dirname "$UNIT_FILE")"
  render "$ASSETS/sdr-doa-ground-console.service.in" "$UNIT_FILE" 0644
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null 2>&1 || die "systemctl --user enable $UNIT failed"
  user=$(id -un)
  if command -v loginctl >/dev/null 2>&1; then
    if [ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null || true)" != yes ]; then
      loginctl enable-linger "$user" 2>/dev/null ||
        warn "could not enable lingering; to start the console at boot without a login run: sudo loginctl enable-linger $user"
    fi
  fi
  return 0
}

main() {
  WORK=$(mktemp -d)
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  : >"$WORK/seeds"
  parse_args "$@"
  [ "$(id -u)" != 0 ] || die "run install.sh as the desktop user, not root; the console runs as a user service"
  UNIT_FILE=$CONFIG_HOME/systemd/user/$UNIT
  DESKTOP_FILE=$DATA_HOME/applications/sdr-doa-ground-console.desktop
  check_python
  locate_source
  say "Installing the SDR-DoA Ground Console $VERSION into $APP_DIR"
  stop_previous
  install_app
  setup_data
  install_launcher
  service=0
  install_service || service=$?
  if [ "$service" = 1 ]; then
    say "Start it with: sdr-doa-console start   (or in the foreground: sdr-doa-console run)"
  elif port_busy; then
    warn "port $PORT is already in use (another console?); stop it, then run: sdr-doa-console start"
  else
    if [ "$service" = 0 ]; then systemctl --user restart "$UNIT"; fi
    if "$BIN_DIR/sdr-doa-console" start >/dev/null 2>&1; then
      if [ "$service" = 0 ]; then
        say "The console runs in the background and starts at boot: http://127.0.0.1:$PORT/"
      else
        say "The console runs in the background until the next reboot: http://127.0.0.1:$PORT/"
      fi
    else
      warn "the console did not answer yet; see: sdr-doa-console status"
    fi
  fi
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR is not on PATH; log in again or use $BIN_DIR/sdr-doa-console" ;;
  esac
  say "Open it: sdr-doa-console open (Chromium or Chrome; the Receiver needs WebUSB)"
  say "Saved data: $DATA_DIR    Help: sdr-doa-console help"
}

main "$@"
