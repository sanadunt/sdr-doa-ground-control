import { describe, expect, it } from 'vitest';
import {
  BUSY_RETRY_MS,
  CAPTURE_MS,
  CHUNK_SAMPLES,
  MAX_BUFFER_S,
  MIRROR_AUDIO_LIMITS,
  RETRY_MS,
  SILENT_AFTER_MS,
  STREAM_IDLE_MS,
  TARGET_BUFFER_S,
  createChunkReader,
  createDecimator,
  createMirrorAudioPlayer,
  createMirrorAudioPublisher,
  encodeAudioChunk,
  estimateLatencyMs,
  floatToPcm16,
  scheduleChunk,
} from './receiverMirrorAudio';
import type { AudioContextLike, AudioPostAnswer, MirrorAudioPlayerEnvironment, StreamAnswer } from './receiverMirrorAudio';
import type { ReceiverBridge, SubscriptionOwner } from './receiverBridge';
import type { ReceiverAudio } from './receiverBridgeProtocol';

const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };

function tone(hz: number, count: number, start = 0, rate = 48_000, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index++) samples[index] = amplitude * Math.sin((2 * Math.PI * hz * (start + index)) / rate);
  return samples;
}

function rms(samples: Float32Array, skip = 0): number {
  let sum = 0;
  for (let index = skip; index < samples.length; index++) sum += samples[index] * samples[index];
  return Math.sqrt(sum / (samples.length - skip));
}

describe('audio chunk format', () => {
  it('encodes the 20-byte header the server parses, then Int16 little-endian', () => {
    const bytes = encodeAudioChunk(7, MIRROR_AUDIO_LIMITS.flagGap, Int16Array.from([1, -2, 32767]));
    expect(bytes.length).toBe(MIRROR_AUDIO_LIMITS.headerBytes + 6);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('SDRA');
    const view = new DataView(bytes.buffer);
    expect([view.getUint8(4), view.getUint8(5), view.getUint16(6, true), view.getUint32(8, true), view.getUint32(12, true), view.getUint32(16, true)])
      .toEqual([1, 1, 0, 7, 16_000, 6]);
    expect([view.getInt16(20, true), view.getInt16(22, true), view.getInt16(24, true)]).toEqual([1, -2, 32767]);
  });

  it('turns floats into PCM, clamped, with non-finite samples as silence', () => {
    expect([...floatToPcm16(Float32Array.from([0, 1, -1, 2, -2, Number.NaN, 0.5]))]).toEqual([0, 32767, -32768, 32767, -32768, 0, 16384]);
  });

  it('reads chunks however the stream splits them, keepalives included', () => {
    const first = encodeAudioChunk(1, 0, Int16Array.from([16384, -16384]));
    const keepalive = encodeAudioChunk(0, 0, new Int16Array(0));
    const second = encodeAudioChunk(2, MIRROR_AUDIO_LIMITS.flagGap, Int16Array.from([8192]));
    const all = new Uint8Array([...first, ...keepalive, ...second]);
    for (const split of [1, 3, 7, 21, all.length]) {
      const reader = createChunkReader();
      const chunks = [];
      for (let offset = 0; offset < all.length; offset += split) chunks.push(...reader.push(all.slice(offset, offset + split)));
      expect(chunks.map((chunk) => [chunk.seq, chunk.flags, [...chunk.samples]])).toEqual([[1, 0, [0.5, -0.5]], [0, 0, []], [2, 1, [0.25]]]);
    }
  });

  it('refuses a stream that is not the console\'s', () => {
    expect(() => createChunkReader().push(new TextEncoder().encode('<!doctype html><html>…'))).toThrow();
    const wrongRate = encodeAudioChunk(1, 0, new Int16Array(4));
    new DataView(wrongRate.buffer).setUint32(12, 48_000, true);
    expect(() => createChunkReader().push(wrongRate)).toThrow();
  });
});

