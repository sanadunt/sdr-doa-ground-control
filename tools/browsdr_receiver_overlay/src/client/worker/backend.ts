/*
Copyright (c) 2026, jLynx <https://github.com/jLynx>

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
	Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
	Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the
	documentation and/or other materials provided with the distribution.
	Neither the name of Great Scott Gadgets nor the names of its contributors may be used to endorse or promote products derived from this software
	without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import * as Comlink from 'comlink';
import { ensureWasmInitialized, init } from './wasm-init';
import { MockHackRF } from './mock-hackrf';
import type { SdrDevice, SdrDeviceInfo, DeviceCapabilities } from '../sdr-device';
import { detectDevice, isHackRFSweepDevice } from '../sdr-device';
import { createSweepEngine } from './sweep-engine';
import type { SweepConfig, SweepEngine, SweepSource, SweepCandidate, SweepProgress, SweepSpectrumFrame } from './sweep-types';
// Import device drivers so they self-register
import '../devices/hackrf';
import '../devices/rtlsdr';
import '../devices/airspy';
import '../devices/airspyhf';
import {
	setRemoteHostCallback,
	setRemoteHostFftCallback,
	setRemoteHostAudioCallback,
	setRemoteHostPocsagCallback,
	setRemoteHostSquelchCallback,
	_ensureRemoteClients,
	_getOrCreateClientState,
	addRemoteClient,
	removeRemoteClient,
	setRemoteVfoParams,
	addRemoteVfo,
	removeRemoteVfo,
	_queueRemoteAudio,
	_mixAndEmitRemoteAudio,
	_reinitRemoteClientWorkers,
	initRemoteClient,
	feedRemoteAudioChunk,
} from './remote-clients';
import { startRxStream } from './rx-stream';
import type { VfoParams, VfoState, PerfCounters, RxStreamOpts, RemoteClientState, DeviceOpenOpts } from './types';
import { displayToDeviceFrequencyHz } from '../frequency-shift';

export class Backend {
	// Hardware — generic SDR device
	device: SdrDevice | null = null;
	wasm: any;

	private sweepEngine: SweepEngine | null = null;

	// VFO state
	vfoParams?: VfoParams[];
	vfoStates?: VfoState[];
	dspWorkers?: Worker[];
	ddcs?: any[];

	// Shared IQ buffers
	sharedIqPools?: (SharedArrayBuffer | ArrayBuffer)[];
	sharedIqViews?: Int8Array[];
	sabPoolIndex?: number;

	// DSP perf
	_perf?: PerfCounters;
	_perfInterval?: any;

	// Internal state
	_sampleRate?: number;
	_centerFreq?: number;
	_makeVfoState?: () => VfoState;
	_spawnWorker?: (index: number, params: VfoParams) => Worker;
	_handleWorkerAudio?: (v: number, msg: any) => void;
	_setSpectrumIqCorrection?: (enabled: boolean) => void;
	_mixBuf?: Float32Array;
	_latchedSquelchOpen?: boolean[];

	// Remote client state
	_remoteHostCb?: any;
	_remoteHostFftCb?: any;
	_remoteHostAudioCb?: any;
	_remoteClients?: Map<string, RemoteClientState>;
	_remoteHostPocsagCb?: any;
	_remoteHostSquelchCb?: any;
	_remoteClientCb?: any;
	_remoteClientAudioCb?: any;
	_remoteClientWhisperCb?: any;

	constructor() {
	}

	async init(): Promise<void> {
		await ensureWasmInitialized();
		this.wasm = await init();
	}

	async open(opts?: DeviceOpenOpts | "mock"): Promise<boolean> {
		if (opts === "mock") {
			this.device = new MockHackRF();
			await this.device.open(null as any);
			return true;
		}

		const devices = await (navigator as any).usb.getDevices();
		const usbDevice = !opts ? devices[0] : devices.find((d: any) => {
			if (opts.vendorId && d.vendorId !== opts.vendorId) return false;
			if (opts.productId && d.productId !== opts.productId) return false;
			if (opts.serialNumber && d.serialNumber !== opts.serialNumber) return false;
			return true;
		});
		if (!usbDevice) {
			return false;
		}

		// Detect which driver matches this USB device
		const driverEntry = detectDevice(usbDevice);
		if (!driverEntry) {
			console.error('No SDR driver found for device:', usbDevice.vendorId.toString(16), usbDevice.productId.toString(16));
			return false;
		}

		this.device = driverEntry.create();
		await this.device.open(usbDevice);
		return true;
	}

	async info(): Promise<SdrDeviceInfo> {
		if (!this.device) throw new Error('No device connected');
		return this.device.getInfo();
	}

	getDeviceCapabilities(): DeviceCapabilities | null {
		if (!this.device) return null;
		const sweepDevice = isHackRFSweepDevice(this.device) ? this.device : null;
		return {
			deviceType: this.device.deviceType,
			sampleRates: this.device.sampleRates,
			gainControls: this.device.gainControls,
			sampleFormat: this.device.sampleFormat,
			supportsManualSweep: sweepDevice !== null,
			supportsNativeSweep: sweepDevice?.nativeSweepSupported ?? false,
		};
	}

	// Remote client methods (imported from remote-clients.ts)
	setRemoteHostCallback = setRemoteHostCallback.bind(this);
	setRemoteHostFftCallback = setRemoteHostFftCallback.bind(this);
	setRemoteHostAudioCallback = setRemoteHostAudioCallback.bind(this);
	setRemoteHostPocsagCallback = setRemoteHostPocsagCallback.bind(this);
	setRemoteHostSquelchCallback = setRemoteHostSquelchCallback.bind(this);
	_ensureRemoteClients = _ensureRemoteClients.bind(this);
	_getOrCreateClientState = _getOrCreateClientState.bind(this);
	addRemoteClient = addRemoteClient.bind(this);
	removeRemoteClient = removeRemoteClient.bind(this);
	setRemoteVfoParams = setRemoteVfoParams.bind(this);
	addRemoteVfo = addRemoteVfo.bind(this);
	removeRemoteVfo = removeRemoteVfo.bind(this);
	_queueRemoteAudio = _queueRemoteAudio.bind(this);
	_mixAndEmitRemoteAudio = _mixAndEmitRemoteAudio.bind(this);
	_reinitRemoteClientWorkers = _reinitRemoteClientWorkers.bind(this);
	initRemoteClient = initRemoteClient.bind(this);
	feedRemoteAudioChunk = feedRemoteAudioChunk.bind(this);

	async startRxStream(
		opts: RxStreamOpts,
		spectrumCallback: (spectrumData: Float32Array) => void,
		audioCallback: (audioSamples: Float32Array) => void,
		whisperCallback: ((vfoIndex: number, frequencyHz: number, samples: Float32Array) => void) | null = null,
		pocsagCallback: ((vfoIndex: number, frequencyHz: number, message: unknown) => void) | null = null,
	): Promise<void> {
		if (this.sweepEngine) throw new Error('Stop the active sweep before starting Receiver mode');
		return startRxStream(this, opts, spectrumCallback, audioCallback, whisperCallback, pocsagCallback);
	}

	setSpectrumIqCorrection(enabled: boolean): void {
		this._setSpectrumIqCorrection?.(enabled);
	}

	async startSweep(
		source: SweepSource,
		config: SweepConfig,
		spectrumCallback: (frame: SweepSpectrumFrame) => void,
		progressCallback: (progress: SweepProgress) => void,
		candidatesCallback: (candidates: SweepCandidate[]) => void,
		errorCallback: (error: string) => void,
	): Promise<void> {
		if (this.sweepEngine) throw new Error('A sweep is already active');
		const sweepDevice = source !== 'simulated' && this.device && isHackRFSweepDevice(this.device)
			? this.device
			: null;
		const engine = createSweepEngine(source, sweepDevice, {
			onSpectrum: frame => {
				const transferList: Transferable[] = [
					frame.current.buffer as ArrayBuffer,
					frame.average.buffer as ArrayBuffer,
					frame.maxHold.buffer as ArrayBuffer,
				];
				spectrumCallback(Comlink.transfer(frame, transferList));
			},
			onProgress: progress => progressCallback(progress),
			onCandidates: candidates => candidatesCallback(candidates),
			onError: error => errorCallback(error),
		});
		this.sweepEngine = engine;
		try {
			await engine.start(config);
		} catch (error) {
			if (this.sweepEngine === engine) this.sweepEngine = null;
			throw error;
		}
	}

	async stopSweep(): Promise<void> {
		const engine = this.sweepEngine;
		if (!engine) return;
		try {
			await engine.stop();
		} finally {
			if (this.sweepEngine === engine) this.sweepEngine = null;
		}
	}

	clearSweep(): void {
		this.sweepEngine?.clear();
	}

	getDspStats(): any {
		if (!this._perf) return null;

		const currentSquelch = this.vfoStates ? this.vfoStates.map(s => s.squelchOpen || false) : [];
		const latchedSquelch = this._latchedSquelchOpen || [];
		const combinedSquelch = currentSquelch.map((sq, i) => sq || latchedSquelch[i]);

		this._latchedSquelchOpen = [...currentSquelch];

		return {
			...this._perf.report,
			squelchOpen: combinedSquelch,
			squelchDb: this.vfoStates ? this.vfoStates.map(s => s.squelchDb ?? -120) : [],
		};
	}

	setVfoParams(index: number, params: Partial<VfoParams>): void {
		if (!this.vfoParams || index < 0 || index >= this.vfoParams.length) return;
		Object.assign(this.vfoParams[index], params);

		if (this.dspWorkers && this.dspWorkers[index]) {
			this.dspWorkers[index].postMessage({
				type: 'configure',
				params: this.vfoParams[index],
				centerFreq: this._centerFreq
			});
		}

		if (params.pocsag === false && this.vfoStates && this.vfoStates[index]) {
			this.vfoStates[index].pocsagDecoder = null;
		}
	}

	addVfo(): number {
		if (!this.vfoParams) return -1;
		const centerFreq = this._centerFreq || 100.0;
		const bw = 150000;
		const params: VfoParams = { freq: centerFreq, mode: 'wfm', enabled: false, deEmphasis: '50us', squelchEnabled: false, squelchLevel: -100.0, lowPass: true, highPass: false, bandwidth: bw, volume: 50, pocsag: false };
		this.vfoParams.push(params);

		const index = this.vfoParams.length - 1;
		this.vfoStates!.push(this._makeVfoState!());
		this.dspWorkers!.push(this._spawnWorker!(index, params));

		return index;
	}

	removeVfo(index: number): void {
		if (!this.vfoParams || index < 0 || index >= this.vfoParams.length) return;
		if (this.vfoParams.length <= 1) return;

		if (this.dspWorkers![index]) {
			this.dspWorkers![index].terminate();
		}

		this.vfoParams.splice(index, 1);
		this.dspWorkers!.splice(index, 1);
		this.vfoStates!.splice(index, 1);
	}

	// ── Generic device control methods ──────────────────────────────

	async setSampleRate(rate: number): Promise<void> {
		if (!this.device) throw new Error('No device connected');
		await this.device.setSampleRate(rate);
	}

	async setFrequency(centerFreqMhz: number, frequencyShiftMhz = 0): Promise<void> {
		if (!this.device) throw new Error('No device connected');
		await this.device.setFrequency(displayToDeviceFrequencyHz(centerFreqMhz, frequencyShiftMhz));

		this._centerFreq = centerFreqMhz;

		if (this.vfoParams && this.dspWorkers) {
			for (let i = 0; i < this.vfoParams.length; i++) {
				if (this.dspWorkers[i]) {
					this.dspWorkers[i].postMessage({
						type: 'configure',
						params: this.vfoParams[i],
						centerFreq: this._centerFreq
					});
				}
			}
		}

		if (this._remoteClients) {
			for (const rc of this._remoteClients.values()) {
				if (rc.workers && rc.params) {
					for (let i = 0; i < rc.workers.length; i++) {
						if (rc.workers[i]) {
							rc.workers[i]!.postMessage({
								type: 'configure',
								params: rc.params[i],
								centerFreq: this._centerFreq
							});
						}
					}
				}
			}
		}
	}

	async setGain(name: string, value: number): Promise<void> {
		if (!this.device) throw new Error('No device connected');
		await this.device.setGain(name, value);
	}

	async setGains(gains: Record<string, number>): Promise<void> {
		if (!this.device) throw new Error('No device connected');
		if (this.device.setGains) {
			await this.device.setGains(gains);
		} else {
			for (const [name, value] of Object.entries(gains)) {
				await this.device.setGain(name, value);
			}
		}
	}

	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		if (!this.device) throw new Error('No device connected');
		if (this.sweepEngine) throw new Error('Stop the active sweep before starting Receiver mode');
		await this.device.startRx(callback);
	}

	async stopRx(): Promise<void> {
		if (!this.device) throw new Error('No device connected');
		try {
			await this.device.stopRx();
		} finally {
			if (this._perfInterval) {
				clearInterval(this._perfInterval);
				this._perfInterval = undefined;
			}
			if (this.ddcs) {
				for (const ddc of this.ddcs) {
					try { ddc.free(); } catch {}
				}
				this.ddcs = [];
			}
			for (const worker of this.dspWorkers || []) {
				try { worker.terminate(); } catch {}
			}
			this.dspWorkers = [];
			this._perf = undefined;
			this._handleWorkerAudio = undefined;
			this._setSpectrumIqCorrection = undefined;
		}
	}

	async close(): Promise<void> {
		const device = this.device;
		if (!device) return;
		try {
			await this.stopSweep();
		} finally {
			try {
				await this.stopRx();
			} catch (error) {
				console.warn('Error stopping RX while closing device:', error);
			}
			try {
				await device.close();
			} finally {
				if (this.device === device) this.device = null;
			}
		}
	}
}
