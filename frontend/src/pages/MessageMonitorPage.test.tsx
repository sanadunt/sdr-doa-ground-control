import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  ConsoleConfig,
  RdfNodeMqttAngularFrame,
  RdfNodeMqttDiagnosticAngularFrame,
  RdfNodeMqttDiagnosticDoa,
  RdfNodeMqttObservation,
  RdfNodeMqttSnapshot,
  RdfNodeMqttTopic,
} from '../types';
import { RDF_NODE_MQTT_TOPICS } from '../types';
import { MessageMonitorPage } from './MessageMonitorPage';

const config: ConsoleConfig = {
  base_url: 'http://127.0.0.1:8787',
  mqtt_host: '',
  mqtt_port: 1883,
  mqtt_transport: 'tcp',
  mqtt_ws_path: '/',
  mqtt_username: '',
  mqtt_password_set: false,
  rdf_node_id: 'uav-01',
  refresh_seconds: 1,
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

function createSnapshot(): RdfNodeMqttSnapshot {
  const topics = Object.fromEntries(
    RDF_NODE_MQTT_TOPICS.map((topic) => [topic, emptyObservation()]),
  ) as Record<RdfNodeMqttTopic, RdfNodeMqttObservation>;
  const topicCounts = Object.fromEntries(
    RDF_NODE_MQTT_TOPICS.map((topic) => [topic, 0]),
  ) as Record<RdfNodeMqttTopic, number>;
  return {
    enabled: true,
    connection: 'ready',
    node_id: 'uav-01',
    last_error: null,
    received: 0,
    valid: 0,
    invalid: 0,
    last_received_at_ms: null,
    topic_counts: topicCounts,
    topics,
  };
}

function observe(
  snapshot: RdfNodeMqttSnapshot,
  topic: RdfNodeMqttTopic,
  payload: RdfNodeMqttObservation['payload'],
  status: RdfNodeMqttObservation['status'] = 'FRESH',
): void {
  snapshot.topics[topic] = {
    status,
    received_at_ms: Date.now() - 1_500,
    qos: topic.startsWith('telemetry/') ? 0 : 1,
    retained: status === 'CONTEXT',
    payload,
    candidate_payload: null,
    error: status === 'INVALID' ? 'INVALID_FIELD' : null,
  };
  snapshot.topic_counts[topic] = 1;
  snapshot.received += 1;
  if (status === 'FRESH') snapshot.valid += 1;
  else if (status === 'INVALID') snapshot.invalid += 1;
  snapshot.last_received_at_ms = snapshot.topics[topic].received_at_ms;
}

function addHealthyHealth(snapshot: RdfNodeMqttSnapshot, status: 'FRESH' | 'STALE' = 'FRESH'): void {
  observe(snapshot, 'telemetry/health', {
    v: 2,
    sid: '7a8b9c0d',
    q: 86,
    t: Date.now() - 1_500,
    run: 1,
    daq: 1,
    drop: 12,
    age: 280,
    temp: 61.4,
    clk: 1,
    rev: 7,
  }, status);
}

function addDoa(snapshot: RdfNodeMqttSnapshot, status: 'FRESH' | 'STALE' = 'FRESH'): void {
  observe(snapshot, 'telemetry/doa', {
    v: 2,
    sid: '7a8b9c0d',
    q: 1245,
    t: Date.now() - 1_500,
    f: 433_920_000,
    a: 137.4,
    c: 8.27,
    p: -54.2,
    rev: 7,
    ok: 1,
  }, status);
}

function addDiagnosticDoa(
  snapshot: RdfNodeMqttSnapshot,
  overrides: Partial<RdfNodeMqttDiagnosticDoa> = {},
  receivedAtMs = Date.now() - 1_500,
  status: 'FRESH' | 'STALE' = 'FRESH',
): void {
  const sourceTimestamp = Date.now() - 1_500;
  const payload: RdfNodeMqttDiagnosticDoa = {
    v: 2,
    sid: '7a8b9c0d',
    q: 1246,
    source: 'doa.xml',
    source_timestamp_ms: sourceTimestamp,
    observed_timestamp_ms: sourceTimestamp,
    raw_doa_deg: 41.25,
    frequency_mhz: 433.92,
    trust: 'UNVERIFIED',
    validation_reasons: ['DIAGNOSTIC_UNVERIFIED', 'SOURCE_PARSE_UNVERIFIED'],
    ...overrides,
  };
  observe(snapshot, 'telemetry/diagnostic/doa', payload, status);
  snapshot.topics['telemetry/diagnostic/doa'].received_at_ms = receivedAtMs;
}

function addDiagnosticAngular(
  snapshot: RdfNodeMqttSnapshot,
  overrides: Partial<RdfNodeMqttDiagnosticAngularFrame> = {},
  receivedAtMs = Date.now() - 1_500,
  status: 'FRESH' | 'STALE' = 'FRESH',
): void {
  const payload: RdfNodeMqttDiagnosticAngularFrame = {
    encoding: 'q16',
    sid: 0x7a8b9c0d,
    q: 1246,
    source_timestamp_ms: Date.now() - 1_500,
    frequency_hz: 433_920_000,
    revision: 7,
    vfo: 0,
    convention: 1,
    raw_doa_deg: 41.25,
    confidence_native_db: 8.27,
    flags: 3,
    trust: 'UNVERIFIED',
    validation_reasons: ['DIAGNOSTIC_UNVERIFIED'],
    values: Array.from({ length: 360 }, (_, index) => index),
    ...overrides,
  };
  observe(snapshot, 'telemetry/diagnostic/angular', payload, status);
  snapshot.topics['telemetry/diagnostic/angular'].received_at_ms = receivedAtMs;
}

function renderPage(snapshot: RdfNodeMqttSnapshot | null, error: string | null = null): string {
  return renderToStaticMarkup(
    <MessageMonitorPage
      mqtt={null}
      config={config}
      onMqttChanged={() => undefined}
      rdfNodeMqtt={snapshot}
      rdfNodeMqttError={error}
      onRefreshRdfNodeMqtt={async () => undefined}
    />,
  );
}

function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

function topicRow(markup: string, topic: string): string {
  const marker = `<th scope="row">${topic}</th>`;
  const index = markup.indexOf(marker);
  if (index < 0) return '';
  const start = markup.lastIndexOf('<tr', index);
  const end = markup.indexOf('</tr>', index);
  return start < 0 || end < 0 ? '' : markup.slice(start, end + '</tr>'.length);
}

describe('MessageMonitorPage RDF Node v2 panel', () => {
  it('shows all twelve topic placeholders before a snapshot arrives', () => {
    const markup = renderPage(null);
    const text = visibleText(markup);
    const tables = markup.match(/<tbody>([\s\S]*?)<\/tbody>/gu) ?? [];
    const topicRows = tables[tables.length - 1] ?? '';

    for (const topic of RDF_NODE_MQTT_TOPICS) expect(text).toContain(topic);
    expect(topicRows.match(/>UNAVAILABLE<\/span>/gu)).toHaveLength(12);
    expect(text).toContain('Waiting for the first RDF Node snapshot.');
  });
  it('shows safe candidate JSON for invalid MQTT observations without changing their status', () => {
    const snapshot = createSnapshot();
    observe(snapshot, 'telemetry/doa', null, 'INVALID');
    Object.assign(snapshot.topics['telemetry/doa'], {
      candidate_payload: { v: 2, a: 'not-an-angle' },
    });

    const row = topicRow(renderPage(snapshot), 'telemetry/doa');
    const text = visibleText(row);

    expect(text).toContain('INVALID');
    expect(text).toContain('INVALID_FIELD');
    expect(text).toContain('Candidate payload');
    expect(text).toContain('"a": "not-an-angle"');
  });


  it('shows fresh DoA as current only alongside matching fresh healthy DAQ evidence', () => {
    const snapshot = createSnapshot();
    addHealthyHealth(snapshot);
    addDoa(snapshot);

    const text = visibleText(renderPage(snapshot));

    expect(text).toContain('DAQ HEALTHY');
    expect(text).toContain('CURRENT DOA');
    expect(text).toContain('137.4°');
    expect(text).toContain('433920000 Hz');
    expect(text).toContain('Age');
  });

  it('matches hexadecimal session IDs without case sensitivity', () => {
    const snapshot = createSnapshot();
    addHealthyHealth(snapshot);
    addDoa(snapshot);
    (snapshot.topics['telemetry/doa'].payload as Record<string, unknown>).sid = '7A8B9C0D';

    const text = visibleText(renderPage(snapshot));

    expect(text).toContain('CURRENT DOA');
    expect(text).toContain('137.4°');
  });


  it('expires cached fresh health and DoA while the next snapshot request is pending', () => {
    const snapshot = createSnapshot();
    addHealthyHealth(snapshot);
    addDoa(snapshot);
    snapshot.topics['telemetry/health'].received_at_ms = Date.now() - 9_000;
    snapshot.topics['telemetry/doa'].received_at_ms = Date.now() - 6_000;

    const text = visibleText(renderPage(snapshot));

    expect(text).toContain('DAQ STALE');
    expect(text).not.toContain('DAQ HEALTHY');
    expect(text).not.toContain('CURRENT DOA');
  });

  it('expires telemetry by source timestamp even when recently received', () => {
    const sourceNow = Date.now();
    const snapshot = createSnapshot();
    addHealthyHealth(snapshot);
    addDoa(snapshot);
    const health = snapshot.topics['telemetry/health'];
    const doa = snapshot.topics['telemetry/doa'];
    (health.payload as Record<string, unknown>).t = sourceNow - 8_500;
    (doa.payload as Record<string, unknown>).t = sourceNow - 5_500;
    health.received_at_ms = sourceNow - 500;
    doa.received_at_ms = sourceNow - 500;

    const frame: RdfNodeMqttAngularFrame = {
      encoding: 'q16',
      sid: 0x7a8b9c0d,
      q: 1245,
      timestamp_ms: sourceNow - 10_500,
      frequency_hz: 433_920_000,
      revision: 7,
      vfo: 0,
      convention: 1,
      raw_doa_deg: null,
      confidence_native_db: null,
      values: Array.from({ length: 360 }, () => 12.5),
    };
    observe(snapshot, 'telemetry/angular', frame);
    snapshot.topics['telemetry/angular'].received_at_ms = sourceNow - 500;

    const text = visibleText(renderPage(snapshot));

    expect(text).toContain('DAQ STALE');
    expect(text).not.toContain('DAQ HEALTHY');
    expect(text).not.toContain('CURRENT DOA');
    expect(text).not.toContain('CURRENT FRAME');
    expect(text).toContain('360 samples · not current');
  });



  it('keeps stale health and DoA from appearing healthy or current', () => {
    const snapshot = createSnapshot();
    addHealthyHealth(snapshot, 'STALE');
    addDoa(snapshot, 'STALE');

    const text = visibleText(renderPage(snapshot));

    expect(text).toContain('STALE');
    expect(text).not.toContain('DAQ HEALTHY');
    expect(text).not.toContain('CURRENT DOA');
    expect(text).toContain('DoA not current');
  });

  it('shows offline Control availability independently from fresh DAQ health', () => {
    const snapshot = createSnapshot();
    addHealthyHealth(snapshot);
    observe(snapshot, 'availability', { v: 2, sid: '7a8b9c0d', online: false, reason: 'CONNECTION_LOST' }, 'CONTEXT');

    const text = visibleText(renderPage(snapshot));

    expect(text).toContain('Control availability');
    expect(text).toContain('OFFLINE (CONTEXT)');
    expect(text).toContain('DAQ HEALTHY');
    expect(text).toContain('Availability is not DAQ health.');
  });

  it('does not treat a ready MQTT connection as healthy DAQ', () => {
    const snapshot = createSnapshot();
    const text = visibleText(renderPage(snapshot));

    expect(text).toContain('READY');
    expect(text).toContain('DAQ UNAVAILABLE');
    expect(text).not.toContain('DAQ HEALTHY');
  });

  it('keeps disabled and failed snapshot states explicit', () => {
    const disabled = createSnapshot();
    disabled.enabled = false;
    disabled.connection = 'disabled';

    expect(visibleText(renderPage(disabled))).toContain('DISABLED');
    expect(visibleText(renderPage(null, 'request failed'))).toContain('RDF Node snapshot request failed.');
  });

  it('does not present a missing Angular frame as complete data', () => {
    const snapshot = createSnapshot();

    const text = visibleText(renderPage(snapshot));

    expect(text).toContain('No complete Angular frame.');
    expect(text).not.toContain('Angular samples');
  });

  it('renders metadata and every sample from a complete 360-value Angular frame', () => {
    const snapshot = createSnapshot();
    addHealthyHealth(snapshot);
    const values = Array.from({ length: 360 }, (_, index) => index - 180);
    const frame: RdfNodeMqttAngularFrame = {
      encoding: 'q16',
      sid: 0x7a8b9c0d,
      q: 1245,
      timestamp_ms: Date.now() - 1_500,
      frequency_hz: 433_920_000,
      revision: 7,
      vfo: 0,
      convention: 1,
      raw_doa_deg: 137.4,
      confidence_native_db: 8.27,
      values,
    };
    observe(snapshot, 'telemetry/angular', frame);

    const markup = renderPage(snapshot);

    expect(markup).toContain('433920000 Hz');
    expect(markup).toContain('360 samples');
    expect(markup).toContain(JSON.stringify(values));
  });

  it('does not present a complete Angular frame as current when its snapshot age expires', () => {
    const snapshot = createSnapshot();
    addHealthyHealth(snapshot);
    const frame: RdfNodeMqttAngularFrame = {
      encoding: 'q16',
      sid: 0x7a8b9c0d,
      q: 1245,
      timestamp_ms: Date.now() - 1_500,
      frequency_hz: 433_920_000,
      revision: 7,
      vfo: 0,
      convention: 1,
      raw_doa_deg: null,
      confidence_native_db: null,
      values: Array.from({ length: 360 }, () => 12.5),
    };
    observe(snapshot, 'telemetry/angular', frame);
    snapshot.topics['telemetry/angular'].received_at_ms = Date.now() - 11_000;

    const text = visibleText(renderPage(snapshot));

    expect(text).not.toContain('CURRENT FRAME');
    expect(text).toContain('360 samples · not current');
  });

  it('requires a known non-null health and Angular revision before showing a current frame', () => {
    const snapshot = createSnapshot();
    observe(snapshot, 'telemetry/health', {
      v: 2,
      sid: '7a8b9c0d',
      q: 86,
      t: Date.now() - 1_500,
      run: 1,
      daq: 1,
      rev: null,
    });
    const frame: RdfNodeMqttAngularFrame = {
      encoding: 'q16',
      sid: 0x7a8b9c0d,
      q: 1245,
      timestamp_ms: Date.now() - 1_500,
      frequency_hz: 433_920_000,
      revision: null,
      vfo: 0,
      convention: 1,
      raw_doa_deg: null,
      confidence_native_db: null,
      values: Array.from({ length: 360 }, () => 12.5),
    };
    observe(snapshot, 'telemetry/angular', frame);

    const text = visibleText(renderPage(snapshot));

    expect(text).not.toContain('CURRENT FRAME');
    expect(text).toContain('DAQ HEALTHY');
  });

  it('rejects positive DoA presentation when fresh observations disagree on session or revision', () => {
    const snapshot = createSnapshot();
    addHealthyHealth(snapshot);
    observe(snapshot, 'telemetry/doa', {
      sid: 'different-session',
      q: 1245,
      rev: 8,
      ok: 1,
      a: 137.4,
    });

    const text = visibleText(renderPage(snapshot));

    expect(text).toContain('DAQ HEALTHY');
    expect(text).not.toContain('CURRENT DOA');
    expect(text).toContain('DoA not current');
  });

  it('renders only allowlisted ACK details and never dumps credential-like fields', () => {
    const snapshot = createSnapshot();
    observe(snapshot, 'ack/config', {
      id: 'ack-17',
      status: 'APPLIED',
      result: {
        proof: 'source_correlated',
        challenge: 'private-challenge',
        password: 'server-password',
      },
      error: {
        error: 'REBOOT_BLOCKED',
        code: 'COMMAND_REJECTED',
        credential: 'private-error-credential',
      },
      extra: 'unrestricted payload',
    });

    const text = visibleText(renderPage(snapshot));

    expect(text).toContain('ack-17');
    expect(text).toContain('APPLIED');
    expect(text).toContain('REBOOT_BLOCKED');
    expect(text).toContain('COMMAND_REJECTED');
    expect(text).not.toContain('private-challenge');
    expect(text).not.toContain('server-password');
    expect(text).not.toContain('private-error-credential');
    expect(text).not.toContain('unrestricted payload');
    expect(text).toContain('ACK statuses are Edge-reported observations; Ground sends no command or receipt.');
  });

  it('renders DoA diagnostic raw values with separate freshness and trust evidence', () => {
    const snapshot = createSnapshot();
    const now = Date.now();
    addDiagnosticDoa(
      snapshot,
      { source_timestamp_ms: now - 4_000, observed_timestamp_ms: now - 3_900 },
      now - 2_000,
    );

    const markup = renderPage(snapshot);
    const text = visibleText(markup);
    const row = topicRow(markup, 'telemetry/diagnostic/doa');

    expect(row).toContain('FRESH');
    expect(text).toContain('41.25°');
    expect(text).toContain('433.92 MHz');
    expect(text).toContain('Receive age');
    expect(text).toContain('Source age');
    expect(text).toContain('UNVERIFIED');
    expect(text).toContain('Edge-supplied reasons');
    expect(text).toContain('SOURCE_PARSE_UNVERIFIED');
    expect(text).not.toContain('CURRENT DOA');
  });

  it('shows Angular diagnostic flags and reasons while withholding samples until disclosure opens', () => {
    const snapshot = createSnapshot();
    const values = Array.from({ length: 360 }, (_, index) => index - 180);
    addDiagnosticAngular(snapshot, {
      flags: 1,
      values,
      validation_reasons: ['DIAGNOSTIC_UNVERIFIED', 'CLOCK_FRESHNESS_UNVERIFIED'],
    }, Date.now() - 1_000, 'STALE');

    const markup = renderPage(snapshot);
    const text = visibleText(markup);
    const row = topicRow(markup, 'telemetry/diagnostic/angular');

    expect(row).toContain('STALE');
    expect(text).toContain('flags');
    expect(text).toContain('Ground-derived reasons');
    expect(text).toContain('CLOCK_FRESHNESS_UNVERIFIED');
    expect(text).toContain('UNVERIFIED');
    expect(markup).toContain('<details');
    expect(markup).toContain('360 diagnostic samples');
    expect(markup).not.toContain(JSON.stringify(values));
    expect(text).not.toContain('CURRENT FRAME');
  });

  it.each([
    ['DoA receive age over 3 seconds', (snapshot: RdfNodeMqttSnapshot, now: number) => {
      addDiagnosticDoa(snapshot, { source_timestamp_ms: now - 1_000 }, now - 3_001);
      return 'telemetry/diagnostic/doa';
    }],
    ['DoA source age over 5 seconds', (snapshot: RdfNodeMqttSnapshot, now: number) => {
      addDiagnosticDoa(snapshot, { source_timestamp_ms: now - 5_001 }, now - 1_000);
      return 'telemetry/diagnostic/doa';
    }],
    ['future DoA source timestamp', (snapshot: RdfNodeMqttSnapshot, now: number) => {
      addDiagnosticDoa(snapshot, { source_timestamp_ms: now + 10_000 }, now - 1_000);
      return 'telemetry/diagnostic/doa';
    }],
    ['future DoA receive timestamp', (snapshot: RdfNodeMqttSnapshot, now: number) => {
      addDiagnosticDoa(snapshot, { source_timestamp_ms: now - 1_000 }, now + 10_000);
      return 'telemetry/diagnostic/doa';
    }],
    ['Angular receive age over 3 seconds', (snapshot: RdfNodeMqttSnapshot, now: number) => {
      addDiagnosticAngular(snapshot, { source_timestamp_ms: now - 1_000 }, now - 3_001);
      return 'telemetry/diagnostic/angular';
    }],
    ['Angular source age over 10 seconds', (snapshot: RdfNodeMqttSnapshot, now: number) => {
      addDiagnosticAngular(snapshot, { source_timestamp_ms: now - 10_001 }, now - 1_000);
      return 'telemetry/diagnostic/angular';
    }],
    ['Angular clock freshness flag absent', (snapshot: RdfNodeMqttSnapshot, now: number) => {
      addDiagnosticAngular(snapshot, {
        flags: 1,
        validation_reasons: ['DIAGNOSTIC_UNVERIFIED', 'CLOCK_FRESHNESS_UNVERIFIED'],
      }, now - 1_000);
      return 'telemetry/diagnostic/angular';
    }],
    ['disconnected MQTT connection', (snapshot: RdfNodeMqttSnapshot, now: number) => {
      addDiagnosticDoa(snapshot);
      snapshot.connection = 'disconnected';
      return 'telemetry/diagnostic/doa';
    }],
    ['disabled MQTT monitor', (snapshot: RdfNodeMqttSnapshot) => {
      addDiagnosticDoa(snapshot);
      snapshot.enabled = false;
      return 'telemetry/diagnostic/doa';
    }],
  ] as Array<[
    string,
    (snapshot: RdfNodeMqttSnapshot, now: number) => RdfNodeMqttTopic,
  ]>)('marks %s stale without promoting it to live data', (_label, addCandidate) => {
    const snapshot = createSnapshot();
    const topic = addCandidate(snapshot, Date.now());
    const row = topicRow(renderPage(snapshot), topic);

    expect(row).toContain('STALE');
    expect(row).not.toContain('CURRENT');
  });

  it('keeps diagnostic observations outside canonical DoA and Angular current gates', () => {
    const snapshot = createSnapshot();
    addDiagnosticDoa(snapshot);
    addDiagnosticAngular(snapshot);

    const text = visibleText(renderPage(snapshot));

    expect(text).toContain('41.25°');
    expect(text).toContain('No complete Angular frame.');
    expect(text).toContain('DoA not current.');
    expect(text).not.toContain('CURRENT DOA');
    expect(text).not.toContain('CURRENT FRAME');
  });

});
