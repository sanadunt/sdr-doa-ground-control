#!/bin/sh
# trial-receiver-engine.sh: phase 0 trial of a Receiver engine tab (issue #15).
#
# Starts a separate Chromium (or Chrome) with a temporary profile on this
# console's Receiver page, in a normal window or headless (--headless=new),
# and logs the browser's CPU and memory, the RadioSpectrum on USB and the
# Receiver mirror's ages every few seconds. Nothing is installed and nothing
# is changed outside the temporary profile, which is removed at the end.
# packaging/receiver-engine/README.md has the measurement procedure.
set -eu

PORT=8787
URL=
BROWSER=
HEADLESS=0
NO_THROTTLE=0
DURATION=600
SAMPLE=5
LOG=
KEEP_PROFILE=0
DRY_RUN=0
HACKRF_USB=1d50:6089

usage() {
  cat <<EOF
Usage: trial-receiver-engine.sh [options]

Opens the console's Receiver page in a separate browser with a temporary
profile and logs CPU, memory, the RadioSpectrum on USB and the Receiver
mirror every SAMPLE seconds. Run it as the desktop user, not root.

  --port N          console port on 127.0.0.1 (default 8787)
  --url URL         page to open (default http://127.0.0.1:PORT/#/receiver)
  --browser PATH    chromium, chromium-browser, google-chrome-stable or
                    google-chrome from PATH by default
  --headless        run with --headless=new (no window)
  --no-throttle     add the flags that stop background throttling, to
                    compare with a run without them
  --duration SEC    stop after SEC seconds (default 600; 0 = until Ctrl+C)
  --sample SEC      seconds between log lines (default 5)
  --log FILE        log file (default ./receiver-engine-trial-DATE.log)
  --keep-profile    keep the temporary profile at the end
  --dry-run         print the browser command and exit
  -h, --help        this text
EOF
}

die() {
  printf 'trial-receiver-engine: %s\n' "$*" >&2
  exit 1
}

need_value() {
  if [ "$#" -lt 2 ] || [ -z "$2" ]; then
    die "$1 needs a value"
  fi
}

is_count() {
  case $1 in
    '' | *[!0-9]*) return 1 ;;
  esac
  return 0
}

while [ "$#" -gt 0 ]; do
  case $1 in
    --port) need_value "$@"; PORT=$2; shift 2 ;;
    --url) need_value "$@"; URL=$2; shift 2 ;;
    --browser) need_value "$@"; BROWSER=$2; shift 2 ;;
    --headless) HEADLESS=1; shift ;;
    --no-throttle) NO_THROTTLE=1; shift ;;
    --duration) need_value "$@"; DURATION=$2; shift 2 ;;
    --sample) need_value "$@"; SAMPLE=$2; shift 2 ;;
    --log) need_value "$@"; LOG=$2; shift 2 ;;
    --keep-profile) KEEP_PROFILE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

if ! is_count "$PORT" || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  die "--port must be 1..65535"
fi
is_count "$DURATION" || die "--duration must be whole seconds"
if ! is_count "$SAMPLE" || [ "$SAMPLE" -lt 1 ]; then
  die "--sample must be at least 1 second"
fi
[ -n "$URL" ] || URL="http://127.0.0.1:$PORT/#/receiver"
case $URL in
  http://127.0.0.1:"$PORT"/*) ;;
  *) die "--url must be on http://127.0.0.1:$PORT/, the origin the WebUSB policy names" ;;
esac
[ -n "$LOG" ] || LOG="./receiver-engine-trial-$(date -u +%Y%m%dT%H%M%SZ).log"

if [ -z "$BROWSER" ]; then
  for candidate in chromium chromium-browser google-chrome-stable google-chrome; do
    if command -v "$candidate" > /dev/null 2>&1; then
      BROWSER=$(command -v "$candidate")
      break
    fi
  done
fi
[ -n "$BROWSER" ] || die "no Chromium or Chrome found; pass --browser PATH"

