import type {
  Candidate,
  DataState,
  Freshness,
  NativeConsistency,
  TelemetrySnapshot,
  Tone,
} from '../types';
import { isMqttSnapshot, mqttDoaUnverified } from './telemetrySource';

export const DEFAULT_CONSOLE_CONFIG = {
  base_url: 'http://doasdr.local:8081',
  mqtt_host: '10.90.0.1',
  mqtt_port: 9001,
  // Same as the server default for a fresh install; 0 means manual refresh.
  refresh_seconds: 2,
};

/** Refresh intervals accepted by /api/console-config, in seconds (0 = manual). */
export const REFRESH_INTERVALS_S: readonly number[] = [0, 1, 2, 5, 10, 30];

export type CandidateName = 'csv' | 'xml' | 'mqtt';

export function candidate(snapshot: TelemetrySnapshot | null | undefined, name: CandidateName): Candidate {
  return snapshot?.doa_candidates?.[name] ?? {};
}

/**
 * The DoA views the answer's source carries: the CSV and XML views of Data
 * Out, or the one MQTT view (issue #8; telemetrySource.ts).
 */
export function sourceViewNames(snapshot: TelemetrySnapshot | null | undefined): CandidateName[] {
  return isMqttSnapshot(snapshot) ? ['mqtt'] : ['csv', 'xml'];
}

/**
 * The view that carries the angle, the 360-bin vector and the VFO frequency:
 * the CSV view of Data Out, or the MQTT view.
 */
