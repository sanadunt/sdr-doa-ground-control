import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RdfNodeMqttObservation, RdfNodeMqttSnapshot, RdfNodeMqttTopic, SystemHealthSnapshot } from '../types';
import { RDF_NODE_MQTT_TOPICS } from '../types';
import { SystemHealthPage } from './SystemHealthPage';


const localHealth: SystemHealthSnapshot = {
  checked_at_ms: 1_750_000_000_000,
  usb_telemetry: 'PRESENT',
  ppp_interface: 'UP',
  raspberry_peer: 'NO_REPLY',
};

function emptyObservation(): RdfNodeMqttObservation {
  return {
    status: 'UNAVAILABLE',
    received_at_ms: null,
    qos: null,
    retained: null,
    payload: null,
    candidate_payload: null,
    error: null,
  };
}

function observation(payload: Record<string, unknown>, receivedAtMs: number): RdfNodeMqttObservation {
  return {
    status: 'FRESH',
    received_at_ms: receivedAtMs,
    qos: 0,
    retained: false,
    payload,
    candidate_payload: null,
    error: null,
  };
}

function healthyMqttSnapshot(options: {
  connection?: RdfNodeMqttSnapshot['connection'];
  healthAgeMs?: number;
} = {}): RdfNodeMqttSnapshot {
  const nowMs = Date.now();
  const healthAtMs = nowMs - (options.healthAgeMs ?? 0);
  const topics = Object.fromEntries(
    RDF_NODE_MQTT_TOPICS.map((topic) => [topic, emptyObservation()]),
  ) as Record<RdfNodeMqttTopic, RdfNodeMqttObservation>;
  const topicCounts = Object.fromEntries(
    RDF_NODE_MQTT_TOPICS.map((topic) => [topic, 0]),
  ) as Record<RdfNodeMqttTopic, number>;
  topics['telemetry/health'] = observation(
    { sid: 'edge-01', q: 7, t: healthAtMs, daq: 1, drop: 12, clk: 1, rev: 4, run: 1, age: 250, temp: 41.5 },
    healthAtMs,
  );
  topics['telemetry/health/detail'] = observation(
    {
      sid: 'edge-01', t: nowMs, usb: 0, sync: [true, null, false],
      cpu: 37.5, mem: 45.2, disk_free: 62.1, throt: false, uv: false,
      tx: 12.5, rx: 25.2, adrop: 4, parse: 1,
    },
    nowMs,
  );
  topics['telemetry/doa'] = observation(
    { sid: 'edge-01', t: nowMs, rev: 4, ok: 1 },
    nowMs,
  );
  topicCounts['telemetry/health'] = 1;
  topicCounts['telemetry/health/detail'] = 1;
  topicCounts['telemetry/doa'] = 1;
  return {
    enabled: options.connection !== 'disabled',
    connection: options.connection ?? 'ready',
    node_id: 'edge-01',
    last_error: null,
    received: 3,
    valid: 3,
    invalid: 0,
    last_received_at_ms: nowMs,
    topic_counts: topicCounts,
    topics,
  };
}

function addDiagnosticObservations(
  snapshot: RdfNodeMqttSnapshot,
  angularFlags = 3,
): number[] {
  const nowMs = Date.now();
  const values = Array.from({ length: 360 }, (_, index) => 90_000 + index);
  snapshot.topics['telemetry/diagnostic/doa'] = observation({
    v: 2,
    sid: '7a8b9c0d',
    q: 8,
    source: 'doa.xml',
    source_timestamp_ms: nowMs - 1_000,
    observed_timestamp_ms: nowMs - 900,
    raw_doa_deg: 43.5,
    frequency_mhz: 433.92,
    trust: 'UNVERIFIED',
    validation_reasons: ['DIAGNOSTIC_UNVERIFIED', 'SOURCE_PARSE_UNVERIFIED'],
  }, nowMs - 500);
  snapshot.topics['telemetry/diagnostic/angular'] = observation({
    encoding: 'q16',
    sid: 0x7a8b9c0d,
    q: 8,
    source_timestamp_ms: nowMs - 1_000,
    frequency_hz: 433_920_000,
    revision: 4,
    vfo: 0,
    convention: 1,
    raw_doa_deg: 43.5,
    confidence_native_db: 5.2,
    flags: angularFlags,
    trust: 'UNVERIFIED',
    validation_reasons: angularFlags & 2
      ? ['DIAGNOSTIC_UNVERIFIED']
      : ['DIAGNOSTIC_UNVERIFIED', 'CLOCK_FRESHNESS_UNVERIFIED'],
    values,
  }, nowMs - 500);
  return values;
}

