/**
 * The Receiver mirror (issue #15, phase 2): what the groundstation page that
 * runs the Receiver frame publishes, and what the LAN view draws from it.
 *
 * The wire format is docs/RECEIVER_MIRROR.md, checked by the console in
 * tools/receiver_mirror.py; MIRROR_LIMITS repeats its numbers. Fields are
 * snake_case as on the wire. The publisher (receiverMirrorPublisher.ts)
 * builds a MirrorState from the bridge status and a MirrorFrame from a bridge
 * spectrum frame (max-hold to at most 512 bins, u8 over a stated dB range,
 * base64); the LAN view's feed (receiverMirrorFeed.ts) reads them back and
 * turns a frame into the bridge's SpectrumFrame for the dock's canvas.
 * mirrorView() applies the stale rules: a frame older than 3 s is stale, no
 * post for 10 s means the source is lost.
 */
import type { DockMode } from './spectrumDockSettings';
import type { MessageKey } from './i18n';
import { LISTEN_MODES, SPECTRUM_FLOOR_DB } from './receiverBridgeProtocol';
import type { BusyState, ListenMode, ReceiverStatus, SpectrumFrame, StatusErrorCode, SweepPhase } from './receiverBridgeProtocol';
import type { DockTone } from './spectrumView';

export const MIRROR_ROUTE = '/api/mirror/receiver';
export const MIRROR_VERSION = 1;

/** The contract's numbers (tools/receiver_mirror.py). */
export const MIRROR_LIMITS = {
  minBins: 16,
  maxBins: 512,
  maxBodyBytes: 8 * 1024,
  maxPostsPerS: 12,
  frameStaleMs: 3_000,
  sourceLostMs: 10_000,
  heartbeatMs: 2_000,
  dbFloor: -200,
  dbCeiling: 100,
  minDbSpan: 1,
  maxAbsFrequencyHz: 100_000_000_000,
  maxSampleRateHz: 100_000_000,
} as const;

/** The publisher sends at most one post every this many ms (5 a second), one at a time. */
export const MIRROR_POST_INTERVAL_MS = 200;
/** The frames the publisher asks the Receiver frame for. */
export const MIRROR_SUBSCRIBE_FPS = 5;
/** The narrowest dB range a published frame states, so a flat frame keeps some shape. */
export const MIRROR_MIN_ENCODED_SPAN_DB = 10;
/** While the LAN view is closed, the publisher asks /api/health this often whether it opened. */
export const MIRROR_LAN_CHECK_MS = 10_000;
/** The LAN view reads the mirror this often while it shows it, slower while the source is lost. */
export const MIRROR_POLL_MS = 200;
export const MIRROR_POLL_LOST_MS = 1_000;

export const MIRROR_SOURCE_KINDS = ['kiosk-tab', 'engine-tab'] as const;
export type MirrorSourceKind = typeof MIRROR_SOURCE_KINDS[number];
const BUSY_VALUES: readonly BusyState[] = ['none', 'sweep', 'scan-listen'];
const SCAN_PHASES: readonly SweepPhase[] = ['idle', 'starting', 'active', 'stopping'];
const ERROR_VALUES: readonly StatusErrorCode[] = ['USB_LOST', 'RX_ERROR', 'NO_WEBUSB'];
const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u;
/** The span of an RX frame: the bridge's default subscription span. */
const RX_SPAN_HZ = 2_000_000;

export interface MirrorSource {
  id: string;
  kind: MirrorSourceKind;
  /** The publishing page is visible; a hidden page sends no frames. */
  visible: boolean;
}

export interface MirrorVfo {
  index: number;
  enabled: boolean;
  mode: ListenMode | null;
  frequency_hz: number | null;
  bandwidth_hz: number | null;
  squelch_enabled: boolean;
  squelch_db: number | null;
}

export interface MirrorScan {
  phase: SweepPhase;
  start_hz: number | null;
  stop_hz: number | null;
  resolution_hz: number | null;
}

