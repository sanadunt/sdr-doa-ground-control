/**
 * The Receiver mirror's audio (phase 5, the owner's decision of 2026-11-02;
 * contract in docs/RECEIVER_MIRROR.md section 10a, server side in
 * tools/receiver_audio_mirror.py).
 *
 * Groundstation page: while the answer to the mirror's POST says LAN viewers
 * listen (`audio_listeners`), the publisher asks the Receiver frame for audio
 * (the bridge's `mirror-audio` owner), turns the 48 kHz mix into 16 kHz 16-bit
 * PCM and posts chunks of CHUNK_SAMPLES (200 ms) to POST
 * /api/mirror/receiver/audio, one at a time.
 *
 * LAN view: one player for the page (mirrorAudioPlayer()), started by the
 * Dengar click (the browser's autoplay rule), reads the GET stream and plays
 * it through Web Audio with a buffer of TARGET_BUFFER_S; once more than
 * CATCH_UP_S is buffered (a stall, a burst, a tab whose audio clock paused in
 * the background) it drops chunks until it is back at TARGET_BUFFER_S.
 *
 * Latency: a chunk holds the 200 ms of audio captured before it was posted,
 * and each of its samples plays that long after the chunk's start, so every
 * sample's delay is the time until the end of the newest scheduled chunk,
 * plus the output's own latency (estimateLatencyMs); with TARGET_BUFFER_S
 * that is about 0.5 s. Neither clock is compared, and the Wi-Fi time (a few
 * milliseconds on a LAN) is left out.
 */
import type { ReceiverBridge } from './receiverBridge';
import type { ReceiverAudio } from './receiverBridgeProtocol';

type TimerHandle = ReturnType<typeof setTimeout>;

export const MIRROR_AUDIO_ROUTE = '/api/mirror/receiver/audio';
export const MIRROR_AUDIO_MAGIC = 'SDRA';
/** The server's numbers (tools/test_receiver_audio_mirror.py compares them). */
export const MIRROR_AUDIO_LIMITS = {
  formatVersion: 1,
  headerBytes: 20,
  sampleRate: 16000,
  minSampleBytes: 1600,
  maxSampleBytes: 16000,
  maxBodyBytes: 16384,
  maxChunksPerS: 10,
  maxListeners: 4,
  keepaliveMs: 1000,
  flagGap: 1,
} as const;

/** Samples per posted chunk: 200 ms at 16 kHz. */
export const CHUNK_SAMPLES = 3200;
/** Chunks waiting while a POST is in flight; an older one is dropped (the next is marked as a gap). */
export const MAX_QUEUED_AUDIO_CHUNKS = 2;
/** The player starts this far ahead after a start or an empty buffer. */
export const TARGET_BUFFER_S = 0.25;
/** More than this buffered: chunks are dropped until TARGET_BUFFER_S is left, so the latency comes back down. */
export const CATCH_UP_S = 0.6;
/** No audio for this long while connected: the groundstation sends none (stopped RX, a scan, muted VFOs). */
export const SILENT_AFTER_MS = 2000;
/** No bytes at all (not even a keepalive) for this long: the stream is dead and opened again. */
export const STREAM_IDLE_MS = 5000;
export const RETRY_MS = 2000;
export const BUSY_RETRY_MS = 5000;
const POST_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Format

export interface AudioChunk {
  seq: number;
  flags: number;
  /** Mono -1..1 at MIRROR_AUDIO_LIMITS.sampleRate; empty for a keepalive. */
  samples: Float32Array;
}

/** One chunk as POST takes it and the stream carries it: the 20-byte header, then Int16 little-endian. */
export function encodeAudioChunk(seq: number, flags: number, pcm: Int16Array): Uint8Array {
  const bytes = new Uint8Array(MIRROR_AUDIO_LIMITS.headerBytes + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 4; index++) bytes[index] = MIRROR_AUDIO_MAGIC.charCodeAt(index);
  view.setUint8(4, MIRROR_AUDIO_LIMITS.formatVersion);
  view.setUint8(5, flags);
  view.setUint16(6, 0, true);
  view.setUint32(8, seq >>> 0, true);
  view.setUint32(12, MIRROR_AUDIO_LIMITS.sampleRate, true);
  view.setUint32(16, pcm.length * 2, true);
  for (let index = 0; index < pcm.length; index++) view.setInt16(MIRROR_AUDIO_LIMITS.headerBytes + index * 2, pcm[index], true);
  return bytes;
}

export function floatToPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, Number.isFinite(samples[index]) ? samples[index] : 0));
    pcm[index] = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
  }
  return pcm;
}

