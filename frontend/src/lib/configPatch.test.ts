import { describe, expect, it } from 'vitest';
import {
  CONFIG_PATCH_ERROR_CODES,
  CONFIG_PATCH_ERROR_KEYS,
  CONFIG_PATCH_FIELDS,
  commandResultView,
  displayValue,
  draftFromReported,
  fieldFor,
  inFieldRange,
  mergeIntoDraft,
  parseDraft,
  rangeParts,
} from './configPatch';
import type { CommandStatusLike } from './configPatch';
import { CONFIG_PATCH_KEYS } from './controlDraft';
import { DICTIONARIES } from './i18n';

const REPORTED = {
  center_frequency_hz: 416_588_000,
  gain_db: 15.5,
  vfo_frequency_hz: null,
  vfo_bandwidth_hz: null,
  vfo_squelch_db: null,
};

describe('config patch fields', () => {
  it('cover the allowlist in contract order with the sdr/v1 ranges', () => {
    expect(CONFIG_PATCH_FIELDS.map((field) => field.key)).toEqual([...CONFIG_PATCH_KEYS]);
    expect(CONFIG_PATCH_FIELDS.map((field) => [field.min, field.max])).toEqual([
      [24_000_000, 1_800_000_000], [-100, 60], [24_000_000, 1_800_000_000], [100, 2_400_000], [-200, 20],
    ]);
  });

  it('show frequencies in MHz and kHz', () => {
    expect(displayValue(fieldFor('center_frequency_hz'), 416_588_000)).toBe('416.588 MHz');
    expect(displayValue(fieldFor('center_frequency_hz'), 433_920_500)).toBe('433.9205 MHz');
    expect(displayValue(fieldFor('vfo_bandwidth_hz'), 12_500)).toBe('12.5 kHz');
    expect(displayValue(fieldFor('vfo_squelch_db'), -80)).toBe('−80 dB');
    expect(rangeParts(fieldFor('vfo_bandwidth_hz'), null)).toEqual({ min: '0.1', max: '2400', unit: 'kHz' });
    expect(rangeParts(fieldFor('gain_db'), { gain_db: [-10, 50] })).toEqual({ min: '−10', max: '50', unit: 'dB' });
  });

  it('prefer the server ranges', () => {
    expect(inFieldRange('center_frequency_hz', 2_000_000_000, null)).toBe(false);
    expect(inFieldRange('center_frequency_hz', 2_000_000_000, { center_frequency_hz: [24_000_000, 3_000_000_000] })).toBe(true);
    expect(inFieldRange('gain_db', Number.NaN)).toBe(false);
  });
});

