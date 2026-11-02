import { describe, expect, it } from 'vitest';
import {
  BAND_RULES,
  appliedMethodText,
  bandRuleFor,
  bandSpacingText,
  configPatchFieldsFor,
  takesUca,
  commandStageText,
  restartReasonText,
  CONFIG_PATCH_ERROR_CODES,
  CONFIG_PATCH_ERROR_KEYS,
  CONFIG_PATCH_FIELDS,
  EDGE_ERROR_KEYS,
  GAIN_TABLE_DB,
  commandResultView,
  displayValue,
  draftFromReported,
  draftWithBand,
  draftWithCenter,
  edgeErrorKey,
  edgeHelperFault,
  fieldFor,
  gainTableValue,
  inFieldRange,
  mergeIntoDraft,
  parseDraft,
  rangeParts,
  settingsReadView,
} from './configPatch';
import type { CommandStatusLike } from './configPatch';
import { CONFIG_PATCH_KEYS } from './controlDraft';
import { DICTIONARIES, translate } from './i18n';

// The five fields of an edge without capabilities.config_fields (before 1.8.0): Kontrol as before.
const LEGACY = configPatchFieldsFor(null);

const REPORTED = {
  center_frequency_hz: 416_588_000,
  gain_db: 15.7,
  vfo0_frequency_hz: null,
  vfo0_bandwidth_hz: null,
  vfo0_squelch_db: null,
};

describe('config patch fields', () => {
  it('cover the edge safe fields in its order with the helper limits', () => {
    expect(CONFIG_PATCH_FIELDS.map((field) => field.key)).toEqual([...CONFIG_PATCH_KEYS]);
    expect(CONFIG_PATCH_FIELDS.map((field) => (field.kind === 'number' ? [field.min, field.max] : field.choices))).toEqual([
      [24_000_000, 1_766_000_000], [-10, 100], [24_000_000, 1_766_000_000], [100, 2_400_000], [-200, 50], [0.05, 1],
      ['Manual', 'Auto', 'Auto Channel', 'Default'],
    ]);
    expect(CONFIG_PATCH_FIELDS.filter((field) => field.kind === 'number' && field.table).map((field) => field.key)).toEqual(['gain_db']);
    expect(GAIN_TABLE_DB).toHaveLength(29);
  });

  it('show frequencies in MHz and kHz', () => {
    expect(displayValue(fieldFor('center_frequency_hz'), 416_588_000)).toBe('416.588 MHz');
    expect(displayValue(fieldFor('center_frequency_hz'), 433_920_500)).toBe('433.9205 MHz');
    expect(displayValue(fieldFor('vfo0_bandwidth_hz'), 12_500)).toBe('12.5 kHz');
    expect(displayValue(fieldFor('vfo0_squelch_db'), -80)).toBe('−80 dB');
    expect(rangeParts(fieldFor('vfo0_bandwidth_hz'), null)).toEqual({ min: '0.1', max: '2400', unit: 'kHz' });
    expect(rangeParts(fieldFor('gain_db'), { gain_db: [-10, 50] })).toEqual({ min: '−10', max: '50', unit: 'dB' });
  });

  it('prefer the server ranges', () => {
    expect(inFieldRange('center_frequency_hz', 1_800_000_000, null)).toBe(false);
    expect(inFieldRange('center_frequency_hz', 1_800_000_000, { center_frequency_hz: [24_000_000, 3_000_000_000] })).toBe(true);
    expect(inFieldRange('gain_db', Number.NaN)).toBe(false);
  });

  it('match a gain to the table within 0.001 dB', () => {
    expect(gainTableValue(20.7)).toBe(20.7);
    expect(gainTableValue(20.7004)).toBe(20.7);
    expect(gainTableValue(20.702)).toBeNull();
    expect(gainTableValue(0)).toBe(0);
    expect(gainTableValue(24.5)).toBeNull();
    expect(gainTableValue(24.5, [24.5])).toBe(24.5);
  });
});

