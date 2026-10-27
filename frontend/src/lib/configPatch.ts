/**
 * Fields, units and draft evaluation for Kontrol's config.patch to the RDF
 * Node edge (sdr/v2/<node>/cmd/config/patch), the results of the edge's ACKs,
 * and the codes the console server and the edge answer with. Values on the
 * wire are SI (Hz, dB); the form shows MHz and kHz. The field rules are the
 * edge's (tools/rdf_node_commands.py): whole Hz, the gain table, and a centre
 * change takes VFO0 along at the same frequency. The server checks them
 * again; the client copy only gives early feedback.
 */
import type { ConsoleCapabilities } from '../api';
import type { MessageKey } from './i18n';
import type { ConfigPatchChanges, ConfigPatchKey } from './controlDraft';
import { parseTypedNumber } from './polarViewSettings';

export interface ConfigPatchField {
  key: ConfigPatchKey;
  /** Label of the dry-run form on the Configuration page (SI unit in the label). */
  label: MessageKey;
  /** Label in Kontrol, where the unit stands beside the input. */
  shortLabel: MessageKey;
  /** Fallback range in SI units; the server's capabilities override it. */
  min: number;
  max: number;
  /** Step of the dry-run number input, in SI units. */
  step: number;
  /** Unit shown in Kontrol, and the SI value of one displayed unit. */
  unit: 'MHz' | 'kHz' | 'dB';
  scale: number;
  /** Decimals shown for a value in Kontrol. */
  decimals: number;
  /** Frequencies are sent as integer Hz. */
  integer: boolean;
  /** Only these values are accepted (the gain table); Kontrol shows a select. */
  table?: boolean;
}

/** The edge helper's gain table; a gain must be within 0.001 dB of one of these. */
export const GAIN_TABLE_DB: readonly number[] = [
  0.0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9, 25.4,
  28.0, 29.7, 32.8, 33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5, 48.0, 49.6,
];
const GAIN_TOLERANCE_DB = 0.001;

/** The edge's safe fields in its order. Ranges mirror rdf_node_commands.PATCH_RANGES. */
export const CONFIG_PATCH_FIELDS: readonly ConfigPatchField[] = [
  { key: 'center_frequency_hz', label: 'config.field.center', shortLabel: 'control.field.center', min: 24_000_000, max: 1_766_000_000, step: 1_000, unit: 'MHz', scale: 1e6, decimals: 3, integer: true },
  { key: 'gain_db', label: 'config.field.gain', shortLabel: 'control.field.gain', min: -10, max: 100, step: 0.1, unit: 'dB', scale: 1, decimals: 1, integer: false, table: true },
  { key: 'vfo0_frequency_hz', label: 'config.field.vfo', shortLabel: 'control.field.vfo', min: 24_000_000, max: 1_766_000_000, step: 1_000, unit: 'MHz', scale: 1e6, decimals: 3, integer: true },
  { key: 'vfo0_bandwidth_hz', label: 'config.field.bandwidth', shortLabel: 'control.field.bandwidth', min: 100, max: 2_400_000, step: 100, unit: 'kHz', scale: 1e3, decimals: 1, integer: true },
  { key: 'vfo0_squelch_db', label: 'config.field.squelch', shortLabel: 'control.field.squelch', min: -200, max: 50, step: 0.5, unit: 'dB', scale: 1, decimals: 0, integer: false },
];

export type ConfigPatchRanges = Partial<Record<ConfigPatchKey, readonly [number, number]>>;

/** [min, max] in SI for a field: the server's range when it sent one, else the client copy. */
export function fieldRange(field: ConfigPatchField, ranges: ConfigPatchRanges | null | undefined): readonly [number, number] {
  const range = ranges?.[field.key];
  return range && Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[0] < range[1] ? range : [field.min, field.max];
}

export function fieldFor(key: ConfigPatchKey): ConfigPatchField {
  return CONFIG_PATCH_FIELDS.find((field) => field.key === key) as ConfigPatchField;
}

/** True when an SI value lies in the field's range. */
export function inFieldRange(key: ConfigPatchKey, value: number | null | undefined, ranges?: ConfigPatchRanges | null): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const [min, max] = fieldRange(fieldFor(key), ranges);
  return value >= min && value <= max;
}

