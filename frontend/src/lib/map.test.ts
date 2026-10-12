import { describe, expect, it } from 'vitest';
import type { MapCoordinate } from '../types';
import {
  BASEMAP_FAILURES_PER_HOST,
  BASEMAP_SWITCH_GRACE_MS,
  OSM_TILE_TEMPLATES,
  basemapAfterTile,
  holdStationCoordinate,
  initialBasemapHealth,
  nextBasemapHost,
  type BasemapHealth,
} from './map';

const live: MapCoordinate = { latitude: -6.2, longitude: 106.8, source: 'DATA_OUT' };
const fallback: MapCoordinate = { latitude: -6.93, longitude: 107.66, source: 'FALLBACK' };
const manual: MapCoordinate = { latitude: -7, longitude: 110, source: 'MANUAL' };

describe('station position through a freshness gap (AUD-29)', () => {
  it('keeps the last live fix while data is only locally stale', () => {
    const first = holdStationCoordinate(null, live, true);
    expect(first).toEqual({ coordinate: live, held: false, lastLive: live });
    const gap = holdStationCoordinate(first.lastLive, fallback, false);
    expect(gap.coordinate).toBe(live);
    expect(gap.held).toBe(true);
  });

  it('drops the memory when a fresh read reports no fix', () => {
    const fresh = holdStationCoordinate(live, fallback, true);
    expect(fresh).toEqual({ coordinate: fallback, held: false, lastLive: null });
    expect(holdStationCoordinate(fresh.lastLive, fallback, false).coordinate).toBe(fallback);
  });

  it('never replaces an explicit FALLBACK or MANUAL choice or a simulation position', () => {
    expect(holdStationCoordinate(live, fallback, false, 'FALLBACK')).toEqual({ coordinate: fallback, held: false, lastLive: live });
    expect(holdStationCoordinate(live, manual, false, 'MANUAL').coordinate).toBe(manual);
    const simulation: MapCoordinate = { latitude: 1, longitude: 2, source: 'SIMULATION' };
    expect(holdStationCoordinate(live, simulation, true)).toEqual({ coordinate: simulation, held: false, lastLive: live });
  });

  it('shows the fallback when no live fix was ever seen', () => {
    expect(holdStationCoordinate(null, fallback, false)).toEqual({ coordinate: fallback, held: false, lastLive: null });
  });
});

describe('basemap tile hosts (AUD-32, AUD-89)', () => {
  const hosts = OSM_TILE_TEMPLATES.length;
  const fail = (state: BasemapHealth, times: number, nowMs: number) => {
    let next = state;
    for (let index = 0; index < times; index += 1) next = basemapAfterTile(next, false, hosts, nowMs);
    return next;
  };

  it('uses one host at a time and moves on after repeated failures', () => {
    expect(OSM_TILE_TEMPLATES[0]).toContain('tile.openstreetmap.de');
    const start = initialBasemapHealth();
    const almost = fail(start, BASEMAP_FAILURES_PER_HOST - 1, 0);
    expect(almost.hostIndex).toBe(0);
    const switched = basemapAfterTile(almost, false, hosts, 0);
    expect(switched).toMatchObject({ hostIndex: 1, failures: 0, hostsFailed: 1, unavailable: false, switchedAtMs: 0 });
  });

  it('ignores late failures from the previous host right after a switch', () => {
    const switched = fail(initialBasemapHealth(), BASEMAP_FAILURES_PER_HOST, 0);
    expect(fail(switched, 10, BASEMAP_SWITCH_GRACE_MS - 1)).toBe(switched);
  });

  it('reports the basemap unavailable once every host failed, without switching in a loop', () => {
    const second = fail(initialBasemapHealth(), BASEMAP_FAILURES_PER_HOST, 0);
    const exhausted = fail(second, BASEMAP_FAILURES_PER_HOST, 10_000);
    expect(exhausted.unavailable).toBe(true);
    expect(fail(exhausted, 50, 20_000)).toBe(exhausted);
    // The periodic check keeps retrying hosts in turn while unavailable.
    const retried = nextBasemapHost(exhausted, hosts, 40_000);
    expect(retried.unavailable).toBe(true);
    expect(retried.hostIndex).not.toBe(exhausted.hostIndex);
  });

  it('clears every failure on the first loaded tile', () => {
    const exhausted = fail(fail(initialBasemapHealth(), BASEMAP_FAILURES_PER_HOST, 0), BASEMAP_FAILURES_PER_HOST, 10_000);
    const loaded = basemapAfterTile(exhausted, true, hosts, 20_000);
    expect(loaded).toMatchObject({ hostIndex: exhausted.hostIndex, failures: 0, hostsFailed: 0, loaded: true, unavailable: false });
    expect(basemapAfterTile(loaded, true, hosts, 20_001)).toBe(loaded);
  });
});
