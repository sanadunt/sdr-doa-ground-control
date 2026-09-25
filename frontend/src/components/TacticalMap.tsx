import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap, GeoJSONSource, ExpressionSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import type { MapCoordinate, TelemetrySnapshot } from '../types';
import { OSM_TILE_TEMPLATES } from '../lib/map';
import { DEFAULT_DOA_OVERLAY_SETTINGS, bearingFeature, guideFeatures, heatFeatures, lobeFeature, type DoaOverlaySettings } from '../lib/doaGeometry';
import { loadOverlaySettings, saveOverlaySettings, validateOverlaySettings } from '../lib/mapOverlaySettings';
import { candidate, numberOrNull } from '../lib/telemetry';
import { EmptyState, Icon, Panel } from './ui';

type OverlayFeatureCollection = FeatureCollection<Point | LineString | Polygon>;
type MapState = 'initializing' | 'ready' | 'unavailable' | 'error';
const DEFAULT_ZOOM = 14;
const STATION_VIEW_OFFSET: [number, number] = [0, 90];
const SOURCE_IDS = ['doa-station', 'doa-lobe', 'doa-bearing', 'doa-guides', 'doa-heat'] as const;
const EMPTY: OverlayFeatureCollection = { type: 'FeatureCollection', features: [] };
const HEAT_PALETTES: Record<DoaOverlaySettings['heatPalette'], ExpressionSpecification> = {
  kraken: ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', .12, '#152238', .35, '#126e82', .58, '#f5d547', .78, '#f28f3b', 1, '#d7263d'],
  thermal: ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', .15, '#30123b', .38, '#4666a9', .58, '#35b779', .78, '#fde725', 1, '#ef3b2c'],
  viridis: ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', .12, '#440154', .36, '#31688e', .6, '#35b779', .8, '#fde725', 1, '#fff7ae'],
  monochrome: ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', .2, '#39434b', .55, '#aeb9c1', 1, '#ffffff'],
};

function pointFeature(coordinate: MapCoordinate | null): FeatureCollection<Point> {
  return coordinate ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { source: coordinate.source }, geometry: { type: 'Point', coordinates: [coordinate.longitude, coordinate.latitude] } }] } : { type: 'FeatureCollection', features: [] };
}

function lobeCollection(coordinate: MapCoordinate, values: number[], settings: DoaOverlaySettings): FeatureCollection<Polygon> {
  return { type: 'FeatureCollection', features: [lobeFeature(coordinate, values, settings)] };
}
function settingNumber(value: string, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }

function paletteColor(palette: DoaOverlaySettings['heatPalette'], weight: number): string {
  const stops: Record<DoaOverlaySettings['heatPalette'], string[]> = {
    kraken: ['21,34,56', '18,110,130', '245,213,71', '242,143,59', '215,38,61'],
    thermal: ['48,18,59', '70,102,169', '53,183,121', '253,231,37', '239,59,44'],
    viridis: ['68,1,84', '49,104,142', '53,183,121', '253,231,37', '255,247,174'],
    monochrome: ['57,67,75', '174,185,193', '255,255,255', '255,255,255', '255,255,255'],
  };
  return stops[palette][Math.min(4, Math.floor(Math.max(0, Math.min(0.999, weight)) * 5))];
}