describe('parseDraft', () => {
  const draft = draftFromReported(REPORTED, LEGACY);

  it('starts with no changes and leaves unreported fields empty', () => {
    expect(draft).toEqual({ center_frequency_hz: '416.588', gain_db: '15.7', vfo0_frequency_hz: '', vfo0_bandwidth_hz: '', vfo0_squelch_db: '' });
    const result = parseDraft(LEGACY, draft, REPORTED, null);
    expect(result.invalid).toBe(false);
    expect(result.changes).toEqual({});
  });

  it('converts display units to SI and keeps frequencies integer Hz', () => {
    const result = parseDraft(LEGACY, { ...draft, vfo0_bandwidth_hz: '12.5', gain_db: '20,7', vfo0_squelch_db: '−70' }, REPORTED, null);
    expect(result.invalid).toBe(false);
    expect(result.changes).toEqual({ gain_db: 20.7, vfo0_bandwidth_hz: 12_500, vfo0_squelch_db: -70 });
    expect(result.fields.find((field) => field.field.key === 'vfo0_bandwidth_hz')?.reported).toBeNull();
  });

  it('flags empty reported fields, non-numbers, out-of-range values and gains off the table', () => {
    const result = parseDraft(LEGACY, { ...draft, center_frequency_hz: '', gain_db: '20', vfo0_squelch_db: '60' }, REPORTED, null);
    expect(result.invalid).toBe(true);
    expect(result.fields.map((field) => field.problem)).toEqual(['empty', 'table', null, null, 'range']);
    expect(result.changes).toEqual({});
    expect(parseDraft(LEGACY, { ...draft, gain_db: 'abc' }, REPORTED, null).fields[1].problem).toBe('number');
    // A server table replaces the client copy.
    expect(parseDraft(LEGACY, { ...draft, gain_db: '20' }, REPORTED, null, [20]).changes).toEqual({ gain_db: 20 });
  });

  it('treats a value equal to the reported one as unchanged', () => {
    const result = parseDraft(LEGACY, { ...draft, center_frequency_hz: '416.5880' }, REPORTED, null);
    expect(result.changes).toEqual({});
  });

  it('takes VFO0 along with a centre change, at the same frequency', () => {
    const reported = { ...REPORTED, vfo0_frequency_hz: 433_920_000 };
    const base = draftFromReported(reported, LEGACY);
    // The centre moves to where VFO0 already is: VFO0 is sent unchanged.
    const along = parseDraft(LEGACY, { ...base, center_frequency_hz: '433.92' }, reported, null);
    expect(along.invalid).toBe(false);
    expect(along.changes).toEqual({ center_frequency_hz: 433_920_000, vfo0_frequency_hz: 433_920_000 });
    const vfo = along.fields.find((field) => field.field.key === 'vfo0_frequency_hz');
    expect([vfo?.changed, vfo?.required]).toEqual([true, true]);
    // Another frequency for VFO0 is refused, as the edge refuses it.
    const apart = parseDraft(LEGACY, { ...base, center_frequency_hz: '434', vfo0_frequency_hz: '434.01' }, reported, null);
    expect(apart.invalid).toBe(true);
    expect(apart.fields.find((field) => field.field.key === 'vfo0_frequency_hz')?.problem).toBe('centerVfo');
    expect(apart.changes).toEqual({ center_frequency_hz: 434_000_000 });
    // VFO0 alone may move inside the band.
    expect(parseDraft(LEGACY, { ...base, vfo0_frequency_hz: '433.95' }, reported, null).changes).toEqual({ vfo0_frequency_hz: 433_950_000 });
    // An unreported, empty VFO0 cannot go along.
    const empty = parseDraft(LEGACY, { ...draft, center_frequency_hz: '434' }, REPORTED, null);
    expect(empty.fields.find((field) => field.field.key === 'vfo0_frequency_hz')?.problem).toBe('centerVfo');
  });

  it('lets VFO0 follow the typed centre, and return to its own value', () => {
    const reported = { ...REPORTED, vfo0_frequency_hz: 416_600_000 };
    const followed = draftWithCenter({}, '434.5', reported);
    // 434.5 MHz is UHF, so the gain follows the band rule too.
    expect(followed).toEqual({ center_frequency_hz: '434.5', vfo0_frequency_hz: '434.5', gain_db: '15.7' });
    const back = draftWithCenter(followed, '416.588', reported);
    expect(back).toEqual({ center_frequency_hz: '416.588' });
    const result = parseDraft(LEGACY, { ...draftFromReported(reported, LEGACY), ...back }, reported, null);
    expect(result.changes).toEqual({});
  });

  it('gives a new centre in a band the band rule gain, and leaves other frequencies alone', () => {
    // The operator's rule of 2 November: UHF 400-480 MHz gain 15.7 dB (UCA 0.128 m), VHF 136-174 MHz 25.4 dB (UCA 0.3 m).
    expect(BAND_RULES.map((rule) => [rule.id, rule.gainDb, rule.ucaM])).toEqual([['VHF', 25.4, 0.3], ['UHF', 15.7, 0.128]]);
    for (const rule of BAND_RULES) expect(GAIN_TABLE_DB).toContain(rule.gainDb);
    expect(bandRuleFor(136_000_000)?.id).toBe('VHF');
    expect(bandRuleFor(174_000_000)?.id).toBe('VHF');
    expect(bandRuleFor(400_000_000)?.id).toBe('UHF');
    expect(bandRuleFor(480_000_000)?.id).toBe('UHF');
    for (const hz of [135_999_999, 174_000_001, 399_999_999, 480_000_001, null]) expect(bandRuleFor(hz)).toBeNull();
    const vhf = draftWithCenter({ gain_db: '15.7' }, '145.5', REPORTED);
    expect(vhf).toMatchObject({ center_frequency_hz: '145.5', vfo0_frequency_hz: '145.5', gain_db: '25.4' });
    expect(parseDraft(LEGACY, { ...draftFromReported(REPORTED, LEGACY), ...vhf }, REPORTED, null).changes)
      .toEqual({ center_frequency_hz: 145_500_000, gain_db: 25.4, vfo0_frequency_hz: 145_500_000 });
    // Outside both bands the gain the operator chose stays.
    expect(draftWithCenter({ gain_db: '20.7' }, '175', REPORTED)).toEqual({ center_frequency_hz: '175', vfo0_frequency_hz: '175', gain_db: '20.7' });
    expect(draftWithBand({}, 433_920_000)).toEqual({ gain_db: '15.7' });
    expect(draftWithBand({ gain_db: '20.7' }, 1_200_000_000)).toEqual({ gain_db: '20.7' });
  });

  it('compares a reported UCA spacing at the precision it is sent with', () => {
    const fields = CONFIG_PATCH_FIELDS;
    const reported = { ...REPORTED, ant_spacing_m: 0.21125 };
    expect(parseDraft(fields, draftFromReported(reported, fields), reported, null).changes).toEqual({});
    expect(parseDraft(fields, { ...draftFromReported(reported, fields), gain_db: '20.7' }, reported, null).changes).toEqual({ gain_db: 20.7 });
  });

  it('merges a spectrum draft as display text', () => {
    const merged = mergeIntoDraft(draft, { center_frequency_hz: 433_925_000, vfo0_frequency_hz: 433_925_000 });
    expect(merged.center_frequency_hz).toBe('433.925');
    expect(merged.vfo0_frequency_hz).toBe('433.925');
    expect(parseDraft(LEGACY, merged, REPORTED, null).changes).toEqual({ center_frequency_hz: 433_925_000, vfo0_frequency_hz: 433_925_000 });
  });
});

