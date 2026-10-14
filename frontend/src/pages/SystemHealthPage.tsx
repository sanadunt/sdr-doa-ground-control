import type { JSX, ReactNode } from 'react';
import type { Candidate, MqttSnapshot, TelemetrySnapshot, Tone } from '../types';
import type { ConsoleCapabilities } from '../api';
import { configPatchPublishable } from '../lib/configPatch';
import { candidate, formatNumber, numberOrNull, syncCount, toneFor } from '../lib/telemetry';
import { useI18n } from '../lib/i18n';
import type { Translate } from '../lib/i18n';
import {
  candidateIssue,
  collectionView,
  dataOutHttp,
  errorKindKey,
  evidenceExpired,
  formatAgeText,
  formatDuration,
  healthHeadline,
  nodeProgressView,
  nodeStatus,
  resourceRows,
  signalQualityView,
  stateTone,
} from '../lib/healthView';
import type { NodeProgressView, ResourceRow, SignalQualityView } from '../lib/healthView';
import { CollectorError, KeyValue, Metric, Panel, SectionHeading, StatusBadge } from '../components/ui';

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function statusValue(status: TelemetrySnapshot['status'], key: string): unknown {
  return status?.safe?.[key] ?? status?.[key];
}

function Subsystem({ name, state, tone, detail }: { name: string; state: string; tone?: Tone; detail: ReactNode }): JSX.Element {
  return (
    <article className="subsystem-card">
      <div className="subsystem-top"><span>{name}</span><StatusBadge label={state} tone={tone ?? stateTone(state)} /></div>
      <strong>{detail}</strong>
    </article>
  );
}

function progressDetail(t: Translate, progress: NodeProgressView | null): string {
  if (!progress) return t('health.progress.notReported');
  const regressed = progress.regressedCounters.length ? ` ${t('health.progress.regressed', { counters: progress.regressedCounters.join(', ') })}` : '';
  switch (progress.state) {
    case 'STALLED':
      return t('health.progress.stalled', {
        counters: progress.stalledCounters.join(', ') || 'status',
        age: progress.longestUnchangedMs === null ? 'N/A' : formatDuration(t, progress.longestUnchangedMs),
      }) + regressed;
    case 'ADVANCING': return t('health.progress.advancing') + regressed;
    case 'UNCHANGED':
      return t('health.progress.unchanged', {
        age: progress.longestUnchangedMs === null ? 'N/A' : formatDuration(t, progress.longestUnchangedMs),
      });
    case 'FIRST_SAMPLE': return t('health.progress.firstSample');
    case 'UNAVAILABLE': return t('health.progress.unavailable');
    case 'UNTRACKED': return t('health.progress.untracked');
    default: return t('health.progress.notReported');
  }
}

/** Name the Data Out file that reported the ADC state, not the collector's internal source id. */
export function overdriveSourceFile(source: string): string {
  if (source === 'status') return 'status.json';
  if (source === 'xml') return 'doa.xml';
  return source;
}

function overdriveDetail(t: Translate, quality: SignalQualityView | null): string {
  if (!quality || quality.state === 'UNKNOWN') return t('health.adc.unknown');
  const sources = (quality.state === 'OVERDRIVE' ? quality.overdriveSources : quality.reportedBy).map(overdriveSourceFile).join(', ') || 'N/A';
  const mask = quality.channelMask === null ? '' : ` · ${t('health.adc.mask', { mask: `0b${quality.channelMask.toString(2)}` })}`;
  return quality.state === 'OVERDRIVE' ? t('health.adc.overdrive', { sources }) + mask : t('health.adc.pass', { sources });
}

function sourceRow(t: Translate, item: Candidate, fallback: 'CSV' | 'XML'): [string, ReactNode] {
  const issue = candidateIssue(item);
  if (item.available !== true) return ['UNAVAILABLE', issue.error ? <CollectorError error={issue.error} /> : t('health.row.nativeView')];
  const value = t('health.row.ageAtRead', { format: item.source_format?.toUpperCase() ?? fallback, age: formatAgeText(t, item.freshness) });
  return [value, issue.quarantined ? t('health.row.quarantined', { error: issue.quarantined }) : t('health.row.nativeView')];
}