/** The gain table value a gain stands for, or null when it is in none. */
export function gainTableValue(value: number, table: readonly number[] = GAIN_TABLE_DB): number | null {
  if (!Number.isFinite(value)) return null;
  return table.find((gain) => Math.abs(gain - value) < GAIN_TOLERANCE_DB) ?? null;
}

/** Plain decimal text of a display value, without trailing zeros (for an input). */
export function plainNumber(value: number, maxDecimals = 6): string {
  if (!Number.isFinite(value)) return '';
  return String(Number(value.toFixed(maxDecimals)));
}

/** An SI value as the operator types it: MHz, kHz or dB without trailing zeros. */
export function draftText(field: ConfigPatchField, siValue: number | null | undefined): string {
  return typeof siValue === 'number' && Number.isFinite(siValue) ? plainNumber(siValue / field.scale) : '';
}

/** An SI value with its unit for review and hints, using a real minus sign. */
export function displayValue(field: ConfigPatchField, siValue: number | null | undefined): string {
  if (typeof siValue !== 'number' || !Number.isFinite(siValue)) return '—';
  const shown = siValue / field.scale;
  // Keep the precision that was typed when it is finer than the default.
  const decimals = Math.max(field.decimals, Math.min(6, (plainNumber(shown).split('.')[1] ?? '').length));
  const text = Math.abs(shown).toFixed(decimals);
  return `${shown < 0 && Number(text) !== 0 ? '−' : ''}${text} ${field.unit}`;
}

/** Range text in display units, e.g. "24 to 1766 MHz" pieces. */
export function rangeParts(field: ConfigPatchField, ranges: ConfigPatchRanges | null | undefined): { min: string; max: string; unit: string } {
  const [min, max] = fieldRange(field, ranges);
  const format = (value: number) => {
    const text = plainNumber(Math.abs(value / field.scale), 3);
    return value < 0 ? `−${text}` : text;
  };
  return { min: format(min), max: format(max), unit: field.unit };
}

export type DraftValues = Partial<Record<ConfigPatchKey, string>>;
export type ReportedValues = Partial<Record<ConfigPatchKey, number | null>>;

/**
 * `table`: a gain the edge's table does not have; `centerVfo`: the centre
 * changes and VFO0 is not the same frequency (the edge requires both, equal).
 */
export type FieldProblem = 'empty' | 'number' | 'range' | 'table' | 'centerVfo';

export interface FieldEvaluation {
  field: ConfigPatchField;
  text: string;
  /** Parsed SI value, or null. */
  value: number | null;
  reported: number | null;
  changed: boolean;
  problem: FieldProblem | null;
  /** Sent although unchanged: VFO0 goes along with a centre change. */
  required?: boolean;
}

export interface DraftEvaluation {
  fields: FieldEvaluation[];
  changes: ConfigPatchChanges;
  invalid: boolean;
}

/** A draft that starts from the reported values. */
export function draftFromReported(reported: ReportedValues, fields: readonly ConfigPatchField[] = CONFIG_PATCH_FIELDS): DraftValues {
  const draft: DraftValues = {};
  for (const field of fields) draft[field.key] = draftText(field, reported[field.key]);
  return draft;
}

/** Merge SI changes (from the spectrum dock) into a draft as display text. */
export function mergeIntoDraft(draft: DraftValues, changes: ConfigPatchChanges, fields: readonly ConfigPatchField[] = CONFIG_PATCH_FIELDS): DraftValues {
  const next: DraftValues = { ...draft };
  for (const field of fields) {
    const value = changes[field.key];
    if (typeof value === 'number' && Number.isFinite(value)) next[field.key] = draftText(field, value);
  }
  return next;
}

/**
 * A draft after the operator typed the centre frequency: VFO0 follows it,
 * because the edge takes a centre change only with VFO0 at the same
 * frequency. Typed back to the reported centre, VFO0 returns to its own
 * reported value.
 */
export function draftWithCenter(draft: DraftValues, text: string, reported: ReportedValues): DraftValues {
  const field = fieldFor('center_frequency_hz');
  const next: DraftValues = { ...draft, center_frequency_hz: text };
  const typed = parseTypedNumber(text);
  const known = reported.center_frequency_hz;
  if (typed !== null && typeof known === 'number' && Math.round(typed * field.scale) === Math.round(known)) {
    delete next.vfo0_frequency_hz;
  } else {
    next.vfo0_frequency_hz = text;
  }
  return next;
}

