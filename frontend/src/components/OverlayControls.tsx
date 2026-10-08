import type { JSX } from 'react';
import { DEFAULT_DOA_OVERLAY_SETTINGS, type DoaOverlaySettings } from '../lib/doaGeometry';
import { useI18n } from '../lib/i18n';

function settingNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const PRESETS: Record<'focused' | 'wide', Partial<DoaOverlaySettings>> = {
  focused: { maxDistanceM: 700, lobeDistanceM: 700, thresholdDb: -35, radialSamples: 10, distanceFalloff: .65, heatIntensity: 1.3, heatBlur: 22 },
  wide: { maxDistanceM: 2500, lobeDistanceM: 1800, thresholdDb: -60, radialSamples: 18, distanceFalloff: .2, heatIntensity: .9, heatBlur: 42 },
};

export function OverlayControls({ settings, onChange, onReset, onClose }: { settings: DoaOverlaySettings; onChange: (next: DoaOverlaySettings) => void; onReset: () => void; onClose: () => void }): JSX.Element {
  const { t } = useI18n();
  const update = (key: keyof DoaOverlaySettings, value: boolean | number | string) => onChange({ ...settings, [key]: value });
  const preset = (name: 'kraken' | 'focused' | 'wide') => onChange({ ...settings, ...(name === 'kraken' ? DEFAULT_DOA_OVERLAY_SETTINGS : PRESETS[name]) });
  const density = settings.heatStyle === 'density';
  return <div id="doa-overlay-controls" className="map-overlay-controls" role="region" aria-label={t('overlay.region')}>
    <div className="overlay-control-header"><h3>{t('overlay.title')}</h3><button className="text-button" type="button" aria-label={t('overlay.closeAria')} onClick={onClose}>{t('overlay.close')}</button></div>
    <fieldset className="overlay-group">
      <legend>{t('overlay.groupLayers')}</legend>
      <div className="overlay-control-grid">
        <label><input type="checkbox" checked={settings.heatmapVisible} onChange={(event) => update('heatmapVisible', event.target.checked)} /> {t('overlay.heatmap')}</label>
        <label><input type="checkbox" checked={settings.lobeVisible} onChange={(event) => update('lobeVisible', event.target.checked)} /> {t('overlay.lobe')}</label>
        <label><input type="checkbox" checked={settings.bearingVisible} onChange={(event) => update('bearingVisible', event.target.checked)} /> {t('overlay.bearing')}</label>
        <label><input type="checkbox" checked={settings.ringsVisible} onChange={(event) => update('ringsVisible', event.target.checked)} /> {t('overlay.rings')}</label>
        <label><input type="checkbox" checked={settings.guidesVisible} onChange={(event) => update('guidesVisible', event.target.checked)} /> {t('overlay.guides')}</label>
      </div>
    </fieldset>
    <fieldset className="overlay-group">
      <legend>{t('overlay.groupHeat')}</legend>
      <div className="overlay-control-fields">
        <label>{t('overlay.heatStyle')}<select value={settings.heatStyle} onChange={(event) => update('heatStyle', event.target.value === 'density' ? 'density' : 'beam')}><option value="beam">{t('overlay.styleBeam')}</option><option value="density">{t('overlay.styleDensity')}</option></select></label>
        <label>{t('overlay.gradient')}<select value={settings.heatPalette} onChange={(event) => update('heatPalette', event.target.value as DoaOverlaySettings['heatPalette'])}><option value="kraken">{t('overlay.paletteKraken')}</option><option value="thermal">{t('overlay.paletteThermal')}</option><option value="viridis">{t('overlay.paletteViridis')}</option><option value="monochrome">{t('overlay.paletteMono')}</option></select></label>
        <label>{t('overlay.opacity')}<input type="range" min="0" max="1" step="0.05" value={settings.heatOpacity} onChange={(event) => update('heatOpacity', Number(event.target.value))} /><output>{Math.round(settings.heatOpacity * 100)}%</output></label>
        <label>{t('overlay.intensity')}<input type="range" min="0.25" max="3" step="0.05" value={settings.heatIntensity} onChange={(event) => update('heatIntensity', Number(event.target.value))} /><output>{settings.heatIntensity.toFixed(2)}×</output></label>
        <label>{t('overlay.falloff')}<input type="range" min="0" max="1" step="0.05" value={settings.distanceFalloff} onChange={(event) => update('distanceFalloff', Number(event.target.value))} /><output>{Math.round(settings.distanceFalloff * 100)}%</output></label>
        <label className={density ? undefined : 'is-inactive'}>{t('overlay.blur')}<input type="range" min="4" max="80" step="1" value={settings.heatBlur} disabled={!density} onChange={(event) => update('heatBlur', Number(event.target.value))} /><output>{density ? `${settings.heatBlur}px` : t('overlay.densityOnly')}</output></label>
        <label>{t('overlay.samples')}<input type="number" min="2" max="32" step="1" value={settings.radialSamples} onChange={(event) => update('radialSamples', settingNumber(event.target.value, settings.radialSamples))} /><small>{t('overlay.samplesHelp')}</small></label>
        <label>{t('overlay.threshold')}<input type="number" min="-160" max="20" step="1" value={settings.thresholdDb} onChange={(event) => update('thresholdDb', settingNumber(event.target.value, settings.thresholdDb))} /></label>
      </div>
    </fieldset>
    <fieldset className="overlay-group">
      <legend>{t('overlay.groupScale')}</legend>
      <div className="overlay-control-fields">
        <label>{t('overlay.minDb')}<input type="number" min="-160" max="20" step="1" value={settings.minDb} onChange={(event) => update('minDb', settingNumber(event.target.value, settings.minDb))} /></label>
        <label>{t('overlay.maxDb')}<input type="number" min="-160" max="20" step="1" value={settings.maxDb} onChange={(event) => update('maxDb', settingNumber(event.target.value, settings.maxDb))} /></label>
        <label>{t('overlay.contrast')}<input type="number" min="0.25" max="4" step="0.25" value={settings.contrast} onChange={(event) => update('contrast', Math.max(.25, Math.min(4, settingNumber(event.target.value, settings.contrast))))} /></label>
        <label>{t('overlay.guideInterval')}<select value={settings.guideInterval} onChange={(event) => update('guideInterval', Number(event.target.value) as DoaOverlaySettings['guideInterval'])}><option value="15">15°</option><option value="30">30°</option><option value="45">45°</option><option value="90">90°</option></select></label>
        <label>{t('overlay.projection')}<input type="number" min="100" max="20000" step="100" value={settings.maxDistanceM} onChange={(event) => update('maxDistanceM', Math.max(100, Math.min(20000, settingNumber(event.target.value, settings.maxDistanceM))))} /></label>
        <label>{t('overlay.lobeRadius')}<input type="number" min="100" max="20000" step="100" value={settings.lobeDistanceM} onChange={(event) => update('lobeDistanceM', Math.max(100, Math.min(20000, settingNumber(event.target.value, settings.lobeDistanceM))))} /></label>
      </div>
    </fieldset>
    <div className="overlay-presets"><span>{t('overlay.presets')}</span><button className="text-button" type="button" onClick={() => preset('kraken')}>{t('overlay.presetKraken')}</button><button className="text-button" type="button" onClick={() => preset('focused')}>{t('overlay.presetFocused')}</button><button className="text-button" type="button" onClick={() => preset('wide')}>{t('overlay.presetWide')}</button></div>
    <div className="overlay-control-actions"><button className="text-button" type="button" onClick={onReset}>{t('overlay.reset')}</button><span>{t('overlay.note')}</span></div>
  </div>;
}
