import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { normalizeCapabilities, normalizeConfigCommandStatus, normalizeConfigReported } from '../api';
import type { ConfigReported } from '../api';
import { ControlPanelView, rebaseOutcome, reviewRows } from '../components/overview/ControlPanel';
import type { ControlPanelViewProps } from '../components/overview/ControlPanel';
import { rfRows } from '../components/overview/NodeCard';
import type { TelemetrySnapshot } from '../types';
import {
  EDGE_ERROR_KEYS,
  commandResultView,
  configPatchFieldsFor,
  draftFromReported,
  draftText,
  draftWithSquelchLevel,
  engineSquelchDb,
  fieldFor,
  fieldValueText,
  mergeIntoDraft,
  parseDraft,
  reportedSquelch,
  resolvedSquelchMode,
  squelchIsAuto,
  squelchModeText,
  takesSquelchMode,
  wholeNumber,
} from './configPatch';
import type { DraftValues, ReportedSquelch, ReportedValues } from './configPatch';
import { parseDryRunChanges } from './configForm';
import { normalizeConfigPatchChanges } from './controlDraft';
import { dataOutDefaultSquelchMode, verifyConfigPatch } from './configVerify';
import { I18nContext, translate } from './i18n';
import type { Lang } from './i18n';
import { snapshotRf } from './telemetrySource';

// Edge 1.9.0 (contract 1.9): config.patch takes vfo0_squelch_mode (Manual, Auto, Auto Channel, Default),
// writes vfo0_squelch_db in whole dB, sends state.rf.sqm (rf.sq left out while automatic) and names
// result.squelch_mode when a level switched an automatic squelch to Manual.

const EDGE_18 = ['ant_spacing_m', 'center_frequency_hz', 'gain_db', 'vfo0_bandwidth_hz', 'vfo0_frequency_hz', 'vfo0_squelch_db'];
const EDGE_19 = [...EDGE_18, 'vfo0_squelch_mode'];
const FIELDS_19 = configPatchFieldsFor(EDGE_19);
const FIELDS_18 = configPatchFieldsFor(EDGE_18);

const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars);
const id = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('id', key, vars);

const LIVE: ReportedValues = {
  center_frequency_hz: 433_920_000, gain_db: 15.7, vfo0_frequency_hz: 433_920_000, vfo0_bandwidth_hz: 12_500,
  vfo0_squelch_db: -80, ant_spacing_m: 0.128, vfo0_squelch_mode: 'Manual',
};

function evaluate(draft: DraftValues, reported: ReportedValues = LIVE, fields = FIELDS_19, squelch: ReportedSquelch | null = null) {
  return parseDraft(fields, { ...draftFromReported(reported, fields), ...draft }, reported, null, undefined, squelch);
}

const squelchOf = (evaluation: ReturnType<typeof evaluate>) => evaluation.fields.find((entry) => entry.field.key === 'vfo0_squelch_db');