export function primaryCandidate(snapshot: TelemetrySnapshot | null | undefined): Candidate {
  return candidate(snapshot, isMqttSnapshot(snapshot) ? 'mqtt' : 'csv');
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function formatNumber(value: unknown, digits = 1): string {
  const number = numberOrNull(value);
  return number === null ? 'N/A' : number.toFixed(digits);
}

/**
 * A view that parsed with a usable canonical angle. A quarantined view keeps
 * available=true but carries normalization_error and no angle.
 */
export function parsedCandidate(value: Candidate | undefined): boolean {
  return value?.available === true
    && !Object.prototype.hasOwnProperty.call(value, 'normalization_error')
    && numberOrNull(value.canonical_angle_deg) !== null;
}

export function freshCandidate(value: Candidate | undefined): boolean {
  const age = value?.freshness?.age_ms;
  return parsedCandidate(value)
    && value?.freshness?.fresh === true
    && typeof age === 'number'
    && Number.isFinite(age)
    && age >= 0;
}

export function completeVector(value: Candidate | undefined): value is Candidate & { angular_power_db: number[] } {
  return Array.isArray(value?.angular_power_db)
    && value.angular_power_db.length === 360
    && value.angular_power_db.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

/**
 * The DoA views are fresh and agree. Data Out: a fresh, comparable pair of
 * CSV and XML views without a conflict. MQTT: a fresh LIVE DoA whose Angular
 * frame does not contradict it (the server checks a same-frame pair).
 */
export function nativeViewsReady(snapshot: TelemetrySnapshot | null | undefined): boolean {
  if (isMqttSnapshot(snapshot)) {
    return freshCandidate(candidate(snapshot, 'mqtt')) && snapshot?.native_consistency?.conflict !== true;
  }
  const csv = candidate(snapshot, 'csv');
  const xml = candidate(snapshot, 'xml');
  const consistency = snapshot?.native_consistency;
  return freshCandidate(csv)
    && freshCandidate(xml)
    && consistency?.comparable === true
    && consistency.conflict !== true;
}

/** The views are ready and carry the 360-bin vector the polar curve and the map overlay draw. */
export function polarDataReady(snapshot: TelemetrySnapshot | null | undefined): boolean {
  return nativeViewsReady(snapshot) && completeVector(primaryCandidate(snapshot));
}

/**
 * A Data Out answer whose doa.xml view is missing while the CSV view is fresh
 * with its 360-bin vector. The CSV view alone carries the angle and the curve,
 * so it is drawn, labelled as partial: nothing cross-checks it against XML.
 */
export function partialCsvReady(snapshot: TelemetrySnapshot | null | undefined): boolean {
  if (!snapshot || isMqttSnapshot(snapshot)) return false;
  const csv = candidate(snapshot, 'csv');
  return candidate(snapshot, 'xml').available !== true
    && freshCandidate(csv)
    && completeVector(csv)
    && snapshot.native_consistency?.conflict !== true;
}

/** The curve may be drawn: both views ready, or the CSV view alone (partialCsvReady). */
export function curveDataReady(snapshot: TelemetrySnapshot | null | undefined): boolean {
  return polarDataReady(snapshot) || partialCsvReady(snapshot);
}

/**
 * The DoA (theta_0 and the bearing) may be drawn. Data Out needs the curve
 * too. A LIVE MQTT DoA is a detection by itself, as for the edge's own
 * Ground: the edge sends its Angular frame far less often than the DoA
 * (about every 9 s, none for 20 s after a command or reconnect, none in
 * profile control), so between frames the bearing is shown without a curve.
 */
export function doaDataReady(snapshot: TelemetrySnapshot | null | undefined): boolean {
  return isMqttSnapshot(snapshot) ? nativeViewsReady(snapshot) : curveDataReady(snapshot);
}

/**
 * DAQ sync state of a readable status record, or null when there is none to
 * judge. A record without daq_health counts as UNKNOWN, as it does for the
 * collector's gate: the collector always reports it.
 */
export function daqSyncState(snapshot: TelemetrySnapshot | null | undefined): 'PASS' | 'FAIL' | 'UNKNOWN' | null {
  if (snapshot?.status?.available !== true) return null;
  const health = snapshot.status.daq_health;
  if (health === 'PASS') return 'PASS';
  if (typeof health !== 'string' || health.trim() === '' || health === 'UNKNOWN') return 'UNKNOWN';
  return 'FAIL';
}

/** The node reported failed DAQ synchronization. */
export function daqFailed(snapshot: TelemetrySnapshot | null | undefined): boolean {
  return daqSyncState(snapshot) === 'FAIL';
}

/** The node's DAQ sync state is unknown: some sync flags or daq_health are missing. */
export function daqUnknown(snapshot: TelemetrySnapshot | null | undefined): boolean {
  return daqSyncState(snapshot) === 'UNKNOWN';
}

export function adcOverdriven(snapshot: TelemetrySnapshot | null | undefined): boolean {
  return snapshot?.publication_gate?.checks?.adc_not_overdriven === false;
}

/**
 * An MQTT answer without a current light Data Out read: MQTT never carries
 * the ADC overdrive and the edge's ok=1 does not weigh it, so the console
 * cannot rule it out (ADC_OVERDRIVE_UNKNOWN). A Data Out answer reads it on
 * every collection.
 */
export function adcOverdriveUnknown(snapshot: TelemetrySnapshot | null | undefined): boolean {
  const check = snapshot?.publication_gate?.checks?.adc_not_overdriven;
  // Data Out says so with null: neither status.json nor doa.xml reported it.
  return isMqttSnapshot(snapshot) ? typeof check !== 'boolean' : snapshot?.status?.available === true && check === null;
}

/** The collector saw the node's status timestamp, uptime or frame index stop advancing. */
export function nodeStalled(snapshot: TelemetrySnapshot | null | undefined): boolean {
  if (!snapshot) return false;
  const progress = snapshot.node_progress;
  if (progress !== null && typeof progress === 'object' && progress.stalled === true) return true;
  return sourceViewNames(snapshot).some((name) => candidate(snapshot, name).freshness?.node_stalled === true);
}

/** Error text of each DoA view that could not be used, e.g. 'XML: HTTP 404', bounded for a tooltip. */
export function candidateErrors(snapshot: TelemetrySnapshot | null | undefined): string[] {
  const errors: string[] = [];
  for (const name of sourceViewNames(snapshot)) {
    const view = candidate(snapshot, name);
    const detail = view.available === true ? view.normalization_error_detail : view.error;
    if (!parsedCandidate(view) && typeof detail === 'string' && detail.trim()) {
      errors.push(`${name.toUpperCase()}: ${detail.trim().slice(0, 160)}`);
    }
  }
  return errors;
}

/** Every DoA view failed at the read itself (transport, HTTP status, deadline), not at parsing. */
function doaReadsFailed(snapshot: TelemetrySnapshot): boolean {
  const resources = snapshot.resources;
  if (!resources || typeof resources !== 'object') return false;
  return ['/DOA_value.html', '/doa.xml'].every((path) => {
    const resource = resources[path];
    return resource !== null && typeof resource === 'object' && resource.ok === false;
  });
}

/**
 * Classify a snapshot in the collector's overall_state order, so a broken or
 * unreachable source is never shown as old data. STALE is used only when the
 * snapshot itself says the DoA output is old, or when an otherwise usable
 * snapshot has outlived its local freshness window.
 */
export function deriveDataState(snapshot: TelemetrySnapshot | null | undefined, error = false, localFresh = true): DataState {
  if (error) return 'ERROR';
  if (!snapshot) return 'LOADING';
  if (snapshot.status?.available !== true) return 'UNAVAILABLE';
  if (daqSyncState(snapshot) !== 'PASS' || adcOverdriven(snapshot)) return 'DEGRADED';
  const views = sourceViewNames(snapshot).map((name) => candidate(snapshot, name));
  const parsed = views.filter(parsedCandidate);
  if (parsed.length === 0 && isMqttSnapshot(snapshot)) {
    // MQTT carries data but no LIVE DoA with a known angle: an angle mode the
    // console cannot map, an UNVERIFIED DoA (the DoA chip says so), or none.
    if (views[0].available === true) return 'INCOMPLETE';
    if (mqttDoaUnverified(snapshot)) return localFresh ? 'AVAILABLE' : 'STALE';
    return 'STALE';
  }
  if (parsed.length === 0) return doaReadsFailed(snapshot) ? 'UNAVAILABLE' : 'INVALID';
  if (snapshot.native_consistency?.conflict === true) return 'CONFLICT';
  if (nodeStalled(snapshot) || !parsed.some(freshCandidate)) return 'STALE';
  if (!nativeViewsReady(snapshot)) return 'INCOMPLETE';
  return localFresh ? 'AVAILABLE' : 'STALE';
}

export function toneFor(value: unknown): Tone {
  const normalized = String(value ?? '').toUpperCase();
  if (['LIVE', 'PASS', 'READY', 'CONNECTED', 'AVAILABLE', 'VERIFIED', 'GOOD', 'CURRENT'].includes(normalized)) return 'good';
  if (['DEGRADED', 'STALE', 'CONFLICT', 'BLOCKED', 'FAIL', 'ERROR', 'UNAVAILABLE', 'INVALID', 'STALLED', 'OVERDRIVE'].includes(normalized)) return 'bad';
  if (['WAITING', 'UNKNOWN', 'NOT CONFIGURED', 'NOT_READY', 'DISCONNECTED', 'OFF', 'INCOMPLETE', 'SIMULATION'].includes(normalized)) return 'warn';
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
    { label: 'DELIVERY', detail: `${String(gate.state ?? 'BLOCKED').toUpperCase()} · the bearing is never published` },
    ...reasons.map((reason) => ({ label: 'GATE', detail: reasonLabel(reason) })),
  ];
}
