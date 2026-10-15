import type { ChangeEvent, Dispatch, JSX, ReactNode, SetStateAction } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ConsoleCapabilities } from '../../api';
import type { TelemetrySnapshot } from '../../types';
import type { OverviewPanels } from '../../lib/overviewPanels';
import type { ConfigPatchChanges } from '../../lib/controlDraft';
import { consoleRequestsMockSdr, createReceiverBridge } from '../../lib/receiverBridge';
import type { BridgeResult, ReceiverBridge } from '../../lib/receiverBridge';
import { SUBSCRIBE_LIMITS, SWEEP_SPAN_LIMITS, inTuneRange, isListenMode } from '../../lib/receiverBridgeProtocol';
import type { BridgeCommand, GainKind, ListenMode, ResultCode, SweepFftSize } from '../../lib/receiverBridgeProtocol';
import { nodeFrequencies } from '../../lib/nodeFrequency';
import type { NodeFrequencies } from '../../lib/nodeFrequency';
import { LISTEN_MODE_OPTIONS, followNodeStore, listenModeStore } from '../../lib/listenPrefs';
import { displayedTuning, settleLocalTune } from '../../lib/receiverSync';
import type { LocalTune } from '../../lib/receiverSync';
import { savedReceiverTuning } from '../../lib/receiverSavedTuning';
import { savedReceiverSweep } from '../../lib/receiverSavedSweep';
import { recentredRange, sweepRows } from '../../lib/sweepSettings';
import type { SweepRange } from '../../lib/sweepSettings';
import { fieldFor, fieldRange, inFieldRange } from '../../lib/configPatch';
import { followMemoryAtMount, followNodeStep, formatMhz, formatMhzTrim, scanPhaseOf, spanAround, spectrumDockView } from '../../lib/spectrumView';
import type { DbRange, DockNotice, FollowMemory } from '../../lib/spectrumView';
import { manualFromDrawn, spectrumDockStore } from '../../lib/spectrumDockSettings';
import type { DbScale, DockMode, SpectrumDockSettings } from '../../lib/spectrumDockSettings';
import { formatMsps, heldValue, radioRows, settlePick } from '../../lib/radioSettings';
import type { HeldPick } from '../../lib/radioSettings';
import { useI18n } from '../../lib/i18n';
import { routeShortcut } from '../../lib/routes';
import type { RouteName } from '../../lib/routes';
import { Icon } from '../ui';
import { SpectrumCanvas } from './SpectrumCanvas';
import type { SpectrumCanvasHandle } from './SpectrumCanvas';
import { SpectrumSettings } from './SpectrumSettings';

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

/** Codes a successful start (RX or scan) makes obsolete. */
const START_NOTICES: ReadonlySet<DockNotice> = new Set([
  'NO_WEBUSB', 'NEEDS_PAIRING', 'NEEDS_DEVICE_CHOICE', 'CONNECT_FAILED', 'MOCK_UNAVAILABLE', 'TIMEOUT', 'RX_NOT_RUNNING', 'SWEEP_FAILED', 'SWEEP_UNSUPPORTED',
]);
/** Start results that leave a click-to-tune frequency unapplied; any other start tuned before it connected. */
const START_KEEPS_PENDING: ReadonlySet<ResultCode> = new Set(['SWEEP_BUSY', 'OUT_OF_RANGE', 'NOT_READY', 'INVALID_COMMAND', 'TIMEOUT']);
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

/** A sample rate change on its way: 'restart' while it restarts a running RX. */
type RadioPending = 'restart' | 'set' | null;

/** The Receiver's Graph min./max. before it reports one. */
const SWEEP_DISPLAY_DEFAULT = { minDb: -60, maxDb: 0 } as const;

function setDockSettings(patch: Partial<SpectrumDockSettings>): void {
  spectrumDockStore.set({ ...spectrumDockStore.get(), ...patch });
}

/**
 * Height the spectrum section needs: its header, then the body's padding,
 * gaps and rows with the waterfall at WATERFALL_MIN_PX, or the open "Atur"
 * column when that is taller and sits beside the trace, plus the dock border.
 */
