import type { FeatureCollection, LineString, Point, Polygon } from 'geojson';
import type { TelemetrySnapshot } from '../types';
import {
  beamFeatures,
  bearingFeature,
  edgeFeatures,
  halfPowerWidth,
  heatFeatures,
  lobeFeature,
  type DoaOverlaySettings,
  type GeoOrigin,
  type HalfPowerWidth,
} from './doaGeometry';
import { geographicBearingForBin } from './polar';
import { snapshotConsoleBaseUrl } from './snapshotRead';
import type { Lang, Translate } from './i18n';

/**
 * The map's held DoA overlay (owner's request of 2026-11-02): when the DoA
 * stops, the map keeps the last live overlay drawn, as the polar dock keeps
 * its last curve (heldCurve() in components/overview/PolarDock.tsx), until
 * live data returns. Owner's decision of 2026-11-02: it keeps the live colours
 * and opacity (a dimmed grey graph was hard to see); only the STALE tag and
 * the time of the last data mark it as old.
 */

/** What the map drew while the overlay was live. */
export interface LiveOverlay {
  /** The 360-bin angular vector. */
  values: number[];
  /** theta_0 of the same record (array frame), or null. */
  thetaDeg: number | null;
  /** The compass offset the overlay was drawn with. */
  offsetDeg: number;
  /**
   * The offset the curve's bins were turned with (contract 1.10: the heading
   * of the Angular frame itself, which may be older than the DoA's); the
   * compass offset when absent.
   */
  curveOffsetDeg?: number;
  /** The DoA record's frequency, or null. */
  frequencyHz: number | null;
  /**
   * The station position the overlay was drawn from. A held overlay stays
   * there: a moving RDF-SDR never carries an old bearing to a place it was
   * not measured from.
   */
  origin: GeoOrigin;
}

/** The remembered overlay, with the browser time it was last live. */
export interface HeldOverlay extends LiveOverlay {
  atMs: number;
}

/** Which node the overlay came from: a held overlay never outlives a new one. */
export interface OverlayIdentity {
  /** The console's Data Out URL at the answer. */
  baseUrl: string | null;
  /** The RDF Node MQTT session (a new one on every edge restart). */
  sid: string | null;
  /** Data Out status.json uptime; it goes back when the node restarts. */
  uptimeMs: number | null;
}

/** Module memory of the map: the held overlay and the node it came from. */
export interface OverlayMemory {
  overlay: HeldOverlay | null;
  identity: OverlayIdentity;
}

const SID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The node an answer came from, as far as the answer says. */
export function overlayIdentity(snapshot: TelemetrySnapshot | null | undefined): OverlayIdentity {
  const mqtt = record(snapshot?.mqtt);
  const sourceMqtt = record(record(snapshot?.source)?.mqtt);
  const sid = [mqtt?.sid, sourceMqtt?.sid].find((value): value is string => typeof value === 'string' && SID_RE.test(value)) ?? null;
  const uptime = record(record(snapshot?.status)?.safe)?.uptime_ms;
  return {
    baseUrl: snapshotConsoleBaseUrl(snapshot),
    sid,
    uptimeMs: typeof uptime === 'number' && Number.isFinite(uptime) && uptime >= 0 ? uptime : null,
  };
}

/**
 * Whether `next` is still the node `previous` described: another Data Out URL,
 * another MQTT session or an uptime that went back is another node (or the
 * same one restarted). A field one of them does not carry decides nothing.
 */
export function sameOverlayNode(previous: OverlayIdentity, next: OverlayIdentity): boolean {
  if (previous.baseUrl !== null && next.baseUrl !== null && previous.baseUrl !== next.baseUrl) return false;
  if (previous.sid !== null && next.sid !== null && previous.sid !== next.sid) return false;
  if (previous.uptimeMs !== null && next.uptimeMs !== null && next.uptimeMs < previous.uptimeMs) return false;
  return true;
}

