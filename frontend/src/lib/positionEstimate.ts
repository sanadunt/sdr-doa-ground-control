import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import type { TelemetrySnapshot } from '../types';
import { bearingAndDistance, destination, type GeoOrigin } from './doaGeometry';
import { formatBearing } from './overlayPalette';
import type { MessageKey, Translate } from './i18n';

/**
 * The transmitter position estimate the console builds from the moving
 * RDF-SDR's bearings (tools/doa_position_estimate.py): the drone's GPS and yaw
 * at each sample first, the edge's own b, lat and lon (contract 1.10) where the
 * drone has none. ESTIMATE: rays from enough places cross; NEED_MOVEMENT: there is a
 * hot area but the rays do not cross from far enough apart yet, so it is not a
 * position; NO_DATA: no bearing with a position has come.
 */
export type PositionEstimateState = 'NO_DATA' | 'NEED_MOVEMENT' | 'ESTIMATE';

export interface PositionEstimateGrid {
  south: number;
  west: number;
  north: number;
  east: number;
  cells: number;
  /** [column east, row north, share of the peak 0..1]. */
  hot: Array<[number, number, number]>;
}

export interface PositionEstimate {
  state: PositionEstimateState;
  latitude: number | null;
  longitude: number | null;
  /** Radius of the area at half the peak or more, metres. */
  radiusM: number | null;
  /** From the place of the latest bearing (the drone, or the RDF-SDR's own GPS). */
  distanceM: number | null;
  bearingDeg: number | null;
  /** From the groundstation's own GNSS (ground_gps); null without a fix. */
  groundDistanceM: number | null;
  groundBearingDeg: number | null;
  groundLatitude: number | null;
  groundLongitude: number | null;
  /** Where the latest bearing's direction and place came from; null from an older console. */
  bearingSource: EstimateSource | null;
  positionSource: EstimateSource | null;
  samples: number;
  stations: number;
  spreadDeg: number | null;
  frequencyHz: number | null;
  minStations: number;
  minSpreadDeg: number;
  resetReason: string | null;
  grid: PositionEstimateGrid | null;
  /**
   * What the last skipped LIVE DoA lacked (tools/doa_position_estimate.py):
   * NO_BEARING (no b: no heading on the node), NO_POSITION (no lat/lon); null
   * once a sample is used, and from an older console.
   */
  waitingFor: 'NO_BEARING' | 'NO_POSITION' | null;
  /** LIVE DoA samples skipped for that reason so far; 0 when the last skip came before the last reset. */
  skipped: number;
  /** The node's GPS has a fix (nav.gps_state FIX); null when the node does not say. */
  nodeGpsFix: boolean | null;
  /**
   * The node says it does not send its position with the DoA
   * (capabilities.nav.position false: nav.gps.publish_position off); null when it does not say.
   */
  positionWithheld: boolean | null;
}

/** drone: the drone's GPS or yaw at the sample's time; rdf: the RDF-SDR's own GPS or compass. */
export type EstimateSource = 'drone' | 'rdf';

function source(value: unknown): EstimateSource | null {
  return value === 'drone' || value === 'rdf' ? value : null;
}

export const POSITION_ESTIMATE_RESET_ROUTE = '/api/position-estimate/reset';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finite(value: unknown, low = -Infinity, high = Infinity): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function parseGrid(value: unknown): PositionEstimateGrid | null {
  const grid = record(value);
  if (!grid) return null;
  const south = finite(grid.south, -90, 90);
  const north = finite(grid.north, -90, 90);
  const west = finite(grid.west, -180, 180);
  const east = finite(grid.east, -180, 180);
  const cells = finite(grid.cells, 1, 1000);
  if (south === null || north === null || west === null || east === null || cells === null || north <= south || !Number.isInteger(cells)) return null;
  const hot: Array<[number, number, number]> = [];
  if (Array.isArray(grid.hot)) {
    for (const cell of grid.hot.slice(0, 5000)) {
      if (!Array.isArray(cell) || cell.length !== 3) continue;
      const [column, row, share] = cell as unknown[];
      if (finite(column, 0, cells - 1) === null || finite(row, 0, cells - 1) === null || finite(share, 0, 1) === null) continue;
      hot.push([column as number, row as number, share as number]);
    }
  }
  return { south, west, north, east, cells, hot };
}

