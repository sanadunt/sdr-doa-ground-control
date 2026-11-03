import { Fragment } from 'react';
import type { JSX } from 'react';
import type { MapCoordinate, PolarSettings, TelemetrySnapshot, Tone } from '../types';
import { numberOrNull, partialCsvReady, primaryCandidate } from '../lib/telemetry';
import { bearingForView, formatDegrees, heldBearing as heldBearingFor, polarView } from '../lib/polar';
import { doaStatusTextKey, overviewDoaStatus, provisionalDoa } from '../lib/doaStatus';
import { useI18n } from '../lib/i18n';
import { ageAtAnswerMs } from '../lib/snapshotRead';
import { doaSample, doaSampleText, edgeDoaReasonKey, edgeDoaReasons, snapshotRf, snapshotVfoPeak, sourceBadge, vfoPeakText } from '../lib/telemetrySource';
import type { MessageKey, Translate } from '../lib/i18n';
import type { RfSettings } from '../lib/telemetrySource';
import { engineSquelchDb } from '../lib/configPatch';

export function coordinateSourceKey(source: MapCoordinate['source'] | undefined): MessageKey {
  if (source === 'SIMULATION') return 'map.sourceSimulation';
  if (source === 'FALLBACK') return 'map.sourceFallback';
  if (source === 'MANUAL') return 'map.sourceManual';
  return 'map.sourceStation';
}

function formatOffset(offset: number): string {
  return String(Number(offset.toFixed(1)));
}

/**
 * Compact bearing HUD over the map. The primary value is the geographic
 * north-clockwise bearing derived from theta_0 and the compass offset; theta_0
 * stays visible beside it, and so does the plotted display peak, because the
 * two are not guaranteed to agree. A DoA overviewDoaStatus() does not show
 * but that is still readable (old, ok=0, DAQ unknown) keeps its bearing,
 * dimmed and marked NOT VALID, with the reason it is held and the edge's
 * own reasons (contract 1.10 health.why, the ok=0 reason). One line names
 * the DoA record's frequency and power (an UNVERIFIED ok=0 record dimmed
 * with the held bearing), or without a current record the frequency the SDR
 * is set to (state.rf), marked as a setting.
 */
