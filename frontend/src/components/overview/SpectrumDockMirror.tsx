import type { JSX, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useI18n } from '../../lib/i18n';
import type { Translate } from '../../lib/i18n';
import { formatDuration } from '../../lib/healthView';
import { mirrorView } from '../../lib/receiverMirror';
import type { MirrorState, MirrorView } from '../../lib/receiverMirror';
import { createMirrorFeed } from '../../lib/receiverMirrorFeed';
import type { ReceiverMirrorFeed } from '../../lib/receiverMirrorFeed';
import { formatMsps } from '../../lib/radioSettings';
import { formatMhz, formatMhzTrim, spanAround } from '../../lib/spectrumView';
import { Icon } from '../ui';
import { SpectrumCanvas } from './SpectrumCanvas';

/** Ages and the stale rules move on with time even when nothing new arrives. */
const AGE_TICK_MS = 500;
const NOOP = (): void => undefined;

/**
 * The mirror as one view: retains the feed while mounted, re-renders when a
 * new answer arrives and every AGE_TICK_MS for the ages and the stale rules.
 */
export function useMirrorView(feed: ReceiverMirrorFeed): MirrorView {
  const feedState = useSyncExternalStore(feed.onState, feed.getState, feed.getState);
  useEffect(() => feed.retain(), [feed]);
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), AGE_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  // A new answer counts from its own arrival, so its ages show as the console sent them.
  const nowMs = Math.max(tick, feedState.receivedAtMs ?? 0);
  return mirrorView({ ...feedState, nowMs });
}

export function mirrorAge(t: Translate, ms: number | null): string {
  return ms === null ? '—' : formatDuration(t, ms);
}

/** The view's chip text: a code, or SOURCE LOST / SUMBER PUTUS. */
export function mirrorChipText(t: Translate, view: MirrorView): string {
  return view.chipKey ? t(view.chipKey) : view.chip;
}

/** The view's message with its age, or null. */
export function mirrorMessage(t: Translate, view: MirrorView): string | null {
  return view.message ? t(view.message, { age: mirrorAge(t, view.messageAgeMs) }) : null;
}

const gainText = (value: number | null | undefined): string => (typeof value === 'number' ? String(Number(value.toFixed(1))) : '—');

/** The info line under the dock head: what the Receiver runs, then the age of the last frame. */
export function mirrorInfoText(t: Translate, view: MirrorView): string {
  const state = view.state;
  const age = t('mirror.frameAge', { age: mirrorAge(t, view.frameAgeMs) });
  if (!state) return age;
  if (view.mode === 'sweep') {
    const rbw = state.scan?.resolution_hz;
    return `${t('mirror.infoSweep', {
      start: formatMhzTrim(state.scan?.start_hz ?? null),
      stop: formatMhzTrim(state.scan?.stop_hz ?? null),
      rbw: typeof rbw === 'number' ? (rbw / 1e3).toFixed(2) : '—',
    })} · ${age}`;
  }
  const span = state.span_hz ?? 2_000_000;
  return `${t('spectrum.info', {
    center: formatMhz(state.center_hz, 3),
    span: (span / 1e6).toFixed(1),
    rate: formatMsps(state.sample_rate_hz),
    lna: gainText(state.gains.lna_db),
    vga: gainText(state.gains.vga_db),
  })}${state.gains.amp ? ` · ${t('spectrum.amp')}` : ''} · ${age}`;
}

/** The axis before a frame arrives: the span around the RX centre, or the scan range. */
function fallbackFor(state: MirrorState | null, mode: MirrorView['mode']): { startHz: number; stopHz: number } | null {
  if (!state) return null;
  if (mode === 'sweep') {
    const start = state.scan?.start_hz;
    const stop = state.scan?.stop_hz;
    return typeof start === 'number' && typeof stop === 'number' && stop > start ? { startHz: start, stopHz: stop } : null;
  }
  return spanAround(state.center_hz, state.span_hz ?? 2_000_000);
}

/**
 * The spectrum and waterfall of a mirror view, drawn by the dock's own canvas
 * from the feed's frames. View only: no tuning, marking or keys.
 */
