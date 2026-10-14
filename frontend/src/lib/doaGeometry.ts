import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import { geographicBearingForBin } from './polar';

export const EARTH_RADIUS_M = 6_371_000;

export interface DoaOverlaySettings {
  lobeVisible: boolean;
  bearingVisible: boolean;
  heatmapVisible: boolean;
  guidesVisible: boolean;
  ringsVisible: boolean;
  heatStyle: 'beam' | 'density';
  /** 'auto' derives the dB range from the current vector; 'manual' uses minDb/maxDb/thresholdDb. */
  dbScale: 'auto' | 'manual';
  maxDistanceM: number;
  lobeDistanceM: number;
  lobeOpacity: number;
  heatOpacity: number;
  heatBlur: number;
  minDb: number;
  maxDb: number;
  contrast: number;
  thresholdDb: number;
  radialSamples: number;
  distanceFalloff: number;
  heatIntensity: number;
  guideInterval: 15 | 30 | 45 | 90;
  heatPalette: 'kraken' | 'thermal' | 'viridis' | 'monochrome';
}

export const DEFAULT_DOA_OVERLAY_SETTINGS: DoaOverlaySettings = {
  lobeVisible: true,
  bearingVisible: true,
  heatmapVisible: true,
  guidesVisible: true,
  ringsVisible: true,
  heatStyle: 'beam',
  dbScale: 'auto',
  maxDistanceM: 1000,
  lobeDistanceM: 1000,
  lobeOpacity: 0.18,
  heatOpacity: 0.72,
  heatBlur: 30,
  minDb: -60,
  maxDb: 0,
  contrast: 1,
  thresholdDb: -60,
  radialSamples: 8,
  distanceFalloff: 0.35,
  heatIntensity: 1,
  guideInterval: 45,
  heatPalette: 'kraken',
};

export interface GeoOrigin { latitude: number; longitude: number }

export function normalizeBearing(value: number): number {
  return ((value % 360) + 360) % 360;
}

/**
 * Point at a geodesic distance and bearing from the origin. The longitude stays
 * continuous with the origin (it may pass ±180°) so overlays near the
 * antimeridian do not wrap across the world; MapLibre draws such longitudes in
 * the adjacent world copy.
 */
export function destination(origin: GeoOrigin, bearingDeg: number, distanceM: number): [number, number] {
  const angular = distanceM / EARTH_RADIUS_M;
  const bearing = normalizeBearing(bearingDeg) * Math.PI / 180;
  const latitude = origin.latitude * Math.PI / 180;
  const resultLat = Math.asin(Math.sin(latitude) * Math.cos(angular) + Math.cos(latitude) * Math.sin(angular) * Math.cos(bearing));
  const deltaLon = Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(latitude), Math.cos(angular) - Math.sin(latitude) * Math.sin(resultLat));
  return [origin.longitude + deltaLon * 180 / Math.PI, resultLat * 180 / Math.PI];
}

export interface DbScale {
  minDb: number;
  maxDb: number;
  thresholdDb: number;
  mode: 'auto' | 'manual' | 'simulation';
  /** False for the auto scale while there is no vector to derive it from. */
  known: boolean;
}

/** Fixed range of the synthetic simulation vector. */
export const SIMULATION_DB_RANGE: readonly [number, number] = [-60, 0];
/** Smallest auto span, so a nearly flat vector is not stretched into a confident lobe. */
export const MIN_AUTO_DB_SPAN = 1;

/**
 * dB range used to turn the vector into visual weights. Live Data Out vectors
 * are shifted to their own floor (all bins >= 0), so a fixed -60..0 range
 * would give every bin weight 1. Auto mode follows the current vector like the
 * polar plot does; simulation keeps its fixed synthetic range.
 */
export function effectiveDbScale(values: readonly number[] | null, settings: DoaOverlaySettings, simulation = false): DbScale {
  if (settings.dbScale === 'manual') return { minDb: settings.minDb, maxDb: settings.maxDb, thresholdDb: settings.thresholdDb, mode: 'manual', known: true };
  if (simulation) return { minDb: SIMULATION_DB_RANGE[0], maxDb: SIMULATION_DB_RANGE[1], thresholdDb: SIMULATION_DB_RANGE[0], mode: 'simulation', known: true };
  const finite = (values ?? []).filter(Number.isFinite);
  if (!finite.length) return { minDb: settings.minDb, maxDb: settings.maxDb, thresholdDb: settings.minDb, mode: 'auto', known: false };
  const low = Math.floor(Math.min(...finite) * 10) / 10;
  const high = Math.max(Math.ceil(Math.max(...finite) * 10) / 10, low + MIN_AUTO_DB_SPAN);
  return { minDb: low, maxDb: high, thresholdDb: low, mode: 'auto', known: true };
}

/** Share of finite bins at or above the top of the scale (drawn at full weight). */
export function saturatedFraction(values: readonly number[] | null, maxDb: number): number {
  const finite = (values ?? []).filter(Number.isFinite);
  if (!finite.length || !Number.isFinite(maxDb)) return 0;
  return finite.filter((value) => value >= maxDb).length / finite.length;
}

