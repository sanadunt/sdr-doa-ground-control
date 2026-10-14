import { describe, expect, it } from 'vitest';
import {
  autoDbRange,
  binAt,
  dbToByte,
  formatDb,
  formatMhz,
  freqAtX,
  noticeMessage,
  paletteLut,
  peakOf,
  snapHz,
  spanAround,
  spectrumDockView,
  ticks,
  xAtFreq,
} from './spectrumView';
import type { DockViewInput } from './spectrumView';
import type { ReceiverStatus } from './receiverBridgeProtocol';
import { DICTIONARIES } from './i18n';

const START = 432_920_000;
const STOP = 434_920_000;

function status(overrides: Partial<ReceiverStatus> = {}): ReceiverStatus {
  return {
    seq: 1, tMs: 0, webusb: true, mockAvailable: false, pairedCount: 1, connected: true, mock: false, deviceName: 'HackRF One',
    running: true, busy: 'none', workspace: 'listener', centerHz: 433_920_000, sampleRateHz: 20_000_000, frequencyShiftHz: 0,
    gains: { lnaDb: 40, vgaDb: 20, amp: false }, vfo: null, squelchOpen: false, audio: 'running', recording: false, error: null, notice: null,
    ...overrides,
  };
}

const input = (overrides: Partial<DockViewInput> = {}): DockViewInput => ({ build: 'built', phase: 'ready', starting: false, status: status(), notice: null, ...overrides });

describe('spectrum axis', () => {
  it('maps pixels to frequencies and back', () => {
    expect(freqAtX(0, START, STOP, 640)).toBe(START);
    expect(freqAtX(320, START, STOP, 640)).toBe(433_920_000);
    expect(freqAtX(-10, START, STOP, 640)).toBe(START);
    expect(freqAtX(10, START, START, 640)).toBeNull();
    expect(xAtFreq(433_920_000, START, STOP, 640)).toBe(320);
    expect(xAtFreq(Number.NaN, START, STOP, 640)).toBeNull();
  });

  it('snaps a click to 1 kHz', () => {
    expect(snapHz(433_920_499)).toBe(433_920_000);
    expect(snapHz(433_920_500)).toBe(433_921_000);
    expect(Number.isNaN(snapHz(Number.NaN))).toBe(true);
  });

  it('labels five ticks from start to stop', () => {
    expect(ticks(START, STOP).map((tick) => tick.label)).toEqual(['432.920', '433.420', '433.920', '434.420', '434.920']);
    expect(ticks(STOP, START)).toEqual([]);
    expect(spanAround(433_920_000, 2_000_000)).toEqual({ startHz: START, stopHz: STOP });
    expect(spanAround(null, 2_000_000)).toBeNull();
  });

  it('formats with a real minus sign', () => {
    expect(formatMhz(433_920_000)).toBe('433.920');
    expect(formatMhz(null)).toBe('—');
    expect(formatDb(-38.04)).toBe('−38.0');
    expect(formatDb(-0.01)).toBe('0.0');
  });
});

