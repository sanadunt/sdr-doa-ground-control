import type { PolarSettings } from '../types';

/**
 * Local view choices of the Overview polar plot: a Compass/Polar override of
 * the resolved axis, Head Up, and a manual dB range (null = automatic). They
 * only change how the plot is drawn; the map, the bearing and Data Out stay
 * as they are.
 */
export interface PolarViewSettings {
  figTypeOverride: PolarSettings['figType'] | null;
  /** Head Up in degrees, 0 to under 360. */
  head: number;
  range: { min: number; max: number } | null;
}

export const POLAR_VIEW_STORAGE_KEY = 'sdr-doa-polar-view-v1';

export const DEFAULT_POLAR_VIEW_SETTINGS: Readonly<PolarViewSettings> = Object.freeze({ figTypeOverride: null, head: 0, range: null });

/** Bound for a manual radial range; the shifted dB values the node reports are far inside it. */
export const POLAR_RANGE_LIMIT_DB = 1000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function validPolarHead(value: unknown): value is number {
  const head = finite(value);
  return head !== null && head >= 0 && head < 360;
}

/** A manual range needs finite ends inside the bound with min below max. */
export function validPolarRange(value: unknown): value is { min: number; max: number } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const min = finite((value as Record<string, unknown>).min);
  const max = finite((value as Record<string, unknown>).max);
  return min !== null && max !== null && min < max && Math.abs(min) <= POLAR_RANGE_LIMIT_DB && Math.abs(max) <= POLAR_RANGE_LIMIT_DB;
}

/** Restore stored view settings; each field falls back to its default on its own. */
export function validatePolarViewSettings(value: unknown): PolarViewSettings {
  const input = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const figTypeOverride = input.figTypeOverride === 'Compass' || input.figTypeOverride === 'Polar' ? input.figTypeOverride : null;
  const head = validPolarHead(input.head) ? input.head : 0;
  const range = validPolarRange(input.range) ? { min: input.range.min, max: input.range.max } : null;
  return { figTypeOverride, head, range };
}

export function loadPolarViewSettings(storage: StorageLike | null = defaultStorage()): PolarViewSettings {
  if (!storage) return { ...DEFAULT_POLAR_VIEW_SETTINGS };
  try {
    const raw = storage.getItem(POLAR_VIEW_STORAGE_KEY);
    return validatePolarViewSettings(raw && raw.length <= 1024 ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_POLAR_VIEW_SETTINGS };
  }
}

export function savePolarViewSettings(settings: PolarViewSettings, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(POLAR_VIEW_STORAGE_KEY, JSON.stringify(validatePolarViewSettings(settings)));
  } catch {
    // Local persistence is optional; the in-memory choice still applies.
  }
}

/** The plot axis after the local override; the override never changes the map or the bearing. */
export function effectiveFigType(resolved: PolarSettings['figType'], view: Pick<PolarViewSettings, 'figTypeOverride'>): PolarSettings['figType'] {
  return view.figTypeOverride ?? resolved;
}

/**
 * Parse a typed number. Accepts a comma decimal and the typographic minus;
 * empty or partial input ('-', '.') is not a number.
 */
export function parseTypedNumber(text: string): number | null {
  const trimmed = text.trim().replace('−', '-').replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** A manual compass offset as typed (-360..360), stored in [0, 360). */
export function parseCompassOffsetInput(text: string): number | null {
  const value = parseTypedNumber(text);
  if (value === null || value < -360 || value > 360) return null;
  const normalized = ((value % 360) + 360) % 360;
  return Number(normalized.toFixed(6));
}
