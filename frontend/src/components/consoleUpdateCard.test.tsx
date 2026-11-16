import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConsoleUpdateCard } from './ConsoleUpdateCard';
import { I18nContext, translate } from '../lib/i18n';
import type { Lang } from '../lib/i18n';
import { normalizeConsoleUpdate } from '../lib/consoleUpdate';
import type { ConsoleUpdateView, UpdateStep } from '../lib/consoleUpdate';

const NOW = 1_800_000_000_000;

/** Vitest blanks every CSS import, so the stylesheet is read from disk. */
function readSource(path: string): string {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  return process.getBuiltinModule('node:fs').readFileSync(new URL(path, import.meta.url), 'utf8');
}

function view(overrides: Record<string, unknown> = {}): ConsoleUpdateView {
  const value = normalizeConsoleUpdate({
    ok: true,
    installed: '3.22.0',
    latest: { state: 'ok', version: '3.23.0', url: 'https://github.com/sanadunt/sdr-doa-ground-control/releases/tag/v3.23.0', code: null, major: 3 },
    update_available: true,
    helper: { available: true, reason: null },
    status: null,
    ...overrides,
  });
  if (!value) throw new Error('fixture');
  return value;
}

function card(initialView: ConsoleUpdateView | null, initialStep?: UpdateStep, lang: Lang = 'en'): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>
      <ConsoleUpdateCard initialView={initialView} initialStep={initialStep} />
    </I18nContext.Provider>,
  );
}

const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars);

describe('Console update card', () => {
  it('shows the installed and newest versions and offers Update', () => {
    const markup = card(view());
    expect(markup).toContain('<section id="update-settings"');
    expect(markup).toContain('UPDATE AVAILABLE');
    expect(markup).toContain('>3.22.0<');
    expect(markup).toContain('href="https://github.com/sanadunt/sdr-doa-ground-control/releases/tag/v3.23.0"');
    expect(markup).toContain(en('update.latestNew', { version: '3.23.0' }));
    expect(markup).toContain(en('update.helperReady'));
    expect(markup).toContain(en('update.none'));
    expect(markup).toMatch(/<button class="ov-button is-primary" type="button" aria-haspopup="dialog" aria-expanded="false">Update<\/button>/);
    expect(markup).not.toContain('role="alertdialog"');
  });

  it('says plainly when GitHub cannot be reached, and Update still works', () => {
    const markup = card(view({ latest: { state: 'error', code: 'OFFLINE', major: 3 }, update_available: false }));
    expect(markup).toContain('OFFLINE');
    expect(markup).toContain(en('update.latestError.OFFLINE'));
    expect(markup).toMatch(/<button class="ov-button" type="button" aria-haspopup="dialog" aria-expanded="false">Update<\/button>/);
    expect(card(view({ latest: { state: 'error', code: 'NO_RELEASE', major: 3 } }))).toContain('No 3.x release on GitHub');
  });

  it('is disabled with the reason until the host helper can update', () => {
    const markup = card(view({ helper: { available: false, reason: 'UPDATE_HELPER_MISSING' } }));
    expect(markup).toContain(en('update.reason.UPDATE_HELPER_MISSING'));
    expect(markup).toMatch(/<button class="ov-button is-primary" type="button" disabled="" aria-haspopup="dialog" aria-expanded="false" title="[^"]*3\.23\.0">Update<\/button>/);
    expect(card(view({ helper: { available: false, reason: 'NOT_DOCKER' } }), undefined, 'id')).toContain(translate('id', 'update.reason.NOT_DOCKER'));
  });

  it('asks first, with Cancel focused and the Receiver warning', () => {
    const markup = card(view(), { stage: 'confirm', busy: 'busy' });
    const box = markup.match(/<div class="cfg-update-confirm" role="alertdialog"[\s\S]*?<\/div><\/div>/)?.[0] ?? '';
    expect(box).toContain(`<h3 id="`);
    expect(box).toContain(en('update.confirmTo', { version: '3.23.0' }));
    expect(box).toContain(en('update.effect'));
    expect(box).toContain(`role="alert">${en('update.busy')}</p>`);
    const buttons = [...box.matchAll(/<button[^>]*>([^<]*)<\/button>/g)];
    expect(buttons.map((match) => match[1])).toEqual([en('power.cancel'), en('update.button')]);
    expect(buttons[0][0]).toContain('autofocus=""');
    expect(buttons[1][0]).not.toContain('disabled');
    // Until the Receiver's state is known, Update waits.
    const checking = card(view(), { stage: 'confirm', busy: 'checking' });
    expect(checking).toContain(en('power.busyChecking'));
    expect(checking).toMatch(/<button class="ov-button is-primary" type="button" disabled="">Update<\/button>/);
    expect(card(view({ latest: { state: 'error', code: 'OFFLINE', major: 3 }, update_available: false }), { stage: 'confirm', busy: 'idle' }))
      .toContain(en('update.offlineNote'));
  });

  it('follows the update and names how it ended', () => {
    const waiting: UpdateStep = { stage: 'waiting', requestedAtMs: NOW, fromVersion: '3.22.0' };
    const running = card(view({ status: { state: 'running', phase: 'pulling', queued_at_ms: NOW, started_at_ms: NOW, stale: false } }), waiting);
    expect(running).toContain('UPDATING');
    expect(running).toContain(en('update.phase.pulling'));
    expect(running).toMatch(/disabled="" aria-haspopup="dialog"/);
    const rolledBack = card(view({ status: { state: 'rolled_back', queued_at_ms: NOW, finished_at_ms: NOW + 60_000, to: '3.23.0', message: 'FAILED: 3.23.0 (abc): unhealthy', stale: false } }), waiting);
    expect(rolledBack).toContain(en('update.result.rolled_back'));
    expect(rolledBack).toContain(en('update.reason', { message: 'FAILED: 3.23.0 (abc): unhealthy' }));
    const reloading = card(view({ installed: '3.23.0', update_available: false }), waiting);
    expect(reloading).toContain(en('update.progress.reloading', { version: '3.23.0' }));
    const notPublished = card(view({ status: { state: 'up_to_date', queued_at_ms: NOW, stale: false } }), waiting);
    expect(notPublished).toContain(en('update.result.notPublished', { version: '3.23.0' }));
  });

  it('names a refused request', () => {
    const markup = card(view(), { stage: 'refused', code: 'HOST_UPDATE_RUNNING', reason: null, message: 'x' });
    expect(markup).toContain(en('update.failed', { error: en('update.error.HOST_UPDATE_RUNNING') }));
  });

  it('styles with console tokens only and stills the spinner for reduced motion', () => {
    const css = readSource('../pages/configuration.css');
    const block = css.slice(css.indexOf('/* Console update card'));
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(block).toMatch(/prefers-reduced-motion: reduce\) \{ \.cfg-update-spinner \{ animation: none/);
  });
});
