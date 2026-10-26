#!/bin/sh
# Installs t900-ground-link on the groundstation host, outside Docker: the
# read-only t900-ground-diag, the t900-ground-watchdog with its root service
# and 30 s timer, the operator command t900-link with a polkit rule, and
# t900-ground-usbreset.service.
#
#   sudo sh install.sh                     # defaults, see --help
#   sudo sh install.sh --dry-run           # show what it would do
#   sudo sh install.sh --watchdog-dry-run  # the watchdog only logs its actions
#
# It never edits the PPP peer file, the udev rule or the PPP service, and it
# opens no port. Re-running it upgrades in place and keeps link.conf. Run it
# from packaging/ground-link in the repository or in the console release.
set -eu

MARKER=t900-ground-link
PREFIX=/usr/local
OP_USER=rdf
CONFIG_DIR=/etc/t900-ground-link
UNIT_DIR=/etc/systemd/system
POLKIT_DIR=/etc/polkit-1/rules.d
POLKIT_NAME=50-t900-ground-link.rules
STATE_DIR=/var/lib/t900-ground-link
ROOT=
DRY_RUN=0
POLKIT_ON=1
TIMER_ON=1
WATCHDOG_MODE=
WORK=

usage() {
  cat <<'EOF'
Usage: sudo sh install.sh [options]

  --user NAME          operator who may restart the PPP service and start
                       t900-ground-usbreset.service without a password
                       (default rdf)
  --no-polkit          no polkit rule (the operator then uses sudo)
  --prefix DIR         program files (default /usr/local): DIR/bin/t900-link,
                       DIR/bin/t900-ground-diag, DIR/sbin/t900-ground-watchdog,
                       DIR/share/t900-ground-link/
  --watchdog-dry-run   the watchdog logs its actions without running them
                       (DRY_RUN=1 in /etc/t900-ground-link/link.conf)
  --watchdog-live      the watchdog runs its actions (DRY_RUN=0)
  --no-watchdog        install the watchdog but leave its timer off (and
                       turn it off when an earlier install turned it on)
  --root DIR           install below DIR (test staging): no systemctl
  --dry-run            show the files and commands, change nothing
  -h, --help           this help

Settings: /etc/t900-ground-link/link.conf, written from link.conf.example on
the first install and kept afterwards. Remove with:
  sudo sh PREFIX/share/t900-ground-link/uninstall.sh [--purge]
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

# Values go into sed replacements, unit files and the polkit rule.
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
      --user) need_value "$@"; OP_USER=$2; shift ;;
      --no-polkit) POLKIT_ON=0 ;;
      --prefix) need_value "$@"; PREFIX=$2; shift ;;
      --watchdog-dry-run) WATCHDOG_MODE=1 ;;
      --watchdog-live) WATCHDOG_MODE=0 ;;
      --no-watchdog) TIMER_ON=0 ;;
      --root) need_value "$@"; ROOT=$2; shift ;;
      --dry-run) DRY_RUN=1 ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option $1 (see --help)" ;;
    esac
    shift
  done
  case $OP_USER in
    -* | '' | *[!A-Za-z0-9._-]*) die "--user is not a user name: $OP_USER" ;;
  esac
  check_path --prefix "$PREFIX"
  [ "$PREFIX" != / ] || die "--prefix must not be /"
  if [ -n "$ROOT" ]; then
    check_path --root "$ROOT"
  fi
}

locate_source() {
  HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
  for file in t900-ground-diag t900-ground-watchdog t900-link uninstall.sh link.conf.example README.md \
    t900-ground-watchdog.service.in t900-ground-watchdog.timer t900-ground-usbreset.service.in \
    50-t900-ground-link.rules.in; do
    [ -f "$HERE/$file" ] || die "$HERE/$file is missing; run install.sh from packaging/ground-link"
  done
  VERSION=unknown
  if [ -f "$HERE/../../VERSION" ]; then
    VERSION=$(head -n 1 "$HERE/../../VERSION")
  fi
}

# Refuse to replace a file this installer did not write.
check_ours() {
  if [ -e "$1" ] && ! grep -q "$MARKER" "$1" 2>/dev/null; then
    die "$1 exists and was not written by this installer; move it away or choose another --prefix"
  fi
}

