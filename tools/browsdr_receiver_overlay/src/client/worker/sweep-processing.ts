import {
	SWEEP_CANDIDATE_PEAK_TOLERANCE_HZ,
	SWEEP_DISPLAY_BINS,
	SWEEP_MAX_BINS,
	SWEEP_OFFSET_HZ,
	SWEEP_SAMPLE_RATE_HZ,
	validateSweepConfig,
} from './sweep-types';
import type { SweepCandidate, SweepConfig, SweepSpectrumFrame } from './sweep-types';

const NO_SIGNAL_DB = -120;
const NOISE_BLOCK_BINS = 128;
const NOISE_HISTOGRAM_SIZE = 161;

export class SweepAccumulator {
	readonly resolutionHz: number;
	readonly binCount: number;
	readonly current: Float32Array;
	readonly average: Float32Array;
	readonly maxHold: Float32Array;
	readonly hitCount: Uint16Array;

	private readonly currentSums: Float32Array;
	private readonly currentWeights: Uint8Array;
	private readonly updated: Uint8Array;
	private readonly noiseFloors: Float32Array;
	private readonly noiseHistogram = new Uint16Array(NOISE_HISTOGRAM_SIZE);
	private readonly candidates: SweepCandidate[] = [];
	private readonly candidatesByPeakBucket = new Map<number, Set<SweepCandidate>>();
	private readonly changedCandidates = new Map<number, SweepCandidate>();
	private readonly candidateSweepState = new Map<number, { sweep: number; lastPeakFrequencyHz: number }>();
	private nextCandidateId = 1;
	private sweepActive = false;
	private _sweepCount = 0;

	constructor(readonly config: SweepConfig) {
		validateSweepConfig(config);
		this.resolutionHz = SWEEP_SAMPLE_RATE_HZ / config.fftSize;
		this.binCount = Math.ceil((config.endHz - config.startHz) / this.resolutionHz);
		if (this.binCount > SWEEP_MAX_BINS) throw new RangeError('Sweep exceeds the supported spectrum memory limit');
		this.current = new Float32Array(this.binCount);
		this.current.fill(Number.NaN);
		this.average = new Float32Array(this.binCount);
		this.average.fill(Number.NaN);
		this.maxHold = new Float32Array(this.binCount);
		this.maxHold.fill(NO_SIGNAL_DB);
		this.hitCount = new Uint16Array(this.binCount);
		this.currentSums = new Float32Array(this.binCount);
		this.currentWeights = new Uint8Array(this.binCount);
		this.updated = new Uint8Array(this.binCount);
		this.noiseFloors = new Float32Array(Math.ceil(this.binCount / NOISE_BLOCK_BINS));
	}

	get sweepCount(): number {
		return this._sweepCount;
	}

	get candidateCount(): number {
		return this.candidates.length;
	}

	beginSweep(): void {
		if (this.sweepActive) this.commitSweep();
		this.current.fill(Number.NaN);
		this.sweepActive = true;
	}

	finishSweep(): void {
		if (!this.sweepActive) return;
		this.commitSweep();
		this.sweepActive = false;
	}

	addSample(frequencyHz: number, powerDb: number): void {
		if (!Number.isFinite(frequencyHz) || !Number.isFinite(powerDb) || frequencyHz < this.config.startHz || frequencyHz >= this.config.endHz) return;
		const index = Math.floor((frequencyHz - this.config.startHz) / this.resolutionHz);
		if (index < 0 || index >= this.binCount) return;
		const weight = this.currentWeights[index];
		this.currentSums[index] += powerDb;
		if (weight < 0xff) this.currentWeights[index] = weight + 1;
		this.current[index] = this.currentSums[index] / this.currentWeights[index];
		this.updated[index] = 1;
	}