/** The Receiver as the source reports it; frequencies in displayed Hz (the Freq Shift included). */
export interface MirrorState {
  /** Counts the source's changes of this state. */
  rev: number;
  t_ms: number;
  connected: boolean;
  running: boolean;
  recording: boolean;
  mock: boolean;
  busy: BusyState;
  center_hz: number | null;
  sample_rate_hz: number | null;
  span_hz: number | null;
  frequency_shift_hz: number;
  gains: { lna_db: number | null; vga_db: number | null; amp: boolean };
  vfo: MirrorVfo | null;
  scan: MirrorScan | null;
  error: StatusErrorCode | null;
}

/** One spectrum frame: bin_count bytes (base64), byte v meaning db_min + v / 255 * (db_max - db_min). */
export interface MirrorFrame {
  seq: number;
  t_ms: number;
  kind: 'rx' | 'sweep';
  center_hz: number;
  start_hz: number;
  stop_hz: number;
  bin_count: number;
  db_min: number;
  db_max: number;
  bins: string;
}

export interface MirrorPublish {
  v: typeof MIRROR_VERSION;
  source: MirrorSource;
  state: MirrorState;
  frame?: MirrorFrame;
}

/** GET /api/mirror/receiver; ages are the server's, at the time it answered. */
export interface MirrorAnswer {
  rev: number;
  frameRev: number;
  source: MirrorSource | null;
  sourceAgeMs: number | null;
  state: MirrorState | null;
  stateAgeMs: number | null;
  frame: MirrorFrame | null;
  frameAgeMs: number | null;
  frameStaleMs: number;
  sourceLostMs: number;
}

// ---------------------------------------------------------------------------
// Encoding (the publisher).
// ---------------------------------------------------------------------------

/** At most `count` bins, each the strongest of the bins it covers. */
export function decimateMaxHold(values: ArrayLike<number>, count: number): Float32Array {
  const length = values.length;
  if (length <= count) return Float32Array.from(values as ArrayLike<number>);
  const out = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    const from = Math.floor((index * length) / count);
    const to = Math.max(from + 1, Math.floor(((index + 1) * length) / count));
    let peak = -Infinity;
    for (let source = from; source < to; source++) {
      const value = values[source];
      if (value > peak) peak = value;
    }
    out[index] = peak;
  }
  return out;
}

/**
 * The bins as bytes over a whole-dB range that holds them: below the weakest
 * and above the strongest bin with a power (the floor level does not count),
 * at least MIRROR_MIN_ENCODED_SPAN_DB wide, inside the contract's limits.
 */
export function encodeBins(values: ArrayLike<number>): { dbMin: number; dbMax: number; bytes: Uint8Array } {
  let low = Infinity;
  let high = -Infinity;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!Number.isFinite(value) || value <= SPECTRUM_FLOOR_DB) continue;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const { dbFloor, dbCeiling } = MIRROR_LIMITS;
  let dbMin = Number.isFinite(low) ? Math.max(dbFloor, Math.floor(low)) : dbFloor;
  let dbMax = Number.isFinite(high) ? Math.min(dbCeiling, Math.ceil(high)) : dbFloor + MIRROR_MIN_ENCODED_SPAN_DB;
  if (dbMax - dbMin < MIRROR_MIN_ENCODED_SPAN_DB) {
    dbMax = Math.min(dbCeiling, dbMin + MIRROR_MIN_ENCODED_SPAN_DB);
    dbMin = dbMax - MIRROR_MIN_ENCODED_SPAN_DB;
  }
  const span = dbMax - dbMin;
  const bytes = new Uint8Array(values.length);
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    bytes[index] = Number.isFinite(value) ? Math.min(255, Math.max(0, Math.round(((value - dbMin) / span) * 255))) : 0;
  }
  return { dbMin, dbMax, bytes };
}

/** The dB value of each byte of a frame. */
export function decodeBins(bytes: Uint8Array, dbMin: number, dbMax: number): Float32Array {
  const out = new Float32Array(bytes.length);
  const step = (dbMax - dbMin) / 255;
  for (let index = 0; index < bytes.length; index++) out[index] = dbMin + bytes[index] * step;
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index++) text += String.fromCharCode(bytes[index]);
  return btoa(text);
}