describe('48 to 16 kHz', () => {
  it('keeps speech frequencies, removes what would fold back, and gives a third of the samples', () => {
    const passed = createDecimator().process(tone(1000, 4800));
    expect(passed.length).toBe(1600);
    expect(rms(passed, 40) / rms(tone(1000, 4800))).toBeGreaterThan(0.95);
    const stopped = createDecimator().process(tone(12_000, 4800));
    expect(rms(stopped, 40) / rms(tone(12_000, 4800))).toBeLessThan(0.05);
  });

  it('gives the same samples in pieces as in one go', () => {
    const input = tone(2500, 9600);
    const whole = createDecimator().process(input);
    const pieces = createDecimator();
    const parts = [pieces.process(input.subarray(0, 786)), pieces.process(input.subarray(786, 4801)), pieces.process(input.subarray(4801))];
    const joined = Float32Array.from(parts.flatMap((part) => [...part]));
    expect(joined.length).toBe(whole.length);
    for (let index = 0; index < whole.length; index++) expect(joined[index]).toBeCloseTo(whole[index], 6);
  });
});

function fakeBridge() {
  const audioListeners = new Set<(audio: ReceiverAudio) => void>();
  const subscriptions: Array<{ owner: SubscriptionOwner | undefined; spectrum: boolean; audio?: boolean }> = [];
  const bridge = {
    onAudio: (listener: (audio: ReceiverAudio) => void) => { audioListeners.add(listener); return () => { audioListeners.delete(listener); }; },
    subscribe: (options: { spectrum: boolean; audio?: boolean }, owner?: SubscriptionOwner) => { subscriptions.push({ owner, ...options }); },
  } as unknown as ReceiverBridge;
  let seq = 0;
  const feed = (count: number, gap = false) => {
    for (let index = 0; index < count; index++) {
      const audio = { seq: ++seq, sampleRateHz: 48_000, gap: gap && index === 0, samples: new Float32Array(4800).fill(0.25) };
      for (const listener of [...audioListeners]) listener(audio);
    }
  };
  return { bridge, subscriptions, feed, listeners: () => audioListeners.size };
}

describe('audio publisher (groundstation)', () => {
  function setup() {
    const fake = fakeBridge();
    const posts: Array<{ seq: number; flags: number; length: number; source: string }> = [];
    const answers: AudioPostAnswer[] = [];
    let hold: ((answer: AudioPostAnswer) => void) | null = null;
    let holding = false;
    const publisher = createMirrorAudioPublisher(fake.bridge, {
      post: (body, source) => {
        const view = new DataView(body.buffer);
        posts.push({ seq: view.getUint32(8, true), flags: view.getUint8(5), length: view.getUint32(16, true), source });
        if (holding) return new Promise((resolve) => { hold = resolve; });
        return Promise.resolve(answers.shift() ?? { status: 200, code: null, listeners: 1 });
      },
    });
    return {
      ...fake, publisher, posts, answers,
      hold: (value: boolean) => { holding = value; },
      release: (answer: AudioPostAnswer = { status: 200, code: null, listeners: 1 }) => { const current = hold; hold = null; current?.(answer); },
    };
  }

  it('taps the Receiver only while somebody listens and posts 200 ms chunks for its source', async () => {
    const h = setup();
    h.feed(4);
    expect(h.posts).toEqual([]);
    expect(h.subscriptions).toEqual([]);
    h.publisher.setListeners(1, 'kiosk-test-0001');
    expect(h.subscriptions.at(-1)).toEqual({ owner: 'mirror-audio', spectrum: false, audio: true });
    // Two 100 ms messages make one 200 ms chunk of 3200 samples.
    h.feed(4);
    await settle();
    expect(h.posts).toEqual([
      { seq: 1, flags: MIRROR_AUDIO_LIMITS.flagGap, length: CHUNK_SAMPLES * 2, source: 'kiosk-test-0001' },
      { seq: 2, flags: 0, length: CHUNK_SAMPLES * 2, source: 'kiosk-test-0001' },
    ]);
    h.publisher.setListeners(0, 'kiosk-test-0001');
    expect(h.subscriptions.at(-1)).toEqual({ owner: 'mirror-audio', spectrum: false, audio: false });
    h.feed(4);
    await settle();
    expect(h.posts).toHaveLength(2);
    expect(h.publisher.status()).toMatchObject({ tapping: false, chunks: 2 });
  });

  it('sends one at a time and drops the oldest waiting chunk, marking the gap', async () => {
    const h = setup();
    h.publisher.setListeners(1, 'kiosk-test-0001');
    h.hold(true);
    h.feed(8); // four chunks: one in flight, two wait, one dropped
    await settle();
    expect(h.posts.map((post) => post.seq)).toEqual([1]);
    h.hold(false);
    h.release();
    await settle();
    expect(h.posts.map((post) => [post.seq, post.flags])).toEqual([[1, 1], [3, 1], [4, 0]]);
    expect(h.publisher.status().dropped).toBe(1);
  });

  it('stops on a 409 or a count of 0, and marks the chunk after a gap or a refusal', async () => {
    const h = setup();
    h.publisher.setListeners(2, 'kiosk-test-0001');
    h.answers.push({ status: 429, code: 'MIRROR_RATE_LIMITED', listeners: null });
    h.feed(4);
    await settle();
    expect(h.posts.map((post) => post.flags)).toEqual([1, 1]);
    h.feed(2, true);
    await settle();
    expect(h.posts.at(-1)?.flags).toBe(1);
    h.answers.push({ status: 409, code: 'MIRROR_NO_SOURCE', listeners: null });
    h.feed(2);
    await settle();
    expect(h.publisher.status().tapping).toBe(false);
    h.publisher.setListeners(1, 'kiosk-test-0001');
    h.answers.push({ status: 200, code: null, listeners: 0 });
    h.feed(2);
    await settle();
    expect(h.publisher.status().tapping).toBe(false);
    h.publisher.stop();
    expect(h.listeners()).toBe(0);
  });
});

