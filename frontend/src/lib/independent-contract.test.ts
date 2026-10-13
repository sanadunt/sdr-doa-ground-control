import { describe, expect, it } from 'vitest';
import type { Candidate, TelemetrySnapshot } from '../types';
import {
  coordinateFromCandidate,
  manualGpsOverrideFromInput,
  manualMapReadiness,
  mapHasCoordinateConflict,
  mapReadiness,
  resolveStationCoordinate,
} from './map';
import {
  DEFAULT_CONSOLE_CONFIG,
  completeVector,
  formatNumber,
  nativeViewsReady,
  numberOrNull,
  polarDataReady,
} from './telemetry';
import {
  angularDirection,
  bearingForView,
  compassOffsetSourceLabel,
  DATA_OUT_SETTINGS_MAX_AGE_MS,
  dataOutCompassFromSnapshot,
  displayAngleForBin,
  DEFAULT_COMPASS_CONFIG,
  formatDegrees,
  geographicBearingForBin,
  manualCompassOverrideFromInput,
  manualCompassSettings,
  normalizeDegrees,
  polarSettings,
  polarView,
  rememberDataOutCompass,
  resolveCompassSource,
  screenAngleForBin,
  signedPeak,
} from './polar';
import { translate } from './i18n';

const VECTOR_SIZE = 360;

function vector(fill = -20): number[] {
  return Array.from({ length: VECTOR_SIZE }, () => fill);
}

function candidate(overrides: Record<string, unknown> = {}): Candidate {
  return {
    available: true,
    freshness: { fresh: true, age_ms: 1_000 },
    latitude: 12.34,
    longitude: 56.78,
    canonical_angle_deg: 42,
    angular_power_db: vector(),
    angular_peak_index: 0,
    angular_peak_db: -20,
    ...overrides,
  } as Candidate;
}

function snapshot(
  csv: Candidate | null = candidate(),
  xml: Candidate | null = candidate(),
  overrides: Partial<TelemetrySnapshot> = {},
): TelemetrySnapshot {
  const candidates: Record<string, Candidate> = {};
  if (csv) candidates.csv = csv;
  if (xml) candidates.xml = xml;
  return {
    status: { available: true, safe: { gps_status: 'FIX' } },
    doa_candidates: candidates,
    native_consistency: { comparable: true, conflict: false },
    ...overrides,
  } as TelemetrySnapshot;
}

function expectNoMap(value: TelemetrySnapshot): void {
  expect(resolveStationCoordinate(value)).toBeNull();
  expect(mapReadiness(value).ready).toBe(false);
}

describe('map coordinate contract', () => {
  it.each([
    ['null latitude', { latitude: null }],
    ['null longitude', { longitude: null }],
    ['string latitude', { latitude: '12.34' }],
    ['string longitude', { longitude: '56.78' }],
  ] as Array<[string, Record<string, unknown>]>)(
    'rejects malformed %s instead of coercing it into a coordinate',
    (_label, overrides) => {
      expect(coordinateFromCandidate(candidate(overrides), 'CSV')).toBeNull();
    },
  );

  it.each([
    ['missing GPS status', undefined],
    ['unknown GPS status', 'UNKNOWN'],
    ['unrecognized GPS status', 'future-status'],
  ] as Array<[string, unknown]>)(
    'withholds the map when GPS status is %s',
    (_label, gpsStatus) => {
      const safe: Record<string, unknown> = {};
      if (gpsStatus !== undefined) safe.gps_status = gpsStatus;
      expectNoMap(snapshot(candidate(), candidate(), {
        status: { available: true, safe },
      }));
    },
  );

  it('withholds the map when only one native source has coordinates', () => {
    expectNoMap(snapshot(candidate(), null));
  });

  it('withholds the map when native views are not comparable', () => {
    expectNoMap(snapshot(candidate(), candidate(), {
      native_consistency: { comparable: false, conflict: false },
    }));
  });

  it('withholds the map when native views are in conflict', () => {
    expectNoMap(snapshot(candidate(), candidate(), {
      native_consistency: { comparable: true, conflict: true },
    }));
  });

  it('withholds the map when the two fresh coordinate candidates conflict', () => {
    const value = snapshot(
      candidate({ latitude: 12.34, longitude: 56.78 }),
      candidate({ latitude: 12.35, longitude: 56.78 }),
    );

    expect(mapHasCoordinateConflict(value)).toBe(true);
    expect(mapReadiness(value).label).toBe('CONFLICT');
    expectNoMap(value);
  });

  it('withholds the map when coordinate candidates are stale', () => {
    const stale = { fresh: false, age_ms: 60_000 };
    expectNoMap(snapshot(
      candidate({ freshness: stale }),
      candidate({ freshness: stale }),
    ));
  });
});

