import type { SweepCandidate, SweepSpectrumFrame, SweepSpectrumView } from '../worker/sweep-types';
import type { ReceiverMarker } from './receiver-records-api';
import { traceLevelAt, traceValues } from './marker-readout';
import { drawSweepMarkerOverlay } from './sweep-marker-renderer';
import type { SweepMarkerPlot } from './sweep-marker-renderer';

const CHART_FONT = '10px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

export interface SweepCanvasOptions {
	view: SweepSpectrumView;
	startHz: number;
	endHz: number;
	selectedCandidate: SweepCandidate | null;
	hoverFrequencyHz: number | null;
	hoverPowerDb: number | null;
	minDb: number;
	maxDb: number;
	markers: ReceiverMarker[];
	selectedMarkerId: string | null;
}

export function drawSweepCanvas(canvas: HTMLCanvasElement, frame: SweepSpectrumFrame | null, options: SweepCanvasOptions): void {
	const rect = canvas.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return;
	const scale = Math.min(window.devicePixelRatio || 1, 2);
	const pixelWidth = Math.round(rect.width * scale);
	const pixelHeight = Math.round(rect.height * scale);
	if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
		canvas.width = pixelWidth;
		canvas.height = pixelHeight;
	}
	const context = canvas.getContext('2d');
	if (!context) return;
	context.setTransform(scale, 0, 0, scale, 0, 0);
	const lightTheme = document.documentElement.dataset.theme === 'light';
	context.fillStyle = lightTheme ? '#ffffff' : '#080b11';
	context.fillRect(0, 0, rect.width, rect.height);

	const left = 54;
	const right = 12;
	const top = 14;
	const bottom = 28;
	const plotWidth = Math.max(1, rect.width - left - right);
	const plotHeight = Math.max(1, rect.height - top - bottom);
	const viewSpan = Math.max(1, options.endHz - options.startHz);
	const yForDb = (db: number): number => top + (options.maxDb - db) / (options.maxDb - options.minDb) * plotHeight;

	context.font = CHART_FONT;
	context.textBaseline = 'middle';
	context.lineWidth = 1;
	context.strokeStyle = lightTheme ? 'rgba(61, 75, 89, 0.16)' : 'rgba(170, 190, 215, 0.16)';
	context.fillStyle = lightTheme ? '#3d4b59' : '#8994a4';
	for (let db = Math.ceil(options.minDb / 20) * 20; db <= options.maxDb; db += 20) {
		const y = yForDb(db);
		context.beginPath();
		context.moveTo(left, y);
		context.lineTo(left + plotWidth, y);
		context.stroke();
		context.textAlign = 'right';
		context.fillText(`${db} dB`, left - 7, y);
	}

	const tickCount = Math.min(4, Math.max(2, Math.floor(plotWidth / 110)));
	for (let tick = 0; tick <= tickCount; tick++) {
		const ratio = tick / tickCount;
		const x = left + plotWidth * ratio;
		const frequencyHz = options.startHz + viewSpan * ratio;
		context.beginPath();
		context.moveTo(x, top);
		context.lineTo(x, top + plotHeight);
		context.stroke();
		context.textAlign = tick === 0 ? 'left' : tick === tickCount ? 'right' : 'center';
		context.textBaseline = 'top';
		context.fillStyle = lightTheme ? '#3d4b59' : '#aab4c2';
		context.fillText(`${(frequencyHz / 1_000_000).toFixed(3)} MHz`, x, top + plotHeight + 7);
	}
	context.textAlign = 'left';
	context.textBaseline = 'top';
	context.fillStyle = lightTheme ? '#56636f' : '#8ea0b8';
	context.fillText('Power (dBFS, relative)', left, 1);

	if (options.selectedCandidate) {
		const candidate = options.selectedCandidate;
		const xStart = left + (candidate.startHz - options.startHz) / viewSpan * plotWidth;
		const xEnd = left + (candidate.endHz - options.startHz) / viewSpan * plotWidth;
		if (xEnd >= left && xStart <= left + plotWidth) {
			const clippedStart = Math.max(left, xStart);
			const clippedEnd = Math.min(left + plotWidth, xEnd);
			context.fillStyle = lightTheme ? 'rgba(128, 84, 0, 0.1)' : 'rgba(255, 193, 7, 0.13)';
			context.fillRect(clippedStart, top, Math.max(1, clippedEnd - clippedStart), plotHeight);
			context.strokeStyle = lightTheme ? '#805400' : 'rgba(255, 193, 7, 0.9)';
			context.setLineDash([4, 3]);
			const centerX = left + (candidate.centerHz - options.startHz) / viewSpan * plotWidth;
			context.beginPath();
			context.moveTo(centerX, top);
			context.lineTo(centerX, top + plotHeight);
			context.stroke();
			context.setLineDash([]);
		}
	}

	if (frame) {
		const values = options.view === 'current' ? frame.current : options.view === 'max' ? frame.maxHold : frame.average;
		const bandSpan = frame.endHz - frame.startHz;
		const viewBinStart = (options.startHz - frame.startHz) / bandSpan * values.length;
		const binsPerPixel = (options.endHz - options.startHz) / bandSpan * values.length / plotWidth;
		context.save();
		context.beginPath();
		context.rect(left, top, plotWidth, plotHeight);
		context.clip();
		context.beginPath();
		for (let x = 0; x < Math.ceil(plotWidth); x++) {
			const sourceStart = Math.max(0, Math.floor(viewBinStart + x * binsPerPixel));
			const sourceEnd = Math.min(values.length, Math.max(sourceStart + 1, Math.ceil(viewBinStart + Math.min(x + 1, plotWidth) * binsPerPixel)));
			let peak = options.minDb;
			for (let index = sourceStart; index < sourceEnd; index++) {
				if (values[index] > peak) peak = values[index];
			}
			const y = yForDb(Math.max(options.minDb, Math.min(options.maxDb, peak)));
			if (x === 0) context.moveTo(left + x, y);
			else context.lineTo(left + x, y);
		}
		const powerGradient = context.createLinearGradient(0, top + plotHeight, 0, top);
		powerGradient.addColorStop(0, '#1d4ed8');
		powerGradient.addColorStop(0.3, '#06b6d4');
		powerGradient.addColorStop(0.62, '#facc15');
		powerGradient.addColorStop(1, '#ef4444');
		context.strokeStyle = powerGradient;
		context.lineWidth = 1.8;
		context.stroke();
		context.restore();
	}

	const markerValues = frame ? traceValues(frame, options.view) : null;
	drawSweepMarkerOverlay(context, options.markers, {
		startHz: options.startHz,
		endHz: options.endHz,
		left,
		top,
		width: plotWidth,
		height: plotHeight,
	} satisfies SweepMarkerPlot, {
		lightTheme,
		selectedMarkerId: options.selectedMarkerId,
		yForDb,
		levelAt: frequencyHz => (frame && markerValues ? traceLevelAt(markerValues, frame.startHz, frame.endHz, frequencyHz) : null),
		font: CHART_FONT,
	});

	if (options.hoverFrequencyHz !== null && options.hoverFrequencyHz >= options.startHz && options.hoverFrequencyHz <= options.endHz) {
		const x = left + (options.hoverFrequencyHz - options.startHz) / viewSpan * plotWidth;
		const powerDb = options.hoverPowerDb;
		const y = powerDb !== null && Number.isFinite(powerDb)
			? yForDb(Math.max(options.minDb, Math.min(options.maxDb, powerDb)))
			: null;
		context.save();
		context.strokeStyle = lightTheme ? 'rgba(22, 32, 42, 0.45)' : 'rgba(255,255,255,0.62)';
		context.setLineDash([2, 3]);
		context.beginPath();
		context.moveTo(x, top);
		context.lineTo(x, top + plotHeight);
		context.stroke();
		if (y !== null) {
			context.beginPath();
			context.moveTo(left, y);
			context.lineTo(left + plotWidth, y);
			context.stroke();
			context.setLineDash([]);
			context.beginPath();
			context.arc(x, y, 4, 0, Math.PI * 2);
			context.fillStyle = '#ef4444';
			context.fill();
			context.lineWidth = 1.5;
			context.strokeStyle = lightTheme ? '#ffffff' : '#fff';
			context.stroke();
			if (powerDb !== null && Number.isFinite(powerDb)) {
				const frequencyText = `${(options.hoverFrequencyHz / 1_000_000).toFixed(6)} MHz`;
				const powerText = `${powerDb.toFixed(1)} dBFS-like`;
				context.font = CHART_FONT;
				const boxWidth = Math.ceil(Math.max(context.measureText(frequencyText).width, context.measureText(powerText).width)) + 14;
				const boxHeight = 34;
				let boxX = x + 9;
				if (boxX + boxWidth > left + plotWidth - 4) boxX = x - boxWidth - 9;
				boxX = Math.max(left + 4, Math.min(left + plotWidth - boxWidth - 4, boxX));
				let boxY = y - boxHeight - 9;
				if (boxY < top + 4) boxY = y + 9;
				boxY = Math.max(top + 4, Math.min(top + plotHeight - boxHeight - 4, boxY));
				context.fillStyle = lightTheme ? 'rgba(255,255,255,0.96)' : 'rgba(8,11,17,0.96)';
				context.fillRect(boxX, boxY, boxWidth, boxHeight);
				context.strokeStyle = lightTheme ? 'rgba(61,75,89,0.45)' : 'rgba(255,255,255,0.68)';
				context.strokeRect(boxX, boxY, boxWidth, boxHeight);
				context.fillStyle = lightTheme ? '#16202a' : '#f8fafc';
				context.textAlign = 'left';
				context.textBaseline = 'top';
				context.fillText(frequencyText, boxX + 7, boxY + 5);
				context.fillText(powerText, boxX + 7, boxY + 19);
			}
		}
		context.setLineDash([]);
		context.restore();
	}
	context.strokeStyle = lightTheme ? 'rgba(61, 75, 89, 0.4)' : 'rgba(160, 180, 205, 0.45)';
	context.strokeRect(left, top, plotWidth, plotHeight);
}
