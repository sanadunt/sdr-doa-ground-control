import type { JSX } from 'react';
import { normalizeDb, type DoaOverlaySettings, type HalfPowerWidth } from '../lib/doaGeometry';
import { formatDistance, paletteGradientCss } from '../lib/overlayPalette';
import { useI18n } from '../lib/i18n';

function formatDb(value: number): string {
  return `${Number(value.toFixed(1))}`;
}

/**
 * Map legend: layer swatches, the colour scale the heat layer is painted with,
 * and the readings derived from the current vector (ring spacing, -3 dB width).
 */
export function OverlayLegend({ settings, ringStepM, halfPower }: { settings: DoaOverlaySettings; ringStepM: number; halfPower: HalfPowerWidth | null }): JSX.Element {
  const { t } = useI18n();
  const beam = settings.heatStyle === 'beam';
  // Contrast bends the weight curve, so place the threshold tick in weight space.
  const thresholdPosition = normalizeDb(settings.thresholdDb, settings.minDb, settings.maxDb, settings.contrast) * 100;
  const showThreshold = beam && settings.thresholdDb > settings.minDb && settings.thresholdDb < settings.maxDb;
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
        <div className="legend-scale" aria-label={beam ? t('map.scaleAria', { min: formatDb(settings.minDb), max: formatDb(settings.maxDb) }) : t('map.scaleRelative')}>
          <span className="legend-scale-end">{beam ? formatDb(settings.minDb) : t('map.scaleLow')}</span>
          <span className="legend-scale-bar" style={{ backgroundImage: paletteGradientCss(settings.heatPalette) }}>
            {showThreshold ? <i className="legend-threshold" style={{ left: `${thresholdPosition}%` }} title={t('map.scaleThreshold', { db: formatDb(settings.thresholdDb) })} /> : null}
          </span>
          <span className="legend-scale-end">{beam ? `${formatDb(settings.maxDb)} dB` : t('map.scaleHigh')}</span>
        </div>
      ) : null}
      <small>{t('map.legendNote')}</small>
    </div>
  );
}
