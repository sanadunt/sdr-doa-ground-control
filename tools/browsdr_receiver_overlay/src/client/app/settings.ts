import type { AppInstance } from './types';
import { makeDefaultVfo } from './constants';
import { normalizeListenerDisplay } from './listener-display';

const SWEEP_SETTINGS_KEY = 'ReceiverSweepSettings';
const LNA_GAINS = [0, 8, 16, 24, 32, 40];
/** The Graph min./max. limits (the builder's SWEEP_DISPLAY_MAX_DB and updateSweepDisplayRange). */
const GRAPH_MIN_DB = -160;
const GRAPH_MAX_DB = 60;
const GRAPH_MIN_GAP_DB = 5;

function finiteIn(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

/**
 * Wide-scan settings survive a reload or a revisit of the Receiver page, the
 * Graph min./max. included (the console's Spektrum dock shares it). The scan
 * source is not stored: it follows the connected radio.
 */
export function restoreSweepSettings(sweep: Record<string, unknown>, raw: string | null): void {
	if (!raw) return;
	let stored: unknown;
	try {
		stored = JSON.parse(raw);
	} catch {
		return;
	}
	if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
	const value = stored as Record<string, unknown>;
	if (finiteIn(value.startMHz, 1, 7250) && finiteIn(value.endMHz, 1, 7250) && value.endMHz > value.startMHz) {
		sweep.startMHz = value.startMHz;
		sweep.endMHz = value.endMHz;
	}
	if (value.fftSize === 4096 || value.fftSize === 8192) sweep.fftSize = value.fftSize;
	if (typeof value.lnaGain === 'number' && LNA_GAINS.includes(value.lnaGain)) sweep.lnaGain = value.lnaGain;
	if (finiteIn(value.vgaGain, 0, 62) && value.vgaGain % 2 === 0) sweep.vgaGain = value.vgaGain;
	if (typeof value.ampEnabled === 'boolean') sweep.ampEnabled = value.ampEnabled;
	if (finiteIn(value.minSnrDb, 1, 60)) sweep.minSnrDb = value.minSnrDb;
	if (finiteIn(value.averageAlpha, 0.01, 1)) sweep.averageAlpha = value.averageAlpha;
	if (finiteIn(value.minimumPeakDb, -160, 0)) sweep.minimumPeakDb = value.minimumPeakDb;
	if (finiteIn(value.displayMinDb, GRAPH_MIN_DB, GRAPH_MAX_DB) && finiteIn(value.displayMaxDb, GRAPH_MIN_DB, GRAPH_MAX_DB)
		&& value.displayMaxDb - value.displayMinDb >= GRAPH_MIN_GAP_DB) {
		sweep.displayMinDb = value.displayMinDb;
		sweep.displayMaxDb = value.displayMaxDb;
	}
	if (typeof value.sortBy === 'string' && ['frequency', 'peak', 'snr', 'hits', 'lastSeen'].includes(value.sortBy)) sweep.sortBy = value.sortBy;
}

export function serializeSweepSettings(sweep: Record<string, unknown>): string {
	const { startMHz, endMHz, fftSize, lnaGain, vgaGain, ampEnabled, minSnrDb, averageAlpha, minimumPeakDb, sortBy, displayMinDb, displayMaxDb } = sweep;
	return JSON.stringify({ startMHz, endMHz, fftSize, lnaGain, vgaGain, ampEnabled, minSnrDb, averageAlpha, minimumPeakDb, sortBy, displayMinDb, displayMaxDb });
}

export const settingsMethods = {
	saveSweepSettings(this: AppInstance) {
		try {
			localStorage.setItem(SWEEP_SETTINGS_KEY, serializeSweepSettings(this.sweep));
		} catch {
			// Storage can be unavailable (private mode); settings then last for this visit only.
		}
	},
	loadSweepSettings(this: AppInstance) {
		try {
			restoreSweepSettings(this.sweep, localStorage.getItem(SWEEP_SETTINGS_KEY));
		} catch {
			// Storage can be unavailable; defaults stay in place.
		}
	},
	saveSetting(this: AppInstance) {
		const obj = {
			radio: this.radio,
			display: this.display,
			gains: this.gains,
			locks: this.locks,
			vfos: this.vfos,
			view: this.view,
			collapsedPanels: this.collapsedPanels,
			recentRemoteIds: this.recentRemoteIds,
		};
		try {
			localStorage.setItem("SDRSetting", JSON.stringify(obj));
		} catch {
			// Storage can be unavailable (private mode); settings then last for this visit only.
		}
	},
	loadSetting(this: AppInstance) {
		try {
			const json = localStorage.getItem('SDRSetting');
			if (json) {
				const setting = JSON.parse(json);
				if (setting.radio) {
					const iqCorrection = setting.radio.iqCorrection;
					Object.assign(this.radio, setting.radio);
					this.radio.iqCorrection = typeof iqCorrection === 'boolean' ? iqCorrection : true;
					// Migrate: enforce minimum fftSize (old saves may have used 2048)
					if (!this.radio.fftSize || this.radio.fftSize < 8192) {
						this.radio.fftSize = 65536;
					}
				}
				if (setting.display && typeof setting.display === 'object') Object.assign(this.display, setting.display);
				// Older saves have no auto flag (Auto then applies); a damaged range falls back to the default.
				normalizeListenerDisplay(this.display);
				if (setting.gains) Object.assign(this.gains, setting.gains);
				if (setting.locks) Object.assign(this.locks, setting.locks);
				// Handle new format (vfos array) or legacy format (audio/audio2)
				if (setting.vfos && Array.isArray(setting.vfos)) {
					this.vfos = setting.vfos.map((v: any) => ({ ...makeDefaultVfo(), ...v }));
				} else {
					if (setting.audio) {
						Object.assign(this.vfos[0], setting.audio, { enabled: false, displayFreq: this.formatFreq(setting.audio.freq || 100.0), focused: false });
					}
					if (setting.audio2) {
						const vfo2 = { ...makeDefaultVfo(), ...setting.audio2, enabled: false, displayFreq: this.formatFreq(setting.audio2.freq || 100.0), focused: false };
						this.vfos.push(vfo2);
					}
				}
				if (setting.activeVfoIndex !== undefined) this.activeVfoIndex = setting.activeVfoIndex;
				else if (setting.activeVfo) this.activeVfoIndex = setting.activeVfo - 1;
				if (setting.view) Object.assign(this.view, setting.view);
				if (setting.collapsedPanels && typeof setting.collapsedPanels === 'object') Object.assign(this.collapsedPanels, setting.collapsedPanels);
				if (setting.recentRemoteIds && Array.isArray(setting.recentRemoteIds)) this.recentRemoteIds = setting.recentRemoteIds;
			}
		} catch (e) { }
	},
	requestOrApplyChange(this: AppInstance, target: string, property: string, value: any) {
		if (this.remoteMode === 'client') {
			this._webrtc.sendCommand({ type: 'requestChange', target, property, value });
		} else {
			if (target === 'radio') {
				this.radio[property] = value;
			} else if (target === 'gains') {
				this.gains[property] = value;
			}
		}
	},
};
