import { useEffect, useRef, useState } from 'react';
import type { PolarSettings } from '../types';
import { displayAngleForBin } from '../lib/polar';

export function radialDomain(values: number[] | null, simulation = false): [number, number] {
  if (simulation || !values?.length) return [-60, 0];
  const low = Math.floor(Math.min(...values) / 10) * 10;
  const high = Math.ceil(Math.max(...values) / 10) * 10 || 0;
  return [low, high > low ? high : low + 10];
}

export function polarUiRevision(settings: PolarSettings, simulation: boolean): string {
  return `${simulation ? 'simulation' : 'live'}:${settings.figType}:${settings.compassOffset}`;
}

export function validPlotRange(head: number, min: number, max: number): boolean {
  return [head, min, max].every(Number.isFinite) && head >= 0 && head < 360 && min < max;
}

export function PolarPlot({ values, settings, simulation }: { values: number[] | null; settings: PolarSettings; simulation: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const library = useRef<typeof import('plotly.js') | null>(null);
  const renderQueue = useRef<Promise<unknown>>(Promise.resolve());
  const dataRevision = useRef(0);
  const layoutKey = useRef('');
  const [controls, setControls] = useState({ head: 0, min: -60, max: 0, manual: false, revision: 0 });
  const [draft, setDraft] = useState({ head: '0', min: '-60', max: '0' });
  const [error, setError] = useState('');
  const [theme, setTheme] = useState(0);
  const [low, high] = controls.manual ? [controls.min, controls.max] : radialDomain(values, simulation);
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
    let plot: typeof import('plotly.js') | undefined;
    const render = async () => {
      const module = await import('plotly.js-dist-min');
      if (disposed) return;
      plot = module.default;
      library.current = plot;
      const css = getComputedStyle(document.documentElement);
      const color = (key: string) => css.getPropertyValue(key).trim();
      const samples = values?.length === 360 && values.every(Number.isFinite) ? [...values, values[0]] : [];
      const ticks = Array.from({ length: 6 }, (_, i) => (high - low) * i / 5);
      const angles = Array.from({ length: 12 }, (_, i) => i * 30);
      const cardinal: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
      const revision = `${polarUiRevision(settings, simulation)}:${controls.revision}`;
      const key = `${revision}:${low}:${high}:${theme}`;
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
        hovertemplate: 'Display %{theta:.1f}°<br>Bin %{customdata[0]}<br>%{customdata[1]:.2f} dB<extra></extra>',
        fill: 'toself', fillcolor: color('--plot-fill'), line: { color: color('--accent'), width: 2 },
      }], { autosize: true, datarevision: ++dataRevision.current, uirevision: revision, margin: { t: 48, b: 48, l: 48, r: 48 },
        paper_bgcolor: color('--surface'), font: { color: color('--text'), size: 13 }, showlegend: false,
        polar: { bgcolor: color('--surface'), uirevision: revision,
          angularaxis: { rotation: 90 + controls.head, direction: 'clockwise', tickmode: 'array', tickvals: angles,
            ticktext: angles.map(a => `${settings.figType === 'Compass' && cardinal[a] ? cardinal[a] + ' ' : ''}${a}°`), gridcolor: color('--line') },
          radialaxis: { range: [0, high - low], tickmode: 'array', tickvals: ticks,
            ticktext: ticks.map(v => `${Number((v + low).toFixed(1))} dB`), angle: 45, gridcolor: color('--line') },
        },
      }, { responsive: true, displaylogo: false, displayModeBar: true });
      layoutKey.current = key;
    };
    // Serialize Plotly updates; expired snapshots waiting in the queue are skipped.
    const update = () => {
      renderQueue.current = renderQueue.current.catch(() => undefined).then(() => {
        if (!disposed) return render();
      }).catch(() => { if (!disposed) node.textContent = 'Plotly failed to load. Reload to retry.'; });
    };
    update();
    const observer = new ResizeObserver(() => { if (plot && !disposed) void plot.Plots.resize(node); });
    observer.observe(node);
    return () => { disposed = true; observer.disconnect(); };
  }, [values, settings.figType, settings.compassOffset, simulation, low, high, controls, theme]);
  return <><form className="plot-controls" onSubmit={event => {
    event.preventDefault();
    const head = Number(draft.head), min = Number(draft.min), max = Number(draft.max);
    if (Object.values(draft).some(v => !v.trim()) || !validPlotRange(head, min, max)) { setError('Head Up harus 0–<360° dan dB minimum harus lebih kecil dari maksimum.'); return; }
    setError(''); setControls(current => ({ head, min, max, manual: true, revision: current.revision + 1 }));
  }}>
    <label className="form-field"><span>Head Up (°)</span><input required type="number" min="0" max="359.999" step="any" value={draft.head} onChange={e => setDraft({ ...draft, head: e.target.value })} /></label>
    <label className="form-field"><span>Min dB</span><input required type="number" step="any" value={draft.min} onChange={e => setDraft({ ...draft, min: e.target.value })} /></label>
    <label className="form-field"><span>Max dB</span><input required type="number" step="any" value={draft.max} onChange={e => setDraft({ ...draft, max: e.target.value })} /></label>
    <button className="primary-button" type="submit">Apply view</button>
    <button className="secondary-button" type="button" onClick={() => {
      setControls(current => ({ head: 0, min: -60, max: 0, manual: false, revision: current.revision + 1 }));
      const [min, max] = radialDomain(values, simulation);
      setDraft({ head: '0', min: String(min), max: String(max) }); setError('');
    }}>Default</button>
  </form>{error ? <p role="alert">{error}</p> : null}<div ref={host} className="plotly-polar" role="img" aria-label={`${simulation ? 'Simulation' : 'Data Out'} ${settings.figType} angular response`} />
    <div className="polar-axis-caption">{settings.figType} · Head Up preset {controls.head}° (drag can override) · source offset {settings.compassOffset}°<br />{controls.manual ? 'Manual scale' : simulation ? 'Fixed simulation scale' : 'Auto scale'}: {low}…{high} dB · source-shifted, not dBm. Values below minimum sit at center; above maximum are clipped. Hover retains original dB. Compass reference is not verified heading.</div></>;
}