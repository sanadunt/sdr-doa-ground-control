import type { JSX } from 'react';
import type { PolarSettings, TelemetrySnapshot } from '../../types';
import { overviewDoaStatus } from '../../lib/doaStatus';
import { droneFixLabel } from '../../lib/droneLink';
import type { DroneView } from '../../lib/droneLink';
import { useI18n } from '../../lib/i18n';
import { formatDegrees } from '../../lib/polar';
import { doaSample, snapshotRf } from '../../lib/telemetrySource';
import { hudBearing } from '../DoaReadout';

/** The tabs of the compact side panel. */
export type CompactTab = 'spectrum' | 'polar' | 'drone' | 'node' | 'control';

/**
 * The compact layout's row under the main view, always shown: the bearing with
 * its age (a held one dimmed and tagged as on the HUD), the RDF-SDR frequency,
 * the drone's height, heading and fix, and three link dots. Each box opens the
 * tab with its details. Portrait and short screens keep the first and third.
 */
export function CompactInfoStrip({ snapshot, localSnapshotFresh, settings, curveOffset, offsetManual, drone, videoLive, onOpenTab }: {
  snapshot: TelemetrySnapshot | null;
  localSnapshotFresh: boolean;
  settings: PolarSettings;
  curveOffset: number | null;
  offsetManual: boolean;
  drone: DroneView | null;
  videoLive: boolean;
  onOpenTab: (tab: CompactTab) => void;
}): JSX.Element {
  const { t } = useI18n();
  const hud = hudBearing(snapshot, localSnapshotFresh, settings, curveOffset, offsetManual);
  const deg = hud.bearing ?? hud.heldBearing;
  const held = hud.bearing === null && hud.heldBearing !== null;
  const age = hud.ageMs === null ? null : t('common.durationS', { value: (hud.ageMs / 1000).toFixed(1) });
  const tag = held ? (hud.heldOld ? 'STALE' : t('polar.notValid')) : hud.ageStale ? 'STALE' : null;
  const status = overviewDoaStatus(snapshot, localSnapshotFresh);
  const sample = doaSample(snapshot, status, localSnapshotFresh);
  const centerHz = sample?.frequencyHz ?? (localSnapshotFresh ? snapshotRf(snapshot)?.centerHz ?? null : null);
  const alt = drone?.position?.alt_rel_m ?? null;
  const heading = drone?.heading?.deg ?? null;
  const fix = drone?.gps ? droneFixLabel(drone.gps) : null;
  const droneLive = drone?.state === 'LIVE';
  const dots: Array<[string, boolean]> = [
    [t('overview.linkRdf'), localSnapshotFresh && snapshot !== null],
    [t('overview.linkDrone'), droneLive],
    [t('overview.linkVideo'), videoLive],
  ];
  return (
    <div className="ov-info" role="group" aria-label={t('overview.info')}>
      <button type="button" className={held ? 'ov-info-box is-bearing is-held' : 'ov-info-box is-bearing'} data-tab="node" onClick={() => onOpenTab('node')}>
        <small>{t('overview.infoBearing')}{age ? ` · ${age}` : ''}{tag ? <span className="ov-info-tag"> · {tag}</span> : null}</small>
        <b>{deg === null ? '—' : `${formatDegrees(deg, 1)}°`}</b>
      </button>
      <button type="button" className="ov-info-box is-frequency" data-tab="node" onClick={() => onOpenTab('node')}>
        <small>{t('overview.infoFrequency')}</small>
        <b>{centerHz === null ? '—' : `${(centerHz / 1e6).toFixed(3)} MHz`}</b>
      </button>
      <button type="button" className={droneLive ? 'ov-info-box is-drone' : 'ov-info-box is-drone is-held'} data-tab="drone" onClick={() => onOpenTab('drone')}>
        <small>{t('overview.infoDrone')}{fix && fix !== '—' ? ` · ${fix}` : ''}</small>
        <b>{alt === null ? '—' : `${alt.toFixed(0)} m`}{heading === null ? '' : ` · ${heading.toFixed(0)}°`}</b>
      </button>
      <button type="button" className="ov-info-box is-link" data-tab="drone" onClick={() => onOpenTab('drone')} aria-label={`${t('overview.infoLink')}: ${dots.map(([name, on]) => `${name} ${on ? 'OK' : '—'}`).join(', ')}`}>
        <small>{t('overview.infoLink')}</small>
        <b className="ov-info-dots">{dots.map(([name, on]) => <span key={name} className={on ? 'is-on' : undefined} title={name}>●</span>)}</b>
      </button>
    </div>
  );
}
