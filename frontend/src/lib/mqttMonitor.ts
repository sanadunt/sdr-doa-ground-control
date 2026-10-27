import type { ConsoleConfig, MqttEntry, MqttSnapshot, MqttTarget, MqttTransport, RdfNodeAck, RdfNodePart, RdfNodeSnapshot, RdfNodeTopic, RdfNodeView, Tone } from '../types';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonNegative(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

export const MQTT_TRANSPORTS: readonly MqttTransport[] = ['tcp', 'websockets'];
export const DEFAULT_MQTT_TRANSPORT: MqttTransport = 'websockets';
export const DEFAULT_MQTT_WS_PATH = '/mqtt';
/** Same rule as the server's mqtt_ws_path check: starts with /, at most 128 characters, no query or spaces. */
const MQTT_WS_PATH_PATTERN = /^\/[A-Za-z0-9._~/-]{0,127}$/u;

export function isMqttTransport(value: unknown): value is MqttTransport {
  return value === 'tcp' || value === 'websockets';
}

export function isMqttWsPath(value: unknown): value is string {
  return typeof value === 'string' && MQTT_WS_PATH_PATTERN.test(value);
}

/** Trimmed WebSocket path for saving, or null when the server would reject it. */
export function normalizeMqttWsPath(input: string): string | null {
  const path = input.trim();
  return isMqttWsPath(path) ? path : null;
}

/**
 * Transport fields for a console-config save. A field the server never
 * reported and the operator did not set is left out, so the server keeps
 * its stored value.
 */
export function mqttTransportFields(
  transport: MqttTransport | undefined,
  wsPath: string | undefined,
): { ok: true; value: Pick<ConsoleConfig, 'mqtt_transport' | 'mqtt_ws_path'> } | { ok: false; error: 'config.mqttWsPathInvalid' } {
  const value: Pick<ConsoleConfig, 'mqtt_transport' | 'mqtt_ws_path'> = {};
  if (transport !== undefined) value.mqtt_transport = transport;
  if (wsPath !== undefined) {
    const path = normalizeMqttWsPath(wsPath);
    if (path === null) return { ok: false, error: 'config.mqttWsPathInvalid' };
    value.mqtt_ws_path = path;
  }
  return { ok: true, value };
}

/** The configured broker, with the saved transport and WebSocket path when the console reported them. */
export function mqttTargetFromConfig(config: Pick<ConsoleConfig, 'mqtt_host' | 'mqtt_port' | 'mqtt_transport' | 'mqtt_ws_path'>): MqttTarget {
  const target: MqttTarget = { host: config.mqtt_host, port: Number(config.mqtt_port) };
  if (config.mqtt_transport !== undefined) target.transport = config.mqtt_transport;
  if (config.mqtt_transport === 'websockets' && config.mqtt_ws_path !== undefined) target.wsPath = config.mqtt_ws_path;
  return target;
}

const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential)/iu;
// Matched against the last word of a key only, so `valid` or `doa_valid`
// are not mistaken for an `id`.
const IDENTIFIER_WORDS = new Set(['station', 'unit', 'hardware', 'serial', 'client', 'device', 'host', 'hostname', 'topic', 'id', 'uid', 'uuid']);
const MAX_PAYLOAD_DEPTH = 6;

function lastKeyWord(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').split(/[\s_.-]+/u).filter(Boolean);
  return (words[words.length - 1] ?? '').toLowerCase();
}

/** Whether the monitor hides this payload key's value. */
export function isRedactedPayloadKey(key: string): boolean {
  return SECRET_KEY.test(key) || IDENTIFIER_WORDS.has(lastKeyWord(key));
}

/** Bounded copy of an untrusted payload with identifiers and secrets replaced by [REDACTED]. */
export function sanitizeMqttPayload(value: unknown, depth = 0): unknown {
  if (depth > MAX_PAYLOAD_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 24).map((item) => sanitizeMqttPayload(item, depth + 1));
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' && value.length > 180 ? `${value.slice(0, 177)}…` : value;
  }
  const output: JsonObject = {};
  for (const [key, entry] of Object.entries(value as JsonObject).slice(0, 64)) {
    output[key] = isRedactedPayloadKey(key) ? '[REDACTED]' : sanitizeMqttPayload(entry, depth + 1);
  }
  return output;
}

