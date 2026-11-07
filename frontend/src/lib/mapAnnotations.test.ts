import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MAP_ANNOTATIONS_ROUTE,
  annotationErrorKey,
  annotationFeatures,
  annotationLabelFeatures,
  draftFeatures,
  formatArea,
  formatLength,
  geofenceHits,
  lastLegBearing,
  normalizeAnnotation,
  normalizeAnnotationsAnswer,
  pathLengthM,
  pointInPolygon,
  polygonAreaM2,
  polygonPerimeterM,
  writeAnnotation,
  type LonLat,
  type MapAnnotation,
} from './mapAnnotations';
import { I18nContext, translate } from './i18n';
import { AnnotationPanel } from '../components/overview/AnnotationPanel';

const SQUARE: LonLat[] = [[107.66, -6.93], [107.67, -6.93], [107.67, -6.94], [107.66, -6.94]];

function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a'.repeat(32), kind: 'area', category: 'nogo', color: '#e5484d', name: 'Sungai', note: 'Jangan lewat',
    geometry: SQUARE, rev: 2, created_ms: 1000, updated_ms: 2000, by: 'tablet 192.168.1.20', ...overrides,
  };
}

const AREA = normalizeAnnotation(stored()) as MapAnnotation;
const MARKER = normalizeAnnotation(stored({ id: 'b'.repeat(32), kind: 'point', category: 'suspect', color: '#f08a24', name: 'Atap', note: '', geometry: [107.665, -6.935] })) as MapAnnotation;

describe('reading the server', () => {
  it('takes stored areas and markers and drops what it cannot draw', () => {
    expect(AREA).toMatchObject({ kind: 'area', category: 'nogo', rev: 2, createdMs: 1000, updatedMs: 2000, by: 'tablet 192.168.1.20' });
    expect(MARKER.geometry).toEqual([107.665, -6.935]);
    for (const bad of [
      stored({ id: 'xyz' }), stored({ kind: 'line' }), stored({ category: 'enemy' }), stored({ color: '#000000' }),
      stored({ geometry: SQUARE.slice(0, 2) }), stored({ geometry: [[200, 0], [0, 0], [0, 1]] }), stored({ rev: 0 }), stored({ name: 3 }), null, [],
    ]) expect(normalizeAnnotation(bad)).toBeNull();
  });

  it('reads an answer with items, an unchanged answer, and refuses anything else', () => {
    expect(normalizeAnnotationsAnswer({ ok: true, rev: 4, items: [stored(), stored({ id: 'zz' })] })).toEqual({ rev: 4, unchanged: false, items: [AREA] });
    expect(normalizeAnnotationsAnswer({ ok: true, rev: 4, unchanged: true })).toEqual({ rev: 4, unchanged: true });
    expect(normalizeAnnotationsAnswer({ ok: false, rev: 4, items: [] })).toBeNull();
    expect(normalizeAnnotationsAnswer({ ok: true, items: [] })).toBeNull();
  });
});

describe('writing', () => {
  it('posts the strict request and reads the saved item', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, rev: 5, op: 'create', item: stored({ rev: 1 }) }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await writeAnnotation({ op: 'create', item: { kind: 'area', category: 'nogo', color: '#e5484d', name: ' Sungai ', note: '', geometry: SQUARE } }, fetcher);
    expect(result).toMatchObject({ ok: true, rev: 5 });
    expect(calls[0].url).toBe(MAP_ANNOTATIONS_ROUTE);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ v: 1, op: 'create', item: { kind: 'area', category: 'nogo', color: '#e5484d', name: 'Sungai', note: '', geometry: SQUARE } });
  });

  it('names a conflict with the other page\'s version, and a network failure', async () => {
    const conflict = (async () => new Response(JSON.stringify({ ok: false, code: 'ANNOTATION_CONFLICT', error: 'x', item: stored({ name: 'Baru', rev: 3 }) }), { status: 409 })) as unknown as typeof fetch;
    const result = await writeAnnotation({ op: 'delete', id: AREA.id, rev: 2 }, conflict);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ANNOTATION_CONFLICT');
      expect(result.current?.name).toBe('Baru');
    }
    const down = (async () => { throw new TypeError('down'); }) as unknown as typeof fetch;
    expect(await writeAnnotation({ op: 'delete', id: AREA.id, rev: 2 }, down)).toEqual({ ok: false, code: 'NETWORK', current: null });
    expect(annotationErrorKey('ANNOTATION_LIMIT')).toBe('annot.error.ANNOTATION_LIMIT');
    expect(annotationErrorKey('SOMETHING_NEW')).toBe('annot.error.ANNOTATION_INVALID');
  });
});

