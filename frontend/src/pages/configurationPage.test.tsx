import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nContext, translate } from '../lib/i18n';
import type { Lang } from '../lib/i18n';
import { DEFAULT_GPS_CONFIG } from '../lib/map';
import { DEFAULT_COMPASS_CONFIG } from '../lib/polar';
import { ConfigurationPage } from './ConfigurationPage';

function render(lang: Lang = 'en'): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>
      <ConfigurationPage
        config={{ base_url: 'http://127.0.0.1:8081', mqtt_host: '', mqtt_port: 1883, refresh_seconds: 10 }}
        branding={{ app_name: 'Ground Console', logo_data_url: '' }}
        gpsConfig={DEFAULT_GPS_CONFIG}
        compassConfig={DEFAULT_COMPASS_CONFIG}
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
    // connection, admin login, dry-run, GPS, Compass
    expect(markup.match(/<form\b/g)?.length).toBe(5);
    expect(markup.match(/type="submit"/g)?.length).toBe(5);
    expect(markup).toContain('Restore GPS defaults');
    expect(markup).toContain('Restore Compass defaults');
  });

  it('offers 1 s and 2 s refresh and warns about a 10 s interval (AUD-24)', () => {
    const markup = render();
    expect(markup).toContain('<option value="1">Every second</option>');
    expect(markup).toContain('<option value="2">Every 2 seconds</option>');
    expect(markup).toContain('Longer than the 5 s DoA freshness window');
  });

  it('labels the base config revision as required (AUD-74)', () => {
    expect(render()).not.toContain('(optional)');
    expect(render('id')).not.toContain('(opsional)');
    expect(render()).toContain('Required by the sdr/v1 config_patch contract');
  });
});
