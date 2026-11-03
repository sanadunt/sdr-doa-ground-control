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
import type { DoaStatus, DoaStatusReason } from './doaStatus';
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
  'DATA_OUT_NOT_OVER_LORA',
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
  // The LoRa serial bridge carries the same MQTT topics by radio: name the link the operator knows.
  const badge = kind === 'mqtt' && overLora(snapshot) ? { ...BADGE.mqtt, labelKey: 'source.lora' as MessageKey } : BADGE[kind];
  return { kind, ...badge, reasons };
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

/**
 * Any answer while the node reaches the broker over the LoRa serial bridge,
 * also one without fresh MQTT (source none): Data Out is not used then, so
 * nothing may name it as the missing source.
 */
export function loraLink(snapshot: TelemetrySnapshot | null | undefined): boolean {
  return record(snapshot?.source)?.link === 'lora';
}

/** An MQTT answer whose node reaches the broker over the LoRa serial bridge: no Data Out values can come. */
export function overLora(snapshot: TelemetrySnapshot | null | undefined): boolean {
  return isMqttSnapshot(snapshot) && record(snapshot?.source)?.link === 'lora';
}

/**
 * How old the Angular frame behind an MQTT answer's curve was when the answer
 * was built, or null. Over Telemetry LoRa a frame comes at most every 20 s,
 * so the curve shows its age instead of looking stuck.
 */
export function angularFrameAgeMs(snapshot: TelemetrySnapshot | null | undefined): number | null {
  if (!isMqttSnapshot(snapshot)) return null;
  const frame = record(record(record(snapshot?.doa_candidates)?.mqtt)?.angular_frame);
  const age = frame?.age_ms;
  return typeof age === 'number' && Number.isFinite(age) && age >= 0 ? age : null;
}

/**
 * The Angular curve of an MQTT answer is held: its frame is older than the
 * 10 s a curve stays LIVE and only the Telemetry LoRa window (45 s) keeps it
 * (a frame comes at most every 20 s by radio). It is drawn dimmed with its age.
 */
export function angularHeld(snapshot: TelemetrySnapshot | null | undefined): boolean {
  return isMqttSnapshot(snapshot) && record(record(snapshot?.doa_candidates)?.mqtt)?.angular_held === true;
}

/**
 * Codes the RDF Node edge gives for a DoA it does not send as LIVE (contract
 * 1.10), with their words. Several parse errors of the DoA CSV share one text.
 */
const EDGE_DOA_REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  SETUP_REQUIRED: 'edgeReason.SETUP_REQUIRED',
  SOURCE_NOT_CONFIGURED: 'edgeReason.SOURCE_NOT_CONFIGURED',
  NO_RECORD: 'edgeReason.NO_RECORD',
  STATUS_STALE_OR_UNAVAILABLE: 'edgeReason.STATUS_STALE_OR_UNAVAILABLE',
  DAQ_NOT_HEALTHY: 'edgeReason.DAQ_NOT_HEALTHY',
  CLOCK_UNTRUSTED: 'edgeReason.CLOCK_UNTRUSTED',
  NO_FRESH_DOA: 'edgeReason.NO_FRESH_DOA',
  DOA_FILE_NOT_UPDATING: 'edgeReason.DOA_FILE_NOT_UPDATING',
  EMPTY_CSV: 'edgeReason.EMPTY_CSV',
  NUL_IN_CSV: 'edgeReason.CSV_MALFORMED',
  CSV_FIELD_COUNT: 'edgeReason.CSV_MALFORMED',
  VFO_RECORD_AMBIGUOUS_OR_MISSING: 'edgeReason.VFO_RECORD',
  MULTIPLE_RECORDS_WITHOUT_VFO_AUTHORITY: 'edgeReason.VFO_RECORD',
  OUTPUT_VFO_MISMATCH: 'edgeReason.VFO_RECORD',
  SOURCE_TIME_REGRESSED: 'edgeReason.SOURCE_TIME_REGRESSED',
  SOURCE_UNVERIFIED: 'edgeReason.SOURCE_UNVERIFIED',
  ANGLE_UNVERIFIED: 'edgeReason.ANGLE_UNVERIFIED',
  CONFIG_UNAVAILABLE: 'edgeReason.CONFIG_UNAVAILABLE',
  CONFIG_ATTRIBUTION_UNVERIFIED: 'edgeReason.CONFIG_ATTRIBUTION_UNVERIFIED',
  CONTROL_IN_PROGRESS: 'edgeReason.CONTROL_IN_PROGRESS',
};

