import { describe, expect, it } from 'vitest';
import { translate } from '../lib/i18n';
import type { MessageKey } from '../lib/i18n';
import { MIN_AUTO_DB_SPAN } from '../lib/doaGeometry';
import { niceStep, polarPlotConfig, polarUiRevision, radialDomain, radialTicks, validHeadUp, validPlotRange } from './PolarPlot';

it('validates manual view controls', () => {
  expect(validPlotRange(90, -60, 0)).toBe(true);
  expect(validPlotRange(360, -60, 0)).toBe(false);
  expect(validPlotRange(0, 0, 0)).toBe(false);
  expect(validPlotRange(0, 10, -60)).toBe(false);
  expect(validPlotRange(NaN, -60, 0)).toBe(false);
});

it('validates Head Up on its own so it does not require a manual range', () => {
  expect(validHeadUp(0)).toBe(true);
  expect(validHeadUp(359.9)).toBe(true);
  expect(validHeadUp(360)).toBe(false);
  expect(validHeadUp(-1)).toBe(false);
  expect(validHeadUp(Number.NaN)).toBe(false);
});

describe('polar interaction persistence', () => {
  it('keeps the interaction revision stable for repeated frames', () => {
    expect(polarUiRevision({ figType: 'Compass', compassOffset: 10 }, true))
      .toBe(polarUiRevision({ figType: 'Compass', compassOffset: 10 }, true));
  });
  it('resets for source or coordinate convention changes', () => {
    const initial = polarUiRevision({ figType: 'Compass', compassOffset: 10 }, true);
    expect(polarUiRevision({ figType: 'Compass', compassOffset: 10 }, false)).not.toBe(initial);
    expect(polarUiRevision({ figType: 'Polar', compassOffset: 10 }, true)).not.toBe(initial);
    expect(polarUiRevision({ figType: 'Compass', compassOffset: 20 }, true)).not.toBe(initial);
  });
});

describe('polar radial scale', () => {
  it('keeps simulation scale stable across random frames', () => {
    expect(radialDomain([-50, -5], true)).toEqual([-60, 0]);
    expect(radialDomain([-35, -12], true)).toEqual([-60, 0]);
  });
  it('preserves signed live values with enclosing ticks', () => {
    expect(radialDomain([-53, -2])).toEqual([-60, 0]);
    expect(radialDomain([3, 24])).toEqual([0, 30]);
  });
  it('fits a low-contrast live vector instead of rounding it into a 10 dB ring', () => {
    // Repo reference snapshot: shifted dB spanning 0.00 to 1.46.
    expect(radialDomain([0, 0.31, 1.46])).toEqual([0, 1.5]);
    expect(radialDomain([12.2, 14.9])).toEqual([12, 15]);
  });
  it('does not divide by zero for a flat vector', () => {
    expect(radialDomain([-20, -20])).toEqual([-20, -19]);
  });
  it('never scales a near-flat vector tighter than the map auto scale', () => {
    expect(radialDomain([0, 0.2])).toEqual([0, 1]);
    expect(radialDomain([0.1, 0.4])).toEqual([0, 1]);
    expect(radialDomain([-3.3, -3.1])).toEqual([-3.5, -2.5]);
    for (const values of [[-20, -20], [0, 0.2], [0.1, 0.4], [-3.3, -3.1], [0, 0.31, 1.46], [7.05, 7.9]]) {
      const [low, high] = radialDomain(values);
      expect(high - low).toBeGreaterThanOrEqual(MIN_AUTO_DB_SPAN);
      expect(low).toBeLessThanOrEqual(Math.min(...values));
      expect(high).toBeGreaterThanOrEqual(Math.max(...values));
    }
  });
  it('has an explicit empty scale', () => {
    expect(radialDomain(null)).toEqual([-60, 0]);
    expect(radialDomain([Number.NaN])).toEqual([-60, 0]);
  });
  it('picks 1/2/5 steps', () => {
    expect(niceStep(0.365)).toBe(0.5);
    expect(niceStep(5.25)).toBe(10);
    expect(niceStep(12.75)).toBe(20);
    expect(niceStep(0.1)).toBe(0.1);
    expect(niceStep(0)).toBe(1);
  });
  it('places radial ticks on whole steps inside the range', () => {
    expect(radialTicks(0, 1.5)).toEqual([0, 0.5, 1, 1.5]);
    expect(radialTicks(-60, 0)).toEqual([-60, -40, -20, 0]);
    expect(radialTicks(-37, 3)).toEqual([-30, -20, -10, 0]);
    expect(radialTicks(0, 1.5, true)).toEqual([0, 1.5]);
  });
});

describe('polar Plotly config', () => {
  it('never offers the Plotly Cloud share button', () => {
    const config = polarPlotConfig('en', (key) => translate('en', key));
    expect(config.showSendToCloud).toBe(false);
    expect(config.plotlyServerURL).toBe('');
    expect(config.modeBarButtonsToRemove).toContain('sendChartToCloud');
    expect(config.displaylogo).toBe(false);
  });
  it('localizes the modebar for the Indonesian UI', () => {
    const t = (key: MessageKey) => translate('id', key);
    const config = polarPlotConfig('id', t);
    expect(config.locale).toBe('id');
    const dictionary = config.locales?.id?.dictionary ?? {};
    expect(dictionary['Download plot as a PNG']).toBe(t('polar.modebarDownload'));
    expect(dictionary.Zoom).toBe(t('polar.modebarZoom'));
    expect(dictionary['Download plot as a PNG']).not.toBe('Download plot as a PNG');
  });
});
