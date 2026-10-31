import { describe, expect, it } from 'vitest';
import { createMirrorFeed, MIRROR_READ_RETRY_MS } from './receiverMirrorFeed';
import type { MirrorFeedEnvironment } from './receiverMirrorFeed';
import type { ReceiverMirrorFeed } from './receiverMirrorFeed';
import { MIRROR_POLL_LOST_MS, MIRROR_POLL_MS, bytesToBase64, mirrorView } from './receiverMirror';
import type { SpectrumFrame } from './receiverBridgeProtocol';
import type { DockMode } from './spectrumDockSettings';
import { createFrameGate } from './spectrumView';

const SOURCE = { id: 'kiosk-test-0001', kind: 'kiosk-tab', visible: true };
const STATE = {
  rev: 1, t_ms: 1, connected: true, running: true, recording: false, mock: false, busy: 'none', center_hz: 433_920_000,
  sample_rate_hz: 10_000_000, span_hz: 2_000_000, frequency_shift_hz: 0, gains: { lna_db: 16, vga_db: 20, amp: false },
  vfo: null, scan: null, error: null,
};

function body(rev: number, frameRev: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true, v: 1, rev, frame_rev: frameRev, source: SOURCE, source_age_ms: 50, state: STATE, state_age_ms: 50,
    frame: {
      seq: frameRev, t_ms: 1, kind: 'rx', center_hz: 433_920_000, start_hz: 432_920_000, stop_hz: 434_920_000, bin_count: 16,
      db_min: -120, db_max: -20, bins: bytesToBase64(Uint8Array.from({ length: 16 }, (_value, index) => index * 16)),
    },
    frame_age_ms: 80,
    limits: { frame_stale_ms: 3000, source_lost_ms: 10000 },
    ...overrides,
  };
}

/** A frame of the scan the groundstation ran over 50–1000 MHz. */
function sweepFrame(seq: number): Record<string, unknown> {
  return {
    seq, t_ms: 1, kind: 'sweep', center_hz: 525_000_000, start_hz: 50_000_000, stop_hz: 1_000_000_000, bin_count: 16,
    db_min: -110, db_max: -30, bins: bytesToBase64(Uint8Array.from({ length: 16 }, (_value, index) => index * 16)),
  };
}

function scanState(phase: 'idle' | 'active', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...STATE, running: false, busy: phase === 'idle' ? 'none' : 'sweep',
    scan: { phase, start_hz: 50_000_000, stop_hz: 1_000_000_000, resolution_hz: 4882.8125, gains: { lna_db: 24, vga_db: 30, amp: false } },
    ...overrides,
  };
}

/**
 * The dock's canvas as far as frames go (SpectrumCanvas): every frame goes
 * through its gate with the mode of its last render, and React renders a
 * state change after the change, here in a microtask, then settles the gate.
 */
function canvasOf(feed: ReceiverMirrorFeed) {
  const gate = createFrameGate();
  const modeNow = (): DockMode => {
    const state = feed.getState();
    return mirrorView({ ...state, nowMs: state.receivedAtMs ?? 0 }).mode;
  };
  let rendered = modeNow();
  const drawn: Array<[SpectrumFrame['source'], number]> = [];
  feed.onState(() => {
    queueMicrotask(() => {
      rendered = modeNow();
      const frame = gate.settle(rendered);
      if (frame) drawn.push([frame.source, frame.seq]);
    });
  });
  feed.onSpectrum((frame) => {
    const taken = gate.offer(frame, rendered);
    if (taken) drawn.push([taken.source, taken.seq]);
  });
  return { drawn, mode: () => rendered };
}

