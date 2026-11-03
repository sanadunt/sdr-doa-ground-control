import { useEffect, useId, useState } from 'react';
import type { JSX } from 'react';
import { fetchWithTimeout, getDrone } from '../api';
import { normalizeDrone } from '../lib/droneLink';
import type { DroneView } from '../lib/droneLink';
import { useI18n } from '../lib/i18n';
import { Card, FormField, KeyValueGrid, Segmented, StatusChip, Switch } from './page';

/** The drone block of console.json as /api/console-config shows it. */
export interface DroneSettings {
  enabled: boolean;
  host: string;
  port: number;
  array_heading_offset_deg: number;
  video_enabled: boolean;
  last_host: string | null;
}

export const DEFAULT_DRONE_SETTINGS: DroneSettings = {
  enabled: true,
  host: 'auto',
  port: 1883,
  array_heading_offset_deg: 0,
  video_enabled: true,
  last_host: null,
};

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u;

/** Read the drone block leniently; any bad field keeps its default. */
export function normalizeDroneSettings(value: unknown): DroneSettings {
  const input = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const port = input.port;
  const offset = input.array_heading_offset_deg;
  return {
    enabled: input.enabled !== false,
    host: typeof input.host === 'string' && input.host.trim() ? input.host.trim() : 'auto',
    port: typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 1883,
    array_heading_offset_deg: typeof offset === 'number' && Number.isFinite(offset) && Math.abs(offset) <= 180 ? offset : 0,
    video_enabled: input.video_enabled !== false,
    last_host: typeof input.last_host === 'string' ? input.last_host : null,
  };
}

/** A host the console accepts: auto, an IPv4 address, or an IPv6 literal (checked again by the server). */
export function droneHostValid(host: string): boolean {
  const value = host.trim();
  return value === 'auto' || IPV4.test(value) || (value.includes(':') && /^[0-9a-fA-F:.]+$/u.test(value));
}

export function droneConnectionTone(view: DroneView | null): 'good' | 'warn' | 'bad' | 'neutral' {
  if (!view || view.state === 'DISABLED') return 'neutral';
  if (view.connection === 'connected' && view.state === 'LIVE') return 'good';
  if (view.connection === 'error') return 'bad';
  return 'warn';
}

export function droneConnectionCode(view: DroneView | null): string {
  if (!view) return 'N/A';
  if (view.state === 'DISABLED') return 'OFF';
  if (view.connection === 'searching' || view.scanning) return 'SEARCHING';
  if (view.connection !== 'connected') return view.connection.toUpperCase();
  return view.state;
}

/**
 * Configuration → Drone: the SIYI remote's broker (found on the LAN, or a
 * fixed address), the array's turn against the drone's nose, and the video.
 * Saved to console.json through POST /api/console-config; the LAN view shows it read only.
 */