/** Above this share of saturated bins the legend warns that the scale hides direction. */
export const SATURATION_WARNING_FRACTION = 0.5;

export function normalizeDb(value: number, minDb: number, maxDb: number, contrast = 1): number {
  if (!Number.isFinite(value) || !Number.isFinite(minDb) || !Number.isFinite(maxDb) || maxDb <= minDb) return 0;
  return Math.max(0, Math.min(1, ((value - minDb) / (maxDb - minDb)) ** Math.max(0.25, contrast)));
}

export function heatDistanceWeight(sample: number, samples: number, falloff: number): number {
  const progress = Math.max(0, Math.min(1, sample / Math.max(1, samples)));
  return Math.max(0, (1 - progress * Math.max(0, Math.min(1, falloff))) * (1 - progress * .18));
}

// Vectors and theta_0 are in the counter-clockwise array frame. Every DoA layer
// maps bins through geographicBearingForBin so the map agrees with the Compass
// reading of the polar plot, whatever axis the plot itself uses.
export function lobeFeature(origin: GeoOrigin, values: number[], settings: DoaOverlaySettings, compassOffset = 0): Feature<Polygon> {
  // The ring is the 360 perimeter points only, closed on its first point.
  const coordinates: [number, number][] = [];
  for (let bin = 0; bin < 360; bin += 1) {
    coordinates.push(destination(origin, geographicBearingForBin(bin, compassOffset), settings.lobeDistanceM * normalizeDb(values[bin] ?? settings.minDb, settings.minDb, settings.maxDb, settings.contrast)));
  }
  coordinates.push(coordinates[0]);
  return { type: 'Feature', properties: { layer: 'lobe', meaning: 'relative angular response' }, geometry: { type: 'Polygon', coordinates: [coordinates] } };
}

export function bearingFeature(origin: GeoOrigin, bearing: number, settings: DoaOverlaySettings): Feature<LineString> {
  return { type: 'Feature', properties: { layer: 'bearing', bearing: normalizeBearing(bearing), meaning: 'direction helper, not target range' }, geometry: { type: 'LineString', coordinates: [[origin.longitude, origin.latitude], destination(origin, bearing, settings.maxDistanceM)] } };
}

export function guideFeatures(origin: GeoOrigin, settings: DoaOverlaySettings): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  for (let angle = 0; angle < 360; angle += settings.guideInterval) {
    features.push({ type: 'Feature', properties: { layer: 'guide', bearing: angle }, geometry: { type: 'LineString', coordinates: [[origin.longitude, origin.latitude], destination(origin, angle, settings.maxDistanceM)] } });
  }
  return { type: 'FeatureCollection', features };
}

/** Density samples below this visual weight add haze without direction information. */
export const MIN_HEAT_WEIGHT = 0.03;

