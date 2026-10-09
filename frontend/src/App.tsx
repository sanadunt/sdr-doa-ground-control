import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { connectMqtt, getBranding, getConsoleConfig, getMqtt, getSnapshot } from './api';
import type { Branding, CompassConfig, ConsoleConfig, GpsConfig, MqttSnapshot, TelemetrySnapshot } from './types';
import { DEFAULT_COMPASS_CONFIG } from './lib/polar';
import { DEFAULT_GPS_CONFIG } from './lib/map';
import { DEFAULT_CONSOLE_CONFIG, deriveDataState } from './lib/telemetry';
import { I18nContext, initialLang, storeLang, translate } from './lib/i18n';
import type { I18nValue, Lang } from './lib/i18n';
import { OverviewPage } from './pages/OverviewPage';
import { ConsoleShell } from './components/Shell';
import type { RouteName } from './components/Shell';
import { useRoute } from './components/Shell';
import { DEFAULT_SIMULATION, simulationSnapshot, randomizeSimulationSettings } from './lib/simulation';

// Overview is the landing route and stays in the entry chunk. The other pages
// load on first visit so the initial bundle only carries what the operator sees.
const ConfigurationPage = lazy(() => import('./pages/ConfigurationPage').then((module) => ({ default: module.ConfigurationPage })));
const DoADiagnosticsPage = lazy(() => import('./pages/DoADiagnosticsPage').then((module) => ({ default: module.DoADiagnosticsPage })));
const MessageMonitorPage = lazy(() => import('./pages/MessageMonitorPage').then((module) => ({ default: module.MessageMonitorPage })));
const SystemHealthPage = lazy(() => import('./pages/SystemHealthPage').then((module) => ({ default: module.SystemHealthPage })));
const SimulationPage = lazy(() => import('./pages/SimulationPage').then((module) => ({ default: module.SimulationPage })));
const ReceiverPage = lazy(() => import('./pages/ReceiverPage').then((module) => ({ default: module.ReceiverPage })));

function prefetchRoutes(): void {
  void import('./pages/ConfigurationPage');
  void import('./pages/DoADiagnosticsPage');
  void import('./pages/MessageMonitorPage');
  void import('./pages/SystemHealthPage');
  void import('./pages/SimulationPage');
  void import('./pages/ReceiverPage');
}

const DEFAULT_BRANDING: Branding = { app_name: 'SDR-DoA Ground Console', logo_data_url: '' };
const DEFAULT_LOCAL_EXPIRY_MS = 5_000;

type FreshnessRecord = Record<string, unknown>;

type RefreshOptions = {
  syncMqtt?: boolean;
  allowBeforeConfig?: boolean;
};

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

function isAbortError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'name' in error) {
    return String((error as { name?: unknown }).name) === 'AbortError';
  }
  return false;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function PageForRoute({
  route,
  snapshot,
  localFresh,
  mqtt,
  config,
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
    case 'configuration': return <ConfigurationPage config={config} branding={branding} gpsConfig={gpsConfig} compassConfig={compassConfig} onGpsConfigChanged={onGpsConfigChanged} onCompassConfigChanged={onCompassConfigChanged} onConfigSaved={onConfigSaved} onBrandingChanged={onBrandingChanged} />;
    case 'message-monitor': return <MessageMonitorPage mqtt={mqtt} config={config} onMqttChanged={onMqttChanged} onRefreshMqtt={onRefreshMqtt} onReconnectMqtt={onReconnectMqtt} />;
    case 'receiver': return <ReceiverPage />;
    case 'overview':
    default: return <OverviewPage snapshot={snapshot} localSnapshotFresh={localFresh} gpsConfig={gpsConfig} compassConfig={compassConfig} />;
  }
}

