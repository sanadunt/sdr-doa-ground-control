import { describe, expect, it } from 'vitest';
import { snapshotUrl } from '../api';
import type { TelemetrySnapshot } from '../types';
import {
  MAX_SERVED_AGE_MS,
  ageAtAnswerMs,
  settingsAgeMs,
  settingsReadAtMs,
  snapshotCollectionId,
  snapshotConsoleRefreshSeconds,
  snapshotReadAtMonotonic,
  snapshotServedAgeMs,
} from './snapshotRead';

function shared(collection: Record<string, unknown>, settings: Record<string, unknown> = {}): TelemetrySnapshot {
  return { collection, settings: { available: true, fields: {}, ...settings } } as TelemetrySnapshot;
}

describe('the time a shared Data Out read was taken (#13)', () => {
  it('counts back from the answer by the age the console reports', () => {
    const answer = shared({ id: '0badc0de-7', age_ms: 1_500, shared: true });
    expect(snapshotServedAgeMs(answer)).toBe(1_500);
    expect(snapshotReadAtMonotonic(answer, 10_000)).toBe(8_500);
  });

  it('takes an answer without a usable age as just read', () => {
    for (const age of [undefined, null, -5, Number.NaN, '1500', true]) {
      const answer = shared({ age_ms: age });
      expect(snapshotServedAgeMs(answer)).toBe(0);
      expect(snapshotReadAtMonotonic(answer, 10_000)).toBe(10_000);
    }
    expect(snapshotServedAgeMs(null)).toBe(0);
    expect(snapshotServedAgeMs({} as TelemetrySnapshot)).toBe(0);
  });

  it('bounds an implausible age', () => {
    expect(snapshotServedAgeMs(shared({ age_ms: 10 * MAX_SERVED_AGE_MS }))).toBe(MAX_SERVED_AGE_MS);
  });

  it('adds the age of the shared read to an age taken at the node read', () => {
    expect(ageAtAnswerMs(400, shared({ age_ms: 3_500 }))).toBe(3_900);
    expect(ageAtAnswerMs(400, shared({}))).toBe(400);
    expect(ageAtAnswerMs(null, shared({ age_ms: 3_500 }))).toBeNull();
  });

  it('reads the console interval the answer reports', () => {
    expect(snapshotConsoleRefreshSeconds(shared({ refresh_seconds: 30 }))).toBe(30);
    expect(snapshotConsoleRefreshSeconds(shared({ refresh_seconds: 0 }))).toBe(0);
    for (const seconds of [undefined, null, -1, 2.5, '5', true, Number.NaN, 86_400]) {
      expect(snapshotConsoleRefreshSeconds(shared({ refresh_seconds: seconds }))).toBeNull();
    }
    expect(snapshotConsoleRefreshSeconds(null)).toBeNull();
  });

  it('echoes only an id the console issued', () => {
    expect(snapshotCollectionId(shared({ id: '0badc0de-7' }))).toBe('0badc0de-7');
    for (const id of ['', '7', '0BADC0DE-7', '0badc0de-7&refresh=1', 7, null]) {
      expect(snapshotCollectionId(shared({ id }))).toBeNull();
    }
  });

  it('reads the settings.json time and age', () => {
    const answer = shared({ settings_reused: true, settings_age_ms: 12_000 }, { reused: true, read_at_ms: 1_700_000_000_000 });
    expect(settingsReadAtMs(answer)).toBe(1_700_000_000_000);
    expect(settingsAgeMs(answer)).toBe(12_000);
    expect(settingsReadAtMs(shared({}, { read_at_ms: null }))).toBeNull();
    expect(settingsAgeMs(shared({ settings_age_ms: null }))).toBeNull();
  });
});

describe('snapshot URL', () => {
  const base = '/api/snapshot?base_url=http%3A%2F%2Fdoasdr.local%3A8081';

  it('asks for a plain read by default', () => {
    expect(snapshotUrl('http://doasdr.local:8081')).toBe(base);
  });

  it('marks Refresh, Cek ulang and the read already shown', () => {
    expect(snapshotUrl('http://doasdr.local:8081', { refresh: true })).toBe(`${base}&refresh=1`);
    expect(snapshotUrl('http://doasdr.local:8081', { freshSettings: true })).toBe(`${base}&refresh=1&fresh_settings=1`);
    expect(snapshotUrl('http://doasdr.local:8081', { seen: '0badc0de-7' })).toBe(`${base}&seen=0badc0de-7`);
    expect(snapshotUrl('http://doasdr.local:8081', { seen: null })).toBe(base);
  });
});
