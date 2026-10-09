import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap, GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import type { MapCoordinate, TelemetrySnapshot } from '../types';
import { getTileSets } from '../api';
import { loadBasemapChoice, resolveBasemap, saveBasemapChoice, type BasemapId, type BasemapSpec, type TileSet } from '../lib/basemaps';
import {
  DEFAULT_DOA_OVERLAY_SETTINGS,
  bearingAndDistance,
  bearingFeature,
  beamFeatures,
  destination,
  edgeFeatures,
  guideFeatures,
  halfPowerWidth,
  heatFeatures,
  lobeFeature,
  niceRingStep,
  rangeRings,
  type DoaOverlaySettings,
  type HalfPowerWidth,
  type RangeRing,
} from '../lib/doaGeometry';
import { loadOverlaySettings, saveOverlaySettings, validateOverlaySettings } from '../lib/mapOverlaySettings';
import { beamColorExpression, beamOpacityExpression, formatDistance, heatmapColorExpression, heatmapRadiusExpression } from '../lib/overlayPalette';
import { candidate, numberOrNull } from '../lib/telemetry';
import { useI18n } from '../lib/i18n';
import type { MessageKey } from '../lib/i18n';
import { coordinateSourceKey } from './DoaReadout';
import { BasemapMenu } from './BasemapMenu';
import { OverlayControls } from './OverlayControls';
import { OverlayLegend } from './OverlayLegend';
import { EmptyState, Icon } from './ui';

// MapLibre 6 looks for its worker next to its own module file. After bundling
// that file does not exist, so GeoJSON sources would never be parsed. Point it
// at the worker Vite builds; it is same-origin, so the CSP stays unchanged.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

type OverlayFeatureCollection = FeatureCollection<Point | LineString | Polygon>;
type MapState = 'initializing' | 'ready' | 'unavailable' | 'error';
const DEFAULT_ZOOM = 14;
const MAX_FRAMING_ZOOM = 17;
// Keep the framed overlay clear of the in-map toolbar (top) and zoom controls (right).
const FRAMING_PADDING = { top: 60, right: 56, bottom: 20, left: 20 };
const GEOMETRY_DEBOUNCE_MS = 120;
const SOURCE_IDS = ['doa-station', 'doa-beam', 'doa-heat', 'doa-rings', 'doa-guides', 'doa-lobe', 'doa-edges', 'doa-bearing'] as const;
type SourceId = typeof SOURCE_IDS[number];
const EMPTY: OverlayFeatureCollection = { type: 'FeatureCollection', features: [] };
const CARDINALS: ReadonlyArray<[MessageKey, number]> = [['map.cardinalN', 0], ['map.cardinalE', 90], ['map.cardinalS', 180], ['map.cardinalW', 270]];
// Basemaps where the default dark reference lines (rings, guides) would vanish.
const DARK_BASEMAPS = new Set<string>(['osm-dark', 'esri-imagery']);

function basemapSourceSpec(spec: BasemapSpec): maplibregl.RasterSourceSpecification {
  return { type: 'raster', tiles: spec.tiles, tileSize: 256, minzoom: spec.minzoom, maxzoom: spec.maxzoom, attribution: spec.attribution, ...(spec.bounds ? { bounds: spec.bounds } : {}) };
}

interface OverlayGeometry {
  data: Record<SourceId, OverlayFeatureCollection>;
  rings: RangeRing[];
  halfPower: HalfPowerWidth | null;
}

function pointFeature(coordinate: MapCoordinate | null): FeatureCollection<Point> {
  return coordinate ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { source: coordinate.source }, geometry: { type: 'Point', coordinates: [coordinate.longitude, coordinate.latitude] } }] } : { type: 'FeatureCollection', features: [] };
}

