import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { getDroneVideoHealth } from '../api';
import type { DroneVideoHealth } from '../api';
import { droneFixLabel, snapshotDrone } from '../lib/droneLink';
import { formatDuration } from '../lib/healthView';
import { useI18n } from '../lib/i18n';
import type { TelemetrySnapshot } from '../types';
import { droneChip, droneVideoText } from './overview/DronePanel';
import { Card, KeyValueGrid, Notice, StatusChip } from './page';
import type { KeyValueItem } from './page';

/** System Health: the drone link (the SIYI remote's broker) and how fresh each part of its telemetry is. */
export function DroneLinkCard({ snapshot }: { snapshot: TelemetrySnapshot | null }): JSX.Element | null {
  const { t } = useI18n();
  if (!snapshot || !('drone' in snapshot)) return null;
  const view = snapshotDrone(snapshot);
  const chip = droneChip(view);
  const age = (block: { age_ms: number | null; stale: boolean } | null) => (block?.age_ms == null ? '—' : `${formatDuration(t, block.age_ms)}${block.stale ? ' · STALE' : ''}`);
  const items: KeyValueItem[] = [
    { id: 'connection', label: t('health.drone.connection'), value: view ? view.connection.toUpperCase() : '—' },
    { id: 'remote', label: t('health.drone.remote'), value: view?.host ? `${view.host}:${view.port ?? 1883} · ${view.discoveryMode === 'auto' ? t('drone.cfg.auto') : t('drone.cfg.fixed')}` : (view?.scanning ? t('drone.searching') : '—') },
    { id: 'fc', label: t('health.drone.fc'), value: view?.link?.fc_online == null ? '—' : view.link.fc_online ? t('drone.fcOnline') : t('drone.fcOffline'), tone: view?.link?.fc_online === false ? 'bad' : undefined },
    { id: 'frames', label: t('health.drone.frames'), value: view?.link?.frames_per_s == null ? '—' : `${view.link.frames_per_s.toFixed(1)}/s` },
    { id: 'bridge', label: t('health.drone.bridge'), value: view?.link?.version ? `v${view.link.version}` : '—' },
    { id: 'position', label: t('health.drone.position'), value: age(view?.position ?? null), tone: view?.position?.stale ? 'bad' : undefined },
    { id: 'gps', label: t('health.drone.gps'), value: view?.gps ? `${droneFixLabel(view.gps)} · ${age(view.gps)}` : '—' },
    { id: 'attitude', label: t('health.drone.attitude'), value: age(view?.attitude ?? null), tone: view?.attitude?.stale ? 'bad' : undefined },
    { id: 'invalid', label: t('health.drone.invalid'), value: view ? `${view.invalid}${view.lastInvalid ? ` · ${view.lastInvalid}` : ''}` : '—', mono: false },
  ];
  const cause = view?.lastError && view.connection !== 'connected' ? view.lastError : null;
  return (
    <Card title={t('health.drone.title')} chip={<StatusChip code={chip.code} tone={chip.tone === 'info' ? 'neutral' : chip.tone} />}>
      {cause ? <Notice tone="warn" title={chip.code}>{cause}</Notice> : null}
      <KeyValueGrid items={items} label={t('health.drone.title')} />
    </Card>
  );
}

/** System Health: the host video service (mediamtx + ffmpeg, packaging/drone-video), read every 5 s. */
export function DroneVideoCard({ initial = null }: { initial?: DroneVideoHealth | null }): JSX.Element {
  const { t } = useI18n();
  const [health, setHealth] = useState<DroneVideoHealth | null>(initial);
  useEffect(() => {
    if (initial) return undefined;
    let stopped = false;
    let timer = 0;
    const read = async () => {
      try {
        const next = await getDroneVideoHealth();
        if (!stopped) setHealth(next);
      } catch {
        // The next read tries again.
      }
      if (!stopped) timer = window.setTimeout(() => { void read(); }, 5_000);
    };
    void read();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [initial]);
  const state = health?.state ?? 'N/A';
  const tone = state === 'OK' ? 'good' : state === 'DISABLED' || state === 'N/A' ? 'neutral' : state === 'DOWN' ? 'bad' : 'warn';
  const cause = health && health.state !== 'OK' ? droneVideoText(health, 'idle', null, t) : null;
  const items: KeyValueItem[] = [
    { id: 'camera', label: t('health.video.camera'), value: health ? (health.cameraReady ? 'READY' : 'NOT READY') : '—', tone: health && !health.cameraReady ? 'bad' : undefined },
    { id: 'encoder', label: t('health.video.encoder'), value: health ? (health.videoReady ? 'READY' : 'NOT READY') : '—', tone: health && !health.videoReady ? 'bad' : undefined },
    { id: 'tracks', label: t('health.video.tracks'), value: health?.tracks.length ? health.tracks.join(', ') : '—' },
    { id: 'readers', label: t('health.video.readers'), value: health?.readers == null ? '—' : String(health.readers) },
  ];
  return (
    <Card title={t('health.video.title')} chip={<StatusChip code={state} tone={tone} />}>
      {cause ? <Notice tone={tone === 'bad' ? 'bad' : 'info'} title={state}>{cause}{health?.error ? ` (${health.error})` : ''}</Notice> : null}
      <KeyValueGrid items={items} label={t('health.video.title')} />
    </Card>
  );
}
