import type { CSSProperties, JSX } from 'react';
import { Suspense, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleCapabilities } from '../api';
import type { CompassConfig, GpsConfig, MapCoordinate, PolarSettings, TelemetrySnapshot } from '../types';
import type { SimulationSettings } from '../lib/simulation';
import { gpsReportsNoFix, holdStationCoordinate, resolveGpsSource, resolveStationCoordinate } from '../lib/map';
import { groundPosition } from '../lib/groundGps';
import { doaStatusTextKey, overviewDoaStatus, provisionalDoa } from '../lib/doaStatus';
import { lazyWithRetry } from '../lib/lazyRetry';
import { compassOffsetSourceLabel, curveCompassOffset, polarSettings, rememberDataOutCompass, resolveCompassSource } from '../lib/polar';
import type { CompassSourceCode, DataOutCompassSettings } from '../lib/polar';
import { revealSection } from '../lib/revealSection';
import type { MessageKey } from '../lib/i18n';
import { effectiveDbScale } from '../lib/doaGeometry';
import type { DoaOverlaySettings, GeoOrigin } from '../lib/doaGeometry';
import { loadOverlaySettings, saveOverlaySettings, validateOverlaySettings } from '../lib/mapOverlaySettings';
import { loadPolarViewSettings, savePolarViewSettings, validatePolarViewSettings, effectiveFigType } from '../lib/polarViewSettings';
import { loadBasemapId, normalizeBasemapId, saveBasemapId } from '../lib/basemaps';
import type { BasemapId } from '../lib/basemaps';
import type { PolarViewSettings } from '../lib/polarViewSettings';
import { DEFAULT_OVERVIEW_PANELS } from '../lib/overviewPanels';
import type { OverviewPanels } from '../lib/overviewPanels';
import type { ConfigPatchChanges, ControlDraftRequest } from '../lib/controlDraft';
import type { ReceiverBridge } from '../lib/receiverBridge';
import { ZERO_INSETS, compactMapInsets, computeMapInsets, sameInsets, stackedRightTop } from '../lib/mapInsets';
import type { MapInsets } from '../lib/mapInsets';
import { primaryCandidate } from '../lib/telemetry';
import { positionEstimate, type PositionEstimate } from '../lib/positionEstimate';
import { overLora } from '../lib/telemetrySource';
import { useI18n } from '../lib/i18n';
import { DoaReadout } from '../components/DoaReadout';
import { LoadErrorBoundary } from '../components/LoadErrorBoundary';
import type { RouteName } from '../components/Shell';
import { NodeCard } from '../components/overview/NodeCard';
import { DronePanel } from '../components/overview/DronePanel';
import type { DroneMapView } from '../components/TacticalMap';
import { DRONE_SAME_PLACE_M, droneArrayHeadingNow, droneStation, positionGap, rememberDroneTrack, snapshotDrone } from '../lib/droneLink';
import { LayersPanel } from '../components/overview/LayersPanel';
import { EstimatePanel } from '../components/overview/EstimatePanel';
import { PolarDock } from '../components/overview/PolarDock';
import { SpectrumDock } from '../components/overview/SpectrumDock';
import { SpectrumDockMirror } from '../components/overview/SpectrumDockMirror';
import type { ReceiverMirrorFeed } from '../lib/receiverMirrorFeed';
import type { CompactLayout } from '../lib/compactLayout';
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

/** Why the compass offset in use is not verified, for the map's REFERENCE notice. */
export function compassCauseKey(code: CompassSourceCode, lora = false): MessageKey | null {
  if (code === 'FALLBACK') return 'map.orientationFallback';
  if (code === 'DATA_OUT_LOCAL_OFFSET') return 'map.orientationNoOffset';
  // Telemetry LoRa never carries settings.json, so there is no read to wait for.
  if (code === 'DATA_OUT_UNAVAILABLE') return lora ? 'map.orientationNotOverLora' : 'map.orientationNotRead';
  return null;
}

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
  /**
   * The compact touch layout (lib/compactLayout.ts): map and spectrum side by side or
   * stacked without a page scroll, no Polar (the stored choice is kept), and the node card
   * only while `nodeOpen`, over the map.
   */
  compactLayout?: CompactLayout | null;
  /** The node card is open in the compact layout; this visit only, never saved. */
  nodeOpen?: boolean;
}

