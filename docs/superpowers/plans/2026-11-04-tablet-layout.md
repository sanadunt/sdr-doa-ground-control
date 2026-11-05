# Tablet layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the compact touch layout, show a swappable main view (map or drone video, the other in a small window), an always-visible info row, a tabbed side panel, and map notices that fold away on a tap.

**Architecture:** The map and the drone video are siblings in one `.ov-main` box. CSS on `data-main` decides which one is big and which is the 16:9 corner window, so neither the MapLibre instance nor the `<video>` element is ever remounted. One `useDroneFeed()` hook reads `/api/drone` and `/api/drone/video` for the page. The stage video and the Drone tab's rows both take their data from it. Desktop rendering is unchanged: every new element renders only when `compactLayout` is set, and every new rule sits under `.console-shell[data-layout^='compact']`.

**Tech Stack:** React 19 / TypeScript, Vitest with static markup (`react-dom/server`), CSS in `overview-dashboard.css` and `console-design.css`.

**Spec:** `docs/superpowers/specs/2026-11-04-tablet-layout-design.md`

## Global Constraints

- Desktop (no `compactLayout`) renders exactly as before; `OverviewPage` stays memoized and props stay stable.
- Compact rules only under `.console-shell[data-layout^='compact']`, token colours only, touch targets ≥ 44 px (`components/compactLayout.test.tsx` checks).
- Every UI string in EN and ID (`lib/i18n.ts`, parity test).
- No new saved preference. Main view and tab are per visit. Compact never writes `panels.spectrum`, `panels.drone` or `panels.control`.
- Drone video stays live in the corner window (owner, 2026-11-04).
- Release as 3.14.0: `VERSION`, compose tags, `QUICKSTART.md`, `packaging/console/README.md`, `AGENTS.md` version lines, `## 3.14.0` in `CHANGELOG.md`.

## Review Focus

1. Swapping the main view must not remount TacticalMap or the `<video>`: the camera position and the WebRTC session survive a swap.
2. The drone link turning `DISABLED` (or video off or not configured) while the video is the main view: the map comes back to the front, and there is no empty box.
3. A dismissed notice stays folded when only its time changes (LIVE→held flicker over LoRa), and reappears when its cause text changes.
4. Portrait phone (360 px wide) and landscape phone (about 800×360): no horizontal scroll, the info row fits, tab buttons are 44 px.
5. LAN view: no Kontrol tab, Spektrum tab is the MIRROR dock, no Receiver frame mounts.

---

### Task 1: Shared drone feed and split Drone panel

**Files:**
- Modify: `frontend/src/components/overview/DronePanel.tsx`
- Test: `frontend/src/components/overview/dronePanel.test.tsx`

**Interfaces:**
- Produces:
  - `useDroneFeed(initialView: DroneView | null, initialHealth?: DroneVideoHealth | null): { view: DroneView | null; health: DroneVideoHealth | null }`. Polls as `DronePanel` does today, and never polls when `initialHealth` is given.
  - `export function DroneVideo(props: { view; health; onState })`.
  - `export function DroneDetails(props: { view: DroneView | null; health: DroneVideoHealth | null; video: { phase: DroneVideoPhase; code: string | null } }): JSX.Element`. It renders the `<dl className="ov-drone-rows">` (link rows plus value rows) and the status text.
  - `export function dronePipShown(view: DroneView | null, health: DroneVideoHealth | null): boolean`. True unless `view` is null or `DISABLED`, `videoEnabled === false`, or health is `DISABLED`/`NOT_CONFIGURED`.
- `DronePanel` keeps its props and markup, built from these pieces.

- [ ] Test `dronePipShown`: null, DISABLED, `videoEnabled: false` and health `DISABLED NOT_CONFIGURED` → false; searching and health `DOWN` → true. Test that `DroneDetails` markup has the Telemetry row and no `<video`.
- [ ] Run `npx vitest run src/components/overview/dronePanel.test.tsx`; expect failures.
- [ ] Implement, keeping the existing tests green.
- [ ] Run the same command; expect pass.

### Task 2: Fold-away map notices

**Files:**
- Modify: `frontend/src/components/MapNoticeChip.tsx`
- Test: `frontend/src/components/compactLayout.test.tsx` (or a new `mapNoticeChip.test.tsx`)

**Interfaces:**
- `export function noticeKey(text: string): string` returns the text with every digit run removed and whitespace collapsed.
- A module-level `Set<string>` holds the dismissed keys for the page's life.
- Compact chip states:
  - full one-line chip (a tap dismisses it);
  - folded `ⓘ` flag (`button.map-chip-flag`, 44 px, `aria-label` = the full text; a tap expands it);
  - expanded (full text + action; a tap folds it back).
- Desktop rendering is unchanged.

- [ ] Test `noticeKey('DoA held · last 17:23:12 · stale')` equals `noticeKey('DoA held · last 17:25:40 · stale')` and differs from the key of another cause. Test that the static markup of a dismissed key renders the flag.
- [ ] Implement; add a `__resetDismissedNotices()` test export.
- [ ] Run the tests; expect pass.

### Task 3: Compact info row

