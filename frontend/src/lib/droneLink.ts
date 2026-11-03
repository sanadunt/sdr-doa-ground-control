import type { MapCoordinate, TelemetrySnapshot } from '../types';
import { distanceAndBearing } from './groundGps';

/**
 * The SIYI drone that carries the RDF-SDR (tools/drone_link.py): the `drone`
 * block of every /api/snapshot answer and of GET /api/drone. Its GPS (RTK)
 * and yaw come first for the station position and the DoA bearing; the
 * RDF-SDR's own GPS and compass stay beside them, so the operator sees when
 * the two disagree.
 */

export type DroneState = 'LIVE' | 'STALE' | 'NO_DATA' | 'DISABLED';
export type DroneConnection = 'connected' | 'connecting' | 'disconnected' | 'searching' | 'disabled' | 'error' | 'stopped';
export type DroneRtk = 'FIXED' | 'FLOAT' | 'NONE';

interface Aged {
  age_ms: number | null;
  stale: boolean;
}

export interface DronePosition extends Aged {
  lat: number | null;
  lon: number | null;
  alt_msl_m: number | null;
  alt_rel_m: number | null;
  speed_ms: number | null;
  heading_deg: number | null;
}

export interface DroneGps extends Aged {
  fix: number | null;
  fix_label: string | null;
  rtk: DroneRtk;
  satellites: number | null;
  hdop: number | null;
}

export interface DroneAttitude extends Aged {
  roll_deg: number | null;
  pitch_deg: number | null;
  yaw_deg: number | null;
}

export interface DroneBattery extends Aged {
  voltage_v: number | null;
  current_a: number | null;
  remaining_pct: number | null;
}

export interface DroneStatus extends Aged {
  armed: boolean | null;
  custom_mode: number | null;
  system_status: number | null;
  type_name: string | null;
}

export interface DroneHud extends Aged {
  groundspeed_ms: number | null;
  climb_ms: number | null;
  throttle_pct: number | null;
}

export interface DroneBridgeLink extends Aged {
  fc_online: boolean | null;
  camera_online: boolean | null;
  frames_per_s: number | null;
  version: string | null;
  uptime_s: number | null;
}

export interface DroneHeadingAtDoa {
  deg: number;
  offset_ms: number;
  source: 'attitude' | 'position';
  doa_timestamp_ms: number | null;
}

export interface DroneView {
  enabled: boolean;
  state: DroneState;
  connection: DroneConnection;
  host: string | null;
  port: number | null;
  lastError: string | null;
  scanning: boolean;
  discoveryMode: 'auto' | 'fixed';
  candidates: Array<{ host: string; fcOnline: boolean | null; version: string | null }>;
  position: DronePosition | null;
  gps: DroneGps | null;
  attitude: DroneAttitude | null;
  battery: DroneBattery | null;
  status: DroneStatus | null;
  hud: DroneHud | null;
  statustext: { severity: number | null; text: string | null; age_ms: number | null } | null;
  link: DroneBridgeLink | null;
  heading: { deg: number; source: 'attitude' | 'position'; age_ms: number | null } | null;
  headingAtDoa: DroneHeadingAtDoa | null;
  arrayHeadingOffsetDeg: number;
  videoEnabled: boolean;
  received: number;
  invalid: number;
  lastInvalid: string | null;
}

type JsonObject = Record<string, unknown>;

const STATES: readonly DroneState[] = ['LIVE', 'STALE', 'NO_DATA', 'DISABLED'];
const CONNECTIONS: readonly DroneConnection[] = ['connected', 'connecting', 'disconnected', 'searching', 'disabled', 'error', 'stopped'];
/** GPS_FIX_TYPE 3 (3D) and above carries a usable position. */
export const DRONE_POSITION_FIX_MIN = 3;
/** Above this the drone and the RDF-SDR disagree on where they are (they fly together). */
export const DRONE_POSITION_GAP_WARN_M = 25;
/** Above this their headings disagree, after the array offset. */
export const DRONE_HEADING_GAP_WARN_DEG = 15;

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

function flag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function aged(value: JsonObject): Aged {
  const age = finite(value.age_ms);
  return { age_ms: age !== null && age >= 0 ? age : null, stale: value.stale !== false };
}

function heading(value: unknown): number | null {
  const number = inRange(value, 0, 360);
  return number === null ? null : number % 360;
}

function block<T>(value: unknown, read: (item: JsonObject) => T): T | null {
  return isObject(value) ? read(value) : null;
}

