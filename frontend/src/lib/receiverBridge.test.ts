import { describe, expect, it } from 'vitest';
import { createReceiverBridge, consoleRequestsMockSdr, mergeTuneView, RECEIVER_BUILD_PROBE_URL } from './receiverBridge';
import type { BridgeEnvironment, BridgeHostWindow, BridgeResult, TuneView } from './receiverBridge';
import {
  BRIDGE_CHANNEL,
  BRIDGE_VERSION,
  COMMAND_TIMEOUT_MS,
  CONSOLE_MESSAGE_TYPES,
  DISPLAY_DB_LIMITS,
  FRAME_MESSAGE_TYPES,
  GAIN_LIMITS,
  HELLO_TIMEOUT_MS,
  LONG_COMMAND_TYPES,
  LISTEN_MODES,
  MAX_QUEUED_COMMANDS,
  RESULT_CODES,
  SAMPLE_RATES_HZ,
  START_TIMEOUT_MS,
  STATUS_ERROR_CODES,
  SUBSCRIBE_LIMITS,
  SWEEP_LIMITS,
  TUNE_LIMITS,
  TUNE_SOURCES,
  clampDisplayRange,
  clampSubscription,
  commandMessage,
  gainSteps,
  normalizeTuneStamp,
  parseFrameMessage,
  snapGain,
} from './receiverBridgeProtocol';

const ORIGIN = 'http://127.0.0.1:8787';

type Listener = (event: { origin: string; source: unknown; data: unknown }) => void;

function harness(options: { probe?: (url: string) => Promise<number> } = {}) {
  const listeners = new Set<Listener>();
  const host: BridgeHostWindow = {
    location: { origin: ORIGIN },
    addEventListener: (_type, listener) => { listeners.add(listener as Listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener as Listener); },
  };
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const probes: string[] = [];
  const env: BridgeEnvironment = {
    host: () => host,
    setTimeout: (callback, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { due: now + ms, callback });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => { timers.delete(handle as unknown as number); },
    probe: (url) => { probes.push(url); return options.probe ? options.probe(url) : Promise.resolve(200); },
    random: () => 0.5,
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [handle, timer] of [...timers.entries()].sort((a, b) => a[1].due - b[1].due)) {
      if (timer.due <= now && timers.has(handle)) {
        timers.delete(handle);
        timer.callback();
      }
    }
  };
  const posted: Array<{ message: Record<string, unknown>; origin: string }> = [];
  const frame = { postMessage: (message: unknown, origin: string) => { posted.push({ message: message as Record<string, unknown>, origin }); } };
  const deliver = (data: unknown, source: unknown = frame, origin = ORIGIN) => {
    for (const listener of [...listeners]) listener({ origin, source, data });
  };
  const fromFrame = (type: string, payload: Record<string, unknown> = {}) => deliver({ ch: BRIDGE_CHANNEL, v: BRIDGE_VERSION, type, ...payload });
  const bridge = createReceiverBridge(env);
  return { bridge, frame, posted, deliver, fromFrame, advance, listeners, probes };
}

const hello = { protocol: 1, mockAvailable: true, webusb: true };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 1,
    tMs: 0,
    webusb: true,
    mockAvailable: true,
    pairedCount: 1,
    connected: true,
    mock: false,
    deviceName: 'RadioSpectrum One',
    running: true,
    busy: 'none',
    workspace: 'listener',
    centerHz: 433_920_000,
    sampleRateHz: 20_000_000,
    frequencyShiftHz: 0,
    gains: { lnaDb: 40, vgaDb: 20, amp: false },
    vfo: { index: 0, enabled: true, mode: 'nfm', frequencyHz: 433_920_000, bandwidthHz: 12_500, squelchEnabled: false, squelchDb: -100, volume: 50 },
    squelchOpen: true,
    audio: 'running',
    recording: false,
    error: null,
    notice: null,
    tune: { rev: 1, by: 'receiver', id: null, receiverRev: 1 },
    ...overrides,
  };
}