/** i18n key of an edge DoA code, or null for a code without words (shown as sent). */
export function edgeDoaReasonKey(code: string): MessageKey | null {
  return Object.prototype.hasOwnProperty.call(EDGE_DOA_REASON_KEYS, code) ? EDGE_DOA_REASON_KEYS[code] : null;
}

/**
 * Why the edge itself holds the DoA back (contract 1.10), as codes: the
 * reasons of the current UNVERIFIED ok=0 sample (validation_reasons, which
 * the console fills from the edge's reason), then telemetry/health.why while
 * that health is fresh. The edge stops sending DoA while its source has
 * nothing new, so health.why is then the only word on it; it also comes in a
 * Data Out or empty answer (source.mqtt.health_why). Empty from an older edge.
 */
export function edgeDoaReasons(snapshot: TelemetrySnapshot | null | undefined): string[] {
  if (!snapshot || snapshot.simulation === true) return [];
  const found: string[] = [];
  const add = (value: unknown) => {
    for (const code of codes(value)) if (!found.includes(code)) found.push(code);
  };
  const mqtt = isMqttSnapshot(snapshot) ? record(snapshot.mqtt) : null;
  const unverified = record(mqtt?.doa_unverified);
  if (unverified && unverified.stale !== true) {
    const listed = codes(unverified.validation_reasons);
    add(listed.length ? listed : unverified.reason);
  }
  const health = record(mqtt?.health);
  if (health) {
    if (health.fresh === true) add(health.why);
  } else {
    const summary = record(record(snapshot.source)?.mqtt);
    const age = finiteOrNull(summary?.health_age_ms);
    const window = finiteOrNull(summary?.health_fresh_ms);
    if (age !== null && window !== null && age >= 0 && age <= window) add(summary?.health_why);
  }
  return found.slice(0, MAX_ROW_REASONS);
}

/** The nav fields of an MQTT answer (health, contract 1.6), or null. */
export function snapshotNav(snapshot: TelemetrySnapshot | null | undefined): Record<string, unknown> | null {
  return isMqttSnapshot(snapshot) ? record(snapshot?.nav) : null;
}

/** The DOA_value.html power floor (CSV_POWER_FLOOR_DB of tools/sdr_doa_collector.py): a clip, not a measurement. */
const POWER_FLOOR_DB = -100;

/** Frequencies the console takes from the node: 1 MHz to 6 GHz, in whole Hz. */
const MIN_HZ = 1_000_000;
const MAX_HZ = 6_000_000_000;

function hzOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const hz = Math.round(value);
  return hz >= MIN_HZ && hz <= MAX_HZ ? hz : null;
}

function inRange(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/** The SDR settings of the node's retained state (state.rf); each value null when missing or out of range. */
export interface RfSettings {
  cfg: number | null;
  centerHz: number | null;
  vfo0Hz: number | null;
  gainDb: number | null;
  bandwidthHz: number | null;
  squelchDb: number | null;
  /** The UCA radius in metres (state.rf.uca, edge 1.8.0). */
  ucaM: number | null;
  /**
   * The VFO0 squelch mode as the edge names it (state.rf.sqm, edge 1.9.0:
   * Manual, Auto, Auto Channel, Default); null from an older edge.
   */
  squelchMode?: string | null;
}

/** A squelch mode as the edge sent it: a short word or phrase, else null. */
function squelchModeOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _.:+-]{0,31}$/u.test(value) ? value : null;
}

/**
 * What an MQTT answer says the SDR is set to (state.rf, edge 1.7), or null
 * without one or when none of its values is usable. These are settings.json
 * values of revision cfg: configured, not measured, so they are shown as a
 * setting and never as the DoA's frequency.
 */
export function snapshotRf(snapshot: TelemetrySnapshot | null | undefined): RfSettings | null {
  const rf = isMqttSnapshot(snapshot) ? record(snapshot?.rf) : null;
  if (!rf) return null;
  const cfg = inRange(rf.cfg, 0, Number.MAX_SAFE_INTEGER);
  const bandwidth = inRange(rf.vfo0_bandwidth_hz, 1, 100_000_000);
  const view: RfSettings = {
    cfg: cfg !== null && Number.isInteger(cfg) ? cfg : null,
    centerHz: hzOrNull(rf.center_frequency_hz),
    vfo0Hz: hzOrNull(rf.vfo0_frequency_hz),
    gainDb: inRange(rf.gain_db, -20, 100),
    bandwidthHz: bandwidth === null ? null : Math.round(bandwidth),
    squelchDb: inRange(rf.vfo0_squelch_db, -200, 50),
    ucaM: inRange(rf.uca_m, 0.001, 100),
    squelchMode: squelchModeOrNull(rf.squelch_mode),
  };
  return view.centerHz === null && view.vfo0Hz === null && view.gainDb === null && view.bandwidthHz === null && view.squelchDb === null
    && view.ucaM === null && view.squelchMode === null ? null : view;
}

