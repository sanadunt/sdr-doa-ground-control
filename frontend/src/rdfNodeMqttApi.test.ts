import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDiagnosticAngularLatest, getRdfNodeMqtt } from './api';

const TOPICS = [
  'telemetry/doa',
  'telemetry/diagnostic/doa',
  'telemetry/diagnostic/angular',
  'telemetry/health',
  'telemetry/health/detail',
  'telemetry/angular',
  'state',
  'capabilities',
  'config/reported',
  'availability',
  'ack/config',
  'ack/operation',
] as const;

type SnapshotFixture = Record<string, unknown>;

function unavailableObservation(): Record<string, unknown> {
  return {
    status: 'UNAVAILABLE',
    received_at_ms: null,
    qos: null,
    retained: null,
    payload: null,
    error: null,
  };
}

function fixture(): SnapshotFixture {
  return {
    enabled: false,
    connection: 'disabled',
    node_id: 'uav-01',
    last_error: null,
    received: 0,
    valid: 0,
    invalid: 0,
    last_received_at_ms: null,
    topic_counts: Object.fromEntries(TOPICS.map((topic) => [topic, 0])),
    topics: Object.fromEntries(TOPICS.map((topic) => [topic, unavailableObservation()])),
  };
}

function topic(f: SnapshotFixture, name: string): Record<string, unknown> {
  return (f.topics as Record<string, Record<string, unknown>>)[name];
}

function diagnosticDoaPayload(): Record<string, unknown> {
  return {
    v: 2,
    sid: '1234abcd',
    q: 22,
    source: 'doa.xml',
    source_timestamp_ms: 1_800_000_000_000,
    observed_timestamp_ms: 1_800_000_000_000,
    raw_doa_deg: 42.5,
    frequency_mhz: 433.92,
    trust: 'UNVERIFIED',
    validation_reasons: ['DIAGNOSTIC_UNVERIFIED'],
  };
}

function diagnosticAngularPayload(): Record<string, unknown> {
  return {
    encoding: 'q16',
    sid: 305419896,
    q: 22,
    source_timestamp_ms: 1_800_000_000_000,
    frequency_hz: 433_920_000,
    revision: null,
    vfo: 0,
    convention: 0,
    raw_doa_deg: 42.5,
    confidence_native_db: 12.5,
    flags: 3,
    trust: 'UNVERIFIED',
    validation_reasons: ['DIAGNOSTIC_UNVERIFIED'],
    values: Array.from({ length: 360 }, (_, index) => index / 10),
  };
}

function markObservation(
  response: SnapshotFixture,
  name: string,
  payload: Record<string, unknown>,
): void {
  Object.assign(topic(response, name), {
    payload,
    status: 'FRESH',
    received_at_ms: 1_800_000_000_000,
    qos: 0,
    retained: false,
  });
}

function diagnosticAngularLatestFixture(): Record<string, unknown> {
  return {
    enabled: true,
    connection: 'ready',
    node_id: 'node_02',
    status: 'FRESH',
    stale: false,
    trust: 'UNVERIFIED',
    encoding: 'q16',
    source_timestamp_ms: 1_800_000_000_000,
    source_age_ms: 1_000,
    received_age_ms: 200,
    flags: 3,
    validation_reasons: ['DIAGNOSTIC_UNVERIFIED'],
    values: Array.from({ length: 360 }, (_, index) => index / 10),
    error: null,
  };
}