/** Read leniently: a bad field reads as null, never the whole block. */
export function normalizeDrone(value: unknown): DroneView | null {
  if (!isObject(value)) return null;
  const discovery = isObject(value.discovery) ? value.discovery : {};
  const atDoa = isObject(value.heading_at_doa) ? value.heading_at_doa : null;
  const atDoaDeg = atDoa ? heading(atDoa.deg) : null;
  const headingBlock = isObject(value.heading) ? value.heading : null;
  const headingDeg = headingBlock ? heading(headingBlock.deg) : null;
  const offset = inRange(value.array_heading_offset_deg, -180, 180);
  const rtk = (gps: JsonObject): DroneRtk => (gps.rtk === 'FIXED' || gps.rtk === 'FLOAT' ? gps.rtk : 'NONE');
  return {
    enabled: value.enabled === true,
    state: STATES.find((item) => item === value.state) ?? 'NO_DATA',
    connection: CONNECTIONS.find((item) => item === value.connection) ?? 'disconnected',
    host: text(value.host, 64),
    port: inRange(value.port, 1, 65535),
    lastError: text(value.last_error),
    scanning: discovery.scanning === true,
    discoveryMode: discovery.mode === 'fixed' ? 'fixed' : 'auto',
    candidates: Array.isArray(discovery.candidates)
      ? discovery.candidates.filter(isObject).slice(0, 8).map((item) => ({
          host: text(item.host, 64) ?? '?',
          fcOnline: flag(item.fc_online),
          version: text(item.version, 32),
        }))
      : [],
    position: block(value.position, (item) => ({
      ...aged(item),
      lat: inRange(item.lat, -90, 90),
      lon: inRange(item.lon, -180, 180),
      alt_msl_m: finite(item.alt_msl_m),
      alt_rel_m: finite(item.alt_rel_m),
      speed_ms: inRange(item.speed_ms, 0, 600),
      heading_deg: heading(item.heading_deg),
    })),
    gps: block(value.gps, (item) => ({
      ...aged(item),
      fix: inRange(item.fix, 0, 8),
      fix_label: text(item.fix_label, 16),
      rtk: rtk(item),
      satellites: inRange(item.satellites, 0, 254),
      hdop: inRange(item.hdop, 0, 99),
    })),
    attitude: block(value.attitude, (item) => ({
      ...aged(item),
      roll_deg: inRange(item.roll_deg, -180, 180),
      pitch_deg: inRange(item.pitch_deg, -180, 180),
      yaw_deg: heading(item.yaw_deg),
    })),
    battery: block(value.battery, (item) => ({
      ...aged(item),
      voltage_v: inRange(item.voltage_v, 0, 100),
      current_a: finite(item.current_a),
      remaining_pct: inRange(item.remaining_pct, 0, 100),
    })),
    status: block(value.status, (item) => ({
      ...aged(item),
      armed: flag(item.armed),
      custom_mode: finite(item.custom_mode),
      system_status: finite(item.system_status),
      type_name: text(item.type_name, 32),
    })),
    hud: block(value.hud, (item) => ({
      ...aged(item),
      groundspeed_ms: inRange(item.groundspeed_ms, 0, 600),
      climb_ms: finite(item.climb_ms),
      throttle_pct: inRange(item.throttle_pct, 0, 100),
    })),
    statustext: block(value.statustext, (item) => ({
      severity: inRange(item.severity, 0, 7),
      text: text(item.text),
      age_ms: finite(item.age_ms),
    })),
    link: block(value.link, (item) => ({
      ...aged(item),
      fc_online: flag(item.fc_online),
      camera_online: flag(item.camera_online),
      frames_per_s: inRange(item.frames_per_s, 0, 100_000),
      version: text(item.version, 32),
      uptime_s: finite(item.uptime_s),
    })),
    heading: headingDeg !== null && headingBlock
      ? { deg: headingDeg, source: headingBlock.source === 'position' ? 'position' : 'attitude', age_ms: finite(headingBlock.age_ms) }
      : null,
    headingAtDoa: atDoa && atDoaDeg !== null
      ? {
          deg: atDoaDeg,
          offset_ms: finite(atDoa.offset_ms) ?? 0,
          source: atDoa.source === 'position' ? 'position' : 'attitude',
          doa_timestamp_ms: finite(atDoa.doa_timestamp_ms),
        }
      : null,
    arrayHeadingOffsetDeg: offset ?? 0,
    videoEnabled: value.video_enabled !== false,
    received: finite(value.received) ?? 0,
    invalid: finite(value.invalid) ?? 0,
    lastInvalid: text(value.last_invalid, 120),
  };
}

export function snapshotDrone(snapshot: TelemetrySnapshot | null | undefined): DroneView | null {
  if (!snapshot || snapshot.simulation === true) return null;
  return normalizeDrone(snapshot.drone);
}

