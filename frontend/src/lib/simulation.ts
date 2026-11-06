import type { TelemetrySnapshot } from '../types';
import { DEFAULT_FALLBACK_COORDINATE } from './map';
import { bearingAndDistance, destination, halfPowerWidth } from './doaGeometry';
import type { GeoOrigin } from './doaGeometry';
import type { PositionEstimate } from './positionEstimate';

export interface SimulationSettings {
  latitude: number;
  longitude: number;
  angle: number;
  /** Gaussian standard deviation σ of the lobe in degrees; not the -3 dB width. */
  width: number;
  /** Distance of the simulated transmitter along the bearing, km (simulationScene). */
  targetKm: number;
}

export const DEFAULT_SIMULATION: SimulationSettings = {
  ...DEFAULT_FALLBACK_COORDINATE, angle: 45, width: 18, targetKm: 2,
};

export const SIMULATION_TARGET_KM = { min: 0.5, max: 8 } as const;

export function randomizeSimulationSettings(settings: SimulationSettings): SimulationSettings {
  return {
    ...settings,
    angle: Math.floor(Math.random() * 360),
    width: 5 + Math.floor(Math.random() * 56),
    targetKm: 1 + Math.floor(Math.random() * 9) / 2,
  };
}

/** One-kilometre visual reference ray, not an estimated target range. */
export function simulationRayEnd(latitude: number, longitude: number, bearing: number): [number, number] {
  const radians = Math.PI / 180;
  const lat = latitude * radians;
  const direction = bearing * radians;
  const arc = 1000 / 6371000;
  const endLat = Math.asin(Math.sin(lat) * Math.cos(arc) + Math.cos(lat) * Math.sin(arc) * Math.cos(direction));
  const deltaLon = Math.atan2(Math.sin(direction) * Math.sin(arc) * Math.cos(lat), Math.cos(arc) - Math.sin(lat) * Math.sin(endLat));
  return [endLat / radians, longitude + deltaLon / radians];
}

export function validateSimulation(value: SimulationSettings): boolean {
  return Object.values(value).every(Number.isFinite)
    && Math.abs(value.latitude) <= 90 && Math.abs(value.longitude) <= 180
    && value.angle >= 0 && value.angle < 360 && value.width >= 5 && value.width <= 60
    && value.targetKm >= SIMULATION_TARGET_KM.min && value.targetKm <= SIMULATION_TARGET_KM.max;
}

/**
 * Array-frame theta_0 for a geographic bearing with compass offset 0. Data Out
 * reports theta_0 counter-clockwise, and the console draws
 * (360 - theta_0 + offset) mod 360 as the bearing.
 */
export function simulationTheta(bearing: number): number {
  return (360 - bearing) % 360;
}

/** Shifted-dB vector: a Gaussian with standard deviation `sigma` degrees around theta_0, -50 to -5 dB. */
function simulationVector(theta: number, sigma: number): number[] {
  return Array.from({ length: 360 }, (_, bin) => {
    const distance = Math.abs(((bin - theta + 540) % 360) - 180);
    return -50 + 45 * Math.exp(-0.5 * (distance / sigma) ** 2);
  });
}

/**
 * The -3 dB width the map legend reports for these settings, so the
 * Simulation page can show the same number; null for invalid settings.
 */
export function simulationHalfPowerWidth(settings: SimulationSettings): number | null {
  if (!validateSimulation(settings)) return null;
  return halfPowerWidth(simulationVector(simulationTheta(settings.angle), settings.width))?.widthDeg ?? null;
}

/**
 * Renderer fixture only; never eligible for publication or remote control.
 * The entered angle is the geographic bearing, so the snapshot carries
 * theta_0 = 360 - angle with a Compass axis and offset 0, and the readout,
 * polar plot and map all show the entered value.
 */
export function simulationSnapshot(settings: SimulationSettings): TelemetrySnapshot {
  if (!validateSimulation(settings)) throw new Error('Invalid simulation settings');
  const theta = simulationTheta(settings.angle);
  const values = simulationVector(theta, settings.width);
  const record = {
    available: true, source_format: 'SIMULATION',
    canonical_angle_deg: theta,
    freshness: { fresh: true, age_ms: 0, reference_kind: 'synthetic-static-preview' },
  };
  return {
    simulation: true,
    overall_state: 'SIMULATION',
    status: { available: true, daq_health: 'SIMULATION' },
    settings: { fields: { doa_fig_type: 'Compass', compass_offset: 0 } },
    doa_candidates: { csv: { ...record, angular_power_db: values }, xml: { ...record } },
    native_consistency: { comparable: true, conflict: false },
    publication_gate: { state: 'BLOCKED', checks: { real_measurement: false }, reasons: ['SIMULATION_ONLY'] },
    authority: { selected: null, canonical_angle_ready: false },
  };
}
/** What the Dashboard map draws around a simulated station; never mixed with live data. */
export interface SimulationScene {
  /** The simulated groundstation GPS fix. */
  ground: GeoOrigin;
  /** The simulated drone: at the station, on its flown track ([lon, lat], oldest first). */
  drone: { position: GeoOrigin; headingDeg: number; track: Array<[number, number]> };
  /** A position estimate in the shape the console serves, centred near the transmitter. */
  estimate: PositionEstimate;
}

