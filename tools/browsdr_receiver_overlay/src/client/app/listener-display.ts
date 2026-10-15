/**
 * dB scale of the Listener's spectrum trace and waterfall (the Dengar tab's
 * "dB scale"): Auto fits the visible part of the spectrum, Manual draws
 * display.minDB to display.maxDB. display.auto, minDB and maxDB are saved with
 * the Receiver's settings (SDRSetting), and the console's Spektrum dock mirrors
 * them through the bridge (receiver:status display, console:display).
 *
 * The automatic range moves with the signal, so it stays outside Vue's
 * reactive state (a property that is not in data()): writing it to display
 * would re-render the page and save the settings many times a second.
 */
import type { AppInstance } from './types';
import { DISPLAY_DB_LIMITS, clampDisplayRange } from './console-bridge-protocol';

/** The upstream Listener range (state.ts), used for a missing or invalid saved one. */
export const LISTENER_DB_DEFAULT = { minDb: -70, maxDb: 0 } as const;
/** The automatic range is recomputed at most this often. */
export const LISTENER_AUTO_INTERVAL_MS = 100;
/** How far each update moves the automatic range towards the new frame (the console dock uses the same). */
export const LISTENER_AUTO_SMOOTHING = 0.2;
/** The waterfall rebuilds its colour table only when the range moved at least this far. */
export const LISTENER_ENGINE_STEP_DB = 0.5;
/** Bins sampled for the noise floor; the peak looks at every visible bin. */
const FLOOR_SAMPLES = 4096;

export interface DbSpan {
	min: number;
	max: number;
}

/**
 * Restored or missing display settings made usable in place: auto a boolean
 * (on unless saved off), and a manual range inside DISPLAY_DB_LIMITS.
 */
export function normalizeListenerDisplay(display: Record<string, unknown>): void {
	const range = clampDisplayRange(display.minDB, display.maxDB) ?? LISTENER_DB_DEFAULT;
	if (display.minDB !== range.minDb) display.minDB = range.minDb;
	if (display.maxDB !== range.maxDb) display.maxDB = range.maxDb;
	const auto = display.auto !== false;
	if (display.auto !== auto) display.auto = auto;
}

/**
 * Automatic range of the bins from `first` to `first + count`: the noise
 * floor (20th percentile) − 5 dB to the peak + 5 dB, at least 20 dB tall, the
 * same rule as the console dock. With a previous range the result moves only
 * `smoothing` of the way, so the trace does not jump.
 */
export function autoListenerRange(
	data: ArrayLike<number>,
	first: number,
	count: number,
	previous: DbSpan | null,
	smoothing: number = LISTENER_AUTO_SMOOTHING,
): DbSpan | null {
	const start = Math.max(0, Math.floor(Number.isFinite(first) ? first : 0));
	const end = Math.min(data.length, start + Math.max(0, Math.floor(Number.isFinite(count) ? count : 0)));
	if (end <= start) return previous;
	const stride = Math.max(1, Math.floor((end - start) / FLOOR_SAMPLES));
	const sample: number[] = [];
	let peak = -Infinity;
	for (let index = start; index < end; index++) {
		const value = data[index];
		if (!Number.isFinite(value)) continue;
		if (value > peak) peak = value;
		if ((index - start) % stride === 0) sample.push(value);
	}
	if (!sample.length) return previous;
	sample.sort((a, b) => a - b);
	let min = sample[Math.floor(0.2 * (sample.length - 1))] - 5;
	let max = peak + 5;
	if (max - min < 20) {
		const middle = (max + min) / 2;
		min = middle - 10;
		max = middle + 10;
	}
	if (!previous || !Number.isFinite(previous.min) || !Number.isFinite(previous.max)) return { min, max };
	const weight = Math.min(1, Math.max(0, smoothing));
	return { min: previous.min + (min - previous.min) * weight, max: previous.max + (max - previous.max) * weight };
}

/**
 * A typed limit kept valid against the other one, as the scan's graph limits
 * are: the edited value moves, the other stays where it can. A value that is
 * not a number falls back to the default for that limit.
 */
export function keepListenerRange(minDb: unknown, maxDb: unknown, changed: 'min' | 'max'): { minDb: number; maxDb: number } {
	const { minDb: floor, maxDb: ceiling, minGapDb: gap } = DISPLAY_DB_LIMITS;
	const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
	const round = (value: number) => Math.round(value * 10) / 10;
	const min = typeof minDb === 'number' && Number.isFinite(minDb) ? round(minDb) : LISTENER_DB_DEFAULT.minDb;
	const max = typeof maxDb === 'number' && Number.isFinite(maxDb) ? round(maxDb) : LISTENER_DB_DEFAULT.maxDb;
	if (changed === 'min') {
		const keptMax = clamp(max, floor + gap, ceiling);
		return { minDb: round(clamp(min, floor, keptMax - gap)), maxDb: keptMax };
	}
	const keptMin = clamp(min, floor, ceiling - gap);
	return { minDb: keptMin, maxDb: round(clamp(max, keptMin + gap, ceiling)) };
}

