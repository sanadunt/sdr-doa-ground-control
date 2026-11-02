import type { FeatureCollection, LineString } from 'geojson';
import type { GroundGpsState, GroundGpsView, MapCoordinate, TelemetrySnapshot } from '../types';
import { bearingAndDistance, destination, type GeoOrigin } from './doaGeometry';
import { formatBearing, formatDistance } from './overlayPalette';
import type { Translate } from './i18n';

/**
 * The groundstation's own GPS (ground-gps-publisher, tools/ground_gps.py): the
 * `ground_gps` block of every /api/snapshot answer. The RDF-SDR and the
 * groundstation stand in different places, so the map draws both and the
 * dotted line between them.
 */

export const GROUND_GPS_STATES: readonly GroundGpsState[] = ['FIX', 'NO_FIX', 'NO_DEVICE', 'NO_DATA', 'ERROR', 'STOPPED', 'STALE', 'NONE'];
/** The server's STALE_AFTER_MS, used when an answer does not report one. */
export const GROUND_GPS_STALE_AFTER_MS = 10_000;
// A line shorter than this is the same spot; the marker alone shows it.
const MIN_LINK_M = 1;
// Above this the line follows the great circle in steps instead of one segment.
const DENSIFY_ABOVE_M = 2_000;
const LINK_STEPS = 32;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function inRange(value: unknown, min: number, max: number): number | null {
  const number = finite(value);
  return number !== null && number >= min && number <= max ? number : null;
}

function text(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/**
 * Read leniently: a bad field reads as null, never the whole status. An
 * unknown state reads as NONE; lat and lon count only while the state is FIX.
 */
export function normalizeGroundGps(value: unknown): GroundGpsView | null {
  if (!isObject(value)) return null;
  const present = value.present === true;
  const state: GroundGpsState = present ? GROUND_GPS_STATES.find((item) => item === value.state) ?? 'NONE' : 'NONE';
  const fixed = state === 'FIX';
  const fix = finite(value.fix);
  const sat = finite(value.sat);
  const staleAfter = finite(value.stale_after_ms);
  return {
    present,
    state,
    lat: fixed ? inRange(value.lat, -90, 90) : null,
    lon: fixed ? inRange(value.lon, -180, 180) : null,
    alt: finite(value.alt),
    fix: fix === 0 || fix === 2 || fix === 3 ? fix : null,
    sat: sat !== null && Number.isInteger(sat) && sat >= 0 ? sat : null,
    hdop: inRange(value.hdop, 0, 100),
    sog: inRange(value.sog, 0, Number.MAX_VALUE),
    cog: inRange(value.cog, 0, 360),
    device: text(value.device),
    error: text(value.error),
    status_age_ms: finite(value.status_age_ms),
    received_at_ms: finite(value.received_at_ms),
    stale_after_ms: staleAfter !== null && staleAfter > 0 ? staleAfter : GROUND_GPS_STALE_AFTER_MS,
  };
}

export function snapshotGroundGps(snapshot: TelemetrySnapshot | null | undefined): GroundGpsView | null {
  return normalizeGroundGps(snapshot?.ground_gps);
}

/**
 * The state to show. Once the page's own window closed (a failed or old read),
 * the last answer no longer says what the receiver does now: STALE.
 */
export function groundGpsState(view: GroundGpsView | null, localFresh: boolean): GroundGpsState {
  if (!view) return 'NONE';
  return !localFresh && view.state !== 'NONE' ? 'STALE' : view.state;
}

export interface GroundPosition {
  latitude: number;
  longitude: number;
  altitude: number | null;
  state: 'FIX';
}

/**
 * Whether the groundstation GPS of the last answer is still current: its
 * status age at the answer plus the time since, within the server's window.
 * It does not follow the RDF-SDR's data freshness, so the GS marker stays
 * while the RDF-SDR is off or its link is down.
 */
export function groundGpsCurrent(
  snapshot: TelemetrySnapshot | null | undefined,
  readAtMonotonic: number | null,
  readFailed: boolean,
  now: number,
): boolean {
  const view = snapshotGroundGps(snapshot);
  if (readFailed || !view || readAtMonotonic === null || !Number.isFinite(readAtMonotonic)) return false;
  const elapsed = now - readAtMonotonic;
  return Number.isFinite(elapsed) && elapsed >= 0 && (view.status_age_ms ?? 0) + elapsed <= view.stale_after_ms;
}

/** The groundstation's position: only from a FIX whose status is not older than the server's window. */
export function groundPosition(snapshot: TelemetrySnapshot | null | undefined): GroundPosition | null {
  const view = snapshotGroundGps(snapshot);
  if (!view || view.state !== 'FIX' || view.lat === null || view.lon === null) return null;
  if (view.status_age_ms !== null && view.status_age_ms > view.stale_after_ms) return null;
  return { latitude: view.lat, longitude: view.lon, altitude: view.alt, state: 'FIX' };
}

/** Great-circle distance and the initial bearing from a to b, degrees from north. */
export function distanceAndBearing(a: GeoOrigin, b: GeoOrigin): { distanceM: number; bearingDeg: number } {
  const { distanceM, bearingDeg } = bearingAndDistance(a, b.longitude, b.latitude);
  return { distanceM, bearingDeg };
}

/**
 * Whether the RDF-SDR position on the map is a live fix. A fallback, a manual
 * entry, a simulation or the last fix held through a gap is not: the line to it
 * is then a reference, dimmed grey.
 */
export function stationPositionLive(coordinate: MapCoordinate | null, held: boolean): boolean {
  if (!coordinate || held) return false;
  return coordinate.source !== 'FALLBACK' && coordinate.source !== 'MANUAL' && coordinate.source !== 'SIMULATION';
}

export interface GroundLink {
  features: FeatureCollection<LineString>;
  distanceM: number;
  bearingDeg: number;
  /** Where the distance and bearing label sits: halfway along the line. */
  label: [number, number];
  live: boolean;
}

/** The dotted line from the groundstation to the RDF-SDR, along the great circle. */
export function groundLink(ground: GeoOrigin, station: GeoOrigin, live: boolean): GroundLink | null {
  const { distanceM, bearingDeg } = distanceAndBearing(ground, station);
  if (!Number.isFinite(distanceM) || distanceM < MIN_LINK_M) return null;
  const steps = distanceM > DENSIFY_ABOVE_M ? LINK_STEPS : 1;
  const coordinates: Array<[number, number]> = [[ground.longitude, ground.latitude]];
  for (let step = 1; step < steps; step += 1) coordinates.push(destination(ground, bearingDeg, distanceM * step / steps));
  coordinates.push([station.longitude, station.latitude]);
  return {
    features: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { layer: 'ground-link', live, distanceM, bearingDeg }, geometry: { type: 'LineString', coordinates } }] },
    distanceM,
    bearingDeg,
    label: destination(ground, bearingDeg, distanceM / 2),
    live,
  };
}

