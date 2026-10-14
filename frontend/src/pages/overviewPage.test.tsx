import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Candidate, TelemetrySnapshot } from '../types';
import { DEFAULT_GPS_CONFIG } from '../lib/map';
import { DEFAULT_COMPASS_CONFIG } from '../lib/polar';
import { I18nContext, translate } from '../lib/i18n';
import type { Lang } from '../lib/i18n';
import { OverviewPanelToggles } from '../components/overview/OverviewPanelToggles';
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

describe('Overview dashboard', () => {
  const dashboard = (value: TelemetrySnapshot | null, props: Partial<Parameters<typeof OverviewPage>[0]> = {}, lang: Lang = 'en') => renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>
      <OverviewPage snapshot={value} localSnapshotFresh gpsConfig={DEFAULT_GPS_CONFIG} compassConfig={DEFAULT_COMPASS_CONFIG} {...props} />
    </I18nContext.Provider>,
  );

  it('floats the bearing HUD over the map with theta_0, the display peak and the note', () => {
    const markup = dashboard(snapshot(), {}, 'id');
    const hud = markup.match(/<section class="ov-hud[^"]*" aria-label="Pembacaan DoA">[\s\S]*?<\/section>/)?.[0] ?? '';
    expect(hud).toContain('Bearing dari utara');
    // Compass, offset 0: bearing = (360 - 211) mod 360.
    expect(hud).toContain('149.0<small>°</small>');
    expect(hud).toContain('211.0°');
    expect(hud).toContain('Arah, bukan lokasi pemancar.');
    expect(markup).toContain('class="ov-map"');
  });

  it('hides the bearing and names the cause when the DoA may not be shown', () => {
    const hud = dashboard(snapshot({ native_consistency: { comparable: true, conflict: true } })).match(/<section class="ov-hud[\s\S]*?<\/section>/)?.[0] ?? '';
    expect(hud).not.toContain('149.0');
    expect(hud).toContain(translate('en', 'polar.conflict'));
  });

  it('marks the HUD age and the node chip STALE once the local window has closed', () => {
    const fresh = dashboard(snapshot({ overall_state: 'UNVERIFIED' }));
    expect(fresh).toContain('<span class="ov-hud-age">age 0.2 s</span>');
    expect(fresh).toContain('<span class="ov-chip tone-info">UNVERIFIED</span>');
    for (const lang of ['en', 'id'] as const) {
      const expired = dashboard(snapshot({ overall_state: 'UNVERIFIED' }), { localSnapshotFresh: false }, lang);
      expect(expired).toContain(`<span class="ov-hud-age is-warn">${translate(lang, 'hud.age', { age: `${translate(lang, 'common.durationS', { value: '0.2' })} · STALE` })}</span>`);
      expect(expired).toContain('<span class="ov-chip tone-warn">STALE</span>');
      expect(expired).not.toContain('UNVERIFIED');
    }
  });

  it('keeps an UNAVAILABLE or CONFLICT node chip and an unknown age unmarked after local expiry', () => {
    const unreachable = dashboard(snapshot({ overall_state: 'UNAVAILABLE', status: { available: false }, doa_candidates: {} }), { localSnapshotFresh: false });
    expect(unreachable).toContain('<span class="ov-chip tone-bad">UNAVAILABLE</span>');
    expect(unreachable).toContain('<span class="ov-hud-age">age —</span>');
    expect(unreachable).not.toContain('ov-chip tone-warn">STALE');
    const conflict = dashboard(snapshot({ overall_state: 'CONFLICT' }), { localSnapshotFresh: false });
    expect(conflict).toContain('<span class="ov-chip tone-bad">CONFLICT</span>');
  });

  it('renders the node card summary with the node frequency and gain', () => {
    const markup = dashboard(snapshot({ settings: { available: true, fields: { center_freq: 416.588, uniform_gain: 15.5 } } }));
    expect(markup).toContain('416.588 MHz · gain 15.5 dB');
    expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="ov-node-detail"/);
    expect(markup).toContain('id="ov-node-detail" class="ov-node-detail" hidden=""');
    expect(dashboard(null)).toContain(translate('en', 'node.waiting'));
  });

  it('opens the dock with the polar and spectrum sections by default, and nothing else', () => {
    const markup = dashboard(snapshot());
    expect(markup).toContain('id="panel-polar"');
    expect(markup).toContain('id="panel-spectrum"');
    expect(markup).not.toContain('id="panel-layers"');
    expect(markup).not.toContain('id="panel-control"');
    expect(markup).toContain('data-dock="full"');
  });

  it('follows the panel choices from App', () => {
    const all = dashboard(snapshot(), { panels: { layers: true, polar: true, spectrum: false, control: true, nodeCollapsed: false } });
    expect(all).toContain('id="panel-layers"');
    expect(all).toContain('id="panel-control"');
    expect(all).not.toContain('id="panel-spectrum"');
    expect(all).toContain('data-dock="polar"');
    expect(all).toContain('data-control="open"');
    expect(all).toContain('id="ov-node-detail" class="ov-node-detail">');
    const none = dashboard(snapshot(), { panels: { layers: false, polar: false, spectrum: false, control: false, nodeCollapsed: true } });
    expect(none).not.toContain('class="ov-dock"');
    expect(none).toContain('data-dock="none"');
  });

  it('shows the layer switches, including the new edges and labels layers', () => {
    const layers = dashboard(snapshot(), { panels: { layers: true, polar: false, spectrum: false, control: false, nodeCollapsed: true } }, 'id')
      .match(/<section id="panel-layers"[\s\S]*?<\/section>/)?.[0] ?? '';
    for (const label of ['Sorotan beam', 'Lobe', 'Garis bearing', 'Tepi −3 dB', 'Cincin jarak', 'Arah U/T/S/B', 'Label teks', 'Opasitas overlay', 'Lanjutan']) {
      expect(layers, label).toContain(label);
    }
    expect(layers).toContain('85 %');
  });

  it('puts the polar mode switch and the settings toggle in the polar header', () => {
    const polar = dashboard(snapshot(), {}, 'id').match(/<section id="panel-polar"[\s\S]*?<\/section>/)?.[0] ?? '';
    expect(polar).toContain('Polar DoA');
    expect(polar).toMatch(/<button type="button" aria-pressed="true">Kompas<\/button>/);
    expect(polar).toMatch(/aria-expanded="false" aria-controls="polar-settings"/);
    // Compass peak = (360 - 211) mod 360; footer shows it with Head Up.
    expect(polar).toContain('Puncak 149.0° · −3 dB');
    expect(polar).toContain('HU 0°');
  });

  it('labels a manual offset in the polar footer and the HUD', () => {
    const markup = dashboard(snapshot(), { compassConfig: { source: 'MANUAL', manualFigType: 'Compass', manualCompassOffset: 30 } });
    expect(markup).toContain('179.0<small>°</small>');
    expect(markup).toContain('<span class="is-manual"> · MANUAL</span>');
  });

  it('renders the spectrum dock and a locked Kontrol', () => {
    const markup = dashboard(snapshot(), { panels: { layers: false, polar: false, spectrum: true, control: true, nodeCollapsed: true } }, 'id');
    expect(markup).toContain('Spektrum');
    expect(markup).toMatch(/aria-keyshortcuts="7"[^>]*title="Buka halaman Receiver \(tombol 7\)"/);
    expect(markup).toContain('Ikuti frekuensi node');
    expect(markup).toContain('>Kirim ke Raspberry<');
    expect(markup).toContain('class="ov-spec-canvas"');
    expect(markup).toContain('Kontrol MQTT');
    expect(markup).toContain('LOCKED');
    expect(markup).toContain('<span class="ov-mono">cmd/config/patch</span>');
    // Nothing in the dock mounts or names the Receiver frame.
    expect(markup).not.toContain('receiver-frame');
  });
});

describe('Overview panel toggles', () => {
  it('press, label and point at the open panels', () => {
    const markup = renderToStaticMarkup(
      <I18nContext.Provider value={{ lang: 'id', setLang: () => undefined, t: (key, vars) => translate('id', key, vars) }}>
        <OverviewPanelToggles panels={{ layers: false, polar: true, spectrum: true, control: false, nodeCollapsed: true }} onChange={() => undefined} />
      </I18nContext.Provider>,
    );
    expect(markup).toContain('role="group" aria-label="Panel"');
    expect(markup).toMatch(/aria-pressed="false" aria-label="Lapisan"/);
    expect(markup).toMatch(/aria-pressed="true" aria-controls="panel-polar" aria-label="Polar"/);
    expect(markup).toMatch(/aria-pressed="true" aria-controls="panel-spectrum" aria-label="Spektrum"/);
    expect(markup).toMatch(/aria-pressed="false" aria-label="Kontrol"/);
  });
});
