import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HYDRATE_TIMEOUT_MS,
  MAX_PREFERENCE_VALUE_BYTES,
  PREFERENCE_KEYS,
  PREFERENCES_PATH,
  RETRY_DELAYS_MS,
  THEME_STORAGE_KEY,
  WRITE_DEBOUNCE_MS,
  createPreferenceSync,
  isPreferenceKey,
  parsePreferenceValues,
  preferenceStorage,
  startPreferenceSync,
} from './preferenceStore';
import type { PreferenceSync } from './preferenceStore';
import { OVERVIEW_PANELS_STORAGE_KEY } from './overviewPanels';
import { FOLLOW_NODE_STORAGE_KEY, LISTEN_MODE_STORAGE_KEY } from './listenPrefs';
import { POLAR_VIEW_STORAGE_KEY } from './polarViewSettings';
import { SPECTRUM_DOCK_STORAGE_KEY } from './spectrumDockSettings';
import { COMPASS_CONFIG_STORAGE_KEY, GPS_CONFIG_STORAGE_KEY } from './sourceConfigStorage';
import { OVERLAY_SETTINGS_STORAGE_KEY } from './mapOverlaySettings';
import { LANG_STORAGE_KEY } from './i18n';

class MemoryStorage {
  readonly values = new Map<string, string>();
  writes = 0;

  getItem(key: string): string | null {
    return this.values.has(key) ? this.values.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.writes += 1;
    this.values.set(key, value);
  }
}

interface Call {
  method: string;
  body: unknown;
  keepalive: boolean;
}

type Answer = Response | Error | 'hang';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function serverDoc(values: Record<string, string>, updatedAt: number | null = 1): Response {
  return json({ version: 1, updated_at_ms: updatedAt, values });
}

/** Fake console: answers queued per method; a PUT without a queued answer echoes the merged values. */
class FakeConsole {
  readonly calls: Call[] = [];
  readonly stored: Record<string, string> = {};
  private readonly answers: Record<string, Answer[]> = { GET: [], PUT: [] };

  queue(method: 'GET' | 'PUT', answer: Answer): void {
    this.answers[method].push(answer);
  }

  puts(): Call[] {
    return this.calls.filter((call) => call.method === 'PUT');
  }

  readonly fetch = (input: string, init?: RequestInit): Promise<Response> => {
    expect(input).toBe(PREFERENCES_PATH);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    this.calls.push({ method, body, keepalive: init?.keepalive === true });
    const answer = this.answers[method].shift();
    if (answer === 'hang') {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer) return Promise.resolve(answer);
    if (method === 'PUT') {
      const values = (body as { values: Record<string, string> }).values;
      Object.assign(this.stored, values);
      return Promise.resolve(json({ ok: true, version: 1, updated_at_ms: 2, values: { ...this.stored } }));
    }
    return Promise.resolve(serverDoc({ ...this.stored }));
  };
}

const PANELS = JSON.stringify({ layers: true, polar: true, spectrum: false, control: false, nodeCollapsed: true });