describe('local manual GPS and Compass controls', () => {
  it.each([
    ['empty latitude', '', '106.8', 'Latitude must be a finite number.'],
    ['out-of-range latitude', '91', '106.8', 'Latitude must be between −90 and 90.'],
    ['out-of-range longitude', '-6.2', '181', 'Longitude must be between −180 and 180.'],
    ['unset Null Island', '0', '0', 'Latitude and longitude cannot both be 0.'],
  ] as Array<[string, unknown, unknown, string]>)('rejects %s', (_label, latitude, longitude, error) => {
    const result = manualGpsOverrideFromInput(latitude, longitude);
    expect(result.override).toBeNull();
    expect(result.error).toBe(error);
  });

  it('accepts a bounded local GPS position without changing the live snapshot contract', () => {
    const result = manualGpsOverrideFromInput('-6.2', '106.816666');
    expect(result.error).toBeNull();
    expect(result.override).toEqual({ enabled: true, latitude: -6.2, longitude: 106.816666 });
    expect(manualMapReadiness(result.override)).toEqual({
      ready: true,
      label: 'LOCAL GPS OVERRIDE',
      detail: 'The online OSM viewport can load around this entered coordinate; live telemetry remains untouched.',
    });
    expect(mapReadiness(null, result.override).ready).toBe(true);
  });

  it('changes only renderer settings for local Compass and never creates a vector', () => {
    const result = manualCompassOverrideFromInput('Compass', '37.5');
    expect(result.error).toBeNull();
    expect(result.override).toEqual({ enabled: true, figType: 'Compass', compassOffset: 37.5 });
    expect(manualCompassSettings(result.override)).toEqual({ figType: 'Compass', compassOffset: 37.5 });
    const view = polarView(null, { figType: 'Polar', compassOffset: 0 }, true, result.override);
    expect(view.settings).toEqual({ figType: 'Compass', compassOffset: 37.5 });
    expect(view.values).toBeNull();
    expect(view.fresh).toBe(false);
  });
});

describe('telemetry numeric and polar readiness contracts', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace string', '   '],
    ['unknown string', 'unknown'],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ] as Array<[string, unknown]>)(
    'formats %s as unavailable rather than zero',
    (_label, value) => {
      expect(numberOrNull(value)).toBeNull();
      expect(formatNumber(value)).not.toBe('0.0');
    },
  );

  it('requires both fresh native views and an explicit comparable result', () => {
    const fresh = snapshot();
    expect(nativeViewsReady(fresh)).toBe(true);
    expect(nativeViewsReady(snapshot(candidate(), candidate(), {
      native_consistency: { comparable: false, conflict: false },
    }))).toBe(false);
    expect(nativeViewsReady(snapshot(candidate(), candidate({ freshness: { fresh: false, age_ms: 60_000 } })))).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['short', vector().slice(0, VECTOR_SIZE - 1)],
  ] as Array<[string, unknown]>)(
    'clears the polar view for an %s angular vector',
    (_label, angularPower) => {
      const value = snapshot(candidate({ angular_power_db: angularPower }));
      expect(completeVector(value.doa_candidates?.csv)).toBe(false);
      expect(polarDataReady(value)).toBe(false);
      const view = polarView(value);
      expect(view.fresh).toBe(false);
      expect(view.values).toBeNull();
    },
  );

  it('clears the polar view when the snapshot is null', () => {
    const view = polarView(null);
    expect(view.fresh).toBe(false);
    expect(view.values).toBeNull();
    expect(view.canonicalAngle).toBeNull();
  });

  it.each([
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ] as Array<[string, number]>)(
    'clears a 360-bin polar vector containing %s',
    (_label, invalidValue) => {
      const angularPower = vector();
      angularPower[17] = invalidValue;
      const value = snapshot(candidate({ angular_power_db: angularPower }));
      expect(completeVector(value.doa_candidates?.csv)).toBe(false);
      expect(polarDataReady(value)).toBe(false);
      expect(polarView(value).values).toBeNull();
    },
  );

  it('does not select a peak from an incomplete or nonfinite vector', () => {
    expect(signedPeak(vector().slice(0, VECTOR_SIZE - 1))).toBeNull();
    const nonfinite = vector();
    nonfinite[3] = Number.NaN;
    expect(signedPeak(nonfinite)).toBeNull();
  });
});

