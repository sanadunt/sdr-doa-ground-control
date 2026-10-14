import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ConfigReadbackError, fetchWithTimeout, updateConsoleConfig } from '../api';
import { translate } from './i18n';
import type { Lang } from './i18n';
import { errorNotice, noticeText } from './errorNotice';

const t = (lang: Lang) => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(lang, key, vars);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('error notices (AUD-99)', () => {
  it('keep console-side failures as keys so they follow the language', () => {
    const timeout = Object.assign(new Error('request timed out after 10000 ms'), { name: 'TimeoutError', timeoutMs: 10_000 });
    expect(errorNotice(timeout, 'app.readError.snapshotFailed')).toEqual({ key: 'app.readError.timedOut', vars: { seconds: 10 } });
    expect(noticeText(t('id'), errorNotice(timeout, 'app.readError.snapshotFailed'))).toBe('Console tidak menjawab dalam 10 dtk.');
    expect(noticeText(t('en'), errorNotice(new ConfigReadbackError('x'), 'config.connectionRejected'))).toMatch(/did not read back the connection settings/);
    expect(errorNotice(new ApiError('request failed (502)', 502, null, false), 'common.requestFailed')).toEqual({ key: 'common.requestFailedStatus', vars: { status: 502 } });
    expect(noticeText(t('id'), errorNotice(new TypeError('Failed to fetch'), 'common.requestFailed'))).toBe('Server console tidak bisa dihubungi (Failed to fetch).');
    expect(errorNotice('boom', 'monitor.readFailed')).toEqual({ key: 'monitor.readFailed' });
    expect(errorNotice(new Error(''), 'monitor.readFailed')).toEqual({ key: 'monitor.readFailed' });
  });

  it('show a server error text as received', () => {
    expect(errorNotice(new ApiError('base_url host is not allowed', 400, null), 'app.readError.snapshotFailed')).toEqual({ text: 'base_url host is not allowed' });
  });

  it('read the timeout from the bounded request itself', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_input: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    const pending = fetchWithTimeout('/api/snapshot', {}, 4_000).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(errorNotice(await pending, 'app.readError.snapshotFailed')).toEqual({ key: 'app.readError.timedOut', vars: { seconds: 4 } });
  });

  it('mark a config read-back mismatch so the page can translate it', async () => {
    const saved = { base_url: 'http://doasdr.local:8081', mqtt_host: '127.0.0.1', mqtt_port: 1883, refresh_seconds: 2 };
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => new Response(
      JSON.stringify(init?.method === 'POST' ? { ok: true } : { ...saved, refresh_seconds: 5 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await expect(updateConsoleConfig(saved)).rejects.toBeInstanceOf(ConfigReadbackError);
  });

  it('tell a generic HTTP failure apart from a server message', async () => {
    vi.stubGlobal('fetch', async () => new Response('not json', { status: 502 }));
    const error = await updateConsoleConfig({ base_url: 'http://x', mqtt_host: '127.0.0.1', mqtt_port: 1, refresh_seconds: 2 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).serverMessage).toBe(false);
    expect(noticeText(t('id'), errorNotice(error, 'config.connectionRejected'))).toBe('Permintaan gagal (HTTP 502)');
  });
});