describe('player scheduling', () => {
  it('starts a buffer ahead, plays back to back, and drops what would lag more than a second', () => {
    expect(scheduleChunk(0, 10, 0.2)).toEqual({ startAt: 10 + TARGET_BUFFER_S, nextTime: 10 + TARGET_BUFFER_S + 0.2 });
    const slot = scheduleChunk(10.45, 10.2, 0.2);
    expect(slot.startAt).toBe(10.45);
    expect(slot.nextTime).toBeCloseTo(10.65);
    // An empty buffer starts again a buffer ahead.
    expect(scheduleChunk(10.0, 10.5, 0.2).startAt).toBeCloseTo(10.5 + TARGET_BUFFER_S);
    expect(scheduleChunk(10 + MAX_BUFFER_S + 0.01, 10, 0.2)).toEqual({ startAt: null, nextTime: 10 + MAX_BUFFER_S + 0.01 });
  });

  it('estimates the latency from the capture, the buffer and the output', () => {
    expect(estimateLatencyMs(10.45, 10, 0.02)).toBe(CAPTURE_MS + 450 + 20);
    expect(estimateLatencyMs(9, 10, 0)).toBe(CAPTURE_MS);
  });
});

function fakeContext(state = 'running') {
  const started: number[] = [];
  const context = {
    state,
    currentTime: 0,
    outputLatency: 0.02,
    destination: {},
    resumes: 0,
    resume() { this.resumes += 1; return Promise.resolve(); },
    createBuffer: (_channels: number, length: number, sampleRate: number) => {
      const data = new Float32Array(length);
      return { getChannelData: () => data, duration: length / sampleRate };
    },
    createBufferSource: () => ({ buffer: null, onended: null, connect: () => undefined, disconnect: () => undefined, start: (when: number) => { started.push(when); } }),
  };
  return { context, started };
}

function playerHarness(options: { context?: AudioContextLike | null } = {}) {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const fake = fakeContext();
  const context = options.context === undefined ? fake.context : options.context;
  const answers: Array<StreamAnswer | Error> = [];
  const opened: AbortSignal[] = [];
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const env: MirrorAudioPlayerEnvironment = {
    createContext: () => context,
    openStream: (signal) => {
      opened.push(signal);
      const next = answers.shift();
      if (next instanceof Error) return Promise.reject(next);
      if (next) return Promise.resolve(next);
      const body = new ReadableStream<Uint8Array>({ start: (controller) => { controllerRef = controller; } });
      signal.addEventListener('abort', () => { try { controllerRef?.error(new Error('aborted')); } catch { /* closed */ } });
      return Promise.resolve({ status: 200, code: null, body });
    },
    now: () => now,
    setTimeout: (callback, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { due: now + ms, callback });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => { timers.delete(handle as unknown as number); },
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    await settle();
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      now = Math.max(now, next[1].due);
      timers.delete(next[0]);
      next[1].callback();
      await settle();
    }
    now = end;
    await settle();
  };
  const push = async (bytes: Uint8Array) => { controllerRef?.enqueue(bytes); await settle(); };
  const end = async () => { controllerRef?.close(); await settle(); };
  return { env, fake, answers, opened, advance, push, end, setNow: (value: number) => { now = value; } };
}

