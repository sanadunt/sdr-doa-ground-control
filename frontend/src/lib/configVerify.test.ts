import { describe, expect, it } from 'vitest';
import type { TelemetrySnapshot } from '../types';
import { CONFIG_PATCH_KEYS } from './controlDraft';
import type { ConfigPatchKey } from './controlDraft';
import { VERIFY_WINDOW_MS, currentConfigValues, dataOutConfigValues, settingsReadAfter, verifyConfigPatch } from './configVerify';
import type { VerifyInput } from './configVerify';

const ISSUED = 1_000_000;
const FINAL = 50_000;

function snapshot(fields: Record<string, unknown>, extra: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return { settings: { available: true, redacted: true, fields, raw_fields_omitted: true }, ...extra };
}

type Values = Partial<Record<ConfigPatchKey, number | null>>;

function reported(values: Values, receivedAt: Values) {
  const full = {} as Record<ConfigPatchKey, number | null>;
  const at = {} as Record<ConfigPatchKey, number | null>;
  for (const key of CONFIG_PATCH_KEYS) {
    full[key] = values[key] ?? null;
    at[key] = receivedAt[key] ?? null;
  }
  return { values: full, valueReceivedAtMs: at };
}

function verify(overrides: Partial<VerifyInput>) {
  return verifyConfigPatch({
    changes: { center_frequency_hz: 433_920_000 },
    issuedAtMs: ISSUED,
    finalAtMs: FINAL,
    nowMs: FINAL + 1_000,
    reported: null,
    snapshot: null,
    snapshotFresh: true,
    ...overrides,
  });
}

describe('dataOutConfigValues', () => {
  it('converts settings.json units to SI', () => {
    const values = dataOutConfigValues(snapshot({ center_freq: 433.92, uniform_gain: 15.7, vfo_freq_0: 433_925_000, vfo_bw_0: 12_500, vfo_squelch_0: -80 }), true);
    expect(values).toEqual({ center_frequency_hz: 433_920_000, gain_db: 15.7, vfo0_frequency_hz: 433_925_000, vfo0_bandwidth_hz: 12_500, vfo0_squelch_db: -80 });
  });

  it('ignores stale, synthetic, unavailable and non-numeric settings', () => {
    const fields = { center_freq: 433.92, uniform_gain: '15.7', vfo_bw_0: Number.NaN, vfo_squelch_0: true };
    expect(dataOutConfigValues(snapshot(fields), false).center_frequency_hz).toBeNull();
    expect(dataOutConfigValues(snapshot(fields, { simulation: true }), true).center_frequency_hz).toBeNull();
    expect(dataOutConfigValues({ settings: { available: false, fields } }, true).center_frequency_hz).toBeNull();
    expect(dataOutConfigValues(null, true).center_frequency_hz).toBeNull();
    const values = dataOutConfigValues(snapshot(fields), true);
    expect(values.center_frequency_hz).toBe(433_920_000);
    expect(values.gain_db).toBeNull();
    expect(values.vfo0_bandwidth_hz).toBeNull();
    expect(values.vfo0_squelch_db).toBeNull();
  });
});

describe('currentConfigValues', () => {
  it('prefers settings/reported and fills what it does not carry from Data Out', () => {
    const dataOut = dataOutConfigValues(snapshot({ center_freq: 415.7882, uniform_gain: 15.7, vfo_freq_0: 415_788_200, vfo_bw_0: 12_500, vfo_squelch_0: -80 }), true);
    const values = currentConfigValues({ center_frequency_hz: 416_588_000, gain_db: 15.5, vfo0_frequency_hz: null, vfo0_bandwidth_hz: null, vfo0_squelch_db: null }, dataOut);
    expect(values).toEqual({ center_frequency_hz: 416_588_000, gain_db: 15.5, vfo0_frequency_hz: 415_788_200, vfo0_bandwidth_hz: 12_500, vfo0_squelch_db: -80 });
    expect(currentConfigValues(null, dataOut).center_frequency_hz).toBe(415_788_200);
  });
});

