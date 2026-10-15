import { describe, expect, it } from 'vitest';
import {
  autoDbRange,
  axisFor,
  binAt,
  contentBoxX,
  dbToByte,
  dockMode,
  followMemoryAtMount,
  followNodeStep,
  formatDb,
  formatMhz,
  formatMhzTrim,
  freqAtX,
  keyStepHz,
  MARKER_HIT_PX,
  MARKER_HIT_TOUCH_PX,
  markerLabelSlots,
  markersInView,
  markNoticeMessage,
  mhzDigits,
  nearestMarker,
  noticeFrameText,
  noticeMessage,
  paletteLut,
  peakOf,
  scanPhaseOf,
  scanPick,
  snapHz,
  spanAround,
  spectrumDockView,
  stepMarker,
  sweepAxis,
  ticks,
  waterfallNeedsReset,
  xAtFreq,
} from './spectrumView';
import type { DockViewInput, FollowInput } from './spectrumView';
import type { BridgeMarker, ReceiverStatus, StatusSweep } from './receiverBridgeProtocol';
import { DICTIONARIES } from './i18n';

const START = 432_920_000;
const STOP = 434_920_000;

function sweep(overrides: Partial<StatusSweep> = {}): StatusSweep {
  return {
    phase: 'idle', source: 'native', startHz: 100e6, stopHz: 1000e6, fftSize: 8192, resolutionHz: 2441.40625, lnaDb: 40, vgaDb: 20, amp: false,
    displayMinDb: -60, displayMaxDb: 0, view: 'average', ...overrides,
  };
}

