import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getConfigPatchStatus, getConfigReported, normalizeConfigCommandStatus, normalizeConfigReported, sendConfigPatch } from './api';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<{ status: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const REPORTED = {
  available: true,
  code: null,
  now_ms: 1000,
  broker: { host: '10.90.0.1', port: 9001, transport: 'websockets', connection: 'connected' },
  base_config_rev: 42,
  base_config_rev_source: 'config_reported',
  reported: { config_rev: 42, received_at_ms: 0, age_ms: 1200, retained: true, synthetic: false, source: 'v1+v2' },
  values: { center_frequency_hz: 416588000, gain_db: 15.5, vfo_frequency_hz: null, vfo_bandwidth_hz: 'x', vfo_squelch_db: Number.NaN, extra: 1 },
  value_sources: { center_frequency_hz: 'v1_config_reported', gain_db: 'v1_config_reported', vfo_frequency_hz: 'mqtt' },
  value_received_at_ms: { center_frequency_hz: 900, gain_db: -1, vfo_frequency_hz: 1.5 },
  pending_command_id: null,
};

describe('getConfigReported', () => {
  it('reads the reported config without credentials beyond same-origin', async () => {
    const calls = fakeFetch([{ status: 200, body: REPORTED }]);
    const reported = await getConfigReported();
    expect(calls[0].url).toBe('/api/mqtt/config-reported');
    expect(calls[0].init.credentials).toBe('same-origin');
    expect(calls[0].init.method).toBeUndefined();
    expect(reported.baseConfigRev).toBe(42);
    expect(reported.broker).toEqual({ host: '10.90.0.1', port: 9001, transport: 'websockets', connection: 'connected' });
    expect(reported.values).toEqual({ center_frequency_hz: 416588000, gain_db: 15.5, vfo_frequency_hz: null, vfo_bandwidth_hz: null, vfo_squelch_db: null });
    expect(reported.valueSources.vfo_frequency_hz).toBeNull();
    expect(reported.valueReceivedAtMs).toEqual({ center_frequency_hz: 900, gain_db: null, vfo_frequency_hz: null, vfo_bandwidth_hz: null, vfo_squelch_db: null });
    expect(reported.reported?.synthetic).toBe(false);
  });

  it('normalizes an unavailable monitor and bad revisions', () => {
    const reported = normalizeConfigReported({ available: false, code: 'MQTT_MONITOR_DISABLED', base_config_rev: -1, base_config_rev_source: 'ack', broker: { connection: 'disabled' } });
    expect(reported.available).toBe(false);
    expect(reported.code).toBe('MQTT_MONITOR_DISABLED');
    expect(reported.baseConfigRev).toBeNull();
    expect(reported.baseConfigRevSource).toBeNull();
    expect(() => normalizeConfigReported([])).toThrow();
  });
});

describe('sendConfigPatch', () => {
  it('posts the reviewed changes with confirm true and reads the accepted command', async () => {
    const calls = fakeFetch([{ status: 202, body: { ok: true, command_id: 'gc-abc', state: 'published', topic: 'sdr/v1/uav-01/cmd/config/patch', qos: 1, base_config_rev: 42, issued_ts_ms: 0, expires_ts_ms: 60000, ttl_ms: 60000, changes: { center_frequency_hz: 433920000 } } }]);
    const accepted = await sendConfigPatch({ changes: { center_frequency_hz: 433_920_000, ...({ restart: 1 } as object) }, base_config_rev: 42, confirm: true });
    expect(calls[0].url).toBe('/api/mqtt/config-patch');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.credentials).toBe('same-origin');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ changes: { center_frequency_hz: 433920000 }, base_config_rev: 42, confirm: true });
    expect(accepted).toMatchObject({ commandId: 'gc-abc', state: 'published', qos: 1, ttlMs: 60000, changes: { center_frequency_hz: 433920000 } });
  });

  it('keeps the error code and body of a refusal', async () => {
    fakeFetch([{ status: 409, body: { ok: false, code: 'CONFIG_REVISION_STALE', error: 'stale', current_base_config_rev: 43 } }]);
    const failure = await sendConfigPatch({ changes: { gain_db: 10 }, base_config_rev: 42, confirm: true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('CONFIG_REVISION_STALE');
    expect((failure as ApiError).status).toBe(409);
    expect((failure as ApiError).details.current_base_config_rev).toBe(43);
  });

  it('rejects an accepted response without a command id', async () => {
    fakeFetch([{ status: 202, body: { ok: true } }]);
    await expect(sendConfigPatch({ changes: { gain_db: 10 }, base_config_rev: 42, confirm: true })).rejects.toThrow('invalid shape');
  });
});

describe('getConfigPatchStatus', () => {
  const STATUS = {
    command_id: 'gc-abc', state: 'acked', final: false, now_ms: 1, issued_ts_ms: 0, expires_ts_ms: 60000, base_config_rev: 42,
    changes: { center_frequency_hz: 433920000 }, puback_reason: 0, echoed: true, monitor_restarted: false,
    ack: { status: 'applied', config_rev: 43, readback_ok: true, error_code: null, current_config_rev: null, changed_fields: ['center_frequency_hz', 7], received_at_ms: 5 },
  };

  it('reads one command by id and derives final from the state', async () => {
    const calls = fakeFetch([{ status: 200, body: STATUS }]);
    const status = await getConfigPatchStatus('gc-abc');
    expect(calls[0].url).toBe('/api/mqtt/config-patch/gc-abc');
    expect(status?.final).toBe(true);
    expect(status?.ack).toEqual({ status: 'applied', configRev: 43, readbackOk: true, errorCode: null, currentConfigRev: null, changedFields: ['center_frequency_hz'], receivedAtMs: 5 });
  });

  it('reads the latest command, or null', async () => {
    const calls = fakeFetch([{ status: 200, body: { command: null } }, { status: 200, body: { command: { ...STATUS, state: 'delivered', ack: null } } }]);
    await expect(getConfigPatchStatus()).resolves.toBeNull();
    const latest = await getConfigPatchStatus();
    expect(calls[0].url).toBe('/api/mqtt/config-patch');
    expect(latest).toMatchObject({ state: 'delivered', final: false, ack: null });
  });

  it('refuses an invalid id before any request, and a mismatched answer', async () => {
    const calls = fakeFetch([{ status: 200, body: { ...STATUS, command_id: 'gc-other' } }]);
    await expect(getConfigPatchStatus('../admin')).rejects.toThrow('invalid command id');
    expect(calls).toHaveLength(0);
    await expect(getConfigPatchStatus('gc-abc')).rejects.toThrow('invalid shape');
  });

  it('drops unknown states', () => {
    expect(normalizeConfigCommandStatus({ ...STATUS, state: 'flying' })).toBeNull();
    expect(normalizeConfigCommandStatus({ ...STATUS, command_id: 'has space' })).toBeNull();
  });
});
