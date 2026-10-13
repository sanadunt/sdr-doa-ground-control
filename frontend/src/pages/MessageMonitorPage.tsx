import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { ConsoleConfig, MqttSnapshot, RdfNodeSnapshot, Tone } from '../types';
import { connectMqtt, getMqtt, getRdfNodeMqtt } from '../api';
import { formatNumber, safeJson, toneFor } from '../lib/telemetry';
import { formatDuration } from '../lib/healthView';
import { healthStateTone, lastMessageAgeMs, mqttDetailRecords, mqttKindRows, rdfStatusTone, rdfTopicRows } from '../lib/mqttMonitor';
import type { MqttKindRow, RdfTopicRow } from '../lib/mqttMonitor';
import { gateReasonLabel, useI18n } from '../lib/i18n';
import type { Lang, Translate } from '../lib/i18n';
import { KeyValue, Metric, Panel, SectionHeading, StatusBadge } from '../components/ui';

/** The v2 snapshot has no App-level poll; this page reads it while it is shown. */
const RDF_NODE_POLL_MS = 2_000;
/** Local clock tick for per-kind ages between reads. */
const AGE_TICK_MS = 1_000;

type MessageMonitorPageProps = {
  mqtt: MqttSnapshot | null;
  config: ConsoleConfig;
  onMqttChanged: (next: MqttSnapshot) => void;
  /** Parent-owned actions give App a request-start token and abort controller. */
  onRefreshMqtt?: () => Promise<void>;
  onReconnectMqtt?: (host: string, port: number) => Promise<void>;
};

function Titled({ title, children }: { title?: string; children: ReactNode }): ReactElement {
  return <span className="monitor-titled" title={title}>{children}</span>;
}

function contractTone(contract: MqttKindRow['contract']): Tone {
  if (contract === 'VALID') return 'good';
  return contract === 'CLEARED' ? 'neutral' : 'warn';
}

function connectionTone(label: string): Tone {
  if (label === 'CONNECTED' || label === 'READY') return 'good';
  if (label === 'ERROR') return 'bad';
  if (label === 'DISCONNECTED') return 'warn';
  return label === 'OFF' || label === 'DISABLED' || label === 'STOPPED' || label === 'CONNECTING' ? 'neutral' : toneFor(label);
}

function PayloadStatus({ row, t, lang }: { row: MqttKindRow; t: Translate; lang: Lang }): ReactElement {
  const items: ReactNode[] = [];
  if (row.availability) {
    items.push(<StatusBadge key="availability" label={row.availability.online ? 'ONLINE' : 'OFFLINE'} tone={row.availability.online ? 'good' : 'bad'} />);
    if (row.availability.reason) items.push(<code key="availability-reason" className="monitor-code">{row.availability.reason}</code>);
  }
  if (row.healthState) items.push(<StatusBadge key="health" label={`state: ${row.healthState}`} tone={healthStateTone(row.healthState)} />);
  for (const flag of row.flags) {
    items.push(<Titled key={`flag-${flag.name}`} title={t('monitor.flagTitle', { name: flag.name })}><StatusBadge label={`${flag.name}: ${flag.value}`} tone={flag.value ? 'good' : 'warn'} /></Titled>);
  }
  for (const reason of row.reasons) {
    const label = gateReasonLabel(lang, reason);
    items.push(<code key={`reason-${reason}`} className="monitor-code" title={label === reason ? undefined : label}>{reason}</code>);
  }
  return items.length ? <div className="monitor-badges">{items}</div> : <span className="monitor-muted">—</span>;
}

