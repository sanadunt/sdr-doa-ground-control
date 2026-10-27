import type { Candidate, GpsConfig, GpsResolution, GpsSourceMode, ManualGpsOverride, MapCoordinate, TelemetrySnapshot } from '../types';
import type { BasemapTone } from './basemaps';
import { isMqttSnapshot, lightStatus, lightXml } from './telemetrySource';

// Basemap health. The console's tile route tries the upstream hosts itself
// (tools/tile_cache.py), so a style has one URL in the browser and hostCount
// is 1; the functions still take any count, one host at a time. A host here is
// one tile URL: MapLibre spreads a multi-URL `tiles` array across hosts by tile
// index rather than retrying, which leaves a checkerboard when one is blocked.
//
// Two outages are told apart. Unavailable: tiles fail and none has drawn since
// the style was chosen or last asked for again, or none of the style's tiles
// is drawn in the view any more. Partial: tiles keep failing while others
// draw, as offline with part of the view cached, where every cached tile that
// loads would otherwise hide the failures of the rest.

/** Consecutive failed tiles on one host before the next host is tried. */
export const BASEMAP_FAILURES_PER_HOST = 4;
/** Failures right after a host switch may still come from the previous host's requests. */
export const BASEMAP_SWITCH_GRACE_MS = 1500;
/**
 * BASEMAP_FAILURES_PER_HOST failures within this window, while a tile of the
 * style has drawn, make the basemap partial. A retry of a partial basemap
 * waits this long for its tiles before it is judged; the tile route answers
 * within 10 s (two hosts, 5 s each).
 */
export const BASEMAP_PARTIAL_WINDOW_MS = 15_000;

export interface BasemapHealth {
  hostIndex: number;
  /** Consecutive failed tiles on the current host. */
  failures: number;
  /** Hosts that failed since the last loaded tile. */
  hostsFailed: number;
  /** A tile loaded on the current host since it was selected. */
  loaded: boolean;
  /** Every host failed since the last loaded tile. */
  unavailable: boolean;
  switchedAtMs: number | null;
  /** Tiles keep failing while others draw. */
  partial: boolean;
  /** When the partial state began or was last confirmed; its retry is due a retry interval later. */
  partialSinceMs: number | null;
  /** A retry of the partial basemap that waits for its tiles. */
  partialRetryAtMs: number | null;
  /** Times of the last BASEMAP_FAILURES_PER_HOST failed tiles, oldest first. */
  recentFailuresMs: readonly number[];
  lastLoadedAtMs: number | null;
}

export type BasemapNotice = 'unavailable' | 'partial' | null;

export function initialBasemapHealth(hostIndex = 0): BasemapHealth {
  return {
    hostIndex, failures: 0, hostsFailed: 0, loaded: false, unavailable: false, switchedAtMs: null,
    partial: false, partialSinceMs: null, partialRetryAtMs: null, recentFailuresMs: [], lastLoadedAtMs: null,
  };
}

/** The map notice for a basemap state; unavailable wins over partial. */
export function basemapNotice(state: BasemapHealth): BasemapNotice {
  if (state.unavailable) return 'unavailable';
  return state.partial ? 'partial' : null;
}

function failureBurst(failures: readonly number[], nowMs: number): boolean {
  return failures.length >= BASEMAP_FAILURES_PER_HOST && nowMs - failures[failures.length - BASEMAP_FAILURES_PER_HOST] <= BASEMAP_PARTIAL_WINDOW_MS;
}

function withPartial(state: BasemapHealth, nowMs: number): BasemapHealth {
  return state.partial ? state : { ...state, partial: true, partialSinceMs: nowMs, partialRetryAtMs: null };
}

/**
 * Leave a failing or silent host for the next one. Once every host failed the
 * basemap is reported unavailable, and further calls keep retrying the hosts
 * in turn until a tile loads.
 */