function sameValue(field: ConfigPatchField, left: number, right: number): boolean {
  return field.integer ? Math.round(left) === Math.round(right) : Math.abs(left - right) < 1e-9;
}

/**
 * Parse every field of a draft against the reported values, the ranges and
 * the edge's rules. An empty field is fine only when the node did not report
 * that value (it is then left out); a changed, valid field goes into
 * `changes` in SI units. A centre change takes VFO0 along: VFO0 must then be
 * the same frequency, and is sent even when it did not change.
 */
export function parseDraft(
  fields: readonly ConfigPatchField[],
  draft: DraftValues,
  reported: ReportedValues,
  ranges: ConfigPatchRanges | null | undefined,
  gainTable: readonly number[] = GAIN_TABLE_DB,
): DraftEvaluation {
  const changes: ConfigPatchChanges = {};
  let invalid = false;
  const evaluated = fields.map((field): FieldEvaluation => {
    const text = draft[field.key] ?? '';
    const reportedValue = reported[field.key];
    const known = typeof reportedValue === 'number' && Number.isFinite(reportedValue) ? reportedValue : null;
    if (text.trim() === '') {
      const problem: FieldProblem | null = known === null ? null : 'empty';
      if (problem) invalid = true;
      return { field, text, value: null, reported: known, changed: false, problem };
    }
    const typed = parseTypedNumber(text);
    if (typed === null) {
      invalid = true;
      return { field, text, value: null, reported: known, changed: false, problem: 'number' };
    }
    const scaled = typed * field.scale;
    let value = field.integer ? Math.round(scaled) : Number(scaled.toFixed(3));
    const [min, max] = fieldRange(field, ranges);
    if (value < min || value > max) {
      invalid = true;
      return { field, text, value, reported: known, changed: false, problem: 'range' };
    }
    const changed = known === null || !sameValue(field, value, known);
    if (field.table && changed) {
      const tableValue = gainTableValue(value, gainTable);
      if (tableValue === null) {
        invalid = true;
        return { field, text, value, reported: known, changed: false, problem: 'table' };
      }
      value = tableValue;
    }
    if (changed) changes[field.key] = value;
    return { field, text, value, reported: known, changed, problem: null };
  });
  const center = changes.center_frequency_hz;
  const vfoIndex = evaluated.findIndex((entry) => entry.field.key === 'vfo0_frequency_hz');
  if (center !== undefined && vfoIndex >= 0 && evaluated[vfoIndex].problem === null) {
    const vfo = evaluated[vfoIndex];
    if (vfo.value === null || Math.round(vfo.value) !== Math.round(center)) {
      invalid = true;
      delete changes.vfo0_frequency_hz;
      evaluated[vfoIndex] = { ...vfo, changed: false, problem: 'centerVfo' };
    } else {
      changes.vfo0_frequency_hz = vfo.value;
      evaluated[vfoIndex] = { ...vfo, changed: true, required: !vfo.changed };
    }
  }
  const ordered: ConfigPatchChanges = {};
  for (const field of fields) {
    const value = changes[field.key];
    if (value !== undefined) ordered[field.key] = value;
  }
  return { fields: evaluated, changes: ordered, invalid };
}

/**
 * Error codes of POST /api/mqtt/config-patch and /api/mqtt/config-get, the
 * command status routes and admin login. Every one has a
 * control.error.<CODE> message; a test keeps the two lists in step. Keep this
 * in step with tools/ground_console.py and tools/rdf_node_commands.py.
 */
export const CONFIG_PATCH_ERROR_CODES = [
  'ORIGIN_REJECTED',
  'ADMIN_REQUIRED',
  'INVALID_REQUEST',
  'CONFIRM_REQUIRED',
  'EMPTY_CHANGES',
  'FIELD_NOT_ALLOWED',
  'VALUE_OUT_OF_RANGE',
  'GAIN_NOT_IN_APPROVED_TABLE',
  'CENTER_CHANGE_REQUIRES_VFO0_TARGET',
  'MVP_CENTER_MUST_EQUAL_VFO0',
  'MQTT_MONITOR_DISABLED',
  'MQTT_DEPENDENCY_MISSING',
  'MQTT_NOT_CONNECTED',
  'NODE_SESSION_UNAVAILABLE',
  'NODE_NOT_FRESH',
  'CONFIG_REVISION_UNKNOWN',
  'CONFIG_REVISION_STALE',
  'COMMAND_IN_FLIGHT',
  'SETTINGS_REQUEST_PENDING',
  'CONFIG_GET_TOO_SOON',
  'MQTT_PUBLISH_FAILED',
  'COMMAND_UNKNOWN',
  'ADMIN_LOGIN_THROTTLED',
] as const;

