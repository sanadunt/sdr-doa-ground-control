import { describe, expect, it } from 'vitest';
import { CONFIG_RETRY_DELAYS_MS, displayFresh, nextPollDelayMs } from './App';
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