describe('edge 1.8: the UCA spacing (ant_spacing_m)', () => {
  const EDGE_18 = ['ant_spacing_m', 'center_frequency_hz', 'gain_db', 'vfo0_bandwidth_hz', 'vfo0_frequency_hz', 'vfo0_squelch_db'];
  const FIELDS = configPatchFieldsFor(EDGE_18);
  const reported = { ...REPORTED, vfo0_frequency_hz: 416_588_000, ant_spacing_m: 0.128 };

  it('offers the field only to an edge that lists it, in the edge order', () => {
    expect(LEGACY.map((field) => field.key)).toEqual(['center_frequency_hz', 'gain_db', 'vfo0_frequency_hz', 'vfo0_bandwidth_hz', 'vfo0_squelch_db']);
    expect(configPatchFieldsFor([])).toEqual(LEGACY);
    expect(configPatchFieldsFor(['something_new'])).toEqual(LEGACY);
    expect(FIELDS.map((field) => field.key)).toEqual(CONFIG_PATCH_KEYS.filter((key) => key !== 'vfo0_squelch_mode'));
    expect(configPatchFieldsFor(['gain_db', 'ant_spacing_m']).map((field) => field.key)).toEqual(['gain_db', 'ant_spacing_m']);
    expect([takesUca(LEGACY), takesUca(FIELDS)]).toEqual([false, true]);
  });

  it('shows metres with 3 decimals and sends 4, as the edge rounds it', () => {
    const field = fieldFor('ant_spacing_m');
    expect([field.unit, field.decimals, field.integer]).toEqual(['m', 3, false]);
    expect(displayValue(field, 0.3)).toBe('0.300 m');
    expect(displayValue(field, 0.1234)).toBe('0.1234 m');
    expect(rangeParts(field, null)).toEqual({ min: '0.05', max: '1', unit: 'm' });
    const base = draftFromReported(reported, FIELDS);
    expect(base.ant_spacing_m).toBe('0.128');
    expect(parseDraft(FIELDS, base, reported, null).changes).toEqual({});
    expect(parseDraft(FIELDS, { ...base, ant_spacing_m: '0,12345' }, reported, null).changes).toEqual({ ant_spacing_m: 0.1235 });
    expect(parseDraft(FIELDS, { ...base, ant_spacing_m: '1.2' }, reported, null).fields[5].problem).toBe('range');
    expect(parseDraft(FIELDS, { ...base, ant_spacing_m: '0.04' }, reported, null).fields[5].problem).toBe('range');
  });

  it('sets the band UCA with the gain, and takes both back with the centre', () => {
    const vhf = draftWithCenter({}, '145.5', reported, true);
    expect(vhf).toEqual({ center_frequency_hz: '145.5', vfo0_frequency_hz: '145.5', gain_db: '25.4', ant_spacing_m: '0.3' });
    expect(parseDraft(FIELDS, { ...draftFromReported(reported, FIELDS), ...vhf }, reported, null).changes)
      .toEqual({ center_frequency_hz: 145_500_000, gain_db: 25.4, vfo0_frequency_hz: 145_500_000, ant_spacing_m: 0.3 });
    expect(draftWithCenter(vhf, '416.588', reported, true)).toEqual({ center_frequency_hz: '416.588' });
    // UHF keeps a reported 0.128 m: nothing to send for the spacing.
    const uhf = draftWithCenter({}, '433.92', reported, true);
    expect(parseDraft(FIELDS, { ...draftFromReported(reported, FIELDS), ...uhf }, reported, null).changes)
      .toEqual({ center_frequency_hz: 433_920_000, vfo0_frequency_hz: 433_920_000 });
    expect(draftWithBand({}, 150_000_000, true)).toEqual({ gain_db: '25.4', ant_spacing_m: '0.3' });
    // An older edge: the gain only, as before.
    expect(draftWithCenter({}, '145.5', reported)).toEqual({ center_frequency_hz: '145.5', vfo0_frequency_hz: '145.5', gain_db: '25.4' });
    expect(draftWithBand({ gain_db: '20.7' }, 1_200_000_000, true)).toEqual({ gain_db: '20.7' });
  });

  it('explains the engine band refusal with the band spacing, and names it in the codes', () => {
    const ack = { status: 'FAILED', error: 'SPACING_SET_BY_ENGINE_BAND', reason: null, revision: 42, bandSpacingM: 0.3 };
    const view = commandResultView({ state: 'acked', pubackReason: null, ack }, 1, 42, 15);
    expect(view).toMatchObject({
      tone: 'err', body: { key: 'control.result.spacingSetByBand', vars: { spacing: '0.3' } },
      code: 'FAILED · SPACING_SET_BY_ENGINE_BAND · band_spacing_m 0.3',
    });
    const en = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) => translate('en', key, vars);
    expect(en(view.body.key, view.body.vars)).toBe('In this band the KrakenSDR engine sets the UCA spacing itself: 0.3 m. Nothing was written.');
    expect(translate('id', view.body.key, view.body.vars)).toContain('0.3 m');
    // Without band_spacing_m the general message names both bands.
    const plain = commandResultView({ state: 'acked', pubackReason: null, ack: { ...ack, bandSpacingM: null } }, 1, 42, 15);
    expect(plain).toMatchObject({ body: { key: 'control.edge.SPACING_SET_BY_ENGINE_BAND' }, code: 'FAILED · SPACING_SET_BY_ENGINE_BAND' });
    expect(edgeErrorKey('SPACING_SET_BY_ENGINE_BAND')).toBe('control.edge.SPACING_SET_BY_ENGINE_BAND');
    expect(bandSpacingText(en, ack)).toBeNull();
  });

  it('says when the edge wrote the band spacing with another change', () => {
    const en = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) => translate('en', key, vars);
    const ack = { status: 'APPLIED', error: null, reason: null, revision: 43, method: 'LIVE', bandSpacingM: 0.128 };
    expect(bandSpacingText(en, ack)).toBe('The RDF-SDR also set the UCA spacing to 0.128 m, the value its engine uses in this band.');
    expect(commandResultView({ state: 'acked', pubackReason: null, ack }, 1, 42, 15).code).toBe('APPLIED · LIVE · band_spacing_m 0.128');
    expect(bandSpacingText(en, { ...ack, bandSpacingM: null })).toBeNull();
    expect(bandSpacingText(en, null)).toBeNull();
  });
});

