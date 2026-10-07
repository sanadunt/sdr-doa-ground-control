import type {
  RdfNodeMqttObservation,
  RdfNodeMqttSnapshot,
  RdfNodeMqttTopic,
  RdfNodeMqttTopicStatus,
  Tone,
} from '../types';

import {
  doaIsCurrent,
  formatObservationAge,
  observationPayload,
  diagnosticObservationAgeLabels,
  diagnosticObservationStatusAt,
  observationStatusAt,
  statusTone,
} from './rdfNodeMqttPresentation';

type DiagnosticTopic = Extract<
  RdfNodeMqttTopic,
  'telemetry/diagnostic/doa' | 'telemetry/diagnostic/angular'
>;

export interface SystemHealthMqttReading {
  value: string;
  tone?: Tone;
  detail: string;
}

export interface SystemHealthMqttDiagnosticReading {
  freshness: SystemHealthMqttReading;
  trust: 'UNVERIFIED';
  receiveAge: string;
  sourceAge: string;
  reasons: string[];
  rawDoa: string;
  frequency: string;
  flags: string;
}

export interface SystemHealthMqttReadings {
  healthStream: SystemHealthMqttReading;
  daq: SystemHealthMqttReading;
  droppedFrames: SystemHealthMqttReading;
  edgeClock: SystemHealthMqttReading;
  sync: SystemHealthMqttReading;
  doa: SystemHealthMqttReading;
  edgeHealth: {
    run: SystemHealthMqttReading;
    sourceAge: SystemHealthMqttReading;
    temperature: SystemHealthMqttReading;
  };
  edgeHealthDetail: {
    usb: SystemHealthMqttReading;
    sync: {
      frame: SystemHealthMqttReading;
      sampleDelay: SystemHealthMqttReading;
      iq: SystemHealthMqttReading;
    };
    cpu: SystemHealthMqttReading;
    memory: SystemHealthMqttReading;
    freeDisk: SystemHealthMqttReading;
    throttled: SystemHealthMqttReading;
    underVoltage: SystemHealthMqttReading;
    tx: SystemHealthMqttReading;
    rx: SystemHealthMqttReading;
    acquisitionDrops: SystemHealthMqttReading;
    parseErrors: SystemHealthMqttReading;
  };
  diagnosticDoa: SystemHealthMqttDiagnosticReading;
  diagnosticAngular: SystemHealthMqttDiagnosticReading;
  gps: SystemHealthMqttReading;
  csv: SystemHealthMqttReading;
  xml: SystemHealthMqttReading;
  frameIndex: SystemHealthMqttReading;
}

const TOPIC_STATUS_LABELS: Readonly<Record<RdfNodeMqttTopicStatus, string>> = {
  UNAVAILABLE: 'UNAVAILABLE',
  CONTEXT: 'CONTEXT ONLY',
  FRESH: 'CURRENT',
  STALE: 'STALE',
  INVALID: 'INVALID',
  INCONSISTENT: 'INCONSISTENT',
};

function observationStatus(
  snapshot: RdfNodeMqttSnapshot | null,
  topic: RdfNodeMqttTopic,
  nowMs: number,
): RdfNodeMqttTopicStatus {
  if (!snapshot || !snapshot.enabled || snapshot.connection !== 'ready') return 'UNAVAILABLE';

  const observation = snapshot.topics[topic];
  const status = observationStatusAt(topic, observation, nowMs);
  return status === 'FRESH' && observation?.retained !== false ? 'CONTEXT' : status;
}

function observationDetail(
  snapshot: RdfNodeMqttSnapshot | null,
  topic: RdfNodeMqttTopic,
  observation: RdfNodeMqttObservation | undefined,
  status: RdfNodeMqttTopicStatus,
  nowMs: number,
): string {
  if (!snapshot) return 'No MQTT snapshot is available.';
  if (!snapshot.enabled) return 'The MQTT monitor is disabled.';
  if (snapshot.connection !== 'ready') {
    return `MQTT monitor ${snapshot.connection}; cached topic data is not current.`;
  }

  const age = formatObservationAge(topic, observation, nowMs);
  if (status === 'FRESH') return `Fresh MQTT observation · age ${age}.`;
  if (status === 'CONTEXT') return `Retained MQTT observation only · age ${age}.`;
  if (status === 'UNAVAILABLE') return 'No MQTT observation is available.';
  return `${TOPIC_STATUS_LABELS[status]} MQTT observation · age ${age}.`;
}

