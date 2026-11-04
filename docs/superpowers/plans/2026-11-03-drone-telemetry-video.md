# Drone telemetry and video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The console reads the SIYI drone's telemetry and video and puts them on the Dashboard, with drone GPS/yaw first and the RDF-SDR's shown beside them.

**Architecture:** A second, subscribe-only paho client (`tools/drone_link.py`) with auto discovery (`tools/drone_discovery.py`) feeds a `drone` block into `/api/drone` and every `/api/snapshot`. A host service (`packaging/drone-video/`) runs mediamtx + ffmpeg; the console reads its health from the mediamtx API and proxies WHEP same-origin. The browser adds `DRONE` GPS/compass sources, a drone marker and track, a Drone panel with video, and System Health cards.

**Tech Stack:** Python 3.9+ stdlib + paho-mqtt 2.1.0, React/TypeScript/Vitest, MapLibre, mediamtx, ffmpeg.

**Spec:** `docs/superpowers/specs/2026-11-03-drone-telemetry-video-design.md`

## Global Constraints

- Console port stays 8787. Never publish to the drone broker; subscribe to the eight explicit topics only.
- Drone topic stale after 10 000 ms; yaw used for a DoA only within 1000 ms of its sample; yaw history 60 s.
- Payload limit 4096 bytes; MAVLink unknowns (heading ≥ 360 / 655.35, hdop ≥ 99.99, lat/lon 0/0) read as null.
- Discovery: TCP 1883, 300 ms timeout, 64 parallel, `bridge/link` with boolean `fc_online` and string `version` within 2 s, rescan after 15 s disconnected.
- mediamtx: WebRTC `:8889`, ICE UDP `:8189`, API `127.0.0.1:9997`, RTSP `127.0.0.1:8654`; WHEP proxy body ≤ 64 KiB.
- Every UI string in EN and ID (`lib/i18n.ts`); Python 3.9 compatible; VERSION 3.13.0 with a CHANGELOG section.

## Review Focus

- Remote broker with hundreds of retained `drone/other/*` topics: not subscribed, never counted (test: subscription list is exactly the eight).
- Drone yaw wrapping 359 → 1 between samples: interpolate the short way (test `test_heading_at_wraps`).
- Groundstation's own broker on 1883 answering the scan: refused, no `bridge/link` (test `test_probe_refuses_broker_without_link`).
- mediamtx not installed / API down: `/api/drone/video` says `DOWN`, WHEP proxy 502, page shows the reason, no exception (tests in `test_drone_video.py`).
- Saved GPS preference `DATA_OUT` migrates once to `DRONE`; an explicit later choice of `DATA_OUT` sticks (Vitest).

---

### Task 1: Drone telemetry store and link

**Files:** Create `tools/drone_link.py`, `tools/fixtures/drone/*.json`, `tools/test_drone_link.py`.

**Interfaces — Produces:**
- `DRONE_TOPICS: tuple[str, ...]`, `STALE_MS = 10_000`, `HEADING_MATCH_MS = 1_000`
- `DroneStore.ingest(topic: str, payload: bytes, received_at_ms: int) -> bool`
- `DroneStore.heading_at(t_ms: int) -> Optional[Tuple[float, int]]` (deg 0..360, offset ms)
- `DroneStore.view(now_ms: int) -> dict` (spec "Bentuk blok drone" minus connection/discovery)
- `DroneLink(host: str, port: int = 1883, *, client_factory=None)` with `start()`, `stop()`, `view(now_ms=None)`, `heading_at(t_ms)`, `connection` property, `disconnected_for_ms(now_ms)`
- `with_drone(answer: Mapping, view: Optional[Mapping]) -> dict`

- [ ] Tests: each fixture topic parsed; unknowns null with `INVALID_FIELD` notes; >4096 bytes refused and counted; stale after 10 s; `test_heading_at_wraps` (359 at t=0, 1 at t=200 → 0 at t=100); no sample within 1 s → None; GPS fix 5/6 → rtk FLOAT/FIXED; `DroneLink` with a fake client subscribes exactly `DRONE_TOPICS`, never publishes, reports connection states.
- [ ] Implement; run `.venv/bin/python -m unittest tools.test_drone_link`; commit.

### Task 2: Discovery

**Files:** Create `tools/drone_discovery.py`, `tools/test_drone_discovery.py`.

