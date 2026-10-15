import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { connectMqtt, getBranding, getCapabilities, getConsoleConfig, getMqtt, getSnapshot, updateConsoleConfig } from './api';
import type { ConsoleCapabilities } from './api';
import type { Branding, CompassConfig, ConsoleConfig, GpsConfig, MqttSnapshot, MqttTarget, TelemetrySnapshot } from './types';
import { loadCompassConfig, loadGpsConfig, saveCompassConfig } from './lib/sourceConfigStorage';
import { DEFAULT_CONSOLE_CONFIG, deriveDataState } from './lib/telemetry';
import { refreshIntervalOptions } from './lib/configForm';
import { loadOverviewPanels, saveOverviewPanels } from './lib/overviewPanels';
import type { OverviewPanels } from './lib/overviewPanels';
import { nextControlDraftRequest } from './lib/controlDraft';
import type { ConfigPatchChanges, ControlDraftRequest } from './lib/controlDraft';
import { createReceiverBridge } from './lib/receiverBridge';
import type { ReceiverBridge } from './lib/receiverBridge';
import { OverviewPanelToggles } from './components/overview/OverviewPanelToggles';
import { I18nContext, initialLang, storeLang, translate, useI18n } from './lib/i18n';
import type { I18nValue, Lang } from './lib/i18n';
import { lazyWithRetry } from './lib/lazyRetry';
import { errorNotice, noticeText } from './lib/errorNotice';
import type { Notice } from './lib/errorNotice';
import { OverviewPage } from './pages/OverviewPage';
import type { OverviewDashboardProps } from './pages/OverviewPage';
import { ConsoleShell } from './components/Shell';
import type { RouteName } from './components/Shell';
import { useRoute } from './components/Shell';
import { LoadErrorBoundary } from './components/LoadErrorBoundary';
import { Page, PageHeader, PageNotice } from './components/page';
import { DEFAULT_SIMULATION, simulationSnapshot, randomizeSimulationSettings } from './lib/simulation';

// Overview is the landing route and stays in the entry chunk. The other pages
// load on first visit so the initial bundle only carries what the operator sees.
const ConfigurationPage = lazyWithRetry(() => import('./pages/ConfigurationPage'), (module) => module.ConfigurationPage);
const DoADiagnosticsPage = lazyWithRetry(() => import('./pages/DoADiagnosticsPage'), (module) => module.DoADiagnosticsPage);
const MessageMonitorPage = lazyWithRetry(() => import('./pages/MessageMonitorPage'), (module) => module.MessageMonitorPage);
const SystemHealthPage = lazyWithRetry(() => import('./pages/SystemHealthPage'), (module) => module.SystemHealthPage);
const SimulationPage = lazyWithRetry(() => import('./pages/SimulationPage'), (module) => module.SimulationPage);
const ReceiverPage = lazyWithRetry(() => import('./pages/ReceiverPage'), (module) => module.ReceiverPage);

function prefetchRoutes(): void {
  // A chunk already loaded keeps working after the console restarts or a
  // rebuild renames it. The map is part of Overview, so it is warmed as well.
  const warm = (load: () => Promise<unknown>) => { void load().catch(() => undefined); };
  warm(() => import('./pages/ConfigurationPage'));
  warm(() => import('./pages/DoADiagnosticsPage'));
  warm(() => import('./pages/MessageMonitorPage'));
  warm(() => import('./pages/SystemHealthPage'));
  warm(() => import('./pages/SimulationPage'));
  warm(() => import('./pages/ReceiverPage'));
  warm(() => import('./components/TacticalMap'));
}

const DEFAULT_BRANDING: Branding = { app_name: 'SDR-DoA Ground Console', logo_data_url: '' };
const DEFAULT_LOCAL_EXPIRY_MS = 5_000;
/** Backoff between attempts to read the local console configuration. */
export const CONFIG_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000];
/**
 * Read now and, after a failure, again with the capped configuration backoff
 * until a read succeeds. Returns a stop function that cancels the pending
 * retry and aborts a read in flight. /api/capabilities goes through this so a
 * single failed request does not drop the default-password warning (and the
 * server ranges) for the life of the page.
 */
