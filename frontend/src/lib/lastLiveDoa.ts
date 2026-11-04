import type { CompassConfig, GpsConfig, TelemetrySnapshot } from '../types';
import { overlayIdentity, sameOverlayNode } from './heldOverlay';
import type { HeldOverlay, OverlayIdentity, OverlayMemory } from './heldOverlay';
import { resolveGpsSource } from './map';
import { curveCompassOffset, curveInDoaFrame, resolveCompassSource } from './polar';
import { numberOrNull, primaryCandidate } from './telemetry';

/**
 * The last live DoA graph a page did not see itself (GET /api/doa/last-live,
 * tools/last_live_doa.py). The console keeps the last /api/snapshot answer
 * whose DoA view had a fresh 360-bin vector; a page that opens later (a
 * tablet, the kiosk after a reload) derives its held overlay and polar curve
 * from that answer exactly as it derives a live one, so the map and the polar
 * dock show the last graph, marked STALE with its time, instead of nothing
 * until the next Angular frame (rare over Telemetry LoRa). A page's own
 * memory always wins; another node never seeds it.
 */

export const LAST_LIVE_DOA_ROUTE = '/api/doa/last-live';

export interface LastLiveDoa {
  /** Console time it was kept. */
  capturedAtMs: number;
  snapshot: TelemetrySnapshot;
}

/** The held graph a page starts from: the overlay in the map's terms and the node it came from. */
export interface HeldSeed {
  overlay: HeldOverlay;
  identity: OverlayIdentity;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The route's answer, read leniently: null when it holds nothing usable. */
export function normalizeLastLiveDoa(value: unknown): LastLiveDoa | null {
  const body = record(value);
  const snapshot = record(body?.snapshot);
  const captured = body?.captured_at_ms;
  if (!snapshot || typeof captured !== 'number' || !Number.isFinite(captured) || captured <= 0) return null;
  return { capturedAtMs: captured, snapshot: snapshot as unknown as TelemetrySnapshot };
}

export async function fetchLastLiveDoa(signal?: AbortSignal): Promise<LastLiveDoa | null> {
  const response = await fetch(LAST_LIVE_DOA_ROUTE, { cache: 'no-store', credentials: 'same-origin', signal });
  // An older console (404) or the Vite dev server (HTML) has none.
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return null;
  return normalizeLastLiveDoa(await response.json());
}

/**
 * The held overlay of the kept answer, with the same rules a live one has:
 * the station position from the GPS choice (the drone's first, as configured),
 * the compass offset from the compass choice (MANUAL first, then the drone's
 * yaw or the RDF-SDR heading of that DoA), the curve turned with its own
 * frame's heading. Null when the answer gives no vector or no position.
 */
export function heldSeedFrom(kept: LastLiveDoa | null, gpsConfig: GpsConfig, compassConfig: CompassConfig): HeldSeed | null {
  if (!kept) return null;
  const snapshot = kept.snapshot;
  if (snapshot.simulation === true) return null;
  const candidate = primaryCandidate(snapshot);
  const values = candidate.angular_power_db;
  if (!Array.isArray(values) || values.length !== 360 || !values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  const origin = resolveGpsSource(snapshot, gpsConfig, snapshot).coordinate;
  if (!origin) return null;
  const compass = resolveCompassSource(snapshot, { figType: compassConfig.manualFigType, compassOffset: compassConfig.manualCompassOffset }, compassConfig, null, kept.capturedAtMs);
  const offsetDeg = Number.isFinite(compass.settings.compassOffset) ? compass.settings.compassOffset : 0;
  const curveOffsetDeg = curveCompassOffset(snapshot, compass, offsetDeg);
  const sampleMs = numberOrNull(candidate.timestamp_ms);
  return {
    overlay: {
      values,
      thetaDeg: numberOrNull(candidate.canonical_angle_deg),
      offsetDeg,
      curveOffsetDeg,
      frequencyHz: numberOrNull(candidate.frequency_hz_normalized),
      origin: { latitude: origin.latitude, longitude: origin.longitude },
      // The time of the DoA record itself, as the page would have remembered it.
      atMs: sampleMs !== null && sampleMs > 0 ? sampleMs : kept.capturedAtMs,
    },
    identity: overlayIdentity(snapshot),
  };
}

/** The seed applies to this answer's node, outside a simulation. */
function seedApplies(seed: HeldSeed | null, current: OverlayIdentity, simulation: boolean): seed is HeldSeed {
  return seed !== null && !simulation && sameOverlayNode(seed.identity, current);
}

/** The map's memory: the seed only while the page remembers no overlay of its own. */
export function seedOverlayMemory(memory: OverlayMemory | null, seed: HeldSeed | null, current: OverlayIdentity, simulation: boolean): OverlayMemory | null {
  if (memory?.overlay || !seedApplies(seed, current, simulation)) return memory;
  return { overlay: seed.overlay, identity: seed.identity };
}

/** The polar dock's held curve from the seed (in the DoA's frame, as polarView() turns a live one), or null. */
export function seedCurve(seed: HeldSeed | null, current: OverlayIdentity, simulation: boolean): { values: number[]; atMs: number } | null {
  if (!seedApplies(seed, current, simulation)) return null;
  const values = curveInDoaFrame(seed.overlay.values, seed.overlay.offsetDeg, seed.overlay.curveOffsetDeg ?? seed.overlay.offsetDeg);
  return values ? { values, atMs: seed.overlay.atMs } : null;
}