describe('the squelch mode field', () => {
  it('is offered only to an edge that lists it, last in the edge order', () => {
    expect(FIELDS_19.map((field) => field.key).at(-1)).toBe('vfo0_squelch_mode');
    expect(takesSquelchMode(FIELDS_19)).toBe(true);
    expect(takesSquelchMode(FIELDS_18)).toBe(false);
    expect(takesSquelchMode(configPatchFieldsFor(null))).toBe(false);
    expect(fieldFor('vfo0_squelch_mode')).toMatchObject({ kind: 'choice', choices: ['Manual', 'Auto', 'Auto Channel', 'Default'] });
  });

  it('shows the operator words and sends the exact edge string', () => {
    const field = fieldFor('vfo0_squelch_mode');
    expect(field.choices.map((choice) => fieldValueText(en, field, choice))).toEqual([
      'Manual', 'Auto · whole spectrum', 'Auto · just under the signal', 'RDF-SDR default',
    ]);
    // Reused in sentences, so the Manual label is the bare word in both languages.
    expect(fieldValueText(id, field, 'Manual')).toBe('Manual');
    expect(fieldValueText(id, field, 'Auto Channel')).toBe('Otomatis · tepat di bawah sinyal');
    const picked = evaluate({ vfo0_squelch_mode: 'Auto Channel' });
    expect(picked.invalid).toBe(false);
    expect(picked.changes).toEqual({ vfo0_squelch_mode: 'Auto Channel' });
    // An unknown value never goes out.
    const bad = evaluate({ vfo0_squelch_mode: 'auto' });
    expect(bad.invalid).toBe(true);
    expect(bad.changes).toEqual({});
    expect(bad.fields.find((entry) => entry.field.key === 'vfo0_squelch_mode')?.problem).toBe('choice');
    expect(normalizeConfigPatchChanges({ vfo0_squelch_mode: 'Auto', gain_db: 'loud', vfo0_squelch_db: -80 }))
      .toEqual({ vfo0_squelch_mode: 'Auto', vfo0_squelch_db: -80 });
    expect(normalizeConfigPatchChanges({ vfo0_squelch_mode: 'On', center_frequency_hz: 'x' })).toEqual({});
  });

  it('locks the level for a picked Auto or Auto Channel, and sends nothing for it', () => {
    for (const mode of ['Auto', 'Auto Channel']) {
      const evaluation = evaluate({ vfo0_squelch_mode: mode, vfo0_squelch_db: '-60' });
      expect(squelchOf(evaluation)).toMatchObject({ locked: true, changed: false, problem: null, lockedText: mode.toUpperCase() });
      expect(evaluation.changes).toEqual({ vfo0_squelch_mode: mode });
    }
    // A reported automatic squelch: the edge sends no level that matters, and an empty one is not a problem.
    const auto = evaluate({ vfo0_squelch_db: '' }, { ...LIVE, vfo0_squelch_mode: 'Auto', vfo0_squelch_db: -71.4 });
    expect(auto.invalid).toBe(false);
    expect(auto.changes).toEqual({});
    expect(squelchOf(auto)).toMatchObject({ locked: true, lockedText: 'AUTO', reportedText: 'AUTO' });
  });

  it('locks a picked Default only when what it follows is known to be automatic', () => {
    // Default following Manual, or an unknown default, leaves the level editable.
    for (const squelch of [null, reportedSquelch(null, 'Manual')]) {
      const evaluation = evaluate({ vfo0_squelch_mode: 'Default', vfo0_squelch_db: '-60' }, LIVE, FIELDS_19, squelch);
      expect(squelchOf(evaluation)?.locked).toBeUndefined();
      expect(evaluation.changes).toEqual({ vfo0_squelch_db: -60, vfo0_squelch_mode: 'Default' });
    }
    const followsAuto = evaluate({ vfo0_squelch_mode: 'Default', vfo0_squelch_db: '-60' }, LIVE, FIELDS_19, reportedSquelch(null, 'Auto Channel'));
    expect(squelchOf(followsAuto)).toMatchObject({ locked: true, lockedText: 'DEFAULT → AUTO CHANNEL' });
    expect(followsAuto.changes).toEqual({ vfo0_squelch_mode: 'Default' });
  });

  it('resolves a reported mode as the edge does (source.squelch_is_auto)', () => {
    expect([undefined, null, 'Default', 'Manual', 'Auto', 'Auto Channel'].map((mode) => squelchIsAuto(mode))).toEqual([true, true, true, false, true, true]);
    expect(squelchIsAuto('Default', 'Manual')).toBe(false);
    expect(squelchIsAuto(undefined, 'Auto Channel')).toBe(true);
    expect(squelchIsAuto('Manual', 'Auto')).toBe(false);
    expect(resolvedSquelchMode('Default', 'Manual')).toBe('Manual');
    expect(resolvedSquelchMode(null)).toBe('Auto');
    const reportedDefault = { ...LIVE, vfo0_squelch_mode: 'Default', vfo0_squelch_db: -71 };
    // A reported Default that follows Manual (the server's flag): the level is the node's and editable.
    const manual = evaluate({}, reportedDefault, FIELDS_19, { auto: false, resolvedMode: 'Manual', defaultMode: 'Manual' });
    expect(squelchOf(manual)).toMatchObject({ text: '-71', problem: null });
    expect(squelchOf(manual)?.locked).toBeUndefined();
    expect(evaluate({ vfo0_squelch_db: '-60' }, reportedDefault, FIELDS_19, { auto: false, resolvedMode: 'Manual', defaultMode: 'Manual' }).changes)
      .toEqual({ vfo0_squelch_db: -60 });
    // Following Auto: locked, and the current value is the mode it resolves to.
    const auto = evaluate({}, reportedDefault, FIELDS_19, { auto: true, resolvedMode: 'Auto', defaultMode: null });
    expect(squelchOf(auto)).toMatchObject({ locked: true, lockedText: 'DEFAULT → AUTO' });
    // Without the server's flag the edge's own rule decides: Default with no default known is Auto.
    expect(squelchOf(evaluate({}, reportedDefault))).toMatchObject({ locked: true, lockedText: 'DEFAULT → AUTO' });
    expect(squelchOf(evaluate({}, reportedDefault, FIELDS_19, reportedSquelch(null, 'Manual')))?.locked).toBeUndefined();
    // The server's flag also covers a report without the mode (Default, then its default).
    const noMode = evaluate({}, { ...LIVE, vfo0_squelch_mode: null }, FIELDS_19, { auto: true, resolvedMode: 'Auto Channel', defaultMode: 'Auto Channel' });
    expect(squelchOf(noMode)).toMatchObject({ locked: true, lockedText: 'DEFAULT → AUTO CHANNEL' });
    // A reported Manual squelch is never locked.
    expect(squelchOf(evaluate({}, LIVE, FIELDS_19, { auto: false, resolvedMode: 'Manual', defaultMode: 'Auto' }))?.locked).toBeUndefined();
  });

  it('reads the server\'s squelch facts and Data Out\'s default mode', () => {
    const settings = normalizeConfigReported({
      available: true, broker: {},
      settings: { id: 'gc-get-1', rev: 42, matches_state_cfg: true, squelch_auto: false, squelch_mode_resolved: 'Manual', vfo_default_squelch_mode: 'Manual' },
    }).settings;
    expect(settings).toMatchObject({ squelchAuto: false, squelchModeResolved: 'Manual', defaultSquelchMode: 'Manual' });
    expect(reportedSquelch(settings, 'Auto')).toEqual({ auto: false, resolvedMode: 'Manual', defaultMode: 'Manual' });
    const older = normalizeConfigReported({ available: true, broker: {}, settings: { id: 'gc-get-1', squelch_auto: 'yes', vfo_default_squelch_mode: '<b>' } }).settings;
    expect(older).toMatchObject({ squelchAuto: null, squelchModeResolved: null, defaultSquelchMode: null });
    expect(reportedSquelch(older, 'Auto Channel')).toEqual({ auto: null, resolvedMode: null, defaultMode: 'Auto Channel' });
    const snapshot = { settings: { available: true, fields: { vfo_default_squelch_mode: 'Manual' } } } as unknown as TelemetrySnapshot;
    expect(dataOutDefaultSquelchMode(snapshot, true)).toBe('Manual');
    expect(dataOutDefaultSquelchMode(snapshot, false)).toBeNull();
    expect(dataOutDefaultSquelchMode({ ...snapshot, simulation: true } as TelemetrySnapshot, true)).toBeNull();
  });

  it('makes the mode Manual when a level is typed', () => {
    expect(draftWithSquelchLevel({ vfo0_squelch_mode: 'Auto' }, '-70', FIELDS_19)).toEqual({ vfo0_squelch_mode: 'Manual', vfo0_squelch_db: '-70' });
    // An older edge has no mode to set.
    expect(draftWithSquelchLevel({}, '-70', FIELDS_18)).toEqual({ vfo0_squelch_db: '-70' });
    // Unknown mode (none reported): the level goes with an explicit Manual.
    const unknown = evaluate(draftWithSquelchLevel({}, '-70', FIELDS_19), { ...LIVE, vfo0_squelch_mode: null });
    expect(unknown.changes).toEqual({ vfo0_squelch_db: -70, vfo0_squelch_mode: 'Manual' });
    // A change brought back for review keeps its level with Manual, as the edge would.
    expect(mergeIntoDraft({}, { vfo0_squelch_db: -70 }, FIELDS_19)).toEqual({ vfo0_squelch_db: '-70', vfo0_squelch_mode: 'Manual' });
    expect(mergeIntoDraft({}, { vfo0_squelch_db: -70, vfo0_squelch_mode: 'Manual' }, FIELDS_19)).toEqual({ vfo0_squelch_db: '-70', vfo0_squelch_mode: 'Manual' });
    expect(mergeIntoDraft({}, { vfo0_squelch_db: -70 }, FIELDS_18)).toEqual({ vfo0_squelch_db: '-70' });
  });

  it('reviews both rows in the operator words', () => {
    const evaluation = evaluate({ vfo0_squelch_mode: 'Manual', vfo0_squelch_db: '-70' }, { ...LIVE, vfo0_squelch_mode: 'Auto' });
    expect(evaluation.changes).toEqual({ vfo0_squelch_db: -70, vfo0_squelch_mode: 'Manual' });
    // The level in settings.json does not run while the squelch is automatic: its current value is the mode.
    expect(reviewRows(id, evaluation.fields)).toEqual([
      { key: 'vfo0_squelch_db', label: 'Squelch VFO', from: 'AUTO', to: '−70 dB' },
      { key: 'vfo0_squelch_mode', label: 'Mode squelch', from: 'Otomatis · seluruh spektrum', to: 'Manual' },
    ]);
    const manual = evaluate({ vfo0_squelch_db: '-70' });
    expect(reviewRows(en, manual.fields)).toEqual([{ key: 'vfo0_squelch_db', label: 'VFO squelch', from: '−80 dB', to: '−70 dB' }]);
  });
});

