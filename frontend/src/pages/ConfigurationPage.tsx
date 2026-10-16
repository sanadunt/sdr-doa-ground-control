import type { FormEvent, JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Branding, CompassConfig, ConsoleConfig, GpsConfig, MqttTransport, PolarSettings } from '../types';
import { ApiError, connectMqtt, dryRunConfigPatch, getAdminStatus, getBranding, getCapabilities, getConfigReported, loginAdmin, logoutAdmin, saveBranding, updateConsoleConfig } from '../api';
import type { ConfigReported, ConsoleCapabilities } from '../api';
import { DEFAULT_FALLBACK_COORDINATE, DEFAULT_GPS_CONFIG, manualGpsOverrideFromInput } from '../lib/map';
import { DEFAULT_COMPASS_CONFIG } from '../lib/polar';
import { DEFAULT_CONSOLE_CONFIG } from '../lib/telemetry';
import {
  activeSection,
  adminErrorKey,
  atPageBottom,
  coordinateText,
  gpsErrorField,
  gpsInputErrorKey,
  isLoopbackHost,
  mergeSavedConfigIntoDraft,
  normalizeConnectionDraft,
  parseBaseRevision,
  parseDryRunChanges,
  patchKeyUnit,
  refreshIntervalOptions,
  refreshWarningKey,
  summarizeDryRun,
} from '../lib/configForm';
import { MAX_LOGO_BYTES, pngDataUrl, pngLogoErrorKey, validatePngLogo } from '../lib/pngLogo';
import { CONFIG_PATCH_FIELDS, configPatchPublishable, fieldRange, plainNumber } from '../lib/configPatch';
import { DEFAULT_MQTT_TRANSPORT, DEFAULT_MQTT_WS_PATH, mqttTargetFromConfig, mqttTransportFields } from '../lib/mqttMonitor';
import { MAX_COMPASS_OFFSET_DEG, saveCompassConfig, saveGpsConfig } from '../lib/sourceConfigStorage';
import { errorNotice, noticeText } from '../lib/errorNotice';
import type { Notice } from '../lib/errorNotice';
import { useI18n } from '../lib/i18n';
import type { MessageKey } from '../lib/i18n';
import { Icon } from '../components/ui';
import { Card, FileButton, FormField, KeyValueGrid, Page, PageGrid, PageHeader, PageNotice, PageStack, Segmented, StatusChip, Tag } from '../components/page';
import type { KeyValueItem, PageTone } from '../components/page';
// Styled by pages/configuration.css, which main.tsx loads with the entry (no CSS in lazy chunks).

// The allowlisted fields, shared with Kontrol (SI units on the wire, ranges, steps).
const DRY_RUN_FIELDS = CONFIG_PATCH_FIELDS;
/** config-reported carries the monitor connection and the values the dry-run placeholders show. */
const REPORTED_POLL_MS = 3_000;
/** Data Out URLs the server accepts (ground_console.py ALLOWED_HOSTS, port 8081). */
const DATA_OUT_URLS = ['http://doasdr.local:8081', 'http://192.168.100.100:8081', 'http://127.0.0.1:8081', 'http://localhost:8081'] as const;
const DATA_OUT_HOSTS = 'doasdr.local · 192.168.100.100 · 127.0.0.1 · localhost · :8081';

type SourceCode = GpsConfig['source'];
const SOURCES: readonly SourceCode[] = ['DATA_OUT', 'MANUAL', 'FALLBACK'];
const SOURCE_LABELS: Record<SourceCode, MessageKey> = { DATA_OUT: 'config.sourceDataOut', MANUAL: 'config.sourceManual', FALLBACK: 'config.sourceFallback' };
// As on the Dashboard: a manual source in the signal colour, a fallback as a warning.
const SOURCE_TONES: Record<SourceCode, PageTone> = { DATA_OUT: 'neutral', MANUAL: 'signal', FALLBACK: 'warn' };

const SECTIONS = [
  { id: 'connection-settings', label: 'config.nav.connection' },
  { id: 'mqtt-settings', label: 'config.nav.mqtt' },
  { id: 'navigation-settings', label: 'config.nav.navigation' },
  { id: 'branding-settings', label: 'config.nav.branding' },
  { id: 'dry-run-settings', label: 'config.nav.dryRun' },
] as const satisfies ReadonlyArray<{ id: string; label: MessageKey }>;
type SectionId = typeof SECTIONS[number]['id'];
const NAVIGATION_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);

type Tone = 'good' | 'warn' | 'bad' | 'neutral';
/** The last action of a card: a state code, plus a message for errors and prompts. */
type Result = { code: string; tone: Tone; message?: Notice };
type Busy = 'connection' | 'mqtt' | 'reconnect' | 'login' | 'logout' | 'branding' | 'dry-run';
type AdminState = 'checking' | 'locked' | 'unlocked' | 'unknown';

function failure(error: unknown, fallback: MessageKey, code = 'ERROR'): Result {
  return { code, tone: 'bad', message: errorNotice(error, fallback) };
}

function adminFailure(error: unknown, fallback: MessageKey): Result {
  const key = adminErrorKey(error);
  return key ? { code: 'ERROR', tone: 'bad', message: { key } } : failure(error, fallback);
}

function submitWith(action: () => void): (event: FormEvent<HTMLFormElement>) => void {
  return (event) => {
    event.preventDefault();
    action();
  };
}

