import { describe, expect, it } from 'vitest';
import {
  BASEMAPS,
  BASEMAP_ORDER,
  BASEMAP_STORAGE_KEY,
  DEFAULT_BASEMAP_ID,
  TILE_ROUTE,
  TILE_SOURCES,
  basemapBaseSource,
  basemapRasterLayers,
  basemapSourceId,
  isBasemapSourceId,
  loadBasemapId,
  normalizeBasemapId,
  saveBasemapId,
  tileUrlTemplate,
  type BasemapId,
} from './basemaps';
import { DICTIONARIES } from './i18n';
import { PREFERENCE_KEYS } from './preferenceStore';

const IDS = Object.keys(BASEMAPS) as BasemapId[];
// Tile providers and data sources; style labels name the look, never one of these.
const PROVIDER_NAMES = /OpenStreetMap|\bOSM\b|CARTO|Esri|ArcGIS|OpenTopoMap|Maxar|Earthstar|Humanitarian|France|Stadia|Stamen|Mapbox|MapTiler|Google|Bing|\bHERE\b|Garmin|SRTM/i;

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('basemap catalogue', () => {
  it('lists the eight styles once, Standard first, as the menu order', () => {
    expect(BASEMAP_ORDER).toEqual(['standard', 'hot', 'light', 'dark', 'satellite', 'hybrid', 'topo', 'plain']);
    expect([...BASEMAP_ORDER].sort()).toEqual([...IDS].sort());
    expect(DEFAULT_BASEMAP_ID).toBe('standard');
    for (const id of IDS) {
      expect(BASEMAPS[id].id).toBe(id);
      // Stored as a preference TOKEN on the server.
      expect(id).toMatch(/^[A-Za-z0-9_.-]{1,32}$/);
    }
  });

  it('labels every style in both languages without naming a provider', () => {
    for (const id of IDS) {
      const key = BASEMAPS[id].labelKey;
      for (const lang of ['en', 'id'] as const) {
        const label = DICTIONARIES[lang][key];
        expect(label, `${lang} ${key}`).toBeTruthy();
        expect(label, `${lang} ${key}`).not.toMatch(PROVIDER_NAMES);
      }
    }
    for (const lang of ['en', 'id'] as const) {
      expect(DICTIONARIES[lang]['map.basemap']).not.toMatch(PROVIDER_NAMES);
      expect(DICTIONARIES[lang]['map.basemapUnavailable']).toContain('{style}');
      expect(DICTIONARIES[lang]['map.basemapPartial']).toContain('{style}');
    }
    expect(DICTIONARIES.en['basemap.hybrid']).toBe('Satellite + labels');
    expect(DICTIONARIES.id['basemap.hybrid']).toBe('Satelit + label');
    expect(DICTIONARIES.id['basemap.light']).toBe('Terang');
    expect(DICTIONARIES.id['basemap.dark']).toBe('Gelap');
  });

  it('draws every tiled style from the console tile route, never a remote host', () => {
    for (const id of IDS) {
      for (const raster of basemapRasterLayers(id, 'http://127.0.0.1:8787')) {
        expect(raster.source.tiles).toHaveLength(1);
        const [template] = raster.source.tiles ?? [];
        expect(template).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:8787${TILE_ROUTE}/[a-z-]+/\\{z\\}/\\{x\\}/\\{y\\}$`));
        expect(raster.source.tileSize).toBe(256);
      }
    }
    expect(tileUrlTemplate('osm')).toBe('/api/tiles/osm/{z}/{x}/{y}');
  });

  it('uses each source maxzoom so MapLibre overzooms instead of asking for missing tiles', () => {
    expect(Object.fromEntries(Object.entries(TILE_SOURCES).map(([id, source]) => [id, source.maxzoom]))).toEqual({ osm: 19, hot: 19, imagery: 18, 'imagery-labels': 18, topo: 17 });
    expect(basemapRasterLayers('topo')[0].source.maxzoom).toBe(17);
    expect(basemapRasterLayers('satellite')[0].source.maxzoom).toBe(18);
    expect(basemapRasterLayers('standard')[0].source.maxzoom).toBe(19);
  });

  it('derives Light and Dark from the Standard tiles with raster paint', () => {
    expect(basemapBaseSource('standard')).toBe('osm');
    expect(basemapBaseSource('light')).toBe('osm');
    expect(basemapBaseSource('dark')).toBe('osm');
    const dark = BASEMAPS.dark.layers[0].paint ?? {};
    // brightness-min above brightness-max inverts the light tiles.
    expect(dark['raster-brightness-min']).toBeGreaterThan(dark['raster-brightness-max'] ?? 1);
    expect(dark['raster-hue-rotate']).toBe(180);
    expect(BASEMAPS.light.layers[0].paint?.['raster-saturation']).toBeLessThan(0);
    expect(BASEMAPS.dark.tone).toBe('dark');
    expect(BASEMAPS.light.tone).toBe('light');
    expect(BASEMAPS.satellite.tone).toBe('dark');
    expect(BASEMAPS.hybrid.tone).toBe('dark');
  });

  it('puts the base layer first and the labels above it, each with its own source id', () => {
    const hybrid = basemapRasterLayers('hybrid');
    expect(hybrid.map((raster) => raster.id)).toEqual(['bm-hybrid', 'bm-hybrid-1']);
    expect(hybrid.map((raster) => raster.source.tiles?.[0])).toEqual(['/api/tiles/imagery/{z}/{x}/{y}', '/api/tiles/imagery-labels/{z}/{x}/{y}']);
    expect(hybrid[0].layer).toMatchObject({ id: 'bm-hybrid', type: 'raster', source: 'bm-hybrid' });
    expect(hybrid[1].layer).toMatchObject({ id: 'bm-hybrid-1', source: 'bm-hybrid-1' });
    expect(basemapRasterLayers('plain')).toEqual([]);
    expect(basemapBaseSource('plain')).toBeNull();
  });

  it('turns tile fades off under reduced motion', () => {
    expect(basemapRasterLayers('standard', '', true)[0].layer.paint?.['raster-fade-duration']).toBe(0);
    expect(basemapRasterLayers('standard', '', false)[0].layer.paint?.['raster-fade-duration']).toBe(300);
  });

  it('recognises only basemap source ids', () => {
    for (const id of IDS) {
      expect(isBasemapSourceId(basemapSourceId(id))).toBe(true);
      expect(isBasemapSourceId(basemapSourceId(id, 1))).toBe(true);
    }
    for (const other of ['doa-beam', 'doa-station', 'osm', 'bm-', 'bm-unknown', 'bm-standard-12', 'xbm-standard']) expect(isBasemapSourceId(other), other).toBe(false);
  });

  it('credits the sources of every tiled style with https links, and Plain has none', () => {
    for (const id of IDS) {
      const style = BASEMAPS[id];
      if (style.layers.length === 0) {
        expect(style.attribution).toBeNull();
        continue;
      }
      expect(style.attribution?.text).toBeTruthy();
      expect(style.attribution?.links.length).toBeGreaterThan(0);
      for (const link of style.attribution?.links ?? []) {
        expect(link.href).toMatch(/^https:\/\//);
        expect(link.text.trim()).not.toBe('');
      }
    }
    expect(BASEMAPS.satellite.attribution?.links[0].text).toBe('Powered by Esri');
  });
});

describe('basemap preference', () => {
  it('is a server-synced preference key', () => {
    expect(PREFERENCE_KEYS).toContain(BASEMAP_STORAGE_KEY);
    expect(BASEMAP_STORAGE_KEY).toBe('sdr-console-basemap');
  });

  it('round-trips a style id and falls back to Standard on anything else', () => {
    const storage = memoryStorage();
    expect(loadBasemapId(storage)).toBe('standard');
    saveBasemapId('satellite', storage);
    expect(storage.values.get(BASEMAP_STORAGE_KEY)).toBe('satellite');
    expect(loadBasemapId(storage)).toBe('satellite');
    for (const bad of ['', 'Satellite', 'streets', 'x'.repeat(40), '__proto__', 'toString']) {
      expect(loadBasemapId(memoryStorage({ [BASEMAP_STORAGE_KEY]: bad })), bad).toBe('standard');
    }
    expect(loadBasemapId(null)).toBe('standard');
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadBasemapId(throwing)).toBe('standard');
    expect(() => saveBasemapId('dark', throwing)).not.toThrow();
  });

  it('normalizes unknown values', () => {
    for (const value of [undefined, null, 3, {}, 'streets', 'carto-dark']) expect(normalizeBasemapId(value)).toBe('standard');
    expect(normalizeBasemapId('hybrid')).toBe('hybrid');
  });
});