const SCENE_GROUND_M = 900;
const SCENE_LEG_M = 1200;
const SCENE_STEP_M = 50;
const SCENE_GRID_M = 10_000;
const SCENE_CELLS = 100;

function lonLat([longitude, latitude]: [number, number]): GeoOrigin {
  return { latitude, longitude };
}

/** Straight leg from a to b in SCENE_STEP_M steps, without a. */
function leg(a: GeoOrigin, b: GeoOrigin): Array<[number, number]> {
  const { bearingDeg, distanceM } = bearingAndDistance(a, b.longitude, b.latitude);
  const steps = Math.max(1, Math.round(distanceM / SCENE_STEP_M));
  return Array.from({ length: steps }, (_, k) => destination(a, bearingDeg, (distanceM * (k + 1)) / steps));
}

/**
 * The drone, its track, the groundstation and a position estimate for the
 * simulated bearing: the transmitter sits targetKm along the entered bearing,
 * the groundstation 900 m behind the station, and the drone flew from the
 * groundstation out to one side and back to the station, so its bearings
 * cross. The estimate's centre is slightly off the transmitter, as a real
 * prediction would be, with a hot area stretched along the bearing.
 */
export function simulationScene(settings: SimulationSettings): SimulationScene | null {
  if (!validateSimulation(settings)) return null;
  const station: GeoOrigin = { latitude: settings.latitude, longitude: settings.longitude };
  const targetM = settings.targetKm * 1000;
  const ground = lonLat(destination(station, settings.angle + 215, SCENE_GROUND_M));
  const turn = lonLat(destination(station, settings.angle + 90, SCENE_LEG_M));
  const track: Array<[number, number]> = [[ground.longitude, ground.latitude], ...leg(ground, turn), ...leg(turn, station)];
  const before = lonLat(track[track.length - 2]);
  const headingDeg = Math.round(bearingAndDistance(before, station.longitude, station.latitude).bearingDeg * 10) / 10;

  const target = lonLat(destination(station, settings.angle, targetM));
  const centre = lonLat(destination(target, settings.angle + 90, targetM * 0.04));
  const radiusM = Math.max(120, Math.round(targetM * 0.08));
  const fromStation = bearingAndDistance(station, centre.longitude, centre.latitude);
  const fromGround = bearingAndDistance(ground, centre.longitude, centre.latitude);
  const fromTurn = bearingAndDistance(turn, centre.longitude, centre.latitude);
  const bearings = [fromStation.bearingDeg, fromGround.bearingDeg, fromTurn.bearingDeg];
  const spread = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
  const spreadDeg = Math.max(...bearings.flatMap((a) => bearings.map((b) => spread(a, b))));

  const half = SCENE_GRID_M / 2;
  const south = destination(centre, 180, half)[1];
  const north = destination(centre, 0, half)[1];
  const west = destination(centre, 270, half)[0];
  const east = destination(centre, 90, half)[0];
  const cell = SCENE_GRID_M / SCENE_CELLS;
  const along = radiusM * 2;
  const across = radiusM * 0.9;
  const direction = (settings.angle * Math.PI) / 180;
  const hot: Array<[number, number, number]> = [];
  for (let row = 0; row < SCENE_CELLS; row += 1) {
    for (let column = 0; column < SCENE_CELLS; column += 1) {
      const e = (column + 0.5) * cell - half;
      const n = (row + 0.5) * cell - half;
      const u = e * Math.sin(direction) + n * Math.cos(direction);
      const v = e * Math.cos(direction) - n * Math.sin(direction);
      const share = Math.exp(-0.5 * ((u / along) ** 2 + (v / across) ** 2));
      if (share >= 0.05) hot.push([column, row, Math.round(share * 1000) / 1000]);
    }
  }
  hot.sort((a, b) => b[2] - a[2]);

  return {
    ground,
    drone: { position: station, headingDeg, track },
    estimate: {
      state: 'ESTIMATE',
      latitude: centre.latitude,
      longitude: centre.longitude,
      radiusM,
      distanceM: Math.round(fromStation.distanceM),
      bearingDeg: Math.round(fromStation.bearingDeg * 10) / 10,
      groundDistanceM: Math.round(fromGround.distanceM),
      groundBearingDeg: Math.round(fromGround.bearingDeg * 10) / 10,
      groundLatitude: ground.latitude,
      groundLongitude: ground.longitude,
      bearingSource: 'drone',
      positionSource: 'drone',
      samples: track.length,
      stations: 3,
      spreadDeg: Math.round(spreadDeg * 10) / 10,
      frequencyHz: null,
      minStations: 3,
      minSpreadDeg: 15,
      resetReason: null,
      grid: { south, west, north, east, cells: SCENE_CELLS, hot: hot.slice(0, 800) },
      waitingFor: null,
      skipped: 0,
      nodeGpsFix: null,
      positionWithheld: null,
    },
  };
}