const KIND_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;
const FLAG_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;
const MAX_KINDS = 16;

function normalizeKindCounts(value: unknown): Record<string, number> | undefined {
  if (!isObject(value)) return undefined;
  const output: Record<string, number> = {};
  for (const [kind, entry] of Object.entries(value)) {
    if (Object.keys(output).length >= MAX_KINDS) break;
    const number = count(entry);
    if (KIND_PATTERN.test(kind) && number !== undefined) output[kind] = number;
  }
  return output;
}

function normalizeEntry(kind: string, value: JsonObject, nowMs: number | null): MqttEntry {
  const entry: MqttEntry = { kind };
  const receivedAt = nonNegative(value.received_at_ms);
  if (receivedAt !== null) entry.received_at_ms = receivedAt;
  const age = nonNegative(value.age_ms);
  entry.age_ms = age ?? (receivedAt !== null && nowMs !== null ? Math.max(0, nowMs - receivedAt) : null);
  entry.source_ts_ms = nonNegative(value.source_ts_ms);
  const bytes = count(value.bytes);
  if (bytes !== undefined) entry.bytes = bytes;
  const qos = count(value.qos);
  if (qos !== undefined) entry.qos = qos;
  entry.retained = value.retained === true;
  entry.valid = value.valid === true;
  if (value.cleared === true) entry.cleared = true;
  if (isObject(value.validity_flags)) {
    const flags: Record<string, boolean> = {};
    for (const [name, flag] of Object.entries(value.validity_flags).slice(0, 8)) {
      if (FLAG_PATTERN.test(name) && typeof flag === 'boolean') flags[name] = flag;
    }
    if (Object.keys(flags).length) entry.validity_flags = flags;
  }
  const source = text(value.source, 64);
  if (source) entry.source = source;
  entry.latency_ms = finite(value.latency_ms);
  const error = text(value.error, 300);
  if (error) entry.error = error;
  if (value.payload !== undefined) entry.payload = sanitizeMqttPayload(value.payload);
  return entry;
}

/**
 * Validate a /api/mqtt response. Unknown fields are dropped, numbers must be
 * finite, and payloads are sanitized here so redaction does not depend on
 * the renderer. `fetchedAtMs` is the browser clock at read time.
 */
export function normalizeMqttSnapshot(value: unknown, fetchedAtMs: number): MqttSnapshot {
  if (!isObject(value)) throw new Error('MQTT response has an invalid shape');
  const snapshot: MqttSnapshot = { fetched_at_ms: fetchedAtMs };
  for (const key of ['enabled', 'read_only', 'publish_enabled'] as const) {
    if (typeof value[key] === 'boolean') snapshot[key] = value[key] as boolean;
  }
  const host = text(value.host, 255);
  if (host) snapshot.host = host;
  const port = count(value.port);
  if (port !== undefined && port >= 1 && port <= 65535) snapshot.port = port;
  if (isMqttTransport(value.transport)) snapshot.transport = value.transport;
  if (isMqttWsPath(value.ws_path)) snapshot.ws_path = value.ws_path;
  const connection = text(value.connection, 32);
  if (connection) snapshot.connection = connection;
  snapshot.last_error = text(value.last_error, 300) ?? null;
  const nowMs = nonNegative(value.now_ms);
  if (nowMs !== null) snapshot.now_ms = nowMs;
  for (const key of ['received', 'valid', 'invalid', 'cleared', 'total_bytes'] as const) {
    const number = count(value[key]);
    if (number !== undefined) snapshot[key] = number;
  }
  snapshot.last_received_at_ms = nonNegative(value.last_received_at_ms);
  snapshot.last_age_ms = nonNegative(value.last_age_ms);
  snapshot.last_latency_ms = finite(value.last_latency_ms);
  snapshot.last_topic = typeof value.last_topic === 'string' && value.last_topic ? value.last_topic.slice(0, 256) : null;
  const kindCounts = normalizeKindCounts(value.kind_counts);
  if (kindCounts) snapshot.kind_counts = kindCounts;
  if (isObject(value.last_by_kind)) {
    const entries: Record<string, MqttEntry> = {};
    for (const [kind, entry] of Object.entries(value.last_by_kind)) {
      if (Object.keys(entries).length >= MAX_KINDS) break;
      if (KIND_PATTERN.test(kind) && isObject(entry)) entries[kind] = normalizeEntry(kind, entry, nowMs);
    }
    snapshot.last_by_kind = entries;
  }
  return snapshot;
}

