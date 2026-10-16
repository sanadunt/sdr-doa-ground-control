import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { ConsoleConfig, MqttSnapshot, MqttTarget, RdfNodeSnapshot, Tone } from '../types';
import { connectMqtt, getMqtt, getRdfNodeMqtt } from '../api';
import type { ConsoleCapabilities } from '../api';
import { configPatchPublishable } from '../lib/configPatch';
import { toneFor } from '../lib/telemetry';
import { formatDuration } from '../lib/healthView';
import { errorNotice, noticeText } from '../lib/errorNotice';
import type { Notice } from '../lib/errorNotice';
import { healthStateTone, lastMessageAgeMs, mqttDetailRecords, mqttKindRows, mqttTargetFromConfig, rdfStatusTone, rdfTopicRows } from '../lib/mqttMonitor';
import type { MqttKindRow, RdfTopicRow } from '../lib/mqttMonitor';
import { gateReasonLabel, useI18n } from '../lib/i18n';
import type { Lang, Translate } from '../lib/i18n';
import { Icon } from '../components/ui';
import { Card, DataTable, EmptyState, KeyValueGrid, Page, PageGrid, PageHeader, PageNotice, Segmented, StatRow, StatTile, StatusChip, Tag } from '../components/page';
import type { DataColumn, KeyValueItem } from '../components/page';

/** A duration for a StatTile: the number as the value, its unit in the small unit slot. */
function durationTile(t: Translate, ms: number | null): { value: string; unit?: string } {
  if (ms === null) return { value: 'N/A' };
  const text = formatDuration(t, ms);
  const match = /^(.*\d)\s+(\S+)$/.exec(text);
  return match ? { value: match[1], unit: match[2] } : { value: text };
}

/** The v2 snapshot has no App-level poll; this page reads it while the v2 view is shown. */
const RDF_NODE_POLL_MS = 2_000;
/** Local clock tick for per-kind ages between reads. */
const AGE_TICK_MS = 1_000;
/** A confirmation (metrics reloaded, monitor restarted) clears itself after this long. */
const CONFIRMATION_MS = 6_000;

export type MonitorProtocol = 'v1' | 'v2';

type MessageMonitorPageProps = {
  mqtt: MqttSnapshot | null;
  config: ConsoleConfig;
  /** Set by the parent while its latest monitor read or reconnect has failed; `mqtt` is then null. */
  mqttError?: string | null;
  onMqttChanged: (next: MqttSnapshot) => void;
  /** Parent-owned actions give App a request-start token and abort controller. */
  onRefreshMqtt?: () => Promise<void>;
  onReconnectMqtt?: (target: MqttTarget) => Promise<void>;
  /** Server capabilities; say whether Kontrol can send a config patch over this connection. */
  capabilities?: ConsoleCapabilities | null;
  /** The view shown first (sdr/v1 by default); RDF Node v2 is polled only while it is shown. */
  initialProtocol?: MonitorProtocol;
};

type ActionMessage = { notice: Notice; tone: 'good' | 'info' | 'warn' | 'bad' };

function contractTone(contract: MqttKindRow['contract']): Tone {
  if (contract === 'VALID') return 'good';
  return contract === 'CLEARED' ? 'neutral' : 'warn';
}

function connectionTone(label: string): Tone {
  if (label === 'CONNECTED' || label === 'READY') return 'good';
  if (label === 'ERROR') return 'bad';
  if (label === 'DISCONNECTED') return 'warn';
  return label === 'OFF' || label === 'DISABLED' || label === 'STOPPED' || label === 'CONNECTING' || label === 'N/A' ? 'neutral' : toneFor(label);
}

/** Whole numbers with the UI language's thousands separator (1,234 or 1.234). */
function useCountFormat(lang: Lang): (value: number | null | undefined) => string {
  const format = useMemo(() => new Intl.NumberFormat(lang === 'id' ? 'id-ID' : 'en-US', { maximumFractionDigits: 0 }), [lang]);
  return useCallback((value) => (typeof value === 'number' && Number.isFinite(value) ? format.format(value) : 'N/A'), [format]);
}

/** Objects and arrays as one line of JSON-like text with spaces, so a long value wraps between entries. */
function inlineJson(value: unknown, depth = 0): string {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return `[${value.map((item) => inlineJson(item, depth + 1)).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}: ${inlineJson(item, depth + 1)}`).join(', ')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** One payload or record value as text: primitives as they are, objects and arrays inline. */
function recordValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value || '""';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return inlineJson(value);
}

