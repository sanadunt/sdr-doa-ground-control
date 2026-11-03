import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TelemetrySnapshot } from '../types';
import { I18nContext, translate } from '../lib/i18n';
import type { Lang } from '../lib/i18n';
import { DEFAULT_GPS_CONFIG } from '../lib/map';
import { DEFAULT_COMPASS_CONFIG } from '../lib/polar';
import { DEFAULT_OVERVIEW_PANELS } from '../lib/overviewPanels';
import type { CompactLayout } from '../lib/compactLayout';
import type { PositionEstimate } from '../lib/positionEstimate';
import { ConsoleShell, worstTone } from './Shell';
import { MapNoticeChip } from './MapNoticeChip';
import { OverviewPanelToggles } from './overview/OverviewPanelToggles';
import { SpectrumDock } from './overview/SpectrumDock';
import { SpectrumDockMirror } from './overview/SpectrumDockMirror';
import { EstimatePanel } from './overview/EstimatePanel';
import { OverviewPage } from '../pages/OverviewPage';

function render(element: ReactElement, lang: Lang = 'en'): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>{element}</I18nContext.Provider>,
  );
}

const healthyView = {
  available: true,
  canonical_angle_deg: 211,
  latitude: -6.2,
  longitude: 106.8,
  freshness: { fresh: true, age_ms: 200, max_age_ms: 5000 },
  angular_power_db: Array.from({ length: 360 }, (_value, index) => -40 + 30 * Math.exp(-(((index - 211) / 10) ** 2))),
};

function liveSnapshot(overrides: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return {
    status: { available: true, daq_health: 'PASS', safe: { gps_status: 'Fix' } },
    doa_candidates: { csv: { ...healthyView }, xml: { ...healthyView } },
    native_consistency: { comparable: true, conflict: false },
    publication_gate: { state: 'BLOCKED', checks: {}, reasons: ['GROUND_CLOCK_UNVERIFIED'] },
    source: { kind: 'mqtt', reason: 'MQTT_FRESH', reasons: ['MQTT_FRESH'] },
    ...overrides,
  } as TelemetrySnapshot;
}

function shell(props: Partial<Parameters<typeof ConsoleShell>[0]> = {}, lang: Lang = 'en'): string {
  return render(
    <ConsoleShell
      route="overview"
      onNavigate={() => undefined}
      branding={{ app_name: 'Ground Console', logo_data_url: '' }}
      snapshot={liveSnapshot()}
      localSnapshotFresh
      loading={false}
      readError={null}
      lastReadAgeMs={100}
      simulationEnabled={false}
      onRefresh={() => undefined}
      refreshSeconds={2}
      refreshOptions={[0, 1, 2, 5]}
      onRefreshSecondsChange={() => undefined}
      layout="compact-landscape"
      {...props}
    >
      <span>workspace</span>
    </ConsoleShell>,
    lang,
  );
}

const header = (markup: string) => markup.match(/<header class="topbar">[\s\S]*?<\/header>/)?.[0] ?? '';
const menuFooter = (markup: string) => markup.match(/<div class="page-menu-footer">[\s\S]*?<div class="local-chip">/)?.[0] ?? '';

