# Repository Guidelines

## Project Overview

This repository is a local, loopback-only Ground Console for SDR-DoA observation. It reads bounded Data Out resources, validates health and freshness, keeps native CSV/XML candidates separate, exposes publication-gate reasons, and renders the result in a React UI. The UI also provides a browser-only DoA simulation, local branding/configuration, renderer-only GPS/Compass choices, and an optional subscriber-only MQTT monitor.

This is not a production target tracker, RF range estimator, or remote-control console by default. Map overlays are direction helpers, not transmitter locations or distance measurements. The normal Ground Console settings form is local or dry-run. Read `initialize.md` first; active code and tests override historical documentation. There is no `README.md`.

## Architecture & Data Flow

```text
SDR-DoA Data Out
    -> tools/sdr_doa_collector.py
       bounded GET, schema parsing, redaction, freshness and consistency gates
    -> tools/ground_console.py
       loopback HTTP APIs and frontend/dist static serving
    -> frontend/src/App.tsx
       snapshot/config/MQTT state, local freshness, route and simulation orchestration
    -> page components
       Overview map + polar plot, health, diagnostics, configuration, monitor, simulation
```

- The collector reads `/status.json`, `/settings.json`, `/DOA_value.html`, and `/doa.xml` only. It enforces host/path, timeout, response-size, numeric, retry, freshness, and native-consistency rules. Display readiness and publication readiness are separate.
- `ground_console.py` is the Python boundary. API routes take precedence over static files, the server refuses non-loopback binds, and the active UI is the built React app. `--legacy-ui` selects the embedded previous interface.
- `App.tsx` owns lifted application state and the language context. `Shell.tsx` provides hash-based routes, the navigation rail/drawer, the runtime status strip, and keyboard shortcuts (1–6 pages, R refresh). Non-Overview pages, `TacticalMap` (MapLibre), and Plotly are lazy chunks. `api.ts` uses same-origin requests with timeout, abort, response normalization, and config/branding read-back verification.
- `OverviewPage` is memoized so the 500 ms freshness tick in `App.tsx` does not re-render the map or plot. It composes `DoaReadout` (canonical bearing and display peak side by side, age, gate, position), `TacticalMap`, and `PolarPanel`. `TacticalMap` owns one MapLibre instance, OSM raster tiles, station marker/popup, GeoJSON overlay layers (beam or density heat, lobe, bearing, −3 dB edges, range rings, guides), DOM text labels, a hover/tap readout, `OverlayControls`, and `OverlayLegend`. Geometry rebuilds are debounced and only touch changed sources; palette, opacity, intensity, and blur are paint-only. MapLibre's worker is bundled by Vite and registered with `setWorkerUrl`; without it, GeoJSON layers never render. The style counts as ready on `styledata` because `load` waits for OSM tiles and may never fire offline. The canvas fallback draws only when MapLibre reports a non-tile error. `PolarPlot` is the active local Plotly renderer and preserves operator interaction while data updates.
- `doaGeometry.ts` generates geodesic bearing, lobe, guide, beam-sector, density-heat, range-ring, and −3 dB edge features, plus the −3 dB width and bearing/distance helpers. `overlayPalette.ts` holds the shared palette stops and MapLibre paint expressions. Signed dB normalization and projection distances are visual parameters, not physical RF conversions.
- `simulation.ts` creates a finite synthetic 360-bin snapshot with publication `BLOCKED` and no authority. `App.tsx` applies it only to Overview; health, diagnostics, runtime, and MQTT remain live.
- The Receiver page (`ReceiverPage.tsx`) embeds a BrowSDR build at `/receiver/` in an iframe and passes the console theme to it. `tools/build_browsdr_receiver.py` copies the pinned `vendor/BrowSDR` submodule, overlays `tools/browsdr_receiver_overlay/src/client/**`, applies exact-string patches that fail when their target text is missing, appends `frontend/src/receiver-embedded-theme.css`, and writes `frontend/dist/receiver`. Run it after `npm run build`, which clears `dist`. When a file already exists in the overlay, edit it there rather than adding a builder patch. `vite build` does not typecheck that tree. Spectrum marker math lives in `app/marker-readout.ts`, tested by `node --test tools/test_receiver_markers.mjs`.
- The staging telemetry path is separate: `sdr_doa_lan_agent.py` composes collector gates, safe MQTT contract messages, bounded latest-value queues, and the stdlib MQTT client. `sdr_doa_mqtt_monitor.py` is display-only and subscriber-only.

## Key Directories

- `frontend/src/`: React/TypeScript application.
  - `components/`: shell, shared UI primitives, map, polar panels, and active renderers.
  - `pages/`: Overview, System Health, DoA Diagnostics, Configuration, Message Monitor, and Simulation.
  - `lib/`: API-independent contracts and pure helpers for telemetry, GPS/map, polar angles, geometry, overlay settings, and simulation.
