/**
 * Client of the LAN view's read-only Records routes: the answer parsers, the URL
 * builders and a request queue that sends one read at a time, as the console allows a
 * LAN client (tools/lan_access.py: one list read per client, pages of at most
 * RECORDS_PAGE_MAX rows). It sends ids and filters only, never a path.
 *
 * The types, value checks, parsers and URL builders are copied from the Receiver's
 * tools/browsdr_receiver_overlay/src/client/app/records-archive-api.ts (and its
 * browserTimeZone/browserUtcOffsetMinutes), unchanged but for indentation;
 * tools/test_receiver_records_contract.mjs compares the two. Change both together.
 */
import type { ArchiveKind } from './recordsArchiveFormat';

/**
 * Client for the console's Records archive routes (/api/receiver/archive/*) and the
 * archive part of /api/receiver/settings: typed requests, URL builders and the parsers
 * that check every answer. The client sends ids and filters only, never a path.
 * No Vue import and no window access at module level, so node --test can load it.
 */
export const RECEIVER_API_ROOT = '/api/receiver';
export const ARCHIVE_API_ROOT = '/api/receiver/archive';

/** Rows per page, the most the LAN view answers (lan_access.RECORDS_PAGE_MAX). */
export const RECORDS_PAGE_SIZE = 50;
const READ_TIMEOUT_MS = 10_000;
/** A busy answer (LAN_RECORDS_BUSY, another tab's read) is tried again this often after Retry-After. */
const BUSY_RETRIES = 2;
const BUSY_RETRY_MS = 1000;

export interface ArchiveFacets {
  vfo_indices: number[];
  modes: string[];
  bandwidths_hz: number[];
  sources: string[];
  statuses: string[];
  min_frequency_hz: number | null;
  max_frequency_hz: number | null;
  totals: { audio: number; scan: number; bytes: number };
  first_ms: number | null;
  last_ms: number | null;
  free_bytes: number | null;
  now_ms: number;
}

export interface ArchiveCalendar {
  days: Array<{ audio: number; scan: number }>;
  first_ms: number | null;
  last_ms: number | null;
  now_ms: number;
  truncated: boolean;
}

export interface ArchiveTimeline {
  from_ms: number;
  to_ms: number;
  now_ms: number;
  audio: Array<[number, number]>;
  scan: Array<[number, number]>;
  counts: { audio: number; scan: number };
  truncated: boolean;
}

export interface ArchiveItem {
  kind: ArchiveKind;
  id: string;
  session_id: string | null;
  start: string;
  end: string | null;
  start_ms: number;
  end_ms: number | null;
  duration_s: number | null;
  bytes: number;
  estimated_bytes: number;
  status: string;
  error: string;
  playable: boolean;
  previewable: boolean;
  downloadable: boolean;
  deletable: boolean;
  vfo_index: number | null;
  frequency_hz: number | null;
  mode: string | null;
  bandwidth_hz: number | null;
  codec: string | null;
  source: string | null;
  start_hz: number | null;
  end_hz: number | null;
  fft_size: number | null;
  trace_count: number | null;
  candidate_count: number | null;
  trace_upload_failures: number | null;
}

export interface ArchiveTotals {
  audio: number;
  scan: number;
  bytes: number;
  estimated_bytes: number;
}

export interface ArchiveItemsPage {
  items: ArchiveItem[];
  total: number;
  totals: ArchiveTotals;
  offset: number;
  limit: number;
  now_ms: number;
}

export interface ArchivePreviewCandidate {
  frequency_hz: number | null;
  peak_db: number | null;
  snr_db: number | null;
  bandwidth_hz: number | null;
}

export interface ArchiveScanPreview {
  id: string;
  start_hz: number | null;
  end_hz: number | null;
  bins: number;
  trace_format: number | null;
  trace_count: number;
  traces_used: number;
  traces_skipped: number;
  max_db: number[];
  mean_db: number[];
  candidates: ArchivePreviewCandidate[];
}

// ── Value checks ─────────────────────────────────────────────────────────

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  const text = stringValue(value, label);
  if (!text) throw new TypeError(`${label} must not be empty.`);
  return text;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : stringValue(value, label);
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number.`);
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null || value === undefined ? null : numberValue(value, label);
}

function integerValue(value: unknown, label: string): number {
  const number = numberValue(value, label);
  if (!Number.isInteger(number)) throw new TypeError(`${label} must be an integer.`);
  return number;
}

function countValue(value: unknown, label: string): number {
  const number = integerValue(value, label);
  if (number < 0) throw new TypeError(`${label} must not be negative.`);
  return number;
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null || value === undefined ? null : integerValue(value, label);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean.`);
  return value;
}

