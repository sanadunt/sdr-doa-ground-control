import type { Candidate, Freshness, NativeConsistency, TelemetrySnapshot, Tone } from '../types';
import type { MessageKey, Translate } from './i18n';
import { candidate, toneFor } from './telemetry';
import { settingsAgeMs } from './snapshotRead';

/** The four bounded GETs the collector makes, in the order it reads them. */
export const DATA_OUT_RESOURCE_PATHS = ['/status.json', '/settings.json', '/DOA_value.html', '/doa.xml'] as const;
export type DataOutResourcePath = typeof DATA_OUT_RESOURCE_PATHS[number];

const MAX_TEXT_LENGTH = 240;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

/** A bounded, single-line string, or null when the value is not usable text. */
function boundedText(value: unknown, max = MAX_TEXT_LENGTH): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegative(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function code(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === 'string' && allowed.includes(value) ? value : null;
}

function stringList(value: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && allowed.includes(entry));
}

// ---------------------------------------------------------------------------
// Data Out resources (AUD-27, AUD-101)

export const RESOURCE_ERROR_KINDS = [
  'invalid_target',
  'http_status',
  'timeout',
  'connection_refused',
  'unreachable',
  'network',
  'body_too_large',
  'redirect',
  'protocol',
  'deadline',
  'skipped',
] as const;
export type ResourceErrorKind = typeof RESOURCE_ERROR_KINDS[number];

export interface ResourceRow {
  path: DataOutResourcePath;
  /** null when the snapshot did not report this resource. */
  ok: boolean | null;
  httpStatus: number | null;
  error: string | null;
  errorKind: ResourceErrorKind | null;
  elapsedMs: number | null;
  attempts: number | null;
  /** Not read in this collection: the console reused a recent copy (settings.json). */
  reused: boolean;
  /** Age of a reused copy when the snapshot was answered, else null. */
  reusedAgeMs: number | null;
}

/** Per-resource read results, normalized from the untrusted snapshot. */
export function resourceRows(snapshot: TelemetrySnapshot | null | undefined): ResourceRow[] {
  const resources = record(snapshot?.resources);
  return DATA_OUT_RESOURCE_PATHS.map((path) => {
    const entry = record(resources?.[path]);
    const status = finite(entry?.http_status);
    const attempts = nonNegative(entry?.attempts);
    const reused = entry?.reused === true;
    return {
      path,
      ok: bool(entry?.ok),
      httpStatus: status !== null && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      error: boundedText(entry?.error),
      errorKind: code(entry?.error_kind, RESOURCE_ERROR_KINDS) as ResourceErrorKind | null,
      elapsedMs: nonNegative(entry?.elapsed_ms),
      attempts: attempts !== null && Number.isInteger(attempts) ? attempts : null,
      reused,
      reusedAgeMs: reused && path === '/settings.json' ? settingsAgeMs(snapshot) : null,
    };
  });
}

export function resourceRow(snapshot: TelemetrySnapshot | null | undefined, path: DataOutResourcePath): ResourceRow {
  return resourceRows(snapshot).find((row) => row.path === path) as ResourceRow;
}

export type HttpReachability = 'WAITING' | 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE' | 'UNKNOWN';

export interface HttpSummary {
  state: HttpReachability;
  ok: number;
  reported: number;
  total: number;
}

/**
 * Whether the Data Out web server answered each GET with 200 at the last read.
 * This is HTTP reachability only; a 200 with an invalid body is still reached.
 */
export function dataOutHttp(snapshot: TelemetrySnapshot | null | undefined): HttpSummary {
  const total = DATA_OUT_RESOURCE_PATHS.length;
  if (!snapshot) return { state: 'WAITING', ok: 0, reported: 0, total };
  const rows = resourceRows(snapshot).filter((row) => row.ok !== null);
  const ok = rows.filter((row) => row.ok === true).length;
  if (!rows.length) return { state: 'UNKNOWN', ok, reported: 0, total };
  const state: HttpReachability = ok === 0 ? 'UNAVAILABLE' : ok === total && rows.length === total ? 'AVAILABLE' : 'PARTIAL';
  return { state, ok, reported: rows.length, total };
}

