import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nContext, translate } from '../lib/i18n';
import type { Lang } from '../lib/i18n';
import { DEFAULT_SIMULATION } from '../lib/simulation';
import { SimulationPage } from './SimulationPage';

function render(element: ReactElement, lang: Lang = 'en'): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) }}>{element}</I18nContext.Provider>,
  );
}

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
}

const noop = () => undefined;

function page(enabled: boolean, automatic = false, lang: Lang = 'en'): string {
  return render(
    <SimulationPage enabled={enabled} automatic={automatic} settings={DEFAULT_SIMULATION} onEnabled={noop} onAutomatic={noop} onSettings={noop} onRandomize={noop} onOverview={noop} />,
    lang,
  );
}

describe('SimulationPage', () => {
  it('uses switches; randomizing waits until the simulation is on', () => {
    const off = page(false);
    expect(off).toContain(`role="switch" aria-checked="false" class="pg-switch"><span class="pg-switch-track" aria-hidden="true"><span class="pg-switch-thumb"></span></span><span class="pg-switch-label">${translate('en', 'sim.enable')}</span>`);
    expect(off).toMatch(/role="switch" aria-checked="false" class="pg-switch" disabled="">.*?Randomize every second/);
    expect(off).toMatch(/<button type="button" class="ov-button" disabled="">.*?Randomize now<\/button>/);
    expect(off).not.toContain('type="checkbox"');

    const on = page(true, true);
    expect(on).toMatch(/role="switch" aria-checked="true" class="pg-switch"><span class="pg-switch-track"[^]*?Simulation on Dashboard/);
    expect(on).not.toMatch(/class="ov-button" disabled="">.*?Randomize now/);
  });

  it('shows SIM ON and the SIMULATION tag in the page bar only while it is on', () => {
    expect(text(page(false))).toContain('Sim OFF');
    expect(page(false)).not.toContain('SIMULATION');
    const on = page(true, true);
    expect(text(on)).toContain('Sim ON SIMULATION AUTO');
    expect(on).toContain(translate('en', 'sim.viewDashboard'));
  });

  it('lists the active scenario as values', () => {
    const body = text(page(true));
    expect(body).toContain('Bearing 45°');
    expect(body).toContain(`${translate('en', 'sim.width')} 18°`);
    expect(body).toContain(`${translate('en', 'sim.halfPower')} 13°`);
    expect(body).toContain(`${translate('en', 'sim.position')} -6.932469, 107.660694`);
  });

  it('edits the scenario in compact fields with units and six-decimal coordinates', () => {
    const markup = page(false);
    expect(markup).toContain('value="-6.932469"');
    expect(markup).toContain('value="107.660694"');
    expect(markup).not.toContain('6.932468839245536');
    expect(markup.match(/<span class="pg-unit">°<\/span>/g)).toHaveLength(4);
    expect(markup).toContain('placeholder="0–359"');
    expect(markup).toContain('<button class="ov-button is-primary" type="submit">Apply</button>');
    expect(markup).not.toContain('pg-field-error');
  });

  it('previews the lobe of the scenario on a compass', () => {
    const markup = page(false);
    expect(markup).toContain('<svg class="ms-preview" viewBox="0 0 240 240" role="img" aria-label="Preview">');
    expect(markup).toMatch(/<path class="ms-preview-lobe" d="M[^"]+ Z"><\/path>/);
    expect(markup.match(/class="ms-preview-edge"/g)).toHaveLength(2);
    expect(markup).toContain('<span class="ov-tag tone-neutral">−3 dB 13°</span>');
    // Bearing 45°: the tip sits up and to the right of the centre.
    const tip = /<circle class="ms-preview-tip" cx="([\d.]+)" cy="([\d.]+)"/.exec(markup);
    expect(tip).not.toBeNull();
    expect(Number(tip?.[1])).toBeGreaterThan(120);
    expect(Number(tip?.[2])).toBeLessThan(120);
  });

  it('carries no explanatory prose and renders in Indonesian', () => {
    const id = text(page(true, false, 'id'));
    expect(id).toContain('Simulasi di Dashboard');
    expect(id).toContain('Acak tiap detik');
    expect(id).toContain('Lihat di Dashboard');
    expect(id).toContain('Sebaran σ');
    expect(id).not.toContain('Ringkasan');
    expect(id).not.toMatch(/Kurva Gaussian|Data dibuat di browser/);
  });
});
