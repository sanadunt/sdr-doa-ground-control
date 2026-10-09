# Receiver Menu Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Receiver menu in `sdr-new` that opens the complete same-origin embedded Receiver instead of a dead `/receiver/` route.

**Architecture:** Add a `receiver` route and an iframe page to the React shell. Ground Console serves a pinned BrowSDR build at `/receiver/` and exposes the local `/api/receiver/*` record APIs backed by a local SQLite store. The feature stays isolated from SDR-DoA Data Out and unrelated System Health/MQTT work.

**Tech Stack:** React 19, TypeScript, Vite, Python standard library, SQLite, pinned BrowSDR git submodule, npm.

**Spec:** `docs/superpowers/specs/2026-10-09-sdr-new-receiver-integration-design.md`

## Global Constraints

- Work only on `feature/receiver-integration`, based on `sdr-new/main` commit `19bd9bdfb3a57d8a7abe2592fd0e75aba534fabc`.
- Keep `main` and the other worktrees unchanged; do not push this branch.
- BrowSDR source stays pinned at `54f6cb7c0d69848461eedc46d278518be6f939d3`.
- Do not commit generated `frontend/dist` output.
- Keep Receiver assets and APIs same-origin; preserve loopback binding and existing static path/body-size protections.
- Do not add remote writes to SDR-DoA Data Out or change its collector/publication gate.
- Do not import unrelated System Health, MQTT, Docker, or other dirty feature work.
- Use no new root/frontend npm dependency; the embedded build uses the pinned submodule's own lockfile. Receiver audio time filtering uses standard-library `zoneinfo`, so document Python 3.9+ as the runtime floor.

## Review Focus

1. Missing or wrong-version BrowSDR source/build must fail the build before serving incomplete assets. Verify with the builder's pinned-source and built-output checks, then the real static-asset test.
2. Encoded traversal, symlinks, dotfiles, unsupported extensions, and paths outside `frontend/dist/receiver` must return 404. Verify with `test_receiver_fixture_static_boundary_rejects_escape_paths` and the final built-asset boundary test.
3. Invalid Receiver IDs, malformed payloads, oversized bodies, and absent records must return bounded errors without corrupting local data. Verify with `test_invalid_ids_and_payload_bounds_are_rejected` and the records API test.
4. Incomplete/failed audio segments and segment deletion must not expose playable partial data or delete sibling segments. Verify with the two Receiver audio API tests and the record-store audio tests.
5. The menu must render in both languages, route via the `7` shortcut, open the same-origin Receiver page, and propagate theme changes. Verify with `Shell.test.tsx`, `i18n.test.ts`, and the real-browser smoke in Task 5; do not initiate hardware scanning during smoke.

---

### Task 1: Add the local Receiver record store

**Files:**
- Create: `tools/test_receiver_record_store.py`
- Create: `tools/receiver_record_store.py`

**Interfaces:**
- Produces `ReceiverRecordStore(data_dir: Union[os.PathLike, str] = DEFAULT_DATA_DIR)`.
- Store contract includes settings, scans, candidate pagination/grouping, trace storage, marker sets, audio sessions/segments, record deletion, and `close()`.
- Uses only SQLite and Python standard-library filesystem/validation APIs.

- [x] **Step 1: Add behavior tests before the store implementation.** Port the Receiver store contract tests, including `test_settings_candidate_upsert_and_sql_pagination`, `test_candidate_history_paginates_beyond_one_thousand_rows`, `test_nearby_peak_frequencies_group_before_pagination`, `test_legacy_candidates_backfill_peak_frequency_for_grouping`, `test_archive_trace_round_trip_and_scan_record_deletion`, `test_record_types_have_independent_counts_and_pagination`, `test_new_scan_prunes_unarchived_rows_but_preserves_archives`, `test_marker_set_named_upsert_and_candidate_proximity_filter`, `test_manual_markers_allow_unmeasured_power_and_reject_invalid_frequencies`, `test_audio_segments_finalize_independently_and_cleanup_with_session`, `test_invalid_ids_and_payload_bounds_are_rejected`, and `test_failed_audio_segment_is_visible_and_not_playable`.
- [x] **Step 2: Run the new tests and confirm they fail because `receiver_record_store` is absent.**

Run: `PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_receiver_record_store`

Expected: import failure for the not-yet-created store module.

