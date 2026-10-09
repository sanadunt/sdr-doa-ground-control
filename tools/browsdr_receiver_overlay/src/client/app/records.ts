import type { AppInstance } from './types';
import { receiverRecordsApi } from './receiver-records-api';
import type { ReceiverAudioSessionRecord, ReceiverMarker, ReceiverRecord, ReceiverScanRecord } from './receiver-records-api';

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
			const [scanPage, audioPage] = await Promise.all([
				receiverRecordsApi.listRecords('scan', this.records.scanPage * pageSize, pageSize),
				receiverRecordsApi.listRecords('audio-session', this.records.audioPage * pageSize, pageSize),
			]);
			if (requestId !== recordRequestIds.get(this)) return;
			this.records.scanItems = scanPage.items.filter((record): record is ReceiverScanRecord => record.type === 'scan');
			this.records.scanTotal = scanPage.total;
			this.records.audioItems = audioPage.items.filter((record): record is ReceiverAudioSessionRecord => record.type === 'audio-session');
			this.records.audioTotal = audioPage.total;
			const scanLastPage = Math.max(0, Math.ceil(scanPage.total / pageSize) - 1);
			const audioLastPage = Math.max(0, Math.ceil(audioPage.total / pageSize) - 1);
			if (this.records.scanPage > scanLastPage || this.records.audioPage > audioLastPage) {
				this.records.scanPage = Math.min(this.records.scanPage, scanLastPage);
				this.records.audioPage = Math.min(this.records.audioPage, audioLastPage);
				void this.loadReceiverRecords();
				return;
			}
			this.records.error = '';
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

	async selectMarkerSet(this: AppInstance) {
		const selected = this.records.markerSets.find((set: { id: string }) => set.id === this.records.selectedMarkerSetId);
		this.records.markerSetName = selected?.name || '';
		this.records.markers = selected ? selected.markers.map((marker: ReceiverMarker) => ({ ...marker })) : [];
		this.records.markerFrequencyDrafts = markerFrequencyDrafts(this.records.markers);
		this.records.selectedMarkerId = null;
		this.records.referenceMarkerId = null;
		this.drawSweepSpectrum();
		this.candidateFilterChanged();
	},

	newMarkerSet(this: AppInstance) {
		this.records.selectedMarkerSetId = '';
		this.records.markerSetName = '';
		this.records.markers = [];
		this.records.markerFrequencyDrafts = {};
		this.records.selectedMarkerId = null;
		this.records.referenceMarkerId = null;
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
		this.records.selectedMarkerId = marker.id;
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
		try {
			const saved = await receiverRecordsApi.saveMarkerSet({
				id: this.records.selectedMarkerSetId,
				name,
				markers: (this.records.markers as ReceiverMarker[]).map(marker => ({ ...marker })),
			});
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
		if (this.records.selectedMarkerId === markerId) this.records.selectedMarkerId = null;
		if (this.records.referenceMarkerId === markerId) this.records.referenceMarkerId = null;
		this.drawSweepSpectrum();
		if (this.records.selectedMarkerSetId) await this.saveMarkerSet();
		else this.candidateFilterChanged();
	},

	async deleteMarkerSet(this: AppInstance) {
		const markerSetId = String(this.records.selectedMarkerSetId || '');
		if (!markerSetId || !window.confirm('Delete this saved marker set? This cannot be undone.')) return;
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
		const description = record.type === 'scan' ? 'spectrum scan and its data' : 'audio session and its audio files';
		if (!window.confirm(`Delete this ${description}? This cannot be undone.`)) return;
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

	audioRecordUrl(this: AppInstance, segmentId: string): string {
		return receiverRecordsApi.audioUrl(segmentId);
	},
};
