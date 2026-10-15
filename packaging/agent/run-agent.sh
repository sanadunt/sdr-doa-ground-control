#!/bin/sh
# Starts sdr_doa_lan_agent.py with flags built from the agent.env variables.
# systemd passes them with EnvironmentFile=/etc/sdr-doa-agent/agent.env, Docker
# with env_file/environment. Empty values use the agent's defaults; arguments
# given to this script go to the agent after the generated flags.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
home=${SDR_DOA_AGENT_HOME:-}
if [ -z "$home" ]; then
  for candidate in "$here/.." "$here/../.."; do
    if [ -f "$candidate/tools/sdr_doa_lan_agent.py" ]; then
      home=$(CDPATH='' cd -- "$candidate" && pwd)
      break
    fi
  done
fi
if [ -z "$home" ] || [ ! -f "$home/tools/sdr_doa_lan_agent.py" ]; then
  echo "run-agent: sdr_doa_lan_agent.py not found; set SDR_DOA_AGENT_HOME" >&2
  exit 78
fi
python=${SDR_DOA_AGENT_PYTHON:-}
if [ -z "$python" ]; then
  if [ -x "$home/venv/bin/python" ]; then python=$home/venv/bin/python; else python=python3; fi
fi

# is_on NAME VALUE: 0 for 1/true/yes/on, 1 for 0/false/no/off/empty.
is_on() {
  case $2 in
    1 | true | TRUE | True | yes | YES | on | ON) return 0 ;;
    0 | false | FALSE | False | no | NO | off | OFF | '') return 1 ;;
  esac
  echo "run-agent: $1 must be 0 or 1, got '$2'" >&2
  exit 78
}

# The generated flags are appended, then the original arguments are rotated to
# the end, so an explicit argument wins over agent.env.
extra=$#
set -- "$@" --base-url "${BASE_URL:-http://127.0.0.1:8081}"
set -- "$@" --mqtt-host "${MQTT_HOST:-127.0.0.1}" --mqtt-port "${MQTT_PORT:-1883}"
set -- "$@" --state-dir "${STATE_DIR:-/var/lib/sdr-doa-agent}"
set -- "$@" --clock-source "${CLOCK_SOURCE:-local}"
if is_on MQTT_TLS "${MQTT_TLS:-0}"; then set -- "$@" --mqtt-tls; fi
if [ -n "${MQTT_CAFILE:-}" ]; then set -- "$@" --mqtt-cafile "$MQTT_CAFILE"; fi
if [ -n "${MQTT_USERNAME:-}" ]; then set -- "$@" --mqtt-username "$MQTT_USERNAME"; fi
if is_on PUBLISH "${PUBLISH:-1}"; then set -- "$@" --publish; fi
config_on=0
if is_on ENABLE_CONFIG "${ENABLE_CONFIG:-0}"; then
  if [ -z "${SETTINGS_PATH:-}" ]; then
    echo "run-agent: ENABLE_CONFIG=1 needs SETTINGS_PATH (the KrakenSDR settings.json)" >&2
    exit 78
  fi
  config_on=1
  set -- "$@" --enable-config
fi
if [ -n "${SETTINGS_PATH:-}" ]; then set -- "$@" --settings-path "$SETTINGS_PATH"; fi
if [ -n "${AUTHORITY:-}" ]; then set -- "$@" --authority "$AUTHORITY"; fi
if [ -n "${HEALTH_INTERVAL:-}" ]; then set -- "$@" --health-interval "$HEALTH_INTERVAL"; fi
if [ -n "${DOA_RATE:-}" ]; then set -- "$@" --doa-rate "$DOA_RATE"; fi
if [ -n "${STATE_INTERVAL:-}" ]; then set -- "$@" --state-interval "$STATE_INTERVAL"; fi
if [ -n "${POLL_INTERVAL:-}" ]; then set -- "$@" --poll-interval "$POLL_INTERVAL"; fi
if [ -n "${COLLECT_BUDGET:-}" ]; then set -- "$@" --collect-budget "$COLLECT_BUDGET"; fi
while [ "$extra" -gt 0 ]; do
  arg=$1
  shift
  set -- "$@" "$arg"
  extra=$((extra - 1))
done

if [ "${SDR_DOA_AGENT_PRINT_COMMAND:-0}" = 1 ]; then
  # Used by the installer's --dry-run and the tests; prints, does not start.
  printf '%s' "$python $home/tools/sdr_doa_lan_agent.py"
  printf ' %s' "$@"
  printf '\n'
  exit 0
fi
# A config patch replaces settings.json through a temporary file next to it,
# so this user needs write access to the file and its directory. Stop with
# the cause instead of answering every patch with a failed ACK.
if [ "$config_on" = 1 ]; then
  settings_dir=$(dirname -- "$SETTINGS_PATH")
  if [ ! -w "$settings_dir" ] || { [ -e "$SETTINGS_PATH" ] && [ ! -w "$SETTINGS_PATH" ]; }; then
    echo "run-agent: ENABLE_CONFIG=1, but uid $(id -u) cannot write $SETTINGS_PATH or $settings_dir." >&2
    echo "Native install: sudo sh install.sh --enable-config --user <owner of settings.json>." >&2
    echo "Docker: mount the KrakenSDR _share directory and run as its owner (docker-compose.yml)." >&2
    exit 78
  fi
fi
export PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
exec "$python" "$home/tools/sdr_doa_lan_agent.py" "$@"
