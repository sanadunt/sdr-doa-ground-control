import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { connectMqtt, getBranding, getConsoleConfig, getMqtt, getSnapshot } from './api';
import type { Branding, CompassConfig, ConsoleConfig, GpsConfig, MqttSnapshot, TelemetrySnapshot } from './types';
import { DEFAULT_COMPASS_CONFIG } from './lib/polar';
import { DEFAULT_GPS_CONFIG } from './lib/map';
import { DEFAULT_CONSOLE_CONFIG, deriveDataState } from './lib/telemetry';
import { I18nContext, initialLang, storeLang, translate, useI18n } from './lib/i18n';
import type { I18nValue, Lang } from './lib/i18n';
import { lazyWithRetry } from './lib/lazyRetry';
import { OverviewPage } from './pages/OverviewPage';
import { ConsoleShell } from './components/Shell';
import type { RouteName } from './components/Shell';
import { useRoute } from './components/Shell';
import { LoadErrorBoundary } from './components/LoadErrorBoundary';
import { EmptyState } from './components/ui';
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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const routeLoading = <div className="route-loading" role="status" aria-live="polite"><span aria-hidden="true" /></div>;

function ConfigUnavailable({ error }: { error: string | null }): ReactElement {
  const { t } = useI18n();
  if (error === null) return routeLoading;
  return (
    <div className="page">
      <h1 className="visually-hidden" data-route-focus tabIndex={-1}>{t('route.configuration')}</h1>
      <EmptyState label={t('app.configUnavailableTitle')} detail={t('app.configUnavailableDetail', { error })} tone="warn" />
    </div>
  );
}

function PageForRoute({
  route,
  snapshot,
  localFresh,
  mqtt,
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
}: {
  route: RouteName;
  snapshot: TelemetrySnapshot | null;
  localFresh: boolean;
  mqtt: MqttSnapshot | null;
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
  onReconnectMqtt: (host: string, port: number) => Promise<void>;
}): ReactElement {
  switch (route) {
    case 'system-health': return <SystemHealthPage snapshot={snapshot} mqtt={mqtt} localSnapshotFresh={localFresh} />;
    case 'doa-diagnostics': return <DoADiagnosticsPage snapshot={snapshot} localSnapshotFresh={localFresh} />;
    // Until the real configuration has been read, the form would offer the
    // built-in defaults for saving over it.
    case 'configuration': return configLoaded
      ? <ConfigurationPage config={config} branding={branding} gpsConfig={gpsConfig} compassConfig={compassConfig} onGpsConfigChanged={onGpsConfigChanged} onCompassConfigChanged={onCompassConfigChanged} onConfigSaved={onConfigSaved} onBrandingChanged={onBrandingChanged} />
      : <ConfigUnavailable error={configError} />;
    case 'message-monitor': return <MessageMonitorPage mqtt={mqtt} config={config} onMqttChanged={onMqttChanged} onRefreshMqtt={onRefreshMqtt} onReconnectMqtt={onReconnectMqtt} />;
    case 'overview':
    default: return <OverviewPage snapshot={snapshot} localSnapshotFresh={localFresh} gpsConfig={gpsConfig} compassConfig={compassConfig} />;
  }
}