export function readWithRetry<T>(read: (signal: AbortSignal) => Promise<T>, onValue: (value: T) => void, delays: readonly number[] = CONFIG_RETRY_DELAYS_MS): () => void {
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  const run = () => {
    timer = undefined;
    const current = new AbortController();
    controller = current;
    read(current.signal).then((value) => {
      if (!stopped) onValue(value);
    }).catch(() => {
      if (stopped) return;
      timer = setTimeout(run, delays[Math.min(attempt, delays.length - 1)]);
      attempt += 1;
    });
  };
  run();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    controller?.abort();
  };
}
/** Shortest pause between the end of one Data Out read and the next automatic one. */
const MIN_POLL_GAP_MS = 500;
/** A read in flight longer than this is shown as "Reading…". */
const SLOW_READ_MS = 1_000;
const MQTT_POLL_FOCUSED_MS = 2_000;
const MQTT_POLL_BACKGROUND_MS = 5_000;

type FreshnessRecord = Record<string, unknown>;

type RefreshOptions = {
  allowBeforeConfig?: boolean;
  /** Abort a read in flight and start a new one (the target changed). */
  replace?: boolean;
};

type InFlightRead = { controller: AbortController; promise: Promise<void> };

function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteNonNegative(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function asFreshnessRecord(value: unknown): FreshnessRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as FreshnessRecord : null;
}

function freshnessRemaining(value: unknown): number | undefined {
  const freshness = asFreshnessRecord(value);
  if (!freshness || !Object.prototype.hasOwnProperty.call(freshness, 'max_age_ms')) return undefined;
  // The collector marks the Ground/node clock as unknown when the renderer's
  // reference is intentionally unverified. That does not make a parsed DoA
  // record stale; candidate-local windows below still bound residence time.
  if (freshness.freshness_known === false) return undefined;
  if (freshness.fresh === false || (freshness.future_skew === true && freshness.fresh !== true)) return -1;
  const maxAge = finiteNonNegative(freshness.max_age_ms);
  const age = finiteNonNegative(freshness.age_ms);
  if (maxAge === null || age === null) return -1;
  return maxAge - age;
}

/**
 * Keep the last renderer evidence bounded by the time still left in the
 * collector's freshness window. The server age is already non-zero by the
 * time a response arrives, so the full max_age must never be restarted.
 */
export function localSnapshotFresh(
  snapshot: TelemetrySnapshot | null,
  receivedAtMonotonic: number | null,
  now = monotonicNow(),
): boolean {
  if (!snapshot || receivedAtMonotonic === null || !Number.isFinite(receivedAtMonotonic)) return false;
  const elapsed = now - receivedAtMonotonic;
  if (!Number.isFinite(elapsed) || elapsed < 0 || snapshot.status?.available !== true) return false;

  const freshnessValues: unknown[] = [snapshot.status?.freshness];
  for (const candidate of Object.values(snapshot.doa_candidates ?? {})) {
    freshnessValues.push(candidate?.freshness);
  }

  const remainingWindows: number[] = [];
  for (const freshness of freshnessValues) {
    const remaining = freshnessRemaining(freshness);
    if (remaining === undefined) continue;
    if (remaining < 0) return false;
    remainingWindows.push(remaining);
  }

  const expiry = remainingWindows.length ? Math.min(...remainingWindows) : DEFAULT_LOCAL_EXPIRY_MS;
  return elapsed <= expiry;
}

/**
 * Whether the screen may treat the last snapshot as current. It depends only
 * on the age of the data and on whether the last read failed, never on a read
 * being in flight, so a refresh does not blank the view while it waits.
 */
export function displayFresh(
  snapshot: TelemetrySnapshot | null,
  receivedAtMonotonic: number | null,
  readFailed: boolean,
  now = monotonicNow(),
): boolean {
  return !readFailed && localSnapshotFresh(snapshot, receivedAtMonotonic, now);
}

/**
 * A saved configuration that points at another Data Out node drops the
 * previous node's snapshot and read error, so neither stands for the new
 * target before its own read lands. Any other change keeps both.
 */
export function savedConfigChangesTarget(previous: ConsoleConfig, next: ConsoleConfig): boolean {
  return previous.base_url !== next.base_url;
}

