import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLAR_VIEW_SETTINGS,
  POLAR_VIEW_STORAGE_KEY,
  effectiveFigType,
  loadPolarViewSettings,
  parseCompassOffsetInput,
  parseTypedNumber,
  savePolarViewSettings,
  validPolarHead,
  validPolarRange,
  validatePolarViewSettings,
} from './polarViewSettings';

function memoryStorage(entries: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map(Object.entries(entries));
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); } };
}

describe('polar view settings', () => {
  it('default to the resolved axis, Head Up 0 and the automatic range', () => {
    expect(DEFAULT_POLAR_VIEW_SETTINGS).toEqual({ figTypeOverride: null, head: 0, range: null });
    expect(loadPolarViewSettings(memoryStorage())).toEqual(DEFAULT_POLAR_VIEW_SETTINGS);
  });

  it('validate every field on restore', () => {
    expect(validatePolarViewSettings({ figTypeOverride: 'Polar', head: 47.6, range: { min: -3, max: 2 } }))
      .toEqual({ figTypeOverride: 'Polar', head: 47.6, range: { min: -3, max: 2 } });
    expect(validatePolarViewSettings({ figTypeOverride: 'Linear', head: 360, range: { min: 2, max: 2 } }))
      .toEqual(DEFAULT_POLAR_VIEW_SETTINGS);
    expect(validatePolarViewSettings({ head: -1, range: { min: Number.NaN, max: 1 } })).toEqual(DEFAULT_POLAR_VIEW_SETTINGS);
    expect(validatePolarViewSettings({ range: { min: -5000, max: 0 } }).range).toBeNull();
    expect(validatePolarViewSettings('nope')).toEqual(DEFAULT_POLAR_VIEW_SETTINGS);
  });

  it('round-trip through storage and survive corrupt data', () => {
    const storage = memoryStorage();
    savePolarViewSettings({ figTypeOverride: 'Compass', head: 90, range: null }, storage);
    expect(loadPolarViewSettings(storage)).toEqual({ figTypeOverride: 'Compass', head: 90, range: null });
    expect(loadPolarViewSettings(memoryStorage({ [POLAR_VIEW_STORAGE_KEY]: '[' }))).toEqual(DEFAULT_POLAR_VIEW_SETTINGS);
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadPolarViewSettings(throwing)).toEqual(DEFAULT_POLAR_VIEW_SETTINGS);
    expect(() => savePolarViewSettings(DEFAULT_POLAR_VIEW_SETTINGS, throwing)).not.toThrow();
  });

  it('apply the axis override only when one is chosen', () => {
    expect(effectiveFigType('Compass', { figTypeOverride: null })).toBe('Compass');
    expect(effectiveFigType('Compass', { figTypeOverride: 'Polar' })).toBe('Polar');
  });

  it('check Head Up and manual ranges', () => {
    expect(validPolarHead(0)).toBe(true);
    expect(validPolarHead(359.9)).toBe(true);
    expect(validPolarHead(360)).toBe(false);
    expect(validPolarHead('10')).toBe(false);
    expect(validPolarRange({ min: -40, max: 0 })).toBe(true);
    expect(validPolarRange({ min: 0, max: -40 })).toBe(false);
    expect(validPolarRange({ min: null, max: 0 })).toBe(false);
  });

  it('parse typed numbers without reading partial input as 0', () => {
    expect(parseTypedNumber('12,5')).toBe(12.5);
    expect(parseTypedNumber('−12')).toBe(-12);
    for (const text of ['', '-', '.', 'abc', '1e3', '12a']) expect(parseTypedNumber(text), text).toBeNull();
  });

  it('accept a manual compass offset from -360 to 360 and store it in [0, 360)', () => {
    expect(parseCompassOffsetInput('30')).toBe(30);
    expect(parseCompassOffsetInput('-30')).toBe(330);
    expect(parseCompassOffsetInput('360')).toBe(0);
    expect(parseCompassOffsetInput('-360')).toBe(0);
    expect(parseCompassOffsetInput('361')).toBeNull();
    expect(parseCompassOffsetInput('')).toBeNull();
  });
});
