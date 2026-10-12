import { useEffect, useId, useState } from 'react';
import type { JSX } from 'react';
import { DEFAULT_DOA_OVERLAY_SETTINGS, type DbScale, type DoaOverlaySettings } from '../lib/doaGeometry';
import { OVERLAY_NUMBER_LIMITS, applyOverlayNumber, type OverlayFieldError, type OverlayNumberKey } from '../lib/mapOverlaySettings';
import { useI18n } from '../lib/i18n';
import type { Translate } from '../lib/i18n';

const PRESETS: Record<'focused' | 'wide', Partial<DoaOverlaySettings>> = {
  focused: { maxDistanceM: 700, lobeDistanceM: 700, thresholdDb: -35, radialSamples: 10, distanceFalloff: .65, heatIntensity: 1.3, heatBlur: 22 },
  wide: { maxDistanceM: 2500, lobeDistanceM: 1800, thresholdDb: -60, radialSamples: 18, distanceFalloff: .2, heatIntensity: .9, heatBlur: 42 },
};

function fieldErrorText(t: Translate, error: OverlayFieldError): string {
  switch (error.code) {
    case 'range': return t('overlay.errorRange', { min: error.min, max: error.max });
    case 'belowMax': return t('overlay.errorBelowMax', { max: error.max });
    case 'aboveMin': return t('overlay.errorAboveMin', { min: error.min });
    default: return t('overlay.errorNumber');
  }
}

/**
 * Typed number field. The draft is free text while typing and is applied on
 * blur or Enter; Escape restores the current value. Invalid input stays in the
 * field with an inline error and never reaches the map or storage.
 */
function NumberField({ label, field, settings, disabled, hint, onCommit }: { label: string; field: OverlayNumberKey; settings: DoaOverlaySettings; disabled?: boolean; hint?: string; onCommit: (next: DoaOverlaySettings) => void }): JSX.Element {
  const { t } = useI18n();
  const value = settings[field];
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<OverlayFieldError | null>(null);
  const messageId = useId();
  useEffect(() => {
    setDraft(String(value));
    setError(null);
  }, [value]);
  const commit = () => {
    if (draft.trim() === String(value)) { setError(null); return; }
    const result = applyOverlayNumber(settings, field, draft);
    if (!result.ok) { setError(result.error); return; }
    setError(null);
    setDraft(String(result.settings[field]));
    onCommit(result.settings);
  };
  // Negative dB values need a keyboard with a minus sign; decimal keypads on phones have none.
  const inputMode = OVERLAY_NUMBER_LIMITS[field].min >= 0 ? 'decimal' : undefined;
  const message = error ? fieldErrorText(t, error) : hint;
  return <label className={disabled ? 'is-inactive' : undefined}>{label}
    <input
      type="text"
      inputMode={inputMode}
      autoComplete="off"
      spellCheck={false}
      value={draft}
      disabled={disabled}
      aria-invalid={error ? true : undefined}
      aria-describedby={message ? messageId : undefined}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        if (event.key === 'Escape' && (draft !== String(value) || error)) { event.stopPropagation(); setDraft(String(value)); setError(null); }
      }}
    />
    {message ? <small id={messageId} className={error ? 'overlay-field-error' : undefined} role={error ? 'alert' : undefined}>{message}</small> : null}
  </label>;
}

export function OverlayControls({ settings, scale, onChange, onReset, onClose }: { settings: DoaOverlaySettings; scale: DbScale; onChange: (next: DoaOverlaySettings) => void; onReset: () => void; onClose: () => void }): JSX.Element {
  const { t } = useI18n();
  const update = (key: keyof DoaOverlaySettings, value: boolean | number | string) => onChange({ ...settings, [key]: value });
  const preset = (name: 'kraken' | 'focused' | 'wide') => onChange({ ...settings, ...(name === 'kraken' ? DEFAULT_DOA_OVERLAY_SETTINGS : PRESETS[name]) });
  const density = settings.heatStyle === 'density';
  const auto = settings.dbScale === 'auto';
  const autoHint = auto ? t('overlay.autoActive') : undefined;
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
        <NumberField label={t('overlay.samples')} field="radialSamples" settings={settings} hint={t('overlay.samplesHelp')} onCommit={onChange} />
        <NumberField label={t('overlay.threshold')} field="thresholdDb" settings={settings} disabled={auto} hint={autoHint} onCommit={onChange} />
      </div>
    </fieldset>
    <fieldset className="overlay-group">
      <legend>{t('overlay.groupScale')}</legend>
      <div className="overlay-control-fields">
        <label>{t('overlay.dbScale')}<select value={settings.dbScale} onChange={(event) => update('dbScale', event.target.value === 'manual' ? 'manual' : 'auto')}><option value="auto">{t('overlay.dbScaleAuto')}</option><option value="manual">{t('overlay.dbScaleManual')}</option></select>{auto && scale.known ? <small>{`${Number(scale.minDb.toFixed(1))} … ${Number(scale.maxDb.toFixed(1))} dB`}</small> : null}</label>
        <NumberField label={t('overlay.contrast')} field="contrast" settings={settings} onCommit={onChange} />
        <NumberField label={t('overlay.minDb')} field="minDb" settings={settings} disabled={auto} hint={autoHint} onCommit={onChange} />
        <NumberField label={t('overlay.maxDb')} field="maxDb" settings={settings} disabled={auto} hint={autoHint} onCommit={onChange} />
        <label>{t('overlay.guideInterval')}<select value={settings.guideInterval} onChange={(event) => update('guideInterval', Number(event.target.value) as DoaOverlaySettings['guideInterval'])}><option value="15">15°</option><option value="30">30°</option><option value="45">45°</option><option value="90">90°</option></select></label>
        <NumberField label={t('overlay.projection')} field="maxDistanceM" settings={settings} onCommit={onChange} />
        <NumberField label={t('overlay.lobeRadius')} field="lobeDistanceM" settings={settings} onCommit={onChange} />
      </div>
    </fieldset>
    <div className="overlay-presets"><span>{t('overlay.presets')}</span><button className="text-button" type="button" onClick={() => preset('kraken')}>{t('overlay.presetKraken')}</button><button className="text-button" type="button" onClick={() => preset('focused')}>{t('overlay.presetFocused')}</button><button className="text-button" type="button" onClick={() => preset('wide')}>{t('overlay.presetWide')}</button></div>
    <div className="overlay-control-actions"><button className="text-button" type="button" onClick={onReset}>{t('overlay.reset')}</button><span>{t('overlay.note')}</span></div>
  </div>;
}
