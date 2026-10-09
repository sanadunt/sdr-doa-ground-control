import {
	SWEEP_DISPLAY_BINS,
	validateSweepConfig,
} from '../worker/sweep-types';
import type {
	SweepCandidate,
	SweepConfig,
	SweepSource,
	SweepSpectrumFrame,
	SweepSpectrumView,
} from '../worker/sweep-types';

export type SweepCandidateSort = 'frequency' | 'peak' | 'snr' | 'hits' | 'lastSeen';
export type SweepSessionVisualization = 'spectrum' | 'waterfall';

export interface SweepSessionDisplay {
	view: SweepSpectrumView;
	minimumPeakDb: number;
	displayMinDb: number;
	displayMaxDb: number;
	viewportStartHz: number;
	viewportEndHz: number;
	sortBy: SweepCandidateSort;
	visualization: SweepSessionVisualization;
	selectedCandidatePeakHz: number | null;
}

export interface SweepSessionWaterfall {
	rowCount: number;
	latestSweepCount: number;
	data: number[];
}

export interface SweepSessionSnapshot {
	source: SweepSource;
	config: SweepConfig;
	frame: SweepSpectrumFrame;
	candidates: SweepCandidate[];
	display: SweepSessionDisplay;
	waterfall: SweepSessionWaterfall;
}

export interface SweepSessionSerializedFrame {
	startHz: number;
	endHz: number;
	resolutionHz: number;
	sweepCount: number;
	current: number[];
	average: number[];
	maxHold: number[];
}

export interface SweepSessionFile {
	format: 'browsdr-wide-sweep';
	version: 1;
	savedAt: string;
	source: SweepSource;
	config: SweepConfig;
	frame: SweepSessionSerializedFrame;
	candidates: SweepCandidate[];
	display: SweepSessionDisplay;
	waterfall: SweepSessionWaterfall;
}

export interface ParsedSweepSession extends SweepSessionSnapshot {
	format: 'browsdr-wide-sweep';
	version: 1;
	savedAt: string;
}

const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_WATERFALL_ROWS = 256;
const SORT_MODES = new Set<SweepCandidateSort>(['frequency', 'peak', 'snr', 'hits', 'lastSeen']);
const SPECTRUM_VIEWS = new Set<SweepSpectrumView>(['current', 'average', 'max']);
const VISUALIZATIONS = new Set<SweepSessionVisualization>(['spectrum', 'waterfall']);
const SWEEP_SOURCES = new Set<SweepSource>(['native', 'manual', 'simulated']);

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function parseCandidate(value: unknown, config: SweepConfig, fallbackId: number): SweepCandidate {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Invalid candidate in sweep session');
	}
	const candidate = value as Record<string, unknown>;
	const fields = [
		'startHz', 'endHz', 'centerHz', 'peakFrequencyHz', 'bandwidthHz', 'peakDb',
		'noiseFloorDb', 'snrDb', 'firstSeen', 'lastSeen', 'hits',
	] as const;
	for (const field of fields) {
		if (!isFiniteNumber(candidate[field])) throw new TypeError(`Invalid candidate field: ${field}`);
	}
	const peakFrequencyHz = candidate.peakFrequencyHz as number;
	const id = candidate.id === undefined ? fallbackId : candidate.id;
	const meanPeakFrequencyHz = candidate.meanPeakFrequencyHz === undefined ? peakFrequencyHz : candidate.meanPeakFrequencyHz;
	const minPeakFrequencyHz = candidate.minPeakFrequencyHz === undefined ? peakFrequencyHz : candidate.minPeakFrequencyHz;
	const maxPeakFrequencyHz = candidate.maxPeakFrequencyHz === undefined ? peakFrequencyHz : candidate.maxPeakFrequencyHz;
	if (!isFiniteNumber(id) || !Number.isInteger(id) || id < 1
		|| !isFiniteNumber(meanPeakFrequencyHz) || !isFiniteNumber(minPeakFrequencyHz)
		|| !isFiniteNumber(maxPeakFrequencyHz)) {
		throw new TypeError('Invalid candidate identity or peak frequency range');
	}
	const parsed = {
		...candidate,
		id,
		meanPeakFrequencyHz,
		minPeakFrequencyHz,
		maxPeakFrequencyHz,
	} as SweepCandidate;
	if (parsed.startHz < config.startHz || parsed.endHz > config.endHz
		|| parsed.startHz >= parsed.endHz || parsed.centerHz < parsed.startHz
		|| parsed.centerHz > parsed.endHz || parsed.peakFrequencyHz < parsed.startHz
		|| parsed.peakFrequencyHz > parsed.endHz || parsed.bandwidthHz <= 0
		|| parsed.minPeakFrequencyHz < parsed.startHz || parsed.maxPeakFrequencyHz > parsed.endHz
		|| parsed.minPeakFrequencyHz > parsed.meanPeakFrequencyHz
		|| parsed.meanPeakFrequencyHz > parsed.maxPeakFrequencyHz
		|| parsed.peakFrequencyHz < parsed.minPeakFrequencyHz
		|| parsed.peakFrequencyHz > parsed.maxPeakFrequencyHz
		|| !Number.isInteger(parsed.hits) || parsed.hits < 1
		|| parsed.firstSeen < 0 || parsed.lastSeen < parsed.firstSeen) {
		throw new TypeError('Candidate values are outside the sweep session range');
	}
	return parsed;
}