const audioChunk = (seq: number) => encodeAudioChunk(seq, 0, new Int16Array(CHUNK_SAMPLES).fill(1000));
const keepalive = () => encodeAudioChunk(0, 0, new Int16Array(0));

describe('audio player (LAN view)', () => {
  it('connects on start, plays each chunk a buffer ahead and shows the latency', async () => {
    const h = playerHarness();
    const player = createMirrorAudioPlayer(h.env);
    expect(player.getState().status).toBe('off');
    player.start();
    expect(h.fake.context.resumes).toBe(1);
    expect(player.getState().status).toBe('connecting');
    await settle();
    expect(player.getState().status).toBe('buffering');
    await h.push(audioChunk(1));
    await h.push(audioChunk(2));
    expect(h.fake.started).toEqual([TARGET_BUFFER_S, TARGET_BUFFER_S + 0.2]);
    expect(player.getState()).toEqual({ status: 'playing', latencyMs: CAPTURE_MS + 650 + 20, code: null });
    player.stop();
    expect(player.getState()).toEqual({ status: 'off', latencyMs: null, code: null });
    expect(h.opened[0].aborted).toBe(true);
  });

  it('says silent after two seconds of keepalives only', async () => {
    const h = playerHarness();
    const player = createMirrorAudioPlayer(h.env);
    player.start();
    await settle();
    await h.advance(1000);
    await h.push(keepalive());
    expect(player.getState().status).toBe('buffering');
    await h.advance(SILENT_AFTER_MS - 1000);
    await h.push(keepalive());
    expect(player.getState().status).toBe('silent');
    await h.push(audioChunk(1));
    expect(player.getState().status).toBe('playing');
  });

  it('opens the stream again after it ends, and waits longer when the listeners are full', async () => {
    const h = playerHarness();
    const player = createMirrorAudioPlayer(h.env);
    player.start();
    await settle();
    await h.end();
    expect(player.getState().status).toBe('retrying');
    h.answers.push({ status: 429, code: 'MIRROR_AUDIO_BUSY', body: null });
    await h.advance(RETRY_MS);
    expect(player.getState()).toMatchObject({ status: 'busy', code: 'MIRROR_AUDIO_BUSY' });
    expect(h.opened).toHaveLength(2);
    await h.advance(BUSY_RETRY_MS - 1);
    expect(h.opened).toHaveLength(2);
    await h.advance(1);
    expect(h.opened).toHaveLength(3);
    expect(player.getState().status).toBe('buffering');
  });

  it('opens again when nothing arrives at all, or the console refuses', async () => {
    const h = playerHarness();
    const player = createMirrorAudioPlayer(h.env);
    h.answers.push({ status: 409, code: 'MIRROR_NO_SOURCE', body: null });
    player.start();
    await settle();
    expect(player.getState()).toMatchObject({ status: 'retrying', code: 'MIRROR_NO_SOURCE' });
    await h.advance(RETRY_MS);
    expect(player.getState().status).toBe('buffering');
    await h.advance(STREAM_IDLE_MS);
    expect(player.getState().status).toBe('retrying');
    expect(h.opened[1].aborted).toBe(true);
  });

  it('names a browser that holds the audio, and one that cannot play it', async () => {
    const held = fakeContext('suspended');
    const h = playerHarness({ context: held.context });
    const player = createMirrorAudioPlayer(h.env);
    player.start();
    await settle();
    expect(player.getState().status).toBe('blocked');
    player.start();
    expect(held.context.resumes).toBe(2);
    const none = createMirrorAudioPlayer(playerHarness({ context: null }).env);
    none.start();
    expect(none.getState().status).toBe('unsupported');
  });
});
