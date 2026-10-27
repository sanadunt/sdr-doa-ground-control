import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DICTIONARIES, I18nContext, translate } from '../lib/i18n';
import type { Lang } from '../lib/i18n';
import { DEFAULT_GPS_CONFIG } from '../lib/map';
import { DEFAULT_COMPASS_CONFIG } from '../lib/polar';
import type { CompassConfig, ConsoleConfig, GpsConfig } from '../types';
import { ConfigurationPage } from './ConfigurationPage';

function render({ lang = 'en', refreshSeconds = 10, gps = DEFAULT_GPS_CONFIG, compass = DEFAULT_COMPASS_CONFIG, config = {} }: {
  lang?: Lang;
  refreshSeconds?: number;
  gps?: GpsConfig;
  compass?: CompassConfig;
  config?: Partial<ConsoleConfig>;
} = {}): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>
      <ConfigurationPage
        config={{ base_url: 'http://127.0.0.1:8081', mqtt_host: '', mqtt_port: 1883, refresh_seconds: refreshSeconds, ...config }}
        branding={{ app_name: 'Ground Console', logo_data_url: '' }}
        gpsConfig={gps}
        compassConfig={compass}
        onGpsConfigChanged={() => undefined}
        onCompassConfigChanged={() => undefined}
        onConfigSaved={async () => undefined}
        onBrandingChanged={() => undefined}
      />
    </I18nContext.Provider>,
  );
}

