import { describe, expect, it } from 'vitest';
import {
  MIRROR_LIMITS,
  MIRROR_MIN_ENCODED_SPAN_DB,
  base64ToBytes,
  bytesToBase64,
  decimateMaxHold,
  decodeBins,
  encodeBins,
  mirrorFrameFromSpectrum,
  mirrorStateFromStatus,
  mirrorStateKey,
  mirrorView,
  normalizeMirrorAnswer,
  normalizeMirrorFrame,
  normalizeMirrorState,
  spectrumFromMirrorFrame,
} from './receiverMirror';
import type { MirrorAnswer, MirrorFrame, MirrorPublish, MirrorState } from './receiverMirror';
import type { ReceiverStatus, RxSpectrumFrame, SweepSpectrumFrame } from './receiverBridgeProtocol';

/** Vitest blanks no JSON, but the fixture lives outside the frontend: read it from disk. */
function readFixture(): MirrorPublish {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  const text = process.getBuiltinModule('node:fs').readFileSync(new URL('../../../tools/fixtures/receiver-mirror/publish.json', import.meta.url), 'utf8');
  return JSON.parse(text) as MirrorPublish;
}

function receiverStatus(overrides: Partial<ReceiverStatus> = {}): ReceiverStatus {
  return {
    seq: 1,
    tMs: 1_761_000_000_000,
    webusb: true,
    mockAvailable: false,
    pairedCount: 1,
    connected: true,
    mock: false,
    deviceName: 'RadioSpectrum One',
    running: true,
    busy: 'none',
    workspace: 'listener',
    centerHz: 433_920_000,
    sampleRateHz: 10_000_000,
    frequencyShiftHz: 0,
    gains: { lnaDb: 16, vgaDb: 20, amp: false },
    vfo: { index: 0, enabled: true, mode: 'nfm', frequencyHz: 433_925_000, bandwidthHz: 12_500, squelchEnabled: false, squelchDb: -60.5, volume: 50 },
    squelchOpen: true,
    audio: 'running',
    recording: false,
    error: null,
    notice: null,
    tune: null,
    display: null,
    sampleRatesHz: [],
    sweep: {
      phase: 'idle', source: 'native', startHz: 400_000_000, stopHz: 500_000_000, fftSize: 4096, resolutionHz: 4882.8125,
      lnaDb: 16, vgaDb: 20, amp: false, displayMinDb: -110, displayMaxDb: -20, view: 'max',
    },
    ...overrides,
  };
}

function rxFrame(bins: number[] | Float32Array, overrides: Partial<RxSpectrumFrame> = {}): RxSpectrumFrame {
  const values = Float32Array.from(bins);
  return {
    source: 'rx', seq: 7, tMs: 1_761_000_000_007, centerHz: 433_920_000, startHz: 432_920_000, stopHz: 434_920_000,
    sampleRateHz: 10_000_000, fftSize: values.length, binCount: values.length, bins: values, ...overrides,
  };
}

/** Every key path of a JSON value, so two shapes can be compared without their values. */
function shape(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => (
    child !== null && typeof child === 'object' && !Array.isArray(child) ? shape(child, `${prefix}${key}.`) : [`${prefix}${key}`]
  )).sort();
}

