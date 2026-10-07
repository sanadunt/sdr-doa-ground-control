import * as api from './api';
import { afterEach, describe, expect, it, vi } from 'vitest';

type HealthClient = (signal?: AbortSignal) => Promise<unknown>;

const VALID_SNAPSHOT = {
  checked_at_ms: 1_750_000_000_000,
  usb_telemetry: 'PRESENT',
  ppp_interface: 'UP',
  raspberry_peer: 'REACHABLE',
};

const VALID_CONFIG = {
  version: 1,
  base_url: 'http://doasdr.local:8081',
  mqtt_host: '10.90.0.1',
  mqtt_port: 9001,
  mqtt_transport: 'websockets' as const,
  mqtt_ws_path: '/mqtt',
  mqtt_username: '',
  mqtt_password_set: false,
  refresh_seconds: 0,
  rdf_node_id: 'uav-01',
};

function isHealthClient(value: unknown): value is HealthClient {
  return typeof value === 'function';
}

function systemHealthClient(): HealthClient {
  const client: unknown = Reflect.get(api, 'getSystemHealth');
  expect(client).toBeTypeOf('function');
  if (!isHealthClient(client)) throw new Error('getSystemHealth is not available');
  return client;
}

function responseForJson(body: unknown): Response {
  const response = new Response();
  Object.defineProperty(response, 'json', { value: async () => body });
  return response;
}

function stubJsonResponse(body: unknown) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseForJson(body));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ConsoleConfig RDF Node identity', () => {
  it('requires the configured ID to be one safe topic segment', () => {
    for (const rdf_node_id of ['node_2', 'node-2', 'A'.repeat(64)]) {
      expect(api.normalizeConsoleConfig({ ...VALID_CONFIG, rdf_node_id }).rdf_node_id)
        .toBe(rdf_node_id);
    }
    for (const rdf_node_id of ['.', '..', '', 'node.part', 'node/part', 'A'.repeat(65)]) {
      expect(() => api.normalizeConsoleConfig({ ...VALID_CONFIG, rdf_node_id }))
        .toThrow('console config response has an invalid shape');
    }
    const { rdf_node_id: _missing, ...legacyConfig } = VALID_CONFIG;
    expect(() => api.normalizeConsoleConfig(legacyConfig))
      .toThrow('console config response has an invalid shape');
  });

  it('posts rdf_node_id and verifies it in the GET readback', async () => {
    const expected = { ...VALID_CONFIG, rdf_node_id: 'node_02' };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(responseForJson(expected))
      .mockResolvedValueOnce(responseForJson(expected));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.updateConsoleConfig(expected)).resolves.toEqual(expected);

    const post = fetchMock.mock.calls[0];
    expect(post?.[0]).toBe('/api/console-config');
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ rdf_node_id: 'node_02' });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/console-config');
  });

  it('rejects readback when the stored rdf_node_id differs from the request', async () => {
    const expected = { ...VALID_CONFIG, rdf_node_id: 'node_02' };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(responseForJson(expected))
      .mockResolvedValueOnce(responseForJson(VALID_CONFIG));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.updateConsoleConfig(expected))
      .rejects.toThrow('console config read-back did not match the requested values');
  });
});

describe('getSystemHealth', () => {
  it('accepts the documented health statuses from the same-origin endpoint', async () => {
    const client = systemHealthClient();
    const samples = [
      { ...VALID_SNAPSHOT },
      { ...VALID_SNAPSHOT, usb_telemetry: 'NOT_FOUND', ppp_interface: 'DOWN', raspberry_peer: 'NOT_PROBED' },
      { ...VALID_SNAPSHOT, usb_telemetry: 'AMBIGUOUS', ppp_interface: 'UNKNOWN', raspberry_peer: 'UNKNOWN' },
      { ...VALID_SNAPSHOT, usb_telemetry: 'UNKNOWN', raspberry_peer: 'NO_REPLY' },
    ];

    for (const sample of samples) {
      const fetchMock = stubJsonResponse(sample);

      await expect(client()).resolves.toEqual(sample);
      const call = fetchMock.mock.calls[0];
      expect(call?.[0]).toBe('/api/system-health');
      expect(call?.[1]?.credentials).toBe('same-origin');
      expect(call?.[1]?.cache).toBe('no-store');
      expect(call?.[1]?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([
    ['usb_telemetry', 'CONNECTED'],
    ['ppp_interface', 'CONNECTED'],
    ['raspberry_peer', 'ONLINE'],
  ] as Array<[string, string]>)('rejects an unknown health status in %s', async (field, status) => {
    const client = systemHealthClient();
    stubJsonResponse({ ...VALID_SNAPSHOT, [field]: status });

    await expect(client()).rejects.toThrow('System Health response has an invalid shape');
  });

  it.each([
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['string', '1750000000000'],
  ] as Array<[string, unknown]>)('rejects an invalid checked_at_ms (%s)', async (_label, checkedAt) => {
    const client = systemHealthClient();
    stubJsonResponse({ ...VALID_SNAPSHOT, checked_at_ms: checkedAt });

    await expect(client()).rejects.toThrow('System Health response has an invalid shape');
  });

  it('aborts the bounded request when its caller signal is cancelled', async () => {
    const client = systemHealthClient();
    let observedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        reject(new Error('bounded request signal is missing'));
        return;
      }
      observedSignal = signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const caller = new AbortController();

    const request = client(caller.signal);
    await Promise.resolve();
    caller.abort(new DOMException('caller cancelled', 'AbortError'));

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
