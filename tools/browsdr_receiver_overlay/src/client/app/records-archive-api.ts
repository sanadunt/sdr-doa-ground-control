/**
 * Client for the console's Records archive routes (/api/receiver/archive/*) and the
 * archive part of /api/receiver/settings: typed requests, URL builders and the parsers
 * that check every answer. The client sends ids and filters only, never a path.
 * No Vue import and no window access at module level, so node --test can load it.
 */
import { browserTimeZone, browserUtcOffsetMinutes, request } from './receiver-records-api';
import type { ArchiveKind } from './records-archive-format';

export const RECEIVER_API_ROOT = '/api/receiver';
export const ARCHIVE_API_ROOT = '/api/receiver/archive';
export const EXPORT_URL_PREFIX = '/api/receiver/archive/exports/';
const EXPORT_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

const READ_TIMEOUT_MS = 10_000;
const SETTINGS_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 60_000;

export interface RetentionResult {
	audio: number;
	sessions: number;
	scans: number;
	bytes: number;
	failed: number;
	more: boolean;
}

export interface ArchiveSettings {
	auto_spectrum_recording: boolean;
	retention_days: number | null;
	retention_options: number[];
	retention_last_run_ms: number | null;
	retention_last_removed: RetentionResult | null;
	retention_running: boolean;
	/** Present when this request ran a retention pass. */
	retention_result?: RetentionResult;
}

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

export interface ArchiveExport {
	export_id: string;
	url: string;
	filename: string;
	count: { audio: number; scan: number };
	missing: number;
	estimated_bytes: number;
	expires_in_s: number;
}

export interface ArchiveDeleteResult {
	deleted: { audio: number; scan: number };
	deleted_scan_ids: string[];
	sessions: number;
	bytes: number;
	skipped: Array<{ kind: ArchiveKind; id: string; code: string; error: string }>;
	skipped_count: number;
}

export interface RetentionPreview {
	days: number;
	cutoff_ms: number;
	audio: number;
	sessions: number;
	scans: number;
	bytes: number;
}

export type ArchiveSelectionBody =
	| { items: Array<{ kind: ArchiveKind; id: string }> }
	| { filter: Record<string, unknown>; expected_count: number };

// ── Value checks ────────────────────────────────────────────────────────────

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

// ── Parsers ─────────────────────────────────────────────────────────────────

function parseRetentionResult(value: unknown, label: string): RetentionResult {
	const row = objectValue(value, label);
	return {
		audio: countValue(row.audio, `${label} audio`),
		sessions: countValue(row.sessions, `${label} sessions`),
		scans: countValue(row.scans, `${label} scans`),
		bytes: countValue(row.bytes, `${label} bytes`),
		failed: countValue(row.failed, `${label} failed`),
		more: booleanValue(row.more, `${label} more`),
	};
}

export function parseArchiveSettings(value: unknown): ArchiveSettings {
	const row = objectValue(value, 'Receiver settings');
	const settings: ArchiveSettings = {
		auto_spectrum_recording: booleanValue(row.auto_spectrum_recording, 'auto_spectrum_recording'),
		retention_days: nullableInteger(row.retention_days, 'retention_days'),
		retention_options: arrayValue(row.retention_options, 'retention_options').map((entry, index) => {
			const days = integerValue(entry, `retention_options[${index}]`);
			if (days <= 0) throw new TypeError('retention options must be positive.');
			return days;
		}),
		retention_last_run_ms: nullableInteger(row.retention_last_run_ms, 'retention_last_run_ms'),
		retention_last_removed: row.retention_last_removed === null ? null : parseRetentionResult(row.retention_last_removed, 'retention_last_removed'),
		retention_running: booleanValue(row.retention_running, 'retention_running'),
	};
	if (settings.retention_days !== null && settings.retention_days <= 0) throw new TypeError('retention_days must be positive or null.');
	if (row.retention_result !== undefined) settings.retention_result = parseRetentionResult(row.retention_result, 'retention_result');
	return settings;
}

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

export function parseArchiveExport(value: unknown): ArchiveExport {
	const row = objectValue(value, 'Archive export');
	const exportId = nonEmptyString(row.export_id, 'export_id');
	if (!EXPORT_ID_PATTERN.test(exportId)) throw new TypeError('export_id is invalid.');
	const url = nonEmptyString(row.url, 'export url');
	if (url !== `${EXPORT_URL_PREFIX}${exportId}`) throw new TypeError(`export url must be ${EXPORT_URL_PREFIX}<export_id>.`);
	const count = objectValue(row.count, 'export count');
	return {
		export_id: exportId,
		url,
		filename: nonEmptyString(row.filename, 'export filename'),
		count: { audio: countValue(count.audio, 'export count audio'), scan: countValue(count.scan, 'export count scan') },
		missing: countValue(row.missing, 'export missing'),
		estimated_bytes: countValue(row.estimated_bytes, 'export estimated_bytes'),
		expires_in_s: countValue(row.expires_in_s, 'export expires_in_s'),
	};
}

