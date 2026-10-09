import { describe, expect, it } from 'vitest';
import { DEFAULT_DOA_OVERLAY_SETTINGS, bearingAndDistance, bearingFeature, beamFeatures, destination, halfPowerWidth, heatDistanceWeight, heatFeatures, lobeFeature, niceRingStep, normalizeBearing, normalizeDb, rangeRings } from './doaGeometry';

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
    expect(lobeFeature(origin, values, DEFAULT_DOA_OVERLAY_SETTINGS).geometry.coordinates[0]).toHaveLength(362);
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
    expect(first.properties).toMatchObject({ bearing: 88, valueDb: 0, weight: 1 });
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