/** Display thresholds for the receive age of one kind; kinds without one are events or markers. */
export const MQTT_KIND_STALE_AFTER_MS: Readonly<Record<string, number>> = {
  doa: 5_000,
  nav: 5_000,
  health: 8_000,
  // The edge agent re-publishes state and config every 30 s.
  state: 65_000,
  config_reported: 65_000,
};

const KIND_ORDER = ['doa', 'health', 'nav', 'state', 'config_reported', 'availability', 'ack_config', 'config_patch', 'unknown'];

/** Time since this snapshot was read, on the browser clock. */
export function elapsedSinceRead(fetchedAtMs: number | undefined, nowLocalMs: number): number {
  return fetchedAtMs === undefined || !Number.isFinite(fetchedAtMs) ? 0 : Math.max(0, nowLocalMs - fetchedAtMs);
}

/** Age of the last message of any kind, aged locally since the read. */
export function lastMessageAgeMs(snapshot: MqttSnapshot | null | undefined, nowLocalMs: number): number | null {
  const age = snapshot?.last_age_ms;
  return typeof age === 'number' ? age + elapsedSinceRead(snapshot?.fetched_at_ms, nowLocalMs) : null;
}

export type MqttContractState = 'VALID' | 'INVALID' | 'CLEARED';

export interface MqttKindRow {
  kind: string;
  count: number | null;
  contract: MqttContractState;
  retained: boolean;
  synthetic: boolean;
  source: string | null;
  flags: Array<{ name: string; value: boolean }>;
  /** health.state from the payload (ONLINE, STALE, DEGRADED, UNAVAILABLE, ...). */
  healthState: string | null;
  /** health.reasons codes. */
  reasons: string[];
  availability: { online: boolean; reason: string | null } | null;
  /** Receive age on the console, aged locally since the read. */
  ageMs: number | null;
  /** Payload ts_ms age (edge clock, may be skewed). Shown for broker replays. */
  sourceAgeMs: number | null;
  staleAfterMs: number | null;
  stale: boolean;
  bytes: number | null;
  latencyMs: number | null;
  error: string | null;
}

const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

function payloadRecord(entry: MqttEntry | undefined): JsonObject | null {
  return isObject(entry?.payload) ? entry.payload : null;
}

/**
 * One row per observed kind with its count, contract and payload status,
 * and local age. A broker replay is judged by its payload age, because its
 * receive time only says when this console subscribed.
 */
