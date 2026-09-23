import { describe, expect, it } from 'vitest';
import { polarUiRevision, radialDomain, validPlotRange } from './PolarPlot';

it('validates manual view controls', () => {
  expect(validPlotRange(90, -60, 0)).toBe(true);
  expect(validPlotRange(360, -60, 0)).toBe(false);
  expect(validPlotRange(0, 0, 0)).toBe(false);
  expect(validPlotRange(0, 10, -60)).toBe(false);
  expect(validPlotRange(NaN, -60, 0)).toBe(false);
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
  it('does not divide by zero for a flat vector', () => {
    expect(radialDomain([-20, -20])).toEqual([-20, -10]);
  });
  it('has an explicit empty scale', () => {
    expect(radialDomain(null)).toEqual([-60, 0]);
  });
});