export const listenerDisplayMethods = {
	/** The range the Listener draws with: the automatic one once Auto has seen a frame, otherwise the manual one. */
	listenerDbRange(this: AppInstance): DbSpan {
		const auto: DbSpan | null = this._listenerAutoDb ?? null;
		if (this.display.auto !== false && auto) return auto;
		return { min: Number(this.display.minDB), max: Number(this.display.maxDB) };
	},

	/** Called with every Listener FFT frame before it is drawn. */
	updateListenerAutoRange(this: AppInstance, data: ArrayLike<number>): void {
		if (this.display.auto === false || !data || !data.length) return;
		const now = performance.now();
		const last: number | undefined = this._listenerAutoAt;
		if (last !== undefined && now - last < LISTENER_AUTO_INTERVAL_MS) return;
		this._listenerAutoAt = now;
		// Only the zoomed part the trace shows.
		const scale = Number(this.view?.zoomScale) > 0 ? Number(this.view.zoomScale) : 1;
		const offset = Number.isFinite(Number(this.view?.zoomOffset)) ? Number(this.view.zoomOffset) : 0;
		const previous: DbSpan | null = this._listenerAutoDb ?? { min: Number(this.display.minDB), max: Number(this.display.maxDB) };
		this._listenerAutoDb = autoListenerRange(data, data.length * offset, data.length / scale, previous);
		this.syncListenerEngineRange(false);
	},

	/** Gives the waterfall the range in use; `force` after a new engine or a changed setting. */
	syncListenerEngineRange(this: AppInstance, force: boolean): void {
		const engine = this._waterfallEngine;
		if (!engine || typeof engine.setRange !== 'function') return;
		const range: DbSpan = this.listenerDbRange();
		const last: DbSpan | null = this._listenerEngineRange ?? null;
		if (!force && last && Math.abs(last.min - range.min) < LISTENER_ENGINE_STEP_DB && Math.abs(last.max - range.max) < LISTENER_ENGINE_STEP_DB) return;
		engine.setRange(range.min, range.max);
		this._listenerEngineRange = { min: range.min, max: range.max };
	},

	/** A changed dB scale (Dengar tab or console): the waterfall takes the new range and the last trace is drawn again. */
	applyListenerDisplay(this: AppInstance): void {
		normalizeListenerDisplay(this.display);
		const auto = this.display.auto !== false;
		if (auto && this._listenerAppliedAuto === false) {
			// Auto starts again from the manual range, so the switch does not jump.
			this._listenerAutoDb = null;
			this._listenerAutoAt = undefined;
		}
		this._listenerAppliedAuto = auto;
		this.syncListenerEngineRange(true);
		if (this._lastSpectrumData && this._fftCtx && typeof this.drawSpectrum === 'function') {
			this._zoomRepaint = true;
			try {
				this.drawSpectrum(this._lastSpectrumData);
			} finally {
				this._zoomRepaint = false;
			}
		}
	},

	/** Auto or Manual from the Dengar tab. Manual starts from the range drawn now, so the picture stays put. */
	setListenerDbAuto(this: AppInstance, auto: boolean): void {
		if (auto) {
			this.display.auto = true;
			return;
		}
		if (this.display.auto === false) return;
		const drawn: DbSpan | null = this._listenerAutoDb ?? null;
		const range = drawn ? clampDisplayRange(Math.round(drawn.min), Math.round(drawn.max)) : null;
		if (range) {
			this.display.minDB = range.minDb;
			this.display.maxDB = range.maxDb;
		}
		this.display.auto = false;
	},

	/** A typed limit, committed on change (Enter or leaving the field). */
	commitListenerDbRange(this: AppInstance, changed: 'min' | 'max', event: Event): void {
		const target = event.target as HTMLInputElement | null;
		const typed = target ? target.valueAsNumber : Number.NaN;
		// An emptied field keeps the value it had.
		const value = Number.isFinite(typed) ? typed : Number(changed === 'min' ? this.display.minDB : this.display.maxDB);
		const minDb = changed === 'min' ? value : Number(this.display.minDB);
		const maxDb = changed === 'max' ? value : Number(this.display.maxDB);
		const next = keepListenerRange(minDb, maxDb, changed);
		this.display.minDB = next.minDb;
		this.display.maxDB = next.maxDb;
		// A clamped value the model already holds still has to replace what was typed.
		if (target) target.value = String(changed === 'min' ? next.minDb : next.maxDb);
	},
};
