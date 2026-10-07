import { RDF_NODE_MQTT_TOPICS } from './types';
import type {
  Branding,
  ConsoleConfig,
  MqttSnapshot,
  RdfNodeMqttAngularFrame,
  RdfNodeMqttDiagnosticAngularFrame,
  RdfNodeMqttDiagnosticAngularLatest,
  RdfNodeMqttDiagnosticDoa,
  RdfNodeMqttConnection,
  RdfNodeMqttObservation,
  RdfNodeMqttSnapshot,
  RdfNodeMqttTopic,
  RdfNodeMqttTopicStatus,
  SystemHealthSnapshot,
  TelemetrySnapshot,
} from './types';

export const DEFAULT_API_TIMEOUT_MS = 10_000;

const DEFAULT_BRANDING: Branding = { app_name: 'SDR-DoA Ground Console', logo_data_url: '' };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function responseError(body: unknown, status: number): Error {
  const detail = isObject(body) && typeof body.error === 'string' && body.error.trim() ? body.error : `request failed (${status})`;
  return new Error(detail);
}

async function readJson<T>(response: Response, signal?: AbortSignal): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error: unknown) {
    // Invalid JSON is treated as an empty body for error reporting, but an
    // aborted body read must stay an aborted request rather than becoming a
    // false successful response.
    if (signal?.aborted || (error && typeof error === 'object' && 'name' in error && ['AbortError', 'TimeoutError'].includes(String((error as { name?: unknown }).name)))) {
      throw error;
    }
    body = undefined;
  }
  if (!response.ok) throw responseError(body, response.status);
  return body as T;
}

function timeoutReason(timeoutMs: number): Error {
  const error = new Error(`request timed out after ${timeoutMs} ms`);
  error.name = 'TimeoutError';
  return error;
}

