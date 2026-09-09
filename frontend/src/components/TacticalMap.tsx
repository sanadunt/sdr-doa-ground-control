import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { CircleMarker, Map as LeafletMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { MapCoordinate } from '../types';
import { DEFAULT_OSM_TILE_TEMPLATE, safeOsmTileTemplate } from '../lib/map';
import { EmptyState, Icon, Panel } from './ui';

type LeafletState = 'initializing' | 'ready' | 'unavailable' | 'error';

const OSM_ATTRIBUTION = '&copy; OpenStreetMap';
const DEFAULT_ZOOM = 15;
const MIN_ZOOM = 3;
const MAX_ZOOM = 19;
const TILE_LOAD_TIMEOUT_MS = 15_000;

export function TacticalMap({ coordinate }: { coordinate: MapCoordinate | null }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const [mapState, setMapState] = useState<LeafletState>('initializing');

  const mapReady = coordinate !== null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let disposed = false;
    let disposeMap: (() => void) | null = null;
    mapRef.current?.remove();
    mapRef.current = null;

    if (!mapReady || !coordinate) {
      setMapState('unavailable');
      return undefined;
    }

    setMapState('initializing');

    const startMap = async (): Promise<void> => {
      try {
        const leafletModule = await import('leaflet');
        if (disposed) return;
        const L = leafletModule.default;
        const map = L.map(host, {
          center: [coordinate.latitude, coordinate.longitude],
          zoom: DEFAULT_ZOOM,
          minZoom: MIN_ZOOM,
          maxZoom: MAX_ZOOM,
          zoomControl: true,
          attributionControl: false,
          preferCanvas: true,
          worldCopyJump: true,
        });
        mapRef.current = map;

        const tiles = L.tileLayer(safeOsmTileTemplate(DEFAULT_OSM_TILE_TEMPLATE), {
          attribution: OSM_ATTRIBUTION,
          minZoom: MIN_ZOOM,
          maxZoom: MAX_ZOOM,
          maxNativeZoom: MAX_ZOOM,
          updateWhenIdle: true,
          updateWhenZooming: false,
          keepBuffer: 1,
          crossOrigin: true,
        });
        tiles.addTo(map);

        const stationMarker: CircleMarker = L.circleMarker([coordinate.latitude, coordinate.longitude], {
          radius: 7,
          color: '#082b19',
          weight: 2,
          fillColor: '#39d98a',
          fillOpacity: 0.95,
          bubblingMouseEvents: false,
        }).addTo(map);
        stationMarker.bindTooltip('Station position', { direction: 'top', opacity: 0.92 });

        let loaded = false;
        let timeoutId: number | null = window.setTimeout(() => {
          if (!loaded && !disposed) setMapState('error');
        }, TILE_LOAD_TIMEOUT_MS);
        const onLoad = () => {
          loaded = true;
          if (timeoutId !== null) window.clearTimeout(timeoutId);
          timeoutId = null;
          if (!disposed) setMapState('ready');
        };
        const onTileError = () => {
          if (!loaded && !disposed) setMapState('error');
        };
        tiles.once('load', onLoad);
        tiles.on('tileerror', onTileError);

        const resizeObserver = typeof ResizeObserver === 'function'
          ? new ResizeObserver(() => map.invalidateSize(false))
          : null;
        resizeObserver?.observe(host);
        const resizeFallback = () => map.invalidateSize(false);
        if (!resizeObserver) window.addEventListener('resize', resizeFallback);
        const invalidateTimer = window.setTimeout(() => map.invalidateSize(false), 0);

        disposeMap = () => {
          if (timeoutId !== null) window.clearTimeout(timeoutId);
          window.clearTimeout(invalidateTimer);
          tiles.off('tileerror', onTileError);
          resizeObserver?.disconnect();
          if (!resizeObserver) window.removeEventListener('resize', resizeFallback);
          if (mapRef.current === map) mapRef.current = null;
          map.remove();
        };
      } catch {
        if (!disposed) setMapState('error');
      }
    };

    void startMap();
    return () => {
      disposed = true;
      disposeMap?.();
      disposeMap = null;
    };
  }, [coordinate?.latitude, coordinate?.longitude, mapReady]);

  const resetView = () => {
    if (coordinate && mapRef.current) {
      mapRef.current.setView([coordinate.latitude, coordinate.longitude], DEFAULT_ZOOM, { animate: true });
    }
  };

  return (
    <Panel
      className="map-panel"
      eyebrow="TACTICAL / MAP 60"
      title="Station position / map"
    >
      <div
        className="map-frame"
        role="application"
        aria-label="Interactive map. Pan by dragging and zoom with the map controls or mouse wheel."
      >
        <div className="map-leaflet-host" ref={hostRef} />
        <span className="map-attribution" aria-label="Map attribution">© OpenStreetMap</span>
        {mapState === 'unavailable' || !mapReady ? (
          <div className="map-empty-wrap">
            <EmptyState label="MAP UNAVAILABLE" detail="A valid station coordinate is not available; the map is held." tone="warn" />
          </div>
        ) : mapState === 'error' ? (
          <div className="map-empty-wrap">
            <EmptyState label="MAP UNAVAILABLE" detail="The map layer did not finish loading; no stale imagery is retained." tone="warn" />
          </div>
        ) : null}
        {mapReady ? (
          <div className="map-coordinate" aria-label="Station coordinates">
            <span>STATION POSITION</span>
            <strong>{coordinate.latitude.toFixed(6)}°, {coordinate.longitude.toFixed(6)}°</strong>
          </div>
        ) : null}
        {mapReady ? (
          <button className="map-reset-button" type="button" onClick={resetView} aria-label="Center map on station position">
            <Icon name="refresh" /> Center
          </button>
        ) : null}
      </div>
    </Panel>
  );
}
