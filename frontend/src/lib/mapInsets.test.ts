import { describe, expect, it } from 'vitest';
import { COMPACT_NOTICE_MIN_PX, COMPACT_TOP_KEEP_PX, MAP_CONTROLS_ROW_PX, ZERO_INSETS, cameraInsets, clampMapPadding, compactMapInsets, computeMapInsets, controlsFramingBottom, graphBounds, noticePlacement, sameInsets, stackedRightTop } from './mapInsets';

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

describe('compact map insets (phones and tablets)', () => {
  // A 412 px wide phone held upright: the map is 412 x 475 under the top bar.
  const map = { left: 0, top: 52, right: 412, bottom: 527 };
  const hud = { left: 8, top: 60, right: 248, bottom: 170 };
  const node = { left: 84, top: 60, right: 404, bottom: 200 };

  it('frames the station centred across: the camera takes only the top inset', () => {
    const insets = compactMapInsets(map, { left: [hud] });
    expect(insets).toEqual({ top: 170 - 52 + 8, right: 0, bottom: 0, left: 0 });
    expect(cameraInsets(insets, true)).toEqual({ top: 126, right: 0, bottom: 0, left: 0 });
    // The PC keeps every side.
    const pc = { top: 0, right: 340, bottom: 200, left: 300 };
    expect(cameraInsets(pc, false)).toBe(pc);
  });

  it('takes the lowest panel, leaving room for a notice below it, and nothing from panels off the map', () => {
    expect(compactMapInsets(map, { left: [hud], right: [node] }).top).toBe(200 - 52 + 8);
    const tall = { left: 8, top: 60, right: 248, bottom: 520 };
    expect(compactMapInsets(map, { left: [tall] }).top).toBe(527 - 52 - COMPACT_TOP_KEEP_PX);
    expect(compactMapInsets(map, { left: [{ left: 0, top: 600, right: 200, bottom: 700 }] })).toEqual(ZERO_INSETS);
    expect(compactMapInsets(map, {})).toEqual(ZERO_INSETS);
  });

  it('starts the node card or Kontrol under the HUD when the two would cover each other', () => {
    // 412 px phone: the right column (from x 84) reaches into the HUD (to x 248).
    expect(stackedRightTop(map, hud, node)).toBe(170 - 52 + 8);
    // A tablet's map has room for both side by side.
    const wide = { left: 0, top: 52, right: 704, bottom: 800 };
    expect(stackedRightTop(wide, hud, { left: 376, top: 60, right: 696, bottom: 200 })).toBeNull();
    // An empty right column (display: none) or no HUD leaves it where it is.
    expect(stackedRightTop(map, hud, { left: 0, top: 0, right: 0, bottom: 0 })).toBeNull();
    expect(stackedRightTop(map, null, node)).toBeNull();
  });

  it('puts the map notices full width under the HUD and the node card on a 412 px phone', () => {
    // HUD (240 px) and node card (320 px) together are wider than the map.
    const insets = compactMapInsets(map, { left: [hud], right: [node] });
    const placement = noticePlacement(insets, true);
    expect(placement).toEqual({ top: 200 - 52 + 8 });
    // No side offsets: the stylesheet's map gap leaves the notices the map's width.
    expect(placement?.left).toBeUndefined();
    expect(placement?.right).toBeUndefined();
    expect(noticePlacement(compactMapInsets(map, {}), true)).toBeUndefined();
  });

  it('puts the notices beside Lapisan on a tablet, not under it in the middle of the map', () => {
    // 1280 x 800 tablet, landscape: the main view is 922 x 688 and Lapisan (260 px) is taller than half of it.
    const main = { left: 0, top: 52, right: 922, bottom: 740 };
    const layers = { left: 8, top: 60, right: 268, bottom: 502 };
    const insets = compactMapInsets(main, { left: [layers] });
    expect(insets).toEqual({ top: 0, right: 0, bottom: 0, left: 268 + 8 });
    expect(noticePlacement(insets, true)).toEqual({ left: 276 });
    expect(cameraInsets(insets, true)).toEqual(insets);
    // Too little map beside it (a 360 px phone): under it, full width, with a notice's room left below.
    const phone = { left: 0, top: 52, right: 360, bottom: 453 };
    const narrow = compactMapInsets(phone, { left: [{ left: 8, top: 60, right: 268, bottom: 445 }] });
    expect(narrow).toEqual({ top: 401 - COMPACT_TOP_KEEP_PX, right: 0, bottom: 0, left: 0 });
    expect(noticePlacement(narrow, true)).toEqual({ top: 281 });
    // The free width needed is the limit itself.
    const edge = { left: 0, top: 0, right: 268 + 16 + COMPACT_NOTICE_MIN_PX, bottom: 600 };
    expect(compactMapInsets(edge, { left: [{ left: 8, top: 8, right: 268, bottom: 300 }] }).left).toBe(276);
    expect(compactMapInsets({ ...edge, right: edge.right - 1 }, { left: [{ left: 8, top: 8, right: 268, bottom: 300 }] }).top).toBe(308);
  });

  it('keeps the PC notices between the side panels', () => {
    expect(noticePlacement({ top: 0, right: 340, bottom: 200, left: 300 }, false)).toEqual({ left: 312, right: 352 });
    expect(noticePlacement(ZERO_INSETS, false)).toBeUndefined();
  });
});

describe('the corner-window map frames the DoA graph', () => {
  const station = { latitude: -6.9, longitude: 107.6, source: 'NAV' } as const;
  it('spans the station and every drawn coordinate', () => {
    const beam = { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[[107.6, -6.9], [107.61, -6.89], [107.605, -6.885], [107.6, -6.9]]] } }] };
    const bearing = { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: [[107.6, -6.9], [107.62, -6.88]] } }] };
    expect(graphBounds([beam, bearing], station)).toEqual([[107.6, -6.9], [107.62, -6.88]]);
  });

  it('is null while no part of the graph is drawn, so the station and its reach are framed', () => {
    expect(graphBounds([{ type: 'FeatureCollection', features: [] }], station)).toBeNull();
    const broken = { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: [[Number.NaN, 1]] } }] };
    expect(graphBounds([broken], station)).toBeNull();
  });
});