export function mqttKindRows(snapshot: MqttSnapshot | null | undefined, nowLocalMs: number): MqttKindRow[] {
  const entries = snapshot?.last_by_kind ?? {};
  const counts = snapshot?.kind_counts ?? {};
  const kinds = [...new Set([...Object.keys(entries), ...Object.keys(counts)])].sort((left, right) => {
    const a = KIND_ORDER.indexOf(left);
    const b = KIND_ORDER.indexOf(right);
    if (a !== b) return (a === -1 ? KIND_ORDER.length : a) - (b === -1 ? KIND_ORDER.length : b);
    return left.localeCompare(right);
  });
  const elapsed = elapsedSinceRead(snapshot?.fetched_at_ms, nowLocalMs);
  const nowMs = typeof snapshot?.now_ms === 'number' ? snapshot.now_ms : null;
  return kinds.map((kind) => {
    const entry = entries[kind];
    const payload = payloadRecord(entry);
    const contract: MqttContractState = entry?.cleared ? 'CLEARED' : entry?.valid ? 'VALID' : 'INVALID';
    const ageMs = typeof entry?.age_ms === 'number' ? entry.age_ms + elapsed : null;
    const sourceTs = entry?.source_ts_ms;
    const sourceAgeMs = typeof sourceTs === 'number' && nowMs !== null ? nowMs - sourceTs + elapsed : null;
    const staleAfterMs = MQTT_KIND_STALE_AFTER_MS[kind] ?? null;
    const retained = entry?.retained === true;
    let stale = false;
    if (entry && contract !== 'CLEARED' && staleAfterMs !== null) {
      stale = ageMs === null || ageMs > staleAfterMs
        || (retained && (sourceAgeMs === null || sourceAgeMs > staleAfterMs));
    }
    const reasons = Array.isArray(payload?.reasons)
      ? payload.reasons.filter((code): code is string => typeof code === 'string' && REASON_CODE.test(code)).slice(0, 16)
      : [];
    const healthState = kind === 'health' && typeof payload?.state === 'string' && REASON_CODE.test(payload.state) ? payload.state : null;
    const availability = kind === 'availability' && typeof payload?.online === 'boolean'
      ? { online: payload.online, reason: typeof payload.reason === 'string' && REASON_CODE.test(payload.reason) ? payload.reason : null }
      : null;
    const source = entry?.source ?? null;
    return {
      kind,
      count: typeof counts[kind] === 'number' ? counts[kind] : null,
      contract,
      retained,
      synthetic: source?.toLowerCase() === 'synthetic',
      source,
      flags: Object.entries(entry?.validity_flags ?? {}).map(([name, value]) => ({ name, value })),
      healthState,
      reasons,
      availability,
      ageMs,
      sourceAgeMs,
      staleAfterMs,
      stale,
      bytes: typeof entry?.bytes === 'number' ? entry.bytes : null,
      latencyMs: typeof entry?.latency_ms === 'number' ? entry.latency_ms : null,
      error: entry?.error ?? null,
    };
  });
}

export function healthStateTone(state: string): Tone {
  if (state === 'ONLINE' || state === 'PASS') return 'good';
  if (state === 'STALE' || state === 'DEGRADED' || state === 'UNAVAILABLE' || state === 'FAIL') return 'bad';
  return 'warn';
}

/** Safe per-kind detail for the JSON view; payloads are already sanitized by the normalizer. */
export function mqttDetailRecords(snapshot: MqttSnapshot | null | undefined): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [kind, entry] of Object.entries(snapshot?.last_by_kind ?? {})) {
    output[kind] = {
      bytes: entry.bytes ?? 0,
      qos: entry.qos ?? 0,
      retained: entry.retained ?? false,
      valid: entry.valid ?? false,
      ...(entry.cleared ? { cleared: true } : {}),
      ...(entry.validity_flags ? { validity_flags: entry.validity_flags } : {}),
      ...(entry.source ? { source: entry.source } : {}),
      latency_ms: entry.latency_ms ?? null,
      ...(entry.error ? { error: entry.error } : {}),
      payload: entry.payload,
    };
  }
  return output;
}

/** RDF Node topic suffixes, in the order the server subscribes to them (docs/MQTT_KONTRAK.md). */
export const RDF_NODE_V2_SUFFIXES = [
  'state',
  'capabilities',
  'availability',
  'telemetry/health',
  'telemetry/health/detail',
  'telemetry/doa',
  'telemetry/diagnostic/doa',
  'telemetry/angular',
  'telemetry/diagnostic/angular',
  'settings/reported',
  'ack/config',
  'ack/operation',
] as const;