/** Vitest blanks every CSS import, so the stylesheet is read from disk. */
function readSource(path: string): string {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  return process.getBuiltinModule('node:fs').readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('Configuration page', () => {
  it('wraps each section in a form so Enter submits it (AUD-106)', () => {
    const markup = render();
    // connection, MQTT, LAN access, GPS, Compass, admin login, dry-run
    expect(markup.match(/<form\b/g)?.length).toBe(7);
    expect(markup.match(/type="submit"/g)?.length).toBe(7);
    expect(markup).toContain('aria-label="Restore GPS defaults"');
    expect(markup).toContain('aria-label="Restore Compass defaults"');
  });

  it('lays the cards out in the section index order', () => {
    const markup = render();
    const ids = ['connection-settings', 'mqtt-settings', 'lan-settings', 'navigation-settings', 'branding-settings', 'dry-run-settings'];
    const cardOrder = ids.map((id) => markup.indexOf(`<section id="${id}"`));
    expect(cardOrder.every((index) => index > 0)).toBe(true);
    expect([...cardOrder].sort((a, b) => a - b)).toEqual(cardOrder);
    const index = markup.match(/<nav class="cfg-index"[\s\S]*?<\/nav>/)?.[0] ?? '';
    expect([...index.matchAll(/aria-controls="([^"]+)"/g)].map((match) => match[1])).toEqual(ids);
    expect(index).toContain('aria-current="location"');
  });

  it('stacks the cards in two content-height columns, so none stretches to a taller neighbour', () => {
    const markup = render();
    const grid = markup.indexOf('<div class="pg-grid cfg-grid">');
    expect(grid).toBeGreaterThan(0);
    const columns = [...markup.slice(grid).matchAll(/<div class="pg-stack pg-span-6">/g)].map((match) => grid + (match.index ?? 0));
    expect(columns).toHaveLength(2);
    const at = (id: string) => markup.indexOf(`<section id="${id}"`);
    // Data Out and MQTT on the left, GPS & Compass and Branding on the right, the dry-run on a full row below.
    expect(columns[0]).toBeLessThan(at('connection-settings'));
    expect(at('mqtt-settings')).toBeLessThan(columns[1]);
    expect(columns[1]).toBeLessThan(at('navigation-settings'));
    expect(at('branding-settings')).toBeLessThan(at('dry-run-settings'));
    expect(markup).toMatch(/<\/div><section id="dry-run-settings" class="pg-card pg-span-12/);
    const css = readSource('./configuration.css');
    expect(css).not.toMatch(/align-items:\s*stretch/);
    expect(css).not.toMatch(/\.pg-card-body\s*\{[^}]*flex:\s*1 1 auto/);
    expect(css).not.toContain('cfg-wide-md');
    // Only 1024–1279 px dissolves the columns into the grid (Connection beside MQTT, GPS & Compass and Branding on full rows).
    const contents = css.match(/@media \(min-width: 1024px\) and \(max-width: 1279px\) \{\s*\.cfg-grid > \.pg-stack \{ display: contents; \}\s*\}/g);
    expect(contents).toHaveLength(1);
    // The other display: contents is the field group that only carries `disabled`.
    expect(css.replace(/\.cfg-fieldset \{[^}]*\}/, '').match(/display: contents/g)).toHaveLength(1);
  });

  it('offers the refresh intervals as one segmented control and warns about a 10 s interval (AUD-24)', () => {
    const markup = render();
    for (const label of ['Manual', '1 s', '2 s', '5 s', '10 s', '30 s']) expect(markup).toContain(`>${label}</button>`);
    expect(markup).toContain('aria-pressed="true">10 s</button>');
    expect(markup).toContain('so at 5 s or longer the bearing and polar curve clear between reads');
  });

  it('warns about a 5 s interval too, since the window counts from the data age, and not at 2 s', () => {
    expect(render({ refreshSeconds: 5 })).toContain('so at 5 s or longer the bearing and polar curve clear between reads');
    const connection = (markup: string) => markup.match(/<section id="connection-settings"[\s\S]*?<\/section>/)?.[0] ?? '';
    expect(connection(render({ refreshSeconds: 2 }))).not.toContain('cfg-warn');
    expect(render({ refreshSeconds: 0 })).toContain(translate('en', 'config.refreshManualWarning'));
  });

  it('shows the patch path as admin-only in the page bar, never as disabled', () => {
    for (const lang of ['en', 'id'] as const) {
      const bar = render({ lang }).match(/<header class="pg-bar[\s\S]*?<\/header>/)?.[0] ?? '';
      expect(bar).toContain(`${translate(lang, 'page.chip.patch')}</span><span class="ov-chip tone-warn">ADMIN ONLY</span>`);
      expect(bar).toContain(`${translate(lang, 'page.chip.admin')}</span><span class="ov-chip tone-neutral">CHECKING</span>`);
      expect(bar).toContain('MQTT</span><span class="ov-chip tone-neutral">UNKNOWN</span>');
      expect(bar).not.toMatch(/>DISABLED<|>NONAKTIF</);
    }
  });

  it('asks for no base revision: the dry-run names the node state the console holds (AUD-74, #9)', () => {
    const markup = render();
    expect(markup).not.toContain('(optional)');
    expect(render({ lang: 'id' })).not.toContain('(opsional)');
    expect(markup).not.toMatch(/<input type="number"[^>]*required=""/);
    expect(markup).not.toContain('base_config_rev');
    expect(markup).not.toContain('placeholder="config_rev"');
  });

  it('puts the unit inside each dry-run field and the range in its placeholder until the node reports a value', () => {
    const markup = render();
    expect(markup).toContain('placeholder="24000000…1766000000"');
    expect(markup.match(/<span class="pg-unit">Hz<\/span>/g)?.length).toBe(3);
    expect(markup.match(/<span class="pg-unit">dB<\/span>/g)?.length).toBe(2);
  });

  it('shows coordinates with 6 decimals and enables them only for a manual source', () => {
    const auto = render();
    expect(auto).toContain('value="-6.932469"');
    expect(auto).toContain('value="107.660694"');
    expect(auto).not.toContain('6.932468839245536');
    const latitude = (markup: string) => markup.match(/<input[^>]*value="-6\.[0-9]+"[^>]*>/)?.[0] ?? '';
    expect(latitude(auto)).toContain('disabled=""');
    const manual = render({ gps: { source: 'MANUAL', manualLatitude: -6.2, manualLongitude: 106.8 } });
    expect(latitude(manual)).toContain('value="-6.2"');
    expect(latitude(manual)).not.toContain('disabled=""');
  });

  it('tags the source in effect and presses it in the source switch', () => {
    const markup = render({ gps: { ...DEFAULT_GPS_CONFIG, source: 'FALLBACK' }, compass: { ...DEFAULT_COMPASS_CONFIG, source: 'MANUAL' } });
    expect(markup).toContain('<span class="ov-tag tone-warn">FALLBACK</span>');
    expect(markup).toContain('<span class="ov-tag tone-signal">MANUAL</span>');
    expect(markup).toContain('aria-pressed="true">Fallback</button>');
    expect(markup).toContain('aria-pressed="true">Manual</button>');
  });

  it('lists the accepted MQTT host forms in the placeholder without a sentence', () => {
    for (const lang of ['en', 'id'] as const) expect(render({ lang })).toContain('placeholder="IPv4 · IPv6 · localhost"');
  });

  it('warns about a monitor without TLS only for a host off this machine', () => {
    expect(render({ config: { mqtt_host: '127.0.0.1' } })).not.toContain('NO TLS');
    expect(render()).not.toContain('NO TLS');
    expect(render({ config: { mqtt_host: '10.90.0.1' } })).toContain(translate('en', 'config.mqttNoCredentials'));
  });

  it('edits the Data Out host list in the Connection card, keeping the URL host', () => {
    for (const lang of ['en', 'id'] as const) {
      const markup = render({ lang, config: { base_url: 'http://rdf.local:8081', data_out_hosts: ['rdf.local', '192.168.100.100', 'fd00::1'] } });
      const card = markup.match(/<section id="connection-settings"[\s\S]*?<\/section>/)?.[0] ?? '';
      expect(card).toContain(`>${translate(lang, 'config.dataOutHosts')}</span>`);
      const pills = [...card.matchAll(/<li class="cfg-host"><span class="cfg-host-name">([^<]+)<\/span><button class="cfg-host-remove" type="button" aria-label="([^"]+)"( disabled="")?/g)];
      expect(pills.map((pill) => pill[1])).toEqual(['rdf.local', '192.168.100.100', 'fd00::1']);
      expect(pills.map((pill) => pill[2])).toEqual(['rdf.local', '192.168.100.100', 'fd00::1'].map((host) => translate(lang, 'config.dataOutHostRemove', { host })));
      // The host of the URL in the field cannot be removed; the others can.
      expect(pills.map((pill) => Boolean(pill[3]))).toEqual([true, false, false]);
      // The URL suggestions follow the list, an IPv6 host in brackets.
      expect(card).toContain('<option value="http://rdf.local:8081"></option><option value="http://192.168.100.100:8081"></option><option value="http://[fd00::1]:8081"></option>');
      expect(card).toContain(`>${translate(lang, 'config.dataOutHostNew')}</span>`);
      expect(card).toContain('placeholder="rdf.local · 192.168.1.20"');
      expect(card).toMatch(new RegExp(`<button class="ov-button" type="button" disabled="">${translate(lang, 'config.dataOutHostAdd')}</button>`));
      // Host editing never submits the card: only Save is a submit button.
      expect(card.match(/type="submit"/g)).toHaveLength(1);
      expect(card).not.toContain(' title=');
    }
  });

  it('shows the default hosts for a server that reports no list', () => {
    const card = render().match(/<section id="connection-settings"[\s\S]*?<\/section>/)?.[0] ?? '';
    expect([...card.matchAll(/<span class="cfg-host-name">([^<]+)<\/span>/g)].map((match) => match[1])).toEqual(['doasdr.local', '192.168.100.100', '127.0.0.1', 'localhost']);
  });

  it('styles the host pills as 44 px targets with console tokens only', () => {
    const css = readSource('./configuration.css');
    const rules = css.slice(css.indexOf('.cfg-host-list'), css.indexOf('.cfg-host-add > .cfg-grow'));
    expect(rules).toMatch(/\.cfg-host \{[^}]*height: 44px;/);
    expect(rules).toMatch(/\.cfg-host-remove \{[^}]*width: 44px;/);
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    expect(css).toMatch(/\.cfg-form\.cfg-conn-form > \.cfg-actions, \.cfg-form\.cfg-conn-form > \.cfg-hosts \{ grid-column: 1 \/ -1; \}/);
  });

  it('carries no help prose (no-helper-prose rule)', () => {
    for (const lang of ['en', 'id'] as const) {
      const markup = render({ lang, refreshSeconds: 2 });
      expect(markup).not.toContain('<small');
      expect(markup).not.toMatch(/browser ini|this browser/);
      for (const key of Object.keys(DICTIONARIES.en)) expect(key, 'retired config prose key').not.toMatch(/^config\.(.*Help(\..*)?|.*Note|.*Eyebrow|remoteWrites.*|secrets.*|mqttPublish.*)$/);
    }
  });
});