describe('mirror frame encoding', () => {
  it('keeps the strongest bin of each group when it decimates', () => {
    const values = Array.from({ length: 2048 }, (_value, index) => (index % 4 === 3 ? -40 : -100));
    const out = decimateMaxHold(values, 512);
    expect(out).toHaveLength(512);
    expect([...out].every((value) => value === -40)).toBe(true);
    const uneven = decimateMaxHold([1, 9, 2, 3, 8, 4, 5], 3);
    // Groups of 2, 2 and 3 bins.
    expect([...uneven]).toEqual([9, 3, 8]);
    // At most the count: fewer bins stay as they are.
    expect([...decimateMaxHold([1, 2, 3], 512)]).toEqual([1, 2, 3]);
  });

  it('states a whole-dB range around the bins and keeps every bin within one step', () => {
    const values = Float32Array.from({ length: 512 }, (_value, index) => -110 + (index % 64) * 1.37);
    const { dbMin, dbMax, bytes } = encodeBins(values);
    expect(dbMin).toBe(-110);
    expect(dbMax).toBe(Math.ceil(-110 + 63 * 1.37));
    const decoded = decodeBins(bytes, dbMin, dbMax);
    const step = (dbMax - dbMin) / 255;
    values.forEach((value, index) => expect(Math.abs(decoded[index] - value)).toBeLessThanOrEqual(step / 2 + 1e-4));
  });

  it('leaves the floor level out of the range and keeps at least 10 dB', () => {
    const flat = encodeBins([-200, -80.2, -80, -79.6, Number.NaN]);
    expect(flat.dbMax - flat.dbMin).toBe(MIRROR_MIN_ENCODED_SPAN_DB);
    expect(flat.dbMin).toBe(-81);
    expect(flat.bytes[0]).toBe(0);
    expect(flat.bytes[4]).toBe(0);
    const silent = encodeBins([-200, -200]);
    expect([silent.dbMin, silent.dbMax]).toEqual([MIRROR_LIMITS.dbFloor, MIRROR_LIMITS.dbFloor + MIRROR_MIN_ENCODED_SPAN_DB]);
    const loud = encodeBins([95, 120]);
    expect(loud.dbMax).toBe(MIRROR_LIMITS.dbCeiling);
    expect(loud.dbMax - loud.dbMin).toBeGreaterThanOrEqual(MIRROR_MIN_ENCODED_SPAN_DB);
  });

  it('round-trips base64 and refuses anything else', () => {
    const bytes = Uint8Array.from({ length: 512 }, (_value, index) => (index * 7) % 256);
    const text = bytesToBase64(bytes);
    expect(text).toHaveLength(684);
    expect(base64ToBytes(text, 512)).toEqual(bytes);
    expect(base64ToBytes(text, 511)).toBeNull();
    expect(base64ToBytes('!'.repeat(684), 512)).toBeNull();
    expect(base64ToBytes(`${text.slice(0, -4)}====`, 512)).toBeNull();
  });

  it('turns an RX frame of 2048 bins into at most 512 bytes with integer Hz', () => {
    const bins = Array.from({ length: 2048 }, (_value, index) => (index === 1024 ? -30 : -100));
    const frame = mirrorFrameFromSpectrum(rxFrame(bins, { startHz: 432_920_000.4, stopHz: 434_920_000.6 }), 5);
    expect(frame).not.toBeNull();
    const published = frame as MirrorFrame;
    expect(published).toMatchObject({ kind: 'rx', seq: 7, t_ms: 1_761_000_000_007, center_hz: 433_920_000, start_hz: 432_920_000, stop_hz: 434_920_001, bin_count: 512 });
    const back = spectrumFromMirrorFrame(published, null) as RxSpectrumFrame;
    expect(back.source).toBe('rx');
    expect(back.binCount).toBe(512);
    expect(Math.max(...back.bins)).toBeCloseTo(-30, 0);
    expect(back.bins.indexOf(Math.max(...back.bins))).toBe(256);
    // The body of a full frame and state stays far below 8 KiB.
    const body: MirrorPublish = { v: 1, source: { id: 'kiosk-0123456789abcdef', kind: 'kiosk-tab', visible: true }, state: mirrorStateFromStatus(receiverStatus(), 1, 0), frame: published };
    expect(JSON.stringify(body).length).toBeLessThan(MIRROR_LIMITS.maxBodyBytes / 4);
  });

  it('gives a scan frame its middle as the centre and reads it back as a scan', () => {
    const sweep: SweepSpectrumFrame = {
      source: 'sweep', seq: 3, tMs: null, startHz: 400_000_000, stopHz: 500_000_000, resolutionHz: 4882.8125, sweepCount: 2, view: 'max',
      binCount: 512, bins: Float32Array.from({ length: 512 }, () => -90),
    };
    const frame = mirrorFrameFromSpectrum(sweep, 42) as MirrorFrame;
    expect(frame).toMatchObject({ kind: 'sweep', t_ms: 42, center_hz: 450_000_000, start_hz: 400_000_000, stop_hz: 500_000_000 });
    const back = spectrumFromMirrorFrame(frame, mirrorStateFromStatus(receiverStatus(), 1, 0)) as SweepSpectrumFrame;
    expect(back).toMatchObject({ source: 'sweep', startHz: 400_000_000, stopHz: 500_000_000, resolutionHz: 4882.8125, view: 'max' });
  });

  it('publishes nothing for a frame without a range or with too few bins', () => {
    expect(mirrorFrameFromSpectrum(rxFrame(new Array(512).fill(-90), { startHz: 5, stopHz: 5 }), 0)).toBeNull();
    expect(mirrorFrameFromSpectrum(rxFrame(new Array(8).fill(-90)), 0)).toBeNull();
  });
});