/** Placeholder for a cell with nothing to show; a stacked phone row hides it. */
const EMPTY_CELL = <span className="ms-empty">—</span>;

function transportLabel(mqtt: MqttSnapshot | null): string | null {
  if (mqtt?.transport === 'tcp') return 'TCP';
  if (mqtt?.transport === 'websockets') return `WS ${mqtt.ws_path ?? '/mqtt'}`;
  return null;
}

function PayloadStatus({ row, lang }: { row: MqttKindRow; lang: Lang }): ReactElement {
  const items: ReactNode[] = [];
  if (row.availability) {
    items.push(<StatusChip key="availability" code={row.availability.online ? 'ONLINE' : 'OFFLINE'} tone={row.availability.online ? 'good' : 'bad'} />);
    if (row.availability.reason) items.push(<Tag key="availability-reason">{row.availability.reason}</Tag>);
  }
  if (row.healthState) items.push(<StatusChip key="health" code={`state: ${row.healthState}`} tone={healthStateTone(row.healthState)} />);
  for (const flag of row.flags) {
    items.push(<StatusChip key={`flag-${flag.name}`} code={`${flag.name}: ${flag.value}`} tone={flag.value ? 'good' : 'warn'} />);
  }
  for (const reason of row.reasons) {
    const label = gateReasonLabel(lang, reason);
    items.push(<Tag key={`reason-${reason}`} title={label === reason ? undefined : label}>{reason}</Tag>);
  }
  return items.length ? <span className="ms-chips">{items}</span> : EMPTY_CELL;
}

function kindColumns(t: Translate, lang: Lang, count: (value: number | null | undefined) => string): Array<DataColumn<MqttKindRow>> {
  return [
    {
      key: 'kind',
      label: t('monitor.col.kind'),
      render: (row) => (
        <span className="ms-chips">
          <code className="ms-code">{row.kind}</code>
          {row.synthetic ? <Tag tone="warn" title="source: synthetic">SYNTHETIC</Tag> : row.source ? <Tag title="source">{row.source}</Tag> : null}
        </span>
      ),
    },
    { key: 'count', label: t('monitor.col.count'), numeric: true, render: (row) => count(row.count) },
    {
      key: 'age',
      label: t('monitor.col.age'),
      numeric: true,
      render: (row) => (
        <span className="ms-stack is-end">
          <span className="ms-chips is-end">
            {row.stale && row.staleAfterMs !== null ? <StatusChip code="STALE" tone="bad" title={t('monitor.staleTitle', { limit: formatDuration(t, row.staleAfterMs) })} /> : null}
            <span>{row.ageMs === null ? 'N/A' : formatDuration(t, row.ageMs)}</span>
          </span>
          {row.retained ? <span className="ms-sub">{row.sourceAgeMs === null ? t('monitor.sourceAgeUnknown') : t('monitor.sourceAge', { age: formatDuration(t, row.sourceAgeMs) })}</span> : null}
        </span>
      ),
    },
    {
      key: 'contract',
      label: t('monitor.col.contract'),
      render: (row) => (
        <span className="ms-stack">
          <span className="ms-chips">
            <StatusChip code={row.contract} tone={contractTone(row.contract)} title={row.contract === 'CLEARED' ? t('monitor.clearedTitle') : undefined} />
            {row.retained ? <Tag>RETAINED</Tag> : null}
          </span>
          {row.error ? <span className="ms-cell-error">{row.error}</span> : null}
        </span>
      ),
    },
    { key: 'payload', label: t('monitor.col.payload'), render: (row) => <PayloadStatus row={row} lang={lang} /> },
    { key: 'bytes', label: t('monitor.col.bytes'), numeric: true, render: (row) => count(row.bytes) },
    { key: 'latency', label: t('monitor.col.latency'), numeric: true, render: (row) => (row.latencyMs === null ? 'N/A' : `${Math.round(row.latencyMs)} ms`) },
  ];
}

