/**
 * View model of the LAN view's read-only Records tab (components/records/RecordsTab.tsx):
 * table rows, calendar cells, the hours of the time line and operator text for a failed
 * read. Pure, so Vitest covers it; the request and the copied Receiver helpers are in
 * recordsArchiveApi.ts and recordsArchiveFormat.ts.
 */
import type { Lang, MessageKey, Translate } from './i18n';
import type { PageTone } from '../components/page/pageContext';
import { RecordsRequestError, audioPlaybackUrl, downloadUrl } from './recordsArchiveApi';
import type { ArchiveCalendar, ArchiveItem } from './recordsArchiveApi';
import {
  ARCHIVE_ERROR_CODES,
  DAY_MONTH_FORMAT,
  formatAudioMHz,
  formatBandwidth,
  formatBytes,
  formatDuration,
  formatScanRange,
  formatScanResolution,
  formatShortDate,
  formatTime,
  HOUR_MS,
  formatterFor,
  localTimeOn,
  statusCode,
} from './recordsArchiveFormat';
import type { ArchiveSortKey, CalendarGrid, TimeRange } from './recordsArchiveFormat';

export type RecordsMode = 'day' | 'all';

/** Sort keys the tablet offers (the Receiver's table also sorts by end, type and status). */
export const RECORDS_SORT_KEYS: readonly ArchiveSortKey[] = ['start', 'duration', 'frequency', 'size'];

/** Codes with their own operator text: the archive's, the LAN view's and the client's own. */
export const RECORDS_ERROR_CODES = [...ARCHIVE_ERROR_CODES, 'LAN_RECORDS_BUSY', 'LAN_READ_ONLY', 'TIMEOUT', 'NETWORK'] as const;

export function recordsLocale(lang: Lang): string {
  return lang === 'id' ? 'id-ID' : 'en-GB';
}

