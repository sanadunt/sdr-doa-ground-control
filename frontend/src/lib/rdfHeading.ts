import type { FeatureCollection, LineString } from 'geojson';
import type { TelemetrySnapshot } from '../types';
import { destination, normalizeBearing, type GeoOrigin } from './doaGeometry';
import { formatBearing } from './overlayPalette';
import type { Translate } from './i18n';
import { snapshotNav } from './telemetrySource';

/**
 * Where the RDF-SDR's array points (not its course), drawn on the map apart from the DoA
 * bearing. While the SIYI drone that carries it gives a heading, that is the drone's yaw
 * plus the array's turn against the nose (source DRONE, `stationHeading()`), the heading
 * the bearing turns with (lib/polar.ts DRONE_YAW). Otherwise it is the RDF-SDR's own compass
 * from the nav fields of telemetry/health (contract 1.6, source RDF): `heading_deg` from
 * north, magnetic plus the edge's own offset, and `compass_state`.
 *
 * OK: compass OK, a heading in [0, 360) and a locally fresh MQTT answer.
 * STALE: the same heading once the answer is no longer fresh; drawn dimmed and
 * labelled, never in the style of a live heading.
 * UNAVAILABLE: the compass reports another state or no usable heading; nothing
 * is drawn, the state is named.
 */
export type RdfHeadingState = 'OK' | 'STALE' | 'UNAVAILABLE';

/** RDF: the RDF-SDR's own compass. DRONE: the drone's yaw plus the array's turn. */
export type HeadingSource = 'RDF' | 'DRONE';

export interface RdfHeading {
  /** Degrees from north, clockwise; null while UNAVAILABLE. */
  headingDeg: number | null;
  state: RdfHeadingState;
  /** The edge's compass state code (OK, NO_REPLY, ...), or null when it sends none. */
  compassState: string | null;
  /** Where the heading comes from; RDF when absent. */
  source?: HeadingSource;
}

function compassCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z_]{1,16}$/u.test(value) ? value : null;
}

function headingValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 360 ? value : null;
}

/**
 * The heading of an MQTT answer, or null when there is nothing to show: no
 * snapshot, a simulation, a Data Out answer or an answer without compass fields.
 */
export function rdfHeading(snapshot: TelemetrySnapshot | null | undefined, localFresh: boolean): RdfHeading | null {
  if (!snapshot || snapshot.simulation === true) return null;
  const nav = snapshotNav(snapshot);
  if (!nav) return null;
  const compassState = compassCode(nav.compass_state);
  const heading = headingValue(nav.heading_deg);
  if (compassState === null && heading === null) return null;
  if (compassState !== 'OK' || heading === null) return { headingDeg: null, state: 'UNAVAILABLE', compassState };
  // A held health (link_mode "lora") keeps its heading, STALE like an old answer.
  return { headingDeg: heading, state: localFresh && nav.stale !== true ? 'OK' : 'STALE', compassState };
}

/**
 * The heading the map draws: the drone's array heading (yaw plus the array's turn) while
 * the drone gives one, else the RDF-SDR's compass (`rdfHeading`). `droneHeadingDeg` is null
 * unless the drone is LIVE with a heading and the compass choice prefers the drone.
 */
export function stationHeading(snapshot: TelemetrySnapshot | null | undefined, localFresh: boolean, droneHeadingDeg: number | null): RdfHeading | null {
  if (snapshot?.simulation === true) return null;
  if (droneHeadingDeg !== null && Number.isFinite(droneHeadingDeg)) {
    // Already in [0, 360) from droneArrayHeadingNow(); wrapping again would only add rounding.
    const deg = droneHeadingDeg >= 0 && droneHeadingDeg < 360 ? droneHeadingDeg : normalizeBearing(droneHeadingDeg);
    return { headingDeg: deg, state: 'OK', compassState: null, source: 'DRONE' };
  }
  const rdf = rdfHeading(snapshot, localFresh);
  return rdf ? { ...rdf, source: 'RDF' } : null;
}

/**
 * The heading line from the station, as long as the bearing line. `held` marks
 * a STALE heading, which the map paints grey; an empty collection without a heading.
 */
export function headingLineFeatures(origin: GeoOrigin, heading: RdfHeading | null, distanceM: number): FeatureCollection<LineString> {
  if (!heading || heading.headingDeg === null || heading.state === 'UNAVAILABLE' || !(distanceM > 0)) return { type: 'FeatureCollection', features: [] };
  // Already in [0, 360) (rdfHeading); normalizing again would only add rounding.
  const bearing = heading.headingDeg;
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { layer: 'rdf-heading', heading: bearing, held: heading.state !== 'OK', source: heading.source ?? 'RDF', meaning: 'RDF-SDR array heading, not a DoA bearing' },
      geometry: { type: 'LineString', coordinates: [[origin.longitude, origin.latitude], destination(origin, bearing, distanceM)] },
    }],
  };
}

/** Headings closer than this to a drawn bearing move their label inward, so the two pills do not overlap. */
const LABEL_CLEARANCE_DEG = 15;

function angleBetween(a: number, b: number): number {
  const difference = Math.abs(normalizeBearing(a) - normalizeBearing(b));
  return Math.min(difference, 360 - difference);
}

/**
 * Where the heading label sits: past the line's end like the bearing label,
 * or along the line when a drawn bearing points nearly the same way.
 */
export function headingLabelPosition(origin: GeoOrigin, headingDeg: number, distanceM: number, bearings: ReadonlyArray<number | null>): [number, number] {
  const near = bearings.some((bearing) => bearing !== null && Number.isFinite(bearing) && angleBetween(bearing, headingDeg) < LABEL_CLEARANCE_DEG);
  return destination(origin, headingDeg, distanceM * (near ? 0.62 : 1.1));
}

/** "HDG 201°", "HDG 244° · DRONE" from the drone, or marked STALE/USANG when the heading is held. */
export function headingLabel(heading: RdfHeading, t: Translate): string {
  if (heading.headingDeg === null) return heading.compassState ?? '—';
  const deg = formatBearing(heading.headingDeg, 0);
  if (heading.source === 'DRONE') return t('map.headingDroneLabel', { deg });
  return t(heading.state === 'OK' ? 'map.headingLabel' : 'map.headingHeldLabel', { deg });
}

/** The station popup's value: the heading with one decimal, DRONE from the drone, STALE when held, or the compass state. */
export function headingPopupText(heading: RdfHeading, unavailable: string, heldTag = 'STALE'): string {
  if (heading.headingDeg === null) return heading.compassState ?? unavailable;
  const deg = `${formatBearing(heading.headingDeg, 1)}°`;
  if (heading.source === 'DRONE') return `${deg} · DRONE`;
  return heading.state === 'OK' ? deg : `${deg} · ${heldTag}`;
}
