import { ApiError } from '../api';
import type { MessageKey } from './i18n';
import { REFRESH_INTERVALS_S } from './telemetry';

/** Mirrors the collector's DEFAULT_DOA_MAX_AGE_MS (5000 ms). */
export const DOA_FRESHNESS_WINDOW_S = 5;

export type FormResult<T> = { ok: true; value: T } | { ok: false; error: MessageKey; vars?: Record<string, string | number> };

export interface ConnectionDraft {
  base_url: string;
  mqtt_host: string;
  mqtt_port: string;
  refresh_seconds: number;
}

export interface ConnectionValues {
  base_url: string;
  mqtt_host: string;
  mqtt_port: number;
  refresh_seconds: number;
}

/**
 * Apply the same normalization the server applies before saving (trimmed
 * values, no trailing slash, integer port), so the read-back comparison sees
 * the values the operator meant instead of reporting a false mismatch.
 */
export function normalizeConnectionDraft(draft: ConnectionDraft, intervals: readonly number[] = REFRESH_INTERVALS_S): FormResult<ConnectionValues> {
  const baseUrl = draft.base_url.trim().replace(/\/+$/u, '');
  if (!baseUrl) return { ok: false, error: 'config.baseUrlRequired' };
  const port = draft.mqtt_port.trim();
  if (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535) return { ok: false, error: 'config.mqttPortInvalid' };
  if (!Number.isInteger(draft.refresh_seconds) || !intervals.includes(draft.refresh_seconds)) return { ok: false, error: 'config.refreshInvalid' };
  return {
    ok: true,
    value: { base_url: baseUrl, mqtt_host: draft.mqtt_host.trim(), mqtt_port: Number(port), refresh_seconds: draft.refresh_seconds },
  };
}

/**
 * Carry a new saved configuration into the form draft one field at a time:
 * only the fields whose saved value changed are replaced, so a save made
 * elsewhere (the top-bar interval select) keeps the operator's unsaved edits.
 */
export function mergeSavedConfigIntoDraft<T extends object>(draft: T, previous: T, next: T): T {
  const merged = { ...draft };
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof T>) {
    if (!Object.is(previous[key], next[key])) merged[key] = next[key];
  }
  return merged;
}

/** Intervals to offer: the server's list when it sent one, always including the saved value. */
export function refreshIntervalOptions(serverIntervals: readonly number[] | null, current: number): number[] {
  const base = serverIntervals && serverIntervals.length ? serverIntervals : REFRESH_INTERVALS_S;
  const options = new Set(base);
  if (Number.isInteger(current) && current >= 0) options.add(current);
  return [...options].sort((a, b) => a - b);
}

/**
 * Warning for an interval that leaves the DoA display cleared between reads.
 * The window runs from the data's age at the read, never from 0, so an
 * interval equal to the window already leaves a gap every cycle.
 */
export function refreshWarningKey(seconds: number): MessageKey | null {
  if (seconds === 0) return 'config.refreshManualWarning';
  return seconds >= DOA_FRESHNESS_WINDOW_S ? 'config.refreshSlowWarning' : null;
}

function parsedNumber(input: string): number | null {
  const text = input.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Message for invalid manual GPS input. lib/map.ts decides acceptance; this
 * only names which check failed in the UI language.
 */
export function gpsInputErrorKey(latitudeInput: string, longitudeInput: string): MessageKey | null {
  const latitude = parsedNumber(latitudeInput);
  if (latitude === null) return 'config.gpsLatNumber';
  if (latitude < -90 || latitude > 90) return 'config.gpsLatRange';
  const longitude = parsedNumber(longitudeInput);
  if (longitude === null) return 'config.gpsLonNumber';
  if (longitude < -180 || longitude > 180) return 'config.gpsLonRange';
  if (latitude === 0 && longitude === 0) return 'config.gpsZero';
  return null;
}

/** base_config_rev is required by the sdr/v1 config_patch contract. */
export function parseBaseRevision(input: string): FormResult<number> {
  const text = input.trim();
  if (!text) return { ok: false, error: 'config.baseRevisionRequired' };
  if (!/^\d{1,15}$/u.test(text)) return { ok: false, error: 'config.baseRevisionInvalid' };
  return { ok: true, value: Number(text) };
}

export function parseDryRunChanges(
  values: Record<string, string>,
  fields: ReadonlyArray<{ key: string; label: MessageKey }>,
): FormResult<Record<string, number>> {
  const changes: Record<string, number> = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (raw === undefined || raw.trim() === '') continue;
    const value = parsedNumber(raw);
    if (value === null) return { ok: false, error: 'config.dryRunNotNumber', vars: { field: field.key } };
    changes[field.key] = value;
  }
  if (!Object.keys(changes).length) return { ok: false, error: 'config.dryRunEmpty' };
  return { ok: true, value: changes };
}

const ADMIN_ERROR_KEYS: Record<string, MessageKey> = {
  ADMIN_DISABLED: 'config.adminDisabled',
  ADMIN_PASSWORD_INVALID: 'config.adminPasswordInvalid',
  ADMIN_LOGIN_THROTTLED: 'config.adminThrottled',
};

/** Translate an admin API failure by its server error code, when it has one. */
export function adminErrorKey(error: unknown): MessageKey | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code && Object.prototype.hasOwnProperty.call(ADMIN_ERROR_KEYS, error.code)) return ADMIN_ERROR_KEYS[error.code];
  if (error.status === 429) return 'config.adminThrottled';
  if (error.status === 503) return 'config.adminDisabled';
  if (error.status === 401) return 'config.adminRequired';
  return null;
}
