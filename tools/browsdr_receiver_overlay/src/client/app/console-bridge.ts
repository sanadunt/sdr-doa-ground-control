/**
 * Frame side of the Ground Console bridge. When the Receiver runs inside the
 * console's same-origin iframe, the Overview dashboard starts and stops RX,
 * tunes, picks the listen mode and draws a cropped spectrum through
 * window.postMessage. The protocol is in console-bridge-protocol.ts.
 *
 * The bridge only answers its parent window on the page's own origin. It
 * never opens the device picker or the VFO conflict dialog, which would be
 * invisible in the hidden frame, and it refuses every radio command while a
 * wide scan or a scan listen owns the radio. It sends codes, not text.
 */
import type { AppInstance } from './types';
import { lookupDevice } from '../device-catalog';
import { RADIO_LOST_PREFIX, RX_STREAM_FAILED_PREFIX, WEBUSB_UNAVAILABLE_MESSAGE } from './connection';
import {
	BRIDGE_CHANNEL,
	BRIDGE_VERSION,
	STATUS_DEBOUNCE_MS,
	STATUS_HEARTBEAT_MS,
	clampSubscription,
	createFrameThrottle,
	cropSpectrum,
	inTuneRange,
	parseConsoleMessage,
	VOLUME_LIMITS,
	type AudioState,
	type BusyState,
	type CommandOf,
	type ConsoleCommand,
	type ReceiverStatus,
	type ResultCode,
	type StatusErrorCode,
	type Subscription,
	type Workspace,
} from './console-bridge-protocol';

export interface ConsoleBridge {
	/** Called with every FFT frame the Listener draws. */
	spectrum(data: ArrayLike<number>): void;
	/** Whether a fresh RX start unmutes VFO 1: false while a console start without listen runs. */
	initialVfoEnabled(): boolean;
	/** A device connection that started outside the bridge; console starts wait for it. */
	trackConnect(pending: Promise<unknown>): void;
	dispose(): void;
}

interface BridgeMessageEvent {
	origin: string;
	source: unknown;
	data: unknown;
}

type MessageListener = (event: BridgeMessageEvent) => void;

interface BridgeParent {
	location: { origin: string };
	postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
}

interface BridgeWindow {
	parent: BridgeParent | null;
	location: { origin: string };
	addEventListener(type: 'message', listener: MessageListener): void;
	removeEventListener(type: 'message', listener: MessageListener): void;
}

interface BridgeUsb {
	getDevices(): Promise<USBDevice[]>;
	addEventListener?(type: 'connect' | 'disconnect', listener: () => void): void;
	removeEventListener?(type: 'connect' | 'disconnect', listener: () => void): void;
}

