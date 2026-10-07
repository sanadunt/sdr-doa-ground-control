export const MAX_SYSTEM_HEALTH_HISTORY_ENTRIES = 2_000;
export const SYSTEM_HEALTH_HISTORY_STORAGE_KEY = 'sdr-doa-ground-control.system-health-history.v1';
export const SYSTEM_HEALTH_MQTT_HISTORY_STORAGE_KEY = 'sdr-doa-ground-control.system-health-history.v2';

export interface SystemHealthHistoryValues {
  overall: string;
  data_out: string;
  daq: string;
  gps: string;
  sync: string;
  csv: string;
  xml: string;
  doa: string;
  ground_clock: string;
  frame_index: string;
  dropped_frames: string;
  usb: string;
  ppp: string;
  peer: string;
  mqtt: string;
}

export interface SystemHealthHistoryEntry {
  captured_at_ms: number;
  checked_at_ms: number;
  values: SystemHealthHistoryValues;
}

export interface SystemHealthMqttHistoryValues {
  edge_health: string;
  daq: string;
  dropped_frames: string;
  edge_clock: string;
  sync: string;
  doa: string;
  gps: string;
  csv: string;
  xml: string;
  frame_index: string;
  usb: string;
  ppp: string;
  peer: string;
  mqtt: string;
}

export interface SystemHealthMqttHistoryEntry {
  source: 'mqtt-v2';
  captured_at_ms: number;
  checked_at_ms: number;
  values: SystemHealthMqttHistoryValues;
}

export type SystemHealthHistoryRecord =
  | (SystemHealthHistoryEntry & { source: 'legacy-data-out' })
  | SystemHealthMqttHistoryEntry;

const HISTORY_FIELDS = [
  'overall',
  'data_out',
  'daq',
  'gps',
  'sync',
  'csv',
  'xml',
  'doa',
  'ground_clock',
  'frame_index',
  'dropped_frames',
  'usb',
  'ppp',
  'peer',
  'mqtt',
] as const satisfies readonly (keyof SystemHealthHistoryValues)[];

const MQTT_HISTORY_FIELDS = [
  'edge_health',
  'daq',
  'dropped_frames',
  'edge_clock',
  'sync',
  'doa',
  'gps',
  'csv',
  'xml',
  'frame_index',
  'usb',
  'ppp',
  'peer',
  'mqtt',
] as const satisfies readonly (keyof SystemHealthMqttHistoryValues)[];

type CsvColumn = {
  heading: string;
  value: (record: SystemHealthHistoryRecord) => string;
};

const CSV_COLUMNS: readonly CsvColumn[] = [
  { heading: 'Overall telemetry', value: (record) => record.source === 'legacy-data-out' ? record.values.overall : '' },
  { heading: 'Data Out / HTTP', value: (record) => record.source === 'legacy-data-out' ? record.values.data_out : '' },
  { heading: 'Edge health stream', value: (record) => record.source === 'mqtt-v2' ? record.values.edge_health : '' },
  { heading: 'DAQ / acquisition', value: (record) => record.values.daq },
  { heading: 'Dropped frames', value: (record) => record.values.dropped_frames },
  { heading: 'Edge clock', value: (record) => record.source === 'mqtt-v2' ? record.values.edge_clock : '' },
  { heading: 'GPS status', value: (record) => record.values.gps },
  { heading: 'Sync flags', value: (record) => record.values.sync },
  { heading: 'CSV source', value: (record) => record.values.csv },
  { heading: 'XML source', value: (record) => record.values.xml },
  { heading: 'DoA / native views', value: (record) => record.source === 'legacy-data-out' ? record.values.doa : '' },
  { heading: 'DoA estimate', value: (record) => record.source === 'mqtt-v2' ? record.values.doa : '' },
  { heading: 'Ground clock', value: (record) => record.source === 'legacy-data-out' ? record.values.ground_clock : '' },
  { heading: 'Frame index', value: (record) => record.source === 'legacy-data-out' ? record.values.frame_index : '' },
  { heading: 'DAQ frame index', value: (record) => record.source === 'mqtt-v2' ? record.values.frame_index : '' },
  { heading: 'Local USB telemetry', value: (record) => record.values.usb },
  { heading: 'PPP interface', value: (record) => record.values.ppp },
  { heading: 'Raspberry peer', value: (record) => record.values.peer },
  { heading: 'MQTT monitor', value: (record) => record.source === 'legacy-data-out' ? record.values.mqtt : '' },
  { heading: 'MQTT v2 connection', value: (record) => record.source === 'mqtt-v2' ? record.values.mqtt : '' },
];