/**
 * Fetch with both a caller cancellation signal and a finite deadline. The
 * timeout is applied in one place so every API wrapper has the same bound.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
): Promise<Response> {
  return runBounded(init.signal, (signal) => fetch(input, { ...init, signal }), timeoutMs);
}

async function boundedJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  return runBounded(signal, async (boundedSignal) => {
    const response = await fetch(input, { ...init, signal: boundedSignal });
    return readJson<T>(response, boundedSignal);
  });
}

async function runBounded<T>(
  callerSignal: AbortSignal | null | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
): Promise<T> {
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_API_TIMEOUT_MS;
  const controller = new AbortController();
  const onCallerAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort((callerSignal as AbortSignal & { reason?: unknown }).reason);
    }
  };
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timeoutId = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(timeoutReason(boundedTimeout));
  }, boundedTimeout);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeoutId);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  return boundedJson<T>(input, init, signal);
}

function normalizeAppName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_BRANDING.app_name;
  const name = value.trim();
  if (!name || name.length > 60 || /[\u0000-\u001f<>"']/u.test(name)) return DEFAULT_BRANDING.app_name;
  return name;
}

function normalizeLogoDataUrl(value: unknown): string {
  if (value === '') return '';
  if (typeof value !== 'string') return '';
  const match = /^data:(image\/png);base64,([A-Za-z0-9+/=\s]+)$/u.exec(value);
  if (!match) return '';
  const encoded = match[2].replace(/\s+/gu, '');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) return '';
  return `data:${match[1]};base64,${encoded}`;
}

/** Convert an untrusted branding response into a renderer-safe shape. */
export function normalizeBranding(value: unknown): Branding {
  const record = isObject(value) ? value : {};
  return {
    app_name: normalizeAppName(record.app_name),
    logo_data_url: normalizeLogoDataUrl(record.logo_data_url),
  };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isUsbTelemetryState(value: unknown): value is SystemHealthSnapshot['usb_telemetry'] {
  return value === 'PRESENT'
    || value === 'NOT_FOUND'
    || value === 'AMBIGUOUS'
    || value === 'UNKNOWN';
}

function isPppInterfaceState(value: unknown): value is SystemHealthSnapshot['ppp_interface'] {
  return value === 'UP' || value === 'DOWN' || value === 'UNKNOWN';
}

function isRaspberryPeerState(value: unknown): value is SystemHealthSnapshot['raspberry_peer'] {
  return value === 'REACHABLE'
    || value === 'NO_REPLY'
    || value === 'NOT_PROBED'
    || value === 'UNKNOWN';
}

function normalizeSystemHealthSnapshot(value: unknown): SystemHealthSnapshot {
  if (!isObject(value)
    || !finiteNumber(value.checked_at_ms)
    || !isUsbTelemetryState(value.usb_telemetry)
    || !isPppInterfaceState(value.ppp_interface)
    || !isRaspberryPeerState(value.raspberry_peer)) {
    throw new Error('System Health response has an invalid shape');
  }
  return {
    checked_at_ms: value.checked_at_ms,
    usb_telemetry: value.usb_telemetry,
    ppp_interface: value.ppp_interface,
    raspberry_peer: value.raspberry_peer,
  };
}

const RDF_NODE_MQTT_CONNECTIONS: readonly RdfNodeMqttConnection[] = [
  'disabled', 'connecting', 'ready', 'disconnected', 'error',
];
const RDF_NODE_MQTT_TOPIC_STATUSES: readonly RdfNodeMqttTopicStatus[] = [
  'UNAVAILABLE', 'CONTEXT', 'FRESH', 'STALE', 'INVALID', 'INCONSISTENT',
];
const RDF_NODE_MQTT_ERROR_CODE = /^[A-Z0-9_]{1,32}$/u;
const RDF_NODE_MQTT_NODE_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const RDF_NODE_MQTT_DIAGNOSTIC_REASON = /^[A-Z][A-Z0-9_]{0,63}$/u;

function invalidRdfNodeMqttResponse(): never {
  throw new Error('RDF Node MQTT response has an invalid shape');
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return isNonNegativeSafeInteger(value) && value >= minimum && value <= maximum;
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

type JsonNodeBudget = { nodes: number };

function copyRdfNodeJsonValue(value: unknown, depth: number, budget: JsonNodeBudget): unknown {
  budget.nodes += 1;
  if (budget.nodes > 8192 || depth > 8) return invalidRdfNodeMqttResponse();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 16_384) return invalidRdfNodeMqttResponse();
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalidRdfNodeMqttResponse();
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 8192) return invalidRdfNodeMqttResponse();
    return value.map((item) => copyRdfNodeJsonValue(item, depth + 1, budget));
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (entries.length > 128 || entries.some(([key]) => key.length > 128)) {
      return invalidRdfNodeMqttResponse();
    }
    const copy = Object.create(null) as JsonObject;
    for (const [key, child] of entries) {
      copy[key] = copyRdfNodeJsonValue(child, depth + 1, budget);
    }
    return copy;
  }
  return invalidRdfNodeMqttResponse();
}

function normalizeRdfNodeJsonPayload(value: unknown): JsonObject {
  if (!isObject(value)) return invalidRdfNodeMqttResponse();
  return copyRdfNodeJsonValue(value, 0, { nodes: 0 }) as JsonObject;
}

