import { describe, expect, it } from 'vitest';
import {
  appendSystemHealthHistory,
  appendSystemHealthMqttHistory,
  parseSystemHealthHistory,
  parseSystemHealthHistoryRecords,
  parseSystemHealthMqttHistory,
  systemHealthHistoryToCsv,
} from './systemHealthHistory';
import type {
  SystemHealthHistoryEntry,
  SystemHealthHistoryValues,
  SystemHealthMqttHistoryEntry,
  SystemHealthMqttHistoryValues,
} from './systemHealthHistory';

function historyEntry(
  capturedAt: number,
  checkedAt: number,
  overrides: Partial<SystemHealthHistoryValues> = {},
): SystemHealthHistoryEntry {
  return {
    captured_at_ms: capturedAt,
    checked_at_ms: checkedAt,
    values: {
      overall: 'READY',
      data_out: 'AVAILABLE',
      daq: 'PASS',
      gps: 'UNKNOWN',
      sync: '3 / 3',
      csv: 'AVAILABLE',
      xml: 'UNAVAILABLE',
      doa: 'PRESENT',
      ground_clock: 'UNVERIFIED',
      frame_index: '42',
      dropped_frames: '0',
      usb: 'PRESENT',
      ppp: 'UP',
      peer: 'REACHABLE',
      mqtt: 'OFF',
      ...overrides,
    },
  };
}

function mqttHistoryEntry(
  capturedAt: number,
  checkedAt: number,
  overrides: Partial<SystemHealthMqttHistoryValues> = {},
): SystemHealthMqttHistoryEntry {
  return {
    source: 'mqtt-v2',
    captured_at_ms: capturedAt,
    checked_at_ms: checkedAt,
    values: {
      edge_health: 'CURRENT',
      daq: 'HEALTHY',
      dropped_frames: '12',
      edge_clock: 'SYNCED',
      sync: '3 / 3',
      doa: 'CURRENT',
      gps: 'NOT PROVIDED',
      csv: 'NOT PROVIDED',
      xml: 'NOT PROVIDED',
      frame_index: 'NOT PROVIDED',
      usb: 'PRESENT',
      ppp: 'UP',
      peer: 'REACHABLE',
      mqtt: 'READY',
      ...overrides,
    },
  };
}

