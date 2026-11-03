/**
 * Fields, units and draft evaluation for Kontrol's config.patch to the RDF
 * Node edge (sdr/v2/<node>/cmd/config/patch), the results of the edge's ACKs,
 * and the codes the console server and the edge answer with. Values on the
 * wire are SI (Hz, dB, m); the form shows MHz and kHz. The field rules are the
 * edge's (tools/rdf_node_commands.py): whole Hz, the gain table, and a centre
 * change takes VFO0 along at the same frequency. The server checks them
 * again; the client copy only gives early feedback.
 */
import type { ConfigSettingsReport, ConsoleCapabilities } from '../api';
import type { MessageKey, Translate } from './i18n';
import { SQUELCH_MODES } from './controlDraft';
import type { ConfigPatchChanges, ConfigPatchChoiceKey, ConfigPatchKey, ConfigPatchNumberKey, ConfigPatchValue, SquelchMode } from './controlDraft';
import { parseTypedNumber } from './polarViewSettings';

interface ConfigPatchFieldBase {
  /** Label of the dry-run form on the Configuration page (SI unit in the label). */
  label: MessageKey;
  /** Label in Kontrol, where the unit stands beside the input. */
  shortLabel: MessageKey;
}

/**
 * A field sent as one of a few exact strings (contract 1.9 vfo0_squelch_mode).
 * Kontrol shows a select with the operator's words; the edge's string is sent.
 */
export interface ChoicePatchField extends ConfigPatchFieldBase {
  kind: 'choice';
  key: ConfigPatchChoiceKey;
  choices: readonly string[];
  /** The operator's words for each value; the value itself is what is sent. */
  optionLabels: Readonly<Record<string, MessageKey>>;
}

/** A field sent as a number in SI units. */
export interface NumberPatchField extends ConfigPatchFieldBase {
  kind: 'number';
  key: ConfigPatchNumberKey;
  /** Fallback range in SI units; the server's capabilities override it. */
  min: number;
  max: number;
  /** Step of the dry-run number input, in SI units. */
  step: number;
  /** Unit shown in Kontrol, and the SI value of one displayed unit. */
  unit: 'MHz' | 'kHz' | 'dB' | 'm';
  scale: number;
  /** Decimals shown for a value in Kontrol. */
  decimals: number;
  /** Decimals of the SI value sent, when not 3 (the edge rounds the UCA radius to 4). */
  sentDecimals?: number;
  /**
   * Sent as a whole number of SI units: frequencies in integer Hz, and since
   * edge 1.9.0 the squelch in whole dB (rdfsdr reads it with int(); the edge
   * rounds a fraction with Python's round(), as wholeNumber() does).
   */
  integer: boolean;
  /** Only these values are accepted (the gain table); Kontrol shows a select. */
  table?: boolean;
}

export type ConfigPatchField = NumberPatchField | ChoicePatchField;

/** The operator's words for each squelch mode; the edge's string is what is sent. */
export const SQUELCH_MODE_KEYS: Readonly<Record<SquelchMode, MessageKey>> = {
  Manual: 'control.squelchMode.manual',
  Auto: 'control.squelchMode.auto',
  'Auto Channel': 'control.squelchMode.autoChannel',
  Default: 'control.squelchMode.default',
};

/** The squelch mode whose level is vfo0_squelch_db; in every other mode the RDF-SDR sets the level itself. */
export const MANUAL_SQUELCH: SquelchMode = 'Manual';

/**
 * The squelch mode rdfsdr runs, as the edge resolves it (source.squelch_is_auto):
 * a missing mode is Default, and Default follows vfo_default_squelch_mode
 * (missing: Auto, rdfsdr's own default).
 */
export function resolvedSquelchMode(mode: unknown, defaultMode?: unknown): unknown {
  const own = mode === undefined || mode === null ? 'Default' : mode;
  if (own !== 'Default') return own;
  return defaultMode === undefined || defaultMode === null ? 'Auto' : defaultMode;
}

/** True when rdfsdr sets VFO0's squelch level itself: Auto or Auto Channel, Default resolved. */
export function squelchIsAuto(mode: unknown, defaultMode?: unknown): boolean {
  const resolved = resolvedSquelchMode(mode, defaultMode);
  return resolved === 'Auto' || resolved === 'Auto Channel';
}

/**
 * What the node reports about its squelch beside the values (edge 1.9):
 * settings/reported's resolved flag and modes, and Data Out's
 * vfo_default_squelch_mode where the report has none.
 */
export interface ReportedSquelch {
  /** The server's squelch_is_auto of a current settings/reported; null without one. */
  auto: boolean | null;
  /** The mode after Default is resolved, from the same report; null when unknown. */
  resolvedMode: string | null;
  /** What Default follows (vfo_default_squelch_mode); null when not reported. */
  defaultMode: string | null;
}

/**
 * The squelch facts beside Kontrol's values: a current settings/reported's
 * (resolved on the server), with Data Out's vfo_default_squelch_mode where
 * the report has none.
 */
