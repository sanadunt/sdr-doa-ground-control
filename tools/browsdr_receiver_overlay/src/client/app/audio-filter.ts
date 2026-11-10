/**
 * The voice filter on what the Receiver plays (docs/superpowers/specs/2026-11-10-radio-audio-filter-design.md).
 *
 * The Receiver plays every VFO's audio through app.gainNode in its own 48 kHz AudioContext
 * (vendor ui-helpers.ts _initAudioCtx). The builder replaces that function's
 * `gainNode.connect(destination)` with attachAudioFilter(), which puts a FilterInsert
 * (radioAudioFilter.ts, the console's own file, copied in by the builder) between the two:
 * Off joins gainNode to the speaker directly, as before; any other preset runs the chain.
 *
 * Only what the speaker gets passes through it. The worker's audio reaches the console bridge
 * (the Receiver mirror's tablets), the VFO recorder and Whisper on their own paths, unfiltered.
 *
 * The settings (app.audioFilter) are saved with the Receiver's settings (SDRSetting) and set on
 * the Dengar tab or by the console's Spektrum dock (console:audio-filter). The state and the
 * last load error (app.audioFilterState, app.audioFilterError) go to the page and receiver:status.
 */
import type { AppInstance } from './types';
import {
	DEFAULT_FILTER_SETTINGS,
	FilterInsert,
	filterBypassed,
	presetSettings,
	validFilterSettings,
	withControls,
} from './radioAudioFilter';
import type { FilterControls, FilterErrorCode, FilterSettings, FilterState, NamedPreset } from './radioAudioFilter';

/** English keys of i18n.ts (RECEIVER_INDONESIAN has the Indonesian). */
const PRESET_LABELS: Record<NamedPreset, string> = { off: 'Off', light: 'Light', standard: 'Standard', strong: 'Strong' };
const STATE_LABELS: Record<FilterState, string> = { off: 'Off', loading: 'Loading AI…', ai: 'AI active', error: 'AI failed', on: 'Active' };
const ERROR_TEXTS: Record<FilterErrorCode, string> = {
	SAMPLE_RATE: 'The AI noise suppressor needs 48 kHz audio (the browser uses {0} Hz).',
	DENOISE_LOAD: 'Could not load the noise suppressor: {0}',
	GATE_LOAD: 'Could not load the noise gate: {0}',
	WORKLET_UNSUPPORTED: 'This browser has no AudioWorklet, so the AI noise suppressor and the gate stay off.',
};

/** A restored setting made usable: anything missing or invalid is the default (Standard). */
export function restoreAudioFilter(raw: unknown): FilterSettings {
	return validFilterSettings(raw) ?? { ...DEFAULT_FILTER_SETTINGS };
}

/** The state shown while no AudioContext exists yet (nothing has played since the page loaded). */
export function idleFilterState(settings: FilterSettings): FilterState {
	return filterBypassed(settings) ? 'off' : 'on';
}

export const audioFilterMethods = {
	/** Called by _initAudioCtx in place of gainNode.connect(destination). */
	attachAudioFilter(this: AppInstance) {
		if (!this.audioCtx || !this.gainNode) return;
		const current = this._audioFilterInsert as FilterInsert | null | undefined;
		if (current) current.destroy();
		const insert = new FilterInsert(this.gainNode, this.audioCtx.destination, restoreAudioFilter(this.audioFilter));
		insert.onStatus = (state, status) => {
			if (this._audioFilterInsert !== insert) return;
			this.audioFilterState = state;
			this.audioFilterError = status.error ? { code: status.error.code, detail: status.error.detail } : null;
		};
		// A property outside data() is not reactive.
		this._audioFilterInsert = insert;
		this.audioFilterState = insert.state();
		this.audioFilterError = null;
	},
	/** Before the AudioContext closes (connection.ts): frees the worklets. */
	detachAudioFilter(this: AppInstance) {
		const current = this._audioFilterInsert as FilterInsert | null | undefined;
		current?.destroy();
		this._audioFilterInsert = null;
		this.audioFilterState = idleFilterState(restoreAudioFilter(this.audioFilter));
		this.audioFilterError = null;
	},
	/** The audioFilter watcher (main.ts): applies the settings to the playing chain. */
	applyAudioFilter(this: AppInstance) {
		const settings = restoreAudioFilter(this.audioFilter);
		const insert = this._audioFilterInsert as FilterInsert | null | undefined;
		if (insert) {
			insert.apply(settings);
			this.audioFilterState = insert.state();
		} else {
			this.audioFilterState = idleFilterState(settings);
			this.audioFilterError = null;
		}
	},
	/** A preset chip on the Dengar tab; inside the click, so a held AudioContext can resume. */
	setAudioFilterPreset(this: AppInstance, name: NamedPreset) {
		this.audioFilter = presetSettings(name);
		this.resumeAudioForFilter();
	},
	/** A custom control on the Dengar tab: the preset becomes custom. */
	setAudioFilterControl(this: AppInstance, patch: Partial<FilterControls>) {
		this.audioFilter = withControls(restoreAudioFilter(this.audioFilter), patch);
		this.resumeAudioForFilter();
	},
	audioFilterPresetLabel(this: AppInstance, name: NamedPreset): string {
		return PRESET_LABELS[name];
	},
	/** The panel title's state: off, loading AI, AI active, AI failed (or another load failure), active. */
	audioFilterStateLabel(this: AppInstance): string {
		const state = this.audioFilterState as FilterState;
		if (state === 'error') {
			const code = this.audioFilterError?.code;
			return this.t(code === 'GATE_LOAD' ? 'Load failed' : 'AI failed');
		}
		return this.t(STATE_LABELS[state] ?? 'Active');
	},
	audioFilterErrorText(this: AppInstance): string {
		const error = this.audioFilterError as { code: FilterErrorCode; detail: string } | null;
		if (!error) return '';
		return this.t(ERROR_TEXTS[error.code]).replace('{0}', error.detail);
	},
	resumeAudioForFilter(this: AppInstance) {
		if (this.audioCtx?.state === 'suspended') this.audioCtx.resume().catch(() => {});
	},
};
