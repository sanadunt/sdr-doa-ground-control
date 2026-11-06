import { describe, expect, it } from 'vitest';
import { DEFAULT_SIMULATION, simulationHalfPowerWidth, simulationScene, simulationSnapshot, simulationTheta, validateSimulation, randomizeSimulationSettings, simulationRayEnd } from './simulation';
import { bearingAndDistance, halfPowerWidth } from './doaGeometry';
import { positionEstimate, positionEstimateFeatures, positionEstimateLineLabels } from './positionEstimate';
import { translate } from './i18n';
import { bearingForView, geographicBearingForBin, polarView } from './polar';
import { overviewDoaStatus } from './doaStatus';

describe('local simulation', () => {
  it('randomizes valid angles and shapes without moving the station', () => {
    const widths = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const next = randomizeSimulationSettings(DEFAULT_SIMULATION);
      expect(validateSimulation(next)).toBe(true);
      expect(next.latitude).toBe(DEFAULT_SIMULATION.latitude);
      expect(next.longitude).toBe(DEFAULT_SIMULATION.longitude);
      expect(polarView(simulationSnapshot(next)).displayPeak).toBe(next.angle);
      widths.add(next.width);
    }
    expect(widths.size).toBeGreaterThan(1);
  });
  it('changes the curve shape when lobe width changes', () => {
    const narrow = polarView(simulationSnapshot({ ...DEFAULT_SIMULATION, width: 5 }));
    const wide = polarView(simulationSnapshot({ ...DEFAULT_SIMULATION, width: 60 }));
    const offPeak = (simulationTheta(DEFAULT_SIMULATION.angle) + 20) % 360;
    expect(narrow.values?.[offPeak]).toBeLessThan(wide.values?.[offPeak] ?? 0);
  });
  it.each([0, 45, 90, 180, 270, 315, 359])('reads the entered bearing %s the same on the readout, polar plot and map', angle => {
    const snapshot = simulationSnapshot({ ...DEFAULT_SIMULATION, angle });
    const view = polarView(snapshot);
    const theta = simulationTheta(angle);
    expect(snapshot.settings?.fields).toEqual({ doa_fig_type: 'Compass', compass_offset: 0 });
    expect(snapshot.doa_candidates?.csv.canonical_angle_deg).toBe(theta);
    // Peak bin is theta_0 (upstream convention), as on a live node.
    expect(view.peakIndex).toBe(theta);
    expect(bearingForView(view)).toBe(angle);
    expect(view.displayPeak).toBe(angle);
    expect(geographicBearingForBin(theta, 0)).toBe(angle);
    expect(overviewDoaStatus(snapshot, true).shown).toBe(true);
  });
  it.each([[0, 1, 0], [90, 0, 1], [180, -1, 0], [270, 0, -1]])('projects compass bearing %s', (bearing, north, east) => {
    const [lat, lon] = simulationRayEnd(0, 0, bearing);
    expect(lat).toBeCloseTo(north * 0.0089932, 5);
    expect(lon).toBeCloseTo(east * 0.0089932, 5);
  });
  it.each([0, 45, 180, 359])('renders a finite circular vector peaking at %s degrees', angle => {
    const snapshot = simulationSnapshot({ ...DEFAULT_SIMULATION, angle });
    const view = polarView(snapshot);
    expect(view.fresh).toBe(true);
    expect(view.values).toHaveLength(360);
    expect(view.values?.every(Number.isFinite)).toBe(true);
    expect(view.displayPeak).toBe(angle);
    expect(view.peakValue).toBe(-5);
    expect(snapshot.publication_gate?.state).toBe('BLOCKED');
    expect(snapshot.authority?.selected).toBeNull();
    expect(snapshot.simulation).toBe(true);
  });
  it.each([{ latitude: 91 }, { longitude: -181 }, { angle: 360 }, { width: 0 }, { angle: NaN }, { targetKm: 0.4 }, { targetKm: 9 }])('rejects invalid settings %o', invalid => {
    const settings = { ...DEFAULT_SIMULATION, ...invalid };
    expect(validateSimulation(settings)).toBe(false);
    expect(() => simulationSnapshot(settings)).toThrow();
  });
  it('does not mutate defaults or reuse vectors', () => {
    const a = simulationSnapshot(DEFAULT_SIMULATION);
    const b = simulationSnapshot(DEFAULT_SIMULATION);
    expect(a.doa_candidates?.csv.angular_power_db).not.toBe(b.doa_candidates?.csv.angular_power_db);
    expect(DEFAULT_SIMULATION.angle).toBe(45);
  });
});

