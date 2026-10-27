import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConsoleConfig } from '../types';
import { I18nContext, translate } from '../lib/i18n';
import type { Lang } from '../lib/i18n';
import { normalizeMqttSnapshot, normalizeRdfNodeSnapshot } from '../lib/mqttMonitor';
import { MessageMonitorPage, RdfNodeView } from './MessageMonitorPage';

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
  host: '127.0.0.1',
  port: 18884,
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
    doa: { kind: 'doa', received_at_ms: now - 600_000, age_ms: 600_000, bytes: 180, qos: 0, retained: false, valid: true, latency_ms: 0, source_ts_ms: now - 600_000, validity_flags: { valid: false }, payload: { v: 1, valid: false, station_id: 'uav-01' } },
    health: { kind: 'health', received_at_ms: now, age_ms: 0, bytes: 200, qos: 0, retained: false, valid: true, latency_ms: 4, source_ts_ms: now - 4, validity_flags: { doa_valid: false }, payload: { v: 1, state: 'ONLINE', doa_valid: false } },
  },
}, now);

const CAPABILITIES_NO_PATCH = { refreshIntervalsS: null, adminEnabled: true, adminDefaultPassword: false, configPatch: { enabled: false, requiresAdmin: true, topic: null, getTopic: null, ackTopic: null, settingsTopic: null, qos: null, ttlMs: null, ranges: {}, gainTableDb: [] } };