/** "1.23 km · 45.0°", or named a reference when the RDF-SDR position is not live. */
export function groundLinkLabel(link: GroundLink, t: Translate): string {
  const distance = formatDistance(link.distanceM);
  const bearing = formatBearing(link.bearingDeg, 1);
  return link.live ? `${distance} · ${bearing}°` : t('map.groundReference', { distance, bearing });
}

/** A state code as the operator reads it: NO_FIX is shown as NO FIX. */
export function groundGpsCode(state: GroundGpsState): string {
  return state.replace(/_/gu, ' ');
}

export function groundGpsTone(state: GroundGpsState): 'good' | 'warn' | 'bad' | 'neutral' {
  if (state === 'FIX') return 'good';
  if (state === 'NO_DEVICE' || state === 'ERROR') return 'bad';
  if (state === 'NONE') return 'neutral';
  return 'warn';
}

/**
 * The node card's Groundstation row: "FIX 3D · 4 sat · 1.2 km", the distance
 * to the RDF-SDR only when both are known (a reference when the RDF-SDR
 * position is not live), else the state.
 */
export function groundGpsSummary(view: GroundGpsView, state: GroundGpsState, distance: { distanceM: number; live: boolean } | null, t: Translate): string {
  if (state !== 'FIX') return groundGpsCode(state);
  const parts = [view.fix === 2 || view.fix === 3 ? `FIX ${view.fix}D` : 'FIX'];
  if (view.sat !== null) parts.push(t('node.satellites', { count: view.sat }));
  if (distance) {
    const text = formatDistance(distance.distanceM);
    parts.push(distance.live ? text : t('node.groundReference', { distance: text }));
  }
  return parts.join(' · ');
}

/** Why the receiver gives no position, in operator words; null for FIX. */
export function groundGpsCause(view: GroundGpsView | null, state: GroundGpsState, t: Translate): string | null {
  switch (state) {
    case 'FIX': return null;
    case 'NO_FIX': return t('health.ground.cause.NO_FIX');
    case 'NO_DEVICE': return t('health.ground.cause.NO_DEVICE');
    case 'NO_DATA': return t('health.ground.cause.NO_DATA');
    case 'ERROR': return t('health.ground.cause.ERROR', { error: view?.error ?? 'ERROR' });
    case 'STOPPED': return t('health.ground.cause.STOPPED');
    case 'STALE': return t('health.ground.cause.STALE');
    default: return t(view ? 'health.ground.cause.NONE' : 'health.ground.cause.noMonitor');
  }
}
