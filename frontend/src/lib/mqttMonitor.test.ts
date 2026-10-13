import { describe, expect, it } from 'vitest';
import {
  isRedactedPayloadKey,
  lastMessageAgeMs,
  mqttDetailRecords,
  mqttKindRows,
  mqttTransportFields,
  normalizeMqttSnapshot,
  normalizeRdfNodeSnapshot,
  RDF_LOCAL_HOLD_MS,
  rdfTopicRows,
  sanitizeMqttPayload,
} from './mqttMonitor';
import { normalizeConsoleConfig } from '../api';

const NOW = 1_790_668_800_000;
const READ_AT = 5_000_000;

// Shape of GET /api/mqtt from tools/sdr_doa_mqtt_monitor.py.
function monitorBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    read_only: true,
    publish_enabled: false,
    host: '127.0.0.1',
    port: 18884,
    transport: 'tcp',
    ws_path: '/mqtt',
    root: 'sdr/v1/uav-01',
    now_ms: NOW,
    connection: 'connected',
    last_error: null,
    received: 607,
    valid: 605,
    invalid: 0,
    cleared: 2,
    total_bytes: 90_000,
    last_received_at_ms: NOW,
    last_age_ms: 0,
    last_latency_ms: 12,
    last_topic: 'sdr/v1/uav-01/telemetry/health',
    kind_counts: { doa: 1, health: 600, state: 3, availability: 1 },
    topic_counts: { 'sdr/v1/uav-01/telemetry/doa': 1 },
    last_by_kind: {
      doa: {
        topic: 'sdr/v1/uav-01/telemetry/doa', kind: 'doa', received_at_ms: NOW - 600_000, age_ms: 600_000,
        bytes: 180, qos: 0, retained: false, valid: true, latency_ms: 0, source_ts_ms: NOW - 600_000,
        validity_flags: { valid: false }, source: 'synthetic',
        payload: { v: 1, ts_ms: NOW - 600_000, seq: 1, valid: false, relative_doa_deg: 137.4, source: 'synthetic' },
      },
      health: {
        kind: 'health', received_at_ms: NOW, age_ms: 0, bytes: 220, qos: 0, retained: false, valid: true,
        latency_ms: 12, source_ts_ms: NOW - 12, validity_flags: { doa_valid: false, settings_valid: true },
        payload: { v: 1, ts_ms: NOW - 12, state: 'STALE', doa_valid: false, settings_valid: true, reasons: ['STATUS_STALE', 'NODE_CLOCK_STALLED', 'bad code'] },
      },
      state: {
        kind: 'state', received_at_ms: NOW - 1_000, age_ms: 1_000, bytes: 0, qos: 1, retained: false, valid: false,
        cleared: true, latency_ms: null, source_ts_ms: null,
      },
      availability: {
        kind: 'availability', received_at_ms: NOW - 2_000, age_ms: 2_000, bytes: 60, qos: 1, retained: true, valid: true,
        latency_ms: null, source_ts_ms: NOW - 3_600_000,
        payload: { v: 1, ts_ms: NOW - 3_600_000, online: false, reason: 'CONNECTION_LOST' },
      },
    },
    ...overrides,
  };
}

describe('MQTT payload redaction', () => {
  it('keeps validity flags and redacts whole-word identifiers and secrets', () => {
    for (const key of ['valid', 'doa_valid', 'settings_valid', 'grid', 'config_rev', 'source', 'reasons']) {
      expect(isRedactedPayloadKey(key), key).toBe(false);
    }
    for (const key of ['id', 'station_id', 'clientId', 'hardware', 'device', 'serial', 'host', 'hostname', 'topic', 'uuid', 'password', 'api_key', 'session_token']) {
      expect(isRedactedPayloadKey(key), key).toBe(true);
    }
  });

  it('sanitizes nested payloads without losing the node flags', () => {
    expect(sanitizeMqttPayload({ valid: false, doa_valid: true, id: 'cmd-1', error: { code: 'X', device_serial: 'abc' }, n: Number.NaN })).toEqual({
      valid: false,
      doa_valid: true,
      id: '[REDACTED]',
      error: { code: 'X', device_serial: '[REDACTED]' },
      n: null,
    });
  });
});

