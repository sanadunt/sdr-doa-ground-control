/**
 * Pure helpers for the Overview spectrum dock: pixel <-> frequency mapping,
 * snapping, the automatic dB scale, the peak, axis ticks, the waterfall
 * palette and the dock's state table, for RX and for the wide scan
 * (Spektrum mode). Frequencies are integer Hz.
 */
import type { MessageKey } from './i18n';
import type { BridgePhase, ReceiverBuild } from './receiverBridge';
import type { ReceiverStatus, ResultCode, SpectrumFrame, StatusErrorCode, SweepPhase } from './receiverBridgeProtocol';
import type { DockMode } from './spectrumDockSettings';
import { nodeFrequenciesChanged } from './nodeFrequency';
import type { NodeFrequencies } from './nodeFrequency';

export const TUNE_SNAP_HZ = 1_000;
export const KEY_STEP_HZ = 10_000;
export const KEY_STEP_LARGE_HZ = 100_000;
/** A pointer that moves less than this between down and up is a click. */
export const CLICK_SLOP_PX = 5;
/** Waterfall history depth in rows. */
export const WATERFALL_ROWS = 128;

export interface DbRange {
  min: number;
  max: number;
}

/** Frequency at x of a `width`-pixel axis from startHz to stopHz (stop exclusive). */
export function freqAtX(x: number, startHz: number, stopHz: number, width: number): number | null {
  if (![x, startHz, stopHz, width].every(Number.isFinite) || width <= 0 || stopHz <= startHz) return null;
  const fraction = Math.min(1, Math.max(0, x / width));
  return startHz + fraction * (stopHz - startHz);
}

/** x of a frequency on the same axis; may fall outside [0, width]. */
export function xAtFreq(hz: number, startHz: number, stopHz: number, width: number): number | null {
  if (![hz, startHz, stopHz, width].every(Number.isFinite) || width <= 0 || stopHz <= startHz) return null;
  return ((hz - startHz) / (stopHz - startHz)) * width;
}

export function snapHz(hz: number, step = TUNE_SNAP_HZ): number {
  if (!Number.isFinite(hz)) return Number.NaN;
  const size = Number.isFinite(step) && step > 0 ? step : TUNE_SNAP_HZ;
  return Math.round(hz / size) * size;
}

/** What contentBoxX needs from a canvas element. */
export interface ContentBoxElement {
  getBoundingClientRect(): { left: number };
  clientLeft: number;
  clientWidth: number;
}

/**
 * x of a pointer inside an element's content box (inside its border) and that
 * box's width: the area a canvas is drawn across. The border box would shift
 * every tune by up to a pixel's worth of frequency.
 */
export function contentBoxX(clientX: number, element: ContentBoxElement): { x: number; width: number } {
  const rect = element.getBoundingClientRect();
  return { x: clientX - (rect.left + element.clientLeft), width: element.clientWidth };
}

function percentile(sorted: ArrayLike<number>, fraction: number): number {
  if (!sorted.length) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))));
  return sorted[index];
}

/**
 * Automatic dB scale: the noise floor (20th percentile) − 5 dB to the
 * maximum + 5 dB, at least 20 dB tall. With a previous range the result
 * moves part of the way towards the new one (`smoothing` 0..1), so the
 * trace does not jump with every frame.
 */
export function autoDbRange(bins: ArrayLike<number>, previous: DbRange | null = null, smoothing = 0.2): DbRange | null {
  const finite: number[] = [];
  for (let index = 0; index < bins.length; index++) {
    const value = bins[index];
    if (Number.isFinite(value)) finite.push(value);
  }
  if (!finite.length) return previous;
  const sorted = Float64Array.from(finite).sort();
  const floor = percentile(sorted, 0.2);
  const peak = sorted[sorted.length - 1];
  let min = floor - 5;
  let max = peak + 5;
  if (max - min < 20) {
    const middle = (max + min) / 2;
    min = middle - 10;
    max = middle + 10;
  }
  if (!previous || !Number.isFinite(previous.min) || !Number.isFinite(previous.max)) return { min, max };
  const weight = Math.min(1, Math.max(0, smoothing));
  return { min: previous.min + (min - previous.min) * weight, max: previous.max + (max - previous.max) * weight };
}

/** The strongest bin and the centre frequency of that bin. */
export function peakOf(bins: ArrayLike<number>, startHz: number, stopHz: number): { db: number; hz: number } | null {
  if (!bins.length || !Number.isFinite(startHz) || !Number.isFinite(stopHz) || stopHz <= startHz) return null;
  let best = -1;
  for (let index = 0; index < bins.length; index++) {
    if (Number.isFinite(bins[index]) && (best < 0 || bins[index] > bins[best])) best = index;
  }
  if (best < 0) return null;
  const step = (stopHz - startHz) / bins.length;
  return { db: bins[best], hz: startHz + (best + 0.5) * step };
}

