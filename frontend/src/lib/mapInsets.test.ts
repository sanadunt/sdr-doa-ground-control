import { describe, expect, it } from 'vitest';
import { MAP_CONTROLS_ROW_PX, ZERO_INSETS, clampMapPadding, computeMapInsets, controlsFramingBottom, sameInsets } from './mapInsets';

const map = { left: 0, top: 52, right: 1440, bottom: 900 };

describe('map insets from the floating panels', () => {
  it('reserve the left column, the right column and the dock', () => {
    const insets = computeMapInsets(map, {
      left: [{ left: 12, top: 64, right: 276, bottom: 208 }],
      right: [{ left: 1164, top: 64, right: 1428, bottom: 160 }],
      bottom: [{ left: 0, top: 644, right: 1440, bottom: 900 }],
    });
    expect(insets).toEqual({ top: 0, left: 288, right: 288, bottom: 256 });
  });

  it('take the widest panel of a column', () => {
    const insets = computeMapInsets(map, { right: [{ left: 1164, top: 64, right: 1428, bottom: 160 }, { left: 1068, top: 172, right: 1428, bottom: 500 }] });
    expect(insets.right).toBe(384);
  });

  it('ignore panels stacked below the map in the narrow layout', () => {
    const narrowMap = { left: 12, top: 100, right: 756, bottom: 520 };
    const insets = computeMapInsets(narrowMap, {
      left: [{ left: 12, top: 532, right: 756, bottom: 680 }],
      bottom: [{ left: 12, top: 700, right: 756, bottom: 980 }],
    });
    expect(insets).toEqual(ZERO_INSETS);
    expect(computeMapInsets(narrowMap, { left: [{ left: 0, top: 0, right: 0, bottom: 0 }] })).toEqual(ZERO_INSETS);
  });

  it('compare by value', () => {
    expect(sameInsets({ top: 0, right: 1, bottom: 2, left: 3 }, { top: 0, right: 1, bottom: 2, left: 3 })).toBe(true);
    expect(sameInsets(ZERO_INSETS, { top: 0, right: 0, bottom: 1, left: 0 })).toBe(false);
  });
});

describe('map padding clamp', () => {
  const framing = { top: 24, right: 24, bottom: 68, left: 24 };

  it('keeps padding that leaves fitBounds room', () => {
    expect(clampMapPadding({ top: 0, right: 288, bottom: 256, left: 288 }, 1440, 848, framing)).toEqual({ top: 0, right: 288, bottom: 256, left: 288 });
  });

  it('scales an axis down so padding and framing stay within 80 % of the canvas', () => {
    const padding = clampMapPadding({ top: 0, right: 384, bottom: 256, left: 288 }, 800, 400, framing);
    expect(padding.left + padding.right + framing.left + framing.right).toBeLessThanOrEqual(800 * 0.8);
    expect(padding.top + padding.bottom + framing.top + framing.bottom).toBeLessThanOrEqual(400 * 0.8);
    expect(padding.left).toBeLessThan(padding.right);
  });

  it('never returns negative or fractional padding', () => {
    expect(clampMapPadding({ top: -5, right: Number.NaN, bottom: 10.6, left: 3 }, 0, 0, framing)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});

describe('framing clearance for the map controls', () => {
  it('keeps the one-row value on wide layouts', () => {
    expect(controlsFramingBottom(MAP_CONTROLS_ROW_PX)).toBe(68);
    expect(controlsFramingBottom(0)).toBe(68);
    expect(controlsFramingBottom(Number.NaN)).toBe(68);
  });

  it('grows when the controls wrap onto a second row at phone width', () => {
    // 44 px buttons, a 6 px gap and the wrapped attribution row.
    expect(controlsFramingBottom(94)).toBe(118);
  });
});
