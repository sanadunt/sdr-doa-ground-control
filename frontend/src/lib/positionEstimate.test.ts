import { describe, expect, it } from 'vitest';
import type { TelemetrySnapshot } from '../types';
import { formatEstimateDistance, positionEstimate, positionEstimateFeatures, positionEstimateLabel } from './positionEstimate';
import { DEFAULT_COMPASS_CONFIG, geographicBearingForBin, nodeArrayHeading, resolveCompassSource } from './polar';
import type { Translate } from './i18n';

const ESTIMATE = {
  state: 'ESTIMATE', latitude: -6.902, longitude: 107.62, radius_m: 420, distance_m: 3400, bearing_deg: 294.3,
  samples: 250, stations: 101, spread_deg: 70.3, frequency_hz: 433_000_000, reset_reason: null,
  method: { min_stations: 3, min_spread_deg: 15 },
  grid: { cells: 100, cell_m: 100, south: -6.95, west: 107.6, north: -6.86, east: 107.69, hot: [[50, 50, 1], [51, 50, 0.6], [999, 0, 1], [1, 2, 7]] },
};

const t: Translate = ((key: string) => (key === 'estimate.mapLabel' ? 'ESTIMATE' : key)) as Translate;

function snapshot(estimate: unknown, extra: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return { position_estimate: estimate as Record<string, unknown>, ...extra } as TelemetrySnapshot;
}

describe('positionEstimate', () => {
  it('reads the estimate and drops bad cells', () => {
    const estimate = positionEstimate(snapshot(ESTIMATE));
    expect(estimate?.state).toBe('ESTIMATE');
    expect([estimate?.latitude, estimate?.longitude, estimate?.distanceM, estimate?.stations]).toEqual([-6.902, 107.62, 3400, 101]);
    expect(estimate?.grid?.hot).toEqual([[50, 50, 1], [51, 50, 0.6]]);
  });

  it('is null without one and in simulation', () => {
    expect(positionEstimate(snapshot(undefined))).toBeNull();
    expect(positionEstimate(snapshot(null))).toBeNull();
    expect(positionEstimate(snapshot(ESTIMATE, { simulation: true }))).toBeNull();
  });

  it('never claims a position without coordinates', () => {
    expect(positionEstimate(snapshot({ ...ESTIMATE, latitude: null }))?.state).toBe('NO_DATA');
    expect(positionEstimate(snapshot({ ...ESTIMATE, state: 'SOMETHING' }))?.state).toBe('NO_DATA');
  });

  it('draws cells, radius, link and point for an ESTIMATE', () => {
    const estimate = positionEstimate(snapshot(ESTIMATE));
    const shapes = positionEstimateFeatures(estimate, { latitude: -6.93, longitude: 107.71 });
    expect(shapes.heat.features).toHaveLength(2);
    expect(shapes.heat.features[0].properties).toEqual({ share: 1, ready: true });
    expect(shapes.lines.features.map((feature) => feature.properties?.kind)).toEqual(['radius', 'link']);
    expect(shapes.point.features[0].geometry.coordinates).toEqual([107.62, -6.902]);
    // Cell 50,50 of a 100-cell grid starts half-way.
    const ring = shapes.heat.features[0].geometry.coordinates[0];
    expect(ring[0][0]).toBeCloseTo(107.645, 6);
    expect(ring[0][1]).toBeCloseTo(-6.905, 6);
  });

  it('draws only the faint cells while the bearings do not cross', () => {
    const estimate = positionEstimate(snapshot({ ...ESTIMATE, state: 'NEED_MOVEMENT' }));
    const shapes = positionEstimateFeatures(estimate, { latitude: -6.93, longitude: 107.71 });
    expect(shapes.heat.features[0].properties?.ready).toBe(false);
    expect(shapes.point.features).toHaveLength(0);
    expect(shapes.lines.features).toHaveLength(0);
  });

  it('labels distance and bearing', () => {
    const estimate = positionEstimate(snapshot(ESTIMATE));
    expect(estimate && positionEstimateLabel(estimate, t)).toBe('ESTIMATE · 3.4 km · 294°');
    expect(formatEstimateDistance(850)).toBe('850 m');
    expect(formatEstimateDistance(12_400)).toBe('12 km');
    expect(formatEstimateDistance(null)).toBe('--');
  });
});

describe('node array heading as the compass offset (contract 1.10)', () => {
  const live = (heading: unknown): TelemetrySnapshot => ({
    source: { kind: 'mqtt' },
    doa_candidates: { mqtt: { available: true, canonical_angle_deg: 150, array_heading_deg: heading } },
  } as unknown as TelemetrySnapshot);

  it('turns theta_0 into the bearing the edge sent', () => {
    const resolution = resolveCompassSource(live(84.3), undefined, DEFAULT_COMPASS_CONFIG);
    expect(resolution.code).toBe('NODE_HEADING');
    expect(resolution.offsetVerified).toBe(true);
    // theta_0 150 (counter-clockwise) with the array reference at 84.3: b = 84.3 - 150 = 294.3.
    expect(geographicBearingForBin(150, resolution.settings.compassOffset)).toBeCloseTo(294.3, 6);
  });

  it('leaves a manual offset alone and ignores a missing heading', () => {
    const manual = resolveCompassSource(live(84.3), undefined, { ...DEFAULT_COMPASS_CONFIG, source: 'MANUAL', manualCompassOffset: 12 });
    expect([manual.code, manual.settings.compassOffset]).toEqual(['MANUAL', 12]);
    expect(nodeArrayHeading(live(null))).toBeNull();
    expect(nodeArrayHeading(live(Number.NaN))).toBeNull();
    expect(resolveCompassSource(live(null), undefined, DEFAULT_COMPASS_CONFIG).code).not.toBe('NODE_HEADING');
  });
});