/** Power of the bin under a frequency, or null outside the span. */
export function binAt(bins: ArrayLike<number>, startHz: number, stopHz: number, hz: number): number | null {
  if (!bins.length || !Number.isFinite(hz) || hz < startHz || hz >= stopHz) return null;
  const index = Math.min(bins.length - 1, Math.floor(((hz - startHz) / (stopHz - startHz)) * bins.length));
  const value = bins[index];
  return Number.isFinite(value) ? value : null;
}

/** MHz text with `digits` decimals and a real minus sign. */
export function formatMhz(hz: number | null | undefined, digits = 3): string {
  if (typeof hz !== 'number' || !Number.isFinite(hz)) return '—';
  const text = (Math.abs(hz) / 1e6).toFixed(digits);
  return hz < 0 && Number(text) !== 0 ? `−${text}` : text;
}

/** dB text with a real minus sign. */
export function formatDb(db: number | null | undefined, digits = 1): string {
  if (typeof db !== 'number' || !Number.isFinite(db)) return '—';
  const text = Math.abs(db).toFixed(digits);
  return db < 0 && Number(text) !== 0 ? `−${text}` : text;
}

/** MHz text with at most `maxDigits` decimals and no trailing zeros: 100, 433.92. */
export function formatMhzTrim(hz: number | null | undefined, maxDigits = 3): string {
  if (typeof hz !== 'number' || !Number.isFinite(hz)) return '—';
  const text = formatMhz(hz, maxDigits);
  return text.includes('.') ? text.replace(/\.?0+$/u, '') : text;
}

/**
 * Decimals a MHz value needs to tell two frequencies `stepHz` apart: 0 for a
 * step of 1 MHz or more, up to 3 (1 kHz). A wide scan's 1.8 MHz bins read in
 * whole MHz; the RX dock keeps 3.
 */
export function mhzDigits(stepHz: number): number {
  if (!Number.isFinite(stepHz) || stepHz <= 0) return 3;
  return Math.min(3, Math.max(0, Math.ceil(-Math.log10(stepHz / 1e6) - 1e-9)));
}

/** `count` evenly spaced labels from start to stop, both ends included, with `digits` MHz decimals. */
export function ticks(startHz: number, stopHz: number, count = 5, digits = 3): Array<{ hz: number; label: string }> {
  if (!Number.isFinite(startHz) || !Number.isFinite(stopHz) || stopHz <= startHz || count < 2) return [];
  return Array.from({ length: count }, (_value, index) => {
    const hz = startHz + ((stopHz - startHz) * index) / (count - 1);
    return { hz, label: formatMhz(hz, digits) };
  });
}

/** Arrow-key step on a scan of `spanHz`: 1/200 of it, at least KEY_STEP_HZ, on the 1 kHz grid. */
export function keyStepHz(spanHz: number): number {
  if (!Number.isFinite(spanHz) || spanHz <= 0) return KEY_STEP_HZ;
  return Math.max(KEY_STEP_HZ, snapHz(spanHz / 200));
}

/**
 * A pick on the scan trace: the centre of the strongest bin within `radius`
 * bins of the clicked one, since a 512-bin scan bin is wide. null outside the trace.
 */
export function scanPick(bins: ArrayLike<number>, startHz: number, stopHz: number, hz: number, radius = 2): number | null {
  if (!bins.length || !Number.isFinite(hz) || !Number.isFinite(startHz) || !Number.isFinite(stopHz) || stopHz <= startHz || hz < startHz || hz >= stopHz) return null;
  const step = (stopHz - startHz) / bins.length;
  const clicked = Math.min(bins.length - 1, Math.floor((hz - startHz) / step));
  let best = clicked;
  for (let index = Math.max(0, clicked - radius); index <= Math.min(bins.length - 1, clicked + radius); index++) {
    if (Number.isFinite(bins[index]) && (!Number.isFinite(bins[best]) || bins[index] > bins[best])) best = index;
  }
  return startHz + (best + 0.5) * step;
}

/** The axis span around a centre frequency, used before any frame has arrived. */
export function spanAround(centerHz: number | null | undefined, spanHz: number): { startHz: number; stopHz: number } | null {
  if (typeof centerHz !== 'number' || !Number.isFinite(centerHz) || !Number.isFinite(spanHz) || spanHz <= 0) return null;
  return { startHz: centerHz - spanHz / 2, stopHz: centerHz + spanHz / 2 };
}

