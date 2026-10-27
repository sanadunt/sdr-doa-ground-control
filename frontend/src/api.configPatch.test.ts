import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  getConfigPatchStatus,
  getConfigReported,
  normalizeCapabilities,
  normalizeConfigCommandStatus,
  normalizeConfigReported,
  requestConfigGet,
  sendConfigPatch,
} from './api';

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

const GET_STATUS = {
  command_id: 'gc-000000000000000000000001', op: 'config.get', topic: 'sdr/v2/uav-01/cmd/config/get', state: 'acked', final: true,
  now_ms: 1, issued_ms: 0, expires_ms: 15000, base_rev: 42, changes: {}, puback_reason: 0, monitor_restarted: false,
  ack: { status: 'REJECTED', final: true, error: 'TLS_REQUIRED_FOR_SETTINGS_REPORT', reason: null, revision: 42, proof: null, persisted: null, t: 1, received_at_ms: 5 },
  settings_reported_at_ms: null,
};

const REPORTED = {
  available: true,
  code: null,
  now_ms: 1000,
  broker: { host: '10.90.0.1', port: 9001, transport: 'websockets', connection: 'connected' },
  node: { sid: 'e2fe561d', cfg: 42, health_fresh: true, health_age_ms: 400, remote_commands: true, remote_config_patch: false },
  base_rev: 42,
  settings: { id: 'gc-000000000000000000000001', rev: 42, received_at_ms: 900, age_ms: 100, matches_state_cfg: true, values: {} },
  values: { center_frequency_hz: 416588000, gain_db: 15.7, vfo0_frequency_hz: null, vfo0_bandwidth_hz: 'x', vfo0_squelch_db: Number.NaN, extra: 1 },
  value_sources: { center_frequency_hz: 'settings_reported', gain_db: 'settings_reported', vfo0_frequency_hz: 'mqtt' },
  value_received_at_ms: { center_frequency_hz: 900, gain_db: -1, vfo0_frequency_hz: 1.5 },
  pending_command_id: null,
  settings_request: GET_STATUS,
};

describe('getConfigReported', () => {
  it('reads the node, the base revision and the settings report without credentials beyond same-origin', async () => {
    const calls = fakeFetch([{ status: 200, body: REPORTED }]);
    const reported = await getConfigReported();
    expect(calls[0].url).toBe('/api/mqtt/config-reported');
    expect(calls[0].init.credentials).toBe('same-origin');
    expect(calls[0].init.method).toBeUndefined();
    expect(reported.baseRev).toBe(42);
    expect(reported.node).toEqual({ sid: 'e2fe561d', cfg: 42, healthFresh: true, healthAgeMs: 400, remoteCommands: true, remoteConfigPatch: false });
    expect(reported.settings).toEqual({ id: 'gc-000000000000000000000001', rev: 42, receivedAtMs: 900, ageMs: 100, matchesStateCfg: true });
    expect(reported.broker).toEqual({ host: '10.90.0.1', port: 9001, transport: 'websockets', connection: 'connected' });
    expect(reported.values).toEqual({ center_frequency_hz: 416588000, gain_db: 15.7, vfo0_frequency_hz: null, vfo0_bandwidth_hz: null, vfo0_squelch_db: null });
    expect(reported.valueSources.vfo0_frequency_hz).toBeNull();
    expect(reported.valueSources.gain_db).toBe('settings_reported');
    expect(reported.valueReceivedAtMs).toEqual({ center_frequency_hz: 900, gain_db: null, vfo0_frequency_hz: null, vfo0_bandwidth_hz: null, vfo0_squelch_db: null });
    expect(reported.settingsRequest).toMatchObject({ op: 'config.get', state: 'acked', final: true, ack: { status: 'REJECTED', error: 'TLS_REQUIRED_FOR_SETTINGS_REPORT' } });
  });

  it('normalizes an unavailable monitor, a missing node and bad values', () => {
    const reported = normalizeConfigReported({ available: false, code: 'MQTT_MONITOR_DISABLED', base_rev: 7, broker: { connection: 'disabled' } });
    expect(reported.available).toBe(false);
    expect(reported.code).toBe('MQTT_MONITOR_DISABLED');
    // Without a node session there is no revision to name.
    expect(reported.baseRev).toBeNull();
    expect(reported.node).toBeNull();
    expect(reported.settings).toBeNull();
    expect(reported.settingsRequest).toBeNull();
    expect(normalizeConfigReported({ ...REPORTED, node: { ...REPORTED.node, sid: 'NOTHEX!!' } }).node).toBeNull();
    expect(normalizeConfigReported({ ...REPORTED, base_rev: -1 }).baseRev).toBeNull();
    expect(normalizeConfigReported({ ...REPORTED, settings: { id: 'bad id' } }).settings).toBeNull();
    expect(() => normalizeConfigReported([])).toThrow();
  });
});

