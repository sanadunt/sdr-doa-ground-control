import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_RETRY_DELAYS_MS, displayFresh, inFlightReadCovers, nextPollDelayMs, readWithRetry, savedConfigChangesTarget } from './App';
import { DEFAULT_CONSOLE_CONFIG } from './lib/telemetry';
import { snapshotReadAtMonotonic } from './lib/snapshotRead';
import type { TelemetrySnapshot } from './types';

const fresh: TelemetrySnapshot = {
  status: { available: true, freshness: { freshness_known: false, age_ms: null, fresh: null, max_age_ms: 10_000 } },
  doa_candidates: {
    csv: { available: true, canonical_angle_deg: 60, freshness: { fresh: true, age_ms: 1_000, max_age_ms: 5_000 } },
    xml: { available: true, canonical_angle_deg: 60, freshness: { fresh: true, age_ms: 1_000, max_age_ms: 5_000 } },
  },
};

describe('display freshness', () => {
  // A refresh in flight used to blank Overview on every poll (AUD-08).
  it('depends on the data age, not on a read being in flight', () => {
    expect(displayFresh(fresh, 0, false, 3_900)).toBe(true);
    expect(displayFresh(fresh, 0, false, 4_100)).toBe(false);
  });

  it('is false while the last read failed', () => {
    expect(displayFresh(fresh, 0, true, 100)).toBe(false);
  });

  // #13: an answer from the console's shared read can be older than its arrival.
  it('counts the time the answer waited on the console', () => {
    const waited = { ...fresh, collection: { id: '0badc0de-3', age_ms: 1_500, shared: true } };
    const readAt = snapshotReadAtMonotonic(waited, 10_000);
    expect(readAt).toBe(8_500);
    // 4 000 ms of the DoA window were left at the read, 1 500 of them passed on the console.
    expect(displayFresh(waited, readAt, false, 12_400)).toBe(true);
    expect(displayFresh(waited, readAt, false, 12_600)).toBe(false);
  });
});

describe('saving the console configuration', () => {
  const nodeA = { ...DEFAULT_CONSOLE_CONFIG, base_url: 'http://192.168.100.100:8081' };

  // Node A's snapshot must not stay CURRENT while the read for node B is in flight.
  it('drops the previous evidence only when the Data Out target changes', () => {
    expect(savedConfigChangesTarget(nodeA, { ...nodeA, base_url: 'http://192.168.100.101:8081' })).toBe(true);
    expect(savedConfigChangesTarget(nodeA, { ...nodeA, refresh_seconds: 5, mqtt_host: '127.0.0.1' })).toBe(false);
  });

  it('leaves nothing current once the evidence is dropped', () => {
    expect(displayFresh(null, null, false, 0)).toBe(false);
  });
});

describe('automatic Data Out reads', () => {
  it('start one interval after the previous read started', () => {
    expect(nextPollDelayMs(2_000, 300)).toBe(1_700);
    expect(nextPollDelayMs(1_000, 0)).toBe(1_000);
  });

  it('leave a gap after a read that took longer than the interval', () => {
    expect(nextPollDelayMs(1_000, 4_000)).toBe(500);
    expect(nextPollDelayMs(2_000, Number.NaN)).toBe(2_000);
  });

  // #13: a page that got an earlier shared read polls again one interval after
  // that read, so it gets the next shared read when it is new.
  it('start one interval after the node was read when the answer came from an earlier read', () => {
    expect(nextPollDelayMs(2_000, 20, 1_200)).toBe(800);
    expect(nextPollDelayMs(2_000, 300, 100)).toBe(1_700);
    expect(nextPollDelayMs(2_000, 20, 1_900)).toBe(500);
    expect(nextPollDelayMs(2_000, 20, Number.NaN)).toBe(1_980);
  });

  it('share a read in flight unless the new one asks for more', () => {
    const automatic = { manual: false, freshSettings: false };
    expect(inFlightReadCovers(automatic, {})).toBe(true);
    expect(inFlightReadCovers(automatic, { manual: true })).toBe(false);
    expect(inFlightReadCovers(automatic, { manual: true, freshSettings: true })).toBe(false);
    expect(inFlightReadCovers({ manual: true, freshSettings: false }, { manual: true })).toBe(true);
    expect(inFlightReadCovers({ manual: true, freshSettings: false }, { manual: true, freshSettings: true })).toBe(false);
    expect(inFlightReadCovers({ manual: true, freshSettings: true }, { manual: true, freshSettings: true })).toBe(true);
    expect(inFlightReadCovers({ manual: true, freshSettings: true }, {})).toBe(true);
  });

  it('retry the console configuration with a capped backoff', () => {
    expect(CONFIG_RETRY_DELAYS_MS[0]).toBe(1_000);
    expect(Math.max(...CONFIG_RETRY_DELAYS_MS)).toBeLessThanOrEqual(15_000);
  });
});

describe('reading capabilities', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('retries a failed read with the backoff until one succeeds', async () => {
    vi.useFakeTimers();
    const results: Array<() => Promise<unknown>> = [
      () => Promise.reject(new Error('timeout')),
      () => Promise.reject(new Error('restart')),
      () => Promise.resolve({ adminDefaultPassword: true }),
    ];
    const read = vi.fn(() => (results.shift() ?? (() => Promise.reject(new Error('unexpected'))))());
    const values: unknown[] = [];
    readWithRetry(read, (value) => values.push(value), [1_000, 2_000]);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(values).toEqual([{ adminDefaultPassword: true }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('stops retrying and aborts the read in flight once stopped', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const read = vi.fn((signal: AbortSignal) => { signals.push(signal); return Promise.reject(new Error('down')); });
    const stop = readWithRetry(read, () => undefined, [1_000]);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(signals[0].aborted).toBe(true);
  });
});
