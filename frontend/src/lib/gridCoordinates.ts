import type { GeoOrigin } from './doaGeometry';

/**
 * How a position is written for a land map: latitude/longitude, UTM grid
 * (zone, X easting and Y northing in metres, WGS84), MGRS, or X/Y in metres
 * east and north of the groundstation. Display only; positions stay WGS84.
 */
export type CoordinateFormat = 'latlon' | 'utm' | 'mgrs' | 'gsxy';

export const COORDINATE_FORMATS: readonly CoordinateFormat[] = ['latlon', 'utm', 'mgrs', 'gsxy'];

export function isCoordinateFormat(value: unknown): value is CoordinateFormat {
  return typeof value === 'string' && (COORDINATE_FORMATS as readonly string[]).includes(value);
}

export interface UtmCoordinate {
  zone: number;
  /** Latitude band letter, C to X. */
  band: string;
  south: boolean;
  /** Metres, with the false easting of 500 000 m. */
  easting: number;
  /** Metres, with the false northing of 10 000 000 m south of the equator. */
  northing: number;
}

const A = 6_378_137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
// Third-order Krüger series of the transverse Mercator projection: millimetres inside a zone.
const N = F / (2 - F);
const RECTIFYING_RADIUS = (A / (1 + N)) * (1 + N ** 2 / 4 + N ** 4 / 64);
const ALPHA = [N / 2 - (2 * N ** 2) / 3 + (5 * N ** 3) / 16, (13 * N ** 2) / 48 - (3 * N ** 3) / 5, (61 * N ** 3) / 240];
const E2N = (2 * Math.sqrt(N)) / (1 + N);

/** The UTM zone, with the Norway and Svalbard exceptions. */
function utmZone(lat: number, lon: number): number {
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) return 32;
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) return 31;
    if (lon >= 9 && lon < 21) return 33;
    if (lon >= 21 && lon < 33) return 35;
    if (lon >= 33 && lon < 42) return 37;
  }
  return Math.min(60, Math.floor((lon + 180) / 6) + 1);
}

/** WGS84 latitude and longitude to UTM; null outside 80°S..84°N, where UTM is not defined. */
export function toUtm(lat: number, lon: number): UtmCoordinate | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -80 || lat > 84 || lon < -180 || lon > 180) return null;
  const zone = utmZone(lat, lon);
  const central = ((zone - 1) * 6 - 180 + 3) * (Math.PI / 180);
  const phi = lat * (Math.PI / 180);
  const lambda = lon * (Math.PI / 180) - central;
  const sinPhi = Math.sin(phi);
  const t = Math.sinh(Math.atanh(sinPhi) - E2N * Math.atanh(E2N * sinPhi));
  const xiPrime = Math.atan2(t, Math.cos(lambda));
  const etaPrime = Math.atanh(Math.sin(lambda) / Math.sqrt(1 + t * t));
  let xi = xiPrime;
  let eta = etaPrime;
  ALPHA.forEach((alpha, index) => {
    const j = 2 * (index + 1);
    xi += alpha * Math.sin(j * xiPrime) * Math.cosh(j * etaPrime);
    eta += alpha * Math.cos(j * xiPrime) * Math.sinh(j * etaPrime);
  });
  const south = lat < 0;
  return {
    zone,
    band: BANDS[Math.min(BANDS.length - 1, Math.floor((lat + 80) / 8))],
    south,
    easting: 500_000 + K0 * RECTIFYING_RADIUS * eta,
    northing: (south ? 10_000_000 : 0) + K0 * RECTIFYING_RADIUS * xi,
  };
}

const MGRS_COLUMNS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const MGRS_ROWS = 'ABCDEFGHJKLMNPQRSTUV';

/**
 * MGRS as a land map reads it: "48M YT 94021 32891" (zone and band, the
 * 100 km square, then X and Y), with `digits` per number (5 is 1 m, 4 is
 * 10 m, 3 is 100 m), truncated as MGRS is; null where UTM is not defined.
 */
export function toMgrs(lat: number, lon: number, digits: 1 | 2 | 3 | 4 | 5 = 5): string | null {
  const utm = toUtm(lat, lon);
  if (!utm) return null;
  const set = ((utm.zone - 1) % 3);
  const column = MGRS_COLUMNS[set][Math.floor(utm.easting / 100_000) - 1];
  const rowOffset = utm.zone % 2 === 0 ? 5 : 0;
  const row = MGRS_ROWS[(Math.floor(utm.northing / 100_000) + rowOffset) % MGRS_ROWS.length];
  if (!column || !row) return null;
  const scale = 10 ** (5 - digits);
  const part = (metres: number) => String(Math.floor((Math.floor(metres) % 100_000) / scale)).padStart(digits, '0');
  return `${utm.zone}${utm.band} ${column}${row} ${part(utm.easting)} ${part(utm.northing)}`;
}

/**
 * Metres east (x) and north (y) of the groundstation, on the WGS84 ellipsoid's
 * local radii at the middle latitude: within a metre over the estimate's 10 km.
 */
export function gsRelativeXY(ground: GeoOrigin, point: GeoOrigin): { x: number; y: number } {
  const e2 = F * (2 - F);
  const phi = ((ground.latitude + point.latitude) / 2) * (Math.PI / 180);
  const w = 1 - e2 * Math.sin(phi) ** 2;
  const meridian = (A * (1 - e2)) / w ** 1.5;
  const normal = A / Math.sqrt(w);
  const dLon = ((((point.longitude - ground.longitude) + 540) % 360) - 180) * (Math.PI / 180);
  const dLat = (point.latitude - ground.latitude) * (Math.PI / 180);
  return { x: dLon * normal * Math.cos(phi), y: dLat * meridian };
}

/** Whole metres with their sign: "+2340 m", "−1181 m", "0 m". */
export function formatGridMetres(metres: number): string {
  const rounded = Math.round(metres);
  if (rounded === 0) return '0 m';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)} m`;
}
