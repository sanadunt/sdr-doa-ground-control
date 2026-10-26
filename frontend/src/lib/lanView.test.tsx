import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { normalizeCapabilities, normalizeLanAccessBrief, normalizeLanAccessStatus, normalizeLanAccessView } from '../api';
import type { LanAccessView } from '../api';
import { accessFromHostname, consoleAccess, isLoopbackHost } from './access';
import { formatLanClients, lanDraftDirty, lanDraftFrom, lanErrorKey, lanReasonKey, lanSettingsFromDraft, lanStateChip, parseLanClients } from './lanAccessForm';
import { DICTIONARIES, I18nContext, translate } from './i18n';
import type { Lang } from './i18n';
import { DEFAULT_GPS_CONFIG } from './map';
import { DEFAULT_COMPASS_CONFIG } from './polar';
import { DEFAULT_OVERVIEW_PANELS } from './overviewPanels';
import { ConsoleShell } from '../components/Shell';
import { OverviewPanelToggles } from '../components/overview/OverviewPanelToggles';
import { ConfigurationPage, LanAccessCard } from '../pages/ConfigurationPage';
import { MessageMonitorPage } from '../pages/MessageMonitorPage';
import { OverviewPage } from '../pages/OverviewPage';
import { ReceiverMirrorPage } from '../pages/ReceiverMirrorPage';
import { createMirrorFeed } from './receiverMirrorFeed';
import type { MirrorFeedState, ReceiverMirrorFeed } from './receiverMirrorFeed';
import { normalizeMirrorAnswer } from './receiverMirror';
import { SpectrumDockMirror } from '../components/overview/SpectrumDockMirror';

/** Vitest blanks every CSS import, so a stylesheet is read from disk. */
function readSource(path: string): string {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  return process.getBuiltinModule('node:fs').readFileSync(new URL(path, import.meta.url), 'utf8');
}

function withI18n(node: ReactElement, lang: Lang = 'en'): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>{node}</I18nContext.Provider>,
  );
}

const SERVER_VIEW = {
  config: { enabled: true, port: 8788, bind: '0.0.0.0', allowed_clients: ['192.168.1.20', '192.168.1.0/24'] },
  status: { enabled: true, state: 'open', reason: null, detail: null, bind: '0.0.0.0', port: 8788, address: '0.0.0.0:8788', allowed_client_count: 2 },
};

describe('access', () => {
  it('treats a named non-loopback host as the LAN view until capabilities say otherwise', () => {
    expect(accessFromHostname('192.168.1.10')).toBe('lan-view');
    expect(accessFromHostname('groundstation.local')).toBe('lan-view');
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.8.9.1', '']) expect(accessFromHostname(host), host).toBe('local');
    expect(consoleAccess('local', '192.168.1.10')).toBe('local');
    expect(consoleAccess('lan-view', '127.0.0.1')).toBe('lan-view');
    expect(consoleAccess(null, '192.168.1.10')).toBe('lan-view');
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
  });

  it('reads access and the LAN state from capabilities without trusting their shape', () => {
    const caps = normalizeCapabilities({ access: 'lan-view', lan_access: { enabled: true, state: 'open', reason: null } });
    expect(caps.access).toBe('lan-view');
    expect(caps.lanAccess).toEqual({ enabled: true, state: 'open', reason: null });
    expect(normalizeCapabilities({ access: 'admin', lan_access: { enabled: 'yes', state: 'open' } })).toMatchObject({ access: null, lanAccess: null });
    expect(normalizeLanAccessBrief({ enabled: true, state: 'closed', reason: 'ADMIN_PASSWORD_DEFAULT' })).toEqual({ enabled: true, state: 'closed', reason: 'ADMIN_PASSWORD_DEFAULT' });
    expect(normalizeLanAccessBrief({ enabled: true, state: 'closed', reason: 'SOMETHING' })?.reason).toBeNull();
    expect(normalizeLanAccessBrief({ enabled: true, state: 'ajar' })).toBeNull();
  });

  it('normalizes the /api/lan-access answer', () => {
    const view = normalizeLanAccessView(SERVER_VIEW);
    expect(view.config).toEqual({ enabled: true, port: 8788, bind: '0.0.0.0', allowedClients: ['192.168.1.20', '192.168.1.0/24'] });
    expect(view.status).toMatchObject({ state: 'open', address: '0.0.0.0:8788', allowedClientCount: 2 });
    const closed = normalizeLanAccessStatus({ ...SERVER_VIEW.status, state: 'closed', reason: 'BIND_FAILED', detail: 'EADDRINUSE', address: '0.0.0.0:8788' });
    expect(closed).toMatchObject({ state: 'closed', reason: 'BIND_FAILED', detail: 'EADDRINUSE', address: null });
    for (const broken of [null, {}, { ...SERVER_VIEW, config: { ...SERVER_VIEW.config, port: 'x' } }, { ...SERVER_VIEW, config: { ...SERVER_VIEW.config, allowed_clients: [42] } }, { ...SERVER_VIEW, status: null }]) {
      expect(() => normalizeLanAccessView(broken)).toThrow();
    }
  });
});

