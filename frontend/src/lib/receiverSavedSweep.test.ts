import { describe, expect, it } from 'vitest';
import { RECEIVER_SWEEP_SETTINGS_KEY, savedReceiverSweep } from './receiverSavedSweep';
import { RECEIVER_SETTING_KEY, savedFrequencyShiftHz } from './receiverSavedTuning';

function storage(values: Record<string, string>) {
  return { getItem: (key: string) => values[key] ?? null };
}

const DEFAULTS = {
  startHz: 100_000_000, stopHz: 1_000_000_000, fftSize: 8192, resolutionHz: 20_000_000 / 8192, lnaDb: 40, vgaDb: 20, amp: false,
  displayMinDb: -60, displayMaxDb: 0, shiftHz: 0,
};

describe('savedReceiverSweep', () => {
  it('reads the Receiver scan settings in displayed Hz, the saved Freq Shift added', () => {
    const values = {
      [RECEIVER_SWEEP_SETTINGS_KEY]: JSON.stringify({ startMHz: 430, endMHz: 440.5, fftSize: 4096, lnaGain: 24, vgaGain: 30, ampEnabled: true, displayMinDb: -110, displayMaxDb: 20 }),
      [RECEIVER_SETTING_KEY]: JSON.stringify({ radio: { centerFreq: 100, frequencyShift: -125 } }),
    };
    expect(savedReceiverSweep(storage(values))).toEqual({
      startHz: 305_000_000, stopHz: 315_500_000, fftSize: 4096, resolutionHz: 20_000_000 / 4096, lnaDb: 24, vgaDb: 30, amp: true,
      displayMinDb: -110, displayMaxDb: 20, shiftHz: -125_000_000,
    });
    expect(savedFrequencyShiftHz(storage(values))).toBe(-125_000_000);
  });

  it('falls back to the Receiver defaults field by field, like the Receiver on load', () => {
    expect(savedReceiverSweep(storage({}))).toEqual(DEFAULTS);
    expect(savedReceiverSweep(null)).toEqual(DEFAULTS);
    expect(savedReceiverSweep(storage({ [RECEIVER_SWEEP_SETTINGS_KEY]: '{' }))).toEqual(DEFAULTS);
    expect(savedReceiverSweep(storage({ [RECEIVER_SWEEP_SETTINGS_KEY]: JSON.stringify({ startMHz: 900, endMHz: 800, fftSize: 2048, lnaGain: 20, vgaGain: 31, ampEnabled: 'on', displayMinDb: -40, displayMaxDb: -38 }) }))).toEqual(DEFAULTS);
    expect(savedReceiverSweep(storage({ [RECEIVER_SWEEP_SETTINGS_KEY]: JSON.stringify({ startMHz: 0.5, endMHz: 8000 }) }))).toEqual(DEFAULTS);
    expect(savedReceiverSweep(storage({ [RECEIVER_SWEEP_SETTINGS_KEY]: 'x'.repeat(5000) }))).toEqual(DEFAULTS);
    const throwing = { getItem: () => { throw new Error('blocked'); } };
    expect(savedReceiverSweep(throwing)).toEqual(DEFAULTS);
    expect(savedFrequencyShiftHz(throwing)).toBe(0);
    expect(savedFrequencyShiftHz(storage({ [RECEIVER_SETTING_KEY]: JSON.stringify({ radio: { frequencyShift: '5' } }) }))).toBe(0);
  });
});
