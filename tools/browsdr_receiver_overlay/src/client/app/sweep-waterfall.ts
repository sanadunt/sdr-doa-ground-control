import { convertDecibelToRGB } from '../utils';
import { drawSweepMarkerHint, sweepCanvasText } from './sweep-marker-renderer';
import { SWEEP_DISPLAY_BINS } from '../worker/sweep-types';
import type { SweepCandidate, SweepSpectrumFrame } from '../worker/sweep-types';

export const SWEEP_WATERFALL_BINS = SWEEP_DISPLAY_BINS;
export const SWEEP_WATERFALL_ROWS = 256;
// Sweep FFT levels reach about +33 dB and the graph ceiling is +60 dB, so the
// stored byte scale covers the same range instead of clipping at 0 dB.
export const SWEEP_WATERFALL_MIN_DB = -160;
export const SWEEP_WATERFALL_MAX_DB = 60;
// Session files and archived traces written before the wider scale used -160..0 dB.
export const LEGACY_SWEEP_LEVEL_MAX_DB = 0;
// First byte of an archived trace in the -160..+60 dB scale. Legacy traces never
// start with it: their levels are at least -120 dB, so every legacy byte is >= 64.
export const ARCHIVED_TRACE_FORMAT_TAG = 1;

export function encodeSweepLevel(db: number, minDb = SWEEP_WATERFALL_MIN_DB, maxDb = SWEEP_WATERFALL_MAX_DB): number {
	const boundedDb = Number.isFinite(db) ? Math.max(minDb, Math.min(maxDb, db)) : minDb;
	return Math.round((boundedDb - minDb) * 255 / (maxDb - minDb));
}

export function decodeSweepLevel(level: number, minDb = SWEEP_WATERFALL_MIN_DB, maxDb = SWEEP_WATERFALL_MAX_DB): number {
	return minDb + level * (maxDb - minDb) / 255;
}

function resampleLevels(values: ArrayLike<number>, bin: number, bins: number): number {
	return values[Math.min(values.length - 1, Math.floor(bin * values.length / bins))];
}

export function encodeArchivedTrace(values: Float32Array): Uint8Array<ArrayBuffer> {
	const trace = new Uint8Array(SWEEP_WATERFALL_BINS);
	if (values.length === 0) return trace;
	for (let bin = 1; bin < trace.length; bin++) trace[bin] = encodeSweepLevel(resampleLevels(values, bin, trace.length));
	trace[0] = ARCHIVED_TRACE_FORMAT_TAG;
	return trace;
}

/** `format` comes from the scan record; null (older archives) detects it from the first byte. */
export function decodeArchivedTrace(trace: Uint8Array, format: number | null = null): Float32Array {
	if (format !== null && format !== ARCHIVED_TRACE_FORMAT_TAG) {
		throw new Error(`Archived trace format ${format} is not supported by this Receiver.`);
	}
	const levels = new Float32Array(trace.length);
	const tagged = format === ARCHIVED_TRACE_FORMAT_TAG || (trace.length > 1 && trace[0] === ARCHIVED_TRACE_FORMAT_TAG);
	const maxDb = tagged ? SWEEP_WATERFALL_MAX_DB : LEGACY_SWEEP_LEVEL_MAX_DB;
	for (let bin = 0; bin < trace.length; bin++) levels[bin] = decodeSweepLevel(trace[bin], SWEEP_WATERFALL_MIN_DB, maxDb);
	// The format byte replaced the first bin, which repeats its neighbour.
	if (tagged) levels[0] = levels[1];
	return levels;
}

export function encodeWaterfallRow(levels: ArrayLike<number>): Uint8Array {
	const row = new Uint8Array(SWEEP_WATERFALL_BINS);
	if (levels.length === 0) return row;
	for (let bin = 0; bin < row.length; bin++) row[bin] = encodeSweepLevel(resampleLevels(levels, bin, row.length));
	return row;
}

export function transcodeWaterfallLevels(data: ArrayLike<number>, fromMinDb: number, fromMaxDb: number): Uint8Array {
	const levels = Uint8Array.from(data);
	if (fromMinDb === SWEEP_WATERFALL_MIN_DB && fromMaxDb === SWEEP_WATERFALL_MAX_DB) return levels;
	for (let index = 0; index < levels.length; index++) {
		levels[index] = encodeSweepLevel(decodeSweepLevel(levels[index], fromMinDb, fromMaxDb));
	}
	return levels;
}

export class SweepWaterfallHistory {
	private readonly data = new Uint8Array(SWEEP_WATERFALL_BINS * SWEEP_WATERFALL_ROWS);
	private count = 0;
	private nextRow = 0;
	private latestSweepCount = 0;
	private revision = 0;

	get rowCount(): number {
		return this.count;
	}

	get latestCompletedSweepCount(): number {
		return this.latestSweepCount;
	}

	get version(): number {
		return this.revision;
	}