describe('measuring', () => {
  it('measures a path, its last leg, an area and its perimeter', () => {
    // 0.01° of longitude at 6.93°S is about 1104 m; 0.01° of latitude about 1106 m.
    const path: LonLat[] = [[107.66, -6.93], [107.67, -6.93], [107.67, -6.94]];
    expect(Math.abs(pathLengthM(path) - 2209)).toBeLessThan(10);
    expect(Math.round(lastLegBearing(path) ?? -1)).toBe(180);
    expect(lastLegBearing(path.slice(0, 1))).toBeNull();
    expect(Math.abs(polygonAreaM2(SQUARE) - 1_221_000) / 1_221_000).toBeLessThan(0.01);
    expect(Math.abs(polygonPerimeterM(SQUARE) - 4420)).toBeLessThan(20);
    expect(formatLength(850.4)).toBe('850 m');
    expect(formatLength(2209)).toBe('2.21 km');
    expect(formatArea(850)).toBe('850 m²');
    expect(formatArea(43_000)).toBe('4.3 ha');
    expect(formatArea(1_221_000)).toBe('1.22 km²');
  });

  it('knows which no-go areas a position is inside of', () => {
    expect(pointInPolygon([107.665, -6.935], SQUARE)).toBe(true);
    expect(pointInPolygon([107.675, -6.935], SQUARE)).toBe(false);
    const safe = { ...AREA, id: 'c'.repeat(32), category: 'safe' as const };
    expect(geofenceHits([107.665, -6.935], [AREA, safe, MARKER]).map((item) => item.id)).toEqual([AREA.id]);
    expect(geofenceHits(null, [AREA])).toEqual([]);
  });
});

describe('map geometry', () => {
  it('closes area rings, marks the picked and the alert, and labels each mark', () => {
    const features = annotationFeatures([AREA, MARKER], MARKER.id, new Set([AREA.id]));
    expect(features.features[0].geometry).toEqual({ type: 'Polygon', coordinates: [[...SQUARE, SQUARE[0]]] });
    expect(features.features[0].properties).toMatchObject({ alert: true, selected: false, color: '#e5484d' });
    expect(features.features[1].properties).toMatchObject({ selected: true, kind: 'point' });
    const labels = annotationLabelFeatures([AREA]);
    const [lon, lat] = (labels.features[0].geometry as { coordinates: number[] }).coordinates;
    expect(lon).toBeCloseTo(107.665, 9);
    expect(lat).toBeCloseTo(-6.935, 9);
  });

  it('draws the shape being drawn, closed for an area of three corners', () => {
    expect(draftFeatures('measure', SQUARE.slice(0, 1)).features.map((feature) => feature.properties.role)).toEqual(['corner']);
    const area = draftFeatures('area', SQUARE.slice(0, 3));
    expect(area.features[0].geometry).toEqual({ type: 'LineString', coordinates: [...SQUARE.slice(0, 3), SQUARE[0]] });
    expect(draftFeatures('measure', SQUARE.slice(0, 3)).features[0].geometry).toEqual({ type: 'LineString', coordinates: SQUARE.slice(0, 3) });
  });
});

describe('the marks panel', () => {
  const render = (props: Partial<Parameters<typeof AnnotationPanel>[0]>) => renderToStaticMarkup(createElement(
    I18nContext.Provider,
    { value: { lang: 'id', setLang: () => undefined, t: (key, vars) => translate('id', key, vars) } },
    createElement(AnnotationPanel, {
      tool: 'none', draft: [], items: [AREA, MARKER], stale: false, selected: null,
      onTool: () => undefined, onDraftChange: () => undefined, onSelect: () => undefined, onFocus: () => undefined, onChanged: () => undefined,
      ...props,
    }),
  ));

  it('lists every mark with its colour and type', () => {
    const html = render({ tool: 'list' });
    expect(html).toContain('2 tanda');
    expect(html).toContain('Sungai');
    expect(html).toContain('Dilarang lewat');
    expect(html).toContain('background:#e5484d');
  });

  it('shows the measured path and the area being drawn', () => {
    expect(render({ tool: 'measure', draft: [[107.66, -6.93], [107.67, -6.93]] })).toContain('Total 1.10 km');
    const drawing = render({ tool: 'area', draft: SQUARE.slice(0, 3) });
    expect(drawing).toContain('Klik sudut-sudutnya di peta');
    expect(drawing).toMatch(/Luas 61\d{4} m²|Luas 6\d\.\d ha/u);
  });

  it('shows a picked mark with Edit, Delete and who changed it last', () => {
    const html = render({ selected: AREA });
    expect(html).toContain('Jangan lewat');
    expect(html).toContain('Oleh tablet 192.168.1.20');
    expect(html).toContain('>Ubah<');
    expect(html).toContain('>Hapus<');
  });

  it('says when the marks could not be read', () => {
    expect(render({ tool: 'list', stale: true })).toContain('Tanda tidak terbaca');
  });
});

describe('the marks styles', () => {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  const css = process.getBuiltinModule('node:fs').readFileSync(new URL('../overview-dashboard.css', import.meta.url), 'utf8');

  it('keeps every target at 44 px and uses console tokens only', () => {
    for (const selector of ['.ov-annot-actions .ov-button', '.ov-annot-row', '.ov-annot-swatch']) {
      expect(css).toMatch(new RegExp(`${selector.replace(/\./g, '\\.')} \\{[^}]*(min-)?height: 44px`, 'u'));
    }
    const rules = css.split('\n').filter((line) => line.startsWith('.ov-annot'));
    expect(rules.length).toBeGreaterThan(10);
    for (const rule of rules) expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/iu);
  });
});