describe('verifyConfigPatch', () => {
  it('confirms from fresh Data Out within the MHz rounding tolerance', () => {
    const result = verify({
      changes: { center_frequency_hz: 433_920_400, gain_db: 20, vfo0_frequency_hz: 433_925_000, vfo0_bandwidth_hz: 12_500, vfo0_squelch_db: -70 },
      snapshot: snapshot({ center_freq: 433.92, uniform_gain: 20.04, vfo_freq_0: 433_925_499, vfo_bw_0: 12_501, vfo_squelch_0: -70.05 }),
    });
    expect(result.fields.map((field) => field.status)).toEqual(['confirmed', 'confirmed', 'confirmed', 'confirmed', 'confirmed']);
    expect(result.fields.every((field) => field.basis === 'data-out')).toBe(true);
    expect(result.fields[0]).toMatchObject({ key: 'center_frequency_hz', sent: 433_920_400, dataOut: 433_920_000, mqtt: null });
    expect(result).toMatchObject({ verdict: 'confirmed', confirmed: 5, total: 5, windowEndsAtMs: FINAL + VERIFY_WINDOW_MS });
  });

  it('keeps a field pending outside the tolerance, then reports it unchanged', () => {
    const changes = { center_frequency_hz: 433_920_000, gain_db: 20, vfo0_bandwidth_hz: 12_500, vfo0_squelch_db: -70 };
    const node = snapshot({ center_freq: 433.9206, uniform_gain: 20.06, vfo_bw_0: 12_502, vfo_squelch_0: -70.1 });
    const during = verify({ changes, snapshot: node });
    expect(during.fields.map((field) => field.status)).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(during.verdict).toBe('pending');
    const after = verify({ changes, snapshot: node, nowMs: FINAL + VERIFY_WINDOW_MS });
    expect(after.fields.map((field) => field.status)).toEqual(['unchanged', 'unchanged', 'unchanged', 'unchanged']);
    expect(after).toMatchObject({ verdict: 'unchanged', confirmed: 0, total: 4 });
  });

  it('uses settings/reported only for a report received after the command was issued', () => {
    const changes = { vfo0_frequency_hz: 433_925_000 };
    const before = verify({ changes, reported: reported({ vfo0_frequency_hz: 433_925_000 }, { vfo0_frequency_hz: ISSUED - 1 }) });
    expect(before.fields[0]).toMatchObject({ mqtt: null, basis: null, status: 'pending' });
    const sameMs = verify({ changes, reported: reported({ vfo0_frequency_hz: 433_925_000 }, { vfo0_frequency_hz: ISSUED }) });
    expect(sameMs.fields[0].mqtt).toBeNull();
    const unknownTime = verify({ changes, reported: reported({ vfo0_frequency_hz: 433_925_000 }, {}) });
    expect(unknownTime.fields[0].mqtt).toBeNull();
    const noIssue = verify({ changes, issuedAtMs: null, reported: reported({ vfo0_frequency_hz: 433_925_000 }, { vfo0_frequency_hz: ISSUED + 5 }) });
    expect(noIssue.fields[0].mqtt).toBeNull();
    const after = verify({ changes, reported: reported({ vfo0_frequency_hz: 433_925_000 }, { vfo0_frequency_hz: ISSUED + 1 }) });
    expect(after.fields[0]).toMatchObject({ mqtt: 433_925_000, basis: 'mqtt', status: 'confirmed' });
    expect(after.verdict).toBe('confirmed');
    // A report from before the command never settles the field.
    const expired = verify({ changes, nowMs: FINAL + VERIFY_WINDOW_MS, reported: reported({ vfo0_frequency_hz: 433_925_000 }, { vfo0_frequency_hz: ISSUED - 1 }) });
    expect(expired.fields[0].status).toBe('not-reported');
  });

  it('lets a settings report received after the command decide over Data Out', () => {
    const changes = { center_frequency_hz: 433_920_000 };
    const mqtt = reported({ center_frequency_hz: 433_920_000 }, { center_frequency_hz: ISSUED + 10 });
    const result = verify({ changes, reported: mqtt, snapshot: snapshot({ center_freq: 415.7882 }) });
    expect(result.fields[0]).toMatchObject({ dataOut: 415_788_200, mqtt: 433_920_000, basis: 'mqtt', status: 'confirmed' });
    const old = reported({ center_frequency_hz: 415_788_200 }, { center_frequency_hz: ISSUED + 10 });
    expect(verify({ changes, reported: old, snapshot: snapshot({ center_freq: 433.92 }) }).fields[0]).toMatchObject({ basis: 'mqtt', status: 'pending' });
    // Without a report after the command, fresh Data Out decides.
    const before = reported({ center_frequency_hz: 415_788_200 }, { center_frequency_hz: ISSUED - 10 });
    expect(verify({ changes, reported: before, snapshot: snapshot({ center_freq: 433.92 }) }).fields[0]).toMatchObject({ mqtt: null, basis: 'data-out', status: 'confirmed' });
    // A stale snapshot is not evidence either.
    const stale = verify({ changes, reported: null, snapshot: snapshot({ center_freq: 433.92 }), snapshotFresh: false });
    expect(stale.fields[0]).toMatchObject({ dataOut: null, basis: null, status: 'pending' });
  });

  it('ignores a stale snapshot but waits for it while the window is open', () => {
    const node = snapshot({ center_freq: 433.92 });
    const during = verify({ snapshot: node, snapshotFresh: false });
    expect(during.fields[0]).toMatchObject({ dataOut: null, basis: null, status: 'pending' });
    const after = verify({ snapshot: node, snapshotFresh: false, nowMs: FINAL + VERIFY_WINDOW_MS + 1 });
    expect(after.fields[0].status).toBe('not-reported');
    expect(after.verdict).toBe('not-reported');
  });

  // #13: the console reuses settings.json for up to 30 s between reads.
  it('takes no evidence from settings.json read before the command was issued', () => {
    const before = snapshot({ center_freq: 415.7882 }, { settings: { available: true, fields: { center_freq: 415.7882 }, reused: true, read_at_ms: ISSUED - 5_000 } });
    const during = verify({ snapshot: before });
    expect(during.fields[0]).toMatchObject({ dataOut: null, basis: null, status: 'pending' });
    const mqtt = reported({ center_frequency_hz: 433_920_000 }, { center_frequency_hz: ISSUED + 10 });
    expect(verify({ snapshot: before, reported: mqtt }).fields[0]).toMatchObject({ dataOut: null, basis: 'mqtt', status: 'confirmed' });
    expect(verify({ snapshot: before, nowMs: FINAL + VERIFY_WINDOW_MS + 1 }).fields[0].status).toBe('not-reported');
    const after = snapshot({}, { settings: { available: true, fields: { center_freq: 433.92 }, read_at_ms: ISSUED + 2_000 } });
    expect(verify({ snapshot: after }).fields[0]).toMatchObject({ dataOut: 433_920_000, basis: 'data-out', status: 'confirmed' });
    expect(settingsReadAfter(before, ISSUED)).toBe(false);
    expect(settingsReadAfter(after, ISSUED)).toBe(true);
    // An older console that does not say when settings.json was read: as before.
    expect(settingsReadAfter(snapshot({ center_freq: 433.92 }), ISSUED)).toBe(true);
    expect(settingsReadAfter(before, null)).toBe(true);
  });

  it('ignores a synthetic snapshot', () => {
    const result = verify({ snapshot: snapshot({ center_freq: 433.92 }, { simulation: true }) });
    expect(result.fields[0]).toMatchObject({ dataOut: null, status: 'not-reported' });
  });

  it('reports a field no source carries as not reported', () => {
    const result = verify({ changes: { center_frequency_hz: 433_920_000, vfo0_squelch_db: -70 }, snapshot: snapshot({ center_freq: 433.92 }) });
    expect(result.fields.map((field) => [field.key, field.status])).toEqual([
      ['center_frequency_hz', 'confirmed'],
      ['vfo0_squelch_db', 'not-reported'],
    ]);
    expect(result).toMatchObject({ verdict: 'partial', confirmed: 1, total: 2 });
  });

  it('stays pending while any field is pending, and lists fields in contract order', () => {
    const result = verify({ changes: { vfo0_squelch_db: -70, center_frequency_hz: 433_920_000 }, snapshot: snapshot({ center_freq: 433.92, vfo_squelch_0: -80 }) });
    expect(result.fields.map((field) => field.key)).toEqual(['center_frequency_hz', 'vfo0_squelch_db']);
    expect(result).toMatchObject({ verdict: 'pending', confirmed: 1, total: 2 });
    const after = verify({ changes: { vfo0_squelch_db: -70, center_frequency_hz: 433_920_000 }, snapshot: snapshot({ center_freq: 433.92, vfo_squelch_0: -80 }), nowMs: FINAL + VERIFY_WINDOW_MS });
    expect(after).toMatchObject({ verdict: 'partial', confirmed: 1, total: 2 });
  });

  it('ends the window at the configured length after the final state', () => {
    const changes = { gain_db: 20 };
    const node = snapshot({ uniform_gain: 10 });
    expect(verify({ changes, snapshot: node, windowMs: 5_000, nowMs: FINAL + 4_999 }).fields[0].status).toBe('pending');
    expect(verify({ changes, snapshot: node, windowMs: 5_000, nowMs: FINAL + 5_000 }).fields[0].status).toBe('unchanged');
  });

  it('decides at once with a zero window, as after a refused patch', () => {
    const changes = { gain_db: 20 };
    expect(verify({ changes, snapshot: snapshot({ uniform_gain: 10 }), windowMs: 0, nowMs: FINAL }).verdict).toBe('unchanged');
    expect(verify({ changes, snapshot: snapshot({ uniform_gain: 20 }), windowMs: 0, nowMs: FINAL }).verdict).toBe('confirmed');
  });

  it('skips non-finite sent values', () => {
    const result = verify({ changes: { gain_db: Number.NaN } });
    expect(result).toMatchObject({ fields: [], total: 0, verdict: 'not-reported' });
  });
});