export interface FrequencyAxis {
  startHz: number;
  stopHz: number;
}

/**
 * The axis the dock draws on. While RX runs it is the last frame's span,
 * unless that frame was taken at another centre than the one now tuned (more
 * than TUNE_SNAP_HZ away): then the expected span around the tuned centre, so
 * a retune moves the axis at once and the old trace stays at its true
 * frequencies until frames at the new centre arrive. While RX is stopped it
 * is the expected span, or the last frame's when there is none.
 */
export function axisFor(
  frame: { centerHz: number; startHz: number; stopHz: number } | null,
  expectedCenterHz: number | null,
  running: boolean,
  expected: FrequencyAxis | null,
): FrequencyAxis | null {
  if (frame && (!expected || (running && (expectedCenterHz === null || Math.abs(frame.centerHz - expectedCenterHz) <= TUNE_SNAP_HZ)))) {
    return { startHz: frame.startHz, stopHz: frame.stopHz };
  }
  return expected;
}

/**
 * The axis of a scan: the frame's range while the scan runs, otherwise the
 * expected range (the Receiver's settings), or the last frame's when there is none.
 */
export function sweepAxis(frame: FrequencyAxis | null, live: boolean, expected: FrequencyAxis | null): FrequencyAxis | null {
  if (frame && (!expected || live)) return { startHz: frame.startHz, stopHz: frame.stopHz };
  return expected;
}

/** What the waterfall history was filled with. */
export interface WaterfallSource {
  source: SpectrumFrame['source'];
  binCount: number;
  startHz: number;
  stopHz: number;
}

/**
 * Whether a frame cannot join the waterfall history: another source (RX or
 * scan), another bin count, or a scan over another range. An RX retune keeps
 * the history; the rows taken at the old centre scroll away.
 */
export function waterfallNeedsReset(previous: WaterfallSource | null, frame: WaterfallSource): boolean {
  if (!previous || previous.source !== frame.source || previous.binCount !== frame.binCount) return true;
  return frame.source === 'sweep' && (previous.startHz !== frame.startHz || previous.stopHz !== frame.stopHz);
}

/** Map a power to 0..255 on a dB range. */
export function dbToByte(db: number, range: DbRange): number {
  if (!Number.isFinite(db) || !(range.max > range.min)) return 0;
  const unit = (db - range.min) / (range.max - range.min);
  return Math.round(Math.min(1, Math.max(0, unit)) * 255);
}

function hexChannel(hex: string, offset: number): number {
  return Number.parseInt(hex.slice(offset, offset + 2), 16);
}

/** 256-entry RGB lookup table interpolated from 0..1 colour stops (#rrggbb). */
export function paletteLut(stops: ReadonlyArray<readonly [number, string]>): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  const valid = stops
    .filter(([stop, colour]) => Number.isFinite(stop) && /^#[0-9a-f]{6}$/iu.test(colour))
    .map(([stop, colour]) => [stop, [hexChannel(colour, 1), hexChannel(colour, 3), hexChannel(colour, 5)]] as const)
    .sort((left, right) => left[0] - right[0]);
  if (!valid.length) return lut;
  for (let index = 0; index < 256; index++) {
    const position = index / 255;
    let upper = valid.findIndex(([stop]) => stop >= position);
    if (upper < 0) upper = valid.length - 1;
    const lower = Math.max(0, upper - 1);
    const [lowStop, lowColour] = valid[lower];
    const [highStop, highColour] = valid[upper];
    const mix = highStop > lowStop ? Math.min(1, Math.max(0, (position - lowStop) / (highStop - lowStop))) : 1;
    for (let channel = 0; channel < 3; channel++) {
      lut[index * 3 + channel] = lowColour[channel] + (highColour[channel] - lowColour[channel]) * mix;
    }
  }
  return lut;
}

/** Follow-node retunes only when the node or the receiver is further away than this. */
export const FOLLOW_TOLERANCE_HZ = 1_000;

/** What "Ikuti frekuensi node" remembers between runs. */
export interface FollowMemory {
  /** RX was running at the previous run; tells an RX start from a dock mounted over a running RX. */
  wasRunning: boolean;
  /** The node tuning last followed, or found already tuned. */
  followed: NodeFrequencies | null;
}

/**
 * Memory of a dock that has just mounted. Over a running receiver (a return
 * to Overview after tuning by hand on the Receiver page) the current node
 * counts as followed and the start as seen, so mounting alone never retunes:
 * only a node change seen while mounted, an RX start or re-checking the box does.
 */
