import { bearingAndDistance, destination, type GeoOrigin } from './doaGeometry';
import type { EstimateSample } from './estimateEngine';
import { validateSimulation, type SimulationSettings } from './simulation';

/**
 * A simulated flight for the position estimate: the drone leaves the simulated
 * station across the bearing, cuts back past the middle towards the
 * transmitter's other side and turns across again, taking a bearing to the
 * transmitter every SAMPLE_INTERVAL_S with Gaussian noise; every third one is
 * an unverified bearing, as the edge sends while it has not verified its angle.
 * Seeded by the scenario, so the same settings fly the same flight.
 */
export const FLIGHT_SPEED_MS = 12;
export const SAMPLE_INTERVAL_S = 3;
export const FLIGHT_NOISE_DEG = { min: 0, max: 15, default: 4 } as const;
const FREQUENCY_HZ = 433_920_000;

export interface SimulatedFlight {
  rays: EstimateSample[];
  /** Where the simulated transmitter is. */
  transmitter: GeoOrigin;
}

/** mulberry32: small, fast, deterministic. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(next: () => number): number {
  const u = Math.max(1e-12, next());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

function at([longitude, latitude]: [number, number]): GeoOrigin {
  return { latitude, longitude };
}

export function simulatedFlight(settings: SimulationSettings, noiseDeg: number): SimulatedFlight | null {
  if (!validateSimulation(settings) || !(noiseDeg >= FLIGHT_NOISE_DEG.min && noiseDeg <= FLIGHT_NOISE_DEG.max)) return null;
  const station: GeoOrigin = { latitude: settings.latitude, longitude: settings.longitude };
  const targetM = settings.targetKm * 1000;
  const transmitter = at(destination(station, settings.angle, targetM));
  const middle = at(destination(station, settings.angle, targetM * 0.5));
  const corners: GeoOrigin[] = [
    station,
    at(destination(station, settings.angle + 90, Math.min(1500, targetM * 0.5))),
    at(destination(middle, settings.angle - 90, targetM * 0.4)),
    at(destination(middle, settings.angle + 90, targetM * 0.15)),
  ];
  const seed = Math.round(settings.latitude * 1e5) ^ Math.round(settings.longitude * 1e5) ^ Math.round(settings.angle * 10) ^ Math.round(settings.targetKm * 100) ^ Math.round(noiseDeg * 10);
  const next = random(seed);
  const step = FLIGHT_SPEED_MS * SAMPLE_INTERVAL_S;
  const rays: EstimateSample[] = [];
  let k = 0;
  for (let leg = 0; leg + 1 < corners.length; leg += 1) {
    const from = corners[leg];
    const { bearingDeg, distanceM } = bearingAndDistance(from, corners[leg + 1].longitude, corners[leg + 1].latitude);
    for (let along = leg === 0 ? 0 : step; along <= distanceM; along += step) {
      const here = at(destination(from, bearingDeg, along));
      const truth = bearingAndDistance(here, transmitter.longitude, transmitter.latitude).bearingDeg;
      rays.push({
        tMs: k * SAMPLE_INTERVAL_S * 1000,
        latitude: here.latitude,
        longitude: here.longitude,
        bearingDeg: ((truth + noiseDeg * gauss(next)) % 360 + 360) % 360,
        verified: k % 3 !== 2,
        frequencyHz: FREQUENCY_HZ,
      });
      k += 1;
    }
  }
  return { rays, transmitter };
}