function harness() {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
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
  const reads: number[] = [];
  const answers: Array<unknown> = [];
  let visible = true;
  const visibilityListeners = new Set<() => void>();
  const env: MirrorFeedEnvironment = {
    now: () => now,
    setTimeout: (callback, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { due: now + ms, callback });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => { timers.delete(handle as unknown as number); },
    read: () => {
      reads.push(now);
      const next = answers.length > 1 ? answers.shift() : answers[0];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    visible: () => visible,
    onVisibilityChange: (listener) => { visibilityListeners.add(listener); return () => { visibilityListeners.delete(listener); }; },
  };
  const feed = createMirrorFeed(env);
  const frames: SpectrumFrame[] = [];
  feed.onSpectrum((frame) => { frames.push(frame); });
  let notified = 0;
  feed.onState(() => { notified += 1; });
  return {
    feed, reads, answers, frames, advance, settle, timers: () => timers.size,
    notified: () => notified,
    setVisible: (value: boolean) => { visible = value; for (const listener of [...visibilityListeners]) listener(); },
  };
}

describe('Receiver mirror feed (LAN view)', () => {
  it('reads nothing until something shows the mirror', async () => {
    const h = harness();
    h.answers.push(body(1, 1));
    await h.advance(5_000);
    expect(h.reads).toHaveLength(0);
    expect(h.feed.getState()).toEqual({ answer: null, receivedAtMs: null, error: false });
  });

  it('reads about 5 times a second while shown and stops when let go', async () => {
    const h = harness();
    h.answers.push(body(1, 1));
    const release = h.feed.retain();
    await h.advance(1_000);
    expect(h.reads).toHaveLength(1 + 1_000 / MIRROR_POLL_MS);
    expect(h.reads[1] - h.reads[0]).toBe(MIRROR_POLL_MS);
    release();
    await h.advance(5_000);
    expect(h.reads).toHaveLength(6);
    expect(h.timers()).toBe(0);
  });

  it('draws each published frame once, as dB, and the newest again for a new view', async () => {
    const h = harness();
    h.answers.push(body(1, 1), body(2, 1), body(3, 2));
    const release = h.feed.retain();
    await h.advance(MIRROR_POLL_MS * 4);
    expect(h.frames.map((frame) => frame.seq)).toEqual([1, 2]);
    const first = h.frames[0];
    expect(first).toMatchObject({ source: 'rx', binCount: 16, startHz: 432_920_000, stopHz: 434_920_000 });
    expect(first.bins[0]).toBe(-120);
    expect(first.bins[15]).toBeCloseTo(-120 + (240 / 255) * 100, 3);
    release();
    // The Receiver route mounts after the dock: it gets the newest frame although no new one came.
    const again = h.feed.retain();
    await h.settle();
    expect(h.frames.map((frame) => frame.seq)).toEqual([1, 2, 2]);
    again();
  });

  it('notifies state only when the source posted again', async () => {
    const h = harness();
    h.answers.push(body(1, 1), body(1, 1), body(1, 1), body(2, 1));
    const release = h.feed.retain();
    await h.advance(MIRROR_POLL_MS * 2);
    expect(h.notified()).toBe(1);
    await h.advance(MIRROR_POLL_MS);
    expect(h.notified()).toBe(2);
    expect(h.feed.getState().answer?.rev).toBe(2);
    release();
  });

  it('carries the groundstation Receiver\'s markers with each new post', async () => {
    const h = harness();
    const markers = { rev: 1, saved: false, total: 3, markers: [
      { id: 'm-2', frequency_hz: 434_000_000, power_db: -50.5, label: 'Repeater' },
      { id: 'm-1', frequency_hz: 433_500_000, power_db: null, label: 'M1' },
    ] };
    h.answers.push(body(1, 1), body(2, 1, { markers }));
    const release = h.feed.retain();
    await h.settle();
    expect(h.feed.getState().answer?.markers).toBeNull();
    const view = mirrorView({ ...h.feed.getState(), nowMs: 0 });
    expect(view.markers).toBeNull();
    await h.advance(MIRROR_POLL_MS);
    expect(h.feed.getState().answer?.markers).toEqual({
      saved: false, total: 3,
      markers: [
        { id: 'm-1', frequencyHz: 433_500_000, powerDb: null, label: 'M1' },
        { id: 'm-2', frequencyHz: 434_000_000, powerDb: -50.5, label: 'Repeater' },
      ],
    });
    expect(mirrorView({ ...h.feed.getState(), nowMs: 0 }).markers?.markers).toHaveLength(2);
    release();
  });

  it('marks a failed read, backs off, and the view counts the source lost after 10 s', async () => {
    const h = harness();
    h.answers.push(body(1, 1), new Error('offline'));
    const release = h.feed.retain();
    await h.settle();
    const answered = h.feed.getState();
    expect(answered.error).toBe(false);
    await h.advance(MIRROR_POLL_MS);
    expect(h.feed.getState().error).toBe(true);
    // The answer is kept; the view ages it from its arrival.
    expect(h.feed.getState().answer?.rev).toBe(1);
    const reads = h.reads.length;
    await h.advance(MIRROR_READ_RETRY_MS[0] - 1);
    expect(h.reads.length).toBe(reads);
    await h.advance(1);
    expect(h.reads.length).toBe(reads + 1);
    const state = h.feed.getState();
    expect(mirrorView({ ...state, nowMs: (state.receivedAtMs ?? 0) + 9_000 }).phase).toBe('stale');
    expect(mirrorView({ ...state, nowMs: (state.receivedAtMs ?? 0) + 10_000 }).phase).toBe('lost');
    release();
  });

  it('reads once a second while nothing is published', async () => {
    const h = harness();
    h.answers.push({ ok: true, v: 1, rev: 0, frame_rev: 0, source: null, state: null, frame: null });
    const release = h.feed.retain();
    await h.advance(MIRROR_POLL_LOST_MS * 3);
    expect(h.reads).toHaveLength(4);
    expect(h.frames).toHaveLength(0);
    release();
  });

  it('pauses while the page is hidden', async () => {
    const h = harness();
    h.answers.push(body(1, 1));
    const release = h.feed.retain();
    await h.settle();
    h.setVisible(false);
    await h.advance(5_000);
    expect(h.reads).toHaveLength(1);
    h.setVisible(true);
    await h.settle();
    expect(h.reads).toHaveLength(2);
    release();
  });

  it('draws a stopped scan\'s last frame for a view that loads after the scan', async () => {
    const h = harness();
    // The groundstation scanned and stopped: RX stopped, busy none, the last frame the scan's.
    h.answers.push(body(4, 9, { state: scanState('idle'), frame: sweepFrame(9) }));
    const canvas = canvasOf(h.feed);
    const release = h.feed.retain();
    await h.settle();
    expect(canvas.mode()).toBe('sweep');
    expect(mirrorView({ ...h.feed.getState(), nowMs: h.feed.getState().receivedAtMs ?? 0 })).toMatchObject({ chip: 'SCAN OFF' });
    // SCAN OFF over the scan's last trace and waterfall row, not over an empty trace.
    expect(canvas.drawn).toEqual([['sweep', 9]]);
    release();
  });

  it('draws the first frame after RX switches to a scan and back', async () => {
    const h = harness();
    h.answers.push(
      body(1, 1),
      body(2, 2, { state: scanState('active'), frame: sweepFrame(2) }),
      body(3, 3, { state: scanState('active'), frame: sweepFrame(3) }),
      body(4, 4),
    );
    const canvas = canvasOf(h.feed);
    const release = h.feed.retain();
    await h.advance(MIRROR_POLL_MS * 3);
    expect(canvas.drawn).toEqual([['rx', 1], ['sweep', 2], ['sweep', 3], ['rx', 4]]);
    expect(canvas.mode()).toBe('rx');
    release();
  });
});