export function nextBasemapHost(state: BasemapHealth, hostCount: number, nowMs: number): BasemapHealth {
  const count = Math.max(1, hostCount);
  const hostsFailed = Math.min(count, state.hostsFailed + 1);
  return { ...state, hostIndex: (state.hostIndex + 1) % count, failures: 0, hostsFailed, loaded: false, unavailable: hostsFailed >= count, switchedAtMs: nowMs };
}

/**
 * Count loaded and failed basemap tiles. A loaded tile clears the host
 * failures. Before any tile loaded, failures move to the next host until all
 * hosts failed; after that the caller's periodic check retries, so a dead
 * network does not cause a reload loop. Once a tile loaded, failures only
 * count towards the partial state.
 */
export function basemapAfterTile(state: BasemapHealth, loaded: boolean, hostCount: number, nowMs: number): BasemapHealth {
  if (loaded) {
    let next: BasemapHealth = { ...state, failures: 0, hostsFailed: 0, loaded: true, unavailable: false, switchedAtMs: null, lastLoadedAtMs: nowMs };
    // After an outage the partial state starts over from the failures just seen.
    if (state.unavailable) next = { ...next, partial: false, partialSinceMs: null, partialRetryAtMs: null };
    return failureBurst(next.recentFailuresMs, nowMs) ? withPartial(next, nowMs) : next;
  }
  const counted = { ...state, recentFailuresMs: [...state.recentFailuresMs, nowMs].slice(-BASEMAP_FAILURES_PER_HOST) };
  if (state.loaded) return failureBurst(counted.recentFailuresMs, nowMs) ? withPartial(counted, nowMs) : counted;
  if (state.unavailable || (state.switchedAtMs !== null && nowMs - state.switchedAtMs < BASEMAP_SWITCH_GRACE_MS)) return counted;
  const failures = state.failures + 1;
  return failures < BASEMAP_FAILURES_PER_HOST ? { ...counted, failures } : nextBasemapHost(counted, hostCount, nowMs);
}

/**
 * A partial basemap whose view draws none of its tiles any more, as after
 * panning offline to an area never viewed, is unavailable: earlier tiles drew
 * elsewhere, not here. drawn is null when the renderer cannot tell; the
 * partial retry then decides.
 */
export function basemapAfterView(state: BasemapHealth, drawn: boolean | null, hostCount: number, nowMs: number): BasemapHealth {
  if (drawn !== false || !state.partial || state.unavailable) return state;
  return nextBasemapHost({ ...state, partialRetryAtMs: null }, hostCount, nowMs);
}

/**
 * Periodic check of a partial basemap: MapLibre does not ask for a failed tile
 * again by itself, so every retryMs the caller reloads the style's tiles
 * (reload: true). The retry is judged BASEMAP_PARTIAL_WINDOW_MS later: no
 * failure since clears the partial state, failures with loaded tiles keep it,
 * and failures with nothing loaded make the basemap unavailable.
 */
export function basemapPartialCheck(state: BasemapHealth, hostCount: number, nowMs: number, retryMs: number): { state: BasemapHealth; reload: boolean } {
  if (!state.partial || state.unavailable) return { state, reload: false };
  const retryAt = state.partialRetryAtMs;
  if (retryAt === null) {
    return nowMs - (state.partialSinceMs ?? nowMs) >= retryMs ? { state: { ...state, partialRetryAtMs: nowMs }, reload: true } : { state, reload: false };
  }
  if (nowMs - retryAt < BASEMAP_PARTIAL_WINDOW_MS) return { state, reload: false };
  const lastFailure = state.recentFailuresMs.length ? state.recentFailuresMs[state.recentFailuresMs.length - 1] : null;
  if (lastFailure === null || lastFailure < retryAt) return { state: { ...state, partial: false, partialSinceMs: null, partialRetryAtMs: null }, reload: false };
  if (state.lastLoadedAtMs !== null && state.lastLoadedAtMs >= retryAt) return { state: { ...state, partialSinceMs: retryAt, partialRetryAtMs: null }, reload: false };
  return { state: nextBasemapHost({ ...state, partialRetryAtMs: null }, hostCount, nowMs), reload: false };
}

