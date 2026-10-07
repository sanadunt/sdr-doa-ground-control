import type {
  RdfNodeMqttAngularFrame,
  RdfNodeMqttObservation,
  RdfNodeMqttSnapshot,
  RdfNodeMqttTopic,
  RdfNodeMqttTopicStatus,
  Tone,
} from '../types';

export type RdfNodeMqttDiagnosticTopic = Extract<
  RdfNodeMqttTopic,
  'telemetry/diagnostic/doa' | 'telemetry/diagnostic/angular'
>;
const TOPIC_DETAILS: Readonly<Record<RdfNodeMqttTopic, readonly string[]>> = {
  'telemetry/diagnostic/doa': [],
  'telemetry/diagnostic/angular': [],
  'telemetry/doa': ['sid', 'q', 't', 'f', 'a', 'c', 'p', 'rev', 'ok'],
  'telemetry/health': ['sid', 'q', 't', 'run', 'daq', 'drop', 'age', 'temp', 'clk', 'rev'],
  'telemetry/health/detail': ['sid', 't', 'usb', 'sync', 'cpu', 'mem', 'disk_free', 'throt', 'uv', 'tx', 'rx', 'adrop', 'parse'],
  'telemetry/angular': [],
  state: ['sid', 'boot', 'instance', 't', 'run', 'daq', 'cfg', 'profile', 'clock'],
  capabilities: ['version', 'mode', 'codecs', 'angle', 'native_axis', 'count', 'profiles', 'scope', 'helper_available', 'maintenance', 'remote_commands', 'config_patch', 'processing', 'restart', 'reboot'],
  'config/reported': ['sid', 'rev', 't', 'proof', 'digest', 'effective'],
  availability: ['sid', 'online', 't', 'reason'],
  'ack/config': ['id', 'status', 't', 'rev', 'result', 'error'],
  'ack/operation': ['id', 'status', 't', 'rev', 'result', 'error'],
};

