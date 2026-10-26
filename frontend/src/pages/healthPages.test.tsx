import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MqttSnapshot, TelemetrySnapshot } from '../types';
import { I18nContext, translate } from '../lib/i18n';
import type { Lang } from '../lib/i18n';
import { SystemHealthPage, overdriveSourceFile } from './SystemHealthPage';
import { DoADiagnosticsPage } from './DoADiagnosticsPage';

function render(element: ReactElement, lang: Lang = 'en'): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>{element}</I18nContext.Provider>,
  );
}

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
}

const SKIPPED = { ok: false, attempts: 0, error: 'skipped: status.json transport failure', error_kind: 'skipped', elapsed_ms: 0 };

// Shape of /api/snapshot when the Data Out host refuses the connection.
const REFUSED = {
  overall_state: 'UNAVAILABLE',
  resources: {
    '/status.json': { path: '/status.json', ok: false, attempts: 1, error: 'connection refused', error_kind: 'connection_refused', elapsed_ms: 3 },
    '/settings.json': { path: '/settings.json', ...SKIPPED },
    '/DOA_value.html': { path: '/DOA_value.html', ...SKIPPED },
    '/doa.xml': { path: '/doa.xml', ...SKIPPED },
  },
  status: { available: false, error: 'connection refused', freshness: null },
  settings: { available: false, redacted: true, error: 'skipped: status.json transport failure' },
  doa_candidates: {
    csv: { available: false, source_format: 'csv', error: 'skipped: status.json transport failure' },
    xml: { available: false, source_format: 'xml', error: 'skipped: status.json transport failure' },
  },
  collection: { elapsed_ms: 4, budget_ms: 4000, deadline_exceeded: false, pair_reads: 1, status_transport_failed: true },
  native_consistency: { comparable: false, conflict: false, frame_relation: 'INCOMPLETE', angle_checked: false, timestamp_delta_ms: null },
  publication_gate: { state: 'BLOCKED', checks: { status_available: false, node_not_stalled: true }, reasons: ['STATUS_UNAVAILABLE_OR_INVALID', 'NO_VALID_DOA_CANDIDATE'] },
} as unknown as TelemetrySnapshot;

const OK_RESOURCES = Object.fromEntries(['/status.json', '/settings.json', '/DOA_value.html', '/doa.xml'].map((path) => [path, { path, ok: true, http_status: 200, attempts: 1, elapsed_ms: 12 }]));

// The valid fixture's 14 safe settings, as the collector sorts them.
const FIELDS = {
  active_vfos: 1, ant_arrangement: 'UCA', ant_spacing_meters: 0.21, center_freq: 415.7882, data_interface: 'shmem',
  doa_decorrelation_method: 'Off', doa_method: 'MUSIC', en_doa: true, en_remote_control: false, gps_fixed_heading: true,
  location_source: 'Static', output_vfo: 0, uniform_gain: 15.7, vfo_mode: 'Standard',
};

const MALFORMED = {
  overall_state: 'INVALID',
  resources: OK_RESOURCES,
  status: { available: true, daq_health: 'PASS', safe: { gps_status: 'Disabled', daq_status: { data_frame_index: 42, frame_sync: true, sample_delay_sync: true, iq_sync: true } } },
  settings: { available: true, redacted: true, fields: FIELDS },
  doa_candidates: {
    csv: { available: false, source_format: 'csv', error: 'expected 377 CSV fields, found 3' },
    xml: { available: false, source_format: 'xml', error: 'xml.TIME is not numeric' },
  },
  node_progress: { state: 'STALLED', stalled: true, stalled_counters: ['timestamp_ms'], unchanged_for_ms: { timestamp_ms: 12500 }, regressed_counters: [], max_stall_ms: 10000, samples: 4 },
  signal_quality: { state: 'OVERDRIVE', adc_overdrive: true, adc_overdrive_sources: ['xml'], adc_overdrive_reported_by: ['status', 'xml'], adc_overdrive_channel_mask: 3, snr_db: 10, confidence_metric_db: { csv: 1.2, xml: 1.35 } },
  native_consistency: { comparable: true, conflict: false, frame_relation: 'ADJACENT_FRAMES', angle_checked: false, timestamp_delta_ms: 1000, circular_distance_deg: 4, tolerance_deg: 1 },
  publication_gate: {
    state: 'BLOCKED',
    checks: { status_available: true, adc_not_overdriven: false, node_not_stalled: false, doa_candidate_parsed: false },
    reasons: ['GROUND_CLOCK_UNVERIFIED', 'NODE_CLOCK_STALLED', 'ADC_OVERDRIVE', 'NO_VALID_DOA_CANDIDATE', 'CSV_VIEW_UNAVAILABLE', 'ANGULAR_PEAK_ANGLE_MISMATCH'],
  },
} as unknown as TelemetrySnapshot;

