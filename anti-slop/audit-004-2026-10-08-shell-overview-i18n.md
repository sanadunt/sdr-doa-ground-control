# Anti-Slop Audit 004: Shell, Overview, Language Switch, and Bundle Split

Date: 2026-10-08  
Mode: post-change review, per user preference.  
Status: Implemented and validated. `antislop.md` and `skills/antislop-*` referenced by `AGENTS.md` are not in the repository; this review follows the format of audits 001–003.

## Changes

- **Navigation.** At 1024 px and wider the sidebar is now a persistent rail, so the operator no longer opens a menu to change pages. The rail collapses to icons and the choice is saved in `localStorage` (`sdr-console-rail`). Below 1024 px it is a drawer with a backdrop; Escape closes it and returns focus to the menu button.
- **Top bar.** Shows the current page name, how long ago the last read happened, a status strip (Data, DoA, Delivery, Snapshot, MQTT, Sim) in monospace with key and value on separate lines, an EN/ID switch, a theme icon button, and refresh. The strip scrolls horizontally on phones instead of hiding the first three statuses as before.
- **Keyboard.** Keys 1–6 switch pages and R refreshes. They are ignored while focus is in an input, select, textarea, or contenteditable element, or while a modifier key is held. `aria-keyshortcuts` is set on the nav items and the refresh button.
- **Overview readout.** A strip above the map shows the canonical bearing, display peak, age at read, delivery gate with the first block reason, and station position with its source. The canonical angle and the display peak are separate cells because they are not guaranteed to agree.
- **Map and polar panels.** The empty header rows are gone. Layers and Center are a toolbar inside the map. The polar panel has a single toolbar row with the availability badge, the status sentence, and Expand. Expand now widens the polar column (2:3) instead of stacking it over the map.
- **Language.** All UI text now comes from `lib/i18n.ts`, which has English and Indonesian dictionaries. Gate reasons have Indonesian labels. Status codes (`STALE`, `BLOCKED`, `AVAILABLE`) stay untranslated so they match the docs and the backend. `<html lang>` follows the choice. Local status messages on the Configuration page store message keys, so they follow a language switch; server errors are still shown as received.
- **Colour roles.** Cyan is used for interaction (active nav, primary buttons, focus). Amber is used for the DoA signal (polar curve, readout bearing, map lobe). Light theme tokens were reworked to match.
- **Bundle.** Non-Overview pages and `TacticalMap` (MapLibre) are lazy chunks, React is split into a vendor chunk, and `gsap` was removed (page entry is now a CSS animation that respects reduced motion). The entry chunk went from 1,396 kB (401 kB gzip) to 91 kB (28 kB gzip), plus a 192 kB (60 kB gzip) React chunk. MapLibre (1,059 kB) and Plotly (4,775 kB) still load when Overview mounts; Vite still prints its large-chunk advisory for those two lazy chunks.
- **Render path.** `OverviewPage` is memoized and keeps its coordinate and settings objects stable across equal values, so the 500 ms freshness tick in `App.tsx` no longer re-renders the map and plot.

## Review findings fixed before commit

- The readout source badge first said `LIVE DATA OUT` even when the snapshot was stale, which broke the "stale data must not look live" rule. It now says `DATA OUT`; freshness is shown in the age cell.
- "Age at read" overflowed with `clock unverified` as the value. The value now shows `—` and the reason moves to the detail line.
- The polar `AVAILABLE` badge was clipped when the toolbar was narrow; it no longer shrinks.
- At 320 px a spacing tweak caused a 4 px horizontal overflow; corrected and re-measured.
- Three unused dictionary keys were removed.
- The caption suffix "compass heading unverified" is kept in both Polar and Compass modes, as before.

## Verification

- `npm run check`: passed.
- `npm test`: 6 files, 78 tests passed, including a new `i18n.test.ts` that checks key parity, placeholder parity, interpolation, language normalization, and gate-reason coverage.
- `npm run build`: passed.
- `unittest discover -s tools`: 38 tests OK. Standalone scripts: collector 11, stage-3 13, security regressions 6, config-apply 4, all passed.
- Production bundle served by `tools/ground_console.py` on 127.0.0.1:8787, driven with Playwright and Chromium:
  - Live Data Out was unreachable (STALE / BLOCKED). The browser-only simulation was used for the AVAILABLE state.
  - Pressing 6 opened Simulation and focused its `h1`; typing 1 in a number field did not navigate; pressing 1 elsewhere opened Overview.
  - Over 3 s of idle static simulation the Plotly container had 0 DOM mutations.
  - Switching to ID set `<html lang="id">` and stored `id`. After navigating to a lazily loaded page, focus landed on its translated `h1`.
  - At 390 × 760 the drawer opened with focus on the first nav item; Escape hid it and focus returned to Menu.
  - At 390 and 320 px, `scrollWidth` matched the viewport on all six routes.
  - No page errors or console errors other than tile and resource 404s.
- Screenshots were taken of dark and light themes, EN and ID, the collapsed rail, overlay settings open, the mobile drawer, and 320 px Overview.

## Limits

- No live SDR, Data Out, or MQTT source was available, so live AVAILABLE rendering was checked only through the labeled simulation.
- The 0-mutation result is measured on the new build only; the old build was not profiled for comparison.
- Keyboard checks covered shortcuts, drawer focus, and route focus, not a full tab-order audit. Reduced motion relies on the existing global rule; it was not toggled in the browser.
- The admin branding write path was not exercised.
