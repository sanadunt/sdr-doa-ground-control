import { describe, expect, it } from 'vitest';
import { formatGridMetres, gsRelativeXY, isCoordinateFormat, toMgrs, toUtm } from './gridCoordinates';

/** WGS84 to UTM by pyproj 3.8 (EPSG:326xx/327xx) and MGRS by the `mgrs` package, 1 m digits. */
const REFERENCE = [
  { lat: -6.932469, lon: 107.660694, zone: 48, band: 'M', easting: 794021.736, northing: 9232891.995, mgrs: '48MYT9402132891' },
  { lat: -6.1754, lon: 106.8272, zone: 48, band: 'M', easting: 702183.322, northing: 9317059.383, mgrs: '48MYU0218317059' },
  { lat: -8.65, lon: 115.2167, zone: 50, band: 'L', easting: 303775.165, northing: 9043383.104, mgrs: '50LLR0377543383' },
  { lat: 3.5952, lon: 98.6722, zone: 47, band: 'N', easting: 463595.175, northing: 397389.385, mgrs: '47NMD6359597389' },
  { lat: -0.5, lon: 117.15, zone: 50, band: 'M', easting: 516690.632, northing: 9944734.772, mgrs: '50MNE1669044734' },
  { lat: 0, lon: 0, zone: 31, band: 'N', easting: 166021.443, northing: 0, mgrs: '31NAA6602100000' },
  { lat: 51.4778, lon: -0.0015, zone: 30, band: 'U', easting: 708213.951, northing: 5707224.543, mgrs: '30UYC0821307224' },
  { lat: 40.7128, lon: -74.006, zone: 18, band: 'T', easting: 583959.372, northing: 4507350.998, mgrs: '18TWL8395907350' },
  { lat: -33.8688, lon: 151.2093, zone: 56, band: 'H', easting: 334368.634, northing: 6250948.345, mgrs: '56HLH3436850948' },
  { lat: 60.5, lon: 4.5, zone: 32, band: 'V', easting: 252928.532, northing: 6715548.234, mgrs: '32VKN5292815548' },
  { lat: 78.2, lon: 15.6, zone: 33, band: 'X', easting: 513696.945, northing: 8680760.053, mgrs: '33XWG1369680760' },
  { lat: -79.9, lon: 170, zone: 59, band: 'C', easting: 480423.389, northing: 1129407.483, mgrs: '59CMM8042329407' },
  { lat: 83.9, lon: -40, zone: 24, band: 'X', easting: 488136.731, northing: 9317033.097, mgrs: '24XVU8813617033' },
  { lat: -6.92026, lon: 107.67402, zone: 48, band: 'M', easting: 795502.988, northing: 9234234.805, mgrs: '48MYT9550234234' },
  { lat: -10.99, lon: 140.99, zone: 54, band: 'L', easting: 498907.525, northing: 8785126.253, mgrs: '54LVN9890785126' },
  { lat: 5.9, lon: 95.3, zone: 46, band: 'N', easting: 754653.105, northing: 652675.978, mgrs: '46NGM5465352675' },
];

describe('UTM', () => {
  it.each(REFERENCE)('matches pyproj at $lat, $lon', (point) => {
    const utm = toUtm(point.lat, point.lon);
    expect(utm).not.toBeNull();
    expect(utm!.zone).toBe(point.zone);
    expect(utm!.band).toBe(point.band);
    expect(utm!.south).toBe(point.lat < 0);
    expect(Math.abs(utm!.easting - point.easting)).toBeLessThan(0.01);
    expect(Math.abs(utm!.northing - point.northing)).toBeLessThan(0.01);
  });

  it('has no UTM beyond 80°S and 84°N, or for a value that is not a coordinate', () => {
    expect(toUtm(-80.5, 10)).toBeNull();
    expect(toUtm(84.5, 10)).toBeNull();
    expect(toUtm(Number.NaN, 10)).toBeNull();
    expect(toUtm(10, 181)).toBeNull();
  });

  it('puts 180° in zone 60', () => {
    expect(toUtm(-6, 180)?.zone).toBe(60);
  });
});

describe('MGRS', () => {
  it.each(REFERENCE)('matches the mgrs package at $lat, $lon', (point) => {
    const text = toMgrs(point.lat, point.lon);
    expect(text?.replace(/ /g, '')).toBe(point.mgrs);
  });

  it('groups zone, square and the two numbers, truncating to the digits asked', () => {
    expect(toMgrs(-6.932469, 107.660694)).toBe('48M YT 94021 32891');
    expect(toMgrs(-6.932469, 107.660694, 4)).toBe('48M YT 9402 3289');
    expect(toMgrs(-6.932469, 107.660694, 3)).toBe('48M YT 940 328');
    expect(toMgrs(85, 0)).toBeNull();
  });
});

describe('X,Y from the groundstation', () => {
  const ground = { latitude: -6.94, longitude: 107.65 };

  it('measures metres east (X) and north (Y), signed', () => {
    const north = gsRelativeXY(ground, { latitude: -6.94 + 1000 / 111_195, longitude: 107.65 });
    expect(Math.abs(north.x)).toBeLessThan(1);
    expect(Math.abs(north.y - 1000)).toBeLessThan(10);
    const east = gsRelativeXY(ground, { latitude: -6.94, longitude: 107.65 + 1000 / (111_195 * Math.cos(-6.94 * Math.PI / 180)) });
    expect(Math.abs(east.x - 1000)).toBeLessThan(10);
    expect(Math.abs(east.y)).toBeLessThan(1);
    const southWest = gsRelativeXY(ground, { latitude: -6.95, longitude: 107.64 });
    expect(southWest.x).toBeLessThan(0);
    expect(southWest.y).toBeLessThan(0);
  });

  it('agrees with the WGS84 ellipsoid (pyproj Geod) within a metre', () => {
    // Geod.inv from -6.92, 107.6 to -6.902, 107.62: 2974.58 m at 47.995°.
    const { x, y } = gsRelativeXY({ latitude: -6.92, longitude: 107.6 }, { latitude: -6.902, longitude: 107.62 });
    expect(Math.abs(x - 2210.36)).toBeLessThan(1);
    expect(Math.abs(y - 1990.58)).toBeLessThan(1);
  });

  it('writes signed whole metres', () => {
    expect(formatGridMetres(2340.4)).toBe('+2340 m');
    expect(formatGridMetres(-1180.6)).toBe('−1181 m');
    expect(formatGridMetres(0.2)).toBe('0 m');
  });
});

it('knows the four formats', () => {
  for (const format of ['latlon', 'utm', 'mgrs', 'gsxy']) expect(isCoordinateFormat(format)).toBe(true);
  expect(isCoordinateFormat('xy')).toBe(false);
  expect(isCoordinateFormat(null)).toBe(false);
});
