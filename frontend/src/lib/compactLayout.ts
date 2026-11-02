import { useSyncExternalStore } from 'react';

/**
 * The compact layout for touch devices (phones and tablets, the LAN view's
 * tablet and the console on a touch screen): a device whose primary input is a
 * finger and that has no hover, at any width. A PC with a mouse never gets it,
 * so the groundstation keeps its layout. The orientation picks map beside the
 * spectrum (landscape) or above it (portrait).
 */
export type CompactLayout = 'compact-landscape' | 'compact-portrait';

export const HOVER_NONE_QUERY = '(hover: none)';
export const POINTER_COARSE_QUERY = '(pointer: coarse)';
export const LANDSCAPE_QUERY = '(orientation: landscape)';

interface MediaQueryListLike {
  matches: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
}
export type MatchMediaLike = (query: string) => MediaQueryListLike;

function windowMatchMedia(): MatchMediaLike | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return (query) => window.matchMedia(query);
}

function matches(matchMedia: MatchMediaLike, query: string): boolean {
  try {
    return matchMedia(query).matches === true;
  } catch {
    return false;
  }
}

/** The layout for a device: compact only for touch without hover. */
export function compactLayoutFor(hoverNone: boolean, pointerCoarse: boolean, landscape: boolean): CompactLayout | null {
  if (!hoverNone || !pointerCoarse) return null;
  return landscape ? 'compact-landscape' : 'compact-portrait';
}

/** The layout this browser asks for now; null without matchMedia (tests, old browsers). */
export function readCompactLayout(matchMedia: MatchMediaLike | null = windowMatchMedia()): CompactLayout | null {
  if (!matchMedia) return null;
  return compactLayoutFor(matches(matchMedia, HOVER_NONE_QUERY), matches(matchMedia, POINTER_COARSE_QUERY), matches(matchMedia, LANDSCAPE_QUERY));
}

/** Calls `onChange` when any of the three queries changes (a mouse plugged in, the device turned). */
export function subscribeCompactLayout(onChange: () => void, matchMedia: MatchMediaLike | null = windowMatchMedia()): () => void {
  if (!matchMedia) return () => undefined;
  const lists: MediaQueryListLike[] = [];
  for (const query of [HOVER_NONE_QUERY, POINTER_COARSE_QUERY, LANDSCAPE_QUERY]) {
    try {
      const list = matchMedia(query);
      list.addEventListener?.('change', onChange);
      lists.push(list);
    } catch {
      // A query this browser cannot evaluate never changes.
    }
  }
  return () => {
    for (const list of lists) list.removeEventListener?.('change', onChange);
  };
}

/**
 * `?layout=compact` (orientation from the device), `?layout=compact-landscape`,
 * `?layout=compact-portrait` or `?layout=desktop` overrides the detection for
 * one page load, for a check from a desktop browser. Anything else detects.
 */
export type LayoutOverride = CompactLayout | 'compact' | 'desktop';

export function layoutOverrideFrom(search: string): LayoutOverride | null {
  let value: string | null = null;
  try {
    value = new URLSearchParams(search).get('layout');
  } catch {
    return null;
  }
  return value === 'compact' || value === 'compact-landscape' || value === 'compact-portrait' || value === 'desktop' ? value : null;
}

/** The detected layout with an override applied. */
export function applyLayoutOverride(detected: CompactLayout | null, override: LayoutOverride | null, landscape: boolean): CompactLayout | null {
  if (override === null) return detected;
  if (override === 'desktop') return null;
  if (override === 'compact') return landscape ? 'compact-landscape' : 'compact-portrait';
  return override;
}

const NO_SUBSCRIPTION = () => () => undefined;
const subscribeWindow = (onChange: () => void) => subscribeCompactLayout(onChange);

/**
 * The layout of this page, following the device as it changes. A test passes
 * `forced` (a layout, or null for the desktop layout) and nothing is read.
 */
export function useCompactLayout(forced?: CompactLayout | null, override: LayoutOverride | null = null): CompactLayout | null {
  const read = () => {
    const matchMedia = windowMatchMedia();
    return applyLayoutOverride(readCompactLayout(matchMedia), override, matchMedia ? matches(matchMedia, LANDSCAPE_QUERY) : true);
  };
  const detected = useSyncExternalStore(forced === undefined ? subscribeWindow : NO_SUBSCRIPTION, read, () => null);
  return forced === undefined ? detected : forced;
}
