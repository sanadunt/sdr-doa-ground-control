import type { SweepSpectrumFrame, SweepSpectrumView } from '../worker/sweep-types';
import type { ReceiverMarker } from './receiver-records-api';

// Eight hues that stay distinct from each other and from the spectrum trace
// gradient in both themes. Marker N uses MARKER_COLORS[(N - 1) % 8].
const MARKER_COLORS_DARK = ['#f472b6', '#38bdf8', '#a3e635', '#fbbf24', '#c084fc', '#2dd4bf', '#fb923c', '#e2e8f0'] as const;
const MARKER_COLORS_LIGHT = ['#be185d', '#0369a1', '#4d7c0f', '#a16207', '#7e22ce', '#0f766e', '#c2410c', '#334155'] as const;

export function markerColor(index: number, lightTheme = false): string {
	const palette = lightTheme ? MARKER_COLORS_LIGHT : MARKER_COLORS_DARK;
	return palette[((index % palette.length) + palette.length) % palette.length];
}

export function markerName(index: number): string {
	return `M${index + 1}`;
}

export function traceValues(frame: SweepSpectrumFrame, view: SweepSpectrumView): Float32Array {
	return view === 'current' ? frame.current : view === 'max' ? frame.maxHold : frame.average;
}

/** Trace level at a frequency, or null outside the scanned band or for a non-finite bin. */
export function traceLevelAt(values: ArrayLike<number>, startHz: number, endHz: number, frequencyHz: number): number | null {
	const span = endHz - startHz;
	if (!values.length || !Number.isFinite(frequencyHz) || !(span > 0) || frequencyHz < startHz || frequencyHz > endHz) return null;
	const index = Math.min(values.length - 1, Math.floor((frequencyHz - startHz) / span * values.length));
	const value = values[index];
	return Number.isFinite(value) ? value : null;
}

/** Strongest finite bin inside [startHz, endHz], reported at its bin centre. */
export function peakInRange(values: ArrayLike<number>, frameStartHz: number, frameEndHz: number, startHz: number, endHz: number): { frequencyHz: number; powerDb: number } | null {
	const span = frameEndHz - frameStartHz;
	if (!values.length || !(span > 0)) return null;
	const binWidth = span / values.length;
	const first = Math.max(0, Math.floor((Math.max(startHz, frameStartHz) - frameStartHz) / binWidth));
	const last = Math.min(values.length - 1, Math.ceil((Math.min(endHz, frameEndHz) - frameStartHz) / binWidth) - 1);
	let best = -1;
	for (let index = first; index <= last; index++) {
		if (Number.isFinite(values[index]) && (best < 0 || values[index] > values[best])) best = index;
	}
	if (best < 0) return null;
	return { frequencyHz: frameStartHz + (best + 0.5) * binWidth, powerDb: values[best] };
}

export function nearestMarkerWithin(markers: ReceiverMarker[], frequencyHz: number, toleranceHz: number): ReceiverMarker | null {
	let nearest: ReceiverMarker | null = null;
	let nearestDistance = Infinity;
	for (const marker of markers) {
		const distance = Math.abs(marker.frequencyHz - frequencyHz);
		if (distance <= toleranceHz && distance < nearestDistance) {
			nearest = marker;
			nearestDistance = distance;
		}
	}
	return nearest;
}

export interface MarkerReadoutRow {
	id: string;
	index: number;
	name: string;
	label: string;
	frequencyHz: number;
	liveDb: number | null;
	savedDb: number | null;
	isReference: boolean;
	deltaHz: number | null;
	deltaDb: number | null;
}

/**
 * One row per marker in list order. Deltas are measured against the reference
 * marker (the first marker unless another id is given) using live levels.
 */
export function buildMarkerReadout(markers: ReceiverMarker[], frame: SweepSpectrumFrame | null, view: SweepSpectrumView, referenceId: string | null): MarkerReadoutRow[] {
	const values = frame ? traceValues(frame, view) : null;
	const live = (frequencyHz: number) => (frame && values ? traceLevelAt(values, frame.startHz, frame.endHz, frequencyHz) : null);
	const reference = markers.find(marker => marker.id === referenceId) ?? markers[0] ?? null;
	const referenceDb = reference ? live(reference.frequencyHz) : null;
	return markers.map((marker, index) => {
		const liveDb = live(marker.frequencyHz);
		const isReference = reference !== null && marker.id === reference.id;
		return {
			id: marker.id,
			index,
			name: markerName(index),
			label: marker.label,
			frequencyHz: marker.frequencyHz,
			liveDb,
			savedDb: marker.powerDb,
			isReference,
			deltaHz: reference && !isReference ? marker.frequencyHz - reference.frequencyHz : null,
			deltaDb: !isReference && liveDb !== null && referenceDb !== null ? liveDb - referenceDb : null,
		};
	});
}

/**
 * Greedy lane assignment for horizontal labels sorted by x. Returns the lane per
 * input item, or -1 when every lane would overlap (the caller shows a badge only).
 */
export function assignLabelLanes(items: Array<{ x: number; width: number }>, laneCount: number, gap = 4): number[] {
	const laneEnds = Array.from({ length: laneCount }, () => -Infinity);
	const order = items.map((item, index) => ({ ...item, index })).sort((a, b) => a.x - b.x);
	const lanes = new Array<number>(items.length).fill(-1);
	for (const item of order) {
		const lane = laneEnds.findIndex(end => item.x >= end + gap);
		if (lane < 0) continue;
		lanes[item.index] = lane;
		laneEnds[lane] = item.x + item.width;
	}
	return lanes;
}

/** Editable MHz text for a marker frequency, at 1 Hz resolution. */
export function frequencyDraftMHz(frequencyHz: number): string {
	return (frequencyHz / 1_000_000).toFixed(6);
}

export function formatMarkerFrequency(frequencyHz: number): string {
	return `${(frequencyHz / 1_000_000).toFixed(6)} MHz`;
}

export function formatDeltaFrequency(deltaHz: number): string {
	const sign = deltaHz > 0 ? '+' : deltaHz < 0 ? '−' : '±';
	const magnitude = Math.abs(deltaHz);
	if (magnitude >= 1_000_000) return `${sign}${(magnitude / 1_000_000).toFixed(6)} MHz`;
	if (magnitude >= 1_000) return `${sign}${(magnitude / 1_000).toFixed(3)} kHz`;
	return `${sign}${magnitude.toFixed(0)} Hz`;
}

export function formatDeltaDb(deltaDb: number): string {
	const sign = deltaDb > 0 ? '+' : deltaDb < 0 ? '−' : '±';
	return `${sign}${Math.abs(deltaDb).toFixed(1)} dB`;
}
