import { describe, expect, it } from 'vitest';
import {
  isRedactedPayloadKey,
  lastMessageAgeMs,
  mqttTargetFromConfig,
  mqttTransportFields,
  normalizeMqttSnapshot,
  normalizeRdfNodeSnapshot,
  RDF_LOCAL_HOLD_MS,
  RDF_NODE_V2_SUFFIXES,
  rdfAckRows,
  rdfAckTone,
  rdfNodeRows,
  rdfStatusTone,
  rdfTopicRows,
  sanitizeMqttPayload,
} from './mqttMonitor';
import { mqttConnectPath, normalizeConsoleConfig } from '../api';

const NOW = 1_790_668_800_000;
const READ_AT = 5_000_000;

// Shape of GET /api/mqtt from tools/sdr_doa_mqtt_monitor.py: the one MQTT status.
function monitorBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    read_only: true,
    publish_enabled: false,
    host: '127.0.0.1',
    port: 18884,
    transport: 'tcp',
    ws_path: '/mqtt',
    node_id: 'uav-01',
    root: 'sdr/v2/uav-01',
    now_ms: NOW,
    connection: 'connected',
    last_error: null,
    received: 1_204,
    valid: 1_200,
    invalid: 3,
    cleared: 1,
    last_received_at_ms: NOW - 400,
    last_age_ms: 400,
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
    });
  });

  it('reads the one status: broker, node topics and their message counts', () => {
    expect(normalizeMqttSnapshot(monitorBody(), READ_AT)).toEqual({
      fetched_at_ms: READ_AT,
      enabled: true,
      read_only: true,
      publish_enabled: false,
      host: '127.0.0.1',
      port: 18884,
      transport: 'tcp',
      ws_path: '/mqtt',
      node_id: 'uav-01',
      root: 'sdr/v2/uav-01',
      now_ms: NOW,
      connection: 'connected',
      last_error: null,
      received: 1_204,
      valid: 1_200,
      invalid: 3,
      cleared: 1,
      last_received_at_ms: NOW - 400,
      last_age_ms: 400,
    });
  });

  it('validates fields and drops what the status does not carry', () => {
    const snapshot = normalizeMqttSnapshot(monitorBody({
      transport: 'udp',
      ws_path: '/mqtt?x=1',
      received: -1,
      invalid: 1.5,
      root: 'sdr/other/uav-01',
      node_id: 'bad node',
      last_by_kind: { doa: { valid: true } },
      kind_counts: { doa: 1 },
      last_topic: 'sdr/v2/uav-01/telemetry/doa',
    }), READ_AT);
    expect(snapshot.transport).toBeUndefined();
    expect(snapshot.ws_path).toBeUndefined();
    expect(snapshot.received).toBeUndefined();
    expect(snapshot.invalid).toBeUndefined();
    expect(snapshot.root).toBeUndefined();
    expect(snapshot.node_id).toBeUndefined();
    for (const key of ['last_by_kind', 'kind_counts', 'last_topic']) expect(snapshot).not.toHaveProperty(key);
  });

  it('ages the last message locally between reads', () => {
    const snapshot = normalizeMqttSnapshot(monitorBody(), READ_AT);
    expect(lastMessageAgeMs(snapshot, READ_AT)).toBe(400);
    expect(lastMessageAgeMs(snapshot, READ_AT + 9_000)).toBe(9_400);
    expect(lastMessageAgeMs(normalizeMqttSnapshot(monitorBody({ last_age_ms: null }), READ_AT), READ_AT)).toBeNull();
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

  it('reconnects with the configured transport and WebSocket path', () => {
    const base = { mqtt_host: '127.0.0.1', mqtt_port: 18884 };
    expect(mqttConnectPath(mqttTargetFromConfig({ ...base, mqtt_transport: 'tcp', mqtt_ws_path: '/ws' }))).toBe('/api/mqtt/connect?host=127.0.0.1&port=18884&transport=tcp');
    expect(mqttConnectPath(mqttTargetFromConfig({ ...base, mqtt_transport: 'websockets', mqtt_ws_path: '/ws' }))).toBe('/api/mqtt/connect?host=127.0.0.1&port=18884&transport=websockets&ws_path=%2Fws');
    // A console that did not report them keeps its saved values.
    expect(mqttConnectPath(mqttTargetFromConfig(base))).toBe('/api/mqtt/connect?host=127.0.0.1&port=18884');
    expect(mqttConnectPath({ host: '::1', port: 9001, transport: 'websockets' })).toBe('/api/mqtt/connect?host=%3A%3A1&port=9001&transport=websockets');
  });
});

