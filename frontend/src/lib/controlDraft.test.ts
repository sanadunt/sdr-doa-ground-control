import { describe, expect, it } from 'vitest';
import {
  createControlSendingStore, CONFIG_PATCH_KEYS, isConfigPatchKey, nextControlDraftRequest, normalizeConfigPatchChanges } from './controlDraft';

describe('control draft requests', () => {
  it('cover exactly the edge config.patch allowlist', () => {
    expect([...CONFIG_PATCH_KEYS]).toEqual(['center_frequency_hz', 'gain_db', 'vfo0_frequency_hz', 'vfo0_bandwidth_hz', 'vfo0_squelch_db', 'ant_spacing_m', 'vfo0_squelch_mode']);
    expect(isConfigPatchKey('vfo_frequency_hz')).toBe(false);
    expect(isConfigPatchKey('gain_db')).toBe(true);
    expect(isConfigPatchKey('restart_service')).toBe(false);
  });

  it('keep only allowlisted finite numbers', () => {
    expect(normalizeConfigPatchChanges({ center_frequency_hz: 433920000, vfo0_frequency_hz: Number.NaN, gain_db: '15', restart: 1 }))
      .toEqual({ center_frequency_hz: 433920000 });
    expect(normalizeConfigPatchChanges(null)).toEqual({});
    expect(normalizeConfigPatchChanges([1, 2])).toEqual({});
  });

  it('number every request so the same changes twice still count as two requests', () => {
    const first = nextControlDraftRequest(null, { center_frequency_hz: 433920000, vfo0_frequency_hz: 433920000 });
    const second = nextControlDraftRequest(first, { center_frequency_hz: 433920000, vfo0_frequency_hz: 433920000 });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(second.changes).toEqual(first.changes);
  });
});

describe('controlSendingStore (Kirim ke RDF-SDR waits for a patch on its way)', () => {
  it('notifies only on a change and stops after unsubscribe', () => {
    const store = createControlSendingStore();
    let calls = 0;
    const off = store.subscribe(() => { calls += 1; });
    expect(store.get()).toBe(false);
    store.set(true); store.set(true);
    expect(store.get()).toBe(true);
    expect(calls).toBe(1);
    off();
    store.set(false);
    expect(calls).toBe(1);
    expect(store.get()).toBe(false);
  });
});
