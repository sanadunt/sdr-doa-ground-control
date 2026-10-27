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
import { mqttTargetFromConfig, rdfAckRows, rdfAckTone, rdfNodeRows, rdfStatusTone, rdfTopicRows } from '../lib/mqttMonitor';
import type { RdfAckRow, RdfNodeRow, RdfTopicRow } from '../lib/mqttMonitor';
import { useI18n } from '../lib/i18n';
import type { Lang, MessageKey, Translate } from '../lib/i18n';
import { Icon } from '../components/ui';
import { Card, DataTable, EmptyState, KeyValueGrid, Page, PageHeader, PageNotice, StatRow, StatTile, StatusChip, Tag } from '../components/page';
import type { DataColumn, KeyValueItem } from '../components/page';

/** A duration for a StatTile: the number as the value, its unit in the small unit slot. */
function durationTile(t: Translate, ms: number | null): { value: string; unit?: string } {
  if (ms === null) return { value: 'N/A' };
  const text = formatDuration(t, ms);
  const match = /^(.*\d)\s+(\S+)$/.exec(text);
  return match ? { value: match[1], unit: match[2] } : { value: text };
}

/** The RDF Node topic view has no App-level poll; this page reads it while it is open. */
const RDF_NODE_POLL_MS = 2_000;
/** Local clock tick for per-kind ages between reads. */
const AGE_TICK_MS = 1_000;
/** A confirmation (metrics reloaded, monitor restarted) clears itself after this long. */
const CONFIRMATION_MS = 6_000;

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
  /** The LAN view: no Reconnect, which replaces the console's monitor. */
  readOnly?: boolean;
};

type ActionMessage = { notice: Notice; tone: 'good' | 'info' | 'warn' | 'bad' };

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

/** Placeholder for a cell with nothing to show; a stacked phone row hides it. */
const EMPTY_CELL = <span className="ms-empty">—</span>;

function transportLabel(mqtt: MqttSnapshot | null): string | null {
  if (mqtt?.transport === 'tcp') return 'TCP';
  if (mqtt?.transport === 'websockets') return `WS ${mqtt.ws_path ?? '/mqtt'}`;
  return null;
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
        if (row.error) parts.push(<Tag key="error" tone={row.status === 'IGNORED' ? 'neutral' : 'bad'}>{row.field ? `${row.error} ${row.field}` : row.error}</Tag>);
        if (row.summary.length) parts.push(<span key="summary" className="ms-summary">{summaryText(row.summary)}</span>);
        if (row.withheld) parts.push(<span key="withheld" className="ms-sub">{t('monitor.v2Gated')}</span>);
        return parts.length ? <span className="ms-chips">{parts}</span> : EMPTY_CELL;
      },
    },
  ];
}

function summaryText(summary: Array<[string, string]>): string {
  return summary.map(([field, value]) => `${field} ${value}`).join(' · ');
}

function nodeColumns(t: Translate): Array<DataColumn<RdfNodeRow>> {
  return [
    { key: 'part', label: t('monitor.col.part'), render: (row) => t(`monitor.part.${row.part}` as MessageKey) },
    { key: 'status', label: t('monitor.col.status'), render: (row) => <StatusChip code={row.status} tone={rdfStatusTone(row.status)} /> },
    { key: 'age', label: t('monitor.col.age'), numeric: true, render: (row) => (row.ageMs === null ? 'N/A' : formatDuration(t, row.ageMs)) },
    {
      key: 'detail',
      label: t('monitor.col.detail'),
      render: (row) => {
        const parts: ReactNode[] = row.reasons.map((reason) => <Tag key={`reason-${reason}`}>{reason}</Tag>);
        if (row.summary.length) parts.push(<span key="summary" className="ms-summary">{summaryText(row.summary)}</span>);
        if (row.withheld) parts.push(<span key="withheld" className="ms-sub">{t('monitor.v2Gated')}</span>);
        return parts.length ? <span className="ms-chips">{parts}</span> : EMPTY_CELL;
      },
    },
  ];
}

function ackColumns(t: Translate): Array<DataColumn<RdfAckRow>> {
  return [
    { key: 'topic', label: t('monitor.col.topic'), code: true, render: (row) => row.topic },
    {
      key: 'status',
      label: t('monitor.col.status'),
      render: (row) => (
        <span className="ms-chips">
          <StatusChip code={row.status} tone={rdfAckTone(row.status)} />
          {row.final ? <Tag>FINAL</Tag> : null}
        </span>
      ),
    },
    { key: 'age', label: t('monitor.col.age'), numeric: true, render: (row) => (row.ageMs === null ? 'N/A' : formatDuration(t, row.ageMs)) },
    { key: 'detail', label: t('monitor.col.detail'), render: (row) => (row.error ? <Tag tone="bad">{row.error}</Tag> : EMPTY_CELL) },
  ];
}

