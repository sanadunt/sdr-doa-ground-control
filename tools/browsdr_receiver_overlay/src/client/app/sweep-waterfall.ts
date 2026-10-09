import { convertDecibelToRGB } from '../utils';
import { SWEEP_DISPLAY_BINS } from '../worker/sweep-types';
import type { SweepCandidate, SweepSpectrumFrame } from '../worker/sweep-types';

export const SWEEP_WATERFALL_BINS = SWEEP_DISPLAY_BINS;
export const SWEEP_WATERFALL_ROWS = 256;
export const SWEEP_WATERFALL_MIN_DB = -160;
export const SWEEP_WATERFALL_MAX_DB = 0;

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
		const rowOffset = this.nextRow * SWEEP_WATERFALL_BINS;
		const values = frame.average;
		for (let bin = 0; bin < SWEEP_WATERFALL_BINS; bin++) {
			const sourceIndex = Math.min(values.length - 1, Math.floor(bin * values.length / SWEEP_WATERFALL_BINS));
			const db = values[sourceIndex];
			const boundedDb = Number.isFinite(db) ? Math.max(SWEEP_WATERFALL_MIN_DB, Math.min(SWEEP_WATERFALL_MAX_DB, db)) : SWEEP_WATERFALL_MIN_DB;
			this.data[rowOffset + bin] = Math.round((boundedDb - SWEEP_WATERFALL_MIN_DB) * 255 / (SWEEP_WATERFALL_MAX_DB - SWEEP_WATERFALL_MIN_DB));
		}
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
		context.fillText('Power (dBFS, relative)', left, 1);
		context.textBaseline = 'middle';
		context.textAlign = 'right';
		context.fillText('Older', left - 7, top + 7);
		context.fillText('Now', left - 7, top + plotHeight - 7);

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
			const db = SWEEP_WATERFALL_MIN_DB + value * (SWEEP_WATERFALL_MAX_DB - SWEEP_WATERFALL_MIN_DB) / 255;
			const color = convertDecibelToRGB(db, minDb, maxDb);
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
