import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { COMPASS_CONFIG_STORAGE_KEY, GPS_CONFIG_STORAGE_KEY } from './lib/sourceConfigStorage';

function memoryStorage(entries: Record<string, string>): Storage {
  const values = new Map(Object.entries(entries));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GPS and Compass source choices after a reload (AUD-39)', () => {
  it('start from what Configuration saved in this browser', () => {
    const storage = memoryStorage({
      [GPS_CONFIG_STORAGE_KEY]: JSON.stringify({ source: 'MANUAL', manualLatitude: -7.25, manualLongitude: 112.75 }),
      [COMPASS_CONFIG_STORAGE_KEY]: JSON.stringify({ source: 'MANUAL', manualFigType: 'Compass', manualCompassOffset: 30 }),
      'sdr-console-lang': 'en',
    });
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { localStorage: storage, location: { hash: '#/overview' } });
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain('-7.25000, 112.75000');
    expect(markup).toContain('MANUAL POSITION');
  });
});