export type NodeStatusState = 'WAITING' | 'VALID' | 'INVALID' | 'UNAVAILABLE';

/** status.json at the last read: unreachable, reached but invalid, or valid. */
export function nodeStatus(snapshot: TelemetrySnapshot | null | undefined): { state: NodeStatusState; error: string | null } {
  if (!snapshot) return { state: 'WAITING', error: null };
  if (snapshot.status?.available === true) return { state: 'VALID', error: null };
  const resource = resourceRow(snapshot, '/status.json');
  const statusError = boundedText(snapshot.status?.error);
  if (resource.ok === false) return { state: 'UNAVAILABLE', error: resource.error ?? statusError };
  return { state: 'INVALID', error: statusError };
}

// ---------------------------------------------------------------------------
// Collection, node progress and signal quality (collector contract §4)

/** How the collector reached the Data Out host: through the system resolver or the one-shot mDNS fallback (#12). */
export interface HostResolutionView {
  method: 'system' | 'mdns';
  address: string;
}

export interface CollectionView {
  elapsedMs: number | null;
  budgetMs: number | null;
  deadlineExceeded: boolean;
  statusTransportFailed: boolean;
  pairReads: number | null;
  /** Null for an IP address in the URL, a read through a proxy, or when no read reached the host. */
  resolution: HostResolutionView | null;
}

function hostResolution(value: unknown): HostResolutionView | null {
  const resolution = record(value);
  const method = resolution?.method;
  const address = resolution?.address;
  if ((method !== 'system' && method !== 'mdns') || typeof address !== 'string') return null;
  // An IPv4 or IPv6 address as the collector reports it, nothing else.
  return /^[0-9A-Fa-f.:]{2,45}$/u.test(address) ? { method, address } : null;
}

export function collectionView(snapshot: TelemetrySnapshot | null | undefined): CollectionView | null {
  const collection = record(snapshot?.collection);
  if (!collection) return null;
  return {
    elapsedMs: nonNegative(collection.elapsed_ms),
    budgetMs: nonNegative(collection.budget_ms),
    deadlineExceeded: collection.deadline_exceeded === true,
    statusTransportFailed: collection.status_transport_failed === true,
    pairReads: nonNegative(collection.pair_reads),
    resolution: hostResolution(collection.host_resolution),
  };
}

const NODE_PROGRESS_STATES = ['ADVANCING', 'UNCHANGED', 'STALLED', 'FIRST_SAMPLE', 'UNAVAILABLE', 'UNTRACKED'] as const;
const NODE_COUNTERS = ['timestamp_ms', 'uptime_ms', 'data_frame_index'] as const;

export interface NodeProgressView {
  state: typeof NODE_PROGRESS_STATES[number] | 'UNKNOWN';
  stalledCounters: string[];
  regressedCounters: string[];
  /** Longest time any counter has stayed unchanged, in Ground monotonic ms. */
  longestUnchangedMs: number | null;
  maxStallMs: number | null;
}

export function nodeProgressView(snapshot: TelemetrySnapshot | null | undefined): NodeProgressView | null {
  const progress = record(snapshot?.node_progress);
  if (!progress) return null;
  const unchanged = record(progress.unchanged_for_ms);
  const ages = NODE_COUNTERS.map((counter) => nonNegative(unchanged?.[counter])).filter((age): age is number => age !== null);
  const state = code(progress.state, NODE_PROGRESS_STATES) as NodeProgressView['state'] | null;
  return {
    state: state ?? (progress.stalled === true ? 'STALLED' : 'UNKNOWN'),
    stalledCounters: stringList(progress.stalled_counters, NODE_COUNTERS),
    regressedCounters: stringList(progress.regressed_counters, NODE_COUNTERS),
    longestUnchangedMs: ages.length ? Math.max(...ages) : null,
    maxStallMs: nonNegative(progress.max_stall_ms),
  };
}

