import type { Candidate, TelemetrySnapshot, Tone } from '../types';
import type { MessageKey } from './i18n';
import { candidate, completeVector, freshCandidate, nativeViewsReady } from './telemetry';

/** Why the DoA curve and bearing are, or are not, shown. */
export type DoaStatusReason =
  | 'waiting'
  | 'simulation'
  | 'available'
  | 'daqDegraded'
  | 'adcOverdrive'
  | 'conflict'
  | 'statusUnavailable'
  | 'viewMissing'
  | 'nodeStalled'
  | 'sourceStale'
  | 'notComparable'
  | 'vectorIncomplete'
  | 'localExpired'
  | 'angleMissing';

export interface DoaStatus {
  /** Untranslated status code for badges. */
  code: 'WAITING' | 'SIMULATION' | 'AVAILABLE' | 'DEGRADED' | 'CONFLICT' | 'UNAVAILABLE' | 'INCOMPLETE' | 'STALE';
  tone: Tone;
  reason: DoaStatusReason;
  /** The curve and bearing are drawn. */
  shown: boolean;
}

function viewMissing(value: Candidate): boolean {
  return value.available !== true;
}

function nodeStalled(snapshot: TelemetrySnapshot): boolean {
  const progress = snapshot.node_progress;
  if (progress && typeof progress === 'object' && (progress as Record<string, unknown>).stalled === true) return true;
  return [candidate(snapshot, 'csv'), candidate(snapshot, 'xml')]
    .some((value) => (value.freshness as Record<string, unknown> | undefined)?.node_stalled === true);
}

/**
 * Status of the DoA views on Overview, derived from the snapshot itself so the
 * text names the actual cause. `drawable` is whether the renderer has a fresh,
 * complete curve for this snapshot.
 */
export function doaStatus(snapshot: TelemetrySnapshot | null | undefined, localFresh: boolean, drawable: boolean): DoaStatus {
  if (!snapshot) return { code: 'WAITING', tone: 'neutral', reason: 'waiting', shown: false };
  if (snapshot.simulation === true) {
    return drawable
      ? { code: 'SIMULATION', tone: 'warn', reason: 'simulation', shown: true }
      : { code: 'SIMULATION', tone: 'warn', reason: 'vectorIncomplete', shown: false };
  }
  const shown = drawable && localFresh;
  const daqFailed = Boolean(snapshot.status?.daq_health) && snapshot.status?.daq_health !== 'PASS';
  const overdriven = snapshot.publication_gate?.checks?.adc_not_overdriven === false;
  if (shown) {
    if (daqFailed) return { code: 'DEGRADED', tone: 'warn', reason: 'daqDegraded', shown };
    if (overdriven) return { code: 'DEGRADED', tone: 'warn', reason: 'adcOverdrive', shown };
    return { code: 'AVAILABLE', tone: 'good', reason: 'available', shown };
  }
  const blocked = (code: DoaStatus['code'], reason: DoaStatusReason): DoaStatus => ({ code, tone: 'warn', reason, shown: false });
  if (snapshot.native_consistency?.conflict === true) return blocked('CONFLICT', 'conflict');
  if (snapshot.status?.available !== true) return blocked('UNAVAILABLE', 'statusUnavailable');
  if (daqFailed) return blocked('DEGRADED', 'daqDegraded');
  if (overdriven) return blocked('DEGRADED', 'adcOverdrive');
  const csv = candidate(snapshot, 'csv');
  const xml = candidate(snapshot, 'xml');
  if (viewMissing(csv) || viewMissing(xml)) return blocked('INCOMPLETE', 'viewMissing');
  if (nodeStalled(snapshot)) return blocked('STALE', 'nodeStalled');
  if (!freshCandidate(csv) || !freshCandidate(xml)) return blocked('STALE', 'sourceStale');
  if (!nativeViewsReady(snapshot)) return blocked('INCOMPLETE', 'notComparable');
  if (!completeVector(csv)) return blocked('INCOMPLETE', 'vectorIncomplete');
  if (!localFresh) return blocked('STALE', 'localExpired');
  return blocked('INCOMPLETE', 'angleMissing');
}

const STATUS_TEXT: Record<DoaStatusReason, MessageKey> = {
  waiting: 'polar.waiting',
  simulation: 'polar.simulation',
  available: 'polar.available',
  daqDegraded: 'polar.daqDegraded',
  adcOverdrive: 'polar.adcOverdrive',
  conflict: 'polar.conflict',
  statusUnavailable: 'polar.statusUnavailable',
  viewMissing: 'polar.viewMissing',
  nodeStalled: 'polar.nodeStalled',
  sourceStale: 'polar.sourceStale',
  notComparable: 'polar.notComparable',
  vectorIncomplete: 'polar.vectorIncomplete',
  localExpired: 'polar.expired',
  angleMissing: 'polar.angleMissing',
};

export function doaStatusTextKey(reason: DoaStatusReason): MessageKey {
  return STATUS_TEXT[reason];
}

// Reasons that hold on every console read (the clock is never verified and the
// authority/unit contracts are not configured) go last so the summary shows
// the reason an operator can act on.
const STANDING_GATE_REASONS = [
  'POWER_FLOOR_LOSSY',
  'POWER_MAPPING_UNVERIFIED',
  'CONFIDENCE_MAPPING_UNVERIFIED',
  'SELECTED_UNITS_NOT_READY',
  'DOA_AUTHORITY_NOT_SELECTED',
  'CANONICAL_ANGLE_NOT_CONFIGURED',
  'GROUND_CLOCK_UNVERIFIED',
];

const ACTIONABLE_GATE_REASONS = [
  'SIMULATION_ONLY',
  'STATUS_UNAVAILABLE_OR_INVALID',
  'NODE_CLOCK_STALLED',
  'NATIVE_DOA_VIEWS_CONFLICT',
  'DAQ_HEALTH_GATE_FAILED',
  'ADC_OVERDRIVE',
  'COLLECTION_DEADLINE_EXCEEDED',
  'NO_VALID_DOA_CANDIDATE',
  'CSV_VIEW_UNAVAILABLE',
  'XML_VIEW_UNAVAILABLE',
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

/** Order gate reasons so the most actionable comes first; unknown reasons sit between. */
export function rankGateReasons(reasons: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(reasons)) return [];
  return reasons
    .filter((reason): reason is string => typeof reason === 'string' && reason.trim() !== '')
    .map((reason, index) => ({ reason, index }))
    .sort((a, b) => gateReasonRank(a.reason) - gateReasonRank(b.reason) || a.index - b.index)
    .map(({ reason }) => reason);
}
