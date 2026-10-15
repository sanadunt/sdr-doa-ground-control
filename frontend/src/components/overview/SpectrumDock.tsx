import type { ChangeEvent, JSX, ReactNode } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ConsoleCapabilities } from '../../api';
import type { TelemetrySnapshot } from '../../types';
import type { OverviewPanels } from '../../lib/overviewPanels';
import type { ConfigPatchChanges } from '../../lib/controlDraft';
import { consoleRequestsMockSdr, createReceiverBridge } from '../../lib/receiverBridge';
import type { BridgeResult, ReceiverBridge } from '../../lib/receiverBridge';
import { SUBSCRIBE_LIMITS, isListenMode } from '../../lib/receiverBridgeProtocol';
import type { BridgeCommand, ListenMode, ReceiverStatus } from '../../lib/receiverBridgeProtocol';
import { nodeFrequencies } from '../../lib/nodeFrequency';
import type { NodeFrequencies } from '../../lib/nodeFrequency';
import { LISTEN_MODE_OPTIONS, loadFollowNode, loadListenMode, saveFollowNode, saveListenMode } from '../../lib/listenPrefs';
import { fieldFor, fieldRange, inFieldRange } from '../../lib/configPatch';
import { followMemoryAtMount, followNodeStep, formatMhz, spanAround, spectrumDockView } from '../../lib/spectrumView';
import type { DockNotice, FollowMemory } from '../../lib/spectrumView';
import { useI18n } from '../../lib/i18n';
import { routeShortcut } from '../../lib/routes';
import type { RouteName } from '../../lib/routes';
import { Icon } from '../ui';
import { SpectrumCanvas } from './SpectrumCanvas';

// The Receiver page's shortcut key follows its place in the page menu.
const RECEIVER_KEY = routeShortcut('receiver');

/**
 * Props of the Overview spectrum dock. Every function prop is stable (state
 * setter or useCallback in App), so the memoized Overview page does not
 * re-render on the 500 ms freshness tick.
 */
export interface SpectrumDockProps {
  snapshot: TelemetrySnapshot | null;
  localSnapshotFresh: boolean;
  capabilities: ConsoleCapabilities | null;
  panels: OverviewPanels;
  onPanelsChange: (next: OverviewPanels) => void;
  /** Pre-fill the Kontrol draft ("Kirim ke RDF-SDR"); it never sends anything by itself. */
  onControlDraftRequest: (changes: ConfigPatchChanges) => void;
  /** Mount the persistent Receiver frame; called synchronously inside the Mulai/Dengar click. */
  onRequestReceiver: () => void;
  onNavigate: (route: RouteName) => void;
  /** The console's one Receiver bridge (App). Without it the dock uses a detached bridge of its own. */
  receiverBridge?: ReceiverBridge;
}

/** Codes a successful start makes obsolete. */
const START_NOTICES: ReadonlySet<DockNotice> = new Set(['NO_WEBUSB', 'NEEDS_PAIRING', 'NEEDS_DEVICE_CHOICE', 'CONNECT_FAILED', 'MOCK_UNAVAILABLE', 'TIMEOUT', 'RX_NOT_RUNNING']);
const SPAN_HZ = SUBSCRIBE_LIMITS.spanDefaultHz;
/** How long the Receiver's own notice (its snackbar is hidden here) stays in the dock after a stop. */
const FRAME_NOTICE_MS = 6_000;
/** Waterfall height kept when the dock grows to fit the rest of the spectrum. */
const WATERFALL_MIN_PX = 48;
/** Set on .ov-stage; --ov-dock-h is at least this tall. */
const DOCK_NEED_PROPERTY = '--ov-spec-need-h';

interface Notice {
  code: DockNotice;
  /** Text from the frame (already localized there), shown as received. */
  message?: string;
}

/** A mode the operator picked, shown until a receiver status newer than its result arrives. */
interface ModePick {
  mode: ListenMode;
  /** The status current when the frame accepted the change; undefined while the change is on its way. */
  settledOn?: ReceiverStatus | null;
}

/**
 * Height the spectrum section needs: its header, then the body's padding,
 * gaps and rows with the waterfall at WATERFALL_MIN_PX, plus the dock border.
 */