	addNativeFft(headerFrequencyHz: number, fftOutput: Float32Array): void {
		const size = fftOutput.length;
		const quarter = size >>> 2;
		const firstSegment = (size * 5) / 8 + 1;
		const secondSegment = (size >>> 3) + 1;
		const half = size >>> 1;
		const binWidth = SWEEP_SAMPLE_RATE_HZ / size;
		this.addNativeSegment(headerFrequencyHz, fftOutput, firstSegment, quarter, half, binWidth);
		this.addNativeSegment(headerFrequencyHz, fftOutput, secondSegment, quarter, half, binWidth);
	}

	addManualFft(centerFrequencyHz: number, fftOutput: Float32Array): void {
		const size = fftOutput.length;
		const half = size >>> 1;
		const edgeBins = size >>> 3;
		const binWidth = SWEEP_SAMPLE_RATE_HZ / size;
		for (let index = edgeBins; index < size - edgeBins; index++) {
			const offsetBins = index - half;
			if (Math.abs(offsetBins) <= 2) continue;
			this.addSample(centerFrequencyHz + offsetBins * binWidth, fftOutput[index]);
		}
	}

	createFrame(displayBins = SWEEP_DISPLAY_BINS): SweepSpectrumFrame {
		const count = Math.min(this.binCount, Math.max(1, Math.floor(displayBins)));
		const current = new Float32Array(count);
		const average = new Float32Array(count);
		const maxHold = new Float32Array(count);
		for (let displayIndex = 0; displayIndex < count; displayIndex++) {
			const start = Math.floor(displayIndex * this.binCount / count);
			const end = Math.max(start + 1, Math.floor((displayIndex + 1) * this.binCount / count));
			let currentPeak = NO_SIGNAL_DB;
			let averagePeak = NO_SIGNAL_DB;
			let maxPeak = NO_SIGNAL_DB;
			for (let index = start; index < end; index++) {
				if (this.current[index] > currentPeak) currentPeak = this.current[index];
				if (this.average[index] > averagePeak) averagePeak = this.average[index];
				if (this.maxHold[index] > maxPeak) maxPeak = this.maxHold[index];
			}
			current[displayIndex] = currentPeak;
			average[displayIndex] = averagePeak;
			maxHold[displayIndex] = maxPeak;
		}
		return {
			startHz: this.config.startHz,
			endHz: this.config.endHz,
			resolutionHz: this.resolutionHz,
			sweepCount: this._sweepCount,
			current,
			average,
			maxHold,
		};
	}

	getCandidates(): SweepCandidate[] {
		return this.candidates.map(candidate => ({ ...candidate }));
	}

	getChangedCandidates(): SweepCandidate[] {
		const changed = Array.from(this.changedCandidates.values(), candidate => ({ ...candidate }));
		this.changedCandidates.clear();
		return changed;
	}

	clear(): void {
		this.current.fill(Number.NaN);
		this.average.fill(Number.NaN);
		this.maxHold.fill(NO_SIGNAL_DB);
		this.hitCount.fill(0);
		this.currentSums.fill(0);
		this.currentWeights.fill(0);
		this.updated.fill(0);
		this.candidates.length = 0;
		this.candidateSweepState.clear();
		this.candidatesByPeakBucket.clear();
		this.changedCandidates.clear();
		this.nextCandidateId = 1;
		this._sweepCount = 0;
	}

	private addNativeSegment(headerFrequencyHz: number, fftOutput: Float32Array, rawStart: number, length: number, half: number, binWidth: number): void {
		for (let i = 0; i < length; i++) {
			const rawIndex = rawStart + i;
			const centeredIndex = (rawIndex + half) % fftOutput.length;
			const signedBin = rawIndex < half ? rawIndex : rawIndex - fftOutput.length;
			const frequencyHz = headerFrequencyHz + SWEEP_OFFSET_HZ + signedBin * binWidth;
			this.addSample(frequencyHz, fftOutput[centeredIndex]);
		}
	}