function status(overrides: Partial<ReceiverStatus> = {}): ReceiverStatus {
  return {
    seq: 1, tMs: 0, webusb: true, mockAvailable: false, pairedCount: 1, connected: true, mock: false, deviceName: 'RadioSpectrum One',
    running: true, busy: 'none', workspace: 'listener', centerHz: 433_920_000, sampleRateHz: 20_000_000, frequencyShiftHz: 0,
    gains: { lnaDb: 40, vgaDb: 20, amp: false }, vfo: null, squelchOpen: false, audio: 'running', recording: false, error: null, notice: null,
    tune: null,
    display: null,
    sampleRatesHz: [],
    sweep: null,
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

  it('uses a running frame axis only while the frame was taken at the tuned centre', () => {
    const frame = { centerHz: 433_920_000, startHz: START, stopHz: STOP };
    const retuned = spanAround(145_500_000, 2_000_000);
    const here = spanAround(433_920_000, 2_000_000);
    expect(axisFor(frame, 433_920_000, true, here)).toEqual({ startHz: START, stopHz: STOP });
    // Within the 1 kHz snap the frame still counts as tuned here.
    expect(axisFor(frame, 433_921_000, true, spanAround(433_921_000, 2_000_000))).toEqual({ startHz: START, stopHz: STOP });
    // A retune moves the axis before the first frame at the new centre arrives.
    expect(axisFor(frame, 145_500_000, true, retuned)).toEqual(retuned);
    // Stopped: the expected span, or the last frame without one.
    expect(axisFor(frame, 433_920_000, false, retuned)).toEqual(retuned);
    expect(axisFor(frame, null, false, null)).toEqual({ startHz: START, stopHz: STOP });
    expect(axisFor(null, 145_500_000, true, retuned)).toEqual(retuned);
    expect(axisFor(null, null, true, null)).toBeNull();
    // Without a tuned centre the running frame decides.
    expect(axisFor(frame, null, true, retuned)).toEqual({ startHz: START, stopHz: STOP });
  });

  it('measures a click across the drawn canvas, inside any border', () => {
    // 1440 px layout: the trace wrapper (x 297, 1 px border) holds the trace canvas at x 298, 1129 px wide;
    // the waterfall canvas has the same border itself.
    const traceCanvas = { getBoundingClientRect: () => ({ left: 298 }), clientLeft: 0, clientWidth: 1129 };
    const waterfall = { getBoundingClientRect: () => ({ left: 297 }), clientLeft: 1, clientWidth: 1129 };
    expect(contentBoxX(308, traceCanvas)).toEqual({ x: 10, width: 1129 });
    expect(contentBoxX(308, waterfall)).toEqual({ x: 10, width: 1129 });
    // The frequency drawn 10 px into the canvas, not the one 11 px into the 1131 px border box.
    const { x, width } = contentBoxX(308, waterfall);
    expect(snapHz(freqAtX(x, START, STOP, width) as number)).toBe(432_938_000);
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

describe('follow node frequency', () => {
  const NODE = { centerHz: 433_920_000, vfoHz: 433_925_000 };
  const step = (memory: ReturnType<typeof followMemoryAtMount>, overrides: Partial<FollowInput> = {}) => followNodeStep(memory, {
    follow: true, node: NODE, running: true, canTune: true, liveCenterHz: 145_500_000, liveVfoHz: 145_500_000, ...overrides,
  });

  it('keeps a manual tuning when the dock mounts over a running receiver', () => {
    // Back on Overview after tuning 145.500 MHz on the Receiver page: no retune.
    const mounted = step(followMemoryAtMount(true, NODE));
    expect(mounted.tune).toBeNull();
    // A node change seen while mounted still retunes.
    const moved = { centerHz: 434_920_000, vfoHz: 434_925_000 };
    expect(step(mounted.memory, { node: moved }).tune).toEqual(moved);
  });

  it('tunes once when RX starts, then only when the node moves by more than 1 kHz', () => {
    // No frame yet: nothing to tune.
    const idle = step(followMemoryAtMount(false, NODE), { running: false, canTune: false });
    expect(idle.tune).toBeNull();
    const started = step(idle.memory);
    expect(started.tune).toEqual(NODE);
    expect(step(started.memory).tune).toBeNull();
    expect(step(started.memory, { node: { centerHz: NODE.centerHz + 900, vfoHz: NODE.vfoHz } }).tune).toBeNull();
    expect(step(started.memory, { node: { centerHz: NODE.centerHz + 1_500, vfoHz: NODE.vfoHz } }).tune).toEqual({ centerHz: NODE.centerHz + 1_500, vfoHz: NODE.vfoHz });
  });

  it('remembers a receiver already on the node, and holds while it cannot tune', () => {
    const atNode = step(followMemoryAtMount(false, null), { liveCenterHz: NODE.centerHz, liveVfoHz: NODE.vfoHz + 500 });
    expect(atNode).toEqual({ memory: { wasRunning: true, followed: NODE }, tune: null });
    for (const overrides of [{ follow: false }, { node: null }, { canTune: false }]) {
      const held = step(followMemoryAtMount(false, null), overrides);
      expect(held.tune, JSON.stringify(overrides)).toBeNull();
      // The start was seen, so it does not retune later on its own.
      expect(held.memory.wasRunning).toBe(true);
    }
  });

  it('retunes after the box is checked again', () => {
    const followed = step(followMemoryAtMount(true, NODE));
    expect(followed.tune).toBeNull();
    expect(step({ ...followed.memory, followed: null }).tune).toEqual(NODE);
  });
});

describe('spectrum dock state table', () => {
  it('reports a missing build first and disables the controls', () => {
    expect(spectrumDockView(input({ build: 'missing', phase: 'unresponsive' }))).toMatchObject({ chip: 'NOT BUILT', message: 'spectrum.notBuilt', controlsDisabled: true });
  });

  it('shows RX OFF before the frame is mounted', () => {
    expect(spectrumDockView(input({ phase: 'idle', status: null }))).toMatchObject({ chip: 'RX OFF', message: null, mode: 'rx', rxRunning: false, live: false, stoppable: false });
    // The stored Spektrum choice: Mulai starts the scan.
    expect(spectrumDockView(input({ phase: 'idle', status: null, storedMode: 'sweep' }))).toMatchObject({ chip: 'SCAN OFF', mode: 'sweep', live: false });
  });

  it('shows connecting while the frame loads or a start runs', () => {
    expect(spectrumDockView(input({ phase: 'connecting', status: null }))).toMatchObject({ chip: '…', message: 'spectrum.connecting' });
    expect(spectrumDockView(input({ phase: 'idle', status: null, starting: true }))).toMatchObject({ chip: '…' });
  });

  it('shows an RX restart for a sample rate change instead of RX stopped', () => {
    const stopped = status({ running: false });
    expect(spectrumDockView(input({ status: stopped, restarting: true }))).toMatchObject({ chip: '…', tone: 'info', message: 'spectrum.restarting', rxRunning: false, controlsDisabled: false });
    // Running again.
    expect(spectrumDockView(input({ restarting: true }))).toMatchObject({ chip: 'RX', rxRunning: true });
    expect(spectrumDockView(input({ status: stopped }))).toMatchObject({ chip: 'RX OFF' });
  });

  it('shows NO BRIDGE for an unresponsive frame', () => {
    expect(spectrumDockView(input({ phase: 'unresponsive', status: null }))).toMatchObject({ chip: 'NO BRIDGE', message: 'spectrum.unresponsive', openReceiver: true });
  });

  it('shows BUSY only while the Receiver listens to a scan candidate, and offers the Receiver page', () => {
    expect(spectrumDockView(input({ status: status({ busy: 'scan-listen', running: true }) }))).toMatchObject({
      chip: 'BUSY', message: 'spectrum.scanListenBusy', openReceiver: true, controlsDisabled: true, mode: 'rx', rxRunning: true, live: true, stoppable: false,
    });
  });

  it('shows a running scan as SCAN with live frames and no stopped overlay, also one the Receiver page started', () => {
    const scanning = status({ busy: 'sweep', running: false, sweep: sweep({ phase: 'active' }) });
    for (const storedMode of ['rx', 'sweep'] as const) {
      expect(spectrumDockView(input({ status: scanning, storedMode }))).toMatchObject({
        chip: 'SCAN', tone: 'good', message: null, mode: 'sweep', rxRunning: false, live: true, stoppable: true, controlsDisabled: false,
      });
    }
    // A refused tune keeps its notice under the live scan.
    expect(spectrumDockView(input({ status: scanning, notice: 'OUT_OF_RANGE' }))).toMatchObject({ chip: 'SCAN', message: 'spectrum.outOfRange', live: true });
    // A busy 'sweep' from a frame without a scan state still counts as a running scan.
    expect(spectrumDockView(input({ status: status({ busy: 'sweep', running: false, sweep: null }) }))).toMatchObject({ chip: 'SCAN', live: true });
  });

  it('shows … while the scan starts or stops; a starting scan can be stopped', () => {
    expect(spectrumDockView(input({ status: status({ busy: 'sweep', running: true, sweep: sweep({ phase: 'starting' }) }) }))).toMatchObject({
      chip: '…', tone: 'info', message: 'spectrum.sweepStarting', mode: 'sweep', live: false, stoppable: true,
    });
    expect(spectrumDockView(input({ status: status({ busy: 'sweep', running: false, sweep: sweep({ phase: 'stopping' }) }) }))).toMatchObject({
      chip: '…', message: 'spectrum.sweepStopping', mode: 'sweep', live: false, stoppable: false,
    });
  });

  it('shows SCAN OFF in Spektrum mode with nothing running, with the reason a scan did not start', () => {
    const idle = status({ running: false, sweep: sweep({ phase: 'idle' }) });
    expect(spectrumDockView(input({ status: idle, storedMode: 'sweep' }))).toMatchObject({ chip: 'SCAN OFF', tone: 'neutral', message: null, mode: 'sweep', live: false, stoppable: false });
    expect(spectrumDockView(input({ status: idle, storedMode: 'sweep', notice: 'SWEEP_FAILED' }))).toMatchObject({ chip: 'SCAN OFF', tone: 'bad', message: 'spectrum.sweepFailed', openReceiver: true });
    expect(spectrumDockView(input({ status: idle, storedMode: 'sweep', notice: 'SWEEP_UNSUPPORTED' }))).toMatchObject({ chip: 'SCAN OFF', tone: 'warn', message: 'spectrum.sweepUnsupported', openReceiver: true });
    expect(spectrumDockView(input({ status: idle, storedMode: 'sweep', starting: true }))).toMatchObject({ chip: '…', message: 'spectrum.connecting', mode: 'sweep' });
    // RX running wins over the stored Spektrum choice.
    expect(spectrumDockView(input({ storedMode: 'sweep' }))).toMatchObject({ chip: 'RX', mode: 'rx', live: true });
  });

  it('names WebUSB and pairing problems with the Receiver page as the way out', () => {
    expect(spectrumDockView(input({ status: status({ running: false, connected: false }), notice: 'NO_WEBUSB' }))).toMatchObject({ chip: 'NO_WEBUSB', message: 'spectrum.noWebusb', openReceiver: false });
    expect(spectrumDockView(input({ status: status({ running: false, connected: false }), notice: 'NEEDS_PAIRING' }))).toMatchObject({ chip: 'NEEDS_PAIRING', message: 'spectrum.needsPairing', openReceiver: true });
    expect(spectrumDockView(input({ status: status({ running: false, connected: false }), notice: 'NEEDS_DEVICE_CHOICE' }))).toMatchObject({ chip: 'NEEDS_DEVICE_CHOICE', message: 'spectrum.needsChoice', openReceiver: true });
  });

  it('shows RX while running, with an audio-blocked hint when there is one', () => {
    expect(spectrumDockView(input())).toMatchObject({ chip: 'RX', tone: 'good', message: null, mode: 'rx', rxRunning: true, live: true, stoppable: true });
    expect(spectrumDockView(input({ notice: 'AUDIO_BLOCKED' }))).toMatchObject({ chip: 'RX', message: 'spectrum.audioBlocked' });
  });

  it('explains a stopped radio after a USB loss or an RX error', () => {
    expect(spectrumDockView(input({ status: status({ running: false, connected: false, error: { code: 'USB_LOST' } }) }))).toMatchObject({ chip: 'RX OFF', tone: 'bad', message: 'spectrum.usbLost' });
    expect(spectrumDockView(input({ status: status({ running: false, error: { code: 'RX_ERROR' } }) }))).toMatchObject({ message: 'spectrum.rxError', openReceiver: true });
  });

  it('has a message for every notice code', () => {
    for (const code of ['NOT_READY', 'INVALID_COMMAND', 'RX_NOT_RUNNING', 'OUT_OF_RANGE', 'TIMEOUT', 'MOCK_UNAVAILABLE', 'CONNECT_FAILED', 'RECORDING_ACTIVE', 'SWEEP_UNSUPPORTED', 'SWEEP_FAILED'] as const) {
      expect(DICTIONARIES.en[noticeMessage(code)], code).toBeTruthy();
    }
    expect(noticeMessage('RECORDING_ACTIVE')).toBe('spectrum.recordingActive');
    expect(noticeMessage('SWEEP_FAILED')).toBe('spectrum.sweepFailed');
    expect(noticeMessage('SWEEP_UNSUPPORTED')).toBe('spectrum.sweepUnsupported');
    expect(noticeMessage('MARKER_LIMIT')).toBe('spectrum.markLimit');
    expect(noticeMessage('MARKER_NOT_FOUND')).toBe('spectrum.markNotFound');
    expect(noticeMessage('MARKER_SAVE_FAILED')).toBe('spectrum.markSaveFailed');
    // For a marker command, OUT_OF_RANGE is the marker range; other codes keep their own text.
    expect(markNoticeMessage('OUT_OF_RANGE')).toBe('spectrum.markOutOfRange');
    expect(markNoticeMessage('TIMEOUT')).toBe('spectrum.timeout');
    expect(markNoticeMessage('MARKER_LIMIT')).toBe('spectrum.markLimit');
    for (const key of ['spectrum.markLimit', 'spectrum.markNotFound', 'spectrum.markSaveFailed', 'spectrum.markOutOfRange'] as const) {
      expect(DICTIONARIES.en[key], key).toBeTruthy();
      expect(DICTIONARIES.id[key], key).toBeTruthy();
    }
  });

  it('shows the Receiver\'s own text after a failed connect or scan start, not after other codes', () => {
    expect(noticeFrameText({ code: 'SWEEP_FAILED', message: 'Sweep error: device busy' })).toBe('Sweep error: device busy');
    expect(noticeFrameText({ code: 'CONNECT_FAILED', message: 'USB claim failed' })).toBe('USB claim failed');
    expect(noticeFrameText({ code: 'NOT_READY', message: 'x' })).toBe('x');
    // A failed marker save names the Receiver's reason.
    expect(noticeFrameText({ code: 'MARKER_SAVE_FAILED', message: 'Could not save marker set: disk full' })).toBe('Could not save marker set: disk full');
    expect(noticeFrameText({ code: 'SWEEP_FAILED' })).toBeNull();
    expect(noticeFrameText({ code: 'SWEEP_BUSY', message: 'x' })).toBeNull();
    expect(noticeFrameText({ code: 'TIMEOUT', message: 'x' })).toBeNull();
    expect(noticeFrameText(null)).toBeNull();
  });
});

describe('spectrum dock mode and scan helpers', () => {
  it('shows the mode that runs, else the stored one', () => {
    expect(dockMode(null, 'rx')).toBe('rx');
    expect(dockMode(null, 'sweep')).toBe('sweep');
    expect(dockMode(status({ running: true }), 'sweep')).toBe('rx');
    expect(dockMode(status({ busy: 'sweep', running: true }), 'rx')).toBe('sweep');
    expect(dockMode(status({ busy: 'scan-listen', running: true }), 'sweep')).toBe('rx');
    expect(dockMode(status({ running: false }), 'sweep')).toBe('sweep');
    expect(scanPhaseOf(null)).toBe('idle');
    expect(scanPhaseOf(status({ busy: 'none', sweep: sweep({ phase: 'active' }) }))).toBe('idle');
    expect(scanPhaseOf(status({ busy: 'sweep', sweep: sweep({ phase: 'stopping' }) }))).toBe('stopping');
    expect(scanPhaseOf(status({ busy: 'sweep', sweep: sweep({ phase: 'idle' }) }))).toBe('active');
  });

  it('reads MHz with the decimals a step can tell apart', () => {
    expect(mhzDigits(1_757_812)).toBe(0);
    expect(mhzDigits(1_000_000)).toBe(0);
    expect(mhzDigits(500_000)).toBe(1);
    expect(mhzDigits(100_000)).toBe(1);
    expect(mhzDigits(24_000)).toBe(2);
    expect(mhzDigits(2_441)).toBe(3);
    expect(mhzDigits(1)).toBe(3);
    expect(mhzDigits(Number.NaN)).toBe(3);
    expect(ticks(100e6, 1000e6, 5, mhzDigits(225e6)).map((tick) => tick.label)).toEqual(['100', '325', '550', '775', '1000']);
    expect(ticks(433e6, 435e6, 5, 1).map((tick) => tick.label)).toEqual(['433.0', '433.5', '434.0', '434.5', '435.0']);
    expect(formatMhzTrim(100e6)).toBe('100');
    expect(formatMhzTrim(1000e6)).toBe('1000');
    expect(formatMhzTrim(433_920_000)).toBe('433.92');
    expect(formatMhzTrim(-25e6)).toBe('−25');
    expect(formatMhzTrim(null)).toBe('—');
  });

  it('steps the arrow keys by a 200th of the scan, at least 10 kHz', () => {
    expect(keyStepHz(900e6)).toBe(4_500_000);
    expect(keyStepHz(1e6)).toBe(10_000);
    expect(keyStepHz(3_333_333)).toBe(17_000);
    expect(keyStepHz(Number.NaN)).toBe(10_000);
  });

  it('picks the strongest scan bin next to a click', () => {
    const bins = new Float32Array(10).fill(-90);
    bins[4] = -20;
    // 10 bins of 1 MHz from 100 MHz: a click in bin 2 takes bin 4 (two away), a click in bin 8 stays.
    expect(scanPick(bins, 100e6, 110e6, 102.3e6)).toBe(104.5e6);
    expect(scanPick(bins, 100e6, 110e6, 108.3e6)).toBe(108.5e6);
    expect(scanPick(bins, 100e6, 110e6, 99e6)).toBeNull();
    expect(scanPick(new Float32Array(0), 100e6, 110e6, 105e6)).toBeNull();
  });

  it('draws a running scan on its own range, a stopped one on the Receiver range', () => {
    const frame = { startHz: 100e6, stopHz: 1000e6 };
    const settings = { startHz: 400e6, stopHz: 500e6 };
    expect(sweepAxis(frame, true, settings)).toEqual(frame);
    expect(sweepAxis(frame, false, settings)).toEqual(settings);
    expect(sweepAxis(frame, false, null)).toEqual(frame);
    expect(sweepAxis(null, true, settings)).toEqual(settings);
  });

  it('starts a new waterfall history for another source, bin count or scan range, not for an RX retune', () => {
    const rx = { source: 'rx' as const, binCount: 512, startHz: 432.9e6, stopHz: 434.9e6 };
    const scan = { source: 'sweep' as const, binCount: 512, startHz: 100e6, stopHz: 1000e6 };
    expect(waterfallNeedsReset(null, rx)).toBe(true);
    expect(waterfallNeedsReset(rx, { ...rx, startHz: 144e6, stopHz: 146e6 })).toBe(false);
    expect(waterfallNeedsReset(rx, { ...rx, binCount: 256 })).toBe(true);
    expect(waterfallNeedsReset(rx, scan)).toBe(true);
    expect(waterfallNeedsReset(scan, rx)).toBe(true);
    expect(waterfallNeedsReset(scan, { ...scan })).toBe(false);
    expect(waterfallNeedsReset(scan, { ...scan, stopHz: 900e6 })).toBe(true);
  });
});

describe('spectrum dock markers', () => {
  const marker = (id: string | null, frequencyHz: number, label = id ?? '?'): BridgeMarker => ({ id, frequencyHz, powerDb: null, label });
  const AXIS = { startHz: 433_000_000, stopHz: 435_000_000 };
  const LIST = [marker('a', 432_900_000), marker('b', 433_000_000), marker('c', 433_500_000), marker(null, 433_510_000), marker('d', 434_000_000), marker('e', 435_500_000)];

  it('places the markers inside the axis, edges included, in frequency order', () => {
    expect(markersInView(LIST, AXIS, 1000).map(({ marker: entry, x }) => [entry.id, x])).toEqual([['b', 0], ['c', 250], [null, 255], ['d', 500]]);
    expect(markersInView(LIST, null, 1000)).toEqual([]);
    expect(markersInView(LIST, AXIS, 0)).toEqual([]);
    expect(markersInView([marker('z', 434_000_000), marker('y', 433_500_000)], AXIS, 1000).map(({ marker: entry }) => entry.id)).toEqual(['y', 'z']);
  });

  it('picks the nearest addressable marker within 6 px, or 12 px for a finger', () => {
    expect(MARKER_HIT_PX).toBe(6);
    expect(MARKER_HIT_TOUCH_PX).toBe(12);
    expect(nearestMarker(LIST, AXIS, 254, 1000, MARKER_HIT_PX)?.id, 'the marker without an id is skipped').toBe('c');
    expect(nearestMarker(LIST, AXIS, 492, 1000, MARKER_HIT_PX)).toBeNull();
    expect(nearestMarker(LIST, AXIS, 492, 1000, MARKER_HIT_TOUCH_PX)?.id).toBe('d');
    expect(nearestMarker(LIST, AXIS, 700, 1000, MARKER_HIT_TOUCH_PX)).toBeNull();
    expect(nearestMarker(LIST, AXIS, Number.NaN, 1000, MARKER_HIT_PX)).toBeNull();
  });

  it('steps the pick through the markers in view with [ and ]', () => {
    expect(stepMarker(LIST, AXIS, 1000, null, 1)?.id).toBe('b');
    expect(stepMarker(LIST, AXIS, 1000, null, -1)?.id).toBe('d');
    expect(stepMarker(LIST, AXIS, 1000, 'c', 1)?.id, 'past the one without an id').toBe('d');
    expect(stepMarker(LIST, AXIS, 1000, 'd', 1)?.id, 'stays at the end').toBe('d');
    expect(stepMarker(LIST, AXIS, 1000, 'b', -1)?.id).toBe('b');
    expect(stepMarker(LIST, AXIS, 1000, 'e', -1)?.id, 'a pick out of view starts from the end').toBe('d');
    expect(stepMarker([], AXIS, 1000, null, 1)).toBeNull();
  });

  it('leaves out labels that would run into the one before', () => {
    expect(markerLabelSlots([0, 30, 70, 75, 200], [60, 60, 60, 60, 60], 4)).toEqual([true, false, true, false, true]);
    expect(markerLabelSlots([], [])).toEqual([]);
  });

  it('always draws the picked marker\'s label and leaves out the neighbours it would overlap', () => {
    // The picked second label takes its slot; the first and third would overlap it.
    expect(markerLabelSlots([0, 30, 70, 200], [60, 60, 60, 60], 4, 1)).toEqual([false, true, false, true]);
    // Labels clear of the picked one stay; the one running into it from the left goes.
    expect(markerLabelSlots([0, 70, 100, 200], [60, 60, 60, 60], 4, 2)).toEqual([true, false, true, true]);
    expect(markerLabelSlots([0, 100], [60, 60], 4, 1)).toEqual([true, true]);
    // No pick, or one out of range, is the plain left-to-right rule.
    expect(markerLabelSlots([0, 30, 70], [60, 60, 60], 4, -1)).toEqual([true, false, true]);
    expect(markerLabelSlots([0, 30, 70], [60, 60, 60], 4, 9)).toEqual([true, false, true]);
  });
});
