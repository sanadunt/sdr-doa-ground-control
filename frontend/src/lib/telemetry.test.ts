import { describe, expect, it } from 'vitest';
import type { Candidate, TelemetrySnapshot } from '../types';
import { DEFAULT_CONSOLE_CONFIG, REFRESH_INTERVALS_S, candidateErrors, deriveDataState, freshCandidate, nodeStalled, parsedCandidate, toneFor } from './telemetry';

function view(overrides: Record<string, unknown> = {}): Candidate {
  return {
    available: true,
    canonical_angle_deg: 211,
    freshness: { fresh: true, age_ms: 300, max_age_ms: 5000 },
    angular_power_db: Array.from({ length: 360 }, () => 0),
    ...overrides,
  } as Candidate;
}

function snapshot(overrides: Partial<TelemetrySnapshot> = {}, csv = view(), xml = view()): TelemetrySnapshot {
  return {
    status: { available: true, daq_health: 'PASS' },
    doa_candidates: { csv, xml },
    native_consistency: { comparable: true, conflict: false },
    publication_gate: { state: 'BLOCKED', checks: {}, reasons: [] },
    ...overrides,
  } as TelemetrySnapshot;
}

const unreadable = { ok: false, error: 'connection refused', error_kind: 'connection_refused' };

describe('data state classification', () => {
  it.each([
    ['read error', snapshot(), true, true, 'ERROR'],
    ['healthy, fresh', snapshot(), false, true, 'AVAILABLE'],
    ['healthy, local window over', snapshot(), false, false, 'STALE'],
    ['status.json unreadable, right after the read', snapshot({ status: { available: false } }), false, false, 'UNAVAILABLE'],
    ['DAQ sync failed', snapshot({ status: { available: true, daq_health: 'FAIL' } }), false, true, 'DEGRADED'],
    ['ADC overdrive', snapshot({ publication_gate: { checks: { adc_not_overdriven: false } } }), false, true, 'DEGRADED'],
    ['both views malformed', snapshot({}, view({ available: false }), view({ available: false })), false, true, 'INVALID'],
    ['both views quarantined', snapshot({}, view({ canonical_angle_deg: undefined, normalization_error: 'CollectorError' }), view({ canonical_angle_deg: undefined, normalization_error: 'CollectorError' })), false, true, 'INVALID'],
    ['both DoA reads failed', snapshot({ resources: { '/DOA_value.html': unreadable, '/doa.xml': unreadable } }, view({ available: false }), view({ available: false })), false, true, 'UNAVAILABLE'],
    ['CSV/XML conflict', snapshot({ native_consistency: { comparable: true, conflict: true } }), false, true, 'CONFLICT'],
    ['source records old', snapshot({}, view({ freshness: { fresh: false, age_ms: 9000 } }), view({ freshness: { fresh: false, age_ms: 9000 } })), false, false, 'STALE'],
    ['node stalled', snapshot({ node_progress: { state: 'STALLED', stalled: true } }), false, false, 'STALE'],
    ['XML view missing', snapshot({}, view(), view({ available: false })), false, true, 'INCOMPLETE'],
    ['views not comparable', snapshot({ native_consistency: { comparable: false, conflict: false } }), false, true, 'INCOMPLETE'],
  ] as Array<[string, TelemetrySnapshot, boolean, boolean, string]>)('%s', (_label, value, error, localFresh, expected) => {
    expect(deriveDataState(value, error, localFresh)).toBe(expected);
  });

  it('waits for the first snapshot', () => {
    expect(deriveDataState(null)).toBe('LOADING');
  });

  it('gives every overall state and chip value an explicit tone', () => {
    expect(toneFor('CONFLICT')).toBe('bad');
    expect(toneFor('INVALID')).toBe('bad');
    expect(toneFor('INCOMPLETE')).toBe('warn');
    expect(toneFor('CURRENT')).toBe('good');
    expect(toneFor('SIMULATION')).toBe('warn');
    expect(toneFor('STALLED')).toBe('bad');
  });
});

describe('candidate readiness', () => {
  it('requires a finite canonical angle', () => {
    expect(freshCandidate(view())).toBe(true);
    expect(freshCandidate(view({ canonical_angle_deg: undefined }))).toBe(false);
    expect(freshCandidate(view({ canonical_angle_deg: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(parsedCandidate(view({ normalization_error: 'CollectorError' }))).toBe(false);
  });

  it('detects a stalled node from either the snapshot or a candidate', () => {
    expect(nodeStalled(snapshot({ node_progress: { stalled: true } }))).toBe(true);
    expect(nodeStalled(snapshot({}, view({ freshness: { fresh: false, age_ms: 1, node_stalled: true } })))).toBe(true);
    expect(nodeStalled(snapshot())).toBe(false);
  });
});

describe('candidate errors', () => {
  it('name the view and the cause for unusable views only', () => {
    const value = snapshot({}, view({ available: false, error: 'HTTP 404' }), view({ canonical_angle_deg: undefined, normalization_error: 'CollectorError', normalization_error_detail: 'angle out of range' }));
    expect(candidateErrors(value)).toEqual(['CSV: HTTP 404', 'XML: angle out of range']);
    expect(candidateErrors(snapshot())).toEqual([]);
  });
});

describe('console defaults', () => {
  it('refresh every 2 s like a fresh server install, from the server interval list', () => {
    expect(DEFAULT_CONSOLE_CONFIG.refresh_seconds).toBe(2);
    expect(REFRESH_INTERVALS_S).toEqual([0, 1, 2, 5, 10, 30]);
  });
});
