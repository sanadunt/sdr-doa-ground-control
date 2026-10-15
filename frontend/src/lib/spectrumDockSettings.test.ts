import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RX_DB,
  SPECTRUM_DOCK_MAX_CHARS,
  SPECTRUM_DOCK_STORAGE_KEY,
  createSpectrumDockStore,
  keepDbRange,
  loadSpectrumDockSettings,
  manualFromDrawn,
  saveSpectrumDockSettings,
  validateSpectrumDockSettings,
} from './spectrumDockSettings';
import type { SpectrumDockSettings } from './spectrumDockSettings';
import { PREFERENCE_KEYS } from './preferenceStore';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('spectrum dock settings', () => {
  it('is a console preference that defaults to the Receiver default, Auto', () => {
    expect(SPECTRUM_DOCK_STORAGE_KEY).toBe('sdr-console-spectrum-dock-v1');
    expect((PREFERENCE_KEYS as readonly string[]).includes(SPECTRUM_DOCK_STORAGE_KEY)).toBe(true);
    expect(DEFAULT_RX_DB).toEqual({ auto: true, minDb: -70, maxDb: 0 });
    expect(loadSpectrumDockSettings(memoryStorage())).toEqual({ rxDb: { auto: true, minDb: -70, maxDb: 0 }, rxDbPending: false });
    expect(loadSpectrumDockSettings(null)).toEqual({ rxDb: { auto: true, minDb: -70, maxDb: 0 }, rxDbPending: false });
  });

  it('validates every field on its own and clamps the range', () => {
    expect(validateSpectrumDockSettings({ rxDb: { auto: false, minDb: -90, maxDb: -20 }, rxDbPending: true })).toEqual({ rxDb: { auto: false, minDb: -90, maxDb: -20 }, rxDbPending: true });
    expect(validateSpectrumDockSettings({ rxDb: { auto: false, minDb: -300, maxDb: -299 } })).toEqual({ rxDb: { auto: false, minDb: -160, maxDb: -155 }, rxDbPending: false });
    for (const bad of [null, [], 'x', { rxDb: null }, { rxDb: { auto: 'no', minDb: -90, maxDb: -20 } }, { rxDb: { auto: false, minDb: '-90', maxDb: -20 } }]) {
      expect(validateSpectrumDockSettings(bad), JSON.stringify(bad)).toEqual({ rxDb: DEFAULT_RX_DB, rxDbPending: false });
    }
    // Nothing usable to send: not pending.
    expect(validateSpectrumDockSettings({ rxDb: 7, rxDbPending: true }).rxDbPending).toBe(false);
  });

  it('round-trips through storage, ignores oversized or broken values and survives a throwing storage', () => {
    const storage = memoryStorage();
    const settings: SpectrumDockSettings = { rxDb: { auto: false, minDb: -97.5, maxDb: -12 }, rxDbPending: true };
    saveSpectrumDockSettings(settings, storage);
    expect(JSON.parse(storage.values.get(SPECTRUM_DOCK_STORAGE_KEY) ?? '')).toEqual(settings);
    expect(loadSpectrumDockSettings(storage)).toEqual(settings);
    expect(loadSpectrumDockSettings(memoryStorage({ [SPECTRUM_DOCK_STORAGE_KEY]: '{' }))).toEqual({ rxDb: DEFAULT_RX_DB, rxDbPending: false });
    const huge = JSON.stringify({ rxDb: { auto: false, minDb: -90, maxDb: -20 }, padding: 'x'.repeat(SPECTRUM_DOCK_MAX_CHARS) });
    expect(loadSpectrumDockSettings(memoryStorage({ [SPECTRUM_DOCK_STORAGE_KEY]: huge })).rxDb).toEqual(DEFAULT_RX_DB);
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadSpectrumDockSettings(throwing)).toEqual({ rxDb: DEFAULT_RX_DB, rxDbPending: false });
    expect(() => saveSpectrumDockSettings(settings, throwing)).not.toThrow();
  });

  it('keeps a typed limit valid against the other, the edited one giving way', () => {
    expect(keepDbRange(-90, -20, 'min')).toEqual({ minDb: -90, maxDb: -20 });
    expect(keepDbRange(-10, -20, 'min')).toEqual({ minDb: -25, maxDb: -20 });
    expect(keepDbRange(-90, -95, 'max')).toEqual({ minDb: -90, maxDb: -85 });
    expect(keepDbRange(-500, 500, 'min')).toEqual({ minDb: -160, maxDb: 60 });
    expect(keepDbRange(-500, 500, 'max')).toEqual({ minDb: -160, maxDb: 60 });
    expect(keepDbRange(-90.04, -20, 'min')).toEqual({ minDb: -90, maxDb: -20 });
  });

  it('starts Manual from the range drawn now, in whole dB, or keeps the stored range without one', () => {
    expect(manualFromDrawn({ min: -95.4, max: -39.6 }, DEFAULT_RX_DB)).toEqual({ auto: false, minDb: -95, maxDb: -40 });
    expect(manualFromDrawn({ min: -400, max: -399 }, DEFAULT_RX_DB)).toEqual({ auto: false, minDb: -160, maxDb: -155 });
    expect(manualFromDrawn(null, { auto: true, minDb: -88, maxDb: -11 })).toEqual({ auto: false, minDb: -88, maxDb: -11 });
  });

  it('a page-wide store saves and announces only real changes', () => {
    const saved: SpectrumDockSettings[] = [];
    const store = createSpectrumDockStore(() => validateSpectrumDockSettings(null), (settings) => saved.push(settings));
    let notified = 0;
    const off = store.subscribe(() => { notified++; });
    store.set({ rxDb: { auto: true, minDb: -70, maxDb: 0 }, rxDbPending: false });
    expect(notified).toBe(0);
    store.set({ rxDb: { auto: false, minDb: -90, maxDb: -20 }, rxDbPending: true });
    expect(notified).toBe(1);
    expect(saved).toEqual([{ rxDb: { auto: false, minDb: -90, maxDb: -20 }, rxDbPending: true }]);
    store.set({ rxDb: { auto: false, minDb: -90, maxDb: -20 }, rxDbPending: true });
    expect(notified).toBe(1);
    off();
    store.set({ rxDb: DEFAULT_RX_DB, rxDbPending: false });
    expect(notified).toBe(1);
    expect(store.get()).toEqual({ rxDb: DEFAULT_RX_DB, rxDbPending: false });
  });
});
