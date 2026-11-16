import type { PositionEstimate, PositionEstimateState } from './positionEstimate';

/**
 * The console's position estimate (tools/doa_position_estimate.py) in the
 * browser, for the replay of a recorded session and the flight simulation:
 * the same grid, ray score, station weighting, re-centring and states, so a
 * replay draws what the console drew. tools/fixtures/position-estimate/drive.json
 * holds one drive and the console's answer to it (estimateEngine.test.ts).
 */

export const GRID_SIZE_M = 10_000;
export const GRID_CELLS = 100;
export const BEARING_SIGMA_DEG = 6;
const BEARING_CUTOFF_DEG = 3 * BEARING_SIGMA_DEG;
export const STATION_M = 50;
export const MIN_STATIONS = 3;
export const MIN_SPREAD_DEG = 10;
export const ROUGH_MIN_STATIONS = 2;
export const ROUGH_SPREAD_DEG = 3;
export const UNVERIFIED_WEIGHT = 0.35;
export const MIN_BEARING_NOISE_DEG = 2;
export const MIN_RADIUS_M = GRID_SIZE_M / GRID_CELLS;
export const MAX_RADIUS_M = GRID_SIZE_M;
export const FREQUENCY_TOLERANCE_HZ = 25_000;
export const HISTORY = 1500;
export const RAYS_SENT = 200;
const MAP_CELLS = 800;
const MAP_FLOOR = 0.2;
const EARTH_R = 6_371_000;
const RAD = Math.PI / 180;

/** One ray: where it was taken and where it pointed. */
export interface EstimateSample {
  tMs: number;
  latitude: number;
  longitude: number;
  bearingDeg: number;
  verified: boolean;
  frequencyHz: number;
}

interface ScoredSample extends EstimateSample {
  weight: number;
}

function mod(value: number, n: number): number {
  return ((value % n) + n) % n;
}

/** Metres east and north of (lat0, lon0); equirectangular, as the console. */
function eastNorth(lat0: number, lon0: number, lat: number, lon: number): [number, number] {
  const east = (mod(lon - lon0 + 540, 360) - 180) * RAD * Math.cos(lat0 * RAD) * EARTH_R;
  const north = (lat - lat0) * RAD * EARTH_R;
  return [east, north];
}

function latLon(lat0: number, lon0: number, east: number, north: number): [number, number] {
  const lat = lat0 + north / EARTH_R / RAD;
  const lon = lon0 + east / (EARTH_R * Math.cos(lat0 * RAD)) / RAD;
  return [lat, mod(lon + 540, 360) - 180];
}

function bearingOf(east: number, north: number): number {
  return mod(Math.atan2(east, north) / RAD, 360);
}

/** Python's round() for halves: to the even neighbour, so station keys match the console's. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

class Grid {
  readonly cell = GRID_SIZE_M / GRID_CELLS;
  readonly values = new Float64Array(GRID_CELLS * GRID_CELLS);

  constructor(readonly lat0: number, readonly lon0: number) {}

  centre(index: number): [number, number] {
    const half = GRID_SIZE_M / 2;
    return [-half + ((index % GRID_CELLS) + 0.5) * this.cell, -half + (Math.floor(index / GRID_CELLS) + 0.5) * this.cell];
  }

  containsInner(east: number, north: number): boolean {
    const limit = GRID_SIZE_M / 4;
    return Math.abs(east) <= limit && Math.abs(north) <= limit;
  }

  addRay(east: number, north: number, bearing: number, weight: number): void {
    const sigma2 = 2 * BEARING_SIGMA_DEG * BEARING_SIGMA_DEG;
    const sinB = Math.sin(bearing * RAD);
    const cosB = Math.cos(bearing * RAD);
    const cutoff = BEARING_CUTOFF_DEG * RAD;
    const half = GRID_SIZE_M / 2;
    for (let j = 0; j < GRID_CELLS; j += 1) {
      const dy = -half + (j + 0.5) * this.cell - north;
      for (let i = 0; i < GRID_CELLS; i += 1) {
        const dx = -half + (i + 0.5) * this.cell - east;
        const along = dx * sinB + dy * cosB;
        if (along <= this.cell) continue;
        const across = dx * cosB - dy * sinB;
        const angle = Math.atan2(Math.abs(across), along);
        if (angle > cutoff) continue;
        const degrees = angle / RAD;
        this.values[j * GRID_CELLS + i] += weight * Math.exp(-(degrees * degrees) / sigma2);
      }
    }
  }
}

function circularSpan(directions: number[]): number {
  if (directions.length < 2) return 0;
  const ordered = directions.map((d) => mod(d, 360)).sort((a, b) => a - b);
  let largest = 360 - ordered[ordered.length - 1] + ordered[0];
  for (let k = 0; k + 1 < ordered.length; k += 1) largest = Math.max(largest, ordered[k + 1] - ordered[k]);
  return 360 - largest;
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Rays in, one PositionEstimate out, as the console builds it. */
export class EstimateEngine {
  private grid: Grid | null = null;
  private samples: ScoredSample[] = [];
  private stations = new Map<string, number>();
  private frequency: number | null = null;
  private result: PositionEstimate = emptyEstimate();

