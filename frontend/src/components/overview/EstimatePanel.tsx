import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { useI18n } from '../../lib/i18n';
import type { MessageKey } from '../../lib/i18n';
import { estimateLocated, estimatePositionText, estimateSourceKey, estimateWaitKey, formatEstimateDistance, resetPositionEstimate, type PositionEstimate } from '../../lib/positionEstimate';
import { estimateExportUrl, fetchEstimateSessions, type EstimateSessionList } from '../../lib/estimateSessions';
import { COORDINATE_FORMATS, isCoordinateFormat, type CoordinateFormat } from '../../lib/gridCoordinates';
import { formatBearing } from '../../lib/overlayPalette';

const STATE_TAG: Record<PositionEstimate['state'], MessageKey> = {
  NO_DATA: 'estimate.tagNoData',
  NEED_MOVEMENT: 'estimate.tagNeedMovement',
  ROUGH: 'estimate.tagRough',
  ESTIMATE: 'estimate.tagEstimate',
};
const STATE_TEXT: Record<PositionEstimate['state'], MessageKey> = {
  NO_DATA: 'estimate.stateNoData',
  NEED_MOVEMENT: 'estimate.stateNeedMovement',
  ROUGH: 'estimate.stateRough',
  ESTIMATE: 'estimate.stateEstimate',
};

const MHZ = new Intl.NumberFormat(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });

/**
 * The recorded sessions (tools/estimate_record_store.py), newest first: when,
 * the frequency, how many rays from how many places, the last state and
 * radius, and Replay with the Google Earth and CSV downloads. Read once each
 * time it opens; the LAN view reads it too.
 */
