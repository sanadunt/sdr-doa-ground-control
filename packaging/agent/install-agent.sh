#!/bin/sh
# Installs the SDR-DoA edge agent on the RDF-SDR (Raspberry) as a systemd
# service that starts at boot and restarts on failure.
#
#   sudo sh install.sh                    # defaults, see --help
#   sudo sh install.sh --enable-config    # let Kontrol change settings.json
#
# Re-running it upgrades in place. agent.env and the state directory are kept;
# only the settings given as flags change. Run it from the unpacked agent
# release, or from a repository checkout (packaging/agent/install-agent.sh).
set -eu

PREFIX=/opt/sdr-doa-agent
CONFIG_DIR=/etc/sdr-doa-agent
STATE_DIR=
SERVICE=sdr-doa-agent
UNIT_DIR=/etc/systemd/system
DEFAULT_SETTINGS=/home/doasdr/doasdr/_share/settings.json
DEFAULT_STATE_DIR=/var/lib/sdr-doa-agent
ROOT=
DRY_RUN=0
SERVICE_ON=1
START_ON=1
AGENT_USER=
WORK=

usage() {
  cat <<'EOF'
Usage: sudo sh install.sh [options]

Agent settings (written to agent.env; on an upgrade only the ones given change):
  --base-url URL        KrakenSDR Data Out (default http://127.0.0.1:8081)
  --mqtt-host HOST      MQTT broker (default 127.0.0.1)
  --mqtt-port PORT      MQTT port (default 1883; MQTT over TCP, not WebSocket)
  --mqtt-tls            TLS verified against the system CA store
  --mqtt-cafile FILE    TLS verified against this CA file
  --mqtt-username NAME  broker user; the password is taken from the
                        SDR_DOA_MQTT_PASSWORD environment variable of this run
  --enable-config       apply Kontrol config patches to the settings file
  --disable-config      answer patches with REMOTE_CONTROL_DISABLED (default)
  --no-publish          do not connect to MQTT at all
  --settings-path PATH  KrakenSDR settings.json
                        (default /home/doasdr/doasdr/_share/settings.json)

Install:
  --user NAME           service user (default: owner of the settings file,
                        else doasdr, else a new system user sdr-doa-agent);
                        with --enable-config it must be able to write that file
  --prefix DIR          program files (default /opt/sdr-doa-agent)
  --config-dir DIR      agent.env location (default /etc/sdr-doa-agent)
  --state-dir DIR       agent state (default /var/lib/sdr-doa-agent)
  --no-service          do not install or enable the systemd service
  --no-start            enable the service for the next boot, do not start it now
  --root DIR            install below DIR (image or test staging): no user,
                        ownership or systemctl changes
  --dry-run             show the files and commands, change nothing
  -h, --help            this help
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

# A system command that changes users, ownership or services.
act() {
  if [ "$DRY_RUN" = 1 ]; then
    say "would run: $*"
  elif [ -n "$ROOT" ]; then
    say "skipped (--root): $*"
  else
    "$@"
  fi
}

# Values end up unquoted in agent.env and the unit file.
check_value() {
  case $2 in
    *[[:space:]]* | *[\'\"\\\`\$]*) die "$1 must not contain spaces, quotes, backslashes, \$ or backticks" ;;
  esac
}

update() {
  check_value "$1" "$2"
  printf '%s=%s\n' "$1" "$2" >>"$WORK/updates"
}

need_value() {
  [ $# -ge 2 ] || die "$1 needs a value"
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
      --base-url) need_value "$@"; update BASE_URL "$2"; shift ;;
      --mqtt-host) need_value "$@"; update MQTT_HOST "$2"; shift ;;
      --mqtt-port)
        need_value "$@"
        case $2 in '' | *[!0-9]*) die "--mqtt-port must be a number" ;; esac
        update MQTT_PORT "$2"
        shift
        ;;
      --mqtt-tls) update MQTT_TLS 1 ;;
      --mqtt-cafile) need_value "$@"; update MQTT_CAFILE "$2"; shift ;;
      --mqtt-username) need_value "$@"; update MQTT_USERNAME "$2"; shift ;;
      --enable-config) update ENABLE_CONFIG 1; update PUBLISH 1 ;;
      --disable-config) update ENABLE_CONFIG 0 ;;
      --no-publish) update PUBLISH 0; update ENABLE_CONFIG 0 ;;
      --settings-path) need_value "$@"; update SETTINGS_PATH "$2"; shift ;;
      --user) need_value "$@"; AGENT_USER=$2; shift ;;
      --prefix) need_value "$@"; PREFIX=$2; shift ;;
      --config-dir) need_value "$@"; CONFIG_DIR=$2; shift ;;
      --state-dir) need_value "$@"; STATE_DIR=$2; shift ;;
      --no-service) SERVICE_ON=0 ;;
      --no-start) START_ON=0 ;;
      --root) need_value "$@"; ROOT=$2; shift ;;
      --dry-run) DRY_RUN=1 ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option $1 (see --help)" ;;
    esac
    shift
  done
  if [ -n "${SDR_DOA_MQTT_PASSWORD:-}" ]; then
    update SDR_DOA_MQTT_PASSWORD "$SDR_DOA_MQTT_PASSWORD"
  fi
  for path in "$PREFIX" "$CONFIG_DIR" "${STATE_DIR:-/x}" "${ROOT:-/x}"; do
    check_value path "$path"
    case $path in
      /*) ;;
      *) die "paths must be absolute: $path" ;;
    esac
  done
  [ "$PREFIX" != / ] || die "--prefix must not be /"
}

write_helper() {
  cat >"$WORK/helper.py" <<'EOF'
import os
import re
import sys
import tempfile


def env_lines(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read().splitlines()
    except FileNotFoundError:
        return None


def key_of(line):
    text = line.strip()
    if not text or text.startswith("#") or "=" not in text:
        return None
    return text.split("=", 1)[0].strip()


def get(path, key):
    value = ""
    for line in env_lines(path) or []:
        if key_of(line) == key:
            value = line.split("=", 1)[1].strip()
    print(value)


def merge(target, template, updates):
    lines = env_lines(target)
    if lines is None:
        lines = env_lines(template) or []
    pending = {}
    for line in env_lines(updates) or []:
        key, _, value = line.partition("=")
        pending[key] = value
    out = []
    for line in lines:
        key = key_of(line)
        if key in pending:
            out.append(f"{key}={pending.pop(key)}")
        else:
            out.append(line)
    out.extend(f"{key}={value}" for key, value in pending.items())
    write(target, "\n".join(out) + "\n", 0o640)


def render(template, target, *pairs):
    with open(template, encoding="utf-8") as handle:
        text = handle.read()
    for pair in pairs:
        name, _, value = pair.partition("=")
        text = text.replace(f"@{name}@", value)
    leftovers = sorted(set(re.findall(r"@[A-Z_]+@", text)))
    if leftovers:
        sys.exit(f"unreplaced placeholders in {template}: {', '.join(leftovers)}")
    write(target, text, 0o644)


def write(target, text, mode):
    directory = os.path.dirname(target) or "."
    os.makedirs(directory, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".install.", dir=directory)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(temporary, target)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


command, *arguments = sys.argv[1:]
{"get": get, "merge": merge, "render": render}[command](*arguments)
EOF
}

check_python() {
  command -v python3 >/dev/null 2>&1 || die "python3 is required (sudo apt install python3)"
  python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' ||
    die "Python 3.9 or newer is required, found $(python3 -V 2>&1)"
}

# Sets SRC (files to install) and ASSETS (packaging/agent templates).
locate_source() {
  here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
  if [ -f "$here/MANIFEST.sha256" ] && [ -f "$here/tools/sdr_doa_lan_agent.py" ]; then
    SRC=$here
    ASSETS=$here/packaging/agent
    if command -v sha256sum >/dev/null 2>&1; then
      (cd "$SRC" && sha256sum --check --quiet MANIFEST.sha256) ||
        die "the release files do not match MANIFEST.sha256; unpack the tarball again"
    fi
  elif [ -f "$here/../../tools/make_release.py" ]; then
    repo=$(CDPATH='' cd -- "$here/../.." && pwd)
    SRC=$WORK/stage
    ASSETS=$repo/packaging/agent
    python3 "$repo/tools/make_release.py" --stage-agent "$SRC" >/dev/null
    cp "$ASSETS/README.md" "$SRC/README.md"
  else
    die "run this script from the unpacked agent release or from packaging/agent in the repository"
  fi
  VERSION=$(cat "$SRC/VERSION")
}

choose_user() {
  if [ -n "$AGENT_USER" ]; then
    return
  fi
  if [ -e "$SETTINGS_PATH" ]; then
    owner=$(stat -c %U "$SETTINGS_PATH" 2>/dev/null || true)
    if [ -n "$owner" ] && [ "$owner" != root ] && [ "$owner" != UNKNOWN ]; then
      AGENT_USER=$owner
      return
    fi
  fi
  if id doasdr >/dev/null 2>&1; then
    AGENT_USER=doasdr
  else
    AGENT_USER=sdr-doa-agent
  fi
}

ensure_user() {
  if id "$AGENT_USER" >/dev/null 2>&1; then
    AGENT_GROUP=$(id -gn "$AGENT_USER")
    CREATED_USER=0
    return
  fi
  [ "$AGENT_USER" = sdr-doa-agent ] || [ -n "$ROOT" ] || [ "$DRY_RUN" = 1 ] ||
    die "user $AGENT_USER does not exist; create it or pick another with --user"
  AGENT_GROUP=$AGENT_USER
  CREATED_USER=1
  act useradd --system --user-group --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin "$AGENT_USER"
}

install_files() {
  dest=$ROOT$PREFIX
  if [ -d "$dest" ] && [ ! -f "$dest/install-info" ] && [ -n "$(ls -A "$dest")" ]; then
    die "$PREFIX is not empty and holds no agent install; choose a dedicated --prefix"
  fi
  mkdir -p "$dest/bin"
  rm -rf "$dest/tools.new"
  mkdir "$dest/tools.new"
  cp "$SRC"/tools/*.py "$dest/tools.new/"
  rm -rf "$dest/tools"
  mv "$dest/tools.new" "$dest/tools"
  cp "$SRC/VERSION" "$dest/VERSION"
  cp "$SRC/README.md" "$dest/README.md"
  cp "$SRC/packaging/agent/run-agent.sh" "$dest/bin/run-agent"
  cp "$ASSETS/uninstall-agent.sh" "$dest/uninstall.sh"
  chmod 0755 "$dest" "$dest/bin" "$dest/tools" "$dest/bin/run-agent" "$dest/uninstall.sh"
  chmod 0644 "$dest"/tools/*.py "$dest/VERSION" "$dest/README.md"
  if [ ! -x "$dest/venv/bin/python" ] || ! "$dest/venv/bin/python" -c '' 2>/dev/null; then
    rm -rf "$dest/venv"
    # The agent needs only the standard library: a venv without pip pins the
    # interpreter and needs no python3-venv package.
    if ! python3 -m venv --without-pip "$dest/venv" 2>/dev/null; then
      rm -rf "$dest/venv"
      warn "python3 -m venv failed; the service uses $(command -v python3)"
    fi
  fi
  cat >"$dest/install-info" <<EOF
PREFIX=$PREFIX
CONFIG_DIR=$CONFIG_DIR
STATE_DIR=$STATE_DIR
SERVICE=$SERVICE
UNIT_FILE=$UNIT_DIR/$SERVICE.service
AGENT_USER=$AGENT_USER
CREATED_USER=$CREATED_USER
VERSION=$VERSION
EOF
  chmod 0644 "$dest/install-info"
}

install_config() {
  env_file=$ROOT$CONFIG_DIR/agent.env
  mkdir -p "$ROOT$CONFIG_DIR"
  chmod 0755 "$ROOT$CONFIG_DIR"
  # STATE_DIR always follows the directory this run sets up.
  update STATE_DIR "$STATE_DIR"
  python3 "$WORK/helper.py" merge "$env_file" "$ASSETS/agent.env.example" "$WORK/updates"
  act chown "root:$AGENT_GROUP" "$env_file"
  mkdir -p "$ROOT$STATE_DIR"
  chmod 0750 "$ROOT$STATE_DIR"
  act chown "$AGENT_USER:$AGENT_GROUP" "$ROOT$STATE_DIR"
}

install_unit() {
  settings_dir=$(dirname -- "$SETTINGS_PATH")
  if [ -n "$SETTINGS_PATH" ]; then
    settings_rw="ReadWritePaths=-$settings_dir"
  else
    settings_rw="# no SETTINGS_PATH: the settings directory stays read-only"
  fi
  python3 "$WORK/helper.py" render "$ASSETS/sdr-doa-agent.service.in" "$ROOT$UNIT_DIR/$SERVICE.service" \
    "PREFIX=$PREFIX" "CONFIG_DIR=$CONFIG_DIR" "STATE_DIR=$STATE_DIR" "USER=$AGENT_USER" \
    "GROUP=$AGENT_GROUP" "SETTINGS_RW=$settings_rw"
  if [ -z "$ROOT" ] && [ "$DRY_RUN" = 0 ] && [ ! -d /run/systemd/system ]; then
    warn "systemd is not running; start the agent with: $PREFIX/bin/run-agent (after loading $CONFIG_DIR/agent.env)"
    return
  fi
  act systemctl daemon-reload
  act systemctl enable "$SERVICE.service"
  if [ "$START_ON" = 1 ]; then
    act systemctl restart "$SERVICE.service"
  fi
}

show_dry_run() {
  say "--- $CONFIG_DIR/agent.env"
  sed 's/^SDR_DOA_MQTT_PASSWORD=..*/SDR_DOA_MQTT_PASSWORD=<hidden>/' "$ROOT$CONFIG_DIR/agent.env"
  if [ "$SERVICE_ON" = 1 ]; then
    say "--- $UNIT_DIR/$SERVICE.service"
    cat "$ROOT$UNIT_DIR/$SERVICE.service"
  fi
  say "--- agent command"
  (
    set -a
    # shellcheck disable=SC1090
    . "$ROOT$CONFIG_DIR/agent.env"
    set +a
    SDR_DOA_AGENT_HOME=$ROOT$PREFIX SDR_DOA_AGENT_PYTHON=$PREFIX/venv/bin/python SDR_DOA_AGENT_PRINT_COMMAND=1 \
      sh "$ROOT$PREFIX/bin/run-agent"
  ) | sed "s|$ROOT||g"
}