function mergeIdentity(previous: OverlayIdentity, next: OverlayIdentity): OverlayIdentity {
  const merged = {
    baseUrl: next.baseUrl ?? previous.baseUrl,
    sid: next.sid ?? previous.sid,
    uptimeMs: next.uptimeMs ?? previous.uptimeMs,
  };
  return merged.baseUrl === previous.baseUrl && merged.sid === previous.sid && merged.uptimeMs === previous.uptimeMs ? previous : merged;
}

/**
 * The overlay to draw held, and the memory to keep. A live overlay is
 * remembered with the time it arrived (the same object while nothing in it
 * changes, so the map rebuilds nothing); while there is none and no live
 * bearing is drawn either (the MQTT DoA between Angular frames draws its live
 * bearing alone), the remembered one is drawn held, with no time cutoff.
 * Simulation is never remembered and never draws a held overlay. Another node
 * or a restart of the same one (overlayIdentity()) forgets the memory.
 */
export function rememberOverlay(
  previous: OverlayMemory | null,
  input: { live: LiveOverlay | null; liveBearing: boolean; identity: OverlayIdentity; simulation: boolean; nowMs: number },
): { draw: HeldOverlay | null; memory: OverlayMemory | null } {
  if (input.simulation) return { draw: null, memory: previous };
  let memory = previous;
  if (memory && !sameOverlayNode(memory.identity, input.identity)) memory = null;
  const identity = memory ? mergeIdentity(memory.identity, input.identity) : input.identity;
  const held = memory?.overlay ?? null;
  if (input.live) {
    const live = input.live;
    const unchanged = held !== null && held.values === live.values && held.thetaDeg === live.thetaDeg && held.offsetDeg === live.offsetDeg && held.curveOffsetDeg === live.curveOffsetDeg && held.frequencyHz === live.frequencyHz
      && held.origin.latitude === live.origin.latitude && held.origin.longitude === live.origin.longitude;
    const overlay = unchanged ? held : { ...live, origin: { latitude: live.origin.latitude, longitude: live.origin.longitude }, atMs: held !== null && held.values === live.values ? held.atMs : input.nowMs };
    return { draw: null, memory: memory && overlay === held && identity === memory.identity ? memory : { overlay, identity } };
  }
  const next = memory && identity === memory.identity ? memory : { overlay: held, identity };
  return { draw: input.liveBearing ? null : held, memory: next };
}

/** The geographic bearing the held overlay was drawn with, or null. */
export function heldBearingDeg(held: HeldOverlay | null): number | null {
  return held && held.thetaDeg !== null && Number.isFinite(held.thetaDeg) ? geographicBearingForBin(held.thetaDeg, held.offsetDeg) : null;
}

/** Degrees between two bearings, 0..180. */
export function bearingGapDeg(a: number, b: number): number {
  const gap = Math.abs((((a - b) % 360) + 360) % 360);
  return gap > 180 ? 360 - gap : gap;
}

/** A provisional line within this of the held bearing is not drawn twice. */
export const PROVISIONAL_HELD_GAP_DEG = 3;

/** Whether the provisional (NOT VALID) line is drawn beside the held overlay. */
export function provisionalBesideHeld(provisionalBearing: number | null, heldBearing: number | null): boolean {
  if (provisionalBearing === null) return false;
  return heldBearing === null || bearingGapDeg(provisionalBearing, heldBearing) > PROVISIONAL_HELD_GAP_DEG;
}

/** The held time as the polar dock shows it ("last 20.27.52"). */
export function heldTimeText(atMs: number, lang: Lang): string {
  return new Date(atMs).toLocaleTimeString(lang === 'id' ? 'id-ID' : 'en-GB', { hour12: false });
}

/** The map notice while the held overlay is drawn; `reason` is the DoA's held cause, if any. */
export function heldNoticeText(t: Translate, time: string, reason: string | undefined): string {
  return t('map.overlayHeldLast', { time, reason: reason ?? t('map.heldNoVector') });
}

