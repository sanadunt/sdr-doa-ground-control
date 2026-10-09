# Anti-Slop Audit 006: Receiver Spectrum Tab and Frequency Markers

Date: 2026-10-09  
Mode: reviewed while working, as the user requested for this task.  
Status: Implemented and validated. `antislop.md` and `skills/antislop-*` are still missing, so this audit follows the format of audits 001–005.

## Scope

This audit covers the **Spectrum** tab on the Receiver page: the BrowSDR build embedded at `/receiver/`. The source is the overlay in `tools/browsdr_receiver_overlay/src/client/**`, plus the patches and theme CSS that `tools/build_browsdr_receiver.py` applies on top of the pinned `vendor/BrowSDR`.

## Findings before the change

1. **Marker labels collided.** Each label was drawn as text at a fixed height next to its line. Two markers a few MHz apart printed over each other, and the text sat on the axis.
2. **Every marker was pink.** The line, label, and waterfall pin had no number, so a chart marker could not be matched to its row in the marker list.
3. **Marker values could not be read.** The only figure was the power when the marker was placed. The list had no current level, no frequency or level difference between markers, and no reference marker.
4. **Duplicate markers were easy to create.** Every click on the chart added a marker, including a click meant to select one that already existed.
5. **No quick placement.** A marker could not be put on the strongest signal or on a row of the peak table without typing its frequency in by hand.
6. **The toolbar was a flat row of 12 equal buttons.** Scan control, view, zoom, and file actions had no visual grouping. The hover readout appeared twice, once below the chart and once as a tooltip on the chart.
7. **There was an empty 60 px band at the top.** The Listener `top-bar` also rendered, empty, in the Spectrum tab.
8. **The light theme used an old palette.** It did not match the console. The Listen button text was pale on a white background.
9. **The canvas patches lived as string replacements in the builder.** About 150 lines of `_replace_once` in `build_browsdr_receiver.py` patched `sweep-canvas.ts` and the marker renderer, even though both files already exist in the overlay. A behaviour change needed edits in two places.

## Changes

- **Marker drawing** (`sweep-marker-renderer.ts`):
  - Each marker gets a number (M1, M2, …) and one of eight colours per theme, chosen by its position in the list.
  - Labels are chips placed in up to three lanes at the top of the plot using greedy assignment. A chip that does not fit any lane shrinks to its number, and a chip near the right edge flips to the left of its line.
  - A diamond shows the live trace level at each marker.
  - The selected marker is drawn last, with a solid line and its level in a box. The box is clamped inside the plot so it never hides behind the axis.
- **Pure helpers** (`marker-readout.ts`, new): colour, name, trace level at a frequency, peak in a range, nearest marker within a tolerance, readout rows with deltas, label lanes, and delta formatting (+/−/±, MHz/kHz/Hz). Covered by `tools/test_receiver_markers.mjs`.
- **Interaction** (`sweep.ts`, `records.ts`, `state.ts`):
  - A click within 8 px of an existing marker selects it instead of adding a new one.
  - Keyboard on the focused canvas: ←/→ move the selected marker by one bin, Shift multiplies the step by 10. Delete or Backspace removes the marker, Esc deselects. Saving is debounced by 400 ms, so holding an arrow key does not send a request per bin.
  - **Marker to peak** puts a marker on the strongest bin in the visible range, or selects the marker already there.
  - The **Mark** button on each peak-table row puts a marker at that peak's frequency.
  - A new marker is selected straight away. Selection and the reference are reset when the marker set changes or the marker is removed.
- **Marker table** (`index.html`): sits below the chart. Columns: number and REF badge, label, frequency, live level (following the active trace), level when placed, Δ frequency, and Δ level against REF. Row actions: Center (keeps the span, clamped to the scan range), Set REF, and Delete. Clicking a row selects its marker on the chart.
- **Layout**:
  - The toolbar is split into Scan, Spectrum/Waterfall, Zoom (− + Fit), Markers, and Session files groups. The files group sits at the right end with no divider, so no divider is left dangling when the toolbar wraps.
  - The duplicate hover readout is removed, keeping only the tooltip on the chart.
  - A single line of interaction hints sits below the chart.
  - The `top-bar` shows only in the Listener tab.
  - Waterfall pins use the same colour as their marker.
- **Theme** (`receiver-embedded-theme.css`): the light tokens follow the console palette (accent `#0a6f80`). The canvas follows the theme. The Listen and Mark buttons now read correctly in the light theme. At 760 px and below the dividers are removed and the files group goes back to the left.
- **Builder**: the `sweep-canvas.ts` and marker renderer patches are moved into the overlay files and removed from `build_browsdr_receiver.py` (−155 lines). The remaining patches still apply.

## Copy review

- Button labels are short verbs: Mark, Center, Set REF, Delete, Marker to peak. "Delete marker" became "Delete" because the row already identifies the marker.
- Column headers state the unit or reference: "Live level", "Level when placed", "Δ frequency", "Δ level". The table subtitle says which trace the live level follows and what the Δ is measured against.
- The chart hint lists the actual shortcuts and nothing else.
- No made-up claims: levels stay dBFS, with the units the existing UI already uses. Δ level is a difference between two points on the same trace, not an RF power measurement.

## Verification

- `node --test tools/test_receiver_markers.mjs tools/test_receiver_iq_spectrum.mjs`: 10 tests passed.
- The patched tree was generated and checked with `npx tsc --noEmit`. Only the 2 baseline errors remain (`HTMLSummaryElement` in `records.ts`, already present before this change). `vite build` does not typecheck, so this step is needed.
- `npm test`: 87 tests passed. `npm run check` and `npm run build` passed. `build_browsdr_receiver.py` built the Receiver.
- `unittest discover -s tools`: 63 tests OK. `git diff --check`: clean.
- Browser checks (Playwright + Chromium against `ground_console.py`, with the BrowSDR **Simulation** sweep source):
  - Clicking near M1 again kept 2 markers (it selected M1). Marker to peak gave 3, Mark gave 4.
  - Seven net steps with →→→ then Shift+← moved the marker from 261.873779 to 258.797607 MHz. The table and chart followed.
  - Set REF moved the badge, and Δ was recalculated. Delete brought the count from 4 to 3. Esc cleared the selection.
  - At 1440 px, the toolbar fits on one row and four markers do not overlap. In the waterfall, the pin colours match their markers.
  - The light theme was checked at 1440 px and the dark theme at 390 px. At 390 px the marker table scrolls horizontally inside its own panel.
  - No console errors except `favicon.ico`.

## Limits

- No HackRF was available. All checks used the Simulation source, which has only a few narrow peaks.
- The Receiver UI stays English only. BrowSDR has no i18n layer, and adding one is outside this change.
- The Spectrum/Listener/Records tabs keep their vertical labels. Changing them would also change the Listener layout.
- Marker colour follows list position, so deleting M2 renumbers and recolours the markers after it. This was chosen so the numbers stay contiguous and match the table.
- The peak history table can still scroll horizontally in a narrow iframe. That layout comes from upstream and was not changed.
