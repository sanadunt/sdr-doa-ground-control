/**
 * Spectrum markers from the LAN view (the owner's decision of 2026-10-31).
 *
 * A viewer adds or removes one of the groundstation Receiver's markers with
 * one command: POST /api/mirror/receiver/markers ({v, id, op: 'add',
 * frequency_hz} or {v, id, op: 'remove', marker_id}). The console queues it
 * for the groundstation page that publishes the mirror, which runs it through
 * the Receiver bridge and reports the bridge's result code. The client reads
 * the command's status (GET .../markers/<id>) every MIRROR_MARK_POLL_MS until
 * it is done or expired. Nothing else is writable from the LAN view: no tune,
 * gains, scan, listen or settings.
 *
 * The marking controller holds the viewer's side: the Markers/Penanda toggle
 * (off at every mount, never saved), the picked marker, the mark on its way
 * and the last failure, as the groundstation dock does. It refuses to send
 * while the mirror has no live source (mirrorMarkBlocked).
 */
import type { MessageKey } from './i18n';
import { inMarkerRange } from './receiverBridgeProtocol';
import type { BridgeMarker } from './receiverBridgeProtocol';
import { MARKER_COMMAND_ID_PATTERN, MIRROR_LIMITS, MIRROR_MARKERS_ROUTE, MIRROR_MARKER_ERROR_CODES, MIRROR_MARKER_RESULT_CODES, MIRROR_VERSION } from './receiverMirror';
import type { MirrorMarkerErrorCode, MirrorMarkerResultCode, MirrorView } from './receiverMirror';
import { markNoticeMessage } from './spectrumView';

type TimerHandle = ReturnType<typeof setTimeout>;

/** The bridge's result, the console's refusal, or what the viewer saw: EXPIRED, NETWORK, REFUSED (any other refusal). */
export type MirrorMarkCode = MirrorMarkerResultCode | MirrorMarkerErrorCode | 'EXPIRED' | 'NETWORK' | 'REFUSED';

export interface MirrorMarkOutcome {
  ok: boolean;
  code: MirrorMarkCode;
  /** An added marker's id (also after MARKER_SAVE_FAILED: it is in the list), or the removed one's. */
  markerId: string | null;
}

export interface MirrorMarkAnswer {
  status: number;
  body: unknown;
}

export interface MirrorMarkEnvironment {
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  /** One request; rejects on a network error. */
  request(method: 'GET' | 'POST', path: string, body: string | null): Promise<MirrorMarkAnswer>;
  random(): number;
}

export interface MirrorMarkClient {
  add(frequencyHz: number): Promise<MirrorMarkOutcome>;
  remove(markerId: string): Promise<MirrorMarkOutcome>;
}

/** The status of a command on its way is read this often. */
export const MIRROR_MARK_POLL_MS = 250;
/** A command not settled this long after it was taken is given up (the console expires it after markerCommandTtlMs). */
export const MIRROR_MARK_WAIT_MS = MIRROR_LIMITS.markerCommandTtlMs + 5_000;

const REQUEST_TIMEOUT_MS = 4_000;

async function requestWithFetch(method: 'GET' | 'POST', path: string, body: string | null): Promise<MirrorMarkAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      method,
      headers: body === null ? undefined : { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body,
      signal: controller.signal,
    });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      // An answer without a JSON body keeps its status only.
    }
    return { status: response.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

export function browserMarkEnvironment(): MirrorMarkEnvironment {
  return {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    request: requestWithFetch,
    random: () => Math.random(),
  };
}

/** A command id: 'tab-' and 16 base-36 characters. */
export function markCommandId(random: () => number): string {
  let text = '';
  while (text.length < 16) text += Math.floor(random() * 36).toString(36);
  return `tab-${text.slice(0, 16)}`;
}

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined;
}

function refusal(body: unknown): MirrorMarkCode {
  const code = field(body, 'code');
  return typeof code === 'string' && (MIRROR_MARKER_ERROR_CODES as readonly string[]).includes(code) ? code as MirrorMarkerErrorCode : 'REFUSED';
}