const RDF_STATUSES = new Set(['LIVE', 'UNVERIFIED', 'FRESH', 'CONTEXT', 'STALE', 'INCONSISTENT', 'IGNORED', 'INVALID', 'UNAVAILABLE']);
const RDF_ERROR = /^[A-Z][A-Z0-9_]{0,31}$/u;
const RDF_FIELD = /^[a-z][a-z0-9_]{0,31}$/u;
const RDF_REASON = /^[A-Z0-9_:-]{1,64}$/u;
const RDF_ACK_STATUS = /^[A-Z][A-Z_]{0,31}$/u;
const RDF_ANGULAR_SUFFIXES = new Set<string>(['telemetry/angular', 'telemetry/diagnostic/angular']);
/** Fields shown for an angular frame; the 360 values stay on the server side of this view. */
const RDF_ANGULAR_FIELDS = ['encoding', 'q', 'timestamp_ms', 'frequency_hz', 'revision', 'vfo', 'convention', 'flags', 'raw_doa_deg', 'confidence_native_db', 'peak_index', 'values_count'];
/** A LIVE, UNVERIFIED or FRESH status is only trusted for this long after the read that reported it. */
export const RDF_LOCAL_HOLD_MS = 5_000;
const RDF_HELD_STATUSES = new Set(['LIVE', 'UNVERIFIED', 'FRESH']);
const MAX_RDF_REASONS = 16;
const MAX_RDF_ACKS = 8;

function rdfReasons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && RDF_REASON.test(item)).slice(0, MAX_RDF_REASONS);
}

function pickSanitized(raw: JsonObject, fields: readonly string[]): Record<string, unknown> {
  const sanitized = sanitizeMqttPayload(Object.fromEntries(fields.filter((key) => key in raw).map((key) => [key, raw[key]])));
  return isObject(sanitized) ? sanitized : {};
}

function normalizeRdfTopic(suffix: string, value: unknown): RdfNodeTopic {
  const record = isObject(value) ? value : {};
  const status = typeof record.status === 'string' && RDF_STATUSES.has(record.status) ? record.status : 'UNAVAILABLE';
  let payload: Record<string, unknown> | null = null;
  const raw = record.payload;
  if (isObject(raw)) {
    if (RDF_ANGULAR_SUFFIXES.has(suffix)) {
      payload = pickSanitized(raw, RDF_ANGULAR_FIELDS);
    } else {
      const sanitized = sanitizeMqttPayload(raw);
      payload = isObject(sanitized) ? sanitized : null;
    }
  }
  const qos = count(record.qos);
  return {
    status,
    received_at_ms: nonNegative(record.received_at_ms),
    qos: qos === undefined ? null : qos,
    retained: typeof record.retained === 'boolean' ? record.retained : null,
    error: typeof record.error === 'string' && RDF_ERROR.test(record.error) ? record.error : null,
    field: typeof record.field === 'string' && RDF_FIELD.test(record.field) ? record.field : null,
    cleared: record.cleared === true,
    payload,
  };
}

/** Parts of the server's node view, in display order, with the fields each shows. */
export const RDF_NODE_PARTS = [
  'session',
  'health',
  'detail',
  'doa',
  'doa_unverified',
  'diagnostic_doa',
  'angular',
  'angular_unverified',
  'capabilities',
  'availability',
  'settings',
] as const;
export type RdfNodePartName = typeof RDF_NODE_PARTS[number];

const RDF_PART_FIELDS: Readonly<Record<RdfNodePartName, readonly string[]>> = {
  session: ['sid', 'cfg', 'run', 'daq', 'profile', 'clock'],
  health: ['run', 'daq', 'clk', 'temp', 'drop', 'age', 'rev'],
  detail: ['usb', 'sync', 'cpu', 'mem', 'disk_free', 'throt', 'uv', 'tx', 'rx', 'ppp', 'peer', 'ppp_svc', 'ppp_restarts'],
  doa: ['a', 'f', 'c', 'p', 'rev'],
  doa_unverified: ['a', 'angle_reference', 'f', 'c', 'p', 'rev'],
  diagnostic_doa: ['raw_doa_deg', 'frequency_mhz', 'source'],
  angular: ['flags', 'raw_doa_deg', 'peak_index', 'frequency_hz', 'revision'],
  angular_unverified: ['from', 'flags', 'raw_doa_deg', 'peak_index', 'frequency_hz', 'revision'],
  capabilities: ['version', 'mode', 'remote_commands', 'remote_config_patch', 'remote_processing', 'remote_restart', 'remote_reboot', 'remote_shutdown', 'remote_ppp_restart'],
  availability: ['online', 'reason'],
  settings: ['rev', 'bytes', 'matches_state_cfg'],
};

