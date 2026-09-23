import { DEFAULT_DOA_OVERLAY_SETTINGS, type DoaOverlaySettings } from './doaGeometry';

const STORAGE_KEY = 'sdr-doa-overlay-settings-v4';
const intervals = new Set([15, 30, 45, 90]);
const palettes = new Set(['kraken', 'thermal', 'viridis', 'monochrome']);

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