import { Component, Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, JSX, ReactNode } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap, GeoJSONSource, MapMouseEvent, MapSourceDataEvent, RasterTileSource } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import type { GpsSourceMode, MapCoordinate, TelemetrySnapshot } from '../types';
import { basemapAfterTile, basemapAfterView, basemapNotice, basemapPaint, basemapPartialCheck, gpsReportsNoFix, holdStationCoordinate, nextBasemapHost, resumeBasemapHealth, shouldReframeStation, type BasemapHealth, type BasemapNotice, type StationFraming } from '../lib/map';
import { BASEMAPS, DEFAULT_BASEMAP_ID, basemapBaseSource, basemapRasterLayers, basemapSourceId, isBasemapSourceId, type BasemapId, type TileSourceId } from '../lib/basemaps';
import { MAP_CONTROLS_ROW_PX, ZERO_INSETS, clampMapPadding, controlsFramingBottom, type MapInsets } from '../lib/mapInsets';
import {
  DEFAULT_DOA_OVERLAY_SETTINGS,
  EARTH_RADIUS_M,
  bearingAndDistance,
  bearingFeature,
  beamFeatures,
  destination,
  edgeFeatures,
  effectiveDbScale,
  guideFeatures,
  halfPowerWidth,
  heatFeatures,
  lobeFeature,
  niceRingStep,
  rangeRings,
  saturatedFraction,
  type DoaOverlaySettings,
  type HalfPowerWidth,
  type RangeRing,
} from '../lib/doaGeometry';
import { geographicBearingForBin } from '../lib/polar';
import { beamColorExpression, beamOpacityExpression, formatBearing, formatDistance, heatmapColorExpression, heatmapRadiusExpression } from '../lib/overlayPalette';
import { numberOrNull, primaryCandidate } from '../lib/telemetry';
import { isMqttSnapshot } from '../lib/telemetrySource';
import { useI18n } from '../lib/i18n';
import type { MessageKey, Translate } from '../lib/i18n';
import { coordinateSourceKey } from './DoaReadout';
import { OverlayLegend } from './OverlayLegend';
import { EmptyState, Icon } from './ui';
import { BasemapMenu } from './overview/BasemapPicker';

// MapLibre 6 looks for its worker next to its own module file. After bundling
// that file does not exist, so GeoJSON sources would never be parsed. Point it
// at the worker Vite builds; it is same-origin, so the CSP stays unchanged.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

type OverlayFeatureCollection = FeatureCollection<Point | LineString | Polygon>;
/**
 * 'no-webgl': MapLibre could not start. 'gl-lost': the WebGL context was lost.
 * 'worker-stalled': GeoJSON sources never came back from the worker.
 * 'error': MapLibre reported a non-tile error. All four draw the canvas fallback.
 */
type MapState = 'initializing' | 'ready' | 'no-webgl' | 'gl-lost' | 'worker-stalled' | 'error';
const FALLBACK_STATES: ReadonlySet<MapState> = new Set(['no-webgl', 'gl-lost', 'worker-stalled', 'error']);
const DEFAULT_ZOOM = 14;
const MAX_FRAMING_ZOOM = 17;
// Keep the framed overlay clear of the map controls (bottom-left row, 44 px
// plus its 12 px margin). framingPadding grows the top to clear the notices
// and the bottom to clear the controls when they wrap onto a second row; the
// floating dashboard panels are handled by the map padding (insets).
const FRAMING_PADDING = { top: 24, right: 24, bottom: controlsFramingBottom(MAP_CONTROLS_ROW_PX), left: 24 };
const NOTICE_CLEARANCE_PX = 8;
const GEOMETRY_DEBOUNCE_MS = 120;
const WORKER_WATCHDOG_MS = 10_000;
const BASEMAP_CHECK_MS = 20_000;
const BASEMAP_RETRY_MS = 60_000;
// The console's tile route tries each upstream's hosts; the browser has one URL per source.
const BASEMAP_HOSTS = 1;
const SOURCE_IDS = ['doa-station', 'doa-beam', 'doa-heat', 'doa-rings', 'doa-guides', 'doa-lobe', 'doa-edges', 'doa-bearing'] as const;
type SourceId = typeof SOURCE_IDS[number];
const SOURCE_ID_SET: ReadonlySet<string> = new Set(SOURCE_IDS);
const EMPTY: OverlayFeatureCollection = { type: 'FeatureCollection', features: [] };
const CARDINALS: ReadonlyArray<[MessageKey, number]> = [['map.cardinalN', 0], ['map.cardinalE', 90], ['map.cardinalS', 180], ['map.cardinalW', 270]];
// Base opacity of each line layer at overlay opacity 1, as set in the style below.
const LINE_LAYER_OPACITY: ReadonlyArray<[string, 'line-opacity', number]> = [
  ['doa-rings', 'line-opacity', .55],
  ['doa-guides', 'line-opacity', .4],
  ['doa-lobe-outline', 'line-opacity', .9],
  ['doa-edges', 'line-opacity', .75],
  ['doa-bearing-casing', 'line-opacity', .85],
  ['doa-bearing', 'line-opacity', .95],
];

interface CameraMemory {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  framing: StationFraming | null;
  operatorMoved: boolean;
}

// Per page session: the map is unmounted on every route change, so the
// operator's camera and the last live station fix are kept here and restored
// when Overview opens again.
let cameraMemory: CameraMemory | null = null;
let lastLiveStation: MapCoordinate | null = null;
// Basemap outages seen earlier, per tile source, so a known outage shows its
// notice at once when the map mounts again or the operator returns to a style.
const basemapMemory: Partial<Record<TileSourceId, BasemapHealth>> = {};

function basemapHealthFor(source: TileSourceId | null): BasemapHealth {
  return resumeBasemapHealth(source ? basemapMemory[source] ?? null : null, 0, BASEMAP_HOSTS);
}

/**
 * Whether the map draws any tile of a raster source in the current view,
 * fallback parents and children included; null when MapLibre cannot tell.
 */