describe('compact top bar', () => {
  it('marks the shell root with the layout, and the PC layout carries no mark', () => {
    expect(shell()).toMatch(/<div class="console-shell is-overview is-compact" data-layout="compact-landscape">/);
    expect(shell({ layout: 'compact-portrait' })).toContain('data-layout="compact-portrait"');
    const desktop = shell({ layout: null });
    expect(desktop).not.toContain('data-layout');
    expect(desktop).not.toContain('status-summary');
    expect(header(desktop)).toContain('class="telemetry-strip');
    expect(header(desktop)).toContain('<select');
  });

  it('keeps one row: menu, brand, one status pill, toolbar and refresh, without the strip, the interval or EN|ID', () => {
    const bar = header(shell({ toolbar: <div className="probe-toolbar" /> }));
    const order = ['menu-toggle', 'brand-mark', 'status-summary', 'topbar-spacer', 'probe-toolbar', 'refresh-button'].map((name) => bar.indexOf(name));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(bar).not.toContain('telemetry-strip');
    expect(bar).not.toContain('<select');
    expect(bar).not.toContain('lang-switch');
    expect(bar).not.toContain('host-power');
  });

  it('names the source and the DoA chip on the pill, in the strip\'s worst tone', () => {
    const pill = shell().match(/<button[^>]*class="status-summary[^"]*"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(pill).toContain('aria-controls="topbar-status"');
    expect(pill).toContain('aria-expanded="false"');
    expect(pill).toContain('<span class="status-summary-source">MQTT</span>');
    expect(pill).toMatch(/<span class="status-summary-doa">DoA [A-Z]+<\/span>/);
    expect(pill).toContain(`aria-label="${translate('en', 'shell.statusSummary', { status: 'MQTT · DoA ' })}`);
    const failed = shell({ readError: 'request timed out' }).match(/class="status-summary tone-(\w+)"/)?.[1];
    expect(failed).toBe('bad');
    expect(worstTone(['good', 'neutral', 'warn', 'good'])).toBe('warn');
    expect(worstTone(['good', 'bad', 'warn'])).toBe('bad');
    expect(worstTone([])).toBe('good');
  });

  it('keeps the full strip with the Delivery checklist in the pill\'s hidden popover', () => {
    const popover = shell().match(/<div id="topbar-status" class="status-popover" hidden="">[\s\S]*?<\/div><\/div>/)?.[0] ?? '';
    expect(popover).toContain('class="telemetry-strip has-source"');
    expect(popover).toContain('aria-controls="delivery-checklist"');
    expect(popover.match(/class="telemetry-item/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it('moves the interval, EN|ID and Restart/Shutdown into the page menu footer, next to the theme and the admin chip', () => {
    const footer = menuFooter(shell({}, 'id'));
    expect(footer).toContain('page-menu-theme');
    expect(footer).toContain(`<span>${translate('id', 'shell.refreshInterval')}</span><select class="refresh-interval"`);
    expect(footer).toContain('<option value="2" selected="">2 dtk</option>');
    expect(footer).toContain('class="lang-switch"');
    expect(footer).toContain('class="host-power"');
    // The PC layout keeps them in the bar.
    expect(menuFooter(shell({ layout: null }))).not.toContain('<select');
  });

  it('shows VIEW ONLY in the bar and no Restart/Shutdown in the LAN view', () => {
    const markup = shell({ access: 'lan-view' }, 'id');
    expect(header(markup)).toContain('view-only-chip');
    expect(header(markup)).toContain('LIHAT SAJA');
    expect(markup).not.toContain('host-power');
  });
});

describe('compact panel switches', () => {
  const toggles = (props: Partial<Parameters<typeof OverviewPanelToggles>[0]> = {}) => render(
    <OverviewPanelToggles panels={DEFAULT_OVERVIEW_PANELS} onChange={() => undefined} compact {...props} />,
  );

  it('offers Layers, Spectrum, the RDF-SDR node card and Control as icons, without Polar', () => {
    const markup = toggles();
    expect(markup).toContain('class="ov-panel-toggles is-compact"');
    const labels = [...markup.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);
    expect(labels).toEqual(['Panels', 'Layers', 'Spectrum', 'RDF-SDR', 'Control']);
    expect(markup).not.toContain('Polar');
    expect(markup).toContain('<button type="button" aria-pressed="false" aria-label="RDF-SDR" title="RDF-SDR">');
    expect(toggles({ nodeOpen: true })).toContain('aria-pressed="true" aria-controls="panel-node" aria-label="RDF-SDR"');
  });

  it('leaves Control out in the LAN view and keeps Polar on the PC', () => {
    expect(toggles({ viewOnly: true })).not.toContain('aria-label="Control"');
    const desktop = render(<OverviewPanelToggles panels={DEFAULT_OVERVIEW_PANELS} onChange={() => undefined} />);
    expect(desktop).toContain('aria-label="Polar"');
    expect(desktop).not.toContain('RDF-SDR');
  });
});

describe('compact dashboard', () => {
  const dashboard = (layout: CompactLayout | null, props: Partial<Parameters<typeof OverviewPage>[0]> = {}) => render(
    <OverviewPage snapshot={liveSnapshot()} localSnapshotFresh gpsConfig={DEFAULT_GPS_CONFIG} compassConfig={DEFAULT_COMPASS_CONFIG} compactLayout={layout} {...props} />,
  );

  it('renders no Polar dock and keeps the stored choice', () => {
    const panels = { ...DEFAULT_OVERVIEW_PANELS, polar: true, spectrum: true };
    const markup = dashboard('compact-landscape', { panels });
    expect(markup).not.toContain('id="panel-polar"');
    expect(markup).toContain('id="panel-spectrum"');
    expect(markup).toMatch(/<div class="page page-overview ov-stage" data-dock="full" data-layout="compact-landscape">/);
    expect(dashboard(null, { panels })).toContain('id="panel-polar"');
  });

  it('gives the map the whole stage when Spektrum is off', () => {
    const markup = dashboard('compact-portrait', { panels: { ...DEFAULT_OVERVIEW_PANELS, polar: true, spectrum: false } });
    expect(markup).toContain('data-dock="none"');
    expect(markup).not.toContain('class="ov-dock"');
  });

  it('shows the node card only while its switch has it open', () => {
    expect(dashboard('compact-landscape')).not.toContain('id="panel-node"');
    expect(dashboard('compact-landscape', { nodeOpen: true })).toContain('id="panel-node"');
    expect(dashboard(null)).toContain('id="panel-node"');
  });

  it('opens the spectrum dock without Atur, follow-node, the mode select or Kirim', () => {
    const markup = dashboard('compact-landscape');
    const dockMarkup = markup.slice(markup.indexOf('id="panel-spectrum"'));
    expect(dockMarkup).toContain('class="ov-spectrum is-compact"');
    expect(dockMarkup).not.toContain('ov-spec-settings-toggle');
    expect(dockMarkup).not.toContain('ov-spec-wide');
    expect(dockMarkup).not.toContain('ov-spec-source');
    for (const kept of ['ov-spec-mode', 'ov-spec-mark', 'ov-spec-listen', 'ov-spec-run', 'ov-spec-open']) expect(dockMarkup).toContain(kept);
    // The Receiver link stays named while it shows only its icon.
    expect(dockMarkup).toContain(`aria-label="${translate('en', 'spectrum.openReceiver')}"`);
  });
});

describe('compact spectrum docks', () => {
  it('keeps the PC dock as it was', () => {
    const markup = render(
      <SpectrumDock snapshot={null} localSnapshotFresh={false} capabilities={null} panels={DEFAULT_OVERVIEW_PANELS} onPanelsChange={() => undefined} onControlDraftRequest={() => undefined} onRequestReceiver={() => undefined} onNavigate={() => undefined} />,
    );
    expect(markup).toContain('class="ov-spectrum"');
    expect(markup).toContain('ov-spec-settings-toggle');
    expect(markup).toContain('ov-spec-follow ov-spec-wide');
  });

  it('gives the LAN view mirror dock a one-row header without the source text', () => {
    const compact = render(<SpectrumDockMirror compact />, 'id');
    expect(compact).toContain('class="ov-spectrum is-view-only is-mirror is-compact"');
    expect(compact).not.toContain('ov-spec-source');
    const head = compact.match(/<div class="ov-dock-head ov-spec-head">[\s\S]*?<div class="ov-spec-main">/)?.[0] ?? '';
    for (const kept of ['MIRROR', 'ov-chip', 'ov-spec-mode', 'ov-spec-mark', 'ov-spec-listen', 'ov-spec-run']) expect(head).toContain(kept);
    const desktop = render(<SpectrumDockMirror />, 'id');
    expect(desktop).toContain('class="ov-spectrum is-view-only is-mirror"');
    expect(desktop).toContain('ov-spec-source');
  });
});

describe('compact map notice', () => {
  it('is a one-line chip that a tap opens, with the link only once open', () => {
    const action = { label: 'Configuration → GPS & Compass', onClick: () => undefined };
    const chip = render(<MapNoticeChip text="REFERENCE: compass offset not reported" action={action} compact />);
    expect(chip).toBe(
      '<div class="map-data-chip is-compact" role="status">'
      + '<button type="button" class="map-chip-toggle" aria-expanded="false" title="REFERENCE: compass offset not reported">'
      + '<span class="map-chip-text">REFERENCE: compass offset not reported</span></button></div>',
    );
    expect(chip).not.toContain('map-chip-action');
  });

  it('keeps the PC notice markup', () => {
    expect(render(<MapNoticeChip text="BASEMAP UNAVAILABLE · Standard" />)).toBe('<div class="map-data-chip" role="status">BASEMAP UNAVAILABLE · Standard</div>');
    const withAction = render(<MapNoticeChip text="REFERENCE" action={{ label: 'Open', onClick: () => undefined }} />);
    expect(withAction).toBe('<div class="map-data-chip has-action" role="status"><span>REFERENCE</span><button type="button" class="map-chip-action">Open</button></div>');
  });
});

describe('compact position estimate', () => {
  const estimate: PositionEstimate = {
    state: 'ESTIMATE', latitude: -6.2, longitude: 106.8, radiusM: 250, distanceM: 1800, bearingDeg: 45, samples: 12, stations: 4, spreadDeg: 60,
    frequencyHz: 433_500_000, minStations: 3, minSpreadDeg: 30, resetReason: null, grid: null,
  } as PositionEstimate;

  it('is one button of two lines that opens the rest', () => {
    const markup = render(<EstimatePanel estimate={estimate} compact />);
    expect(markup).toContain('class="ov-card ov-estimate is-ready is-compact"');
    expect(markup).toContain('<button type="button" class="ov-estimate-summary" aria-expanded="false">');
    expect(markup).toContain('ov-estimate-distance');
    expect(markup).not.toContain('ov-estimate-note');
    expect(markup).not.toContain('ov-estimate-actions');
    expect(render(<EstimatePanel estimate={estimate} />)).toContain('ov-estimate-note');
  });
});

/** Vitest blanks every CSS import, so the stylesheet is read from disk. */
function readStylesheet(path: string): string {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  return process.getBuiltinModule('node:fs').readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** The compact section of a stylesheet: from its heading to the end of the file. */
function compactSection(css: string): string {
  const start = css.indexOf('/* Compact touch layout');
  expect(start).toBeGreaterThan(-1);
  return css.slice(start);
}

/** Every rule of a section, with at-rule wrappers left out. */
function rules(section: string): Array<{ selector: string; body: string }> {
  const withoutComments = section.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2] }));
}