/** Delay before the next automatic read: one interval after the last read started, never back to back. */
export function nextPollDelayMs(intervalMs: number, readElapsedMs: number): number {
  const elapsed = Number.isFinite(readElapsedMs) && readElapsedMs > 0 ? readElapsedMs : 0;
  return Math.max(intervalMs - elapsed, MIN_POLL_GAP_MS);
}

function isAbortError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'name' in error) {
    return String((error as { name?: unknown }).name) === 'AbortError';
  }
  return false;
}

const routeLoading = <div className="route-loading" role="status" aria-live="polite"><span aria-hidden="true" /></div>;

function ConfigUnavailable({ error }: { error: string | null }): ReactElement {
  const { t } = useI18n();
  if (error === null) return routeLoading;
  return (
    <Page>
      <PageHeader title={t('route.configuration')} />
      <PageNotice tone="warn" title={t('app.configUnavailableTitle')}>{t('app.configUnavailableDetail', { error })}</PageNotice>
    </Page>
  );
}

function PageForRoute({
  route,
  snapshot,
  localFresh,
  mqtt,
  mqttError,
  config,
  configLoaded,
  configError,
  branding,
  gpsConfig,
  compassConfig,
  onGpsConfigChanged,
  onCompassConfigChanged,
  onConfigSaved,
  onBrandingChanged,
  onMqttChanged,
  onRefreshMqtt,
  onReconnectMqtt,
  overview,
}: {
  route: RouteName;
  snapshot: TelemetrySnapshot | null;
  localFresh: boolean;
  mqtt: MqttSnapshot | null;
  mqttError: string | null;
  config: ConsoleConfig;
  configLoaded: boolean;
  configError: string | null;
  branding: Branding;
  gpsConfig: GpsConfig;
  compassConfig: CompassConfig;
  onGpsConfigChanged: (next: GpsConfig) => void;
  onCompassConfigChanged: (next: CompassConfig) => void;
  onConfigSaved: (next: ConsoleConfig) => Promise<void>;
  onBrandingChanged: (next: Branding) => void;
  onMqttChanged: (next: MqttSnapshot) => void;
  onRefreshMqtt: () => Promise<void>;
  onReconnectMqtt: (target: MqttTarget) => Promise<void>;
  /** Dashboard wiring for Overview; every value is stable across the 500 ms freshness tick. */
  overview: OverviewDashboardProps;
}): ReactElement {
  switch (route) {
    case 'system-health': return <SystemHealthPage snapshot={snapshot} mqtt={mqtt} mqttError={mqttError} localSnapshotFresh={localFresh} capabilities={overview.capabilities} />;
    case 'doa-diagnostics': return <DoADiagnosticsPage snapshot={snapshot} localSnapshotFresh={localFresh} />;
    // Until the real configuration has been read, the form would offer the
    // built-in defaults for saving over it.
    case 'configuration': return configLoaded
      ? <ConfigurationPage config={config} branding={branding} gpsConfig={gpsConfig} compassConfig={compassConfig} onGpsConfigChanged={onGpsConfigChanged} onCompassConfigChanged={onCompassConfigChanged} onConfigSaved={onConfigSaved} onBrandingChanged={onBrandingChanged} />
      : <ConfigUnavailable error={configError} />;
    case 'message-monitor': return <MessageMonitorPage mqtt={mqtt} mqttError={mqttError} config={config} onMqttChanged={onMqttChanged} onRefreshMqtt={onRefreshMqtt} onReconnectMqtt={onReconnectMqtt} capabilities={overview.capabilities} />;
    case 'overview':
    default: return <OverviewPage snapshot={snapshot} localSnapshotFresh={localFresh} gpsConfig={gpsConfig} compassConfig={compassConfig} {...overview} />;
  }
}

