#!/bin/sh
# Removes the SDR-DoA edge agent installed by install-agent.sh.
#
#   sudo sh /opt/sdr-doa-agent/uninstall.sh            # keep agent.env and state
#   sudo sh /opt/sdr-doa-agent/uninstall.sh --purge    # remove them too
set -eu

PREFIX=
PURGE=0
ROOT=

usage() {
  cat <<'EOF'
Usage: sudo sh uninstall.sh [--prefix DIR] [--purge] [--root DIR]

Stops and disables the sdr-doa-agent service and removes the program files.
agent.env and the state directory stay unless --purge is given; --purge also
removes the service user when the installer created it.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

have_systemd() {
  [ -z "$ROOT" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

while [ $# -gt 0 ]; do
  case $1 in
    --prefix) [ $# -ge 2 ] || die "--prefix needs a value"; PREFIX=$2; shift ;;
    --root) [ $# -ge 2 ] || die "--root needs a value"; ROOT=$2; shift ;;
    --purge) PURGE=1 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

if [ -z "$PREFIX" ]; then
  here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
  if [ -f "$here/install-info" ]; then
    PREFIX=${here#"$ROOT"}
  else
    PREFIX=/opt/sdr-doa-agent
  fi
fi
dest=$ROOT$PREFIX
info=$dest/install-info
[ -f "$info" ] || die "$info not found; pass --prefix of the installed agent"
[ -f "$dest/tools/sdr_doa_lan_agent.py" ] || die "$dest does not look like an agent install"
if [ -z "$ROOT" ] && [ "$(id -u)" != 0 ]; then
  die "run as root: sudo sh $0"
fi

# install-info is written by the installer: KEY=VALUE lines without quoting.
value() { sed -n "s/^$1=//p" "$info" | tail -n 1; }
CONFIG_DIR=$(value CONFIG_DIR)
STATE_DIR=$(value STATE_DIR)
SERVICE=$(value SERVICE)
UNIT_FILE=$(value UNIT_FILE)
AGENT_USER=$(value AGENT_USER)
CREATED_USER=$(value CREATED_USER)

if have_systemd; then
  systemctl disable --now "$SERVICE.service" 2>/dev/null || true
fi
if [ -n "$UNIT_FILE" ] && [ -f "$ROOT$UNIT_FILE" ]; then
  rm -f "$ROOT$UNIT_FILE"
  if have_systemd; then systemctl daemon-reload; fi
fi
# Only what the installer put there, so a shared --prefix keeps other files.
rm -rf "$dest/tools" "$dest/venv"
rm -f "$dest/bin/run-agent" "$dest/VERSION" "$dest/README.md" "$dest/uninstall.sh" "$dest/install-info"
rmdir "$dest/bin" "$dest" 2>/dev/null || true
echo "Removed the agent from $PREFIX"

if [ "$PURGE" = 1 ]; then
  rm -f "$ROOT$CONFIG_DIR/agent.env" "$ROOT$STATE_DIR/config_revision.json" "$ROOT$STATE_DIR/config.lock"
  rmdir "$ROOT$CONFIG_DIR" "$ROOT$STATE_DIR" 2>/dev/null || true
  if [ "$CREATED_USER" = 1 ] && [ -z "$ROOT" ] && id "$AGENT_USER" >/dev/null 2>&1; then
    userdel "$AGENT_USER" || true
  fi
  echo "Removed $CONFIG_DIR/agent.env and the agent state in $STATE_DIR"
else
  echo "Kept $CONFIG_DIR/agent.env and $STATE_DIR (remove them with --purge)"
fi
