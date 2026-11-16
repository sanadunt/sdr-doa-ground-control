import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import type { TelemetrySnapshot } from '../types';
import { bearingAndDistance, destination, type GeoOrigin } from './doaGeometry';
import { formatBearing } from './overlayPalette';
import { formatGridMetres, gsRelativeXY, toMgrs, toUtm, type CoordinateFormat } from './gridCoordinates';
import type { MessageKey, Translate } from './i18n';

/**
 * The transmitter position estimate the console builds from the moving
 * RDF-SDR's bearings (tools/doa_position_estimate.py): the drone's GPS and yaw
 * at each sample first, the edge's own b, lat and lon (contract 1.10) where the
 * drone has none. ESTIMATE: rays from enough places cross; ROUGH: rays from two
 * or more places cross a few degrees apart, a point with a wide radius that
 * shrinks as more directions come; NEED_MOVEMENT: rays from one place only, so
 * there is a direction but no distance; NO_DATA: no bearing with a position has come.
 * Bearings the edge has not verified (DoA ok=0) count as weaker rays.
 */
export type PositionEstimateState = 'NO_DATA' | 'NEED_MOVEMENT' | 'ROUGH' | 'ESTIMATE';

/** One ray of the estimate: where and when it was taken, where it pointed, and whether the edge verified it. */
export interface EstimateRay {
  tMs: number;
  latitude: number;
  longitude: number;
  bearingDeg: number;
  verified: boolean;
}

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
  /** Rays from bearings the edge has not verified (DoA ok=0), counted at UNVERIFIED_WEIGHT. */
  unverifiedSamples: number;
  stations: number;
  spreadDeg: number | null;
  frequencyHz: number | null;
  minStations: number;
  minSpreadDeg: number;
  roughMinStations: number;
  roughSpreadDeg: number;
  resetReason: string | null;
  grid: PositionEstimateGrid | null;
  /** The latest rays, oldest first: the map's history lines. */
  rays: EstimateRay[];
  /** The peak's share of every ray's weight; null before a ray. */
  peakShare: number | null;
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
  const state = value.state === 'ESTIMATE' || value.state === 'ROUGH' || value.state === 'NEED_MOVEMENT' ? value.state : 'NO_DATA';
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
    unverifiedSamples: count(value.unverified_samples),
    stations: count(value.stations),
    spreadDeg: finite(value.spread_deg, 0, 360),
    frequencyHz: finite(value.frequency_hz, 1),
    minStations: count(method.min_stations) || 3,
    minSpreadDeg: finite(method.min_spread_deg, 0, 180) ?? 10,
    roughMinStations: count(method.rough_min_stations) || 2,
    roughSpreadDeg: finite(method.rough_spread_deg, 0, 180) ?? 3,
    resetReason: typeof value.reset_reason === 'string' && /^[A-Z_]{1,32}$/u.test(value.reset_reason) ? value.reset_reason : null,
    grid: parseGrid(value.grid),
    rays: parseRays(value.rays),
    peakShare: finite(value.peak_share, 0, 1),
    waitingFor: skipCurrent && (value.waiting_for === 'NO_BEARING' || value.waiting_for === 'NO_POSITION') ? value.waiting_for : null,
    skipped: skipCurrent ? count(value.skipped) : 0,
    positionWithheld: positionWithheld(snapshot),
    nodeGpsFix: nodeGpsFix(snapshot),
  };
}

/** At most this many rays are read from an answer (the console sends 200). */
export const MAX_RAYS = 500;

/** [t_ms, latitude, longitude, bearing_deg, verified 1/0] rows; a bad row is left out. */
function parseRays(value: unknown): EstimateRay[] {
  if (!Array.isArray(value)) return [];
  const rays: EstimateRay[] = [];
  for (const row of value.slice(-MAX_RAYS)) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const tMs = finite(row[0], 0);
    const latitude = finite(row[1], -90, 90);
    const longitude = finite(row[2], -180, 180);
    const bearingDeg = finite(row[3], 0, 360);
    if (tMs === null || latitude === null || longitude === null || bearingDeg === null || (row[4] !== 0 && row[4] !== 1)) continue;
    rays.push({ tMs, latitude, longitude, bearingDeg, verified: row[4] === 1 });
  }
  return rays;
}

/** A point on the map: a rough estimate or an estimate with its position. */
export function estimateLocated(estimate: PositionEstimate | null): estimate is PositionEstimate & { latitude: number; longitude: number } {
  return estimate !== null && (estimate.state === 'ESTIMATE' || estimate.state === 'ROUGH')
    && estimate.latitude !== null && estimate.longitude !== null;
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
  if (!estimateLocated(estimate)) {
    return { heat: { type: 'FeatureCollection', features: heat }, lines: EMPTY_LINES, point: EMPTY_POINTS };
  }
  const centre: GeoOrigin = { latitude: estimate.latitude, longitude: estimate.longitude };
  const rough = estimate.state === 'ROUGH';
  const lines: Array<Feature<LineString>> = [];
  if (estimate.radiusM !== null && estimate.radiusM > 0) {
    const ring: Array<[number, number]> = [];
    for (let k = 0; k <= 64; k += 1) ring.push(destination(centre, (k * 360) / 64, estimate.radiusM));
    lines.push({ type: 'Feature', properties: { kind: 'radius', rough }, geometry: { type: 'LineString', coordinates: ring } });
  }
  if (station) {
    lines.push({
      type: 'Feature',
      properties: { kind: 'link', rough },
      geometry: { type: 'LineString', coordinates: [[station.longitude, station.latitude], [centre.longitude, centre.latitude]] },
    });
  }
  if (estimate.groundLatitude !== null && estimate.groundLongitude !== null) {
    lines.push({
      type: 'Feature',
      properties: { kind: 'ground', rough },
      geometry: { type: 'LineString', coordinates: [[estimate.groundLongitude, estimate.groundLatitude], [centre.longitude, centre.latitude]] },
    });
  }
  return {
    heat: { type: 'FeatureCollection', features: heat },
    lines: { type: 'FeatureCollection', features: lines },
    point: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { rough }, geometry: { type: 'Point', coordinates: [centre.longitude, centre.latitude] } }] },
  };
}