function KindRow({ row, t, lang }: { row: MqttKindRow; t: Translate; lang: Lang }): ReactElement {
  const contractTitle = row.contract === 'CLEARED' ? t('monitor.clearedTitle') : undefined;
  return (
    <tr>
      <td>
        <div className="monitor-badges">
          <span>{row.kind}</span>
          {row.synthetic ? <Titled title={t('monitor.syntheticTitle')}><StatusBadge label="SYNTHETIC" tone="warn" /></Titled> : null}
        </div>
        {row.source && !row.synthetic ? <small className="monitor-cell-note"><code>source</code> {row.source}</small> : null}
      </td>
      <td>{row.count === null ? 'N/A' : row.count}</td>
      <td>
        <div className="monitor-badges">
          <span>{row.ageMs === null ? 'N/A' : formatDuration(t, row.ageMs)}</span>
          {row.stale && row.staleAfterMs !== null ? <Titled title={t('monitor.staleTitle', { limit: formatDuration(t, row.staleAfterMs) })}><StatusBadge label="STALE" tone="bad" /></Titled> : null}
        </div>
        {row.retained ? <small className="monitor-cell-note">{row.sourceAgeMs === null ? t('monitor.sourceAgeUnknown') : t('monitor.sourceAge', { age: formatDuration(t, row.sourceAgeMs) })}</small> : null}
      </td>
      <td>
        <div className="monitor-badges">
          <Titled title={contractTitle}><StatusBadge label={row.contract} tone={contractTone(row.contract)} /></Titled>
          {row.retained ? <Titled title={t('monitor.retainedTitle')}><StatusBadge label="RETAINED" tone="neutral" /></Titled> : null}
        </div>
        {row.error ? <small className="monitor-cell-note">{row.error}</small> : null}
      </td>
      <td><PayloadStatus row={row} t={t} lang={lang} /></td>
      <td>{row.bytes === null ? 'N/A' : row.bytes}</td>
      <td>{row.latencyMs === null ? 'N/A' : `${Math.round(row.latencyMs)} ms`}</td>
    </tr>
  );
}

function RdfRow({ row, t }: { row: RdfTopicRow; t: Translate }): ReactElement {
  return (
    <tr>
      <td><code className="monitor-topic">{row.suffix}</code></td>
      <td>{row.count === null ? 'N/A' : row.count}</td>
      <td><StatusBadge label={row.status} tone={rdfStatusTone(row.status)} /></td>
      <td>{row.ageMs === null ? 'N/A' : formatDuration(t, row.ageMs)}</td>
      <td>{row.retained === null ? '—' : row.retained ? 'RETAINED' : 'LIVE'}</td>
      <td>
        {row.error ? <code className="monitor-code">{row.error}</code> : null}
        {row.summary.length ? <span className="monitor-summary">{row.summary.map(([field, value]) => `${field} ${value}`).join(' · ')}</span> : null}
        {row.withheld ? <small className="monitor-cell-note">{t('monitor.v2Gated')}</small> : null}
        {!row.error && !row.summary.length && !row.withheld ? <span className="monitor-muted">—</span> : null}
      </td>
    </tr>
  );
}

