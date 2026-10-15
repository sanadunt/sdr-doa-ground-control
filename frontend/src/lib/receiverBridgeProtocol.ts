/**
 * Console side of the Receiver bridge protocol (console page <-> the hidden
 * same-origin /receiver/ frame). Constants, types and the parsers that turn
 * an untrusted postMessage payload into a typed frame message.
 *
 * The frame keeps its own copy in
 * tools/browsdr_receiver_overlay/src/client/app/console-bridge-protocol.ts;
 * a contract test compares the two. Change both together.
 *
 * Every message is { ch: BRIDGE_CHANNEL, v: BRIDGE_VERSION, type, ...payload }.
 * Frequencies are integer Hz of the displayed frequency (the Receiver's
 * frequency shift included), powers are relative dB (not calibrated) and
 * times are Date.now() milliseconds.
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
/** Demodulator modes in UI order; the keys of the Receiver's MODE_DEFAULTS. */
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
/** Wide scan FFT sizes: 4.88 kHz and 2.44 kHz resolution at the scan's 20 MSPS. */
export const SWEEP_FFT_SIZES = [4096, 8192] as const;
/** The scan trace the Receiver shows. */
export const SWEEP_VIEWS = ['current', 'average', 'max'] as const;
export const SWEEP_SOURCES = ['native', 'manual', 'simulated'] as const;
/** receiver:status sweep.phase. */
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
/** A scan range the console may set: at least minSpanHz wide, at most maxBins bins of sampleRateHz / fftSize. */
export const SWEEP_SPAN_LIMITS = { minSpanHz: 1_000_000, sampleRateHz: 20_000_000, maxBins: 500_000 } as const;
export const VOLUME_LIMITS = { min: 0, max: 100 } as const;
/**
 * Manual dB range of the Receiver's RX (Dengar) spectrum and waterfall, which
 * the Spektrum dock mirrors: the Receiver's graph limits, at least minGapDb apart.
 */
export const DISPLAY_DB_LIMITS = { minDb: -160, maxDb: 60, minGapDb: 5 } as const;
/** RX sample rates a console:radio may set: the RadioSpectrum's list. The frame also checks the connected device's. */
export const SAMPLE_RATES_HZ = [2_000_000, 4_000_000, 5_000_000, 8_000_000, 10_000_000, 16_000_000, 20_000_000] as const;
/** RX LNA and VGA gains in dB. The frame checks the connected device's own controls. */
export const GAIN_LIMITS = {
  lna: { min: 0, max: 40, step: 8 },
  vga: { min: 0, max: 62, step: 2 },
} as const;
export const COMMAND_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Spectrum bins with no finite power are sent as this level. */
export const SPECTRUM_FLOOR_DB = -200;

/**
 * console:start and console:sweep-start wait for a USB connect and the stream, console:radio for an RX
 * restart, console:sweep-stop for the scan archive to close; everything else is quick.
 */
export const START_TIMEOUT_MS = 20_000;
export const COMMAND_TIMEOUT_MS = 8_000;
/** A frame that sends no receiver:hello this long after its load is reported unresponsive. */
export const HELLO_TIMEOUT_MS = 8_000;
/** Commands issued before receiver:hello wait in a queue of at most this many. */
export const MAX_QUEUED_COMMANDS = 16;

export type FrameMessageType = typeof FRAME_MESSAGE_TYPES[number];
export type ConsoleMessageType = typeof CONSOLE_MESSAGE_TYPES[number];
export type ListenMode = typeof LISTEN_MODES[number];
export type ResultCode = typeof RESULT_CODES[number];
export type StatusErrorCode = typeof STATUS_ERROR_CODES[number];
export type BusyState = typeof BUSY_STATES[number];
export type Workspace = typeof WORKSPACES[number];
export type AudioState = typeof AUDIO_STATES[number];
export type TuneSource = typeof TUNE_SOURCES[number];
export type GainKind = keyof typeof GAIN_LIMITS;
export type SweepFftSize = typeof SWEEP_FFT_SIZES[number];
export type SweepView = typeof SWEEP_VIEWS[number];
export type SweepSource = typeof SWEEP_SOURCES[number];
export type SweepPhase = typeof SWEEP_PHASES[number];

