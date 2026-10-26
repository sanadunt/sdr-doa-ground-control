import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ConfigReadbackError, normalizeConsoleConfig, updateConsoleConfig } from '../api';
import {
  DATA_OUT_ERROR_CODES,
  DATA_OUT_PORT,
  DEFAULT_DATA_OUT_HOSTS,
  MAX_DATA_OUT_HOSTS,
  addDataOutHost,
  checkDataOutDraft,
  dataOutErrorNotice,
  dataOutUrlHost,
  normalizeDataOutHost,
  normalizeDataOutHostList,
} from './dataOutHosts';
import { noticeText } from './errorNotice';
import { translate } from './i18n';
import type { Lang } from './i18n';

interface Cases {
  defaults: string[];
  port: number;
  max_hosts: number;
  error_codes: string[];
  hosts: Array<[string, string | null]>;
  urls: Array<[string, string | null]>;
}

/** The cases tools/test_data_out_hosts.py runs against sdr_doa_collector.py. */
function readCases(): Cases {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  const text = process.getBuiltinModule('node:fs').readFileSync(new URL('../../../tools/fixtures/data_out_hosts.json', import.meta.url), 'utf8');
  return JSON.parse(text) as Cases;
}

const CASES = readCases();
const t = (lang: Lang) => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(lang, key, vars);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Data Out host rules (same cases as the collector)', () => {
  it('keep the defaults, port, limit and error codes of the server', () => {
    expect(DEFAULT_DATA_OUT_HOSTS).toEqual(CASES.defaults);
    expect(DATA_OUT_PORT).toBe(CASES.port);
    expect(MAX_DATA_OUT_HOSTS).toBe(CASES.max_hosts);
    expect([...DATA_OUT_ERROR_CODES]).toEqual(CASES.error_codes);
  });

  it.each(CASES.hosts)('normalize host %j to %j', (input, expected) => {
    expect(normalizeDataOutHost(input)).toBe(expected);
  });

  it.each(CASES.urls)('read the host of URL %j as %j', (input, expected) => {
    expect(dataOutUrlHost(input)).toBe(expected);
  });

  it('read every saved form back as itself, and refuse IPv4-mapped addresses', () => {
    for (const [, expected] of CASES.hosts) {
      if (expected !== null) expect(normalizeDataOutHost(expected)).toBe(expected);
    }
    // The collector refuses these too: Python may save a mapped address as a dotted quad.
    for (const host of ['::ffff:c0a8:6464', '::ffff:0:0', '0:0:0:0:0:ffff:7f00:1', '[::ffff:a00:1]']) {
      expect(normalizeDataOutHost(host)).toBeNull();
    }
    expect(normalizeDataOutHostList(['doasdr.local', '::ffff:0:c0a8:6464'])).toEqual(['doasdr.local', '::ffff:0:c0a8:6464']);
    expect(() => normalizeDataOutHostList(['doasdr.local', '::ffff:192.168.100.100'])).toThrow();
  });
});

describe('Data Out host list draft', () => {
  it('adds a typed host in its saved form, once, up to the limit', () => {
    expect(addDataOutHost(DEFAULT_DATA_OUT_HOSTS, ' RDF.local. ')).toEqual({ ok: true, value: [...DEFAULT_DATA_OUT_HOSTS, 'rdf.local'] });
    expect(addDataOutHost(DEFAULT_DATA_OUT_HOSTS, 'DOASDR.local')).toEqual({ ok: false, error: 'config.dataOutHostDuplicate', vars: { host: 'doasdr.local' } });
    expect(addDataOutHost(DEFAULT_DATA_OUT_HOSTS, '*.local')).toEqual({ ok: false, error: 'config.dataOutHostInvalid' });
    expect(addDataOutHost(DEFAULT_DATA_OUT_HOSTS, 'http://rdf.local:8081')).toEqual({ ok: false, error: 'config.dataOutHostInvalid' });
    const full = Array.from({ length: MAX_DATA_OUT_HOSTS }, (_, index) => `node${index}.local`);
    expect(addDataOutHost(full, 'rdf.local')).toEqual({ ok: false, error: 'config.dataOutHostsTooMany', vars: { max: 16 } });
  });

  it('accepts a URL whose host is in the list and returns what the server keeps', () => {
    expect(checkDataOutDraft(' http://rdf.local:8081/ ', ['rdf.local'], 'http://doasdr.local:8081')).toEqual({
      ok: true,
      value: { base_url: 'http://rdf.local:8081', data_out_hosts: ['rdf.local'] },
    });
  });

  it('names the hosts and the port when the URL is outside the list', () => {
    const result = checkDataOutDraft('http://rdf.local:8081', DEFAULT_DATA_OUT_HOSTS, 'http://doasdr.local:8081');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('baseUrl');
    expect(noticeText(t('en'), result.notice)).toBe('Use http://<host>:8081 with a host from the list: doasdr.local, 192.168.100.100, 127.0.0.1, localhost.');
    expect(noticeText(t('id'), result.notice)).toBe('Pakai http://<host>:8081 dengan host dari daftar: doasdr.local, 192.168.100.100, 127.0.0.1, localhost.');
    const port = checkDataOutDraft('http://rdf.local:9999', ['rdf.local'], 'http://rdf.local:8081');
    expect(!port.ok && port.field).toBe('baseUrl');
  });

  it('keeps the host of an unchanged URL in the list', () => {
    const result = checkDataOutDraft('http://doasdr.local:8081', ['rdf.local'], 'http://doasdr.local:8081');
    expect(result).toEqual({ ok: false, field: 'hosts', notice: { key: 'config.dataOutHostInUse', vars: { host: 'doasdr.local' } } });
    expect(checkDataOutDraft('http://doasdr.local:8081', [], 'http://doasdr.local:8081')).toEqual({ ok: false, field: 'hosts', notice: { key: 'config.dataOutHostsEmpty' } });
    expect(checkDataOutDraft('  ', ['rdf.local'], 'http://doasdr.local:8081')).toEqual({ ok: false, field: 'baseUrl', notice: { key: 'config.baseUrlRequired' } });
  });
});

