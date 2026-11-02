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
 * the LAN view, which only watches.
 */
export function EstimatePanel({ estimate, viewOnly = false }: { estimate: PositionEstimate; viewOnly?: boolean }): JSX.Element {
  const { t } = useI18n();
  const [resetState, setResetState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const ready = estimate.state === 'ESTIMATE';
  const onReset = () => {
    setResetState({ busy: true, error: null });
    resetPositionEstimate().then(
      () => setResetState({ busy: false, error: null }),
      (error: unknown) => setResetState({ busy: false, error: error instanceof Error ? error.message : 'ERROR' }),
    );
  };
  return (
    <section className={`ov-card ov-estimate ${ready ? 'is-ready' : 'is-pending'}`} aria-label={t('estimate.title')}>
      <div className="ov-hud-head">
        <span className="ov-eyebrow">{t('estimate.title')}</span>
        <span className="ov-tag tone-neutral">{t(STATE_TAG[estimate.state])}</span>
      </div>
      {ready ? null : <p className="ov-hud-held" role="status">{t(STATE_TEXT[estimate.state])}</p>}
      {ready && estimate.latitude !== null && estimate.longitude !== null ? (
        <>
          <div className="ov-estimate-distance">
            {t('estimate.distance', {
              distance: formatEstimateDistance(estimate.distanceM),
              bearing: estimate.bearingDeg === null ? '--' : formatBearing(estimate.bearingDeg, 0),
            })}
          </div>
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