/** The drone's position for the map: LIVE, a 3D fix or better, not stale, not 0/0. */
export function droneStation(view: DroneView | null): MapCoordinate | null {
  if (!view || view.state !== 'LIVE') return null;
  const position = view.position;
  const gps = view.gps;
  if (!position || position.stale || position.lat === null || position.lon === null) return null;
  if (position.lat === 0 && position.lon === 0) return null;
  if (!gps || gps.stale || gps.fix === null || gps.fix < DRONE_POSITION_FIX_MIN) return null;
  return { latitude: position.lat, longitude: position.lon, source: 'DRONE' };
}

/** The array heading from the drone's yaw at the DoA sample's time, with the array's turn against the nose. */
export function droneArrayHeadingAtDoa(view: DroneView | null): number | null {
  if (!view || view.state === 'DISABLED' || !view.headingAtDoa) return null;
  return (((view.headingAtDoa.deg + view.arrayHeadingOffsetDeg) % 360) + 360) % 360;
}

/** The drone's current array heading (yaw plus the array's turn), for the map marker and the comparison. */
export function droneArrayHeadingNow(view: DroneView | null): number | null {
  if (!view || !view.heading) return null;
  return (((view.heading.deg + view.arrayHeadingOffsetDeg) % 360) + 360) % 360;
}

/** Distance and bearing between two positions, or null when either is missing. */
export function positionGap(a: MapCoordinate | null, b: MapCoordinate | null): { distanceM: number; bearingDeg: number } | null {
  if (!a || !b) return null;
  return distanceAndBearing(
    { latitude: a.latitude, longitude: a.longitude },
    { latitude: b.latitude, longitude: b.longitude },
  );
}

/** The signed turn from b to a, -180..180, or null. */
export function headingGap(a: number | null, b: number | null): number | null {
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return ((((a - b) % 360) + 540) % 360) - 180;
}

/** RTK FIXED, RTK FLOAT, or the fix label (3D, DGPS, NO_FIX, ...). */
export function droneFixLabel(gps: DroneGps | null): string {
  if (!gps) return '—';
  if (gps.rtk !== 'NONE') return `RTK ${gps.rtk}`;
  return gps.fix_label ?? (gps.fix !== null ? String(gps.fix) : '—');
}

/** Points kept of the flown track, and the least move that adds one. */
export const DRONE_TRACK_MAX = 2000;
const DRONE_TRACK_STEP_M = 1;
/** Within this the RDF-SDR's own GPS is the same place as the drone's: no second marker. */
export const DRONE_SAME_PLACE_M = 5;

let droneTrack: ReadonlyArray<[number, number]> = [];
let droneTrackHost: string | null = null;

/**
 * The drone's flown track for this page session: one point per move of at
 * least 1 m, at most 2000, forgotten when the remote changes. A new array only
 * when a point is added, so the map redraws it only then.
 */
export function rememberDroneTrack(view: DroneView | null): ReadonlyArray<[number, number]> {
  const station = droneStation(view);
  if (view && view.host !== droneTrackHost) {
    droneTrackHost = view.host;
    droneTrack = [];
  }
  if (!station) return droneTrack;
  const last = droneTrack[droneTrack.length - 1];
  const point: [number, number] = [station.longitude, station.latitude];
  if (last) {
    const moved = distanceAndBearing({ latitude: last[1], longitude: last[0] }, station).distanceM;
    if (moved < DRONE_TRACK_STEP_M) return droneTrack;
  }
  droneTrack = [...droneTrack.slice(-(DRONE_TRACK_MAX - 1)), point];
  return droneTrack;
}

/** Tests: start a fresh page session. */
export function forgetDroneTrack(): void {
  droneTrack = [];
  droneTrackHost = null;
}

/** The server's STALE_MS (tools/drone_link.py): a drone value older than this is stale. */
export const DRONE_STALE_MS = 10_000;

/**
 * Whether the drone block of the last answer is still current: a read that
 * did not fail, no older than the server's window. It ages apart from the
 * RDF-SDR's data, so the drone stays on the map while the RDF-SDR is off or
 * its link is down (each part also carries its own stale flag).
 */
export function droneCurrent(
  snapshot: TelemetrySnapshot | null | undefined,
  readAtMonotonic: number | null,
  readFailed: boolean,
  now: number,
): boolean {
  if (readFailed || !snapshotDrone(snapshot) || readAtMonotonic === null || !Number.isFinite(readAtMonotonic)) return false;
  const elapsed = now - readAtMonotonic;
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= DRONE_STALE_MS;
}