describe('capabilities', () => {
  it('carry the edge topics, lifetime, ranges and gain table', () => {
    const capabilities = normalizeCapabilities({
      config_patch: {
        enabled: true, requires_admin: true, topic: 'sdr/v2/uav-01/cmd/config/patch', get_topic: 'sdr/v2/uav-01/cmd/config/get',
        ack_topic: 'sdr/v2/uav-01/ack/config', settings_topic: 'sdr/v2/uav-01/settings/reported', qos: 1, ttl_ms: 15000,
        ranges: { vfo0_frequency_hz: [24000000, 1766000000], vfo_frequency_hz: [1, 2] }, gain_table_db: [0, 20.7, 'x', 500],
      },
    });
    expect(capabilities.configPatch).toEqual({
      enabled: true,
      requiresAdmin: true,
      topic: 'sdr/v2/uav-01/cmd/config/patch',
      getTopic: 'sdr/v2/uav-01/cmd/config/get',
      ackTopic: 'sdr/v2/uav-01/ack/config',
      settingsTopic: 'sdr/v2/uav-01/settings/reported',
      qos: 1,
      ttlMs: 15000,
      ranges: { vfo0_frequency_hz: [24000000, 1766000000] },
      gainTableDb: [0, 20.7],
    });
  });
});

describe('sendConfigPatch', () => {
  it('posts the reviewed changes with base_rev and confirm true, and reads the accepted command', async () => {
    const calls = fakeFetch([{ status: 202, body: {
      ok: true, command_id: 'gc-abc', op: 'config.patch', state: 'published', topic: 'sdr/v2/uav-01/cmd/config/patch', qos: 1,
      base_rev: 42, issued_ms: 0, expires_ms: 15000, ttl_ms: 15000, changes: { center_frequency_hz: 433920000, vfo0_frequency_hz: 433920000 },
    } }]);
    const accepted = await sendConfigPatch({
      changes: { center_frequency_hz: 433_920_000, vfo0_frequency_hz: 433_920_000, ...({ restart: 1 } as object) }, base_rev: 42, confirm: true,
    });
    expect(calls[0].url).toBe('/api/mqtt/config-patch');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.credentials).toBe('same-origin');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      changes: { center_frequency_hz: 433920000, vfo0_frequency_hz: 433920000 }, base_rev: 42, confirm: true,
    });
    expect(accepted).toMatchObject({ commandId: 'gc-abc', op: 'config.patch', state: 'published', qos: 1, baseRev: 42, ttlMs: 15000 });
  });

  it('keeps the error code and body of a refusal', async () => {
    fakeFetch([{ status: 409, body: { ok: false, code: 'CONFIG_REVISION_STALE', error: 'stale', current_base_rev: 43 } }]);
    const failure = await sendConfigPatch({ changes: { gain_db: 20.7 }, base_rev: 42, confirm: true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('CONFIG_REVISION_STALE');
    expect((failure as ApiError).status).toBe(409);
    expect((failure as ApiError).details.current_base_rev).toBe(43);
  });

  it('rejects an accepted response without a command id', async () => {
    fakeFetch([{ status: 202, body: { ok: true } }]);
    await expect(sendConfigPatch({ changes: { gain_db: 20.7 }, base_rev: 42, confirm: true })).rejects.toThrow('invalid shape');
  });
});

