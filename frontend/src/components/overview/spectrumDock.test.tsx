import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelemetrySnapshot } from '../../types';
import { I18nContext, translate } from '../../lib/i18n';
import type { Lang } from '../../lib/i18n';
import { createReceiverBridge } from '../../lib/receiverBridge';
import type { BridgeEnvironment, ReceiverBridge } from '../../lib/receiverBridge';
import { BRIDGE_CHANNEL, BRIDGE_VERSION } from '../../lib/receiverBridgeProtocol';
import { DEFAULT_OVERVIEW_PANELS } from '../../lib/overviewPanels';
import { followNodeStore } from '../../lib/listenPrefs';
import { DEFAULT_SPECTRUM_DOCK_SETTINGS, spectrumDockStore } from '../../lib/spectrumDockSettings';
import type { ConsoleCapabilities } from '../../api';
import { SpectrumDock, SpectrumMarkRow, spectrumNeedFromParts } from './SpectrumDock';
import type { SpectrumMarkRowProps } from './SpectrumDock';
import { SpectrumSettings } from './SpectrumSettings';
import type { RadioRows, SpectrumSettingsProps, SweepRows } from './SpectrumSettings';

const ORIGIN = 'http://127.0.0.1:8787';

/** A bridge driven by hand: attach, then feed it frame messages. `tuneResult` answers one console:tune with that tuning. */
function bridgeWith(options: { probe?: number; hello?: boolean; status?: Record<string, unknown> | null; attach?: boolean; tuneResult?: Record<string, unknown>; markers?: Record<string, unknown> } = {}): ReceiverBridge {
  type Listener = (event: { origin: string; source: unknown; data: unknown }) => void;
  const listeners: Listener[] = [];
  const posted: Array<Record<string, unknown>> = [];
  const env: BridgeEnvironment = {
    host: () => ({ location: { origin: ORIGIN }, addEventListener: (_type, listener) => { listeners.push(listener as Listener); }, removeEventListener: () => undefined }),
    setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => undefined,
    probe: () => Promise.resolve(options.probe ?? 200),
    random: () => 0.25,
  };
  const bridge = createReceiverBridge(env);
  const frame = { postMessage: (message: unknown) => { posted.push(message as Record<string, unknown>); } };
  if (options.attach !== false) bridge.attach(frame);
  const send = (type: string, payload: Record<string, unknown>) => {
    for (const listener of listeners) listener({ origin: ORIGIN, source: frame, data: { ch: BRIDGE_CHANNEL, v: BRIDGE_VERSION, type, ...payload } });
  };
  if (options.hello !== false && options.attach !== false) send('receiver:hello', { protocol: 1, mockAvailable: false, webusb: true });
  if (options.status) send('receiver:status', options.status);
  if (options.markers) send('receiver:markers', options.markers);
  if (options.tuneResult) {
    void bridge.send({ type: 'console:tune', centerHz: Number(options.tuneResult.centerHz) });
    send('receiver:result', { id: posted.at(-1)?.id, ok: true, code: 'OK', tune: options.tuneResult });
  }
  return bridge;
}

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 1, tMs: 0, webusb: true, mockAvailable: false, pairedCount: 1, connected: true, mock: false, deviceName: 'RadioSpectrum One',
    running: true, busy: 'none', workspace: 'listener', centerHz: 433_920_000, sampleRateHz: 20_000_000, frequencyShiftHz: 0,
    gains: { lnaDb: 24, vgaDb: 20, amp: false },
    vfo: { index: 0, enabled: false, mode: 'nfm', frequencyHz: 433_925_000, bandwidthHz: 12_500, squelchEnabled: false, squelchDb: -100, volume: 50 },
    squelchOpen: false, audio: 'running', recording: false, error: null, notice: null,
    tune: { rev: 1, by: 'receiver', id: null, receiverRev: 1 },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  followNodeStore.set(true);
  spectrumDockStore.set({ ...DEFAULT_SPECTRUM_DOCK_SETTINGS });
});

/** The scan state a Receiver reports; the Receiver defaults unless overridden. */
function scan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: 'idle', source: 'native', startHz: 100_000_000, stopHz: 1_000_000_000, fftSize: 8192, resolutionHz: 20_000_000 / 8192,
    lnaDb: 40, vgaDb: 20, amp: false, displayMinDb: -60, displayMaxDb: 0, view: 'average', ...overrides,
  };
}

const NODE: TelemetrySnapshot = {
  status: { available: true },
  settings: { available: true, fields: { center_freq: 416.588 } },
  doa_candidates: { csv: { available: true, frequency_hz_normalized: 416_588_000 } },
} as TelemetrySnapshot;

function dock(bridge: ReceiverBridge | undefined, { lang = 'id', snapshot = NODE, capabilities = null }: { lang?: Lang; snapshot?: TelemetrySnapshot | null; capabilities?: ConsoleCapabilities | null } = {}): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>
      <SpectrumDock
        snapshot={snapshot}
        localSnapshotFresh
        capabilities={capabilities}
        panels={DEFAULT_OVERVIEW_PANELS}
        onPanelsChange={() => undefined}
        onControlDraftRequest={() => undefined}
        onRequestReceiver={() => undefined}
        onNavigate={() => undefined}
        receiverBridge={bridge}
      />
    </I18nContext.Provider>,
  );
}

const chip = (markup: string) => /<span class="ov-chip tone-\w+">([^<]*)<\/span>/.exec(markup)?.[1];

