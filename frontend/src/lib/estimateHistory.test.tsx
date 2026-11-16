import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TelemetrySnapshot } from '../types';
import { EstimatePanel } from '../components/overview/EstimatePanel';
import { EstimatePlaybackBar } from '../components/overview/EstimatePlaybackBar';
import { bearingAndDistance } from './doaGeometry';
import { estimateAfter } from './estimateEngine';
import { formatPlaybackTime, raysAt, withGround, type Playback } from './estimatePlayback';
import { estimateExportUrl, parseSession, parseSessionList } from './estimateSessions';
import { simulatedFlight } from './estimateSimulation';
import { I18nContext, translate, type Lang } from './i18n';
import { estimateLocated, estimateMapLabel, estimateRayFeatures, positionEstimate, positionEstimateFeatures } from './positionEstimate';
import { DEFAULT_SIMULATION } from './simulation';
import { validateOverlaySettings } from './mapOverlaySettings';

function render(element: ReactElement, lang: Lang = 'id'): string {
  return renderToStaticMarkup(createElement(I18nContext.Provider, { value: { lang, setLang: () => undefined, t: (key, vars) => translate(lang, key, vars) } }, element));
}

const ROUGH = {
  state: 'ROUGH', latitude: -6.902, longitude: 107.62, radius_m: 1800, distance_m: 3400, bearing_deg: 294.3,
  samples: 12, unverified_samples: 4, stations: 4, spread_deg: 6.2, frequency_hz: 433_920_000, reset_reason: null,
  method: { min_stations: 3, min_spread_deg: 10, rough_min_stations: 2, rough_spread_deg: 3 },
  rays: [[1000, -6.93, 107.71, 300.5, 1], [4000, -6.931, 107.712, 301.2, 0], [7000, -6.932, 107.714, 'x', 1], [9000, -6.933, 107.716, 302, 2]],
  grid: null,
};

function snapshot(estimate: unknown): TelemetrySnapshot {
  return { position_estimate: estimate as Record<string, unknown> } as TelemetrySnapshot;
}

describe('the rough estimate and its rays', () => {
  it('reads ROUGH, the thresholds, the unverified count and the good rays', () => {
    const estimate = positionEstimate(snapshot(ROUGH));
    expect(estimate?.state).toBe('ROUGH');
    expect([estimate?.unverifiedSamples, estimate?.roughMinStations, estimate?.roughSpreadDeg, estimate?.minSpreadDeg]).toEqual([4, 2, 3, 10]);
    expect(estimate?.rays.map((ray) => [ray.tMs, ray.verified])).toEqual([[1000, true], [4000, false]]);
    expect(estimateLocated(estimate ?? null)).toBe(true);
  });

  it('draws a rough point, radius and link, marked rough', () => {
    const estimate = positionEstimate(snapshot(ROUGH));
    const shapes = positionEstimateFeatures(estimate, { latitude: -6.93, longitude: 107.71 });
    expect(shapes.point.features[0].properties).toEqual({ rough: true });
    expect(shapes.lines.features.map((line) => [line.properties?.kind, line.properties?.rough])).toEqual([['radius', true], ['link', true]]);
    expect(estimateMapLabel(estimate!, 'latlon', (key) => translate('id', key)).above).toBe('ESTIMASI KASAR · ±1.8 km');
  });

  it('draws every ray from its place past the estimate, newest least faded, and the path', () => {
    const estimate = positionEstimate(snapshot(ROUGH))!;
    const { rays, path } = estimateRayFeatures(estimate);
    expect(rays.features.map((ray) => ray.properties)).toEqual([{ age: 1, verified: true }, { age: 0, verified: false }]);
    const [start, end] = rays.features[0].geometry.coordinates as Array<[number, number]>;
    expect(start).toEqual([107.71, -6.93]);
    const reach = bearingAndDistance({ latitude: start[1], longitude: start[0] }, end[0], end[1]);
    const toEstimate = bearingAndDistance({ latitude: -6.93, longitude: 107.71 }, 107.62, -6.902);
    // 30% past the estimate, at most 10 km.
    expect(reach.distanceM).toBeCloseTo(Math.min(10_000, toEstimate.distanceM * 1.3), -1);
    expect(reach.bearingDeg).toBeCloseTo(300.5, 1);
    expect(path.features[0].geometry.coordinates).toHaveLength(2);
    expect(estimateRayFeatures(null).rays.features).toHaveLength(0);
  });

  it('keeps the history lines on unless switched off, also for an older stored setting', () => {
    expect(validateOverlaySettings({}).estimateRaysVisible).toBe(true);
    expect(validateOverlaySettings({ estimateRaysVisible: false }).estimateRaysVisible).toBe(false);
  });

  it('shows the rough tag, the unverified count and History on the card', () => {
    const html = render(createElement(EstimatePanel, { estimate: positionEstimate(snapshot(ROUGH))! }));
    expect(html).toContain('KASAR');
    expect(html).toContain('4 belum valid');
    expect(html).toContain('Riwayat');
    expect(html).toContain('Estimasi kasar');
    const plain = render(createElement(EstimatePanel, { estimate: positionEstimate(snapshot(ROUGH))!, history: false, viewOnly: true }));
    expect(plain).not.toContain('Riwayat');
    expect(plain).not.toContain('Mulai ulang');
  });
});

