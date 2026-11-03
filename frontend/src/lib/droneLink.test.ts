import { beforeEach, describe, expect, it } from 'vitest';
import type { TelemetrySnapshot } from '../types';
import {
  DRONE_TRACK_MAX,
  droneArrayHeadingAtDoa,
  droneArrayHeadingNow,
  droneFixLabel,
  droneStation,
  forgetDroneTrack,
  headingGap,
  normalizeDrone,
  positionGap,
  rememberDroneTrack,
  snapshotDrone,
} from './droneLink';
import { DEFAULT_GPS_CONFIG, resolveGpsSource } from './map';
import { DEFAULT_COMPASS_CONFIG, curveCompassOffset, resolveCompassSource } from './polar';

/** The drone block as tools/drone_link.py serves it, from tools/fixtures/drone/bridge-payloads.json. */
function block(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const aged = { age_ms: 300, stale: false };
  return {
    enabled: true,
    state: 'LIVE',
    connection: 'connected',
    host: '192.168.1.162',
    port: 1883,
    last_error: null,
    discovery: { mode: 'auto', scanning: false, last_scan_at_ms: 1, candidates: [{ host: '192.168.1.162', fc_online: true, version: '0.1.0' }] },
    position: { ...aged, lat: -6.9321, lon: 107.6612, alt_msl_m: 742.3, alt_rel_m: 25.4, speed_ms: 3.104, heading_deg: 87 },
    gps: { ...aged, fix: 6, fix_label: 'RTK_FIXED', rtk: 'FIXED', satellites: 22, hdop: 0.6 },
    attitude: { ...aged, roll_deg: 8.2, pitch_deg: -4.1, yaw_deg: 87.3 },
    battery: { ...aged, voltage_v: 6.1, current_a: 4.2, remaining_pct: null },
    status: { ...aged, armed: true, custom_mode: 4, system_status: 4, type_name: 'quadrotor' },
    hud: { ...aged, groundspeed_ms: 3.1, climb_ms: 0.2, throttle_pct: 52 },
    statustext: { severity: 6, text: 'EKF3 IMU0 is using GPS', age_ms: 5000 },
    link: { ...aged, fc_online: true, camera_online: true, frames_per_s: 41.5, version: '0.1.0', uptime_s: 10992, present: true },
    heading: { deg: 87.3, source: 'attitude', age_ms: 300 },
    heading_at_doa: { deg: 80, offset_ms: 120, source: 'attitude', doa_timestamp_ms: 1000, candidate: 'mqtt' },
    array_heading_offset_deg: 0,
    video_enabled: true,
    received: 9,
    invalid: 0,
    last_invalid: null,
    ...overrides,
  };
}

function snapshot(drone: unknown, extra: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return { drone, ...extra } as TelemetrySnapshot;
}

describe('normalizeDrone', () => {
  it('reads the server block', () => {
    const view = normalizeDrone(block());
    expect(view?.state).toBe('LIVE');
    expect(view?.gps?.rtk).toBe('FIXED');
    expect(view?.headingAtDoa).toEqual({ deg: 80, offset_ms: 120, source: 'attitude', doa_timestamp_ms: 1000 });
    expect(view?.candidates).toEqual([{ host: '192.168.1.162', fcOnline: true, version: '0.1.0' }]);
    expect(view?.battery?.remaining_pct).toBeNull();
  });

  it('reads a bad field as null, never the whole block', () => {
    const view = normalizeDrone(block({ state: 'BOGUS', position: { lat: 'x', lon: 107.6, stale: false, age_ms: 1 }, heading_at_doa: { deg: 999 } }));
    expect(view?.state).toBe('NO_DATA');
    expect(view?.position?.lat).toBeNull();
    expect(view?.headingAtDoa).toBeNull();
    expect(normalizeDrone(null)).toBeNull();
    expect(normalizeDrone([1])).toBeNull();
  });

  it('a simulation has no drone', () => {
    expect(snapshotDrone({ drone: block(), simulation: true } as TelemetrySnapshot)).toBeNull();
  });
});

describe('droneStation', () => {
  it('needs LIVE, a 3D fix and a fresh position', () => {
    expect(droneStation(normalizeDrone(block()))).toEqual({ latitude: -6.9321, longitude: 107.6612, source: 'DRONE' });
    expect(droneStation(normalizeDrone(block({ state: 'STALE' })))).toBeNull();
    expect(droneStation(normalizeDrone(block({ gps: { fix: 2, rtk: 'NONE', stale: false, age_ms: 1 } })))).toBeNull();
    expect(droneStation(normalizeDrone(block({ position: { lat: -6.9, lon: 107.6, stale: true, age_ms: 11000 } })))).toBeNull();
    expect(droneStation(normalizeDrone(block({ position: { lat: 0, lon: 0, stale: false, age_ms: 1 } })))).toBeNull();
  });
});