/**
 * Reads the stream's bytes as they arrive (in any split) into chunks. A
 * header that is not the format's (magic, version, rate, length) throws: the
 * stream is not the console's and is closed.
 */
export function createChunkReader(): { push(bytes: Uint8Array): AudioChunk[] } {
  let pending = new Uint8Array(0);
  return {
    push(bytes) {
      const joined = new Uint8Array(pending.length + bytes.length);
      joined.set(pending);
      joined.set(bytes, pending.length);
      const chunks: AudioChunk[] = [];
      let offset = 0;
      const header = MIRROR_AUDIO_LIMITS.headerBytes;
      while (joined.length - offset >= header) {
        const view = new DataView(joined.buffer, joined.byteOffset + offset);
        const magic = String.fromCharCode(joined[offset], joined[offset + 1], joined[offset + 2], joined[offset + 3]);
        const length = view.getUint32(16, true);
        if (magic !== MIRROR_AUDIO_MAGIC || view.getUint8(4) !== MIRROR_AUDIO_LIMITS.formatVersion
          || view.getUint32(12, true) !== MIRROR_AUDIO_LIMITS.sampleRate || length % 2 !== 0 || length > MIRROR_AUDIO_LIMITS.maxSampleBytes) {
          throw new Error('not a Receiver audio stream');
        }
        if (joined.length - offset < header + length) break;
        const samples = new Float32Array(length / 2);
        for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(header + index * 2, true) / 0x8000;
        chunks.push({ seq: view.getUint32(8, true), flags: view.getUint8(5), samples });
        offset += header + length;
      }
      pending = joined.slice(offset);
      return chunks;
    },
  };
}

// ---------------------------------------------------------------------------
// 48 kHz to 16 kHz

const DECIMATION = 3;
const FIR_TAPS = 31;
/** Low-pass at about 7 kHz of 48 kHz (a Hamming-windowed sinc), so nothing above 8 kHz folds back. */
const FIR = ((): Float64Array => {
  const cutoff = 7000 / 48000;
  const taps = new Float64Array(FIR_TAPS);
  const middle = (FIR_TAPS - 1) / 2;
  let sum = 0;
  for (let index = 0; index < FIR_TAPS; index++) {
    const n = index - middle;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * index) / (FIR_TAPS - 1));
    taps[index] = sinc * window;
    sum += taps[index];
  }
  for (let index = 0; index < FIR_TAPS; index++) taps[index] /= sum;
  return taps;
})();