export function followMemoryAtMount(running: boolean, node: NodeFrequencies | null): FollowMemory {
  return { wasRunning: running, followed: running ? node : null };
}

export interface FollowInput {
  follow: boolean;
  node: NodeFrequencies | null;
  running: boolean;
  /** The bridge is ready with a status, the Receiver is not busy and no start is waiting. */
  canTune: boolean;
  liveCenterHz: number | null;
  liveVfoHz: number | null;
}

/**
 * One run of follow-node: retune when the node moves by more than
 * FOLLOW_TOLERANCE_HZ, and once when RX starts. Returns the next memory and
 * the tuning to send, if any.
 */
export function followNodeStep(memory: FollowMemory, input: FollowInput): { memory: FollowMemory; tune: NodeFrequencies | null } {
  const justStarted = input.running && !memory.wasRunning;
  const next: FollowMemory = { wasRunning: input.running, followed: memory.followed };
  const { node } = input;
  if (!input.follow || !node || !input.canTune) return { memory: next, tune: null };
  const atTarget = input.liveCenterHz !== null && Math.abs(input.liveCenterHz - node.centerHz) <= FOLLOW_TOLERANCE_HZ
    && (input.liveVfoHz === null || Math.abs(input.liveVfoHz - node.vfoHz) <= FOLLOW_TOLERANCE_HZ);
  if (atTarget) return { memory: { ...next, followed: node }, tune: null };
  if (!justStarted && !nodeFrequenciesChanged(memory.followed, node, FOLLOW_TOLERANCE_HZ)) return { memory: next, tune: null };
  return { memory: { ...next, followed: node }, tune: node };
}

export type DockTone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';

/** A code the dock keeps from the last command result or a status error. */
export type DockNotice = ResultCode | StatusErrorCode;

export interface DockViewInput {
  build: ReceiverBuild;
  phase: BridgePhase;
  /** A Mulai/Dengar start (RX or scan) is waiting for its result. */
  starting: boolean;
  /** A dock sample rate change is restarting RX. */
  restarting?: boolean;
  status: ReceiverStatus | null;
  /** Code of the last failed dock command, cleared by the next success. */
  notice: DockNotice | null;
  /** The stored mode: what Mulai starts while nothing runs. */
  storedMode?: DockMode;
}

export interface DockView {
  /** Untranslated status code for the chip. */
  chip: string;
  tone: DockTone;
  /** Text for the body, or null when the trace speaks for itself. */
  message: MessageKey | null;
  /** Offer "Buka Receiver (key)" next to the message. */
  openReceiver: boolean;
  /** The mode shown: the one that runs, otherwise the stored one. */
  mode: DockMode;
  /** The Receiver's RX runs (Dengar, follow-node and the RX axis use it). */
  rxRunning: boolean;
  /** The trace is drawn live: RX in RX mode, a running scan in Spektrum mode; otherwise it is dimmed under the overlay. */
  live: boolean;
  /** Mulai shows as Berhenti: RX runs in RX mode, or a scan starts or runs. */
  stoppable: boolean;
  /** Mulai and Dengar cannot run (build missing or the Receiver is busy). */
  controlsDisabled: boolean;
}

/** The scan's phase as the Receiver reports it; a busy 'sweep' without a usable scan state counts as active. */
export function scanPhaseOf(status: ReceiverStatus | null): SweepPhase {
  if (status?.busy !== 'sweep') return 'idle';
  const phase = status.sweep?.phase;
  return phase && phase !== 'idle' ? phase : 'active';
}

/**
 * The mode the dock shows: Spektrum while the Receiver scans (also a scan
 * started on the Receiver page), RX while its RX runs, otherwise the stored
 * choice, which is what Mulai starts.
 */
export function dockMode(status: ReceiverStatus | null, stored: DockMode): DockMode {
  if (status?.busy === 'sweep') return 'sweep';
  if (status?.running === true) return 'rx';
  return stored;
}

const NOTICE_MESSAGES: Partial<Record<DockNotice, MessageKey>> = {
  NO_WEBUSB: 'spectrum.noWebusb',
  NEEDS_PAIRING: 'spectrum.needsPairing',
  NEEDS_DEVICE_CHOICE: 'spectrum.needsChoice',
  SWEEP_BUSY: 'spectrum.sweepBusy',
  AUDIO_BLOCKED: 'spectrum.audioBlocked',
  OUT_OF_RANGE: 'spectrum.outOfRange',
  CONNECT_FAILED: 'spectrum.connectFailed',
  MOCK_UNAVAILABLE: 'spectrum.mockUnavailable',
  TIMEOUT: 'spectrum.timeout',
  RECORDING_ACTIVE: 'spectrum.recordingActive',
  SWEEP_UNSUPPORTED: 'spectrum.sweepUnsupported',
  SWEEP_FAILED: 'spectrum.sweepFailed',
  USB_LOST: 'spectrum.usbLost',
  RX_ERROR: 'spectrum.rxError',
};

