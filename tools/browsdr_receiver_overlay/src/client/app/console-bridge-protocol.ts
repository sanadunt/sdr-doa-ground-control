/**
 * Receiver side of the Ground Console bridge protocol: constants, message
 * parsing and the spectrum crop. Pure functions only, so node tests can use them.
 *
 * The console keeps its own copy in frontend/src/lib/receiverBridgeProtocol.ts;
 * a contract test compares the two. Change both together.
 *
 * Every message is { ch: BRIDGE_CHANNEL, v: BRIDGE_VERSION, type, ...payload }.
 * Frequencies are integer Hz of the displayed frequency (radio.frequencyShift
 * included), powers are relative dB and times are Date.now() milliseconds.
 */

export const BRIDGE_CHANNEL = 'sdr-console-receiver';
export const BRIDGE_VERSION = 1;

/** Frame to console. */
export const FRAME_MESSAGE_TYPES = ['receiver:hello', 'receiver:status', 'receiver:spectrum', 'receiver:result', 'receiver:sweep'] as const;
/** Console to frame. */
export const CONSOLE_MESSAGE_TYPES = [
	'console:hello',
	'console:subscribe',
	'console:start',
	'console:stop',
	'console:tune',
	'console:vfo',
	'console:listen',
	'console:display',
	'console:gains',
	'console:radio',
	'console:sweep-start',
	'console:sweep-stop',
	'console:sweep-config',
	'console:sweep-display',
] as const;
/** Demodulator modes in UI order; the keys of MODE_DEFAULTS in constants.ts. */
export const LISTEN_MODES = ['nfm', 'wfm', 'am', 'usb', 'lsb', 'dsb', 'cw', 'raw'] as const;
/** receiver:result codes. TIMEOUT is produced by the console only. */
export const RESULT_CODES = [
	'OK',
	'NOT_READY',
	'INVALID_COMMAND',
	'NO_WEBUSB',
	'NEEDS_PAIRING',
	'NEEDS_DEVICE_CHOICE',
	'MOCK_UNAVAILABLE',
	'CONNECT_FAILED',
	'SWEEP_BUSY',
	'RX_NOT_RUNNING',
	'OUT_OF_RANGE',
	'AUDIO_BLOCKED',
	'RECORDING_ACTIVE',
	'SWEEP_UNSUPPORTED',
	'SWEEP_FAILED',
	'TIMEOUT',
] as const;
/** receiver:status error.code values; the console translates them. */
export const STATUS_ERROR_CODES = ['USB_LOST', 'RX_ERROR', 'NO_WEBUSB'] as const;
export const BUSY_STATES = ['none', 'sweep', 'scan-listen'] as const;
export const WORKSPACES = ['spectrum', 'listener', 'records'] as const;
export const AUDIO_STATES = ['none', 'suspended', 'running'] as const;
/** Who made the latest change of the centre or the active VFO (receiver:status tune.by). */
export const TUNE_SOURCES = ['console', 'receiver'] as const;
/** Wide scan FFT sizes: 4.88 kHz and 2.44 kHz resolution at the scan's 20 MSPS (worker/sweep-types.ts). */
export const SWEEP_FFT_SIZES = [4096, 8192] as const;
/** The scan trace the Receiver shows (sweep.view). */
export const SWEEP_VIEWS = ['current', 'average', 'max'] as const;
export const SWEEP_SOURCES = ['native', 'manual', 'simulated'] as const;
/** receiver:status sweep.phase: from the Receiver's sweep.starting, active and stopping. */
export const SWEEP_PHASES = ['idle', 'starting', 'active', 'stopping'] as const;

export const SUBSCRIBE_LIMITS = {
	binsMin: 64,
	binsMax: 2048,
	binsDefault: 512,
	fpsMin: 1,
	fpsMax: 15,
	fpsDefault: 10,
	spanMinHz: 100_000,
	spanDefaultHz: 2_000_000,
} as const;

/** Displayed centre and VFO frequencies a command may set. */
export const TUNE_LIMITS = { minHz: 1_000_000, maxHz: 6_000_000_000 } as const;
/**
 * Device frequencies (Freq Shift removed) of a wide scan and of the Receiver's
 * spectrum markers: the RadioSpectrum sweep range, wider than TUNE_LIMITS.
 */
