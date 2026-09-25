# Anti-Slop Audit 002: Overview

Date: 2026-09-25  
Mode: post-change review, per user preference.  
Status: Overview simplification implemented and validated.

## Changes

- Removed the visible route breadcrumb/title, Data Out read strip, simulation banner, Overview facts, and redundant map/polar headings. Kept an accessible visually hidden Overview heading and route focus on the map.
- Kept DATA, DOA, DELIVERY, SNAPSHOT, MQTT, and SIMULATION indicators on desktop. At widths up to 620 px, the compact top row keeps SNAPSHOT, MQTT, and SIMULATION.
- Made the left navigation closed by default. The Menu button opens it; Escape closes it and restores focus. Selecting a route closes the menu.
- Kept the map before the polar plot on mobile. Reordered the narrow-screen plot so its visualization appears before the compact 44 px controls.
- Added explicit SIMULATION ON/OFF status. The simulation map remains labeled `SIMULATION`; the map’s direction-helper and non-target-location caveat remains visible.
- Removed the redundant “Station reference” popup heading and obsolete Overview/polar metadata styles.

## Verification

- `npm run check` — passed.
- `npm test` — passed: 5 files, 72 tests.
- `npm run build` — passed. Vite emitted its non-failing large-chunk advisory for the application and Plotly bundles.
- Exercised the production UI at `http://127.0.0.1:8787/` in Chromium. At 1366 × 768, the closed menu, compact status row, map, and graph fit the viewport; both panels measured 688 px high and document width matched the viewport.
- At 390 × 844, the map precedes the visible polar plot; only SNAPSHOT, MQTT, and SIMULATION appear in the status row. Document and body widths both matched 390 px.
- At 320 × 568, document/body width matched 320 px; no element extended beyond the viewport. Polar controls remained in one row with 44 px action buttons.
- Opened the navigation at 390 px: all six routes were visible in a two-column layout. Escape closed it and returned focus to Menu. Route selection also closed the menu.
- Toggled simulation OFF → ON → OFF through the Simulation route. Overview showed `SIMULATION · ON` with the synthetic curve and map label, while Snapshot and MQTT status stayed unchanged; after turning it off, the curve cleared and the badge returned to OFF.
- Opened map overlay settings at desktop width. Settings and map remained side-by-side, all controls were reachable by scrolling, and the Overview content expanded vertically instead of clipping the graph.
- Checked dark and light themes. `agent-browser errors` returned no output.

Screenshots: `/tmp/overview-final-production.png`, `/tmp/overview-final-mobile-390.png`, `/tmp/overview-final-mobile-320.png`, `/tmp/overview-settings-final.png`, `/tmp/overview-final-light.png`, and `/tmp/overview-final-simulation.png`.

## Limits

The local snapshot was still loading: DoA was unavailable and delivery was blocked. MQTT reported connected. These checks establish layout and interaction behavior only; they do not establish live telemetry, RF behavior, physical-device usability, or Raspberry hardware behavior. Viewports were emulated in Chromium.
