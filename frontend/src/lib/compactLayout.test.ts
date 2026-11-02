import { describe, expect, it } from 'vitest';
import {
  HOVER_NONE_QUERY, LANDSCAPE_QUERY, POINTER_COARSE_QUERY,
  applyLayoutOverride, compactLayoutFor, layoutOverrideFrom, readCompactLayout, subscribeCompactLayout,
} from './compactLayout';
import type { MatchMediaLike } from './compactLayout';

/** A browser whose media queries answer from a table; listeners are counted. */
function fakeMatchMedia(answers: Record<string, boolean>): MatchMediaLike & { listeners: Map<string, Set<() => void>> } {
  const listeners = new Map<string, Set<() => void>>();
  const matchMedia = ((query: string) => ({
    matches: answers[query] === true,
    addEventListener: (_type: 'change', listener: () => void) => {
      if (!listeners.has(query)) listeners.set(query, new Set());
      listeners.get(query)?.add(listener);
    },
    removeEventListener: (_type: 'change', listener: () => void) => { listeners.get(query)?.delete(listener); },
  })) as MatchMediaLike & { listeners: Map<string, Set<() => void>> };
  matchMedia.listeners = listeners;
  return matchMedia;
}

const device = (hoverNone: boolean, pointerCoarse: boolean, landscape: boolean) => fakeMatchMedia({
  [HOVER_NONE_QUERY]: hoverNone, [POINTER_COARSE_QUERY]: pointerCoarse, [LANDSCAPE_QUERY]: landscape,
});

describe('compact layout detection', () => {
  it('is compact only for touch without hover, at any width', () => {
    // A phone or tablet: no hover, a finger.
    expect(readCompactLayout(device(true, true, true))).toBe('compact-landscape');
    expect(readCompactLayout(device(true, true, false))).toBe('compact-portrait');
    // A PC with a mouse, and a touch laptop whose primary pointer is its touchpad or mouse.
    expect(readCompactLayout(device(false, false, true))).toBeNull();
    expect(readCompactLayout(device(false, true, true))).toBeNull();
    // A TV remote or a stylus that cannot hover but points finely.
    expect(readCompactLayout(device(true, false, true))).toBeNull();
    expect(compactLayoutFor(true, true, false)).toBe('compact-portrait');
  });

  it('stays the PC layout without matchMedia or when a query throws', () => {
    expect(readCompactLayout(null)).toBeNull();
    const throwing: MatchMediaLike = () => { throw new Error('unsupported'); };
    expect(readCompactLayout(throwing)).toBeNull();
    expect(() => subscribeCompactLayout(() => undefined, throwing)()).not.toThrow();
    expect(() => subscribeCompactLayout(() => undefined, null)()).not.toThrow();
  });

  it('follows all three queries and stops following on cleanup', () => {
    const matchMedia = device(true, true, true);
    let changes = 0;
    const stop = subscribeCompactLayout(() => { changes += 1; }, matchMedia);
    expect([...matchMedia.listeners.keys()].sort()).toEqual([HOVER_NONE_QUERY, LANDSCAPE_QUERY, POINTER_COARSE_QUERY].sort());
    for (const set of matchMedia.listeners.values()) for (const listener of set) listener();
    expect(changes).toBe(3);
    stop();
    expect([...matchMedia.listeners.values()].every((set) => set.size === 0)).toBe(true);
  });

  it('takes ?layout= for one load and ignores anything else', () => {
    expect(layoutOverrideFrom('?layout=compact')).toBe('compact');
    expect(layoutOverrideFrom('?mock=1&layout=compact-portrait')).toBe('compact-portrait');
    expect(layoutOverrideFrom('?layout=desktop')).toBe('desktop');
    expect(layoutOverrideFrom('?layout=tablet')).toBeNull();
    expect(layoutOverrideFrom('')).toBeNull();
    expect(applyLayoutOverride(null, 'compact', false)).toBe('compact-portrait');
    expect(applyLayoutOverride(null, 'compact', true)).toBe('compact-landscape');
    expect(applyLayoutOverride('compact-landscape', 'desktop', true)).toBeNull();
    expect(applyLayoutOverride(null, 'compact-landscape', false)).toBe('compact-landscape');
    expect(applyLayoutOverride('compact-portrait', null, true)).toBe('compact-portrait');
  });
});
