import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleShell } from './Shell';
import { HostPowerPanel } from './HostPowerControls';
import { I18nContext, translate } from '../lib/i18n';
import type { Lang, Translate } from '../lib/i18n';
import {
  HOST_POWER_CLOSED, HostPowerError, canSend, hostPowerStep, normalizeHostPower, readReceiverBusy, requestHostPower,
} from '../lib/hostPower';
import type { HostPowerCapability, HostPowerEvent, HostPowerStep } from '../lib/hostPower';
import { normalizeCapabilities } from '../api';
import type { ConsoleAccess } from '../lib/access';

const en: Translate = (key, vars) => translate('en', key, vars);
const READY: HostPowerCapability = { available: true, reason: null };

function shell(access: ConsoleAccess, hostPower: HostPowerCapability | null | undefined, lang: Lang = 'en'): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>
      <ConsoleShell
        route="overview" onNavigate={() => undefined} branding={{ app_name: 'G', logo_data_url: '' }} snapshot={null}
        localSnapshotFresh={false} loading={false} readError={null} lastReadAgeMs={null} simulationEnabled={false}
        onRefresh={() => undefined} access={access} hostPower={hostPower}
      >
        <span />
      </ConsoleShell>
    </I18nContext.Provider>,
  );
}

function powerButtons(markup: string): string[] {
  return [...markup.matchAll(/<button[^>]*class="icon-button host-power-button[^"]*"[^>]*>/g)].map((match) => match[0]);
}

function steps(...events: HostPowerEvent[]): HostPowerStep {
  return events.reduce(hostPowerStep, HOST_POWER_CLOSED);
}

function panel(step: Exclude<HostPowerStep, { stage: 'closed' }>, t: Translate = en): string {
  return renderToStaticMarkup(<HostPowerPanel step={step} t={t} onCancel={() => undefined} onSend={() => undefined} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('top bar Restart and Shutdown', () => {
  it('sit right after the language switch on the console\'s own page', () => {
    const markup = shell('local', READY);
    const buttons = powerButtons(markup);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toContain('aria-label="Restart this PC"');
    expect(buttons[1]).toContain('aria-label="Shut down this PC"');
    expect(buttons.join('')).not.toContain('disabled');
    expect(buttons.every((button) => button.includes('aria-haspopup="dialog"'))).toBe(true);
    // After EN|ID, inside the tools.
    const tools = markup.slice(markup.indexOf('class="topbar-tools"'));
    expect(tools.indexOf('class="lang-switch"')).toBeLessThan(tools.indexOf('class="host-power"'));
    expect(tools.indexOf('class="host-power"')).toBeLessThan(tools.indexOf('</header>'));
    expect(markup).toContain('role="group" aria-label="Groundstation PC"');
    // No confirm panel until a click.
    expect(markup).not.toContain('host-power-panel');
  });

  it('are never rendered in the LAN view, whatever the capabilities say', () => {
    for (const hostPower of [READY, null, undefined]) {
      const markup = shell('lan-view', hostPower);
      expect(markup).not.toContain('host-power');
      expect(markup).not.toContain('Restart this PC');
      expect(markup).toContain('VIEW ONLY');
    }
  });

  it('stay disabled with the reason until the host side is installed', () => {
    const missing = powerButtons(shell('local', { available: false, reason: 'DIR_MISSING' }));
    expect(missing).toHaveLength(2);
    for (const button of missing) {
      expect(button).toContain('disabled=""');
      expect(button).toContain(': Host helper not installed"');
    }
    expect(missing[0]).toContain('title="Restart this PC: Host helper not installed"');
    // Before capabilities arrive (null) they wait, disabled.
    expect(powerButtons(shell('local', null)).every((button) => button.includes('disabled=""'))).toBe(true);
    expect(powerButtons(shell('local', undefined)).every((button) => button.includes('disabled=""'))).toBe(true);
    const id = powerButtons(shell('local', { available: false, reason: 'HELPER_MISSING' }, 'id'));
    expect(id[0]).toContain('title="Mulai ulang PC ini: Helper host belum dipasang"');
    expect(id[1]).toContain('title="Matikan PC ini: Helper host belum dipasang"');
  });
});

describe('confirm step', () => {
  it('names the action, puts Cancel first with the focus, and waits for the Receiver\'s state', () => {
    const checking = panel(steps({ type: 'open', action: 'reboot' }) as Exclude<HostPowerStep, { stage: 'closed' }>);
    expect(checking).toContain('<h3 id="host-power-title">Restart this PC?</h3>');
    expect(checking).toContain('Ubuntu restarts now.');
    expect(checking).toContain('Checking the Receiver…');
    const buttons = [...checking.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toContain('autofocus=""');
    expect(buttons[0]).toContain('>Cancel</button>');
    expect(buttons[1]).toContain('disabled=""');
    expect(buttons[1]).toContain('Restart');

    const idle = panel(steps({ type: 'open', action: 'poweroff' }, { type: 'health', busy: 'idle' }) as Exclude<HostPowerStep, { stage: 'closed' }>);
    expect(idle).toContain('Shut down this PC?');
    expect(idle).toContain('The PC stays off until someone presses its power button.');
    expect(idle).not.toContain('role="alert"');
    expect(idle).not.toContain('Checking the Receiver');
    expect(idle.match(/<button[^>]*class="ov-button is-danger is-wide"[^>]*>/)?.[0]).not.toContain('disabled');
  });

  it('warns when /api/health reports receiver_busy', () => {
    const busy = panel(steps({ type: 'open', action: 'reboot' }, { type: 'health', busy: 'busy' }) as Exclude<HostPowerStep, { stage: 'closed' }>);
    expect(busy).toContain('<p class="host-power-warning" role="alert">A Receiver recording or scan is being written; it stops when the PC goes down.</p>');
    const unknown = panel(steps({ type: 'open', action: 'reboot' }, { type: 'health', busy: 'unknown' }) as Exclude<HostPowerStep, { stage: 'closed' }>);
    expect(unknown).toContain('Could not check whether the Receiver is recording.');
    expect(unknown).not.toContain('role="alert"');
    const id = panel(
      steps({ type: 'open', action: 'poweroff' }, { type: 'health', busy: 'busy' }) as Exclude<HostPowerStep, { stage: 'closed' }>,
      (key, vars) => translate('id', key, vars),
    );
    expect(id).toContain('Matikan PC ini?');
    expect(id).toContain('Receiver sedang menulis rekaman atau pindaian');
    expect(id).toContain('>Batal</button>');
  });

  it('shows what happened after the post', () => {
    const sent = panel(steps({ type: 'open', action: 'poweroff' }, { type: 'health', busy: 'idle' }, { type: 'send' }, { type: 'sent' }) as Exclude<HostPowerStep, { stage: 'closed' }>);
    expect(sent).toContain('role="status">Shutdown requested. The PC goes down in a moment.</p>');
    expect(sent).toContain('>Close</button>');
    expect(sent).not.toContain('is-danger');
    const failed = panel(steps(
      { type: 'open', action: 'reboot' }, { type: 'health', busy: 'idle' }, { type: 'send' },
      { type: 'failed', code: 'HOST_POWER_UNAVAILABLE', reason: 'HELPER_MISSING', message: 'raw server text' },
    ) as Exclude<HostPowerStep, { stage: 'closed' }>);
    expect(failed).toContain('Not sent: The host helper is not installed.');
    expect(failed).toContain('<code>HOST_POWER_UNAVAILABLE · HELPER_MISSING</code>');
    const sending = panel(steps({ type: 'open', action: 'reboot' }, { type: 'health', busy: 'idle' }, { type: 'send' }) as Exclude<HostPowerStep, { stage: 'closed' }>);
    expect(sending).toContain('Sending…');
    expect([...sending.matchAll(/<button[^>]*disabled=""/g)]).toHaveLength(2);
  });
});

describe('confirm state', () => {
  it('posts only from the confirm step, after the Receiver\'s state is known', () => {
    const open = steps({ type: 'open', action: 'reboot' });
    expect(open).toEqual({ stage: 'confirm', action: 'reboot', busy: 'checking' });
    expect(canSend(open)).toBe(false);
    expect(hostPowerStep(open, { type: 'send' })).toBe(open);
    const ready = hostPowerStep(open, { type: 'health', busy: 'busy' });
    expect(canSend(ready)).toBe(true);
    expect(hostPowerStep(ready, { type: 'send' })).toEqual({ stage: 'sending', action: 'reboot', busy: 'busy' });
    expect(canSend(HOST_POWER_CLOSED)).toBe(false);
    expect(hostPowerStep(HOST_POWER_CLOSED, { type: 'send' })).toBe(HOST_POWER_CLOSED);
    expect(hostPowerStep(HOST_POWER_CLOSED, { type: 'sent' })).toBe(HOST_POWER_CLOSED);
  });

  it('cancels from every step but sending; another button switches the action', () => {
    const confirm = steps({ type: 'open', action: 'reboot' }, { type: 'health', busy: 'idle' });
    expect(hostPowerStep(confirm, { type: 'cancel' })).toEqual(HOST_POWER_CLOSED);
    expect(hostPowerStep(confirm, { type: 'open', action: 'poweroff' })).toEqual({ stage: 'confirm', action: 'poweroff', busy: 'checking' });
    const sending = hostPowerStep(confirm, { type: 'send' });
    expect(hostPowerStep(sending, { type: 'cancel' })).toBe(sending);
    expect(hostPowerStep(sending, { type: 'open', action: 'poweroff' })).toBe(sending);
    const sent = hostPowerStep(sending, { type: 'sent' });
    expect(hostPowerStep(sent, { type: 'cancel' })).toEqual(HOST_POWER_CLOSED);
    const failed = hostPowerStep(sending, { type: 'failed', code: 'NOT_A_CODE', reason: 'NOPE', message: 'x' });
    expect(failed).toEqual({ stage: 'failed', action: 'reboot', code: null, reason: null, message: 'x' });
  });
});

describe('host power API', () => {
  it('reads the capability strictly', () => {
    expect(normalizeHostPower({ available: true, reason: null, actions: ['reboot', 'poweroff'] })).toEqual({ available: true, reason: null });
    expect(normalizeHostPower({ available: false, reason: 'DIR_NOT_WRITABLE' })).toEqual({ available: false, reason: 'DIR_NOT_WRITABLE' });
    expect(normalizeHostPower({ available: false, reason: 'SOMETHING_NEW' })).toEqual({ available: false, reason: null });
    for (const bad of [null, undefined, 'yes', [], { available: 'true' }]) expect(normalizeHostPower(bad)).toBeNull();
    expect(normalizeCapabilities({ access: 'local', host_power: { available: true } }).hostPower).toEqual(READY);
    expect(normalizeCapabilities({ access: 'lan-view' }).hostPower).toBeNull();
  });

  it('posts the action with confirm and names the server\'s refusal', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const answers = [
      new Response(JSON.stringify({ ok: true, action: 'reboot', requested_at_ms: 1 }), { status: 202 }),
      new Response(JSON.stringify({ ok: false, code: 'HOST_POWER_PENDING', error: 'the host has not taken the previous request yet' }), { status: 409 }),
      new Response('<html>', { status: 502 }),
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return answers.shift() as Response;
    }));
    await expect(requestHostPower('reboot')).resolves.toBeUndefined();
    expect(calls[0].url).toBe('/api/host/power');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.credentials).toBe('same-origin');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ action: 'reboot', confirm: true });
    const pending = await requestHostPower('poweroff').catch((error: unknown) => error);
    expect(pending).toBeInstanceOf(HostPowerError);
    expect((pending as HostPowerError).code).toBe('HOST_POWER_PENDING');
    const gateway = await requestHostPower('poweroff').catch((error: unknown) => error);
    expect((gateway as HostPowerError).code).toBeNull();
    expect((gateway as HostPowerError).message).toBe('HTTP 502');
  });

  it('reads receiver_busy from /api/health', async () => {
    const answers = [
      new Response(JSON.stringify({ ok: true, version: '3.3.0', receiver_busy: true }), { status: 200 }),
      new Response(JSON.stringify({ ok: true, version: '3.3.0', receiver_busy: false }), { status: 200 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe('/api/health');
      return answers.shift() as Response;
    }));
    await expect(readReceiverBusy()).resolves.toBe('busy');
    await expect(readReceiverBusy()).resolves.toBe('idle');
    await expect(readReceiverBusy()).rejects.toThrow('receiver_busy');
  });
});

/** Vitest blanks every CSS import, so the stylesheet is read from disk. */
function readSource(path: string): string {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  return process.getBuiltinModule('node:fs').readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('host power CSS', () => {
  const css = readSource('../console-design.css');
  it('keeps 44 px buttons and token colours', () => {
    const rules = css.split('\n').filter((line) => line.includes('host-power') || line.includes('.ov-button.is-danger'));
    expect(rules.length).toBeGreaterThan(5);
    // The buttons are .icon-button (44 x 44); nothing here shrinks them.
    expect(rules.join('\n')).not.toMatch(/(?:width|height):\s*(?:[0-3]?\d|4[0-3])px/);
    expect(css).toMatch(/\.icon-button \{[^}]*width: 44px; height: 44px;/);
    for (const rule of rules) expect(rule.replace(/rgba\(0, 0, 0, \.35\)/g, '')).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
