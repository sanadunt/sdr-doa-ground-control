import type { JSX } from 'react';
import type { MapCoordinate, PolarSettings, TelemetrySnapshot, Tone } from '../types';
import { candidate, numberOrNull } from '../lib/telemetry';
import { bearingForView, formatDegrees, polarView } from '../lib/polar';
import { doaStatusTextKey, overviewDoaStatus } from '../lib/doaStatus';
import { useI18n } from '../lib/i18n';
import type { MessageKey } from '../lib/i18n';

export function coordinateSourceKey(source: MapCoordinate['source'] | undefined): MessageKey {
  if (source === 'SIMULATION') return 'map.sourceSimulation';
  if (source === 'FALLBACK') return 'map.sourceFallback';
  if (source === 'MANUAL') return 'map.sourceManual';
  return 'map.sourceStation';
}

function formatOffset(offset: number): string {
  return String(Number(offset.toFixed(1)));
}

/**
 * Compact bearing HUD over the map. The primary value is the geographic
 * north-clockwise bearing derived from theta_0 and the compass offset; theta_0
 * stays visible beside it, and so does the plotted display peak, because the
 * two are not guaranteed to agree. Nothing is shown unless
 * overviewDoaStatus() says the DoA may be shown.
 */
export function DoaReadout({
  snapshot,
  localSnapshotFresh,
  settings,
  offsetSource,
  offsetVerified,
  offsetManual = false,
}: {
  snapshot: TelemetrySnapshot | null;
  localSnapshotFresh: boolean;
  /** Plot axis (after the local override) for the display peak, and the compass offset. */
  settings: PolarSettings;
  /** Untranslated offset source label, e.g. DATA_OUT or MANUAL. */
  offsetSource: string;
  offsetVerified: boolean;
  /** The offset is a local manual entry; shown in the manual tone. */
  offsetManual?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const simulation = Boolean(snapshot?.simulation);
  const view = polarView(snapshot, settings, localSnapshotFresh, null, settings);
  const status = overviewDoaStatus(snapshot, localSnapshotFresh);
  const statusText = t(doaStatusTextKey(status.reason));
  const bearing = status.shown ? bearingForView(view) : null;
  const csv = candidate(snapshot, 'csv');
  const rawAge = numberOrNull(csv.freshness?.age_ms);
  const ageMs = rawAge !== null && rawAge >= 0 ? rawAge : null;
  const bearingTone: Tone = status.shown ? (status.code === 'DEGRADED' || !offsetVerified ? 'warn' : 'good') : status.code === 'WAITING' ? 'neutral' : 'warn';
  // The age is the collector's value at the last read and does not grow, so
  // once the local window has closed (or the source itself is stale) it is
  // marked STALE instead of reading as current. Without an age (Data Out
  // unreachable) there is nothing to mark.
  const ageStale = !simulation && ageMs !== null && (!localSnapshotFresh || status.code === 'STALE');
  const ageValue = simulation ? 'SIM' : ageMs !== null ? t('common.durationS', { value: (ageMs / 1000).toFixed(1) }) : '—';
  const age = ageStale ? `${ageValue} · STALE` : ageValue;
  const ageTitle = simulation
    ? t('readout.simulationAge')
    : snapshot && ageMs === null && csv.available === true ? t('readout.clockUnverified') : undefined;
  const frameDetail = bearing !== null && view.canonicalAngle !== null
    ? t(offsetVerified ? 'readout.bearingDetail' : 'readout.bearingDetailAssumed', {
      theta: formatDegrees(view.canonicalAngle, 1),
      offset: formatOffset(settings.compassOffset),
      source: offsetSource,
    })
    : null;
  const peakAxis = settings.figType === 'Compass' ? t('readout.peakAxisCompass') : t('readout.peakAxisPolar');
  const peakTitle = status.shown && view.peakValue !== null ? `${peakAxis} · ${t('readout.peakDetail', { db: view.peakValue.toFixed(1) })}` : undefined;

  return (
    <section className={`ov-hud ov-card readout-${bearingTone}`} aria-label={t('readout.region')}>
      <div className="ov-hud-head">
        <span className="ov-eyebrow">{t('readout.bearing')}</span>
        {simulation ? <span className="ov-tag tone-warn">{t('readout.simulation')}</span> : null}
        <span className={ageStale ? 'ov-hud-age is-warn' : 'ov-hud-age'} title={ageTitle}>{t('hud.age', { age })}</span>
      </div>
      <div className="ov-hud-bearing" title={`${t('readout.bearingTitle', { source: offsetSource })}${frameDetail === null ? '' : `\n${frameDetail}`}`}>
        {bearing !== null ? <>{formatDegrees(bearing, 1)}<small>°</small></> : <span className="readout-empty">—</span>}
      </div>
      {status.shown ? (
        <>
          <div className="ov-hud-grid">
            <span>{t('hud.theta')} <b>{view.canonicalAngle !== null ? `${formatDegrees(view.canonicalAngle, 1)}°` : '—'}</b></span>
            <span title={peakTitle}>{t('hud.peak')} <b>{view.displayPeak !== null ? `${formatDegrees(view.displayPeak, 1)}°` : '—'}</b></span>
          </div>
          <div className="ov-hud-offset">
            {t('hud.offset')} <b>{formatOffset(settings.compassOffset)}°</b> · <span className={offsetManual ? 'is-manual' : offsetVerified ? undefined : 'is-warn'}>{offsetSource}</span>
          </div>
          {status.code === 'DEGRADED' ? <p className="ov-hud-held">{statusText}</p> : null}
        </>
      ) : <p className="ov-hud-held" role="status">{statusText}</p>}
      <div className="ov-hud-note">{t('hud.note')}</div>
    </section>
  );
}