describe('MessageMonitorPage', () => {
  const markup = render(<MessageMonitorPage mqtt={SNAPSHOT} config={CONFIG} onMqttChanged={() => undefined} />);
  const body = text(markup);

  it('shows the publish mode as a value: admin config patch only, or subscribe only', () => {
    expect(body).toContain(`${translate('en', 'monitor.publish')} ${translate('en', 'monitor.subscribeOnly')}`);
    expect(body).not.toContain('publish disabled');
    const off = text(render(<MessageMonitorPage mqtt={SNAPSHOT} config={CONFIG} onMqttChanged={() => undefined} capabilities={CAPABILITIES_NO_PATCH} />, 'id'));
    expect(off).toContain(`${translate('id', 'monitor.publish')} ${translate('id', 'monitor.subscribeOnlyNoPatch')}`);
    const unexpected = text(render(<MessageMonitorPage mqtt={{ ...SNAPSHOT, publish_enabled: true }} config={CONFIG} onMqttChanged={() => undefined} />));
    expect(unexpected).toContain(translate('en', 'monitor.unexpectedWrite'));
  });

  it('shows each kind with its count, its own age, contract and payload status in one row', () => {
    expect(body).toContain('doa 1 STALE 10 min VALID valid: false 180 0 ms');
    expect(body).toMatch(/health 600 \d+ ms VALID state: ONLINE doa_valid: false 200 4 ms/);
  });

  it('right-aligns the numeric columns', () => {
    expect(markup).toMatch(/<th scope="col" class="is-num">Count<\/th>/);
    expect(markup).toMatch(/<td data-label="Bytes" class="is-num">180<\/td>/);
  });

  it('shows the latest record of the chosen kind as fields, with the node flags instead of redacting them', () => {
    expect(markup).toContain('<select aria-label="Kind">');
    expect(markup).toContain('<dt>validity_flags</dt><dd class="is-mono">{valid: false}</dd>');
    expect(markup).toMatch(/<dt>valid<\/dt><dd class="is-mono">false<\/dd>/);
    expect(markup).toMatch(/<dt>station_id<\/dt><dd class="is-mono">\[REDACTED\]<\/dd>/);
    expect(markup).not.toContain('uav-01');
    expect(markup).not.toContain('<pre');
  });

  it('puts the connection, transport and actions in the page bar and the broker in the connection card', () => {
    expect(markup).toMatch(/<div class="pg-bar-chips"><span class="ov-chip tone-good">CONNECTED<\/span><span class="ov-tag tone-neutral">TCP<\/span><\/div>/);
    // Reconnect carries no explanatory tooltip.
    expect(markup).toContain(`<button class="ov-button" type="button">${translate('en', 'monitor.reconnect')}</button>`);
    expect(body).toContain(`${translate('en', 'monitor.broker')} 127.0.0.1:18884`);
    expect(body).toContain(`${translate('en', 'monitor.transport')} TCP`);
    expect(body).toContain(`${translate('en', 'monitor.topic')} [REDACTED]`);
    // The reconnect result is a short state, not an explanation of the new session.
    expect(translate('en', 'monitor.requested')).toBe('Monitor restarted.');
    expect(translate('id', 'monitor.requested')).toBe('Monitor dimulai ulang.');
  });

  it('switches between sdr/v1 and RDF Node and shows only the selected one', () => {
    expect(markup).toMatch(/<button type="button" aria-pressed="true">sdr\/v1<\/button><button type="button" aria-pressed="false">RDF Node<\/button>/);
    expect(body).not.toContain('telemetry/doa');
    const v2 = text(render(<MessageMonitorPage mqtt={SNAPSHOT} config={CONFIG} onMqttChanged={() => undefined} initialProtocol="v2" />));
    expect(v2).toContain(translate('en', 'monitor.v2Loading'));
    expect(v2).not.toContain(translate('en', 'monitor.kindsTitle'));
  });

  it('shows the counters as a stat row with grouped thousands and no prose', () => {
    expect(markup).toContain('class="pg-stats"');
    expect(body).toContain(`${translate('en', 'monitor.bytes')} 1,000`);
    expect(text(render(<MessageMonitorPage mqtt={SNAPSHOT} config={CONFIG} onMqttChanged={() => undefined} />, 'id'))).toContain(`${translate('id', 'monitor.bytes')} 1.000`);
    expect(body).toContain(`${translate('en', 'monitor.latency')} 4 ms`);
    expect(body).not.toContain('bounded events');
  });

  it('shows a failed monitor read as ERROR, not as a monitor that is switched off', () => {
    const error = translate('en', 'app.readError.timedOut', { seconds: 8 });
    const failedMarkup = render(<MessageMonitorPage mqtt={null} mqttError={error} config={CONFIG} onMqttChanged={() => undefined} />);
    const failed = text(failedMarkup);
    expect(failed).toContain(translate('en', 'monitor.stateUnknown', { error }));
    expect(failed).toContain(`${translate('en', 'monitor.connection')} ERROR`);
    expect(failed).toContain(`${translate('en', 'monitor.error')} ${error}`);
    expect(failed).not.toMatch(/\bOFF\b/);
    expect(failedMarkup).toContain('class="pg-notice tone-bad" role="alert"');

    const off = text(render(<MessageMonitorPage mqtt={null} config={CONFIG} onMqttChanged={() => undefined} />));
    expect(off).toContain(`${translate('en', 'monitor.connection')} OFF`);
    expect(off).not.toContain('ERROR');
    expect(off).not.toContain(translate('en', 'monitor.error'));
    expect(off).toContain(translate('en', 'monitor.noEvents'));
  });

  it('tags synthetic data and reports an OFFLINE edge agent', () => {
    const synthetic = normalizeMqttSnapshot({
      enabled: true, read_only: true, publish_enabled: false, transport: 'websockets', ws_path: '/mqtt', now_ms: now, connection: 'connected',
      kind_counts: { availability: 2 },
      last_by_kind: { availability: { received_at_ms: now, age_ms: 0, bytes: 40, retained: true, valid: true, source: 'synthetic', source_ts_ms: now, payload: { v: 1, online: false, reason: 'SHUTDOWN' } } },
    }, now);
    const markup = render(<MessageMonitorPage mqtt={synthetic} config={CONFIG} onMqttChanged={() => undefined} />);
    const body = text(markup);
    expect(markup).toContain('<span class="ov-tag tone-neutral">WS</span><span class="ov-tag tone-warn" title="source: synthetic">SYNTHETIC</span>');
    expect(body).toContain(translate('en', 'monitor.offlineNotice', { reason: 'SHUTDOWN' }));
    expect(body).toContain('availability SYNTHETIC 2');
    expect(body).toContain('OFFLINE SHUTDOWN');
    expect(body).toContain(`${translate('en', 'monitor.transport')} WS /mqtt`);
  });

  it('renders in Indonesian', () => {
    const id = text(render(<MessageMonitorPage mqtt={SNAPSHOT} config={CONFIG} onMqttChanged={() => undefined} />, 'id'));
    expect(id).toContain('Jenis pesan');
    expect(id).toContain('STALE 10 mnt');
    expect(id).toContain('Muat ulang');
    expect(id).toContain('Sambungkan ulang');
  });
});