/** The marker client of one LAN view page. */
export function createMirrorMarkClient(environment: MirrorMarkEnvironment = browserMarkEnvironment()): MirrorMarkClient {
  const env = environment;

  const wait = (ms: number) => new Promise<void>((resolve) => { env.setTimeout(resolve, ms); });

  async function send(command: Record<string, unknown>, fallbackMarkerId: string | null): Promise<MirrorMarkOutcome> {
    let id = markCommandId(env.random);
    while (!MARKER_COMMAND_ID_PATTERN.test(id)) id = markCommandId(env.random);
    const failed = (code: MirrorMarkCode): MirrorMarkOutcome => ({ ok: false, code, markerId: null });
    let answer: MirrorMarkAnswer;
    try {
      answer = await env.request('POST', MIRROR_MARKERS_ROUTE, JSON.stringify({ v: MIRROR_VERSION, id, ...command }));
    } catch {
      return failed('NETWORK');
    }
    if (answer.status !== 202) return failed(refusal(answer.body));
    const deadline = env.now() + MIRROR_MARK_WAIT_MS;
    while (env.now() < deadline) {
      await wait(MIRROR_MARK_POLL_MS);
      let status: MirrorMarkAnswer;
      try {
        status = await env.request('GET', `${MIRROR_MARKERS_ROUTE}/${id}`, null);
      } catch {
        continue; // A dropped read; the command may still run.
      }
      // Not held any more: the LAN view closed and opened again, or the console restarted.
      if (status.status === 404) return failed('EXPIRED');
      if (status.status !== 200) continue;
      const state = field(status.body, 'status');
      if (state === 'expired') return failed('EXPIRED');
      if (state !== 'done') continue;
      const rawCode = field(status.body, 'code');
      const code: MirrorMarkCode = typeof rawCode === 'string' && (MIRROR_MARKER_RESULT_CODES as readonly string[]).includes(rawCode)
        ? rawCode as MirrorMarkerResultCode
        : 'NOT_READY';
      const markerId = field(status.body, 'marker_id');
      return { ok: code === 'OK', code, markerId: typeof markerId === 'string' ? markerId : fallbackMarkerId };
    }
    return failed('EXPIRED');
  }

  return {
    add: (frequencyHz) => send({ op: 'add', frequency_hz: Math.round(frequencyHz) }, null),
    remove: (markerId) => send({ op: 'remove', marker_id: markerId }, markerId),
  };
}

/** Why the viewer cannot mark now, or null: no live groundstation page (also before the first answer), or stale frames. */
export function mirrorMarkBlocked(view: Pick<MirrorView, 'phase'>): MessageKey | null {
  switch (view.phase) {
    case 'connecting':
    case 'none':
    case 'lost':
      return 'mirror.markNoSource';
    case 'stale':
      return 'mirror.markStale';
    default:
      return null;
  }
}

const MIRROR_CODE_MESSAGES: Partial<Record<MirrorMarkCode, MessageKey>> = {
  MIRROR_NO_SOURCE: 'mirror.markNoSource',
  MIRROR_RATE_LIMITED: 'mirror.markBusy',
  MIRROR_MARKER_BUSY: 'mirror.markBusy',
  MIRROR_LAN_CLOSED: 'mirror.markLanClosed',
  EXPIRED: 'mirror.markExpired',
  NETWORK: 'mirror.markFailed',
  ORIGIN_REJECTED: 'mirror.markRefused',
  MIRROR_INVALID: 'mirror.markRefused',
  MIRROR_TOO_LARGE: 'mirror.markRefused',
  MIRROR_DUPLICATE_ID: 'mirror.markRefused',
  MIRROR_UNKNOWN_COMMAND: 'mirror.markExpired',
  REFUSED: 'mirror.markRefused',
};

/** The operator's words for a failed marker command: the Receiver's codes as on the groundstation dock, then the mirror's. */
export function mirrorMarkMessage(code: MirrorMarkCode): MessageKey {
  const own = MIRROR_CODE_MESSAGES[code];
  if (own) return own;
  return (MIRROR_MARKER_RESULT_CODES as readonly string[]).includes(code) ? markNoticeMessage(code as MirrorMarkerResultCode) : 'mirror.markRefused';
}

