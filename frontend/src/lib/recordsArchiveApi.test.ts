import { describe, expect, it } from 'vitest';
import { RECORDS_PAGE_SIZE, RecordsRequestError, createRecordsClient, isAbortError, probePlayback } from './recordsArchiveApi';
import type { RecordsClientEnv } from './recordsArchiveApi';

const FACETS = {
  vfo_indices: [], modes: [], bandwidths_hz: [], sources: [], statuses: [], min_frequency_hz: null, max_frequency_hz: null,
  totals: { audio: 0, scan: 0, bytes: 0 }, first_ms: null, last_ms: null, free_bytes: null, now_ms: 1,
};
const ITEMS = { items: [], total: 0, totals: { audio: 0, scan: 0, bytes: 0, estimated_bytes: 0 }, offset: 0, limit: 50, now_ms: 1 };

interface Call {
  url: string;
  init: RequestInit;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}

/** A fetch whose answers the test hands out, and timers it fires itself. */
function fakeEnv() {
  const calls: Call[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const env: RecordsClientEnv = {
    fetch: (url, init) => new Promise<Response>((resolve, reject) => {
      calls.push({ url, init, resolve, reject });
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
    setTimeout: (callback, ms) => {
      const id = nextTimer++;
      timers.set(id, callback);
      void ms;
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => { timers.delete(handle as unknown as number); },
  };
  const fireTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) callback();
  };
  return { env, calls, fireTimers, timers };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Records client', () => {
  it('sends one read at a time, in order, to the archive routes', async () => {
    const { env, calls } = fakeEnv();
    const client = createRecordsClient(env);
    const facets = client.facets();
    const items = client.items(new URLSearchParams({ limit: String(RECORDS_PAGE_SIZE) }));
    await flush();
    expect(calls.map((call) => call.url)).toEqual(['/api/receiver/archive/facets']);
    expect(calls[0].init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
    expect(calls[0].init.method).toBeUndefined();
    calls[0].resolve(json(FACETS));
    expect((await facets).totals.audio).toBe(0);
    await flush();
    expect(calls.map((call) => call.url)).toEqual(['/api/receiver/archive/facets', '/api/receiver/archive/items?limit=50']);
    calls[1].resolve(json(ITEMS));
    expect((await items).limit).toBe(50);
  });

  it('builds the calendar, time line and preview paths', async () => {
    const { env, calls } = fakeEnv();
    const client = createRecordsClient(env);
    void client.calendar([1, 2, 3], 'audio').catch(() => undefined);
    await flush();
    expect(calls[0].url).toBe('/api/receiver/archive/calendar?bounds=1%2C2%2C3&type=audio');
    calls[0].resolve(json({ days: [{ audio: 1, scan: 0 }, { audio: 0, scan: 0 }], first_ms: null, last_ms: null, now_ms: 0, truncated: false }));
    void client.timeline(new URLSearchParams({ from_ms: '0', to_ms: '10' })).catch(() => undefined);
    void client.scanPreview('dddddddd-0000-4000-8000-000000000001').catch(() => undefined);
    await flush();
    expect(calls[1].url).toBe('/api/receiver/archive/timeline?from_ms=0&to_ms=10');
    calls[1].resolve(json({}, 500));
    await flush();
    expect(calls[2].url).toBe('/api/receiver/archive/scans/dddddddd-0000-4000-8000-000000000001/preview');
  });

  it('never sends a read aborted while it waits, and reports the abort', async () => {
    const { env, calls } = fakeEnv();
    const client = createRecordsClient(env);
    const first = client.facets();
    const controller = new AbortController();
    const second = client.items(new URLSearchParams(), controller.signal);
    controller.abort();
    calls.length || await flush();
    calls[0].resolve(json(FACETS));
    await first;
    await expect(second).rejects.toSatisfy(isAbortError);
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('turns a refusal into its code and tries a busy answer again', async () => {
    const { env, calls, fireTimers } = fakeEnv();
    const client = createRecordsClient(env);
    const read = client.items(new URLSearchParams());
    await flush();
    calls[0].resolve(json({ ok: false, code: 'LAN_RECORDS_BUSY', error: 'one Records read at a time' }, 429));
    await flush();
    fireTimers();
    await flush();
    expect(calls).toHaveLength(2);
    calls[1].resolve(json(ITEMS));
    expect((await read).total).toBe(0);
    const refused = client.items(new URLSearchParams({ limit: '51' }));
    await flush();
    calls[2].resolve(json({ ok: false, code: 'ARCHIVE_INVALID_REQUEST', error: 'limit must be at most 50 on the LAN view' }, 400));
    await expect(refused).rejects.toMatchObject({ name: 'RecordsRequestError', code: 'ARCHIVE_INVALID_REQUEST', status: 400 });
  });

  it('gives up on a busy console after two more tries', async () => {
    const { env, calls, fireTimers } = fakeEnv();
    const client = createRecordsClient(env);
    const read = client.facets();
    for (let attempt = 0; attempt < 3; attempt++) {
      await flush();
      calls[attempt].resolve(json({ ok: false, code: 'LAN_RECORDS_BUSY', error: 'busy' }, 429));
      await flush();
      fireTimers();
    }
    await expect(read).rejects.toMatchObject({ code: 'LAN_RECORDS_BUSY' });
    expect(calls).toHaveLength(3);
  });

  it('names a timeout and a network failure, and refuses a malformed answer', async () => {
    const { env, calls, fireTimers } = fakeEnv();
    const client = createRecordsClient(env);
    const slow = client.facets();
    await flush();
    fireTimers();
    await expect(slow).rejects.toMatchObject({ code: 'TIMEOUT', status: 0 });
    const down = client.facets();
    await flush();
    calls[1].reject(new TypeError('Failed to fetch'));
    await expect(down).rejects.toMatchObject({ code: 'NETWORK' });
    const malformed = client.facets();
    await flush();
    calls[2].resolve(json({ totals: 'x' }));
    await expect(malformed).rejects.toBeInstanceOf(TypeError);
    const html = client.facets();
    await flush();
    calls[3].resolve(new Response('<html>', { status: 403 }));
    await expect(html).rejects.toEqual(new RecordsRequestError('request failed (403)', 403, ''));
  });
});

describe('playback probe', () => {
  const url = '/api/receiver/audio-segments/0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8/audio';

  it('asks for one byte and reports nothing when the route serves the audio', async () => {
    const { env, calls } = fakeEnv();
    const probe = probePlayback(url, env);
    await flush();
    expect(calls[0].url).toBe(url);
    expect(new Headers(calls[0].init.headers).get('Range')).toBe('bytes=0-0');
    expect(calls[0].init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
    calls[0].resolve(new Response('x', { status: 206 }));
    expect(await probe).toBeNull();
  });

  it("returns the console's refusal or the failure", async () => {
    const { env, calls, fireTimers } = fakeEnv();
    const busy = probePlayback(url, env);
    await flush();
    calls[0].resolve(json({ ok: false, code: 'LAN_RECORDS_BUSY', error: 'at most 4 Records downloads at once' }, 429));
    expect(await busy).toMatchObject({ code: 'LAN_RECORDS_BUSY', status: 429 });
    const missing = probePlayback(url, env);
    await flush();
    calls[1].resolve(json({ ok: false, code: 'ARCHIVE_FILE_MISSING', error: 'The audio file is missing.' }, 404));
    expect(await missing).toMatchObject({ code: 'ARCHIVE_FILE_MISSING', status: 404 });
    const down = probePlayback(url, env);
    await flush();
    calls[2].reject(new TypeError('Failed to fetch'));
    expect(await down).toMatchObject({ code: 'NETWORK' });
    const slow = probePlayback(url, env);
    await flush();
    fireTimers();
    expect(await slow).toMatchObject({ code: 'TIMEOUT' });
    expect(await slow).toBeInstanceOf(RecordsRequestError);
  });
});