	appendCompletedSweep(frame: SweepSpectrumFrame): boolean {
		if (!Number.isInteger(frame.sweepCount) || frame.sweepCount <= this.latestSweepCount || frame.sweepCount < 1
			|| frame.average.length === 0) return false;
		this.data.set(encodeWaterfallRow(frame.average), this.nextRow * SWEEP_WATERFALL_BINS);
		this.nextRow = (this.nextRow + 1) % SWEEP_WATERFALL_ROWS;
		this.count = Math.min(this.count + 1, SWEEP_WATERFALL_ROWS);
		this.latestSweepCount = frame.sweepCount;
		this.revision++;
		return true;
	}

	clear(): void {
		this.data.fill(0);
		this.count = 0;
		this.nextRow = 0;
		this.latestSweepCount = 0;
		this.revision++;
	}

	restore(rows: Uint8Array, rowCount: number, latestSweepCount: number): void {
		if (!Number.isInteger(rowCount) || rowCount < 0 || rowCount > SWEEP_WATERFALL_ROWS
			|| rows.length !== rowCount * SWEEP_WATERFALL_BINS
			|| !Number.isInteger(latestSweepCount) || latestSweepCount < rowCount) {
			throw new RangeError('Invalid waterfall snapshot');
		}
		this.clear();
		this.data.set(rows, 0);
		this.count = rowCount;
		this.nextRow = rowCount % SWEEP_WATERFALL_ROWS;
		this.latestSweepCount = latestSweepCount;
	}

	readChronologicalRow(row: number): Uint8Array | null {
		if (!Number.isInteger(row) || row < 0 || row >= this.count) return null;
		const oldestPhysicalRow = this.count === SWEEP_WATERFALL_ROWS ? this.nextRow : 0;
		const physicalRow = (oldestPhysicalRow + row) % SWEEP_WATERFALL_ROWS;
		const offset = physicalRow * SWEEP_WATERFALL_BINS;
		return this.data.subarray(offset, offset + SWEEP_WATERFALL_BINS);
	}

	exportChronologicalRows(): Uint8Array {
		const rows = new Uint8Array(this.count * SWEEP_WATERFALL_BINS);
		for (let row = 0; row < this.count; row++) {
			const source = this.readChronologicalRow(row);
			if (source) rows.set(source, row * SWEEP_WATERFALL_BINS);
		}
		return rows;
	}
}

export interface SweepWaterfallOptions {
	viewportStartHz: number;
	viewportEndHz: number;
	minDb: number;
	maxDb: number;
	selectedCandidate: SweepCandidate | null;
}

export class SweepWaterfallRenderer {
	private readonly sourceCanvas = document.createElement('canvas');
	private readonly sourceContext: CanvasRenderingContext2D | null;
	private imageData: ImageData | null = null;
	private renderedVersion = -1;
	private renderedMinDb = Number.NaN;
	private renderedMaxDb = Number.NaN;

	constructor() {
		this.sourceCanvas.width = SWEEP_WATERFALL_BINS;
		this.sourceCanvas.height = SWEEP_WATERFALL_ROWS;
		this.sourceContext = this.sourceCanvas.getContext('2d');
		this.imageData = this.sourceContext?.createImageData(SWEEP_WATERFALL_BINS, SWEEP_WATERFALL_ROWS) ?? null;
	}