check_started() {
  if [ "$SERVICE_ON" = 1 ] && [ "$START_ON" = 1 ] && [ -z "$ROOT" ] && [ -d /run/systemd/system ]; then
    sleep 2
    if systemctl is-active --quiet "$SERVICE.service"; then
      say "The $SERVICE service is running and starts at boot."
    else
      warn "the $SERVICE service is not running; see: journalctl -u $SERVICE -n 50"
    fi
  fi
}

main() {
  WORK=$(mktemp -d)
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  : >"$WORK/updates"
  parse_args "$@"
  if [ "$DRY_RUN" = 1 ]; then
    ROOT=$WORK/root
  elif [ -z "$ROOT" ] && [ "$(id -u)" != 0 ]; then
    die "run as root: sudo sh $0 $*"
  fi
  check_python
  write_helper
  locate_source

  existing_env=$ROOT$CONFIG_DIR/agent.env
  if [ "$DRY_RUN" = 1 ] && [ -f "$CONFIG_DIR/agent.env" ]; then
    mkdir -p "$ROOT$CONFIG_DIR"
    cp "$CONFIG_DIR/agent.env" "$existing_env"
  fi
  SETTINGS_PATH=$(sed -n 's/^SETTINGS_PATH=//p' "$WORK/updates" | tail -n 1)
  if [ -z "$SETTINGS_PATH" ] && [ -f "$existing_env" ]; then
    SETTINGS_PATH=$(python3 "$WORK/helper.py" get "$existing_env" SETTINGS_PATH)
  elif [ -z "$SETTINGS_PATH" ]; then
    SETTINGS_PATH=$DEFAULT_SETTINGS
  fi
  if [ -z "$STATE_DIR" ] && [ -f "$existing_env" ]; then
    STATE_DIR=$(python3 "$WORK/helper.py" get "$existing_env" STATE_DIR)
  fi
  STATE_DIR=${STATE_DIR:-$DEFAULT_STATE_DIR}
  choose_user
  ensure_user

  if [ "$DRY_RUN" = 1 ]; then
    say "Dry run of the SDR-DoA agent $VERSION install into $PREFIX (service user $AGENT_USER)"
  else
    say "Installing the SDR-DoA agent $VERSION into $ROOT$PREFIX (service user $AGENT_USER)"
  fi
  install_files
  install_config
  if [ "$SERVICE_ON" = 1 ]; then
    install_unit
  fi
  if [ "$DRY_RUN" = 1 ]; then
    show_dry_run
    say "Dry run: nothing was changed."
    return
  fi
  check_started
  say "Settings: $CONFIG_DIR/agent.env (sudo systemctl restart $SERVICE after a change)"
  if [ "$SERVICE_ON" = 1 ] && [ -z "$ROOT" ]; then
    say "Status:   systemctl status $SERVICE    Logs: journalctl -u $SERVICE -f"
  fi
  say "Remove:   sudo sh $PREFIX/uninstall.sh"
  if [ ! -e "$SETTINGS_PATH" ]; then
    warn "$SETTINGS_PATH does not exist yet; set SETTINGS_PATH in agent.env if KrakenSDR keeps it elsewhere"
  fi
}

main "$@"