export function MessageMonitorPage({
  mqtt,
  config,
  onMqttChanged,
  onRefreshMqtt,
  onReconnectMqtt,
}: MessageMonitorPageProps): ReactElement {
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [rdfNode, setRdfNode] = useState<RdfNodeSnapshot | null>(null);
  const [rdfError, setRdfError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const requestSequence = useRef(0);
  const rdfController = useRef<AbortController | null>(null);
  const rdfSequence = useRef(0);
  const connection = String(mqtt?.connection ?? 'OFF').toUpperCase();

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
      setRdfError(error instanceof Error && error.message ? error.message : 'request failed');
    } finally {
      if (rdfController.current === controller) rdfController.current = null;
    }
  }, []);

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
    setMessage('');
    void readRdfNode();
    try {
      if (onRefreshMqtt) {
        await onRefreshMqtt();
      } else {
        const next = await getMqtt();
        if (!mountedRef.current || sequence !== requestSequence.current) return;
        onMqttChanged(next);
      }
      if (mountedRef.current && sequence === requestSequence.current) setMessage(t('monitor.refreshed'));
    } catch (error: unknown) {
      if (mountedRef.current && sequence === requestSequence.current) {
        setMessage(error instanceof Error ? error.message : t('monitor.readFailed'));
      }
    } finally {
      if (mountedRef.current && sequence === requestSequence.current) setBusy(false);
    }
  };

  const reconnect = async () => {
    if (!config.mqtt_host) {
      setMessage(t('monitor.noHost'));
      return;
    }
    const sequence = ++requestSequence.current;
    setBusy(true);
    setMessage('');
    try {
      if (onReconnectMqtt) {
        await onReconnectMqtt(config.mqtt_host, Number(config.mqtt_port));
      } else {
        const next = await connectMqtt(config.mqtt_host, Number(config.mqtt_port));
        if (!mountedRef.current || sequence !== requestSequence.current) return;
        onMqttChanged(next);
      }
      if (mountedRef.current && sequence === requestSequence.current) setMessage(t('monitor.requested'));
      void readRdfNode();
    } catch (error: unknown) {
      if (mountedRef.current && sequence === requestSequence.current) {
        setMessage(error instanceof Error ? error.message : t('monitor.connectFailed'));
      }
    } finally {
      if (mountedRef.current && sequence === requestSequence.current) setBusy(false);
    }
  };

  const rows = mqttKindRows(mqtt, nowMs);
  const detailJson = useMemo(() => safeJson(mqttDetailRecords(mqtt), t('monitor.noRecords')), [mqtt, t]);
  const lastAge = lastMessageAgeMs(mqtt, nowMs);
  const synthetic = rows.some((row) => row.synthetic);
  const availability = rows.find((row) => row.kind === 'availability')?.availability ?? null;
  const transport = mqtt?.transport === 'tcp'
    ? t('monitor.transportTcp')
    : mqtt?.transport === 'websockets'
      ? t('monitor.transportWs', { path: mqtt.ws_path ?? '/mqtt' })
      : t('monitor.transportUnknown');
  const cleared = mqtt?.cleared ?? 0;

  const rdfRows = rdfTopicRows(rdfNode, nowMs);
  const rdfConnection = rdfError ? 'ERROR' : rdfNode ? rdfNode.connection.toUpperCase() : 'N/A';
  const rdfLastAge = rdfNode?.last_received_at_ms != null && rdfNode.now_ms !== null
    ? Math.max(0, rdfNode.now_ms - rdfNode.last_received_at_ms) + Math.max(0, nowMs - rdfNode.fetched_at_ms)
    : null;

  return (
    <div className="page message-monitor-page">
      <SectionHeading eyebrow={t('monitor.eyebrow')} title={t('monitor.title')} detail={t('monitor.detail')} />
      <Panel className="monitor-banner" eyebrow={t('monitor.transportEyebrow')} title={t('monitor.transportTitle')} action={<div className="form-actions compact"><button className="secondary-button" type="button" disabled={busy} onClick={refresh}>{t('monitor.refresh')}</button><button className="secondary-button" type="button" disabled={busy} onClick={reconnect} title={t('monitor.reconnectHint')}>{t('monitor.reconnect')}</button></div>}>
        <div className="monitor-state"><StatusBadge label={connection} tone={connectionTone(connection)} />{mqtt?.enabled ? <span>{transport}</span> : null}<span>{mqtt?.read_only === false || mqtt?.publish_enabled === true ? t('monitor.unexpectedWrite') : t('monitor.readOnly')}</span><span role="status">{message}</span></div>
      </Panel>
      <div className="metric-grid monitor-metrics">
        <Metric label={t('monitor.received')} value={formatNumber(mqtt?.received, 0)} detail={cleared > 0 ? t('monitor.receivedClearedDetail', { count: cleared }) : t('monitor.receivedDetail')} tone="neutral" />
        <Metric label={t('monitor.valid')} value={formatNumber(mqtt?.valid, 0)} detail={t('monitor.validDetail')} tone="good" />
        <Metric label={t('monitor.invalid')} value={formatNumber(mqtt?.invalid, 0)} detail={t('monitor.invalidDetail')} tone={(mqtt?.invalid ?? 0) > 0 ? 'warn' : 'neutral'} />
        <Metric label={t('monitor.bytes')} value={formatNumber(mqtt?.total_bytes, 0)} detail={t('monitor.bytesDetail')} tone="neutral" />
        <Metric label={t('monitor.latency')} value={mqtt?.last_latency_ms == null ? 'N/A' : `${formatNumber(mqtt.last_latency_ms, 0)} ms`} detail={lastAge === null ? t('monitor.noAge') : t('monitor.age', { age: formatDuration(t, lastAge) })} tone="neutral" />
      </div>
      <div className="monitor-grid">
        <Panel className="monitor-table-panel" eyebrow={t('monitor.kindsEyebrow')} title={t('monitor.kindsTitle')}>
          {synthetic ? <div className="dry-run-notice monitor-notice" role="status"><strong>SYNTHETIC</strong> {t('monitor.syntheticNotice')}</div> : null}
          {availability && !availability.online ? <div className="dry-run-notice monitor-notice monitor-notice-bad" role="status"><strong>OFFLINE</strong> {availability.reason ? t('monitor.offlineNotice', { reason: availability.reason }) : t('monitor.offlineNoticeNoReason')}</div> : null}
          <div className="table-wrap" role="region" aria-label={t('monitor.kindsAria')} tabIndex={0}>
            <table className="monitor-kind-table">
              <thead><tr><th>{t('monitor.col.kind')}</th><th>{t('monitor.col.count')}</th><th>{t('monitor.col.age')}</th><th>{t('monitor.col.contract')}</th><th>{t('monitor.col.payload')}</th><th>{t('monitor.col.bytes')}</th><th>{t('monitor.col.latency')}</th></tr></thead>
              <tbody>
                {rows.map((row) => <KindRow key={row.kind} row={row} t={t} lang={lang} />)}
                {!rows.length ? <tr><td colSpan={7} className="empty-cell">{t('monitor.noEvents')}</td></tr> : null}
              </tbody>
            </table>
          </div>
          <p className="monitor-panel-note">{t('monitor.kindsNote')}</p>
        </Panel>
        <Panel className="monitor-v2-panel" eyebrow={t('monitor.v2Eyebrow')} title={t('monitor.v2Title')} action={<StatusBadge label={rdfConnection} tone={connectionTone(rdfConnection)} />}>
          <p className="monitor-panel-note">{t('monitor.v2Note')}</p>
          <div className="monitor-state">
            {rdfNode ? <span>{t('monitor.v2Counts', { received: formatNumber(rdfNode.received, 0), valid: formatNumber(rdfNode.valid, 0), invalid: formatNumber(rdfNode.invalid, 0) })}</span> : <span>{rdfError ? '' : t('monitor.v2Loading')}</span>}
            {rdfNode ? <span>{rdfLastAge === null ? t('monitor.v2NoMessage') : t('monitor.v2LastMessage', { age: formatDuration(t, rdfLastAge) })}</span> : null}
            {rdfError ? <span className="status-text-bad">{t('monitor.v2ReadFailed', { error: rdfError })}</span> : rdfNode?.last_error ? <code className="monitor-code">{rdfNode.last_error}</code> : null}
          </div>
          <div className="table-wrap" role="region" aria-label={t('monitor.v2Aria')} tabIndex={0}>
            <table className="monitor-v2-table">
              <thead><tr><th>{t('monitor.col.topic')}</th><th>{t('monitor.col.count')}</th><th>{t('monitor.col.status')}</th><th>{t('monitor.col.age')}</th><th>{t('monitor.col.retained')}</th><th>{t('monitor.col.detail')}</th></tr></thead>
              <tbody>{rdfRows.map((row) => <RdfRow key={row.suffix} row={row} t={t} />)}</tbody>
            </table>
          </div>
        </Panel>
        <Panel className="monitor-detail-panel" eyebrow={t('monitor.detailEyebrow')} title={t('monitor.detailTitle')}>
          <div className="key-value-list"><KeyValue label={t('monitor.connection')} value={connection} detail={mqtt?.last_error ?? t('monitor.noError')} /><KeyValue label={t('monitor.lastAge')} value={lastAge === null ? 'N/A' : formatDuration(t, lastAge)} detail={t('monitor.lastAgeDetail')} /><KeyValue label={t('monitor.topic')} value={mqtt?.last_topic ? '[REDACTED]' : 'N/A'} detail={t('monitor.topicDetail')} /><KeyValue label={t('monitor.publish')} value={mqtt?.publish_enabled === false ? 'DISABLED' : mqtt ? t('monitor.notAsserted') : 'N/A'} detail={t('monitor.publishDetail')} /></div>
          <pre className="result-box monitor-json">{detailJson}</pre>
        </Panel>
      </div>
    </div>
  );
}