export function reportedSquelch(
  settings: Pick<ConfigSettingsReport, 'squelchAuto' | 'squelchModeResolved' | 'defaultSquelchMode'> | null | undefined,
  dataOutDefaultMode: string | null = null,
): ReportedSquelch {
  return {
    auto: settings?.squelchAuto ?? null,
    resolvedMode: settings?.squelchModeResolved ?? null,
    defaultMode: settings?.defaultSquelchMode ?? dataOutDefaultMode,
  };
}

/** The squelch mode Kontrol shows in place of an automatic level, e.g. AUTO or DEFAULT → AUTO CHANNEL. */
export function squelchModeShort(mode: string, resolved: string | null): string {
  if (mode !== 'Default') return mode.toUpperCase();
  return resolved && resolved !== 'Default' ? `DEFAULT → ${resolved.toUpperCase()}` : 'DEFAULT';
}

/**
 * The squelch level as rdfsdr runs it: a Manual squelch is read with int(),
 * which truncates toward zero, so a level of -40.7 dB left in settings.json
 * runs as -40 dB.
 */
export function engineSquelchDb(value: number): number {
  return Math.trunc(value) || 0;
}

/** True for the squelch level in whole dB (edge 1.9.0), whose reported value is truncated as rdfsdr reads it. */
function wholeDbField(field: NumberPatchField): boolean {
  return field.key === 'vfo0_squelch_db' && field.integer;
}

/** The edge helper's gain table; a gain must be within 0.001 dB of one of these. */
export const GAIN_TABLE_DB: readonly number[] = [
  0.0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9, 25.4,
  28.0, 29.7, 32.8, 33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5, 48.0, 49.6,
];
const GAIN_TOLERANCE_DB = 0.001;

/**
 * The edge's safe fields in its order. Ranges mirror rdf_node_commands.PATCH_RANGES.
 * ant_spacing_m (edge 1.8.0) and vfo0_squelch_mode (edge 1.9.0) are offered
 * only to an edge that lists them.
 */
export const CONFIG_PATCH_FIELDS: readonly ConfigPatchField[] = [
  { key: 'center_frequency_hz', kind: 'number', label: 'config.field.center', shortLabel: 'control.field.center', min: 24_000_000, max: 1_766_000_000, step: 1_000, unit: 'MHz', scale: 1e6, decimals: 3, integer: true },
  { key: 'gain_db', kind: 'number', label: 'config.field.gain', shortLabel: 'control.field.gain', min: -10, max: 100, step: 0.1, unit: 'dB', scale: 1, decimals: 1, integer: false, table: true },
  { key: 'vfo0_frequency_hz', kind: 'number', label: 'config.field.vfo', shortLabel: 'control.field.vfo', min: 24_000_000, max: 1_766_000_000, step: 1_000, unit: 'MHz', scale: 1e6, decimals: 3, integer: true },
  { key: 'vfo0_bandwidth_hz', kind: 'number', label: 'config.field.bandwidth', shortLabel: 'control.field.bandwidth', min: 100, max: 2_400_000, step: 100, unit: 'kHz', scale: 1e3, decimals: 1, integer: true },
  { key: 'vfo0_squelch_db', kind: 'number', label: 'config.field.squelch', shortLabel: 'control.field.squelch', min: -200, max: 50, step: 1, unit: 'dB', scale: 1, decimals: 0, integer: true },
  { key: 'ant_spacing_m', kind: 'number', label: 'config.field.uca', shortLabel: 'control.field.uca', min: 0.05, max: 1, step: 0.001, unit: 'm', scale: 1, decimals: 3, sentDecimals: 4, integer: false },
  { key: 'vfo0_squelch_mode', kind: 'choice', label: 'config.field.squelchMode', shortLabel: 'control.field.squelchMode', choices: SQUELCH_MODES, optionLabels: SQUELCH_MODE_KEYS },
];

/** The fields an edge without capabilities.config_fields (before 1.8.0) takes. */
const LEGACY_FIELD_COUNT = 5;

/**
 * The squelch of an edge before 1.9.0, which keeps a fraction as sent: 0.5 dB
 * steps and no rounding, as before (the server rounds only for edge 1.9.0).
 */
const LEGACY_SQUELCH_FIELD: NumberPatchField = { ...(CONFIG_PATCH_FIELDS[4] as NumberPatchField), step: 0.5, integer: false };

/**
 * The Kontrol fields a node takes: those its capabilities.config_fields
 * lists (contract 1.8), in the edge's order, or the five of an older edge that
 * sends no list (tools/rdf_node_commands.py node_patch_fields). The squelch is
 * in whole dB only for an edge that also takes the squelch mode (1.9.0), as
 * rdf_node_commands.node_writes_whole_db() decides on the server.
 */
export function configPatchFieldsFor(configFields: readonly string[] | null | undefined): readonly ConfigPatchField[] {
  const listed = configFields?.length ? CONFIG_PATCH_FIELDS.filter((field) => configFields.includes(field.key)) : [];
  const fields = listed.length ? listed : CONFIG_PATCH_FIELDS.slice(0, LEGACY_FIELD_COUNT);
  return takesSquelchMode(fields) ? fields : fields.map((field) => (field.key === 'vfo0_squelch_db' ? LEGACY_SQUELCH_FIELD : field));
}