/** A low-pass decimator by 3 that keeps its history across chunks; reset() after a gap. */
export function createDecimator(): { process(input: Float32Array): Float32Array; reset(): void } {
  let history = new Float32Array(FIR_TAPS - 1);
  let phase = 0;
  return {
    process(input) {
      const joined = new Float32Array(history.length + input.length);
      joined.set(history);
      joined.set(input, history.length);
      const out: number[] = [];
      for (let index = phase; index < input.length; index += DECIMATION) {
        // joined[index .. index + FIR_TAPS - 1] ends at input[index].
        let acc = 0;
        for (let tap = 0; tap < FIR_TAPS; tap++) acc += FIR[tap] * joined[index + tap];
        out.push(acc);
      }
      const last = phase + Math.ceil((input.length - phase) / DECIMATION) * DECIMATION;
      phase = Math.max(0, last - input.length);
      history = joined.slice(joined.length - (FIR_TAPS - 1));
      return Float32Array.from(out);
    },
    reset() {
      history = new Float32Array(FIR_TAPS - 1);
      phase = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Groundstation: the publisher

export interface AudioPostAnswer {
  status: number;
  code: string | null;
  /** Listeners the console reports (an accepted post only). */
  listeners: number | null;
}

export interface MirrorAudioPublisherEnvironment {
  /** POST one chunk for this page's mirror source; rejects on a network error. */
  post(body: Uint8Array, sourceId: string): Promise<AudioPostAnswer>;
}

async function postAudioWithFetch(body: Uint8Array, sourceId: string): Promise<AudioPostAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const response = await fetch(`${MIRROR_AUDIO_ROUTE}?source=${encodeURIComponent(sourceId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: body as BodyInit,
      signal: controller.signal,
    });
    let code: string | null = null;
    let listeners: number | null = null;
    try {
      const answer = await response.json() as { code?: unknown; listeners?: unknown };
      if (!response.ok && typeof answer.code === 'string') code = answer.code;
      if (response.ok && typeof answer.listeners === 'number' && Number.isInteger(answer.listeners) && answer.listeners >= 0) listeners = answer.listeners;
    } catch {
      // An answer without a JSON body keeps its status only.
    }
    return { status: response.status, code, listeners };
  } finally {
    clearTimeout(timer);
  }
}

export interface MirrorAudioPublisherStatus {
  /** The Receiver is asked for audio (somebody listens). */
  tapping: boolean;
  chunks: number;
  refused: number;
  dropped: number;
}

export interface MirrorAudioPublisher {
  /** The listener count from the mirror's POST answer, for this page's source id; 0 stops the tap. */
  setListeners(count: number, sourceId: string): void;
  stop(): void;
  status(): MirrorAudioPublisherStatus;
}

/** The groundstation's audio publisher; the mirror publisher drives it (receiverMirrorPublisher.ts). */
export function createMirrorAudioPublisher(
  bridge: ReceiverBridge,
  env: MirrorAudioPublisherEnvironment = { post: postAudioWithFetch },
): MirrorAudioPublisher {
  const decimator = createDecimator();
  let stopped = false;
  let tapping = false;
  let sourceId = '';
  let seq = 0;
  let pcm = new Int16Array(CHUNK_SAMPLES);
  let fill = 0;
  let gap = true;
  // A refused or failed post: the next chunk sent follows lost audio.
  let lost = false;
  let queue: { seq: number; flags: number; pcm: Int16Array }[] = [];
  let inFlight = false;
  const counters = { chunks: 0, refused: 0, dropped: 0 };

  function setTap(on: boolean): void {
    if (on === tapping) return;
    tapping = on;
    bridge.subscribe({ spectrum: false, audio: on }, 'mirror-audio');
    if (!on) {
      queue = [];
      fill = 0;
      gap = true;
      lost = false;
      decimator.reset();
    }
  }

  function pump(): void {
    if (stopped || inFlight || !tapping || !queue.length) return;
    const next = queue.shift() as (typeof queue)[number];
    const flags = next.flags | (lost ? MIRROR_AUDIO_LIMITS.flagGap : 0);
    lost = false;
    inFlight = true;
    counters.chunks += 1;
    env.post(encodeAudioChunk(next.seq, flags, next.pcm), sourceId).then(
      (answer) => {
        if (answer.status >= 200 && answer.status < 300) {
          if (answer.listeners === 0) setTap(false);
          return;
        }
        counters.refused += 1;
        // No source or a closed LAN view: stop until the mirror's next answer says somebody listens.
        if (answer.status === 409) setTap(false);
        else lost = true;
      },
      () => {
        counters.refused += 1;
        lost = true;
      },
    ).finally(() => {
      inFlight = false;
      pump();
    });
  }

  function queueChunk(): void {
    const chunk = { seq: ++seq, flags: gap ? MIRROR_AUDIO_LIMITS.flagGap : 0, pcm };
    gap = false;
    queue.push(chunk);
    while (queue.length > MAX_QUEUED_AUDIO_CHUNKS) {
      queue.shift();
      counters.dropped += 1;
      queue[0].flags |= MIRROR_AUDIO_LIMITS.flagGap;
    }
    pcm = new Int16Array(CHUNK_SAMPLES);
    fill = 0;
    pump();
  }

  const offAudio = bridge.onAudio((audio: ReceiverAudio) => {
    if (stopped || !tapping) return;
    if (audio.gap) {
      decimator.reset();
      fill = 0;
      gap = true;
    }
    const samples = floatToPcm16(decimator.process(audio.samples));
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(CHUNK_SAMPLES - fill, samples.length - offset);
      pcm.set(samples.subarray(offset, offset + take), fill);
      fill += take;
      offset += take;
      if (fill === CHUNK_SAMPLES) queueChunk();
    }
  });

  return {
    setListeners(count, id) {
      if (stopped) return;
      sourceId = id;
      setTap(count > 0);
    },
    stop() {
      if (stopped) return;
      setTap(false);
      stopped = true;
      offAudio();
    },
    status() {
      return { tapping, ...counters };
    },
  };
}

// ---------------------------------------------------------------------------
// LAN view: the player

/**
 * What the player does: off; connecting (the stream is being opened);
 * buffering and playing; silent (connected, but no audio for SILENT_AFTER_MS);
 * busy (MIRROR_AUDIO_BUSY, tried again after BUSY_RETRY_MS); blocked (the
 * browser keeps the AudioContext suspended); retrying (the stream ended or
 * was refused, opened again after RETRY_MS); unsupported (no Web Audio or
 * no streamed fetch).
 */
export type MirrorAudioStatus = 'off' | 'connecting' | 'buffering' | 'playing' | 'silent' | 'busy' | 'blocked' | 'retrying' | 'unsupported';

export interface MirrorAudioState {
  status: MirrorAudioStatus;
  /** The estimated latency while audio plays, else null. */
  latencyMs: number | null;
  /** The console's code of the last refusal, if any. */
  code: string | null;
}

export interface AudioContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  createBuffer(channels: number, length: number, sampleRate: number): { getChannelData(channel: number): Float32Array; readonly duration: number };
  createBufferSource(): { buffer: unknown; connect(node: unknown): void; start(when: number): void; onended: (() => void) | null; disconnect(): void };
}

export interface StreamAnswer {
  status: number;
  code: string | null;
  body: ReadableStream<Uint8Array> | null;
}

export interface MirrorAudioPlayerEnvironment {
  createContext(): AudioContextLike | null;
  openStream(signal: AbortSignal): Promise<StreamAnswer>;
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

async function openStreamWithFetch(signal: AbortSignal): Promise<StreamAnswer> {
  const response = await fetch(MIRROR_AUDIO_ROUTE, { cache: 'no-store', credentials: 'same-origin', signal });
  if (response.ok) return { status: response.status, code: null, body: response.body };
  let code: string | null = null;
  try {
    const answer = await response.json() as { code?: unknown };
    if (typeof answer.code === 'string') code = answer.code;
  } catch {
    // The status alone, then.
  }
  return { status: response.status, code, body: null };
}

export function browserPlayerEnvironment(): MirrorAudioPlayerEnvironment {
  return {
    createContext: () => {
      const Context = typeof window === 'undefined'
        ? undefined
        : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
      if (!Context || typeof fetch !== 'function' || typeof ReadableStream === 'undefined') return null;
      return new Context({ latencyHint: 'interactive' }) as unknown as AudioContextLike;
    },
    openStream: openStreamWithFetch,
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
}

export interface ChunkSlot {
  /** When the chunk starts on the AudioContext's clock; null: dropped. */
  startAt: number | null;
  nextTime: number;
  /** Dropping chunks until the buffer is back at TARGET_BUFFER_S. */
  catchingUp: boolean;
}

/**
 * Where the next chunk goes on the AudioContext's clock: after an empty
 * buffer (or at the start) TARGET_BUFFER_S ahead, else right after the
 * previous one. With more than CATCH_UP_S buffered, chunks are dropped
 * (startAt null) until no more than TARGET_BUFFER_S is left.
 */
export function scheduleChunk(nextTime: number, now: number, durationS: number, catchingUp = false): ChunkSlot {
  const ahead = nextTime - now;
  if (ahead < 0.02) {
    const startAt = now + TARGET_BUFFER_S;
    return { startAt, nextTime: startAt + durationS, catchingUp: false };
  }
  if ((catchingUp || ahead > CATCH_UP_S) && ahead > TARGET_BUFFER_S) return { startAt: null, nextTime, catchingUp: true };
  return { startAt: nextTime, nextTime: nextTime + durationS, catchingUp: false };
}

/** The latency estimate: until the end of the newest scheduled chunk, and the output's own latency. */
export function estimateLatencyMs(nextTime: number, now: number, outputLatencyS: number): number {
  return Math.round(Math.max(0, nextTime - now) * 1000 + Math.max(0, outputLatencyS) * 1000);
}

export interface MirrorAudioPlayer {
  /** Start listening; call it inside the click, so the browser lets the audio play. */
  start(): void;
  stop(): void;
  getState(): MirrorAudioState;
  subscribe(listener: () => void): () => void;
}

export function createMirrorAudioPlayer(env: MirrorAudioPlayerEnvironment = browserPlayerEnvironment()): MirrorAudioPlayer {
  let state: MirrorAudioState = { status: 'off', latencyMs: null, code: null };
  const listeners = new Set<() => void>();
  let context: AudioContextLike | null = null;
  let enabled = false;
  let generation = 0;
  let controller: AbortController | null = null;
  let retryTimer: TimerHandle | null = null;
  let idleTimer: TimerHandle | null = null;
  let nextTime = 0;
  let catchingUp = false;
  let lastAudioAt = -Infinity;
  let connectedAt = 0;

  function set(next: Partial<MirrorAudioState>): void {
    const merged = { ...state, ...next };
    if (merged.status === state.status && merged.latencyMs === state.latencyMs && merged.code === state.code) return;
    state = merged;
    for (const listener of [...listeners]) listener();
  }

  function clearTimers(): void {
    if (retryTimer !== null) env.clearTimeout(retryTimer);
    if (idleTimer !== null) env.clearTimeout(idleTimer);
    retryTimer = null;
    idleTimer = null;
  }

  function outputLatency(): number {
    return context?.outputLatency ?? context?.baseLatency ?? 0;
  }

  function blocked(): boolean {
    return context !== null && context.state !== 'running';
  }

  function retry(ms: number, status: MirrorAudioStatus, code: string | null): void {
    controller?.abort();
    controller = null;
    if (!enabled) return;
    set({ status, latencyMs: null, code });
    if (retryTimer !== null) env.clearTimeout(retryTimer);
    retryTimer = env.setTimeout(() => { retryTimer = null; connect(); }, ms);
  }

  function armIdle(own: number): void {
    if (idleTimer !== null) env.clearTimeout(idleTimer);
    idleTimer = env.setTimeout(() => {
      idleTimer = null;
      if (own === generation) retry(RETRY_MS, 'retrying', null);
    }, STREAM_IDLE_MS);
  }

  function play(chunk: AudioChunk): void {
    if (!context) return;
    const now = context.currentTime;
    const duration = chunk.samples.length / MIRROR_AUDIO_LIMITS.sampleRate;
    const slot = scheduleChunk(nextTime, now, duration, catchingUp);
    nextTime = slot.nextTime;
    catchingUp = slot.catchingUp;
    if (slot.startAt !== null) {
      const buffer = context.createBuffer(1, chunk.samples.length, MIRROR_AUDIO_LIMITS.sampleRate);
      buffer.getChannelData(0).set(chunk.samples);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => source.disconnect();
      source.start(slot.startAt);
    }
    set({ status: blocked() ? 'blocked' : 'playing', latencyMs: estimateLatencyMs(nextTime, now, outputLatency()), code: null });
  }

  function received(chunks: AudioChunk[]): void {
    const now = env.now();
    for (const chunk of chunks) {
      if (chunk.samples.length) {
        lastAudioAt = now;
        play(chunk);
      }
    }
    if (now - Math.max(lastAudioAt, connectedAt) >= SILENT_AFTER_MS) set({ status: blocked() ? 'blocked' : 'silent', latencyMs: null });
  }

  async function read(own: number, body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const chunks = createChunkReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (own !== generation) return;
        if (done) break;
        armIdle(own);
        received(chunks.push(value));
      }
      retry(RETRY_MS, 'retrying', null);
    } catch {
      if (own === generation) retry(RETRY_MS, 'retrying', null);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Already released with the aborted request.
      }
    }
  }

  function connect(): void {
    if (!enabled) return;
    const own = ++generation;
    controller?.abort();
    controller = new AbortController();
    set({ status: 'connecting', latencyMs: null });
    env.openStream(controller.signal).then(
      (answer) => {
        if (own !== generation || !enabled) return;
        if (answer.status === 429) {
          retry(BUSY_RETRY_MS, 'busy', answer.code);
          return;
        }
        if (answer.status !== 200 || !answer.body) {
          retry(RETRY_MS, 'retrying', answer.code);
          return;
        }
        connectedAt = env.now();
        lastAudioAt = -Infinity;
        nextTime = 0;
        set({ status: blocked() ? 'blocked' : 'buffering', code: null });
        armIdle(own);
        void read(own, answer.body);
      },
      () => {
        if (own === generation) retry(RETRY_MS, 'retrying', null);
      },
    );
  }

  return {
    start() {
      if (!context) context = env.createContext();
      if (!context) {
        set({ status: 'unsupported', latencyMs: null });
        return;
      }
      // Inside the click: the browser lets this context play.
      const resumed = context.resume();
      void resumed.then(() => { if (enabled && state.status === 'blocked' && !blocked()) set({ status: 'buffering' }); }, () => undefined);
      if (enabled) {
        // Tapped again: only the resume above, for a context the browser held.
        if (blocked()) set({ status: 'blocked' });
        return;
      }
      enabled = true;
      connect();
    },
    stop() {
      enabled = false;
      generation += 1;
      clearTimers();
      controller?.abort();
      controller = null;
      nextTime = 0;
      set({ status: 'off', latencyMs: null, code: null });
    },
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

let shared: MirrorAudioPlayer | null = null;

/** The LAN view's one player: the dock and the Receiver route share it, so a route change keeps the sound. */
export function mirrorAudioPlayer(): MirrorAudioPlayer {
  shared ??= createMirrorAudioPlayer();
  return shared;
}