// GET /api/mqtt/rdf-node as tools/rdf_node_mqtt_v2.py serves it after a healthy
// edge (payloads of the edge's own code); tools/test_rdf_node_mqtt_v2.py keeps it current.
function apiSnapshot(): Record<string, any> {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  const text = process.getBuiltinModule('node:fs').readFileSync(new URL('../../../tools/fixtures/rdf-node/api-snapshot.json', import.meta.url), 'utf8');
  return JSON.parse(text) as Record<string, any>;
}

describe('RDF Node snapshot', () => {
  const body = apiSnapshot();
  const snapshot = normalizeRdfNodeSnapshot(body, READ_AT);

  it('normalizes every subscribed topic of the edge contract and no retired one', () => {
    expect([...RDF_NODE_V2_SUFFIXES].sort()).toEqual(Object.keys(body.topics).sort());
    expect(Object.keys(snapshot.topics)).toHaveLength(12);
    expect(snapshot.topics).not.toHaveProperty('config/reported');
    expect(snapshot.topics['telemetry/angular'].status).toBe('LIVE');
    expect(snapshot.topics['telemetry/doa'].status).toBe('UNVERIFIED');
    expect(snapshot.topics['telemetry/diagnostic/angular'].status).toBe('UNVERIFIED');
    expect(snapshot.invalid).toBe(0);
    expect(() => normalizeRdfNodeSnapshot('x', READ_AT)).toThrow('invalid shape');
  });

  it('never keeps the angular values or the native settings text', () => {
    const angular = snapshot.topics['telemetry/angular'].payload!;
    expect(angular).not.toHaveProperty('values');
    expect(angular).toMatchObject({ flags: 63, values_count: 360, peak_index: 200 });
    expect(snapshot.node.parts.angular!.fields).not.toHaveProperty('values');
    expect(JSON.stringify(snapshot)).not.toContain('settings_json');
    expect(JSON.stringify(snapshot)).not.toContain('fixture-station');
  });

  it('reads the node view: LIVE angular, the RAW DoA apart, the session and the settings', () => {
    const parts = snapshot.node.parts;
    expect(parts.session).toMatchObject({ status: 'CONTEXT', fields: { sid: body.node.session.sid, cfg: body.node.session.cfg } });
    expect(parts.health!.status).toBe('FRESH');
    expect(parts.doa).toMatchObject({ status: 'LIVE', reasons: [] });
    expect(parts.angular).toMatchObject({ status: 'LIVE', reasons: [] });
    expect(parts.doa_unverified).toMatchObject({ status: 'UNVERIFIED', reasons: ['SOURCE_UNVERIFIED', 'ANGLE_UNVERIFIED'], fields: { a: 200, angle_reference: 'RAW' } });
    expect(parts.diagnostic_doa!.reasons).toEqual(['DIAGNOSTIC_UNVERIFIED', 'DAQ_NOT_HEALTHY']);
    expect(parts.angular_unverified).toMatchObject({ status: 'UNVERIFIED', fields: { from: 'telemetry/diagnostic/angular', flags: 63 } });
    expect(parts.settings).toMatchObject({ status: 'CONTEXT', reasons: [], fields: { matches_state_cfg: true } });
    expect(parts.capabilities!.fields).toMatchObject({ version: '1.0.0', remote_commands: true });
    expect(snapshot.node.acks.map((ack) => ack.status)).toEqual(['OUTCOME_UNKNOWN', 'APPLIED', 'APPLIED']);
    expect(snapshot.node.acks[0]).toMatchObject({ topic: 'ack/operation', final: true, error: 'FILENOTFOUNDERROR' });
    expect(snapshot.node.settings_requests).toBe(0);
  });

  it('marks a part from the flags the server set on it', () => {
    const changed = apiSnapshot();
    changed.node.doa.live = false;
    changed.node.doa.reasons = ['HEALTH_STALE'];
    changed.node.capabilities.session_match = false;
    changed.node.settings.matches_state_cfg = false;
    changed.node.health.fresh = false;
    changed.node.angular_unverified.validation_reasons = ['ok', 'X'.repeat(65), 'SOURCE_STALE'];
    changed.node.angular_unverified.topic = '<img src=x>';
    changed.node.angular_unverified.from = 'forged';
    changed.node.acks = [{ topic: 'cmd/config/patch', status: 'APPLIED' }, { topic: 'ack/config', status: '<b>', final: true }];
    const parts = normalizeRdfNodeSnapshot(changed, READ_AT).node;
    expect(parts.parts.doa).toMatchObject({ status: 'STALE', reasons: ['HEALTH_STALE'] });
    expect(parts.parts.capabilities!.status).toBe('INCONSISTENT');
    expect(parts.parts.settings!.reasons).toEqual(['PREVIOUS_CONFIG']);
    expect(parts.parts.health!.status).toBe('STALE');
    expect(parts.parts.angular_unverified!.reasons).toEqual(['SOURCE_STALE']);
    expect(parts.parts.angular_unverified!.fields).not.toHaveProperty('from');
    expect(parts.acks).toEqual([]);
    const empty = normalizeRdfNodeSnapshot({ topics: {} }, READ_AT);
    expect(Object.values(empty.node.parts).every((part) => part === null)).toBe(true);
    expect(empty.node.acks).toEqual([]);
  });

  it('shows direction values only for LIVE or UNVERIFIED messages', () => {
    const changed = apiSnapshot();
    changed.topics['telemetry/doa'] = { ...changed.topics['telemetry/doa'], status: 'INCONSISTENT', error: 'REVISION_MISMATCH' };
    const rows = rdfTopicRows(normalizeRdfNodeSnapshot(changed, READ_AT), READ_AT);
    const doa = rows.find((row) => row.suffix === 'telemetry/doa')!;
    expect(doa).toMatchObject({ status: 'INCONSISTENT', error: 'REVISION_MISMATCH', summary: [], withheld: true });
    const angular = rows.find((row) => row.suffix === 'telemetry/angular')!;
    expect(angular.summary).toEqual([['flags', '63'], ['raw_doa_deg', '200'], ['frequency_hz', '433920000'], ['revision', '1']]);
    const health = rows.find((row) => row.suffix === 'telemetry/health')!;
    expect(health.summary).toContainEqual(['temp', '52.3']);
  });

  it('shows a node part direction only while it is LIVE or UNVERIFIED', () => {
    const live = rdfNodeRows(snapshot, READ_AT);
    expect(live.find((row) => row.part === 'doa')).toMatchObject({ status: 'LIVE', withheld: false });
    expect(live.find((row) => row.part === 'doa')!.summary).toContainEqual(['a', '160']);
    expect(live.find((row) => row.part === 'angular')!.summary).toContainEqual(['peak_index', '200']);
    expect(live.find((row) => row.part === 'angular_unverified')!.summary).toContainEqual(['raw_doa_deg', '200']);
    const changed = apiSnapshot();
    changed.node.doa.live = false;
    changed.node.doa.reasons = ['SOURCE_STALE'];
    changed.node.doa_unverified.stale = true;
    const rows = rdfNodeRows(normalizeRdfNodeSnapshot(changed, READ_AT), READ_AT);
    const doa = rows.find((row) => row.part === 'doa')!;
    expect(doa).toMatchObject({ status: 'STALE', reasons: ['SOURCE_STALE'], withheld: true });
    expect(doa.summary.map(([field]) => field)).not.toContain('a');
    expect(doa.summary).toContainEqual(['f', '433920000']);
    const raw = rows.find((row) => row.part === 'doa_unverified')!;
    expect(raw).toMatchObject({ status: 'STALE', withheld: true });
    expect(raw.summary.map(([field]) => field)).not.toContain('a');
    // A read that is no longer renewed holds nothing back as LIVE or UNVERIFIED either.
    for (const row of rdfNodeRows(snapshot, READ_AT + RDF_LOCAL_HOLD_MS + 1)) {
      const fields = row.summary.map(([field]) => field);
      if (['doa', 'doa_unverified', 'diagnostic_doa', 'angular', 'angular_unverified'].includes(row.part)) {
        expect(row).toMatchObject({ status: 'STALE', withheld: true });
        expect(fields.filter((field) => ['a', 'raw_doa_deg', 'peak_index'].includes(field))).toEqual([]);
      } else {
        expect(row.withheld).toBe(false);
      }
    }
  });

  it('keeps the edge ACK errors longer than 32 characters', () => {
    const changed = apiSnapshot();
    changed.node.acks = [
      { topic: 'ack/config', status: 'FAILED', final: true, result: { error: 'CENTER_CHANGE_REQUIRES_VFO0_TARGET' } },
      { topic: 'ack/operation', status: 'REJECTED', final: true, result: { error: 'DIAGNOSTIC_ANGULAR_SEQUENCE_EXHAUSTED_RESTART_AGENT' } },
      { topic: 'ack/operation', status: 'FAILED', final: true, result: { error: 'X'.repeat(65) } },
      { topic: 'ack/operation', status: 'FAILED', final: true, result: { error: 'not a code' } },
    ];
    expect(normalizeRdfNodeSnapshot(changed, READ_AT).node.acks.map((ack) => ack.error))
      .toEqual(['CENTER_CHANGE_REQUIRES_VFO0_TARGET', 'DIAGNOSTIC_ANGULAR_SEQUENCE_EXHAUSTED_RESTART_AGENT', null, null]);
  });

  it('names the field of an INVALID message', () => {
    const changed = apiSnapshot();
    changed.topics.capabilities = { status: 'INVALID', received_at_ms: NOW, qos: 1, retained: true, error: 'INVALID_FIELD', field: 'maintenance', payload: null };
    changed.topics.state = { status: 'INVALID', error: 'INVALID_FIELD', field: 'Bad Field' };
    const rows = rdfTopicRows(normalizeRdfNodeSnapshot(changed, READ_AT), READ_AT);
    expect(rows.find((row) => row.suffix === 'capabilities')).toMatchObject({ status: 'INVALID', error: 'INVALID_FIELD', field: 'maintenance' });
    expect(rows.find((row) => row.suffix === 'state')!.field).toBeNull();
  });

  it('labels a retained clear as CLEARED instead of a missing value', () => {
    const changed = apiSnapshot();
    changed.topics.availability = { status: 'UNAVAILABLE', received_at_ms: body.now_ms - 800, qos: 1, retained: true, error: 'RETAINED_CLEARED', cleared: true, payload: null };
    changed.topics.state = { status: 'SOMETHING_NEW' };
    const rows = rdfTopicRows(normalizeRdfNodeSnapshot(changed, READ_AT), READ_AT);
    expect(rows.find((row) => row.suffix === 'availability')).toMatchObject({ status: 'CLEARED', error: 'RETAINED_CLEARED' });
    expect(rows.find((row) => row.suffix === 'state')!.status).toBe('UNAVAILABLE');
  });

  it('stops trusting LIVE, UNVERIFIED and FRESH when the reads stop', () => {
    const later = READ_AT + RDF_LOCAL_HOLD_MS + 1;
    const rows = rdfTopicRows(snapshot, later);
    expect(rows.find((row) => row.suffix === 'telemetry/angular')).toMatchObject({ status: 'STALE', summary: [], withheld: true });
    expect(rows.find((row) => row.suffix === 'telemetry/doa')!.status).toBe('STALE');
    expect(rows.find((row) => row.suffix === 'telemetry/health')!.status).toBe('STALE');
    expect(rows.find((row) => row.suffix === 'state')!.status).toBe('CONTEXT');
    expect(rows.find((row) => row.suffix === 'telemetry/health')!.ageMs).toBe(400 + RDF_LOCAL_HOLD_MS + 1);
    const nodeRows = rdfNodeRows(snapshot, later);
    expect(nodeRows.find((row) => row.part === 'angular')!.status).toBe('STALE');
    expect(nodeRows.find((row) => row.part === 'session')!.status).toBe('CONTEXT');
  });

  it('lists only the node parts the server holds, in display order', () => {
    const rows = rdfNodeRows(snapshot, READ_AT);
    expect(rows.map((row) => row.part)).toEqual(['session', 'health', 'detail', 'doa', 'doa_unverified', 'diagnostic_doa', 'angular', 'angular_unverified', 'capabilities', 'availability', 'settings']);
    expect(rows.find((row) => row.part === 'doa_unverified')!.summary).toContainEqual(['a', '200']);
    expect(rdfNodeRows(null, READ_AT)).toEqual([]);
    const acks = rdfAckRows(snapshot, READ_AT + 1_000);
    expect(acks[0].ageMs).toBe(1_400);
  });

  it('gives statuses and ACK outcomes their tones', () => {
    expect(['LIVE', 'FRESH', 'UNVERIFIED', 'STALE', 'INCONSISTENT', 'INVALID', 'IGNORED', 'CONTEXT'].map(rdfStatusTone))
      .toEqual(['good', 'good', 'warn', 'bad', 'bad', 'bad', 'neutral', 'neutral']);
    expect(['APPLIED', 'REJECTED', 'PERSISTED_UNVERIFIED', 'OUTCOME_UNKNOWN', 'ACCEPTED', 'PPP_RESTART_REQUESTED'].map(rdfAckTone))
      .toEqual(['good', 'bad', 'warn', 'warn', 'neutral', 'neutral']);
  });
});