function installResponse(value: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => value,
  } as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('getRdfNodeMqtt', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('normalizes the disabled snapshot with all twelve fixed topic entries', async () => {
    const fetchMock = installResponse(fixture());
    const controller = new AbortController();

    const result = await getRdfNodeMqtt(controller.signal);

    expect(result.connection).toBe('disabled');
    expect(Object.keys(result.topics)).toEqual(TOPICS);
    expect(Object.keys(result.topic_counts)).toEqual(TOPICS);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/mqtt/rdf-node',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin', signal: expect.any(AbortSignal) }),
    );
  });

  it('normalizes validated diagnostic DoA fields', async () => {
    const response = fixture();
    const payload = diagnosticDoaPayload();
    markObservation(response, 'telemetry/diagnostic/doa', payload);
    installResponse(response);

    const result = await getRdfNodeMqtt();

    expect(result.topics['telemetry/diagnostic/doa'].payload).toEqual(payload);
  });
  it('keeps invalid candidate fields separate while the broker stays ready', async () => {
    const response = fixture();
    const receivedAtMs = 1_800_000_000_000;
    const candidatePayload = {
      v: 2,
      sid: '1234abcd',
      q: 4,
      t: receivedAtMs,
      f: 433_920_000,
      a: 'not-an-angle',
      c: 12,
      p: -6,
      rev: 7,
      ok: 1,
    };
    response.enabled = true;
    response.connection = 'ready';
    response.received = 1;
    response.invalid = 1;
    response.last_received_at_ms = receivedAtMs;
    (response.topic_counts as Record<string, number>)['telemetry/doa'] = 1;
    Object.assign(topic(response, 'telemetry/doa'), {
      status: 'INVALID',
      received_at_ms: receivedAtMs,
      qos: 0,
      retained: false,
      payload: null,
      candidate_payload: candidatePayload,
      error: 'INVALID_FIELD',
    });
    installResponse(response);

    const result = await getRdfNodeMqtt();

    expect(result.connection).toBe('ready');
    expect(result.topics['telemetry/doa']).toMatchObject({
      status: 'INVALID',
      payload: null,
      candidate_payload: candidatePayload,
      error: 'INVALID_FIELD',
      received_at_ms: receivedAtMs,
    });
  });


  it.each([
    ['wrong protocol version', (payload: Record<string, unknown>) => { payload.v = 1; }],
    ['malformed session ID', (payload: Record<string, unknown>) => { payload.sid = '123'; }],
    ['unsafe sequence', (payload: Record<string, unknown>) => { payload.q = Number.MAX_SAFE_INTEGER + 1; }],
    ['wrong diagnostic source', (payload: Record<string, unknown>) => { payload.source = 'other.xml'; }],
    ['zero source timestamp', (payload: Record<string, unknown>) => { payload.source_timestamp_ms = 0; }],
    ['unsafe observed timestamp', (payload: Record<string, unknown>) => { payload.observed_timestamp_ms = Number.MAX_SAFE_INTEGER + 1; }],
    ['malformed reason code', (payload: Record<string, unknown>) => { payload.validation_reasons = ['unverified']; }],
    ['too many reason codes', (payload: Record<string, unknown>) => { payload.validation_reasons = Array(33).fill('DIAGNOSTIC_UNVERIFIED'); }],
    ['unselected field', (payload: Record<string, unknown>) => { payload.password = 'must not reach state'; }],
    ['non-numeric DoA', (payload: Record<string, unknown>) => { payload.raw_doa_deg = true; }],
    ['verified trust claim', (payload: Record<string, unknown>) => { payload.trust = 'VERIFIED'; }],
    ['missing diagnostic reason', (payload: Record<string, unknown>) => { payload.validation_reasons = []; }],
  ])('rejects diagnostic DoA with %s', async (_label, mutate) => {
    const response = fixture();
    const payload = diagnosticDoaPayload();
    mutate(payload);
    markObservation(response, 'telemetry/diagnostic/doa', payload);
    installResponse(response);

    await expect(getRdfNodeMqtt()).rejects.toThrow(/RDF Node MQTT response has an invalid shape/u);
  });

  it('normalizes diagnostic Angular as a distinct unverified frame', async () => {
    const response = fixture();
    const payload = diagnosticAngularPayload();
    markObservation(response, 'telemetry/diagnostic/angular', payload);
    installResponse(response);

    const result = await getRdfNodeMqtt();

    expect(result.topics['telemetry/diagnostic/angular'].payload).toEqual(payload);
    expect(result.topics['telemetry/angular'].payload).toBeNull();
  });

  it.each([
    ['reserved flag bits', (payload: Record<string, unknown>) => { payload.flags = 32; }],
    ['unknown encoding', (payload: Record<string, unknown>) => { payload.encoding = 'q8'; }],
    ['zero source timestamp', (payload: Record<string, unknown>) => { payload.source_timestamp_ms = 0; }],
    ['frequency above the frame limit', (payload: Record<string, unknown>) => { payload.frequency_hz = 1_000_000_000_001; }],
    ['revision sentinel as data', (payload: Record<string, unknown>) => { payload.revision = 0xffff_ffff; }],
    ['out-of-range VFO metadata', (payload: Record<string, unknown>) => { payload.vfo = 256; }],
    ['verified trust claim', (payload: Record<string, unknown>) => { payload.trust = 'VERIFIED'; }],
    ['missing diagnostic reason', (payload: Record<string, unknown>) => { payload.validation_reasons = []; }],
    ['malformed reason code', (payload: Record<string, unknown>) => { payload.validation_reasons = ['unverified']; }],
    ['too many reasons', (payload: Record<string, unknown>) => { payload.validation_reasons = Array(33).fill('DIAGNOSTIC_UNVERIFIED'); }],
    ['a short angular vector', (payload: Record<string, unknown>) => { payload.values = Array(359).fill(0); }],
    ['a non-finite angular sample', (payload: Record<string, unknown>) => { payload.values = [...Array(359).fill(0), Number.NaN]; }],
  ])('rejects diagnostic Angular with %s', async (_label, mutate) => {
    const response = fixture();
    const payload = diagnosticAngularPayload();
    mutate(payload);
    markObservation(response, 'telemetry/diagnostic/angular', payload);
    installResponse(response);

    await expect(getRdfNodeMqtt()).rejects.toThrow(/RDF Node MQTT response has an invalid shape/u);
  });

  it('accepts a complete Angular frame only with 360 finite decoded values', async () => {
    const response = fixture();
    const frame = {
      encoding: 'q16',
      sid: 305419896,
      q: 21,
      timestamp_ms: 1_800_000_000_000,
      frequency_hz: 433_920_000,
      revision: 4,
      vfo: 0,
      convention: 0,
      raw_doa_deg: 42.5,
      confidence_native_db: 327.67,
      values: Array.from({ length: 360 }, (_, index) => index / 10),
    };
    topic(response, 'telemetry/angular').payload = frame;
    topic(response, 'telemetry/angular').status = 'FRESH';
    topic(response, 'telemetry/angular').received_at_ms = 1_800_000_000_000;
    topic(response, 'telemetry/angular').qos = 0;
    topic(response, 'telemetry/angular').retained = false;

    installResponse(response);
    const result = await getRdfNodeMqtt();

    expect(result.topics['telemetry/angular'].payload).toMatchObject({ encoding: 'q16', values: frame.values });
  });

  it('accepts payload arrays within the backend MQTT JSON-size bound', async () => {
    const response = fixture();
    const codecs = Array.from({ length: 4_800 }, () => '');
    topic(response, 'capabilities').payload = { codecs };
    topic(response, 'capabilities').status = 'CONTEXT';
    topic(response, 'capabilities').received_at_ms = 1_800_000_000_000;
    topic(response, 'capabilities').qos = 1;
    topic(response, 'capabilities').retained = true;

    installResponse(response);
    const result = await getRdfNodeMqtt();

    expect(result.topics.capabilities.payload).toMatchObject({ codecs });
  });

  it.each([
    ['a short frame', Array.from({ length: 359 }, () => 1)],
    ['a non-finite sample', [...Array.from({ length: 359 }, () => 1), Number.NaN]],
  ])('rejects Angular payloads containing %s', async (_label, values) => {
    const response = fixture();
    topic(response, 'telemetry/angular').payload = {
      encoding: 'q16',
      sid: 1,
      q: 1,
      timestamp_ms: 1,
      frequency_hz: 1,
      revision: null,
      vfo: 0,
      convention: 0,
      raw_doa_deg: null,
      confidence_native_db: null,
      values,
    };
    topic(response, 'telemetry/angular').status = 'FRESH';

    installResponse(response);
    await expect(getRdfNodeMqtt()).rejects.toThrow(/RDF Node MQTT response has an invalid shape/u);
  });

  it.each([
    ['unknown connection', (response: SnapshotFixture) => { response.connection = 'ONLINE'; }],
    ['unknown topic', (response: SnapshotFixture) => { (response.topics as Record<string, unknown>)['cmd/reboot'] = unavailableObservation(); }],
    ['missing topic', (response: SnapshotFixture) => { delete (response.topics as Record<string, unknown>)['state']; }],
    ['unknown topic status', (response: SnapshotFixture) => { topic(response, 'state').status = 'CURRENT'; }],
    ['negative received count', (response: SnapshotFixture) => { response.received = -1; }],
    ['non-finite valid count', (response: SnapshotFixture) => { response.valid = Number.POSITIVE_INFINITY; }],
    ['negative last timestamp', (response: SnapshotFixture) => { response.last_received_at_ms = -1; }],
    ['negative topic count', (response: SnapshotFixture) => { (response.topic_counts as Record<string, unknown>).state = -1; }],
    ['negative topic timestamp', (response: SnapshotFixture) => { topic(response, 'state').received_at_ms = -1; }],
    ['malformed object payload', (response: SnapshotFixture) => { topic(response, 'state').payload = 'not an object'; }],
    ['non-finite payload value', (response: SnapshotFixture) => { topic(response, 'state').payload = { revision: Number.NaN }; }],
  ] as Array<[string, (response: SnapshotFixture) => void]>)('rejects %s instead of returning unchecked response data', async (_label, mutate) => {
    const response = fixture();
    mutate(response);
    installResponse(response);

    await expect(getRdfNodeMqtt()).rejects.toThrow(/RDF Node MQTT response has an invalid shape/u);
  });
});