/** Commands that wait for START_TIMEOUT_MS instead of COMMAND_TIMEOUT_MS. */
export const LONG_COMMAND_TYPES: ReadonlySet<ConsoleMessageType> = new Set<ConsoleMessageType>(['console:start', 'console:radio', 'console:sweep-start', 'console:sweep-stop']);

export interface Subscription {
  spectrum: boolean;
  bins: number;
  fps: number;
  spanHz: number;
}

export interface ReceiverHello {
  protocol: number;
  mockAvailable: boolean;
  webusb: boolean;
}

export interface StatusVfo {
  index: number;
  enabled: boolean;
  /** One of LISTEN_MODES, or null when the frame reports a mode the console does not know. */
  mode: ListenMode | null;
  frequencyHz: number | null;
  bandwidthHz: number | null;
  squelchEnabled: boolean;
  squelchDb: number | null;
  volume: number | null;
}

/**
 * Attribution of the Receiver's current tuning. rev increases with every
 * change of the centre, the active VFO index or that VFO's frequency;
 * receiverRev is the last rev not written by a console command (a change
 * made on the Receiver page).
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

/** The Receiver's RX dB scale: Auto, or the manual range (kept while Auto is on). */
export interface StatusDisplay extends DisplayRangeDb {
  auto: boolean;
}

/** The Receiver's wide scan: its state and settings, frequencies in displayed Hz. */
export interface StatusSweep {
  phase: SweepPhase;
  source: SweepSource;
  startHz: number;
  /** Above startHz. */
  stopHz: number;
  fftSize: SweepFftSize;
  resolutionHz: number;
  lnaDb: number | null;
  vgaDb: number | null;
  amp: boolean;
  /** The Receiver's Graph min./max., in DISPLAY_DB_LIMITS. */
  displayMinDb: number;
  displayMaxDb: number;
  view: SweepView;
}

export interface ReceiverStatus {
  seq: number;
  tMs: number | null;
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
  /** Already-localized Receiver notice text, shown as received. */
  notice: string | null;
  /** null when the frame sends no valid stamp; the console then cannot attribute a retune. */
  tune: TuneStamp | null;
  /** RX dB scale; null from a frame that does not report it. */
  display: StatusDisplay | null;
  /** Sample rates of the connected device; [] while none is connected or from a frame that does not report them. */
  sampleRatesHz: number[];
  /** The wide scan; null from a frame that does not report it or reports an unusable one. */
  sweep: StatusSweep | null;
}

/** A receiver:spectrum frame: the RX spectrum around the centre. */
export interface RxSpectrumFrame {
  source: 'rx';
  seq: number;
  tMs: number | null;
  centerHz: number;
  startHz: number;
  /** Exclusive upper edge. */
  stopHz: number;
  sampleRateHz: number;
  fftSize: number;
  binCount: number;
  /** A copy owned by the console; non-finite powers are replaced by SPECTRUM_FLOOR_DB. */
  bins: Float32Array;
}

/** A receiver:sweep frame: the wide scan over its whole range, max-hold downsampled by the frame. */
export interface SweepSpectrumFrame {
  source: 'sweep';
  seq: number;
  tMs: number | null;
  startHz: number;
  /** Exclusive upper edge. */
  stopHz: number;
  /** The scan's own bin width; null when the frame did not report it. */
  resolutionHz: number | null;
  sweepCount: number | null;
  view: SweepView;
  binCount: number;
  /** A copy owned by the console; non-finite powers are replaced by SPECTRUM_FLOOR_DB. */
  bins: Float32Array;
}

/** What the spectrum dock draws: an RX frame or a scan frame. */
export type SpectrumFrame = RxSpectrumFrame | SweepSpectrumFrame;

export interface ReceiverResult {
  id: string;
  ok: boolean;
  code: ResultCode;
  message?: string;
  /** Results of console:tune, console:vfo, console:start and console:radio: the tuning after the command. */
  tune?: ResultTune;
}

export type FrameMessage =
  | { type: 'receiver:hello'; hello: ReceiverHello }
  | { type: 'receiver:status'; status: ReceiverStatus }
  | { type: 'receiver:spectrum'; frame: RxSpectrumFrame }
  | { type: 'receiver:sweep'; frame: SweepSpectrumFrame }
  | { type: 'receiver:result'; result: ReceiverResult };

