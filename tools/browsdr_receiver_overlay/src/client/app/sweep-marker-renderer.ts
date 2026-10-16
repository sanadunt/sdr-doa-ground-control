import type { ReceiverMarker } from './receiver-records-api';

let translateCanvasText: (text: string) => string = text => text;

/** Text drawn on the Spectrum and waterfall canvases follows the Receiver language. */
export function setSweepCanvasTranslator(translate: (text: string) => string): void {
	translateCanvasText = translate;
}

export function sweepCanvasText(text: string): string {
	return translateCanvasText(text);
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


/** A marker label box: 14 px tall, label rows 16 px apart, 4 px kept clear beside a label. */
export const MARKER_LABEL_HEIGHT_PX = 14;
export const MARKER_LABEL_ROW_PX = 16;
const MARKER_LABEL_GAP_PX = 4;
/** Places a label may take: its own row and the next ones, before it is left out (its line stays). */
export const MARKER_LABEL_MAX_ROWS = 4;

export interface MarkerLabelBox {
	x: number;
	width: number;
	/** The label's own top edge, before any collision. */
	y: number;
}

export interface MarkerLabelLayout {
	/** The way a label moves when its own place is taken: 1 down, -1 up (the default). */
	direction?: 1 | -1;
	/** The highest top edge a label may take (default: the plot top). */
	minY?: number;
}

/** The rows a label may take: its own (inside the bounds), then rows in `direction`, then the other way where the bound stops them. */
function labelRows(ownY: number, minY: number, maxY: number, direction: 1 | -1): number[] {
	const start = Math.max(minY, Math.min(maxY, ownY));
	const rows = [start];
	for (const way of [direction, -direction]) {
		for (let step = 1; rows.length < MARKER_LABEL_MAX_ROWS; step++) {
			const y = start + way * step * MARKER_LABEL_ROW_PX;
			if (y < minY || y > maxY) break;
			rows.push(y);
		}
	}
	return rows;
}

/**
 * Tops for marker labels so that no two overlap, placed from left to right: a label keeps
 * its own place when it is free, else takes the nearest free row in `direction` (the other
 * way only where a bound stops it), inside [minY, maxY]; a label with no free row among its
 * MARKER_LABEL_MAX_ROWS is left out (null). Only labels that still reach the current x are
 * compared, so a long list stays linear.
 */
export function placeMarkerLabels(boxes: MarkerLabelBox[], minY: number, maxY: number, direction: 1 | -1 = -1): (number | null)[] {
	const tops: (number | null)[] = boxes.map(() => null);
	const order = boxes.map((_, index) => index).filter(index => Number.isFinite(boxes[index].x) && Number.isFinite(boxes[index].y))
		.sort((a, b) => boxes[a].x - boxes[b].x);
	const lowest = Math.max(minY, maxY);
	let active: { right: number; y: number }[] = [];
	for (const index of order) {
		const box = boxes[index];
		active = active.filter(placed => placed.right + MARKER_LABEL_GAP_PX > box.x);
		const y = labelRows(box.y, minY, lowest, direction)
			.find(row => !active.some(placed => Math.abs(placed.y - row) < MARKER_LABEL_HEIGHT_PX));
		if (y === undefined) continue;
		tops[index] = y;
		active.push({ right: box.x + box.width, y });
	}
	return tops;
}

export function drawSweepMarkerOverlay(
	context: CanvasRenderingContext2D,
	markers: ReceiverMarker[],
	plot: SweepMarkerPlot,
	labelY: (marker: ReceiverMarker, index: number) => number,
	layout: MarkerLabelLayout = {},
): void {
	const span = plot.endHz - plot.startHz;
	if (!Number.isFinite(span) || span <= 0 || markers.length === 0) return;
	context.save();
	context.beginPath();
	context.rect(plot.left, plot.top, plot.width, plot.height);
	context.clip();
	context.font = '10px "Roboto Mono", monospace';
	context.textBaseline = 'top';
	// Every line first, then the labels over them, moved or left out where they would overlap.
	const labels: { text: string; box: MarkerLabelBox }[] = [];
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
		const text = `${marker.label.trim() || `M${index + 1}`} ${(marker.frequencyHz / 1_000_000).toFixed(3)} MHz`;
		const width = context.measureText(text).width + 8;
		labels.push({ text, box: { x: Math.max(plot.left, Math.min(plot.left + plot.width - width, x + 3)), width, y: labelY(marker, index) } });
	}
	const tops = placeMarkerLabels(labels.map(label => label.box), layout.minY ?? plot.top,
		plot.top + plot.height - MARKER_LABEL_HEIGHT_PX - 1, layout.direction ?? -1);
	for (let index = 0; index < labels.length; index++) {
		const y = tops[index];
		if (y === null) continue;
		const { text, box } = labels[index];
		context.fillStyle = 'rgba(55, 23, 37, 0.9)';
		context.fillRect(box.x, y, box.width, MARKER_LABEL_HEIGHT_PX);
		context.fillStyle = '#ffd3e0';
		context.fillText(text, box.x + 4, y + 2);
	}
	context.restore();
}
