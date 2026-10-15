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

describe('Configuration page', () => {
  it('wraps each section in a form so Enter submits it (AUD-106)', () => {
    const markup = render();
    // connection, GPS, Compass, MQTT, admin login, dry-run
    expect(markup.match(/<form\b/g)?.length).toBe(6);
    expect(markup.match(/type="submit"/g)?.length).toBe(6);
    expect(markup).toContain('aria-label="Restore GPS defaults"');
    expect(markup).toContain('aria-label="Restore Compass defaults"');
  });

  it('lays the cards out in the section index order', () => {
    const markup = render();
    const ids = ['connection-settings', 'navigation-settings', 'mqtt-settings', 'branding-settings', 'dry-run-settings'];
    const cardOrder = ids.map((id) => markup.indexOf(`<section id="${id}"`));
    expect(cardOrder.every((index) => index > 0)).toBe(true);
    expect([...cardOrder].sort((a, b) => a - b)).toEqual(cardOrder);
    const index = markup.match(/<nav class="cfg-index"[\s\S]*?<\/nav>/)?.[0] ?? '';
    expect([...index.matchAll(/aria-controls="([^"]+)"/g)].map((match) => match[1])).toEqual(ids);
    expect(index).toContain('aria-current="location"');
  });

  it('offers the refresh intervals as one segmented control and warns about a 10 s interval (AUD-24)', () => {
    const markup = render();
    for (const label of ['Manual', '1 s', '2 s', '5 s', '10 s', '30 s']) expect(markup).toContain(`>${label}</button>`);
    expect(markup).toContain('aria-pressed="true">10 s</button>');
    expect(markup).toContain('so at 5 s or longer the bearing and polar curve clear between reads');
  });

  it('warns about a 5 s interval too, since the window counts from the data age, and not at 2 s', () => {
    expect(render({ refreshSeconds: 5 })).toContain('so at 5 s or longer the bearing and polar curve clear between reads');
    expect(render({ refreshSeconds: 2 })).not.toContain('cfg-warn');
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

  it('marks the base config revision as required without help prose (AUD-74)', () => {
    const markup = render();
    expect(markup).not.toContain('(optional)');
    expect(render({ lang: 'id' })).not.toContain('(opsional)');
    expect(markup).toMatch(/<input type="number"[^>]*required=""[^>]*aria-required="true"/);
  });

  it('puts the unit inside each dry-run field and the range in its placeholder until the node reports a value', () => {
    const markup = render();
    expect(markup).toContain('placeholder="24000000…1800000000"');
    expect(markup.match(/<span class="pg-unit">Hz<\/span>/g)?.length).toBe(3);
    expect(markup.match(/<span class="pg-unit">dB<\/span>/g)?.length).toBe(2);
    expect(markup).toContain('placeholder="config_rev"');
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

  it('warns about a monitor without TLS only for a host off this machine', () => {
    expect(render({ config: { mqtt_host: '127.0.0.1' } })).not.toContain('NO TLS');
    expect(render()).not.toContain('NO TLS');
    expect(render({ config: { mqtt_host: '10.90.0.1' } })).toContain(translate('en', 'config.mqttNoCredentials'));
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
