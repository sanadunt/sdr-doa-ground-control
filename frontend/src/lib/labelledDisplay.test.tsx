import { describe, expect, it } from 'vitest';
import type { JSX } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Candidate, TelemetrySnapshot } from '../types';
import { I18nContext, translate } from './i18n';
import type { Lang } from './i18n';
import { overviewDoaStatus, provisionalTheta } from './doaStatus';
import { deliveryCheckKey, deliveryView } from './delivery';
import { adcOverdriveUnknown, curveDataReady, partialCsvReady } from './telemetry';
import { polarView } from './polar';
import { DoaReadout } from '../components/DoaReadout';
import { DeliveryChecklist } from '../components/DeliveryChecklist';
import { heldCurve } from '../components/overview/PolarDock';
import { compassCauseKey } from '../pages/OverviewPage';
import { DoADiagnosticsPage } from '../pages/DoADiagnosticsPage';

/** An answer of tools/telemetry_source.py, written by tools/test_telemetry_source.py. */
function answer(name: string): TelemetrySnapshot {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  const text = process.getBuiltinModule('node:fs').readFileSync(new URL(`../../../tools/fixtures/telemetry-source/${name}`, import.meta.url), 'utf8');
  return JSON.parse(text) as TelemetrySnapshot;
}

function vector(peak = 60): number[] {
  return Array.from({ length: 360 }, (_, bin) => (bin === peak ? 1.5 : 0));
}

function candidate(overrides: Record<string, unknown> = {}): Candidate {
  return { available: true, freshness: { fresh: true, age_ms: 200 }, canonical_angle_deg: 60, angular_power_db: vector(), ...overrides } as Candidate;
}

function dataOut(overrides: Partial<TelemetrySnapshot> = {}, csv = candidate(), xml = candidate()): TelemetrySnapshot {
  return {
    status: { available: true, daq_health: 'PASS' },
    doa_candidates: { csv, xml },
    native_consistency: { comparable: true, conflict: false },
    publication_gate: { state: 'BLOCKED', checks: { adc_not_overdriven: true }, reasons: ['GROUND_CLOCK_UNVERIFIED'] },
    ...overrides,
  } as TelemetrySnapshot;
}

function wrap(lang: Lang, node: JSX.Element): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>{node}</I18nContext.Provider>,
  );
}

function hud(snapshot: TelemetrySnapshot, lang: Lang = 'en', localFresh = true): string {
  return wrap(lang, <DoaReadout snapshot={snapshot} localSnapshotFresh={localFresh} settings={{ figType: 'Compass', compassOffset: 0 }} offsetSource="DATA_OUT" offsetVerified />);
}

describe('a held DoA that is still readable is shown dimmed, never as a valid one', () => {
  it('keeps the angle of an old record, an ok=0 DoA, an unknown DAQ and a missing status', () => {
    const stale = dataOut({}, candidate({ freshness: { fresh: false, age_ms: 9_000 } }), candidate({ freshness: { fresh: false, age_ms: 9_000 } }));
    const daqUnknown = dataOut({ status: { available: true, daq_health: 'UNKNOWN' } });
    const noStatus = dataOut({ status: { available: false } });
    for (const snapshot of [stale, daqUnknown, noStatus]) {
      const status = overviewDoaStatus(snapshot, true);
      expect(status.shown).toBe(false);
      expect(provisionalTheta(snapshot, status)).toBe(60);
    }
    const expired = dataOut();
    expect(provisionalTheta(expired, overviewDoaStatus(expired, false))).toBe(60);
    const unverified = answer('mqtt-unverified.json');
    expect(provisionalTheta(unverified, overviewDoaStatus(unverified, true))).toBe(160);
  });

  it('hides the angle of a conflict, a failed DAQ sync and an overdriven ADC', () => {
    const conflict = dataOut({ native_consistency: { comparable: true, conflict: true } });
    const daqFail = dataOut({ status: { available: true, daq_health: 'FAIL' } });
    const overdrive = dataOut({ publication_gate: { state: 'BLOCKED', checks: { adc_not_overdriven: false }, reasons: [] } });
    for (const snapshot of [conflict, daqFail, overdrive]) expect(provisionalTheta(snapshot, overviewDoaStatus(snapshot, true))).toBeNull();
  });

  it('gives no held angle while the DoA is shown or simulated', () => {
    const healthy = dataOut();
    expect(provisionalTheta(healthy, overviewDoaStatus(healthy, true))).toBeNull();
    const simulated = { ...dataOut({}, candidate({ freshness: { fresh: false, age_ms: 9_000 } })), simulation: true } as TelemetrySnapshot;
    expect(provisionalTheta(simulated, overviewDoaStatus(simulated, true))).toBeNull();
  });

  it.each(['en', 'id'] as const)('labels the HUD STALE with its age or NOT VALID in %s', (lang) => {
    const stale = dataOut({}, candidate({ freshness: { fresh: false, age_ms: 9_000 } }), candidate({ freshness: { fresh: false, age_ms: 9_000 } }));
    const staleMarkup = hud(stale, lang);
    expect(staleMarkup).toContain('ov-hud-bearing is-provisional');
    expect(staleMarkup).toContain(`>${translate(lang, 'polar.staleTag', { age: translate(lang, 'common.durationS', { value: '9.0' }) })}<`);
    const daqMarkup = hud(dataOut({ status: { available: true, daq_health: 'UNKNOWN' } }), lang);
    expect(daqMarkup).toContain(`>${translate(lang, 'polar.notValid')}<`);
    expect(daqMarkup).toContain(translate(lang, 'polar.daqUnknown'));
    // A valid DoA carries neither tag and is not dimmed.
    const healthy = hud(dataOut(), lang);
    expect(healthy).not.toContain('is-provisional');
    expect(healthy).not.toContain(translate(lang, 'polar.notValid'));
  });
});

