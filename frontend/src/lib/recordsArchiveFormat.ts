/**
 * Pure helpers of the LAN view's read-only Records tab (components/records/RecordsTab.tsx):
 * local day bounds, the calendar grid, cached date formatters, size/duration/frequency
 * text, timeline geometry, filter serialisation, paging and the scan preview trace.
 *
 * The declarations below are copied from the Receiver's own Records
 * (tools/browsdr_receiver_overlay/src/client/app/records-archive-format.ts), unchanged
 * but for indentation, so the tablet asks and shows what the groundstation does;
 * tools/test_receiver_records_contract.mjs compares the two. Change both together.
 *
 * Day bounds are the browser's own local midnights (new Date(y, m - 1, d)); the
 * console never needs the time zone to answer a calendar, timeline or items query.
 */

/** The console's archive error codes (receiver_archive.ARCHIVE_ERROR_CODES), as the Receiver lists them. */
export const ARCHIVE_ERROR_CODES = [
  'ORIGIN_REJECTED',
  'ARCHIVE_INVALID_REQUEST',
  'ARCHIVE_NOT_FOUND',
  'ARCHIVE_FILE_MISSING',
  'ARCHIVE_ITEM_ACTIVE',
  'ARCHIVE_SELECTION_CHANGED',
  'ARCHIVE_TOO_MANY_ITEMS',
  'ARCHIVE_EXPORT_TOO_LARGE',
  'ARCHIVE_EXPORT_BUSY',
  'RETENTION_INVALID',
  'RETENTION_CONFIRM_REQUIRED',
  'ARCHIVE_STORAGE_ERROR',
] as const;

export const SEARCH_MAX_LENGTH = 64;

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

export type ArchiveKind = 'audio' | 'scan';
export type ArchiveTypeFilter = 'all' | 'audio' | 'scan';
export type ArchiveViewMode = 'day' | 'range' | 'all';
export type ArchiveSortKey = 'start' | 'end' | 'duration' | 'frequency' | 'size' | 'type' | 'status';

/** Status filter values, in menu order, with their untranslated chip codes. */
export const ARCHIVE_STATUSES: ReadonlyArray<readonly [string, string]> = [
  ['complete', 'COMPLETE'],
  ['stopped', 'STOPPED'],
  ['partial', 'PARTIAL'],
  ['interrupted', 'INTERRUPTED'],
  ['failed', 'FAILED'],
  ['recording', 'REC'],
  ['running', 'SCANNING'],
];

const STATUS_CODES: Readonly<Record<string, string>> = Object.fromEntries(ARCHIVE_STATUSES);

export function statusCode(status: string): string {
  return STATUS_CODES[status] ?? status.toUpperCase();
}

// ── Calendar dates ───────────────────────────────────────────────────────
// Dates are 'YYYY-MM-DD' keys. Calendar arithmetic uses day numbers, so a local day
// removed by a zone change (Pacific/Apia, 2011-12-30) is still a grid cell.

// Dates are 'YYYY-MM-DD' keys. Calendar arithmetic uses day numbers, so a local day
// removed by a zone change (Pacific/Apia, 2011-12-30) is still a grid cell.
export interface DateParts {
  year: number;
  month: number;
  day: number;
}

/** Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's days_from_civil). */
export function dayNumber(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function dateFromDayNumber(days: number): DateParts {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

export function formatDateKey(parts: DateParts): string {
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function parseDateKey(key: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const round = dateFromDayNumber(dayNumber(parts.year, parts.month, parts.day));
  return round.year === parts.year && round.month === parts.month && round.day === parts.day ? parts : null;
}

function requireDateKey(key: string): DateParts {
  const parts = parseDateKey(key);
  if (!parts) throw new TypeError(`Invalid date key: ${key}`);
  return parts;
}

export function dateKeyDayNumber(key: string): number {
  const parts = requireDateKey(key);
  return dayNumber(parts.year, parts.month, parts.day);
}

export function addDays(key: string, days: number): string {
  return formatDateKey(dateFromDayNumber(dateKeyDayNumber(key) + days));
}

/** The local calendar date of an instant. */
export function localDateKey(ms: number): string {
  const date = new Date(ms);
  return formatDateKey({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() });
}

export function monthKeyOf(dateKey: string): string {
  return dateKey.slice(0, 7);
}

export function addMonths(monthKey: string, months: number): string {
  const [year, month] = monthKey.split('-').map(Number);
  const index = year * 12 + (month - 1) + months;
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}`;
}

/** The browser's local midnight that starts a calendar date. */
export function localMidnight(key: string): number {
  const parts = requireDateKey(key);
  const date = new Date(parts.year, parts.month - 1, parts.day);
  if (parts.year < 100) date.setFullYear(parts.year, parts.month - 1, parts.day);
  return date.getTime();
}

/** A local time on a calendar date; times in a DST gap move forward as Date does. */
export function localTimeOn(key: string, hours: number, minutes: number): number {
  const parts = requireDateKey(key);
  const date = new Date(parts.year, parts.month - 1, parts.day, hours, minutes);
  if (parts.year < 100) date.setFullYear(parts.year, parts.month - 1, parts.day);
  return date.getTime();
}

export interface DayBounds {
  startMs: number;
  endMs: number;
}

/** From this date's local midnight to the next one; empty for a day the zone skipped. */
export function localDayBounds(key: string): DayBounds {
  return { startMs: localMidnight(key), endMs: localMidnight(addDays(key, 1)) };
}

export function dayExists(key: string): boolean {
  const bounds = localDayBounds(key);
  return bounds.endMs > bounds.startMs;
}

/** The next existing date in a direction (skips a day removed by a zone change). */
export function shiftExistingDay(key: string, direction: number): string {
  let next = addDays(key, direction);
  for (let guard = 0; guard < 3 && !dayExists(next); guard++) next = addDays(next, direction);
  return next;
}

export interface CalendarCell {
  key: string;
  day: number;
  inMonth: boolean;
  startMs: number;
  endMs: number;
  /** Index into the calendar answer's days, or -1 for a day the zone skipped. */
  interval: number;
}

export interface CalendarGrid {
  month: string;
  cells: CalendarCell[];
  /** Strictly increasing local midnights for /archive/calendar (43, or fewer when a day was skipped). */
  bounds: number[];
}

/** The 6x7 grid of a month, Sunday first, with the midnights the console counts records in. */
export function calendarGrid(monthKey: string): CalendarGrid {
  const first = dateKeyDayNumber(`${monthKey}-01`);
  const weekday = ((first + 4) % 7 + 7) % 7;
  const gridStart = first - weekday;
  const month = Number(monthKey.slice(5, 7));
  const midnights: number[] = [];
  const keys: string[] = [];
  for (let index = 0; index <= 42; index++) {
    const key = formatDateKey(dateFromDayNumber(gridStart + index));
    keys.push(key);
    midnights.push(localMidnight(key));
  }
  const bounds: number[] = [];
  for (const value of midnights) {
    if (!bounds.length || value > bounds[bounds.length - 1]) bounds.push(value);
  }
  const cells: CalendarCell[] = [];
  for (let index = 0; index < 42; index++) {
    const parts = requireDateKey(keys[index]);
    const startMs = midnights[index];
    const endMs = midnights[index + 1];
    const position = endMs > startMs ? bounds.indexOf(startMs) : -1;
    cells.push({
      key: keys[index],
      day: parts.day,
      inMonth: parts.month === month,
      startMs,
      endMs,
      interval: position >= 0 && bounds[position + 1] === endMs ? position : -1,
    });
  }
  return { month: monthKey, cells, bounds };
}

// ── Formatting ───────────────────────────────────────────────────────────

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** One Intl.DateTimeFormat per (locale, options); building them per cell is slow. */
export function formatterFor(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? 'default'}|${JSON.stringify(options)}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    formatterCache.set(key, formatter);
  }
  return formatter;
}

export function clearFormatterCache(): void {
  formatterCache.clear();
}

export const TIME_FORMAT: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
export const HOUR_FORMAT: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
export const SHORT_DATE_FORMAT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
/** A time on a neighbouring day of the one shown in Day mode. */
export const DAY_MONTH_FORMAT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
export const LONG_DATE_FORMAT: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
export const MONTH_FORMAT: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' };

export function formatTime(ms: number, locale: string | undefined): string {
  return formatterFor(locale, TIME_FORMAT).format(ms);
}

export function formatHour(ms: number, locale: string | undefined): string {
  return formatterFor(locale, HOUR_FORMAT).format(ms);
}

export function formatShortDate(ms: number, locale: string | undefined): string {
  return formatterFor(locale, SHORT_DATE_FORMAT).format(ms);
}

/** Noon of a date, for labels that must not shift at a DST midnight. */
export function dateKeyNoon(key: string): number {
  return localTimeOn(key, 12, 0);
}

export function formatDateKeyLabel(key: string, locale: string | undefined, options: Intl.DateTimeFormatOptions = LONG_DATE_FORMAT): string {
  return formatterFor(locale, options).format(dateKeyNoon(key));
}

export function formatMonthLabel(monthKey: string, locale: string | undefined): string {
  return formatterFor(locale, MONTH_FORMAT).format(dateKeyNoon(`${monthKey}-01`));
}

/** H:MM:SS. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours}:${pad(minutes)}:${pad(total % 60)}`;
}

/** B below 1 KiB, otherwise KiB, MiB or GiB with one decimal. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function formatAudioMHz(frequencyHz: number | null): string {
  return frequencyHz === null ? '—' : `${(frequencyHz / 1_000_000).toFixed(6)} MHz`;
}

export function formatScanRange(startHz: number | null, endHz: number | null): string {
  if (startHz === null || endHz === null) return '—';
  return `${(startHz / 1_000_000).toFixed(3)}–${(endHz / 1_000_000).toFixed(3)} MHz`;
}

/** Bin width of a 20 MSPS scan. */
export function formatScanResolution(fftSize: number | null): string {
  if (fftSize === null || !Number.isFinite(fftSize) || fftSize <= 0) return '—';
  return `${(20e6 / fftSize / 1000).toFixed(2)} kHz`;
}

export function formatBandwidth(bandwidthHz: number | null): string {
  if (bandwidthHz === null || !Number.isFinite(bandwidthHz)) return '—';
  if (bandwidthHz >= 1_000_000) return `${Number((bandwidthHz / 1_000_000).toFixed(3))} MHz`;
  return `${Number((bandwidthHz / 1000).toFixed(3))} kHz`;
}

// ── Timeline ─────────────────────────────────────────────────────────────
// The strip spans one local day; the SVG viewBox is one unit per minute, so a 23 h,
// 24 h or 25 h day is 1380, 1440 or 1500 units wide.

// The strip spans one local day; the SVG viewBox is one unit per minute, so a 23 h,
// 24 h or 25 h day is 1380, 1440 or 1500 units wide.
export interface TimelineBar {
  x: number;
  width: number;
}

export interface TimelineTick {
  ms: number;
  pct: number;
  label: string;
  /** Hidden at 760 px and below, where a label shows every 6 h. */
  minor: boolean;
}

export function timelineWidth(dayStartMs: number, dayEndMs: number): number {
  return Math.max(1, (dayEndMs - dayStartMs) / MINUTE_MS);
}

export function timelineX(ms: number, dayStartMs: number, dayEndMs: number): number {
  const clamped = Math.min(dayEndMs, Math.max(dayStartMs, ms));
  return (clamped - dayStartMs) / MINUTE_MS;
}

/** Bars for clipped intervals, at least 1/360 of the day wide so one short item stays visible. */
export function timelineBars(intervals: ReadonlyArray<readonly [number, number]>, dayStartMs: number, dayEndMs: number): TimelineBar[] {
  const width = timelineWidth(dayStartMs, dayEndMs);
  const minimum = width / 360;
  const bars: TimelineBar[] = [];
  for (const [start, end] of intervals) {
    if (end < dayStartMs || start > dayEndMs) continue;
    const x0 = timelineX(start, dayStartMs, dayEndMs);
    const x1 = timelineX(end, dayStartMs, dayEndMs);
    const barWidth = Math.max(minimum, x1 - x0);
    bars.push({ x: Math.max(0, Math.min(x0, width - barWidth)), width: barWidth });
  }
  return bars;
}

/** Grid lines at every absolute hour after the day start. */
export function timelineHourLines(dayStartMs: number, dayEndMs: number): number[] {
  const lines: number[] = [];
  for (let ms = dayStartMs + HOUR_MS; ms < dayEndMs; ms += HOUR_MS) lines.push((ms - dayStartMs) / MINUTE_MS);
  return lines;
}

/** A label every 3 absolute hours from the day start, named by the local clock. */
export function timelineTicks(dayStartMs: number, dayEndMs: number, label: (ms: number) => string): TimelineTick[] {
  const ticks: TimelineTick[] = [];
  const length = dayEndMs - dayStartMs;
  for (let index = 0; dayStartMs + index * 3 * HOUR_MS < dayEndMs; index++) {
    const ms = dayStartMs + index * 3 * HOUR_MS;
    ticks.push({ ms, pct: ((ms - dayStartMs) / length) * 100, label: label(ms), minor: index % 2 === 1 });
  }
  return ticks;
}

export interface TimeRange {
  startMs: number;
  endMs: number;
}

/** The local hour that contains a point of the strip. */
export function hourContaining(ms: number, dayStartMs: number, dayEndMs: number): TimeRange {
  const date = new Date(Math.min(dayEndMs - 1, Math.max(dayStartMs, ms)));
  date.setMinutes(0, 0, 0);
  const startMs = Math.max(dayStartMs, date.getTime());
  return { startMs, endMs: Math.min(dayEndMs, startMs + HOUR_MS) };
}

// ── Filters ──────────────────────────────────────────────────────────────

export interface ArchiveFilters {
  type: ArchiveTypeFilter;
  status: string;
  minMHz: string;
  maxMHz: string;
  vfo: string;
  mode: string;
  bandwidth: string;
  q: string;
  /** Range mode's time of day (local), 'HH:MM'. */
  timeFrom: string;
  timeTo: string;
}

export function emptyFilters(): ArchiveFilters {
  return { type: 'all', status: '', minMHz: '', maxMHz: '', vfo: '', mode: '', bandwidth: '', q: '', timeFrom: '', timeTo: '' };
}

/** A MHz field in Hz: undefined when empty, null when it is not a usable frequency. */
export function parseMHzField(value: string): number | null | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const mhz = Number(text);
  if (!Number.isFinite(mhz) || mhz < 0) return null;
  const hz = Math.round(mhz * 1_000_000);
  return hz <= 1e12 ? hz : null;
}

export function frequencyFieldErrors(filters: ArchiveFilters): { min: boolean; max: boolean } {
  const min = parseMHzField(filters.minMHz);
  const max = parseMHzField(filters.maxMHz);
  const order = typeof min === 'number' && typeof max === 'number' && min > max;
  return { min: min === null || order, max: max === null || order };
}

function audioOnlyFilterSet(filters: ArchiveFilters): boolean {
  return Boolean(filters.vfo || filters.mode || filters.bandwidth);
}

/** The type the query uses: VFO, mode or bandwidth filters leave scans out. */
export function effectiveType(filters: ArchiveFilters): ArchiveTypeFilter {
  if (filters.type === 'all' && audioOnlyFilterSet(filters)) return 'audio';
  return filters.type;
}

/** Filter fields the console takes, with empty and unusable fields left out. */
export function filterFields(filters: ArchiveFilters): Record<string, string | number> {
  const fields: Record<string, string | number> = {};
  const type = effectiveType(filters);
  if (type !== 'all') fields.type = type;
  if (filters.status) fields.status = filters.status;
  const errors = frequencyFieldErrors(filters);
  const min = parseMHzField(filters.minMHz);
  const max = parseMHzField(filters.maxMHz);
  if (typeof min === 'number' && !errors.min) fields.min_frequency_hz = min;
  if (typeof max === 'number' && !errors.max) fields.max_frequency_hz = max;
  if (type !== 'scan') {
    const vfo = Number(filters.vfo);
    if (filters.vfo !== '' && Number.isInteger(vfo) && vfo >= 0 && vfo <= 63) fields.vfo_index = vfo;
    const mode = filters.mode.trim().toLowerCase();
    if (/^[a-z0-9_-]{1,16}$/.test(mode)) fields.mode = mode;
    const bandwidth = Number(filters.bandwidth);
    if (filters.bandwidth !== '' && Number.isFinite(bandwidth) && bandwidth >= 0 && bandwidth <= 1e9) fields.bandwidth_hz = bandwidth;
  }
  const q = filters.q.trim().slice(0, SEARCH_MAX_LENGTH);
  if (q) fields.q = q;
  return fields;
}

export type ArchiveTimeQuery =
  | { kind: 'range'; fromMs: number; toMs: number }
  | { kind: 'windows'; windows: Array<[number, number]> }
  | { kind: 'all' };

function setTimeParams(params: URLSearchParams, query: ArchiveTimeQuery): void {
  if (query.kind === 'range') {
    params.set('from_ms', String(query.fromMs));
    params.set('to_ms', String(query.toMs));
  } else if (query.kind === 'windows') {
    params.set('windows', query.windows.map(([start, end]) => `${start}-${end}`).join(','));
  }
}

function setFieldParams(params: URLSearchParams, filters: ArchiveFilters): void {
  for (const [key, value] of Object.entries(filterFields(filters))) params.set(key, String(value));
}

export interface ArchivePaging {
  sort: ArchiveSortKey;
  order: 'asc' | 'desc';
  offset: number;
  limit: number;
}

export function itemsQuery(filters: ArchiveFilters, time: ArchiveTimeQuery, paging: ArchivePaging): URLSearchParams {
  const params = new URLSearchParams();
  setTimeParams(params, time);
  setFieldParams(params, filters);
  params.set('sort', paging.sort);
  params.set('order', paging.order);
  params.set('offset', String(paging.offset));
  params.set('limit', String(paging.limit));
  return params;
}

/** The strip always covers the whole day; the selection only narrows the table. */
export function timelineQuery(filters: ArchiveFilters, day: DayBounds): URLSearchParams {
  const params = new URLSearchParams();
  params.set('from_ms', String(day.startMs));
  params.set('to_ms', String(day.endMs));
  setFieldParams(params, filters);
  return params;
}

// ── Paging ───────────────────────────────────────────────────────────────

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** '1–50' of a page, or '0' for no rows. */
export function pageRangeLabel(page: number, pageSize: number, shown: number): string {
  if (shown <= 0) return '0';
  const first = page * pageSize + 1;
  return `${first}–${first + shown - 1}`;
}

/** The order a column sorts in on its first click: newest, longest and largest first. */
export function defaultSortOrder(key: ArchiveSortKey): 'asc' | 'desc' {
  return key === 'start' || key === 'end' || key === 'duration' || key === 'size' ? 'desc' : 'asc';
}

// ── Scan preview ─────────────────────────────────────────────────────────

export interface TracePlot {
  maxPoints: string;
  meanPoints: string;
  topDb: number;
  bottomDb: number;
}

/** Polyline points (x = bin, y = 0..100 from top) for the Max and Average traces. */
export function tracePlot(maxDb: readonly number[], meanDb: readonly number[]): TracePlot | null {
  const values = [...maxDb, ...meanDb].filter(Number.isFinite);
  if (!maxDb.length || !values.length) return null;
  let top = Math.ceil(Math.max(...values) / 10) * 10;
  let bottom = Math.floor(Math.min(...values) / 10) * 10;
  if (top - bottom < 10) {
    top += 5;
    bottom -= 5;
  }
  const y = (db: number) => (((top - db) / (top - bottom)) * 100).toFixed(2);
  const points = (series: readonly number[]) => series.map((db, index) => `${index},${Number.isFinite(db) ? y(db) : '100'}`).join(' ');
  return { maxPoints: points(maxDb), meanPoints: points(meanDb), topDb: top, bottomDb: bottom };
}

// ── LAN view only ────────────────────────────────────────────────────────

/**
 * The time part of a query on the tablet, which offers Day and All dates: the
 * Receiver's archiveTimeSpec(mode, date, date, timeRange, filters).query for those
 * two modes (the contract test checks it).
 */
export function recordsTimeQuery(mode: 'day' | 'all', dateKey: string, timeRange: TimeRange | null): ArchiveTimeQuery {
  if (mode === 'all' || !parseDateKey(dateKey)) return { kind: 'all' };
  const range = timeRange ?? localDayBounds(dateKey);
  return { kind: 'range', fromMs: range.startMs, toMs: Math.max(range.endMs, range.startMs + 1) };
}