export type ConfigPatchErrorCode = typeof CONFIG_PATCH_ERROR_CODES[number];

export const CONFIG_PATCH_ERROR_KEYS: Record<ConfigPatchErrorCode, MessageKey> = {
  ORIGIN_REJECTED: 'control.error.ORIGIN_REJECTED',
  ADMIN_REQUIRED: 'control.error.ADMIN_REQUIRED',
  INVALID_REQUEST: 'control.error.INVALID_REQUEST',
  CONFIRM_REQUIRED: 'control.error.CONFIRM_REQUIRED',
  EMPTY_CHANGES: 'control.error.EMPTY_CHANGES',
  FIELD_NOT_ALLOWED: 'control.error.FIELD_NOT_ALLOWED',
  VALUE_OUT_OF_RANGE: 'control.error.VALUE_OUT_OF_RANGE',
  GAIN_NOT_IN_APPROVED_TABLE: 'control.error.GAIN_NOT_IN_APPROVED_TABLE',
  CENTER_CHANGE_REQUIRES_VFO0_TARGET: 'control.error.CENTER_CHANGE_REQUIRES_VFO0_TARGET',
  MVP_CENTER_MUST_EQUAL_VFO0: 'control.error.MVP_CENTER_MUST_EQUAL_VFO0',
  MQTT_MONITOR_DISABLED: 'control.error.MQTT_MONITOR_DISABLED',
  MQTT_DEPENDENCY_MISSING: 'control.error.MQTT_DEPENDENCY_MISSING',
  MQTT_NOT_CONNECTED: 'control.error.MQTT_NOT_CONNECTED',
  NODE_SESSION_UNAVAILABLE: 'control.error.NODE_SESSION_UNAVAILABLE',
  NODE_NOT_FRESH: 'control.error.NODE_NOT_FRESH',
  CONFIG_REVISION_UNKNOWN: 'control.error.CONFIG_REVISION_UNKNOWN',
  CONFIG_REVISION_STALE: 'control.error.CONFIG_REVISION_STALE',
  COMMAND_IN_FLIGHT: 'control.error.COMMAND_IN_FLIGHT',
  SETTINGS_REQUEST_PENDING: 'control.error.SETTINGS_REQUEST_PENDING',
  CONFIG_GET_TOO_SOON: 'control.error.CONFIG_GET_TOO_SOON',
  MQTT_PUBLISH_FAILED: 'control.error.MQTT_PUBLISH_FAILED',
  COMMAND_UNKNOWN: 'control.error.COMMAND_UNKNOWN',
  ADMIN_LOGIN_THROTTLED: 'control.error.ADMIN_LOGIN_THROTTLED',
};