describe('the squelch in whole dB (edge 1.9.0)', () => {
  it('rounds as Python round() does', () => {
    expect([-40.7, -40.2, -40.5, -41.5, 40.5, 41.5, -80].map(wholeNumber)).toEqual([-41, -40, -40, -42, 40, 42, -80]);
  });

  it('sends a typed fraction as whole dB and says so', () => {
    const evaluation = evaluate({ vfo0_squelch_db: '-40.7' });
    expect(evaluation.changes).toEqual({ vfo0_squelch_db: -41 });
    expect(Number.isInteger(evaluation.changes.vfo0_squelch_db)).toBe(true);
    expect(fieldFor('vfo0_squelch_db')).toMatchObject({ step: 1, decimals: 0, integer: true, unit: 'dB' });
  });

  it('reads a reported fraction as rdfsdr runs it (int(), toward zero) and keeps the form clean', () => {
    const reported = { ...LIVE, vfo0_squelch_db: -40.7 };
    expect([-40.7, -40.2, 40.7, -0.4, 0.4, -80].map(engineSquelchDb)).toEqual([-40, -40, 40, 0, 0, -80]);
    expect(Object.is(engineSquelchDb(-0.4), 0)).toBe(true);
    expect(draftText(fieldFor('vfo0_squelch_db'), -40.7)).toBe('-40');
    expect(draftText(fieldFor('vfo0_squelch_db'), -0.4)).toBe('0');
    const untouched = evaluate({}, reported);
    expect(untouched.changes).toEqual({});
    expect(untouched.invalid).toBe(false);
    expect(squelchOf(untouched)).toMatchObject({ text: '-40', reported: -40 });
    // Typing the value it reads as is no change; a typed value is rounded as the edge rounds it.
    expect(evaluate({ vfo0_squelch_db: '-40' }, reported).changes).toEqual({});
    expect(evaluate({ vfo0_squelch_db: '-40.4' }, reported).changes).toEqual({});
    expect(evaluate({ vfo0_squelch_db: '-41' }, reported).changes).toEqual({ vfo0_squelch_db: -41 });
    expect(evaluate({ vfo0_squelch_db: '-40.7' }, reported).changes).toEqual({ vfo0_squelch_db: -41 });
    // The hint names the level that runs.
    expect(reviewRows(en, evaluate({ vfo0_squelch_db: '-41' }, reported).fields)[0]).toMatchObject({ from: '−40 dB', to: '−41 dB' });
  });

  it('checks the range before rounding, as the edge does', () => {
    expect(evaluate({ vfo0_squelch_db: '50.4' }).fields.find((entry) => entry.field.key === 'vfo0_squelch_db')?.problem).toBe('range');
    expect(evaluate({ vfo0_squelch_db: '50' }).changes).toEqual({ vfo0_squelch_db: 50 });
  });

  it('keeps an older edge as before: 0.5 dB steps, sent as typed', () => {
    const squelch = FIELDS_18.find((field) => field.key === 'vfo0_squelch_db');
    expect(squelch).toMatchObject({ step: 0.5, integer: false });
    const older = { ...LIVE, vfo0_squelch_mode: null, vfo0_squelch_db: -40.7 };
    expect(draftFromReported(older, FIELDS_18).vfo0_squelch_db).toBe('-40.7');
    expect(evaluate({ vfo0_squelch_db: '-40.5' }, older, FIELDS_18).changes).toEqual({ vfo0_squelch_db: -40.5 });
    expect(evaluate({}, older, FIELDS_18).changes).toEqual({});
  });
});

