import { useState, type JSX } from 'react';
import { useI18n } from '../../lib/i18n';
import type { MessageKey } from '../../lib/i18n';
import { formatEstimateDistance, resetPositionEstimate, type PositionEstimate } from '../../lib/positionEstimate';
import { formatBearing } from '../../lib/overlayPalette';

const STATE_TAG: Record<PositionEstimate['state'], MessageKey> = {
  NO_DATA: 'estimate.tagNoData',
  NEED_MOVEMENT: 'estimate.tagNeedMovement',
  ESTIMATE: 'estimate.tagEstimate',
};
const STATE_TEXT: Record<PositionEstimate['state'], MessageKey> = {
  NO_DATA: 'estimate.stateNoData',
  NEED_MOVEMENT: 'estimate.stateNeedMovement',
  ESTIMATE: 'estimate.stateEstimate',
};

/**
 * The transmitter position estimate under the bearing HUD: where the moving
 * RDF-SDR's bearings cross, how far that is, and what it rests on. "Start
 * over" clears it on this console (nothing goes to the node). Not shown in
 * the LAN view, which only watches. In the compact touch layout, and on a
 * desktop while Lapisan is open (the column would squeeze it), it is one
 * button of two lines (title, state and distance) that opens the rest.
 */
export function EstimatePanel({ estimate, viewOnly = false, compact = false }: { estimate: PositionEstimate; viewOnly?: boolean; compact?: boolean }): JSX.Element {
  const { t } = useI18n();
  const [resetState, setResetState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [expanded, setExpanded] = useState(false);
  const ready = estimate.state === 'ESTIMATE';
  const located = ready && estimate.latitude !== null && estimate.longitude !== null;
  const distanceText = located ? t('estimate.distance', {
    distance: formatEstimateDistance(estimate.distanceM),
    bearing: estimate.bearingDeg === null ? '--' : formatBearing(estimate.bearingDeg, 0),
  }) : null;
  const onReset = () => {
    setResetState({ busy: true, error: null });
    resetPositionEstimate().then(
      () => setResetState({ busy: false, error: null }),
      (error: unknown) => setResetState({ busy: false, error: error instanceof Error ? error.message : 'ERROR' }),
    );
  };
  const className = `ov-card ov-estimate ${ready ? 'is-ready' : 'is-pending'}${compact ? ' is-compact' : ''}`;
  if (compact && !expanded) {
    return (
      <section className={className} aria-label={t('estimate.title')}>
        <button type="button" className="ov-estimate-summary" aria-expanded={false} onClick={() => setExpanded(true)}>
          <span className="ov-hud-head">
            <span className="ov-eyebrow">{t('estimate.title')}</span>
            <span className="ov-tag tone-neutral">{t(STATE_TAG[estimate.state])}</span>
          </span>
          <span className="ov-estimate-distance">{distanceText ?? t(STATE_TEXT[estimate.state])}</span>
        </button>
      </section>
    );
  }
  return (
    <section className={className} aria-label={t('estimate.title')}>
      {compact ? (
        <button type="button" className="ov-estimate-summary" aria-expanded onClick={() => setExpanded(false)}>
          <span className="ov-hud-head">
            <span className="ov-eyebrow">{t('estimate.title')}</span>
            <span className="ov-tag tone-neutral">{t(STATE_TAG[estimate.state])}</span>
          </span>
        </button>
      ) : (
        <div className="ov-hud-head">
          <span className="ov-eyebrow">{t('estimate.title')}</span>
          <span className="ov-tag tone-neutral">{t(STATE_TAG[estimate.state])}</span>
        </div>
      )}
      {ready ? null : <p className="ov-hud-held" role="status">{t(STATE_TEXT[estimate.state])}</p>}
      {located && estimate.latitude !== null && estimate.longitude !== null ? (
        <>
          <div className="ov-estimate-distance">{distanceText}</div>
          <div className="ov-hud-offset">
            <b>{t('estimate.position', {
              lat: estimate.latitude.toFixed(5),
              lon: estimate.longitude.toFixed(5),
              radius: formatEstimateDistance(estimate.radiusM),
            })}</b>
          </div>
        </>
      ) : null}
      {estimate.samples > 0 ? (
        <div className="ov-hud-offset">
          {t('estimate.samples', {
            samples: String(estimate.samples),
            stations: String(estimate.stations),
            spread: estimate.spreadDeg === null ? '0' : estimate.spreadDeg.toFixed(0),
          })}
        </div>
      ) : null}
      {!ready ? <p className="ov-estimate-note">{t('estimate.needs', { stations: String(estimate.minStations), spread: estimate.minSpreadDeg.toFixed(0) })}</p> : null}
      {estimate.resetReason === 'FREQUENCY_CHANGED' ? <p className="ov-hud-held">{t('estimate.frequencyChanged')}</p> : null}
      <p className="ov-estimate-note">{t('estimate.note')}</p>
      {viewOnly ? null : (
        <div className="ov-estimate-actions">
          <button type="button" className="ov-button" onClick={onReset} disabled={resetState.busy || estimate.samples === 0}>
            {resetState.busy ? t('estimate.resetting') : t('estimate.reset')}
          </button>
          {resetState.error ? <span className="ov-hud-held" role="status">{t('estimate.resetFailed', { code: resetState.error })}</span> : null}
        </div>
      )}
    </section>
  );
}