describe('System Health local history', () => {
  it('keeps one entry per authoritative probe timestamp', () => {
    const first = historyEntry(1_750_000_000_000, 1_750_000_000_000);
    const duplicate = historyEntry(1_750_000_000_500, 1_750_000_000_000, { overall: 'STALE' });

    expect(appendSystemHealthHistory([first], duplicate)).toEqual([first]);
  });

  it('retains only the newest 2,000 checks', () => {
    const existing = Array.from({ length: 2_000 }, (_, index) => historyEntry(index + 1, index + 1));
    const appended = appendSystemHealthHistory(existing, historyEntry(2_001, 2_001));

    expect(appended).toHaveLength(2_000);
    expect(appended[0]?.checked_at_ms).toBe(2);
    expect(appended.at(-1)?.checked_at_ms).toBe(2_001);
  });

  it('rejects corrupt persisted history instead of silently replacing it', () => {
    expect(() => parseSystemHealthHistory('{broken')).toThrow();
    expect(() => parseSystemHealthHistory(JSON.stringify([{ checked_at_ms: 1 }]))).toThrow();
  });

  it('exports timestamps and status values as CSV-safe cells', () => {
    const legacy = {
      ...historyEntry(1_750_000_000_000, 1_750_000_000_000, {
        overall: '=1+1',
        daq: 'PASS, verified',
      }),
      source: 'legacy-data-out' as const,
    };
    const csv = systemHealthHistoryToCsv([legacy]);

    expect(csv).toContain('"Source"');
    expect(csv).toContain('"Captured at (UTC)"');
    expect(csv).toContain('"Local System Health probe checked at (UTC)"');
    expect(csv).toContain('"2025-06-15T15:06:40.000Z"');
    expect(csv).toContain('"Legacy Data Out"');
    expect(csv).toContain(',"\'=1+1",');
    expect(csv).toContain('"PASS, verified"');
  });
  it('parses only source-tagged summary fields', () => {
    const entry = mqttHistoryEntry(1_750_000_000_000, 1_750_000_000_000);
    expect(parseSystemHealthMqttHistory(JSON.stringify([entry]))).toEqual([entry]);

    const withUnknownFields = {
      ...entry,
      payload: { secret: 'raw-topic-payload' },
      values: { ...entry.values, payload: 'raw-topic-payload' },
    };
    expect(parseSystemHealthMqttHistory(JSON.stringify([withUnknownFields]))).toEqual([entry]);

    const missingSource = { ...entry, source: undefined };
    const wrongSource = { ...entry, source: 'legacy-data-out' };
    expect(() => parseSystemHealthMqttHistory(JSON.stringify([missingSource]))).toThrow();
    expect(() => parseSystemHealthMqttHistory(JSON.stringify([wrongSource]))).toThrow();
  });

  it('rejects invalid timestamps and cells', () => {
    const entry = mqttHistoryEntry(1_750_000_000_000, 1_750_000_000_000);
    const invalidTimes: unknown[] = [
      { ...entry, captured_at_ms: 1.5 },
      { ...entry, checked_at_ms: Number.MAX_SAFE_INTEGER + 1 },
      { ...entry, captured_at_ms: -1 },
      { ...entry, checked_at_ms: 8_640_000_000_000_001 },
    ];
    for (const invalid of invalidTimes) {
      expect(() => parseSystemHealthMqttHistory(JSON.stringify([invalid]))).toThrow();
    }

    const missingCell = JSON.parse(JSON.stringify(entry)) as { values: Record<string, unknown> };
    delete missingCell.values.sync;
    const invalidCells = [
      missingCell,
      { ...entry, values: { ...entry.values, daq: 'x'.repeat(121) } },
      { ...entry, values: { ...entry.values, edge_health: 'bad\u0000value' } },
    ];
    for (const invalid of invalidCells) {
      expect(() => parseSystemHealthMqttHistory(JSON.stringify([invalid]))).toThrow();
    }
  });

  it('deduplicates local probe times and caps at 2,000 entries', () => {
    const first = mqttHistoryEntry(1_750_000_000_000, 1_750_000_000_000);
    const duplicate = mqttHistoryEntry(1_750_000_000_500, 1_750_000_000_000, { daq: 'DEGRADED' });
    expect(appendSystemHealthMqttHistory([first], duplicate)).toEqual([first]);
    expect(parseSystemHealthMqttHistory(JSON.stringify([first, duplicate]))).toEqual([first]);

    const existing = Array.from({ length: 2_000 }, (_, index) => mqttHistoryEntry(index + 1, index + 1));
    const appended = appendSystemHealthMqttHistory(existing, mqttHistoryEntry(2_001, 2_001));
    expect(appended).toHaveLength(2_000);
    expect(appended[0]?.checked_at_ms).toBe(2);
    expect(appended.at(-1)?.checked_at_ms).toBe(2_001);
  });

  it('keeps v1 history readable without relabeling its records', () => {
    const legacy = historyEntry(1_750_000_000_000, 1_750_000_000_000);
    expect(parseSystemHealthHistory(JSON.stringify([legacy]))).toEqual([legacy]);
  });

  it('tags legacy v1 records without rewriting them', () => {
    const legacy = historyEntry(100, 110);

    expect(parseSystemHealthHistoryRecords(JSON.stringify([legacy]), null)).toEqual([
      { ...legacy, source: 'legacy-data-out' },
    ]);
  });

  it('sorts combined history by capture time', () => {
    const earlierLegacy = historyEntry(100, 110);
    const laterLegacy = historyEntry(300, 310);
    const middleMqtt = mqttHistoryEntry(200, 210);
    const records = parseSystemHealthHistoryRecords(
      JSON.stringify([laterLegacy, earlierLegacy]),
      JSON.stringify([middleMqtt]),
    );

    expect(records.map(({ source, captured_at_ms }) => [source, captured_at_ms])).toEqual([
      ['legacy-data-out', 100],
      ['mqtt-v2', 200],
      ['legacy-data-out', 300],
    ]);
  });

  it('exports_source_specific_csv_rows', () => {
    const legacy = {
      ...historyEntry(100, 110, { data_out: 'LEGACY-DATA-OUT' }),
      source: 'legacy-data-out' as const,
    };
    const mqtt = mqttHistoryEntry(200, 210, { edge_health: 'MQTT-CURRENT' });
    const csv = systemHealthHistoryToCsv([legacy, mqtt]);
    const rows = csv.split('\n');

    expect(rows[0]).toContain('"Source"');
    expect(rows[1]).toContain('"Legacy Data Out"');
    expect(rows[1]).toContain('"LEGACY-DATA-OUT"');
    expect(rows[2]).toContain('"MQTT v2"');
    expect(rows[2]).toContain('"MQTT-CURRENT"');
    expect(csv).not.toContain('raw-topic-payload');
  });
});