const SIGNAL_STATES = ['PASS', 'OVERDRIVE', 'UNKNOWN'] as const;
const OVERDRIVE_SOURCES = ['status', 'xml'] as const;

export interface SignalQualityView {
  state: typeof SIGNAL_STATES[number];
  adcOverdrive: boolean | null;
  overdriveSources: string[];
  reportedBy: string[];
  channelMask: number | null;
  snrDb: number | null;
  paprCsvDb: number | null;
  paprXmlDb: number | null;
  noiseSourceEnabled: boolean | null;
}

export function signalQualityView(snapshot: TelemetrySnapshot | null | undefined): SignalQualityView | null {
  const quality = record(snapshot?.signal_quality);
  if (!quality) return null;
  const papr = record(quality.confidence_metric_db);
  const mask = nonNegative(quality.adc_overdrive_channel_mask);
  const overdrive = bool(quality.adc_overdrive);
  const state = code(quality.state, SIGNAL_STATES) as SignalQualityView['state'] | null;
  return {
    state: state ?? (overdrive === true ? 'OVERDRIVE' : 'UNKNOWN'),
    adcOverdrive: overdrive,
    overdriveSources: stringList(quality.adc_overdrive_sources, OVERDRIVE_SOURCES),
    reportedBy: stringList(quality.adc_overdrive_reported_by, OVERDRIVE_SOURCES),
    channelMask: mask !== null && Number.isInteger(mask) ? mask : null,
    snrDb: finite(quality.snr_db),
    paprCsvDb: finite(papr?.csv),
    paprXmlDb: finite(papr?.xml),
    noiseSourceEnabled: bool(quality.noise_source_enabled),
  };
}

// ---------------------------------------------------------------------------
// Native candidates and their consistency (AUD-18, AUD-22, AUD-69)

const FRAME_RELATIONS = ['SAME_FRAME', 'ADJACENT_FRAMES', 'OUT_OF_WINDOW', 'INCOMPLETE'] as const;

export interface ConsistencyView {
  /** Untranslated relation code shown to the operator. */
  relation: 'N/A' | 'ANGLE INVALID' | 'CONFLICT' | 'NOT COMPARABLE' | 'NOT CHECKED' | 'EQUAL';
  frameRelation: typeof FRAME_RELATIONS[number] | null;
  angleChecked: boolean | null;
  timestampDeltaMs: number | null;
  distanceDeg: number | null;
  toleranceDeg: number | null;
  pairReads: number | null;
}

export function consistencyView(consistency: NativeConsistency | null | undefined): ConsistencyView {
  const value = record(consistency);
  const frameRelation = code(value?.frame_relation, FRAME_RELATIONS) as ConsistencyView['frameRelation'];
  const angleChecked = bool(value?.angle_checked);
  let relation: ConsistencyView['relation'] = 'N/A';
  if (value) {
    if (value.angle_invalid === true) relation = 'ANGLE INVALID';
    else if (value.conflict === true) relation = 'CONFLICT';
    else if (value.comparable !== true) relation = 'NOT COMPARABLE';
    // Adjacent frames stay comparable but the angle test only runs on a same-frame pair.
    else if (angleChecked === false) relation = 'NOT CHECKED';
    else relation = 'EQUAL';
  }
  const delta = finite(value?.timestamp_delta_ms);
  return {
    relation,
    frameRelation,
    angleChecked,
    timestampDeltaMs: delta === null ? null : Math.abs(delta),
    distanceDeg: nonNegative(value?.circular_distance_deg),
    toleranceDeg: nonNegative(value?.tolerance_deg),
    pairReads: nonNegative(value?.pair_reads),
  };
}

export interface CandidateIssue {
  error: string | null;
  /** The angle could not be canonicalized; the view is held back. */
  quarantined: string | null;
}

export function candidateIssue(item: Candidate): CandidateIssue {
  const quarantine = boundedText(item.normalization_error_detail) ?? boundedText(item.normalization_error);
  return { error: boundedText(item.error), quarantined: quarantine };
}

