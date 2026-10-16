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

/** A coordinate as the form shows it: at most 6 decimals (about 0.1 m), no trailing zeros. */
export function coordinateText(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toFixed(6))) : '';
}

/** Which manual GPS field a gpsInputErrorKey message belongs to. */
export function gpsErrorField(key: MessageKey): 'lat' | 'lon' {
  return key === 'config.gpsLonNumber' || key === 'config.gpsLonRange' ? 'lon' : 'lat';
}

/**
 * True for a host that stays on this machine: localhost, 127.0.0.0/8 or ::1
 * (also in brackets). The no-TLS warning shows only for other hosts.
 */
export function isLoopbackHost(input: string): boolean {
  const host = input.trim().toLowerCase().replace(/^\[(.*)\]$/u, '$1');
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  return Boolean(octets && Number(octets[1]) === 127 && octets.slice(2).every((part) => Number(part) <= 255));
}

/**
 * Whether the index treats the page as scrolled to its end. A page that fits
 * the viewport has no end to reach: it counts as one only while a section was
 * jumped to (`jumped`), so that section keeps its mark when the window is
 * resized; otherwise the index marks the section at the top.
 */
export function atPageBottom(viewportHeight: number, scrollY: number, scrollHeight: number, jumped = false): boolean {
  if (scrollHeight <= viewportHeight + 2) return jumped;
  return viewportHeight + scrollY >= scrollHeight - 2;
}

/**
 * The section index entry to mark as current. `sections` are in page order
 * with their top edge relative to the viewport; a section is reached once its
 * top is at or above `threshold` (where a jump puts it). Sections in one grid
 * row share a top: the earlier one wins unless `preferred` (the last one
 * jumped to) is among them. At the bottom of the page the sections below the
 * threshold can never reach it, so the preferred one, when it is not above
 * the reached row, or else the last section counts as current.
 */
export function activeSection(
  sections: ReadonlyArray<{ id: string; top: number }>,
  threshold: number,
  atBottom: boolean,
  preferred: string | null = null,
): string | null {
  if (!sections.length) return null;
  let current = sections[0].id;
  let currentTop = Number.NEGATIVE_INFINITY;
  for (const section of sections) {
    if (section.top > threshold + 1) continue;
    if (section.top > currentTop + 1) {
      current = section.id;
      currentTop = section.top;
    } else if (Math.abs(section.top - currentTop) <= 1 && section.id === preferred) {
      current = section.id;
    }
  }
  if (atBottom) {
    const target = sections.find((section) => section.id === preferred);
    if (target && target.top >= currentTop - 1) return target.id;
    return sections[sections.length - 1].id;
  }
  return current;
}

export interface DryRunSummary {
  validation: string | null;
  transport: string | null;
  baseConfigRev: number | null;
  /** Normalized changes in the order the server returned them. */
  changes: Array<{ key: string; value: number }>;
  ttlMs: number | null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function shortText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
}

/** The parts of a dry-run response the result grid shows; anything malformed is left out. */
export function summarizeDryRun(result: Record<string, unknown>): DryRunSummary {
  const command = recordOrNull(result.command);
  const changes = recordOrNull(command?.changes);
  const issued = command?.issued_ts_ms;
  const expires = command?.expires_ts_ms;
  const rev = command?.base_config_rev;
  return {
    validation: shortText(result.validation),
    transport: shortText(result.transport),
    baseConfigRev: typeof rev === 'number' && Number.isInteger(rev) && rev >= 0 ? rev : null,
    changes: changes
      ? Object.entries(changes)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
        .map(([key, value]) => ({ key, value }))
      : [],
    ttlMs: typeof issued === 'number' && typeof expires === 'number' && Number.isFinite(issued) && Number.isFinite(expires) && expires > issued ? expires - issued : null,
  };
}

/** SI unit of a config patch key on the wire (…_hz, …_db). */
export function patchKeyUnit(key: string): 'Hz' | 'dB' | '' {
  if (key.endsWith('_hz')) return 'Hz';
  if (key.endsWith('_db')) return 'dB';
  return '';
}
