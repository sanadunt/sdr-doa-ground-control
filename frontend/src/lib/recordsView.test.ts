import { afterEach, describe, expect, it } from 'vitest';
import { DICTIONARIES, translate } from './i18n';
import type { MessageKey } from './i18n';
import { RecordsRequestError } from './recordsArchiveApi';
import type { ArchiveCalendar, ArchiveItem } from './recordsArchiveApi';
import { calendarGrid, clearFormatterCache, formatTime, localDateKey, localDayBounds } from './recordsArchiveFormat';
import { RECORDS_ERROR_CODES, calendarDays, dayHours, pageAfterAnswer, playbackErrorText, recordRow, recordStatusTone, recordsErrorText, weekdayLabels } from './recordsView';

const t = (key: MessageKey, vars?: Record<string, string | number>) => translate('en', key, vars);
// Node's process, without the node types the app's tsconfig leaves out.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const savedZone = env.TZ;

/** Runs `body` in a time zone; the cached formatters keep the zone they were made in, so they go too. */
function inZone<T>(zone: string, body: () => T): T {
  env.TZ = zone;
  clearFormatterCache();
  try {
    return body();
  } finally {
    if (savedZone === undefined) delete env.TZ;
    else env.TZ = savedZone;
  }
}

afterEach(() => {
  if (savedZone === undefined) delete env.TZ;
  else env.TZ = savedZone;
});

const AUDIO: ArchiveItem = {
  kind: 'audio', id: '0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8', session_id: 's', start: '2025-03-10T12:00:00+00:00', end: '2025-03-10T12:00:03+00:00',
  start_ms: Date.UTC(2025, 2, 10, 12), end_ms: Date.UTC(2025, 2, 10, 12, 0, 3), duration_s: 3, bytes: 10_240, estimated_bytes: 11_264,
  status: 'complete', error: '', playable: true, previewable: false, downloadable: true, deletable: true, vfo_index: 1,
  frequency_hz: 98_100_000, mode: 'wfm', bandwidth_hz: 200_000, codec: 'audio/webm;codecs=opus', source: null, start_hz: null,
  end_hz: null, fft_size: null, trace_count: null, candidate_count: null, trace_upload_failures: null,
};

const SCAN: ArchiveItem = {
  ...AUDIO, kind: 'scan', id: 'dddddddd-0000-4000-8000-000000000001', session_id: null, playable: false, previewable: true,
  vfo_index: null, frequency_hz: null, mode: null, bandwidth_hz: null, codec: null, source: 'simulated', start_hz: 100e6, end_hz: 200e6,
  fft_size: 4096, trace_count: 12, candidate_count: 3, trace_upload_failures: 2,
};

