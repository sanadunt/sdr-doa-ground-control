import type { ChangeEvent, FocusEvent, JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ListenMode } from '../../lib/receiverBridgeProtocol';
import { DISPLAY_DB_LIMITS } from '../../lib/receiverBridgeProtocol';
import { LISTEN_MODE_OPTIONS } from '../../lib/listenPrefs';
import { keepDbRange } from '../../lib/spectrumDockSettings';
import type { DbScale } from '../../lib/spectrumDockSettings';
import { formatDb } from '../../lib/spectrumView';
import type { DbRange } from '../../lib/spectrumView';
import { parseTypedNumber } from '../../lib/polarViewSettings';
import { useI18n } from '../../lib/i18n';
import { Icon } from '../ui';
import { useSyncedDraft } from './useSyncedDraft';

function dbText(value: number): string {
  return String(Number(value.toFixed(1)));
}

export interface SpectrumSettingsProps {
  /** Header controls repeated here; CSS shows this copy only while the dock is too narrow for them. */
  followNode: boolean;
  onFollowNode: (next: boolean) => void;
  mode: ListenMode;
  onModeChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  sendable: boolean;
  sendTitle: string;
  onSend: () => void;
  /** The RX dB scale as the dock shows it (the Receiver's, or the last one known). */
  db: DbScale;
  /** The automatic range drawn now, in whole dB; null before the first frame. */
  autoRange: DbRange | null;
  onDbAuto: () => void;
  onDbManual: () => void;
  onDbRange: (range: { minDb: number; maxDb: number }) => void;
}

/**
 * The spectrum dock's "Atur" column, in the pattern of the Polar dock's: on a
 * narrow dock the follow-node switch, the demodulation mode and "Kirim ke
 * RDF-SDR" move here from the header, then the RX dB scale, which the
 * Receiver's Dengar tab shares. Typed limits apply on Enter or when the field
 * is left.
 */
export function SpectrumSettings({
  followNode,
  onFollowNode,
  mode,
  onModeChange,
  sendable,
  sendTitle,
  onSend,
  db,
  autoRange,
  onDbAuto,
  onDbManual,
  onDbRange,
}: SpectrumSettingsProps): JSX.Element {
  const { t } = useI18n();
  const auto = db.auto;
  const [minDraft, setMinDraft] = useSyncedDraft(auto ? null : db.minDb, parseTypedNumber, dbText);
  const [maxDraft, setMaxDraft] = useSyncedDraft(auto ? null : db.maxDb, parseTypedNumber, dbText);
  const typedMin = parseTypedNumber(minDraft);
  const typedMax = parseTypedNumber(maxDraft);
  const rangeError = !auto && (typedMin === null || typedMax === null);
  const { minDb: floor, maxDb: ceiling, minGapDb: gap } = DISPLAY_DB_LIMITS;

  const commit = (changed: 'min' | 'max') => {
    if (auto) return;
    if (typedMin === null || typedMax === null) return;
    const next = keepDbRange(typedMin, typedMax, changed);
    if (next.minDb !== db.minDb || next.maxDb !== db.maxDb) onDbRange(next);
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
      <div className="ov-ps-row">
        <div className="ov-ps-label">
          <span id="ov-spec-db-label">{t('spectrum.dbScale')}</span>
          <span className={rangeError ? 'is-error' : auto ? undefined : 'is-manual'}>{dbTag}</span>
        </div>
        <div className="ov-ps-controls">
          <div className="ov-seg ov-w-106" role="group" aria-labelledby="ov-spec-db-label">
            <button type="button" aria-pressed={auto} onClick={onDbAuto}>{t('polarDock.dbAuto')}</button>
            <button type="button" aria-pressed={!auto} onClick={onDbManual}>{t('polarDock.dbManual')}</button>
          </div>
          <input className={`ov-db-input${rangeError && typedMin === null ? ' is-error' : ''}`} type="text" inputMode="text" autoComplete="off" spellCheck={false}
            aria-label={t('polarDock.dbMin')} disabled={auto} aria-invalid={(rangeError && typedMin === null) || undefined}
            value={auto ? (autoRange ? dbText(autoRange.min) : '') : minDraft}
            onChange={(event) => setMinDraft(event.target.value)} onKeyDown={onKeyDown('min')} onBlur={onBlur('min')} />
          <span aria-hidden="true" className="ov-ps-dash">–</span>
          <input className={`ov-db-input${rangeError && typedMax === null ? ' is-error' : ''}`} type="text" inputMode="text" autoComplete="off" spellCheck={false}
            aria-label={t('polarDock.dbMax')} disabled={auto} aria-invalid={(rangeError && typedMax === null) || undefined}
            value={auto ? (autoRange ? dbText(autoRange.max) : '') : maxDraft}
            onChange={(event) => setMaxDraft(event.target.value)} onKeyDown={onKeyDown('max')} onBlur={onBlur('max')} />
        </div>
      </div>
      {/* The radio rows (sample rate, gains; the scan's range and resolution) follow here. */}
    </div>
  );
}