# render TEMPLATE TARGET: replace the @NAME@ placeholders.
render() {
  sed -e "s|@SBIN_DIR@|$PREFIX/sbin|g" -e "s|@SHARE_DIR@|$SHARE_DIR|g" \
    -e "s|@PPP_SERVICE@|$PPP_SERVICE|g" -e "s|@USER@|$OP_USER|g" "$1" >"$2.new"
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

set_dry_run() {
  file=$1
  tmp=$file.new
  if grep -q '^DRY_RUN=' "$file"; then
    sed "s/^DRY_RUN=.*/DRY_RUN=$2/" "$file" >"$tmp"
  else
    { cat "$file"; printf 'DRY_RUN=%s\n' "$2"; } >"$tmp"
  fi
  chmod 0644 "$tmp"
  mv -f "$tmp" "$file"
}

# The PPP service named in the config that will be in effect.
read_ppp_service() {
  values=$(sh "$HERE/t900-ground-watchdog" --config "$1" check-config 2>&1) ||
    die "$CONFIG_DIR/link.conf: $(printf '%s' "$values" | tail -n 1)"
  PPP_SERVICE=$(printf '%s\n' "$values" | sed -n 's/^PPP_SERVICE=//p')
  WATCHDOG_DRY=$(printf '%s\n' "$values" | sed -n 's/^DRY_RUN=//p')
}

polkit_supported() {
  command -v pkaction >/dev/null 2>&1 || return 1
  version=$(pkaction --version 2>/dev/null | awk '{ print $NF }')
  major=${version%%.*}
  minor=${version#*.}
  minor=${minor%%.*}
  case $major$minor in '' | *[!0-9]*) return 1 ;; esac
  # 0.105 (Ubuntu 22.04 and older) reads only .pkla files.
  [ "$major" -ge 1 ] || [ "$minor" -ge 106 ]
}

# Read-only checks of the running system; --root (test staging) skips them.
preflight() {
  if [ -n "$ROOT" ] && [ "$DRY_RUN" = 0 ]; then
    return 0
  fi
  if [ "$POLKIT_ON" = 1 ] && ! id "$OP_USER" >/dev/null 2>&1; then
    if [ "$DRY_RUN" = 1 ]; then
      warn "user $OP_USER does not exist; the install would stop here (pick one with --user, or --no-polkit)"
    else
      die "user $OP_USER does not exist; pick the operator with --user, or install without the rule: --no-polkit"
    fi
  fi
  if [ ! -d /run/systemd/system ]; then
    warn "systemd is not running: the watchdog timer and the polkit rule need it"
  elif ! systemctl cat "$PPP_SERVICE" >/dev/null 2>&1; then
    warn "$PPP_SERVICE is not installed; set PPP_SERVICE in $CONFIG_DIR/link.conf and re-run the installer"
  fi
  if [ "$POLKIT_ON" = 1 ] && ! polkit_supported; then
    warn "polkit 0.106 or later was not found: the rule is installed but has no effect; $OP_USER uses sudo for t900-link restart and usb-reset"
  fi
}

install_files() {
  bin=$ROOT$PREFIX/bin
  sbin=$ROOT$PREFIX/sbin
  share=$ROOT$SHARE_DIR
  config=$ROOT$CONFIG_DIR/link.conf
  units=$ROOT$UNIT_DIR
  for target in "$bin/t900-link" "$bin/t900-ground-diag" "$sbin/t900-ground-watchdog" \
    "$units/t900-ground-watchdog.service" "$units/t900-ground-watchdog.timer" \
    "$units/t900-ground-usbreset.service" "$ROOT$POLKIT_DIR/$POLKIT_NAME"; do
    check_ours "$target"
  done
  if [ -e "$share" ] && [ ! -f "$share/install-info" ] && [ -n "$(ls -A "$share")" ]; then
    die "$SHARE_DIR is not empty and holds no t900-ground-link install"
  fi

  mkdir -p "$bin" "$sbin" "$share" "$units" "$ROOT$CONFIG_DIR"
  copy "$HERE/t900-link" "$bin/t900-link" 0755
  copy "$HERE/t900-ground-diag" "$bin/t900-ground-diag" 0755
  copy "$HERE/t900-ground-watchdog" "$sbin/t900-ground-watchdog" 0755
  copy "$HERE/uninstall.sh" "$share/uninstall.sh" 0755
  copy "$HERE/README.md" "$share/README.md" 0644
  copy "$HERE/link.conf.example" "$share/link.conf.example" 0644

  if [ -f "$config" ]; then
    say "Keeping $CONFIG_DIR/link.conf"
  else
    copy "$HERE/link.conf.example" "$config" 0644
    say "Wrote $CONFIG_DIR/link.conf"
  fi
  if [ -n "$WATCHDOG_MODE" ]; then
    set_dry_run "$config" "$WATCHDOG_MODE"
  fi
  # A config the watchdog cannot use stops the install here.
  read_ppp_service "$config"

  render "$HERE/t900-ground-watchdog.service.in" "$units/t900-ground-watchdog.service"
  copy "$HERE/t900-ground-watchdog.timer" "$units/t900-ground-watchdog.timer" 0644
  render "$HERE/t900-ground-usbreset.service.in" "$units/t900-ground-usbreset.service"
  polkit_rule=
  if [ "$POLKIT_ON" = 1 ]; then
    mkdir -p "$ROOT$POLKIT_DIR"
    render "$HERE/50-t900-ground-link.rules.in" "$ROOT$POLKIT_DIR/$POLKIT_NAME"
    polkit_rule=$POLKIT_DIR/$POLKIT_NAME
  elif [ -f "$ROOT$POLKIT_DIR/$POLKIT_NAME" ]; then
    rm -f "$ROOT$POLKIT_DIR/$POLKIT_NAME"
    say "Removed the polkit rule $POLKIT_DIR/$POLKIT_NAME (--no-polkit)"
  fi

  cat >"$share/install-info" <<EOF
# t900-ground-link install record, read by uninstall.sh
PREFIX=$PREFIX
CONFIG_DIR=$CONFIG_DIR
UNIT_DIR=$UNIT_DIR
STATE_DIR=$STATE_DIR
POLKIT_RULE=$polkit_rule
OP_USER=$OP_USER
VERSION=$VERSION
EOF
  chmod 0644 "$share/install-info"
}

enable_units() {
  if [ -z "$ROOT" ] && [ "$DRY_RUN" = 0 ] && [ ! -d /run/systemd/system ]; then
    warn "systemd is not running; units written but not enabled"
    return 0
  fi
  act systemctl daemon-reload
  if [ "$TIMER_ON" = 1 ]; then
    act systemctl enable --now t900-ground-watchdog.timer
  else
    act systemctl disable --now t900-ground-watchdog.timer
  fi
}

show_dry_run() {
  for file in "$CONFIG_DIR/link.conf" "$UNIT_DIR/t900-ground-watchdog.service" \
    "$UNIT_DIR/t900-ground-watchdog.timer" "$UNIT_DIR/t900-ground-usbreset.service"; do
    say "--- $file"
    cat "$ROOT$file"
  done
  if [ "$POLKIT_ON" = 1 ]; then
    say "--- $POLKIT_DIR/$POLKIT_NAME"
    cat "$ROOT$POLKIT_DIR/$POLKIT_NAME"
  fi
  say "--- program files"
  say "$PREFIX/bin/t900-link"
  say "$PREFIX/bin/t900-ground-diag"
  say "$PREFIX/sbin/t900-ground-watchdog"
  say "$SHARE_DIR/{README.md,link.conf.example,uninstall.sh,install-info}"
}

main() {
  WORK=$(mktemp -d)
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  parse_args "$@"
  SHARE_DIR=$PREFIX/share/t900-ground-link
  locate_source
  if [ "$DRY_RUN" = 1 ]; then
    ROOT=$WORK/root
    # Show what the existing install would become, without touching it.
    if [ -f "$CONFIG_DIR/link.conf" ]; then
      mkdir -p "$ROOT$CONFIG_DIR"
      cp "$CONFIG_DIR/link.conf" "$ROOT$CONFIG_DIR/link.conf"
      chmod 0644 "$ROOT$CONFIG_DIR/link.conf"
    fi
  elif [ -z "$ROOT" ] && [ "$(id -u)" != 0 ]; then
    die "run as root: sudo sh $0 $*"
  fi
  if [ -f "$ROOT$CONFIG_DIR/link.conf" ]; then
    read_ppp_service "$ROOT$CONFIG_DIR/link.conf"
  else
    read_ppp_service "$HERE/link.conf.example"
  fi
  preflight

  if [ "$DRY_RUN" = 1 ]; then
    say "Dry run of the t900-ground-link install into $PREFIX (operator $OP_USER)"
  else
    say "Installing t900-ground-link into $ROOT$PREFIX (operator $OP_USER)"
  fi
  install_files
  enable_units
  if [ "$DRY_RUN" = 1 ]; then
    show_dry_run
    say "Dry run: nothing was changed."
    return 0
  fi
  if [ "$WATCHDOG_DRY" = 1 ]; then
    mode="dry run: it logs its actions and runs none (switch: sudo sh install.sh --watchdog-live)"
  else
    mode="live"
  fi
  if [ "$TIMER_ON" = 1 ]; then
    say "Watchdog: checks $PPP_SERVICE every 30 s, $mode"
  else
    say "Watchdog: installed, timer off (sudo systemctl enable --now t900-ground-watchdog.timer)"
  fi
  if [ "$POLKIT_ON" = 1 ]; then
    say "Operator: $OP_USER may run t900-link restart and t900-link usb-reset without a password"
  fi
  say "Settings: $CONFIG_DIR/link.conf (check: sudo t900-ground-watchdog check-config)"
  say "Journal:  journalctl -t t900-ground-watchdog    Report: t900-ground-diag"
  say "Remove:   sudo sh $SHARE_DIR/uninstall.sh [--purge]"
}

main "$@"
