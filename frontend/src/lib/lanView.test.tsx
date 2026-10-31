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
import { ReceiverMirrorPage, mirrorStateItems } from '../pages/ReceiverMirrorPage';
import { createMirrorFeed } from './receiverMirrorFeed';
import type { MirrorFeedState, ReceiverMirrorFeed } from './receiverMirrorFeed';
import { mirrorView, normalizeMirrorAnswer } from './receiverMirror';
import { SpectrumDockMirror, mirrorInfoText } from '../components/overview/SpectrumDockMirror';
import { createMirrorMarkController } from './receiverMirrorMarks';
import type { MirrorMarkClient, MirrorMarkController, MirrorMarkOutcome } from './receiverMirrorMarks';

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
    // The dock shows the groundstation's Receiver as MIRROR, every radio control disabled;
    // Markers/Penanda is the one that works (marker add and remove, 2026-10-31).
    expect(markup).toContain('<section id="panel-spectrum" class="ov-spectrum is-view-only is-mirror"');
    expect(markup).toContain('<span class="ov-tag tone-info">MIRROR</span>');
    expect(markup).toContain(translate('en', 'mirror.connecting'));
    const dock = markup.slice(markup.indexOf('<section id="panel-spectrum"'));
    const dockButtons = dock.slice(0, dock.indexOf('</section>')).match(/<button[^>]*>/g) ?? [];
    expect(dockButtons).toHaveLength(5);
    const enabled = dockButtons.filter((tag) => !tag.includes('disabled'));
    expect(enabled).toEqual([`<button class="ov-button ov-spec-mark" type="button" aria-pressed="false" title="${translate('en', 'mirror.markNoSource')}">`]);
    // Marking is off at every mount: the trace is a picture until it is turned on.
    expect(markup).toContain('role="img"');
    expect(markup).not.toContain('role="slider"');
    expect(markup).not.toContain('role="application"');
    expect(markup).not.toContain('ov-spec-settings-toggle');
    expect(markup).not.toContain('ov-spec-mark-row');
    expect(markup).not.toContain('/receiver/');
    expect(markup).not.toContain('<iframe');
    expect(markup).not.toContain('<audio');
  });

  it('shows the Receiver route as the mirror without the frame', () => {
    for (const lang of ['en', 'id'] as const) {
      const markup = withI18n(<ReceiverMirrorPage feed={createMirrorFeed()} initialTab="mirror" />, lang);
      expect(markup).toContain('>MIRROR</span>');
      expect(markup).toContain(translate(lang, 'mirror.stateTitle'));
      expect(markup).toContain(translate(lang, 'mirror.connecting'));
      expect(markup).toContain('class="ov-spectrum is-view-only is-mirror rx-mirror-spectrum"');
      // The Mirror | Records switch sits in the page bar.
      expect(markup).toContain(`aria-label="${translate(lang, 'records.tabs')}"`);
      expect(markup).toContain(`<button type="button" aria-pressed="true">${translate(lang, 'records.tabMirror')}</button>`);
      expect(markup).not.toContain('<iframe');
      expect(markup).not.toContain('<audio');
      expect(markup).not.toContain('role="slider"');
    }
  });

  it('shows the Records tab read only: browse, play and download one record, nothing that writes', () => {
    for (const lang of ['en', 'id'] as const) {
      const markup = withI18n(<ReceiverMirrorPage feed={createMirrorFeed()} initialTab="records" />, lang);
      expect(markup).toContain(`<button type="button" aria-pressed="true">${translate(lang, 'records.tabRecords')}</button>`);
      expect(markup).toContain(translate(lang, 'records.modeDay'));
      expect(markup).toContain(translate(lang, 'records.modeAll'));
      expect(markup).toContain(translate(lang, 'records.loading'));
      expect(markup).toContain(`aria-label="${translate(lang, 'records.filters')}"`);
      // The mirror is not read while Records shows, and no player exists before a row is opened.
      expect(markup).not.toContain('MIRROR');
      expect(markup).not.toContain('<audio');
      expect(markup).not.toContain('<iframe');
      // No delete, selection ZIP, retention or settings control.
      for (const forbidden of ['type="checkbox"', 'Hapus', 'Delete', 'ZIP', 'Retens', 'Retention', 'Auto-archive', 'method="post"']) {
        expect(markup).not.toContain(forbidden);
      }
    }
    const css = readSource('../pages/receiver-mirror.css');
    const records = css.slice(css.indexOf('/* Records tab'));
    expect(records.length).toBeGreaterThan(100);
    // Console tokens only, 44 px targets.
    expect(records).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(records).toContain('min-height: 44px');
    expect(records).toContain('.rec-tl-strip { position: relative; height: 44px;');
  });

  describe('marking from the tablet', () => {
    const fixture = JSON.parse(readSource('../../../tools/fixtures/receiver-mirror/publish.json')) as Record<string, unknown>;
    const answerWith = (markers: unknown) => normalizeMirrorAnswer({
      ok: true, v: 1, rev: 5, frame_rev: 3, source: fixture.source, source_age_ms: 100, state: fixture.state, state_age_ms: 100,
      frame: fixture.frame, frame_age_ms: 150, limits: { frame_stale_ms: 3000, source_lost_ms: 10000 }, markers,
    });
    const feedOf = (answer: ReturnType<typeof normalizeMirrorAnswer>, ageMs = 0): ReceiverMirrorFeed => {
      const state: MirrorFeedState = { answer, receivedAtMs: Date.now() - ageMs, error: false };
      return { retain: () => () => undefined, getState: () => state, onState: () => () => undefined, onSpectrum: () => () => undefined };
    };
    /** A controller whose commands settle when the test says so, turned on. */
    const marking = (): { controller: MirrorMarkController; settle: (outcome: MirrorMarkOutcome) => void } => {
      let settle: (outcome: MirrorMarkOutcome) => void = () => undefined;
      const pending = () => new Promise<MirrorMarkOutcome>((resolve) => { settle = resolve; });
      const client: MirrorMarkClient = { add: pending, remove: pending };
      const controller = createMirrorMarkController(client);
      controller.toggle();
      return { controller, settle: (outcome) => settle(outcome) };
    };
    const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
    const head = (markup: string) => markup.slice(markup.indexOf('<div class="ov-dock-head'), markup.indexOf('<div class="ov-spec-main'));

    it('turns the trace into a marking canvas, never a tuning one, with every radio control still disabled', () => {
      const { controller } = marking();
      for (const lang of ['en', 'id'] as const) {
        const markup = withI18n(<SpectrumDockMirror feed={feedOf(answerWith(fixture.markers))} markController={controller} />, lang);
        expect(markup).toContain(`role="application" aria-label="${translate(lang, 'mirror.canvasAriaMarking')}"`);
        expect(markup).not.toContain('role="slider"');
        expect(markup).toContain('ov-spec-trace is-marking is-read-only');
        // The toggle is pressed and counts the groundstation's list; Mulai, Dengar and the mode switch stay disabled.
        const buttons = head(markup).match(/<button[^>]*>/g) ?? [];
        expect(buttons.filter((tag) => !tag.includes('disabled'))).toEqual(['<button class="ov-button ov-spec-mark" type="button" aria-pressed="true">']);
        expect(head(markup)).toContain('<span class="ov-spec-mark-count">2</span>');
        expect(markup).not.toContain(translate(lang, 'mirror.markNoSource'));
      }
    });

    it('shows a picked marker with Remove and without Tune here', () => {
      const { controller } = marking();
      controller.select('m-2');
      for (const lang of ['en', 'id'] as const) {
        const markup = withI18n(<SpectrumDockMirror feed={feedOf(answerWith(fixture.markers))} markController={controller} />, lang);
        expect(markup).toContain('<span class="ov-spec-mark-readout">Repeater · 434.000 MHz · −48.5 dB</span>');
        expect(markup).toContain(`>${translate(lang, 'spectrum.markRemove')}</button>`);
        expect(markup).not.toContain(translate(lang, 'spectrum.markTune'));
        expect(markup).not.toContain(translate(lang, 'spectrum.markUnsaved'));
      }
    });

    it('says Not saved while no marker set is selected on the groundstation', () => {
      const { controller } = marking();
      const unsaved = { ...(fixture.markers as Record<string, unknown>), saved: false };
      for (const lang of ['en', 'id'] as const) {
        const markup = withI18n(<SpectrumDockMirror feed={feedOf(answerWith(unsaved))} markController={controller} />, lang);
        expect(markup).toContain(`<span class="ov-tag tone-warn">${translate(lang, 'spectrum.markUnsaved')}</span>`);
      }
    });

    it('shows a mark on its way, then the failure in operator words', async () => {
      const { controller, settle } = marking();
      controller.mark(433_700_000, { blocked: null, frequencyShiftHz: 0, markers: [] });
      const sending = withI18n(<SpectrumDockMirror feed={feedOf(answerWith(fixture.markers))} markController={controller} />, 'id');
      expect(sending).toContain(translate('id', 'mirror.markSending'));
      settle({ ok: false, code: 'MIRROR_MARKER_BUSY', markerId: null });
      await flush();
      const busy = withI18n(<SpectrumDockMirror feed={feedOf(answerWith(fixture.markers))} markController={controller} />, 'id');
      expect(busy).not.toContain(translate('id', 'mirror.markSending'));
      expect(busy).toContain(translate('id', 'mirror.markBusy'));
    });

    it('pauses marking with its reason while the source is lost or its frames are stale', () => {
      const { controller } = marking();
      for (const lang of ['en', 'id'] as const) {
        const stale = withI18n(<SpectrumDockMirror feed={feedOf(answerWith(fixture.markers), 5_000)} markController={controller} />, lang);
        expect(stale).toContain(translate(lang, 'mirror.markStale'));
        expect(stale).toContain('role="img"');
        expect(stale).not.toContain('role="application"');
        expect(head(stale)).toContain(`aria-pressed="true" title="${translate(lang, 'mirror.markStale')}"`);
        const lost = withI18n(<SpectrumDockMirror feed={feedOf(answerWith(fixture.markers), 20_000)} markController={controller} />, lang);
        expect(lost).toContain(translate(lang, 'mirror.markNoSource'));
        expect(lost).not.toContain('role="application"');
        const none = withI18n(<SpectrumDockMirror feed={feedOf(normalizeMirrorAnswer({ ok: true, v: 1, rev: 0, frame_rev: 0, source: null, state: null, frame: null }))} markController={controller} />, lang);
        expect(none).toContain(translate(lang, 'mirror.markNoSource'));
      }
    });

    it('marks on the Receiver route too, from the Spectrum card', () => {
      const { controller } = marking();
      const markup = withI18n(<ReceiverMirrorPage feed={feedOf(answerWith(fixture.markers))} initialTab="mirror" markController={controller} />, 'id');
      expect(markup).toContain('<button class="ov-button ov-spec-mark" type="button" aria-pressed="true"><svg');
      expect(markup).toContain(`role="application" aria-label="${translate('id', 'mirror.canvasAriaMarking')}"`);
      // Records never get the toggle.
      const records = withI18n(<ReceiverMirrorPage feed={feedOf(answerWith(fixture.markers))} initialTab="records" markController={controller} />, 'id');
      expect(records).not.toContain('ov-spec-mark');
    });

    it('keeps its touch targets at 44 px and the marking cursor on a view-only trace', () => {
      const css = readSource('../overview-dashboard.css');
      expect(css).toMatch(/\.ov-button \{[^}]*height: 44px;/u);
      expect(css).toContain('.ov-spec-trace.is-read-only:not(.is-marking), .ov-spec-waterfall.is-read-only:not(.is-marking) { cursor: default; }');
      expect(css).toContain('.ov-spec-trace.is-marking, .ov-spec-waterfall.is-marking, .ov-spec-trace.is-marking .ov-spec-overlay { cursor: copy; }');
    });
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

  it('keeps Stop on a running scan or RX while its frames are STALE or its source is lost', () => {
    const fixture = JSON.parse(readSource('../../../tools/fixtures/receiver-mirror/publish.json')) as Record<string, unknown>;
    const fixtureState = fixture.state as Record<string, unknown>;
    const answerWith = (state: Record<string, unknown>, frameKind: 'rx' | 'sweep') => normalizeMirrorAnswer({
      ok: true, v: 1, rev: 5, frame_rev: 3, source: fixture.source, source_age_ms: 100, state, state_age_ms: 100,
      frame: { ...(fixture.frame as Record<string, unknown>), kind: frameKind }, frame_age_ms: 150, limits: { frame_stale_ms: 3000, source_lost_ms: 10000 },
    });
    const scanAnswer = answerWith({ ...fixtureState, busy: 'sweep', running: false, scan: { phase: 'active', start_hz: 400_000_000, stop_hz: 500_000_000, resolution_hz: 4882.8125 } }, 'sweep');
    const rxAnswer = answerWith(fixtureState, 'rx');
    expect([scanAnswer?.state?.busy, rxAnswer?.state?.running]).toEqual(['sweep', true]);
    const feedAt = (answer: typeof scanAnswer, ageMs: number): ReceiverMirrorFeed => {
      const state: MirrorFeedState = { answer, receivedAtMs: Date.now() - ageMs, error: false };
      return { retain: () => () => undefined, getState: () => state, onState: () => () => undefined, onSpectrum: () => () => undefined };
    };
    const chip = (markup: string) => markup.match(/<span class="ov-chip tone-\w+">([^<]*)<\/span>/)?.[1];
    const runLabel = (markup: string) => markup.match(/<button class="ov-button ov-spec-run" type="button" disabled="">[\s\S]*?<span>([^<]*)<\/span>/)?.[1];
    for (const lang of ['en', 'id'] as const) {
      const stop = translate(lang, 'spectrum.stop');
      for (const [answer, liveChip] of [[scanAnswer, 'SCAN'], [rxAnswer, 'RX']] as const) {
        const live = withI18n(<SpectrumDockMirror feed={feedAt(answer, 0)} />, lang);
        expect([chip(live), runLabel(live)]).toEqual([liveChip, stop]);
        const stale = withI18n(<SpectrumDockMirror feed={feedAt(answer, 5_000)} />, lang);
        expect([chip(stale), runLabel(stale)]).toEqual(['STALE', stop]);
        const lost = withI18n(<SpectrumDockMirror feed={feedAt(answer, 20_000)} />, lang);
        expect([chip(lost), runLabel(lost)]).toEqual([translate(lang, 'mirror.chipLost'), stop]);
      }
      const stopped = withI18n(<SpectrumDockMirror feed={feedAt(answerWith({ ...fixtureState, running: false }, 'rx'), 0)} />, lang);
      expect([chip(stopped), runLabel(stopped)]).toEqual(['RX OFF', translate(lang, 'spectrum.start')]);
    }
  });

  it('shows the scan\'s own gains while a scan runs, never the RX gains as the scan\'s', () => {
    const fixture = JSON.parse(readSource('../../../tools/fixtures/receiver-mirror/publish.json')) as Record<string, unknown>;
    const fixtureState = fixture.state as Record<string, unknown>;
    const fixtureScan = fixtureState.scan as Record<string, unknown>;
    const viewOf = (state: Record<string, unknown>, frameKind: 'rx' | 'sweep') => mirrorView({
      answer: normalizeMirrorAnswer({
        ok: true, v: 1, rev: 5, frame_rev: 3, source: fixture.source, source_age_ms: 100, state, state_age_ms: 100,
        frame: { ...(fixture.frame as Record<string, unknown>), kind: frameKind }, frame_age_ms: 150, limits: { frame_stale_ms: 3000, source_lost_ms: 10000 },
      }),
      receivedAtMs: 0,
      error: false,
      nowMs: 0,
    });
    const scanning = (phase: string, scan: Record<string, unknown> = fixtureScan) => viewOf({ ...fixtureState, busy: 'sweep', running: false, scan: { ...scan, phase } }, 'sweep');
    // The fixture's RX gains (16, 20, off) differ from its scan's (24, 30, on).
    expect([fixtureState.gains, fixtureScan.gains]).toEqual([{ lna_db: 16, vga_db: 20, amp: false }, { lna_db: 24, vga_db: 30, amp: true }]);
    for (const lang of ['en', 'id'] as const) {
      const t: Parameters<typeof mirrorStateItems>[0] = (key, vars) => translate(lang, key, vars);
      const gainRows = (view: ReturnType<typeof mirrorView>) => mirrorStateItems(t, view)
        .filter((item) => ['lna', 'vga', 'amp'].includes(item.id ?? ''))
        .map((item) => [item.label, item.value]);
      const scanLabel = (gain: string) => translate(lang, 'mirror.scanGain', { gain });
      for (const phase of ['starting', 'active', 'stopping']) {
        expect(gainRows(scanning(phase))).toEqual([[scanLabel('LNA'), '24 dB'], [scanLabel('VGA'), '30 dB'], [scanLabel('+14 dB'), 'ON']]);
      }
      expect(gainRows(viewOf(fixtureState, 'rx'))).toEqual([['LNA', '16 dB'], ['VGA', '20 dB'], ['+14 dB', 'OFF']]);
      // An older groundstation page sends no scan gains: unknown, not the RX gains.
      const { gains: _gains, ...older } = fixtureScan;
      expect(gainRows(scanning('active', older))).toEqual([[scanLabel('LNA'), '—'], [scanLabel('VGA'), '—'], [scanLabel('+14 dB'), '—']]);
      // The dock's info line in Spektrum mode: the scan's gains, as the groundstation dock shows them.
      const info = mirrorInfoText(t, scanning('active'));
      expect(info).toContain('LNA 24 dB · VGA 30 dB · +14 dB');
      expect(info).not.toContain('LNA 16 dB');
      expect(mirrorInfoText(t, scanning('active', older))).toContain('LNA — dB · VGA — dB');
      expect(mirrorInfoText(t, viewOf(fixtureState, 'rx'))).toContain('LNA 16 dB · VGA 20 dB');
    }
    expect(translate('en', 'mirror.scanGain', { gain: 'LNA' })).not.toBe(translate('id', 'mirror.scanGain', { gain: 'LNA' }));
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
