import type { JSX } from 'react';
import { useRef, useState } from 'react';
import type { PolarSettings, TelemetrySnapshot } from '../types';
import { polarDataReady } from '../lib/telemetry';
import { polarView } from '../lib/polar';
import { PolarPlot } from './PolarPlot';
import { Panel, StatusBadge } from './ui';

export function PolarPanel({
  snapshot,
  localSnapshotFresh,
  compassSettings,
}: {
  snapshot: TelemetrySnapshot | null;
  localSnapshotFresh: boolean;
  compassSettings: PolarSettings;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const previousSettings = useRef<PolarSettings>({ figType: 'Polar', compassOffset: 0 });
  const liveView = polarView(snapshot, previousSettings.current, localSnapshotFresh, null, compassSettings);
  const view = { ...liveView, settings: compassSettings };
  previousSettings.current = compassSettings;
  const available = view.fresh && polarDataReady(snapshot) && localSnapshotFresh;
  const availabilityLabel = available ? 'AVAILABLE' : !snapshot ? 'WAITING' : !localSnapshotFresh ? 'STALE' : 'NOT READY';
  const availabilityTone = available ? 'good' : availabilityLabel === 'WAITING' ? 'neutral' : 'warn';
  const statusDetail = available
    ? view.reason
    : !snapshot
      ? 'Waiting for the first Data Out snapshot.'
      : !localSnapshotFresh
        ? 'Local snapshot expired; curve cleared until the next bounded read.'
        : view.reason;
  return (
    <Panel
      className={`polar-panel ${expanded ? 'polar-expanded' : ''}`}
      action={<button type="button" className="secondary-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Restore graph' : 'Enlarge graph'}</button>}
    >
      <div className="polar-frame">
        <div className="polar-status" role="status" aria-live="polite" aria-label={`Polar plot status: ${availabilityLabel}. ${statusDetail}`} title={statusDetail}>
          <StatusBadge label={availabilityLabel} tone={availabilityTone} />
        </div>
        <PolarPlot values={available ? view.values : null} settings={view.settings} simulation={Boolean(snapshot?.simulation)} />
      </div>
    </Panel>
  );
}
