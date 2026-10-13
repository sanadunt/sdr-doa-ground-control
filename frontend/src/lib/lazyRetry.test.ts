import { describe, expect, it } from 'vitest';
import { failedChunkUrl, importWithRetry } from './lazyRetry';

const ORIGIN = 'http://127.0.0.1:8787';
const noWait = () => Promise.resolve();
const chunkError = (url: string) => new TypeError(`Failed to fetch dynamically imported module: ${url}`);

describe('lazy chunk retry', () => {
  it('re-imports a failed chunk under a new URL, since the browser caches the failure', async () => {
    const imported: string[] = [];
    const result = await importWithRetry(
      () => Promise.reject(chunkError(`${ORIGIN}/assets/TacticalMap-abc123.js`)),
      (module: { TacticalMap: string }) => module.TacticalMap,
      { delays: [10, 20], wait: noWait, origin: ORIGIN, importUrl: (url) => { imported.push(url); return Promise.resolve({ TacticalMap: 'map' }); } },
    );
    expect(result).toBe('map');
    expect(imported).toEqual([`${ORIGIN}/assets/TacticalMap-abc123.js?retry=1`]);
  });

  it('retries the original loader when the error names no chunk', async () => {
    let calls = 0;
    const load = () => (++calls === 1 ? Promise.reject(new Error('network')) : Promise.resolve({ Page: 'page' }));
    await expect(importWithRetry(load, (module) => module.Page, { delays: [10], wait: noWait, origin: ORIGIN })).resolves.toBe('page');
    expect(calls).toBe(2);
  });

  it('gives the last error to the boundary after every attempt failed', async () => {
    const waits: number[] = [];
    let calls = 0;
    const load = () => Promise.reject(new Error(`attempt ${++calls}`));
    await expect(importWithRetry(load, (module: unknown) => module, { delays: [10, 20], wait: (ms) => { waits.push(ms); return Promise.resolve(); }, origin: ORIGIN })).rejects.toThrow('attempt 3');
    expect(waits).toEqual([10, 20]);
  });

  it('only retries URLs of this console\'s own chunks', () => {
    expect(failedChunkUrl(chunkError(`${ORIGIN}/assets/TacticalMap-abc.js`), ORIGIN)).toBe(`${ORIGIN}/assets/TacticalMap-abc.js`);
    expect(failedChunkUrl(new TypeError(`error loading dynamically imported module: ${ORIGIN}/assets/x.js`), ORIGIN)).toBe(`${ORIGIN}/assets/x.js`);
    expect(failedChunkUrl(chunkError('https://evil.example/assets/x.js'), ORIGIN)).toBeNull();
    expect(failedChunkUrl(chunkError(`${ORIGIN}/api/snapshot`), ORIGIN)).toBeNull();
    expect(failedChunkUrl(new Error('Importing a module script failed.'), ORIGIN)).toBeNull();
  });
});