/** True when the fields include the UCA radius, so the band rule sets it too. */
export function takesUca(fields: readonly ConfigPatchField[]): boolean {
  return fields.some((field) => field.key === 'ant_spacing_m');
}

/** True when the fields include the squelch mode (edge 1.9.0). */
export function takesSquelchMode(fields: readonly ConfigPatchField[]): boolean {
  return fields.some((field) => field.key === 'vfo0_squelch_mode');
}

export type ConfigPatchRanges = Partial<Record<ConfigPatchNumberKey, readonly [number, number]>>;

/** [min, max] in SI for a field: the server's range when it sent one, else the client copy. */
export function fieldRange(field: NumberPatchField, ranges: ConfigPatchRanges | null | undefined): readonly [number, number] {
  const range = ranges?.[field.key];
  return range && Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[0] < range[1] ? range : [field.min, field.max];
}

export function fieldFor(key: ConfigPatchChoiceKey): ChoicePatchField;
export function fieldFor(key: ConfigPatchNumberKey): NumberPatchField;
export function fieldFor(key: ConfigPatchKey): ConfigPatchField;
export function fieldFor(key: ConfigPatchKey): ConfigPatchField {
  return CONFIG_PATCH_FIELDS.find((field) => field.key === key) as ConfigPatchField;
}

/**
 * Python's round() of the edge: to the nearest whole number, a half to the
 * even one (-40.5 -> -40, -41.5 -> -42), so the console shows the squelch the
 * edge will write.
 */