describe('polar compass transforms', () => {
  it('uses Data Out Compass settings only when the current snapshot is usable', () => {
    const dataOutSnapshot = snapshot(candidate(), candidate(), {
      settings: { fields: { doa_fig_type: 'Compass', compass_offset: 10 } },
    });
    expect(resolveCompassSource(dataOutSnapshot, undefined, DEFAULT_COMPASS_CONFIG).label).toBe('DATA_OUT COMPASS');
    expect(resolveCompassSource(null, undefined, DEFAULT_COMPASS_CONFIG).label).toBe('DATA_OUT COMPASS · DEFAULT FALLBACK');
    const malformed = snapshot(candidate(), candidate(), {
      settings: { fields: { doa_fig_type: 'not-a-display-axis', compass_offset: 'bad' } },
    });
    expect(resolveCompassSource(malformed, undefined, DEFAULT_COMPASS_CONFIG).label).toBe('DATA_OUT COMPASS · DEFAULT FALLBACK');
  });

  it('preserves a finite string compass offset from Data Out', () => {
    expect(polarSettings('Compass', '17.5')).toEqual({ figType: 'Compass', compassOffset: 17.5 });
  });

  it('normalizes compass display angles with the configured offset', () => {
    const compass = polarSettings('Compass', 10);
    expect(compass).toEqual({ figType: 'Compass', compassOffset: 10 });
    expect(displayAngleForBin(0, compass)).toBe(10);
    expect(displayAngleForBin(90, compass)).toBe(280);
    expect(displayAngleForBin(350, polarSettings('compass', -20))).toBe(350);
    expect(displayAngleForBin(90, polarSettings('Polar', 10))).toBe(90);
    expect(normalizeDegrees(-10)).toBe(350);
    expect(normalizeDegrees(730)).toBe(10);
  });

  it('maps theta_0 to a north-clockwise geographic bearing that matches the Compass display peak', () => {
    for (const offset of [0, 30, -20]) {
      for (const theta of [0, 90, 180, 270]) {
        expect(geographicBearingForBin(theta, offset)).toBe(displayAngleForBin(theta, polarSettings('Compass', offset)));
      }
    }
    expect(geographicBearingForBin(90, 0)).toBe(270);
    expect(geographicBearingForBin(90, 30)).toBe(300);
    expect(geographicBearingForBin(0, Number.NaN)).toBe(0);
  });

  it('applies the compass transform once to the polar view peak', () => {
    const angularPower = vector();
    angularPower[90] = 5;
    const value = snapshot(
      candidate({ angular_power_db: angularPower, angular_peak_index: 90, angular_peak_db: 5 }),
      candidate(),
      { settings: { fields: { doa_fig_type: 'Compass', compass_offset: 10 } } },
    );

    const view = polarView(value);
    expect(view.fresh).toBe(true);
    expect(view.peakIndex).toBe(90);
    expect(view.peakValue).toBe(5);
    expect(view.displayPeak).toBe(280);
  });
});

