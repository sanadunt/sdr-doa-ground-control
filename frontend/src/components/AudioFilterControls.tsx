import type { JSX } from 'react';
import { useId } from 'react';
import { FILTER_LIMITS, FILTER_PRESET_NAMES, presetSettings, withControls } from '../lib/radioAudioFilter';
import type { DenoiseKind, FilterControls, FilterError, FilterSettings, FilterState } from '../lib/radioAudioFilter';
import { useI18n } from '../lib/i18n';
import type { MessageKey } from '../lib/i18n';

const PRESET_KEYS: Record<typeof FILTER_PRESET_NAMES[number], MessageKey> = {
  off: 'filter.preset.off',
  light: 'filter.preset.light',
  standard: 'filter.preset.standard',
  strong: 'filter.preset.strong',
};

const STATE_KEYS: Record<FilterState, MessageKey> = {
  off: 'filter.state.off',
  loading: 'filter.state.loading',
  ai: 'filter.state.ai',
  error: 'filter.state.error',
  on: 'filter.state.on',
};

const ERROR_KEYS: Record<FilterError['code'], MessageKey> = {
  SAMPLE_RATE: 'filter.error.SAMPLE_RATE',
  DENOISE_LOAD: 'filter.error.DENOISE_LOAD',
  GATE_LOAD: 'filter.error.GATE_LOAD',
  WORKLET_UNSUPPORTED: 'filter.error.WORKLET_UNSUPPORTED',
};

export interface AudioFilterControlsProps {
  /** null until the owner of the filter answers (the Receiver frame); the rows then show nothing to pick. */
  settings: FilterSettings | null;
  state: FilterState | null;
  error: FilterError | null;
  /** Every change is whole settings: a preset, or one control (the preset becomes custom). */
  onChange: (settings: FilterSettings) => void;
  disabled?: boolean;
  /** A line under the rows, such as why the browser holds the audio. */
  hint?: string | null;
}

/**
 * The voice filter's controls (radioAudioFilter.ts), in the rows of the spectrum dock's Atur column:
 * presets Off, Light, Standard and Strong, then the custom controls (voice band, noise suppressor,
 * clarity, AGC with its boost, noise gate). The state shows by the title. Used by the groundstation
 * dock for the Receiver frame's filter and by the LAN view for the tablet's own.
 */
export function AudioFilterControls({ settings, state, error, onChange, disabled = false, hint = null }: AudioFilterControlsProps): JSX.Element {
  const { t } = useI18n();
  const id = useId();
  const off = disabled || settings === null;
  const change = (patch: Partial<FilterControls>) => {
    if (settings) onChange(withControls(settings, patch));
  };
  const stateText = state === 'error' && error?.code === 'GATE_LOAD' ? t('filter.state.loadError') : state ? t(STATE_KEYS[state]) : '';
  const toggle = (key: 'bandpass' | 'clarity' | 'agc' | 'gate', label: string) => (
    <button className="ov-button ov-filter-toggle" type="button" aria-pressed={settings?.[key] === true} disabled={off}
      onClick={() => { if (settings) change({ [key]: !settings[key] }); }}>
      {label}
    </button>
  );
  return (
    <div className="ov-filter" role="group" aria-labelledby={`${id}-title`}>
      <div className="ov-ps-row">
        <div className="ov-ps-label">
          <span id={`${id}-title`}>{t('filter.title')}</span>
          {stateText ? <span className={`ov-filter-state is-${state}`} role="status">{stateText}</span> : null}
          {settings?.preset === 'custom' ? <span>{t('filter.preset.custom')}</span> : null}
        </div>
        <div className="ov-ps-controls">
          <div className="ov-seg ov-filter-presets" role="group" aria-labelledby={`${id}-title`}>
            {FILTER_PRESET_NAMES.map((name) => (
              <button key={name} type="button" aria-pressed={settings?.preset === name} disabled={off}
                onClick={() => { if (settings?.preset !== name) onChange(presetSettings(name)); }}>
                {t(PRESET_KEYS[name])}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="ov-ps-row">
        <div className="ov-ps-label">
          <span id={`${id}-parts`}>{t('filter.parts')}</span>
          {settings?.bandpass ? <span>{t('filter.band', { low: String(settings.lowHz), high: String(settings.highHz) })}</span> : null}
        </div>
        <div className="ov-ps-controls ov-filter-toggles" role="group" aria-labelledby={`${id}-parts`}>
          {toggle('bandpass', t('filter.bandpass'))}
          {toggle('clarity', t('filter.clarity'))}
          {toggle('gate', t('filter.gate'))}
        </div>
      </div>
      <div className="ov-ps-row">
        <div className="ov-ps-label">
          <label htmlFor={`${id}-denoise`}>{t('filter.denoise')}</label>
        </div>
        <div className="ov-ps-controls">
          <select id={`${id}-denoise`} className="ov-radio-select" disabled={off} value={settings?.denoise ?? ''}
            onChange={(event) => change({ denoise: event.target.value as DenoiseKind })}>
            {settings === null ? <option value="">—</option> : null}
            <option value="gtcrn">GTCRN</option>
            <option value="speex">Speex</option>
            <option value="off">{t('filter.denoiseOff')}</option>
          </select>
        </div>
      </div>
      <div className="ov-ps-row">
        <div className="ov-ps-label">
          <span id={`${id}-agc`}>{t('filter.agc')}</span>
          {settings ? <span>{t('filter.boostValue', { db: String(settings.agc ? settings.boostDb : 0) })}</span> : null}
        </div>
        <div className="ov-ps-controls" role="group" aria-labelledby={`${id}-agc`}>
          {toggle('agc', 'AGC')}
          <input className="ov-filter-boost" type="range" aria-label={t('filter.boost')}
            min={FILTER_LIMITS.boostDb.min} max={FILTER_LIMITS.boostDb.max} step={FILTER_LIMITS.boostDb.step}
            disabled={off || !settings?.agc} value={settings?.boostDb ?? 0}
            onChange={(event) => change({ boostDb: Number(event.target.value) })} />
        </div>
      </div>
      {error ? <p className="ov-filter-note is-error" role="alert">{t(ERROR_KEYS[error.code], { detail: error.detail })}</p> : null}
      {hint ? <p className="ov-filter-note">{hint}</p> : null}
    </div>
  );
}
