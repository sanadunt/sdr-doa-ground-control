import { createApp, markRaw } from 'vue';
import * as Comlink from 'comlink';
import { createAppData } from './state';
import { computedProperties } from './computed';
import { uiHelperMethods } from './ui-helpers';
import { connectionMethods } from './connection';
import { canvasMethods, mountCanvas } from './canvas';
import { audioMethods } from './audio';
import { vfoMethods } from './vfo';
import { serializeSweepSettings, settingsMethods } from './settings';
import { listenerDisplayMethods } from './listener-display';
import { listenerMarkerMethods } from './listener-markers';
import { bookmarkMethods } from './bookmarks';
import { whisperMethods } from './whisper';
import { pocsagMethods } from './pocsag';
import { zoomMethods } from './zoom';
import { sweepMethods } from './sweep';
import { recordsMethods } from './records';
import { audioRecordingMethods } from './audio-recording';
import { receiverRecordsApi } from './receiver-records-api';
import { i18nMethods, receiverLanguage, translateReceiver } from './i18n';
import { setSweepCanvasTranslator } from './sweep-marker-renderer';
import { installConsoleBridge } from './console-bridge';

const Backend = Comlink.wrap<any>(new Worker(new URL('../worker/main.ts', import.meta.url), { type: 'module' }));

let receiverApp: any = null;

function receiverIsBusy(app: any): boolean {
	return Boolean(app && (app.running || app.audioRecording.armed || app.audioRecording.starting
		|| app.sweep.active || app.sweep.starting || app.sweep.stopping || app.sweep.listening || app.sweep.listenStarting));
}

if ('serviceWorker' in navigator) {
	// The first install also fires controllerchange; only an update to an already
	// controlled page needs fresh assets, and never in the middle of RX, a scan or a recording.
	const hadController = Boolean(navigator.serviceWorker.controller);
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		if (!hadController) return;
		if (receiverIsBusy(receiverApp)) {
			receiverApp.showMsg('Receiver update downloaded. Reload this page when RX, scanning and recording have stopped.');
			return;
		}
		window.location.reload();
	});
}
if ('caches' in window) {
	// Earlier builds cached /api/ responses in the service worker; drop that cache.
	void caches.delete('api-cache').catch(() => undefined);
}