describe('requestConfigGet', () => {
  it('posts an empty object to config-get and reads the accepted command', async () => {
    const calls = fakeFetch([{ status: 202, body: { ok: true, command_id: 'gc-get', op: 'config.get', state: 'published', topic: 'sdr/v2/uav-01/cmd/config/get', qos: 1, base_rev: 42, issued_ms: 0, expires_ms: 15000, ttl_ms: 15000, changes: {} } }]);
    const accepted = await requestConfigGet();
    expect(calls[0].url).toBe('/api/mqtt/config-get');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('{}');
    expect(calls[0].init.credentials).toBe('same-origin');
    expect(accepted).toMatchObject({ commandId: 'gc-get', op: 'config.get', changes: {} });
  });

  it('keeps the code of a pending request', async () => {
    fakeFetch([{ status: 409, body: { ok: false, code: 'SETTINGS_REQUEST_PENDING', error: 'pending', command_id: 'gc-1' } }]);
    const failure = await requestConfigGet().catch((error: unknown) => error);
    expect((failure as ApiError).code).toBe('SETTINGS_REQUEST_PENDING');
  });
});

describe('getConfigPatchStatus', () => {
  const STATUS = {
    command_id: 'gc-abc', op: 'config.patch', topic: 'sdr/v2/uav-01/cmd/config/patch', state: 'acked', final: false, now_ms: 1,
    issued_ms: 0, expires_ms: 15000, base_rev: 42, changes: { center_frequency_hz: 433920000, vfo0_frequency_hz: 433920000 },
    puback_reason: 0, monitor_restarted: false, settings_reported_at_ms: null,
    ack: {
      status: 'APPLIED', final: true, error: null, reason: null, revision: 43, persisted: true, t: 1, received_at_ms: 5,
      proof: { center_frequency_hz: 'FRESH_DAQ_RF_CENTER', vfo0_frequency_hz: 'FRESH_DOA_FREQUENCY', other: 'X', gain_db: 'not a code' },
    },
  };

  it('reads one command by id and derives final from the state', async () => {
    const calls = fakeFetch([{ status: 200, body: STATUS }]);
    const status = await getConfigPatchStatus('gc-abc');
    expect(calls[0].url).toBe('/api/mqtt/config-patch/gc-abc');
    expect(status?.final).toBe(true);
    expect(status?.op).toBe('config.patch');
    expect(status?.ack).toEqual({
      status: 'APPLIED', final: true, error: null, reason: null, revision: 43, persisted: true, receivedAtMs: 5,
      proof: { center_frequency_hz: 'FRESH_DAQ_RF_CENTER', vfo0_frequency_hz: 'FRESH_DOA_FREQUENCY' },
    });
  });

  it('knows every state of the edge command path', () => {
    for (const [state, final] of [
      ['published', false], ['delivered', false], ['acknowledged', false], ['acked', true], ['reported', true],
      ['publish_failed', true], ['no_ack', true], ['no_final_ack', true], ['no_report', true],
    ] as const) {
      expect(normalizeConfigCommandStatus({ ...STATUS, state })?.final, state).toBe(final);
    }
    expect(normalizeConfigCommandStatus({ ...STATUS, ack: { ...STATUS.ack, status: 'applied' } })?.ack).toBeNull();
    expect(normalizeConfigCommandStatus({ ...GET_STATUS, ack: { ...GET_STATUS.ack, proof: 'source_correlated' } })?.ack?.proof).toBe('source_correlated');
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
