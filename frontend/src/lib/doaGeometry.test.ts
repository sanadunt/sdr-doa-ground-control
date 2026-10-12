import { describe, expect, it } from 'vitest';
import { DEFAULT_DOA_OVERLAY_SETTINGS, MIN_AUTO_DB_SPAN, bearingAndDistance, bearingFeature, beamFeatures, destination, edgeFeatures, effectiveDbScale, halfPowerWidth, heatDistanceWeight, heatFeatures, lobeFeature, niceRingStep, normalizeBearing, normalizeDb, rangeRings, saturatedFraction } from './doaGeometry';
import { displayAngleForBin, geographicBearingForBin } from './polar';

describe('DoA geographic overlay geometry', () => {
  const origin = { latitude: 0, longitude: 0 };
  it('keeps bearings north-clockwise and wraps values', () => {
    expect(normalizeBearing(-1)).toBe(359);
    expect(destination(origin, 0, 1000)[1]).toBeGreaterThan(0);
    expect(destination(origin, 90, 1000)[0]).toBeGreaterThan(0);
  });
  it('normalizes signed dB without pretending to be physical power', () => {
    expect(normalizeDb(-60, -60, 0)).toBe(0);
    expect(normalizeDb(0, -60, 0)).toBe(1);
    expect(normalizeDb(-30, -60, 0)).toBeCloseTo(0.5);
  });
  it('creates bounded lobe, bearing and heat features', () => {
    const values = Array.from({ length: 360 }, (_, i) => i === 90 ? 0 : -60);
    expect(lobeFeature(origin, values, DEFAULT_DOA_OVERLAY_SETTINGS).geometry.coordinates[0]).toHaveLength(361);
    expect(bearingFeature(origin, 90, DEFAULT_DOA_OVERLAY_SETTINGS).geometry.coordinates).toHaveLength(2);
    expect(heatFeatures(origin, values, DEFAULT_DOA_OVERLAY_SETTINGS).features.length).toBeGreaterThan(0);
  });
  it('supports threshold, radial density, and distance falloff controls', () => {
    const settings = { ...DEFAULT_DOA_OVERLAY_SETTINGS, thresholdDb: -20, radialSamples: 16, distanceFalloff: .8 };
    const values = Array.from({ length: 360 }, (_, i) => i === 90 ? -10 : -40);
    const heat = heatFeatures(origin, values, settings);
    expect(heat.features).toHaveLength(16);
    expect(heat.features[0].properties?.weight).toBeGreaterThan(heat.features[15].properties?.weight);
    expect(heatDistanceWeight(1, 10, .8)).toBeGreaterThan(heatDistanceWeight(10, 10, .8));
  });
});
describe('beam, rings, and half-power helpers', () => {
  const origin = { latitude: -6.93, longitude: 107.66 };
  const peaked = (center: number, width: number) => Array.from({ length: 360 }, (_, bin) => {
    const distance = Math.abs(((bin - center + 540) % 360) - 180);
    return -50 + 45 * Math.exp(-0.5 * (distance / width) ** 2);
  });

  it('builds one sector per bin and band above threshold, with weights for paint expressions', () => {
    const values = Array.from({ length: 360 }, (_, i) => (i >= 88 && i <= 92 ? 0 : -80));
    const settings = { ...DEFAULT_DOA_OVERLAY_SETTINGS, radialSamples: 4, thresholdDb: -60, distanceFalloff: 0 };
    const beam = beamFeatures(origin, values, settings);
    expect(beam.features).toHaveLength(5 * 4);
    const first = beam.features[0];
    // Bin 88 is theta_0 in the counter-clockwise array frame: 272° geographic with offset 0.
    expect(first.properties).toMatchObject({ bin: 88, bearing: 272, valueDb: 0, weight: 1 });
    const ring = first.geometry.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('drops sectors below the noise threshold and returns nothing for incomplete vectors', () => {
    const values = Array.from({ length: 360 }, () => -70);
    expect(beamFeatures(origin, values, { ...DEFAULT_DOA_OVERLAY_SETTINGS, thresholdDb: -60 }).features).toHaveLength(0);
    expect(beamFeatures(origin, values.slice(0, 200), DEFAULT_DOA_OVERLAY_SETTINGS).features).toHaveLength(0);
  });

  it('prunes near-zero density samples instead of painting a full disc', () => {
    const flatLow = Array.from({ length: 360 }, () => -59);
    expect(heatFeatures(origin, flatLow, DEFAULT_DOA_OVERLAY_SETTINGS).features).toHaveLength(0);
  });

  it('rounds ring spacing and places rings up to the projection distance', () => {
    expect(niceRingStep(1000)).toBe(250);
    expect(niceRingStep(2500)).toBe(1000);
    expect(niceRingStep(700)).toBe(200);
    const { rings, features } = rangeRings(origin, 1000);
    expect(rings.map((ring) => ring.distanceM)).toEqual([250, 500, 750, 1000]);
    expect(features.features).toHaveLength(4);
    expect(bearingAndDistance(origin, rings[3].label[0], rings[3].label[1]).distanceM).toBeCloseTo(1000, 0);
  });

  it('measures the contiguous -3 dB width around the peak, including wrap-around', () => {
    const width = halfPowerWidth(peaked(45, 18));
    expect(width?.peakIndex).toBe(45);
    // The synthetic curve is Gaussian in dB: -3 dB from a 45 dB swing at sigma 18° is ±6°.
    expect(width?.widthDeg).toBe(13);
    const wrapped = halfPowerWidth(peaked(2, 10));
    expect(wrapped?.startDeg).toBeGreaterThan(300);
    expect(wrapped?.endDeg).toBeLessThan(30);
    expect(halfPowerWidth(Array.from({ length: 360 }, () => -10))).toBeNull();
    expect(halfPowerWidth([0, 1, 2])).toBeNull();
  });

  it('computes bearing and distance consistently with destination()', () => {
    const [lon, lat] = destination(origin, 210, 640);
    const result = bearingAndDistance(origin, lon, lat);
    expect(result.bearingDeg).toBeCloseTo(210, 1);
    expect(result.distanceM).toBeCloseTo(640, 0);
  });
});

describe('density compensation', () => {
  it('scales density weight with distance so samples near the station do not pool', () => {
    const origin = { latitude: 0, longitude: 0 };
    const values = Array.from({ length: 360 }, (_, i) => (i === 10 ? 0 : -80));
    const heat = heatFeatures(origin, values, { ...DEFAULT_DOA_OVERLAY_SETTINGS, distanceFalloff: 0 });
    const weights = heat.features.map((feature) => feature.properties?.densityWeight as number);
    expect(weights[0]).toBeLessThan(weights[weights.length - 1]);
  });
});

describe('geographic bearing of theta_0 bins (AUD-01)', () => {
  const origin = { latitude: -6.2, longitude: 106.8 };
  const peaked = (center: number) => Array.from({ length: 360 }, (_, bin) => {
    const distance = Math.abs(((bin - center + 540) % 360) - 180);
    return -50 + 45 * Math.exp(-0.5 * (distance / 8) ** 2);
  });
  const angularGap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

  for (const theta of [0, 90, 180, 270, 350]) {
    for (const offset of [0, 30, -45, 90]) {
      it(`theta_0 ${theta}° with offset ${offset}° points where the Compass polar peak points`, () => {
        const expected = displayAngleForBin(theta, { figType: 'Compass', compassOffset: offset });
        expect(geographicBearingForBin(theta, offset)).toBe(expected);
        const values = peaked(theta);

        const ring = lobeFeature(origin, values, DEFAULT_DOA_OVERLAY_SETTINGS, offset).geometry.coordinates[0];
        const tip = ring.reduce((best, point) => {
          const measured = bearingAndDistance(origin, point[0], point[1]);
          return measured.distanceM > best.distanceM ? measured : best;
        }, { bearingDeg: 0, distanceM: -1 });
        expect(angularGap(tip.bearingDeg, expected)).toBeLessThan(0.5);

        const beam = beamFeatures(origin, values, DEFAULT_DOA_OVERLAY_SETTINGS, offset).features;
        const strongest = beam.reduce((best, feature) => ((feature.properties?.weight as number) > (best.properties?.weight as number) ? feature : best));
        expect(strongest.properties?.bin).toBe(theta);
        expect(angularGap(strongest.properties?.bearing as number, expected)).toBeLessThan(1e-9);

        const heat = heatFeatures(origin, values, DEFAULT_DOA_OVERLAY_SETTINGS, offset).features;
        const hottest = heat.reduce((best, feature) => ((feature.properties?.weight as number) > (best.properties?.weight as number) ? feature : best));
        expect(angularGap(hottest.properties?.bearing as number, expected)).toBeLessThan(1e-9);

        const edges = edgeFeatures(origin, halfPowerWidth(values), DEFAULT_DOA_OVERLAY_SETTINGS, offset).features.map((feature) => feature.properties?.bearing as number);
        expect(edges).toHaveLength(2);
        expect(Math.abs(angularGap(edges[0], expected) - angularGap(edges[1], expected))).toBeLessThan(1e-9);

        const line = bearingFeature(origin, geographicBearingForBin(theta, offset), DEFAULT_DOA_OVERLAY_SETTINGS).geometry.coordinates[1];
        expect(angularGap(bearingAndDistance(origin, line[0], line[1]).bearingDeg, expected)).toBeLessThan(0.01);
      });
    }
  }
});

describe('lobe ring and antimeridian (AUD-87, AUD-88)', () => {
  it('builds the lobe from perimeter points only and closes the ring', () => {
    const origin = { latitude: -6.2, longitude: 106.8 };
    const values = Array.from({ length: 360 }, () => 0);
    const ring = lobeFeature(origin, values, { ...DEFAULT_DOA_OVERLAY_SETTINGS, minDb: -10, maxDb: 0 }).geometry.coordinates[0];
    expect(ring).toHaveLength(361);
    expect(ring[0]).toEqual(ring[360]);
    // A full-weight lobe never passes through the station, so no spoke is drawn.
    expect(ring.every((point) => bearingAndDistance(origin, point[0], point[1]).distanceM > 900)).toBe(true);
  });

  it('keeps longitudes continuous with a station near ±180°', () => {
    const origin = { latitude: -17.8, longitude: 179.995 };
    expect(destination(origin, 90, 1000)[0]).toBeGreaterThan(180);
    const values = Array.from({ length: 360 }, (_, bin) => (bin < 180 ? 0 : -30));
    const ring = lobeFeature(origin, values, DEFAULT_DOA_OVERLAY_SETTINGS).geometry.coordinates[0];
    const longitudes = ring.map((point) => point[0]);
    expect(Math.max(...longitudes) - Math.min(...longitudes)).toBeLessThan(1);
    for (const feature of rangeRings(origin, 1000).features.features) {
      const coordinates = feature.geometry.coordinates;
      for (let index = 1; index < coordinates.length; index += 1) expect(Math.abs(coordinates[index][0] - coordinates[index - 1][0])).toBeLessThan(1);
    }
    const sectors = beamFeatures(origin, values, DEFAULT_DOA_OVERLAY_SETTINGS).features;
    expect(sectors.every((sector) => {
      const lons = sector.geometry.coordinates[0].map((point) => point[0]);
      return Math.max(...lons) - Math.min(...lons) < 1;
    })).toBe(true);
  });
});

describe('dB scale for live and simulated vectors (AUD-07)', () => {
  const origin = { latitude: -6.2, longitude: 106.8 };
  // Live Data Out vectors are shifted to their own floor: 0..1.46 dB, peak at bin 350.
  const live = Array.from({ length: 360 }, (_, bin) => {
    const distance = Math.abs(((bin - 350 + 540) % 360) - 180);
    return 1.46 * Math.exp(-0.5 * (distance / 20) ** 2);
  });

  it('saturates every bin with the fixed -60..0 range, which the manual scale reports', () => {
    const manual = { ...DEFAULT_DOA_OVERLAY_SETTINGS, dbScale: 'manual' as const };
    const scale = effectiveDbScale(live, manual);
    expect(scale).toMatchObject({ minDb: -60, maxDb: 0, mode: 'manual' });
    expect(saturatedFraction(live, scale.maxDb)).toBe(1);
  });

  it('derives an auto range from the vector so the lobe and beam keep their direction', () => {
    const scale = effectiveDbScale(live, DEFAULT_DOA_OVERLAY_SETTINGS);
    expect(scale).toMatchObject({ minDb: 0, maxDb: 1.5, thresholdDb: 0, mode: 'auto', known: true });
    expect(effectiveDbScale(null, DEFAULT_DOA_OVERLAY_SETTINGS).known).toBe(false);
    const draw = { ...DEFAULT_DOA_OVERLAY_SETTINGS, minDb: scale.minDb, maxDb: scale.maxDb, thresholdDb: scale.thresholdDb };
    const radii = lobeFeature(origin, live, draw).geometry.coordinates[0].map((point) => bearingAndDistance(origin, point[0], point[1]).distanceM);
    expect(Math.max(...radii)).toBeGreaterThan(900);
    expect(Math.min(...radii)).toBeLessThan(50);
    const weights = new Set(beamFeatures(origin, live, draw).features.map((feature) => feature.properties?.weight));
    expect(weights.size).toBeGreaterThan(20);
    expect(saturatedFraction(live, scale.maxDb)).toBe(0);
  });

  it('keeps the synthetic range for simulation and a minimum span for flat vectors', () => {
    expect(effectiveDbScale(live, DEFAULT_DOA_OVERLAY_SETTINGS, true)).toMatchObject({ minDb: -60, maxDb: 0, mode: 'simulation' });
    const flat = effectiveDbScale(Array.from({ length: 360 }, () => 0.2), DEFAULT_DOA_OVERLAY_SETTINGS);
    expect(flat.maxDb - flat.minDb).toBeCloseTo(MIN_AUTO_DB_SPAN);
  });
});
