import type { TelemetrySnapshot, Tone } from '../types';
import { rankGateReasons } from './doaStatus';
import type { MessageKey } from './i18n';

/**
 * What the Delivery (Publikasi) chip says about the publication gate. The
 * console never publishes a bearing, so the gate is BLOCKED on every read by
 * reasons that only configuration clears (no DoA authority, no approved angle
 * convention, an unverified clock). Those are "setup needed", not a fault;
 * the chip says "problem" only when the data itself has one.
 */
export type DeliveryState = 'READY' | 'SIMULATION' | 'PROBLEM' | 'SETUP';

/** Reasons only configuration clears; they hold on every console read. */
export const SETUP_GATE_REASONS: readonly string[] = [
  'DOA_AUTHORITY_NOT_SELECTED',
  'CANONICAL_ANGLE_NOT_CONFIGURED',
  'GROUND_CLOCK_UNVERIFIED',
  'SELECTED_UNITS_NOT_READY',
  'CONFIDENCE_MAPPING_UNVERIFIED',
  'POWER_MAPPING_UNVERIFIED',
  // The edge sends ok=0 until its own authority and angle are verified (its default).
  'MQTT_DOA_UNVERIFIED',
];

/** Reasons that come and go with read timing or the signal and need no action. */
export const NOTE_GATE_REASONS: readonly string[] = [
  'NATIVE_ANGLE_UNCHECKED',
  'MQTT_ANGULAR_UNAVAILABLE',
  'POWER_FLOOR_LOSSY',
  'SIMULATION_ONLY',
];

/** Gate checks that only configuration can pass; the rest describe the data. */
const SETUP_CHECKS: ReadonlySet<string> = new Set([
  'authority_selected',
  'selected_doa_fresh',
  'selected_units_valid',
  'canonical_angle_ready',
  'status_fresh',
]);

export interface DeliveryCheck {
  key: string;
  /** true passed, false failed, null not judged (unknown or not applicable). */
  ok: boolean | null;
  group: 'setup' | 'data';
}

export interface DeliveryView {
  state: DeliveryState;
  tone: Tone;
  /** Reasons the data has a problem, most actionable first. */
  problems: string[];
  /** Reasons that need configuration. */
  setup: string[];
  /** Reasons that need no action. */
  notes: string[];
  /** The gate's checks, data first, then setup, each in the server's order. */
  checks: DeliveryCheck[];
}

const CHECK_KEY_RE = /^[a-z0-9_]{1,48}$/;

export function deliveryView(snapshot: TelemetrySnapshot | null | undefined): DeliveryView {
  const gate = snapshot?.publication_gate;
  const reasons = rankGateReasons(gate?.reasons);
  const setup = reasons.filter((reason) => SETUP_GATE_REASONS.includes(reason));
  const notes = reasons.filter((reason) => NOTE_GATE_REASONS.includes(reason));
  const problems = reasons.filter((reason) => !setup.includes(reason) && !notes.includes(reason));
  const checks: DeliveryCheck[] = Object.entries(gate?.checks ?? {})
    .filter(([key]) => CHECK_KEY_RE.test(key))
    .map(([key, value]): DeliveryCheck => ({
      key,
      ok: typeof value === 'boolean' ? value : null,
      group: SETUP_CHECKS.has(key) ? 'setup' : 'data',
    }));
  checks.sort((a, b) => (a.group === b.group ? 0 : a.group === 'data' ? -1 : 1));
  const ready = String(gate?.state ?? '').toUpperCase() === 'READY';
  const state: DeliveryState = ready ? 'READY'
    : snapshot?.simulation === true ? 'SIMULATION'
      : problems.length > 0 ? 'PROBLEM' : 'SETUP';
  const tone: Tone = state === 'READY' ? 'good' : state === 'SETUP' ? 'neutral' : 'warn';
  return { state, tone, problems, setup, notes, checks };
}

const CHECK_LABELS: Record<string, MessageKey> = {
  status_available: 'delivery.check.status_available',
  status_fresh: 'delivery.check.status_fresh',
  mqtt_health_fresh: 'delivery.check.mqtt_health_fresh',
  daq_healthy: 'delivery.check.daq_healthy',
  adc_not_overdriven: 'delivery.check.adc_not_overdriven',
  node_not_stalled: 'delivery.check.node_not_stalled',
  doa_candidate_parsed: 'delivery.check.doa_candidate_parsed',
  doa_candidate_fresh: 'delivery.check.doa_candidate_fresh',
  angular_vector_live: 'delivery.check.angular_vector_live',
  authority_selected: 'delivery.check.authority_selected',
  selected_doa_fresh: 'delivery.check.selected_doa_fresh',
  selected_units_valid: 'delivery.check.selected_units_valid',
  canonical_angle_ready: 'delivery.check.canonical_angle_ready',
  native_views_consistent: 'delivery.check.native_views_consistent',
  angular_peak_consistent: 'delivery.check.angular_peak_consistent',
  native_angle_checked: 'delivery.check.native_angle_checked',
};

/** i18n key of a gate check, or null for a check this console does not name. */
export function deliveryCheckKey(key: string): MessageKey | null {
  return CHECK_LABELS[key] ?? null;
}

const STATE_LABELS: Record<DeliveryState, MessageKey> = {
  READY: 'delivery.ready',
  SIMULATION: 'delivery.simulation',
  PROBLEM: 'delivery.problem',
  SETUP: 'delivery.setup',
};

export function deliveryStateKey(state: DeliveryState): MessageKey {
  return STATE_LABELS[state];
}
