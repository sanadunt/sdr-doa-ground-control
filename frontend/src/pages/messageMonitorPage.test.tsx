import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConsoleConfig } from '../types';
import { I18nContext, translate } from '../lib/i18n';
import type { Lang } from '../lib/i18n';
import { normalizeMqttSnapshot } from '../lib/mqttMonitor';
import { MessageMonitorPage } from './MessageMonitorPage';

const CONFIG: ConsoleConfig = { base_url: 'http://doasdr.local:8081', mqtt_host: '127.0.0.1', mqtt_port: 18884, mqtt_transport: 'tcp', mqtt_ws_path: '/mqtt', refresh_seconds: 2 };

function render(element: ReactElement, lang: Lang = 'en'): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>{element}</I18nContext.Provider>,
  );
}

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
}

const now = Date.now();
const SNAPSHOT = normalizeMqttSnapshot({
  enabled: true,
  read_only: true,
  publish_enabled: false,
  transport: 'tcp',
  ws_path: '/mqtt',
  now_ms: now,
  connection: 'connected',
  received: 601,
  valid: 601,
  invalid: 0,
  cleared: 0,
  total_bytes: 1000,
  last_age_ms: 0,
  last_latency_ms: 4,
  last_topic: 'sdr/v1/uav-01/telemetry/health',
  kind_counts: { doa: 1, health: 600 },
  topic_counts: { 'sdr/v1/uav-01/telemetry/doa': 1, 'sdr/v1/uav-01/telemetry/health': 600 },
  last_by_kind: {
    doa: { kind: 'doa', received_at_ms: now - 600_000, age_ms: 600_000, bytes: 180, qos: 0, retained: false, valid: true, latency_ms: 0, source_ts_ms: now - 600_000, validity_flags: { valid: false }, payload: { v: 1, valid: false } },
    health: { kind: 'health', received_at_ms: now, age_ms: 0, bytes: 200, qos: 0, retained: false, valid: true, latency_ms: 4, source_ts_ms: now - 4, validity_flags: { doa_valid: false }, payload: { v: 1, state: 'ONLINE', doa_valid: false } },
  },
}, now);

describe('MessageMonitorPage', () => {
  const markup = render(<MessageMonitorPage mqtt={SNAPSHOT} config={CONFIG} onMqttChanged={() => undefined} />);
  const body = text(markup);

  it('shows the count of each kind and its own age', () => {
    expect(body).toContain('doa 1 10 min STALE VALID');
    expect(body).toMatch(/health 600 \d+ ms VALID state: ONLINE doa_valid: false/);
  });

  it('shows the node flags instead of redacting them', () => {
    expect(body).toContain('valid: false');
    expect(body).toContain('doa_valid: false');
    expect(markup).not.toContain('"valid": "[REDACTED]"');
    expect(markup).toContain('&quot;valid&quot;: false');
  });

  it('names the transport and says a reconnect resets the counters', () => {
    expect(body).toContain('MQTT over TCP');
    expect(markup).toContain(`title="${translate('en', 'monitor.reconnectHint')}"`);
    expect(translate('en', 'monitor.requested')).toMatch(/zero/);
    expect(translate('id', 'monitor.requested')).toMatch(/nol/);
  });

  it('renders the RDF Node v2 panel with every subscribed topic', () => {
    expect(body).toContain('RDF Node v2 telemetry');
    for (const suffix of ['telemetry/doa', 'telemetry/angular', 'availability', 'ack/operation']) expect(body).toContain(suffix);
  });

  it('lets the metric row reflow on phones', () => {
    expect(markup).toContain('class="metric-grid monitor-metrics"');
    expect(markup).not.toContain('metric-grid five');
  });

  it('shows a failed monitor read as ERROR, not as a monitor that is switched off', () => {
    const error = translate('en', 'app.readError.timedOut', { seconds: 8 });
    const failedMarkup = render(<MessageMonitorPage mqtt={null} mqttError={error} config={CONFIG} onMqttChanged={() => undefined} />);
    const failed = text(failedMarkup);
    expect(failed).toContain(translate('en', 'monitor.stateUnknown', { error }));
    expect(failed).toContain(`${translate('en', 'monitor.connection')} ERROR ${error}`);
    expect(failed).not.toContain(translate('en', 'monitor.noError'));
    expect(failed).not.toMatch(/\bOFF\b/);
    expect(failedMarkup).toContain('class="status-text-bad"');

    const off = text(render(<MessageMonitorPage mqtt={null} config={CONFIG} onMqttChanged={() => undefined} />));
    expect(off).toContain(`${translate('en', 'monitor.connection')} OFF ${translate('en', 'monitor.noError')}`);
    expect(off).not.toContain('ERROR');
  });

  it('renders in Indonesian', () => {
    const id = text(render(<MessageMonitorPage mqtt={SNAPSHOT} config={CONFIG} onMqttChanged={() => undefined} />, 'id'));
    expect(id).toContain('MQTT lewat TCP');
    expect(id).toContain('Telemetri RDF Node v2');
    expect(id).toContain('10 mnt STALE');
  });
});
