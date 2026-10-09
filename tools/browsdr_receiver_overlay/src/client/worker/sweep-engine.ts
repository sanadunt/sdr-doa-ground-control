import { FFT } from './wasm-init';
import { processSpectrumFft } from './iq-spectrum';
import { SweepBlockParser } from './sweep-parser';
import { SweepAccumulator } from './sweep-processing';
import {
	SWEEP_BASEBAND_FILTER_BW_HZ,
	SWEEP_BLOCK_BYTES,
	SWEEP_HEADER_BYTES,
	SWEEP_MAX_FREQUENCY_HZ,
	SWEEP_OFFSET_HZ,
	SWEEP_SAMPLE_RATE_HZ,
	SWEEP_TUNE_STEP_HZ,
	validateSweepConfig,
} from './sweep-types';
import type { SweepConfig, SweepEngine, SweepEngineCallbacks, SweepSource } from './sweep-types';
import { isHackRFSweepDevice } from '../sdr-device';
import type { HackRFSweepDevice } from '../sdr-device';

const IQ_SAMPLES_PER_BLOCK = (SWEEP_BLOCK_BYTES - SWEEP_HEADER_BYTES) >>> 1;
const REPORT_INTERVAL_MS = 100;
const MANUAL_TUNE_STEP_HZ = SWEEP_SAMPLE_RATE_HZ * 0.5;
const MANUAL_SETTLING_TRANSFERS = 1;
const MANUAL_USABLE_BANDWIDTH_HZ = SWEEP_BASEBAND_FILTER_BW_HZ;

abstract class SpectrumSweepEngine implements SweepEngine {
	protected config!: SweepConfig;
	protected accumulator!: SweepAccumulator;
	protected fft!: FFT;
	protected iqInput!: Int8Array;
	protected fftOutput!: Float32Array;
	protected running = false;
	protected currentFrequencyHz = 0;
	protected receivedBytes = 0;

	private sourceStarted = false;
	private reportTimer: number | null = null;
	private stopPromise: Promise<void> | null = null;
	private startPromise: Promise<void> | null = null;
	private startedAt = 0;
	private lastReportAt = 0;
	private lastReportedBytes = 0;
	private lastReportedSweep = -1;

	constructor(protected readonly callbacks: SweepEngineCallbacks) {}
	protected get usesFft(): boolean {
		return true;
	}

	async start(config: SweepConfig): Promise<void> {
		if (this.sourceStarted) throw new Error('Sweep engine is already running');
		validateSweepConfig(config);
		this.config = config;
		this.accumulator = new SweepAccumulator(config);
		if (this.usesFft) {
			const window = new Float32Array(config.fftSize);
			for (let i = 0; i < window.length; i++) {
				window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (window.length - 1)));
			}
			this.fft = new FFT(config.fftSize, window);
			this.fft.set_smoothing_speed(1);
			this.iqInput = new Int8Array(config.fftSize * 2);
			this.fftOutput = new Float32Array(config.fftSize);
		}
		this.running = true;
		this.sourceStarted = true;
		this.startedAt = performance.now();
		this.lastReportAt = this.startedAt;
		this.reportTimer = setInterval(() => this.report(), REPORT_INTERVAL_MS);
		try {
			const startPromise = this.startSource();
			this.startPromise = startPromise;
			await startPromise;
		} catch (error) {
			await this.stop().catch(() => {});
			throw error;
		} finally {
			this.startPromise = null;
		}
	}

	async stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		if (!this.sourceStarted) return;
		this.running = false;
		this.sourceStarted = false;
		if (this.reportTimer) {
			clearInterval(this.reportTimer);
			this.reportTimer = null;
		}
		const startPromise = this.startPromise;
		this.stopPromise = (async () => {
			try {
				await startPromise?.catch(() => {});
				await this.stopSource();
			} finally {
				this.report(true);
				this.stopPromise = null;
			}
		})();
		return this.stopPromise;
	}

	clear(): void {
		if (!this.sourceStarted) return;
		this.accumulator.clear();
		this.lastReportedSweep = -1;
		this.callbacks.onCandidates([]);
		this.callbacks.onSpectrum(this.accumulator.createFrame());
	}

	protected abstract startSource(): Promise<void>;
	protected abstract stopSource(): Promise<void>;

	protected reportError(error: unknown): void {
		if (!this.running) return;
		const message = error instanceof Error ? error.message : String(error);
		try {
			this.callbacks.onError(message);
		} catch (callbackError) {
			console.error('Sweep error callback failed:', callbackError);
		}
		void this.stop().catch(stopError => console.error('Failed to stop sweep after an error:', stopError));
	}

	protected report(force = false): void {
		if (!this.running && !force) return;
		const now = performance.now();
		const elapsedMs = Math.max(1, now - this.startedAt);
		const intervalMs = Math.max(1, now - this.lastReportAt);
		const sweepCount = this.accumulator.sweepCount;
		try {
			this.callbacks.onProgress({
				sweepCount,
				sweepsPerSecond: sweepCount * 1000 / elapsedMs,
				currentFrequencyHz: this.currentFrequencyHz,
				bytesPerSecond: (this.receivedBytes - this.lastReportedBytes) * 1000 / intervalMs,
				detectedCount: this.accumulator.candidateCount,
				discardedBytes: this.discardedBytes(),
			});
			this.callbacks.onSpectrum(this.accumulator.createFrame());
			if (sweepCount !== this.lastReportedSweep) {
				this.lastReportedSweep = sweepCount;
				this.callbacks.onCandidates(this.accumulator.getChangedCandidates());
			}
		} catch (error) {
			this.reportError(error);
		}
		this.lastReportAt = now;
		this.lastReportedBytes = this.receivedBytes;
	}

	protected discardedBytes(): number {
		return 0;
	}
}

