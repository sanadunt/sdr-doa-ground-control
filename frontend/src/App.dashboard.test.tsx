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

function renderApp(hash: string, entries: Record<string, string> = {}, hostname = '127.0.0.1'): string {
  const storage = memoryStorage({ 'sdr-console-lang': 'en', ...entries });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage, location: { hash, hostname, search: '' } });
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

  it('opens the Dashboard at #/dashboard and still at #/overview', () => {
    for (const hash of ['#/dashboard', '#/overview']) {
      const markup = renderApp(hash);
      expect(markup, hash).toContain('class="ov-panel-toggles"');
      expect(markup, hash).toMatch(/<h1 class="visually-hidden" data-route-focus="true" tabindex="-1">Dashboard<\/h1>/);
    }
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

describe('the LAN view in App', () => {
  const LAN_HOST = '192.168.1.10';
  const PANELS = JSON.stringify({ layers: false, polar: true, spectrum: true, control: true, nodeCollapsed: true });

  it('is view only from the first render on a LAN address: chip, no Kontrol, no Receiver dock', () => {
    const markup = renderApp('#/dashboard', { [OVERVIEW_PANELS_STORAGE_KEY]: PANELS }, LAN_HOST);
    expect(markup).toContain('view-only-chip');
    expect(markup).not.toContain('aria-controls="panel-control"');
    expect(markup).not.toContain('id="panel-control"');
    expect(markup).toContain('ov-spectrum is-view-only');
    expect(markup).not.toContain('receiver-frame');
  });

  it('never mounts the Receiver frame on the Receiver route', () => {
    const markup = renderApp('#/receiver', {}, LAN_HOST);
    expect(markup).not.toContain('receiver-frame');
    expect(markup).not.toContain('/receiver/');
    expect(markup).not.toContain('page-content-receiver');
    expect(markup).toContain('The Receiver runs on the groundstation.');
  });

  it('stays the full console on the loopback address', () => {
    const markup = renderApp('#/dashboard', { [OVERVIEW_PANELS_STORAGE_KEY]: PANELS });
    expect(markup).not.toContain('view-only-chip');
    expect(markup).toContain('id="panel-control"');
    // The Receiver section mounts (its lazy page is still loading in a static render).
    const receiver = renderApp('#/receiver');
    expect(receiver).toContain('page-content-receiver');
    expect(receiver).not.toContain('The Receiver runs on the groundstation.');
  });
});
