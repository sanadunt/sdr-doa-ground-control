/**
 * Which Overview dashboard panels are open. A per-browser preference, kept in
 * localStorage and validated on restore; it never reaches the console server.
 */
export interface OverviewPanels {
  /** Map layers panel (left column). */
  layers: boolean;
  /** Polar DoA section of the bottom dock. */
  polar: boolean;
  /** Spectrum section of the bottom dock. */
  spectrum: boolean;
  /** Kontrol (MQTT config patch) panel (right column). */
  control: boolean;
  /** The node card shows only its two-line summary. */
  nodeCollapsed: boolean;
}

export type OverviewPanelKey = Exclude<keyof OverviewPanels, 'nodeCollapsed'>;

export const OVERVIEW_PANELS_STORAGE_KEY = 'sdr-console-overview-panels-v1';

export const DEFAULT_OVERVIEW_PANELS: Readonly<OverviewPanels> = Object.freeze({
  layers: false,
  polar: true,
  spectrum: true,
  control: false,
  nodeCollapsed: true,
});

const KEYS: ReadonlyArray<keyof OverviewPanels> = ['layers', 'polar', 'spectrum', 'control', 'nodeCollapsed'];

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Every field that is not a boolean falls back to its default on its own. */
export function validateOverviewPanels(value: unknown): OverviewPanels {
  const input = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const panels = { ...DEFAULT_OVERVIEW_PANELS };
  for (const key of KEYS) {
    const entry = input[key];
    if (typeof entry === 'boolean') panels[key] = entry;
  }
  return panels;
}

export function sameOverviewPanels(left: OverviewPanels, right: OverviewPanels): boolean {
  return KEYS.every((key) => left[key] === right[key]);
}

export function loadOverviewPanels(storage: StorageLike | null = defaultStorage()): OverviewPanels {
  if (!storage) return { ...DEFAULT_OVERVIEW_PANELS };
  try {
    const raw = storage.getItem(OVERVIEW_PANELS_STORAGE_KEY);
    return validateOverviewPanels(raw && raw.length <= 1024 ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_OVERVIEW_PANELS };
  }
}

export function saveOverviewPanels(panels: OverviewPanels, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(OVERVIEW_PANELS_STORAGE_KEY, JSON.stringify(validateOverviewPanels(panels)));
  } catch {
    // Local persistence is optional; the in-memory choice still applies.
  }
}