describe('Data Out without doa.xml draws the CSV view, labelled partial', () => {
  const partial = dataOut({ native_consistency: { comparable: false, conflict: false } }, candidate(), candidate({ available: false }));

  it('counts the CSV view alone as drawable', () => {
    expect(partialCsvReady(partial)).toBe(true);
    expect(curveDataReady(partial)).toBe(true);
    expect(overviewDoaStatus(partial, true)).toMatchObject({ code: 'PARTIAL', reason: 'partial', shown: true });
    expect(polarView(partial, undefined, true).fresh).toBe(true);
    // A stale or incomplete CSV view is not.
    expect(partialCsvReady(dataOut({}, candidate({ freshness: { fresh: false, age_ms: 9_000 } }), candidate({ available: false })))).toBe(false);
    expect(partialCsvReady(dataOut({}, candidate({ angular_power_db: [1, 2] }), candidate({ available: false })))).toBe(false);
    // Both views present but not comparable is still not drawn.
    expect(overviewDoaStatus(dataOut({ native_consistency: { comparable: false, conflict: false } }), true).shown).toBe(false);
  });

  it.each(['en', 'id'] as const)('tags the HUD PARTIAL in %s', (lang) => {
    const markup = hud(partial, lang);
    expect(markup).toContain(`>${translate(lang, 'polar.partialTag')}<`);
    expect(markup).toContain(translate(lang, 'polar.partial'));
    expect(markup).not.toContain('is-provisional');
  });

  it('reads an overdrive Data Out does not report as unknown, not as a pass', () => {
    const unknown = dataOut({ publication_gate: { state: 'BLOCKED', checks: { adc_not_overdriven: null }, reasons: ['ADC_OVERDRIVE_UNKNOWN'] } });
    expect(adcOverdriveUnknown(unknown)).toBe(true);
    expect(overviewDoaStatus(unknown, true)).toMatchObject({ code: 'DEGRADED', reason: 'adcUnknown', shown: true });
    expect(adcOverdriveUnknown(dataOut())).toBe(false);
    // An older answer without the check is not unknown.
    expect(adcOverdriveUnknown(dataOut({ publication_gate: { state: 'BLOCKED', checks: {}, reasons: [] } }))).toBe(false);
  });
});

describe('the polar dock keeps the last curve', () => {
  it('remembers a new curve with its arrival time and draws it when none is current', () => {
    const first = vector(10);
    const stored = heldCurve(null, first, false, 1_000);
    expect(stored).toEqual({ draw: first, held: null, memory: { values: first, atMs: 1_000 } });
    // The same array keeps its time; a new one gets a new time.
    expect(heldCurve(stored.memory, first, false, 2_000).memory?.atMs).toBe(1_000);
    const second = vector(20);
    expect(heldCurve(stored.memory, second, false, 3_000).memory).toEqual({ values: second, atMs: 3_000 });
    const held = heldCurve(stored.memory, null, false, 9_000);
    expect(held.draw).toBe(first);
    expect(held.held).toEqual({ values: first, atMs: 1_000 });
  });

  it('never remembers or holds a simulated curve', () => {
    const live = heldCurve(null, vector(10), false, 1_000).memory;
    const simulated = vector(90);
    expect(heldCurve(live, simulated, true, 2_000)).toEqual({ draw: simulated, held: null, memory: live });
    expect(heldCurve(live, null, true, 3_000)).toEqual({ draw: null, held: null, memory: live });
    expect(heldCurve(null, null, false, 3_000)).toEqual({ draw: null, held: null, memory: null });
  });
});

