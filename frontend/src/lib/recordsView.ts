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
  lastPage,
  localTimeOn,
  statusCode,
} from './recordsArchiveFormat';
import type { ArchiveSortKey, ArchiveTypeFilter, CalendarGrid, TimeRange } from './recordsArchiveFormat';

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

/** A calendar answer with the month and type filter it was asked for. */
export interface MonthCounts {
  month: string;
  type: ArchiveTypeFilter;
  calendar: ArchiveCalendar;
}

/**
 * The 6x7 cells of a month with the counts the console answered for them. Counts of
 * another month or type filter (the answer before ‹ › or a type change) are not drawn,
 * as the Receiver's calendarWeeks() does.
 */
export function calendarDays(grid: CalendarGrid, counts: MonthCounts | null, type: ArchiveTypeFilter, selectedKey: string, todayKey: string): CalendarDay[] {
  const days = counts && counts.month === grid.month && counts.type === type ? counts.calendar.days : null;
  return grid.cells.map((cell) => {
    const count = days && cell.interval >= 0 ? days[cell.interval] : undefined;
    return {
      key: cell.key,
      day: cell.day,
      inMonth: cell.inMonth,
      audio: count?.audio ?? 0,
      scan: count?.scan ?? 0,
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

/**
 * The page to show after an items answer: a page past the end (records deleted or
 * removed by retention since it was asked for) becomes the last page, as the
 * Receiver's loadItems() does.
 */
export function pageAfterAnswer(page: number, answer: { items: readonly unknown[]; total: number }, pageSize: number): number {
  if (!answer.items.length && answer.total > 0 && page > 0) return Math.min(page, lastPage(answer.total, pageSize));
  return page;
}

// HTMLMediaElement error codes (MediaError).
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/**
 * Why a recording did not play. `probe` is what the playback route answered when
 * asked again (probePlayback): its refusal (busy, gone, no answer) names the cause;
 * only when the route served the audio is the browser's decoder, or a dropped
 * connection, to blame.
 */
export function playbackErrorText(t: Translate, mediaErrorCode: number | null, probe: unknown): string {
  if (probe) return recordsErrorText(t, probe);
  if (mediaErrorCode === MEDIA_ERR_DECODE || mediaErrorCode === MEDIA_ERR_SRC_NOT_SUPPORTED) return t('records.playUnsupported');
  if (mediaErrorCode === MEDIA_ERR_NETWORK) return t('records.playDropped');
  return t('records.playFailed');
}
