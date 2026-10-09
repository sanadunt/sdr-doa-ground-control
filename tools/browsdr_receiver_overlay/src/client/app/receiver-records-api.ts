import type { SweepCandidate, SweepConfig, SweepSource } from '../worker/sweep-types';

export type SweepCandidateSort = 'frequency' | 'peak' | 'snr' | 'hits' | 'lastSeen';

export interface SweepCandidatePage {
	items: SweepCandidate[];
	total: number;
	offset: number;
	limit: number;
}

export interface ReceiverMarker {
	id: string;
	frequencyHz: number;
	powerDb: number | null;
	label: string;
}

export interface ReceiverMarkerSet {
	id: string;
	name: string;
	markers: ReceiverMarker[];
}

export interface ReceiverSettings {
	auto_spectrum_recording: boolean;
}

export interface ReceiverScanRecord {
	type: 'scan';
	id: string;
	created_at: string;
	completed_at: string | null;
	source: SweepSource | 'receiver';
	status: 'running' | 'complete' | 'stopped' | 'failed';
	archive: boolean;
	start_hz: number | null;
	end_hz: number | null;
	candidate_count: number;
	trace_count: number;
}

export interface ReceiverScanDetails extends ReceiverScanRecord {
	config: SweepConfig;
}

export interface ReceiverTraceRecord {
	sweep: number;
	created_at: string;
}

export interface ReceiverTracePage {
	items: ReceiverTraceRecord[];
	total: number;
	offset: number;
	limit: number;
}

export interface ReceiverAudioSegmentRecord {
	id: string;
	vfo_index: number;
	frequency_hz: number;
	mode: string;
	bandwidth_hz: number;
	started_at: string;
	ended_at: string | null;
	duration_seconds: number | null;
	codec: string;
	bytes: number;
	status: 'complete' | 'failed';
	error: string;
}

export interface ReceiverAudioSessionRecord {
	type: 'audio-session';
	id: string;
	created_at: string;
	completed_at: string | null;
	segments: ReceiverAudioSegmentRecord[];
}

export type ReceiverRecord = ReceiverScanRecord | ReceiverAudioSessionRecord;

export interface ReceiverRecordPage {
	items: ReceiverRecord[];
	total: number;
	offset: number;
	limit: number;
}

export interface CreateScanInput {
	source: SweepSource;
	config: SweepConfig;
	archive: boolean;
}

export interface CandidateQuery {
	offset: number;
	limit: number;
	sort: SweepCandidateSort;
	minimumPeakDb: number;
	markedOnly: boolean;
	markerSetId: string | null;
	nearFrequencyHz?: number;
	markerFrequencies?: number[];
	groupAdjacent?: boolean;
}

const API_ROOT = '/api/receiver';
const JSON_TIMEOUT_MS = 10_000;
const AUDIO_CHUNK_TIMEOUT_MS = 30_000;

function objectValue(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
	return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be a non-empty string.`);
	return value;
}

function numberValue(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number.`);
	return value;
}

function integerValue(value: unknown, label: string): number {
	const number = numberValue(value, label);
	if (!Number.isInteger(number)) throw new TypeError(`${label} must be an integer.`);
	return number;
}

function nullableString(value: unknown, label: string): string | null {
	return value === null ? null : stringValue(value, label);
}

function parseVoid(): void {
	return;
}

function parseIdResponse(value: unknown): { id: string } {
	const result = objectValue(value, 'Receiver response');
	return { id: stringValue(result.id, 'id') };
}

function parseSettings(value: unknown): ReceiverSettings {
	const result = objectValue(value, 'Receiver settings');
	if (typeof result.auto_spectrum_recording !== 'boolean') throw new TypeError('auto_spectrum_recording must be a boolean.');
	return { auto_spectrum_recording: result.auto_spectrum_recording };
}

