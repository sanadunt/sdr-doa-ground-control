import { describe, expect, it } from 'vitest';
import { createReceiverBridge, consoleRequestsMockSdr, RECEIVER_BUILD_PROBE_URL } from './receiverBridge';
import type { BridgeEnvironment, BridgeHostWindow, BridgeResult } from './receiverBridge';
import {
  BRIDGE_CHANNEL,
  BRIDGE_VERSION,
  COMMAND_TIMEOUT_MS,
  CONSOLE_MESSAGE_TYPES,
  FRAME_MESSAGE_TYPES,
  HELLO_TIMEOUT_MS,
  LISTEN_MODES,
  MAX_QUEUED_COMMANDS,
  RESULT_CODES,
  START_TIMEOUT_MS,
  STATUS_ERROR_CODES,
  SUBSCRIBE_LIMITS,
  clampSubscription,
  commandMessage,
  parseFrameMessage,
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
    ...overrides,
  };
}

describe('receiver bridge protocol', () => {
  it('matches the frame-side constants', () => {
    expect(BRIDGE_CHANNEL).toBe('sdr-console-receiver');
    expect(BRIDGE_VERSION).toBe(1);
    expect([...FRAME_MESSAGE_TYPES]).toEqual(['receiver:hello', 'receiver:status', 'receiver:spectrum', 'receiver:result']);
    expect([...CONSOLE_MESSAGE_TYPES]).toEqual(['console:hello', 'console:subscribe', 'console:start', 'console:stop', 'console:tune', 'console:vfo', 'console:listen']);
    expect([...LISTEN_MODES]).toEqual(['nfm', 'wfm', 'am', 'usb', 'lsb', 'dsb', 'cw', 'raw']);
    expect([...RESULT_CODES]).toEqual(['OK', 'NOT_READY', 'INVALID_COMMAND', 'NO_WEBUSB', 'NEEDS_PAIRING', 'NEEDS_DEVICE_CHOICE', 'MOCK_UNAVAILABLE', 'CONNECT_FAILED', 'SWEEP_BUSY', 'RX_NOT_RUNNING', 'OUT_OF_RANGE', 'AUDIO_BLOCKED', 'TIMEOUT']);
    expect([...STATUS_ERROR_CODES]).toEqual(['USB_LOST', 'RX_ERROR', 'NO_WEBUSB']);
    expect(SUBSCRIBE_LIMITS).toEqual({ binsMin: 64, binsMax: 2048, binsDefault: 512, fpsMin: 1, fpsMax: 15, fpsDefault: 10, spanMinHz: 100_000, spanDefaultHz: 2_000_000 });
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
  });
});

describe('createReceiverBridge', () => {
  it('starts idle without touching any window', () => {
    const bridge = createReceiverBridge({ host: () => { throw new Error('window used'); }, setTimeout, clearTimeout, probe: () => Promise.resolve(200), random: Math.random });
    expect(bridge.getState()).toEqual({ phase: 'idle', build: 'unknown', hello: null, status: null, lastResult: null });
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

  it('times out a start after 20 s and other commands after 8 s', async () => {
    const h = harness();
    h.bridge.attach(h.frame);
    h.fromFrame('receiver:hello', hello);
    const start = h.bridge.send({ type: 'console:start', mock: false, listen: false });
    const stop = h.bridge.send({ type: 'console:stop' });
    h.advance(COMMAND_TIMEOUT_MS);
    await expect(stop).resolves.toEqual({ ok: false, code: 'TIMEOUT' });
    h.advance(START_TIMEOUT_MS - COMMAND_TIMEOUT_MS);
    await expect(start).resolves.toEqual({ ok: false, code: 'TIMEOUT' });
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
