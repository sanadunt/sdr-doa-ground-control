# SDR-DoA frontend workflow

## Architecture

React + TypeScript + Vite compile the browser application. Python retains the collector, API, local admin/branding, local configuration/dry-run, the subscriber-only MQTT monitor, and the Receiver record store. Production uses only the loopback Python HTTP server; Node is a development/build dependency, not a second production server. The embedded Receiver is a separate BrowSDR build served by the same Python server at `/receiver/`.

## Build

Use a supported Node LTS satisfying Vite's engine requirement (Node 22.12 or newer within Node 22 is suitable) and a project `.venv` with Python 3.9 or newer.

```sh
git submodule update --init --recursive   # once, for the Receiver
cd frontend
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run build:all
cd ..
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_ground_console_static
```

`npm run build:all` runs `npm run build` and then `tools/build_browsdr_receiver.py` (through `frontend/scripts/build-receiver.mjs`, which uses the `.venv` Python when present). `npm run build` alone empties `frontend/dist`, including `frontend/dist/receiver`; without the submodule it is the frontend-only build, and `/receiver/` then shows a page explaining how to build the Receiver. The builder resolves `npm` through `PATH`, so it also finds `npm.cmd` on Windows.

`frontend/dist` and `node_modules` are generated and ignored by Git. Keep the package lock in version control. The static regression suite skips its build-dependent checks when `dist/index.html` is absent; such a run is not full acceptance. It fails its Receiver checks when `dist` exists and `vendor/BrowSDR` is checked out but `dist/receiver` is missing.

Plotly is bundled as a partial build (`plotly.js/lib/core` plus `lib/scatterpolar`, registered in `src/lib/plotlyPolar.ts`). If `plotly.js` is upgraded, check that both entry points still exist and that the Vite plugin in `vite.config.ts` still drops Plotly's MapLibre stylesheet.

## Runtime

After building, run from the repository root with the project `.venv`:

```sh
.venv/bin/python tools/ground_console.py --bind 127.0.0.1 --port 8787
```

The default MQTT monitor target is `10.90.0.1:9001` over WebSocket. Install `paho-mqtt==2.1.0` into `.venv` for the monitor; without it the console still starts and reports the monitor as ERROR. Add `--mqtt-host ''` to run without a monitor. Explicit `--base-url` and `--mqtt-*` flags override the saved `console.json` for that run. Runtime serves `frontend/dist` with same-origin APIs. Never expose the console or development server on a non-loopback address.

## Rollback

```sh
.venv/bin/python tools/ground_console.py --legacy-ui --bind 127.0.0.1 --port 8787
```

This selects the previous embedded interface without reverting source or changing saved configuration. Stop only the local console process being replaced; do not restart any remote service.

## Navigation

Seven routes, reachable with keys `1`–`7` (`R` refreshes):

- Overview: readout, map and polar plot.
- System Health: summary, Data Out HTTP per-resource reads, inspector, node progress, subsystem status.
- DoA Diagnostics: delivery gate checks, native-record detection log, frame relation, snapshot-derived operator log, effective config.
- Configuration: local connection (Data Out, MQTT host/port/transport/WebSocket path, refresh interval), admin/branding, dry-run preview, GPS and Compass source.
- Message Monitor: read-only sdr/v1 subscriber state and messages, plus the RDF Node v2 panel.
- Simulation: browser-only synthetic Overview data.
- Receiver: embedded BrowSDR; stays mounted after its first visit.

The detection log is not target tracking and the snapshot-derived log is not a durable historical event archive.

## Credentials

Create the real root `.env` manually from `.env.example` if needed. Never commit it. `SDR_DOA_ADMIN_PASSWORD` is Python-only and must never be renamed to a `VITE_` variable or embedded into a frontend build. Process environment retains precedence. Password changes require a local Python process restart; the frontend does not read `.env` contents. Without the variable, admin login is disabled (HTTP 503 `ADMIN_DISABLED`).

## Map boundary

MapLibre GL JS renders a 2D slippy-map viewport, not measured terrain/buildings. It needs WebGL2; without it, after a WebGL context loss, or when its worker fails, the map shows a notice and draws a simplified canvas overlay. The map loads only the OpenStreetMap tiles needed for the visible viewport, supports drag-pan, wheel/button zoom, a station marker, and a center-on-station action. It does not prefetch or bulk-download the world, infer target/range/track data, or fabricate coordinates.

GPS source selection is explicit: fresh valid Data Out coordinates are preferred when Data Out is selected; MANUAL uses the locally validated input; FALLBACK uses the approved station coordinate and is labelled as fallback. During a freshness gap the last live Data Out position is kept and labelled stale. Invalid, stale, conflicting, disabled, unknown, or zero/zero live coordinates never become a fake fix. OSM attribution remains visible while the online layer is active.

Tile requests use HTTPS and one host at a time: `tile.openstreetmap.de` first, then `tile.openstreetmap.org` after 4 consecutive tile errors or a silent host. MapLibre spreads a multi-URL `tiles` array across hosts by tile index without retrying, so both hosts are never configured together. When every host has failed, a BASEMAP UNAVAILABLE chip appears and the overlay is still drawn. The CSP `img-src` and `connect-src` allow both hosts. Tiles use ordinary browser cache semantics.

## Validation and release

Run frontend typecheck/build/tests, Python baseline tests (including the standalone `tools/test_*.py` scripts for changed modules), static security tests, `node --test tools/test_receiver_*.mjs` when Receiver code changed, actual browser route/resize/freshness checks and an independent exact-candidate review. Hash untracked source and build assets as well as tracked diffs. A build or test failure is not an accepted migration. Commit/push requires a current review and authorization; no remote writes are part of ordinary UI development.