describe('the edge answer', () => {
  const status = (ack: Record<string, unknown>) => normalizeConfigCommandStatus({
    command_id: 'gc-1', op: 'config.patch', state: 'acked', changes: { vfo0_squelch_db: -70 },
    ack: { status: 'APPLIED', final: true, revision: 43, method: 'LIVE', ...ack },
  });

  it('names the mode a level switched the squelch to', () => {
    const switched = status({ squelch_mode: 'Manual' });
    expect(switched?.ack?.squelchMode).toBe('Manual');
    expect(switched?.changes).toEqual({ vfo0_squelch_db: -70 });
    expect(squelchModeText(en, switched?.ack ?? null)).toBe('The squelch mode is now Manual: a level counts only in Manual.');
    expect(squelchModeText(id, switched?.ack ?? null)).toBe('Mode squelch kini Manual: level hanya berlaku pada Manual.');
    expect(commandResultView(switched!, 1, 42, 15).code).toBe('APPLIED · LIVE · squelch_mode Manual');
    const plain = status({});
    expect(plain?.ack?.squelchMode).toBeNull();
    expect(squelchModeText(en, plain?.ack ?? null)).toBeNull();
    expect(commandResultView(plain!, 1, 42, 15).code).toBe('APPLIED · LIVE');
    expect(status({ squelch_mode: '<b>' })?.ack?.squelchMode).toBeNull();
  });

  it('explains SQUELCH_MODE_INVALID in both languages', () => {
    expect(EDGE_ERROR_KEYS.SQUELCH_MODE_INVALID).toBe('control.error.SQUELCH_MODE_INVALID');
    const failed = normalizeConfigCommandStatus({
      command_id: 'gc-1', op: 'config.patch', state: 'acked', changes: {},
      ack: { status: 'FAILED', final: true, error: 'SQUELCH_MODE_INVALID' },
    });
    const view = commandResultView(failed!, 1, 42, 15);
    expect(en(view.body.key)).toBe('The squelch mode must be Manual, Auto, Auto Channel or Default.');
    expect(id(view.body.key)).toBe('Mode squelch harus Manual, Auto, Auto Channel, atau Default.');
  });

  it('reads the reported mode as its string and drops anything else', () => {
    const reported = normalizeConfigReported({
      available: true, broker: { connection: 'connected' },
      values: { vfo0_squelch_mode: 'Auto Channel', vfo0_squelch_db: -71 },
    });
    expect(reported.values.vfo0_squelch_mode).toBe('Auto Channel');
    expect(normalizeConfigReported({ available: true, broker: {}, values: { vfo0_squelch_mode: 'Loud' } }).values.vfo0_squelch_mode).toBeNull();
    expect(normalizeConfigReported({ available: true, broker: {}, values: { vfo0_squelch_mode: 3 } }).values.vfo0_squelch_mode).toBeNull();
  });
});

