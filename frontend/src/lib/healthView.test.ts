import { describe, expect, it } from 'vitest';
import type { TelemetrySnapshot } from '../types';
import { DICTIONARIES, gateReasonLabel, translate } from './i18n';
import {
  collectorErrorText,
  consistencyView,
  csvRowsView,
  dataOutHttp,
  durationParts,
  evidenceExpired,
  formatAgeText,
  formatCount,
  formatDuration,
  gateCheckKey,
  gateCheckRows,
  healthHeadline,
  isSecretSettingKey,
  nodeProgressView,
  nodeStatus,
  resourceRows,
  settingUnit,
  settingValueText,
  signalQualityView,
  stateTone,
  syncFlagsView,
} from './healthView';

const PATHS = ['/status.json', '/settings.json', '/DOA_value.html', '/doa.xml'];

function resources(overrides: Record<string, Record<string, unknown>> = {}): Record<string, Record<string, unknown>> {
  return Object.fromEntries(PATHS.map((path) => [path, { path, ok: true, http_status: 200, attempts: 1, ...overrides[path] }]));
}

function freshCandidate(): Record<string, unknown> {
  return { available: true, canonical_angle_deg: 211, freshness: { age_ms: 120, fresh: true, max_age_ms: 5000 } };
}

function snapshot(extra: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return {
    overall_state: 'UNVERIFIED',
    status: { available: true, daq_health: 'PASS' },
    resources: resources(),
    doa_candidates: { csv: freshCandidate(), xml: freshCandidate() },
    ...extra,
  } as TelemetrySnapshot;
}

describe('Data Out HTTP reachability (AUD-101)', () => {
  it('stays AVAILABLE when status.json answers 200 but fails schema validation', () => {
    const value = snapshot({ status: { available: false, error: 'status.daq_ok must be boolean' }, overall_state: 'UNAVAILABLE' });
    expect(dataOutHttp(value)).toEqual({ state: 'AVAILABLE', ok: 4, reported: 4, total: 4 });
    expect(nodeStatus(value)).toEqual({ state: 'INVALID', error: 'status.daq_ok must be boolean' });
  });

  it('is PARTIAL when doa.xml answers 404, even though status.json is valid', () => {
    const value = snapshot({ resources: resources({ '/doa.xml': { ok: false, http_status: 404, error: 'HTTP 404', error_kind: 'http_status' } }) });
    expect(dataOutHttp(value).state).toBe('PARTIAL');
    expect(nodeStatus(value).state).toBe('VALID');
    expect(resourceRows(value)[3]).toMatchObject({ path: '/doa.xml', ok: false, httpStatus: 404, error: 'HTTP 404', errorKind: 'http_status' });
  });

  it('is UNAVAILABLE with the transport error when status.json is refused and the rest skipped', () => {
    const value = snapshot({
      status: { available: false, error: 'connection refused' },
      resources: resources({
        '/status.json': { ok: false, http_status: undefined, error: 'connection refused', error_kind: 'connection_refused' },
        '/settings.json': { ok: false, error: 'skipped: status.json transport failure', error_kind: 'skipped', attempts: 0 },
        '/DOA_value.html': { ok: false, error: 'skipped: status.json transport failure', error_kind: 'skipped', attempts: 0 },
        '/doa.xml': { ok: false, error: 'skipped: status.json transport failure', error_kind: 'skipped', attempts: 0 },
      }),
    });
    expect(dataOutHttp(value).state).toBe('UNAVAILABLE');
    expect(nodeStatus(value)).toEqual({ state: 'UNAVAILABLE', error: 'connection refused' });
  });

  it('reports WAITING without a snapshot and UNKNOWN when resources are absent', () => {
    expect(dataOutHttp(null).state).toBe('WAITING');
    expect(dataOutHttp(snapshot({ resources: undefined })).state).toBe('UNKNOWN');
  });

  it('drops unknown error kinds, bad statuses and control characters from untrusted fields', () => {
    const value = snapshot({ resources: resources({ '/status.json': { ok: false, http_status: 99999, error_kind: 'rm -rf', error: 'bad\u0000line\nnext' } }) });
    expect(resourceRows(value)[0]).toMatchObject({ httpStatus: null, errorKind: null, error: 'bad line next' });
  });
});

