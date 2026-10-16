import { describe, expect, it } from 'vitest';
import type { Candidate, GpsSourceMode, MapCoordinate, TelemetrySnapshot } from '../types';
import {
  BASEMAP_FAILURES_PER_HOST,
  BASEMAP_PARTIAL_WINDOW_MS,
  BASEMAP_SWITCH_GRACE_MS,
  basemapAfterTile,
  basemapNotice,
  basemapPaint,
  basemapPartialCheck,
  gpsReportsNoFix,
  holdStationCoordinate,
  initialBasemapHealth,
  nextBasemapHost,
  resolveGpsSource,
  resumeBasemapHealth,
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
  // The health logic takes any host count; the console's tile route now does
  // the host fallback, so the map passes one URL per style (see below).
  const hosts = 2;
  const fail = (state: BasemapHealth, times: number, nowMs: number, count = hosts) => {
    let next = state;
    for (let index = 0; index < times; index += 1) next = basemapAfterTile(next, false, count, nowMs);
    return next;
  };

  it('uses one host at a time and moves on after repeated failures', () => {
    const start = initialBasemapHealth();
    const almost = fail(start, BASEMAP_FAILURES_PER_HOST - 1, 0);
    expect(almost.hostIndex).toBe(0);
    const switched = basemapAfterTile(almost, false, hosts, 0);
    expect(switched).toMatchObject({ hostIndex: 1, failures: 0, hostsFailed: 1, unavailable: false, switchedAtMs: 0 });
  });

  it('ignores late failures from the previous host right after a switch', () => {
    const switched = fail(initialBasemapHealth(), BASEMAP_FAILURES_PER_HOST, 0);
    expect(fail(switched, 10, BASEMAP_SWITCH_GRACE_MS - 1)).toMatchObject({ hostIndex: switched.hostIndex, failures: 0, hostsFailed: switched.hostsFailed, switchedAtMs: switched.switchedAtMs });
  });

  it('reports the basemap unavailable once every host failed, without switching in a loop', () => {
    const second = fail(initialBasemapHealth(), BASEMAP_FAILURES_PER_HOST, 0);
    const exhausted = fail(second, BASEMAP_FAILURES_PER_HOST, 10_000);
    expect(exhausted.unavailable).toBe(true);
    expect(fail(exhausted, 50, 20_000)).toMatchObject({ hostIndex: exhausted.hostIndex, failures: 0, unavailable: true, switchedAtMs: exhausted.switchedAtMs });
    expect(basemapNotice(exhausted)).toBe('unavailable');
    // The periodic check keeps retrying hosts in turn while unavailable.
    const retried = nextBasemapHost(exhausted, hosts, 40_000);
    expect(retried.unavailable).toBe(true);
    expect(retried.hostIndex).not.toBe(exhausted.hostIndex);
  });

  it('marks a one-URL style unavailable after one round and retries it in place', () => {
    const exhausted = basemapAfterTile(fail(initialBasemapHealth(), BASEMAP_FAILURES_PER_HOST - 1, 0, 1), false, 1, 0);
    expect(exhausted).toMatchObject({ hostIndex: 0, hostsFailed: 1, unavailable: true, switchedAtMs: 0 });
    const retried = nextBasemapHost(exhausted, 1, 60_000);
    expect(retried).toMatchObject({ hostIndex: 0, unavailable: true, switchedAtMs: 60_000 });
    expect(basemapAfterTile(retried, true, 1, 61_000)).toMatchObject({ loaded: true, unavailable: false });
  });

  it('clears every failure on the first loaded tile', () => {
    const exhausted = fail(fail(initialBasemapHealth(), BASEMAP_FAILURES_PER_HOST, 0), BASEMAP_FAILURES_PER_HOST, 10_000);
    const loaded = basemapAfterTile(exhausted, true, hosts, 20_000);
    expect(loaded).toMatchObject({ hostIndex: exhausted.hostIndex, failures: 0, hostsFailed: 0, loaded: true, unavailable: false });
    expect(basemapAfterTile(loaded, true, hosts, 20_001)).toMatchObject({ hostIndex: exhausted.hostIndex, failures: 0, loaded: true, unavailable: false });
  });
});