function resourceResult(t: Translate, row: ResourceRow): { label: string; tone: Tone } {
  if (row.ok === true) return { label: row.httpStatus === null ? 'OK' : `HTTP ${row.httpStatus}`, tone: 'good' };
  if (row.ok === false) return { label: t(errorKindKey(row.errorKind)), tone: row.errorKind === 'skipped' ? 'warn' : 'bad' };
  return { label: 'N/A', tone: 'neutral' };
}

function ResourcesPanel({ snapshot }: { snapshot: TelemetrySnapshot | null }): JSX.Element {
  const { t } = useI18n();
  const rows = resourceRows(snapshot);
  const collection = collectionView(snapshot);
  return (
    <Panel className="resources-panel" eyebrow={t('health.resourcesEyebrow')} title={t('health.resourcesTitle')}>
      {snapshot ? (
        <div className="table-wrap" tabIndex={0} role="region" aria-label={t('health.resourcesTitle')}>
          <table className="resource-table">
            <thead><tr><th scope="col">{t('health.res.path')}</th><th scope="col">{t('health.res.result')}</th><th scope="col">{t('health.res.detail')}</th><th scope="col">{t('health.res.time')}</th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const result = resourceResult(t, row);
                const time = row.elapsedMs === null ? null : formatDuration(t, row.elapsedMs);
                const retried = row.attempts !== null && row.attempts > 1;
                return (
                  <tr key={row.path}>
                    <td><code>{row.path}</code></td>
                    <td><span className={`resource-result status-text-${result.tone}`}>{result.label}</span></td>
                    <td className="resource-detail">{row.ok === false ? row.error ? <CollectorError error={row.error} /> : t('health.res.noDetail') : row.ok === true ? t('health.res.received') : t('health.res.notReported')}</td>
                    <td>{time !== null && retried ? t('health.res.attempts', { time, count: row.attempts ?? 0 }) : retried ? t('health.res.attemptCount', { count: row.attempts ?? 0 }) : time ?? 'N/A'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <div className="empty-inline resource-empty">{t('health.noResponse')}</div>}
      {collection ? (
        <div className={`collection-note status-text-${collection.deadlineExceeded || collection.statusTransportFailed ? 'warn' : 'neutral'}`}>
          {collection.elapsedMs !== null ? (collection.budgetMs !== null
            ? t('health.collection.budget', { elapsed: formatDuration(t, collection.elapsedMs), budget: formatDuration(t, collection.budgetMs) })
            : t('health.collection.elapsed', { elapsed: formatDuration(t, collection.elapsedMs) })) : null}
          {collection.deadlineExceeded ? <strong> COLLECTION_DEADLINE_EXCEEDED · {t('health.collection.deadline')}</strong> : null}
          {collection.statusTransportFailed ? <strong> {t('health.collection.statusTransport')}</strong> : null}
        </div>
      ) : null}
    </Panel>
  );
}

export function SystemHealthPage({ snapshot, mqtt, mqttError = null, localSnapshotFresh, capabilities = null }: { snapshot: TelemetrySnapshot | null; mqtt: MqttSnapshot | null; mqttError?: string | null; localSnapshotFresh: boolean; capabilities?: ConsoleCapabilities | null }): JSX.Element {
  const { t } = useI18n();
  const status = snapshot?.status;
  const daq = safeRecord(statusValue(status, 'daq_status'));
  const dropped = numberOrNull(statusValue(status, 'daq_num_dropped_frames'));
  const headline = healthHeadline(snapshot, localSnapshotFresh);
  const expired = evidenceExpired(snapshot, localSnapshotFresh);
  const http = dataOutHttp(snapshot);
  const node = nodeStatus(snapshot);
  const progress = nodeProgressView(snapshot);
  const quality = signalQualityView(snapshot);
  const sync = `${syncCount(snapshot)} / 3`;
  // A failed /api/mqtt poll leaves mqtt null; that is a read error, not a monitor that is off.
  const mqttReadFailed = !mqtt && Boolean(mqttError);
  const connection = mqttReadFailed ? 'ERROR' : String(mqtt?.connection ?? 'OFF').toUpperCase();
  const csv = candidate(snapshot, 'csv');
  const xml = candidate(snapshot, 'xml');
  const failedSync = Array.isArray(status?.failed_sync_flags) ? status.failed_sync_flags.filter((flag): flag is string => typeof flag === 'string') : [];
  const missingSync = Array.isArray(status?.missing_sync_flags) ? status.missing_sync_flags.filter((flag): flag is string => typeof flag === 'string') : [];
  const daqHealth = status?.daq_health ?? (statusValue(status, 'daq_ok') === true ? 'PASS' : 'N/A');
  const daqDetail = failedSync.length
    ? t('health.row.syncFailed', { flags: failedSync.join(', ') })
    : missingSync.length ? t('health.row.syncMissing', { flags: missingSync.join(', ') }) : t('health.row.daqDetail');
  const [csvValue, csvDetail] = sourceRow(t, csv, 'CSV');
  const [xmlValue, xmlDetail] = sourceRow(t, xml, 'XML');
  const papr = quality && (quality.paprCsvDb !== null || quality.paprXmlDb !== null)
    ? `CSV ${formatNumber(quality.paprCsvDb, 2)} · XML ${formatNumber(quality.paprXmlDb, 2)} dB`
    : 'N/A';
  const nodeRows: Array<{ label: string; value: string; detail: ReactNode; tone?: Tone }> = [
    { label: t('health.row.nodeStatus'), value: node.state, detail: node.error ? <CollectorError error={node.error} /> : t('health.row.nodeStatusDetail'), tone: stateTone(node.state) },
    { label: t('health.row.daq'), value: String(daqHealth), detail: daqDetail, tone: toneFor(daqHealth) },
    { label: t('health.row.progress'), value: progress?.state ?? 'N/A', detail: progressDetail(t, progress), tone: progress ? stateTone(progress.state) : undefined },
    { label: t('health.row.adc'), value: quality?.state ?? 'N/A', detail: overdriveDetail(t, quality), tone: quality?.state === 'OVERDRIVE' ? 'bad' : quality?.state === 'PASS' ? 'good' : undefined },
    { label: t('health.row.snr'), value: quality?.snrDb === null || !quality ? 'N/A' : `${formatNumber(quality.snrDb, 1)} dB`, detail: t('health.row.snrDetail') },
    { label: t('health.row.papr'), value: papr, detail: t('health.row.paprDetail') },
    { label: t('health.row.gps'), value: String(statusValue(status, 'gps_status') ?? 'UNKNOWN'), detail: t('health.row.gpsDetail') },
    { label: t('health.row.frame'), value: typeof daq.data_frame_index === 'number' ? formatNumber(daq.data_frame_index, 0) : 'N/A', detail: t('health.row.nativeField') },
    { label: t('health.row.dropped'), value: dropped === null ? 'N/A' : formatNumber(dropped, 0), detail: t('health.row.nativeField') },
    { label: t('health.row.syncFlags'), value: sync, detail: 'frame / delay / IQ' },
    { label: t('health.row.noiseSource'), value: quality?.noiseSourceEnabled === true ? 'ON' : quality?.noiseSourceEnabled === false ? 'OFF' : 'N/A', detail: t('health.row.nativeField') },
    { label: t('health.row.csv'), value: csvValue, detail: csvDetail, tone: csv.available === true ? undefined : snapshot ? 'warn' : undefined },
    { label: t('health.row.xml'), value: xmlValue, detail: xmlDetail, tone: xml.available === true ? undefined : snapshot ? 'warn' : undefined },
  ];
  const viewsPresent = [csv, xml].filter((item) => item.available === true).length;
  const doaState = !snapshot ? 'WAITING'
    : snapshot.native_consistency?.conflict ? 'CONFLICT'
      : viewsPresent === 0 ? 'MISSING'
        : viewsPresent === 1 ? 'INCOMPLETE'
          : candidateIssue(csv).quarantined || candidateIssue(xml).quarantined ? 'INVALID' : 'PRESENT';
  return (
    <div className="page">
      <SectionHeading eyebrow={t('health.eyebrow')} title={t('health.title')} detail={t('health.detail')} />
      {expired ? <div className="dry-run-notice stale-evidence-banner" role="status"><strong>{t('common.staleEvidence')}</strong> {t('health.stale')}</div> : null}
      <div className="health-summary-grid">
        <Panel className="health-summary-panel" eyebrow={t('health.summaryEyebrow')} title={t('health.summaryTitle')}>
          <div className="health-summary-main">
            <div className="health-summary-http"><span>{t('health.summaryHttp')}</span><StatusBadge label={http.state} tone={stateTone(http.state)} /></div>
            <strong className={`health-headline headline-${stateTone(headline)}`}>{headline}</strong>
            <span>{snapshot ? t('health.classified') : t('health.noResponse')}</span>
          </div>
          <div className="metric-grid three"><Metric label="DAQ" value={status?.daq_health ?? 'N/A'} detail={dropped === null ? t('health.dropsNa') : t('health.drops', { count: dropped })} tone={toneFor(status?.daq_health)} /><Metric label={t('health.sync')} value={sync} detail={t('health.syncDetail')} tone={sync === '3 / 3' ? 'good' : 'warn'} /><Metric label="MQTT" value={connection} detail={mqttReadFailed ? mqttError ?? '' : mqtt?.read_only === false ? t('health.unexpectedWrite') : t('health.subscriberOnly')} tone={mqttReadFailed ? 'bad' : mqtt?.connection === 'connected' ? 'good' : 'warn'} /></div>
        </Panel>
        <Panel className="inspector-panel" eyebrow={t('health.inspectorEyebrow')} title={t('health.inspectorTitle')}>
          <div className="key-value-list">{nodeRows.map((row) => <KeyValue key={row.label} label={row.label} value={row.value} detail={row.detail} tone={row.tone} />)}</div>
        </Panel>
      </div>
      <ResourcesPanel snapshot={snapshot} />
      <Panel className="subsystems-panel" eyebrow={t('health.subsystemsEyebrow')} title={t('health.subsystemsTitle')}>
        <div className="subsystem-grid">
          <Subsystem name="Data Out / HTTP" state={http.state} detail={http.reported ? t('health.sub.httpDetail', { ok: http.ok, total: http.total }) : t('health.sub.httpUnknown')} />
          <Subsystem name={t('health.sub.node')} state={node.state} detail={node.error ? <CollectorError error={node.error} /> : t('health.row.nodeStatusDetail')} />
          <Subsystem name={t('health.sub.daq')} state={String(status?.daq_health ?? 'UNKNOWN')} detail={dropped === null ? t('health.sub.dropsUnavailable') : t('health.drops', { count: formatNumber(dropped, 0) })} />
          <Subsystem name={t('health.sub.progress')} state={progress?.state ?? 'N/A'} detail={progressDetail(t, progress)} />
          <Subsystem name={t('health.sub.doa')} state={doaState} detail={t('health.sub.doaDetail')} />
          <Subsystem name={t('health.sub.clock')} state="UNVERIFIED" detail={t('health.sub.clockDetail')} />
          <Subsystem name={t('health.sub.mqtt')} state={connection} detail={mqtt?.publish_enabled === false ? t(configPatchPublishable(capabilities) ? 'health.sub.publishAdminOnly' : 'health.sub.publishUnavailable') : t('health.sub.noMonitor')} />
        </div>
      </Panel>
    </div>
  );
}