/** The status a part shows, from the flags the server set on it. */
function rdfPartStatus(name: RdfNodePartName, raw: JsonObject): string {
  switch (name) {
    case 'session':
      return 'CONTEXT';
    case 'health':
      return raw.fresh === true ? 'FRESH' : 'STALE';
    case 'detail':
      return raw.stale === false ? 'FRESH' : 'STALE';
    case 'doa':
    case 'angular':
      return raw.live === true ? 'LIVE' : 'STALE';
    case 'doa_unverified':
    case 'diagnostic_doa':
    case 'angular_unverified':
      return raw.stale === false ? 'UNVERIFIED' : 'STALE';
    case 'capabilities':
    case 'availability':
      return raw.session_match === false ? 'INCONSISTENT' : 'CONTEXT';
    case 'settings':
      return 'CONTEXT';
  }
  return 'UNAVAILABLE';
}

function normalizeRdfPart(name: RdfNodePartName, value: unknown): RdfNodePart | null {
  if (!isObject(value)) return null;
  const reasons = rdfReasons(name === 'angular_unverified' || name === 'doa_unverified' || name === 'diagnostic_doa' ? value.validation_reasons : value.reasons);
  if (name === 'settings' && value.matches_state_cfg === false) reasons.push('PREVIOUS_CONFIG');
  const fields = pickSanitized(value, RDF_PART_FIELDS[name].filter((field) => field !== 'from'));
  // The candidate's topic (a key the payload sanitizer hides), named after one of the two Angular topics only.
  if (name === 'angular_unverified' && typeof value.topic === 'string' && RDF_ANGULAR_SUFFIXES.has(value.topic)) fields.from = value.topic;
  return {
    status: rdfPartStatus(name, value),
    received_at_ms: nonNegative(value.received_at_ms),
    reasons,
    fields,
  };
}

function normalizeRdfAck(value: unknown): RdfNodeAck | null {
  if (!isObject(value)) return null;
  const topic = value.topic === 'ack/config' || value.topic === 'ack/operation' ? value.topic : null;
  const status = typeof value.status === 'string' && RDF_ACK_STATUS.test(value.status) ? value.status : null;
  if (topic === null || status === null) return null;
  const result = isObject(value.result) ? value.result : {};
  const error = typeof result.error === 'string' && RDF_ERROR.test(result.error) ? result.error : null;
  return { topic, status, final: value.final === true, received_at_ms: nonNegative(value.received_at_ms), error };
}

function normalizeRdfNodeView(value: unknown): RdfNodeView {
  const record = isObject(value) ? value : {};
  const parts: Record<string, RdfNodePart | null> = {};
  for (const name of RDF_NODE_PARTS) parts[name] = normalizeRdfPart(name, record[name]);
  const acks = Array.isArray(record.acks)
    ? record.acks.slice(0, MAX_RDF_ACKS).map(normalizeRdfAck).filter((ack): ack is RdfNodeAck => ack !== null)
    : [];
  const requests = Array.isArray(record.settings_requests) ? record.settings_requests.length : 0;
  return { parts, acks, settings_requests: requests };
}

