import { describe, expect, it } from 'vitest';
import type {
  RdfNodeMqttObservation,
  RdfNodeMqttSnapshot,
  RdfNodeMqttTopic,
  RdfNodeMqttTopicStatus,
} from '../types';
import { RDF_NODE_MQTT_TOPICS } from '../types';
import { systemHealthMqttReadings } from './systemHealthMqtt';

const NOW = 1_750_000_000_000;

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
  payload: Record<string, unknown>,
  options: {
    status?: RdfNodeMqttTopicStatus;
    receivedAtMs?: number | null;
    retained?: boolean | null;
  } = {},
): void {
  snapshot.topics[topic] = {
    status: options.status ?? 'FRESH',
    received_at_ms: options.receivedAtMs ?? NOW,
    qos: 0,
    retained: options.retained ?? false,
    payload,
    candidate_payload: null,
    error: null,
  };
}

function healthySnapshot(): RdfNodeMqttSnapshot {
  const snapshot = createSnapshot();
  observe(snapshot, 'telemetry/health', {
    sid: '7a8b9c0d', q: 86, t: NOW, daq: 1, drop: 12, clk: 1, rev: 7, run: 1, age: 250, temp: 41.5,
  });
  observe(snapshot, 'telemetry/health/detail', {
    sid: '7a8b9c0d', t: NOW, usb: 0, sync: [true, true, true],
    cpu: 37.5, mem: 45.2, disk_free: 62.1, throt: false, uv: false,
    tx: 12.5, rx: 25.2, adrop: 4, parse: 1,
  });
  observe(snapshot, 'telemetry/doa', {
    sid: '7a8b9c0d', q: 1245, t: NOW, rev: 7, ok: 1,
  });
  return snapshot;
}

function addDiagnosticDoa(
  snapshot: RdfNodeMqttSnapshot,
  overrides: Record<string, unknown> = {},
  status: RdfNodeMqttTopicStatus = 'FRESH',
  receivedAtMs = NOW - 500,
): void {
  observe(snapshot, 'telemetry/diagnostic/doa', {
    v: 2,
    sid: '7a8b9c0d',
    q: 1246,
    source: 'doa.xml',
    source_timestamp_ms: NOW - 1_000,
    observed_timestamp_ms: NOW - 900,
    raw_doa_deg: 43.5,
    frequency_mhz: 433.92,
    trust: 'UNVERIFIED',
    validation_reasons: ['DIAGNOSTIC_UNVERIFIED', 'SOURCE_PARSE_UNVERIFIED'],
    ...overrides,
  }, { status, receivedAtMs });
}

function addDiagnosticAngular(
  snapshot: RdfNodeMqttSnapshot,
  overrides: Record<string, unknown> = {},
  status: RdfNodeMqttTopicStatus = 'FRESH',
  receivedAtMs = NOW - 500,
): void {
  observe(snapshot, 'telemetry/diagnostic/angular', {
    encoding: 'q16',
    sid: 0x7a8b9c0d,
    q: 1246,
    source_timestamp_ms: NOW - 1_000,
    frequency_hz: 433_920_000,
    revision: 4,
    vfo: 0,
    convention: 1,
    raw_doa_deg: 43.5,
    confidence_native_db: 5.2,
    flags: 3,
    trust: 'UNVERIFIED',
    validation_reasons: ['DIAGNOSTIC_UNVERIFIED'],
    values: Array.from({ length: 360 }, (_, index) => index),
    ...overrides,
  }, { status, receivedAtMs });
}

function withAges(
  snapshot: RdfNodeMqttSnapshot,
  topic: 'telemetry/health' | 'telemetry/health/detail' | 'telemetry/doa',
  receivedAgeMs: number,
  sourceAgeMs: number,
): void {
  const observation = snapshot.topics[topic];
  const payload = observation.payload as Record<string, unknown>;
  snapshot.topics[topic] = {
    ...observation,
    received_at_ms: NOW - receivedAgeMs,
    payload: { ...payload, t: NOW - sourceAgeMs },
  };
}