export function wholeNumber(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** True when an SI value lies in the field's range. */
export function inFieldRange(key: ConfigPatchNumberKey, value: number | null | undefined, ranges?: ConfigPatchRanges | null): boolean {
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

/**
 * A reported SI value as the operator types it: MHz, kHz or dB without
 * trailing zeros; a whole-unit field shows a whole value (the squelch level as
 * rdfsdr runs it, truncated toward zero: a reported -40.7 dB reads -40), and
 * a choice field its exact string.
 */
export function draftText(field: ConfigPatchField, value: ConfigPatchValue | null | undefined): string {
  if (field.kind === 'choice') return typeof value === 'string' && field.choices.includes(value) ? value : '';
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return plainNumber(reportedNumber(field, value) / field.scale);
}

/** A reported number at the precision the field is shown and compared in. */
function reportedNumber(field: NumberPatchField, value: number): number {
  if (!field.integer) return value;
  return wholeDbField(field) ? engineSquelchDb(value) : wholeNumber(value);
}

/** A value for review, hints and the read-back: the operator's words for a choice, an SI value with its unit otherwise. */
export function fieldValueText(t: Translate, field: ConfigPatchField, value: ConfigPatchValue | null | undefined): string {
  if (field.kind === 'choice') {
    if (typeof value !== 'string' || value === '') return '—';
    return Object.prototype.hasOwnProperty.call(field.optionLabels, value) ? t(field.optionLabels[value]) : value;
  }
  return displayValue(field, typeof value === 'number' ? value : null);
}

/** An SI value with its unit for review and hints, using a real minus sign. */
export function displayValue(field: NumberPatchField, siValue: number | null | undefined): string {
  if (typeof siValue !== 'number' || !Number.isFinite(siValue)) return '—';
  const shown = siValue / field.scale;
  // Keep the precision that was typed when it is finer than the default.
  const decimals = Math.max(field.decimals, Math.min(6, (plainNumber(shown).split('.')[1] ?? '').length));
  const text = Math.abs(shown).toFixed(decimals);
  return `${shown < 0 && Number(text) !== 0 ? '−' : ''}${text} ${field.unit}`;
}

/** Range text in display units, e.g. "24 to 1766 MHz" pieces. */
export function rangeParts(field: NumberPatchField, ranges: ConfigPatchRanges | null | undefined): { min: string; max: string; unit: string } {
  const [min, max] = fieldRange(field, ranges);
  const format = (value: number) => {
    const text = plainNumber(Math.abs(value / field.scale), 3);
    return value < 0 ? `−${text}` : text;
  };
  return { min: format(min), max: format(max), unit: field.unit };
}

export type DraftValues = Partial<Record<ConfigPatchKey, string>>;
export type ReportedValues = Partial<Record<ConfigPatchKey, ConfigPatchValue | null>>;

/**
 * `table`: a gain the edge's table does not have; `centerVfo`: the centre
 * changes and VFO0 is not the same frequency (the edge requires both, equal);
 * `choice`: a value a choice field does not have.
 */
export type FieldProblem = 'empty' | 'number' | 'range' | 'table' | 'centerVfo' | 'choice';

export interface FieldEvaluation {
  field: ConfigPatchField;
  text: string;
  /** Parsed SI value (a choice field: its string), or null. */
  value: ConfigPatchValue | null;
  reported: ConfigPatchValue | null;
  changed: boolean;
  problem: FieldProblem | null;
  /** Sent although unchanged: VFO0 goes along with a centre change. */
  required?: boolean;
  /** The squelch level while the squelch is automatic: the RDF-SDR sets it, so it is never sent. */
  locked?: boolean;
  /** With `locked`: the mode shown in place of the level (AUTO, AUTO CHANNEL, DEFAULT → AUTO). */
  lockedText?: string;
  /**
   * The current value shown in place of the reported level while the reported
   * squelch is automatic (the level in settings.json does not run then).
   */
  reportedText?: string;
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

/**
 * Merge SI changes (from the spectrum dock, or a change reviewed again) into
 * a draft as display text. A squelch level without a mode sets the mode to
 * Manual where the node takes one, as the edge itself does.
 */
export function mergeIntoDraft(draft: DraftValues, changes: ConfigPatchChanges, fields: readonly ConfigPatchField[] = CONFIG_PATCH_FIELDS): DraftValues {
  const next: DraftValues = { ...draft };
  for (const field of fields) {
    const text = draftText(field, changes[field.key]);
    if (text !== '') next[field.key] = text;
  }
  if (next.vfo0_squelch_db !== draft.vfo0_squelch_db && changes.vfo0_squelch_mode === undefined && takesSquelchMode(fields)) {
    next.vfo0_squelch_mode = MANUAL_SQUELCH;
  }
  return next;
}

/**
 * A draft after the operator typed a squelch level: where the node takes a
 * squelch mode, the mode becomes Manual, since only a Manual squelch uses the
 * level (the edge switches an automatic squelch to Manual for a level anyway).
 */
export function draftWithSquelchLevel(draft: DraftValues, text: string, fields: readonly ConfigPatchField[]): DraftValues {
  const next: DraftValues = { ...draft, vfo0_squelch_db: text };
  if (takesSquelchMode(fields)) next.vfo0_squelch_mode = MANUAL_SQUELCH;
  return next;
}

/**
 * The operator's band rules (2 November): within a band a new centre
 * frequency takes that band's receiver gain and UCA radius. The gains are the
 * edge's gain table values nearest the rule's 15 and 25 dB, the ones the
 * KrakenSDR engine itself uses there. Outside both bands nothing else changes.
 */
export interface BandRule {
  id: 'VHF' | 'UHF';
  minHz: number;
  maxHz: number;
  gainDb: number;
  /** UCA radius in metres; sent only to an edge that takes ant_spacing_m (1.8.0). */
  ucaM: number;
}

export const BAND_RULES: readonly BandRule[] = [
  { id: 'VHF', minHz: 136_000_000, maxHz: 174_000_000, gainDb: 25.4, ucaM: 0.3 },
  { id: 'UHF', minHz: 400_000_000, maxHz: 480_000_000, gainDb: 15.7, ucaM: 0.128 },
];

export function bandRuleFor(hz: number | null | undefined): BandRule | null {
  if (typeof hz !== 'number' || !Number.isFinite(hz)) return null;
  return BAND_RULES.find((rule) => hz >= rule.minHz && hz <= rule.maxHz) ?? null;
}

/**
 * A draft whose new centre lies in a band: the gain follows the band rule,
 * and with `withUca` (an edge that takes ant_spacing_m) the UCA radius too.
 */
export function draftWithBand(draft: DraftValues, centerHz: ConfigPatchValue | null | undefined, withUca = false): DraftValues {
  if (typeof centerHz !== 'number') return draft;
  const rule = bandRuleFor(centerHz);
  if (!rule) return draft;
  const next: DraftValues = { ...draft, gain_db: draftText(fieldFor('gain_db'), rule.gainDb) };
  if (withUca) next.ant_spacing_m = draftText(fieldFor('ant_spacing_m'), rule.ucaM);
  return next;
}

/**
 * A draft after the operator typed the centre frequency: VFO0 follows it,
 * because the edge takes a centre change only with VFO0 at the same
 * frequency. Typed back to the reported centre, VFO0 returns to its own
 * reported value. A new centre in a band also takes the band's gain (and,
 * with `withUca`, its UCA radius; draftWithBand), which go back with the centre.
 */
export function draftWithCenter(draft: DraftValues, text: string, reported: ReportedValues, withUca = false): DraftValues {
  const field = fieldFor('center_frequency_hz');
  const next: DraftValues = { ...draft, center_frequency_hz: text };
  const typed = parseTypedNumber(text);
  const known = reported.center_frequency_hz;
  if (typed !== null && typeof known === 'number' && Math.round(typed * field.scale) === Math.round(known)) {
    // Back on the reported centre, VFO0 and the gain return to their reported values too.
    delete next.vfo0_frequency_hz;
    delete next.gain_db;
    if (withUca) delete next.ant_spacing_m;
    return next;
  }
  next.vfo0_frequency_hz = text;
  // A new centre in a band takes the band's gain and UCA (the operator can still pick another).
  return typed === null ? next : draftWithBand(next, typed * field.scale, withUca);
}

/** A typed value (rounded as the edge rounds it) against a reported one (as the field shows it). */
function sameValue(field: NumberPatchField, typed: number, reported: number): boolean {
  return field.integer ? wholeNumber(typed) === reportedNumber(field, reported) : Math.abs(typed - reported) < 1e-9;
}

/**
 * The squelch mode that locks the level, or null: an unchanged mode while
 * the reported squelch is automatic (the server's flag, else the edge's rule
 * on the reported mode), or a mode picked now that is Auto or Auto Channel,
 * or Default when what it follows is known and automatic. Default following
 * Manual (or an unknown default) leaves the level editable.
 */
function squelchLock(mode: FieldEvaluation | undefined, squelch: ReportedSquelch | null): string | null {
  if (!mode || mode.problem !== null) return null;
  const defaultMode = squelch?.defaultMode ?? null;
  if (mode.changed) {
    const picked = mode.value;
    if (picked === 'Auto' || picked === 'Auto Channel') return squelchModeShort(picked, picked);
    if (picked === 'Default' && defaultMode !== null && squelchIsAuto(picked, defaultMode)) return squelchModeShort(picked, defaultMode);
    return null;
  }
  return reportedSquelchText(mode, squelch);
}

/** The reported squelch mode when the reported squelch is automatic (its level then counts for nothing), else null. */
function reportedSquelchText(mode: FieldEvaluation | undefined, squelch: ReportedSquelch | null): string | null {
  if (!mode) return null;
  const defaultMode = squelch?.defaultMode ?? null;
  const reported = typeof mode.reported === 'string' ? mode.reported : null;
  const auto = typeof squelch?.auto === 'boolean' ? squelch.auto : reported !== null && squelchIsAuto(reported, defaultMode);
  if (!auto) return null;
  const shown = reported ?? 'Default';
  const resolved = squelch?.resolvedMode ?? resolvedSquelchMode(shown, defaultMode);
  return squelchModeShort(shown, typeof resolved === 'string' ? resolved : null);
}

function evaluateChoice(field: ChoicePatchField, text: string, reportedValue: ConfigPatchValue | null | undefined): FieldEvaluation {
  const known = typeof reportedValue === 'string' && field.choices.includes(reportedValue) ? reportedValue : null;
  if (text.trim() === '') return { field, text, value: null, reported: known, changed: false, problem: known === null ? null : 'empty' };
  if (!field.choices.includes(text)) return { field, text, value: null, reported: known, changed: false, problem: 'choice' };
  return { field, text, value: text, reported: known, changed: text !== known, problem: null };
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
  squelch: ReportedSquelch | null = null,
): DraftEvaluation {
  const changes: ConfigPatchChanges = {};
  const evaluated = fields.map((field): FieldEvaluation => {
    const text = draft[field.key] ?? '';
    const reportedValue = reported[field.key];
    if (field.kind === 'choice') {
      const entry = evaluateChoice(field, text, reportedValue);
      if (entry.changed && typeof entry.value === 'string') changes[field.key] = entry.value;
      return entry;
    }
    // A reported squelch level as rdfsdr runs it (whole dB, truncated); other values as reported.
    const known = typeof reportedValue === 'number' && Number.isFinite(reportedValue)
      ? (wholeDbField(field) ? engineSquelchDb(reportedValue) : reportedValue) : null;
    if (text.trim() === '') {
      const problem: FieldProblem | null = known === null ? null : 'empty';
      return { field, text, value: null, reported: known, changed: false, problem };
    }
    const typed = parseTypedNumber(text);
    if (typed === null) {
      return { field, text, value: null, reported: known, changed: false, problem: 'number' };
    }
    const scaled = typed * field.scale;
    let value = field.integer ? wholeNumber(scaled) : Number(scaled.toFixed(field.sentDecimals ?? 3));
    const [min, max] = fieldRange(field, ranges);
    // A value typed in SI units (dB, m) is checked before rounding, as the edge's
    // finite(value, low, high) does; MHz and kHz are checked once converted to whole Hz.
    const checked = field.scale === 1 ? scaled : value;
    if (checked < min || checked > max) {
      return { field, text, value, reported: known, changed: false, problem: 'range' };
    }
    // The reported value at the precision a typed one is sent with: a reported
    // 0.21125 m is not a change from the 0.2112 m its own text reads back as.
    const knownSent = known === null || field.integer ? known : Number(known.toFixed(field.sentDecimals ?? 3));
    const changed = knownSent === null || !sameValue(field, value, knownSent);
    if (field.table && changed) {
      const tableValue = gainTableValue(value, gainTable);
      if (tableValue === null) {
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
    if (typeof vfo.value !== 'number' || typeof center !== 'number' || Math.round(vfo.value) !== Math.round(center)) {
      delete changes.vfo0_frequency_hz;
      evaluated[vfoIndex] = { ...vfo, changed: false, problem: 'centerVfo' };
    } else {
      changes.vfo0_frequency_hz = vfo.value;
      evaluated[vfoIndex] = { ...vfo, changed: true, required: !vfo.changed };
    }
  }
  // Contract 1.9: an automatic squelch sets its level itself, so the level is
  // neither checked nor sent then (squelchLock()); the mode is shown instead.
  const modeEntry = evaluated.find((entry) => entry.field.key === 'vfo0_squelch_mode');
  const lockedText = squelchLock(modeEntry, squelch);
  const reportedText = reportedSquelchText(modeEntry, squelch);
  const squelchIndex = evaluated.findIndex((entry) => entry.field.key === 'vfo0_squelch_db');
  if (lockedText !== null && squelchIndex >= 0) {
    delete changes.vfo0_squelch_db;
    evaluated[squelchIndex] = { ...evaluated[squelchIndex], changed: false, problem: null, locked: true, lockedText };
  }
  if (reportedText !== null && squelchIndex >= 0) evaluated[squelchIndex] = { ...evaluated[squelchIndex], reportedText };
  const ordered: ConfigPatchChanges = {};
  for (const field of fields) {
    const value = changes[field.key];
    if (value !== undefined) ordered[field.key] = value;
  }
  return { fields: evaluated, changes: ordered, invalid: evaluated.some((entry) => entry.problem !== null) };
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
  'SQUELCH_MODE_INVALID',
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
  SQUELCH_MODE_INVALID: 'control.error.SQUELCH_MODE_INVALID',
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
  // Edge 1.8.0: in VHF/UHF the KrakenSDR engine sets the UCA radius itself (result.band_spacing_m names it).
  SPACING_SET_BY_ENGINE_BAND: 'control.edge.SPACING_SET_BY_ENGINE_BAND',
  // Edge 1.9.0: a squelch mode other than Manual, Auto, Auto Channel or Default.
  SQUELCH_MODE_INVALID: 'control.error.SQUELCH_MODE_INVALID',
};

const SPACING_SET_BY_ENGINE_BAND = 'SPACING_SET_BY_ENGINE_BAND';

/** The message of an edge error code, with the band's UCA radius when the edge named it. */
function edgeErrorBody(code: string | null, bandSpacingM: number | null | undefined): CommandResultView['body'] | null {
  if (code === SPACING_SET_BY_ENGINE_BAND && typeof bandSpacingM === 'number') {
    return { key: 'control.result.spacingSetByBand', vars: { spacing: plainNumber(bandSpacingM, 4) } };
  }
  const key = edgeErrorKey(code);
  return key ? { key } : null;
}

export function edgeErrorKey(code: string | null | undefined): MessageKey | null {
  return code && Object.prototype.hasOwnProperty.call(EDGE_ERROR_KEYS, code) ? EDGE_ERROR_KEYS[code] : null;
}

/**
 * The edge puts the class name of an exception its settings helper raised
 * in `result.error`, upper-cased (OSERROR, FILENOTFOUNDERROR,
 * PERMISSIONERROR, TIMEOUTEXPIRED...). Such a code means the helper on the
 * Raspberry could not run, not that the values were refused.
 */
export function edgeHelperFault(code: string | null | undefined): boolean {
  return typeof code === 'string' && /^(?:[A-Z][A-Z0-9]*ERROR|TIMEOUTEXPIRED|CALLEDPROCESSERROR)$/u.test(code);
}

/** `info`: neither success nor failure (PERSISTED_UNVERIFIED, OUTCOME_UNKNOWN, no final ACK). */
export type ResultTone = 'ok' | 'info' | 'warn' | 'err';

/** How a final command status reads in Kontrol; all text is chosen by key. */
export interface CommandResultView {
  tone: ResultTone;
  /** The outcome in the operator's words. */
  title: { key: MessageKey; vars?: Record<string, string | number> };
  body: { key: MessageKey; vars?: Record<string, string | number> };
  /** The raw codes (the edge's status and error, a PUBACK reason), shown under the result. */
  code: string | null;
  /** The values on the node changed or may have; read them again. */
  reload: boolean;
  /** The node's settings changed after the base revision was read: the same change can be reviewed again on the new one. */
  rebase?: boolean;
}

/** Minimal view of a command status, as normalized by api.ts. */
export interface CommandStatusLike {
  state: string;
  pubackReason: number | null;
  ack: {
    status: string;
    error: string | null;
    reason: string | null;
    revision: number | null;
    /** Contract 1.7: LIVE, RESTART or FILE. */
    method?: string | null;
    liveFailure?: string | null;
    proof?: Readonly<Record<string, string>> | string | null;
    /** Contract 1.8: the UCA radius the engine's band rule set with the patch, or requires. */
    bandSpacingM?: number | null;
    /** Contract 1.9: the squelch mode a level sent while the squelch was automatic switched it to (Manual). */
    squelchMode?: string | null;
  } | null;
}

function withCode(status: string, code: string | null): string {
  return code ? `${status} · ${code}` : status;
}

/**
 * The raw line of a contract 1.7 answer: status, method, the reason or error,
 * why a live retune did not hold, and the DAQ and settings proof.
 */
function rawCodes(ack: NonNullable<CommandStatusLike['ack']>, code: string | null): string {
  const parts = [ack.status, ack.method ?? null, code, ack.liveFailure ? `live ${ack.liveFailure}` : null];
  const proof = ack.proof;
  if (ack.method && proof && typeof proof === 'object') {
    for (const key of ['daq', 'settings'] as const) {
      if (typeof proof[key] === 'string') parts.push(`${key} ${proof[key]}`);
    }
  }
  return parts.filter((part): part is string => Boolean(part)).join(' · ');
}

const RESTART_REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  GAIN_CHANGE: 'control.reason.GAIN_CHANGE',
  LARGE_FREQUENCY_JUMP: 'control.reason.LARGE_FREQUENCY_JUMP',
  'LIVE_FAILED:DAQ_NOT_HEALTHY_AFTER_RETUNE': 'control.reason.DAQ_NOT_HEALTHY_AFTER_RETUNE',
};
const ENGINE_OVERRODE_PREFIX = 'LIVE_FAILED:ENGINE_OVERRODE:';

/**
 * Why the edge restarts the SDR engine for a config.patch, in the operator's
 * words: a gain change, a jump above its live-retune limit, or a live retune
 * the engine overrode (naming the field) or that left the DAQ unhealthy.
 * Anything else is shown as the edge sent it.
 */
export function restartReasonText(t: Translate, reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (Object.prototype.hasOwnProperty.call(RESTART_REASON_KEYS, reason)) return t(RESTART_REASON_KEYS[reason]);
  if (reason.startsWith(ENGINE_OVERRODE_PREFIX)) {
    const field = reason.slice(ENGINE_OVERRODE_PREFIX.length);
    const known = CONFIG_PATCH_FIELDS.find((entry) => entry.key === field);
    return t('control.reason.ENGINE_OVERRODE', { field: known ? t(known.shortLabel) : field });
  }
  return reason;
}

/**
 * The step a contract 1.7 edge is on while it applies a config.patch, or
 * null when its ACK says no more than the status: VERIFYING a live retune,
 * or APPLYING / VERIFYING a restart of the SDR engine with its reason.
 */
export function commandStageText(t: Translate, ack: CommandStatusLike['ack']): string | null {
  if (!ack || (ack.status !== 'APPLYING' && ack.status !== 'VERIFYING')) return null;
  if (ack.method === 'LIVE') return t('control.stage.live');
  if (ack.method === 'RESTART') {
    const reason = restartReasonText(t, ack.reason);
    return reason ? t('control.stage.restartReason', { reason }) : t('control.stage.restart');
  }
  return null;
}

/**
 * The UCA radius the edge wrote with a patch inside a band (contract 1.8):
 * the KrakenSDR engine sets it there itself, so the edge keeps settings.json
 * in step. Null without one, and for the refusal that names the band radius.
 */
export function bandSpacingText(t: Translate, ack: CommandStatusLike['ack']): string | null {
  if (!ack || typeof ack.bandSpacingM !== 'number' || ack.error === SPACING_SET_BY_ENGINE_BAND) return null;
  return t('control.result.bandSpacing', { spacing: plainNumber(ack.bandSpacingM, 4) });
}

/**
 * The squelch mode the edge switched to with a patch (contract 1.9): a level
 * sent while the squelch was automatic makes it Manual. Null without one.
 */
export function squelchModeText(t: Translate, ack: CommandStatusLike['ack']): string | null {
  if (!ack || typeof ack.squelchMode !== 'string' || !ack.squelchMode) return null;
  return t('control.result.squelchMode', { mode: fieldValueText(t, fieldFor('vfo0_squelch_mode'), ack.squelchMode) });
}

/** How an APPLIED config.patch was applied (contract 1.7), or null for an older edge. */
export function appliedMethodText(t: Translate, ack: CommandStatusLike['ack']): string | null {
  if (!ack || ack.status !== 'APPLIED') return null;
  if (ack.method === 'LIVE') return t('control.result.method.live');
  if (ack.method === 'RESTART') {
    const reason = restartReasonText(t, ack.reason);
    return reason ? t('control.result.method.restartReason', { reason }) : t('control.result.method.restart');
  }
  return null;
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
      code: status.pubackReason === null ? null : `PUBACK ${status.pubackReason}`,
      reload: false,
    };
  }
  if (status.state === 'no_final_ack') {
    return {
      tone: 'info',
      title: { key: 'control.result.noFinalAckTitle' },
      body: { key: 'control.result.noFinalAck', vars: { status: ack?.status ?? 'ACCEPTED' } },
      code: ack?.status ?? null,
      reload: true,
    };
  }
  if (status.state === 'no_ack' || !ack) {
    return { tone: 'err', title: { key: 'control.result.noAckTitle' }, body: { key: 'control.result.noAck', vars: { ttl: ttlS } }, code: 'NO ACK', reload: false };
  }
  const code = ack.error ?? ack.reason;
  // A contract 1.7 answer also names its method; an older one keeps the plain line.
  const plain = ack.method || ack.liveFailure ? rawCodes(ack, code) : withCode(ack.status, code);
  // Contract 1.8: the band radius the edge named; contract 1.9: the squelch mode it switched to.
  const spaced = typeof ack.bandSpacingM === 'number' ? `${plain} · band_spacing_m ${plainNumber(ack.bandSpacingM, 4)}` : plain;
  const raw = ack.squelchMode ? `${spaced} · squelch_mode ${ack.squelchMode}` : spaced;
  const rev = ack.revision ?? '—';
  const helper = edgeHelperFault(ack.error);
  if (ack.status === 'APPLIED') {
    return { tone: 'ok', title: { key: 'control.result.title.applied' }, body: { key: 'control.result.applied', vars: { count: changeCount, rev } }, code: raw, reload: true };
  }
  if (ack.status === 'PERSISTED_UNVERIFIED') {
    // Contract 1.7 names why there is no runtime proof: the engine was not running, or changed a value at its start.
    const body: MessageKey = ack.reason === 'ENGINE_NOT_RUNNING' ? 'control.result.persistedEngineStopped'
      : ack.error === 'ENGINE_OVERRODE_AT_START' ? 'control.result.persistedEngineOverrode' : 'control.result.persistedUnverified';
    return { tone: 'info', title: { key: 'control.result.title.persisted' }, body: { key: body, vars: { rev } }, code: raw, reload: true };
  }
  if (ack.status === 'OUTCOME_UNKNOWN') {
    // Name the likely cause: the helper did not run, the link dropped while
    // applying, or (1.7) the engine did not stop or its DAQ did not recover.
    const body: MessageKey = ack.error === 'ENGINE_DID_NOT_STOP' ? 'control.result.outcomeEngineDidNotStop'
      : ack.error === 'DAQ_NOT_HEALTHY_AFTER_RESTART' ? 'control.result.outcomeDaqAfterRestart'
        : helper ? 'control.result.outcomeUnknownHelper'
          : ack.reason === 'CONNECTION_LOST' ? 'control.result.outcomeUnknownLink' : 'control.result.outcomeUnknown';
    return { tone: 'info', title: { key: 'control.result.title.unknown' }, body: { key: body, vars: { code: code ?? '—' } }, code: raw, reload: true };
  }
  if (ack.error === 'CONFIG_REVISION_CONFLICT' || (ack.status === 'CONFLICT' && !ack.error)) {
    return {
      tone: 'warn',
      title: { key: 'control.result.title.conflict' },
      body: { key: 'control.result.conflict', vars: { rev: baseRev ?? '—' } },
      code: withCode(ack.status, 'CONFIG_REVISION_CONFLICT'),
      reload: true,
      rebase: true,
    };
  }
  const edgeBody = edgeErrorBody(code, ack.bandSpacingM);
  if (ack.status === 'REJECTED' || ack.status === 'CONFLICT') {
    return { tone: 'warn', title: { key: 'control.result.title.rejected' }, body: edgeBody ?? { key: 'control.result.rejected' }, code: raw, reload: false };
  }
  if (ack.status === 'EXPIRED') {
    return { tone: 'warn', title: { key: 'control.result.title.expired' }, body: { key: 'control.result.expired' }, code: raw, reload: false };
  }
  if (ack.status === 'CANCELLED') {
    return { tone: 'warn', title: { key: 'control.result.title.cancelled' }, body: { key: 'control.result.cancelled' }, code: raw, reload: true };
  }
  if (ack.status === 'FAILED') {
    return {
      tone: 'err',
      title: { key: 'control.result.title.failed' },
      body: helper ? { key: 'control.result.failedHelper', vars: { code: code ?? '—' } } : edgeBody ?? { key: 'control.result.failed' },
      code: raw,
      reload: true,
    };
  }
  // A status this console does not know: not a success; show the code as the edge sent it.
  return { tone: 'info', title: { key: 'control.result.ackTitle', vars: { status: ack.status } }, body: { key: 'control.result.outcomeUnknown', vars: { code: code ?? '—' } }, code: raw, reload: true };
}

/** What Kontrol shows about the latest config.get, or null when there is nothing to say. */
export interface SettingsReadView {
  tone: 'info' | 'warn' | 'err';
  /** The code shown beside the message (an edge error, or the console's state). */
  code: string | null;
  key: MessageKey;
}

/** The latest config.get as Kontrol shows it; a delivered settings report needs no line. */
/**
 * Over Telemetry LoRa a config.get can be lost on the way to the RDF-SDR (the radio is half-duplex), and
 * then nothing answers it. A config.get only reads, so Kontrol asks again, at most this many times in
 * all (owner's decision of 2026-11-02). A config.patch is never resent.
 */
export const SETTINGS_GET_LORA_TRIES = 3;

/** Whether Kontrol asks for the settings again: a config.get over LoRa ended without any answer. */
export function settingsGetRetry(
  status: Pick<CommandStatusLike, 'state'> & { commandId?: string; final?: boolean } | null | undefined,
  overLora: boolean,
  tries: number,
): boolean {
  return overLora && status?.final === true && status.state === 'no_ack' && tries < SETTINGS_GET_LORA_TRIES;
}

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
      return { tone: 'warn', code, key: edgeErrorKey(code) ?? (edgeHelperFault(code) ? 'control.settings.helper' : 'control.settings.refused') };
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
