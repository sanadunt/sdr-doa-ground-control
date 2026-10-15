import { describe, expect, it } from 'vitest';
import {
  FOLLOW_NODE_STORAGE_KEY,
  LISTEN_MODE_OPTIONS,
  LISTEN_MODE_STORAGE_KEY,
  createPreferenceValueStore,
  loadFollowNode,
  loadListenMode,
  saveFollowNode,
  saveListenMode,
} from './listenPrefs';

function memory(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, values };
}

describe('listen preferences', () => {
  it('default to NFM and following the node', () => {
    expect(loadListenMode(memory())).toBe('nfm');
    expect(loadFollowNode(memory())).toBe(true);
    expect(loadListenMode(null)).toBe('nfm');
  });

  it('restore only valid values', () => {
    expect(loadListenMode(memory({ [LISTEN_MODE_STORAGE_KEY]: 'wfm' }))).toBe('wfm');
    expect(loadListenMode(memory({ [LISTEN_MODE_STORAGE_KEY]: 'FM' }))).toBe('nfm');
    expect(loadFollowNode(memory({ [FOLLOW_NODE_STORAGE_KEY]: 'false' }))).toBe(false);
    expect(loadFollowNode(memory({ [FOLLOW_NODE_STORAGE_KEY]: '0' }))).toBe(true);
  });

  it('survive a storage that throws', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadListenMode(broken)).toBe('nfm');
    expect(() => saveListenMode('am', broken)).not.toThrow();
    expect(() => saveFollowNode(false, broken)).not.toThrow();
  });

  it('round-trip', () => {
    const storage = memory();
    saveListenMode('usb', storage);
    saveFollowNode(false, storage);
    expect(loadListenMode(storage)).toBe('usb');
    expect(loadFollowNode(storage)).toBe(false);
  });

  it('offer the modes in UI order with upper-case labels', () => {
    expect(LISTEN_MODE_OPTIONS.map((option) => option.label)).toEqual(['NFM', 'WFM', 'AM', 'USB', 'LSB', 'DSB', 'CW', 'RAW']);
  });
});

describe('page-wide listen preference stores', () => {
  it('load once, save every change and notify subscribers', () => {
    const storage = memory({ [FOLLOW_NODE_STORAGE_KEY]: 'true' });
    let loads = 0;
    const store = createPreferenceValueStore(() => { loads += 1; return loadFollowNode(storage); }, (value) => saveFollowNode(value, storage));
    expect(store.get()).toBe(true);
    expect(store.get()).toBe(true);
    expect(loads).toBe(1);
    let calls = 0;
    const unsubscribe = store.subscribe(() => { calls += 1; });
    store.set(false);
    expect(store.get()).toBe(false);
    expect(storage.values.get(FOLLOW_NODE_STORAGE_KEY)).toBe('false');
    expect(calls).toBe(1);
    // An equal value is not saved again and notifies nobody.
    store.set(false);
    expect(calls).toBe(1);
    unsubscribe();
    store.set(true);
    expect(calls).toBe(1);
    expect(loadFollowNode(storage)).toBe(true);
  });

  it('keep the mode a subscriber set before the first read', () => {
    const storage = memory({ [LISTEN_MODE_STORAGE_KEY]: 'nfm' });
    const store = createPreferenceValueStore(() => loadListenMode(storage), (mode) => saveListenMode(mode, storage));
    store.set('am');
    expect(store.get()).toBe('am');
    expect(loadListenMode(storage)).toBe('am');
  });

  it('survive a subscriber that throws', () => {
    const store = createPreferenceValueStore(() => 'nfm', () => undefined);
    let reached = false;
    store.subscribe(() => { throw new Error('broken'); });
    store.subscribe(() => { reached = true; });
    expect(() => store.set('usb')).not.toThrow();
    expect(reached).toBe(true);
  });
});