export default function App(): ReactElement {
  const [route, navigate] = useRoute();
  const [config, setConfig] = useState<ConsoleConfig>(DEFAULT_CONSOLE_CONFIG);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configError, setConfigError] = useState<Notice | null>(null);
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [mqtt, setMqtt] = useState<MqttSnapshot | null>(null);
  const [mqttError, setMqttError] = useState<Notice | null>(null);
  const [readStartedAt, setReadStartedAt] = useState<number | null>(null);
  // Errors are kept as keys or received text and translated at render time.
  const [readError, setReadError] = useState<Notice | null>(null);
  const [receivedAtMonotonic, setReceivedAtMonotonic] = useState<number | null>(null);
  const [expiryTick, setExpiryTick] = useState(0);
  const [gpsConfig, setGpsConfig] = useState<GpsConfig>(loadGpsConfig);
  const [compassConfig, setCompassConfig] = useState<CompassConfig>(loadCompassConfig);
  const [lang, setLangState] = useState<Lang>(initialLang);
  const i18n = useMemo<I18nValue>(() => ({
    lang,
    setLang: (next) => { setLangState(next); storeLang(next); },
    t: (key, vars) => translate(lang, key, vars),
  }), [lang]);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const [simulationEnabled, setSimulationEnabled] = useState(false);
  const [simulationAutomatic, setSimulationAutomatic] = useState(false);
  const [simulationSettings, setSimulationSettings] = useState(DEFAULT_SIMULATION);
  const syntheticSnapshot = useMemo(() => simulationSnapshot(simulationSettings), [simulationSettings]);
  const randomizeSimulation = useCallback(() => {
    setSimulationSettings(randomizeSimulationSettings);
  }, []);
  // Server capabilities (refresh intervals, admin, config patch); null until read.
  const [capabilities, setCapabilities] = useState<ConsoleCapabilities | null>(null);
  // Interval chosen in the top bar while its save is in flight, and the last save error.
  const [refreshPending, setRefreshPending] = useState<number | null>(null);
  const [refreshSaveError, setRefreshSaveError] = useState<Notice | null>(null);
  const refreshSaveController = useRef<AbortController | null>(null);
  // Overview dashboard panels, a per-browser preference.
  const [overviewPanels, setOverviewPanels] = useState<OverviewPanels>(() => loadOverviewPanels());
  useEffect(() => { saveOverviewPanels(overviewPanels); }, [overviewPanels]);
  // A draft handed from the spectrum dock to Kontrol; it is never sent from here.
  const [controlDraftRequest, setControlDraftRequest] = useState<ControlDraftRequest | null>(null);
  const onControlDraftRequest = useCallback((changes: ConfigPatchChanges): void => {
    setControlDraftRequest((previous) => nextControlDraftRequest(previous, changes));
  }, []);
  const onCompassConfigChanged = useCallback((next: CompassConfig): void => {
    setCompassConfig(next);
    saveCompassConfig(next);
  }, []);
  // The Receiver frame stays mounted after its first visit so RX, scans and
  // recordings keep running while the operator uses other pages. It also
  // mounts, once, when the Overview spectrum dock asks for it (Mulai/Dengar);
  // it never mounts at console load, because mounting claims the HackRF.
  const [receiverRequested, setReceiverRequested] = useState(false);
  const requestReceiver = useCallback((): void => { setReceiverRequested(true); }, []);
  // One bridge to the Receiver frame for the life of the console page; the
  // Receiver page attaches the frame, the Overview dock drives it.
  const receiverBridgeRef = useRef<ReceiverBridge | null>(null);
  if (receiverBridgeRef.current === null) receiverBridgeRef.current = createReceiverBridge();
  const receiverBridge = receiverBridgeRef.current;
  const [receiverMounted, setReceiverMounted] = useState(route === 'receiver');
  if ((route === 'receiver' || receiverRequested) && !receiverMounted) setReceiverMounted(true);
  useEffect(() => {
    // Warm the page chunks once the landing view has painted.
    const timer = window.setTimeout(prefetchRoutes, 1200);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    document.title = branding.app_name;
  }, [branding.app_name]);
  useEffect(() => {
    if (!simulationEnabled || !simulationAutomatic) return;
    const timer = window.setInterval(randomizeSimulation, 1000);
    return () => window.clearInterval(timer);
  }, [simulationEnabled, simulationAutomatic, randomizeSimulation]);

  const mountedRef = useRef(false);
  const configRef = useRef<ConsoleConfig>(config);
  const configReadyRef = useRef(false);
  const configSequence = useRef(0);
  const configController = useRef<AbortController | null>(null);
  const brandingController = useRef<AbortController | null>(null);
  const refreshSequence = useRef(0);
  const mqttSequence = useRef(0);
  const readInFlight = useRef<InFlightRead | null>(null);
  const mqttController = useRef<AbortController | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const receiverRef = useRef<HTMLElement | null>(null);

  // Keep the default argument of refresh independent of render closures while
  // still making a newly verified config available immediately to a callback.
  configRef.current = config;

  const refreshMqtt = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) return;
    const sequence = ++mqttSequence.current;
    mqttController.current?.abort();
    const controller = new AbortController();
    mqttController.current = controller;

    try {
      const next = await getMqtt(controller.signal);
      if (!mountedRef.current || sequence !== mqttSequence.current) return;
      setMqtt(next);
      setMqttError(null);
    } catch (error: unknown) {
      if (!mountedRef.current || sequence !== mqttSequence.current || isAbortError(error)) return;
      // Never leave a previously healthy snapshot looking current after a
      // failed monitor read. The shell and the Message Monitor show ERROR
      // with this error.
      setMqtt(null);
      setMqttError(errorNotice(error, 'monitor.readFailed'));
      throw error;
    } finally {
      if (mqttController.current === controller) mqttController.current = null;
    }
  }, []);

  const reconnectMqtt = useCallback(async (target: MqttTarget): Promise<void> => {
    if (!mountedRef.current) return;
    const sequence = ++mqttSequence.current;
    mqttController.current?.abort();
    const controller = new AbortController();
    mqttController.current = controller;
    setMqtt(null);

    try {
      const next = await connectMqtt(target, controller.signal);
      if (!mountedRef.current || sequence !== mqttSequence.current) return;
      setMqtt(next);
      setMqttError(null);
    } catch (error: unknown) {
      if (!mountedRef.current || sequence !== mqttSequence.current || isAbortError(error)) return;
      setMqtt(null);
      setMqttError(errorNotice(error, 'monitor.connectFailed'));
      throw error;
    } finally {
      if (mqttController.current === controller) mqttController.current = null;
    }
  }, []);

  const applyMqtt = useCallback((next: MqttSnapshot): void => {
    if (!mountedRef.current) return;
    ++mqttSequence.current;
    mqttController.current?.abort();
    mqttController.current = null;
    setMqtt(next);
    setMqttError(null);
  }, []);

  /**
   * Read one Data Out snapshot. A read already in flight is shared instead of
   * aborted, so a slow node still gets its answer on screen (the server bounds
   * each collection to a few seconds). Only a changed target replaces it.
   */
  const refresh = useCallback((baseUrl?: string, options: RefreshOptions = {}): Promise<void> => {
    if (!mountedRef.current) return Promise.resolve();
    if (!configReadyRef.current && options.allowBeforeConfig !== true) {
      setReadError({ key: 'app.readError.configNotLoaded' });
      return Promise.resolve();
    }

    const targetBaseUrl = baseUrl ?? configRef.current.base_url;
    if (!targetBaseUrl) {
      setReadError({ key: 'app.readError.noBaseUrl' });
      return Promise.resolve();
    }

    const current = readInFlight.current;
    if (current && options.replace !== true) return current.promise;
    current?.controller.abort();

    const sequence = ++refreshSequence.current;
    const controller = new AbortController();
    setReadStartedAt(monotonicNow());

    const promise = (async () => {
      try {
        const next = await getSnapshot(targetBaseUrl, controller.signal);
        if (!mountedRef.current || sequence !== refreshSequence.current) return;
        setSnapshot(next);
        setReceivedAtMonotonic(monotonicNow());
        setReadError(null);
      } catch (error: unknown) {
        if (!mountedRef.current || sequence !== refreshSequence.current || isAbortError(error)) return;
        // Keep the previous evidence in place, but the display freshness stays
        // false while this error is shown so old data cannot look live. The
        // error stays until a read succeeds.
        setReadError(errorNotice(error, 'app.readError.snapshotFailed'));
      } finally {
        if (readInFlight.current?.controller === controller) {
          readInFlight.current = null;
          if (mountedRef.current) setReadStartedAt(null);
        }
      }
    })();
    readInFlight.current = { controller, promise };
    return promise;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let retryTimer: number | undefined;
    let attempt = 0;
    const initialBrandingController = new AbortController();
    brandingController.current = initialBrandingController;

    getBranding(initialBrandingController.signal).then((next) => {
      if (mountedRef.current) setBranding(next);
    }).catch((error: unknown) => {
      if (!mountedRef.current || isAbortError(error)) return;
      // The default branding is safe and remains visible when the local
      // branding endpoint is unavailable.
    });

    const loadConfig = () => {
      retryTimer = undefined;
      if (!mountedRef.current || configReadyRef.current) return;
      const sequence = ++configSequence.current;
      const controller = new AbortController();
      configController.current = controller;
      getConsoleConfig(controller.signal).then((next) => {
        if (!mountedRef.current || sequence !== configSequence.current) return;
        configRef.current = next;
        configReadyRef.current = true;
        setConfig(next);
        setConfigLoaded(true);
        setConfigError(null);
        setReadError(null);
        // MQTT state is polled on its own timer; read it once right away.
        void refreshMqtt().catch(() => undefined);
        void refresh(next.base_url);
      }).catch((error: unknown) => {
        if (!mountedRef.current || sequence !== configSequence.current || isAbortError(error)) return;
        configReadyRef.current = false;
        // Do not substitute DEFAULT_CONSOLE_CONFIG.base_url here. A failed local
        // config read must never trigger an unverified remote Data Out request.
        setConfigError(errorNotice(error, 'common.requestFailed'));
        setReadError({ key: 'app.readError.configNotLoaded' });
        const delayMs = CONFIG_RETRY_DELAYS_MS[Math.min(attempt, CONFIG_RETRY_DELAYS_MS.length - 1)];
        attempt += 1;
        retryTimer = window.setTimeout(loadConfig, delayMs);
      }).finally(() => {
        if (configController.current === controller) configController.current = null;
      });
    };
    loadConfig();

    return () => {
      mountedRef.current = false;
      window.clearTimeout(retryTimer);
      ++configSequence.current;
      ++refreshSequence.current;
      ++mqttSequence.current;
      configController.current?.abort();
      brandingController.current?.abort();
      readInFlight.current?.controller.abort();
      mqttController.current?.abort();
      configController.current = null;
      brandingController.current = null;
      readInFlight.current = null;
      mqttController.current = null;
    };
  }, [refresh, refreshMqtt]);

  useEffect(() => {
    const timer = window.setInterval(() => setExpiryTick((value) => value + 1), 500);
    return () => window.clearInterval(timer);
  }, []);

  // Automatic Data Out reads: the next one is scheduled when the previous one
  // has finished, so requests never pile up or abort each other.
  useEffect(() => {
    if (!configLoaded || !Number.isFinite(config.refresh_seconds) || config.refresh_seconds <= 0) return undefined;
    const intervalMs = config.refresh_seconds * 1000;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      const started = monotonicNow();
      await refresh();
      if (stopped) return;
      timer = window.setTimeout(() => { void tick(); }, nextPollDelayMs(intervalMs, monotonicNow() - started));
    };
    timer = window.setTimeout(() => { void tick(); }, intervalMs);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [configLoaded, config.refresh_seconds, refresh]);

  // MQTT monitor state has its own poll, faster on the pages that show it.
  const mqttFocused = route === 'message-monitor' || route === 'system-health';
  useEffect(() => {
    if (!configLoaded) return undefined;
    const poll = () => {
      if (mqttController.current) return;
      void refreshMqtt().catch(() => undefined);
    };
    if (mqttFocused) poll();
    const timer = window.setInterval(poll, mqttFocused ? MQTT_POLL_FOCUSED_MS : MQTT_POLL_BACKGROUND_MS);
    return () => window.clearInterval(timer);
  }, [configLoaded, mqttFocused, refreshMqtt]);

  useLayoutEffect(() => {
    const content = route === 'receiver' ? receiverRef.current : contentRef.current;
    if (!content) return undefined;

    // Lazy routes render their heading after the chunk arrives, so wait for the
    // focus target instead of assuming it exists in this layout pass.
    const focusTarget = (): boolean => {
      const routeTarget = content.querySelector<HTMLElement>('h1:not(.visually-hidden), [data-route-focus]');
      if (!routeTarget) return false;
      if (routeTarget.tagName === 'H1') routeTarget.tabIndex = -1;
      try {
        routeTarget.focus({ preventScroll: true });
      } catch {
        routeTarget.focus();
      }
      return true;
    };
    if (focusTarget() || typeof MutationObserver !== 'function') return undefined;
    const focusedBefore = document.activeElement;
    const observer = new MutationObserver(() => {
      // Never pull focus back if the operator already moved it while loading.
      if (document.activeElement !== focusedBefore || focusTarget()) observer.disconnect();
    });
    observer.observe(content, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [route]);

  const onConfigSaved = useCallback(async (next: ConsoleConfig): Promise<void> => {
    if (!mountedRef.current) return;
    const targetChanged = savedConfigChangesTarget(configRef.current, next);
    ++configSequence.current;
    configController.current?.abort();
    configController.current = null;
    configRef.current = next;
    configReadyRef.current = true;
    setConfig(next);
    setConfigLoaded(true);
    setConfigError(null);
    // A verified save (here or in Configuration) supersedes a failed interval save.
    setRefreshSaveError(null);
    if (targetChanged) {
      setSnapshot(null);
      setReceivedAtMonotonic(null);
      setReadError(null);
    }
    // A config save can replace the local subscriber. Read its state under the
    // same guard before the snapshot request is allowed to update the shell.
    void refreshMqtt().catch(() => undefined);
    await refresh(next.base_url, { allowBeforeConfig: true, replace: true });
  }, [refresh, refreshMqtt]);

  const onBrandingChanged = useCallback((next: Branding): void => {
    if (mountedRef.current) setBranding(next);
  }, []);

  // Capabilities are read once the configuration is known, and retried until
  // they arrive. Until then the built-in interval list applies and Kontrol has
  // no server ranges or default-password flag.
  useEffect(() => {
    if (!configLoaded) return undefined;
    return readWithRetry(getCapabilities, (next) => {
      if (mountedRef.current) setCapabilities(next);
    });
  }, [configLoaded]);

  // The top-bar interval select saves through the same verified path as the
  // Configuration form. The chosen interval shows while the save is in flight;
  // a failed save leaves the previous interval in place and marks the select.
  useEffect(() => () => refreshSaveController.current?.abort(), []);
  const onRefreshSecondsChange = useCallback((seconds: number): void => {
    if (!configReadyRef.current || seconds === configRef.current.refresh_seconds) return;
    refreshSaveController.current?.abort();
    const controller = new AbortController();
    refreshSaveController.current = controller;
    setRefreshPending(seconds);
    setRefreshSaveError(null);
    updateConsoleConfig({ ...configRef.current, refresh_seconds: seconds }, controller.signal)
      .then((next) => {
        // The follow-up Data Out read runs on its own; the select need not wait for it.
        if (!controller.signal.aborted) void onConfigSaved(next);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error) || !mountedRef.current) return;
        // Not a Data Out read failure: it stays on the select, not in the read banner.
        setRefreshSaveError(errorNotice(error, 'common.requestFailed'));
      })
      .finally(() => {
        if (refreshSaveController.current !== controller) return;
        refreshSaveController.current = null;
        if (mountedRef.current) setRefreshPending(null);
      });
  }, [onConfigSaved]);

  // Kontrol's "Cek ulang": read Data Out now, sharing a read already in flight.
  const refreshSnapshot = useCallback((): void => { void refresh(); }, [refresh]);
  const overviewWiring = useMemo<OverviewDashboardProps>(() => ({
    panels: overviewPanels,
    onPanelsChange: setOverviewPanels,
    onCompassConfigChanged,
    onRequestReceiver: requestReceiver,
    onNavigate: navigate,
    capabilities,
    controlDraftRequest,
    onControlDraftRequest,
    receiverBridge,
    onRefreshSnapshot: refreshSnapshot,
  }), [overviewPanels, onCompassConfigChanged, requestReceiver, navigate, capabilities, controlDraftRequest, onControlDraftRequest, receiverBridge, refreshSnapshot]);
  const refreshOptions = useMemo(() => refreshIntervalOptions(capabilities?.refreshIntervalsS ?? null, config.refresh_seconds), [capabilities, config.refresh_seconds]);

  const onRefresh = useCallback((): void => {
    void refresh();
    void refreshMqtt().catch(() => undefined);
  }, [refresh, refreshMqtt]);

  const readErrorText = readError ? noticeText(i18n.t, readError) : null;
  const mqttErrorText = mqttError ? noticeText(i18n.t, mqttError) : null;
  const configErrorText = configError ? noticeText(i18n.t, configError) : null;
  const refreshSaveErrorText = refreshSaveError ? noticeText(i18n.t, refreshSaveError) : null;
  const now = monotonicNow();
  const currentLocalFresh = expiryTick >= 0 && displayFresh(snapshot, receivedAtMonotonic, readError !== null, now);
  const lastReadAgeMs = receivedAtMonotonic === null ? null : Math.max(0, now - receivedAtMonotonic);
  // A quick poll is not announced; the first read and slow reads are.
  const readingVisible = readStartedAt !== null && (snapshot === null || now - readStartedAt >= SLOW_READ_MS);

  return (
    <I18nContext.Provider value={i18n}>
      <ConsoleShell
        route={route}
        onNavigate={navigate}
        branding={branding}
        snapshot={snapshot}
        localSnapshotFresh={currentLocalFresh}
        loading={readingVisible}
        readError={readErrorText}
        lastReadAgeMs={lastReadAgeMs}
        mqttConnection={mqtt?.connection}
        mqttError={mqttErrorText}
        simulationEnabled={simulationEnabled}
        onRefresh={onRefresh}
        refreshSeconds={configLoaded ? refreshPending ?? config.refresh_seconds : undefined}
        refreshOptions={refreshOptions}
        refreshDisabled={!configLoaded || refreshPending !== null}
        refreshError={refreshSaveErrorText}
        onRefreshSecondsChange={onRefreshSecondsChange}
        toolbar={route === 'overview' ? <OverviewPanelToggles panels={overviewPanels} onChange={setOverviewPanels} /> : undefined}
      >
        {route !== 'receiver' ? (
          <section ref={contentRef} className="route-content" key={route}>
            <LoadErrorBoundary>
              <Suspense fallback={routeLoading}>
                {route === 'simulation' ? <SimulationPage enabled={simulationEnabled} automatic={simulationAutomatic} settings={simulationSettings} onEnabled={enabled => { setSimulationEnabled(enabled); if (!enabled) setSimulationAutomatic(false); }} onAutomatic={setSimulationAutomatic} onSettings={setSimulationSettings} onRandomize={randomizeSimulation} onOverview={() => navigate('overview')} />
                  : route === 'overview' && simulationEnabled ? <OverviewPage snapshot={syntheticSnapshot} localSnapshotFresh={true} gpsConfig={gpsConfig} compassConfig={compassConfig} simulation={simulationSettings} {...overviewWiring} />
                  : <PageForRoute route={route} snapshot={snapshot} localFresh={currentLocalFresh} mqtt={mqtt} mqttError={mqttErrorText} config={config} configLoaded={configLoaded} configError={configErrorText} branding={branding} gpsConfig={gpsConfig} compassConfig={compassConfig} onGpsConfigChanged={setGpsConfig} onCompassConfigChanged={onCompassConfigChanged} onConfigSaved={onConfigSaved} onBrandingChanged={onBrandingChanged} onMqttChanged={applyMqtt} onRefreshMqtt={refreshMqtt} onReconnectMqtt={reconnectMqtt} overview={overviewWiring} />}
              </Suspense>
            </LoadErrorBoundary>
          </section>
        ) : null}
        {receiverMounted ? (
          // Inline display:none because the Overview layout gives every
          // .route-content a display value that would override `hidden`.
          <section ref={receiverRef} className="route-content" hidden={route !== 'receiver'} style={route === 'receiver' ? undefined : { display: 'none' }}>
            <LoadErrorBoundary>
              <Suspense fallback={routeLoading}>
                <ReceiverPage bridge={receiverBridge} visible={route === 'receiver'} />
              </Suspense>
            </LoadErrorBoundary>
          </section>
        ) : null}
      </ConsoleShell>
    </I18nContext.Provider>
  );
}

export { deriveDataState };
