import type { ExpressionSpecification } from 'maplibre-gl';
import type { DoaOverlaySettings } from './doaGeometry';

export type HeatPalette = DoaOverlaySettings['heatPalette'];

/** Colour stops on a 0–1 visual weight. Shared by the map layers and the legend bar. */
export const PALETTE_STOPS: Record<HeatPalette, ReadonlyArray<readonly [number, string]>> = {
  kraken: [[0, '#1d4e89'], [0.35, '#126e82'], [0.6, '#f5d547'], [0.8, '#f28f3b'], [1, '#d7263d']],
  thermal: [[0, '#30123b'], [0.35, '#4666a9'], [0.58, '#35b779'], [0.8, '#fde725'], [1, '#ef3b2c']],
  viridis: [[0, '#440154'], [0.36, '#31688e'], [0.6, '#35b779'], [0.8, '#fde725'], [1, '#fff7ae']],
  monochrome: [[0, '#39434b'], [0.55, '#aeb9c1'], [1, '#ffffff']],
};

function flatten(stops: ReadonlyArray<readonly [number, string]>): Array<number | string> {
  return stops.flatMap(([stop, colour]) => [stop, colour]);
}

/** Beam sectors: colour by the feature's normalized dB weight. */
export function beamColorExpression(palette: HeatPalette): ExpressionSpecification {
  return ['interpolate', ['linear'], ['get', 'weight'], ...flatten(PALETTE_STOPS[palette])] as unknown as ExpressionSpecification;
}

/**
 * Beam opacity stays a paint expression so the opacity and intensity sliders
 * never rebuild geometry: opacity × radial falloff × min(1, weight × intensity).
 */
export function beamOpacityExpression(opacity: number, intensity: number): ExpressionSpecification {
  return ['*', opacity, ['get', 'radial'], ['min', 1, ['*', ['get', 'weight'], intensity]]] as unknown as ExpressionSpecification;
}

/** Density heatmap: transparent at zero density, then the same palette. */
export function heatmapColorExpression(palette: HeatPalette): ExpressionSpecification {
  const stops = PALETTE_STOPS[palette].map(([stop, colour]) => [0.08 + stop * 0.92, colour] as const);
  return ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', ...flatten(stops)] as unknown as ExpressionSpecification;
}

/**
 * Heatmap radius doubles per zoom level around the reference zoom so the blur
 * covers the same ground distance while zooming instead of changing shape.
 */
export function heatmapRadiusExpression(blurPx: number, referenceZoom = 14): ExpressionSpecification {
  return ['interpolate', ['exponential', 2], ['zoom'], referenceZoom - 4, Math.max(1, blurPx / 16), referenceZoom, blurPx, referenceZoom + 3, blurPx * 8] as unknown as ExpressionSpecification;
}

export function paletteGradientCss(palette: HeatPalette): string {
  return `linear-gradient(90deg, ${PALETTE_STOPS[palette].map(([stop, colour]) => `${colour} ${Math.round(stop * 100)}%`).join(', ')})`;
}

/** Ground distance label: metres below 1 km, otherwise kilometres without trailing zeros. */
export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres) || metres < 0) return '—';
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${Number((metres / 1000).toFixed(2))} km`;
}