const FRESH = { age_ms: 120, fresh: true, max_age_ms: 5000 };

// A healthy read as the console sees it: delivery BLOCKED only by the standing reasons.
const VALID = {
  overall_state: 'UNVERIFIED',
  collector: { clock_source: 'remote_unverified', base_url: 'http://doasdr.local:8081' },
  resources: OK_RESOURCES,
  status: { available: true, daq_health: 'PASS', safe: { gps_status: 'Disabled', daq_num_dropped_frames: 0, daq_status: { data_frame_index: 351, frame_sync: true, sample_delay_sync: true, iq_sync: true } } },
  settings: { available: true, redacted: true, fields: FIELDS, raw_fields_omitted: true },
  doa_candidates: {
    csv: { available: true, source_format: 'csv', doa_raw_deg: 149, canonical_angle_deg: 211, angle_convention: 'csv_360_minus_theta', freshness: FRESH, native_metrics_state: 'READY', contract_mapping_state: 'NOT_READY', csv_rows_total: 1, csv_row_index: 0, csv_row_selection: 'single_row', angular_peak_angle_distance_deg: 0, angular_peak_angle_consistent: true, angular_peak_angle_tolerance_deg: 3 },
    xml: { available: true, source_format: 'xml', doa_raw_deg: 211, canonical_angle_deg: 211, angle_convention: 'xml_raw_theta', freshness: FRESH, native_metrics_state: 'READY', contract_mapping_state: 'NOT_READY', adc_overdrive_active: false },
  },
  node_progress: { state: 'ADVANCING', stalled: false, stalled_counters: [], regressed_counters: [], unchanged_for_ms: {}, max_stall_ms: 10000 },
  signal_quality: { state: 'PASS', adc_overdrive: false, adc_overdrive_sources: [], adc_overdrive_reported_by: ['status', 'xml'], snr_db: 10, confidence_metric_db: { csv: 1.2, xml: 1.35 }, noise_source_enabled: false },
  collection: { elapsed_ms: 124, budget_ms: 4000, deadline_exceeded: false, pair_reads: 1, status_transport_failed: false },
  native_consistency: { comparable: true, conflict: false, frame_relation: 'SAME_FRAME', angle_checked: true, timestamp_delta_ms: 0, circular_distance_deg: 0, tolerance_deg: 1 },
  authority: { selected: null, canonical_angle_ready: false },
  publication_gate: {
    state: 'BLOCKED',
    checks: {
      status_available: true, status_fresh: null, daq_healthy: true, adc_not_overdriven: true, node_not_stalled: true, doa_candidate_parsed: true, doa_candidate_fresh: true,
      authority_selected: false, selected_doa_fresh: false, selected_units_valid: false, canonical_angle_ready: false, native_views_consistent: true, angular_peak_consistent: true, native_angle_checked: true,
    },
    reasons: ['GROUND_CLOCK_UNVERIFIED', 'DOA_AUTHORITY_NOT_SELECTED', 'CANONICAL_ANGLE_NOT_CONFIGURED'],
  },
} as unknown as TelemetrySnapshot;