describe('the Delivery chip separates setup from a data problem', () => {
  it('waits only on setup when every reason is one configuration clears', () => {
    const view = deliveryView(answer('mqtt-live.json'));
    expect(view.state).toBe('SETUP');
    expect(view.tone).toBe('neutral');
    expect(view.problems).toEqual([]);
    expect(view.setup).toEqual(expect.arrayContaining(['DOA_AUTHORITY_NOT_SELECTED', 'CANONICAL_ANGLE_NOT_CONFIGURED', 'GROUND_CLOCK_UNVERIFIED']));
    // Data checks come before setup checks, each group in the server's order.
    const groups = view.checks.map((check) => check.group);
    expect(groups.indexOf('setup')).toBeGreaterThan(groups.lastIndexOf('data'));
    expect(view.checks.find((check) => check.key === 'authority_selected')).toMatchObject({ ok: false, group: 'setup' });
    for (const check of view.checks) expect(deliveryCheckKey(check.key)).not.toBeNull();
    // ok=0 is the edge's default until its own authority and angle are verified: setup, not a fault.
    expect(deliveryView(answer('mqtt-unverified.json'))).toMatchObject({ state: 'SETUP', problems: [] });
  });

  it('says problem when the data has one, ready when the gate is, and keeps notes apart', () => {
    const problem = deliveryView(dataOut({ publication_gate: { state: 'BLOCKED', checks: { daq_healthy: false, adc_not_overdriven: null }, reasons: ['GROUND_CLOCK_UNVERIFIED', 'NATIVE_ANGLE_UNCHECKED', 'DAQ_HEALTH_GATE_FAILED'] } }));
    expect(problem).toMatchObject({ state: 'PROBLEM', tone: 'warn', problems: ['DAQ_HEALTH_GATE_FAILED'], setup: ['GROUND_CLOCK_UNVERIFIED'], notes: ['NATIVE_ANGLE_UNCHECKED'] });
    expect(problem.checks).toEqual([{ key: 'daq_healthy', ok: false, group: 'data' }, { key: 'adc_not_overdriven', ok: null, group: 'data' }]);
    expect(deliveryView(dataOut({ publication_gate: { state: 'READY', checks: {}, reasons: [] } })).state).toBe('READY');
    expect(deliveryView({ ...dataOut(), simulation: true } as TelemetrySnapshot).state).toBe('SIMULATION');
    expect(deliveryView(null).state).toBe('SETUP');
    // A check name outside the plain pattern is left out.
    expect(deliveryView(dataOut({ publication_gate: { state: 'BLOCKED', checks: { '<b>': true }, reasons: [] } })).checks).toEqual([]);
  });

  it.each(['en', 'id'] as const)('renders the chip as a button that opens the checklist in %s', (lang) => {
    const markup = wrap(lang, <DeliveryChecklist snapshot={answer('mqtt-live.json')} />);
    expect(markup).toContain('<button class="telemetry-item telemetry-button tone-neutral" type="button" aria-expanded="false" aria-controls="delivery-checklist"');
    expect(markup).toContain(translate(lang, 'delivery.setup'));
    // Closed, the panel is not in the page.
    expect(markup).not.toContain('class="delivery-panel"');
  });
});

describe('cause of an unverified compass offset', () => {
  it('names each local or missing source and nothing for a verified one', () => {
    expect(compassCauseKey('FALLBACK')).toBe('map.orientationFallback');
    expect(compassCauseKey('DATA_OUT_LOCAL_OFFSET')).toBe('map.orientationNoOffset');
    expect(compassCauseKey('DATA_OUT_UNAVAILABLE')).toBe('map.orientationNotRead');
    expect(compassCauseKey('DATA_OUT')).toBeNull();
    expect(compassCauseKey('MANUAL')).toBeNull();
  });

  it.each(['en', 'id'] as const)('fills the REFERENCE notice in %s', (lang) => {
    const text = translate(lang, 'map.orientationReference', { cause: translate(lang, 'map.orientationNotRead'), offset: 0 });
    expect(text).toContain(translate(lang, 'map.orientationNotRead'));
    expect(text).not.toContain('{');
  });
});

describe('DoA Diagnostics names the source of an MQTT answer', () => {
  it.each(['en', 'id'] as const)('says Data Out (fallback) is not used in %s', (lang) => {
    const markup = wrap(lang, <DoADiagnosticsPage snapshot={answer('mqtt-live.json')} localSnapshotFresh />);
    expect(markup).toContain(translate(lang, 'diag.mqtt.sourceValue'));
    expect(translate('id', 'diag.mqtt.sourceValue')).toBe('MQTT · Data Out (cadangan) tidak dipakai');
    const dataOutMarkup = wrap(lang, <DoADiagnosticsPage snapshot={dataOut()} localSnapshotFresh />);
    expect(dataOutMarkup).not.toContain(translate(lang, 'diag.mqtt.sourceValue'));
  });
});