describe('Kontrol error codes', () => {
  it('have an EN and ID message for every backend code', () => {
    for (const code of CONFIG_PATCH_ERROR_CODES) {
      const key = CONFIG_PATCH_ERROR_KEYS[code];
      expect(key).toBe(`control.error.${code}`);
      expect(DICTIONARIES.en[key], code).toBeTruthy();
      expect(DICTIONARIES.id[key], code).toBeTruthy();
    }
    const keys = Object.keys(DICTIONARIES.en).filter((key) => key.startsWith('control.error.') && key !== 'control.error.unknown');
    expect(keys.map((key) => key.slice('control.error.'.length)).sort()).toEqual([...CONFIG_PATCH_ERROR_CODES].sort());
  });

  it('give the edge codes an operator can act on a message in both languages', () => {
    for (const [code, key] of Object.entries(EDGE_ERROR_KEYS)) {
      expect(DICTIONARIES.en[key], code).toBeTruthy();
      expect(DICTIONARIES.id[key], code).toBeTruthy();
    }
    for (const key of Object.keys(DICTIONARIES.en).filter((entry) => entry.startsWith('control.edge.'))) {
      expect(Object.values(EDGE_ERROR_KEYS), key).toContain(key);
    }
    expect(edgeErrorKey('TLS_REQUIRED_FOR_SETTINGS_REPORT')).toBe('control.edge.TLS_REQUIRED_FOR_SETTINGS_REPORT');
    expect(edgeErrorKey('SOMETHING_NEW')).toBeNull();
    expect(edgeErrorKey('constructor')).toBeNull();
    expect(edgeErrorKey(null)).toBeNull();
  });
});

