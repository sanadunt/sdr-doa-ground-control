import type { JSX } from 'react';
import { useRef, useState } from 'react';
import type { PolarSettings, TelemetrySnapshot } from '../types';
import { polarDataReady } from '../lib/telemetry';
import { displayLabel, polarMetadata, polarView } from '../lib/polar';
import { PolarPlot } from './PolarPlot';
import { EmptyState, Metric, Panel, StatusBadge } from './ui';

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
  const meta = polarMetadata(view);

  const available = view.fresh && polarDataReady(snapshot) && localSnapshotFresh;
  const retainedCanonical = view.canonicalAngle !== null && !available;
  return (
    <Panel
      className={`polar-panel ${expanded ? 'polar-expanded' : ''}`}
      eyebrow={snapshot?.simulation ? '02 / SIMULATION · Synthetic response' : '02 / Direction finding'}
      title="Angular response"
      action={<div className="panel-action-group"><StatusBadge label={available ? 'AVAILABLE' : 'UNAVAILABLE'} tone={available ? 'good' : 'warn'} /><button type="button" className="secondary-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Restore split view' : 'Enlarge plot'}</button></div>}
    >
      <div className="polar-frame">
        <PolarPlot values={available ? view.values : null} settings={view.settings} simulation={Boolean(snapshot?.simulation)} />
        {!available ? <div className="polar-empty"><EmptyState label="POLAR UNAVAILABLE" detail={localSnapshotFresh ? view.reason : 'Local snapshot expired; curve cleared until the next bounded read.'} tone="warn" /></div> : null}
      </div>
      <div className="polar-meta-grid">
        <Metric label={retainedCanonical ? 'Canonical source · last-read metadata' : 'Canonical source'} value={meta.canonical} detail={retainedCanonical ? 'Last-read metadata only; not an active source' : 'Upstream θ₀; not a plotted display peak'} tone={view.canonicalAngle === null ? 'neutral' : retainedCanonical ? 'warn' : 'good'} />
        <Metric label="Plotted display peak" value={meta.peak} detail={displayLabel(view)} tone={view.displayPeak === null ? 'neutral' : 'good'} />
        <Metric label="Signed peak" value={meta.peakDb} detail="Source-shifted dB · no re-log / abs" tone={view.peakValue === null ? 'neutral' : 'good'} />
        <Metric label="Vector" value={`${meta.bins} bins`} detail={snapshot?.simulation ? 'Synthetic vector · not measured' : available ? 'Data Out vector' : 'No active vector'} tone={view.fresh ? 'good' : 'neutral'} />
      </div>
    </Panel>
  );
}
