export const SWEEP_SAMPLE_RATE_HZ = 20_000_000;
export const SWEEP_BASEBAND_FILTER_BW_HZ = SWEEP_SAMPLE_RATE_HZ * 0.75;
export const SWEEP_MIN_FREQUENCY_HZ = 1_000_000;
export const SWEEP_MAX_FREQUENCY_HZ = 7_250_000_000;
export const SWEEP_TUNE_STEP_HZ = 20_000_000;
export const SWEEP_OFFSET_HZ = 7_500_000;
export const SWEEP_BLOCK_BYTES = 16_384;
export const SWEEP_HEADER_BYTES = 10;
export const SWEEP_MAX_BINS = 500_000;
export const SWEEP_CANDIDATE_PEAK_TOLERANCE_HZ = 50_000;
export const SWEEP_DISPLAY_BINS = 2_048;

export type SweepSource = 'native' | 'manual' | 'simulated';
export type SweepSpectrumView = 'current' | 'average' | 'max';

export interface SweepConfig {
	startHz: number;
	endHz: number;
	fftSize: 4096 | 8192;
	minSnrDb: number;
	averageAlpha: number;
	lnaGain: number;
	vgaGain: number;
	ampEnabled: boolean;
	iqCorrection: boolean;
}

export interface SweepSpectrumFrame {
	startHz: number;
	endHz: number;
	resolutionHz: number;
	sweepCount: number;
	current: Float32Array;
	average: Float32Array;
	maxHold: Float32Array;
}

export interface SweepProgress {
	sweepCount: number;
	sweepsPerSecond: number;
	currentFrequencyHz: number;
	bytesPerSecond: number;
	detectedCount: number;
	discardedBytes: number;
}

export interface SweepCandidate {
	id: number;
	startHz: number;
	endHz: number;
	centerHz: number;
	peakFrequencyHz: number;
	meanPeakFrequencyHz: number;
	minPeakFrequencyHz: number;
	maxPeakFrequencyHz: number;
	bandwidthHz: number;
	peakDb: number;
	noiseFloorDb: number;
	snrDb: number;
	firstSeen: number;
	lastSeen: number;
	hits: number;
	peakRangeStartHz?: number;
	peakRangeEndHz?: number;
	peakRangeCenterHz?: number;
}

export interface SweepEngineCallbacks {
	onSpectrum(frame: SweepSpectrumFrame): void;
	onProgress(progress: SweepProgress): void;
	onCandidates(candidates: SweepCandidate[]): void;
	onError(error: string): void;
}

export interface SweepEngine {
	start(config: SweepConfig): Promise<void>;
	stop(): Promise<void>;
	clear(): void;
}

export function validateSweepConfig(config: SweepConfig): void {
	if (!Number.isFinite(config.startHz) || !Number.isFinite(config.endHz)
		|| config.startHz < SWEEP_MIN_FREQUENCY_HZ
		|| config.endHz > SWEEP_MAX_FREQUENCY_HZ
		|| config.startHz >= config.endHz) {
		throw new RangeError('Sweep range must be increasing and within 1–7250 MHz');
	}

	if (typeof config.iqCorrection !== 'boolean') {
		throw new TypeError('IQ correction setting must be boolean');
	}
	if (config.fftSize !== 4096 && config.fftSize !== 8192) {
		throw new RangeError('Sweep FFT size must be 4096 or 8192');
	}
	if (!Number.isFinite(config.minSnrDb) || config.minSnrDb < 1 || config.minSnrDb > 60) {
		throw new RangeError('Detection SNR threshold must be between 1 and 60 dB');
	}
	if (!Number.isFinite(config.averageAlpha) || config.averageAlpha < 0.01 || config.averageAlpha > 1) {
		throw new RangeError('Averaging must be between 0.01 and 1');
	}
	if (!Number.isInteger(config.lnaGain) || config.lnaGain < 0 || config.lnaGain > 40 || config.lnaGain % 8 !== 0) {
		throw new RangeError('LNA gain must be a multiple of 8 dB from 0 to 40 dB');
	}
	if (!Number.isInteger(config.vgaGain) || config.vgaGain < 0 || config.vgaGain > 62 || config.vgaGain % 2 !== 0) {
		throw new RangeError('VGA gain must be an even value from 0 to 62 dB');
	}
	const resolutionHz = SWEEP_SAMPLE_RATE_HZ / config.fftSize;
	if (Math.ceil((config.endHz - config.startHz) / resolutionHz) > SWEEP_MAX_BINS) {
		throw new RangeError(`Sweep range exceeds the ${SWEEP_MAX_BINS.toLocaleString()}-bin memory limit; use 4.9 kHz resolution or a narrower span`);
	}
}