describe('Data Out errors from the console', () => {
  it('translate each code onto its field, with the list the server sent', () => {
    const details = { data_out_hosts: ['doasdr.local', 'rdf.local'], port: 8081, host: 'doasdr.local' };
    const notAllowed = dataOutErrorNotice(new ApiError('x', 400, 'DATA_OUT_URL_NOT_ALLOWED', true, details));
    expect(notAllowed?.field).toBe('baseUrl');
    expect(notAllowed && noticeText(t('en'), notAllowed.notice)).toBe('Use http://<host>:8081 with a host from the list: doasdr.local, rdf.local.');
    expect(dataOutErrorNotice(new ApiError('x', 400, 'DATA_OUT_HOST_IN_USE', true, details))).toEqual({ field: 'hosts', notice: { key: 'config.dataOutHostInUse', vars: { host: 'doasdr.local' } } });
    expect(dataOutErrorNotice(new ApiError('x', 400, 'DATA_OUT_HOSTS_EMPTY', true, {}))?.notice).toEqual({ key: 'config.dataOutHostsEmpty' });
    expect(dataOutErrorNotice(new ApiError('x', 400, 'DATA_OUT_HOSTS_TOO_MANY', true, {}))?.notice).toEqual({ key: 'config.dataOutHostsTooMany', vars: { max: 16 } });
    expect(dataOutErrorNotice(new ApiError('x', 400, 'DATA_OUT_HOST_INVALID', true, {}))).toEqual({ field: 'hosts', notice: { key: 'config.dataOutHostInvalid' } });
  });

  it('leave every other error to the generic notice', () => {
    expect(dataOutErrorNotice(new ApiError('x', 400, 'ORIGIN_REJECTED', true, {}))).toBeNull();
    expect(dataOutErrorNotice(new ApiError('x', 400, null, true, {}))).toBeNull();
    expect(dataOutErrorNotice(new Error('DATA_OUT_URL_NOT_ALLOWED'))).toBeNull();
  });

  it('ignore a malformed list in the error body', () => {
    const odd = dataOutErrorNotice(new ApiError('x', 400, 'DATA_OUT_URL_NOT_ALLOWED', true, { data_out_hosts: ['rdf.local', 7, null] }));
    expect(odd && noticeText(t('en'), odd.notice)).toBe('Use http://<host>:8081 with a host from the list: rdf.local.');
  });
});

describe('console config with the host list', () => {
  const base = { base_url: 'http://rdf.local:8081', mqtt_host: '127.0.0.1', mqtt_port: 1883, refresh_seconds: 2 };

  it('reads a saved list and refuses one the server would never send', () => {
    expect(normalizeConsoleConfig({ ...base, data_out_hosts: ['rdf.local', 'fd00::1'] }).data_out_hosts).toEqual(['rdf.local', 'fd00::1']);
    expect(normalizeConsoleConfig(base).data_out_hosts).toBeUndefined();
    for (const bad of [[], ['RDF.local'], ['rdf.local', 'rdf.local'], ['*.local'], 'rdf.local', Array.from({ length: 17 }, (_, index) => `n${index}.local`)]) {
      expect(() => normalizeConsoleConfig({ ...base, data_out_hosts: bad })).toThrow('Data Out host list');
    }
    expect(normalizeDataOutHostList(['doasdr.local'])).toEqual(['doasdr.local']);
  });

  it('report a host list the server did not keep as a read-back mismatch', async () => {
    const sent = { ...base, data_out_hosts: ['rdf.local', 'doasdr.local'] };
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => new Response(
      JSON.stringify(init?.method === 'POST' ? { ok: true } : { ...sent, data_out_hosts: ['rdf.local'] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await expect(updateConsoleConfig(sent)).rejects.toBeInstanceOf(ConfigReadbackError);
  });

  it('accept the list read back unchanged', async () => {
    const sent = { ...base, data_out_hosts: ['rdf.local', 'doasdr.local'] };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(sent), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(updateConsoleConfig(sent)).resolves.toEqual(sent);
  });
});
