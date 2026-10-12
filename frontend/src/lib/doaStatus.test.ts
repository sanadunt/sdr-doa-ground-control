import { describe, expect, it } from 'vitest';
import type { Candidate, TelemetrySnapshot } from '../types';
import { doaStatus, doaStatusTextKey, rankGateReasons } from './doaStatus';
import type { DoaStatusReason } from './doaStatus';
import { DICTIONARIES } from './i18n';
import { polarView } from './polar';
import { simulationSnapshot, DEFAULT_SIMULATION } from './simulation';

function vector(): number[] {
  return Array.from({ length: 360 }, (_, bin) => (bin === 60 ? 1.5 : 0));
}

function candidate(overrides: Record<string, unknown> = {}): Candidate {
  return {
    available: true,
    freshness: { fresh: true, age_ms: 200 },
    canonical_angle_deg: 60,
    angular_power_db: vector(),
    ...overrides,
  } as Candidate;
}

function snapshot(overrides: Partial<TelemetrySnapshot> = {}, csv = candidate(), xml = candidate()): TelemetrySnapshot {
  return {
    status: { available: true, daq_health: 'PASS' },
    doa_candidates: { csv, xml },
    native_consistency: { comparable: true, conflict: false },
    publication_gate: { state: 'BLOCKED', checks: {}, reasons: [] },
    ...overrides,
  } as TelemetrySnapshot;
}

function statusOf(value: TelemetrySnapshot | null, localFresh = true) {
  return doaStatus(value, localFresh, polarView(value, undefined, localFresh).fresh);
}

describe('DoA view status names the actual cause', () => {
  it.each([
    ['no snapshot yet', null, true, 'WAITING', 'waiting'],
    ['healthy record', snapshot(), true, 'AVAILABLE', 'available'],
    ['CSV/XML conflict', snapshot({ native_consistency: { comparable: true, conflict: true } }), true, 'CONFLICT', 'conflict'],
    ['status.json read error', snapshot({ status: { available: false } }), false, 'UNAVAILABLE', 'statusUnavailable'],
    ['missing XML view', snapshot({}, candidate(), candidate({ available: false })), true, 'INCOMPLETE', 'viewMissing'],
    ['record stale at the source', snapshot({}, candidate({ freshness: { fresh: false, age_ms: 6000 } })), false, 'STALE', 'sourceStale'],
    ['frozen node', snapshot({ node_progress: { stalled: true } }, candidate({ freshness: { fresh: false, age_ms: 20000, node_stalled: true } })), false, 'STALE', 'nodeStalled'],
    ['views not comparable', snapshot({ native_consistency: { comparable: false, conflict: false } }), true, 'INCOMPLETE', 'notComparable'],
    ['incomplete vector', snapshot({}, candidate({ angular_power_db: [1, 2, 3] })), true, 'INCOMPLETE', 'vectorIncomplete'],
    ['local window expired', snapshot(), false, 'STALE', 'localExpired'],
    ['no canonical angle', snapshot({}, candidate({ canonical_angle_deg: undefined })), true, 'INCOMPLETE', 'angleMissing'],
  ] as Array<[string, TelemetrySnapshot | null, boolean, string, DoaStatusReason]>)('%s', (_label, value, localFresh, code, reason) => {
    const status = statusOf(value, localFresh);
    expect(status.code).toBe(code);
    expect(status.reason).toBe(reason);
    expect(status.shown).toBe(code === 'AVAILABLE');
  });

  it('does not call a drawn curve AVAILABLE when the DAQ is not synchronized', () => {
    const status = statusOf(snapshot({ status: { available: true, daq_health: 'FAIL' } }));
    expect(status.code).toBe('DEGRADED');
    expect(status.reason).toBe('daqDegraded');
  });

  it('flags ADC overdrive from the gate checks', () => {
    const status = statusOf(snapshot({ publication_gate: { state: 'BLOCKED', checks: { adc_not_overdriven: false }, reasons: ['ADC_OVERDRIVE'] } }));
    expect(status.code).toBe('DEGRADED');
    expect(status.reason).toBe('adcOverdrive');
  });

  it('labels simulation separately from live Data Out', () => {
    const status = statusOf(simulationSnapshot(DEFAULT_SIMULATION));
    expect(status.code).toBe('SIMULATION');
    expect(status.shown).toBe(true);
    expect(status.tone).toBe('warn');
  });

  it('has a status text in both languages for every reason', () => {
    const reasons: DoaStatusReason[] = ['waiting', 'simulation', 'available', 'daqDegraded', 'adcOverdrive', 'conflict', 'statusUnavailable',
      'viewMissing', 'nodeStalled', 'sourceStale', 'notComparable', 'vectorIncomplete', 'localExpired', 'angleMissing'];
    for (const reason of reasons) {
      const key = doaStatusTextKey(reason);
      expect(DICTIONARIES.en[key], reason).toBeTruthy();
      expect(DICTIONARIES.id[key], reason).toBeTruthy();
    }
  });
});

describe('gate reason ranking', () => {
  it('puts the actionable reason ahead of the standing clock and authority reasons', () => {
    expect(rankGateReasons(['GROUND_CLOCK_UNVERIFIED', 'CANONICAL_ANGLE_NOT_CONFIGURED', 'NATIVE_DOA_VIEWS_CONFLICT'])[0]).toBe('NATIVE_DOA_VIEWS_CONFLICT');
    expect(rankGateReasons(['GROUND_CLOCK_UNVERIFIED', 'DOA_CANDIDATES_STALE', 'DAQ_HEALTH_GATE_FAILED'])).toEqual(['DAQ_HEALTH_GATE_FAILED', 'DOA_CANDIDATES_STALE', 'GROUND_CLOCK_UNVERIFIED']);
  });
  it('keeps unknown reasons ahead of standing ones and drops non-strings', () => {
    expect(rankGateReasons(['GROUND_CLOCK_UNVERIFIED', 'NEW_REASON', 7, ''])).toEqual(['NEW_REASON', 'GROUND_CLOCK_UNVERIFIED']);
    expect(rankGateReasons(undefined)).toEqual([]);
  });
});
