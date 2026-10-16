/**
 * The device frequency each Listener FFT frame was taken at. The main thread
 * moves the centre at once, but sends setFrequency only after a 200 ms
 * debounce, so a frame stamped there with the Vue centre would draw old data
 * on the new axis. The worker stamps each frame with what the radio was
 * actually tuned to instead: null while a retune is under way, and for the
 * first SPECTRUM_SETTLE_FRAMES frames after it, whose input and smoothing
 * (EMA 0.6 per frame, rx-stream.ts) still carry the previous tuning.
 */

/** Frames after a retune before one is attributed again: 0.4^3, about 6 % of the old spectrum, remains. */
export const SPECTRUM_SETTLE_FRAMES = 3;

export interface SpectrumTuning {
	/** A setFrequency to the device starts; call the returned function with the device Hz it reached, or null when it failed. */
	retune(): (appliedHz: number | null) => void;
	/** The device Hz of the frame produced now, or null when it belongs to no one tuning. */
	frameStamp(): number | null;
}

export function createSpectrumTuning(startHz: number, settleFrames: number = SPECTRUM_SETTLE_FRAMES): SpectrumTuning {
	// The frequency the radio last reached, and the stamp: null while any retune is under way.
	let lastHz: number | null = Number.isFinite(startHz) ? startHz : null;
	let tunedHz = lastHz;
	let inFlight = 0;
	let moved = false;
	let settle = 0;
	return {
		retune() {
			inFlight++;
			tunedHz = null;
			let finished = false;
			return (appliedHz: number | null) => {
				if (finished) return;
				finished = true;
				inFlight--;
				// A failed control transfer leaves the radio where it was.
				if (appliedHz !== null && Number.isFinite(appliedHz)) {
					lastHz = appliedHz;
					moved = true;
				}
				if (inFlight > 0) return;
				tunedHz = lastHz;
				if (moved) settle = settleFrames;
				moved = false;
			};
		},
		frameStamp() {
			if (tunedHz === null) return null;
			if (settle > 0) {
				settle--;
				return null;
			}
			return tunedHz;
		},
	};
}