describe('the read-back of a sent squelch mode', () => {
  const reported = (mode: string | null, at = 2_000) => ({
    values: { center_frequency_hz: null, gain_db: null, vfo0_frequency_hz: null, vfo0_bandwidth_hz: null, vfo0_squelch_db: null, ant_spacing_m: null, vfo0_squelch_mode: mode },
    valueReceivedAtMs: { center_frequency_hz: null, gain_db: null, vfo0_frequency_hz: null, vfo0_bandwidth_hz: null, vfo0_squelch_db: null, ant_spacing_m: null, vfo0_squelch_mode: mode === null ? null : at },
  });
  const check = (mqtt: string | null, dataOut: string | null = null) => verifyConfigPatch({
    changes: { vfo0_squelch_mode: 'Auto Channel' },
    issuedAtMs: 1_000,
    finalAtMs: 3_000,
    nowMs: 200_000,
    reported: reported(mqtt),
    snapshot: dataOut === null ? null : { settings: { available: true, fields: { vfo_squelch_mode_0: dataOut } } } as TelemetrySnapshot,
    snapshotFresh: true,
  });

  it('compares the string exactly', () => {
    expect(check('Auto Channel').fields[0]).toMatchObject({ key: 'vfo0_squelch_mode', sent: 'Auto Channel', basis: 'mqtt', status: 'confirmed' });
    expect(check('Auto').fields[0].status).toBe('unchanged');
    expect(check(null, 'Auto Channel').fields[0]).toMatchObject({ basis: 'data-out', status: 'confirmed' });
    expect(check(null, 'auto channel').fields[0].status).toBe('not-reported');
    expect(check(null).fields[0].status).toBe('not-reported');
  });
});

