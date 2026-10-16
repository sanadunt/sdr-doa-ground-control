# SDR-DoA frontend workflow

## Architecture

React + TypeScript + Vite compile the browser application. Python retains the collector, API, local admin/branding, local configuration/dry-run, the MQTT monitor, the admin-gated config-patch publish, and the Receiver record store. The monitor subscribes and never publishes on its own; its one publish is a config patch that an admin reviews and confirms in Kontrol on the Dashboard. The browser never talks to MQTT. Production uses only the loopback Python HTTP server; Node is a development/build dependency, not a second production server. The embedded Receiver is a separate BrowSDR build served by the same Python server at `/receiver/`.

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

After a `git pull`, rebuild before running the console, then restart it; a stale `frontend/dist` serves the previous UI:

```sh
cd frontend && npm ci && npm run build:all
```

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

Seven routes, in menu order, reachable from the page menu in the top bar or with keys `1`–`7` by that order (`R` refreshes). Every route has the same top bar: page menu, status strip, refresh button and refresh-interval select. The pages other than the Dashboard and the Receiver share the page kit (`frontend/src/components/page/`, styled by `frontend/src/page-kit.css`): a page bar with key state chips and actions, then a 12-column grid of compact cards.

- Dashboard (`#/dashboard`, route id `overview`; `#/overview` still opens it): full-map dashboard with the bearing HUD, node card, Lapisan (map layers), Kontrol (admin-gated config patch, "Send to RDF-SDR"/"Kirim ke RDF-SDR"), and a bottom dock with Polar (and its Atur settings) and Spektrum (the Receiver's RX spectrum or, in Spektrum mode, its wide scan, Listen, click-to-tune, and its Atur column with the RX dB scale shared with the Receiver's Dengar tab and the Listener's sample rate, LNA, VGA and +14 dB amp, or in Spektrum mode the scan's Graph min./max., range, resolution and gains, synced both ways; and a Penanda marking mode that adds and removes markers in the Receiver's Penanda spektrum list, which the dock, the Receiver's Spektrum canvas and its Dengar trace all draw). Its panel toggles sit in the top bar. The UI names the Raspberry node RDF-SDR and the HackRF receiver RadioSpectrum, and shows labels, values, state chips, errors and action prompts without one-line help texts.
- Receiver (key `2`): embedded BrowSDR; mounts on its first visit or the first Mulai/Dengar in the Dashboard spectrum dock, then stays mounted.
- System Health: summary, Data Out HTTP per-resource reads, inspector, node progress, subsystem status.
- DoA Diagnostics: delivery gate checks, native-record detection log, frame relation, snapshot-derived operator log, effective config.
- Configuration: local connection (Data Out, MQTT host/port/transport/WebSocket path, refresh interval), admin/branding, dry-run preview (never sent), GPS and Compass source.
- Message Monitor: read-only sdr/v1 subscriber state and messages, plus the RDF Node v2 panel.
- Simulation: browser-only synthetic Dashboard data.

The detection log is not target tracking and the snapshot-derived log is not a durable historical event archive.

## Credentials

Create the real root `.env` manually from `.env.example` and replace the placeholder password. Never commit it. `SDR_DOA_ADMIN_PASSWORD` is Python-only and must never be renamed to a `VITE_` variable or embedded into a frontend build. Process environment retains precedence. Password changes require a local Python process restart; the frontend does not read `.env` contents. When the variable is absent from both the environment and `.env`, the default password `123456` applies: the console prints a startup warning, capabilities report `admin_default_password: true`, and Kontrol shows a warning. Set a real password before using Kontrol on a shared computer. An explicitly empty value (`SDR_DOA_ADMIN_PASSWORD=`) disables admin login (HTTP 503 `ADMIN_DISABLED`); so does a `.env` that exists but cannot be read or decoded. After 5 failed logins within 60 s, every login gets HTTP 429 `ADMIN_LOGIN_THROTTLED` for 30 s. The admin session unlocks branding and Kontrol.

## Map boundary

MapLibre GL JS renders a 2D slippy-map viewport, not measured terrain/buildings. It needs WebGL2; without it, after a WebGL context loss, or when its worker fails, the map shows a notice and draws a simplified canvas overlay. The map loads only the basemap tiles needed for the visible viewport, supports drag-pan, wheel/button zoom, a station marker, and a center-on-station action. It does not prefetch or bulk-download the world, infer target/range/track data, or fabricate coordinates.

GPS source selection is explicit: fresh valid Data Out coordinates are preferred when Data Out is selected; MANUAL uses the locally validated input; FALLBACK uses the approved station coordinate and is labelled as fallback. During a freshness gap the last live Data Out position is kept and labelled stale. Invalid, stale, conflicting, disabled, unknown, or zero/zero live coordinates never become a fake fix. The attribution chip names the data and imagery sources of the drawn basemap style (licence requirement) while its tiles can draw; the style picker itself shows style names only.

Basemap styles (`frontend/src/lib/basemaps.ts`: Standard, Hot, Light, Dark, Satellite, Satellite + labels, Topographic, Plain) all draw from the console's same-origin route `/api/tiles/<source>/<z>/<x>/<y>`, so the browser never contacts a tile provider and the CSP `img-src` and `connect-src` list no tile host. Light and Dark repaint the Standard tiles with MapLibre raster paint. `tools/tile_cache.py` holds the fixed upstreams (HTTPS only, at most two hosts per source tried one at a time, OSM `tile.openstreetmap.de` before `tile.openstreetmap.org`, no redirects, 5 s timeout, 1 MiB cap, PNG/JPEG/WebP only) and a disk cache under `--tile-cache-dir` (`--tile-cache-max-mb`, default 512, least recently used first). A cached tile is fresh for max(upstream max-age, 7 days), capped at 30 days; a stale one is served when the upstream cannot be reached, and an uncached one answers 504. A failing host backs off for 30 s. There is no prefetch or bulk download. When the tiles of the selected style fail and none has drawn, a BASEMAP UNAVAILABLE · <style> chip appears; when they keep failing while others draw (offline with part of the view cached), a BASEMAP PARTIAL · <style> chip appears. The overlay is still drawn, and the style retries every 60 s. Outbound fetches use the standard environment proxy.

## Validation and release

Run frontend typecheck/build/tests, Python baseline tests (including the standalone `tools/test_*.py` scripts for changed modules), static security tests, `node --test tools/test_receiver_*.mjs` when Receiver code changed, actual browser route/resize/freshness checks and an independent exact-candidate review. Hash untracked source and build assets as well as tracked diffs. A build or test failure is not an accepted migration. Commit/push requires a current review and authorization. Apart from exercising Kontrol against a local staging broker (`tools/mqtt_stage4.conf`), no remote writes are part of ordinary UI development.
