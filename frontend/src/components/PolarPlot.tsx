import { useEffect, useMemo, useRef, useState } from 'react';
import type { Config } from 'plotly.js';
import type { PolarSettings } from '../types';
import type { PlotlyApi } from '../lib/plotlyPolar';
import { angularDirection, displayAngleForBin } from '../lib/polar';
import { useI18n } from '../lib/i18n';
import type { Lang, Translate } from '../lib/i18n';

const FIXED_DOMAIN: [number, number] = [-60, 0];
// Live Data Out vectors are shifted dB that often span only 1-3 dB; scale to
// the data instead of 10 dB steps so the lobe fills the plot.
const RADIAL_MIN_SPAN_DB = 1;
const MAX_RADIAL_TICKS = 12;

function clean(value: number): number {
  const rounded = Number(value.toFixed(9));
  return rounded === 0 ? 0 : rounded;
}

/** Smallest 1/2/5 x 10^k step that is at least `raw`. */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(raw));
  const fraction = clean(raw / base);
  return clean((fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * base);
}

export function radialDomain(values: number[] | null, simulation = false): [number, number] {
  if (simulation || !values?.length) return FIXED_DOMAIN;
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return FIXED_DOMAIN;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const step = niceStep(Math.max(max - min, RADIAL_MIN_SPAN_DB) / 4);
  const low = clean(Math.floor(clean(min / step)) * step);
  const high = clean(Math.ceil(clean(max / step)) * step);
  return [low, high > low ? high : clean(low + step)];
}

/** Absolute dB tick values on the radial axis; compact plots show only the ends. */
export function radialTicks(low: number, high: number, compact = false): number[] {
  if (compact || !(high > low)) return [low, high];
  const step = niceStep((high - low) / 4);
  const first = Math.ceil(clean(low / step));
  const last = Math.floor(clean(high / step));
  const ticks: number[] = [];
  for (let index = first; index <= last && ticks.length < MAX_RADIAL_TICKS; index += 1) ticks.push(clean(index * step));
  return ticks.length >= 2 ? ticks : [low, high];
}

export function polarUiRevision(settings: PolarSettings, simulation: boolean): string {
  return `${simulation ? 'simulation' : 'live'}:${settings.figType}:${settings.compassOffset}`;
}

export function validHeadUp(head: number): boolean {
  return Number.isFinite(head) && head >= 0 && head < 360;
}

export function validPlotRange(head: number, min: number, max: number): boolean {
  return validHeadUp(head) && Number.isFinite(min) && Number.isFinite(max) && min < max;
}

// Modebar buttons that would upload the figure to Plotly Cloud, or that select
// points the console does not use.
export const REMOVED_MODEBAR_BUTTONS = ['sendChartToCloud', 'select2d', 'lasso2d'] as const;

/** Plotly config for the polar panel: local only, localized modebar. */
export function polarPlotConfig(lang: Lang, t: Translate): Partial<Config> {
  const config: Partial<Config> = {
    responsive: true,
    displaylogo: false,
    displayModeBar: true,
    showSendToCloud: false,
    plotlyServerURL: '',
    modeBarButtonsToRemove: [...REMOVED_MODEBAR_BUTTONS],
    locale: lang,
  };
  if (lang !== 'en') {
    // Plotly looks up its own English strings in this dictionary.
    config.locales = {
      [lang]: {
        dictionary: {
          'Download plot as a PNG': t('polar.modebarDownload'),
          Zoom: t('polar.modebarZoom'),
          'Toggle show closest data on hover': t('polar.modebarHover'),
          'Preparing image - this may take a few seconds': t('polar.modebarPreparing'),
          'Image download succeeded': t('polar.modebarSucceeded'),
          'Sorry, there was a problem downloading your image!': t('polar.modebarFailed'),
        },
      },
    };
  }
  return config;
}

function dbLabel(value: number): string {
  return `${Number(value.toFixed(2))}`;
}

