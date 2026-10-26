/**
 * The LAN view's reading of the Receiver mirror (issue #15, phase 2).
 *
 * One feed per LAN view page, created in App. While something shows it (the
 * spectrum dock in MIRROR mode or the Receiver route, through retain()) and
 * the page is visible, it reads GET /api/mirror/receiver every
 * MIRROR_POLL_MS (MIRROR_POLL_LOST_MS while the source is lost, longer after
 * a failed read), one read at a time. A frame the feed has not drawn yet goes
 * to the spectrum listeners as the bridge's SpectrumFrame, so the dock's
 * canvas draws it like a Receiver frame; frames never become React state. The
 * answer itself is state (getState/onState), and changes only when the
 * source posted again, so a stopped radio re-renders nothing. No audio.
 */
import type { SpectrumFeed } from './receiverBridge';
import type { SpectrumFrame } from './receiverBridgeProtocol';
import { MIRROR_POLL_LOST_MS, MIRROR_POLL_MS, MIRROR_ROUTE, normalizeMirrorAnswer, spectrumFromMirrorFrame } from './receiverMirror';
import type { MirrorAnswer } from './receiverMirror';

type TimerHandle = ReturnType<typeof setTimeout>;

export interface MirrorFeedState {
  answer: MirrorAnswer | null;
  /** Date.now() when the answer arrived. */
  receivedAtMs: number | null;
  /** The last read failed (the answer, if any, is older). */
  error: boolean;
}

export interface ReceiverMirrorFeed extends SpectrumFeed {
  /** Keep the feed reading while the caller shows it; the returned function lets go. */
  retain(): () => void;
  getState(): MirrorFeedState;
  onState(listener: () => void): () => void;
}

export interface MirrorFeedEnvironment {
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  /** GET the mirror; resolves with the parsed JSON body, rejects on a failed request. */
  read(signal: AbortSignal): Promise<unknown>;
  visible(): boolean;
  onVisibilityChange(listener: () => void): () => void;
}

/** Delays after failed reads, in order; the last one repeats. */
export const MIRROR_READ_RETRY_MS: readonly number[] = [1_000, 2_000, 5_000];
const READ_TIMEOUT_MS = 4_000;

async function readWithFetch(signal: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort);
  const timer = setTimeout(abort, READ_TIMEOUT_MS);
  try {
    const response = await fetch(MIRROR_ROUTE, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    if (!response.ok) throw new Error(`mirror ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export function browserFeedEnvironment(): MirrorFeedEnvironment {
  return {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    read: readWithFetch,
    visible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    onVisibilityChange: (listener) => {
      if (typeof document === 'undefined') return () => undefined;
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

const INITIAL: MirrorFeedState = Object.freeze({ answer: null, receivedAtMs: null, error: false });

/** Whether a new answer changes what a viewer shows (beyond the ages, which the viewer advances itself). */
function answerChanged(previous: MirrorAnswer | null, next: MirrorAnswer): boolean {
  return !previous || previous.rev !== next.rev || previous.frameRev !== next.frameRev
    || previous.source?.id !== next.source?.id || (previous.source === null) !== (next.source === null);
}

export function createMirrorFeed(environment: MirrorFeedEnvironment = browserFeedEnvironment()): ReceiverMirrorFeed {
  const env = environment;
  let state: MirrorFeedState = INITIAL;
  let holders = 0;
  let timer: TimerHandle | null = null;
  let controller: AbortController | null = null;
  let failures = 0;
  let drawnFrame: string | null = null;
  let offVisibility: (() => void) | null = null;
  const stateListeners = new Set<() => void>();
  const spectrumListeners = new Set<(frame: SpectrumFrame) => void>();

  function setState(next: MirrorFeedState): void {
    state = next;
    for (const listener of [...stateListeners]) {
      try {
        listener();
      } catch {
        // One failing subscriber must not stop the others.
      }
    }
  }

  function active(): boolean {
    return holders > 0 && env.visible();
  }

  function clearTimer(): void {
    if (timer !== null) env.clearTimeout(timer);
    timer = null;
  }

  function schedule(ms: number): void {
    clearTimer();
    if (active()) timer = env.setTimeout(() => { timer = null; read(); }, ms);
  }

  function emit(answer: MirrorAnswer): void {
    const frame = answer.frame;
    if (!frame || !answer.source) return;
    // Each published frame is drawn once (a waterfall row each), also when it is old.
    const key = `${answer.source.id}:${answer.frameRev}`;
    if (key === drawnFrame) return;
    drawnFrame = key;
    const decoded = spectrumFromMirrorFrame(frame, answer.state);
    if (!decoded) return;
    for (const listener of [...spectrumListeners]) {
      try {
        listener(decoded);
      } catch {
        // A canvas error must not block other listeners.
      }
    }
  }

  function read(): void {
    if (!active() || controller) return;
    const current = new AbortController();
    controller = current;
    env.read(current.signal).then(
      (body) => {
        if (controller !== current) return;
        const answer = normalizeMirrorAnswer(body);
        if (!answer) throw new Error('not a mirror answer');
        failures = 0;
        const changed = answerChanged(state.answer, answer) || state.error;
        if (changed) setState({ answer, receivedAtMs: env.now(), error: false });
        emit(answer);
        const lost = !answer.source || answer.sourceAgeMs === null || answer.sourceAgeMs > answer.sourceLostMs;
        return lost ? MIRROR_POLL_LOST_MS : MIRROR_POLL_MS;
      },
    ).catch(() => {
      if (controller !== current) return undefined;
      const delay = MIRROR_READ_RETRY_MS[Math.min(failures, MIRROR_READ_RETRY_MS.length - 1)];
      failures += 1;
      if (!state.error) setState({ ...state, error: true });
      return delay;
    }).then((delay) => {
      if (controller !== current) return;
      controller = null;
      if (typeof delay === 'number') schedule(delay);
    });
  }

  function onVisibility(): void {
    if (active()) {
      if (!controller && timer === null) read();
    } else {
      clearTimer();
      controller?.abort();
      controller = null;
    }
  }

  return {
    retain() {
      holders += 1;
      if (holders === 1) {
        // A view mounted now draws the newest frame even when no new one comes (a stopped radio).
        drawnFrame = null;
        offVisibility = env.onVisibilityChange(onVisibility);
        read();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holders -= 1;
        if (holders > 0) return;
        offVisibility?.();
        offVisibility = null;
        clearTimer();
        controller?.abort();
        controller = null;
      };
    },
    getState() {
      return state;
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => { stateListeners.delete(listener); };
    },
    onSpectrum(listener) {
      spectrumListeners.add(listener);
      return () => { spectrumListeners.delete(listener); };
    },
  };
}