export function DroneSettingsCard({ readOnly = false, initial = null, initialView = null }: {
  readOnly?: boolean;
  /** The first state, for a static render; the card reads the console itself otherwise. */
  initial?: DroneSettings | null;
  initialView?: DroneView | null;
}): JSX.Element {
  const { t } = useI18n();
  const ids = useId();
  const [saved, setSaved] = useState<DroneSettings>(initial ?? DEFAULT_DRONE_SETTINGS);
  const [draft, setDraft] = useState<DroneSettings>(initial ?? DEFAULT_DRONE_SETTINGS);
  const [view, setView] = useState<DroneView | null>(initialView);
  const [result, setResult] = useState<{ code: string; tone: 'good' | 'bad'; text?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initial) return undefined;
    const controller = new AbortController();
    void fetchWithTimeout('/api/console-config', { cache: 'no-store', signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        const block = body !== null && typeof body === 'object' ? (body as Record<string, unknown>).drone : undefined;
        const settings = normalizeDroneSettings(block);
        setSaved(settings);
        setDraft(settings);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [initial]);

  useEffect(() => {
    if (initialView) return undefined;
    let stopped = false;
    let timer = 0;
    const read = async () => {
      try {
        const next = normalizeDrone(await getDrone());
        if (!stopped) setView(next);
      } catch {
        // The next read tries again.
      }
      if (!stopped) timer = window.setTimeout(() => { void read(); }, 3_000);
    };
    void read();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [initialView]);

  const hostMode = draft.host === 'auto' ? 'auto' : 'fixed';
  const hostOk = droneHostValid(draft.host);
  const offsetOk = Number.isFinite(draft.array_heading_offset_deg) && Math.abs(draft.array_heading_offset_deg) <= 180;
  const dirty = JSON.stringify({ ...draft, last_host: null }) !== JSON.stringify({ ...saved, last_host: null });

  const save = async () => {
    if (!hostOk || !offsetOk) return;
    setBusy(true);
    setResult(null);
    try {
      const { last_host: _ignored, ...payload } = draft;
      const response = await fetchWithTimeout('/api/console-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drone: { ...payload, host: payload.host.trim() } }),
      });
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) {
        setResult({ code: 'REFUSED', tone: 'bad', text: typeof body?.error === 'string' ? body.error : undefined });
        return;
      }
      const next = normalizeDroneSettings(body?.drone);
      setSaved(next);
      setDraft(next);
      setResult({ code: 'SAVED', tone: 'good' });
    } catch {
      setResult({ code: 'NETWORK', tone: 'bad' });
    } finally {
      setBusy(false);
    }
  };

  const statusItems = [
    { id: 'connection', label: t('drone.cfg.connection'), value: droneConnectionCode(view) },
    { id: 'host', label: t('drone.cfg.remote'), value: view?.host ? `${view.host}:${view.port ?? draft.port}` : '—' },
    { id: 'found', label: t('drone.cfg.lastFound'), value: saved.last_host ?? '—' },
    { id: 'bridge', label: t('drone.cfg.bridge'), value: view?.link?.version ? `v${view.link.version}` : '—' },
  ];

  return (
    <Card id="drone-settings" className="cfg-section" title={t('drone.cfg.title')} chip={<StatusChip code={droneConnectionCode(view)} tone={droneConnectionTone(view)} />}>
      <form className="cfg-sub" noValidate aria-labelledby={`${ids}-drone`} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <h3 id={`${ids}-drone`} className="visually-hidden">{t('drone.cfg.title')}</h3>
        <Switch checked={draft.enabled} disabled={readOnly} label={t('drone.cfg.enabled')} onChange={(enabled) => { setDraft({ ...draft, enabled }); setResult(null); }} />
        <Segmented
          label={t('drone.cfg.hostMode')}
          disabled={readOnly}
          options={[{ value: 'auto' as const, label: t('drone.cfg.auto') }, { value: 'fixed' as const, label: t('drone.cfg.fixed') }]}
          value={hostMode}
          onChange={(mode) => { setDraft({ ...draft, host: mode === 'auto' ? 'auto' : (saved.last_host ?? '') }); setResult(null); }}
        />
        <div className="cfg-pair">
          <FormField mono label={t('drone.cfg.host')} error={hostOk ? undefined : t('drone.cfg.hostInvalid')}>
            <input type="text" inputMode="decimal" value={hostMode === 'auto' ? '' : draft.host} placeholder={hostMode === 'auto' ? t('drone.cfg.auto') : '192.168.1.162'} disabled={readOnly || hostMode === 'auto'} onChange={(event) => { setDraft({ ...draft, host: event.target.value }); setResult(null); }} />
          </FormField>
          <FormField label={t('drone.cfg.offset')} unit="°" error={offsetOk ? undefined : t('drone.cfg.offsetInvalid')}>
            <input type="number" inputMode="decimal" min={-180} max={180} step={0.1} value={String(draft.array_heading_offset_deg)} disabled={readOnly} onChange={(event) => { setDraft({ ...draft, array_heading_offset_deg: event.target.value.trim() === '' ? Number.NaN : Number(event.target.value) }); setResult(null); }} />
          </FormField>
        </div>
        <Switch checked={draft.video_enabled} disabled={readOnly} label={t('drone.cfg.video')} onChange={(video_enabled) => { setDraft({ ...draft, video_enabled }); setResult(null); }} />
        <KeyValueGrid items={statusItems} label={t('drone.cfg.title')} />
        {readOnly ? null : (
          <div className="cfg-actions">
            <button className={dirty ? 'ov-button is-primary' : 'ov-button'} type="submit" disabled={busy || !dirty || !hostOk || !offsetOk}>{t('drone.cfg.save')}</button>
            <span className="cfg-result" role="status">
              {result ? <StatusChip code={result.code} tone={result.tone} /> : null}
              {result?.text ? <span className={`cfg-result-text pg-text-${result.tone}`}>{result.text}</span> : null}
            </span>
          </div>
        )}
      </form>
    </Card>
  );
}
