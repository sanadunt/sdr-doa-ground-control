import type { AppInstance } from './types';
import { ReceiverRequestError, browserTimeZone, browserUtcOffsetMinutes, receiverRecordsApi } from './receiver-records-api';
import { receiverDateLocale } from './i18n';
import type { ReceiverAudioSegmentRecord, ReceiverAudioSessionRecord, ReceiverMarker, ReceiverRecord, ReceiverScanRecord } from './receiver-records-api';

const recordRequestIds = new WeakMap<object, number>();

function nextRecordRequestId(app: object): number {
	const next = (recordRequestIds.get(app) || 0) + 1;
	recordRequestIds.set(app, next);
	return next;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function newMarkerId(): string {
	return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `marker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function markerFrequencyDrafts(markers: ReceiverMarker[]): Record<string, string> {
	return Object.fromEntries(markers.map(marker => [marker.id, String(marker.frequencyHz / 1_000_000)]));
}

function localAudioDateKey(date: Date): string {
	const year = String(date.getFullYear()).padStart(4, '0');
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function localAudioMonthKey(date: Date): string {
	return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function localAudioDateFromKey(value: string): Date {
	const [year, month, day] = value.split('-').map(Number);
	return new Date(year, month - 1, day, 12, 0, 0, 0);
}

export const recordsMethods = {
	async loadReceiverSettings(this: AppInstance) {
		const [settingsResult, markerSetsResult] = await Promise.allSettled([
			receiverRecordsApi.getSettings(),
			receiverRecordsApi.getMarkerSets(),
		]);
		const errors: string[] = [];
		if (settingsResult.status === 'fulfilled') {
			this.records.autoSpectrumRecording = settingsResult.value.auto_spectrum_recording;
			this.records.savedAutoSpectrumRecording = settingsResult.value.auto_spectrum_recording;
		} else {
			errors.push(`settings: ${errorMessage(settingsResult.reason)}`);
		}
		if (markerSetsResult.status === 'fulfilled') {
			this.records.markerSets = markerSetsResult.value;
		} else {
			errors.push(`marker sets: ${errorMessage(markerSetsResult.reason)}`);
		}
		this.records.settingsLoaded = true;
		this.records.error = errors.length ? `Local Receiver records unavailable (${errors.join('; ')}).` : '';
	},

	async updateAutoSpectrumRecording(this: AppInstance) {
		const requested = Boolean(this.records.autoSpectrumRecording);
		try {
			const saved = await receiverRecordsApi.updateSettings({ auto_spectrum_recording: requested });
			this.records.autoSpectrumRecording = saved.auto_spectrum_recording;
			this.records.savedAutoSpectrumRecording = saved.auto_spectrum_recording;
			this.records.error = '';
		} catch (error) {
			this.records.autoSpectrumRecording = this.records.savedAutoSpectrumRecording;
			this.records.error = `Could not save spectrum recording preference: ${errorMessage(error)}`;
		}
	},

	async loadReceiverRecords(this: AppInstance) {
		const requestId = nextRecordRequestId(this);
		this.records.loading = true;
		try {
			const pageSize = this.records.pageSize;
			const timeZone = browserTimeZone();
			const utcOffsetMinutes = browserUtcOffsetMinutes();
			// Each list loads on its own: a failed facet or filter request must not hide saved records.
			const [scanResult, audioResult, facetResult] = await Promise.allSettled([
				receiverRecordsApi.listRecords('scan', this.records.scanPage * pageSize, pageSize),
				(async () => receiverRecordsApi.listAudioRecords(
					this.records.audioPage * pageSize,
					pageSize,
					{
						date: this.records.audioDateFilter,
						timeFrom: this.records.audioTimeFrom,
						timeTo: this.records.audioTimeTo,
						timeZone,
						utcOffsetMinutes,
						minimumFrequencyMHz: this.records.audioMinimumFrequencyMHz,
						maximumFrequencyMHz: this.records.audioMaximumFrequencyMHz,
						vfoIndex: this.records.audioVfoFilter,
						mode: this.records.audioModeFilter,
						bandwidthHz: this.records.audioBandwidthFilter,
					},
				))(),
				receiverRecordsApi.getAudioRecordFacets(timeZone, utcOffsetMinutes),
			]);
			if (requestId !== recordRequestIds.get(this)) return;
			const errors: string[] = [];
			let scanLastPage = this.records.scanPage;
			let audioLastPage = this.records.audioPage;
			if (scanResult.status === 'fulfilled') {
				const scanPage = scanResult.value;
				this.records.scanItems = scanPage.items.filter((record): record is ReceiverScanRecord => record.type === 'scan');
				this.records.scanTotal = scanPage.total;
				scanLastPage = Math.max(0, Math.ceil(scanPage.total / pageSize) - 1);
			} else {
				errors.push(`spectrum scans: ${errorMessage(scanResult.reason)}`);
			}
			if (audioResult.status === 'fulfilled') {
				const audioPage = audioResult.value;
				this.records.audioItems = audioPage.items.filter((record): record is ReceiverAudioSessionRecord => record.type === 'audio-session');
				this.records.audioTotal = audioPage.total;
				audioLastPage = Math.max(0, Math.ceil(audioPage.total / pageSize) - 1);
			} else {
				errors.push(`VFO audio: ${errorMessage(audioResult.reason)}`);
			}
			if (facetResult.status === 'fulfilled') {
				const audioFacets = facetResult.value;
				this.records.audioFacets = audioFacets;
				this.records.audioAvailableDateLookup = Object.fromEntries(audioFacets.available_dates.map(date => [date, true] as const));
				if (!this.records.audioCalendarMonth) {
					const latestAudioDate = audioFacets.available_dates[audioFacets.available_dates.length - 1] || localAudioDateKey(new Date());
					this.records.audioCalendarMonth = latestAudioDate.slice(0, 7);
				}
			} else {
				errors.push(`audio filter options: ${errorMessage(facetResult.reason)}`);
			}
			if (this.records.scanPage > scanLastPage || this.records.audioPage > audioLastPage) {
				this.records.scanPage = Math.min(this.records.scanPage, scanLastPage);
				this.records.audioPage = Math.min(this.records.audioPage, audioLastPage);
				void this.loadReceiverRecords();
				return;
			}
			this.records.error = errors.length ? `Could not load some local Receiver records (${errors.join('; ')}).` : '';
		} catch (error) {
			if (requestId === recordRequestIds.get(this)) this.records.error = `Could not load local Receiver records: ${errorMessage(error)}`;
		} finally {
			if (requestId === recordRequestIds.get(this)) this.records.loading = false;
		}
	},

	changeReceiverRecordPage(this: AppInstance, type: 'scan' | 'audio-session', page: number) {
		if (type === 'scan') {
			const lastPage = Math.max(0, Math.ceil(this.records.scanTotal / this.records.pageSize) - 1);
			this.records.scanPage = Math.max(0, Math.min(lastPage, Math.floor(page)));
		} else {
			const lastPage = Math.max(0, Math.ceil(this.records.audioTotal / this.records.pageSize) - 1);
			this.records.audioPage = Math.max(0, Math.min(lastPage, Math.floor(page)));
		}
		void this.loadReceiverRecords();
	},

	applyAudioRecordFilters(this: AppInstance) {
		this.records.audioPage = 0;
		this.records.audioItems = [];
		void this.loadReceiverRecords();
	},

	hasAudioRecordFilters(this: AppInstance): boolean {
		return Boolean(this.records.audioDateFilter || this.records.audioTimeFrom || this.records.audioTimeTo || this.records.audioMinimumFrequencyMHz || this.records.audioMaximumFrequencyMHz || this.records.audioVfoFilter || this.records.audioModeFilter || this.records.audioBandwidthFilter);
	},

	clearAudioRecordFilters(this: AppInstance) {
		this.records.audioDateFilter = '';
		this.records.audioTimeFrom = '';
		this.records.audioTimeTo = '';
		this.records.audioMinimumFrequencyMHz = '';
		this.records.audioMaximumFrequencyMHz = '';
		this.records.audioVfoFilter = '';
		this.records.audioModeFilter = '';
		this.records.audioBandwidthFilter = '';
		this.applyAudioRecordFilters();
	},

	setAudioFrequencyFilter(this: AppInstance, event: Event, bound: 'min' | 'max') {
		if (!(event.currentTarget instanceof HTMLInputElement)) return;
		if (bound === 'min') this.records.audioMinimumFrequencyMHz = event.currentTarget.value;
		else this.records.audioMaximumFrequencyMHz = event.currentTarget.value;
		this.applyAudioRecordFilters();
	},

	audioCalendarWeekdays(this: AppInstance): string[] {
		return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => this.t(day));
	},

	audioCalendarMonthLabel(this: AppInstance): string {
		const [year, month] = (this.records.audioCalendarMonth || localAudioMonthKey(new Date())).split('-').map(Number);
		return new Date(year, month - 1, 1, 12).toLocaleDateString(receiverDateLocale(this.uiLanguage), { month: 'long', year: 'numeric' });
	},

	formatAudioDate(this: AppInstance, dateKey: string): string {
		return localAudioDateFromKey(dateKey).toLocaleDateString(receiverDateLocale(this.uiLanguage), { year: 'numeric', month: 'short', day: 'numeric' });
	},

	audioCalendarWeeks(this: AppInstance) {
		const [year, month] = (this.records.audioCalendarMonth || localAudioMonthKey(new Date())).split('-').map(Number);
		const monthStart = new Date(year, month - 1, 1, 12);
		const firstVisibleDate = new Date(year, month - 1, 1 - monthStart.getDay(), 12);
		return Array.from({ length: 6 }, (_, weekIndex) => Array.from({ length: 7 }, (_, dayIndex) => {
			const date = new Date(firstVisibleDate);
			date.setDate(firstVisibleDate.getDate() + weekIndex * 7 + dayIndex);
			const dateKey = localAudioDateKey(date);
			return { date: dateKey, day: date.getDate(), inMonth: date.getMonth() === monthStart.getMonth(), hasRecords: Boolean(this.records.audioAvailableDateLookup[dateKey]) };
		}));
	},

	focusAudioCalendarDate(this: AppInstance, dateKey: string) {
		window.requestAnimationFrame(() => document.getElementById(`audio-calendar-date-${dateKey}`)?.focus());
	},

	changeAudioCalendarMonth(this: AppInstance, offset: number) {
		const [year, month] = (this.records.audioCalendarMonth || localAudioMonthKey(new Date())).split('-').map(Number);
		const nextMonth = new Date(year, month - 1 + offset, 1, 12);
		this.records.audioCalendarMonth = localAudioMonthKey(nextMonth);
		this.records.audioCalendarFocusedDate = localAudioDateKey(nextMonth);
		this.focusAudioCalendarDate(this.records.audioCalendarFocusedDate);
	},

	toggleAudioCalendar(this: AppInstance, event: Event) {
		if (!(event.currentTarget instanceof HTMLDetailsElement)) return;
		this.records.audioCalendarOpen = event.currentTarget.open;
		if (!event.currentTarget.open) return;
		const dates = this.records.audioFacets?.available_dates || [];
		const focusDate = this.records.audioDateFilter || this.records.audioCalendarFocusedDate || dates[dates.length - 1] || localAudioDateKey(new Date());
		this.records.audioCalendarMonth = focusDate.slice(0, 7);
		this.records.audioCalendarFocusedDate = focusDate;
		this.focusAudioCalendarDate(focusDate);
	},

	moveAudioCalendarFocus(this: AppInstance, event: KeyboardEvent, dateKey: string) {
		const date = localAudioDateFromKey(dateKey);
		switch (event.key) {
			case 'ArrowLeft': date.setDate(date.getDate() - 1); break;
			case 'ArrowRight': date.setDate(date.getDate() + 1); break;
			case 'ArrowUp': date.setDate(date.getDate() - 7); break;
			case 'ArrowDown': date.setDate(date.getDate() + 7); break;
			case 'Home': date.setDate(date.getDate() - date.getDay()); break;
			case 'End': date.setDate(date.getDate() + 6 - date.getDay()); break;
			default: return;
		}
		event.preventDefault();
		const nextDate = localAudioDateKey(date);
		this.records.audioCalendarFocusedDate = nextDate;
		this.records.audioCalendarMonth = nextDate.slice(0, 7);
		this.focusAudioCalendarDate(nextDate);
	},

	selectAudioCalendarDate(this: AppInstance, dateKey: string) {
		this.records.audioDateFilter = dateKey;
		this.records.audioCalendarFocusedDate = dateKey;
		this.records.audioCalendarMonth = dateKey.slice(0, 7);
		this.records.audioCalendarOpen = false;
		this.applyAudioRecordFilters();
		window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.audio-date-picker > summary')?.focus());
	},

	closeAudioCalendar(this: AppInstance) {
		this.records.audioCalendarOpen = false;
		window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.audio-date-picker > summary')?.focus());
	},

	async selectMarkerSet(this: AppInstance) {
		const selected = this.records.markerSets.find((set: { id: string }) => set.id === this.records.selectedMarkerSetId);
		this.records.markerSetName = selected?.name || '';
		this.records.markers = selected ? selected.markers.map((marker: ReceiverMarker) => ({ ...marker })) : [];
		this.records.markerFrequencyDrafts = markerFrequencyDrafts(this.records.markers);
		this.drawSweepSpectrum();
		this.candidateFilterChanged();
	},

	newMarkerSet(this: AppInstance) {
		this.records.selectedMarkerSetId = '';
		this.records.markerSetName = '';
		this.records.markers = [];
		this.records.markerFrequencyDrafts = {};
		this.records.markedOnly = false;
		this.drawSweepSpectrum();
		this.candidateFilterChanged();
	},

	async addReceiverMarker(this: AppInstance, frequencyHz: number, powerDb: number | null, label = '') {
		if (!Number.isFinite(frequencyHz) || frequencyHz <= 0 || (powerDb !== null && !Number.isFinite(powerDb))) {
			this.records.error = 'Marker frequency must be positive and finite; measured power must be finite.';
			return;
		}
		const marker: ReceiverMarker = {
			id: newMarkerId(),
			frequencyHz,
			powerDb,
			label: String(label).trim().slice(0, 80) || `Marker ${this.records.markers.length + 1}`,
		};
		this.records.markers.push(marker);
		this.records.markerFrequencyDrafts[marker.id] = String(frequencyHz / 1_000_000);
		this.records.error = '';
		this.drawSweepSpectrum();
		if (this.records.selectedMarkerSetId) await this.saveMarkerSet();
		else this.candidateFilterChanged();
	},

	async addManualReceiverMarker(this: AppInstance) {
		const rawFrequencyMHz = String(this.records.manualMarkerFrequencyMHz || '').trim();
		const frequencyMHz = Number(rawFrequencyMHz);
		const frequencyHz = frequencyMHz * 1_000_000;
		if (!rawFrequencyMHz || !Number.isFinite(frequencyMHz) || frequencyMHz <= 0 || !Number.isFinite(frequencyHz)) {
			this.records.error = 'Enter a positive finite marker frequency in MHz.';
			return;
		}
		const label = String(this.records.manualMarkerLabel || '').trim();
		await this.addReceiverMarker(frequencyHz, null, label);
		if (!this.records.error) {
			this.records.manualMarkerFrequencyMHz = '';
			this.records.manualMarkerLabel = '';
		}
	},

	async updateReceiverMarker(this: AppInstance, markerId: string) {
		const marker = (this.records.markers as ReceiverMarker[]).find(item => item.id === markerId);
		if (!marker) return;
		const rawFrequencyMHz = String(this.records.markerFrequencyDrafts[markerId] ?? '').trim();
		const frequencyMHz = Number(rawFrequencyMHz);
		const frequencyHz = frequencyMHz * 1_000_000;
		if (!rawFrequencyMHz || !Number.isFinite(frequencyMHz) || frequencyMHz <= 0 || !Number.isFinite(frequencyHz)) {
			this.records.markerFrequencyDrafts[markerId] = String(marker.frequencyHz / 1_000_000);
			this.records.error = 'Marker frequency must be a positive finite value in MHz.';
			return;
		}
		marker.frequencyHz = frequencyHz;
		marker.label = String(marker.label || '').slice(0, 80);
		this.records.markerFrequencyDrafts[markerId] = String(frequencyHz / 1_000_000);
		this.records.error = '';
		this.drawSweepSpectrum();
		if (this.records.selectedMarkerSetId) await this.saveMarkerSet();
		else this.candidateFilterChanged();
	},

	async saveMarkerSet(this: AppInstance) {
		const name = String(this.records.markerSetName || '').trim();
		if (!name) {
			this.records.error = 'Enter a name before saving this marker set.';
			return;
		}
		if ((this.records.markers as ReceiverMarker[]).some(marker =>
			!Number.isFinite(marker.frequencyHz) || marker.frequencyHz <= 0
			|| (marker.powerDb !== null && !Number.isFinite(marker.powerDb)))) {
			this.records.error = 'Marker frequencies must be positive and finite; measured powers must be finite.';
			return;
		}
		const markerSet = {
			id: this.records.selectedMarkerSetId,
			name,
			markers: (this.records.markers as ReceiverMarker[]).map(marker => ({ ...marker })),
		};
		try {
			let saved;
			try {
				saved = await receiverRecordsApi.saveMarkerSet(markerSet);
			} catch (error) {
				if (!(error instanceof ReceiverRequestError) || error.status !== 409 || markerSet.id) throw error;
				if (!window.confirm(this.tm(`A marker set named "${name}" already exists. Replace its markers with the ${markerSet.markers.length} marker(s) shown here?`))) {
					this.records.error = `Not saved: a marker set named "${name}" already exists. Choose another name or load that set.`;
					return;
				}
				saved = await receiverRecordsApi.saveMarkerSet(markerSet, true);
			}
			const index = this.records.markerSets.findIndex((set: { id: string }) => set.id === saved.id);
			if (index < 0) this.records.markerSets.push(saved);
			else this.records.markerSets[index] = saved;
			this.records.selectedMarkerSetId = saved.id;
			this.records.markerSetName = saved.name;
			this.records.markers = saved.markers.map(marker => ({ ...marker }));
			this.records.markerFrequencyDrafts = markerFrequencyDrafts(this.records.markers);
			this.records.error = '';
			this.candidateFilterChanged();
		} catch (error) {
			this.records.error = `Could not save marker set: ${errorMessage(error)}`;
		}
	},

	async removeReceiverMarker(this: AppInstance, markerId: string) {
		this.records.markers = (this.records.markers as ReceiverMarker[]).filter(marker => marker.id !== markerId);
		const drafts = { ...this.records.markerFrequencyDrafts };
		delete drafts[markerId];
		this.records.markerFrequencyDrafts = drafts;
		this.drawSweepSpectrum();
		if (this.records.selectedMarkerSetId) await this.saveMarkerSet();
		else this.candidateFilterChanged();
	},

	async deleteMarkerSet(this: AppInstance) {
		const markerSetId = String(this.records.selectedMarkerSetId || '');
		if (!markerSetId || !window.confirm(this.tm('Delete this saved marker set? This cannot be undone.'))) return;
		try {
			await receiverRecordsApi.deleteMarkerSet(markerSetId);
			this.records.markerSets = this.records.markerSets.filter((set: { id: string }) => set.id !== markerSetId);
			this.records.selectedMarkerSetId = '';
			this.records.markerSetName = '';
			this.records.markers = [];
			this.records.markerFrequencyDrafts = {};
			this.records.markedOnly = false;
			this.records.error = '';
			this.drawSweepSpectrum();
			this.candidateFilterChanged();
		} catch (error) {
			this.records.error = `Could not delete marker set: ${errorMessage(error)}`;
		}
	},

	async openReceiverRecord(this: AppInstance, record: ReceiverRecord) {
		if (record.type !== 'scan') return;
		await this.openArchivedSweep(record.id);
	},

	async deleteReceiverRecord(this: AppInstance, record: ReceiverRecord) {
		if (record.type === 'scan' && record.id === this.sweep.scanId && (this.sweep.active || this.sweep.starting || this.sweep.stopping)) {
			this.records.error = 'Stop the active scan before deleting its record.';
			return;
		}
		if (record.type === 'audio-session' && record.completed_at === null) {
			this.records.error = 'Stop the VFO audio recording before deleting this session.';
			return;
		}
		const description = record.type === 'scan' ? 'spectrum scan and its data' : 'audio session and its audio files';
		if (!window.confirm(this.tm(`Delete this ${description}? This cannot be undone.`))) return;
		try {
			await receiverRecordsApi.deleteRecord(record.id);
			if (record.type === 'scan') {
				if (record.id === this.sweep.scanId) this.clearSweepData();
				const lastPage = Math.max(0, Math.ceil((this.records.scanTotal - 1) / this.records.pageSize) - 1);
				this.records.scanPage = Math.min(this.records.scanPage, lastPage);
			} else {
				const lastPage = Math.max(0, Math.ceil((this.records.audioTotal - 1) / this.records.pageSize) - 1);
				this.records.audioPage = Math.min(this.records.audioPage, lastPage);
			}
			await this.loadReceiverRecords();
			this.records.error = '';
		} catch (error) {
			this.records.error = `Could not delete record: ${errorMessage(error)}`;
		}
	},

	async deleteAudioSegment(this: AppInstance, segment: ReceiverAudioSegmentRecord) {
		if (segment.ended_at === null) {
			this.records.error = 'Stop the active VFO recording before deleting it.';
			return;
		}
		if (this.records.deletingAudioSegmentId) return;
		const frequencyMHz = (segment.frequency_hz / 1_000_000).toFixed(6);
		if (!window.confirm(this.tm(`Delete VFO ${segment.vfo_index + 1} recording at ${frequencyMHz} MHz? This cannot be undone.`))) return;
		this.records.deletingAudioSegmentId = segment.id;
		this.records.error = '';
		try {
			await receiverRecordsApi.deleteAudioSegment(segment.id);
			await this.loadReceiverRecords();
		} catch (error) {
			this.records.error = `Could not delete recording: ${errorMessage(error)}`;
		} finally {
			this.records.deletingAudioSegmentId = '';
		}
	},

	audioRecordUrl(this: AppInstance, segmentId: string): string {
		return receiverRecordsApi.audioUrl(segmentId);
	},

	/** Operator label for a stored scan source; the stored value stays the English code. */
	scanSourceLabel(this: AppInstance, source: ReceiverScanRecord['source']): string {
		switch (source) {
			case 'simulated':
				return this.t('Simulation (synthetic peaks)');
			case 'native':
				return this.t('HackRF native sweep');
			case 'manual':
				return this.t('HackRF manual sweep');
			case 'receiver':
				return this.t('Receiver');
			default:
				return source;
		}
	},
};
