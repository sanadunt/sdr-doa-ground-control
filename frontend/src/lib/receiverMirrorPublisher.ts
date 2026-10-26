/**
 * The Receiver mirror's source in the groundstation page (issue #15, phase 2).
 *
 * App starts it in the console page that owns the Receiver frame (never in
 * the LAN view). While the console's LAN view is open it posts the bridge's
 * state and its spectrum frames to POST /api/mirror/receiver; the LAN view
 * reads them back. It only listens to the bridge (its state and its frames,
 * under its own subscription owner) and never sends a command to the frame.
 *
 * Pace: at most one post every MIRROR_POST_INTERVAL_MS (5 a second), one at a
 * time. A post carries the current state and the newest frame not sent yet;
 * it goes out when a frame arrives, the state changes, or the heartbeat is
 * due (every MIRROR_LIMITS.heartbeatMs). Frames older than the newest one are
 * dropped, never queued. Frames are asked for only while this page is visible.
 *
 * The LAN view's state: checked at start through /api/health, and again every
 * MIRROR_LAN_CHECK_MS while closed; a post answered with MIRROR_LAN_CLOSED
 * stops the posts and the frames at once. Nothing is posted without a frame
 * that answers the bridge (no state, no post): viewers then see the source lost.
 */
import type { ReceiverBridge } from './receiverBridge';
import type { SpectrumFrame } from './receiverBridgeProtocol';
import {
  MIRROR_LAN_CHECK_MS,
  MIRROR_LIMITS,
  MIRROR_POST_INTERVAL_MS,
  MIRROR_ROUTE,
  MIRROR_SUBSCRIBE_FPS,
  MIRROR_VERSION,
  mirrorFrameFromSpectrum,
  mirrorStateFromStatus,
  mirrorStateKey,
} from './receiverMirror';
import type { MirrorPublish, MirrorSource, MirrorState } from './receiverMirror';

type TimerHandle = ReturnType<typeof setTimeout>;

export interface MirrorPostAnswer {
  status: number;
  /** The error code of a refusal, when the answer carried one. */
  code: string | null;
}

export interface MirrorPublisherEnvironment {
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  /** POST the body; rejects on a network error. */
  post(body: string): Promise<MirrorPostAnswer>;
  /** Whether the console's LAN view is open (GET /api/health); rejects when unknown. */
  lanOpen(): Promise<boolean>;
  visible(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  random(): number;
}

/** After a refusal or a network error, wait this long (doubling up to the cap) before the next post. */
export const MIRROR_RETRY_MS = 1_000;
export const MIRROR_RETRY_MAX_MS = 10_000;

const POST_TIMEOUT_MS = 5_000;

async function postWithFetch(body: string): Promise<MirrorPostAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const response = await fetch(MIRROR_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body,
      signal: controller.signal,
    });
    let code: string | null = null;
    if (!response.ok) {
      try {
        const answer: unknown = await response.json();
        if (typeof answer === 'object' && answer !== null && typeof (answer as { code?: unknown }).code === 'string') code = (answer as { code: string }).code;
      } catch {
        // A refusal without a JSON body keeps its status only.
      }
    } else {
      void response.body?.cancel().catch(() => undefined);
    }
    return { status: response.status, code };
  } finally {
    clearTimeout(timer);
  }
}

async function lanOpenFromHealth(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const response = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    if (!response.ok) throw new Error(`health ${response.status}`);
    const body: unknown = await response.json();
    const lan = typeof body === 'object' && body !== null ? (body as { lan_access?: unknown }).lan_access : null;
    return typeof lan === 'object' && lan !== null && (lan as { state?: unknown }).state === 'open';
  } finally {
    clearTimeout(timer);
  }
}