describe('commandResultView', () => {
  const status = (state: string, ack: CommandStatusLike['ack'] = null, pubackReason: number | null = null): CommandStatusLike => ({ state, ack, pubackReason });
  const ack = (overrides: Partial<NonNullable<CommandStatusLike['ack']>>) => ({ status: 'APPLIED', error: null, reason: null, revision: 43, ...overrides });

  it('reports APPLIED with the new revision as the only success', () => {
    const view = commandResultView(status('acked', ack({})), 2, 42, 15);
    expect(view).toEqual({ tone: 'ok', title: { key: 'control.result.title.applied' }, body: { key: 'control.result.applied', vars: { count: 2, rev: 43 } }, code: 'APPLIED', reload: true });
  });

  it('keeps PERSISTED_UNVERIFIED, OUTCOME_UNKNOWN and a missing final ACK apart from success and failure', () => {
    const persisted = commandResultView(status('acked', ack({ status: 'PERSISTED_UNVERIFIED', reason: 'NATIVE_RUNTIME_EVIDENCE_INCOMPLETE' })), 2, 42, 15);
    expect(persisted).toEqual({
      tone: 'info',
      title: { key: 'control.result.title.persisted' },
      body: { key: 'control.result.persistedUnverified', vars: { rev: 43 } },
      code: 'PERSISTED_UNVERIFIED · NATIVE_RUNTIME_EVIDENCE_INCOMPLETE',
      reload: true,
    });
    const unknown = commandResultView(status('acked', ack({ status: 'OUTCOME_UNKNOWN', error: 'HELPER_CLOSED', revision: null })), 1, 42, 15);
    expect(unknown).toMatchObject({ tone: 'info', title: { key: 'control.result.title.unknown' }, body: { key: 'control.result.outcomeUnknown' }, code: 'OUTCOME_UNKNOWN · HELPER_CLOSED', reload: true });
    const lost = commandResultView(status('no_final_ack', ack({ status: 'ACCEPTED', revision: null })), 1, 42, 15);
    expect(lost).toEqual({ tone: 'info', title: { key: 'control.result.noFinalAckTitle' }, body: { key: 'control.result.noFinalAck', vars: { status: 'ACCEPTED' } }, code: 'ACCEPTED', reload: true });
  });

  it('explains a stale base revision and asks to read the values again', () => {
    for (const conflict of [ack({ status: 'REJECTED', error: 'CONFIG_REVISION_CONFLICT' }), ack({ status: 'CONFLICT' })]) {
      const view = commandResultView(status('acked', conflict), 1, 42, 15);
      expect(view.tone).toBe('warn');
      expect(view.title).toEqual({ key: 'control.result.title.conflict' });
      expect(view.code).toBe(`${conflict.status} · CONFIG_REVISION_CONFLICT`);
      expect(view.body).toEqual({ key: 'control.result.conflict', vars: { rev: 42 } });
      expect(view.reload).toBe(true);
      // The same change can be reviewed again on the new revision.
      expect(view.rebase).toBe(true);
    }
  });

  it('shows the edge code of rejections, expiries, cancels and failures', () => {
    expect(commandResultView(status('acked', ack({ status: 'REJECTED', error: 'BUSY' })), 1, 42, 15)).toMatchObject({
      tone: 'warn', title: { key: 'control.result.title.rejected' }, body: { key: 'control.edge.BUSY' }, code: 'REJECTED · BUSY', reload: false,
    });
    expect(commandResultView(status('acked', ack({ status: 'REJECTED', error: 'NEW_EDGE_CODE' })), 1, 42, 15).body).toEqual({ key: 'control.result.rejected' });
    expect(commandResultView(status('acked', ack({ status: 'EXPIRED', error: 'EXPIRED_OR_INVALID_DEADLINE' })), 1, 42, 15)).toMatchObject({
      tone: 'warn', title: { key: 'control.result.title.expired' }, code: 'EXPIRED · EXPIRED_OR_INVALID_DEADLINE', body: { key: 'control.result.expired' },
    });
    expect(commandResultView(status('acked', ack({ status: 'CANCELLED' })), 1, 42, 15)).toMatchObject({ tone: 'warn', body: { key: 'control.result.cancelled' } });
    expect(commandResultView(status('acked', ack({ status: 'FAILED', error: 'GAIN_NOT_IN_APPROVED_TABLE' })), 1, 42, 15)).toMatchObject({
      tone: 'err', title: { key: 'control.result.title.failed' }, code: 'FAILED · GAIN_NOT_IN_APPROVED_TABLE', body: { key: 'control.error.GAIN_NOT_IN_APPROVED_TABLE' }, reload: true,
    });
    expect(commandResultView(status('acked', ack({ status: 'FAILED', error: 'APPLY_FAULT' })), 1, 42, 15).body).toEqual({ key: 'control.result.failed' });
  });

  it('names the settings helper as the likely cause of an exception code', () => {
    for (const code of ['OSERROR', 'FILENOTFOUNDERROR', 'PERMISSIONERROR', 'TIMEOUTEXPIRED']) {
      expect(edgeHelperFault(code)).toBe(true);
      const unknown = commandResultView(status('acked', ack({ status: 'OUTCOME_UNKNOWN', error: code, revision: null })), 1, 42, 15);
      expect(unknown).toMatchObject({ tone: 'info', title: { key: 'control.result.title.unknown' }, body: { key: 'control.result.outcomeUnknownHelper', vars: { code } }, code: `OUTCOME_UNKNOWN · ${code}` });
      const failed = commandResultView(status('acked', ack({ status: 'FAILED', error: code })), 1, 42, 15);
      expect(failed).toMatchObject({ tone: 'err', body: { key: 'control.result.failedHelper', vars: { code } }, code: `FAILED · ${code}` });
    }
    for (const code of ['BUSY', 'CONFIG_REVISION_CONFLICT', 'ERRORS', null]) expect(edgeHelperFault(code)).toBe(false);
    // A link that dropped while applying is named too.
    expect(commandResultView(status('acked', ack({ status: 'OUTCOME_UNKNOWN', reason: 'CONNECTION_LOST', revision: null })), 1, 42, 15).body)
      .toEqual({ key: 'control.result.outcomeUnknownLink', vars: { code: 'CONNECTION_LOST' } });
    // An unknown final status is not a success and shows its code.
    expect(commandResultView(status('acked', ack({ status: 'SOMETHING_NEW' })), 1, 42, 15)).toMatchObject({ tone: 'info', code: 'SOMETHING_NEW' });
  });

  it('keeps the plain code line of an edge before contract 1.7', () => {
    expect(commandResultView(status('acked', ack({ method: null, liveFailure: null })), 1, 42, 15).code).toBe('APPLIED');
  });

  it('names the method, the reason and the proof of a contract 1.7 answer', () => {
    // The final ACK of 105.9 -> 103.1 MHz over Telemetry LoRa on 2 November.
    const applied = ack({ method: 'RESTART', reason: 'LIVE_FAILED:ENGINE_OVERRODE:gain_db', revision: 298,
      proof: { daq: 'FRESH_HEALTHY_AFTER_RESTART', settings: 'INTACT_AFTER_START' } });
    const view = commandResultView(status('acked', applied), 2, 297, 15);
    expect(view).toMatchObject({ tone: 'ok', body: { key: 'control.result.applied', vars: { count: 2, rev: 298 } } });
    expect(view.code).toBe('APPLIED · RESTART · LIVE_FAILED:ENGINE_OVERRODE:gain_db · daq FRESH_HEALTHY_AFTER_RESTART · settings INTACT_AFTER_START');
    const persisted = commandResultView(status('acked', ack({ status: 'PERSISTED_UNVERIFIED', method: 'LIVE',
      reason: 'NATIVE_RUNTIME_EVIDENCE_INCOMPLETE', liveFailure: 'DAQ_NOT_HEALTHY_AFTER_RETUNE' })), 1, 42, 15);
    expect(persisted).toMatchObject({ tone: 'info', body: { key: 'control.result.persistedUnverified' },
      code: 'PERSISTED_UNVERIFIED · LIVE · NATIVE_RUNTIME_EVIDENCE_INCOMPLETE · live DAQ_NOT_HEALTHY_AFTER_RETUNE' });
    expect(commandResultView(status('acked', ack({ status: 'PERSISTED_UNVERIFIED', method: 'FILE', reason: 'ENGINE_NOT_RUNNING' })), 1, 42, 15))
      .toMatchObject({ tone: 'info', body: { key: 'control.result.persistedEngineStopped', vars: { rev: 43 } } });
    expect(commandResultView(status('acked', ack({ status: 'PERSISTED_UNVERIFIED', method: 'RESTART', reason: 'GAIN_CHANGE', error: 'ENGINE_OVERRODE_AT_START' })), 1, 42, 15).body.key)
      .toBe('control.result.persistedEngineOverrode');
    for (const [error, key] of [['ENGINE_DID_NOT_STOP', 'control.result.outcomeEngineDidNotStop'], ['DAQ_NOT_HEALTHY_AFTER_RESTART', 'control.result.outcomeDaqAfterRestart']] as const) {
      expect(commandResultView(status('acked', ack({ status: 'OUTCOME_UNKNOWN', method: 'RESTART', reason: 'GAIN_CHANGE', error })), 1, 42, 15))
        .toMatchObject({ tone: 'info', body: { key }, code: `OUTCOME_UNKNOWN · RESTART · ${error}` });
    }
  });

  it('says which step the edge is on and how it applied the change', () => {
    const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars);
    const id = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('id', key, vars);
    expect(commandStageText(en, ack({ status: 'ACCEPTED' }))).toBeNull();
    expect(commandStageText(en, ack({ status: 'VERIFYING' }))).toBeNull();
    expect(commandStageText(en, ack({ status: 'VERIFYING', method: 'LIVE' }))).toBe('RDF-SDR is retuning live and checking the DAQ…');
    expect(commandStageText(id, ack({ status: 'APPLYING', method: 'RESTART', reason: 'LIVE_FAILED:ENGINE_OVERRODE:gain_db' })))
      .toBe('RDF-SDR me-restart SDR untuk menerapkan perubahan (engine SDR mengubah Gain saat retune langsung)…');
    expect(commandStageText(en, ack({ status: 'VERIFYING', method: 'RESTART', reason: 'GAIN_CHANGE' })))
      .toBe('RDF-SDR is restarting the SDR to apply the change (a gain change needs a restart)…');
    expect(commandStageText(en, ack({ status: 'APPLIED', method: 'RESTART' }))).toBeNull();
    expect(appliedMethodText(en, ack({ method: 'LIVE' }))).toBe('Applied by a live retune.');
    expect(appliedMethodText(id, ack({ method: 'RESTART', reason: 'LARGE_FREQUENCY_JUMP' })))
      .toBe('Diterapkan dengan restart SDR (frekuensi bergeser lebih jauh dari batas retune langsung).');
    expect(appliedMethodText(en, ack({ method: 'RESTART' }))).toBe('Applied by restarting the SDR.');
    expect(appliedMethodText(en, ack({}))).toBeNull();
    expect(appliedMethodText(en, ack({ status: 'PERSISTED_UNVERIFIED', method: 'LIVE' }))).toBeNull();
    // A field the console does not know and a reason it has no words for are shown as the edge sent them.
    expect(restartReasonText(en, 'LIVE_FAILED:ENGINE_OVERRODE:vfo1_frequency_hz')).toBe('the SDR engine changed vfo1_frequency_hz on the live retune');
    expect(restartReasonText(en, 'LIVE_FAILED:DAQ_NOT_HEALTHY_AFTER_RETUNE')).toBe('the DAQ was not healthy after the live retune');
    expect(restartReasonText(en, 'SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(restartReasonText(en, null)).toBeNull();
  });

  it('has its own messages for no ACK and a refused publish', () => {
    expect(commandResultView(status('no_ack'), 1, 42, 15)).toMatchObject({ tone: 'err', title: { key: 'control.result.noAckTitle' }, body: { key: 'control.result.noAck', vars: { ttl: 15 } } });
    expect(commandResultView(status('publish_failed', null, 135), 1, 42, 15)).toMatchObject({ tone: 'err', body: { key: 'control.result.publishFailed', vars: { reason: 135 } } });
  });
});

describe('settingsReadView', () => {
  const status = (state: string, ack: CommandStatusLike['ack'] = null, pubackReason: number | null = null): CommandStatusLike => ({ state, ack, pubackReason });

  it('says what happened to the latest config.get', () => {
    expect(settingsReadView(null)).toBeNull();
    for (const state of ['published', 'delivered', 'acknowledged']) {
      expect(settingsReadView(status(state))).toEqual({ tone: 'info', code: null, key: 'control.settings.reading' });
    }
    expect(settingsReadView(status('reported'))).toBeNull();
    expect(settingsReadView(status('acked', { status: 'REJECTED', error: 'TLS_REQUIRED_FOR_SETTINGS_REPORT', reason: null, revision: 3 }))).toEqual({
      tone: 'warn', code: 'TLS_REQUIRED_FOR_SETTINGS_REPORT', key: 'control.edge.TLS_REQUIRED_FOR_SETTINGS_REPORT',
    });
    expect(settingsReadView(status('acked', { status: 'REJECTED', error: 'SOMETHING', reason: null, revision: null }))).toEqual({
      tone: 'warn', code: 'SOMETHING', key: 'control.settings.refused',
    });
    expect(settingsReadView(status('no_ack'))).toEqual({ tone: 'warn', code: 'NO ACK', key: 'control.settings.noAck' });
    expect(settingsReadView(status('no_report'))).toEqual({ tone: 'warn', code: 'NO REPORT', key: 'control.settings.noReport' });
    expect(settingsReadView(status('publish_failed', null, 135))).toEqual({ tone: 'err', code: 'PUBACK 135', key: 'control.settings.publishFailed' });
  });
});
