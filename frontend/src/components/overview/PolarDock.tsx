import type { JSX } from 'react';
import { useState } from 'react';
import type { CompassConfig, PolarSettings, TelemetrySnapshot } from '../../types';
import { bearingForView, formatDegrees, normalizeDegrees, polarView } from '../../lib/polar';
import { overviewDoaStatus } from '../../lib/doaStatus';
import { sourceBadge } from '../../lib/telemetrySource';
import { halfPowerWidth } from '../../lib/doaGeometry';
import { parseCompassOffsetInput, parseTypedNumber, validPolarHead, validPolarRange } from '../../lib/polarViewSettings';
import type { PolarViewSettings } from '../../lib/polarViewSettings';
import { useI18n } from '../../lib/i18n';
import { PolarPlot, peakUpHead, radialDomain } from '../PolarPlot';
import { Icon } from '../ui';
import { useSyncedDraft } from './useSyncedDraft';

function degreesLabel(value: number): string {
  return String(Number(value.toFixed(1)));
}

function dbText(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** The last curve the dock drew, with the browser time it arrived. */
export interface HeldCurve {
  values: number[];
  atMs: number;
}

// Module scope keeps it across route changes, like the map's last station fix.
let lastCurve: HeldCurve | null = null;

/**
 * The curve to draw: the current one, remembered with the time it arrived,
 * or, while there is none (stale data, no Angular frame), the last one, so
 * the plot never empties; the dock then says it has no update. Simulation
 * curves are drawn but never remembered.
 */
export function heldCurve(previous: HeldCurve | null, current: number[] | null, simulation: boolean, nowMs: number): { draw: number[] | null; held: HeldCurve | null; memory: HeldCurve | null } {
  if (current) {
    if (simulation) return { draw: current, held: null, memory: previous };
    const memory = previous?.values === current ? previous : { values: current, atMs: nowMs };
    return { draw: current, held: null, memory };
  }
  if (simulation || !previous) return { draw: null, held: null, memory: previous };
  return { draw: previous.values, held: previous, memory: previous };
}

const parseHead = (text: string): number | null => {
  const value = parseTypedNumber(text);
  return value !== null && validPolarHead(value) ? value : null;
};

/**
 * Polar section of the Overview dock: the plot, its footer, and the "Atur"
 * column (Head Up, compass offset source, dB scale). View settings are local
 * renderer choices; a manual compass offset is the same local Compass source
 * the Configuration page writes, so it moves the map and the plot together.
 */
export function PolarDock({
  snapshot,
  localSnapshotFresh,
  settings,
  offsetSource,
  offsetVerified,
  compassConfig,
  onCompassConfigChanged,
  view,
  onViewChange,
}: {
  snapshot: TelemetrySnapshot | null;
  localSnapshotFresh: boolean;
  /** Plot settings after the local axis override; compassOffset is the one the map uses too. */
  settings: PolarSettings;
  offsetSource: string;
  offsetVerified: boolean;
  compassConfig: CompassConfig;
  onCompassConfigChanged?: (next: CompassConfig) => void;
  view: PolarViewSettings;
  onViewChange: (next: PolarViewSettings) => void;
}): JSX.Element {
  const { t, lang } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const simulation = snapshot?.simulation === true;
  const source = sourceBadge(snapshot);
  const sourceLabel = source ? t(source.labelKey) : undefined;
  const status = overviewDoaStatus(snapshot, localSnapshotFresh);
  const polar = polarView(snapshot, settings, localSnapshotFresh, null, settings);
  const curve = heldCurve(lastCurve, status.shown ? polar.values : null, snapshot?.simulation === true, Date.now());
  lastCurve = curve.memory;
  const values = curve.draw;
  const heldAt = curve.held ? new Date(curve.held.atMs).toLocaleTimeString(lang === 'id' ? 'id-ID' : 'en-GB', { hour12: false }) : null;
  const width = values ? halfPowerWidth(values) : null;
  const widthText = width ? `${width.widthDeg}°` : t('common.na');
  const head = validPolarHead(view.head) ? view.head : 0;
  const headLabel = degreesLabel(head);
  const compass = settings.figType === 'Compass';
  const manualOffset = !simulation && compassConfig.source === 'MANUAL';
  const fallbackOffset = !simulation && (compassConfig.source === 'FALLBACK' || !offsetVerified);
  const bearing = status.shown ? bearingForView(polar) : null;
  const [autoLow, autoHigh] = radialDomain(values, simulation);

  // A held curve says since when; the dock is narrow, so that replaces the waiting text.
  const footer = heldAt ? t('polarDock.heldCurve', { time: heldAt })
    : status.shown && polar.canonicalAngle !== null
    ? compass
      ? t('polarDock.footer', { peak: polar.displayPeak === null ? '—' : formatDegrees(polar.displayPeak, 1), width: widthText, head: headLabel })
      : t('polarDock.footerPolar', { theta: formatDegrees(polar.canonicalAngle, 1), width: widthText, head: headLabel })
    : t('polarDock.footerWaiting', { head: headLabel });

  // Head Up: slider, typed value and "peak up" all write the same view field.
  const [headDraft, setHeadDraft] = useSyncedDraft(head, parseHead, degreesLabel);
  const headError = parseHead(headDraft) === null;
  const setHead = (next: number) => onViewChange({ ...view, head: next });

  // Compass offset: the typed value is kept as typed, stored in [0, 360).
  const [offsetDraft, setOffsetDraft] = useSyncedDraft(manualOffset ? compassConfig.manualCompassOffset : null, parseCompassOffsetInput, degreesLabel);
  const offsetError = manualOffset && parseCompassOffsetInput(offsetDraft) === null;
  const offsetTag = simulation ? 'SIMULATION'
    : offsetError ? t('polarDock.offsetRange')
      : manualOffset ? t('polarDock.offsetTagManual')
        : fallbackOffset ? t('polarDock.offsetFallback') : t('polarDock.offsetTagDataOut');
  const offsetTagTone = simulation ? 'is-warn' : offsetError ? 'is-error' : manualOffset ? 'is-manual' : fallbackOffset ? 'is-warn' : undefined;
  const writeCompass = (next: CompassConfig) => onCompassConfigChanged?.(next);
  const chooseManual = () => {
    if (manualOffset) return;
    // Start from the offset in use, so switching to Manual does not move the bearing.
    const current = Number.isFinite(settings.compassOffset) ? Number(normalizeDegrees(settings.compassOffset).toFixed(6)) % 360 : 0;
    setOffsetDraft(degreesLabel(current));
    writeCompass({ ...compassConfig, source: 'MANUAL', manualCompassOffset: current, manualFigType: settings.figType });
  };
  const chooseDataOut = () => {
    if (compassConfig.source !== 'DATA_OUT') writeCompass({ ...compassConfig, source: 'DATA_OUT' });
  };

  // dB scale: Auto follows the vector; Manual starts from the current auto range.
  const auto = view.range === null;
  const [minDraft, setMinDraft] = useSyncedDraft(view.range?.min ?? null, parseTypedNumber, dbText);
  const [maxDraft, setMaxDraft] = useSyncedDraft(view.range?.max ?? null, parseTypedNumber, dbText);
  const typedMin = parseTypedNumber(minDraft);
  const typedMax = parseTypedNumber(maxDraft);
  const rangeError = !auto && !validPolarRange({ min: typedMin, max: typedMax });
  const applyRange = (minText: string, maxText: string) => {
    const range = { min: parseTypedNumber(minText), max: parseTypedNumber(maxText) };
    if (validPolarRange(range)) onViewChange({ ...view, range });
  };
  const dbTag = rangeError ? t('polarDock.rangeError')
    : auto ? t('polarDock.dbAutoRange', { low: dbText(autoLow), high: dbText(autoHigh) })
      : t('polarDock.dbManualRange', { low: dbText(view.range?.min ?? autoLow), high: dbText(view.range?.max ?? autoHigh) });

  const reset = () => onViewChange({ figTypeOverride: null, head: 0, range: null });

  return (
    <section id="panel-polar" className={`ov-polar${settingsOpen ? ' is-settings-open' : ''}`} aria-labelledby="ov-polar-title">
      <div className="ov-dock-head">
        <h2 id="ov-polar-title">{t('polarDock.title')}</h2>
        <div className="ov-seg ov-seg-compact" role="group" aria-label={t('polarDock.viewMode')}>
          <button type="button" aria-pressed={compass} onClick={() => onViewChange({ ...view, figTypeOverride: 'Compass' })}>{t('polarDock.viewCompass')}</button>
          <button type="button" aria-pressed={!compass} onClick={() => onViewChange({ ...view, figTypeOverride: 'Polar' })}>{t('polarDock.viewPolar')}</button>
        </div>
        <button className="ov-button" type="button" aria-expanded={settingsOpen} aria-controls="polar-settings" onClick={() => setSettingsOpen(!settingsOpen)}>
          <Icon name="sliders" /><span>{t('polarDock.settings')}</span>
        </button>
      </div>
      <div className="ov-polar-body">
        <div className="ov-polar-plot">
          <div className={heldAt ? 'ov-polar-frame is-held' : 'ov-polar-frame'}>
            <PolarPlot values={values} settings={settings} simulation={simulation} offsetSource={offsetSource} head={head} range={view.range} hideSettings compactCaption modeBar={false} sourceLabel={sourceLabel} />
          </div>
          <p className={heldAt ? 'ov-polar-footer is-warn' : 'ov-polar-footer'}>{footer}{!heldAt && status.shown && !values ? <span className="is-warn"> · {t('polarDock.noCurve')}</span> : null}{manualOffset && compass ? <span className="is-manual"> · MANUAL</span> : null}</p>
        </div>
        {settingsOpen ? (
          <div id="polar-settings" className="ov-polar-settings" role="group" aria-label={t('polarDock.settingsRegion')}>
            <div className="ov-ps-row">
              <div className="ov-ps-label">
                <label htmlFor="ov-ps-head">{t('polarDock.headUp')}</label>
                <span className={headError ? 'is-error' : undefined}>{headError ? t('polarDock.headRange') : t('polarDock.headTag', { head: headLabel })}</span>
              </div>
              <div className="ov-ps-controls">
                <input className="ov-ps-slider" type="range" min="0" max="359" step="1" aria-label={t('polarDock.headSlider')} value={Math.round(head) % 360} onChange={(event) => setHead(Number(event.target.value))} />
                <span className={`ov-unit-input ov-w-80${headError ? ' is-error' : ''}`}>
                  <input id="ov-ps-head" type="text" inputMode="decimal" autoComplete="off" spellCheck={false} aria-invalid={headError || undefined} value={headDraft} onChange={(event) => {
                    setHeadDraft(event.target.value);
                    const next = parseHead(event.target.value);
                    if (next !== null) setHead(next);
                  }} />
                  <span aria-hidden="true">°</span>
                </span>
                <button className="ov-icon-button is-bordered" type="button" aria-label={t('polarDock.peakUpAria')} title={t('polarDock.peakUp')} disabled={!status.shown || polar.canonicalAngle === null} onClick={() => {
                  if (polar.canonicalAngle !== null) setHead(peakUpHead(polar.canonicalAngle, settings));
                }}>
                  <Icon name="peak-up" />
                </button>
              </div>
            </div>
            <div className="ov-ps-row">
              <div className="ov-ps-label">
                <label htmlFor="ov-ps-offset">{t('polarDock.offset')}</label>
                <span className={offsetTagTone}>{offsetTag}</span>
              </div>
              <div className="ov-ps-controls">
                <div className="ov-seg ov-w-132" role="group" aria-label={t('polarDock.offsetSource')}>
                  <button type="button" disabled={simulation} aria-pressed={!simulation && compassConfig.source === 'DATA_OUT'} onClick={chooseDataOut}>{t('polarDock.offsetDataOut')}</button>
                  <button type="button" disabled={simulation} aria-pressed={manualOffset} onClick={chooseManual}>{t('polarDock.offsetManual')}</button>
                </div>
                <span className={`ov-unit-input ov-w-100${offsetError ? ' is-error' : ''}`}>
                  <input id="ov-ps-offset" type="text" inputMode="text" autoComplete="off" spellCheck={false} disabled={!manualOffset} aria-invalid={offsetError || undefined}
                    value={manualOffset ? offsetDraft : degreesLabel(settings.compassOffset)}
                    onChange={(event) => {
                      setOffsetDraft(event.target.value);
                      const next = parseCompassOffsetInput(event.target.value);
                      if (next !== null) writeCompass({ ...compassConfig, source: 'MANUAL', manualCompassOffset: next });
                    }} />
                  <span aria-hidden="true">°</span>
                </span>
                <span className="ov-ps-preview">{t('polarDock.bearingPreview', { bearing: bearing === null ? '—' : `${formatDegrees(bearing, 1)}°` })}</span>
              </div>
            </div>
            <div className="ov-ps-row">
              <div className="ov-ps-label">
                <span id="ov-ps-db-label">{t('polarDock.dbScale')}</span>
                <span className={rangeError ? 'is-error' : undefined}>{dbTag}</span>
              </div>
              <div className="ov-ps-controls">
                <div className="ov-seg ov-w-106" role="group" aria-labelledby="ov-ps-db-label">
                  <button type="button" aria-pressed={auto} onClick={() => onViewChange({ ...view, range: null })}>{t('polarDock.dbAuto')}</button>
                  <button type="button" aria-pressed={!auto} onClick={() => {
                    if (!auto) return;
                    setMinDraft(dbText(autoLow));
                    setMaxDraft(dbText(autoHigh));
                    onViewChange({ ...view, range: { min: autoLow, max: autoHigh } });
                  }}>{t('polarDock.dbManual')}</button>
                </div>
                <input className={`ov-db-input${rangeError ? ' is-error' : ''}`} type="text" inputMode="text" autoComplete="off" aria-label={t('polarDock.dbMin')} disabled={auto} aria-invalid={rangeError || undefined}
                  value={auto ? dbText(autoLow) : minDraft}
                  onChange={(event) => { setMinDraft(event.target.value); applyRange(event.target.value, maxDraft); }} />
                <span aria-hidden="true" className="ov-ps-dash">–</span>
                <input className={`ov-db-input${rangeError ? ' is-error' : ''}`} type="text" inputMode="text" autoComplete="off" aria-label={t('polarDock.dbMax')} disabled={auto} aria-invalid={rangeError || undefined}
                  value={auto ? dbText(autoHigh) : maxDraft}
                  onChange={(event) => { setMaxDraft(event.target.value); applyRange(minDraft, event.target.value); }} />
                <button className="ov-icon-button is-bordered" type="button" aria-label={t('polarDock.reset')} title={t('polarDock.reset')} onClick={reset}>
                  <Icon name="reset" />
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
