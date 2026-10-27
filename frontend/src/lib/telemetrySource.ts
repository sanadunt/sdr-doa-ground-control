/**
 * Which source answered /api/snapshot (issue #8). The console decides on the
 * server (tools/telemetry_source.py): MQTT while the RDF Node's health is
 * fresh with daq=1, else Data Out as the fallback, else none. An MQTT answer
 * keeps the TelemetrySnapshot shape with one DoA view, `doa_candidates.mqtt`
 * (the LIVE telemetry/doa with the vector of its LIVE telemetry/angular
 * frame), instead of the CSV and XML views of Data Out. An answer without a
 * source block comes from an older server, which always read Data Out.
 */
import type { Candidate, Tone, TelemetrySnapshot } from '../types';
import type { MessageKey } from './i18n';

export type TelemetrySourceKind = 'mqtt' | 'data_out' | 'none';

/** The source codes the server sends (telemetry_source.SOURCE_REASONS). */
export const SOURCE_REASONS = [
  'MQTT_FRESH',
  'MQTT_DISABLED',
  'MQTT_NO_SESSION',
  'MQTT_NO_HEALTH',
  'MQTT_HEALTH_STALE',
  'MQTT_DAQ_NOT_HEALTHY',
  'DATA_OUT_REQUESTED',
  'DATA_OUT_UNAVAILABLE',
] as const;
export type SourceReason = typeof SOURCE_REASONS[number];

const MAX_REASONS = 8;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The answer's source, or null for an answer without one (an older server, a simulation). */
export function snapshotSourceKind(snapshot: TelemetrySnapshot | null | undefined): TelemetrySourceKind | null {
  const kind = record(snapshot?.source)?.kind;
  return kind === 'mqtt' || kind === 'data_out' || kind === 'none' ? kind : null;
}

/** The answer came from MQTT: its DoA view is `doa_candidates.mqtt`. */
export function isMqttSnapshot(snapshot: TelemetrySnapshot | null | undefined): boolean {
  return snapshot?.simulation !== true && snapshotSourceKind(snapshot) === 'mqtt';
}

/** The known source codes of the answer, in the server's order; MQTT_FRESH for an MQTT answer. */
export function snapshotSourceReasons(snapshot: TelemetrySnapshot | null | undefined): SourceReason[] {
  const source = record(snapshot?.source);
  if (!source) return [];
  const raw = Array.isArray(source.reasons) && source.reasons.length > 0 ? source.reasons : [source.reason];
  return raw
    .filter((reason): reason is SourceReason => typeof reason === 'string' && (SOURCE_REASONS as readonly string[]).includes(reason))
    .slice(0, MAX_REASONS);
}

export interface SourceBadge {
  kind: TelemetrySourceKind;
  /** MQTT, Data Out (fallback) or none, in the UI language. */
  labelKey: MessageKey;
  tone: Tone;
  /** Why this source: the codes the tooltip names (empty for MQTT). */
  reasons: SourceReason[];
}

const BADGE: Record<TelemetrySourceKind, { labelKey: MessageKey; tone: Tone }> = {
  mqtt: { labelKey: 'source.mqtt', tone: 'good' },
  data_out: { labelKey: 'source.dataOut', tone: 'warn' },
  none: { labelKey: 'source.none', tone: 'bad' },
};

/** The source badge of the status strip and the HUD, or null when the answer names no source. */
export function sourceBadge(snapshot: TelemetrySnapshot | null | undefined): SourceBadge | null {
  if (!snapshot || snapshot.simulation === true) return null;
  const kind = snapshotSourceKind(snapshot);
  if (kind === null) return null;
  const reasons = kind === 'mqtt' ? [] : snapshotSourceReasons(snapshot).filter((reason) => reason !== 'MQTT_FRESH');
  return { kind, ...BADGE[kind], reasons };
}

/** i18n key of a source code. */
export function sourceReasonKey(reason: SourceReason): MessageKey {
  return `source.reason.${reason}` as MessageKey;
}

/**
 * An MQTT answer whose only current DoA is UNVERIFIED (telemetry/doa ok=0):
 * the edge has not verified the source authority or the angle convention.
 * It is a diagnostic, never a DoA to show.
 */
export function mqttDoaUnverified(snapshot: TelemetrySnapshot | null | undefined): boolean {
  if (!isMqttSnapshot(snapshot)) return false;
  const unverified = record(record(snapshot?.mqtt)?.doa_unverified);
  return unverified !== null && unverified.stale !== true;
}