export function MirrorSpectrum({ feed, view }: { feed: ReceiverMirrorFeed; view: MirrorView }): JSX.Element {
  const { t } = useI18n();
  const state = view.state;
  const fallback = fallbackFor(state, view.mode);
  const fallbackStart = fallback?.startHz;
  const fallbackStop = fallback?.stopHz;
  const fallbackView = useMemo(
    () => (fallbackStart === undefined || fallbackStop === undefined ? null : { startHz: fallbackStart, stopHz: fallbackStop }),
    [fallbackStart, fallbackStop],
  );
  const vfoHz = state?.vfo?.frequency_hz ?? null;
  const vfoBandwidth = state?.vfo?.bandwidth_hz ?? 0;
  const vfo = useMemo(() => (vfoHz === null || view.mode === 'sweep' ? null : { frequencyHz: vfoHz, bandwidthHz: vfoBandwidth }), [vfoHz, vfoBandwidth, view.mode]);
  const message = mirrorMessage(t, view);
  const notice: ReactNode = view.live && message ? <span className={`ov-spec-message tone-${view.tone}`}>{message}</span> : null;
  const overlay = <span>{message ?? t(view.mode === 'sweep' ? 'spectrum.sweepStopped' : 'spectrum.stopped')}</span>;
  return (
    <SpectrumCanvas
      bridge={feed}
      mode={view.mode}
      live={view.live}
      fallbackView={fallbackView}
      centerHz={view.mode === 'rx' ? state?.center_hz ?? null : null}
      vfo={vfo}
      info={mirrorInfoText(t, view)}
      notice={notice}
      overlay={overlay}
      tuneHz={null}
      onTune={NOOP}
      dbRange={null}
      readOnly
    />
  );
}

/**
 * The spectrum dock in the LAN view: the groundstation's Receiver as the
 * console mirrors it (MIRROR), with the age of its last frame, STALE when
 * frames stop and SOURCE LOST / SUMBER PUTUS when the groundstation page
 * stops posting. Every control shows its state and is disabled; no audio.
 */
export function SpectrumDockMirror({ feed: given = null }: { feed?: ReceiverMirrorFeed | null }): JSX.Element {
  const { t } = useI18n();
  // App passes its one feed; a dock rendered on its own (tests) makes one.
  const fallback = useRef<ReceiverMirrorFeed | null>(null);
  if (!given && !fallback.current) fallback.current = createMirrorFeed();
  const feed = given ?? (fallback.current as ReceiverMirrorFeed);
  const view = useMirrorView(feed);
  const state = view.state;
  const shiftHz = state?.frequency_shift_hz ?? 0;
  // From the last state, as on the groundstation's dock; the chip shows STALE or SOURCE LOST.
  const stoppable = view.stoppable;
  const listening = state?.running === true && state.vfo?.enabled === true;
  return (
    <section id="panel-spectrum" className="ov-spectrum is-view-only is-mirror" aria-labelledby="ov-spectrum-title">
      <div className="ov-dock-head ov-spec-head">
        <h2 id="ov-spectrum-title">{t('spectrum.title')}</h2>
        {state?.mock
          ? <span className="ov-tag tone-warn">MOCK</span>
          : <span className="ov-spec-source">{t('mirror.source')}</span>}
        <span className="ov-tag tone-info">MIRROR</span>
        {shiftHz !== 0 ? <span className="ov-tag tone-info">UPCONVERTER</span> : null}
        {state?.recording ? <span className="ov-tag tone-bad">REC</span> : null}
        <span className={`ov-chip tone-${view.tone}`}>{mirrorChipText(t, view)}</span>
        <div className="ov-seg ov-seg-compact ov-spec-mode" role="group" aria-label={t('spectrum.modeGroup')}>
          <button type="button" aria-pressed={view.mode === 'rx'} disabled>{t('spectrum.modeRx')}</button>
          <button type="button" aria-pressed={view.mode === 'sweep'} disabled>{t('spectrum.modeSweep')}</button>
        </div>
        <span className="ov-spacer" />
        <div className="ov-spec-group">
          <button className="ov-button ov-spec-listen" type="button" aria-pressed={listening} disabled>
            <Icon name="headphones" /><span>{t('spectrum.listen')}</span>
          </button>
        </div>
        <div className="ov-spec-group">
          <button className="ov-button ov-spec-run" type="button" disabled>
            <Icon name={stoppable ? 'stop' : 'play'} /><span>{stoppable ? t('spectrum.stop') : t('spectrum.start')}</span>
          </button>
        </div>
      </div>
      <div className="ov-spec-main">
        <MirrorSpectrum feed={feed} view={view} />
      </div>
    </section>
  );
}