describe('receiver bridge protocol', () => {
  it('matches the frame-side constants', () => {
    expect(BRIDGE_CHANNEL).toBe('sdr-console-receiver');
    expect(BRIDGE_VERSION).toBe(1);
    expect([...FRAME_MESSAGE_TYPES]).toEqual(['receiver:hello', 'receiver:status', 'receiver:spectrum', 'receiver:result']);
    expect([...CONSOLE_MESSAGE_TYPES]).toEqual(['console:hello', 'console:subscribe', 'console:start', 'console:stop', 'console:tune', 'console:vfo', 'console:listen', 'console:display', 'console:gains', 'console:radio']);
    expect([...LISTEN_MODES]).toEqual(['nfm', 'wfm', 'am', 'usb', 'lsb', 'dsb', 'cw', 'raw']);
    expect([...RESULT_CODES]).toEqual(['OK', 'NOT_READY', 'INVALID_COMMAND', 'NO_WEBUSB', 'NEEDS_PAIRING', 'NEEDS_DEVICE_CHOICE', 'MOCK_UNAVAILABLE', 'CONNECT_FAILED', 'SWEEP_BUSY', 'RX_NOT_RUNNING', 'OUT_OF_RANGE', 'AUDIO_BLOCKED', 'RECORDING_ACTIVE', 'TIMEOUT']);
    expect([...STATUS_ERROR_CODES]).toEqual(['USB_LOST', 'RX_ERROR', 'NO_WEBUSB']);
    expect(SUBSCRIBE_LIMITS).toEqual({ binsMin: 64, binsMax: 2048, binsDefault: 512, fpsMin: 1, fpsMax: 15, fpsDefault: 10, spanMinHz: 100_000, spanDefaultHz: 2_000_000 });
    expect([...TUNE_SOURCES]).toEqual(['console', 'receiver']);
    expect(TUNE_LIMITS).toEqual({ minHz: 1_000_000, maxHz: 6_000_000_000 });
    // Scans and Receiver markers reach 7.25 GHz; RX tuning stops at 6 GHz.
    expect(SWEEP_LIMITS).toEqual({ minHz: 1_000_000, maxHz: 7_250_000_000 });
    expect(DISPLAY_DB_LIMITS).toEqual({ minDb: -160, maxDb: 60, minGapDb: 5 });
    expect([...SAMPLE_RATES_HZ]).toEqual([2_000_000, 4_000_000, 5_000_000, 8_000_000, 10_000_000, 16_000_000, 20_000_000]);
    expect(GAIN_LIMITS).toEqual({ lna: { min: 0, max: 40, step: 8 }, vga: { min: 0, max: 62, step: 2 } });
    expect([...LONG_COMMAND_TYPES]).toEqual(['console:start', 'console:radio']);
  });

  it('snaps gains to their step inside the limits and lists every step', () => {
    expect(snapGain('lna', 24)).toBe(24);
    expect(snapGain('lna', 27)).toBe(24);
    expect(snapGain('lna', 29)).toBe(32);
    expect(snapGain('lna', -3)).toBe(0);
    expect(snapGain('lna', 99)).toBe(40);
    expect(snapGain('vga', 31)).toBe(32);
    expect(snapGain('vga', 63)).toBe(62);
    expect(snapGain('vga', Number.NaN)).toBeNull();
    expect(snapGain('vga', '20')).toBeNull();
    expect(gainSteps('lna')).toEqual([0, 8, 16, 24, 32, 40]);
    expect(gainSteps('vga')).toHaveLength(32);
    expect(gainSteps('vga').at(-1)).toBe(62);
  });

  it('reads the device sample rates of a status and drops anything that is not a rate', () => {
    const rates = (value: unknown) => {
      const parsed = parseFrameMessage({ ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:status', ...status({ sampleRatesHz: value }) });
      return parsed?.type === 'receiver:status' ? parsed.status.sampleRatesHz : 'unparsed';
    };
    expect(rates([2_000_000, 20_000_000])).toEqual([2_000_000, 20_000_000]);
    expect(rates(undefined)).toEqual([]);
    expect(rates('2000000')).toEqual([]);
    expect(rates([2_000_000, 2_000_000, -4, 2.5, '8000000', null, 10_000_000])).toEqual([2_000_000, 10_000_000]);
    expect(rates(Array.from({ length: 40 }, (_value, index) => (index + 1) * 1_000_000))).toHaveLength(16);
  });

  it('keeps a manual dB range inside the graph limits, minimum first', () => {
    expect(clampDisplayRange(-90, -20)).toEqual({ minDb: -90, maxDb: -20 });
    expect(clampDisplayRange(-200, 100)).toEqual({ minDb: -160, maxDb: 60 });
    expect(clampDisplayRange(-20, -90)).toEqual({ minDb: -20, maxDb: -15 });
    expect(clampDisplayRange(-40.04, -38)).toEqual({ minDb: -40, maxDb: -35 });
    expect(clampDisplayRange(Number.NaN, 0)).toBeNull();
    expect(clampDisplayRange('-90', -20)).toBeNull();
  });

  it('reads the RX dB scale of a status and treats a missing or malformed one as unknown', () => {
    const display = (value: unknown) => {
      const parsed = parseFrameMessage({ ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:status', ...status({ display: value }) });
      return parsed?.type === 'receiver:status' ? parsed.status.display : 'not parsed';
    };
    expect(display({ auto: false, minDb: -90, maxDb: -20 })).toEqual({ auto: false, minDb: -90, maxDb: -20 });
    expect(display({ auto: true, minDb: -300, maxDb: 300 })).toEqual({ auto: true, minDb: -160, maxDb: 60 });
    expect(display(undefined)).toBeNull();
    expect(display({ auto: 'yes', minDb: -90, maxDb: -20 })).toBeNull();
    expect(display({ auto: false, minDb: -90 })).toBeNull();
  });

  it('parses a tune stamp and refuses an incomplete or inconsistent one', () => {
    expect(normalizeTuneStamp({ rev: 4, by: 'console', id: 'c3-x', receiverRev: 2 })).toEqual({ rev: 4, by: 'console', id: 'c3-x', receiverRev: 2 });
    // A Receiver-page change carries no command id; a bad id is dropped.
    expect(normalizeTuneStamp({ rev: 4, by: 'receiver', id: 'c3-x', receiverRev: 4 })).toEqual({ rev: 4, by: 'receiver', id: null, receiverRev: 4 });
    expect(normalizeTuneStamp({ rev: 4, by: 'console', id: 'bad id', receiverRev: 0 })).toEqual({ rev: 4, by: 'console', id: null, receiverRev: 0 });
    for (const bad of [
      undefined, null, [], 'rev',
      { rev: 4, by: 'operator', id: null, receiverRev: 0 },
      { rev: -1, by: 'receiver', id: null, receiverRev: 0 },
      { rev: 1.5, by: 'receiver', id: null, receiverRev: 0 },
      { rev: 2, by: 'receiver', id: null, receiverRev: 3 },
      { rev: 2, by: 'receiver', id: null },
      { rev: '2', by: 'receiver', id: null, receiverRev: 0 },
    ]) {
      expect(normalizeTuneStamp(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('keeps the tune stamp of a status and treats a missing one as unknown', () => {
    const parse = (overrides: Record<string, unknown>) => {
      const parsed = parseFrameMessage({ ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:status', ...status(overrides) });
      return parsed?.type === 'receiver:status' ? parsed.status : null;
    };
    expect(parse({ tune: { rev: 7, by: 'console', id: 'c9-a', receiverRev: 5 } })?.tune).toEqual({ rev: 7, by: 'console', id: 'c9-a', receiverRev: 5 });
    expect(parse({ tune: undefined })?.tune).toBeNull();
    expect(parse({ tune: { rev: 7, by: 'nobody', receiverRev: 0 } })?.tune).toBeNull();
  });

  it('keeps the tuning a result carries and drops a malformed one', () => {
    const tune = { rev: 3, by: 'console', id: 'c4-a', receiverRev: 1, centerHz: 145_500_000.4, vfoHz: 145_510_000 };
    const parsed = parseFrameMessage({ ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:result', id: 'c4-a', ok: true, code: 'OK', tune });
    expect(parsed).toEqual({ type: 'receiver:result', result: { id: 'c4-a', ok: true, code: 'OK', tune: { ...tune, centerHz: 145_500_000 } } });
    const refused = parseFrameMessage({ ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:result', id: 'c4-b', ok: false, code: 'SWEEP_BUSY', tune: { ...tune, centerHz: Number.NaN, vfoHz: null } });
    expect(refused?.type === 'receiver:result' ? refused.result.tune : undefined).toEqual({ rev: 3, by: 'console', id: 'c4-a', receiverRev: 1, centerHz: null, vfoHz: null });
    const malformed = parseFrameMessage({ ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:result', id: 'c4-c', ok: true, code: 'OK', tune: { rev: -3 } });
    expect(malformed).toEqual({ type: 'receiver:result', result: { id: 'c4-c', ok: true, code: 'OK' } });
  });

  it('clamps subscriptions like the frame', () => {
    expect(clampSubscription({ spectrum: true, bins: 10, fps: 99, spanHz: 5 })).toEqual({ spectrum: true, bins: 64, fps: 15, spanHz: 100_000 });
    expect(clampSubscription({ spectrum: 'yes', bins: Number.NaN })).toEqual({ spectrum: false, bins: 512, fps: 10, spanHz: 2_000_000 });
  });

  it('rejects anything that is not a well-formed frame envelope', () => {
    expect(parseFrameMessage(null)).toBeNull();
    expect(parseFrameMessage({ ch: 'other', v: 1, type: 'receiver:hello', protocol: 1 })).toBeNull();
    expect(parseFrameMessage({ ch: BRIDGE_CHANNEL, v: 2, type: 'receiver:hello', protocol: 1 })).toBeNull();
    expect(parseFrameMessage({ ch: BRIDGE_CHANNEL, v: 1, type: 'console:start', id: 'c1' })).toBeNull();
    expect(parseFrameMessage({ ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:hello', protocol: 2 })).toBeNull();
    expect(parseFrameMessage({ ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:result', id: 'bad id!', ok: true, code: 'OK' })).toBeNull();
    expect(parseFrameMessage({ ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:status', seq: -1 })).toBeNull();
  });

  it('normalizes a status from unknown values', () => {
    const parsed = parseFrameMessage({ ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:status', ...status({ centerHz: 433_920_000.4, busy: 'mystery', audio: 'loud', error: { code: 'NOPE' }, notice: '   ', vfo: { index: -1, enabled: 'yes', mode: 'fm', frequencyHz: Number.POSITIVE_INFINITY, volume: 500 } }) });
    expect(parsed?.type).toBe('receiver:status');
    if (parsed?.type !== 'receiver:status') return;
    expect(parsed.status.centerHz).toBe(433_920_000);
    // An unknown busy state is treated as busy, so the dock never retunes over it.
    expect(parsed.status.busy).toBe('sweep');
    expect(parsed.status.audio).toBe('none');
    expect(parsed.status.error).toBeNull();
    expect(parsed.status.notice).toBeNull();
    expect(parsed.status.vfo).toEqual({ index: 0, enabled: false, mode: null, frequencyHz: null, bandwidthHz: null, squelchEnabled: false, squelchDb: null, volume: null });
  });

  it('copies spectrum bins from any typed array and drops bad frames', () => {
    // A typed array from another realm only needs to pass ArrayBuffer.isView.
    const foreign = new Float64Array([-90, Number.NaN, -40, -80]);
    const parsed = parseFrameMessage({ ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:spectrum', seq: 3, tMs: 1, centerHz: 100e6, startHz: 99e6, stopHz: 101e6, sampleRateHz: 20e6, fftSize: 65536, binCount: 4, bins: foreign });
    expect(parsed?.type).toBe('receiver:spectrum');
    if (parsed?.type !== 'receiver:spectrum') return;
    expect(Array.from(parsed.frame.bins)).toEqual([-90, -200, -40, -80]);
    expect(parsed.frame.bins).not.toBe(foreign);
    const bad = { ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:spectrum', seq: 3, centerHz: 100e6, startHz: 99e6, stopHz: 101e6, sampleRateHz: 20e6, binCount: 4 };
    expect(parseFrameMessage({ ...bad, bins: [1, 2, 3, 4] })).toBeNull();
    expect(parseFrameMessage({ ...bad, bins: new Float32Array(3) })).toBeNull();
    expect(parseFrameMessage({ ...bad, bins: new DataView(new ArrayBuffer(16)) })).toBeNull();
    expect(parseFrameMessage({ ...bad, stopHz: 98e6, bins: new Float32Array(4) })).toBeNull();
  });

  it('builds command messages with only accepted fields', () => {
    expect(commandMessage('c1-a', { type: 'console:start', mock: true, listen: false, mode: 'wfm', centerHz: 433_920_000.6, vfoHz: 12 })).toEqual({
      ch: BRIDGE_CHANNEL, v: 1, type: 'console:start', id: 'c1-a', mock: true, listen: false, mode: 'wfm', centerHz: 433_920_001,
    });
    expect(commandMessage('c2-a', { type: 'console:vfo', volume: 250 })).toEqual({ ch: BRIDGE_CHANNEL, v: 1, type: 'console:vfo', id: 'c2-a', volume: 100 });
    expect(commandMessage('c3-a', { type: 'console:display', auto: true })).toEqual({ ch: BRIDGE_CHANNEL, v: 1, type: 'console:display', id: 'c3-a', auto: true });
    expect(commandMessage('c4-a', { type: 'console:display', auto: false, minDb: -95.04, maxDb: -96 })).toEqual({
      ch: BRIDGE_CHANNEL, v: 1, type: 'console:display', id: 'c4-a', auto: false, minDb: -95, maxDb: -90,
    });
    expect(commandMessage('c5-a', { type: 'console:display', auto: false, minDb: Number.NaN, maxDb: -20 })).toEqual({ ch: BRIDGE_CHANNEL, v: 1, type: 'console:display', id: 'c5-a', auto: false });
    expect(commandMessage('c6-a', { type: 'console:gains', lnaDb: 27, vgaDb: Number.NaN, amp: true })).toEqual({ ch: BRIDGE_CHANNEL, v: 1, type: 'console:gains', id: 'c6-a', lnaDb: 24, amp: true });
    expect(commandMessage('c7-a', { type: 'console:gains', vgaDb: 63 })).toEqual({ ch: BRIDGE_CHANNEL, v: 1, type: 'console:gains', id: 'c7-a', vgaDb: 62 });
    expect(commandMessage('c8-a', { type: 'console:radio', sampleRateHz: 8_000_000.2 })).toEqual({ ch: BRIDGE_CHANNEL, v: 1, type: 'console:radio', id: 'c8-a', sampleRateHz: 8_000_000 });
    expect(commandMessage('c9-a', { type: 'console:radio', sampleRateHz: 8_000_000, confirmRecording: true })).toEqual({
      ch: BRIDGE_CHANNEL, v: 1, type: 'console:radio', id: 'c9-a', sampleRateHz: 8_000_000, confirmRecording: true,
    });
    expect(commandMessage('c10-a', { type: 'console:radio', sampleRateHz: 8_000_000, confirmRecording: false })).not.toHaveProperty('confirmRecording');
  });
});

describe('createReceiverBridge', () => {
  it('starts idle without touching any window', () => {
    const bridge = createReceiverBridge({ host: () => { throw new Error('window used'); }, setTimeout, clearTimeout, probe: () => Promise.resolve(200), random: Math.random });
    expect(bridge.getState()).toEqual({ phase: 'idle', build: 'unknown', hello: null, status: null, tune: null, lastResult: null });
  });

  it('says hello on attach, becomes ready on the frame hello, and re-sends the subscription', () => {
    const h = harness();
    h.bridge.subscribe({ spectrum: true });
    h.bridge.attach(h.frame);
    expect(h.bridge.getState().phase).toBe('connecting');
    expect(h.posted.map((entry) => entry.message.type)).toEqual(['console:hello']);
    expect(h.posted[0].origin).toBe(ORIGIN);
    h.fromFrame('receiver:hello', hello);
    expect(h.bridge.getState().phase).toBe('ready');
    expect(h.bridge.getState().build).toBe('built');
    const subscribe = h.posted.at(-1)?.message;
    expect(subscribe).toMatchObject({ type: 'console:subscribe', spectrum: true, bins: 512, fps: 10, spanHz: 2_000_000 });
    expect(typeof subscribe?.id).toBe('string');
  });

  it('ignores messages from another origin, another window or with a wrong envelope', () => {
    const h = harness();
    h.bridge.attach(h.frame);
    h.deliver({ ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:hello', ...hello }, h.frame, 'http://evil.example');
    h.deliver({ ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:hello', ...hello }, { postMessage: () => undefined });
    h.deliver({ ch: 'sdr-console-receiver-2', v: 1, type: 'receiver:hello', ...hello });
    h.deliver('receiver:hello');
    expect(h.bridge.getState().phase).toBe('connecting');
  });

  it('queues commands before hello, then posts them in order', async () => {
    const h = harness();
    const results: BridgeResult[] = [];
    void h.bridge.send({ type: 'console:start', mock: false, listen: false }).then((result) => results.push(result));
    void h.bridge.send({ type: 'console:listen', enabled: true }).then((result) => results.push(result));
    expect(h.posted).toEqual([]);
    h.bridge.attach(h.frame);
    expect(h.posted.map((entry) => entry.message.type)).toEqual(['console:hello']);
    h.fromFrame('receiver:hello', hello);
    const commands = h.posted.slice(1);
    expect(commands.map((entry) => entry.message.type)).toEqual(['console:start', 'console:listen']);
    h.fromFrame('receiver:result', { id: commands[1].message.id, ok: false, code: 'AUDIO_BLOCKED' });
    h.fromFrame('receiver:result', { id: commands[0].message.id, ok: true, code: 'OK' });
    await flush();
    expect(results).toEqual([{ ok: false, code: 'AUDIO_BLOCKED' }, { ok: true, code: 'OK' }]);
    expect(h.bridge.getState().lastResult).toMatchObject({ type: 'console:start', ok: true, code: 'OK' });
  });

  it('posts synchronously once ready, and routes results by id', async () => {
    const h = harness();
    h.bridge.attach(h.frame);
    h.fromFrame('receiver:hello', hello);
    const before = h.posted.length;
    const pending = h.bridge.send({ type: 'console:tune', centerHz: 433_920_000, vfoHz: 433_925_000 });
    expect(h.posted.length).toBe(before + 1);
    const message = h.posted.at(-1)?.message ?? {};
    expect(message).toMatchObject({ type: 'console:tune', centerHz: 433_920_000, vfoHz: 433_925_000 });
    expect(String(message.id)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    h.fromFrame('receiver:result', { id: 'c999-x', ok: true, code: 'OK' });
    h.fromFrame('receiver:result', { id: message.id, ok: false, code: 'OUT_OF_RANGE', message: 'too far' });
    await expect(pending).resolves.toEqual({ ok: false, code: 'OUT_OF_RANGE', message: 'too far' });
  });

  it('times out a start and a sample rate change after 20 s and other commands after 8 s', async () => {
    const h = harness();
    h.bridge.attach(h.frame);
    h.fromFrame('receiver:hello', hello);
    const start = h.bridge.send({ type: 'console:start', mock: false, listen: false });
    const radio = h.bridge.send({ type: 'console:radio', sampleRateHz: 10_000_000 });
    const stop = h.bridge.send({ type: 'console:stop' });
    const gains = h.bridge.send({ type: 'console:gains', lnaDb: 16 });
    let radioSettled = false;
    void radio.then(() => { radioSettled = true; });
    h.advance(COMMAND_TIMEOUT_MS);
    await expect(stop).resolves.toEqual({ ok: false, code: 'TIMEOUT' });
    await expect(gains).resolves.toEqual({ ok: false, code: 'TIMEOUT' });
    expect(radioSettled).toBe(false);
    h.advance(START_TIMEOUT_MS - COMMAND_TIMEOUT_MS);
    await expect(start).resolves.toEqual({ ok: false, code: 'TIMEOUT' });
    await expect(radio).resolves.toEqual({ ok: false, code: 'TIMEOUT' });
  });

  it('refuses more than 16 queued commands', async () => {
    const h = harness();
    for (let index = 0; index < MAX_QUEUED_COMMANDS; index++) void h.bridge.send({ type: 'console:stop' });
    await expect(h.bridge.send({ type: 'console:stop' })).resolves.toEqual({ ok: false, code: 'NOT_READY' });
  });

  it('marks a frame without hello unresponsive after 8 s, and recovers on a late hello', () => {
    const h = harness();
    h.bridge.attach(h.frame);
    h.advance(HELLO_TIMEOUT_MS);
    expect(h.bridge.getState().phase).toBe('unresponsive');
    h.fromFrame('receiver:hello', hello);
    expect(h.bridge.getState().phase).toBe('ready');
  });

  it('drops results of commands posted to a reloaded document, but keeps the queue across detach', async () => {
    const h = harness();
    h.bridge.attach(h.frame);
    h.fromFrame('receiver:hello', hello);
    const posted = h.bridge.send({ type: 'console:stop' });
    h.bridge.attach(h.frame);
    await expect(posted).resolves.toEqual({ ok: false, code: 'TIMEOUT' });
    h.bridge.detach();
    expect(h.listeners.size).toBe(0);
    expect(h.bridge.getState().phase).toBe('idle');
    const queued = h.bridge.send({ type: 'console:listen', enabled: false });
    h.bridge.attach(h.frame);
    h.fromFrame('receiver:hello', hello);
    const message = h.posted.at(-1)?.message ?? {};
    expect(message.type).toBe('console:listen');
    h.fromFrame('receiver:result', { id: message.id, ok: true, code: 'OK' });
    await expect(queued).resolves.toEqual({ ok: true, code: 'OK' });
  });

  it('keeps only newer statuses and notifies state listeners', () => {
    const h = harness();
    let calls = 0;
    const unsubscribe = h.bridge.onState(() => { calls += 1; });
    h.bridge.attach(h.frame);
    h.fromFrame('receiver:hello', hello);
    h.fromFrame('receiver:status', status({ seq: 5, centerHz: 100_000_000 }));
    h.fromFrame('receiver:status', status({ seq: 4, centerHz: 200_000_000 }));
    expect(h.bridge.getState().status?.centerHz).toBe(100_000_000);
    expect(calls).toBeGreaterThanOrEqual(3);
    unsubscribe();
    const before = calls;
    h.fromFrame('receiver:status', status({ seq: 6 }));
    expect(calls).toBe(before);
  });

  it('keeps the tuning with the highest rev from statuses and results', async () => {
    const h = harness();
    h.bridge.attach(h.frame);
    h.fromFrame('receiver:hello', hello);
    h.fromFrame('receiver:status', status({ seq: 2, centerHz: 100_000_000, vfo: { index: 0, enabled: false, mode: 'nfm', frequencyHz: 100_010_000 }, tune: { rev: 3, by: 'receiver', id: null, receiverRev: 3 } }));
    expect(h.bridge.getState().tune).toEqual({ rev: 3, by: 'receiver', commandId: null, receiverRev: 3, centerHz: 100_000_000, vfoHz: 100_010_000 });

    // A tune result shows before the next status.
    const pending = h.bridge.send({ type: 'console:tune', centerHz: 145_500_000, vfoHz: 145_500_000 });
    const id = String(h.posted.at(-1)?.message.id);
    h.fromFrame('receiver:result', { id, ok: true, code: 'OK', tune: { rev: 4, by: 'console', id, receiverRev: 3, centerHz: 145_500_000, vfoHz: 145_500_000 } });
    await expect(pending).resolves.toEqual({ ok: true, code: 'OK', tune: { rev: 4, by: 'console', id, receiverRev: 3, centerHz: 145_500_000, vfoHz: 145_500_000 } });
    expect(h.bridge.getState().tune).toEqual({ rev: 4, by: 'console', commandId: id, receiverRev: 3, centerHz: 145_500_000, vfoHz: 145_500_000 });
    expect(h.bridge.getState().status?.centerHz).toBe(100_000_000);

    // A status sent before the command does not take the tuning back.
    h.fromFrame('receiver:status', status({ seq: 3, centerHz: 100_000_000, tune: { rev: 3, by: 'receiver', id: null, receiverRev: 3 } }));
    expect(h.bridge.getState().tune?.centerHz).toBe(145_500_000);
    h.fromFrame('receiver:status', status({ seq: 4, centerHz: 150_000_000, vfo: { index: 0, enabled: false, mode: 'nfm', frequencyHz: 150_000_000 }, tune: { rev: 5, by: 'receiver', id: null, receiverRev: 5 } }));
    expect(h.bridge.getState().tune).toMatchObject({ rev: 5, by: 'receiver', receiverRev: 5, centerHz: 150_000_000, vfoHz: 150_000_000 });

    // A status without a stamp (an older frame) keeps the last known tuning; a new document resets it.
    h.fromFrame('receiver:status', status({ seq: 5, tune: undefined }));
    expect(h.bridge.getState().tune?.rev).toBe(5);
    h.bridge.attach(h.frame);
    expect(h.bridge.getState().tune).toBeNull();
    h.fromFrame('receiver:hello', hello);
    h.fromFrame('receiver:status', status({ seq: 1, tune: { rev: 0, by: 'receiver', id: null, receiverRev: 0 } }));
    expect(h.bridge.getState().tune?.rev).toBe(0);
    h.bridge.detach();
    expect(h.bridge.getState().tune).toBeNull();
  });

  it('a refused tune also reports the tuning the Receiver kept', async () => {
    const h = harness();
    h.bridge.attach(h.frame);
    h.fromFrame('receiver:hello', hello);
    h.fromFrame('receiver:status', status({ seq: 2, tune: { rev: 2, by: 'receiver', id: null, receiverRev: 2 } }));
    const pending = h.bridge.send({ type: 'console:tune', centerHz: 145_500_000 });
    const id = String(h.posted.at(-1)?.message.id);
    h.fromFrame('receiver:result', { id, ok: false, code: 'SWEEP_BUSY', tune: { rev: 2, by: 'receiver', id: null, receiverRev: 2, centerHz: 433_920_000, vfoHz: 433_920_000 } });
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'SWEEP_BUSY' });
    expect(h.bridge.getState().tune).toMatchObject({ rev: 2, centerHz: 433_920_000 });
  });

  it('hands spectrum frames to listeners without storing them in state', () => {
    const h = harness();
    const frames: number[] = [];
    h.bridge.onSpectrum((frame) => frames.push(frame.binCount));
    h.bridge.attach(h.frame);
    h.fromFrame('receiver:hello', hello);
    const stateBefore = h.bridge.getState();
    h.fromFrame('receiver:spectrum', { seq: 1, centerHz: 100e6, startHz: 99e6, stopHz: 101e6, sampleRateHz: 20e6, fftSize: 65536, binCount: 64, bins: new Float32Array(64) });
    expect(frames).toEqual([64]);
    expect(h.bridge.getState()).toBe(stateBefore);
  });

  it('probes the Receiver build once', async () => {
    const missing = harness({ probe: () => Promise.resolve(404) });
    missing.bridge.probeBuild();
    missing.bridge.probeBuild();
    await flush();
    expect(missing.probes).toEqual([RECEIVER_BUILD_PROBE_URL]);
    expect(missing.bridge.getState().build).toBe('missing');
    const offline = harness({ probe: () => Promise.reject(new TypeError('offline')) });
    offline.bridge.probeBuild();
    await flush();
    expect(offline.bridge.getState().build).toBe('missing');
    const built = harness();
    built.bridge.probeBuild();
    await flush();
    expect(built.bridge.getState().build).toBe('built');
  });
});

describe('consoleRequestsMockSdr', () => {
  it('needs a loopback host and exactly mock=1', () => {
    expect(consoleRequestsMockSdr({ hostname: '127.0.0.1', search: '?mock=1' })).toBe(true);
    expect(consoleRequestsMockSdr({ hostname: '127.0.0.1', search: '?mock=true' })).toBe(false);
    expect(consoleRequestsMockSdr({ hostname: 'example.com', search: '?mock=1' })).toBe(false);
  });
});

describe('mergeTuneView', () => {
  const view = (overrides: Partial<TuneView> = {}): TuneView => ({ rev: 1, by: 'receiver', commandId: null, receiverRev: 1, centerHz: 100_000_000, vfoHz: 100_000_000, ...overrides });

  it('takes the higher rev and never lowers receiverRev', () => {
    const current = view({ rev: 4, receiverRev: 4 });
    expect(mergeTuneView(null, current)).toBe(current);
    expect(mergeTuneView(current, null)).toBe(current);
    expect(mergeTuneView(current, view({ rev: 3, centerHz: 1 }))).toBe(current);
    expect(mergeTuneView(current, view({ rev: 4 }))).toBe(current);
    const next = view({ rev: 5, by: 'console', commandId: 'c1-a', receiverRev: 4, centerHz: 145_500_000 });
    expect(mergeTuneView(current, next)).toBe(next);
    expect(mergeTuneView(current, view({ rev: 6, receiverRev: 2 }))).toMatchObject({ rev: 6, receiverRev: 4 });
    expect(mergeTuneView(view({ rev: 6, receiverRev: 2 }), view({ rev: 6, receiverRev: 6 }))).toMatchObject({ rev: 6, receiverRev: 6 });
  });
});