export function serializeSweepSession(snapshot: SweepSessionSnapshot): string {
	const file: SweepSessionFile = {
		format: 'browsdr-wide-sweep',
		version: 1,
		savedAt: new Date().toISOString(),
		...snapshot,
		config: { ...snapshot.config },
		frame: {
			startHz: snapshot.frame.startHz,
			endHz: snapshot.frame.endHz,
			resolutionHz: snapshot.frame.resolutionHz,
			sweepCount: snapshot.frame.sweepCount,
			current: Array.from(snapshot.frame.current),
			average: Array.from(snapshot.frame.average),
			maxHold: Array.from(snapshot.frame.maxHold),
		},
		display: { ...snapshot.display },
	};
	return JSON.stringify(file);
}

export function parseSweepSession(text: string): ParsedSweepSession {
	if (text.length > MAX_SESSION_BYTES) throw new RangeError('Sweep session file exceeds the 8 MiB limit');
	const parsed: unknown = JSON.parse(text);
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new TypeError('Unsupported sweep session file');
	}
	const root = parsed as Record<string, unknown>;
	if (root.format !== 'browsdr-wide-sweep' || root.version !== 1) throw new TypeError('Unsupported sweep session file');
	const savedAt = root.savedAt;
	if (typeof savedAt !== 'string' || !Number.isFinite(Date.parse(savedAt))) {
		throw new TypeError('Invalid sweep session timestamp');
	}
	if (!SWEEP_SOURCES.has(root.source as SweepSource)) throw new TypeError('Invalid sweep source');
	const source = root.source as SweepSource;
	const rawConfig = root.config;
	if (rawConfig === null || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
		throw new TypeError('Invalid sweep configuration');
	}
	const rawConfigFields = rawConfig as Record<string, unknown>;
	const rawIqCorrection = rawConfigFields.iqCorrection;
	if (rawIqCorrection !== undefined && typeof rawIqCorrection !== 'boolean') {
		throw new TypeError('Invalid sweep configuration');
	}
	const config = {
		...rawConfigFields,
		iqCorrection: rawIqCorrection === undefined ? false : rawIqCorrection,
	} as unknown as SweepConfig;
	if (typeof config.ampEnabled !== 'boolean') throw new TypeError('Invalid sweep configuration');
	validateSweepConfig(config);

	const rawFrame = root.frame;
	if (rawFrame === null || typeof rawFrame !== 'object' || Array.isArray(rawFrame)) {
		throw new TypeError('Invalid spectrum frame');
	}
	const frameFields = rawFrame as Record<string, unknown>;
	const startHz = frameFields.startHz;
	const endHz = frameFields.endHz;
	const resolutionHz = frameFields.resolutionHz;
	const sweepCount = frameFields.sweepCount;
	if (!isFiniteNumber(startHz) || !isFiniteNumber(endHz) || !isFiniteNumber(resolutionHz)
		|| !Number.isInteger(sweepCount) || (sweepCount as number) < 0
		|| startHz !== config.startHz || endHz !== config.endHz || resolutionHz <= 0) {
		throw new TypeError('Spectrum frame does not match its sweep configuration');
	}
	const parseTrace = (value: unknown): Float32Array => {
		if (!Array.isArray(value) || value.length !== SWEEP_DISPLAY_BINS
			|| !value.every(isFiniteNumber)) throw new TypeError('Invalid spectrum trace');
		return Float32Array.from(value);
	};
	const frame: SweepSpectrumFrame = {
		startHz,
		endHz,
		resolutionHz,
		sweepCount: sweepCount as number,
		current: parseTrace(frameFields.current),
		average: parseTrace(frameFields.average),
		maxHold: parseTrace(frameFields.maxHold),
	};

	const rawCandidates = root.candidates;
	if (!Array.isArray(rawCandidates)) {
		throw new TypeError('Invalid sweep candidate history');
	}
	const candidateIds = new Set<number>();
	const candidates = rawCandidates.map((candidate, index) => {
		const parsed = parseCandidate(candidate, config, index + 1);
		if (candidateIds.has(parsed.id)) throw new TypeError('Duplicate candidate identity in sweep session');
		candidateIds.add(parsed.id);
		return parsed;
	});

	const rawDisplay = root.display;
	if (rawDisplay === null || typeof rawDisplay !== 'object' || Array.isArray(rawDisplay)) {
		throw new TypeError('Invalid sweep display settings');
	}
	const displayFields = rawDisplay as Record<string, unknown>;
	const display = displayFields as unknown as SweepSessionDisplay;
	if (!SPECTRUM_VIEWS.has(display.view) || !SORT_MODES.has(display.sortBy) || !VISUALIZATIONS.has(display.visualization)
		|| !isFiniteNumber(display.minimumPeakDb) || display.minimumPeakDb < -160 || display.minimumPeakDb > 0
		|| !isFiniteNumber(display.displayMinDb) || display.displayMinDb < -160
		|| !isFiniteNumber(display.displayMaxDb) || display.displayMaxDb > 0
		|| display.displayMaxDb - display.displayMinDb < 5
		|| !isFiniteNumber(display.viewportStartHz) || !isFiniteNumber(display.viewportEndHz)
		|| display.viewportStartHz < config.startHz || display.viewportEndHz > config.endHz
		|| display.viewportStartHz >= display.viewportEndHz
		|| (display.selectedCandidatePeakHz !== null && !isFiniteNumber(display.selectedCandidatePeakHz))) {
		throw new TypeError('Invalid sweep display settings');
	}

	const rawWaterfall = root.waterfall;
	if (rawWaterfall === null || typeof rawWaterfall !== 'object' || Array.isArray(rawWaterfall)) {
		throw new TypeError('Invalid waterfall history');
	}
	const waterfallFields = rawWaterfall as Record<string, unknown>;
	const rowCount = waterfallFields.rowCount;
	const latestSweepCount = waterfallFields.latestSweepCount;
	const data = waterfallFields.data;
	if (!Number.isInteger(rowCount) || (rowCount as number) < 0 || (rowCount as number) > MAX_WATERFALL_ROWS
		|| !Number.isInteger(latestSweepCount) || (latestSweepCount as number) < (rowCount as number)
		|| (latestSweepCount as number) > frame.sweepCount
		|| !Array.isArray(data) || data.length !== (rowCount as number) * SWEEP_DISPLAY_BINS
		|| !data.every(value => isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value <= 255)) {
		throw new TypeError('Invalid waterfall history');
	}
	return {
		format: 'browsdr-wide-sweep',
		version: 1,
		savedAt,
		source,
		config: { ...config },
		frame,
		candidates,
		display: { ...display },
		waterfall: {
			rowCount: rowCount as number,
			latestSweepCount: latestSweepCount as number,
			data: [...data] as number[],
		},
	};
}

export function exportSweepCandidatesCsv(candidates: SweepCandidate[]): string {
	const header = [
		'start_hz', 'end_hz', 'center_hz', 'peak_frequency_hz', 'mean_peak_frequency_hz',
		'min_peak_frequency_hz', 'max_peak_frequency_hz', 'bandwidth_hz', 'peak_db',
		'noise_floor_db', 'snr_db', 'first_seen_ms', 'last_seen_ms', 'hits',
	];
	const rows = candidates.map(candidate => [
		candidate.startHz,
		candidate.endHz,
		candidate.centerHz,
		candidate.peakFrequencyHz,
		candidate.meanPeakFrequencyHz,
		candidate.minPeakFrequencyHz,
		candidate.maxPeakFrequencyHz,
		candidate.bandwidthHz,
		candidate.peakDb,
		candidate.noiseFloorDb,
		candidate.snrDb,
		candidate.firstSeen,
		candidate.lastSeen,
		candidate.hits,
	].join(','));
	return [header.join(','), ...rows].join('\r\n');
}
