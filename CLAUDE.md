# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The full repository guide (architecture, data flow, conventions, commands, QA expectations) lives in `AGENTS.md` and is imported here so it stays the single source:

@AGENTS.md

`initialize.md` is the original entrypoint, written in Bahasa Indonesia. Keep existing English identifiers, endpoints, schema names and technical comments in English. Prose docs in this repo are mostly Indonesian.

## Running a single test

```sh
# Vitest: one file, or filter by test name
cd frontend && npx vitest run src/lib/doaGeometry.test.ts
cd frontend && npx vitest run -t "partial test name"

# Python unittest-based files (test_ground_console_static, test_rdf_node_mqtt_v2, test_sdr_doa_mqtt_monitor,
# test_receiver_record_store, test_build_browsdr_receiver, test_mqtt_config_patch, test_config_patch_contract)
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_ground_console_static.GroundConsoleStaticRegressionTests.<test_method>
# Config-patch HTTP contract (fake monitor, no broker) and the backend-code/i18n contract with lib/configPatch.ts
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_mqtt_config_patch tools.test_config_patch_contract
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_mqtt_config_patch.ConfigPatchServerTests.<test_method>

# Python standalone assert scripts (all other tools/test_*.py): run the whole file,
# or call one test_* function directly
python3 tools/test_sdr_doa_collector.py
python3 -c "import sys; sys.path.insert(0, 'tools'); import test_sdr_doa_collector as t; t.test_<name>()"

# Node tests for the Receiver overlay (iq_spectrum, sweep_dsp, audio_recorder, i18n, archive_uploads, rx_errors,
# console_bridge, bridge_contract, ...). They need the vendor/BrowSDR submodule and import .ts through
# tools/receiver_overlay_hooks.mjs; test_receiver_sweep_dsp.mjs needs Node 22.13+.
node --test tools/test_receiver_sweep_dsp.mjs
node --test tools/test_receiver_console_bridge.mjs    # frame side of the dashboard bridge, fake app
node --test tools/test_receiver_bridge_contract.mjs   # console and frame protocol copies must match
```

## Receiver (embedded BrowSDR)

`AGENTS.md` lists the seventh route (`#/receiver`, `ReceiverPage.tsx`); the details are here. It iframes a separately built BrowSDR sub-app served same-origin at `/receiver/`.

- Source is the `vendor/BrowSDR` git submodule, pinned by `BROWSDR_REVISION` in `tools/build_browsdr_receiver.py`. Fetch it with `git submodule update --init --recursive`.
- Do not edit `vendor/BrowSDR`. Local changes live in `tools/browsdr_receiver_overlay/src/` and are applied at build time: the builder copies the submodule to a temp dir, overlays those files, patches anchors with `_replace_once` (it fails if an anchor is missing or appears more than once), runs `npm ci` and `npm run build --base=/receiver/` with npm resolved through `shutil.which` (`npm.cmd` on Windows), and writes `frontend/dist/receiver`. If you bump the pin, also bump `BROWSDR_OVERLAY_BASE_REVISION` and re-check every anchor.
- Build order: `npm run build` empties `frontend/dist`, including `dist/receiver`. Use `cd frontend && npm run build:all`, or run `.venv/bin/python tools/build_browsdr_receiver.py` after every `npm run build`. Without the Receiver build, `/receiver/` returns a 404 page with these steps, and the static suite fails its Receiver checks when `vendor/BrowSDR` is checked out.
- Lifetime: the iframe mounts lazily, on the first `#/receiver` visit or the first Mulai/Dengar click in the Overview Spektrum dock, never at console load, because mounting runs `autoConnectAuthorizedHackRF` and claims the radio. After that it stays mounted (hidden) across route changes, so RX, scans and recordings keep running until the console page reloads. Never move or key that section: it would reload the frame and stop RX. Shortcuts 1–7 and R are forwarded from the frame except while typing in a field there. Theme and language arrive as `?theme=&lang=` and later through a `console-language-change` event, without reloading the frame. When the route becomes `receiver` again, `ReceiverPage` dispatches `console-theme-change` on the frame window, which makes the Receiver resize its canvases (they are 0×0 while hidden).
- Dashboard bridge (Overview Spektrum dock ↔ frame), `window.postMessage` with envelope `{ch: "sdr-console-receiver", v: 1, type, ...}`:
  - Senders are checked: the console takes only `event.origin === location.origin` from the frame's `contentWindow`; the frame installs the bridge only under a same-origin parent and takes only `window.parent`. Anything else is ignored.
  - Frame to console: `receiver:hello`, `receiver:status` (debounced 100 ms, 2 s heartbeat), `receiver:spectrum` (2 MHz crop around the RX centre, 512 max-hold bins, at most 10 fps, transferred `Float32Array`, only while the dock is mounted and the page visible), `receiver:result`. Console to frame: `console:hello|subscribe|start|stop|tune|vfo|listen`, each command with an id. Commands queue (16) until hello; `start` times out after 20 s, the rest after 8 s (`TIMEOUT`); no hello within 8 s of load shows `NO BRIDGE`.
  - Frequencies are integer Hz of the displayed frequency, Freq Shift included (the dock shows `UPCONVERTER` when it is not 0). The frame never changes the sample rate, never calls `connect()` or `validateAndApplyVfoFreq` (their dialogs would be invisible), answers `SWEEP_BUSY` while a wide scan or scan listen runs, and keeps VFO 1 muted on a start without listen (`initialVfoEnabled()`).
  - The constants exist twice, `frontend/src/lib/receiverBridgeProtocol.ts` and the overlay's `console-bridge-protocol.ts`; change both (`tools/test_receiver_bridge_contract.mjs` compares them). `_verify_embedded_build` fails when the bundle lacks the channel string.
