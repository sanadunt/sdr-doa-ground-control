import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';

const EARTH_RADIUS_M = 6_371_000;

export interface DoaOverlaySettings {
  lobeVisible: boolean;
  bearingVisible: boolean;
  heatmapVisible: boolean;
  guidesVisible: boolean;
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

export function destination(origin: GeoOrigin, bearingDeg: number, distanceM: number): [number, number] {
  const angular = distanceM / EARTH_RADIUS_M;
  const bearing = normalizeBearing(bearingDeg) * Math.PI / 180;
  const latitude = origin.latitude * Math.PI / 180;
  const resultLat = Math.asin(Math.sin(latitude) * Math.cos(angular) + Math.cos(latitude) * Math.sin(angular) * Math.cos(bearing));
  const deltaLon = Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(latitude), Math.cos(angular) - Math.sin(latitude) * Math.sin(resultLat));
  const longitude = origin.longitude + deltaLon * 180 / Math.PI;
  return [((longitude + 540) % 360) - 180, resultLat * 180 / Math.PI];
}

export function normalizeDb(value: number, minDb: number, maxDb: number, contrast = 1): number {
  if (!Number.isFinite(value) || !Number.isFinite(minDb) || !Number.isFinite(maxDb) || maxDb <= minDb) return 0;
  return Math.max(0, Math.min(1, ((value - minDb) / (maxDb - minDb)) ** Math.max(0.25, contrast)));
}

export function heatDistanceWeight(sample: number, samples: number, falloff: number): number {
  const progress = Math.max(0, Math.min(1, sample / Math.max(1, samples)));
  return Math.max(0, (1 - progress * Math.max(0, Math.min(1, falloff))) * (1 - progress * .18));
}

export function lobeFeature(origin: GeoOrigin, values: number[], settings: DoaOverlaySettings): Feature<Polygon> {
  const coordinates: [number, number][] = [[origin.longitude, origin.latitude]];
  for (let bin = 0; bin < 360; bin += 1) {
    coordinates.push(destination(origin, bin, settings.lobeDistanceM * normalizeDb(values[bin] ?? settings.minDb, settings.minDb, settings.maxDb, settings.contrast)));
  }
  coordinates.push(coordinates[1]);
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

export function heatFeatures(origin: GeoOrigin, values: number[], settings: DoaOverlaySettings, samplesPerRay = 8): FeatureCollection<Point> {
  const features: Feature<Point>[] = [];
  const step = Math.max(1, Math.floor(360 / Math.max(1, values.length)));
  for (let bin = 0; bin < 360; bin += step) {
    const weight = normalizeDb(values[bin] ?? settings.minDb, settings.minDb, settings.maxDb, settings.contrast);
    if (weight <= 0) continue;
    if ((values[bin] ?? settings.minDb) < settings.thresholdDb) continue;
    const samples = Math.max(2, Math.round(settings.radialSamples ?? samplesPerRay));
    for (let sample = 1; sample <= samples; sample += 1) {
      const distance = settings.maxDistanceM * sample / samples;
      const radialWeight = heatDistanceWeight(sample, samples, settings.distanceFalloff);
      features.push({ type: 'Feature', properties: { layer: 'heatmap', weight: weight * radialWeight, bearing: bin, valueDb: values[bin] }, geometry: { type: 'Point', coordinates: destination(origin, bin, distance) } });
    }
  }
  return { type: 'FeatureCollection', features };
}

export function emptyFeatures<T extends Point | LineString | Polygon>(): FeatureCollection<T> {
  return { type: 'FeatureCollection', features: [] };
}