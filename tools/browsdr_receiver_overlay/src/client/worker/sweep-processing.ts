import {
	SWEEP_CANDIDATE_PEAK_TOLERANCE_HZ,
	SWEEP_DISPLAY_BINS,
	SWEEP_MAX_BINS,
	SWEEP_MAX_CANDIDATES,
	SWEEP_OFFSET_HZ,
	SWEEP_SAMPLE_RATE_HZ,
	validateSweepConfig,
} from './sweep-types';
import type { SweepCandidate, SweepConfig, SweepSpectrumFrame } from './sweep-types';

const NO_SIGNAL_DB = -120;
const NOISE_BLOCK_BINS = 128;
const NOISE_HISTOGRAM_SIZE = 161;
const BLOCK_FLOOR_PERCENTILE = 0.5;
// Block floors are ranked across this half-width, so a signal wider than one
// block cannot become its own noise floor.
const NOISE_FLOOR_HALF_WINDOW_HZ = 10_000_000;
const WIDEBAND_FLOOR_PERCENTILE = 0.25;
// Detection uses its own averaging so the false-alarm rate does not follow the
// display averaging setting.
const DETECTION_AVERAGE_ALPHA = 0.25;
// Below this many sweeps the detection average of pure noise still crosses
// typical thresholds too often to confirm a weak signal.
const CONFIRMATION_MIN_SWEEPS = 6;
// Single-sweep receiver noise practically never reaches this far above the floor.
const IMMEDIATE_DETECTION_SNR_DB = 16;
const BAND_CONTACT_BINS = 2;
const SMOOTHING_HALF_WIDTH_BINS = 2;

interface CandidateState {
	sweep: number;
	lastPeakFrequencyHz: number;
	bucket: number;
}

interface DetectionRun {
	startHz: number;
	endHz: number;
	peakFrequencyHz: number;
	peakDb: number;
	noiseFloorDb: number;
	snrDb: number;
}

function peakBucket(frequencyHz: number): number {
	return Math.floor(frequencyHz / SWEEP_CANDIDATE_PEAK_TOLERANCE_HZ);
}

export class SweepAccumulator {
	readonly config: SweepConfig;
	readonly resolutionHz: number;
	readonly binCount: number;
	readonly current: Float32Array;
	readonly average: Float32Array;
	readonly maxHold: Float32Array;
	readonly hitCount: Uint16Array;

	private readonly detectionAverage: Float32Array;
	private readonly binOffsets: Float32Array;
	private readonly currentSums: Float32Array;
	private readonly currentWeights: Uint8Array;
	private readonly updated: Uint8Array;
	private readonly blockFloors: Float32Array;
	private readonly noiseFloors: Float32Array;
	private readonly floorWindow: Float32Array;
	private readonly floorHalfWindowBlocks: number;
	private readonly noiseHistogram = new Uint16Array(NOISE_HISTOGRAM_SIZE);
	private readonly candidates: SweepCandidate[] = [];
	private readonly candidatesByPeakBucket = new Map<number, Set<SweepCandidate>>();
	private readonly changedCandidates = new Map<number, SweepCandidate>();
	private readonly removedCandidateIds = new Set<number>();
	private readonly candidateState = new Map<number, CandidateState>();
	private nextCandidateId = 1;
	private sweepActive = false;
	private _sweepCount = 0;

