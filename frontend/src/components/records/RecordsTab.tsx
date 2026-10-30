import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, KeyboardEvent, SyntheticEvent } from 'react';
import { useI18n } from '../../lib/i18n';
import type { Translate } from '../../lib/i18n';
import { RECORDS_PAGE_SIZE, createRecordsClient, isAbortError, probePlayback } from '../../lib/recordsArchiveApi';
import type { ArchiveFacets, ArchiveItemsPage, ArchiveScanPreview, ArchiveTimeline, RecordsClient } from '../../lib/recordsArchiveApi';
import {
  ARCHIVE_STATUSES,
  addMonths,
  calendarGrid,
  defaultSortOrder,
  emptyFilters,
  formatAudioMHz,
  formatBandwidth,
  formatBytes,
  formatDateKeyLabel,
  formatHour,
  formatMonthLabel,
  frequencyFieldErrors,
  itemsQuery,
  localDateKey,
  localDayBounds,
  monthKeyOf,
  pageCount,
  pageRangeLabel,
  recordsTimeQuery,
  shiftExistingDay,
  timelineBars,
  timelineHourLines,
  timelineQuery,
  timelineTicks,
  timelineWidth,
  timelineX,
  tracePlot,
} from '../../lib/recordsArchiveFormat';
import type { ArchiveFilters, ArchiveSortKey, ArchiveTypeFilter, TimeRange } from '../../lib/recordsArchiveFormat';
import {
  RECORDS_SORT_KEYS,
  calendarDays,
  dayHours,
  pageAfterAnswer,
  playbackErrorText,
  recordRow,
  recordsErrorText,
  recordsLocale,
  weekdayLabels,
} from '../../lib/recordsView';
import type { MonthCounts, RecordRow, RecordsMode } from '../../lib/recordsView';
import { Card, EmptyState, FormField, Notice, Segmented, StatusChip, Tag, Toolbar } from '../page';

export interface ReadState<T> {
  /** The key of the read `data` and `error` came from (an earlier one while a new read loads). */
  key: string | null;
  data: T | null;
  error: unknown;
  loading: boolean;
}

/**
 * One read per key: a new key aborts the read before (a queued read never goes
 * out) and keeps the last data on screen while the new one loads, so a caller
 * that must not show another read's data checks `key` or the data itself. A
 * null key reads nothing.
 */
function useRead<T>(key: string | null, read: (signal: AbortSignal) => Promise<T>): ReadState<T> {
  const readRef = useRef(read);
  readRef.current = read;
  const [state, setState] = useState<ReadState<T>>({ key: null, data: null, error: null, loading: false });
  useEffect(() => {
    if (key === null) {
      setState({ key: null, data: null, error: null, loading: false });
      return undefined;
    }
    const controller = new AbortController();
    setState((previous) => ({ key: previous.key, data: previous.data, error: null, loading: true }));
    readRef.current(controller.signal).then(
      (data) => { if (!controller.signal.aborted) setState({ key, data, error: null, loading: false }); },
      (error: unknown) => {
        if (!controller.signal.aborted && !isAbortError(error)) setState({ key, data: null, error, loading: false });
      },
    );
    return () => controller.abort();
  }, [key]);
  return state;
}

function previewKeyPrefix(scanId: string): string {
  return `preview:${scanId}:`;
}

function previewKey(scanId: string, reload: number): string {
  return `${previewKeyPrefix(scanId)}${reload}`;
}

interface TextFilters {
  minMHz: string;
  maxMHz: string;
  q: string;
}

const TEXT_FILTER_DELAY_MS = 400;

function sameRange(a: TimeRange | null, b: TimeRange): boolean {
  return a !== null && a.startMs === b.startMs && a.endMs === b.endMs;
}

