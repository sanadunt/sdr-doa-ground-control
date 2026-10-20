import type { AppInstance } from './types';
import { ReceiverRequestError, receiverRecordsApi } from './receiver-records-api';
import type { ReceiverMarker } from './receiver-records-api';

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

	/** The Records component's Auto-archive scans switch. */
	setAutoSpectrumRecording(this: AppInstance, enabled: boolean) {
		this.records.autoSpectrumRecording = Boolean(enabled);
		void this.updateAutoSpectrumRecording();
	},

	/** Scans deleted from Records; the one open in Spectrum is cleared unless a scan runs. */
	onArchiveDeleted(this: AppInstance, scanIds: string[]) {
		const scanId = this.sweep.scanId as string | null;
		if (!scanId || !Array.isArray(scanIds) || !scanIds.includes(scanId)) return;
		if (this.sweep.active || this.sweep.starting || this.sweep.stopping) return;
		this.clearSweepData();
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

	/**
	 * Adds a marker to the working list and saves it to the selected marker set. Returns its id and
	 * whether that save worked (null when no set is selected), or null for an unusable frequency or
	 * power. The Ground Console bridge adds the dashboard's markers through here.
	 */
	async addReceiverMarker(this: AppInstance, frequencyHz: number, powerDb: number | null, label = ''): Promise<{ id: string; saved: boolean | null } | null> {
		if (!Number.isFinite(frequencyHz) || frequencyHz <= 0 || (powerDb !== null && !Number.isFinite(powerDb))) {
			this.records.error = 'Marker frequency must be positive and finite; measured power must be finite.';
			return null;
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
		if (this.records.selectedMarkerSetId) return { id: marker.id, saved: await this.saveMarkerSet() };
		this.candidateFilterChanged();
		return { id: marker.id, saved: null };
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

	/** Saves the working list as the named set; true once the console has stored it. */
	async saveMarkerSet(this: AppInstance): Promise<boolean> {
		const name = String(this.records.markerSetName || '').trim();
		if (!name) {
			this.records.error = 'Enter a name before saving this marker set.';
			return false;
		}
		if ((this.records.markers as ReceiverMarker[]).some(marker =>
			!Number.isFinite(marker.frequencyHz) || marker.frequencyHz <= 0
			|| (marker.powerDb !== null && !Number.isFinite(marker.powerDb)))) {
			this.records.error = 'Marker frequencies must be positive and finite; measured powers must be finite.';
			return false;
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
					return false;
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
			return true;
		} catch (error) {
			this.records.error = `Could not save marker set: ${errorMessage(error)}`;
			return false;
		}
	},

	/** Removes a marker from the working list and the selected set; saved is null when no set is selected. */
	async removeReceiverMarker(this: AppInstance, markerId: string): Promise<{ removed: boolean; saved: boolean | null }> {
		const before = (this.records.markers as ReceiverMarker[]).length;
		this.records.markers = (this.records.markers as ReceiverMarker[]).filter(marker => marker.id !== markerId);
		const removed = (this.records.markers as ReceiverMarker[]).length < before;
		const drafts = { ...this.records.markerFrequencyDrafts };
		delete drafts[markerId];
		this.records.markerFrequencyDrafts = drafts;
		this.drawSweepSpectrum();
		if (this.records.selectedMarkerSetId) return { removed, saved: await this.saveMarkerSet() };
		this.candidateFilterChanged();
		return { removed, saved: null };
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
};