function parseCandidate(value: unknown): SweepCandidate {
	const row = objectValue(value, 'Sweep candidate');
	const candidate: SweepCandidate = {
		id: integerValue(row.id, 'candidate id'),
		startHz: numberValue(row.startHz, 'candidate startHz'),
		endHz: numberValue(row.endHz, 'candidate endHz'),
		centerHz: numberValue(row.centerHz, 'candidate centerHz'),
		peakFrequencyHz: numberValue(row.peakFrequencyHz, 'candidate peakFrequencyHz'),
		meanPeakFrequencyHz: numberValue(row.meanPeakFrequencyHz, 'candidate meanPeakFrequencyHz'),
		minPeakFrequencyHz: numberValue(row.minPeakFrequencyHz, 'candidate minPeakFrequencyHz'),
		maxPeakFrequencyHz: numberValue(row.maxPeakFrequencyHz, 'candidate maxPeakFrequencyHz'),
		bandwidthHz: numberValue(row.bandwidthHz, 'candidate bandwidthHz'),
		peakDb: numberValue(row.peakDb, 'candidate peakDb'),
		noiseFloorDb: numberValue(row.noiseFloorDb, 'candidate noiseFloorDb'),
		snrDb: numberValue(row.snrDb, 'candidate snrDb'),
		firstSeen: numberValue(row.firstSeen, 'candidate firstSeen'),
		lastSeen: numberValue(row.lastSeen, 'candidate lastSeen'),
		hits: integerValue(row.hits, 'candidate hits'),
	};
	const peakRangeValues = [row.peakRangeStartHz, row.peakRangeEndHz, row.peakRangeCenterHz];
	if (peakRangeValues.some(item => item !== undefined)) {
		if (peakRangeValues.some(item => item === undefined)) throw new TypeError('candidate peak range is incomplete.');
		const peakRangeStartHz = numberValue(row.peakRangeStartHz, 'candidate peakRangeStartHz');
		const peakRangeEndHz = numberValue(row.peakRangeEndHz, 'candidate peakRangeEndHz');
		const peakRangeCenterHz = numberValue(row.peakRangeCenterHz, 'candidate peakRangeCenterHz');
		if (peakRangeStartHz > peakRangeCenterHz || peakRangeCenterHz > peakRangeEndHz) {
			throw new TypeError('candidate peak range is invalid.');
		}
		candidate.peakRangeStartHz = peakRangeStartHz;
		candidate.peakRangeEndHz = peakRangeEndHz;
		candidate.peakRangeCenterHz = peakRangeCenterHz;
	} else {
		candidate.peakRangeStartHz = candidate.peakFrequencyHz;
		candidate.peakRangeEndHz = candidate.peakFrequencyHz;
		candidate.peakRangeCenterHz = candidate.peakFrequencyHz;
	}
	return candidate;
}

function parsePage<T>(value: unknown, parseItem: (item: unknown) => T, label: string): { items: T[]; total: number; offset: number; limit: number } {
	const row = objectValue(value, label);
	if (!Array.isArray(row.items)) throw new TypeError(`${label} items must be an array.`);
	return {
		items: row.items.map(parseItem),
		total: integerValue(row.total, `${label} total`),
		offset: integerValue(row.offset, `${label} offset`),
		limit: integerValue(row.limit, `${label} limit`),
	};
}

function parseCandidatePage(value: unknown): SweepCandidatePage {
	return parsePage(value, parseCandidate, 'Candidate page');
}

function markerFromApi(value: unknown): ReceiverMarker {
	const row = objectValue(value, 'Receiver marker');
	const frequencyHz = numberValue(row.frequency_hz, 'marker frequency_hz');
	if (frequencyHz <= 0) throw new TypeError('marker frequency_hz must be positive.');
	return {
		id: stringValue(row.id, 'marker id'),
		frequencyHz,
		powerDb: row.power_db === null ? null : numberValue(row.power_db, 'marker power_db'),
		label: typeof row.label === 'string' ? row.label : '',
	};
}

function markerToApi(marker: ReceiverMarker): { id: string; frequency_hz: number; power_db: number | null; label: string } {
	return { id: marker.id, frequency_hz: marker.frequencyHz, power_db: marker.powerDb, label: marker.label };
}

function parseMarkerSet(value: unknown): ReceiverMarkerSet {
	const row = objectValue(value, 'Marker set');
	if (!Array.isArray(row.markers)) throw new TypeError('Marker set markers must be an array.');
	return { id: stringValue(row.id, 'marker set id'), name: stringValue(row.name, 'marker set name'), markers: row.markers.map(markerFromApi) };
}

