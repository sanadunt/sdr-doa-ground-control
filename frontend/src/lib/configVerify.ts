/**
 * Did the RDF-SDR take a sent config patch? Each sent field is compared with
 * the node's settings/reported (MQTT) first, counted only when the report
 * arrived after the command was issued and is of the node's current
 * revision; a fresh Data Out settings.json (the fallback) is used for a
 * field only when no such report carries it. The console may reuse
 * settings.json for a while, so a copy read before the command was issued is
 * not evidence either. An ACK says what the edge did; this reads the values
 * back from the node.
 */
import type { ConfigReported } from '../api';
import type { TelemetrySnapshot } from '../types';
import { CONFIG_PATCH_KEYS, configPatchValue } from './controlDraft';
import type { ConfigPatchChanges, ConfigPatchKey, ConfigPatchValue } from './controlDraft';
import { settingsReadAtMs } from './snapshotRead';

export type VerifyStatus = 'confirmed' | 'pending' | 'unchanged' | 'not-reported';
export type VerifyVerdict = 'confirmed' | 'partial' | 'pending' | 'unchanged' | 'not-reported';
export type VerifyBasis = 'data-out' | 'mqtt';

/** How long after the command became final a field may still turn up changed. */
export const VERIFY_WINDOW_MS = 90_000;

export interface VerifyFieldRule {
  /** settings.json key in the Data Out snapshot. */
  dataOutKey: string;
  /** SI value of one settings.json unit (center_freq is MHz). */
  scale: number;
  /** Largest difference, in SI, that still counts as the sent value; a text value must be equal. */
  tolerance: number;
}

export const VERIFY_FIELD_RULES: Record<ConfigPatchKey, VerifyFieldRule> = {
  // center_freq is MHz in settings.json; its rounding can hide a few hundred Hz.
  center_frequency_hz: { dataOutKey: 'center_freq', scale: 1e6, tolerance: 500 },
  gain_db: { dataOutKey: 'uniform_gain', scale: 1, tolerance: 0.05 },
  vfo0_frequency_hz: { dataOutKey: 'vfo_freq_0', scale: 1, tolerance: 500 },
  vfo0_bandwidth_hz: { dataOutKey: 'vfo_bw_0', scale: 1, tolerance: 1 },
  vfo0_squelch_db: { dataOutKey: 'vfo_squelch_0', scale: 1, tolerance: 0.05 },
  // The UCA radius in metres (edge 1.8.0); the edge rounds it to 0.1 mm and its band rule to the band value.
  ant_spacing_m: { dataOutKey: 'ant_spacing_meters', scale: 1, tolerance: 0.0005 },
  // The squelch mode (edge 1.9.0): the exact string the edge took (Manual, Auto, Auto Channel, Default).
  vfo0_squelch_mode: { dataOutKey: 'vfo_squelch_mode_0', scale: 1, tolerance: 0 },
};

export type ConfigValues = Record<ConfigPatchKey, ConfigPatchValue | null>;

function emptyValues(): ConfigValues {
  const values = {} as ConfigValues;
  for (const key of CONFIG_PATCH_KEYS) values[key] = null;
  return values;
}

/** settings.json values in SI, whatever the snapshot's age; synthetic data never counts. */
function settingsValues(snapshot: TelemetrySnapshot | null): ConfigValues {
  const values = emptyValues();
  const settings = snapshot?.settings;
  if (!snapshot || snapshot.simulation === true || settings?.available !== true) return values;
  const fields = settings.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return values;
  for (const key of CONFIG_PATCH_KEYS) {
    const rule = VERIFY_FIELD_RULES[key];
    const raw = configPatchValue(key, fields[rule.dataOutKey]);
    if (raw === null) continue;
    values[key] = typeof raw === 'number' && rule.scale !== 1 ? Math.round(raw * rule.scale) : raw;
  }
  return values;
}

/** The node's settings from a fresh, live Data Out snapshot, in SI; null per field otherwise. */
export function dataOutConfigValues(snapshot: TelemetrySnapshot | null, fresh: boolean): ConfigValues {
  return fresh ? settingsValues(snapshot) : emptyValues();
}

/**
 * settings.json vfo_default_squelch_mode (what a Default squelch mode follows,
 * edge 1.9) from a fresh, live Data Out snapshot; null otherwise.
 */
export function dataOutDefaultSquelchMode(snapshot: TelemetrySnapshot | null, fresh: boolean): string | null {
  const settings = snapshot?.settings;
  if (!fresh || !snapshot || snapshot.simulation === true || settings?.available !== true) return null;
  const fields = settings.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  const value = (fields as Record<string, unknown>).vfo_default_squelch_mode;
  return typeof value === 'string' && /^[A-Za-z][A-Za-z ]{0,31}$/u.test(value) ? value : null;
}

// An array arrangement as settings.json spells it; kept as it is, since the edge compares it with 'UCA' exactly.
const ANT_ARRANGEMENT_RE = /^[A-Za-z_]{1,16}$/u;

/** settings.json ant_arrangement as the edge reads it, or null when it is not a short word. */
export function antArrangementOrNull(value: unknown): string | null {
  return typeof value === 'string' && ANT_ARRANGEMENT_RE.test(value) ? value : null;
}