describe('preference sync', () => {
  let storage: MemoryStorage;
  let console_: FakeConsole;
  let warnings: string[];
  let sync: PreferenceSync;

  beforeEach(() => {
    vi.useFakeTimers();
    storage = new MemoryStorage();
    console_ = new FakeConsole();
    warnings = [];
    sync = createPreferenceSync({
      fetch: console_.fetch,
      storage: () => storage,
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle),
      warn: (message) => warnings.push(message),
    });
  });

  afterEach(() => {
    sync.dispose();
    vi.useRealTimers();
  });

  it('stays local before it is started', async () => {
    sync.write(THEME_STORAGE_KEY, 'light');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(console_.calls).toEqual([]);
    expect(sync.state()).toBe('idle');
  });

  it('writes the server copy into storage before the first render', async () => {
    storage.setItem(THEME_STORAGE_KEY, 'dark');
    console_.queue('GET', serverDoc({ [THEME_STORAGE_KEY]: 'light', [OVERVIEW_PANELS_STORAGE_KEY]: PANELS, 'not-a-preference': 'x' }));
    await expect(sync.hydrate()).resolves.toBe('ready');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(storage.getItem(OVERVIEW_PANELS_STORAGE_KEY)).toBe(PANELS);
    expect(storage.getItem('not-a-preference')).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(console_.puts()).toEqual([]);
  });

  it('uploads local preferences the server lacks, once (migration)', async () => {
    storage.setItem(LANG_STORAGE_KEY, 'id');
    storage.setItem(OVERVIEW_PANELS_STORAGE_KEY, PANELS);
    storage.setItem('browsdr-device-id', 'device-1');
    console_.queue('GET', serverDoc({ [LANG_STORAGE_KEY]: 'en' }, null));
    await sync.hydrate();
    // The server wins for the key it has.
    expect(storage.getItem(LANG_STORAGE_KEY)).toBe('en');
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    expect(console_.puts()).toHaveLength(1);
    expect(console_.puts()[0].body).toEqual({ values: { [OVERVIEW_PANELS_STORAGE_KEY]: PANELS } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(console_.puts()).toHaveLength(1);
    expect(sync.pendingKeys()).toEqual([]);
  });

  it('debounces writes into one PUT with the latest values', async () => {
    console_.queue('GET', serverDoc({}));
    await sync.hydrate();
    sync.write(THEME_STORAGE_KEY, 'light');
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS - 100);
    sync.write(THEME_STORAGE_KEY, 'dark');
    sync.write(LANG_STORAGE_KEY, 'id');
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS - 1);
    expect(console_.puts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(console_.puts()).toHaveLength(1);
    expect(console_.puts()[0].body).toEqual({ values: { [THEME_STORAGE_KEY]: 'dark', [LANG_STORAGE_KEY]: 'id' } });
    expect(console_.puts()[0].keepalive).toBe(false);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('sends nothing when a value equals the server copy', async () => {
    console_.queue('GET', serverDoc({ [THEME_STORAGE_KEY]: 'light', [OVERVIEW_PANELS_STORAGE_KEY]: PANELS }));
    await sync.hydrate();
    // Mount-time re-saves of the restored values.
    sync.write(THEME_STORAGE_KEY, 'light');
    sync.write(OVERVIEW_PANELS_STORAGE_KEY, PANELS);
    // A change that is undone before the debounce fires.
    sync.write(LANG_STORAGE_KEY, 'id');
    await vi.advanceTimersByTimeAsync(100);
    sync.write(THEME_STORAGE_KEY, 'dark');
    sync.write(THEME_STORAGE_KEY, 'light');
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    expect(console_.puts()).toHaveLength(1);
    expect(console_.puts()[0].body).toEqual({ values: { [LANG_STORAGE_KEY]: 'id' } });
    // The confirmed value is now the server copy.
    sync.write(LANG_STORAGE_KEY, 'id');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(console_.puts()).toHaveLength(1);
  });

  it('retries a failed PUT with backoff and keeps the latest value', async () => {
    console_.queue('GET', serverDoc({}));
    await sync.hydrate();
    console_.queue('PUT', json({ ok: false, code: 'PREFERENCES_WRITE_FAILED' }, 500));
    console_.queue('PUT', new TypeError('network down'));
    sync.write(THEME_STORAGE_KEY, 'light');
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    expect(console_.puts()).toHaveLength(1);
    // A write during the backoff waits for the retry instead of sending at once.
    sync.write(LANG_STORAGE_KEY, 'id');
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] - 1);
    expect(console_.puts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(console_.puts()).toHaveLength(2);
    expect(console_.puts()[1].body).toEqual({ values: { [THEME_STORAGE_KEY]: 'light', [LANG_STORAGE_KEY]: 'id' } });
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]);
    expect(console_.puts()).toHaveLength(3);
    expect(console_.stored).toEqual({ [THEME_STORAGE_KEY]: 'light', [LANG_STORAGE_KEY]: 'id' });
    expect(sync.pendingKeys()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(console_.puts()).toHaveLength(3);
  });

  it('drops values the server refuses instead of retrying them', async () => {
    console_.queue('GET', serverDoc({}));
    await sync.hydrate();
    console_.queue('PUT', json({ ok: false, code: 'PREFERENCE_VALUE_INVALID' }, 400));
    sync.write(THEME_STORAGE_KEY, 'light');
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(console_.puts()).toHaveLength(1);
    expect(sync.pendingKeys()).toEqual([]);
    expect(warnings.join(' ')).toContain('400');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('keeps an oversized value in this browser only', async () => {
    console_.queue('GET', serverDoc({}));
    await sync.hydrate();
    const huge = JSON.stringify(['x'.repeat(MAX_PREFERENCE_VALUE_BYTES)]);
    sync.write('sdr-web-bookmarks', huge);
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    expect(console_.puts()).toEqual([]);
    expect(storage.getItem('sdr-web-bookmarks')).toBe(huge);
    expect(warnings.join(' ')).toContain('sdr-web-bookmarks');
  });

  it('stays local when the console has no preferences route', async () => {
    console_.queue('GET', json({ error: 'not found' }, 404));
    await expect(sync.hydrate()).resolves.toBe('unsupported');
    sync.write(THEME_STORAGE_KEY, 'light');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(console_.calls).toHaveLength(1);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('treats an HTML answer (Vite dev server) as no preferences route', async () => {
    console_.queue('GET', new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    await expect(sync.hydrate()).resolves.toBe('unsupported');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(console_.calls).toHaveLength(1);
  });

  it('renders after the timeout and catches up when the server answers later', async () => {
    storage.setItem(THEME_STORAGE_KEY, 'dark');
    console_.queue('GET', 'hang');
    console_.queue('GET', serverDoc({ [THEME_STORAGE_KEY]: 'light', [LANG_STORAGE_KEY]: 'id', [POLAR_VIEW_STORAGE_KEY]: '{"head":90}' }));
    const hydrated = sync.hydrate(HYDRATE_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(HYDRATE_TIMEOUT_MS);
    await expect(hydrated).resolves.toBe('offline');
    // While the server copy is unknown: a default filled into empty storage
    // is not queued, a real change to a stored value is.
    sync.write(LANG_STORAGE_KEY, 'en');
    sync.write(THEME_STORAGE_KEY, 'dark');
    sync.write(POLAR_VIEW_STORAGE_KEY, '{"head":0}');
    sync.write(POLAR_VIEW_STORAGE_KEY, '{"head":180}');
    expect(console_.puts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    expect(sync.state()).toBe('ready');
    expect(storage.getItem(LANG_STORAGE_KEY)).toBe('id');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(storage.getItem(POLAR_VIEW_STORAGE_KEY)).toBe('{"head":180}');
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    expect(console_.puts()).toHaveLength(1);
    expect(console_.puts()[0].body).toEqual({ values: { [POLAR_VIEW_STORAGE_KEY]: '{"head":180}' } });
  });

  it('keeps retrying the first read with backoff', async () => {
    console_.queue('GET', new TypeError('offline'));
    console_.queue('GET', json({ error: 'busy' }, 503));
    await sync.hydrate();
    expect(sync.state()).toBe('offline');
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    expect(sync.state()).toBe('offline');
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]);
    expect(sync.state()).toBe('ready');
    expect(console_.calls.map((call) => call.method)).toEqual(['GET', 'GET', 'GET']);
  });

  it('carries writes from the Receiver frame or another tab', async () => {
    console_.queue('GET', serverDoc({}));
    await sync.hydrate();
    sync.noteExternalWrite('SDRSetting', '{"radio":{"centerFreq":433.92}}', null);
    sync.noteExternalWrite('ReceiverSweepSettings', null, '{"startMHz":100}');
    sync.noteExternalWrite(null, null, null);
    sync.noteExternalWrite('browsdr-device-id', 'device-2', 'device-1');
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    expect(console_.puts()).toHaveLength(1);
    expect(console_.puts()[0].body).toEqual({ values: { SDRSetting: '{"radio":{"centerFreq":433.92}}' } });
  });

  it('flushes with keepalive when the page is hidden', async () => {
    console_.queue('GET', serverDoc({}));
    await sync.hydrate();
    sync.write(THEME_STORAGE_KEY, 'light');
    sync.flushOnHide();
    await vi.advanceTimersByTimeAsync(0);
    expect(console_.puts()).toHaveLength(1);
    expect(console_.puts()[0].keepalive).toBe(true);
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS * 4);
    expect(console_.puts()).toHaveLength(1);
    sync.flushOnHide();
    await vi.advanceTimersByTimeAsync(0);
    expect(console_.puts()).toHaveLength(1);
  });

  it('survives a storage that throws', async () => {
    const broken = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    const blocked = createPreferenceSync({
      fetch: console_.fetch,
      storage: () => broken,
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    });
    console_.queue('GET', serverDoc({ [THEME_STORAGE_KEY]: 'light' }));
    await expect(blocked.hydrate()).resolves.toBe('ready');
    expect(() => blocked.write(LANG_STORAGE_KEY, 'id')).not.toThrow();
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    expect(console_.puts()[0].body).toEqual({ values: { [LANG_STORAGE_KEY]: 'id' } });
    blocked.dispose();
  });
});

describe('preference keys', () => {
  it('cover every preference module key and nothing else', () => {
    const moduleKeys = [
      THEME_STORAGE_KEY,
      LANG_STORAGE_KEY,
      OVERVIEW_PANELS_STORAGE_KEY,
      OVERLAY_SETTINGS_STORAGE_KEY,
      POLAR_VIEW_STORAGE_KEY,
      LISTEN_MODE_STORAGE_KEY,
      FOLLOW_NODE_STORAGE_KEY,
      SPECTRUM_DOCK_STORAGE_KEY,
      GPS_CONFIG_STORAGE_KEY,
      COMPASS_CONFIG_STORAGE_KEY,
    ];
    const receiverKeys = ['SDRSetting', 'ReceiverSweepSettings', 'sdr-web-bookmarks'];
    expect([...PREFERENCE_KEYS].sort()).toEqual([...moduleKeys, ...receiverKeys].sort());
    expect(new Set(PREFERENCE_KEYS).size).toBe(PREFERENCE_KEYS.length);
    expect(isPreferenceKey('browsdr-device-id')).toBe(false);
    expect(isPreferenceKey('browsdr-share-code')).toBe(false);
  });

  it('parse only known string values from a server answer', () => {
    expect(parsePreferenceValues(null)).toBeNull();
    expect(parsePreferenceValues({ values: [] })).toBeNull();
    const parsed = parsePreferenceValues({ values: { [THEME_STORAGE_KEY]: 'light', [LANG_STORAGE_KEY]: 1, other: 'x' } });
    expect(parsed && Object.fromEntries(parsed)).toEqual({ [THEME_STORAGE_KEY]: 'light' });
  });
});

describe('preferenceStorage adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is null without localStorage', () => {
    vi.stubGlobal('window', undefined);
    expect(preferenceStorage()).toBeNull();
  });

  it('reads and writes localStorage', () => {
    const storage = new MemoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
    const adapter = preferenceStorage();
    adapter?.setItem(THEME_STORAGE_KEY, 'light');
    adapter?.setItem('another-key', 'value');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(adapter?.getItem('another-key')).toBe('value');
  });
});

describe('startPreferenceSync', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('never holds the first render past its deadline', async () => {
    vi.useFakeTimers();
    const listeners: string[] = [];
    const storage = new MemoryStorage();
    // A request that ignores the abort signal and never answers.
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('window', { localStorage: storage, fetch, addEventListener: (type: string) => listeners.push(type) });
    vi.stubGlobal('document', { addEventListener: (type: string) => listeners.push(type), visibilityState: 'visible' });
    let done = false;
    void startPreferenceSync(HYDRATE_TIMEOUT_MS).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(HYDRATE_TIMEOUT_MS + 199);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(listeners.sort()).toEqual(['pagehide', 'storage', 'visibilitychange']);
  });
});