describe('spectrum levels', () => {
  const bins = Float32Array.from([-100, -98, -99, -97, -101, -40, -99, -100, -98, -102]);

  it('scales from the noise floor to the peak', () => {
    const range = autoDbRange(bins);
    expect(range?.max).toBeCloseTo(-35);
    // Sorted, the 20th percentile (index 1 of 0..9) is -101.
    expect(range?.min).toBeCloseTo(-106);
  });

  it('keeps at least 20 dB and smooths towards a new range', () => {
    const flat = autoDbRange(Float32Array.from([-60, -60, -60]));
    expect((flat?.max ?? 0) - (flat?.min ?? 0)).toBeCloseTo(20);
    const smoothed = autoDbRange(bins, { min: -125, max: -15 }, 0.5);
    expect(smoothed?.min).toBeCloseTo(-115.5);
    expect(smoothed?.max).toBeCloseTo(-25);
    expect(autoDbRange([Number.NaN], null)).toBeNull();
  });

  it('finds the peak and the bin under a frequency', () => {
    const peak = peakOf(bins, 0, 10_000);
    expect(peak).toEqual({ db: -40, hz: 5_500 });
    expect(binAt(bins, 0, 10_000, 5_999)).toBe(-40);
    expect(binAt(bins, 0, 10_000, 10_000)).toBeNull();
  });

  it('maps power to a waterfall byte and builds a palette', () => {
    expect(dbToByte(-110, { min: -100, max: -20 })).toBe(0);
    expect(dbToByte(-60, { min: -100, max: -20 })).toBe(128);
    expect(dbToByte(0, { min: -100, max: -20 })).toBe(255);
    const lut = paletteLut([[0, '#000000'], [1, '#ff8000']]);
    expect(Array.from(lut.slice(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(lut.slice(255 * 3, 256 * 3))).toEqual([255, 128, 0]);
  });
});

describe('spectrum dock state table', () => {
  it('reports a missing build first and disables the controls', () => {
    expect(spectrumDockView(input({ build: 'missing', phase: 'unresponsive' }))).toMatchObject({ chip: 'NOT BUILT', message: 'spectrum.notBuilt', controlsDisabled: true });
  });

  it('shows RX OFF before the frame is mounted', () => {
    expect(spectrumDockView(input({ phase: 'idle', status: null }))).toMatchObject({ chip: 'RX OFF', message: null, running: false });
  });

  it('shows connecting while the frame loads or a start runs', () => {
    expect(spectrumDockView(input({ phase: 'connecting', status: null }))).toMatchObject({ chip: '…', message: 'spectrum.connecting' });
    expect(spectrumDockView(input({ phase: 'idle', status: null, starting: true }))).toMatchObject({ chip: '…' });
  });

  it('shows NO BRIDGE for an unresponsive frame', () => {
    expect(spectrumDockView(input({ phase: 'unresponsive', status: null }))).toMatchObject({ chip: 'NO BRIDGE', message: 'spectrum.unresponsive', openReceiver: true });
  });

  it('shows BUSY while the Receiver scans and offers the Receiver page', () => {
    expect(spectrumDockView(input({ status: status({ busy: 'sweep', running: false }) }))).toMatchObject({ chip: 'BUSY', message: 'spectrum.sweepBusy', openReceiver: true, controlsDisabled: true });
  });

  it('names WebUSB and pairing problems with the Receiver page as the way out', () => {
    expect(spectrumDockView(input({ status: status({ running: false, connected: false }), notice: 'NO_WEBUSB' }))).toMatchObject({ chip: 'NO_WEBUSB', message: 'spectrum.noWebusb', openReceiver: false });
    expect(spectrumDockView(input({ status: status({ running: false, connected: false }), notice: 'NEEDS_PAIRING' }))).toMatchObject({ chip: 'NEEDS_PAIRING', message: 'spectrum.needsPairing', openReceiver: true });
    expect(spectrumDockView(input({ status: status({ running: false, connected: false }), notice: 'NEEDS_DEVICE_CHOICE' }))).toMatchObject({ chip: 'NEEDS_DEVICE_CHOICE', message: 'spectrum.needsChoice', openReceiver: true });
  });

  it('shows RX while running, with an audio-blocked hint when there is one', () => {
    expect(spectrumDockView(input())).toMatchObject({ chip: 'RX', tone: 'good', message: null, running: true });
    expect(spectrumDockView(input({ notice: 'AUDIO_BLOCKED' }))).toMatchObject({ chip: 'RX', message: 'spectrum.audioBlocked' });
  });

  it('explains a stopped radio after a USB loss or an RX error', () => {
    expect(spectrumDockView(input({ status: status({ running: false, connected: false, error: { code: 'USB_LOST' } }) }))).toMatchObject({ chip: 'RX OFF', tone: 'bad', message: 'spectrum.usbLost' });
    expect(spectrumDockView(input({ status: status({ running: false, error: { code: 'RX_ERROR' } }) }))).toMatchObject({ message: 'spectrum.rxError', openReceiver: true });
  });

  it('has a message for every notice code', () => {
    for (const code of ['NOT_READY', 'INVALID_COMMAND', 'RX_NOT_RUNNING', 'OUT_OF_RANGE', 'TIMEOUT', 'MOCK_UNAVAILABLE', 'CONNECT_FAILED'] as const) {
      expect(DICTIONARIES.en[noticeMessage(code)], code).toBeTruthy();
    }
  });
});