function Calendar({ t, locale, monthKey, type, dateKey, todayKey, counts, error, onMonth, onPick }: {
  t: Translate;
  locale: string;
  monthKey: string;
  type: ArchiveTypeFilter;
  dateKey: string;
  todayKey: string;
  counts: MonthCounts | null;
  /** The failure of this month's read, if it failed. */
  error: unknown;
  onMonth: (monthKey: string) => void;
  onPick: (dateKey: string) => void;
}): JSX.Element {
  const grid = useMemo(() => calendarGrid(monthKey), [monthKey]);
  const days = calendarDays(grid, counts, type, dateKey, todayKey);
  const weekdays = useMemo(() => weekdayLabels(locale), [locale]);
  return (
    <div className="rec-cal">
      <div className="rec-cal-head">
        <button type="button" className="ov-button" aria-label={t('records.prevMonth')} onClick={() => onMonth(addMonths(monthKey, -1))}>‹</button>
        <strong className="rec-cal-month">{formatMonthLabel(monthKey, locale)}</strong>
        <button type="button" className="ov-button" aria-label={t('records.nextMonth')} onClick={() => onMonth(addMonths(monthKey, 1))}>›</button>
      </div>
      <div className="rec-cal-grid" role="grid" aria-label={formatMonthLabel(monthKey, locale)}>
        {weekdays.map((name) => <span key={name} className="rec-cal-weekday" aria-hidden="true">{name}</span>)}
        {days.map((day) => (
          <button
            key={day.key}
            type="button"
            className={['rec-cal-day', day.inMonth ? '' : 'is-outside', day.today ? 'is-today' : ''].filter(Boolean).join(' ')}
            aria-pressed={day.selected}
            disabled={day.skipped}
            aria-label={t('records.dayCounts', { date: formatDateKeyLabel(day.key, locale), audio: day.audio, scan: day.scan })}
            onClick={() => onPick(day.key)}
          >
            <span>{day.day}</span>
            <span className="rec-cal-dots" aria-hidden="true">
              {day.audio > 0 ? <i className="is-audio" /> : null}
              {day.scan > 0 ? <i className="is-scan" /> : null}
            </span>
          </button>
        ))}
      </div>
      {error ? <Notice tone="bad">{recordsErrorText(t, error)}</Notice> : null}
    </div>
  );
}