describe('state.rf.sqm in the node card', () => {
  const base = { cfg: 1, centerHz: null, vfo0Hz: null, gainDb: null, bandwidthHz: null, squelchDb: null, ucaM: null };

  it('shows a sent level (the edge leaves it out while automatic), else a mode other than Manual', () => {
    expect(rfRows({ ...base, squelchMode: 'Auto' }, en)).toEqual([['Squelch', 'AUTO · setting', undefined, true]]);
    expect(rfRows({ ...base, squelchMode: 'Auto Channel' }, en)).toEqual([['Squelch', 'AUTO CHANNEL · setting', undefined, true]]);
    expect(rfRows({ ...base, squelchMode: 'Default' }, id)).toEqual([['Squelch', 'DEFAULT · setelan', undefined, true]]);
    // Default that follows Manual: the edge sends the level, which is what runs.
    expect(rfRows({ ...base, squelchMode: 'Default', squelchDb: -71 }, id)).toEqual([['Squelch', '-71 dB · setelan', undefined, true]]);
    expect(rfRows({ ...base, squelchMode: 'Manual', squelchDb: -80 }, en)).toEqual([['Squelch', '-80 dB · setting', undefined, true]]);
    // A fraction left in settings.json runs as int(): toward zero.
    expect(rfRows({ ...base, squelchMode: 'Manual', squelchDb: -40.7 }, en)).toEqual([['Squelch', '-40 dB · setting', undefined, true]]);
    expect(rfRows({ ...base, squelchMode: 'Manual', squelchDb: -0.4 }, en)).toEqual([['Squelch', '0 dB · setting', undefined, true]]);
    // An older edge (no mode) as before.
    expect(rfRows({ ...base, squelchDb: -100 }, en)).toEqual([['Squelch', '-100.0 dB · setting', undefined, true]]);
    expect(rfRows({ ...base, squelchDb: -40.7 }, en)).toEqual([['Squelch', '-40.7 dB · setting', undefined, true]]);
    expect(rfRows({ ...base, squelchMode: 'Manual' }, en)).toEqual([]);
  });

  it('reads rf.squelch_mode of an MQTT answer, with or without a level', () => {
    const answer = (rf: Record<string, unknown>) => ({ source: { kind: 'mqtt' }, rf: { source: 'state.rf', ...rf } }) as unknown as TelemetrySnapshot;
    expect(snapshotRf(answer({ squelch_mode: 'Auto Channel', vfo0_squelch_db: null }))).toMatchObject({ squelchMode: 'Auto Channel', squelchDb: null });
    expect(snapshotRf(answer({ squelch_mode: 'Manual', vfo0_squelch_db: -80 }))).toMatchObject({ squelchMode: 'Manual', squelchDb: -80 });
    expect(snapshotRf(answer({ squelch_mode: '', vfo0_squelch_db: -80 }))?.squelchMode).toBeNull();
    expect(snapshotRf(answer({ squelch_mode: null }))).toBeNull();
  });
});

