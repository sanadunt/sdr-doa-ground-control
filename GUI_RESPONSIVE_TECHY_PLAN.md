# Ground Console GUI Responsive and Technical Refresh Plan

Status: **Implementation and local QA complete (2026-09-25). Operational acceptance remains pending a Ground Station monitor review and live hardware/telemetry validation.**

## Overview

The goal is to make the React Ground Console responsive across phone, tablet, laptop, and wide desktop layouts while giving it a more technical, instrument-grade visual identity. The redesign must preserve the existing telemetry contracts, freshness and publication gates, read-only boundaries, MapLibre behavior, Plotly interaction state, simulation isolation, and light/dark themes.

Design read:

> Operational SDR-DoA console for technical operators, using a restrained instrument-panel visual language with **ENERGY 2 / RHYTHM 2 / MOTION 1**.

“More techy” means clearer data hierarchy, tabular measurements, precise dividers, compact but readable controls, explicit source/freshness labels, and map/plot surfaces that feel like real tools. It does not mean neon gradients, fake radar sweeps, background grids, excessive glow, glassmorphism, or fabricated telemetry.

### Confirmed issues and audit targets

| ID | Priority | Finding | Evidence / impact |
|---|---:|---|---|
| RSP-01 | P0 | Mobile navigation remains vertical instead of becoming horizontally scrollable or compact. | At 320 px and 390 px, `.primary-nav` retains the base `flex-direction: column`; the nav is 608 px high and the sidebar is 701 px high. Workspace content starts below almost a full viewport. |
| RSP-02 | P1 | Several interactive targets are smaller than the 44 x 44 px mobile minimum. | Theme and refresh controls are 38 px high; many primary/secondary buttons are 40 px; form fields are 43 px. |
| RSP-03 | P1 | Mobile shell chrome consumes too much vertical space. | At 320 x 740, the sidebar is 701 px high and the status cluster wraps to 67 px before the read strip and page content. |
| RSP-04 | P1 | Configuration is usable but excessively long on narrow screens. | At 320 px, the page is about 5,056 px tall. Connection, branding, dry-run, GPS, and Compass workflows need clearer section navigation and progressive disclosure without hiding safety information. |
| RSP-05 | P1 | Responsive behavior is split across layered stylesheets and overlapping media queries. | `styles.css`, `console-design.css`, and `polar-layout.css` override the same shell, Overview, panel, and breakpoint rules. This makes fixes fragile and increases regression risk. |
| VIS-01 | P1 | Technical hierarchy is inconsistent between shell, status areas, map, plot, forms, and tables. | The current graphite/amber direction is sound, but operational readings, actions, status, and metadata do not yet follow one explicit visual system. |
| A11Y-01 | P1 | Small labels and dense metadata need accessibility verification. | Active rules include 10 px and 11 px labels/status text. Both themes need measured contrast, 200% zoom, keyboard, and focus checks. |
| QA-01 | P1 | There is no repeatable visual regression suite. | Existing Vitest tests cover contracts/helpers. Browser QA exists as historical reports, not a checked-in reproducible viewport/state matrix. |
| PERF-01 | P2 | The production bundle remains large. | Plotly is approximately 4.8 MB minified and already lazy-loaded. UI work must not accidentally move it into the initial application path or add another heavy visual dependency. |

The first implementation pass should confirm every item against the current production build and add newly reproduced issues to the same backlog. Historical test counts and old Leaflet notes are not current evidence.

### Non-goals

- No backend, MQTT contract, collector, publication-gate, or remote-control changes.
- No changes that imply transmitter position, RF range, target tracking, or calibrated power.
- No fabricated live, health, history, or activity data for visual completeness.
- No replacement of MapLibre or Plotly unless a separately approved performance investigation proves it necessary.
- No redesign of the embedded `--legacy-ui` interface.

## Approach

### 1. Fix responsive structure before visual decoration

Start with layout defects that block content: navigation, shell chrome, target sizing, overflow, and page reflow. Apply breakpoints where content fails rather than targeting named devices. Mobile must be a distinct layout, not a compressed desktop.

Proposed responsive states:

- **Narrow, up to the content failure point near 620 px:** compact brand/header, horizontally scrollable primary destinations or a clearly labeled menu, one-column content, 44 px controls, stacked forms, and no covered content.
- **Medium, approximately 621 to 980 px:** compact top navigation, one-column Overview with an explicit map/plot order, two-column form groups only where labels remain readable.
- **Desktop, above approximately 980 px:** persistent sidebar and two-surface Overview.
- **Short desktop:** reduce nonessential chrome without shrinking labels or hiding operational state.
- **Wide desktop:** constrain reading width while allowing map and plot surfaces to use available space.

The exact breakpoint values remain subject to browser evidence. Existing 620/980/1200 rules are starting points, not requirements.

### 2. Build one visual system around operator decisions

Define and reuse a small token set for:

