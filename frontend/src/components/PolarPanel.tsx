import type { JSX } from 'react';
import { useState } from 'react';
import type { PolarSettings, TelemetrySnapshot } from '../types';
import { polarView } from '../lib/polar';
import { doaStatus, doaStatusTextKey } from '../lib/doaStatus';
import { useI18n } from '../lib/i18n';
import { PolarPlot } from './PolarPlot';
import { Icon, StatusBadge } from './ui';

export function PolarPanel({
  snapshot,
  localSnapshotFresh,
  compassSettings,
  offsetSource,
}: {
  snapshot: TelemetrySnapshot | null;
  localSnapshotFresh: boolean;
  compassSettings: PolarSettings;
  offsetSource: string;
}): JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const view = polarView(snapshot, compassSettings, localSnapshotFresh, null, compassSettings);
  const status = doaStatus(snapshot, localSnapshotFresh, view.fresh);
  const statusDetail = t(doaStatusTextKey(status.reason));
  return (
    <section className={`panel polar-panel ${expanded ? 'polar-expanded' : ''}`}>
      <div className="panel-toolbar">
        <div className="polar-status" role="status" aria-live="polite" aria-label={t('polar.statusAria', { state: status.code, detail: statusDetail })} title={statusDetail}>
          <StatusBadge label={status.code} tone={status.tone} />
          <span className="polar-status-detail">{statusDetail}</span>
        </div>
        <button type="button" className="toolbar-button polar-expand-button" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>
          <Icon name={expanded ? 'collapse' : 'expand'} /><span>{expanded ? t('polar.restore') : t('polar.expand')}</span>
        </button>
      </div>
      <div className="polar-frame">
        <PolarPlot values={status.shown ? view.values : null} settings={compassSettings} simulation={Boolean(snapshot?.simulation)} offsetSource={offsetSource} />
      </div>
    </section>
  );
}