// Rows are formatted in the test run's own zone (Intl keeps the zone it started with in
// a Vitest worker), so the shown day is the record's local date and times come from
// the same formatter.
describe('record rows', () => {
  const context = (mode: 'day' | 'all') => {
    const day = localDayBounds(localDateKey(AUDIO.start_ms));
    return { t, locale: 'en-GB', mode, dayStartMs: day.startMs, dayEndMs: day.endMs, timeZone: 'UTC', utcOffsetMinutes: 0 };
  };
  const start = () => formatTime(AUDIO.start_ms, 'en-GB');

  it('labels an audio segment with its VFO, frequency, mode and links', () => {
    const row = recordRow(AUDIO, context('day'));
    expect(row).toMatchObject({
      key: `audio:${AUDIO.id}`, typeLabel: 'VFO 2', sourceCode: '', startDate: '', startTime: start(), endTime: formatTime(AUDIO.end_ms ?? 0, 'en-GB'),
      frequencyLabel: '98.100000 MHz', modeLabel: 'WFM · 200 kHz', durationLabel: '0:00:03', sizeLabel: '10.0 KiB',
      statusCode: 'COMPLETE', statusTone: 'good', playable: true, previewable: false, live: false,
      playbackUrl: `/api/receiver/audio-segments/${AUDIO.id}/audio`,
      downloadUrl: `/api/receiver/archive/audio/${AUDIO.id}/download?time_zone=UTC&utc_offset_minutes=0`,
    });
    expect(row.label).toBe(`VFO 2 · 98.100000 MHz · ${start()}`);
  });

  it('labels a scan with its range, resolution, source and the traces not saved', () => {
    const row = recordRow(SCAN, context('all'));
    expect(row).toMatchObject({
      typeLabel: 'Scan', sourceCode: 'SIMULATED', frequencyLabel: '100.000–200.000 MHz', modeLabel: '4.88 kHz', playable: false,
      previewable: true, playbackUrl: '', notSavedLabel: '2 not saved',
      downloadUrl: `/api/receiver/archive/scans/${SCAN.id}/download?time_zone=UTC&utc_offset_minutes=0`,
    });
    expect(row.startDate).not.toBe('');
  });

  it('shows a running scan or recording as live, without size, play or download', () => {
    const running = recordRow({ ...SCAN, status: 'running', end_ms: null, previewable: false, downloadable: false }, context('day'));
    expect(running).toMatchObject({ statusCode: 'SCANNING', statusTone: 'info', live: true, sizeLabel: '—', endTime: '', downloadUrl: '', previewable: false });
    const recording = recordRow({ ...AUDIO, status: 'recording', playable: false, downloadable: false }, context('day'));
    expect(recording).toMatchObject({ statusCode: 'REC', live: true, playable: false, playbackUrl: '', downloadUrl: '' });
    expect(recordStatusTone('interrupted')).toBe('warn');
    expect(recordStatusTone('failed')).toBe('bad');
  });

  it('dates a time on another day in Day mode', () => {
    const row = recordRow({ ...AUDIO, start_ms: context('day').dayStartMs - 60_000 }, context('day'));
    expect(row.startDate).not.toBe('');
  });
});

describe('errors', () => {
  it('has an EN and ID text for every code', () => {
    for (const code of RECORDS_ERROR_CODES) {
      const key = `records.error.${code}`;
      expect(DICTIONARIES.en, key).toHaveProperty([key]);
      expect(DICTIONARIES.id, key).toHaveProperty([key]);
      expect(recordsErrorText(t, new RecordsRequestError('x', 400, code))).toBe(translate('en', key as MessageKey));
    }
  });

  it('names an unknown failure with its message', () => {
    expect(recordsErrorText(t, new RecordsRequestError('boom', 500, 'SOMETHING_ELSE'))).toBe('Records could not be read: boom');
    expect(recordsErrorText(t, new TypeError('items must be an array.'))).toBe('Records could not be read: items must be an array.');
  });
});