- graphite background and neutral surfaces;
- amber action/selection accent;
- green, amber, and red semantic states paired with text;
- readable type scale and line height;
- tabular numeric style for coordinates, dB, timestamps, counts, and frequencies;
- spacing scale, divider hierarchy, control heights, focus rings, and surface radii;
- map/plot focal surfaces and quieter supporting metadata.

Use monospace only for measurements, identifiers, and raw records. Keep body text and controls in the system UI font. Prefer flat instrument surfaces and precise separators over card stacks, gradients, glow, and large shadows.

### 3. Refactor CSS by ownership, not by another override layer

Do not add a fourth stylesheet that patches symptoms. Establish ownership for:

- global tokens and primitives;
- shell/navigation/status chrome;
- page layout;
- MapLibre controls and overlays;
- Plotly controls and metadata;
- responsive states.

Remove obsolete declarations after each migrated area. Keep component markup changes limited to semantic grouping or behavior required by responsive layouts.

### 4. Validate real states, not only the ideal screenshot

Every page must be reviewed with relevant states:

- first load and loading;
- unavailable/no-data;
- stale and read error;
- conflict/degraded where fixtures support it;
- simulation OFF and ON;
- MQTT disabled, disconnected, connected, and invalid payload states;
- dark and light themes;
- reduced motion;
- keyboard-only use.

The redesign must keep `SIMULATION`, `FALLBACK`, `MANUAL`, stale, and blocked states visually explicit.

## Key Steps

### Step 1: Establish the baseline and acceptance matrix

1. Run the production build through `tools/ground_console.py`, not Vite alone.
2. Capture all six routes at 320 x 740, 390 x 844, 768 x 1024, 980 px, 1366 x 768, 1440 x 900, and 1920 x 1080.
3. Exercise dark/light themes, 200% zoom, keyboard navigation, reduced motion, unavailable data, and simulation ON/OFF.
4. Record document overflow, clipped content, target sizes, console errors, and MapLibre/Plotly resize behavior.
5. Convert reproduced findings into a prioritized checklist with exact route, viewport, state, and acceptance criterion.

Acceptance:

- Every P0/P1 issue has reproducible evidence.
- The plan distinguishes confirmed defects from subjective visual preferences.
- No Raspberry, production broker, or remote write is needed for the baseline.

### Step 2: Repair the responsive shell

1. Replace the broken narrow navigation behavior with a deliberate mobile pattern. Preferred first option: one-row horizontally scrollable primary navigation with clear active state, scroll affordance, and 44 px targets. If six destinations remain too dense, use a labeled `Menu` control with keyboard and Escape behavior.
2. Compact the mobile brand area and remove the desktop-only sidebar footer from the first viewport while retaining the read-only message in a reachable location.
3. Reflow title, runtime status, theme, and refresh controls so the operator can scan them without a tall wrapped block.
4. Keep the read strip readable and allow long errors, timestamps, and MQTT text to wrap without horizontal overflow.
5. Reserve space for any sticky navigation so it never covers the last control or footer.

Acceptance:

- On 320 x 740, page content begins within the first viewport.
- No shell element causes horizontal document overflow.
- All interactive targets are at least 44 x 44 px on touch layouts.
- Tab order matches visual order; focus indicators are visible in both themes.

### Step 3: Stabilize layout primitives and CSS ownership

1. Inventory duplicate shell, panel, Overview, and responsive declarations across the three active stylesheets.
2. Move final values into a documented token and primitive layer.
3. Consolidate media queries around content-driven layout states.
4. Remove superseded rules instead of preserving override chains.
5. Keep `polar-layout.css` limited to Plotly-specific layout if a separate file remains useful.

Acceptance:

- Each major selector has one clear source of truth.
- No behavior depends on import-order accidents.
- Desktop and mobile screenshots remain stable during stylesheet cleanup.

### Step 4: Redesign Overview as the primary instrument workspace

1. Choose and document the operator priority on narrow screens. Recommended order: angular response first when evaluating DoA shape, followed by the map direction helper; keep a compact switch or anchor between them if field use favors rapid movement.
2. Keep map and plot side by side on wide screens, with minimum usable widths and no forced viewport-height clipping.
3. Rework Plotly controls into a compact control bar that wraps cleanly and keeps labels attached to inputs.
4. Keep map overlay settings as a real drawer/popover with internal scrolling, clear close behavior, keyboard access, and controls that remain at least 44 px high on mobile.
5. Reduce competing metadata around the primary visualization. Group canonical source, plotted peak, signed peak, and vector state into a consistent instrument readout.
6. Preserve MapLibre camera state, Plotly `uirevision`, resize observers, and stale-data clearing.

Acceptance:

- Map and plot remain legible at every target viewport and 200% zoom.
- Data updates do not reset operator camera, zoom, rotation, Head Up, or manual dB range.
- Overlay controls never hide attribution or trap keyboard focus.
- Fallback/manual/simulation sources cannot be mistaken for live verified GPS.