type Collection = FeatureCollection<Point | LineString | Polygon>;
const NONE: Collection = { type: 'FeatureCollection', features: [] };

/** The held overlay's features, one collection per held source. */
export interface HeldFeatures {
  'doa-held-beam': Collection;
  'doa-held-heat': Collection;
  'doa-held-lobe': Collection;
  'doa-held-edges': Collection;
  'doa-held-bearing': Collection;
  halfPower: HalfPowerWidth | null;
}

export const NO_HELD_FEATURES: HeldFeatures = {
  'doa-held-beam': NONE, 'doa-held-heat': NONE, 'doa-held-lobe': NONE, 'doa-held-edges': NONE, 'doa-held-bearing': NONE, halfPower: null,
};

/**
 * The held overlay's geometry: the same shapes the live overlay draws from
 * the remembered vector, with the remembered compass offset and from the
 * remembered station position, into the held sources only (never the live
 * ones). `draw` carries the visibility and the dB scale in use.
 */
export function heldOverlayFeatures(held: HeldOverlay | null, draw: DoaOverlaySettings): HeldFeatures {
  const origin = held?.origin;
  if (!origin || !held || held.values.length !== 360 || draw.maxDb <= draw.minDb) return NO_HELD_FEATURES;
  const halfPower = halfPowerWidth(held.values);
  const bearing = heldBearingDeg(held);
  const curveOffset = held.curveOffsetDeg ?? held.offsetDeg;
  return {
    'doa-held-beam': draw.heatmapVisible && draw.heatStyle === 'beam' ? beamFeatures(origin, held.values, draw, curveOffset) : NONE,
    'doa-held-heat': draw.heatmapVisible && draw.heatStyle === 'density' ? heatFeatures(origin, held.values, draw, curveOffset) : NONE,
    'doa-held-lobe': draw.lobeVisible ? { type: 'FeatureCollection', features: [lobeFeature(origin, held.values, draw, curveOffset)] } : NONE,
    'doa-held-edges': draw.edgesVisible ? edgeFeatures(origin, halfPower, draw, curveOffset) : NONE,
    'doa-held-bearing': draw.bearingVisible && bearing !== null ? { type: 'FeatureCollection', features: [bearingFeature(origin, bearing, draw)] } : NONE,
    halfPower,
  };
}

/**
 * Each live layer and the held layer that mirrors it (owner's decision of
 * 2026-11-02): a held layer is drawn with exactly its live layer's paint (the
 * palette, the opacity, intensity and blur of the Layers settings, the
 * bearing colour, the lobe and edge style), from its own held source, so live
 * data replaces it at once. Only the STALE tag and the time of the last data
 * mark it (the bearing label, the legend, the hover readout and the notice).
 */
export const HELD_LAYER_OF: Readonly<Record<string, string>> = {
  'doa-beam': 'doa-held-beam',
  'doa-heat': 'doa-held-heat',
  'doa-lobe-fill': 'doa-held-lobe-fill',
  'doa-lobe-outline': 'doa-held-lobe-outline',
  'doa-edges': 'doa-held-edges',
  'doa-bearing-casing': 'doa-held-bearing-casing',
  'doa-bearing': 'doa-held-bearing',
};

/** The source a held layer draws from: its live layer's source with `held-` after `doa-`. */
export function heldSourceId(liveSource: string): string {
  return liveSource.replace(/^doa-/u, 'doa-held-');
}

/**
 * The held copy of a live layer: the same specification (type, paint, layout,
 * filter) with the held layer id and the held source.
 */
export function heldLayerSpec<T extends { id: string; source: string }>(live: T): T {
  const id = HELD_LAYER_OF[live.id];
  if (!id) throw new Error(`no held layer for ${live.id}`);
  return { ...live, id, source: heldSourceId(live.source) };
}
