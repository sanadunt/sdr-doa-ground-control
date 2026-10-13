import { describe, expect, it } from 'vitest';
import { DEFAULT_GPS_CONFIG } from './map';
import { DEFAULT_COMPASS_CONFIG } from './polar';
import { COMPASS_CONFIG_STORAGE_KEY, GPS_CONFIG_STORAGE_KEY, loadCompassConfig, loadGpsConfig, saveCompassConfig, saveGpsConfig } from './sourceConfigStorage';

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = value; },
  };
}

describe('GPS / Compass source persistence (AUD-39)', () => {
  it('restores a saved MANUAL GPS position and Compass axis', () => {
    const storage = memoryStorage();
    saveGpsConfig({ source: 'MANUAL', manualLatitude: -7.25, manualLongitude: 112.75 }, storage);
    saveCompassConfig({ source: 'MANUAL', manualFigType: 'Polar', manualCompassOffset: 30 }, storage);
    expect(loadGpsConfig(storage)).toEqual({ source: 'MANUAL', manualLatitude: -7.25, manualLongitude: 112.75 });
    expect(loadCompassConfig(storage)).toEqual({ source: 'MANUAL', manualFigType: 'Polar', manualCompassOffset: 30 });
  });

  it('falls back to the defaults for missing, malformed or out-of-range values', () => {
    expect(loadGpsConfig(memoryStorage())).toEqual(DEFAULT_GPS_CONFIG);
    expect(loadGpsConfig(memoryStorage({ [GPS_CONFIG_STORAGE_KEY]: '{not json' }))).toEqual(DEFAULT_GPS_CONFIG);
    expect(loadGpsConfig(memoryStorage({ [GPS_CONFIG_STORAGE_KEY]: JSON.stringify({ source: 'MANUAL', manualLatitude: 95, manualLongitude: 10 }) }))).toEqual(DEFAULT_GPS_CONFIG);
    expect(loadGpsConfig(memoryStorage({ [GPS_CONFIG_STORAGE_KEY]: JSON.stringify({ source: 'REMOTE', manualLatitude: 1, manualLongitude: 1 }) }))).toEqual(DEFAULT_GPS_CONFIG);
    expect(loadCompassConfig(memoryStorage({ [COMPASS_CONFIG_STORAGE_KEY]: JSON.stringify({ source: 'MANUAL', manualFigType: 'Linear', manualCompassOffset: 0 }) }))).toEqual(DEFAULT_COMPASS_CONFIG);
    expect(loadCompassConfig(memoryStorage({ [COMPASS_CONFIG_STORAGE_KEY]: JSON.stringify({ source: 'MANUAL', manualFigType: 'Polar', manualCompassOffset: 1e9 }) }))).toEqual(DEFAULT_COMPASS_CONFIG);
  });

  it('keeps a FALLBACK choice even when its manual coordinates are unusable', () => {
    const storage = memoryStorage({ [GPS_CONFIG_STORAGE_KEY]: JSON.stringify({ source: 'FALLBACK', manualLatitude: 'x', manualLongitude: null }) });
    expect(loadGpsConfig(storage)).toEqual({ ...DEFAULT_GPS_CONFIG, source: 'FALLBACK' });
  });

  it('survives storage that throws', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(() => saveGpsConfig(DEFAULT_GPS_CONFIG, broken)).not.toThrow();
    expect(loadGpsConfig(broken)).toEqual(DEFAULT_GPS_CONFIG);
    expect(loadCompassConfig(null)).toEqual(DEFAULT_COMPASS_CONFIG);
  });
});
