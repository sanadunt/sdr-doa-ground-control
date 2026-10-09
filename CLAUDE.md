# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The full repository guide (architecture, data flow, conventions, commands, QA expectations) lives in `AGENTS.md` and is imported here so it stays the single source:

@AGENTS.md

`initialize.md` is the original entrypoint, written in Bahasa Indonesia, and its absolute paths (`/Users/mac/...`) are from another machine. Keep existing English identifiers, endpoints, schema names and technical comments in English. Prose docs in this repo are mostly Indonesian.

## Running a single test

```sh
# Vitest: one file, or filter by test name
cd frontend && npx vitest run src/lib/doaGeometry.test.ts
cd frontend && npx vitest run -t "partial test name"

# Python unittest-based files (test_ground_console_static, test_rdf_node_mqtt_v2, test_sdr_doa_mqtt_monitor)
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_ground_console_static.GroundConsoleStaticRegressionTests.<test_method>

# Python standalone assert scripts (all other tools/test_*.py): run the whole file,
# or call one test_* function directly
python3 tools/test_sdr_doa_collector.py
python3 -c "import sys; sys.path.insert(0, 'tools'); import test_sdr_doa_collector as t; t.test_<name>()"
```

The standalone scripts collect every module-level `test_*` function in their `__main__` block, so `unittest discover` skips them. Run them by name when you touch their modules.

## Verification after a change

From `initialize.md`, the expected sequence before calling work done:

```sh
cd frontend && npm test && npm run check && npm run build
cd .. && PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest discover -s tools -p 'test_*.py'
git diff --check
```

The `.venv` is not committed. Create it locally (Python stdlib is enough for most tools; add `paho-mqtt==2.1.0` for the MQTT monitor/publisher and their tests).

## Data contract notes that span several files

- `TelemetrySnapshot` (`frontend/src/types.ts`) mirrors what `tools/sdr_doa_collector.py` produces via `/api/snapshot`. Key fields are `doa_candidates.csv` / `doa_candidates.xml` (kept separate, never silently merged), `native_consistency`, `authority`, `publication_gate` (`state` + `reasons`), and `overall_state`.
- `canonical_angle_deg` is the canonical source value. It is not necessarily the plotted display peak.
- `angular_power_db` is a 360-bin angular DoA spectrum, not a frequency spectrum.
- Compass/Polar conversion happens in the renderer (`lib/polar.ts`) from settings. Never rewrite source data for display.
- Local freshness expiry must not reset data age on every response. Expired data is cleared or marked stale in active visuals.
- Health available, Data Out available, native records present, and delivery READY are four different states.

## Known failure modes

- `ModuleNotFoundError: No module named 'paho'`: local config has `mqtt_host`, so the console loads the monitor. Install `paho-mqtt==2.1.0` into `.venv`.
- Basemap missing: MapLibre is only the renderer. Check CSP `connect-src`/`img-src` in `ground_console.py` against the tile host in `lib/map.ts`, then network/proxy. A tile failure does not mean the overlay failed.
- Overlay in the DOM but invisible: check coordinate validity and camera, a fresh 360-length `angular_power_db`, non-empty geometry, visibility/opacity/paint, canvas fallback stacking and transform, map resize, and stale `localStorage` overlay settings.
- Plot or map resets on data update: data updates must go through the restyle/set-data path. Do not resend layout/camera. Keep user state (zoom, rotation, head-up, manual range) separate from the data revision.

## antislop paths

`AGENTS.md` points to `antislop.md` and `skills/antislop-*/SKILL.md`. Neither exists in this checkout. Only `anti-slop/` holds past audit reports. If antislop applies to a task and those files are missing, tell the user instead of guessing their content.
