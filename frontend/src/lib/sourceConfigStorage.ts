import type { CompassConfig, GpsConfig } from '../types';
import { DEFAULT_GPS_CONFIG, manualGpsOverrideFromInput } from './map';
import { DEFAULT_COMPASS_CONFIG } from './polar';
import { preferenceStorage } from './preferenceStore';

export const GPS_CONFIG_STORAGE_KEY = 'sdr-doa-gps-source-v1';
export const COMPASS_CONFIG_STORAGE_KEY = 'sdr-doa-compass-source-v1';

const SOURCES = ['DATA_OUT', 'MANUAL', 'FALLBACK'] as const;
// Same range the Configuration form accepts for a manual offset.
export const MAX_COMPASS_OFFSET_DEG = 360;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// localStorage, with writes copied to the console server (lib/preferenceStore.ts).
function defaultStorage(): StorageLike | null {
  return preferenceStorage();
}

function readJson(storage: StorageLike | null, key: string): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    // Bound what is parsed; a real config is well under 1 KiB.
    return raw && raw.length <= 4096 ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(storage: StorageLike | null, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Local persistence is optional; the in-memory choice still applies.
  }
}

/** Restore a stored GPS source choice; anything invalid falls back to the default. */
export function validateGpsConfig(value: unknown): GpsConfig {
  const input = record(value);
  if (!input) return { ...DEFAULT_GPS_CONFIG };
  const source = SOURCES.find((entry) => entry === input.source);
  const manual = manualGpsOverrideFromInput(input.manualLatitude, input.manualLongitude).override;
  if (!source || (source === 'MANUAL' && !manual)) return { ...DEFAULT_GPS_CONFIG };
  return {
    source,
    manualLatitude: manual?.latitude ?? DEFAULT_GPS_CONFIG.manualLatitude,
    manualLongitude: manual?.longitude ?? DEFAULT_GPS_CONFIG.manualLongitude,
  };
}

/** Restore a stored Compass source choice; anything invalid falls back to the default. */
export function validateCompassConfig(value: unknown): CompassConfig {
  const input = record(value);
  if (!input) return { ...DEFAULT_COMPASS_CONFIG };
  const source = SOURCES.find((entry) => entry === input.source);
  const figType = input.manualFigType === 'Polar' || input.manualFigType === 'Compass' ? input.manualFigType : null;
  const offset = input.manualCompassOffset;
  if (!source || !figType || typeof offset !== 'number' || !Number.isFinite(offset) || Math.abs(offset) > MAX_COMPASS_OFFSET_DEG) {
    return { ...DEFAULT_COMPASS_CONFIG };
  }
  return { source, manualFigType: figType, manualCompassOffset: offset };
}

export function loadGpsConfig(storage: StorageLike | null = defaultStorage()): GpsConfig {
  return validateGpsConfig(readJson(storage, GPS_CONFIG_STORAGE_KEY));
}

export function saveGpsConfig(config: GpsConfig, storage: StorageLike | null = defaultStorage()): void {
  writeJson(storage, GPS_CONFIG_STORAGE_KEY, validateGpsConfig(config));
}

export function loadCompassConfig(storage: StorageLike | null = defaultStorage()): CompassConfig {
  return validateCompassConfig(readJson(storage, COMPASS_CONFIG_STORAGE_KEY));
}

export function saveCompassConfig(config: CompassConfig, storage: StorageLike | null = defaultStorage()): void {
  writeJson(storage, COMPASS_CONFIG_STORAGE_KEY, validateCompassConfig(config));
}
