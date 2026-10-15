import { describe, expect, it } from 'vitest';
import { recentredRange, sweepRangeLimits, sweepRows } from './sweepSettings';
import type { ReceiverStatus } from './receiverBridgeProtocol';

function status(overrides: Partial<ReceiverStatus> = {}): ReceiverStatus {
  return {
    seq: 1, tMs: 0, webusb: true, mockAvailable: false, pairedCount: 1, connected: true, mock: false, deviceName: null, running: false,
    busy: 'none', workspace: 'spectrum', centerHz: 433_920_000, sampleRateHz: 20_000_000, frequencyShiftHz: 0, gains: { lnaDb: 40, vgaDb: 20, amp: false },
    vfo: null, squelchOpen: false, audio: 'none', recording: false, error: null, notice: null, tune: null, display: null, sampleRatesHz: [], sweep: null,
    ...overrides,
  };
}

const SHOWN = { range: { startHz: 100e6, stopHz: 1000e6 }, fftSize: 8192 as const, lnaDb: 40, vgaDb: 20, amp: false };

describe('scan rows', () => {
  it('are editable only while the frame answers, no scan runs and no start is on its way', () => {
    expect(sweepRows({ live: status(), shown: SHOWN, saved: null, starting: false })).toMatchObject({ ready: true, scanning: false, disabled: false, startHz: 100e6, stopHz: 1000e6 });
    expect(sweepRows({ live: status({ busy: 'sweep' }), shown: SHOWN, saved: null, starting: false })).toMatchObject({ scanning: true, disabled: true });
    expect(sweepRows({ live: status({ busy: 'scan-listen' }), shown: SHOWN, saved: null, starting: false })).toMatchObject({ scanning: true, disabled: true });
    expect(sweepRows({ live: status(), shown: SHOWN, saved: null, starting: true })).toMatchObject({ scanning: false, disabled: true });
    expect(sweepRows({ live: null, shown: SHOWN, saved: null, starting: false })).toMatchObject({ ready: false, scanning: false, disabled: true });
  });

  it('take the shift from the Receiver, or from its saved settings before the frame answers', () => {
    expect(sweepRows({ live: status({ frequencyShiftHz: -125e6 }), shown: SHOWN, saved: null, starting: false }).shiftHz).toBe(-125e6);
    const saved = { startHz: 0, stopHz: 1, fftSize: 8192 as const, resolutionHz: 1, lnaDb: 0, vgaDb: 0, amp: false, displayMinDb: -60, displayMaxDb: 0, shiftHz: 50e6 };
    expect(sweepRows({ live: null, shown: SHOWN, saved, starting: false }).shiftHz).toBe(50e6);
  });

  it('centre the scan span on the RX centre, inside the device range', () => {
    expect(recentredRange({ startHz: 100e6, stopHz: 200e6 }, 433_920_000, 0, 8192)).toEqual({ startHz: 383_920_000, stopHz: 483_920_000 });
    // Near an edge the span moves back inside 1–7250 MHz.
    expect(recentredRange({ startHz: 100e6, stopHz: 200e6 }, 20e6, 0, 8192)).toEqual({ startHz: 1e6, stopHz: 101e6 });
    expect(recentredRange({ startHz: 100e6, stopHz: 200e6 }, 7_240e6, 0, 8192)).toEqual({ startHz: 7_150e6, stopHz: 7_250e6 });
    // Displayed Hz with an upconverter: the device range moves by the shift.
    expect(recentredRange({ startHz: 100e6, stopHz: 200e6 }, 0, -125e6, 8192)).toEqual({ startHz: -50e6, stopHz: 50e6 });
    expect(recentredRange({ startHz: 100e6, stopHz: 200e6 }, -100e6, -125e6, 8192)).toEqual({ startHz: -124e6, stopHz: -24e6 });
    // A span too wide for the resolution has no valid range.
    expect(recentredRange({ startHz: 100e6, stopHz: 2_000e6 }, 433e6, 0, 8192)).toBeNull();
    expect(recentredRange({ startHz: 100e6, stopHz: 200e6 }, Number.NaN, 0, 8192)).toBeNull();
    expect(sweepRangeLimits(-125e6, 4096)).toEqual({ minHz: -124e6, maxHz: 7_125e6, maxSpanHz: 2_441_406_250 });
  });
});