describe('mirror state', () => {
  it('has exactly the shape of the shared fixture, which the console checks too', () => {
    const fixture = readFixture();
    const state = mirrorStateFromStatus(receiverStatus(), 7, 0);
    expect(shape(state)).toEqual(shape(fixture.state));
    expect(state).toEqual(fixture.state);
    const frame = mirrorFrameFromSpectrum(rxFrame(new Array(16).fill(-90)), 0) as MirrorFrame;
    expect(shape(frame)).toEqual(shape(fixture.frame));
    expect(normalizeMirrorState(fixture.state)).toEqual(fixture.state);
    expect(normalizeMirrorFrame(fixture.frame)).toEqual(fixture.frame);
  });

  it('copies the bridge status with a span no wider than the sample rate', () => {
    const state = mirrorStateFromStatus(receiverStatus({ sampleRateHz: 1_500_000, centerHz: 100_000_000.6, frequencyShiftHz: -125_000_000, error: { code: 'USB_LOST' }, vfo: null, sweep: null }), 3, 99);
    expect(state).toMatchObject({ rev: 3, t_ms: 1_761_000_000_000, center_hz: 100_000_001, sample_rate_hz: 1_500_000, span_hz: 1_500_000, frequency_shift_hz: -125_000_000, error: 'USB_LOST', vfo: null, scan: null });
    expect(mirrorStateFromStatus(receiverStatus({ tMs: null, sampleRateHz: null }), 1, 77)).toMatchObject({ t_ms: 77, sample_rate_hz: null, span_hz: null });
  });

  it('changes its key only when something but rev and time changes', () => {
    const one = mirrorStateFromStatus(receiverStatus(), 1, 0);
    const two = mirrorStateFromStatus(receiverStatus({ tMs: 5, seq: 9 }), 2, 10);
    expect(mirrorStateKey(two)).toBe(mirrorStateKey(one));
    expect(mirrorStateKey(mirrorStateFromStatus(receiverStatus({ centerHz: 1 }), 1, 0))).not.toBe(mirrorStateKey(one));
  });
});

function answer(overrides: Partial<MirrorAnswer> = {}, stateOverrides: Partial<MirrorState> = {}): MirrorAnswer {
  const fixture = readFixture();
  return {
    rev: 10,
    frameRev: 4,
    source: fixture.source,
    sourceAgeMs: 100,
    state: { ...fixture.state, ...stateOverrides },
    stateAgeMs: 100,
    frame: fixture.frame ?? null,
    frameAgeMs: 150,
    frameStaleMs: 3000,
    sourceLostMs: 10000,
    ...overrides,
  };
}

describe('the GET answer', () => {
  it('reads a server answer and drops parts that do not check out', () => {
    const fixture = readFixture();
    const body = {
      ok: true, v: 1, rev: 3, frame_rev: 2, source: fixture.source, source_age_ms: 120, state: fixture.state, state_age_ms: 120,
      frame: fixture.frame, frame_age_ms: 400, limits: { frame_stale_ms: 3000, source_lost_ms: 10000 },
    };
    expect(normalizeMirrorAnswer(body)).toEqual({
      rev: 3, frameRev: 2, source: fixture.source, sourceAgeMs: 120, state: fixture.state, stateAgeMs: 120, frame: fixture.frame, frameAgeMs: 400, frameStaleMs: 3000, sourceLostMs: 10000,
    });
    const badFrame = normalizeMirrorAnswer({ ...body, frame: { ...fixture.frame, bins: 'AAAA' } });
    expect(badFrame?.frame).toBeNull();
    expect(badFrame?.state).toEqual(fixture.state);
    expect(normalizeMirrorAnswer({ ...body, source: { ...fixture.source, id: 'x' } })?.state).toBeNull();
    expect(normalizeMirrorAnswer({ ...body, ok: false })).toBeNull();
    expect(normalizeMirrorAnswer({ ...body, v: 2 })).toBeNull();
    expect(normalizeMirrorAnswer({ ok: true, v: 1, rev: 0, frame_rev: 0, source: null, state: null, frame: null })).toMatchObject({ source: null, state: null, frame: null });
  });
});