function OverlayControls({ settings, onChange, onReset, onClose }: { settings: DoaOverlaySettings; onChange: (next: DoaOverlaySettings) => void; onReset: () => void; onClose: () => void }): JSX.Element {
  const update = (key: keyof DoaOverlaySettings, value: boolean | number | string) => onChange({ ...settings, [key]: value });
  const preset = (name: 'kraken' | 'focused' | 'wide') => {
    const values = name === 'focused'
      ? { maxDistanceM: 700, lobeDistanceM: 700, thresholdDb: -35, radialSamples: 10, distanceFalloff: .65, heatIntensity: 1.3, heatBlur: 22 }
      : name === 'wide'
        ? { maxDistanceM: 2500, lobeDistanceM: 1800, thresholdDb: -60, radialSamples: 18, distanceFalloff: .2, heatIntensity: .9, heatBlur: 42 }
        : { ...DEFAULT_DOA_OVERLAY_SETTINGS };
    onChange({ ...settings, ...values });
  };
  return <div id="doa-overlay-controls" className="map-overlay-controls" role="region" aria-label="DoA map overlay controls">
    <div className="overlay-control-header"><h3>Overlay settings</h3><button className="text-button" type="button" aria-label="Close overlay settings" onClick={onClose}>Close</button></div>
    <div className="overlay-control-grid">
      <label><input type="checkbox" checked={settings.lobeVisible} onChange={(event) => update('lobeVisible', event.target.checked)} /> Lobe</label>
      <label><input type="checkbox" checked={settings.bearingVisible} onChange={(event) => update('bearingVisible', event.target.checked)} /> Bearing</label>
      <label><input type="checkbox" checked={settings.heatmapVisible} onChange={(event) => update('heatmapVisible', event.target.checked)} /> Heatmap</label>
      <label><input type="checkbox" checked={settings.guidesVisible} onChange={(event) => update('guidesVisible', event.target.checked)} /> Guides</label>
    </div>
    <div className="overlay-control-fields">
      <label>Projection distance (m)<input type="number" min="100" max="20000" step="100" value={settings.maxDistanceM} onChange={(event) => update('maxDistanceM', Math.max(100, Math.min(20000, settingNumber(event.target.value, settings.maxDistanceM))))} /></label>
      <label>Lobe radius (m)<input type="number" min="100" max="20000" step="100" value={settings.lobeDistanceM} onChange={(event) => update('lobeDistanceM', Math.max(100, Math.min(20000, settingNumber(event.target.value, settings.lobeDistanceM))))} /></label>
      <label>Minimum dB<input type="number" min="-160" max="20" step="1" value={settings.minDb} onChange={(event) => update('minDb', settingNumber(event.target.value, settings.minDb))} /></label>
      <label>Maximum dB<input type="number" min="-160" max="20" step="1" value={settings.maxDb} onChange={(event) => update('maxDb', settingNumber(event.target.value, settings.maxDb))} /></label>
      <label>Visual contrast<input type="number" min="0.25" max="4" step="0.25" value={settings.contrast} onChange={(event) => update('contrast', Math.max(.25, Math.min(4, settingNumber(event.target.value, settings.contrast))))} /></label>
      <label>Noise threshold (dB)<input type="number" min="-160" max="20" step="1" value={settings.thresholdDb} onChange={(event) => update('thresholdDb', settingNumber(event.target.value, settings.thresholdDb))} /></label>
      <label>Radial samples<input type="number" min="2" max="32" step="1" value={settings.radialSamples} onChange={(event) => update('radialSamples', settingNumber(event.target.value, settings.radialSamples))} /><small>Density along each bearing</small></label>
      <label>Distance falloff<input type="range" min="0" max="1" step="0.05" value={settings.distanceFalloff} onChange={(event) => update('distanceFalloff', Number(event.target.value))} /><output>{Math.round(settings.distanceFalloff * 100)}%</output></label>
      <label>Visual intensity<input type="range" min="0.25" max="3" step="0.05" value={settings.heatIntensity} onChange={(event) => update('heatIntensity', Number(event.target.value))} /><output>{settings.heatIntensity.toFixed(2)}×</output></label>
      <label>Heat opacity<input type="range" min="0" max="1" step="0.05" value={settings.heatOpacity} onChange={(event) => update('heatOpacity', Number(event.target.value))} /><output>{Math.round(settings.heatOpacity * 100)}%</output></label>
      <label>Heat blur<input type="range" min="4" max="80" step="1" value={settings.heatBlur} onChange={(event) => update('heatBlur', Number(event.target.value))} /><output>{settings.heatBlur}px</output></label>
      <label>Heat gradient<select value={settings.heatPalette} onChange={(event) => update('heatPalette', event.target.value as DoaOverlaySettings['heatPalette'])}><option value="kraken">Kraken direction</option><option value="thermal">Thermal</option><option value="viridis">Viridis</option><option value="monochrome">Monochrome</option></select></label>
    </div>
    <label className="overlay-guide-field">Guide interval<select value={settings.guideInterval} onChange={(event) => update('guideInterval', Number(event.target.value) as DoaOverlaySettings['guideInterval'])}><option value="15">15°</option><option value="30">30°</option><option value="45">45°</option><option value="90">90°</option></select></label>
    <div className="overlay-presets"><span>Quick preset</span><button className="text-button" type="button" onClick={() => preset('kraken')}>Kraken</button><button className="text-button" type="button" onClick={() => preset('focused')}>Focused</button><button className="text-button" type="button" onClick={() => preset('wide')}>Wide</button></div>
    <div className="overlay-control-actions"><button className="text-button" type="button" onClick={onReset}>Reset overlay settings</button><span>Projection and falloff are visual helpers, not target range.</span></div>
  </div>;
}

