import type { JSX } from 'react';
import type { MqttSnapshot, TelemetrySnapshot } from '../types';
import { candidate, formatAge, formatNumber, numberOrNull, syncCount, toneFor } from '../lib/telemetry';
import { KeyValue, Metric, Panel, SectionHeading, StatusBadge } from '../components/ui';

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function statusValue(status: TelemetrySnapshot['status'], key: string): unknown {
  return status?.safe?.[key] ?? status?.[key];
}

function Subsystem({ name, state, detail }: { name: string; state: string; detail: string }): JSX.Element {
  return (
    <article className="subsystem-card">
      <div className="subsystem-top"><span>{name}</span><StatusBadge label={state} tone={toneFor(state)} /></div>
      <strong>{detail}</strong>
    </article>
  );
}

export function SystemHealthPage({ snapshot, mqtt, localSnapshotFresh }: { snapshot: TelemetrySnapshot | null; mqtt: MqttSnapshot | null; localSnapshotFresh: boolean }): JSX.Element {
  const status = snapshot?.status;
  const daq = safeRecord(statusValue(status, 'daq_status'));
  const dropped = numberOrNull(statusValue(status, 'daq_num_dropped_frames'));
  const overall = localSnapshotFresh ? String(snapshot?.overall_state ?? 'WAITING').toUpperCase() : snapshot ? 'STALE' : 'WAITING';
  const dataState = status?.available === true && localSnapshotFresh ? 'AVAILABLE' : status?.available === false ? 'UNAVAILABLE' : overall;
  const sync = `${syncCount(snapshot)} / 3`;
  const connection = String(mqtt?.connection ?? 'OFF').toUpperCase();
  const csv = candidate(snapshot, 'csv');
  const xml = candidate(snapshot, 'xml');
  const nodeRows: Array<[string, unknown, string]> = [
    ['Data Out status', status?.available === true ? 'AVAILABLE' : 'UNAVAILABLE', 'GET-only collector response'],
    ['DAQ health', status?.daq_health ?? (statusValue(status, 'daq_ok') === true ? 'PASS' : 'N/A'), 'Input and frame path'],
    ['GPS status', statusValue(status, 'gps_status') ?? 'UNKNOWN', 'Position gate input'],
    ['Frame index', daq.data_frame_index, 'Native status field'],
    ['Dropped frames', dropped, 'Native status field'],
    ['Sync flags', sync, 'frame / delay / IQ'],
    ['CSV source', csv.available === true ? `${csv.source_format?.toUpperCase() ?? 'CSV'} · age at read ${formatAge(csv.freshness)}` : 'UNAVAILABLE', 'DoA native view'],
    ['XML source', xml.available === true ? `${xml.source_format?.toUpperCase() ?? 'XML'} · age at read ${formatAge(xml.freshness)}` : 'UNAVAILABLE', 'DoA native view'],
  ];
  return (
    <div className="page">
      <SectionHeading eyebrow="RUNTIME / HEALTH" title="System health" detail="A bounded inspector for the local collector, node status, and subscriber path. Identifiers are intentionally withheld." />
      {snapshot && !localSnapshotFresh ? <div className="dry-run-notice stale-evidence-banner" role="status"><strong>STALE EVIDENCE</strong> This page is showing the last local Data Out snapshot; health values are not current.</div> : null}
      <div className="health-summary-grid">
        <Panel className="health-summary-panel" eyebrow="SUMMARY" title="System Summary">
          <div className="health-summary-main"><StatusBadge label={dataState} tone={toneFor(dataState)} /><strong>{overall}</strong><span>{snapshot ? 'Last Data Out response classified locally.' : 'No Data Out response has been read.'}</span></div>
          <div className="metric-grid three"><Metric label="DAQ" value={status?.daq_health ?? 'N/A'} detail={dropped === null ? 'drops N/A' : `${dropped} dropped frames`} tone={toneFor(status?.daq_health)} /><Metric label="Sync" value={sync} detail="required flags passing" tone={sync === '3 / 3' ? 'good' : 'warn'} /><Metric label="MQTT" value={connection} detail={mqtt?.read_only === false ? 'unexpected write capability' : 'subscriber-only'} tone={mqtt?.connection === 'connected' ? 'good' : 'warn'} /></div>
        </Panel>
        <Panel className="inspector-panel" eyebrow="INSPECTOR" title="Node Inspector">
          <div className="key-value-list">{nodeRows.map(([label, value, detail]) => <KeyValue key={label} label={label} value={typeof value === 'number' ? formatNumber(value, 0) : String(value ?? 'N/A')} detail={detail} />)}</div>
        </Panel>
      </div>
      <Panel className="subsystems-panel" eyebrow="SUBSYSTEMS" title="Subsystem status">
        <div className="subsystem-grid">
          <Subsystem name="Data Out / HTTP" state={status?.available === true && localSnapshotFresh ? 'AVAILABLE' : status?.available === false ? 'UNAVAILABLE' : 'STALE'} detail="Bounded GET response" />
          <Subsystem name="DAQ / acquisition" state={String(status?.daq_health ?? 'UNKNOWN')} detail={dropped === null ? 'Drop counter unavailable' : `${formatNumber(dropped, 0)} dropped frames`} />
          <Subsystem name="DoA / native views" state={snapshot?.native_consistency?.conflict ? 'CONFLICT' : csv.available === true && xml.available === true ? 'PRESENT' : 'INCOMPLETE'} detail="CSV and XML are not merged" />
          <Subsystem name="Ground clock" state="UNVERIFIED" detail="Remote node clock is not asserted" />
          <Subsystem name="MQTT monitor" state={connection} detail={mqtt?.publish_enabled === false ? 'Publish disabled' : 'No monitor'} />
        </div>
      </Panel>
    </div>
  );
}
