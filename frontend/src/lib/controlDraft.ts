/**
 * Draft request handed from the Overview spectrum dock ("Kirim ke RDF-SDR")
 * to the Kontrol panel. It only pre-fills the Kontrol draft; nothing is sent
 * until the operator unlocks admin, reviews the change and confirms it there.
 */

/** Fields of the sdr/v1 cmd/config/patch allowlist, in SI units (Hz, dB). */
export const CONFIG_PATCH_KEYS = ['center_frequency_hz', 'gain_db', 'vfo_frequency_hz', 'vfo_bandwidth_hz', 'vfo_squelch_db'] as const;

export type ConfigPatchKey = typeof CONFIG_PATCH_KEYS[number];

export type ConfigPatchChanges = Partial<Record<ConfigPatchKey, number>>;

export interface ControlDraftRequest {
  /** Increases with every request, so the panel can tell a new request from a re-render. */
  seq: number;
  changes: ConfigPatchChanges;
}

export function isConfigPatchKey(value: unknown): value is ConfigPatchKey {
  return typeof value === 'string' && (CONFIG_PATCH_KEYS as readonly string[]).includes(value);
}

/** Keep only allowlisted keys with finite numbers; anything else is dropped. */
export function normalizeConfigPatchChanges(value: unknown): ConfigPatchChanges {
  const changes: ConfigPatchChanges = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return changes;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isConfigPatchKey(key) && typeof entry === 'number' && Number.isFinite(entry)) changes[key] = entry;
  }
  return changes;
}

export function nextControlDraftRequest(previous: ControlDraftRequest | null, changes: unknown): ControlDraftRequest {
  return { seq: (previous?.seq ?? 0) + 1, changes: normalizeConfigPatchChanges(changes) };
}