export const SWEEP_LIMITS = { minHz: 1_000_000, maxHz: 7_250_000_000 } as const;
/**
 * A wide scan range the console may set: at least minSpanHz wide, and at
 * most maxBins bins of sampleRateHz / fftSize (worker/sweep-types.ts
 * validateSweepConfig and SWEEP_MAX_BINS).
 */
export const SWEEP_SPAN_LIMITS = { minSpanHz: 1_000_000, sampleRateHz: 20_000_000, maxBins: 500_000 } as const;
export const VOLUME_LIMITS = { min: 0, max: 100 } as const;
/**
 * Manual dB range of the Listener's spectrum and waterfall (the Dengar tab's
 * dB scale): the graph limits of the wide scan, at least minGapDb apart.
 */
export const DISPLAY_DB_LIMITS = { minDb: -160, maxDb: 60, minGapDb: 5 } as const;
/** Listener sample rates a console:radio may set: the RadioSpectrum's list (devices/hackrf.ts sampleRates). */
export const SAMPLE_RATES_HZ = [2_000_000, 4_000_000, 5_000_000, 8_000_000, 10_000_000, 16_000_000, 20_000_000] as const;
/**
 * Listener LNA and VGA gains in dB (devices/hackrf.ts gainControls). The
 * connected device's own controls decide; these apply before it connects.
 */
export const GAIN_LIMITS = {
	lna: { min: 0, max: 40, step: 8 },
	vga: { min: 0, max: 62, step: 2 },
} as const;
export const COMMAND_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Status changes are sent at most this often. */
export const STATUS_DEBOUNCE_MS = 100;
/** A running, connected, busy, error or recording change is sent at once, at most this often. */
export const STATUS_URGENT_MIN_MS = 20;
/** Status is repeated this often while the console holds a subscription. */
export const STATUS_HEARTBEAT_MS = 2_000;
/** Spectrum bins with no finite power are sent as this level. */
export const SPECTRUM_FLOOR_DB = -200;

export type FrameMessageType = typeof FRAME_MESSAGE_TYPES[number];
export type ConsoleMessageType = typeof CONSOLE_MESSAGE_TYPES[number];
export type ListenMode = typeof LISTEN_MODES[number];
export type ResultCode = typeof RESULT_CODES[number];
export type StatusErrorCode = typeof STATUS_ERROR_CODES[number];
export type BusyState = typeof BUSY_STATES[number];
export type Workspace = typeof WORKSPACES[number];
export type AudioState = typeof AUDIO_STATES[number];
export type TuneSource = typeof TUNE_SOURCES[number];
export type SweepFftSize = typeof SWEEP_FFT_SIZES[number];
export type SweepView = typeof SWEEP_VIEWS[number];
export type SweepSource = typeof SWEEP_SOURCES[number];
export type SweepPhase = typeof SWEEP_PHASES[number];

export interface Subscription {
	spectrum: boolean;
	bins: number;
	fps: number;
	spanHz: number;
}

export type ConsoleCommand =
	| { type: 'console:hello' }
	| ({ type: 'console:subscribe'; id: string } & Subscription)
	| { type: 'console:start'; id: string; mock: boolean; listen: boolean; mode?: ListenMode; centerHz?: number; vfoHz?: number }
	| { type: 'console:stop'; id: string }
	| { type: 'console:tune'; id: string; centerHz: number; vfoHz?: number }
	| { type: 'console:vfo'; id: string; mode?: ListenMode; frequencyHz?: number; volume?: number }
	| { type: 'console:listen'; id: string; enabled: boolean }
	/** Without minDb and maxDb the Listener keeps its manual range. */
	| { type: 'console:display'; id: string; auto: boolean; minDb?: number; maxDb?: number }
	/** At least one field. */
	| { type: 'console:gains'; id: string; lnaDb?: number; vgaDb?: number; amp?: boolean }
	/** confirmRecording: the operator confirmed, in the console page, that an armed recording continues in a new segment. */
	| { type: 'console:radio'; id: string; sampleRateHz: number; confirmRecording?: boolean }
	/** confirmRecording: the operator confirmed, in the console page, that the scan ends an armed recording. */
	| { type: 'console:sweep-start'; id: string; mock: boolean; confirmRecording?: boolean }
	/** resumeRx: start RX again when it ran before the scan. */
	| { type: 'console:sweep-stop'; id: string; resumeRx: boolean }
	/** Displayed Hz; at least one field. Refused while a scan runs. */
	| { type: 'console:sweep-config'; id: string; startHz?: number; stopHz?: number; fftSize?: SweepFftSize; lnaDb?: number; vgaDb?: number; amp?: boolean }
	/** The scan's graph range (the Receiver's Graph min./max.). */
	| { type: 'console:sweep-display'; id: string; minDb: number; maxDb: number }
	/** A console command with a usable id whose payload is wrong; answered with INVALID_COMMAND. */
	| { type: 'invalid'; id: string };

