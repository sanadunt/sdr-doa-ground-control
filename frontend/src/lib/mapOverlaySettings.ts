import { DEFAULT_DOA_OVERLAY_SETTINGS, type DoaOverlaySettings } from './doaGeometry';

const STORAGE_KEY = 'sdr-doa-overlay-settings-v4';
const intervals = new Set([15, 30, 45, 90]);
const palettes = new Set(['kraken', 'thermal', 'viridis', 'monochrome']);
/** The overlay never fades out completely, so a stored 0 cannot hide it without a trace. */
export const OVERLAY_OPACITY_MIN = 0.2;

export function validateOverlaySettings(input: Partial<DoaOverlaySettings>): DoaOverlaySettings {
  const merged = { ...DEFAULT_DOA_OVERLAY_SETTINGS, ...input };
  const number = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  };
  const minDb = number(merged.minDb, DEFAULT_DOA_OVERLAY_SETTINGS.minDb, -160, 20);
  const maxDbCandidate = number(merged.maxDb, DEFAULT_DOA_OVERLAY_SETTINGS.maxDb, -160, 20);
  const maxDb = maxDbCandidate > minDb ? maxDbCandidate : Math.min(20, minDb + 1);
  return {
    lobeVisible: Boolean(merged.lobeVisible),
    bearingVisible: Boolean(merged.bearingVisible),
    heatmapVisible: Boolean(merged.heatmapVisible),
    guidesVisible: Boolean(merged.guidesVisible),
    ringsVisible: Boolean(merged.ringsVisible),
    edgesVisible: Boolean(merged.edgesVisible),
    labelsVisible: Boolean(merged.labelsVisible),
    overlayOpacity: number(merged.overlayOpacity, DEFAULT_DOA_OVERLAY_SETTINGS.overlayOpacity, OVERLAY_OPACITY_MIN, 1),
    heatStyle: merged.heatStyle === 'density' ? 'density' : 'beam',
    dbScale: merged.dbScale === 'manual' ? 'manual' : 'auto',
    maxDistanceM: number(merged.maxDistanceM, 1000, 100, 20000),
    lobeDistanceM: number(merged.lobeDistanceM, 1000, 100, 20000),
    lobeOpacity: number(merged.lobeOpacity, .18, 0, .6),
    heatOpacity: number(merged.heatOpacity, .55, 0, 1),
    heatBlur: number(merged.heatBlur, 24, 4, 80),
    minDb,
    maxDb,
    contrast: number(merged.contrast, 1, .25, 4),
    thresholdDb: number(merged.thresholdDb, minDb, -160, 20),
    radialSamples: Math.round(number(merged.radialSamples, 8, 2, 32)),
    distanceFalloff: number(merged.distanceFalloff, .35, 0, 1),
    heatIntensity: number(merged.heatIntensity, 1, .25, 3),
    guideInterval: intervals.has(Number(merged.guideInterval)) ? Number(merged.guideInterval) as DoaOverlaySettings['guideInterval'] : 45,
    heatPalette: palettes.has(String(merged.heatPalette)) ? merged.heatPalette : DEFAULT_DOA_OVERLAY_SETTINGS.heatPalette,
  };
}

export type OverlayNumberKey = 'radialSamples' | 'thresholdDb' | 'minDb' | 'maxDb' | 'contrast' | 'maxDistanceM' | 'lobeDistanceM';

export const OVERLAY_NUMBER_LIMITS: Readonly<Record<OverlayNumberKey, { min: number; max: number; integer?: boolean }>> = {
  radialSamples: { min: 2, max: 32, integer: true },
  thresholdDb: { min: -160, max: 20 },
  minDb: { min: -160, max: 20 },
  maxDb: { min: -160, max: 20 },
  contrast: { min: 0.25, max: 4 },
  maxDistanceM: { min: 100, max: 20000 },
  lobeDistanceM: { min: 100, max: 20000 },
};

export type OverlayFieldError =
  | { code: 'number' }
  | { code: 'range'; min: number; max: number }
  | { code: 'belowMax'; max: number }
  | { code: 'aboveMin'; min: number };

export type OverlayFieldResult = { ok: true; settings: DoaOverlaySettings } | { ok: false; error: OverlayFieldError };

/**
 * Apply one typed number field. Called on commit (blur or Enter), never per
 * keystroke: empty or partial input ('-', '.') is rejected instead of read as
 * 0, out-of-range values are rejected instead of clamped, and a minimum that
 * is not below the maximum is reported instead of rewriting the maximum.
 */
export function applyOverlayNumber(settings: DoaOverlaySettings, key: OverlayNumberKey, text: string): OverlayFieldResult {
  const trimmed = text.trim().replace(',', '.');
  const parsed = /^[-+]?(\d+\.?\d*|\.\d+)$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(parsed)) return { ok: false, error: { code: 'number' } };
  const limits = OVERLAY_NUMBER_LIMITS[key];
  const value = limits.integer ? Math.round(parsed) : parsed;
  if (value < limits.min || value > limits.max) return { ok: false, error: { code: 'range', min: limits.min, max: limits.max } };
  if (key === 'minDb' && value >= settings.maxDb) return { ok: false, error: { code: 'belowMax', max: settings.maxDb } };
  if (key === 'maxDb' && value <= settings.minDb) return { ok: false, error: { code: 'aboveMin', min: settings.minDb } };
  return { ok: true, settings: validateOverlaySettings({ ...settings, [key]: value }) };
}

export function loadOverlaySettings(): DoaOverlaySettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? validateOverlaySettings(JSON.parse(raw) as Partial<DoaOverlaySettings>) : DEFAULT_DOA_OVERLAY_SETTINGS;
  } catch {
    return DEFAULT_DOA_OVERLAY_SETTINGS;
  }
}

export function saveOverlaySettings(settings: DoaOverlaySettings): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(validateOverlaySettings(settings))); } catch { /* local persistence is optional */ }
}