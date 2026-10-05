import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ConsoleConfig, MqttSnapshot } from '../types';
import { connectMqtt, getMqtt } from '../api';
import { formatNumber, safeJson, safeMqttEntries, toneFor } from '../lib/telemetry';
import { KeyValue, Metric, Panel, SectionHeading, StatusBadge } from '../components/ui';

type MessageMonitorPageProps = {
  mqtt: MqttSnapshot | null;
  config: ConsoleConfig;
  onMqttChanged: (next: MqttSnapshot) => void;
  /** Parent-owned actions give App a request-start token and abort controller. */
  onRefreshMqtt?: () => Promise<void>;
  onReconnectMqtt?: (host: string, port: number) => Promise<void>;
};

export function MessageMonitorPage({
  mqtt,
  config,
  onMqttChanged,
  onRefreshMqtt,
  onReconnectMqtt,
}: MessageMonitorPageProps): ReactElement {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const mountedRef = useRef(true);
  const requestSequence = useRef(0);
  const connection = String(mqtt?.connection ?? 'OFF').toUpperCase();

  useEffect(() => () => {
    mountedRef.current = false;
    ++requestSequence.current;
  }, []);

  const refresh = async () => {
    const sequence = ++requestSequence.current;
    setBusy(true);
    setMessage('');
    try {
      if (onRefreshMqtt) {
        await onRefreshMqtt();
      } else {
        const next = await getMqtt();
        if (!mountedRef.current || sequence !== requestSequence.current) return;
        onMqttChanged(next);
      }
      if (mountedRef.current && sequence === requestSequence.current) setMessage('Subscriber metrics refreshed.');
    } catch (error: unknown) {
      if (mountedRef.current && sequence === requestSequence.current) {
        setMessage(error instanceof Error ? error.message : 'Monitor read failed.');
      }
    } finally {
      if (mountedRef.current && sequence === requestSequence.current) setBusy(false);
    }
  };

  const reconnect = async () => {
    if (!config.mqtt_host) {
      setMessage('Set an MQTT broker IP address or localhost in Configuration first.');
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
      if (mountedRef.current && sequence === requestSequence.current) setMessage('Local MQTT monitor requested as subscriber-only.');
    } catch (error: unknown) {
      if (mountedRef.current && sequence === requestSequence.current) {
        setMessage(error instanceof Error ? error.message : 'Monitor connection failed.');
      }
    } finally {
      if (mountedRef.current && sequence === requestSequence.current) setBusy(false);
    }
  };

  return (
    <div className="page">
      <SectionHeading eyebrow="MESSAGING / READ-ONLY" title="Message monitor" detail="Bounded subscriber metrics from the local MQTT monitor. There is no publish, command, or remote control surface here." />
      <Panel className="monitor-banner" eyebrow="SUBSCRIBER PATH" title="Transport state" action={<div className="form-actions compact"><button className="secondary-button" type="button" disabled={busy} onClick={refresh}>Refresh metrics</button><button className="secondary-button" type="button" disabled={busy} onClick={reconnect}>Reconnect local monitor</button></div>}>
        <div className="monitor-state"><StatusBadge label={connection} tone={toneFor(connection)} /><span>{mqtt?.read_only === false || mqtt?.publish_enabled === true ? 'Unexpected write capability reported' : 'Read-only / publish disabled'}</span><span>{message}</span></div>
      </Panel>
      <div className="metric-grid five monitor-metrics"><Metric label="Received" value={formatNumber(mqtt?.received, 0)} detail="bounded events" tone="neutral" /><Metric label="Valid" value={formatNumber(mqtt?.valid, 0)} detail="contract decoded" tone="good" /><Metric label="Invalid" value={formatNumber(mqtt?.invalid, 0)} detail="rejected or oversized" tone={(mqtt?.invalid ?? 0) > 0 ? 'warn' : 'neutral'} /><Metric label="Bytes" value={formatNumber(mqtt?.total_bytes, 0)} detail="observed payload bytes" tone="neutral" /><Metric label="Last latency" value={mqtt?.last_latency_ms == null ? 'N/A' : `${formatNumber(mqtt.last_latency_ms, 0)} ms`} detail={mqtt?.last_age_ms == null ? 'no event age' : `age ${formatNumber(mqtt.last_age_ms, 0)} ms`} tone="neutral" /></div>
      <div className="monitor-grid">
        <Panel className="monitor-table-panel" eyebrow="KIND COUNTERS" title="Observed message kinds">
          <div className="table-wrap" role="region" aria-label="Observed message kind counters" tabIndex={0}><table><thead><tr><th>Kind</th><th>Count</th><th>Last validity</th><th>Bytes</th><th>Latency</th></tr></thead><tbody>{Object.entries(mqtt?.last_by_kind ?? {}).map(([kind, entry]) => <tr key={kind}><td>{kind}</td><td>{formatNumber(mqtt?.topic_counts?.[kind], 0)}</td><td><StatusBadge label={entry.valid ? 'VALID' : 'INVALID'} tone={entry.valid ? 'good' : 'warn'} /></td><td>{formatNumber(entry.bytes, 0)}</td><td>{entry.latency_ms == null ? 'N/A' : `${formatNumber(entry.latency_ms, 0)} ms`}</td></tr>)}{!Object.keys(mqtt?.last_by_kind ?? {}).length ? <tr><td colSpan={5} className="empty-cell">No bounded subscriber events observed.</td></tr> : null}</tbody></table></div>
        </Panel>
        <Panel className="monitor-detail-panel" eyebrow="SAFE DETAIL" title="Latest decoded records">
          <div className="key-value-list"><KeyValue label="Connection" value={connection} detail={mqtt?.last_error ?? 'No connection error reported'} /><KeyValue label="Last message age" value={mqtt?.last_age_ms == null ? 'N/A' : `${formatNumber(mqtt.last_age_ms, 0)} ms`} detail="Non-negative local age" /><KeyValue label="Topic identity" value={mqtt?.last_topic ? '[REDACTED]' : 'N/A'} detail="Raw topic withheld from UI" /><KeyValue label="Publish capability" value={mqtt?.publish_enabled === false ? 'DISABLED' : mqtt ? 'NOT ASSERTED' : 'N/A'} detail="Monitor never sends messages" /></div>
          <pre className="result-box monitor-json">{safeJson(safeMqttEntries(mqtt?.last_by_kind), 'No decoded records.')}</pre>
        </Panel>
      </div>
    </div>
  );
}
