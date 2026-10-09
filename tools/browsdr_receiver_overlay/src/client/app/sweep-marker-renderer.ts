import type { ReceiverMarker } from './receiver-records-api';
import { assignLabelLanes, markerColor, markerName } from './marker-readout';

export interface SweepMarkerPlot {
	startHz: number;
	endHz: number;
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface SweepMarkerStyle {
	lightTheme: boolean;
	selectedMarkerId: string | null;
	yForDb: (db: number) => number;
	/** Live trace level at a frequency, or null when the trace has no value there. */
	levelAt: (frequencyHz: number) => number | null;
	font: string;
}

const LABEL_LANES = 3;
const LANE_HEIGHT = 17;
const DEFAULT_LABEL = /^Marker \d+$/;

export function sweepMarkerPositionRatio(frequencyHz: number, startHz: number, endHz: number): number | null {
	const span = endHz - startHz;
	if (!Number.isFinite(frequencyHz) || !Number.isFinite(startHz) || !Number.isFinite(endHz)
		|| span <= 0 || frequencyHz < startHz || frequencyHz > endHz) return null;
	return (frequencyHz - startHz) / span;
}

function markerChipText(marker: ReceiverMarker, index: number): string {
	const label = marker.label.trim();
	const frequency = (marker.frequencyHz / 1_000_000).toFixed(6);
	return label && !DEFAULT_LABEL.test(label) ? `${markerName(index)} ${label} · ${frequency}` : `${markerName(index)} ${frequency}`;
}

/**
 * Markers are numbered and coloured by list position. Labels sit in up to three
 * lanes along the top of the plot; a label that cannot fit collapses to its
 * marker number so neighbouring markers never print over each other.
 */
export function drawSweepMarkerOverlay(context: CanvasRenderingContext2D, markers: ReceiverMarker[], plot: SweepMarkerPlot, style: SweepMarkerStyle): void {
	const span = plot.endHz - plot.startHz;
	if (!Number.isFinite(span) || span <= 0 || markers.length === 0) return;
	context.save();
	context.beginPath();
	context.rect(plot.left, plot.top, plot.width, plot.height);
	context.clip();
	context.font = style.font;
	context.textBaseline = 'middle';

	const visible = markers
		.map((marker, index) => ({ marker, index, ratio: sweepMarkerPositionRatio(marker.frequencyHz, plot.startHz, plot.endHz) }))
		.filter((item): item is { marker: ReceiverMarker; index: number; ratio: number } => item.ratio !== null)
		.map(item => {
			const x = plot.left + item.ratio * plot.width;
			const text = markerChipText(item.marker, item.index);
			const width = context.measureText(text).width + 12;
			const flipLeft = x + 4 + width > plot.left + plot.width;
			return { ...item, x, text, width, chipX: flipLeft ? x - 4 - width : x + 4 };
		});
	const lanes = assignLabelLanes(visible.map(item => ({ x: item.chipX, width: item.width })), LABEL_LANES);

	// Draw the selected marker last so it stays on top of its neighbours.
	const order = visible.map((_, position) => position)
		.sort((a, b) => Number(visible[a].marker.id === style.selectedMarkerId) - Number(visible[b].marker.id === style.selectedMarkerId));
	for (const position of order) {
		const item = visible[position];
		const selected = item.marker.id === style.selectedMarkerId;
		const color = markerColor(item.index, style.lightTheme);
		context.strokeStyle = color;
		context.lineWidth = selected ? 2 : 1.2;
		context.setLineDash(selected ? [] : [5, 3]);
		context.beginPath();
		context.moveTo(item.x, plot.top);
		context.lineTo(item.x, plot.top + plot.height);
		context.stroke();
		context.setLineDash([]);

		context.fillStyle = color;
		context.beginPath();
		context.moveTo(item.x - 5, plot.top);
		context.lineTo(item.x + 5, plot.top);
		context.lineTo(item.x, plot.top + 6);
		context.closePath();
		context.fill();

		const lane = lanes[position];
		const chipText = lane >= 0 ? item.text : markerName(item.index);
		const chipWidth = lane >= 0 ? item.width : context.measureText(chipText).width + 12;
		const chipX = lane >= 0 ? item.chipX : (item.x + 4 + chipWidth > plot.left + plot.width ? item.x - 4 - chipWidth : item.x + 4);
		const chipY = plot.top + 8 + Math.max(0, lane) * LANE_HEIGHT;
		context.fillStyle = style.lightTheme ? 'rgba(255, 255, 255, 0.94)' : 'rgba(11, 15, 20, 0.9)';
		context.fillRect(chipX, chipY, chipWidth, LANE_HEIGHT - 3);
		context.strokeStyle = color;
		context.lineWidth = selected ? 1.6 : 1;
		context.strokeRect(chipX + 0.5, chipY + 0.5, chipWidth - 1, LANE_HEIGHT - 4);
		context.fillStyle = color;
		context.textAlign = 'left';
		context.fillText(chipText, chipX + 6, chipY + (LANE_HEIGHT - 3) / 2 + 0.5);

		const level = style.levelAt(item.marker.frequencyHz);
		if (level !== null) {
			const y = Math.max(plot.top, Math.min(plot.top + plot.height, style.yForDb(level)));
			const size = selected ? 6 : 4.5;
			context.beginPath();
			context.moveTo(item.x, y - size);
			context.lineTo(item.x + size, y);
			context.lineTo(item.x, y + size);
			context.lineTo(item.x - size, y);
			context.closePath();
			context.fillStyle = color;
			context.fill();
			context.lineWidth = 1.5;
			context.strokeStyle = style.lightTheme ? '#ffffff' : '#0b0f14';
			context.stroke();
			if (selected) {
				const levelText = `${level.toFixed(1)} dB`;
				const textWidth = context.measureText(levelText).width + 10;
				const textX = item.x + 9 + textWidth > plot.left + plot.width ? item.x - 9 - textWidth : item.x + 9;
				// Keep the box inside the clipped plot when the level sits on an edge.
				const textY = Math.max(plot.top + 8, Math.min(plot.top + plot.height - 9, y));
				context.fillStyle = style.lightTheme ? 'rgba(255, 255, 255, 0.94)' : 'rgba(11, 15, 20, 0.9)';
				context.fillRect(textX, textY - 8, textWidth, 16);
				context.strokeStyle = color;
				context.lineWidth = 1;
				context.strokeRect(textX + 0.5, textY - 7.5, textWidth - 1, 15);
				context.fillStyle = color;
				context.fillText(levelText, textX + 5, textY + 0.5);
			}
		}
	}
	context.restore();
}