export function DoaReadout({
  snapshot,
  localSnapshotFresh,
  settings,
  curveOffset = null,
  offsetSource,
  offsetVerified,
  offsetManual = false,
}: {
  snapshot: TelemetrySnapshot | null;
  localSnapshotFresh: boolean;
  /** Plot axis (after the local override) for the display peak, and the compass offset. */
  settings: PolarSettings;
  /** The offset of the Angular curve's own frame (curveCompassOffset); null: the compass offset. */
  curveOffset?: number | null;
  /** Untranslated offset source label, e.g. DATA_OUT or MANUAL. */
  offsetSource: string;
  offsetVerified: boolean;
  /** The offset is a local manual entry; shown in the manual tone. */
  offsetManual?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const simulation = Boolean(snapshot?.simulation);
  const view = polarView(snapshot, settings, localSnapshotFresh, null, settings, curveOffset);
  const status = overviewDoaStatus(snapshot, localSnapshotFresh);
  const statusText = t(doaStatusTextKey(status.reason));
  const bearing = status.shown ? bearingForView(view) : null;
  // A held DoA turns with the heading of its own sample (contract 1.10 h); a manual offset stays above it.
  const held = provisionalDoa(snapshot, status);
  const heldTheta = held?.thetaDeg ?? null;
  const heldBearing = heldBearingFor(heldTheta, offsetManual ? null : held?.headingDeg ?? null, settings.compassOffset)?.bearingDeg ?? null;
  // Why the edge itself holds the DoA back, in words, the codes in the tooltip.
  const edgeWhy = status.shown ? [] : edgeDoaReasons(snapshot);
  const edgeWhyText = edgeWhy.map((code) => {
    const key = edgeDoaReasonKey(code);
    return key ? t(key) : code;
  }).join(' · ');
  const partial = status.shown && partialCsvReady(snapshot);
  // The CSV view of Data Out, or the MQTT view; the badge says which source.
  const csv = primaryCandidate(snapshot);
  const source = sourceBadge(snapshot);
  // A held ok=0 sample newer than the stale LIVE DoA carries its own age, and is NOT VALID rather than old.
  const heldUnverified = held?.unverified === true;
  const unverifiedRecord = snapshot?.mqtt?.doa_unverified;
  const rawAge = heldUnverified
    ? numberOrNull(unverifiedRecord !== null && typeof unverifiedRecord === 'object' ? (unverifiedRecord as Record<string, unknown>).age_ms : null)
    : numberOrNull(csv.freshness?.age_ms);
  // The DoA age when this page got the answer: a shared read's own age counts.
  const ageMs = ageAtAnswerMs(rawAge !== null && rawAge >= 0 ? rawAge : null, snapshot);
  const bearingTone: Tone = status.shown ? (status.code === 'DEGRADED' || !offsetVerified ? 'warn' : 'good') : status.code === 'WAITING' ? 'neutral' : 'warn';
  // The age is the value when the last answer arrived and does not grow, so
  // once the local window has closed (or the source itself is stale) it is
  // marked STALE instead of reading as current. Without an age (Data Out
  // unreachable) there is nothing to mark.
  const ageStale = !simulation && ageMs !== null && (!localSnapshotFresh || (status.code === 'STALE' && !heldUnverified));
  const ageValue = simulation ? 'SIM' : ageMs !== null ? t('common.durationS', { value: (ageMs / 1000).toFixed(1) }) : '—';
  // A held bearing is old (STALE N s) or not valid at all (ok=0, DAQ unknown).
  const heldOld = !heldUnverified && (status.reason === 'sourceStale' || status.reason === 'localExpired' || status.reason === 'nodeStalled');
  const staleTag = heldBearing !== null && heldOld && ageMs !== null && !simulation;
  const heldTag = heldBearing === null ? null : staleTag ? t('polar.staleTag', { age: ageValue }) : t('polar.notValid');
  // The STALE tag already carries the age; the age line does not repeat it.
  const age = ageStale && !staleTag ? `${ageValue} · STALE` : ageValue;
  const ageTitle = !simulation && snapshot && ageMs === null && csv.available === true ? t('readout.clockUnverified') : undefined;
  const frameDetail = bearing !== null && view.canonicalAngle !== null
    ? t(offsetVerified ? 'readout.bearingDetail' : 'readout.bearingDetailAssumed', {
      theta: formatDegrees(view.canonicalAngle, 1),
      offset: formatOffset(settings.compassOffset),
      source: offsetSource,
    })
    : null;
  const sample = doaSample(snapshot, status, localSnapshotFresh);
  // An expired answer's setting is not shown as current either.
  const rfCenterHz = sample === null && localSnapshotFresh ? snapshotRf(snapshot)?.centerHz ?? null : null;
  // A verified record only while the bearing is shown, an UNVERIFIED one only in the held branch (doaSample).
  const sampleLine = sample !== null ? (
    <div className={sample.verified ? 'ov-hud-sample' : 'ov-hud-sample is-provisional'}>{t('hud.signal')} <b>{doaSampleText(sample)}</b></div>
  ) : rfCenterHz !== null ? (
    <div className="ov-hud-sample is-setting">{t('hud.setting')} <b>{(rfCenterHz / 1e6).toFixed(3)} MHz</b></div>
  ) : null;
  // What the SDR is set to (state.rf, edge 1.7+): gain, VFO0 and its squelch, under the signal line.
  const rfLine = hudRfParts(localSnapshotFresh ? snapshotRf(snapshot) : null, t);
  // Without a shown DoA: how far the output VFO's peak is from squelch (edge 1.11), so the operator can tell
  // no signal from a squelch set too high. An expired answer's reading is not shown as current.
  const vfoPeak = !status.shown && localSnapshotFresh ? snapshotVfoPeak(snapshot) : null;
  const belowSquelch = vfoPeak?.marginDb != null && vfoPeak.marginDb < 0;
  const vfoPeakLine = vfoPeak?.fresh ? (
    <div className={belowSquelch ? 'ov-hud-sample is-warn' : 'ov-hud-sample'}>
      {t('hud.vfoPeak')} <b>{vfoPeakText(vfoPeak)}</b>{belowSquelch ? ` · ${t('hud.belowSquelch')}` : null}
    </div>
  ) : null;
  const peakAxis = settings.figType === 'Compass' ? t('readout.peakAxisCompass') : t('readout.peakAxisPolar');
  const peakTitle = status.shown && view.peakValue !== null ? `${peakAxis} · ${t('readout.peakDetail', { db: view.peakValue.toFixed(1) })}` : undefined;

  return (
    <section className={`ov-hud ov-card readout-${bearingTone}`} aria-label={t('readout.region')}>
      <div className="ov-hud-head">
        <span className="ov-eyebrow">{t('readout.bearing')}</span>
        {simulation ? <span className="ov-tag tone-warn">{t('readout.simulation')}</span> : null}
        {source ? <span className={`ov-tag tone-${source.tone}`}>{t(source.labelKey)}</span> : null}
        {partial ? <span className="ov-tag tone-warn">{t('polar.partialTag')}</span> : null}
        {heldTag ? <span className="ov-tag tone-neutral">{heldTag}</span> : null}
        <span className={ageStale ? 'ov-hud-age is-warn' : 'ov-hud-age'} title={ageTitle}>{t('hud.age', { age })}</span>
      </div>
      <div className={heldBearing !== null ? 'ov-hud-bearing is-provisional' : 'ov-hud-bearing'} title={frameDetail ?? undefined}>
        {bearing !== null ? <>{formatDegrees(bearing, 1)}<small>°</small></>
          : heldBearing !== null ? <>{formatDegrees(heldBearing, 1)}<small>°</small></>
            : <span className="readout-empty">—</span>}
      </div>
      {status.shown ? (
        <>
          <div className="ov-hud-grid">
            <span>{t('hud.theta')} <b>{view.canonicalAngle !== null ? `${formatDegrees(view.canonicalAngle, 1)}°` : '—'}</b></span>
            <span title={peakTitle}>{t('hud.peak')} <b>{view.displayPeak !== null ? `${formatDegrees(view.displayPeak, 1)}°` : '—'}</b></span>
          </div>
          {sampleLine}
          {rfLine.length ? <div className="ov-hud-sample is-setting ov-hud-rf">{rfLine.map(([label, value], index) => <Fragment key={label}>{index ? ' · ' : ''}<span>{label} <b>{value}</b></span></Fragment>)}</div> : null}
          <div className="ov-hud-offset">
            {t('hud.offset')} <b>{formatOffset(settings.compassOffset)}°</b> · <span className={offsetManual ? 'is-manual' : offsetVerified ? undefined : 'is-warn'}>{offsetSource}</span>
          </div>
          {status.code === 'DEGRADED' || status.code === 'PARTIAL' ? <p className="ov-hud-held">{statusText}</p> : null}
        </>
      ) : (
        <>
          {heldTheta !== null ? (
            <div className="ov-hud-grid is-provisional">
              <span>{t('hud.theta')} <b>{formatDegrees(heldTheta, 1)}°</b></span>
            </div>
          ) : null}
          {sampleLine}
          {rfLine.length ? <div className="ov-hud-sample is-setting ov-hud-rf">{rfLine.map(([label, value], index) => <Fragment key={label}>{index ? ' · ' : ''}<span>{label} <b>{value}</b></span></Fragment>)}</div> : null}
          {vfoPeakLine}
          <p className="ov-hud-held" role="status">{statusText}</p>
          {edgeWhy.length ? <p className="ov-hud-held" title={edgeWhy.join(', ')}>{t('hud.edgeWhy', { reasons: edgeWhyText })}</p> : null}
        </>
      )}
    </section>
  );
}

/**
 * The HUD's settings line from state.rf: gain, VFO0 and its squelch, each only when the edge sends it.
 * The squelch is the level the engine runs (whole dB) or, while automatic, its mode (edge 1.9).
 */
export function hudRfParts(rf: RfSettings | null, t: Translate): Array<[string, string]> {
  if (!rf) return [];
  const parts: Array<[string, string]> = [];
  if (rf.gainDb !== null) parts.push([t('hud.gain'), `${rf.gainDb.toFixed(1)} dB`]);
  if (rf.vfo0Hz !== null) parts.push(['VFO', `${(rf.vfo0Hz / 1e6).toFixed(3)} MHz`]);
  const mode = rf.squelchMode ?? null;
  if (rf.squelchDb !== null) parts.push([t('hud.squelch'), `${mode === null ? rf.squelchDb.toFixed(1) : engineSquelchDb(rf.squelchDb)} dB`]);
  else if (mode !== null && mode !== 'Manual') parts.push([t('hud.squelch'), mode.toUpperCase()]);
  return parts;
}