/** A ray without an estimate to reach for is drawn this long; with one it reaches past it. */
export const RAY_DEFAULT_M = 3000;
const RAY_MIN_M = 1000;
const RAY_MAX_M = 10_000;

/**
 * The history lines: every ray from where it was taken along its bearing,
 * reaching 30% past a located estimate (1 to 10 km) or RAY_DEFAULT_M without
 * one. `age` is 0 for the newest ray and 1 for the oldest, so the map fades
 * old rays; `verified` false for the edge's unverified bearings. `path` is
 * the line through the places the rays were taken, oldest first.
 */
export function estimateRayFeatures(estimate: PositionEstimate | null): { rays: FeatureCollection<LineString>; path: FeatureCollection<LineString> } {
  const rays = estimate?.rays ?? [];
  if (!rays.length) return { rays: EMPTY_LINES, path: EMPTY_LINES };
  const located = estimateLocated(estimate);
  const last = rays.length - 1;
  const features: Array<Feature<LineString>> = rays.map((ray, index) => {
    const origin: GeoOrigin = { latitude: ray.latitude, longitude: ray.longitude };
    let length = RAY_DEFAULT_M;
    if (located) {
      const { distanceM } = bearingAndDistance(origin, estimate.longitude, estimate.latitude);
      length = Math.min(RAY_MAX_M, Math.max(RAY_MIN_M, distanceM * 1.3));
    }
    return {
      type: 'Feature',
      properties: { age: last === 0 ? 0 : (last - index) / last, verified: ray.verified },
      geometry: { type: 'LineString', coordinates: [[ray.longitude, ray.latitude], destination(origin, ray.bearingDeg, length)] },
    };
  });
  const path: Array<[number, number]> = [];
  for (const ray of rays) {
    const point: [number, number] = [ray.longitude, ray.latitude];
    const previous = path[path.length - 1];
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) path.push(point);
  }
  return {
    rays: { type: 'FeatureCollection', features },
    path: path.length > 1
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: path } }] }
      : EMPTY_LINES,
  };
}

/**
 * The estimate's position in the chosen format, with its radius, or null
 * without a position: latitude/longitude, UTM (zone, X easting, Y northing),
 * MGRS, or X/Y metres east and north of the groundstation's own GPS fix.
 */
export function estimatePositionText(estimate: PositionEstimate, format: CoordinateFormat, t: Translate): string | null {
  const coordinates = estimateCoordinates(estimate, format, t);
  if (!coordinates) return null;
  return coordinates.located ? `${coordinates.text} · ±${formatEstimateDistance(estimate.radiusM)}` : coordinates.text;
}

/**
 * The map label at the estimate: a small upper line with ESTIMATE and the
 * radius, and the position in the chosen format below it, so it reads off
 * the map without opening the card.
 */
export function estimateMapLabel(estimate: PositionEstimate, format: CoordinateFormat, t: Translate): { above: string; text: string } {
  const above = `${t(estimate.state === 'ROUGH' ? 'estimate.mapLabelRough' : 'estimate.mapLabel')} · ±${formatEstimateDistance(estimate.radiusM)}`;
  return { above, text: estimateCoordinates(estimate, format, t)?.text ?? t('estimate.mapLabel') };
}

/** The position alone in the chosen format; `located` is false for a reason it cannot be written that way. */
function estimateCoordinates(estimate: PositionEstimate, format: CoordinateFormat, t: Translate): { text: string; located: boolean } | null {
  const { latitude, longitude } = estimate;
  if (latitude === null || longitude === null) return null;
  if (format === 'utm') {
    const utm = toUtm(latitude, longitude);
    if (!utm) return { text: t('estimate.positionNoGrid'), located: false };
    return {
      text: t('estimate.positionUtm', { zone: `${utm.zone}${utm.band}`, x: String(Math.round(utm.easting)), y: String(Math.round(utm.northing)) }),
      located: true,
    };
  }
  if (format === 'mgrs') {
    const mgrs = toMgrs(latitude, longitude);
    return mgrs ? { text: t('estimate.positionMgrs', { mgrs }), located: true } : { text: t('estimate.positionNoGrid'), located: false };
  }
  if (format === 'gsxy') {
    if (estimate.groundLatitude === null || estimate.groundLongitude === null) return { text: t('estimate.positionNoGround'), located: false };
    const { x, y } = gsRelativeXY({ latitude: estimate.groundLatitude, longitude: estimate.groundLongitude }, { latitude, longitude });
    return { text: t('estimate.positionGs', { x: formatGridMetres(x), y: formatGridMetres(y) }), located: true };
  }
  return { text: t('estimate.position', { lat: latitude.toFixed(5), lon: longitude.toFixed(5) }), located: true };
}

export function formatEstimateDistance(metres: number | null): string {
  if (metres === null) return '--';
  return metres >= 1000 ? `${(metres / 1000).toFixed(metres >= 10_000 ? 0 : 1)} km` : `${Math.round(metres)} m`;
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
  if (!estimateLocated(estimate)) return [];
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
