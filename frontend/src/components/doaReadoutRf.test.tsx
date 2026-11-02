import { describe, expect, it } from 'vitest';
import { hudRfParts } from './DoaReadout';
import { translate } from '../lib/i18n';
import type { RfSettings } from '../lib/telemetrySource';

const rf = (over: Partial<RfSettings> = {}): RfSettings => ({
  cfg: 342, centerHz: 481_287_000, vfo0Hz: 481_287_000, gainDb: 25.4, bandwidthHz: 12_500,
  squelchDb: null, ucaM: 0.128, squelchMode: 'Default', ...over,
});

describe('HUD settings line (gain, VFO, squelch from state.rf)', () => {
  const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('id', key, vars);
  it('names gain, VFO and an automatic squelch by its mode', () => {
    expect(hudRfParts(rf(), t)).toEqual([['Gain', '25.4 dB'], ['VFO', '481.287 MHz'], ['Squelch', 'DEFAULT']]);
  });
  it('shows the level the engine runs while the squelch is manual', () => {
    expect(hudRfParts(rf({ squelchMode: 'Manual', squelchDb: -89.6 }), t)).toContainEqual(['Squelch', '-89 dB']);
    expect(hudRfParts(rf({ squelchMode: null, squelchDb: -75 }), t)).toContainEqual(['Squelch', '-75.0 dB']);
  });
  it('leaves out what the edge does not send, and nothing without state.rf', () => {
    expect(hudRfParts(rf({ gainDb: null, squelchMode: null }), t)).toEqual([['VFO', '481.287 MHz']]);
    expect(hudRfParts(null, t)).toEqual([]);
  });
});
