import type { AppInstance } from './types';
import * as Comlink from 'comlink';
import { getAllCatalogFilters, lookupDevice } from '../device-catalog';

function initializeGains(
	gainControls: readonly { name: string; min: number; max: number; step: number; default: number }[],
	currentGains: Record<string, number>,
): Record<string, number> {
	const gains: Record<string, number> = {};
	for (const control of gainControls) {
		const value = currentGains[control.name];
		const steps = (value - control.min) / control.step;
		const isStepAligned = control.step > 0 && Number.isFinite(steps) && Math.abs(steps - Math.round(steps)) <= 1e-9;
		const isValid = Number.isFinite(value)
			&& value >= control.min
			&& value <= control.max
			&& isStepAligned;
		gains[control.name] = isValid ? value : control.default;
	}
	return gains;
}

const WEBUSB_UNAVAILABLE_MESSAGE = 'This browser has no WebUSB, so it cannot connect a HackRF. Open the console in Chrome or Edge (desktop or Android).';
const RX_STREAM_FAILED_PREFIX = 'The radio stopped sending samples';

function sameUsbDevice(a: USBDevice, b: USBDevice): boolean {
	return a === b || (a.vendorId === b.vendorId && a.productId === b.productId
		&& (a.serialNumber ?? '') === (b.serialNumber ?? ''));
}

/** False only when WebUSB no longer lists the radio; unknown counts as present. */
async function usbDeviceIsPresent(device: USBDevice): Promise<boolean> {
	if (!('usb' in navigator)) return true;
	try {
		return (await navigator.usb.getDevices()).some(candidate => sameUsbDevice(candidate, device));
	} catch {
		return true;
	}
}

/** Hardware scan source for a newly connected radio; Simulation only when the radio cannot scan. */
function hardwareSweepSource(capabilities: { supportsNativeSweep?: boolean; supportsManualSweep?: boolean } | null): 'native' | 'manual' | null {
	if (capabilities?.supportsNativeSweep) return 'native';
	if (capabilities?.supportsManualSweep) return 'manual';
	return null;
}

