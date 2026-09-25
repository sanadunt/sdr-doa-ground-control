import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { Branding, CompassConfig, ConsoleConfig, GpsConfig, PolarSettings } from '../types';
import { dryRunConfigPatch, getAdminStatus, getBranding, loginAdmin, logoutAdmin, saveBranding, updateConsoleConfig } from '../api';
import { DEFAULT_FALLBACK_COORDINATE, DEFAULT_GPS_CONFIG, manualGpsOverrideFromInput } from '../lib/map';
import { DEFAULT_COMPASS_CONFIG } from '../lib/polar';
import { DEFAULT_CONSOLE_CONFIG } from '../lib/telemetry';
import { KeyValue, Metric, Panel, SectionHeading, StatusBadge } from '../components/ui';

const DRY_RUN_FIELDS = [
  { key: 'center_frequency_hz', label: 'Center frequency (Hz)', min: 24_000_000, max: 1_800_000_000, step: 1_000 },
  { key: 'gain_db', label: 'Gain (dB)', min: -100, max: 60, step: 0.5 },
  { key: 'vfo_frequency_hz', label: 'VFO frequency (Hz)', min: 24_000_000, max: 1_800_000_000, step: 1_000 },
  { key: 'vfo_bandwidth_hz', label: 'VFO bandwidth (Hz)', min: 100, max: 2_400_000, step: 100 },
  { key: 'vfo_squelch_db', label: 'VFO squelch (dB)', min: -200, max: 20, step: 0.5 },
] as const;