export function TacticalMap({ coordinate, snapshot, localSnapshotFresh }: { coordinate: MapCoordinate | null; snapshot?: TelemetrySnapshot | null; localSnapshotFresh?: boolean }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const stationMarkerRef = useRef<maplibregl.Marker | null>(null);
  const stationPopupRef = useRef<maplibregl.Popup | null>(null);
  const centeredCoordinateRef = useRef<string | null>(null);
  const coordinateRef = useRef(coordinate);
  const [mapState, setMapState] = useState<MapState>('initializing');
  const [controlsOpen, setControlsOpen] = useState(false);
  const overlayToggleRef = useRef<HTMLButtonElement>(null);
  const [settings, setSettings] = useState<DoaOverlaySettings>(() => loadOverlaySettings());
  coordinateRef.current = coordinate;
  const csv = candidate(snapshot ?? null, 'csv');
  const values = localSnapshotFresh !== false && Array.isArray(csv.angular_power_db) && csv.angular_power_db.length === 360 ? csv.angular_power_db : null;
  const canonicalAngle = numberOrNull(csv.canonical_angle_deg);
  const bearing = canonicalAngle ?? numberOrNull(csv.angular_peak_index);
  const derived = useMemo(() => {
    if (!coordinate || !values || bearing === null || settings.maxDb <= settings.minDb) return { lobe: EMPTY, bearing: EMPTY, guides: EMPTY, heat: EMPTY };
    return { lobe: settings.lobeVisible ? lobeCollection(coordinate, values, settings) : EMPTY, bearing: settings.bearingVisible ? { type: 'FeatureCollection', features: [bearingFeature(coordinate, bearing, settings)] } satisfies FeatureCollection<LineString> : EMPTY, guides: settings.guidesVisible ? guideFeatures(coordinate, settings) : EMPTY, heat: settings.heatmapVisible ? heatFeatures(coordinate, values, settings, 8) : EMPTY };
  }, [coordinate, values, bearing, settings]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let disposed = false;
    const map = new maplibregl.Map({ container: host, center: coordinate ? [coordinate.longitude, coordinate.latitude] : [0, 0], zoom: coordinate ? DEFAULT_ZOOM : 2, minZoom: 1, maxZoom: 19, attributionControl: false, style: { version: 8, sources: { osm: { type: 'raster', tiles: [...OSM_TILE_TEMPLATES], tileSize: 256, attribution: '© OpenStreetMap contributors' }, ...Object.fromEntries(SOURCE_IDS.map((id) => [id, { type: 'geojson', data: EMPTY }])) }, layers: [
      { id: 'osm', type: 'raster', source: 'osm' },
      { id: 'doa-heat', type: 'heatmap', source: 'doa-heat', maxzoom: 20, paint: { 'heatmap-weight': ['coalesce', ['get', 'weight'], 0], 'heatmap-intensity': 1.35, 'heatmap-radius': 30, 'heatmap-opacity': .72, 'heatmap-color': HEAT_PALETTES.kraken } },
      { id: 'doa-guides', type: 'line', source: 'doa-guides', paint: { 'line-color': '#aab4bd', 'line-opacity': .5, 'line-width': 1, 'line-dasharray': [2, 3] } },
      { id: 'doa-lobe-fill', type: 'fill', source: 'doa-lobe', paint: { 'fill-color': '#dca861', 'fill-opacity': .18 } },
      { id: 'doa-lobe-outline', type: 'line', source: 'doa-lobe', paint: { 'line-color': '#dca861', 'line-opacity': .8, 'line-width': 2 } },
      { id: 'doa-bearing', type: 'line', source: 'doa-bearing', paint: { 'line-color': '#f08a60', 'line-opacity': .95, 'line-width': 3, 'line-dasharray': [2, 1] } },
      { id: 'doa-station-halo', type: 'circle', source: 'doa-station', paint: { 'circle-radius': 12, 'circle-color': '#182027', 'circle-opacity': .8 } },
      { id: 'doa-station', type: 'circle', source: 'doa-station', paint: { 'circle-radius': 6, 'circle-color': '#ebbc70', 'circle-stroke-color': '#15181b', 'circle-stroke-width': 2 } },
    ] } });
    mapRef.current = map; setMapState('initializing');
    const onLoad = () => { if (!disposed) setMapState('ready'); };
    const onError = (event: maplibregl.ErrorEvent) => {
      // A failed raster tile is a network/provider issue, not a failed MapLibre
      // renderer. Keep the map and DoA overlay usable while the alternate OSM
      // template is retried. Only initialization/style errors block the map.
      const sourceId = String((event as unknown as { sourceId?: string }).sourceId ?? '');
      const message = String(event.error?.message ?? '').toLowerCase();
      const isRasterTileIssue = sourceId === 'osm' || message.includes('tile') || message.includes('raster');
      if (!disposed && !isRasterTileIssue) setMapState('error');
    };
    map.once('load', onLoad); map.on('error', onError); map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    return () => { disposed = true; map.off('error', onError); stationPopupRef.current?.remove(); stationPopupRef.current = null; stationMarkerRef.current?.remove(); stationMarkerRef.current = null; map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const map = mapRef.current;
    if (!host || !map || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(host);
    return () => observer.disconnect();
  }, [mapState]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const applyOverlay = () => {
      if (!map.getSource('doa-station')) return;
      if (coordinate) {
        const coordinateKey = `${coordinate.latitude.toFixed(7)},${coordinate.longitude.toFixed(7)}`;
        if (centeredCoordinateRef.current === null) {
          map.jumpTo({ center: [coordinate.longitude, coordinate.latitude], zoom: DEFAULT_ZOOM, padding: { top: 0, right: 0, bottom: STATION_VIEW_OFFSET[1] * 2, left: 0 } });
          centeredCoordinateRef.current = coordinateKey;
        }
        if (!stationMarkerRef.current) {
          const markerElement = document.createElement('button');
          markerElement.type = 'button';
          markerElement.className = 'doa-station-marker';
          const popup = new maplibregl.Popup({ offset: 18, closeButton: true, closeOnClick: false, className: 'doa-station-popup' });
          stationPopupRef.current = popup;
          stationMarkerRef.current = new maplibregl.Marker({ element: markerElement, anchor: 'center' })
            .setLngLat([coordinate.longitude, coordinate.latitude])
            .setPopup(popup)
            .addTo(map);
        }
        const stationLabel = `Station at ${coordinate.latitude.toFixed(6)}, ${coordinate.longitude.toFixed(6)}. Activate for details.`;
        stationMarkerRef.current.getElement().setAttribute('aria-label', stationLabel);
        stationMarkerRef.current.getElement().setAttribute('title', 'Station details');
        stationPopupRef.current?.setLngLat([coordinate.longitude, coordinate.latitude]).setHTML(
          `<div class="station-popup-content"><dl><dt>Source</dt><dd>${coordinate.source}</dd><dt>Position</dt><dd>${coordinate.latitude.toFixed(6)}°, ${coordinate.longitude.toFixed(6)}°</dd><dt>DoA bearing</dt><dd>${bearing === null ? 'Unavailable' : `${bearing.toFixed(1)}°`}</dd><dt>Vector</dt><dd>${values ? '360 bins' : 'Unavailable'}</dd></dl><small>Direction helper only, not a target location.</small></div>`,
        );
        stationMarkerRef.current.setLngLat([coordinate.longitude, coordinate.latitude]);
      } else {
        stationPopupRef.current?.remove();
        stationPopupRef.current = null;
        stationMarkerRef.current?.remove();
        stationMarkerRef.current = null;
        centeredCoordinateRef.current = null;
      }
      const setSource = (id: string, data: OverlayFeatureCollection) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
      setSource('doa-station', pointFeature(coordinate)); setSource('doa-lobe', derived.lobe); setSource('doa-bearing', derived.bearing); setSource('doa-guides', derived.guides); setSource('doa-heat', derived.heat);
      const setVisibility = (id: string, visible: boolean) => {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
      };
      setVisibility('doa-heat', settings.heatmapVisible);
      setVisibility('doa-guides', settings.guidesVisible);
      setVisibility('doa-lobe-fill', settings.lobeVisible);
      setVisibility('doa-lobe-outline', settings.lobeVisible);
      setVisibility('doa-bearing', settings.bearingVisible);
      if (map.getLayer('doa-heat')) {
        map.setPaintProperty('doa-heat', 'heatmap-radius', settings.heatBlur);
        map.setPaintProperty('doa-heat', 'heatmap-opacity', settings.heatOpacity);
        map.setPaintProperty('doa-heat', 'heatmap-color', HEAT_PALETTES[settings.heatPalette]);
      }
      if (map.getLayer('doa-lobe-fill')) map.setPaintProperty('doa-lobe-fill', 'fill-opacity', settings.lobeOpacity);
    };
    applyOverlay();
    if (!map.loaded()) map.once('load', applyOverlay);
    map.once('idle', applyOverlay);
    return () => { map.off('load', applyOverlay); map.off('idle', applyOverlay); };
  }, [coordinate, derived, settings, mapState, bearing, values]);

  // MapLibre remains the geographic renderer. This canvas is a deliberate
  // presentation fallback for DoA overlays: it follows MapLibre's projection,
  // but does not depend on a style/source update being accepted by WebGL.
  // It makes the direction helper visible even when a raster tile or GL layer
  // is unavailable, without changing the underlying data or map interaction.
  useEffect(() => {
    const map = mapRef.current;
    const canvas = overlayCanvasRef.current;
    const host = hostRef.current;
    if (!map || !canvas || !host) return undefined;
    const draw = () => {
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
      if (!coordinate || !values) return;
      const origin = map.project([coordinate.longitude, coordinate.latitude]);
      const point = (feature: Feature<Point>): { x: number; y: number } => {
        const [longitude, latitude] = feature.geometry.coordinates;
        const projected = map.project([longitude, latitude]);
        return { x: projected.x, y: projected.y };
      };
      const lineCoordinates = (feature: Feature<LineString>) => feature.geometry.coordinates.map(([longitude, latitude]): { x: number; y: number } => {
        const projected = map.project([longitude, latitude]);
        return { x: projected.x, y: projected.y };
      });
      if (settings.guidesVisible) {
        context.save();
        context.strokeStyle = 'rgba(224,232,238,.48)';
        context.lineWidth = 1;
        context.setLineDash([5, 6]);
        for (const feature of derived.guides.features as Feature<LineString>[]) {
          const line = lineCoordinates(feature);
          context.beginPath(); context.moveTo(line[0].x, line[0].y); context.lineTo(line[1].x, line[1].y); context.stroke();
        }
        context.restore();
      }
      if (settings.heatmapVisible) {
        context.save();
        context.globalCompositeOperation = 'screen';
        for (const feature of derived.heat.features as Feature<Point>[]) {
          const { x, y } = point(feature);
          const weight = Number(feature.properties?.weight ?? 0);
          const radius = Math.max(10, settings.heatBlur * (0.7 + weight * 1.2));
          const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
          const color = paletteColor(settings.heatPalette, Math.min(1, weight * settings.heatIntensity));
          gradient.addColorStop(0, `rgba(${color},${Math.min(.86, settings.heatOpacity * (.45 + weight * settings.heatIntensity))})`);
          gradient.addColorStop(1, `rgba(${color},0)`);
          context.fillStyle = gradient; context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
        }
        context.restore();
      }
      if (settings.lobeVisible && derived.lobe.features[0]) {
        const polygon = derived.lobe.features[0] as Feature<Polygon>;
        const coordinates: Array<{ x: number; y: number }> = polygon.geometry.coordinates[0].map(([longitude, latitude]): { x: number; y: number } => {
          const projected = map.project([longitude, latitude]); return { x: projected.x, y: projected.y };
        });
        context.save(); context.beginPath();
        coordinates.forEach((item, index) => index ? context.lineTo(item.x, item.y) : context.moveTo(item.x, item.y));
        context.closePath(); context.fillStyle = `rgba(235,188,112,${settings.lobeOpacity})`; context.fill();
        context.strokeStyle = 'rgba(235,188,112,.92)'; context.lineWidth = 2; context.stroke(); context.restore();
      }
      if (settings.bearingVisible && derived.bearing.features[0]) {
        const line = lineCoordinates(derived.bearing.features[0] as Feature<LineString>);
        context.save(); context.strokeStyle = '#ff765f'; context.lineWidth = 3; context.setLineDash([9, 5]);
        context.beginPath(); context.moveTo(line[0].x, line[0].y); context.lineTo(line[1].x, line[1].y); context.stroke(); context.restore();
      }
      context.save(); context.fillStyle = '#ebbc70'; context.strokeStyle = '#172027'; context.lineWidth = 3;
      context.beginPath(); context.arc(origin.x, origin.y, 7, 0, Math.PI * 2); context.fill(); context.stroke(); context.restore();
    };
    draw();
    map.on('move', draw); map.on('resize', draw); map.on('rotate', draw); map.on('zoom', draw);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
    observer?.observe(host);
    return () => { map.off('move', draw); map.off('resize', draw); map.off('rotate', draw); map.off('zoom', draw); observer?.disconnect(); };
  }, [coordinate, values, derived, settings, mapState]);

  const updateSettings = (next: DoaOverlaySettings) => {
    const valid = validateOverlaySettings(next);
    setSettings(valid);
    saveOverlaySettings(valid);
  };
  const closeControls = () => {
    setControlsOpen(false);
    overlayToggleRef.current?.focus();
  };

  const resetView = () => { const current = coordinateRef.current; if (current && mapRef.current) { centeredCoordinateRef.current = `${current.latitude.toFixed(7)},${current.longitude.toFixed(7)}`; mapRef.current.easeTo({ center: [current.longitude, current.latitude], zoom: DEFAULT_ZOOM, bearing: 0, pitch: 0, padding: { top: 0, right: 0, bottom: STATION_VIEW_OFFSET[1] * 2, left: 0 }, duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 350 }); } };
  const dataLabel = values ? `360 bins · ${bearing === null ? 'bearing unavailable' : `${bearing.toFixed(0)}° reference`}` : 'No fresh 360-bin vector';
  return <Panel className="map-panel" action={<div className="map-panel-actions"><button ref={overlayToggleRef} className="secondary-button map-settings-button" type="button" onClick={() => setControlsOpen((open) => !open)} aria-expanded={controlsOpen} aria-controls={controlsOpen ? 'doa-overlay-controls' : undefined}>Overlay settings</button></div>}>
    <div className={`map-workspace${controlsOpen ? ' map-workspace-settings-open' : ''}`}>
      {controlsOpen ? <OverlayControls settings={settings} onChange={updateSettings} onReset={() => updateSettings(DEFAULT_DOA_OVERLAY_SETTINGS)} onClose={closeControls} /> : null}
      <div className="map-frame" role="application" aria-label="Interactive DoA map. Pan, zoom, and rotate without changing DoA data." tabIndex={-1} data-route-focus>
        <div className="maplibre-host" ref={hostRef} />
        <canvas ref={overlayCanvasRef} className="doa-overlay-canvas" aria-hidden="true" />
        <span className="map-attribution" aria-label="Map attribution">© OpenStreetMap contributors</span>
        {mapState === 'unavailable' || !coordinate ? <div className="map-empty-wrap"><EmptyState label="MAP UNAVAILABLE" detail="A valid station coordinate is not available; geographic overlay is held." tone="warn" /></div> : null}
        {mapState === 'error' ? <div className="map-empty-wrap"><EmptyState label="BASEMAP UNAVAILABLE" detail="MapLibre or the OSM tile layer did not load. Overlay data is not treated as a target location." tone="warn" /></div> : null}
        {coordinate ? <button className="map-reset-button" type="button" onClick={resetView} aria-label="Center map on station position"><Icon name="refresh" /> Center</button> : null}
      </div>
      <div className="map-bottom-overlay">
        {coordinate ? <div className="map-coordinate" aria-label="Station coordinates"><span>{coordinate.source === 'SIMULATION' ? 'SIMULATION · NOT LIVE GPS' : coordinate.source === 'FALLBACK' ? 'REFERENCE ONLY · NOT LIVE GPS' : coordinate.source === 'MANUAL' ? 'MANUAL POSITION · NOT LIVE GPS' : 'STATION POSITION'}</span><strong>{coordinate.latitude.toFixed(6)}°, {coordinate.longitude.toFixed(6)}°</strong><small>{dataLabel}</small></div> : null}
        <div className={`map-overlay-legend palette-${settings.heatPalette}`} role="note"><span><i className="legend-swatch legend-bearing" /> Bearing</span><span><i className="legend-swatch legend-lobe" /> Lobe</span><span><i className="legend-swatch legend-heat" /> Heat · {derived.heat.features.length} samples</span><small>Direction helper · bukan lokasi target</small></div>
      </div>
    </div>
  </Panel>;
}