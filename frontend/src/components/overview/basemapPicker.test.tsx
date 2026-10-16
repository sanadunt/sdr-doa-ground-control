import type { CSSProperties, ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BASEMAP_ORDER } from '../../lib/basemaps';
import { I18nContext, translate } from '../../lib/i18n';
import type { Lang } from '../../lib/i18n';
import { NO_PAGE_SHORTCUTS_ATTRIBUTE } from '../../lib/shortcuts';
import { BasemapMenu, BasemapSelect, basemapMenuPosition } from './BasemapPicker';

function render(element: ReactElement, lang: Lang = 'en'): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>{element}</I18nContext.Provider>,
  );
}

/** Vitest blanks every CSS import, so the stylesheet is read from disk. */
function readStylesheet(path: string): string {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  return process.getBuiltinModule('node:fs').readFileSync(new URL(path, import.meta.url), 'utf8');
}

const noop = () => undefined;

describe('basemap menu', () => {
  it('is a 44 px map button with a closed radio menu in the top layer', () => {
    const html = render(<BasemapMenu value="satellite" onChange={noop} />);
    expect(html).toMatch(/<button class="ov-map-button" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="ov-basemap-menu" aria-label="Basemap" title="Basemap">/);
    // A popover is drawn in the top layer, above the map's floating panels and the dock.
    expect(html).toMatch(/<div id="ov-basemap-menu" class="ov-basemap-menu" popover="manual" role="radiogroup" aria-label="Basemap" data-no-page-shortcuts="" hidden=""/);
    const inputs = [...html.matchAll(/<input type="radio" name="ov-basemap-menu"[^>]*>/g)].map((match) => match[0]);
    expect(inputs.map((input) => /value="([a-z]+)"/.exec(input)?.[1])).toEqual([...BASEMAP_ORDER]);
    expect(inputs.filter((input) => input.includes('checked=""')).map((input) => /value="([a-z]+)"/.exec(input)?.[1])).toEqual(['satellite']);
  });

  it('keeps digit keys inside the open menu, so a digit does not leave the Dashboard', () => {
    const html = render(<BasemapMenu value="standard" onChange={noop} />);
    expect(html).toMatch(new RegExp(`<div id="ov-basemap-menu"[^>]* ${NO_PAGE_SHORTCUTS_ATTRIBUTE}=""`));
  });

  it('shows the style names in both languages', () => {
    const english = render(<BasemapMenu value="standard" onChange={noop} />);
    for (const label of ['Standard', 'Hot', 'Light', 'Dark', 'Satellite', 'Satellite + labels', 'Topographic', 'Plain']) expect(english).toContain(`<span>${label}</span>`);
    const indonesian = render(<BasemapMenu value="standard" onChange={noop} />, 'id');
    for (const label of ['Standar', 'Hot', 'Terang', 'Gelap', 'Satelit', 'Satelit + label', 'Topografi', 'Polos']) expect(indonesian).toContain(`<span>${label}</span>`);
    expect(indonesian).toContain('aria-label="Peta dasar"');
  });

  it('opens above its button when there is room and stays in the viewport', () => {
    const viewport = { width: 1440, height: 900 };
    const space = (style: CSSProperties) => (style as Record<string, unknown>)['--ov-basemap-space'];
    const up = basemapMenuPosition({ top: 600, bottom: 644, left: 200 }, { width: 280, height: 200 }, viewport);
    expect(up).toMatchObject({ left: 200, bottom: 900 - 600 + 6, top: 'auto' });
    // The room goes to the stylesheet, which also applies its own caps per layout.
    expect(up).not.toHaveProperty('maxHeight');
    expect(space(up)).toBe('420px');
    expect(space(basemapMenuPosition({ top: 230, bottom: 274, left: 200 }, { width: 280, height: 200 }, viewport))).toBe(`${230 - 6 - 8}px`);
    const down = basemapMenuPosition({ top: 40, bottom: 84, left: 1400 }, { width: 280, height: 200 }, viewport);
    expect(down).toMatchObject({ top: 90, bottom: 'auto', left: 1440 - 280 - 8 });
    // Phone widths keep the 16 px side gutter on both sides.
    const phoneViewport = { width: 390, height: 844 };
    expect(basemapMenuPosition({ top: 500, bottom: 544, left: 16 }, { width: 280, height: 200 }, phoneViewport).left).toBe(16);
    expect(basemapMenuPosition({ top: 500, bottom: 544, left: 230 }, { width: 280, height: 200 }, phoneViewport).left).toBe(390 - 280 - 16);
  });
});

describe('basemap select', () => {
  it('offers the same styles with the value selected', () => {
    const html = render(<BasemapSelect value="topo" onChange={noop} />, 'id');
    expect(html).toMatch(/^<label class="ov-basemap-row"><span>Peta dasar<\/span><select>/);
    const values = [...html.matchAll(/<option value="([a-z]+)"/g)].map((match) => match[1]);
    expect(values).toEqual([...BASEMAP_ORDER]);
    expect(html).toContain('<option value="topo" selected="">Topografi</option>');
  });
});

describe('basemap styles', () => {
  const css = readStylesheet('../../overview-dashboard.css');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2] }));
  const declarations = (selector: string) => rules.filter((rule) => rule.selector.split(',').some((part) => part.trim().endsWith(selector))).map((rule) => rule.body).join(';');

  it('keeps every picker target at 44 px', () => {
    for (const selector of ['.ov-basemap-option', '.ov-basemap-row', '.ov-basemap-row select', '.ov-map-attribution']) {
      expect(declarations(selector), selector).toMatch(/(?:^|[;\s])(?:min-)?height:\s*44px/);
    }
  });

  it('scrolls the menu inside the viewport and narrows it on a phone', () => {
    expect(declarations('.ov-basemap-menu')).toMatch(/overflow-y:\s*auto/);
    expect(declarations('.ov-basemap-menu')).toMatch(/position:\s*fixed/);
    expect(declarations('.ov-basemap-menu')).toMatch(/max-height:\s*min\(420px, 60vh, var\(--ov-basemap-space, 420px\)\)/);
    expect(css).toMatch(/@media \(max-width: 1023px\)[\s\S]*\.ov-basemap-menu \{ max-height: min\(320px, 40vh, var\(--ov-basemap-space, 320px\)\); \}/);
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*\.ov-basemap-menu \{ width: min\(280px, calc\(100vw - 32px\)\); \}/);
    expect(declarations('.ov-basemap-menu[hidden]')).toMatch(/display:\s*none/);
  });

  it('uses console tokens only', () => {
    for (const rule of rules.filter((item) => /ov-basemap|ov-map-attribution/.test(item.selector))) {
      expect(rule.body, rule.selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });
});