describe('normalizeMqttSnapshot', () => {
  it('rejects a non-object response', () => {
    expect(() => normalizeMqttSnapshot([], READ_AT)).toThrow('invalid shape');
    expect(() => normalizeMqttSnapshot(null, READ_AT)).toThrow('invalid shape');
  });

  it('keeps the disabled response minimal', () => {
    expect(normalizeMqttSnapshot({ enabled: false, read_only: true, publish_enabled: false }, READ_AT)).toEqual({
      fetched_at_ms: READ_AT,
      enabled: false,
      read_only: true,
      publish_enabled: false,
      last_error: null,
      last_received_at_ms: null,
      last_age_ms: null,
      last_latency_ms: null,
      last_topic: null,
    });
  });

  it('validates fields and sanitizes payloads', () => {
    const snapshot = normalizeMqttSnapshot(monitorBody({
      transport: 'udp',
      ws_path: '/mqtt?x=1',
      received: -1,
      kind_counts: { doa: 1, health: 1.5, 'Bad Kind': 3 },
    }), READ_AT);
    expect(snapshot.transport).toBeUndefined();
    expect(snapshot.ws_path).toBeUndefined();
    expect(snapshot.received).toBeUndefined();
    expect(snapshot.kind_counts).toEqual({ doa: 1 });
    const doa = snapshot.last_by_kind?.doa;
    expect(doa?.validity_flags).toEqual({ valid: false });
    expect((doa?.payload as Record<string, unknown>).valid).toBe(false);
    expect(doa).not.toHaveProperty('topic');
    expect(snapshot.fetched_at_ms).toBe(READ_AT);
  });

  it('derives an entry age from the server clock when age_ms is missing', () => {
    const body = monitorBody();
    const entries = body.last_by_kind as Record<string, Record<string, unknown>>;
    delete entries.doa.age_ms;
    expect(normalizeMqttSnapshot(body, READ_AT).last_by_kind?.doa.age_ms).toBe(600_000);
  });
});

describe('mqttKindRows', () => {
  const snapshot = normalizeMqttSnapshot(monitorBody(), READ_AT);
  const rows = mqttKindRows(snapshot, READ_AT);
  const row = (kind: string) => rows.find((item) => item.kind === kind)!;

  it('reads the count per kind, not per topic', () => {
    expect(row('doa').count).toBe(1);
    expect(row('health').count).toBe(600);
    expect(rows.map((item) => item.kind)).toEqual(['doa', 'health', 'state', 'availability']);
  });

  it('marks an old DoA stale even while health keeps arriving', () => {
    expect(row('doa')).toMatchObject({ contract: 'VALID', ageMs: 600_000, stale: true, synthetic: true });
    expect(row('doa').flags).toEqual([{ name: 'valid', value: false }]);
    expect(row('health')).toMatchObject({ ageMs: 0, stale: false, healthState: 'STALE' });
    expect(row('health').reasons).toEqual(['STATUS_STALE', 'NODE_CLOCK_STALLED']);
    expect(lastMessageAgeMs(snapshot, READ_AT)).toBe(0);
  });

  it('ages records locally between reads', () => {
    const later = mqttKindRows(snapshot, READ_AT + 9_000);
    expect(later.find((item) => item.kind === 'health')).toMatchObject({ ageMs: 9_000, stale: true });
    expect(lastMessageAgeMs(snapshot, READ_AT + 9_000)).toBe(9_000);
  });

  it('shows a retained clear as CLEARED, never stale or invalid', () => {
    expect(row('state')).toMatchObject({ contract: 'CLEARED', stale: false, bytes: 0 });
  });

  it('reports availability and judges a broker replay by its own timestamp', () => {
    expect(row('availability').availability).toEqual({ online: false, reason: 'CONNECTION_LOST' });
    expect(row('availability')).toMatchObject({ retained: true, sourceAgeMs: 3_600_000, stale: false });
    const replay = normalizeMqttSnapshot(monitorBody({
      last_by_kind: {
        state: { kind: 'state', received_at_ms: NOW, age_ms: 0, retained: true, valid: true, source_ts_ms: NOW - 7_200_000, payload: { v: 1 } },
        config_reported: { kind: 'config_reported', received_at_ms: NOW, age_ms: 0, retained: true, valid: true, source_ts_ms: null },
      },
    }), READ_AT);
    const replayRows = mqttKindRows(replay, READ_AT);
    expect(replayRows.find((item) => item.kind === 'state')).toMatchObject({ ageMs: 0, sourceAgeMs: 7_200_000, stale: true });
    expect(replayRows.find((item) => item.kind === 'config_reported')).toMatchObject({ sourceAgeMs: null, stale: true });
  });

  it('builds the JSON detail from sanitized entries only', () => {
    const detail = mqttDetailRecords(snapshot) as Record<string, Record<string, unknown>>;
    expect(detail.doa.validity_flags).toEqual({ valid: false });
    expect(detail.state.cleared).toBe(true);
    expect(JSON.stringify(detail)).not.toContain('sdr/v1/uav-01');
  });
});