function renderPage(options: {
  rdfNodeMqtt?: RdfNodeMqttSnapshot | null;
  rdfNodeMqttError?: string | null;
  systemHealth?: SystemHealthSnapshot | null;
  systemHealthError?: string | null;
} = {}): string {
  return renderToStaticMarkup(
    <SystemHealthPage
      rdfNodeMqtt={options.rdfNodeMqtt === undefined ? healthyMqttSnapshot() : options.rdfNodeMqtt}
      rdfNodeMqttError={options.rdfNodeMqttError ?? null}
      systemHealth={options.systemHealth === undefined ? localHealth : options.systemHealth}
      systemHealthError={options.systemHealthError ?? null}
    />,
  );
}

function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('SystemHealthPage MQTT telemetry', () => {
  it('renders_mqtt_fields_without_a_data_out_snapshot', () => {
    const markup = renderPage();
    const text = visibleText(markup);

    expect(text).toContain('Edge health stream CURRENT');
    expect(text).toContain('DAQ / acquisition HEALTHY');
    expect(text).toContain('Dropped frames 12');
    expect(text).toContain('Edge clock SYNCED');
    expect(text).toContain('Sync flags 1 / 3');
    expect(text).toContain('DoA estimate CURRENT');
    expect(text).toContain('GPS status NOT PROVIDED');
    expect(text).toContain('CSV source NOT PROVIDED');
    expect(text).toContain('XML source NOT PROVIDED');
    expect(text).toContain('DAQ frame index NOT PROVIDED');
    expect(text).not.toContain('Data Out / HTTP');
  });

  it('keeps_broker_ready_separate_from_stale_health', () => {
    const text = visibleText(renderPage({ rdfNodeMqtt: healthyMqttSnapshot({ healthAgeMs: 8_001 }) }));

    expect(text).toContain('MQTT v2 connection READY');
    expect(text).toContain('Edge health stream STALE');
    expect(text).toContain('DAQ / acquisition STALE');
    expect(text).not.toContain('DAQ / acquisition HEALTHY');
  });

  it('shows_mqtt_error_without_old_green_values', () => {
    const markup = renderPage({
      rdfNodeMqtt: healthyMqttSnapshot(),
      rdfNodeMqttError: 'request timed out',
    });
    const text = visibleText(markup);

    expect(markup).toContain('role="alert"');
    expect(text).toContain('request timed out');
    expect(text).toContain('DAQ / acquisition UNAVAILABLE');
    expect(text).not.toContain('DAQ / acquisition HEALTHY');
  });

  it('keeps_local_probe_results_independent', () => {
    const text = visibleText(renderPage({
      rdfNodeMqtt: healthyMqttSnapshot(),
      systemHealth: null,
      systemHealthError: 'local probe timed out',
    }));

    expect(text).toContain('DAQ / acquisition HEALTHY');
    expect(text).toContain('local probe timed out');
    expect(text).toContain('Local USB telemetry UNKNOWN');
    expect(text).toContain('PPP interface UNKNOWN');
    expect(text).toContain('Raspberry peer UNKNOWN');
  });

  it('shows the authoritative local System Health probe timestamp', () => {
    const markup = renderPage();

    expect(markup).toContain('Last checked');
    expect(markup).toMatch(/datetime="2025-06-15T15:06:40\.000Z"/i);
  });

  it('separates edge telemetry from local host checks without an aggregate pass state', () => {
    const markup = renderPage();
    const text = visibleText(markup);

    expect(markup).toMatch(/<section\b(?=[^>]*aria-labelledby="system-health-edge-heading")[^>]*>/);
    expect(markup).toContain('id="system-health-edge-heading"');
    expect(text).toContain('Edge telemetry & processing');
    expect(markup).toMatch(/<section\b(?=[^>]*aria-labelledby="system-health-local-heading")[^>]*>/);
    expect(markup).toContain('id="system-health-local-heading"');
    expect(text).toContain('Ground Console host & connections');
    expect(text).not.toMatch(/\bPASS\b/);
  });
  it('shows invalid candidates, unverified trust, and received timestamps in expandable topic rows', () => {
    const snapshot = healthyMqttSnapshot();
    const receivedAtMs = Date.now() - 5_000;
    const candidatePayload = {
      v: 2,
      sid: '7a8b9c0d',
      q: 9,
      t: receivedAtMs,
      f: 433_920_000,
      a: 'not-an-angle',
    };
    Object.assign(snapshot.topics['telemetry/doa'], {
      status: 'INVALID',
      received_at_ms: receivedAtMs,
      payload: null,
      candidate_payload: candidatePayload,
      error: 'INVALID_FIELD',
    });
    addDiagnosticObservations(snapshot);
    const latestAtMs = Date.now() - 120_500;
    snapshot.last_received_at_ms = latestAtMs;

    const markup = renderPage({ rdfNodeMqtt: snapshot });
    const text = visibleText(markup);

    expect(text).toContain('MQTT topic payloads');
    expect(text).toContain('telemetry/doa');
    expect(text).toContain('INVALID_FIELD');
    expect(text).toContain('not-an-angle');
    expect(text).toContain('UNVERIFIED');
    expect(markup).toContain('status-warn');
    expect(markup.toLowerCase()).toContain(`datetime="${new Date(receivedAtMs).toISOString().toLowerCase()}"`);
    expect(text).toContain('Latest MQTT update');
    expect(text).toContain('2 minutes ago');
    expect(markup.toLowerCase()).toContain(`datetime="${new Date(latestAtMs).toISOString().toLowerCase()}"`);
  });

  it('shows timestamp and parser error without inventing a candidate for unstructured invalid input', () => {
    const snapshot = healthyMqttSnapshot();
    const receivedAtMs = Date.now() - 5_000;
    Object.assign(snapshot.topics['telemetry/doa'], {
      status: 'INVALID',
      received_at_ms: receivedAtMs,
      payload: null,
      candidate_payload: null,
      error: 'PAYLOAD_TOO_LARGE',
    });

    const markup = renderPage({ rdfNodeMqtt: snapshot });
    const text = visibleText(markup);
    const firstTopicDisclosure = markup.match(/<details class="system-health-mqtt-topic">([\s\S]*?<\/details>)/u)?.[1] ?? '';

    expect(text).toContain('PAYLOAD_TOO_LARGE');
    expect(text).toContain('No structured candidate payload is available for this invalid message.');
    expect(firstTopicDisclosure).not.toContain('Observed payload; canonical readings');
    expect(markup.toLowerCase()).toContain(`datetime="${new Date(receivedAtMs).toISOString().toLowerCase()}"`);
    expect(text).not.toContain('not-an-angle');
  });

  it.each([
    [2_500, '2 seconds ago'],
    [120_500, '2 minutes ago'],
    [7_200_500, '2 hours ago'],
    [172_800_500, '2 days ago'],
  ])('formats MQTT update age as %s ms: %s', (ageMs, label) => {
    const snapshot = healthyMqttSnapshot();
    snapshot.last_received_at_ms = Date.now() - ageMs;

    expect(visibleText(renderPage({ rdfNodeMqtt: snapshot }))).toContain(label);
  });

  it('renders complete Edge health and health-detail fields as a separate subgroup', () => {
    const text = visibleText(renderPage());

    expect(text).toContain('Run state RUNNING');
    expect(text).toContain('Edge source age 250 ms');
    expect(text).toContain('Edge temperature 41.5 °C');
    expect(text).toContain('Edge health detail');
    expect(text).toContain('Edge USB 0');
    expect(text).toContain('Local USB telemetry PRESENT');
    expect(text).toContain('CPU 37.5 %');
    expect(text).toContain('Memory 45.2 %');
    expect(text).toContain('Free disk 62.1 %');
    expect(text).toContain('TX 12.5 kbit/s');
    expect(text).toContain('RX 25.2 kbit/s');
    expect(text).toContain('Acquisition drops 4');
    expect(text).toContain('Parse errors 1');
  });

  it('renders health-detail sync flags in frame, sample-delay, IQ order without coercion', () => {
    const text = visibleText(renderPage());
    const frame = text.indexOf('Frame sync TRUE');
    const sampleDelay = text.indexOf('Sample-delay sync NOT REPORTED');
    const iq = text.indexOf('IQ sync FALSE');

    expect(frame).toBeGreaterThanOrEqual(0);
    expect(sampleDelay).toBeGreaterThan(frame);
    expect(iq).toBeGreaterThan(sampleDelay);
    expect(text).toContain('Throttled FALSE');
    expect(text).toContain('Undervoltage FALSE');
  });

  it('shows stale detail status instead of cached values past the 15-second boundary', () => {
    const snapshot = healthyMqttSnapshot();
    const detail = snapshot.topics['telemetry/health/detail'];
    const payload = detail.payload as Record<string, unknown>;
    snapshot.topics['telemetry/health/detail'] = {
      ...detail,
      received_at_ms: Date.now() - 15_001,
      payload: { ...payload, t: Date.now() },
    };
    const text = visibleText(renderPage({ rdfNodeMqtt: snapshot }));

    expect(text).toContain('CPU STALE');
    expect(text).not.toContain('CPU 37.5 %');
  });

  it('shows separate diagnostic freshness, trust, age, raw values, and reasons without sample arrays', () => {
    const snapshot = healthyMqttSnapshot();
    const values = addDiagnosticObservations(snapshot);
    const markup = renderPage({ rdfNodeMqtt: snapshot });
    const text = visibleText(markup);

    expect(text).toContain('Diagnostic observations');
    expect(text).toContain('Diagnostic DoA FRESH');
    expect(text).toContain('Diagnostic Angular FRESH');
    expect(text).toContain('Trust UNVERIFIED');
    expect(text).toContain('Receive age');
    expect(text).toContain('Source age');
    expect(text).toContain('43.5°');
    expect(text).toContain('433.92 MHz');
    expect(text).toContain('SOURCE_PARSE_UNVERIFIED');
    expect(text).toContain('flags 3');
    expect(text).toContain('Local USB telemetry PRESENT');
    expect(text).toContain('Edge USB 0');
    expect(markup).not.toContain(JSON.stringify(values));
  });

  it('marks Angular diagnostics stale without the clock bit and keeps their reasons visible', () => {
    const snapshot = healthyMqttSnapshot();
    addDiagnosticObservations(snapshot, 1);
    const text = visibleText(renderPage({ rdfNodeMqtt: snapshot }));

    expect(text).toContain('Diagnostic Angular STALE');
    expect(text).toContain('CLOCK_FRESHNESS_UNVERIFIED');
    expect(text).toContain('Trust UNVERIFIED');
  });

  it('does not let diagnostic DoA replace the canonical DoA estimate', () => {
    const snapshot = healthyMqttSnapshot();
    addDiagnosticObservations(snapshot);
    snapshot.topics['telemetry/doa'] = emptyObservation();
    const text = visibleText(renderPage({ rdfNodeMqtt: snapshot }));

    expect(text).toContain('Diagnostic DoA FRESH');
    expect(text).toContain('DoA estimate UNAVAILABLE');
    expect(text).not.toContain('DoA estimate CURRENT');
  });
});