function spectrumNeedPx(section: HTMLElement): number | null {
  const head = section.querySelector<HTMLElement>('.ov-spec-head');
  const body = section.querySelector<HTMLElement>('.ov-spec-body');
  if (!head || !body) return null;
  const style = getComputedStyle(body);
  const px = (value: string) => Number.parseFloat(value) || 0;
  const rows = Array.from(body.children) as HTMLElement[];
  let bodyNeed = px(style.paddingTop) + px(style.paddingBottom) + px(style.rowGap) * Math.max(0, rows.length - 1);
  for (const row of rows) {
    bodyNeed += row.classList.contains('ov-spec-waterfall') ? WATERFALL_MIN_PX + row.offsetHeight - row.clientHeight : row.getBoundingClientRect().height;
  }
  // The column's own content, not its stretched box, so the dock can shrink again. Over the trace
  // (a narrow dock) the column scrolls instead.
  const settings = section.querySelector<HTMLElement>('.ov-spec-settings');
  let settingsNeed = 0;
  if (settings) {
    const columnStyle = getComputedStyle(settings);
    if (columnStyle.position === 'static') {
      const shown = (Array.from(settings.children) as HTMLElement[]).filter((child) => child.getClientRects().length > 0);
      settingsNeed = px(columnStyle.paddingTop) + px(columnStyle.paddingBottom) + px(columnStyle.rowGap) * Math.max(0, shown.length - 1);
      for (const child of shown) settingsNeed += child.getBoundingClientRect().height;
    }
  }
  let need = head.getBoundingClientRect().height + Math.max(bodyNeed, settingsNeed);
  const dock = section.parentElement;
  if (dock) need += dock.offsetHeight - dock.clientHeight;
  return Math.ceil(need);
}

