import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConsoleShell, loraCause } from '../components/Shell';
import { SystemHealthPage } from '../pages/SystemHealthPage';
import type { LoraLinkView } from '../types';
import { I18nContext, translate } from './i18n';
import type { Lang } from './i18n';
import { loraChip, normalizeLoraLink } from './loraLink';
import { normalizeMqttSnapshot } from './mqttMonitor';

// The `lora` block of /api/mqtt as tools/lora_link.py builds it (tools/test_lora_link.py writes the file).
type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
const VIEWS = JSON.parse(
  process.getBuiltinModule('node:fs').readFileSync(new URL('../../../tools/fixtures/lora-link/views.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

function view(name: string): LoraLinkView {
  const normalized = normalizeLoraLink(VIEWS[name]);
  if (!normalized) throw new Error(`fixture ${name} did not normalize`);
  return normalized;
}

function render(element: ReactElement, lang: Lang = 'en'): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>{element}</I18nContext.Provider>,
  );
}

function shellMarkup(lora: LoraLinkView | undefined, lang: Lang = 'en'): string {
  return render(
    <ConsoleShell route="system-health" onNavigate={() => undefined} branding={{ app_name: 'G', logo_data_url: '' }} snapshot={null} localSnapshotFresh={false} loading={false} readError={null} lastReadAgeMs={null} simulationEnabled={false} onRefresh={() => undefined} mqttConnection="connected" loraLink={lora}>
      <span />
    </ConsoleShell>,
    lang,
  );
}

function loraItem(markup: string): { className: string; value: string; title: string | null } | null {
  const match = markup.match(/<span class="(telemetry-item[^"]*)"( title="([^"]*)")?[^>]*><span class="telemetry-key">Telemetry LoRa<\/span><span class="telemetry-value"><i aria-hidden="true"><\/i>([^<]*)<\/span>/);
  return match ? { className: match[1], title: match[3] ?? null, value: match[4] } : null;
}

describe('LoRa link normalization', () => {
  it('reads every fixture state the server builds', () => {
    expect(view('absent')).toMatchObject({ present: false, ground: null, edge: null });
    expect(view('receiving').ground).toMatchObject({ state: 'UP', data: 'DATA', since_rx_ms: 600, status_age_ms: 200, clock_warning: false });
    expect(view('receiving').ground?.rates).toEqual({ frames: 6, messages: 4, heartbeats: 0.2, crc_errors: 0, lost_frames: 0 });
    expect(view('idle').ground?.data).toBe('LINK_ONLY');
    expect(view('down').ground).toMatchObject({ state: 'DOWN', data: 'NONE' });
    expect(view('stale').ground?.state).toBe('STALE');
    expect(view('port_error').ground).toMatchObject({ state: 'PORT_ERROR', port_error: 'ENOENT' });
    expect(view('clock').ground).toMatchObject({ clock_warning: true, peer: { clock_offset_ms: -2400 } });
  });

  it('drops a malformed block or role', () => {
    expect(normalizeLoraLink(null)).toBeUndefined();
    expect(normalizeLoraLink({ ground: {} })).toBeUndefined();
    expect(normalizeLoraLink({ present: true, ground: { state: 'MAYBE' } })?.ground).toBeNull();
    const odd = normalizeLoraLink({ present: true, ground: { state: 'UP', data: 'x', rates: { frames: 'a' }, rx: { frames: -1 } } });
    expect(odd?.ground).toMatchObject({ data: 'UNKNOWN', rates: null, rx: { frames: null } });
  });

  it('comes through the /api/mqtt adapter', () => {
    expect(normalizeMqttSnapshot({ connection: 'connected', lora: VIEWS.receiving }, 0).lora?.ground?.data).toBe('DATA');
    expect(normalizeMqttSnapshot({ connection: 'connected' }, 0).lora).toBeUndefined();
  });
});

