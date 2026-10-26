/**
 * When the data in a /api/snapshot answer was read from the node. The
 * console shares one Data Out read between every viewer, so an answer can
 * carry a collection that completed a while before it was sent; its
 * `collection.age_ms` says how long. Freshness and the read age count from
 * the node read, never from the answer's arrival.
 */
import type { TelemetrySnapshot } from '../types';

/** An answer older than this is treated as this old; the server keeps none longer than 30 s. */
export const MAX_SERVED_AGE_MS = 120_000;
const COLLECTION_ID_RE = /^[0-9a-f]{8}-[0-9]{1,12}$/;
/** A reported interval above this is not taken (the console offers at most 30 s). */
const MAX_REFRESH_SECONDS = 3_600;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** How long before the answer its collection completed, in ms; 0 when not reported. */
export function snapshotServedAgeMs(snapshot: TelemetrySnapshot | null | undefined): number {
  const age = record(snapshot?.collection)?.age_ms;
  if (typeof age !== 'number' || !Number.isFinite(age) || age <= 0) return 0;
  return Math.min(age, MAX_SERVED_AGE_MS);
}

/** Monotonic time the node was read: the answer's arrival minus its served age. */
export function snapshotReadAtMonotonic(snapshot: TelemetrySnapshot | null | undefined, receivedAtMonotonic: number): number {
  return receivedAtMonotonic - snapshotServedAgeMs(snapshot);
}

/**
 * A collector age (ms, counted when the node was read) as of when the answer
 * was sent: the time the shared read waited on the console is added. This is
 * the age the HUD shows, as it was when every answer was a new read.
 */
export function ageAtAnswerMs(ageMs: number | null, snapshot: TelemetrySnapshot | null | undefined): number | null {
  return ageMs === null ? null : ageMs + snapshotServedAgeMs(snapshot);
}

/**
 * The console's saved refresh interval (s) when the answer was sent, or null.
 * It sets how long the console shares one read, so a page that loaded another
 * interval polls at this one and re-reads the console config.
 */
export function snapshotConsoleRefreshSeconds(snapshot: TelemetrySnapshot | null | undefined): number | null {
  const seconds = record(snapshot?.collection)?.refresh_seconds;
  return typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= 0 && seconds <= MAX_REFRESH_SECONDS ? seconds : null;
}

/** The shared read's id, sent back as `seen` so the next poll gets a new read. */
export function snapshotCollectionId(snapshot: TelemetrySnapshot | null | undefined): string | null {
  const id = record(snapshot?.collection)?.id;
  return typeof id === 'string' && COLLECTION_ID_RE.test(id) ? id : null;
}

/** Console clock (ms) when the settings.json in this snapshot was read, or null. */
export function settingsReadAtMs(snapshot: TelemetrySnapshot | null | undefined): number | null {
  const readAt = snapshot?.settings?.read_at_ms;
  return typeof readAt === 'number' && Number.isFinite(readAt) && readAt > 0 ? readAt : null;
}

/** Age of the settings.json in this snapshot when the answer was sent, or null. */
export function settingsAgeMs(snapshot: TelemetrySnapshot | null | undefined): number | null {
  const age = record(snapshot?.collection)?.settings_age_ms;
  return typeof age === 'number' && Number.isFinite(age) && age >= 0 ? age : null;
}