export function recordsErrorText(t: Translate, error: unknown): string {
  if (error instanceof RecordsRequestError && (RECORDS_ERROR_CODES as readonly string[]).includes(error.code)) {
    return t(`records.error.${error.code}` as MessageKey);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return t('records.error.unknown', { error: detail.slice(0, 160) });
}

/** Chip tone of a record status: finished good, cut short warn, failed bad, running info. */
export function recordStatusTone(status: string): PageTone {
  if (status === 'complete') return 'good';
  if (status === 'failed') return 'bad';
  if (status === 'recording' || status === 'running') return 'info';
  return 'warn';
}

export interface RecordRowContext {
  t: Translate;
  locale: string;
  mode: RecordsMode;
  /** The day shown in Day mode; a time on another day also shows its date. */
  dayStartMs: number;
  dayEndMs: number;
  /** File names follow the tablet's zone; tests pass a fixed one. */
  timeZone?: string;
  utcOffsetMinutes?: number;
}

export interface RecordRow {
  key: string;
  kind: ArchiveItem['kind'];
  id: string;
  typeLabel: string;
  /** Source code of a scan (NATIVE, SIMULATED, ...), empty for audio. */
  sourceCode: string;
  startDate: string;
  startTime: string;
  endTime: string;
  frequencyLabel: string;
  modeLabel: string;
  durationLabel: string;
  sizeLabel: string;
  statusCode: string;
  statusTone: PageTone;
  /** The console's text of why a record failed or was cut short. */
  statusTitle: string;
  notSavedLabel: string;
  live: boolean;
  playable: boolean;
  previewable: boolean;
  /** The download link, empty when the record has nothing to download. */
  downloadUrl: string;
  playbackUrl: string;
  /** Short description for accessible names. */
  label: string;
}

function dateAndTime(ms: number | null, context: RecordRowContext): { date: string; time: string } {
  if (ms === null) return { date: '', time: '—' };
  const time = formatTime(ms, context.locale);
  if (context.mode !== 'day') return { date: formatShortDate(ms, context.locale), time };
  const sameDay = ms >= context.dayStartMs && ms < context.dayEndMs;
  return { date: sameDay ? '' : formatterFor(context.locale, DAY_MONTH_FORMAT).format(ms), time };
}

export function recordRow(item: ArchiveItem, context: RecordRowContext): RecordRow {
  const { t } = context;
  const audio = item.kind === 'audio';
  const start = dateAndTime(item.start_ms, context);
  const end = dateAndTime(item.end_ms, context);
  const typeLabel = audio ? (item.vfo_index === null ? 'VFO' : `VFO ${item.vfo_index + 1}`) : t('records.scan');
  const frequencyLabel = audio ? formatAudioMHz(item.frequency_hz) : formatScanRange(item.start_hz, item.end_hz);
  const modeLabel = audio
    ? [item.mode ? item.mode.toUpperCase() : '', item.bandwidth_hz === null ? '' : formatBandwidth(item.bandwidth_hz)].filter(Boolean).join(' · ') || '—'
    : formatScanResolution(item.fft_size);
  const failures = item.trace_upload_failures ?? 0;
  return {
    key: `${item.kind}:${item.id}`,
    kind: item.kind,
    id: item.id,
    typeLabel,
    sourceCode: audio || !item.source ? '' : item.source.toUpperCase(),
    startDate: start.date,
    startTime: start.time,
    endTime: item.end_ms === null ? '' : end.time,
    frequencyLabel,
    modeLabel,
    durationLabel: formatDuration(item.duration_s),
    // A running scan's size is counted when it finishes.
    sizeLabel: !audio && item.status === 'running' ? '—' : formatBytes(item.bytes),
    statusCode: statusCode(item.status),
    statusTone: recordStatusTone(item.status),
    statusTitle: item.error,
    notSavedLabel: failures > 0 ? t('records.notSaved', { count: failures }) : '',
    live: item.status === 'recording' || item.status === 'running',
    playable: audio && item.playable,
    previewable: !audio && item.previewable,
    downloadUrl: item.downloadable ? downloadUrl(item.kind, item.id, context.timeZone, context.utcOffsetMinutes) : '',
    playbackUrl: audio && item.playable ? audioPlaybackUrl(item.id) : '',
    label: `${typeLabel} · ${frequencyLabel} · ${start.date ? `${start.date} ` : ''}${start.time}`,
  };
}

export interface CalendarDay {
  key: string;
  day: number;
  inMonth: boolean;
  audio: number;
  scan: number;
  selected: boolean;
  today: boolean;
  /** A day the zone skipped (no interval): shown, never picked. */
  skipped: boolean;
}

/** The 6x7 cells of a month with the counts the console answered for them. */
export function calendarDays(grid: CalendarGrid, calendar: ArchiveCalendar | null, selectedKey: string, todayKey: string): CalendarDay[] {
  return grid.cells.map((cell) => {
    const counts = calendar && cell.interval >= 0 ? calendar.days[cell.interval] : undefined;
    return {
      key: cell.key,
      day: cell.day,
      inMonth: cell.inMonth,
      audio: counts?.audio ?? 0,
      scan: counts?.scan ?? 0,
      selected: cell.key === selectedKey,
      today: cell.key === todayKey,
      skipped: cell.interval < 0,
    };
  });
}

/** Weekday names, Sunday first, in the page's language (the calendar grid starts on Sunday). */
export function weekdayLabels(locale: string): string[] {
  const formatter = formatterFor(locale, { weekday: 'short' });
  // 2025-03-09 was a Sunday; noon keeps every zone on that date.
  return Array.from({ length: 7 }, (_, index) => formatter.format(localTimeOn(`2025-03-${String(9 + index).padStart(2, '0')}`, 12, 0)));
}

/**
 * Every hour of a day from its local midnight, as the time line's buttons (23, 24 or
 * 25 of them). Absolute hours, so the repeated hour of a fall-back day is its own
 * button (stepping by the local clock would find the first 02:00 twice).
 */
export function dayHours(dayStartMs: number, dayEndMs: number): TimeRange[] {
  const hours: TimeRange[] = [];
  for (let start = dayStartMs; start < dayEndMs && hours.length < 26; start += HOUR_MS) {
    hours.push({ startMs: start, endMs: Math.min(dayEndMs, start + HOUR_MS) });
  }
  return hours;
}
