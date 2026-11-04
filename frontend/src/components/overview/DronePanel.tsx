import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { getDrone, getDroneVideoHealth } from '../../api';
import type { DroneVideoHealth } from '../../api';
import { droneFixLabel, normalizeDrone } from '../../lib/droneLink';
import type { DroneView } from '../../lib/droneLink';
import { useI18n } from '../../lib/i18n';
import type { MessageKey, Translate } from '../../lib/i18n';
import { startWhep, WhepError } from '../../lib/whep';
import type { WhepSession } from '../../lib/whep';
import { Icon } from '../ui';

type ChipTone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';
/** How often the panel reads /api/drone while shown: the drone moves faster than the snapshot interval. */
export const DRONE_POLL_MS = 1_000;
/** How often it reads the video service's state. */
export const DRONE_VIDEO_HEALTH_MS = 5_000;
const VIDEO_RETRY_MS = 3_000;
// A WebRTC 'disconnected' often recovers by itself; only a long one restarts the player.
const VIDEO_DISCONNECT_GRACE_MS = 5_000;

export function droneChip(view: DroneView | null): { code: string; tone: ChipTone } {
  if (!view || view.state === 'DISABLED') return { code: 'OFF', tone: 'neutral' };
  if (view.connection === 'searching' || (view.scanning && view.connection !== 'connected')) return { code: 'SEARCHING', tone: 'warn' };
  if (view.connection !== 'connected') return { code: 'OFFLINE', tone: 'bad' };
  if (view.state === 'LIVE') return { code: 'LIVE', tone: 'good' };
  if (view.state === 'STALE') return { code: 'STALE', tone: 'warn' };
  return { code: 'NO DATA', tone: 'warn' };
}

const fmt = (value: number | null | undefined, digits: number, unit = '') => (value === null || value === undefined ? '—' : `${value.toFixed(digits)}${unit}`);

/** A row of the panel; tone is a class of the value (is-good, is-warn, is-bad, is-stale, is-empty). */
export interface DroneRow { key: string; label: string; value: string; tone?: string; wide?: boolean }

const NONE = '—';

/** The telemetry link's state in a few words: off, searching, connecting, connected (with or without data), not connected. */
export function droneLinkStatus(view: DroneView | null, t: Translate): { value: string; tone: string } {
  if (!view) return { value: t('drone.linkChecking'), tone: 'is-empty' };
  if (view.state === 'DISABLED' || view.connection === 'disabled') return { value: t('drone.linkOff'), tone: 'is-empty' };
  const host = view.host ?? NONE;
  if (view.connection === 'searching' || (view.scanning && view.connection !== 'connected')) return { value: t('drone.linkSearching'), tone: 'is-warn' };
  if (view.connection === 'connecting') return { value: t('drone.linkConnecting', { host }), tone: 'is-warn' };
  if (view.connection !== 'connected') return { value: t('drone.linkDown', { host }), tone: 'is-bad' };
  if (view.state === 'LIVE') return { value: t('drone.linkLive', { host }), tone: 'is-good' };
  if (view.state === 'STALE') return { value: t('drone.linkStale', { host }), tone: 'is-warn' };
  return { value: t('drone.linkNoData', { host }), tone: 'is-warn' };
}

export type DroneVideoPhase = 'idle' | 'connecting' | 'playing' | 'error';

/** The video's state in a few words, from the service's health and the player. */
export function droneVideoStatus(health: DroneVideoHealth | null, phase: DroneVideoPhase, code: string | null, t: Translate): { value: string; tone: string } {
  if (phase === 'playing') return { value: t('drone.videoLive'), tone: 'is-good' };
  if (!health) return { value: t('drone.videoChecking'), tone: 'is-empty' };
  if (health.state === 'DISABLED') return { value: t(health.reason === 'NOT_CONFIGURED' ? 'drone.videoNone' : 'drone.videoOff'), tone: 'is-empty' };
  // Nobody watches yet: the camera is pulled once the player asks (PULL=on-demand).
  if (health.state === 'STANDBY' && phase === 'idle') return { value: t('drone.videoStandby'), tone: 'is-empty' };
  if (health.state === 'DOWN') return { value: t('drone.videoDown'), tone: 'is-bad' };
  if (health.state === 'NO_ENCODER') return { value: t('drone.videoNoEncoder'), tone: 'is-bad' };
  if (health.state === 'NO_CAMERA' || code === 'DRONE_VIDEO_NO_STREAM') return { value: t('drone.videoNoCamera'), tone: 'is-warn' };
  if (phase === 'error') return { value: t('drone.videoRetrying'), tone: 'is-warn' };
  return { value: t('drone.videoConnecting'), tone: 'is-warn' };
}