	constructor(config: SweepConfig) {
		validateSweepConfig(config);
		this.config = config;
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
		this.detectionAverage = new Float32Array(this.binCount);
		this.detectionAverage.fill(Number.NaN);
		this.binOffsets = new Float32Array(this.binCount);
		this.binOffsets.fill(0.5);
		this.currentSums = new Float32Array(this.binCount);
		this.currentWeights = new Uint8Array(this.binCount);
		this.updated = new Uint8Array(this.binCount);
		const blockCount = Math.ceil(this.binCount / NOISE_BLOCK_BINS);
		this.blockFloors = new Float32Array(blockCount);
		this.noiseFloors = new Float32Array(blockCount);
		this.floorHalfWindowBlocks = Math.max(1, Math.round(NOISE_FLOOR_HALF_WINDOW_HZ / (NOISE_BLOCK_BINS * this.resolutionHz)));
		this.floorWindow = new Float32Array(this.floorHalfWindowBlocks * 2 + 1);
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
		const position = (frequencyHz - this.config.startHz) / this.resolutionHz;
		const index = Math.floor(position);
		if (index < 0 || index >= this.binCount) return;
		const weight = this.currentWeights[index];
		this.currentSums[index] += powerDb;
		if (weight < 0xff) this.currentWeights[index] = weight + 1;
		this.current[index] = this.currentSums[index] / this.currentWeights[index];
		this.binOffsets[index] = position - index;
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

	takeRemovedCandidateIds(): number[] {
		const removed = Array.from(this.removedCandidateIds);
		this.removedCandidateIds.clear();
		return removed;
	}

	clear(): void {
		this.current.fill(Number.NaN);
		this.average.fill(Number.NaN);
		this.maxHold.fill(NO_SIGNAL_DB);
		this.hitCount.fill(0);
		this.detectionAverage.fill(Number.NaN);
		this.binOffsets.fill(0.5);
		this.currentSums.fill(0);
		this.currentWeights.fill(0);
		this.updated.fill(0);
		this.candidates.length = 0;
		this.candidateState.clear();
		this.candidatesByPeakBucket.clear();
		this.changedCandidates.clear();
		this.removedCandidateIds.clear();
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
			// Plain mean until the bin has 1/alpha sweeps, so early sweeps are not weighted by the first one.
			const detectionAlpha = Math.max(DETECTION_AVERAGE_ALPHA, 1 / this.hitCount[index]);
			this.detectionAverage[index] = Number.isFinite(this.detectionAverage[index])
				? this.detectionAverage[index] + detectionAlpha * (value - this.detectionAverage[index])
				: value;
			this.updated[index] = 0;
			this.currentSums[index] = 0;
			this.currentWeights[index] = 0;
		}
		if (!hasSamples) return;
		this._sweepCount++;
		this.detectCandidates(Date.now());
	}

	private updateNoiseFloors(): void {
		for (let block = 0; block < this.blockFloors.length; block++) {
			this.noiseHistogram.fill(0);
			const start = block * NOISE_BLOCK_BINS;
			const end = Math.min(this.binCount, start + NOISE_BLOCK_BINS);
			let count = 0;
			for (let index = start; index < end; index++) {
				const value = this.detectionAverage[index];
				if (!Number.isFinite(value)) continue;
				const bucket = Math.max(0, Math.min(NOISE_HISTOGRAM_SIZE - 1, Math.floor(value + 160)));
				this.noiseHistogram[bucket]++;
				count++;
			}
			this.blockFloors[block] = Number.NaN;
			if (count === 0) continue;
			const target = Math.floor((count - 1) * BLOCK_FLOOR_PERCENTILE);
			let cumulative = 0;
			for (let bucket = 0; bucket < this.noiseHistogram.length; bucket++) {
				cumulative += this.noiseHistogram[bucket];
				if (cumulative > target) {
					this.blockFloors[block] = bucket - 160;
					break;
				}
			}
		}

		const halfWindow = this.floorHalfWindowBlocks;
		for (let block = 0; block < this.blockFloors.length; block++) {
			let count = 0;
			const first = Math.max(0, block - halfWindow);
			const last = Math.min(this.blockFloors.length - 1, block + halfWindow);
			for (let neighbour = first; neighbour <= last; neighbour++) {
				const value = this.blockFloors[neighbour];
				if (Number.isFinite(value)) this.floorWindow[count++] = value;
			}
			if (count === 0) {
				this.noiseFloors[block] = NO_SIGNAL_DB;
				continue;
			}
			const ranked = this.floorWindow.subarray(0, count).sort();
			const widebandFloor = ranked[Math.floor((count - 1) * WIDEBAND_FLOOR_PERCENTILE)];
			const ownFloor = this.blockFloors[block];
			this.noiseFloors[block] = Number.isFinite(ownFloor) ? Math.min(ownFloor, widebandFloor) : widebandFloor;
		}
	}

