import type { Candidate, TelemetrySnapshot, Tone } from '../types';
import type { MessageKey } from './i18n';
import { adcOverdriveUnknown, adcOverdriven, candidate, completeVector, daqFailed, daqUnknown, doaDataReady, freshCandidate, nativeViewsReady, nodeStalled, numberOrNull, parsedCandidate, partialCsvReady, sourceViewNames } from './telemetry';
import { isMqttSnapshot, mqttDoaUnverified } from './telemetrySource';

/** Why the DoA curve and bearing are, or are not, shown. */
export type DoaStatusReason =
  | 'waiting'
  | 'simulation'
  | 'available'
  | 'partial'
  | 'daqDegraded'
  | 'daqUnknown'
  | 'adcOverdrive'
  | 'adcUnknown'
  | 'conflict'
  | 'statusUnavailable'
  | 'viewMissing'
  | 'nodeStalled'
  | 'sourceStale'
  | 'notComparable'
  | 'vectorIncomplete'
  | 'localExpired'
  | 'angleMissing'
  | 'mqttUnverified'
  | 'mqttNoDoa';

export interface DoaStatus {
  /** Untranslated status code for badges. */
  code: 'WAITING' | 'SIMULATION' | 'AVAILABLE' | 'PARTIAL' | 'DEGRADED' | 'CONFLICT' | 'UNAVAILABLE' | 'INCOMPLETE' | 'STALE' | 'UNVERIFIED';
  tone: Tone;
  reason: DoaStatusReason;
  /** The curve and bearing are drawn. */
  shown: boolean;
}

function viewMissing(value: Candidate): boolean {
  return value.available !== true;
}

/**
 * The snapshot carries a fresh, comparable, non-conflicting pair of views with
 * a finite canonical angle and a complete 360-bin vector (an MQTT answer: a
 * fresh LIVE DoA, with or without its Angular vector; doaDataReady), and the
 * local freshness window is still open. This is the data condition only; the
 * DAQ and ADC checks are applied by doaStatus.
 */
export function doaDrawable(snapshot: TelemetrySnapshot | null | undefined, localFresh: boolean): boolean {
  return localFresh && doaDataReady(snapshot);
}

/**
 * Status of the DoA views on Overview, derived from the snapshot itself so the
 * text names the actual cause. `drawable` is whether the renderer has a fresh,
 * complete curve for this snapshot.
 *
 * A live record from a DAQ that is not synchronized or whose sync state is
 * unknown, or from an overdriven ADC, is not shown: the array phases may not
 * be coherent, so a drawn bearing would look meaningful when it is not. An
 * MQTT answer whose overdrive is unknown (no light Data Out read in 65 s) is
 * shown as DEGRADED with that cause.
 */