describe('System Health layout', () => {
  it('shows a healthy read as tiles, compact cards and chips without helper prose', () => {
    const monitor = { enabled: true, read_only: true, publish_enabled: false, connection: 'connected', host: '10.90.0.1', port: 9001, transport: 'websockets', ws_path: '/mqtt', received: 1204, invalid: 0 } as unknown as MqttSnapshot;
    const markup = render(<SystemHealthPage snapshot={VALID} mqtt={monitor} localSnapshotFresh />);
    const page = text(markup);
    expect(page).toContain('DAQ PASS 0 dropped');
    expect(page).toContain('Sync 3/3');
    expect(page).toContain('ADC PASS status.json · doa.xml');
    expect(page).toContain('SNR 10.0 dB XML');
    expect(page).toContain('MQTT CONNECTED');
    expect(page).toContain('Clock UNVERIFIED');
    expect(page).toContain('RDF-SDR VALID');
    expect(page).toContain('Progress ADVANCING Frame index 351 Dropped frames 0 Sync flags frame delay IQ Noise source OFF GPS status Disabled');
    expect(page).toContain('124 ms / 4.0 s');
    expect(page).toContain('DoA views PRESENT View State Age at read CSV PRESENT 0.1 s XML PRESENT 0.1 s');
    expect(page).toContain('MQTT monitor CONNECTED Broker 10.90.0.1:9001 Transport WS /mqtt Publish Admin config patch only');
    expect(page).toContain('Messages 1,204 Invalid 0');
    // No Detail column, notices, summary sentences or the old subsystem list on a healthy read.
    expect(page).not.toContain('Detail');
    expect(markup).not.toContain('pg-notice');
    expect(page).not.toMatch(/Body received|Schema-checked|Subsystem|classified locally|Native status field/);
    expect(markup).toContain('<span class="ov-tag tone-good" title="iq_sync">IQ</span>');
  });

  it('gives the progress value a tooltip only for a cause, never an explanation of the state', () => {
    const progressRow = (markup: string) => markup.match(/<div class="pg-kv-row"[^>]*><dt>Progress<\/dt>/)?.[0] ?? '';
    const withProgress = (progress: Record<string, unknown>) => ({ ...VALID, node_progress: { stalled: false, stalled_counters: [], regressed_counters: [], unchanged_for_ms: {}, max_stall_ms: 10000, ...progress } }) as unknown as TelemetrySnapshot;
    for (const state of ['ADVANCING', 'UNCHANGED', 'FIRST_SAMPLE', 'UNTRACKED']) {
      const row = progressRow(render(<SystemHealthPage snapshot={withProgress({ state, unchanged_for_ms: { timestamp_ms: 4000 } })} mqtt={null} localSnapshotFresh />));
      expect(row, state).toContain('<dt>Progress</dt>');
      expect(row, state).not.toContain('title=');
    }
    const stalled = render(<SystemHealthPage snapshot={withProgress({ state: 'STALLED', stalled: true, stalled_counters: ['timestamp_ms', 'uptime_ms'], unchanged_for_ms: { timestamp_ms: 12000, uptime_ms: 12000 } })} mqtt={null} localSnapshotFresh />);
    expect(progressRow(stalled)).toContain('title="No change in timestamp_ms, uptime_ms for 12.0 s; Data Out files are frozen"');
    expect(text(stalled)).toContain('NODE_CLOCK_STALLED No change in timestamp_ms, uptime_ms for 12.0 s');
    const regressed = render(<SystemHealthPage snapshot={withProgress({ state: 'ADVANCING', regressed_counters: ['uptime_ms'] })} mqtt={null} localSnapshotFresh />);
    expect(progressRow(regressed)).toContain('title="Went backwards: uptime_ms (node restart?)."');
    const unavailable = render(<SystemHealthPage snapshot={withProgress({ state: 'UNAVAILABLE' })} mqtt={null} localSnapshotFresh />);
    expect(progressRow(unavailable)).toContain(`title="${translate('en', 'health.progress.unavailable')}"`);
  });

  it('marks a failing sync flag and names it in a notice', () => {
    const failed = { ...VALID, status: { ...VALID.status, daq_health: 'FAIL', failed_sync_flags: ['iq_sync'], safe: { daq_status: { frame_sync: true, sample_delay_sync: true, iq_sync: false } } } } as unknown as TelemetrySnapshot;
    const markup = render(<SystemHealthPage snapshot={failed} mqtt={null} localSnapshotFresh />);
    expect(markup).toContain('<span class="ov-tag tone-bad" title="iq_sync">IQ</span>');
    expect(text(markup)).toContain('DAQ Sync failed: iq_sync');
    expect(text(markup)).toContain('Sync 2/3');
  });

  it('shows STALE EVIDENCE as a warning notice once the local window has run out', () => {
    const markup = render(<SystemHealthPage snapshot={VALID} mqtt={null} localSnapshotFresh={false} />);
    expect(markup).toContain('<div class="pg-notice tone-warn" role="status"><strong class="pg-notice-title">STALE EVIDENCE</strong>');
    expect(text(markup)).toContain('STALE');
  });
});

describe('System Health ADC overdrive detail', () => {
  it('names the Data Out files that reported the ADC state', () => {
    expect(overdriveSourceFile('status')).toBe('status.json');
    expect(overdriveSourceFile('xml')).toBe('doa.xml');
    expect(overdriveSourceFile('other')).toBe('other');
  });
});

