/**
 * Fields, units and draft evaluation for the sdr/v1 cmd/config/patch that
 * Kontrol sends, plus the codes the console server and the edge agent can
 * answer with. Values on the wire are SI (Hz, dB); the form shows MHz and kHz.
 * The server re-checks the allowlist and ranges; the client copy only gives
 * early feedback.
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
}

/** The allowlist in contract order. Ranges mirror sdr_doa_mqtt.CONFIG_RANGES. */
export const CONFIG_PATCH_FIELDS: readonly ConfigPatchField[] = [
  { key: 'center_frequency_hz', label: 'config.field.center', shortLabel: 'control.field.center', min: 24_000_000, max: 1_800_000_000, step: 1_000, unit: 'MHz', scale: 1e6, decimals: 3, integer: true },
  { key: 'gain_db', label: 'config.field.gain', shortLabel: 'control.field.gain', min: -100, max: 60, step: 0.5, unit: 'dB', scale: 1, decimals: 1, integer: false },
  { key: 'vfo_frequency_hz', label: 'config.field.vfo', shortLabel: 'control.field.vfo', min: 24_000_000, max: 1_800_000_000, step: 1_000, unit: 'MHz', scale: 1e6, decimals: 3, integer: true },
  { key: 'vfo_bandwidth_hz', label: 'config.field.bandwidth', shortLabel: 'control.field.bandwidth', min: 100, max: 2_400_000, step: 100, unit: 'kHz', scale: 1e3, decimals: 1, integer: true },
  { key: 'vfo_squelch_db', label: 'config.field.squelch', shortLabel: 'control.field.squelch', min: -200, max: 20, step: 0.5, unit: 'dB', scale: 1, decimals: 0, integer: false },
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

/** Range text in display units, e.g. "24 to 1800 MHz" pieces. */
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

export type FieldProblem = 'empty' | 'number' | 'range';

export interface FieldEvaluation {
  field: ConfigPatchField;
  text: string;
  /** Parsed SI value, or null. */
  value: number | null;
  reported: number | null;
  changed: boolean;
  problem: FieldProblem | null;
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

function sameValue(field: ConfigPatchField, left: number, right: number): boolean {
  return field.integer ? Math.round(left) === Math.round(right) : Math.abs(left - right) < 1e-9;
}

/**
 * Parse every field of a draft against the reported values and the ranges.
 * An empty field is fine only when the node did not report that value (it
 * is then left out); a changed, valid field goes into `changes` in SI units.
 */
export function parseDraft(
  fields: readonly ConfigPatchField[],
  draft: DraftValues,
  reported: ReportedValues,
  ranges: ConfigPatchRanges | null | undefined,
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
    const value = field.integer ? Math.round(scaled) : Number(scaled.toFixed(3));
    const [min, max] = fieldRange(field, ranges);
    if (value < min || value > max) {
      invalid = true;
      return { field, text, value, reported: known, changed: false, problem: 'range' };
    }
    const changed = known === null || !sameValue(field, value, known);
    if (changed) changes[field.key] = value;
    return { field, text, value, reported: known, changed, problem: null };
  });
  return { fields: evaluated, changes, invalid };
}

/**
 * Error codes of POST /api/mqtt/config-patch, the command status routes and
 * admin login. Every one has a control.error.<CODE> message; a test keeps
 * the two lists in step. Keep this in step with tools/ground_console.py.
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

export type ResultTone = 'ok' | 'warn' | 'err';

/** How a final command status reads in Kontrol; all text is chosen by key. */
export interface CommandResultView {
  tone: ResultTone;
  title: { key: MessageKey; vars?: Record<string, string | number> };
  body: { key: MessageKey; vars?: Record<string, string | number> };
  /** The values on the node changed or may have; reload the reported values. */
  reload: boolean;
}

/** Minimal view of a command status, as normalized by api.ts. */
export interface CommandStatusLike {
  state: string;
  pubackReason: number | null;
  ack: { status: string; configRev: number | null; errorCode: string | null; currentConfigRev: number | null; changedFields: readonly string[] } | null;
}

const REMOTE_DISABLED_CODES = new Set(['REMOTE_CONTROL_DISABLED', 'CONTROL_DISABLED', 'REMOTE_CONTROL_NOT_ENABLED']);

/**
 * Map a final command status to the result Kontrol shows. `changeCount` and
 * `baseRev` describe the command that was sent; `ttlS` its lifetime.
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
  if (status.state === 'no_ack' || !ack) {
    return { tone: 'err', title: { key: 'control.result.noAckTitle' }, body: { key: 'control.result.noAck', vars: { ttl: ttlS } }, reload: false };
  }
  const code = ack.errorCode ?? ack.status.toUpperCase();
  if (ack.status === 'applied') {
    const count = ack.changedFields.length || changeCount;
    return {
      tone: 'ok',
      title: { key: 'control.result.ackTitle', vars: { status: 'applied' } },
      body: { key: 'control.result.applied', vars: { count, rev: ack.configRev ?? '—' } },
      reload: true,
    };
  }
  if (ack.status === 'conflict' || ack.errorCode === 'CONFIG_REVISION_CONFLICT') {
    return {
      tone: 'warn',
      title: { key: 'control.result.rejectedTitle', vars: { code: 'CONFIG_REVISION_CONFLICT' } },
      body: { key: 'control.result.conflict', vars: { rev: baseRev ?? '—' } },
      reload: true,
    };
  }
  if (ack.errorCode !== null && REMOTE_DISABLED_CODES.has(ack.errorCode)) {
    return { tone: 'warn', title: { key: 'control.result.rejectedTitle', vars: { code: ack.errorCode } }, body: { key: 'control.result.remoteDisabled' }, reload: false };
  }
  if (ack.status === 'rejected') {
    return { tone: 'warn', title: { key: 'control.result.rejectedTitle', vars: { code } }, body: { key: 'control.result.rejected' }, reload: false };
  }
  if (ack.status === 'expired') {
    return { tone: 'warn', title: { key: 'control.result.ackTitle', vars: { status: ack.errorCode ? `expired · ${ack.errorCode}` : 'expired' } }, body: { key: 'control.result.expired' }, reload: false };
  }
  return {
    tone: 'err',
    title: { key: 'control.result.ackTitle', vars: { status: ack.errorCode ? `${ack.status} · ${ack.errorCode}` : ack.status } },
    body: { key: 'control.result.failed' },
    reload: true,
  };
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