describe('health headline and stale evidence', () => {
  it('names the collector cause instead of STALE when the read had no fresh evidence', () => {
    const unavailable = snapshot({ overall_state: 'UNAVAILABLE', status: { available: false } });
    expect(healthHeadline(unavailable, false)).toBe('UNAVAILABLE');
    expect(evidenceExpired(unavailable, false)).toBe(false);
    const invalid = snapshot({ overall_state: 'INVALID', doa_candidates: { csv: { available: false }, xml: { available: false } } });
    expect(healthHeadline(invalid, false)).toBe('INVALID');
    expect(evidenceExpired(invalid, false)).toBe(false);
  });

  it('shows STALE only for a live state whose local window has run out', () => {
    expect(healthHeadline(snapshot(), true)).toBe('UNVERIFIED');
    expect(healthHeadline(snapshot(), false)).toBe('STALE');
    expect(evidenceExpired(snapshot(), false)).toBe(true);
    const degraded = snapshot({ overall_state: 'DEGRADED' });
    expect(healthHeadline(degraded, false)).toBe('DEGRADED');
    expect(evidenceExpired(degraded, false)).toBe(true);
    expect(healthHeadline(null, false)).toBe('WAITING');
  });
});

describe('new collector fields', () => {
  it('reads node progress, keeping only known counters', () => {
    const value = snapshot({ node_progress: { state: 'STALLED', stalled: true, stalled_counters: ['timestamp_ms', 'evil'], unchanged_for_ms: { timestamp_ms: 12000, uptime_ms: 11000 }, regressed_counters: [], max_stall_ms: 10000 } });
    expect(nodeProgressView(value)).toEqual({ state: 'STALLED', stalledCounters: ['timestamp_ms'], regressedCounters: [], longestUnchangedMs: 12000, maxStallMs: 10000 });
    expect(nodeProgressView(snapshot())).toBeNull();
  });

  it('keeps UNCHANGED apart from ADVANCING and does not show it as good', () => {
    const value = snapshot({ node_progress: { state: 'UNCHANGED', stalled: false, stalled_counters: [], changed_counters: [], unchanged_for_ms: { timestamp_ms: 4000 }, regressed_counters: [], max_stall_ms: 10000 } });
    expect(nodeProgressView(value)?.state).toBe('UNCHANGED');
    expect(nodeProgressView(value)?.longestUnchangedMs).toBe(4000);
    expect(stateTone('UNCHANGED')).toBe('warn');
    expect(stateTone('ADVANCING')).toBe('good');
  });

  it('reads signal quality without treating PAPR as a confidence', () => {
    const value = snapshot({ signal_quality: { state: 'OVERDRIVE', adc_overdrive: true, adc_overdrive_sources: ['xml'], adc_overdrive_reported_by: ['status', 'xml'], adc_overdrive_channel_mask: 5, snr_db: 10, confidence_metric_db: { csv: 1.2, xml: 1.35 }, noise_source_enabled: false } });
    expect(signalQualityView(value)).toMatchObject({ state: 'OVERDRIVE', overdriveSources: ['xml'], channelMask: 5, snrDb: 10, paprCsvDb: 1.2, paprXmlDb: 1.35, noiseSourceEnabled: false });
  });

  it('distinguishes adjacent frames, conflicts and invalid angles', () => {
    expect(consistencyView({ comparable: true, conflict: false, angle_checked: true, frame_relation: 'SAME_FRAME', timestamp_delta_ms: 0, circular_distance_deg: 0.2, tolerance_deg: 1 }).relation).toBe('EQUAL');
    expect(consistencyView({ comparable: true, conflict: false, angle_checked: false, frame_relation: 'ADJACENT_FRAMES', timestamp_delta_ms: -1000 })).toMatchObject({ relation: 'NOT CHECKED', frameRelation: 'ADJACENT_FRAMES', timestampDeltaMs: 1000 });
    expect(consistencyView({ comparable: true, conflict: true, angle_checked: true }).relation).toBe('CONFLICT');
    expect(consistencyView({ comparable: false, conflict: false, angle_invalid: true }).relation).toBe('ANGLE INVALID');
    expect(consistencyView({ comparable: false, frame_relation: 'OUT_OF_WINDOW' }).relation).toBe('NOT COMPARABLE');
    expect(consistencyView(undefined).relation).toBe('N/A');
  });

  it('lists additional VFO rows from a multi-row CSV', () => {
    const rows = csvRowsView({ csv_rows_total: 3, csv_row_index: 1, csv_row_selection: 'matched_xml_frequency', additional_vfo_rows: [{ row_index: 0, frequency_hz: 433_920_000, doa_raw_deg: 10, canonical_angle_deg: 350, confidence_raw: 1.1, power_raw: -60 }, 'junk'] });
    expect(rows.total).toBe(3);
    expect(rows.selection).toBe('matched_xml_frequency');
    expect(rows.additional[0]).toEqual({ rowIndex: 0, frequencyHz: 433_920_000, rawDeg: 10, canonicalDeg: 350, confidenceRaw: 1.1, powerRaw: -60 });
    expect(rows.additional[1]).toEqual({ rowIndex: null, frequencyHz: null, rawDeg: null, canonicalDeg: null, confidenceRaw: null, powerRaw: null });
  });

  it('has a translated label for every publication-gate check the collector sends', () => {
    const checks = ['status_available', 'status_fresh', 'daq_healthy', 'adc_not_overdriven', 'node_not_stalled', 'doa_candidate_parsed', 'doa_candidate_fresh', 'authority_selected', 'selected_doa_fresh', 'selected_units_valid', 'canonical_angle_ready', 'native_views_consistent', 'angular_peak_consistent'];
    for (const check of checks) {
      const key = gateCheckKey(check);
      expect(key, check).not.toBeNull();
      expect(DICTIONARIES.id[key as keyof typeof DICTIONARIES.en]).not.toBe(DICTIONARIES.en[key as keyof typeof DICTIONARIES.en]);
    }
    expect(gateCheckKey('future_check')).toBeNull();
    expect(gateCheckKey('toString')).toBeNull();
  });
});