describe('LAN access form', () => {
  it('splits the allowed clients on commas, spaces and new lines without repeats', () => {
    expect(parseLanClients(' 192.168.1.20, 192.168.1.0/24\nfd00::/64;192.168.1.20  ')).toEqual(['192.168.1.20', '192.168.1.0/24', 'fd00::/64']);
    expect(parseLanClients('   ')).toEqual([]);
    expect(formatLanClients(['a', 'b'])).toBe('a, b');
  });

  it('checks what the page can tell before the console does', () => {
    const draft = { enabled: true, port: '8788', bind: '0.0.0.0', clients: '192.168.1.20' };
    expect(lanSettingsFromDraft(draft, 8787)).toEqual({ ok: true, value: { enabled: true, port: 8788, bind: '0.0.0.0', allowedClients: ['192.168.1.20'] } });
    for (const port of ['', '80', '1023', '65536', '8788.5', 'abc']) {
      expect(lanSettingsFromDraft({ ...draft, port }, 8787), port).toMatchObject({ ok: false, field: 'port', error: 'config.lanPortInvalid' });
    }
    expect(lanSettingsFromDraft({ ...draft, port: '8787' }, 8787)).toMatchObject({ ok: false, field: 'port', error: 'config.lanPortConsole' });
    expect(lanSettingsFromDraft({ ...draft, port: '8787' }, null).ok).toBe(true);
    expect(lanSettingsFromDraft({ ...draft, bind: ' ' }, 8787)).toMatchObject({ ok: false, field: 'bind' });
    const many = Array.from({ length: 33 }, (_, index) => `192.168.1.${index}`).join(',');
    expect(lanSettingsFromDraft({ ...draft, clients: many }, 8787)).toMatchObject({ ok: false, field: 'clients', error: 'config.lanClientsTooMany' });
  });

  it('knows when the draft differs from the saved setting', () => {
    const saved = { enabled: false, port: 8788, bind: '0.0.0.0', allowedClients: ['192.168.1.20', '192.168.1.0/24'] };
    const draft = lanDraftFrom(saved);
    expect(lanDraftDirty(draft, saved)).toBe(false);
    expect(lanDraftDirty({ ...draft, clients: '192.168.1.20 192.168.1.0/24' }, saved)).toBe(false);
    expect(lanDraftDirty({ ...draft, enabled: true }, saved)).toBe(true);
    expect(lanDraftDirty({ ...draft, port: '8789' }, saved)).toBe(true);
    expect(lanDraftDirty({ ...draft, clients: '192.168.1.20' }, saved)).toBe(true);
  });

  it('has an EN and ID message for every closed reason and error code', () => {
    for (const reason of ['DISABLED', 'ADMIN_PASSWORD_DEFAULT', 'ADMIN_DISABLED', 'PORT_CONFLICT', 'BIND_FAILED', 'STOPPED'] as const) {
      const key = lanReasonKey(reason);
      expect(DICTIONARIES.en[key]).toBeTruthy();
      expect(DICTIONARIES.id[key]).toBeTruthy();
    }
    for (const code of ['ORIGIN_REJECTED', 'ADMIN_REQUIRED', 'LAN_ACCESS_INVALID', 'LAN_ADMIN_PASSWORD_DEFAULT', 'LAN_ACCESS_SAVE_FAILED']) {
      const key = lanErrorKey(code);
      expect(key, code).not.toBeNull();
      expect(DICTIONARIES.id[key!]).toBeTruthy();
    }
    expect(lanErrorKey('SOMETHING_ELSE')).toBeNull();
    expect(lanErrorKey(null)).toBeNull();
    expect(translate('id', 'shell.viewOnly')).toBe('LIHAT SAJA');
    expect(translate('en', 'shell.viewOnly')).toBe('VIEW ONLY');
  });

  it('marks the state chip', () => {
    expect(lanStateChip(null)).toEqual({ code: 'UNKNOWN', tone: 'neutral' });
    expect(lanStateChip(normalizeLanAccessStatus(SERVER_VIEW.status))).toEqual({ code: 'OPEN', tone: 'good' });
    expect(lanStateChip(normalizeLanAccessStatus({ ...SERVER_VIEW.status, state: 'closed', reason: 'DISABLED', enabled: false }))).toEqual({ code: 'CLOSED', tone: 'neutral' });
    expect(lanStateChip(normalizeLanAccessStatus({ ...SERVER_VIEW.status, state: 'closed', reason: 'BIND_FAILED' }))).toEqual({ code: 'CLOSED', tone: 'warn' });
  });
});