function without(errors: Record<string, Notice>, key: string): Record<string, Notice> {
  if (!(key in errors)) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

/** A range end for a hint, with a real minus sign (the reported value stays typeable). */
function hintNumber(value: number): string {
  return plainNumber(value).replace(/^-/u, '−');
}

function primaryWhen(dirty: boolean): string {
  return dirty ? 'ov-button is-primary' : 'ov-button';
}

function connectionTone(code: string): Tone {
  if (code === 'CONNECTED') return 'good';
  return code === 'DISABLED' || code === 'OFF' || code === 'UNKNOWN' ? 'neutral' : 'warn';
}

/** Bottom of the sticky top bar and section bar, so a jump lands below them. */
function stickyOffset(bar: Element | null): number {
  let bottom = 0;
  for (const element of [document.querySelector('.topbar'), bar]) {
    if (element && getComputedStyle(element).position === 'sticky') bottom = Math.max(bottom, element.getBoundingClientRect().bottom);
  }
  return bottom + 8;
}

/** A card's result: the state chip and, for errors and prompts, the message. Always present as a live region. */
function ResultLine({ result }: { result: Result | null }): JSX.Element {
  const { t } = useI18n();
  return (
    <span className="cfg-result" role="status">
      {result ? <StatusChip code={result.code} tone={result.tone} /> : null}
      {result?.message ? <span className={`cfg-result-text pg-text-${result.tone}`}>{noticeText(t, result.message)}</span> : null}
    </span>
  );
}

export function ConfigurationPage({
  config,
  branding,
  gpsConfig,
  compassConfig,
  onGpsConfigChanged,
  onCompassConfigChanged,
  onConfigSaved,
  onBrandingChanged,
}: {
  config: ConsoleConfig;
  branding: Branding;
  gpsConfig: GpsConfig;
  compassConfig: CompassConfig;
  onGpsConfigChanged: (next: GpsConfig) => void;
  onCompassConfigChanged: (next: CompassConfig) => void;
  onConfigSaved: (config: ConsoleConfig) => Promise<void>;
  onBrandingChanged: (branding: Branding) => void;
}): JSX.Element {
  const { t, lang } = useI18n();
  const ids = useId();
  const saved = useMemo<ConsoleConfig>(() => ({ ...DEFAULT_CONSOLE_CONFIG, ...config }), [config]);
  const [connection, setConnection] = useState<ConsoleConfig>({ ...DEFAULT_CONSOLE_CONFIG, ...config });
  // The port stays text while it is edited so clearing the field does not turn it into 0.
  const [mqttPortDraft, setMqttPortDraft] = useState(String(config.mqtt_port));
  const [connectionErrors, setConnectionErrors] = useState<{ baseUrl?: Notice; refresh?: Notice }>({});
  const [connectionResult, setConnectionResult] = useState<Result | null>(null);
  const [mqttErrors, setMqttErrors] = useState<{ host?: Notice; port?: Notice; wsPath?: Notice }>({});
  const [mqttResult, setMqttResult] = useState<Result | null>(null);
  const [capabilities, setCapabilities] = useState<ConsoleCapabilities | null>(null);
  const [reported, setReported] = useState<ConfigReported | null>(null);
  const [reportedFailed, setReportedFailed] = useState(false);
  const [reportedTick, setReportedTick] = useState(0);
  const [gpsSource, setGpsSource] = useState<SourceCode>(gpsConfig.source);
  const [manualLatitude, setManualLatitude] = useState(coordinateText(gpsConfig.manualLatitude));
  const [manualLongitude, setManualLongitude] = useState(coordinateText(gpsConfig.manualLongitude));
  const [gpsErrors, setGpsErrors] = useState<{ lat?: Notice; lon?: Notice }>({});
  const [gpsResult, setGpsResult] = useState<Result | null>(null);
  const [compassSource, setCompassSource] = useState<SourceCode>(compassConfig.source);
  const [manualAxis, setManualAxis] = useState<PolarSettings['figType']>(compassConfig.manualFigType);
  const [manualOffset, setManualOffset] = useState(String(compassConfig.manualCompassOffset));
  const [compassError, setCompassError] = useState<Notice | null>(null);
  const [compassResult, setCompassResult] = useState<Result | null>(null);
  const [admin, setAdmin] = useState<AdminState>('checking');
  const [adminReadError, setAdminReadError] = useState<Notice | null>(null);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<Notice | null>(null);
  const [brandName, setBrandName] = useState(branding.app_name);
  const [brandLogo, setBrandLogo] = useState(branding.logo_data_url);
  const [pendingLogo, setPendingLogo] = useState<string | null>(null);
  const [logoFileName, setLogoFileName] = useState<string | null>(null);
  const [brandResult, setBrandResult] = useState<Result | null>(null);
  const [dryRunValues, setDryRunValues] = useState<Record<string, string>>({});
  const [baseRevision, setBaseRevision] = useState('');
  const [dryRunErrors, setDryRunErrors] = useState<Record<string, Notice>>({});
  const [dryRunResult, setDryRunResult] = useState<Result | null>(null);
  const [dryRunData, setDryRunData] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [currentSection, setCurrentSection] = useState<SectionId>(SECTIONS[0].id);
  const mountedRef = useRef(false);
  const logoSequence = useRef(0);
  const indexRef = useRef<HTMLElement>(null);
  // The section last jumped to; it wins a tie between sections in one grid row.
  const preferredSection = useRef<SectionId | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      logoSequence.current += 1;
    };
  }, []);
  // A save from the top-bar interval select also lands here; only the saved
  // fields that changed replace the draft, so unsaved edits survive it.
  const savedConfigRef = useRef(config);
  useEffect(() => {
    const previous = savedConfigRef.current;
    savedConfigRef.current = config;
    if (previous === config) return;
    setConnection((draft) => mergeSavedConfigIntoDraft(draft, { ...DEFAULT_CONSOLE_CONFIG, ...previous }, { ...DEFAULT_CONSOLE_CONFIG, ...config }));
    if (previous.mqtt_port !== config.mqtt_port) setMqttPortDraft(String(config.mqtt_port));
  }, [config]);
  useEffect(() => {
    setBrandName(branding.app_name);
    setBrandLogo(branding.logo_data_url);
    setPendingLogo(null);
    setLogoFileName(null);
  }, [branding]);
  useEffect(() => {
    let active = true;
    getAdminStatus().then((result) => {
      if (!active) return;
      setAdmin(result.authenticated ? 'unlocked' : 'locked');
      setAdminReadError(null);
    }).catch((error: unknown) => {
      if (!active) return;
      setAdmin('unknown');
      setAdminReadError(errorNotice(error, 'config.adminUnavailable'));
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    // Older servers have no capability fields; the form then keeps its built-in defaults.
    getCapabilities(controller.signal).then((next) => {
      if (!controller.signal.aborted) setCapabilities(next);
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);
  // The monitor connection (page bar and MQTT card) and the reported values
  // the dry-run fields show as placeholders. A save or reconnect reads again at once.
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    const read = () => {
      const current = new AbortController();
      controller = current;
      getConfigReported(current.signal).then((next) => {
        if (!active) return;
        setReported(next);
        setReportedFailed(false);
      }).catch(() => {
        if (active && !current.signal.aborted) setReportedFailed(true);
      }).finally(() => {
        if (active) timer = window.setTimeout(read, REPORTED_POLL_MS);
      });
    };
    read();
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, [reportedTick]);

  useEffect(() => {
    setGpsSource(gpsConfig.source);
    setManualLatitude(coordinateText(gpsConfig.manualLatitude));
    setManualLongitude(coordinateText(gpsConfig.manualLongitude));
  }, [gpsConfig]);

  useEffect(() => {
    setCompassSource(compassConfig.source);
    setManualAxis(compassConfig.manualFigType);
    setManualOffset(String(compassConfig.manualCompassOffset));
  }, [compassConfig]);

  // Marks the section under the sticky index while the page scrolls.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const sections: Array<{ id: SectionId; top: number }> = [];
      for (const section of SECTIONS) {
        const element = document.getElementById(section.id);
        if (!element) return;
        sections.push({ id: section.id, top: element.getBoundingClientRect().top });
      }
      const atBottom = atPageBottom(window.innerHeight, window.scrollY, document.documentElement.scrollHeight);
      const next = activeSection(sections, stickyOffset(indexRef.current?.closest('.pg-bar') ?? null), atBottom, preferredSection.current);
      if (next) setCurrentSection(next as SectionId);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    // Scrolling by hand ends the preference for the section last jumped to.
    const release = () => { preferredSection.current = null; };
    const releaseOnKey = (event: KeyboardEvent) => {
      if (NAVIGATION_KEYS.has(event.key)) release();
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('wheel', release, { passive: true });
    window.addEventListener('touchstart', release, { passive: true });
    window.addEventListener('keydown', releaseOnKey);
    schedule();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('wheel', release);
      window.removeEventListener('touchstart', release);
      window.removeEventListener('keydown', releaseOnKey);
    };
  }, []);

  const jumpTo = (id: SectionId) => {
    const element = document.getElementById(id);
    if (!element) return;
    preferredSection.current = id;
    setCurrentSection(id);
    const top = element.getBoundingClientRect().top + window.scrollY - stickyOffset(indexRef.current?.closest('.pg-bar') ?? null);
    window.scrollTo({ top: Math.max(0, top) });
    // Move focus with the jump, as an in-page link does.
    const heading = element.querySelector('h2');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  };

  const indexKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const buttons = [...event.currentTarget.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[(index + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length].focus();
  };

  const selectedLogo = pendingLogo === null ? brandLogo : pendingLogo;
  const refreshOptions = useMemo(() => refreshIntervalOptions(capabilities?.refreshIntervalsS ?? null, config.refresh_seconds), [capabilities, config.refresh_seconds]);
  const refreshWarning = refreshWarningKey(Number(connection.refresh_seconds));
  const adminAuthenticated = admin === 'unlocked';
  const adminDisabled = capabilities?.adminEnabled === false && !adminAuthenticated;
  const patchPublishable = configPatchPublishable(capabilities);
  const adminCode = adminAuthenticated ? 'AUTHENTICATED' : adminDisabled ? 'DISABLED' : admin === 'checking' ? 'CHECKING' : admin === 'unknown' ? 'UNKNOWN' : 'LOCKED';
  const adminTone: Tone = adminAuthenticated ? 'good' : adminDisabled || admin === 'checking' ? 'neutral' : 'warn';
  const mqttCode = reportedFailed ? 'ERROR' : reported ? reported.broker.connection.toUpperCase() : 'UNKNOWN';
  const mqttTitle = reported?.code ?? undefined;
  const transport: MqttTransport = connection.mqtt_transport ?? DEFAULT_MQTT_TRANSPORT;
  const savedTransport: MqttTransport = saved.mqtt_transport ?? DEFAULT_MQTT_TRANSPORT;
  const wsPath = connection.mqtt_ws_path ?? DEFAULT_MQTT_WS_PATH;
  const savedHost = saved.mqtt_host.trim();
  const noTls = savedHost !== '' && !isLoopbackHost(savedHost);
  const ranges = capabilities?.configPatch?.ranges;
  const numberFormat = useMemo(() => new Intl.NumberFormat(lang === 'id' ? 'id-ID' : 'en-US', { maximumFractionDigits: 3 }), [lang]);
  const dryRunSummary = useMemo(() => (dryRunData ? summarizeDryRun(dryRunData) : null), [dryRunData]);

  const changed = {
    baseUrl: connection.base_url.trim().replace(/\/+$/u, '') !== saved.base_url,
    refresh: Number(connection.refresh_seconds) !== saved.refresh_seconds,
    host: connection.mqtt_host.trim() !== saved.mqtt_host,
    port: mqttPortDraft.trim() !== String(saved.mqtt_port),
    transport: transport !== savedTransport,
    wsPath: transport === 'websockets' && wsPath.trim() !== (saved.mqtt_ws_path ?? DEFAULT_MQTT_WS_PATH),
    gpsSource: gpsSource !== gpsConfig.source,
    lat: gpsSource === 'MANUAL' && manualLatitude.trim() !== coordinateText(gpsConfig.manualLatitude),
    lon: gpsSource === 'MANUAL' && manualLongitude.trim() !== coordinateText(gpsConfig.manualLongitude),
    compassSource: compassSource !== compassConfig.source,
    axis: manualAxis !== compassConfig.manualFigType,
    offset: manualOffset.trim() !== String(compassConfig.manualCompassOffset),
    appName: brandName.trim() !== branding.app_name,
  };
  const connectionDirty = changed.baseUrl || changed.refresh;
  const mqttDirty = changed.host || changed.port || changed.transport || changed.wsPath;
  const gpsDirty = changed.gpsSource || changed.lat || changed.lon;
  const compassDirty = changed.compassSource || changed.axis || changed.offset;
  const brandingDirty = changed.appName || pendingLogo !== null;
  const changedClass = (flag: boolean) => (flag ? 'cfg-changed' : undefined);
  const fieldError = (notice: Notice | null | undefined) => (notice ? noticeText(t, notice) : undefined);

  const editConnection = (patch: Partial<ConsoleConfig>, field: 'baseUrl' | 'refresh') => {
    setConnection((draft) => ({ ...draft, ...patch }));
    setConnectionErrors((errors) => ({ ...errors, [field]: undefined }));
    setConnectionResult(null);
  };
  const editMqtt = (patch: Partial<ConsoleConfig>, field: 'host' | 'wsPath' | null) => {
    setConnection((draft) => ({ ...draft, ...patch }));
    if (field) setMqttErrors((errors) => ({ ...errors, [field]: undefined }));
    setMqttResult(null);
  };

  const saveConnection = async () => {
    // Only this card's fields: an unsaved MQTT edit stays a draft.
    const draft = normalizeConnectionDraft({
      base_url: connection.base_url,
      mqtt_host: saved.mqtt_host,
      mqtt_port: String(saved.mqtt_port),
      refresh_seconds: Number(connection.refresh_seconds),
    }, refreshOptions);
    if (!draft.ok) {
      if (draft.error === 'config.baseUrlRequired') setConnectionErrors({ baseUrl: { key: draft.error } });
      else if (draft.error === 'config.refreshInvalid') setConnectionErrors({ refresh: { key: draft.error } });
      else setConnectionResult({ code: 'ERROR', tone: 'bad', message: { key: draft.error, vars: draft.vars } });
      return;
    }
    setConnectionErrors({});
    setConnectionResult(null);
    setBusy('connection');
    try {
      const normalized = await updateConsoleConfig({ ...saved, base_url: draft.value.base_url, refresh_seconds: draft.value.refresh_seconds });
      await onConfigSaved(normalized);
      if (!mountedRef.current) return;
      setConnection((current) => ({ ...current, base_url: normalized.base_url, refresh_seconds: normalized.refresh_seconds }));
      setConnectionResult({ code: 'SAVED', tone: 'good' });
    } catch (error: unknown) {
      if (mountedRef.current) setConnectionResult(failure(error, 'config.connectionRejected'));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const saveMqtt = async () => {
    const draft = normalizeConnectionDraft({
      base_url: saved.base_url,
      mqtt_host: connection.mqtt_host,
      mqtt_port: mqttPortDraft,
      refresh_seconds: saved.refresh_seconds,
    }, refreshOptions);
    // The path field is disabled under TCP; an edit left there neither blocks the save nor replaces the stored path.
    const fields = mqttTransportFields(connection.mqtt_transport, transport === 'websockets' ? connection.mqtt_ws_path : undefined);
    const errors: { port?: Notice; wsPath?: Notice } = {};
    if (!draft.ok && draft.error === 'config.mqttPortInvalid') errors.port = { key: draft.error };
    if (!fields.ok) errors.wsPath = { key: fields.error };
    if (errors.port || errors.wsPath) {
      setMqttErrors(errors);
      return;
    }
    if (!draft.ok || !fields.ok) {
      if (!draft.ok) setMqttResult({ code: 'ERROR', tone: 'bad', message: { key: draft.error, vars: draft.vars } });
      return;
    }
    setMqttErrors({});
    setMqttResult(null);
    setBusy('mqtt');
    try {
      const normalized = await updateConsoleConfig({ ...saved, mqtt_host: draft.value.mqtt_host, mqtt_port: draft.value.mqtt_port, ...fields.value });
      await onConfigSaved(normalized);
      if (!mountedRef.current) return;
      setConnection((current) => ({ ...current, mqtt_host: normalized.mqtt_host, mqtt_port: normalized.mqtt_port, mqtt_transport: normalized.mqtt_transport, mqtt_ws_path: normalized.mqtt_ws_path }));
      setMqttPortDraft(String(normalized.mqtt_port));
      setMqttResult({ code: 'SAVED', tone: 'good' });
      setReportedTick((tick) => tick + 1);
    } catch (error: unknown) {
      if (mountedRef.current) setMqttResult(failure(error, 'config.connectionRejected'));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const reconnect = async () => {
    if (!savedHost) return;
    setMqttResult(null);
    setBusy('reconnect');
    try {
      await connectMqtt(mqttTargetFromConfig(saved));
      if (!mountedRef.current) return;
      setMqttResult({ code: 'REQUESTED', tone: 'neutral' });
      setReportedTick((tick) => tick + 1);
    } catch (error: unknown) {
      if (mountedRef.current) setMqttResult(failure(error, 'config.reconnectFailed'));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const applyGpsConfig = () => {
    const validation = manualGpsOverrideFromInput(manualLatitude, manualLongitude);
    if (gpsSource === 'MANUAL' && !validation.override) {
      const key = gpsInputErrorKey(manualLatitude, manualLongitude) ?? 'config.gpsInvalid';
      setGpsErrors({ [gpsErrorField(key)]: { key } });
      setGpsResult(null);
      return;
    }
    const next: GpsConfig = {
      source: gpsSource,
      manualLatitude: validation.override?.latitude ?? DEFAULT_FALLBACK_COORDINATE.latitude,
      manualLongitude: validation.override?.longitude ?? DEFAULT_FALLBACK_COORDINATE.longitude,
    };
    onGpsConfigChanged(next);
    saveGpsConfig(next);
    setGpsErrors({});
    setGpsResult({ code: 'APPLIED', tone: 'good' });
  };

  const applyCompassConfig = () => {
    const compassOffset = manualOffset.trim() === '' ? Number.NaN : Number(manualOffset);
    if (!Number.isFinite(compassOffset) || Math.abs(compassOffset) > MAX_COMPASS_OFFSET_DEG) {
      setCompassError({ key: 'config.compassInvalid' });
      setCompassResult(null);
      return;
    }
    const next: CompassConfig = { source: compassSource, manualFigType: manualAxis, manualCompassOffset: compassOffset };
    onCompassConfigChanged(next);
    saveCompassConfig(next);
    setCompassError(null);
    setCompassResult({ code: 'APPLIED', tone: 'good' });
  };

  const restoreGpsDefaults = () => {
    onGpsConfigChanged(DEFAULT_GPS_CONFIG);
    saveGpsConfig(DEFAULT_GPS_CONFIG);
    setGpsSource(DEFAULT_GPS_CONFIG.source);
    setManualLatitude(coordinateText(DEFAULT_GPS_CONFIG.manualLatitude));
    setManualLongitude(coordinateText(DEFAULT_GPS_CONFIG.manualLongitude));
    setGpsErrors({});
    setGpsResult({ code: 'DEFAULT', tone: 'neutral' });
  };

  const restoreCompassDefaults = () => {
    onCompassConfigChanged(DEFAULT_COMPASS_CONFIG);
    saveCompassConfig(DEFAULT_COMPASS_CONFIG);
    setCompassSource(DEFAULT_COMPASS_CONFIG.source);
    setManualAxis(DEFAULT_COMPASS_CONFIG.manualFigType);
    setManualOffset(String(DEFAULT_COMPASS_CONFIG.manualCompassOffset));
    setCompassError(null);
    setCompassResult({ code: 'DEFAULT', tone: 'neutral' });
  };

  const signIn = async () => {
    if (!password || adminDisabled) return;
    setPasswordError(null);
    setBusy('login');
    try {
      await loginAdmin(password);
      if (!mountedRef.current) return;
      setPassword('');
      setAdmin('unlocked');
      setAdminReadError(null);
      setBrandResult(null);
    } catch (error: unknown) {
      if (mountedRef.current) setPasswordError(adminFailure(error, 'config.loginFailed').message ?? { key: 'config.loginFailed' });
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const signOut = async () => {
    setBusy('logout');
    try {
      await logoutAdmin();
      if (!mountedRef.current) return;
      setAdmin('locked');
      setBrandResult(null);
    } catch (error: unknown) {
      if (mountedRef.current) setBrandResult(failure(error, 'config.logoutFailed'));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const chooseLogo = (input: HTMLInputElement) => {
    const file = input.files?.[0];
    // Clear the picker so choosing the same file again after a rejection re-runs the check.
    input.value = '';
    if (!file) return;
    if ((file.type && file.type !== 'image/png') || file.size > MAX_LOGO_BYTES) {
      setBrandResult({ code: 'ERROR', tone: 'bad', message: { key: file.size > MAX_LOGO_BYTES ? 'config.logoTooLarge' : 'config.logoNotPng' } });
      return;
    }
    const sequence = ++logoSequence.current;
    file.arrayBuffer().then((buffer) => {
      if (!mountedRef.current || sequence !== logoSequence.current) return;
      const bytes = new Uint8Array(buffer);
      const problem = validatePngLogo(bytes);
      if (problem) {
        setBrandResult({ code: 'ERROR', tone: 'bad', message: { key: pngLogoErrorKey(problem) } });
        return;
      }
      setPendingLogo(pngDataUrl(bytes));
      setLogoFileName(file.name);
      setBrandResult({ code: 'STAGED', tone: 'warn', message: { key: 'config.logoStaged' } });
    }).catch(() => {
      if (mountedRef.current && sequence === logoSequence.current) setBrandResult({ code: 'ERROR', tone: 'bad', message: { key: 'config.logoReadFailed' } });
    });
  };

  const persistBranding = async () => {
    setBusy('branding');
    setBrandResult(null);
    try {
      const savedBranding = await saveBranding({ app_name: brandName.trim(), logo_data_url: selectedLogo });
      const verified = await getBranding();
      if (!mountedRef.current) return;
      if (savedBranding.app_name !== verified.app_name || savedBranding.logo_data_url !== verified.logo_data_url) {
        setBrandResult({ code: 'MISMATCH', tone: 'bad', message: { key: 'config.readbackMismatch' } });
        return;
      }
      onBrandingChanged(verified);
      setPendingLogo(null);
      setLogoFileName(null);
      setBrandResult({ code: 'VERIFIED', tone: 'good' });
    } catch (error: unknown) {
      if (mountedRef.current) setBrandResult(adminFailure(error, 'config.brandingFailed'));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const runDryRun = async () => {
    setDryRunData(null);
    setDryRunResult(null);
    const changes = parseDryRunChanges(dryRunValues, DRY_RUN_FIELDS);
    const revision = parseBaseRevision(baseRevision);
    const errors: Record<string, Notice> = {};
    if (!changes.ok && changes.error === 'config.dryRunNotNumber' && changes.vars?.field) errors[String(changes.vars.field)] = { key: changes.error, vars: changes.vars };
    if (!revision.ok) errors.base_config_rev = { key: revision.error };
    setDryRunErrors(errors);
    if (!changes.ok && !Object.keys(errors).length) {
      setDryRunResult({ code: 'ERROR', tone: 'bad', message: { key: changes.error, vars: changes.vars } });
      return;
    }
    if (!changes.ok || !revision.ok) return;
    setBusy('dry-run');
    try {
      const result = await dryRunConfigPatch({ base_config_rev: revision.value, changes: changes.value });
      if (!mountedRef.current) return;
      if (result.ok === true) {
        setDryRunData(result);
        setDryRunResult({ code: 'PASS', tone: 'good' });
      } else {
        setDryRunResult({ code: 'REJECTED', tone: 'bad', message: result.error ? { text: String(result.error) } : { key: 'config.dryRunRejected' } });
      }
    } catch (error: unknown) {
      if (mountedRef.current) setDryRunResult(failure(error, 'config.dryRunFailed', error instanceof ApiError && error.status === 400 ? 'REJECTED' : 'ERROR'));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const sourceOptions = SOURCES.map((source) => ({ value: source, label: t(SOURCE_LABELS[source]) }));
  const refreshLabel = t('config.refresh');
  const transportLabel = t('config.mqttTransport');
  const axisLabel = t('config.manualAxis');
  const resultItems: Array<KeyValueItem | null> = dryRunSummary ? [
    dryRunSummary.baseConfigRev !== null ? { id: 'rev', label: 'base_config_rev', value: dryRunSummary.baseConfigRev } : null,
    ...dryRunSummary.changes.map((change): KeyValueItem => ({ id: change.key, label: change.key, value: `${numberFormat.format(change.value)} ${patchKeyUnit(change.key)}`.trim() })),
    dryRunSummary.ttlMs !== null ? { id: 'ttl', label: 'ttl', value: t('common.durationS', { value: numberFormat.format(dryRunSummary.ttlMs / 1000) }) } : null,
    dryRunSummary.transport ? { id: 'transport', label: 'transport', value: dryRunSummary.transport } : null,
  ] : [];

  return (
    <Page className="cfg-page">
      <PageHeader
        title={t('route.configuration')}
        className="cfg-bar"
        chips={<>
          <StatusChip label={t('page.chip.admin')} code={adminCode} tone={adminTone} />
          <StatusChip label={t('status.mqtt')} code={mqttCode} tone={connectionTone(mqttCode)} title={mqttTitle} />
          <StatusChip label={t('page.chip.patch')} code={patchPublishable ? 'ADMIN ONLY' : 'UNAVAILABLE'} tone={patchPublishable ? 'warn' : 'neutral'} />
        </>}
        actions={(
          <nav ref={indexRef} className="cfg-index" aria-label={t('config.sections')}>
            <div className="ov-seg pg-seg is-compact" onKeyDown={indexKeys}>
              {SECTIONS.map((section) => (
                <button key={section.id} type="button" aria-controls={section.id} aria-current={currentSection === section.id ? 'location' : undefined} onClick={() => jumpTo(section.id)}>{t(section.label)}</button>
              ))}
            </div>
          </nav>
        )}
      />
      <PageGrid className="cfg-grid">
        {/* Two columns of content-height cards (Data Out and MQTT; GPS & Compass and Branding), so no card stretches to its neighbour's height. */}
        <PageStack span={6}>
          <Card id="connection-settings" span={6} className="cfg-section" bodyClassName="cfg-conn-body" title={t('config.connectionTitle')}>
            <form className="cfg-form cfg-conn-form" noValidate onSubmit={submitWith(() => { if (!busy) void saveConnection(); })}>
              <FormField label={t('config.baseUrl')} mono error={fieldError(connectionErrors.baseUrl)} className={changedClass(changed.baseUrl)}>
                <input type="text" inputMode="url" list={`${ids}-data-out`} value={connection.base_url} placeholder={DATA_OUT_URLS[0]} title={DATA_OUT_HOSTS} spellCheck={false} autoComplete="off" onChange={(event) => editConnection({ base_url: event.target.value }, 'baseUrl')} />
              </FormField>
              <datalist id={`${ids}-data-out`}>{DATA_OUT_URLS.map((url) => <option key={url} value={url} />)}</datalist>
              <div className="cfg-group">
                <span className="pg-field-label" aria-hidden="true">{refreshLabel}</span>
                <Segmented
                  label={refreshLabel}
                  className={changedClass(changed.refresh)}
                  options={refreshOptions.map((seconds) => ({ value: seconds, label: seconds === 0 ? t('shell.refreshManual') : t('common.durationS', { value: seconds }) }))}
                  value={Number(connection.refresh_seconds)}
                  onChange={(seconds) => editConnection({ refresh_seconds: seconds }, 'refresh')}
                />
                {connectionErrors.refresh ? <span className="pg-field-error" role="alert">{fieldError(connectionErrors.refresh)}</span> : null}
                {refreshWarning ? <span className="cfg-warn" role="status">{t(refreshWarning)}</span> : null}
              </div>
              <div className="cfg-actions">
                <button className={primaryWhen(connectionDirty)} type="submit" disabled={busy !== null} aria-busy={busy === 'connection' || undefined}>{t('config.save')}</button>
                <ResultLine result={connectionResult} />
              </div>
            </form>
          </Card>

          <Card id="mqtt-settings" span={6} className="cfg-section" title={t('config.mqttTitle')} chip={<StatusChip code={mqttCode} tone={connectionTone(mqttCode)} title={mqttTitle} />}>
            <form className="cfg-form" noValidate onSubmit={submitWith(() => { if (!busy) void saveMqtt(); })}>
              <div className="cfg-row">
                <FormField label={t('config.mqttHost')} mono className={['cfg-grow', changedClass(changed.host)].filter(Boolean).join(' ')} error={fieldError(mqttErrors.host)}>
                  <input type="text" value={connection.mqtt_host} placeholder={t('config.mqttHostPlaceholder')} spellCheck={false} autoComplete="off" onChange={(event) => editMqtt({ mqtt_host: event.target.value }, 'host')} />
                </FormField>
                <FormField label={t('config.mqttPort')} size="sm" error={fieldError(mqttErrors.port)} className={changedClass(changed.port)}>
                  <input type="number" inputMode="numeric" value={mqttPortDraft} min={1} max={65535} step={1} onChange={(event) => { setMqttPortDraft(event.target.value); setMqttErrors((errors) => ({ ...errors, port: undefined })); setMqttResult(null); }} />
                </FormField>
              </div>
              <div className="cfg-row">
                <div className="cfg-group">
                  <span className="pg-field-label" aria-hidden="true">{transportLabel}</span>
                  <Segmented label={transportLabel} className={changedClass(changed.transport)} options={[{ value: 'websockets' as const, label: t('config.mqttTransportWs') }, { value: 'tcp' as const, label: t('config.mqttTransportTcp') }]} value={transport} onChange={(next) => editMqtt({ mqtt_transport: next }, 'wsPath')} />
                </div>
                <FormField label={t('config.mqttWsPath')} size="sm" mono error={fieldError(mqttErrors.wsPath)} className={changedClass(changed.wsPath)}>
                  <input type="text" value={wsPath} spellCheck={false} autoComplete="off" disabled={transport !== 'websockets'} onChange={(event) => editMqtt({ mqtt_ws_path: event.target.value }, 'wsPath')} />
                </FormField>
              </div>
              {noTls ? <PageNotice tone="warn" title="NO TLS">{t('config.mqttNoCredentials')}</PageNotice> : null}
              <div className="cfg-actions">
                <button className={primaryWhen(mqttDirty)} type="submit" disabled={busy !== null} aria-busy={busy === 'mqtt' || undefined}>{t('config.save')}</button>
                <button className="ov-button" type="button" disabled={busy !== null || !savedHost} aria-busy={busy === 'reconnect' || undefined} onClick={() => { void reconnect(); }}>{t('config.reconnect')}</button>
                <ResultLine result={mqttResult} />
              </div>
            </form>
          </Card>
        </PageStack>

        <PageStack span={6}>
          <Card id="navigation-settings" className="cfg-section" bodyClassName="cfg-nav-body" title={t('config.navTitle')}>
            <div className="cfg-split">
              <form className="cfg-sub" noValidate aria-labelledby={`${ids}-gps`} onSubmit={submitWith(applyGpsConfig)}>
                <div className="cfg-sub-head">
                  <h3 id={`${ids}-gps`} className="cfg-sub-title">{t('config.gpsTitle')}</h3>
                  <Tag tone={SOURCE_TONES[gpsConfig.source]}>{gpsConfig.source}</Tag>
                </div>
                <Segmented label={t('config.gpsSource')} className={changedClass(changed.gpsSource)} options={sourceOptions} value={gpsSource} onChange={(source) => { setGpsSource(source); setGpsErrors({}); setGpsResult(null); }} />
                <div className="cfg-pair">
                  <FormField label={t('config.manualLat')} unit="°" error={fieldError(gpsErrors.lat)} className={changedClass(changed.lat)}>
                    <input type="number" inputMode="decimal" value={manualLatitude} min={-90} max={90} step={0.000001} placeholder="−90…90" disabled={gpsSource !== 'MANUAL'} onChange={(event) => { setManualLatitude(event.target.value); setGpsErrors({}); setGpsResult(null); }} />
                  </FormField>
                  <FormField label={t('config.manualLon')} unit="°" error={fieldError(gpsErrors.lon)} className={changedClass(changed.lon)}>
                    <input type="number" inputMode="decimal" value={manualLongitude} min={-180} max={180} step={0.000001} placeholder="−180…180" disabled={gpsSource !== 'MANUAL'} onChange={(event) => { setManualLongitude(event.target.value); setGpsErrors({}); setGpsResult(null); }} />
                  </FormField>
                </div>
                <KeyValueGrid columns={1} items={[{ id: 'fallback', label: t('config.sourceFallback'), value: `${DEFAULT_FALLBACK_COORDINATE.latitude.toFixed(6)}, ${DEFAULT_FALLBACK_COORDINATE.longitude.toFixed(6)}` }]} />
                <div className="cfg-actions">
                  <button className={primaryWhen(gpsDirty)} type="submit" aria-label={t('config.applyGps')}>{t('config.apply')}</button>
                  <button className="ov-icon-button is-bordered" type="button" aria-label={t('config.restoreGpsDefaults')} title={t('config.restoreGpsDefaults')} onClick={restoreGpsDefaults}><Icon name="reset" /></button>
                  <ResultLine result={gpsResult} />
                </div>
              </form>
              <form className="cfg-sub" noValidate aria-labelledby={`${ids}-compass`} onSubmit={submitWith(applyCompassConfig)}>
                <div className="cfg-sub-head">
                  <h3 id={`${ids}-compass`} className="cfg-sub-title">{t('config.compassTitle')}</h3>
                  <Tag tone={SOURCE_TONES[compassConfig.source]}>{compassConfig.source}</Tag>
                </div>
                <Segmented label={t('config.compassSource')} className={changedClass(changed.compassSource)} options={sourceOptions} value={compassSource} onChange={(source) => { setCompassSource(source); setCompassResult(null); }} />
                <div className="cfg-pair">
                  <div className="cfg-group">
                    <span className="pg-field-label" aria-hidden="true">{axisLabel}</span>
                    <Segmented label={axisLabel} className={changedClass(changed.axis)} options={[{ value: 'Compass' as const, label: t('polarDock.viewCompass') }, { value: 'Polar' as const, label: t('polarDock.viewPolar') }]} value={manualAxis} onChange={(axis) => { setManualAxis(axis); setCompassResult(null); }} />
                  </div>
                  <FormField label={t('config.manualOffset')} unit="°" error={fieldError(compassError)} className={changedClass(changed.offset)}>
                    <input type="number" inputMode="decimal" value={manualOffset} min={-MAX_COMPASS_OFFSET_DEG} max={MAX_COMPASS_OFFSET_DEG} step={0.1} onChange={(event) => { setManualOffset(event.target.value); setCompassError(null); setCompassResult(null); }} />
                  </FormField>
                </div>
                <div className="cfg-actions">
                  <button className={primaryWhen(compassDirty)} type="submit" aria-label={t('config.applyCompass')}>{t('config.apply')}</button>
                  <button className="ov-icon-button is-bordered" type="button" aria-label={t('config.restoreCompassDefaults')} title={t('config.restoreCompassDefaults')} onClick={restoreCompassDefaults}><Icon name="reset" /></button>
                  <ResultLine result={compassResult} />
                </div>
              </form>
            </div>
          </Card>

          <Card id="branding-settings" className="cfg-section" title={t('config.brandingTitle')} chip={<StatusChip code={adminCode} tone={adminTone} />}>
            {capabilities?.adminDefaultPassword ? <PageNotice tone="warn" title="DEFAULT PASSWORD">{t('control.defaultPassword')}</PageNotice> : null}
            {adminReadError && !adminAuthenticated ? <PageNotice tone="warn" title="ADMIN">{noticeText(t, adminReadError)}</PageNotice> : null}
            {adminDisabled ? <PageNotice tone="warn" title="DISABLED">{t('config.adminDisabled')}</PageNotice> : null}
            {!adminAuthenticated ? (
              <form className="cfg-form" noValidate onSubmit={submitWith(() => { if (!busy) void signIn(); })}>
                <FormField label={t('config.password')} size="md" error={fieldError(passwordError)}>
                  <input type="password" value={password} disabled={adminDisabled} autoComplete="current-password" onChange={(event) => { setPassword(event.target.value); setPasswordError(null); }} />
                </FormField>
                <div className="cfg-actions">
                  <button className="ov-button is-primary" type="submit" disabled={busy !== null || !password || adminDisabled} aria-busy={busy === 'login' || undefined}>{t('config.unlock')}</button>
                </div>
              </form>
            ) : (
              <form className="cfg-form" noValidate onSubmit={submitWith(() => { if (!busy) void persistBranding(); })}>
                <div className="cfg-brand">
                  <div className="cfg-logo">{selectedLogo ? <img src={selectedLogo} alt={t('config.logoPreview')} /> : <span>{t('config.noLogo')}</span>}</div>
                  <div className="cfg-brand-fields">
                    <FormField label={t('config.appName')} className={changedClass(changed.appName)}>
                      <input type="text" value={brandName} maxLength={60} autoComplete="off" onChange={(event) => { setBrandName(event.target.value); setBrandResult(null); }} />
                    </FormField>
                    <div className="cfg-group" role="group" aria-label={t('config.logo')}>
                      <span className="pg-field-label" aria-hidden="true">{t('config.logo')}</span>
                      <FileButton label={t('config.choosePng')} accept="image/png" fileName={logoFileName ?? (pendingLogo === '' ? '—' : null)} placeholder={t('config.logoLimits')} disabled={busy !== null} onChange={chooseLogo} />
                    </div>
                  </div>
                </div>
                <div className="cfg-actions">
                  <button className={primaryWhen(brandingDirty)} type="submit" disabled={busy !== null} aria-busy={busy === 'branding' || undefined}>{t('config.save')}</button>
                  <button className="ov-button" type="button" disabled={busy !== null || selectedLogo === ''} onClick={() => { setPendingLogo(''); setLogoFileName(null); setBrandResult({ code: 'STAGED', tone: 'warn', message: { key: 'config.logoRemoval' } }); }}>{t('config.resetLogo')}</button>
                  <button className="ov-button tone-bad" type="button" disabled={busy !== null} aria-busy={busy === 'logout' || undefined} onClick={() => { void signOut(); }}>{t('config.closeAdmin')}</button>
                  <ResultLine result={brandResult} />
                </div>
              </form>
            )}
          </Card>
        </PageStack>

        <Card id="dry-run-settings" span={12} className="cfg-section" title={t('config.dryRunTitle')} chip={<Tag>DRY-RUN</Tag>}>
          <form className="cfg-form" noValidate onSubmit={submitWith(() => { if (!busy) void runDryRun(); })}>
            <div className="cfg-dry-fields">
              {DRY_RUN_FIELDS.map((field) => {
                const [min, max] = fieldRange(field, ranges);
                const reportedValue = reported?.values[field.key];
                const unit = field.unit === 'dB' ? 'dB' : 'Hz';
                return (
                  <FormField key={field.key} label={t(field.label)} unit={unit} error={fieldError(dryRunErrors[field.key])}>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={dryRunValues[field.key] ?? ''}
                      min={min}
                      max={max}
                      step={field.step}
                      placeholder={typeof reportedValue === 'number' ? plainNumber(reportedValue) : `${hintNumber(min)}…${hintNumber(max)}`}
                      title={`${hintNumber(min)} … ${hintNumber(max)} ${unit}`}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDryRunValues((values) => ({ ...values, [field.key]: value }));
                        setDryRunErrors((errors) => without(errors, field.key));
                        setDryRunResult(null);
                      }}
                    />
                  </FormField>
                );
              })}
              <FormField label={t('config.baseRevision')} error={fieldError(dryRunErrors.base_config_rev)}>
                <input
                  type="number"
                  inputMode="numeric"
                  value={baseRevision}
                  min={0}
                  step={1}
                  required
                  aria-required="true"
                  placeholder={reported?.baseConfigRev !== null && reported?.baseConfigRev !== undefined ? String(reported.baseConfigRev) : 'config_rev'}
                  onChange={(event) => {
                    setBaseRevision(event.target.value);
                    setDryRunErrors((errors) => without(errors, 'base_config_rev'));
                    setDryRunResult(null);
                  }}
                />
              </FormField>
            </div>
            <div className="cfg-actions">
              <button className="ov-button is-primary" type="submit" disabled={busy !== null} aria-busy={busy === 'dry-run' || undefined}>{t('config.validate')}</button>
              <ResultLine result={dryRunResult} />
            </div>
          </form>
          {dryRunData ? (
            <div className="cfg-dry-result" role="group" aria-label={t('config.dryRunResult')}>
              {resultItems.some(Boolean) ? <KeyValueGrid columns={3} labels="mono" items={resultItems} /> : null}
              <details className="cfg-json">
                <summary>JSON</summary>
                <pre>{JSON.stringify(dryRunData, null, 2)}</pre>
              </details>
            </div>
          ) : null}
        </Card>
      </PageGrid>
    </Page>
  );
}
