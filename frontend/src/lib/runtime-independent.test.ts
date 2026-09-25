import { describe, expect, it } from 'vitest';
import { localSnapshotFresh } from '../App';
import { normalizeBranding } from '../api';
import type { TelemetrySnapshot } from '../types';

function snapshot(freshness?: { age_ms?: number | null; max_age_ms?: number }): TelemetrySnapshot {
  return {
    status: { available: true, freshness },
  };
}

describe('renderer runtime freshness', () => {
  it('uses the remaining server freshness window instead of restarting max_age', () => {
    const response = snapshot({ age_ms: 4_500, max_age_ms: 5_000 });
    expect(localSnapshotFresh(response, 0, 499)).toBe(true);
    expect(localSnapshotFresh(response, 0, 501)).toBe(false);
  });

  it('uses the shortest remaining window across status and candidates', () => {
    const response: TelemetrySnapshot = {
      status: { available: true, freshness: { age_ms: 100, max_age_ms: 5_000 } },
      doa_candidates: { csv: { freshness: { age_ms: 900, max_age_ms: 1_000 } } },
    };
    expect(localSnapshotFresh(response, 0, 99)).toBe(true);
    expect(localSnapshotFresh(response, 0, 101)).toBe(false);
  });

  it('does not keep evidence live when the received evidence is already expired', () => {
    expect(localSnapshotFresh(snapshot({ age_ms: 5_001, max_age_ms: 5_000 }), 0, 0)).toBe(false);
  });

  it('keeps the valid disk_collection evidence observable when the ground clock is unverified', () => {
    const validDiskCollectionSnapshot: TelemetrySnapshot = {
      status: {
        available: true,
        daq_health: 'PASS',
        freshness: {
          freshness_known: false,
          age_ms: null,
          fresh: null,
          future_skew: null,
          max_age_ms: 10_000,
        },
      },
      doa_candidates: {
        csv: { available: true, freshness: { freshness_known: true, age_ms: 0, fresh: true, max_age_ms: 5_000 } },
        xml: { available: true, freshness: { freshness_known: true, age_ms: 0, fresh: true, max_age_ms: 5_000 } },
      },
    };
    expect(localSnapshotFresh(validDiskCollectionSnapshot, 0, 4_999)).toBe(true);
    expect(localSnapshotFresh(validDiskCollectionSnapshot, 0, 5_001)).toBe(false);
  });

  it('does not reject a fresh candidate merely because the collector reports bounded future skew', () => {
    const response = snapshot({ age_ms: 0, max_age_ms: 5_000 });
    response.status!.freshness = { age_ms: 0, max_age_ms: 5_000, fresh: true, future_skew: true };
    expect(localSnapshotFresh(response, 0, 1_000)).toBe(true);
  });
});

describe('branding response safety', () => {
  it('returns renderer-safe defaults for malformed or remote logo values', () => {
    expect(normalizeBranding({ app_name: '<unsafe>', logo_data_url: 'https://example.invalid/logo.png' })).toEqual({
      app_name: 'SDR-DoA Ground Console',
      logo_data_url: '',
    });
    expect(normalizeBranding({ app_name: ' Ground Console ', logo_data_url: '' })).toEqual({
      app_name: 'Ground Console',
      logo_data_url: '',
    });
  });
});
