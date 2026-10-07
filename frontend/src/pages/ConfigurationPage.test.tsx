import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConsoleConfig } from '../types';
import { DEFAULT_GPS_CONFIG } from '../lib/map';
import { DEFAULT_COMPASS_CONFIG } from '../lib/polar';
import { DEFAULT_CONSOLE_CONFIG } from '../lib/telemetry';
import { ConfigurationPage } from './ConfigurationPage';

const BRANDING = { app_name: 'Ground Console', logo_data_url: '' };

function renderPage(config: ConsoleConfig): string {
  return renderToStaticMarkup(
    <ConfigurationPage
      config={config}
      branding={BRANDING}
      gpsConfig={DEFAULT_GPS_CONFIG}
      compassConfig={DEFAULT_COMPASS_CONFIG}
      onGpsConfigChanged={() => undefined}
      onCompassConfigChanged={() => undefined}
      onConfigSaved={async () => undefined}
      onBrandingChanged={() => undefined}
    />,
  );
}

describe('ConfigurationPage RDF Node identity', () => {
  it('shows the default v2 node ID in Connection settings', () => {
    expect(DEFAULT_CONSOLE_CONFIG.rdf_node_id).toBe('uav-01');
    const markup = renderPage(DEFAULT_CONSOLE_CONFIG);

    expect(markup).toContain('<span>RDF Node v2 ID</span>');
    expect(markup).toContain('value="uav-01"');
  });

  it('shows the configured v2 node ID in the editable field', () => {
    const config = { ...DEFAULT_CONSOLE_CONFIG, rdf_node_id: 'node_02' };

    expect(renderPage(config)).toContain('value="node_02"');
  });
});
