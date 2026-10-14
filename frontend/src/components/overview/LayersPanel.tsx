import type { JSX } from 'react';
import { DEFAULT_DOA_OVERLAY_SETTINGS } from '../../lib/doaGeometry';
import type { DbScale, DoaOverlaySettings } from '../../lib/doaGeometry';
import { OVERLAY_OPACITY_MIN } from '../../lib/mapOverlaySettings';
import type { BasemapStatus } from '../../lib/map';
import { useI18n } from '../../lib/i18n';
import type { MessageKey } from '../../lib/i18n';
import { OverlayControls } from '../OverlayControls';
import { Icon } from '../ui';

type LayerKey = 'heatmapVisible' | 'lobeVisible' | 'bearingVisible' | 'edgesVisible' | 'ringsVisible' | 'guidesVisible' | 'labelsVisible';

const LAYERS: ReadonlyArray<[LayerKey, MessageKey]> = [
  ['heatmapVisible', 'layers.beam'],
  ['lobeVisible', 'layers.lobe'],
  ['bearingVisible', 'layers.line'],
  ['edgesVisible', 'layers.edges'],
  ['ringsVisible', 'layers.rings'],
  ['guidesVisible', 'layers.guides'],
  ['labelsVisible', 'layers.labels'],
];

/** Map layers panel: the seven layer switches, overlay opacity and the advanced overlay settings. */
export function LayersPanel({
  settings,
  scale,
  basemap,
  onChange,
  onClose,
}: {
  settings: DoaOverlaySettings;
  scale: DbScale;
  basemap: BasemapStatus;
  onChange: (next: DoaOverlaySettings) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const opacity = Math.round(settings.overlayOpacity * 100);
  const scaleText = scale.mode === 'manual'
    ? t('polarDock.dbManual')
    : scale.known ? `${t('polarDock.dbAuto')} · ${Number(scale.minDb.toFixed(1))} … ${Number(scale.maxDb.toFixed(1))} dB` : t('polarDock.dbAuto');
  return (
    <section id="panel-layers" className="ov-layers ov-card" aria-labelledby="ov-layers-title">
      <div className="ov-card-head ov-card-head-rule">
        <h2 id="ov-layers-title">{t('layers.title')}</h2>
        <button className="ov-icon-button" type="button" aria-label={t('layers.close')} title={t('layers.close')} onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="ov-layers-body">
        <div className="ov-layer-grid">
          {LAYERS.map(([key, label]) => (
            <label key={key} className="ov-check">
              <input type="checkbox" checked={settings[key]} onChange={(event) => onChange({ ...settings, [key]: event.target.checked })} />
              <span>{t(label)}</span>
            </label>
          ))}
        </div>
        <label className="ov-range">
          <span className="ov-range-head"><span>{t('layers.opacity')}</span><output>{opacity} %</output></span>
          <input
            type="range"
            aria-label={t('layers.opacity')}
            min={Math.round(OVERLAY_OPACITY_MIN * 100)}
            max="100"
            step="5"
            value={opacity}
            onChange={(event) => onChange({ ...settings, overlayOpacity: Number(event.target.value) / 100 })}
          />
        </label>
        <div className="ov-layers-meta">
          <span>{t('layers.dbScale', { mode: scaleText })}</span>
          <span className={basemap.unavailable ? 'is-warn' : 'ov-mono'}>{basemap.unavailable ? t('map.basemapUnavailable') : t('layers.basemap', { host: basemap.host })}</span>
        </div>
        <details className="ov-advanced">
          <summary>{t('layers.advanced')}</summary>
          <OverlayControls embedded settings={settings} scale={scale} onChange={onChange} onReset={() => onChange({ ...DEFAULT_DOA_OVERLAY_SETTINGS })} />
        </details>
      </div>
    </section>
  );
}