export function doaStatus(snapshot: TelemetrySnapshot | null | undefined, localFresh: boolean, drawable: boolean): DoaStatus {
  if (!snapshot) return { code: 'WAITING', tone: 'neutral', reason: 'waiting', shown: false };
  if (snapshot.simulation === true) {
    return drawable
      ? { code: 'SIMULATION', tone: 'warn', reason: 'simulation', shown: true }
      : { code: 'SIMULATION', tone: 'warn', reason: 'vectorIncomplete', shown: false };
  }
  const blocked = (code: DoaStatus['code'], reason: DoaStatusReason): DoaStatus => ({ code, tone: 'warn', reason, shown: false });
  if (snapshot.native_consistency?.conflict === true) return blocked('CONFLICT', 'conflict');
  if (snapshot.status?.available !== true) return blocked('UNAVAILABLE', 'statusUnavailable');
  if (daqFailed(snapshot)) return blocked('DEGRADED', 'daqDegraded');
  if (daqUnknown(snapshot)) return blocked('DEGRADED', 'daqUnknown');
  if (adcOverdriven(snapshot)) return blocked('DEGRADED', 'adcOverdrive');
  if (drawable && localFresh) {
    // MQTT stays the source while Data Out is unreachable, so an unknown
    // overdrive does not hide the bearing; it is shown DEGRADED with the cause.
    if (adcOverdriveUnknown(snapshot)) return { code: 'DEGRADED', tone: 'warn', reason: 'adcUnknown', shown: true };
    // Data Out without doa.xml: the CSV view alone, drawn and labelled partial.
    if (partialCsvReady(snapshot)) return { code: 'PARTIAL', tone: 'warn', reason: 'partial', shown: true };
    return { code: 'AVAILABLE', tone: 'good', reason: 'available', shown: true };
  }
  if (isMqttSnapshot(snapshot)) {
    // One view from MQTT: the LIVE DoA (ok=1), shown with or without its
    // Angular frame. An UNVERIFIED DoA (ok=0) is a diagnostic and never shown.
    const view = candidate(snapshot, 'mqtt');
    if (view.available !== true) return mqttDoaUnverified(snapshot) ? blocked('UNVERIFIED', 'mqttUnverified') : blocked('STALE', 'mqttNoDoa');
    if (!parsedCandidate(view)) return blocked('INCOMPLETE', 'angleMissing');
    if (!freshCandidate(view)) return blocked('STALE', 'sourceStale');
    if (!localFresh) return blocked('STALE', 'localExpired');
    return blocked('INCOMPLETE', 'angleMissing');
  }
  const csv = candidate(snapshot, 'csv');
  const xml = candidate(snapshot, 'xml');
  if (viewMissing(csv) || viewMissing(xml)) return blocked('INCOMPLETE', 'viewMissing');
  if (!parsedCandidate(csv) || !parsedCandidate(xml)) return blocked('INCOMPLETE', 'angleMissing');
  if (nodeStalled(snapshot)) return blocked('STALE', 'nodeStalled');
  if (!freshCandidate(csv) || !freshCandidate(xml)) return blocked('STALE', 'sourceStale');
  if (!nativeViewsReady(snapshot)) return blocked('INCOMPLETE', 'notComparable');
  if (!completeVector(csv)) return blocked('INCOMPLETE', 'vectorIncomplete');
  if (!localFresh) return blocked('STALE', 'localExpired');
  return blocked('INCOMPLETE', 'angleMissing');
}

/**
 * The one readiness predicate for Overview: the map overlay (doaReady), the
 * readout bearing and the polar curve all follow `shown`, and the shell DoA
 * chip shows `code`.
 */
export function overviewDoaStatus(snapshot: TelemetrySnapshot | null | undefined, localFresh: boolean): DoaStatus {
  return doaStatus(snapshot, localFresh, doaDrawable(snapshot, localFresh));
}

// Held reasons whose last angle is still worth showing, dimmed and marked NOT
// VALID (BELUM VALID): the record is old, unverified at the edge, or the DAQ
// state is unknown. A conflict, a failed DAQ sync or an overdriven ADC have no
// angle that means anything, so they stay hidden.
const PROVISIONAL_REASONS: ReadonlySet<DoaStatusReason> = new Set<DoaStatusReason>([
  'mqttUnverified',
  'mqttNoDoa',
  'sourceStale',
  'localExpired',
  'nodeStalled',
  'daqUnknown',
  'statusUnavailable',
  'notComparable',
  'vectorIncomplete',
  'viewMissing',
]);

/**
 * theta_0 of a DoA that is not valid but still readable, for the dimmed
 * bearing on the HUD and the dashed grey line on the map; null while the DoA
 * is shown, or when nothing readable is left. MQTT: the LIVE view's angle,
 * else the UNVERIFIED (ok=0) one. Data Out: the CSV view, else XML.
 */
export function provisionalTheta(snapshot: TelemetrySnapshot | null | undefined, status: DoaStatus): number | null {
  if (!snapshot || snapshot.simulation === true || status.shown || !PROVISIONAL_REASONS.has(status.reason)) return null;
  for (const name of sourceViewNames(snapshot)) {
    const view = candidate(snapshot, name);
    if (parsedCandidate(view)) return numberOrNull(view.canonical_angle_deg);
  }
  const unverified = snapshot.mqtt?.doa_unverified;
  return unverified !== null && typeof unverified === 'object'
    ? numberOrNull((unverified as Record<string, unknown>).canonical_angle_deg)
    : null;
}