/**
 * Basemap health when the map mounts again on Overview. A known outage carries
 * over, so its notice shows at once instead of after the next round of tile
 * failures; otherwise the map starts fresh on the last host that worked. A
 * partial state is found again from the new map's own tiles.
 */
export function resumeBasemapHealth(memory: BasemapHealth | null, preferredHost: number, hostCount: number): BasemapHealth {
  if (memory?.unavailable) return { ...memory, failures: 0, loaded: false, partial: false, partialSinceMs: null, partialRetryAtMs: null };
  return initialBasemapHealth(Math.max(0, Math.trunc(preferredHost)) % Math.max(1, hostCount));
}

export interface BasemapPaint {
  /** Map background, seen wherever no tile is drawn. */
  background: string;
  rings: string;
  guides: string;
  /** -3 dB edge lines. */
  edges: string;
  edgeWidth: number;
  lobeOutline: string;
}

/**
 * Background and reference-line colours. The background follows the console
 * theme. The lines follow what they are drawn on: the style's tiles once they
 * load (Dark and the imagery styles are dark, the others light), otherwise
 * the theme's background, so on a dark surface they turn light to stay readable.
 */
export function basemapPaint(theme: 'light' | 'dark', tilesLoaded: boolean, tone: BasemapTone = 'light'): BasemapPaint {
  const background = theme === 'dark' ? '#1b242d' : '#dfe4dc';
  const surface = tilesLoaded ? tone : theme;
  if (surface === 'dark') return { background, rings: '#c3ced8', guides: '#9aabba', edges: '#ff8a5c', edgeWidth: 2, lobeOutline: '#ebbc70' };
  return { background, rings: '#1f2d3a', guides: '#34495c', edges: '#e0603a', edgeWidth: 1.5, lobeOutline: '#c98a2e' };
}

export const DEFAULT_FALLBACK_COORDINATE = Object.freeze({ latitude: -6.932468839245536, longitude: 107.66069405900005 });
export const DEFAULT_GPS_CONFIG: GpsConfig = {
  source: 'DATA_OUT',
  manualLatitude: DEFAULT_FALLBACK_COORDINATE.latitude,
  manualLongitude: DEFAULT_FALLBACK_COORDINATE.longitude,
};
const GPS_DISABLED_STATES = new Set(['disabled', 'off', 'none', 'unavailable', 'not fixed', 'no fix']);
const GPS_POSITIVE_STATES = new Set(['fix', 'fixed', 'enabled', 'active', 'ok', 'pass', 'connected', 'locked', '3d fix', 'gps fix']);
const COORDINATE_EPSILON = 1e-7;

function finiteCoordinate(value: unknown, lower: number, upper: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= lower && value <= upper;
}

export interface ManualGpsValidation {
  override: ManualGpsOverride | null;
  error: string | null;
}

