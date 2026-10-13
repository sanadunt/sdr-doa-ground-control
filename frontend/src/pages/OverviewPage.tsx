import type { JSX } from 'react';
import { Suspense, memo, useMemo } from 'react';
import type { CompassConfig, GpsConfig, MapCoordinate, PolarSettings, TelemetrySnapshot } from '../types';
import type { SimulationSettings } from '../lib/simulation';
import { holdStationCoordinate, resolveGpsSource } from '../lib/map';
import { overviewDoaStatus } from '../lib/doaStatus';
import { lazyWithRetry } from '../lib/lazyRetry';
import { compassOffsetSourceLabel, polarSettings, rememberDataOutCompass, resolveCompassSource } from '../lib/polar';
import type { DataOutCompassSettings } from '../lib/polar';
import { useI18n } from '../lib/i18n';
import { DoaReadout } from '../components/DoaReadout';
import { PolarPanel } from '../components/PolarPanel';
import { LoadErrorBoundary } from '../components/LoadErrorBoundary';

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
// Last live Data Out station fix for the readout, held through freshness gaps
// with the same rule the map uses for its marker.
let lastLiveStation: MapCoordinate | null = null;

function OverviewPageView({
  snapshot,
  localSnapshotFresh,
  gpsConfig,
  compassConfig,
  simulation,
}: {
  snapshot: TelemetrySnapshot | null;
  localSnapshotFresh: boolean;
  gpsConfig: GpsConfig;
  compassConfig: CompassConfig;
  simulation?: SimulationSettings;
}): JSX.Element {
  const { t } = useI18n();
  const evidence = localSnapshotFresh ? snapshot : null;
  const gpsCoordinate = resolveGpsSource(evidence, gpsConfig).coordinate;
  const station = simulation ? null : holdStationCoordinate(lastLiveStation, gpsCoordinate, localSnapshotFresh && snapshot?.status?.available === true, gpsConfig.source);
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
  const settings = useMemo<PolarSettings>(() => ({ figType, compassOffset }), [figType, compassOffset]);
  const heldLatitude = station?.held ? station.coordinate?.latitude : undefined;
  const heldLongitude = station?.held ? station.coordinate?.longitude : undefined;
  const readoutCoordinate = useMemo<MapCoordinate | null>(
    () => (heldLatitude === undefined || heldLongitude === undefined ? coordinate : { latitude: heldLatitude, longitude: heldLongitude, source: 'DATA_OUT' }),
    [coordinate, heldLatitude, heldLongitude],
  );
  // One readiness decision for the map overlay, the readout bearing and the polar curve.
  const doa = overviewDoaStatus(snapshot, localSnapshotFresh);

  return (
    <div className="page page-overview" aria-label={t('route.overview')}>
      <h1 className="visually-hidden">{t('route.overview')}</h1>
      <DoaReadout snapshot={snapshot} localSnapshotFresh={localSnapshotFresh} coordinate={readoutCoordinate} positionHeld={station?.held === true} settings={settings} offsetSource={offsetSource} offsetVerified={offsetVerified} />
      <div className="overview-spatial">
        <LoadErrorBoundary variant="map">
          <Suspense fallback={<MapPlaceholder />}>
            <TacticalMap coordinate={coordinate} snapshot={snapshot} localSnapshotFresh={localSnapshotFresh} compassOffset={compassOffset} orientationVerified={offsetVerified} gpsSource={gpsConfig.source} doaReady={doa.shown} />
          </Suspense>
        </LoadErrorBoundary>
        <PolarPanel snapshot={snapshot} localSnapshotFresh={localSnapshotFresh} compassSettings={settings} offsetSource={offsetSource} />
      </div>
    </div>
  );
}

export const OverviewPage = memo(OverviewPageView);