- Pairing: `console:start` connects one HackRF already authorized for this origin. With none, it opens the WebUSB chooser only if the click's user activation still reaches the hidden frame, and otherwise answers `NEEDS_PAIRING`; with several it answers `NEEDS_DEVICE_CHOICE`. The dock then offers "Buka Receiver (7)": pair or pick the device once on the Receiver page, go back to Overview, press Mulai. `localhost:8787` and `127.0.0.1:8787` are separate origins with separate WebUSB permissions.
- The embedded build registers no service worker and loads no remote fonts. The Mock SDR appears only on a loopback host (`localhost`, `127.0.0.1`, `[::1]`) with `?mock=1` and is labelled MOCK. From the console use `/?mock=1#/receiver`, or `/?mock=1#/overview` and press Mulai: `consoleRequestsMockSdr()` (in `lib/receiverBridge.ts`, re-exported by `ReceiverPage.tsx`) forwards `mock=1` to the frame and to `console:start` only when the console host is loopback. The Mock's frequency is a no-op, so tuning only moves the axis. WebUSB, and therefore Chromium (Chrome or Edge), is required for a real HackRF.
- Backend: `/api/receiver/*` in `ground_console.py` is backed by `tools/receiver_record_store.py`, a SQLite and audio file store under `--data-dir` (default `~/.local/share/sdr-doa-ground-console`). POST and DELETE require a same-origin loopback `Origin` header, otherwise 403. `/receiver` responses get their own MIME allowlist, a WebUSB/autoplay policy, and a static root kept separate from the main app's. Sessions left open by a reload or crash are closed after 2 minutes without activity (checked at store start and when Records is listed) and show as Interrupted.
- `ground_console.py` imports the store, which imports `zoneinfo` at startup, so the console needs Python 3.9+. On Windows, `pip install tzdata`; without it the Records time filters fall back to the browser's current UTC offset.

The standalone scripts collect every module-level `test_*` function in their `__main__` block, so `unittest discover` skips them. Run them by name when you touch their modules.

## Verification after a change

The expected sequence before calling work done:

```sh
cd frontend && npm test && npm run check && npm run build:all
cd .. && PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest discover -s tools -p 'test_*.py'
python3 tools/test_<module>.py              # the standalone scripts for the modules you changed
node --test tools/test_receiver_*.mjs       # when Receiver code changed
git diff --check
```

`npm run build:all` needs the submodule. Without it, `npm run build` is the frontend-only build and the Receiver checks are skipped.

The `.venv` is not committed. Create it locally with Python 3.9+ (stdlib is enough for most tools; add `paho-mqtt==2.1.0` for the MQTT monitor/publisher and their tests).

## Data contract notes that span several files