/**
 * The telemetry rows, always all of them: a value the drone has not sent
 * reads "—", so the panel shows where each value will come; a stale one is marked.
 */
export function droneRows(view: DroneView | null, t: Translate): DroneRow[] {
  const rows: DroneRow[] = [];
  const stale = (block: { stale: boolean } | null) => (block?.stale ? 'is-stale' : undefined);
  const empty = (key: string, label: string, wide = false): DroneRow => ({ key, label, value: NONE, tone: 'is-empty', wide });
  if (!view?.status) rows.push(empty('status', t('drone.status')));
  else {
    const armed = view.status.armed === null ? '—' : view.status.armed ? 'ARMED' : 'DISARMED';
    const mode = view.status.custom_mode === null ? '' : ` · ${t('drone.modeValue', { mode: view.status.custom_mode })}`;
    rows.push({ key: 'status', label: t('drone.status'), value: `${armed}${mode}`, tone: stale(view.status) ?? (view.status.armed ? 'is-warn' : undefined) });
  }
  if (!view?.gps) rows.push(empty('gps', t('drone.gps'), true));
  else {
    const parts = [droneFixLabel(view.gps)];
    if (view.gps.satellites !== null) parts.push(t('drone.satellites', { count: view.gps.satellites }));
    if (view.gps.hdop !== null) parts.push(`HDOP ${view.gps.hdop.toFixed(1)}`);
    rows.push({ key: 'gps', label: t('drone.gps'), value: parts.join(' · '), wide: true, tone: stale(view.gps) ?? (view.gps.rtk === 'FIXED' ? 'is-good' : view.gps.fix !== null && view.gps.fix < 3 ? 'is-bad' : undefined) });
  }
  if (!view?.position) rows.push(empty('alt', t('drone.altitude'), true), empty('speed', t('drone.speed')));
  else {
    rows.push({ key: 'alt', label: t('drone.altitude'), value: t('drone.altValue', { rel: fmt(view.position.alt_rel_m, 1, ' m'), msl: fmt(view.position.alt_msl_m, 0, ' m') }), wide: true, tone: stale(view.position) });
    rows.push({ key: 'speed', label: t('drone.speed'), value: `${fmt(view.position.speed_ms, 1, ' m/s')}${view.hud?.climb_ms !== null && view.hud?.climb_ms !== undefined ? ` · ↕ ${view.hud.climb_ms.toFixed(1)} m/s` : ''}`, tone: stale(view.position) });
  }
  rows.push(view?.heading ? { key: 'heading', label: t('drone.heading'), value: `${view.heading.deg.toFixed(1)}°` } : empty('heading', t('drone.heading')));
  if (!view?.attitude) rows.push(empty('attitude', t('drone.attitude')));
  else rows.push({ key: 'attitude', label: t('drone.attitude'), value: `${fmt(view.attitude.roll_deg, 1, '°')} / ${fmt(view.attitude.pitch_deg, 1, '°')}`, tone: stale(view.attitude) });
  if (!view?.battery) rows.push(empty('battery', t('drone.battery')));
  else {
    const pct = view.battery.remaining_pct === null ? '' : ` · ${view.battery.remaining_pct.toFixed(0)}%`;
    rows.push({ key: 'battery', label: t('drone.battery'), value: `${fmt(view.battery.voltage_v, 2, ' V')} · ${fmt(view.battery.current_a, 1, ' A')}${pct}`, tone: stale(view.battery) });
  }
  if (!view?.link) rows.push(empty('link', t('drone.link'), true));
  else {
    const fc = view.link.fc_online === null ? '—' : view.link.fc_online ? t('drone.fcOnline') : t('drone.fcOffline');
    const host = view.host ? ` · ${view.host}` : '';
    rows.push({ key: 'link', label: t('drone.link'), value: `${fc}${host}`, wide: true, tone: view.link.stale ? 'is-stale' : view.link.fc_online === false ? 'is-bad' : undefined });
  }
  return rows;
}

