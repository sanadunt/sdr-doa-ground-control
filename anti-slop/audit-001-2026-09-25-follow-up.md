# Anti-Slop Audit 001: Follow-up

Date: 2026-09-25  
Status: A-001 through A-004 remediated after user approval.

## Changes

- **A-001 — Center/Zoom out collision:** moved Center below the MapLibre zoom/compass stack. At 320 px, the vertical overlap is 0 px and a hit test at Zoom out resolves to `.maplibregl-ctrl-zoom-out`.
- **A-002 — Settings/HUD collision:** moved overlay settings into the map workspace as a sibling of the map canvas and moved coordinates/legend below the canvas. On desktop, expanded settings sit beside the map; at mobile widths, settings, map, and HUD stack in document flow. At 320 px, settings-to-map intersection is 0; the settings panel scrolls internally so the Reset action remains reachable.
- **A-003 — Mobile hierarchy:** removed the mobile-only polar-first order. At 390 px, the map panel begins at document y=499 and the polar panel at y=1,280. The mobile top bar hides its duplicate route title while retaining the status badges and read strip; measured top-bar height is 119 px.
- **A-004 — Route heading focus:** retained programmatic focus on the route `h1` but replaced its control-like amber rectangle with an amber underline.

Changed application files: `frontend/src/components/TacticalMap.tsx` and `frontend/src/console-design.css`.

## Verification

- `npm run check` — passed.
- `npm test` — passed: 5 files, 72 tests.
- `npm run build` — passed. Vite still reports the existing large-chunk advisory for the app and Plotly bundles; it did not fail the build.
- Exercised the production UI through the local Ground Console at `http://127.0.0.1:8787/` in Chromium. Overview document width matched viewport at 320, 390, 620, 621, 768, 980, 981, 1366, and 1920 px. All six navigation routes were opened at 320 px; each retained its page heading with no horizontal document overflow.
- At 320 px, the closed map has 0 px Center/Zoom out overlap, Zoom out remains the hit-test target, the HUD is outside the map frame, and the map precedes the plot. With settings open, the panel is 286 × 460 px, the map starts 10 px below it, and the two boxes do not intersect; its internal scroll range is 1,059 px.
- At 1366 px, expanded settings reflow beside the map rather than covering it. The map frame and HUD are separate siblings, with an 8 px flow gap in the measured viewport.

Screenshots: `/tmp/doa-overview-fixed-desktop.png`, `/tmp/doa-overview-fixed-mobile.png`, `/tmp/doa-map-settings-fixed-desktop.png`, `/tmp/doa-map-settings-fixed-mobile.png`, and `/tmp/doa-map-settings-fixed-320.png`.

## Limits

The browser showed no fresh Data Out snapshot; DATA was loading, DoA unavailable, delivery blocked, and the map used its fallback station coordinate. These checks verify layout and interaction geometry only—not live telemetry, RF behavior, or hardware. Viewports were emulated in Chromium, not tested on physical devices.