describe('System Health MQTT card', () => {
  it('names the admin config patch as the only publish path', () => {
    const monitor = { enabled: true, read_only: true, publish_enabled: false, connection: 'connected' } as unknown as MqttSnapshot;
    const patch = (enabled: boolean) => ({ refreshIntervalsS: null, adminEnabled: true, adminDefaultPassword: false, configPatch: { enabled, requiresAdmin: true, topic: null, qos: 1, ttlMs: null, ranges: {} } });
    for (const lang of ['en', 'id'] as const) {
      const available = text(render(<SystemHealthPage snapshot={REFUSED} mqtt={monitor} localSnapshotFresh={false} capabilities={patch(true)} />, lang));
      expect(available).toContain(translate(lang, 'health.sub.publishAdminOnly'));
      expect(available).not.toMatch(/Publish disabled|Publish nonaktif/);
      const unknown = text(render(<SystemHealthPage snapshot={REFUSED} mqtt={monitor} localSnapshotFresh={false} />, lang));
      expect(unknown).toContain(translate(lang, 'health.sub.publishAdminOnly'));
      const off = text(render(<SystemHealthPage snapshot={REFUSED} mqtt={monitor} localSnapshotFresh={false} capabilities={patch(false)} />, lang));
      expect(off).toContain(translate(lang, 'health.sub.publishUnavailable'));
    }
  });

  it('reports a failed /api/mqtt poll as ERROR instead of OFF', () => {
    const page = text(render(<SystemHealthPage snapshot={REFUSED} mqtt={null} mqttError="Console unreachable" localSnapshotFresh={false} />));
    expect(page).toContain('ERROR');
    expect(page).toContain('Console unreachable');
    const off = text(render(<SystemHealthPage snapshot={REFUSED} mqtt={null} localSnapshotFresh={false} />));
    expect(off).toContain('OFF');
  });
});

describe('System Health shows why Data Out failed (AUD-27, AUD-101)', () => {
  it('renders the transport error, the skipped reads and UNAVAILABLE without a stale banner', () => {
    const markup = render(<SystemHealthPage snapshot={REFUSED} mqtt={null} localSnapshotFresh={false} />);
    const page = text(markup);
    expect(page).toContain('The Data Out host refused the connection.');
    expect(page).toContain('Connection refused');
    expect(page).toContain('Skipped: status.json could not be reached.');
    // The collector's own message stays available as the tooltip.
    expect(markup).toContain('title="connection refused"');
    expect(markup).toContain('title="skipped: status.json transport failure"');
    expect(page).toContain('status.json could not be reached, so the other reads were skipped.');
    expect(page).toContain('UNAVAILABLE');
    expect(page).not.toContain('STALE EVIDENCE');
  });

  it('keeps Data Out HTTP available when only parsing failed, and shows the parse errors', () => {
    const page = text(render(<SystemHealthPage snapshot={MALFORMED} mqtt={null} localSnapshotFresh={false} />));
    expect(page).toContain('HTTP AVAILABLE');
    expect(page).toContain('Data Out AVAILABLE');
    expect(page).toContain('expected 377 CSV fields, found 3');
    expect(page).toContain('xml.TIME is not numeric');
    expect(page).toContain('INVALID');
    expect(page).toContain('No change in timestamp_ms for 12.5 s');
    expect(page).toContain('ADC overdrive reported by doa.xml');
    expect(page).toContain('channel mask 0b11');
    expect(page).toContain('PAPR 1.20/1.35 dB CSV / XML');
    // Every resource answered 200, so the table needs no Detail column.
    expect(page).toMatch(/Resource Result Time \/status\.json HTTP 200/);
  });

  // #13: settings.json was not read in this collection; the console reused it.
  it('shows a reused settings.json as REUSED with its age', () => {
    const reused = {
      ...VALID,
      resources: { ...OK_RESOURCES, '/settings.json': { ...OK_RESOURCES['/settings.json'], reused: true } },
      collection: { elapsed_ms: 30, budget_ms: 4000, settings_reused: true, settings_age_ms: 12_000 },
    } as unknown as TelemetrySnapshot;
    expect(text(render(<SystemHealthPage snapshot={reused} mqtt={null} localSnapshotFresh />))).toMatch(/\/settings\.json REUSED 12\.0 s old/);
    expect(text(render(<SystemHealthPage snapshot={reused} mqtt={null} localSnapshotFresh />, 'id'))).toMatch(/\/settings\.json REUSED umur 12\.0 dtk/);
  });

  it('does not call unchanged counters advancing', () => {
    const unchanged = { ...MALFORMED, node_progress: { state: 'UNCHANGED', stalled: false, stalled_counters: [], changed_counters: [], unchanged_for_ms: { timestamp_ms: 4000, uptime_ms: 4000 }, regressed_counters: [], max_stall_ms: 10000, samples: 3 } } as unknown as TelemetrySnapshot;
    const markup = render(<SystemHealthPage snapshot={unchanged} mqtt={null} localSnapshotFresh={false} />);
    const page = text(markup);
    expect(page).toContain('Progress UNCHANGED 4.0 s');
    // The chip and the age beside it say it all: no tooltip restating them, no prose.
    expect(markup).not.toContain('No counter changed');
    expect(page).not.toContain('are advancing');
    expect(page).not.toContain('NODE_CLOCK_STALLED');
    expect(render(<SystemHealthPage snapshot={unchanged} mqtt={null} localSnapshotFresh={false} />, 'id')).not.toContain('Tidak ada counter yang berubah');
  });

  it('speaks Indonesian for error kinds, collector messages and durations', () => {
    const markup = render(<SystemHealthPage snapshot={REFUSED} mqtt={null} localSnapshotFresh={false} />, 'id');
    const page = text(markup);
    expect(page).toContain('Koneksi ditolak');
    expect(page).toContain('Dilewati');
    expect(page).toContain('Host Data Out menolak koneksi.');
    expect(page).toContain('Dilewati: status.json tidak bisa dijangkau.');
    expect(page).not.toContain('connection refused');
    expect(page).not.toContain('transport failure');
    expect(markup).toContain('title="connection refused"');
    expect(page).toContain('3 ms');
    expect(page).not.toContain('clock unverified');
  });
});