describe('LoRa chip', () => {
  it('maps the bridge state and the data-in indicator', () => {
    expect(loraChip(undefined)).toBeNull();
    expect(loraChip(view('absent'))).toBeNull();
    expect(loraChip(view('receiving'))).toEqual({ value: 'RX', tone: 'good', receiving: true, clockWarning: false });
    expect(loraChip(view('idle'))).toMatchObject({ value: 'IDLE', tone: 'warn', receiving: false });
    expect(loraChip(view('down'))).toMatchObject({ value: 'DOWN', tone: 'bad' });
    expect(loraChip(view('stale'))).toMatchObject({ value: 'STALE', tone: 'bad' });
    expect(loraChip(view('port_error'))).toMatchObject({ value: 'PORT', tone: 'bad' });
    expect(loraChip(view('clock'))).toMatchObject({ value: 'RX', tone: 'warn', clockWarning: true });
  });

  it('shows in the top bar only where a bridge reports, pulsing while data arrives', () => {
    expect(loraItem(shellMarkup(undefined))).toBeNull();
    expect(loraItem(shellMarkup(view('absent')))).toBeNull();
    expect(shellMarkup(view('absent'))).not.toContain('has-lora');
    const receiving = loraItem(shellMarkup(view('receiving')));
    expect(receiving).toMatchObject({ value: 'RX', title: null });
    expect(receiving?.className).toBe('telemetry-item tone-good is-receiving');
    expect(shellMarkup(view('receiving'))).toContain('telemetry-strip has-lora');
    expect(loraItem(shellMarkup(view('down')))?.className).toBe('telemetry-item tone-bad');
  });

  it('names only the current cause in its tooltip, in both languages', () => {
    const t = (lang: Lang) => (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) => translate(lang, key, vars);
    expect(loraCause(t('en'), view('receiving'))).toBeUndefined();
    expect(loraCause(t('en'), view('idle'))).toBe('Heartbeats only, no telemetry');
    expect(loraCause(t('en'), view('down'))).toBe('No Telemetry LoRa frame for 16 s');
    expect(loraCause(t('id'), view('stale'))).toBe('Jembatan Telemetry LoRa diam selama 40 dtk');
    expect(loraCause(t('en'), view('port_error'))).toBe('Telemetry LoRa port: ENOENT');
    expect(loraCause(t('en'), view('clock'))).toContain('RDF-SDR clock off by -2.4 s');
    expect(loraItem(shellMarkup(view('clock'), 'id'))?.title).toContain('SOURCE_TIMESTAMP_NOT_FRESH');
  });
});

describe('System Health LoRa card', () => {
  const page = (lora: LoraLinkView | undefined, lang: Lang = 'en') => render(
    <SystemHealthPage snapshot={null} mqtt={{ connection: 'connected', fetched_at_ms: Date.now(), lora }} localSnapshotFresh={false} />,
    lang,
  );

  it('is absent without a bridge', () => {
    expect(page(undefined)).not.toContain('>Telemetry LoRa<');
    expect(page(view('absent'))).not.toContain('>Telemetry LoRa<');
  });

  it('shows the data-in state, rates, errors and the RDF-SDR side', () => {
    const markup = page(view('receiving'));
    expect(markup).toContain('>Telemetry LoRa<');
    expect(markup).toContain('Receiving');
    expect(markup).toContain('4/s · 6/s');
    expect(markup).toContain('198 frames · 2 lost');
    expect(markup).toContain('-35 ms');
    expect(page(view('receiving'), 'id')).toContain('Data masuk');
  });

  it('warns about a silent bridge, the port and the RDF-SDR clock', () => {
    expect(page(view('stale'))).toContain('Telemetry LoRa bridge silent for');
    expect(page(view('port_error'))).toContain('Telemetry LoRa port: ENOENT');
    expect(page(view('clock'))).toContain('SOURCE_TIMESTAMP_NOT_FRESH');
  });
});
