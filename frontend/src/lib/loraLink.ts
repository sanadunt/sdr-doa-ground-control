import type { LoraDataState, LoraLinkRole, LoraLinkState, LoraLinkView, MqttSnapshot, TelemetrySnapshot, Tone } from '../types';

type JsonObject = Record<string, unknown>;

const STATES: readonly LoraLinkState[] = ['UP', 'DOWN', 'STALE', 'PORT_ERROR'];
const DATA_STATES: readonly LoraDataState[] = ['DATA', 'LINK_ONLY', 'NONE', 'UNKNOWN'];
const RX_KEYS = ['frames', 'crc_errors', 'bad_frames', 'lost_frames', 'messages', 'duplicates', 'incomplete', 'heartbeats'] as const;
const TX_KEYS = ['queued', 'superseded', 'expired', 'sent_messages', 'sent_frames', 'sent_bytes', 'too_large'] as const;
const RATE_KEYS = ['frames', 'messages', 'heartbeats', 'crc_errors', 'lost_frames'] as const;
/** The server's CLOCK_OFFSET_WARN_MS (tools/lora_link.py), used when it does not report one. */
export const LORA_CLOCK_WARN_MS = 1000;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function counts(value: unknown, keys: readonly string[]): Record<string, number | null> {
  const source = isObject(value) ? value : {};
  return Object.fromEntries(keys.map((key) => [key, count(source[key])]));
}

function normalizeRole(value: unknown, role: 'ground' | 'edge'): LoraLinkRole | null {
  if (!isObject(value)) return null;
  const state = STATES.find((item) => item === value.state);
  if (!state) return null;
  const rates = isObject(value.rates) && RATE_KEYS.every((key) => finite((value.rates as JsonObject)[key]) !== null)
    ? Object.fromEntries(RATE_KEYS.map((key) => [key, Math.max(0, finite((value.rates as JsonObject)[key]) ?? 0)])) as LoraLinkRole['rates']
    : null;
  const peer = isObject(value.peer)
    ? {
      uptime_s: count(value.peer.uptime_s),
      rx_frames: count(value.peer.rx_frames),
      crc_errors: count(value.peer.crc_errors),
      lost_frames: count(value.peer.lost_frames),
      clock_offset_ms: finite(value.peer.clock_offset_ms),
    }
    : null;
  return {
    role,
    state,
    data: DATA_STATES.find((item) => item === value.data) ?? 'UNKNOWN',
    status_age_ms: count(value.status_age_ms),
    since_rx_ms: count(value.since_rx_ms),
    port_error: typeof value.port_error === 'string' && value.port_error.trim() ? value.port_error.trim().slice(0, 200) : null,
    mqtt: value.mqtt === 'CONNECTED' || value.mqtt === 'DISCONNECTED' ? value.mqtt : null,
    rx: counts(value.rx, RX_KEYS),
    tx: counts(value.tx, TX_KEYS),
    queue: count(value.queue),
    rates,
    peer,
    link_changes: count(value.link_changes),
    clock_warning: value.clock_warning === true,
  };
}

/** The `lora` block of /api/mqtt, or undefined when the server sent none. */
export function normalizeLoraLink(value: unknown): LoraLinkView | undefined {
  if (!isObject(value) || typeof value.present !== 'boolean') return undefined;
  return {
    present: value.present,
    ground: normalizeRole(value.ground, 'ground'),
    edge: normalizeRole(value.edge, 'edge'),
    invalid: count(value.invalid) ?? 0,
    clock_warn_ms: count(value.clock_warn_ms) ?? LORA_CLOCK_WARN_MS,
  };
}

export interface LoraChip {
  /** RX, IDLE, NO RX, UP, DOWN, PORT or STALE. */
  value: string;
  tone: Tone;
  /** Data arrives over the radio now: the chip's dot pulses. */
  receiving: boolean;
  clockWarning: boolean;
}

/** The top bar's LoRa chip, or null where no bridge reports (a T900 or PPP groundstation). */
export function loraChip(lora: LoraLinkView | null | undefined): LoraChip | null {
  if (!lora?.present) return null;
  const ground = lora.ground;
  if (!ground) return null;
  const clockWarning = ground.clock_warning;
  switch (ground.state) {
    case 'STALE': return { value: 'STALE', tone: 'bad', receiving: false, clockWarning };
    case 'PORT_ERROR': return { value: 'PORT', tone: 'bad', receiving: false, clockWarning };
    case 'DOWN': return { value: 'DOWN', tone: 'bad', receiving: false, clockWarning };
    default: break;
  }
  const warn = clockWarning ? 'warn' : 'good';
  switch (ground.data) {
    case 'DATA': return { value: 'RX', tone: warn, receiving: true, clockWarning };
    case 'LINK_ONLY': return { value: 'IDLE', tone: 'warn', receiving: false, clockWarning };
    case 'NONE': return { value: 'NO RX', tone: 'warn', receiving: false, clockWarning };
    default: return { value: 'UP', tone: warn, receiving: false, clockWarning };
  }
}

/**
 * Data Out is not used: the node reaches the broker over the LoRa serial
 * bridge (no IP path), named by the snapshot's source or by a bridge status on
 * the broker. Its settings and card then fold away.
 */
export function dataOutUnused(snapshot: TelemetrySnapshot | null | undefined, mqtt: MqttSnapshot | null | undefined): boolean {
  const source = snapshot?.source;
  const link = source !== null && typeof source === 'object' ? (source as Record<string, unknown>).link : undefined;
  return link === 'lora' || mqtt?.lora?.present === true;
}