/**
 * Spectrum section of the Overview dock. It drives the hidden, persistent
 * Receiver frame over the bridge: Mulai/Berhenti, Dengar with a mode,
 * click-to-tune and "follow node frequency". "Kirim ke RDF-SDR" only opens
 * Kontrol with a draft; the send itself needs admin, review and a confirm.
 *
 * The frame owns the centre and the VFO. The dock shows a click-to-tune at
 * once and then what the frame reports (TuneView); a refused tune snaps back.
 * Follow-node and the mode live in page-wide stores, because App also changes
 * them after a Receiver-page change (lib/receiverSync.ts).
 *
 * The RX|Spektrum switch picks what the dock shows and Mulai starts: RX (the
 * 2 MHz around the RX centre) or the Receiver's wide scan over its own range.
 * The dock shows the mode that runs, also a scan started on the Receiver page;
 * the stored choice applies while nothing runs. In Spektrum mode Mulai and
 * Berhenti start and stop the scan, a click sets the RX centre and VFO for the
 * next RX (the scan keeps running), and Dengar stops the scan and starts RX.
 *
 * The header keeps one row on a wide dock; on a narrow one follow-node, the
 * mode and "Kirim ke RDF-SDR" move into the "Atur" column (CSS shows one of
 * the two copies). In RX mode the column holds the RX dB scale, shared with
 * the Receiver's Dengar tab through spectrumDockStore and App's display sync,
 * and the Listener's sample rate, LNA, VGA and +14 dB amp; in Spektrum mode
 * the scan's dB scale (Manual is the Receiver's Graph min./max.), range,
 * resolution and gains, read-only while a scan runs. The frame owns all of
 * them: the dock shows its status and holds a pick until the frame reports it.
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

  const followNode = useSyncExternalStore(followNodeStore.subscribe, followNodeStore.get, followNodeStore.get);
  const mode = useSyncExternalStore(listenModeStore.subscribe, listenModeStore.get, listenModeStore.get);
  // Picks shown until the frame reports them (lib/radioSettings.ts); one token counter for all.
  const pickToken = useRef(0);
  const [modePick, setModePick] = useState<HeldPick<ListenMode> | null>(null);
  const [ratePick, setRatePick] = useState<HeldPick<number> | null>(null);
  const [lnaPick, setLnaPick] = useState<HeldPick<number> | null>(null);
  const [vgaPick, setVgaPick] = useState<HeldPick<number> | null>(null);
  const [ampPick, setAmpPick] = useState<HeldPick<boolean> | null>(null);
  // The scan's settings and Graph min./max., held the same way.
  const [rangePick, setRangePick] = useState<HeldPick<SweepRange> | null>(null);
  const [fftPick, setFftPick] = useState<HeldPick<SweepFftSize> | null>(null);
  const [sweepLnaPick, setSweepLnaPick] = useState<HeldPick<number> | null>(null);
  const [sweepVgaPick, setSweepVgaPick] = useState<HeldPick<number> | null>(null);
  const [sweepAmpPick, setSweepAmpPick] = useState<HeldPick<boolean> | null>(null);
  const [sweepDbPick, setSweepDbPick] = useState<HeldPick<{ minDb: number; maxDb: number }> | null>(null);
  const [radioPending, setRadioPending] = useState<RadioPending>(null);
  // A dock tune shown until the frame reports it (lib/receiverSync.ts displayedTuning).
  const [localTune, setLocalTune] = useState<LocalTune | null>(null);
  const tuneToken = useRef(0);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The RX dB scale: the Receiver's once its frame reports it, otherwise the last one known.
  const dockSettings = useSyncExternalStore(spectrumDockStore.subscribe, spectrumDockStore.get, spectrumDockStore.get);
  const rxDb = dockSettings.rxDb;
  const canvasHandle = useRef<SpectrumCanvasHandle | null>(null);
  // The automatic range, in whole dB and at most twice a second, only while the column shows it.
  const [autoRange, setAutoRange] = useState<DbRange | null>(null);
  const onAutoRange = useCallback((range: DbRange) => { setAutoRange(range); }, []);

  const fresh = nodeFrequencies(snapshot, localSnapshotFresh);
  const nodeCenter = fresh?.centerHz ?? null;
  const nodeVfo = fresh?.vfoHz ?? null;
  const node = useMemo<NodeFrequencies | null>(() => (nodeCenter === null || nodeVfo === null ? null : { centerHz: nodeCenter, vfoHz: nodeVfo }), [nodeCenter, nodeVfo]);

  const view = spectrumDockView({ build, phase, starting, restarting: radioPending === 'restart', status: live, notice: notice?.code ?? null, storedMode: dockSettings.mode });
  const dockMode = view.mode;
  const running = view.rxRunning;
  const scanPhase = scanPhaseOf(live);
  const scanBusy = scanPhase !== 'idle';
  const listening = running && live?.vfo?.enabled === true;
  // The VFO is on but the browser has not let its audio play yet.
  const audioHeld = notice?.code === 'AUDIO_BLOCKED' || live?.audio === 'suspended';
  // The select shows what the receiver demodulates (the Receiver page shares the VFO); the stored
  // preference is for the next start. A fresh pick holds until the receiver reports on it.
  const shownMode: ListenMode = heldValue(modePick, bridgeState.status) ?? live?.vfo?.mode ?? mode;
  // The Listener's radio settings, as the frame reports them and with a fresh pick held.
  const shownRate = heldValue(ratePick, bridgeState.status) ?? live?.sampleRateHz ?? null;
  const shownLna = heldValue(lnaPick, bridgeState.status) ?? live?.gains.lnaDb ?? null;
  const shownVga = heldValue(vgaPick, bridgeState.status) ?? live?.gains.vgaDb ?? null;
  const shownAmp = heldValue(ampPick, bridgeState.status) ?? (live ? live.gains.amp : null);
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

  // A running receiver or scan makes the start errors obsolete.
  const drawnLive = view.live;
  useEffect(() => {
    if (drawnLive) setNotice((current) => (current && START_NOTICES.has(current.code) ? null : current));
  }, [drawnLive]);

  // The stored mode follows what runs, also a scan or RX started on the Receiver page, so the dock
  // keeps showing that mode once it stops.
  const runningMode: DockMode | null = live?.busy === 'sweep' ? 'sweep' : live?.running ? 'rx' : null;
  useEffect(() => {
    if (runningMode !== null && spectrumDockStore.get().mode !== runningMode) setDockSettings({ mode: runningMode });
  }, [runningMode]);
  // Each mode has its own automatic range.
  useEffect(() => { setAutoRange(null); }, [dockMode]);

  const report = (result: BridgeResult): void => {
    if (!mountedRef.current) return;
    setNotice(result.ok ? null : { code: result.code, message: result.message });
  };
  const reportFailure = (result: BridgeResult): void => {
    if (!result.ok) report(result);
  };

  // What the Receiver reports (the highest tune rev seen), and what the dock shows: its own tune until confirmed.
  const tuneView = phase === 'ready' ? bridgeState.tune : null;
  const liveCenter = tuneView?.centerHz ?? live?.centerHz ?? null;
  const liveVfo = tuneView?.vfoHz ?? live?.vfo?.frequencyHz ?? null;
  const shown = displayedTuning(localTune, tuneView);
  const shownCenter = shown?.centerHz ?? liveCenter;
  const shownVfo = shown?.vfoHz ?? liveVfo;
  // Before the frame is mounted, the Receiver's last saved tuning (read only).
  const idle = phase === 'idle';
  const saved = useMemo(() => (idle ? savedReceiverTuning() : null), [idle]);

  // Follow the node: retune when its frequency moves by more than 1 kHz, and once when RX starts.
  const liveBusy = live?.busy ?? 'none';
  const liveKnown = live !== null;
  useEffect(() => {
    const step = followNodeStep(followRef.current ?? followMemoryAtMount(running, node), {
      follow: followNode,
      node,
      running,
      canTune: phase === 'ready' && liveKnown && liveBusy === 'none' && !starting && !radioPending,
      liveCenterHz: liveCenter,
      liveVfoHz: liveVfo,
    });
    followRef.current = step.memory;
    if (step.tune) void bridge.send({ type: 'console:tune', centerHz: step.tune.centerHz, vfoHz: step.tune.vfoHz }).then(reportFailure);
  }, [followNode, node, phase, running, liveKnown, liveBusy, liveCenter, liveVfo, starting, radioPending, bridge]);

  // The Receiver's snackbar text lasts about 3 s; the dock keeps it for FRAME_NOTICE_MS.
  const liveNotice = live?.notice ?? null;
  useEffect(() => {
    if (frameNotice && frameNotice.text === null && liveNotice) setFrameNotice({ text: liveNotice });
  }, [frameNotice, liveNotice]);

  const setFollowNode = (next: boolean) => {
    followNodeStore.set(next);
    // Turning it on retunes to the node at once.
    if (next && followRef.current) followRef.current = { ...followRef.current, followed: null };
  };

  /** Where Mulai tunes: the node under follow-node, otherwise the last click while the frame was away. */
  const target: NodeFrequencies | null = followNode && node ? node : pendingHz !== null ? { centerHz: pendingHz, vfoHz: pendingHz } : null;

  const start = (listen: boolean) => {
    // Mount the frame and post the command inside this click, so the frame can use the gesture.
    onRequestReceiver();
    if (spectrumDockStore.get().mode !== 'rx') setDockSettings({ mode: 'rx' });
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
      if (!START_KEEPS_PENDING.has(result.code)) setPendingHz(null);
      if (!result.ok) return;
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

  /** Starts the Receiver's wide scan over its own range; confirmRecording after the operator agreed to end a recording. */
  const startScan = (confirmRecording: boolean) => {
    onRequestReceiver();
    setStarting(true);
    setNotice(null);
    if (spectrumDockStore.get().mode !== 'sweep') setDockSettings({ mode: 'sweep' });
    const mock = consoleRequestsMockSdr(window.location);
    const command: BridgeCommand = confirmRecording ? { type: 'console:sweep-start', mock, confirmRecording: true } : { type: 'console:sweep-start', mock };
    void bridge.send(command).then((result) => {
      if (!mountedRef.current) return;
      setStarting(false);
      report(result);
      // A scan that did not start over a running RX leaves the dock on RX.
      if (!result.ok && bridge.getState().status?.running === true) setDockSettings({ mode: 'rx' });
    });
  };

  const stopScan = () => {
    setNotice(null);
    void bridge.send({ type: 'console:sweep-stop', resumeRx: false }).then(report);
  };

  /** RX|Spektrum: with nothing running it only picks what Mulai starts; otherwise it stops one and starts the other. */
  const chooseMode = (next: DockMode) => {
    if (next === dockMode) return;
    if (next === 'sweep') {
      if (!running) {
        setDockSettings({ mode: 'sweep' });
        return;
      }
      // The scan stops RX, which ends a VFO audio recording armed on the Receiver page: ask first.
      const endsRecording = live?.recording === true;
      if (endsRecording && !window.confirm(t('spectrum.sweepRecordingConfirm'))) return;
      startScan(endsRecording);
      return;
    }
    if (!scanBusy) {
      setDockSettings({ mode: 'rx' });
      return;
    }
    // The frame runs these one after another: the scan stops before RX starts.
    void bridge.send({ type: 'console:sweep-stop', resumeRx: false }).then(reportFailure);
    start(false);
  };

  const toggleListen = () => {
    // Spektrum mode: the radio cannot scan and listen at once, so Dengar stops the scan and starts RX.
    if (dockMode === 'sweep') {
      if (scanBusy) void bridge.send({ type: 'console:sweep-stop', resumeRx: false }).then(reportFailure);
      start(true);
      return;
    }
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
    // The shown VFO: a dock tune still on its way must not be undone by this command.
    const frequencyHz = followNode && node ? node.vfoHz : shownVfo ?? undefined;
    void bridge.send(frequencyHz === undefined ? { type: 'console:vfo', mode: shownMode } : { type: 'console:vfo', mode: shownMode, frequencyHz }).then(reportFailure);
    void bridge.send({ type: 'console:listen', enabled: true }).then(report);
  };

  /**
   * Shows `value` at once and sends the command; an accepted pick holds until the next
   * status, a refused one shows the receiver's value again. `done` replaces the failure notice.
   */
  function sendHeld<T>(setPick: Dispatch<SetStateAction<HeldPick<T> | null>>, value: T, command: BridgeCommand, done?: (result: BridgeResult) => void): void {
    pickToken.current += 1;
    const token = pickToken.current;
    setPick({ value, token });
    void bridge.send(command).then((result) => {
      if (!mountedRef.current) return;
      setPick((current) => settlePick(current, token, result.ok, bridge.getState().status));
      if (done) done(result);
      else reportFailure(result);
    });
  }

  const changeMode = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    if (!isListenMode(next)) return;
    listenModeStore.set(next);
    requestedModeRef.current = next;
    // Without a frame the next start carries the mode.
    if (phase === 'idle' && !starting) return;
    // Before the frame's hello the bridge queues it behind a waiting start.
    sendHeld(setModePick, next, { type: 'console:vfo', mode: next });
  };

  // The sample rate restarts a running RX; an armed recording continues in a new segment, so ask first.
  const changeSampleRate = (hz: number) => {
    if (!Number.isInteger(hz) || hz <= 0 || hz === shownRate || radioPending !== null) return;
    const confirmRecording = running && live?.recording === true;
    if (confirmRecording && !window.confirm(t('spectrum.rateRecordingConfirm'))) return;
    setRadioPending(running ? 'restart' : 'set');
    setNotice(null);
    const command: BridgeCommand = confirmRecording ? { type: 'console:radio', sampleRateHz: hz, confirmRecording: true } : { type: 'console:radio', sampleRateHz: hz };
    sendHeld(setRatePick, hz, command, (result) => {
      setRadioPending(null);
      report(result);
    });
  };
  // Gains apply live, without a restart.
  const changeGain = (kind: GainKind, db: number) => {
    if (!Number.isFinite(db) || db === (kind === 'lna' ? shownLna : shownVga)) return;
    if (kind === 'lna') sendHeld(setLnaPick, db, { type: 'console:gains', lnaDb: db });
    else sendHeld(setVgaPick, db, { type: 'console:gains', vgaDb: db });
  };
  const changeAmp = (enabled: boolean) => {
    sendHeld(setAmpPick, enabled, { type: 'console:gains', amp: enabled });
  };

  // Click-to-tune sets the RX centre and the listen VFO and stops following the node. On a scan
  // it sets them for the next RX (the scan keeps running); RX cannot tune above TUNE_LIMITS.
  const tune = (hz: number) => {
    if (!Number.isFinite(hz)) return;
    if (!inTuneRange(hz)) {
      setNotice({ code: 'OUT_OF_RANGE' });
      return;
    }
    setFollowNode(false);
    if (phase === 'idle' && !starting) {
      // No frame yet: the next Mulai tunes here.
      setPendingHz(hz);
      return;
    }
    // Shown at once; while a start is on its way the tune waits in the bridge queue behind it.
    tuneToken.current += 1;
    const token = tuneToken.current;
    setLocalTune({ token, centerHz: hz, vfoHz: hz, awaitRev: null });
    void bridge.send({ type: 'console:tune', centerHz: hz, vfoHz: hz }).then((result) => {
      report(result);
      if (!mountedRef.current) return;
      if (result.ok) setPendingHz(null);
      // A refused tune snaps back to what the Receiver reports; an applied one is in the TuneView by now.
      const view = bridge.getState().tune;
      setLocalTune((current) => settleLocalTune(current, token, result, view));
    });
  };

  // A dock change of the dB scale is pending until the Receiver has it (App sends it).
  const setRxDb = (next: DbScale) => setDockSettings({ rxDb: next, rxDbPending: true });
  const chooseDbAuto = () => {
    if (!rxDb.auto) setRxDb({ ...rxDb, auto: true });
  };
  // Manual starts from the range drawn now, so the trace stays put.
  const chooseDbManual = () => {
    if (rxDb.auto) setRxDb(manualFromDrawn(canvasHandle.current?.currentRange() ?? null, rxDb));
  };

  // The scan: its range and settings as the Receiver reports them (a held pick first), or as it saved
  // them before the frame is mounted.
  const savedSweep = useMemo(() => (idle ? savedReceiverSweep() : null), [idle]);
  const liveSweep = live?.sweep ?? null;
  const sweepRange: SweepRange | null = heldValue(rangePick, bridgeState.status)
    ?? (liveSweep ? { startHz: liveSweep.startHz, stopHz: liveSweep.stopHz } : savedSweep ? { startHz: savedSweep.startHz, stopHz: savedSweep.stopHz } : null);
  const sweepFft = heldValue(fftPick, bridgeState.status) ?? liveSweep?.fftSize ?? savedSweep?.fftSize ?? null;
  const sweepLna = heldValue(sweepLnaPick, bridgeState.status) ?? (liveSweep ? liveSweep.lnaDb : savedSweep?.lnaDb ?? null);
  const sweepVga = heldValue(sweepVgaPick, bridgeState.status) ?? (liveSweep ? liveSweep.vgaDb : savedSweep?.vgaDb ?? null);
  const sweepAmp = heldValue(sweepAmpPick, bridgeState.status) ?? (liveSweep ? liveSweep.amp : savedSweep?.amp ?? null);
  // The scan's dB scale: Auto is the dock's own; Manual is the Receiver's Graph min./max., seeded from it.
  const sweepDisplay = heldValue(sweepDbPick, bridgeState.status)
    ?? (liveSweep ? { minDb: liveSweep.displayMinDb, maxDb: liveSweep.displayMaxDb } : savedSweep ? { minDb: savedSweep.displayMinDb, maxDb: savedSweep.displayMaxDb } : SWEEP_DISPLAY_DEFAULT);
  const sweepDb: DbScale = { auto: dockSettings.sweepAuto, minDb: sweepDisplay.minDb, maxDb: sweepDisplay.maxDb };
  // Switching to Manual sends nothing: the Receiver's own range applies until a limit is typed.
  const chooseSweepAuto = (auto: boolean) => { if (dockSettings.sweepAuto !== auto) setDockSettings({ sweepAuto: auto }); };
  const sendSweepDisplay = (range: { minDb: number; maxDb: number }) => {
    chooseSweepAuto(false);
    sendHeld(setSweepDbPick, range, { type: 'console:sweep-display', minDb: range.minDb, maxDb: range.maxDb });
  };
  const changeSweepRange = (range: SweepRange) => {
    sendHeld(setRangePick, range, { type: 'console:sweep-config', startHz: range.startHz, stopHz: range.stopHz });
  };
  const changeSweepFft = (fftSize: SweepFftSize) => {
    sendHeld(setFftPick, fftSize, { type: 'console:sweep-config', fftSize });
  };
  const changeSweepGain = (kind: GainKind, db: number) => {
    if (!Number.isFinite(db) || db === (kind === 'lna' ? sweepLna : sweepVga)) return;
    if (kind === 'lna') sendHeld(setSweepLnaPick, db, { type: 'console:sweep-config', lnaDb: db });
    else sendHeld(setSweepVgaPick, db, { type: 'console:sweep-config', vgaDb: db });
  };
  const changeSweepAmp = (enabled: boolean) => {
    sendHeld(setSweepAmpPick, enabled, { type: 'console:sweep-config', amp: enabled });
  };

  const shownDb = dockMode === 'sweep' ? sweepDb : rxDb;
  const manualMin = shownDb.auto ? null : shownDb.minDb;
  const manualMax = shownDb.auto ? null : shownDb.maxDb;
  const dbRange = useMemo(() => (manualMin === null || manualMax === null ? null : { min: manualMin, max: manualMax }), [manualMin, manualMax]);

  // "Kirim ke RDF-SDR": the RX centre and listen VFO as a Kontrol draft.
  const ranges = capabilities?.configPatch?.ranges ?? null;
  const rxCenterHz = shownCenter ?? target?.centerHz ?? null;
  const rxVfoHz = shownVfo ?? target?.vfoHz ?? rxCenterHz;
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
  const axisCenter = running ? shownCenter : pendingHz ?? shownCenter ?? target?.centerHz ?? saved?.centerHz ?? null;
  const fallbackView = spanAround(axisCenter, spanHz);
  const fallbackStart = fallbackView?.startHz;
  const fallbackStop = fallbackView?.stopHz;
  const stableFallback = useMemo(() => (fallbackStart === undefined || fallbackStop === undefined ? null : { startHz: fallbackStart, stopHz: fallbackStop }), [fallbackStart, fallbackStop]);
  const vfoHz = shownVfo ?? pendingHz ?? target?.vfoHz ?? saved?.vfoHz ?? null;
  const vfoBandwidth = live?.vfo?.bandwidthHz ?? 0;
  const vfoBand = useMemo(() => (vfoHz === null ? null : { frequencyHz: vfoHz, bandwidthHz: vfoBandwidth }), [vfoHz, vfoBandwidth]);
  const gainText = (value: number | null | undefined) => (typeof value === 'number' ? String(Number(value.toFixed(1))) : '—');
  const sweepStart = sweepRange?.startHz;
  const sweepStop = sweepRange?.stopHz;
  const sweepView = useMemo(() => (sweepStart === undefined || sweepStop === undefined ? null : { startHz: sweepStart, stopHz: sweepStop }), [sweepStart, sweepStop]);
  const info = dockMode === 'sweep'
    ? t('spectrum.infoSweep', {
      start: formatMhzTrim(sweepStart),
      stop: formatMhzTrim(sweepStop),
      rbw: sweepFft === null ? '—' : (SWEEP_SPAN_LIMITS.sampleRateHz / sweepFft / 1e3).toFixed(2),
      lna: gainText(sweepLna),
      vga: gainText(sweepVga),
    }) + (sweepAmp === true ? ` · ${t('spectrum.amp')}` : '')
    : t('spectrum.info', {
      center: formatMhz(axisCenter, 3),
      span: (spanHz / 1e6).toFixed(1),
      rate: formatMsps(shownRate),
      lna: gainText(shownLna),
      vga: gainText(shownVga),
    }) + (shownAmp === true ? ` · ${t('spectrum.amp')}` : '');

  const radio = radioRows({
    live,
    shown: { sampleRateHz: shownRate, lnaDb: shownLna, vgaDb: shownVga, amp: shownAmp },
    ratePending: radioPending !== null,
    starting,
  });
  const sweep = sweepRows({
    live,
    shown: { range: sweepRange, fftSize: sweepFft, lnaDb: sweepLna, vgaDb: sweepVga, amp: sweepAmp },
    saved: savedSweep,
    starting,
  });
  // "Pusatkan ke RX": the scan's span around the RX centre the dock shows.
  const centerSweep = sweepRange && sweepFft !== null && rxCenterHz !== null
    ? () => {
      const next = recentredRange(sweepRange, rxCenterHz, sweep.shiftHz, sweepFft);
      if (next) changeSweepRange(next);
      else setNotice({ code: 'OUT_OF_RANGE' });
    }
    : null;

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
  if (view.live && (messageText || followHint)) {
    lineNotice = (
      <>
        {messageText ? <span className={`ov-spec-message tone-${view.tone === 'good' ? 'warn' : view.tone}`}>{messageText}{frameText ? ` (${frameText})` : ''}</span> : null}
        {followHint ? <span className="ov-spec-message tone-neutral">{followHint}</span> : null}
        {frameNoticeLine}
        {view.openReceiver ? openReceiverButton : null}
      </>
    );
  } else if (!view.live && followHint && !view.message) {
    lineNotice = <><span className="ov-spec-message tone-neutral">{followHint}</span>{frameNoticeLine}</>;
  }
  const overlay = (
    <>
      <span>{messageText ?? t(dockMode === 'sweep' ? 'spectrum.sweepStopped' : 'spectrum.stopped')}{frameText ? ` (${frameText})` : ''}</span>
      {view.openReceiver ? openReceiverButton : null}
    </>
  );

  const mock = live?.mock === true || (mockRequested && !live?.connected);
  const shiftHz = live?.frequencyShiftHz ?? 0;
  // Only while the simulated scan starts or runs: the scan source stays 'simulated' until a radio that can scan connects.
  const simulatedScan = liveSweep?.source === 'simulated' && (scanPhase === 'starting' || scanPhase === 'active');
  const runStops = view.stoppable;
  const modeDisabled = view.controlsDisabled || starting || radioPending !== null || scanPhase === 'stopping';

  return (
    <section id="panel-spectrum" className={`ov-spectrum${settingsOpen ? ' is-settings-open' : ''}`} aria-labelledby="ov-spectrum-title" ref={sectionRef}>
      {/* [title][source or MOCK][tags][chip][mode switch][Penanda] … [follow, mode, Dengar] Kirim [Mulai, Receiver] Atur.
          The mode switch and the Penanda toggle take their place after the chip. Follow, mode and Kirim
          carry ov-spec-wide: on a narrow dock they are hidden here and shown in the Atur column. */}
      <div className="ov-dock-head ov-spec-head">
        <h2 id="ov-spectrum-title">{t('spectrum.title')}</h2>
        {mock
          ? <span className="ov-tag tone-warn">MOCK</span>
          : <span className="ov-spec-source">{t('spectrum.sourceHackrf')}</span>}
        {shiftHz !== 0 ? <span className="ov-tag tone-info" title={t('spectrum.upconverterTitle', { shift: formatMhz(shiftHz, 3) })}>UPCONVERTER</span> : null}
        {simulatedScan ? <span className="ov-tag tone-warn">SIM</span> : null}
        {live?.recording ? <span className="ov-tag tone-bad">REC</span> : null}
        <span className={`ov-chip tone-${view.tone}`}>{view.chip}</span>
        <div className="ov-seg ov-seg-compact ov-spec-mode" role="group" aria-label={t('spectrum.modeGroup')}>
          <button type="button" aria-pressed={dockMode === 'rx'} disabled={modeDisabled} onClick={() => chooseMode('rx')}>{t('spectrum.modeRx')}</button>
          <button type="button" aria-pressed={dockMode === 'sweep'} disabled={modeDisabled} onClick={() => chooseMode('sweep')}>{t('spectrum.modeSweep')}</button>
        </div>
        <span className="ov-spacer" />
        {/* Follow, mode and Dengar wrap as one group, as do Mulai/Berhenti and the Receiver link. */}
        <div className="ov-spec-group">
          <label className="ov-spec-follow ov-spec-wide">
            <input type="checkbox" checked={followNode} onChange={(event) => setFollowNode(event.target.checked)} />
            <span>{t('spectrum.follow')}</span>
          </label>
          <select className="ov-listen-mode ov-spec-wide" aria-label={t('spectrum.mode')} title={t('spectrum.mode')} value={shownMode} onChange={changeMode}>
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
        <button className="ov-button ov-spec-send ov-spec-wide" type="button" disabled={!sendable} title={sendTitle} onClick={sendDraft}>
          <Icon name="send" /><span>{t('spectrum.send')}</span>
        </button>
        <div className="ov-spec-group">
          <button
            className="ov-button ov-spec-run"
            type="button"
            disabled={view.controlsDisabled || scanPhase === 'stopping' || ((starting || radioPending === 'restart') && !runStops)}
            onClick={() => {
              if (dockMode === 'sweep') {
                if (runStops) stopScan();
                else startScan(false);
              } else if (runStops) stop();
              else start(false);
            }}
          >
            <Icon name={runStops ? 'stop' : 'play'} /><span>{runStops ? t('spectrum.stop') : t('spectrum.start')}</span>
          </button>
          <button className="ov-button ov-spec-open" type="button" aria-keyshortcuts={RECEIVER_KEY} aria-label={t('spectrum.openReceiver')} onClick={() => onNavigate('receiver')}>
            <Icon name="external" /><span className="ov-spec-open-label">{t('spectrum.openReceiver')}</span><kbd aria-hidden="true">{RECEIVER_KEY}</kbd>
          </button>
        </div>
        <button className="ov-button ov-spec-settings-toggle" type="button" aria-expanded={settingsOpen} aria-controls="spectrum-settings" onClick={() => setSettingsOpen(!settingsOpen)}>
          <Icon name="sliders" /><span>{t('spectrum.settings')}</span>
        </button>
      </div>
      <div className="ov-spec-main">
        <SpectrumCanvas
          bridge={bridge}
          mode={dockMode}
          live={view.live}
          fallbackView={dockMode === 'sweep' ? sweepView : stableFallback}
          centerHz={axisCenter}
          vfo={vfoBand}
          info={info}
          notice={lineNotice}
          overlay={overlay}
          tuneHz={vfoHz}
          onTune={tune}
          dbRange={dbRange}
          onAutoRange={settingsOpen && shownDb.auto ? onAutoRange : undefined}
          handle={canvasHandle}
        />
        {settingsOpen ? (
          <SpectrumSettings
            dockMode={dockMode}
            followNode={followNode}
            onFollowNode={setFollowNode}
            mode={shownMode}
            onModeChange={changeMode}
            sendable={sendable}
            sendTitle={sendTitle}
            onSend={sendDraft}
            db={shownDb}
            dbEditable={dockMode === 'rx' || live !== null}
            autoRange={autoRange}
            onDbAuto={dockMode === 'sweep' ? () => chooseSweepAuto(true) : chooseDbAuto}
            onDbManual={dockMode === 'sweep' ? () => chooseSweepAuto(false) : chooseDbManual}
            onDbRange={dockMode === 'sweep' ? sendSweepDisplay : (range) => setRxDb({ auto: false, ...range })}
            radio={radio}
            onSampleRate={changeSampleRate}
            onGain={changeGain}
            onAmp={changeAmp}
            sweep={sweep}
            onSweepRange={changeSweepRange}
            onSweepCenter={centerSweep}
            onSweepFft={changeSweepFft}
            onSweepGain={changeSweepGain}
            onSweepAmp={changeSweepAmp}
          />
        ) : null}
      </div>
    </section>
  );
}
