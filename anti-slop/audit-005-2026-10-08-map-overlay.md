# Anti-Slop Audit 005: DoA Map Overlay Indicators and Render Path

Date: 2026-10-08  
Mode: post-change review, per user preference from audit 004.  
Status: Implemented and validated. `antislop.md` and `skills/antislop-*` are still absent; this follows the format of audits 001–004.

## Root cause found during the work

The MapLibre GeoJSON layers (heat, lobe, bearing, guides, station circle) were not rendering in the production bundle. MapLibre 6 builds its worker URL as `new URL('./maplibre-gl-worker.mjs', import.meta.url)`. After Vite bundling that resolves to `/assets/maplibre-gl-worker.mjs`, which is never emitted. The server log showed that request returning 404, and those console 404s had been filtered as tile errors during earlier QA. Without the worker no GeoJSON source is parsed. Everything the operator saw on the map came from the canvas "fallback", which redrew every layer, including about 2,880 radial gradients for heat, on every pan and zoom frame. That produced both the blurry blue disc and the main-thread cost.

Fix: `TacticalMap.tsx` imports `maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url` and calls `maplibregl.setWorkerUrl()`, and `vite.config.ts` builds workers as ES modules. The worker is a same-origin file, so the CSP is unchanged and no `worker-src blob:` was added.

A second issue appeared once the worker loaded: the map `load` event waits for every source, including OSM raster tiles, so it never fired while tiles were failing or retrying. The overlay now treats the style as ready on the first `styledata` event in which its GeoJSON sources exist. This also matters for field use without internet.

## Changes

- **Beam heat style (new default).** One annular sector per degree and radial band, coloured by normalized dB weight through the selected palette. Opacity is `heatOpacity × radial falloff × min(1, weight × intensity)`. Palette, opacity, and intensity are MapLibre paint expressions, so their sliders no longer rebuild geometry. The previous point heatmap is kept as **Density**. It now prunes samples below 3 % visual weight, scales density weight with distance so samples where rays converge at the station do not pool, uses `heatIntensity` (previously ignored by the GL layer), and scales its blur radius with zoom so the shape holds while zooming.
- **Indicators.**
  - Range rings at rounded spacing (1/2/2.5/5 × 10ⁿ m) with ground-distance labels.
  - N/E/S/W labels (U/T/S/B in Indonesian).
  - A bearing value label at the end of the bearing line, with a white casing under the line for contrast on OSM.
  - −3 dB edge lines with the −3 dB width in the legend and station popup. The width is measured contiguously around the strongest bin, relative to the displayed spectrum, and is `n/a` when the whole circle is within 3 dB.
- **Hover or tap readout.** Shows the bearing bin, its shifted dB value, and the ground distance from the station within the overlay radius. It hides while dragging and when the pointer leaves the map.
- **Legend.** Shows the layer swatches, ring spacing, and −3 dB width. The colour bar uses the active palette with min/max dB labels and a threshold tick placed in weight space, so it stays correct when contrast is not 1. In Density mode the bar is labelled relative low/high, because density is not a dB scale.
- **Stale state.** When no fresh 360-bin vector is present, a chip says the overlay is cleared. Bearing, edges, and heat are removed. Rings and cardinal labels stay because they are a ground-distance reference, not DoA data. The station popup no longer reports a canonical bearing from a stale record.
- **Camera.** On the first fix and on Center, the camera frames the projection radius (padded clear of the toolbar and zoom controls) instead of using a fixed zoom with a 180 px offset, which pushed the overlay off small screens.
- **Render path.**
  - Geometry settings are debounced (120 ms).
  - `setData` runs only for sources whose collection changed.
  - Visibility and paint updates run separately from geometry.
  - The canvas fallback runs only after a non-tile MapLibre error, redraws once per animation frame, and draws guides, lobe, bearing, and station but not heat.
- **Settings panel.** Grouped into Layers, Heat, and Scale/geometry. Adds Heat style and Range rings. Heat blur is disabled with a "density only" note in Beam mode. Split out of `TacticalMap` into `OverlayControls.tsx`. The legend is in `OverlayLegend.tsx`, and palettes and expressions are in `lib/overlayPalette.ts`.

## Verification

- `npm run check`: passed.
- `npm test`: 6 files, 85 tests passed. New tests cover beam sector count, properties and closure, threshold and incomplete vectors, density pruning and distance compensation, ring spacing and placement, the −3 dB width including wrap-around and flat vectors, and bearing/distance against `destination()`.
- `npm run build`: passed. The bundle now includes `maplibre-gl-worker-*.js` (507 kB).
- `unittest discover -s tools`: OK. `test_stage3.py` 13 and `test_sdr_doa_security_regressions.py` 6 passed.
- Browser checks (Playwright + Chromium against `ground_console.py`, labelled simulation):
  - The worker request returns 200.
  - No CSP violations.
  - No page or console errors apart from `favicon.ico`.
  - Labels present: `250 m, 500 m, 750 m, 1 km, N, E, S, W, 45.0°`.
  - Hover on the beam read `Bearing 45° · -5.0 dB / 603 m from station`. Hover outside the radius showed no popup.
  - In Indonesian, an off-beam hover read `Bearing 239° · -50.0 dB / 552 m dari stasiun`.
  - With simulation off, the stale chip appeared and only ring and cardinal labels remained.
  - At 390 px, `scrollWidth` equalled the viewport with and without the settings panel open.
- Main-thread script time during a 3 s mouse pan, 3 runs each, measured with the CDP `ScriptDuration` metric:
  - Old build: 263–287 ms.
  - New build: 125–152 ms.
- Total task time stayed about 3 s in both, because this headless Chromium renders WebGL in software (SwiftShader). Under software GL, frame counts were similar: 55–73 frames per 3 s before and 54–62 after. The new build is also drawing GL layers that the old one silently skipped. Per-layer isolation under software GL: overlays off 112–133 frames, beam only 73–87, every layer on 54–58.

## Limits

- Frame-rate numbers come from software-rendered WebGL and do not predict a real GPU. No hardware GPU measurement was possible here.
- The canvas fallback path was not exercised, because a non-tile MapLibre error could not be produced in this environment.
- Live Data Out vectors were not available, so all overlay rendering was checked with the labelled simulation (a single Gaussian peak). Real spectra with several peaks will show more −3 dB variation; the width only describes the strongest peak.
- Stored overlay settings from before this change have no `heatStyle`, so they now open in Beam mode. Density remains one click away.
