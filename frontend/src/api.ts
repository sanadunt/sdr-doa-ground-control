import type { Branding, ConsoleConfig, MqttSnapshot, MqttTarget, RdfNodeSnapshot, TelemetrySnapshot } from './types';
import { isMqttTransport, isMqttWsPath, normalizeMqttSnapshot, normalizeRdfNodeSnapshot } from './lib/mqttMonitor';
import { CONFIG_PATCH_KEYS } from './lib/controlDraft';
import { normalizeDataOutHostList } from './lib/dataOutHosts';
import type { ConfigPatchKey } from './lib/controlDraft';

export const DEFAULT_API_TIMEOUT_MS = 10_000;

const DEFAULT_BRANDING: Branding = { app_name: 'SDR-DoA Ground Console', logo_data_url: '' };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** HTTP error from the local console API; `code` is the server's stable error code, when it sends one. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** The message is the server's own error text, not the generic status fallback. */
  readonly serverMessage: boolean;
  /** The parsed error body; untrusted, normalize before use (e.g. command_id, current_base_config_rev). */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, status: number, code: string | null, serverMessage = true, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.serverMessage = serverMessage;
    this.details = details;
  }
}

/** The console stored something other than what was sent, or its POST and GET answers disagree. */
export class ConfigReadbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigReadbackError';
  }
}

