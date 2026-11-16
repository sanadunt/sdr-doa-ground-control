import type { JSX } from 'react';
import { useI18n } from '../../lib/i18n';
import { PLAYBACK_SPEEDS, formatPlaybackTime, type Playback, type PlaybackSpeed } from '../../lib/estimatePlayback';
import { formatEstimateDistance } from '../../lib/positionEstimate';
import { Icon } from '../ui';

/**
 * The controls at the top of the estimate card while a recorded estimate
 * session or a simulated flight plays: its tag (REPLAY or SIMULATION), play and
 * pause, from the start, the position slider, the speed, how many rays so far,
 * and in a simulation the true distance and how far the estimate misses. A
 * replay closes from here.
 */
export function EstimatePlaybackBar({ playback, loading = false, error = null, onClose }: {
  playback: Playback;
  loading?: boolean;
  error?: string | null;
  onClose?: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const simulation = playback.kind === 'simulation';
  const tag = t(simulation ? 'playback.simTag' : 'playback.replayTag');
  const truth = playback.truth;
  return (
    <section className="ov-playback" aria-label={tag} data-no-page-shortcuts>
      <span className="ov-tag tone-warn">{tag}</span>
      {loading || error ? (
        <span className="ov-playback-status" role="status">{error ? t('playback.failed', { code: error }) : t('playback.loading')}</span>
      ) : (
        <>
          <button
            type="button"
            className="ov-button"
            onClick={playback.playing ? playback.pause : playback.play}
            aria-label={t(playback.playing ? 'playback.pause' : 'playback.play')}
            title={t(playback.playing ? 'playback.pause' : 'playback.play')}
          >
            <Icon name={playback.playing ? 'stop' : 'play'} />
          </button>
          <button type="button" className="ov-button" onClick={playback.restart} aria-label={t('playback.restart')} title={t('playback.restart')}><Icon name="reset" /></button>
          <input
            type="range"
            className="ov-playback-slider"
            min={0}
            max={Math.max(1, playback.durationMs)}
            step={1000}
            value={playback.cursorMs}
            onChange={(event) => playback.seek(Number(event.target.value))}
            aria-label={t('playback.position')}
          />
          <span className="ov-playback-time">{t('playback.time', { elapsed: formatPlaybackTime(playback.cursorMs), total: formatPlaybackTime(playback.durationMs) })}</span>
          <label className="ov-playback-speed">
            <span className="visually-hidden">{t('playback.speed')}</span>
            <select value={playback.speed} onChange={(event) => playback.setSpeed(Number(event.target.value) as PlaybackSpeed)} aria-label={t('playback.speed')}>
              {PLAYBACK_SPEEDS.map((speed) => <option key={speed} value={speed}>{`×${speed}`}</option>)}
            </select>
          </label>
          <span className="ov-playback-time">{t('playback.rays', { count: String(playback.count) })}</span>
          {simulation && truth ? (
            <span className="ov-playback-time">
              {t('playback.truth', { actual: formatEstimateDistance(truth.actualM), error: truth.errorM === null ? '--' : formatEstimateDistance(truth.errorM) })}
            </span>
          ) : null}
        </>
      )}
      {onClose ? (
        <button type="button" className="ov-button" onClick={onClose} aria-label={t('playback.exit')} title={t('playback.exit')}><Icon name="close" /></button>
      ) : null}
    </section>
  );
}
