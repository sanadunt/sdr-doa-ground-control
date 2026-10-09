import { describe, expect, it } from 'vitest';
import serverSource from '../../../tools/ground_console.py?raw';
import { ONLINE_BASEMAPS, normalizeTileSets, resolveBasemap } from './basemaps';

const ORIGIN = 'http://127.0.0.1:8787';
const tileSet = { id: 'bandung', name: 'Bandung', format: 'png', minzoom: 10, maxzoom: 16, bounds: [107.5, -7, 107.8, -6.8] as [number, number, number, number], attribution: 'Local survey' };

describe('basemap registry', () => {
  it('offers the five online basemaps in menu order', () => {
    expect(ONLINE_BASEMAPS.map((basemap) => basemap.id)).toEqual(['osm', 'osm-light', 'osm-dark', 'osm-hot', 'esri-imagery']);
  });

  it('only uses tile hosts that the console CSP allows', () => {
    const block = /BASEMAP_TILE_HOSTS = " "\.join\(\(([\s\S]*?)\)\)/.exec(serverSource)?.[1] ?? '';
    const allowed = new Set([...block.matchAll(/"(https:\/\/[^"]+)"/g)].map((match) => match[1]));
    expect(allowed.size).toBeGreaterThan(0);
    for (const basemap of ONLINE_BASEMAPS) {
      for (const template of basemap.tiles) expect(allowed).toContain(new URL(template.replace(/[{}]/g, '')).origin);
    }
  });

  it('resolves an MBTiles choice to the local tile route with its zoom range', () => {
    const spec = resolveBasemap('mbtiles:bandung', [tileSet], ORIGIN);
    expect(spec.tiles).toEqual([`${ORIGIN}/api/tiles/bandung/{z}/{x}/{y}`]);
    expect([spec.minzoom, spec.maxzoom]).toEqual([10, 16]);
    expect(spec.bounds).toEqual(tileSet.bounds);
    expect(spec.attribution).toBe('Local survey');
  });

  it('falls back to OSM for unknown or missing choices', () => {
    expect(resolveBasemap('mbtiles:gone', [tileSet], ORIGIN).id).toBe('osm');
    expect(resolveBasemap('google-maps', [], ORIGIN).id).toBe('osm');
    expect(resolveBasemap('osm-dark', [], ORIGIN).id).toBe('osm-dark');
  });

  it('drops tile-set entries with unsafe ids or broken fields', () => {
    const items = normalizeTileSets({ items: [
      { id: 'ok_1', name: ' Area ', minzoom: 3, maxzoom: 2, bounds: [1, 2, 3], attribution: 42 },
      { id: '../etc', name: 'bad' },
      { id: '', name: 'empty' },
      'not an object',
    ] });
    expect(items).toEqual([{ id: 'ok_1', name: 'Area', format: 'png', minzoom: 3, maxzoom: 3, bounds: null, attribution: '' }]);
    expect(normalizeTileSets(null)).toEqual([]);
  });
});
