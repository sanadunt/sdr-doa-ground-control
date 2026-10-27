import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_RETRY_DELAYS_MS, configChangesReads, configResyncFor, displayFresh, inFlightReadCovers, nextPollDelayMs, pollDelayAfterReadMs, readErrorRefusesUrl, readWithRetry, refusalResyncFor, savedConfigChangesTarget, startAutomaticReads } from './App';
import type { PollAnswer } from './App';
import { ApiError } from './api';
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

  // #13 review: the first automatic read used to wait a full interval after
  // the page opened, whatever the age of the shared read it opened on.
  it('schedule the first read from the node read of the answer the page opened on', () => {
    // Interval 5 s; the page started its read at 1000 and got, 40 ms later, a
    // shared read completed 4.5 s earlier: the next read is due 0.5 s later.
    const opened = { atMonotonic: 1_040, servedAgeMs: 4_500, consoleRefreshSeconds: 5 };
    expect(pollDelayAfterReadMs(5_000, 1_000, 1_040, opened)).toBe(500);
    // A shared read 1 s old: four seconds to go, counted from the node read.
    expect(pollDelayAfterReadMs(5_000, 1_000, 1_040, { ...opened, servedAgeMs: 1_000 })).toBe(4_000);
    // The effect started after the answer that is still in mind: a full interval.
    expect(pollDelayAfterReadMs(5_000, 2_000, 2_000, opened)).toBe(5_000);
    expect(pollDelayAfterReadMs(5_000, 1_000, 1_300, null)).toBe(4_700);
  });

  // #13 review: a page still on 2 s while the console shares each read for
  // 30 s polled at 2 Hz until the read was new.
  it('wait for the console interval when it is longer than the page one', () => {
    const answer = { atMonotonic: 10_000, servedAgeMs: 1_900, consoleRefreshSeconds: 30 };
    expect(pollDelayAfterReadMs(2_000, 9_990, 10_000, answer)).toBe(28_100);
    // A shorter console interval or manual mode on the console does not shorten the page's.
    expect(pollDelayAfterReadMs(2_000, 9_990, 10_000, { ...answer, servedAgeMs: 100, consoleRefreshSeconds: 1 })).toBe(1_900);
    expect(pollDelayAfterReadMs(2_000, 9_990, 10_000, { ...answer, servedAgeMs: 100, consoleRefreshSeconds: 0 })).toBe(1_900);
    expect(pollDelayAfterReadMs(2_000, 9_990, 10_000, { ...answer, servedAgeMs: 100, consoleRefreshSeconds: null })).toBe(1_900);
  });

  it('wait for the read the page opened with, then poll from its node read', async () => {
    vi.useFakeTimers();
    try {
      let answer: PollAnswer | null = null;
      const reads: number[] = [];
      let finishFirst: () => void = () => undefined;
      const pending = new Promise<void>((resolve) => { finishFirst = resolve; });
      const stop = startAutomaticReads({
        intervalMs: 5_000,
        read: async () => {
          reads.push(Date.now());
          answer = { atMonotonic: Date.now(), servedAgeMs: 0, consoleRefreshSeconds: 5 };
        },
        pending,
        lastAnswer: () => answer,
        now: () => Date.now(),
      });
      const opened = Date.now();
      await vi.advanceTimersByTimeAsync(40);
      // The first answer is a shared read that completed 4.5 s before it arrived.
      answer = { atMonotonic: Date.now(), servedAgeMs: 4_500, consoleRefreshSeconds: 5 };
      finishFirst();
      await vi.advanceTimersByTimeAsync(499);
      expect(reads).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads).toEqual([opened + 540]);
      // Then one interval after each new read.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reads).toEqual([opened + 540, opened + 5_540]);
      stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(reads).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('start a full interval later without a read in flight, and not at all once stopped', async () => {
    vi.useFakeTimers();
    try {
      const reads: number[] = [];
      const options = { intervalMs: 2_000, read: async () => { reads.push(Date.now()); }, pending: null, lastAnswer: () => null, now: () => Date.now() };
      const start = Date.now();
      const stop = startAutomaticReads(options);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(reads).toEqual([start + 2_000]);
      stop();
      const stopEarly = startAutomaticReads({ ...options, pending: Promise.resolve() });
      stopEarly();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads).toEqual([start + 2_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  // #13 review: the page read its config once, so another page's interval
  // change left its select and its poll on the old value.
  it('re-read the config once per shared read that reports another interval', () => {
    const answer = (collection: Record<string, unknown>) => ({ collection } as TelemetrySnapshot);
    const page = { base_url: 'http://doasdr.local:8081', refresh_seconds: 2 };
    expect(configResyncFor(answer({ id: '0badc0de-4', refresh_seconds: 30 }), page, null)).toBe('0badc0de-4');
    expect(configResyncFor(answer({ id: '0badc0de-4', refresh_seconds: 30 }), page, '0badc0de-4')).toBeNull();
    expect(configResyncFor(answer({ id: '0badc0de-5', refresh_seconds: 30 }), page, '0badc0de-4')).toBe('0badc0de-5');
    expect(configResyncFor(answer({ id: '0badc0de-4', refresh_seconds: 0 }), page, null)).toBe('0badc0de-4');
    expect(configResyncFor(answer({ id: '0badc0de-4', refresh_seconds: 2 }), page, null)).toBeNull();
    // An older console, a malformed answer or no answer: nothing to compare.
    expect(configResyncFor(answer({ id: '0badc0de-4' }), page, null)).toBeNull();
    expect(configResyncFor(answer({ refresh_seconds: 30 }), page, null)).toBeNull();
    expect(configResyncFor(null, page, null)).toBeNull();
  });

  // #11/#13 review: a page kept the Data Out URL it loaded, so after another
  // page moved Data Out it read the old target as a second shared read, or
  // was refused for good once the old host left the list.
  it('re-read the config when the console reads another Data Out URL or refuses the page\'s', () => {
    const answer = (collection: Record<string, unknown>) => ({ collection } as TelemetrySnapshot);
    const page = { base_url: 'http://doasdr.local:8081', refresh_seconds: 2 };
    const moved = { id: '0badc0de-7', refresh_seconds: 2, console_base_url: 'http://192.168.100.100:8081' };
    expect(configResyncFor(answer(moved), page, null)).toBe('0badc0de-7');
    expect(configResyncFor(answer(moved), page, '0badc0de-7')).toBeNull();
    expect(configResyncFor(answer({ ...moved, console_base_url: 'http://doasdr.local:8081/' }), page, null)).toBeNull();
    expect(configResyncFor(answer({ ...moved, console_base_url: 'http://doasdr.local:8081' }), { ...page, base_url: 'http://doasdr.local:8081/' }, null)).toBeNull();
    for (const bad of ['', 8081, null]) {
      expect(configResyncFor(answer({ ...moved, console_base_url: bad }), page, null)).toBeNull();
    }
    // A refused URL: once per refusal run, and only while the page still uses that URL.
    const refused = new ApiError('not allowed', 400, 'DATA_OUT_URL_NOT_ALLOWED');
    expect(readErrorRefusesUrl(refused)).toBe(true);
    expect(readErrorRefusesUrl(new ApiError('bad gateway', 502, 'COLLECTION_FAILED'))).toBe(false);
    expect(readErrorRefusesUrl(new Error('DATA_OUT_URL_NOT_ALLOWED'))).toBe(false);
    const refusal = { baseUrl: 'http://doasdr.local:8081', run: 3 };
    expect(refusalResyncFor(refusal, page, null)).toBe('refused-3');
    expect(refusalResyncFor(refusal, page, 'refused-3')).toBeNull();
    expect(refusalResyncFor({ ...refusal, run: 4 }, page, 'refused-3')).toBe('refused-4');
    expect(refusalResyncFor(refusal, { ...page, base_url: 'http://192.168.100.100:8081' }, null)).toBeNull();
    expect(refusalResyncFor(null, page, null)).toBeNull();
    // The re-read config is applied only when it moves the reads.
    expect(configChangesReads(page, { ...page, base_url: 'http://192.168.100.100:8081' })).toBe(true);
    expect(configChangesReads(page, { ...page, refresh_seconds: 5 })).toBe(true);
    expect(configChangesReads(page, { ...page, base_url: 'http://doasdr.local:8081/' })).toBe(false);
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