- [x] **Step 3: Implement `ReceiverRecordStore` in `tools/receiver_record_store.py`.** Port the receiver-only SQLite implementation; preserve its input validation, pagination limits, archive cleanup, audio finalization, and local data-directory behavior.
- [x] **Step 4: Run the store tests and confirm all listed contracts pass.**

Run: `PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_receiver_record_store`

Expected: all `ReceiverRecordStoreTests` pass with temporary test directories.

- [x] **Step 5: Commit the store and its tests.**

```bash
git add tools/receiver_record_store.py tools/test_receiver_record_store.py
git commit -m "feat: add local Receiver record storage"
```

### Task 2: Expose the local Receiver APIs

**Files:**
- Modify: `tools/ground_console.py`
- Modify: `tools/test_ground_console_static.py`

**Interfaces:**
- `GroundConsoleServer(..., receiver_data_dir: Optional[Path] = None)` owns and closes one `ReceiverRecordStore`.
- Add same-origin `/api/receiver/*` GET, POST, and DELETE handlers; keep record/audio mutations local and independent of Data Out. Return `{"error": "..."}` with 400 for invalid input and 404 for absent records; audio supports valid byte ranges (206) and rejects unsatisfiable ranges (416).
- GET: `/settings`, `/audio-facets`, `/records`, `/marker-sets`, `/scans/{scan_id}`, `/scans/{scan_id}/candidates`, `/scans/{scan_id}/traces`, `/scans/{scan_id}/trace?sweep=N`, `/audio-segments/{segment_id}/audio`.
- POST: `/settings`, `/scans`, `/marker-sets`, `/scans/{scan_id}/candidates`, `/scans/{scan_id}/candidates/query`, `/scans/{scan_id}/trace?sweep=N`, `/scans/{scan_id}/finish`, `/audio-sessions`, `/audio-sessions/{session_id}/segments`, `/audio-sessions/{session_id}/finish`, `/audio-segments/{segment_id}/chunk`, `/audio-segments/{segment_id}/finish`.
- DELETE: `/records/{id}`, `/audio-segments/{id}`, `/marker-sets/{id}`. Every listed path is prefixed `/api/receiver`.
- Add CLI `--data-dir` for the Receiver data directory.
- Update `ConsoleHTTPHarness` to inject a temporary Receiver data directory and close it after each test.

- [x] **Step 1: Add API behavior tests before handlers.** Port `test_receiver_records_routes_page_markers_and_delete_archives`, `test_receiver_audio_routes_stream_completed_files_and_expose_failures`, and `test_receiver_audio_segment_delete_preserves_siblings_and_rejects_active_segment`. Assert settings/scan/record/marker transitions, JSON error shape and status codes, completed-audio streaming/ranges, and sibling-preserving deletion.
- [x] **Step 2: Run those tests and confirm the new API paths fail against the current server.**

Run: `PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_ground_console_static.GroundConsoleStaticRegressionTests.test_receiver_records_routes_page_markers_and_delete_archives tools.test_ground_console_static.GroundConsoleStaticRegressionTests.test_receiver_audio_routes_stream_completed_files_and_expose_failures tools.test_ground_console_static.GroundConsoleStaticRegressionTests.test_receiver_audio_segment_delete_preserves_siblings_and_rejects_active_segment`

Expected: Receiver requests currently return 404; no Receiver store is constructed.

- [x] **Step 3: Implement the Receiver-only GET/POST/DELETE dispatch and error mapping in `tools/ground_console.py`.** Preserve current API precedence, bounded JSON/binary reads, audio `Range` responses, and 400-versus-404 error behavior. Construct the store from `receiver_data_dir` and close it in the server shutdown path.
- [x] **Step 4: Add and validate `--data-dir`; keep the default data location local and allow tests/smoke runs to pass a temporary directory.**
- [x] **Step 5: Run the three Receiver HTTP tests and the existing static-server suite.**

Run: `PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_ground_console_static`

Expected: Receiver API tests and all pre-existing static/API tests pass.

- [x] **Step 6: Commit the API implementation and tests.**

```bash
git add tools/ground_console.py tools/test_ground_console_static.py
git commit -m "feat: add local Receiver APIs"
```

### Task 3: Serve the embedded Receiver build safely

