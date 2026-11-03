import type { JSX, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useI18n } from '../../lib/i18n';
import type { Lang, MessageKey, Translate } from '../../lib/i18n';
import { formatDuration } from '../../lib/healthView';
import type { BridgeMarker } from '../../lib/receiverBridgeProtocol';
import { mirrorView } from '../../lib/receiverMirror';
import type { MirrorState, MirrorView } from '../../lib/receiverMirror';
import { createMirrorFeed } from '../../lib/receiverMirrorFeed';
import type { ReceiverMirrorFeed } from '../../lib/receiverMirrorFeed';
import { createMirrorMarkClient, createMirrorMarkController, mirrorMarkBlocked, mirrorMarkMessage } from '../../lib/receiverMirrorMarks';
import { MIRROR_AUDIO_LIMITS, mirrorAudioPlayer } from '../../lib/receiverMirrorAudio';
import type { MirrorAudioPlayer, MirrorAudioState } from '../../lib/receiverMirrorAudio';
import type { MirrorMarkContext, MirrorMarkController, MirrorMarkState } from '../../lib/receiverMirrorMarks';
import { formatMsps } from '../../lib/radioSettings';
import { formatMhz, formatMhzTrim, spanAround } from '../../lib/spectrumView';
import { Icon } from '../ui';
import { SpectrumCanvas } from './SpectrumCanvas';
import { SpectrumMarkRow, SpectrumModeLabel } from './SpectrumDock';

/** Ages and the stale rules move on with time even when nothing new arrives. */
const AGE_TICK_MS = 500;
const NOOP = (): void => undefined;
const NO_MARKERS: readonly BridgeMarker[] = [];

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
    // The scan's own gains, as the groundstation dock shows them; never the RX gains.
    const rbw = state.scan?.resolution_hz;
    const gains = state.scan?.gains ?? null;
    return `${t('spectrum.infoSweep', {
      start: formatMhzTrim(state.scan?.start_hz ?? null),
      stop: formatMhzTrim(state.scan?.stop_hz ?? null),
      rbw: typeof rbw === 'number' ? (rbw / 1e3).toFixed(2) : '—',
      lna: gainText(gains?.lna_db),
      vga: gainText(gains?.vga_db),
    })}${gains?.amp ? ` · ${t('spectrum.amp')}` : ''} · ${age}`;
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

/** The viewer's marking of the groundstation Receiver's markers, for one mirror view. */
export interface MirrorMarking {
  state: MirrorMarkState;
  /** Why marking cannot send now (no live source, stale frames), or null. */
  blocked: MessageKey | null;
  markers: readonly BridgeMarker[];
  /** Markers in the Receiver's list; null before the groundstation sent it. */
  total: number | null;
  /** The list is saved to a marker set on the groundstation (null: not known yet). */
  saved: boolean | null;
  selected: BridgeMarker | null;
  context: MirrorMarkContext;
  controller: MirrorMarkController;
}

/**
 * Marking in the LAN view: the Markers/Penanda toggle (off at every mount,
 * never saved), the picked marker, the mark on its way and the last failure,
 * kept by a controller that sends one command per click through the console
 * to the groundstation page. The groundstation's list is the mirror's.
 */
export function useMirrorMarking(view: MirrorView, given: MirrorMarkController | null = null): MirrorMarking {
  // Tests pass a controller; otherwise each view has its own, with this page's marker client.
  const controllerRef = useRef<MirrorMarkController | null>(null);
  if (!given && !controllerRef.current) controllerRef.current = createMirrorMarkController(createMirrorMarkClient());
  const controller = given ?? (controllerRef.current as MirrorMarkController);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const markers = view.markers?.markers ?? NO_MARKERS;
  const blocked = mirrorMarkBlocked(view);
  const context: MirrorMarkContext = { blocked, frequencyShiftHz: view.state?.frequency_shift_hz ?? 0, markers };
  const selected = state.selectedId === null ? null : markers.find((marker) => marker.id === state.selectedId) ?? null;
  return { state, blocked, markers, total: view.markers?.total ?? null, saved: view.markers?.saved ?? null, selected, context, controller };
}

/**
 * The text beside Dengar in the LAN view: the estimated latency while audio
 * plays, otherwise why there is none (from the player and the mirror's state).
 * Null while the tablet does not listen.
 */
