import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';

/** Waits before the second and third attempt to fetch a lazy chunk. */
export const CHUNK_RETRY_DELAYS_MS: readonly number[] = [500, 1500];

// Chromium and Firefox name the chunk URL in a failed dynamic import.
const FAILED_IMPORT = /(?:Failed to fetch dynamically imported module|error loading dynamically imported module):\s*(\S+)/;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * The chunk URL of a failed dynamic import, when it is one of this console's
 * own built chunks. Anything else is not retried by URL.
 */
export function failedChunkUrl(error: unknown, origin: string): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = FAILED_IMPORT.exec(message);
  if (!match) return null;
  try {
    const url = new URL(match[1], origin);
    if (url.origin !== origin || !/^\/assets\/[A-Za-z0-9._-]+\.js$/.test(url.pathname)) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Run a dynamic import, retrying after each delay when it fails. Browsers keep
 * a failed module URL in their module map and do not fetch it again, so a retry
 * imports the same chunk under a new query string. A console restart drops
 * chunk requests for a moment; a rebuild renames the chunks, and then only a
 * reload helps, so the last error is passed on to an error boundary.
 */
export async function importWithRetry<M, T>(
  load: () => Promise<M>,
  pick: (module: M) => T,
  options: { delays?: readonly number[]; wait?: (ms: number) => Promise<void>; importUrl?: (url: string) => Promise<M>; origin?: string } = {},
): Promise<T> {
  const delays = options.delays ?? CHUNK_RETRY_DELAYS_MS;
  const wait = options.wait ?? delay;
  const importUrl = options.importUrl ?? ((url: string) => import(/* @vite-ignore */ url) as Promise<M>);
  const origin = options.origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  let lastError: unknown;
  let chunkUrl: string | null = null;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (attempt > 0) await wait(delays[attempt - 1]);
    try {
      return pick(await (chunkUrl ? importUrl(`${chunkUrl}?retry=${attempt}`) : load()));
    } catch (error: unknown) {
      lastError = error;
      chunkUrl = chunkUrl ?? failedChunkUrl(error, origin);
    }
  }
  throw lastError;
}

export function lazyWithRetry<M, T extends ComponentType<any>>(load: () => Promise<M>, pick: (module: M) => T): LazyExoticComponent<T> {
  return lazy(() => importWithRetry(load, (module) => ({ default: pick(module) })));
}