function isTimestamp(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && Number.isFinite(new Date(value).getTime());
}

function normalizeEntry(value: unknown): SystemHealthHistoryEntry | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!('captured_at_ms' in value) || !('checked_at_ms' in value) || !('values' in value)) return null;

  const capturedAt = Reflect.get(value, 'captured_at_ms');
  const checkedAt = Reflect.get(value, 'checked_at_ms');
  const values = Reflect.get(value, 'values');
  if (!isTimestamp(capturedAt) || !isTimestamp(checkedAt) || values === null || typeof values !== 'object' || Array.isArray(values)) {
    return null;
  }

  const normalizedValues = {} as SystemHealthHistoryValues;
  for (const field of HISTORY_FIELDS) {
    const cell = Reflect.get(values, field);
    if (typeof cell !== 'string' || cell.length > 120 || /[\u0000-\u001f\u007f]/.test(cell)) {
      return null;
    }
    normalizedValues[field] = cell;
  }

  return {
    captured_at_ms: capturedAt,
    checked_at_ms: checkedAt,
    values: normalizedValues,
  };
}

function normalizeEntries(entries: readonly SystemHealthHistoryEntry[]): SystemHealthHistoryEntry[] {
  const unique: SystemHealthHistoryEntry[] = [];
  const checkedTimes = new Set<number>();
  for (const entry of entries) {
    const normalized = normalizeEntry(entry);
    if (!normalized) throw new TypeError('Invalid System Health history entry');
    if (checkedTimes.has(normalized.checked_at_ms)) continue;
    checkedTimes.add(normalized.checked_at_ms);
    unique.push(normalized);
  }
  return unique.slice(-MAX_SYSTEM_HEALTH_HISTORY_ENTRIES);
}

export function parseSystemHealthHistory(raw: string | null): SystemHealthHistoryEntry[] {
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new TypeError('System Health history must be an array');

  const entries = parsed.map((entry) => {
    const normalized = normalizeEntry(entry);
    if (!normalized) throw new TypeError('Invalid System Health history entry');
    return normalized;
  });
  return normalizeEntries(entries);
}

export function appendSystemHealthHistory(
  history: readonly SystemHealthHistoryEntry[],
  entry: SystemHealthHistoryEntry,
): SystemHealthHistoryEntry[] {
  const normalizedHistory = normalizeEntries(history);
  const normalizedEntry = normalizeEntry(entry);
  if (!normalizedEntry) throw new TypeError('Invalid System Health history entry');
  if (normalizedHistory.some((saved) => saved.checked_at_ms === normalizedEntry.checked_at_ms)) {
    return normalizedHistory;
  }
  return [...normalizedHistory, normalizedEntry].slice(-MAX_SYSTEM_HEALTH_HISTORY_ENTRIES);
}

function normalizeMqttEntry(value: unknown): SystemHealthMqttHistoryEntry | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!('captured_at_ms' in value) || !('checked_at_ms' in value) || !('values' in value)) return null;
  if (Reflect.get(value, 'source') !== 'mqtt-v2') return null;

  const capturedAt = Reflect.get(value, 'captured_at_ms');
  const checkedAt = Reflect.get(value, 'checked_at_ms');
  const values = Reflect.get(value, 'values');
  if (!isTimestamp(capturedAt) || !isTimestamp(checkedAt) || values === null || typeof values !== 'object' || Array.isArray(values)) {
    return null;
  }

  const normalizedValues = {} as SystemHealthMqttHistoryValues;
  for (const field of MQTT_HISTORY_FIELDS) {
    const cell = Reflect.get(values, field);
    if (typeof cell !== 'string' || cell.length > 120 || /[\u0000-\u001f\u007f]/.test(cell)) {
      return null;
    }
    normalizedValues[field] = cell;
  }

  return {
    source: 'mqtt-v2',
    captured_at_ms: capturedAt,
    checked_at_ms: checkedAt,
    values: normalizedValues,
  };
}