	private floorAt(index: number): number {
		return this.noiseFloors[Math.floor(index / NOISE_BLOCK_BINS)];
	}

	private binLowHz(index: number): number {
		const frequencyHz = this.config.startHz + (index + this.binOffsets[index] - 0.5) * this.resolutionHz;
		return Math.min(this.config.endHz, Math.max(this.config.startHz, frequencyHz));
	}

	private binHighHz(index: number): number {
		const frequencyHz = this.config.startHz + (index + this.binOffsets[index] + 0.5) * this.resolutionHz;
		return Math.min(this.config.endHz, Math.max(this.config.startHz, frequencyHz));
	}

	private interpolatedPeakHz(peakIndex: number, runStartHz: number, runEndHz: number): number {
		let fraction = 0;
		const left = this.current[peakIndex - 1];
		const centre = this.current[peakIndex];
		const right = this.current[peakIndex + 1];
		if (peakIndex > 0 && peakIndex < this.binCount - 1 && Number.isFinite(left) && Number.isFinite(right)
			&& Math.abs(this.binOffsets[peakIndex - 1] - this.binOffsets[peakIndex]) < 1e-3
			&& Math.abs(this.binOffsets[peakIndex + 1] - this.binOffsets[peakIndex]) < 1e-3) {
			const curvature = left - 2 * centre + right;
			if (curvature < 0) fraction = Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / curvature));
		}
		const frequencyHz = this.config.startHz + (peakIndex + this.binOffsets[peakIndex] + fraction) * this.resolutionHz;
		return Math.min(runEndHz, Math.max(runStartHz, frequencyHz));
	}

	private detectCandidates(now: number): void {
		this.updateNoiseFloors();
		const minSnrDb = this.config.minSnrDb;
		const immediateSnrDb = Math.max(minSnrDb, IMMEDIATE_DETECTION_SNR_DB);
		const runs: DetectionRun[] = [];
		let runStart = -1;
		let firstLevelBin = -1;
		let lastLevelBin = -1;
		let peakIndex = -1;
		let peakDb = NO_SIGNAL_DB;
		let measuredBins = 0;
		let currentActiveBins = 0;
		let averageConfirmed = false;
		let smoothingSum = 0;
		let smoothingCount = 0;
		for (let index = 0; index < Math.min(SMOOTHING_HALF_WIDTH_BINS, this.binCount); index++) {
			if (Number.isFinite(this.current[index])) {
				smoothingSum += this.current[index];
				smoothingCount++;
			}
		}
		for (let index = 0; index <= this.binCount; index++) {
			let currentActive = false;
			let averageActive = false;
			let bridged = false;
			if (index < this.binCount) {
				const entering = index + SMOOTHING_HALF_WIDTH_BINS;
				if (entering < this.binCount && Number.isFinite(this.current[entering])) {
					smoothingSum += this.current[entering];
					smoothingCount++;
				}
				const leaving = index - SMOOTHING_HALF_WIDTH_BINS - 1;
				if (leaving >= 0 && Number.isFinite(this.current[leaving])) {
					smoothingSum -= this.current[leaving];
					smoothingCount--;
				}
				const floor = this.floorAt(index);
				const value = this.current[index];
				currentActive = Number.isFinite(value) && value - floor >= minSnrDb;
				averageActive = this.hitCount[index] >= CONFIRMATION_MIN_SWEEPS
					&& this.detectionAverage[index] - floor >= minSnrDb;
				// The smoothed level and unmeasured bins (the skipped DC bins of a
				// manual capture) only bridge a run; they never set its edges.
				bridged = !Number.isFinite(value)
					|| (smoothingCount > 0 && smoothingSum / smoothingCount - floor >= minSnrDb);
			}
			const levelActive = currentActive || averageActive;
			if (levelActive || (bridged && runStart >= 0)) {
				if (runStart < 0) runStart = index;
				if (levelActive) {
					if (firstLevelBin < 0) firstLevelBin = index;
					lastLevelBin = index;
				}
				const value = this.current[index];
				if (Number.isFinite(value)) {
					measuredBins++;
					if (peakIndex < 0 || value > peakDb) {
						peakDb = value;
						peakIndex = index;
					}
				}
				if (currentActive) currentActiveBins++;
				if (averageActive) averageConfirmed = true;
				if (index < this.binCount) continue;
			}
			if (runStart < 0) continue;
			// A run must be present in this sweep, not only in the slower detection
			// average, so a signal that stopped does not keep collecting hits.
			if (peakIndex >= 0 && currentActiveBins > 0 && currentActiveBins * 4 >= measuredBins) {
				const noiseFloorDb = this.floorAt(peakIndex);
				const snrDb = peakDb - noiseFloorDb;
				if (averageConfirmed || snrDb >= immediateSnrDb) {
					const startHz = this.binLowHz(firstLevelBin);
					const endHz = this.binHighHz(lastLevelBin);
					if (endHz > startHz) {
						const peakFrequencyHz = this.interpolatedPeakHz(peakIndex, startHz, endHz);
						runs.push({ startHz, endHz, peakFrequencyHz, peakDb, noiseFloorDb, snrDb });
					}
				}
			}
			runStart = -1;
			firstLevelBin = -1;
			lastLevelBin = -1;
			peakIndex = -1;
			peakDb = NO_SIGNAL_DB;
			measuredBins = 0;
			currentActiveBins = 0;
			averageConfirmed = false;
		}

		// The strongest detections claim existing candidates first, so a weaker run
		// beside a carrier cannot take the carrier's identity.
		runs.sort((a, b) => b.snrDb - a.snrDb || a.peakFrequencyHz - b.peakFrequencyHz);
		for (const run of runs) {
			const match = this.nearestPeakCandidate(run) ?? this.overlappingCandidate(run);
			if (match) this.updateCandidate(match, run, now);
			else this.createCandidate(run, now);
		}
	}

	private isUnmatched(candidate: SweepCandidate): boolean {
		const state = this.candidateState.get(candidate.id);
		return state !== undefined && state.sweep !== this._sweepCount;
	}

	private nearestPeakCandidate(run: DetectionRun): SweepCandidate | null {
		const bucket = peakBucket(run.peakFrequencyHz);
		let best: SweepCandidate | null = null;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let neighbour = bucket - 1; neighbour <= bucket + 1; neighbour++) {
			for (const candidate of this.candidatesByPeakBucket.get(neighbour) ?? []) {
				if (!this.isUnmatched(candidate)) continue;
				const distance = Math.abs(run.peakFrequencyHz - (this.candidateState.get(candidate.id)?.lastPeakFrequencyHz ?? Number.NaN));
				if (!(distance <= SWEEP_CANDIDATE_PEAK_TOLERANCE_HZ)) continue;
				if (distance < bestDistance || (distance === bestDistance && best !== null && candidate.id < best.id)) {
					best = candidate;
					bestDistance = distance;
				}
			}
		}
		return best;
	}

	// Wideband signals have no stable peak, so they keep their identity through
	// band overlap instead: at least half of both the run and the candidate.
	private overlappingCandidate(run: DetectionRun): SweepCandidate | null {
		const runWidthHz = run.endHz - run.startHz;
		let best: SweepCandidate | null = null;
		let bestOverlapHz = 0;
		for (const candidate of this.candidates) {
			if (!this.isUnmatched(candidate)) continue;
			const overlapHz = Math.min(run.endHz, candidate.endHz) - Math.max(run.startHz, candidate.startHz);
			if (overlapHz * 2 < runWidthHz || overlapHz * 2 < candidate.bandwidthHz) continue;
			if (overlapHz > bestOverlapHz) {
				best = candidate;
				bestOverlapHz = overlapHz;
			}
		}
		return best;
	}

	private bandContact(candidate: SweepCandidate, run: DetectionRun): boolean {
		const marginHz = BAND_CONTACT_BINS * this.resolutionHz;
		return run.startHz <= candidate.endHz + marginHz && run.endHz >= candidate.startHz - marginHz;
	}

	private updateCandidate(candidate: SweepCandidate, run: DetectionRun, now: number): void {
		const state = this.candidateState.get(candidate.id);
		if (!state) return;
		if (this.bandContact(candidate, run)) {
			candidate.startHz = Math.min(candidate.startHz, run.startHz);
			candidate.endHz = Math.max(candidate.endHz, run.endHz);
		} else {
			// A peak that moved away from the band only extends it to the peak itself.
			candidate.startHz = Math.min(candidate.startHz, run.peakFrequencyHz);
			candidate.endHz = Math.max(candidate.endHz, run.peakFrequencyHz);
		}
		candidate.centerHz = (candidate.startHz + candidate.endHz) / 2;
		candidate.bandwidthHz = candidate.endHz - candidate.startHz;
		candidate.meanPeakFrequencyHz += (run.peakFrequencyHz - candidate.meanPeakFrequencyHz) / (candidate.hits + 1);
		candidate.minPeakFrequencyHz = Math.min(candidate.minPeakFrequencyHz, run.peakFrequencyHz);
		candidate.maxPeakFrequencyHz = Math.max(candidate.maxPeakFrequencyHz, run.peakFrequencyHz);
		candidate.meanPeakFrequencyHz = Math.min(candidate.maxPeakFrequencyHz, Math.max(candidate.minPeakFrequencyHz, candidate.meanPeakFrequencyHz));
		if (run.peakDb > candidate.peakDb) {
			candidate.peakDb = run.peakDb;
			candidate.peakFrequencyHz = run.peakFrequencyHz;
		}
		candidate.noiseFloorDb = Math.min(candidate.noiseFloorDb, run.noiseFloorDb);
		candidate.snrDb = candidate.peakDb - candidate.noiseFloorDb;
		candidate.lastSeen = now;
		candidate.hits++;
		state.sweep = this._sweepCount;
		state.lastPeakFrequencyHz = run.peakFrequencyHz;
		const bucket = peakBucket(run.peakFrequencyHz);
		if (bucket !== state.bucket) {
			this.removeCandidateFromPeakIndex(candidate, state.bucket);
			state.bucket = bucket;
			this.addCandidateToPeakIndex(candidate, bucket);
		}
		this.changedCandidates.set(candidate.id, candidate);
	}

	private createCandidate(run: DetectionRun, now: number): void {
		if (this.candidates.length >= SWEEP_MAX_CANDIDATES) this.evictLeastRecentlySeen();
		const candidate: SweepCandidate = {
			id: this.nextCandidateId++,
			startHz: run.startHz,
			endHz: run.endHz,
			centerHz: (run.startHz + run.endHz) / 2,
			bandwidthHz: run.endHz - run.startHz,
			peakFrequencyHz: run.peakFrequencyHz,
			meanPeakFrequencyHz: run.peakFrequencyHz,
			minPeakFrequencyHz: run.peakFrequencyHz,
			maxPeakFrequencyHz: run.peakFrequencyHz,
			peakDb: run.peakDb,
			noiseFloorDb: run.noiseFloorDb,
			snrDb: run.snrDb,
			firstSeen: now,
			lastSeen: now,
			hits: 1,
		};
		const bucket = peakBucket(run.peakFrequencyHz);
		this.candidates.push(candidate);
		this.candidateState.set(candidate.id, { sweep: this._sweepCount, lastPeakFrequencyHz: run.peakFrequencyHz, bucket });
		this.addCandidateToPeakIndex(candidate, bucket);
		this.changedCandidates.set(candidate.id, candidate);
	}

	private evictLeastRecentlySeen(): void {
		let oldest = 0;
		for (let index = 1; index < this.candidates.length; index++) {
			const candidate = this.candidates[index];
			const current = this.candidates[oldest];
			if (candidate.lastSeen < current.lastSeen
				|| (candidate.lastSeen === current.lastSeen && candidate.hits < current.hits)) oldest = index;
		}
		const [evicted] = this.candidates.splice(oldest, 1);
		if (!evicted) return;
		const state = this.candidateState.get(evicted.id);
		if (state) this.removeCandidateFromPeakIndex(evicted, state.bucket);
		this.candidateState.delete(evicted.id);
		this.changedCandidates.delete(evicted.id);
		this.removedCandidateIds.add(evicted.id);
	}

	private addCandidateToPeakIndex(candidate: SweepCandidate, bucket: number): void {
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