describe('polar orientation against upstream KrakenSDR', () => {
  // Upstream kraken_web_doa.py: Polar plots theta = bin with Plotly's default
  // counter-clockwise axis at rotation 90; Compass plots theta = 360 - bin + offset
  // on a clockwise axis. Screen angles below are degrees clockwise from the top.
  const upstreamPolarScreen = (bin: number) => normalizeDegrees(-bin);

  it('draws Polar counter-clockwise like upstream, so Polar and Compass at offset 0 coincide on screen', () => {
    const polar = polarSettings('Polar', 0);
    const compass = polarSettings('Compass', 0);
    expect(angularDirection(polar)).toBe('counterclockwise');
    expect(angularDirection(compass)).toBe('clockwise');
    for (const bin of [0, 45, 60, 90, 180, 270, 359]) {
      expect(screenAngleForBin(bin, polar)).toBe(upstreamPolarScreen(bin));
      expect(screenAngleForBin(bin, compass)).toBe(screenAngleForBin(bin, polar));
      // Polar keeps theta_0 as its label; Compass labels the bin with its bearing.
      expect(displayAngleForBin(bin, polar)).toBe(bin);
      expect(displayAngleForBin(bin, compass)).toBe(geographicBearingForBin(bin, 0));
    }
  });

  it('labels the Compass peak with the upstream compass value and the north-clockwise bearing', () => {
    for (const offset of [0, 30, -20]) {
      for (const bin of [0, 60, 90, 180, 270]) {
        const upstreamLabel = normalizeDegrees(360 - bin + offset);
        const compass = polarSettings('Compass', offset);
        expect(displayAngleForBin(bin, compass)).toBe(upstreamLabel);
        // The console's Compass axis is north-up: the label is also the screen position.
        expect(screenAngleForBin(bin, compass)).toBe(upstreamLabel);
      }
    }
  });

  it('gives the readout the geographic bearing of theta_0, not the raw array angle', () => {
    const angularPower = vector();
    angularPower[60] = 5;
    const value = snapshot(candidate({ canonical_angle_deg: 60, angular_power_db: angularPower }), candidate({ canonical_angle_deg: 60 }));
    expect(bearingForView(polarView(value, undefined, true, null, { figType: 'Compass', compassOffset: 0 }))).toBe(300);
    expect(bearingForView(polarView(value, undefined, true, null, { figType: 'Compass', compassOffset: 30 }))).toBe(330);
    // The Polar axis choice does not change the geographic bearing.
    expect(bearingForView(polarView(value, undefined, true, null, { figType: 'Polar', compassOffset: 30 }))).toBe(330);
    expect(bearingForView(polarView(null))).toBeNull();
  });

  it('rounds before wrapping so north never reads 360', () => {
    expect(formatDegrees(359.96, 1)).toBe('0.0');
    expect(formatDegrees(359.6)).toBe('0');
    expect(formatDegrees(-0.04, 1)).toBe('0.0');
    expect(formatDegrees(12.34, 1)).toBe('12.3');
    expect(formatDegrees(Number.NaN)).toBe('N/A');
  });
});

