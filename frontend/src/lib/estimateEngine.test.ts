import { describe, expect, it } from 'vitest';
import { EstimateEngine, estimateAfter, type EstimateSample } from './estimateEngine';

/** tools/fixtures/position-estimate/drive.json: one drive and the console's estimate after each checkpoint (tools/test_estimate_history.py). */
type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
const fixture = JSON.parse(process.getBuiltinModule('node:fs').readFileSync(new URL('../../../tools/fixtures/position-estimate/drive.json', import.meta.url), 'utf8')) as {
  samples: Array<[number, number, number, number, number, number]>;
  checkpoints: Array<Record<string, number | string | null>>;
};
const samples: EstimateSample[] = fixture.samples.map(([tMs, latitude, longitude, bearingDeg, verified, frequencyHz]) => ({ tMs, latitude, longitude, bearingDeg, verified: verified === 1, frequencyHz }));

describe('the browser estimate engine', () => {
  it('comes to the console\'s answers for the shared drive', () => {
    for (const point of fixture.checkpoints) {
      const view = estimateAfter(samples, point.after as number);
      expect(view.state, `after ${point.after}`).toBe(point.state);
      expect(view.latitude).toBeCloseTo(point.latitude as number, 6);
      expect(view.longitude).toBeCloseTo(point.longitude as number, 6);
      expect(Math.abs((view.radiusM ?? 0) - (point.radius_m as number))).toBeLessThanOrEqual(1);
      expect(view.stations).toBe(point.stations);
      expect(view.spreadDeg).toBeCloseTo(point.spread_deg as number, 1);
      expect(Math.abs((view.distanceM ?? 0) - (point.distance_m as number))).toBeLessThanOrEqual(1);
      expect(view.samples).toBe(point.samples);
      expect(view.unverifiedSamples).toBe(point.unverified_samples);
    }
  });

  it('narrows as rays from more directions come', () => {
    const radii = fixture.checkpoints.map((point) => estimateAfter(samples, point.after as number).radiusM ?? Infinity);
    expect(radii[radii.length - 1]).toBeLessThan(radii[0] / 3);
  });

  it('keeps the latest 200 rays for the history lines, oldest first', () => {
    const engine = new EstimateEngine();
    for (const sample of samples) engine.add(sample);
    const rays = engine.view().rays;
    expect(rays).toHaveLength(Math.min(200, samples.length));
    expect(rays[rays.length - 1].tMs).toBe(samples[samples.length - 1].tMs);
    expect(rays.some((ray) => !ray.verified)).toBe(true);
  });

  it('starts over on another frequency', () => {
    const engine = new EstimateEngine();
    for (const sample of samples.slice(0, 10)) engine.add(sample);
    engine.add({ ...samples[10], frequencyHz: samples[10].frequencyHz + 100_000 });
    expect(engine.view().samples).toBe(1);
  });
});