export type CommandOf<T extends ConsoleCommand['type']> = Extract<ConsoleCommand, { type: T }>;

export interface StatusVfo {
	index: number;
	enabled: boolean;
	mode: string;
	frequencyHz: number | null;
	bandwidthHz: number | null;
	squelchEnabled: boolean;
	squelchDb: number | null;
	volume: number | null;
}

/**
 * Attribution of the current tuning. rev increases with every change of the
 * centre, the active VFO index or that VFO's frequency; receiverRev is the
 * last rev not written by a console command (a Receiver-page change).
 */
export interface TuneStamp {
	rev: number;
	by: TuneSource;
	/** The console command that made the latest change; null when by is 'receiver'. */
	id: string | null;
	receiverRev: number;
}

/** The tuning after a console:tune, console:vfo, console:start or console:radio, carried by its result. */
export interface ResultTune extends TuneStamp {
	centerHz: number | null;
	vfoHz: number | null;
}

/** A manual dB range in DISPLAY_DB_LIMITS. */
export interface DisplayRangeDb {
	minDb: number;
	maxDb: number;
}

/** The Listener's dB scale: Auto, or the manual range (kept while Auto is on). */
export interface StatusDisplay extends DisplayRangeDb {
	auto: boolean;
}

/** The Receiver's wide scan: its state and settings, frequencies in displayed Hz. */
export interface StatusSweep {
	phase: SweepPhase;
	source: SweepSource;
	startHz: number;
	stopHz: number;
	fftSize: SweepFftSize;
	resolutionHz: number;
	lnaDb: number | null;
	vgaDb: number | null;
	amp: boolean;
	/** The Receiver's Graph min./max. */
	displayMinDb: number;
	displayMaxDb: number;
	view: SweepView;
}

export interface ReceiverStatus {
	seq: number;
	tMs: number;
	webusb: boolean;
	mockAvailable: boolean;
	pairedCount: number | null;
	connected: boolean;
	mock: boolean;
	deviceName: string | null;
	running: boolean;
	busy: BusyState;
	workspace: Workspace;
	centerHz: number | null;
	sampleRateHz: number | null;
	frequencyShiftHz: number;
	gains: { lnaDb: number | null; vgaDb: number | null; amp: boolean };
	vfo: StatusVfo | null;
	squelchOpen: boolean;
	audio: AudioState;
	recording: boolean;
	error: { code: StatusErrorCode } | null;
	notice: string | null;
	tune: TuneStamp;
	display: StatusDisplay;
	/** Sample rates of the connected device, in its order; [] while none is connected. */
	sampleRatesHz: number[];
	sweep: StatusSweep;
}

export interface CroppedSpectrum {
	startHz: number;
	stopHz: number;
	bins: Float32Array;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isListenMode(value: unknown): value is ListenMode {
	return typeof value === 'string' && (LISTEN_MODES as readonly string[]).includes(value);
}

/** undefined when absent, null when present but not a finite number. */
function optionalHz(value: unknown): number | undefined | null {
	if (value === undefined) return undefined;
	return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

/** undefined when absent, null when present but not a finite number. */
function optionalNumber(value: unknown): number | undefined | null {
	if (value === undefined) return undefined;
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, value));
}

/** 0.1 dB steps, so both sides store the same value. */
function roundDb(value: number): number {
	return Math.round(value * 10) / 10;
}

/**
 * A manual dB range kept inside DISPLAY_DB_LIMITS: the minimum first (at most
 * maxDb − minGapDb), then the maximum at least minGapDb above it, both in
 * 0.1 dB steps. null when either is not a finite number.
 */
export function clampDisplayRange(minDb: unknown, maxDb: unknown): DisplayRangeDb | null {
	if (typeof minDb !== 'number' || !Number.isFinite(minDb) || typeof maxDb !== 'number' || !Number.isFinite(maxDb)) return null;
	const { minDb: floor, maxDb: ceiling, minGapDb: gap } = DISPLAY_DB_LIMITS;
	const min = roundDb(Math.min(ceiling - gap, Math.max(floor, roundDb(minDb))));
	const max = roundDb(Math.min(ceiling, Math.max(min + gap, roundDb(maxDb))));
	return { minDb: min, maxDb: max };
}