export const connectionMethods = {
	selectSweepSourceForConnectedDevice(this: AppInstance) {
		if (this.sweep.active || this.sweep.starting || this.sweep.stopping) return;
		const source = hardwareSweepSource(this.deviceCapabilities);
		if (!source || this.sweep.source === source) return;
		if (this.sweep.hasResults && this.sweep.source === 'simulated') {
			// Keep the shown results labelled as the simulation they came from.
			this.showMsg('Radio connected. The results shown are SIMULATION; choose the HackRF source or Clear before scanning.');
			return;
		}
		this.sweep.source = source;
	},

	async handleUsbDeviceLost(this: AppInstance, device: USBDevice) {
		// A failed RX transfer may already be stopping RX for the same unplug; let it finish first.
		if (this._rxFailureHandling) await this._rxFailureHandling;
		await this._handleRadioLost(device, false);
	},

	async _handleRadioLost(this: AppInstance, device: USBDevice, recordingWasArmed: boolean) {
		const opened = this._usbDevice as USBDevice | null;
		if (!this.connected || this.mockDevice || opened === null || !sameUsbDevice(opened, device)) return;
		this._usbDevice = null;
		const wasRecording = recordingWasArmed || this.audioRecording.armed;
		try {
			if (this.sweep.active || this.sweep.starting) await this.stopSweep(false, 'failed');
		} catch (error) {
			console.error('Stopping the scan after USB loss failed:', error);
		}
		try {
			if (this.running) await this.togglePlay();
		} catch (error) {
			console.error('Stopping RX after USB loss failed:', error);
			this.running = false;
		}
		try {
			await this.backend?.close();
		} catch (error) {
			console.error('Closing the lost device failed:', error);
		}
		this.connected = false;
		this.deviceCapabilities = null;
		this.info.boardName = '';
		const message = `Radio disconnected (USB unplugged or lost). RX and scanning stopped${wasRecording ? '; the recording was saved up to this point' : ''}. Reconnect the radio to continue.`;
		this.audioRecording.notice = wasRecording ? message : this.audioRecording.notice;
		this.sweep.error = message;
		this.showMsg(message);
	},

	/**
	 * The worker reports the first failed RX bulk transfer of a stream. Stop RX so the
	 * recording is closed instead of collecting silence, then tell a lost radio apart
	 * from one that is still attached.
	 */
	handleRxStreamError(this: AppInstance, streamId: number, detail: string): Promise<void> | undefined {
		if (streamId !== this._rxStreamId || !this.running || !this.connected || this._rxFailureHandling) return undefined;
		const handling = (async () => {
			const device = this._usbDevice as USBDevice | null;
			const wasRecording = Boolean(this.audioRecording.armed || this.audioRecording.starting);
			try {
				await this.togglePlay();
			} catch (error) {
				console.error('Stopping RX after a failed USB transfer failed:', error);
				this.running = false;
			}
			if (device && !(await usbDeviceIsPresent(device))) {
				await this._handleRadioLost(device, wasRecording);
				return;
			}
			if (!this.connected || this._usbDevice !== device) return;
			const message = `${RX_STREAM_FAILED_PREFIX} (${detail}). RX stopped${wasRecording ? '; the recording was saved up to this point' : ''}. Check the USB cable, then press Resume or reconnect the radio.`;
			if (wasRecording) this.audioRecording.notice = message;
			this.sweep.error = message;
			this.showMsg(message);
		})();
		this._rxFailureHandling = handling;
		void handling.finally(() => {
			if (this._rxFailureHandling === handling) this._rxFailureHandling = null;
		});
		return handling;
	},

	async autoConnectAuthorizedHackRF(this: AppInstance) {
		if (!this.backend || !('usb' in navigator)) return;
		try {
			const authorizedDevices = await navigator.usb.getDevices();
			const hackrfDevices = authorizedDevices.filter(device => lookupDevice(device)?.type === 'hackrf');
			if (hackrfDevices.length !== 1) return;
			this._initAudioCtx();
			this.showMsg('Reconnecting to previously authorized HackRF...');
			await this.connectToDevice(hackrfDevices[0]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.showMsg(`HackRF auto-connect failed: ${message}`);
		}
	},
	async connect(this: AppInstance) {
		if (!this.backend) return;
		if (!('usb' in navigator)) {
			this.sweep.error = WEBUSB_UNAVAILABLE_MESSAGE;
			this.showMsg(WEBUSB_UNAVAILABLE_MESSAGE);
			return;
		}
		this._initAudioCtx(); // create AudioContext within user gesture

		// Get already-paired USB devices and filter to recognized SDR devices
		const allPaired = await navigator.usb.getDevices();
		type PairedSdr = { device: USBDevice; driverName: string; productName: string };
		const sdrDevices: PairedSdr[] = [];
		for (const device of allPaired) {
			const driver = lookupDevice(device);
			if (driver) {
				sdrDevices.push({ device, driverName: driver.name, productName: device.productName || '' });
			}
		}

		if (sdrDevices.length === 0) {
			// No paired SDR devices — go straight to browser USB picker
			await this.pairNewDevice();
		} else {
			// Show our custom picker dialog
			this.devicePicker.devices = sdrDevices;
			this.devicePicker.show = true;
		}
	},

	async pairNewDevice(this: AppInstance) {
		this.devicePicker.show = false;
		const device = await navigator.usb.requestDevice({
			filters: getAllCatalogFilters()
		}).catch(() => null);
		if (!device) return;
		await this.connectToDevice(device);
	},

	async connectToDevice(this: AppInstance, device: USBDevice) {
		if (this.sweep.starting && !this.sweep.active) {
			this.showMsg('Wait for scan startup to finish before connecting a device.');
			return;
		}
		if (this.sweep.active) await this.stopSweep(false);
		this.devicePicker.show = false;
		try {
			const ok = await this.backend.open({
				vendorId: device.vendorId,
				productId: device.productId,
				serialNumber: device.serialNumber
			});
			if (ok) {
				this.connected = true;
				this.mockDevice = false;
				this._usbDevice = device;
				if (this.sweep.error === WEBUSB_UNAVAILABLE_MESSAGE || this.sweep.error.startsWith('Radio disconnected')
					|| this.sweep.error.startsWith(RX_STREAM_FAILED_PREFIX)) this.sweep.error = '';
				const info = await this.backend.info();
				this.info.boardName = info.name;

				// Populate device capabilities for dynamic UI
				const caps = await this.backend.getDeviceCapabilities();
				this.deviceCapabilities = caps;
				this.selectSweepSourceForConnectedDevice();
				if (caps) {
					this.gains = initializeGains(caps.gainControls, this.gains);

					// If current sample rate isn't in the device's supported list, pick the closest
					if (!caps.sampleRates.includes(this.radio.sampleRate)) {
						this.radio.sampleRate = caps.sampleRates[caps.sampleRates.length - 1];
					}
				}

				this.showMsg("Connected to Radio SDR");
				await this.startStream();
			} else {
				this.showMsg("Failed to open device.");
			}
		} catch (e: any) {
			this.showMsg("Connect Error: " + e.message);
		}
	},

	async connectMock(this: AppInstance) {
		if (this.sweep.starting && !this.sweep.active) {
			this.showMsg('Wait for scan startup to finish before connecting a device.');
			return;
		}
		if (this.sweep.active) await this.stopSweep(false);
		if (!this.backend) return;
		this.showMsg("Connecting Mock SDR...");
		try {
			const ok = await this.backend.open("mock");
			if (ok) {
				this.connected = true;
				this.mockDevice = true;
				this._usbDevice = null;
				const info = await this.backend.info();
				this.info.boardName = info.name;

				const caps = await this.backend.getDeviceCapabilities();
				this.deviceCapabilities = caps;
				this.selectSweepSourceForConnectedDevice();
				if (caps) {
					this.gains = initializeGains(caps.gainControls, this.gains);
				}

				this.showMsg("Connected to Mock SDR");
				await this.startStream();
			} else {
				this.showMsg("Failed to open Mock SDR.");
			}
		} catch (e: any) {
			this.showMsg("Mock Connect Error: " + e.message);
		}
	},
	async disconnect(this: AppInstance) {
		if (this.sweep.starting && !this.sweep.active) {
			this.showMsg('Wait for scan startup to finish before disconnecting.');
			return;
		}
		if (this.sweep.active) await this.stopSweep(false);
		if (this.remoteMode === 'client' && this._webrtc) {
			this._webrtc.close();
			this._webrtc = null;
			this.remoteMode = 'none';
			if (this.running) await this.togglePlay();
			this.connected = false;
			this.deviceCapabilities = null;
			this.showMsg("Disconnected from remote device");
			// Clear the URL
			window.history.replaceState({}, document.title, "/");
			return;
		}

		if (this.remoteMode === 'host' && this._webrtc) {
			this._webrtc.close();
			this._webrtc = null;
			this.remoteMode = 'none';
			this.remoteClients = [];
			this.showRemoteClientsDialog = false;
			this.showMsg("Remote sharing stopped");
		}

		if (this.running) await this.togglePlay();
		await this.backend.close();
		this.connected = false;
		this.mockDevice = false;
		this._usbDevice = null;
		this.deviceCapabilities = null;
		this.showMsg("Disconnected");
	},
	_releaseWakeLock(this: AppInstance) {
		if (this._wakeLock) {
			this._wakeLock.release().catch(() => {});
			this._wakeLock = null;
		}
	},
	async _acquireWakeLock(this: AppInstance) {
		if ('wakeLock' in navigator) {
			try {
				this._wakeLock = await (navigator as any).wakeLock.request('screen');
			} catch (_) {}
		}
	},
	async togglePlay(this: AppInstance, isRestart = false, sweepTransition = false) {
		if (this.sweep.active || (this.sweep.starting && !sweepTransition)) return;
		if (this.running) {
			// Transfer errors from the stream being stopped are expected, not a failure.
			this._rxStreamId = (this._rxStreamId ?? 0) + 1;
			const wasRecording = this.audioRecording.armed || this.audioRecording.starting;
			await this.disarmVfoAudioRecording();
			if (wasRecording && !this._rxRestarting) {
				// Opening Spectrum, Pause, or a lost radio all stop RX; say so instead of stopping silently.
				this.audioRecording.notice = sweepTransition
					? 'VFO audio recording stopped because the Spectrum scan needs the radio. Saved audio is in Records.'
					: 'VFO audio recording stopped with the Receiver. Saved audio is in Records.';
				this.showMsg(this.audioRecording.notice);
			}
			await this.backend.stopRx();
			this.running = false;
			if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
			this.dspStats = null;
			if (this._mediaAudioEl) {
				this._mediaAudioEl.pause();
				if (this._mediaSource && this._mediaSource.readyState === 'open') {
					try { this._mediaSource.endOfStream(); } catch (_) {}
				}
				this._mediaSource = null;
				this._silentMp3Data = null;
				this._mediaAudioEl.src = '';
				this._mediaAudioEl.remove();
				this._mediaAudioEl = null;
			}
			if (this.audioCtx) {
				try { await this.audioCtx.close(); } catch (_: any) { }
				this.audioCtx = null;
				this.gainNode = null;
			}
			this._releaseWakeLock();
			if ('mediaSession' in navigator) {
				navigator.mediaSession.playbackState = 'paused';
				navigator.mediaSession.setActionHandler('play', null);
				navigator.mediaSession.setActionHandler('pause', null);
				navigator.mediaSession.setActionHandler('stop', null);
			}
		} else {
			this.startStream(isRestart);
		}
	},
	async startStream(this: AppInstance, isRestart = false) {
		if (this.running || this.sweep.active) return;

		this.initCanvas();

		// Set running=true synchronously so drawSpectrum() isn't blocked by the
		// `if (!this.running)` guard while we're awaiting startRxStream(). For
		// remote clients, WebRTC FFT chunks can arrive before that await resolves.
		this.running = true;

		const opts = {
			centerFreq: this.radio.centerFreq,
			frequencyShift: this.radio.frequencyShift,
			sampleRate: this.radio.sampleRate,
			fftSize: this.radio.fftSize,
			iqCorrection: this.radio.iqCorrection,
			gains: { ...this.gains },
		};

		const rxStreamId = this._rxStreamId = (this._rxStreamId ?? 0) + 1;
		try {
			await this.backend.startRxStream(opts,
				Comlink.proxy((spectrumData: any) => this.drawSpectrum(spectrumData)),
				Comlink.proxy((audioSamples: any) => this.playAudio(audioSamples)),
				Comlink.proxy((vfoIndex: number, freq: number, samples: Float32Array) => {
					this._feedWhisperVfo(vfoIndex, freq, samples);
					this.recordVfoAudio(vfoIndex, freq, samples);
				}),
				Comlink.proxy((vfoIndex: number, freq: number, msg: any) => this._onPocsagMessage(vfoIndex, freq, msg)),
				Comlink.proxy((detail: string) => { void this.handleRxStreamError(rxStreamId, detail); }),
			);
		} catch (e: any) {
			console.error('Error starting RX stream:', e);
			this.showMsg("Error starting stream.");
			this.running = false;
			await this.disarmVfoAudioRecording();
			return;
		}
		if (this.sweep.error.startsWith(RX_STREAM_FAILED_PREFIX)) this.sweep.error = '';

		this._statsTimer = setInterval(async () => {
			if (this.backend && this.running) {
				this.dspStats = await this.backend.getDspStats();
				// Remote clients receive squelch state via WebRTC 'squelchState'
				// commands (see remote.ts). Skip local polling so the host-provided
				// data isn't overwritten with stale all-false values from the mock backend.
				if (this.remoteMode === 'client') return;
				if (this.dspStats && this.dspStats.squelchOpen) {
					const now = Date.now();
					const squelchStates = this.dspStats.squelchOpen.slice();
					for (let i = 0; i < squelchStates.length; i++) {
						if (squelchStates[i]) {
							this.vfoSquelchHangUntil[i] = now + 1000;
						} else if (this.vfoSquelchHangUntil[i] && now < this.vfoSquelchHangUntil[i]) {
							squelchStates[i] = true;
						}
					}
					this.vfoSquelchOpen = squelchStates;
					// ── Frequency activity tracker ──
					// Uses raw (pre-hang) states to count true squelch-open events
					const rawOpen = this.dspStats.squelchOpen;
					for (let i = 0; i < rawOpen.length; i++) {
						if (!this.vfoActivityStats[i]) {
							this.vfoActivityStats[i] = { count: 0, totalMs: 0, squelchOpenSince: null };
						}
						const stat = this.vfoActivityStats[i];
						// Only track activity for VFOs that are not muted
						if (rawOpen[i] && this.vfos[i]?.enabled) {
							if (stat.squelchOpenSince === null) {
								// Squelch just opened – start a new event
								stat.squelchOpenSince = now;
								stat.count++;
							}
						} else {
							if (stat.squelchOpenSince !== null) {
								// Squelch just closed – accumulate duration
								stat.totalMs += now - stat.squelchOpenSince;
								stat.squelchOpenSince = null;
							}
						}
					}
					// Bump reactive tick so sortedVfoActivity recomputes
					this.activityNow = now;
				}
				// ── Auto-squelch sample collection ──
				if (this.dspStats && this.dspStats.squelchDb) {
					for (let i = 0; i < this.dspStats.squelchDb.length; i++) {
						if (this.autoSquelchActive[i] && this.autoSquelchSamples[i]) {
							this.autoSquelchSamples[i].push(this.dspStats.squelchDb[i]);
						}
					}
				}
			}
		}, 500);

		await this._acquireWakeLock();
		if ('mediaSession' in navigator) {
			navigator.mediaSession.metadata = new MediaMetadata({
				title: 'Freq. Spectrum',
				artist: 'Receiving',
				artwork: [
					{ src: '/receiver/icon-96.png', sizes: '96x96', type: 'image/png' },
					{ src: '/receiver/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: '/receiver/icon-512.png', sizes: '512x512', type: 'image/png' },
				],
			});
			navigator.mediaSession.playbackState = 'playing';
			// Action handlers are REQUIRED for Chrome on Android to show the media notification.
			// Without at least play+pause registered, the notification never appears.
			navigator.mediaSession.setActionHandler('play', () => {
				if (this._mediaAudioEl) this._mediaAudioEl.play().catch(() => {});
				if (this.audioCtx?.state === 'suspended') this.audioCtx.resume().catch(() => {});
				navigator.mediaSession.playbackState = 'playing';
			});
			navigator.mediaSession.setActionHandler('pause', () => {
				// Don't actually pause — just keep showing the notification (user can stop from the UI)
				navigator.mediaSession.playbackState = 'playing';
			});
			navigator.mediaSession.setActionHandler('stop', () => { this.togglePlay(); });
		}

		// Add additional VFOs beyond the first (which is created by default in the worker).
		// In client mode, notify the host via WebRTC instead of calling the mock backend.
		for (let i = 1; i < this.vfos.length; i++) {
			if (this.remoteMode === 'client' && this._webrtc) {
				this._webrtc.sendCommand({ type: 'addRemoteVfo' });
			} else {
				await this.backend.addVfo();
			}
		}

		// Enable first VFO by default only on initial start (not restart).
		// During a restart (e.g. center freq change), preserve existing mute states.
		if (!isRestart) {
			this.vfos[0].enabled = true;
		}
		this.toggleVfoCheckbox(0);

		// Send all VFO params to worker (or host in client mode)
		for (let i = 0; i < this.vfos.length; i++) {
			this.updateBackendVfoParams(i);
		}
	},
};
