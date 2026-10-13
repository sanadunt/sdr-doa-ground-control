import { describe, expect, it } from 'vitest';
import type { Candidate, GpsSourceMode, MapCoordinate, TelemetrySnapshot } from '../types';
import {
  BASEMAP_FAILURES_PER_HOST,
  BASEMAP_SWITCH_GRACE_MS,
  OSM_TILE_TEMPLATES,
  basemapAfterTile,
  gpsReportsNoFix,
  holdStationCoordinate,
  initialBasemapHealth,
  nextBasemapHost,
  resolveGpsSource,
  shouldReframeStation,
  type BasemapHealth,
  type StationFraming,
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

function view(overrides: Record<string, unknown> = {}): Candidate {
  return { available: true, latitude: -6.2, longitude: 106.8, freshness: { fresh: true, age_ms: 200, max_age_ms: 5000 }, ...overrides } as Candidate;
}

function gpsSnapshot(gpsStatus: unknown, overrides: Partial<TelemetrySnapshot> = {}, xml = view()): TelemetrySnapshot {
  return {
    status: { available: true, daq_health: 'PASS', safe: gpsStatus === undefined ? {} : { gps_status: gpsStatus } },
    doa_candidates: { csv: view(), xml },
    native_consistency: { comparable: true, conflict: false },
    ...overrides,
  } as TelemetrySnapshot;
}

describe('station position when the read has no usable coordinate', () => {
  const stationFor = (lastLive: MapCoordinate | null, value: TelemetrySnapshot, localFresh = true) => holdStationCoordinate(
    lastLive,
    resolveGpsSource(localFresh ? value : null).coordinate,
    gpsReportsNoFix(value, localFresh),
  );

  it('keeps the last live fix through a CSV/XML conflict or a missing view', () => {
    const first = stationFor(null, gpsSnapshot('Fix'));
    expect(first).toMatchObject({ held: false, coordinate: { source: 'DATA_OUT' } });
    for (const value of [
      gpsSnapshot('Fix', { native_consistency: { comparable: true, conflict: true } }),
      gpsSnapshot('Fix', { native_consistency: { comparable: false, conflict: false } }, view({ available: false })),
    ]) {
      const next = stationFor(first.lastLive, value);
      expect(next.held).toBe(true);
      expect(next.coordinate).toEqual(first.lastLive);
    }
  });

  it('falls back only when the node reports no fix', () => {
    const first = stationFor(null, gpsSnapshot('Fix'));
    for (const status of ['Disabled', 'no fix', 'searching', undefined, null]) {
      expect(gpsReportsNoFix(gpsSnapshot(status), true), String(status)).toBe(true);
      expect(stationFor(first.lastLive, gpsSnapshot(status, { native_consistency: { comparable: true, conflict: true } }))).toMatchObject({ held: false, lastLive: null, coordinate: { source: 'FALLBACK' } });
    }
  });

  it('never treats an old or unreadable status record as no fix', () => {
    expect(gpsReportsNoFix(gpsSnapshot('Disabled'), false)).toBe(false);
    expect(gpsReportsNoFix({ status: { available: false } } as TelemetrySnapshot, true)).toBe(false);
    expect(gpsReportsNoFix(null, true)).toBe(false);
  });
});

describe('camera framing on a station source change (AUD-10)', () => {
  // Mirrors the TacticalMap station effect: the framing record changes only when the camera is reframed.
  const reframes = (steps: Array<[MapCoordinate['source'], GpsSourceMode]>, start: StationFraming | null = null) => {
    let framed = start;
    return steps.map(([source, selection]) => {
      const reframe = shouldReframeStation(framed, source, selection);
      if (reframe) framed = { source, selection };
      return reframe;
    });
  };

  it('frames the first position and reframes once when a live fix replaces the fallback', () => {
    expect(reframes([['FALLBACK', 'DATA_OUT'], ['DATA_OUT', 'DATA_OUT'], ['DATA_OUT', 'DATA_OUT']])).toEqual([true, true, false]);
  });

  it('keeps the camera through a lost GPS fix and its return', () => {
    expect(reframes([['DATA_OUT', 'DATA_OUT'], ['FALLBACK', 'DATA_OUT'], ['FALLBACK', 'DATA_OUT'], ['DATA_OUT', 'DATA_OUT']])).toEqual([true, false, false, false]);
  });

  it('reframes on a new GPS selection or a simulation toggle', () => {
    const framedLive: StationFraming = { source: 'DATA_OUT', selection: 'DATA_OUT' };
    expect(shouldReframeStation(framedLive, 'MANUAL', 'MANUAL')).toBe(true);
    expect(shouldReframeStation(framedLive, 'FALLBACK', 'FALLBACK')).toBe(true);
    expect(shouldReframeStation({ source: 'FALLBACK', selection: 'DATA_OUT' }, 'FALLBACK', 'FALLBACK')).toBe(true);
    expect(reframes([['SIMULATION', 'DATA_OUT'], ['DATA_OUT', 'DATA_OUT']], framedLive)).toEqual([true, true]);
    expect(reframes([['MANUAL', 'MANUAL'], ['MANUAL', 'MANUAL']], framedLive)).toEqual([true, false]);
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