/** Validate a /api/mqtt/rdf-node response. Missing topics read as UNAVAILABLE, missing node parts as null. */
export function normalizeRdfNodeSnapshot(value: unknown, fetchedAtMs: number): RdfNodeSnapshot {
  if (!isObject(value)) throw new Error('RDF Node response has an invalid shape');
  const topics = isObject(value.topics) ? value.topics : {};
  const topicCounts = isObject(value.topic_counts) ? value.topic_counts : {};
  const invalidCounts = isObject(value.invalid_counts) ? value.invalid_counts : {};
  const normalizedTopics: Record<string, RdfNodeTopic> = {};
  const normalizedCounts: Record<string, number> = {};
  const normalizedInvalid: Record<string, number> = {};
  for (const suffix of RDF_NODE_V2_SUFFIXES) {
    normalizedTopics[suffix] = normalizeRdfTopic(suffix, topics[suffix]);
    const number = count(topicCounts[suffix]);
    if (number !== undefined) normalizedCounts[suffix] = number;
    const invalid = count(invalidCounts[suffix]);
    if (invalid !== undefined) normalizedInvalid[suffix] = invalid;
  }
  return {
    enabled: value.enabled === true,
    connection: text(value.connection, 32) ?? 'disabled',
    last_error: text(value.last_error, 300) ?? null,
    now_ms: nonNegative(value.now_ms),
    fetched_at_ms: fetchedAtMs,
    received: count(value.received) ?? null,
    valid: count(value.valid) ?? null,
    invalid: count(value.invalid) ?? null,
    last_received_at_ms: nonNegative(value.last_received_at_ms),
    topic_counts: normalizedCounts,
    invalid_counts: normalizedInvalid,
    topics: normalizedTopics,
    node: normalizeRdfNodeView(value.node),
  };
}

export interface RdfTopicRow {
  suffix: string;
  count: number | null;
  /** Server status; LIVE, UNVERIFIED and FRESH turn STALE once the read is older than RDF_LOCAL_HOLD_MS. */
  status: string;
  ageMs: number | null;
  retained: boolean | null;
  error: string | null;
  field: string | null;
  /** Short field=value pairs; empty for DoA and angular unless they are LIVE or UNVERIFIED. */
  summary: Array<[string, string]>;
  /** DoA or angular values exist but are not shown because the topic is neither LIVE nor UNVERIFIED. */
  withheld: boolean;
}

function summaryValue(value: unknown): string | null {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.round(value * 1000) / 1000);
  if (typeof value === 'string' && value) return value.slice(0, 48);
  if (Array.isArray(value)) {
    const items = value.slice(0, 4).map(summaryValue).filter((item): item is string => item !== null);
    return items.length ? items.join('/') : null;
  }
  return null;
}

/** Short field=value pairs of a record, in the given order. */
export function rdfSummary(record: Record<string, unknown> | null | undefined, fields: readonly string[]): Array<[string, string]> {
  const summary: Array<[string, string]> = [];
  if (!record) return summary;
  for (const field of fields) {
    const value = summaryValue(record[field]);
    if (value !== null) summary.push([field, value]);
  }
  return summary;
}

const RDF_SUMMARY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  state: ['run', 'daq', 'cfg', 'profile', 'clock'],
  capabilities: ['version', 'mode', 'angle', 'count', 'remote_commands'],
  availability: ['online', 'reason'],
  'telemetry/health': ['run', 'daq', 'drop', 'age', 'temp', 'clk', 'rev'],
  'telemetry/health/detail': ['usb', 'sync', 'cpu', 'mem', 'disk_free', 'throt', 'uv', 'ppp', 'peer', 'ppp_svc'],
  'telemetry/doa': ['a', 'c', 'p', 'f', 'ok', 'rev'],
  'telemetry/diagnostic/doa': ['raw_doa_deg', 'frequency_mhz'],
  'telemetry/angular': ['flags', 'raw_doa_deg', 'frequency_hz', 'revision'],
  'telemetry/diagnostic/angular': ['flags', 'raw_doa_deg', 'frequency_hz', 'revision'],
  'settings/reported': ['rev', 'bytes'],
  'ack/config': ['status', 'rev'],
  'ack/operation': ['status', 'rev'],
};
/** Direction values are shown only for a message the console accepted. */
const RDF_GATED_SUFFIXES = new Set<string>(['telemetry/doa', 'telemetry/diagnostic/doa', 'telemetry/angular', 'telemetry/diagnostic/angular']);

function heldStatus(status: string, elapsed: number): string {
  return RDF_HELD_STATUSES.has(status) && elapsed > RDF_LOCAL_HOLD_MS ? 'STALE' : status;
}

