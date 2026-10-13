import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConsoleShell, formatElapsed } from './Shell';
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
