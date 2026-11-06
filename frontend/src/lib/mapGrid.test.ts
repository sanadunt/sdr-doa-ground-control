import { describe, expect, it } from 'vitest';
import { toUtmInZone } from './gridCoordinates';
import { MAP_GRID_MAX_LINES, degreeLabel, gridStep, isMapGridKind, mapGridColors, mapGridFeatures, utmLineLabel } from './mapGrid';

/** About 6 km by 5 km around the simulated station in Bandung (UTM 48M). */
const BANDUNG = { west: 107.63, south: -6.955, east: 107.685, north: -6.91 };

describe('UTM and MGRS grid', () => {
  const utm = mapGridFeatures('utm', BANDUNG);
  const xLines = utm.features.filter((line) => line.properties.axis === 'x');
  const yLines = utm.features.filter((line) => line.properties.axis === 'y');

  it('draws a 1 km grid over a view of a few kilometres, labelled X and Y in metres', () => {
    expect(xLines.length).toBeGreaterThanOrEqual(4);
    expect(yLines.length).toBeGreaterThanOrEqual(4);
    expect(xLines.map((line) => line.properties.label)).toContain('X 795000');
    expect(yLines.map((line) => line.properties.label)).toContain('Y 9234000');
    for (const line of xLines) expect(line.properties.label).toMatch(/^X \d{3}000$/);
    for (const line of yLines) expect(line.properties.label).toMatch(/^Y \d{4}000$/);
  });

  it('puts every point of a line on its own easting or northing', () => {
    for (const line of utm.features) {
      const value = Number(line.properties.label.slice(2));
      for (const [lon, lat] of line.geometry.coordinates) {
        const point = toUtmInZone(lat, lon, 48)!;
        expect(Math.abs((line.properties.axis === 'x' ? point.easting : point.northing) - value)).toBeLessThan(0.01);
      }
    }
  });

  it('labels MGRS lines with their digits inside the 100 km square', () => {
    const mgrs = mapGridFeatures('mgrs', BANDUNG);
    const labels = mgrs.features.map((line) => `${line.properties.axis}${line.properties.label}`);
    expect(labels).toContain('x95');
    expect(labels).toContain('y34');
    expect(utmLineLabel('mgrs', 'x', 795_500, 100, 48)).toBe('955');
    expect(utmLineLabel('mgrs', 'x', 790_000, 10_000, 48)).toBe('9');
    // 100 km lines start a square and carry its letter (zone 48: columns S-Z, rows offset by 5).
    expect(utmLineLabel('mgrs', 'x', 700_000, 100_000, 48)).toBe('Y');
    expect(utmLineLabel('mgrs', 'y', 9_200_000, 100_000, 48)).toBe('T');
  });

  it('widens the step as the view grows and stops at a whole-country view', () => {
    const wide = mapGridFeatures('utm', { west: 107, south: -7.5, east: 108.2, north: -6.4 });
    expect(wide.features[0].properties.label).toMatch(/0000$/);
    expect(wide.features.filter((line) => line.properties.axis === 'x').length).toBeLessThanOrEqual(MAP_GRID_MAX_LINES);
    expect(mapGridFeatures('utm', { west: 60, south: -40, east: 170, north: 40 }).features).toHaveLength(0);
  });

  it('keeps the zone of the view centre and runs across the equator', () => {
    const equator = mapGridFeatures('utm', { west: 117.1, south: -0.04, east: 117.16, north: 0.02 });
    const northings = equator.features.filter((line) => line.properties.axis === 'y').map((line) => Number(line.properties.label.slice(2)));
    // A southern centre keeps the false northing on both sides: 9 996 000 to 10 002 000.
    expect(Math.min(...northings)).toBeLessThan(10_000_000);
    expect(Math.max(...northings)).toBeGreaterThan(10_000_000);
  });
});

describe('latitude/longitude graticule', () => {
  it('draws lines at a round step with the decimals it needs', () => {
    const grid = mapGridFeatures('latlon', BANDUNG);
    const labels = grid.features.map((line) => line.properties.label);
    expect(labels).toContain('107.660°');
    expect(labels).toContain('-6.930°');
    expect(grid.features.filter((line) => line.properties.axis === 'x').length).toBeLessThanOrEqual(MAP_GRID_MAX_LINES);
    expect(degreeLabel(-6.9, 0.1)).toBe('-6.9°');
    expect(degreeLabel(107, 1)).toBe('107°');
    expect(degreeLabel(107.66, 0.01)).toBe('107.66°');
  });
});

describe('grid choices', () => {
  it('draws nothing when off or for a view that is not one', () => {
    expect(mapGridFeatures('off', BANDUNG).features).toHaveLength(0);
    expect(mapGridFeatures('utm', { ...BANDUNG, east: Number.NaN }).features).toHaveLength(0);
    expect(mapGridFeatures('latlon', { ...BANDUNG, east: BANDUNG.west }).features).toHaveLength(0);
  });

  it('knows its kinds, steps and colours', () => {
    for (const kind of ['off', 'utm', 'mgrs', 'latlon']) expect(isMapGridKind(kind)).toBe(true);
    expect(isMapGridKind('grid')).toBe(false);
    expect(gridStep(6000, [100, 1000, 10000])).toBe(1000);
    expect(gridStep(1200, [100, 1000])).toBe(100);
    expect(gridStep(0, [100])).toBeNull();
    expect(mapGridColors(true).text).not.toBe(mapGridColors(false).text);
  });
});