	private commitSweep(): void {
		const alpha = this.config.averageAlpha;
		let hasSamples = false;
		for (let index = 0; index < this.binCount; index++) {
			if (!this.updated[index]) continue;
			hasSamples = true;
			const value = this.current[index];
			this.average[index] = Number.isFinite(this.average[index])
				? this.average[index] + alpha * (value - this.average[index])
				: value;
			if (value > this.maxHold[index]) this.maxHold[index] = value;
			if (this.hitCount[index] < 0xffff) this.hitCount[index]++;
			this.updated[index] = 0;
			this.currentSums[index] = 0;
			this.currentWeights[index] = 0;
		}
		if (!hasSamples) return;
		this._sweepCount++;
		this.detectCandidates(Date.now());
	}

	private detectCandidates(now: number): void {
		for (let block = 0; block < this.noiseFloors.length; block++) {
			this.noiseHistogram.fill(0);
			const start = block * NOISE_BLOCK_BINS;
			const end = Math.min(this.binCount, start + NOISE_BLOCK_BINS);
			let count = 0;
			for (let index = start; index < end; index++) {
				const value = this.average[index];
				if (!Number.isFinite(value)) continue;
				const bucket = Math.max(0, Math.min(NOISE_HISTOGRAM_SIZE - 1, Math.floor(value + 160)));
				this.noiseHistogram[bucket]++;
				count++;
			}
			if (count === 0) {
				this.noiseFloors[block] = NO_SIGNAL_DB;
				continue;
			}
			const target = Math.floor((count - 1) * 0.25);
			let cumulative = 0;
			for (let bucket = 0; bucket < this.noiseHistogram.length; bucket++) {
				cumulative += this.noiseHistogram[bucket];
				if (cumulative > target) {
					this.noiseFloors[block] = bucket - 160;
					break;
				}
			}
		}

		let candidateStart = -1;
		let candidatePeak = NO_SIGNAL_DB;
		let candidateNoise = NO_SIGNAL_DB;
		let candidatePeakFrequencyHz = this.config.startHz;
		for (let index = 0; index <= this.binCount; index++) {
			let active = false;
			if (index < this.binCount && Number.isFinite(this.current[index])) {
				const floor = this.noiseFloors[Math.floor(index / NOISE_BLOCK_BINS)];
				active = this.current[index] - floor >= this.config.minSnrDb;
				if (active && this.current[index] > candidatePeak) {
					candidatePeak = this.current[index];
					candidateNoise = floor;
					candidatePeakFrequencyHz = this.config.startHz + (index + 0.5) * this.resolutionHz;
				}
			}
			if (active && candidateStart < 0) candidateStart = index;
			if (!active && candidateStart >= 0) {
				this.upsertCandidate(candidateStart, index - 1, candidatePeak, candidateNoise, candidatePeakFrequencyHz, now);
				candidateStart = -1;
				candidatePeak = NO_SIGNAL_DB;
				candidateNoise = NO_SIGNAL_DB;
				candidatePeakFrequencyHz = this.config.startHz;
			}
		}
	}