# The browser's own flags. No remote debugging port: it would let any local
# process drive this browser. No --no-sandbox: the script refuses root instead.
set -- \
  --no-first-run \
  --no-default-browser-check \
  --disable-sync \
  --password-store=basic \
  --autoplay-policy=no-user-gesture-required \
  --new-window
[ "$HEADLESS" -eq 0 ] || set -- "$@" --headless=new
[ "$NO_THROTTLE" -eq 0 ] || set -- "$@" \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows

if [ "$DRY_RUN" -eq 1 ]; then
  printf '%s --user-data-dir=PROFILE' "$BROWSER"
  printf ' %s' "$@" "$URL"
  printf '\n'
  exit 0
fi

[ "$(id -u)" -ne 0 ] || die "run as the desktop user, not root (Chromium would need --no-sandbox)"
[ -r /proc/self/stat ] || die "needs Linux /proc to measure the browser"
command -v curl > /dev/null 2>&1 || die "needs curl to read the console"

if ! curl -fsS --noproxy '*' --max-time 3 -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
  die "the console does not answer on http://127.0.0.1:$PORT/api/health; start it first"
fi

POLICY_FOUND=0
for dir in /etc/opt/chrome/policies/managed /etc/chromium/policies/managed /etc/chromium-browser/policies/managed; do
  for file in "$dir"/*.json; do
    [ -r "$file" ] || continue
    if grep -q WebUsbAllowDevicesForUrls "$file"; then
      POLICY_FOUND=1
      printf 'policy: %s\n' "$file"
    fi
  done
done
[ "$POLICY_FOUND" -eq 1 ] || printf 'warning: no WebUsbAllowDevicesForUrls policy found; auto-connect needs one (README, step 1)\n' >&2

TICKS=$(getconf CLK_TCK 2> /dev/null || echo 100)

# The browser and every process below it.
tree_pids() {
  ps -e -o pid= -o ppid= | awk -v root="$1" '
    { parent[$1] = $2; pids[NR] = $1 }
    END {
      keep[root] = 1
      changed = 1
      while (changed) {
        changed = 0
        for (i in pids) {
          p = pids[i]
          if (!(p in keep) && (parent[p] in keep)) { keep[p] = 1; changed = 1 }
        }
      }
      for (p in keep) print p
    }'
}

# CPU ticks (user + system) of the given pids; the command name in
# /proc/PID/stat may hold spaces, so fields count from after its ")".
cpu_ticks() {
  total=0
  for pid in "$@"; do
    [ -r "/proc/$pid/stat" ] || continue
    ticks=$(sed 's/^.*) //' "/proc/$pid/stat" 2> /dev/null | awk '{ print $12 + $13 }') || continue
    [ -n "$ticks" ] || continue
    total=$((total + ticks))
  done
  printf '%s\n' "$total"
}

rss_kib() {
  [ "$#" -gt 0 ] || { printf '0\n'; return; }
  pids=$(printf '%s,' "$@")
  ps -o rss= -p "${pids%,}" 2> /dev/null | awk '{ sum += $1 } END { print sum + 0 }'
}

usb_state() {
  if command -v lsusb > /dev/null 2>&1; then
    if lsusb -d "$HACKRF_USB" > /dev/null 2>&1; then printf 'present'; else printf 'absent'; fi
  else
    printf 'unknown'
  fi
}

# The Receiver mirror as the console sees it (only filled while the LAN view is open).
mirror_state() {
  body=$(curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:$PORT/api/mirror/receiver" 2> /dev/null) || { printf 'mirror=unreachable'; return; }
  if command -v python3 > /dev/null 2>&1; then
    printf '%s' "$body" | python3 -I -c '
import json, sys
d = json.load(sys.stdin)
s = d.get("state") or {}
src = d.get("source") or {}
print("mirror_source_age_ms=%s mirror_frame_age_ms=%s visible=%s running=%s connected=%s" % (
    d.get("source_age_ms"), d.get("frame_age_ms"), src.get("visible"), s.get("running"), s.get("connected")), end="")
' 2> /dev/null || printf 'mirror=unreadable'
  else
    printf 'mirror=no-python3'
  fi
}

PROFILE=$(mktemp -d "${TMPDIR:-/tmp}/sdr-doa-receiver-engine.XXXXXX")
BROWSER_PID=

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$BROWSER_PID" ] && kill -0 "$BROWSER_PID" 2> /dev/null; then
    # The browser ends its own processes on TERM; what is left after 5 s is killed.
    left=$(tree_pids "$BROWSER_PID" 2> /dev/null || true)
    kill -TERM "$BROWSER_PID" 2> /dev/null || true
    waited=0
    while kill -0 "$BROWSER_PID" 2> /dev/null && [ "$waited" -lt 5 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    for pid in $left; do
      kill -KILL "$pid" 2> /dev/null || true
    done
  fi
  if [ "$KEEP_PROFILE" -eq 1 ]; then
    printf 'profile kept: %s\n' "$PROFILE"
  else
    rm -rf "$PROFILE"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$BROWSER" --user-data-dir="$PROFILE" "$@" "$URL" > "$PROFILE/browser.log" 2>&1 &
BROWSER_PID=$!
printf 'browser: %s (pid %s), profile %s\n' "$BROWSER" "$BROWSER_PID" "$PROFILE"
printf 'log: %s\n' "$LOG"

printf '# %s browser=%s headless=%s no_throttle=%s url=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BROWSER" "$HEADLESS" "$NO_THROTTLE" "$URL" >> "$LOG"

started=$(date +%s)
pids=$(tree_pids "$BROWSER_PID")
# shellcheck disable=SC2086 # one pid per word
last_ticks=$(cpu_ticks $pids)
last_time=$started
max_cpu=0
max_rss=0
samples=0
cpu_sum=0

while kill -0 "$BROWSER_PID" 2> /dev/null; do
  sleep "$SAMPLE"
  kill -0 "$BROWSER_PID" 2> /dev/null || break
  now=$(date +%s)
  pids=$(tree_pids "$BROWSER_PID")
  # shellcheck disable=SC2086 # one pid per word
  ticks=$(cpu_ticks $pids)
  # shellcheck disable=SC2086 # one pid per word
  rss=$(rss_kib $pids)
  elapsed=$((now - last_time))
  [ "$elapsed" -ge 1 ] || elapsed=1
  # Percent of one core, one decimal, in integer arithmetic.
  cpu10=$(( (ticks - last_ticks) * 1000 / (TICKS * elapsed) ))
  last_ticks=$ticks
  last_time=$now
  count=$(printf '%s\n' "$pids" | grep -c .)
  samples=$((samples + 1))
  cpu_sum=$((cpu_sum + cpu10))
  [ "$cpu10" -le "$max_cpu" ] || max_cpu=$cpu10
  [ "$rss" -le "$max_rss" ] || max_rss=$rss
  line=$(printf '%s t=%ss cpu=%s.%s%% rss=%sMiB procs=%s usb=%s %s' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$((now - started))" "$((cpu10 / 10))" "$((cpu10 % 10))" \
    "$((rss / 1024))" "$count" "$(usb_state)" "$(mirror_state)")
  printf '%s\n' "$line" | tee -a "$LOG"
  if [ "$DURATION" -gt 0 ] && [ $((now - started)) -ge "$DURATION" ]; then
    break
  fi
done

if [ "$samples" -gt 0 ]; then
  average=$((cpu_sum / samples))
  summary=$(printf 'summary: samples=%s cpu_avg=%s.%s%% cpu_max=%s.%s%% rss_max=%sMiB' \
    "$samples" "$((average / 10))" "$((average % 10))" "$((max_cpu / 10))" "$((max_cpu % 10))" "$((max_rss / 1024))")
  printf '%s\n' "$summary" | tee -a "$LOG"
fi
kill -0 "$BROWSER_PID" 2> /dev/null || printf 'the browser exited; its output: %s/browser.log (kept with --keep-profile)\n' "$PROFILE"
