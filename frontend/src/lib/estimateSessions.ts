import type { EstimateSample } from './estimateEngine';
import type { PositionEstimateState } from './positionEstimate';

/**
 * The recorded position-estimate sessions on the console
 * (tools/estimate_record_store.py, GET only, also in the LAN view): the list,
 * one session's rays for the replay, and the CSV and Google Earth (KML) exports.
 */
export const ESTIMATE_SESSIONS_ROUTE = '/api/position-estimate/sessions';
const SESSION_ID = /^[0-9a-f]{32}$/u;

export interface EstimateSessionSummary {
  id: string;
  startedMs: number;
  lastMs: number;
  frequencyHz: number | null;
  samples: number;
  unverified: number;
  state: PositionEstimateState | null;
  radiusM: number | null;
  stations: number | null;
}

export interface EstimateSessionList {
  available: boolean;
  sessions: EstimateSessionSummary[];
  /** The session the console records into now, or null. */
  currentId: string | null;
}

export interface EstimateSession extends EstimateSessionSummary {
  rays: EstimateSample[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function state(value: unknown): PositionEstimateState | null {
  return value === 'NO_DATA' || value === 'NEED_MOVEMENT' || value === 'ROUGH' || value === 'ESTIMATE' ? value : null;
}

function summary(value: unknown): EstimateSessionSummary | null {
  const row = record(value);
  if (!row || typeof row.id !== 'string' || !SESSION_ID.test(row.id)) return null;
  const startedMs = finite(row.started_ms);
  const lastMs = finite(row.last_ms);
  if (startedMs === null || lastMs === null) return null;
  const estimate = record(row.estimate) ?? {};
  return {
    id: row.id,
    startedMs,
    lastMs,
    frequencyHz: finite(row.frequency_hz),
    samples: finite(row.samples) ?? 0,
    unverified: finite(row.unverified) ?? 0,
    state: state(estimate.state),
    radiusM: finite(estimate.radius_m),
    stations: finite(estimate.stations),
  };
}

export function parseSessionList(value: unknown): EstimateSessionList {
  const body = record(value);
  const sessions = Array.isArray(body?.sessions) ? body.sessions.map(summary).filter((row): row is EstimateSessionSummary => row !== null) : [];
  const currentId = typeof body?.current_id === 'string' && SESSION_ID.test(body.current_id) ? body.current_id : null;
  return { available: body?.available === true, sessions, currentId };
}

/** One session; rows that are not [t_ms, lat, lon, bearing, verified, frequency] are left out. */
export function parseSession(value: unknown): EstimateSession | null {
  const head = summary(value);
  const body = record(value);
  if (!head || !body) return null;
  const rays: EstimateSample[] = [];
  if (Array.isArray(body.samples)) {
    for (const row of body.samples) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const [tMs, latitude, longitude, bearingDeg, verified, frequencyHz] = row.map(finite);
      if (tMs === null || latitude === null || longitude === null || bearingDeg === null || frequencyHz === null) continue;
      if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || (verified !== 0 && verified !== 1)) continue;
      rays.push({ tMs, latitude, longitude, bearingDeg, verified: verified === 1, frequencyHz });
    }
  }
  return { ...head, rays };
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) {
    let code = `HTTP_${response.status}`;
    try {
      const value = record(await response.json())?.code;
      if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value)) code = value;
    } catch {
      // An answer without JSON keeps only its status.
    }
    throw new Error(code);
  }
  return response.json();
}

export async function fetchEstimateSessions(signal?: AbortSignal): Promise<EstimateSessionList> {
  return parseSessionList(await getJson(ESTIMATE_SESSIONS_ROUTE, signal));
}

export async function fetchEstimateSession(id: string, signal?: AbortSignal): Promise<EstimateSession> {
  if (!SESSION_ID.test(id)) throw new Error('ESTIMATE_SESSION_NOT_FOUND');
  const session = parseSession(await getJson(`${ESTIMATE_SESSIONS_ROUTE}/${id}`, signal));
  if (!session) throw new Error('INVALID_ANSWER');
  return session;
}

export function estimateExportUrl(id: string, kind: 'csv' | 'kml'): string {
  return `${ESTIMATE_SESSIONS_ROUTE}/${id}/export.${kind}`;
}