/** The latest record of one kind: its record fields, then the decoded (redacted) payload one level deep. */
function RecordCard({ mqtt, kinds }: { mqtt: MqttSnapshot | null; kinds: string[] }): ReactElement {
  const { t } = useI18n();
  const [chosen, setChosen] = useState<string | null>(null);
  const kind = chosen !== null && kinds.includes(chosen) ? chosen : kinds[0] ?? null;
  const record = useMemo(() => {
    if (kind === null) return null;
    const detail = mqttDetailRecords(mqtt)[kind];
    return detail && typeof detail === 'object' ? detail as Record<string, unknown> : null;
  }, [mqtt, kind]);
  const payload = record?.payload;
  const meta: KeyValueItem[] = record
    ? Object.entries(record).filter(([key]) => key !== 'payload').map(([key, value]) => ({
      id: key,
      label: key,
      value: recordValue(value),
      tone: key === 'error' ? 'bad' as const : undefined,
    }))
    : [];
  const fields: KeyValueItem[] = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.entries(payload as Record<string, unknown>).map(([key, value]) => ({ id: key, label: key, value: recordValue(value) }))
    : [];
  return (
    <Card
      title={t('monitor.detailTitle')}
      className="ms-record"
      actions={kinds.length ? (
        <span className="ms-select">
          <select aria-label={t('monitor.col.kind')} value={kind ?? ''} onChange={(event) => setChosen(event.target.value)}>
            {kinds.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </span>
      ) : null}
    >
      {record ? (
        <>
          <KeyValueGrid items={meta} columns={3} labels="mono" label={kind ?? undefined} />
          <div className="ms-payload">
            <span className="pg-micro">payload</span>
            {fields.length
              ? <KeyValueGrid items={fields} columns={3} labels="mono" label="payload" />
              : <span className="ms-payload-empty">{payload === undefined ? '—' : recordValue(payload)}</span>}
          </div>
        </>
      ) : <EmptyState label={t('monitor.noRecords')} />}
    </Card>
  );
}

function rdfColumns(t: Translate, count: (value: number | null | undefined) => string): Array<DataColumn<RdfTopicRow>> {
  return [
    { key: 'topic', label: t('monitor.col.topic'), code: true, render: (row) => row.suffix },
    { key: 'count', label: t('monitor.col.count'), numeric: true, render: (row) => count(row.count) },
    { key: 'status', label: t('monitor.col.status'), render: (row) => <StatusChip code={row.status} tone={rdfStatusTone(row.status)} /> },
    { key: 'age', label: t('monitor.col.age'), numeric: true, render: (row) => (row.ageMs === null ? 'N/A' : formatDuration(t, row.ageMs)) },
    { key: 'retained', label: t('monitor.col.retained'), render: (row) => (row.retained === null ? EMPTY_CELL : <Tag>{row.retained ? 'RETAINED' : 'LIVE'}</Tag>) },
    {
      key: 'detail',
      label: t('monitor.col.detail'),
      render: (row) => {
        const parts: ReactNode[] = [];
        if (row.error) parts.push(<Tag key="error" tone="bad">{row.error}</Tag>);
        if (row.summary.length) parts.push(<span key="summary" className="ms-summary">{row.summary.map(([field, value]) => `${field} ${value}`).join(' · ')}</span>);
        if (row.withheld) parts.push(<span key="withheld" className="ms-sub">{t('monitor.v2Gated')}</span>);
        return parts.length ? <span className="ms-chips">{parts}</span> : EMPTY_CELL;
      },
    },
  ];
}

/** A topic with something to show: a counted message, or a state other than UNAVAILABLE (e.g. CLEARED). */
function topicHasData(row: RdfTopicRow): boolean {
  return (row.count ?? 0) > 0 || row.status !== 'UNAVAILABLE';
}

/** RDF Node v2: counters, subscription state and one row per subscribed topic. */
export function RdfNodeView({ rdfNode, rdfError, nowMs }: { rdfNode: RdfNodeSnapshot | null; rdfError: Notice | null; nowMs: number }): ReactElement {
  const { t, lang } = useI18n();
  const count = useCountFormat(lang);
  const [showEmpty, setShowEmpty] = useState(false);
  const rows = rdfTopicRows(rdfNode, nowMs);
  const connection = rdfError ? 'ERROR' : rdfNode ? rdfNode.connection.toUpperCase() : 'N/A';
  const lastAge = rdfNode?.last_received_at_ms != null && rdfNode.now_ms !== null
    ? Math.max(0, rdfNode.now_ms - rdfNode.last_received_at_ms) + Math.max(0, nowMs - rdfNode.fetched_at_ms)
    : null;
  const withData = rows.filter(topicHasData);
  const emptyCount = rows.length - withData.length;
  const shown = showEmpty ? rows : withData;
  const invalid = rdfNode?.invalid ?? null;
  return (
    <>
      {rdfError ? <PageNotice tone="bad" title="ERROR">{t('monitor.v2ReadFailed', { error: noticeText(t, rdfError) })}</PageNotice> : null}
      <Card flush>
        <StatRow label="RDF Node v2">
          <StatTile label={t('monitor.v2Subscription')} value={connection} tone={connectionTone(connection)} sub={rdfNode?.last_error ?? undefined} title={rdfNode?.last_error ?? undefined} />
          <StatTile label={t('monitor.received')} value={count(rdfNode?.received)} />
          <StatTile label={t('monitor.valid')} value={count(rdfNode?.valid)} tone={(rdfNode?.valid ?? 0) > 0 ? 'good' : undefined} />
          <StatTile label={t('monitor.invalid')} value={count(invalid)} tone={invalid !== null && invalid > 0 ? 'warn' : undefined} />
          <StatTile label={t('monitor.lastAge')} {...durationTile(t, lastAge)} />
        </StatRow>
      </Card>
      <Card
        title={t('monitor.v2Topics')}
        chip={rdfNode ? <Tag>{`${withData.length} / ${rows.length}`}</Tag> : null}
        actions={withData.length && emptyCount ? (
          <button type="button" className="ov-button" aria-pressed={showEmpty} onClick={() => setShowEmpty((value) => !value)}>
            {showEmpty ? t('monitor.v2HideEmpty') : t('monitor.v2ShowEmpty', { count: emptyCount })}
          </button>
        ) : null}
        flush
      >
        {!rdfNode
          ? <EmptyState label={rdfError ? t('monitor.v2NoMessage') : t('monitor.v2Loading')} code={rdfError ? 'N/A' : null} />
          : withData.length === 0
            ? <EmptyState label={t('monitor.v2NoMessage')} />
            : (
              <DataTable
                columns={rdfColumns(t, count)}
                rows={shown}
                rowKey={(row) => row.suffix}
                rowClassName={(row) => (topicHasData(row) ? undefined : 'is-muted')}
                className="ms-topics"
                label={t('monitor.v2Topics')}
                minWidth="720px"
              />
            )}
      </Card>
    </>
  );
}

export function MessageMonitorPage({
  mqtt,
  config,
  mqttError = null,
  onMqttChanged,
  onRefreshMqtt,
  onReconnectMqtt,
  capabilities = null,
  initialProtocol = 'v1',
}: MessageMonitorPageProps): ReactElement {
  const { t, lang } = useI18n();
  const count = useCountFormat(lang);
  const [protocol, setProtocol] = useState<MonitorProtocol>(initialProtocol);
  const [busy, setBusy] = useState(false);
  // Kept as a key or as received text so a language switch re-renders it.
  const [message, setMessage] = useState<ActionMessage | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [rdfNode, setRdfNode] = useState<RdfNodeSnapshot | null>(null);
  const [rdfError, setRdfError] = useState<Notice | null>(null);
  const mountedRef = useRef(true);
  const requestSequence = useRef(0);
  const rdfController = useRef<AbortController | null>(null);
  const rdfSequence = useRef(0);
  // Without a snapshot after a failed read the monitor state is unknown, not OFF.
  const connection = mqttError ? 'ERROR' : String(mqtt?.connection ?? 'OFF').toUpperCase();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      ++requestSequence.current;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), AGE_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Confirmations clear themselves; warnings and errors stay until the next action.
  useEffect(() => {
    if (!message || (message.tone !== 'good' && message.tone !== 'info')) return undefined;
    const timer = window.setTimeout(() => setMessage((current) => (current === message ? null : current)), CONFIRMATION_MS);
    return () => window.clearTimeout(timer);
  }, [message]);

  const readRdfNode = useCallback(async (): Promise<void> => {
    if (rdfController.current) return;
    const controller = new AbortController();
    const sequence = ++rdfSequence.current;
    rdfController.current = controller;
    try {
      const next = await getRdfNodeMqtt(controller.signal);
      if (controller.signal.aborted || sequence !== rdfSequence.current) return;
      setRdfNode(next);
      setRdfError(null);
    } catch (error: unknown) {
      if (controller.signal.aborted || sequence !== rdfSequence.current) return;
      setRdfError(errorNotice(error, 'common.requestFailed'));
    } finally {
      if (rdfController.current === controller) rdfController.current = null;
    }
  }, []);

  // RDF Node v2 is read only while its view is shown.
  useEffect(() => {
    if (protocol !== 'v2') return undefined;
    void readRdfNode();
    const timer = window.setInterval(() => { void readRdfNode(); }, RDF_NODE_POLL_MS);
    return () => {
      window.clearInterval(timer);
      ++rdfSequence.current;
      rdfController.current?.abort();
      rdfController.current = null;
    };
  }, [protocol, readRdfNode]);

  const refresh = async () => {
    const sequence = ++requestSequence.current;
    setBusy(true);
    setMessage(null);
    if (protocol === 'v2') void readRdfNode();
    try {
      if (onRefreshMqtt) {
        await onRefreshMqtt();
      } else {
        const next = await getMqtt();
        if (!mountedRef.current || sequence !== requestSequence.current) return;
        onMqttChanged(next);
      }
      if (mountedRef.current && sequence === requestSequence.current) setMessage({ notice: { key: 'monitor.refreshed' }, tone: 'good' });
    } catch (error: unknown) {
      // A parent-owned read reports its failure through mqttError.
      if (mountedRef.current && sequence === requestSequence.current) setMessage(onRefreshMqtt ? null : { notice: errorNotice(error, 'monitor.readFailed'), tone: 'bad' });
    } finally {
      if (mountedRef.current && sequence === requestSequence.current) setBusy(false);
    }
  };

  const reconnect = async () => {
    if (!config.mqtt_host) {
      setMessage({ notice: { key: 'monitor.noHost' }, tone: 'warn' });
      return;
    }
    const sequence = ++requestSequence.current;
    setBusy(true);
    setMessage(null);
    const target = mqttTargetFromConfig(config);
    try {
      if (onReconnectMqtt) {
        await onReconnectMqtt(target);
      } else {
        const next = await connectMqtt(target);
        if (!mountedRef.current || sequence !== requestSequence.current) return;
        onMqttChanged(next);
      }
      if (mountedRef.current && sequence === requestSequence.current) setMessage({ notice: { key: 'monitor.requested' }, tone: 'info' });
      if (protocol === 'v2') void readRdfNode();
    } catch (error: unknown) {
      if (mountedRef.current && sequence === requestSequence.current) setMessage(onReconnectMqtt ? null : { notice: errorNotice(error, 'monitor.connectFailed'), tone: 'bad' });
    } finally {
      if (mountedRef.current && sequence === requestSequence.current) setBusy(false);
    }
  };

  const rows = mqttKindRows(mqtt, nowMs);
  const lastAge = lastMessageAgeMs(mqtt, nowMs);
  const synthetic = rows.some((row) => row.synthetic);
  const availability = rows.find((row) => row.kind === 'availability')?.availability ?? null;
  const transport = transportLabel(mqtt);
  const cleared = mqtt?.cleared ?? 0;
  const invalid = mqtt?.invalid ?? null;
  const latency = typeof mqtt?.last_latency_ms === 'number' && Number.isFinite(mqtt.last_latency_ms) ? Math.round(mqtt.last_latency_ms) : null;
  const connectionError = mqttError ?? mqtt?.last_error ?? null;
  const unexpectedWrite = Boolean(mqtt) && (mqtt?.read_only === false || mqtt?.publish_enabled === true);
  const broker = typeof mqtt?.host === 'string' && mqtt.host ? `${mqtt.host}${typeof mqtt.port === 'number' ? `:${mqtt.port}` : ''}` : null;
  const publish: KeyValueItem = !mqtt
    ? { id: 'publish', label: t('monitor.publish'), value: 'N/A', tone: 'neutral' }
    : unexpectedWrite
      ? { id: 'publish', label: t('monitor.publish'), value: t('monitor.unexpectedWrite'), mono: false, tone: 'bad' }
      : mqtt.publish_enabled === false
        ? { id: 'publish', label: t('monitor.publish'), value: t(configPatchPublishable(capabilities) ? 'monitor.subscribeOnly' : 'monitor.subscribeOnlyNoPatch'), mono: false }
        : { id: 'publish', label: t('monitor.publish'), value: t('monitor.notAsserted'), tone: 'warn' };
  const connectionItems: KeyValueItem[] = [
    connectionError ? { id: 'error', label: t('monitor.error'), value: connectionError, mono: false, tone: 'bad' } : null,
    { id: 'broker', label: t('monitor.broker'), value: broker ?? 'N/A' },
    { id: 'transport', label: t('monitor.transport'), value: transport ?? 'N/A' },
    { id: 'topic', label: t('monitor.topic'), value: mqtt?.last_topic ? '[REDACTED]' : 'N/A' },
    publish,
  ].filter((item): item is KeyValueItem => item !== null);

  return (
    <Page className="ms-page">
      <PageHeader
        title={t('route.message-monitor')}
        chips={<>
          <StatusChip code={connection} tone={connectionTone(connection)} title={connectionError ?? undefined} />
          {mqtt?.enabled && transport ? <Tag>{mqtt.transport === 'tcp' ? 'TCP' : 'WS'}</Tag> : null}
          {synthetic ? <Tag tone="warn" title="source: synthetic">SYNTHETIC</Tag> : null}
        </>}
        actions={<>
          <Segmented
            compact
            label={t('monitor.protocol')}
            value={protocol}
            onChange={setProtocol}
            options={[{ value: 'v1', label: 'sdr/v1' }, { value: 'v2', label: 'RDF Node v2' }]}
          />
          <button className="ov-button" type="button" disabled={busy} onClick={refresh}><Icon name="refresh" />{t('monitor.refresh')}</button>
          <button className="ov-button" type="button" disabled={busy} onClick={reconnect}>{t('monitor.reconnect')}</button>
        </>}
      />
      {mqttError ? <PageNotice tone="bad" title="ERROR">{t('monitor.stateUnknown', { error: mqttError })}</PageNotice> : null}
      {message ? <PageNotice tone={message.tone}>{noticeText(t, message.notice)}</PageNotice> : null}
      {protocol === 'v1' ? (
        <>
          {availability && !availability.online ? (
            <PageNotice tone="bad" title="OFFLINE">{availability.reason ? t('monitor.offlineNotice', { reason: availability.reason }) : t('monitor.offlineNoticeNoReason')}</PageNotice>
          ) : null}
          <Card flush>
            <StatRow label="sdr/v1">
              <StatTile label={t('monitor.received')} value={count(mqtt?.received)} sub={cleared > 0 ? t('monitor.cleared', { count: count(cleared) }) : undefined} />
              <StatTile label={t('monitor.valid')} value={count(mqtt?.valid)} tone={(mqtt?.valid ?? 0) > 0 ? 'good' : undefined} />
              <StatTile label={t('monitor.invalid')} value={count(invalid)} tone={invalid !== null && invalid > 0 ? 'warn' : undefined} />
              <StatTile label={t('monitor.bytes')} value={count(mqtt?.total_bytes)} />
              <StatTile label={t('monitor.latency')} value={latency === null ? 'N/A' : count(latency)} unit={latency === null ? undefined : 'ms'} />
              <StatTile label={t('monitor.lastAge')} {...durationTile(t, lastAge)} />
            </StatRow>
          </Card>
          <PageGrid>
            <Card span={8} className="ms-kinds" title={t('monitor.kindsTitle')} chip={rows.length ? <Tag>{count(rows.length)}</Tag> : null} flush>
              <DataTable
                columns={kindColumns(t, lang, count)}
                rows={rows}
                rowKey={(row) => row.kind}
                label={t('monitor.kindsTitle')}
                empty={t('monitor.noEvents')}
                minWidth="760px"
              />
            </Card>
            <Card span={4} className="ms-conn" title={t('monitor.connection')} chip={<StatusChip code={connection} tone={connectionTone(connection)} title={connectionError ?? undefined} />}>
              <KeyValueGrid items={connectionItems} columns={1} label={t('monitor.connection')} />
            </Card>
            <RecordCard mqtt={mqtt} kinds={rows.filter((row) => mqtt?.last_by_kind?.[row.kind]).map((row) => row.kind)} />
          </PageGrid>
        </>
      ) : (
        <RdfNodeView rdfNode={rdfNode} rdfError={rdfError} nowMs={nowMs} />
      )}
    </Page>
  );
}
