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
export const FRAME_MESSAGE_TYPES = ['receiver:hello', 'receiver:status', 'receiver:spectrum', 'receiver:result'] as const;
/** Console to frame. */
export const CONSOLE_MESSAGE_TYPES = [
  'console:hello',
  'console:subscribe',
  'console:start',
  'console:stop',
  'console:tune',
  'console:vfo',
  'console:listen',
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
  'TIMEOUT',
] as const;
/** receiver:status error.code values; the console translates them. */
export const STATUS_ERROR_CODES = ['USB_LOST', 'RX_ERROR', 'NO_WEBUSB'] as const;
export const BUSY_STATES = ['none', 'sweep', 'scan-listen'] as const;
export const WORKSPACES = ['spectrum', 'listener', 'records'] as const;
export const AUDIO_STATES = ['none', 'suspended', 'running'] as const;

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
export const VOLUME_LIMITS = { min: 0, max: 100 } as const;
export const COMMAND_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Spectrum bins with no finite power are sent as this level. */
export const SPECTRUM_FLOOR_DB = -200;

/** console:start waits for a USB connect and the stream; everything else is quick. */
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
}

export interface SpectrumFrame {
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

export interface ReceiverResult {
  id: string;
  ok: boolean;
  code: ResultCode;
  message?: string;
}

export type FrameMessage =
  | { type: 'receiver:hello'; hello: ReceiverHello }
  | { type: 'receiver:status'; status: ReceiverStatus }
  | { type: 'receiver:spectrum'; frame: SpectrumFrame }
  | { type: 'receiver:result'; result: ReceiverResult };

/** Commands the console sends; the bridge adds `id` and the envelope. */
export type BridgeCommand =
  | { type: 'console:start'; mock: boolean; listen: boolean; mode?: ListenMode; centerHz?: number; vfoHz?: number }
  | { type: 'console:stop' }
  | { type: 'console:tune'; centerHz: number; vfoHz?: number }
  | { type: 'console:vfo'; mode?: ListenMode; frequencyHz?: number; volume?: number }
  | { type: 'console:listen'; enabled: boolean };

const MAX_TEXT_CHARS = 300;
const MAX_DEVICE_NAME_CHARS = 80;

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
  };
}

/**
 * Normalize a receiver:spectrum payload. `bins` is duck-typed with
 * ArrayBuffer.isView (no instanceof, so a typed array from another realm
 * works) and copied, so the console never keeps a reference the frame owns.
 */
export function normalizeSpectrumFrame(value: unknown): SpectrumFrame | null {
  if (!isRecord(value)) return null;
  const bins = value.bins;
  if (!ArrayBuffer.isView(bins) || bins instanceof DataView) return null;
  const source = bins as unknown as ArrayLike<unknown>;
  const length = typeof source.length === 'number' ? source.length : -1;
  const binCount = finiteOrNull(value.binCount);
  if (binCount === null || !Number.isInteger(binCount) || binCount < 1 || binCount > SUBSCRIBE_LIMITS.binsMax || length !== binCount) return null;
  const startHz = finiteOrNull(value.startHz);
  const stopHz = finiteOrNull(value.stopHz);
  const centerHz = finiteOrNull(value.centerHz);
  const sampleRateHz = finiteOrNull(value.sampleRateHz);
  const seq = finiteOrNull(value.seq);
  const fftSize = finiteOrNull(value.fftSize);
  if (startHz === null || stopHz === null || centerHz === null || stopHz <= startHz) return null;
  if (sampleRateHz === null || sampleRateHz <= 0 || seq === null || seq < 0) return null;
  const copy = new Float32Array(binCount);
  for (let index = 0; index < binCount; index++) {
    const power = Number(source[index]);
    copy[index] = Number.isFinite(power) ? power : SPECTRUM_FLOOR_DB;
  }
  return {
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
  const message = boundedText(value.message, MAX_TEXT_CHARS);
  return message ? { id: value.id, ok, code: ok ? 'OK' : code, message } : { id: value.id, ok, code: ok ? 'OK' : code };
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
    default:
      return envelope;
  }
}
