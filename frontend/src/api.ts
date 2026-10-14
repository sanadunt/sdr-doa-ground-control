import type { Branding, ConsoleConfig, MqttSnapshot, MqttTarget, RdfNodeSnapshot, TelemetrySnapshot } from './types';
import { isMqttTransport, isMqttWsPath, normalizeMqttSnapshot, normalizeRdfNodeSnapshot } from './lib/mqttMonitor';

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

  constructor(message: string, status: number, code: string | null, serverMessage = true) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.serverMessage = serverMessage;
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
  return new ApiError(detail, status, code, serverMessage);
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
  return config;
}

function sameConfigValues(left: ConsoleConfig, right: ConsoleConfig): boolean {
  return left.base_url === right.base_url
    && left.mqtt_host === right.mqtt_host
    && left.mqtt_port === right.mqtt_port
    && left.refresh_seconds === right.refresh_seconds
    && (left.mqtt_transport === undefined || left.mqtt_transport === right.mqtt_transport)
    && (left.mqtt_ws_path === undefined || left.mqtt_ws_path === right.mqtt_ws_path)
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

export async function getSnapshot(baseUrl: string, signal?: AbortSignal): Promise<TelemetrySnapshot> {
  const url = `/api/snapshot?base_url=${encodeURIComponent(baseUrl)}`;
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

export interface ConsoleCapabilities {
  /** Refresh intervals the server accepts, in seconds (0 = manual), or null when not reported. */
  refreshIntervalsS: number[] | null;
  /** Whether admin login is configured on the server, or null when not reported. */
  adminEnabled: boolean | null;
}

export function normalizeCapabilities(value: unknown): ConsoleCapabilities {
  const record = isObject(value) ? value : {};
  const intervals = Array.isArray(record.refresh_intervals_s)
    ? record.refresh_intervals_s.filter((entry): entry is number => typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry <= 3600).slice(0, 16)
    : [];
  return {
    refreshIntervalsS: intervals.length ? [...new Set(intervals)].sort((a, b) => a - b) : null,
    adminEnabled: typeof record.admin_enabled === 'boolean' ? record.admin_enabled : null,
  };
}

export async function getCapabilities(signal?: AbortSignal): Promise<ConsoleCapabilities> {
  const body = await requestJson<unknown>('/api/capabilities', {
    cache: 'no-store',
    credentials: 'same-origin',
  }, signal);
  return normalizeCapabilities(body);
}
