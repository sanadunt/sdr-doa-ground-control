import { describe, expect, it } from 'vitest';
import { DEFAULT_DOA_OVERLAY_SETTINGS } from './doaGeometry';
import { applyOverlayNumber, validateOverlaySettings } from './mapOverlaySettings';

describe('overlay number fields (AUD-30)', () => {
  const settings = DEFAULT_DOA_OVERLAY_SETTINGS;

  it('treats empty and partial input as not a number instead of 0', () => {
    for (const text of ['', ' ', '-', '.', '-.', '+', 'abc', '1e3']) {
      expect(applyOverlayNumber(settings, 'minDb', text)).toEqual({ ok: false, error: { code: 'number' } });
    }
  });

  it('applies whole typed values without clamping them mid-way', () => {
    const projection = applyOverlayNumber(settings, 'maxDistanceM', '2500');
    expect(projection.ok && projection.settings.maxDistanceM).toBe(2500);
    const lobe = applyOverlayNumber(settings, 'lobeDistanceM', '700');
    expect(lobe.ok && lobe.settings.lobeDistanceM).toBe(700);
    const samples = applyOverlayNumber(settings, 'radialSamples', '16');
    expect(samples.ok && samples.settings.radialSamples).toBe(16);
    const contrast = applyOverlayNumber(settings, 'contrast', '1,5');
    expect(contrast.ok && contrast.settings.contrast).toBe(1.5);
    const minDb = applyOverlayNumber(settings, 'minDb', '-80');
    expect(minDb.ok && [minDb.settings.minDb, minDb.settings.maxDb]).toEqual([-80, 0]);
  });

  it('rejects out-of-range values instead of clamping them', () => {
    expect(applyOverlayNumber(settings, 'maxDistanceM', '25000')).toEqual({ ok: false, error: { code: 'range', min: 100, max: 20000 } });
    expect(applyOverlayNumber(settings, 'radialSamples', '1')).toEqual({ ok: false, error: { code: 'range', min: 2, max: 32 } });
  });

  it('reports a minimum at or above the maximum instead of rewriting the maximum', () => {
    expect(applyOverlayNumber(settings, 'minDb', '0')).toEqual({ ok: false, error: { code: 'belowMax', max: 0 } });
    expect(applyOverlayNumber(settings, 'maxDb', '-70')).toEqual({ ok: false, error: { code: 'aboveMin', min: -60 } });
    const maxDb = applyOverlayNumber(settings, 'maxDb', '-10');
    expect(maxDb.ok && maxDb.settings.maxDb).toBe(-10);
  });

  it('restores stored settings without a dB scale field to the auto scale', () => {
    const legacy: Record<string, unknown> = { ...settings, minDb: -60, maxDb: 0 };
    delete legacy.dbScale;
    expect(validateOverlaySettings(legacy).dbScale).toBe('auto');
    expect(validateOverlaySettings({ ...settings, dbScale: 'manual' }).dbScale).toBe('manual');
  });
});