export class NativeHackRFSweepEngine extends SpectrumSweepEngine {
	private readonly parser = new SweepBlockParser();
	private firstTagHz = 0;
	private groupFrequencyHz = Number.NaN;
	private lastTagHz = Number.NaN;
	private collectedSamples = 0;
	private groupProcessed = false;

	constructor(private readonly device: HackRFSweepDevice, callbacks: SweepEngineCallbacks) {
		super(callbacks);
	}

	protected override async startSource(): Promise<void> {
		if (!this.device.nativeSweepSupported) throw new Error('Native HackRF sweep requires USB API 1.4 or newer');
		const startMHz = Math.floor(this.config.startHz / 1_000_000);
		const requestedEndMHz = Math.ceil(this.config.endHz / 1_000_000);
		const stepMHz = SWEEP_TUNE_STEP_HZ / 1_000_000;
		const stopMHz = startMHz + Math.ceil((requestedEndMHz - startMHz) / stepMHz) * stepMHz;
		if (stopMHz > 7250) throw new RangeError('Native sweep needs up to 20 MHz of tuning margin below 7250 MHz');
		this.firstTagHz = startMHz * 1_000_000;
		await this.device.stopRx();
		await this.device.setAntennaEnable(false);
		await this.device.setSampleRate(SWEEP_SAMPLE_RATE_HZ);
		if (!this.device.setBandwidth) throw new Error('HackRF sweep requires baseband filter control');
		await this.device.setBandwidth(SWEEP_BASEBAND_FILTER_BW_HZ);
		await this.device.setGain('LNA', this.config.lnaGain);
		await this.device.setGain('VGA', this.config.vgaGain);
		await this.device.setGain('Amp (14dB)', this.config.ampEnabled ? 1 : 0);
		const blocksPerTune = Math.ceil(this.config.fftSize / IQ_SAMPLES_PER_BLOCK);
		await this.device.initSweep(
			[startMHz, stopMHz],
			blocksPerTune * SWEEP_BLOCK_BYTES,
			SWEEP_TUNE_STEP_HZ,
			SWEEP_OFFSET_HZ,
			1,
		);
		await this.device.startRxSweep(data => this.onTransfer(data), error => this.reportError(error));
	}

	protected override async stopSource(): Promise<void> {
		this.parser.reset();
		await this.device.stopRxSweep();
	}

	protected override discardedBytes(): number {
		return this.parser.discardedBytes;
	}

	private onTransfer(data: ArrayBufferView): void {
		if (!this.running) return;
		this.receivedBytes += data.byteLength;
		const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		try {
			this.parser.push(bytes, (frequencyHz, buffer, iqOffset) => this.onBlock(frequencyHz, buffer, iqOffset));
		} catch (error) {
			this.reportError(error);
		}
	}

