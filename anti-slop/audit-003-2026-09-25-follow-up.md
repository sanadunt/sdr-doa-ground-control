# Anti-Slop Audit 003: Polar Status and Brand Title

Date: 2026-09-25  
Mode: post-change review, per user preference.  
Status: Polar status, collapsible controls, and configurable browser title implemented and validated.

## Changes

- Replaced the `POLAR UNAVAILABLE` overlay with a compact status above the graph. `AVAILABLE` is green only when the local 360-bin vector is fresh; other states remain `WAITING`, `STALE`, or `NOT READY` and do not imply usable data.
- Moved Head Up, Min dB, and Max dB controls after the plot and caption into a native `<details>` disclosure. The collapsed-state rule explicitly hides form content because the author `display:flex` rule otherwise overrides the browser disclosure style. Enter opens and closes the settings.
- Bound `document.title` to the configured `branding.app_name`. The Brand workspace now says that saving App name also changes the browser-tab title. Frontend fallback branding now matches the existing Python and HTML default, `SDR-DoA Ground Console`.

## Verification

- `npm run check` — passed.
- `npm test` — passed: 5 files, 72 tests.
- `npm run build` — passed. Vite emitted its existing non-failing large-chunk advisory for the application and Plotly bundles.
- Exercised the production UI at `http://127.0.0.1:8787/` in Chromium. With live Data Out unavailable, Overview showed `WAITING`, the settings disclosure was closed, and `POLAR UNAVAILABLE` was absent. With the browser-only simulation enabled, the polar graph rendered a curve and showed green `AVAILABLE`; simulation was then disabled and the browser returned to Overview.
- Opened and closed Graph settings with Enter. When open, the form was below the graph; when closed, its form had no rendered boxes. At 390 × 844 and 320 × 568, document width matched viewport width. At 320 px, all three inputs and both actions fit without horizontal overflow.
- On the main server, `document.title` matched the actual `/api/branding` `app_name` (`SDR-DoA Ground Console`). A separate loopback QA server loaded an isolated persisted branding fixture (`QA Custom Ground Title`); the rendered document title matched that value and the Brand helper text appeared. The QA server and fixture were removed afterward.
- `agent-browser errors` returned no output. No persistent branding value was changed.

Screenshots: `/tmp/ground-polar-available-desktop.png`, `/tmp/ground-polar-settings-desktop.png`, `/tmp/ground-polar-mobile-390.png`, and `/tmp/ground-polar-settings-320.png`.

## Limits

The production Data Out snapshot remained unavailable, so the green `AVAILABLE` state was verified with the labeled browser simulation, not live SDR data. The production Brand workspace was `LOCKED`; the authenticated save was not exercised, and no admin credential was used. The separate QA server verified that a persisted configured name drives the browser title on load, not the privileged write path.
