import { describe, expect, it } from 'vitest';
import { ApiError, normalizeCapabilities } from '../api';
import { adminErrorKey, gpsInputErrorKey, normalizeConnectionDraft, parseBaseRevision, parseDryRunChanges, refreshIntervalOptions, refreshWarningKey } from './configForm';
import { manualGpsOverrideFromInput } from './map';

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
    expect(normalizeCapabilities({ refresh_intervals_s: [30, 0, 2, 2, 1, -1, 1.5, '5', 99999], admin_enabled: false })).toEqual({ refreshIntervalsS: [0, 1, 2, 30], adminEnabled: false });
    expect(normalizeCapabilities('nope')).toEqual({ refreshIntervalsS: null, adminEnabled: null });
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
  it('requires a non-negative integer base revision', () => {
    expect(parseBaseRevision('')).toEqual({ ok: false, error: 'config.baseRevisionRequired' });
    expect(parseBaseRevision('-1')).toEqual({ ok: false, error: 'config.baseRevisionInvalid' });
    expect(parseBaseRevision('1.5')).toEqual({ ok: false, error: 'config.baseRevisionInvalid' });
    expect(parseBaseRevision(' 42 ')).toEqual({ ok: true, value: 42 });
  });

  it('sends only filled numeric fields and names a non-numeric one', () => {
    const fields = [{ key: 'gain_db', label: 'config.field.gain' as const }, { key: 'vfo_squelch_db', label: 'config.field.squelch' as const }];
    expect(parseDryRunChanges({ gain_db: '12.5', vfo_squelch_db: '' }, fields)).toEqual({ ok: true, value: { gain_db: 12.5 } });
    expect(parseDryRunChanges({}, fields)).toEqual({ ok: false, error: 'config.dryRunEmpty' });
    expect(parseDryRunChanges({ gain_db: 'loud' }, fields)).toEqual({ ok: false, error: 'config.dryRunNotNumber', vars: { field: 'gain_db' } });
  });
});

describe('admin error codes (AUD-81)', () => {
  it('translates server codes instead of showing server text', () => {
    expect(adminErrorKey(new ApiError('admin login disabled: set SDR_DOA_ADMIN_PASSWORD', 503, 'ADMIN_DISABLED'))).toBe('config.adminDisabled');
    expect(adminErrorKey(new ApiError('admin password is incorrect', 401, 'ADMIN_PASSWORD_INVALID'))).toBe('config.adminPasswordInvalid');
    expect(adminErrorKey(new ApiError('admin authentication required', 401, null))).toBe('config.adminRequired');
    expect(adminErrorKey(new ApiError('logo exceeds the 256 KiB limit', 400, null))).toBeNull();
    expect(adminErrorKey(new Error('network'))).toBeNull();
  });
});
