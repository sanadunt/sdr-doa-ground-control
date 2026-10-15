/**
 * Console end of the Receiver bridge: one instance per console page, created
 * in App and shared by the Receiver page (which attaches the frame window on
 * load) and the Overview spectrum dock (which sends commands and draws
 * spectrum frames). The protocol is in receiverBridgeProtocol.ts.
 *
 * Messages are accepted only from the attached frame window on this page's
 * own origin. Commands sent before the frame says hello wait in a short
 * queue; every command settles, with TIMEOUT when the frame does not answer.
 * The Receiver's tuning is kept as a TuneView: the highest tune rev seen in a
 * status or in a command result, so a tune result shows before the next status.
 * Its marker list is kept as the newest receiver:markers (highest rev); it
 * changes only when someone marks, so it is state like the status.
 * Nothing here touches `window` until attach(), so creating a bridge is safe
 * during server rendering.
 */
import {
  BRIDGE_CHANNEL,
  BRIDGE_VERSION,
  COMMAND_TIMEOUT_MS,
  HELLO_TIMEOUT_MS,
  LONG_COMMAND_TYPES,
  MAX_QUEUED_COMMANDS,
  START_TIMEOUT_MS,
  clampSubscription,
  commandMessage,
  parseFrameMessage,
} from './receiverBridgeProtocol';
import type {
  BridgeCommand,
  ConsoleMessageType,
  ReceiverHello,
  ReceiverMarkers,
  ReceiverStatus,
  ResultCode,
  ResultTune,
  SpectrumFrame,
  Subscription,
  TuneSource,
} from './receiverBridgeProtocol';

export type BridgePhase = 'idle' | 'connecting' | 'ready' | 'unresponsive';
export type ReceiverBuild = 'unknown' | 'built' | 'missing';

export interface BridgeResult {
  ok: boolean;
  code: ResultCode;
  message?: string;
  /** The tuning after a tune, vfo, start or radio command, as the frame reported it. */
  tune?: ResultTune;
  /** A marker-add's new marker. */
  markerId?: string;
}

export interface BridgeLastResult extends BridgeResult {
  id: string;
  type: ConsoleMessageType;
}

/** The Receiver's centre and active VFO with the stamp of the change that set them. */
export interface TuneView {
  rev: number;
  by: TuneSource;
  /** The console command that made the change, when by is 'console'. */
  commandId: string | null;
  /** The last rev made on the Receiver page. */
  receiverRev: number;
  centerHz: number | null;
  vfoHz: number | null;
}

export interface BridgeState {
  /** idle: no frame attached; connecting: loaded, waiting for hello; unresponsive: no hello in time. */
  phase: BridgePhase;
  /** Result of the one-time probe for the built Receiver. */
  build: ReceiverBuild;
  hello: ReceiverHello | null;
  status: ReceiverStatus | null;
  /** null until a status with a tune stamp arrives from the attached frame. */
  tune: TuneView | null;
  /** The Receiver's spectrum markers; null until the attached frame sends them. */
  markers: ReceiverMarkers | null;
  lastResult: BridgeLastResult | null;
}

export interface ReceiverBridge {
  /** Bind the loaded frame window; called on every iframe load. */
  attach(frameWindow: BridgeFrameWindow): void;
  /** Forget the frame window; queued (unsent) commands are kept for the next attach. */
  detach(): void;
  /** Post a command (synchronously when the frame is ready) and settle with its result. */
  send(command: BridgeCommand): Promise<BridgeResult>;
  /** Set the spectrum subscription; it is re-sent after every hello. */
  subscribe(options: { spectrum: boolean; bins?: number; fps?: number; spanHz?: number }): void;
  getState(): BridgeState;
  /** For useSyncExternalStore. */
  onState(listener: () => void): () => void;
  /** RX spectrum and scan frames go to canvases directly; they are never React state. */
  onSpectrum(listener: (frame: SpectrumFrame) => void): () => void;
  /** Probe once whether the Receiver build is being served. */
  probeBuild(): void;
}

/** What the bridge needs from the frame's window. */
export interface BridgeFrameWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

interface BridgeMessageEvent {
  origin: string;
  source: unknown;
  data: unknown;
}

/** What the bridge needs from the console's own window. */
export interface BridgeHostWindow {
  location: { origin: string };
  addEventListener(type: 'message', listener: (event: BridgeMessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: BridgeMessageEvent) => void): void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface BridgeEnvironment {
  /** The console window, resolved lazily; null outside a browser. */
  host(): BridgeHostWindow | null;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  /** Resolves with the HTTP status of the build probe; rejects on a network error. */
  probe(url: string): Promise<number>;
  random(): number;
}

/** A script every Receiver build serves; GET because the console has no HEAD handler. */
export const RECEIVER_BUILD_PROBE_URL = '/receiver/receiver-boot.js';
const PROBE_TIMEOUT_MS = 8_000;

async function probeWithFetch(url: string): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    // Only the status matters; do not download the script body.
    void response.body?.cancel().catch(() => undefined);
    return response.status;
  } finally {
    clearTimeout(timer);
  }
}

