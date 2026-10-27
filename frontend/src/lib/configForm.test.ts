import { describe, expect, it } from 'vitest';
import { ApiError, normalizeCapabilities } from '../api';
import { activeSection, adminErrorKey, atPageBottom, coordinateText, gpsErrorField, gpsInputErrorKey, isLoopbackHost, mergeSavedConfigIntoDraft, normalizeConnectionDraft, parseDryRunChanges, patchKeyUnit, refreshIntervalOptions, refreshWarningKey, summarizeDryRun } from './configForm';
import { manualGpsOverrideFromInput } from './map';
import type { ConsoleConfig } from '../types';

const DRAFT = { base_url: 'http://127.0.0.1:8081', mqtt_host: '127.0.0.1', mqtt_port: '1883', refresh_seconds: 2 };

describe('connection draft normalization (AUD-41, AUD-106)', () => {
  it('normalizes the way the server does so the read-back matches', () => {
    const result = normalizeConnectionDraft({ ...DRAFT, base_url: '  http://127.0.0.1:8081/ ', mqtt_host: ' localhost ' });
    expect(result).toEqual({ ok: true, value: { base_url: 'http://127.0.0.1:8081', mqtt_host: 'localhost', mqtt_port: 1883, refresh_seconds: 2 } });
  });

  it('rejects a blank, fractional or out-of-range port instead of truncating it', () => {
    for (const port of ['', ' ', '0', '1883.9', '65536', '18e3', '-1', 'abc']) {
      expect(normalizeConnectionDraft({ ...DRAFT, mqtt_port: port }), port).toEqual({ ok: false, error: 'config.mqttPortInvalid' });
    }
    expect(normalizeConnectionDraft({ ...DRAFT, mqtt_port: ' 9001 ' })).toMatchObject({ ok: true, value: { mqtt_port: 9001 } });
  });

  it('requires a base URL and a listed refresh interval', () => {
    expect(normalizeConnectionDraft({ ...DRAFT, base_url: ' / ' })).toEqual({ ok: false, error: 'config.baseUrlRequired' });
    expect(normalizeConnectionDraft({ ...DRAFT, refresh_seconds: 3 })).toEqual({ ok: false, error: 'config.refreshInvalid' });
  });
});

describe('saved config reaching the form draft', () => {
  const saved = { base_url: 'http://doasdr.local:8081', mqtt_host: '10.90.0.1', mqtt_port: 9001, refresh_seconds: 2 };

  it('keeps unsaved edits when only the top-bar interval was saved', () => {
    const draft = { ...saved, base_url: 'http://192.168.100.100:8081', mqtt_host: '127.0.0.1' };
    const next = { ...saved, refresh_seconds: 5 };
    expect(mergeSavedConfigIntoDraft(draft, saved, next)).toEqual({ ...draft, refresh_seconds: 5 });
  });

  it('replaces every field whose saved value changed', () => {
    const draft: ConsoleConfig = { ...saved, base_url: 'http://192.168.100.100:8081' };
    const next: ConsoleConfig = { ...saved, base_url: 'http://127.0.0.1:8081', mqtt_port: 1883, mqtt_transport: 'tcp' };
    expect(mergeSavedConfigIntoDraft<ConsoleConfig>(draft, saved, next)).toEqual(next);
  });
});