function shell(access: 'local' | 'lan-view', lang: Lang = 'en'): string {
  return withI18n(
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
      refreshSeconds={2}
      onRefreshSecondsChange={access === 'local' ? () => undefined : undefined}
      access={access}
    >
      <div />
    </ConsoleShell>,
    lang,
  );
}

describe('LAN view UI', () => {
  it('shows VIEW ONLY in the top bar and the page menu, and the interval only as a value', () => {
    for (const lang of ['en', 'id'] as const) {
      const markup = shell('lan-view', lang);
      const chip = translate(lang, 'shell.viewOnly');
      expect(markup).toContain(`<div class="topbar-tools"><span class="ov-chip tone-info view-only-chip">${chip}</span>`);
      expect(markup).toContain(`<div class="local-chip">`);
      expect(markup.match(new RegExp(chip, 'g'))).toHaveLength(2);
      expect(markup.match(/<select[^>]*refresh-interval[^>]*>/)?.[0]).toContain('disabled');
    }
    const local = shell('local');
    expect(local).not.toContain('view-only-chip');
    expect(local).not.toContain('VIEW ONLY');
    expect(local).not.toContain('is-view-only');
    expect(local.match(/<select[^>]*refresh-interval[^>]*>/)?.[0]).not.toContain('disabled');
  });

  it('gives the interval select\'s place to the chip on a phone', () => {
    expect(shell('lan-view')).toMatch(/<div class="console-shell is-overview is-view-only">/);
    const css = readSource('../console-design.css');
    const phone = css.match(/@media \(max-width: 600px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(phone).toContain('.console-shell.is-view-only .refresh-interval { display: none; }');
  });

  it('has no Kontrol switch in the LAN view', () => {
    const panels = { ...DEFAULT_OVERVIEW_PANELS, control: true };
    expect(withI18n(<OverviewPanelToggles panels={panels} onChange={() => undefined} />)).toContain('aria-controls="panel-control"');
    const view = withI18n(<OverviewPanelToggles panels={panels} onChange={() => undefined} viewOnly />);
    expect(view).not.toContain('panel-control');
    expect(view).toContain('aria-controls="panel-spectrum"');
  });

  it('never shows Kontrol or the Receiver dock on the LAN view Dashboard', () => {
    const markup = withI18n(
      <OverviewPage
        snapshot={null}
        localSnapshotFresh={false}
        gpsConfig={DEFAULT_GPS_CONFIG}
        compassConfig={DEFAULT_COMPASS_CONFIG}
        panels={{ ...DEFAULT_OVERVIEW_PANELS, control: true, spectrum: true }}
        viewOnly
      />,
    );
    expect(markup).not.toContain('id="panel-control"');
    expect(markup).not.toContain('data-control="open"');
    // The dock shows the groundstation's Receiver as MIRROR, every control disabled.
    expect(markup).toContain('<section id="panel-spectrum" class="ov-spectrum is-view-only is-mirror"');
    expect(markup).toContain('<span class="ov-tag tone-info">MIRROR</span>');
    expect(markup).toContain(translate('en', 'mirror.connecting'));
    const dock = markup.slice(markup.indexOf('<section id="panel-spectrum"'));
    const dockButtons = dock.slice(0, dock.indexOf('</section>')).match(/<button[^>]*>/g) ?? [];
    expect(dockButtons).toHaveLength(4);
    for (const tag of dockButtons) expect(tag).toContain('disabled');
    expect(markup).toContain('role="img"');
    expect(markup).not.toContain('role="slider"');
    expect(markup).not.toContain('ov-spec-settings-toggle');
    expect(markup).not.toContain('ov-spec-mark');
    expect(markup).not.toContain('/receiver/');
    expect(markup).not.toContain('<iframe');
    expect(markup).not.toContain('<audio');
  });

  it('shows the Receiver route as the mirror without the frame', () => {
    for (const lang of ['en', 'id'] as const) {
      const markup = withI18n(<ReceiverMirrorPage feed={createMirrorFeed()} />, lang);
      expect(markup).toContain('>MIRROR</span>');
      expect(markup).toContain(translate(lang, 'mirror.stateTitle'));
      expect(markup).toContain(translate(lang, 'mirror.connecting'));
      expect(markup).toContain('class="ov-spectrum is-view-only is-mirror rx-mirror-spectrum"');
      expect(markup).not.toContain('<iframe');
      expect(markup).not.toContain('<audio');
      expect(markup).not.toContain('role="slider"');
    }
  });

  it('shows the mirror as live, STALE after 3 s and SOURCE LOST / SUMBER PUTUS after 10 s', () => {
    const fixture = JSON.parse(readSource('../../../tools/fixtures/receiver-mirror/publish.json')) as Record<string, unknown>;
    const answer = normalizeMirrorAnswer({
      ok: true, v: 1, rev: 5, frame_rev: 3, source: fixture.source, source_age_ms: 100, state: fixture.state, state_age_ms: 100,
      frame: fixture.frame, frame_age_ms: 150, limits: { frame_stale_ms: 3000, source_lost_ms: 10000 },
    });
    expect(answer).not.toBeNull();
    const feedAt = (ageMs: number): ReceiverMirrorFeed => {
      const state: MirrorFeedState = { answer, receivedAtMs: Date.now() - ageMs, error: false };
      return { retain: () => () => undefined, getState: () => state, onState: () => () => undefined, onSpectrum: () => () => undefined };
    };
    const chip = (markup: string) => markup.match(/<span class="ov-chip tone-(\w+)">([^<]*)<\/span>/)?.slice(1);
    const live = withI18n(<SpectrumDockMirror feed={feedAt(0)} />);
    expect(chip(live)).toEqual(['good', 'RX']);
    expect(live).not.toContain('is-stopped');
    expect(live).toContain('Center 433.920 MHz');
    const stale = withI18n(<SpectrumDockMirror feed={feedAt(5_000)} />, 'id');
    expect(chip(stale)).toEqual(['warn', 'STALE']);
    expect(stale).toContain('ov-spec-trace is-stopped');
    expect(stale).toMatch(/Frame terakhir 5\.\d dtk lalu\./);
    for (const lang of ['en', 'id'] as const) {
      const lost = withI18n(<SpectrumDockMirror feed={feedAt(20_000)} />, lang);
      expect(chip(lost)).toEqual(['bad', translate(lang, 'mirror.chipLost')]);
      expect(lost).toContain('ov-spec-trace is-stopped');
    }
    expect(translate('id', 'mirror.chipLost')).toBe('SUMBER PUTUS');
  });

  it('has no Reconnect on the Message Monitor in the LAN view', () => {
    const page = (readOnly: boolean) => withI18n(
      <MessageMonitorPage mqtt={null} config={{ base_url: 'http://127.0.0.1:8081', mqtt_host: '127.0.0.1', mqtt_port: 1883, refresh_seconds: 2 }} onMqttChanged={() => undefined} readOnly={readOnly} />,
    );
    expect(page(false)).toContain(`>${translate('en', 'monitor.reconnect')}</button>`);
    expect(page(true)).not.toContain(`>${translate('en', 'monitor.reconnect')}</button>`);
  });
});

function configuration(readOnly: boolean, lang: Lang = 'en'): string {
  return withI18n(
    <ConfigurationPage
      config={{ base_url: 'http://127.0.0.1:8081', mqtt_host: '10.90.0.1', mqtt_port: 9001, refresh_seconds: 2 }}
      branding={{ app_name: 'Ground Console', logo_data_url: '' }}
      gpsConfig={DEFAULT_GPS_CONFIG}
      compassConfig={DEFAULT_COMPASS_CONFIG}
      onGpsConfigChanged={() => undefined}
      onCompassConfigChanged={() => undefined}
      onConfigSaved={async () => undefined}
      onBrandingChanged={() => undefined}
      readOnly={readOnly}
    />,
    lang,
  );
}

describe('Configuration in the LAN view', () => {
  it('shows the console settings without Save, admin, LAN access or dry-run', () => {
    const markup = configuration(true);
    expect(markup).toContain('<span class="ov-chip tone-info">VIEW ONLY</span>');
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain('id="lan-settings"');
    expect(markup).not.toContain('id="dry-run-settings"');
    expect(markup).not.toContain(`>${translate('en', 'config.reconnect')}</button>`);
    expect(markup).not.toContain('NO TLS');
    // Connection and MQTT fields are locked; the values still show.
    expect(markup.match(/<fieldset class="cfg-fieldset" disabled="">/g)).toHaveLength(2);
    expect(markup).toContain('value="http://127.0.0.1:8081"');
    // GPS & Compass stay this browser's choice; Save appears nowhere.
    expect(markup.match(/type="submit"/g)).toHaveLength(2);
    expect(markup).not.toContain(`>${translate('en', 'config.save')}</button>`);
    expect(markup).toContain('Ground Console');
    const index = markup.match(/<nav class="cfg-index"[\s\S]*?<\/nav>/)?.[0] ?? '';
    expect([...index.matchAll(/aria-controls="([^"]+)"/g)].map((match) => match[1])).toEqual(['connection-settings', 'mqtt-settings', 'navigation-settings', 'branding-settings']);
  });

  it('puts the LAN access card under MQTT on the console itself', () => {
    const markup = configuration(false);
    expect(markup.indexOf('id="mqtt-settings"')).toBeLessThan(markup.indexOf('id="lan-settings"'));
    expect(markup.indexOf('id="lan-settings"')).toBeLessThan(markup.indexOf('id="navigation-settings"'));
    expect(markup).not.toContain('view-only');
    expect(configuration(false, 'id')).toContain(`>${translate('id', 'config.lanTitle')}</h2>`);
  });
});

describe('LAN access card', () => {
  const view: LanAccessView = normalizeLanAccessView(SERVER_VIEW);

  it('shows the live state and address with labels and values only', () => {
    for (const lang of ['en', 'id'] as const) {
      const markup = withI18n(<LanAccessCard adminAuthenticated defaultPassword={false} onAdminLost={() => undefined} initialView={view} />, lang);
      expect(markup).toContain('<span class="ov-chip tone-good">OPEN</span>');
      expect(markup).toContain('http://0.0.0.0:8788/');
      expect(markup).toContain('value="192.168.1.20, 192.168.1.0/24"');
      expect(markup).toContain('<span class="pg-unit">2/32</span>');
      expect(markup).toContain('role="switch" aria-checked="true"');
      expect(markup).toContain('<fieldset class="cfg-fieldset">');
      expect(markup).not.toContain(translate(lang, 'config.lanAdminNeeded').replace('&', '&amp;'));
      expect(markup).not.toContain('<small');
    }
  });

  it('locks the fields until admin is unlocked and says so', () => {
    const markup = withI18n(<LanAccessCard adminAuthenticated={false} defaultPassword={false} onAdminLost={() => undefined} initialView={view} />);
    expect(markup).toContain('<fieldset class="cfg-fieldset" disabled="">');
    expect(markup).toContain(translate('en', 'config.lanAdminNeeded').replace('&', '&amp;'));
    expect(markup).toMatch(/<button class="ov-button" type="submit" disabled="">/);
  });

  it('cannot be switched on while the default admin password is in use', () => {
    const off = normalizeLanAccessView({ ...SERVER_VIEW, config: { ...SERVER_VIEW.config, enabled: false }, status: { ...SERVER_VIEW.status, enabled: false, state: 'closed', reason: 'DISABLED', address: null } });
    const markup = withI18n(<LanAccessCard adminAuthenticated defaultPassword onAdminLost={() => undefined} initialView={off} />);
    expect(markup).toMatch(/<button type="button" role="switch" aria-checked="false" class="pg-switch" disabled="">/);
    expect(markup).toContain('<span class="ov-chip tone-neutral">CLOSED</span>');
    // Off is not a fault: no notice.
    expect(markup).not.toContain('pg-notice');
  });

  it('names why an enabled LAN view stays closed', () => {
    const refused = normalizeLanAccessView({ ...SERVER_VIEW, status: { ...SERVER_VIEW.status, state: 'closed', reason: 'BIND_FAILED', detail: 'EADDRINUSE', address: null } });
    const markup = withI18n(<LanAccessCard adminAuthenticated defaultPassword={false} onAdminLost={() => undefined} initialView={refused} />, 'id');
    expect(markup).toContain('<span class="ov-chip tone-warn">CLOSED</span>');
    expect(markup).toContain(translate('id', 'config.lanReason.BIND_FAILED', { detail: 'EADDRINUSE' }));
    expect(markup).toContain('<strong class="pg-notice-title">BIND_FAILED</strong>');
  });
});