describe('DoA Diagnostics', () => {
  it('lists every effective setting, including uniform_gain and vfo_mode (AUD-104)', () => {
    const page = text(render(<DoADiagnosticsPage snapshot={MALFORMED} localSnapshotFresh={false} />));
    // Raw keys, as the node's settings.json names them, with the unit where it is known.
    for (const key of Object.keys(FIELDS)) expect(page, key).toContain(` ${key} `);
    expect(page).toContain('vfo_mode Standard');
    expect(page).toContain('uniform_gain 15.7 dB');
    expect(page).toContain('center_freq 415.7882 MHz');
    expect(page).toContain('en_doa ON');
    expect(page).toContain('local_snapshot_fresh false');
    expect(page).toContain('raw_settings_omitted true');
    expect(page).not.toMatch(/[{}]/);
  });

  it('shows record errors, frame relation and labels for the new gate reasons and checks', () => {
    const page = text(render(<DoADiagnosticsPage snapshot={MALFORMED} localSnapshotFresh={false} />));
    expect(page).toContain('expected 377 CSV fields, found 3');
    expect(page).toContain('NOT CHECKED');
    expect(page).toContain('ADJACENT_FRAMES');
    expect(page).toContain('Node status counters stopped advancing');
    expect(page).toContain('CSV vector peak does not match θ₀');
    expect(page).toContain('ADC not overdriven');
    // Actionable reasons come before the standing clock reason.
    expect(page.indexOf('Node status counters stopped advancing')).toBeLessThan(page.indexOf('Ground and node clocks are not verified'));
  });

  it('translates gate checks and reasons in Indonesian', () => {
    const page = text(render(<DoADiagnosticsPage snapshot={MALFORMED} localSnapshotFresh={false} />, 'id'));
    expect(page).toContain('Node tidak macet');
    expect(page).toContain('ADC overdrive dilaporkan; turunkan gain penerima');
    expect(page).not.toContain('Node Not Stalled');
  });

  it('shows compass_offset while keys that may hold a secret stay hidden', () => {
    const fields = { ...FIELDS, compass_offset: 12.5, doa_fig_type: 'Compass', password: 'p', admin_password: 'p', api_key: 'k', apiKey: 'k', client_secret: 's', access_token: 't', credentials: 'c' };
    const withSecrets = { ...MALFORMED, settings: { available: true, redacted: true, fields } } as unknown as TelemetrySnapshot;
    const page = text(render(<DoADiagnosticsPage snapshot={withSecrets} localSnapshotFresh={false} />));
    expect(page).toContain('compass_offset 12.5°');
    expect(page).toContain('doa_fig_type Compass');
    for (const label of ['password', 'api_key', 'apiKey', 'client_secret', 'access_token', 'credentials']) expect(page, label).not.toContain(label);
  });

  it('translates a known collector message on the native record and keeps an unknown one as is', () => {
    const page = text(render(<DoADiagnosticsPage snapshot={REFUSED} localSnapshotFresh={false} />, 'id'));
    expect(page).toContain('Dilewati: status.json tidak bisa dijangkau.');
    expect(text(render(<DoADiagnosticsPage snapshot={MALFORMED} localSnapshotFresh={false} />, 'id'))).toContain('expected 377 CSV fields, found 3');
  });

  it('shows the per-resource HTTP failure on the native record', () => {
    const page = text(render(<DoADiagnosticsPage snapshot={REFUSED} localSnapshotFresh={false} />));
    expect(page).toContain('Skipped');
    expect(page).toContain('UNAVAILABLE');
    expect(page).not.toContain('REDACTED FIELDS');
  });
});

