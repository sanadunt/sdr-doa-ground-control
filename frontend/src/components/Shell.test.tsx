import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConsoleShell, formatElapsed, refreshSelectOptions } from './Shell';
import { I18nContext, translate } from '../lib/i18n';
import type { Lang } from '../lib/i18n';
import type { TelemetrySnapshot } from '../types';

describe('Receiver navigation', () => {
  it('exposes the active Receiver page as the seventh keyboard route', () => {
    const markup = renderToStaticMarkup(
      <ConsoleShell
        route="receiver"
        onNavigate={() => undefined}
        branding={{ app_name: 'Ground Console', logo_data_url: '' }}
        snapshot={null}
        localSnapshotFresh={false}
        loading={false}
        readError={null}
        lastReadAgeMs={null}
        simulationEnabled={false}
        onRefresh={() => undefined}
      >
        <span>Receiver workspace</span>
      </ConsoleShell>,
    );
    const activeItem = markup.match(/<button[^>]*class="nav-item nav-active"[^>]*>[\s\S]*?<\/button>/)?.[0];

    expect(activeItem).toContain('aria-current="page"');
    expect(activeItem).toContain('aria-keyshortcuts="7"');
    expect(activeItem).toContain('Receiver');
  });
});

function strip(props: Partial<Parameters<typeof ConsoleShell>[0]> = {}): Record<string, { value: string; tone: string }> {
  const markup = renderToStaticMarkup(
    <ConsoleShell
      route="overview"
      onNavigate={() => undefined}
      branding={{ app_name: 'Ground Console', logo_data_url: '' }}
      snapshot={null}
      localSnapshotFresh={false}
      loading={false}
      readError={null}
      lastReadAgeMs={null}
      simulationEnabled={false}
      onRefresh={() => undefined}
      {...props}
    >
      <span>workspace</span>
    </ConsoleShell>,
  );
  const items: Record<string, { value: string; tone: string }> = {};
  for (const match of markup.matchAll(/<span class="telemetry-item tone-(\w+)"[^>]*><span class="telemetry-key">([^<]+)<\/span><span class="telemetry-value"><i aria-hidden="true"><\/i>([^<]*)<\/span>/g)) {
    items[match[2]] = { tone: match[1], value: match[3] };
  }
  return items;
}

const healthyView = {
  available: true,
  canonical_angle_deg: 211,
  freshness: { fresh: true, age_ms: 200, max_age_ms: 5000 },
  angular_power_db: Array.from({ length: 360 }, () => 0),
};

function liveSnapshot(overrides: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return {
    status: { available: true, daq_health: 'PASS' },
    doa_candidates: { csv: { ...healthyView }, xml: { ...healthyView } },
    native_consistency: { comparable: true, conflict: false },
    publication_gate: { state: 'BLOCKED', checks: {}, reasons: ['GROUND_CLOCK_UNVERIFIED'] },
    ...overrides,
  } as TelemetrySnapshot;
}

describe('runtime status strip', () => {
  it('shows a healthy fresh read as available and current', () => {
    const items = strip({ snapshot: liveSnapshot(), localSnapshotFresh: true, lastReadAgeMs: 300 });
    expect(items.Data).toEqual({ value: 'AVAILABLE', tone: 'good' });
    expect(items.DoA).toEqual({ value: 'AVAILABLE', tone: 'good' });
    expect(items.Snapshot).toEqual({ value: 'CURRENT', tone: 'good' });
  });

  it('reports an unreachable status.json as UNAVAILABLE, not STALE, right after the read', () => {
    const items = strip({ snapshot: liveSnapshot({ status: { available: false } }), localSnapshotFresh: false, lastReadAgeMs: 100 });
    expect(items.Data.value).toBe('UNAVAILABLE');
    expect(items.DoA.value).toBe('UNAVAILABLE');
    expect(items.Snapshot).toEqual({ value: 'CURRENT', tone: 'good' });
  });

  it('never shows the DoA chip as AVAILABLE when the DAQ is not synchronized', () => {
    const items = strip({ snapshot: liveSnapshot({ status: { available: true, daq_health: 'FAIL' } }), localSnapshotFresh: true, lastReadAgeMs: 100 });
    expect(items.Data.value).toBe('DEGRADED');
    expect(items.DoA).toEqual({ value: 'DEGRADED', tone: 'warn' });
  });

  it('names malformed and incomplete records instead of calling them stale', () => {
    const malformed = liveSnapshot({ doa_candidates: { csv: { available: false }, xml: { available: false } } });
    expect(strip({ snapshot: malformed, localSnapshotFresh: true, lastReadAgeMs: 100 }).Data.value).toBe('INVALID');
    const missingXml = liveSnapshot({ doa_candidates: { csv: { ...healthyView }, xml: { available: false } } });
    expect(strip({ snapshot: missingXml, localSnapshotFresh: true, lastReadAgeMs: 100 }).Data).toEqual({ value: 'INCOMPLETE', tone: 'warn' });
  });

  it('shows a stalled node as STALE in both chips', () => {
    const stalled = liveSnapshot({ node_progress: { state: 'STALLED', stalled: true } });
    const items = strip({ snapshot: stalled, localSnapshotFresh: false, lastReadAgeMs: 100 });
    expect(items.Data.value).toBe('STALE');
    expect(items.DoA.value).toBe('STALE');
  });

  it('ages the snapshot chip and keeps a failed read visible as ERROR', () => {
    expect(strip({ snapshot: liveSnapshot(), localSnapshotFresh: false, lastReadAgeMs: 6000 }).Snapshot.value).toBe('STALE');
    const failed = strip({ snapshot: liveSnapshot(), localSnapshotFresh: false, lastReadAgeMs: 100, readError: 'request timed out after 10000 ms' });
    expect(failed.Data.value).toBe('ERROR');
    expect(failed.Snapshot.value).toBe('ERROR');
    expect(strip({ loading: true }).Snapshot.value).toBe('LOADING');
  });

  it('shows a failed MQTT state read as ERROR', () => {
    expect(strip({ mqttConnection: 'connected' }).MQTT).toEqual({ value: 'CONNECTED', tone: 'good' });
    expect(strip({ mqttConnection: 'connected', mqttError: 'request failed (500)' }).MQTT).toEqual({ value: 'ERROR', tone: 'warn' });
  });

  it('keeps the refresh button enabled while a read is in flight', () => {
    const markup = renderToStaticMarkup(
      <ConsoleShell route="overview" onNavigate={() => undefined} branding={{ app_name: 'G', logo_data_url: '' }} snapshot={null} localSnapshotFresh={false} loading readError={null} lastReadAgeMs={null} simulationEnabled={false} onRefresh={() => undefined}>
        <span />
      </ConsoleShell>,
    );
    const button = markup.match(/<button[^>]*refresh-button[^>]*>/)?.[0] ?? '';
    expect(button).toContain('aria-busy="true"');
    expect(button).not.toContain('disabled');
  });
});