function kindValue(value: unknown, label: string): ArchiveKind {
  if (value !== 'audio' && value !== 'scan') throw new TypeError(`${label} must be audio or scan.`);
  return value;
}

function intervals(value: unknown, label: string): Array<[number, number]> {
  return arrayValue(value, label).map((entry, index) => {
    const pair = arrayValue(entry, `${label}[${index}]`);
    if (pair.length !== 2) throw new TypeError(`${label}[${index}] must be a [start, end] pair.`);
    const start = integerValue(pair[0], `${label}[${index}] start`);
    const end = integerValue(pair[1], `${label}[${index}] end`);
    if (end < start) throw new TypeError(`${label}[${index}] ends before it starts.`);
    return [start, end] as [number, number];
  });
}

// ── Parsers ──────────────────────────────────────────────────────────────

export function parseArchiveFacets(value: unknown): ArchiveFacets {
  const row = objectValue(value, 'Archive facets');
  const totals = objectValue(row.totals, 'Archive facet totals');
  return {
    vfo_indices: arrayValue(row.vfo_indices, 'vfo_indices').map((entry, index) => countValue(entry, `vfo_indices[${index}]`)),
    modes: arrayValue(row.modes, 'modes').map((entry, index) => nonEmptyString(entry, `modes[${index}]`)),
    bandwidths_hz: arrayValue(row.bandwidths_hz, 'bandwidths_hz').map((entry, index) => numberValue(entry, `bandwidths_hz[${index}]`)),
    sources: arrayValue(row.sources, 'sources').map((entry, index) => stringValue(entry, `sources[${index}]`)),
    statuses: arrayValue(row.statuses, 'statuses').map((entry, index) => nonEmptyString(entry, `statuses[${index}]`)),
    min_frequency_hz: nullableNumber(row.min_frequency_hz, 'min_frequency_hz'),
    max_frequency_hz: nullableNumber(row.max_frequency_hz, 'max_frequency_hz'),
    totals: {
      audio: countValue(totals.audio, 'totals audio'),
      scan: countValue(totals.scan, 'totals scan'),
      bytes: countValue(totals.bytes, 'totals bytes'),
    },
    first_ms: nullableInteger(row.first_ms, 'first_ms'),
    last_ms: nullableInteger(row.last_ms, 'last_ms'),
    free_bytes: row.free_bytes === null ? null : countValue(row.free_bytes, 'free_bytes'),
    now_ms: integerValue(row.now_ms, 'now_ms'),
  };
}

export function parseArchiveCalendar(value: unknown, expectedDays?: number): ArchiveCalendar {
  const row = objectValue(value, 'Archive calendar');
  const days = arrayValue(row.days, 'calendar days').map((entry, index) => {
    const day = objectValue(entry, `calendar days[${index}]`);
    return { audio: countValue(day.audio, `days[${index}] audio`), scan: countValue(day.scan, `days[${index}] scan`) };
  });
  if (expectedDays !== undefined && days.length !== expectedDays) throw new TypeError(`Archive calendar must have ${expectedDays} days.`);
  return {
    days,
    first_ms: nullableInteger(row.first_ms, 'first_ms'),
    last_ms: nullableInteger(row.last_ms, 'last_ms'),
    now_ms: integerValue(row.now_ms, 'now_ms'),
    truncated: booleanValue(row.truncated, 'truncated'),
  };
}

export function parseArchiveTimeline(value: unknown): ArchiveTimeline {
  const row = objectValue(value, 'Archive timeline');
  const counts = objectValue(row.counts, 'timeline counts');
  return {
    from_ms: integerValue(row.from_ms, 'from_ms'),
    to_ms: integerValue(row.to_ms, 'to_ms'),
    now_ms: integerValue(row.now_ms, 'now_ms'),
    audio: intervals(row.audio, 'timeline audio'),
    scan: intervals(row.scan, 'timeline scan'),
    counts: { audio: countValue(counts.audio, 'counts audio'), scan: countValue(counts.scan, 'counts scan') },
    truncated: booleanValue(row.truncated, 'truncated'),
  };
}