describe('DoA Diagnostics layout', () => {
  it('lists blocked checks first and folds the passing ones behind a toggle', () => {
    const markup = render(<DoADiagnosticsPage snapshot={VALID} localSnapshotFresh />);
    const page = text(markup);
    expect(page).toContain('Delivery gate BLOCKED Show PASS (9)');
    expect(page).toMatch(/Authority selected BLOCKED Selected DoA fresh BLOCKED Selected units valid BLOCKED Canonical angle ready BLOCKED Node status fresh NOT CONFIGURED Block reasons/);
    expect(page).not.toContain('DAQ healthy');
    expect(page).not.toContain('Operator log');
    // Standing reasons are listed once and not marked as actionable.
    expect(page.match(/GROUND_CLOCK_UNVERIFIED/g)).toHaveLength(1);
    expect(markup).not.toContain('is-actionable');
  });

  it('marks a failing node check FAIL and its reason actionable', () => {
    const page = render(<DoADiagnosticsPage snapshot={MALFORMED} localSnapshotFresh={false} />);
    expect(page).toContain('<span class="hd-check-label" title="adc_not_overdriven">ADC not overdriven</span><span class="ov-chip tone-bad">FAIL</span>');
    expect(page).toContain('<li class="is-actionable"><span class="hd-reason-text">ADC overdrive reported; reduce receiver gain</span><span class="ov-tag tone-bad">ADC_OVERDRIVE</span></li>');
  });

  it('compares CSV and XML field by field and states the relation without a sentence', () => {
    const page = text(render(<DoADiagnosticsPage snapshot={VALID} localSnapshotFresh />));
    expect(page).toContain('θ₀ 211.0°');
    expect(page).toContain('Field CSV XML State PRESENT PRESENT Raw angle 149.0° 211.0° Canonical θ₀ 211.0° 211.0° Age at read 0.1 s 0.1 s HTTP HTTP 200 12 ms HTTP 200 12 ms');
    expect(page).toContain('CSV rows 1 / 1');
    expect(page).toContain('Peak vs θ₀ 0.0°');
    expect(page).toContain('ADC overdrive — PASS Frame SAME_FRAME Δt 0 ms Δθ 0.0° / 1.0°');
    expect(page).toContain('Native records EQUAL Field CSV XML');
    expect(page).toContain('Collector Authority NONE Angle readiness NOT CONFIGURED Native views FRESH / COMPARABLE Settings source REDACTED FIELDS local_snapshot_fresh true');
    expect(page).not.toMatch(/collector conversion|Contract mapping: |within freshness window/);
  });
});

/** Vitest blanks every CSS import, so the stylesheet is read from disk. */
function readSource(path: string): string {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  return process.getBuiltinModule('node:fs').readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('health and diagnostics stylesheet', () => {
  const css = readSource('./health-diagnostics.css');

  it('loads from the entry after the page kit, never from the lazy page chunks', () => {
    const main = readSource('../main.tsx');
    expect(main.indexOf("import './pages/health-diagnostics.css';")).toBeGreaterThan(main.indexOf("import './page-kit.css';"));
    for (const page of ['./SystemHealthPage.tsx', './DoADiagnosticsPage.tsx']) expect(readSource(page)).not.toMatch(/\.css['"]/);
  });

  it('uses the console tokens only and prefixes its classes', () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/rgba?\(/);
    for (const selector of rules.match(/\.[a-z][\w-]*/g) ?? []) expect(selector, selector).toMatch(/^\.(hd-|pg-|ov-|is-)/);
  });
});