/** The light Data Out read of an MQTT answer, or null. */
function lightRead(snapshot: TelemetrySnapshot | null | undefined): Record<string, unknown> | null {
  return isMqttSnapshot(snapshot) ? record(snapshot?.data_out_light) : null;
}

/** status.json of the light read, when it was read. */
export function lightStatus(snapshot: TelemetrySnapshot | null | undefined): Record<string, unknown> | null {
  const status = record(lightRead(snapshot)?.status);
  return status && status.available === true ? status : null;
}

/** The doa.xml view of the light read (its position and freshness at that read), or null. */
export function lightXml(snapshot: TelemetrySnapshot | null | undefined): Candidate | null {
  const xml = record(lightRead(snapshot)?.xml);
  return xml && xml.available === true ? xml as Candidate : null;
}

/** One part of what an MQTT answer carries, for DoA Diagnostics. */
export interface MqttDiagnosticRow {
  key: 'doa' | 'angular' | 'doa_unverified' | 'diagnostic_doa' | 'angular_unverified';
  /** LIVE and STALE for the LIVE topics; UNVERIFIED and STALE for the rest. */
  status: 'LIVE' | 'UNVERIFIED' | 'STALE';
  /** theta_0 in degrees, when the console can map the part's angle. */
  thetaDeg: number | null;
  frequencyHz: number | null;
  ageMs: number | null;
  /** Why it is not LIVE (server or edge codes). */
  reasons: string[];
}

const REASON_RE = /^[A-Z0-9_:-]{1,64}$/;
const MAX_ROW_REASONS = 8;

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function codes(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && REASON_RE.test(item)).slice(0, MAX_ROW_REASONS)
    : [];
}

function ageOf(part: Record<string, unknown>): number | null {
  const ages = [finiteOrNull(part.age_ms), finiteOrNull(part.source_age_ms)].filter((age): age is number => age !== null);
  return ages.length ? Math.max(0, ...ages) : null;
}

/**
 * The DoA parts of an MQTT answer: the LIVE DoA and Angular frame the
 * Dashboard draws, and the UNVERIFIED and diagnostic ones it never draws
 * (telemetry/doa ok=0, trust-only and diagnostic Angular, diagnostic
 * doa.xml). Empty for any other answer.
 */
export function mqttDiagnosticRows(snapshot: TelemetrySnapshot | null | undefined): MqttDiagnosticRow[] {
  if (!isMqttSnapshot(snapshot)) return [];
  const mqtt = record(snapshot?.mqtt);
  if (!mqtt) return [];
  const view = record(snapshot?.doa_candidates?.mqtt);
  const rows: MqttDiagnosticRow[] = [];
  const doa = record(mqtt.doa);
  if (doa) {
    rows.push({
      key: 'doa',
      status: doa.live === true ? 'LIVE' : 'STALE',
      thetaDeg: finiteOrNull(view?.canonical_angle_deg),
      frequencyHz: finiteOrNull(doa.f),
      ageMs: ageOf(doa),
      reasons: codes(doa.reasons),
    });
  }
  const angular = record(mqtt.angular);
  if (angular) {
    rows.push({
      key: 'angular',
      status: angular.live === true ? 'LIVE' : 'STALE',
      thetaDeg: finiteOrNull(angular.canonical_angle_deg),
      frequencyHz: finiteOrNull(angular.frequency_hz),
      ageMs: ageOf(angular),
      reasons: codes(angular.reasons),
    });
  }
  const parts: Array<[MqttDiagnosticRow['key'], Record<string, unknown> | null]> = [
    ['doa_unverified', record(mqtt.doa_unverified)],
    ['diagnostic_doa', record(mqtt.diagnostic_doa)],
    ['angular_unverified', record(mqtt.angular_unverified)],
  ];
  for (const [key, part] of parts) {
    if (!part) continue;
    const mhz = finiteOrNull(part.frequency_mhz);
    rows.push({
      key,
      status: part.stale === true ? 'STALE' : 'UNVERIFIED',
      thetaDeg: finiteOrNull(part.canonical_angle_deg),
      frequencyHz: finiteOrNull(part.f) ?? finiteOrNull(part.frequency_hz) ?? (mhz === null ? null : Math.round(mhz * 1e6)),
      ageMs: ageOf(part),
      reasons: codes(part.validation_reasons),
    });
  }
  return rows;
}

/** capabilities.angle of the MQTT answer's session, when the console can map it. */
export function mqttAngleMode(snapshot: TelemetrySnapshot | null | undefined): string | null {
  const mode = record(snapshot?.mqtt)?.angle_convention;
  return isMqttSnapshot(snapshot) && (mode === 'theta_mirror' || mode === 'csv_native') ? mode : null;
}