describe('read error and read age (AUD-27, AUD-99)', () => {
  const render = (lang: Lang, props: Partial<Parameters<typeof ConsoleShell>[0]>) => renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>
      <ConsoleShell route="system-health" onNavigate={() => undefined} branding={{ app_name: 'G', logo_data_url: '' }} snapshot={liveSnapshot()} localSnapshotFresh={false} loading={false} readError={null} lastReadAgeMs={null} simulationEnabled={false} onRefresh={() => undefined} {...props}>
        <span />
      </ConsoleShell>
    </I18nContext.Provider>,
  );

  it('shows the read error as visible text, not only as a tooltip', () => {
    const markup = render('id', { readError: 'Console tidak menjawab dalam 10 dtk.', lastReadAgeMs: 12_000 });
    const banner = markup.match(/<div class="read-error-banner" role="alert">[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(banner).toContain('Snapshot gagal: Console tidak menjawab dalam 10 dtk.');
    expect(render('en', { lastReadAgeMs: 100 })).not.toContain('read-error-banner');
  });

  it('formats the read age in the UI language', () => {
    const t = (lang: Lang) => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(lang, key, vars);
    expect(formatElapsed(t('id'), 12_400)).toBe('12 dtk');
    expect(formatElapsed(t('id'), 3 * 60_000 + 5_000)).toBe('3 mnt');
    expect(formatElapsed(t('id'), 2 * 3_600_000)).toBe('2 jam');
    expect(formatElapsed(t('en'), 2 * 3_600_000)).toBe('2 h');
    expect(formatElapsed(t('en'), Number.NaN)).toBe('0 s');
    expect(render('id', { lastReadAgeMs: 3 * 3_600_000 })).toContain('Dibaca 3 jam lalu');
  });
});

describe('status strip tooltips', () => {
  const render = (lang: Lang) => renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>
      <ConsoleShell route="overview" onNavigate={() => undefined} branding={{ app_name: 'G', logo_data_url: '' }} snapshot={liveSnapshot()} localSnapshotFresh loading={false} readError={null} lastReadAgeMs={100} simulationEnabled={false} onRefresh={() => undefined}>
        <span />
      </ConsoleShell>
    </I18nContext.Provider>,
  );

  it.each(['en', 'id'] as const)('explains each of the six chips in %s', (lang) => {
    const items = [...render(lang).matchAll(/<span class="telemetry-item[^"]*"([^>]*)>/g)].map((match) => match[1]);
    expect(items).toHaveLength(6);
    const help = ['status.dataHelp', 'status.doaHelp', 'status.deliveryHelp', 'status.snapshotHelp', 'status.mqttHelp', 'status.simHelp'] as const;
    items.forEach((attributes, index) => {
      const title = attributes.match(/title="([^"]*)"/)?.[1] ?? '';
      expect(title.replace(/&#x27;/g, "'"), help[index]).toContain(translate(lang, help[index]));
    });
  });
});

describe('top bar and page menu (dashboard shell)', () => {
  const render = (props: Partial<Parameters<typeof ConsoleShell>[0]> = {}, lang: Lang = 'en') => renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>
      <ConsoleShell route="overview" onNavigate={() => undefined} branding={{ app_name: 'Ground Console', logo_data_url: '' }} snapshot={liveSnapshot()} localSnapshotFresh loading={false} readError={null} lastReadAgeMs={100} simulationEnabled={false} onRefresh={() => undefined} {...props}>
        <span>workspace</span>
      </ConsoleShell>
    </I18nContext.Provider>,
  );

  it('keeps every page in a hidden popover menu instead of a rail', () => {
    const markup = render();
    expect(markup).not.toContain('class="sidebar"');
    const menu = markup.match(/<div id="console-navigation"[^>]*>/)?.[0] ?? '';
    expect(menu).toContain('class="page-menu"');
    expect(menu).toContain('hidden=""');
    expect(markup.match(/class="nav-item[^"]*"/g)).toHaveLength(7);
    const toggle = markup.match(/<button[^>]*menu-toggle[^>]*>/)?.[0] ?? '';
    expect(toggle).toContain('aria-controls="console-navigation"');
    expect(toggle).toContain('aria-expanded="false"');
    expect(toggle).toContain(`aria-label="${translate('en', 'shell.pageMenu')}"`);
  });

  it('moves the theme toggle and the control note into the menu footer', () => {
    const footer = render().match(/<div class="page-menu-footer">[\s\S]*?<\/p><\/div>/)?.[0] ?? '';
    expect(footer).toContain('page-menu-theme');
    expect(footer).toContain(translate('en', 'shell.readOnly'));
    expect(footer).toContain(translate('en', 'shell.shortcutHint'));
  });

  it('shows the route title and read age off Overview only', () => {
    expect(render()).not.toContain('topbar-title');
    const health = render({ route: 'system-health' }, 'id');
    expect(health).toContain('class="topbar-title"');
    expect(health).toContain('Kesehatan Sistem');
    expect(health).toContain('Dibaca 0 dtk lalu');
  });

  it('shows the brand mark only, named for assistive technology', () => {
    const markup = render();
    expect(markup).toMatch(/<span class="brand-mark" role="img" aria-label="Ground Console"[^>]*>GC<\/span>/);
    expect(markup).not.toContain('brand-name');
  });

  it('offers the saved refresh interval and the server intervals in the top bar', () => {
    const markup = render({ refreshSeconds: 2, refreshOptions: [0, 1, 2, 5, 10, 30], onRefreshSecondsChange: () => undefined }, 'id');
    const select = markup.match(/<select[^>]*refresh-interval[\s\S]*?<\/select>/)?.[0] ?? '';
    expect(select).toContain(`aria-label="${translate('id', 'shell.refreshInterval')}"`);
    expect(select).not.toContain('disabled');
    expect(select).toContain('<option value="0">Manual</option>');
    expect(select).toContain('<option value="2" selected="">2 dtk</option>');
    expect(select).toContain('<option value="30">30 dtk</option>');
  });

  it('disables the interval select until the configuration is known, and names a failed save', () => {
    const waiting = render({ onRefreshSecondsChange: () => undefined }).match(/<select[^>]*>/)?.[0] ?? '';
    expect(waiting).toContain('disabled');
    const failed = render({ refreshSeconds: 5, onRefreshSecondsChange: () => undefined, refreshError: 'request failed (500)' }).match(/<select[^>]*>/)?.[0] ?? '';
    expect(failed).toContain('aria-invalid="true"');
    expect(failed).toContain('request failed (500)');
  });

  it('renders the page toolbar slot it is given', () => {
    expect(render({ toolbar: <div className="probe-toolbar">tools</div> })).toMatch(/<div class="topbar-toolbar"><div class="probe-toolbar">tools<\/div><\/div>/);
    expect(render()).not.toContain('topbar-toolbar');
  });

  it('keeps an unknown saved interval selectable', () => {
    expect(refreshSelectOptions([0, 1, 2], 15)).toEqual([0, 1, 2, 15]);
    expect(refreshSelectOptions([2, 0, 2], null)).toEqual([0, 2]);
  });
});

/** Vitest blanks every CSS import, so the stylesheet is read from disk. */
function readStylesheet(path: string): string {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  return process.getBuiltinModule('node:fs').readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('top bar styles', () => {
  const css = readStylesheet('../console-design.css');

  it('fits its 44 px controls, padding and border inside --topbar-h so Overview does not scroll by a pixel', () => {
    const tokenHeight = Number(/--topbar-h:\s*(\d+)px/.exec(css)?.[1]);
    const rule = /(?:^|\n)\.topbar \{([^}]*)\}/.exec(css)?.[1] ?? '';
    const padding = /padding:\s*(\d+)px\s+\d+px\s*;/.exec(rule);
    expect(padding, rule).not.toBeNull();
    expect(44 + 2 * Number(padding?.[1]) + 1).toBeLessThanOrEqual(tokenHeight);
    expect(css).toMatch(/\.page-content-overview \{[^}]*height: calc\(100dvh - var\(--topbar-h\)\)/);
  });
});