function OverviewPageView({
  snapshot,
  localSnapshotFresh,
  groundGpsFresh = localSnapshotFresh,
  droneFresh = localSnapshotFresh,
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
  compactLayout = null,
  nodeOpen = false,
}: {
  snapshot: TelemetrySnapshot | null;
  localSnapshotFresh: boolean;
  /** The groundstation GPS is current; it ages apart from the RDF-SDR's data (default: localSnapshotFresh). */
  groundGpsFresh?: boolean;
  /** The drone block is current; it ages apart from the RDF-SDR's data (default: localSnapshotFresh). */
  droneFresh?: boolean;
  gpsConfig: GpsConfig;
  compassConfig: CompassConfig;
  simulation?: SimulationSettings;
} & OverviewDashboardProps): JSX.Element {
  const { t } = useI18n();
  const evidence = localSnapshotFresh ? snapshot : null;
  const gpsCoordinate = resolveGpsSource(evidence, gpsConfig, droneFresh ? snapshot : null).coordinate;
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
  // The Angular curve turns with the heading of its own frame (contract 1.10), which may be older than the DoA's.
  const curveOffset = simulationSettings ? compassOffset : curveCompassOffset(snapshot, compass, compassOffset);
  const causeKey = simulation ? null : compassCauseKey(compass.code, overLora(snapshot));
  const orientationCause = causeKey ? t(causeKey) : undefined;
  // The REFERENCE notice opens Configuration at GPS & Compass.
  const openCompassSettings = useCallback(() => {
    onNavigate('configuration');
    revealSection('navigation-settings');
  }, [onNavigate]);
  const heldLatitude = station?.held ? station.coordinate?.latitude : undefined;
  const heldLongitude = station?.held ? station.coordinate?.longitude : undefined;
  const readoutCoordinate = useMemo<MapCoordinate | null>(
    () => (heldLatitude === undefined || heldLongitude === undefined ? coordinate : { latitude: heldLatitude, longitude: heldLongitude, source: 'DATA_OUT' }),
    [coordinate, heldLatitude, heldLongitude],
  );
  // The groundstation's own GPS fix, from a fresh answer only; none in simulation,
  // whose station is synthetic. Stable across equal values like the station.
  const ground = simulation ? null : groundPosition(groundGpsFresh ? snapshot : null);
  const groundLatitude = ground?.latitude;
  const groundLongitude = ground?.longitude;
  const groundCoordinate = useMemo<GeoOrigin | null>(
    () => (groundLatitude === undefined || groundLongitude === undefined ? null : { latitude: groundLatitude, longitude: groundLongitude }),
    [groundLatitude, groundLongitude],
  );
  // The drone that carries the RDF-SDR: its marker on its nose heading, its
  // track, and the RDF-SDR's own GPS beside it where the two disagree.
  const droneView = simulation ? null : snapshotDrone(droneFresh ? snapshot : null);
  const droneHere = droneStation(droneView);
  const droneTrack = simulation ? null : rememberDroneTrack(droneView);
  const rdfOwn = droneHere ? resolveStationCoordinate(evidence) : null;
  const rdfGap = positionGap(droneHere, rdfOwn);
  const rdfOwnShown = rdfOwn && rdfGap && rdfGap.distanceM > DRONE_SAME_PLACE_M ? rdfOwn : null;
  const droneHeadingNow = droneArrayHeadingNow(droneView);
  const droneMapKey = droneHere
    ? JSON.stringify([droneHere.latitude, droneHere.longitude, droneHeadingNow === null ? null : Math.round(droneHeadingNow * 10) / 10, droneTrack?.length ?? 0, rdfOwnShown?.latitude, rdfOwnShown?.longitude])
    : '';
  const droneMap = useMemo<DroneMapView | null>(() => (droneHere && droneTrack ? {
    position: { latitude: droneHere.latitude, longitude: droneHere.longitude },
    headingDeg: droneView?.heading?.deg ?? null,
    track: droneTrack,
    rdfOwn: rdfOwnShown ? { latitude: rdfOwnShown.latitude, longitude: rdfOwnShown.longitude } : null,
  } : null),
  // Rebuilt only when what the map draws changes.
  [droneMapKey]);
  // Where the moving RDF-SDR's bearings cross. It is built on the console from
  // every bearing so far, so it outlives a stale answer; kept stable across
  // equal answers so the map only redraws it when it changes.
  const estimateNow = simulation ? null : positionEstimate(snapshot);
  const estimateKey = estimateNow ? JSON.stringify(estimateNow) : '';
  const estimate = useMemo<PositionEstimate | null>(() => (estimateKey ? JSON.parse(estimateKey) as PositionEstimate : null), [estimateKey]);
  // One readiness decision for the map overlay, the bearing HUD and the polar curve.
  const doa = overviewDoaStatus(snapshot, localSnapshotFresh);
  // A held DoA is drawn with the heading of the very sample it comes from; a manual offset stays above it, as for a LIVE one.
  const provisional = provisionalDoa(snapshot, doa);
  const provisionalHeading = offsetManual ? null : provisional?.headingDeg ?? null;

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
  const csv = primaryCandidate(snapshot);
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
  // Compact: where the node card and Kontrol start when the map is too narrow for them beside the HUD (under it), else null.
  const [rightTop, setRightTop] = useState<number | null>(null);
  const compact = compactLayout !== null;
  // The compact layout has no Polar: the DoA is on the map. The stored choice stays for the PC.
  const polarShown = panels.polar && !compact;
  const nodeShown = !compact || nodeOpen;
  const dockShown = polarShown || panels.spectrum;
  // Kontrol publishes to the node; the LAN view never shows it, whatever the saved panels say.
  const controlShown = panels.control && !viewOnly;
  useEffect(() => {
    const mapElement = mapRef.current;
    if (!mapElement || typeof ResizeObserver !== 'function') return undefined;
    let frame = 0;
    const box = (element: HTMLElement | null) => (element ? element.getBoundingClientRect() : null);
    const rects = (element: HTMLElement | null) => (element ? Array.from(element.children, (child) => child.getBoundingClientRect()) : []);
    const measure = () => {
      frame = 0;
      // Compact: the dock is beside or below the map, never over it, and the
      // camera takes only the top inset (cameraInsets() in the map).
      const next = compact
        ? compactMapInsets(mapElement.getBoundingClientRect(), { left: rects(leftRef.current), right: rects(rightRef.current) })
        : computeMapInsets(mapElement.getBoundingClientRect(), {
          left: rects(leftRef.current),
          right: rects(rightRef.current),
          bottom: dockRef.current ? [dockRef.current.getBoundingClientRect()] : [],
        });
      setInsets((current) => (sameInsets(current, next) ? current : next));
      setRightTop(compact ? stackedRightTop(mapElement.getBoundingClientRect(), box(leftRef.current), box(rightRef.current)) : null);
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
  }, [panels.layers, controlShown, polarShown, panels.spectrum, panels.drone, panels.nodeCollapsed, nodeShown, compactLayout]);

  return (
    <div className="page page-overview ov-stage" data-dock={dockShown ? (panels.spectrum ? 'full' : 'polar') : 'none'} data-control={controlShown ? 'open' : undefined} data-layout={compactLayout ?? undefined}>
      <h1 className="visually-hidden" data-route-focus tabIndex={-1}>{t('route.overview')}</h1>
      <div className="ov-map" ref={mapRef}>
        <LoadErrorBoundary variant="map">
          <Suspense fallback={<MapPlaceholder />}>
            <TacticalMap
              coordinate={coordinate}
              snapshot={snapshot}
              localSnapshotFresh={localSnapshotFresh}
              compassOffset={compassOffset}
              curveOffset={curveOffset}
              orientationVerified={offsetVerified}
              gpsSource={gpsConfig.source}
              doaReady={doa.shown}
              doaHeldCode={doa.shown ? undefined : doa.code}
              doaHeldText={doa.shown ? undefined : t(doaStatusTextKey(doa.reason))}
              provisionalTheta={provisional?.thetaDeg ?? null}
              provisionalHeading={provisionalHeading}
              orientationCause={orientationCause}
              onOpenCompassSettings={openCompassSettings}
              overlaySettings={overlaySettings}
              insets={insets}
              basemapId={basemapId}
              onBasemapSelect={onBasemapSelect}
              ground={groundCoordinate}
              estimate={estimate}
              compact={compact}
              drone={droneMap}
            />
          </Suspense>
        </LoadErrorBoundary>
      </div>
      <div className="ov-left" ref={leftRef}>
        <DoaReadout snapshot={snapshot} localSnapshotFresh={localSnapshotFresh} settings={plotSettings} curveOffset={curveOffset} offsetSource={offsetSource} offsetVerified={offsetVerified} offsetManual={offsetManual} />
        {/* On a phone or tablet the card shows only once there is an estimate: its waiting states would cover the small map. */}
        {estimate && overlaySettings.estimateVisible && (!compact || estimate.state === 'ESTIMATE') ? <EstimatePanel estimate={estimate} viewOnly={viewOnly} compact={compact || panels.layers} /> : null}
        {panels.layers ? <LayersPanel settings={overlaySettings} scale={overlayScale} onChange={onOverlayChange} onClose={() => onPanelsChange({ ...panels, layers: false })} basemapId={basemapId} onBasemapChange={onBasemapSelect} /> : null}
      </div>
      <div className={rightTop === null ? 'ov-right' : 'ov-right is-stacked'} ref={rightRef} style={rightTop === null ? undefined : { '--ov-right-top': `${rightTop}px` } as CSSProperties}>
        {panels.drone ? <DronePanel initialView={droneView} onClose={() => onPanelsChange({ ...panels, drone: false })} /> : null}
        {nodeShown ? <NodeCard
          snapshot={snapshot}
          localSnapshotFresh={localSnapshotFresh}
          groundGpsFresh={groundGpsFresh}
          coordinate={readoutCoordinate}
          positionHeld={station?.held === true}
          ground={groundCoordinate}
          compassOffset={compassOffset}
          offsetSource={offsetSource}
          offsetManual={offsetManual}
          collapsed={panels.nodeCollapsed}
          onToggle={() => onPanelsChange({ ...panels, nodeCollapsed: !panels.nodeCollapsed })}
        /> : null}
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
          {polarShown ? (
            <PolarDock
              snapshot={snapshot}
              localSnapshotFresh={localSnapshotFresh}
              settings={plotSettings}
              curveOffset={curveOffset}
              offsetSource={offsetSource}
              offsetVerified={offsetVerified}
              compassConfig={compassConfig}
              onCompassConfigChanged={onCompassConfigChanged}
              view={polarViewSettings}
              onViewChange={onPolarViewChange}
            />
          ) : null}
          {panels.spectrum && viewOnly ? <SpectrumDockMirror feed={mirrorFeed} compact={compact || panels.layers} /> : null}
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
              compact={compact}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const OverviewPage = memo(OverviewPageView);
