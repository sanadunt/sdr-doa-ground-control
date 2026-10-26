import type { JSX } from 'react';
import { Suspense, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleCapabilities } from '../api';
import type { CompassConfig, GpsConfig, MapCoordinate, PolarSettings, TelemetrySnapshot } from '../types';
import type { SimulationSettings } from '../lib/simulation';
import { gpsReportsNoFix, holdStationCoordinate, resolveGpsSource } from '../lib/map';
import { doaStatusTextKey, overviewDoaStatus } from '../lib/doaStatus';
import { lazyWithRetry } from '../lib/lazyRetry';
import { compassOffsetSourceLabel, polarSettings, rememberDataOutCompass, resolveCompassSource } from '../lib/polar';
import type { DataOutCompassSettings } from '../lib/polar';
import { effectiveDbScale } from '../lib/doaGeometry';
import type { DoaOverlaySettings } from '../lib/doaGeometry';
import { loadOverlaySettings, saveOverlaySettings, validateOverlaySettings } from '../lib/mapOverlaySettings';
import { loadPolarViewSettings, savePolarViewSettings, validatePolarViewSettings, effectiveFigType } from '../lib/polarViewSettings';
import { loadBasemapId, normalizeBasemapId, saveBasemapId } from '../lib/basemaps';
import type { BasemapId } from '../lib/basemaps';
import type { PolarViewSettings } from '../lib/polarViewSettings';
import { DEFAULT_OVERVIEW_PANELS } from '../lib/overviewPanels';
import type { OverviewPanels } from '../lib/overviewPanels';
import type { ConfigPatchChanges, ControlDraftRequest } from '../lib/controlDraft';
import type { ReceiverBridge } from '../lib/receiverBridge';
import { ZERO_INSETS, computeMapInsets, sameInsets } from '../lib/mapInsets';
import type { MapInsets } from '../lib/mapInsets';
import { candidate } from '../lib/telemetry';
import { useI18n } from '../lib/i18n';
import { DoaReadout } from '../components/DoaReadout';
import { LoadErrorBoundary } from '../components/LoadErrorBoundary';
import type { RouteName } from '../components/Shell';
import { NodeCard } from '../components/overview/NodeCard';
import { LayersPanel } from '../components/overview/LayersPanel';
import { PolarDock } from '../components/overview/PolarDock';
import { SpectrumDock } from '../components/overview/SpectrumDock';
import { SpectrumDockMirror } from '../components/overview/SpectrumDockMirror';
import type { ReceiverMirrorFeed } from '../lib/receiverMirrorFeed';
import { ControlPanel } from '../components/overview/ControlPanel';

// MapLibre is one of the two large dependencies (Plotly, loaded by PolarPlot,
// is the other); load it beside the shell instead of blocking the first paint.
const TacticalMap = lazyWithRetry(() => import('../components/TacticalMap'), (module) => module.TacticalMap);

function MapPlaceholder(): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="panel map-panel map-panel-loading" role="status" aria-live="polite">
      <div className="map-frame"><span className="map-loading-label">{t('map.loading')}</span></div>
    </section>
  );
}

// Last usable Data Out display settings. Module scope keeps them across route
// changes, so one failed settings.json read does not flip the orientation.
let dataOutCompassMemory: DataOutCompassSettings | null = null;
// Last live Data Out station fix for the node card, held through freshness
// gaps with the same rule the map uses for its marker.
let lastLiveStation: MapCoordinate | null = null;

const noop = (): void => undefined;

/**
 * Dashboard wiring from App. Every value must be stable across the 500 ms
 * freshness tick (state, a useCallback, or a ref), or the memoized page
 * re-renders the map and Plotly on every tick. All are optional so the page
 * also renders on its own (tests, simulation).
 */
export interface OverviewDashboardProps {
  panels?: OverviewPanels;
  onPanelsChange?: (next: OverviewPanels) => void;
  /** Writes the local Compass source (manual offset from the polar dock); App also persists it. */
  onCompassConfigChanged?: (next: CompassConfig) => void;
  /** The console's one Receiver bridge; passed through to the spectrum dock. */
  receiverBridge?: ReceiverBridge;
  onRequestReceiver?: () => void;
  onNavigate?: (route: RouteName) => void;
  capabilities?: ConsoleCapabilities | null;
  controlDraftRequest?: ControlDraftRequest | null;
  onControlDraftRequest?: (changes: ConfigPatchChanges) => void;
  /** Read Data Out now, settings.json included; Kontrol's "Cek ulang". */
  onRefreshSnapshot?: () => void;
  /** The LAN view: no Kontrol, and the spectrum dock never mounts the Receiver frame. */
  viewOnly?: boolean;
  /** The LAN view's Receiver mirror; the spectrum dock shows it in MIRROR mode. */
  mirrorFeed?: ReceiverMirrorFeed | null;
}