export interface CsvRowsView {
  total: number | null;
  index: number | null;
  selection: 'single_row' | 'matched_xml_frequency' | null;
  additional: Array<{
    rowIndex: number | null;
    frequencyHz: number | null;
    rawDeg: number | null;
    canonicalDeg: number | null;
    confidenceRaw: number | null;
    powerRaw: number | null;
  }>;
}

const MAX_VFO_ROWS = 16;

/** Multi-VFO CSV rows (Output VFO = ALL); only the selected row carries a vector. */
export function csvRowsView(item: Candidate): CsvRowsView {
  const rows = Array.isArray(item.additional_vfo_rows) ? item.additional_vfo_rows : [];
  const selection = code(item.csv_row_selection, ['single_row', 'matched_xml_frequency']) as CsvRowsView['selection'];
  return {
    total: nonNegative(item.csv_rows_total),
    index: nonNegative(item.csv_row_index),
    selection,
    additional: rows.slice(0, MAX_VFO_ROWS).map((row) => {
      const entry = record(row);
      return {
        rowIndex: nonNegative(entry?.row_index),
        frequencyHz: nonNegative(entry?.frequency_hz),
        rawDeg: finite(entry?.doa_raw_deg),
        canonicalDeg: finite(entry?.canonical_angle_deg),
        confidenceRaw: finite(entry?.confidence_raw),
        powerRaw: finite(entry?.power_raw),
      };
    }),
  };
}

export function peakConsistency(item: Candidate): { distanceDeg: number | null; consistent: boolean | null; toleranceDeg: number | null } {
  return {
    distanceDeg: nonNegative(item.angular_peak_angle_distance_deg),
    consistent: bool(item.angular_peak_angle_consistent),
    toleranceDeg: nonNegative(item.angular_peak_angle_tolerance_deg),
  };
}

// ---------------------------------------------------------------------------
// Headline and freshness wording

function freshAtRead(snapshot: TelemetrySnapshot): boolean {
  if (snapshot.status?.available !== true) return false;
  return (['csv', 'xml'] as const).some((name) => {
    const item = candidate(snapshot, name);
    return item.available === true && item.freshness?.fresh === true;
  });
}

/**
 * The snapshot carried fresh DoA evidence when it was read, and that window has
 * since run out locally. A read that never had fresh evidence names its own
 * cause instead of being called stale.
 */
export function evidenceExpired(snapshot: TelemetrySnapshot | null | undefined, localFresh: boolean): boolean {
  return Boolean(snapshot) && !localFresh && freshAtRead(snapshot as TelemetrySnapshot);
}

/** Collector classification first; STALE only replaces a state that claimed live data. */
export function healthHeadline(snapshot: TelemetrySnapshot | null | undefined, localFresh: boolean): string {
  if (!snapshot) return 'WAITING';
  const overall = typeof snapshot.overall_state === 'string' && snapshot.overall_state.trim()
    ? snapshot.overall_state.trim().toUpperCase().slice(0, 32)
    : 'UNKNOWN';
  if (evidenceExpired(snapshot, localFresh) && ['LIVE', 'UNVERIFIED', 'UNKNOWN'].includes(overall)) return 'STALE';
  return overall;
}

/** Age in seconds, or null when the freshness reference is unknown. */
function ageSeconds(freshness: Freshness | null | undefined): number | null {
  const age = freshness?.age_ms;
  return typeof age === 'number' && Number.isFinite(age) && age >= 0 ? age / 1000 : null;
}

/** Tone for the status codes used on Health and Diagnostics. */
export function stateTone(value: unknown): Tone {
  const normalized = String(value ?? '').toUpperCase();
  if (['VALID', 'ADVANCING', 'EQUAL', 'SAME_FRAME', 'PRESENT'].includes(normalized)) return 'good';
  if (['STALLED', 'OVERDRIVE', 'ANGLE INVALID', 'MISMATCH'].includes(normalized)) return 'bad';
  if (['PARTIAL', 'INCOMPLETE', 'FIRST_SAMPLE', 'UNCHANGED', 'UNTRACKED', 'NOT CHECKED', 'NOT COMPARABLE', 'ADJACENT_FRAMES', 'OUT_OF_WINDOW', 'MISSING'].includes(normalized)) return 'warn';
  return toneFor(normalized);
}

