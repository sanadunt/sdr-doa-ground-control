import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bearingAndDistance, type GeoOrigin } from './doaGeometry';
import { EstimateEngine, type EstimateSample } from './estimateEngine';
import type { PositionEstimate } from './positionEstimate';

/**
 * Plays a list of rays back through the browser's copy of the console's
 * estimate (lib/estimateEngine.ts): a recorded session (replay) or a simulated
 * flight. The cursor runs over the rays' own times at a chosen speed; the
 * estimate, its history lines and the drone's place and track are those at the
 * cursor, so the map draws the session as it grew.
 */
export type PlaybackKind = 'replay' | 'simulation';

export interface PlaybackSource {
  kind: PlaybackKind;
  /** Changes when another session or flight is loaded; the cursor starts over. */
  key: string;
  rays: EstimateSample[];
  /** The simulated transmitter, for the error readout; null for a replay. */
  transmitter: GeoOrigin | null;
}

export const PLAYBACK_SPEEDS = [1, 5, 20, 60] as const;
export type PlaybackSpeed = typeof PLAYBACK_SPEEDS[number];
const TICK_MS = 200;
const TRACK_POINTS = 2000;

export interface PlaybackDrone {
  position: GeoOrigin;
  headingDeg: number | null;
  track: Array<[number, number]>;
}

export interface Playback {
  active: boolean;
  kind: PlaybackKind | null;
  playing: boolean;
  speed: PlaybackSpeed;
  /** Milliseconds since the first ray, and the whole span. */
  cursorMs: number;
  durationMs: number;
  /** Rays up to the cursor. */
  count: number;
  estimate: PositionEstimate | null;
  drone: PlaybackDrone | null;
  /** Simulation: distance from the drone to the transmitter and the estimate's miss, metres. */
  truth: { actualM: number; errorM: number | null } | null;
  play: () => void;
  pause: () => void;
  restart: () => void;
  seek: (ms: number) => void;
  setSpeed: (speed: PlaybackSpeed) => void;
}

/** How many rays fall at or before `cursorMs` after the first one. */
export function raysAt(rays: readonly EstimateSample[], cursorMs: number): number {
  if (!rays.length) return 0;
  const end = rays[0].tMs + cursorMs;
  let low = 0;
  let high = rays.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rays[mid].tMs <= end) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** The estimate with the groundstation's distance and bearing to it, as the console adds them. */
export function withGround(estimate: PositionEstimate, ground: GeoOrigin | null): PositionEstimate {
  if (!ground || estimate.latitude === null || estimate.longitude === null) return estimate;
  const { bearingDeg, distanceM } = bearingAndDistance(ground, estimate.longitude, estimate.latitude);
  return {
    ...estimate,
    groundLatitude: ground.latitude,
    groundLongitude: ground.longitude,
    groundDistanceM: Math.round(distanceM),
    groundBearingDeg: Math.round(bearingDeg * 10) / 10,
  };
}

export function usePlayback(source: PlaybackSource | null, ground: GeoOrigin | null, initialSpeed: PlaybackSpeed = 20): Playback {
  const [cursorMs, setCursorMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(initialSpeed);
  const rays = source?.rays ?? [];
  const durationMs = rays.length ? rays[rays.length - 1].tMs - rays[0].tMs : 0;
  const key = source?.key ?? null;

  // A new source starts from the beginning and plays.
  useEffect(() => {
    setCursorMs(0);
    setPlaying(key !== null);
    setSpeed(initialSpeed);
  }, [key, initialSpeed]);

  useEffect(() => {
    if (!playing || key === null) return undefined;
    const timer = window.setInterval(() => {
      setCursorMs((current) => {
        const next = Math.min(durationMs, current + TICK_MS * speed);
        if (next >= durationMs) setPlaying(false);
        return next;
      });
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [playing, speed, durationMs, key]);

  const count = raysAt(rays, cursorMs);
  // The engine follows the cursor forward one ray at a time; a step back starts it over.
  const engine = useRef<{ key: string | null; added: number; engine: EstimateEngine }>({ key: null, added: 0, engine: new EstimateEngine() });
  const estimate = useMemo(() => {
    if (key === null) return null;
    const state = engine.current;
    if (state.key !== key || count < state.added) {
      state.key = key;
      state.added = 0;
      state.engine = new EstimateEngine();
    }
    for (; state.added < count; state.added += 1) state.engine.add(rays[state.added]);
    return withGround(state.engine.view(), ground);
  }, [key, count, rays, ground]);

  const drone = useMemo<PlaybackDrone | null>(() => {
    if (key === null || count === 0) return null;
    const last = rays[count - 1];
    const track: Array<[number, number]> = [];
    for (const ray of rays.slice(Math.max(0, count - TRACK_POINTS), count)) {
      const previous = track[track.length - 1];
      if (!previous || previous[0] !== ray.longitude || previous[1] !== ray.latitude) track.push([ray.longitude, ray.latitude]);
    }
    let headingDeg: number | null = null;
    if (track.length > 1) {
      const [lon, lat] = track[track.length - 2];
      headingDeg = Math.round(bearingAndDistance({ latitude: lat, longitude: lon }, last.longitude, last.latitude).bearingDeg * 10) / 10;
    }
    return { position: { latitude: last.latitude, longitude: last.longitude }, headingDeg, track };
  }, [key, count, rays]);

  const transmitter = source?.transmitter ?? null;
  const truth = useMemo(() => {
    if (!transmitter || !drone) return null;
    const actualM = bearingAndDistance(drone.position, transmitter.longitude, transmitter.latitude).distanceM;
    const located = estimate && (estimate.state === 'ESTIMATE' || estimate.state === 'ROUGH') && estimate.latitude !== null && estimate.longitude !== null;
    const errorM = located ? bearingAndDistance(transmitter, estimate.longitude as number, estimate.latitude as number).distanceM : null;
    return { actualM, errorM };
  }, [transmitter, drone, estimate]);

  const play = useCallback(() => {
    setCursorMs((current) => (current >= durationMs ? 0 : current));
    setPlaying(true);
  }, [durationMs]);
  const pause = useCallback(() => setPlaying(false), []);
  const restart = useCallback(() => { setCursorMs(0); setPlaying(true); }, []);
  const seek = useCallback((ms: number) => setCursorMs(Math.max(0, Math.min(durationMs, ms))), [durationMs]);

  return {
    active: key !== null,
    kind: source?.kind ?? null,
    playing,
    speed,
    cursorMs,
    durationMs,
    count,
    estimate,
    drone,
    truth,
    play,
    pause,
    restart,
    seek,
    setSpeed,
  };
}

/** m:ss, or h:mm:ss from an hour. */
export function formatPlaybackTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}