const SAFE_EFFECTIVE_FIELDS = [
  'center_frequency_hz', 'gain_db', 'vfo0_frequency_hz', 'vfo0_bandwidth_hz',
  'vfo0_squelch_db', 'ant_arrangement', 'doa_method', 'active_vfos', 'output_vfo', 'en_doa',
] as const;
const SAFE_ACK_RESULT_FIELDS = [
  'revision', 'proof', 'persisted', 'operation', 'valid_seconds', 'prepare_id',
  'status', 'id', 'op', 'state', 'result', 'error', 'code', 'target_id',
] as const;
const SAFE_ACK_PROOF_VALUES: Readonly<Record<string, string>> = {
  center_frequency_hz: 'FRESH_DAQ_RF_CENTER',
  vfo0_frequency_hz: 'FRESH_DOA_FREQUENCY',
};
const TOPIC_MAX_AGE_MS: Readonly<Partial<Record<RdfNodeMqttTopic, number>>> = {
  'telemetry/health': 8_000,
  'telemetry/doa': 5_000,
  'telemetry/health/detail': 15_000,
  'telemetry/angular': 10_000,
  'ack/config': 30_000,
  'ack/operation': 30_000,
};
export const ANGULAR_METADATA_FIELDS = [
  'encoding', 'sid', 'q', 'timestamp_ms', 'frequency_hz', 'revision',
  'vfo', 'convention', 'raw_doa_deg', 'confidence_native_db',
] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function formatValue(value: unknown): string | null {
  if (value === null) return 'N/A';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 157)}…` : value;
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => formatValue(item) ?? 'N/A').join(', ')
      + (value.length > 12 ? ', …' : '');
  }
  return null;
}

function formatAckProof(value: unknown): string | null {
  if (!isRecord(value)) return formatValue(value);
  return Object.entries(SAFE_ACK_PROOF_VALUES)
    .filter(([field, expected]) => value[field] === expected)
    .map(([field, expected]) => `${field}=${expected}`)
    .join('; ') || null;
}

function detailValue(topic: RdfNodeMqttTopic, key: string, value: unknown): string | null {
  if (key === 'effective' && topic === 'config/reported' && isRecord(value)) {
    return SAFE_EFFECTIVE_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(value, field))
      .map((field) => `${field}=${formatValue(value[field]) ?? '[structured value withheld]'}`)
      .join('; ');
  }
  if ((key === 'result' || key === 'error') && (topic === 'ack/config' || topic === 'ack/operation') && isRecord(value)) {
    return SAFE_ACK_RESULT_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(value, field))
      .map((field) => {
        const formatted = field === 'proof' ? formatAckProof(value[field]) : formatValue(value[field]);
        return `${field}=${formatted ?? '[structured value withheld]'}`;
      })
      .join('; ') || null;
  }
  return formatValue(value);
}

export function formatTopicDetails(topic: RdfNodeMqttTopic, payload: unknown): Array<[string, string]> {
  if (!isRecord(payload)) return [];
  return TOPIC_DETAILS[topic].flatMap((key) => {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) return [];
    const value = detailValue(topic, key, payload[key]);
    return value === null ? [] : [[key, value]];
  });
}

export function formatAngularMetadata(frame: RdfNodeMqttAngularFrame): Array<[string, string]> {
  return ANGULAR_METADATA_FIELDS.flatMap((field) => {
    const value = detailValue('telemetry/angular', field, frame[field]);
    if (value === null) return [];
    const unit = field === 'frequency_hz' ? ' Hz'
      : field === 'timestamp_ms' ? ' ms'
        : field === 'raw_doa_deg' ? '°'
          : field === 'confidence_native_db' ? ' dB'
            : '';
    return [[field, `${value}${unit}`] as [string, string]];
  });
}

function sourceTimestampMs(
  topic: RdfNodeMqttTopic,
  observation: RdfNodeMqttObservation,
): number | null {
  const payload = observationPayload(observation);
  const timestamp = payload?.[topic === 'telemetry/angular' ? 'timestamp_ms' : 't'];
  return typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp > 0
    ? timestamp
    : null;
}

export function observationStatusAt(
  topic: RdfNodeMqttTopic,
  observation: RdfNodeMqttObservation | undefined,
  nowMs = Date.now(),
): RdfNodeMqttTopicStatus {
  if (!observation) return 'UNAVAILABLE';
  if (observation.status !== 'FRESH') return observation.status;
  const maxAgeMs = TOPIC_MAX_AGE_MS[topic];
  if (maxAgeMs === undefined) return observation.status;
  const receivedAtMs = observation.received_at_ms;
  const sourceAtMs = sourceTimestampMs(topic, observation);
  return receivedAtMs !== null
    && sourceAtMs !== null
    && nowMs >= receivedAtMs
    && nowMs >= sourceAtMs
    && nowMs - receivedAtMs <= maxAgeMs
    && nowMs - sourceAtMs <= maxAgeMs
    ? 'FRESH'
    : 'STALE';
}

const DIAGNOSTIC_AGE_LIMITS: Readonly<Record<RdfNodeMqttDiagnosticTopic, { receiveMs: number; sourceMs: number }>> = {
  'telemetry/diagnostic/doa': { receiveMs: 3_000, sourceMs: 5_000 },
  'telemetry/diagnostic/angular': { receiveMs: 3_000, sourceMs: 10_000 },
};

export function isDiagnosticTopic(topic: RdfNodeMqttTopic): topic is RdfNodeMqttDiagnosticTopic {
  return topic === 'telemetry/diagnostic/doa' || topic === 'telemetry/diagnostic/angular';
}

export function diagnosticObservationStatusAt(
  topic: RdfNodeMqttDiagnosticTopic,
  observation: RdfNodeMqttObservation | undefined,
  snapshot: RdfNodeMqttSnapshot | null | undefined,
  nowMs = Date.now(),
): RdfNodeMqttTopicStatus {
  if (!observation) return 'UNAVAILABLE';
  if (observation.status === 'UNAVAILABLE' || observation.status === 'INVALID') return observation.status;
  if (observation.status !== 'FRESH' && observation.status !== 'STALE') return observation.status;
  if (observation.status === 'STALE'
    || !snapshot?.enabled
    || snapshot.connection !== 'ready'
    || !Number.isSafeInteger(nowMs)
    || observation.received_at_ms === null
    || !Number.isSafeInteger(observation.received_at_ms)) {
    return 'STALE';
  }

  const payload = observationPayload(observation);
  const sourceTimestamp = payload?.source_timestamp_ms;
  if (typeof sourceTimestamp !== 'number' || !Number.isSafeInteger(sourceTimestamp) || sourceTimestamp <= 0) {
    return 'STALE';
  }

  const receiveAge = nowMs - observation.received_at_ms;
  const sourceAge = nowMs - sourceTimestamp;
  const limits = DIAGNOSTIC_AGE_LIMITS[topic];
  if (receiveAge < 0 || sourceAge < 0
    || receiveAge > limits.receiveMs || sourceAge > limits.sourceMs) {
    return 'STALE';
  }
  if (topic === 'telemetry/diagnostic/angular') {
    const flags = payload?.flags;
    if (typeof flags !== 'number' || !Number.isInteger(flags) || flags < 0 || flags > 0x1f || (flags & 0x02) === 0) {
      return 'STALE';
    }
  }
  return 'FRESH';
}

export function formatDiagnosticAge(timestampMs: number | null, nowMs = Date.now()): string {
  if (timestampMs === null || !Number.isSafeInteger(timestampMs) || timestampMs < 0) return 'N/A';
  if (timestampMs > nowMs) return 'Future timestamp';
  return formatAge(timestampMs, nowMs);
}

export function diagnosticObservationAgeLabels(
  observation: RdfNodeMqttObservation | undefined,
  nowMs = Date.now(),
): { receive: string; source: string } {
  const sourceTimestamp = observationPayload(observation)?.source_timestamp_ms;
  return {
    receive: formatDiagnosticAge(observation?.received_at_ms ?? null, nowMs),
    source: formatDiagnosticAge(
      typeof sourceTimestamp === 'number' && Number.isSafeInteger(sourceTimestamp) && sourceTimestamp > 0
        ? sourceTimestamp
        : null,
      nowMs,
    ),
  };
}

export function statusTone(status: RdfNodeMqttTopicStatus): Tone {
  if (status === 'FRESH') return 'good';
  if (status === 'INVALID' || status === 'INCONSISTENT') return 'bad';
  if (status === 'STALE') return 'warn';
  return 'neutral';
}

export function connectionTone(connection: RdfNodeMqttSnapshot['connection'] | null): Tone {
  if (connection === 'ready') return 'good';
  if (connection === 'connecting') return 'warn';
  if (connection === 'error' || connection === 'disconnected') return 'bad';
  return 'neutral';
}

export function formatAge(receivedAtMs: number | null, nowMs = Date.now()): string {
  if (receivedAtMs === null) return 'N/A';
  const ageMs = nowMs - receivedAtMs;
  if (ageMs < -1_000) return 'Future timestamp';
  if (ageMs < 1_000) return '<1 s';
  return `${Math.floor(Math.max(0, ageMs) / 1_000)} s`;
}

export function formatRelativeAge(receivedAtMs: number | null | undefined, nowMs = Date.now()): string {
  if (receivedAtMs === null || receivedAtMs === undefined) return 'Not received';
  if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0 || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    return 'Invalid timestamp';
  }
  const ageMs = nowMs - receivedAtMs;
  if (ageMs < 0) return 'Future timestamp';

  const seconds = Math.floor(ageMs / 1_000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function formatObservationAge(
  topic: RdfNodeMqttTopic,
  observation: RdfNodeMqttObservation | undefined,
  nowMs = Date.now(),
): string {
  const receivedAtMs = observation?.received_at_ms;
  if (receivedAtMs === null || receivedAtMs === undefined) return 'N/A';
  const sourceAtMs = observation ? sourceTimestampMs(topic, observation) : null;
  if (receivedAtMs > nowMs || (sourceAtMs !== null && sourceAtMs > nowMs)) return 'Future timestamp';
  return formatAge(Math.min(receivedAtMs, sourceAtMs ?? receivedAtMs), nowMs);
}



export function observationPayload(observation: RdfNodeMqttObservation | undefined): Record<string, unknown> | null {
  return observation && isRecord(observation.payload) ? observation.payload : null;
}

export function observationDisplayPayload(observation: RdfNodeMqttObservation | undefined): Record<string, unknown> | null {
  return observationPayload(observation)
    ?? (observation && isRecord(observation.candidate_payload) ? observation.candidate_payload : null);
}

export function observationIsUnverified(observation: RdfNodeMqttObservation | undefined): boolean {
  if (!observation) return false;
  if (observation.status === 'INVALID' && isRecord(observation.candidate_payload)) return true;
  const payload = observationPayload(observation);
  return payload?.trust === 'UNVERIFIED'
    || payload?.proof === 'unverified'
    || payload?.proof === 'persisted_unverified';
}

export function daqState(
  health: RdfNodeMqttObservation | undefined,
  nowMs = Date.now(),
): { label: string; tone: Tone } {
  const status = observationStatusAt('telemetry/health', health, nowMs);
  if (!health || status === 'UNAVAILABLE') return { label: 'DAQ UNAVAILABLE', tone: 'neutral' };
  const payload = observationPayload(health);
  if (status === 'FRESH' && health.retained === false && payload?.daq === 1) {
    return { label: 'DAQ HEALTHY', tone: 'good' };
  }
  if (status === 'FRESH' && payload?.daq === 0) return { label: 'DAQ DEGRADED', tone: 'warn' };
  if (status === 'STALE') return { label: 'DAQ STALE', tone: 'warn' };
  if (status === 'INVALID' || status === 'INCONSISTENT') {
    return { label: `DAQ ${status}`, tone: 'bad' };
  }
  if (status === 'CONTEXT') return { label: 'DAQ CONTEXT ONLY', tone: 'neutral' };
  return { label: 'DAQ UNKNOWN', tone: 'neutral' };
}

function hasCurrentHealth(health: RdfNodeMqttObservation | undefined, nowMs: number): boolean {
  const payload = health && observationPayload(health);
  return observationStatusAt('telemetry/health', health, nowMs) === 'FRESH'
    && health?.retained === false
    && payload?.daq === 1;
}

export function doaIsCurrent(
  doa: RdfNodeMqttObservation | undefined,
  health: RdfNodeMqttObservation | undefined,
  nowMs = Date.now(),
): boolean {
  const doaPayload = observationPayload(doa);
  const healthPayload = observationPayload(health);
  return observationStatusAt('telemetry/doa', doa, nowMs) === 'FRESH'
    && doa?.retained === false
    && hasCurrentHealth(health, nowMs)
    && doaPayload?.ok === 1
    && typeof doaPayload.sid === 'string'
    && typeof healthPayload?.sid === 'string'
    && doaPayload.sid.toLowerCase() === healthPayload.sid.toLowerCase()
    && typeof doaPayload.rev === 'number'
    && doaPayload.rev === healthPayload.rev;
}

export function isAngularFrame(value: unknown): value is RdfNodeMqttAngularFrame {
  return isRecord(value)
    && (value.encoding === 'q16' || value.encoding === 'u8')
    && Array.isArray(value.values)
    && value.values.length === 360
    && value.values.every((sample) => typeof sample === 'number' && Number.isFinite(sample));
}

export function angularIsCurrent(
  observation: RdfNodeMqttObservation | undefined,
  health: RdfNodeMqttObservation | undefined,
  nowMs = Date.now(),
): boolean {
  const payload = observation?.payload;
  const healthPayload = observationPayload(health);
  if (observationStatusAt('telemetry/angular', observation, nowMs) !== 'FRESH'
    || observation?.retained !== false
    || !isAngularFrame(payload)
    || !hasCurrentHealth(health, nowMs)) return false;
  const healthSession = healthPayload?.sid;
  const sessionId = typeof healthSession === 'string' ? Number.parseInt(healthSession, 16) : Number.NaN;
  const healthRevision = healthPayload?.rev;
  return typeof payload.revision === 'number'
    && Number.isSafeInteger(payload.revision)
    && typeof healthRevision === 'number'
    && Number.isSafeInteger(healthRevision)
    && payload.sid === sessionId
    && payload.revision === healthRevision;
}
