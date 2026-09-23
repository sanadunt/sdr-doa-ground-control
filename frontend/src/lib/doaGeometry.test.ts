import { describe, expect, it } from 'vitest';
import { DEFAULT_DOA_OVERLAY_SETTINGS, bearingFeature, destination, heatDistanceWeight, heatFeatures, lobeFeature, normalizeBearing, normalizeDb } from './doaGeometry';

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