function parseScanRecord(value: unknown): ReceiverScanRecord {
	const row = objectValue(value, 'Scan record');
	const source = stringValue(row.source, 'scan source');
	if (!['native', 'manual', 'simulated', 'receiver'].includes(source)) throw new TypeError('scan source is invalid.');
	const status = stringValue(row.status, 'scan status');
	if (!['running', 'complete', 'stopped', 'failed'].includes(status)) throw new TypeError('scan status is invalid.');
	if (typeof row.archive !== 'boolean') throw new TypeError('scan archive must be a boolean.');
	return {
		type: 'scan',
		id: stringValue(row.id, 'scan id'),
		created_at: stringValue(row.created_at, 'scan created_at'),
		completed_at: nullableString(row.completed_at, 'scan completed_at'),
		source: source as ReceiverScanRecord['source'],
		status: status as ReceiverScanRecord['status'],
		archive: row.archive,
		start_hz: row.start_hz === null ? null : numberValue(row.start_hz, 'scan start_hz'),
		end_hz: row.end_hz === null ? null : numberValue(row.end_hz, 'scan end_hz'),
		candidate_count: integerValue(row.candidate_count, 'scan candidate_count'),
		trace_count: integerValue(row.trace_count, 'scan trace_count'),
	};
}

function parseAudioSegment(value: unknown): ReceiverAudioSegmentRecord {
	const row = objectValue(value, 'Audio segment');
	const status = row.status === undefined ? 'complete' : row.status;
	if (status !== 'complete' && status !== 'failed') throw new TypeError('Audio segment status is invalid.');
	return {
		id: stringValue(row.id, 'audio segment id'),
		vfo_index: integerValue(row.vfo_index, 'audio VFO index'),
		frequency_hz: numberValue(row.frequency_hz, 'audio frequency_hz'),
		mode: stringValue(row.mode, 'audio mode'),
		bandwidth_hz: numberValue(row.bandwidth_hz, 'audio bandwidth_hz'),
		started_at: stringValue(row.started_at, 'audio started_at'),
		ended_at: nullableString(row.ended_at, 'audio ended_at'),
		duration_seconds: row.duration_seconds === null || row.duration_seconds === undefined ? null : numberValue(row.duration_seconds, 'audio duration_seconds'),
		codec: stringValue(row.codec, 'audio codec'),
		bytes: integerValue(row.bytes, 'audio bytes'),
		status,
		error: typeof row.error === 'string' ? row.error : '',
	};
}

function parseRecord(value: unknown): ReceiverRecord {
	const row = objectValue(value, 'Receiver record');
	if (row.type === 'scan') return parseScanRecord(row);
	if (row.type !== 'audio-session' || !Array.isArray(row.segments)) throw new TypeError('Receiver record type is invalid.');
	return {
		type: 'audio-session',
		id: stringValue(row.id, 'audio session id'),
		created_at: stringValue(row.created_at, 'audio session created_at'),
		completed_at: nullableString(row.completed_at, 'audio session completed_at'),
		segments: row.segments.map(parseAudioSegment),
	};
}

function parseTrace(value: unknown): ReceiverTraceRecord {
	const row = objectValue(value, 'Trace record');
	return { sweep: integerValue(row.sweep, 'trace sweep'), created_at: stringValue(row.created_at, 'trace created_at') };
}

function parseTracePage(value: unknown): ReceiverTracePage {
	return parsePage(value, parseTrace, 'Trace page');
}

function parseScanDetails(value: unknown): ReceiverScanDetails {
	const row = objectValue(value, 'Scan details');
	const record = parseScanRecord(row);
	const config = objectValue(row.config, 'Scan config');
	const startHz = numberValue(config.startHz, 'config startHz');
	const endHz = numberValue(config.endHz, 'config endHz');
	const fftSize = integerValue(config.fftSize, 'config fftSize');
	if (fftSize !== 4096 && fftSize !== 8192) throw new TypeError('config fftSize is invalid.');
	const parsedConfig: SweepConfig = {
		startHz,
		endHz,
		fftSize,
		minSnrDb: numberValue(config.minSnrDb, 'config minSnrDb'),
		averageAlpha: numberValue(config.averageAlpha, 'config averageAlpha'),
		lnaGain: numberValue(config.lnaGain, 'config lnaGain'),
		vgaGain: numberValue(config.vgaGain, 'config vgaGain'),
		ampEnabled: config.ampEnabled === true,
		iqCorrection: config.iqCorrection === true,
	};
	return { ...record, config: parsedConfig };
}