export default function App(): ReactElement {
  const [route, navigate] = useRoute();
  const [config, setConfig] = useState<ConsoleConfig>(DEFAULT_CONSOLE_CONFIG);
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [mqtt, setMqtt] = useState<MqttSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
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
  const refreshController = useRef<AbortController | null>(null);
  const mqttController = useRef<AbortController | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);

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
    } catch (error: unknown) {
      if (!mountedRef.current || sequence !== mqttSequence.current || isAbortError(error)) return;
      // Never leave a previously healthy snapshot looking current after a
      // failed monitor read. The initiating page surfaces the error text; the
      // shell sees an explicitly cleared MQTT state.
      setMqtt(null);
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
    } catch (error: unknown) {
      if (!mountedRef.current || sequence !== mqttSequence.current || isAbortError(error)) return;
      setMqtt(null);
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
  }, []);

  const refresh = useCallback(async (baseUrl?: string, options: RefreshOptions = {}): Promise<void> => {
    if (!mountedRef.current) return;
    if (!configReadyRef.current && options.allowBeforeConfig !== true) {
      setReadError('Local console configuration unavailable; Data Out read was not attempted.');
      return;
    }

    const targetBaseUrl = baseUrl ?? configRef.current.base_url;
    if (!targetBaseUrl) {
      setReadError('No Data Out base URL is configured.');
      return;
    }

    const sequence = ++refreshSequence.current;
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    setLoading(true);
    setReadError(null);

    try {
      const next = await getSnapshot(targetBaseUrl, controller.signal);
      if (!mountedRef.current || sequence !== refreshSequence.current) return;
      const receivedAt = monotonicNow();
      setSnapshot(next);
      setReceivedAtMonotonic(receivedAt);
      setReadError(null);
      if (options.syncMqtt !== false) void refreshMqtt().catch(() => undefined);
    } catch (error: unknown) {
      if (!mountedRef.current || sequence !== refreshSequence.current || isAbortError(error)) return;
      // Keep the previous evidence in place, but currentLocalFresh remains false
      // while this error is displayed so stale data cannot look live.
      setReadError(errorMessage(error, 'Data Out snapshot failed.'));
    } finally {
      if (refreshController.current === controller) {
        refreshController.current = null;
        if (mountedRef.current && sequence === refreshSequence.current) setLoading(false);
      }
    }
  }, [refreshMqtt]);

  useEffect(() => {
    mountedRef.current = true;
    const initialConfigSequence = ++configSequence.current;
    const initialConfigController = new AbortController();
    const initialBrandingController = new AbortController();
    configController.current = initialConfigController;
    brandingController.current = initialBrandingController;

    getBranding(initialBrandingController.signal).then((next) => {
      if (mountedRef.current) setBranding(next);
    }).catch((error: unknown) => {
      if (!mountedRef.current || isAbortError(error)) return;
      // The default branding is safe and remains visible when the local
      // branding endpoint is unavailable.
    });

    getConsoleConfig(initialConfigController.signal).then((next) => {
      if (!mountedRef.current || initialConfigSequence !== configSequence.current) return;
      configRef.current = next;
      configReadyRef.current = true;
      setConfig(next);
      // MQTT configuration can change independently of Data Out availability;
      // start its guarded read immediately and do not duplicate it on snapshot.
      void refreshMqtt().catch(() => undefined);
      void refresh(next.base_url, { syncMqtt: false });
    }).catch((error: unknown) => {
      if (!mountedRef.current || initialConfigSequence !== configSequence.current || isAbortError(error)) return;
      configReadyRef.current = false;
      setLoading(false);
      // Do not substitute DEFAULT_CONSOLE_CONFIG.base_url here. A failed local
      // config read must never trigger an unverified remote Data Out request.
      setReadError('Local console configuration unavailable; Data Out read was not attempted.');
    });

    // Initial MQTT read starts only after local configuration resolves.

    return () => {
      mountedRef.current = false;
      ++configSequence.current;
      ++refreshSequence.current;
      ++mqttSequence.current;
      configController.current?.abort();
      brandingController.current?.abort();
      refreshController.current?.abort();
      mqttController.current?.abort();
      configController.current = null;
      brandingController.current = null;
      refreshController.current = null;
      mqttController.current = null;
    };
  }, [refresh, refreshMqtt]);

  useEffect(() => {
    const timer = window.setInterval(() => setExpiryTick((value) => value + 1), 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!configReadyRef.current || !Number.isFinite(config.refresh_seconds) || config.refresh_seconds <= 0) return undefined;
    const timer = window.setInterval(() => {
      if (configReadyRef.current) void refresh();
    }, config.refresh_seconds * 1000);
    return () => window.clearInterval(timer);
  }, [config.refresh_seconds, refresh]);

  useLayoutEffect(() => {
    const content = contentRef.current;
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
    setReadError(null);
    // A config save can replace the local subscriber. Read its state under the
    // same guard before the snapshot request is allowed to update the shell.
    void refreshMqtt().catch(() => undefined);
    await refresh(next.base_url, { syncMqtt: false, allowBeforeConfig: true });
  }, [refresh, refreshMqtt]);

  const onBrandingChanged = useCallback((next: Branding): void => {
    if (mountedRef.current) setBranding(next);
  }, []);

  const currentLocalFresh = expiryTick >= 0
    && !loading
    && readError === null
    && localSnapshotFresh(snapshot, receivedAtMonotonic);

  const lastReadAgeMs = receivedAtMonotonic === null ? null : Math.max(0, monotonicNow() - receivedAtMonotonic);

  return (
    <I18nContext.Provider value={i18n}>
      <ConsoleShell
        route={route}
        onNavigate={navigate}
        branding={branding}
        snapshot={snapshot}
        localSnapshotFresh={currentLocalFresh}
        loading={loading}
        readError={readError}
        lastReadAgeMs={lastReadAgeMs}
        mqttConnection={mqtt?.connection}
        simulationEnabled={simulationEnabled}
        onRefresh={() => void refresh()}
      >
        <section ref={contentRef} className="route-content" key={route}>
          <Suspense fallback={<div className="route-loading" role="status" aria-live="polite"><span aria-hidden="true" /></div>}>
            {route === 'simulation' ? <SimulationPage enabled={simulationEnabled} automatic={simulationAutomatic} settings={simulationSettings} onEnabled={enabled => { setSimulationEnabled(enabled); if (!enabled) setSimulationAutomatic(false); }} onAutomatic={setSimulationAutomatic} onSettings={setSimulationSettings} onRandomize={randomizeSimulation} onOverview={() => navigate('overview')} />
              : route === 'overview' && simulationEnabled ? <OverviewPage snapshot={syntheticSnapshot} localSnapshotFresh={true} gpsConfig={gpsConfig} compassConfig={compassConfig} simulation={simulationSettings} />
              : <PageForRoute route={route} snapshot={snapshot} localFresh={currentLocalFresh} mqtt={mqtt} config={config} branding={branding} gpsConfig={gpsConfig} compassConfig={compassConfig} onGpsConfigChanged={setGpsConfig} onCompassConfigChanged={setCompassConfig} onConfigSaved={onConfigSaved} onBrandingChanged={onBrandingChanged} onMqttChanged={applyMqtt} onRefreshMqtt={refreshMqtt} onReconnectMqtt={reconnectMqtt} />}
          </Suspense>
        </section>
      </ConsoleShell>
    </I18nContext.Provider>
  );
}

export { deriveDataState };