  add(sample: EstimateSample): void {
    if (this.frequency !== null && Math.abs(sample.frequencyHz - this.frequency) > FREQUENCY_TOLERANCE_HZ) this.reset();
    if (this.frequency === null) this.frequency = sample.frequencyHz;
    let grid = this.grid ?? new Grid(sample.latitude, sample.longitude);
    const [east, north] = eastNorth(grid.lat0, grid.lon0, sample.latitude, sample.longitude);
    const replay = !grid.containsInner(east, north);
    if (replay) grid = new Grid(sample.latitude, sample.longitude);
    const scored: ScoredSample = { ...sample, bearingDeg: mod(sample.bearingDeg, 360), weight: this.weight(sample) };
    if (replay) {
      for (const old of this.samples) {
        const [ox, oy] = eastNorth(grid.lat0, grid.lon0, old.latitude, old.longitude);
        grid.addRay(ox, oy, old.bearingDeg, old.weight);
      }
    }
    this.samples.push(scored);
    if (this.samples.length > HISTORY) this.samples.shift();
    const [sx, sy] = eastNorth(grid.lat0, grid.lon0, sample.latitude, sample.longitude);
    grid.addRay(sx, sy, scored.bearingDeg, scored.weight);
    this.grid = grid;
    this.result = this.summarize(grid, scored);
  }

  reset(): void {
    this.grid = null;
    this.samples = [];
    this.stations = new Map();
    this.frequency = null;
    this.result = emptyEstimate();
  }

  view(): PositionEstimate {
    return this.result;
  }

  private weight(sample: EstimateSample): number {
    const keyLat = roundHalfEven((sample.latitude * RAD * EARTH_R) / STATION_M);
    const keyLon = roundHalfEven((sample.longitude * RAD * EARTH_R * Math.cos(sample.latitude * RAD)) / STATION_M);
    const key = `${keyLat},${keyLon}`;
    const count = (this.stations.get(key) ?? 0) + 1;
    this.stations.set(key, count);
    return (sample.verified ? 1 : UNVERIFIED_WEIGHT) / count;
  }