	private onBlock(frequencyHz: number, buffer: Uint8Array, iqOffset: number): void {
		this.currentFrequencyHz = frequencyHz + SWEEP_OFFSET_HZ;
		if (frequencyHz === this.firstTagHz && (this.lastTagHz !== this.firstTagHz || this.groupProcessed)) {
			this.accumulator.beginSweep();
			this.groupFrequencyHz = Number.NaN;
			this.collectedSamples = 0;
			this.groupProcessed = false;
		}
		if (frequencyHz !== this.groupFrequencyHz) {
			this.groupFrequencyHz = frequencyHz;
			this.collectedSamples = 0;
			this.groupProcessed = false;
		}
		if (!this.groupProcessed) {
			const availableSamples = Math.min(IQ_SAMPLES_PER_BLOCK, this.config.fftSize - this.collectedSamples);
			const sourceEnd = iqOffset + availableSamples * 2;
			const source = new Int8Array(buffer.buffer, buffer.byteOffset + iqOffset, sourceEnd - iqOffset);
			this.iqInput.set(source, this.collectedSamples * 2);
			this.collectedSamples += availableSamples;
			if (this.collectedSamples >= this.config.fftSize) {
				processSpectrumFft(this.fft, this.iqInput, this.fftOutput, this.config.iqCorrection);
				this.accumulator.addNativeFft(frequencyHz, this.fftOutput);
				this.groupProcessed = true;
			}
		}
		this.lastTagHz = frequencyHz;
	}
}

export class ManualSweepEngine extends SpectrumSweepEngine {
	private runPromise: Promise<void> | null = null;
	private cancelCapture: (() => void) | null = null;
	private receiverStopped = false;

	constructor(private readonly device: HackRFSweepDevice, callbacks: SweepEngineCallbacks) {
		super(callbacks);
	}

	protected override async startSource(): Promise<void> {
		await this.device.stopRx();
		this.receiverStopped = true;
		await this.device.setAntennaEnable(false);
		await this.device.setSampleRate(SWEEP_SAMPLE_RATE_HZ);
		if (!this.device.setBandwidth) throw new Error('HackRF sweep requires baseband filter control');
		await this.device.setBandwidth(SWEEP_BASEBAND_FILTER_BW_HZ);
		await this.device.setGain('LNA', this.config.lnaGain);
		await this.device.setGain('VGA', this.config.vgaGain);
		await this.device.setGain('Amp (14dB)', this.config.ampEnabled ? 1 : 0);
		this.runPromise = this.runLoop().catch(error => this.reportError(error));
	}

	protected override async stopSource(): Promise<void> {
		this.cancelCapture?.();
		if (this.runPromise) {
			await this.runPromise;
			this.runPromise = null;
		}
		await this.stopReceiver();
	}

	private async stopReceiver(): Promise<void> {
		if (this.receiverStopped) return;
		await this.device.stopRx();
		this.receiverStopped = true;
	}

	private async runLoop(): Promise<void> {
		const firstCenterHz = this.config.startHz + MANUAL_USABLE_BANDWIDTH_HZ / 2;
		for (;;) {
			if (!this.running) return;
			this.accumulator.beginSweep();
			let completed = true;
			for (
				let centerHz = firstCenterHz;
				centerHz - MANUAL_USABLE_BANDWIDTH_HZ / 2 < this.config.endHz;
				centerHz += MANUAL_TUNE_STEP_HZ
			) {
				if (!this.running) {
					completed = false;
					break;
				}
				await this.stopReceiver();
				if (!this.running) {
					completed = false;
					break;
				}
				const tuneFrequencyHz = Math.min(centerHz, SWEEP_MAX_FREQUENCY_HZ);
				await this.device.setFrequency(tuneFrequencyHz);
				if (!this.running) {
					completed = false;
					break;
				}
				this.currentFrequencyHz = tuneFrequencyHz;
				let captured = false;
				try {
					captured = await this.captureAt(tuneFrequencyHz);
				} finally {
					await this.stopReceiver();
				}
				if (!captured) {
					completed = false;
					break;
				}
				if (centerHz + MANUAL_USABLE_BANDWIDTH_HZ / 2 >= this.config.endHz) break;
			}
			if (!completed) return;
			this.accumulator.finishSweep();
		}
	}