/** The bytes of a base64 text, or null when it is not base64 of exactly `count` bytes. */
export function base64ToBytes(text: string, count: number): Uint8Array | null {
  if (text.length !== 4 * Math.ceil(count / 3) || !/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) return null;
  let raw: string;
  try {
    raw = atob(text);
  } catch {
    return null;
  }
  if (raw.length !== count) return null;
  const bytes = new Uint8Array(count);
  for (let index = 0; index < count; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function wholeHz(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MIRROR_LIMITS.maxAbsFrequencyHz ? Math.round(value) : null;
}

function rateHz(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= MIRROR_LIMITS.maxSampleRateHz ? Math.round(value) : null;
}

function gainDb(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 200 ? value : null;
}

function wholeMs(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : Math.round(fallback);
}

/** A bridge spectrum frame as a published frame, or null when it has no usable range. */
export function mirrorFrameFromSpectrum(frame: SpectrumFrame, nowMs: number): MirrorFrame | null {
  const startHz = wholeHz(frame.startHz);
  const stopHz = wholeHz(frame.stopHz);
  if (startHz === null || stopHz === null || stopHz <= startHz || frame.bins.length < MIRROR_LIMITS.minBins) return null;
  const centerSource = frame.source === 'rx' ? frame.centerHz : (frame.startHz + frame.stopHz) / 2;
  const centerHz = Math.min(stopHz, Math.max(startHz, wholeHz(centerSource) ?? Math.round((startHz + stopHz) / 2)));
  const values = decimateMaxHold(frame.bins, MIRROR_LIMITS.maxBins);
  const { dbMin, dbMax, bytes } = encodeBins(values);
  return {
    seq: Number.isInteger(frame.seq) && frame.seq >= 0 ? frame.seq : 0,
    t_ms: wholeMs(frame.tMs, nowMs),
    kind: frame.source,
    center_hz: centerHz,
    start_hz: startHz,
    stop_hz: stopHz,
    bin_count: bytes.length,
    db_min: dbMin,
    db_max: dbMax,
    bins: bytesToBase64(bytes),
  };
}

/** The bridge status as the mirrored state (rev set by the publisher). */
export function mirrorStateFromStatus(status: ReceiverStatus, rev: number, nowMs: number): MirrorState {
  const vfo = status.vfo;
  const sweep = status.sweep;
  const sampleRate = rateHz(status.sampleRateHz);
  let scanStart = wholeHz(sweep?.startHz);
  let scanStop = wholeHz(sweep?.stopHz);
  if (scanStart !== null && scanStop !== null && scanStop <= scanStart) {
    scanStart = null;
    scanStop = null;
  }
  return {
    rev,
    t_ms: wholeMs(status.tMs, nowMs),
    connected: status.connected,
    running: status.running,
    recording: status.recording,
    mock: status.mock,
    busy: status.busy,
    center_hz: wholeHz(status.centerHz),
    sample_rate_hz: sampleRate,
    span_hz: sampleRate === null ? null : Math.min(RX_SPAN_HZ, sampleRate),
    frequency_shift_hz: wholeHz(status.frequencyShiftHz) ?? 0,
    gains: { lna_db: gainDb(status.gains.lnaDb), vga_db: gainDb(status.gains.vgaDb), amp: status.gains.amp },
    vfo: vfo ? {
      index: Math.min(63, Math.max(0, Math.round(vfo.index))),
      enabled: vfo.enabled,
      mode: vfo.mode,
      frequency_hz: wholeHz(vfo.frequencyHz),
      bandwidth_hz: rateHz(vfo.bandwidthHz),
      squelch_enabled: vfo.squelchEnabled,
      squelch_db: typeof vfo.squelchDb === 'number' && Number.isFinite(vfo.squelchDb) && vfo.squelchDb >= -200 && vfo.squelchDb <= 100 ? vfo.squelchDb : null,
    } : null,
    scan: sweep ? {
      phase: sweep.phase,
      start_hz: scanStart,
      stop_hz: scanStop,
      resolution_hz: typeof sweep.resolutionHz === 'number' && Number.isFinite(sweep.resolutionHz) && sweep.resolutionHz > 0 ? sweep.resolutionHz : null,
    } : null,
    error: status.error?.code ?? null,
  };
}

/** What a state change is: everything but rev and t_ms. */
export function mirrorStateKey(state: MirrorState): string {
  const { rev: _rev, t_ms: _time, ...rest } = state;
  return JSON.stringify(rest);
}

// ---------------------------------------------------------------------------
// Decoding (the LAN view).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function int(value: unknown, low: number, high: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high ? value : null;
}

function finite(value: unknown, low: number, high: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high ? value : null;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : null;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const HZ = MIRROR_LIMITS.maxAbsFrequencyHz;

function hzOrNull(value: unknown): number | null {
  return int(value, -HZ, HZ);
}

function normalizeSource(value: unknown): MirrorSource | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !SOURCE_ID_PATTERN.test(value.id) || typeof value.visible !== 'boolean') return null;
  const kind = oneOf(MIRROR_SOURCE_KINDS, value.kind);
  return kind ? { id: value.id, kind, visible: value.visible } : null;
}

