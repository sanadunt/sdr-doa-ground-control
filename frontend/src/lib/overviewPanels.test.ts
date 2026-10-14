import { describe, expect, it } from 'vitest';
import { DEFAULT_OVERVIEW_PANELS, OVERVIEW_PANELS_STORAGE_KEY, loadOverviewPanels, sameOverviewPanels, saveOverviewPanels, validateOverviewPanels } from './overviewPanels';

function memoryStorage(entries: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { values: Map<string, string> } {
  const values = new Map(Object.entries(entries));
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); } };
}

describe('Overview panels', () => {
  it('start from the mockup defaults: polar and spectrum open, node card collapsed', () => {
    expect(DEFAULT_OVERVIEW_PANELS).toEqual({ layers: false, polar: true, spectrum: true, control: false, nodeCollapsed: true });
    expect(loadOverviewPanels(memoryStorage())).toEqual(DEFAULT_OVERVIEW_PANELS);
    expect(loadOverviewPanels(null)).toEqual(DEFAULT_OVERVIEW_PANELS);
  });

  it('restore each stored boolean on its own and ignore anything else', () => {
    expect(validateOverviewPanels({ layers: true, polar: 'no', spectrum: false, control: 1, nodeCollapsed: false, extra: true }))
      .toEqual({ layers: true, polar: true, spectrum: false, control: false, nodeCollapsed: false });
    expect(validateOverviewPanels(null)).toEqual(DEFAULT_OVERVIEW_PANELS);
    expect(validateOverviewPanels([true, false])).toEqual(DEFAULT_OVERVIEW_PANELS);
  });

  it('survive corrupt, oversized or failing storage', () => {
    expect(loadOverviewPanels(memoryStorage({ [OVERVIEW_PANELS_STORAGE_KEY]: '{not json' }))).toEqual(DEFAULT_OVERVIEW_PANELS);
    expect(loadOverviewPanels(memoryStorage({ [OVERVIEW_PANELS_STORAGE_KEY]: JSON.stringify({ layers: true, pad: 'x'.repeat(2000) }) }))).toEqual(DEFAULT_OVERVIEW_PANELS);
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadOverviewPanels(throwing)).toEqual(DEFAULT_OVERVIEW_PANELS);
    expect(() => saveOverviewPanels(DEFAULT_OVERVIEW_PANELS, throwing)).not.toThrow();
  });

  it('round-trip through storage', () => {
    const storage = memoryStorage();
    const panels = { layers: true, polar: false, spectrum: true, control: true, nodeCollapsed: false };
    saveOverviewPanels(panels, storage);
    expect(loadOverviewPanels(storage)).toEqual(panels);
    expect(sameOverviewPanels(loadOverviewPanels(storage), panels)).toBe(true);
    expect(sameOverviewPanels(panels, DEFAULT_OVERVIEW_PANELS)).toBe(false);
  });
});