function browserEnvironment(): BridgeEnvironment {
  return {
    host: () => (typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window as unknown as BridgeHostWindow : null),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    probe: probeWithFetch,
    random: () => Math.random(),
  };
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The Receiver offers its Mock SDR only with ?mock=1 on a loopback host. A
 * console page opened as http://127.0.0.1:8787/?mock=1 passes that on to the
 * frame and to console:start; any other host or value leaves it off.
 */
export function consoleRequestsMockSdr(location: Pick<Location, 'hostname' | 'search'>): boolean {
  return LOOPBACK_HOSTS.has(location.hostname.toLowerCase()) && new URLSearchParams(location.search).get('mock') === '1';
}

interface PendingCommand {
  id: string;
  type: ConsoleMessageType;
  message: Record<string, unknown>;
  posted: boolean;
  timer: TimerHandle;
  resolve(result: BridgeResult): void;
}

const INITIAL_STATE: BridgeState = Object.freeze({ phase: 'idle', build: 'unknown', hello: null, status: null, tune: null, markers: null, lastResult: null });

/** The tuning a status reports; null when the frame sent no tune stamp. */
export function tuneViewFromStatus(status: ReceiverStatus): TuneView | null {
  if (!status.tune) return null;
  const { rev, by, id, receiverRev } = status.tune;
  return { rev, by, commandId: id, receiverRev, centerHz: status.centerHz, vfoHz: status.vfo?.frequencyHz ?? null };
}

export function tuneViewFromResult(tune: ResultTune): TuneView {
  return { rev: tune.rev, by: tune.by, commandId: tune.id, receiverRev: tune.receiverRev, centerHz: tune.centerHz, vfoHz: tune.vfoHz };
}

/** The newer of two tunings by rev; receiverRev never goes back. Returns `current` when nothing changes. */
export function mergeTuneView(current: TuneView | null, next: TuneView | null): TuneView | null {
  if (!next) return current;
  if (!current) return next;
  if (next.rev > current.rev) return next.receiverRev >= current.receiverRev ? next : { ...next, receiverRev: current.receiverRev };
  return next.receiverRev > current.receiverRev ? { ...current, receiverRev: next.receiverRev } : current;
}

export function createReceiverBridge(environment: BridgeEnvironment = browserEnvironment()): ReceiverBridge {
  const env = environment;
  let state: BridgeState = INITIAL_STATE;
  let host: BridgeHostWindow | null = null;
  let target: BridgeFrameWindow | null = null;
  let helloTimer: TimerHandle | null = null;
  let subscription: Subscription | null = null;
  let postedSubscriptionKey: string | null = null;
  let lastStatusSeq = -1;
  let commandCounter = 0;
  let probing = false;
  const pending = new Map<string, PendingCommand>();
  const queue: PendingCommand[] = [];
  const stateListeners = new Set<() => void>();
  const spectrumListeners = new Set<(frame: SpectrumFrame) => void>();

  function setState(patch: Partial<BridgeState>): void {
    state = { ...state, ...patch };
    for (const listener of [...stateListeners]) {
      try {
        listener();
      } catch {
        // One failing subscriber must not stop the others.
      }
    }
  }

  function nextId(): string {
    commandCounter += 1;
    const random = Math.floor(env.random() * 0x7fffffff).toString(36);
    return `c${commandCounter}-${random || '0'}`;
  }

  function post(message: Record<string, unknown>): boolean {
    if (!target || !host) return false;
    try {
      target.postMessage(message, host.location.origin);
      return true;
    } catch {
      // A frame that is navigating away cannot take messages.
      return false;
    }
  }

  function settle(entry: PendingCommand, result: BridgeResult): void {
    env.clearTimeout(entry.timer);
    pending.delete(entry.id);
    const queued = queue.indexOf(entry);
    if (queued >= 0) queue.splice(queued, 1);
    const tune = result.tune ? mergeTuneView(state.tune, tuneViewFromResult(result.tune)) : state.tune;
    setState({ lastResult: { id: entry.id, type: entry.type, ...result }, tune });
    entry.resolve(result);
  }

  /** Commands already posted to a document that is gone will never be answered. */
  function expirePosted(): void {
    for (const entry of [...pending.values()]) {
      if (entry.posted) settle(entry, { ok: false, code: 'TIMEOUT' });
    }
  }

  function postSubscription(force: boolean): void {
    if (!subscription || state.phase !== 'ready') return;
    const key = JSON.stringify(subscription);
    if (!force && key === postedSubscriptionKey) return;
    // The frame answers with a result; nothing waits for it.
    if (post({ ch: BRIDGE_CHANNEL, v: BRIDGE_VERSION, type: 'console:subscribe', id: nextId(), ...subscription })) postedSubscriptionKey = key;
  }

  function flushQueue(): void {
    while (queue.length && state.phase === 'ready') {
      const entry = queue.shift() as PendingCommand;
      if (!pending.has(entry.id)) continue;
      entry.posted = post(entry.message);
      if (!entry.posted) {
        settle(entry, { ok: false, code: 'NOT_READY' });
      }
    }
  }

  function clearHelloTimer(): void {
    if (helloTimer !== null) env.clearTimeout(helloTimer);
    helloTimer = null;
  }

  const onMessage = (event: BridgeMessageEvent): void => {
    if (!host || !target || event.source !== target || event.origin !== host.location.origin) return;
    const message = parseFrameMessage(event.data);
    if (!message) return;
    switch (message.type) {
      case 'receiver:hello': {
        clearHelloTimer();
        const becameReady = state.phase !== 'ready';
        // A hello also proves the build is served.
        setState({ phase: 'ready', hello: message.hello, build: 'built' });
        postSubscription(becameReady);
        flushQueue();
        return;
      }
      case 'receiver:status':
        if (message.status.seq <= lastStatusSeq) return;
        lastStatusSeq = message.status.seq;
        setState({ status: message.status, tune: mergeTuneView(state.tune, tuneViewFromStatus(message.status)) });
        return;
      // RX and scan frames go to the same canvases; the dock draws the one of its mode.
      case 'receiver:spectrum':
      case 'receiver:sweep':
        for (const listener of [...spectrumListeners]) {
          try {
            listener(message.frame);
          } catch {
            // A canvas error must not block other listeners.
          }
        }
        return;
      case 'receiver:result': {
        const entry = pending.get(message.result.id);
        if (!entry) return;
        const { ok, code, message: text, tune, markerId } = message.result;
        const result: BridgeResult = { ok, code };
        if (text) result.message = text;
        if (tune) result.tune = tune;
        if (markerId) result.markerId = markerId;
        settle(entry, result);
        return;
      }
      case 'receiver:markers':
        if (state.markers && message.markers.rev <= state.markers.rev) return;
        setState({ markers: message.markers });
        return;
      default:
        return;
    }
  };

  function listen(): boolean {
    if (host) return true;
    host = env.host();
    if (!host) return false;
    host.addEventListener('message', onMessage);
    return true;
  }

  return {
    attach(frameWindow) {
      if (!listen()) return;
      expirePosted();
      clearHelloTimer();
      target = frameWindow;
      lastStatusSeq = -1;
      postedSubscriptionKey = null;
      setState({ phase: 'connecting', hello: null, status: null, tune: null, markers: null });
      post({ ch: BRIDGE_CHANNEL, v: BRIDGE_VERSION, type: 'console:hello' });
      helloTimer = env.setTimeout(() => {
        helloTimer = null;
        if (state.phase === 'connecting') setState({ phase: 'unresponsive' });
      }, HELLO_TIMEOUT_MS);
    },

    detach() {
      clearHelloTimer();
      expirePosted();
      if (host) host.removeEventListener('message', onMessage);
      host = null;
      target = null;
      postedSubscriptionKey = null;
      lastStatusSeq = -1;
      if (state.phase !== 'idle' || state.status !== null || state.hello !== null || state.tune !== null || state.markers !== null) {
        setState({ phase: 'idle', hello: null, status: null, tune: null, markers: null });
      }
    },

    send(command) {
      return new Promise<BridgeResult>((resolve) => {
        const id = nextId();
        const timeoutMs = LONG_COMMAND_TYPES.has(command.type) ? START_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
        const entry: PendingCommand = {
          id,
          type: command.type,
          message: commandMessage(id, command),
          posted: false,
          resolve,
          timer: env.setTimeout(() => {
            if (pending.has(id)) settle(entry, { ok: false, code: 'TIMEOUT' });
          }, timeoutMs),
        };
        pending.set(id, entry);
        if (state.phase === 'ready' && target) {
          // Posted inside the caller's click handler, so the frame can still
          // use the gesture for the USB chooser and audio.
          entry.posted = post(entry.message);
          if (!entry.posted) settle(entry, { ok: false, code: 'NOT_READY' });
          return;
        }
        if (queue.length >= MAX_QUEUED_COMMANDS) {
          settle(entry, { ok: false, code: 'NOT_READY' });
          return;
        }
        queue.push(entry);
      });
    },

    subscribe(options) {
      subscription = clampSubscription(options);
      postSubscription(false);
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

    probeBuild() {
      if (probing || state.build !== 'unknown') return;
      probing = true;
      env.probe(RECEIVER_BUILD_PROBE_URL).then(
        (status) => {
          if (state.build === 'unknown') setState({ build: status >= 200 && status < 300 ? 'built' : 'missing' });
        },
        () => {
          if (state.build === 'unknown') setState({ build: 'missing' });
        },
      ).finally(() => { probing = false; });
    },
  };
}