describe('mirror view (stale rules)', () => {
  const at = (value: MirrorAnswer | null, elapsed: number, error = false) => mirrorView({ answer: value, receivedAtMs: value ? 1_000 : null, error, nowMs: 1_000 + elapsed });

  it('waits for the first answer, then says when the console does not answer', () => {
    expect(at(null, 0)).toMatchObject({ phase: 'connecting', chip: '…', message: 'mirror.connecting', live: false });
    expect(at(null, 0, true)).toMatchObject({ phase: 'lost', chipKey: 'mirror.chipLost', tone: 'bad', message: 'mirror.readFailed' });
  });

  it('shows nothing published as the source lost', () => {
    expect(at(answer({ source: null, state: null, frame: null, sourceAgeMs: null, frameAgeMs: null }), 0)).toMatchObject({ phase: 'none', chipKey: 'mirror.chipLost', message: 'mirror.noSource' });
  });

  it('draws live while frames are younger than 3 s', () => {
    expect(at(answer(), 0)).toMatchObject({ phase: 'live', chip: 'RX', tone: 'good', live: true, message: null, mode: 'rx', frameAgeMs: 150 });
    expect(at(answer(), 2_850)).toMatchObject({ phase: 'live', frameAgeMs: 3_000 });
  });

  it('turns STALE once the last frame is older than 3 s, counting on from the answer', () => {
    const view = at(answer(), 2_851);
    expect(view).toMatchObject({ phase: 'stale', chip: 'STALE', tone: 'warn', live: false, message: 'mirror.frameStale', frameAgeMs: 3_001 });
    expect(at(answer({ frameAgeMs: 3_500 }), 0)).toMatchObject({ phase: 'stale', messageAgeMs: 3_500 });
    expect(at(answer({ frame: null, frameAgeMs: null }), 0)).toMatchObject({ phase: 'stale', message: 'mirror.noFrame' });
    // A hidden groundstation page sends no frames; the view says so.
    const fixture = readFixture();
    expect(at(answer({ frameAgeMs: 5_000, source: { ...fixture.source, visible: false } }), 0)).toMatchObject({ phase: 'stale', message: 'mirror.kioskHidden' });
  });

  it('turns SOURCE LOST / SUMBER PUTUS after 10 s without a post, also when the console stops answering', () => {
    expect(at(answer(), 9_900)).toMatchObject({ phase: 'stale' });
    expect(at(answer(), 9_901)).toMatchObject({ phase: 'lost', chipKey: 'mirror.chipLost', tone: 'bad', message: 'mirror.sourceLost', messageAgeMs: 10_001, live: false });
    expect(at(answer(), 9_901, true)).toMatchObject({ phase: 'lost' });
    expect(at(answer({ sourceAgeMs: 12_000 }), 0)).toMatchObject({ phase: 'lost', sourceAgeMs: 12_000 });
  });

  it('shows a stopped radio without calling it stale', () => {
    expect(at(answer({ frameAgeMs: 60_000 }, { running: false }), 0)).toMatchObject({ phase: 'stopped', chip: 'RX OFF', tone: 'neutral', message: null, live: false });
    expect(at(answer({}, { running: false, connected: false }), 0)).toMatchObject({ message: 'mirror.notConnected' });
    expect(at(answer({}, { running: false, error: 'USB_LOST' }), 0)).toMatchObject({ tone: 'bad', message: 'spectrum.usbLost' });
  });

  it('follows a scan: live SCAN, … while it starts or stops, SCAN OFF after', () => {
    const fixture = readFixture();
    const sweepFrame = { ...(fixture.frame as MirrorFrame), kind: 'sweep' as const };
    const scan = (phase: 'starting' | 'active' | 'stopping') => answer({ frame: sweepFrame }, { busy: 'sweep', running: false, scan: { phase, start_hz: 400_000_000, stop_hz: 500_000_000, resolution_hz: 4882.8125 } });
    expect(at(scan('active'), 0)).toMatchObject({ phase: 'live', chip: 'SCAN', mode: 'sweep', live: true });
    expect(at(scan('starting'), 0)).toMatchObject({ phase: 'changing', chip: '…', message: 'spectrum.sweepStarting' });
    expect(at(scan('stopping'), 0)).toMatchObject({ phase: 'changing', message: 'spectrum.sweepStopping' });
    // An RX frame while the Receiver scans is not this mode's frame.
    expect(at(answer({}, { busy: 'sweep', scan: { phase: 'active', start_hz: 1, stop_hz: 2, resolution_hz: null } }), 0)).toMatchObject({ phase: 'stale', message: 'mirror.noFrame' });
    expect(at(answer({}, { busy: 'scan-listen' }), 0)).toMatchObject({ phase: 'live', chip: 'BUSY', tone: 'warn', message: 'spectrum.scanListenBusy' });
    // #15 review: once the scan stopped the bridge reports busy 'none'; the
    // last frame is the scan's, so the mirror stays in Spektrum with SCAN OFF.
    const stopped = answer({ frame: sweepFrame, frameAgeMs: 60_000 }, { busy: 'none', running: false, scan: { phase: 'idle', start_hz: 400_000_000, stop_hz: 500_000_000, resolution_hz: 4882.8125 } });
    expect(at(stopped, 0)).toMatchObject({ phase: 'stopped', chip: 'SCAN OFF', mode: 'sweep', tone: 'neutral', live: false, stoppable: false, message: null });
    // An RX frame, no frame, or RX running again: RX.
    expect(at(answer({ frameAgeMs: 60_000 }, { busy: 'none', running: false }), 0)).toMatchObject({ chip: 'RX OFF', mode: 'rx' });
    expect(at(answer({ frame: null }, { busy: 'none', running: false }), 0)).toMatchObject({ chip: 'RX OFF', mode: 'rx' });
    expect(at(answer({ frame: sweepFrame }, { busy: 'none', running: true }), 0)).toMatchObject({ phase: 'stale', mode: 'rx', message: 'mirror.noFrame' });
    // A lost source after a scan keeps the scan's mode for the dimmed trace.
    expect(at(stopped, 20_000)).toMatchObject({ phase: 'lost', mode: 'sweep', stoppable: false });
  });

  it('shows Stop from the last state, as the groundstation dock does, also while STALE or the source is lost', () => {
    const fixture = readFixture();
    const sweepFrame = { ...(fixture.frame as MirrorFrame), kind: 'sweep' as const };
    const scan = (phase: 'starting' | 'active' | 'stopping') => answer({ frame: sweepFrame }, { busy: 'sweep', running: false, scan: { phase, start_hz: 400_000_000, stop_hz: 500_000_000, resolution_hz: 4882.8125 } });
    for (const [elapsed, phase] of [[0, 'live'], [5_000, 'stale'], [20_000, 'lost']] as const) {
      expect(at(scan('active'), elapsed)).toMatchObject({ phase, mode: 'sweep', stoppable: true });
      expect(at(answer(), elapsed)).toMatchObject({ phase, mode: 'rx', stoppable: true });
    }
    // A scan that starts can be stopped; one that stops cannot (the dock's DockView.stoppable).
    expect(at(scan('starting'), 0)).toMatchObject({ phase: 'changing', stoppable: true });
    expect(at(scan('starting'), 20_000)).toMatchObject({ phase: 'lost', stoppable: true });
    expect(at(scan('stopping'), 0)).toMatchObject({ phase: 'changing', stoppable: false });
    // A scan listen on the Receiver page: BUSY, the radio is not the dock's to stop.
    expect(at(answer({}, { busy: 'scan-listen' }), 0)).toMatchObject({ chip: 'BUSY', stoppable: false });
    expect(at(answer({}, { running: false }), 0)).toMatchObject({ phase: 'stopped', mode: 'rx', stoppable: false });
    expect(at(answer({}, { running: false }), 20_000)).toMatchObject({ phase: 'lost', stoppable: false });
    expect(at(null, 0)).toMatchObject({ phase: 'connecting', stoppable: false });
    expect(at(null, 0, true)).toMatchObject({ phase: 'lost', stoppable: false });
    expect(at(answer({ source: null, state: null, frame: null }), 0)).toMatchObject({ phase: 'none', stoppable: false });
  });
});
