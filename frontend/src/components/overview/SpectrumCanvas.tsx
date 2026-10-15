import type { JSX, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, Ref } from 'react';
import { useEffect, useImperativeHandle, useRef } from 'react';
import type { ReceiverBridge } from '../../lib/receiverBridge';
import type { RxSpectrumFrame } from '../../lib/receiverBridgeProtocol';
import { PALETTE_STOPS } from '../../lib/overlayPalette';
import {
  CLICK_SLOP_PX,
  KEY_STEP_HZ,
  KEY_STEP_LARGE_HZ,
  WATERFALL_ROWS,
  autoDbRange,
  axisFor,
  binAt,
  contentBoxX,
  dbToByte,
  formatDb,
  formatMhz,
  freqAtX,
  paletteLut,
  peakOf,
  snapHz,
  ticks,
  xAtFreq,
} from '../../lib/spectrumView';
import type { DbRange } from '../../lib/spectrumView';
import { useI18n } from '../../lib/i18n';

const TICK_COUNT = 5;
const WATERFALL_LUT = paletteLut(PALETTE_STOPS.viridis);

interface Colors { trace: string; grid: string; vfo: string; background: string }

const FALLBACK_COLORS: Colors = { trace: '#3cc8dc', grid: '#233040', vfo: '#ebbc70', background: '#0b0f14' };

