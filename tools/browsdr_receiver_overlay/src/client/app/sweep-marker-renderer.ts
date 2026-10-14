import type { ReceiverMarker } from './receiver-records-api';

let translateCanvasText: (text: string) => string = text => text;

/** Text drawn on the Spectrum and waterfall canvases follows the Receiver language. */
export function setSweepCanvasTranslator(translate: (text: string) => string): void {
	translateCanvasText = translate;
}

export function sweepCanvasText(text: string): string {
	return translateCanvasText(text);
}

export function sweepMarkerHint(): string {
	const coarsePointer = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
		&& window.matchMedia('(pointer: coarse)').matches;
	return sweepCanvasText(coarsePointer ? 'Hold to add marker' : 'Click: add marker · drag: pan · wheel: zoom');
}

export function drawSweepMarkerHint(context: CanvasRenderingContext2D, left: number, width: number, reservedWidth: number): void {
	const hint = sweepMarkerHint();
	if (reservedWidth + 16 + context.measureText(hint).width > width) return;
	const textAlign = context.textAlign;
	context.textAlign = 'right';
	context.fillText(hint, left + width, 1);
	context.textAlign = textAlign;
}

export interface SweepMarkerPlot {
	startHz: number;
	endHz: number;
	left: number;
	top: number;
	width: number;
	height: number;
}
export function sweepMarkerPositionRatio(frequencyHz: number, startHz: number, endHz: number): number | null {
	const span = endHz - startHz;
	if (!Number.isFinite(frequencyHz) || !Number.isFinite(startHz) || !Number.isFinite(endHz)
		|| span <= 0 || frequencyHz < startHz || frequencyHz > endHz) return null;
	return (frequencyHz - startHz) / span;
}


export function drawSweepMarkerOverlay(
	context: CanvasRenderingContext2D,
	markers: ReceiverMarker[],
	plot: SweepMarkerPlot,
	labelY: (marker: ReceiverMarker, index: number) => number,
): void {
	const span = plot.endHz - plot.startHz;
	if (!Number.isFinite(span) || span <= 0 || markers.length === 0) return;
	context.save();
	context.beginPath();
	context.rect(plot.left, plot.top, plot.width, plot.height);
	context.clip();
	context.font = '10px "Roboto Mono", monospace';
	context.textBaseline = 'top';
	for (let index = 0; index < markers.length; index++) {
		const marker = markers[index];
		const position = sweepMarkerPositionRatio(marker.frequencyHz, plot.startHz, plot.endHz);
		if (position === null) continue;
		const x = plot.left + position * plot.width;
		context.strokeStyle = '#ff75a0';
		context.lineWidth = 1.2;
		context.beginPath();
		context.moveTo(x, plot.top);
		context.lineTo(x, plot.top + plot.height);
		context.stroke();
		const label = `${marker.label.trim() || `M${index + 1}`} ${(marker.frequencyHz / 1_000_000).toFixed(3)} MHz`;
		const labelWidth = context.measureText(label).width + 8;
		const labelX = Math.max(plot.left, Math.min(plot.left + plot.width - labelWidth, x + 3));
		const y = Math.max(plot.top, Math.min(plot.top + plot.height - 15, labelY(marker, index)));
		context.fillStyle = 'rgba(55, 23, 37, 0.9)';
		context.fillRect(labelX, y, labelWidth, 14);
		context.fillStyle = '#ffd3e0';
		context.fillText(label, labelX + 4, y + 2);
	}
	context.restore();
}