**Files:**
- Create: `.gitmodules`
- Add submodule: `vendor/BrowSDR` at `54f6cb7c0d69848461eedc46d278518be6f939d3`
- Create: `tools/build_browsdr_receiver.py`
- Create: `tools/browsdr_receiver_overlay/src/client/` with Receiver-specific source overlays for the pinned BrowSDR revision
- Create: `tools/test_build_browsdr_receiver.py`
- Create: `frontend/src/receiver-embedded-theme.css`
- Modify: `tools/ground_console.py`
- Modify: `tools/test_ground_console_static.py`

**Interfaces:**
- `tools/build_browsdr_receiver.py` requires an exact clean checkout of the pinned BrowSDR revision, applies the checked-in Receiver client overlay, builds generated `frontend/dist/receiver`, and verifies `/receiver/` asset roots, PWA scope, required WASM files, and removal of forbidden remote-sharing code.
- `ConsoleHandler._send_frontend(request_path)` maps `/receiver` and `/receiver/...` only to `frontend/dist/receiver`; Receiver CSP and WebUSB/autoplay policy are receiver-only.

- [x] **Step 1: Add a fixture-backed static-serving test named `test_receiver_fixture_static_serving_uses_receiver_policy` before changing the server.** Extend `ConsoleHTTPHarness` so the test can supply a temporary build root containing a Ground Console index plus a minimal Receiver `index.html` and asset. Assert `/receiver` and `/receiver/`, same-origin assets, Receiver CSP and `usb=(self), autoplay=(self)`, and unchanged Ground Console CSP/Permissions-Policy headers.
- [x] **Step 2: Add `test_receiver_fixture_static_boundary_rejects_escape_paths` against the temporary build root.** Cover literal/encoded traversal, dotfiles, symlink escape, and unsupported extensions; expect 404 for every escape.
- [x] **Step 3: Run the new static tests and confirm `/receiver/` fails under the current `/` and `/assets/`-only allowlist.**

Run: `PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_ground_console_static`

Expected: the Receiver fixture tests fail because the current server rejects `/receiver/`.

- [x] **Step 4: Update `_send_frontend` to select the Receiver root only for `/receiver` paths.** Keep root and asset allowlists disjoint; preserve path traversal, symlink, dotfile, cache, and existing Ground Console CSP behavior. Permit only the Receiver bundle's required MIME types (`.mjs`, `.json`, `.map`, `.webmanifest`, image/font, `.wasm`, audio, text, and gzip types) within the Receiver root. Apply WebUSB/autoplay policy only to Receiver responses and preserve the source-archive disposition.
- [x] **Step 5: Add the BrowSDR submodule at `https://github.com/sanadunt/BrowSDR.git` and port the build script/theme integration.** Require an exact clean checkout at `54f6cb7c0d69848461eedc46d278518be6f939d3`; apply the checked-in Receiver source overlay before the embedding transformations. Do not commit `frontend/dist`.
- [x] **Step 6: Build the Receiver and run the real-build static tests.**

Run: `.venv/bin/python tools/build_browsdr_receiver.py`

Then run: `PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_ground_console_static`

Expected: the builder reports `frontend/dist/receiver`; `test_receiver_is_same_origin_scoped_and_serves_source` and the built-asset `test_receiver_static_boundary_blocks_traversal_and_unknown_extensions` pass without skips. The Ground Console root retains its existing headers; USB/autoplay permissions are present only on Receiver responses.

- [x] **Step 7: Commit the submodule, builder, overlay, theme, serving changes, and tests.**

```bash
git add .gitmodules vendor/BrowSDR tools/build_browsdr_receiver.py tools/browsdr_receiver_overlay tools/test_build_browsdr_receiver.py frontend/src/receiver-embedded-theme.css tools/ground_console.py tools/test_ground_console_static.py docs/superpowers/plans/2026-10-09-receiver-integration.md
git commit -m "feat: build and serve embedded Receiver"
```

### Task 4: Add the Receiver menu and page

**Files:**
- Modify: `frontend/src/components/Shell.tsx`
- Modify: `frontend/src/components/ui.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/lib/i18n.ts`
- Modify: `frontend/src/lib/i18n.test.ts`
- Modify: `frontend/src/console-design.css`
- Create: `frontend/src/pages/ReceiverPage.tsx`
- Create: `frontend/src/components/Shell.test.tsx`