// ---------------------------------------------------------------------------
// i18n key maps

const ERROR_KIND_KEYS: Record<ResourceErrorKind, MessageKey> = {
  invalid_target: 'health.errorKind.invalid_target',
  http_status: 'health.errorKind.http_status',
  timeout: 'health.errorKind.timeout',
  connection_refused: 'health.errorKind.connection_refused',
  unreachable: 'health.errorKind.unreachable',
  network: 'health.errorKind.network',
  body_too_large: 'health.errorKind.body_too_large',
  redirect: 'health.errorKind.redirect',
  protocol: 'health.errorKind.protocol',
  deadline: 'health.errorKind.deadline',
  skipped: 'health.errorKind.skipped',
};

export function errorKindKey(kind: ResourceErrorKind | null): MessageKey {
  return kind ? ERROR_KIND_KEYS[kind] : 'health.errorKind.unknown';
}

const GATE_CHECK_KEYS: Record<string, MessageKey> = {
  status_available: 'diag.check.status_available',
  status_fresh: 'diag.check.status_fresh',
  daq_healthy: 'diag.check.daq_healthy',
  adc_not_overdriven: 'diag.check.adc_not_overdriven',
  node_not_stalled: 'diag.check.node_not_stalled',
  doa_candidate_parsed: 'diag.check.doa_candidate_parsed',
  doa_candidate_fresh: 'diag.check.doa_candidate_fresh',
  authority_selected: 'diag.check.authority_selected',
  selected_doa_fresh: 'diag.check.selected_doa_fresh',
  selected_units_valid: 'diag.check.selected_units_valid',
  canonical_angle_ready: 'diag.check.canonical_angle_ready',
  native_views_consistent: 'diag.check.native_views_consistent',
  angular_peak_consistent: 'diag.check.angular_peak_consistent',
  native_angle_checked: 'diag.check.native_angle_checked',
};

/** i18n key for a known publication-gate check, or null for an unknown one. */
export function gateCheckKey(check: string): MessageKey | null {
  return Object.prototype.hasOwnProperty.call(GATE_CHECK_KEYS, check) ? GATE_CHECK_KEYS[check] : null;
}

/** Fallback label for a gate check the console does not know yet. */
export function humanizeKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (value) => value.toUpperCase());
}

// Checks that fail on every console read: the console never selects an
// authority or approves the angle convention, so the selected-source checks
// follow. They block delivery by design and are not a node fault.
const STANDING_GATE_CHECKS: ReadonlySet<string> = new Set([
  'authority_selected',
  'canonical_angle_ready',
  'selected_doa_fresh',
  'selected_units_valid',
]);

export type GateCheckState = 'FAIL' | 'BLOCKED' | 'NOT CONFIGURED' | 'PASS';

export interface GateCheckRow {
  key: string;
  state: GateCheckState;
  tone: Tone;
}

const GATE_CHECK_ORDER: Record<GateCheckState, number> = { FAIL: 0, BLOCKED: 1, 'NOT CONFIGURED': 2, PASS: 3 };
const MAX_GATE_CHECKS = 32;

/**
 * Publication-gate checks in reading order: failing node checks first, then
 * the checks the console blocks by design, then unset ones, then passes.
 * A false check is FAIL (bad) unless it is one of the standing checks,
 * which read BLOCKED (warn).
 */
