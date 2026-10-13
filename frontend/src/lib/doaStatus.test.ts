import { describe, expect, it } from 'vitest';
import type { Candidate, TelemetrySnapshot } from '../types';
import { actionableGateReasons, doaDrawable, doaStatus, doaStatusTextKey, overviewDoaStatus, rankGateReasons } from './doaStatus';
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

  it('hides a fresh curve when the DAQ is not synchronized', () => {
    const status = statusOf(snapshot({ status: { available: true, daq_health: 'FAIL' } }));
    expect(status.code).toBe('DEGRADED');
    expect(status.reason).toBe('daqDegraded');
    expect(status.shown).toBe(false);
  });

  it('names an unknown DAQ sync state apart from a failed one', () => {
    for (const status of [statusOf(snapshot({ status: { available: true, daq_health: 'UNKNOWN' } })), statusOf(snapshot({ status: { available: true } }))]) {
      expect(status).toMatchObject({ code: 'DEGRADED', reason: 'daqUnknown', shown: false });
    }
    expect(doaStatusTextKey('daqUnknown')).not.toBe(doaStatusTextKey('daqDegraded'));
    expect(DICTIONARIES.en[doaStatusTextKey('daqUnknown')]).toMatch(/unknown/);
  });

  it('hides a fresh curve on ADC overdrive', () => {
    const status = statusOf(snapshot({ publication_gate: { state: 'BLOCKED', checks: { adc_not_overdriven: false }, reasons: ['ADC_OVERDRIVE'] } }));
    expect(status.code).toBe('DEGRADED');
    expect(status.reason).toBe('adcOverdrive');
    expect(status.shown).toBe(false);
  });

  it('names a quarantined view instead of calling it stale', () => {
    const quarantined = candidate({ canonical_angle_deg: undefined, units_valid: false, normalization_error: 'CollectorError' });
    const status = overviewDoaStatus(snapshot({ native_consistency: { comparable: false, conflict: false, angle_invalid: true } }, candidate(), quarantined), true);
    expect(status).toMatchObject({ code: 'INCOMPLETE', reason: 'angleMissing', shown: false });
  });

  it('labels simulation separately from live Data Out', () => {
    const status = statusOf(simulationSnapshot(DEFAULT_SIMULATION));
    expect(status.code).toBe('SIMULATION');
    expect(status.shown).toBe(true);
    expect(status.tone).toBe('warn');
  });

  it('has a status text in both languages for every reason', () => {
    const reasons: DoaStatusReason[] = ['waiting', 'simulation', 'available', 'daqDegraded', 'daqUnknown', 'adcOverdrive', 'conflict', 'statusUnavailable',
      'viewMissing', 'nodeStalled', 'sourceStale', 'notComparable', 'vectorIncomplete', 'localExpired', 'angleMissing'];
    for (const reason of reasons) {
      const key = doaStatusTextKey(reason);
      expect(DICTIONARIES.en[key], reason).toBeTruthy();
      expect(DICTIONARIES.id[key], reason).toBeTruthy();
    }
  });
});

describe('shared Overview readiness predicate', () => {
  // The map (doaReady), the readout bearing and the polar curve all use overviewDoaStatus().shown.
  it.each([
    ['healthy', snapshot(), true, true],
    ['DAQ sync failed', snapshot({ status: { available: true, daq_health: 'FAIL' } }), true, false],
    ['DAQ state unknown', snapshot({ status: { available: true, daq_health: 'UNKNOWN' } }), true, false],
    ['DAQ state not reported', snapshot({ status: { available: true } }), true, false],
    ['ADC overdrive', snapshot({ publication_gate: { state: 'BLOCKED', checks: { adc_not_overdriven: false }, reasons: [] } }), true, false],
    ['CSV/XML conflict', snapshot({ native_consistency: { comparable: true, conflict: true } }), true, false],
    ['XML view missing', snapshot({}, candidate(), candidate({ available: false })), true, false],
    ['node stalled', snapshot({ node_progress: { stalled: true } }, candidate({ freshness: { fresh: false, age_ms: 9000, node_stalled: true } }), candidate({ freshness: { fresh: false, age_ms: 9000, node_stalled: true } })), true, false],
    ['no canonical angle', snapshot({}, candidate({ canonical_angle_deg: undefined, angular_peak_index: 60 })), true, false],
    ['non-finite canonical angle', snapshot({}, candidate({ canonical_angle_deg: Number.NaN })), true, false],
    ['local window expired', snapshot(), false, false],
  ] as Array<[string, TelemetrySnapshot, boolean, boolean]>)('%s', (_label, value, localFresh, shown) => {
    const status = overviewDoaStatus(value, localFresh);
    expect(status.shown).toBe(shown);
    expect(status.code === 'AVAILABLE').toBe(shown);
    // The renderer's own freshness agrees with the data half of the predicate.
    expect(doaDrawable(value, localFresh)).toBe(polarView(value, undefined, localFresh).fresh);
  });
});

describe('gate reason ranking', () => {
  it('puts the actionable reason ahead of the standing clock and authority reasons', () => {
    expect(rankGateReasons(['GROUND_CLOCK_UNVERIFIED', 'CANONICAL_ANGLE_NOT_CONFIGURED', 'NATIVE_DOA_VIEWS_CONFLICT'])[0]).toBe('NATIVE_DOA_VIEWS_CONFLICT');
    expect(rankGateReasons(['GROUND_CLOCK_UNVERIFIED', 'DOA_CANDIDATES_STALE', 'DAQ_HEALTH_GATE_FAILED'])).toEqual(['DAQ_HEALTH_GATE_FAILED', 'DOA_CANDIDATES_STALE', 'GROUND_CLOCK_UNVERIFIED']);
  });
  it('leaves out the standing reasons when only actionable ones are wanted', () => {
    expect(actionableGateReasons(['GROUND_CLOCK_UNVERIFIED', 'DOA_AUTHORITY_NOT_SELECTED'])).toEqual([]);
    expect(actionableGateReasons(['GROUND_CLOCK_UNVERIFIED', 'NODE_CLOCK_STALLED'])).toEqual(['NODE_CLOCK_STALLED']);
  });
  it('ranks an unchecked adjacent-frame pair last, so the readout reason does not flip per read', () => {
    expect(rankGateReasons(['NATIVE_ANGLE_UNCHECKED', 'GROUND_CLOCK_UNVERIFIED'])).toEqual(['GROUND_CLOCK_UNVERIFIED', 'NATIVE_ANGLE_UNCHECKED']);
    expect(actionableGateReasons(['NATIVE_ANGLE_UNCHECKED', 'GROUND_CLOCK_UNVERIFIED'])).toEqual([]);
  });
  it('keeps unknown reasons ahead of standing ones and drops non-strings', () => {
    expect(rankGateReasons(['GROUND_CLOCK_UNVERIFIED', 'NEW_REASON', 7, ''])).toEqual(['NEW_REASON', 'GROUND_CLOCK_UNVERIFIED']);
    expect(rankGateReasons(undefined)).toEqual([]);
  });
});