/** Frequency and power of one DoA record. */
export interface DoaSample {
  frequencyHz: number;
  /** The record's native power in dB (not dBm), or null. */
  powerDb: number | null;
  /** The shown DoA (LIVE, ok=1); false for the UNVERIFIED ok=0 record, which is shown dimmed. */
  verified: boolean;
}

/** Frequency in MHz with three decimals and power in dB with one, e.g. "103.100 MHz · -54.2 dB". */
export function doaSampleText(sample: DoaSample): string {
  const mhz = `${(sample.frequencyHz / 1e6).toFixed(3)} MHz`;
  return sample.powerDb === null ? mhz : `${mhz} · ${sample.powerDb.toFixed(1)} dB`;
}

// The held reasons under which the UNVERIFIED ok=0 record is the current one.
const UNVERIFIED_SAMPLE_REASONS: ReadonlySet<DoaStatusReason> = new Set<DoaStatusReason>(['mqttUnverified', 'loraUnverified']);

/**
 * The current UNVERIFIED ok=0 record of an MQTT answer that arrived after its
 * LIVE DoA view went stale (a retune in progress, say): the newer word, held
 * in place of the last LIVE angle (provisionalDoa) and named on the signal
 * line with its own frequency and age. null otherwise.
 */
export function unverifiedAfterStaleLive(snapshot: TelemetrySnapshot | null | undefined): Record<string, unknown> | null {
  if (!isMqttSnapshot(snapshot)) return null;
  const unverified = record(record(snapshot?.mqtt)?.doa_unverified);
  const live = record(snapshot?.doa_candidates?.mqtt);
  if (!unverified || unverified.stale === true || !live || record(live.freshness)?.fresh === true) return null;
  const liveAt = finiteOrNull(live.received_at_ms);
  const unverifiedAt = finiteOrNull(unverified.received_at_ms);
  return liveAt !== null && unverifiedAt !== null && unverifiedAt > liveAt ? unverified : null;
}

/**
 * The frequency and power of the DoA record the Dashboard is showing, with
 * `status` from overviewDoaStatus(): the shown view's (the MQTT view or the
 * CSV view of Data Out); else, while the local window is open, the current
 * UNVERIFIED ok=0 record of an MQTT answer (also one newer than a stale LIVE
 * DoA, unverifiedAfterStaleLive), marked unverified. null when
 * there is no current record, so the caller can show the configured
 * frequency (snapshotRf) instead. The ok=0 record never fills a DoA view.
 */
export function doaSample(snapshot: TelemetrySnapshot | null | undefined, status: DoaStatus, localFresh: boolean): DoaSample | null {
  if (!snapshot || snapshot.simulation === true) return null;
  if (status.shown) {
    const view = record(snapshot.doa_candidates?.[isMqttSnapshot(snapshot) ? 'mqtt' : 'csv']);
    const frequencyHz = hzOrNull(view?.frequency_hz_normalized) ?? hzOrNull(view?.frequency_hz);
    if (frequencyHz === null) return null;
    // Data Out marks a CSV power at its floor as not valid (POWER_FLOOR_LOSSY).
    const powerDb = view?.power_native_valid === false ? null : inRange(view?.power_native_db, -250, 100);
    return { frequencyHz, powerDb, verified: true };
  }
  if (!localFresh || !isMqttSnapshot(snapshot)) return null;
  // A stale LIVE DoA gives way to a newer ok=0 record, as the held bearing does.
  if (!UNVERIFIED_SAMPLE_REASONS.has(status.reason) && !(status.reason === 'sourceStale' && unverifiedAfterStaleLive(snapshot))) return null;
  const unverified = record(record(snapshot.mqtt)?.doa_unverified);
  if (!unverified || unverified.stale === true) return null;
  const frequencyHz = hzOrNull(unverified.f);
  // A power at the DOA_value.html floor is the clip, not a measurement, as for a LIVE record.
  const powerDb = inRange(unverified.p, -250, 100);
  return frequencyHz === null ? null : { frequencyHz, powerDb: powerDb !== null && powerDb <= POWER_FLOOR_DB ? null : powerDb, verified: false };
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
