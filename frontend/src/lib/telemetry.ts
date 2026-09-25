import type {
  Candidate,
  DataState,
  Freshness,
  MqttEntry,
  NativeConsistency,
  TelemetrySnapshot,
  Tone,
} from '../types';

export const DEFAULT_CONSOLE_CONFIG = {
  base_url: 'http://doasdr.local:8081',
  mqtt_host: '',
  mqtt_port: 1883,
  refresh_seconds: 0,
};

export function candidate(snapshot: TelemetrySnapshot | null | undefined, name: 'csv' | 'xml'): Candidate {
  return snapshot?.doa_candidates?.[name] ?? {};
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function formatNumber(value: unknown, digits = 1): string {
  const number = numberOrNull(value);
  return number === null ? 'N/A' : number.toFixed(digits);
}

export function formatAge(freshness: Freshness | null | undefined): string {
  if (!freshness) return 'clock unverified';
  if (freshness.age_ms === null || freshness.age_ms === undefined || typeof freshness.age_ms !== 'number' || !Number.isFinite(freshness.age_ms) || freshness.age_ms < 0) {
    return 'clock unverified';
  }
  return `${(freshness.age_ms / 1000).toFixed(1)} s`;
}

export function freshCandidate(value: Candidate | undefined): boolean {
  const age = value?.freshness?.age_ms;
  return value?.available === true
    && value.freshness?.fresh === true
    && typeof age === 'number'
    && Number.isFinite(age)
    && age >= 0;
}

export function completeVector(value: Candidate | undefined): value is Candidate & { angular_power_db: number[] } {
  return Array.isArray(value?.angular_power_db)
    && value.angular_power_db.length === 360
    && value.angular_power_db.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

export function nativeViewsReady(snapshot: TelemetrySnapshot | null | undefined): boolean {
  const csv = candidate(snapshot, 'csv');
  const xml = candidate(snapshot, 'xml');
  const consistency = snapshot?.native_consistency;
  return freshCandidate(csv)
    && freshCandidate(xml)
    && consistency?.comparable === true
    && consistency.conflict !== true;
}

export function polarDataReady(snapshot: TelemetrySnapshot | null | undefined): boolean {
  const csv = candidate(snapshot, 'csv');
  return nativeViewsReady(snapshot) && completeVector(csv);
}

export function deriveDataState(snapshot: TelemetrySnapshot | null | undefined, error = false): DataState {
  if (error) return 'ERROR';
  if (!snapshot) return 'LOADING';
  if (snapshot.native_consistency?.conflict === true) return 'CONFLICT';
  if (snapshot.status?.available !== true) return 'UNAVAILABLE';
  if (snapshot.status?.daq_health && snapshot.status.daq_health !== 'PASS') return 'DEGRADED';
  if (!nativeViewsReady(snapshot)) return 'STALE';
  return 'AVAILABLE';
}

export function toneFor(value: unknown): Tone {
  const normalized = String(value ?? '').toUpperCase();
  if (['LIVE', 'PASS', 'READY', 'CONNECTED', 'AVAILABLE', 'VERIFIED', 'GOOD'].includes(normalized)) return 'good';
  if (['DEGRADED', 'STALE', 'CONFLICT', 'BLOCKED', 'FAIL', 'ERROR', 'UNAVAILABLE', 'INVALID'].includes(normalized)) return 'bad';
  if (['WAITING', 'UNKNOWN', 'NOT CONFIGURED', 'NOT_READY', 'DISCONNECTED', 'OFF'].includes(normalized)) return 'warn';
  return 'neutral';
}

export function boolLabel(value: unknown): string {
  return value === true ? 'yes' : value === false ? 'no' : 'N/A';
}

export const GATE_REASON_LABELS: Record<string, string> = {
  GROUND_CLOCK_UNVERIFIED: 'Ground and node clocks are not verified',
  CANONICAL_ANGLE_NOT_CONFIGURED: 'Canonical angle convention is not approved',
  DOA_AUTHORITY_NOT_SELECTED: 'DoA authority source is not selected',
  SELECTED_UNITS_NOT_READY: 'Selected source unit contract is not ready',
  CONFIDENCE_MAPPING_UNVERIFIED: 'Native PAPR is not mapped to confidence 0–1',
  POWER_MAPPING_UNVERIFIED: 'Native power is not calibrated to power_db contract',
  POWER_FLOOR_LOSSY: 'XML power is at floor and information is lossy',
  NATIVE_DOA_VIEWS_CONFLICT: 'CSV and XML views differ after canonicalization',
  DAQ_HEALTH_GATE_FAILED: 'DAQ or frame synchronization gate failed',
  DOA_CANDIDATES_STALE: 'DoA output is older than the freshness window',
  STATUS_UNAVAILABLE_OR_INVALID: 'Node status is unavailable or invalid',
  NO_VALID_DOA_CANDIDATE: 'No valid DoA candidate was parsed',
  STATUS_STALE: 'Node status is older than the freshness window',
  SELECTED_AUTHORITY_UNAVAILABLE: 'Selected authority source is unavailable',
  SELECTED_DOA_STALE: 'Selected DoA source is stale',
};

export function reasonLabel(reason: string): string {
  return GATE_REASON_LABELS[reason] ?? reason;
}

export function safeJson(value: unknown, fallback = 'N/A'): string {
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
}

export function redactIdentifier(value: unknown): string {
  return value === undefined || value === null || String(value).trim() === '' ? 'N/A' : '[REDACTED]';
}

export function displaySourceTimestamp(freshness: Freshness | null | undefined): string {
  if (!freshness || typeof freshness.timestamp_ms !== 'number') return 'N/A';
  return new Date(freshness.timestamp_ms).toISOString();
}

export function consistencyRelation(consistency: NativeConsistency | undefined): string {
  if (!consistency?.comparable) return 'NOT COMPARABLE';
  if (consistency.conflict) return 'CONFLICT';
  const distance = numberOrNull(consistency.circular_distance_deg);
  if (distance !== null && distance <= 3) return 'EQUAL';
  return 'DIFFERENT';
}

export function syncCount(snapshot: TelemetrySnapshot | null | undefined): number {
  const daq = snapshot?.status?.safe?.daq_status;
  if (!daq || typeof daq !== 'object') return 0;
  return ['frame_sync', 'sample_delay_sync', 'iq_sync']
    .filter((key) => (daq as Record<string, unknown>)[key] === true).length;
}

export function eventItems(snapshot: TelemetrySnapshot | null | undefined): Array<{ label: string; detail: string }> {
  if (!snapshot) return [{ label: 'SNAPSHOT', detail: 'Awaiting first Data Out read.' }];
  const gate = snapshot.publication_gate ?? {};
  const relation = consistencyRelation(snapshot.native_consistency);
  const overall = snapshot.overall_state ?? 'UNKNOWN';
  const reasons = (gate.reasons ?? []).slice(0, 4);
  return [
    { label: 'SNAPSHOT', detail: `${overall} · Data Out read complete` },
    { label: 'DOA VIEWS', detail: `${relation} · CSV / XML remain separate` },
    { label: 'DELIVERY', detail: `${String(gate.state ?? 'BLOCKED').toUpperCase()} · publish path disabled` },
    ...reasons.map((reason) => ({ label: 'GATE', detail: reasonLabel(reason) })),
  ];
}

function sanitizePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 24).map(sanitizePayload);
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' && value.length > 180 ? `${value.slice(0, 177)}…` : value;
  }
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (/(pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential)/i.test(key)) {
      output[key] = '[REDACTED]';
    } else if (/(station|unit|hardware|serial|client|device|host|topic|id)$/i.test(key)) {
      output[key] = '[REDACTED]';
    } else {
      output[key] = sanitizePayload(entry);
    }
  }
  return output;
}

export function safeMqttEntries(entries: Record<string, MqttEntry> | undefined): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [kind, entry] of Object.entries(entries ?? {})) {
    output[kind] = {
      kind: entry.kind ?? kind,
      bytes: entry.bytes ?? 0,
      qos: entry.qos ?? 0,
      retained: entry.retained ?? false,
      valid: entry.valid ?? false,
      latency_ms: entry.latency_ms ?? null,
      error: entry.error,
      payload: sanitizePayload(entry.payload),
    };
  }
  return output;
}