function normalizeVfo(value: unknown): MirrorVfo | null {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || typeof value.squelch_enabled !== 'boolean') return null;
  const index = int(value.index, 0, 63);
  if (index === null) return null;
  return {
    index,
    enabled: value.enabled,
    mode: oneOf(LISTEN_MODES, value.mode),
    frequency_hz: hzOrNull(value.frequency_hz),
    bandwidth_hz: int(value.bandwidth_hz, 1, MIRROR_LIMITS.maxSampleRateHz),
    squelch_enabled: value.squelch_enabled,
    squelch_db: finite(value.squelch_db, -200, 100),
  };
}

function normalizeScan(value: unknown): MirrorScan | null {
  if (!isRecord(value)) return null;
  const phase = oneOf(SCAN_PHASES, value.phase);
  if (!phase) return null;
  return { phase, start_hz: hzOrNull(value.start_hz), stop_hz: hzOrNull(value.stop_hz), resolution_hz: finite(value.resolution_hz, 0.001, MIRROR_LIMITS.maxSampleRateHz) };
}

export function normalizeMirrorState(value: unknown): MirrorState | null {
  if (!isRecord(value) || !isRecord(value.gains)) return null;
  const busy = oneOf(BUSY_VALUES, value.busy);
  const rev = int(value.rev, 0, MAX_SAFE);
  const time = int(value.t_ms, 0, MAX_SAFE);
  const shift = hzOrNull(value.frequency_shift_hz);
  const flags = [value.connected, value.running, value.recording, value.mock, value.gains.amp];
  if (busy === null || rev === null || time === null || shift === null || !flags.every((flag) => typeof flag === 'boolean')) return null;
  return {
    rev,
    t_ms: time,
    connected: value.connected as boolean,
    running: value.running as boolean,
    recording: value.recording as boolean,
    mock: value.mock as boolean,
    busy,
    center_hz: hzOrNull(value.center_hz),
    sample_rate_hz: int(value.sample_rate_hz, 1, MIRROR_LIMITS.maxSampleRateHz),
    span_hz: int(value.span_hz, 1, MIRROR_LIMITS.maxSampleRateHz),
    frequency_shift_hz: shift,
    gains: { lna_db: finite(value.gains.lna_db, 0, 200), vga_db: finite(value.gains.vga_db, 0, 200), amp: value.gains.amp as boolean },
    vfo: normalizeVfo(value.vfo),
    scan: normalizeScan(value.scan),
    error: oneOf(ERROR_VALUES, value.error),
  };
}

export function normalizeMirrorFrame(value: unknown): MirrorFrame | null {
  if (!isRecord(value)) return null;
  const kind = value.kind === 'rx' || value.kind === 'sweep' ? value.kind : null;
  const seq = int(value.seq, 0, MAX_SAFE);
  const time = int(value.t_ms, 0, MAX_SAFE);
  const start = hzOrNull(value.start_hz);
  const stop = hzOrNull(value.stop_hz);
  const center = hzOrNull(value.center_hz);
  const count = int(value.bin_count, MIRROR_LIMITS.minBins, MIRROR_LIMITS.maxBins);
  const dbMin = finite(value.db_min, MIRROR_LIMITS.dbFloor, MIRROR_LIMITS.dbCeiling);
  const dbMax = finite(value.db_max, MIRROR_LIMITS.dbFloor, MIRROR_LIMITS.dbCeiling);
  if (kind === null || seq === null || time === null || start === null || stop === null || center === null || count === null
    || dbMin === null || dbMax === null || stop <= start || center < start || center > stop || dbMax - dbMin < MIRROR_LIMITS.minDbSpan
    || typeof value.bins !== 'string' || base64ToBytes(value.bins, count) === null) return null;
  return { seq, t_ms: time, kind, center_hz: center, start_hz: start, stop_hz: stop, bin_count: count, db_min: dbMin, db_max: dbMax, bins: value.bins };
}