describe('RdfNodeView', () => {
  const quiet = normalizeRdfNodeSnapshot({ enabled: true, connection: 'ready', now_ms: now, received: 0, valid: 0, invalid: 0, topic_counts: {}, topics: {} }, now);

  it('labels READY as the subscription state and shows one line instead of empty topic rows', () => {
    const body = text(render(<RdfNodeView rdfNode={quiet} rdfError={null} nowMs={now} />));
    expect(body).toContain(`${translate('en', 'monitor.v2Subscription')} READY`);
    expect(body).toContain(translate('en', 'monitor.v2NoMessage'));
    expect(body).not.toContain('UNAVAILABLE');
    expect(body).not.toContain('telemetry/angular');
  });

  it('lists topics with messages and folds the empty ones behind a toggle', () => {
    const busy = normalizeRdfNodeSnapshot({
      enabled: true, connection: 'ready', now_ms: now, received: 3, valid: 3, invalid: 0, last_received_at_ms: now - 1_000,
      topic_counts: { state: 2, availability: 1 },
      topics: {
        state: { status: 'FRESH', received_at_ms: now - 1_000, qos: 1, retained: true, payload: { run: 'RUNNING', daq: 'OK' } },
        availability: { status: 'CONTEXT', received_at_ms: now - 2_000, qos: 1, retained: true, payload: { online: true } },
      },
    }, now);
    const markup = render(<RdfNodeView rdfNode={busy} rdfError={null} nowMs={now} />);
    const body = text(markup);
    expect(body).toContain('state 2 FRESH');
    expect(body).toContain('run RUNNING · daq OK');
    expect(body).toContain('availability 1 CONTEXT');
    expect(body).not.toContain('telemetry/doa');
    expect(body).toContain(translate('en', 'monitor.v2ShowEmpty', { count: 10 }));
    expect(markup).toContain('aria-pressed="false"');
  });

  it('shows the node view, the last ACKs and why a message was refused', () => {
    // The body tools/rdf_node_mqtt_v2.py serves after a healthy edge (tools/fixtures/rdf-node/).
    type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
    const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
    const raw = process.getBuiltinModule('node:fs').readFileSync(new URL('../../../tools/fixtures/rdf-node/api-snapshot.json', import.meta.url), 'utf8');
    const served = JSON.parse(raw) as Record<string, any>;
    served.topics.capabilities = { status: 'INVALID', received_at_ms: served.now_ms, qos: 1, retained: true, error: 'INVALID_FIELD', field: 'maintenance', payload: null };
    const snapshot = normalizeRdfNodeSnapshot(served, now);
    const markup = render(<RdfNodeView rdfNode={snapshot} rdfError={null} nowMs={now} />);
    const body = text(markup);
    expect(body).toContain(translate('en', 'monitor.rdfNode'));
    expect(body).toMatch(/Angular LIVE \d+ ms flags 63 · raw_doa_deg 200 · peak_index 200/);
    expect(body).toMatch(/DoA RAW UNVERIFIED \d+ ms SOURCE_UNVERIFIED ANGLE_UNVERIFIED a 200 · angle_reference RAW/);
    expect(body).toContain('Angular candidate UNVERIFIED');
    expect(body).toMatch(/Settings CONTEXT \d+ ms rev 1 · bytes \d+ · matches_state_cfg true/);
    expect(body).toContain(`${translate('en', 'monitor.rdfAcks')} 3`);
    expect(body).toMatch(/ack\/operation OUTCOME_UNKNOWN FINAL \d+ ms FILENOTFOUNDERROR/);
    expect(body).toContain('capabilities 1 INVALID');
    expect(body).toContain('INVALID_FIELD maintenance');
    expect(markup).not.toContain('settings_json');
    const id = text(render(<RdfNodeView rdfNode={snapshot} rdfError={null} nowMs={now} />, 'id'));
    expect(id).toContain('Kandidat Angular UNVERIFIED');
    expect(id).toContain('Sesi CONTEXT');
  });

  it('hides the direction of a stale node part and keeps a long edge ACK error', () => {
    type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
    const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
    const raw = process.getBuiltinModule('node:fs').readFileSync(new URL('../../../tools/fixtures/rdf-node/api-snapshot.json', import.meta.url), 'utf8');
    const served = JSON.parse(raw) as Record<string, any>;
    served.node.doa.live = false;
    served.node.doa.reasons = ['SOURCE_STALE'];
    served.node.acks = [{ topic: 'ack/config', status: 'FAILED', final: true, received_at_ms: served.now_ms, result: { error: 'CENTER_CHANGE_REQUIRES_VFO0_TARGET' } }];
    const body = text(render(<RdfNodeView rdfNode={normalizeRdfNodeSnapshot(served, now)} rdfError={null} nowMs={now} />));
    expect(body).toMatch(new RegExp(`DoA STALE \\d+ ms SOURCE_STALE f 433920000 · c [\\d.]+ · p [\\d.-]+ · rev 1 ${translate('en', 'monitor.v2Gated')}`));
    expect(body).not.toMatch(/DoA STALE[^|]*\ba 160\b/);
    expect(body).toMatch(/ack\/config FAILED FINAL \d+ ms CENTER_CHANGE_REQUIRES_VFO0_TARGET/);
  });

  it('reports a failed read', () => {
    const body = text(render(<RdfNodeView rdfNode={null} rdfError={{ text: 'boom' }} nowMs={now} />, 'id'));
    expect(body).toContain(translate('id', 'monitor.v2ReadFailed', { error: 'boom' }));
    expect(body).toContain(`${translate('id', 'monitor.v2Subscription')} ERROR`);
  });
});