export default function App(): ReactElement {
  const [route, navigate] = useRoute();
  const [config, setConfig] = useState<ConsoleConfig>(DEFAULT_CONSOLE_CONFIG);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [mqtt, setMqtt] = useState<MqttSnapshot | null>(null);
  const [mqttError, setMqttError] = useState<string | null>(null);
  const [readStartedAt, setReadStartedAt] = useState<number | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [receivedAtMonotonic, setReceivedAtMonotonic] = useState<number | null>(null);
  const [expiryTick, setExpiryTick] = useState(0);
  const [gpsConfig, setGpsConfig] = useState<GpsConfig>(DEFAULT_GPS_CONFIG);
  const [compassConfig, setCompassConfig] = useState<CompassConfig>(DEFAULT_COMPASS_CONFIG);
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
  // The Receiver frame stays mounted after its first visit so RX, scans and
  // recordings keep running while the operator uses other pages.
  const [receiverMounted, setReceiverMounted] = useState(route === 'receiver');
  if (route === 'receiver' && !receiverMounted) setReceiverMounted(true);
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
      // failed monitor read. The initiating page surfaces the error text; the
      // shell shows ERROR.
      setMqtt(null);
      setMqttError(errorMessage(error, 'MQTT state read failed.'));
      throw error;
    } finally {
      if (mqttController.current === controller) mqttController.current = null;
    }
  }, []);

  const reconnectMqtt = useCallback(async (host: string, port: number): Promise<void> => {
    if (!mountedRef.current) return;
    const sequence = ++mqttSequence.current;
    mqttController.current?.abort();
    const controller = new AbortController();
    mqttController.current = controller;
    setMqtt(null);

    try {
      const next = await connectMqtt(host, port, controller.signal);
      if (!mountedRef.current || sequence !== mqttSequence.current) return;
      setMqtt(next);
      setMqttError(null);
    } catch (error: unknown) {
      if (!mountedRef.current || sequence !== mqttSequence.current || isAbortError(error)) return;
      setMqtt(null);
      setMqttError(errorMessage(error, 'MQTT reconnect failed.'));
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
      setReadError('Local console configuration unavailable; Data Out read was not attempted.');
      return Promise.resolve();
    }

    const targetBaseUrl = baseUrl ?? configRef.current.base_url;
    if (!targetBaseUrl) {
      setReadError('No Data Out base URL is configured.');
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
        setReadError(errorMessage(error, 'Data Out snapshot failed.'));
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
        setConfigError(errorMessage(error, 'console config read failed'));
        setReadError('Local console configuration unavailable; Data Out read was not attempted.');
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
    ++configSequence.current;
    configController.current?.abort();
    configController.current = null;
    configRef.current = next;
    configReadyRef.current = true;
    setConfig(next);
    setConfigLoaded(true);
    setConfigError(null);
    setReadError(null);
    // A config save can replace the local subscriber. Read its state under the
    // same guard before the snapshot request is allowed to update the shell.
    void refreshMqtt().catch(() => undefined);
    await refresh(next.base_url, { allowBeforeConfig: true, replace: true });
  }, [refresh, refreshMqtt]);

  const onBrandingChanged = useCallback((next: Branding): void => {
    if (mountedRef.current) setBranding(next);
  }, []);

  const onRefresh = useCallback((): void => {
    void refresh();
    void refreshMqtt().catch(() => undefined);
  }, [refresh, refreshMqtt]);

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
        readError={readError}
        lastReadAgeMs={lastReadAgeMs}
        mqttConnection={mqtt?.connection}
        mqttError={mqttError}
        simulationEnabled={simulationEnabled}
        onRefresh={onRefresh}
      >
        {route !== 'receiver' ? (
          <section ref={contentRef} className="route-content" key={route}>
            <LoadErrorBoundary>
              <Suspense fallback={routeLoading}>
                {route === 'simulation' ? <SimulationPage enabled={simulationEnabled} automatic={simulationAutomatic} settings={simulationSettings} onEnabled={enabled => { setSimulationEnabled(enabled); if (!enabled) setSimulationAutomatic(false); }} onAutomatic={setSimulationAutomatic} onSettings={setSimulationSettings} onRandomize={randomizeSimulation} onOverview={() => navigate('overview')} />
                  : route === 'overview' && simulationEnabled ? <OverviewPage snapshot={syntheticSnapshot} localSnapshotFresh={true} gpsConfig={gpsConfig} compassConfig={compassConfig} simulation={simulationSettings} />
                  : <PageForRoute route={route} snapshot={snapshot} localFresh={currentLocalFresh} mqtt={mqtt} config={config} configLoaded={configLoaded} configError={configError} branding={branding} gpsConfig={gpsConfig} compassConfig={compassConfig} onGpsConfigChanged={setGpsConfig} onCompassConfigChanged={setCompassConfig} onConfigSaved={onConfigSaved} onBrandingChanged={onBrandingChanged} onMqttChanged={applyMqtt} onRefreshMqtt={refreshMqtt} onReconnectMqtt={reconnectMqtt} />}
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
                <ReceiverPage />
              </Suspense>
            </LoadErrorBoundary>
          </section>
        ) : null}
      </ConsoleShell>
    </I18nContext.Provider>
  );
}

export { deriveDataState };
