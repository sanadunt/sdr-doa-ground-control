/**
 * The Receiver's spectrum markers (the "Penanda spektrum" list) on the
 * Listener's (Dengar tab) trace, in the span it shows. Markers are stored in
 * device Hz, the Listener's axis is displayed Hz (Freq Shift included), so
 * they are drawn at frequencyHz + shift, with the label and colours of the
 * Spektrum canvas. Display only: a click on the Listener still tunes the VFO.
 * The console's Spektrum dock shows the same list (console-bridge.ts).
 *
 * The shifted list is rebuilt when the markers or the shift change, not for
 * every FFT frame, and kept outside Vue's reactive state.
 */
import type { AppInstance } from './types';
import type { ReceiverMarker } from './receiver-records-api';
import { drawSweepMarkerOverlay } from './sweep-marker-renderer';

/** Label rows above the bottom edge; neighbours in the list alternate between them. */
const LABEL_ROW_PX = 16;

/** The markers in displayed Hz, in the Receiver's list order (its M1, M2 … names follow that order). */
export function listenerMarkers(markers: unknown, frequencyShiftMhz: unknown): ReceiverMarker[] {
	if (!Array.isArray(markers)) return [];
	const shiftMhz = typeof frequencyShiftMhz === 'number' && Number.isFinite(frequencyShiftMhz) ? frequencyShiftMhz : 0;
	const shiftHz = shiftMhz * 1e6;
	return markers.map((marker: Partial<ReceiverMarker> | null) => ({
		id: String(marker?.id ?? ''),
		frequencyHz: typeof marker?.frequencyHz === 'number' ? marker.frequencyHz + shiftHz : Number.NaN,
		powerDb: typeof marker?.powerDb === 'number' ? marker.powerDb : null,
		label: typeof marker?.label === 'string' ? marker.label : '',
	}));
}

export const listenerMarkerMethods = {
	/** A changed marker list or Freq Shift: kept for drawSpectrum, and a stopped Listener's last trace is drawn again. */
	refreshListenerMarkers(this: AppInstance): void {
		this._listenerMarkers = listenerMarkers(this.records?.markers, this.radio?.frequencyShift);
		// A running Listener draws them with its next frame.
		if (this.running || !this._lastSpectrumData || !this._fftCtx || typeof this.drawSpectrum !== 'function') return;
		this._zoomRepaint = true;
		try {
			this.drawSpectrum(this._lastSpectrumData);
		} finally {
			this._zoomRepaint = false;
		}
	},

	/** Draws the markers inside the Listener's visible span; called at the end of drawSpectrum (canvas.ts, patched by the builder). */
	drawListenerMarkers(this: AppInstance, context: CanvasRenderingContext2D, width: number, height: number): void {
		const markers: ReceiverMarker[] = this._listenerMarkers ?? [];
		if (!markers.length || !(width > 0) || !(height > 0)) return;
		const startHz = Number(this.minFreq) * 1e6;
		const endHz = Number(this.maxFreq) * 1e6;
		drawSweepMarkerOverlay(context, markers, { startHz, endHz, left: 0, top: 0, width, height },
			(_marker, index) => height - LABEL_ROW_PX - (index % 2) * LABEL_ROW_PX);
	},
};
