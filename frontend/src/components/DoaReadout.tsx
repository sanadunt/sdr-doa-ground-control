import type { JSX, ReactNode } from 'react';
import type { MapCoordinate, PolarSettings, TelemetrySnapshot, Tone } from '../types';
import { candidate, formatAge, numberOrNull } from '../lib/telemetry';
import { bearingForView, formatDegrees, polarView } from '../lib/polar';
import { doaStatus, doaStatusTextKey, rankGateReasons } from '../lib/doaStatus';
import { gateReasonLabel, useI18n } from '../lib/i18n';
import type { MessageKey } from '../lib/i18n';

function ReadoutCell({ label, value, detail, title, tone = 'neutral', primary = false, badge }: { label: string; value: ReactNode; detail: ReactNode; title?: string; tone?: Tone; primary?: boolean; badge?: ReactNode }): JSX.Element {
  return (
    <div className={`readout-cell readout-${tone}${primary ? ' readout-primary' : ''}`} title={title}>
      <div className="readout-label"><span>{label}</span>{badge}</div>
      <div className="readout-value">{value}</div>
      <div className="readout-detail">{detail}</div>
    </div>
  );
}

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
 * Operator summary above the map. The primary bearing is the geographic
 * north-clockwise bearing derived from theta_0 and the compass offset; theta_0
 * itself stays visible in the detail line. The plotted display peak is shown
 * beside it because the two are not guaranteed to agree.
 */
export function DoaReadout({
  snapshot,
  localSnapshotFresh,
  coordinate,
  settings,
  offsetSource,
  offsetVerified,
}: {
  snapshot: TelemetrySnapshot | null;
  localSnapshotFresh: boolean;
  coordinate: MapCoordinate | null;
  settings: PolarSettings;
  offsetSource: string;
  offsetVerified: boolean;
}): JSX.Element {
  const { lang, t } = useI18n();
  const simulation = Boolean(snapshot?.simulation);
  const view = polarView(snapshot, settings, localSnapshotFresh, null, settings);
  const status = doaStatus(snapshot, localSnapshotFresh, view.fresh);
  const statusText = t(doaStatusTextKey(status.reason));
  const bearing = status.shown ? bearingForView(view) : null;
  const csv = candidate(snapshot, 'csv');
  const gate = String(snapshot?.publication_gate?.state ?? 'BLOCKED').toUpperCase();
  const reasons = rankGateReasons(snapshot?.publication_gate?.reasons);
  const firstReason = reasons[0] ? gateReasonLabel(lang, reasons[0]) : t('readout.noReason');
  const reasonText = reasons.length > 1 ? t('readout.reasonMore', { reason: firstReason, count: reasons.length - 1 }) : firstReason;
  // Name the actual state (CONFLICT, UNAVAILABLE, ...) instead of CURRENT when nothing is shown.
  const freshness = status.shown ? 'CURRENT' : status.code;
  const rawAge = numberOrNull(csv.freshness?.age_ms);
  const ageMs = rawAge !== null && rawAge >= 0 ? rawAge : null;
  const sourceBadge = <span className={`readout-badge ${simulation ? 'tone-warn' : 'tone-neutral'}`}>{simulation ? t('readout.simulation') : t('readout.live')}</span>;
  const bearingTone: Tone = status.shown ? (status.code === 'DEGRADED' || !offsetVerified ? 'warn' : 'good') : status.code === 'WAITING' ? 'neutral' : 'warn';
  const frameDetail = bearing !== null && view.canonicalAngle !== null
    ? t(offsetVerified ? 'readout.bearingDetail' : 'readout.bearingDetailAssumed', {
      theta: formatDegrees(view.canonicalAngle, 1),
      offset: formatOffset(settings.compassOffset),
      source: offsetSource,
    })
    : null;
  // A degraded record keeps its bearing on screen, so the cause leads the detail line.
  const bearingDetail = frameDetail === null || status.code === 'DEGRADED' ? statusText : frameDetail;
  const peakAxis = settings.figType === 'Compass' ? t('readout.peakAxisCompass') : t('readout.peakAxisPolar');
  const peakDetail = status.shown && view.peakValue !== null
    ? `${peakAxis} · ${t('readout.peakDetail', { db: view.peakValue.toFixed(1) })}`
    : t('common.na');
  const ageDetail = simulation
    ? t('readout.simulationAge')
    : snapshot && ageMs === null
      ? csv.available === true ? `${freshness} · ${t('readout.clockUnverified')}` : `${freshness} · ${t('common.na')}`
      : freshness;

  return (
    <section className="doa-readout" aria-label={t('readout.region')}>
      <ReadoutCell
        primary
        label={t('readout.bearing')}
        badge={sourceBadge}
        tone={bearingTone}
        title={`${t('readout.bearingTitle', { source: offsetSource })}${frameDetail === null ? '' : `\n${frameDetail}`}`}
        value={bearing !== null ? <>{formatDegrees(bearing, 1)}<small>°</small></> : <span className="readout-empty">—</span>}
        detail={bearingDetail}
      />
      <ReadoutCell
        label={t('readout.peak')}
        title={peakDetail}
        value={status.shown && view.displayPeak !== null ? <>{formatDegrees(view.displayPeak)}<small>°</small></> : <span className="readout-empty">—</span>}
        detail={peakDetail}
      />
      <ReadoutCell
        label={t('readout.age')}
        tone={freshness === 'CURRENT' ? 'good' : freshness === 'WAITING' ? 'neutral' : 'warn'}
        value={simulation ? <span className="readout-code">SIM</span> : ageMs !== null ? formatAge(csv.freshness) : <span className="readout-empty">—</span>}
        detail={ageDetail}
      />
      <ReadoutCell
        label={t('readout.gate')}
        tone={gate === 'READY' ? 'good' : 'warn'}
        title={reasons.map((reason) => gateReasonLabel(lang, reason)).join('\n') || undefined}
        value={<span className="readout-code">{gate}</span>}
        detail={reasonText}
      />
      <ReadoutCell
        label={t('readout.position')}
        tone={coordinate?.source === 'DATA_OUT' ? 'good' : 'neutral'}
        value={coordinate ? <span className="readout-coordinate">{coordinate.latitude.toFixed(5)}, {coordinate.longitude.toFixed(5)}</span> : <span className="readout-empty">—</span>}
        detail={coordinate ? t(coordinateSourceKey(coordinate.source)) : t('readout.noPosition')}
      />
    </section>
  );
}
