import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { Branding, CompassConfig, ConsoleConfig, GpsConfig, PolarSettings } from '../types';
import { dryRunConfigPatch, getAdminStatus, getBranding, loginAdmin, logoutAdmin, saveBranding, updateConsoleConfig } from '../api';
import { DEFAULT_FALLBACK_COORDINATE, DEFAULT_GPS_CONFIG, manualGpsOverrideFromInput } from '../lib/map';
import { DEFAULT_COMPASS_CONFIG } from '../lib/polar';
import { DEFAULT_CONSOLE_CONFIG } from '../lib/telemetry';
import { useI18n } from '../lib/i18n';
import type { MessageKey, Translate } from '../lib/i18n';
import { KeyValue, Metric, Panel, SectionHeading, StatusBadge } from '../components/ui';

const DRY_RUN_FIELDS = [
  { key: 'center_frequency_hz', label: 'config.field.center', min: 24_000_000, max: 1_800_000_000, step: 1_000 },
  { key: 'gain_db', label: 'config.field.gain', min: -100, max: 60, step: 0.5 },
  { key: 'vfo_frequency_hz', label: 'config.field.vfo', min: 24_000_000, max: 1_800_000_000, step: 1_000 },
  { key: 'vfo_bandwidth_hz', label: 'config.field.bandwidth', min: 100, max: 2_400_000, step: 100 },
  { key: 'vfo_squelch_db', label: 'config.field.squelch', min: -200, max: 20, step: 0.5 },
] as const satisfies ReadonlyArray<{ key: string; label: MessageKey; min: number; max: number; step: number }>;

type Tone = 'good' | 'warn' | 'bad' | 'neutral';
// Local messages keep their key so they follow a language switch; server and
// validation errors arrive as text and are shown as received.
type Status = { tone: Tone; key: MessageKey; vars?: Record<string, string | number> } | { tone: Tone; text: string };

function statusText(status: Status, t: Translate): string {
  return 'key' in status ? t(status.key, status.vars) : status.text;
}

function errorStatus(error: unknown, fallback: MessageKey): Status {
  return error instanceof Error && error.message ? { tone: 'bad', text: error.message } : { tone: 'bad', key: fallback };
}

