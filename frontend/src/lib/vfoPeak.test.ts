import { describe, expect, it } from 'vitest';
import type { TelemetrySnapshot } from '../types';
import { GAIN_TABLE_DB } from './configPatch';
import { gainStepUp, squelchFromPeak, vfoPeak } from './vfoPeak';

function answer(health: Record<string, unknown> | null, extra: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return {
    source: { kind: 'mqtt', reason: 'MQTT_FRESH', reasons: ['MQTT_FRESH'] },
    mqtt: { health },
    ...extra,
  } as unknown as TelemetrySnapshot;
}

describe('vfoPeak', () => {
  it('reads the output VFO peak and squelch of a fresh health (contract 1.11)', () => {
    expect(vfoPeak(answer({ fresh: true, pk: -79.7, psq: -70 }), true)).toEqual({ peakDb: -79.7, squelchDb: -70, marginDb: -9.7, held: true });
    expect(vfoPeak(answer({ fresh: true, pk: -53.4, psq: -70 }), true)).toEqual({ peakDb: -53.4, squelchDb: -70, marginDb: 16.6, held: false });
  });

  it('holds at a zero margin, as rdfsdr computes DoA only above the squelch', () => {
    expect(vfoPeak(answer({ fresh: true, pk: -70, psq: -70 }), true)?.held).toBe(true);
  });

  it('keeps a peak without a squelch, never calling it held', () => {
    expect(vfoPeak(answer({ fresh: true, pk: -80, psq: null }), true)).toEqual({ peakDb: -80, squelchDb: null, marginDb: null, held: false });
  });

  it('is null for an older edge, a stale measurement, stale health, an expired answer or a simulation', () => {
    expect(vfoPeak(answer({ fresh: true }), true)).toBeNull();
    expect(vfoPeak(answer({ fresh: true, pk: null, psq: -70 }), true)).toBeNull();
    expect(vfoPeak(answer({ fresh: false, pk: -80, psq: -70 }), true)).toBeNull();
    expect(vfoPeak(answer({ fresh: true, pk: -80, psq: -70 }), false)).toBeNull();
    expect(vfoPeak(answer({ fresh: true, pk: -80, psq: -70 }, { simulation: true } as Partial<TelemetrySnapshot>), true)).toBeNull();
    expect(vfoPeak(answer(null), true)).toBeNull();
    expect(vfoPeak(null, true)).toBeNull();
    expect(vfoPeak(answer({ fresh: true, pk: '-80', psq: -70 }), true)).toBeNull();
  });
});

describe('squelchFromPeak', () => {
  it('puts the squelch 6 dB under the peak, in whole dB', () => {
    expect(squelchFromPeak(-79.7)).toBe(-86);
    expect(squelchFromPeak(-53.4)).toBe(-59);
  });

  it('stays inside the edge range', () => {
    expect(squelchFromPeak(-198)).toBe(-200);
    expect(squelchFromPeak(80)).toBe(50);
  });
});

describe('gainStepUp', () => {
  it('takes the first gain of the table at least 3 dB higher', () => {
    expect(gainStepUp(15.7, GAIN_TABLE_DB)).toBe(19.7);
    expect(gainStepUp(25.4, GAIN_TABLE_DB)).toBe(29.7);
    expect(gainStepUp(0, GAIN_TABLE_DB)).toBe(3.7);
  });

  it('is null at the top of the table or without a current gain', () => {
    expect(gainStepUp(48, GAIN_TABLE_DB)).toBeNull();
    expect(gainStepUp(49.6, GAIN_TABLE_DB)).toBeNull();
    expect(gainStepUp(null, GAIN_TABLE_DB)).toBeNull();
  });
});