/** A topic with something to show: a counted message, or a state other than UNAVAILABLE (e.g. CLEARED). */
function topicHasData(row: RdfTopicRow): boolean {
  return (row.count ?? 0) > 0 || row.status !== 'UNAVAILABLE';
}

/** RDF Node: counters, subscription state, the node view, the last ACKs and one row per subscribed topic. */
export function RdfNodeView({ rdfNode, rdfError, nowMs }: { rdfNode: RdfNodeSnapshot | null; rdfError: Notice | null; nowMs: number }): ReactElement {
  const { t, lang } = useI18n();
  const count = useCountFormat(lang);
  const [showEmpty, setShowEmpty] = useState(false);
  const rows = rdfTopicRows(rdfNode, nowMs);
  const nodeRows = rdfNodeRows(rdfNode, nowMs);
  const ackRows = rdfAckRows(rdfNode, nowMs);
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
        <StatRow label="RDF Node">
          <StatTile label={t('monitor.v2Subscription')} value={connection} tone={connectionTone(connection)} sub={rdfNode?.last_error ?? undefined} title={rdfNode?.last_error ?? undefined} />
          <StatTile label={t('monitor.received')} value={count(rdfNode?.received)} />
          <StatTile label={t('monitor.valid')} value={count(rdfNode?.valid)} tone={(rdfNode?.valid ?? 0) > 0 ? 'good' : undefined} />
          <StatTile label={t('monitor.invalid')} value={count(invalid)} tone={invalid !== null && invalid > 0 ? 'warn' : undefined} />
          <StatTile label={t('monitor.lastAge')} {...durationTile(t, lastAge)} />
        </StatRow>
      </Card>
      {rdfNode ? (
        <Card title={t('monitor.rdfNode')} flush>
          {nodeRows.length
            ? <DataTable columns={nodeColumns(t)} rows={nodeRows} rowKey={(row) => row.part} className="ms-node" label={t('monitor.rdfNode')} minWidth="720px" />
            : <EmptyState label={t('monitor.rdfNodeEmpty')} />}
        </Card>
      ) : null}
      {ackRows.length ? (
        <Card title={t('monitor.rdfAcks')} chip={<Tag>{count(ackRows.length)}</Tag>} flush>
          <DataTable columns={ackColumns(t)} rows={ackRows} rowKey={(_row, index) => String(index)} className="ms-acks" label={t('monitor.rdfAcks')} minWidth="560px" />
        </Card>
      ) : null}
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
  readOnly = false,
}: MessageMonitorPageProps): ReactElement {
  const { t } = useI18n();
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

  // The topic view is read only while this page is open.
  useEffect(() => {
    void readRdfNode();
    const timer = window.setInterval(() => { void readRdfNode(); }, RDF_NODE_POLL_MS);
    return () => {
      window.clearInterval(timer);
      ++rdfSequence.current;
      rdfController.current?.abort();
      rdfController.current = null;
    };
  }, [readRdfNode]);

  const refresh = async () => {
    const sequence = ++requestSequence.current;
    setBusy(true);
    setMessage(null);
    void readRdfNode();
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
      void readRdfNode();
    } catch (error: unknown) {
      if (mountedRef.current && sequence === requestSequence.current) setMessage(onReconnectMqtt ? null : { notice: errorNotice(error, 'monitor.connectFailed'), tone: 'bad' });
    } finally {
      if (mountedRef.current && sequence === requestSequence.current) setBusy(false);
    }
  };

  const transport = transportLabel(mqtt);
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
    { id: 'root', label: t('monitor.topic'), value: mqtt?.root ?? 'N/A' },
    publish,
  ].filter((item): item is KeyValueItem => item !== null);

  return (
    <Page className="ms-page">
      <PageHeader
        title={t('route.message-monitor')}
        chips={<>
          <StatusChip code={connection} tone={connectionTone(connection)} title={connectionError ?? undefined} />
          {mqtt?.enabled && transport ? <Tag>{mqtt.transport === 'tcp' ? 'TCP' : 'WS'}</Tag> : null}
        </>}
        actions={<>
          <button className="ov-button" type="button" disabled={busy} onClick={refresh}><Icon name="refresh" />{t('monitor.refresh')}</button>
          {readOnly ? null : <button className="ov-button" type="button" disabled={busy} onClick={reconnect}>{t('monitor.reconnect')}</button>}
        </>}
      />
      {mqttError ? <PageNotice tone="bad" title="ERROR">{t('monitor.stateUnknown', { error: mqttError })}</PageNotice> : null}
      {message ? <PageNotice tone={message.tone}>{noticeText(t, message.notice)}</PageNotice> : null}
      <RdfNodeView rdfNode={rdfNode} rdfError={rdfError} nowMs={nowMs} />
      <Card className="ms-conn" title={t('monitor.connection')} chip={<StatusChip code={connection} tone={connectionTone(connection)} title={connectionError ?? undefined} />}>
        <KeyValueGrid items={connectionItems} columns={3} label={t('monitor.connection')} />
      </Card>
    </Page>
  );
}