function topicReading(
  snapshot: RdfNodeMqttSnapshot | null,
  topic: RdfNodeMqttTopic,
  nowMs: number,
): { observation: RdfNodeMqttObservation | undefined; status: RdfNodeMqttTopicStatus; reading: SystemHealthMqttReading } {
  const observation = snapshot?.topics[topic];
  const status = observationStatus(snapshot, topic, nowMs);
  return {
    observation,
    status,
    reading: {
      value: TOPIC_STATUS_LABELS[status],
      tone: statusTone(status),
      detail: observationDetail(snapshot, topic, observation, status, nowMs),
    },
  };
}

function topicState(status: RdfNodeMqttTopicStatus, detail: string): SystemHealthMqttReading {
  return {
    value: TOPIC_STATUS_LABELS[status],
    tone: statusTone(status),
    detail,
  };
}

function notProvided(field: string): SystemHealthMqttReading {
  return {
    value: 'NOT PROVIDED',
    tone: 'neutral',
    detail: `${field} is not provided by the current MQTT v2 contract.`,
  };
}
function notReported(field: string): SystemHealthMqttReading {
  return {
    value: 'NOT REPORTED',
    tone: 'neutral',
    detail: `${field} was not reported in the current MQTT observation.`,
  };
}

function mapRun(
  status: RdfNodeMqttTopicStatus,
  payload: Record<string, unknown> | null,
  detail: string,
): SystemHealthMqttReading {
  if (status !== 'FRESH') return topicState(status, detail);
  const run = payload?.run;
  if (run === null || run === undefined) return notReported('Edge run state');
  if (typeof run !== 'number' || !Number.isInteger(run)) {
    return { value: 'INVALID', tone: 'bad', detail: 'Fresh health observation has an invalid Edge run state.' };
  }
  switch (run) {
    case 0: return { value: 'STOPPED', tone: 'warn', detail };
    case 1: return { value: 'RUNNING', tone: 'good', detail };
    case 2: return { value: 'STARTING', tone: 'warn', detail };
    case 3: return { value: 'STOPPING', tone: 'warn', detail };
    case 4: return { value: 'ERROR', tone: 'bad', detail };
    case 255: return { value: 'UNKNOWN', tone: 'neutral', detail };
    default: return { value: 'INVALID', tone: 'bad', detail: 'Fresh health observation has an unknown Edge run code.' };
  }
}

function mapReportedNumber(
  status: RdfNodeMqttTopicStatus,
  payload: Record<string, unknown> | null,
  key: string,
  label: string,
  unit: string,
  minimum: number,
  maximum: number,
  detail: string,
  integer = false,
): SystemHealthMqttReading {
  if (status !== 'FRESH') return topicState(status, detail);
  const value = payload?.[key];
  if (value === null || value === undefined) return notReported(label);
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < minimum || value > maximum || (integer && !Number.isSafeInteger(value))) {
    return { value: 'INVALID', tone: 'bad', detail: `Fresh observation has an invalid ${label.toLowerCase()}.` };
  }
  return { value: `${String(value)}${unit}`, tone: 'neutral', detail };
}

function mapReportedBoolean(
  status: RdfNodeMqttTopicStatus,
  payload: Record<string, unknown> | null,
  key: string,
  label: string,
  detail: string,
): SystemHealthMqttReading {
  if (status !== 'FRESH') return topicState(status, detail);
  const value = payload?.[key];
  if (value === null || value === undefined) return notReported(label);
  if (typeof value !== 'boolean') {
    return { value: 'INVALID', tone: 'bad', detail: `Fresh observation has an invalid ${label.toLowerCase()}.` };
  }
  return { value: value ? 'TRUE' : 'FALSE', tone: value ? 'warn' : 'good', detail };
}

function mapSyncFlag(
  status: RdfNodeMqttTopicStatus,
  payload: Record<string, unknown> | null,
  index: number,
  label: string,
  detail: string,
): SystemHealthMqttReading {
  if (status !== 'FRESH') return topicState(status, detail);
  const sync = payload?.sync;
  if (sync === null || sync === undefined) return notReported(`Edge ${label} synchronization`);
  if (!Array.isArray(sync) || sync.length !== 3
    || !sync.every((value) => value === true || value === false || value === null)) {
    return { value: 'INVALID', tone: 'bad', detail: 'Fresh health detail has invalid sync flags.' };
  }
  const value = sync[index];
  if (value === null) return notReported(`Edge ${label} synchronization`);
  return { value: value ? 'TRUE' : 'FALSE', tone: value ? 'good' : 'warn', detail };
}

