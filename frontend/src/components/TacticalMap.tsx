import { Component, Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, JSX, ReactNode } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap, ExpressionSpecification, GeoJSONSource, LayerSpecification, MapMouseEvent, MapSourceDataEvent, RasterTileSource } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import type { GpsSourceMode, MapCoordinate, TelemetrySnapshot } from '../types';
import { basemapAfterTile, basemapAfterView, basemapNotice, basemapPaint, basemapPartialCheck, gpsReportsNoFix, holdStationCoordinate, nextBasemapHost, resumeBasemapHealth, shouldReframeStation, type BasemapHealth, type BasemapNotice, type StationFraming } from '../lib/map';
import { BASEMAPS, DEFAULT_BASEMAP_ID, basemapHealthKey, basemapSourceId, isBasemapSourceId, type BasemapId } from '../lib/basemaps';
import { OFFLINE_GLYPHS_PATH, basemapContents, registerOfflineProtocol, type BasemapContent } from '../lib/offlineBasemap';
import { MAP_CONTROLS_ROW_PX, ZERO_INSETS, cameraInsets, clampMapPadding, controlsFramingBottom, noticePlacement, type MapInsets } from '../lib/mapInsets';
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
  type GeoOrigin,
  type HalfPowerWidth,
  type RangeRing,
} from '../lib/doaGeometry';
import { groundLink, groundLinkLabel, stationPositionLive } from '../lib/groundGps';
import { binsAtBearing, geographicBearingForBin, heldBearing as provisionalBearingOf } from '../lib/polar';
import { beamColorExpression, beamOpacityExpression, formatBearing, formatDistance, heatmapColorExpression, heatmapRadiusExpression } from '../lib/overlayPalette';
import { numberOrNull, primaryCandidate } from '../lib/telemetry';
import { angularFrameAgeMs, angularHeld, doaSample, isMqttSnapshot } from '../lib/telemetrySource';
import { overviewDoaStatus } from '../lib/doaStatus';
import { headingLabel, headingLabelPosition, headingLineFeatures, headingPopupText, rdfHeading, type RdfHeading } from '../lib/rdfHeading';
import { NO_ESTIMATE_FEATURES, positionEstimateFeatures, positionEstimateLabel, type PositionEstimate } from '../lib/positionEstimate';
import { HELD_LAYER_OF, NO_HELD_FEATURES, heldBearingDeg, heldLayerSpec, heldNoticeText, heldOverlayFeatures, heldTimeText, overlayIdentity, provisionalBesideHeld, rememberOverlay, type OverlayMemory } from '../lib/heldOverlay';
import { useI18n } from '../lib/i18n';
import type { MessageKey, Translate } from '../lib/i18n';
import { coordinateSourceKey } from './DoaReadout';
import { OverlayLegend } from './OverlayLegend';
import { EmptyState, Icon } from './ui';
import { BasemapMenu } from './overview/BasemapPicker';
import { MapNoticeChip } from './MapNoticeChip';

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
// A held Angular curve (older than 10 s, kept by the Telemetry LoRa window) is drawn at this share of its opacity.
const HELD_CURVE_FADE = .45;
const WORKER_WATCHDOG_MS = 10_000;
const BASEMAP_CHECK_MS = 20_000;
const BASEMAP_RETRY_MS = 60_000;
// The console's tile route tries each upstream's hosts; the browser has one URL per source.
const BASEMAP_HOSTS = 1;
const SOURCE_IDS = ['doa-station', 'doa-beam', 'doa-heat', 'doa-rings', 'doa-guides', 'doa-lobe', 'doa-edges', 'doa-bearing', 'doa-provisional', 'doa-held-beam', 'doa-held-heat', 'doa-held-lobe', 'doa-held-edges', 'doa-held-bearing', 'rdf-heading', 'ground-link', 'estimate-heat', 'estimate-lines', 'estimate-point'] as const;
type SourceId = typeof SOURCE_IDS[number];
const SOURCE_ID_SET: ReadonlySet<string> = new Set(SOURCE_IDS);
const EMPTY: OverlayFeatureCollection = { type: 'FeatureCollection', features: [] };
const CARDINALS: ReadonlyArray<[MessageKey, number]> = [['map.cardinalN', 0], ['map.cardinalE', 90], ['map.cardinalS', 180], ['map.cardinalW', 270]];
// The line from the groundstation to the RDF-SDR: the accent colour while the
// RDF-SDR position is live, grey while it is a reference; never the bearing colour.
const GROUND_LINK_LIVE = { dark: '#3cc8dc', light: '#0a6f80' } as const;
// A reference line (the RDF-SDR position is not live) is slate, darker on light tiles so its dots stay visible.
const GROUND_LINK_REFERENCE = { dark: '#9aa6b2', light: '#46525e' } as const;
function groundLinkColor(darkBackground: boolean): ExpressionSpecification {
  return ['case', ['==', ['get', 'live'], true], darkBackground ? GROUND_LINK_LIVE.dark : GROUND_LINK_LIVE.light, darkBackground ? GROUND_LINK_REFERENCE.dark : GROUND_LINK_REFERENCE.light];
}
// The RDF-SDR's heading from telemetry/health (nav heading_deg: the compass, plus
// the edge's own offset): violet, apart from the bearing, the lobe and the ground
// link; slate and finer dashes while the heading is held (STALE). It shows where
// the array points now, not the direction of travel, and it never turns the bearing.
const HEADING_LIVE = { dark: '#c2a6ff', light: '#5b34c4' } as const;
const HEADING_HELD = { dark: '#9aa6b2', light: '#46525e' } as const;
// The transmitter position estimate: cyan, apart from the DoA's amber and red.
const ESTIMATE_COLOR = { dark: '#5fd4ff', light: '#0b6f99' } as const;
function estimateColor(darkBackground: boolean): string {
  return darkBackground ? ESTIMATE_COLOR.dark : ESTIMATE_COLOR.light;
}
function headingColors(darkBackground: boolean): { live: string; held: string } {
  return { live: darkBackground ? HEADING_LIVE.dark : HEADING_LIVE.light, held: darkBackground ? HEADING_HELD.dark : HEADING_HELD.light };
}
// The line layers drawn from the Angular curve; they fade with a held curve.
const CURVE_LINE_LAYERS: ReadonlySet<string> = new Set(['doa-lobe-outline', 'doa-edges']);
// Base opacity of each line layer at overlay opacity 1, as set in the style below.
const LINE_LAYER_OPACITY: ReadonlyArray<[string, 'line-opacity', number]> = [
  ['doa-rings', 'line-opacity', .55],
  ['doa-guides', 'line-opacity', .4],
  ['doa-lobe-outline', 'line-opacity', .9],
  ['doa-edges', 'line-opacity', .75],
  ['doa-bearing-casing', 'line-opacity', .85],
  ['doa-bearing', 'line-opacity', .95],
  ['doa-provisional', 'line-opacity', .9],
  ['rdf-heading', 'line-opacity', .95],
  ['rdf-heading-held', 'line-opacity', .8],
];

