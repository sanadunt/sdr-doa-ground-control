import type { JSX } from 'react';
import { useState } from 'react';
import type { PolarSettings, TelemetrySnapshot } from '../types';
import { polarDataReady } from '../lib/telemetry';
import { polarView } from '../lib/polar';
import { useI18n } from '../lib/i18n';
import { PolarPlot } from './PolarPlot';
import { Icon, StatusBadge } from './ui';

export function PolarPanel({
  snapshot,
  localSnapshotFresh,
  compassSettings,
  onHide,
}: {
  snapshot: TelemetrySnapshot | null;
  localSnapshotFresh: boolean;
  compassSettings: PolarSettings;
  /** Shown as a Hide button when the panel floats over the map. */
  onHide?: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const view = polarView(snapshot, compassSettings, localSnapshotFresh, null, compassSettings);
  const available = view.fresh && polarDataReady(snapshot) && localSnapshotFresh;
  const availabilityLabel = available ? 'AVAILABLE' : !snapshot ? 'WAITING' : !localSnapshotFresh ? 'STALE' : 'NOT READY';
  const availabilityTone = available ? 'good' : availabilityLabel === 'WAITING' ? 'neutral' : 'warn';
  const statusDetail = available
    ? t('polar.available')
    : !snapshot
      ? t('polar.waiting')
      : !localSnapshotFresh
        ? t('polar.expired')
        : t('polar.cleared');
  return (
    <section className={`panel polar-panel ${expanded ? 'polar-expanded' : ''}`}>
      <div className="panel-toolbar">
        <div className="polar-status" role="status" aria-live="polite" aria-label={t('polar.statusAria', { state: availabilityLabel, detail: statusDetail })} title={statusDetail}>
          <StatusBadge label={availabilityLabel} tone={availabilityTone} />
          <span className="polar-status-detail">{statusDetail}</span>
        </div>
        <div className="polar-actions">
          <button type="button" className="toolbar-button polar-expand-button" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>
            <Icon name={expanded ? 'collapse' : 'expand'} /><span>{expanded ? t('polar.restore') : t('polar.expand')}</span>
          </button>
          {onHide ? <button type="button" className="toolbar-button polar-hide-button" onClick={onHide} aria-label={t('dashboard.hidePolar')} title={t('dashboard.hidePolar')}><Icon name="close" /></button> : null}
        </div>
      </div>
      <div className="polar-frame">
        <PolarPlot values={available ? view.values : null} settings={compassSettings} simulation={Boolean(snapshot?.simulation)} />
      </div>
    </section>
  );
}