/** Commands the console sends; the bridge adds `id` and the envelope. */
export type BridgeCommand =
  | { type: 'console:start'; mock: boolean; listen: boolean; mode?: ListenMode; centerHz?: number; vfoHz?: number }
  | { type: 'console:stop' }
  | { type: 'console:tune'; centerHz: number; vfoHz?: number }
  | { type: 'console:vfo'; mode?: ListenMode; frequencyHz?: number; volume?: number }
  | { type: 'console:listen'; enabled: boolean }
  /** Without minDb and maxDb the Receiver keeps its manual range. */
  | { type: 'console:display'; auto: boolean; minDb?: number; maxDb?: number }
  /** At least one field; gains are snapped to their step. */
  | { type: 'console:gains'; lnaDb?: number; vgaDb?: number; amp?: boolean }
  /** confirmRecording only after the operator confirmed it in this page. */
  | { type: 'console:radio'; sampleRateHz: number; confirmRecording?: boolean }
  /** confirmRecording only after the operator confirmed, in this page, that the scan ends an armed recording. */
  | { type: 'console:sweep-start'; mock: boolean; confirmRecording?: boolean }
  | { type: 'console:sweep-stop'; resumeRx: boolean }
  /** Displayed Hz; at least one field. The frame refuses it while a scan runs. */
  | { type: 'console:sweep-config'; startHz?: number; stopHz?: number; fftSize?: SweepFftSize; lnaDb?: number; vgaDb?: number; amp?: boolean }
  /** The scan's graph range (the Receiver's Graph min./max.). */
  | { type: 'console:sweep-display'; minDb: number; maxDb: number };

const MAX_TEXT_CHARS = 300;
const MAX_DEVICE_NAME_CHARS = 80;
const MAX_SAMPLE_RATES = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export function isListenMode(value: unknown): value is ListenMode {
  return oneOf(LISTEN_MODES, value);
}

export function isResultCode(value: unknown): value is ResultCode {
  return oneOf(RESULT_CODES, value);
}

export function isCommandId(value: unknown): value is string {
  return typeof value === 'string' && COMMAND_ID_PATTERN.test(value);
}

