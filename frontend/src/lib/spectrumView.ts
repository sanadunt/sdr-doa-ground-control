/**
 * Pure helpers for the Overview spectrum dock: pixel <-> frequency mapping,
 * snapping, the automatic dB scale, the peak, axis ticks, the waterfall
 * palette and the dock's state table. Frequencies are integer Hz.
 */
import type { MessageKey } from './i18n';
import type { BridgePhase, ReceiverBuild } from './receiverBridge';
import type { ReceiverStatus, ResultCode, StatusErrorCode } from './receiverBridgeProtocol';

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

/** `count` evenly spaced labels from start to stop, both ends included. */
export function ticks(startHz: number, stopHz: number, count = 5): Array<{ hz: number; label: string }> {
  if (!Number.isFinite(startHz) || !Number.isFinite(stopHz) || stopHz <= startHz || count < 2) return [];
  return Array.from({ length: count }, (_value, index) => {
    const hz = startHz + ((stopHz - startHz) * index) / (count - 1);
    return { hz, label: formatMhz(hz, 3) };
  });
}

/** The axis span around a centre frequency, used before any frame has arrived. */
export function spanAround(centerHz: number | null | undefined, spanHz: number): { startHz: number; stopHz: number } | null {
  if (typeof centerHz !== 'number' || !Number.isFinite(centerHz) || !Number.isFinite(spanHz) || spanHz <= 0) return null;
  return { startHz: centerHz - spanHz / 2, stopHz: centerHz + spanHz / 2 };
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

export type DockTone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';

/** A code the dock keeps from the last command result or a status error. */
export type DockNotice = ResultCode | StatusErrorCode;

export interface DockViewInput {
  build: ReceiverBuild;
  phase: BridgePhase;
  /** A Mulai/Dengar start is waiting for its result. */
  starting: boolean;
  status: ReceiverStatus | null;
  /** Code of the last failed dock command, cleared by the next success. */
  notice: DockNotice | null;
}

export interface DockView {
  /** Untranslated status code for the chip. */
  chip: string;
  tone: DockTone;
  /** Text for the body, or null when the trace speaks for itself. */
  message: MessageKey | null;
  /** Offer "Buka Receiver (7)" next to the message. */
  openReceiver: boolean;
  running: boolean;
  /** Mulai and Dengar cannot run (build missing or the Receiver is busy). */
  controlsDisabled: boolean;
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
  USB_LOST: 'spectrum.usbLost',
  RX_ERROR: 'spectrum.rxError',
};

/** Message for a notice code; codes without their own text use spectrum.commandFailed. */
export function noticeMessage(notice: DockNotice): MessageKey {
  return NOTICE_MESSAGES[notice] ?? 'spectrum.commandFailed';
}

/**
 * The dock's chip and body text for one moment, in priority order: build
 * missing, unresponsive frame, connecting, busy Receiver, a code that needs
 * the Receiver page, then running or stopped.
 */
export function spectrumDockView({ build, phase, starting, status, notice }: DockViewInput): DockView {
  if (build === 'missing') {
    return { chip: 'NOT BUILT', tone: 'warn', message: 'spectrum.notBuilt', openReceiver: false, running: false, controlsDisabled: true };
  }
  const live = phase === 'ready' ? status : null;
  const running = live?.running === true;
  if (phase === 'unresponsive') {
    return { chip: 'NO BRIDGE', tone: 'bad', message: 'spectrum.unresponsive', openReceiver: true, running: false, controlsDisabled: false };
  }
  if (live && live.busy !== 'none') {
    return { chip: 'BUSY', tone: 'warn', message: 'spectrum.sweepBusy', openReceiver: true, running, controlsDisabled: true };
  }
  if (phase === 'connecting' || (starting && !running)) {
    return { chip: '…', tone: 'info', message: 'spectrum.connecting', openReceiver: false, running: false, controlsDisabled: false };
  }
  const usbError = live?.error?.code ?? null;
  const code = notice ?? (usbError === 'NO_WEBUSB' ? usbError : null);
  if (!running && (code === 'NO_WEBUSB' || code === 'NEEDS_PAIRING' || code === 'NEEDS_DEVICE_CHOICE')) {
    return { chip: code, tone: code === 'NO_WEBUSB' ? 'bad' : 'warn', message: noticeMessage(code), openReceiver: code !== 'NO_WEBUSB', running: false, controlsDisabled: false };
  }
  if (running) {
    return { chip: 'RX', tone: 'good', message: notice ? noticeMessage(notice) : null, openReceiver: notice === 'SWEEP_BUSY', running: true, controlsDisabled: false };
  }
  const stoppedBy = notice ?? (usbError === 'USB_LOST' || usbError === 'RX_ERROR' ? usbError : null);
  return {
    chip: 'RX OFF',
    tone: stoppedBy === 'USB_LOST' || stoppedBy === 'RX_ERROR' || stoppedBy === 'CONNECT_FAILED' ? 'bad' : 'neutral',
    message: stoppedBy ? noticeMessage(stoppedBy) : null,
    openReceiver: stoppedBy === 'RX_ERROR' || stoppedBy === 'CONNECT_FAILED',
    running: false,
    controlsDisabled: false,
  };
}