export function mirrorAudioText(t: Translate, lang: Lang, audio: MirrorAudioState, view: MirrorView): string | null {
  switch (audio.status) {
    case 'off':
      return null;
    case 'connecting':
    case 'buffering':
      return t('mirror.audio.connecting');
    case 'playing': {
      const seconds = ((audio.latencyMs ?? 0) / 1000).toFixed(1);
      return t('mirror.audio.latency', { latency: lang === 'id' ? seconds.replace('.', ',') : seconds });
    }
    case 'retrying':
      return view.phase === 'lost' || view.phase === 'none' ? mirrorChipText(t, view) : t('mirror.audio.retrying');
    case 'busy':
      return t('mirror.audio.busy', { max: MIRROR_AUDIO_LIMITS.maxListeners });
    case 'blocked':
      return t('mirror.audio.blocked');
    case 'unsupported':
      return t('mirror.audio.unsupported');
    case 'silent': {
      const state = view.state;
      if (view.phase === 'lost' || view.phase === 'none' || !state) return mirrorChipText(t, view);
      const phase = state.scan?.phase;
      if (state.busy === 'sweep' || phase === 'starting' || phase === 'active') return t('mirror.audio.scan');
      if (!state.running) return t('mirror.audio.rxOff');
      return t('mirror.audio.silent');
    }
    default:
      return null;
  }
}

/**
 * Dengar/Listen in the LAN view: the tablet hears the groundstation Receiver
 * (docs/RECEIVER_MIRROR.md 10a). The click starts the page's one player
 * inside the gesture, so the browser lets it play; a second click stops it,
 * or resumes audio the browser held. Off at every page load.
 */
export function MirrorListenButton({ view, player: given = null }: { view: MirrorView; player?: MirrorAudioPlayer | null }): JSX.Element {
  const { t, lang } = useI18n();
  const player = given ?? mirrorAudioPlayer();
  const audio = useSyncExternalStore(player.subscribe, player.getState, player.getState);
  const on = audio.status !== 'off' && audio.status !== 'unsupported';
  const text = mirrorAudioText(t, lang, audio, view);
  const tone = audio.status === 'playing' ? 'good' : audio.status === 'busy' || audio.status === 'blocked' || audio.status === 'unsupported' || audio.status === 'retrying' ? 'warn' : 'muted';
  return (
    <div className="ov-spec-group ov-spec-audio-group">
      <button
        className="ov-button ov-spec-listen"
        type="button"
        aria-pressed={on}
        onClick={() => { if (on && audio.status !== 'blocked') player.stop(); else player.start(); }}
      >
        <Icon name="headphones" /><span>{t('spectrum.listen')}</span>
      </button>
      {text ? <span className={`ov-spec-audio tone-${tone}`} role="status">{text}</span> : null}
    </div>
  );
}

/** The Markers/Penanda toggle with the list's count; it stays usable so a blocked reason shows when it is turned on. */
export function MirrorMarkToggle({ marking }: { marking: MirrorMarking }): JSX.Element {
  const { t } = useI18n();
  return (
    <button
      className="ov-button ov-spec-mark"
      type="button"
      aria-pressed={marking.state.on}
      title={marking.blocked ? t(marking.blocked) : undefined}
      onClick={marking.controller.toggle}
    >
      <Icon name="marker" /><span className="ov-spec-mark-label">{t('spectrum.mark')}</span>
      {marking.total ? <span className="ov-spec-mark-count">{marking.total}</span> : null}
    </button>
  );
}

/** The marking part of the notice line: the picked marker with Remove, Not saved, sending, the blocked reason, the last failure. */
function MirrorMarkRow({ marking }: { marking: MirrorMarking }): JSX.Element | null {
  const { t } = useI18n();
  const { state, blocked, selected, saved, context, controller } = marking;
  if (!state.on) return null;
  const lines: ReactNode[] = [];
  if (blocked) lines.push(<span key="blocked" className="ov-spec-message tone-warn">{t(blocked)}</span>);
  else if (state.sending > 0) lines.push(<span key="sending" className="ov-spec-message tone-info">{t('mirror.markSending')}</span>);
  if (state.notice) lines.push(<span key="notice" className="ov-spec-message tone-warn">{t(mirrorMarkMessage(state.notice))}</span>);
  if (!selected && saved !== false && !lines.length) return null;
  return (
    <SpectrumMarkRow
      marker={selected}
      unsaved={saved === false}
      notice={null}
      onRemove={(id) => controller.remove(id, context)}
      status={lines}
    />
  );
}

/**
 * The spectrum and waterfall of a mirror view, drawn by the dock's own canvas
 * from the feed's frames. View only: no tuning or arrow keys. With `marking`
 * on and a live source, a click adds a marker to the groundstation Receiver's
 * list or picks one, and the marker keys work.
 */
