import type { TelemetrySnapshot } from '../types';
import { DEFAULT_FALLBACK_COORDINATE } from './map';
import { halfPowerWidth } from './doaGeometry';

export interface SimulationSettings {
  latitude: number;
  longitude: number;
  angle: number;
  /** Gaussian standard deviation σ of the lobe in degrees; not the -3 dB width. */
  width: number;
}

export const DEFAULT_SIMULATION: SimulationSettings = {
  ...DEFAULT_FALLBACK_COORDINATE, angle: 45, width: 18,
};

export function randomizeSimulationSettings(settings: SimulationSettings): SimulationSettings {
  return { ...settings, angle: Math.floor(Math.random() * 360), width: 5 + Math.floor(Math.random() * 56) };
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
    && value.angle >= 0 && value.angle < 360 && value.width >= 5 && value.width <= 60;
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