/** Message for a notice code; codes without their own text use spectrum.commandFailed. */
export function noticeMessage(notice: DockNotice): MessageKey {
  return NOTICE_MESSAGES[notice] ?? 'spectrum.commandFailed';
}

/** Codes that leave the radio stopped in an error worth the Receiver page. */
const STOPPED_BAD: ReadonlySet<DockNotice> = new Set<DockNotice>(['USB_LOST', 'RX_ERROR', 'CONNECT_FAILED', 'SWEEP_FAILED']);
const STOPPED_OPEN_RECEIVER: ReadonlySet<DockNotice> = new Set<DockNotice>(['RX_ERROR', 'CONNECT_FAILED', 'SWEEP_FAILED', 'SWEEP_UNSUPPORTED']);

/**
 * The dock's chip and body text for one moment, in priority order: build
 * missing, unresponsive frame, a scan listen on the Receiver page (BUSY), a
 * scan that starts, runs or stops (Spektrum mode), connecting or an RX
 * restart, a code that needs the Receiver page, then RX running or stopped.
 */
export function spectrumDockView({ build, phase, starting, restarting = false, status, notice, storedMode = 'rx' }: DockViewInput): DockView {
  const live = phase === 'ready' ? status : null;
  const mode = dockMode(live, storedMode);
  const rxRunning = live?.running === true;
  const base = { mode, rxRunning, live: false, stoppable: false, controlsDisabled: false, openReceiver: false, message: null };
  if (build === 'missing') {
    return { ...base, chip: 'NOT BUILT', tone: 'warn', message: 'spectrum.notBuilt', rxRunning: false, controlsDisabled: true };
  }
  if (phase === 'unresponsive') {
    return { ...base, chip: 'NO BRIDGE', tone: 'bad', message: 'spectrum.unresponsive', openReceiver: true, rxRunning: false };
  }
  // The Receiver listens to a scan candidate: the radio is its own until that ends.
  if (live && live.busy === 'scan-listen') {
    return { ...base, chip: 'BUSY', tone: 'warn', message: 'spectrum.sweepBusy', openReceiver: true, live: rxRunning, controlsDisabled: true };
  }
  const scan = scanPhaseOf(live);
  if (scan === 'active') {
    return { ...base, chip: 'SCAN', tone: 'good', message: notice ? noticeMessage(notice) : null, live: true, stoppable: true };
  }
  if (scan !== 'idle') {
    return { ...base, chip: '…', tone: 'info', message: scan === 'stopping' ? 'spectrum.sweepStopping' : 'spectrum.sweepStarting', stoppable: scan === 'starting' };
  }
  if (phase === 'connecting' || (starting && !rxRunning)) {
    return { ...base, chip: '…', tone: 'info', message: 'spectrum.connecting' };
  }
  // A sample rate change stops RX for a moment; it is not "RX stopped".
  if (restarting && !rxRunning) {
    return { ...base, chip: '…', tone: 'info', message: 'spectrum.restarting' };
  }
  const usbError = live?.error?.code ?? null;
  const code = notice ?? (usbError === 'NO_WEBUSB' ? usbError : null);
  if (!rxRunning && (code === 'NO_WEBUSB' || code === 'NEEDS_PAIRING' || code === 'NEEDS_DEVICE_CHOICE')) {
    return { ...base, chip: code, tone: code === 'NO_WEBUSB' ? 'bad' : 'warn', message: noticeMessage(code), openReceiver: code !== 'NO_WEBUSB' };
  }
  if (rxRunning) {
    return { ...base, chip: 'RX', tone: 'good', message: notice ? noticeMessage(notice) : null, openReceiver: notice === 'SWEEP_BUSY', live: true, stoppable: true };
  }
  const stoppedBy = notice ?? (usbError === 'USB_LOST' || usbError === 'RX_ERROR' ? usbError : null);
  return {
    ...base,
    chip: mode === 'sweep' ? 'SCAN OFF' : 'RX OFF',
    tone: stoppedBy && STOPPED_BAD.has(stoppedBy) ? 'bad' : stoppedBy === 'SWEEP_UNSUPPORTED' ? 'warn' : 'neutral',
    message: stoppedBy ? noticeMessage(stoppedBy) : null,
    openReceiver: stoppedBy !== null && STOPPED_OPEN_RECEIVER.has(stoppedBy),
  };
}