describe('the Configuration dry-run form', () => {
  it('sends the picked squelch mode as its string beside the numbers', () => {
    const fields = [fieldFor('vfo0_squelch_db'), fieldFor('vfo0_squelch_mode')];
    expect(parseDryRunChanges({ vfo0_squelch_db: '-70', vfo0_squelch_mode: 'Auto Channel' }, fields))
      .toEqual({ ok: true, value: { vfo0_squelch_db: -70, vfo0_squelch_mode: 'Auto Channel' } });
    expect(parseDryRunChanges({ vfo0_squelch_mode: '' }, fields)).toEqual({ ok: false, error: 'config.dryRunEmpty' });
  });
});

describe('Kontrol with an edge 1.9 node', () => {
  const CAPABILITIES = normalizeCapabilities({ admin_enabled: true, config_patch: { enabled: true, requires_admin: true } });
  const NODE = { sid: '0a1b2c3d', cfg: 42, health_fresh: true, health_age_ms: 900, remote_commands: true, remote_config_patch: true };
  const reportedFor = (fields: string[] | undefined, mode: string | null): ConfigReported => normalizeConfigReported({
    available: true,
    broker: { host: '10.90.0.1', port: 9001, transport: 'websockets', connection: 'connected' },
    node: { ...NODE, ...(fields ? { config_fields: fields } : {}) },
    base_rev: 42,
    settings: { id: 'gc-get-1', rev: 42, received_at_ms: 99_000, age_ms: 1200, matches_state_cfg: true },
    values: { center_frequency_hz: 433_920_000, gain_db: 15.7, vfo0_frequency_hz: 433_920_000, vfo0_bandwidth_hz: 12_500, vfo0_squelch_db: -80, ant_spacing_m: 0.128, vfo0_squelch_mode: mode },
  });

  function view(reported: ConfigReported, draft: DraftValues = {}, lang: Lang = 'en', props: Partial<ControlPanelViewProps> = {}): string {
    const noop = () => undefined;
    const fields = configPatchFieldsFor(reported.node?.configFields);
    const evaluation = parseDraft(fields, { ...draftFromReported(reported.values, fields), ...draft }, reported.values, null);
    return renderToStaticMarkup(
      <I18nContext.Provider value={{ lang, setLang: noop, t: (key, vars) => translate(lang, key, vars) }}>
        <ControlPanelView
          capabilities={CAPABILITIES} admin="unlocked" adminNotice={null} reported={reported} reportedError={null}
          evaluation={evaluation} stage="edit" review={null} sending={null} done={null} editError={null}
          onClose={noop} onLock={noop} onUnlocked={noop} onDraftChange={noop} onReview={noop} onReset={noop}
          onSend={noop} onBack={noop} onDone={noop} onReload={noop}
          {...props}
        />
      </I18nContext.Provider>,
    );
  }

  it('offers the mode select with the operator words and the edge strings as values', () => {
    const markup = view(reportedFor(EDGE_19, 'Manual'));
    expect(markup).toContain('<label for="ov-control-vfo0_squelch_mode">Squelch mode</label>');
    expect(markup).toContain('<option value="Auto Channel">Auto · just under the signal</option>');
    expect(markup).toContain('<option value="Manual" selected="">Manual</option>');
    expect(markup).toMatch(/id="ov-control-vfo0_squelch_db"[^>]*value="-80"\/><span>dB<\/span>/);
    expect(markup.match(/class="ov-control-field"/g)).toHaveLength(7);
  });

  it('disables the level with a note while the squelch is automatic', () => {
    const markup = view(reportedFor(EDGE_19, 'Auto'), {}, 'id');
    expect(markup).toMatch(/id="ov-control-vfo0_squelch_db"[^>]*disabled=""/);
    expect(markup).toContain('Diatur RDF-SDR sendiri pada mode ini');
    // The mode in place of the level, without a unit.
    expect(markup).toMatch(/id="ov-control-vfo0_squelch_db"[^>]*value="AUTO"[^>]*\/><\/div>/);
    expect(view(reportedFor(EDGE_19, 'Default'))).toMatch(/id="ov-control-vfo0_squelch_db"[^>]*value="DEFAULT → AUTO"/);
  });

  it('renders an older edge exactly as before: no mode, the level enabled', () => {
    for (const fields of [EDGE_18, undefined]) {
      const markup = view(reportedFor(fields, null));
      expect(markup).not.toContain('vfo0_squelch_mode');
      expect(markup).not.toContain('Squelch mode');
      expect(markup).not.toMatch(/id="ov-control-vfo0_squelch_db"[^>]*disabled=""/);
    }
  });

  it('shows the switch to Manual under the result', () => {
    const done = normalizeConfigCommandStatus({
      command_id: 'gc-1', op: 'config.patch', state: 'acked', changes: { vfo0_squelch_db: -70 },
      ack: { status: 'APPLIED', final: true, revision: 43, method: 'LIVE', squelch_mode: 'Manual' },
    })!;
    const markup = view(reportedFor(EDGE_19, 'Manual'), {}, 'en', {
      stage: 'done',
      done: { view: commandResultView(done, 1, 42, 15), error: null, commandId: 'gc-1', restarted: false, ack: done.ack },
    });
    expect(markup).toContain('The squelch mode is now Manual: a level counts only in Manual.');
    expect(markup).toContain('APPLIED · LIVE · squelch_mode Manual');
  });

  it('brings a reviewed level back with Manual after the node switched to Auto', () => {
    const reported = reportedFor(EDGE_19, 'Auto');
    const outcome = rebaseOutcome({ changes: { vfo0_squelch_db: -70 }, fromRev: 41, startedAtMs: 0 }, reported, null, null, [15.7], en, 10_000);
    expect(outcome.kind).toBe('review');
    if (outcome.kind === 'review') expect(outcome.review.changes).toEqual({ vfo0_squelch_db: -70, vfo0_squelch_mode: 'Manual' });
  });
});