function OverviewPageView({
  snapshot,
  localSnapshotFresh,
  gpsConfig,
  compassConfig,
  simulation,
  panels = DEFAULT_OVERVIEW_PANELS,
  onPanelsChange = noop,
  onCompassConfigChanged,
  receiverBridge,
  onRequestReceiver = noop,
  onNavigate = noop,
  capabilities = null,
  controlDraftRequest = null,
  onControlDraftRequest = noop,
  onRefreshSnapshot = noop,
  viewOnly = false,
  mirrorFeed = null,
}: {
  snapshot: TelemetrySnapshot | null;
  localSnapshotFresh: boolean;
  gpsConfig: GpsConfig;
  compassConfig: CompassConfig;
  simulation?: SimulationSettings;
} & OverviewDashboardProps): JSX.Element {
  const { t } = useI18n();
  const evidence = localSnapshotFresh ? snapshot : null;
  const gpsCoordinate = resolveGpsSource(evidence, gpsConfig).coordinate;
  const station = simulation ? null : holdStationCoordinate(lastLiveStation, gpsCoordinate, gpsReportsNoFix(snapshot, localSnapshotFresh), gpsConfig.source);
  if (station) lastLiveStation = station.lastLive;
  dataOutCompassMemory = rememberDataOutCompass(dataOutCompassMemory, snapshot);
  const compass = resolveCompassSource(snapshot, { figType: compassConfig.manualFigType, compassOffset: compassConfig.manualCompassOffset }, compassConfig, dataOutCompassMemory);
  const simulationSettings = simulation ? polarSettings(snapshot?.settings?.fields?.doa_fig_type, snapshot?.settings?.fields?.compass_offset) : null;
  const latitude = simulation?.latitude ?? gpsCoordinate?.latitude;
  const longitude = simulation?.longitude ?? gpsCoordinate?.longitude;
  const source = simulation ? 'SIMULATION' : gpsCoordinate?.source;
  // Keep the coordinate and settings objects stable across equal values so map
  // overlays and Plotly only update when the underlying numbers change.
  const coordinate = useMemo<MapCoordinate | null>(
    () => (latitude === undefined || longitude === undefined || source === undefined ? null : { latitude, longitude, source }),
    [latitude, longitude, source],
  );
  const figType = simulationSettings?.figType ?? compass.settings.figType;
  const compassOffset = simulationSettings?.compassOffset ?? compass.settings.compassOffset;
  const offsetSource = simulation ? 'SIMULATION' : compassOffsetSourceLabel(compass, t);
  const offsetVerified = simulation ? true : compass.offsetVerified;
  const offsetManual = !simulation && compass.code === 'MANUAL';
  const heldLatitude = station?.held ? station.coordinate?.latitude : undefined;
  const heldLongitude = station?.held ? station.coordinate?.longitude : undefined;
  const readoutCoordinate = useMemo<MapCoordinate | null>(
    () => (heldLatitude === undefined || heldLongitude === undefined ? coordinate : { latitude: heldLatitude, longitude: heldLongitude, source: 'DATA_OUT' }),
    [coordinate, heldLatitude, heldLongitude],
  );
  // One readiness decision for the map overlay, the bearing HUD and the polar curve.
  const doa = overviewDoaStatus(snapshot, localSnapshotFresh);

  // Polar view choices (axis override, Head Up, dB range) only change the plot
  // and the display peak; the map and the bearing use the resolved settings.
  const [polarViewSettings, setPolarViewSettings] = useState<PolarViewSettings>(() => loadPolarViewSettings());
  const onPolarViewChange = useCallback((next: PolarViewSettings) => {
    const valid = validatePolarViewSettings(next);
    setPolarViewSettings(valid);
    savePolarViewSettings(valid);
  }, []);
  const plotFigType = effectiveFigType(figType, polarViewSettings);
  const plotSettings = useMemo<PolarSettings>(() => ({ figType: plotFigType, compassOffset }), [plotFigType, compassOffset]);

  // Overlay settings live here so the Layers panel and the map share them.
  const [overlaySettings, setOverlaySettings] = useState<DoaOverlaySettings>(() => loadOverlaySettings());
  const onOverlayChange = useCallback((next: DoaOverlaySettings) => {
    const valid = validateOverlaySettings(next);
    setOverlaySettings(valid);
    saveOverlaySettings(valid);
  }, []);
  // The basemap style; the map button and the Lapisan select share it.
  const [basemapId, setBasemapId] = useState<BasemapId>(() => loadBasemapId());
  const onBasemapSelect = useCallback((id: BasemapId) => {
    const valid = normalizeBasemapId(id);
    setBasemapId(valid);
    saveBasemapId(valid);
  }, []);
  const csv = candidate(snapshot, 'csv');
  const overlayValues = doa.shown && localSnapshotFresh && Array.isArray(csv.angular_power_db) && csv.angular_power_db.length === 360 ? csv.angular_power_db : null;
  const isSimulation = snapshot?.simulation === true;
  const overlayScale = useMemo(() => effectiveDbScale(overlayValues, overlaySettings, isSimulation), [overlayValues, overlaySettings, isSimulation]);

  // The panels float over the map; their space becomes map padding so the
  // station is framed in the part of the map that stays visible.
  const mapRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [insets, setInsets] = useState<MapInsets>(ZERO_INSETS);
  const dockShown = panels.polar || panels.spectrum;
  // Kontrol publishes to the node; the LAN view never shows it, whatever the saved panels say.
  const controlShown = panels.control && !viewOnly;
  useEffect(() => {
    const mapElement = mapRef.current;
    if (!mapElement || typeof ResizeObserver !== 'function') return undefined;
    let frame = 0;
    const rects = (element: HTMLElement | null) => (element ? Array.from(element.children, (child) => child.getBoundingClientRect()) : []);
    const measure = () => {
      frame = 0;
      const next = computeMapInsets(mapElement.getBoundingClientRect(), {
        left: rects(leftRef.current),
        right: rects(rightRef.current),
        bottom: dockRef.current ? [dockRef.current.getBoundingClientRect()] : [],
      });
      setInsets((current) => (sameInsets(current, next) ? current : next));
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(mapElement);
    for (const column of [leftRef.current, rightRef.current, dockRef.current]) {
      if (!column) continue;
      observer.observe(column);
      for (const child of Array.from(column.children)) observer.observe(child);
    }
    schedule();
    return () => { window.cancelAnimationFrame(frame); observer.disconnect(); };
  }, [panels.layers, controlShown, panels.polar, panels.spectrum, panels.nodeCollapsed]);

  return (
    <div className="page page-overview ov-stage" data-dock={dockShown ? (panels.spectrum ? 'full' : 'polar') : 'none'} data-control={controlShown ? 'open' : undefined}>
      <h1 className="visually-hidden" data-route-focus tabIndex={-1}>{t('route.overview')}</h1>
      <div className="ov-map" ref={mapRef}>
        <LoadErrorBoundary variant="map">
          <Suspense fallback={<MapPlaceholder />}>
            <TacticalMap
              coordinate={coordinate}
              snapshot={snapshot}
              localSnapshotFresh={localSnapshotFresh}
              compassOffset={compassOffset}
              orientationVerified={offsetVerified}
              gpsSource={gpsConfig.source}
              doaReady={doa.shown}
              doaHeldCode={doa.shown ? undefined : doa.code}
              doaHeldText={doa.shown ? undefined : t(doaStatusTextKey(doa.reason))}
              overlaySettings={overlaySettings}
              insets={insets}
              basemapId={basemapId}
              onBasemapSelect={onBasemapSelect}
            />
          </Suspense>
        </LoadErrorBoundary>
      </div>
      <div className="ov-left" ref={leftRef}>
        <DoaReadout snapshot={snapshot} localSnapshotFresh={localSnapshotFresh} settings={plotSettings} offsetSource={offsetSource} offsetVerified={offsetVerified} offsetManual={offsetManual} />
        {panels.layers ? <LayersPanel settings={overlaySettings} scale={overlayScale} onChange={onOverlayChange} onClose={() => onPanelsChange({ ...panels, layers: false })} basemapId={basemapId} onBasemapChange={onBasemapSelect} /> : null}
      </div>
      <div className="ov-right" ref={rightRef}>
        <NodeCard
          snapshot={snapshot}
          localSnapshotFresh={localSnapshotFresh}
          coordinate={readoutCoordinate}
          positionHeld={station?.held === true}
          compassOffset={compassOffset}
          offsetSource={offsetSource}
          offsetManual={offsetManual}
          collapsed={panels.nodeCollapsed}
          onToggle={() => onPanelsChange({ ...panels, nodeCollapsed: !panels.nodeCollapsed })}
        />
        {controlShown ? (
          <ControlPanel
            capabilities={capabilities}
            controlDraftRequest={controlDraftRequest}
            onClose={() => onPanelsChange({ ...panels, control: false })}
            snapshot={snapshot}
            localSnapshotFresh={localSnapshotFresh}
            onRefreshSnapshot={onRefreshSnapshot}
          />
        ) : null}
      </div>
      {dockShown ? (
        <div className="ov-dock" ref={dockRef}>
          {panels.polar ? (
            <PolarDock
              snapshot={snapshot}
              localSnapshotFresh={localSnapshotFresh}
              settings={plotSettings}
              offsetSource={offsetSource}
              offsetVerified={offsetVerified}
              compassConfig={compassConfig}
              onCompassConfigChanged={onCompassConfigChanged}
              view={polarViewSettings}
              onViewChange={onPolarViewChange}
            />
          ) : null}
          {panels.spectrum && viewOnly ? <SpectrumDockMirror feed={mirrorFeed} /> : null}
          {panels.spectrum && !viewOnly ? (
            <SpectrumDock
              snapshot={snapshot}
              localSnapshotFresh={localSnapshotFresh}
              capabilities={capabilities}
              panels={panels}
              onPanelsChange={onPanelsChange}
              onControlDraftRequest={onControlDraftRequest}
              onRequestReceiver={onRequestReceiver}
              onNavigate={onNavigate}
              receiverBridge={receiverBridge}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const OverviewPage = memo(OverviewPageView);