describe('System Health MQTT readings', () => {
  it('maps fresh health to current readings without conflating DAQ health', () => {
    const readings = systemHealthMqttReadings(healthySnapshot(), NOW);

    expect(readings.healthStream).toMatchObject({ value: 'CURRENT', tone: 'good' });
    expect(readings.daq).toMatchObject({ value: 'HEALTHY', tone: 'good' });
    expect(readings.droppedFrames).toMatchObject({ value: '12', tone: 'neutral' });
    expect(readings.edgeClock).toMatchObject({ value: 'SYNCED', tone: 'good' });
    expect(readings.sync).toMatchObject({ value: '3 / 3', tone: 'good' });
    expect(readings.doa).toMatchObject({ value: 'CURRENT', tone: 'good' });
  });

  it('maps fresh daq zero to degraded', () => {
    const snapshot = healthySnapshot();
    observe(snapshot, 'telemetry/health', {
      sid: '7a8b9c0d', q: 86, t: NOW, daq: 0, drop: 12, clk: 1, rev: 7,
    });

    expect(systemHealthMqttReadings(snapshot, NOW).daq).toMatchObject({ value: 'DEGRADED', tone: 'warn' });
  });

  it('maps fresh daq two to unknown', () => {
    const snapshot = healthySnapshot();
    observe(snapshot, 'telemetry/health', {
      sid: '7a8b9c0d', q: 86, t: NOW, daq: 2, drop: 12, clk: 1, rev: 7,
    });

    expect(systemHealthMqttReadings(snapshot, NOW).daq).toMatchObject({ value: 'UNKNOWN', tone: 'neutral' });
  });

  it('preserves an unreported dropped-frame count', () => {
    const snapshot = healthySnapshot();
    observe(snapshot, 'telemetry/health', {
      sid: '7a8b9c0d', q: 86, t: NOW, daq: 1, drop: null, clk: 1, rev: 7,
    });

    expect(systemHealthMqttReadings(snapshot, NOW).droppedFrames.value).toBe('NOT REPORTED');
  });

  it('marks an untrusted edge clock as a warning', () => {
    const snapshot = healthySnapshot();
    observe(snapshot, 'telemetry/health', {
      sid: '7a8b9c0d', q: 86, t: NOW, daq: 1, drop: 12, clk: 0, rev: 7,
    });

    expect(systemHealthMqttReadings(snapshot, NOW).edgeClock).toMatchObject({ value: 'UNTRUSTED', tone: 'warn' });
  });

  it('counts false and unknown sync flags separately', () => {
    const snapshot = healthySnapshot();
    observe(snapshot, 'telemetry/health/detail', {
      sid: '7a8b9c0d', t: NOW, sync: [true, false, null],
    });

    const sync = systemHealthMqttReadings(snapshot, NOW).sync;
    expect(sync).toMatchObject({ value: '1 / 3', tone: 'warn' });
    expect(sync.detail).toContain('1 true');
    expect(sync.detail).toContain('1 false');
    expect(sync.detail).toContain('1 unknown');
  });

  it.each([
    ['STALE', 'STALE', 'warn'],
    ['CONTEXT', 'CONTEXT ONLY', 'neutral'],
    ['UNAVAILABLE', 'UNAVAILABLE', 'neutral'],
    ['INVALID', 'INVALID', 'bad'],
    ['INCONSISTENT', 'INCONSISTENT', 'bad'],
  ] as const)('keeps %s health-topic state explicit', (status, value, tone) => {
    const snapshot = healthySnapshot();
    observe(snapshot, 'telemetry/health', {
      sid: '7a8b9c0d', q: 86, t: NOW, daq: 1, drop: 12, clk: 1, rev: 7,
    }, { status });

    expect(systemHealthMqttReadings(snapshot, NOW).healthStream).toMatchObject({ value, tone });
  });

  it('does not use a retained observation as current telemetry', () => {
    const snapshot = healthySnapshot();
    const health = snapshot.topics['telemetry/health'];
    snapshot.topics['telemetry/health'] = { ...health, retained: true };

    expect(systemHealthMqttReadings(snapshot, NOW).healthStream.value).toBe('CONTEXT ONLY');
  });

  it('does not use cached observations when MQTT is disabled or disconnected', () => {
    const disabled = healthySnapshot();
    disabled.enabled = false;
    disabled.connection = 'disabled';
    const disconnected = healthySnapshot();
    disconnected.connection = 'disconnected';

    expect(systemHealthMqttReadings(disabled, NOW).daq.value).toBe('UNAVAILABLE');
    expect(systemHealthMqttReadings(disconnected, NOW).daq.value).toBe('UNAVAILABLE');
  });

  it('requires the canonical DoA topic and correlated healthy session', () => {
    const snapshot = healthySnapshot();
    expect(systemHealthMqttReadings(snapshot, NOW).doa.value).toBe('CURRENT');

    const mismatched = healthySnapshot();
    observe(mismatched, 'telemetry/health', {
      sid: 'different', q: 86, t: NOW, daq: 1, drop: 12, clk: 1, rev: 7,
    });
    expect(systemHealthMqttReadings(mismatched, NOW).doa.value).toBe('INCONSISTENT');

    const absent = healthySnapshot();
    absent.topics['telemetry/doa'] = emptyObservation();
    expect(systemHealthMqttReadings(absent, NOW).doa.value).toBe('UNAVAILABLE');
  });

  it.each([
    ['telemetry/health', 'receive', 8_000, 'CURRENT'],
    ['telemetry/health', 'receive', 8_001, 'STALE'],
    ['telemetry/health', 'source', 8_000, 'CURRENT'],
    ['telemetry/health', 'source', 8_001, 'STALE'],
    ['telemetry/doa', 'receive', 5_000, 'CURRENT'],
    ['telemetry/doa', 'receive', 5_001, 'STALE'],
    ['telemetry/doa', 'source', 5_000, 'CURRENT'],
    ['telemetry/doa', 'source', 5_001, 'STALE'],
    ['telemetry/health/detail', 'receive', 15_000, '3 / 3'],
    ['telemetry/health/detail', 'receive', 15_001, 'STALE'],
    ['telemetry/health/detail', 'source', 15_000, '3 / 3'],
    ['telemetry/health/detail', 'source', 15_001, 'STALE'],
  ] as const)('uses the %s %s-time age boundary at %s ms', (topic, timestamp, age, expected) => {
    const snapshot = healthySnapshot();
    withAges(snapshot, topic, timestamp === 'receive' ? age : 0, timestamp === 'source' ? age : 0);
    const readings = systemHealthMqttReadings(snapshot, NOW);
    const value = topic === 'telemetry/health'
      ? readings.healthStream.value
      : topic === 'telemetry/doa' ? readings.doa.value : readings.sync.value;

    expect(value).toBe(expected);
  });

  it('marks contract gaps not provided and never uses MQTT q as a frame index', () => {
    const readings = systemHealthMqttReadings(healthySnapshot(), NOW);

    for (const field of ['gps', 'csv', 'xml', 'frameIndex'] as const) {
      expect(readings[field].value).toBe('NOT PROVIDED');
    }
    expect(readings.frameIndex.value).not.toBe('86');
    expect(readings.frameIndex.detail).not.toContain('86');
  });
  it.each([
    [0, 'STOPPED', 'warn'],
    [1, 'RUNNING', 'good'],
    [2, 'STARTING', 'warn'],
    [3, 'STOPPING', 'warn'],
    [4, 'ERROR', 'bad'],
    [255, 'UNKNOWN', 'neutral'],
  ] as const)('maps Edge run code %s to %s', (run, value, tone) => {
    const snapshot = healthySnapshot();
    const health = snapshot.topics['telemetry/health'];
    snapshot.topics['telemetry/health'] = {
      ...health,
      payload: { ...(health.payload as Record<string, unknown>), run },
    };

    expect(systemHealthMqttReadings(snapshot, NOW).edgeHealth.run).toMatchObject({ value, tone });
  });

  it('maps Edge source age and temperature with units and preserves absent reports', () => {
    const snapshot = healthySnapshot();
    const readings = systemHealthMqttReadings(snapshot, NOW);
    expect(readings.edgeHealth.sourceAge.value).toBe('250 ms');
    expect(readings.edgeHealth.temperature.value).toBe('41.5 °C');

    const health = snapshot.topics['telemetry/health'];
    const payload = { ...(health.payload as Record<string, unknown>), run: null, age: null, temp: null };
    snapshot.topics['telemetry/health'] = { ...health, payload };

    const unreported = systemHealthMqttReadings(snapshot, NOW).edgeHealth;
    expect(unreported.run.value).toBe('NOT REPORTED');
    expect(unreported.sourceAge.value).toBe('NOT REPORTED');
    expect(unreported.temperature.value).toBe('NOT REPORTED');
  });

  it('maps every Edge health-detail field with its source unit and exact sync order', () => {
    const snapshot = healthySnapshot();
    const observation = snapshot.topics['telemetry/health/detail'];
    snapshot.topics['telemetry/health/detail'] = {
      ...observation,
      payload: { ...(observation.payload as Record<string, unknown>), sync: [false, true, null] },
    };
    const detail = systemHealthMqttReadings(snapshot, NOW).edgeHealthDetail;

    expect(detail.usb.value).toBe('0');
    expect(detail.sync.frame.value).toBe('FALSE');
    expect(detail.sync.sampleDelay.value).toBe('TRUE');
    expect(detail.sync.iq.value).toBe('NOT REPORTED');
    expect(detail.cpu.value).toBe('37.5 %');
    expect(detail.memory.value).toBe('45.2 %');
    expect(detail.freeDisk.value).toBe('62.1 %');
    expect(detail.throttled.value).toBe('FALSE');
    expect(detail.underVoltage.value).toBe('FALSE');
    expect(detail.tx.value).toBe('12.5 kbit/s');
    expect(detail.rx.value).toBe('25.2 kbit/s');
    expect(detail.acquisitionDrops.value).toBe('4');
    expect(detail.parseErrors.value).toBe('1');
  });


  it('does not turn false booleans or unknown sync into a clear/zero result', () => {
    const snapshot = healthySnapshot();
    const detail = snapshot.topics['telemetry/health/detail'];
    snapshot.topics['telemetry/health/detail'] = {
      ...detail,
      payload: {
        sid: '7a8b9c0d',
        t: NOW,
        sync: [null, null, null],
        throt: false,
        uv: null,
      },
    };

    const readings = systemHealthMqttReadings(snapshot, NOW);
    expect(readings.sync.value).toBe('NOT REPORTED');
    expect(readings.edgeHealthDetail.sync.frame.value).toBe('NOT REPORTED');
    expect(readings.edgeHealthDetail.sync.sampleDelay.value).toBe('NOT REPORTED');
    expect(readings.edgeHealthDetail.sync.iq.value).toBe('NOT REPORTED');
    expect(readings.edgeHealthDetail.throttled.value).toBe('FALSE');
    expect(readings.edgeHealthDetail.underVoltage.value).toBe('NOT REPORTED');
    expect(readings.edgeHealthDetail.cpu.value).toBe('NOT REPORTED');
    expect(readings.edgeHealthDetail.memory.value).toBe('NOT REPORTED');
    expect(readings.edgeHealthDetail.acquisitionDrops.value).toBe('NOT REPORTED');
  });

  it('lets stale or invalid Edge detail status override cached field values', () => {
    for (const status of ['STALE', 'INVALID'] as const) {
      const snapshot = healthySnapshot();
      observe(snapshot, 'telemetry/health/detail', {
        sid: '7a8b9c0d', t: NOW, sync: [true, true, true], cpu: 99, throt: false,
      }, { status });

      const detail = systemHealthMqttReadings(snapshot, NOW).edgeHealthDetail;
      expect(detail.cpu.value).toBe(status);
      expect(detail.throttled.value).toBe(status);
      expect(detail.sync.frame.value).toBe(status);
    }
  });

  it.each([
    ['receive', 15_000, '37.5 %'],
    ['receive', 15_001, 'STALE'],
    ['source', 15_000, '37.5 %'],
    ['source', 15_001, 'STALE'],
  ] as const)('applies the 15,000 ms Edge detail %s-age boundary', (timestamp, age, expected) => {
    const snapshot = healthySnapshot();
    withAges(snapshot, 'telemetry/health/detail', timestamp === 'receive' ? age : 0, timestamp === 'source' ? age : 0);

    expect(systemHealthMqttReadings(snapshot, NOW).edgeHealthDetail.cpu.value).toBe(expected);
  });

  it('keeps diagnostic trust, freshness, ages, and reasons outside live DoA readings', () => {
    const snapshot = createSnapshot();
    addDiagnosticDoa(snapshot);
    addDiagnosticAngular(snapshot);

    const readings = systemHealthMqttReadings(snapshot, NOW);

    expect(readings.diagnosticDoa.freshness.value).toBe('FRESH');
    expect(readings.diagnosticDoa.trust).toBe('UNVERIFIED');
    expect(readings.diagnosticDoa.receiveAge).toBe('<1 s');
    expect(readings.diagnosticDoa.sourceAge).toBe('1 s');
    expect(readings.diagnosticDoa.rawDoa).toBe('43.5°');
    expect(readings.diagnosticDoa.frequency).toBe('433.92 MHz');
    expect(readings.diagnosticDoa.reasons).toContain('SOURCE_PARSE_UNVERIFIED');
    expect(readings.diagnosticAngular.freshness.value).toBe('FRESH');
    expect(readings.diagnosticAngular.trust).toBe('UNVERIFIED');
    expect(readings.diagnosticAngular.flags).toBe('3');
    expect(readings.diagnosticAngular.reasons).toEqual(['DIAGNOSTIC_UNVERIFIED']);
    expect(readings.doa.value).toBe('UNAVAILABLE');
    expect(readings.diagnosticAngular).not.toHaveProperty('values');
  });

  it('marks diagnostic candidates stale for missing clock evidence, stale age, or disconnected MQTT', () => {
    const missingClock = healthySnapshot();
    addDiagnosticAngular(missingClock, {
      flags: 1,
      validation_reasons: ['DIAGNOSTIC_UNVERIFIED', 'CLOCK_FRESHNESS_UNVERIFIED'],
    });
    expect(systemHealthMqttReadings(missingClock, NOW).diagnosticAngular.freshness.value).toBe('STALE');
    expect(systemHealthMqttReadings(missingClock, NOW).diagnosticAngular.reasons).toContain('CLOCK_FRESHNESS_UNVERIFIED');

    const stale = healthySnapshot();
    addDiagnosticDoa(stale, { source_timestamp_ms: NOW - 5_001 });
    expect(systemHealthMqttReadings(stale, NOW).diagnosticDoa.freshness.value).toBe('STALE');

    const disconnected = healthySnapshot();
    addDiagnosticAngular(disconnected);
    disconnected.connection = 'disconnected';
    expect(systemHealthMqttReadings(disconnected, NOW).diagnosticAngular.freshness.value).toBe('STALE');
  });

});
