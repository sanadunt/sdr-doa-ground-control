/**
 * Did the RDF-SDR take a sent config patch? Each sent field is compared with
 * the latest Data Out settings.json first; MQTT is used for a field only when
 * a fresh Data Out snapshot does not carry it, and only with a value that
 * arrived after the command was issued. The console may reuse settings.json
 * for a while, so a copy read before the command was issued is not evidence
 * either. An ACK only says the edge agent wrote settings.json; this reads the
 * values back from the node.
 */
import type { ConfigReported } from '../api';
import type { TelemetrySnapshot } from '../types';
import { CONFIG_PATCH_KEYS } from './controlDraft';
import type { ConfigPatchChanges, ConfigPatchKey } from './controlDraft';
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
  /** Largest difference, in SI, that still counts as the sent value. */
  tolerance: number;
}

export const VERIFY_FIELD_RULES: Record<ConfigPatchKey, VerifyFieldRule> = {
  // center_freq is MHz in settings.json; its rounding can hide a few hundred Hz.
  center_frequency_hz: { dataOutKey: 'center_freq', scale: 1e6, tolerance: 500 },
  gain_db: { dataOutKey: 'uniform_gain', scale: 1, tolerance: 0.05 },
  vfo_frequency_hz: { dataOutKey: 'vfo_freq_0', scale: 1, tolerance: 500 },
  vfo_bandwidth_hz: { dataOutKey: 'vfo_bw_0', scale: 1, tolerance: 1 },
  vfo_squelch_db: { dataOutKey: 'vfo_squelch_0', scale: 1, tolerance: 0.05 },
};

export type ConfigValues = Record<ConfigPatchKey, number | null>;

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
    const raw = fields[rule.dataOutKey];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    values[key] = rule.scale === 1 ? raw : Math.round(raw * rule.scale);
  }
  return values;
}

/** The node's settings from a fresh, live Data Out snapshot, in SI; null per field otherwise. */
export function dataOutConfigValues(snapshot: TelemetrySnapshot | null, fresh: boolean): ConfigValues {
  return fresh ? settingsValues(snapshot) : emptyValues();
}

/** Current values for the Kontrol form: MQTT first, then Data Out for what MQTT does not report. */
export function currentConfigValues(mqtt: Partial<Record<ConfigPatchKey, number | null>> | null | undefined, dataOut: ConfigValues): ConfigValues {
  const values = emptyValues();
  for (const key of CONFIG_PATCH_KEYS) {
    const reported = mqtt?.[key];
    values[key] = typeof reported === 'number' && Number.isFinite(reported) ? reported : dataOut[key];
  }
  return values;
}

export interface VerifyInput {
  /** What was sent, in SI units. */
  changes: ConfigPatchChanges;
  /** Server time the command was issued; an MQTT value must arrive after it. */
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
  sent: number;
  /** Fresh Data Out value in SI, else null. */
  dataOut: number | null;
  /** MQTT value that arrived after the command was issued, else null. */
  mqtt: number | null;
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

function matches(key: ConfigPatchKey, value: number, sent: number): boolean {
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
    const sent = input.changes[key];
    if (typeof sent !== 'number' || !Number.isFinite(sent)) continue;
    const dataOut = fresh[key];
    const mqttValue = input.reported?.values[key] ?? null;
    const receivedAt = input.reported?.valueReceivedAtMs[key] ?? null;
    const mqtt = mqttValue !== null && input.issuedAtMs !== null && receivedAt !== null && receivedAt > input.issuedAtMs ? mqttValue : null;
    const basis: VerifyBasis | null = dataOut !== null ? 'data-out' : mqtt !== null ? 'mqtt' : null;
    const evidence = basis === 'data-out' ? dataOut : mqtt;
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