export function gateCheckRows(checks: unknown): GateCheckRow[] {
  const value = record(checks);
  if (!value) return [];
  return Object.entries(value)
    .slice(0, MAX_GATE_CHECKS)
    .map(([key, result], index) => {
      const state: GateCheckState = result === true ? 'PASS'
        : result === false ? (STANDING_GATE_CHECKS.has(key) ? 'BLOCKED' : 'FAIL')
          : 'NOT CONFIGURED';
      const tone: Tone = state === 'PASS' ? 'good' : state === 'FAIL' ? 'bad' : state === 'BLOCKED' ? 'warn' : 'neutral';
      return { row: { key, state, tone }, index };
    })
    .sort((a, b) => GATE_CHECK_ORDER[a.row.state] - GATE_CHECK_ORDER[b.row.state] || a.index - b.index)
    .map(({ row }) => row);
}

// ---------------------------------------------------------------------------
// DAQ sync flags

export const SYNC_FLAGS = [
  { key: 'frame_sync', label: 'frame' },
  { key: 'sample_delay_sync', label: 'delay' },
  { key: 'iq_sync', label: 'IQ' },
] as const;

export interface SyncFlagView {
  key: typeof SYNC_FLAGS[number]['key'];
  label: string;
  /** true passing, false failing, null not reported. */
  ok: boolean | null;
}

/** The three required DAQ sync flags from status.json, each passing, failing or missing. */
export function syncFlagsView(snapshot: TelemetrySnapshot | null | undefined): SyncFlagView[] {
  const status = record(snapshot?.status);
  const safe = record(status?.safe);
  const daq = record(safe?.daq_status) ?? record(status?.daq_status);
  return SYNC_FLAGS.map(({ key, label }) => ({ key, label, ok: bool(daq?.[key]) }));
}

// ---------------------------------------------------------------------------
// Settings shown on Diagnostics

// Whole segments that name a secret, and longer words that do anywhere in a segment.
const SECRET_SEGMENTS: ReadonlySet<string> = new Set(['pass', 'pwd', 'key', 'keys']);
const SECRET_WORDS = /password|passwd|passphrase|secret|token|credential|apikey|privatekey/;

/**
 * True for a settings key that may hold a secret. Keys are split into segments
 * on _ - . spaces and camelCase, so compass_offset is shown while password,
 * api_key, apiKey, client_secret and access_token stay hidden.
 */
export function isSecretSettingKey(key: string): boolean {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_.-]+/)
    .filter(Boolean);
  return segments.some((segment) => SECRET_SEGMENTS.has(segment) || SECRET_WORDS.test(segment));
}

// Units of the settings.json fields the collector passes (KrakenSDR's own
// units: center_freq in MHz, VFO frequency and bandwidth in Hz).
const SETTING_UNITS: Readonly<Record<string, string>> = {
  center_freq: 'MHz',
  uniform_gain: 'dB',
  ant_spacing_meters: 'm',
  compass_offset: '°',
};

/** The unit of a Data Out settings field, or null when it has none or is unknown. */
export function settingUnit(key: string): string | null {
  if (Object.prototype.hasOwnProperty.call(SETTING_UNITS, key)) return SETTING_UNITS[key];
  if (/^vfo_(freq|bw)_\d+$/.test(key)) return 'Hz';
  if (/^vfo_squelch_\d+$/.test(key)) return 'dB';
  return null;
}

/** A settings value as shown on Diagnostics: booleans as ON/OFF, a known unit appended to numbers. */
export function settingValueText(key: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'ON' : 'OFF';
  if (value === null || value === undefined) return 'N/A';
  const unit = typeof value === 'number' ? settingUnit(key) : null;
  const text = boundedText(String(value), 80) ?? '—';
  if (!unit) return text;
  return unit === '°' ? `${text}°` : `${text} ${unit}`;
}

// ---------------------------------------------------------------------------
// Collector error messages

