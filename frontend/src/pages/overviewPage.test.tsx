import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Candidate, TelemetrySnapshot } from '../types';
import { DEFAULT_GPS_CONFIG } from '../lib/map';
import { DEFAULT_COMPASS_CONFIG } from '../lib/polar';
import { I18nContext, translate } from '../lib/i18n';
import { OverviewPage } from './OverviewPage';

function render(element: ReactElement): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang: 'en', setLang: () => undefined, t: (key, vars) => translate('en', key, vars) }}>{element}</I18nContext.Provider>,
  );
}

function view(overrides: Record<string, unknown> = {}): Candidate {
  return {
    available: true,
    canonical_angle_deg: 211,
    latitude: -6.2,
    longitude: 106.8,
    freshness: { fresh: true, age_ms: 200, max_age_ms: 5000 },
    angular_power_db: Array.from({ length: 360 }, (_value, index) => -40 + 30 * Math.exp(-(((index - 211) / 10) ** 2))),
    ...overrides,
  } as Candidate;
}

function snapshot(overrides: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return {
    status: { available: true, daq_health: 'PASS', safe: { gps_status: 'Fix' } },
    doa_candidates: { csv: view(), xml: view() },
    native_consistency: { comparable: true, conflict: false },
    publication_gate: { state: 'BLOCKED', checks: {}, reasons: [] },
    ...overrides,
  } as TelemetrySnapshot;
}

const overview = (value: TelemetrySnapshot) => render(<OverviewPage snapshot={value} localSnapshotFresh gpsConfig={DEFAULT_GPS_CONFIG} compassConfig={DEFAULT_COMPASS_CONFIG} />);

describe('Overview', () => {
  it('has a route focus target like the other pages', () => {
    expect(overview(snapshot())).toMatch(/<h1 class="visually-hidden" data-route-focus="true" tabindex="-1">Overview<\/h1>/);
  });

  it('keeps the live station position through a CSV/XML conflict', () => {
    expect(overview(snapshot())).toContain('-6.20000, 106.80000');
    const conflict = overview(snapshot({ native_consistency: { comparable: true, conflict: true } }));
    expect(conflict).toContain('-6.20000, 106.80000');
    expect(conflict).toContain(translate('en', 'map.sourceHeld'));
    expect(conflict).not.toContain(translate('en', 'map.sourceFallback'));
  });

  it('falls back to the reference position when the node reports no fix', () => {
    overview(snapshot());
    const noFix = overview(snapshot({ status: { available: true, daq_health: 'PASS', safe: { gps_status: 'Disabled' } } }));
    expect(noFix).toContain(translate('en', 'map.sourceFallback'));
    expect(noFix).not.toContain('-6.20000, 106.80000');
  });
});