/** The widest scan range in Hz an FFT size allows. */
export function sweepMaxSpanHz(fftSize: number): number {
	const { sampleRateHz, maxBins } = SWEEP_SPAN_LIMITS;
	return Number.isFinite(fftSize) && fftSize > 0 ? Math.floor((maxBins * sampleRateHz) / fftSize) : 0;
}

/**
 * Whether a scan range in displayed Hz is one the Receiver can scan: with the
 * frequency shift removed inside SWEEP_LIMITS, increasing, at least
 * minSpanHz wide and at most maxBins bins at this FFT size.
 */
export function inSweepRange(startHz: unknown, stopHz: unknown, fftSize: unknown, frequencyShiftHz = 0): boolean {
	if (typeof startHz !== 'number' || typeof stopHz !== 'number' || !Number.isFinite(startHz) || !Number.isFinite(stopHz)) return false;
	if (!(SWEEP_FFT_SIZES as readonly unknown[]).includes(fftSize) || !Number.isFinite(frequencyShiftHz)) return false;
	const deviceStart = startHz - frequencyShiftHz;
	const deviceStop = stopHz - frequencyShiftHz;
	if (deviceStart < SWEEP_LIMITS.minHz || deviceStop > SWEEP_LIMITS.maxHz || deviceStop - deviceStart < SWEEP_SPAN_LIMITS.minSpanHz) return false;
	const resolutionHz = SWEEP_SPAN_LIMITS.sampleRateHz / (fftSize as number);
	return Math.ceil((deviceStop - deviceStart) / resolutionHz) <= SWEEP_SPAN_LIMITS.maxBins;
}

/**
 * Downsamples a scan trace with max-hold into a new Float32Array of at most
 * `bins` values; a bin without a finite value is SPECTRUM_FLOOR_DB.
 */
export function decimateMaxHold(values: ArrayLike<number>, bins: number): Float32Array {
	const size = values.length;
	const count = Math.max(0, Math.min(size, Math.floor(bins)));
	const output = new Float32Array(count);
	for (let k = 0; k < count; k++) {
		const from = Math.floor((k * size) / count);
		const to = Math.max(from + 1, Math.floor(((k + 1) * size) / count));
		let peak = -Infinity;
		for (let index = from; index < to; index++) {
			const value = values[index];
			if (Number.isFinite(value) && value > peak) peak = value;
		}
		output[k] = peak === -Infinity ? SPECTRUM_FLOOR_DB : peak;
	}
	return output;
}

/** Clamps a requested subscription; values that are not finite numbers take the default. */
export function clampSubscription(raw: { spectrum?: unknown; bins?: unknown; fps?: unknown; spanHz?: unknown }): Subscription {
	const limits = SUBSCRIBE_LIMITS;
	return {
		spectrum: raw.spectrum === true,
		bins: Math.round(clampNumber(raw.bins, limits.binsMin, limits.binsMax, limits.binsDefault)),
		fps: clampNumber(raw.fps, limits.fpsMin, limits.fpsMax, limits.fpsDefault),
		// The upper bound is the sample rate, applied when a frame is cropped.
		spanHz: Math.round(clampNumber(raw.spanHz, limits.spanMinHz, TUNE_LIMITS.maxHz, limits.spanDefaultHz)),
	};
}

export function isCommandId(value: unknown): value is string {
	return typeof value === 'string' && COMMAND_ID_PATTERN.test(value);
}

export function inTuneRange(hz: number): boolean {
	return Number.isFinite(hz) && hz >= TUNE_LIMITS.minHz && hz <= TUNE_LIMITS.maxHz;
}

/** A gain value a control accepts: inside min..max and on its step. */
export function onGainStep(value: number, control: { min: number; max: number; step: number }): boolean {
	if (!Number.isFinite(value) || value < control.min || value > control.max) return false;
	const steps = (value - control.min) / control.step;
	return control.step > 0 && Math.abs(steps - Math.round(steps)) <= 1e-9;
}

/**
 * Parses a console message. Returns null for anything that is not a bridge
 * envelope with a known console type and a valid command id (it is ignored);
 * returns { type: 'invalid', id } when only the payload is wrong.
 */