describe('refresh intervals (AUD-24)', () => {
  it('offers 1 s and 2 s, preferring the server list and keeping the saved value', () => {
    expect(refreshIntervalOptions(null, 2)).toEqual([0, 1, 2, 5, 10, 30]);
    expect(refreshIntervalOptions([0, 1, 2, 5], 10)).toEqual([0, 1, 2, 5, 10]);
  });

  // The window counts from the data's age at the read, so 5 s already leaves a gap.
  it('warns for manual refresh and for intervals as long as the 5 s DoA window', () => {
    expect(refreshWarningKey(0)).toBe('config.refreshManualWarning');
    expect(refreshWarningKey(1)).toBeNull();
    expect(refreshWarningKey(2)).toBeNull();
    expect(refreshWarningKey(5)).toBe('config.refreshSlowWarning');
    expect(refreshWarningKey(10)).toBe('config.refreshSlowWarning');
  });

  it('normalizes /api/capabilities defensively', () => {
    expect(normalizeCapabilities({ refresh_intervals_s: [30, 0, 2, 2, 1, -1, 1.5, '5', 99999], admin_enabled: false })).toEqual({ refreshIntervalsS: [0, 1, 2, 30], adminEnabled: false, adminDefaultPassword: null, configPatch: null, access: null, lanAccess: null });
    expect(normalizeCapabilities('nope')).toEqual({ refreshIntervalsS: null, adminEnabled: null, adminDefaultPassword: null, configPatch: null, access: null, lanAccess: null });
  });

  it('reads the default-password flag and the config patch block without trusting its shape', () => {
    const capabilities = normalizeCapabilities({
      admin_enabled: true,
      admin_default_password: true,
      config_patch: {
        enabled: true,
        requires_admin: true,
        topic: 'sdr/v2/uav-01/cmd/config/patch',
        get_topic: 'sdr/v2/uav-01/cmd/config/get',
        ack_topic: 'sdr/v2/uav-01/ack/config',
        settings_topic: 'sdr/v2/uav-01/settings/reported',
        qos: 1,
        ttl_ms: 15000,
        ranges: { center_frequency_hz: [24000000, 1766000000], gain_db: [60, -100], vfo0_squelch_db: [-200, 'x'], vfo_squelch_db: [-200, 50], unknown_field: [0, 1] },
        gain_table_db: [0, 15.7, 'x', 49.6, 1e9],
      },
    });
    expect(capabilities.adminDefaultPassword).toBe(true);
    expect(capabilities.configPatch).toEqual({
      enabled: true,
      requiresAdmin: true,
      topic: 'sdr/v2/uav-01/cmd/config/patch',
      getTopic: 'sdr/v2/uav-01/cmd/config/get',
      ackTopic: 'sdr/v2/uav-01/ack/config',
      settingsTopic: 'sdr/v2/uav-01/settings/reported',
      qos: 1,
      ttlMs: 15000,
      ranges: { center_frequency_hz: [24000000, 1766000000] },
      gainTableDb: [0, 15.7, 49.6],
    });
    const hostile = normalizeCapabilities({ config_patch: { enabled: 'yes', requires_admin: 0, topic: 'sdr/#', get_topic: 'sdr/+/x', qos: 7, ttl_ms: 1e9, gain_table_db: 'all' } }).configPatch;
    expect(hostile).toEqual({ enabled: false, requiresAdmin: true, topic: null, getTopic: null, ackTopic: null, settingsTopic: null, qos: null, ttlMs: null, ranges: {}, gainTableDb: [] });
  });
});

describe('manual GPS messages (AUD-99)', () => {
  it('names the failed check and agrees with the map validator', () => {
    const cases: Array<[string, string, string | null]> = [
      ['', '106.8', 'config.gpsLatNumber'],
      ['91', '106.8', 'config.gpsLatRange'],
      ['-6.2', 'x', 'config.gpsLonNumber'],
      ['-6.2', '181', 'config.gpsLonRange'],
      ['0', '0', 'config.gpsZero'],
      ['-6.2', '106.8', null],
    ];
    for (const [lat, lon, key] of cases) {
      expect(gpsInputErrorKey(lat, lon), `${lat},${lon}`).toBe(key);
      expect(manualGpsOverrideFromInput(lat, lon).override === null, `${lat},${lon}`).toBe(key !== null);
    }
  });
});

describe('dry-run form (AUD-74)', () => {
  it('sends only filled numeric fields and names a non-numeric one', () => {
    const fields = [{ key: 'gain_db', label: 'config.field.gain' as const }, { key: 'vfo0_squelch_db', label: 'config.field.squelch' as const }];
    expect(parseDryRunChanges({ gain_db: '12.5', vfo0_squelch_db: '' }, fields)).toEqual({ ok: true, value: { gain_db: 12.5 } });
    expect(parseDryRunChanges({}, fields)).toEqual({ ok: false, error: 'config.dryRunEmpty' });
    expect(parseDryRunChanges({ gain_db: 'loud' }, fields)).toEqual({ ok: false, error: 'config.dryRunNotNumber', vars: { field: 'gain_db' } });
  });
});

describe('admin error codes (AUD-81)', () => {
  it('translates server codes instead of showing server text', () => {
    expect(adminErrorKey(new ApiError('admin login disabled: set SDR_DOA_ADMIN_PASSWORD', 503, 'ADMIN_DISABLED'))).toBe('config.adminDisabled');
    expect(adminErrorKey(new ApiError('admin password is incorrect', 401, 'ADMIN_PASSWORD_INVALID'))).toBe('config.adminPasswordInvalid');
    expect(adminErrorKey(new ApiError('admin authentication required', 401, null))).toBe('config.adminRequired');
    expect(adminErrorKey(new ApiError('too many failed logins', 429, 'ADMIN_LOGIN_THROTTLED'))).toBe('config.adminThrottled');
    expect(adminErrorKey(new ApiError('slow down', 429, null))).toBe('config.adminThrottled');
    expect(adminErrorKey(new ApiError('logo exceeds the 256 KiB limit', 400, null))).toBeNull();
    expect(adminErrorKey(new Error('network'))).toBeNull();
  });
});