function Field({ label, value, onChange, type = 'text', min, max, step, help }: { label: string; value: string | number; onChange: (value: string) => void; type?: string; min?: number; max?: number; step?: number; help?: string }): JSX.Element {
  return <label className="form-field"><span>{label}</span><input type={type} value={value} min={min} max={max} step={step} onChange={(event) => onChange(event.target.value)} />{help ? <small>{help}</small> : null}</label>;
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
  const { t } = useI18n();
  const [connection, setConnection] = useState<ConsoleConfig>({ ...DEFAULT_CONSOLE_CONFIG, ...config });
  const [gpsSource, setGpsSource] = useState<GpsConfig['source']>(gpsConfig.source);
  const [manualLatitude, setManualLatitude] = useState(String(gpsConfig.manualLatitude));
  const [manualLongitude, setManualLongitude] = useState(String(gpsConfig.manualLongitude));
  const [gpsStatus, setGpsStatus] = useState<Status>({ tone: 'neutral', key: 'config.gpsLocal' });
  const [compassSource, setCompassSource] = useState<CompassConfig['source']>(compassConfig.source);
  const [manualAxis, setManualAxis] = useState<PolarSettings['figType']>(compassConfig.manualFigType);
  const [manualOffset, setManualOffset] = useState(String(compassConfig.manualCompassOffset));
  const [compassStatus, setCompassStatus] = useState<Status>({ tone: 'neutral', key: 'config.compassLocal' });
  const [connectionStatus, setConnectionStatus] = useState<Status>({ tone: 'neutral', key: 'config.connectionLoaded' });
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [adminStatus, setAdminStatus] = useState<Status>({ tone: 'neutral', key: 'config.adminChecking' });
  const [brandName, setBrandName] = useState(branding.app_name);
  const [brandLogo, setBrandLogo] = useState(branding.logo_data_url);
  const [pendingLogo, setPendingLogo] = useState<string | null>(null);
  const [brandStatus, setBrandStatus] = useState<Status>({ tone: 'neutral', key: 'config.brandingLocal' });
  const [dryRunValues, setDryRunValues] = useState<Record<string, string>>({});
  const [baseRevision, setBaseRevision] = useState('');
  const [dryRunStatus, setDryRunStatus] = useState<Status>({ tone: 'neutral', key: 'config.dryRunIdle' });
  const [dryRunResult, setDryRunResult] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setConnection({ ...DEFAULT_CONSOLE_CONFIG, ...config });
  }, [config]);
  useEffect(() => {
    setBrandName(branding.app_name);
    setBrandLogo(branding.logo_data_url);
    setPendingLogo(null);
  }, [branding]);
  useEffect(() => {
    let active = true;
    getAdminStatus().then((result) => {
      if (!active) return;
      setAdminAuthenticated(result.authenticated);
      setAdminStatus({ tone: result.authenticated ? 'good' : 'neutral', key: result.authenticated ? 'config.adminActive' : 'config.adminClosed' });
    }).catch((error: unknown) => {
      if (active) setAdminStatus(error instanceof Error && error.message ? { tone: 'warn', text: error.message } : { tone: 'warn', key: 'config.adminUnavailable' });
    });
    return () => { active = false; };
  }, []);

  const selectedLogo = useMemo(() => pendingLogo === null ? brandLogo : pendingLogo, [brandLogo, pendingLogo]);

  useEffect(() => {
    setGpsSource(gpsConfig.source);
    setManualLatitude(String(gpsConfig.manualLatitude));
    setManualLongitude(String(gpsConfig.manualLongitude));
  }, [gpsConfig]);

  useEffect(() => {
    setCompassSource(compassConfig.source);
    setManualAxis(compassConfig.manualFigType);
    setManualOffset(String(compassConfig.manualCompassOffset));
  }, [compassConfig]);

  const applyGpsConfig = () => {
    const validation = manualGpsOverrideFromInput(manualLatitude, manualLongitude);
    if (gpsSource === 'MANUAL' && !validation.override) {
      setGpsStatus(validation.error ? { tone: 'bad', text: validation.error } : { tone: 'bad', key: 'config.gpsInvalid' });
      return;
    }
    const next: GpsConfig = {
      source: gpsSource,
      manualLatitude: validation.override?.latitude ?? DEFAULT_FALLBACK_COORDINATE.latitude,
      manualLongitude: validation.override?.longitude ?? DEFAULT_FALLBACK_COORDINATE.longitude,
    };
    onGpsConfigChanged(next);
    setGpsStatus({ tone: gpsSource === 'DATA_OUT' ? 'good' : 'warn', key: 'config.gpsApplied', vars: { source: gpsSource === 'DATA_OUT' ? 'DATA OUT' : gpsSource, lat: DEFAULT_FALLBACK_COORDINATE.latitude, lon: DEFAULT_FALLBACK_COORDINATE.longitude } });
  };

  const applyCompassConfig = () => {
    const compassOffset = Number(manualOffset);
    if (!Number.isFinite(compassOffset)) {
      setCompassStatus({ tone: 'bad', key: 'config.compassInvalid' });
      return;
    }
    const next: CompassConfig = { source: compassSource, manualFigType: manualAxis, manualCompassOffset: compassOffset };
    onCompassConfigChanged(next);
    setCompassStatus({ tone: compassSource === 'DATA_OUT' ? 'good' : 'warn', key: 'config.compassApplied', vars: { source: compassSource === 'DATA_OUT' ? 'DATA OUT' : compassSource } });
  };

  const restoreSourceDefaults = () => {
    onGpsConfigChanged(DEFAULT_GPS_CONFIG);
    onCompassConfigChanged(DEFAULT_COMPASS_CONFIG);
    setGpsSource(DEFAULT_GPS_CONFIG.source);
    setManualLatitude(String(DEFAULT_GPS_CONFIG.manualLatitude));
    setManualLongitude(String(DEFAULT_GPS_CONFIG.manualLongitude));
    setCompassSource(DEFAULT_COMPASS_CONFIG.source);
    setManualAxis(DEFAULT_COMPASS_CONFIG.manualFigType);
    setManualOffset(String(DEFAULT_COMPASS_CONFIG.manualCompassOffset));
    setGpsStatus({ tone: 'neutral', key: 'config.defaultsGps' });
    setCompassStatus({ tone: 'neutral', key: 'config.defaultsCompass' });
  };

  const applyConnection = async () => {
    setBusy(true);
    try {
      const normalized = await updateConsoleConfig({
        ...connection,
        mqtt_port: Number(connection.mqtt_port),
        refresh_seconds: Number(connection.refresh_seconds),
      });
      await onConfigSaved(normalized);
      setConnection(normalized);
      setConnectionStatus({ tone: 'good', key: 'config.connectionSaved' });
    } catch (error: unknown) {
      setConnectionStatus(errorStatus(error, 'config.connectionRejected'));
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    setBusy(true);
    try {
      await loginAdmin(password);
      setPassword('');
      setAdminAuthenticated(true);
      setAdminStatus({ tone: 'good', key: 'config.adminActive' });
    } catch (error: unknown) {
      setAdminStatus(errorStatus(error, 'config.loginFailed'));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await logoutAdmin();
      setAdminAuthenticated(false);
      setAdminStatus({ tone: 'neutral', key: 'config.adminClosed' });
    } catch (error: unknown) {
      setAdminStatus(errorStatus(error, 'config.logoutFailed'));
    } finally {
      setBusy(false);
    }
  };

  const chooseLogo = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 256 * 1024 || file.type !== 'image/png') {
      setBrandStatus({ tone: 'bad', key: 'config.logoInvalid' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setPendingLogo(String(reader.result ?? ''));
      setBrandStatus({ tone: 'neutral', key: 'config.logoStaged' });
    };
    reader.onerror = () => setBrandStatus({ tone: 'bad', key: 'config.logoReadFailed' });
    reader.readAsDataURL(file);
  };

  const persistBranding = async () => {
    setBusy(true);
    try {
      const saved = await saveBranding({ app_name: brandName.trim(), logo_data_url: selectedLogo });
      const verified = await getBranding();
      if (saved.app_name !== verified.app_name || saved.logo_data_url !== verified.logo_data_url) throw new Error(t('config.readbackMismatch'));
      onBrandingChanged(verified);
      setPendingLogo(null);
      setBrandStatus({ tone: 'good', key: 'config.brandingSaved' });
    } catch (error: unknown) {
      setBrandStatus(errorStatus(error, 'config.brandingFailed'));
    } finally {
      setBusy(false);
    }
  };

  const runDryRun = async () => {
    setBusy(true);
    setDryRunResult(null);
    try {
      const changes: Record<string, number> = {};
      for (const field of DRY_RUN_FIELDS) {
        const raw = dryRunValues[field.key];
        if (raw !== undefined && raw !== '') changes[field.key] = Number(raw);
      }
      if (!Object.keys(changes).length) throw new Error(t('config.dryRunEmpty'));
      const result = await dryRunConfigPatch({
        base_config_rev: baseRevision.trim() === '' ? undefined : Number(baseRevision),
        changes,
      });
      setDryRunResult(result);
      setDryRunStatus(result.ok === true ? { tone: 'good', key: 'config.dryRunPassed' } : result.error ? { tone: 'bad', text: String(result.error) } : { tone: 'bad', key: 'config.dryRunRejected' });
    } catch (error: unknown) {
      setDryRunStatus(errorStatus(error, 'config.dryRunFailed'));
    } finally {
      setBusy(false);
    }
  };

  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ block: 'start' });
  const statusLine = (status: Status) => <span className={`form-status status-text-${status.tone}`}>{statusText(status, t)}</span>;

  return (
    <div className="page configuration-page">
      <SectionHeading eyebrow={t('config.eyebrow')} title={t('config.title')} detail={t('config.detail')} />
      <nav className="config-index" aria-label={t('config.sections')}>
        <button type="button" aria-controls="connection-settings" onClick={() => scrollTo('connection-settings')}>{t('config.nav.connection')}</button>
        <button type="button" aria-controls="branding-settings" onClick={() => scrollTo('branding-settings')}>{t('config.nav.branding')}</button>
        <button type="button" aria-controls="dry-run-settings" onClick={() => scrollTo('dry-run-settings')}>{t('config.nav.dryRun')}</button>
        <button type="button" aria-controls="navigation-settings" onClick={() => scrollTo('navigation-settings')}>{t('config.nav.navigation')}</button>
      </nav>
      <div className="config-grid">
        <Panel className="connection-panel" eyebrow={t('config.connectionEyebrow')} title={<span id="connection-settings" className="config-index-target">{t('config.connectionTitle')}</span>}>
          <div className="form-grid">
            <Field label={t('config.baseUrl')} value={connection.base_url} onChange={(value) => setConnection({ ...connection, base_url: value })} help={t('config.baseUrlHelp')} />
            <Field label={t('config.mqttHost')} value={connection.mqtt_host} onChange={(value) => setConnection({ ...connection, mqtt_host: value })} help={t('config.mqttHostHelp')} />
            <Field label={t('config.mqttPort')} type="number" value={connection.mqtt_port} min={1} max={65535} onChange={(value) => setConnection({ ...connection, mqtt_port: Number(value) })} />
            <label className="form-field"><span>{t('config.refresh')}</span><select value={connection.refresh_seconds} onChange={(event) => setConnection({ ...connection, refresh_seconds: Number(event.target.value) })}><option value={0}>{t('config.refreshManual')}</option><option value={5}>{t('config.refreshEvery', { s: 5 })}</option><option value={10}>{t('config.refreshEvery', { s: 10 })}</option><option value={30}>{t('config.refreshEvery', { s: 30 })}</option></select><small>{t('config.refreshHelp')}</small></label>
          </div>
          <div className="form-actions"><button className="primary-button" type="button" disabled={busy} onClick={applyConnection}>{t('config.saveConnection')}</button>{statusLine(connectionStatus)}</div>
          <div className="dry-run-notice"><strong>.env</strong> {t('config.envNote')}</div>
        </Panel>
        <Panel className="admin-panel" eyebrow={t('config.adminEyebrow')} title={<span id="branding-settings" className="config-index-target">{t('config.brandingTitle')}</span>} action={<StatusBadge label={adminAuthenticated ? t('config.authenticated') : t('config.locked')} tone={adminAuthenticated ? 'good' : 'warn'} />}>
          <p className="admin-note">{t('config.tabTitleNote')}</p>
          {!adminAuthenticated ? <div className="admin-login-form"><p>{t('config.adminNote')}</p><Field label={t('config.password')} type="password" value={password} onChange={setPassword} help={t('config.passwordHelp')} /><button className="primary-button" type="button" disabled={busy || !password} onClick={signIn}>{t('config.unlock')}</button></div> : <div className="branding-workspace"><div className="branding-preview">{selectedLogo ? <img src={selectedLogo} alt={t('config.logoPreview')} /> : <span>{t('config.noLogo')}</span>}</div><Field label={t('config.appName')} value={brandName} onChange={setBrandName} /><label className="form-field"><span>{t('config.logo')}</span><input type="file" accept="image/png" onChange={(event) => chooseLogo(event.target.files?.[0])} /><small>{t('config.logoHelp')}</small></label><div className="form-actions"><button className="primary-button" type="button" disabled={busy} onClick={persistBranding}>{t('config.saveVerify')}</button><button className="secondary-button" type="button" disabled={busy} onClick={() => { setPendingLogo(''); setBrandStatus({ tone: 'neutral', key: 'config.logoRemoval' }); }}>{t('config.resetLogo')}</button><button className="text-button" type="button" disabled={busy} onClick={signOut}>{t('config.closeAdmin')}</button></div></div>}
          <div className={`form-status status-text-${adminStatus.tone}`}>{statusText(adminStatus, t)}</div><div className={`form-status status-text-${brandStatus.tone}`}>{statusText(brandStatus, t)}</div>
        </Panel>
        <Panel className="dry-run-panel" eyebrow={t('config.dryRunEyebrow')} title={<span id="dry-run-settings" className="config-index-target">{t('config.dryRunTitle')}</span>} action={<StatusBadge label={t('config.previewOnly')} tone="neutral" />}>
          <div className="dry-run-notice">{t('config.dryRunNote')}</div>
          <div className="form-grid dry-run-fields">{DRY_RUN_FIELDS.map((field) => <Field key={field.key} label={t(field.label)} type="number" value={dryRunValues[field.key] ?? ''} min={field.min} max={field.max} step={field.step} onChange={(value) => setDryRunValues({ ...dryRunValues, [field.key]: value })} />)}</div>
          <Field label={t('config.baseRevision')} type="number" value={baseRevision} min={0} step={1} onChange={setBaseRevision} help={t('config.baseRevisionHelp')} />
          <div className="form-actions"><button className="primary-button" type="button" disabled={busy} onClick={runDryRun}>{t('config.validate')}</button>{statusLine(dryRunStatus)}</div>
          {dryRunResult ? <pre className="result-box" aria-label={t('config.dryRunResult')}>{JSON.stringify(dryRunResult, null, 2)}</pre> : null}
        </Panel>
      </div>
      <Panel className="manual-test-panel" eyebrow={t('config.navEyebrow')} title={<span id="navigation-settings" className="config-index-target">{t('config.navTitle')}</span>} action={<StatusBadge label={t('config.localConfig')} tone="neutral" />}>
        <div className="manual-test-notice">{t('config.navNote')}</div>
        <div className="manual-test-grid">
          <div className="manual-test-block">
            <div className="manual-test-block-title">{t('config.gpsTitle')}</div>
            <p>{t('config.gpsNote')} <strong>{DEFAULT_FALLBACK_COORDINATE.latitude}, {DEFAULT_FALLBACK_COORDINATE.longitude}</strong>.</p>
            <div className="form-grid manual-test-fields">
              <label className="form-field"><span>{t('config.gpsSource')}</span><select value={gpsSource} onChange={(event) => setGpsSource(event.target.value as GpsConfig['source'])}><option value="DATA_OUT">{t('config.sourceDataOut')}</option><option value="MANUAL">{t('config.sourceManual')}</option><option value="FALLBACK">{t('config.sourceFallback')}</option></select><small>{t('config.gpsSourceHelp')}</small></label>
              <Field label={t('config.manualLat')} type="number" value={manualLatitude} min={-90} max={90} step={0.00001} onChange={setManualLatitude} />
              <Field label={t('config.manualLon')} type="number" value={manualLongitude} min={-180} max={180} step={0.00001} onChange={setManualLongitude} />
            </div>
            <div className="form-actions compact">
              <button className="primary-button" type="button" onClick={applyGpsConfig}>{t('config.applyGps')}</button>
              <button className="secondary-button" type="button" onClick={restoreSourceDefaults}>{t('config.restoreDefaults')}</button>
              {statusLine(gpsStatus)}
            </div>
          </div>
          <div className="manual-test-block">
            <div className="manual-test-block-title">{t('config.compassTitle')}</div>
            <p>{t('config.compassNote')}</p>
            <div className="form-grid manual-test-fields">
              <label className="form-field"><span>{t('config.compassSource')}</span><select value={compassSource} onChange={(event) => setCompassSource(event.target.value as CompassConfig['source'])}><option value="DATA_OUT">{t('config.sourceDataOut')}</option><option value="MANUAL">{t('config.sourceManual')}</option><option value="FALLBACK">{t('config.sourceFallback')}</option></select><small>{t('config.compassSourceHelp')}</small></label>
              <label className="form-field"><span>{t('config.manualAxis')}</span><select value={manualAxis} onChange={(event) => setManualAxis(event.target.value === 'Polar' ? 'Polar' : 'Compass')}><option value="Compass">Compass</option><option value="Polar">Polar</option></select><small>{t('config.manualAxisHelp')}</small></label>
              <Field label={t('config.manualOffset')} type="number" value={manualOffset} step={0.1} onChange={setManualOffset} help={t('config.manualOffsetHelp')} />
            </div>
            <div className="form-actions compact">
              <button className="primary-button" type="button" onClick={applyCompassConfig}>{t('config.applyCompass')}</button>
              <button className="secondary-button" type="button" onClick={restoreSourceDefaults}>{t('config.restoreDefaults')}</button>
              {statusLine(compassStatus)}
            </div>
          </div>
        </div>
      </Panel>
      <div className="config-guard-row"><Metric label={t('config.remoteWrites')} value={t('config.disabled')} detail={t('config.remoteWritesDetail')} tone="good" /><Metric label={t('config.mqttPublish')} value={t('config.disabled')} detail={t('config.mqttPublishDetail')} tone="good" /><Metric label={t('config.secrets')} value={t('config.secretsValue')} detail={t('config.secretsDetail')} tone="good" /><Metric label={t('config.adminSession')} value={adminAuthenticated ? t('config.adminSessionActive') : t('config.adminSessionClosed')} detail={t('config.cookieDetail')} tone={adminAuthenticated ? 'warn' : 'good'} /></div>
    </div>
  );
}