export function parseConsoleMessage(data: unknown): ConsoleCommand | null {
	if (!isRecord(data) || data.ch !== BRIDGE_CHANNEL || data.v !== BRIDGE_VERSION || typeof data.type !== 'string') return null;
	const type = data.type;
	if (type === 'console:hello') return { type };
	if (!(CONSOLE_MESSAGE_TYPES as readonly string[]).includes(type) || !isCommandId(data.id)) return null;
	const id = data.id;
	const invalid = { type: 'invalid', id } as const;
	switch (type) {
		case 'console:subscribe': {
			if (typeof data.spectrum !== 'boolean') return invalid;
			return { type, id, ...clampSubscription(data) };
		}
		case 'console:start': {
			if ((data.mock !== undefined && typeof data.mock !== 'boolean')
				|| (data.listen !== undefined && typeof data.listen !== 'boolean')
				|| (data.mode !== undefined && !isListenMode(data.mode))) return invalid;
			const centerHz = optionalHz(data.centerHz);
			const vfoHz = optionalHz(data.vfoHz);
			if (centerHz === null || vfoHz === null) return invalid;
			const command: CommandOf<'console:start'> = { type, id, mock: data.mock === true, listen: data.listen === true };
			if (data.mode !== undefined) command.mode = data.mode as ListenMode;
			if (centerHz !== undefined) command.centerHz = centerHz;
			if (vfoHz !== undefined) command.vfoHz = vfoHz;
			return command;
		}
		case 'console:stop':
			return { type, id };
		case 'console:tune': {
			const centerHz = optionalHz(data.centerHz);
			const vfoHz = optionalHz(data.vfoHz);
			if (centerHz === undefined || centerHz === null || vfoHz === null) return invalid;
			return vfoHz === undefined ? { type, id, centerHz } : { type, id, centerHz, vfoHz };
		}
		case 'console:vfo': {
			if (data.mode !== undefined && !isListenMode(data.mode)) return invalid;
			const frequencyHz = optionalHz(data.frequencyHz);
			if (frequencyHz === null) return invalid;
			if (data.volume !== undefined && (typeof data.volume !== 'number' || !Number.isFinite(data.volume))) return invalid;
			const command: CommandOf<'console:vfo'> = { type, id };
			if (data.mode !== undefined) command.mode = data.mode as ListenMode;
			if (frequencyHz !== undefined) command.frequencyHz = frequencyHz;
			if (data.volume !== undefined) command.volume = data.volume as number;
			return command;
		}
		case 'console:listen':
			return typeof data.enabled === 'boolean' ? { type, id, enabled: data.enabled } : invalid;
		case 'console:display': {
			if (typeof data.auto !== 'boolean' || (data.minDb === undefined) !== (data.maxDb === undefined)) return invalid;
			if (data.minDb === undefined) return { type, id, auto: data.auto };
			const range = clampDisplayRange(data.minDb, data.maxDb);
			return range ? { type, id, auto: data.auto, ...range } : invalid;
		}
		case 'console:gains': {
			const lnaDb = optionalNumber(data.lnaDb);
			const vgaDb = optionalNumber(data.vgaDb);
			if (lnaDb === null || vgaDb === null || (data.amp !== undefined && typeof data.amp !== 'boolean')) return invalid;
			if (lnaDb === undefined && vgaDb === undefined && data.amp === undefined) return invalid;
			const command: CommandOf<'console:gains'> = { type, id };
			if (lnaDb !== undefined) command.lnaDb = lnaDb;
			if (vgaDb !== undefined) command.vgaDb = vgaDb;
			if (data.amp !== undefined) command.amp = data.amp as boolean;
			return command;
		}
		case 'console:radio': {
			const rate = data.sampleRateHz;
			if (typeof rate !== 'number' || !Number.isInteger(rate) || rate <= 0) return invalid;
			if (data.confirmRecording !== undefined && typeof data.confirmRecording !== 'boolean') return invalid;
			return data.confirmRecording === true ? { type, id, sampleRateHz: rate, confirmRecording: true } : { type, id, sampleRateHz: rate };
		}
		case 'console:sweep-start': {
			if ((data.mock !== undefined && typeof data.mock !== 'boolean')
				|| (data.confirmRecording !== undefined && typeof data.confirmRecording !== 'boolean')) return invalid;
			const command: CommandOf<'console:sweep-start'> = { type, id, mock: data.mock === true };
			if (data.confirmRecording === true) command.confirmRecording = true;
			return command;
		}
		case 'console:sweep-stop':
			return data.resumeRx === undefined || typeof data.resumeRx === 'boolean' ? { type, id, resumeRx: data.resumeRx === true } : invalid;
		case 'console:sweep-config': {
			const startHz = optionalHz(data.startHz);
			const stopHz = optionalHz(data.stopHz);
			const lnaDb = optionalNumber(data.lnaDb);
			const vgaDb = optionalNumber(data.vgaDb);
			if (startHz === null || stopHz === null || lnaDb === null || vgaDb === null) return invalid;
			if (data.fftSize !== undefined && !(SWEEP_FFT_SIZES as readonly unknown[]).includes(data.fftSize)) return invalid;
			if (data.amp !== undefined && typeof data.amp !== 'boolean') return invalid;
			const command: CommandOf<'console:sweep-config'> = { type, id };
			if (startHz !== undefined) command.startHz = startHz;
			if (stopHz !== undefined) command.stopHz = stopHz;
			if (data.fftSize !== undefined) command.fftSize = data.fftSize as SweepFftSize;
			if (lnaDb !== undefined) command.lnaDb = lnaDb;
			if (vgaDb !== undefined) command.vgaDb = vgaDb;
			if (data.amp !== undefined) command.amp = data.amp as boolean;
			return Object.keys(command).length > 2 ? command : invalid;
		}
		case 'console:sweep-display': {
			const range = clampDisplayRange(data.minDb, data.maxDb);
			return range ? { type, id, ...range } : invalid;
		}
		default:
			return null;
	}
}

