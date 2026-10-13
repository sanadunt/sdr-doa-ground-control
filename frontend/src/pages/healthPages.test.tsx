import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TelemetrySnapshot } from '../types';
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

describe('System Health ADC overdrive detail', () => {
  it('names the Data Out files that reported the ADC state', () => {
    expect(overdriveSourceFile('status')).toBe('status.json');
    expect(overdriveSourceFile('xml')).toBe('doa.xml');
    expect(overdriveSourceFile('other')).toBe('other');
  });
});

describe('System Health MQTT card', () => {
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
    expect(page).toMatch(/Data Out HTTP AVAILABLE/);
    expect(page).toContain('expected 377 CSV fields, found 3');
    expect(page).toContain('xml.TIME is not numeric');
    expect(page).toContain('INVALID');
    expect(page).toContain('No change in timestamp_ms for 12.5 s');
    expect(page).toContain('ADC overdrive reported by doa.xml');
    expect(page).toContain('channel mask 0b11');
    expect(page).toContain('CSV 1.20 · XML 1.35 dB');
  });

  it('does not call unchanged counters advancing', () => {
    const unchanged = { ...MALFORMED, node_progress: { state: 'UNCHANGED', stalled: false, stalled_counters: [], changed_counters: [], unchanged_for_ms: { timestamp_ms: 4000, uptime_ms: 4000 }, regressed_counters: [], max_stall_ms: 10000, samples: 3 } } as unknown as TelemetrySnapshot;
    const page = text(render(<SystemHealthPage snapshot={unchanged} mqtt={null} localSnapshotFresh={false} />));
    expect(page).toContain('UNCHANGED');
    expect(page).toContain('No counter changed since the previous read (4.0 s)');
    expect(page).not.toContain('are advancing');
    expect(text(render(<SystemHealthPage snapshot={unchanged} mqtt={null} localSnapshotFresh={false} />, 'id'))).toContain('Tidak ada counter yang berubah');
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
    for (const key of Object.keys(FIELDS)) expect(page, key).toContain(key.replace(/_/g, ' '));
    expect(page).toContain('Standard');
    expect(page).toContain('15.7');
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
    expect(page).toContain('compass offset 12.5');
    expect(page).toContain('doa fig type Compass');
    for (const label of ['password', 'admin password', 'api key', 'apiKey', 'client secret', 'access token', 'credentials']) expect(page, label).not.toContain(label);
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