const COLLECTOR_ERRORS: ReadonlyArray<[RegExp, (match: RegExpMatchArray) => [MessageKey, Record<string, string>?]]> = [
  [/^connection refused$/, () => ['health.error.connectionRefused']],
  [/^timed out$/, () => ['health.error.timedOut']],
  [/^host name resolution failed$/, () => ['health.error.dnsFailed']],
  [/^([a-z0-9.-]{1,253}\.local) could not be resolved \(system and mDNS\); use an IP address$/, (match) => ['health.error.localNameFailed', { host: match[1] }]],
  [/^host unreachable$/, () => ['health.error.hostUnreachable']],
  [/^network error( \(\w+\))?$/, () => ['health.error.network']],
  [/^HTTP (\d{3})$/, (match) => ['health.error.httpStatus', { code: match[1] }]],
  [/^HTTP error$/, () => ['health.error.httpError']],
  [/^HTTP redirect is not allowed$/, () => ['health.error.redirect']],
  [/^body exceeds (\d+) bytes$/, (match) => ['health.error.bodyTooLarge', { limit: match[1] }]],
  [/^invalid HTTP response( \(\w+\))?$/, () => ['health.error.protocol']],
  [/^skipped: status\.json transport failure$/, () => ['health.error.skippedStatus']],
  [/^collection deadline exceeded$/, () => ['health.error.deadline']],
  [/^resource unavailable$/, () => ['health.error.resourceUnavailable']],
  [/^invalid JSON at (\/[\w.]+)$/, (match) => ['health.error.invalidJson', { path: match[1] }]],
  [/^expected JSON object at (\/[\w.]+)$/, (match) => ['health.error.jsonObject', { path: match[1] }]],
  [/^invalid DoA XML$/, () => ['health.error.invalidXml']],
  [/^DoA CSV is not UTF-8$/, () => ['health.error.csvEncoding']],
  [/^(status|settings|resource) parse failed$/, () => ['health.error.parseFailed']],
];

export interface CollectorErrorText {
  /** Text in the UI language, or the raw message when it is not a known collector message. */
  text: string;
  /** The collector's own message, kept for a tooltip. */
  raw: string;
  known: boolean;
}

/** Translate a known collector error message; an unknown one is shown as is. */
export function collectorErrorText(t: Translate, raw: string): CollectorErrorText {
  const message = raw.trim();
  for (const [pattern, describe] of COLLECTOR_ERRORS) {
    const match = message.match(pattern);
    if (!match) continue;
    const [key, vars] = describe(match);
    return { text: t(key, vars), raw: message, known: true };
  }
  return { text: message, raw: message, known: false };
}

// ---------------------------------------------------------------------------
// Localized durations (AUD-99)

export type DurationUnit = 'ms' | 's' | 'min' | 'h';

export function durationParts(ms: number): { unit: DurationUnit; value: string } {
  const bounded = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (bounded < 1000) return { unit: 'ms', value: String(Math.round(bounded)) };
  if (bounded < 60_000) return { unit: 's', value: (bounded / 1000).toFixed(1) };
  if (bounded < 3_600_000) return { unit: 'min', value: String(Math.floor(bounded / 60_000)) };
  return { unit: 'h', value: String(Math.floor(bounded / 3_600_000)) };
}

const DURATION_KEYS: Record<DurationUnit, MessageKey> = {
  ms: 'common.durationMs',
  s: 'common.durationS',
  min: 'common.durationMin',
  h: 'common.durationH',
};

export function formatDuration(t: Translate, ms: number): string {
  const { unit, value } = durationParts(ms);
  return t(DURATION_KEYS[unit], { value });
}

const COUNT_FORMATS: Record<string, Intl.NumberFormat> = {};

/** An integer count with the UI language's thousands separator (1,204 / 1.204), or N/A. */
export function formatCount(lang: string, value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'N/A';
  const locale = lang === 'id' ? 'id-ID' : 'en-US';
  COUNT_FORMATS[locale] ??= new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return COUNT_FORMATS[locale].format(Math.round(value));
}

/** Age at read in the UI language, or the explicit unknown-clock wording. */
export function formatAgeText(t: Translate, freshness: Freshness | null | undefined): string {
  const seconds = ageSeconds(freshness);
  return seconds === null ? t('readout.clockUnverified') : t('common.durationS', { value: seconds.toFixed(1) });
}
