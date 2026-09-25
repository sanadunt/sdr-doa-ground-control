import type { JSX } from 'react';
import type { CompassConfig, GpsConfig, TelemetrySnapshot } from '../types';
import { resolveGpsSource } from '../lib/map';
import { resolveCompassSource } from '../lib/polar';
import { PolarPanel } from '../components/PolarPanel';
import { TacticalMap } from '../components/TacticalMap';

export function OverviewPage({
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
  simulation?: import('../lib/simulation').SimulationSettings;
}): JSX.Element {
  const gpsResolution = resolveGpsSource(localSnapshotFresh ? snapshot : null, gpsConfig);
  const compassResolution = resolveCompassSource(localSnapshotFresh ? snapshot : null, { figType: compassConfig.manualFigType, compassOffset: compassConfig.manualCompassOffset }, compassConfig);
  return (
    <div className="page page-overview" aria-label="Overview">
      <h1 className="visually-hidden">Overview</h1>
      <div className="overview-spatial">
        <TacticalMap
          coordinate={simulation ? { latitude: simulation.latitude, longitude: simulation.longitude, source: 'SIMULATION' } : gpsResolution.coordinate}
          snapshot={snapshot}
          localSnapshotFresh={localSnapshotFresh}
        />
        <PolarPanel
          snapshot={snapshot}
          localSnapshotFresh={localSnapshotFresh}
          compassSettings={simulation ? { figType: 'Polar', compassOffset: 0 } : compassResolution.settings}
        />
      </div>
    </div>
  );
}