export function heatFeatures(origin: GeoOrigin, values: number[], settings: DoaOverlaySettings, compassOffset = 0): FeatureCollection<Point> {
  const features: Feature<Point>[] = [];
  const step = Math.max(1, Math.floor(360 / Math.max(1, values.length)));
  for (let bin = 0; bin < 360; bin += step) {
    const weight = normalizeDb(values[bin] ?? settings.minDb, settings.minDb, settings.maxDb, settings.contrast);
    if (weight <= 0) continue;
    if ((values[bin] ?? settings.minDb) < settings.thresholdDb) continue;
    const bearing = geographicBearingForBin(bin, compassOffset);
    const samples = Math.max(2, Math.round(settings.radialSamples));
    for (let sample = 1; sample <= samples; sample += 1) {
      const radialWeight = heatDistanceWeight(sample, samples, settings.distanceFalloff);
      if (weight * radialWeight < MIN_HEAT_WEIGHT) continue;
      const distance = settings.maxDistanceM * sample / samples;
      // Rays converge at the station, so samples crowd together near it. Scaling
      // the density weight with distance keeps the heatmap from pooling there.
      const densityWeight = weight * radialWeight * (sample / samples);
      features.push({ type: 'Feature', properties: { layer: 'heatmap', weight: weight * radialWeight, densityWeight, bearing, bin, valueDb: values[bin] }, geometry: { type: 'Point', coordinates: destination(origin, bearing, distance) } });
    }
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Angular beam: one annular sector per bin and radial band. Colour and opacity
 * come from per-feature weights so palette, opacity, and intensity stay paint
 * properties and never force a geometry rebuild.
 */
export function beamFeatures(origin: GeoOrigin, values: number[], settings: DoaOverlaySettings, compassOffset = 0): FeatureCollection<Polygon> {
  const features: Feature<Polygon>[] = [];
  if (values.length !== 360) return { type: 'FeatureCollection', features };
  const bands = Math.max(2, Math.round(settings.radialSamples));
  // Shared vertex grid: edge e sits at bin e - 0.5, ring r at r/bands of the projection.
  const grid: Array<Array<[number, number]>> = [];
  for (let edge = 0; edge <= 360; edge += 1) {
    const row: Array<[number, number]> = [];
    const edgeBearing = geographicBearingForBin(edge - 0.5, compassOffset);
    for (let ring = 0; ring <= bands; ring += 1) row.push(ring === 0 ? [origin.longitude, origin.latitude] : destination(origin, edgeBearing, settings.maxDistanceM * ring / bands));
    grid.push(row);
  }
  for (let bin = 0; bin < 360; bin += 1) {
    const valueDb = values[bin];
    if (!Number.isFinite(valueDb) || valueDb < settings.thresholdDb) continue;
    const weight = normalizeDb(valueDb, settings.minDb, settings.maxDb, settings.contrast);
    if (weight <= 0) continue;
    for (let ring = 0; ring < bands; ring += 1) {
      const radial = heatDistanceWeight(ring + 0.5, bands, settings.distanceFalloff);
      if (weight * radial < MIN_HEAT_WEIGHT) continue;
      const inner = ring === 0
        ? [grid[bin][0]]
        : [grid[bin + 1][ring], grid[bin][ring]];
      const ringCoordinates = [grid[bin][ring + 1], grid[bin + 1][ring + 1], ...inner];
      ringCoordinates.push(ringCoordinates[0]);
      features.push({ type: 'Feature', properties: { layer: 'beam', weight, radial, bearing: geographicBearingForBin(bin, compassOffset), bin, valueDb }, geometry: { type: 'Polygon', coordinates: [ringCoordinates] } });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Round a ring spacing to 1, 2, 2.5, or 5 × 10^n metres so labels stay readable. */
export function niceRingStep(maxDistanceM: number, targetRings = 4): number {
  if (!Number.isFinite(maxDistanceM) || maxDistanceM <= 0) return 0;
  const raw = maxDistanceM / Math.max(1, targetRings);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

export interface RangeRing { distanceM: number; label: [number, number] }

/** Ground-distance rings around the station: a map scale, not a target range. */
export function rangeRings(origin: GeoOrigin, maxDistanceM: number): { features: FeatureCollection<LineString>; rings: RangeRing[] } {
  const step = niceRingStep(maxDistanceM);
  const features: Feature<LineString>[] = [];
  const rings: RangeRing[] = [];
  if (step <= 0) return { features: { type: 'FeatureCollection', features }, rings };
  for (let distance = step; distance <= maxDistanceM + step * 1e-6; distance += step) {
    const coordinates: [number, number][] = [];
    for (let angle = 0; angle <= 360; angle += 4) coordinates.push(destination(origin, angle, distance));
    features.push({ type: 'Feature', properties: { layer: 'ring', distanceM: distance }, geometry: { type: 'LineString', coordinates } });
    rings.push({ distanceM: distance, label: destination(origin, 135, distance) });
  }
  return { features: { type: 'FeatureCollection', features }, rings };
}

export interface HalfPowerWidth { widthDeg: number; startDeg: number; endDeg: number; peakIndex: number; peakDb: number }

/**
 * Contiguous width around the strongest bin where the shifted dB vector stays
 * within 3 dB of that peak. Relative to the displayed spectrum only; returns
 * null for incomplete vectors or when the whole circle is within 3 dB. The
 * start/end angles are in bin (theta_0) space, not geographic bearings.
 */
export function halfPowerWidth(values: number[]): HalfPowerWidth | null {
  if (values.length !== 360 || !values.every(Number.isFinite)) return null;
  const peakDb = Math.max(...values);
  const peakIndex = values.indexOf(peakDb);
  const floor = peakDb - 3;
  let left = 0;
  while (left < 359 && values[(peakIndex - left - 1 + 360) % 360] >= floor) left += 1;
  let right = 0;
  while (right < 359 && values[(peakIndex + right + 1) % 360] >= floor) right += 1;
  const widthDeg = left + right + 1;
  if (widthDeg >= 360) return null;
  return { widthDeg, startDeg: normalizeBearing(peakIndex - left - 0.5), endDeg: normalizeBearing(peakIndex + right + 0.5), peakIndex, peakDb };
}

/** Initial great-circle bearing and distance from origin to a point. */
export function bearingAndDistance(origin: GeoOrigin, longitude: number, latitude: number): { bearingDeg: number; distanceM: number } {
  const toRad = Math.PI / 180;
  const lat1 = origin.latitude * toRad;
  const lat2 = latitude * toRad;
  const deltaLon = (longitude - origin.longitude) * toRad;
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  const bearingDeg = normalizeBearing(Math.atan2(y, x) / toRad);
  const a = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  const distanceM = 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
  return { bearingDeg, distanceM };
}

export function edgeFeatures(origin: GeoOrigin, width: HalfPowerWidth | null, settings: DoaOverlaySettings, compassOffset = 0): FeatureCollection<LineString> {
  if (!width) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: [width.startDeg, width.endDeg].map((bin) => {
      const bearing = geographicBearingForBin(bin, compassOffset);
      return { type: 'Feature', properties: { layer: 'half-power-edge', bearing, bin }, geometry: { type: 'LineString', coordinates: [[origin.longitude, origin.latitude], destination(origin, bearing, settings.maxDistanceM)] } };
    }),
  };
}

export function emptyFeatures<T extends Point | LineString | Polygon>(): FeatureCollection<T> {
  return { type: 'FeatureCollection', features: [] };
}