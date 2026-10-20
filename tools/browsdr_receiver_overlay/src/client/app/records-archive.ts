/**
 * The Records (Rekaman) workspace: a calendar with record dots, a 24 h timeline of the
 * day, a filtered and sorted table of audio segments and archived scans, previews,
 * downloads (single files and server-built ZIPs), deletes and the retention setting.
 *
 * A child component of the Receiver root, mounted once under v-show with primitive
 * props only, so the root's frequent renders (sweep frames, VFO updates) skip it. Its
 * state stays while the frame is mounted. Nothing here opens on its own: every action
 * starts from a click on the visible page, and confirmations are inline bars (no
 * window.confirm), dropped when the tab or the frame is hidden.
 */
import { ReceiverRequestError, browserTimeZone, browserUtcOffsetMinutes } from './receiver-records-api';
import { radioDisplayText, receiverDateLocale, translateReceiver, translateReceiverMessage } from './i18n';
import type { ReceiverLanguage } from './i18n';
import {
	ARCHIVE_ERROR_TEXT, ARCHIVE_STATUSES, PAGE_SIZES, RANGE_MAX_DAYS, RETENTION_DAY_OPTIONS, RETENTION_LABEL_KEYS, WEEKDAY_KEYS,
	activeFilterCount, addDays, addMonths, archiveTimeSpec, buildArchiveRow, calendarGrid, dateKeyDayNumber, dayExists, daySpan,
	defaultSortOrder, dragRange, emptyFilters, emptySelection, filterBody, firstHour, formatAudioMHz, formatBandwidth, formatBytes,
	formatDateKeyLabel, formatDuration, formatHour, formatMonthLabel, formatScanRange, formatScanResolution, formatShortDate, formatTime,
	frequencyFieldErrors, hasFilters, hourContaining, isRowSelected, itemsQuery, lastHour, lastPage, localDateKey, localDayBounds,
	monthKeyOf, moveWindow, pageCount, pageRangeLabel, pageSelectionState, parseDateKey, rangeTimeFields, resizeWindow, selectAllResults,
	selectionItems, selectionSummary, shiftExistingDay, timeFieldsRange, timelineBars, timelineHourLines, timelineQuery, timelineTicks,
	timelineWidth, timelineX, togglePageSelection, toggleRowSelection, tracePlot,
	CELL_DATE_FORMAT, SHORT_DATE_FORMAT,
} from './records-archive-format';
import type { ArchiveFilters, ArchiveRowView, ArchiveSelection, ArchiveSortKey, ArchiveViewMode, TimeRange } from './records-archive-format';
import { archiveApi, audioPlaybackUrl, downloadUrl, exportDownloadUrl } from './records-archive-api';
import type { ArchiveCalendar, ArchiveFacets, ArchiveItem, ArchiveScanPreview, ArchiveSettings, ArchiveTimeline, ArchiveTotals, RetentionPreview } from './records-archive-api';
import { RECORDS_ARCHIVE_TEMPLATE } from './records-archive-template';

// The component's `this`; the overlay is not type-checked by the build (see types.ts).
type Vm = any;

type LoadKind = 'facets' | 'settings' | 'calendar' | 'timeline' | 'items' | 'preview' | 'retentionPreview';

type ConfirmState =
	| { type: 'delete-row'; key: string; kind: 'audio' | 'scan'; id: string }
	| { type: 'delete-selection' }
	| { type: 'retention'; days: number; preview: RetentionPreview }
	| { type: 'open-scan'; key: string; id: string; withRecording: boolean };

interface Notice {
	/** English sentences, each translated on its own. */
	parts: string[];
	tone: 'ok' | 'warn' | 'bad' | 'info';
}

const SEARCH_DEBOUNCE_MS = 300;
const LIVE_REFRESH_MS = 10_000;
const AFTER_STOP_REFRESH_MS = 1_000;
const RETENTION_FOLLOW_UP_MS = 10_000;
const DRAG_THRESHOLD_PX = 4;

function errorText(error: unknown): string {
	if (error instanceof ReceiverRequestError && error.code && ARCHIVE_ERROR_TEXT[error.code]) return ARCHIVE_ERROR_TEXT[error.code];
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
	return error instanceof ReceiverRequestError ? error.code : '';
}

