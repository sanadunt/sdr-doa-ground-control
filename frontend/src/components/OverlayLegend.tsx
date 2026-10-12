import type { JSX } from 'react';
import { SATURATION_WARNING_FRACTION, normalizeDb, type DbScale, type DoaOverlaySettings, type HalfPowerWidth } from '../lib/doaGeometry';
import { formatDistance, paletteGradientCss } from '../lib/overlayPalette';
import { useI18n } from '../lib/i18n';

function formatDb(value: number, known = true): string {
  return known ? `${Number(value.toFixed(1))}` : '—';
}

/**
 * Map legend: layer swatches, the colour scale the heat layer is painted with,
 * and the readings derived from the current vector (ring spacing, -3 dB width).
 */
export function OverlayLegend({ settings, scale, saturation, ringStepM, halfPower }: { settings: DoaOverlaySettings; scale: DbScale; saturation: number; ringStepM: number; halfPower: HalfPowerWidth | null }): JSX.Element {
  const { t } = useI18n();
  const beam = settings.heatStyle === 'beam';
  const auto = scale.mode !== 'manual';
  // Contrast bends the weight curve, so place the threshold tick in weight space.
  const thresholdPosition = normalizeDb(scale.thresholdDb, scale.minDb, scale.maxDb, settings.contrast) * 100;
  const showThreshold = beam && scale.known && scale.thresholdDb > scale.minDb && scale.thresholdDb < scale.maxDb;
  const scaleAria = auto
    ? t('map.scaleAutoAria', { min: formatDb(scale.minDb, scale.known), max: formatDb(scale.maxDb, scale.known) })
    : t('map.scaleAria', { min: formatDb(scale.minDb), max: formatDb(scale.maxDb) });
  const saturated = scale.mode === 'manual' && saturation >= SATURATION_WARNING_FRACTION;
  return (
    <div className="map-overlay-legend" role="note">
      <div className="legend-row">
        {settings.bearingVisible ? <span><i className="legend-swatch legend-bearing" /> {t('map.legendBearing')}</span> : null}
        {settings.bearingVisible && halfPower ? <span><i className="legend-swatch legend-edge" /> {t('map.legendEdges')}</span> : null}
        {settings.lobeVisible ? <span><i className="legend-swatch legend-lobe" /> {t('map.legendLobe')}</span> : null}
        {settings.ringsVisible && ringStepM > 0 ? <span className="legend-reading">{t('map.ringStep', { step: formatDistance(ringStepM) })}</span> : null}
        <span className="legend-reading">{halfPower ? t('map.halfPower', { deg: halfPower.widthDeg }) : t('map.halfPowerNone')}</span>
      </div>
      {settings.heatmapVisible ? (
        <div className="legend-scale" aria-label={beam ? scaleAria : t('map.scaleRelative')}>
          <span className="legend-scale-end">{beam ? formatDb(scale.minDb, scale.known) : t('map.scaleLow')}</span>
          <span className="legend-scale-bar" style={{ backgroundImage: paletteGradientCss(settings.heatPalette) }}>
            {showThreshold ? <i className="legend-threshold" style={{ left: `${thresholdPosition}%` }} title={t('map.scaleThreshold', { db: formatDb(scale.thresholdDb) })} /> : null}
          </span>
          <span className="legend-scale-end">{beam ? `${formatDb(scale.maxDb, scale.known)} dB` : t('map.scaleHigh')}</span>
          {beam && scale.mode === 'auto' ? <span className="legend-scale-mode">{t('map.scaleAuto')}</span> : null}
        </div>
      ) : null}
      {saturated ? <span className="legend-warning" role="status">{t('map.scaleSaturated', { pct: Math.round(saturation * 100) })}</span> : null}
      <small>{t('map.legendNote')}</small>
    </div>
  );
}