/** The estimate of an MQTT answer, or null when there is none (Data Out, simulation, an older console). */
export function positionEstimate(snapshot: TelemetrySnapshot | null | undefined): PositionEstimate | null {
  if (!snapshot || snapshot.simulation === true) return null;
  const value = record(snapshot.position_estimate);
  if (!value) return null;
  const state = value.state === 'ESTIMATE' || value.state === 'NEED_MOVEMENT' ? value.state : 'NO_DATA';
  const latitude = finite(value.latitude, -90, 90);
  const longitude = finite(value.longitude, -180, 180);
  const method = record(value.method) ?? {};
  // A skip from before "Start over" (or the console's start) says nothing about the estimate since.
  const skippedAt = finite(value.skipped_at_ms, 0);
  const resetAt = finite(value.reset_at_ms, 0);
  const skipCurrent = skippedAt === null || resetAt === null || skippedAt >= resetAt;
  return {
    state: state !== 'NO_DATA' && (latitude === null || longitude === null) ? 'NO_DATA' : state,
    latitude,
    longitude,
    radiusM: finite(value.radius_m, 0),
    distanceM: finite(value.distance_m, 0),
    bearingDeg: finite(value.bearing_deg, 0, 360),
    groundDistanceM: finite(value.ground_distance_m, 0),
    groundBearingDeg: finite(value.ground_bearing_deg, 0, 360),
    groundLatitude: finite(value.ground_latitude, -90, 90),
    groundLongitude: finite(value.ground_longitude, -180, 180),
    bearingSource: source(value.bearing_source),
    positionSource: source(value.position_source),
    samples: count(value.samples),
    stations: count(value.stations),
    spreadDeg: finite(value.spread_deg, 0, 360),
    frequencyHz: finite(value.frequency_hz, 1),
    minStations: count(method.min_stations) || 3,
    minSpreadDeg: finite(method.min_spread_deg, 0, 180) ?? 15,
    resetReason: typeof value.reset_reason === 'string' && /^[A-Z_]{1,32}$/u.test(value.reset_reason) ? value.reset_reason : null,
    grid: parseGrid(value.grid),
    waitingFor: skipCurrent && (value.waiting_for === 'NO_BEARING' || value.waiting_for === 'NO_POSITION') ? value.waiting_for : null,
    skipped: skipCurrent ? count(value.skipped) : 0,
    positionWithheld: positionWithheld(snapshot),
    nodeGpsFix: nodeGpsFix(snapshot),
  };
}

/** nav.gps_state of the node (telemetry/health): FIX or another state; null without one. */
function nodeGpsFix(snapshot: TelemetrySnapshot): boolean | null {
  const state = record(snapshot.nav)?.gps_state;
  return typeof state === 'string' ? state === 'FIX' : null;
}

/** capabilities.nav.position of the MQTT session: false when the node withholds its position. */
function positionWithheld(snapshot: TelemetrySnapshot): boolean | null {
  const position = record(record(record(snapshot.mqtt)?.capabilities)?.nav)?.position;
  return typeof position === 'boolean' ? !position : null;
}

/**
 * What the estimate waits for, in the operator's terms, or null: a node that
 * withholds its position (publish_position off), a node GPS without a fix, a
 * bearing without a position, or a DoA without a heading.
 */
export function estimateWaitKey(estimate: PositionEstimate): MessageKey | null {
  if (estimate.waitingFor === 'NO_POSITION') {
    if (estimate.positionWithheld === true) return 'estimate.waitPositionWithheld';
    return estimate.nodeGpsFix === false ? 'estimate.waitGpsFix' : 'estimate.waitPosition';
  }
  if (estimate.waitingFor === 'NO_BEARING') return 'estimate.waitBearing';
  return null;
}

/** Where the latest bearing came from, for the card; null from an older console. */
export function estimateSourceKey(estimate: PositionEstimate): MessageKey | null {
  const { bearingSource, positionSource } = estimate;
  if (bearingSource === null || positionSource === null) return null;
  if (bearingSource === 'drone') return positionSource === 'drone' ? 'estimate.sourceDrone' : 'estimate.sourceDroneYaw';
  return positionSource === 'drone' ? 'estimate.sourceDroneGps' : 'estimate.sourceRdf';
}

const EMPTY_POLYGONS: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: [] };
const EMPTY_LINES: FeatureCollection<LineString> = { type: 'FeatureCollection', features: [] };
const EMPTY_POINTS: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] };

export interface PositionEstimateFeatures {
  heat: FeatureCollection<Polygon>;
  /** The half-peak radius around the estimate and the lines from the RDF-SDR and the groundstation to it. */
  lines: FeatureCollection<LineString>;
  point: FeatureCollection<Point>;
}

export const NO_ESTIMATE_FEATURES: PositionEstimateFeatures = { heat: EMPTY_POLYGONS, lines: EMPTY_LINES, point: EMPTY_POINTS };