**Interfaces:**
- Add route literal `receiver` to `RouteName` and the exported `ROUTES` array.
- Add a `receiver` SVG icon to `IconName`/`Icon`; append Receiver as route 7 to preserve existing 1–6 keyboard assignments.
- `ReceiverPage(): JSX.Element` renders the same-origin `/receiver/` iframe and synchronizes the theme through `console-theme-change`.
- `App.tsx` lazy-loads/prefetches `ReceiverPage` and renders it for route `receiver`.

- [ ] **Step 1: Add failing translation and shell-render tests.** In `i18n.test.ts`, assert the English and Indonesian Receiver label/hint are available and non-empty. In `Shell.test.tsx`, render `ConsoleShell` with route `receiver` and assert the navigation shows Receiver as the current page with `aria-keyshortcuts="7"`.
- [ ] **Step 2: Run the focused frontend tests and confirm they fail because the route/messages are absent.**

Run: `npm test -- src/components/Shell.test.tsx src/lib/i18n.test.ts` (from `frontend/`)

Expected: the route is missing from navigation and the Receiver translation contract fails.

- [ ] **Step 3: Add the route and localized navigation contract.** Add the route to the end of `ROUTES`, English/Indonesian label and hint keys, and update shortcut help from 1–6 to 1–7. Add the receiver icon.
- [ ] **Step 4: Wire the lazy page, route switch, and route-specific shell/page classes.** Preserve existing Overview behavior and focus handling.
- [ ] **Step 5: Create `ReceiverPage.tsx` with the same-origin iframe, `allow="usb; autoplay"`, eager loading, and safe same-origin theme synchronization/cleanup.**
- [ ] **Step 6: Add Receiver full-height responsive CSS in `console-design.css`; keep the Ground Console top bar and navigation visible.**
- [ ] **Step 7: Run focused tests, then frontend checks, full tests, and build.**

Run from `frontend/`: `npm test -- src/components/Shell.test.tsx src/lib/i18n.test.ts`, then `npm run check && npm test && npm run build`.

Expected: focused route/locale tests pass; all existing frontend checks/tests pass; Vite emits the Receiver page chunk and shell assets.

- [ ] **Step 8: Commit the frontend route and page.**

```bash
git add frontend/src/components/Shell.tsx frontend/src/components/ui.tsx frontend/src/App.tsx frontend/src/lib/i18n.ts frontend/src/lib/i18n.test.ts frontend/src/console-design.css frontend/src/pages/ReceiverPage.tsx frontend/src/components/Shell.test.tsx
git commit -m "feat: add Receiver navigation and page"
```

### Task 5: Document setup and verify the complete Receiver path

**Files:**
- Modify: `QUICKSTART.md`

- [ ] **Step 1: Document submodule initialization and Receiver build.** Explain `git clone --recurse-submodules` (or `git submodule update --init --recursive` for an existing clone), Python 3.9+, Node.js 22 or later, and `.venv/bin/python tools/build_browsdr_receiver.py`; keep `frontend/dist` documented as generated output.
- [ ] **Step 2: Run focused backend tests and build checks.**

Run from repo root:

```bash
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_receiver_record_store
.venv/bin/python tools/build_browsdr_receiver.py
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tools.test_ground_console_static
cd frontend && npm run check && npm test && npm run build
```

Expected: all focused Python tests and frontend checks/tests pass; the embedded Receiver build and frontend build both produce their required output.

- [ ] **Step 3: Start Ground Console on loopback with temporary branding/config/Receiver data paths and MQTT disabled.** Do not connect a hardware receiver or trigger scan/record operations during this smoke.
- [ ] **Step 4: In a real browser, select the Receiver menu and verify `#/receiver`, active menu, navigate away then press `7` from the parent shell to select Receiver, iframe title and `/receiver/` load, representative asset and `/api/receiver/settings`/`marker-sets` requests, and theme propagation. Confirm no console errors from app code; report missing hardware separately.
- [ ] **Step 5: Re-run `npm run check`, `npm test`, `npm run build`, the two Python Receiver/static tests, and the Browser smoke after any fixes.**
- [ ] **Step 6: Commit the setup documentation.**

```bash
git add QUICKSTART.md
git commit -m "docs: document embedded Receiver setup"
```

**Completion evidence:** report branch/commit history, test and build outputs, browser path observed, any unavailable hardware proof, and confirmation that `main`, unrelated worktrees, and generated build output were untouched/not committed.