describe('MQTT transport settings', () => {
  it('leaves unreported fields out and validates the WebSocket path', () => {
    expect(mqttTransportFields(undefined, undefined)).toEqual({ ok: true, value: {} });
    expect(mqttTransportFields('tcp', ' /ws ')).toEqual({ ok: true, value: { mqtt_transport: 'tcp', mqtt_ws_path: '/ws' } });
    expect(mqttTransportFields('websockets', 'mqtt')).toEqual({ ok: false, error: 'config.mqttWsPathInvalid' });
    expect(mqttTransportFields('websockets', '/mqtt?token=1')).toEqual({ ok: false, error: 'config.mqttWsPathInvalid' });
    expect(mqttTransportFields('websockets', `/${'a'.repeat(128)}`)).toEqual({ ok: false, error: 'config.mqttWsPathInvalid' });
  });

  it('carries transport and path through the console config contract', () => {
    const base = { base_url: 'http://doasdr.local:8081', mqtt_host: '127.0.0.1', mqtt_port: 18884, refresh_seconds: 2 };
    expect(normalizeConsoleConfig({ ...base, mqtt_transport: 'tcp', mqtt_ws_path: '/ws' })).toEqual({ ...base, mqtt_transport: 'tcp', mqtt_ws_path: '/ws' });
    expect(normalizeConsoleConfig(base)).toEqual(base);
    expect(() => normalizeConsoleConfig({ ...base, mqtt_transport: 'udp' })).toThrow('MQTT transport');
    expect(() => normalizeConsoleConfig({ ...base, mqtt_ws_path: 'mqtt' })).toThrow('WebSocket path');
  });
});

// Shape of GET /api/mqtt/rdf-node from tools/rdf_node_mqtt_v2.py.
function rdfBody(): Record<string, unknown> {
  const empty = { status: 'UNAVAILABLE', received_at_ms: null, qos: null, retained: null, payload: null, error: null };
  return {
    node_id: 'uav-01',
    now_ms: NOW,
    enabled: true,
    connection: 'ready',
    last_error: null,
    received: 4,
    valid: 3,
    invalid: 1,
    last_received_at_ms: NOW - 500,
    topic_counts: { 'telemetry/doa': 1, 'telemetry/health': 1, 'telemetry/angular': 1, availability: 1 },
    topics: {
      'telemetry/doa': { status: 'STALE', received_at_ms: NOW - 6_000, qos: 0, retained: false, error: 'SOURCE_STALE', payload: { v: 2, sid: '7a8b9c0d', a: 137.4, c: 8.27, ok: 1, rev: 7 } },
      'telemetry/health': { status: 'FRESH', received_at_ms: NOW - 500, qos: 0, retained: false, error: null, payload: { v: 2, run: 1, daq: 1, temp: 61.4, rev: 7 } },
      'telemetry/angular': { status: 'FRESH', received_at_ms: NOW - 500, qos: 0, retained: false, error: null, payload: { encoding: 'q16', raw_doa_deg: 137.4, revision: 7, values: new Array(360).fill(12.5) } },
      availability: { status: 'INVALID', received_at_ms: NOW - 900, qos: 1, retained: true, error: 'bad error text', payload: null },
      state: { ...empty, status: 'SOMETHING_NEW' },
    },
  };
}

describe('RDF Node v2 snapshot', () => {
  const snapshot = normalizeRdfNodeSnapshot(rdfBody(), READ_AT);

  it('normalizes every subscribed topic and drops the angular vector', () => {
    expect(Object.keys(snapshot.topics)).toHaveLength(10);
    expect(snapshot.topics['ack/operation'].status).toBe('UNAVAILABLE');
    expect(snapshot.topics.state.status).toBe('UNAVAILABLE');
    expect(snapshot.topics['telemetry/angular'].payload).toEqual({ encoding: 'q16', raw_doa_deg: 137.4, revision: 7 });
    expect(snapshot.topics.availability.error).toBeNull();
    expect(() => normalizeRdfNodeSnapshot('x', READ_AT)).toThrow('invalid shape');
  });

  it('shows DoA and angular values only while FRESH', () => {
    const rows = rdfTopicRows(snapshot, READ_AT);
    const doa = rows.find((row) => row.suffix === 'telemetry/doa')!;
    expect(doa).toMatchObject({ status: 'STALE', error: 'SOURCE_STALE', summary: [], withheld: true, ageMs: 6_000 });
    const angular = rows.find((row) => row.suffix === 'telemetry/angular')!;
    expect(angular.summary).toEqual([['encoding', 'q16'], ['raw_doa_deg', '137.4'], ['revision', '7']]);
    const health = rows.find((row) => row.suffix === 'telemetry/health')!;
    expect(health.summary).toContainEqual(['temp', '61.4']);
  });

  it('stops trusting FRESH when the reads stop', () => {
    const rows = rdfTopicRows(snapshot, READ_AT + RDF_LOCAL_HOLD_MS + 1);
    const angular = rows.find((row) => row.suffix === 'telemetry/angular')!;
    expect(angular).toMatchObject({ status: 'STALE', summary: [], withheld: true });
    expect(rows.find((row) => row.suffix === 'telemetry/health')!.ageMs).toBe(500 + RDF_LOCAL_HOLD_MS + 1);
  });
});