interface BridgeNavigator {
	usb?: BridgeUsb;
	userActivation?: { isActive: boolean };
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface ConsoleBridgeEnvironment {
	window: BridgeWindow;
	navigator: BridgeNavigator;
	/** Epoch milliseconds for tMs. */
	now(): number;
	/** Monotonic milliseconds for the spectrum throttle. */
	monotonicNow(): number;
	setTimeout(callback: () => void, ms: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
	setInterval(callback: () => void, ms: number): TimerHandle;
	clearInterval(handle: TimerHandle): void;
}

/**
 * How long a command waits for AudioContext.resume() before reporting
 * AUDIO_BLOCKED. Without a user gesture resume() never settles; with one it can
 * take a few hundred milliseconds on some audio outputs.
 */
export const AUDIO_RESUME_WAIT_MS = 1000;

function browserEnvironment(): ConsoleBridgeEnvironment {
	return {
		window: window as unknown as BridgeWindow,
		navigator: navigator as unknown as BridgeNavigator,
		now: () => Date.now(),
		monotonicNow: () => performance.now(),
		setTimeout: (callback, ms) => setTimeout(callback, ms),
		clearTimeout: handle => clearTimeout(handle),
		setInterval: (callback, ms) => setInterval(callback, ms),
		clearInterval: handle => clearInterval(handle),
	};
}

/** The parent window when it is a different window on this page's origin, otherwise null. */
function sameOriginParent(win: BridgeWindow): BridgeParent | null {
	const parent = win.parent;
	if (!parent || (parent as unknown) === win) return null;
	try {
		return parent.location.origin === win.location.origin ? parent : null;
	} catch {
		// A cross-origin parent throws on location access.
		return null;
	}
}

function mhzToHz(mhz: unknown): number | null {
	return typeof mhz === 'number' && Number.isFinite(mhz) ? Math.round(mhz * 1e6) : null;
}

function finiteOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isHackRf(device: USBDevice): boolean {
	return lookupDevice(device)?.type === 'hackrf';
}

/**
 * Installs the bridge when the Receiver is framed by the console on the same
 * origin. Returns null, and does nothing, in a standalone /receiver/ tab or
 * under a foreign parent.
 */
export function installConsoleBridge(app: AppInstance, environment: ConsoleBridgeEnvironment = browserEnvironment()): ConsoleBridge | null {
	const env = environment;
	const win = env.window;
	const parent = sameOriginParent(win);
	if (!parent) return null;
	const origin = win.location.origin;

	let disposed = false;
	let subscription: Subscription | null = null;
	const throttle = createFrameThrottle();
	let statusSeq = 0;
	let spectrumSeq = 0;
	let statusTimer: TimerHandle | null = null;
	let heartbeat: TimerHandle | null = null;
	let pairedCount: number | null = null;
	let pairedGeneration = 0;
	let startsPending = 0;
	let pendingListen = true;
	let connectInFlight: Promise<void> | null = null;
	let lifecycle: Promise<void> = Promise.resolve();

	function post(message: Record<string, unknown>, transfer: Transferable[] = []): void {
		if (disposed) return;
		try {
			parent!.postMessage({ ch: BRIDGE_CHANNEL, v: BRIDGE_VERSION, ...message }, origin, transfer);
		} catch (error) {
			// The console page is going away; nothing to tell it.
			console.error('Receiver console bridge could not post a message:', error);
		}
	}

	function hasWebUsb(): boolean {
		return Boolean(env.navigator.usb);
	}

	function activeIndex(): number {
		const index = Number(app.activeVfoIndex);
		const count = Array.isArray(app.vfos) ? app.vfos.length : 0;
		return Number.isInteger(index) && index >= 0 && index < count ? index : 0;
	}

	function busyState(): BusyState {
		const sweep = app.sweep ?? {};
		if (sweep.active || sweep.starting || sweep.stopping) return 'sweep';
		if (sweep.listening || sweep.listenStarting) return 'scan-listen';
		return 'none';
	}

	function workspace(): Workspace {
		const value = app.activeWorkspace;
		return value === 'listener' || value === 'records' ? value : 'spectrum';
	}

	function audioState(): AudioState {
		const state = app.audioCtx?.state;
		return state === 'running' || state === 'suspended' ? state : 'none';
	}

	function statusError(): { code: StatusErrorCode } | null {
		const error = typeof app.sweep?.error === 'string' ? app.sweep.error as string : '';
		if (error === WEBUSB_UNAVAILABLE_MESSAGE) return { code: 'NO_WEBUSB' };
		if (!app.connected && error.startsWith(RADIO_LOST_PREFIX)) return { code: 'USB_LOST' };
		if (!app.running && error.startsWith(RX_STREAM_FAILED_PREFIX)) return { code: 'RX_ERROR' };
		return null;
	}

	function gains(): ReceiverStatus['gains'] {
		const values = (app.gains ?? {}) as Record<string, unknown>;
		const amp = Object.entries(values).some(([name, value]) => name.startsWith('Amp') && Number(value) > 0);
		return { lnaDb: finiteOrNull(values.LNA), vgaDb: finiteOrNull(values.VGA), amp };
	}

	function snapshot(): Omit<ReceiverStatus, 'seq' | 'tMs'> {
		const index = activeIndex();
		const vfo = Array.isArray(app.vfos) ? app.vfos[index] : null;
		const connected = Boolean(app.connected);
		const mock = connected && Boolean(app.mockDevice);
		const notice = app.snackbar?.show && typeof app.snackbar.message === 'string' && app.snackbar.message
			? (typeof app.tm === 'function' ? app.tm(app.snackbar.message) as string : app.snackbar.message as string)
			: null;
		return {
			webusb: hasWebUsb(),
			mockAvailable: Boolean(app.mockSdrEnabled),
			pairedCount,
			connected,
			mock,
			deviceName: connected ? (mock ? 'Mock SDR' : (String(app.info?.boardName ?? '') || null)) : null,
			running: Boolean(app.running),
			busy: busyState(),
			workspace: workspace(),
			centerHz: mhzToHz(app.radio?.centerFreq),
			sampleRateHz: finiteOrNull(app.radio?.sampleRate),
			frequencyShiftHz: mhzToHz(app.radio?.frequencyShift) ?? 0,
			gains: gains(),
			vfo: vfo ? {
				index,
				enabled: Boolean(vfo.enabled),
				mode: String(vfo.mode),
				frequencyHz: mhzToHz(vfo.freq),
				bandwidthHz: finiteOrNull(vfo.bandwidth),
				squelchEnabled: Boolean(vfo.squelchEnabled),
				squelchDb: finiteOrNull(vfo.squelchLevel),
				volume: finiteOrNull(vfo.volume),
			} : null,
			squelchOpen: Boolean(app.running && app.vfoSquelchOpen?.[index]),
			audio: audioState(),
			recording: Boolean(app.audioRecording?.armed),
			error: statusError(),
			notice,
		};
	}

	function sendStatusNow(): void {
		if (statusTimer !== null) {
			env.clearTimeout(statusTimer);
			statusTimer = null;
		}
		post({ type: 'receiver:status', seq: ++statusSeq, tMs: env.now(), ...snapshot() });
	}

	function scheduleStatus(): void {
		if (disposed || statusTimer !== null) return;
		statusTimer = env.setTimeout(() => {
			statusTimer = null;
			if (!disposed) sendStatusNow();
		}, STATUS_DEBOUNCE_MS);
	}

	function sendHello(): void {
		post({ type: 'receiver:hello', protocol: BRIDGE_VERSION, mockAvailable: Boolean(app.mockSdrEnabled), webusb: hasWebUsb() });
	}

	function reply(id: string, code: ResultCode, message?: string): void {
		post({ type: 'receiver:result', id, ok: code === 'OK', code, ...(message ? { message } : {}) });
		scheduleStatus();
	}

	async function pairedHackRfs(): Promise<USBDevice[]> {
		const usb = env.navigator.usb;
		if (!usb) return [];
		return (await usb.getDevices()).filter(isHackRf);
	}

	async function refreshPairedCount(): Promise<void> {
		const generation = ++pairedGeneration;
		if (!env.navigator.usb) {
			pairedCount = null;
			return;
		}
		try {
			const count = (await pairedHackRfs()).length;
			if (generation !== pairedGeneration || disposed) return;
			pairedCount = count;
			scheduleStatus();
		} catch (error) {
			console.error('Receiver console bridge could not list paired radios:', error);
		}
	}

	function setVfoFrequency(index: number, hz: number): void {
		const vfo = app.vfos[index];
		const mhz = hz / 1e6;
		vfo.freq = mhz;
		vfo.displayFreq = typeof app.formatFreq === 'function' ? app.formatFreq(mhz) : mhz.toFixed(6).padStart(10, '0');
	}

	function currentCenterHz(): number {
		return mhzToHz(app.radio.centerFreq) ?? 0;
	}

	function halfSampleRateHz(): number {
		const sampleRate = Number(app.radio.sampleRate);
		return Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate / 2 : 0;
	}

	/** Sets the centre and, when given, the active VFO without the VFO conflict dialog. */
	function tune(centerHz: number, vfoHz: number | undefined): ResultCode {
		if (!inTuneRange(centerHz)) return 'OUT_OF_RANGE';
		if (vfoHz !== undefined && (!inTuneRange(vfoHz) || Math.abs(vfoHz - centerHz) > halfSampleRateHz())) return 'OUT_OF_RANGE';
		if (busyState() !== 'none') return 'SWEEP_BUSY';
		if (!app.vfos?.[activeIndex()]) return 'NOT_READY';
		// The centerFreq watcher retunes the radio after its 200 ms debounce; a stopped
		// radio uses the new values at its next start.
		app.radio.centerFreq = centerHz / 1e6;
		if (vfoHz !== undefined) setVfoFrequency(activeIndex(), vfoHz);
		app.updateAllBackendVfoParams();
		return 'OK';
	}

	function vfo(command: { mode?: string; frequencyHz?: number; volume?: number }): ResultCode {
		if (command.frequencyHz !== undefined && !inTuneRange(command.frequencyHz)) return 'OUT_OF_RANGE';
		if (command.volume !== undefined && (command.volume < VOLUME_LIMITS.min || command.volume > VOLUME_LIMITS.max)) return 'OUT_OF_RANGE';
		if (busyState() !== 'none') return 'SWEEP_BUSY';
		const index = activeIndex();
		const current = app.vfos?.[index];
		if (!current) return 'NOT_READY';
		if (command.mode !== undefined && current.mode !== command.mode) {
			current.mode = command.mode;
			app.applyModeDefaults(index);
		}
		let recentred = false;
		if (command.frequencyHz !== undefined) {
			if (Math.abs(command.frequencyHz - currentCenterHz()) > halfSampleRateHz()) {
				app.radio.centerFreq = command.frequencyHz / 1e6;
				recentred = true;
			}
			setVfoFrequency(index, command.frequencyHz);
		}
		if (command.volume !== undefined) current.volume = command.volume;
		if (recentred) app.updateAllBackendVfoParams();
		else app.updateBackendVfoParams(index);
		return 'OK';
	}

	function delay(ms: number): { promise: Promise<void>; cancel(): void } {
		let handle: TimerHandle | null = null;
		const promise = new Promise<void>(resolve => {
			handle = env.setTimeout(resolve, ms);
		});
		return { promise, cancel: () => { if (handle !== null) env.clearTimeout(handle); } };
	}

	/** Resumes audio inside the activation the console's click passed to this frame. */
	async function ensureAudio(): Promise<ResultCode> {
		const context = app.audioCtx;
		if (!context) return 'AUDIO_BLOCKED';
		if (context.state !== 'running' && typeof context.resume === 'function') {
			// resume() stays pending without a user gesture; do not wait for it forever.
			const wait = delay(AUDIO_RESUME_WAIT_MS);
			const resumed = (async () => {
				try {
					await context.resume();
				} catch {
					// A refused or closed context is reported through its state below.
				}
			})();
			try {
				await Promise.race([resumed, wait.promise]);
			} finally {
				wait.cancel();
			}
		}
		return app.audioCtx?.state === 'running' ? 'OK' : 'AUDIO_BLOCKED';
	}

	function setListening(index: number, enabled: boolean): void {
		const current = app.vfos[index];
		if (Boolean(current.enabled) === enabled && !enabled) return;
		current.enabled = enabled;
		app.toggleVfoCheckbox(index);
	}

	async function listen(enabled: boolean): Promise<ResultCode> {
		if (busyState() !== 'none') return 'SWEEP_BUSY';
		if (enabled && !app.running) return 'RX_NOT_RUNNING';
		const index = activeIndex();
		if (!app.vfos?.[index]) return 'NOT_READY';
		setListening(index, enabled);
		return enabled ? ensureAudio() : 'OK';
	}

	async function stop(): Promise<ResultCode> {
		if (busyState() !== 'none') return 'SWEEP_BUSY';
		if (app.running) await app.togglePlay();
		return 'OK';
	}

	/** Connects the radio for a console start; a code when it cannot, otherwise null. */
	async function connectForStart(mock: boolean): Promise<[ResultCode, string?] | null> {
		const noticeBefore = app.snackbar?.message;
		const failure = (): [ResultCode, string?] => {
			const notice = app.snackbar?.message;
			const message = typeof notice === 'string' && notice && notice !== noticeBefore
				? (typeof app.tm === 'function' ? app.tm(notice) as string : notice)
				: undefined;
			return ['CONNECT_FAILED', message];
		};
		try {
			if (mock) {
				if (!app.mockSdrEnabled) return ['MOCK_UNAVAILABLE'];
				await app.connectMock();
				return app.connected ? null : failure();
			}
			if (!env.navigator.usb) return ['NO_WEBUSB'];
			const devices = await pairedHackRfs();
			pairedCount = devices.length;
			if (devices.length > 1) return ['NEEDS_DEVICE_CHOICE'];
			if (devices.length === 1) {
				await app.connectToDevice(devices[0]);
				return app.connected ? null : failure();
			}
			// The browser chooser needs the activation of the console click that sent
			// this command; without it the operator pairs on the Receiver page.
			if (!env.navigator.userActivation?.isActive) return ['NEEDS_PAIRING'];
			await app.pairNewDevice();
			if (app.connected) return null;
			const paired = await pairedHackRfs();
			pairedCount = paired.length;
			return paired.length === 0 ? ['NEEDS_PAIRING'] : failure();
		} catch (error) {
			return ['CONNECT_FAILED', errorText(error)];
		}
	}

	async function start(command: CommandOf<'console:start'>): Promise<[ResultCode, string?]> {
		if (busyState() !== 'none') return ['SWEEP_BUSY'];
		if (!app.backend) return ['NOT_READY'];
		const { centerHz, vfoHz, mode } = command;
		if ((centerHz !== undefined && !inTuneRange(centerHz)) || (vfoHz !== undefined && !inTuneRange(vfoHz))) return ['OUT_OF_RANGE'];
		if (centerHz !== undefined && vfoHz !== undefined && Math.abs(vfoHz - centerHz) > halfSampleRateHz()) return ['OUT_OF_RANGE'];
		if (mode !== undefined) {
			const code = vfo({ mode });
			if (code !== 'OK') return [code];
		}
		if (centerHz !== undefined) {
			const code = tune(centerHz, vfoHz);
			if (code !== 'OK') return [code];
		} else if (vfoHz !== undefined) {
			const code = vfo({ frequencyHz: vfoHz });
			if (code !== 'OK') return [code];
		}

		// An auto-connect of the authorised HackRF may already be opening the radio.
		if (connectInFlight) await connectInFlight;
		if (busyState() !== 'none') return ['SWEEP_BUSY'];
		if (!app.connected) {
			const failure = await connectForStart(command.mock);
			if (failure) return failure;
		}
		if (!app.running) await app.startStream();
		if (!app.running) {
			const notice = app.snackbar?.message;
			return ['CONNECT_FAILED', typeof notice === 'string' && notice ? (typeof app.tm === 'function' ? app.tm(notice) as string : notice) : undefined];
		}
		// The Receiver page then opens on the running Listener, not the wide-scan view.
		if (app.activeWorkspace === 'spectrum') app.activeWorkspace = 'listener';
		const index = activeIndex();
		if (!app.vfos?.[index]) return ['OK'];
		// The dashboard decides whether this start is audible, also when RX was already
		// running or an auto-connect started it before this command arrived.
		setListening(index, command.listen);
		return [command.listen ? await ensureAudio() : 'OK'];
	}

	/** Start, stop and listen run one after another so they never race each other. */
	function enqueue(id: string, task: () => Promise<[ResultCode, string?]>, fallback: ResultCode, done?: () => void): void {
		const run = async (): Promise<void> => {
			let result: [ResultCode, string?];
			try {
				result = await task();
			} catch (error) {
				result = [fallback, errorText(error)];
			} finally {
				done?.();
			}
			reply(id, result[0], result[1]);
		};
		lifecycle = lifecycle.then(run, run);
	}

	function handle(command: ConsoleCommand): void {
		switch (command.type) {
			case 'console:hello':
				sendHello();
				sendStatusNow();
				void refreshPairedCount();
				return;
			case 'invalid':
				reply(command.id, 'INVALID_COMMAND');
				return;
			case 'console:subscribe': {
				const next = clampSubscription(command);
				if (!subscription || subscription.fps !== next.fps) throttle.setFps(next.fps);
				subscription = next;
				if (heartbeat === null) heartbeat = env.setInterval(() => { if (!disposed) sendStatusNow(); }, STATUS_HEARTBEAT_MS);
				reply(command.id, 'OK');
				return;
			}
			case 'console:tune': {
				let code: ResultCode;
				try {
					code = tune(command.centerHz, command.vfoHz);
				} catch (error) {
					reply(command.id, 'NOT_READY', errorText(error));
					return;
				}
				reply(command.id, code);
				return;
			}
			case 'console:vfo': {
				let code: ResultCode;
				try {
					code = vfo(command);
				} catch (error) {
					reply(command.id, 'NOT_READY', errorText(error));
					return;
				}
				reply(command.id, code);
				return;
			}
			case 'console:start':
				// Set before the queue runs: an auto-connect that is already opening the
				// radio reads it when its RX starts.
				startsPending++;
				pendingListen = command.listen;
				enqueue(command.id, () => start(command), 'CONNECT_FAILED', () => { startsPending--; });
				return;
			case 'console:stop':
				enqueue(command.id, async () => [await stop()], 'NOT_READY');
				return;
			case 'console:listen':
				enqueue(command.id, async () => [await listen(command.enabled)], 'NOT_READY');
				return;
		}
	}

	const onMessage: MessageListener = event => {
		if (disposed || event.origin !== origin || event.source !== parent) return;
		const command = parseConsoleMessage(event.data);
		if (command) handle(command);
	};

	const onUsbChange = (): void => { void refreshPairedCount(); };

	win.addEventListener('message', onMessage);
	const usb = env.navigator.usb;
	if (usb && typeof usb.addEventListener === 'function') {
		usb.addEventListener('connect', onUsbChange);
		usb.addEventListener('disconnect', onUsbChange);
	}
	const unwatch: (() => void) | null = typeof app.$watch === 'function'
		? app.$watch(() => JSON.stringify(snapshot()), () => scheduleStatus())
		: null;

	sendHello();
	sendStatusNow();
	void refreshPairedCount();

	return {
		spectrum(data: ArrayLike<number>): void {
			if (disposed || !subscription?.spectrum || !app.running || !data || !data.length) return;
			if (!throttle.accept(env.monotonicNow())) return;
			const centerHz = mhzToHz(app.radio?.centerFreq);
			const sampleRateHz = finiteOrNull(app.radio?.sampleRate);
			if (centerHz === null || sampleRateHz === null) return;
			const cropped = cropSpectrum(data, centerHz, sampleRateHz, subscription.spanHz, subscription.bins);
			if (!cropped) return;
			post({
				type: 'receiver:spectrum',
				seq: ++spectrumSeq,
				tMs: env.now(),
				centerHz,
				startHz: cropped.startHz,
				stopHz: cropped.stopHz,
				sampleRateHz,
				fftSize: data.length,
				binCount: cropped.bins.length,
				bins: cropped.bins,
			}, [cropped.bins.buffer]);
		},
		initialVfoEnabled(): boolean {
			return startsPending > 0 ? pendingListen : true;
		},
		trackConnect(pending: Promise<unknown>): void {
			const settled = Promise.resolve(pending).then(() => undefined, () => undefined);
			connectInFlight = settled;
			void settled.then(() => {
				if (connectInFlight === settled) connectInFlight = null;
			});
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			win.removeEventListener('message', onMessage);
			if (usb && typeof usb.removeEventListener === 'function') {
				usb.removeEventListener('connect', onUsbChange);
				usb.removeEventListener('disconnect', onUsbChange);
			}
			unwatch?.();
			if (statusTimer !== null) env.clearTimeout(statusTimer);
			if (heartbeat !== null) env.clearInterval(heartbeat);
			statusTimer = null;
			heartbeat = null;
		},
	};
}