export function isConfigPatchErrorCode(value: unknown): value is ConfigPatchErrorCode {
  return typeof value === 'string' && (CONFIG_PATCH_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Codes the RDF Node edge puts in `result.error` of an ACK, with a message
 * where the operator can act on it. The code itself is always shown; an
 * unknown one gets the status's general message.
 */
export const EDGE_ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  TLS_REQUIRED_FOR_SETTINGS_REPORT: 'control.edge.TLS_REQUIRED_FOR_SETTINGS_REPORT',
  SETTINGS_UNAVAILABLE: 'control.edge.SETTINGS_UNAVAILABLE',
  SETTINGS_STALE: 'control.edge.SETTINGS_STALE',
  SETTINGS_REPORT_TOO_LARGE: 'control.edge.SETTINGS_REPORT_TOO_LARGE',
  SETTINGS_REQUEST_PENDING: 'control.error.SETTINGS_REQUEST_PENDING',
  REQUEST_RATE_LIMIT: 'control.error.CONFIG_GET_TOO_SOON',
  SESSION_MISMATCH: 'control.edge.SESSION_MISMATCH',
  EXPIRED_OR_INVALID_DEADLINE: 'control.edge.EXPIRED_OR_INVALID_DEADLINE',
  CLOCK_UNTRUSTED: 'control.edge.CLOCK_UNTRUSTED',
  BUSY: 'control.edge.BUSY',
  REMOTE_COMMANDS_DISABLED: 'control.edge.REMOTE_COMMANDS_DISABLED',
  DEMO_NO_HARDWARE_CONTROL: 'control.edge.DEMO_NO_HARDWARE_CONTROL',
  CONFIG_TARGET_NOT_READY: 'control.edge.CONFIG_TARGET_NOT_READY',
  CONFIG_CHANGED_BEFORE_WRITE: 'control.edge.CONFIG_CHANGED_BEFORE_WRITE',
  EXTERNAL_WRITER_CONFLICT: 'control.edge.CONFIG_CHANGED_BEFORE_WRITE',
  CONTROL_REQUIRES_SINGLE_VFO0: 'control.edge.CONTROL_REQUIRES_SINGLE_VFO0',
  CENTER_CHANGE_REQUIRES_VFO0_TARGET: 'control.error.CENTER_CHANGE_REQUIRES_VFO0_TARGET',
  MVP_CENTER_MUST_EQUAL_VFO0: 'control.error.MVP_CENTER_MUST_EQUAL_VFO0',
  GAIN_NOT_IN_APPROVED_TABLE: 'control.error.GAIN_NOT_IN_APPROVED_TABLE',
  INTEGER_OUT_OF_RANGE: 'control.edge.OUT_OF_RANGE',
  NUMBER_OUT_OF_RANGE: 'control.edge.OUT_OF_RANGE',
  INVALID_PATCH: 'control.error.FIELD_NOT_ALLOWED',
  COMMAND_ID_CONFLICT: 'control.edge.COMMAND_ID_CONFLICT',
};

export function edgeErrorKey(code: string | null | undefined): MessageKey | null {
  return code && Object.prototype.hasOwnProperty.call(EDGE_ERROR_KEYS, code) ? EDGE_ERROR_KEYS[code] : null;
}

/** `info`: neither success nor failure (PERSISTED_UNVERIFIED, OUTCOME_UNKNOWN, no final ACK). */
export type ResultTone = 'ok' | 'info' | 'warn' | 'err';

/** How a final command status reads in Kontrol; all text is chosen by key. */
export interface CommandResultView {
  tone: ResultTone;
  title: { key: MessageKey; vars?: Record<string, string | number> };
  body: { key: MessageKey; vars?: Record<string, string | number> };
  /** The values on the node changed or may have; read them again. */
  reload: boolean;
}

/** Minimal view of a command status, as normalized by api.ts. */
export interface CommandStatusLike {
  state: string;
  pubackReason: number | null;
  ack: { status: string; error: string | null; reason: string | null; revision: number | null } | null;
}

function withCode(status: string, code: string | null): string {
  return code ? `${status} · ${code}` : status;
}

/**
 * Map a final command status to the result Kontrol shows. `changeCount` and
 * `baseRev` describe the command that was sent; `ttlS` its lifetime.
 * APPLIED is the only success; PERSISTED_UNVERIFIED, OUTCOME_UNKNOWN and a
 * missing final ACK are neither success nor failure, and nothing is resent.
 */
export function commandResultView(status: CommandStatusLike, changeCount: number, baseRev: number | null, ttlS: number): CommandResultView {
  const ack = status.ack;
  if (status.state === 'publish_failed') {
    return {
      tone: 'err',
      title: { key: 'control.result.publishFailedTitle' },
      body: { key: 'control.result.publishFailed', vars: { reason: status.pubackReason === null ? '—' : status.pubackReason } },
      reload: false,
    };
  }
  if (status.state === 'no_final_ack') {
    return {
      tone: 'info',
      title: { key: 'control.result.noFinalAckTitle' },
      body: { key: 'control.result.noFinalAck', vars: { status: ack?.status ?? 'ACCEPTED' } },
      reload: true,
    };
  }
  if (status.state === 'no_ack' || !ack) {
    return { tone: 'err', title: { key: 'control.result.noAckTitle' }, body: { key: 'control.result.noAck', vars: { ttl: ttlS } }, reload: false };
  }
  const code = ack.error ?? ack.reason;
  const rev = ack.revision ?? '—';
  if (ack.status === 'APPLIED') {
    return {
      tone: 'ok',
      title: { key: 'control.result.ackTitle', vars: { status: 'APPLIED' } },
      body: { key: 'control.result.applied', vars: { count: changeCount, rev } },
      reload: true,
    };
  }
  if (ack.status === 'PERSISTED_UNVERIFIED') {
    return {
      tone: 'info',
      title: { key: 'control.result.ackTitle', vars: { status: withCode('PERSISTED_UNVERIFIED', ack.reason) } },
      body: { key: 'control.result.persistedUnverified', vars: { rev } },
      reload: true,
    };
  }
  if (ack.status === 'OUTCOME_UNKNOWN') {
    return {
      tone: 'info',
      title: { key: 'control.result.ackTitle', vars: { status: withCode('OUTCOME_UNKNOWN', code) } },
      body: { key: 'control.result.outcomeUnknown' },
      reload: true,
    };
  }
  if (ack.error === 'CONFIG_REVISION_CONFLICT' || (ack.status === 'CONFLICT' && !ack.error)) {
    return {
      tone: 'warn',
      title: { key: 'control.result.rejectedTitle', vars: { code: withCode(ack.status, 'CONFIG_REVISION_CONFLICT') } },
      body: { key: 'control.result.conflict', vars: { rev: baseRev ?? '—' } },
      reload: true,
    };
  }
  const edgeKey = edgeErrorKey(code);
  if (ack.status === 'REJECTED' || ack.status === 'CONFLICT') {
    return {
      tone: 'warn',
      title: { key: 'control.result.rejectedTitle', vars: { code: withCode(ack.status, code) } },
      body: { key: edgeKey ?? 'control.result.rejected' },
      reload: false,
    };
  }
  if (ack.status === 'EXPIRED') {
    return { tone: 'warn', title: { key: 'control.result.ackTitle', vars: { status: withCode('EXPIRED', code) } }, body: { key: 'control.result.expired' }, reload: false };
  }
  if (ack.status === 'CANCELLED') {
    return { tone: 'warn', title: { key: 'control.result.ackTitle', vars: { status: withCode('CANCELLED', code) } }, body: { key: 'control.result.cancelled' }, reload: true };
  }
  return {
    tone: 'err',
    title: { key: 'control.result.ackTitle', vars: { status: withCode(ack.status, code) } },
    body: { key: edgeKey ?? 'control.result.failed' },
    reload: true,
  };
}

/** What Kontrol shows about the latest config.get, or null when there is nothing to say. */
export interface SettingsReadView {
  tone: 'info' | 'warn' | 'err';
  /** The code shown beside the message (an edge error, or the console's state). */
  code: string | null;
  key: MessageKey;
}

/** The latest config.get as Kontrol shows it; a delivered settings report needs no line. */
export function settingsReadView(status: CommandStatusLike | null | undefined): SettingsReadView | null {
  if (!status) return null;
  switch (status.state) {
    case 'published':
    case 'delivered':
    case 'acknowledged':
      return { tone: 'info', code: null, key: 'control.settings.reading' };
    case 'reported':
      return null;
    case 'publish_failed':
      return { tone: 'err', code: status.pubackReason === null ? null : `PUBACK ${status.pubackReason}`, key: 'control.settings.publishFailed' };
    case 'no_ack':
      return { tone: 'warn', code: 'NO ACK', key: 'control.settings.noAck' };
    case 'no_report':
      return { tone: 'warn', code: 'NO REPORT', key: 'control.settings.noReport' };
    default: {
      const code = status.ack?.error ?? status.ack?.reason ?? status.ack?.status ?? null;
      return { tone: 'warn', code, key: edgeErrorKey(code) ?? 'control.settings.refused' };
    }
  }
}

/**
 * Whether Kontrol can publish the admin-confirmed config patch, by the same
 * rule Kontrol applies: only an explicit `config_patch.enabled: false` (no
 * MQTT monitor that can publish) turns the path off. The monitor itself never
 * publishes on its own; pages that describe publishing use this so their copy
 * matches what Kontrol will do.
 */
export function configPatchPublishable(capabilities: ConsoleCapabilities | null | undefined): boolean {
  return capabilities?.configPatch?.enabled !== false;
}
