import type { Feature, FeatureCollection, LineString } from 'geojson';
import { fromUtm, toUtm, toUtmInZone } from './gridCoordinates';

/**
 * A reference grid over the map for reading positions off a land map: UTM
 * (lines of whole easting X and northing Y, labelled "X 795000"), MGRS (the
 * same lines, labelled with their digits inside the 100 km square as a
 * topographic sheet prints them) or a latitude/longitude graticule. UTM and
 * MGRS keep the zone of the view's centre, as one printed sheet does.
 */
export type MapGridKind = 'off' | 'utm' | 'mgrs' | 'latlon';

export const MAP_GRID_KINDS: readonly MapGridKind[] = ['off', 'utm', 'mgrs', 'latlon'];

export function isMapGridKind(value: unknown): value is MapGridKind {
  return typeof value === 'string' && (MAP_GRID_KINDS as readonly string[]).includes(value);
}

export interface MapViewBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface MapGridProperties {
  /** 'x' for a line of one easting or longitude, 'y' for one northing or latitude. */
  axis: 'x' | 'y';
  label: string;
}

export type MapGridFeatures = FeatureCollection<LineString, MapGridProperties>;

export const NO_MAP_GRID: MapGridFeatures = { type: 'FeatureCollection', features: [] };

/** At most this many lines each way; the spacing grows until they fit. */
export const MAP_GRID_MAX_LINES = 15;
const METRE_STEPS = [100, 1_000, 10_000, 100_000];
const DEGREE_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
const LINE_SAMPLES = 24;
const MGRS_COLUMNS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const MGRS_ROWS = 'ABCDEFGHJKLMNPQRSTUV';

/** The smallest step that keeps the lines across `span` at MAP_GRID_MAX_LINES or fewer, or null. */
export function gridStep(span: number, steps: readonly number[]): number | null {
  if (!(span > 0)) return null;
  return steps.find((step) => span / step <= MAP_GRID_MAX_LINES) ?? null;
}

function multiples(low: number, high: number, step: number): number[] {
  const values: number[] = [];
  for (let k = Math.ceil(low / step); k * step <= high && values.length <= MAP_GRID_MAX_LINES * 4; k += 1) {
    // Rounded to the step's own decimals, so 0.1 steps give -6.9, not -6.8999999.
    values.push(Number((k * step).toFixed(6)));
  }
  return values;
}

function line(points: Array<[number, number]>, properties: MapGridProperties): Feature<LineString, MapGridProperties> {
  return { type: 'Feature', properties, geometry: { type: 'LineString', coordinates: points } };
}

/** The label of an easting (axis x) or northing (axis y) line: UTM in metres, MGRS in the square's digits. */
export function utmLineLabel(kind: 'utm' | 'mgrs', axis: 'x' | 'y', metres: number, step: number, zone: number): string {
  if (kind === 'utm') return `${axis === 'x' ? 'X' : 'Y'} ${Math.round(metres)}`;
  const inSquare = ((Math.round(metres) % 100_000) + 100_000) % 100_000;
  if (step >= 100_000) {
    // A 100 km line starts a square: name its letter.
    if (axis === 'x') return MGRS_COLUMNS[(zone - 1) % 3][Math.round(metres / 100_000) - 1] ?? '';
    return MGRS_ROWS[(Math.round(metres / 100_000) + (zone % 2 === 0 ? 5 : 0)) % MGRS_ROWS.length];
  }
  const digits = 5 - Math.round(Math.log10(step));
  return String(Math.floor(inSquare / step)).padStart(digits, '0');
}

