import type { JSX, ReactNode } from 'react';
import type { Candidate, MqttSnapshot, TelemetrySnapshot, Tone } from '../types';
import type { ConsoleCapabilities } from '../api';
import { configPatchPublishable } from '../lib/configPatch';
import { lastMessageAgeMs } from '../lib/mqttMonitor';
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
  formatCount,
  formatDuration,
  healthHeadline,
  nodeProgressView,
  nodeStatus,
  resourceRows,
  signalQualityView,
  stateTone,
  syncFlagsView,
} from '../lib/healthView';
import type { NodeProgressView, ResourceRow, SignalQualityView } from '../lib/healthView';
import { CollectorError } from '../components/ui';
import { Card, DataTable, EmptyState, KeyValueGrid, Notice, Page, PageGrid, PageHeader, PageStack, StatRow, StatTile, StatusChip, Tag } from '../components/page';
import type { DataColumn, KeyValueItem, PageTone } from '../components/page';

function statusValue(status: TelemetrySnapshot['status'], key: string): unknown {
  return status?.safe?.[key] ?? status?.[key];
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/**
 * The cause behind a progress state, for the tooltip of the progress value and
 * the stall notice: which counters stalled or went backwards, or that
 * status.json was unusable. A state without a cause (ADVANCING, UNCHANGED with
 * its age beside the chip, FIRST_SAMPLE, UNTRACKED) gets none.
 */
function progressCause(t: Translate, progress: NodeProgressView | null): string | undefined {
  if (!progress) return undefined;
  const regressed = progress.regressedCounters.length ? t('health.progress.regressed', { counters: progress.regressedCounters.join(', ') }) : '';
  switch (progress.state) {
    case 'STALLED':
      return [t('health.progress.stalled', {
        counters: progress.stalledCounters.join(', ') || 'status',
        age: progress.longestUnchangedMs === null ? 'N/A' : formatDuration(t, progress.longestUnchangedMs),
      }), regressed].filter(Boolean).join(' ');
    case 'UNAVAILABLE': return t('health.progress.unavailable');
    default: return regressed || undefined;
  }
}

/** Name the Data Out file that reported the ADC state, not the collector's internal source id. */
export function overdriveSourceFile(source: string): string {
  if (source === 'status') return 'status.json';
  if (source === 'xml') return 'doa.xml';
  return source;
}

function channelMask(mask: number | null): string | null {
  return mask === null ? null : `0b${mask.toString(2)}`;
}

function overdriveNotice(t: Translate, quality: SignalQualityView): string {
  const sources = quality.overdriveSources.map(overdriveSourceFile).join(', ') || 'N/A';
  const mask = channelMask(quality.channelMask);
  return t('health.adc.overdrive', { sources }) + (mask ? ` · ${t('health.adc.mask', { mask })}` : '');
}

function resourceResult(t: Translate, row: ResourceRow): { label: string; tone: Tone } {
  if (row.reused && row.ok === true) return { label: 'REUSED', tone: 'neutral' };
  if (row.ok === true) return { label: row.httpStatus === null ? 'OK' : `HTTP ${row.httpStatus}`, tone: 'good' };
  if (row.ok === false) return { label: t(errorKindKey(row.errorKind)), tone: row.errorKind === 'skipped' ? 'warn' : 'bad' };
  return { label: 'N/A', tone: 'neutral' };
}

function resourceTime(t: Translate, row: ResourceRow): string {
  if (row.reused) return row.reusedAgeMs === null ? 'N/A' : t('health.res.age', { age: formatDuration(t, row.reusedAgeMs) });
  const time = row.elapsedMs === null ? null : formatDuration(t, row.elapsedMs);
  const retried = row.attempts !== null && row.attempts > 1;
  if (time !== null && retried) return t('health.res.attempts', { time, count: row.attempts ?? 0 });
  if (retried) return t('health.res.attemptCount', { count: row.attempts ?? 0 });
  return time ?? 'N/A';
}

function DataOutCard({ snapshot }: { snapshot: TelemetrySnapshot | null }): JSX.Element {
  const { t } = useI18n();
  const rows = resourceRows(snapshot);
  const http = dataOutHttp(snapshot);
  const collection = collectionView(snapshot);
  const failed = rows.some((row) => row.ok === false);
  const collector = snapshot?.collector && typeof snapshot.collector === 'object' ? snapshot.collector as Record<string, unknown> : null;
  const baseUrl = typeof collector?.base_url === 'string' ? collector.base_url.slice(0, 120) : null;
  const columns: Array<DataColumn<ResourceRow>> = [
    { key: 'path', label: t('health.res.path'), code: true, className: 'hd-nowrap', render: (row) => row.path },
    {
      key: 'result',
      label: t('health.res.result'),
      render: (row) => {
        const result = resourceResult(t, row);
        return <StatusChip code={result.label} tone={result.tone} />;
      },
    },
    { key: 'time', label: t('health.res.time'), numeric: true, render: (row) => resourceTime(t, row) },
  ];
  if (failed) {
    columns.push({
      key: 'detail',
      label: t('health.res.detail'),
      className: 'hd-error-cell',
      render: (row) => row.ok === false ? row.error ? <CollectorError error={row.error} /> : t('health.res.noDetail') : null,
    });
  }
  const timing = collection && collection.elapsedMs !== null
    ? `${formatDuration(t, collection.elapsedMs)}${collection.budgetMs !== null ? ` / ${formatDuration(t, collection.budgetMs)}` : ''}`
    : null;
  return (
    <Card
      title="Data Out"
      chip={<StatusChip code={http.state} title={baseUrl ?? undefined} />}
      actions={timing ? <span className="pg-card-meta">{timing}</span> : null}
      flush
    >
      {collection?.deadlineExceeded || collection?.statusTransportFailed ? (
        <div className="hd-card-notices">
          {collection.deadlineExceeded ? <Notice tone="bad" title="COLLECTION_DEADLINE_EXCEEDED">{t('health.collection.deadline')}</Notice> : null}
          {collection.statusTransportFailed ? <Notice tone="bad" title="status.json">{t('health.collection.statusTransport')}</Notice> : null}
        </div>
      ) : null}
      {snapshot
        ? <DataTable columns={columns} rows={rows} rowKey={(row) => row.path} label="Data Out" stack={failed} />
        : <EmptyState label={t('health.noResponse')} code="WAITING" />}
    </Card>
  );
}

type ViewRow = { name: 'CSV' | 'XML'; item: Candidate };

function viewState(item: Candidate): string {
  if (item.available !== true) return 'MISSING';
  return candidateIssue(item).quarantined ? 'INVALID' : 'PRESENT';
}

function DoaViewsCard({ snapshot }: { snapshot: TelemetrySnapshot | null }): JSX.Element {
  const { t } = useI18n();
  const rows: ViewRow[] = [{ name: 'CSV', item: candidate(snapshot, 'csv') }, { name: 'XML', item: candidate(snapshot, 'xml') }];
  const present = rows.filter((row) => row.item.available === true).length;
  const state = !snapshot ? 'WAITING'
    : snapshot.native_consistency?.conflict ? 'CONFLICT'
      : present === 0 ? 'MISSING'
        : present === 1 ? 'INCOMPLETE'
          : rows.some((row) => candidateIssue(row.item).quarantined) ? 'INVALID' : 'PRESENT';
  const issues = rows.some((row) => {
    const issue = candidateIssue(row.item);
    return Boolean(issue.error || issue.quarantined);
  });
  const columns: Array<DataColumn<ViewRow>> = [
    { key: 'view', label: t('health.views.view'), code: true, width: '72px', render: (row) => row.name },
    { key: 'state', label: t('health.views.state'), render: (row) => <StatusChip code={viewState(row.item)} /> },
    {
      key: 'age',
      label: t('diag.ageAtRead'),
      numeric: true,
      render: (row) => row.item.available === true
        ? <span className={row.item.freshness?.fresh === true ? undefined : 'pg-text-warn'}>{formatAgeText(t, row.item.freshness)}</span>
        : 'N/A',
    },
  ];
  if (issues) {
    columns.push({
      key: 'detail',
      label: t('health.res.detail'),
      className: 'hd-error-cell',
      render: (row) => {
        const issue = candidateIssue(row.item);
        if (issue.quarantined) return t('health.row.quarantined', { error: issue.quarantined });
        return issue.error ? <CollectorError error={issue.error} /> : null;
      },
    });
  }
  return (
    <Card title={t('health.views.title')} chip={<StatusChip code={state} />} flush>
      <DataTable columns={columns} rows={rows} rowKey={(row) => row.name} label={t('health.views.title')} stack={issues} />
    </Card>
  );
}

function MqttCard({ mqtt, mqttError, capabilities }: { mqtt: MqttSnapshot | null; mqttError: string | null; capabilities: ConsoleCapabilities | null }): JSX.Element {
  const { lang, t } = useI18n();
  // A failed /api/mqtt poll leaves mqtt null; that is a read error, not a monitor that is off.
  const readFailed = !mqtt && Boolean(mqttError);
  const connection = readFailed ? 'ERROR' : String(mqtt?.connection ?? 'OFF').toUpperCase();
  const host = typeof mqtt?.host === 'string' && mqtt.host ? mqtt.host : null;
  const port = typeof mqtt?.port === 'number' && Number.isFinite(mqtt.port) ? mqtt.port : null;
  const transport = mqtt?.transport === 'websockets' ? `WS ${typeof mqtt.ws_path === 'string' ? mqtt.ws_path : ''}`.trim() : mqtt?.transport === 'tcp' ? 'TCP' : null;
  const unexpectedWrite = Boolean(mqtt) && (mqtt?.read_only === false || mqtt?.publish_enabled === true);
  const publish: KeyValueItem = !mqtt
    ? { id: 'publish', label: t('health.mqtt.publish'), value: t('health.sub.noMonitor'), mono: false, tone: 'neutral' }
    : unexpectedWrite
      ? { id: 'publish', label: t('health.mqtt.publish'), value: t('health.unexpectedWrite'), mono: false, tone: 'bad' }
      : { id: 'publish', label: t('health.mqtt.publish'), value: t(configPatchPublishable(capabilities) ? 'health.sub.publishAdminOnly' : 'health.sub.publishUnavailable'), mono: false };
  const lastAge = lastMessageAgeMs(mqtt, Date.now());
  const received = numberOrNull(mqtt?.received);
  const invalid = numberOrNull(mqtt?.invalid);
  const lastError = typeof mqtt?.last_error === 'string' && mqtt.last_error.trim() ? mqtt.last_error.trim().slice(0, 240) : null;
  const items: KeyValueItem[] = [
    { label: t('health.mqtt.broker'), value: host ? `${host}${port === null ? '' : `:${port}`}` : 'N/A' },
    { id: 'transport', label: t('health.mqtt.transport'), value: transport ?? 'N/A' },
    publish,
    { label: t('health.mqtt.last'), value: lastAge === null ? '—' : formatDuration(t, lastAge) },
    { label: t('health.mqtt.received'), value: received === null ? '—' : formatCount(lang, received) },
    { label: t('health.mqtt.invalid'), value: invalid === null ? '—' : formatCount(lang, invalid), tone: invalid !== null && invalid > 0 ? 'warn' : undefined },
  ];
  const tone: PageTone = readFailed || connection === 'ERROR' ? 'bad' : connection === 'CONNECTED' ? 'good' : 'warn';
  return (
    <Card title={t('health.sub.mqtt')} chip={<StatusChip code={connection} tone={tone} />}>
      {readFailed ? <Notice tone="bad" title="ERROR">{mqttError}</Notice> : null}
      {!readFailed && lastError && connection !== 'CONNECTED' ? <Notice tone="bad" title={connection}>{lastError}</Notice> : null}
      <KeyValueGrid items={items} label={t('health.sub.mqtt')} />
    </Card>
  );
}

function syncTone(ok: boolean | null): PageTone {
  return ok === true ? 'good' : ok === false ? 'bad' : 'neutral';
}

export function SystemHealthPage({ snapshot, mqtt, mqttError = null, localSnapshotFresh, capabilities = null }: { snapshot: TelemetrySnapshot | null; mqtt: MqttSnapshot | null; mqttError?: string | null; localSnapshotFresh: boolean; capabilities?: ConsoleCapabilities | null }): JSX.Element {
  const { lang, t } = useI18n();
  const status = snapshot?.status;
  const daq = safeRecord(statusValue(status, 'daq_status'));
  const dropped = numberOrNull(statusValue(status, 'daq_num_dropped_frames'));
  const headline = healthHeadline(snapshot, localSnapshotFresh);
  const expired = evidenceExpired(snapshot, localSnapshotFresh);
  const http = dataOutHttp(snapshot);
  const node = nodeStatus(snapshot);
  const progress = nodeProgressView(snapshot);
  const quality = signalQualityView(snapshot);
  const syncs = syncCount(snapshot);
  const flags = syncFlagsView(snapshot);
  const readFailed = !mqtt && Boolean(mqttError);
  const connection = readFailed ? 'ERROR' : String(mqtt?.connection ?? 'OFF').toUpperCase();
  const failedSync = Array.isArray(status?.failed_sync_flags) ? status.failed_sync_flags.filter((flag): flag is string => typeof flag === 'string') : [];
  const missingSync = Array.isArray(status?.missing_sync_flags) ? status.missing_sync_flags.filter((flag): flag is string => typeof flag === 'string') : [];
  const daqHealth = String(status?.daq_health ?? (statusValue(status, 'daq_ok') === true ? 'PASS' : 'N/A'));
  const syncCause = failedSync.length
    ? t('health.row.syncFailed', { flags: failedSync.join(', ') })
    : missingSync.length ? t('health.row.syncMissing', { flags: missingSync.join(', ') }) : undefined;
  const adcState = quality?.state ?? 'N/A';
  const adcSources = quality ? (quality.state === 'OVERDRIVE' ? quality.overdriveSources : quality.reportedBy).map(overdriveSourceFile).join(' · ') : '';
  const progressAge = progress?.longestUnchangedMs !== null && progress?.longestUnchangedMs !== undefined && progress.state !== 'ADVANCING'
    ? formatDuration(t, progress.longestUnchangedMs)
    : null;
  const progressValue: ReactNode = (
    <>
      <StatusChip code={progress?.state ?? 'N/A'} tone={progress ? stateTone(progress.state) : 'neutral'} />
      {progressAge ? <span>{progressAge}</span> : null}
    </>
  );
  const noise = quality?.noiseSourceEnabled === true ? 'ON' : quality?.noiseSourceEnabled === false ? 'OFF' : 'N/A';
  const gps = String(statusValue(status, 'gps_status') ?? 'UNKNOWN');
  const nodeItems: KeyValueItem[] = [
    { id: 'progress', label: t('health.row.progress'), value: progressValue, title: progressCause(t, progress) },
    { id: 'frame', label: t('health.row.frame'), value: typeof daq.data_frame_index === 'number' ? formatCount(lang, daq.data_frame_index) : 'N/A' },
    { id: 'dropped', label: t('health.row.dropped'), value: dropped === null ? 'N/A' : formatCount(lang, dropped), tone: dropped !== null && dropped > 0 ? 'warn' : undefined },
    {
      id: 'sync',
      label: t('health.row.syncFlags'),
      value: <span className="hd-flags">{flags.map((flag) => <Tag key={flag.key} tone={syncTone(flag.ok)} title={flag.key}>{flag.label}</Tag>)}</span>,
      title: syncCause,
    },
    { id: 'noise', label: t('health.row.noiseSource'), value: noise, tone: noise === 'ON' ? 'warn' : undefined },
    { id: 'gps', label: t('health.row.gps'), value: gps },
  ];
  const papr = quality && (quality.paprCsvDb !== null || quality.paprXmlDb !== null)
    ? `${formatNumber(quality.paprCsvDb, 2)}/${formatNumber(quality.paprXmlDb, 2)}`
    : 'N/A';
  const snr = quality?.snrDb === null || !quality ? 'N/A' : formatNumber(quality.snrDb, 1);
  // The console collects with clock_source remote_unverified; only a local clock is verified.
  const clock = safeRecord(snapshot?.collector).clock_source === 'local' ? 'LOCAL' : 'UNVERIFIED';
  return (
    <Page className="hd-page">
      <PageHeader
        title={t('route.system-health')}
        chips={<>
          <StatusChip code={headline} />
          <StatusChip label={t('page.chip.http')} code={http.state} />
          <StatusChip label={t('page.chip.node')} code={node.state} />
          <StatusChip label={t('page.chip.progress')} code={progress?.state ?? 'N/A'} />
        </>}
      />
      {expired ? <Notice tone="warn" title={t('common.staleEvidence')}>{t('health.stale')}</Notice> : null}
      <Card flush className="hd-stats">
        <StatRow label={t('route.system-health')}>
          <StatTile label="DAQ" value={daqHealth} tone={toneFor(daqHealth)} sub={dropped === null ? undefined : t('health.drops', { count: formatCount(lang, dropped) })} />
          <StatTile label={t('health.sync')} value={`${syncs}/3`} tone={syncs === 3 ? 'good' : snapshot ? 'bad' : 'neutral'} title={syncCause} />
          <StatTile label="ADC" value={adcState} tone={adcState === 'OVERDRIVE' ? 'bad' : adcState === 'PASS' ? 'good' : 'neutral'} sub={adcSources || undefined} />
          <StatTile label="SNR" value={snr} unit={snr === 'N/A' ? undefined : 'dB'} sub="XML" />
          <StatTile label="PAPR" value={papr} unit={papr === 'N/A' ? undefined : 'dB'} sub="CSV / XML" />
          <StatTile label="MQTT" value={connection} tone={readFailed || connection === 'ERROR' ? 'bad' : connection === 'CONNECTED' ? 'good' : 'warn'} />
          <StatTile label={t('health.clock')} value={clock} tone={clock === 'LOCAL' ? 'good' : 'neutral'} />
        </StatRow>
      </Card>
      <PageGrid>
        <PageStack span={6}>
          <Card title={t('node.title')} chip={<StatusChip code={node.state} />}>
            {node.error ? <Notice tone="bad" title={node.state}><CollectorError error={node.error} /></Notice> : null}
            {progress?.state === 'STALLED' ? <Notice tone="bad" title="NODE_CLOCK_STALLED">{progressCause(t, progress)}</Notice> : null}
            {progress && progress.state !== 'STALLED' && progress.regressedCounters.length
              ? <Notice tone="warn" title={progress.state}>{t('health.progress.regressed', { counters: progress.regressedCounters.join(', ') })}</Notice>
              : null}
            {quality?.state === 'OVERDRIVE' ? <Notice tone="bad" title="ADC_OVERDRIVE">{overdriveNotice(t, quality)}</Notice> : null}
            {failedSync.length ? <Notice tone="bad" title="DAQ">{syncCause}</Notice> : missingSync.length ? <Notice tone="warn" title="DAQ">{syncCause}</Notice> : null}
            <KeyValueGrid items={nodeItems} label={t('node.title')} />
          </Card>
          <DoaViewsCard snapshot={snapshot} />
        </PageStack>
        <PageStack span={6}>
          <DataOutCard snapshot={snapshot} />
          <MqttCard mqtt={mqtt} mqttError={mqttError} capabilities={capabilities} />
        </PageStack>
      </PageGrid>
    </Page>
  );
}