function EstimateHistory({ onReplay }: { onReplay?: (id: string) => void }): JSX.Element {
  const { t } = useI18n();
  const [list, setList] = useState<{ status: 'loading' | 'ready' | 'error'; value?: EstimateSessionList; code?: string }>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    fetchEstimateSessions(controller.signal).then(
      (value) => setList({ status: 'ready', value }),
      (error: unknown) => { if (!controller.signal.aborted) setList({ status: 'error', code: error instanceof Error ? error.message : 'ERROR' }); },
    );
    return () => controller.abort();
  }, []);
  if (list.status === 'loading') return <p className="ov-estimate-note" role="status">{t('estimate.historyLoading')}</p>;
  if (list.status === 'error' || !list.value) return <p className="ov-hud-held" role="status">{t('estimate.historyFailed', { code: list.code ?? 'ERROR' })}</p>;
  if (!list.value.available) return <p className="ov-hud-held" role="status">{t('estimate.historyUnavailable')}</p>;
  if (!list.value.sessions.length) return <p className="ov-estimate-note" role="status">{t('estimate.historyEmpty')}</p>;
  return (
    <ul className="ov-estimate-history" aria-label={t('estimate.historyTitle')}>
      {list.value.sessions.slice(0, 30).map((session) => (
        <li key={session.id}>
          <div className="ov-estimate-history-head">
            <b>{new Date(session.startedMs).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</b>
            {session.frequencyHz !== null ? <span>{`${MHZ.format(session.frequencyHz / 1e6)} MHz`}</span> : null}
            {session.id === list.value?.currentId ? <span className="ov-tag tone-good">{t('estimate.historyNow')}</span> : null}
            {session.state ? <span className="ov-tag tone-neutral">{t(STATE_TAG[session.state])}</span> : null}
          </div>
          <div className="ov-hud-offset">
            {t('estimate.historyRow', { rays: String(session.samples), places: String(session.stations ?? 0) })}
            {session.radiusM !== null && (session.state === 'ESTIMATE' || session.state === 'ROUGH') ? ` · ±${formatEstimateDistance(session.radiusM)}` : ''}
          </div>
          <div className="ov-estimate-actions">
            {onReplay ? <button type="button" className="ov-button" onClick={() => onReplay(session.id)}>{t('estimate.replay')}</button> : null}
            <a className="ov-button" href={estimateExportUrl(session.id, 'kml')} download>{t('estimate.kml')}</a>
            <a className="ov-button" href={estimateExportUrl(session.id, 'csv')} download>{t('estimate.csv')}</a>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The transmitter position estimate under the bearing HUD: where the moving
 * RDF-SDR's bearings cross, how far that is from the RDF-SDR and from the
 * groundstation, and what it rests on (the drone's GPS and yaw, or the RDF-SDR's own). While the
 * console skips LIVE bearings it says what they lack: a position (or that the
 * node does not send one) or a heading. "Start over" clears it on this
 * console (nothing goes to the node). Not shown in the LAN view, which only watches.
 * The position is written as Lat/Lon, UTM, MGRS or X,Y from the groundstation,
 * as the operator picks for a land map (the overlay setting coordinateFormat). In the compact touch layout, and on a
 * desktop while Lapisan is open (the column would squeeze it), it is one
 * button of two lines (title, state and distance) that opens the rest.
 */
export function EstimatePanel({ estimate, viewOnly = false, compact = false, coordinateFormat = 'latlon', onCoordinateFormatChange, onReplay, history = true, playback = null }: {
  estimate: PositionEstimate;
  viewOnly?: boolean;
  compact?: boolean;
  coordinateFormat?: CoordinateFormat;
  onCoordinateFormatChange?: (format: CoordinateFormat) => void;
  /** Replay a recorded session on the map; without it the history offers the downloads only. */
  onReplay?: (id: string) => void;
  /** The recorded sessions (not during a simulation). */
  history?: boolean;
  /** The replay or simulated flight's controls, at the top of the card. */
  playback?: ReactNode;
}): JSX.Element {
  const { t } = useI18n();
  const [resetState, setResetState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [expanded, setExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const ready = estimate.state === 'ESTIMATE';
  const located = estimateLocated(estimate);
  const distanceText = located ? t('estimate.distance', {
    distance: formatEstimateDistance(estimate.distanceM),
    bearing: estimate.bearingDeg === null ? '--' : formatBearing(estimate.bearingDeg, 0),
  }) : null;
  const groundText = located && estimate.groundDistanceM !== null ? t('estimate.groundDistance', {
    distance: formatEstimateDistance(estimate.groundDistanceM),
    bearing: estimate.groundBearingDeg === null ? '--' : formatBearing(estimate.groundBearingDeg, 0),
  }) : null;
  const sourceKey = estimateSourceKey(estimate);
  const waitKey = estimateWaitKey(estimate);
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
      {playback}
      {/* Nothing used yet: what the skipped bearings lack replaces the plain waiting text. */}
      {ready || (estimate.state === 'NO_DATA' && waitKey) ? null : <p className="ov-hud-held" role="status">{t(STATE_TEXT[estimate.state])}</p>}
      {waitKey ? (
        <p className="ov-hud-held" role={estimate.state === 'NO_DATA' ? 'status' : undefined}>
          {t(waitKey)}{estimate.skipped > 0 ? ` · ${t('estimate.skipped', { count: String(estimate.skipped) })}` : ''}
        </p>
      ) : null}
      {located && estimate.latitude !== null && estimate.longitude !== null ? (
        <>
          <div className="ov-estimate-distance">{distanceText}</div>
          {groundText ? <div className="ov-estimate-distance">{groundText}</div> : null}
          <div className="ov-hud-offset ov-estimate-position">
            <b>{estimatePositionText(estimate, coordinateFormat, t)}</b>
          </div>
          {onCoordinateFormatChange ? (
            <label className="ov-estimate-format">
              <span>{t('estimate.coordinates')}</span>
              <select
                value={coordinateFormat}
                onChange={(event) => { if (isCoordinateFormat(event.target.value)) onCoordinateFormatChange(event.target.value); }}
              >
                {COORDINATE_FORMATS.map((format) => <option key={format} value={format}>{t(`estimate.coord.${format}`)}</option>)}
              </select>
            </label>
          ) : null}
        </>
      ) : null}
      {estimate.samples > 0 ? (
        <div className="ov-hud-offset">
          {t('estimate.samples', {
            samples: String(estimate.samples),
            stations: String(estimate.stations),
            spread: estimate.spreadDeg === null ? '0' : estimate.spreadDeg.toFixed(0),
          })}
          {estimate.unverifiedSamples > 0 ? ` · ${t('estimate.unverified', { count: String(estimate.unverifiedSamples) })}` : ''}
        </div>
      ) : null}
      {sourceKey && estimate.samples > 0 ? <div className="ov-hud-offset">{t(sourceKey)}</div> : null}
      {!ready ? <p className="ov-estimate-note">{t('estimate.needs', { stations: String(estimate.minStations), spread: estimate.minSpreadDeg.toFixed(0) })}</p> : null}
      {estimate.resetReason === 'FREQUENCY_CHANGED' ? <p className="ov-hud-held">{t('estimate.frequencyChanged')}</p> : null}
      <p className="ov-estimate-note">{t('estimate.note')}</p>
      <div className="ov-estimate-actions">
        {viewOnly ? null : (
          <button type="button" className="ov-button" onClick={onReset} disabled={resetState.busy || estimate.samples === 0}>
            {resetState.busy ? t('estimate.resetting') : t('estimate.reset')}
          </button>
        )}
        {history ? (
          <button type="button" className="ov-button" aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}>
            {historyOpen ? t('estimate.close') : t('estimate.history')}
          </button>
        ) : null}
        {resetState.error ? <span className="ov-hud-held" role="status">{t('estimate.resetFailed', { code: resetState.error })}</span> : null}
      </div>
      {history && historyOpen ? <EstimateHistory onReplay={onReplay ? (id) => { setHistoryOpen(false); onReplay(id); } : undefined} /> : null}
    </section>
  );
}