describe('headings', () => {
  it('turns the yaw by the array offset', () => {
    expect(droneArrayHeadingAtDoa(normalizeDrone(block()))).toBe(80);
    expect(droneArrayHeadingAtDoa(normalizeDrone(block({ array_heading_offset_deg: -90 })))).toBe(350);
    expect(droneArrayHeadingAtDoa(normalizeDrone(block({ heading_at_doa: null })))).toBeNull();
    expect(droneArrayHeadingNow(normalizeDrone(block({ array_heading_offset_deg: 10 })))).toBeCloseTo(97.3);
  });

  it('compares headings the short way', () => {
    expect(headingGap(10, 350)).toBe(20);
    expect(headingGap(350, 10)).toBe(-20);
    expect(headingGap(null, 10)).toBeNull();
  });

  it('labels the fix', () => {
    expect(droneFixLabel(normalizeDrone(block())?.gps ?? null)).toBe('RTK FIXED');
    expect(droneFixLabel(normalizeDrone(block({ gps: { fix: 3, fix_label: '3D', rtk: 'NONE', stale: false, age_ms: 1 } }))?.gps ?? null)).toBe('3D');
    expect(droneFixLabel(null)).toBe('—');
  });

  it('measures the gap between two positions', () => {
    const gap = positionGap({ latitude: -6.9321, longitude: 107.6612, source: 'DRONE' }, { latitude: -6.9321, longitude: 107.6613, source: 'NAV' });
    expect(gap?.distanceM).toBeGreaterThan(10);
    expect(gap?.distanceM).toBeLessThan(12);
    expect(positionGap(null, null)).toBeNull();
  });
});

describe('GPS source with the drone first', () => {
  it('takes the drone fix over the RDF-SDR', () => {
    const resolution = resolveGpsSource(snapshot(block()), DEFAULT_GPS_CONFIG);
    expect(resolution.coordinate?.source).toBe('DRONE');
    expect(resolution.label).toBe('DRONE GPS');
  });

  it('falls back when the drone has no fix or the operator turned it off', () => {
    expect(resolveGpsSource(snapshot(block({ state: 'STALE' })), DEFAULT_GPS_CONFIG).coordinate?.source).toBe('FALLBACK');
    expect(resolveGpsSource(snapshot(block()), { ...DEFAULT_GPS_CONFIG, preferDrone: false }).coordinate?.source).toBe('FALLBACK');
  });

  it('a manual position stays above the drone', () => {
    const resolution = resolveGpsSource(snapshot(block()), { source: 'MANUAL', manualLatitude: -7, manualLongitude: 110, preferDrone: true });
    expect(resolution.coordinate?.source).toBe('MANUAL');
  });
});

describe('compass source with the drone first', () => {
  const previous = { figType: 'Compass' as const, compassOffset: 0 };

  it('turns the bearing with the drone yaw at the DoA sample', () => {
    const resolution = resolveCompassSource(snapshot(block({ array_heading_offset_deg: 5 })), previous, DEFAULT_COMPASS_CONFIG);
    expect(resolution.code).toBe('DRONE_YAW');
    expect(resolution.settings.compassOffset).toBe(85);
    expect(resolution.label).toBe('DRONE YAW');
  });

  it('uses the RDF-SDR heading when no yaw matches the DoA time', () => {
    const answer = snapshot(block({ heading_at_doa: null }), {
      doa_candidates: { mqtt: { available: true, array_heading_deg: 120 } },
    } as Partial<TelemetrySnapshot>);
    expect(resolveCompassSource(answer, previous, DEFAULT_COMPASS_CONFIG).code).toBe('NODE_HEADING');
  });

  it('the operator can put the RDF-SDR heading first, and MANUAL stays above all', () => {
    const answer = snapshot(block(), { doa_candidates: { mqtt: { available: true, array_heading_deg: 120 } } } as Partial<TelemetrySnapshot>);
    expect(resolveCompassSource(answer, previous, { ...DEFAULT_COMPASS_CONFIG, preferDrone: false }).code).toBe('NODE_HEADING');
    expect(resolveCompassSource(answer, previous, { source: 'MANUAL', manualFigType: 'Compass', manualCompassOffset: 12, preferDrone: true }).code).toBe('MANUAL');
  });

  it('turns the Angular curve by how far the RDF-SDR turned between its frame and the DoA', () => {
    const answer = snapshot(block(), { doa_candidates: { mqtt: { available: true, array_heading_deg: 100, angular_heading_deg: 90 } } } as Partial<TelemetrySnapshot>);
    expect(curveCompassOffset(answer, { code: 'DRONE_YAW' }, 80)).toBe(70);
    expect(curveCompassOffset(snapshot(block()), { code: 'DRONE_YAW' }, 80)).toBe(80);
  });
});

describe('flown track', () => {
  beforeEach(() => forgetDroneTrack());

  it('adds a point per metre moved and keeps the same array otherwise', () => {
    const first = rememberDroneTrack(normalizeDrone(block()));
    expect(first).toHaveLength(1);
    expect(rememberDroneTrack(normalizeDrone(block()))).toBe(first);
    const moved = rememberDroneTrack(normalizeDrone(block({ position: { lat: -6.9322, lon: 107.6612, stale: false, age_ms: 1 } })));
    expect(moved).toHaveLength(2);
    expect(moved).not.toBe(first);
  });

  it('is forgotten when the remote changes and bounded', () => {
    rememberDroneTrack(normalizeDrone(block()));
    expect(rememberDroneTrack(normalizeDrone(block({ host: '10.0.0.5' })))).toHaveLength(1);
    for (let index = 0; index < DRONE_TRACK_MAX + 10; index += 1) {
      rememberDroneTrack(normalizeDrone(block({ host: '10.0.0.5', position: { lat: -6.9 - index * 0.0001, lon: 107.6, stale: false, age_ms: 1 } })));
    }
    expect(rememberDroneTrack(normalizeDrone(block({ host: '10.0.0.5', position: { lat: -6.9, lon: 107.6, stale: true, age_ms: 1 } })))).toHaveLength(DRONE_TRACK_MAX);
  });
});
