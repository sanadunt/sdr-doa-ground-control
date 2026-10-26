/**
 * Server copy of the operator's browser preferences.
 *
 * Every preference module still reads and validates its own localStorage
 * value. This module adds one thing: the console server keeps the same
 * strings (`/api/preferences`, a JSON file on the console host), so another
 * browser, a cleared cache or a new container on the same data volume gets
 * them back.
 *
 * - Before React renders, `startPreferenceSync()` reads the server copy
 *   (about 800 ms at most) and writes it into localStorage, so the existing
 *   loaders see it. Keys the server lacks but this browser has are uploaded
 *   once (migration from a browser-only install).
 * - Every preference write goes through `writePreference()` (or the
 *   `preferenceStorage()` adapter): localStorage first, then a debounced PUT
 *   of the changed keys, retried with backoff and flushed with `keepalive`
 *   when the page is hidden. A value equal to the server's is not sent.
 * - The embedded Receiver writes its own keys (same origin, same
 *   localStorage); the `storage` event that reaches this window carries them
 *   to the server too.
 * - In the LAN view the server answers `read_only: true`: its copy only
 *   fills keys this browser does not have yet, and nothing is ever sent, so
 *   a tablet keeps its own choices and never changes the groundstation's.
 *
 * Live data never goes through here, and nothing secret is stored.
 */

/** Exactly the per-operator preference keys; PREFERENCE_KEYS in tools/preferences_store.py must match. */
export const PREFERENCE_KEYS = [
  'sdr-console-theme',
  'sdr-console-lang',
  'sdr-console-overview-panels-v1',
  'sdr-console-basemap',
  'sdr-doa-overlay-settings-v4',
  'sdr-doa-polar-view-v1',
  'sdr-console-listen-mode',
  'sdr-console-follow-node',
  'sdr-console-spectrum-dock-v1',
  'sdr-doa-gps-source-v1',
  'sdr-doa-compass-source-v1',
  // Embedded Receiver: its settings, wide-scan settings and bookmarks.
  'SDRSetting',
  'ReceiverSweepSettings',
  'sdr-web-bookmarks',
] as const;

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

/** The console theme ('dark' | 'light'); the Receiver frame reads it too. */
export const THEME_STORAGE_KEY = 'sdr-console-theme';

export const PREFERENCES_PATH = '/api/preferences';
/** How long the first render waits for the server copy. */
export const HYDRATE_TIMEOUT_MS = 800;
export const WRITE_DEBOUNCE_MS = 500;
export const REQUEST_TIMEOUT_MS = 5_000;
/** Backoff for a failed PUT or a failed first read; the last delay repeats. */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Same bound as MAX_PREFERENCE_VALUE_BYTES on the server. */
export const MAX_PREFERENCE_VALUE_BYTES = 32 * 1024;

const KEY_SET: ReadonlySet<string> = new Set(PREFERENCE_KEYS);