describe('partial basemap (offline with part of the view cached)', () => {
  const RETRY_MS = 60_000;
  // Cached tiles load and uncached ones fail in one burst, in any order.
  const tiles = (state: BasemapHealth, pattern: string, startMs: number, stepMs = 100): BasemapHealth => {
    let next = state;
    [...pattern].forEach((tile, index) => { next = basemapAfterTile(next, tile === 'L', 1, startMs + index * stepMs); });
    return next;
  };

  it('shows PARTIAL when tiles keep failing while others load, where each load used to hide the failures', () => {
    const state = tiles(initialBasemapHealth(), 'LFLFLFLFL', 0);
    expect(state).toMatchObject({ loaded: true, unavailable: false, partial: true });
    expect(basemapNotice(state)).toBe('partial');
  });

  it('keeps UNAVAILABLE when every tile fails', () => {
    const state = tiles(initialBasemapHealth(), 'FFFFFFFF', 0);
    expect(basemapNotice(state)).toBe('unavailable');
    expect(state.partial).toBe(false);
  });

  it('turns an early UNAVAILABLE into PARTIAL once a cached tile draws', () => {
    const unavailable = tiles(initialBasemapHealth(), 'FFFF', 0);
    expect(basemapNotice(unavailable)).toBe('unavailable');
    expect(basemapNotice(basemapAfterTile(unavailable, true, 1, 1_000))).toBe('partial');
  });

  it('counts tiles that fail after the view loaded, such as an uncached area panned or zoomed into', () => {
    const loaded = tiles(initialBasemapHealth(), 'LLLL', 0);
    expect(basemapNotice(tiles(loaded, 'FFFFFF', 120_000))).toBe('partial');
  });

  it('ignores failures spread wider than the window, and a single failed tile', () => {
    const loaded = tiles(initialBasemapHealth(), 'LLLLF', 0);
    expect(basemapNotice(loaded)).toBeNull();
    const spread = tiles(loaded, 'FFFF', 30_000, BASEMAP_PARTIAL_WINDOW_MS / 3 + 1);
    expect(spread.partial).toBe(false);
    expect(basemapNotice(basemapAfterTile(spread, true, 1, 50_000))).toBeNull();
  });

  it('retries a partial style at the slow pace and clears it when the retry brings no failure', () => {
    const partial = tiles(initialBasemapHealth(), 'LFFFFL', 0);
    expect(partial.partialSinceMs).not.toBeNull();
    const since = partial.partialSinceMs ?? 0;
    expect(basemapPartialCheck(partial, 1, since + RETRY_MS - 1, RETRY_MS)).toEqual({ state: partial, reload: false });
    const retry = basemapPartialCheck(partial, 1, since + RETRY_MS, RETRY_MS);
    expect(retry.reload).toBe(true);
    // The tiles come back while the retry waits; the notice stays until it is judged.
    const answered = tiles(retry.state, 'LLLL', since + RETRY_MS + 200);
    expect(basemapNotice(answered)).toBe('partial');
    expect(basemapPartialCheck(answered, 1, since + RETRY_MS + BASEMAP_PARTIAL_WINDOW_MS - 1, RETRY_MS).state).toBe(answered);
    const cleared = basemapPartialCheck(answered, 1, since + RETRY_MS + BASEMAP_PARTIAL_WINDOW_MS, RETRY_MS);
    expect(cleared.reload).toBe(false);
    expect(basemapNotice(cleared.state)).toBeNull();
  });

  it('keeps PARTIAL when the retry fails again, and retries again later without flicker', () => {
    const partial = tiles(initialBasemapHealth(), 'LFFFFL', 0);
    const retryAt = (partial.partialSinceMs ?? 0) + RETRY_MS;
    const retried = tiles(basemapPartialCheck(partial, 1, retryAt, RETRY_MS).state, 'LFFLFF', retryAt + 100);
    expect(basemapNotice(retried)).toBe('partial');
    const judged = basemapPartialCheck(retried, 1, retryAt + BASEMAP_PARTIAL_WINDOW_MS, RETRY_MS);
    expect(basemapNotice(judged.state)).toBe('partial');
    expect(judged.state.partialRetryAtMs).toBeNull();
    expect(basemapPartialCheck(judged.state, 1, retryAt + RETRY_MS - 1, RETRY_MS).reload).toBe(false);
    expect(basemapPartialCheck(judged.state, 1, retryAt + RETRY_MS, RETRY_MS).reload).toBe(true);
  });

  it('turns UNAVAILABLE when a retry loads nothing, as after panning to an area never viewed', () => {
    const partial = tiles(initialBasemapHealth(), 'LFFFFL', 0);
    const retryAt = (partial.partialSinceMs ?? 0) + RETRY_MS;
    const failed = tiles(basemapPartialCheck(partial, 1, retryAt, RETRY_MS).state, 'FFFFFF', retryAt + 100);
    const judged = basemapPartialCheck(failed, 1, retryAt + BASEMAP_PARTIAL_WINDOW_MS, RETRY_MS).state;
    expect(judged).toMatchObject({ loaded: false, unavailable: true });
    expect(basemapNotice(judged)).toBe('unavailable');
    // The unavailable path takes over; its own retry clears it when a tile draws.
    expect(basemapPartialCheck(judged, 1, retryAt + 2 * RETRY_MS, RETRY_MS)).toEqual({ state: judged, reload: false });
    expect(basemapNotice(basemapAfterTile(judged, true, 1, retryAt + 2 * RETRY_MS))).toBeNull();
  });

  it('is not carried to the next Overview visit; the new map finds it again from its own tiles', () => {
    const partial = tiles(initialBasemapHealth(), 'LFFFFL', 0);
    expect(basemapNotice(resumeBasemapHealth(partial, 0, 1))).toBeNull();
  });
});

