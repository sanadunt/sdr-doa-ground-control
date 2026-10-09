# Anti-Slop Audit 007: Monobs Layout, Navigation, and Page Density

Date: 2026-10-09  
Mode: reviewed while working, as the user requested.  
Status: Implemented and validated. `antislop.md` and `skills/antislop-*` are still missing, so this audit uses the same format as audits 001–006.

## Requests

1. Make the Receiver feel tidier; it felt crowded.
2. Rename the Receiver menu to **Monobs** and move it directly below Dashboard. The user confirmed that "Dashboard" means the first menu, which was Overview/Ringkasan, and that it should also be renamed to **Dashboard**.
3. Re-audit every page and treat large empty areas as findings.

## Findings before the change

Screenshots were taken at 1440×900, 1920×1080, and 390×844 for all seven routes and all three Receiver tabs.

**Receiver**

- **Two navigation rails.** The console rail sat next to a second vertical rail holding the Spectrum/Listener/Records tabs, which also used rotated text. This cost about 55 px of width and gave the page two competing left edges.
- **Settings grid.** The Spectrum tab opened with 15 acquisition, detection, display, and listen controls in a dense two-row grid. The checkbox labels wrapped ("RF amp (+14 dB)"), and the Min/Max pair sat in its own boxed sub-group.
- **Status line.** A separate status line sat between the toolbar and the chart.
- **Empty chart.** Before the first scan the chart was a blank grid with no instruction.
- **Duplicate marker controls.** A right-hand "Spectrum markers" column repeated the marker list from the new readout table (frequency/label inputs per marker), added the set manager and manual entry, and squeezed the peak history into the remaining width with its own scroll area.
- **Listener.** With the radio off, the Listener tab showed a large black area with no message.
- **Records.** The Refresh button stretched across the whole header, because upstream `.btn` has `flex: 1`. With no recordings, a full filter panel showed for an empty list.

**Other pages**

- **Duplicate page title.** Every page except Dashboard and Receiver repeated its name under the shell header: an eyebrow, a 22 px H1 that looked underlined because of route focus, and a description. That is about 100 px of title.
- **Stale banner offset.** The stale-evidence banner was indented 20 px on both sides, so it did not line up with the cards.
- **System Health.** The summary card was stretched to the height of the Node inspector and left a large empty area. The subsystem table spanned the full width, with the status badge floating in the middle of each row.
- **DoA Diagnostics.**
  - Each operator-log entry took two lines.
  - Four of the seven entries repeat the block reasons shown above.
  - As a result, the Effective config card ended with about 220 px of empty body.
- **Configuration.**
  - The fourth item in the safety summary used a different component (`KeyValue`), so its label case and size did not match the other three.
  - The dry-run form put short numeric fields two per row at full width.
- **Message Monitor.** "Latest decoded records" showed a raw `{}` box when nothing had been decoded.
- **Simulation.**
  - The two cards were stacked, with full-width inputs for four short numbers.
  - The page scrolled at 1440×900 although the content fits on one screen.

## Changes

### Navigation

- Order: Dashboard, Monobs, System Health, DoA Diagnostics, Configuration, Message Monitor, Simulation. Keys 1–7 follow this order.
- `route.overview` reads **Dashboard** in both languages. `route.receiver` reads **Monobs**, with the hint "Spectrum monitoring and recordings" / "Monitoring spektrum dan rekaman".
- The simulation copy now says Dashboard instead of Overview/Ringkasan.
- The route ids stay `overview` and `receiver`, so stored links keep working. `#/monobs` was added as an alias.
- `QUICKSTART.md` and `AGENTS.md` were updated. The Shell and i18n tests now assert the new labels and order.

### Monobs

- **Tabs.** Spectrum, Listener, and Records sit in one horizontal tab bar at the top of the iframe, replacing the second rail. ←/→ move between tabs (↑/↓ still work), and `aria-orientation` is now horizontal.
- **Spectrum header.** The title row now holds the sweep counters, so the separate status line is gone.
- **Scan bar.** One row holds Source, Range (start–end MHz), and Resolution, with Connect and Start/Stop scan on the right.
- **Scan settings.** A collapsible panel holds the less frequent controls in three groups: Gain (LNA, VGA, RF amp, IQ correction), Detection (minimum SNR, averaging α), and Listen (demodulation). While closed, its summary line shows the current values: `LNA 40 dB · VGA 20 dB · RF amp off · IQ on · SNR ≥ 8 dB · α 0.35`.
- **Chart toolbar.** It sits directly above the chart:
  - Spectrum/Waterfall, Trace, Scale (min to max dBFS), Zoom − + Fit, and Marker to peak.
  - A **Session** menu holding Open, Save JSON, Export CSV, and Clear. The menu closes on Esc, on an outside click, or when focus leaves it.