describe('parseDraft', () => {
  const draft = draftFromReported(REPORTED);

  it('starts with no changes and leaves unreported fields empty', () => {
    expect(draft).toEqual({ center_frequency_hz: '416.588', gain_db: '15.5', vfo_frequency_hz: '', vfo_bandwidth_hz: '', vfo_squelch_db: '' });
    const result = parseDraft(CONFIG_PATCH_FIELDS, draft, REPORTED, null);
    expect(result.invalid).toBe(false);
    expect(result.changes).toEqual({});
  });

  it('converts display units to SI and keeps frequencies integer Hz', () => {
    const result = parseDraft(CONFIG_PATCH_FIELDS, { ...draft, center_frequency_hz: '433,9205', vfo_bandwidth_hz: '12.5', gain_db: '−3' }, REPORTED, null);
    expect(result.invalid).toBe(false);
    expect(result.changes).toEqual({ center_frequency_hz: 433_920_500, vfo_bandwidth_hz: 12_500, gain_db: -3 });
    expect(result.fields.find((field) => field.field.key === 'vfo_bandwidth_hz')?.reported).toBeNull();
  });

  it('flags empty reported fields, non-numbers and out-of-range values', () => {
    const result = parseDraft(CONFIG_PATCH_FIELDS, { ...draft, center_frequency_hz: '', gain_db: 'abc', vfo_squelch_db: '30' }, REPORTED, null);
    expect(result.invalid).toBe(true);
    expect(result.fields.map((field) => field.problem)).toEqual(['empty', 'number', null, null, 'range']);
    expect(result.changes).toEqual({});
  });

  it('treats a value equal to the reported one as unchanged', () => {
    const result = parseDraft(CONFIG_PATCH_FIELDS, { ...draft, center_frequency_hz: '416.5880' }, REPORTED, null);
    expect(result.changes).toEqual({});
  });

  it('merges a spectrum draft as display text', () => {
    const merged = mergeIntoDraft(draft, { center_frequency_hz: 433_920_000, vfo_frequency_hz: 433_925_000 });
    expect(merged.center_frequency_hz).toBe('433.92');
    expect(merged.vfo_frequency_hz).toBe('433.925');
    expect(parseDraft(CONFIG_PATCH_FIELDS, merged, REPORTED, null).changes).toEqual({ center_frequency_hz: 433_920_000, vfo_frequency_hz: 433_925_000 });
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
});

describe('commandResultView', () => {
  const status = (state: string, ack: CommandStatusLike['ack'] = null, pubackReason: number | null = null): CommandStatusLike => ({ state, ack, pubackReason });
  const ack = (overrides: Partial<NonNullable<CommandStatusLike['ack']>>) => ({ status: 'applied', configRev: 43, errorCode: null, currentConfigRev: null, changedFields: [], ...overrides });

  it('reports applied with the new revision', () => {
    const view = commandResultView(status('acked', ack({ changedFields: ['center_frequency_hz'] })), 2, 42, 60);
    expect(view).toEqual({ tone: 'ok', title: { key: 'control.result.ackTitle', vars: { status: 'applied' } }, body: { key: 'control.result.applied', vars: { count: 1, rev: 43 } }, reload: true });
  });

  it('asks for a reload on a revision conflict', () => {
    const view = commandResultView(status('acked', ack({ status: 'conflict', errorCode: 'CONFIG_REVISION_CONFLICT', currentConfigRev: 44 })), 1, 42, 60);
    expect(view.tone).toBe('warn');
    expect(view.title).toEqual({ key: 'control.result.rejectedTitle', vars: { code: 'CONFIG_REVISION_CONFLICT' } });
    expect(view.body).toEqual({ key: 'control.result.conflict', vars: { rev: 42 } });
    expect(view.reload).toBe(true);
  });

  it('names a disabled remote control', () => {
    for (const code of ['REMOTE_CONTROL_DISABLED', 'CONTROL_DISABLED']) {
      const view = commandResultView(status('acked', ack({ status: 'rejected', errorCode: code })), 1, 42, 60);
      expect(view.title).toEqual({ key: 'control.result.rejectedTitle', vars: { code } });
      expect(view.body.key).toBe('control.result.remoteDisabled');
    }
  });

  it('shows the code of other rejections, expiries and failures', () => {
    expect(commandResultView(status('acked', ack({ status: 'rejected', errorCode: 'FIELD_NOT_ALLOWED' })), 1, 42, 60).title).toEqual({ key: 'control.result.rejectedTitle', vars: { code: 'FIELD_NOT_ALLOWED' } });
    expect(commandResultView(status('acked', ack({ status: 'expired', errorCode: 'COMMAND_EXPIRED' })), 1, 42, 60)).toMatchObject({ tone: 'warn', body: { key: 'control.result.expired' } });
    expect(commandResultView(status('acked', ack({ status: 'failed', errorCode: 'APPLY_ERROR' })), 1, 42, 60)).toMatchObject({ tone: 'err', title: { vars: { status: 'failed · APPLY_ERROR' } } });
  });

  it('has its own messages for no ACK and a refused publish', () => {
    expect(commandResultView(status('no_ack'), 1, 42, 60)).toMatchObject({ tone: 'err', title: { key: 'control.result.noAckTitle' }, body: { key: 'control.result.noAck', vars: { ttl: 60 } } });
    expect(commandResultView(status('publish_failed', null, 135), 1, 42, 60)).toMatchObject({ tone: 'err', body: { key: 'control.result.publishFailed', vars: { reason: 135 } } });
  });
});
