/**
 * Per-browser listen preferences of the Overview spectrum dock: the
 * demodulation mode and "follow node frequency". Validated on restore; every
 * storage access is guarded, so a blocked or private storage only loses the
 * preference.
 *
 * followNodeStore and listenModeStore hold the current value for the whole
 * console page, so App can change it while the dock is not mounted (a retune
 * or a mode change on the Receiver page) and a mounted dock re-renders
 * (useSyncExternalStore).
 */
import { preferenceStorage } from './preferenceStore';
import { LISTEN_MODES, isListenMode } from './receiverBridgeProtocol';
import type { ListenMode } from './receiverBridgeProtocol';

export const LISTEN_MODE_STORAGE_KEY = 'sdr-console-listen-mode';
export const FOLLOW_NODE_STORAGE_KEY = 'sdr-console-follow-node';
export const DEFAULT_LISTEN_MODE: ListenMode = 'nfm';
export const DEFAULT_FOLLOW_NODE = true;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

// localStorage, with writes copied to the console server (lib/preferenceStore.ts).
function defaultStorage(): StorageLike | null {
  return preferenceStorage();
}

function read(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(storage: StorageLike | null, key: string, value: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Local persistence is optional; the in-memory choice still applies.
  }
}

/** Upper-case labels in the order the select shows them. */
export const LISTEN_MODE_OPTIONS: ReadonlyArray<{ value: ListenMode; label: string }> = LISTEN_MODES.map((value) => ({ value, label: value.toUpperCase() }));

export function loadListenMode(storage: StorageLike | null = defaultStorage()): ListenMode {
  const stored = read(storage, LISTEN_MODE_STORAGE_KEY);
  return isListenMode(stored) ? stored : DEFAULT_LISTEN_MODE;
}

export function saveListenMode(mode: ListenMode, storage: StorageLike | null = defaultStorage()): void {
  if (isListenMode(mode)) write(storage, LISTEN_MODE_STORAGE_KEY, mode);
}

export function loadFollowNode(storage: StorageLike | null = defaultStorage()): boolean {
  const stored = read(storage, FOLLOW_NODE_STORAGE_KEY);
  return stored === 'false' ? false : stored === 'true' ? true : DEFAULT_FOLLOW_NODE;
}

export function saveFollowNode(follow: boolean, storage: StorageLike | null = defaultStorage()): void {
  write(storage, FOLLOW_NODE_STORAGE_KEY, follow ? 'true' : 'false');
}

export interface PreferenceValueStore<T> {
  get(): T;
  /** Saves the value and notifies subscribers; an equal value does nothing. */
  set(value: T): void;
  subscribe(listener: () => void): () => void;
}

/** A value read from storage on first use and written back on every change. */
export function createPreferenceValueStore<T>(load: () => T, save: (value: T) => void): PreferenceValueStore<T> {
  let loaded = false;
  let value: T;
  const listeners = new Set<() => void>();
  const get = (): T => {
    if (!loaded) {
      value = load();
      loaded = true;
    }
    return value;
  };
  return {
    get,
    set(next) {
      if (loaded && Object.is(next, value)) return;
      value = next;
      loaded = true;
      save(next);
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // One failing subscriber must not stop the others.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export const followNodeStore: PreferenceValueStore<boolean> = createPreferenceValueStore(() => loadFollowNode(), (follow) => saveFollowNode(follow));
export const listenModeStore: PreferenceValueStore<ListenMode> = createPreferenceValueStore(() => loadListenMode(), (mode) => saveListenMode(mode));