	draw(canvas: HTMLCanvasElement, history: SweepWaterfallHistory, frame: SweepSpectrumFrame | null, options: SweepWaterfallOptions): void {
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
		context.fillStyle = '#080b11';
		context.fillRect(0, 0, rect.width, rect.height);

		const left = 54;
		const right = 12;
		const top = 14;
		const bottom = 28;
		const plotWidth = Math.max(1, rect.width - left - right);
		const plotHeight = Math.max(1, rect.height - top - bottom);
		const viewSpan = Math.max(1, options.viewportEndHz - options.viewportStartHz);
		const totalStartHz = frame?.startHz ?? options.viewportStartHz;
		const totalEndHz = frame?.endHz ?? options.viewportEndHz;
		const totalSpan = Math.max(1, totalEndHz - totalStartHz);

		context.font = '10px "Roboto Mono", monospace';
		context.textBaseline = 'middle';
		context.lineWidth = 1;
		context.strokeStyle = 'rgba(170, 190, 215, 0.18)';
		context.fillStyle = '#8994a4';
		for (let tick = 0; tick <= 4; tick++) {
			const x = left + plotWidth * tick / 4;
			const frequencyHz = options.viewportStartHz + viewSpan * tick / 4;
			context.beginPath();
			context.moveTo(x, top);
			context.lineTo(x, top + plotHeight);
			context.stroke();
			context.textAlign = tick === 0 ? 'left' : tick === 4 ? 'right' : 'center';
			context.textBaseline = 'top';
			context.fillStyle = '#aab4c2';
			context.fillText(`${(frequencyHz / 1_000_000).toFixed(3)} MHz`, x, top + plotHeight + 7);
		}
		context.textAlign = 'left';
		context.textBaseline = 'top';
		context.fillStyle = '#8ea0b8';
		const axisLabel = sweepCanvasText('Power (dBFS, relative)');
		context.fillText(axisLabel, left, 1);
		drawSweepMarkerHint(context, left, plotWidth, context.measureText(axisLabel).width);
		context.textBaseline = 'middle';
		context.textAlign = 'right';
		context.fillText(sweepCanvasText('Older'), left - 7, top + 7);
		context.fillText(sweepCanvasText('Now'), left - 7, top + plotHeight - 7);

		if (frame && history.rowCount > 0 && this.sourceContext && this.imageData) {
			this.updateSourceImage(history, options.minDb, options.maxDb);
			const sourceStart = Math.max(0, Math.min(SWEEP_WATERFALL_BINS, (options.viewportStartHz - totalStartHz) / totalSpan * SWEEP_WATERFALL_BINS));
			const sourceEnd = Math.max(sourceStart, Math.min(SWEEP_WATERFALL_BINS, (options.viewportEndHz - totalStartHz) / totalSpan * SWEEP_WATERFALL_BINS));
			const sourceWidth = sourceEnd - sourceStart;
			context.save();
			context.beginPath();
			context.rect(left, top, plotWidth, plotHeight);
			context.clip();
			context.imageSmoothingEnabled = false;
			const destinationHeight = plotHeight * history.rowCount / SWEEP_WATERFALL_ROWS;
			const destinationTop = top + plotHeight - destinationHeight;
			if (sourceWidth > 0) context.drawImage(this.sourceCanvas, sourceStart, 0, sourceWidth, history.rowCount, left, destinationTop, plotWidth, destinationHeight);
			context.restore();
		}

		context.save();
		context.beginPath();
		context.rect(left, top, plotWidth, plotHeight);
		context.clip();
		context.strokeStyle = 'rgba(170, 190, 215, 0.18)';
		for (let tick = 0; tick <= 4; tick++) {
			const x = left + plotWidth * tick / 4;
			context.beginPath();
			context.moveTo(x, top);
			context.lineTo(x, top + plotHeight);
			context.stroke();
		}
		for (let tick = 1; tick < 4; tick++) {
			const y = top + plotHeight * tick / 4;
			context.beginPath();
			context.moveTo(left, y);
			context.lineTo(left + plotWidth, y);
			context.stroke();
		}
		context.restore();

		const candidate = options.selectedCandidate;
		if (candidate) {
			const xStart = left + (candidate.startHz - options.viewportStartHz) / viewSpan * plotWidth;
			const xEnd = left + (candidate.endHz - options.viewportStartHz) / viewSpan * plotWidth;
			if (xEnd >= left && xStart <= left + plotWidth) {
				context.fillStyle = 'rgba(255, 193, 7, 0.13)';
				context.fillRect(Math.max(left, xStart), top, Math.max(1, Math.min(left + plotWidth, xEnd) - Math.max(left, xStart)), plotHeight);
				context.strokeStyle = 'rgba(255, 193, 7, 0.9)';
				context.setLineDash([4, 3]);
				const centerX = left + (candidate.centerHz - options.viewportStartHz) / viewSpan * plotWidth;
				context.beginPath();
				context.moveTo(centerX, top);
				context.lineTo(centerX, top + plotHeight);
				context.stroke();
				context.setLineDash([]);
			}
		}

		context.strokeStyle = 'rgba(160, 180, 205, 0.45)';
		context.strokeRect(left, top, plotWidth, plotHeight);
	}

	private updateSourceImage(history: SweepWaterfallHistory, minDb: number, maxDb: number): void {
		if (!this.sourceContext || !this.imageData
			|| (this.renderedVersion === history.version && this.renderedMinDb === minDb && this.renderedMaxDb === maxDb)) return;
		const colors = new Uint8Array(256 * 4);
		for (let value = 0; value < 256; value++) {
			const color = convertDecibelToRGB(decodeSweepLevel(value), minDb, maxDb);
			const offset = value * 4;
			colors[offset] = color.r;
			colors[offset + 1] = color.g;
			colors[offset + 2] = color.b;
			colors[offset + 3] = 255;
		}
		const pixels = this.imageData.data;
		pixels.fill(0);
		for (let row = 0; row < history.rowCount; row++) {
			const values = history.readChronologicalRow(row);
			if (!values) continue;
			const rowOffset = row * SWEEP_WATERFALL_BINS * 4;
			for (let bin = 0; bin < SWEEP_WATERFALL_BINS; bin++) {
				const colorOffset = values[bin] * 4;
				const pixelOffset = rowOffset + bin * 4;
				pixels[pixelOffset] = colors[colorOffset];
				pixels[pixelOffset + 1] = colors[colorOffset + 1];
				pixels[pixelOffset + 2] = colors[colorOffset + 2];
				pixels[pixelOffset + 3] = 255;
			}
		}
		this.sourceContext.putImageData(this.imageData, 0, 0);
		this.renderedVersion = history.version;
		this.renderedMinDb = minDb;
		this.renderedMaxDb = maxDb;
	}
}