const VIDEO_STATE_KEYS: Record<DroneVideoHealth['state'], MessageKey> = {
  OK: 'drone.video.connecting',
  STANDBY: 'drone.video.standby',
  NO_CAMERA: 'drone.video.noCamera',
  NO_ENCODER: 'drone.video.noEncoder',
  DOWN: 'drone.video.down',
  DISABLED: 'drone.video.disabled',
};

/** The line over the video while it does not play. */
export function droneVideoText(health: DroneVideoHealth | null, phase: 'idle' | 'connecting' | 'playing' | 'error', code: string | null, t: Translate): string | null {
  if (phase === 'playing') return null;
  if (!health) return t('drone.video.checking');
  if (health.state === 'DISABLED' && health.reason === 'NOT_CONFIGURED') return t('drone.video.notConfigured');
  // STANDBY plays as OK: the player's offer starts the pull.
  if (health.state === 'STANDBY' && phase === 'idle') return t(VIDEO_STATE_KEYS.STANDBY);
  if (health.state !== 'OK' && health.state !== 'STANDBY') return t(VIDEO_STATE_KEYS[health.state]);
  if (phase === 'error') return code === 'DRONE_VIDEO_NO_STREAM' ? t('drone.video.noCamera') : t('drone.video.failed');
  return t('drone.video.connecting');
}