describe('Data Out compass settings resolution', () => {
  const NODE = 'http://doasdr.local:8081';
  function settingsSnapshot(fields: Record<string, unknown> | null, observedAt = 1_000_000, baseUrl = NODE): TelemetrySnapshot {
    return snapshot(candidate(), candidate(), {
      collector: { base_url: baseUrl },
      observed_at_ms: observedAt,
      settings: fields === null ? { available: false } : { available: true, fields },
    });
  }
  const LOCAL = { figType: 'Compass' as const, compassOffset: 0 };

  it('keeps the Data Out offset when the plot type is Linear (KrakenSDR default)', () => {
    const resolution = resolveCompassSource(settingsSnapshot({ doa_fig_type: 'Linear', compass_offset: 30 }), LOCAL, DEFAULT_COMPASS_CONFIG);
    expect(resolution.settings).toEqual({ figType: 'Compass', compassOffset: 30 });
    expect(resolution.code).toBe('DATA_OUT_LOCAL_AXIS');
    expect(resolution.label).toBe('DATA_OUT OFFSET · LOCAL AXIS');
    expect(resolution.offsetVerified).toBe(true);
  });

  it('marks a missing offset as local and unverified', () => {
    const resolution = resolveCompassSource(settingsSnapshot({ doa_fig_type: 'Polar' }), LOCAL, DEFAULT_COMPASS_CONFIG);
    expect(resolution.settings).toEqual({ figType: 'Polar', compassOffset: 0 });
    expect(resolution.code).toBe('DATA_OUT_LOCAL_OFFSET');
    expect(resolution.offsetVerified).toBe(false);
  });

  it('reuses the last Data Out settings when one settings.json read fails, and labels it', () => {
    let memory = rememberDataOutCompass(null, settingsSnapshot({ doa_fig_type: 'Compass', compass_offset: 45 }, 1_000_000));
    const failed = settingsSnapshot(null, 1_002_000);
    memory = rememberDataOutCompass(memory, failed);
    const resolution = resolveCompassSource(failed, LOCAL, DEFAULT_COMPASS_CONFIG, memory);
    expect(resolution.settings).toEqual({ figType: 'Compass', compassOffset: 45 });
    expect(resolution.effectiveSource).toBe('DATA_OUT');
    expect(resolution.label).toBe('DATA_OUT COMPASS · LAST KNOWN');
    expect(resolution.lastKnownAgeMs).toBe(2_000);
    expect(compassOffsetSourceLabel(resolution, (key, vars) => translate('en', key, vars))).toBe('DATA_OUT last known 2.0 s');
    // The age unit follows the UI language like every other duration.
    expect(compassOffsetSourceLabel(resolution, (key, vars) => translate('id', key, vars))).toBe('DATA_OUT terakhir diketahui 2.0 dtk');
  });

  it('falls back explicitly when the remembered settings are too old or from another node', () => {
    const memory = dataOutCompassFromSnapshot(settingsSnapshot({ doa_fig_type: 'Compass', compass_offset: 45 }, 1_000_000));
    const late = settingsSnapshot(null, 1_000_000 + DATA_OUT_SETTINGS_MAX_AGE_MS + 1);
    expect(resolveCompassSource(late, LOCAL, DEFAULT_COMPASS_CONFIG, memory).label).toBe('DATA_OUT COMPASS · DEFAULT FALLBACK');
    const otherNode = settingsSnapshot(null, 1_001_000, 'http://192.168.100.100:8081');
    expect(rememberDataOutCompass(memory, otherNode)).toBeNull();
    const fallback = resolveCompassSource(otherNode, LOCAL, DEFAULT_COMPASS_CONFIG, memory);
    expect(fallback.code).toBe('DATA_OUT_UNAVAILABLE');
    expect(fallback.offsetVerified).toBe(false);
    expect(compassOffsetSourceLabel(fallback, (key, vars) => translate('en', key, vars))).toBe('assumed');
  });

  it('never learns compass settings from a simulation snapshot', () => {
    const simulation = { ...settingsSnapshot({ doa_fig_type: 'Polar', compass_offset: 0 }), simulation: true };
    expect(dataOutCompassFromSnapshot(simulation)).toBeNull();
    const memory = dataOutCompassFromSnapshot(settingsSnapshot({ doa_fig_type: 'Compass', compass_offset: 12 }));
    expect(rememberDataOutCompass(memory, simulation)).toBe(memory);
  });

  it('lets manual settings win over Data Out', () => {
    const resolution = resolveCompassSource(
      settingsSnapshot({ doa_fig_type: 'Compass', compass_offset: 45 }),
      LOCAL,
      { source: 'MANUAL', manualFigType: 'Polar', manualCompassOffset: 12.5 },
    );
    expect(resolution.settings).toEqual({ figType: 'Polar', compassOffset: 12.5 });
    expect(compassOffsetSourceLabel(resolution, (key, vars) => translate('en', key, vars))).toBe('MANUAL');
  });
});

describe('default Ground Console MQTT profile', () => {
  it('uses the Ground broker IP and port', () => {
    expect(DEFAULT_CONSOLE_CONFIG).toMatchObject({
      mqtt_host: '10.90.0.1',
      mqtt_port: 9001,
    });
  });
});