**Files:**
- Create: `frontend/src/components/overview/CompactInfoStrip.tsx`
- Modify: `frontend/src/components/DoaReadout.tsx` (export a pure helper)
- Test: `frontend/src/components/overview/compactInfoStrip.test.tsx`

**Interfaces:**
- `export function hudBearing(snapshot, localSnapshotFresh, settings: PolarSettings, curveOffset: number | null, offsetManual: boolean): { deg: number | null; held: boolean; unverified: boolean; ageMs: number | null }`. It uses the same rules as DoaReadout (`bearingForView` when shown, else `heldBearing`), and DoaReadout uses it too.
- `CompactInfoStrip(props: { snapshot; localSnapshotFresh; settings; curveOffset; offsetManual; drone: DroneView | null; videoLive: boolean; onOpenTab: (tab: CompactTab) => void })`.
  - Four buttons (`.ov-info-box`, 44 px or taller): bearing (→ `node`), frequency (`doaSample()`, else `snapshotRf()` center → `node`), drone (alt rel · heading · `droneFixLabel` → `drone`), link dots (RDF-SDR fresh, drone LIVE, video live → `drone`).
  - Held bearings carry `is-held` and the STALE/NOT VALID tag.
- `export type CompactTab = 'spectrum' | 'drone' | 'node' | 'control'`.

- [ ] Tests: a live snapshot fixture shows the bearing in `0.0°` format; a held one shows the tag; no drone shows `—`; each box's `data-tab` is right.
- [ ] Implement; run `npx vitest run src/components/overview/compactInfoStrip.test.tsx src/components/doaReadout*`; expect pass.

### Task 4: Compact stage, corner window and tabs

**Files:**
- Modify: `frontend/src/pages/OverviewPage.tsx`, `frontend/src/components/overview/OverviewPanelToggles.tsx`, `frontend/src/overview-dashboard.css` (compact section), `frontend/src/lib/i18n.ts`
- Test: `frontend/src/components/compactLayout.test.tsx`, `frontend/src/pages/overviewPage.test.tsx`

**Interfaces:**
- Compact markup:
  - `.ov-stage` holds `.ov-main[data-main=map|video]` (`.ov-map`; `.ov-video` holding `DroneVideo` while `dronePipShown`; a `button.ov-pip-swap` over the small one with `aria-label` `overview.swapView`).
  - Then `CompactInfoStrip`.
  - Then `.ov-side` with `div[role=tablist].ov-side-tabs` (Spektrum, Drone, RDF-SDR, Kontrol when `!viewOnly`, each with a status tag) and the tab panel.
  - Then `.ov-left` holding only Lapisan (and EstimatePanel with an estimate).
- Tab content:
  - spectrum: the existing dock component.
  - drone: `DroneDetails`.
  - node: `DoaReadout` + `NodeCard` (expanded, no toggle).
  - control: `ControlPanel`, kept mounted and `hidden` when not active.
- Compact page state (never saved): `main: 'map' | 'video'` and `tab: CompactTab`. `main` falls back to `'map'` whenever `dronePipShown` is false.
- `COMPACT_TOGGLES` becomes Lapisan only. The `nodeOpen` prop is no longer used in compact.
- CSS (compact only):
  - landscape grid `'main side' 'info side'`, columns `72fr 28fr`, rows `1fr auto`;
  - portrait grid `'main' 'info' 'side'`, rows `60fr auto 40fr`;
  - the small one absolute at right/bottom 8 px, width 32 %, 16:9, border, z above the map;
  - map buttons hidden while the map is small;
  - info row 4 columns in landscape and 2 in portrait or below 500 px height (boxes 3 and 4 hidden there);
  - tabs 44 px.
- i18n: `overview.swapView`, `overview.tabSpectrum`, `overview.tabDrone`, `overview.tabNode`, `overview.tabControl`, `overview.infoBearing`, `overview.infoFrequency`, `overview.infoDrone`, `overview.infoLink`, `overview.noticeShow`, EN and ID.

- [ ] Tests:
  - compact markup has `.ov-main`, the info row and `role="tablist"` with 4 tabs (3 with `viewOnly`);
  - desktop markup has none of them;
  - the existing compact CSS checks are updated (scope, tokens, 44 px) for the new selectors.
- [ ] Implement; run `npm test` and `npm run check`; expect pass.

### Task 5: Verify, document, release

**Files:**
- Modify: `CLAUDE.md` ("Compact touch layout"), `AGENTS.md` (compact sentence, version), `CHANGELOG.md`, `VERSION`, `docker-compose.yml`, `docker-compose.release.yml`, `QUICKSTART.md`, `packaging/console/README.md`

- [ ] `npm run build:all`, and the Python release and static suites (`tools.test_release_workflow`, `test_make_release`, `test_ground_console_static`).
- [ ] Browser check, with a local console and a fake drone link, at `?layout=compact-landscape` (1280×800), `compact-portrait` (800×1280) and phone sizes (360×780, 780×360):
  - a swap keeps the map's camera and the video;
  - a notice folds and stays folded when only its time changes;
  - the tabs work;
  - there is no horizontal scroll.
- [ ] Docs and version 3.14.0, commit, PR, merge, tag `v3.14.0`, then update the groundstation and relaunch the kiosk.