- `frontend/dist/`: generated production assets served by Python. Do not edit it as source.
- `tools/`: Python Ground Console, collector, edge/MQTT staging code, operational scripts, tests, and fixtures.
- `tools/fixtures/`: valid, stale, unhealthy, malformed, nonfinite, missing-status, conflict, and partial Data Out cases.
- `deploy/`: example-only rollout/service material. Treat as plan, not an enabled deployment.

## Development Commands

Install and validate the frontend from `frontend/`:

```sh
cd frontend
npm ci --ignore-scripts --no-audit --no-fund
npm run check       # TypeScript build/typecheck, not lint
npm test            # Vitest run
npm run build       # tsc -b && vite build; writes frontend/dist
npm run dev         # Vite development server on 127.0.0.1
npm run preview     # Vite preview on 127.0.0.1
```

Run the production UI through the Python server from the repository root:

```sh
.venv/bin/python tools/ground_console.py --bind 127.0.0.1 --port 8787
# legacy embedded UI, when specifically needed
.venv/bin/python tools/ground_console.py --legacy-ui --bind 127.0.0.1 --port 8787
```

The default URL is `http://127.0.0.1:8787/`. Vite alone does not provide the `/api` backend. Never expose the Ground Console or Vite server on a non-loopback address.

Useful backend checks:

```sh
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest discover -s tools -p 'test_*.py'
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_ground_console_static
python3 tools/test_sdr_doa_collector.py
python3 tools/test_stage3.py
```

Most Python test files are standalone scripts with plain `assert` functions, so `unittest discover` does not execute every test. Run the named scripts when changing their modules. MQTT integration tests require a local staging broker on `127.0.0.1:18884`; use `tools/mqtt_stage4.conf` only for local staging. A synthetic publisher is available at `tools/synthetic_mqtt_publisher.py`.

## Code Conventions & Common Patterns

- TypeScript is strict. Normalize external values from `unknown`, then apply finite/range checks. Represent unavailable, stale, conflict, and error states explicitly instead of coercing bad data into valid-looking values.
- UI text lives in `lib/i18n.ts` with English and Indonesian dictionaries; read it through `useI18n()`. Add every key to both dictionaries (`i18n.test.ts` enforces key and placeholder parity). Status codes such as `STALE` or `BLOCKED` stay untranslated. The language choice is stored in `localStorage` under `sdr-console-lang`.
- Use pure helpers for contracts and transformations. Keep API validation in `api.ts`, telemetry readiness/gate logic in `lib/telemetry.ts`, GPS selection in `lib/map.ts`, angle conversion in `lib/polar.ts`, and GeoJSON math in `lib/doaGeometry.ts`.
- React state is lifted into `App.tsx` and passed through callback props. Effects must clean up timers, abort controllers, observers, MapLibre resources, Plotly instances, and listeners because the app mounts under `StrictMode`.
- Preserve latest-request-wins behavior and local freshness expiry. Do not recreate map/plot layout or camera state for ordinary data updates. Use `localStorage` only for local theme/visual preferences, with validation on restore.
- Components use `PascalCase`; functions, variables, and hooks use `camelCase`; constants use `UPPER_SNAKE_CASE`; Python modules/functions use `snake_case`; Python tests use `test_*` entry points.
- Python paths are intentionally bounded and defensive: allowlisted URLs, no redirects, finite timeouts, body limits, redaction, atomic local writes, and explicit loopback checks. MQTT payloads are schema-validated, size-bounded, and latest-value-wins per stream.
- Keep live, fixture, and synthetic data separate. Simulation must remain visibly labeled `SIMULATION` and must not affect health, diagnostics, MQTT, publication authority, or Raspberry state.
- Preserve the freshness gate, publication gate, redaction, CSP, timeout/abort handling, subscriber-only monitor, and dry-run boundary. Do not add a remote write path or expose secrets to `VITE_*` or browser state.
- Styles load in `main.tsx` as `styles.css`, then `console-design.css`, then `polar-layout.css`. Later files override earlier declarations. Check responsive and reduced-motion behavior when changing UI.

## Important Files