export function MirrorSpectrum({ feed, view, marking = null }: { feed: ReceiverMirrorFeed; view: MirrorView; marking?: MirrorMarking | null }): JSX.Element {
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
  const markRow = marking ? <MirrorMarkRow marking={marking} /> : null;
  const liveLine = view.live && message ? <span className={`ov-spec-message tone-${view.tone}`}>{message}</span> : null;
  const notice: ReactNode = liveLine || markRow ? <>{liveLine}{markRow}</> : null;
  const overlay = <span>{message ?? t(view.mode === 'sweep' ? 'spectrum.sweepStopped' : 'spectrum.stopped')}</span>;
  // Marking sends only while the source is live; the reason shows in the notice line.
  const active = marking !== null && marking.state.on && marking.blocked === null;
  const context = marking?.context ?? null;
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
      tuneHz={active ? vfoHz : null}
      onTune={NOOP}
      dbRange={null}
      markers={marking?.markers ?? NO_MARKERS}
      selectedMarkerId={marking?.selected?.id ?? null}
      pendingMarkHz={marking?.state.pendingHz ?? null}
      marking={active}
      onMark={context ? (hz) => marking?.controller.mark(hz, context) : undefined}
      onSelectMarker={marking?.controller.select}
      onMarkerKey={context ? (action) => marking?.controller.key(action, context) : undefined}
      readOnly
    />
  );
}

/**
 * The spectrum dock in the LAN view: the groundstation's Receiver as the
 * console mirrors it (MIRROR), with the age of its last frame, STALE when
 * frames stop and SOURCE LOST / SUMBER PUTUS when the groundstation page
 * stops posting. Every radio control shows its state and is disabled, but
 * two: Markers/Penanda adds and removes the groundstation Receiver's markers
 * (the owner's decision of 2026-10-31), and Dengar/Listen plays its audio on
 * this tablet (the owner's decision of 2026-11-02). In the compact touch
 * layout the header keeps one row: no source text, buttons as icons.
 */
export function SpectrumDockMirror({ feed: given = null, markController = null, audioPlayer = null, compact = false }: {
  feed?: ReceiverMirrorFeed | null;
  markController?: MirrorMarkController | null;
  /** Tests pass a player; otherwise the page's one (mirrorAudioPlayer()). */
  audioPlayer?: MirrorAudioPlayer | null;
  compact?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  // App passes its one feed; a dock rendered on its own (tests) makes one.
  const fallback = useRef<ReceiverMirrorFeed | null>(null);
  if (!given && !fallback.current) fallback.current = createMirrorFeed();
  const feed = given ?? (fallback.current as ReceiverMirrorFeed);
  const view = useMirrorView(feed);
  const marking = useMirrorMarking(view, markController);
  const state = view.state;
  const shiftHz = state?.frequency_shift_hz ?? 0;
  // From the last state, as on the groundstation's dock; the chip shows STALE or SOURCE LOST.
  const stoppable = view.stoppable;
  return (
    <section id="panel-spectrum" className={`ov-spectrum is-view-only is-mirror${compact ? ' is-compact' : ''}`} aria-labelledby="ov-spectrum-title">
      <div className="ov-dock-head ov-spec-head">
        <h2 id="ov-spectrum-title">{t('spectrum.title')}</h2>
        {state?.mock
          ? <span className="ov-tag tone-warn">MOCK</span>
          : compact ? null : <span className="ov-spec-source">{t('mirror.source')}</span>}
        <span className="ov-tag tone-info">MIRROR</span>
        {shiftHz !== 0 ? <span className="ov-tag tone-info">UPCONVERTER</span> : null}
        {state?.recording ? <span className="ov-tag tone-bad">REC</span> : null}
        <span className={`ov-chip tone-${view.tone}`}>{mirrorChipText(t, view)}</span>
        <div className="ov-seg ov-seg-compact ov-spec-mode" role="group" aria-label={t('spectrum.modeGroup')}>
          <button type="button" aria-pressed={view.mode === 'rx'} disabled><SpectrumModeLabel compact={compact} icon="receiver" text={t('spectrum.modeRx')} /></button>
          <button type="button" aria-pressed={view.mode === 'sweep'} disabled><SpectrumModeLabel compact={compact} icon="spectrum" text={t('spectrum.modeSweep')} /></button>
        </div>
        <MirrorMarkToggle marking={marking} />
        <span className="ov-spacer" />
        <MirrorListenButton view={view} player={audioPlayer} />
        <div className="ov-spec-group">
          <button className="ov-button ov-spec-run" type="button" disabled>
            <Icon name={stoppable ? 'stop' : 'play'} /><span>{stoppable ? t('spectrum.stop') : t('spectrum.start')}</span>
          </button>
        </div>
      </div>
      <div className="ov-spec-main">
        <MirrorSpectrum feed={feed} view={view} marking={marking} />
      </div>
    </section>
  );
}