/** The drone camera through the console's WHEP proxy, started only while the video service reports OK. */
function DroneVideo({ view, health, onState }: {
  view: DroneView | null;
  health: DroneVideoHealth | null;
  /** The player's phase and last error code, for the panel's Video row. */
  onState: (phase: DroneVideoPhase, code: string | null) => void;
}): JSX.Element {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<DroneVideoPhase>('idle');
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => { onState(phase, code); }, [onState, phase, code]);
  const [attempt, setAttempt] = useState(0);
  // On demand the offer itself starts the camera, so STANDBY plays like OK.
  const ready = (health?.state === 'OK' || health?.state === 'STANDBY') && typeof RTCPeerConnection === 'function';

  useEffect(() => {
    if (!ready) {
      setPhase('idle');
      return undefined;
    }
    const controller = new AbortController();
    let session: WhepSession | null = null;
    let retry = 0;
    let grace = 0;
    const again = () => {
      window.clearTimeout(retry);
      retry = window.setTimeout(() => setAttempt((value) => value + 1), VIDEO_RETRY_MS);
    };
    setPhase('connecting');
    void startWhep((stream) => {
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      void video.play().catch(() => undefined);
    }, controller.signal).then((opened) => {
      if (controller.signal.aborted) {
        opened.close();
        return;
      }
      session = opened;
      opened.pc.addEventListener('connectionstatechange', () => {
        const state = opened.pc.connectionState;
        if (state === 'failed' || state === 'closed') {
          setPhase('error');
          again();
        } else if (state === 'disconnected') {
          window.clearTimeout(grace);
          grace = window.setTimeout(() => {
            if (opened.pc.connectionState === 'disconnected') {
              setPhase('error');
              again();
            }
          }, VIDEO_DISCONNECT_GRACE_MS);
        }
      });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setCode(error instanceof WhepError ? error.code : null);
      setPhase('error');
      again();
    });
    return () => {
      controller.abort();
      window.clearTimeout(retry);
      window.clearTimeout(grace);
      session?.close();
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };
  }, [ready, attempt]);

  const notice = droneVideoText(health, phase, code, t);
  const position = view?.position;
  return (
    <div className="ov-drone-video" data-phase={phase}>
      {/* Muted and inline, so browsers let it start without a gesture; the drone camera has no audio. */}
      <video ref={videoRef} muted playsInline autoPlay aria-label={t('drone.video.label')} onPlaying={() => setPhase('playing')} />
      {notice ? <div className="ov-drone-video-notice" role="status">{notice}</div> : null}
      {phase === 'playing' && position ? (
        <div className="ov-drone-hud" aria-hidden="true">
          <span>ALT {fmt(position.alt_rel_m, 1, ' m')}</span>
          <span>GS {fmt(position.speed_ms, 1, ' m/s')}</span>
          <span>HDG {view?.heading ? `${view.heading.deg.toFixed(0)}°` : '—'}</span>
          {view?.battery?.voltage_v !== null && view?.battery?.voltage_v !== undefined ? <span>{view.battery.voltage_v.toFixed(1)} V</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The drone panel (right column, above the RDF-SDR card): the camera and the
 * flight telemetry from the SIYI remote, read only. It reads /api/drone every
 * second and the video service every 5 s while shown.
 */
export function DronePanel({ initialView = null, initialHealth = null, onClose }: {
  /** The drone block of the last snapshot answer, shown until the first read. */
  initialView?: DroneView | null;
  /** Static renders (tests) pass a health and never read. */
  initialHealth?: DroneVideoHealth | null;
  onClose?: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [view, setView] = useState<DroneView | null>(initialView);
  const [health, setHealth] = useState<DroneVideoHealth | null>(initialHealth);
  const [large, setLarge] = useState(false);
  const staticRender = initialHealth !== null;

  useEffect(() => {
    if (staticRender) return undefined;
    let stopped = false;
    let timer = 0;
    const read = async () => {
      if (document.visibilityState !== 'hidden') {
        try {
          const next = normalizeDrone(await getDrone());
          if (!stopped && next) setView(next);
        } catch {
          // Kept: the next read tries again.
        }
      }
      if (!stopped) timer = window.setTimeout(() => { void read(); }, DRONE_POLL_MS);
    };
    void read();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [staticRender]);

  useEffect(() => {
    if (staticRender) return undefined;
    let stopped = false;
    let timer = 0;
    const read = async () => {
      try {
        const next = await getDroneVideoHealth();
        if (!stopped) setHealth(next);
      } catch {
        if (!stopped) setHealth((current) => current ?? { state: 'DOWN', reason: 'CONSOLE_UNREACHABLE', cameraReady: false, videoReady: false, readers: null, tracks: [], error: null });
      }
      if (!stopped) timer = window.setTimeout(() => { void read(); }, DRONE_VIDEO_HEALTH_MS);
    };
    void read();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [staticRender]);

  const [video, setVideo] = useState<{ phase: DroneVideoPhase; code: string | null }>({ phase: 'idle', code: null });
  const onVideoState = useCallback((phase: DroneVideoPhase, code: string | null) => setVideo({ phase, code }), []);
  const chip = droneChip(view);
  const rows = droneRows(view, t);
  const text = view?.statustext?.text ?? null;
  const videoShown = view?.videoEnabled !== false;
  const link = droneLinkStatus(view, t);
  const videoStatus = droneVideoStatus(health, videoShown ? video.phase : 'idle', video.code, t);
  const status: DroneRow[] = [
    { key: 'telemetry', label: t('drone.telemetry'), value: link.value, tone: link.tone, wide: true },
    { key: 'video', label: t('drone.video.label'), value: videoShown ? videoStatus.value : t('drone.videoOff'), tone: videoShown ? videoStatus.tone : 'is-empty', wide: true },
  ];
  return (
    <section id="panel-drone" className={large ? 'ov-drone ov-card is-large' : 'ov-drone ov-card'} aria-labelledby="ov-drone-title">
      <div className="ov-card-head">
        <h2 id="ov-drone-title">{t('drone.title')}</h2>
        <span className={`ov-chip tone-${chip.tone}`}>{chip.code}</span>
        {videoShown ? (
          <button className="ov-icon-button" type="button" aria-pressed={large} aria-label={large ? t('drone.shrink') : t('drone.expand')} title={large ? t('drone.shrink') : t('drone.expand')} onClick={() => setLarge(!large)}>
            <Icon name={large ? 'collapse' : 'expand'} />
          </button>
        ) : null}
        {onClose ? (
          <button className="ov-icon-button" type="button" aria-label={t('drone.close')} title={t('drone.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        ) : null}
      </div>
      {videoShown ? <DroneVideo view={view} health={health} onState={onVideoState} /> : null}
      <dl className="ov-drone-rows">
        {[...status, ...rows].map((row) => (
          <div key={row.key} className={[row.wide ? 'is-wide' : '', row.key === 'video' ? 'is-last-status' : ''].filter(Boolean).join(' ') || undefined}>
            <dt>{row.label}</dt>
            <dd className={row.tone}>{row.value}</dd>
          </div>
        ))}
      </dl>
      {text ? <p className="ov-drone-text" title={t('drone.statustext')}>{text}</p> : null}
    </section>
  );
}