export function PolarPlot({ values, settings, simulation, offsetSource }: { values: number[] | null; settings: PolarSettings; simulation: boolean; offsetSource: string }) {
  const { lang, t } = useI18n();
  const loadFailedText = useRef('');
  loadFailedText.current = t('polar.loadFailed');
  const host = useRef<HTMLDivElement>(null);
  const library = useRef<PlotlyApi | null>(null);
  const renderQueue = useRef<Promise<unknown>>(Promise.resolve());
  const dataRevision = useRef(0);
  const layoutKey = useRef('');
  const lastLiveDomain = useRef<[number, number] | null>(null);
  const [compact, setCompact] = useState(false);
  const liveDomain = useMemo(() => (values && !simulation ? radialDomain(values) : null), [values, simulation]);
  // Keep the last live scale while the curve is briefly cleared so an
  // ordinary refresh does not replay the layout and reset the operator's zoom.
  if (liveDomain) lastLiveDomain.current = liveDomain;
  const [autoLow, autoHigh] = simulation ? FIXED_DOMAIN : liveDomain ?? lastLiveDomain.current ?? FIXED_DOMAIN;
  const [controls, setControls] = useState({ head: 0, min: autoLow, max: autoHigh, manual: false, revision: 0 });
  const [draft, setDraft] = useState({ head: '0', min: String(autoLow), max: String(autoHigh), manual: false });
  const [error, setError] = useState('');
  const [theme, setTheme] = useState(0);
  const [low, high] = controls.manual ? [controls.min, controls.max] : [autoLow, autoHigh];
  useEffect(() => {
    const update = () => setTheme(n => n + 1);
    window.addEventListener('console-theme-change', update);
    return () => window.removeEventListener('console-theme-change', update);
  }, []);
  useEffect(() => {
    const node = host.current;
    return () => { layoutKey.current = ''; if (node) library.current?.purge(node); };
  }, []);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let disposed = false;
    let plot: PlotlyApi | undefined;
    const render = async () => {
      const module = await import('../lib/plotlyPolar');
      if (disposed) return;
      plot = module.default;
      library.current = plot;
      const css = getComputedStyle(document.documentElement);
      const color = (key: string) => css.getPropertyValue(key).trim();
      const samples = values?.length === 360 && values.every(Number.isFinite) ? [...values, values[0]] : [];
      const ticks = radialTicks(low, high, compact);
      const angles = Array.from({ length: 12 }, (_, i) => i * 30);
      const cardinal: Record<number, string> = { 0: t('map.cardinalN'), 90: t('map.cardinalE'), 180: t('map.cardinalS'), 270: t('map.cardinalW') };
      const hoverAxis = settings.figType === 'Compass' ? t('polar.hoverCompass') : t('polar.hoverPolar');
      const revision = `${polarUiRevision(settings, simulation)}:${controls.revision}:${compact}`;
      const key = `${revision}:${low}:${high}:${theme}:${lang}`;
      // Data-only updates must not replay the layout or Plotly's interaction
      // defaults. Restyle updates the curve while preserving rotated/zoomed axes.
      if (layoutKey.current === key) {
        // Restyle's runtime API wraps per-trace arrays; upstream typings omit
        // this additional dimension for polar coordinates and customdata.
        const update = {
          r: [samples.map(v => Math.max(0, v - low))],
          theta: [samples.map((_, i) => displayAngleForBin(i % 360, settings))],
          customdata: [samples.map((v, i) => [i % 360, v])],
        };
        await plot.restyle(node, update as unknown as Parameters<typeof plot.restyle>[1], [0]);
        return;
      }
      await plot.react(node, [{ type: 'scatterpolar', mode: 'lines',
        r: samples.map(v => Math.max(0, v - low)), theta: samples.map((_, i) => displayAngleForBin(i % 360, settings)),
        customdata: samples.map((v, i) => [i % 360, v]),
        hovertemplate: `${hoverAxis} %{theta:.1f}°<br>${t('polar.hoverBin')} %{customdata[0]}<br>%{customdata[1]:.2f} dB<extra></extra>`,
        fill: 'toself', fillcolor: color('--plot-fill'), line: { color: color('--signal'), width: 2 },
      }], { autosize: true, datarevision: ++dataRevision.current, uirevision: revision,
        margin: compact ? { t: 40, b: 40, l: 40, r: 40 } : { t: 48, b: 48, l: 64, r: 64 },
        paper_bgcolor: color('--surface'), font: { color: color('--text'), size: 13 }, showlegend: false,
        polar: { bgcolor: color('--surface'), uirevision: revision,
          // Compass labels run clockwise; Polar labels are theta_0 and run
          // counter-clockwise as in KrakenSDR. Head Up turns both the same way.
          angularaxis: { rotation: 90 + controls.head, direction: angularDirection(settings), tickmode: 'array', tickvals: angles,
            ticktext: angles.map(a => {
              if (settings.figType !== 'Compass' || !cardinal[a]) return `${a}°`;
              return compact ? cardinal[a] : `${cardinal[a]} ${a}°`;
            }), gridcolor: color('--line') },
          radialaxis: { range: [0, high - low], tickmode: 'array', tickvals: ticks.map(v => v - low),
            ticktext: ticks.map(v => `${dbLabel(v)} dB`), angle: 45, gridcolor: color('--line') },
        },
      }, polarPlotConfig(lang, t));
      layoutKey.current = key;
    };
    // Serialize Plotly updates; expired snapshots waiting in the queue are skipped.
    const update = () => {
      renderQueue.current = renderQueue.current.catch(() => undefined).then(() => {
        if (!disposed) return render();
      }).catch(() => { if (!disposed) node.textContent = loadFailedText.current; });
    };
    update();
    const observer = new ResizeObserver(() => {
      const nextCompact = node.clientWidth < 420;
      setCompact(current => current === nextCompact ? current : nextCompact);
      if (plot && !disposed) void plot.Plots.resize(node);
    });
    observer.observe(node);
    return () => { disposed = true; observer.disconnect(); };
  }, [values, settings, simulation, low, high, controls, theme, compact, lang, t]);
  const mode = controls.manual ? t('polar.modeManual') : simulation ? t('polar.modeSimulation') : t('polar.modeAuto');
  const caption = settings.figType === 'Compass'
    ? t('polar.captionCompass', {
      head: controls.head,
      offset: Number(settings.compassOffset.toFixed(1)),
      source: offsetSource,
      mode,
      low: dbLabel(low),
      high: dbLabel(high),
    })
    : t('polar.captionPolar', { head: controls.head, mode, low: dbLabel(low), high: dbLabel(high) });
  const syncAutoRange = () => setDraft(current => ({ ...current, min: String(autoLow), max: String(autoHigh) }));
  return <>
    <div ref={host} className="plotly-polar" role="img" aria-label={t('polar.plotAria', { source: simulation ? t('polar.sourceSimulation') : t('polar.sourceLive'), fig: settings.figType })} />
    <div className="polar-axis-caption">{caption}</div>
    <details className="plot-settings" onToggle={event => { if (event.currentTarget.open && !controls.manual) syncAutoRange(); }}>
      <summary>{t('polar.settings')}</summary>
      <form className="plot-controls" onSubmit={event => {
        event.preventDefault();
        const head = Number(draft.head);
        if (!draft.head.trim() || !validHeadUp(head)) { setError(t('polar.headError')); return; }
        if (!draft.manual) {
          // Head Up alone keeps the automatic radial range.
          setError(''); setControls(current => ({ ...current, head, manual: false, revision: current.revision + 1 }));
          return;
        }
        const min = Number(draft.min), max = Number(draft.max);
        if (!draft.min.trim() || !draft.max.trim() || !validPlotRange(head, min, max)) { setError(t('polar.rangeError')); return; }
        setError(''); setControls(current => ({ head, min, max, manual: true, revision: current.revision + 1 }));
      }}>
        <label className="form-field"><span>{t('polar.headUp')}</span><input required type="number" min="0" max="359.999" step="any" value={draft.head} onChange={e => setDraft({ ...draft, head: e.target.value })} /></label>
        <label className="plot-manual-toggle"><input type="checkbox" checked={draft.manual} onChange={e => {
          const manual = e.target.checked;
          setDraft(current => ({ ...current, manual, ...(manual && !current.manual && !controls.manual ? { min: String(autoLow), max: String(autoHigh) } : {}) }));
        }} /> {t('polar.manualRange')}</label>
        <label className="form-field"><span>{t('polar.minDb')}</span><input required={draft.manual} disabled={!draft.manual} type="number" step="any" value={draft.min} onChange={e => setDraft({ ...draft, min: e.target.value })} /></label>
        <label className="form-field"><span>{t('polar.maxDb')}</span><input required={draft.manual} disabled={!draft.manual} type="number" step="any" value={draft.max} onChange={e => setDraft({ ...draft, max: e.target.value })} /></label>
        <button className="primary-button" type="submit">{t('polar.apply')}</button>
        <button className="secondary-button" type="button" onClick={() => {
          setControls(current => ({ head: 0, min: autoLow, max: autoHigh, manual: false, revision: current.revision + 1 }));
          setDraft({ head: '0', min: String(autoLow), max: String(autoHigh), manual: false }); setError('');
        }}>{t('polar.default')}</button>
      </form>
      {error ? <p className="plot-control-error" role="alert">{error}</p> : null}
    </details>
  </>;
}