describe('basemap state across Overview visits', () => {
  const hosts = 2;
  const exhausted = (): BasemapHealth => {
    let state = initialBasemapHealth();
    for (let index = 0; index < BASEMAP_FAILURES_PER_HOST; index += 1) state = basemapAfterTile(state, false, hosts, 0);
    for (let index = 0; index < BASEMAP_FAILURES_PER_HOST; index += 1) state = basemapAfterTile(state, false, hosts, 10_000);
    return state;
  };

  it('keeps a known outage, so the notice shows as soon as the map mounts again', () => {
    const resumed = resumeBasemapHealth(exhausted(), 0, hosts);
    expect(resumed.unavailable).toBe(true);
    expect(resumed.hostIndex).toBe(exhausted().hostIndex);
    // A tile that loads after the return still clears it.
    expect(basemapAfterTile(resumed, true, hosts, 20_000).unavailable).toBe(false);
  });

  it('starts fresh on the last working host otherwise', () => {
    expect(resumeBasemapHealth(null, 1, hosts)).toEqual(initialBasemapHealth(1));
    expect(resumeBasemapHealth(initialBasemapHealth(0), 3, hosts)).toEqual(initialBasemapHealth(3 % hosts));
  });
});

describe('basemap paint per theme', () => {
  it('uses a dark neutral background in the dark theme and light lines until tiles draw', () => {
    const light = basemapPaint('light', false);
    const darkBare = basemapPaint('dark', false);
    const darkTiles = basemapPaint('dark', true);
    expect(light.background).toBe('#dfe4dc');
    expect(darkBare.background).not.toBe(light.background);
    expect(darkBare.rings).not.toBe(light.rings);
    // Standard tiles are light, so dark lines come back once they draw.
    expect(darkTiles.rings).toBe(light.rings);
    expect(basemapPaint('light', true)).toEqual(light);
  });

  it('follows the tone of the drawn tiles, and the theme while no tiles are drawn', () => {
    for (const theme of ['light', 'dark'] as const) {
      const onLight = basemapPaint(theme, true, 'light');
      const onDark = basemapPaint(theme, true, 'dark');
      expect(onLight.rings).toBe('#1f2d3a');
      expect(onDark.rings).toBe('#c3ced8');
      expect(onDark.guides).not.toBe(onLight.guides);
      expect(onDark.edges).not.toBe(onLight.edges);
      expect(onDark.edgeWidth).toBeGreaterThan(onLight.edgeWidth);
      expect(onDark.lobeOutline).not.toBe(onLight.lobeOutline);
      // The background always follows the console theme.
      expect(onDark.background).toBe(onLight.background);
      expect(basemapPaint(theme, false, 'dark')).toEqual(basemapPaint(theme, false, 'light'));
    }
    expect(basemapPaint('light', false, 'dark').rings).toBe('#1f2d3a');
    expect(basemapPaint('dark', false, 'light').rings).toBe('#c3ced8');
  });
});