function isAbort(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

function plural(count: number, one: string, many: string): string {
	return count === 1 ? one : many;
}

function fieldValue(event: Event): string {
	const target = event.target as HTMLInputElement | HTMLSelectElement | null;
	return target ? target.value : '';
}

export const ReceiverArchive = {
	name: 'ReceiverArchive',
	template: RECORDS_ARCHIVE_TEMPLATE,
	props: {
		active: { type: Boolean, default: false },
		language: { type: String, default: 'en' },
		scanBusy: { type: Boolean, default: false },
		rxRunning: { type: Boolean, default: false },
		recording: { type: Boolean, default: false },
		autoArchive: { type: Boolean, default: false },
		loadedScanId: { type: String, default: '' },
	},
	emits: ['open-scan', 'deleted', 'update-auto-archive'],

	data() {
		const today = localDateKey(Date.now());
		return {
			view: {
				mode: 'day' as ArchiveViewMode,
				fromDate: today,
				toDate: today,
				calendarMonth: monthKeyOf(today),
				calendarOpen: false,
				filtersOpen: false,
				focusedDate: today,
				rangeAnchor: '',
			},
			filters: emptyFilters() as ArchiveFilters,
			searchDraft: '',
			timeRange: null as TimeRange | null,
			dragPreview: null as TimeRange | null,
			timeFields: { from: '', to: '', invalid: '' as '' | 'from' | 'to' },
			sort: { key: 'start' as ArchiveSortKey, order: 'desc' as 'asc' | 'desc' },
			page: 0,
			pageSize: PAGE_SIZES[0],
			items: Object.freeze([]) as readonly ArchiveItem[],
			total: 0,
			totals: { audio: 0, scan: 0, bytes: 0, estimated_bytes: 0 } as ArchiveTotals,
			loadedOnce: false,
			timeline: null as ArchiveTimeline | null,
			calendar: null as (ArchiveCalendar & { month: string; type: string }) | null,
			facets: null as ArchiveFacets | null,
			settings: null as ArchiveSettings | null,
			selection: emptySelection() as ArchiveSelection,
			preview: null as { key: string; kind: 'audio' | 'scan'; id: string } | null,
			previewData: null as ArchiveScanPreview | null,
			previewError: '',
			previewLoading: false,
			audioPlaying: false,
			confirm: null as ConfirmState | null,
			busy: {
				items: false,
				refreshing: false,
				deleting: false,
				exporting: false,
				retention: false,
				retentionPreview: false,
			},
			loadErrors: { facets: '', settings: '', calendar: '', timeline: '', items: '' } as Record<string, string>,
			notice: null as Notice | null,
			readyExport: null as { url: string; filename: string } | null,
			retentionDraft: '',
			todayKey: today,
			pageSizes: PAGE_SIZES,
		};
	},

	computed: {
		locale(this: Vm): string | undefined {
			return receiverDateLocale(this.language as ReceiverLanguage);
		},
		dayBounds(this: Vm) {
			if (this.view.mode !== 'day' || !parseDateKey(this.view.fromDate)) return null;
			return localDayBounds(this.view.fromDate);
		},
		timeSpec(this: Vm) {
			return archiveTimeSpec(this.view.mode, this.view.fromDate, this.view.toDate, this.timeRange, this.filters);
		},
		timeOfDayState(this: Vm): string {
			return this.timeSpec.timeOfDay;
		},
		timeOfDayDisabled(this: Vm): boolean {
			return this.view.mode !== 'range' || this.timeOfDayState === 'too-many';
		},
		frequencyErrors(this: Vm) {
			return frequencyFieldErrors(this.filters);
		},
		filtersSet(this: Vm): boolean {
			return hasFilters(this.filters);
		},
		filtersButtonLabel(this: Vm): string {
			const count = activeFilterCount(this.filters, this.view.mode);
			return count ? `${this.t('Filters')} (${count})` : this.t('Filters');
		},
		monthLabel(this: Vm): string {
			return formatMonthLabel(this.view.calendarMonth, this.locale);
		},
		weekdayLabels(this: Vm): string[] {
			return WEEKDAY_KEYS.map(key => this.t(key));
		},
		calendarGridView(this: Vm) {
			return calendarGrid(this.view.calendarMonth);
		},
		calendarWeeks(this: Vm) {
			const grid = this.calendarGridView;
			const counts = this.calendar && this.calendar.month === grid.month ? this.calendar.days : null;
			const { mode, fromDate, toDate, focusedDate } = this.view;
			const from = mode === 'all' ? '' : fromDate;
			const to = mode === 'range' ? toDate : fromDate;
			const focusInGrid = grid.cells.some((cell: { key: string }) => cell.key === focusedDate);
			const focus = focusInGrid ? focusedDate : grid.cells.find((cell: { inMonth: boolean }) => cell.inMonth)?.key;
			const weeks = [];
			for (let week = 0; week < 6; week++) {
				const cells = grid.cells.slice(week * 7, week * 7 + 7).map((cell: { key: string; day: number; inMonth: boolean; interval: number; startMs: number; endMs: number }) => {
					const count = counts && cell.interval >= 0 ? counts[cell.interval] : null;
					const audio = count?.audio ?? 0;
					const scan = count?.scan ?? 0;
					const selected = Boolean(from) && cell.key >= from && cell.key <= to;
					// A local day removed by a zone change has no length and no records.
					const exists = cell.endMs > cell.startMs;
					const label = formatDateKeyLabel(cell.key, this.locale, CELL_DATE_FORMAT);
					const ariaLabel = audio || scan
						? `${label}, ${audio} ${this.t('audio')}, ${scan} ${this.t(scan === 1 ? 'scan' : 'scans')}`
						: `${label}, ${this.t('no records')}`;
					return {
						key: cell.key,
						day: cell.day,
						exists,
						hasAudio: audio > 0,
						hasScan: scan > 0,
						selected,
						isToday: cell.key === this.todayKey,
						tabindex: cell.key === focus ? 0 : -1,
						ariaLabel,
						classes: {
							'is-outside': !cell.inMonth,
							'is-selected': selected,
							'is-picked': selected && mode === 'day',
							'is-range-start': selected && mode === 'range' && cell.key === from,
							'is-range-end': selected && mode === 'range' && cell.key === to,
							'is-today': cell.key === this.todayKey,
						},
					};
				});
				weeks.push({ key: cells[0].key, cells });
			}
			return weeks;
		},
		dayLabel(this: Vm): string {
			if (this.view.mode === 'all') return this.t('All dates');
			if (this.view.mode === 'range' && this.view.toDate !== this.view.fromDate) {
				return `${formatDateKeyLabel(this.view.fromDate, this.locale, SHORT_DATE_FORMAT)} – ${formatDateKeyLabel(this.view.toDate, this.locale, SHORT_DATE_FORMAT)}`;
			}
			return formatDateKeyLabel(this.view.fromDate, this.locale);
		},
		dayValues(this: Vm): string {
			return `${this.totals.audio} ${this.t('audio')} · ${this.totals.scan} ${this.t(this.totals.scan === 1 ? 'scan' : 'scans')}`;
		},
		periodNav(this: Vm) {
			if (this.view.mode === 'all') return { prev: false, next: false };
			const last = this.view.mode === 'range' ? this.view.toDate : this.view.fromDate;
			return { prev: true, next: last < this.todayKey };
		},
		timelineView(this: Vm) {
			const day = this.dayBounds;
			if (!day || day.endMs <= day.startMs) return null;
			const width = timelineWidth(day.startMs, day.endMs);
			const timeline = this.timeline && this.timeline.from_ms === day.startMs && this.timeline.to_ms === day.endMs ? this.timeline : null;
			const shown = this.dragPreview ?? this.timeRange;
			const nowMs = timeline?.now_ms ?? Date.now();
			const selectionText = shown
				? `${formatHour(shown.startMs, this.locale)}–${formatHour(shown.endMs, this.locale)}`
				: this.t('Whole day');
			return {
				width,
				viewBox: `0 0 ${width} 64`,
				hourLines: timelineHourLines(day.startMs, day.endMs),
				ticks: timelineTicks(day.startMs, day.endMs, ms => formatHour(ms, this.locale)),
				audioBars: timeline ? timelineBars(timeline.audio, day.startMs, day.endMs) : [],
				scanBars: timeline ? timelineBars(timeline.scan, day.startMs, day.endMs) : [],
				selection: shown ? { x: timelineX(shown.startMs, day.startMs, day.endMs), width: Math.max(0.5, timelineX(shown.endMs, day.startMs, day.endMs) - timelineX(shown.startMs, day.startMs, day.endMs)) } : null,
				nowX: nowMs > day.startMs && nowMs < day.endMs ? timelineX(nowMs, day.startMs, day.endMs) : null,
				truncated: Boolean(timeline?.truncated),
				ariaLabel: `${this.t('Timeline')}: ${selectionText}`,
			};
		},
		rowsBase(this: Vm): readonly ArchiveRowView[] {
			const day = this.dayBounds ?? { startMs: 0, endMs: 0 };
			const timeZone = browserTimeZone();
			const offset = browserUtcOffsetMinutes();
			const context = {
				t: (text: string) => this.t(text),
				tm: (text: string) => this.tm(text),
				sourceLabel: (source: string) => this.scanSourceLabel(source),
				locale: this.locale,
				mode: this.view.mode,
				dayStartMs: day.startMs,
				dayEndMs: day.endMs,
				downloadUrl: (kind: 'audio' | 'scan', id: string) => downloadUrl(kind, id, timeZone, offset),
			};
			return Object.freeze((this.items as readonly ArchiveItem[]).map(item => buildArchiveRow(item, context)));
		},
		previewView(this: Vm) {
			const preview = this.preview;
			if (!preview) return null;
			const row = (this.rowsBase as readonly ArchiveRowView[]).find(entry => entry.key === preview.key);
			if (!row) return null;
			const item = row.item;
			if (preview.kind === 'audio') {
				return {
					audioUrl: audioPlaybackUrl(item.id),
					details: [
						{ key: 'vfo', label: 'VFO', value: item.vfo_index === null ? '—' : String(item.vfo_index + 1) },
						{ key: 'frequency', label: this.t('Frequency'), value: formatAudioMHz(item.frequency_hz) },
						{ key: 'mode', label: this.t('Mode'), value: item.mode ? item.mode.toUpperCase() : '—' },
						{ key: 'bandwidth', label: this.t('Bandwidth'), value: formatBandwidth(item.bandwidth_hz) },
						{ key: 'start', label: this.t('Start'), value: `${formatShortDate(item.start_ms, this.locale)} ${formatTime(item.start_ms, this.locale)}` },
						{ key: 'end', label: this.t('End'), value: item.end_ms === null ? '—' : `${formatShortDate(item.end_ms, this.locale)} ${formatTime(item.end_ms, this.locale)}` },
						{ key: 'duration', label: this.t('Duration'), value: formatDuration(item.duration_s) },
						{ key: 'size', label: this.t('Size'), value: formatBytes(item.bytes) },
						{ key: 'codec', label: this.t('Codec'), value: item.codec || '—' },
					],
					errorText: item.error ? this.tm(item.error) : '',
				};
			}
			const data = this.previewData && this.previewData.id === item.id ? this.previewData : null;
			const plot = data ? tracePlot(data.max_db, data.mean_db) : null;
			const failures = item.trace_upload_failures ?? 0;
			return {
				loading: this.previewLoading,
				errorText: this.previewError ? this.tm(`Could not load the scan preview: ${this.previewError}`) : '',
				maxPoints: plot?.maxPoints ?? '',
				meanPoints: plot?.meanPoints ?? '',
				topLabel: plot ? `${plot.topDb} dB` : '',
				bottomLabel: plot ? `${plot.bottomDb} dB` : '',
				startLabel: data?.start_hz == null ? '' : `${(data.start_hz / 1_000_000).toFixed(3)} MHz`,
				endLabel: data?.end_hz == null ? '' : `${(data.end_hz / 1_000_000).toFixed(3)} MHz`,
				details: [
					{ key: 'range', label: this.t('Frequency'), value: formatScanRange(item.start_hz, item.end_hz) },
					{ key: 'traces', label: this.t('Traces'), value: String(item.trace_count ?? 0) },
					{ key: 'candidates', label: this.t('Candidates'), value: String(item.candidate_count ?? 0) },
					{ key: 'resolution', label: this.t('Resolution'), value: formatScanResolution(item.fft_size) },
					...(failures ? [{ key: 'failures', label: this.t('not saved'), value: String(failures) }] : []),
				],
				candidates: (data?.candidates ?? []).map((candidate: { frequency_hz: number | null; peak_db: number | null; snr_db: number | null }, index: number) => ({
					key: String(index),
					frequency: candidate.frequency_hz === null ? '—' : (candidate.frequency_hz / 1_000_000).toFixed(6),
					peak: candidate.peak_db === null ? '—' : candidate.peak_db.toFixed(1),
					snr: candidate.snr_db === null ? '—' : candidate.snr_db.toFixed(1),
				})),
			};
		},
		rowsView(this: Vm) {
			const confirm = this.confirm as ConfirmState | null;
			const preview = this.preview;
			return (this.rowsBase as readonly ArchiveRowView[]).map(row => {
				const selected = isRowSelected(this.selection, row);
				const previewed = Boolean(preview && preview.key === row.key);
				const playing = previewed && row.kind === 'audio' && this.audioPlaying;
				const playText = this.t(playing ? 'Pause' : 'Play');
				return {
					...row,
					selected,
					previewed,
					playing,
					playAria: `${playText}: ${row.label}`,
					previewAria: `${this.t('Preview')}: ${row.label}`,
					preview: previewed ? this.previewView : null,
					confirming: Boolean(confirm && confirm.type === 'delete-row' && confirm.key === row.key),
					openConfirmText: confirm && confirm.type === 'open-scan' && confirm.key === row.key
						? this.t(confirm.withRecording ? 'Open in Spectrum stops RX and the VFO audio recording.' : 'Open in Spectrum stops RX.')
						: '',
					classes: {
						'is-selected': selected,
						'is-previewed': previewed,
						'is-live': row.live,
						'is-loaded': row.kind === 'scan' && row.id === this.loadedScanId,
					},
				};
			});
		},
		pageSelection(this: Vm): string {
			return pageSelectionState(this.selection, this.rowsBase);
		},
		pageHasSelectable(this: Vm): boolean {
			return (this.rowsBase as readonly ArchiveRowView[]).some(row => row.selectable);
		},
		selectionView(this: Vm) {
			const summary = selectionSummary(this.selection);
			const filterMode = this.selection.mode === 'filter';
			const rows = this.rowsBase as readonly ArchiveRowView[];
			const canSelectAll = !filterMode && this.pageSelection === 'all' && this.total > rows.length;
			return {
				...summary,
				text: filterMode || !summary.count ? '' : `${summary.count} ${this.t('selected')} · ${formatBytes(summary.estimatedBytes)}`,
				canSelectAll,
				selectAllLabel: `${this.t('Select all results')} (${this.total})`,
				allSelectedLabel: filterMode ? `${this.t('All results selected')} (${summary.count}) · ${formatBytes(summary.estimatedBytes)}` : '',
			};
		},
		selectionConfirmView(this: Vm) {
			if (!this.confirm || this.confirm.type !== 'delete-selection') return null;
			const summary = selectionSummary(this.selection);
			return { label: `${summary.deleteCount} · ${formatBytes(summary.estimatedBytes)}` };
		},
		retentionOptions(this: Vm) {
			if (!this.settings) return [];
			const options: readonly number[] = this.settings.retention_options.length ? this.settings.retention_options : RETENTION_DAY_OPTIONS;
			return options.map(days => ({ value: String(days), label: this.retentionLabel(days) }));
		},
		retentionConfirmView(this: Vm) {
			if (!this.confirm || this.confirm.type !== 'retention') return null;
			const preview = this.confirm.preview as RetentionPreview;
			return {
				optionLabel: this.retentionLabel(this.confirm.days),
				countsLabel: `${preview.audio} ${this.t('audio')} · ${preview.scans} ${this.t(preview.scans === 1 ? 'scan' : 'scans')} · ${formatBytes(preview.bytes)}`,
			};
		},
		storedLabel(this: Vm): string {
			return this.facets ? formatBytes(this.facets.totals.bytes) : '—';
		},
		freeLabel(this: Vm): string {
			return this.facets && this.facets.free_bytes !== null ? formatBytes(this.facets.free_bytes) : '—';
		},
		notRemovedLabel(this: Vm): string {
			const failed = this.settings?.retention_last_removed?.failed ?? 0;
			return failed > 0 ? this.tm(`${failed} not removed`) : '';
		},
		noticeText(this: Vm): string {
			return this.notice ? (this.notice.parts as string[]).map(part => this.tm(part)).join(' ') : '';
		},
		noticeTone(this: Vm): string {
			return this.notice ? `is-${this.notice.tone}` : '';
		},
		loadErrorText(this: Vm): string {
			const first = Object.values(this.loadErrors as Record<string, string>).find(Boolean);
			return first ? this.tm(`Could not load Records: ${first}`) : '';
		},
		statusOptions() {
			return ARCHIVE_STATUSES.map(([value, label]) => ({ value, label }));
		},
		vfoOptions(this: Vm) {
			return (this.facets?.vfo_indices ?? []).map((index: number) => ({ value: String(index), label: `VFO ${index + 1}` }));
		},
		modeOptions(this: Vm) {
			return (this.facets?.modes ?? []).map((mode: string) => ({ value: mode, label: mode.toUpperCase() }));
		},
		bandwidthOptions(this: Vm) {
			return (this.facets?.bandwidths_hz ?? []).map((bandwidth: number) => ({ value: String(bandwidth), label: formatBandwidth(bandwidth) }));
		},
		sortAria(this: Vm): Record<string, string> {
			const aria: Record<string, string> = {};
			for (const key of ['start', 'end', 'type', 'frequency', 'duration', 'size', 'status']) {
				aria[key] = this.sort.key === key ? (this.sort.order === 'asc' ? 'ascending' : 'descending') : 'none';
			}
			return aria;
		},
		sortMarks(this: Vm): Record<string, string> {
			const marks: Record<string, string> = {};
			for (const key of ['start', 'end', 'type', 'frequency', 'duration', 'size', 'status']) {
				marks[key] = this.sort.key === key ? (this.sort.order === 'asc' ? '▲' : '▼') : '';
			}
			return marks;
		},
		pageTotal(this: Vm): number {
			return pageCount(this.total, this.pageSize);
		},
		rangeLabel(this: Vm): string {
			return `${pageRangeLabel(this.page, this.pageSize, this.rowsBase.length)} ${this.t('of')} ${this.total}`;
		},
		emptyState(this: Vm) {
			if (this.rowsBase.length) return null;
			const totals = this.facets?.totals;
			if (totals && totals.audio + totals.scan === 0) return { key: 'none', action: '' };
			if (hasFilters(this.filters) || this.timeRange) return { key: 'filters', action: this.filtersSet ? 'clear' : '' };
			const latest = this.facets?.last_ms ?? null;
			const action = latest !== null ? 'latest' : '';
			if (this.view.mode === 'day') return { key: 'day', action };
			if (this.view.mode === 'range') return { key: 'period', action };
			return { key: 'none', action: '' };
		},
		hasLiveRows(this: Vm): boolean {
			return (this.rowsBase as readonly ArchiveRowView[]).some(row => row.live);
		},
	},

	watch: {
		active(this: Vm, active: boolean) {
			if (!active) return;
			if (!this._started) void this.start();
			else void this.refreshAll();
		},
		timeRange(this: Vm, range: TimeRange | null) {
			const day = this.dayBounds;
			const fields = rangeTimeFields(range, day ? day.endMs : 0);
			this.timeFields = { ...fields, invalid: '' };
		},
		recording(this: Vm, now: boolean, before: boolean) {
			if (before && !now) this.refreshSoon();
		},
		scanBusy(this: Vm, now: boolean, before: boolean) {
			if (before && !now) this.refreshSoon();
		},
	},

	created(this: Vm) {
		// Non-reactive bookkeeping: latest-request ids, abort controllers and timers.
		this._started = false;
		this._shown = true;
		this._hiddenWhileActive = false;
		this._requestIds = {} as Record<LoadKind, number>;
		this._aborts = {} as Record<LoadKind, AbortController | undefined>;
		this._timers = { search: 0, live: 0, soon: 0, retention: 0, export: 0 } as Record<string, number>;
		this._drag = null;
		this._resizeObserver = null;
		this._onDocumentVisibility = () => {
			if (document.visibilityState === 'visible') this.scheduleLiveRefresh();
			else this.clearTimer('live');
		};
		// Nothing loads until the Records tab is first shown.
		if (this.active) void this.start();
	},

	mounted(this: Vm) {
		document.addEventListener('visibilitychange', this._onDocumentVisibility);
		if (typeof ResizeObserver === 'function') {
			// 0x0 means this tab or the whole Receiver frame is hidden.
			this._resizeObserver = new ResizeObserver((entries: ResizeObserverEntry[]) => {
				const rect = entries[entries.length - 1]?.contentRect;
				if (rect) this.onShownChange(rect.width > 0 || rect.height > 0);
			});
			this._resizeObserver.observe(this.$el);
		}
	},

	beforeUnmount(this: Vm) {
		document.removeEventListener('visibilitychange', this._onDocumentVisibility);
		this._resizeObserver?.disconnect();
		for (const name of Object.keys(this._timers)) this.clearTimer(name);
		for (const controller of Object.values(this._aborts) as Array<AbortController | undefined>) controller?.abort();
	},

	methods: {
		t(this: Vm, text: string): string {
			return translateReceiver(this.language as ReceiverLanguage, text);
		},
		tm(this: Vm, message: string): string {
			return radioDisplayText(translateReceiverMessage(this.language as ReceiverLanguage, message));
		},
		/** Operator label for a stored scan source; the stored value stays the English code. */
		scanSourceLabel(this: Vm, source: string): string {
			switch (source) {
				case 'simulated':
					return this.t('Simulation (synthetic peaks)');
				case 'native':
					return this.t('RadioSpectrum native sweep');
				case 'manual':
					return this.t('RadioSpectrum manual sweep');
				case 'receiver':
					return this.t('Receiver');
				default:
					return source;
			}
		},
		retentionLabel(this: Vm, days: number): string {
			const key = RETENTION_LABEL_KEYS[days];
			return key ? this.t(key) : String(days);
		},

		clearTimer(this: Vm, name: string) {
			if (this._timers[name]) window.clearTimeout(this._timers[name]);
			this._timers[name] = 0;
		},

		/** Runs one request of a kind; an older one of the same kind is cancelled and its answer ignored. */
		async fetchLatest<T>(this: Vm, kind: LoadKind, run: (signal: AbortSignal) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown } | null> {
			const id = (this._requestIds[kind] ?? 0) + 1;
			this._requestIds[kind] = id;
			this._aborts[kind]?.abort();
			const controller = new AbortController();
			this._aborts[kind] = controller;
			try {
				const value = await run(controller.signal);
				return id === this._requestIds[kind] ? { ok: true, value } : null;
			} catch (error) {
				if (id !== this._requestIds[kind] || (controller.signal.aborted && isAbort(error))) return null;
				return { ok: false, error };
			}
		},

		// ── Loading ────────────────────────────────────────────────────────

		async start(this: Vm) {
			this._started = true;
			this.todayKey = localDateKey(Date.now());
			this.view.fromDate = this.view.toDate = this.view.focusedDate = this.todayKey;
			this.view.calendarMonth = monthKeyOf(this.todayKey);
			await Promise.all([this.loadFacets(), this.loadSettings(), this.loadCalendar()]);
			// The first day shown is today when it has records, else the day of the latest one.
			const todayCell = this.calendarCellCounts(this.todayKey);
			const latest = this.facets?.last_ms ?? null;
			if (!(todayCell && (todayCell.audio || todayCell.scan)) && latest !== null) {
				const key = localDateKey(latest);
				this.view.fromDate = this.view.toDate = this.view.focusedDate = key;
				if (monthKeyOf(key) !== this.view.calendarMonth) {
					this.view.calendarMonth = monthKeyOf(key);
					void this.loadCalendar();
				}
			}
			await Promise.all([this.loadTimeline(), this.loadItems()]);
		},

		calendarCellCounts(this: Vm, key: string) {
			if (!this.calendar || this.calendar.month !== this.view.calendarMonth) return null;
			const cell = this.calendarGridView.cells.find((entry: { key: string }) => entry.key === key);
			return cell && cell.interval >= 0 ? this.calendar.days[cell.interval] : null;
		},

		async refreshAll(this: Vm) {
			if (!this._started) return this.start();
			this.todayKey = localDateKey(Date.now());
			this.busy.refreshing = true;
			try {
				await Promise.all([this.loadFacets(), this.loadSettings(), this.loadCalendar(), this.loadTimeline(), this.loadItems()]);
			} finally {
				this.busy.refreshing = false;
			}
		},

		refreshSoon(this: Vm) {
			if (!this.active || !this._started) return;
			this.clearTimer('soon');
			this._timers.soon = window.setTimeout(() => {
				this._timers.soon = 0;
				if (this.active && this._shown) void this.refreshAll();
			}, AFTER_STOP_REFRESH_MS);
		},

		async loadFacets(this: Vm) {
			const result = await this.fetchLatest('facets', (signal: AbortSignal) => archiveApi.facets(signal));
			if (!result) return;
			if (result.ok) {
				this.facets = Object.freeze(result.value);
				this.loadErrors.facets = '';
			} else {
				this.loadErrors.facets = errorText(result.error);
			}
		},

		async loadSettings(this: Vm) {
			const result = await this.fetchLatest('settings', (signal: AbortSignal) => archiveApi.getSettings(signal));
			if (!result) return;
			if (result.ok) {
				this.applySettings(result.value);
				this.loadErrors.settings = '';
			} else {
				this.loadErrors.settings = errorText(result.error);
			}
		},

		applySettings(this: Vm, settings: ArchiveSettings) {
			this.settings = Object.freeze(settings);
			if (!this.confirm || this.confirm.type !== 'retention') {
				this.retentionDraft = settings.retention_days === null ? 'off' : String(settings.retention_days);
			}
		},

		async loadCalendar(this: Vm) {
			const month = this.view.calendarMonth;
			const type = this.filters.type;
			const grid = calendarGrid(month);
			const result = await this.fetchLatest('calendar', (signal: AbortSignal) => archiveApi.calendar(grid.bounds, type, signal));
			if (!result) return;
			if (result.ok) {
				this.calendar = Object.freeze({ ...result.value, month, type });
				this.loadErrors.calendar = '';
			} else {
				this.loadErrors.calendar = errorText(result.error);
			}
		},

		async loadTimeline(this: Vm) {
			const day = this.dayBounds;
			if (!day || day.endMs <= day.startMs) {
				this.timeline = null;
				return;
			}
			const params = timelineQuery(this.filters, day);
			const result = await this.fetchLatest('timeline', (signal: AbortSignal) => archiveApi.timeline(params, signal));
			if (!result) return;
			if (result.ok) {
				this.timeline = Object.freeze(result.value);
				this.loadErrors.timeline = '';
			} else {
				this.loadErrors.timeline = errorText(result.error);
			}
		},

		async loadItems(this: Vm) {
			// A console left open past midnight: Next day and the today mark follow the clock.
			this.todayKey = localDateKey(Date.now());
			const params = itemsQuery(this.filters, this.timeSpec.query, {
				sort: this.sort.key,
				order: this.sort.order,
				offset: this.page * this.pageSize,
				limit: this.pageSize,
			});
			this.busy.items = true;
			const result = await this.fetchLatest('items', (signal: AbortSignal) => archiveApi.items(params, signal));
			if (!result) return;
			this.busy.items = false;
			if (!result.ok) {
				this.loadErrors.items = errorText(result.error);
				this.loadedOnce = true;
				return;
			}
			const page = result.value;
			if (!page.items.length && page.total > 0 && this.page > 0) {
				// An offset past the end: go to the last page.
				this.page = lastPage(page.total, this.pageSize);
				return this.loadItems();
			}
			this.items = page.items;
			this.total = page.total;
			this.totals = page.totals;
			this.loadedOnce = true;
			this.loadErrors.items = '';
			this.scheduleLiveRefresh();
		},

		/** While a listed row is recording or scanning, the table and timeline follow it. */
		scheduleLiveRefresh(this: Vm) {
			this.clearTimer('live');
			if (!this.active || !this._shown || document.visibilityState === 'hidden' || !this.hasLiveRows) return;
			this._timers.live = window.setTimeout(() => {
				this._timers.live = 0;
				if (!this.active || !this._shown || document.visibilityState === 'hidden') return;
				void this.loadTimeline();
				void this.loadItems();
			}, LIVE_REFRESH_MS);
		},

		onShownChange(this: Vm, shown: boolean) {
			if (shown === this._shown) return;
			this._shown = shown;
			if (shown) {
				// Back from another console page with Records still the open tab: what was
				// recorded or deleted meanwhile shows at once. A tab switch refreshes through
				// the active watcher instead (active was already false when it hid).
				const wasHiddenWhileActive = this._hiddenWhileActive;
				this._hiddenWhileActive = false;
				if (wasHiddenWhileActive && this.active && this._started) void this.refreshAll();
				else this.scheduleLiveRefresh();
				return;
			}
			this._hiddenWhileActive = Boolean(this.active);
			this.pauseAudio();
			if (this.confirm) this.cancelConfirm();
			this.clearTimer('live');
		},

		/** A change of what is listed: first page, no selection, new items (and strip, calendar). */
		applyQuery(this: Vm, options: { calendar?: boolean; timeline?: boolean } = {}) {
			this.page = 0;
			this.selection = emptySelection();
			if (this.confirm && this.confirm.type === 'delete-selection') this.confirm = null;
			void this.loadItems();
			if (options.timeline !== false) void this.loadTimeline();
			if (options.calendar) void this.loadCalendar();
		},

		// ── Filters ────────────────────────────────────────────────────────

		setType(this: Vm, type: 'all' | 'audio' | 'scan') {
			if (this.filters.type === type) return;
			this.filters.type = type;
			this.applyQuery({ calendar: true });
		},

		setFilter(this: Vm, field: 'status' | 'vfo' | 'mode' | 'bandwidth' | 'timeFrom' | 'timeTo', event: Event) {
			const value = fieldValue(event);
			if (this.filters[field] === value) return;
			this.filters[field] = value;
			this.applyQuery();
		},

		setFrequency(this: Vm, bound: 'min' | 'max', event: Event) {
			const value = fieldValue(event).trim();
			const field = bound === 'min' ? 'minMHz' : 'maxMHz';
			if (this.filters[field] === value) return;
			this.filters[field] = value;
			this.applyQuery();
		},

		onSearchInput(this: Vm, event: Event) {
			this.searchDraft = fieldValue(event);
			this.clearTimer('search');
			this._timers.search = window.setTimeout(() => {
				this._timers.search = 0;
				this.applySearch();
			}, SEARCH_DEBOUNCE_MS);
		},

		applySearch(this: Vm) {
			this.clearTimer('search');
			const q = this.searchDraft.trim().slice(0, 64);
			if (q === this.filters.q) return;
			this.filters.q = q;
			this.applyQuery();
		},

		clearFilters(this: Vm) {
			const typeChanged = this.filters.type !== 'all';
			this.filters = emptyFilters();
			this.searchDraft = '';
			this.clearTimer('search');
			this.timeRange = null;
			this.applyQuery({ calendar: typeChanged });
		},

		// ── Calendar and dates ─────────────────────────────────────────────

		setMonth(this: Vm, monthKey: string) {
			if (monthKey === this.view.calendarMonth) return;
			this.view.calendarMonth = monthKey;
			void this.loadCalendar();
		},

		changeMonth(this: Vm, delta: number) {
			this.setMonth(addMonths(this.view.calendarMonth, delta));
			this.view.focusedDate = `${this.view.calendarMonth}-01`;
		},

		setDay(this: Vm, key: string) {
			this.view.fromDate = this.view.toDate = this.view.focusedDate = key;
			this.view.rangeAnchor = '';
			this.timeRange = null;
			this.setMonth(monthKeyOf(key));
		},

		goToday(this: Vm) {
			this.todayKey = localDateKey(Date.now());
			if (this.view.mode === 'all') {
				this.setMonth(monthKeyOf(this.todayKey));
				this.view.focusedDate = this.todayKey;
				return;
			}
			this.setDay(this.todayKey);
			this.applyQuery();
		},

		goLatest(this: Vm) {
			const latest = this.facets?.last_ms ?? null;
			if (latest === null) return;
			const key = localDateKey(latest);
			if (this.view.mode === 'range') {
				const span = daySpan(this.view.fromDate, this.view.toDate);
				this.view.toDate = key;
				this.view.fromDate = addDays(key, -(span - 1));
				this.view.focusedDate = key;
				this.view.rangeAnchor = '';
				this.setMonth(monthKeyOf(key));
			} else {
				if (this.view.mode === 'all') this.view.mode = 'day';
				this.setDay(key);
			}
			this.applyQuery();
		},

		setMode(this: Vm, mode: ArchiveViewMode) {
			if (this.view.mode === mode) return;
			this.view.mode = mode;
			this.view.rangeAnchor = '';
			if (mode === 'day') this.view.toDate = this.view.fromDate;
			this.timeRange = null;
			this.applyQuery();
		},

		pickDate(this: Vm, key: string) {
			if (!dayExists(key)) return;
			this.view.focusedDate = key;
			if (this.view.mode === 'range') {
				if (!this.view.rangeAnchor) {
					this.view.rangeAnchor = key;
					this.view.fromDate = this.view.toDate = key;
				} else {
					let from = this.view.rangeAnchor;
					let to = key;
					if (to < from) [from, to] = [to, from];
					if (daySpan(from, to) > RANGE_MAX_DAYS) {
						if (key === to) from = addDays(to, -(RANGE_MAX_DAYS - 1));
						else to = addDays(from, RANGE_MAX_DAYS - 1);
					}
					this.view.fromDate = from;
					this.view.toDate = to;
					this.view.rangeAnchor = '';
				}
				this.setMonth(monthKeyOf(key));
				this.applyQuery();
				return;
			}
			if (this.view.mode === 'all') this.view.mode = 'day';
			this.setDay(key);
			this.view.calendarOpen = false;
			this.applyQuery();
		},

		onCalendarKey(this: Vm, event: KeyboardEvent, key: string) {
			const weekday = ((dateKeyDayNumber(key) + 4) % 7 + 7) % 7;
			const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday };
			if (!(event.key in moves)) return;
			event.preventDefault();
			const next = addDays(key, moves[event.key]);
			this.view.focusedDate = next;
			this.setMonth(monthKeyOf(next));
			void this.$nextTick(() => {
				this.$el.querySelector(`.archive-day[data-date="${next}"]`)?.focus();
			});
		},

		shiftPeriod(this: Vm, direction: number) {
			if (this.view.mode === 'all') return;
			this.todayKey = localDateKey(Date.now());
			if (direction > 0 && !this.periodNav.next) return;
			if (this.view.mode === 'range') {
				const span = daySpan(this.view.fromDate, this.view.toDate);
				this.view.fromDate = addDays(this.view.fromDate, direction * span);
				this.view.toDate = addDays(this.view.toDate, direction * span);
				this.view.focusedDate = this.view.toDate;
				this.view.rangeAnchor = '';
				this.setMonth(monthKeyOf(this.view.toDate));
			} else {
				this.setDay(shiftExistingDay(this.view.fromDate, direction));
			}
			this.applyQuery();
		},

		// ── Timeline ───────────────────────────────────────────────────────

		setTimeRange(this: Vm, range: TimeRange | null) {
			const same = (range === null && this.timeRange === null)
				|| (range && this.timeRange && range.startMs === this.timeRange.startMs && range.endMs === this.timeRange.endMs);
			this.timeRange = range;
			if (!same) this.applyQuery({ timeline: false });
		},

		timelineMs(this: Vm, event: PointerEvent): number | null {
			const day = this.dayBounds;
			const target = event.currentTarget as HTMLElement | null;
			if (!day || !target) return null;
			const rect = target.getBoundingClientRect();
			if (rect.width <= 0) return null;
			const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
			return day.startMs + fraction * (day.endMs - day.startMs);
		},

		onTimelinePointerDown(this: Vm, event: PointerEvent) {
			if (event.button !== 0) return;
			const ms = this.timelineMs(event);
			if (ms === null) return;
			(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
			this._drag = { pointerId: event.pointerId, startX: event.clientX, startMs: ms, moved: false };
		},

		onTimelinePointerMove(this: Vm, event: PointerEvent) {
			const drag = this._drag;
			const day = this.dayBounds;
			if (!drag || drag.pointerId !== event.pointerId || !day) return;
			if (!drag.moved && Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX) return;
			const ms = this.timelineMs(event);
			if (ms === null) return;
			drag.moved = true;
			this.dragPreview = dragRange(drag.startMs, ms, day.startMs, day.endMs);
		},

		onTimelinePointerUp(this: Vm, event: PointerEvent) {
			const drag = this._drag;
			const day = this.dayBounds;
			this._drag = null;
			this.dragPreview = null;
			if (!drag || drag.pointerId !== event.pointerId || !day) return;
			(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
			const ms = this.timelineMs(event) ?? drag.startMs;
			this.setTimeRange(drag.moved ? dragRange(drag.startMs, ms, day.startMs, day.endMs) : hourContaining(ms, day.startMs, day.endMs));
		},

		onTimelinePointerCancel(this: Vm) {
			this._drag = null;
			this.dragPreview = null;
		},

		onTimelineKey(this: Vm, event: KeyboardEvent) {
			const day = this.dayBounds;
			if (!day) return;
			let range: TimeRange | null | undefined;
			if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
				const direction = event.key === 'ArrowLeft' ? -1 : 1;
				range = event.shiftKey ? resizeWindow(this.timeRange, direction, day.startMs, day.endMs) : moveWindow(this.timeRange, direction, day.startMs, day.endMs);
			} else if (event.key === 'Home') {
				range = firstHour(day.startMs, day.endMs);
			} else if (event.key === 'End') {
				range = lastHour(day.startMs, day.endMs);
			} else if (event.key === 'Escape') {
				if (!this.timeRange) return;
				range = null;
			} else {
				return;
			}
			event.preventDefault();
			this.setTimeRange(range);
		},

		setTimeField(this: Vm, bound: 'from' | 'to', event: Event) {
			const value = fieldValue(event);
			const from = bound === 'from' ? value : this.timeFields.from;
			const to = bound === 'to' ? value : this.timeFields.to;
			this.timeFields[bound] = value;
			const result = timeFieldsRange(this.view.fromDate, from, to);
			this.timeFields.invalid = result.invalid;
			if (result.invalid) return;
			this.setTimeRange(result.range);
		},

		// ── Sorting and paging ─────────────────────────────────────────────

		sortBy(this: Vm, key: ArchiveSortKey) {
			if (this.sort.key === key) this.sort.order = this.sort.order === 'asc' ? 'desc' : 'asc';
			else this.sort = { key, order: defaultSortOrder(key) };
			this.page = 0;
			void this.loadItems();
		},

		goPage(this: Vm, page: number) {
			const next = Math.max(0, Math.min(this.pageTotal - 1, page));
			if (next === this.page) return;
			this.page = next;
			void this.loadItems();
		},

		setPageSize(this: Vm, event: Event) {
			const size = Number(fieldValue(event));
			if (!PAGE_SIZES.includes(size) || size === this.pageSize) return;
			this.pageSize = size;
			this.page = 0;
			void this.loadItems();
		},

		// ── Selection ──────────────────────────────────────────────────────

		toggleRow(this: Vm, row: ArchiveRowView) {
			this.selection = toggleRowSelection(this.selection, row, this.rowsBase);
		},

		togglePage(this: Vm) {
			this.selection = togglePageSelection(this.selection, this.rowsBase);
		},

		selectAll(this: Vm) {
			this.selection = selectAllResults(this.total, this.totals.estimated_bytes);
		},

		clearSelection(this: Vm) {
			this.selection = emptySelection();
			if (this.confirm && this.confirm.type === 'delete-selection') this.confirm = null;
		},

		selectionBody(this: Vm, purpose: 'export' | 'delete') {
			if (this.selection.mode === 'filter') {
				return { filter: filterBody(this.filters, this.timeSpec.query), expected_count: this.selection.filterCount };
			}
			return { items: selectionItems(this.selection, purpose) };
		},

		/** After ARCHIVE_SELECTION_CHANGED: the filter's new total becomes the selection. */
		updateFilterCount(this: Vm, error: unknown): boolean {
			const count = error instanceof ReceiverRequestError ? error.details.count : undefined;
			if (this.selection.mode !== 'filter' || typeof count !== 'number' || !Number.isInteger(count) || count < 0) return false;
			this.selection = selectAllResults(count, this.selection.filterEstimatedBytes);
			void this.loadItems();
			return true;
		},

		// ── Actions ────────────────────────────────────────────────────────

		audioElement(this: Vm): HTMLAudioElement | null {
			return this.$el?.querySelector?.('audio.archive-audio') ?? null;
		},

		pauseAudio(this: Vm) {
			const audio = this.audioElement();
			if (audio && !audio.paused) audio.pause();
			this.audioPlaying = false;
		},

		onAudioState(this: Vm, playing: boolean) {
			this.audioPlaying = playing;
		},

		async togglePlay(this: Vm, row: ArchiveRowView) {
			if (!row.playable) return;
			if (this.preview && this.preview.key === row.key) {
				const audio = this.audioElement();
				if (audio && !audio.paused) {
					audio.pause();
					return;
				}
			} else {
				this.pauseAudio();
				this.preview = { key: row.key, kind: 'audio', id: row.id };
				if (this.confirm && this.confirm.type === 'open-scan') this.confirm = null;
			}
			await this.$nextTick();
			const audio = this.audioElement();
			if (audio) {
				try {
					await audio.play();
				} catch {
					// The player shows its own controls; a blocked play() leaves it paused.
				}
			}
		},

		togglePreview(this: Vm, row: ArchiveRowView) {
			if (!row.previewable) return;
			if (this.preview && this.preview.key === row.key) {
				this.preview = null;
				if (this.confirm && this.confirm.type === 'open-scan') this.confirm = null;
				return;
			}
			this.pauseAudio();
			this.preview = { key: row.key, kind: row.kind, id: row.id };
			if (row.kind === 'scan') void this.loadPreview(row.id);
		},

		async loadPreview(this: Vm, scanId: string) {
			this.previewLoading = true;
			this.previewError = '';
			const result = await this.fetchLatest('preview', (signal: AbortSignal) => archiveApi.scanPreview(scanId, signal));
			if (!result) return;
			this.previewLoading = false;
			if (result.ok) this.previewData = Object.freeze(result.value);
			else this.previewError = errorText(result.error);
		},

		openScan(this: Vm, row: ArchiveRowView) {
			if (this.scanBusy || row.kind !== 'scan') return;
			if (this.rxRunning || this.recording) {
				this.confirm = { type: 'open-scan', key: row.key, id: row.id, withRecording: Boolean(this.recording) };
				this.focusConfirmCancel();
				return;
			}
			this.$emit('open-scan', row.id);
		},

		confirmOpenScan(this: Vm) {
			if (!this.confirm || this.confirm.type !== 'open-scan' || this.scanBusy) return;
			const scanId = this.confirm.id;
			this.confirm = null;
			this.$emit('open-scan', scanId);
		},

		focusConfirmCancel(this: Vm) {
			void this.$nextTick(() => {
				this.$el.querySelector('[data-confirm-cancel]')?.focus();
			});
		},

		cancelConfirm(this: Vm) {
			const confirm = this.confirm as ConfirmState | null;
			this.confirm = null;
			if (confirm && confirm.type === 'retention') this.restoreRetention();
		},

		askDeleteRow(this: Vm, row: ArchiveRowView) {
			if (!row.deletable) return;
			this.confirm = { type: 'delete-row', key: row.key, kind: row.kind, id: row.id };
			this.focusConfirmCancel();
		},

		async confirmDeleteRow(this: Vm) {
			const confirm = this.confirm;
			if (!confirm || confirm.type !== 'delete-row') return;
			await this.runDelete({ items: [{ kind: confirm.kind, id: confirm.id }] });
		},

		askDeleteSelection(this: Vm) {
			if (!this.selectionView.canDelete) return;
			this.confirm = { type: 'delete-selection' };
			this.focusConfirmCancel();
		},

		async confirmDeleteSelection(this: Vm) {
			if (!this.confirm || this.confirm.type !== 'delete-selection') return;
			await this.runDelete(this.selectionBody('delete'));
		},

		async runDelete(this: Vm, body: { items?: Array<{ kind: 'audio' | 'scan'; id: string }> }) {
			if (this.busy.deleting) return;
			this.busy.deleting = true;
			try {
				const result = await archiveApi.deleteItems(body as never);
				this.confirm = null;
				const deleted = result.deleted.audio + result.deleted.scan;
				const parts: string[] = [];
				if (deleted || !result.skipped_count) parts.push(`${deleted} ${plural(deleted, 'record', 'records')} deleted.`);
				if (result.skipped_count) {
					parts.push(`${result.skipped_count} ${plural(result.skipped_count, 'record was', 'records were')} not deleted.`);
					const first = result.skipped[0];
					if (first) parts.push(ARCHIVE_ERROR_TEXT[first.code] ?? first.error);
				}
				this.notice = { parts, tone: result.skipped_count ? 'warn' : 'ok' };
				const previewKey = this.preview?.key;
				if (previewKey && (!body.items || body.items.some(item => `${item.kind}:${item.id}` === previewKey))) {
					this.pauseAudio();
					this.preview = null;
				}
				if (result.deleted_scan_ids.length) this.$emit('deleted', result.deleted_scan_ids.slice());
				this.selection = emptySelection();
				await this.refreshAll();
			} catch (error) {
				if (errorCode(error) === 'ARCHIVE_SELECTION_CHANGED' && this.updateFilterCount(error)) {
					this.notice = { parts: [errorText(error)], tone: 'warn' };
					this.confirm = { type: 'delete-selection' };
					this.focusConfirmCancel();
				} else {
					this.notice = { parts: [`Could not delete records: ${errorText(error)}`], tone: 'bad' };
				}
			} finally {
				this.busy.deleting = false;
			}
		},

		async downloadSelection(this: Vm) {
			if (!this.selectionView.canDownload || this.busy.exporting) return;
			this.busy.exporting = true;
			this.readyExport = null;
			this.clearTimer('export');
			this.notice = { parts: ['Preparing ZIP…'], tone: 'info' };
			try {
				const prepared = await archiveApi.createExport(this.selectionBody('export'));
				const url = exportDownloadUrl(prepared.url);
				const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
				if (activation?.isActive) {
					// Same-origin <a download>: Chrome's download manager streams the file.
					const link = document.createElement('a');
					link.href = url;
					link.download = prepared.filename;
					link.click();
					this.notice = { parts: ['Download started.'], tone: 'ok' };
				} else {
					// The click's activation ran out while the console prepared the ZIP.
					this.notice = null;
					this.readyExport = { url, filename: prepared.filename };
					this._timers.export = window.setTimeout(() => {
						this._timers.export = 0;
						this.readyExport = null;
					}, prepared.expires_in_s * 1000);
				}
			} catch (error) {
				if (errorCode(error) === 'ARCHIVE_SELECTION_CHANGED') this.updateFilterCount(error);
				this.notice = { parts: [`Could not prepare the ZIP: ${errorText(error)}`], tone: 'bad' };
			} finally {
				this.busy.exporting = false;
			}
		},

		onReadyExportClick(this: Vm) {
			// The link is single use; the browser follows it before it goes.
			this.clearTimer('export');
			window.setTimeout(() => {
				this.readyExport = null;
				this.notice = { parts: ['Download started.'], tone: 'ok' };
			}, 0);
		},

		dismissNotice(this: Vm) {
			this.notice = null;
			this.readyExport = null;
			this.clearTimer('export');
		},

		onAutoArchiveChange(this: Vm, event: Event) {
			this.$emit('update-auto-archive', Boolean((event.target as HTMLInputElement).checked));
		},

		// ── Retention ──────────────────────────────────────────────────────

		restoreRetention(this: Vm) {
			const saved = this.settings?.retention_days;
			this.retentionDraft = saved === null || saved === undefined ? 'off' : String(saved);
		},

		async onRetentionChange(this: Vm, event: Event) {
			if (!this.settings) return;
			const select = event.target as HTMLSelectElement;
			const value = select.value;
			const saved = this.settings.retention_days;
			this.retentionDraft = value;
			if (this.confirm && this.confirm.type === 'retention') this.confirm = null;
			if (value === 'off') {
				if (saved === null) return;
				this.busy.retention = true;
				try {
					this.applySettings(await archiveApi.setRetention(null, false));
				} catch (error) {
					this.restoreRetention();
					select.value = this.retentionDraft;
					this.notice = { parts: [`Could not save retention: ${errorText(error)}`], tone: 'bad' };
				} finally {
					this.busy.retention = false;
				}
				return;
			}
			const days = Number(value);
			if (days === saved) return;
			this.busy.retentionPreview = true;
			const result = await this.fetchLatest('retentionPreview', (signal: AbortSignal) => archiveApi.retentionPreview(days, signal));
			this.busy.retentionPreview = false;
			if (!result) return;
			if (!result.ok) {
				this.restoreRetention();
				select.value = this.retentionDraft;
				this.notice = { parts: [`Could not save retention: ${errorText(result.error)}`], tone: 'bad' };
				return;
			}
			if (!this._shown || this.retentionDraft !== value) {
				this.restoreRetention();
				return;
			}
			this.confirm = { type: 'retention', days, preview: Object.freeze(result.value) };
			this.focusConfirmCancel();
		},

		async applyRetention(this: Vm) {
			if (!this.confirm || this.confirm.type !== 'retention' || this.busy.retention) return;
			const days = this.confirm.days;
			this.busy.retention = true;
			try {
				const settings: ArchiveSettings = await archiveApi.setRetention(days, true);
				this.confirm = null;
				this.applySettings(settings);
				const removed = settings.retention_result;
				if (removed) {
					const count = removed.audio + removed.scans;
					this.notice = { parts: [`Retention removed ${count} ${plural(count, 'record', 'records')} (${formatBytes(removed.bytes)}).`], tone: 'ok' };
				}
				await this.refreshAll();
				if (settings.retention_running || removed?.more) {
					this.clearTimer('retention');
					this._timers.retention = window.setTimeout(() => {
						this._timers.retention = 0;
						if (this._shown && document.visibilityState === 'visible') void this.refreshAll();
					}, RETENTION_FOLLOW_UP_MS);
				}
			} catch (error) {
				this.confirm = null;
				this.restoreRetention();
				this.notice = { parts: [`Could not save retention: ${errorText(error)}`], tone: 'bad' };
			} finally {
				this.busy.retention = false;
			}
		},
	},
};
