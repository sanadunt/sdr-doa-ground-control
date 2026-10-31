import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserPublisherEnvironment, startMirrorPublisher, mirrorSourceId, MIRROR_RETRY_MS } from './receiverMirrorPublisher';
import type { MirrorPostAnswer, MirrorPublisherEnvironment } from './receiverMirrorPublisher';
import { MIRROR_LAN_CHECK_MS, MIRROR_LIMITS, MIRROR_POST_INTERVAL_MS, MIRROR_SUBSCRIBE_FPS } from './receiverMirror';
import type { MirrorPublish } from './receiverMirror';
import type { BridgeResult, BridgeState, ReceiverBridge, SubscriptionOwner } from './receiverBridge';
import type { BridgeCommand, BridgeMarker, ReceiverMarkers, ReceiverStatus, RxSpectrumFrame, SpectrumFrame } from './receiverBridgeProtocol';

function status(overrides: Partial<ReceiverStatus> = {}): ReceiverStatus {
  return {
    seq: 1, tMs: 1_000, webusb: true, mockAvailable: false, pairedCount: 1, connected: true, mock: false, deviceName: 'RadioSpectrum One',
    running: true, busy: 'none', workspace: 'listener', centerHz: 433_920_000, sampleRateHz: 10_000_000, frequencyShiftHz: 0,
    gains: { lnaDb: 16, vgaDb: 20, amp: false },
    vfo: { index: 0, enabled: true, mode: 'nfm', frequencyHz: 433_925_000, bandwidthHz: 12_500, squelchEnabled: false, squelchDb: null, volume: 50 },
    squelchOpen: true, audio: 'running', recording: false, error: null, notice: null, tune: null, display: null, sampleRatesHz: [], sweep: null,
    ...overrides,
  };
}

function frame(seq: number, bins = 2048): RxSpectrumFrame {
  const values = Float32Array.from({ length: bins }, (_value, index) => -100 + (index % 50));
  return { source: 'rx', seq, tMs: 1_000 + seq, centerHz: 433_920_000, startHz: 432_920_000, stopHz: 434_920_000, sampleRateHz: 10_000_000, fftSize: bins, binCount: bins, bins: values };
}