**Interfaces — Produces:** `subnet_hosts(addresses: Iterable[str]) -> List[str]`; `scan(hosts, *, connect, probe, last_host=None, parallel=64) -> Optional[str]`; `DroneDiscovery(mode_host: str, *, on_found, connect=..., probe=..., interfaces=..., clock=...)` with `start()`, `stop()`, `status() -> dict`, `report_disconnected(ms)`; `probe_bridge_link(host, port=1883, timeout_s=2.0) -> Optional[dict]`.

- [ ] Tests: /24 from interface addresses without self and network/broadcast; probe without link refused; `fc_online` true preferred then lowest IP; last host tried first and wins without scan; rescan after 15 s disconnected (fake clock).
- [ ] Implement; run tests; commit.

### Task 3: Console wiring (config, routes, snapshot, LAN view, video health, WHEP proxy)

**Files:** Modify `tools/ground_console.py`, `tools/lan_access.py`; create `tools/test_drone_video.py`.

**Interfaces — Consumes:** Task 1 and 2. **Produces:** `GET /api/drone`, `GET /api/drone/video`, `POST /api/drone/video/whep`, `DELETE /api/drone/video/whep/<id>`, `drone` block on `/api/snapshot`, `drone` in `/api/console-config` (`enabled`, `host`, `port`, `array_heading_offset_deg`, `video_enabled`), `GroundConsoleServer(drone_link_factory=..., mediamtx_api=..., whep_upstream=...)`.

- [ ] Tests listed in the spec under `test_drone_video.py`; run them plus `tools.test_lan_access tools.test_preferences_store tools.test_data_out_hosts`; commit.

### Task 4: Video service kit

**Files:** Create `packaging/drone-video/{README.md,install.sh,uninstall.sh,drone-video-supervisor,drone-video.conf.example,drone-video.service.in}`, `tools/test_drone_video_kit.py`; modify `tools/make_release.py` (`DRONE_VIDEO_FILES`), `tools/test_make_release.py`, CI shellcheck line in `.github/workflows/ci.yml` and CLAUDE.md verification line.

**Interfaces — Produces:** `drone-video-supervisor` functions `build_config(camera_url, encoder, bitrate, additional_hosts, ffmpeg_bin) -> str`, `pick_encoder(requested, has_render_node, ffmpeg_encoders) -> str`, `camera_url_from_console(body: dict) -> Optional[str]`.

- [ ] Tests: config per encoder, auto pick, camera URL from a fake console, restart on host change, installer `--root` and `--dry-run`, shellcheck when present; commit.

### Task 5: Browser data layer and GPS/compass sources

**Files:** Create `frontend/src/lib/droneLink.ts`, `frontend/src/lib/droneLink.test.ts`; modify `types.ts`, `api.ts`, `lib/map.ts`, `lib/polar.ts`, `lib/sourceConfigStorage.ts`, `lib/i18n.ts`.

**Interfaces — Produces:** `normalizeDrone(value: unknown): DroneView | null`, `snapshotDrone(snapshot)`, `droneStation(view): MapCoordinate | null` (source `'DRONE'`), `droneHeadingAtDoa(view): number | null`, `positionGap(a, b): {distanceM, bearingDeg} | null`, `headingGap(a, b): number | null`, `GpsSourceMode` and `CompassSourceMode` gain `'DRONE'`.

- [ ] Tests: normalize lenient; station only LIVE + fix ≥ 3; resolveGpsSource DRONE → drone, else RDF-SDR path, else fallback; resolveCompassSource DRONE with heading_at_doa → offset = deg + array offset, label `DRONE YAW`; without → NODE_HEADING; migration of saved DATA_OUT; commit.

### Task 6: Dashboard, Drone panel with video, System Health, Configuration

**Files:** Create `components/overview/DronePanel.tsx`, `components/overview/DroneVideo.tsx`, `lib/whep.ts`, tests; modify `TacticalMap.tsx`, `NodeCard.tsx`, `OverviewPage.tsx`, `overviewPanels.ts`, `PanelToggles`, `SystemHealthPage.tsx`, `ConfigurationPage.tsx`, `App.tsx`, CSS.

- [ ] Tests: markup of panel (no data, live, stale), node card dual rows, health cards, config drone fields, panel preference; build; browser check against a fake drone broker and the mock; commit.

### Task 7: Docs, version, full verification, PR

- [ ] CLAUDE.md/AGENTS.md sections, `CHANGELOG.md` `## 3.13.0`, VERSION and compose tags; run the CLAUDE.md verification sequence; open the PR.