describe('calendar and time line', () => {
  it('puts the console counts on the month grid', () => {
    inZone('Asia/Jakarta', () => {
      const grid = calendarGrid('2025-03');
      const tenthInterval = grid.cells.find((cell) => cell.key === '2025-03-10')?.interval ?? -1;
      const calendar: ArchiveCalendar = {
        days: grid.bounds.slice(1).map((_, index) => (index === tenthInterval ? { audio: 2, scan: 1 } : { audio: 0, scan: 0 })),
        first_ms: null, last_ms: null, now_ms: 0, truncated: false,
      };
      const days = calendarDays(grid, { month: '2025-03', type: 'all', calendar }, 'all', '2025-03-10', '2025-03-11');
      expect(days).toHaveLength(42);
      const tenth = days.find((day) => day.key === '2025-03-10');
      expect(tenth).toMatchObject({ audio: 2, scan: 1, selected: true, today: false, inMonth: true, skipped: false });
      expect(days.find((day) => day.key === '2025-03-11')?.today).toBe(true);
      expect(days[0]).toMatchObject({ key: '2025-02-23', inMonth: false });
      expect(calendarDays(grid, null, 'all', '', '').every((day) => day.audio === 0 && day.scan === 0)).toBe(true);
    });
  });

  it("shows no counts of another month or type while the grid's own load", () => {
    inZone('Asia/Jakarta', () => {
      const february = calendarGrid('2025-02');
      const calendar: ArchiveCalendar = {
        days: february.bounds.slice(1).map(() => ({ audio: 3, scan: 2 })), first_ms: null, last_ms: null, now_ms: 0, truncated: false,
      };
      const march = calendarGrid('2025-03');
      const empty = (days: ReturnType<typeof calendarDays>) => days.every((day) => day.audio === 0 && day.scan === 0);
      // February's answer on March's grid (after ›, before March answers): no dots.
      expect(empty(calendarDays(march, { month: '2025-02', type: 'all', calendar }, 'all', '', ''))).toBe(true);
      // An answer for another type filter: no dots either.
      expect(empty(calendarDays(february, { month: '2025-02', type: 'audio', calendar }, 'all', '', ''))).toBe(true);
      expect(empty(calendarDays(february, { month: '2025-02', type: 'all', calendar }, 'all', '', ''))).toBe(false);
    });
  });

  it('marks a day the zone skipped', () => {
    inZone('Pacific/Apia', () => {
      const skipped = calendarDays(calendarGrid('2011-12'), null, 'all', '', '').find((day) => day.key === '2011-12-30');
      expect(skipped?.skipped).toBe(true);
    });
  });

  it('gives one button per local hour on 23, 24 and 25 hour days', () => {
    inZone('Europe/Berlin', () => {
      for (const [key, count] of [['2025-03-30', 23], ['2025-03-10', 24], ['2025-10-26', 25]] as const) {
        const day = localDayBounds(key);
        const hours = dayHours(day.startMs, day.endMs);
        expect(hours, key).toHaveLength(count);
        expect(hours[0].startMs).toBe(day.startMs);
        expect(hours[hours.length - 1].endMs).toBe(day.endMs);
        for (let index = 1; index < hours.length; index++) expect(hours[index].startMs).toBe(hours[index - 1].endMs);
      }
    });
  });

  it('names the weekdays Sunday first', () => {
    expect(weekdayLabels('en-GB')).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    expect(weekdayLabels('id-ID')[0]).toBe('Min');
  });
});

describe('paging after the records changed', () => {
  it('moves an empty page past the end to the last page, as the Receiver does', () => {
    // Page 3 of 120 (offset 100) after the groundstation deleted 60 records.
    expect(pageAfterAnswer(2, { items: [], total: 60 }, 50)).toBe(1);
    expect(pageAfterAnswer(5, { items: [], total: 1 }, 50)).toBe(0);
    // A page with rows, the first page and an empty archive stay where they are.
    expect(pageAfterAnswer(2, { items: [{}], total: 120 }, 50)).toBe(2);
    expect(pageAfterAnswer(0, { items: [], total: 0 }, 50)).toBe(0);
    expect(pageAfterAnswer(3, { items: [], total: 0 }, 50)).toBe(3);
  });
});

describe('playback errors', () => {
  const MEDIA_ERR_NETWORK = 2;
  const MEDIA_ERR_DECODE = 3;
  const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

  it('names what the console answered when the playback route refused', () => {
    const busy = new RecordsRequestError('at most 4 Records downloads at once', 429, 'LAN_RECORDS_BUSY');
    expect(playbackErrorText(t, MEDIA_ERR_SRC_NOT_SUPPORTED, busy)).toBe(translate('en', 'records.error.LAN_RECORDS_BUSY'));
    const missing = new RecordsRequestError('The audio file is missing.', 404, 'ARCHIVE_FILE_MISSING');
    expect(playbackErrorText(t, MEDIA_ERR_SRC_NOT_SUPPORTED, missing)).toBe(translate('en', 'records.error.ARCHIVE_FILE_MISSING'));
    expect(playbackErrorText(t, MEDIA_ERR_NETWORK, new RecordsRequestError('Failed to fetch', 0, 'NETWORK'))).toBe(translate('en', 'records.error.NETWORK'));
  });

  it('blames the browser only when the route answered and the media could not be decoded', () => {
    expect(playbackErrorText(t, MEDIA_ERR_SRC_NOT_SUPPORTED, null)).toBe(translate('en', 'records.playUnsupported'));
    expect(playbackErrorText(t, MEDIA_ERR_DECODE, null)).toBe(translate('en', 'records.playUnsupported'));
    expect(playbackErrorText(t, MEDIA_ERR_NETWORK, null)).toBe(translate('en', 'records.playDropped'));
    expect(playbackErrorText(t, null, null)).toBe(translate('en', 'records.playFailed'));
  });
});
