import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ConsoleConfig, MqttSnapshot } from '../types';
import { connectMqtt, getMqtt } from '../api';
import { formatNumber, safeJson, safeMqttEntries, toneFor } from '../lib/telemetry';
import { useI18n } from '../lib/i18n';
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
  const { t } = useI18n();
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
    } catch (error: unknown) {
      if (mountedRef.current && sequence === requestSequence.current) {
        setMessage(error instanceof Error ? error.message : t('monitor.connectFailed'));
      }
    } finally {
      if (mountedRef.current && sequence === requestSequence.current) setBusy(false);
    }
  };

  return (
    <div className="page">
      <SectionHeading eyebrow={t('monitor.eyebrow')} title={t('monitor.title')} detail={t('monitor.detail')} />
      <Panel className="monitor-banner" eyebrow={t('monitor.transportEyebrow')} title={t('monitor.transportTitle')} action={<div className="form-actions compact"><button className="secondary-button" type="button" disabled={busy} onClick={refresh}>{t('monitor.refresh')}</button><button className="secondary-button" type="button" disabled={busy} onClick={reconnect}>{t('monitor.reconnect')}</button></div>}>
        <div className="monitor-state"><StatusBadge label={connection} tone={toneFor(connection)} /><span>{mqtt?.read_only === false || mqtt?.publish_enabled === true ? t('monitor.unexpectedWrite') : t('monitor.readOnly')}</span><span>{message}</span></div>
      </Panel>
      <div className="metric-grid five monitor-metrics"><Metric label={t('monitor.received')} value={formatNumber(mqtt?.received, 0)} detail={t('monitor.receivedDetail')} tone="neutral" /><Metric label={t('monitor.valid')} value={formatNumber(mqtt?.valid, 0)} detail={t('monitor.validDetail')} tone="good" /><Metric label={t('monitor.invalid')} value={formatNumber(mqtt?.invalid, 0)} detail={t('monitor.invalidDetail')} tone={(mqtt?.invalid ?? 0) > 0 ? 'warn' : 'neutral'} /><Metric label={t('monitor.bytes')} value={formatNumber(mqtt?.total_bytes, 0)} detail={t('monitor.bytesDetail')} tone="neutral" /><Metric label={t('monitor.latency')} value={mqtt?.last_latency_ms == null ? 'N/A' : `${formatNumber(mqtt.last_latency_ms, 0)} ms`} detail={mqtt?.last_age_ms == null ? t('monitor.noAge') : t('monitor.age', { ms: formatNumber(mqtt.last_age_ms, 0) })} tone="neutral" /></div>
      <div className="monitor-grid">
        <Panel className="monitor-table-panel" eyebrow={t('monitor.kindsEyebrow')} title={t('monitor.kindsTitle')}>
          <div className="table-wrap" role="region" aria-label={t('monitor.kindsAria')} tabIndex={0}><table><thead><tr><th>{t('monitor.col.kind')}</th><th>{t('monitor.col.count')}</th><th>{t('monitor.col.validity')}</th><th>{t('monitor.col.bytes')}</th><th>{t('monitor.col.latency')}</th></tr></thead><tbody>{Object.entries(mqtt?.last_by_kind ?? {}).map(([kind, entry]) => <tr key={kind}><td>{kind}</td><td>{formatNumber(mqtt?.topic_counts?.[kind], 0)}</td><td><StatusBadge label={entry.valid ? 'VALID' : 'INVALID'} tone={entry.valid ? 'good' : 'warn'} /></td><td>{formatNumber(entry.bytes, 0)}</td><td>{entry.latency_ms == null ? 'N/A' : `${formatNumber(entry.latency_ms, 0)} ms`}</td></tr>)}{!Object.keys(mqtt?.last_by_kind ?? {}).length ? <tr><td colSpan={5} className="empty-cell">{t('monitor.noEvents')}</td></tr> : null}</tbody></table></div>
        </Panel>
        <Panel className="monitor-detail-panel" eyebrow={t('monitor.detailEyebrow')} title={t('monitor.detailTitle')}>
          <div className="key-value-list"><KeyValue label={t('monitor.connection')} value={connection} detail={mqtt?.last_error ?? t('monitor.noError')} /><KeyValue label={t('monitor.lastAge')} value={mqtt?.last_age_ms == null ? 'N/A' : `${formatNumber(mqtt.last_age_ms, 0)} ms`} detail={t('monitor.lastAgeDetail')} /><KeyValue label={t('monitor.topic')} value={mqtt?.last_topic ? '[REDACTED]' : 'N/A'} detail={t('monitor.topicDetail')} /><KeyValue label={t('monitor.publish')} value={mqtt?.publish_enabled === false ? 'DISABLED' : mqtt ? t('monitor.notAsserted') : 'N/A'} detail={t('monitor.publishDetail')} /></div>
          {Object.keys(mqtt?.last_by_kind ?? {}).length
            ? <pre className="result-box monitor-json">{safeJson(safeMqttEntries(mqtt?.last_by_kind), t('monitor.noRecords'))}</pre>
            : <p className="monitor-json-empty">{t('monitor.noRecords')}</p>}
        </Panel>
      </div>
    </div>
  );
}