export function browserPublisherEnvironment(): MirrorPublisherEnvironment {
  return {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    post: postWithFetch,
    lanOpen: lanOpenFromHealth,
    visible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    onVisibilityChange: (listener) => {
      if (typeof document === 'undefined') return () => undefined;
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    random: () => Math.random(),
  };
}

/** A page-load id for the mirror's source: 'kiosk-' and 16 base-36 characters. */
export function mirrorSourceId(random: () => number): string {
  let text = '';
  while (text.length < 16) text += Math.floor(random() * 36).toString(36);
  return `kiosk-${text.slice(0, 16)}`;
}

export interface MirrorPublisherStatus {
  /** The LAN view is open, as far as the publisher knows. */
  lanOpen: boolean;
  posts: number;
  frames: number;
  refused: number;
}

export interface MirrorPublisher {
  stop(): void;
  status(): MirrorPublisherStatus;
}

/** Start publishing this page's Receiver; stop() ends it and drops the mirror's subscription. */
export function startMirrorPublisher(bridge: ReceiverBridge, environment: MirrorPublisherEnvironment = browserPublisherEnvironment()): MirrorPublisher {
  const env = environment;
  const sourceId = mirrorSourceId(env.random);
  let stopped = false;
  let lanOpen = false;
  let checking = false;
  let lanTimer: TimerHandle | null = null;
  let timer: TimerHandle | null = null;
  let inFlight = false;
  let lastPostAt = -Infinity;
  let blockedUntil = -Infinity;
  let retryMs = MIRROR_RETRY_MS;
  let state: MirrorState | null = null;
  let stateKey = '';
  let stateRev = 0;
  let stateDirty = false;
  let pendingFrame: SpectrumFrame | null = null;
  const counters = { posts: 0, frames: 0, refused: 0 };

  function source(): MirrorSource {
    return { id: sourceId, kind: 'kiosk-tab', visible: env.visible() };
  }

  function clearTimer(): void {
    if (timer !== null) env.clearTimeout(timer);
    timer = null;
  }

  function schedule(ms: number): void {
    clearTimer();
    timer = env.setTimeout(() => { timer = null; pump(); }, Math.max(0, ms));
  }

  function updateSubscription(): void {
    bridge.subscribe({ spectrum: !stopped && lanOpen && env.visible(), bins: MIRROR_LIMITS.maxBins, fps: MIRROR_SUBSCRIBE_FPS }, 'mirror');
  }

  /** The state from the bridge; a change of it, or of the page's visibility, is a new rev. */
  function refreshState(): void {
    const bridgeState = bridge.getState();
    const status = bridgeState.phase === 'ready' ? bridgeState.status : null;
    if (!status) {
      state = null;
      return;
    }
    const next = mirrorStateFromStatus(status, stateRev, env.now());
    const key = `${env.visible() ? 1 : 0}${mirrorStateKey(next)}`;
    if (key !== stateKey) {
      stateKey = key;
      stateRev += 1;
      stateDirty = true;
    }
    state = { ...next, rev: stateRev };
  }

  function send(frame: SpectrumFrame | null, now: number): void {
    if (!state) return;
    const body: MirrorPublish = { v: MIRROR_VERSION, source: source(), state: { ...state, t_ms: Math.max(state.t_ms, 0) } };
    const encoded = frame ? mirrorFrameFromSpectrum(frame, now) : null;
    if (encoded) body.frame = encoded;
    let text = JSON.stringify(body);
    if (text.length > MIRROR_LIMITS.maxBodyBytes && body.frame) {
      // Never expected (a frame is about 1 KiB); the state goes alone then.
      delete body.frame;
      text = JSON.stringify(body);
    }
    inFlight = true;
    lastPostAt = now;
    stateDirty = false;
    counters.posts += 1;
    if (body.frame) counters.frames += 1;
    env.post(text).then(
      (answer) => {
        if (answer.status >= 200 && answer.status < 300) {
          retryMs = MIRROR_RETRY_MS;
          return;
        }
        counters.refused += 1;
        if (answer.status === 409 && answer.code === 'MIRROR_LAN_CLOSED') {
          setLanOpen(false);
          return;
        }
        // A rate refusal, a schema refusal or a console that is away: the state goes again later.
        stateDirty = true;
        blockedUntil = env.now() + retryMs;
        retryMs = Math.min(MIRROR_RETRY_MAX_MS, retryMs * 2);
      },
      () => {
        counters.refused += 1;
        stateDirty = true;
        blockedUntil = env.now() + retryMs;
        retryMs = Math.min(MIRROR_RETRY_MAX_MS, retryMs * 2);
      },
    ).finally(() => {
      inFlight = false;
      pump();
    });
  }

  function pump(): void {
    if (stopped || !lanOpen || inFlight) return;
    clearTimer();
    if (!state) return;
    const now = env.now();
    const due = Math.max(lastPostAt + MIRROR_POST_INTERVAL_MS, blockedUntil);
    const wanted = pendingFrame !== null || stateDirty || now - lastPostAt >= MIRROR_LIMITS.heartbeatMs;
    if (wanted && now >= due) {
      const frame = pendingFrame;
      pendingFrame = null;
      send(frame, now);
      return;
    }
    schedule(wanted ? due - now : Math.max(due, lastPostAt + MIRROR_LIMITS.heartbeatMs) - now);
  }

  function scheduleLanCheck(): void {
    if (lanTimer !== null) env.clearTimeout(lanTimer);
    lanTimer = stopped || lanOpen ? null : env.setTimeout(() => { lanTimer = null; checkLan(); }, MIRROR_LAN_CHECK_MS);
  }

  function setLanOpen(open: boolean): void {
    if (stopped || open === lanOpen) {
      scheduleLanCheck();
      return;
    }
    lanOpen = open;
    updateSubscription();
    if (open) {
      stateDirty = true;
      retryMs = MIRROR_RETRY_MS;
      blockedUntil = -Infinity;
      refreshState();
      pump();
    } else {
      pendingFrame = null;
      clearTimer();
    }
    scheduleLanCheck();
  }

  function checkLan(): void {
    if (stopped || checking) return;
    checking = true;
    env.lanOpen().then(
      (open) => { checking = false; setLanOpen(open); },
      () => { checking = false; scheduleLanCheck(); },
    );
  }

  const offState = bridge.onState(() => {
    if (stopped) return;
    refreshState();
    pump();
  });
  const offSpectrum = bridge.onSpectrum((frame) => {
    if (stopped || !lanOpen || !env.visible()) return;
    pendingFrame = frame;
    pump();
  });
  const offVisibility = env.onVisibilityChange(() => {
    if (stopped) return;
    updateSubscription();
    if (!env.visible()) pendingFrame = null;
    refreshState();
    pump();
  });

  updateSubscription();
  refreshState();
  checkLan();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      offState();
      offSpectrum();
      offVisibility();
      clearTimer();
      if (lanTimer !== null) env.clearTimeout(lanTimer);
      lanTimer = null;
      pendingFrame = null;
      bridge.subscribe({ spectrum: false }, 'mirror');
    },
    status() {
      return { lanOpen, ...counters };
    },
  };
}