function mapDiagnostic(
  snapshot: RdfNodeMqttSnapshot | null,
  topic: DiagnosticTopic,
  nowMs: number,
): SystemHealthMqttDiagnosticReading {
  const observation = snapshot?.topics[topic];
  const status = diagnosticObservationStatusAt(topic, observation, snapshot, nowMs);
  const age = diagnosticObservationAgeLabels(observation, nowMs);
  const payload = observationPayload(observation);
  const rawDoa = payload?.raw_doa_deg;
  const frequency = topic === 'telemetry/diagnostic/doa'
    ? payload?.frequency_mhz
    : payload?.frequency_hz;
  const reasons = payload?.validation_reasons;
  const freshnessLabel = status === 'FRESH' ? 'FRESH' : TOPIC_STATUS_LABELS[status];
  const detail = `${freshnessLabel} diagnostic observation; UNVERIFIED and not readiness evidence.`;
  return {
    freshness: { value: freshnessLabel, tone: statusTone(status), detail },
    trust: 'UNVERIFIED',
    receiveAge: age.receive,
    sourceAge: age.source,
    reasons: Array.isArray(reasons)
      ? reasons.filter((reason): reason is string => typeof reason === 'string').slice(0, 32)
      : [],
    rawDoa: typeof rawDoa === 'number' && Number.isFinite(rawDoa)
      ? `${String(rawDoa)}°`
      : 'NOT REPORTED',
    frequency: typeof frequency === 'number' && Number.isFinite(frequency)
      ? `${String(frequency)} ${topic === 'telemetry/diagnostic/doa' ? 'MHz' : 'Hz'}`
      : 'NOT REPORTED',
    flags: topic === 'telemetry/diagnostic/angular'
      && typeof payload?.flags === 'number'
      && Number.isInteger(payload.flags)
      && payload.flags >= 0
      && payload.flags <= 0x1f
      ? String(payload.flags)
      : 'NOT REPORTED',
  };
}

function mapSync(
  status: RdfNodeMqttTopicStatus,
  payload: Record<string, unknown> | null,
  detail: string,
): SystemHealthMqttReading {
  if (status !== 'FRESH') return topicState(status, detail);
  const sync = payload?.sync;
  if (sync === null || sync === undefined) return notReported('Edge synchronization');
  if (!Array.isArray(sync) || sync.length !== 3 || !sync.every((value) => value === true || value === false || value === null)) {
    return { value: 'INVALID', tone: 'bad', detail: 'Fresh health detail has invalid sync flags.' };
  }

  const trueCount = sync.filter((value) => value === true).length;
  const falseCount = sync.filter((value) => value === false).length;
  const unknownCount = sync.length - trueCount - falseCount;
  if (unknownCount === 3) return notReported('Edge synchronization');
  return {
    value: `${trueCount} / 3`,
    tone: trueCount === 3 ? 'good' : 'warn',
    detail: `${trueCount} true · ${falseCount} false · ${unknownCount} unknown; ${detail}`,
  };
}

function mapDaq(
  status: RdfNodeMqttTopicStatus,
  payload: Record<string, unknown> | null,
  detail: string,
): SystemHealthMqttReading {
  if (status !== 'FRESH') return topicState(status, detail);
  const daq = payload?.daq;
  if (daq === null || daq === undefined) return notReported('DAQ state');
  switch (daq) {
    case 1: return { value: 'HEALTHY', tone: 'good', detail };
    case 0: return { value: 'DEGRADED', tone: 'warn', detail };
    case 2: return { value: 'UNKNOWN', tone: 'neutral', detail };
    default: return { value: 'INVALID', tone: 'bad', detail: 'Fresh health observation has no valid DAQ state.' };
  }
}

function mapDroppedFrames(
  status: RdfNodeMqttTopicStatus,
  payload: Record<string, unknown> | null,
  detail: string,
): SystemHealthMqttReading {
  if (status !== 'FRESH') return topicState(status, detail);
  const dropped = payload?.drop;
  if (dropped === null || dropped === undefined) return notReported('Dropped-frame count');
  if (typeof dropped !== 'number' || !Number.isSafeInteger(dropped) || dropped < 0) {
    return { value: 'INVALID', tone: 'bad', detail: 'Fresh health observation has an invalid dropped-frame count.' };
  }
  return { value: String(dropped), tone: 'neutral', detail };
}

function mapEdgeClock(
  status: RdfNodeMqttTopicStatus,
  payload: Record<string, unknown> | null,
  detail: string,
): SystemHealthMqttReading {
  if (status !== 'FRESH') return topicState(status, detail);
  if (payload?.clk === null || payload?.clk === undefined) return notReported('Edge clock state');
  if (payload.clk === 1) return { value: 'SYNCED', tone: 'good', detail: 'Edge clock is synchronized.' };
  if (payload.clk === 0) return { value: 'UNTRUSTED', tone: 'warn', detail: 'Edge clock is not synchronized.' };
  return { value: 'INVALID', tone: 'bad', detail: 'Fresh health observation has no valid Edge clock state.' };
}

