import { describe, expect, it } from 'vitest';
import {
  CONFIG_PATCH_ERROR_CODES,
  CONFIG_PATCH_ERROR_KEYS,
  CONFIG_PATCH_FIELDS,
  EDGE_ERROR_KEYS,
  GAIN_TABLE_DB,
  commandResultView,
  displayValue,
  draftFromReported,
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
import { DICTIONARIES } from './i18n';

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
    expect(CONFIG_PATCH_FIELDS.map((field) => [field.min, field.max])).toEqual([
      [24_000_000, 1_766_000_000], [-10, 100], [24_000_000, 1_766_000_000], [100, 2_400_000], [-200, 50],
    ]);
    expect(CONFIG_PATCH_FIELDS.filter((field) => field.table).map((field) => field.key)).toEqual(['gain_db']);
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
  const draft = draftFromReported(REPORTED);

  it('starts with no changes and leaves unreported fields empty', () => {
    expect(draft).toEqual({ center_frequency_hz: '416.588', gain_db: '15.7', vfo0_frequency_hz: '', vfo0_bandwidth_hz: '', vfo0_squelch_db: '' });
    const result = parseDraft(CONFIG_PATCH_FIELDS, draft, REPORTED, null);
    expect(result.invalid).toBe(false);
    expect(result.changes).toEqual({});
  });

  it('converts display units to SI and keeps frequencies integer Hz', () => {
    const result = parseDraft(CONFIG_PATCH_FIELDS, { ...draft, vfo0_bandwidth_hz: '12.5', gain_db: '20,7', vfo0_squelch_db: '−70' }, REPORTED, null);
    expect(result.invalid).toBe(false);
    expect(result.changes).toEqual({ gain_db: 20.7, vfo0_bandwidth_hz: 12_500, vfo0_squelch_db: -70 });
    expect(result.fields.find((field) => field.field.key === 'vfo0_bandwidth_hz')?.reported).toBeNull();
  });

  it('flags empty reported fields, non-numbers, out-of-range values and gains off the table', () => {
    const result = parseDraft(CONFIG_PATCH_FIELDS, { ...draft, center_frequency_hz: '', gain_db: '20', vfo0_squelch_db: '60' }, REPORTED, null);
    expect(result.invalid).toBe(true);
    expect(result.fields.map((field) => field.problem)).toEqual(['empty', 'table', null, null, 'range']);
    expect(result.changes).toEqual({});
    expect(parseDraft(CONFIG_PATCH_FIELDS, { ...draft, gain_db: 'abc' }, REPORTED, null).fields[1].problem).toBe('number');
    // A server table replaces the client copy.
    expect(parseDraft(CONFIG_PATCH_FIELDS, { ...draft, gain_db: '20' }, REPORTED, null, [20]).changes).toEqual({ gain_db: 20 });
  });

  it('treats a value equal to the reported one as unchanged', () => {
    const result = parseDraft(CONFIG_PATCH_FIELDS, { ...draft, center_frequency_hz: '416.5880' }, REPORTED, null);
    expect(result.changes).toEqual({});
  });

  it('takes VFO0 along with a centre change, at the same frequency', () => {
    const reported = { ...REPORTED, vfo0_frequency_hz: 433_920_000 };
    const base = draftFromReported(reported);
    // The centre moves to where VFO0 already is: VFO0 is sent unchanged.
    const along = parseDraft(CONFIG_PATCH_FIELDS, { ...base, center_frequency_hz: '433.92' }, reported, null);
    expect(along.invalid).toBe(false);
    expect(along.changes).toEqual({ center_frequency_hz: 433_920_000, vfo0_frequency_hz: 433_920_000 });
    const vfo = along.fields.find((field) => field.field.key === 'vfo0_frequency_hz');
    expect([vfo?.changed, vfo?.required]).toEqual([true, true]);
    // Another frequency for VFO0 is refused, as the edge refuses it.
    const apart = parseDraft(CONFIG_PATCH_FIELDS, { ...base, center_frequency_hz: '434', vfo0_frequency_hz: '434.01' }, reported, null);
    expect(apart.invalid).toBe(true);
    expect(apart.fields.find((field) => field.field.key === 'vfo0_frequency_hz')?.problem).toBe('centerVfo');
    expect(apart.changes).toEqual({ center_frequency_hz: 434_000_000 });
    // VFO0 alone may move inside the band.
    expect(parseDraft(CONFIG_PATCH_FIELDS, { ...base, vfo0_frequency_hz: '433.95' }, reported, null).changes).toEqual({ vfo0_frequency_hz: 433_950_000 });
    // An unreported, empty VFO0 cannot go along.
    const empty = parseDraft(CONFIG_PATCH_FIELDS, { ...draft, center_frequency_hz: '434' }, REPORTED, null);
    expect(empty.fields.find((field) => field.field.key === 'vfo0_frequency_hz')?.problem).toBe('centerVfo');
  });

  it('lets VFO0 follow the typed centre, and return to its own value', () => {
    const reported = { ...REPORTED, vfo0_frequency_hz: 416_600_000 };
    const followed = draftWithCenter({}, '434.5', reported);
    expect(followed).toEqual({ center_frequency_hz: '434.5', vfo0_frequency_hz: '434.5' });
    const back = draftWithCenter(followed, '416.588', reported);
    expect(back).toEqual({ center_frequency_hz: '416.588' });
    const result = parseDraft(CONFIG_PATCH_FIELDS, { ...draftFromReported(reported), ...back }, reported, null);
    expect(result.changes).toEqual({});
  });

  it('merges a spectrum draft as display text', () => {
    const merged = mergeIntoDraft(draft, { center_frequency_hz: 433_925_000, vfo0_frequency_hz: 433_925_000 });
    expect(merged.center_frequency_hz).toBe('433.925');
    expect(merged.vfo0_frequency_hz).toBe('433.925');
    expect(parseDraft(CONFIG_PATCH_FIELDS, merged, REPORTED, null).changes).toEqual({ center_frequency_hz: 433_925_000, vfo0_frequency_hz: 433_925_000 });
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