receiverApp = createApp({
	data() { return createAppData(); },
	computed: { ...computedProperties },
	methods: {
		...uiHelperMethods,
		...connectionMethods,
		...canvasMethods,
		...audioMethods,
		...vfoMethods,
		...settingsMethods,
		...bookmarkMethods,
		...whisperMethods,
		...pocsagMethods,
		...zoomMethods,
		...sweepMethods,
		...recordsMethods,
		...audioRecordingMethods,
		...i18nMethods,
		...listenerDisplayMethods,
		...listenerMarkerMethods,
	},
	created: async function () {
		this.loadSetting();
		// Non-reactive: the dB scale last applied to the Listener (listener-display.ts).
		this._listenerAppliedAuto = this.display.auto !== false;
		this.loadSweepSettings();
		this.loadBookmarks();
		this.$watch(() => serializeSweepSettings(this.sweep), () => this.saveSweepSettings());
		// The spectrum markers also show on the Listener trace (listener-markers.ts).
		this.$watch(() => [this.records.markers, this.radio.frequencyShift], () => this.refreshListenerMarkers(), { deep: true, immediate: true });

		// The Receiver iframe is removed when the console leaves #/receiver, and a reload or
		// closed tab never runs Vue's unmount hooks; keep what was recorded so far.
		window.addEventListener('pagehide', () => {
			this.finalizeVfoAudioRecordingForUnload();
			const scanId = this.sweep.scanId as string | null;
			if (scanId && (this.sweep.active || this.sweep.starting || this.sweep.stopping)) {
				void receiverRecordsApi.finishScan(scanId, 'stopped', { keepalive: true }).catch(() => undefined);
			}
		});
		if ('usb' in navigator) {
			// An unplugged HackRF only shows up here; the RX transfer loop just stops.
			(navigator.usb as USB & EventTarget).addEventListener('disconnect', (event: Event) => {
				const device = (event as Event & { device?: USBDevice }).device;
				if (device) void this.handleUsbDeviceLost(device);
			});
		}

		// Track online/offline status for PWA — disables internet-dependent features when offline
		window.addEventListener('online', () => { this.isOnline = true; });
		window.addEventListener('offline', () => { this.isOnline = false; });

		// Re-acquire the screen wake lock if the page becomes visible again while running
		// (the OS releases it automatically when the screen turns off)
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible' && this.running) {
				this._acquireWakeLock();
			}
		});

		this.backend = await new (Backend as any)();
		await this.backend.init();
		await this.loadReceiverSettings();
		// Inside the console's frame, the Overview dashboard drives RX through this bridge.
		// Installed before the auto-connect below so a console start can keep VFO 1 muted.
		// A property outside data() is not reactive.
		const consoleBridge = installConsoleBridge(this);
		this._consoleBridge = consoleBridge ? markRaw(consoleBridge) : null;

		let freqDebounce: ReturnType<typeof setTimeout> | null = null;
		this.$watch(() => this.radio.centerFreq, async (newVal: any, oldVal: any) => {
			this.saveSetting();
			// Reset zoom on radio change
			this.view.zoomScale = 1.0;
			this.view.zoomOffset = 0.0;
			this.applyZoomToEngine();

			if (this.remoteMode === 'client') {
				if (!this._applyingSync) {
					this._webrtc.sendCommand({ type: 'requestChange', target: 'radio', property: 'centerFreq', value: newVal });
				}
				return;
			}

			// Debounce: wait for the input to settle before sending USB commands.
			// Typing "106" fires intermediate values (1, 10, 106) — each triggers a
			// full pauseRx/VCO-cal/resumeRx cycle that can leave the FC0012 PLL in a
			// bad state if changes arrive too fast.
			if (freqDebounce) clearTimeout(freqDebounce);
			freqDebounce = setTimeout(() => {
				freqDebounce = null;

				if (this.running && this.backend) {
					this.backend.setFrequency(newVal, this.radio.frequencyShift).catch(console.error);
				}

				if (this.remoteMode === 'host' && this._webrtc) {
					this._webrtc.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains, locks: this.locks });
				}
			}, 200);
		});

		this.$watch(() => [this.radio.sampleRate, this.radio.fftSize], async (newVals: any[], oldVals: any[]) => {
			this.saveSetting();
			this.view.zoomScale = 1.0;
			this.view.zoomOffset = 0.0;
			this.applyZoomToEngine();

			if (this.remoteMode === 'client') {
				if (!this._applyingSync) {
					if (newVals[0] !== oldVals[0]) {
						this._webrtc.sendCommand({ type: 'requestChange', target: 'radio', property: 'sampleRate', value: newVals[0] });
					}
				}
				return;
			}

			if (this.running && (newVals[0] !== oldVals[0] || newVals[1] !== oldVals[1])) {
				const resumeRecording = this.audioRecording.armed;
				this._rxRestarting = true;
				try {
					await this.togglePlay();
					await this.togglePlay(true);
				} finally {
					this._rxRestarting = false;
				}
				if (resumeRecording) await this.resumeVfoAudioRecordingAfterRestart('the sample rate or FFT size changed');
			}

			if (this.remoteMode === 'host' && this._webrtc) {
				this._webrtc.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains, locks: this.locks });
			}
		}, { deep: true });

		this.$watch(() => this.radio.iqCorrection, (enabled: boolean) => {
			this.saveSetting();
			if (this.remoteMode === 'client') {
				if (!this._applyingSync) {
					this._webrtc.sendCommand({ type: 'requestChange', target: 'radio', property: 'iqCorrection', value: enabled });
				}
				return;
			}

			if (this.running && this.backend) {
				this.backend.setSpectrumIqCorrection(enabled).catch(console.error);
			}
			if (this.remoteMode === 'host' && this._webrtc) {
				this._webrtc.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains, locks: this.locks });
			}
		});

		let frequencyShiftDebounce: ReturnType<typeof setTimeout> | null = null;
		this.$watch(() => this.radio.frequencyShift, (newVal: any) => {
			this.saveSetting();

			// The converter belongs to the host's hardware. Remote clients receive
			// the host's shift through radio sync and cannot change it themselves.
			if (this.remoteMode === 'client') return;

			if (frequencyShiftDebounce) clearTimeout(frequencyShiftDebounce);
			frequencyShiftDebounce = setTimeout(() => {
				frequencyShiftDebounce = null;
				if (this.running && this.backend) {
					this.backend.setFrequency(this.radio.centerFreq, newVal).catch(console.error);
				}

				if (this.remoteMode === 'host' && this._webrtc) {
					this._webrtc.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains, locks: this.locks });
				}
			}, 200);
		});

		let gainDebounce: ReturnType<typeof setTimeout> | null = null;
		this.$watch('gains', () => {
			// Debounce: wait for slider to settle before sending USB commands.
			// Dragging fires many intermediate values — only the final one matters.
			if (gainDebounce) clearTimeout(gainDebounce);
			gainDebounce = setTimeout(() => {
				gainDebounce = null;

				if (this.remoteMode === 'client') {
					if (!this._applyingSync) {
						for (const [name, value] of Object.entries(this.gains)) {
							this._webrtc.sendCommand({ type: 'requestChange', target: 'gains', property: name, value });
						}
					}
					return;
				}

				if (this.running && this.connected && this.backend) {
					this.backend.setGains({ ...this.gains }).catch(console.error);
				}

				if (this.remoteMode === 'host' && this._webrtc) {
					this._webrtc.sendCommand({ type: 'sync', gains: this.gains, locks: this.locks });
				}

				this.saveSetting();
			}, 100);
		}, { deep: true });

		this.$watch('vfos', () => {
			for (let i = 0; i < this.vfos.length; i++) {
				if (!this.vfos[i].focused) {
					this.vfos[i].displayFreq = this.formatFreq(this.vfos[i].freq);
				}
				this.updateBackendVfoParams(i);
			}
			this.saveSetting();
		}, { deep: true });

		this.$watch('view', () => {
			this.applyZoomToEngine();
			this.saveSetting();
		}, { deep: true });

		this.$watch('collapsedPanels', () => {
			this.saveSetting();
		}, { deep: true });

		// The dB scale, set on the Dengar tab or by the console's Spektrum dock.
		this.$watch(() => [this.display.auto, this.display.minDB, this.display.maxDB], () => {
			this.applyListenerDisplay();
			this.saveSetting();
		});

		this.$watch('locks', () => {
			if (this.remoteMode === 'host' && this._webrtc) {
				this._webrtc.sendCommand({ type: 'sync', locks: this.locks });
			}
			this.saveSetting();
		}, { deep: true });
		await this.$nextTick();
		const autoConnect = this.autoConnectAuthorizedHackRF();
		this._consoleBridge?.trackConnect(autoConnect);
		await autoConnect;
	},
	mounted() {
		setSweepCanvasTranslator(text => translateReceiver(this.uiLanguage, text));
		mountCanvas.call(this);
		this.initSweepCanvas();
	},
	beforeUnmount() {
		this._consoleBridge?.dispose();
		this._consoleBridge = null;
		this.disposeSweepCanvas();
		void this.disarmVfoAudioRecording();
		if (this.sweep.active || this.sweep.starting) void this.stopSweep(false, 'stopped');
	},
}).mount('#app');
window.addEventListener('console-language-change', (event: Event) => {
	receiverApp.uiLanguage = receiverLanguage((event as CustomEvent<unknown>).detail);
	if (receiverApp.activeWorkspace === 'spectrum') receiverApp.drawSweepSpectrum();
});
window.addEventListener('console-theme-change', () => {
	if (receiverApp.activeWorkspace === 'spectrum') receiverApp.drawSweepSpectrum();
	else if (receiverApp.activeWorkspace === 'listener') receiverApp.resizeFftCanvas();
});