/** Display rows for the topic table, with ages advanced on the browser clock since the read. */
export function rdfTopicRows(snapshot: RdfNodeSnapshot | null | undefined, nowLocalMs: number): RdfTopicRow[] {
  const elapsed = elapsedSinceRead(snapshot?.fetched_at_ms, nowLocalMs);
  return RDF_NODE_V2_SUFFIXES.map((suffix) => {
    const topic = snapshot?.topics[suffix];
    const receivedAt = topic?.received_at_ms ?? null;
    const nowMs = snapshot?.now_ms ?? null;
    const ageMs = receivedAt !== null && nowMs !== null ? Math.max(0, nowMs - receivedAt) + elapsed : null;
    const status = topic?.cleared ? 'CLEARED' : heldStatus(topic?.status ?? 'UNAVAILABLE', elapsed);
    const payload = topic?.payload ?? null;
    const withheld = payload !== null && RDF_GATED_SUFFIXES.has(suffix) && status !== 'LIVE' && status !== 'UNVERIFIED';
    return {
      suffix,
      count: snapshot?.topic_counts[suffix] ?? null,
      status,
      ageMs,
      retained: topic?.retained ?? null,
      error: topic?.error ?? null,
      field: topic?.field ?? null,
      summary: withheld ? [] : rdfSummary(payload, RDF_SUMMARY_FIELDS[suffix] ?? []),
      withheld,
    };
  });
}

export interface RdfNodeRow {
  part: RdfNodePartName;
  status: string;
  ageMs: number | null;
  reasons: string[];
  summary: Array<[string, string]>;
}

/** Display rows for the node view: only parts the server holds a value for. */
export function rdfNodeRows(snapshot: RdfNodeSnapshot | null | undefined, nowLocalMs: number): RdfNodeRow[] {
  if (!snapshot) return [];
  const elapsed = elapsedSinceRead(snapshot.fetched_at_ms, nowLocalMs);
  const rows: RdfNodeRow[] = [];
  for (const part of RDF_NODE_PARTS) {
    const value = snapshot.node.parts[part];
    if (!value) continue;
    const ageMs = value.received_at_ms !== null && snapshot.now_ms !== null ? Math.max(0, snapshot.now_ms - value.received_at_ms) + elapsed : null;
    rows.push({
      part,
      status: heldStatus(value.status, elapsed),
      ageMs,
      reasons: value.reasons,
      summary: rdfSummary(value.fields, RDF_PART_FIELDS[part]),
    });
  }
  return rows;
}

export interface RdfAckRow extends RdfNodeAck {
  ageMs: number | null;
}

export function rdfAckRows(snapshot: RdfNodeSnapshot | null | undefined, nowLocalMs: number): RdfAckRow[] {
  if (!snapshot) return [];
  const elapsed = elapsedSinceRead(snapshot.fetched_at_ms, nowLocalMs);
  return snapshot.node.acks.map((ack) => ({
    ...ack,
    ageMs: ack.received_at_ms !== null && snapshot.now_ms !== null ? Math.max(0, snapshot.now_ms - ack.received_at_ms) + elapsed : null,
  }));
}

export function rdfStatusTone(status: string): Tone {
  if (status === 'LIVE' || status === 'FRESH') return 'good';
  if (status === 'UNVERIFIED') return 'warn';
  if (status === 'STALE' || status === 'INCONSISTENT' || status === 'INVALID') return 'bad';
  return 'neutral';
}

const RDF_ACK_BAD = new Set(['FAILED', 'REJECTED', 'EXPIRED', 'CONFLICT']);
const RDF_ACK_UNSURE = new Set(['PERSISTED_UNVERIFIED', 'OUTCOME_UNKNOWN', 'CANCELLED']);

/** APPLIED is the only success; an unknown or unverified outcome is neither. */
export function rdfAckTone(status: string): Tone {
  if (status === 'APPLIED') return 'good';
  if (RDF_ACK_BAD.has(status)) return 'bad';
  if (RDF_ACK_UNSURE.has(status)) return 'warn';
  return 'neutral';
}
