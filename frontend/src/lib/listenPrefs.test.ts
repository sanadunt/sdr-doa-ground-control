import { describe, expect, it } from 'vitest';
import {
  FOLLOW_NODE_STORAGE_KEY,
  LISTEN_MODE_OPTIONS,
  LISTEN_MODE_STORAGE_KEY,
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