describe('localized durations (AUD-99)', () => {
  it('uses jam/mnt/dtk in Indonesian instead of h/min/s', () => {
    const id = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('id', key, vars);
    expect(durationParts(250)).toEqual({ unit: 'ms', value: '250' });
    expect(formatDuration(id, 7200_000)).toBe('2 jam');
    expect(formatDuration(id, 125_000)).toBe('2 mnt');
    expect(formatDuration(id, 1_500)).toBe('1.5 dtk');
    expect(formatAgeText(id, { age_ms: null })).toBe(DICTIONARIES.id['readout.clockUnverified']);
    expect(formatAgeText((key, vars) => translate('en', key, vars), { age_ms: 2300 })).toBe('2.3 s');
  });
});

describe('labels for the collector gate reasons added in wave 1', () => {
  it('has distinct English and Indonesian text for each new reason', () => {
    const reasons = ['NODE_CLOCK_STALLED', 'ADC_OVERDRIVE', 'COLLECTION_DEADLINE_EXCEEDED', 'CSV_VIEW_UNAVAILABLE', 'XML_VIEW_UNAVAILABLE', 'NATIVE_ANGLE_INVALID', 'ANGULAR_PEAK_ANGLE_MISMATCH'];
    for (const reason of reasons) {
      const english = gateReasonLabel('en', reason);
      const indonesian = gateReasonLabel('id', reason);
      expect(english, reason).not.toBe(reason);
      expect(indonesian, reason).not.toBe(reason);
      expect(indonesian, reason).not.toBe(english);
    }
  });
});

describe('settings keys that may hold a secret', () => {
  it('matches whole segments, so compass_offset is not taken for a password', () => {
    for (const key of ['compass_offset', 'doa_fig_type', 'center_freq', 'keyboard_layout', 'monkey_mode', 'bypass_filter']) expect(isSecretSettingKey(key), key).toBe(false);
  });

  it('hides passwords, secrets, tokens, keys and credentials in any spelling', () => {
    for (const key of ['password', 'admin_password', 'adminPassword', 'PASS', 'db-pass', 'pwd', 'passphrase', 'secret', 'client_secret', 'token', 'access_token', 'authToken', 'key', 'api_key', 'apiKey', 'api-key', 'apikey', 'private.key', 'credential', 'credentials']) expect(isSecretSettingKey(key), key).toBe(true);
  });
});