/** A bridge with just what the publisher uses, a fake clock and a fake console. */
function harness(options: { lanOpen?: boolean; visible?: boolean } = {}) {
  let now = 10_000;
  let nextHandle = 1;
  const timers = new Map<number, { due: number; callback: () => void }>();
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
  const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

  let bridgeState: BridgeState = { phase: 'ready', build: 'built', hello: null, status: status(), tune: null, markers: null, lastResult: null };
  const stateListeners = new Set<() => void>();
  const spectrumListeners = new Set<(frame: SpectrumFrame) => void>();
  const subscriptions: Array<{ owner: SubscriptionOwner | undefined; spectrum: boolean; bins?: number; fps?: number }> = [];
  // Commands the publisher sends the frame; each settles when the test says so.
  const sent: Array<{ command: BridgeCommand; settle: (result: BridgeResult) => void; fail: () => void }> = [];
  const bridge = {
    send: (command: BridgeCommand) => new Promise<BridgeResult>((resolve, reject) => {
      sent.push({ command, settle: resolve, fail: () => reject(new Error('detached')) });
    }),
    getState: () => bridgeState,
    onState: (listener: () => void) => { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; },
    onSpectrum: (listener: (frame: SpectrumFrame) => void) => { spectrumListeners.add(listener); return () => { spectrumListeners.delete(listener); }; },
    subscribe: (subscription: { spectrum: boolean; bins?: number; fps?: number }, owner?: SubscriptionOwner) => { subscriptions.push({ owner, ...subscription }); },
  } as unknown as ReceiverBridge;
  const setStatus = (next: ReceiverStatus | null, phase: BridgeState['phase'] = 'ready') => {
    bridgeState = { ...bridgeState, phase, status: next };
    for (const listener of [...stateListeners]) listener();
  };
  const sendFrame = (value: SpectrumFrame) => { for (const listener of [...spectrumListeners]) listener(value); };
  const setMarkers = (markers: ReceiverMarkers | null) => {
    bridgeState = { ...bridgeState, markers };
    for (const listener of [...stateListeners]) listener();
  };

  const posts: Array<{ at: number; body: MirrorPublish }> = [];
  const answers: Array<MirrorPostAnswer | Error> = [];
  let pendingPost: { resolve: (answer: MirrorPostAnswer) => void } | null = null;
  let holdPosts = false;
  let lanOpen = options.lanOpen ?? true;
  let lanChecks = 0;
  let visible = options.visible ?? true;
  const visibilityListeners = new Set<() => void>();
  const env: MirrorPublisherEnvironment = {
    now: () => now,
    setTimeout: (callback, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { due: now + ms, callback });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => { timers.delete(handle as unknown as number); },
    post: (body) => {
      posts.push({ at: now, body: JSON.parse(body) as MirrorPublish });
      if (holdPosts) return new Promise((resolve) => { pendingPost = { resolve }; });
      const answer = answers.shift() ?? { status: 200, code: null };
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    lanOpen: () => { lanChecks += 1; return Promise.resolve(lanOpen); },
    visible: () => visible,
    onVisibilityChange: (listener) => { visibilityListeners.add(listener); return () => { visibilityListeners.delete(listener); }; },
    random: () => 0.5,
  };
  return {
    env, bridge, posts, answers, subscriptions, advance, settle, setStatus, sendFrame, setMarkers, sent,
    setLan: (open: boolean) => { lanOpen = open; },
    lanChecks: () => lanChecks,
    setVisible: (value: boolean) => { visible = value; for (const listener of [...visibilityListeners]) listener(); },
    hold: (value: boolean) => { holdPosts = value; },
    release: (answer: MirrorPostAnswer = { status: 200, code: null }) => { const current = pendingPost; pendingPost = null; current?.resolve(answer); },
    timers: () => timers.size,
    listeners: () => stateListeners.size + spectrumListeners.size + visibilityListeners.size,
    now: () => now,
  };
}

describe('Receiver mirror publisher', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('names its source per page load', () => {
    expect(mirrorSourceId(() => 0.5)).toBe('kiosk-iiiiiiiiiiiiiiii');
    expect(mirrorSourceId(Math.random)).toMatch(/^kiosk-[a-z0-9]{16}$/);
  });

  it('asks whether the LAN view is open, subscribes as the mirror and posts the state at once', async () => {
    const h = harness();
    const publisher = startMirrorPublisher(h.bridge, h.env);
    await h.settle();
    expect(h.lanChecks()).toBe(1);
    expect(h.subscriptions.at(-1)).toEqual({ owner: 'mirror', spectrum: true, bins: MIRROR_LIMITS.maxBins, fps: MIRROR_SUBSCRIBE_FPS });
    expect(h.posts).toHaveLength(1);
    const body = h.posts[0].body;
    expect(body.v).toBe(1);
    expect(body.source).toEqual({ id: 'kiosk-iiiiiiiiiiiiiiii', kind: 'kiosk-tab', visible: true });
    expect(body.state).toMatchObject({ rev: 1, running: true, center_hz: 433_920_000, span_hz: 2_000_000 });
    expect(body.frame).toBeUndefined();
    expect(publisher.status()).toMatchObject({ lanOpen: true, posts: 1, frames: 0 });
    publisher.stop();
  });

  it('posts at most 5 a second, one at a time, with only the newest frame', async () => {
    const h = harness();
    const publisher = startMirrorPublisher(h.bridge, h.env);
    await h.settle();
    // Frames at 20 fps for 2 s.
    for (let index = 1; index <= 40; index++) {
      h.sendFrame(frame(index));
      await h.advance(50);
    }
    const times = h.posts.map((post) => post.at);
    for (let index = 1; index < times.length; index++) expect(times[index] - times[index - 1]).toBeGreaterThanOrEqual(MIRROR_POST_INTERVAL_MS);
    expect(h.posts.length).toBeLessThanOrEqual(11);
    expect(h.posts.length).toBeGreaterThanOrEqual(9);
    const seqs = h.posts.map((post) => post.body.frame?.seq).filter((seq): seq is number => seq !== undefined);
    // Each post carries the newest frame at its time; nothing older is queued.
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs.at(-1)).toBeGreaterThanOrEqual(36);
    for (const post of h.posts) {
      if (post.body.frame) expect(post.body.frame.bin_count).toBe(512);
      expect(JSON.stringify(post.body).length).toBeLessThan(MIRROR_LIMITS.maxBodyBytes);
    }
    publisher.stop();
  });

  it('waits for the answer before the next post', async () => {
    const h = harness();
    const publisher = startMirrorPublisher(h.bridge, h.env);
    await h.settle();
    h.hold(true);
    h.sendFrame(frame(1));
    await h.advance(MIRROR_POST_INTERVAL_MS);
    expect(h.posts).toHaveLength(2);
    for (let index = 2; index <= 10; index++) {
      h.sendFrame(frame(index));
      await h.advance(100);
    }
    expect(h.posts).toHaveLength(2);
    h.hold(false);
    h.release();
    await h.settle();
    expect(h.posts).toHaveLength(3);
    expect(h.posts[2].body.frame?.seq).toBe(10);
    publisher.stop();
  });

  it('sends the state when it changes and a heartbeat every 500 ms without frames', async () => {
    const h = harness();
    const publisher = startMirrorPublisher(h.bridge, h.env);
    await h.settle();
    expect(h.posts).toHaveLength(1);
    // Same state with a new seq and time: nothing new before the heartbeat.
    h.setStatus(status({ seq: 2, tMs: 2_000 }));
    await h.advance(MIRROR_LIMITS.heartbeatMs - 100);
    expect(h.posts).toHaveLength(1);
    h.setStatus(status({ seq: 3, running: false }));
    await h.advance(MIRROR_POST_INTERVAL_MS);
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1].body.state).toMatchObject({ rev: 2, running: false });
    await h.advance(MIRROR_LIMITS.heartbeatMs * 3);
    expect(h.posts).toHaveLength(5);
    expect(h.posts.slice(2).map((post) => post.body.state.rev)).toEqual([2, 2, 2]);
    expect(h.posts[3].at - h.posts[2].at).toBe(MIRROR_LIMITS.heartbeatMs);
    publisher.stop();
  });

  it('publishes nothing while the Receiver frame does not answer', async () => {
    const h = harness();
    h.setStatus(null, 'connecting');
    const publisher = startMirrorPublisher(h.bridge, h.env);
    await h.advance(5_000);
    expect(h.posts).toHaveLength(0);
    h.setStatus(status(), 'ready');
    await h.settle();
    expect(h.posts).toHaveLength(1);
    publisher.stop();
  });

  it('stays quiet while the LAN view is closed and starts when it opens', async () => {
    const h = harness({ lanOpen: false });
    const publisher = startMirrorPublisher(h.bridge, h.env);
    await h.settle();
    h.sendFrame(frame(1));
    await h.advance(MIRROR_LAN_CHECK_MS - 1);
    expect(h.posts).toHaveLength(0);
    expect(h.subscriptions.at(-1)).toMatchObject({ owner: 'mirror', spectrum: false });
    expect(h.lanChecks()).toBe(1);
    h.setLan(true);
    await h.advance(1);
    expect(h.lanChecks()).toBe(2);
    expect(h.subscriptions.at(-1)).toMatchObject({ owner: 'mirror', spectrum: true });
    expect(h.posts).toHaveLength(1);
    // While open, no more checks: the posts' answers tell.
    await h.advance(MIRROR_LAN_CHECK_MS * 3);
    expect(h.lanChecks()).toBe(2);
    publisher.stop();
  });

  it('stops posting and asking for frames when the console says the LAN view closed', async () => {
    const h = harness();
    const publisher = startMirrorPublisher(h.bridge, h.env);
    await h.settle();
    h.answers.push({ status: 409, code: 'MIRROR_LAN_CLOSED' });
    h.sendFrame(frame(1));
    await h.advance(MIRROR_POST_INTERVAL_MS);
    expect(h.posts).toHaveLength(2);
    expect(publisher.status().lanOpen).toBe(false);
    expect(h.subscriptions.at(-1)).toMatchObject({ owner: 'mirror', spectrum: false });
    h.setLan(false);
    for (let index = 2; index < 20; index++) {
      h.sendFrame(frame(index));
      await h.advance(500);
    }
    expect(h.posts).toHaveLength(2);
    publisher.stop();
  });

  it('backs off after a refusal or a failed request', async () => {
    const h = harness();
    const publisher = startMirrorPublisher(h.bridge, h.env);
    await h.settle();
    h.answers.push({ status: 429, code: 'MIRROR_RATE_LIMITED' }, new Error('offline'));
    h.sendFrame(frame(1));
    await h.advance(MIRROR_POST_INTERVAL_MS);
    expect(h.posts).toHaveLength(2);
    const refusedAt = h.now();
    h.sendFrame(frame(2));
    await h.advance(MIRROR_RETRY_MS - 1);
    expect(h.posts).toHaveLength(2);
    await h.advance(1);
    expect(h.posts).toHaveLength(3);
    expect(h.posts[2].at - refusedAt).toBe(MIRROR_RETRY_MS);
    // The second failure doubles the wait.
    h.sendFrame(frame(3));
    await h.advance(MIRROR_RETRY_MS * 2 - 1);
    expect(h.posts).toHaveLength(3);
    await h.advance(1);
    expect(h.posts).toHaveLength(4);
    expect(publisher.status().refused).toBe(2);
    publisher.stop();
  });

  it('asks for no frames while the page is hidden and says so in the source', async () => {
    const h = harness();
    const publisher = startMirrorPublisher(h.bridge, h.env);
    await h.settle();
    h.setVisible(false);
    await h.advance(MIRROR_POST_INTERVAL_MS);
    expect(h.subscriptions.at(-1)).toMatchObject({ owner: 'mirror', spectrum: false });
    expect(h.posts.at(-1)?.body.source.visible).toBe(false);
    expect(h.posts.at(-1)?.body.state.rev).toBe(2);
    const count = h.posts.length;
    h.sendFrame(frame(9));
    await h.advance(MIRROR_POST_INTERVAL_MS);
    expect(h.posts.length).toBe(count);
    h.setVisible(true);
    expect(h.subscriptions.at(-1)).toMatchObject({ owner: 'mirror', spectrum: true });
    publisher.stop();
  });

  it('runs each viewer\'s marker command once and reports its result in the next post', async () => {
    const h = harness();
    const publisher = startMirrorPublisher(h.bridge, h.env);
    await h.settle();
    h.answers.push({ status: 200, code: null, commands: [
      { id: 'tab-cmd-0001', op: 'add', frequency_hz: 433_920_000 },
      { id: 'tab-cmd-0002', op: 'remove', marker_id: 'm-4' },
    ] });
    await h.advance(MIRROR_LIMITS.heartbeatMs);
    expect(h.posts).toHaveLength(2);
    expect(h.sent.map((entry) => entry.command)).toEqual([
      { type: 'console:marker-add', frequencyHz: 433_920_000 },
      { type: 'console:marker-remove', markerId: 'm-4' },
    ]);
    // A command handed out again (a resent answer) runs once only.
    h.answers.push({ status: 200, code: null, commands: [{ id: 'tab-cmd-0001', op: 'add', frequency_hz: 433_920_000 }] });
    await h.advance(MIRROR_LIMITS.heartbeatMs);
    expect(h.sent).toHaveLength(2);
    expect(publisher.status().commands).toBe(2);
    // Results go out at the next post slot, without waiting for the heartbeat.
    const before = h.posts.length;
    h.sent[0].settle({ ok: true, code: 'OK', markerId: 'm-9' });
    h.sent[1].settle({ ok: false, code: 'MARKER_NOT_FOUND' });
    await h.advance(MIRROR_POST_INTERVAL_MS);
    expect(h.posts).toHaveLength(before + 1);
    expect(h.posts.at(-1)?.body.results).toEqual([
      { id: 'tab-cmd-0001', code: 'OK', marker_id: 'm-9' },
      { id: 'tab-cmd-0002', code: 'MARKER_NOT_FOUND', marker_id: null },
    ]);
    // Sent once: the next post carries none.
    await h.advance(MIRROR_LIMITS.heartbeatMs);
    expect(h.posts.at(-1)?.body.results).toBeUndefined();
    publisher.stop();
  });

  it('reports a code the console does not take, or a failed send, as NOT_READY', async () => {
    const h = harness();
    const publisher = startMirrorPublisher(h.bridge, h.env);
    await h.settle();
    h.answers.push({ status: 200, code: null, commands: [
      { id: 'tab-cmd-0001', op: 'add', frequency_hz: 433_920_000 },
      { id: 'tab-cmd-0002', op: 'add', frequency_hz: 434_920_000 },
    ] });
    await h.advance(MIRROR_LIMITS.heartbeatMs);
    h.sent[0].settle({ ok: false, code: 'SWEEP_BUSY', markerId: 'not an id' });
    h.sent[1].fail();
    await h.advance(MIRROR_POST_INTERVAL_MS);
    expect(h.posts.at(-1)?.body.results).toEqual([
      { id: 'tab-cmd-0001', code: 'NOT_READY', marker_id: null },
      { id: 'tab-cmd-0002', code: 'NOT_READY', marker_id: null },
    ]);
    publisher.stop();
  });

  it('keeps the results of a refused post and sends them again', async () => {
    const h = harness();
    const publisher = startMirrorPublisher(h.bridge, h.env);
    await h.settle();
    h.answers.push({ status: 200, code: null, commands: [{ id: 'tab-cmd-0001', op: 'remove', marker_id: 'm-1' }] });
    await h.advance(MIRROR_LIMITS.heartbeatMs);
    h.answers.push({ status: 429, code: 'MIRROR_RATE_LIMITED' });
    h.sent[0].settle({ ok: true, code: 'OK' });
    await h.advance(MIRROR_POST_INTERVAL_MS);
    expect(h.posts.at(-1)?.body.results).toEqual([{ id: 'tab-cmd-0001', code: 'OK', marker_id: null }]);
    await h.advance(MIRROR_RETRY_MS);
    expect(h.posts.at(-1)?.body.results).toEqual([{ id: 'tab-cmd-0001', code: 'OK', marker_id: null }]);
    await h.advance(MIRROR_LIMITS.heartbeatMs);
    expect(h.posts.at(-1)?.body.results).toBeUndefined();
    publisher.stop();
  });

  it('sends the Receiver\'s marker list with every post, nearest the view, within the body limit', async () => {
    const h = harness();
    const marker = (index: number, label = `M${index}`): BridgeMarker => ({ id: `m-${index}`, frequencyHz: 433_920_000 + (index - 50) * 100_000, powerDb: -50, label });
    const list = (markers: BridgeMarker[]): ReceiverMarkers => ({ rev: 2, setId: null, setName: null, frequencyShiftHz: 0, markers, total: markers.length, truncated: false });
    h.setMarkers(list([marker(50), marker(10)]));
    const publisher = startMirrorPublisher(h.bridge, h.env);
    await h.settle();
    expect(h.posts[0].body.markers).toEqual({
      rev: 2, saved: false, total: 2,
      markers: [
        { id: 'm-10', frequency_hz: 429_920_000, power_db: -50, label: 'M10' },
        { id: 'm-50', frequency_hz: 433_920_000, power_db: -50, label: 'M50' },
      ],
    });
    // 100 markers with long labels of two-byte characters and a frame: the nearest that fit in 8 KiB.
    h.setMarkers(list(Array.from({ length: 100 }, (_value, index) => marker(index, `é\n${'ö'.repeat(60)}`))));
    h.sendFrame(frame(1));
    await h.advance(MIRROR_POST_INTERVAL_MS);
    const body = h.posts.at(-1)?.body as MirrorPublish;
    expect(body.frame?.bin_count).toBe(512);
    const sent = body.markers?.markers ?? [];
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(MIRROR_LIMITS.maxBodyBytes);
    expect(sent.length).toBeGreaterThan(8);
    expect(sent.length).toBeLessThan(MIRROR_LIMITS.maxMarkers);
    expect(body.markers?.total).toBe(100);
    // The kept markers are those nearest the RX centre, in frequency order, with labels the console takes.
    const distances = sent.map((entry) => Math.abs(entry.frequency_hz - 433_920_000));
    expect(Math.max(...distances)).toBeLessThanOrEqual((sent.length / 2 + 1) * 100_000);
    expect(sent.map((entry) => entry.frequency_hz)).toEqual([...sent.map((entry) => entry.frequency_hz)].sort((a, b) => a - b));
    for (const entry of sent) {
      expect(Array.from(entry.label)).toHaveLength(MIRROR_LIMITS.maxMarkerLabelChars);
      expect(entry.label).not.toMatch(/[\u0000-\u001f]/u);
    }
    publisher.stop();
  });

  it('reads the handed-out commands from the console\'s answer', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ ok: true, rev: 4, frame_rev: 1, commands: [
      { id: 'tab-cmd-0001', op: 'add', frequency_hz: 433_920_000 },
      { id: 'short', op: 'add', frequency_hz: 1 },
      { id: 'tab-cmd-0002', op: 'tune', frequency_hz: 1 },
      { id: 'tab-cmd-0003', op: 'remove', marker_id: 'm 1' },
      { id: 'tab-cmd-0004', op: 'remove', marker_id: 'm-1' },
    ] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);
    const answer = await browserPublisherEnvironment().post('{}');
    expect(answer).toEqual({ status: 200, code: null, commands: [
      { id: 'tab-cmd-0001', op: 'add', frequency_hz: 433_920_000 },
      { id: 'tab-cmd-0004', op: 'remove', marker_id: 'm-1' },
    ] });
    fetchStub.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, code: 'MIRROR_LAN_CLOSED', commands: [{ id: 'tab-cmd-0001', op: 'add', frequency_hz: 1 }] }), { status: 409 }));
    expect(await browserPublisherEnvironment().post('{}')).toEqual({ status: 409, code: 'MIRROR_LAN_CLOSED', commands: [] });
  });

  it('stop() ends everything and drops the mirror subscription', async () => {
    const h = harness();
    const publisher = startMirrorPublisher(h.bridge, h.env);
    await h.settle();
    publisher.stop();
    expect(h.subscriptions.at(-1)).toMatchObject({ owner: 'mirror', spectrum: false });
    expect(h.timers()).toBe(0);
    expect(h.listeners()).toBe(0);
    h.sendFrame(frame(1));
    await h.advance(10_000);
    expect(h.posts).toHaveLength(1);
  });
});