function finiteInput(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** Validate UI-entered GPS values without coercing empty or malformed input. */
export function manualGpsOverrideFromInput(latitudeInput: unknown, longitudeInput: unknown): ManualGpsValidation {
  const latitude = finiteInput(latitudeInput);
  if (latitude === null) return { override: null, error: 'Latitude must be a finite number.' };
  if (!finiteCoordinate(latitude, -90, 90)) return { override: null, error: 'Latitude must be between −90 and 90.' };

  const longitude = finiteInput(longitudeInput);
  if (longitude === null) return { override: null, error: 'Longitude must be a finite number.' };
  if (!finiteCoordinate(longitude, -180, 180)) return { override: null, error: 'Longitude must be between −180 and 180.' };
  if (latitude === 0 && longitude === 0) return { override: null, error: 'Latitude and longitude cannot both be 0.' };

  return { override: { enabled: true, latitude, longitude }, error: null };
}

/** Turn an enabled, validated manual override into the map's coordinate shape. */
export function manualGpsCoordinate(override: ManualGpsOverride | null | undefined): MapCoordinate | null {
  if (override?.enabled !== true) return null;
  const validated = manualGpsOverrideFromInput(override.latitude, override.longitude).override;
  return validated ? { latitude: validated.latitude, longitude: validated.longitude, source: 'MANUAL' } : null;
}

function fallbackCoordinate(): MapCoordinate {
  return { ...DEFAULT_FALLBACK_COORDINATE, source: 'FALLBACK' };
}

export function resolveGpsSource(
  snapshot: TelemetrySnapshot | null | undefined,
  config: GpsConfig = DEFAULT_GPS_CONFIG,
): GpsResolution {
  const selectedSource = config.source;
  if (selectedSource === 'MANUAL') {
    const manual = manualGpsOverrideFromInput(config.manualLatitude, config.manualLongitude).override;
    return manual
      ? {
          coordinate: { latitude: manual.latitude, longitude: manual.longitude, source: 'MANUAL' },
          selectedSource,
          effectiveSource: 'MANUAL',
          label: 'MANUAL GPS',
          detail: 'Using the locally entered coordinate; remote telemetry is not modified.',
        }
      : {
          coordinate: null,
          selectedSource,
          effectiveSource: 'MANUAL',
          label: 'MANUAL GPS INVALID',
          detail: 'Manual latitude/longitude is invalid; map request remains held.',
        };
  }
  if (selectedSource === 'FALLBACK') {
    return {
      coordinate: fallbackCoordinate(),
      selectedSource,
      effectiveSource: 'FALLBACK',
      label: 'DEFAULT FALLBACK',
      detail: 'Using the configured fallback station location; this is not a live GPS fix.',
    };
  }
  const dataOut = resolveStationCoordinate(snapshot);
  if (dataOut) {
    return {
      coordinate: { ...dataOut, source: 'DATA_OUT' },
      selectedSource,
      effectiveSource: 'DATA_OUT',
      label: 'DATA_OUT GPS',
      detail: 'Using a fresh, valid, mutually consistent station coordinate from Data Out.',
    };
  }
  return {
    coordinate: fallbackCoordinate(),
    selectedSource,
    effectiveSource: 'FALLBACK',
    label: 'DATA_OUT GPS · DEFAULT FALLBACK',
    detail: 'Data Out GPS is unavailable or invalid; using the configured fallback station location.',
  };
}

export interface HeldStation {
  coordinate: MapCoordinate | null;
  /** The coordinate is the last live Data Out fix, kept through a freshness gap. */
  held: boolean;
  lastLive: MapCoordinate | null;
}

/**
 * A fresh, readable status record says the node has no GPS fix: its
 * gps_status is missing, disabled or not a positive fix state. A CONFLICT, a
 * missing DoA view or a stale record does not say that.
 */
export function gpsReportsNoFix(snapshot: TelemetrySnapshot | null | undefined, localFresh: boolean): boolean {
  if (!localFresh || snapshot?.status?.available !== true) return false;
  if (isMqttSnapshot(snapshot)) {
    // Over MQTT only the light Data Out read knows the GPS state.
    const status = lightStatus(snapshot);
    if (!status) return false;
    const safe = status.safe !== null && typeof status.safe === 'object' ? status.safe as Record<string, unknown> : {};
    const light = safe.gps_status;
    return typeof light !== 'string' || !GPS_POSITIVE_STATES.has(light.trim().toLowerCase());
  }
  const raw = snapshot.status.safe?.gps_status;
  return typeof raw !== 'string' || !GPS_POSITIVE_STATES.has(raw.trim().toLowerCase());
}

/**
 * Keep the last live Data Out station position while the current read gives
 * no usable coordinate (local freshness gap, failed status read, CSV/XML
 * conflict, missing view) instead of jumping to the configured fallback
 * position. Only a read that reports no fix (gpsReportsNoFix) drops the
 * memory. An explicit FALLBACK or MANUAL choice is never replaced.
 */
export function holdStationCoordinate(
  lastLive: MapCoordinate | null,
  coordinate: MapCoordinate | null,
  noFixReported: boolean,
  selectedSource: GpsSourceMode = 'DATA_OUT',
): HeldStation {
  if (coordinate?.source === 'DATA_OUT') return { coordinate, held: false, lastLive: coordinate };
  if (selectedSource !== 'DATA_OUT' || coordinate?.source !== 'FALLBACK') return { coordinate, held: false, lastLive };
  if (noFixReported) return { coordinate, held: false, lastLive: null };
  return lastLive ? { coordinate: lastLive, held: true, lastLive } : { coordinate, held: false, lastLive: null };
}

/** The station position source and GPS selection the camera was last framed on. */
export interface StationFraming {
  source: MapCoordinate['source'];
  selection: GpsSourceMode;
}

/**
 * Whether a new station position reframes the camera: the first position, a
 * new GPS source selection, simulation turning on or off, or a live/manual fix
 * that replaces the fallback. Losing a live fix to the fallback is not a
 * reason: the camera stays and only the marker moves.
 */
export function shouldReframeStation(framed: StationFraming | null, next: MapCoordinate['source'], selection: GpsSourceMode): boolean {
  if (!framed || framed.selection !== selection) return true;
  if (next === framed.source) return false;
  if (next === 'SIMULATION' || framed.source === 'SIMULATION') return true;
  return framed.source === 'FALLBACK';
}

export function coordinateFromCandidate(candidate: Candidate | undefined, source: MapCoordinate['source']): MapCoordinate | null {
  if (!candidate || candidate.available !== true) return null;
  const latitude = candidate.latitude;
  const longitude = candidate.longitude;
  if (!finiteCoordinate(latitude, -90, 90) || !finiteCoordinate(longitude, -180, 180)) return null;
  // The upstream contract uses 0/0 as an unset/Null-Island placeholder.
  if (latitude === 0 && longitude === 0) return null;
  const freshness = candidate.freshness;
  if (freshness?.fresh !== true || typeof freshness.age_ms !== 'number' || !Number.isFinite(freshness.age_ms) || freshness.age_ms < 0) {
    return null;
  }
  return { latitude, longitude, source };
}

/**
 * The station position of an MQTT answer: MQTT carries none, so it is the
 * doa.xml LOCATION of the light Data Out read, while that read had a positive
 * GPS fix and doa.xml was fresh against its status.json.
 */
function lightStationCoordinate(snapshot: TelemetrySnapshot): MapCoordinate | null {
  const status = lightStatus(snapshot);
  const safe = status?.safe !== null && typeof status?.safe === 'object' ? status.safe as Record<string, unknown> : {};
  const gps = typeof safe.gps_status === 'string' ? safe.gps_status.trim().toLowerCase() : '';
  if (!status || GPS_DISABLED_STATES.has(gps) || !GPS_POSITIVE_STATES.has(gps)) return null;
  return coordinateFromCandidate(lightXml(snapshot) ?? undefined, 'XML');
}

export function resolveStationCoordinate(snapshot: TelemetrySnapshot | null | undefined): MapCoordinate | null {
  if (!snapshot || snapshot.status?.available !== true) return null;
  if (isMqttSnapshot(snapshot)) return lightStationCoordinate(snapshot);
  const rawGpsStatus = snapshot.status.safe?.gps_status;
  if (typeof rawGpsStatus !== 'string') return null;
  const gpsStatus = rawGpsStatus.trim().toLowerCase();
  if (GPS_DISABLED_STATES.has(gpsStatus) || !GPS_POSITIVE_STATES.has(gpsStatus)) return null;
  if (snapshot.native_consistency?.comparable !== true || snapshot.native_consistency.conflict === true) return null;

  const candidates = snapshot.doa_candidates ?? {};
  const csvCoordinate = coordinateFromCandidate(candidates.csv, 'CSV');
  const xmlCoordinate = coordinateFromCandidate(candidates.xml, 'XML');
  if (!csvCoordinate || !xmlCoordinate) return null;
  const conflict = (
    Math.abs(csvCoordinate.latitude - xmlCoordinate.latitude) > COORDINATE_EPSILON
    || Math.abs(csvCoordinate.longitude - xmlCoordinate.longitude) > COORDINATE_EPSILON
  );
  if (conflict) return null;
  return csvCoordinate;
}

export function mapHasCoordinateConflict(snapshot: TelemetrySnapshot | null | undefined): boolean {
  if (isMqttSnapshot(snapshot)) return false;
  const candidates = snapshot?.doa_candidates ?? {};
  const csv = coordinateFromCandidate(candidates.csv, 'CSV');
  const xml = coordinateFromCandidate(candidates.xml, 'XML');
  return Boolean(csv && xml && (
    Math.abs(csv.latitude - xml.latitude) > COORDINATE_EPSILON
    || Math.abs(csv.longitude - xml.longitude) > COORDINATE_EPSILON
  ));
}

/** Readiness for the explicit local GPS test path; no live snapshot is involved. */
export function manualMapReadiness(override: ManualGpsOverride | null | undefined): {
  ready: boolean;
  label: string;
  detail: string;
} {
  const coordinate = manualGpsCoordinate(override);
  if (!coordinate) {
    return {
      ready: false,
      label: 'INVALID LOCAL GPS OVERRIDE',
      detail: 'Enter finite latitude/longitude within range; 0/0 is not accepted.',
    };
  }
  return {
    ready: true,
    label: 'LOCAL GPS OVERRIDE',
    detail: 'The online OSM viewport can load around this entered coordinate; live telemetry remains untouched.',
  };
}

export function mapReadiness(
  snapshot: TelemetrySnapshot | null | undefined,
  manualGpsOverride?: ManualGpsOverride | null,
): {
  ready: boolean;
  label: string;
  detail: string;
} {
  if (manualGpsOverride?.enabled === true) return manualMapReadiness(manualGpsOverride);

  const coordinate = resolveStationCoordinate(snapshot);
  if (coordinate) {
    return {
      ready: true,
      label: 'COORDINATES AVAILABLE',
      detail: `Fresh station position from ${coordinate.source}; no target marker or bearing ray is inferred.`,
    };
  }
  if (mapHasCoordinateConflict(snapshot)) {
    return {
      ready: false,
      label: 'CONFLICT',
      detail: 'CSV / XML station coordinates conflict; the OSM viewport and station marker remain held.',
    };
  }
  const rawGps = snapshot?.status?.safe?.gps_status;
  const gps = typeof rawGps === 'string' ? rawGps.trim().toLowerCase() : '';
  if (GPS_DISABLED_STATES.has(gps)) {
    return {
      ready: false,
      label: 'NOT CONFIGURED',
      detail: 'GPS is disabled or has no fix; 0/0 is treated as unset and the OSM viewport remains held.',
    };
  }
  if (!GPS_POSITIVE_STATES.has(gps)) {
    return {
      ready: false,
      label: 'NOT CONFIGURED',
      detail: 'A positive GPS fix status is required before requesting the OSM viewport.',
    };
  }
  if (snapshot?.native_consistency?.comparable !== true) {
    return {
      ready: false,
      label: 'UNAVAILABLE',
      detail: 'CSV / XML coordinates are not comparable; the OSM viewport and station marker remain held.',
    };
  }
  return {
    ready: false,
    label: snapshot ? 'UNAVAILABLE' : 'WAITING',
    detail: 'No fresh, valid, mutually consistent station coordinates are present.',
  };
}
