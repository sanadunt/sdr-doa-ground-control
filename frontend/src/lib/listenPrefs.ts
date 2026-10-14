/**
 * Per-browser listen preferences of the Overview spectrum dock: the
 * demodulation mode and "follow node frequency". Validated on restore; every
 * storage access is guarded, so a blocked or private storage only loses the
 * preference.
 */
import { LISTEN_MODES, isListenMode } from './receiverBridgeProtocol';
import type { ListenMode } from './receiverBridgeProtocol';

export const LISTEN_MODE_STORAGE_KEY = 'sdr-console-listen-mode';
export const FOLLOW_NODE_STORAGE_KEY = 'sdr-console-follow-node';
export const DEFAULT_LISTEN_MODE: ListenMode = 'nfm';
export const DEFAULT_FOLLOW_NODE = true;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
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