/** True for a displayed frequency a tune command may carry. */
export function inTuneRange(hz: unknown): hz is number {
  return typeof hz === 'number' && Number.isFinite(hz) && hz >= TUNE_LIMITS.minHz && hz <= TUNE_LIMITS.maxHz;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function hzOrNull(value: unknown): number | null {
  const number = finiteOrNull(value);
  return number === null ? null : Math.round(number);
}

function nonNegativeOrNull(value: unknown): number | null {
  const number = finiteOrNull(value);
  return number !== null && number >= 0 ? number : null;
}

function boundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
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
 * A manual dB range kept inside DISPLAY_DB_LIMITS the way the frame keeps it:
 * the minimum first (at most maxDb − minGapDb), then the maximum at least
 * minGapDb above it, both in 0.1 dB steps. null when either is not a finite number.
 */
export function clampDisplayRange(minDb: unknown, maxDb: unknown): DisplayRangeDb | null {
  if (typeof minDb !== 'number' || !Number.isFinite(minDb) || typeof maxDb !== 'number' || !Number.isFinite(maxDb)) return null;
  const { minDb: floor, maxDb: ceiling, minGapDb: gap } = DISPLAY_DB_LIMITS;
  const min = roundDb(Math.min(ceiling - gap, Math.max(floor, roundDb(minDb))));
  const max = roundDb(Math.min(ceiling, Math.max(min + gap, roundDb(maxDb))));
  return { minDb: min, maxDb: max };
}

/** A gain in GAIN_LIMITS on its step, nearest to `value`; null when it is not a finite number. */
export function snapGain(kind: GainKind, value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const { min, max, step } = GAIN_LIMITS[kind];
  const clamped = Math.min(max, Math.max(min, value));
  return Math.min(max, min + Math.round((clamped - min) / step) * step);
}

/** The values of a gain control in GAIN_LIMITS, lowest first. */
export function gainSteps(kind: GainKind): number[] {
  const { min, max, step } = GAIN_LIMITS[kind];
  return Array.from({ length: Math.floor((max - min) / step) + 1 }, (_value, index) => min + index * step);
}

export function isSweepFftSize(value: unknown): value is SweepFftSize {
  return (SWEEP_FFT_SIZES as readonly unknown[]).includes(value);
}

/** The widest scan range in Hz an FFT size allows. */
export function sweepMaxSpanHz(fftSize: number): number {
  const { sampleRateHz, maxBins } = SWEEP_SPAN_LIMITS;
  return Number.isFinite(fftSize) && fftSize > 0 ? Math.floor((maxBins * sampleRateHz) / fftSize) : 0;
}

/**
 * Whether a scan range in displayed Hz is one the Receiver can scan, as the
 * frame checks it: with the frequency shift removed inside SWEEP_LIMITS,
 * increasing, at least minSpanHz wide and at most maxBins bins at this FFT size.
 */
export function inSweepRange(startHz: unknown, stopHz: unknown, fftSize: unknown, frequencyShiftHz = 0): boolean {
  if (typeof startHz !== 'number' || typeof stopHz !== 'number' || !Number.isFinite(startHz) || !Number.isFinite(stopHz)) return false;
  if (!isSweepFftSize(fftSize) || !Number.isFinite(frequencyShiftHz)) return false;
  const deviceStart = startHz - frequencyShiftHz;
  const deviceStop = stopHz - frequencyShiftHz;
  if (deviceStart < SWEEP_LIMITS.minHz || deviceStop > SWEEP_LIMITS.maxHz || deviceStop - deviceStart < SWEEP_SPAN_LIMITS.minSpanHz) return false;
  const resolutionHz = SWEEP_SPAN_LIMITS.sampleRateHz / fftSize;
  return Math.ceil((deviceStop - deviceStart) / resolutionHz) <= SWEEP_SPAN_LIMITS.maxBins;
}

/** Clamps a requested subscription exactly as the frame does; non-numbers take the default. */
export function clampSubscription(raw: { spectrum?: unknown; bins?: unknown; fps?: unknown; spanHz?: unknown }): Subscription {
  const limits = SUBSCRIBE_LIMITS;
  return {
    spectrum: raw.spectrum === true,
    bins: Math.round(clampNumber(raw.bins, limits.binsMin, limits.binsMax, limits.binsDefault)),
    fps: clampNumber(raw.fps, limits.fpsMin, limits.fpsMax, limits.fpsDefault),
    spanHz: Math.round(clampNumber(raw.spanHz, limits.spanMinHz, TUNE_LIMITS.maxHz, limits.spanDefaultHz)),
  };
}

function revOrNull(value: unknown): number | null {
  const number = finiteOrNull(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

/** A tune stamp, or null when any part of it is missing or out of range. */
export function normalizeTuneStamp(value: unknown): TuneStamp | null {
  if (!isRecord(value) || !oneOf(TUNE_SOURCES, value.by)) return null;
  const rev = revOrNull(value.rev);
  const receiverRev = revOrNull(value.receiverRev);
  if (rev === null || receiverRev === null || receiverRev > rev) return null;
  const id = value.by === 'console' && isCommandId(value.id) ? value.id : null;
  return { rev, by: value.by, id, receiverRev };
}

function normalizeResultTune(value: unknown): ResultTune | null {
  const stamp = normalizeTuneStamp(value);
  if (!stamp || !isRecord(value)) return null;
  return { ...stamp, centerHz: hzOrNull(value.centerHz), vfoHz: hzOrNull(value.vfoHz) };
}

function normalizeDisplay(value: unknown): StatusDisplay | null {
  if (!isRecord(value) || typeof value.auto !== 'boolean') return null;
  const range = clampDisplayRange(value.minDb, value.maxDb);
  return range ? { auto: value.auto, ...range } : null;
}

function normalizeSampleRates(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const rates: number[] = [];
  for (const rate of value.slice(0, MAX_SAMPLE_RATES)) {
    if (typeof rate === 'number' && Number.isInteger(rate) && rate > 0 && !rates.includes(rate)) rates.push(rate);
  }
  return rates;
}

/** The scan state; null when its phase, range or FFT size is unusable. */
function normalizeSweep(value: unknown): StatusSweep | null {
  if (!isRecord(value) || !oneOf(SWEEP_PHASES, value.phase) || !isSweepFftSize(value.fftSize)) return null;
  const startHz = hzOrNull(value.startHz);
  const stopHz = hzOrNull(value.stopHz);
  if (startHz === null || stopHz === null || stopHz <= startHz) return null;
  const resolutionHz = finiteOrNull(value.resolutionHz);
  const display = clampDisplayRange(value.displayMinDb, value.displayMaxDb);
  return {
    phase: value.phase,
    source: oneOf(SWEEP_SOURCES, value.source) ? value.source : 'simulated',
    startHz,
    stopHz,
    fftSize: value.fftSize,
    resolutionHz: resolutionHz !== null && resolutionHz > 0 ? resolutionHz : SWEEP_SPAN_LIMITS.sampleRateHz / value.fftSize,
    lnaDb: finiteOrNull(value.lnaDb),
    vgaDb: finiteOrNull(value.vgaDb),
    amp: value.amp === true,
    // The Receiver's own default when the frame sends none.
    displayMinDb: display?.minDb ?? -60,
    displayMaxDb: display?.maxDb ?? 0,
    view: oneOf(SWEEP_VIEWS, value.view) ? value.view : 'average',
  };
}

function normalizeVfo(value: unknown): StatusVfo | null {
  if (!isRecord(value)) return null;
  const index = finiteOrNull(value.index);
  const volume = finiteOrNull(value.volume);
  return {
    index: index !== null && Number.isInteger(index) && index >= 0 ? index : 0,
    enabled: value.enabled === true,
    mode: isListenMode(value.mode) ? value.mode : null,
    frequencyHz: hzOrNull(value.frequencyHz),
    bandwidthHz: nonNegativeOrNull(value.bandwidthHz),
    squelchEnabled: value.squelchEnabled === true,
    squelchDb: finiteOrNull(value.squelchDb),
    volume: volume !== null && volume >= VOLUME_LIMITS.min && volume <= VOLUME_LIMITS.max ? volume : null,
  };
}

/** Normalize a receiver:status payload; null when it lacks a usable sequence number. */
export function normalizeReceiverStatus(value: unknown): ReceiverStatus | null {
  if (!isRecord(value)) return null;
  const seq = finiteOrNull(value.seq);
  if (seq === null || !Number.isInteger(seq) || seq < 0) return null;
  const gains = isRecord(value.gains) ? value.gains : {};
  const pairedCount = finiteOrNull(value.pairedCount);
  const error = isRecord(value.error) && oneOf(STATUS_ERROR_CODES, value.error.code) ? { code: value.error.code } : null;
  const connected = value.connected === true;
  return {
    seq,
    tMs: finiteOrNull(value.tMs),
    webusb: value.webusb === true,
    mockAvailable: value.mockAvailable === true,
    pairedCount: pairedCount !== null && Number.isInteger(pairedCount) && pairedCount >= 0 ? pairedCount : null,
    connected,
    mock: connected && value.mock === true,
    deviceName: connected ? boundedText(value.deviceName, MAX_DEVICE_NAME_CHARS) : null,
    running: value.running === true,
    // A state this console does not know is treated as busy, so it never retunes over it.
    busy: oneOf(BUSY_STATES, value.busy) ? value.busy : value.busy === undefined ? 'none' : 'sweep',
    workspace: oneOf(WORKSPACES, value.workspace) ? value.workspace : 'spectrum',
    centerHz: hzOrNull(value.centerHz),
    sampleRateHz: nonNegativeOrNull(value.sampleRateHz),
    frequencyShiftHz: hzOrNull(value.frequencyShiftHz) ?? 0,
    gains: { lnaDb: finiteOrNull(gains.lnaDb), vgaDb: finiteOrNull(gains.vgaDb), amp: gains.amp === true },
    vfo: normalizeVfo(value.vfo),
    squelchOpen: value.squelchOpen === true,
    audio: oneOf(AUDIO_STATES, value.audio) ? value.audio : 'none',
    recording: value.recording === true,
    error,
    notice: boundedText(value.notice, MAX_TEXT_CHARS),
    tune: normalizeTuneStamp(value.tune),
    display: normalizeDisplay(value.display),
    sampleRatesHz: normalizeSampleRates(value.sampleRatesHz),
    sweep: normalizeSweep(value.sweep),
  };
}

/**
 * The bins of a spectrum or scan payload as a console-owned copy, or null.
 * `bins` is duck-typed with ArrayBuffer.isView (no instanceof, so a typed
 * array from another realm works) and must hold exactly binCount values.
 */
function copyBins(value: Record<string, unknown>): Float32Array | null {
  const bins = value.bins;
  if (!ArrayBuffer.isView(bins) || bins instanceof DataView) return null;
  const source = bins as unknown as ArrayLike<unknown>;
  const length = typeof source.length === 'number' ? source.length : -1;
  const binCount = finiteOrNull(value.binCount);
  if (binCount === null || !Number.isInteger(binCount) || binCount < 1 || binCount > SUBSCRIBE_LIMITS.binsMax || length !== binCount) return null;
  const copy = new Float32Array(binCount);
  for (let index = 0; index < binCount; index++) {
    const power = Number(source[index]);
    copy[index] = Number.isFinite(power) ? power : SPECTRUM_FLOOR_DB;
  }
  return copy;
}

/** Normalize a receiver:spectrum payload; the bins are copied, so the console never keeps a reference the frame owns. */
export function normalizeSpectrumFrame(value: unknown): RxSpectrumFrame | null {
  if (!isRecord(value)) return null;
  const copy = copyBins(value);
  if (!copy) return null;
  const binCount = copy.length;
  const startHz = finiteOrNull(value.startHz);
  const stopHz = finiteOrNull(value.stopHz);
  const centerHz = finiteOrNull(value.centerHz);
  const sampleRateHz = finiteOrNull(value.sampleRateHz);
  const seq = finiteOrNull(value.seq);
  const fftSize = finiteOrNull(value.fftSize);
  if (startHz === null || stopHz === null || centerHz === null || stopHz <= startHz) return null;
  if (sampleRateHz === null || sampleRateHz <= 0 || seq === null || seq < 0) return null;
  return {
    source: 'rx',
    seq,
    tMs: finiteOrNull(value.tMs),
    centerHz: Math.round(centerHz),
    startHz: Math.round(startHz),
    stopHz: Math.round(stopHz),
    sampleRateHz,
    fftSize: fftSize !== null && Number.isInteger(fftSize) && fftSize > 0 ? fftSize : binCount,
    binCount,
    bins: copy,
  };
}

/** Normalize a receiver:sweep payload; the bins are copied like a spectrum frame's. */
export function normalizeSweepFrame(value: unknown): SweepSpectrumFrame | null {
  if (!isRecord(value)) return null;
  const copy = copyBins(value);
  if (!copy) return null;
  const startHz = finiteOrNull(value.startHz);
  const stopHz = finiteOrNull(value.stopHz);
  const seq = finiteOrNull(value.seq);
  if (startHz === null || stopHz === null || stopHz <= startHz || seq === null || seq < 0) return null;
  const resolutionHz = finiteOrNull(value.resolutionHz);
  const sweepCount = finiteOrNull(value.sweepCount);
  return {
    source: 'sweep',
    seq,
    tMs: finiteOrNull(value.tMs),
    startHz: Math.round(startHz),
    stopHz: Math.round(stopHz),
    resolutionHz: resolutionHz !== null && resolutionHz > 0 ? resolutionHz : null,
    sweepCount: sweepCount !== null && Number.isInteger(sweepCount) && sweepCount >= 0 ? sweepCount : null,
    view: oneOf(SWEEP_VIEWS, value.view) ? value.view : 'average',
    binCount: copy.length,
    bins: copy,
  };
}

function normalizeHello(value: Record<string, unknown>): ReceiverHello | null {
  const protocol = finiteOrNull(value.protocol);
  if (protocol !== BRIDGE_VERSION) return null;
  return { protocol, mockAvailable: value.mockAvailable === true, webusb: value.webusb === true };
}

function normalizeResult(value: Record<string, unknown>): ReceiverResult | null {
  if (!isCommandId(value.id)) return null;
  // An unknown code from a newer frame still settles the command, as a failure.
  const code: ResultCode = isResultCode(value.code) ? value.code : value.ok === true ? 'OK' : 'NOT_READY';
  const ok = value.ok === true && code === 'OK';
  const result: ReceiverResult = { id: value.id, ok, code: ok ? 'OK' : code };
  const message = boundedText(value.message, MAX_TEXT_CHARS);
  if (message) result.message = message;
  const tune = normalizeResultTune(value.tune);
  if (tune) result.tune = tune;
  return result;
}

/**
 * Parse a message from the frame. Anything that is not a bridge envelope of
 * a known frame type with a well-formed payload returns null and is ignored.
 */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!isRecord(data) || data.ch !== BRIDGE_CHANNEL || data.v !== BRIDGE_VERSION || !oneOf(FRAME_MESSAGE_TYPES, data.type)) return null;
  switch (data.type) {
    case 'receiver:hello': {
      const hello = normalizeHello(data);
      return hello ? { type: data.type, hello } : null;
    }
    case 'receiver:status': {
      const status = normalizeReceiverStatus(data);
      return status ? { type: data.type, status } : null;
    }
    case 'receiver:spectrum': {
      const frame = normalizeSpectrumFrame(data);
      return frame ? { type: data.type, frame } : null;
    }
    case 'receiver:sweep': {
      const frame = normalizeSweepFrame(data);
      return frame ? { type: data.type, frame } : null;
    }
    case 'receiver:result': {
      const result = normalizeResult(data);
      return result ? { type: data.type, result } : null;
    }
    default:
      return null;
  }
}

/** The wire form of a command: envelope, id and only the fields the frame accepts. */
export function commandMessage(id: string, command: BridgeCommand): Record<string, unknown> {
  const envelope = { ch: BRIDGE_CHANNEL, v: BRIDGE_VERSION, type: command.type, id };
  switch (command.type) {
    case 'console:start': {
      const message: Record<string, unknown> = { ...envelope, mock: command.mock === true, listen: command.listen === true };
      if (isListenMode(command.mode)) message.mode = command.mode;
      if (inTuneRange(command.centerHz)) message.centerHz = Math.round(command.centerHz);
      if (inTuneRange(command.vfoHz)) message.vfoHz = Math.round(command.vfoHz);
      return message;
    }
    case 'console:stop':
      return envelope;
    case 'console:tune': {
      const message: Record<string, unknown> = { ...envelope, centerHz: Math.round(command.centerHz) };
      if (inTuneRange(command.vfoHz)) message.vfoHz = Math.round(command.vfoHz);
      return message;
    }
    case 'console:vfo': {
      const message: Record<string, unknown> = { ...envelope };
      if (isListenMode(command.mode)) message.mode = command.mode;
      if (inTuneRange(command.frequencyHz)) message.frequencyHz = Math.round(command.frequencyHz);
      if (typeof command.volume === 'number' && Number.isFinite(command.volume)) message.volume = Math.min(VOLUME_LIMITS.max, Math.max(VOLUME_LIMITS.min, command.volume));
      return message;
    }
    case 'console:listen':
      return { ...envelope, enabled: command.enabled === true };
    case 'console:display': {
      const message: Record<string, unknown> = { ...envelope, auto: command.auto === true };
      const range = clampDisplayRange(command.minDb, command.maxDb);
      if (range) Object.assign(message, range);
      return message;
    }
    case 'console:gains': {
      const message: Record<string, unknown> = { ...envelope };
      const lnaDb = snapGain('lna', command.lnaDb);
      const vgaDb = snapGain('vga', command.vgaDb);
      if (lnaDb !== null) message.lnaDb = lnaDb;
      if (vgaDb !== null) message.vgaDb = vgaDb;
      if (typeof command.amp === 'boolean') message.amp = command.amp;
      return message;
    }
    case 'console:radio': {
      const message: Record<string, unknown> = { ...envelope, sampleRateHz: Math.round(command.sampleRateHz) };
      if (command.confirmRecording === true) message.confirmRecording = true;
      return message;
    }
    case 'console:sweep-start': {
      const message: Record<string, unknown> = { ...envelope, mock: command.mock === true };
      if (command.confirmRecording === true) message.confirmRecording = true;
      return message;
    }
    case 'console:sweep-stop':
      return { ...envelope, resumeRx: command.resumeRx === true };
    case 'console:sweep-config': {
      const message: Record<string, unknown> = { ...envelope };
      const hz = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null);
      const startHz = hz(command.startHz);
      const stopHz = hz(command.stopHz);
      const lnaDb = snapGain('lna', command.lnaDb);
      const vgaDb = snapGain('vga', command.vgaDb);
      if (startHz !== null) message.startHz = startHz;
      if (stopHz !== null) message.stopHz = stopHz;
      if (isSweepFftSize(command.fftSize)) message.fftSize = command.fftSize;
      if (lnaDb !== null) message.lnaDb = lnaDb;
      if (vgaDb !== null) message.vgaDb = vgaDb;
      if (typeof command.amp === 'boolean') message.amp = command.amp;
      return message;
    }
    case 'console:sweep-display': {
      const message: Record<string, unknown> = { ...envelope };
      const range = clampDisplayRange(command.minDb, command.maxDb);
      if (range) Object.assign(message, range);
      return message;
    }
    default:
      return envelope;
  }
}