/**
 * Crops a DC-centred FFT frame (index N/2 is the centre frequency) to spanHz
 * around the centre and downsamples it with max-hold into a new Float32Array of
 * at most `bins` values. stopHz is the exclusive upper edge; bin k covers
 * [startHz + k*(stopHz-startHz)/binCount, + one step).
 */
export function cropSpectrum(
	data: ArrayLike<number>,
	centerHz: number,
	sampleRateHz: number,
	spanHz: number,
	bins: number,
): CroppedSpectrum | null {
	const size = data.length;
	if (!size || !Number.isFinite(centerHz) || !Number.isFinite(sampleRateHz) || sampleRateHz <= 0
		|| !Number.isFinite(spanHz) || spanHz <= 0 || !Number.isFinite(bins) || bins < 1) return null;
	const binHz = sampleRateHz / size;
	const half = Math.min(spanHz, sampleRateHz) / 2;
	const first = Math.max(0, Math.floor(size / 2 - half / binHz));
	const end = Math.min(size, Math.ceil(size / 2 + half / binHz));
	if (end <= first) return null;
	const count = Math.min(Math.floor(bins), end - first);
	const output = new Float32Array(count);
	const factor = (end - first) / count;
	for (let k = 0; k < count; k++) {
		const from = first + Math.floor(k * factor);
		const to = Math.max(from + 1, first + Math.floor((k + 1) * factor));
		let peak = -Infinity;
		for (let index = from; index < to; index++) {
			const value = data[index];
			if (Number.isFinite(value) && value > peak) peak = value;
		}
		output[k] = peak === -Infinity ? SPECTRUM_FLOOR_DB : peak;
	}
	const lowEdgeHz = centerHz - sampleRateHz / 2;
	return {
		startHz: Math.round(lowEdgeHz + first * binHz),
		stopHz: Math.round(lowEdgeHz + end * binHz),
		bins: output,
	};
}

/**
 * Passes at most `fps` frames per second on average, timed by the caller's
 * clock (performance.now()). After a gap the next frame passes at once.
 */
export function createFrameThrottle(initialFps: number = SUBSCRIBE_LIMITS.fpsDefault) {
	let intervalMs = 1000 / initialFps;
	let nextDueMs = -Infinity;
	return {
		setFps(fps: number): void {
			intervalMs = 1000 / fps;
			nextDueMs = -Infinity;
		},
		accept(nowMs: number): boolean {
			if (nowMs < nextDueMs) return false;
			// Keep the average rate when frames arrive slightly late; restart the
			// schedule after a pause instead of sending a burst.
			nextDueMs = nowMs - nextDueMs > intervalMs ? nowMs + intervalMs : nextDueMs + intervalMs;
			return true;
		},
	};
}