/** Camera bounds that show the whole projection radius around the station. */
function overlayBounds(coordinate: MapCoordinate, radiusM: number): [[number, number], [number, number]] {
  const reach = radiusM * 1.15;
  const north = destination(coordinate, 0, reach)[1];
  const south = destination(coordinate, 180, reach)[1];
  const east = destination(coordinate, 90, reach)[0];
  const west = destination(coordinate, 270, reach)[0];
  return [[west, south], [east, north]];
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function TacticalMap({
  coordinate,
  snapshot,
  localSnapshotFresh,
  overlay,
  overlayVisible = false,
  onToggleOverlay,
}: {
  coordinate: MapCoordinate | null;
  snapshot?: TelemetrySnapshot | null;
  localSnapshotFresh?: boolean;
  /** Floating panel drawn over the map (the DoA polar graph on the Dashboard). */
  overlay?: ReactNode;
  overlayVisible?: boolean;
  onToggleOverlay?: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [basemapId, setBasemapId] = useState<BasemapId>(() => loadBasemapChoice());
  const [tileSets, setTileSets] = useState<TileSet[]>([]);
  const appliedBasemapRef = useRef<string>('');
  const tileSetRequestRef = useRef<AbortController | null>(null);
  const refreshTileSets = useCallback(() => {
    tileSetRequestRef.current?.abort();
    const controller = new AbortController();
    tileSetRequestRef.current = controller;
    getTileSets(controller.signal).then((items) => { if (!controller.signal.aborted) setTileSets(items); }).catch(() => { /* offline basemaps are optional */ });
  }, []);
  useEffect(() => {
    refreshTileSets();
    return () => tileSetRequestRef.current?.abort();
  }, [refreshTileSets]);
  const basemap = useMemo(() => resolveBasemap(basemapId, tileSets, window.location.origin), [basemapId, tileSets]);
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const stationMarkerRef = useRef<maplibregl.Marker | null>(null);
  const stationPopupRef = useRef<maplibregl.Popup | null>(null);
  const centeredCoordinateRef = useRef<string | null>(null);
  const appliedDataRef = useRef<Partial<Record<SourceId, OverlayFeatureCollection>>>({});
  const coordinateRef = useRef(coordinate);
  const [mapState, setMapState] = useState<MapState>('initializing');
  const [styleReady, setStyleReady] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const overlayToggleRef = useRef<HTMLButtonElement>(null);
  const [settings, setSettings] = useState<DoaOverlaySettings>(() => loadOverlaySettings());
  // Sliders update paint properties immediately; geometry follows after a short pause.
  const g = useDebouncedValue(settings, GEOMETRY_DEBOUNCE_MS);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  coordinateRef.current = coordinate;

  const csv = candidate(snapshot ?? null, 'csv');
  const values = localSnapshotFresh !== false && Array.isArray(csv.angular_power_db) && csv.angular_power_db.length === 360 ? csv.angular_power_db : null;
  const canonicalAngle = numberOrNull(csv.canonical_angle_deg);
  // A bearing is only drawn or reported while its vector is fresh.
  const bearing = values ? canonicalAngle ?? numberOrNull(csv.angular_peak_index) : null;

  const geometry = useMemo<OverlayGeometry>(() => {
    const data: Record<SourceId, OverlayFeatureCollection> = {
      'doa-station': pointFeature(coordinate), 'doa-beam': EMPTY, 'doa-heat': EMPTY, 'doa-rings': EMPTY, 'doa-guides': EMPTY, 'doa-lobe': EMPTY, 'doa-edges': EMPTY, 'doa-bearing': EMPTY,
    };
    if (!coordinate) return { data, rings: [], halfPower: null };
    // Rings and guides are a ground-distance and orientation reference; they do not depend on DoA data.
    const ringSet = g.ringsVisible ? rangeRings(coordinate, g.maxDistanceM) : null;
    if (ringSet) data['doa-rings'] = ringSet.features;
    if (g.guidesVisible) data['doa-guides'] = guideFeatures(coordinate, g);
    if (!values || g.maxDb <= g.minDb) return { data, rings: ringSet?.rings ?? [], halfPower: null };
    const halfPower = halfPowerWidth(values);
    if (g.heatmapVisible && g.heatStyle === 'beam') data['doa-beam'] = beamFeatures(coordinate, values, g);
    if (g.heatmapVisible && g.heatStyle === 'density') data['doa-heat'] = heatFeatures(coordinate, values, g);
    if (g.lobeVisible) data['doa-lobe'] = { type: 'FeatureCollection', features: [lobeFeature(coordinate, values, g)] };
    if (g.bearingVisible && bearing !== null) data['doa-bearing'] = { type: 'FeatureCollection', features: [bearingFeature(coordinate, bearing, g)] };
    if (g.bearingVisible) data['doa-edges'] = edgeFeatures(coordinate, halfPower, g);
    return { data, rings: ringSet?.rings ?? [], halfPower };
    // Paint-only settings (palette, opacity, intensity, blur) are intentionally not dependencies.
  }, [coordinate, values, bearing, g.ringsVisible, g.guidesVisible, g.guideInterval, g.heatmapVisible, g.heatStyle, g.lobeVisible, g.bearingVisible, g.maxDistanceM, g.lobeDistanceM, g.minDb, g.maxDb, g.contrast, g.thresholdDb, g.radialSamples, g.distanceFalloff]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let disposed = false;
    // The first style uses the stored online choice; an MBTiles choice switches in
    // once the tile-set list has loaded.
    const initialBasemap = resolveBasemap(basemapId, [], window.location.origin);
    appliedBasemapRef.current = JSON.stringify(initialBasemap);
    const map = new maplibregl.Map({ container: host, center: coordinate ? [coordinate.longitude, coordinate.latitude] : [0, 0], zoom: coordinate ? DEFAULT_ZOOM : 2, minZoom: 1, maxZoom: 19, attributionControl: false, style: { version: 8, sources: { basemap: basemapSourceSpec(initialBasemap), ...Object.fromEntries(SOURCE_IDS.map((id) => [id, { type: 'geojson', data: EMPTY }])) }, layers: [
      { id: 'basemap', type: 'raster', source: 'basemap', paint: initialBasemap.paint },
      { id: 'doa-beam', type: 'fill', source: 'doa-beam', paint: { 'fill-antialias': false, 'fill-color': beamColorExpression(DEFAULT_DOA_OVERLAY_SETTINGS.heatPalette), 'fill-opacity': beamOpacityExpression(DEFAULT_DOA_OVERLAY_SETTINGS.heatOpacity, DEFAULT_DOA_OVERLAY_SETTINGS.heatIntensity) } },
      { id: 'doa-heat', type: 'heatmap', source: 'doa-heat', maxzoom: 20, paint: { 'heatmap-weight': ['coalesce', ['get', 'densityWeight'], ['get', 'weight'], 0], 'heatmap-intensity': 1, 'heatmap-radius': heatmapRadiusExpression(DEFAULT_DOA_OVERLAY_SETTINGS.heatBlur), 'heatmap-opacity': .72, 'heatmap-color': heatmapColorExpression(DEFAULT_DOA_OVERLAY_SETTINGS.heatPalette) } },
      { id: 'doa-rings', type: 'line', source: 'doa-rings', paint: { 'line-color': '#1f2d3a', 'line-opacity': .55, 'line-width': 1.2, 'line-dasharray': [4, 3] } },
      { id: 'doa-guides', type: 'line', source: 'doa-guides', paint: { 'line-color': '#34495c', 'line-opacity': .4, 'line-width': 1, 'line-dasharray': [2, 3] } },
      { id: 'doa-lobe-fill', type: 'fill', source: 'doa-lobe', paint: { 'fill-color': '#dca861', 'fill-opacity': .18 } },
      { id: 'doa-lobe-outline', type: 'line', source: 'doa-lobe', paint: { 'line-color': '#c98a2e', 'line-opacity': .9, 'line-width': 2 } },
      { id: 'doa-edges', type: 'line', source: 'doa-edges', paint: { 'line-color': '#e0603a', 'line-opacity': .75, 'line-width': 1.5, 'line-dasharray': [1, 2] } },
      { id: 'doa-bearing-casing', type: 'line', source: 'doa-bearing', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-opacity': .85, 'line-width': 6 } },
      { id: 'doa-bearing', type: 'line', source: 'doa-bearing', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#e0603a', 'line-opacity': .95, 'line-width': 3 } },
      { id: 'doa-station-halo', type: 'circle', source: 'doa-station', paint: { 'circle-radius': 12, 'circle-color': '#182027', 'circle-opacity': .8 } },
      { id: 'doa-station', type: 'circle', source: 'doa-station', paint: { 'circle-radius': 6, 'circle-color': '#ebbc70', 'circle-stroke-color': '#15181b', 'circle-stroke-width': 2 } },
    ] } });
    mapRef.current = map; setMapState('initializing');
    const onLoad = () => { if (!disposed) { setStyleReady(true); setMapState((state) => (state === 'error' ? state : 'ready')); } };
    const onError = (event: maplibregl.ErrorEvent) => {
      // A failed raster tile is a network/provider issue, not a failed MapLibre
      // renderer. Keep the map and DoA overlay usable while the alternate OSM
      // template is retried. Only initialization/style errors block the map.
      const sourceId = String((event as unknown as { sourceId?: string }).sourceId ?? '');
      const message = String(event.error?.message ?? '').toLowerCase();
      const isRasterTileIssue = sourceId === 'basemap' || message.includes('tile') || message.includes('raster');
      if (!disposed && !isRasterTileIssue) setMapState('error');
    };
    // 'load' waits for every source, including raster tiles, so it may never fire
    // when OSM is unreachable. The overlay only needs the parsed style and its
    // GeoJSON sources, which 'styledata' reports as soon as they exist.
    const onStyleData = () => { if (map.getSource('doa-station')) { map.off('styledata', onStyleData); onLoad(); } };
    map.on('styledata', onStyleData); map.on('error', onError); map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');
    return () => { disposed = true; map.off('styledata', onStyleData); map.off('error', onError); stationPopupRef.current?.remove(); stationPopupRef.current = null; stationMarkerRef.current?.remove(); stationMarkerRef.current = null; appliedDataRef.current = {}; map.remove(); mapRef.current = null; };
    // The map instance lives for the component lifetime; data arrives through setData.
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const map = mapRef.current;
    if (!host || !map || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(host);
    return () => observer.disconnect();
  }, [mapState]);

  // Basemap switch: swap the raster source and layer underneath the overlay.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    const key = JSON.stringify(basemap);
    if (appliedBasemapRef.current !== key) {
      if (map.getLayer('basemap')) map.removeLayer('basemap');
      if (map.getSource('basemap')) map.removeSource('basemap');
      map.addSource('basemap', basemapSourceSpec(basemap));
      map.addLayer({ id: 'basemap', type: 'raster', source: 'basemap', paint: basemap.paint }, 'doa-beam');
      appliedBasemapRef.current = key;
    }
    const onDark = DARK_BASEMAPS.has(basemap.id);
    map.setPaintProperty('doa-rings', 'line-color', onDark ? '#e8eef3' : '#1f2d3a');
    map.setPaintProperty('doa-rings', 'line-opacity', onDark ? .7 : .55);
    map.setPaintProperty('doa-guides', 'line-color', onDark ? '#d5dee6' : '#34495c');
    map.setPaintProperty('doa-guides', 'line-opacity', onDark ? .55 : .4);
  }, [styleReady, basemap]);

  const chooseBasemap = (id: BasemapId) => {
    setBasemapId(id);
    saveBasemapChoice(id);
  };

  // Push only the sources whose collections changed since the last update.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    for (const id of SOURCE_IDS) {
      const next = geometry.data[id];
      if (appliedDataRef.current[id] === next) continue;
      (map.getSource(id) as GeoJSONSource | undefined)?.setData(next);
      appliedDataRef.current[id] = next;
    }
  }, [styleReady, geometry]);

  // Visibility and paint properties never rebuild geometry.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    const setVisibility = (id: string, visible: boolean) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    };
    setVisibility('doa-beam', settings.heatmapVisible && settings.heatStyle === 'beam');
    setVisibility('doa-heat', settings.heatmapVisible && settings.heatStyle === 'density');
    setVisibility('doa-rings', settings.ringsVisible);
    setVisibility('doa-guides', settings.guidesVisible);
    setVisibility('doa-lobe-fill', settings.lobeVisible);
    setVisibility('doa-lobe-outline', settings.lobeVisible);
    setVisibility('doa-edges', settings.bearingVisible);
    setVisibility('doa-bearing-casing', settings.bearingVisible);
    setVisibility('doa-bearing', settings.bearingVisible);
    map.setPaintProperty('doa-beam', 'fill-color', beamColorExpression(settings.heatPalette));
    map.setPaintProperty('doa-beam', 'fill-opacity', beamOpacityExpression(settings.heatOpacity, settings.heatIntensity));
    map.setPaintProperty('doa-heat', 'heatmap-color', heatmapColorExpression(settings.heatPalette));
    map.setPaintProperty('doa-heat', 'heatmap-radius', heatmapRadiusExpression(settings.heatBlur));
    map.setPaintProperty('doa-heat', 'heatmap-opacity', settings.heatOpacity);
    map.setPaintProperty('doa-heat', 'heatmap-intensity', settings.heatIntensity);
    map.setPaintProperty('doa-lobe-fill', 'fill-opacity', settings.lobeOpacity);
  }, [styleReady, settings.heatmapVisible, settings.heatStyle, settings.ringsVisible, settings.guidesVisible, settings.lobeVisible, settings.bearingVisible, settings.heatPalette, settings.heatOpacity, settings.heatIntensity, settings.heatBlur, settings.lobeOpacity]);

  // Station marker, popup, and first-fix camera.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    if (!coordinate) {
      stationPopupRef.current?.remove();
      stationPopupRef.current = null;
      stationMarkerRef.current?.remove();
      stationMarkerRef.current = null;
      centeredCoordinateRef.current = null;
      return;
    }
    if (centeredCoordinateRef.current === null) {
      map.fitBounds(overlayBounds(coordinate, Math.max(settingsRef.current.maxDistanceM, settingsRef.current.lobeDistanceM)), { padding: FRAMING_PADDING, maxZoom: MAX_FRAMING_ZOOM, duration: 0 });
      centeredCoordinateRef.current = `${coordinate.latitude.toFixed(7)},${coordinate.longitude.toFixed(7)}`;
    }
    if (!stationMarkerRef.current) {
      const markerElement = document.createElement('button');
      markerElement.type = 'button';
      markerElement.className = 'doa-station-marker';
      const popup = new maplibregl.Popup({ offset: 18, closeButton: true, closeOnClick: false, className: 'doa-station-popup' });
      stationPopupRef.current = popup;
      stationMarkerRef.current = new maplibregl.Marker({ element: markerElement, anchor: 'center' }).setPopup(popup).setLngLat([coordinate.longitude, coordinate.latitude]).addTo(map);
    }
    const markerElement = stationMarkerRef.current.getElement();
    markerElement.setAttribute('aria-label', t('map.stationAria', { lat: coordinate.latitude.toFixed(6), lon: coordinate.longitude.toFixed(6) }));
    markerElement.setAttribute('title', t('map.stationTitle'));
    // Popup text comes only from the static dictionary, internal enums, and formatted numbers.
    stationPopupRef.current?.setLngLat([coordinate.longitude, coordinate.latitude]).setHTML(
      `<div class="station-popup-content"><dl><dt>${t('map.popupSource')}</dt><dd>${coordinate.source}</dd><dt>${t('map.popupPosition')}</dt><dd>${coordinate.latitude.toFixed(6)}°, ${coordinate.longitude.toFixed(6)}°</dd><dt>${t('map.popupBearing')}</dt><dd>${bearing === null ? t('map.popupUnavailable') : `${bearing.toFixed(1)}°`}</dd><dt>${t('map.popupHalfPower')}</dt><dd>${geometry.halfPower ? `${geometry.halfPower.widthDeg}°` : t('map.popupUnavailable')}</dd><dt>${t('map.popupVector')}</dt><dd>${values ? t('map.popupBins') : t('map.popupUnavailable')}</dd></dl><small>${t('map.popupNote')}</small></div>`,
    );
    stationMarkerRef.current.setLngLat([coordinate.longitude, coordinate.latitude]);
  }, [styleReady, coordinate, bearing, values, geometry.halfPower, t]);

  // Text labels as DOM markers: the inline style has no glyph source, and the
  // CSP keeps the console from fetching remote fonts for symbol layers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !coordinate) return undefined;
    const markers: maplibregl.Marker[] = [];
    const add = (lngLat: [number, number], className: string, text: string) => {
      const element = document.createElement('div');
      element.className = `doa-map-label ${className}`;
      element.textContent = text;
      element.setAttribute('aria-hidden', 'true');
      markers.push(new maplibregl.Marker({ element, anchor: 'center' }).setLngLat(lngLat).addTo(map));
    };
    if (g.ringsVisible && geometry.rings.length) {
      for (const ring of geometry.rings) add(ring.label, 'doa-ring-label', formatDistance(ring.distanceM));
      const outer = geometry.rings[geometry.rings.length - 1].distanceM * 1.12;
      for (const [key, angle] of CARDINALS) add(destination(coordinate, angle, outer), 'doa-cardinal-label', t(key));
    }
    if (g.bearingVisible && bearing !== null) add(destination(coordinate, bearing, g.maxDistanceM * 1.1), 'doa-bearing-label', `${bearing.toFixed(1)}°`);
    return () => { for (const marker of markers) marker.remove(); };
  }, [styleReady, coordinate, geometry.rings, bearing, g.ringsVisible, g.bearingVisible, g.maxDistanceM, t]);

  // Hover (or tap) readout: bearing bin, its shifted dB value, and ground distance from the station.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !coordinate || !values || !(settings.heatmapVisible || settings.lobeVisible)) return undefined;
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'doa-hover-popup', offset: 14, maxWidth: '260px' });
    const radius = Math.max(g.maxDistanceM, g.lobeDistanceM) * 1.02;
    let frame = 0;
    let pending: maplibregl.LngLat | null = null;
    let dragging = false;
    const render = () => {
      frame = 0;
      if (!pending || dragging) return;
      const { bearingDeg, distanceM } = bearingAndDistance(coordinate, pending.lng, pending.lat);
      if (distanceM > radius || distanceM < 1) { popup.remove(); return; }
      const bin = Math.round(bearingDeg) % 360;
      popup.setLngLat(pending).setHTML(`<strong>${t('map.hoverBearing', { deg: bin, db: values[bin].toFixed(1) })}</strong><span>${t('map.hoverDistance', { distance: formatDistance(distanceM) })}</span><small>${t('map.hoverNote')}</small>`);
      if (!popup.isOpen()) popup.addTo(map);
    };
    const onMove = (event: MapMouseEvent) => {
      pending = event.lngLat;
      if (!frame) frame = window.requestAnimationFrame(render);
    };
    const hide = () => { pending = null; popup.remove(); };
    const onDragStart = () => { dragging = true; hide(); };
    const onDragEnd = () => { dragging = false; };
    const canvas = map.getCanvas();
    map.on('mousemove', onMove);
    map.on('click', onMove);
    map.on('dragstart', onDragStart);
    map.on('dragend', onDragEnd);
    canvas.addEventListener('mouseleave', hide);
    return () => {
      window.cancelAnimationFrame(frame);
      map.off('mousemove', onMove);
      map.off('click', onMove);
      map.off('dragstart', onDragStart);
      map.off('dragend', onDragEnd);
      canvas.removeEventListener('mouseleave', hide);
      popup.remove();
    };
  }, [styleReady, coordinate, values, settings.heatmapVisible, settings.lobeVisible, g.maxDistanceM, g.lobeDistanceM, t]);

  // Canvas fallback, used only when MapLibre reports a non-tile error and its
  // GL layers may not be drawing. It keeps the direction helper (guides, lobe,
  // bearing, station) visible; the heat layer is not reproduced here.
  const glFailed = mapState === 'error';
  useEffect(() => {
    const map = mapRef.current;
    const canvas = overlayCanvasRef.current;
    const host = hostRef.current;
    if (!map || !canvas || !host || !glFailed) return undefined;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const rect = host.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      if (!coordinate) return;
      const project = ([longitude, latitude]: number[]) => map.project([longitude, latitude]);
      const strokeLines = (collection: OverlayFeatureCollection, style: string, width: number, dash: number[]) => {
        context.save(); context.strokeStyle = style; context.lineWidth = width; context.setLineDash(dash);
        for (const feature of collection.features as Feature<LineString>[]) {
          context.beginPath();
          feature.geometry.coordinates.forEach((position, index) => { const point = project(position); if (index) context.lineTo(point.x, point.y); else context.moveTo(point.x, point.y); });
          context.stroke();
        }
        context.restore();
      };
      if (settings.guidesVisible) strokeLines(geometry.data['doa-guides'], 'rgba(52,73,92,.5)', 1, [5, 6]);
      const lobe = geometry.data['doa-lobe'].features[0] as Feature<Polygon> | undefined;
      if (settings.lobeVisible && lobe) {
        context.save(); context.beginPath();
        lobe.geometry.coordinates[0].forEach((position, index) => { const point = project(position); if (index) context.lineTo(point.x, point.y); else context.moveTo(point.x, point.y); });
        context.closePath(); context.fillStyle = `rgba(235,188,112,${settings.lobeOpacity})`; context.fill();
        context.strokeStyle = 'rgba(201,138,46,.92)'; context.lineWidth = 2; context.stroke(); context.restore();
      }
      if (settings.bearingVisible) strokeLines(geometry.data['doa-bearing'], '#e0603a', 3, [9, 5]);
      const origin = map.project([coordinate.longitude, coordinate.latitude]);
      context.save(); context.fillStyle = '#ebbc70'; context.strokeStyle = '#172027'; context.lineWidth = 3;
      context.beginPath(); context.arc(origin.x, origin.y, 7, 0, Math.PI * 2); context.fill(); context.stroke(); context.restore();
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(draw); };
    schedule();
    map.on('move', schedule); map.on('resize', schedule);
    return () => { window.cancelAnimationFrame(frame); map.off('move', schedule); map.off('resize', schedule); const context = canvas.getContext('2d'); context?.clearRect(0, 0, canvas.width, canvas.height); };
  }, [glFailed, coordinate, geometry, settings.guidesVisible, settings.lobeVisible, settings.bearingVisible, settings.lobeOpacity]);

  const updateSettings = (next: DoaOverlaySettings) => {
    const valid = validateOverlaySettings(next);
    setSettings(valid);
    saveOverlaySettings(valid);
  };
  const closeControls = () => {
    setControlsOpen(false);
    overlayToggleRef.current?.focus();
  };

  const resetView = () => {
    const current = coordinateRef.current;
    const map = mapRef.current;
    if (!current || !map) return;
    centeredCoordinateRef.current = `${current.latitude.toFixed(7)},${current.longitude.toFixed(7)}`;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    map.easeTo({ bearing: 0, pitch: 0, duration: 0 });
    map.fitBounds(overlayBounds(current, Math.max(settings.maxDistanceM, settings.lobeDistanceM)), { padding: FRAMING_PADDING, maxZoom: MAX_FRAMING_ZOOM, duration: reduced ? 0 : 350 });
  };
  const dataLabel = values ? t('map.vectorReady', { bearing: bearing === null ? t('map.bearingUnavailable') : t('map.bearingReference', { deg: bearing.toFixed(0) }) }) : t('map.noVector');
  return <section className="panel map-panel">
    <div className={`map-workspace${controlsOpen ? ' map-workspace-settings-open' : ''}`}>
      {controlsOpen ? <OverlayControls settings={settings} onChange={updateSettings} onReset={() => updateSettings(DEFAULT_DOA_OVERLAY_SETTINGS)} onClose={closeControls} /> : null}
      <div className="map-frame" role="application" aria-label={t('map.appAria')} tabIndex={-1} data-route-focus>
        <div className="maplibre-host" ref={hostRef} />
        <canvas ref={overlayCanvasRef} className="doa-overlay-canvas" aria-hidden="true" hidden={!glFailed} />
        <div className="map-toolbar">
          <button ref={overlayToggleRef} className="toolbar-button map-settings-button" type="button" onClick={() => setControlsOpen((open) => !open)} aria-expanded={controlsOpen} aria-controls={controlsOpen ? 'doa-overlay-controls' : undefined}><Icon name="layers" /><span>{t('map.layers')}</span></button>
          <BasemapMenu value={basemap.id} tileSets={tileSets} onChange={chooseBasemap} onOpen={refreshTileSets} />
          {coordinate ? <button className="toolbar-button map-reset-button" type="button" onClick={resetView} aria-label={t('map.centerAria')} title={t('map.centerAria')}><Icon name="crosshair" /><span>{t('map.center')}</span></button> : null}
          {onToggleOverlay ? <button className="toolbar-button map-polar-toggle" type="button" onClick={onToggleOverlay} aria-pressed={overlayVisible} aria-controls={overlayVisible ? 'dashboard-polar-overlay' : undefined}><Icon name="polar" /><span>{overlayVisible ? t('dashboard.hidePolar') : t('dashboard.showPolar')}</span></button> : null}
        </div>
        {overlay && overlayVisible ? <div id="dashboard-polar-overlay" className="map-polar-overlay">{overlay}</div> : null}
        {coordinate && !values ? <div className="map-data-chip" role="status">{t('map.overlayCleared')}</div> : null}
        <span className="map-attribution" aria-label={t('map.attributionAria')}>{basemap.attribution}</span>
        {mapState === 'unavailable' || !coordinate ? <div className="map-empty-wrap"><EmptyState label={t('map.unavailable')} detail={t('map.unavailableDetail')} tone="warn" /></div> : null}
        {mapState === 'error' ? <div className="map-empty-wrap"><EmptyState label={t('map.basemapUnavailable')} detail={t('map.basemapUnavailableDetail')} tone="warn" /></div> : null}
      </div>
      <div className="map-bottom-overlay">
        <OverlayLegend settings={settings} ringStepM={niceRingStep(settings.maxDistanceM)} halfPower={geometry.halfPower} />
        {coordinate ? <div className="map-coordinate" aria-label={t('map.coordinatesAria')}><span>{t(coordinateSourceKey(coordinate.source))}</span><strong>{coordinate.latitude.toFixed(6)}°, {coordinate.longitude.toFixed(6)}°</strong><small>{dataLabel}</small></div> : null}
      </div>
    </div>
  </section>;
}