describe('recorded sessions', () => {
  const id = 'a'.repeat(32);
  it('reads the list and leaves out bad rows', () => {
    const list = parseSessionList({
      available: true, current_id: id,
      sessions: [
        { id, started_ms: 1, last_ms: 9, frequency_hz: 433_920_000, samples: 51, unverified: 3, estimate: { state: 'ESTIMATE', radius_m: 120, stations: 40 } },
        { id: 'nope', started_ms: 1, last_ms: 2 },
      ],
    });
    expect(list.sessions).toHaveLength(1);
    expect([list.currentId, list.sessions[0].state, list.sessions[0].radiusM]).toEqual([id, 'ESTIMATE', 120]);
    expect(parseSessionList(null)).toEqual({ available: false, sessions: [], currentId: null });
  });

  it('reads one session\'s rays', () => {
    const session = parseSession({ id, started_ms: 1, last_ms: 9, samples: [[1, -6.9, 107.6, 10.5, 1, 433_920_000], [2, 95, 107.6, 10, 1, 1], [3, -6.9, 107.6, 11, 0, 433_920_000]], estimate: {} });
    expect(session?.rays.map((ray) => [ray.tMs, ray.verified])).toEqual([[1, true], [3, false]]);
    expect(estimateExportUrl(id, 'kml')).toBe(`/api/position-estimate/sessions/${id}/export.kml`);
  });
});

describe('the simulated flight', () => {
  it('flies, takes noisy rays and narrows onto the transmitter', () => {
    const flight = simulatedFlight({ ...DEFAULT_SIMULATION, targetKm: 2 }, 4);
    expect(flight).not.toBeNull();
    const { rays, transmitter } = flight!;
    expect(rays.length).toBeGreaterThan(60);
    expect(rays.filter((ray) => !ray.verified).length).toBe(Math.floor(rays.length / 3));
    const early = estimateAfter(rays, 12);
    const final = estimateAfter(rays, rays.length);
    expect(final.state).toBe('ESTIMATE');
    expect(final.radiusM).toBeLessThan(early.radiusM ?? Infinity);
    const miss = bearingAndDistance(transmitter, final.longitude!, final.latitude!).distanceM;
    expect(miss).toBeLessThan(250);
    // The same settings fly the same flight.
    expect(simulatedFlight({ ...DEFAULT_SIMULATION, targetKm: 2 }, 4)!.rays[5]).toEqual(rays[5]);
    expect(simulatedFlight(DEFAULT_SIMULATION, 99)).toBeNull();
  });
});

describe('playback', () => {
  const rays = [0, 3000, 6000, 9000].map((tMs) => ({ tMs: 1000 + tMs, latitude: -6.9, longitude: 107.6, bearingDeg: 10, verified: true, frequencyHz: 1 }));
  it('counts the rays up to the cursor', () => {
    expect([raysAt(rays, 0), raysAt(rays, 2999), raysAt(rays, 3000), raysAt(rays, 60_000), raysAt([], 5)]).toEqual([1, 1, 2, 4, 0]);
  });

  it('writes the time and adds the groundstation\'s distance', () => {
    expect([formatPlaybackTime(65_000), formatPlaybackTime(3_725_000)]).toEqual(['1:05', '1:02:05']);
    const estimate = withGround({ ...estimateAfter([], 0), latitude: -6.9, longitude: 107.61 }, { latitude: -6.9, longitude: 107.6 });
    expect(estimate.groundDistanceM).toBeGreaterThan(1000);
  });

  it('shows the bar with its tag, controls and the simulation\'s miss', () => {
    const playback: Playback = {
      active: true, kind: 'simulation', playing: true, speed: 5, cursorMs: 65_000, durationMs: 300_000, count: 22,
      estimate: null, drone: null, truth: { actualM: 1800, errorM: 140 },
      play: () => undefined, pause: () => undefined, restart: () => undefined, seek: () => undefined, setSpeed: () => undefined,
    };
    const html = render(createElement(EstimatePlaybackBar, { playback }));
    expect(html).toContain('SIMULASI');
    expect(html).toContain('1:05 dari 5:00');
    expect(html).toContain('22 garis');
    expect(html).toContain('Sebenarnya 1.8 km · meleset 140 m');
    expect(html).not.toContain('Tutup putar ulang');
    const replay = render(createElement(EstimatePlaybackBar, { playback: { ...playback, kind: 'replay', truth: null }, onClose: () => undefined }), 'en');
    expect(replay).toContain('REPLAY');
    expect(replay).toContain('Close replay');
    expect(render(createElement(EstimatePlaybackBar, { playback, loading: true }))).toContain('Memuat rekaman');
  });
});