  /** Two standard deviations of the estimate along its widest axis (doa_position_estimate._uncertainty_m). */
  private uncertaintyM(grid: Grid, ex: number, ey: number): number {
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    let residual = 0;
    let total = 0;
    for (const sample of this.samples) {
      const [ox, oy] = eastNorth(grid.lat0, grid.lon0, sample.latitude, sample.longitude);
      const dx = ex - ox;
      const dy = ey - oy;
      const distance = Math.hypot(dx, dy);
      if (distance < grid.cell) continue;
      const miss = mod(sample.bearingDeg - bearingOf(dx, dy) + 180, 360) - 180;
      if (Math.abs(miss) > BEARING_CUTOFF_DEG) continue;
      residual += sample.weight * miss * miss;
      total += sample.weight;
      const nx = -dy / distance;
      const ny = dx / distance;
      const info = sample.weight / (distance * distance);
      sxx += info * nx * nx;
      sxy += info * nx * ny;
      syy += info * ny * ny;
    }
    if (total <= 0) return MAX_RADIUS_M;
    const noise = Math.max(MIN_BEARING_NOISE_DEG, Math.sqrt(residual / total)) * RAD;
    const trace = sxx + syy;
    const det = sxx * syy - sxy * sxy;
    const smallest = trace / 2 - Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
    if (smallest <= 1e-18) return MAX_RADIUS_M;
    return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, (2 * noise) / Math.sqrt(smallest)));
  }

  private summarize(grid: Grid, latest: ScoredSample): PositionEstimate {
    const values = grid.values;
    let peakIndex = 0;
    for (let index = 1; index < values.length; index += 1) if (values[index] > values[peakIndex]) peakIndex = index;
    const peak = values[peakIndex];
    const base: PositionEstimate = {
      ...emptyEstimate(),
      samples: this.samples.length,
      unverifiedSamples: this.samples.filter((s) => !s.verified).length,
      frequencyHz: this.frequency,
      rays: this.samples.slice(-RAYS_SENT).map((s) => ({ tMs: s.tMs, latitude: s.latitude, longitude: s.longitude, bearingDeg: s.bearingDeg, verified: s.verified })),
    };
    if (!(peak > 0)) return base;
    const [px, py] = grid.centre(peakIndex);
    let total = 0;
    let sx = 0;
    let sy = 0;
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value >= 0.8 * peak) {
        const [cx, cy] = grid.centre(index);
        if (Math.abs(cx - px) <= 3 * grid.cell && Math.abs(cy - py) <= 3 * grid.cell) {
          total += value;
          sx += value * cx;
          sy += value * cy;
        }
      }
    }
    const ex = sx / total;
    const ey = sy / total;
    const [lat, lon] = latLon(grid.lat0, grid.lon0, ex, ey);
    const seen = new Set<string>();
    const directions: number[] = [];
    for (const sample of this.samples) {
      const [ox, oy] = eastNorth(grid.lat0, grid.lon0, sample.latitude, sample.longitude);
      const key = `${roundHalfEven(ox / STATION_M)},${roundHalfEven(oy / STATION_M)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      directions.push(bearingOf(ox - ex, oy - ey));
    }
    const spread = circularSpan(directions);
    const ready = seen.size >= MIN_STATIONS && spread >= MIN_SPREAD_DEG;
    const rough = !ready && seen.size >= ROUGH_MIN_STATIONS && spread >= ROUGH_SPREAD_DEG;
    const state: PositionEstimateState = ready ? 'ESTIMATE' : rough ? 'ROUGH' : 'NEED_MOVEMENT';
    const [nx, ny] = eastNorth(grid.lat0, grid.lon0, latest.latitude, latest.longitude);
    const cells: Array<[number, number]> = [];
    for (let index = 0; index < values.length; index += 1) if (values[index] >= MAP_FLOOR * peak) cells.push([values[index], index]);
    cells.sort((a, b) => b[0] - a[0]);
    const half = GRID_SIZE_M / 2;
    const [south, west] = latLon(grid.lat0, grid.lon0, -half, -half);
    const [north, east] = latLon(grid.lat0, grid.lon0, half, half);
    const weightTotal = this.samples.reduce((sum, s) => sum + s.weight, 0);
    return {
      ...base,
      state,
      stations: seen.size,
      spreadDeg: round(spread, 1),
      latitude: round(lat, 6),
      longitude: round(lon, 6),
      radiusM: Math.round(this.uncertaintyM(grid, ex, ey)),
      distanceM: Math.round(Math.hypot(ex - nx, ey - ny)),
      bearingDeg: round(bearingOf(ex - nx, ey - ny), 1),
      peakShare: round(peak / Math.max(1e-9, weightTotal), 3),
      grid: {
        south, west, north, east, cells: GRID_CELLS,
        hot: cells.slice(0, MAP_CELLS).map(([value, index]) => [index % GRID_CELLS, Math.floor(index / GRID_CELLS), round(value / peak, 3)]),
      },
    };
  }
}

/** The empty estimate the console serves before any ray. */
export function emptyEstimate(): PositionEstimate {
  return {
    state: 'NO_DATA',
    latitude: null,
    longitude: null,
    radiusM: null,
    distanceM: null,
    bearingDeg: null,
    groundDistanceM: null,
    groundBearingDeg: null,
    groundLatitude: null,
    groundLongitude: null,
    bearingSource: null,
    positionSource: null,
    samples: 0,
    unverifiedSamples: 0,
    stations: 0,
    spreadDeg: null,
    frequencyHz: null,
    minStations: MIN_STATIONS,
    minSpreadDeg: MIN_SPREAD_DEG,
    roughMinStations: ROUGH_MIN_STATIONS,
    roughSpreadDeg: ROUGH_SPREAD_DEG,
    resetReason: null,
    grid: null,
    rays: [],
    peakShare: null,
    waitingFor: null,
    skipped: 0,
    nodeGpsFix: null,
    positionWithheld: null,
  };
}

/** The estimate after the first `count` samples, from scratch. */
export function estimateAfter(samples: readonly EstimateSample[], count: number): PositionEstimate {
  const engine = new EstimateEngine();
  for (const sample of samples.slice(0, count)) engine.add(sample);
  return engine.view();
}
