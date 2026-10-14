import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { OVERVIEW_PANELS_STORAGE_KEY } from './lib/overviewPanels';

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

function renderApp(hash: string, entries: Record<string, string> = {}): string {
  const storage = memoryStorage({ 'sdr-console-lang': 'en', ...entries });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage, location: { hash, hostname: '127.0.0.1', search: '' } });
  return renderToStaticMarkup(<App />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dashboard wiring in App', () => {
  it('puts the panel toggles in the top bar on Overview only', () => {
    expect(renderApp('#/overview')).toContain('class="ov-panel-toggles"');
    expect(renderApp('#/system-health')).not.toContain('ov-panel-toggles');
  });

  it('restores the stored panel choices', () => {
    const markup = renderApp('#/overview', { [OVERVIEW_PANELS_STORAGE_KEY]: JSON.stringify({ layers: true, polar: false, spectrum: true, control: false, nodeCollapsed: true }) });
    expect(markup).toMatch(/aria-pressed="true" aria-controls="panel-layers"/);
    expect(markup).toContain('id="panel-layers"');
    expect(markup).not.toContain('id="panel-polar"');
  });

  it('never mounts the Receiver frame at console load, so the HackRF is not claimed', () => {
    const markup = renderApp('#/overview');
    expect(markup).not.toContain('receiver-frame');
    expect(markup).not.toContain('/receiver/');
  });

  it('keeps the refresh interval select disabled until the configuration is read', () => {
    const select = renderApp('#/overview').match(/<select[^>]*refresh-interval[^>]*>/)?.[0] ?? '';
    expect(select).toContain('disabled');
  });
});
