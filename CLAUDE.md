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
# test_receiver_record_store, test_build_browsdr_receiver)
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_ground_console_static.GroundConsoleStaticRegressionTests.<test_method>

# Python standalone assert scripts (all other tools/test_*.py): run the whole file,
# or call one test_* function directly
python3 tools/test_sdr_doa_collector.py
python3 -c "import sys; sys.path.insert(0, 'tools'); import test_sdr_doa_collector as t; t.test_<name>()"

# Node tests for the Receiver overlay (iq_spectrum, sweep_dsp, audio_recorder, i18n, archive_uploads, rx_errors).
# They need the vendor/BrowSDR submodule and import .ts through tools/receiver_overlay_hooks.mjs;
# test_receiver_sweep_dsp.mjs needs Node 22.13+.
node --test tools/test_receiver_sweep_dsp.mjs
```

## Receiver (embedded BrowSDR)

`AGENTS.md` lists the seventh route (`#/receiver`, `ReceiverPage.tsx`); the details are here. It iframes a separately built BrowSDR sub-app served same-origin at `/receiver/`.

- Source is the `vendor/BrowSDR` git submodule, pinned by `BROWSDR_REVISION` in `tools/build_browsdr_receiver.py`. Fetch it with `git submodule update --init --recursive`.
- Do not edit `vendor/BrowSDR`. Local changes live in `tools/browsdr_receiver_overlay/src/` and are applied at build time: the builder copies the submodule to a temp dir, overlays those files, patches anchors with `_replace_once` (it fails if an anchor is missing or appears more than once), runs `npm ci` and `npm run build --base=/receiver/` with npm resolved through `shutil.which` (`npm.cmd` on Windows), and writes `frontend/dist/receiver`. If you bump the pin, also bump `BROWSDR_OVERLAY_BASE_REVISION` and re-check every anchor.
- Build order: `npm run build` empties `frontend/dist`, including `dist/receiver`. Use `cd frontend && npm run build:all`, or run `.venv/bin/python tools/build_browsdr_receiver.py` after every `npm run build`. Without the Receiver build, `/receiver/` returns a 404 page with these steps, and the static suite fails its Receiver checks when `vendor/BrowSDR` is checked out.
- Lifetime: after the first visit the iframe stays mounted (hidden) across route changes, so RX, scans and recordings keep running until the console page reloads. Shortcuts 1–7 and R are forwarded from the frame except while typing in a field there. Theme and language arrive as `?theme=&lang=` and later through a `console-language-change` event, without reloading the frame.
- The embedded build registers no service worker and loads no remote fonts. The Mock SDR appears only on a loopback host with `?mock=1` and is labelled MOCK. WebUSB, and therefore Chromium (Chrome or Edge), is required for a real HackRF.
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

## Known failure modes

- MQTT monitor shows ERROR "MQTT monitor dependency paho-mqtt is not installed": the console starts without paho, but monitoring needs `paho-mqtt==2.1.0` in `.venv`.
- Receiver page says "Receiver is not built": `npm run build` deleted `frontend/dist/receiver`. Run the Receiver builder (or `npm run build:all`).
- Basemap missing: MapLibre is only the renderer. Check CSP `connect-src`/`img-src` in `ground_console.py` against both tile hosts in `lib/map.ts`, then network/proxy. A tile failure does not mean the overlay failed; the map shows BASEMAP UNAVAILABLE when every host failed.
- Overlay in the DOM but invisible: check `doaReady` (DAQ, ADC overdrive, CONFLICT, missing view, stalled node), coordinate validity and camera, a fresh 360-length `angular_power_db`, non-empty geometry, visibility/opacity/paint, canvas fallback stacking and transform, map resize, and stale `localStorage` overlay settings.
- Plot or map resets on data update: data updates must go through the restyle/set-data path. Do not resend layout/camera. Keep user state (zoom, rotation, head-up, manual range) separate from the data revision.
- Data STALE with `NODE_CLOCK_STALLED` while port 8081 still answers: the node's DSP stopped. This is reported, not a console bug.

## antislop paths

`AGENTS.md` points to `antislop.md` and `skills/antislop-*/SKILL.md`. Neither exists in this checkout. Only `anti-slop/` holds past audit reports. If antislop applies to a task and those files are missing, tell the user instead of guessing their content.