async function request<T>(path: string, init: RequestInit, parse: (value: unknown) => T, timeoutMs = JSON_TIMEOUT_MS): Promise<T> {
	const controller = new AbortController();
	const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
	try {
		const headers = new Headers(init.headers);
		if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
		const response = await fetch(`${API_ROOT}${path}`, {
			...init,
			headers,
			credentials: 'same-origin',
			cache: 'no-store',
			signal: controller.signal,
		});
		const text = await response.text();
		if (!response.ok) {
			let detail = text;
			try {
				const body: unknown = JSON.parse(text);
				const error = objectValue(body, 'Receiver error').error;
				if (typeof error === 'string') detail = error;
			} catch {
				// Keep the server's plain-text diagnostic.
			}
			throw new Error(detail || `Receiver records request failed with HTTP ${response.status}.`);
		}
		let body: unknown;
		if (text) {
			try {
				body = JSON.parse(text) as unknown;
			} catch {
				throw new TypeError('Receiver records response was not valid JSON.');
			}
		}
		return parse(body);
	} finally {
		window.clearTimeout(timeout);
	}
}

async function requestTrace(path: string): Promise<Uint8Array> {
	const controller = new AbortController();
	const timeout = window.setTimeout(() => controller.abort(), JSON_TIMEOUT_MS);
	try {
		const response = await fetch(`${API_ROOT}${path}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
		if (!response.ok) throw new Error(`Receiver trace request failed with HTTP ${response.status}.`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length !== 2_048) throw new TypeError('Receiver trace must contain exactly 2,048 bytes.');
		return bytes;
	} finally {
		window.clearTimeout(timeout);
	}
}

function json(body: unknown): RequestInit {
	return { method: 'POST', body: JSON.stringify(body) };
}

function encodeId(id: string): string {
	return encodeURIComponent(id);
}

export const receiverRecordsApi = {
	getSettings(): Promise<ReceiverSettings> {
		return request('/settings', {}, parseSettings);
	},

	updateSettings(settings: ReceiverSettings): Promise<ReceiverSettings> {
		return request('/settings', json(settings), parseSettings);
	},

	createScan(input: CreateScanInput): Promise<{ id: string; created_at: string; archive: boolean }> {
		return request('/scans', json(input), value => {
			const row = objectValue(value, 'Created scan');
			if (typeof row.archive !== 'boolean') throw new TypeError('scan archive must be a boolean.');
			return { id: stringValue(row.id, 'scan id'), created_at: stringValue(row.created_at, 'scan created_at'), archive: row.archive };
		});
	},

	upsertCandidates(scanId: string, candidates: SweepCandidate[]): Promise<void> {
		return request(`/scans/${encodeId(scanId)}/candidates`, json({ candidates }), parseVoid);
	},

	getCandidates(scanId: string, query: CandidateQuery): Promise<SweepCandidatePage> {
		if (query.markedOnly && !query.markerSetId) {
			return request(`/scans/${encodeId(scanId)}/candidates/query`, json({
				offset: query.offset,
				limit: query.limit,
				sort: query.sort,
				minimum_peak_db: query.minimumPeakDb,
				marked_only: true,
				marker_frequencies: query.markerFrequencies ?? [],
				group_adjacent: Boolean(query.groupAdjacent),
			}), parseCandidatePage);
		}
		const params = new URLSearchParams({
			offset: String(query.offset),
			limit: String(query.limit),
			sort: query.sort,
			minimum_peak_db: String(query.minimumPeakDb),
			marked_only: String(query.markedOnly),
			group_adjacent: String(Boolean(query.groupAdjacent)),
		});
		if (query.markerSetId) params.set('marker_set_id', query.markerSetId);
		if (query.nearFrequencyHz !== undefined) params.set('near_frequency_hz', String(query.nearFrequencyHz));
		return request(`/scans/${encodeId(scanId)}/candidates?${params.toString()}`, {}, parseCandidatePage);
	},

	saveTrace(scanId: string, sweep: number, trace: Uint8Array<ArrayBuffer>): Promise<void> {
		return request(`/scans/${encodeId(scanId)}/trace?sweep=${encodeURIComponent(String(sweep))}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/octet-stream' },
			body: trace,
		}, parseVoid);
	},

	getScan(scanId: string): Promise<ReceiverScanDetails> {
		return request(`/scans/${encodeId(scanId)}`, {}, parseScanDetails);
	},

	getTraces(scanId: string, offset: number, limit: number, order: 'asc' | 'desc'): Promise<ReceiverTracePage> {
		const params = new URLSearchParams({ offset: String(offset), limit: String(limit), order });
		return request(`/scans/${encodeId(scanId)}/traces?${params.toString()}`, {}, parseTracePage);
	},

	getTrace(scanId: string, sweep: number): Promise<Uint8Array> {
		return requestTrace(`/scans/${encodeId(scanId)}/trace?sweep=${encodeURIComponent(String(sweep))}`);
	},

	finishScan(scanId: string, status: 'complete' | 'stopped' | 'failed'): Promise<void> {
		return request(`/scans/${encodeId(scanId)}/finish`, json({ status }), parseVoid);
	},

	listRecords(type: ReceiverRecord['type'], offset = 0, limit = 100): Promise<ReceiverRecordPage> {
		const params = new URLSearchParams({ type, offset: String(offset), limit: String(limit) });
		return request(`/records?${params.toString()}`, {}, value => {
			const page = parsePage(value, parseRecord, 'Records page');
			if (page.items.some(record => record.type !== type)) {
				throw new TypeError(`Records response included an item outside the ${type} filter.`);
			}
			return page;
		});
	},

	deleteRecord(recordId: string): Promise<void> {
		return request(`/records/${encodeId(recordId)}`, { method: 'DELETE' }, parseVoid);
	},

	async getMarkerSets(): Promise<ReceiverMarkerSet[]> {
		const result = objectValue(await request('/marker-sets', {}, value => value), 'Marker sets');
		if (!Array.isArray(result.items)) throw new TypeError('Marker sets items must be an array.');
		return result.items.map(parseMarkerSet);
	},

	async saveMarkerSet(set: ReceiverMarkerSet): Promise<ReceiverMarkerSet> {
		return request('/marker-sets', json({
			id: set.id || undefined,
			name: set.name,
			markers: set.markers.map(markerToApi),
		}), parseMarkerSet);
	},

	deleteMarkerSet(setId: string): Promise<void> {
		return request(`/marker-sets/${encodeId(setId)}`, { method: 'DELETE' }, parseVoid);
	},

	createAudioSession(): Promise<{ id: string }> {
		return request('/audio-sessions', json({}), parseIdResponse);
	},

	createAudioSegment(sessionId: string, metadata: { vfo_index: number; frequency_hz: number; mode: string; bandwidth_hz: number; codec: string; started_at: string }): Promise<{ id: string }> {
		return request(`/audio-sessions/${encodeId(sessionId)}/segments`, json(metadata), parseIdResponse);
	},

	appendAudioChunk(segmentId: string, chunk: Blob): Promise<void> {
		return request(`/audio-segments/${encodeId(segmentId)}/chunk`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/octet-stream' },
			body: chunk,
		}, parseVoid, AUDIO_CHUNK_TIMEOUT_MS);
	},

	finishAudioSegment(segmentId: string, metadata: { ended_at: string; duration_seconds: number; status?: 'complete' | 'failed'; error?: string }): Promise<void> {
		return request(`/audio-segments/${encodeId(segmentId)}/finish`, json(metadata), parseVoid);
	},

	finishAudioSession(sessionId: string): Promise<void> {
		return request(`/audio-sessions/${encodeId(sessionId)}/finish`, json({}), parseVoid);
	},

	audioUrl(segmentId: string): string {
		return `${API_ROOT}/audio-segments/${encodeId(segmentId)}/audio`;
	},
};