- `initialize.md`: current repository entrypoint and safety rules.
- `SDR_DOA_FRONTEND_WORKFLOW.md`: install, build, runtime, credential, and release workflow.
- `QUICKSTART.md`: cross-platform install, build, run, simulation, and troubleshooting guide.
- `frontend/package.json`, `frontend/package-lock.json`: npm scripts and locked dependency graph.
- `frontend/src/main.tsx`, `frontend/src/App.tsx`: browser entry and application orchestration.
- `frontend/src/api.ts`, `frontend/src/types.ts`: same-origin API adapter and shared data contracts.
- `frontend/src/components/Shell.tsx`: hash routes, navigation, theme, runtime/status chrome.
- `frontend/src/components/TacticalMap.tsx`, `PolarPlot.tsx`: active map and polar renderers.
- `frontend/src/lib/telemetry.ts`, `map.ts`, `polar.ts`, `doaGeometry.ts`, `mapOverlaySettings.ts`, `simulation.ts`: readiness, source resolution, angle/display rules, overlay geometry/settings, and synthetic data.
- `frontend/src/lib/i18n.ts`: EN/ID dictionaries, gate reason translations, and the language context.
- `tools/ground_console.py`: loopback server, local APIs, static serving, CSP, local config and branding.
- `tools/sdr_doa_collector.py`: bounded read-only Data Out collector and publication gate input.
- `tools/sdr_doa_lan_agent.py`, `sdr_doa_mqtt.py`, `sdr_doa_mqtt_stdlib.py`, `sdr_doa_mqtt_monitor.py`: staging edge agent, contract, transport, and monitor.
- `tools/test_*.py`, `tools/test_stage3.py`, and `frontend/src/**/*.test.*`: executable contract and policy coverage.
- `.env.example`: local-only `SDR_DOA_ADMIN_PASSWORD`; real `.env` is ignored and must not be committed.
- `MAPLIBRE_DOA_OVERLAY_PLAN.md` and `evaluasi GUI.md`: recent overlay/UI decisions and known validation limits. Treat older Leaflet or network/deployment notes as historical unless active code confirms them.

## Runtime/Tooling Preferences

- Use npm from `frontend/` with the committed lockfile. Project docs recommend Node 22.12+ within a supported Node 22 LTS; Vite/plugin engine ranges also accept newer supported Node versions. No root package manager, `.nvmrc`, or npm version is pinned.
- Use the project `.venv` for Python commands. The Python tools are mostly standard-library code. `paho-mqtt==2.1.0` is needed only for the paho-based MQTT monitor, synthetic publisher, and related tests.
- There is no Python dependency manifest, formatter, linter, CI workflow, Docker/Compose setup, or coverage configuration. `npm run check` is the defined static check; there is no `npm run lint`.
- Build `frontend/dist` before full static-serving QA. The static regression suite skips build-dependent checks when `frontend/dist/index.html` is absent.
- Keep credentials in the process environment or ignored root `.env`. `SDR_DOA_ADMIN_PASSWORD` is Python-only; never rename it to a `VITE_` variable or embed it in the frontend bundle.
- Local console defaults are loopback bind `127.0.0.1`, port `8787`, and Data Out `http://doasdr.local:8081`. MQTT monitor hosts must remain loopback in the Ground Console. Staging broker files are not production security configurations.

## Testing & QA

- Frontend tests use Vitest and currently focus on pure/helper contracts: DoA geometry, simulation invariants, GPS/Compass and freshness gates, branding normalization, and polar range/uirevision behavior. There are no React rendering, browser automation, screenshot, or visual-regression tests, and no coverage threshold.
- Python coverage is policy-focused and uses standard-library scripts. Tests cover parser/schema/redaction/freshness gates, fixture states, Ground Console HTTP/static security, loopback binding, MQTT contract and queue behavior, edge-agent publication/config gates, and local config apply safety.
- Prefer injected fetchers, in-memory payloads, temporary directories, loopback HTTP servers, and fake monitors. Reuse the relevant fixture family instead of contacting Raspberry hardware.
- For UI changes, run the frontend checks and build, serve the production bundle through `ground_console.py`, then exercise the affected route and state. Check no-data, stale, error, simulation ON/OFF, data updates, theme, responsive widths, keyboard focus, CSP/network behavior, and reduced motion when relevant.
- Browser and hardware/live MQTT checks are documented practices, not checked-in automated targets. Do not treat historical test counts in `evaluasi GUI.md` or stage reports as current acceptance evidence. No live Raspberry, RF/T900, or production MQTT end-to-end path is established by this repository.

<!-- antislop:start -->
## antislop
For UI, copy, people, mobile layout, or code comments work, read `antislop.md` (core) and then the skill for the task:
- UI / visual: `skills/antislop-ui/SKILL.md`
- Copy & text: `skills/antislop-copywriting/SKILL.md`
- People: `skills/antislop-human/SKILL.md`
- Mobile / responsive: `skills/antislop-layoutmobile/SKILL.md`
- Code comments: `skills/antislop-code/SKILL.md`
Before starting, ask the user when antislop applies: during the work, or after it is done.
<!-- antislop:end -->
