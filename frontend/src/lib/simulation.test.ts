import { describe, expect, it } from 'vitest';
import { DEFAULT_SIMULATION, simulationSnapshot, validateSimulation, randomizeSimulationSettings, simulationRayEnd } from './simulation';
import { polarView } from './polar';

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
    expect(narrow.values?.[65]).toBeLessThan(wide.values?.[65] ?? 0);
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
  it.each([{ latitude: 91 }, { longitude: -181 }, { angle: 360 }, { width: 0 }, { angle: NaN }])('rejects invalid settings %o', invalid => {
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