	private upsertCandidate(firstBin: number, lastBin: number, peakDb: number, noiseFloorDb: number, peakFrequencyHz: number, now: number): void {
		const startHz = this.config.startHz + firstBin * this.resolutionHz;
		const endHz = Math.min(this.config.endHz, this.config.startHz + (lastBin + 1) * this.resolutionHz);
		const peakBucket = Math.floor(peakFrequencyHz / SWEEP_CANDIDATE_PEAK_TOLERANCE_HZ);
		let matchedCandidate: SweepCandidate | undefined;
		let matchedPeakState: { sweep: number; lastPeakFrequencyHz: number } | undefined;
		for (let bucket = peakBucket - 1; bucket <= peakBucket + 1 && !matchedCandidate; bucket++) {
			for (const candidate of this.candidatesByPeakBucket.get(bucket) ?? []) {
				const state = this.candidateSweepState.get(candidate.id);
				if (!state || state.sweep === this._sweepCount
					|| Math.abs(peakFrequencyHz - state.lastPeakFrequencyHz) > SWEEP_CANDIDATE_PEAK_TOLERANCE_HZ) continue;
				matchedCandidate = candidate;
				matchedPeakState = state;
				break;
			}
		}
		if (matchedCandidate && matchedPeakState) {
			const oldPeakBucket = Math.floor(matchedPeakState.lastPeakFrequencyHz / SWEEP_CANDIDATE_PEAK_TOLERANCE_HZ);
			matchedCandidate.startHz = Math.min(matchedCandidate.startHz, startHz);
			matchedCandidate.endHz = Math.max(matchedCandidate.endHz, endHz);
			matchedCandidate.centerHz = (matchedCandidate.startHz + matchedCandidate.endHz) / 2;
			matchedCandidate.bandwidthHz = matchedCandidate.endHz - matchedCandidate.startHz;
			matchedCandidate.meanPeakFrequencyHz += (peakFrequencyHz - matchedCandidate.meanPeakFrequencyHz) / (matchedCandidate.hits + 1);
			matchedCandidate.minPeakFrequencyHz = Math.min(matchedCandidate.minPeakFrequencyHz, peakFrequencyHz);
			matchedCandidate.maxPeakFrequencyHz = Math.max(matchedCandidate.maxPeakFrequencyHz, peakFrequencyHz);
			if (peakDb > matchedCandidate.peakDb) {
				matchedCandidate.peakDb = peakDb;
				matchedCandidate.peakFrequencyHz = peakFrequencyHz;
			}
			matchedCandidate.noiseFloorDb = Math.min(matchedCandidate.noiseFloorDb, noiseFloorDb);
			matchedCandidate.snrDb = matchedCandidate.peakDb - matchedCandidate.noiseFloorDb;
			matchedCandidate.lastSeen = now;
			matchedCandidate.hits++;
			matchedPeakState.sweep = this._sweepCount;
			matchedPeakState.lastPeakFrequencyHz = peakFrequencyHz;
			const newPeakBucket = Math.floor(peakFrequencyHz / SWEEP_CANDIDATE_PEAK_TOLERANCE_HZ);
			if (newPeakBucket !== oldPeakBucket) {
				this.removeCandidateFromPeakIndex(matchedCandidate, oldPeakBucket);
				this.addCandidateToPeakIndex(matchedCandidate);
			}
			this.changedCandidates.set(matchedCandidate.id, matchedCandidate);
			return;
		}

		const candidate: SweepCandidate = {
			id: this.nextCandidateId++,
			startHz,
			endHz,
			centerHz: (startHz + endHz) / 2,
			bandwidthHz: endHz - startHz,
			peakFrequencyHz,
			meanPeakFrequencyHz: peakFrequencyHz,
			minPeakFrequencyHz: peakFrequencyHz,
			maxPeakFrequencyHz: peakFrequencyHz,
			peakDb,
			noiseFloorDb,
			snrDb: peakDb - noiseFloorDb,
			firstSeen: now,
			lastSeen: now,
			hits: 1,
		};
		this.candidates.push(candidate);
		this.candidateSweepState.set(candidate.id, {
			sweep: this._sweepCount,
			lastPeakFrequencyHz: peakFrequencyHz,
		});
		this.addCandidateToPeakIndex(candidate);
		this.changedCandidates.set(candidate.id, candidate);
	}

	private addCandidateToPeakIndex(candidate: SweepCandidate): void {
		const lastPeakFrequencyHz = this.candidateSweepState.get(candidate.id)?.lastPeakFrequencyHz ?? candidate.meanPeakFrequencyHz;
		const bucket = Math.floor(lastPeakFrequencyHz / SWEEP_CANDIDATE_PEAK_TOLERANCE_HZ);
		let candidates = this.candidatesByPeakBucket.get(bucket);
		if (!candidates) {
			candidates = new Set<SweepCandidate>();
			this.candidatesByPeakBucket.set(bucket, candidates);
		}
		candidates.add(candidate);
	}

	private removeCandidateFromPeakIndex(candidate: SweepCandidate, bucket: number): void {
		const candidates = this.candidatesByPeakBucket.get(bucket);
		if (!candidates) return;
		candidates.delete(candidate);
		if (candidates.size === 0) this.candidatesByPeakBucket.delete(bucket);
	}
}