function readColors(element: Element): Colors {
  try {
    const style = getComputedStyle(element);
    const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    return {
      trace: pick('--accent', FALLBACK_COLORS.trace),
      grid: pick('--line-soft', FALLBACK_COLORS.grid),
      vfo: pick('--signal', FALLBACK_COLORS.vfo),
      background: pick('--bg', FALLBACK_COLORS.background),
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

export interface SpectrumCanvasHandle {
  /** The dB range drawn now: the manual one, or the automatic one once a frame arrived. */
  currentRange(): DbRange | null;
}

export interface SpectrumCanvasProps {
  bridge: ReceiverBridge;
  /** RX is running; a stopped trace is dimmed and covered by `overlay`. */
  running: boolean;
  /** Axis before the first frame, while stopped, and after a retune until frames at the new centre arrive. */
  fallbackView: { startHz: number; stopHz: number } | null;
  /** The RX centre the dock shows as tuned; a frame taken at another centre does not set the axis. */
  centerHz: number | null;
  /** Listen VFO band, drawn over the trace. */
  vfo: { frequencyHz: number; bandwidthHz: number } | null;
  /** Info line: centre, span and gains. */
  info: string;
  /** Extra line under the info, such as a follow-node hint or an error. */
  notice?: ReactNode;
  /** Shown over the trace while RX is stopped. */
  overlay: ReactNode;
  /** Frequency the arrow keys step from: the listen VFO as the dock shows it. */
  tuneHz: number | null;
  onTune: (hz: number) => void;
  /** Manual dB range of the trace and the whole waterfall; null follows the signal (Auto). */
  dbRange: DbRange | null;
  /** The automatic range in whole dB, at most every 500 ms and only when it changed; for the settings column. */
  onAutoRange?: (range: DbRange) => void;
  handle?: Ref<SpectrumCanvasHandle>;
}

/**
 * Trace and waterfall of the Overview spectrum dock. Frames arrive from the
 * Receiver bridge and are drawn imperatively into canvases; nothing per frame
 * goes through React state (an open settings column gets the automatic range
 * in whole dB, at most twice a second). The dB range is Auto (smoothed, from
 * the frames) or the manual dbRange, and applies to the trace and the whole
 * waterfall history. Click (less than 5 px of movement) or the arrow keys
 * tune; hovering shows the frequency and power under the pointer.
 */
export function SpectrumCanvas({ bridge, running, fallbackView, centerHz, vfo, info, notice, overlay, tuneHz, onTune, dbRange, onAutoRange, handle }: SpectrumCanvasProps): JSX.Element {
  const { t } = useI18n();
  const traceRef = useRef<HTMLCanvasElement>(null);
  const waterfallRef = useRef<HTMLCanvasElement>(null);
  const peakRef = useRef<HTMLSpanElement>(null);
  const topLabelRef = useRef<HTMLSpanElement>(null);
  const bottomLabelRef = useRef<HTMLSpanElement>(null);
  const vfoLabelRef = useRef<HTMLSpanElement>(null);
  const hoverRef = useRef<HTMLSpanElement>(null);
  const ticksRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<RxSpectrumFrame | null>(null);
  // The automatic range follows every frame, also in Manual, so Auto takes over without a jump.
  const autoRef = useRef<DbRange | null>(null);
  // The range drawn: dbRange, or the automatic one.
  const rangeRef = useRef<DbRange | null>(dbRange);
  const reportedRef = useRef<{ range: DbRange; at: number } | null>(null);
  const colorsRef = useRef<Colors | null>(null);
  const waterfallState = useRef<Waterfall>({ bins: 0, head: 0, filled: 0, rows: new Float32Array(0), image: null, buffer: null });
  const pointerRef = useRef<{ x: number; y: number; id: number } | null>(null);
  const drawRef = useRef<() => void>(() => undefined);
  const props = useRef({ running, fallbackView, centerHz, vfo, t, tuneHz, dbRange, onAutoRange });
  props.current = { running, fallbackView, centerHz, vfo, t, tuneHz, dbRange, onAutoRange };

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

  /** The axis in use: the last frame while running at the tuned centre, otherwise the expected span. */
  const view = (): { startHz: number; stopHz: number } | null => {
    const { running: live, fallbackView: expected, centerHz: tunedHz } = props.current;
    return axisFor(frameRef.current, tunedHz, live, expected);
  };

  drawRef.current = () => {
    const canvas = traceRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const colors = colorsRef.current ?? (colorsRef.current = readColors(canvas));
    const { running: live, vfo: band } = props.current;
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
      context.globalAlpha = live ? 1 : 0.35;
      context.stroke();
      context.lineTo(width, height);
      context.lineTo(0, height);
      context.closePath();
      context.fillStyle = colors.trace;
      context.globalAlpha = live ? 0.12 : 0.05;
      context.fill();
      context.globalAlpha = 1;
    }
    if (topLabelRef.current) topLabelRef.current.textContent = range ? `${formatDb(range.max, 0)} dBFS` : '';
    if (bottomLabelRef.current) bottomLabelRef.current.textContent = range ? formatDb(range.min, 0) : '';

    const tickRow = ticksRef.current;
    if (tickRow) {
      const labels = axis ? ticks(axis.startHz, axis.stopHz, TICK_COUNT) : [];
      Array.from(tickRow.children).forEach((child, index) => {
        const text = labels[index]?.label ?? '—';
        if (child.textContent !== text) child.textContent = text;
      });
    }

    const fall = waterfallRef.current;
    const state = waterfallState.current;
    if (fall && state.image && state.buffer && state.filled > 0) {
      const target = fall.getContext('2d');
      if (target) {
        target.fillStyle = colors.background;
        target.fillRect(0, 0, fall.width, fall.height);
        target.globalAlpha = live ? 1 : 0.5;
        target.imageSmoothingEnabled = true;
        target.drawImage(state.buffer, 0, 0, state.bins, WATERFALL_ROWS, 0, 0, fall.width, fall.height);
        target.globalAlpha = 1;
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
      if (frame.source !== 'rx') return;
      frameRef.current = frame;
      autoRef.current = autoDbRange(frame.bins, autoRef.current);
      const range = props.current.dbRange ?? autoRef.current;
      rangeRef.current = range;
      const state = waterfallState.current;
      if (state.bins !== frame.binCount || !state.buffer) {
        state.bins = frame.binCount;
        state.rows = new Float32Array(frame.binCount * WATERFALL_ROWS);
        state.head = 0;
        state.filled = 0;
        state.buffer = state.buffer ?? document.createElement('canvas');
        state.buffer.width = frame.binCount;
        state.buffer.height = WATERFALL_ROWS;
        state.image = state.buffer.getContext('2d')?.createImageData(frame.binCount, WATERFALL_ROWS) ?? null;
      }
      if (state.image && state.buffer) {
        state.rows.set(frame.bins, state.head * state.bins);
        state.head = (state.head + 1) % WATERFALL_ROWS;
        state.filled = Math.min(WATERFALL_ROWS, state.filled + 1);
        // Every row with the current range: Auto and Manual colour the whole history alike.
        if (range) paintWaterfall(state, range);
      }
      reportAuto(false);
      const peak = peakOf(frame.bins, frame.startHz, frame.stopHz);
      if (peakRef.current) {
        peakRef.current.textContent = peak ? props.current.t('spectrum.peak', { db: formatDb(peak.db, 1), freq: formatMhz(peak.hz, 3) }) : '';
      }
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

  // A stopped radio, a new VFO or a retune redraws without waiting for a frame.
  useEffect(() => {
    drawRef.current();
  }, [running, centerHz, vfo?.frequencyHz, vfo?.bandwidthHz, fallbackView?.startHz, fallbackView?.stopHz]);

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
    if (hz !== null) onTune(snapHz(hz));
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
    hover.textContent = props.current.t('spectrum.hover', { freq: formatMhz(hz, 3), db: formatDb(db, 1) });
    hover.style.left = `${Math.min(100, Math.max(0, (x / width) * 100)).toFixed(1)}%`;
    hover.dataset.side = x > width / 2 ? 'left' : 'right';
    hover.hidden = false;
  };

  const onPointerLeave = () => {
    pointerRef.current = null;
    if (hoverRef.current) hoverRef.current.hidden = true;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
    if (!direction || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    // A held key steps from the tuning shown after the previous step, not from the last status.
    const from = props.current.tuneHz ?? (() => { const axis = view(); return axis ? (axis.startHz + axis.stopHz) / 2 : null; })();
    if (from === null) return;
    const next = snapHz(from + direction * (event.shiftKey ? KEY_STEP_LARGE_HZ : KEY_STEP_HZ));
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
      <div className={`ov-spec-trace${running ? '' : ' is-stopped'}`} {...pointerHandlers}>
        <canvas
          ref={traceRef}
          className="ov-spec-canvas"
          tabIndex={0}
          role="slider"
          aria-label={t('spectrum.canvasAria')}
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
        {!running ? <div className="ov-spec-overlay">{overlay}</div> : null}
      </div>
      <div className="ov-spec-ticks" ref={ticksRef} aria-hidden="true">
        {Array.from({ length: TICK_COUNT }, (_value, index) => <span key={index}>{fallbackView ? ticks(fallbackView.startHz, fallbackView.stopHz, TICK_COUNT)[index]?.label ?? '—' : '—'}</span>)}
      </div>
      <canvas ref={waterfallRef} className="ov-spec-waterfall" aria-hidden="true" {...pointerHandlers} />
    </div>
  );
}