/**
 * settings.json ant_arrangement (UCA, ULA) from a fresh, live Data Out
 * snapshot; null otherwise. The engine's own UCA radius rule holds for a UCA only.
 */
export function dataOutAntArrangement(snapshot: TelemetrySnapshot | null, fresh: boolean): string | null {
  const settings = snapshot?.settings;
  if (!fresh || !snapshot || snapshot.simulation === true || settings?.available !== true) return null;
  const fields = settings.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  return antArrangementOrNull((fields as Record<string, unknown>).ant_arrangement);
}

/**
 * The array arrangement the edge's band rule (control._band_spacing) reads:
 * the current settings/reported first, which also arrives over LoRa, then a
 * fresh Data Out; null when neither says, which parseDraft treats as a UCA,
 * as the edge treats a settings.json without the key.
 */
export function controlAntArrangement(settings: ConfigReported['settings'] | null | undefined, dataOut: string | null): string | null {
  return (settings?.matchesStateCfg === true ? settings.antArrangement : null) ?? dataOut;
}

/** Current values for the Kontrol form: settings/reported first, then Data Out for what it does not carry. */
export function currentConfigValues(mqtt: Partial<Record<ConfigPatchKey, ConfigPatchValue | null>> | null | undefined, dataOut: ConfigValues): ConfigValues {
  const values = emptyValues();
  for (const key of CONFIG_PATCH_KEYS) values[key] = configPatchValue(key, mqtt?.[key]) ?? dataOut[key];
  return values;
}

export interface VerifyInput {
  /** What was sent, in SI units. */
  changes: ConfigPatchChanges;
  /** Server time the command was issued; a settings/reported value must arrive after it. */
  issuedAtMs: number | null;
  /** When the command became final, on the clock of `nowMs`. */
  finalAtMs: number;
  nowMs: number;
  reported: Pick<ConfigReported, 'values' | 'valueReceivedAtMs'> | null;
  snapshot: TelemetrySnapshot | null;
  /** Local freshness of the snapshot; a stale one is not evidence. */
  snapshotFresh: boolean;
  windowMs?: number;
}

export interface VerifyField {
  key: ConfigPatchKey;
  sent: ConfigPatchValue;
  /** Fresh Data Out value in SI, else null. */
  dataOut: ConfigPatchValue | null;
  /** settings/reported value that arrived after the command was issued, else null. */
  mqtt: ConfigPatchValue | null;
  /** Source the status was decided on. */
  basis: VerifyBasis | null;
  status: VerifyStatus;
}

export interface ConfigVerification {
  fields: VerifyField[];
  verdict: VerifyVerdict;
  confirmed: number;
  total: number;
  windowEndsAtMs: number;
}

function matches(key: ConfigPatchKey, value: ConfigPatchValue, sent: ConfigPatchValue): boolean {
  if (typeof value === 'string' || typeof sent === 'string') return value === sent;
  return Math.abs(value - sent) <= VERIFY_FIELD_RULES[key].tolerance + 1e-9;
}

/** settings.json in this snapshot was read after the command was issued (unknown counts as after). */
export function settingsReadAfter(snapshot: TelemetrySnapshot | null, issuedAtMs: number | null): boolean {
  const readAt = settingsReadAtMs(snapshot);
  return readAt === null || issuedAtMs === null || readAt >= issuedAtMs;
}

export function verifyConfigPatch(input: VerifyInput): ConfigVerification {
  const windowEndsAtMs = input.finalAtMs + (input.windowMs ?? VERIFY_WINDOW_MS);
  const open = input.nowMs < windowEndsAtMs;
  const fresh = dataOutConfigValues(input.snapshot, input.snapshotFresh && settingsReadAfter(input.snapshot, input.issuedAtMs));
  // A stale snapshot is not evidence, but it shows the node reports the field.
  const carried = settingsValues(input.snapshot);
  const fields: VerifyField[] = [];
  for (const key of CONFIG_PATCH_KEYS) {
    const sent = configPatchValue(key, input.changes[key]);
    if (sent === null) continue;
    const dataOut = fresh[key];
    const mqttValue = input.reported?.values[key] ?? null;
    const receivedAt = input.reported?.valueReceivedAtMs[key] ?? null;
    const mqtt = mqttValue !== null && input.issuedAtMs !== null && receivedAt !== null && receivedAt > input.issuedAtMs ? mqttValue : null;
    const basis: VerifyBasis | null = mqtt !== null ? 'mqtt' : dataOut !== null ? 'data-out' : null;
    const evidence = basis === 'mqtt' ? mqtt : dataOut;
    let status: VerifyStatus;
    if (evidence !== null) status = matches(key, evidence, sent) ? 'confirmed' : open ? 'pending' : 'unchanged';
    else status = open && (mqttValue !== null || carried[key] !== null) ? 'pending' : 'not-reported';
    fields.push({ key, sent, dataOut, mqtt, basis, status });
  }
  const confirmed = fields.filter((field) => field.status === 'confirmed').length;
  const total = fields.length;
  const verdict: VerifyVerdict = fields.some((field) => field.status === 'pending') ? 'pending'
    : total > 0 && confirmed === total ? 'confirmed'
      : confirmed > 0 ? 'partial'
        : fields.some((field) => field.status === 'unchanged') ? 'unchanged'
          : 'not-reported';
  return { fields, verdict, confirmed, total, windowEndsAtMs };
}
