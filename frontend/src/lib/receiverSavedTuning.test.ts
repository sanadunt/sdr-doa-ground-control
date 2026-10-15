import { describe, expect, it } from 'vitest';
import { RECEIVER_SETTING_KEY, RECEIVER_SETTING_MAX_CHARS, savedReceiverTuning } from './receiverSavedTuning';

function storage(value: string | null) {
  return { getItem: (key: string) => (key === RECEIVER_SETTING_KEY ? value : null) };
}

describe('savedReceiverTuning', () => {
  it('reads the saved centre and the active VFO in Hz', () => {
    const setting = { radio: { centerFreq: 433.92, sampleRate: 20_000_000 }, vfos: [{ freq: 433.925 }, { freq: 434.1 }], activeVfoIndex: 1 };
    expect(savedReceiverTuning(storage(JSON.stringify(setting)))).toEqual({ centerHz: 433_920_000, vfoHz: 434_100_000 });
    expect(savedReceiverTuning(storage(JSON.stringify({ ...setting, activeVfoIndex: 7 })))).toEqual({ centerHz: 433_920_000, vfoHz: 433_925_000 });
    expect(savedReceiverTuning(storage(JSON.stringify({ radio: { centerFreq: 100 } })))).toEqual({ centerHz: 100_000_000, vfoHz: null });
    expect(savedReceiverTuning(storage(JSON.stringify({ radio: { centerFreq: 100 }, vfos: [{ freq: 7000 }] })))).toEqual({ centerHz: 100_000_000, vfoHz: null });
  });

  it('returns null for anything it cannot trust', () => {
    for (const raw of [
      null, '', 'not json', '[]', '{"radio":null}', '{"radio":{"centerFreq":"433.92"}}', '{"radio":{"centerFreq":0.5}}',
      '{"radio":{"centerFreq":6500}}', JSON.stringify({ radio: { centerFreq: 100 }, pad: 'x'.repeat(RECEIVER_SETTING_MAX_CHARS) }),
    ]) {
      expect(savedReceiverTuning(storage(raw)), String(raw).slice(0, 40)).toBeNull();
    }
    expect(savedReceiverTuning(null)).toBeNull();
    expect(savedReceiverTuning({ getItem: () => { throw new Error('blocked'); } })).toBeNull();
  });

  it('reads nothing outside a browser', () => {
    expect(savedReceiverTuning()).toBeNull();
  });
});