type Status = { tone: 'good' | 'warn' | 'bad' | 'neutral'; text: string };

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
  const [connection, setConnection] = useState<ConsoleConfig>({ ...DEFAULT_CONSOLE_CONFIG, ...config });
  const [gpsSource, setGpsSource] = useState<GpsConfig['source']>(gpsConfig.source);
  const [manualLatitude, setManualLatitude] = useState(String(gpsConfig.manualLatitude));
  const [manualLongitude, setManualLongitude] = useState(String(gpsConfig.manualLongitude));
  const [gpsStatus, setGpsStatus] = useState<Status>({ tone: 'neutral', text: 'GPS source configuration is local to this browser.' });
  const [compassSource, setCompassSource] = useState<CompassConfig['source']>(compassConfig.source);
  const [manualAxis, setManualAxis] = useState<PolarSettings['figType']>(compassConfig.manualFigType);
  const [manualOffset, setManualOffset] = useState(String(compassConfig.manualCompassOffset));
  const [compassStatus, setCompassStatus] = useState<Status>({ tone: 'neutral', text: 'Compass source configuration is local to this browser.' });
  const [connectionStatus, setConnectionStatus] = useState<Status>({ tone: 'neutral', text: 'Local values are loaded from the Ground Console.' });
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [adminStatus, setAdminStatus] = useState<Status>({ tone: 'neutral', text: 'Checking local admin session…' });
  const [brandName, setBrandName] = useState(branding.app_name);
  const [brandLogo, setBrandLogo] = useState(branding.logo_data_url);
  const [pendingLogo, setPendingLogo] = useState<string | null>(null);
  const [brandStatus, setBrandStatus] = useState<Status>({ tone: 'neutral', text: 'Branding is local and admin-protected.' });
  const [dryRunValues, setDryRunValues] = useState<Record<string, string>>({});
  const [baseRevision, setBaseRevision] = useState('');
  const [dryRunStatus, setDryRunStatus] = useState<Status>({ tone: 'neutral', text: 'Preview only. Nothing is sent to MQTT or the Raspberry.' });
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
      setAdminStatus({ tone: result.authenticated ? 'good' : 'neutral', text: result.authenticated ? 'Admin session active on this loopback console.' : 'Admin session is closed.' });
    }).catch((error: unknown) => {
      if (active) setAdminStatus({ tone: 'warn', text: error instanceof Error ? error.message : 'Admin status unavailable.' });
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
      setGpsStatus({ tone: 'bad', text: validation.error ?? 'Manual GPS must be finite, within range, and not 0,0.' });
      return;
    }
    const next: GpsConfig = {
      source: gpsSource,
      manualLatitude: validation.override?.latitude ?? DEFAULT_FALLBACK_COORDINATE.latitude,
      manualLongitude: validation.override?.longitude ?? DEFAULT_FALLBACK_COORDINATE.longitude,
    };
    onGpsConfigChanged(next);
    setGpsStatus({ tone: gpsSource === 'DATA_OUT' ? 'good' : 'warn', text: `${gpsSource === 'DATA_OUT' ? 'DATA OUT' : gpsSource} GPS source selected. Local fallback remains ${DEFAULT_FALLBACK_COORDINATE.latitude}, ${DEFAULT_FALLBACK_COORDINATE.longitude}.` });
  };

  const applyCompassConfig = () => {
    const compassOffset = Number(manualOffset);
    if (!Number.isFinite(compassOffset)) {
      setCompassStatus({ tone: 'bad', text: 'Manual Compass offset must be a finite number.' });
      return;
    }
    const next: CompassConfig = { source: compassSource, manualFigType: manualAxis, manualCompassOffset: compassOffset };
    onCompassConfigChanged(next);
    setCompassStatus({ tone: compassSource === 'DATA_OUT' ? 'good' : 'warn', text: `${compassSource === 'DATA_OUT' ? 'DATA OUT' : compassSource} Compass source selected. Renderer only; no remote setting is changed.` });
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
    setGpsStatus({ tone: 'neutral', text: 'Source defaults restored with configured fallback.' });
    setCompassStatus({ tone: 'neutral', text: 'Source defaults restored with local renderer fallback.' });
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
      setConnectionStatus({ tone: 'good', text: 'Saved locally and applied to the local read path.' });
    } catch (error: unknown) {
      setConnectionStatus({ tone: 'bad', text: error instanceof Error ? error.message : 'Connection settings were rejected.' });
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
      setAdminStatus({ tone: 'good', text: 'Admin session active on this loopback console.' });
    } catch (error: unknown) {
      setAdminStatus({ tone: 'bad', text: error instanceof Error ? error.message : 'Admin login failed.' });
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await logoutAdmin();
      setAdminAuthenticated(false);
      setAdminStatus({ tone: 'neutral', text: 'Admin session closed.' });
    } catch (error: unknown) {
      setAdminStatus({ tone: 'bad', text: error instanceof Error ? error.message : 'Admin logout failed.' });
    } finally {
      setBusy(false);
    }
  };

  const chooseLogo = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 256 * 1024 || file.type !== 'image/png') {
      setBrandStatus({ tone: 'bad', text: 'Choose a PNG logo no larger than 256 KiB.' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setPendingLogo(String(reader.result ?? ''));
      setBrandStatus({ tone: 'neutral', text: 'New local logo staged; save to persist it.' });
    };
    reader.onerror = () => setBrandStatus({ tone: 'bad', text: 'Logo could not be read.' });
    reader.readAsDataURL(file);
  };

  const persistBranding = async () => {
    setBusy(true);
    try {
      const saved = await saveBranding({ app_name: brandName.trim(), logo_data_url: selectedLogo });
      const verified = await getBranding();
      if (saved.app_name !== verified.app_name || saved.logo_data_url !== verified.logo_data_url) throw new Error('Branding read-back did not match the saved value.');
      onBrandingChanged(verified);
      setPendingLogo(null);
      setBrandStatus({ tone: 'good', text: 'Branding saved and verified with a local GET read-back.' });
    } catch (error: unknown) {
      setBrandStatus({ tone: 'bad', text: error instanceof Error ? error.message : 'Branding save failed.' });
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
      if (!Object.keys(changes).length) throw new Error('Enter at least one allowlisted field.');
      const result = await dryRunConfigPatch({
        base_config_rev: baseRevision.trim() === '' ? undefined : Number(baseRevision),
        changes,
      });
      setDryRunResult(result);
      setDryRunStatus({ tone: result.ok === true ? 'good' : 'bad', text: result.ok === true ? 'Validation passed; no transport or mutation occurred.' : String(result.error ?? 'Dry-run rejected.') });
    } catch (error: unknown) {
      setDryRunStatus({ tone: 'bad', text: error instanceof Error ? error.message : 'Dry-run failed.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page configuration-page">
      <SectionHeading eyebrow="LOCAL CONTROL / CONFIG" title="Configuration" detail="This workspace changes only Ground Console local state. Remote settings, service control, and MQTT publish remain unavailable." />
      <nav className="config-index" aria-label="Configuration sections">
        <button type="button" aria-controls="connection-settings" onClick={() => document.getElementById('connection-settings')?.scrollIntoView({ block: 'start' })}>Connection</button>
        <button type="button" aria-controls="branding-settings" onClick={() => document.getElementById('branding-settings')?.scrollIntoView({ block: 'start' })}>Branding</button>
        <button type="button" aria-controls="dry-run-settings" onClick={() => document.getElementById('dry-run-settings')?.scrollIntoView({ block: 'start' })}>Dry-run preview</button>
        <button type="button" aria-controls="navigation-settings" onClick={() => document.getElementById('navigation-settings')?.scrollIntoView({ block: 'start' })}>GPS + Compass</button>
      </nav>
      <div className="config-grid">
        <Panel className="connection-panel" eyebrow="LOCAL SETTINGS" title={<span id="connection-settings" className="config-index-target">Connection and refresh</span>}>
          <div className="form-grid">
            <Field label="Data Out base URL" value={connection.base_url} onChange={(value) => setConnection({ ...connection, base_url: value })} help="Validated by the existing local allowlist." />
            <Field label="MQTT monitor host" value={connection.mqtt_host} onChange={(value) => setConnection({ ...connection, mqtt_host: value })} help="Optional loopback subscriber; blank keeps it OFF." />
            <Field label="MQTT port" type="number" value={connection.mqtt_port} min={1} max={65535} onChange={(value) => setConnection({ ...connection, mqtt_port: Number(value) })} />
            <label className="form-field"><span>Refresh interval</span><select value={connection.refresh_seconds} onChange={(event) => setConnection({ ...connection, refresh_seconds: Number(event.target.value) })}><option value={0}>Manual only</option><option value={5}>Every 5 seconds</option><option value={10}>Every 10 seconds</option><option value={30}>Every 30 seconds</option></select><small>Every read has a finite request deadline.</small></label>
          </div>
          <div className="form-actions"><button className="primary-button" type="button" disabled={busy} onClick={applyConnection}>Save local connection</button><span className={`form-status status-text-${connectionStatus.tone}`}>{connectionStatus.text}</span></div>
          <div className="dry-run-notice"><strong>.env</strong> is read by Python at startup only; the browser does not read or expose its values. Restart the local Python console after changing it.</div>
        </Panel>
        <Panel className="admin-panel" eyebrow="LOCAL ADMIN" title={<span id="branding-settings" className="config-index-target">Branding workspace</span>} action={<StatusBadge label={adminAuthenticated ? 'AUTHENTICATED' : 'LOCKED'} tone={adminAuthenticated ? 'good' : 'warn'} />}>
          <p>Saved app name also controls this browser tab title.</p>
          {!adminAuthenticated ? <div className="admin-login-form"><p>Admin authentication unlocks local app name and PNG branding only.</p><Field label="Admin password" type="password" value={password} onChange={setPassword} help="Password is submitted to the local console and never displayed." /><button className="primary-button" type="button" disabled={busy || !password} onClick={signIn}>Unlock local branding</button></div> : <div className="branding-workspace"><div className="branding-preview">{selectedLogo ? <img src={selectedLogo} alt="Local branding preview" /> : <span>NO LOGO</span>}</div><Field label="App name" value={brandName} onChange={setBrandName} /><label className="form-field"><span>PNG logo</span><input type="file" accept="image/png" onChange={(event) => chooseLogo(event.target.files?.[0])} /><small>Maximum 256 KiB. Browser-local staging until save.</small></label><div className="form-actions"><button className="primary-button" type="button" disabled={busy} onClick={persistBranding}>Save and verify</button><button className="secondary-button" type="button" disabled={busy} onClick={() => { setPendingLogo(''); setBrandStatus({ tone: 'neutral', text: 'Logo removal staged; save to persist it.' }); }}>Reset logo</button><button className="text-button" type="button" disabled={busy} onClick={signOut}>Close admin session</button></div></div>}
          <div className={`form-status status-text-${adminStatus.tone}`}>{adminStatus.text}</div><div className={`form-status status-text-${brandStatus.tone}`}>{brandStatus.text}</div>
        </Panel>
        <Panel className="dry-run-panel" eyebrow="DRY-RUN / NO TRANSPORT" title={<span id="dry-run-settings" className="config-index-target">Configuration patch preview</span>} action={<StatusBadge label="PREVIEW ONLY" tone="neutral" />}>
          <div className="dry-run-notice">The allowlist and ranges are enforced by Python. This form creates a validation preview only; it does not publish, POST remotely, write Raspberry files, or restart services.</div>
          <div className="form-grid dry-run-fields">{DRY_RUN_FIELDS.map((field) => <Field key={field.key} label={field.label} type="number" value={dryRunValues[field.key] ?? ''} min={field.min} max={field.max} step={field.step} onChange={(value) => setDryRunValues({ ...dryRunValues, [field.key]: value })} />)}</div>
          <Field label="Base config revision (optional)" type="number" value={baseRevision} min={0} step={1} onChange={setBaseRevision} help="Must be a non-negative integer when supplied." />
          <div className="form-actions"><button className="primary-button" type="button" disabled={busy} onClick={runDryRun}>Validate dry-run patch</button><span className={`form-status status-text-${dryRunStatus.tone}`}>{dryRunStatus.text}</span></div>
          {dryRunResult ? <pre className="result-box" aria-label="Dry-run result">{JSON.stringify(dryRunResult, null, 2)}</pre> : null}
        </Panel>
      </div>
      <Panel className="manual-test-panel" eyebrow="NAVIGATION / DISPLAY SOURCE" title={<span id="navigation-settings" className="config-index-target">GPS + Compass configuration</span>} action={<StatusBadge label="LOCAL CONFIG" tone="neutral" />}>
        <div className="manual-test-notice">
          Pilih sumber data tanpa mengubah Raspberry atau MQTT. Default source adalah Data Out; bila data GPS/Compass belum valid, console memakai fallback lokal yang ditampilkan eksplisit.
        </div>
        <div className="manual-test-grid">
          <div className="manual-test-block">
            <div className="manual-test-block-title">GPS / OSM station position</div>
            <p>Data Out memakai koordinat fresh. MANUAL memakai input ini. FALLBACK selalu memakai station default <strong>{DEFAULT_FALLBACK_COORDINATE.latitude}, {DEFAULT_FALLBACK_COORDINATE.longitude}</strong>.</p>
            <div className="form-grid manual-test-fields">
              <label className="form-field"><span>GPS source</span><select value={gpsSource} onChange={(event) => setGpsSource(event.target.value as GpsConfig['source'])}><option value="DATA_OUT">Data Out</option><option value="MANUAL">Manual input</option><option value="FALLBACK">Default fallback</option></select><small>Data Out falls back automatically when its coordinate gate is unavailable.</small></label>
              <Field label="Manual latitude (−90 to 90)" type="number" value={manualLatitude} min={-90} max={90} step={0.00001} onChange={setManualLatitude} />
              <Field label="Manual longitude (−180 to 180)" type="number" value={manualLongitude} min={-180} max={180} step={0.00001} onChange={setManualLongitude} />
            </div>
            <div className="form-actions compact">
              <button className="primary-button" type="button" onClick={applyGpsConfig}>Apply GPS source</button>
              <button className="secondary-button" type="button" onClick={restoreSourceDefaults}>Restore defaults</button>
              <span className={`form-status status-text-${gpsStatus.tone}`}>{gpsStatus.text}</span>
            </div>
          </div>
          <div className="manual-test-block">
            <div className="manual-test-block-title">Compass / Polar display axis</div>
            <p>Data Out reads <code>doa_fig_type</code> and <code>compass_offset</code> from settings. MANUAL/FALLBACK affect only the local renderer; no 360-bin vector is synthesized.</p>
            <div className="form-grid manual-test-fields">
              <label className="form-field"><span>Compass source</span><select value={compassSource} onChange={(event) => setCompassSource(event.target.value as CompassConfig['source'])}><option value="DATA_OUT">Data Out</option><option value="MANUAL">Manual input</option><option value="FALLBACK">Default fallback</option></select><small>Local renderer settings are used for the Polar view.</small></label>
              <label className="form-field"><span>Manual axis</span><select value={manualAxis} onChange={(event) => setManualAxis(event.target.value === 'Polar' ? 'Polar' : 'Compass')}><option value="Compass">Compass</option><option value="Polar">Polar</option></select><small>Compass applies 360° − bin + offset.</small></label>
              <Field label="Manual offset (degrees)" type="number" value={manualOffset} step={0.1} onChange={setManualOffset} help="Finite values are normalized for display." />
            </div>
            <div className="form-actions compact">
              <button className="primary-button" type="button" onClick={applyCompassConfig}>Apply Compass source</button>
              <button className="secondary-button" type="button" onClick={restoreSourceDefaults}>Restore defaults</button>
              <span className={`form-status status-text-${compassStatus.tone}`}>{compassStatus.text}</span>
            </div>
          </div>
        </div>
      </Panel>
      <div className="config-guard-row"><Metric label="Remote writes" value="DISABLED" detail="Existing API security preserved" tone="good" /><Metric label="MQTT publish" value="DISABLED" detail="Subscriber-only monitor" tone="good" /><Metric label="Secret handling" value="SERVER ONLY" detail="Python reads .env at startup; the browser never receives secret values." tone="good" /><KeyValue label="Admin session" value={adminAuthenticated ? 'LOCAL / ACTIVE' : 'CLOSED'} detail="HttpOnly SameSite cookie" /></div>
    </div>
  );
}