### Step 5: Reflow supporting pages by task

- **System Health:** keep the overall state and failed/degraded subsystems first; use rows for secondary subsystem details instead of equal-weight cards.
- **DoA Diagnostics:** preserve the gate-first hierarchy, separate CSV/XML records, and make wide records scroll inside a labeled container rather than overflowing the page.
- **Configuration:** add a compact section index or native disclosure groups for Connection, Branding, Dry-run, GPS, and Compass. Keep safety notices visible when their section is active. Do not hide validation errors or apply actions below unrelated content.
- **Message Monitor:** prioritize connection state and latest invalid/important messages; contain wide tables; retain subscriber-only labeling.
- **Simulation:** keep enable/disable, scenario inputs, randomization, and the `View Overview` action close together; make the synthetic-only boundary impossible to miss.

Acceptance:

- No page requires horizontal document scrolling at 320 px.
- Forms remain usable with the mobile keyboard and at 200% zoom.
- Empty, loading, error, stale, and disabled states explain the cause and next action.
- Important actions stay adjacent to the data they change.

### Step 6: Apply the technical visual refresh

1. Standardize status rails, measurement labels, coordinate/dB/frequency typography, panel headers, and action hierarchy.
2. Give each screen one focal point: map/plot on Overview, overall health on Health, delivery gate on Diagnostics, current section form on Configuration, connection/message stream on Monitor, and scenario controls on Simulation.
3. Use amber only for current selection and operator action. Reserve green/red/amber status colors for semantic state with accompanying text.
4. Keep motion limited to short route/state transitions and direct interaction feedback. Respect `prefers-reduced-motion`.
5. Avoid generic “tech” decoration that does not improve scanning or state recognition.

Acceptance:

- The interface remains identifiable as an SDR-DoA instrument console if branding is removed.
- Every major visual decision has a one-line operational reason.
- Both themes pass text and non-text contrast checks.
- No dead controls, decorative data, endless motion, or color-only state indicators are introduced.

### Step 7: Verify behavior and release readiness

1. Run `npm run check`, `npm test`, and `npm run build`.
2. Run the Python static/security regression suite after building `frontend/dist`.
3. Browser-test all routes using the viewport/state matrix from Step 1.
4. Check keyboard navigation, focus, theme persistence, reduced motion, 200% zoom, MapLibre gestures/settings, Plotly controls/interaction persistence, and simulation transitions.
5. Check browser console, failed network requests, and CSP behavior.
6. Update `evaluasi GUI.md` with current screenshots, measured results, remaining limitations, and hardware checks still pending.

Acceptance:

- Zero horizontal document overflow at the tested narrow widths.
- No controls below 44 x 44 px on touch layouts.
- No new JavaScript console errors.
- Existing telemetry, freshness, publication, redaction, simulation, and read-only contracts remain unchanged.
- Human review is completed on the actual Ground Station monitor before operational acceptance.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| CSS consolidation changes unrelated screens. | High | Migrate one ownership area at a time; compare every route and both themes after each cutover. |
| MapLibre or Plotly gets incorrect size during reflow. | High | Preserve component lifecycles and `ResizeObserver`; test tab changes, panel expansion, viewport resize, and simulation updates. |
| “Techy” styling reduces readability. | High | Treat technical style as information hierarchy, not decoration; enforce type, contrast, focus, and motion limits. |
| Compact mobile navigation hides important routes. | Medium | Keep primary routes visible when practical; if using a menu, label it, support keyboard/Escape, and test discoverability. |
| Progressive disclosure hides safety context or errors. | High | Keep source, dry-run, read-only, and validation state inside each active section; auto-open sections containing errors. |
| Desktop density is copied unchanged to mobile. | High | Define a separate narrow layout with its own spacing, order, and controls; verify 320 px and 200% zoom. |
| Visual polish implies unverified telemetry quality. | High | Preserve explicit `STALE`, `BLOCKED`, `SIMULATION`, `FALLBACK`, `MANUAL`, and source-provenance labels. |
| Additional libraries increase the already-large bundle. | Medium | Prefer existing React/CSS/GSAP/MapLibre/Plotly capabilities; require profiling evidence before adding dependencies. |
| Browser QA passes without live hardware behavior. | Medium | State the limitation; complete fixture/simulation coverage locally and schedule separate Ground Station and live telemetry validation. |
| Scope expands into backend or remote control. | High | Keep API and telemetry contracts frozen for this effort; raise any required contract change as a separate reviewed task. |

## Implementation status

The responsive shell, page reflow, plot label adaptation, touch sizing, focus treatment, and technical visual tokens are implemented. Local verification evidence and the remaining hardware, zoom, map-tile, and bundle limitations are recorded in `evaluasi GUI.md` under “Refresh responsif dan visual instrumen”.
