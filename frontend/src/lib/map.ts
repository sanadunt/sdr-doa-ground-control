import type { Candidate, GpsConfig, GpsResolution, GpsSourceMode, ManualGpsOverride, MapCoordinate, TelemetrySnapshot } from '../types';

export const DEFAULT_OSM_TILE_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
// Public OSM-derived tile endpoint tried first because some networks reject the
// main tile.openstreetmap.org host even when the browser has normal HTTPS access.
// Both endpoints are free; neither requires an API key.
export const FALLBACK_OSM_TILE_TEMPLATE = 'https://tile.openstreetmap.de/{z}/{x}/{y}.png';
/**
 * Tile hosts in the order they are tried. The map uses one host at a time:
 * MapLibre spreads a multi-URL `tiles` array across hosts by tile index rather
 * than retrying, which leaves a checkerboard when one host is blocked.
 */
export const OSM_TILE_TEMPLATES = [FALLBACK_OSM_TILE_TEMPLATE, DEFAULT_OSM_TILE_TEMPLATE] as const;
/** Consecutive failed tiles on one host before the next host is tried. */
export const BASEMAP_FAILURES_PER_HOST = 4;
/** Failures right after a host switch may still come from the previous host's requests. */
export const BASEMAP_SWITCH_GRACE_MS = 1500;

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
}

export function initialBasemapHealth(hostIndex = 0): BasemapHealth {
  return { hostIndex, failures: 0, hostsFailed: 0, loaded: false, unavailable: false, switchedAtMs: null };
}

/**
 * Leave a failing or silent host for the next one. Once every host failed the
 * basemap is reported unavailable, and further calls keep retrying the hosts
 * in turn until a tile loads.
 */
export function nextBasemapHost(state: BasemapHealth, hostCount: number, nowMs: number): BasemapHealth {
  const count = Math.max(1, hostCount);
  const hostsFailed = Math.min(count, state.hostsFailed + 1);
  return { hostIndex: (state.hostIndex + 1) % count, failures: 0, hostsFailed, loaded: false, unavailable: hostsFailed >= count, switchedAtMs: nowMs };
}

/**
 * Count loaded and failed basemap tiles. A loaded tile clears every failure.
 * Failures only move to the next host until all hosts failed; after that the
 * caller's periodic check retries, so a dead network does not cause a reload loop.
 */
export function basemapAfterTile(state: BasemapHealth, loaded: boolean, hostCount: number, nowMs: number): BasemapHealth {
  if (loaded) return state.loaded && state.failures === 0 && !state.unavailable ? state : { ...initialBasemapHealth(state.hostIndex), loaded: true };
  if (state.unavailable || (state.switchedAtMs !== null && nowMs - state.switchedAtMs < BASEMAP_SWITCH_GRACE_MS)) return state;
  const failures = state.failures + 1;
  return failures < BASEMAP_FAILURES_PER_HOST ? { ...state, failures } : nextBasemapHost(state, hostCount, nowMs);
}

export const DEFAULT_FALLBACK_COORDINATE = Object.freeze({ latitude: -6.932468839245536, longitude: 107.66069405900005 });
export const DEFAULT_GPS_CONFIG: GpsConfig = {
  source: 'DATA_OUT',
  manualLatitude: DEFAULT_FALLBACK_COORDINATE.latitude,
  manualLongitude: DEFAULT_FALLBACK_COORDINATE.longitude,
};
const ALLOWED_TILE_HOST = 'tile.openstreetmap.org';
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

export function resolveStationCoordinate(snapshot: TelemetrySnapshot | null | undefined): MapCoordinate | null {
  if (!snapshot || snapshot.status?.available !== true) return null;
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

/**
 * Only the approved OSM HTTPS host is accepted. Keeping the template check
 * here prevents a Vite env value from becoming an unrestricted image proxy.
 */
export function safeOsmTileTemplate(template: string | undefined = DEFAULT_OSM_TILE_TEMPLATE): string {
  const candidate = template?.trim() || DEFAULT_OSM_TILE_TEMPLATE;
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== 'https:'
      || parsed.hostname.toLowerCase() !== ALLOWED_TILE_HOST
      || parsed.search
      || parsed.hash
      || !parsed.pathname.endsWith('.png')
      || !parsed.pathname.includes('{z}')
      || !parsed.pathname.includes('{x}')
      || !parsed.pathname.includes('{y}')
    ) {
      return DEFAULT_OSM_TILE_TEMPLATE;
    }
    return candidate;
  } catch {
    return DEFAULT_OSM_TILE_TEMPLATE;
  }
}

export function osmTileUrlForIndex(
  x: number,
  y: number,
  zoom = 13,
  template = DEFAULT_OSM_TILE_TEMPLATE,
): string {
  const safeZoom = Math.max(1, Math.min(19, Math.trunc(zoom)));
  const scale = 2 ** safeZoom;
  const normalizedX = ((Math.trunc(x) % scale) + scale) % scale;
  const safeY = Math.max(0, Math.min(scale - 1, Math.trunc(y)));
  return safeOsmTileTemplate(template)
    .replace('{z}', String(safeZoom))
    .replace('{x}', String(normalizedX))
    .replace('{y}', String(safeY));
}

export function osmTileUrl(
  coordinate: MapCoordinate,
  zoom = 13,
  template = DEFAULT_OSM_TILE_TEMPLATE,
): string {
  const safeZoom = Math.max(1, Math.min(19, Math.trunc(zoom)));
  const scale = 2 ** safeZoom;
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, coordinate.latitude));
  const x = Math.floor(((coordinate.longitude + 180) / 360) * scale);
  const latitudeRadians = latitude * Math.PI / 180;
  const y = Math.floor(
    (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * scale,
  );
  return osmTileUrlForIndex(x, y, safeZoom, template);
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