export function parseArchiveItem(value: unknown): ArchiveItem {
  const row = objectValue(value, 'Archive item');
  const item: ArchiveItem = {
    kind: kindValue(row.kind, 'item kind'),
    id: nonEmptyString(row.id, 'item id'),
    session_id: nullableString(row.session_id, 'item session_id'),
    start: nonEmptyString(row.start, 'item start'),
    end: nullableString(row.end, 'item end'),
    start_ms: integerValue(row.start_ms, 'item start_ms'),
    end_ms: nullableInteger(row.end_ms, 'item end_ms'),
    duration_s: nullableNumber(row.duration_s, 'item duration_s'),
    bytes: countValue(row.bytes, 'item bytes'),
    estimated_bytes: countValue(row.estimated_bytes, 'item estimated_bytes'),
    status: nonEmptyString(row.status, 'item status'),
    error: stringValue(row.error, 'item error'),
    playable: booleanValue(row.playable, 'item playable'),
    previewable: booleanValue(row.previewable, 'item previewable'),
    downloadable: booleanValue(row.downloadable, 'item downloadable'),
    deletable: booleanValue(row.deletable, 'item deletable'),
    vfo_index: nullableInteger(row.vfo_index, 'item vfo_index'),
    frequency_hz: nullableNumber(row.frequency_hz, 'item frequency_hz'),
    mode: nullableString(row.mode, 'item mode'),
    bandwidth_hz: nullableNumber(row.bandwidth_hz, 'item bandwidth_hz'),
    codec: nullableString(row.codec, 'item codec'),
    source: nullableString(row.source, 'item source'),
    start_hz: nullableNumber(row.start_hz, 'item start_hz'),
    end_hz: nullableNumber(row.end_hz, 'item end_hz'),
    fft_size: nullableInteger(row.fft_size, 'item fft_size'),
    trace_count: nullableInteger(row.trace_count, 'item trace_count'),
    candidate_count: nullableInteger(row.candidate_count, 'item candidate_count'),
    trace_upload_failures: nullableInteger(row.trace_upload_failures, 'item trace_upload_failures'),
  };
  return Object.freeze(item);
}

function parseTotals(value: unknown): ArchiveTotals {
  const totals = objectValue(value, 'Archive totals');
  return {
    audio: countValue(totals.audio, 'totals audio'),
    scan: countValue(totals.scan, 'totals scan'),
    bytes: countValue(totals.bytes, 'totals bytes'),
    estimated_bytes: countValue(totals.estimated_bytes, 'totals estimated_bytes'),
  };
}

export function parseArchiveItems(value: unknown): ArchiveItemsPage {
  const row = objectValue(value, 'Archive items');
  return {
    items: Object.freeze(arrayValue(row.items, 'items').map(parseArchiveItem)) as ArchiveItem[],
    total: countValue(row.total, 'total'),
    totals: parseTotals(row.totals),
    offset: countValue(row.offset, 'offset'),
    limit: countValue(row.limit, 'limit'),
    now_ms: integerValue(row.now_ms, 'now_ms'),
  };
}

function dbSeries(value: unknown, label: string): number[] {
  return arrayValue(value, label).map((entry, index) => numberValue(entry, `${label}[${index}]`));
}

export function parseArchiveScanPreview(value: unknown): ArchiveScanPreview {
  const row = objectValue(value, 'Scan preview');
  const maxDb = dbSeries(row.max_db, 'max_db');
  const meanDb = dbSeries(row.mean_db, 'mean_db');
  if (maxDb.length !== meanDb.length) throw new TypeError('Scan preview max_db and mean_db must have one length.');
  const candidates = arrayValue(row.candidates, 'candidates').map((entry, index) => {
    const candidate = objectValue(entry, `candidates[${index}]`);
    return {
      frequency_hz: nullableNumber(candidate.frequency_hz, `candidates[${index}] frequency_hz`),
      peak_db: nullableNumber(candidate.peak_db, `candidates[${index}] peak_db`),
      snr_db: nullableNumber(candidate.snr_db, `candidates[${index}] snr_db`),
      bandwidth_hz: nullableNumber(candidate.bandwidth_hz, `candidates[${index}] bandwidth_hz`),
    };
  });
  return {
    id: nonEmptyString(row.id, 'preview id'),
    start_hz: nullableNumber(row.start_hz, 'start_hz'),
    end_hz: nullableNumber(row.end_hz, 'end_hz'),
    bins: countValue(row.bins, 'bins'),
    trace_format: nullableInteger(row.trace_format, 'trace_format'),
    trace_count: countValue(row.trace_count, 'trace_count'),
    traces_used: countValue(row.traces_used, 'traces_used'),
    traces_skipped: countValue(row.traces_skipped, 'traces_skipped'),
    max_db: maxDb,
    mean_db: meanDb,
    candidates: candidates.slice(0, 10),
  };
}

// ── URLs ─────────────────────────────────────────────────────────────────

/** The browser's current UTC offset, used by the console when its tz database lacks the zone. */
export function browserUtcOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function encodeId(id: string): string {
  return encodeURIComponent(id);
}

/** The browser's zone and current offset; they only shape downloaded file names. */
export function zoneQuery(timeZone = browserTimeZone(), utcOffsetMinutes = browserUtcOffsetMinutes()): string {
  return new URLSearchParams({ time_zone: timeZone, utc_offset_minutes: String(utcOffsetMinutes) }).toString();
}

