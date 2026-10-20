/**
 * Pure helpers for the Records archive (records-archive.ts): local day bounds, the
 * calendar grid, cached date formatters, size/duration/frequency text, timeline
 * geometry, the selection model, filter serialisation and the table row labels.
 * No Vue import and no window access at module level, so node --test can load it.
 *
 * Day bounds are the browser's own local midnights (new Date(y, m - 1, d)); the
 * console never needs the time zone to answer a calendar, timeline or items query.
 */

/** English text per console archive error code; shown through tm(). */
export const ARCHIVE_ERROR_TEXT: Readonly<Record<string, string>> = {
	ORIGIN_REJECTED: 'Open the Receiver from this console.',
	ARCHIVE_INVALID_REQUEST: 'Check the filter values.',
	ARCHIVE_NOT_FOUND: 'Record not found. Refresh the list.',
	ARCHIVE_FILE_MISSING: 'The audio file is missing.',
	ARCHIVE_ITEM_ACTIVE: 'Stop the recording or scan before deleting it.',
	ARCHIVE_SELECTION_CHANGED: 'The results changed. Check the selection and try again.',
	ARCHIVE_TOO_MANY_ITEMS: 'Too many records selected.',
	ARCHIVE_EXPORT_TOO_LARGE: 'The selection is too large for one ZIP.',
	ARCHIVE_EXPORT_BUSY: 'Another download is running. Try again when it finishes.',
	RETENTION_INVALID: 'Retention value is not supported.',
	RETENTION_CONFIRM_REQUIRED: 'Confirm the retention change.',
	ARCHIVE_STORAGE_ERROR: 'Receiver storage error.',
};

/** Export size estimate, equal to the console's (receiver_archive.ESTIMATE_*). */
export const ESTIMATE_AUDIO_EXTRA_BYTES = 1024;
export const ESTIMATE_SCAN_TRACE_BYTES = 16384;
export const ESTIMATE_SCAN_CANDIDATE_BYTES = 1024;
export const ESTIMATE_SCAN_EXTRA_BYTES = 8192;

export const EXPORT_MAX_ITEMS = 1000;
export const EXPORT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const DELETE_MAX_ITEMS = 2000;
export const RANGE_MAX_DAYS = 366;
export const TIME_OF_DAY_MAX_DAYS = 62;
export const PAGE_SIZES: readonly number[] = [50, 100, 200];
export const SEARCH_MAX_LENGTH = 64;
export const RETENTION_DAY_OPTIONS: readonly number[] = [1, 3, 7, 14, 30, 60, 90];
/** Option labels as t() keys. */
export const RETENTION_LABEL_KEYS: Readonly<Record<number, string>> = {
	1: '1 day',
	3: '3 days',
	7: '7 days',
	14: '14 days',
	30: '30 days',
	60: '60 days',
	90: '90 days',
};

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
export const SNAP_MS = 5 * MINUTE_MS;
export const RESIZE_STEP_MS = 15 * MINUTE_MS;

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

// ── Calendar dates ──────────────────────────────────────────────────────────
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