export function isPreferenceKey(key: unknown): key is PreferenceKey {
  return typeof key === 'string' && KEY_SET.has(key);
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface PreferenceSyncDeps {
  fetch: FetchLike;
  /** Resolved on every access; null when storage is unavailable. */
  storage: () => StorageLike | null;
  setTimeout: (callback: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
  warn?: (message: string) => void;
}

/**
 * idle: not started (tests, or before main.tsx runs); writes stay local.
 * hydrating / offline: the server copy is not known yet; changes are kept
 * and sent once it is. ready: synced. unsupported: the server has no
 * preferences route (an older console or the Vite dev server); local only.
 * readonly: the LAN view; the server copy filled the keys this browser
 * lacked, and writes stay local.
 */
export type PreferenceSyncState = 'idle' | 'hydrating' | 'ready' | 'offline' | 'unsupported' | 'readonly';

export interface PreferenceSync {
  readonly state: () => PreferenceSyncState;
  /** Read the server copy into localStorage; resolves (never rejects) once known or failed. */
  hydrate: (timeoutMs?: number) => Promise<PreferenceSyncState>;
  /** Write localStorage and queue the value for the server. */
  write: (key: PreferenceKey, value: string) => void;
  /** A value another window (the Receiver frame, another tab) already wrote to localStorage. */
  noteExternalWrite: (key: string | null, newValue: string | null, oldValue: string | null) => void;
  /** Send queued changes now. */
  flush: () => Promise<void>;
  /** Send queued changes with `keepalive`, for pagehide. */
  flushOnHide: () => void;
  /** Keys queued for the server, for tests and diagnostics. */
  pendingKeys: () => PreferenceKey[];
  dispose: () => void;
}

function utf8Length(value: string): number {
  try {
    return new TextEncoder().encode(value).length;
  } catch {
    return value.length * 3;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The known keys with string values of a GET or PUT answer, or null when the shape is wrong. */
export function parsePreferenceValues(body: unknown): Map<PreferenceKey, string> | null {
  if (!isRecord(body) || !isRecord(body.values)) return null;
  const values = new Map<PreferenceKey, string>();
  for (const key of PREFERENCE_KEYS) {
    const value = body.values[key];
    if (typeof value === 'string' && utf8Length(value) <= MAX_PREFERENCE_VALUE_BYTES) values.set(key, value);
  }
  return values;
}

export function createPreferenceSync(deps: PreferenceSyncDeps): PreferenceSync {
  let state: PreferenceSyncState = 'idle';
  /** What the server holds, as far as this page knows. */
  const server = new Map<PreferenceKey, string>();
  /** Changes not yet confirmed by the server, latest value per key. */
  const pending = new Map<PreferenceKey, string>();
  let debounceTimer: TimerHandle | null = null;
  let retryTimer: TimerHandle | null = null;
  let retryAttempt = 0;
  let inFlight: Promise<void> | null = null;
  let disposed = false;
  const warn = deps.warn ?? (() => undefined);

  function readLocal(key: string): string | null {
    try {
      return deps.storage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  function writeLocal(key: string, value: string): void {
    try {
      deps.storage()?.setItem(key, value);
    } catch {
      // Storage can be blocked; the in-memory choice and the server copy still apply.
    }
  }

  function clearDebounce(): void {
    if (debounceTimer !== null) deps.clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  function clearRetry(): void {
    if (retryTimer !== null) deps.clearTimeout(retryTimer);
    retryTimer = null;
  }

  function nextRetryDelay(): number {
    const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
    retryAttempt += 1;
    return delay;
  }

  interface Answer {
    status: number;
    ok: boolean;
    /** Parsed JSON, or undefined when the body is not JSON. */
    body: unknown;
  }

  /** One bounded request: the deadline covers the headers and the body. */
  async function request(method: 'GET' | 'PUT', body: unknown, timeoutMs: number, keepalive = false): Promise<Answer> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = deps.setTimeout(() => controller?.abort(), timeoutMs);
    try {
      const response = await deps.fetch(PREFERENCES_PATH, {
        method,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        keepalive,
        signal: controller?.signal,
      });
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (error: unknown) {
        // An aborted body read is a failed request, not an empty answer.
        if (controller?.signal.aborted) throw error;
        parsed = undefined;
      }
      return { status: response.status, ok: response.ok, body: parsed };
    } finally {
      deps.clearTimeout(timer);
    }
  }

  function goUnsupported(): void {
    state = 'unsupported';
    pending.clear();
    clearDebounce();
    clearRetry();
  }

  function goOffline(): void {
    state = 'offline';
    clearRetry();
    if (disposed) return;
    retryTimer = deps.setTimeout(() => {
      retryTimer = null;
      void hydrate(REQUEST_TIMEOUT_MS);
    }, nextRetryDelay());
  }

  function scheduleFlush(delayMs: number): void {
    if (disposed || state !== 'ready' || retryTimer !== null) return;
    clearDebounce();
    debounceTimer = deps.setTimeout(() => {
      debounceTimer = null;
      void flush();
    }, delayMs);
  }

  function scheduleRetry(): void {
    clearRetry();
    if (disposed) return;
    retryTimer = deps.setTimeout(() => {
      retryTimer = null;
      void flush();
    }, nextRetryDelay());
  }

  async function hydrate(timeoutMs = HYDRATE_TIMEOUT_MS): Promise<PreferenceSyncState> {
    if (disposed || state === 'unsupported' || state === 'ready' || state === 'readonly') return state;
    clearRetry();
    if (state === 'idle') state = 'hydrating';
    let response: Answer;
    try {
      response = await request('GET', undefined, timeoutMs);
    } catch {
      goOffline();
      return state;
    }
    if (response.status === 404 || response.status === 405) {
      goUnsupported();
      return state;
    }
    if (!response.ok) {
      goOffline();
      return state;
    }
    const values = parsePreferenceValues(response.body);
    if (!values) {
      // A definite answer that is not a preferences document, such as the
      // Vite dev server's index.html fallback: no server copy here.
      goUnsupported();
      return state;
    }
    if (isRecord(response.body) && response.body.read_only === true) {
      // The LAN view: the groundstation's choices are only defaults here.
      for (const [key, value] of values) {
        if (!pending.has(key) && readLocal(key) === null) writeLocal(key, value);
      }
      state = 'readonly';
      pending.clear();
      clearDebounce();
      clearRetry();
      return state;
    }
    server.clear();
    for (const [key, value] of values) server.set(key, value);
    // The server copy wins, except for a key changed on this page since it loaded.
    for (const [key, value] of values) {
      if (!pending.has(key) && readLocal(key) !== value) writeLocal(key, value);
    }
    // Migration: what this browser has and the server lacks is uploaded.
    for (const key of PREFERENCE_KEYS) {
      if (values.has(key) || pending.has(key)) continue;
      const local = readLocal(key);
      if (local !== null && utf8Length(local) <= MAX_PREFERENCE_VALUE_BYTES) pending.set(key, local);
    }
    for (const [key, value] of pending) {
      if (server.get(key) === value) pending.delete(key);
    }
    state = 'ready';
    retryAttempt = 0;
    if (pending.size > 0) scheduleFlush(WRITE_DEBOUNCE_MS);
    return state;
  }

  function collectChanges(): Partial<Record<PreferenceKey, string>> {
    const changes: Partial<Record<PreferenceKey, string>> = {};
    for (const [key, value] of [...pending]) {
      if (server.get(key) === value) {
        pending.delete(key);
      } else if (utf8Length(value) > MAX_PREFERENCE_VALUE_BYTES) {
        warn(`preference ${key} is larger than ${MAX_PREFERENCE_VALUE_BYTES} bytes; kept in this browser only`);
        pending.delete(key);
      } else {
        changes[key] = value;
      }
    }
    return changes;
  }

  async function send(changes: Partial<Record<PreferenceKey, string>>, keepalive: boolean): Promise<void> {
    let response: Answer;
    try {
      response = await request('PUT', { values: changes }, REQUEST_TIMEOUT_MS, keepalive);
    } catch {
      // Also after a keepalive flush: a hidden page may come back, and an
      // unloading one drops the timer anyway.
      scheduleRetry();
      return;
    }
    if (response.ok) {
      retryAttempt = 0;
      const confirmed = parsePreferenceValues(response.body);
      if (confirmed) {
        server.clear();
        for (const [key, value] of confirmed) server.set(key, value);
      } else {
        for (const [key, value] of Object.entries(changes) as Array<[PreferenceKey, string]>) server.set(key, value);
      }
      for (const [key, value] of Object.entries(changes) as Array<[PreferenceKey, string]>) {
        if (pending.get(key) === value) pending.delete(key);
      }
      return;
    }
    if (response.status === 404 || response.status === 405) {
      goUnsupported();
      return;
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      // The server refused these values (origin, shape, size); sending them again would not help.
      warn(`preferences were not saved on the console (${response.status})`);
      for (const [key, value] of Object.entries(changes) as Array<[PreferenceKey, string]>) {
        if (pending.get(key) === value) pending.delete(key);
      }
      return;
    }
    scheduleRetry();
  }

  async function flush(): Promise<void> {
    clearDebounce();
    if (disposed || state !== 'ready') return;
    if (inFlight) {
      await inFlight;
      if (pending.size > 0) scheduleFlush(WRITE_DEBOUNCE_MS);
      return;
    }
    const changes = collectChanges();
    if (Object.keys(changes).length === 0) return;
    clearRetry();
    const current = send(changes, false).finally(() => {
      inFlight = null;
    });
    inFlight = current;
    await current;
    // Written while the PUT was on its way.
    if (pending.size > 0) scheduleFlush(WRITE_DEBOUNCE_MS);
  }

  function flushOnHide(): void {
    if (disposed || state !== 'ready') return;
    clearDebounce();
    const changes = collectChanges();
    if (Object.keys(changes).length === 0) return;
    void send(changes, true);
  }

  function note(key: PreferenceKey, value: string, previous: string | null): void {
    if (disposed || state === 'idle' || state === 'unsupported' || state === 'readonly') return;
    if (state !== 'ready') {
      // Before the server copy is known, only a real change is kept: a
      // default filled into empty storage must not replace what the server
      // holds once it answers.
      if (previous === null || previous === value) return;
      pending.set(key, value);
      return;
    }
    if (server.get(key) === value) {
      pending.delete(key);
      return;
    }
    pending.set(key, value);
    scheduleFlush(WRITE_DEBOUNCE_MS);
  }

  return {
    state: () => state,
    hydrate,
    write(key, value) {
      const previous = readLocal(key);
      writeLocal(key, value);
      note(key, value, previous);
    },
    noteExternalWrite(key, newValue, oldValue) {
      // A removal (or localStorage.clear()) elsewhere does not erase the server copy.
      if (!isPreferenceKey(key) || newValue === null) return;
      note(key, newValue, oldValue);
    },
    flush,
    flushOnHide,
    pendingKeys: () => [...pending.keys()],
    dispose() {
      disposed = true;
      clearDebounce();
      clearRetry();
    },
  };
}

// ---------------------------------------------------------------------------
// The page's single instance.
// ---------------------------------------------------------------------------

function browserStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

let pageSync: PreferenceSync | null = null;
let installed = false;

function sync(): PreferenceSync {
  if (!pageSync) {
    pageSync = createPreferenceSync({
      fetch: (input, init) => window.fetch(input, init),
      storage: browserStorage,
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle),
      warn: (message) => {
        if (typeof console !== 'undefined') console.warn(`[preferences] ${message}`);
      },
    });
  }
  return pageSync;
}

/** Read one preference from localStorage; null when absent or storage is blocked. */
export function readPreference(key: PreferenceKey): string | null {
  try {
    return browserStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Write one preference to localStorage and queue it for the console server. */
export function writePreference(key: PreferenceKey, value: string): void {
  sync().write(key, value);
}

/**
 * A Storage-shaped view for the preference modules' default storage: reads
 * go to localStorage, writes go through `writePreference`. Null when
 * localStorage is unavailable, like the modules' own default.
 */
export function preferenceStorage(): StorageLike | null {
  const storage = browserStorage();
  if (!storage) return null;
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => {
      if (isPreferenceKey(key)) writePreference(key, value);
      else storage.setItem(key, value);
    },
  };
}

/**
 * Called once by main.tsx before the first render: read the server copy
 * into localStorage and start syncing. Resolves after at most
 * HYDRATE_TIMEOUT_MS; it never rejects.
 */
export async function startPreferenceSync(timeoutMs = HYDRATE_TIMEOUT_MS): Promise<void> {
  if (typeof window === 'undefined') return;
  const instance = sync();
  if (!installed) {
    installed = true;
    window.addEventListener('storage', (event) => {
      if (event.storageArea !== null && event.storageArea !== browserStorage()) return;
      instance.noteExternalWrite(event.key, event.newValue, event.oldValue);
    });
    window.addEventListener('pagehide', () => instance.flushOnHide());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') instance.flushOnHide();
    });
  }
  // hydrate() aborts its own request at the deadline; the race only makes
  // sure the first render never waits longer, whatever the network does.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs + 200);
  });
  try {
    await Promise.race([instance.hydrate(timeoutMs).then(() => undefined), deadline]);
  } catch {
    // hydrate() handles its own failures; rendering must go on regardless.
  } finally {
    clearTimeout(timer);
  }
}