function responseError(body: unknown, status: number): Error {
  const serverMessage = isObject(body) && typeof body.error === 'string' && body.error.trim() !== '';
  const detail = serverMessage ? String(body.error) : `request failed (${status})`;
  const code = isObject(body) && typeof body.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(body.code) ? body.code : null;
  return new ApiError(detail, status, code, serverMessage, isObject(body) ? body : {});
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
  const error = Object.assign(new Error(`request timed out after ${timeoutMs} ms`), { timeoutMs });
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

/** Validate the fields needed by the local console before they reach state. */
export function normalizeConsoleConfig(value: unknown): ConsoleConfig {
  if (!isObject(value)
    || typeof value.base_url !== 'string'
    || typeof value.mqtt_host !== 'string'
    || !finiteNumber(value.mqtt_port)
    || !finiteNumber(value.refresh_seconds)) {
    throw new Error('console config response has an invalid shape');
  }
  const config: ConsoleConfig = {
    base_url: value.base_url,
    mqtt_host: value.mqtt_host,
    mqtt_port: value.mqtt_port,
    refresh_seconds: value.refresh_seconds,
  };
  if (value.version !== undefined) {
    if (!finiteNumber(value.version)) throw new Error('console config response has an invalid version');
    config.version = value.version;
  }
  if (value.mqtt_transport !== undefined) {
    if (!isMqttTransport(value.mqtt_transport)) throw new Error('console config response has an invalid MQTT transport');
    config.mqtt_transport = value.mqtt_transport;
  }
  if (value.mqtt_ws_path !== undefined) {
    if (!isMqttWsPath(value.mqtt_ws_path)) throw new Error('console config response has an invalid MQTT WebSocket path');
    config.mqtt_ws_path = value.mqtt_ws_path;
  }
  if (value.data_out_hosts !== undefined) config.data_out_hosts = normalizeDataOutHostList(value.data_out_hosts);
  return config;
}

function sameHosts(left: readonly string[], right: readonly string[] | undefined): boolean {
  return right !== undefined && left.length === right.length && left.every((host, index) => host === right[index]);
}

function sameConfigValues(left: ConsoleConfig, right: ConsoleConfig): boolean {
  return left.base_url === right.base_url
    && left.mqtt_host === right.mqtt_host
    && left.mqtt_port === right.mqtt_port
    && left.refresh_seconds === right.refresh_seconds
    && (left.mqtt_transport === undefined || left.mqtt_transport === right.mqtt_transport)
    && (left.mqtt_ws_path === undefined || left.mqtt_ws_path === right.mqtt_ws_path)
    && (left.data_out_hosts === undefined || sameHosts(left.data_out_hosts, right.data_out_hosts))
    && (left.version === undefined || left.version === right.version);
}

function hasConfigFields(value: unknown): boolean {
  return isObject(value)
    && 'base_url' in value
    && 'mqtt_host' in value
    && 'mqtt_port' in value
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
export async function updateConsoleConfig(config: ConsoleConfig, signal?: AbortSignal): Promise<ConsoleConfig> {
  const expected = normalizeConsoleConfig(config);
  const postedBody = await requestJson<unknown>('/api/console-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(expected),
  }, signal);
  const readback = await getConsoleConfig(signal);

  if (!sameConfigValues(expected, readback)) {
    throw new ConfigReadbackError('console config read-back did not match the requested values');
  }
  if (hasConfigFields(postedBody)) {
    const posted = normalizeConsoleConfig(postedBody);
    if (!sameConfigValues(posted, readback)) {
      throw new ConfigReadbackError('console config POST response did not match the GET read-back');
    }
  }
  return readback;
}

/** How a snapshot read asks the console's shared Data Out read. */
export interface SnapshotReadOptions {
  /** The operator's Refresh: a new read once the last one is 1 s old. */
  refresh?: boolean;
  /** Kontrol's "Cek ulang": read settings.json too instead of its recent copy. */
  freshSettings?: boolean;
  /** Collection id this page already shows, so the next poll gets a new read. */
  seen?: string | null;
}

/** /api/snapshot URL for a read; the console decides whether it reads Data Out. */
export function snapshotUrl(baseUrl: string, options: SnapshotReadOptions = {}): string {
  let url = `/api/snapshot?base_url=${encodeURIComponent(baseUrl)}`;
  if (options.refresh || options.freshSettings) url += '&refresh=1';
  if (options.freshSettings) url += '&fresh_settings=1';
  if (options.seen) url += `&seen=${encodeURIComponent(options.seen)}`;
  return url;
}

export async function getSnapshot(baseUrl: string, signal?: AbortSignal, options: SnapshotReadOptions = {}): Promise<TelemetrySnapshot> {
  const url = snapshotUrl(baseUrl, options);
  const body = await requestJson<unknown>(url, {
    cache: 'no-store',
    credentials: 'same-origin',
  }, signal);
  if (!isObject(body)) throw new Error('Data Out snapshot response has an invalid shape');
  return body as TelemetrySnapshot;
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

export async function getMqtt(signal?: AbortSignal): Promise<MqttSnapshot> {
  const body = await requestJson<unknown>('/api/mqtt', {
    cache: 'no-store',
    credentials: 'same-origin',
  }, signal);
  return normalizeMqttSnapshot(body, Date.now());
}

/** RDF Node v2 telemetry from the same subscriber connection. */
export async function getRdfNodeMqtt(signal?: AbortSignal): Promise<RdfNodeSnapshot> {
  const body = await requestJson<unknown>('/api/mqtt/rdf-node', {
    cache: 'no-store',
    credentials: 'same-origin',
  }, signal);
  return normalizeRdfNodeSnapshot(body, Date.now());
}

/** Query for /api/mqtt/connect. */
export function mqttConnectPath(target: MqttTarget): string {
  const query = new URLSearchParams({ host: target.host, port: String(target.port) });
  if (target.transport !== undefined) query.set('transport', target.transport);
  if (target.transport === 'websockets' && target.wsPath !== undefined) query.set('ws_path', target.wsPath);
  return `/api/mqtt/connect?${query.toString()}`;
}

export async function connectMqtt(target: MqttTarget, signal?: AbortSignal): Promise<MqttSnapshot> {
  const body = await requestJson<unknown>(mqttConnectPath(target), {
    method: 'POST',
    credentials: 'same-origin',
  }, signal);
  if (!isObject(body)) throw new Error('MQTT connect response has an invalid shape');
  return normalizeMqttSnapshot(body, Date.now());
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

export interface ConfigPatchCapability {
  /** The server can publish an admin-confirmed cmd/config/patch over its MQTT connection. */
  enabled: boolean;
  requiresAdmin: boolean;
  /** Full MQTT topic, for display only. */
  topic: string | null;
  qos: number | null;
  /** Command lifetime the server sets, in ms. */
  ttlMs: number | null;
  /** Server-side [min, max] per field in SI units (Hz, dB). Missing fields fall back to the client copy. */
  ranges: Partial<Record<ConfigPatchKey, readonly [number, number]>>;
}

export interface ConsoleCapabilities {
  /** Refresh intervals the server accepts, in seconds (0 = manual), or null when not reported. */
  refreshIntervalsS: number[] | null;
  /** Whether admin login is configured on the server, or null when not reported. */
  adminEnabled: boolean | null;
  /** The admin password is the built-in default (123456); the password itself never leaves the server. */
  adminDefaultPassword: boolean | null;
  /** Config patch publishing, or null when the server does not report it. */
  configPatch: ConfigPatchCapability | null;
}

function normalizeTopic(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[\x21-\x7e]+$/u.test(value) && !/[+#]/u.test(value) ? value : null;
}

function normalizeConfigPatchCapability(value: unknown): ConfigPatchCapability | null {
  if (!isObject(value)) return null;
  const ranges: Partial<Record<ConfigPatchKey, readonly [number, number]>> = {};
  if (isObject(value.ranges)) {
    for (const key of CONFIG_PATCH_KEYS) {
      const range = value.ranges[key];
      if (Array.isArray(range) && range.length === 2 && finiteNumber(range[0]) && finiteNumber(range[1]) && range[0] < range[1]) {
        ranges[key] = [range[0], range[1]];
      }
    }
  }
  const qos = value.qos === 0 || value.qos === 1 || value.qos === 2 ? value.qos : null;
  const ttlMs = finiteNumber(value.ttl_ms) && Number.isInteger(value.ttl_ms) && value.ttl_ms > 0 && value.ttl_ms <= 600_000 ? value.ttl_ms : null;
  return {
    enabled: value.enabled === true,
    // Anything but an explicit false keeps the admin requirement.
    requiresAdmin: value.requires_admin !== false,
    topic: normalizeTopic(value.topic),
    qos,
    ttlMs,
    ranges,
  };
}

export function normalizeCapabilities(value: unknown): ConsoleCapabilities {
  const record = isObject(value) ? value : {};
  const intervals = Array.isArray(record.refresh_intervals_s)
    ? record.refresh_intervals_s.filter((entry): entry is number => typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry <= 3600).slice(0, 16)
    : [];
  return {
    refreshIntervalsS: intervals.length ? [...new Set(intervals)].sort((a, b) => a - b) : null,
    adminEnabled: typeof record.admin_enabled === 'boolean' ? record.admin_enabled : null,
    adminDefaultPassword: typeof record.admin_default_password === 'boolean' ? record.admin_default_password : null,
    configPatch: normalizeConfigPatchCapability(record.config_patch),
  };
}

export async function getCapabilities(signal?: AbortSignal): Promise<ConsoleCapabilities> {
  const body = await requestJson<unknown>('/api/capabilities', {
    cache: 'no-store',
    credentials: 'same-origin',
  }, signal);
  return normalizeCapabilities(body);
}

// ---------------------------------------------------------------------------
// Kontrol: reported config, admin-confirmed config patch, command status.
// ---------------------------------------------------------------------------

const COMMAND_ID_RE = /^[A-Za-z0-9_-]{1,64}$/u;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const REVISION_SOURCES = ['config_reported', 'ack', 'state'] as const;
const VALUE_SOURCES = ['v1_config_reported', 'v2_effective'] as const;
const REPORTED_SOURCES = ['v1', 'v2', 'v1+v2'] as const;
export const CONFIG_COMMAND_STATES = ['published', 'delivered', 'acknowledged', 'acked', 'publish_failed', 'no_ack'] as const;
const FINAL_COMMAND_STATES: ReadonlySet<string> = new Set(['acked', 'publish_failed', 'no_ack']);

export type ConfigRevisionSource = typeof REVISION_SOURCES[number];
export type ConfigValueSource = typeof VALUE_SOURCES[number];
export type ConfigCommandState = typeof CONFIG_COMMAND_STATES[number];

function oneOfValues<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function integerOrNull(value: unknown, minimum = Number.NEGATIVE_INFINITY): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum ? value : null;
}

function finiteOrNull(value: unknown): number | null {
  return finiteNumber(value) ? value : null;
}

function boundedString(value: unknown, maxChars: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars ? value : null;
}

function commandIdOrNull(value: unknown): string | null {
  return typeof value === 'string' && COMMAND_ID_RE.test(value) ? value : null;
}

function codeOrNull(value: unknown): string | null {
  return typeof value === 'string' && CODE_RE.test(value) ? value : null;
}

function patchValues<T>(input: unknown, pick: (value: unknown) => T | null): Record<ConfigPatchKey, T | null> {
  const record = isObject(input) ? input : {};
  const values = {} as Record<ConfigPatchKey, T | null>;
  for (const key of CONFIG_PATCH_KEYS) values[key] = pick(record[key]);
  return values;
}

export interface ConfigReportedBroker {
  host: string | null;
  port: number | null;
  transport: string | null;
  /** Monitor connection state as the server reports it (connected, connecting, disabled, error, ...). */
  connection: string;
}

export interface ConfigReported {
  available: boolean;
  /** MQTT_MONITOR_DISABLED or MQTT_DEPENDENCY_MISSING when unavailable. */
  code: string | null;
  nowMs: number | null;
  broker: ConfigReportedBroker;
  /** The revision a patch must name; chosen by the server from v1 MQTT. */
  baseConfigRev: number | null;
  baseConfigRevSource: ConfigRevisionSource | null;
  reported: {
    configRev: number | null;
    receivedAtMs: number | null;
    ageMs: number | null;
    retained: boolean;
    synthetic: boolean;
    source: string | null;
  } | null;
  values: Record<ConfigPatchKey, number | null>;
  valueSources: Record<ConfigPatchKey, ConfigValueSource | null>;
  /** Server time the message carrying each value arrived; null when unknown. */
  valueReceivedAtMs: Record<ConfigPatchKey, number | null>;
  pendingCommandId: string | null;
}

export function normalizeConfigReported(value: unknown): ConfigReported {
  if (!isObject(value)) throw new Error('config-reported response has an invalid shape');
  const broker = isObject(value.broker) ? value.broker : {};
  const reported = isObject(value.reported) ? value.reported : null;
  const baseConfigRev = integerOrNull(value.base_config_rev, 0);
  return {
    available: value.available === true,
    code: codeOrNull(value.code),
    nowMs: finiteOrNull(value.now_ms),
    broker: {
      host: boundedString(broker.host, 255),
      port: integerOrNull(broker.port, 1),
      transport: boundedString(broker.transport, 32),
      connection: boundedString(broker.connection, 32) ?? 'unknown',
    },
    baseConfigRev,
    baseConfigRevSource: baseConfigRev !== null && oneOfValues(REVISION_SOURCES, value.base_config_rev_source) ? value.base_config_rev_source : null,
    reported: reported ? {
      configRev: integerOrNull(reported.config_rev, 0),
      receivedAtMs: integerOrNull(reported.received_at_ms, 0),
      ageMs: integerOrNull(reported.age_ms, 0),
      retained: reported.retained === true,
      synthetic: reported.synthetic === true,
      source: oneOfValues(REPORTED_SOURCES, reported.source) ? reported.source : null,
    } : null,
    values: patchValues(value.values, finiteOrNull),
    valueSources: patchValues(value.value_sources, (entry) => (oneOfValues(VALUE_SOURCES, entry) ? entry : null)),
    valueReceivedAtMs: patchValues(value.value_received_at_ms, (entry) => integerOrNull(entry, 0)),
    pendingCommandId: commandIdOrNull(value.pending_command_id),
  };
}

/** What the Raspberry reported over MQTT, and the base revision the next patch must name. No admin needed. */
export async function getConfigReported(signal?: AbortSignal): Promise<ConfigReported> {
  const body = await requestJson<unknown>('/api/mqtt/config-reported', {
    cache: 'no-store',
    credentials: 'same-origin',
  }, signal);
  return normalizeConfigReported(body);
}

export interface ConfigPatchRequest {
  changes: Partial<Record<ConfigPatchKey, number>>;
  base_config_rev: number;
  /** Always true: the operator reviewed the change in Kontrol. */
  confirm: true;
}

export interface ConfigPatchAccepted {
  commandId: string;
  state: ConfigCommandState;
  topic: string | null;
  qos: number | null;
  baseConfigRev: number | null;
  issuedTsMs: number | null;
  expiresTsMs: number | null;
  ttlMs: number | null;
  changes: Partial<Record<ConfigPatchKey, number>>;
}

function patchChanges(value: unknown): Partial<Record<ConfigPatchKey, number>> {
  const changes: Partial<Record<ConfigPatchKey, number>> = {};
  if (!isObject(value)) return changes;
  for (const key of CONFIG_PATCH_KEYS) {
    const entry = value[key];
    if (finiteNumber(entry)) changes[key] = entry;
  }
  return changes;
}

export function normalizeConfigPatchAccepted(value: unknown): ConfigPatchAccepted {
  const commandId = isObject(value) ? commandIdOrNull(value.command_id) : null;
  if (!isObject(value) || value.ok !== true || !commandId) throw new Error('config-patch response has an invalid shape');
  return {
    commandId,
    state: oneOfValues(CONFIG_COMMAND_STATES, value.state) ? value.state : 'published',
    topic: normalizeTopic(value.topic),
    qos: value.qos === 0 || value.qos === 1 || value.qos === 2 ? value.qos : null,
    baseConfigRev: integerOrNull(value.base_config_rev, 0),
    issuedTsMs: integerOrNull(value.issued_ts_ms, 0),
    expiresTsMs: integerOrNull(value.expires_ts_ms, 0),
    ttlMs: integerOrNull(value.ttl_ms, 1),
    changes: patchChanges(value.changes),
  };
}

/**
 * Publish an admin-confirmed config patch through the console's MQTT
 * connection. The browser sends its Origin and the admin cookie; the server
 * checks both, the allowlist, the ranges and the base revision again.
 */
export async function sendConfigPatch(request: ConfigPatchRequest, signal?: AbortSignal): Promise<ConfigPatchAccepted> {
  const body = await requestJson<unknown>('/api/mqtt/config-patch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    body: JSON.stringify({ changes: patchChanges(request.changes), base_config_rev: request.base_config_rev, confirm: true }),
  }, signal);
  return normalizeConfigPatchAccepted(body);
}

export interface ConfigCommandAck {
  status: string;
  configRev: number | null;
  readbackOk: boolean | null;
  errorCode: string | null;
  currentConfigRev: number | null;
  changedFields: string[];
  receivedAtMs: number | null;
}

export interface ConfigCommandStatus {
  commandId: string;
  state: ConfigCommandState;
  final: boolean;
  nowMs: number | null;
  issuedTsMs: number | null;
  expiresTsMs: number | null;
  baseConfigRev: number | null;
  changes: Partial<Record<ConfigPatchKey, number>>;
  pubackReason: number | null;
  echoed: boolean;
  monitorRestarted: boolean;
  ack: ConfigCommandAck | null;
}

function normalizeAck(value: unknown): ConfigCommandAck | null {
  if (!isObject(value)) return null;
  const status = typeof value.status === 'string' && /^[a-z_]{1,32}$/u.test(value.status) ? value.status : null;
  if (!status) return null;
  return {
    status,
    configRev: integerOrNull(value.config_rev, 0),
    readbackOk: typeof value.readback_ok === 'boolean' ? value.readback_ok : null,
    errorCode: codeOrNull(value.error_code),
    currentConfigRev: integerOrNull(value.current_config_rev, 0),
    changedFields: Array.isArray(value.changed_fields) ? value.changed_fields.filter((entry): entry is string => typeof entry === 'string' && entry.length <= 64).slice(0, 16) : [],
    receivedAtMs: integerOrNull(value.received_at_ms, 0),
  };
}

export function normalizeConfigCommandStatus(value: unknown): ConfigCommandStatus | null {
  if (!isObject(value)) return null;
  const commandId = commandIdOrNull(value.command_id);
  if (!commandId || !oneOfValues(CONFIG_COMMAND_STATES, value.state)) return null;
  return {
    commandId,
    state: value.state,
    // The state decides; a final flag that disagrees with it is ignored.
    final: FINAL_COMMAND_STATES.has(value.state),
    nowMs: finiteOrNull(value.now_ms),
    issuedTsMs: integerOrNull(value.issued_ts_ms, 0),
    expiresTsMs: integerOrNull(value.expires_ts_ms, 0),
    baseConfigRev: integerOrNull(value.base_config_rev, 0),
    changes: patchChanges(value.changes),
    pubackReason: integerOrNull(value.puback_reason, 0),
    echoed: value.echoed === true,
    monitorRestarted: value.monitor_restarted === true,
    ack: normalizeAck(value.ack),
  };
}

/**
 * Status of one published config patch, or with no id the latest one the
 * console published (null when there is none), so a reload can resume.
 */
export async function getConfigPatchStatus(commandId?: string, signal?: AbortSignal): Promise<ConfigCommandStatus | null> {
  if (commandId !== undefined && !COMMAND_ID_RE.test(commandId)) throw new Error('invalid command id');
  const path = commandId === undefined ? '/api/mqtt/config-patch' : `/api/mqtt/config-patch/${encodeURIComponent(commandId)}`;
  const body = await requestJson<unknown>(path, {
    cache: 'no-store',
    credentials: 'same-origin',
  }, signal);
  if (commandId === undefined) {
    if (!isObject(body)) throw new Error('config-patch status response has an invalid shape');
    return body.command === null || body.command === undefined ? null : normalizeConfigCommandStatus(body.command);
  }
  const status = normalizeConfigCommandStatus(body);
  if (!status || status.commandId !== commandId) throw new Error('config-patch status response has an invalid shape');
  return status;
}
