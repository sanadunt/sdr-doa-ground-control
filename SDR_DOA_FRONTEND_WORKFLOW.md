# SDR-DoA frontend workflow

## Architecture

React + TypeScript + Vite compile the browser application. Python retains the collector, API, local admin/branding, local configuration/dry-run and subscriber-only MQTT monitor. Production uses only the loopback Python HTTP server; Node is a development/build dependency, not a second production server.

## Build

Use a supported Node LTS satisfying Vite's engine requirement (Node 22.12 or newer within Node 22 is suitable).

```sh
cd frontend
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run build
cd ..
python3 tools/test_ground_console_static.py
```

`frontend/dist` and `node_modules` are generated and ignored by Git. Keep the package lock in version control. The static regression suite explicitly skips its build-dependent checks when `dist/index.html` is absent; such a run is not full acceptance.

## Runtime

After building, run the existing command from the repository root:

```sh
python3 tools/ground_console.py --bind 127.0.0.1 --port 8787
```

Existing configuration paths and optional CLI flags remain supported. Runtime serves `frontend/dist` with same-origin APIs. Never expose the console or development server on a non-loopback address.

## Rollback

```sh
python3 tools/ground_console.py --legacy-ui --bind 127.0.0.1 --port 8787
```

This selects the previous embedded interface without reverting source or changing saved configuration. Stop only the local console process being replaced; do not restart any remote service.

## Navigation

- Overview: Map and Polar only, side-by-side 60/40 on wide screens.
- System Health: System Summary, Inspector, Node Inspector, Subsystem Status.
- DoA Diagnostics: Delivery Gate, latest native-record Detection Ledger, snapshot-derived Operator Log, Effective Config.
- Configuration: local connection, admin/branding, dry-run preview.
- Message Monitor: read-only subscriber state and messages.

The ledger is not target tracking and the snapshot-derived log is not a durable historical event archive.

## Credentials

Create the real root `.env` manually from `.env.example` if needed. Never commit it. `SDR_DOA_ADMIN_PASSWORD` is Python-only and must never be renamed to a `VITE_` variable or embedded into a frontend build. Process environment retains precedence. Password changes require a local Python process restart; the frontend does not read `.env` contents.

## Map boundary

Leaflet renders a 2D slippy-map viewport, not measured terrain/buildings. The Overview keeps Map about 60% and Polar about 40% on wide screens. The map loads only the OpenStreetMap tiles needed for the visible viewport, supports drag-pan, wheel/button zoom, a station marker, and a center-on-station action. It does not prefetch or bulk-download the world, infer target/range/track data, or fabricate coordinates.

GPS source selection is explicit: fresh valid Data Out coordinates are preferred when Data Out is selected; MANUAL uses the locally validated input; FALLBACK uses the approved station coordinate and is labelled as fallback. Invalid, stale, conflicting, disabled, unknown, or zero/zero live coordinates never become a fake fix. OSM attribution remains visible while the online layer is active. Tile requests use HTTPS, the allowlisted `tile.openstreetmap.org` template, ordinary browser cache semantics, and the existing static-server CSP.

## Validation and release

Run frontend typecheck/build/tests, Python baseline tests, static security tests, actual browser route/resize/freshness checks and an independent exact-candidate review. Hash untracked source and build assets as well as tracked diffs. A build or test failure is not an accepted migration. Commit/push requires a current review and authorization; no remote writes are part of ordinary UI development.
