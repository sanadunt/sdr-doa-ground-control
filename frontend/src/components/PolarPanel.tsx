import type { JSX } from 'react';
import { useEffect, useRef } from 'react';
import type { PolarSettings, TelemetrySnapshot } from '../types';
import { polarDataReady } from '../lib/telemetry';
import { canonicalLabel, displayLabel, drawPolarCanvas, polarMetadata, polarView } from '../lib/polar';
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previousSettings = useRef<PolarSettings>({ figType: 'Polar', compassOffset: 0 });
  const liveView = polarView(snapshot, previousSettings.current, localSnapshotFresh, null, compassSettings);
  const view = { ...liveView, settings: compassSettings };
  previousSettings.current = compassSettings;
  const meta = polarMetadata(view);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const redraw = () => drawPolarCanvas(canvas, view.values, view.fresh, view.settings);
    redraw();
    const parent = canvas.closest('.polar-frame');
    const observer = typeof ResizeObserver === 'function' && parent ? new ResizeObserver(redraw) : null;
    observer?.observe(parent as Element);
    window.addEventListener('resize', redraw);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', redraw);
    };
  }, [view.values, view.fresh, view.settings]);

  const available = view.fresh && polarDataReady(snapshot) && localSnapshotFresh;
  const retainedCanonical = view.canonicalAngle !== null && !available;
  return (
    <Panel
      className="polar-panel"
      eyebrow="SIGNAL / POLAR 40"
      title="Angular response"
      action={<StatusBadge label={available ? 'AVAILABLE' : 'UNAVAILABLE'} tone={available ? 'good' : 'warn'} />}
    >
      <div className="polar-frame">
        <canvas ref={canvasRef} aria-label={available ? '360 bin angular response plot' : 'Angular response unavailable'} />
        {!available ? <div className="polar-empty"><EmptyState label="POLAR UNAVAILABLE" detail={localSnapshotFresh ? view.reason : 'Local snapshot expired; curve cleared until the next bounded read.'} tone="warn" /></div> : null}
        <div className="polar-center-note" aria-hidden="true">{available ? <><span>θ₀ SOURCE</span><strong>{canonicalLabel(view)}</strong></> : <><span>NO ACTIVE θ₀ SOURCE</span><strong>—°</strong></>}</div>
      </div>
      <div className="polar-meta-grid">
        <Metric label={retainedCanonical ? 'Canonical source · last-read metadata' : 'Canonical source'} value={meta.canonical} detail={retainedCanonical ? 'Last-read metadata only; not an active source' : 'Upstream θ₀; not a plotted display peak'} tone={view.canonicalAngle === null ? 'neutral' : retainedCanonical ? 'warn' : 'good'} />
        <Metric label="Plotted display peak" value={meta.peak} detail={displayLabel(view)} tone={view.displayPeak === null ? 'neutral' : 'good'} />
        <Metric label="Signed peak" value={meta.peakDb} detail="Source-shifted dB · no re-log / abs" tone={view.peakValue === null ? 'neutral' : 'good'} />
        <Metric label="Vector" value={`${meta.bins} bins`} detail={available ? 'Data Out vector' : 'No active vector'} tone={view.fresh ? 'good' : 'neutral'} />
      </div>
    </Panel>
  );
}
