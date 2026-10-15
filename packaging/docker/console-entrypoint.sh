#!/bin/sh
# Entrypoint of the Ground Console image.
#
# Everything the console saves lives in one directory (default /data, the
# volume): console.json, branding.json, preferences.json, receiver/ and .env.
# The console binds 127.0.0.1 only. Run the container with the host network
# (network_mode: host, Linux) so that loopback is the host's loopback; a bridge
# network with a published port cannot reach a loopback-only server.
#
# Extra arguments are passed to ground_console.py. Do not pass --base-url or
# --mqtt-*: they override the saved settings for the run, so changes made in
# the UI would look unsaved after a restart.
set -eu

APP_DIR=${SDR_DOA_APP_DIR:-/opt/sdr-doa-ground-console}
DATA_DIR=${SDR_DOA_DATA_DIR:-/data}
PORT=${SDR_DOA_PORT:-8787}
PYTHON=${SDR_DOA_PYTHON:-python}

case $PORT in
  '' | *[!0-9]*)
    echo "sdr-doa-console: SDR_DOA_PORT must be a port number, got '$PORT'" >&2
    exit 64
    ;;
esac

if ! mkdir -p "$DATA_DIR/receiver" 2>/dev/null || [ ! -w "$DATA_DIR" ]; then
  echo "sdr-doa-console: $DATA_DIR is not writable by uid $(id -u)." >&2
  echo "Use the named volume from docker-compose.yml, or chown a bind mount to $(id -u):$(id -g)." >&2
  exit 73
fi

exec "$PYTHON" "$APP_DIR/tools/ground_console.py" \
  --bind 127.0.0.1 \
  --port "$PORT" \
  --config-path "$DATA_DIR/console.json" \
  --branding-path "$DATA_DIR/branding.json" \
  --preferences-path "$DATA_DIR/preferences.json" \
  --data-dir "$DATA_DIR/receiver" \
  --env-file "$DATA_DIR/.env" \
  "$@"
