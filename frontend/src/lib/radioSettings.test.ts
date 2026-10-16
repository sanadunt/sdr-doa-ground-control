import { describe, expect, it } from 'vitest';
import type { ReceiverStatus } from './receiverBridgeProtocol';
import { formatMsps, heldValue, radioRows, sampleRateOptions, settlePick } from './radioSettings';
import type { HeldPick } from './radioSettings';

const before = { seq: 1 } as ReceiverStatus;
const after = { seq: 2 } as ReceiverStatus;

describe('held radio picks', () => {
  it('shows a pick while its command is on its way and until a newer status', () => {
    const sent: HeldPick<number> = { value: 24, token: 1 };
    expect(heldValue(sent, before)).toBe(24);
    const accepted = settlePick(sent, 1, true, before);
    expect(accepted).toEqual({ value: 24, token: 1, settledOn: before });
    expect(heldValue(accepted, before)).toBe(24);
    expect(heldValue(accepted, after), 'the next status reports the value itself').toBeNull();
    expect(heldValue(null, before)).toBeNull();
  });

  it('drops a refused pick and ignores the answer of an older one', () => {
    expect(settlePick({ value: 24, token: 1 }, 1, false, before)).toBeNull();
    const newer: HeldPick<number> = { value: 32, token: 2 };
    expect(settlePick(newer, 1, true, before)).toBe(newer);
    expect(settlePick(newer, 1, false, before)).toBe(newer);
    const settled: HeldPick<boolean> = { value: false, token: 3, settledOn: before };
    expect(settlePick(settled, 3, false, after), 'a pick settles once').toBe(settled);
    expect(heldValue(settled, before)).toBe(false);
  });
});

describe('sample rate options', () => {
  it('offers the device rates a console command may set, otherwise the RadioSpectrum list', () => {
    expect(sampleRateOptions([], 20_000_000)).toEqual([2e6, 4e6, 5e6, 8e6, 10e6, 16e6, 20e6]);
    expect(sampleRateOptions(undefined, null)).toEqual([2e6, 4e6, 5e6, 8e6, 10e6, 16e6, 20e6]);
    expect(sampleRateOptions([20e6, 2e6, 3e6], 2e6)).toEqual([2e6, 20e6]);
  });

  it('keeps the current rate shown when it is not in the list', () => {
    expect(sampleRateOptions([2e6, 20e6], 2_400_000)).toEqual([2e6, 2_400_000, 20e6]);
    expect(sampleRateOptions([2e6], Number.NaN)).toEqual([2e6]);
  });

  it('formats MSPS without trailing zeros', () => {
    expect(formatMsps(20_000_000)).toBe('20');
    expect(formatMsps(2_400_000)).toBe('2.4');
    expect(formatMsps(null)).toBe('—');
    expect(formatMsps(0)).toBe('—');
  });
});

describe('Atur radio rows', () => {
  const live = (overrides: Partial<ReceiverStatus> = {}) => ({ seq: 3, busy: 'none', running: true, sampleRatesHz: [2e6, 20e6], ...overrides }) as ReceiverStatus;
  const shown = { sampleRateHz: 20e6, lnaDb: 24, vgaDb: 20, amp: false };
  const rows = (overrides: Partial<Parameters<typeof radioRows>[0]> = {}) => radioRows({ live: live(), shown, ratePending: false, starting: false, ...overrides });

  it('needs the Receiver frame', () => {
    expect(rows({ live: null })).toMatchObject({ ready: false, rateDisabled: true, gainsDisabled: true });
    expect(rows()).toEqual({ ready: true, sampleRateHz: 20e6, sampleRates: [2e6, 20e6], rateDisabled: false, ratePending: false, lnaDb: 24, vgaDb: 20, amp: false, gainsDisabled: false });
  });

  it('holds the rate during any scan, a start or another rate change', () => {
    for (const busy of ['sweep', 'scan-listen'] as const) expect(rows({ live: live({ busy, running: false }) }).rateDisabled, busy).toBe(true);
    // A rate change on its way locks the select through ratePending (aria-disabled), not disabled, so it keeps focus.
    expect(rows({ ratePending: true })).toMatchObject({ rateDisabled: false, ratePending: true });
    expect(rows({ starting: true }).rateDisabled).toBe(true);
  });

  it('keeps gains open during a wide scan, as the Receiver keeps them for the next RX start', () => {
    expect(rows({ live: live({ busy: 'sweep', running: false }) }).gainsDisabled).toBe(false);
    expect(rows({ live: live({ busy: 'sweep', running: true }) }).gainsDisabled, 'a scan start that still has RX').toBe(true);
    expect(rows({ live: live({ busy: 'scan-listen' }) }).gainsDisabled).toBe(true);
    expect(rows({ ratePending: true }).gainsDisabled).toBe(false);
  });
});