export function parseArchiveDelete(value: unknown): ArchiveDeleteResult {
	const row = objectValue(value, 'Archive delete');
	const deleted = objectValue(row.deleted, 'deleted');
	return {
		deleted: { audio: countValue(deleted.audio, 'deleted audio'), scan: countValue(deleted.scan, 'deleted scan') },
		deleted_scan_ids: arrayValue(row.deleted_scan_ids, 'deleted_scan_ids').map((entry, index) => nonEmptyString(entry, `deleted_scan_ids[${index}]`)),
		sessions: countValue(row.sessions, 'sessions'),
		bytes: countValue(row.bytes, 'bytes'),
		skipped: arrayValue(row.skipped, 'skipped').map((entry, index) => {
			const skipped = objectValue(entry, `skipped[${index}]`);
			return {
				kind: kindValue(skipped.kind, `skipped[${index}] kind`),
				id: nonEmptyString(skipped.id, `skipped[${index}] id`),
				code: stringValue(skipped.code, `skipped[${index}] code`),
				error: stringValue(skipped.error, `skipped[${index}] error`),
			};
		}),
		skipped_count: countValue(row.skipped_count, 'skipped_count'),
	};
}

export function parseRetentionPreview(value: unknown): RetentionPreview {
	const row = objectValue(value, 'Retention preview');
	return {
		days: countValue(row.days, 'days'),
		cutoff_ms: integerValue(row.cutoff_ms, 'cutoff_ms'),
		audio: countValue(row.audio, 'audio'),
		sessions: countValue(row.sessions, 'sessions'),
		scans: countValue(row.scans, 'scans'),
		bytes: countValue(row.bytes, 'bytes'),
	};
}

// ── URLs ────────────────────────────────────────────────────────────────────

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

/** A ZIP url from the console, only when it is one of its single-use export links. */
export function exportDownloadUrl(url: string): string {
	if (!url.startsWith(EXPORT_URL_PREFIX) || !EXPORT_ID_PATTERN.test(url.slice(EXPORT_URL_PREFIX.length))) {
		throw new TypeError(`export url must start with ${EXPORT_URL_PREFIX}.`);
	}
	return url;
}

// ── Requests ────────────────────────────────────────────────────────────────

function post(body: unknown, signal?: AbortSignal): RequestInit {
	return { method: 'POST', body: JSON.stringify(body), ...(signal ? { signal } : {}) };
}

function get(signal?: AbortSignal): RequestInit {
	return signal ? { signal } : {};
}

export const archiveApi = {
	facets(signal?: AbortSignal): Promise<ArchiveFacets> {
		return request('/archive/facets', get(signal), parseArchiveFacets, READ_TIMEOUT_MS);
	},

	calendar(bounds: readonly number[], type: string, signal?: AbortSignal): Promise<ArchiveCalendar> {
		const params = new URLSearchParams({ bounds: bounds.join(',') });
		if (type !== 'all') params.set('type', type);
		return request(`/archive/calendar?${params.toString()}`, get(signal), value => parseArchiveCalendar(value, bounds.length - 1), READ_TIMEOUT_MS);
	},

	timeline(params: URLSearchParams, signal?: AbortSignal): Promise<ArchiveTimeline> {
		return request(`/archive/timeline?${params.toString()}`, get(signal), parseArchiveTimeline, READ_TIMEOUT_MS);
	},

	items(params: URLSearchParams, signal?: AbortSignal): Promise<ArchiveItemsPage> {
		return request(`/archive/items?${params.toString()}`, get(signal), parseArchiveItems, READ_TIMEOUT_MS);
	},

	scanPreview(scanId: string, signal?: AbortSignal): Promise<ArchiveScanPreview> {
		return request(`/archive/scans/${encodeId(scanId)}/preview`, get(signal), parseArchiveScanPreview, READ_TIMEOUT_MS);
	},

	createExport(selection: ArchiveSelectionBody, timeZone = browserTimeZone(), utcOffsetMinutes = browserUtcOffsetMinutes()): Promise<ArchiveExport> {
		return request('/archive/exports', post({ ...selection, time_zone: timeZone, utc_offset_minutes: utcOffsetMinutes }), parseArchiveExport, WRITE_TIMEOUT_MS);
	},

	deleteItems(selection: ArchiveSelectionBody): Promise<ArchiveDeleteResult> {
		return request('/archive/delete', post(selection), parseArchiveDelete, WRITE_TIMEOUT_MS);
	},

	retentionPreview(days: number, signal?: AbortSignal): Promise<RetentionPreview> {
		return request(`/archive/retention-preview?${new URLSearchParams({ days: String(days) }).toString()}`, get(signal), parseRetentionPreview, READ_TIMEOUT_MS);
	},

	getSettings(signal?: AbortSignal): Promise<ArchiveSettings> {
		return request('/settings', get(signal), parseArchiveSettings, READ_TIMEOUT_MS);
	},

	/** A new non-null retention needs confirm: true; Off and an unchanged value do not. */
	setRetention(days: number | null, confirm: boolean): Promise<ArchiveSettings> {
		return request('/settings', post(confirm ? { retention_days: days, confirm: true } : { retention_days: days }), parseArchiveSettings, SETTINGS_TIMEOUT_MS);
	},
};