	private async captureAt(centerHz: number): Promise<boolean> {
		let resolveCapture!: (captured: boolean) => void;
		let capturedSamples = 0;
		let settlingTransfers = MANUAL_SETTLING_TRANSFERS;
		let settled = false;
		const capture = new Promise<boolean>(resolve => { resolveCapture = resolve; });
		const finish = (captured: boolean): void => {
			if (settled) return;
			settled = true;
			this.cancelCapture = null;
			resolveCapture(captured);
		};
		this.cancelCapture = () => finish(false);
		this.receiverStopped = false;
		await this.device.startRx(data => {
			if (!this.running || settled) return;
			const source = new Int8Array(data.buffer, data.byteOffset, data.byteLength);
			this.receivedBytes += source.byteLength;
			if (settlingTransfers > 0) {
				settlingTransfers--;
				return;
			}
			const bytesNeeded = this.iqInput.length - capturedSamples * 2;
			const bytesCopied = Math.min(bytesNeeded, source.length) & ~1;
			this.iqInput.set(source.subarray(0, bytesCopied), capturedSamples * 2);
			capturedSamples += bytesCopied >>> 1;
			if (capturedSamples >= this.config.fftSize) {
				processSpectrumFft(this.fft, this.iqInput, this.fftOutput, this.config.iqCorrection);
				this.accumulator.addManualFft(centerHz, this.fftOutput);
				finish(true);
			}
		});
		return capture;
	}
}

export class SimulatedSweepEngine extends SpectrumSweepEngine {
	private simulationTimer: number | null = null;
	private noiseState = 0x6d2b79f5;

	protected override get usesFft(): boolean {
		return false;
	}

	protected override async startSource(): Promise<void> {
		this.generateSweep();
		this.simulationTimer = setInterval(() => this.generateSweep(), 500);
	}

	protected override async stopSource(): Promise<void> {
		if (this.simulationTimer) {
			clearInterval(this.simulationTimer);
			this.simulationTimer = null;
		}
	}

	private generateSweep(): void {
		if (!this.running) return;
		const startHz = this.config.startHz;
		const spanHz = this.config.endHz - startHz;
		const intermittentOn = this.accumulator.sweepCount % 2 === 0;
		this.accumulator.beginSweep();
		for (let index = 0; index < this.accumulator.binCount; index++) {
			const frequencyHz = startHz + (index + 0.5) * this.accumulator.resolutionHz;
			this.noiseState = (this.noiseState * 1664525 + 1013904223) >>> 0;
			let powerDb = -94 + (this.noiseState / 0x1_0000_0000) * 6;
			powerDb = this.addSimulatedSignal(powerDb, frequencyHz, startHz + spanHz * 0.18, spanHz * 0.0008, -38);
			powerDb = this.addSimulatedSignal(powerDb, frequencyHz, startHz + spanHz * 0.44, spanHz * 0.009, -53);
			powerDb = this.addSimulatedSignal(
				powerDb,
				frequencyHz,
				startHz + spanHz / 2,
				Math.max(this.accumulator.resolutionHz * 4, spanHz * 0.00005),
				-22,
			);
			if (intermittentOn) {
				powerDb = this.addSimulatedSignal(powerDb, frequencyHz, startHz + spanHz * 0.73, spanHz * 0.0015, -42);
			}
			this.accumulator.addSample(frequencyHz, powerDb);
		}
		this.accumulator.finishSweep();
		this.currentFrequencyHz = this.config.endHz;
	}

	private addSimulatedSignal(noiseDb: number, frequencyHz: number, centerHz: number, bandwidthHz: number, peakDb: number): number {
		const distance = Math.abs(frequencyHz - centerHz);
		if (distance >= bandwidthHz / 2) return noiseDb;
		const signalDb = peakDb - 12 * distance / (bandwidthHz / 2);
		return Math.max(noiseDb, signalDb);
	}
}

export function createSweepEngine(source: SweepSource, device: HackRFSweepDevice | null, callbacks: SweepEngineCallbacks): SweepEngine {
	if (source === 'simulated') return new SimulatedSweepEngine(callbacks);
	if (!device || !isHackRFSweepDevice(device)) throw new Error('Connect a HackRF to start a hardware sweep');
	if (source === 'native') {
		if (!device.nativeSweepSupported) throw new Error('Native HackRF sweep requires USB API 1.4 or newer; select Manual mode instead');
		return new NativeHackRFSweepEngine(device, callbacks);
	}
	return new ManualSweepEngine(device, callbacks);
}