function mapDoa(
  snapshot: RdfNodeMqttSnapshot | null,
  status: RdfNodeMqttTopicStatus,
  detail: string,
  nowMs: number,
): SystemHealthMqttReading {
  if (status !== 'FRESH') return topicState(status, detail);
  if (snapshot && doaIsCurrent(
    snapshot.topics['telemetry/doa'],
    snapshot.topics['telemetry/health'],
    nowMs,
  )) {
    return { value: 'CURRENT', tone: 'good', detail: 'Canonical telemetry/doa observation passes current health, session, and revision checks.' };
  }
  return { value: 'INCONSISTENT', tone: 'bad', detail: 'DoA observation does not match current health, session, or revision checks.' };
}

export function systemHealthMqttReadings(
  snapshot: RdfNodeMqttSnapshot | null,
  nowMs = Date.now(),
): SystemHealthMqttReadings {
  const health = topicReading(snapshot, 'telemetry/health', nowMs);
  const detail = topicReading(snapshot, 'telemetry/health/detail', nowMs);
  const doa = topicReading(snapshot, 'telemetry/doa', nowMs);
  const healthPayload = health.status === 'FRESH' ? observationPayload(health.observation) : null;
  const detailPayload = detail.status === 'FRESH' ? observationPayload(detail.observation) : null;

  return {
    healthStream: health.reading,
    daq: mapDaq(health.status, healthPayload, health.reading.detail),
    droppedFrames: mapDroppedFrames(health.status, healthPayload, health.reading.detail),
    edgeClock: mapEdgeClock(health.status, healthPayload, health.reading.detail),
    sync: mapSync(detail.status, detailPayload, detail.reading.detail),
    doa: mapDoa(snapshot, doa.status, doa.reading.detail, nowMs),
    edgeHealth: {
      run: mapRun(health.status, healthPayload, health.reading.detail),
      sourceAge: mapReportedNumber(
        health.status, healthPayload, 'age', 'Edge source age', ' ms', 0, 0xffffffff, health.reading.detail, true,
      ),
      temperature: mapReportedNumber(
        health.status, healthPayload, 'temp', 'Edge temperature', ' °C', -100, 200, health.reading.detail,
      ),
    },
    edgeHealthDetail: {
      usb: mapReportedNumber(
        detail.status, detailPayload, 'usb', 'Edge USB code', '', 0, 255, detail.reading.detail, true,
      ),
      sync: {
        frame: mapSyncFlag(detail.status, detailPayload, 0, 'frame', detail.reading.detail),
        sampleDelay: mapSyncFlag(detail.status, detailPayload, 1, 'sample delay', detail.reading.detail),
        iq: mapSyncFlag(detail.status, detailPayload, 2, 'IQ', detail.reading.detail),
      },
      cpu: mapReportedNumber(
        detail.status, detailPayload, 'cpu', 'Edge CPU usage', ' %', 0, 100, detail.reading.detail,
      ),
      memory: mapReportedNumber(
        detail.status, detailPayload, 'mem', 'Edge memory usage', ' %', 0, 100, detail.reading.detail,
      ),
      freeDisk: mapReportedNumber(
        detail.status, detailPayload, 'disk_free', 'Edge free disk', ' %', 0, 100, detail.reading.detail,
      ),
      throttled: mapReportedBoolean(detail.status, detailPayload, 'throt', 'Edge throttling', detail.reading.detail),
      underVoltage: mapReportedBoolean(detail.status, detailPayload, 'uv', 'Edge under-voltage', detail.reading.detail),
      tx: mapReportedNumber(
        detail.status, detailPayload, 'tx', 'Edge TX rate', ' kbit/s', 0, 1_000_000_000, detail.reading.detail,
      ),
      rx: mapReportedNumber(
        detail.status, detailPayload, 'rx', 'Edge RX rate', ' kbit/s', 0, 1_000_000_000, detail.reading.detail,
      ),
      acquisitionDrops: mapReportedNumber(
        detail.status, detailPayload, 'adrop', 'Edge acquisition drops', '', 0, 0xffffffff, detail.reading.detail, true,
      ),
      parseErrors: mapReportedNumber(
        detail.status, detailPayload, 'parse', 'Edge parse errors', '', 0, 0xffffffff, detail.reading.detail, true,
      ),
    },
    diagnosticDoa: mapDiagnostic(snapshot, 'telemetry/diagnostic/doa', nowMs),
    diagnosticAngular: mapDiagnostic(snapshot, 'telemetry/diagnostic/angular', nowMs),
    gps: notProvided('GPS status'),
    csv: notProvided('CSV source'),
    xml: notProvided('XML source'),
    frameIndex: notProvided('DAQ frame index'),
  };
}