describe('Spectrum dock header', () => {
  it('orders title, source, chip, follow, mode, Dengar, Kirim, Mulai, the Receiver link and Atur', () => {
    const markup = dock(bridgeWith({ attach: false }));
    const order = ['Spektrum', 'RadioSpectrum · WebUSB', 'ov-chip', 'Ikuti frekuensi node', 'ov-listen-mode', '>Dengar<', '>Kirim ke RDF-SDR<', '>Mulai<', 'Buka Receiver penuh', '>Atur<'];
    const positions = order.map((needle) => markup.indexOf(needle));
    for (const [index, position] of positions.entries()) expect(position, order[index]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('offers the eight listen modes with NFM selected by default', () => {
    const select = /<select class="ov-listen-mode ov-spec-wide"[\s\S]*?<\/select>/.exec(dock(bridgeWith({ attach: false })))?.[0] ?? '';
    expect(select).toContain('aria-label="Modulasi"');
    expect([...select.matchAll(/<option value="(\w+)"[^>]*>(\w+)<\/option>/g)].map((match) => `${match[1]}:${match[2]}`)).toEqual(['nfm:NFM', 'wfm:WFM', 'am:AM', 'usb:USB', 'lsb:LSB', 'dsb:DSB', 'cw:CW', 'raw:RAW']);
    expect(select).toMatch(/<option value="nfm" selected="">NFM<\/option>/);
  });

  it('keeps follow, mode and Dengar together, and Mulai/Berhenti next to the labelled Receiver link', () => {
    const groups = [...dock(bridgeWith({ attach: false })).matchAll(/<div class="ov-spec-group">([\s\S]*?)<\/div>/g)].map((match) => match[1]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatch(/^<label class="ov-spec-follow ov-spec-wide"[\s\S]*<select class="ov-listen-mode ov-spec-wide"[\s\S]*<button class="ov-button ov-spec-listen"[\s\S]*>Dengar<\/span><\/button>$/);
    expect(groups[1]).toMatch(/^<button class="ov-button ov-spec-run"[\s\S]*<button class="ov-button ov-spec-open"[\s\S]*<\/button>$/);
    expect(groups[1]).toContain('<span class="ov-spec-open-label">Buka Receiver penuh</span><kbd aria-hidden="true">2</kbd>');
  });

  it('ends with a closed Atur toggle and renders no settings column until it opens', () => {
    const markup = dock(bridgeWith({ attach: false }));
    expect(markup).toMatch(/<button class="ov-button ov-spec-settings-toggle" type="button" aria-expanded="false" aria-controls="spectrum-settings"><svg[\s\S]*?<\/svg><span>Atur<\/span><\/button><\/div><div class="ov-spec-main">/);
    expect(markup).not.toContain('id="spectrum-settings"');
    expect(markup).toContain('<section id="panel-spectrum" class="ov-spectrum"');
  });

  it('marks follow, mode and Kirim as the header copies a narrow dock moves into Atur; Dengar, Mulai and the Receiver link stay', () => {
    const markup = dock(bridgeWith({ attach: false }));
    const wide = [...markup.matchAll(/<(\w+) class="([^"]*\bov-spec-wide\b[^"]*)"/g)].map((match) => `${match[1]}.${match[2]}`);
    expect(wide).toEqual(['label.ov-spec-follow ov-spec-wide', 'select.ov-listen-mode ov-spec-wide', 'button.ov-button ov-spec-send ov-spec-wide']);
    for (const kept of ['ov-spec-listen', 'ov-spec-run', 'ov-spec-open', 'ov-spec-settings-toggle']) expect(markup).toMatch(new RegExp(`class="ov-button ${kept}"`));
  });

  it('follows the node by default and keeps the Receiver shortcut', () => {
    const markup = dock(bridgeWith({ attach: false }));
    expect(markup).toMatch(/<input type="checkbox" checked=""\/><span>Ikuti frekuensi node<\/span>/);
    expect(markup).toMatch(/<button class="ov-button ov-spec-open" type="button" aria-keyshortcuts="2" aria-label="Buka Receiver penuh">/);
    expect(markup).toContain('<kbd aria-hidden="true">2</kbd>');
    // Labels only: no explanatory tooltips on the follow switch, the trace or the Receiver link.
    expect(markup).toContain('<label class="ov-spec-follow ov-spec-wide"><input');
    expect(markup).not.toMatch(/class="ov-spec-trace[^"]*"[^>]*title=/);
  });
});

describe('Spectrum dock states', () => {
  it('shows RX OFF and the stopped text before the frame is mounted', () => {
    const markup = dock(bridgeWith({ attach: false }));
    expect(chip(markup)).toBe('RX OFF');
    expect(markup).toContain('<div class="ov-spec-overlay"><span>RX berhenti</span></div>');
    // The axis follows the node until the first frame.
    expect(markup).toContain('Tengah 416.588 MHz · span 2.0 MHz · — MSPS · LNA — dB · VGA — dB');
    expect(markup).toContain('<span>415.588</span>');
    // Never renders the frame or its URL.
    expect(markup).not.toContain('/receiver/');
  });

  it('shows NOT BUILT and disables Mulai and Dengar when the Receiver is missing', async () => {
    const bridge = bridgeWith({ attach: false, probe: 404 });
    bridge.probeBuild();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const markup = dock(bridge);
    expect(chip(markup)).toBe('NOT BUILT');
    expect(markup).toContain('Receiver belum dibangun. Jalankan npm run build:all.');
    expect(markup).toMatch(/<button class="ov-button ov-spec-listen" type="button" aria-pressed="false"[^>]*disabled=""/);
    expect(markup).toMatch(/<button class="ov-button ov-spec-run" type="button" disabled=""/);
  });

  it('shows the connecting state while the frame has not said hello', () => {
    const markup = dock(bridgeWith({ hello: false }));
    expect(chip(markup)).toBe('…');
    expect(markup).toContain('Menghubungkan ke Receiver…');
  });

  it('shows RX, the live centre and gains while running', () => {
    const markup = dock(bridgeWith({ status: status() }), { snapshot: null });
    expect(chip(markup)).toBe('RX');
    expect(markup).toContain('Tengah 433.920 MHz · span 2.0 MHz · 20 MSPS · LNA 24 dB · VGA 20 dB');
    expect(markup).not.toContain('+14 dB');
    expect(markup).toContain('>Berhenti<');
    expect(markup).not.toContain('RX berhenti');
    expect(markup).toMatch(/<button class="ov-button ov-spec-listen" type="button" aria-pressed="false">/);
    expect(markup).toContain('aria-valuetext="433.925 MHz"');
  });

  it('presses Dengar while the VFO is audible', () => {
    const markup = dock(bridgeWith({ status: status({ vfo: { index: 0, enabled: true, mode: 'wfm', frequencyHz: 433_925_000, bandwidthHz: 150_000 } }) }));
    expect(markup).toMatch(/aria-pressed="true" title="Berhenti mendengar"/);
  });

  it('offers Dengar again while the browser holds the audio back', () => {
    const markup = dock(bridgeWith({ status: status({ audio: 'suspended', vfo: { index: 0, enabled: true, mode: 'nfm', frequencyHz: 433_925_000, bandwidthHz: 12_500 } }) }));
    expect(markup).toMatch(/<button class="ov-button ov-spec-listen" type="button" aria-pressed="true">/);
  });

  it('shows the mode the receiver demodulates; the stored preference only until the frame answers', () => {
    const select = (markup: string) => /<select class="ov-listen-mode ov-spec-wide"[\s\S]*?<\/select>/.exec(markup)?.[0] ?? '';
    // AM was set on the Receiver page, which shares the VFO; the stored preference is NFM.
    const live = select(dock(bridgeWith({ status: status({ vfo: { index: 0, enabled: true, mode: 'am', frequencyHz: 433_925_000, bandwidthHz: 10_000 } }) })));
    expect(live).toMatch(/<option value="am" selected="">AM<\/option>/);
    expect(live).not.toContain('selected="">NFM');
    expect(select(dock(bridgeWith({ hello: false })))).toMatch(/<option value="nfm" selected="">NFM<\/option>/);
    // A mode the console does not know falls back to the preference.
    expect(select(dock(bridgeWith({ status: status({ vfo: { index: 0, enabled: false, mode: 'fm', frequencyHz: 433_925_000 } }) })))).toMatch(/<option value="nfm" selected="">NFM<\/option>/);
  });

  it('marks a VFO audio recording armed on the Receiver page with REC', () => {
    expect(dock(bridgeWith({ status: status({ recording: true }) }))).toContain('<span class="ov-tag tone-bad">REC</span>');
    expect(dock(bridgeWith({ status: status() }))).not.toContain('>REC<');
  });

  it('shows the MOCK tag for the Mock SDR and UPCONVERTER for a frequency shift', () => {
    const markup = dock(bridgeWith({ status: status({ mock: true, deviceName: 'Mock SDR', frequencyShiftHz: 125_000_000 }) }));
    expect(markup).toContain('<span class="ov-tag tone-warn">MOCK</span>');
    expect(markup).not.toContain('RadioSpectrum · WebUSB');
    expect(markup).toContain('<span class="ov-tag tone-info" title="Geser frekuensi 125.000 MHz">UPCONVERTER</span>');
  });

  it('shows BUSY with the way to the Receiver page only while the Receiver listens to a scan candidate', () => {
    const markup = dock(bridgeWith({ status: status({ busy: 'scan-listen' }) }));
    expect(chip(markup)).toBe('BUSY');
    expect(markup).toContain('Dengar-pindai berjalan di halaman Receiver');
    expect(markup).toContain('Buka Receiver (2)');
  });

  it('explains a lost RadioSpectrum', () => {
    const markup = dock(bridgeWith({ status: status({ running: false, connected: false, error: { code: 'USB_LOST' } }) }), { lang: 'en' });
    expect(chip(markup)).toBe('RX OFF');
    expect(markup).toContain('RadioSpectrum disconnected');
  });

  it('enables Kirim ke RDF-SDR only for frequencies RDF-SDR accepts', () => {
    const inRange = dock(bridgeWith({ status: status() }));
    expect(inRange).toContain('<button class="ov-button ov-spec-send ov-spec-wide" type="button" title="RX 433.920 MHz · VFO 433.925 MHz">');
    const outOfRange = dock(bridgeWith({ status: status({ centerHz: 2_400_000_000, vfo: null }) }));
    expect(outOfRange).toContain('<button class="ov-button ov-spec-send ov-spec-wide" type="button" disabled="" title="RDF-SDR menerima 24 s/d 1800 MHz">');
  });

  it('holds when there is no fresh node frequency to follow', () => {
    const markup = dock(bridgeWith({ attach: false }), { snapshot: null });
    expect(markup).toContain('<span class="ov-spec-message tone-neutral">Frekuensi node belum segar</span>');
  });

  it('renders without a bridge from App', () => {
    expect(chip(dock(undefined))).toBe('RX OFF');
  });

  it('shows follow-node as the page-wide store holds it', () => {
    followNodeStore.set(false);
    const markup = dock(bridgeWith({ attach: false }));
    expect(markup).toMatch(/<input type="checkbox"\/><span>Ikuti frekuensi node<\/span>/);
    // Not following: the axis no longer shows the node before the frame is mounted.
    expect(markup).not.toContain('Tengah 416.588 MHz');
  });

  it('shows the tuning of a tune result before the next status', () => {
    const markup = dock(bridgeWith({
      status: status(),
      tuneResult: { rev: 2, by: 'console', id: null, receiverRev: 1, centerHz: 145_500_000, vfoHz: 145_510_000 },
    }), { snapshot: null });
    expect(markup).toContain('Tengah 145.500 MHz · span 2.0 MHz');
    expect(markup).toContain('aria-valuetext="145.510 MHz"');
    expect(markup).toContain('title="RX 145.500 MHz · VFO 145.510 MHz"');
  });

  it('shows the Receiver\'s saved centre, read only, before the frame is mounted', () => {
    const saved = JSON.stringify({ radio: { centerFreq: 145.5 }, vfos: [{ freq: 145.51 }], activeVfoIndex: 0 });
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => (key === 'SDRSetting' ? saved : null), setItem: () => undefined } });
    // Without a fresh node frequency to follow, the saved centre is what Mulai would use.
    const markup = dock(bridgeWith({ attach: false }), { snapshot: null });
    expect(markup).toContain('Tengah 145.500 MHz · span 2.0 MHz');
    expect(markup).toContain('aria-valuetext="145.510 MHz"');
    // It is shown, not sent: Kirim ke RDF-SDR still has no frequency.
    expect(markup).toMatch(/<button class="ov-button ov-spec-send ov-spec-wide" type="button" disabled=""/);
    // Following the node, the node still wins.
    expect(dock(bridgeWith({ attach: false }))).toContain('Tengah 416.588 MHz');
  });
});

describe('Spectrum dock Spektrum mode', () => {
  const modeSwitch = (markup: string) => /<div class="ov-seg ov-seg-compact ov-spec-mode" role="group" aria-label="Mode spektrum">([\s\S]*?)<\/div>/.exec(markup)?.[1] ?? '';
  const pressed = (markup: string) => [...modeSwitch(markup).matchAll(/aria-pressed="true"[^>]*>([^<]+)</g)].map((match) => match[1]);

  it('puts the RX|Spektrum switch right after the chip, then Penanda, before follow-node', () => {
    const markup = dock(bridgeWith({ attach: false }));
    const order = ['class="ov-chip', 'ov-spec-mode', '>RX<', '>Spektrum<', 'ov-spec-mark', '>Penanda<', 'Ikuti frekuensi node'];
    const positions = order.map((needle) => markup.indexOf(needle, markup.indexOf('class="ov-chip')));
    for (const [index, position] of positions.entries()) expect(position, order[index]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(pressed(markup)).toEqual(['RX']);
    expect(dock(bridgeWith({ attach: false }), { lang: 'en' })).toMatch(/aria-label="Spectrum mode">[\s\S]*?>RX<\/button>[\s\S]*?>Spectrum<\/button>/);
  });

  it('follows the stored choice while nothing runs', () => {
    spectrumDockStore.set({ ...DEFAULT_SPECTRUM_DOCK_SETTINGS, mode: 'sweep' });
    const markup = dock(bridgeWith({ attach: false }));
    expect(pressed(markup)).toEqual(['Spektrum']);
    expect(chip(markup)).toBe('SCAN OFF');
    expect(markup).toContain('<div class="ov-spec-overlay"><span>Pindai berhenti</span></div>');
    expect(markup).toContain('>Mulai<');
    // RX running wins.
    expect(pressed(dock(bridgeWith({ status: status() })))).toEqual(['RX']);
  });

  it('shows a scan started on the Receiver page as Spektrum with live frames and no stopped overlay', () => {
    const markup = dock(bridgeWith({ status: status({ running: false, busy: 'sweep', sweep: scan({ phase: 'active', lnaDb: 32, vgaDb: 16, amp: true, fftSize: 4096, resolutionHz: 4882.8125 }) }) }));
    expect(pressed(markup)).toEqual(['Spektrum']);
    expect(chip(markup)).toBe('SCAN');
    expect(markup).not.toContain('ov-spec-overlay');
    expect(markup).not.toContain('is-stopped');
    expect(markup).toContain('>Berhenti<');
    expect(markup).toContain('100–1000 MHz · RBW 4.88 kHz · LNA 32 dB · VGA 16 dB · +14 dB');
    expect(markup).toContain('<span>100</span><span>325</span><span>550</span><span>775</span><span>1000</span>');
    expect(markup).toContain('aria-label="Pindai lebar. Klik, atau pakai tombol panah, untuk mengatur tengah RX dan VFO bagi RX berikutnya."');
    // Not simulated: no SIM tag.
    expect(markup).not.toContain('>SIM<');
    // Dengar stays offered: it stops the scan and starts RX.
    expect(markup).toMatch(/<button class="ov-button ov-spec-listen" type="button" aria-pressed="false">/);
  });

  it('tags the simulated scan SIM only while it starts or runs', () => {
    const sim = (phase: string, busy: string) => dock(bridgeWith({ status: status({ running: false, busy, sweep: scan({ phase, source: 'simulated' }) }) }));
    expect(sim('active', 'sweep')).toContain('<span class="ov-tag tone-warn">SIM</span>');
    expect(sim('starting', 'sweep')).toContain('>SIM<');
    expect(sim('stopping', 'sweep')).not.toContain('>SIM<');
    // The scan source stays 'simulated' until a radio that can scan connects; idle, that is no simulation.
    spectrumDockStore.set({ ...DEFAULT_SPECTRUM_DOCK_SETTINGS, mode: 'sweep' });
    expect(sim('idle', 'none')).not.toContain('>SIM<');
  });

  it('shows … while a scan starts or stops, and keeps Berhenti for a starting scan', () => {
    const starting = dock(bridgeWith({ status: status({ running: true, busy: 'sweep', sweep: scan({ phase: 'starting' }) }) }));
    expect(chip(starting)).toBe('…');
    expect(starting).toContain('Memulai pindai…');
    expect(starting).toMatch(/<button class="ov-button ov-spec-run" type="button">[\s\S]*?>Berhenti</);
    const stopping = dock(bridgeWith({ status: status({ running: false, busy: 'sweep', sweep: scan({ phase: 'stopping' }) }) }));
    expect(stopping).toContain('Menghentikan pindai…');
    expect(stopping).toMatch(/<button class="ov-button ov-spec-run" type="button" disabled=""/);
    expect(modeSwitch(stopping)).toMatch(/disabled=""/);
  });

  it('draws the Receiver\'s saved scan range before the frame is mounted', () => {
    spectrumDockStore.set({ ...DEFAULT_SPECTRUM_DOCK_SETTINGS, mode: 'sweep' });
    const sweepSettings = JSON.stringify({ startMHz: 430, endMHz: 440, fftSize: 8192, lnaGain: 24, vgaGain: 30, ampEnabled: false });
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => (key === 'ReceiverSweepSettings' ? sweepSettings : null), setItem: () => undefined } });
    const markup = dock(bridgeWith({ attach: false }));
    expect(markup).toContain('430–440 MHz · RBW 2.44 kHz · LNA 24 dB · VGA 30 dB');
    expect(markup).toContain('<span>430.0</span><span>432.5</span><span>435.0</span><span>437.5</span><span>440.0</span>');
  });
});