function normalizeRdfNodeAngularPayload(value: unknown): RdfNodeMqttAngularFrame {
  const keys = [
    'encoding', 'sid', 'q', 'timestamp_ms', 'frequency_hz', 'revision',
    'vfo', 'convention', 'raw_doa_deg', 'confidence_native_db', 'values',
  ];
  if (!isObject(value) || !hasExactKeys(value, keys)
    || (value.encoding !== 'q16' && value.encoding !== 'u8')
    || !isIntegerInRange(value.sid, 0, 0xffff_ffff)
    || !isIntegerInRange(value.q, 0, 0xffff_ffff)
    || !isIntegerInRange(value.timestamp_ms, 1, Number.MAX_SAFE_INTEGER)
    || !isIntegerInRange(value.frequency_hz, 0, 1_000_000_000_000)
    || !(value.revision === null || isIntegerInRange(value.revision, 0, 0xffff_fffe))
    || !isIntegerInRange(value.vfo, 0, 255)
    || !isIntegerInRange(value.convention, 0, 255)
    || !(value.raw_doa_deg === null
      || (typeof value.raw_doa_deg === 'number' && Number.isFinite(value.raw_doa_deg) && value.raw_doa_deg >= 0 && value.raw_doa_deg <= 655.34))
    || !(value.confidence_native_db === null
      || (typeof value.confidence_native_db === 'number' && Number.isFinite(value.confidence_native_db) && value.confidence_native_db >= -327.67 && value.confidence_native_db <= 327.67))
    || !Array.isArray(value.values)
    || value.values.length !== 360
    || !value.values.every((sample) => typeof sample === 'number' && Number.isFinite(sample))) {
    return invalidRdfNodeMqttResponse();
  }
  return {
    encoding: value.encoding,
    sid: value.sid,
    q: value.q,
    timestamp_ms: value.timestamp_ms,
    frequency_hz: value.frequency_hz,
    revision: value.revision,
    vfo: value.vfo,
    convention: value.convention,
    raw_doa_deg: value.raw_doa_deg,
    confidence_native_db: value.confidence_native_db,
    values: value.values.slice(),
  };
}

