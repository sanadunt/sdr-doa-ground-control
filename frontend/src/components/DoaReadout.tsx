import type { JSX, ReactNode } from 'react';
import type { MapCoordinate, PolarSettings, TelemetrySnapshot, Tone } from '../types';
import { candidate, formatAge, numberOrNull } from '../lib/telemetry';
import { polarView } from '../lib/polar';
import { gateReasonLabel, useI18n } from '../lib/i18n';
import type { MessageKey } from '../lib/i18n';

function ReadoutCell({ label, value, detail, tone = 'neutral', primary = false, badge }: { label: string; value: ReactNode; detail: ReactNode; tone?: Tone; primary?: boolean; badge?: ReactNode }): JSX.Element {
  return (
    <div className={`readout-cell readout-${tone}${primary ? ' readout-primary' : ''}`}>
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

/**
 * Operator summary above the map. The canonical angle and the plotted display
 * peak are shown side by side because they are not guaranteed to agree.
 */
export function DoaReadout({ snapshot, localSnapshotFresh, coordinate, settings }: { snapshot: TelemetrySnapshot | null; localSnapshotFresh: boolean; coordinate: MapCoordinate | null; settings: PolarSettings }): JSX.Element {
  const { lang, t } = useI18n();
  const simulation = Boolean(snapshot?.simulation);
  const view = polarView(snapshot, settings, localSnapshotFresh, null, settings);
  const available = view.fresh && localSnapshotFresh;
  const csv = candidate(snapshot, 'csv');
  const gate = String(snapshot?.publication_gate?.state ?? 'BLOCKED').toUpperCase();
  const reasons = snapshot?.publication_gate?.reasons ?? [];
  const firstReason = reasons[0] ? gateReasonLabel(lang, reasons[0]) : t('readout.noReason');
  const reasonText = reasons.length > 1 ? t('readout.reasonMore', { reason: firstReason, count: reasons.length - 1 }) : firstReason;
  const freshness = !snapshot ? 'WAITING' : localSnapshotFresh ? 'CURRENT' : 'STALE';
  const rawAge = numberOrNull(csv.freshness?.age_ms);
  const ageMs = rawAge !== null && rawAge >= 0 ? rawAge : null;
  const sourceBadge = <span className={`readout-badge ${simulation ? 'tone-warn' : 'tone-neutral'}`}>{simulation ? t('readout.simulation') : t('readout.live')}</span>;

  return (
    <section className="doa-readout" aria-label={t('readout.region')}>
      <ReadoutCell
        primary
        label={t('readout.bearing')}
        badge={sourceBadge}
        tone={available ? 'good' : 'neutral'}
        value={available && view.canonicalAngle !== null ? <>{view.canonicalAngle.toFixed(1)}<small>°</small></> : <span className="readout-empty">—</span>}
        detail={available ? `${settings.figType} · CSV` : t('readout.noBearing')}
      />
      <ReadoutCell
        label={t('readout.peak')}
        value={available && view.displayPeak !== null ? <>{view.displayPeak.toFixed(0)}<small>°</small></> : <span className="readout-empty">—</span>}
        detail={available && view.peakValue !== null ? t('readout.peakDetail', { db: view.peakValue.toFixed(1) }) : t('common.na')}
      />
      <ReadoutCell
        label={t('readout.age')}
        tone={freshness === 'CURRENT' ? 'good' : freshness === 'STALE' ? 'warn' : 'neutral'}
        value={simulation ? <span className="readout-code">SIM</span> : ageMs !== null ? formatAge(csv.freshness) : <span className="readout-empty">—</span>}
        detail={simulation ? t('readout.simulationAge') : snapshot && ageMs === null ? `${freshness} · ${t('readout.clockUnverified')}` : freshness}
      />
      <ReadoutCell
        label={t('readout.gate')}
        tone={gate === 'READY' ? 'good' : 'warn'}
        value={<span className="readout-code">{gate}</span>}
        detail={<span title={reasons.map((reason) => gateReasonLabel(lang, reason)).join('\n') || undefined}>{reasonText}</span>}
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