function utmGrid(kind: 'utm' | 'mgrs', bounds: MapViewBounds): MapGridFeatures {
  const centre = toUtm((bounds.south + bounds.north) / 2, (bounds.west + bounds.east) / 2);
  if (!centre) return NO_MAP_GRID;
  const { zone, south } = centre;
  // The view's outline in this zone, sampled along its edges.
  const eastings: number[] = [];
  const northings: number[] = [];
  for (let k = 0; k <= 8; k += 1) {
    const f = k / 8;
    for (const [lat, lon] of [
      [bounds.south, bounds.west + f * (bounds.east - bounds.west)],
      [bounds.north, bounds.west + f * (bounds.east - bounds.west)],
      [bounds.south + f * (bounds.north - bounds.south), bounds.west],
      [bounds.south + f * (bounds.north - bounds.south), bounds.east],
    ]) {
      const utm = toUtmInZone(Math.max(-80, Math.min(84, lat)), lon, zone);
      if (!utm) continue;
      eastings.push(utm.easting);
      // Signed northings (negative south of the equator), so a view across it stays continuous.
      northings.push(utm.south ? utm.northing - 10_000_000 : utm.northing);
    }
  }
  if (eastings.length === 0) return NO_MAP_GRID;
  const eMin = Math.min(...eastings);
  const eMax = Math.max(...eastings);
  const nMin = Math.min(...northings);
  const nMax = Math.max(...northings);
  const step = gridStep(Math.max(eMax - eMin, nMax - nMin), METRE_STEPS);
  if (step === null) return NO_MAP_GRID;
  const features: Array<Feature<LineString, MapGridProperties>> = [];
  const toLonLat = (e: number, n: number): [number, number] => {
    const { latitude, longitude } = fromUtm(zone, false, e, n);
    return [longitude, latitude];
  };
  // Labels keep the sheet's own false northing: 10 000 000 m added in a southern zone.
  const shown = (n: number) => (south ? n + 10_000_000 : n);
  for (const e of multiples(eMin, eMax, step)) {
    const points = Array.from({ length: LINE_SAMPLES + 1 }, (_, k) => toLonLat(e, nMin + ((nMax - nMin) * k) / LINE_SAMPLES));
    features.push(line(points, { axis: 'x', label: utmLineLabel(kind, 'x', e, step, zone) }));
  }
  for (const n of multiples(nMin, nMax, step)) {
    const points = Array.from({ length: LINE_SAMPLES + 1 }, (_, k) => toLonLat(eMin + ((eMax - eMin) * k) / LINE_SAMPLES, n));
    features.push(line(points, { axis: 'y', label: utmLineLabel(kind, 'y', shown(n), step, zone) }));
  }
  return { type: 'FeatureCollection', features };
}

/** "-6.93°" with the decimals the step needs. */
export function degreeLabel(value: number, step: number): string {
  const decimals = Math.max(0, Math.min(3, Math.ceil(-Math.log10(step) - 1e-9)));
  return `${value.toFixed(decimals)}°`;
}

function latLonGrid(bounds: MapViewBounds): MapGridFeatures {
  const south = Math.max(-85, bounds.south);
  const north = Math.min(85, bounds.north);
  const step = gridStep(Math.max(bounds.east - bounds.west, north - south), DEGREE_STEPS);
  if (step === null) return NO_MAP_GRID;
  const features: Array<Feature<LineString, MapGridProperties>> = [];
  for (const lon of multiples(bounds.west, bounds.east, step)) {
    features.push(line([[lon, south], [lon, north]], { axis: 'x', label: degreeLabel(lon, step) }));
  }
  for (const lat of multiples(south, north, step)) {
    features.push(line([[bounds.west, lat], [bounds.east, lat]], { axis: 'y', label: degreeLabel(lat, step) }));
  }
  return { type: 'FeatureCollection', features };
}

/** The grid lines over the view, each with the label it prints along itself. */
export function mapGridFeatures(kind: MapGridKind, bounds: MapViewBounds): MapGridFeatures {
  if (kind === 'off' || ![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)) return NO_MAP_GRID;
  if (bounds.east <= bounds.west || bounds.north <= bounds.south) return NO_MAP_GRID;
  return kind === 'latlon' ? latLonGrid(bounds) : utmGrid(kind, bounds);
}

/** Grid ink that reads on the drawn tiles: light lines on dark tiles, dark on light ones. */
export function mapGridColors(dark: boolean): { line: string; text: string; halo: string } {
  return dark
    ? { line: 'rgba(235, 242, 248, 0.55)', text: '#eef3f7', halo: 'rgba(12, 16, 20, 0.85)' }
    : { line: 'rgba(24, 36, 48, 0.5)', text: '#18242f', halo: 'rgba(255, 255, 255, 0.9)' };
}
