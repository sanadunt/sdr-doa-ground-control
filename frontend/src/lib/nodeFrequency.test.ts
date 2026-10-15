import { describe, expect, it } from 'vitest';
import type { TelemetrySnapshot } from '../types';
import { nodeFrequencies, nodeFrequenciesChanged } from './nodeFrequency';

function snapshot(overrides: Partial<TelemetrySnapshot> = {}, csv: Record<string, unknown> = { available: true, frequency_hz_normalized: 416_600_000 }): TelemetrySnapshot {
  return {
    status: { available: true },
    settings: { available: true, fields: { center_freq: 416.588 } },
    doa_candidates: { csv },
    ...overrides,
  } as TelemetrySnapshot;
}

describe('nodeFrequencies', () => {
  it('reads the centre from settings.json (MHz) and the VFO from the CSV view (Hz)', () => {
    expect(nodeFrequencies(snapshot(), true)).toEqual({ centerHz: 416_588_000, vfoHz: 416_600_000 });
  });

  it('falls back to the centre when the CSV view has no frequency', () => {
    expect(nodeFrequencies(snapshot({}, { available: true }), true)).toEqual({ centerHz: 416_588_000, vfoHz: 416_588_000 });
    expect(nodeFrequencies(snapshot({}, { available: false, frequency_hz_normalized: 416_600_000 }), true)?.vfoHz).toBe(416_588_000);
  });

  it('accepts a numeric string from settings.json', () => {
    expect(nodeFrequencies(snapshot({ settings: { fields: { center_freq: '433.92' } } }), true)?.centerHz).toBe(433_920_000);
  });

  it('gives nothing for stale, unreachable, simulated or invalid data', () => {
    expect(nodeFrequencies(snapshot(), false)).toBeNull();
    expect(nodeFrequencies(null, true)).toBeNull();
    expect(nodeFrequencies(snapshot({ status: { available: false } }), true)).toBeNull();
    expect(nodeFrequencies(snapshot({ simulation: true }), true)).toBeNull();
    expect(nodeFrequencies(snapshot({ settings: { fields: { center_freq: 'abc' } } }), true)).toBeNull();
    expect(nodeFrequencies(snapshot({ settings: { fields: { center_freq: 0.5 } } }), true)).toBeNull();
  });
});

describe('nodeFrequenciesChanged', () => {
  it('ignores moves of 1 kHz or less', () => {
    const base = { centerHz: 433_920_000, vfoHz: 433_920_000 };
    expect(nodeFrequenciesChanged(base, { centerHz: 433_921_000, vfoHz: 433_919_000 })).toBe(false);
    expect(nodeFrequenciesChanged(base, { centerHz: 433_921_001, vfoHz: 433_920_000 })).toBe(true);
    expect(nodeFrequenciesChanged(null, base)).toBe(true);
    expect(nodeFrequenciesChanged(null, null)).toBe(false);
  });
});
