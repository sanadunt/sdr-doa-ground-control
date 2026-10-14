import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TelemetrySnapshot } from '../../types';
import { I18nContext, translate } from '../../lib/i18n';
import type { Lang } from '../../lib/i18n';
import { createReceiverBridge } from '../../lib/receiverBridge';
import type { BridgeEnvironment, ReceiverBridge } from '../../lib/receiverBridge';
import { BRIDGE_CHANNEL, BRIDGE_VERSION } from '../../lib/receiverBridgeProtocol';
import { DEFAULT_OVERVIEW_PANELS } from '../../lib/overviewPanels';
import type { ConsoleCapabilities } from '../../api';
import { SpectrumDock } from './SpectrumDock';

const ORIGIN = 'http://127.0.0.1:8787';

/** A bridge driven by hand: attach, then feed it frame messages. */
function bridgeWith(options: { probe?: number; hello?: boolean; status?: Record<string, unknown> | null; attach?: boolean } = {}): ReceiverBridge {
  type Listener = (event: { origin: string; source: unknown; data: unknown }) => void;
  const listeners: Listener[] = [];
  const env: BridgeEnvironment = {
    host: () => ({ location: { origin: ORIGIN }, addEventListener: (_type, listener) => { listeners.push(listener as Listener); }, removeEventListener: () => undefined }),
    setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => undefined,
    probe: () => Promise.resolve(options.probe ?? 200),
    random: () => 0.25,
  };
  const bridge = createReceiverBridge(env);
  const frame = { postMessage: () => undefined };
  if (options.attach !== false) bridge.attach(frame);
  const send = (type: string, payload: Record<string, unknown>) => {
    for (const listener of listeners) listener({ origin: ORIGIN, source: frame, data: { ch: BRIDGE_CHANNEL, v: BRIDGE_VERSION, type, ...payload } });
  };
  if (options.hello !== false && options.attach !== false) send('receiver:hello', { protocol: 1, mockAvailable: false, webusb: true });
  if (options.status) send('receiver:status', options.status);
  return bridge;
}

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 1, tMs: 0, webusb: true, mockAvailable: false, pairedCount: 1, connected: true, mock: false, deviceName: 'HackRF One',
    running: true, busy: 'none', workspace: 'listener', centerHz: 433_920_000, sampleRateHz: 20_000_000, frequencyShiftHz: 0,
    gains: { lnaDb: 24, vgaDb: 20, amp: false },
    vfo: { index: 0, enabled: false, mode: 'nfm', frequencyHz: 433_925_000, bandwidthHz: 12_500, squelchEnabled: false, squelchDb: -100, volume: 50 },
    squelchOpen: false, audio: 'running', recording: false, error: null, notice: null,
    ...overrides,
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
  it('orders title, source, chip, follow, mode, Dengar, Kirim, Mulai and the Receiver link', () => {
    const markup = dock(bridgeWith({ attach: false }));
    const order = ['Spektrum', 'HackRF · WebUSB', 'ov-chip', 'Ikuti frekuensi node', 'ov-listen-mode', '>Dengar<', '>Kirim ke Raspberry<', '>Mulai<', 'Buka Receiver penuh'];
    const positions = order.map((needle) => markup.indexOf(needle));
    for (const [index, position] of positions.entries()) expect(position, order[index]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('offers the eight listen modes with NFM selected by default', () => {
    const select = /<select class="ov-listen-mode"[\s\S]*?<\/select>/.exec(dock(bridgeWith({ attach: false })))?.[0] ?? '';
    expect(select).toContain('aria-label="Modulasi"');
    expect([...select.matchAll(/<option value="(\w+)"[^>]*>(\w+)<\/option>/g)].map((match) => `${match[1]}:${match[2]}`)).toEqual(['nfm:NFM', 'wfm:WFM', 'am:AM', 'usb:USB', 'lsb:LSB', 'dsb:DSB', 'cw:CW', 'raw:RAW']);
    expect(select).toMatch(/<option value="nfm" selected="">NFM<\/option>/);
  });

  it('follows the node by default and keeps the Receiver shortcut', () => {
    const markup = dock(bridgeWith({ attach: false }));
    expect(markup).toMatch(/<input type="checkbox" checked=""\/><span>Ikuti frekuensi node<\/span>/);
    expect(markup).toMatch(/aria-keyshortcuts="7"[^>]*title="Buka halaman Receiver \(tombol 7\)"/);
    expect(markup).toContain('<kbd aria-hidden="true">7</kbd>');
  });
});

describe('Spectrum dock states', () => {
  it('shows RX OFF and the stopped text before the frame is mounted', () => {
    const markup = dock(bridgeWith({ attach: false }));
    expect(chip(markup)).toBe('RX OFF');
    expect(markup).toContain('RX berhenti. Tekan Mulai untuk menyalakan HackRF.');
    // The axis follows the node until the first frame.
    expect(markup).toContain('Tengah 416.588 MHz · span 2.0 MHz · LNA — dB · VGA — dB');
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
    expect(markup).toContain('Tengah 433.920 MHz · span 2.0 MHz · LNA 24 dB · VGA 20 dB');
    expect(markup).toContain('>Berhenti<');
    expect(markup).not.toContain('RX berhenti.');
    expect(markup).toMatch(/aria-pressed="false" title="Putar audio VFO di browser ini"/);
    expect(markup).toContain('aria-valuetext="433.925 MHz"');
  });

  it('presses Dengar while the VFO is audible', () => {
    const markup = dock(bridgeWith({ status: status({ vfo: { index: 0, enabled: true, mode: 'wfm', frequencyHz: 433_925_000, bandwidthHz: 150_000 } }) }));
    expect(markup).toMatch(/aria-pressed="true" title="Berhenti mendengar"/);
  });

  it('offers Dengar again while the browser holds the audio back', () => {
    const markup = dock(bridgeWith({ status: status({ audio: 'suspended', vfo: { index: 0, enabled: true, mode: 'nfm', frequencyHz: 433_925_000, bandwidthHz: 12_500 } }) }));
    expect(markup).toMatch(/aria-pressed="true" title="Putar audio VFO di browser ini"/);
  });

  it('shows the mode the receiver demodulates; the stored preference only until the frame answers', () => {
    const select = (markup: string) => /<select class="ov-listen-mode"[\s\S]*?<\/select>/.exec(markup)?.[0] ?? '';
    // AM was set on the Receiver page, which shares the VFO; the stored preference is NFM.
    const live = select(dock(bridgeWith({ status: status({ vfo: { index: 0, enabled: true, mode: 'am', frequencyHz: 433_925_000, bandwidthHz: 10_000 } }) })));
    expect(live).toMatch(/<option value="am" selected="">AM<\/option>/);
    expect(live).not.toContain('selected="">NFM');
    expect(select(dock(bridgeWith({ hello: false })))).toMatch(/<option value="nfm" selected="">NFM<\/option>/);
    // A mode the console does not know falls back to the preference.
    expect(select(dock(bridgeWith({ status: status({ vfo: { index: 0, enabled: false, mode: 'fm', frequencyHz: 433_925_000 } }) })))).toMatch(/<option value="nfm" selected="">NFM<\/option>/);
  });

  it('shows the MOCK tag for the Mock SDR and UPCONVERTER for a frequency shift', () => {
    const markup = dock(bridgeWith({ status: status({ mock: true, deviceName: 'Mock SDR', frequencyShiftHz: 125_000_000 }) }));
    expect(markup).toContain('>MOCK</span>');
    expect(markup).not.toContain('HackRF · WebUSB');
    expect(markup).toContain('>UPCONVERTER</span>');
  });

  it('shows BUSY with the way to the Receiver page during a scan', () => {
    const markup = dock(bridgeWith({ status: status({ busy: 'scan-listen' }) }));
    expect(chip(markup)).toBe('BUSY');
    expect(markup).toContain('Pindai lebar atau dengar-pindai sedang berjalan');
    expect(markup).toContain('Buka Receiver (7)');
  });

  it('explains a lost HackRF', () => {
    const markup = dock(bridgeWith({ status: status({ running: false, connected: false, error: { code: 'USB_LOST' } }) }), { lang: 'en' });
    expect(chip(markup)).toBe('RX OFF');
    expect(markup).toContain('The HackRF was disconnected.');
  });

  it('enables Kirim ke Raspberry only for frequencies the Raspberry accepts', () => {
    const inRange = dock(bridgeWith({ status: status() }));
    expect(inRange).toMatch(/<button class="ov-button ov-spec-send" type="button" title="Buka Kontrol dengan draf tengah RX 433.920 MHz dan VFO 433.925 MHz/);
    const outOfRange = dock(bridgeWith({ status: status({ centerHz: 2_400_000_000, vfo: null }) }));
    expect(outOfRange).toMatch(/<button class="ov-button ov-spec-send" type="button" disabled="" title="Raspberry menerima 24 s\/d 1800 MHz/);
  });

  it('holds when there is no fresh node frequency to follow', () => {
    const markup = dock(bridgeWith({ attach: false }), { snapshot: null });
    expect(markup).toContain('Frekuensi node belum segar; tuning saat ini dipertahankan.');
  });

  it('renders without a bridge from App', () => {
    expect(chip(dock(undefined))).toBe('RX OFF');
  });
});
