import type { JSX } from 'react';
import type { CompassConfig, GpsConfig, TelemetrySnapshot } from '../types';
import { resolveGpsSource } from '../lib/map';
import { resolveCompassSource } from '../lib/polar';
import { candidate } from '../lib/telemetry';
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
  const csv = candidate(snapshot, 'csv');
  const xml = candidate(snapshot, 'xml');
  const vectorReady = localSnapshotFresh && Array.isArray(csv.angular_power_db) && csv.angular_power_db.length === 360;
  return (
    <div className="page page-overview">
      <div className="overview-intro">
        <div>
          <div className="panel-eyebrow">Observation workspace</div>
          <h1>Direction finding</h1>
          <p>Station reference and native angular response. Observation is not delivery readiness.</p>
        </div>
        <div className="overview-facts" aria-label="Overview data facts">
          <span>CSV {csv.available === true ? 'PRESENT' : '—'}</span>
          <span>XML {xml.available === true ? 'PRESENT' : '—'}</span>
          <span>VECTOR {vectorReady ? '360' : '—'}</span>
        </div>
      </div>
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