function age(value: unknown): number | null {
  return int(value, 0, MAX_SAFE);
}

/** The GET answer, or null when it is not one; a part that does not check out is null. */
export function normalizeMirrorAnswer(value: unknown): MirrorAnswer | null {
  if (!isRecord(value) || value.ok !== true || value.v !== MIRROR_VERSION) return null;
  const rev = int(value.rev, 0, MAX_SAFE);
  const frameRev = int(value.frame_rev, 0, MAX_SAFE);
  if (rev === null || frameRev === null) return null;
  const limits = isRecord(value.limits) ? value.limits : {};
  const source = normalizeSource(value.source);
  const state = source ? normalizeMirrorState(value.state) : null;
  const frame = source ? normalizeMirrorFrame(value.frame) : null;
  return {
    rev,
    frameRev,
    source,
    sourceAgeMs: source ? age(value.source_age_ms) : null,
    state,
    stateAgeMs: state ? age(value.state_age_ms) : null,
    frame,
    frameAgeMs: frame ? age(value.frame_age_ms) : null,
    frameStaleMs: int(limits.frame_stale_ms, 100, 600_000) ?? MIRROR_LIMITS.frameStaleMs,
    sourceLostMs: int(limits.source_lost_ms, 100, 600_000) ?? MIRROR_LIMITS.sourceLostMs,
  };
}

/** A published frame as the bridge frame the dock's canvas draws. */
export function spectrumFromMirrorFrame(frame: MirrorFrame, state: MirrorState | null): SpectrumFrame | null {
  const bytes = base64ToBytes(frame.bins, frame.bin_count);
  if (!bytes) return null;
  const bins = decodeBins(bytes, frame.db_min, frame.db_max);
  if (frame.kind === 'sweep') {
    return {
      source: 'sweep',
      seq: frame.seq,
      tMs: frame.t_ms,
      startHz: frame.start_hz,
      stopHz: frame.stop_hz,
      resolutionHz: state?.scan?.resolution_hz ?? null,
      sweepCount: null,
      view: 'max',
      binCount: frame.bin_count,
      bins,
    };
  }
  return {
    source: 'rx',
    seq: frame.seq,
    tMs: frame.t_ms,
    centerHz: frame.center_hz,
    startHz: frame.start_hz,
    stopHz: frame.stop_hz,
    sampleRateHz: state?.sample_rate_hz ?? frame.stop_hz - frame.start_hz,
    fftSize: frame.bin_count,
    binCount: frame.bin_count,
    bins,
  };
}

// ---------------------------------------------------------------------------
// The LAN view's reading of the mirror.
// ---------------------------------------------------------------------------

export type MirrorPhase = 'connecting' | 'none' | 'lost' | 'stale' | 'live' | 'changing' | 'stopped';

export interface MirrorView {
  phase: MirrorPhase;
  /** Untranslated chip code; chipKey, when set, is shown instead (SOURCE LOST / SUMBER PUTUS). */
  chip: string;
  chipKey: MessageKey | null;
  tone: DockTone;
  /** The mode the Receiver runs: Spektrum while it scans, otherwise RX. */
  mode: DockMode;
  /**
   * Start/Stop shows Stop, as on the groundstation's dock (DockView.stoppable):
   * a scan that starts or runs, or RX running outside a scan listen. It
   * follows the last state, also while its frames are STALE or the source is
   * lost; only the chip shows the freshness.
   */
  stoppable: boolean;
  /** The trace is drawn live; otherwise it is dimmed under the overlay. */
  live: boolean;
  message: MessageKey | null;
  /** Age for the message ({age}), in ms. */
  messageAgeMs: number | null;
  /** Ages now: the last post of the source and the last frame, extrapolated from the answer. */
  sourceAgeMs: number | null;
  frameAgeMs: number | null;
  state: MirrorState | null;
  source: MirrorSource | null;
}

export interface MirrorViewInput {
  answer: MirrorAnswer | null;
  /** Date.now() when the answer arrived. */
  receivedAtMs: number | null;
  /** The last read failed. */
  error: boolean;
  nowMs: number;
}