/** Playback (with Range) of a stored segment. */
export function audioPlaybackUrl(segmentId: string): string {
  return `${RECEIVER_API_ROOT}/audio-segments/${encodeId(segmentId)}/audio`;
}

export function audioDownloadUrl(segmentId: string, timeZone?: string, utcOffsetMinutes?: number): string {
  return `${ARCHIVE_API_ROOT}/audio/${encodeId(segmentId)}/download?${zoneQuery(timeZone, utcOffsetMinutes)}`;
}

export function scanDownloadUrl(scanId: string, timeZone?: string, utcOffsetMinutes?: number): string {
  return `${ARCHIVE_API_ROOT}/scans/${encodeId(scanId)}/download?${zoneQuery(timeZone, utcOffsetMinutes)}`;
}

export function downloadUrl(kind: ArchiveKind, id: string, timeZone?: string, utcOffsetMinutes?: number): string {
  return kind === 'audio' ? audioDownloadUrl(id, timeZone, utcOffsetMinutes) : scanDownloadUrl(id, timeZone, utcOffsetMinutes);
}

// ── Requests ─────────────────────────────────────────────────────────────

/** A refused or failed Records read: the console's code ({ok: false, code, error}), TIMEOUT or NETWORK. */
export class RecordsRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code = '') {
    super(message);
    this.name = 'RecordsRequestError';
    this.status = status;
    this.code = code;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function abortError(): DOMException {
  return new DOMException('The read was cancelled.', 'AbortError');
}

export interface RecordsClient {
  facets(signal?: AbortSignal): Promise<ArchiveFacets>;
  calendar(bounds: readonly number[], type: string, signal?: AbortSignal): Promise<ArchiveCalendar>;
  timeline(params: URLSearchParams, signal?: AbortSignal): Promise<ArchiveTimeline>;
  items(params: URLSearchParams, signal?: AbortSignal): Promise<ArchiveItemsPage>;
  scanPreview(scanId: string, signal?: AbortSignal): Promise<ArchiveScanPreview>;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface RecordsClientEnv {
  fetch(input: string, init: RequestInit): Promise<Response>;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const browserEnv: RecordsClientEnv = {
  fetch: (input, init) => fetch(input, init),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

function pause(env: RecordsClientEnv, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      env.clearTimeout(timer);
      reject(abortError());
    };
    const timer = env.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A client whose reads run one at a time, in the order asked: the console takes one
 * Records list read per LAN client and makes a second one wait. A read aborted while
 * it waits in the queue never goes out; a busy answer (another tab of the same
 * tablet) is tried again after a second, twice.
 */
export function createRecordsClient(env: RecordsClientEnv = browserEnv): RecordsClient {
  let queue: Promise<unknown> = Promise.resolve();

  async function send<T>(path: string, parse: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw abortError();
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = env.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, READ_TIMEOUT_MS);
      let status: number;
      let text: string;
      try {
        const response = await env.fetch(`${RECEIVER_API_ROOT}${path}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        status = response.status;
        text = await response.text();
      } catch (error: unknown) {
        if (signal?.aborted) throw abortError();
        if (timedOut) throw new RecordsRequestError('The console did not answer in time.', 0, 'TIMEOUT');
        throw new RecordsRequestError(error instanceof Error ? error.message : String(error), 0, 'NETWORK');
      } finally {
        env.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (status >= 200 && status < 300) return parse(body);
      const row = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
      const code = typeof row.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(row.code) ? row.code : '';
      if (code === 'LAN_RECORDS_BUSY' && attempt < BUSY_RETRIES) {
        await pause(env, BUSY_RETRY_MS, signal);
        continue;
      }
      const message = typeof row.error === 'string' && row.error ? row.error : `request failed (${status})`;
      throw new RecordsRequestError(message, status, code);
    }
  }

  function enqueue<T>(path: string, parse: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
    const run = queue.then(() => send(path, parse, signal));
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    facets: (signal) => enqueue('/archive/facets', parseArchiveFacets, signal),
    calendar(bounds, type, signal) {
      const params = new URLSearchParams({ bounds: bounds.join(',') });
      if (type !== 'all') params.set('type', type);
      return enqueue(`/archive/calendar?${params.toString()}`, (value) => parseArchiveCalendar(value, bounds.length - 1), signal);
    },
    timeline: (params, signal) => enqueue(`/archive/timeline?${params.toString()}`, parseArchiveTimeline, signal),
    items: (params, signal) => enqueue(`/archive/items?${params.toString()}`, parseArchiveItems, signal),
    scanPreview: (scanId, signal) => enqueue(`/archive/scans/${encodeId(scanId)}/preview`, parseArchiveScanPreview, signal),
  };
}