function spectrumNeedPx(section: HTMLElement): number | null {
  const head = section.querySelector<HTMLElement>('.ov-spec-head');
  const body = section.querySelector<HTMLElement>('.ov-spec-body');
  if (!head || !body) return null;
  const style = getComputedStyle(body);
  const px = (value: string) => Number.parseFloat(value) || 0;
  const rows = Array.from(body.children) as HTMLElement[];
  let need = head.getBoundingClientRect().height + px(style.paddingTop) + px(style.paddingBottom) + px(style.rowGap) * Math.max(0, rows.length - 1);
  for (const row of rows) {
    need += row.classList.contains('ov-spec-waterfall') ? WATERFALL_MIN_PX + row.offsetHeight - row.clientHeight : row.getBoundingClientRect().height;
  }
  const dock = section.parentElement;
  if (dock) need += dock.offsetHeight - dock.clientHeight;
  return Math.ceil(need);
}

/**
 * Spectrum section of the Overview dock. It drives the hidden, persistent
 * Receiver frame over the bridge: Mulai/Berhenti, Dengar with a mode,
 * click-to-tune and "follow node frequency". "Kirim ke RDF-SDR" only opens
 * Kontrol with a draft; the send itself needs admin, review and a confirm.
 */
export function SpectrumDock({
  snapshot,
  localSnapshotFresh,
  capabilities,
  panels,
  onPanelsChange,
  onControlDraftRequest,
  onRequestReceiver,
  onNavigate,
  receiverBridge,
}: SpectrumDockProps): JSX.Element {
  const { t } = useI18n();
  const fallbackBridge = useRef<ReceiverBridge | null>(null);
  if (!receiverBridge && !fallbackBridge.current) fallbackBridge.current = createReceiverBridge();
  const bridge = receiverBridge ?? (fallbackBridge.current as ReceiverBridge);
  const bridgeState = useSyncExternalStore(bridge.onState, bridge.getState, bridge.getState);
  const { phase, build } = bridgeState;
  const live = phase === 'ready' ? bridgeState.status : null;

  const [followNode, setFollowNodeState] = useState<boolean>(() => loadFollowNode());
  const [mode, setModeState] = useState<ListenMode>(() => loadListenMode());
  const [modePick, setModePick] = useState<ModePick | null>(null);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // A click-to-tune frequency for the next Mulai, while the frame is not mounted.
  const [pendingHz, setPendingHz] = useState<number | null>(null);
  const [mockRequested, setMockRequested] = useState(false);
  // After a dock stop: the Receiver's notice, kept here once it arrives (text null while waiting).
  const [frameNotice, setFrameNotice] = useState<{ text: string | null } | null>(null);
  const mountedRef = useRef(true);
  const frameNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The mode the dock last asked the receiver for; read when a start settles.
  const requestedModeRef = useRef<ListenMode>(mode);
  const sectionRef = useRef<HTMLElement>(null);
  const fitDockRef = useRef<() => void>(() => undefined);

  const fresh = nodeFrequencies(snapshot, localSnapshotFresh);
  const nodeCenter = fresh?.centerHz ?? null;
  const nodeVfo = fresh?.vfoHz ?? null;
  const node = useMemo<NodeFrequencies | null>(() => (nodeCenter === null || nodeVfo === null ? null : { centerHz: nodeCenter, vfoHz: nodeVfo }), [nodeCenter, nodeVfo]);

  const view = spectrumDockView({ build, phase, starting, status: live, notice: notice?.code ?? null });
  const running = view.running;
  const listening = running && live?.vfo?.enabled === true;
  // The VFO is on but the browser has not let its audio play yet.
  const audioHeld = notice?.code === 'AUDIO_BLOCKED' || live?.audio === 'suspended';
  // The select shows what the receiver demodulates (the Receiver page shares the VFO); the stored
  // preference is for the next start. A fresh pick holds until the receiver reports on it.
  const heldMode = modePick && (modePick.settledOn === undefined || modePick.settledOn === bridgeState.status) ? modePick.mode : null;
  const shownMode: ListenMode = heldMode ?? live?.vfo?.mode ?? mode;
  // Mounted over a running receiver, the dock keeps its tuning (see followMemoryAtMount).
  const followRef = useRef<FollowMemory | null>(null);
  if (followRef.current === null) followRef.current = followMemoryAtMount(running, node);

  useEffect(() => {
    mountedRef.current = true;
    setMockRequested(consoleRequestsMockSdr(window.location));
    return () => {
      mountedRef.current = false;
      if (frameNoticeTimer.current !== null) clearTimeout(frameNoticeTimer.current);
      frameNoticeTimer.current = null;
    };
  }, []);

  // The dock grows to fit the spectrum instead of clipping its axis and waterfall: a header that
  // wraps (narrow widths, Polar "Atur" open), a notice line or a two-row info line. --ov-dock-h
  // on .ov-stage reads the height set here; it applies only while the dock floats over the map.
  useLayoutEffect(() => {
    const section = sectionRef.current;
    const stage = section?.closest<HTMLElement>('.ov-stage') ?? null;
    if (!section || !stage) return undefined;
    let last = '';
    let frame = 0;
    const fit = () => {
      const need = spectrumNeedPx(section);
      const value = need === null ? '' : `${need}px`;
      if (value === last) return;
      last = value;
      if (value) stage.style.setProperty(DOCK_NEED_PROPERTY, value);
      else stage.style.removeProperty(DOCK_NEED_PROPERTY);
    };
    fitDockRef.current = fit;
    fit();
    // Width changes and late font loads re-wrap the header; the new height is set on the next frame.
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => { if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; fit(); }); })
      : null;
    for (const element of [section, section.querySelector('.ov-spec-head'), section.querySelector('.ov-spec-info')]) {
      if (element) observer?.observe(element);
    }
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      fitDockRef.current = () => undefined;
      stage.style.removeProperty(DOCK_NEED_PROPERTY);
    };
  }, []);
  // A notice line or a new chip can change the height without a resize of the observed elements.
  useLayoutEffect(() => { fitDockRef.current(); });

  useEffect(() => { bridge.probeBuild(); }, [bridge]);

  // Spectrum frames flow only while this dock is mounted and the page is visible.
  useEffect(() => {
    const update = () => bridge.subscribe({
      spectrum: document.visibilityState === 'visible',
      bins: SUBSCRIBE_LIMITS.binsDefault,
      fps: SUBSCRIBE_LIMITS.fpsDefault,
      spanHz: SPAN_HZ,
    });
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      bridge.subscribe({ spectrum: false });
    };
  }, [bridge]);

  // A running receiver makes the start errors obsolete.
  useEffect(() => {
    if (running) setNotice((current) => (current && START_NOTICES.has(current.code) ? null : current));
  }, [running]);

  const report = (result: BridgeResult): void => {
    if (!mountedRef.current) return;
    setNotice(result.ok ? null : { code: result.code, message: result.message });
  };
  const reportFailure = (result: BridgeResult): void => {
    if (!result.ok) report(result);
  };

  // Follow the node: retune when its frequency moves by more than 1 kHz, and once when RX starts.
  const liveCenter = live?.centerHz ?? null;
  const liveVfo = live?.vfo?.frequencyHz ?? null;
  const liveBusy = live?.busy ?? 'none';
  const liveKnown = live !== null;
  useEffect(() => {
    const step = followNodeStep(followRef.current ?? followMemoryAtMount(running, node), {
      follow: followNode,
      node,
      running,
      canTune: phase === 'ready' && liveKnown && liveBusy === 'none' && !starting,
      liveCenterHz: liveCenter,
      liveVfoHz: liveVfo,
    });
    followRef.current = step.memory;
    if (step.tune) void bridge.send({ type: 'console:tune', centerHz: step.tune.centerHz, vfoHz: step.tune.vfoHz }).then(reportFailure);
  }, [followNode, node, phase, running, liveKnown, liveBusy, liveCenter, liveVfo, starting, bridge]);

  // The Receiver's snackbar text lasts about 3 s; the dock keeps it for FRAME_NOTICE_MS.
  const liveNotice = live?.notice ?? null;
  useEffect(() => {
    if (frameNotice && frameNotice.text === null && liveNotice) setFrameNotice({ text: liveNotice });
  }, [frameNotice, liveNotice]);

  const setFollowNode = (next: boolean) => {
    setFollowNodeState(next);
    saveFollowNode(next);
    // Turning it on retunes to the node at once.
    if (next && followRef.current) followRef.current = { ...followRef.current, followed: null };
  };

  /** Where Mulai tunes: the node under follow-node, otherwise the last click while the frame was away. */
  const target: NodeFrequencies | null = followNode && node ? node : pendingHz !== null ? { centerHz: pendingHz, vfoHz: pendingHz } : null;

  const start = (listen: boolean) => {
    // Mount the frame and post the command inside this click, so the frame can use the gesture.
    onRequestReceiver();
    setStarting(true);
    setNotice(null);
    const startMode = shownMode;
    requestedModeRef.current = startMode;
    const command: BridgeCommand = { type: 'console:start', mock: consoleRequestsMockSdr(window.location), listen, mode: startMode };
    if (target) {
      command.centerHz = target.centerHz;
      command.vfoHz = target.vfoHz;
      if (followNode && node && followRef.current) followRef.current = { ...followRef.current, followed: node };
    }
    void bridge.send(command).then((result) => {
      if (!mountedRef.current) return;
      setStarting(false);
      report(result);
      if (!result.ok) return;
      setPendingHz(null);
      // A mode picked while this start waited behind another Receiver task reached the
      // frame first and was then replaced by the start's own mode: send it again.
      const wanted = requestedModeRef.current;
      if (wanted !== startMode) void bridge.send({ type: 'console:vfo', mode: wanted }).then(reportFailure);
    });
  };

  const showFrameNotice = () => {
    if (frameNoticeTimer.current !== null) clearTimeout(frameNoticeTimer.current);
    setFrameNotice({ text: null });
    frameNoticeTimer.current = setTimeout(() => {
      frameNoticeTimer.current = null;
      if (mountedRef.current) setFrameNotice(null);
    }, FRAME_NOTICE_MS);
  };

  const stop = () => {
    // Berhenti also ends a VFO audio recording armed on the Receiver page: ask first.
    const endsRecording = live?.recording === true;
    if (endsRecording && !window.confirm(t('spectrum.stopRecordingConfirm'))) return;
    setNotice(null);
    void bridge.send({ type: 'console:stop' }).then((result) => {
      report(result);
      // The Receiver reports the ended recording in its own snackbar, which is hidden here.
      if (endsRecording && result.ok && mountedRef.current) showFrameNotice();
    });
  };

  const toggleListen = () => {
    // A VFO that is on while the browser holds the audio back: this click is the
    // gesture the AudioContext needs, so ask again instead of turning it off.
    if (listening && audioHeld) {
      void bridge.send({ type: 'console:listen', enabled: true }).then(report);
      return;
    }
    if (listening) {
      void bridge.send({ type: 'console:listen', enabled: false }).then(report);
      return;
    }
    if (!running) {
      start(true);
      return;
    }
    const frequencyHz = followNode && node ? node.vfoHz : liveVfo ?? undefined;
    void bridge.send(frequencyHz === undefined ? { type: 'console:vfo', mode: shownMode } : { type: 'console:vfo', mode: shownMode, frequencyHz }).then(reportFailure);
    void bridge.send({ type: 'console:listen', enabled: true }).then(report);
  };

  const changeMode = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    if (!isListenMode(next)) return;
    setModeState(next);
    saveListenMode(next);
    requestedModeRef.current = next;
    // Without a frame the next start carries the mode.
    if (phase === 'idle' && !starting) return;
    // Before the frame's hello the bridge queues it behind a waiting start.
    setModePick({ mode: next });
    void bridge.send({ type: 'console:vfo', mode: next }).then((result) => {
      if (!mountedRef.current) return;
      // A refused change shows the receiver's mode again.
      setModePick((current) => (current?.mode !== next || current.settledOn !== undefined ? current : result.ok ? { mode: next, settledOn: bridge.getState().status } : null));
      reportFailure(result);
    });
  };

  // Click-to-tune sets the RX centre and the listen VFO and stops following the node.
  const tune = (hz: number) => {
    if (!Number.isFinite(hz)) return;
    setFollowNode(false);
    if (phase === 'idle' && !starting) {
      // No frame yet: the next Mulai tunes here.
      setPendingHz(hz);
      return;
    }
    // While a start is on its way the tune waits in the bridge queue behind it.
    void bridge.send({ type: 'console:tune', centerHz: hz, vfoHz: hz }).then((result) => {
      report(result);
      if (result.ok && mountedRef.current) setPendingHz(null);
    });
  };

  // "Kirim ke RDF-SDR": the RX centre and listen VFO as a Kontrol draft.
  const ranges = capabilities?.configPatch?.ranges ?? null;
  const rxCenterHz = live?.centerHz ?? target?.centerHz ?? null;
  const rxVfoHz = liveVfo ?? target?.vfoHz ?? rxCenterHz;
  const sendable = rxCenterHz !== null && rxVfoHz !== null
    && inFieldRange('center_frequency_hz', rxCenterHz, ranges) && inFieldRange('vfo_frequency_hz', rxVfoHz, ranges);
  const [rangeMin, rangeMax] = fieldRange(fieldFor('center_frequency_hz'), ranges);
  const sendTitle = rxCenterHz === null
    ? t('spectrum.sendNoFrequency')
    : sendable
      ? t('spectrum.sendTitle', { center: formatMhz(rxCenterHz, 3), vfo: formatMhz(rxVfoHz, 3) })
      : t('spectrum.sendOutOfRange', { min: formatMhz(rangeMin, 0), max: formatMhz(rangeMax, 0) });
  const sendDraft = () => {
    if (!sendable || rxCenterHz === null || rxVfoHz === null) return;
    onPanelsChange({ ...panels, control: true });
    onControlDraftRequest({ center_frequency_hz: rxCenterHz, vfo_frequency_hz: rxVfoHz });
  };

  const sampleRate = live?.sampleRateHz ?? null;
  const spanHz = sampleRate !== null && sampleRate > 0 ? Math.min(SPAN_HZ, sampleRate) : SPAN_HZ;
  const axisCenter = running ? liveCenter : pendingHz ?? liveCenter ?? target?.centerHz ?? null;
  const fallbackView = spanAround(axisCenter, spanHz);
  const fallbackStart = fallbackView?.startHz;
  const fallbackStop = fallbackView?.stopHz;
  const stableFallback = useMemo(() => (fallbackStart === undefined || fallbackStop === undefined ? null : { startHz: fallbackStart, stopHz: fallbackStop }), [fallbackStart, fallbackStop]);
  const vfoHz = liveVfo ?? (pendingHz ?? target?.vfoHz ?? null);
  const vfoBandwidth = live?.vfo?.bandwidthHz ?? 0;
  const vfoBand = useMemo(() => (vfoHz === null ? null : { frequencyHz: vfoHz, bandwidthHz: vfoBandwidth }), [vfoHz, vfoBandwidth]);
  const gainText = (value: number | null | undefined) => (typeof value === 'number' ? String(Number(value.toFixed(1))) : '—');
  const info = t('spectrum.info', {
    center: formatMhz(axisCenter, 3),
    span: (spanHz / 1e6).toFixed(1),
    lna: gainText(live?.gains.lnaDb),
    vga: gainText(live?.gains.vgaDb),
  });

  const openReceiverButton = (
    <button className="ov-button ov-spec-inline-button" type="button" onClick={() => onNavigate('receiver')}>
      <Icon name="external" /><span>{t('spectrum.openReceiverShort', { key: RECEIVER_KEY })}</span>
    </button>
  );
  const frameText = notice?.message && (notice.code === 'CONNECT_FAILED' || notice.code === 'NOT_READY' || notice.code === 'INVALID_COMMAND') ? notice.message : null;
  const messageText = view.message ? t(view.message) : null;
  const followHint = followNode && !node ? t('spectrum.followUnavailable') : null;
  // The Receiver's own notice after a dock stop, such as the ended recording (already localized there).
  const frameNoticeLine = frameNotice?.text ? <span className="ov-spec-message tone-warn">{frameNotice.text}</span> : null;
  let lineNotice: ReactNode = frameNoticeLine;
  if (running && (messageText || followHint)) {
    lineNotice = (
      <>
        {messageText ? <span className={`ov-spec-message tone-${view.tone === 'good' ? 'warn' : view.tone}`}>{messageText}{frameText ? ` (${frameText})` : ''}</span> : null}
        {followHint ? <span className="ov-spec-message tone-neutral">{followHint}</span> : null}
        {frameNoticeLine}
        {view.openReceiver ? openReceiverButton : null}
      </>
    );
  } else if (!running && followHint && !view.message) {
    lineNotice = <><span className="ov-spec-message tone-neutral">{followHint}</span>{frameNoticeLine}</>;
  }
  const overlay = (
    <>
      <span>{messageText ?? t('spectrum.stopped')}{frameText ? ` (${frameText})` : ''}</span>
      {view.openReceiver ? openReceiverButton : null}
    </>
  );

  const mock = live?.mock === true || (mockRequested && !live?.connected);
  const shiftHz = live?.frequencyShiftHz ?? 0;

  return (
    <section id="panel-spectrum" className="ov-spectrum" aria-labelledby="ov-spectrum-title" ref={sectionRef}>
      <div className="ov-dock-head ov-spec-head">
        <h2 id="ov-spectrum-title">{t('spectrum.title')}</h2>
        {mock
          ? <span className="ov-tag tone-warn">MOCK</span>
          : <span className="ov-spec-source">{t('spectrum.sourceHackrf')}</span>}
        {shiftHz !== 0 ? <span className="ov-tag tone-info" title={t('spectrum.upconverterTitle', { shift: formatMhz(shiftHz, 3) })}>UPCONVERTER</span> : null}
        {live?.recording ? <span className="ov-tag tone-bad">REC</span> : null}
        <span className={`ov-chip tone-${view.tone}`}>{view.chip}</span>
        <span className="ov-spacer" />
        {/* Follow, mode and Dengar wrap as one group, as do Mulai/Berhenti and the Receiver link. */}
        <div className="ov-spec-group">
          <label className="ov-spec-follow">
            <input type="checkbox" checked={followNode} onChange={(event) => setFollowNode(event.target.checked)} />
            <span>{t('spectrum.follow')}</span>
          </label>
          <select className="ov-listen-mode" aria-label={t('spectrum.mode')} title={t('spectrum.mode')} value={shownMode} onChange={changeMode}>
            {LISTEN_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button
            className="ov-button ov-spec-listen"
            type="button"
            aria-pressed={listening}
            title={listening && !audioHeld ? t('spectrum.listenStop') : undefined}
            disabled={view.controlsDisabled}
            onClick={toggleListen}
          >
            <Icon name="headphones" /><span>{t('spectrum.listen')}</span>
          </button>
        </div>
        <button className="ov-button ov-spec-send" type="button" disabled={!sendable} title={sendTitle} onClick={sendDraft}>
          <Icon name="send" /><span>{t('spectrum.send')}</span>
        </button>
        <div className="ov-spec-group">
          <button
            className="ov-button ov-spec-run"
            type="button"
            disabled={view.controlsDisabled || (starting && !running)}
            onClick={() => (running ? stop() : start(false))}
          >
            <Icon name={running ? 'stop' : 'play'} /><span>{running ? t('spectrum.stop') : t('spectrum.start')}</span>
          </button>
          <button className="ov-button ov-spec-open" type="button" aria-keyshortcuts={RECEIVER_KEY} aria-label={t('spectrum.openReceiver')} onClick={() => onNavigate('receiver')}>
            <Icon name="external" /><span className="ov-spec-open-label">{t('spectrum.openReceiver')}</span><kbd aria-hidden="true">{RECEIVER_KEY}</kbd>
          </button>
        </div>
      </div>
      <SpectrumCanvas
        bridge={bridge}
        running={running}
        fallbackView={stableFallback}
        vfo={vfoBand}
        info={info}
        notice={lineNotice}
        overlay={overlay}
        tuneHz={vfoHz}
        onTune={tune}
      />
    </section>
  );
}
