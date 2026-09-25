import type { JSX } from 'react';
import type { TelemetrySnapshot } from '../types';
import { candidate, consistencyRelation, eventItems, formatAge, formatNumber, GATE_REASON_LABELS, nativeViewsReady, reasonLabel, safeJson, toneFor } from '../lib/telemetry';
import { KeyValue, Metric, Panel, SectionHeading, StatusBadge } from '../components/ui';

function checkLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (value) => value.toUpperCase());
}

export function DoADiagnosticsPage({ snapshot, localSnapshotFresh }: { snapshot: TelemetrySnapshot | null; localSnapshotFresh: boolean }): JSX.Element {
  const gate = snapshot?.publication_gate;
  const checks = gate?.checks ?? {};
  const reasons = gate?.reasons ?? [];
  const csv = candidate(snapshot, 'csv');
  const xml = candidate(snapshot, 'xml');
  const fields = snapshot?.settings?.fields ?? {};
  const events = eventItems(snapshot);
  return (
    <div className="page">
      <SectionHeading eyebrow="EVIDENCE / DOA" title="DoA diagnostics" detail="Every gate is shown independently; observability is not delivery readiness." />
      {snapshot && !localSnapshotFresh ? <div className="dry-run-notice stale-evidence-banner" role="status"><strong>STALE EVIDENCE</strong> This page is showing the last local Data Out snapshot; gate and native records are not current.</div> : null}
      <div className="diagnostics-top-grid">
        <Panel className="gate-panel" eyebrow="DELIVERY GATE" title="Publication ledger" action={<StatusBadge label={String(gate?.state ?? 'BLOCKED').toUpperCase()} tone={gate?.state === 'READY' ? 'good' : 'warn'} />}>
          <div className="gate-ledger">
            {Object.entries(checks).map(([key, value]) => <div className="gate-row" key={key}><span className={value === true ? 'gate-pass' : value === false ? 'gate-fail' : 'gate-neutral'} aria-hidden="true">{value === true ? '✓' : value === false ? '×' : '·'}</span><strong>{checkLabel(key)}</strong><span>{value === true ? 'PASS' : value === false ? 'BLOCKED' : 'NOT CONFIGURED'}</span></div>)}
            {!Object.keys(checks).length ? <div className="empty-inline">No gate response yet.</div> : null}
          </div>
          <div className="reason-list"><div className="panel-eyebrow">BLOCK REASONS</div>{reasons.length ? reasons.map((reason) => <div className="reason-row" key={reason}><span>!</span><span>{GATE_REASON_LABELS[reason] ? reasonLabel(reason) : reason}</span></div>) : <div className="empty-inline">No blocking reasons reported.</div>}</div>
        </Panel>
        <Panel className="ledger-panel" eyebrow="NATIVE RECORDS" title="Detection ledger">
          <div className="native-records">
            {(['csv', 'xml'] as const).map((name) => {
              const item = name === 'csv' ? csv : xml;
              return <article className="native-record" key={name}><div className="native-record-head"><strong>{name.toUpperCase()}</strong><StatusBadge label={item.available === true ? 'PRESENT' : 'MISSING'} tone={item.available === true ? 'good' : 'warn'} /></div><div className="native-record-grid"><KeyValue label="Raw angle" value={item.doa_raw_deg === undefined ? 'N/A' : `${formatNumber(item.doa_raw_deg)}°`} detail={String(item.angle_convention ?? 'native')} /><KeyValue label="Canonical" value={item.canonical_angle_deg === undefined ? 'N/A' : `${formatNumber(item.canonical_angle_deg)}°`} detail="collector conversion" /><KeyValue label="Age at read" value={formatAge(item.freshness)} detail={item.freshness?.fresh === true ? 'within freshness window at read' : 'not fresh at read'} /><KeyValue label="Units" value={item.native_metrics_state ?? 'N/A'} detail={item.contract_mapping_state ?? 'N/A'} /></div></article>;
            })}
          </div>
          <div className="consistency-readout"><span>CSV / XML relation</span><strong>{consistencyRelation(snapshot?.native_consistency)}</strong><small>distance {formatNumber(snapshot?.native_consistency?.circular_distance_deg)}° · comparability remains explicit</small></div>
        </Panel>
      </div>
      <div className="diagnostics-bottom-grid">
        <Panel className="operator-panel" eyebrow="SNAPSHOT-DERIVED / NOT PERSISTENT HISTORY" title="Operator log">
          <ol className="operator-log">{events.map((event, index) => <li key={`${event.label}-${index}`}><span className="log-index">{String(index + 1).padStart(2, '0')}</span><div><strong>{event.label}</strong><span>{event.detail}</span></div></li>)}</ol>
        </Panel>
        <Panel className="effective-config-panel" eyebrow="READ-ONLY VIEW" title="Effective config">
          <div className="config-readout"><KeyValue label="Selected authority" value={snapshot?.authority?.selected ?? 'NONE'} detail="No automatic selection" /><KeyValue label="Angle readiness" value={snapshot?.authority?.canonical_angle_ready === true ? 'READY' : 'NOT CONFIGURED'} detail="Deployment decision required" /><KeyValue label="Native views" value={nativeViewsReady(snapshot) && localSnapshotFresh ? 'FRESH / COMPARABLE' : 'NOT READY'} detail="local elapsed expiry applied" /><KeyValue label="Settings source" value={snapshot?.settings?.redacted === true ? 'REDACTED FIELDS' : 'UNAVAILABLE'} detail="Raw settings omitted by collector" />{Object.entries(fields).filter(([key]) => !/(pass|secret|token|key|credential)/i.test(key)).slice(0, 12).map(([key, value]) => <KeyValue key={key} label={key.replace(/_/g, ' ')} value={typeof value === 'boolean' ? (value ? 'ON' : 'OFF') : String(value)} />)}</div>
          <pre className="diagnostic-note">{safeJson({ local_snapshot_fresh: localSnapshotFresh, raw_settings_omitted: snapshot?.settings?.raw_fields_omitted ?? true })}</pre>
        </Panel>
      </div>
    </div>
  );
}