const STATUS_TEXT: Record<DoaStatusReason, MessageKey> = {
  waiting: 'polar.waiting',
  simulation: 'polar.simulation',
  available: 'polar.available',
  partial: 'polar.partial',
  daqDegraded: 'polar.daqDegraded',
  daqUnknown: 'polar.daqUnknown',
  adcOverdrive: 'polar.adcOverdrive',
  adcUnknown: 'polar.adcUnknown',
  conflict: 'polar.conflict',
  statusUnavailable: 'polar.statusUnavailable',
  viewMissing: 'polar.viewMissing',
  nodeStalled: 'polar.nodeStalled',
  sourceStale: 'polar.sourceStale',
  notComparable: 'polar.notComparable',
  vectorIncomplete: 'polar.vectorIncomplete',
  localExpired: 'polar.expired',
  angleMissing: 'polar.angleMissing',
  mqttUnverified: 'polar.mqttUnverified',
  mqttNoDoa: 'polar.mqttNoDoa',
};

export function doaStatusTextKey(reason: DoaStatusReason): MessageKey {
  return STATUS_TEXT[reason];
}

// Reasons that hold on every console read (the clock is never verified and the
// authority/unit contracts are not configured) go last so the summary shows
// the reason an operator can act on. NATIVE_ANGLE_UNCHECKED comes and goes
// with read timing (CSV and XML from adjacent frames, or an MQTT DoA newer
// than its Angular frame) and needs no action, and so does
// MQTT_ANGULAR_UNAVAILABLE (an MQTT DoA between Angular frames, shown
// without its curve).
const STANDING_GATE_REASONS = [
  'POWER_FLOOR_LOSSY',
  'POWER_MAPPING_UNVERIFIED',
  'CONFIDENCE_MAPPING_UNVERIFIED',
  'SELECTED_UNITS_NOT_READY',
  'DOA_AUTHORITY_NOT_SELECTED',
  'CANONICAL_ANGLE_NOT_CONFIGURED',
  'GROUND_CLOCK_UNVERIFIED',
  'NATIVE_ANGLE_UNCHECKED',
  'MQTT_ANGULAR_UNAVAILABLE',
];

const ACTIONABLE_GATE_REASONS = [
  'SIMULATION_ONLY',
  'STATUS_UNAVAILABLE_OR_INVALID',
  'NODE_CLOCK_STALLED',
  'NATIVE_DOA_VIEWS_CONFLICT',
  'MQTT_DOA_ANGULAR_CONFLICT',
  'DAQ_HEALTH_GATE_FAILED',
  'ADC_OVERDRIVE',
  'ADC_OVERDRIVE_UNKNOWN',
  'DAQ_HEALTH_UNKNOWN',
  'COLLECTION_DEADLINE_EXCEEDED',
  'NO_VALID_DOA_CANDIDATE',
  'MQTT_NO_DOA',
  'MQTT_DOA_UNVERIFIED',
  'MQTT_ANGLE_CONVENTION_UNKNOWN',
  'CSV_VIEW_UNAVAILABLE',
  'XML_VIEW_UNAVAILABLE',
  'CSV_VFO_ROW_UNCONFIRMED',
  'NATIVE_ANGLE_INVALID',
  'DOA_CANDIDATES_STALE',
  'STATUS_STALE',
  'SELECTED_DOA_STALE',
  'SELECTED_AUTHORITY_UNAVAILABLE',
  'ANGULAR_PEAK_ANGLE_MISMATCH',
];

function gateReasonRank(reason: string): number {
  const actionable = ACTIONABLE_GATE_REASONS.indexOf(reason);
  if (actionable >= 0) return actionable;
  const standing = STANDING_GATE_REASONS.indexOf(reason);
  if (standing >= 0) return 1000 + standing;
  return 500;
}

/** Ranked gate reasons without the standing ones that hold on every console read. */
export function actionableGateReasons(reasons: readonly unknown[] | null | undefined): string[] {
  return rankGateReasons(reasons).filter((reason) => !STANDING_GATE_REASONS.includes(reason));
}

/** Order gate reasons so the most actionable comes first; unknown reasons sit between. */
export function rankGateReasons(reasons: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(reasons)) return [];
  return reasons
    .filter((reason): reason is string => typeof reason === 'string' && reason.trim() !== '')
    .map((reason, index) => ({ reason, index }))
    .sort((a, b) => gateReasonRank(a.reason) - gateReasonRank(b.reason) || a.index - b.index)
    .map(({ reason }) => reason);
}