/** Calendar days from a to b, both included (1 for the same day). */
export function daySpan(fromKey: string, toKey: string): number {
	return dateKeyDayNumber(toKey) - dateKeyDayNumber(fromKey) + 1;
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

export function calendarBounds(monthKey: string): number[] {
	return calendarGrid(monthKey).bounds;
}

// ── Formatting ──────────────────────────────────────────────────────────────

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
export const CELL_DATE_FORMAT: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' };
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

/** Weekday labels as t() keys, Sunday first. */
export const WEEKDAY_KEYS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

export function formatCount(value: number): string {
	return String(Math.max(0, Math.trunc(value)));
}

/** Export estimate of one item, the console's formula. */
export function estimateItemBytes(kind: ArchiveKind, bytes: number, traceCount: number, candidateCount: number): number {
	if (kind === 'audio') return bytes + ESTIMATE_AUDIO_EXTRA_BYTES;
	return traceCount * ESTIMATE_SCAN_TRACE_BYTES + candidateCount * ESTIMATE_SCAN_CANDIDATE_BYTES + ESTIMATE_SCAN_EXTRA_BYTES;
}

// ── Timeline ────────────────────────────────────────────────────────────────
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

export function snapToDayStep(ms: number, dayStartMs: number, dayEndMs: number, step = SNAP_MS): number {
	const snapped = dayStartMs + Math.round((ms - dayStartMs) / step) * step;
	return Math.min(dayEndMs, Math.max(dayStartMs, snapped));
}

/** A dragged range snapped to 5 min from the day start, at least one step long. */
export function dragRange(fromMs: number, toMs: number, dayStartMs: number, dayEndMs: number): TimeRange {
	let startMs = snapToDayStep(Math.min(fromMs, toMs), dayStartMs, dayEndMs);
	let endMs = snapToDayStep(Math.max(fromMs, toMs), dayStartMs, dayEndMs);
	if (endMs - startMs < SNAP_MS) {
		endMs = Math.min(dayEndMs, startMs + SNAP_MS);
		startMs = Math.max(dayStartMs, endMs - SNAP_MS);
	}
	return { startMs, endMs };
}

/** Left/Right: move a 1 h window (or the selection) by one hour inside the day. */
export function moveWindow(range: TimeRange | null, direction: number, dayStartMs: number, dayEndMs: number): TimeRange {
	if (!range) {
		return direction > 0
			? { startMs: dayStartMs, endMs: Math.min(dayEndMs, dayStartMs + HOUR_MS) }
			: { startMs: Math.max(dayStartMs, dayEndMs - HOUR_MS), endMs: dayEndMs };
	}
	const length = Math.min(range.endMs - range.startMs, dayEndMs - dayStartMs);
	let startMs = range.startMs + direction * HOUR_MS;
	startMs = Math.min(dayEndMs - length, Math.max(dayStartMs, startMs));
	return { startMs, endMs: startMs + length };
}

/** Shift+Left/Right: change the window's end by 15 min. */
export function resizeWindow(range: TimeRange | null, direction: number, dayStartMs: number, dayEndMs: number): TimeRange {
	const base = range ?? { startMs: dayStartMs, endMs: Math.min(dayEndMs, dayStartMs + HOUR_MS) };
	const endMs = Math.min(dayEndMs, Math.max(base.startMs + RESIZE_STEP_MS, base.endMs + direction * RESIZE_STEP_MS));
	return { startMs: base.startMs, endMs: Math.max(endMs, Math.min(dayEndMs, base.startMs + SNAP_MS)) };
}

export function firstHour(dayStartMs: number, dayEndMs: number): TimeRange {
	return { startMs: dayStartMs, endMs: Math.min(dayEndMs, dayStartMs + HOUR_MS) };
}

export function lastHour(dayStartMs: number, dayEndMs: number): TimeRange {
	return { startMs: Math.max(dayStartMs, dayEndMs - HOUR_MS), endMs: dayEndMs };
}

/** 'HH:MM' of an instant on the local clock. */
export function timeFieldValue(ms: number): string {
	const date = new Date(ms);
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseTimeField(value: string): { hours: number; minutes: number } | null {
	const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	return hours <= 23 && minutes <= 59 ? { hours, minutes } : null;
}

/**
 * The timeline's From/To fields as a range on the shown day. An empty From is the day
 * start and an empty To the day end; both empty is the whole day (null range).
 */
export function timeFieldsRange(dateKey: string, from: string, to: string): { range: TimeRange | null; invalid: '' | 'from' | 'to' } {
	const day = localDayBounds(dateKey);
	if (!from.trim() && !to.trim()) return { range: null, invalid: '' };
	const fromTime = from.trim() ? parseTimeField(from) : { hours: 0, minutes: 0 };
	if (!fromTime) return { range: null, invalid: 'from' };
	const toTime = to.trim() ? parseTimeField(to) : null;
	if (to.trim() && !toTime) return { range: null, invalid: 'to' };
	const startMs = from.trim() ? localTimeOn(dateKey, fromTime.hours, fromTime.minutes) : day.startMs;
	const endMs = toTime ? localTimeOn(dateKey, toTime.hours, toTime.minutes) : day.endMs;
	if (startMs < day.startMs || startMs >= day.endMs) return { range: null, invalid: 'from' };
	if (endMs <= startMs || endMs > day.endMs) return { range: null, invalid: 'to' };
	return { range: { startMs, endMs }, invalid: '' };
}

/** The From/To field values for a selection; To is empty when it ends with the day. */
export function rangeTimeFields(range: TimeRange | null, dayEndMs: number): { from: string; to: string } {
	if (!range) return { from: '', to: '' };
	return { from: timeFieldValue(range.startMs), to: range.endMs >= dayEndMs ? '' : timeFieldValue(range.endMs) };
}

// ── Filters ─────────────────────────────────────────────────────────────────

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

/** Filters other than the dates (shown as 'Filters (n)' on a phone). */
export function activeFilterCount(filters: ArchiveFilters, mode: ArchiveViewMode): number {
	let count = 0;
	if (filters.type !== 'all') count++;
	if (filters.status) count++;
	if (filters.minMHz.trim() || filters.maxMHz.trim()) count++;
	if (filters.type !== 'scan') {
		if (filters.vfo) count++;
		if (filters.mode) count++;
		if (filters.bandwidth) count++;
	}
	if (filters.q.trim()) count++;
	if (mode === 'range' && (filters.timeFrom || filters.timeTo)) count++;
	return count;
}

export function hasFilters(filters: ArchiveFilters): boolean {
	return Boolean(filters.type !== 'all' || filters.status || filters.minMHz.trim() || filters.maxMHz.trim()
		|| filters.vfo || filters.mode || filters.bandwidth || filters.q.trim() || filters.timeFrom || filters.timeTo);
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

export type TimeOfDayState = 'off' | 'on' | 'too-many' | 'invalid' | 'disabled';

/**
 * One window per day from the range's time of day (local). A To earlier than From
 * wraps past midnight into the next day; an empty From is midnight and an empty To
 * the day's end. Null when the fields cannot make a window.
 */
export function timeOfDayWindows(fromKey: string, toKey: string, timeFrom: string, timeTo: string): Array<[number, number]> | null {
	const from = timeFrom ? parseTimeField(timeFrom) : null;
	const to = timeTo ? parseTimeField(timeTo) : null;
	if ((timeFrom && !from) || (timeTo && !to) || (!from && !to)) return null;
	const fromMinutes = from ? from.hours * 60 + from.minutes : 0;
	const toMinutes = to ? to.hours * 60 + to.minutes : null;
	if (from && to && fromMinutes === toMinutes) return null;
	const windows: Array<[number, number]> = [];
	const days = daySpan(fromKey, toKey);
	for (let index = 0; index < days; index++) {
		const key = addDays(fromKey, index);
		const day = localDayBounds(key);
		if (day.endMs <= day.startMs) continue;
		const start = from ? localTimeOn(key, from.hours, from.minutes) : day.startMs;
		let end: number;
		if (toMinutes === null) end = day.endMs;
		else if (toMinutes > fromMinutes) end = localTimeOn(key, to!.hours, to!.minutes);
		else end = localTimeOn(addDays(key, 1), to!.hours, to!.minutes);
		if (end <= start) continue;
		const previous = windows[windows.length - 1];
		if (previous && start < previous[1]) continue;
		windows.push([start, end]);
	}
	return windows.length ? windows : null;
}

export interface TimeSpec {
	query: ArchiveTimeQuery;
	timeOfDay: TimeOfDayState;
}

/** The time part of a query: the day (or its timeline selection), the range, or all dates. */
export function archiveTimeSpec(mode: ArchiveViewMode, fromDate: string, toDate: string, timeRange: TimeRange | null, filters: ArchiveFilters): TimeSpec {
	if (mode === 'all' || !parseDateKey(fromDate)) return { query: { kind: 'all' }, timeOfDay: 'disabled' };
	if (mode === 'day') {
		const day = localDayBounds(fromDate);
		const range = timeRange ?? day;
		return { query: { kind: 'range', fromMs: range.startMs, toMs: Math.max(range.endMs, range.startMs + 1) }, timeOfDay: 'disabled' };
	}
	const lastDate = parseDateKey(toDate) ? toDate : fromDate;
	const range = { kind: 'range' as const, fromMs: localMidnight(fromDate), toMs: localMidnight(addDays(lastDate, 1)) };
	if (!filters.timeFrom && !filters.timeTo) return { query: range, timeOfDay: 'off' };
	if (daySpan(fromDate, lastDate) > TIME_OF_DAY_MAX_DAYS) return { query: range, timeOfDay: 'too-many' };
	const windows = timeOfDayWindows(fromDate, lastDate, filters.timeFrom, filters.timeTo);
	if (!windows) return { query: range, timeOfDay: 'invalid' };
	return { query: { kind: 'windows', windows }, timeOfDay: 'on' };
}

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

/** The filter object of an export or delete request (JSON numbers for ms and Hz). */
export function filterBody(filters: ArchiveFilters, time: ArchiveTimeQuery): Record<string, unknown> {
	const body: Record<string, unknown> = { ...filterFields(filters) };
	if (time.kind === 'range') {
		body.from_ms = time.fromMs;
		body.to_ms = time.toMs;
	} else if (time.kind === 'windows') {
		body.windows = time.windows.map(([start, end]) => [start, end]);
	}
	return body;
}

// ── Selection ───────────────────────────────────────────────────────────────

export interface SelectableRow {
	kind: ArchiveKind;
	id: string;
	estimatedBytes: number;
	downloadable: boolean;
	deletable: boolean;
}

export interface SelectionEntry extends SelectableRow {}

export interface ArchiveSelection {
	mode: 'ids' | 'filter';
	ids: Map<string, SelectionEntry>;
	filterCount: number;
	filterEstimatedBytes: number;
}

export function selectionKey(kind: ArchiveKind, id: string): string {
	return `${kind}:${id}`;
}

export function emptySelection(): ArchiveSelection {
	return { mode: 'ids', ids: new Map(), filterCount: 0, filterEstimatedBytes: 0 };
}

/** A recording segment or a running scan can be neither downloaded nor deleted. */
export function rowSelectable(row: Pick<SelectableRow, 'downloadable' | 'deletable'>): boolean {
	return row.downloadable || row.deletable;
}

export function isRowSelected(selection: ArchiveSelection, row: SelectableRow): boolean {
	if (!rowSelectable(row)) return false;
	return selection.mode === 'filter' || selection.ids.has(selectionKey(row.kind, row.id));
}

function entryOf(row: SelectableRow): SelectionEntry {
	return { kind: row.kind, id: row.id, estimatedBytes: row.estimatedBytes, downloadable: row.downloadable, deletable: row.deletable };
}

export function toggleRowSelection(selection: ArchiveSelection, row: SelectableRow, pageRows: readonly SelectableRow[]): ArchiveSelection {
	if (!rowSelectable(row)) return selection;
	if (selection.mode === 'filter') {
		// Unticking one row of "all results" keeps the rest of this page.
		const ids = new Map<string, SelectionEntry>();
		for (const pageRow of pageRows) {
			if (rowSelectable(pageRow) && !(pageRow.kind === row.kind && pageRow.id === row.id)) ids.set(selectionKey(pageRow.kind, pageRow.id), entryOf(pageRow));
		}
		return { ...emptySelection(), ids };
	}
	const ids = new Map(selection.ids);
	const key = selectionKey(row.kind, row.id);
	if (ids.has(key)) ids.delete(key);
	else ids.set(key, entryOf(row));
	return { ...selection, ids };
}

export function pageSelectionState(selection: ArchiveSelection, pageRows: readonly SelectableRow[]): 'none' | 'some' | 'all' {
	const selectable = pageRows.filter(rowSelectable);
	if (!selectable.length) return 'none';
	const selected = selectable.filter(row => isRowSelected(selection, row)).length;
	if (!selected) return 'none';
	return selected === selectable.length ? 'all' : 'some';
}

/** The page checkbox: selects every selectable row of the page, or clears them. */
export function togglePageSelection(selection: ArchiveSelection, pageRows: readonly SelectableRow[]): ArchiveSelection {
	if (selection.mode === 'filter') return emptySelection();
	const ids = new Map(selection.ids);
	const state = pageSelectionState(selection, pageRows);
	for (const row of pageRows) {
		if (!rowSelectable(row)) continue;
		const key = selectionKey(row.kind, row.id);
		if (state === 'all') ids.delete(key);
		else ids.set(key, entryOf(row));
	}
	return { ...selection, ids };
}

export function selectAllResults(total: number, estimatedBytes: number): ArchiveSelection {
	return { mode: 'filter', ids: new Map(), filterCount: total, filterEstimatedBytes: estimatedBytes };
}

export interface SelectionSummary {
	count: number;
	downloadCount: number;
	deleteCount: number;
	estimatedBytes: number;
	/** Above 1000 downloadable items or a 4 GiB estimate. */
	tooLarge: boolean;
	/** Above 2000 items. */
	tooMany: boolean;
	canDownload: boolean;
	canDelete: boolean;
}

export function selectionSummary(selection: ArchiveSelection): SelectionSummary {
	let count: number;
	let downloadCount: number;
	let deleteCount: number;
	let estimatedBytes = 0;
	if (selection.mode === 'filter') {
		count = downloadCount = deleteCount = selection.filterCount;
		estimatedBytes = selection.filterEstimatedBytes;
	} else {
		count = selection.ids.size;
		downloadCount = 0;
		deleteCount = 0;
		for (const entry of selection.ids.values()) {
			if (entry.downloadable) {
				downloadCount++;
				estimatedBytes += entry.estimatedBytes;
			}
			if (entry.deletable) deleteCount++;
		}
	}
	const tooLarge = downloadCount > EXPORT_MAX_ITEMS || estimatedBytes > EXPORT_MAX_BYTES;
	const tooMany = deleteCount > DELETE_MAX_ITEMS;
	return {
		count,
		downloadCount,
		deleteCount,
		estimatedBytes,
		tooLarge,
		tooMany,
		canDownload: downloadCount > 0 && !tooLarge,
		canDelete: deleteCount > 0 && !tooMany,
	};
}

/** The explicit items of an ids selection, for export (downloadable) or delete (deletable). */
export function selectionItems(selection: ArchiveSelection, purpose: 'export' | 'delete'): Array<{ kind: ArchiveKind; id: string }> {
	const items: Array<{ kind: ArchiveKind; id: string }> = [];
	for (const entry of selection.ids.values()) {
		if (purpose === 'export' ? entry.downloadable : entry.deletable) items.push({ kind: entry.kind, id: entry.id });
	}
	return items;
}

// ── Paging ──────────────────────────────────────────────────────────────────

export function pageCount(total: number, pageSize: number): number {
	return Math.max(1, Math.ceil(total / pageSize));
}

export function lastPage(total: number, pageSize: number): number {
	return pageCount(total, pageSize) - 1;
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

// ── Table rows ──────────────────────────────────────────────────────────────

export interface ArchiveRowItem {
	kind: ArchiveKind;
	id: string;
	start: string;
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

export interface RowContext {
	t: (text: string) => string;
	tm: (text: string) => string;
	sourceLabel: (source: string) => string;
	locale: string | undefined;
	mode: ArchiveViewMode;
	/** The day shown in Day mode; a time on another day also shows its date. */
	dayStartMs: number;
	dayEndMs: number;
	downloadUrl: (kind: ArchiveKind, id: string) => string;
}

export interface ArchiveRowView extends SelectableRow {
	key: string;
	item: ArchiveRowItem;
	selectable: boolean;
	playable: boolean;
	previewable: boolean;
	startIso: string;
	startDate: string;
	startTime: string;
	endDate: string;
	endTime: string;
	/** End time after the start on a phone card; empty while recording or scanning. */
	phoneEnd: string;
	typeLabel: string;
	sourceLabel: string;
	simulated: boolean;
	frequencyLabel: string;
	modeLabel: string;
	durationLabel: string;
	sizeLabel: string;
	statusCode: string;
	statusClass: string;
	statusTitle: string;
	notSavedLabel: string;
	downloadUrl: string;
	/** Short description for confirmations and accessible names. */
	label: string;
	checkAria: string;
	downloadAria: string;
	deleteAria: string;
	live: boolean;
}

function dateAndTime(ms: number | null, context: RowContext): { date: string; time: string } {
	if (ms === null) return { date: '', time: '—' };
	const time = formatTime(ms, context.locale);
	if (context.mode !== 'day') return { date: formatShortDate(ms, context.locale), time };
	const sameDay = ms >= context.dayStartMs && ms < context.dayEndMs;
	return { date: sameDay ? '' : formatterFor(context.locale, DAY_MONTH_FORMAT).format(ms), time };
}

export function buildArchiveRow(item: ArchiveRowItem, context: RowContext): ArchiveRowView {
	const { t } = context;
	const start = dateAndTime(item.start_ms, context);
	const end = item.end_ms === null ? { date: '', time: '—' } : dateAndTime(item.end_ms, context);
	const audio = item.kind === 'audio';
	const typeLabel = audio ? (item.vfo_index === null ? 'VFO' : `VFO ${item.vfo_index + 1}`) : t('Scan');
	const frequencyLabel = audio ? formatAudioMHz(item.frequency_hz) : formatScanRange(item.start_hz, item.end_hz);
	const modeLabel = audio
		? [item.mode ? item.mode.toUpperCase() : '', item.bandwidth_hz === null ? '' : formatBandwidth(item.bandwidth_hz)].filter(Boolean).join(' · ') || '—'
		: formatScanResolution(item.fft_size);
	const failures = item.trace_upload_failures ?? 0;
	const label = `${typeLabel} · ${frequencyLabel} · ${start.date ? `${start.date} ` : ''}${start.time}`;
	const statusClass = `is-${item.status.replace(/[^a-z]/g, '') || 'unknown'}`;
	const row: ArchiveRowView = {
		key: selectionKey(item.kind, item.id),
		kind: item.kind,
		id: item.id,
		item,
		estimatedBytes: item.estimated_bytes,
		downloadable: item.downloadable,
		deletable: item.deletable,
		selectable: rowSelectable(item),
		playable: item.playable,
		previewable: item.previewable,
		startIso: item.start,
		startDate: start.date,
		startTime: start.time,
		endDate: end.date,
		endTime: end.time,
		phoneEnd: item.end_ms === null ? '' : end.time,
		typeLabel,
		sourceLabel: audio || !item.source ? '' : context.sourceLabel(item.source),
		simulated: !audio && item.source === 'simulated',
		frequencyLabel,
		modeLabel,
		durationLabel: formatDuration(item.duration_s),
		sizeLabel: formatBytes(item.bytes),
		statusCode: statusCode(item.status),
		statusClass,
		statusTitle: item.error ? context.tm(item.error) : '',
		notSavedLabel: failures > 0 ? `${failures} ${t('not saved')}` : '',
		downloadUrl: item.downloadable ? context.downloadUrl(item.kind, item.id) : '',
		label,
		checkAria: `${t('Select')}: ${label}`,
		downloadAria: `${t('Download')}: ${label}`,
		deleteAria: `${t('Delete')}: ${label}`,
		live: item.status === 'recording' || item.status === 'running',
	};
	return Object.freeze(row);
}

// ── Scan preview ────────────────────────────────────────────────────────────

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