describe('collector error messages', () => {
  const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars);
  const id = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('id', key, vars);

  it('translates the messages the collector produces and keeps the raw text', () => {
    expect(collectorErrorText(id, 'connection refused')).toEqual({ text: 'Host Data Out menolak koneksi.', raw: 'connection refused', known: true });
    expect(collectorErrorText(id, 'skipped: status.json transport failure').text).toBe('Dilewati: status.json tidak bisa dijangkau.');
    expect(collectorErrorText(en, 'HTTP 404').text).toBe('Data Out answered HTTP 404.');
    expect(collectorErrorText(id, 'body exceeds 262144 bytes').text).toBe('Respons lebih besar dari batas 262144 byte.');
    expect(collectorErrorText(en, 'network error (OSError)').text).toBe('Network error while reading Data Out.');
    expect(collectorErrorText(id, 'invalid JSON at /status.json').text).toBe('JSON tidak valid di /status.json.');
    expect(collectorErrorText(en, 'collection deadline exceeded').text).toBe('Not read: the collection deadline was reached.');
  });

  it('shows an unknown message unchanged', () => {
    expect(collectorErrorText(id, 'expected 377 CSV fields, found 3')).toEqual({ text: 'expected 377 CSV fields, found 3', raw: 'expected 377 CSV fields, found 3', known: false });
  });
});

describe('publication-gate checks for Diagnostics', () => {
  it('puts failing node checks first, then the standing blocks, unset checks and passes', () => {
    const rows = gateCheckRows({ status_available: true, authority_selected: false, status_fresh: null, adc_not_overdriven: false, daq_healthy: true, canonical_angle_ready: false });
    expect(rows.map((row) => `${row.key}:${row.state}:${row.tone}`)).toEqual([
      'adc_not_overdriven:FAIL:bad',
      'authority_selected:BLOCKED:warn',
      'canonical_angle_ready:BLOCKED:warn',
      'status_fresh:NOT CONFIGURED:neutral',
      'status_available:PASS:good',
      'daq_healthy:PASS:good',
    ]);
  });

  it('ignores a gate without checks', () => {
    expect(gateCheckRows(undefined)).toEqual([]);
    expect(gateCheckRows(['status_available'])).toEqual([]);
  });
});

describe('DAQ sync flags', () => {
  it('reads each required flag as passing, failing or missing', () => {
    const value = snapshot({ status: { available: true, safe: { daq_status: { frame_sync: true, iq_sync: false } } } });
    expect(syncFlagsView(value)).toEqual([
      { key: 'frame_sync', label: 'frame', ok: true },
      { key: 'sample_delay_sync', label: 'delay', ok: null },
      { key: 'iq_sync', label: 'IQ', ok: false },
    ]);
    expect(syncFlagsView(null).every((flag) => flag.ok === null)).toBe(true);
  });
});

describe('effective settings on Diagnostics', () => {
  it('appends the unit KrakenSDR uses for each known field', () => {
    expect(settingUnit('center_freq')).toBe('MHz');
    expect(settingUnit('vfo_freq_0')).toBe('Hz');
    expect(settingUnit('vfo_bw_1')).toBe('Hz');
    expect(settingUnit('vfo_squelch_0')).toBe('dB');
    expect(settingUnit('doa_method')).toBeNull();
    expect(settingValueText('center_freq', 415.7882)).toBe('415.7882 MHz');
    expect(settingValueText('compass_offset', 12.5)).toBe('12.5°');
    expect(settingValueText('vfo_freq_0', 415788200)).toBe('415788200 Hz');
    expect(settingValueText('en_doa', true)).toBe('ON');
    expect(settingValueText('doa_method', 'MUSIC')).toBe('MUSIC');
    // A unit only follows a number, never a text value under a numeric key.
    expect(settingValueText('center_freq', 'n/a')).toBe('n/a');
    expect(settingValueText('location_source', null)).toBe('N/A');
  });

  it('formats counts with the thousands separator of the UI language', () => {
    expect(formatCount('en', 1204)).toBe('1,204');
    expect(formatCount('id', 1204)).toBe('1.204');
    expect(formatCount('en', null)).toBe('N/A');
    expect(formatCount('en', Number.NaN)).toBe('N/A');
  });
});