const STOPPED_ERRORS: Partial<Record<StatusErrorCode, MessageKey>> = {
  USB_LOST: 'spectrum.usbLost',
  RX_ERROR: 'spectrum.rxError',
  NO_WEBUSB: 'spectrum.noWebusb',
};

/**
 * The chip, tone and message of the mirror for one moment. In order: no
 * answer yet, nothing published, the source lost (no post for 10 s, also
 * when the console stops answering), frames expected but older than 3 s
 * (STALE), live, a scan that starts or stops, then stopped.
 */
export function mirrorView({ answer, receivedAtMs, error, nowMs }: MirrorViewInput): MirrorView {
  const elapsed = receivedAtMs === null ? 0 : Math.max(0, nowMs - receivedAtMs);
  const sourceAgeMs = answer?.sourceAgeMs === null || answer?.sourceAgeMs === undefined ? null : answer.sourceAgeMs + elapsed;
  const frameAgeMs = answer?.frameAgeMs === null || answer?.frameAgeMs === undefined ? null : answer.frameAgeMs + elapsed;
  const state = answer?.state ?? null;
  const source = answer?.source ?? null;
  const mode: DockMode = state?.busy === 'sweep' ? 'sweep' : 'rx';
  const scanPhase: SweepPhase = state?.busy === 'sweep' ? state.scan?.phase && state.scan.phase !== 'idle' ? state.scan.phase : 'active' : 'idle';
  const stoppable = mode === 'sweep' ? scanPhase === 'active' || scanPhase === 'starting' : state?.running === true && state.busy !== 'scan-listen';
  const base = { mode, stoppable, live: false, sourceAgeMs, frameAgeMs, state, source, messageAgeMs: null, chipKey: null };
  if (!answer) {
    return error
      ? { ...base, phase: 'lost', chip: '', chipKey: 'mirror.chipLost', tone: 'bad', message: 'mirror.readFailed' }
      : { ...base, phase: 'connecting', chip: '…', tone: 'info', message: 'mirror.connecting' };
  }
  if (!source || !state) {
    return { ...base, phase: 'none', chip: '', chipKey: 'mirror.chipLost', tone: 'bad', message: 'mirror.noSource' };
  }
  const lostAfter = answer.sourceLostMs;
  if (sourceAgeMs === null || sourceAgeMs > lostAfter) {
    return { ...base, phase: 'lost', chip: '', chipKey: 'mirror.chipLost', tone: 'bad', message: 'mirror.sourceLost', messageAgeMs: sourceAgeMs };
  }
  const expected = mode === 'sweep' ? scanPhase === 'active' : state.running;
  if (expected) {
    const frame = answer.frame;
    if (!frame || frame.kind !== mode || frameAgeMs === null || frameAgeMs > answer.frameStaleMs) {
      return {
        ...base,
        phase: 'stale',
        chip: 'STALE',
        tone: 'warn',
        message: !source.visible ? 'mirror.kioskHidden' : frame && frame.kind === mode && frameAgeMs !== null ? 'mirror.frameStale' : 'mirror.noFrame',
        messageAgeMs: frameAgeMs,
      };
    }
    const busy = state.busy === 'scan-listen';
    return { ...base, phase: 'live', chip: mode === 'sweep' ? 'SCAN' : busy ? 'BUSY' : 'RX', tone: busy ? 'warn' : 'good', live: true, message: busy ? 'spectrum.scanListenBusy' : null };
  }
  if (mode === 'sweep' && scanPhase !== 'idle') {
    return { ...base, phase: 'changing', chip: '…', tone: 'info', message: scanPhase === 'stopping' ? 'spectrum.sweepStopping' : 'spectrum.sweepStarting' };
  }
  const errorMessage = state.error ? STOPPED_ERRORS[state.error] ?? null : null;
  return {
    ...base,
    phase: 'stopped',
    chip: mode === 'sweep' ? 'SCAN OFF' : 'RX OFF',
    tone: state.error === 'USB_LOST' || state.error === 'RX_ERROR' ? 'bad' : 'neutral',
    message: errorMessage ?? (state.connected ? null : 'mirror.notConnected'),
  };
}
