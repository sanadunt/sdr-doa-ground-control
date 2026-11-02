/**
 * Draft request handed from the Overview spectrum dock ("Kirim ke RDF-SDR")
 * to the Kontrol panel. It only pre-fills the Kontrol draft; nothing is sent
 * until the operator unlocks admin, reviews the change and confirms it there.
 */

/**
 * The RDF Node edge's safe fields for config.patch, in its own order and SI
 * units (Hz, dB, m); tools/rdf_node_commands.py PATCH_FIELDS. ant_spacing_m
 * (the UCA radius) came with edge 1.8.0 and vfo0_squelch_mode with edge 1.9.0;
 * each goes only to an edge whose capabilities.config_fields lists it
 * (configPatchFieldsFor()).
 */
export const CONFIG_PATCH_KEYS = ['center_frequency_hz', 'gain_db', 'vfo0_frequency_hz', 'vfo0_bandwidth_hz', 'vfo0_squelch_db', 'ant_spacing_m', 'vfo0_squelch_mode'] as const;

export type ConfigPatchKey = typeof CONFIG_PATCH_KEYS[number];

/** The field carried as text (contract 1.9), and the fields carried as numbers. */
export type ConfigPatchChoiceKey = 'vfo0_squelch_mode';
export type ConfigPatchNumberKey = Exclude<ConfigPatchKey, ConfigPatchChoiceKey>;

/**
 * The squelch modes edge 1.9.0 takes for vfo0_squelch_mode, exactly as sent
 * (rdf_node_commands.SQUELCH_MODES). Manual uses vfo0_squelch_db; Auto, Auto
 * Channel and Default (rdfsdr's default, Auto) set the level themselves.
 */
export const SQUELCH_MODES = ['Manual', 'Auto', 'Auto Channel', 'Default'] as const;

export type SquelchMode = typeof SQUELCH_MODES[number];

export function isSquelchMode(value: unknown): value is SquelchMode {
  return typeof value === 'string' && (SQUELCH_MODES as readonly string[]).includes(value);
}

/** Fields carried as one of a few exact strings instead of a number. */
export const CONFIG_PATCH_CHOICES: Readonly<Record<ConfigPatchChoiceKey, readonly string[]>> = {
  vfo0_squelch_mode: SQUELCH_MODES,
};

/** A config.patch value: a number in SI units, or the exact string of a choice field. */
export type ConfigPatchValue = number | string;

export type ConfigPatchChanges = Partial<Record<ConfigPatchKey, ConfigPatchValue>>;

/** A value the field takes: one of its strings for a choice field, a finite number otherwise; else null. */
export function configPatchValue(key: ConfigPatchKey, value: unknown): ConfigPatchValue | null {
  const choices = key in CONFIG_PATCH_CHOICES ? CONFIG_PATCH_CHOICES[key as ConfigPatchChoiceKey] : null;
  if (choices) return typeof value === 'string' && choices.includes(value) ? value : null;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface ControlDraftRequest {
  /** Increases with every request, so the panel can tell a new request from a re-render. */
  seq: number;
  changes: ConfigPatchChanges;
}

export function isConfigPatchKey(value: unknown): value is ConfigPatchKey {
  return typeof value === 'string' && (CONFIG_PATCH_KEYS as readonly string[]).includes(value);
}

/** Keep only allowlisted keys with a value they take (configPatchValue()); anything else is dropped. */
export function normalizeConfigPatchChanges(value: unknown): ConfigPatchChanges {
  const changes: ConfigPatchChanges = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return changes;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isConfigPatchKey(key)) continue;
    const accepted = configPatchValue(key, entry);
    if (accepted !== null) changes[key] = accepted;
  }
  return changes;
}

export function nextControlDraftRequest(previous: ControlDraftRequest | null, changes: unknown): ControlDraftRequest {
  return { seq: (previous?.seq ?? 0) + 1, changes: normalizeConfigPatchChanges(changes) };
}
