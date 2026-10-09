import type { JSX } from 'react';
import type { MqttSnapshot, TelemetrySnapshot } from '../types';
import { candidate, formatAge, formatNumber, numberOrNull, syncCount, toneFor } from '../lib/telemetry';
import { useI18n } from '../lib/i18n';
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
      <div className="subsystem-text"><span>{name}</span><strong>{detail}</strong></div>
      <StatusBadge label={state} tone={toneFor(state)} />
    </article>
  );
}

export function SystemHealthPage({ snapshot, mqtt, localSnapshotFresh }: { snapshot: TelemetrySnapshot | null; mqtt: MqttSnapshot | null; localSnapshotFresh: boolean }): JSX.Element {
  const { t } = useI18n();
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
    [t('health.row.dataOut'), status?.available === true ? 'AVAILABLE' : 'UNAVAILABLE', t('health.row.dataOutDetail')],
    [t('health.row.daq'), status?.daq_health ?? (statusValue(status, 'daq_ok') === true ? 'PASS' : 'N/A'), t('health.row.daqDetail')],
    [t('health.row.gps'), statusValue(status, 'gps_status') ?? 'UNKNOWN', t('health.row.gpsDetail')],
    [t('health.row.frame'), daq.data_frame_index, t('health.row.nativeField')],
    [t('health.row.dropped'), dropped, t('health.row.nativeField')],
    [t('health.row.syncFlags'), sync, 'frame / delay / IQ'],
    [t('health.row.csv'), csv.available === true ? t('health.row.ageAtRead', { format: csv.source_format?.toUpperCase() ?? 'CSV', age: formatAge(csv.freshness) }) : 'UNAVAILABLE', t('health.row.nativeView')],
    [t('health.row.xml'), xml.available === true ? t('health.row.ageAtRead', { format: xml.source_format?.toUpperCase() ?? 'XML', age: formatAge(xml.freshness) }) : 'UNAVAILABLE', t('health.row.nativeView')],
  ];
  return (
    <div className="page">
      <SectionHeading eyebrow={t('health.eyebrow')} title={t('health.title')} detail={t('health.detail')} />
      {snapshot && !localSnapshotFresh ? <div className="dry-run-notice stale-evidence-banner" role="status"><strong>{t('common.staleEvidence')}</strong> {t('health.stale')}</div> : null}
      <div className="health-summary-grid">
        <div className="health-column">
          <Panel className="health-summary-panel" eyebrow={t('health.summaryEyebrow')} title={t('health.summaryTitle')}>
            <div className="health-summary-main"><StatusBadge label={dataState} tone={toneFor(dataState)} /><strong>{overall}</strong><span>{snapshot ? t('health.classified') : t('health.noResponse')}</span></div>
            <div className="metric-grid three"><Metric label="DAQ" value={status?.daq_health ?? 'N/A'} detail={dropped === null ? t('health.dropsNa') : t('health.drops', { count: dropped })} tone={toneFor(status?.daq_health)} /><Metric label={t('health.sync')} value={sync} detail={t('health.syncDetail')} tone={sync === '3 / 3' ? 'good' : 'warn'} /><Metric label="MQTT" value={connection} detail={mqtt?.read_only === false ? t('health.unexpectedWrite') : t('health.subscriberOnly')} tone={mqtt?.connection === 'connected' ? 'good' : 'warn'} /></div>
          </Panel>
          <Panel className="subsystems-panel" eyebrow={t('health.subsystemsEyebrow')} title={t('health.subsystemsTitle')}>
            <div className="subsystem-grid">
              <Subsystem name="Data Out / HTTP" state={status?.available === true && localSnapshotFresh ? 'AVAILABLE' : status?.available === false ? 'UNAVAILABLE' : 'STALE'} detail={t('health.sub.http')} />
              <Subsystem name={t('health.sub.daq')} state={String(status?.daq_health ?? 'UNKNOWN')} detail={dropped === null ? t('health.sub.dropsUnavailable') : t('health.drops', { count: formatNumber(dropped, 0) })} />
              <Subsystem name={t('health.sub.doa')} state={snapshot?.native_consistency?.conflict ? 'CONFLICT' : csv.available === true && xml.available === true ? 'PRESENT' : 'INCOMPLETE'} detail={t('health.sub.doaDetail')} />
              <Subsystem name={t('health.sub.clock')} state="UNVERIFIED" detail={t('health.sub.clockDetail')} />
              <Subsystem name={t('health.sub.mqtt')} state={connection} detail={mqtt?.publish_enabled === false ? t('health.sub.publishDisabled') : t('health.sub.noMonitor')} />
            </div>
          </Panel>
        </div>
        <Panel className="inspector-panel" eyebrow={t('health.inspectorEyebrow')} title={t('health.inspectorTitle')}>
          <div className="key-value-list">{nodeRows.map(([label, value, detail]) => <KeyValue key={label} label={label} value={typeof value === 'number' ? formatNumber(value, 0) : String(value ?? 'N/A')} detail={detail} />)}</div>
        </Panel>
      </div>
    </div>
  );
}