export interface MirrorMarkState {
  /** Marking is on (the Markers/Penanda toggle). */
  on: boolean;
  selectedId: string | null;
  /** The newest add on its way, drawn dashed until it settles. */
  pendingHz: number | null;
  /** Commands on their way. */
  sending: number;
  /** The last failed command. */
  notice: MirrorMarkCode | null;
}

/** What the controller needs to know of the mirror at the moment of a click. */
export interface MirrorMarkContext {
  blocked: MessageKey | null;
  /** The Receiver's Freq Shift: the marker range is in device Hz. */
  frequencyShiftHz: number;
  markers: readonly BridgeMarker[];
}

export interface MirrorMarkController {
  getState(): MirrorMarkState;
  subscribe(listener: () => void): () => void;
  toggle(): void;
  mark(hz: number, context: MirrorMarkContext): void;
  select(id: string | null): void;
  remove(id: string, context: MirrorMarkContext): void;
  /** Delete/Backspace removes the picked marker; Ctrl/⌘+Z removes this viewer's last mark still listed. */
  key(action: 'remove' | 'undo', context: MirrorMarkContext): void;
}

/** This viewer's own marks Ctrl/⌘+Z takes back, at most. */
const MARK_UNDO_DEPTH = 20;

export function createMirrorMarkController(client: MirrorMarkClient): MirrorMarkController {
  let state: MirrorMarkState = { on: false, selectedId: null, pendingHz: null, sending: 0, notice: null };
  let token = 0;
  let own: string[] = [];
  const listeners = new Set<() => void>();

  function set(patch: Partial<MirrorMarkState>): void {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  }

  function usable(context: MirrorMarkContext): boolean {
    return state.on && context.blocked === null;
  }

  function remove(id: string, context: MirrorMarkContext): void {
    if (!usable(context)) return;
    set({ sending: state.sending + 1, notice: null });
    void client.remove(id).then((outcome) => {
      const gone = outcome.ok || outcome.code === 'MARKER_NOT_FOUND' || outcome.code === 'MARKER_SAVE_FAILED';
      if (gone) own = own.filter((mine) => mine !== id);
      set({
        sending: Math.max(0, state.sending - 1),
        notice: outcome.ok ? null : outcome.code,
        selectedId: gone && state.selectedId === id ? null : state.selectedId,
      });
    });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    toggle() {
      set(state.on ? { on: false, selectedId: null, notice: null } : { on: true });
    },
    mark(hz, context) {
      if (!usable(context) || !Number.isFinite(hz)) return;
      if (!inMarkerRange(hz, context.frequencyShiftHz)) {
        set({ notice: 'OUT_OF_RANGE' });
        return;
      }
      token += 1;
      const mine = token;
      set({ pendingHz: hz, sending: state.sending + 1, notice: null });
      void client.add(hz).then((outcome) => {
        const patch: Partial<MirrorMarkState> = { sending: Math.max(0, state.sending - 1), notice: outcome.ok ? null : outcome.code };
        if (token === mine) patch.pendingHz = null;
        // Also a marker whose save failed is in the list: pick it, so Remove is one tap away.
        if (outcome.markerId) {
          own = [...own.filter((id) => id !== outcome.markerId), outcome.markerId].slice(-MARK_UNDO_DEPTH);
          patch.selectedId = outcome.markerId;
        }
        set(patch);
      });
    },
    select(id) {
      if (state.on) set({ selectedId: id });
    },
    remove,
    key(action, context) {
      if (action === 'remove') {
        const picked = context.markers.find((marker) => marker.id !== null && marker.id === state.selectedId);
        if (picked?.id) remove(picked.id, context);
        return;
      }
      const listed = new Set(context.markers.map((marker) => marker.id));
      const last = [...own].reverse().find((id) => listed.has(id));
      if (last) remove(last, context);
    },
  };
}