describe('Configuration page helpers', () => {
  it('shows coordinates with at most 6 decimals', () => {
    expect(coordinateText(-6.932468839245536)).toBe('-6.932469');
    expect(coordinateText(107.66069405900005)).toBe('107.660694');
    expect(coordinateText(-6.5)).toBe('-6.5');
    expect(coordinateText(Number.NaN)).toBe('');
  });

  it('puts a manual GPS message under the field it names', () => {
    expect(gpsErrorField('config.gpsLatNumber')).toBe('lat');
    expect(gpsErrorField('config.gpsLatRange')).toBe('lat');
    expect(gpsErrorField('config.gpsLonNumber')).toBe('lon');
    expect(gpsErrorField('config.gpsLonRange')).toBe('lon');
    expect(gpsErrorField('config.gpsZero')).toBe('lat');
  });

  it('treats only this machine as loopback for the no-TLS warning', () => {
    for (const host of ['localhost', ' LOCALHOST ', '127.0.0.1', '127.10.0.254', '::1', '[::1]']) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ['', '10.90.0.1', '192.168.100.100', '127.0.0.256', '128.0.0.1', 'fe80::1', 'localhost.example']) expect(isLoopbackHost(host), host).toBe(false);
  });

  it('marks the section that reached the sticky index, preferring the one jumped to in a shared row', () => {
    const sections = [
      { id: 'connection', top: -400 },
      { id: 'navigation', top: -400 },
      { id: 'mqtt', top: 110 },
      { id: 'branding', top: 110 },
      { id: 'dry-run', top: 500 },
    ];
    expect(activeSection(sections, 120, false)).toBe('mqtt');
    expect(activeSection(sections, 120, false, 'branding')).toBe('branding');
    expect(activeSection(sections, 120, false, 'dry-run')).toBe('mqtt');
    expect(activeSection(sections.map((section) => ({ ...section, top: section.top + 1000 })), 120, false)).toBe('connection');
    expect(activeSection([], 120, false)).toBeNull();
  });

  it('marks the last section, or the one jumped to, at the bottom of the page', () => {
    const sections = [
      { id: 'connection', top: -900 },
      { id: 'mqtt', top: 110 },
      { id: 'branding', top: 110 },
      { id: 'dry-run', top: 420 },
    ];
    expect(activeSection(sections, 120, true)).toBe('dry-run');
    expect(activeSection(sections, 120, true, 'branding')).toBe('branding');
    expect(activeSection(sections, 120, true, 'connection')).toBe('dry-run');
  });

  it('counts the end of a scrolling page as its bottom, and a page that fits the viewport only after a jump', () => {
    expect(atPageBottom(900, 48, 948)).toBe(true);
    expect(atPageBottom(900, 47, 948)).toBe(true);
    expect(atPageBottom(900, 0, 948)).toBe(false);
    expect(atPageBottom(900, 0, 948, true)).toBe(false);
    // The two-column layout fits 1440 × 900: the index keeps the first section instead of jumping to Dry-run.
    expect(atPageBottom(900, 0, 900)).toBe(false);
    expect(atPageBottom(900, 0, 640)).toBe(false);
    // A section jumped to on a page that fits keeps its mark when the window is resized.
    expect(atPageBottom(900, 0, 900, true)).toBe(true);
    const fitting = [
      { id: 'connection', top: 120 },
      { id: 'mqtt', top: 400 },
      { id: 'navigation', top: 120 },
      { id: 'branding', top: 452 },
      { id: 'dry-run', top: 680 },
    ];
    expect(activeSection(fitting, 110, atPageBottom(900, 0, 900, false), null)).toBe('connection');
    for (const id of ['mqtt', 'navigation', 'branding', 'dry-run', 'connection']) {
      expect(activeSection(fitting, 110, atPageBottom(900, 0, 900, true), id)).toBe(id);
    }
  });

  it('summarizes a dry-run response and leaves malformed parts out', () => {
    expect(summarizeDryRun({
      ok: true,
      validation: 'passed',
      transport: 'none',
      topic: 'sdr/v2/uav-01/cmd/config/patch',
      command: { v: 2, op: 'config.patch', sid: '0a1b2c3d', base_rev: 12, issued_ms: 1000, expires_ms: 16000, changes: { center_frequency_hz: 433920000, gain_db: 12.5, bad: 'x', inf: Number.POSITIVE_INFINITY } },
    })).toEqual({
      validation: 'passed',
      transport: 'none',
      baseRev: 12,
      sid: '0a1b2c3d',
      topic: 'sdr/v2/uav-01/cmd/config/patch',
      changes: [{ key: 'center_frequency_hz', value: 433920000 }, { key: 'gain_db', value: 12.5 }],
      ttlMs: 15000,
    });
    // No node session yet: the preview has base_rev and sid null.
    expect(summarizeDryRun({ topic: 'sdr/#\n', command: { base_rev: null, sid: 'NOT-HEX', changes: {} } })).toEqual({ validation: null, transport: null, baseRev: null, sid: null, topic: null, changes: [], ttlMs: null });
    expect(summarizeDryRun({ command: 'x' })).toEqual({ validation: null, transport: null, baseRev: null, sid: null, topic: null, changes: [], ttlMs: null });
    expect(patchKeyUnit('vfo0_bandwidth_hz')).toBe('Hz');
    expect(patchKeyUnit('vfo0_squelch_db')).toBe('dB');
    expect(patchKeyUnit('other')).toBe('');
  });
});
