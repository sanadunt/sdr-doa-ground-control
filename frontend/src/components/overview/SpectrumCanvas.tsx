import type { JSX, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, Ref } from 'react';
import { useEffect, useImperativeHandle, useRef } from 'react';
import type { ReceiverBridge } from '../../lib/receiverBridge';
import type { BridgeMarker, SpectrumFrame } from '../../lib/receiverBridgeProtocol';
import type { DockMode } from '../../lib/spectrumDockSettings';
import { PALETTE_STOPS } from '../../lib/overlayPalette';
import {
  CLICK_SLOP_PX,
  KEY_STEP_HZ,
  KEY_STEP_LARGE_HZ,
  MARKER_HIT_PX,
  MARKER_HIT_TOUCH_PX,
  MARKER_LABEL_GAP_PX,
  WATERFALL_ROWS,
  autoDbRange,
  axisFor,
  binAt,
  contentBoxX,
  dbToByte,
  formatDb,
  formatMhz,
  freqAtX,
  keyStepHz,
  markerLabelSlots,
  markersInView,
  mhzDigits,
  nearestMarker,
  paletteLut,
  peakOf,
  scanPick,
  snapHz,
  stepMarker,
  sweepAxis,
  ticks,
  waterfallNeedsReset,
  xAtFreq,
} from '../../lib/spectrumView';
import type { DbRange, FrequencyAxis, WaterfallSource } from '../../lib/spectrumView';
import { useI18n } from '../../lib/i18n';

const TICK_COUNT = 5;
const WATERFALL_LUT = paletteLut(PALETTE_STOPS.viridis);

interface Colors { trace: string; grid: string; vfo: string; background: string; marker: string }

const FALLBACK_COLORS: Colors = { trace: '#3cc8dc', grid: '#233040', vfo: '#ebbc70', background: '#0b0f14', marker: '#ff75a0' };
/** Marker labels on the trace: at most this many characters, below the VFO label row (CSS px). */
const MARKER_LABEL_CHARS = 14;
const MARKER_LABEL_TOP_PX = 16;

function readColors(element: Element): Colors {
  try {
    const style = getComputedStyle(element);
    const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    return {
      trace: pick('--accent', FALLBACK_COLORS.trace),
      grid: pick('--line-soft', FALLBACK_COLORS.grid),
      vfo: pick('--signal', FALLBACK_COLORS.vfo),
      background: pick('--bg', FALLBACK_COLORS.background),
      marker: pick('--marker', FALLBACK_COLORS.marker),
    };
  } catch {
    return FALLBACK_COLORS;
  }
}