- **Empty chart.** Before the first scan the chart says "No scan data yet. Set the range, then press Start scan."
- **Markers panel.** It now also holds the marker-set controls: saved set, name, Save set, and a **More** menu (new set, JSON/CSV export, delete saved set).
  - Labels and frequencies are edited inline in the readout table.
  - "Add by frequency" sits under the table.
  - The separate right-hand marker column is gone.
- **Frequency display.** Frequencies are shown as `x.xxxxxx` MHz. Editing only a label no longer rewrites the stored frequency to that rounded text (`frequencyDraftMHz` plus a guard in `updateReceiverMarker`).
- **Peak history.** It uses the full width. Sort by moved into its filter row. The table scrolls inside a 440 px band, and the Spectrum tab scrolls as one page.
- **Listener.** With the radio off, it says "Radio is off. Use Connect Device under Source to start listening."
- **Records.**
  - Refresh is a normal-width button.
  - The VFO audio filters show only when recordings exist or a filter is active.
- **Builder.** The Spectrum section markup now lives in the overlay `index.html`. These builder patches were removed:
  - the wide-scan caption patch
  - the ten-occurrence disabled-state patch
  - the graph-range rewrite and reorder
- **Removed CSS.** Old toolbar-group and marker-row CSS that no longer matched any markup was deleted.

### Other pages

- **Page intro.** `SectionHeading` keeps its H1 for screen readers and route focus, but visually hidden. The visible intro is one line: eyebrow plus the page note.
- **Stale banner.** It now aligns with the cards.
- **System Health.** Summary and Subsystems now share the left column. Each subsystem row is name and detail on the left, badge on the right. At 1440 px the page is 1028 px tall instead of 1188, and at 1920×1080 it no longer scrolls.
- **DoA Diagnostics.** Gate rows and log entries use one line each. The page is 1340 px tall instead of 1682.
- **Configuration.**
  - The admin session is a `Metric` like its neighbours (CLOSED green, ACTIVE amber).
  - Dry-run fields go three per row from 1200 px.
- **Message Monitor.** When nothing has been decoded it shows "No decoded records." instead of `{}`.
- **Simulation.**
  - The two cards sit side by side from 1200 px, so the page fits 1440×900 without scrolling.
  - The draft latitude and longitude start at 6 decimals.

## Copy review

- Menu names are what the user asked for. Status codes stay untranslated.
- Each new empty state says what to do next, in one sentence, and names the actual control ("Start scan", "Connect Device", "Marker to peak", "Mark").
- Menu items say what they produce, for example "Save session (JSON)" and "Export peaks (CSV)". The destructive items (Clear results, Delete saved set) use the danger colour.
- The summary of the collapsed scan settings uses the same units as the controls.

## Verification

- `npm test`: 87 passed. `npm run check` and `npm run build` passed.
- `build_browsdr_receiver.py`: the build succeeded, and every remaining patch still finds its anchor.
- `node --test tools/test_receiver_markers.mjs tools/test_receiver_iq_spectrum.mjs`: 11 passed, including a new test for `frequencyDraftMHz`.
- Patched-tree `tsc --noEmit`: only the 2 baseline `HTMLSummaryElement` errors.
- `unittest discover -s tools`: OK. `git diff --check`: clean.
- Browser checks (Playwright + Chromium against `ground_console.py`, BrowSDR Simulation source):
  - `#/monobs` opened the Monobs route, with Monobs active in second place.
  - Dark theme: clicking near an existing marker selected it instead of adding one. Marker to peak and Mark added markers. ←/→ and Shift moved the selected marker, then Set REF, Delete, and Esc were checked.
  - Light theme: the open scan settings, the Session menu, inline edits, Add by frequency, and the tab keys were checked.
  - An inline label edit kept the frequency at `549.780273`. Add by frequency `433.92` created `433.920000`.
  - The workspace tabs switched with ←/→. The Session menu closed on outside click and on Esc, and stayed open while tabbing into it.
  - Light and dark themes were checked at 1440 px and mobile at 390 px. No horizontal page scroll on any route at 390, 1440, or 1920 px.
  - No page errors. The only console error was the known `favicon.ico` 404.

## Limits

- Monobs is still English only, because BrowSDR has no i18n layer. Only the console menu label and hint are translated.
- The Listener sidebar and toolbar are upstream BrowSDR layouts. This change only adds the off-state message and the shared tab bar.
- System Health still ends with empty space under the Node inspector at 1440 px. That space is page background, not an empty card. Balancing it further would mean splitting the inspector.
- No HackRF was attached, so all Monobs checks used the Simulation source.