/**
 * Sets a paint property on a live DoA layer and on the held layer that mirrors
 * it (HELD_LAYER_OF), so the held overlay always has exactly the live paint.
 */
function setDoaPaint(map: MapLibreMap, id: string, property: Parameters<MapLibreMap['setPaintProperty']>[1], value: Parameters<MapLibreMap['setPaintProperty']>[2]): void {
  map.setPaintProperty(id, property, value);
  const held = HELD_LAYER_OF[id];
  if (held && map.getLayer(held)) map.setPaintProperty(held, property, value);
}

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
// The last live DoA overlay and the node it came from, drawn held while the
// DoA has stopped (lib/heldOverlay.ts), as the polar dock keeps its last curve.
let overlayMemory: OverlayMemory | null = null;
// Basemap outages seen earlier, per tile source (or 'offline'), so a known
// outage shows its notice at once when the map mounts again or the operator
// returns to a style.
const basemapMemory: Partial<Record<string, BasemapHealth>> = {};

function basemapHealthFor(source: string | null): BasemapHealth {
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

/**
 * Removes the layers and sources of `remove`, then adds `add` under the DoA
 * overlay. Never map.setStyle(): see selectBasemapRef.
 */
function replaceBasemapContent(map: MapLibreMap, remove: readonly BasemapContent[], add: readonly BasemapContent[]): void {
  for (const content of remove) {
    for (const layer of [...content.layers].reverse()) if (map.getLayer(layer.id)) map.removeLayer(layer.id);
    if (map.getSource(content.id)) map.removeSource(content.id);
  }
  for (const content of add) {
    map.addSource(content.id, content.source);
    for (const layer of content.layers) map.addLayer(layer, 'doa-beam');
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
  /** The -3 dB width of the held overlay, never shown as a live reading. */
  heldHalfPower: HalfPowerWidth | null;
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
  /** Compass offset applied to the DoA's theta_0 on the map; 0 in simulation. */
  compassOffset?: number;
  /**
   * Offset applied to the Angular curve's bins (beam, heat, lobe, edges): the
   * heading of the curve's own frame (contract 1.10), else compassOffset.
   */
  curveOffset?: number;
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
  /** theta_0 of a held DoA that is still readable; drawn as a dashed grey line marked NOT VALID. */
  provisionalTheta?: number | null;
  /**
   * The array heading of the sample provisionalTheta comes from (contract 1.10
   * h); the dashed line turns with it instead of compassOffset and then needs no
   * orientation notice. Null: compassOffset.
   */
  provisionalHeading?: number | null;
  /** Translated cause of an unverified compass offset, named in the REFERENCE notice. */
  orientationCause?: string;
  /** Opens Configuration → GPS & Compass from the REFERENCE notice. */
  onOpenCompassSettings?: () => void;
  /** Overlay layers, opacity and scale; owned and persisted by the Overview page (Layers panel). */
  overlaySettings?: DoaOverlaySettings;
  /** Space the floating dashboard panels take from the map; it moves the framing, not the canvas. */
  insets?: MapInsets;
  /** Basemap style; owned and persisted by the Overview page. */
  basemapId?: BasemapId;
  /** Shows the basemap button in the map controls when set. */
  onBasemapSelect?: (id: BasemapId) => void;
  /** The groundstation's own GPS fix; null without one. Kept stable across equal values by the caller. */
  ground?: GeoOrigin | null;
  /** Where the moving RDF-SDR's bearings cross (lib/positionEstimate.ts); null without one. Stable across equal values. */
  estimate?: PositionEstimate | null;
  /** The compact touch layout: notices fold to one-line chips that open on a tap. */
  compact?: boolean;
}

function TacticalMapView({ coordinate, snapshot, localSnapshotFresh, compassOffset = 0, curveOffset, orientationVerified = true, gpsSource = 'DATA_OUT', doaReady = true, doaHeldCode, doaHeldText, provisionalTheta = null, provisionalHeading = null, orientationCause, onOpenCompassSettings, overlaySettings = DEFAULT_DOA_OVERLAY_SETTINGS, insets = ZERO_INSETS, basemapId = DEFAULT_BASEMAP_ID, onBasemapSelect, ground = null, estimate = null, compact = false }: TacticalMapProps): JSX.Element {
  const { t, lang } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const stationMarkerRef = useRef<maplibregl.Marker | null>(null);
  const stationPopupRef = useRef<maplibregl.Popup | null>(null);
  const groundMarkerRef = useRef<maplibregl.Marker | null>(null);
  const headingMarkerRef = useRef<maplibregl.Marker | null>(null);
  const framingRef = useRef<StationFraming | null>(null);
  const operatorMovedRef = useRef(false);
  const styleReadyRef = useRef(false);
  const appliedDataRef = useRef<Partial<Record<SourceId, OverlayFeatureCollection>>>({});
  const [mapState, setMapState] = useState<MapState>('initializing');
  const [styleReady, setStyleReady] = useState(false);
  // The style the map draws; it follows basemapId once the style is ready.
  const [activeBasemap, setActiveBasemap] = useState<BasemapId>(basemapId);
  const [basemapStatus, setBasemapStatus] = useState<BasemapNotice>(() => basemapNotice(basemapHealthFor(basemapHealthKey(basemapId))));
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
  // The compact layout frames with the top inset only, so the station stays centred horizontally.
  const insetsRef = useRef(cameraInsets(insets, compact));
  insetsRef.current = cameraInsets(insets, compact);

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
  // The curve's bins turn with the heading of their own frame, which may be older than the DoA's.
  const binOffset = typeof curveOffset === 'number' && Number.isFinite(curveOffset) ? curveOffset : offset;
  // A held curve (LoRa window) stays, dimmed, with its age.
  const curveHeld = values !== null && angularHeld(snapshot);
  const curveFade = curveHeld ? HELD_CURVE_FADE : 1;
  // theta_0 is the array-frame angle; only its geographic bearing is drawn or reported.
  // An MQTT DoA is shown without its Angular vector between frames: the
  // bearing line stays, the beam, lobe and edges need the vector.
  const theta = doaReady && fresh && (values || isMqttSnapshot(snapshot)) ? numberOrNull(csv.canonical_angle_deg) : null;
  const bearing = theta === null ? null : geographicBearingForBin(theta, offset);
  // The held (NOT VALID) DoA turns with the heading of its own sample when it has one.
  const provisional = doaReady ? null : provisionalBearingOf(provisionalTheta, provisionalHeading, offset);
  const provisionalBearing = provisional?.bearingDeg ?? null;
  // The RDF-SDR's heading from telemetry/health (where its array points, from
  // the compass), drawn apart from the bearing. It never turns the bearing: a
  // contract 1.10 DoA carries the heading it was taken with (h, which may come
  // from the GPS course or be held), and that one turns it (compassOffset,
  // lib/polar.ts NODE_HEADING, or provisionalHeading for a held DoA), so the
  // two lines may differ while the platform turns. Kept as primitives so a new
  // snapshot with the same heading changes nothing on the map.
  const headingNow = rdfHeading(snapshot, fresh);
  const headingDeg = headingNow?.headingDeg ?? null;
  const headingState = headingNow?.state ?? null;
  const compassState = headingNow?.compassState ?? null;
  const heading = useMemo<RdfHeading | null>(() => (headingState === null ? null : { headingDeg, state: headingState, compassState }), [headingDeg, headingState, compassState]);
  // The DoA record's frequency, shown above the angle on the bearing label: the
  // shown DoA's, or the held (NOT VALID) record's beside its dimmed angle.
  const sampleHz = doaSample(snapshot, overviewDoaStatus(snapshot, fresh), fresh)?.frequencyHz ?? null;
  const frequencyText = sampleHz === null ? null : `${(sampleHz / 1e6).toFixed(3)} MHz`;
  // The last live overlay, drawn held (in the live style, marked STALE with its time) while no
  // live vector and no live bearing is drawn: a stopped DoA (STALE, NOT VALID,
  // CONFLICT, a failed DAQ sync, an overdrive...) never empties the map, as the
  // polar dock keeps its curve. Never from or during a simulation; another
  // node or a restart forgets it. Kept in module scope across route changes.
  const remembered = rememberOverlay(overlayMemory, {
    live: values && !simulation && stationCoordinate ? { values, thetaDeg: theta, offsetDeg: offset, curveOffsetDeg: binOffset, frequencyHz: sampleHz, origin: stationCoordinate } : null,
    liveBearing: bearing !== null,
    identity: overlayIdentity(snapshot),
    simulation,
    nowMs: Date.now(),
  });
  overlayMemory = remembered.memory;
  const heldDraw = stationCoordinate ? remembered.draw : null;
  // The held overlay stays where it was measured, not where the station is now.
  const heldOrigin = heldDraw?.origin ?? null;
  const heldBearing = heldBearingDeg(heldDraw);
  const heldTime = heldDraw ? heldTimeText(heldDraw.atMs, lang) : null;
  const heldFrequencyText = heldDraw?.frequencyHz != null ? `${(heldDraw.frequencyHz / 1e6).toFixed(3)} MHz` : null;
  // A NOT VALID line within 3° of the held bearing is not drawn twice.
  const provisionalShown = heldDraw ? provisionalBesideHeld(provisionalBearing, heldBearing) : provisionalBearing !== null;
  // The scale follows the drawn vector, live or held.
  const scaleValues = values ?? heldDraw?.values ?? null;
  // Only the scale fields matter here; depending on all of g would rebuild geometry on paint-only changes.
  const scale = useMemo(() => effectiveDbScale(scaleValues, g, simulation), [scaleValues, simulation, g.dbScale, g.minDb, g.maxDb, g.thresholdDb]);
  const saturation = useMemo(() => saturatedFraction(scaleValues, scale.maxDb), [scaleValues, scale.maxDb]);

  const geometry = useMemo<OverlayGeometry>(() => {
    const data: Record<SourceId, OverlayFeatureCollection> = {
      'doa-station': pointFeature(stationCoordinate), 'doa-beam': EMPTY, 'doa-heat': EMPTY, 'doa-rings': EMPTY, 'doa-guides': EMPTY, 'doa-lobe': EMPTY, 'doa-edges': EMPTY, 'doa-bearing': EMPTY, 'doa-provisional': EMPTY,
      'doa-held-beam': EMPTY, 'doa-held-heat': EMPTY, 'doa-held-lobe': EMPTY, 'doa-held-edges': EMPTY, 'doa-held-bearing': EMPTY, 'rdf-heading': EMPTY, 'ground-link': EMPTY,
      'estimate-heat': EMPTY, 'estimate-lines': EMPTY, 'estimate-point': EMPTY,
    };
    if (!stationCoordinate) return { data, rings: [], halfPower: null, heldHalfPower: null };
    // Rings and guides are a ground-distance and orientation reference; they do not depend on DoA data.
    const ringSet = g.ringsVisible ? rangeRings(stationCoordinate, g.maxDistanceM) : null;
    if (ringSet) data['doa-rings'] = ringSet.features;
    if (g.guidesVisible) data['doa-guides'] = guideFeatures(stationCoordinate, g);
    const draw: DoaOverlaySettings = { ...g, minDb: scale.minDb, maxDb: scale.maxDb, thresholdDb: scale.thresholdDb };
    if (!values) {
      if (g.bearingVisible && bearing !== null) data['doa-bearing'] = { type: 'FeatureCollection', features: [bearingFeature(stationCoordinate, bearing, draw)] };
      if (g.bearingVisible && provisionalShown && provisionalBearing !== null) data['doa-provisional'] = { type: 'FeatureCollection', features: [bearingFeature(stationCoordinate, provisionalBearing, draw)] };
      // The held overlay goes only into its own sources, painted like the live ones.
      const { halfPower: heldHalfPower, ...held } = heldDraw ? heldOverlayFeatures(heldDraw, draw) : NO_HELD_FEATURES;
      Object.assign(data, held);
      return { data, rings: ringSet?.rings ?? [], halfPower: null, heldHalfPower };
    }
    if (draw.maxDb <= draw.minDb) return { data, rings: ringSet?.rings ?? [], halfPower: null, heldHalfPower: null };
    const halfPower = halfPowerWidth(values);
    if (g.heatmapVisible && g.heatStyle === 'beam') data['doa-beam'] = beamFeatures(stationCoordinate, values, draw, binOffset);
    if (g.heatmapVisible && g.heatStyle === 'density') data['doa-heat'] = heatFeatures(stationCoordinate, values, draw, binOffset);
    if (g.lobeVisible) data['doa-lobe'] = { type: 'FeatureCollection', features: [lobeFeature(stationCoordinate, values, draw, binOffset)] };
    if (g.bearingVisible && bearing !== null) data['doa-bearing'] = { type: 'FeatureCollection', features: [bearingFeature(stationCoordinate, bearing, draw)] };
    if (g.edgesVisible) data['doa-edges'] = edgeFeatures(stationCoordinate, halfPower, draw, binOffset);
    return { data, rings: ringSet?.rings ?? [], halfPower, heldHalfPower: null };
    // Paint-only settings (palette, opacity, intensity, blur) are intentionally not dependencies.
  }, [stationCoordinate, values, bearing, provisionalBearing, provisionalShown, heldDraw, binOffset, scale, g.ringsVisible, g.guidesVisible, g.guideInterval, g.heatmapVisible, g.heatStyle, g.lobeVisible, g.bearingVisible, g.edgesVisible, g.maxDistanceM, g.lobeDistanceM, g.contrast, g.radialSamples, g.distanceFalloff]);
  const bearingDrawn = geometry.data['doa-bearing'].features.length > 0;
  const provisionalDrawn = geometry.data['doa-provisional'].features.length > 0;
  const heldBearingDrawn = geometry.data['doa-held-bearing'].features.length > 0;
  // The groundstation stands apart from the RDF-SDR; the dotted line joins them.
  const stationLive = stationPositionLive(stationCoordinate, station.held);
  const link = useMemo(() => (ground && stationCoordinate ? groundLink(ground, stationCoordinate, stationLive) : null), [ground, stationCoordinate, stationLive]);
  const headingLine = useMemo<OverlayFeatureCollection>(() => (stationCoordinate && g.headingVisible ? headingLineFeatures(stationCoordinate, heading, g.maxDistanceM) : EMPTY), [stationCoordinate, heading, g.headingVisible, g.maxDistanceM]);
  const headingDrawn = headingLine.features.length > 0;
  const headingHeld = heading !== null && heading.state !== 'OK';
  const estimateShapes = useMemo(() => (g.estimateVisible ? positionEstimateFeatures(estimate, stationCoordinate) : NO_ESTIMATE_FEATURES), [estimate, stationCoordinate, g.estimateVisible]);
  const estimatePoint = g.estimateVisible && estimate?.state === 'ESTIMATE' && estimate.latitude !== null && estimate.longitude !== null
    ? [estimate.longitude, estimate.latitude] as [number, number] : null;
  const sourceData = useMemo<Record<SourceId, OverlayFeatureCollection>>(() => ({
    ...geometry.data, 'rdf-heading': headingLine, 'ground-link': link?.features ?? EMPTY,
    'estimate-heat': estimateShapes.heat, 'estimate-lines': estimateShapes.lines, 'estimate-point': estimateShapes.point,
  }), [geometry, headingLine, link, estimateShapes]);

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
    let activeSource = basemapHealthKey(activeId);
    let basemap: BasemapHealth = basemapHealthFor(activeSource);
    // When the active style was chosen or its tiles last reloaded, for the silent-host check.
    let basemapSince = performance.now();
    const contents = basemapContents(activeId, origin, prefersReducedMotion());
    const paint = basemapPaint(consoleTheme(), false);
    // The live DoA layers. The held overlay (the last live one, while the DoA has
    // stopped) draws each from its own held source with exactly the same paint
    // (heldLayerSpec(), owner's decision of 2026-11-02), and every paint change
    // below reaches both (setDoaPaint()).
    const doaLayers = {
      beam: { id: 'doa-beam', type: 'fill', source: 'doa-beam', paint: { 'fill-antialias': false, 'fill-color': beamColorExpression(DEFAULT_DOA_OVERLAY_SETTINGS.heatPalette), 'fill-opacity': beamOpacityExpression(DEFAULT_DOA_OVERLAY_SETTINGS.heatOpacity, DEFAULT_DOA_OVERLAY_SETTINGS.heatIntensity) } },
      heat: { id: 'doa-heat', type: 'heatmap', source: 'doa-heat', maxzoom: 20, paint: { 'heatmap-weight': ['coalesce', ['get', 'densityWeight'], ['get', 'weight'], 0], 'heatmap-intensity': 1, 'heatmap-radius': heatmapRadiusExpression(DEFAULT_DOA_OVERLAY_SETTINGS.heatBlur), 'heatmap-opacity': .72, 'heatmap-color': heatmapColorExpression(DEFAULT_DOA_OVERLAY_SETTINGS.heatPalette) } },
      lobeFill: { id: 'doa-lobe-fill', type: 'fill', source: 'doa-lobe', paint: { 'fill-color': '#dca861', 'fill-opacity': .18 } },
      lobeOutline: { id: 'doa-lobe-outline', type: 'line', source: 'doa-lobe', paint: { 'line-color': '#c98a2e', 'line-opacity': .9, 'line-width': 2 } },
      edges: { id: 'doa-edges', type: 'line', source: 'doa-edges', paint: { 'line-color': '#e0603a', 'line-opacity': .75, 'line-width': 1.5, 'line-dasharray': [1, 2] } },
      bearingCasing: { id: 'doa-bearing-casing', type: 'line', source: 'doa-bearing', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-opacity': .85, 'line-width': 6 } },
      bearing: { id: 'doa-bearing', type: 'line', source: 'doa-bearing', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#e0603a', 'line-opacity': .95, 'line-width': 3 } },
    } satisfies Record<string, LayerSpecification & { source: string }>;
    let map: MapLibreMap;
    try {
      // The Offline style reads its PMTiles archive through this protocol.
      registerOfflineProtocol((name, loader) => maplibregl.addProtocol(name, loader));
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
        style: { version: 8, glyphs: origin + OFFLINE_GLYPHS_PATH, sources: { ...Object.fromEntries(contents.map((content) => [content.id, content.source])), ...Object.fromEntries(SOURCE_IDS.map((id) => [id, { type: 'geojson', data: EMPTY }])) }, layers: [
          // Neutral land colour under the tiles; it follows the console theme when no tiles load.
          { id: 'basemap-background', type: 'background', paint: { 'background-color': paint.background } },
          // Basemap raster layers sit here, under 'doa-beam'; a style change swaps only them.
          ...contents.flatMap((content) => content.layers),
          doaLayers.beam,
          heldLayerSpec(doaLayers.beam),
          doaLayers.heat,
          heldLayerSpec(doaLayers.heat),
          // Where the bearings of many places agree: cyan cells, fainter while the rays do not cross yet.
          { id: 'estimate-heat', type: 'fill', source: 'estimate-heat', paint: { 'fill-antialias': false, 'fill-color': estimateColor(consoleTheme() === 'dark'), 'fill-opacity': ['*', ['case', ['==', ['get', 'ready'], true], 1, .5], ['interpolate', ['linear'], ['get', 'share'], .2, .08, 1, .5]] } },
          { id: 'doa-rings', type: 'line', source: 'doa-rings', paint: { 'line-color': paint.rings, 'line-opacity': .55, 'line-width': 1.2, 'line-dasharray': [4, 3] } },
          { id: 'doa-guides', type: 'line', source: 'doa-guides', paint: { 'line-color': paint.guides, 'line-opacity': .4, 'line-width': 1, 'line-dasharray': [2, 3] } },
          doaLayers.lobeFill,
          doaLayers.lobeOutline,
          doaLayers.edges,
          heldLayerSpec(doaLayers.lobeFill),
          heldLayerSpec(doaLayers.lobeOutline),
          heldLayerSpec(doaLayers.edges),
          // The RDF-SDR's compass heading, under the DoA bearing: violet dashes, or slate finer dashes while held.
          { id: 'rdf-heading', type: 'line', source: 'rdf-heading', filter: ['!=', ['get', 'held'], true], layout: { 'line-cap': 'butt' }, paint: { 'line-color': headingColors(consoleTheme() === 'dark').live, 'line-opacity': .95, 'line-width': 2, 'line-dasharray': [4, 2.5] } },
          { id: 'rdf-heading-held', type: 'line', source: 'rdf-heading', filter: ['==', ['get', 'held'], true], layout: { 'line-cap': 'butt' }, paint: { 'line-color': headingColors(consoleTheme() === 'dark').held, 'line-opacity': .8, 'line-width': 2, 'line-dasharray': [1.5, 2.5] } },
          doaLayers.bearingCasing,
          doaLayers.bearing,
          heldLayerSpec(doaLayers.bearingCasing),
          heldLayerSpec(doaLayers.bearing),
          // A held DoA that is still readable: grey and dashed, never the bearing colour.
          { id: 'doa-provisional', type: 'line', source: 'doa-provisional', paint: { 'line-color': '#8d99a6', 'line-opacity': .9, 'line-width': 3, 'line-dasharray': [2, 1.5] } },
          // Groundstation to RDF-SDR: dots (zero-length dashes with round caps).
          { id: 'ground-link', type: 'line', source: 'ground-link', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': groundLinkColor(consoleTheme() === 'dark'), 'line-opacity': ['case', ['==', ['get', 'live'], true], .95, .9], 'line-width': 4, 'line-dasharray': [0, 2] } },
          { id: 'estimate-lines', type: 'line', source: 'estimate-lines', layout: { 'line-cap': 'round' }, paint: { 'line-color': estimateColor(consoleTheme() === 'dark'), 'line-opacity': .7, 'line-width': 1.2, 'line-dasharray': [3, 2] } },
          { id: 'estimate-point-halo', type: 'circle', source: 'estimate-point', paint: { 'circle-radius': 8, 'circle-color': '#182027', 'circle-opacity': .75 } },
          { id: 'estimate-point', type: 'circle', source: 'estimate-point', paint: { 'circle-radius': 4.5, 'circle-color': estimateColor(consoleTheme() === 'dark'), 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } },
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
        for (const content of basemapContents(activeId, origin)) {
          const source = map.getSource(content.id);
          if (source?.type === 'raster') (source as RasterTileSource).setTiles((content.source as { tiles?: string[] }).tiles ?? []);
          // A vector archive has no tile list to reset: add it again.
          else if (source) replaceBasemapContent(map, [content], [content]);
        }
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
        replaceBasemapContent(map, [...basemapContents(activeId, origin), ...basemapContents(next, origin)], basemapContents(next, origin, prefersReducedMotion()));
      } catch {
        // activeId stays, so the next ready style or selection tries again.
        return;
      }
      activeId = next;
      activeSource = basemapHealthKey(next);
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
      // A glyph range the console does not ship (a rare script in a place name)
      // only leaves that label out; it is not a map failure.
      if (String((event.error as { url?: unknown } | undefined)?.url ?? '').includes('/assets/map-fonts/')) return;
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
      groundMarkerRef.current?.remove();
      groundMarkerRef.current = null;
      headingMarkerRef.current?.remove();
      headingMarkerRef.current = null;
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
  }, [mapState, insets.top, insets.right, insets.bottom, insets.left, compact]);

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
    setDoaPaint(map, 'doa-edges', 'line-color', paint.edges);
    setDoaPaint(map, 'doa-edges', 'line-width', paint.edgeWidth);
    setDoaPaint(map, 'doa-lobe-outline', 'line-color', paint.lobeOutline);
    map.setPaintProperty('ground-link', 'line-color', groundLinkColor(tilesLoaded ? tone === 'dark' : theme === 'dark'));
    const headingPaint = headingColors(tilesLoaded ? tone === 'dark' : theme === 'dark');
    map.setPaintProperty('rdf-heading', 'line-color', headingPaint.live);
    map.setPaintProperty('rdf-heading-held', 'line-color', headingPaint.held);
    const estimatePaint = estimateColor(tilesLoaded ? tone === 'dark' : theme === 'dark');
    for (const [layer, property] of [['estimate-heat', 'fill-color'], ['estimate-lines', 'line-color'], ['estimate-point', 'circle-color']] as const) map.setPaintProperty(layer, property, estimatePaint);
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
      const next = sourceData[id];
      if (appliedDataRef.current[id] === next) continue;
      (map.getSource(id) as GeoJSONSource | undefined)?.setData(next);
      appliedDataRef.current[id] = next;
    }
  }, [styleReady, sourceData]);

  // Visibility and paint properties never rebuild geometry.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    // A live DoA layer and its held mirror are shown and hidden together.
    const setVisibility = (id: string, visible: boolean) => {
      for (const layer of [id, HELD_LAYER_OF[id]]) if (layer && map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', visible ? 'visible' : 'none');
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
    setVisibility('doa-provisional', settings.bearingVisible);
    setVisibility('rdf-heading', settings.headingVisible);
    setVisibility('rdf-heading-held', settings.headingVisible);
    // Overlay opacity scales every DoA layer; the station marker stays opaque.
    // The curve's layers (beam, heat, lobe, edges) fade further while the curve is held.
    const fade = settings.overlayOpacity;
    const curveLayerFade = fade * curveFade;
    // The held layers get the same palette, opacity, intensity and blur (setDoaPaint()).
    setDoaPaint(map, 'doa-beam', 'fill-color', beamColorExpression(settings.heatPalette));
    setDoaPaint(map, 'doa-beam', 'fill-opacity', beamOpacityExpression(settings.heatOpacity * curveLayerFade, settings.heatIntensity));
    setDoaPaint(map, 'doa-heat', 'heatmap-color', heatmapColorExpression(settings.heatPalette));
    setDoaPaint(map, 'doa-heat', 'heatmap-radius', heatmapRadiusExpression(settings.heatBlur));
    setDoaPaint(map, 'doa-heat', 'heatmap-opacity', settings.heatOpacity * curveLayerFade);
    setDoaPaint(map, 'doa-heat', 'heatmap-intensity', settings.heatIntensity);
    setDoaPaint(map, 'doa-lobe-fill', 'fill-opacity', settings.lobeOpacity * curveLayerFade);
    for (const [id, property, base] of LINE_LAYER_OPACITY) setDoaPaint(map, id, property, base * (CURVE_LINE_LAYERS.has(id) ? curveLayerFade : fade));
  }, [styleReady, curveFade, settings.heatmapVisible, settings.heatStyle, settings.ringsVisible, settings.guidesVisible, settings.lobeVisible, settings.edgesVisible, settings.bearingVisible, settings.headingVisible, settings.heatPalette, settings.heatOpacity, settings.heatIntensity, settings.heatBlur, settings.lobeOpacity, settings.overlayOpacity]);

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
      `<div class="station-popup-content"><strong>${t('map.stationTitle')}</strong><dl><dt>${t('map.popupSource')}</dt><dd>${stationCoordinate.source}${station.held ? ' · STALE' : ''}</dd><dt>${t('map.popupPosition')}</dt><dd>${stationCoordinate.latitude.toFixed(6)}°, ${stationCoordinate.longitude.toFixed(6)}°</dd><dt>${t('map.popupBearing')}</dt><dd>${bearing === null ? unavailable : `${formatBearing(bearing, 1)}°`}</dd><dt>${t('map.popupTheta')}</dt><dd>${theta === null ? unavailable : `${formatBearing(theta, 1)}°`}</dd><dt>${t('map.popupOffset')}</dt><dd>${Number(offset.toFixed(1))}°</dd>${heading ? `<dt>${t('map.popupHeading')}</dt><dd>${headingPopupText(heading, unavailable)}</dd>` : ''}<dt>${t('map.popupHalfPower')}</dt><dd>${geometry.halfPower ? `${geometry.halfPower.widthDeg}°` : unavailable}</dd><dt>${t('map.popupVector')}</dt><dd>${values ? t('map.popupBins') : unavailable}</dd></dl></div>`,
    );
    stationMarkerRef.current.setLngLat([stationCoordinate.longitude, stationCoordinate.latitude]);
  }, [styleReady, stationCoordinate, gpsSource, station.held, bearing, theta, offset, values, geometry.halfPower, heading, t]);

  // The heading triangle on the station circle. rotationAlignment 'map' keeps
  // it on the geographic heading while the map rotates; it takes no clicks, so
  // the station marker under it still opens its popup.
  const triangleDeg = settings.headingVisible && stationCoordinate && headingDeg !== null && headingState !== 'UNAVAILABLE' ? headingDeg : null;
  const triangleHeld = headingState !== 'OK';
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || triangleDeg === null || !stationCoordinate) {
      headingMarkerRef.current?.remove();
      headingMarkerRef.current = null;
      return;
    }
    if (!headingMarkerRef.current) {
      const element = document.createElement('div');
      element.className = 'rdf-heading-marker';
      element.setAttribute('aria-hidden', 'true');
      headingMarkerRef.current = new maplibregl.Marker({ element, anchor: 'center', rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([stationCoordinate.longitude, stationCoordinate.latitude]).addTo(map);
    }
    headingMarkerRef.current.getElement().classList.toggle('is-held', triangleHeld);
    headingMarkerRef.current.setRotation(triangleDeg).setLngLat([stationCoordinate.longitude, stationCoordinate.latitude]);
  }, [styleReady, stationCoordinate, triangleDeg, triangleHeld]);

  // Groundstation marker: a square marked GS, apart from the RDF-SDR's round
  // marker. It only moves on data updates; the camera stays where it is.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    if (!ground) {
      groundMarkerRef.current?.remove();
      groundMarkerRef.current = null;
      return;
    }
    if (!groundMarkerRef.current) {
      const element = document.createElement('div');
      element.className = 'ov-ground-marker';
      element.setAttribute('role', 'img');
      groundMarkerRef.current = new maplibregl.Marker({ element, anchor: 'center' }).setLngLat([ground.longitude, ground.latitude]).addTo(map);
    }
    const element = groundMarkerRef.current.getElement();
    element.textContent = t('map.groundShort');
    element.setAttribute('aria-label', t('map.groundAria', { lat: ground.latitude.toFixed(6), lon: ground.longitude.toFixed(6) }));
    element.setAttribute('title', t('map.groundTitle'));
    groundMarkerRef.current.setLngLat([ground.longitude, ground.latitude]);
  }, [styleReady, ground, t]);

  // Text labels as DOM markers: the inline style has no glyph source, and the
  // CSP keeps the console from fetching remote fonts for symbol layers.
  // "Label teks" turns all of them off; ring distances follow the rings, the
  // N/E/S/W letters follow the direction guides, the pill follows the bearing.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !stationCoordinate || !g.labelsVisible) return undefined;
    const markers: maplibregl.Marker[] = [];
    const add = (lngLat: [number, number], className: string, text: string, above: string | null = null) => {
      const element = document.createElement('div');
      element.className = `doa-map-label ${className}`;
      if (above) {
        // Two lines: a small upper line (the frequency) over the value.
        const top = document.createElement('span');
        top.className = 'doa-map-label-above';
        top.textContent = above;
        const value = document.createElement('span');
        value.textContent = text;
        element.append(top, value);
      } else {
        element.textContent = text;
      }
      element.setAttribute('aria-hidden', 'true');
      markers.push(new maplibregl.Marker({ element, anchor: 'center' }).setLngLat(lngLat).addTo(map));
    };
    if (g.ringsVisible) for (const ring of geometry.rings) add(ring.label, 'doa-ring-label', formatDistance(ring.distanceM));
    if (g.guidesVisible) {
      const outer = (geometry.rings.length ? geometry.rings[geometry.rings.length - 1].distanceM : g.maxDistanceM) * 1.12;
      for (const [key, angle] of CARDINALS) add(destination(stationCoordinate, angle, outer), 'doa-cardinal-label', t(key));
    }
    if (bearingDrawn && bearing !== null) add(destination(stationCoordinate, bearing, g.maxDistanceM * 1.1), 'doa-bearing-label', `${formatBearing(bearing, 1)}°`, frequencyText);
    if (provisionalDrawn && provisionalBearing !== null) add(destination(stationCoordinate, provisionalBearing, g.maxDistanceM * 1.1), 'doa-bearing-label is-provisional', `${t('polar.notValid')} · ${formatBearing(provisionalBearing, 1)}°`, frequencyText);
    // The held bearing: the live label with its own frequency, STALE and the time it was live.
    if (heldBearingDrawn && heldOrigin && heldBearing !== null && heldTime) add(destination(heldOrigin, heldBearing, g.maxDistanceM * 1.1), 'doa-bearing-label', t('map.heldBearing', { deg: formatBearing(heldBearing, 1), time: heldTime }), heldFrequencyText);
    if (headingDrawn && heading?.headingDeg != null) {
      const near = [bearingDrawn ? bearing : null, provisionalDrawn ? provisionalBearing : null, heldBearingDrawn ? heldBearing : null];
      add(headingLabelPosition(stationCoordinate, heading.headingDeg, g.maxDistanceM, near), headingHeld ? 'doa-heading-label is-held' : 'doa-heading-label', headingLabel(heading, t));
    }
    if (link) add(link.label, link.live ? 'ov-ground-label' : 'ov-ground-label is-reference', groundLinkLabel(link, t));
    if (estimatePoint && estimate) add(estimatePoint, 'doa-estimate-label', positionEstimateLabel(estimate, t));
    return () => { for (const marker of markers) marker.remove(); };
  }, [styleReady, stationCoordinate, geometry.rings, bearing, bearingDrawn, provisionalBearing, provisionalDrawn, frequencyText, heldBearing, heldBearingDrawn, heldOrigin, heldTime, heldFrequencyText, heading, headingDrawn, headingHeld, link, estimate, estimatePoint?.[0], estimatePoint?.[1], g.ringsVisible, g.guidesVisible, g.labelsVisible, g.maxDistanceM, t]);

  // Hover (or tap) readout: geographic bearing, its theta_0 in the DoA frame and the curve's dB value there, and ground distance from the station.
  // A held overlay reads its remembered vector and offset, under a STALE line with its time.
  const readoutValues = values ?? heldDraw?.values ?? null;
  const readoutOffset = values ? offset : heldDraw?.offsetDeg ?? offset;
  const readoutCurveOffset = values ? binOffset : heldDraw?.curveOffsetDeg ?? heldDraw?.offsetDeg ?? offset;
  const readoutHeld = values ? null : heldTime;
  // Measured from where the drawn overlay starts: the station, or the held overlay's own origin.
  const readoutOrigin = values ? stationCoordinate : heldOrigin ?? stationCoordinate;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !readoutOrigin || !readoutValues || !(settings.heatmapVisible || settings.lobeVisible)) return undefined;
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'doa-hover-popup', offset: 14, maxWidth: '260px' });
    const radius = Math.max(g.maxDistanceM, g.lobeDistanceM) * 1.02;
    let frame = 0;
    let pending: maplibregl.LngLat | null = null;
    let dragging = false;
    const render = () => {
      frame = 0;
      if (!pending || dragging) return;
      const { bearingDeg, distanceM } = bearingAndDistance(readoutOrigin, pending.lng, pending.lat);
      if (distanceM > radius || distanceM < 1) { popup.remove(); return; }
      // The value comes from the curve's own frame; theta_0 is named in the DoA's frame, as on the HUD.
      const { frameBin, theta } = binsAtBearing(bearingDeg, readoutCurveOffset, readoutOffset);
      const heldLine = readoutHeld ? `<span class="is-held">${t('map.legendHeld', { time: readoutHeld })}</span>` : '';
      popup.setLngLat(pending).setHTML(`${heldLine}<strong>${t('map.hoverBearing', { deg: formatBearing(bearingDeg, 0), theta, db: readoutValues[frameBin].toFixed(1) })}</strong><span>${t('map.hoverDistance', { distance: formatDistance(distanceM) })}</span>`);
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
  }, [styleReady, readoutOrigin, readoutValues, readoutCurveOffset, readoutOffset, readoutHeld, settings.heatmapVisible, settings.lobeVisible, g.maxDistanceM, g.lobeDistanceM, t]);

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
      // The live overlay and the held one (the last live one) in the same live style.
      const drawDirection = (lobeData: OverlayFeatureCollection, edgesData: OverlayFeatureCollection, bearingData: OverlayFeatureCollection) => {
        const lobe = lobeData.features[0] as Feature<Polygon> | undefined;
      // A held curve's lobe and edges are drawn fainter, as on the map.
      context.globalAlpha = settings.overlayOpacity * curveFade;
        if (settings.lobeVisible && lobe) {
          context.save(); context.beginPath();
          lobe.geometry.coordinates[0].forEach((position, index) => { const point = project(position); if (index) context.lineTo(point.x, point.y); else context.moveTo(point.x, point.y); });
          context.closePath(); context.fillStyle = `rgba(235,188,112,${settings.lobeOpacity})`; context.fill();
          context.strokeStyle = darkBackground ? 'rgba(235,188,112,.92)' : 'rgba(201,138,46,.92)'; context.lineWidth = 2; context.stroke(); context.restore();
        }
        if (settings.edgesVisible) strokeLines(edgesData, darkBackground ? 'rgba(255,138,92,.8)' : 'rgba(224,96,58,.75)', darkBackground ? 2 : 1.5, [2, 4]);
        context.globalAlpha = settings.overlayOpacity;
      if (settings.bearingVisible) strokeLines(bearingData, '#e0603a', 3, [9, 5]);
      };
      drawDirection(geometry.data['doa-lobe'], geometry.data['doa-edges'], geometry.data['doa-bearing']);
      drawDirection(geometry.data['doa-held-lobe'], geometry.data['doa-held-edges'], geometry.data['doa-held-bearing']);
      if (settings.bearingVisible) strokeLines(geometry.data['doa-provisional'], darkBackground ? 'rgba(170,182,194,.9)' : 'rgba(96,108,120,.9)', 3, [6, 5]);
      const headingPaint = headingColors(darkBackground);
      if (settings.headingVisible) strokeLines(headingLine, headingHeld ? headingPaint.held : headingPaint.live, 2, headingHeld ? [3, 5] : [8, 5]);
      // The station and groundstation markers and their line stay opaque, as on the map.
      context.globalAlpha = 1;
      if (link) strokeLines(link.features, link.live ? (darkBackground ? GROUND_LINK_LIVE.dark : GROUND_LINK_LIVE.light) : (darkBackground ? GROUND_LINK_REFERENCE.dark : GROUND_LINK_REFERENCE.light), 3, [2, 5]);
      if (estimatePoint) {
        strokeLines(estimateShapes.lines, estimateColor(darkBackground), 2, [6, 4]);
        const point = project(estimatePoint);
        context.save(); context.fillStyle = estimateColor(darkBackground); context.strokeStyle = '#ffffff'; context.lineWidth = 2;
        context.beginPath(); context.arc(point.x, point.y, 7, 0, Math.PI * 2); context.fill(); context.stroke(); context.restore();
      }
      if (ground) {
        const point = project([ground.longitude, ground.latitude]);
        context.save(); context.fillStyle = darkBackground ? GROUND_LINK_LIVE.dark : GROUND_LINK_LIVE.light; context.strokeStyle = '#172027'; context.lineWidth = 2;
        context.fillRect(point.x - 8, point.y - 8, 16, 16); context.strokeRect(point.x - 8, point.y - 8, 16, 16); context.restore();
      }
      const origin = project([stationCoordinate.longitude, stationCoordinate.latitude]);
      context.save(); context.fillStyle = '#ebbc70'; context.strokeStyle = '#172027'; context.lineWidth = 3;
      context.beginPath(); context.arc(origin.x, origin.y, 7, 0, Math.PI * 2); context.fill(); context.stroke(); context.restore();
      if (settings.headingVisible && heading?.headingDeg != null && heading.state !== 'UNAVAILABLE') {
        // The screen direction of the heading follows the projection, so a rotated map turns the triangle too.
        const ahead = project(destination(stationCoordinate, heading.headingDeg, Math.max(1, settings.maxDistanceM)));
        const angle = Math.atan2(ahead.x - origin.x, origin.y - ahead.y);
        context.save(); context.translate(origin.x, origin.y); context.rotate(angle);
        context.globalAlpha = headingHeld ? .6 : 1;
        context.fillStyle = headingHeld ? HEADING_HELD.dark : HEADING_LIVE.light; context.strokeStyle = '#ffffff'; context.lineWidth = 1.5;
        context.beginPath(); context.moveTo(0, -22); context.lineTo(7, -11); context.lineTo(-7, -11); context.closePath(); context.fill(); context.stroke(); context.restore();
      }
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
        if (settings.bearingVisible && bearingLine && bearing !== null) label(destination(stationCoordinate, bearing, settings.maxDistanceM * 1.1), `${frequencyText ? `${frequencyText} · ` : ''}${formatBearing(bearing, 1)}°`, '#11171e');
        const provisionalLine = geometry.data['doa-provisional'].features.length > 0;
        if (settings.bearingVisible && provisionalLine && provisionalBearing !== null) label(destination(stationCoordinate, provisionalBearing, settings.maxDistanceM * 1.1), `${frequencyText ? `${frequencyText} · ` : ''}${t('polar.notValid')} · ${formatBearing(provisionalBearing, 1)}°`, '#5b6670');
        const heldLine = geometry.data['doa-held-bearing'].features.length > 0;
        if (settings.bearingVisible && heldLine && heldOrigin && heldBearing !== null && heldTime) label(destination(heldOrigin, heldBearing, settings.maxDistanceM * 1.1), `${heldFrequencyText ? `${heldFrequencyText} · ` : ''}${t('map.heldBearing', { deg: formatBearing(heldBearing, 1), time: heldTime })}`, '#11171e');
        if (settings.headingVisible && headingLine.features.length > 0 && heading?.headingDeg != null) {
          const near = [bearingLine ? bearing : null, provisionalLine ? provisionalBearing : null, heldLine ? heldBearing : null];
          label(headingLabelPosition(stationCoordinate, heading.headingDeg, settings.maxDistanceM, near), headingLabel(heading, t), headingHeld ? '#5b6670' : HEADING_LIVE.light);
        }
        if (link) label(link.label, groundLinkLabel(link, t), link.live ? '#11171e' : '#5b6670');
        if (estimatePoint && estimate) label([estimatePoint[0], estimatePoint[1]], positionEstimateLabel(estimate, t), ESTIMATE_COLOR.light);
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
  }, [fallbackActive, mapState, theme, tilesLoaded, tone, styleReady, stationCoordinate, geometry, curveFade, bearing, provisionalBearing, frequencyText, heldBearing, heldOrigin, heldTime, heldFrequencyText, heading, headingLine, headingHeld, ground, link, estimate, estimateShapes, estimatePoint?.[0], estimatePoint?.[1], settings.ringsVisible, settings.guidesVisible, settings.lobeVisible, settings.edgesVisible, settings.bearingVisible, settings.headingVisible, settings.labelsVisible, settings.overlayOpacity, settings.lobeOpacity, settings.maxDistanceM, settings.lobeDistanceM, t]);

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
  const bearingText = bearing === null ? t('map.bearingUnavailable') : t('map.bearingReference', { deg: formatBearing(bearing, 0) });
  const heldAgeMs = curveHeld ? angularFrameAgeMs(snapshot) : null;
  const dataLabel = values
    ? heldAgeMs !== null ? t('map.vectorHeld', { bearing: bearingText, age: t('common.durationS', { value: Math.round(heldAgeMs / 1000) }) }) : t('map.vectorReady', { bearing: bearingText })
    : bearingOnly ? t('map.bearingOnly', { deg: formatBearing(bearing, 0) })
      : provisionalBearing !== null ? t('map.provisional', { deg: formatBearing(provisionalBearing, 0) })
        : heldDraw && heldTime ? t('map.heldData', { deg: heldBearing === null ? t('common.na') : formatBearing(heldBearing, 0), time: heldTime })
          : held && doaHeldCode ? t('map.doaHeld', { code: doaHeldCode }) : t('map.noVector');
  const notices: string[] = [];
  if (mapState === 'no-webgl') notices.push(t('map.noWebgl'));
  if (mapState === 'gl-lost') notices.push(t('map.glLost'));
  if (mapState === 'worker-stalled') notices.push(t('map.workerStalled'));
  if (mapState === 'error') notices.push(t('map.rendererError'));
  if (basemapStatus && mapState !== 'no-webgl') notices.push(t(basemapStatus === 'partial' ? 'map.basemapPartial' : 'map.basemapUnavailable', { style: t(BASEMAPS[activeBasemap].labelKey) }));
  // With a remembered overlay the map draws it held and says since when; without one it says why it is empty.
  if (stationCoordinate && !values && !bearingOnly) {
    notices.push(heldDraw && heldTime ? heldNoticeText(t, heldTime, held ? doaHeldText : undefined)
      : held ? t('map.overlayHeld', { reason: doaHeldText }) : t('map.overlayCleared'));
  }
  // The compass notice names its cause and links to the setting that fixes it.
  // A held DoA turned with its own sample's heading does not depend on the offset in use.
  const orientationNotice = (values || bearingOnly || (provisional !== null && !provisional.nodeHeading) || heldDraw) && !orientationVerified
    ? t('map.orientationReference', { cause: orientationCause ?? t('map.orientationNotReported'), offset: Number(offset.toFixed(1)) })
    : null;
  // The credit follows the style the map draws; Plain draws no tiles and needs none.
  const attribution = BASEMAPS[activeBasemap].attribution;
  // DOM labels fade with the overlay through this custom property.
  const frameStyle = { '--overlay-opacity': String(settings.overlayOpacity) } as CSSProperties;
  // Notices sit top-centre between the floating panels, or under them in the compact layout.
  const noticeStyle: CSSProperties | undefined = noticePlacement(insets, compact);
  return <section className="panel map-panel">
    <div className="map-workspace">
      <div className="map-stage">
        <div className="map-frame" role="application" aria-label={t('map.appAria')} tabIndex={-1} style={frameStyle}>
          <div className="maplibre-host" ref={hostRef} />
          <canvas ref={overlayCanvasRef} className="doa-overlay-canvas" aria-hidden="true" hidden={!fallbackActive} />
          <div className="map-notices" ref={noticesRef} style={noticeStyle}>
            {notices.map((notice) => <MapNoticeChip key={notice} text={notice} compact={compact} />)}
            {orientationNotice ? (
              <MapNoticeChip
                text={orientationNotice}
                action={onOpenCompassSettings ? { label: t('map.compassSettings'), onClick: onOpenCompassSettings } : null}
                compact={compact}
              />
            ) : null}
          </div>
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
        <OverlayLegend settings={settings} scale={scale} saturation={saturation} ringStepM={niceRingStep(settings.maxDistanceM)} halfPower={geometry.halfPower ?? geometry.heldHalfPower} heldTime={values ? null : heldTime} heading={settings.headingVisible && headingDrawn ? (headingHeld ? 'held' : 'live') : null} />
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