describe('compact layout styles', () => {
  const sheets = { shell: readStylesheet('../console-design.css'), dashboard: readStylesheet('../overview-dashboard.css') };

  it.each(Object.entries(sheets))('scopes every %s rule under the compact data-layout, so a PC is untouched', (_name, css) => {
    const found = rules(compactSection(css));
    expect(found.length).toBeGreaterThan(10);
    for (const { selector } of found) {
      for (const part of selector.split(',')) expect(part.trim(), selector).toMatch(/^\.console-shell(?:\.[\w-]+)?\[data-layout(?:\^)?='compact[\w-]*'\]/);
    }
  });

  it.each(Object.entries(sheets))('uses colour tokens only in the %s compact rules', (_name, css) => {
    const section = compactSection(css).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(section).not.toMatch(/\brgba?\(/);
    expect(section).not.toMatch(/\bhsla?\(/);
  });

  it('keeps 44 px touch targets for the pill, the notice, the switches, the menu rows and the dock buttons', () => {
    const shellRules = rules(compactSection(sheets.shell));
    const dashRules = rules(compactSection(sheets.dashboard));
    const body = (list: typeof shellRules, selector: string) => list.find((rule) => rule.selector.endsWith(selector))?.body ?? '';
    expect(body(shellRules, '.status-summary')).toMatch(/height: 44px/);
    expect(body(shellRules, '.map-chip-toggle')).toMatch(/min-height: 44px/);
    expect(body(shellRules, '.page-menu-row')).toMatch(/min-height: 44px/);
    expect(body(dashRules, '.topbar-toolbar .ov-panel-toggles button')).toMatch(/width: 44px; min-width: 44px/);
    expect(body(dashRules, '.ov-spec-open')).toMatch(/width: 44px/);
    expect(body(dashRules, '.ov-estimate-summary')).toMatch(/min-height: 44px/);
    // No compact rule shrinks a control below 44 px.
    for (const { selector, body: declarations } of [...shellRules, ...dashRules]) {
      if (/height: 1px/.test(declarations)) continue;
      for (const match of declarations.matchAll(/(?:^|[;\s])(min-height|height|width|min-width):\s*(\d+)px/g)) {
        // The control itself, not a dot or a label inside it.
        const target = selector.split(',').map((part) => part.trim().split(/[\s>]+/).pop() ?? '').join(',');
        if (/button|toggle|summary|\.ov-spec-(?:run|open|listen)/.test(target) && Number(match[2]) < 44) throw new Error(`${selector}: ${match[0]}`);
      }
    }
  });

  it('lays the stage out side by side in landscape and stacked in portrait, without a page scroll', () => {
    const dashboard = compactSection(sheets.dashboard);
    expect(dashboard).toMatch(/\.console-shell\[data-layout\^='compact'\] \.ov-stage \{[^}]*grid-template-areas: 'map dock'; grid-template-columns: minmax\(0, 55fr\) minmax\(0, 45fr\)/);
    expect(dashboard).toMatch(/\.console-shell\[data-layout='compact-portrait'\] \.ov-stage \{[^}]*grid-template-areas: 'map' 'dock'; grid-template-columns: minmax\(0, 1fr\); grid-template-rows: minmax\(0, 55fr\) minmax\(0, 45fr\)/);
    expect(dashboard).toMatch(/\.ov-stage\[data-dock='none'\] \{[^}]*grid-template-areas: 'map'/);
    expect(dashboard).toMatch(/\.ov-stage \.map-bottom-overlay \{ display: none; \}/);
    expect(compactSection(sheets.shell)).toMatch(/\.page-content-overview \{ height: calc\(100dvh - var\(--topbar-h\)\); overflow: hidden; \}/);
  });

  it('stretches the Spektrum panel to its bottom: the dock, the main area and the body fill, the waterfall takes the rest', () => {
    const dashRules = rules(compactSection(sheets.dashboard));
    const body = (selector: string) => dashRules.find((rule) => rule.selector.endsWith(selector))?.body ?? '';
    // The dock fills its grid cell, and the spectrum section, its main area and the canvas body fill the dock.
    expect(body(' .ov-dock')).toMatch(/display: flex; flex-direction: column;/);
    expect(body(' .ov-dock > .ov-spectrum')).toMatch(/flex: 1 1 auto;[^}]*min-height: 0/);
    expect(body(' .ov-spec-main')).toMatch(/flex: 1 1 auto; flex-direction: column; min-height: 0; overflow: hidden/);
    expect(body(' .ov-spec-main > .ov-spec-body')).toMatch(/flex: 1 1 auto; min-height: 0; overflow: hidden/);
    // The trace a fixed share, the waterfall everything below it, neither held at the PC's stacked 96 px.
    expect(body(' .ov-spec-trace')).toMatch(/flex: 0 1 42%; min-height: 76px; max-height: 280px/);
    expect(body(' .ov-spec-waterfall')).toMatch(/flex: 1 1 0; height: auto; min-height: 40px/);
    // Compact rules outrank the stacked layout's fixed waterfall height and the narrow dock's scroll.
    expect(sheets.dashboard).toMatch(/@media \(max-width: 1023px\) \{[\s\S]*?\.ov-spec-waterfall \{ flex: none; height: 96px; \}/);
  });
});
