import type { JSX } from 'react';
import { Suspense, lazy, memo, useCallback, useMemo, useState } from 'react';
import type { CompassConfig, GpsConfig, MapCoordinate, PolarSettings, TelemetrySnapshot } from '../types';
import type { SimulationSettings } from '../lib/simulation';
import { resolveGpsSource } from '../lib/map';
import { resolveCompassSource } from '../lib/polar';
import { useI18n } from '../lib/i18n';
import { DoaReadout } from '../components/DoaReadout';
import { PolarPanel } from '../components/PolarPanel';

// MapLibre is the largest dependency in the app; load it beside the shell
// instead of blocking the first paint on it.
const TacticalMap = lazy(() => import('../components/TacticalMap').then((module) => ({ default: module.TacticalMap })));

const POLAR_OVERLAY_KEY = 'sdr-console-polar-overlay';

function loadPolarOverlayVisible(): boolean {
  try { return window.localStorage.getItem(POLAR_OVERLAY_KEY) !== 'hidden'; } catch { return true; }
}

function MapPlaceholder(): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="panel map-panel map-panel-loading" role="status" aria-live="polite">
      <div className="map-frame"><span className="map-loading-label">{t('map.loading')}</span></div>
    </section>
  );
}

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
  const compassSettings = resolveCompassSource(evidence, { figType: compassConfig.manualFigType, compassOffset: compassConfig.manualCompassOffset }, compassConfig).settings;
  const latitude = simulation?.latitude ?? gpsCoordinate?.latitude;
  const longitude = simulation?.longitude ?? gpsCoordinate?.longitude;
  const source = simulation ? 'SIMULATION' : gpsCoordinate?.source;
  // Keep the coordinate and settings objects stable across equal values so map
  // overlays and Plotly only update when the underlying numbers change.
  const coordinate = useMemo<MapCoordinate | null>(
    () => (latitude === undefined || longitude === undefined || source === undefined ? null : { latitude, longitude, source }),
    [latitude, longitude, source],
  );
  const figType = simulation ? 'Polar' : compassSettings.figType;
  const compassOffset = simulation ? 0 : compassSettings.compassOffset;
  const settings = useMemo<PolarSettings>(() => ({ figType, compassOffset }), [figType, compassOffset]);
  const [polarVisible, setPolarVisible] = useState(loadPolarOverlayVisible);
  const togglePolar = useCallback(() => {
    setPolarVisible((visible) => {
      try { window.localStorage.setItem(POLAR_OVERLAY_KEY, visible ? 'hidden' : 'shown'); } catch { /* optional */ }
      return !visible;
    });
  }, []);

  return (
    <div className="page page-overview" aria-label={t('route.overview')}>
      <h1 className="visually-hidden">{t('route.overview')}</h1>
      <DoaReadout snapshot={snapshot} localSnapshotFresh={localSnapshotFresh} coordinate={coordinate} settings={settings} />
      {/* The map fills the Dashboard; the DoA polar graph floats over it and can be hidden. */}
      <div className="overview-spatial overview-fullmap">
        <Suspense fallback={<MapPlaceholder />}>
          <TacticalMap
            coordinate={coordinate}
            snapshot={snapshot}
            localSnapshotFresh={localSnapshotFresh}
            overlay={<PolarPanel snapshot={snapshot} localSnapshotFresh={localSnapshotFresh} compassSettings={settings} onHide={togglePolar} />}
            overlayVisible={polarVisible}
            onToggleOverlay={togglePolar}
          />
        </Suspense>
      </div>
    </div>
  );
}

export const OverviewPage = memo(OverviewPageView);
