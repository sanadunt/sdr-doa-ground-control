import type { ChangeEvent, FocusEvent, JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { GainKind, ListenMode, SweepFftSize } from '../../lib/receiverBridgeProtocol';
import { DISPLAY_DB_LIMITS, SWEEP_FFT_SIZES, SWEEP_SPAN_LIMITS, gainSteps, inSweepRange } from '../../lib/receiverBridgeProtocol';
import { formatMsps } from '../../lib/radioSettings';
import type { RadioRows } from '../../lib/radioSettings';
import { sweepRangeLimits } from '../../lib/sweepSettings';
import type { SweepRange, SweepRows } from '../../lib/sweepSettings';
import { LISTEN_MODE_OPTIONS } from '../../lib/listenPrefs';
import { keepDbRange } from '../../lib/spectrumDockSettings';
import type { DbScale, DockMode } from '../../lib/spectrumDockSettings';
import { formatDb, formatMhzTrim } from '../../lib/spectrumView';
import type { DbRange } from '../../lib/spectrumView';
import { parseTypedNumber } from '../../lib/polarViewSettings';
import { useI18n } from '../../lib/i18n';
import { Icon } from '../ui';
import { useSyncedDraft } from './useSyncedDraft';

function dbText(value: number): string {
  return String(Number(value.toFixed(1)));
}

/** A frequency field in MHz, up to 1 kHz. */
function mhzText(hz: number): string {
  return String(Number((hz / 1e6).toFixed(3)));
}

/** Typed MHz as whole Hz on the 1 kHz grid, or null. */
function parseMhz(text: string): number | null {
  const value = parseTypedNumber(text);
  return value === null ? null : Math.round(value * 1e3) * 1e3;
}

function resolutionKhz(fftSize: SweepFftSize): string {
  return (SWEEP_SPAN_LIMITS.sampleRateHz / fftSize / 1e3).toFixed(2);
}

export type { RadioRows, SweepRows };

const LNA_STEPS = gainSteps('lna');
const VGA_STEPS = gainSteps('vga');
// 4.88 kHz first, as the Receiver lists them.
const FFT_OPTIONS: readonly SweepFftSize[] = [...SWEEP_FFT_SIZES];

export interface SpectrumSettingsProps {
  /** RX shows the dB scale, sample rate and gains; Spektrum the scan's dB scale, range, resolution and gains. */
  dockMode: DockMode;
  /** Header controls repeated here; CSS shows this copy only while the dock is too narrow for them. */
  followNode: boolean;
  onFollowNode: (next: boolean) => void;
  mode: ListenMode;
  onModeChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  sendable: boolean;
  sendTitle: string;
  onSend: () => void;
  /** The dB scale of the mode shown: RX (shared with the Dengar tab) or the scan's (the Receiver's Graph min./max. when Manual). */
  db: DbScale;
  /** Manual limits can be typed: the scan's need the Receiver frame. */
  dbEditable: boolean;
  /** The automatic range drawn now, in whole dB; null before the first frame. */
  autoRange: DbRange | null;
  onDbAuto: () => void;
  onDbManual: () => void;
  onDbRange: (range: { minDb: number; maxDb: number }) => void;
  radio: RadioRows;
  onSampleRate: (hz: number) => void;
  onGain: (kind: GainKind, db: number) => void;
  onAmp: (enabled: boolean) => void;
  sweep: SweepRows;
  onSweepRange: (range: SweepRange) => void;
  /** "Pusatkan ke RX"; null when there is no RX centre to centre on. */
  onSweepCenter: (() => void) | null;
  onSweepFft: (fftSize: SweepFftSize) => void;
  onSweepGain: (kind: GainKind, db: number) => void;
  onSweepAmp: (enabled: boolean) => void;
}

interface DbScaleRowProps {
  db: DbScale;
  editable: boolean;
  autoRange: DbRange | null;
  onAuto: () => void;
  onManual: () => void;
  onRange: (range: { minDb: number; maxDb: number }) => void;
}

/** The dB scale: Auto|Manual and the manual limits, applied on Enter or when a field is left. */
function DbScaleRow({ db, editable, autoRange, onAuto, onManual, onRange }: DbScaleRowProps): JSX.Element {
  const { t } = useI18n();
  const auto = db.auto;
  const [minDraft, setMinDraft] = useSyncedDraft(auto ? null : db.minDb, parseTypedNumber, dbText);
  const [maxDraft, setMaxDraft] = useSyncedDraft(auto ? null : db.maxDb, parseTypedNumber, dbText);
  const typedMin = parseTypedNumber(minDraft);
  const typedMax = parseTypedNumber(maxDraft);
  const rangeError = !auto && (typedMin === null || typedMax === null);
  const { minDb: floor, maxDb: ceiling, minGapDb: gap } = DISPLAY_DB_LIMITS;
  const fieldsDisabled = auto || !editable;

  const commit = (changed: 'min' | 'max') => {
    if (fieldsDisabled || typedMin === null || typedMax === null) return;
    const next = keepDbRange(typedMin, typedMax, changed);
    if (next.minDb !== db.minDb || next.maxDb !== db.maxDb) onRange(next);
    // A clamped value equal to the stored one still replaces what was typed.
    setMinDraft(dbText(next.minDb));
    setMaxDraft(dbText(next.maxDb));
  };
  const revert = () => {
    setMinDraft(dbText(db.minDb));
    setMaxDraft(dbText(db.maxDb));
  };
  const onKeyDown = (changed: 'min' | 'max') => (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit(changed);
    else if (event.key === 'Escape') revert();
  };
  const onBlur = (changed: 'min' | 'max') => (_event: FocusEvent<HTMLInputElement>) => {
    if (rangeError) revert();
    else commit(changed);
  };
  const dbTag = rangeError
    ? t('spectrum.dbRangeError', { min: formatDb(floor, 0), max: formatDb(ceiling, 0), gap: String(gap) })
    : auto
      ? t('spectrum.dbAutoRange', { low: formatDb(autoRange?.min, 0), high: formatDb(autoRange?.max, 0) })
      : t('spectrum.dbManualRange', { low: formatDb(db.minDb, 1), high: formatDb(db.maxDb, 1) });

  return (
    <div className="ov-ps-row">
      <div className="ov-ps-label">
        <span id="ov-spec-db-label">{t('spectrum.dbScale')}</span>
        <span className={rangeError ? 'is-error' : auto ? undefined : 'is-manual'}>{dbTag}</span>
      </div>
      <div className="ov-ps-controls">
        <div className="ov-seg ov-w-106" role="group" aria-labelledby="ov-spec-db-label">
          <button type="button" aria-pressed={auto} onClick={onAuto}>{t('polarDock.dbAuto')}</button>
          <button type="button" aria-pressed={!auto} onClick={onManual}>{t('polarDock.dbManual')}</button>
        </div>
        <input className={`ov-db-input${rangeError && typedMin === null ? ' is-error' : ''}`} type="text" inputMode="text" autoComplete="off" spellCheck={false}
          aria-label={t('polarDock.dbMin')} disabled={fieldsDisabled} aria-invalid={(rangeError && typedMin === null) || undefined}
          value={auto ? (autoRange ? dbText(autoRange.min) : '') : minDraft}
          onChange={(event) => setMinDraft(event.target.value)} onKeyDown={onKeyDown('min')} onBlur={onBlur('min')} />
        <span aria-hidden="true" className="ov-ps-dash">–</span>
        <input className={`ov-db-input${rangeError && typedMax === null ? ' is-error' : ''}`} type="text" inputMode="text" autoComplete="off" spellCheck={false}
          aria-label={t('polarDock.dbMax')} disabled={fieldsDisabled} aria-invalid={(rangeError && typedMax === null) || undefined}
          value={auto ? (autoRange ? dbText(autoRange.max) : '') : maxDraft}
          onChange={(event) => setMaxDraft(event.target.value)} onKeyDown={onKeyDown('max')} onBlur={onBlur('max')} />
      </div>
    </div>
  );
}

interface GainSelectProps {
  kind: GainKind;
  value: number | null;
  /** The control shows a value; otherwise '—'. */
  known: boolean;
  disabled: boolean;
  onChange: (kind: GainKind, db: number) => void;
}

/** An LNA or VGA select: every step of the RadioSpectrum control, '—' while the value is unknown. */
function GainSelect({ kind, value, known, disabled, onChange }: GainSelectProps): JSX.Element {
  const { t } = useI18n();
  const text = known && value !== null ? String(value) : '';
  const steps = kind === 'lna' ? LNA_STEPS : VGA_STEPS;
  const option = kind === 'lna' ? 'spectrum.lnaOption' : 'spectrum.vgaOption';
  return (
    <select className="ov-radio-select" aria-label={t(kind === 'lna' ? 'spectrum.lnaAria' : 'spectrum.vgaAria')} disabled={disabled}
      value={text} onChange={(event) => { if (event.target.value !== '') onChange(kind, Number(event.target.value)); }}>
      {text === '' || !steps.includes(Number(text)) ? <option value={text}>{text === '' ? '—' : t(option, { db: text })}</option> : null}
      {known ? steps.map((step) => <option key={step} value={String(step)}>{t(option, { db: String(step) })}</option>) : null}
    </select>
  );
}

interface SweepRangeRowProps {
  sweep: SweepRows;
  onRange: (range: SweepRange) => void;
  onCenter: (() => void) | null;
}

/** The scan range in MHz (displayed, Freq Shift included), checked like the Receiver checks it, applied on Enter or when a field is left. */
function SweepRangeRow({ sweep, onRange, onCenter }: SweepRangeRowProps): JSX.Element {
  const { t } = useI18n();
  const [startDraft, setStartDraft] = useSyncedDraft(sweep.startHz, parseMhz, mhzText);
  const [stopDraft, setStopDraft] = useSyncedDraft(sweep.stopHz, parseMhz, mhzText);
  const fftSize = sweep.fftSize ?? 8192;
  const typedStart = parseMhz(startDraft);
  const typedStop = parseMhz(stopDraft);
  const valid = typedStart !== null && typedStop !== null && inSweepRange(typedStart, typedStop, fftSize, sweep.shiftHz);
  const rangeError = !sweep.disabled && !valid && (startDraft !== '' || stopDraft !== '');
  const limits = sweepRangeLimits(sweep.shiftHz, fftSize);

  const revert = () => {
    if (sweep.startHz !== null) setStartDraft(mhzText(sweep.startHz));
    if (sweep.stopHz !== null) setStopDraft(mhzText(sweep.stopHz));
  };
  const commit = () => {
    if (sweep.disabled || typedStart === null || typedStop === null || !valid) return;
    if (typedStart !== sweep.startHz || typedStop !== sweep.stopHz) onRange({ startHz: typedStart, stopHz: typedStop });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit();
    else if (event.key === 'Escape') revert();
  };
  // Leaving a field applies a valid range; an invalid one stays visible until both fields are left, then reverts.
  const onBlur = (event: FocusEvent<HTMLInputElement>) => {
    const next = event.relatedTarget;
    if (next instanceof HTMLInputElement && next.dataset.sweepRange === 'true') return;
    if (valid) commit();
    else revert();
  };
  const tag = rangeError
    ? t('spectrum.rangeError', { min: formatMhzTrim(limits.minHz, 0), max: formatMhzTrim(limits.maxHz, 0), span: formatMhzTrim(limits.maxSpanHz, 0) })
    : sweep.scanning ? t('spectrum.sweepLocked') : '';
  return (
    <div className="ov-ps-row">
      <div className="ov-ps-label">
        <span id="ov-spec-range-label">{t('spectrum.range')}</span>
        {tag ? <span className={rangeError ? 'is-error' : 'is-warn'}>{tag}</span> : null}
      </div>
      <div className="ov-ps-controls" role="group" aria-labelledby="ov-spec-range-label">
        <input className={`ov-db-input ov-mhz-input${rangeError ? ' is-error' : ''}`} type="text" inputMode="decimal" autoComplete="off" spellCheck={false}
          data-sweep-range="true" aria-label={t('spectrum.rangeStart')} disabled={sweep.disabled} aria-invalid={rangeError || undefined}
          value={startDraft} onChange={(event) => setStartDraft(event.target.value)} onKeyDown={onKeyDown} onBlur={onBlur} />
        <span aria-hidden="true" className="ov-ps-dash">–</span>
        <input className={`ov-db-input ov-mhz-input${rangeError ? ' is-error' : ''}`} type="text" inputMode="decimal" autoComplete="off" spellCheck={false}
          data-sweep-range="true" aria-label={t('spectrum.rangeStop')} disabled={sweep.disabled} aria-invalid={rangeError || undefined}
          value={stopDraft} onChange={(event) => setStopDraft(event.target.value)} onKeyDown={onKeyDown} onBlur={onBlur} />
        <button className="ov-icon-button is-bordered" type="button" aria-label={t('spectrum.rangeCenter')} title={t('spectrum.rangeCenter')}
          disabled={sweep.disabled || onCenter === null} onClick={() => onCenter?.()}>
          <Icon name="crosshair" />
        </button>
      </div>
    </div>
  );
}

/**
 * The spectrum dock's "Atur" column, in the pattern of the Polar dock's: on a
 * narrow dock the follow-node switch, the demodulation mode and "Kirim ke
 * RDF-SDR" move here from the header. In RX mode it holds the RX dB scale,
 * which the Receiver's Dengar tab shares, then the Listener's sample rate,
 * LNA, VGA and +14 dB amp. In Spektrum mode it holds the scan's dB scale
 * (Manual is the Receiver's Graph min./max.), then the scan's range,
 * resolution and gains, which are read-only while a scan runs, as on the
 * Receiver page. Typed values apply on Enter or when the field is left.
 */
export function SpectrumSettings({
  dockMode,
  followNode,
  onFollowNode,
  mode,
  onModeChange,
  sendable,
  sendTitle,
  onSend,
  db,
  dbEditable,
  autoRange,
  onDbAuto,
  onDbManual,
  onDbRange,
  radio,
  onSampleRate,
  onGain,
  onAmp,
  sweep,
  onSweepRange,
  onSweepCenter,
  onSweepFft,
  onSweepGain,
  onSweepAmp,
}: SpectrumSettingsProps): JSX.Element {
  const { t } = useI18n();
  const rateValue = radio.ready && radio.sampleRateHz !== null ? String(radio.sampleRateHz) : '';
  const span = sweep.startHz !== null && sweep.stopHz !== null ? sweep.stopHz - sweep.startHz : null;
  const sweepKnown = sweep.ready || sweep.startHz !== null;
  const lockedTag = sweep.scanning ? <span className="is-warn">{t('spectrum.sweepLocked')}</span> : null;

  return (
    <div id="spectrum-settings" className="ov-spec-settings" role="group" aria-label={t('spectrum.settingsRegion')}>
      <div className="ov-ps-row ov-spec-narrow">
        <div className="ov-ps-controls">
          <label className="ov-spec-follow">
            <input type="checkbox" checked={followNode} onChange={(event) => onFollowNode(event.target.checked)} />
            <span>{t('spectrum.follow')}</span>
          </label>
          <select className="ov-listen-mode" aria-label={t('spectrum.mode')} title={t('spectrum.mode')} value={mode} onChange={onModeChange}>
            {LISTEN_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      </div>
      <div className="ov-ps-row ov-spec-narrow">
        <div className="ov-ps-controls">
          <button className="ov-button ov-spec-send is-wide" type="button" disabled={!sendable} title={sendTitle} onClick={onSend}>
            <Icon name="send" /><span>{t('spectrum.send')}</span>
          </button>
        </div>
      </div>
      {/* Keyed by mode: the two dB scales keep separate typed drafts. */}
      <DbScaleRow key={dockMode} db={db} editable={dbEditable} autoRange={autoRange} onAuto={onDbAuto} onManual={onDbManual} onRange={onDbRange} />
      {dockMode === 'rx' ? (
        <>
          <div className="ov-ps-row">
            <div className="ov-ps-label">
              <span id="ov-spec-rate-label">{t('spectrum.sampleRate')}</span>
              {radio.ratePending ? <span>…</span> : null}
            </div>
            <div className="ov-ps-controls">
              <select className="ov-radio-select" aria-labelledby="ov-spec-rate-label" disabled={!radio.ready || radio.rateDisabled}
                aria-disabled={radio.ratePending ? true : undefined}
                value={rateValue} onChange={(event) => { if (!radio.ratePending && event.target.value !== '') onSampleRate(Number(event.target.value)); }}>
                {rateValue === '' ? <option value="">—</option> : null}
                {radio.ready ? radio.sampleRates.map((rate) => <option key={rate} value={String(rate)}>{t('spectrum.rateOption', { rate: formatMsps(rate) })}</option>) : null}
              </select>
            </div>
          </div>
          <div className="ov-ps-row">
            <div className="ov-ps-label">
              <span id="ov-spec-gain-label">{t('spectrum.gain')}</span>
            </div>
            <div className="ov-ps-controls" role="group" aria-labelledby="ov-spec-gain-label">
              <GainSelect kind="lna" value={radio.lnaDb} known={radio.ready} disabled={!radio.ready || radio.gainsDisabled} onChange={onGain} />
              <GainSelect kind="vga" value={radio.vgaDb} known={radio.ready} disabled={!radio.ready || radio.gainsDisabled} onChange={onGain} />
              <button className="ov-button ov-spec-amp" type="button" aria-pressed={radio.ready && radio.amp === true} aria-label={t('spectrum.ampAria')}
                disabled={!radio.ready || radio.gainsDisabled || radio.amp === null} onClick={() => onAmp(radio.amp !== true)}>
                {t('spectrum.amp')}
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          <SweepRangeRow sweep={sweep} onRange={onSweepRange} onCenter={onSweepCenter} />
          <div className="ov-ps-row">
            <div className="ov-ps-label">
              <span id="ov-spec-res-label">{t('spectrum.resolution')}</span>
              {lockedTag}
            </div>
            <div className="ov-ps-controls">
              <div className="ov-seg ov-spec-res" role="group" aria-labelledby="ov-spec-res-label">
                {FFT_OPTIONS.map((fftSize) => (
                  <button key={fftSize} type="button" aria-pressed={sweep.fftSize === fftSize}
                    // A resolution the current range does not fit in is not offered.
                    disabled={sweep.disabled || (span !== null && sweep.startHz !== null && sweep.stopHz !== null && !inSweepRange(sweep.startHz, sweep.stopHz, fftSize, sweep.shiftHz))}
                    onClick={() => { if (sweep.fftSize !== fftSize) onSweepFft(fftSize); }}>
                    {t('spectrum.resolutionOption', { khz: resolutionKhz(fftSize) })}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="ov-ps-row">
            <div className="ov-ps-label">
              <span id="ov-spec-sgain-label">{t('spectrum.gain')}</span>
              {lockedTag}
            </div>
            <div className="ov-ps-controls" role="group" aria-labelledby="ov-spec-sgain-label">
              <GainSelect kind="lna" value={sweep.lnaDb} known={sweepKnown} disabled={sweep.disabled} onChange={onSweepGain} />
              <GainSelect kind="vga" value={sweep.vgaDb} known={sweepKnown} disabled={sweep.disabled} onChange={onSweepGain} />
              <button className="ov-button ov-spec-amp" type="button" aria-pressed={sweep.amp === true} aria-label={t('spectrum.ampAria')}
                disabled={sweep.disabled || sweep.amp === null} onClick={() => onSweepAmp(sweep.amp !== true)}>
                {t('spectrum.amp')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
