import { describe, expect, it } from 'vitest';
import { CONFIG_PATCH_KEYS, isConfigPatchKey, nextControlDraftRequest, normalizeConfigPatchChanges } from './controlDraft';

describe('control draft requests', () => {
  it('cover exactly the sdr/v1 config patch allowlist', () => {
    expect([...CONFIG_PATCH_KEYS]).toEqual(['center_frequency_hz', 'gain_db', 'vfo_frequency_hz', 'vfo_bandwidth_hz', 'vfo_squelch_db']);
    expect(isConfigPatchKey('gain_db')).toBe(true);
    expect(isConfigPatchKey('restart_service')).toBe(false);
  });

  it('keep only allowlisted finite numbers', () => {
    expect(normalizeConfigPatchChanges({ center_frequency_hz: 433920000, vfo_frequency_hz: Number.NaN, gain_db: '15', restart: 1 }))
      .toEqual({ center_frequency_hz: 433920000 });
    expect(normalizeConfigPatchChanges(null)).toEqual({});
    expect(normalizeConfigPatchChanges([1, 2])).toEqual({});
  });

  it('number every request so the same changes twice still count as two requests', () => {
    const first = nextControlDraftRequest(null, { center_frequency_hz: 433920000, vfo_frequency_hz: 433920000 });
    const second = nextControlDraftRequest(first, { center_frequency_hz: 433920000, vfo_frequency_hz: 433920000 });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(second.changes).toEqual(first.changes);
  });
});
