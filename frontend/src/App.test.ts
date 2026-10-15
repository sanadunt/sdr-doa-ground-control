import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_RETRY_DELAYS_MS, displayFresh, nextPollDelayMs, readWithRetry, savedConfigChangesTarget } from './App';
import { DEFAULT_CONSOLE_CONFIG } from './lib/telemetry';
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