function normalizeMqttEntries(entries: readonly SystemHealthMqttHistoryEntry[]): SystemHealthMqttHistoryEntry[] {
  const unique: SystemHealthMqttHistoryEntry[] = [];
  const checkedTimes = new Set<number>();
  for (const entry of entries) {
    const normalized = normalizeMqttEntry(entry);
    if (!normalized) throw new TypeError('Invalid MQTT System Health history entry');
    if (checkedTimes.has(normalized.checked_at_ms)) continue;
    checkedTimes.add(normalized.checked_at_ms);
    unique.push(normalized);
  }
  return unique.slice(-MAX_SYSTEM_HEALTH_HISTORY_ENTRIES);
}

export function parseSystemHealthMqttHistory(raw: string | null): SystemHealthMqttHistoryEntry[] {
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new TypeError('MQTT System Health history must be an array');

  const entries = parsed.map((entry) => {
    const normalized = normalizeMqttEntry(entry);
    if (!normalized) throw new TypeError('Invalid MQTT System Health history entry');
    return normalized;
  });
  return normalizeMqttEntries(entries);
}

export function appendSystemHealthMqttHistory(
  history: readonly SystemHealthMqttHistoryEntry[],
  entry: SystemHealthMqttHistoryEntry,
): SystemHealthMqttHistoryEntry[] {
  const normalizedHistory = normalizeMqttEntries(history);
  const normalizedEntry = normalizeMqttEntry(entry);
  if (!normalizedEntry) throw new TypeError('Invalid MQTT System Health history entry');
  if (normalizedHistory.some((saved) => saved.checked_at_ms === normalizedEntry.checked_at_ms)) {
    return normalizedHistory;
  }
  return [...normalizedHistory, normalizedEntry].slice(-MAX_SYSTEM_HEALTH_HISTORY_ENTRIES);
}

export function parseSystemHealthHistoryRecords(
  legacyRaw: string | null,
  mqttRaw: string | null,
): SystemHealthHistoryRecord[] {
  const legacy = parseSystemHealthHistory(legacyRaw).map((entry) => ({
    ...entry,
    source: 'legacy-data-out' as const,
  }));
  const mqtt = parseSystemHealthMqttHistory(mqttRaw);
  return [...legacy, ...mqtt].sort((left, right) => (
    left.captured_at_ms < right.captured_at_ms ? -1 : left.captured_at_ms > right.captured_at_ms ? 1 : 0
  ));
}

function normalizeHistoryRecord(value: unknown): SystemHealthHistoryRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = Reflect.get(value, 'source');
  if (source === 'legacy-data-out') {
    const normalized = normalizeEntry(value);
    return normalized ? { ...normalized, source } : null;
  }
  if (source === 'mqtt-v2') return normalizeMqttEntry(value);
  return null;
}

function normalizeHistoryRecords(history: readonly SystemHealthHistoryRecord[]): SystemHealthHistoryRecord[] {
  const unique: SystemHealthHistoryRecord[] = [];
  const checkedTimes = new Set<string>();
  for (const record of history) {
    const normalized = normalizeHistoryRecord(record);
    if (!normalized) throw new TypeError('Invalid System Health history record');
    const checkedTime = `${normalized.source}:${normalized.checked_at_ms}`;
    if (checkedTimes.has(checkedTime)) continue;
    checkedTimes.add(checkedTime);
    unique.push(normalized);
  }
  return unique;
}

function csvCell(value: string): string {
  const safe = /^[\u0000-\u0020]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function systemHealthHistoryToCsv(history: readonly SystemHealthHistoryRecord[]): string {
  const entries = normalizeHistoryRecords(history);
  const headings = [
    'Source',
    'Captured at (UTC)',
    'Local System Health probe checked at (UTC)',
    ...CSV_COLUMNS.map(({ heading }) => heading),
  ];
  const rows = entries.map((record) => [
    record.source === 'legacy-data-out' ? 'Legacy Data Out' : 'MQTT v2',
    new Date(record.captured_at_ms).toISOString(),
    new Date(record.checked_at_ms).toISOString(),
    ...CSV_COLUMNS.map(({ value }) => value(record)),
  ]);
  return [headings, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}