describe('getDiagnosticAngularLatest', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('validates the same-origin diagnostic latest response', async () => {
    const value = diagnosticAngularLatestFixture();
    const fetchMock = installResponse(value);
    const controller = new AbortController();

    const result = await getDiagnosticAngularLatest(controller.signal);

    expect(result).toEqual(value);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/angular/diagnostic/latest',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin', signal: expect.any(AbortSignal) }),
    );
  });

  it('distinguishes unavailable and invalid states without candidate metadata', async () => {
    const unavailable = {
      enabled: false,
      connection: 'disabled',
      node_id: 'uav-01',
      status: 'UNAVAILABLE',
      stale: false,
      trust: null,
      encoding: null,
      source_timestamp_ms: null,
      source_age_ms: null,
      received_age_ms: null,
      flags: null,
      validation_reasons: [],
      values: null,
      error: null,
    };
    installResponse(unavailable);
    await expect(getDiagnosticAngularLatest()).resolves.toMatchObject({
      status: 'UNAVAILABLE',
      values: null,
      trust: null,
    });

    installResponse({ ...unavailable, status: 'INVALID', error: 'INVALID_PAYLOAD' });
    await expect(getDiagnosticAngularLatest()).resolves.toMatchObject({
      status: 'INVALID',
      values: null,
      error: 'INVALID_PAYLOAD',
    });
  });

  it('retains stale decoded values when the source clock is in the future', async () => {
    const value = diagnosticAngularLatestFixture();
    value.status = 'STALE';
    value.stale = true;
    value.source_timestamp_ms = 1_800_000_000_010;
    value.source_age_ms = null;
    value.received_age_ms = null;
    value.error = 'DIAGNOSTIC_SOURCE_FUTURE';
    installResponse(value);

    const result = await getDiagnosticAngularLatest();

    expect(result.status).toBe('STALE');
    expect(result.source_age_ms).toBeNull();
    expect(result.received_age_ms).toBeNull();
    expect(result.values).toHaveLength(360);
  });

  it.each([
    ['unknown diagnostic status', (value: Record<string, unknown>) => { value.status = 'CURRENT'; }],
    ['node ID with multiple topic segments', (value: Record<string, unknown>) => { value.node_id = 'node.part'; }],
    ['reserved angular flags', (value: Record<string, unknown>) => { value.flags = 32; }],
    ['short angular values', (value: Record<string, unknown>) => { value.values = Array(359).fill(0); }],
    ['missing unverified reason', (value: Record<string, unknown>) => { value.validation_reasons = []; }],
    ['fresh clock flag absent', (value: Record<string, unknown>) => { value.flags = 1; }],
    ['fresh source age over threshold', (value: Record<string, unknown>) => { value.source_age_ms = 10_001; }],
    ['stale candidate without sanitized error', (value: Record<string, unknown>) => { value.status = 'STALE'; value.stale = true; value.error = null; }],
    ['fresh state marked stale', (value: Record<string, unknown>) => { value.stale = true; }],
  ])('rejects %s', async (_label, mutate) => {
    const value = diagnosticAngularLatestFixture();
    mutate(value);
    installResponse(value);

    await expect(getDiagnosticAngularLatest())
      .rejects.toThrow(/diagnostic Angular response has an invalid shape/u);
  });
});