function isDiagnosticFiniteNumber(value: unknown): value is number {
  return finiteNumber(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function isDiagnosticReasonList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 32
    && value.every((reason) => typeof reason === 'string' && RDF_NODE_MQTT_DIAGNOSTIC_REASON.test(reason))
    && value.includes('DIAGNOSTIC_UNVERIFIED');
}

function normalizeRdfNodeMqttDiagnosticDoaPayload(value: unknown): RdfNodeMqttDiagnosticDoa {
  const keys = [
    'v', 'sid', 'q', 'source', 'source_timestamp_ms', 'observed_timestamp_ms',
    'raw_doa_deg', 'frequency_mhz', 'trust', 'validation_reasons',
  ];
  if (!isObject(value) || !hasExactKeys(value, keys)
    || value.v !== 2
    || typeof value.sid !== 'string'
    || !/^[0-9a-fA-F]{8}$/u.test(value.sid)
    || !isIntegerInRange(value.q, 0, 0xffff_ffff)
    || value.source !== 'doa.xml'
    || !isIntegerInRange(value.source_timestamp_ms, 1, Number.MAX_SAFE_INTEGER)
    || !isIntegerInRange(value.observed_timestamp_ms, 1, Number.MAX_SAFE_INTEGER)
    || !isDiagnosticFiniteNumber(value.raw_doa_deg)
    || !isDiagnosticFiniteNumber(value.frequency_mhz)
    || value.trust !== 'UNVERIFIED'
    || !isDiagnosticReasonList(value.validation_reasons)) {
    return invalidRdfNodeMqttResponse();
  }
  return {
    v: 2,
    sid: value.sid,
    q: value.q,
    source: 'doa.xml',
    source_timestamp_ms: value.source_timestamp_ms,
    observed_timestamp_ms: value.observed_timestamp_ms,
    raw_doa_deg: value.raw_doa_deg,
    frequency_mhz: value.frequency_mhz,
    trust: 'UNVERIFIED',
    validation_reasons: value.validation_reasons.slice(),
  };
}

function normalizeRdfNodeMqttDiagnosticAngularPayload(value: unknown): RdfNodeMqttDiagnosticAngularFrame {
  const keys = [
    'encoding', 'sid', 'q', 'source_timestamp_ms', 'frequency_hz', 'revision',
    'vfo', 'convention', 'raw_doa_deg', 'confidence_native_db', 'flags',
    'trust', 'validation_reasons', 'values',
  ];
  if (!isObject(value) || !hasExactKeys(value, keys)
    || (value.encoding !== 'q16' && value.encoding !== 'u8')
    || !isIntegerInRange(value.sid, 0, 0xffff_ffff)
    || !isIntegerInRange(value.q, 0, 0xffff_ffff)
    || !isIntegerInRange(value.source_timestamp_ms, 1, Number.MAX_SAFE_INTEGER)
    || !isIntegerInRange(value.frequency_hz, 0, 1_000_000_000_000)
    || !(value.revision === null || isIntegerInRange(value.revision, 0, 0xffff_fffe))
    || !isIntegerInRange(value.vfo, 0, 255)
    || !isIntegerInRange(value.convention, 0, 255)
    || !(value.raw_doa_deg === null
      || (finiteNumber(value.raw_doa_deg) && value.raw_doa_deg >= 0 && value.raw_doa_deg <= 655.34))
    || !(value.confidence_native_db === null
      || (finiteNumber(value.confidence_native_db) && value.confidence_native_db >= -327.67 && value.confidence_native_db <= 327.67))
    || !isIntegerInRange(value.flags, 0, 0x1f)
    || value.trust !== 'UNVERIFIED'
    || !isDiagnosticReasonList(value.validation_reasons)
    || !Array.isArray(value.values)
    || value.values.length !== 360
    || !value.values.every(isDiagnosticFiniteNumber)) {
    return invalidRdfNodeMqttResponse();
  }
  return {
    encoding: value.encoding,
    sid: value.sid,
    q: value.q,
    source_timestamp_ms: value.source_timestamp_ms,
    frequency_hz: value.frequency_hz,
    revision: value.revision,
    vfo: value.vfo,
    convention: value.convention,
    raw_doa_deg: value.raw_doa_deg,
    confidence_native_db: value.confidence_native_db,
    flags: value.flags,
    trust: 'UNVERIFIED',
    validation_reasons: value.validation_reasons.slice(),
    values: value.values.slice(),
  };
}

function isRdfNodeMqttTopicStatus(value: unknown): value is RdfNodeMqttTopicStatus {
  return typeof value === 'string'
    && RDF_NODE_MQTT_TOPIC_STATUSES.includes(value as RdfNodeMqttTopicStatus);
}

function normalizeRdfNodeMqttObservation(topic: RdfNodeMqttTopic, value: unknown): RdfNodeMqttObservation {
  const requiredKeys = ['status', 'received_at_ms', 'qos', 'retained', 'payload', 'error'];
  const hasCandidateKey = isObject(value) && Object.prototype.hasOwnProperty.call(value, 'candidate_payload');
  if (!isObject(value)
    || !(hasExactKeys(value, requiredKeys)
      || hasExactKeys(value, [...requiredKeys, 'candidate_payload']))
    || !isRdfNodeMqttTopicStatus(value.status)
    || !(value.received_at_ms === null || isNonNegativeSafeInteger(value.received_at_ms))
    || !(value.qos === null || value.qos === 0 || value.qos === 1)
    || !(value.retained === null || typeof value.retained === 'boolean')
    || !(value.error === null || (typeof value.error === 'string' && RDF_NODE_MQTT_ERROR_CODE.test(value.error)))) {
    return invalidRdfNodeMqttResponse();
  }
  const candidatePayload = value.candidate_payload === null || value.candidate_payload === undefined
    ? null
    : normalizeRdfNodeJsonPayload(value.candidate_payload);
  let payload: RdfNodeMqttObservation['payload'];
  if (value.payload === null) {
    payload = null;
  } else if (topic === 'telemetry/angular') {
    payload = normalizeRdfNodeAngularPayload(value.payload);
  } else if (topic === 'telemetry/diagnostic/doa') {
    payload = normalizeRdfNodeMqttDiagnosticDoaPayload(value.payload);
  } else if (topic === 'telemetry/diagnostic/angular') {
    payload = normalizeRdfNodeMqttDiagnosticAngularPayload(value.payload);
  } else {
    payload = normalizeRdfNodeJsonPayload(value.payload);
  }
  if (value.status === 'UNAVAILABLE') {
    if (value.received_at_ms !== null || value.qos !== null || value.retained !== null || payload !== null
      || candidatePayload !== null || value.error !== null) {
      return invalidRdfNodeMqttResponse();
    }
  } else if (value.received_at_ms === null || value.qos === null || value.retained === null) {
    return invalidRdfNodeMqttResponse();
  }
  if (value.status === 'INVALID' && (value.error === null || payload !== null)) return invalidRdfNodeMqttResponse();
  if (value.status !== 'INVALID' && candidatePayload !== null) return invalidRdfNodeMqttResponse();
  if (['CONTEXT', 'FRESH', 'STALE', 'INCONSISTENT'].includes(value.status) && payload === null) {
    return invalidRdfNodeMqttResponse();
  }
  return {
    status: value.status,
    received_at_ms: value.received_at_ms,
    qos: value.qos,
    retained: value.retained,
    payload,
    candidate_payload: hasCandidateKey ? candidatePayload : null,
    error: value.error,
  };
}

/** Normalize the untrusted read-only RDF Node MQTT endpoint response. */
export function normalizeRdfNodeMqttSnapshot(value: unknown): RdfNodeMqttSnapshot {
  const expectedKeys = [
    'enabled', 'connection', 'node_id', 'last_error', 'received', 'valid',
    'invalid', 'last_received_at_ms', 'topic_counts', 'topics',
  ];
  if (!isObject(value) || !hasExactKeys(value, expectedKeys)
    || typeof value.enabled !== 'boolean'
    || typeof value.connection !== 'string'
    || !RDF_NODE_MQTT_CONNECTIONS.includes(value.connection as RdfNodeMqttConnection)
    || typeof value.node_id !== 'string'
    || !RDF_NODE_MQTT_NODE_ID.test(value.node_id)
    || !(value.last_error === null
      || (typeof value.last_error === 'string' && RDF_NODE_MQTT_ERROR_CODE.test(value.last_error)))
    || !isNonNegativeSafeInteger(value.received)
    || !isNonNegativeSafeInteger(value.valid)
    || !isNonNegativeSafeInteger(value.invalid)
    || !(value.last_received_at_ms === null || isNonNegativeSafeInteger(value.last_received_at_ms))
    || !isObject(value.topic_counts)
    || !hasExactKeys(value.topic_counts, RDF_NODE_MQTT_TOPICS)
    || !isObject(value.topics)
    || !hasExactKeys(value.topics, RDF_NODE_MQTT_TOPICS)) {
    return invalidRdfNodeMqttResponse();
  }
  const topicCounts = {} as Record<RdfNodeMqttTopic, number>;
  const topics = {} as Record<RdfNodeMqttTopic, RdfNodeMqttObservation>;
  for (const topicName of RDF_NODE_MQTT_TOPICS) {
    const count = value.topic_counts[topicName];
    if (!isNonNegativeSafeInteger(count)) return invalidRdfNodeMqttResponse();
    topicCounts[topicName] = count;
    topics[topicName] = normalizeRdfNodeMqttObservation(topicName, value.topics[topicName]);
  }
  return {
    enabled: value.enabled,
    connection: value.connection as RdfNodeMqttConnection,
    node_id: value.node_id,
    last_error: value.last_error,
    received: value.received,
    valid: value.valid,
    invalid: value.invalid,
    last_received_at_ms: value.last_received_at_ms,
    topic_counts: topicCounts,
    topics,
  };
}

const RDF_NODE_MQTT_DIAGNOSTIC_LATEST_KEYS = [
  'enabled', 'connection', 'node_id', 'status', 'stale', 'trust', 'encoding',
  'source_timestamp_ms', 'source_age_ms', 'received_age_ms', 'flags',
  'validation_reasons', 'values', 'error',
];

function invalidDiagnosticAngularLatestResponse(): never {
  throw new Error('diagnostic Angular response has an invalid shape');
}

/** Normalize the display-only diagnostic endpoint without making it live telemetry. */
export function normalizeDiagnosticAngularLatest(value: unknown): RdfNodeMqttDiagnosticAngularLatest {
  if (!isObject(value) || !hasExactKeys(value, RDF_NODE_MQTT_DIAGNOSTIC_LATEST_KEYS)
    || typeof value.enabled !== 'boolean'
    || typeof value.connection !== 'string'
    || !RDF_NODE_MQTT_CONNECTIONS.includes(value.connection as RdfNodeMqttConnection)
    || typeof value.node_id !== 'string'
    || !RDF_NODE_MQTT_NODE_ID.test(value.node_id)
    || (value.status !== 'UNAVAILABLE' && value.status !== 'FRESH' && value.status !== 'STALE' && value.status !== 'INVALID')
    || typeof value.stale !== 'boolean'
    || !(value.trust === null || value.trust === 'UNVERIFIED')
    || !(value.encoding === null || value.encoding === 'q16' || value.encoding === 'u8')
    || !(value.source_timestamp_ms === null || isIntegerInRange(value.source_timestamp_ms, 1, Number.MAX_SAFE_INTEGER))
    || !(value.source_age_ms === null || isNonNegativeSafeInteger(value.source_age_ms))
    || !(value.received_age_ms === null || isNonNegativeSafeInteger(value.received_age_ms))
    || !(value.flags === null || isIntegerInRange(value.flags, 0, 0x1f))
    || !Array.isArray(value.validation_reasons)
    || value.validation_reasons.length > 32
    || !value.validation_reasons.every((reason) => typeof reason === 'string' && RDF_NODE_MQTT_DIAGNOSTIC_REASON.test(reason))
    || !(value.values === null
      || (Array.isArray(value.values)
        && value.values.length === 360
        && value.values.every(isDiagnosticFiniteNumber)))
    || !(value.error === null || (typeof value.error === 'string' && RDF_NODE_MQTT_ERROR_CODE.test(value.error)))) {
    return invalidDiagnosticAngularLatestResponse();
  }

  const noCandidate = value.trust === null
    && value.encoding === null
    && value.source_timestamp_ms === null
    && value.source_age_ms === null
    && value.received_age_ms === null
    && value.flags === null
    && value.validation_reasons.length === 0
    && value.values === null;
  if (value.status === 'UNAVAILABLE' || value.status === 'INVALID') {
    if (!noCandidate || value.stale || (value.status === 'UNAVAILABLE' ? value.error !== null : value.error === null)) {
      return invalidDiagnosticAngularLatestResponse();
    }
  } else {
    if (value.trust !== 'UNVERIFIED'
      || value.encoding === null
      || value.source_timestamp_ms === null
      || value.flags === null
      || !value.validation_reasons.includes('DIAGNOSTIC_UNVERIFIED')
      || value.values === null
      || (value.status === 'FRESH' && (
        value.stale
        || !value.enabled
        || value.connection !== 'ready'
        || value.source_age_ms === null
        || value.source_age_ms > 10_000
        || value.received_age_ms === null
        || value.received_age_ms > 3_000
        || (value.flags & 0x02) === 0
        || value.error !== null
      ))
      || (value.status === 'STALE' && (!value.stale || value.error === null))) {
      return invalidDiagnosticAngularLatestResponse();
    }
  }

  return {
    enabled: value.enabled,
    connection: value.connection as RdfNodeMqttConnection,
    node_id: value.node_id,
    status: value.status,
    stale: value.stale,
    trust: value.trust,
    encoding: value.encoding,
    source_timestamp_ms: value.source_timestamp_ms,
    source_age_ms: value.source_age_ms,
    received_age_ms: value.received_age_ms,
    flags: value.flags,
    validation_reasons: value.validation_reasons.slice(),
    values: value.values === null ? null : value.values.slice(),
    error: value.error,
  };
}

/** Validate the fields needed by the local console before they reach state. */
export function normalizeConsoleConfig(value: unknown): ConsoleConfig {
  if (!isObject(value)
    || typeof value.base_url !== 'string'
    || typeof value.mqtt_host !== 'string'
    || !finiteNumber(value.mqtt_port)
    || (value.mqtt_transport !== 'tcp' && value.mqtt_transport !== 'websockets')
    || typeof value.mqtt_ws_path !== 'string'
    || !value.mqtt_ws_path.startsWith('/')
    || typeof value.mqtt_username !== 'string'
    || typeof value.mqtt_password_set !== 'boolean'
    || typeof value.rdf_node_id !== 'string'
    || !RDF_NODE_MQTT_NODE_ID.test(value.rdf_node_id)
    || value.rdf_node_id === '.' || value.rdf_node_id === '..'
    || !finiteNumber(value.refresh_seconds)) {
    throw new Error('console config response has an invalid shape');
  }
  const config: ConsoleConfig = {
    base_url: value.base_url,
    mqtt_host: value.mqtt_host,
    mqtt_port: value.mqtt_port,
    mqtt_transport: value.mqtt_transport,
    mqtt_ws_path: value.mqtt_ws_path,
    mqtt_username: value.mqtt_username,
    mqtt_password_set: value.mqtt_password_set,
    refresh_seconds: value.refresh_seconds,
    rdf_node_id: value.rdf_node_id,
  };
  if (value.version !== undefined) {
    if (!finiteNumber(value.version)) throw new Error('console config response has an invalid version');
    config.version = value.version;
  }
  return config;
}

function sameConfigValues(left: ConsoleConfig, right: ConsoleConfig): boolean {
  return left.base_url === right.base_url
    && left.mqtt_host === right.mqtt_host
    && left.mqtt_port === right.mqtt_port
    && left.mqtt_transport === right.mqtt_transport
    && left.mqtt_ws_path === right.mqtt_ws_path
    && left.mqtt_username === right.mqtt_username
    && left.mqtt_password_set === right.mqtt_password_set
    && left.refresh_seconds === right.refresh_seconds
    && left.rdf_node_id === right.rdf_node_id
    && (left.version === undefined || left.version === right.version);
}

function hasConfigFields(value: unknown): boolean {
  return isObject(value)
    && 'base_url' in value
    && 'mqtt_host' in value
    && 'mqtt_port' in value
    && 'mqtt_transport' in value
    && 'mqtt_ws_path' in value
    && 'mqtt_username' in value
    && 'mqtt_password_set' in value
    && 'rdf_node_id' in value
    && 'refresh_seconds' in value;
}

export async function getConsoleConfig(signal?: AbortSignal): Promise<ConsoleConfig> {
  const body = await requestJson<unknown>('/api/console-config', {
    cache: 'no-store',
    credentials: 'same-origin',
  }, signal);
  return normalizeConsoleConfig(body);
}

/**
 * Persist local configuration, then verify the exact stored values with a
 * separate GET. A successful POST alone is never reported to the UI.
 */
export async function updateConsoleConfig(
  config: ConsoleConfig,
  options: { mqttPassword?: string; clearMqttPassword?: boolean } = {},
  signal?: AbortSignal,
): Promise<ConsoleConfig> {
  const expected = normalizeConsoleConfig(config);
  const payload: Record<string, unknown> = { ...expected };
  if (options.mqttPassword !== undefined) {
    if (options.clearMqttPassword || options.mqttPassword === '') {
      throw new Error('Enter a new broker password or clear the saved password, not both.');
    }
    payload.mqtt_password = options.mqttPassword;
    expected.mqtt_password_set = true;
  } else if (options.clearMqttPassword) {
    payload.clear_mqtt_password = true;
    expected.mqtt_password_set = false;
  }
  const postedBody = await requestJson<unknown>('/api/console-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  }, signal);
  const readback = await getConsoleConfig(signal);

  if (!sameConfigValues(expected, readback)) {
    throw new Error('console config read-back did not match the requested values');
  }
  if (hasConfigFields(postedBody)) {
    const posted = normalizeConsoleConfig(postedBody);
    if (!sameConfigValues(posted, readback)) {
      throw new Error('console config POST response did not match the GET read-back');
    }
  }
  return readback;
}

export async function getSnapshot(baseUrl: string, signal?: AbortSignal): Promise<TelemetrySnapshot> {
  const url = `/api/snapshot?base_url=${encodeURIComponent(baseUrl)}`;
  const body = await requestJson<unknown>(url, {
    cache: 'no-store',
    credentials: 'same-origin',
  }, signal);
  if (!isObject(body)) throw new Error('Data Out snapshot response has an invalid shape');
  return body as TelemetrySnapshot;
}

export async function getSystemHealth(signal?: AbortSignal): Promise<SystemHealthSnapshot> {
  const body = await requestJson<unknown>('/api/system-health', {
    cache: 'no-store',
    credentials: 'same-origin',
  }, signal);
  return normalizeSystemHealthSnapshot(body);
}

export async function getBranding(signal?: AbortSignal): Promise<Branding> {
  const body = await requestJson<unknown>('/api/branding', {
    cache: 'no-store',
    credentials: 'same-origin',
  }, signal);
  return normalizeBranding(body);
}

export async function getAdminStatus(signal?: AbortSignal): Promise<{ authenticated: boolean }> {
  const body = await requestJson<unknown>('/api/admin/status', {
    cache: 'no-store',
    credentials: 'same-origin',
  }, signal);
  return { authenticated: isObject(body) && body.authenticated === true };
}

export async function loginAdmin(password: string, signal?: AbortSignal): Promise<void> {
  await requestJson<unknown>('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ password }),
  }, signal);
}

export async function logoutAdmin(signal?: AbortSignal): Promise<void> {
  await requestJson<unknown>('/api/admin/logout', {
    method: 'POST',
    credentials: 'same-origin',
    body: '{}',
  }, signal);
}

export async function saveBranding(payload: Branding, signal?: AbortSignal): Promise<Branding> {
  const response = await requestJson<unknown>('/api/admin/branding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  }, signal);
  return normalizeBranding(response);
}

export async function getRdfNodeMqtt(signal?: AbortSignal): Promise<RdfNodeMqttSnapshot> {
  const body = await requestJson<unknown>('/api/mqtt/rdf-node', {
    cache: 'no-store',
    credentials: 'same-origin',
  }, signal);
  return normalizeRdfNodeMqttSnapshot(body);
}

export async function getDiagnosticAngularLatest(
  signal?: AbortSignal,
): Promise<RdfNodeMqttDiagnosticAngularLatest> {
  const body = await requestJson<unknown>('/api/v2/angular/diagnostic/latest', {
    cache: 'no-store',
    credentials: 'same-origin',
  }, signal);
  return normalizeDiagnosticAngularLatest(body);
}

export async function getMqtt(signal?: AbortSignal): Promise<MqttSnapshot> {
  const body = await requestJson<unknown>('/api/mqtt', {
    cache: 'no-store',
    credentials: 'same-origin',
  }, signal);
  if (!isObject(body)) throw new Error('MQTT response has an invalid shape');
  return body as MqttSnapshot;
}

export async function connectMqtt(host: string, port: number, signal?: AbortSignal): Promise<MqttSnapshot> {
  const body = await requestJson<unknown>(`/api/mqtt/connect?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}`, {
    method: 'POST',
    credentials: 'same-origin',
  }, signal);
  if (!isObject(body)) throw new Error('MQTT connect response has an invalid shape');
  return body as MqttSnapshot;
}

export async function dryRunConfigPatch(payload: {
  base_config_rev?: number;
  changes: Record<string, number>;
}, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const body = await requestJson<unknown>('/api/dry-run/config-patch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  }, signal);
  if (!isObject(body)) throw new Error('dry-run response has an invalid shape');
  return body;
}