- `TelemetrySnapshot` (`frontend/src/types.ts`) mirrors what `tools/sdr_doa_collector.py` produces via `/api/snapshot`. Key fields are `doa_candidates.csv` / `doa_candidates.xml` (kept separate, never silently merged), `native_consistency` (with `frame_relation` and `angle_checked`), `authority`, `publication_gate` (`state` + `reasons` + `checks`), `overall_state`, `node_progress`, `signal_quality`, `collection`, and per-path `resources`.
- `canonical_angle_deg` is the native θ₀: an array-frame angle, counter-clockwise. It is not a geographic bearing and not necessarily the plotted display peak. Convert with `geographicBearingForBin()` in `lib/polar.ts`.
- `angular_power_db` is a 360-bin angular DoA spectrum, not a frequency spectrum. Its peak bin should equal θ₀ within 3° (`ANGULAR_PEAK_ANGLE_MISMATCH` otherwise).
- Compass/Polar conversion happens in the renderer (`lib/polar.ts`) from settings. Never rewrite source data for display.
- Local freshness expiry must not reset data age on every response. Expired data is cleared or marked stale in active visuals. Show DoA only through `overviewDoaStatus().shown`.
- Health available, Data Out available, native records present, and delivery READY are four different states.
- `ground_console.py` always collects with `authority="none"` and `clock_source="remote_unverified"`, and nothing passes `canonical_angle_ready=True`. Healthy data therefore reads `overall_state` `UNVERIFIED` (never `LIVE`) and `publication_gate` `BLOCKED` with `DOA_AUTHORITY_NOT_SELECTED`, `CANONICAL_ANGLE_NOT_CONFIGURED` and `GROUND_CLOCK_UNVERIFIED`. That is the console's observation boundary (Kontrol does not change it), not a defect.
- Kontrol has two layers of state. In the browser: admin `checking`/`locked`/`unlocked`, then `edit` → `review` → `sending` → `done`. On the server, per command: `published` → `delivered` (PUBACK < 128) → `acknowledged` (ACK `received`/`applying`) → final `acked` (ACK `applied`, `rejected`, `conflict`, `expired` or `failed`), or final `publish_failed` (publish error or PUBACK ≥ 128) or `no_ack` (no final ACK by `expires_ts_ms` + 5 s, so about 65 s). `monitor_restarted` marks a command whose monitor was replaced; ACKs are still read from the current one.
- `acked` with `applied` only proves that the edge agent wrote `settings.json` and read it back. Whether KrakenSDR picked the change up shows later as a new `center_freq` in Data Out (node card). `base_config_rev` is chosen by the server (see `AGENTS.md`); the browser must echo the revision it reviewed. VFO values in Kontrol come only from RDF v2 `config/reported.effective` (`vfo0_*`), otherwise "tidak dilaporkan". The spectrum dock's node frequency comes from Data Out (`settings.fields.center_freq` in MHz, `doa_candidates.csv.frequency_hz_normalized`), not from MQTT.

## Known failure modes

- MQTT monitor shows ERROR "MQTT monitor dependency paho-mqtt is not installed": the console starts without paho, but monitoring needs `paho-mqtt==2.1.0` in `.venv`.
- Receiver page says "Receiver is not built": `npm run build` deleted `frontend/dist/receiver`. Run the Receiver builder (or `npm run build:all`).
- Basemap missing: MapLibre is only the renderer. Check CSP `connect-src`/`img-src` in `ground_console.py` against both tile hosts in `lib/map.ts`, then network/proxy. A tile failure does not mean the overlay failed; the map shows BASEMAP UNAVAILABLE when every host failed.
- Overlay in the DOM but invisible: check `doaReady` (DAQ, ADC overdrive, CONFLICT, missing view, stalled node), coordinate validity and camera, a fresh 360-length `angular_power_db`, non-empty geometry, visibility/opacity/paint, canvas fallback stacking and transform, map resize, and stale `localStorage` overlay settings.
- Plot or map resets on data update: data updates must go through the restyle/set-data path. Do not resend layout/camera. Keep user state (zoom, rotation, head-up, manual range) separate from the data revision.
- Data STALE with `NODE_CLOCK_STALLED` while port 8081 still answers: the node's DSP stopped. This is reported, not a console bug.
- Old UI after `git pull` (rail instead of the top bar, no dashboard): `frontend/dist` is stale. Run `cd frontend && npm ci && npm run build:all`, then restart the console (the Python side changed too).
- Kontrol shows "No ACK yet" (`no_ack`) about 65 s after Send: no edge agent answered on `ack/config`. Either the agent is not running or uses another broker, or the Pi runs an older `sdr_doa_lan_agent.py` that subscribes to `cmd/config/patch` only with `--enable-config`. This repo's agent with `--publish` but without `--enable-config` answers `rejected` with `REMOTE_CONTROL_DISABLED` instead.
- Kontrol Send stays disabled, or POST returns 409 `CONFIG_REVISION_UNKNOWN`: no v1 `config_reported` (retained by the agent), `ack_config` or `state` has arrived since the monitor connected. The agent publishes `config_reported` only once it can read `settings.json` through Data Out.
- `tools/mqtt_lan_stage.conf` (TLS, passwords, ACL) cannot carry Kontrol: the console monitor has no TLS or credentials and cannot connect there. Use `tools/mqtt_stage4.conf` (anonymous, `127.0.0.1:18884`) locally, or a broker that admits the console anonymously.
- `publish_failed` with a PUBACK reason ≥ 128 (135 is "Not authorized"): the broker ACL does not let the console's anonymous client publish to `sdr/v1/uav-01/cmd/config/patch`.

## antislop paths

`AGENTS.md` points to `antislop.md` and `skills/antislop-*/SKILL.md`. Neither exists in this checkout. Only `anti-slop/` holds past audit reports. If antislop applies to a task and those files are missing, tell the user instead of guessing their content.
