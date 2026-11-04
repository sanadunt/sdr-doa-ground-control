import { describe, expect, it } from 'vitest';
import type { TelemetrySnapshot } from '../types';
import { overlayIdentity } from './heldOverlay';
import type { OverlayMemory } from './heldOverlay';
import { heldSeedFrom, normalizeLastLiveDoa, seedCurve, seedOverlayMemory } from './lastLiveDoa';
import type { LastLiveDoa } from './lastLiveDoa';
import { DEFAULT_GPS_CONFIG } from './map';
import { DEFAULT_COMPASS_CONFIG } from './polar';

type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
function readJson(path: string): TelemetrySnapshot {
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  return JSON.parse(process.getBuiltinModule('node:fs').readFileSync(new URL(path, import.meta.url), 'utf8')) as TelemetrySnapshot;
}

const LIVE = readJson('../../../tools/fixtures/telemetry-source/mqtt-live.json');
const KEPT: LastLiveDoa = { capturedAtMs: 1_793_070_141_000, snapshot: LIVE };

describe('the console\'s last live DoA graph (GET /api/doa/last-live)', () => {
  it('reads the route leniently', () => {
    expect(normalizeLastLiveDoa({ ok: true, captured_at_ms: 5, snapshot: LIVE })).toEqual({ capturedAtMs: 5, snapshot: LIVE });
    expect(normalizeLastLiveDoa({ ok: true, captured_at_ms: null, snapshot: null })).toBeNull();
    expect(normalizeLastLiveDoa({ captured_at_ms: 5, snapshot: [] })).toBeNull();
    expect(normalizeLastLiveDoa('<html>')).toBeNull();
  });

  it('derives the held overlay as the map derives a live one', () => {
    const seed = heldSeedFrom(KEPT, DEFAULT_GPS_CONFIG, DEFAULT_COMPASS_CONFIG);
    expect(seed).not.toBeNull();
    const candidate = LIVE.doa_candidates?.mqtt as Record<string, unknown>;
    expect(seed?.overlay.values).toBe(candidate.angular_power_db);
    expect(seed?.overlay.thetaDeg).toBe(160);
    expect(seed?.overlay.frequencyHz).toBe(433_920_000);
    // When the console kept it, as a page's own memory keeps the time an answer arrived.
    expect(seed?.overlay.atMs).toBe(KEPT.capturedAtMs);
    expect(seed?.identity).toEqual(overlayIdentity(LIVE));
    // A MANUAL compass offset turns it, as it turns a live one.
    const manual = heldSeedFrom(KEPT, DEFAULT_GPS_CONFIG, { ...DEFAULT_COMPASS_CONFIG, source: 'MANUAL', manualCompassOffset: 42 });
    expect(manual?.overlay.offsetDeg).toBe(42);
  });

  it('gives nothing without a vector, a position or outside a simulation', () => {
    expect(heldSeedFrom(null, DEFAULT_GPS_CONFIG, DEFAULT_COMPASS_CONFIG)).toBeNull();
    const noVector = structuredClone(LIVE);
    delete (noVector.doa_candidates?.mqtt as Record<string, unknown>).angular_power_db;
    expect(heldSeedFrom({ ...KEPT, snapshot: noVector }, DEFAULT_GPS_CONFIG, DEFAULT_COMPASS_CONFIG)).toBeNull();
    expect(heldSeedFrom({ ...KEPT, snapshot: { ...LIVE, simulation: true } }, DEFAULT_GPS_CONFIG, DEFAULT_COMPASS_CONFIG)).toBeNull();
    const nowhere = heldSeedFrom(KEPT, { ...DEFAULT_GPS_CONFIG, source: 'MANUAL', manualLatitude: Number.NaN, manualLongitude: Number.NaN }, DEFAULT_COMPASS_CONFIG);
    expect(nowhere).toBeNull();
  });

  it('seeds the map only while the page remembers no overlay of its own, for the same node', () => {
    const seed = heldSeedFrom(KEPT, DEFAULT_GPS_CONFIG, DEFAULT_COMPASS_CONFIG);
    const here = overlayIdentity(LIVE);
    expect(seedOverlayMemory(null, seed, here, false)).toEqual({ overlay: seed?.overlay, identity: seed?.identity });
    const own: OverlayMemory = { overlay: { ...seed!.overlay, atMs: 9 }, identity: here };
    expect(seedOverlayMemory(own, seed, here, false)).toBe(own);
    expect(seedOverlayMemory(null, seed, { ...here, sid: 'another1' }, false)).toBeNull();
    expect(seedOverlayMemory(null, seed, here, true)).toBeNull();
    expect(seedOverlayMemory(null, null, here, false)).toBeNull();
  });

  it('seeds the polar dock with the curve in the DoA frame', () => {
    const seed = heldSeedFrom(KEPT, DEFAULT_GPS_CONFIG, DEFAULT_COMPASS_CONFIG)!;
    const here = overlayIdentity(LIVE);
    expect(seedCurve(seed, here, false)).toEqual({ values: seed.overlay.values, atMs: seed.overlay.atMs });
    const turned = seedCurve({ ...seed, overlay: { ...seed.overlay, offsetDeg: 10, curveOffsetDeg: 0 } }, here, false);
    expect(turned?.values[10]).toBe(seed.overlay.values[0]);
    expect(seedCurve(seed, { ...here, sid: 'another1' }, false)).toBeNull();
    expect(seedCurve(seed, here, true)).toBeNull();
  });
});
