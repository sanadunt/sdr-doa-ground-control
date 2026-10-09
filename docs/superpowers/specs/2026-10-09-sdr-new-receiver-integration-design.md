# Receiver Integration in sdr-new

## Status

Proposed; awaiting user review.

## Date

2026-10-09

## Context

The user wants a new branch in `/home/rdf/Documents/sdr-new/sdr-doa-ground-control` that adds a functioning Receiver. The clone was clean on `main` at `19bd9bdfb3a57d8a7abe2592fd0e75aba534fabc`, the merge of the Claude branch. Its committed tree matches Claude commit `e1d505299b9813b2336d84fb4008901bf184174e`; it has no Receiver menu, embedded `/receiver/` build, static-serving support, or Receiver APIs. A local smoke run rendered the six existing routes and confirmed `/receiver/` returns 404.

The Receiver implementation to port is available in the separate feature worktree. It includes a Receiver page, a pinned BrowSDR source/build, a local record store, API handlers, and static-serving protections. The feature worktree also contains unrelated System Health/MQTT changes and dirty edits; those are out of scope.

## Goals

- Keep `main` at its current commit and implement on a dedicated local branch, `feature/receiver-integration`, based on `sdr-new/main`.
- Add a complete, usable Receiver view rather than a menu that leads to 404.
- Port only Receiver-specific code and dependencies; preserve other repositories and worktrees.
- Serve the embedded Receiver and its local APIs same-origin through Ground Console.
- Keep the Receiver's browser-local WebUSB path separate from the SDR-DoA Data Out collector and publication gate; do not add remote writes to SDR-DoA.
- Do not push the branch or commit generated `frontend/dist` output.

## Non-goals

- Merge unrelated System Health, MQTT, Docker, or other feature work.
- Change the SDR-DoA telemetry schema, collector, or publication readiness.
- Claim hardware operation without testing on supported HackRF hardware.

## Design

### Branch boundary

All changes go to `feature/receiver-integration` in `sdr-new`, whose starting commit is `19bd9bdfb3a57d8a7abe2592fd0e75aba534fabc`. Do not edit `main` or the original source worktrees. Port Receiver code selectively; adapt shared files to this branch rather than replacing them wholesale.

### Frontend route and page

Add `receiver` to `RouteName` and the primary route list, provide an icon and English/Indonesian labels and hints, and update keyboard shortcut help for the seventh page. Wire a lazy route import and rendering in `App.tsx` consistent with the existing routes. Add route-specific full-height layout while retaining the Ground Console shell and navigation.

The Receiver page embeds same-origin `/receiver/` in an iframe and synchronizes the Ground Console theme. Browser permissions remain limited to those required by the Receiver UI. No remote Receiver URL is used.

### Embedded Receiver build and static assets

Add the pinned BrowSDR source submodule at revision `54f6cb7c0d69848461eedc46d278518be6f939d3` and the existing build integration that emits `frontend/dist/receiver`. Do not commit generated build output.

Extend Ground Console static serving so `/receiver` and `/receiver/...` map only to the built Receiver tree. Retain path traversal, symlink, dotfile, and allowlisted-root protections. Apply Receiver-specific CSP and WebUSB/autoplay permissions without loosening policy for other Ground Console pages. Preserve required MIME handling and source archive download behavior.

### Local Receiver APIs and storage

Port the Receiver record-store module and only the `/api/receiver/*` GET/POST/DELETE handlers required by the embedded UI. Preserve bounded payload reads, input/error handling, local persistence, and required binary/audio streaming behavior. These APIs do not call or modify SDR-DoA Data Out and do not affect its readiness/publication gate.

### Failure behavior and security

If Receiver assets are not built, `/receiver/` must return a bounded unavailable/not-found response; do not fall back to a remote site or expose upstream source. Invalid API requests and missing records return the established JSON error shape. Preserve Ground Console loopback binding, static path checks, request-size limits, and page-specific CSP.

## Alternatives considered

### Add only the menu and iframe

Rejected: the current clone returns 404 for `/receiver/` and has no local Receiver APIs, so the menu would be broken.

### Merge the whole feature branch

Rejected: that worktree contains unrelated System Health/MQTT and other dirty changes. Importing it would expand scope and risk overwriting the user's work.

### Selectively port the full Receiver feature

Selected: it adds the embedded UI, build, static serving, and local APIs while keeping the change isolated to `sdr-new` and the Receiver scope.

## Acceptance criteria

1. `main` and other worktrees remain unchanged; the implementation is on `feature/receiver-integration` based on `19bd9bd`.
2. Receiver appears in navigation and hash routing with English/Indonesian labels and keyboard shortcut support.
3. The pinned BrowSDR build produces the `/receiver/` assets; generated `dist` output is not committed.
4. Ground Console serves only allowed built assets and rejects traversal, symlink, dotfile, and non-build paths.
5. Receiver API tests cover representative settings, records/scans, and audio behavior using isolated local storage.
6. Frontend type checks, tests, and build pass; relevant Python static/API and record-store tests pass.
7. A loopback Ground Console smoke run renders the menu and loads `/receiver/`, required assets, and representative local API requests. Hardware-dependent WebUSB operation is reported separately.
8. Quickstart/setup documentation explains the submodule and Receiver build prerequisites.

## Verification plan

- Run `npm run check`, `npm test`, and `npm run build` in `frontend`.
- Initialize/verify the pinned submodule and run `tools/build_browsdr_receiver.py`; report any missing Node or package-network prerequisite accurately.
- Run focused Receiver record-store and Ground Console static/API tests, then the relevant Python suite.
- Launch Ground Console on loopback and exercise the Receiver menu, `/receiver/`, representative assets, and API calls in a real browser. Confirm no unexpected browser errors; do not infer hardware scanning from a no-device smoke run.

## Implementation-plan boundary

This document records the design only. After user review and approval, write and review a separate implementation plan before changing product code.