describe('simulation lobe spread', () => {
  it.each([5, 18, 20, 33, 60])('shows the same -3 dB width as the map legend for sigma %s', (width) => {
    const settings = { ...DEFAULT_SIMULATION, width };
    const legend = halfPowerWidth(simulationSnapshot(settings).doa_candidates?.csv.angular_power_db ?? []);
    expect(simulationHalfPowerWidth(settings)).toBe(legend?.widthDeg);
  });

  it('is a Gaussian sigma, so the -3 dB width is about 0.74 of it', () => {
    expect(simulationHalfPowerWidth({ ...DEFAULT_SIMULATION, width: 20 })).toBe(15);
    expect(simulationHalfPowerWidth({ ...DEFAULT_SIMULATION, width: 0 })).toBeNull();
  });

  it('names the field a spread (sigma), not a width, in both languages', () => {
    expect(translate('en', 'sim.width')).toContain('σ');
    expect(translate('id', 'sim.width')).toContain('σ');
    expect(translate('id', 'sim.halfPower')).toBe('Lebar −3 dB');
  });
});

describe('simulation scene', () => {
  const settings = { ...DEFAULT_SIMULATION, angle: 60, targetKm: 3 };
  const scene = simulationScene(settings);
  const station = { latitude: settings.latitude, longitude: settings.longitude };

  it('puts the estimate near the transmitter on the entered bearing', () => {
    expect(scene).not.toBeNull();
    const estimate = scene!.estimate;
    expect(estimate.state).toBe('ESTIMATE');
    const from = bearingAndDistance(station, estimate.longitude!, estimate.latitude!);
    expect(Math.abs(from.distanceM - 3000)).toBeLessThan(150);
    expect(Math.abs(from.bearingDeg - 60)).toBeLessThan(5);
    expect(estimate.distanceM).toBe(Math.round(from.distanceM));
    expect(estimate.bearingSource).toBe('drone');
    expect(estimate.positionSource).toBe('drone');
  });

  it('measures the groundstation distance from the simulated groundstation', () => {
    const { ground, estimate } = scene!;
    expect(bearingAndDistance(station, ground.longitude, ground.latitude).distanceM).toBeCloseTo(900, -1);
    const from = bearingAndDistance(ground, estimate.longitude!, estimate.latitude!);
    expect(estimate.groundDistanceM).toBe(Math.round(from.distanceM));
    expect(estimate.groundLatitude).toBe(ground.latitude);
  });

  it('flies the drone from the groundstation to the station', () => {
    const { drone, ground } = scene!;
    expect(drone.position).toEqual(station);
    expect(drone.track[0]).toEqual([ground.longitude, ground.latitude]);
    const [lon, lat] = drone.track[drone.track.length - 1];
    expect(bearingAndDistance(station, lon, lat).distanceM).toBeLessThan(1);
    expect(drone.track.length).toBeGreaterThan(20);
    expect(drone.headingDeg).toBeGreaterThanOrEqual(0);
    expect(drone.headingDeg).toBeLessThan(360);
  });

  it('draws the heat, both lines and their labels on the map', () => {
    const estimate = scene!.estimate;
    expect(estimate.grid!.hot.length).toBeGreaterThan(10);
    expect(estimate.grid!.hot.length).toBeLessThanOrEqual(800);
    expect(estimate.grid!.hot[0][2]).toBeGreaterThan(0.9);
    const features = positionEstimateFeatures(estimate, station);
    expect(features.lines.features.map((line) => line.properties?.kind)).toEqual(['radius', 'link', 'ground']);
    const labels = positionEstimateLineLabels(estimate, station, (key, values) => translate('id', key, values));
    expect(labels).toHaveLength(2);
  });

  it('stays out of the live estimate and rejects invalid settings', () => {
    expect(positionEstimate(simulationSnapshot(settings))).toBeNull();
    expect(simulationScene({ ...settings, targetKm: 20 })).toBeNull();
  });
});