function Timeline({ t, locale, dateKey, timeline, selected, onSelect }: {
  t: Translate;
  locale: string;
  dateKey: string;
  timeline: ArchiveTimeline | null;
  selected: TimeRange | null;
  onSelect: (range: TimeRange | null) => void;
}): JSX.Element {
  const day = useMemo(() => localDayBounds(dateKey), [dateKey]);
  const width = timelineWidth(day.startMs, day.endMs);
  const length = day.endMs - day.startMs;
  const hours = useMemo(() => dayHours(day.startMs, day.endMs), [day]);
  const ticks = timelineTicks(day.startMs, day.endMs, (ms) => formatHour(ms, locale));
  const audioBars = timeline ? timelineBars(timeline.audio, day.startMs, day.endMs) : [];
  const scanBars = timeline ? timelineBars(timeline.scan, day.startMs, day.endMs) : [];
  const selectedX = selected ? timelineX(selected.startMs, day.startMs, day.endMs) : 0;
  const selectedWidth = selected ? timelineX(selected.endMs, day.startMs, day.endMs) - selectedX : 0;
  return (
    <div className="rec-tl">
      <div className="rec-tl-strip">
        <svg viewBox={`0 0 ${width} 24`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          {timelineHourLines(day.startMs, day.endMs).map((x) => <line key={x} className="rec-tl-grid" x1={x} x2={x} y1={0} y2={24} />)}
          {selected ? <rect className="rec-tl-sel" x={selectedX} width={selectedWidth} y={0} height={24} /> : null}
          {audioBars.map((bar, index) => <rect key={`a${index}`} className="rec-tl-audio" x={bar.x} width={bar.width} y={2} height={9} />)}
          {scanBars.map((bar, index) => <rect key={`s${index}`} className="rec-tl-scan" x={bar.x} width={bar.width} y={13} height={9} />)}
        </svg>
        <div className="rec-tl-hours" role="group" aria-label={t('records.timeline', { date: formatDateKeyLabel(dateKey, locale) })}>
          {hours.map((hour) => {
            const pressed = sameRange(selected, hour);
            return (
              <button
                key={hour.startMs}
                type="button"
                aria-pressed={pressed}
                aria-label={t('records.hour', { from: formatHour(hour.startMs, locale), to: formatHour(hour.endMs, locale) })}
                style={{ left: `${((hour.startMs - day.startMs) / length) * 100}%`, width: `${((hour.endMs - hour.startMs) / length) * 100}%` }}
                onClick={() => onSelect(pressed ? null : hour)}
              />
            );
          })}
        </div>
      </div>
      <div className="rec-tl-ticks" aria-hidden="true">
        {ticks.map((tick) => <span key={tick.ms} className={tick.minor ? 'is-minor' : undefined} style={{ left: `${tick.pct}%` }}>{tick.label}</span>)}
      </div>
    </div>
  );
}

/**
 * A scan's preview under its row. The read keeps the previous scan's answer while
 * this one loads (one read at a time), so only an answer with this scan's id is
 * drawn, as the Receiver checks previewData.id.
 */
export function ScanPreview({ t, scanId, preview }: { t: Translate; scanId: string; preview: ReadState<ArchiveScanPreview> }): JSX.Element {
  const ownRead = preview.key !== null && preview.key.startsWith(previewKeyPrefix(scanId));
  if (ownRead && preview.error) return <Notice tone="bad">{recordsErrorText(t, preview.error)}</Notice>;
  const data = preview.data && preview.data.id === scanId ? preview.data : null;
  if (!data) return <EmptyState label={t('records.previewLoading')} code={null} />;
  const plot = tracePlot(data.max_db, data.mean_db);
  if (!plot) return <EmptyState label={t('records.previewNone')} code="NO DATA" />;
  return (
    <div className="rec-preview">
      <div className="rec-preview-plot">
        <span className="rec-preview-db is-top">{plot.topDb} dB</span>
        <svg viewBox={`0 0 ${Math.max(1, data.max_db.length - 1)} 100`} preserveAspectRatio="none" role="img" aria-label={t('records.previewAriaPlot')}>
          <polyline className="rec-preview-mean" points={plot.meanPoints} vectorEffect="non-scaling-stroke" />
          <polyline className="rec-preview-max" points={plot.maxPoints} vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="rec-preview-db is-bottom">{plot.bottomDb} dB</span>
      </div>
      <div className="rec-preview-legend">
        <span className="is-max">{t('records.previewMax')}</span>
        <span className="is-mean">{t('records.previewMean')}</span>
        <span>{data.start_hz !== null && data.end_hz !== null ? `${formatAudioMHz(data.start_hz)} – ${formatAudioMHz(data.end_hz)}` : ''}</span>
        <span>{t('records.previewSweeps', { used: data.traces_used, count: data.trace_count })}</span>
      </div>
      {data.candidates.length ? (
        <table className="pg-table rec-candidates">
          <caption>{t('records.candidates')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('records.candidateFrequency')}</th>
              <th scope="col" className="is-num">{t('records.candidatePeak')}</th>
              <th scope="col" className="is-num">{t('records.candidateSnr')}</th>
              <th scope="col" className="is-num">{t('records.candidateBandwidth')}</th>
            </tr>
          </thead>
          <tbody>
            {data.candidates.map((candidate, index) => (
              <tr key={index}>
                <td className="is-num">{formatAudioMHz(candidate.frequency_hz)}</td>
                <td className="is-num">{candidate.peak_db === null ? '—' : `${candidate.peak_db.toFixed(1)} dB`}</td>
                <td className="is-num">{candidate.snr_db === null ? '—' : `${candidate.snr_db.toFixed(1)} dB`}</td>
                <td className="is-num">{formatBandwidth(candidate.bandwidth_hz)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

interface PlaybackFailure {
  mediaErrorCode: number | null;
  probe: unknown;
}

function AudioPlayer({ t, url }: { t: Translate; url: string }): JSX.Element {
  const [failure, setFailure] = useState<PlaybackFailure | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  function onError(event: SyntheticEvent<HTMLAudioElement>): void {
    const mediaErrorCode = event.currentTarget.error?.code ?? null;
    // Ask the route once more, so the text names a busy tablet or a deleted file
    // rather than blaming the browser.
    void probePlayback(url).then((probe) => {
      if (mounted.current) setFailure({ mediaErrorCode, probe });
    });
  }
  // One <audio> at a time and only while its row is open: closing the row
  // removes it, which ends its connection to the console.
  return (
    <div className="rec-player">
      <audio controls autoPlay preload="none" src={url} onError={onError} />
      {failure ? <Notice tone="warn">{playbackErrorText(t, failure.mediaErrorCode, failure.probe)}</Notice> : null}
    </div>
  );
}

function RecordItem({ t, row, open, preview, onToggle }: {
  t: Translate;
  row: RecordRow;
  open: boolean;
  preview: ReadState<ArchiveScanPreview>;
  onToggle: () => void;
}): JSX.Element {
  const canOpen = row.playable || row.previewable;
  return (
    <li className={['rec-row', open ? 'is-open' : ''].filter(Boolean).join(' ')}>
      <div className="rec-row-main">
        <div className="rec-row-type">
          <strong>{row.typeLabel}</strong>
          {row.sourceCode ? <Tag>{row.sourceCode}</Tag> : null}
        </div>
        <div className="rec-row-time pg-value">
          {row.startDate ? <span className="rec-row-date">{row.startDate}</span> : null}
          <span>{row.startTime}{row.endTime ? ` – ${row.endTime}` : ''}</span>
        </div>
        <div className="rec-row-freq pg-value">{row.frequencyLabel}</div>
        <div className="rec-row-mode">{row.modeLabel}</div>
        <div className="rec-row-num pg-value">{row.durationLabel}</div>
        <div className="rec-row-num pg-value">{row.sizeLabel}</div>
        <div className="rec-row-status">
          <StatusChip code={row.statusCode} tone={row.statusTone} title={row.statusTitle || undefined} />
          {row.notSavedLabel ? <span className="rec-row-note">{row.notSavedLabel}</span> : null}
        </div>
        <div className="rec-row-actions">
          {canOpen ? (
            <button
              type="button"
              className="ov-button"
              aria-expanded={open}
              aria-label={t(open ? 'records.closeAria' : row.playable ? 'records.playAria' : 'records.previewAria', { label: row.label })}
              onClick={onToggle}
            >
              {open ? t('records.close') : row.playable ? t('records.play') : t('records.preview')}
            </button>
          ) : null}
          {row.downloadUrl ? (
            <a className="ov-button" href={row.downloadUrl} download aria-label={t('records.downloadAria', { label: row.label })}>{t('records.download')}</a>
          ) : null}
        </div>
      </div>
      {open && row.playable ? <AudioPlayer t={t} url={row.playbackUrl} /> : null}
      {open && row.previewable ? <ScanPreview t={t} scanId={row.id} preview={preview} /> : null}
    </li>
  );
}

/**
 * The groundstation's Receiver Records in the LAN view, read only: the day's
 * calendar and time line, filters, one page of records at a time, audio
 * playback, a scan's preview and the download of one record. No delete, no
 * selection ZIP, no retention: those stay on the groundstation. Reads go out
 * one at a time (the console takes one per LAN client) and only while the tab
 * shows; it reads again each time it is shown.
 */
export function RecordsTab({ client: givenClient, now = Date.now }: { client?: RecordsClient; now?: () => number }): JSX.Element {
  const { t, lang } = useI18n();
  const locale = recordsLocale(lang);
  const client = useMemo(() => givenClient ?? createRecordsClient(), [givenClient]);
  const todayKey = localDateKey(now());
  const [mode, setMode] = useState<RecordsMode>('day');
  const [dateKey, setDateKey] = useState(todayKey);
  const [monthKey, setMonthKey] = useState(monthKeyOf(todayKey));
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [timeRange, setTimeRange] = useState<TimeRange | null>(null);
  const [filters, setFilters] = useState<ArchiveFilters>(emptyFilters);
  const [text, setText] = useState<TextFilters>({ minMHz: '', maxMHz: '', q: '' });
  const [sort, setSort] = useState<ArchiveSortKey>('start');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // Typed filters apply after a short pause, so each key press is not a read.
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((current) => (current.minMHz === text.minMHz && current.maxMHz === text.maxMHz && current.q === text.q
        ? current
        : { ...current, ...text }));
      setPage(0);
    }, TEXT_FILTER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const day = useMemo(() => localDayBounds(dateKey), [dateKey]);
  const timeQuery = recordsTimeQuery(mode, dateKey, mode === 'day' ? timeRange : null);
  const itemsParams = itemsQuery(filters, timeQuery, { sort, order, offset: page * RECORDS_PAGE_SIZE, limit: RECORDS_PAGE_SIZE }).toString();
  const timelineParams = timelineQuery(filters, day).toString();
  const grid = useMemo(() => calendarGrid(monthKey), [monthKey]);

  // Declared in the order the queue should send them: the table first.
  const itemsKey = `items:${itemsParams}:${reload}`;
  const items = useRead<ArchiveItemsPage>(itemsKey, (signal) => client.items(new URLSearchParams(itemsParams), signal));
  const timeline = useRead<ArchiveTimeline>(mode === 'day' ? `timeline:${timelineParams}:${reload}` : null,
    (signal) => client.timeline(new URLSearchParams(timelineParams), signal));
  const calendarKey = mode === 'day' && calendarOpen ? `calendar:${monthKey}:${filters.type}:${reload}` : null;
  const calendarType = filters.type;
  const calendar = useRead<MonthCounts>(calendarKey,
    (signal) => client.calendar(grid.bounds, calendarType, signal).then((answer) => ({ month: monthKey, type: calendarType, calendar: answer })));
  const facets = useRead<ArchiveFacets>(`facets:${reload}`, (signal) => client.facets(signal));
  const openRow = openKey?.startsWith('scan:') ? openKey.slice(5) : null;
  const preview = useRead<ArchiveScanPreview>(openRow ? previewKey(openRow, reload) : null, (signal) => client.scanPreview(openRow ?? '', signal));

  // A page past the end (records deleted or removed by retention since) moves to the last page.
  const pageNow = items.data && items.key === itemsKey ? pageAfterAnswer(page, items.data, RECORDS_PAGE_SIZE) : page;
  useEffect(() => {
    if (pageNow !== page) setPage(pageNow);
  }, [pageNow, page]);

  const rowContext = { t, locale, mode, dayStartMs: day.startMs, dayEndMs: day.endMs };
  const rows = (items.data?.items ?? []).map((item) => recordRow(item, rowContext));
  const total = items.data?.total ?? 0;
  const pages = pageCount(total, RECORDS_PAGE_SIZE);
  const frequencyErrors = frequencyFieldErrors({ ...filters, ...text });
  const filtered = filters.type !== 'all' || filters.status !== '' || filters.minMHz.trim() !== '' || filters.maxMHz.trim() !== '' || filters.q.trim() !== '';
  const statuses = ARCHIVE_STATUSES.filter(([value]) => !facets.data || facets.data.statuses.includes(value) || value === filters.status);

  function changeFilters(next: Partial<ArchiveFilters>): void {
    setFilters((current) => ({ ...current, ...next }));
    setPage(0);
  }

  function pickDate(key: string): void {
    setDateKey(key);
    setMonthKey(monthKeyOf(key));
    setTimeRange(null);
    setPage(0);
  }

  function changeSort(next: ArchiveSortKey): void {
    setSort(next);
    setOrder(defaultSortOrder(next));
    setPage(0);
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') setFilters((current) => ({ ...current, ...text }));
  }

  const emptyLabel = filtered ? t('records.emptyFiltered') : mode === 'day' ? t('records.emptyDay') : t('records.emptyAll');
  const dateLabel = formatDateKeyLabel(dateKey, locale);

  return (
    <Card title={t('records.tabRecords')} span={12} className="rec-card"
      actions={<button type="button" className="ov-button" onClick={() => setReload((value) => value + 1)}>{t('records.refresh')}</button>}
    >
      <Toolbar className="rec-dates">
        <Segmented<RecordsMode>
          label={t('records.modeLabel')}
          compact
          value={mode}
          onChange={(next) => { setMode(next); setPage(0); }}
          options={[{ value: 'day', label: t('records.modeDay') }, { value: 'all', label: t('records.modeAll') }]}
        />
        {mode === 'day' ? (
          <>
            <button type="button" className="ov-button" aria-label={t('records.prevDay')} onClick={() => pickDate(shiftExistingDay(dateKey, -1))}>‹</button>
            <button type="button" className="ov-button rec-date" aria-expanded={calendarOpen} aria-label={t('records.chooseDate', { date: dateLabel })}
              onClick={() => { setCalendarOpen((value) => !value); setMonthKey(monthKeyOf(dateKey)); }}
            >
              {dateLabel}
            </button>
            <button type="button" className="ov-button" aria-label={t('records.nextDay')} onClick={() => pickDate(shiftExistingDay(dateKey, 1))}>›</button>
            <button type="button" className="ov-button" disabled={dateKey === todayKey} onClick={() => pickDate(todayKey)}>{t('records.today')}</button>
          </>
        ) : null}
        {facets.data ? (
          <span className="rec-totals pg-value">
            {t('records.totals', { audio: facets.data.totals.audio, scan: facets.data.totals.scan, size: formatBytes(facets.data.totals.bytes) })}
          </span>
        ) : null}
      </Toolbar>
      {mode === 'day' && calendarOpen ? (
        <Calendar t={t} locale={locale} monthKey={monthKey} type={filters.type} dateKey={dateKey} todayKey={todayKey} counts={calendar.data}
          error={calendar.key === calendarKey ? calendar.error : null}
          onMonth={setMonthKey} onPick={(key) => { pickDate(key); setCalendarOpen(false); }}
        />
      ) : null}
      {mode === 'day' ? (
        <div className="rec-tl-row">
          <Timeline t={t} locale={locale} dateKey={dateKey} timeline={timeline.data} selected={timeRange}
            onSelect={(range) => { setTimeRange(range); setPage(0); }}
          />
          {timeRange ? (
            <button type="button" className="ov-button" onClick={() => { setTimeRange(null); setPage(0); }}>
              {t('records.wholeDay')}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="rec-filters" role="group" aria-label={t('records.filters')}>
        <Segmented<ArchiveTypeFilter>
          label={t('records.type')}
          compact
          value={filters.type}
          onChange={(type) => changeFilters({ type })}
          options={[
            { value: 'all', label: t('records.typeAll') },
            { value: 'audio', label: t('records.typeAudio') },
            { value: 'scan', label: t('records.typeScan') },
          ]}
        />
        <FormField label={t('records.status')} size="sm">
          <select value={filters.status} onChange={(event) => changeFilters({ status: event.target.value })}>
            <option value="">{t('records.statusAny')}</option>
            {statuses.map(([value, code]) => <option key={value} value={value}>{code}</option>)}
          </select>
        </FormField>
        <FormField label={t('records.minMHz')} unit="MHz" size="xs" error={frequencyErrors.min ? t('records.frequencyInvalid') : undefined}>
          <input type="text" inputMode="decimal" value={text.minMHz} onChange={(event) => setText({ ...text, minMHz: event.target.value })} onKeyDown={onSearchKey} />
        </FormField>
        <FormField label={t('records.maxMHz')} unit="MHz" size="xs" error={frequencyErrors.max && !frequencyErrors.min ? t('records.frequencyInvalid') : undefined}>
          <input type="text" inputMode="decimal" value={text.maxMHz} onChange={(event) => setText({ ...text, maxMHz: event.target.value })} onKeyDown={onSearchKey} />
        </FormField>
        <FormField label={t('records.search')} size="md">
          <input type="search" maxLength={64} placeholder={t('records.searchPlaceholder')} value={text.q}
            onChange={(event) => setText({ ...text, q: event.target.value })} onKeyDown={onSearchKey}
          />
        </FormField>
      </div>
      <Toolbar className="rec-results">
        <span className="pg-value">{t('records.results', { count: total })}</span>
        <FormField label={t('records.sort')} size="sm">
          <select value={sort} onChange={(event) => changeSort(event.target.value as ArchiveSortKey)}>
            {RECORDS_SORT_KEYS.map((key) => (
              <option key={key} value={key}>
                {t(key === 'start' ? 'records.sortStart' : key === 'duration' ? 'records.sortDuration' : key === 'frequency' ? 'records.sortFrequency' : 'records.sortSize')}
              </option>
            ))}
          </select>
        </FormField>
        <button type="button" className="ov-button" onClick={() => { setOrder(order === 'asc' ? 'desc' : 'asc'); setPage(0); }}>
          {order === 'asc' ? `↑ ${t('records.orderAsc')}` : `↓ ${t('records.orderDesc')}`}
        </button>
        <span className="rec-pages">
          <button type="button" className="ov-button" aria-label={t('records.prevPage')} disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
          <span className="pg-value">{t('records.page', { range: pageRangeLabel(page, RECORDS_PAGE_SIZE, rows.length), total })}</span>
          <button type="button" className="ov-button" aria-label={t('records.nextPage')} disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>›</button>
        </span>
      </Toolbar>
      {items.error ? (
        <Notice tone="bad" action={<button type="button" className="ov-button" onClick={() => setReload((value) => value + 1)}>{t('records.retry')}</button>}>
          {recordsErrorText(t, items.error)}
        </Notice>
      ) : null}
      {rows.length ? (
        <ul className={['rec-list', items.loading ? 'is-loading' : ''].filter(Boolean).join(' ')} aria-label={t('records.list')} aria-busy={items.loading || undefined}>
          {rows.map((row) => (
            <RecordItem key={row.key} t={t} row={row} open={openKey === row.key} preview={preview}
              onToggle={() => setOpenKey(openKey === row.key ? null : row.key)}
            />
          ))}
        </ul>
      ) : items.error ? null : (
        <EmptyState
          label={items.loading || !items.data || pageNow !== page ? t('records.loading') : emptyLabel}
          code={items.loading || !items.data || pageNow !== page ? null : 'NO DATA'}
        />
      )}
    </Card>
  );
}