/** Keep a canvas backing store at its CSS size times the device pixel ratio. */
function fitCanvas(canvas: HTMLCanvasElement): boolean {
  const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

/** Waterfall history in dB (newest row at head - 1), so a new range recolours every row at once. */
export interface Waterfall {
  bins: number;
  head: number;
  filled: number;
  rows: Float32Array;
  image: ImageData | null;
  buffer: HTMLCanvasElement | null;
  /** What the rows hold; a frame of another source, bin count or scan range starts a new history. */
  source?: WaterfallSource | null;
}

/** MHz decimals of the readouts: 3 for RX; for a scan, what one of its bins can tell apart. */
function readoutDigits(mode: DockMode, axis: FrequencyAxis | null, bins: number): number {
  return mode === 'sweep' && axis ? mhzDigits((axis.stopHz - axis.startHz) / Math.max(1, bins)) : 3;
}

/** MHz decimals of the axis ticks: 3 for RX; for a scan, one more than the tick step needs (432.5 between 430 and 435). */
function tickDigits(mode: DockMode, axis: FrequencyAxis | null, count: number): number {
  return mode === 'sweep' && axis ? mhzDigits((axis.stopHz - axis.startHz) / Math.max(1, count - 1) / 10) : 3;
}

/** Paints the whole history with one dB range into the waterfall's backing canvas, newest row on top. */
export function paintWaterfall(state: Waterfall, range: DbRange): void {
  if (!state.image || !state.buffer || state.bins < 1) return;
  const pixels = state.image.data;
  for (let row = 0; row < WATERFALL_ROWS; row++) {
    const source = (state.head - 1 - row + WATERFALL_ROWS) % WATERFALL_ROWS;
    const present = row < state.filled;
    for (let index = 0; index < state.bins; index++) {
      const pixel = (row * state.bins + index) * 4;
      const level = present ? dbToByte(state.rows[source * state.bins + index], range) : 0;
      pixels[pixel] = WATERFALL_LUT[level * 3];
      pixels[pixel + 1] = WATERFALL_LUT[level * 3 + 1];
      pixels[pixel + 2] = WATERFALL_LUT[level * 3 + 2];
      pixels[pixel + 3] = present ? 255 : 0;
    }
  }
  state.buffer.getContext('2d')?.putImageData(state.image, 0, 0);
}

/** How often the automatic range is reported to an open settings column. */
const AUTO_REPORT_MS = 500;

/** A label for the trace: the marker's own, clipped. */
function markerLabel(marker: BridgeMarker): string {
  const text = marker.label || '•';
  return text.length > MARKER_LABEL_CHARS ? `${text.slice(0, MARKER_LABEL_CHARS - 1)}…` : text;
}

/** Marker lines (and on the trace, labels where they fit) over a canvas drawn on `axis`. */
function drawMarkers(
  context: CanvasRenderingContext2D,
  options: { markers: readonly BridgeMarker[]; axis: FrequencyAxis; width: number; height: number; ratio: number; colors: Colors; selectedId: string | null; pendingHz: number | null; dashed: boolean; labels: boolean },
): void {
  const { axis, width, height, ratio, colors, selectedId } = options;
  const shown = markersInView(options.markers, axis, width);
  const pendingX = options.pendingHz === null ? null : xAtFreq(options.pendingHz, axis.startHz, axis.stopHz, width);
  if (!shown.length && (pendingX === null || pendingX < 0 || pendingX > width)) return;
  context.save();
  context.strokeStyle = colors.marker;
  context.globalAlpha = 0.95;
  const line = (x: number, thick: boolean, dash: number[]) => {
    const px = Math.round(x) + 0.5;
    context.lineWidth = Math.max(1, Math.round((thick ? 2 : 1) * ratio));
    context.setLineDash(dash);
    context.beginPath();
    context.moveTo(px, 0);
    context.lineTo(px, height);
    context.stroke();
  };
  const dash = options.dashed ? [3 * ratio, 3 * ratio] : [];
  for (const { marker, x } of shown) line(x, marker.id !== null && marker.id === selectedId, dash);
  if (pendingX !== null && pendingX >= 0 && pendingX <= width) line(pendingX, false, [2 * ratio, 2 * ratio]);
  context.setLineDash([]);
  if (options.labels && shown.length) {
    context.font = `${Math.round(10 * ratio)}px ui-monospace, monospace`;
    context.textBaseline = 'top';
    const texts = shown.map(({ marker }) => markerLabel(marker));
    const widths = texts.map((text) => context.measureText(text).width + 6 * ratio);
    const starts = shown.map(({ x }, index) => Math.max(0, Math.min(width - widths[index], x + 3 * ratio)));
    // Labels that would run into the one before are left out; the picked marker always shows its own.
    const picked = selectedId === null ? -1 : shown.findIndex(({ marker }) => marker.id === selectedId);
    const slots = markerLabelSlots(starts, widths, MARKER_LABEL_GAP_PX * ratio, picked);
    const top = MARKER_LABEL_TOP_PX * ratio;
    shown.forEach(({ marker }, index) => {
      if (!slots[index]) return;
      context.globalAlpha = 0.85;
      context.fillStyle = colors.background;
      context.fillRect(starts[index], top, widths[index], 13 * ratio);
      context.globalAlpha = 1;
      context.fillStyle = colors.marker;
      context.fillText(texts[index], starts[index] + 3 * ratio, top + 1.5 * ratio);
    });
  }
  context.restore();
}

export interface SpectrumCanvasHandle {
  /** The dB range drawn now: the manual one, or the automatic one once a frame arrived. */
  currentRange(): DbRange | null;
}

export interface SpectrumCanvasProps {
  bridge: ReceiverBridge;
  /** RX frames or the wide scan's (Spektrum); frames of the other source are not drawn. */
  mode: DockMode;
  /** The trace is live (RX runs in RX mode, a scan runs in Spektrum mode); otherwise it is dimmed and covered by `overlay`. */
  live: boolean;
  /**
   * Axis before the first frame and while stopped: the span around the RX centre, or the scan range.
   * In RX mode also after a retune until frames at the new centre arrive.
   */
  fallbackView: { startHz: number; stopHz: number } | null;
  /** RX mode: the RX centre the dock shows as tuned; a frame taken at another centre does not set the axis. */
  centerHz: number | null;
  /** Listen VFO band, drawn over the trace. */
  vfo: { frequencyHz: number; bandwidthHz: number } | null;
  /** Info line: centre, span and gains. */
  info: string;
  /** Extra line under the info, such as a follow-node hint or an error. */
  notice?: ReactNode;
  /** Shown over the trace while it is not live. */
  overlay: ReactNode;
  /** Frequency the arrow keys step from: the listen VFO as the dock shows it. */
  tuneHz: number | null;
  onTune: (hz: number) => void;
  /** Manual dB range of the trace and the whole waterfall; null follows the signal (Auto). */
  dbRange: DbRange | null;
  /** The automatic range in whole dB, at most every 500 ms and only when it changed; for the settings column. */
  onAutoRange?: (range: DbRange) => void;
  handle?: Ref<SpectrumCanvasHandle>;
  /** The Receiver's spectrum markers in displayed Hz, drawn on the trace and the waterfall in both modes. */
  markers?: readonly BridgeMarker[];
  selectedMarkerId?: string | null;
  /** A dock mark on its way, drawn dashed until the Receiver's list shows it. */
  pendingMarkHz?: number | null;
  /** Marking mode: a click adds a marker or picks one instead of tuning, and the marker keys work. */
  marking?: boolean;
  onMark?: (hz: number) => void;
  onSelectMarker?: (id: string | null) => void;
  /** Delete/Backspace removes the picked marker; Ctrl/⌘+Z takes back the dock's last mark. */
  onMarkerKey?: (action: 'remove' | 'undo') => void;
}

const NO_MARKERS: readonly BridgeMarker[] = [];

/**
 * Trace and waterfall of the Overview spectrum dock. Frames arrive from the
 * Receiver bridge and are drawn imperatively into canvases; nothing per frame
 * goes through React state (an open settings column gets the automatic range
 * in whole dB, at most twice a second). In RX mode the frames are the 2 MHz
 * around the RX centre; in Spektrum mode the wide scan over its range, read
 * out with the decimals its bins can tell apart. The dB range is Auto
 * (smoothed, from the frames) or the manual dbRange, and applies to the trace
 * and the whole waterfall history. Click (less than 5 px of movement) or the
 * arrow keys tune the RX centre and VFO (on a scan: for the next RX, at the
 * strongest nearby bin); hovering shows the frequency and power under the pointer.
 * The Receiver's markers are lines on the trace (labelled where they fit) and
 * dashed lines on the waterfall. In marking mode a click adds a marker there,
 * or picks the one within a few pixels, and Enter, [ ], Delete and Ctrl/⌘+Z work.
 */
export function SpectrumCanvas({
  bridge, mode, live, fallbackView, centerHz, vfo, info, notice, overlay, tuneHz, onTune, dbRange, onAutoRange, handle,
  markers = NO_MARKERS, selectedMarkerId = null, pendingMarkHz = null, marking = false, onMark, onSelectMarker, onMarkerKey,
}: SpectrumCanvasProps): JSX.Element {
  const { t } = useI18n();
  const traceRef = useRef<HTMLCanvasElement>(null);
  const waterfallRef = useRef<HTMLCanvasElement>(null);
  const peakRef = useRef<HTMLSpanElement>(null);
  // The peak of the last frame; hidden while a stopped scan shows another range than that frame's.
  const peakTextRef = useRef('');
  const topLabelRef = useRef<HTMLSpanElement>(null);
  const bottomLabelRef = useRef<HTMLSpanElement>(null);
  const vfoLabelRef = useRef<HTMLSpanElement>(null);
  const hoverRef = useRef<HTMLSpanElement>(null);
  const ticksRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<SpectrumFrame | null>(null);
  // The automatic range follows every frame, also in Manual, so Auto takes over without a jump.
  const autoRef = useRef<DbRange | null>(null);
  // The range drawn: dbRange, or the automatic one.
  const rangeRef = useRef<DbRange | null>(dbRange);
  const reportedRef = useRef<{ range: DbRange; at: number } | null>(null);
  const colorsRef = useRef<Colors | null>(null);
  const waterfallState = useRef<Waterfall>({ bins: 0, head: 0, filled: 0, rows: new Float32Array(0), image: null, buffer: null, source: null });
  const pointerRef = useRef<{ x: number; y: number; id: number } | null>(null);
  const drawRef = useRef<() => void>(() => undefined);
  const props = useRef({ mode, live, fallbackView, centerHz, vfo, t, tuneHz, dbRange, onAutoRange, markers, selectedMarkerId, pendingMarkHz });
  props.current = { mode, live, fallbackView, centerHz, vfo, t, tuneHz, dbRange, onAutoRange, markers, selectedMarkerId, pendingMarkHz };

  useImperativeHandle(handle, () => ({ currentRange: () => rangeRef.current }), []);

  /** Tells an open settings column the automatic range, in whole dB, when it changed. */
  const reportAuto = (force: boolean) => {
    const report = props.current.onAutoRange;
    const auto = autoRef.current;
    if (!report || !auto) return;
    const range = { min: Math.round(auto.min), max: Math.round(auto.max) };
    const now = Date.now();
    const last = reportedRef.current;
    if (!force && last && (now - last.at < AUTO_REPORT_MS || (last.range.min === range.min && last.range.max === range.max))) return;
    reportedRef.current = { range, at: now };
    report(range);
  };

  /**
   * The axis in use. RX: the last frame while running at the tuned centre, otherwise the expected
   * span. Scan: the last frame's range while the scan runs, otherwise the Receiver's range.
   */
  const view = (): FrequencyAxis | null => {
    const { mode: current, live: drawnLive, fallbackView: expected, centerHz: tunedHz } = props.current;
    const frame = frameRef.current;
    if (current === 'sweep') return sweepAxis(frame?.source === 'sweep' ? frame : null, drawnLive, expected);
    return axisFor(frame?.source === 'rx' ? frame : null, tunedHz, drawnLive, expected);
  };

  drawRef.current = () => {
    const canvas = traceRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const colors = colorsRef.current ?? (colorsRef.current = readColors(canvas));
    const { live: drawnLive, vfo: band, mode: current, markers: markerList, selectedMarkerId: selectedId, pendingMarkHz: pendingHz } = props.current;
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    context.globalAlpha = 1;
    context.strokeStyle = colors.grid;
    context.lineWidth = 1;
    context.beginPath();
    for (const fraction of [1 / 3, 2 / 3]) {
      const y = Math.round(height * fraction) + 0.5;
      context.moveTo(0, y);
      context.lineTo(width, y);
    }
    for (const fraction of [0.25, 0.5, 0.75]) {
      const x = Math.round(width * fraction) + 0.5;
      context.moveTo(x, 0);
      context.lineTo(x, height);
    }
    context.stroke();

    const axis = view();
    const frameNow = frameRef.current;
    // A stopped scan set to another range: its old waterfall and peak do not belong to this axis.
    const staleScan = current === 'sweep' && frameNow?.source === 'sweep' && axis !== null
      && (Math.abs(frameNow.startHz - axis.startHz) > 0.5 || Math.abs(frameNow.stopHz - axis.stopHz) > 0.5);
    if (peakRef.current) {
      const peakText = staleScan ? '' : peakTextRef.current;
      if (peakRef.current.textContent !== peakText) peakRef.current.textContent = peakText;
    }
    const vfoLabel = vfoLabelRef.current;
    let vfoShown = false;
    if (axis && band) {
      const low = xAtFreq(band.frequencyHz - band.bandwidthHz / 2, axis.startHz, axis.stopHz, width);
      const high = xAtFreq(band.frequencyHz + band.bandwidthHz / 2, axis.startHz, axis.stopHz, width);
      if (low !== null && high !== null && high >= 0 && low <= width) {
        const left = Math.max(0, low);
        const span = Math.max(2, Math.min(width, high) - left);
        context.globalAlpha = 0.35;
        context.fillStyle = colors.vfo;
        context.fillRect(left, 0, span, height);
        context.globalAlpha = 1;
        vfoShown = true;
        if (vfoLabel) vfoLabel.style.left = `${Math.min(90, Math.max(0, (left / width) * 100)).toFixed(1)}%`;
      }
    }
    if (vfoLabel) vfoLabel.hidden = !vfoShown;

    const frame = frameRef.current;
    const range = rangeRef.current;
    if (frame && range && axis && range.max > range.min) {
      const bins = frame.bins;
      const count = bins.length;
      const toY = (db: number) => Math.min(height, Math.max(0, ((range.max - db) / (range.max - range.min)) * height));
      context.beginPath();
      for (let index = 0; index < count; index++) {
        const hz = frame.startHz + ((index + 0.5) * (frame.stopHz - frame.startHz)) / count;
        const x = xAtFreq(hz, axis.startHz, axis.stopHz, width) ?? 0;
        const y = toY(bins[index]);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.strokeStyle = colors.trace;
      context.lineWidth = Math.max(1, Math.round(1.4 * (width / Math.max(1, canvas.clientWidth))));
      context.lineJoin = 'round';
      context.globalAlpha = drawnLive ? 1 : 0.35;
      context.stroke();
      context.lineTo(width, height);
      context.lineTo(0, height);
      context.closePath();
      context.fillStyle = colors.trace;
      context.globalAlpha = drawnLive ? 0.12 : 0.05;
      context.fill();
      context.globalAlpha = 1;
    }
    if (axis) {
      drawMarkers(context, { markers: markerList, axis, width, height, ratio: width / Math.max(1, canvas.clientWidth), colors, selectedId, pendingHz, dashed: false, labels: true });
    }
    if (topLabelRef.current) topLabelRef.current.textContent = range ? `${formatDb(range.max, 0)} dBFS` : '';
    if (bottomLabelRef.current) bottomLabelRef.current.textContent = range ? formatDb(range.min, 0) : '';

    const tickRow = ticksRef.current;
    if (tickRow) {
      const labels = axis ? ticks(axis.startHz, axis.stopHz, TICK_COUNT, tickDigits(current, axis, TICK_COUNT)) : [];
      Array.from(tickRow.children).forEach((child, index) => {
        const text = labels[index]?.label ?? '—';
        if (child.textContent !== text) child.textContent = text;
      });
    }

    const fall = waterfallRef.current;
    const state = waterfallState.current;
    const target = fall?.getContext('2d') ?? null;
    if (fall && target) {
      if (state.image && state.buffer && state.filled > 0 && !staleScan) {
        target.fillStyle = colors.background;
        target.fillRect(0, 0, fall.width, fall.height);
        target.globalAlpha = drawnLive ? 1 : 0.5;
        target.imageSmoothingEnabled = true;
        target.drawImage(state.buffer, 0, 0, state.bins, WATERFALL_ROWS, 0, 0, fall.width, fall.height);
        target.globalAlpha = 1;
      } else {
        // No history, or one of another scan range: only the markers.
        target.clearRect(0, 0, fall.width, fall.height);
      }
      if (axis) {
        drawMarkers(target, { markers: markerList, axis, width: fall.width, height: fall.height, ratio: fall.width / Math.max(1, fall.clientWidth), colors, selectedId, pendingHz, dashed: true, labels: false });
      }
    }
  };

  // Spectrum frames: update the range, the waterfall history and the peak, then draw once per animation frame.
  useEffect(() => {
    let scheduled = 0;
    const schedule = () => {
      if (!scheduled) scheduled = window.requestAnimationFrame(() => { scheduled = 0; drawRef.current(); });
    };
    const unsubscribe = bridge.onSpectrum((frame) => {
      // An RX frame in Spektrum mode or a scan frame in RX mode (the other mode just ended) is not drawn.
      if (frame.source !== props.current.mode) return;
      frameRef.current = frame;
      autoRef.current = autoDbRange(frame.bins, autoRef.current);
      const range = props.current.dbRange ?? autoRef.current;
      rangeRef.current = range;
      const state = waterfallState.current;
      const source: WaterfallSource = { source: frame.source, binCount: frame.binCount, startHz: frame.startHz, stopHz: frame.stopHz };
      if (waterfallNeedsReset(state.source ?? null, source) || !state.buffer) {
        if (state.bins !== frame.binCount || !state.buffer) {
          state.bins = frame.binCount;
          state.rows = new Float32Array(frame.binCount * WATERFALL_ROWS);
          state.buffer = state.buffer ?? document.createElement('canvas');
          state.buffer.width = frame.binCount;
          state.buffer.height = WATERFALL_ROWS;
          state.image = state.buffer.getContext('2d')?.createImageData(frame.binCount, WATERFALL_ROWS) ?? null;
        }
        state.head = 0;
        state.filled = 0;
      }
      state.source = source;
      if (state.image && state.buffer) {
        state.rows.set(frame.bins, state.head * state.bins);
        state.head = (state.head + 1) % WATERFALL_ROWS;
        state.filled = Math.min(WATERFALL_ROWS, state.filled + 1);
        // Every row with the current range: Auto and Manual colour the whole history alike.
        if (range) paintWaterfall(state, range);
      }
      reportAuto(false);
      const peak = peakOf(frame.bins, frame.startHz, frame.stopHz);
      const digits = readoutDigits(frame.source, frame, frame.binCount);
      // Shown by the next draw.
      peakTextRef.current = peak ? props.current.t('spectrum.peak', { db: formatDb(peak.db, 1), freq: formatMhz(peak.hz, digits) }) : '';
      schedule();
    });
    return () => {
      unsubscribe();
      window.cancelAnimationFrame(scheduled);
    };
  }, [bridge]);

  // Canvas sizes follow the layout; colours follow the theme.
  useEffect(() => {
    const trace = traceRef.current;
    const fall = waterfallRef.current;
    if (!trace || !fall) return undefined;
    const resize = () => {
      fitCanvas(trace);
      fitCanvas(fall);
      drawRef.current();
    };
    const onTheme = () => {
      colorsRef.current = null;
      drawRef.current();
    };
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(trace);
    observer?.observe(fall);
    window.addEventListener('console-theme-change', onTheme);
    return () => {
      observer?.disconnect();
      window.removeEventListener('console-theme-change', onTheme);
    };
  }, []);

  // A switch between RX and the scan drops the other mode's trace, waterfall and automatic range.
  useEffect(() => {
    if (!frameRef.current || frameRef.current.source === mode) return;
    frameRef.current = null;
    autoRef.current = null;
    rangeRef.current = props.current.dbRange;
    const state = waterfallState.current;
    state.head = 0;
    state.filled = 0;
    state.source = null;
    peakTextRef.current = '';
    drawRef.current();
    const fall = waterfallRef.current;
    fall?.getContext('2d')?.clearRect(0, 0, fall.width, fall.height);
  }, [mode]);

  // A stopped radio or scan, a new VFO, a retune or a marker change redraws without waiting for a frame.
  useEffect(() => {
    drawRef.current();
  }, [live, mode, centerHz, vfo?.frequencyHz, vfo?.bandwidthHz, fallbackView?.startHz, fallbackView?.stopHz, markers, selectedMarkerId, pendingMarkHz]);

  // A new dB range (or Auto) recolours the trace and the whole waterfall at once.
  const manualMin = dbRange?.min;
  const manualMax = dbRange?.max;
  useEffect(() => {
    const range = manualMin !== undefined && manualMax !== undefined ? { min: manualMin, max: manualMax } : autoRef.current;
    rangeRef.current = range;
    if (range) paintWaterfall(waterfallState.current, range);
    drawRef.current();
  }, [manualMin, manualMax]);

  // An opened settings column gets the automatic range at once.
  useEffect(() => {
    reportedRef.current = null;
    reportAuto(true);
    // reportAuto reads the latest props through props.current.
  }, [onAutoRange]);

  /** x across the canvas that was drawn: the trace canvas inside its bordered wrapper, or the waterfall inside its border. */
  const pointerX = (event: ReactPointerEvent<HTMLElement>): { x: number; width: number } | null => {
    const canvas = event.currentTarget === waterfallRef.current ? waterfallRef.current : traceRef.current;
    return canvas ? contentBoxX(event.clientX, canvas) : null;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    // A button in the stopped overlay is not a tune click.
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button, a'))) return;
    pointerRef.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const start = pointerRef.current;
    pointerRef.current = null;
    if (!start || start.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) >= CLICK_SLOP_PX) return;
    const axis = view();
    const point = pointerX(event);
    if (!axis || !point) return;
    const hz = freqAtX(point.x, axis.startHz, axis.stopHz, point.width);
    if (hz === null) return;
    if (marking) {
      // A click next to a marker picks it; elsewhere it adds one.
      const hit = nearestMarker(markers, axis, point.x, point.width, event.pointerType === 'touch' ? MARKER_HIT_TOUCH_PX : MARKER_HIT_PX);
      if (hit) {
        onSelectMarker?.(hit.id);
        return;
      }
    }
    // A scan bin is wide: take the strongest one next to the click.
    const frame = frameRef.current;
    const picked = props.current.mode === 'sweep' && frame?.source === 'sweep' ? scanPick(frame.bins, frame.startHz, frame.stopHz, hz) : null;
    if (marking) onMark?.(snapHz(picked ?? hz));
    else onTune(snapHz(picked ?? hz));
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const hover = hoverRef.current;
    const axis = view();
    if (!hover) return;
    if (!axis) {
      hover.hidden = true;
      return;
    }
    const point = pointerX(event);
    const hz = point ? freqAtX(point.x, axis.startHz, axis.stopHz, point.width) : null;
    if (!point || hz === null) {
      hover.hidden = true;
      return;
    }
    const { x, width } = point;
    const frame = frameRef.current;
    const db = frame ? binAt(frame.bins, frame.startHz, frame.stopHz, hz) : null;
    const digits = readoutDigits(props.current.mode, axis, frame?.binCount ?? 512);
    // While marking, the marker under the pointer is named.
    const near = marking ? nearestMarker(markers, axis, x, width, event.pointerType === 'touch' ? MARKER_HIT_TOUCH_PX : MARKER_HIT_PX) : null;
    hover.textContent = near
      ? props.current.t('spectrum.markReadout', { label: near.label, freq: formatMhz(near.frequencyHz, digits) })
      : props.current.t('spectrum.hover', { freq: formatMhz(hz, digits), db: formatDb(db, 1) });
    hover.style.left = `${Math.min(100, Math.max(0, (x / width) * 100)).toFixed(1)}%`;
    hover.dataset.side = x > width / 2 ? 'left' : 'right';
    hover.hidden = false;
  };

  const onPointerLeave = () => {
    pointerRef.current = null;
    if (hoverRef.current) hoverRef.current.hidden = true;
  };

  /** The marker keys while marking; true when the key was one of them. */
  const markerKey = (event: ReactKeyboardEvent<HTMLElement>): boolean => {
    if (!marking) return false;
    // [ and ] need AltGr (Ctrl+Alt) on some keyboard layouts.
    const altGr = event.ctrlKey && event.altKey && !event.metaKey;
    if ((event.key === '[' || event.key === ']') && (altGr || !(event.ctrlKey || event.metaKey || event.altKey))) {
      event.preventDefault();
      const next = stepMarker(markers, view(), Math.max(1, traceRef.current?.clientWidth ?? 1), selectedMarkerId, event.key === ']' ? 1 : -1);
      if (next) onSelectMarker?.(next.id);
      return true;
    }
    if (event.altKey) return false;
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      onMarkerKey?.('undo');
      return true;
    }
    if (event.ctrlKey || event.metaKey) return false;
    switch (event.key) {
      case 'Enter': {
        event.preventDefault();
        const hz = props.current.tuneHz;
        if (hz !== null) onMark?.(snapHz(hz));
        return true;
      }
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        onMarkerKey?.('remove');
        return true;
      case 'Escape':
        event.preventDefault();
        onSelectMarker?.(null);
        return true;
      default:
        return false;
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (markerKey(event)) return;
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
    if (!direction || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    // A held key steps from the tuning shown after the previous step, not from the last status.
    const axis = view();
    const from = props.current.tuneHz ?? (axis ? (axis.startHz + axis.stopHz) / 2 : null);
    if (from === null) return;
    // On a scan the step follows its span (1/200 of it, at least 10 kHz).
    const step = props.current.mode === 'sweep' && axis ? keyStepHz(axis.stopHz - axis.startHz) : KEY_STEP_HZ;
    const large = props.current.mode === 'sweep' ? step * 10 : KEY_STEP_LARGE_HZ;
    const next = snapHz(from + direction * (event.shiftKey ? large : step));
    // The next repeat may come before the dock re-renders with this value.
    props.current = { ...props.current, tuneHz: next };
    onTune(next);
  };

  const pointerHandlers = { onPointerDown, onPointerUp, onPointerMove, onPointerLeave, onPointerCancel: onPointerLeave };
  const valueText = tuneHz === null ? undefined : `${formatMhz(tuneHz, 3)} MHz`;

  return (
    <div className="ov-spec-body">
      <div className="ov-spec-info">
        <span>{info}</span>
        <span className="ov-spec-peak" ref={peakRef} />
      </div>
      {notice ? <div className="ov-spec-notice" role="status">{notice}</div> : null}
      <div className={`ov-spec-trace${live ? '' : ' is-stopped'}${marking ? ' is-marking' : ''}`} {...pointerHandlers}>
        <canvas
          ref={traceRef}
          className="ov-spec-canvas"
          tabIndex={0}
          role="slider"
          aria-label={t(marking ? 'spectrum.canvasAriaMarking' : mode === 'sweep' ? 'spectrum.canvasAriaSweep' : 'spectrum.canvasAria')}
          aria-valuemin={1}
          aria-valuemax={6000}
          aria-valuenow={tuneHz === null ? undefined : Number((tuneHz / 1e6).toFixed(3))}
          aria-valuetext={valueText}
          onKeyDown={onKeyDown}
        />
        <span className="ov-spec-label is-top" ref={topLabelRef} aria-hidden="true" />
        <span className="ov-spec-label is-bottom" ref={bottomLabelRef} aria-hidden="true" />
        <span className="ov-spec-vfo" ref={vfoLabelRef} aria-hidden="true" hidden>VFO</span>
        <span className="ov-spec-hover" ref={hoverRef} aria-hidden="true" hidden />
        {!live ? <div className="ov-spec-overlay">{overlay}</div> : null}
      </div>
      <div className="ov-spec-ticks" ref={ticksRef} aria-hidden="true">
        {Array.from({ length: TICK_COUNT }, (_value, index) => (
          <span key={index}>{fallbackView ? ticks(fallbackView.startHz, fallbackView.stopHz, TICK_COUNT, tickDigits(mode, fallbackView, TICK_COUNT))[index]?.label ?? '—' : '—'}</span>
        ))}
      </div>
      <canvas ref={waterfallRef} className={`ov-spec-waterfall${marking ? ' is-marking' : ''}`} aria-hidden="true" {...pointerHandlers} />
    </div>
  );
}