function rasterSourceDrawn(map: MapLibreMap, sourceId: string): boolean | null {
  try {
    const ids: unknown = map.style?.tileManagers?.[sourceId]?.getRenderableIds();
    return Array.isArray(ids) ? ids.length > 0 : null;
  } catch {
    return null;
  }
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function consoleTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
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

function stationInView(map: MapLibreMap, coordinate: MapCoordinate): boolean {
  try {
    return map.getBounds().contains([coordinate.longitude, coordinate.latitude]);
  } catch {
    return false;
  }
}

function mapLocale(t: Translate): Record<string, string> {
  return {
    'NavigationControl.ZoomIn': t('map.ctrlZoomIn'),
    'NavigationControl.ZoomOut': t('map.ctrlZoomOut'),
    'NavigationControl.ResetBearing': t('map.ctrlResetBearing'),
    'Popup.Close': t('map.ctrlPopupClose'),
    'Map.Title': t('map.ctrlMapTitle'),
    'Marker.Title': t('map.ctrlMarkerTitle'),
  };
}

type Projector = (position: number[]) => { x: number; y: number };

/** Local north-up projection for the canvas fallback when there is no MapLibre map at all. */
function localProjector(origin: MapCoordinate, radiusM: number, width: number, height: number): Projector {
  const metresPerDegree = EARTH_RADIUS_M * Math.PI / 180;
  const lonScale = metresPerDegree * Math.cos(origin.latitude * Math.PI / 180);
  const pixelsPerMetre = Math.max(1e-6, (Math.min(width, height) / 2 - 30) / Math.max(1, radiusM));
  return ([longitude, latitude]) => ({
    x: width / 2 + (longitude - origin.longitude) * lonScale * pixelsPerMetre,
    y: height / 2 - (latitude - origin.latitude) * metresPerDegree * pixelsPerMetre,
  });
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface TacticalMapProps {
  coordinate: MapCoordinate | null;
  snapshot?: TelemetrySnapshot | null;
  localSnapshotFresh?: boolean;
  /** Compass offset applied to every theta_0 bin on the map; 0 in simulation. */
  compassOffset?: number;
  /** False when the offset is a local fallback rather than reported or entered; bearings are then a reference only. */
  orientationVerified?: boolean;
  /** Selected GPS source. Only a DATA_OUT selection holds the last live fix through a freshness gap. */
  gpsSource?: GpsSourceMode;
  /** Single gate for DoA geometry, applied on top of vector freshness. */
  doaReady?: boolean;
  /** Untranslated DoA status code while doaReady is false, e.g. CONFLICT. */
  doaHeldCode?: string;
  /** Translated cause while doaReady is false; the map names it instead of a generic vector notice. */
  doaHeldText?: string;
  /** Overlay layers, opacity and scale; owned and persisted by the Overview page (Layers panel). */
  overlaySettings?: DoaOverlaySettings;
  /** Space the floating dashboard panels take from the map; it moves the framing, not the canvas. */
  insets?: MapInsets;
  /** Basemap style; owned and persisted by the Overview page. */
  basemapId?: BasemapId;
  /** Shows the basemap button in the map controls when set. */
  onBasemapSelect?: (id: BasemapId) => void;
}

function TacticalMapView({ coordinate, snapshot, localSnapshotFresh, compassOffset = 0, orientationVerified = true, gpsSource = 'DATA_OUT', doaReady = true, doaHeldCode, doaHeldText, overlaySettings = DEFAULT_DOA_OVERLAY_SETTINGS, insets = ZERO_INSETS, basemapId = DEFAULT_BASEMAP_ID, onBasemapSelect }: TacticalMapProps): JSX.Element {
  const { t, lang } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const stationMarkerRef = useRef<maplibregl.Marker | null>(null);
  const stationPopupRef = useRef<maplibregl.Popup | null>(null);
  const framingRef = useRef<StationFraming | null>(null);
  const operatorMovedRef = useRef(false);
  const styleReadyRef = useRef(false);
  const appliedDataRef = useRef<Partial<Record<SourceId, OverlayFeatureCollection>>>({});
  const [mapState, setMapState] = useState<MapState>('initializing');
  const [styleReady, setStyleReady] = useState(false);
  // The style the map draws; it follows basemapId once the style is ready.
  const [activeBasemap, setActiveBasemap] = useState<BasemapId>(basemapId);
  const [basemapStatus, setBasemapStatus] = useState<BasemapNotice>(() => basemapNotice(basemapHealthFor(basemapBaseSource(basemapId))));
  const [tilesLoaded, setTilesLoaded] = useState(false);
  const [theme, setTheme] = useState(consoleTheme);
  const noticesRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const settings = overlaySettings;
  // Sliders update paint properties immediately; geometry follows after a short pause.
  const g = useDebouncedValue(settings, GEOMETRY_DEBOUNCE_MS);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const basemapIdRef = useRef(basemapId);
  basemapIdRef.current = basemapId;
  const selectBasemapRef = useRef<((id: BasemapId) => void) | null>(null);
  const tone = BASEMAPS[activeBasemap].tone;
  const insetsRef = useRef(insets);
  insetsRef.current = insets;

  const fresh = localSnapshotFresh !== false;
  const noFixReported = gpsReportsNoFix(snapshot, fresh);
  const station = useMemo(() => holdStationCoordinate(lastLiveStation, coordinate, noFixReported, gpsSource), [coordinate, noFixReported, gpsSource]);
  useEffect(() => { lastLiveStation = station.lastLive; }, [station.lastLive]);
  const stationCoordinate = station.coordinate;
  const coordinateRef = useRef(stationCoordinate);
  coordinateRef.current = stationCoordinate;

  const csv = primaryCandidate(snapshot ?? null);
  const simulation = snapshot?.simulation === true;
  const values = doaReady && fresh && Array.isArray(csv.angular_power_db) && csv.angular_power_db.length === 360 ? csv.angular_power_db : null;
  const offset = Number.isFinite(compassOffset) ? compassOffset : 0;
  // theta_0 is the array-frame angle; only its geographic bearing is drawn or reported.
  // An MQTT DoA is shown without its Angular vector between frames: the
  // bearing line stays, the beam, lobe and edges need the vector.
  const theta = doaReady && fresh && (values || isMqttSnapshot(snapshot)) ? numberOrNull(csv.canonical_angle_deg) : null;
  const bearing = theta === null ? null : geographicBearingForBin(theta, offset);
  // Only the scale fields matter here; depending on all of g would rebuild geometry on paint-only changes.
  const scale = useMemo(() => effectiveDbScale(values, g, simulation), [values, simulation, g.dbScale, g.minDb, g.maxDb, g.thresholdDb]);
  const saturation = useMemo(() => saturatedFraction(values, scale.maxDb), [values, scale.maxDb]);

  const geometry = useMemo<OverlayGeometry>(() => {
    const data: Record<SourceId, OverlayFeatureCollection> = {
      'doa-station': pointFeature(stationCoordinate), 'doa-beam': EMPTY, 'doa-heat': EMPTY, 'doa-rings': EMPTY, 'doa-guides': EMPTY, 'doa-lobe': EMPTY, 'doa-edges': EMPTY, 'doa-bearing': EMPTY,
    };
    if (!stationCoordinate) return { data, rings: [], halfPower: null };
    // Rings and guides are a ground-distance and orientation reference; they do not depend on DoA data.
    const ringSet = g.ringsVisible ? rangeRings(stationCoordinate, g.maxDistanceM) : null;
    if (ringSet) data['doa-rings'] = ringSet.features;
    if (g.guidesVisible) data['doa-guides'] = guideFeatures(stationCoordinate, g);
    const draw: DoaOverlaySettings = { ...g, minDb: scale.minDb, maxDb: scale.maxDb, thresholdDb: scale.thresholdDb };
    if (!values) {
      if (g.bearingVisible && bearing !== null) data['doa-bearing'] = { type: 'FeatureCollection', features: [bearingFeature(stationCoordinate, bearing, draw)] };
      return { data, rings: ringSet?.rings ?? [], halfPower: null };
    }
    if (draw.maxDb <= draw.minDb) return { data, rings: ringSet?.rings ?? [], halfPower: null };
    const halfPower = halfPowerWidth(values);
    if (g.heatmapVisible && g.heatStyle === 'beam') data['doa-beam'] = beamFeatures(stationCoordinate, values, draw, offset);
    if (g.heatmapVisible && g.heatStyle === 'density') data['doa-heat'] = heatFeatures(stationCoordinate, values, draw, offset);
    if (g.lobeVisible) data['doa-lobe'] = { type: 'FeatureCollection', features: [lobeFeature(stationCoordinate, values, draw, offset)] };
    if (g.bearingVisible && bearing !== null) data['doa-bearing'] = { type: 'FeatureCollection', features: [bearingFeature(stationCoordinate, bearing, draw)] };
    if (g.edgesVisible) data['doa-edges'] = edgeFeatures(stationCoordinate, halfPower, draw, offset);
    return { data, rings: ringSet?.rings ?? [], halfPower };
    // Paint-only settings (palette, opacity, intensity, blur) are intentionally not dependencies.
  }, [stationCoordinate, values, bearing, offset, scale, g.ringsVisible, g.guidesVisible, g.guideInterval, g.heatmapVisible, g.heatStyle, g.lobeVisible, g.bearingVisible, g.edgesVisible, g.maxDistanceM, g.lobeDistanceM, g.contrast, g.radialSamples, g.distanceFalloff]);
  const bearingDrawn = geometry.data['doa-bearing'].features.length > 0;

  // Frame below the notices (basemap unavailable, overlay held...) so they never
  // cover the north label, and above the map controls so they never cover the south one.
  const framingPadding = (map: MapLibreMap) => {
    const notices = noticesRef.current;
    const below = notices && notices.offsetHeight > 0 ? notices.offsetTop + notices.offsetHeight + NOTICE_CLEARANCE_PX : 0;
    const height = map.getContainer().clientHeight;
    const limit = Math.max(FRAMING_PADDING.top, height * 0.45);
    const bottomLimit = Math.max(FRAMING_PADDING.bottom, height * 0.35);
    const bottom = Math.min(bottomLimit, controlsFramingBottom(controlsRef.current?.offsetHeight ?? 0));
    return { ...FRAMING_PADDING, top: Math.min(limit, Math.max(FRAMING_PADDING.top, below)), bottom };
  };
  // The dashboard panels float over the map. Their space becomes map padding,
  // clamped so it and the framing padding still leave fitBounds room to act.
  const applyPadding = (map: MapLibreMap) => {
    const container = map.getContainer();
    const padding = clampMapPadding(insetsRef.current, container.clientWidth, container.clientHeight, framingPadding(map));
    const current = map.getPadding();
    if (current.top === padding.top && current.right === padding.right && current.bottom === padding.bottom && current.left === padding.left) return false;
    map.setPadding(padding);
    return true;
  };
  const applyPaddingRef = useRef(applyPadding);
  applyPaddingRef.current = applyPadding;
  const frameStation = (map: MapLibreMap, target: MapCoordinate, durationMs = 0) => {
    const reach = Math.max(settingsRef.current.maxDistanceM, settingsRef.current.lobeDistanceM);
    map.fitBounds(overlayBounds(target, reach), { padding: framingPadding(map), maxZoom: MAX_FRAMING_ZOOM, duration: durationMs });
    framingRef.current = { source: target.source, selection: gpsSource };
    operatorMovedRef.current = false;
  };
  const frameStationRef = useRef(frameStation);
  frameStationRef.current = frameStation;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let disposed = false;
    const memory = cameraMemory;
    const start = coordinateRef.current;
    // Tiles come from this console; MapLibre needs absolute tile URLs.
    const origin = window.location.origin;
    let activeId: BasemapId = basemapIdRef.current;
    let activeSource = basemapBaseSource(activeId);
    let basemap: BasemapHealth = basemapHealthFor(activeSource);
    // When the active style was chosen or its tiles last reloaded, for the silent-host check.
    let basemapSince = performance.now();
    const rasters = basemapRasterLayers(activeId, origin, prefersReducedMotion());
    const paint = basemapPaint(consoleTheme(), false);
    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container: host,
        center: memory?.center ?? (start ? [start.longitude, start.latitude] : [0, 0]),
        zoom: memory?.zoom ?? (start ? DEFAULT_ZOOM : 2),
        bearing: memory?.bearing ?? 0,
        pitch: memory?.pitch ?? 0,
        minZoom: 1,
        maxZoom: 19,
        attributionControl: false,
        locale: mapLocale(t),
        style: { version: 8, sources: { ...Object.fromEntries(rasters.map((raster) => [raster.id, raster.source])), ...Object.fromEntries(SOURCE_IDS.map((id) => [id, { type: 'geojson', data: EMPTY }])) }, layers: [
          // Neutral land colour under the tiles; it follows the console theme when no tiles load.
          { id: 'basemap-background', type: 'background', paint: { 'background-color': paint.background } },
          // Basemap raster layers sit here, under 'doa-beam'; a style change swaps only them.
          ...rasters.map((raster) => raster.layer),
          { id: 'doa-beam', type: 'fill', source: 'doa-beam', paint: { 'fill-antialias': false, 'fill-color': beamColorExpression(DEFAULT_DOA_OVERLAY_SETTINGS.heatPalette), 'fill-opacity': beamOpacityExpression(DEFAULT_DOA_OVERLAY_SETTINGS.heatOpacity, DEFAULT_DOA_OVERLAY_SETTINGS.heatIntensity) } },
          { id: 'doa-heat', type: 'heatmap', source: 'doa-heat', maxzoom: 20, paint: { 'heatmap-weight': ['coalesce', ['get', 'densityWeight'], ['get', 'weight'], 0], 'heatmap-intensity': 1, 'heatmap-radius': heatmapRadiusExpression(DEFAULT_DOA_OVERLAY_SETTINGS.heatBlur), 'heatmap-opacity': .72, 'heatmap-color': heatmapColorExpression(DEFAULT_DOA_OVERLAY_SETTINGS.heatPalette) } },
          { id: 'doa-rings', type: 'line', source: 'doa-rings', paint: { 'line-color': paint.rings, 'line-opacity': .55, 'line-width': 1.2, 'line-dasharray': [4, 3] } },
          { id: 'doa-guides', type: 'line', source: 'doa-guides', paint: { 'line-color': paint.guides, 'line-opacity': .4, 'line-width': 1, 'line-dasharray': [2, 3] } },
          { id: 'doa-lobe-fill', type: 'fill', source: 'doa-lobe', paint: { 'fill-color': '#dca861', 'fill-opacity': .18 } },
          { id: 'doa-lobe-outline', type: 'line', source: 'doa-lobe', paint: { 'line-color': '#c98a2e', 'line-opacity': .9, 'line-width': 2 } },
          { id: 'doa-edges', type: 'line', source: 'doa-edges', paint: { 'line-color': '#e0603a', 'line-opacity': .75, 'line-width': 1.5, 'line-dasharray': [1, 2] } },
          { id: 'doa-bearing-casing', type: 'line', source: 'doa-bearing', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-opacity': .85, 'line-width': 6 } },
          { id: 'doa-bearing', type: 'line', source: 'doa-bearing', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#e0603a', 'line-opacity': .95, 'line-width': 3 } },
          { id: 'doa-station-halo', type: 'circle', source: 'doa-station', paint: { 'circle-radius': 12, 'circle-color': '#182027', 'circle-opacity': .8 } },
          { id: 'doa-station', type: 'circle', source: 'doa-station', paint: { 'circle-radius': 6, 'circle-color': '#ebbc70', 'circle-stroke-color': '#15181b', 'circle-stroke-width': 2 } },
        ] },
      });
    } catch {
      // Without WebGL2 the constructor throws. Keep the console running and
      // draw the direction helper on the canvas fallback instead.
      host.replaceChildren();
      setMapState('no-webgl');
      return undefined;
    }
    mapRef.current = map;
    framingRef.current = memory?.framing ?? null;
    operatorMovedRef.current = memory?.operatorMoved ?? false;
    setMapState('initializing');

    // reload: ask for the active style's tiles again (the periodic retry).
    const applyBasemap = (next: BasemapHealth, reload = false) => {
      basemap = next;
      if (activeSource) basemapMemory[activeSource] = next;
      if (reload && map.style) {
        basemapSince = performance.now();
        for (const raster of basemapRasterLayers(activeId, origin)) (map.getSource(raster.id) as RasterTileSource | undefined)?.setTiles(raster.source.tiles ?? []);
      }
      setBasemapStatus(basemapNotice(next));
      setTilesLoaded(next.loaded);
    };
    // Swap the basemap raster sources and layers under the overlay. Never
    // map.setStyle(): it would drop the GeoJSON data and runtime paint while
    // appliedDataRef still believes them applied. Each style has its own
    // source ids, so late tile errors of the previous style are ignored by id.
    selectBasemapRef.current = (next: BasemapId) => {
      if (disposed || next === activeId || !styleReadyRef.current || !map.style) return;
      try {
        for (const raster of [...basemapRasterLayers(activeId, origin), ...basemapRasterLayers(next, origin)]) {
          if (map.getLayer(raster.id)) map.removeLayer(raster.id);
          if (map.getSource(raster.id)) map.removeSource(raster.id);
        }
        for (const raster of basemapRasterLayers(next, origin, prefersReducedMotion())) {
          map.addSource(raster.id, raster.source);
          map.addLayer(raster.layer, 'doa-beam');
        }
      } catch {
        // activeId stays, so the next ready style or selection tries again.
        return;
      }
      activeId = next;
      activeSource = basemapBaseSource(next);
      basemap = basemapHealthFor(activeSource);
      basemapSince = performance.now();
      setActiveBasemap(next);
      setTilesLoaded(false);
      setBasemapStatus(basemapNotice(basemap));
    };
    const onStyleData = () => {
      // Fires for the first style and again after a WebGL context restore.
      if (disposed || styleReadyRef.current || !map.style || !map.getSource('doa-station')) return;
      styleReadyRef.current = true;
      appliedDataRef.current = {};
      setStyleReady(true);
      setMapState((state) => (state === 'initializing' || state === 'gl-lost' ? 'ready' : state));
    };
    const onError = (event: maplibregl.ErrorEvent) => {
      if (disposed || (event.error as { name?: unknown } | undefined)?.name === 'AbortError') return;
      // A failed raster tile is a network/provider issue, not a failed MapLibre
      // renderer: repeated failures of the active style show a non-blocking
      // notice and the overlay stays. Only other errors block the map.
      const sourceId = String((event as unknown as { sourceId?: string }).sourceId ?? '');
      if (isBasemapSourceId(sourceId)) {
        // Only the active base layer counts; a removed style or a label layer does not.
        if (sourceId === basemapSourceId(activeId)) applyBasemap(basemapAfterTile(basemap, false, BASEMAP_HOSTS, performance.now()));
        return;
      }
      const message = String(event.error?.message ?? '').toLowerCase();
      if (message.includes('tile') || message.includes('raster')) return;
      setMapState((state) => (state === 'gl-lost' ? state : 'error'));
    };
    let workerAlive = false;
    const workerWatchdog = window.setTimeout(() => {
      if (!disposed && !workerAlive) setMapState((state) => (state === 'initializing' || state === 'ready' ? 'worker-stalled' : state));
    }, WORKER_WATCHDOG_MS);
    const onSourceData = (event: MapSourceDataEvent) => {
      if (disposed) return;
      if (isBasemapSourceId(event.sourceId)) {
        if (event.tile && event.sourceId === basemapSourceId(activeId)) applyBasemap(basemapAfterTile(basemap, true, BASEMAP_HOSTS, performance.now()));
        return;
      }
      // GeoJSON sources report metadata once the worker has parsed their data.
      if (!workerAlive && event.sourceDataType === 'metadata' && SOURCE_ID_SET.has(event.sourceId)) {
        workerAlive = true;
        window.clearTimeout(workerWatchdog);
        setMapState((state) => (state === 'worker-stalled' ? (styleReadyRef.current ? 'ready' : 'initializing') : state));
      }
    };
    // Tiles that never answer produce no tile errors, so a style whose tiles
    // stay silent counts as unavailable; then its tiles are asked for again at
    // a slower pace. A partial style is asked for again at that pace too, since
    // MapLibre does not request a failed tile twice, and turns unavailable once
    // none of its tiles is drawn in the view. Plain has no tiles to check.
    const basemapCheck = window.setInterval(() => {
      const now = performance.now();
      if (disposed || !activeSource) return;
      if (basemap.loaded) {
        const viewed = basemapAfterView(basemap, rasterSourceDrawn(map, basemapSourceId(activeId)), BASEMAP_HOSTS, now);
        if (viewed !== basemap) {
          applyBasemap(viewed);
          return;
        }
        const partial = basemapPartialCheck(basemap, BASEMAP_HOSTS, now, BASEMAP_RETRY_MS);
        if (partial.state !== basemap) applyBasemap(partial.state, partial.reload);
        return;
      }
      if (now - basemapSince < BASEMAP_CHECK_MS || (basemap.unavailable && now - (basemap.switchedAtMs ?? 0) < BASEMAP_RETRY_MS)) return;
      applyBasemap(nextBasemapHost(basemap, BASEMAP_HOSTS, now), true);
    }, BASEMAP_CHECK_MS / 4);
    const onContextLost = () => {
      if (disposed) return;
      styleReadyRef.current = false;
      setStyleReady(false);
      setMapState('gl-lost');
    };
    // MapLibre restores the style itself; styledata then marks the overlay ready again.
    const onContextRestored = () => { if (!disposed) map.triggerRepaint(); };
    const onMoveStart = (event: { originalEvent?: unknown }) => { if (event.originalEvent) operatorMovedRef.current = true; };
    // 'load' waits for every source, including raster tiles, so it may never fire
    // when OSM is unreachable. The overlay only needs the parsed style and its
    // GeoJSON sources, which 'styledata' reports as soon as they exist.
    map.on('styledata', onStyleData);
    map.on('error', onError);
    map.on('sourcedata', onSourceData);
    map.on('webglcontextlost', onContextLost);
    map.on('webglcontextrestored', onContextRestored);
    map.on('movestart', onMoveStart);
    return () => {
      disposed = true;
      selectBasemapRef.current = null;
      window.clearTimeout(workerWatchdog);
      window.clearInterval(basemapCheck);
      cameraMemory = { center: map.getCenter().toArray(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(), framing: framingRef.current, operatorMoved: operatorMovedRef.current };
      map.off('styledata', onStyleData);
      map.off('error', onError);
      map.off('sourcedata', onSourceData);
      map.off('webglcontextlost', onContextLost);
      map.off('webglcontextrestored', onContextRestored);
      map.off('movestart', onMoveStart);
      stationPopupRef.current?.remove();
      stationPopupRef.current = null;
      stationMarkerRef.current?.remove();
      stationMarkerRef.current = null;
      appliedDataRef.current = {};
      styleReadyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
    // The map instance lives for the component lifetime; data arrives through setData
    // and the language through the locale effect below.
  }, []);

  // MapLibre's own strings (popup close, canvas title) follow the console
  // language. The zoom, centre and north-up buttons are console markup below.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const locale = mapLocale(t);
    map._locale = { ...map._locale, ...locale };
    map.getCanvas().setAttribute('aria-label', locale['Map.Title']);
    // t changes only with the language.
  }, [lang, mapState]);

  // Panel space changed (a panel opened, closed or resized): move the framing
  // area, and reframe an untouched camera so the station stays in the free part.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!applyPaddingRef.current(map)) return;
    const target = coordinateRef.current;
    if (target && framingRef.current?.source === target.source && !operatorMovedRef.current) frameStationRef.current(map, target);
  }, [mapState, insets.top, insets.right, insets.bottom, insets.left]);

  useEffect(() => {
    const update = () => setTheme(consoleTheme());
    window.addEventListener('console-theme-change', update);
    return () => window.removeEventListener('console-theme-change', update);
  }, []);

  // The chosen basemap style replaces the raster layers once the style is ready
  // (again after a WebGL context restore, which keeps the swapped layers).
  useEffect(() => {
    if (styleReady) selectBasemapRef.current?.(basemapId);
  }, [styleReady, basemapId]);

  // The background follows the theme; reference lines follow the tiles' tone
  // once they draw, and the theme while no tiles are drawn.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    const paint = basemapPaint(theme, tilesLoaded, tone);
    map.setPaintProperty('basemap-background', 'background-color', paint.background);
    map.setPaintProperty('doa-rings', 'line-color', paint.rings);
    map.setPaintProperty('doa-guides', 'line-color', paint.guides);
    map.setPaintProperty('doa-edges', 'line-color', paint.edges);
    map.setPaintProperty('doa-edges', 'line-width', paint.edgeWidth);
    map.setPaintProperty('doa-lobe-outline', 'line-color', paint.lobeOutline);
  }, [styleReady, theme, tilesLoaded, tone]);

  // Resizes from the window, the dashboard layout or the notices keep the
  // overlay framed while the operator has not moved the camera.
  useEffect(() => {
    const host = hostRef.current;
    const map = mapRef.current;
    if (!host || !map || typeof ResizeObserver !== 'function') return undefined;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      map.resize();
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        applyPaddingRef.current(map);
        const target = coordinateRef.current;
        if (target && framingRef.current?.source === target.source && !operatorMovedRef.current) frameStationRef.current(map, target);
      });
    });
    observer.observe(host);
    if (noticesRef.current) observer.observe(noticesRef.current);
    if (controlsRef.current) observer.observe(controlsRef.current);
    return () => { window.cancelAnimationFrame(frame); observer.disconnect(); };
  }, [mapState]);

  // A new projection radius reframes an untouched camera so the overlay stays in view.
  useEffect(() => {
    const map = mapRef.current;
    const target = coordinateRef.current;
    if (map && target && framingRef.current?.source === target.source && !operatorMovedRef.current) frameStationRef.current(map, target);
  }, [g.maxDistanceM, g.lobeDistanceM]);

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
    setVisibility('doa-edges', settings.edgesVisible);
    setVisibility('doa-bearing-casing', settings.bearingVisible);
    setVisibility('doa-bearing', settings.bearingVisible);
    // Overlay opacity scales every DoA layer; the station marker stays opaque.
    const fade = settings.overlayOpacity;
    map.setPaintProperty('doa-beam', 'fill-color', beamColorExpression(settings.heatPalette));
    map.setPaintProperty('doa-beam', 'fill-opacity', beamOpacityExpression(settings.heatOpacity * fade, settings.heatIntensity));
    map.setPaintProperty('doa-heat', 'heatmap-color', heatmapColorExpression(settings.heatPalette));
    map.setPaintProperty('doa-heat', 'heatmap-radius', heatmapRadiusExpression(settings.heatBlur));
    map.setPaintProperty('doa-heat', 'heatmap-opacity', settings.heatOpacity * fade);
    map.setPaintProperty('doa-heat', 'heatmap-intensity', settings.heatIntensity);
    map.setPaintProperty('doa-lobe-fill', 'fill-opacity', settings.lobeOpacity * fade);
    for (const [id, property, base] of LINE_LAYER_OPACITY) map.setPaintProperty(id, property, base * fade);
  }, [styleReady, settings.heatmapVisible, settings.heatStyle, settings.ringsVisible, settings.guidesVisible, settings.lobeVisible, settings.edgesVisible, settings.bearingVisible, settings.heatPalette, settings.heatOpacity, settings.heatIntensity, settings.heatBlur, settings.lobeOpacity, settings.overlayOpacity]);

  // Station marker, popup, and camera framing. shouldReframeStation decides
  // when a new position frames the camera; an operator-moved camera that still
  // shows the station is left alone. Ordinary data updates and a lost GPS fix
  // only move the marker.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    if (!stationCoordinate) {
      stationPopupRef.current?.remove();
      stationPopupRef.current = null;
      stationMarkerRef.current?.remove();
      stationMarkerRef.current = null;
      framingRef.current = null;
      return;
    }
    if (shouldReframeStation(framingRef.current, stationCoordinate.source, gpsSource)) {
      if (!operatorMovedRef.current || !stationInView(map, stationCoordinate)) frameStationRef.current(map, stationCoordinate);
      framingRef.current = { source: stationCoordinate.source, selection: gpsSource };
    }
    if (!stationMarkerRef.current) {
      const markerElement = document.createElement('button');
      markerElement.type = 'button';
      markerElement.className = 'doa-station-marker';
      const popup = new maplibregl.Popup({ offset: 18, closeButton: true, closeOnClick: false, className: 'doa-station-popup' });
      stationPopupRef.current = popup;
      stationMarkerRef.current = new maplibregl.Marker({ element: markerElement, anchor: 'center' }).setPopup(popup).setLngLat([stationCoordinate.longitude, stationCoordinate.latitude]).addTo(map);
    }
    const markerElement = stationMarkerRef.current.getElement();
    markerElement.classList.toggle('is-stale', station.held);
    markerElement.setAttribute('aria-label', t('map.stationAria', { lat: stationCoordinate.latitude.toFixed(6), lon: stationCoordinate.longitude.toFixed(6) }));
    markerElement.setAttribute('title', t('map.stationTitle'));
    const unavailable = t('map.popupUnavailable');
    // Popup text comes only from the static dictionary, internal enums, and formatted numbers.
    stationPopupRef.current?.setLngLat([stationCoordinate.longitude, stationCoordinate.latitude]).setHTML(
      `<div class="station-popup-content"><strong>${t('map.stationTitle')}</strong><dl><dt>${t('map.popupSource')}</dt><dd>${stationCoordinate.source}${station.held ? ' · STALE' : ''}</dd><dt>${t('map.popupPosition')}</dt><dd>${stationCoordinate.latitude.toFixed(6)}°, ${stationCoordinate.longitude.toFixed(6)}°</dd><dt>${t('map.popupBearing')}</dt><dd>${bearing === null ? unavailable : `${formatBearing(bearing, 1)}°`}</dd><dt>${t('map.popupTheta')}</dt><dd>${theta === null ? unavailable : `${formatBearing(theta, 1)}°`}</dd><dt>${t('map.popupOffset')}</dt><dd>${Number(offset.toFixed(1))}°</dd><dt>${t('map.popupHalfPower')}</dt><dd>${geometry.halfPower ? `${geometry.halfPower.widthDeg}°` : unavailable}</dd><dt>${t('map.popupVector')}</dt><dd>${values ? t('map.popupBins') : unavailable}</dd></dl></div>`,
    );
    stationMarkerRef.current.setLngLat([stationCoordinate.longitude, stationCoordinate.latitude]);
  }, [styleReady, stationCoordinate, gpsSource, station.held, bearing, theta, offset, values, geometry.halfPower, t]);

  // Text labels as DOM markers: the inline style has no glyph source, and the
  // CSP keeps the console from fetching remote fonts for symbol layers.
  // "Label teks" turns all of them off; ring distances follow the rings, the
  // N/E/S/W letters follow the direction guides, the pill follows the bearing.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !stationCoordinate || !g.labelsVisible) return undefined;
    const markers: maplibregl.Marker[] = [];
    const add = (lngLat: [number, number], className: string, text: string) => {
      const element = document.createElement('div');
      element.className = `doa-map-label ${className}`;
      element.textContent = text;
      element.setAttribute('aria-hidden', 'true');
      markers.push(new maplibregl.Marker({ element, anchor: 'center' }).setLngLat(lngLat).addTo(map));
    };
    if (g.ringsVisible) for (const ring of geometry.rings) add(ring.label, 'doa-ring-label', formatDistance(ring.distanceM));
    if (g.guidesVisible) {
      const outer = (geometry.rings.length ? geometry.rings[geometry.rings.length - 1].distanceM : g.maxDistanceM) * 1.12;
      for (const [key, angle] of CARDINALS) add(destination(stationCoordinate, angle, outer), 'doa-cardinal-label', t(key));
    }
    if (bearingDrawn && bearing !== null) add(destination(stationCoordinate, bearing, g.maxDistanceM * 1.1), 'doa-bearing-label', `${formatBearing(bearing, 1)}°`);
    return () => { for (const marker of markers) marker.remove(); };
  }, [styleReady, stationCoordinate, geometry.rings, bearing, bearingDrawn, g.ringsVisible, g.guidesVisible, g.labelsVisible, g.maxDistanceM, t]);

  // Hover (or tap) readout: geographic bearing, its theta_0 bin and shifted dB value, and ground distance from the station.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !stationCoordinate || !values || !(settings.heatmapVisible || settings.lobeVisible)) return undefined;
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'doa-hover-popup', offset: 14, maxWidth: '260px' });
    const radius = Math.max(g.maxDistanceM, g.lobeDistanceM) * 1.02;
    let frame = 0;
    let pending: maplibregl.LngLat | null = null;
    let dragging = false;
    const render = () => {
      frame = 0;
      if (!pending || dragging) return;
      const { bearingDeg, distanceM } = bearingAndDistance(stationCoordinate, pending.lng, pending.lat);
      if (distanceM > radius || distanceM < 1) { popup.remove(); return; }
      const bin = Math.round(geographicBearingForBin(bearingDeg, offset)) % 360;
      popup.setLngLat(pending).setHTML(`<strong>${t('map.hoverBearing', { deg: formatBearing(bearingDeg, 0), theta: bin, db: values[bin].toFixed(1) })}</strong><span>${t('map.hoverDistance', { distance: formatDistance(distanceM) })}</span>`);
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
  }, [styleReady, stationCoordinate, values, offset, settings.heatmapVisible, settings.lobeVisible, g.maxDistanceM, g.lobeDistanceM, t]);

  // Canvas fallback, used when MapLibre's GL layers may not be drawing (non-tile
  // error, lost context, stalled worker) or when there is no map at all (no
  // WebGL2, local north-up projection). It keeps the direction helper (rings,
  // guides, lobe, edges, bearing, station) visible; heat is not reproduced.
  const fallbackActive = FALLBACK_STATES.has(mapState);
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host || !fallbackActive) return undefined;
    const map = mapRef.current;
    // DOM labels need a ready style; without it the canvas writes its own.
    const drawText = !styleReady && settings.labelsVisible;
    // No map or a lost context leaves no tiles behind the lines; otherwise the
    // drawn tiles' tone decides, and the theme while no tiles are drawn.
    const darkBackground = !map || mapState === 'gl-lost' || (tilesLoaded ? tone === 'dark' : theme === 'dark');
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
      if (!stationCoordinate) return;
      context.globalAlpha = settings.overlayOpacity;
      const reach = Math.max(settings.maxDistanceM, settings.lobeDistanceM) * 1.15;
      const project: Projector = map ? ([longitude, latitude]) => map.project([longitude, latitude]) : localProjector(stationCoordinate, reach, rect.width, rect.height);
      const strokeLines = (collection: OverlayFeatureCollection, style: string, width: number, dash: number[]) => {
        context.save(); context.strokeStyle = style; context.lineWidth = width; context.setLineDash(dash);
        for (const feature of collection.features as Feature<LineString>[]) {
          context.beginPath();
          feature.geometry.coordinates.forEach((position, index) => { const point = project(position); if (index) context.lineTo(point.x, point.y); else context.moveTo(point.x, point.y); });
          context.stroke();
        }
        context.restore();
      };
      if (settings.ringsVisible) strokeLines(geometry.data['doa-rings'], darkBackground ? 'rgba(150,170,190,.6)' : 'rgba(31,45,58,.6)', 1.2, [4, 3]);
      if (settings.guidesVisible) strokeLines(geometry.data['doa-guides'], darkBackground ? 'rgba(150,170,190,.4)' : 'rgba(52,73,92,.5)', 1, [5, 6]);
      const lobe = geometry.data['doa-lobe'].features[0] as Feature<Polygon> | undefined;
      if (settings.lobeVisible && lobe) {
        context.save(); context.beginPath();
        lobe.geometry.coordinates[0].forEach((position, index) => { const point = project(position); if (index) context.lineTo(point.x, point.y); else context.moveTo(point.x, point.y); });
        context.closePath(); context.fillStyle = `rgba(235,188,112,${settings.lobeOpacity})`; context.fill();
        context.strokeStyle = darkBackground ? 'rgba(235,188,112,.92)' : 'rgba(201,138,46,.92)'; context.lineWidth = 2; context.stroke(); context.restore();
      }
      if (settings.edgesVisible) strokeLines(geometry.data['doa-edges'], darkBackground ? 'rgba(255,138,92,.8)' : 'rgba(224,96,58,.75)', darkBackground ? 2 : 1.5, [2, 4]);
      if (settings.bearingVisible) strokeLines(geometry.data['doa-bearing'], '#e0603a', 3, [9, 5]);
      // The station marker stays opaque, as on the map.
      context.globalAlpha = 1;
      const origin = project([stationCoordinate.longitude, stationCoordinate.latitude]);
      context.save(); context.fillStyle = '#ebbc70'; context.strokeStyle = '#172027'; context.lineWidth = 3;
      context.beginPath(); context.arc(origin.x, origin.y, 7, 0, Math.PI * 2); context.fill(); context.stroke(); context.restore();
      if (drawText) {
        context.save();
        context.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        const label = (position: [number, number], text: string, background: string) => {
          const point = project(position);
          const width = context.measureText(text).width + 10;
          context.fillStyle = background; context.fillRect(point.x - width / 2, point.y - 9, width, 18);
          context.fillStyle = '#ffffff'; context.fillText(text, point.x, point.y);
        };
        const outer = (geometry.rings.length ? geometry.rings[geometry.rings.length - 1].distanceM : settings.maxDistanceM) * 1.12;
        if (settings.guidesVisible) for (const [key, angle] of CARDINALS) label(destination(stationCoordinate, angle, outer), t(key), 'rgba(17,23,30,.82)');
        const bearingLine = geometry.data['doa-bearing'].features.length > 0;
        if (settings.bearingVisible && bearingLine && bearing !== null) label(destination(stationCoordinate, bearing, settings.maxDistanceM * 1.1), `${formatBearing(bearing, 1)}°`, '#11171e');
        context.restore();
      }
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(draw); };
    schedule();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(host);
    map?.on('move', schedule);
    map?.on('resize', schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      map?.off('move', schedule);
      map?.off('resize', schedule);
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [fallbackActive, mapState, theme, tilesLoaded, tone, styleReady, stationCoordinate, geometry, bearing, settings.ringsVisible, settings.guidesVisible, settings.lobeVisible, settings.edgesVisible, settings.bearingVisible, settings.labelsVisible, settings.overlayOpacity, settings.lobeOpacity, settings.maxDistanceM, settings.lobeDistanceM, t]);

  const reducedMotion = prefersReducedMotion;
  const resetView = () => {
    const current = coordinateRef.current;
    const map = mapRef.current;
    if (!current || !map) return;
    map.easeTo({ bearing: 0, pitch: 0, duration: 0 });
    frameStation(map, current, reducedMotion() ? 0 : 350);
  };
  // Button zooms are the operator's choice, so a later resize does not undo them.
  const zoomBy = (direction: 1 | -1) => {
    const map = mapRef.current;
    if (!map) return;
    operatorMovedRef.current = true;
    const options = reducedMotion() ? { duration: 0 } : undefined;
    if (direction > 0) map.zoomIn(options); else map.zoomOut(options);
  };
  const northUp = () => {
    mapRef.current?.easeTo({ bearing: 0, pitch: 0, duration: reducedMotion() ? 0 : 300 });
  };
  const held = !doaReady && doaHeldText !== undefined;
  // An MQTT DoA between Angular frames: the bearing without the curve.
  const bearingOnly = !values && bearing !== null;
  const dataLabel = values
    ? t('map.vectorReady', { bearing: bearing === null ? t('map.bearingUnavailable') : t('map.bearingReference', { deg: formatBearing(bearing, 0) }) })
    : bearingOnly ? t('map.bearingOnly', { deg: formatBearing(bearing, 0) })
      : held && doaHeldCode ? t('map.doaHeld', { code: doaHeldCode }) : t('map.noVector');
  const notices: string[] = [];
  if (mapState === 'no-webgl') notices.push(t('map.noWebgl'));
  if (mapState === 'gl-lost') notices.push(t('map.glLost'));
  if (mapState === 'worker-stalled') notices.push(t('map.workerStalled'));
  if (mapState === 'error') notices.push(t('map.rendererError'));
  if (basemapStatus && mapState !== 'no-webgl') notices.push(t(basemapStatus === 'partial' ? 'map.basemapPartial' : 'map.basemapUnavailable', { style: t(BASEMAPS[activeBasemap].labelKey) }));
  if (stationCoordinate && !values && !bearingOnly) notices.push(held ? t('map.overlayHeld', { reason: doaHeldText }) : t('map.overlayCleared'));
  if ((values || bearingOnly) && !orientationVerified) notices.push(t('map.orientationReference', { offset: Number(offset.toFixed(1)) }));
  // The credit follows the style the map draws; Plain draws no tiles and needs none.
  const attribution = BASEMAPS[activeBasemap].attribution;
  // DOM labels fade with the overlay through this custom property.
  const frameStyle = { '--overlay-opacity': String(settings.overlayOpacity) } as CSSProperties;
  // Notices sit top-centre in the space between the floating panels.
  const noticeStyle: CSSProperties | undefined = insets.left || insets.right ? { left: insets.left + 12, right: insets.right + 12 } : undefined;
  return <section className="panel map-panel">
    <div className="map-workspace">
      <div className="map-stage">
        <div className="map-frame" role="application" aria-label={t('map.appAria')} tabIndex={-1} style={frameStyle}>
          <div className="maplibre-host" ref={hostRef} />
          <canvas ref={overlayCanvasRef} className="doa-overlay-canvas" aria-hidden="true" hidden={!fallbackActive} />
          <div className="map-notices" ref={noticesRef} style={noticeStyle}>{notices.map((notice) => <div key={notice} className="map-data-chip" role="status">{notice}</div>)}</div>
          {!stationCoordinate ? <div className="map-empty-wrap"><EmptyState label={t('map.unavailable')} detail={t('map.unavailableDetail')} tone="warn" /></div> : null}
        </div>
        {mapState !== 'no-webgl' ? (
          <div className="ov-map-controls" ref={controlsRef}>
            <button className="ov-map-button" type="button" aria-label={t('map.ctrlZoomIn')} title={t('map.ctrlZoomIn')} onClick={() => zoomBy(1)}><Icon name="plus" /></button>
            <button className="ov-map-button" type="button" aria-label={t('map.ctrlZoomOut')} title={t('map.ctrlZoomOut')} onClick={() => zoomBy(-1)}><Icon name="minus" /></button>
            {stationCoordinate ? <button className="ov-map-button" type="button" aria-label={t('map.centerAria')} title={t('map.centerAria')} onClick={resetView}><Icon name="crosshair" /></button> : null}
            <button className="ov-map-button" type="button" aria-label={t('map.northUp')} title={t('map.northUp')} onClick={northUp}><Icon name="north" /></button>
            {onBasemapSelect ? <BasemapMenu value={basemapId} onChange={onBasemapSelect} /> : null}
            {attribution ? (
              <p className="ov-map-attribution" title={attribution.text}>
                {attribution.links.map((link, index) => (
                  <Fragment key={link.href}>
                    {index ? <span className="ov-map-attribution-sep" aria-hidden="true">·</span> : null}
                    <a href={link.href} target="_blank" rel="noopener noreferrer" aria-label={t('map.attributionLink', { source: link.text })}>{link.text}</a>
                  </Fragment>
                ))}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="map-bottom-overlay">
        <OverlayLegend settings={settings} scale={scale} saturation={saturation} ringStepM={niceRingStep(settings.maxDistanceM)} halfPower={geometry.halfPower} />
        {stationCoordinate ? <div className="map-coordinate" aria-label={t('map.coordinatesAria')}><span>{station.held ? t('map.sourceHeld') : t(coordinateSourceKey(stationCoordinate.source))}</span><strong>{stationCoordinate.latitude.toFixed(6)}°, {stationCoordinate.longitude.toFixed(6)}°</strong><small>{dataLabel}</small></div> : null}
      </div>
    </div>
  </section>;
}

/** Keeps a map failure inside the map panel; the rest of Overview keeps running. */
class MapErrorBoundary extends Component<{ children: ReactNode; label: string; detail: string }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <section className="panel map-panel">
      <div className="map-frame">
        <div className="map-empty-wrap"><EmptyState label={this.props.label} detail={this.props.detail} tone="warn" /></div>
      </div>
    </section>;
  }
}

export function TacticalMap(props: TacticalMapProps): JSX.Element {
  const { t } = useI18n();
  return <MapErrorBoundary label={t('map.crashed')} detail={t('map.crashedDetail')}><TacticalMapView {...props} /></MapErrorBoundary>;
}