/** Vitest blanks every CSS import, so the stylesheet is read from disk. */
function readStylesheet(path: string): string {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  return process.getBuiltinModule('node:fs').readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('Spectrum dock styles', () => {
  const dashboardCss = readStylesheet('../../overview-dashboard.css');
  const declarations = (selector: string) => [...dashboardCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].split(',').some((part) => part.trim().endsWith(selector)))
    .map((match) => match[2]);

  it('never hides the Receiver label', () => {
    expect(declarations('.ov-spec-open-label').length).toBeGreaterThan(0);
    expect(declarations('.ov-spec-open-label').join(';')).not.toMatch(/display:\s*none/);
  });

  it('keeps the inline Receiver button at the 44 px touch target', () => {
    expect(declarations('.ov-spec-inline-button').length).toBeGreaterThan(0);
    const heights = declarations('.ov-spec-inline-button').join(';').match(/(?:^|[;\s])(?:min-)?height:\s*(\d+)px/g) ?? [];
    for (const height of heights) expect(Number(/(\d+)px/.exec(height)?.[1]), height).toBeGreaterThanOrEqual(44);
  });

  it('grows the dock to the height the spectrum needs', () => {
    expect(dashboardCss).toMatch(/--ov-dock-h:\s*max\(256px,\s*var\(--ov-spec-need-h,\s*0px\)\)/);
  });

  it('counts the open Atur column beside the trace only when taller, and below it in full', () => {
    // Header 48, body 180, column 311, dock border 1.
    expect(spectrumNeedFromParts(48, 180, 311, false, 1)).toBe(360);
    expect(spectrumNeedFromParts(48, 180, 120, false, 1)).toBe(229);
    expect(spectrumNeedFromParts(48, 180, 194, true, 1)).toBe(423);
    expect(spectrumNeedFromParts(48.2, 180.1, 0, true, 0)).toBe(229);
  });

  /** The body of an at-rule block such as `@container ov-spec (max-width: 1279px)`. */
  const block = (prelude: string): string => {
    const start = dashboardCss.indexOf(`${prelude} {`);
    if (start < 0) return '';
    let depth = 0;
    for (let index = dashboardCss.indexOf('{', start); index < dashboardCss.length; index++) {
      if (dashboardCss[index] === '{') depth++;
      if (dashboardCss[index] === '}' && --depth === 0) return dashboardCss.slice(dashboardCss.indexOf('{', start) + 1, index);
    }
    return '';
  };

  it('moves follow, mode and Kirim into Atur below a 1400 px dock and hides the source text below 1500 px', () => {
    expect(declarations('.ov-spec-settings > .ov-spec-narrow').join(';')).toMatch(/display:\s*none/);
    const narrow = block('@container ov-spec (max-width: 1399px)');
    expect(narrow).toMatch(/\.ov-spec-head \.ov-spec-wide\s*\{\s*display:\s*none;?\s*\}/);
    expect(narrow).toMatch(/\.ov-spec-settings > \.ov-spec-narrow\s*\{\s*display:\s*flex;?\s*\}/);
    expect(block('@container ov-spec (max-width: 1499px)')).toMatch(/\.ov-spec-source\s*\{\s*display:\s*none;?\s*\}/);
  });

  it('puts Atur beside the trace, below it on a dock of 760 px or less, and below it when stacked', () => {
    expect(declarations('.ov-spec-settings').join(';')).toMatch(/width:\s*337px/);
    const narrow = block('@container ov-spec (max-width: 760px)');
    // Below the trace, never over it: nothing in the column covers the marker row's buttons.
    expect(narrow).not.toMatch(/position:\s*absolute/);
    expect(narrow).toMatch(/\.ov-spec-main\s*\{[^}]*flex-direction:\s*column[^}]*overflow-y:\s*auto/);
    expect(narrow).toMatch(/\.ov-spec-settings\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(313px,\s*100%\),\s*1fr\)\)[^}]*width:\s*auto[^}]*overflow:\s*visible/);
    // Scrolled under the header when the stage is too short, the trace keeps its waterfall.
    expect(narrow).toMatch(/\.ov-spec-main > \.ov-spec-body\s*\{\s*flex:\s*1 0 auto;?\s*\}/);
    expect(narrow).toMatch(/\.ov-spec-main \.ov-spec-waterfall\s*\{\s*min-height:\s*48px;?\s*\}/);
    const stacked = block('@media (max-width: 1023px)');
    expect(stacked).toMatch(/\.ov-spec-main\s*\{\s*flex-direction:\s*column;?\s*\}/);
    expect(stacked).toMatch(/\.ov-spec-settings\s*\{[^}]*position:\s*static[^}]*width:\s*auto/);
    // The stacked rule comes after the container rule, so it wins on a phone.
    expect(dashboardCss.indexOf('@media (max-width: 1023px)')).toBeGreaterThan(dashboardCss.indexOf('@container ov-spec (max-width: 760px)'));
  });

  it('keeps the settings controls at 44 px and uses console tokens only', () => {
    for (const selector of ['.ov-seg', '.ov-db-input', '.ov-ps-controls', '.ov-listen-mode', '.ov-radio-select', '.ov-button']) {
      expect(declarations(selector).join(';'), selector).toMatch(/(?:^|[;\s])height:\s*44px/);
    }
    const spectrumRules = [...dashboardCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((match) => /\.ov-spec-(?:settings|main|narrow|wide|mode|mark|amp)|\.ov-radio-select/.test(match[1]));
    expect(spectrumRules.length).toBeGreaterThan(4);
    for (const rule of spectrumRules) expect(rule[2], rule[1]).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});

/** The radio rows before the Receiver frame answers. */
const RADIO_UNKNOWN: RadioRows = {
  ready: false, sampleRateHz: null, sampleRates: [], rateDisabled: true, ratePending: false, lnaDb: null, vgaDb: null, amp: null, gainsDisabled: true,
};

/** The scan rows before the Receiver frame answers: its saved defaults, disabled. */
const SWEEP_SAVED: SweepRows = {
  ready: false, scanning: false, disabled: true, startHz: 100_000_000, stopHz: 1_000_000_000, fftSize: 8192, lnaDb: 40, vgaDb: 20, amp: false, shiftHz: 0,
};

function settings(overrides: Partial<SpectrumSettingsProps> = {}, lang: Lang = 'id'): string {
  const props: SpectrumSettingsProps = {
    dockMode: 'rx',
    followNode: true,
    onFollowNode: () => undefined,
    mode: 'am',
    onModeChange: () => undefined,
    sendable: true,
    sendTitle: 'RX 433.920 MHz · VFO 433.925 MHz',
    onSend: () => undefined,
    db: { auto: true, minDb: -70, maxDb: 0 },
    dbEditable: true,
    autoRange: { min: -95, max: -40 },
    onDbAuto: () => undefined,
    onDbManual: () => undefined,
    onDbRange: () => undefined,
    radio: RADIO_UNKNOWN,
    onSampleRate: () => undefined,
    onGain: () => undefined,
    onAmp: () => undefined,
    sweep: SWEEP_SAVED,
    onSweepRange: () => undefined,
    onSweepCenter: () => undefined,
    onSweepFft: () => undefined,
    onSweepGain: () => undefined,
    onSweepAmp: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>
      <SpectrumSettings {...props} />
    </I18nContext.Provider>,
  );
}

describe('Spectrum dock Atur column', () => {
  it('is the region the toggle controls, with the narrow-dock copies of follow, mode and Kirim first', () => {
    const markup = settings();
    expect(markup).toMatch(/^<div id="spectrum-settings" class="ov-spec-settings" role="group" aria-label="Pengaturan spektrum">/);
    const narrow = [...markup.matchAll(/<div class="ov-ps-row ov-spec-narrow">([\s\S]*?)<\/div><\/div>/g)].map((match) => match[1]);
    expect(narrow).toHaveLength(2);
    expect(narrow[0]).toMatch(/<label class="ov-spec-follow"><input type="checkbox" checked=""\/><span>Ikuti frekuensi node<\/span><\/label><select class="ov-listen-mode" aria-label="Modulasi"/);
    expect(narrow[0]).toMatch(/<option value="am" selected="">AM<\/option>/);
    expect(narrow[1]).toMatch(/<button class="ov-button ov-spec-send is-wide" type="button" title="RX 433.920 MHz · VFO 433.925 MHz">/);
    expect(settings({ sendable: false, sendTitle: 'x' })).toMatch(/<button class="ov-button ov-spec-send is-wide" type="button" disabled=""/);
  });

  it('shows Auto with the range drawn now in disabled fields', () => {
    const markup = settings();
    expect(markup).toContain('<span id="ov-spec-db-label">Skala dB</span><span>Auto · −95 s/d −40</span>');
    expect(markup).toMatch(/<div class="ov-seg ov-w-106" role="group" aria-labelledby="ov-spec-db-label"><button type="button" aria-pressed="true">Auto<\/button><button type="button" aria-pressed="false">Manual<\/button><\/div>/);
    expect(markup).toMatch(/<input class="ov-db-input" type="text" inputMode="text" autoComplete="off" spellCheck="false" aria-label="Min dB" disabled="" value="-95"\/>/);
    expect(markup).toMatch(/aria-label="Maks dB" disabled="" value="-40"\/>/);
    // Before the first frame there is no range to show.
    expect(settings({ autoRange: null }, 'en')).toContain('<span>Auto · — to —</span>');
  });

  it('shows Manual with the shared range in editable fields', () => {
    const markup = settings({ db: { auto: false, minDb: -90, maxDb: -20 } }, 'en');
    expect(markup).toContain('<span id="ov-spec-db-label">dB scale</span><span class="is-manual">Manual · −90.0 to −20.0</span>');
    expect(markup).toMatch(/<button type="button" aria-pressed="false">Auto<\/button><button type="button" aria-pressed="true">Manual<\/button>/);
    expect(markup).toMatch(/aria-label="Min dB" value="-90"\/>/);
    expect(markup).toMatch(/aria-label="Max dB" value="-20"\/>/);
    const dbRow = markup.slice(markup.indexOf('id="ov-spec-db-label"'), markup.indexOf('id="ov-spec-rate-label"'));
    expect(dbRow).toContain('Manual');
    expect(dbRow).not.toContain('disabled=""');
  });
});

describe('Spectrum dock Atur radio rows', () => {
  const ready: RadioRows = {
    ready: true, sampleRateHz: 20_000_000, sampleRates: [2e6, 4e6, 5e6, 8e6, 10e6, 16e6, 20e6], rateDisabled: false, ratePending: false,
    lnaDb: 24, vgaDb: 20, amp: false, gainsDisabled: false,
  };
  const row = (markup: string, labelId: string) => {
    const start = markup.indexOf(`id="${labelId}"`);
    const end = markup.indexOf('<div class="ov-ps-row', start);
    return markup.slice(start, end < 0 ? undefined : end);
  };
  const selects = (markup: string) => [...markup.matchAll(/<select[^>]*>([\s\S]*?)<\/select>/g)];

  it('follows the dB scale with the sample rate and the gain rows', () => {
    const markup = settings({ radio: ready });
    const order = ['id="ov-spec-db-label"', 'id="ov-spec-rate-label"', 'id="ov-spec-gain-label"'];
    const positions = order.map((needle) => markup.indexOf(needle));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('shows the Receiver\'s rate and gains in enabled selects', () => {
    const markup = settings({ radio: ready }, 'en');
    const rate = row(markup, 'ov-spec-rate-label');
    expect(rate).toContain('>Sample rate</span>');
    expect(rate).toMatch(/<select class="ov-radio-select" aria-labelledby="ov-spec-rate-label">/);
    expect([...rate.matchAll(/<option value="(\d+)"[^>]*>([^<]*)<\/option>/g)].map((match) => match[2])).toEqual(['2 MSPS', '4 MSPS', '5 MSPS', '8 MSPS', '10 MSPS', '16 MSPS', '20 MSPS']);
    expect(rate).toMatch(/<option value="20000000" selected="">20 MSPS<\/option>/);
    const gain = row(markup, 'ov-spec-gain-label');
    expect(gain).toMatch(/<div class="ov-ps-controls" role="group" aria-labelledby="ov-spec-gain-label">/);
    const [lna, vga] = selects(gain);
    expect(lna[0]).toMatch(/aria-label="LNA gain"/);
    expect([...lna[1].matchAll(/>(LNA \d+ dB)</g)].map((match) => match[1])).toEqual(['LNA 0 dB', 'LNA 8 dB', 'LNA 16 dB', 'LNA 24 dB', 'LNA 32 dB', 'LNA 40 dB']);
    expect(lna[1]).toMatch(/<option value="24" selected="">LNA 24 dB<\/option>/);
    expect(vga[0]).toMatch(/aria-label="VGA gain"/);
    expect(vga[1].match(/<option /g)).toHaveLength(32);
    expect(vga[1]).toMatch(/<option value="20" selected="">VGA 20 dB<\/option>/);
    expect(gain).toMatch(/<button class="ov-button ov-spec-amp" type="button" aria-pressed="false" aria-label="RF amp \+14 dB">\+14 dB<\/button>/);
    expect(row(markup, 'ov-spec-rate-label') + gain).not.toContain('disabled=""');
    expect(settings({ radio: { ...ready, amp: true } }, 'id')).toMatch(/aria-pressed="true" aria-label="Penguat RF \+14 dB">\+14 dB</);
  });

  it('shows — in disabled controls while the Receiver frame does not answer', () => {
    const markup = settings();
    const rate = row(markup, 'ov-spec-rate-label');
    expect(rate).toMatch(/<select class="ov-radio-select" aria-labelledby="ov-spec-rate-label" disabled=""><option value="" selected="">—<\/option><\/select>/);
    const gain = row(markup, 'ov-spec-gain-label');
    for (const [select] of selects(gain)) expect(select).toMatch(/disabled=""><option value="" selected="">—<\/option><\/select>$/);
    expect(gain).toMatch(/<button class="ov-button ov-spec-amp" type="button" aria-pressed="false" aria-label="Penguat RF \+14 dB" disabled="">/);
  });

  it('marks a rate change on its way and keeps an unknown gain selectable', () => {
    const pending = settings({ radio: { ...ready, ratePending: true } });
    expect(row(pending, 'ov-spec-rate-label')).toMatch(/^id="ov-spec-rate-label">Sample rate<\/span><span>…<\/span>/);
    // Locked but focusable: a keyboard pick keeps its focus while RX restarts.
    expect(row(pending, 'ov-spec-rate-label')).toMatch(/<select class="ov-radio-select" aria-labelledby="ov-spec-rate-label" aria-disabled="true">/);
    expect(row(pending, 'ov-spec-rate-label')).not.toContain('disabled=""');
    expect(row(settings({ radio: { ...ready, rateDisabled: true } }), 'ov-spec-rate-label')).toMatch(/aria-labelledby="ov-spec-rate-label" disabled="">/);
    const unknown = row(settings({ radio: { ...ready, lnaDb: null, amp: null } }), 'ov-spec-gain-label');
    const [lna] = selects(unknown);
    expect(lna[0]).not.toContain('disabled=""');
    expect(lna[1]).toMatch(/^<option value="" selected="">—<\/option><option value="0">LNA 0 dB<\/option>/);
    expect(unknown).toMatch(/aria-pressed="false" aria-label="Penguat RF \+14 dB" disabled="">/);
    // An off-step value from another device stays shown.
    expect(row(settings({ radio: { ...ready, lnaDb: 14 } }), 'ov-spec-gain-label')).toMatch(/<option value="14" selected="">LNA 14 dB<\/option><option value="0">/);
  });

  it('adds the rate and the +14 dB amp to the dock info line', () => {
    expect(dock(bridgeWith({ status: status({ sampleRateHz: 8_000_000, gains: { lnaDb: 32, vgaDb: 16, amp: true } }) }), { snapshot: null, lang: 'en' }))
      .toContain('Center 433.920 MHz · span 2.0 MHz · 8 MSPS · LNA 32 dB · VGA 16 dB · +14 dB');
  });
});

describe('Spectrum dock Atur scan rows', () => {
  const scanning: SweepRows = { ...SWEEP_SAVED, ready: true, scanning: true, disabled: true, startHz: 430_000_000, stopHz: 440_000_000, lnaDb: 32, vgaDb: 16, amp: true };
  const ready: SweepRows = { ...scanning, scanning: false, disabled: false };

  it('shows the scan dB scale, range, resolution and gains in Spektrum mode instead of the RX rows', () => {
    const markup = settings({ dockMode: 'sweep', sweep: ready, db: { auto: false, minDb: -110, maxDb: -20 } });
    const order = ['Skala dB', 'Rentang', 'Resolusi', 'ov-spec-sgain-label'];
    const positions = order.map((needle) => markup.indexOf(needle));
    for (const [index, position] of positions.entries()) expect(position, order[index]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(markup).not.toContain('Sample rate');
    expect(markup).toContain('aria-label="Awal MHz"');
    expect(markup).toMatch(/aria-label="Awal MHz"[^>]*value="430"/);
    expect(markup).toMatch(/aria-label="Akhir MHz"[^>]*value="440"/);
    expect(markup).toContain('<button class="ov-icon-button is-bordered" type="button" aria-label="Pusatkan ke RX" title="Pusatkan ke RX">');
    expect(markup).toMatch(/<button type="button" aria-pressed="false">4\.88 kHz<\/button><button type="button" aria-pressed="true">2\.44 kHz<\/button>/);
    expect(markup).toMatch(/<option value="32" selected="">LNA 32 dB<\/option>/);
    expect(markup).toMatch(/<option value="16" selected="">VGA 16 dB<\/option>/);
    expect(markup).toMatch(/<button class="ov-button ov-spec-amp" type="button" aria-pressed="true" aria-label="Penguat RF \+14 dB">/);
    // Manual is the Receiver's Graph min./max., editable while the frame answers.
    expect(markup).toMatch(/aria-label="Min dB"[^>]*value="-110"/);
    expect(markup).not.toMatch(/aria-label="Min dB" disabled/);
    expect(markup).not.toContain('Terkunci');
  });

  it('keeps the RX rows in RX mode', () => {
    const markup = settings({ sweep: ready });
    expect(markup).toContain('Sample rate');
    expect(markup).not.toContain('Rentang');
  });

  it('locks the scan settings while a scan runs, as the Receiver page does', () => {
    const markup = settings({ dockMode: 'sweep', sweep: scanning });
    expect(markup).toContain('<span class="is-warn">Terkunci selama pindai</span>');
    expect(markup).toMatch(/aria-label="Awal MHz" disabled=""/);
    expect(markup).toMatch(/aria-label="Pusatkan ke RX" title="Pusatkan ke RX" disabled=""/);
    expect(markup).toMatch(/<select class="ov-radio-select" aria-label="Gain LNA" disabled=""/);
    expect(markup).toMatch(/<button type="button" aria-pressed="true" disabled="">2\.44 kHz/);
    // The graph range is display only: it stays editable during the scan.
    expect(settings({ dockMode: 'sweep', sweep: scanning, db: { auto: false, minDb: -110, maxDb: -20 } })).not.toMatch(/aria-label="Min dB" disabled/);
  });

  it('shows the saved scan settings disabled before the frame answers, the graph limits read only', () => {
    const markup = settings({ dockMode: 'sweep', sweep: SWEEP_SAVED, dbEditable: false, db: { auto: false, minDb: -60, maxDb: 0 } });
    expect(markup).toMatch(/aria-label="Awal MHz" disabled=""[^>]*value="100"/);
    expect(markup).toMatch(/<option value="40" selected="">LNA 40 dB<\/option>/);
    expect(markup).toMatch(/aria-label="Min dB" disabled=""/);
    expect(markup).not.toContain('Terkunci');
  });

  it('does not offer a resolution the range does not fit', () => {
    const wide = settings({ dockMode: 'sweep', sweep: { ...ready, startHz: 100_000_000, stopHz: 2_000_000_000, fftSize: 4096 } });
    expect(wide).toMatch(/<button type="button" aria-pressed="true">4\.88 kHz<\/button><button type="button" aria-pressed="false" disabled="">2\.44 kHz<\/button>/);
  });

  it('shows the range in displayed MHz and the limits of an upconverter', () => {
    const markup = settings({ dockMode: 'sweep', sweep: { ...ready, startHz: -25_000_000, stopHz: 875_000_000, shiftHz: -125_000_000 } }, 'en');
    expect(markup).toMatch(/aria-label="Start MHz"[^>]*value="-25"/);
    expect(markup).toContain('Range');
    expect(markup).toContain('Resolution');
  });
});

describe('Spectrum dock markers', () => {
  const MARKERS = {
    rev: 2, setId: null, setName: null, frequencyShiftHz: 0, total: 3, truncated: false,
    markers: [
      { id: 'm-1', frequencyHz: 433_500_000, powerDb: null, label: 'Marker 1' },
      { id: 'm-2', frequencyHz: 434_000_000, powerDb: -48.25, label: 'Tower' },
      { id: 'm-3', frequencyHz: 900_000_000, powerDb: null, label: 'Far' },
    ],
  };
  const toggle = (markup: string) => /<button class="ov-button ov-spec-mark"[^>]*>[\s\S]*?<\/button>/.exec(markup)?.[0] ?? '';

  it('offers Penanda off and disabled until the Receiver frame answers', () => {
    const button = toggle(dock(bridgeWith({ attach: false })));
    expect(button).toMatch(/^<button class="ov-button ov-spec-mark" type="button" aria-pressed="false" disabled="">/);
    expect(button).toContain('<span class="ov-spec-mark-label">Penanda</span>');
    expect(button).not.toContain('ov-spec-mark-count');
    expect(toggle(dock(bridgeWith({ attach: false }), { lang: 'en' }))).toContain('>Markers<');
  });

  it('enables Penanda with the number of markers in the Receiver list, still off at mount', () => {
    const button = toggle(dock(bridgeWith({ status: status(), markers: MARKERS })));
    expect(button).toMatch(/^<button class="ov-button ov-spec-mark" type="button" aria-pressed="false">/);
    expect(button).toContain('<span class="ov-spec-mark-count">3</span>');
    // Marking is not on, so the notice line has no marking row and the canvas keeps its tune label.
    const markup = dock(bridgeWith({ status: status(), markers: MARKERS }));
    expect(markup).not.toContain('ov-spec-mark-row');
    expect(markup).not.toContain('is-marking');
    expect(markup).toContain('aria-label="Spektrum di sekitar tengah RX.');
    // An empty list shows no count.
    expect(toggle(dock(bridgeWith({ status: status(), markers: { ...MARKERS, total: 0, markers: [] } })))).not.toContain('ov-spec-mark-count');
  });

  function markRow(overrides: Partial<SpectrumMarkRowProps> = {}, lang: Lang = 'id'): string {
    const props: SpectrumMarkRowProps = { marker: null, unsaved: false, notice: null, onRemove: () => undefined, onTune: () => undefined, ...overrides };
    return renderToStaticMarkup(
      <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>
        <SpectrumMarkRow {...props} />
      </I18nContext.Provider>,
    );
  }

  it('shows the picked marker with Hapus and Tala ke sini, and Belum disimpan without a marker set', () => {
    const markup = markRow({ marker: MARKERS.markers[1], unsaved: true });
    expect(markup).toBe(
      '<span class="ov-spec-mark-row"><span class="ov-spec-mark-readout">Tower · 434.000 MHz · −48.3 dB</span>'
      + '<button class="ov-button ov-spec-inline-button" type="button">Hapus</button>'
      + '<button class="ov-button ov-spec-inline-button" type="button">Tala ke sini</button>'
      + '<span class="ov-tag tone-warn">Belum disimpan</span></span>',
    );
    const english = markRow({ marker: MARKERS.markers[0], unsaved: false }, 'en');
    expect(english).toContain('>Marker 1 · 433.500 MHz</span>');
    expect(english).toContain('>Remove<');
    expect(english).toContain('>Tune here<');
    expect(english).not.toContain('Not saved');
  });

  it('offers no Remove for a marker the console cannot address, and no tuning above 6 GHz', () => {
    expect(markRow({ marker: { id: null, frequencyHz: 433_500_000, powerDb: null, label: 'M4' } })).not.toContain('>Hapus<');
    expect(markRow({ marker: { id: 'h', frequencyHz: 6_500_000_000, powerDb: null, label: 'High' } })).toContain('<button class="ov-button ov-spec-inline-button" type="button" disabled="">Tala ke sini</button>');
  });

  it('names a refused marker command, with the Receiver text for a failed save', () => {
    expect(markRow({ notice: { code: 'MARKER_LIMIT' } })).toContain('<span class="ov-spec-message tone-warn">Batas penanda tercapai</span>');
    expect(markRow({ notice: { code: 'OUT_OF_RANGE' } }, 'en')).toContain('>Outside the marker range<');
    expect(markRow({ notice: { code: 'MARKER_SAVE_FAILED', message: 'Could not save marker set: disk full' } })).toContain('>Penanda tidak tersimpan ke set (Could not save marker set: disk full)<');
    expect(markRow({ notice: { code: 'MARKER_NOT_FOUND' } }, 'en')).toContain('>Marker no longer exists<');
  });

  it('styles Penanda and the markers with the console marker token, at the 44 px target', () => {
    const dashboardCss = readStylesheet('../../overview-dashboard.css');
    const designCss = readStylesheet('../../console-design.css');
    expect(/:root \{[^}]*--marker:\s*#ff75a0;/.exec(designCss)).not.toBeNull();
    expect(/:root\[data-theme='light'\] \{[^}]*--marker:\s*#a23557;/.exec(designCss)).not.toBeNull();
    expect(dashboardCss).toMatch(/\.ov-button\.ov-spec-mark\[aria-pressed='true'\] \{[^}]*border-color:\s*var\(--marker\)/);
    expect(dashboardCss).toMatch(/\.ov-spec-trace\.is-marking, \.ov-spec-waterfall\.is-marking, \.ov-spec-trace\.is-marking \.ov-spec-overlay \{\s*cursor:\s*copy;?\s*\}/);
    // The toggle is an .ov-button, 44 px high, and nothing in its own rules sets another height.
    const markRules = [...dashboardCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((match) => /\.ov-spec-mark(?![-\w])/.test(match[1]));
    expect(markRules.length).toBeGreaterThan(2);
    for (const rule of markRules) expect(rule[2], rule[1]).not.toMatch(/(?:^|[;\s])(?:min-)?height:/);
  });

  it('keeps the Penanda label as the button name where a mid-width dock shows only the icon and the count', () => {
    const dashboardCss = readStylesheet('../../overview-dashboard.css');
    const start = dashboardCss.indexOf('@container ov-spec (min-width: 761px) and (max-width: 1099px) {');
    expect(start).toBeGreaterThan(-1);
    const body = dashboardCss.slice(start, dashboardCss.indexOf('}', dashboardCss.indexOf('{', dashboardCss.indexOf('.ov-spec-mark-label', start))) + 1);
    expect(body).toMatch(/\.ov-spec-mark-label \{[^}]*clip-path:\s*inset\(50%\)/);
    expect(body).not.toMatch(/display:\s*none/);
  });
});