/** Map geometry: hot cells (share 0..1), and with an ESTIMATE its point, radius and the lines from the station and the groundstation. */
export function positionEstimateFeatures(estimate: PositionEstimate | null, station: GeoOrigin | null): PositionEstimateFeatures {
  if (!estimate || estimate.state === 'NO_DATA') return NO_ESTIMATE_FEATURES;
  const grid = estimate.grid;
  const heat: Array<Feature<Polygon>> = [];
  if (grid) {
    const dLat = (grid.north - grid.south) / grid.cells;
    const dLon = (grid.east - grid.west) / grid.cells;
    for (const [column, row, share] of grid.hot) {
      const s = grid.south + row * dLat;
      const w = grid.west + column * dLon;
      heat.push({
        type: 'Feature',
        properties: { share, ready: estimate.state === 'ESTIMATE' },
        geometry: { type: 'Polygon', coordinates: [[[w, s], [w + dLon, s], [w + dLon, s + dLat], [w, s + dLat], [w, s]]] },
      });
    }
  }
  if (estimate.state !== 'ESTIMATE' || estimate.latitude === null || estimate.longitude === null) {
    return { heat: { type: 'FeatureCollection', features: heat }, lines: EMPTY_LINES, point: EMPTY_POINTS };
  }
  const centre: GeoOrigin = { latitude: estimate.latitude, longitude: estimate.longitude };
  const lines: Array<Feature<LineString>> = [];
  if (estimate.radiusM !== null && estimate.radiusM > 0) {
    const ring: Array<[number, number]> = [];
    for (let k = 0; k <= 64; k += 1) ring.push(destination(centre, (k * 360) / 64, estimate.radiusM));
    lines.push({ type: 'Feature', properties: { kind: 'radius' }, geometry: { type: 'LineString', coordinates: ring } });
  }
  if (station) {
    lines.push({
      type: 'Feature',
      properties: { kind: 'link' },
      geometry: { type: 'LineString', coordinates: [[station.longitude, station.latitude], [centre.longitude, centre.latitude]] },
    });
  }
  if (estimate.groundLatitude !== null && estimate.groundLongitude !== null) {
    lines.push({
      type: 'Feature',
      properties: { kind: 'ground' },
      geometry: { type: 'LineString', coordinates: [[estimate.groundLongitude, estimate.groundLatitude], [centre.longitude, centre.latitude]] },
    });
  }
  return {
    heat: { type: 'FeatureCollection', features: heat },
    lines: { type: 'FeatureCollection', features: lines },
    point: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [centre.longitude, centre.latitude] } }] },
  };
}

export function formatEstimateDistance(metres: number | null): string {
  if (metres === null) return '--';
  return metres >= 1000 ? `${(metres / 1000).toFixed(metres >= 10_000 ? 0 : 1)} km` : `${Math.round(metres)} m`;
}

/** Map pill at the estimate point; the distances sit on the lines (positionEstimateLineLabels()). */
export function positionEstimateLabel(_estimate: PositionEstimate, t: Translate): string {
  return t('estimate.mapLabel');
}

export interface EstimateLineLabel {
  /** Halfway along the line. */
  lngLat: [number, number];
  text: string;
}

/**
 * The distance and bearing written halfway along each line to an ESTIMATE: "RDF-SDR 3.4 km · 294°"
 * from the station drawn now (the drone), "GS 5.2 km · 48°" from the groundstation while it has a fix.
 */
export function positionEstimateLineLabels(estimate: PositionEstimate | null, station: GeoOrigin | null, t: Translate): EstimateLineLabel[] {
  if (!estimate || estimate.state !== 'ESTIMATE' || estimate.latitude === null || estimate.longitude === null) return [];
  const labels: EstimateLineLabel[] = [];
  const along = (origin: GeoOrigin, key: 'estimate.mapNode' | 'estimate.mapGround') => {
    const { bearingDeg, distanceM } = bearingAndDistance(origin, estimate.longitude as number, estimate.latitude as number);
    if (!(distanceM > 0)) return;
    labels.push({
      lngLat: destination(origin, bearingDeg, distanceM / 2),
      text: t(key, { distance: formatEstimateDistance(distanceM), bearing: formatBearing(bearingDeg, 0) }),
    });
  };
  if (station) along(station, 'estimate.mapNode');
  if (estimate.groundLatitude !== null && estimate.groundLongitude !== null) {
    along({ latitude: estimate.groundLatitude, longitude: estimate.groundLongitude }, 'estimate.mapGround');
  }
  return labels;
}

/** POST the reset; resolves with the server's new (empty) estimate view, rejects with its code. */
export async function resetPositionEstimate(signal?: AbortSignal): Promise<void> {
  const response = await fetch(POSITION_ESTIMATE_RESET_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    body: '{}',
    signal,
  });
  if (response.ok) return;
  let code = `HTTP_${response.status}`;
  try {
    const body: unknown = await response.json();
    const value = record(body)?.code;
    if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value)) code = value;
  } catch {
    // An answer without JSON keeps only its status.
  }
  throw new Error(code);
}
