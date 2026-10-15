// The Receiver side of the console dashboard bridge: envelope and sender checks,
// the protocol constants, spectrum crop and throttle, status messages and every
// console command against a fake Receiver app. Run with:
//   node --test tools/test_receiver_console_bridge.mjs
// Needs the vendor/BrowSDR submodule and Node 22.13+.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./receiver_overlay_hooks.mjs', import.meta.url);
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
	if (specifier === 'comlink') {
		return { url: 'data:text/javascript,export const proxy = value => value; export const transfer = value => value; export function wrap() { return {}; }', shortCircuit: true };
	}
	return nextResolve(specifier, context);
}`)}`);

const appDir = new URL('./browsdr_receiver_overlay/src/client/app/', import.meta.url);
const protocol = await import(new URL('console-bridge-protocol.ts', appDir).href);
const { installConsoleBridge, AUDIO_RESUME_WAIT_MS, RADIO_POLL_MS, RADIO_RESTART_WAIT_MS, SWEEP_STOP_WAIT_MS } = await import(new URL('console-bridge.ts', appDir).href);
const { connectionMethods } = await import(new URL('connection.ts', appDir).href);
const { vfoMethods } = await import(new URL('vfo.ts', appDir).href);
const { makeDefaultVfo, MODE_DEFAULTS } = await import(new URL('../vendor/BrowSDR/src/client/app/constants.ts', import.meta.url).href);

const {
	BRIDGE_CHANNEL, BRIDGE_VERSION, FRAME_MESSAGE_TYPES, CONSOLE_MESSAGE_TYPES, LISTEN_MODES, RESULT_CODES,
	STATUS_ERROR_CODES, SUBSCRIBE_LIMITS, SPECTRUM_FLOOR_DB, TUNE_SOURCES, SWEEP_LIMITS, STATUS_DEBOUNCE_MS,
	STATUS_URGENT_MIN_MS, DISPLAY_DB_LIMITS, SAMPLE_RATES_HZ, GAIN_LIMITS, SWEEP_FFT_SIZES, SWEEP_VIEWS, SWEEP_SOURCES, SWEEP_PHASES,
	SWEEP_SPAN_LIMITS, clampDisplayRange, clampSubscription, cropSpectrum, createFrameThrottle, decimateMaxHold, inSweepRange,
	onGainStep, parseConsoleMessage, sweepMaxSpanHz,
} = protocol;
const {
	SWEEP_MIN_FREQUENCY_HZ, SWEEP_MAX_FREQUENCY_HZ, SWEEP_MAX_BINS, SWEEP_SAMPLE_RATE_HZ, validateSweepConfig,
} = await import(new URL('./browsdr_receiver_overlay/src/client/worker/sweep-types.ts', import.meta.url).href);
const { HackRFDevice } = await import(new URL('./browsdr_receiver_overlay/src/client/devices/hackrf.ts', import.meta.url).href);
const { MockHackRF } = await import(new URL('./browsdr_receiver_overlay/src/client/worker/mock-hackrf.ts', import.meta.url).href);
const DEVICE_RATES = [2_000_000, 4_000_000, 5_000_000, 8_000_000, 10_000_000, 16_000_000, 20_000_000];

const ORIGIN = 'http://127.0.0.1:8787';
const EPOCH_MS = 1_760_000_000_000;
const settle = async (rounds = 8) => {
	for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
};

/** Manual timers: nothing runs until advance(). */
function createClock() {
	let now = 0;
	let nextId = 1;
	const timers = new Map();
	return {
		now: () => EPOCH_MS + now,
		monotonicNow: () => now,
		setTimeout(callback, ms) { const id = nextId++; timers.set(id, { at: now + ms, callback, every: 0 }); return id; },
		clearTimeout(id) { timers.delete(id); },
		setInterval(callback, ms) { const id = nextId++; timers.set(id, { at: now + ms, callback, every: ms }); return id; },
		clearInterval(id) { timers.delete(id); },
		advance(ms) {
			const target = now + ms;
			for (;;) {
				let nextTimer = null;
				for (const [id, timer] of timers) {
					if (timer.at <= target && (!nextTimer || timer.at < nextTimer[1].at)) nextTimer = [id, timer];
				}
				if (!nextTimer) break;
				const [id, timer] = nextTimer;
				now = timer.at;
				if (timer.every) timer.at += timer.every;
				else timers.delete(id);
				timer.callback();
			}
			now = target;
		},
		pending: () => timers.size,
	};
}

class FakeUsbDevice {
	constructor(serialNumber = '0000000000000000a06063c8234e6c5f') {
		this.vendorId = 0x1d50;
		this.productId = 0x6089;
		this.serialNumber = serialNumber;
	}
}

class FakeAudioContext {
	constructor(policy) {
		this.policy = policy;
		this.state = 'suspended';
		this.resumeCalls = 0;
	}
	resume() {
		this.resumeCalls++;
		if (this.policy.allowed) {
			this.state = 'running';
			return Promise.resolve();
		}
		// Chromium keeps resume() pending until a user gesture.
		return new Promise(() => {});
	}
	async close() { this.state = 'closed'; }
}

/** A console parent window and the framed Receiver window. */
function createFrame({ parentOrigin = ORIGIN, crossOrigin = false, usbDevices = [new FakeUsbDevice()], webusb = true, activation = false } = {}) {
	const posted = [];
	const parent = {
		get location() {
			if (crossOrigin) throw new Error('SecurityError: Blocked a frame from accessing a cross-origin frame.');
			return { origin: parentOrigin };
		},
		postMessage(message, targetOrigin, transfer = []) {
			// Clone like the browser: catches values that cannot cross windows and detaches transfers.
			posted.push({ message: structuredClone(message, { transfer }), targetOrigin, transfer });
		},
	};
	const listeners = new Set();
	const win = {
		parent,
		location: { origin: ORIGIN },
		addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
		removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
	};
	const usbListeners = new Map();
	const usb = {
		devices: usbDevices,
		async getDevices() { return this.devices; },
		addEventListener(type, listener) { usbListeners.set(type, listener); },
		removeEventListener(type, listener) { if (usbListeners.get(type) === listener) usbListeners.delete(type); },
	};
	const navigatorLike = { userActivation: { isActive: activation } };
	if (webusb) navigatorLike.usb = usb;
	const dispatch = (data, { origin = ORIGIN, source = parent } = {}) => {
		for (const listener of [...listeners]) listener({ data, origin, source });
	};
	const send = (type, payload = {}) => dispatch({ ch: BRIDGE_CHANNEL, v: BRIDGE_VERSION, type, ...payload });
	return { win, parent, posted, dispatch, send, listeners, usb, usbListeners, navigator: navigatorLike };
}

function receiverApp({ audioAllowed = true, openOk = true, mockSdrEnabled = false, sampleRates = DEVICE_RATES, ampName = 'Amp (14dB)', sweepSupport = true } = {}) {
	const log = [];
	const watchers = [];
	const audioPolicy = { allowed: audioAllowed };
	// startRx: fails the next RX start (the stream could not start). sweep: the next scan start throws this error.
	const failures = { startRx: false, sweep: null };
	const backend = {
		async open(target) { log.push(['open', target === 'mock' ? 'mock' : 'usb']); return openOk; },
		async info() { return { name: log.some(entry => entry[0] === 'open' && entry[1] === 'mock') ? 'Mock SDR (Signal Gen)' : 'HackRF One' }; },
		async getDeviceCapabilities() {
			return {
				gainControls: [
					{ name: 'LNA', min: 0, max: 40, step: 8, default: 40 },
					{ name: 'VGA', min: 0, max: 62, step: 2, default: 20 },
					{ name: ampName, min: 0, max: 1, step: 1, default: 0 },
				],
				sampleRates,
				supportsNativeSweep: sweepSupport,
				supportsManualSweep: sweepSupport,
			};
		},
		async startRxStream(options) {
			log.push(['startRx', options.centerFreq, options.sampleRate]);
			if (failures.startRx) {
				failures.startRx = false;
				throw new Error('stream failed');
			}
		},
		async setGains(gains) { log.push(['setGains', gains]); },
		async setFrequency(mhz) { log.push(['setFrequency', mhz]); },
		async stopRx() { log.push('stopRx'); },
		setVfoParams(index, params) { log.push(['vfoParams', index, params.freq, params.mode, params.enabled]); },
		async addVfo() {},
		async getDspStats() { return null; },
		async close() { log.push('close'); },
	};
	const app = {
		...connectionMethods,
		...vfoMethods,
		backend,
		connected: false,
		running: false,
		mockDevice: false,
		mockSdrEnabled,
		remoteMode: 'none',
		activeWorkspace: 'spectrum',
		radio: { centerFreq: 100, frequencyShift: 0, sampleRate: 20_000_000, fftSize: 65536, iqCorrection: true },
		display: { minDB: -70, maxDB: 0, auto: true },
		gains: {},
		deviceCapabilities: null,
		info: { boardName: '' },
		vfos: [makeDefaultVfo(100)],
		activeVfoIndex: 0,
		vfoSquelchOpen: [],
		snackbar: { show: false, message: '' },
		// The Receiver's scan defaults (state.ts).
		sweep: {
			active: false, starting: false, stopping: false, listening: false, listenStarting: false, error: '', source: 'simulated', hasResults: false,
			returnToRx: false, startMHz: 100, endMHz: 1000, fftSize: 8192, lnaGain: 40, vgaGain: 20, ampEnabled: false,
			displayMinDb: -60, displayMaxDb: 0, view: 'average',
		},
		audioRecording: { armed: false, starting: false, notice: '', error: '' },
		devicePicker: { show: false, devices: [] },
		vfoConflictDialog: { show: false },
		audioCtx: null,
		_mediaAudioEl: null,
		_whisperVfoStates: [],
		_rxStreamId: 0,
		_statsTimer: null,
		initCanvas() {},
		formatFreq(mhz) { return mhz.toFixed(6).padStart(10, '0'); },
		showMsg(message) { this.snackbar.message = message; this.snackbar.show = true; log.push(['msg', message]); },
		tm(message) { return message; },
		_initAudioCtx() { if (!this.audioCtx) this.audioCtx = new FakeAudioContext(audioPolicy); },
		async stopVfoAudioRecording() {},
		async disarmVfoAudioRecording() { this.audioRecording.armed = false; },
		// The Receiver's scan start (sweep.ts startSweep after the builder's pauseReceiverForSweep), without the worker.
		async startSweep() {
			log.push(['startSweep', this.sweep.source]);
			if (this.sweep.active || this.sweep.starting || this.sweep.stopping) return;
			this.sweep.starting = true;
			this.sweep.error = '';
			this.sweep.returnToRx = this.sweep.returnToRx || this.running;
			try {
				if (this.running) await this.togglePlay(false, true);
				if (failures.sweep) {
					this.sweep.error = failures.sweep;
					this.showMsg(`Sweep error: ${failures.sweep}`);
					failures.sweep = null;
					this.sweep.returnToRx = false;
					return;
				}
				this.sweep.active = true;
			} finally {
				this.sweep.starting = false;
			}
		},
		async startHardwareSweep() {
			const capabilities = this.deviceCapabilities;
			const source = capabilities?.supportsNativeSweep ? 'native' : capabilities?.supportsManualSweep ? 'manual' : null;
			if (!source) {
				this.showMsg('Connected device does not support hardware wide spectrum scanning.');
				this.sweep.returnToRx = false;
				return false;
			}
			this.sweep.source = source;
			await this.startSweep();
			return this.sweep.active || this.sweep.starting;
		},
		async stopSweep(resumeReceiver = true) {
			log.push(['stopSweep', resumeReceiver]);
			if (this.sweep.starting && !this.sweep.active) return false;
			if (!this.sweep.active) return !this.sweep.stopping;
			const shouldResume = resumeReceiver && this.sweep.returnToRx;
			this.sweep.active = false;
			this.sweep.stopping = true;
			await Promise.resolve();
			this.sweep.stopping = false;
			this.sweep.returnToRx = false;
			if (shouldResume && this.connected) await this.startStream();
			return true;
		},
		initSweepCanvas() { log.push('initSweepCanvas'); },
		drawSweepSpectrum() { log.push('drawSweepSpectrum'); },
		// Both can open a confirm() or stop RX on their own; the bridge must never call them.
		requestWorkspace() { throw new Error('requestWorkspace() from the bridge'); },
		selectWorkspace() { throw new Error('selectWorkspace() from the bridge'); },
		connect() { throw new Error('connect() from the bridge'); },
		async pairNewDevice() { log.push('pairNewDevice'); },
		$watch(getter, callback) {
			const watcher = { getter, callback, last: getter() };
			watchers.push(watcher);
			return () => watchers.splice(watchers.indexOf(watcher), 1);
		},
	};
	/** Stands in for Vue noticing reactive changes. */
	const flushWatchers = () => {
		for (const watcher of [...watchers]) {
			const value = watcher.getter();
			if (value !== watcher.last) {
				watcher.last = value;
				watcher.callback();
			}
		}
	};
	// Vue runs pending watchers before the next tick resolves.
	app.$nextTick = async () => { flushWatchers(); };
	// The Receiver's [sampleRate, fftSize] watcher in main.ts: it restarts a running RX.
	app.$watch(() => `${app.radio.sampleRate}|${app.radio.fftSize}`, async () => {
		if (!app.running) return;
		const resumeRecording = app.audioRecording.armed;
		app._rxRestarting = true;
		try {
			await app.togglePlay();
			await app.togglePlay(true);
		} finally {
			app._rxRestarting = false;
		}
		if (resumeRecording) log.push('resumeRecording');
	});
	return { app, log, watchers, flushWatchers, audioPolicy, failures };
}

/** Installs a bridge on a fake app and frame; the stats timer of a started RX is cleared afterwards. */
function setup(t, { frame: frameOptions = {}, app: appOptions = {} } = {}) {
	const frame = createFrame(frameOptions);
	const fake = receiverApp(appOptions);
	const clock = createClock();
	const bridge = installConsoleBridge(fake.app, {
		window: frame.win,
		navigator: frame.navigator,
		now: clock.now,
		monotonicNow: clock.monotonicNow,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
	});
	fake.app._consoleBridge = bridge;
	t.after(() => {
		clearInterval(fake.app._statsTimer);
		bridge?.dispose();
	});
	const messages = type => frame.posted.map(entry => entry.message).filter(message => message.type === type);
	const result = id => {
		const results = messages('receiver:result').filter(message => message.id === id);
		assert.ok(results.length <= 1, `exactly one result for ${id}, got ${results.length}`);
		return results[0];
	};
	return { ...fake, frame, clock, bridge, messages, result };
}

// ---------------------------------------------------------------------------
// Protocol constants and parsing

test('protocol constants match the console contract', () => {
	assert.equal(BRIDGE_CHANNEL, 'sdr-console-receiver');
	assert.equal(BRIDGE_VERSION, 1);
	assert.deepEqual([...FRAME_MESSAGE_TYPES], ['receiver:hello', 'receiver:status', 'receiver:spectrum', 'receiver:result', 'receiver:sweep']);
	assert.deepEqual([...CONSOLE_MESSAGE_TYPES], [
		'console:hello', 'console:subscribe', 'console:start', 'console:stop', 'console:tune', 'console:vfo', 'console:listen',
		'console:display', 'console:gains', 'console:radio', 'console:sweep-start', 'console:sweep-stop', 'console:sweep-config',
		'console:sweep-display',
	]);
	assert.deepEqual([...LISTEN_MODES], ['nfm', 'wfm', 'am', 'usb', 'lsb', 'dsb', 'cw', 'raw']);
	assert.deepEqual([...LISTEN_MODES].sort(), Object.keys(MODE_DEFAULTS).sort(), 'every Receiver mode, nothing else');
	assert.deepEqual([...RESULT_CODES], [
		'OK', 'NOT_READY', 'INVALID_COMMAND', 'NO_WEBUSB', 'NEEDS_PAIRING', 'NEEDS_DEVICE_CHOICE', 'MOCK_UNAVAILABLE',
		'CONNECT_FAILED', 'SWEEP_BUSY', 'RX_NOT_RUNNING', 'OUT_OF_RANGE', 'AUDIO_BLOCKED', 'RECORDING_ACTIVE', 'SWEEP_UNSUPPORTED',
		'SWEEP_FAILED', 'TIMEOUT',
	]);
	assert.deepEqual([...STATUS_ERROR_CODES], ['USB_LOST', 'RX_ERROR', 'NO_WEBUSB']);
	assert.deepEqual({ ...SUBSCRIBE_LIMITS }, {
		binsMin: 64, binsMax: 2048, binsDefault: 512, fpsMin: 1, fpsMax: 15, fpsDefault: 10, spanMinHz: 100000, spanDefaultHz: 2000000,
	});
	assert.deepEqual([...TUNE_SOURCES], ['console', 'receiver']);
	assert.deepEqual({ ...SWEEP_LIMITS }, { minHz: SWEEP_MIN_FREQUENCY_HZ, maxHz: SWEEP_MAX_FREQUENCY_HZ }, 'the Receiver sweep range');
	assert.equal(STATUS_DEBOUNCE_MS, 100);
	assert.equal(STATUS_URGENT_MIN_MS, 20);
	assert.deepEqual({ ...DISPLAY_DB_LIMITS }, { minDb: -160, maxDb: 60, minGapDb: 5 }, 'the scan graph limits');
});

test('sample rates and gain limits are the RadioSpectrum and Mock SDR controls', () => {
	for (const device of [new HackRFDevice(), new MockHackRF()]) {
		assert.deepEqual([...SAMPLE_RATES_HZ], [...device.sampleRates], device.deviceType);
		for (const [kind, name] of [['lna', 'LNA'], ['vga', 'VGA']]) {
			const control = device.gainControls.find(entry => entry.name === name);
			assert.deepEqual({ ...GAIN_LIMITS[kind] }, { min: control.min, max: control.max, step: control.step }, `${device.deviceType} ${name}`);
		}
		assert.ok(device.gainControls.some(entry => entry.name.startsWith('Amp') && entry.min === 0 && entry.max === 1), `${device.deviceType} amp`);
	}
	assert.deepEqual(DEVICE_RATES, [...SAMPLE_RATES_HZ]);
	assert.equal(onGainStep(24, GAIN_LIMITS.lna), true);
	assert.equal(onGainStep(0, GAIN_LIMITS.vga), true);
	assert.equal(onGainStep(62, GAIN_LIMITS.vga), true);
	for (const [value, control] of [[7, GAIN_LIMITS.lna], [48, GAIN_LIMITS.lna], [-8, GAIN_LIMITS.lna], [63, GAIN_LIMITS.vga], [Number.NaN, GAIN_LIMITS.vga]]) {
		assert.equal(onGainStep(value, control), false, String(value));
	}
});

test('clampDisplayRange keeps a manual range inside the graph limits, min first', () => {
	assert.deepEqual(clampDisplayRange(-90, -20), { minDb: -90, maxDb: -20 });
	assert.deepEqual(clampDisplayRange(-90.04, -19.96), { minDb: -90, maxDb: -20 }, '0.1 dB steps');
	assert.deepEqual(clampDisplayRange(-200, 100), { minDb: -160, maxDb: 60 });
	assert.deepEqual(clampDisplayRange(-20, -90), { minDb: -20, maxDb: -15 }, 'an inverted range keeps the minimum');
	assert.deepEqual(clampDisplayRange(-40, -38), { minDb: -40, maxDb: -35 }, 'at least 5 dB apart');
	assert.deepEqual(clampDisplayRange(70, 80), { minDb: 55, maxDb: 60 });
	for (const [min, max] of [[Number.NaN, 0], [-70, Infinity], ['-70', 0], [null, 0], [-70, undefined]]) {
		assert.equal(clampDisplayRange(min, max), null, `${min}, ${max}`);
	}
});

test('parseConsoleMessage ignores foreign envelopes and unusable ids', () => {
	const tune = { ch: BRIDGE_CHANNEL, v: BRIDGE_VERSION, type: 'console:tune', id: 'c1-ab', centerHz: 433_920_000 };
	assert.deepEqual(parseConsoleMessage(tune), { type: 'console:tune', id: 'c1-ab', centerHz: 433_920_000 });
	for (const data of [
		null, undefined, 'console:tune', [tune], 42,
		{ ...tune, ch: 'other-channel' },
		{ ...tune, v: 2 },
		{ ...tune, v: '1' },
		{ ...tune, type: 'console:unknown' },
		{ ...tune, type: 'receiver:status' },
		{ ...tune, id: undefined },
		{ ...tune, id: '' },
		{ ...tune, id: 'has space' },
		{ ...tune, id: 'x'.repeat(65) },
		{ ...tune, id: 7 },
	]) {
		assert.equal(parseConsoleMessage(data), null, JSON.stringify(data));
	}
	assert.deepEqual(parseConsoleMessage({ ch: BRIDGE_CHANNEL, v: BRIDGE_VERSION, type: 'console:hello' }), { type: 'console:hello' });
});

test('parseConsoleMessage marks a wrong payload invalid and normalizes valid ones', () => {
	const envelope = (type, payload) => ({ ch: BRIDGE_CHANNEL, v: BRIDGE_VERSION, type, id: 'c2-x', ...payload });
	const invalid = { type: 'invalid', id: 'c2-x' };
	assert.deepEqual(parseConsoleMessage(envelope('console:tune', {})), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:tune', { centerHz: '433920000' })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:tune', { centerHz: Number.NaN })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:tune', { centerHz: 1e8, vfoHz: Infinity })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:listen', { enabled: 'yes' })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:subscribe', { bins: 512 })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:vfo', { mode: 'fm' })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:vfo', { volume: null })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:start', { mock: 'true' })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:start', { mode: 'NFM' })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:display', {})), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:display', { auto: 'false' })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:display', { auto: false, minDb: -90 })), invalid, 'both limits or neither');
	assert.deepEqual(parseConsoleMessage(envelope('console:display', { auto: false, minDb: -90, maxDb: '-20' })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:gains', {})), invalid, 'at least one gain');
	assert.deepEqual(parseConsoleMessage(envelope('console:gains', { lnaDb: '24' })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:gains', { vgaDb: Number.NaN })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:gains', { amp: 1 })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:radio', {})), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:radio', { sampleRateHz: '20000000' })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:radio', { sampleRateHz: 2_000_000.5 })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:radio', { sampleRateHz: -2_000_000 })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:radio', { sampleRateHz: 2_000_000, confirmRecording: 'yes' })), invalid);

	assert.deepEqual(parseConsoleMessage(envelope('console:tune', { centerHz: 433_920_000.4, vfoHz: 434_000_000 })),
		{ type: 'console:tune', id: 'c2-x', centerHz: 433_920_000, vfoHz: 434_000_000 });
	assert.deepEqual(parseConsoleMessage(envelope('console:start', { mock: true, listen: false, mode: 'am', centerHz: 1e8 })),
		{ type: 'console:start', id: 'c2-x', mock: true, listen: false, mode: 'am', centerHz: 100_000_000 });
	assert.deepEqual(parseConsoleMessage(envelope('console:start', {})), { type: 'console:start', id: 'c2-x', mock: false, listen: false });
	assert.deepEqual(parseConsoleMessage(envelope('console:vfo', { mode: 'usb', volume: 30 })), { type: 'console:vfo', id: 'c2-x', mode: 'usb', volume: 30 });
	assert.deepEqual(parseConsoleMessage(envelope('console:stop', { extra: 1 })), { type: 'console:stop', id: 'c2-x' });
	assert.deepEqual(parseConsoleMessage(envelope('console:display', { auto: true })), { type: 'console:display', id: 'c2-x', auto: true });
	assert.deepEqual(parseConsoleMessage(envelope('console:display', { auto: false, minDb: -200, maxDb: -199 })),
		{ type: 'console:display', id: 'c2-x', auto: false, minDb: -160, maxDb: -155 }, 'clamped like the console sends it');
	assert.deepEqual(parseConsoleMessage(envelope('console:subscribe', { spectrum: true, bins: 9999, fps: 0, spanHz: 10 })),
		{ type: 'console:subscribe', id: 'c2-x', spectrum: true, bins: 2048, fps: 1, spanHz: 100_000 });
	assert.deepEqual(parseConsoleMessage(envelope('console:gains', { lnaDb: 24, amp: false, extra: 1 })), { type: 'console:gains', id: 'c2-x', lnaDb: 24, amp: false });
	assert.deepEqual(parseConsoleMessage(envelope('console:gains', { vgaDb: 7 })), { type: 'console:gains', id: 'c2-x', vgaDb: 7 }, 'the step is checked against the device');
	assert.deepEqual(parseConsoleMessage(envelope('console:radio', { sampleRateHz: 8_000_000 })), { type: 'console:radio', id: 'c2-x', sampleRateHz: 8_000_000 });
	assert.deepEqual(parseConsoleMessage(envelope('console:radio', { sampleRateHz: 8_000_000, confirmRecording: false })), { type: 'console:radio', id: 'c2-x', sampleRateHz: 8_000_000 });
	assert.deepEqual(parseConsoleMessage(envelope('console:radio', { sampleRateHz: 8_000_000, confirmRecording: true })),
		{ type: 'console:radio', id: 'c2-x', sampleRateHz: 8_000_000, confirmRecording: true });
});

test('clampSubscription clamps ranges and defaults non-numbers', () => {
	assert.deepEqual(clampSubscription({ spectrum: true }), { spectrum: true, bins: 512, fps: 10, spanHz: 2_000_000 });
	assert.deepEqual(clampSubscription({ spectrum: false, bins: 1, fps: 99, spanHz: 5_000_000 }), { spectrum: false, bins: 64, fps: 15, spanHz: 5_000_000 });
	assert.deepEqual(clampSubscription({ spectrum: 'yes', bins: Number.NaN, fps: '5', spanHz: -1 }), { spectrum: false, bins: 512, fps: 10, spanHz: 100_000 });
	assert.equal(clampSubscription({ bins: 300.6 }).bins, 301);
});

// ---------------------------------------------------------------------------
// Spectrum crop and throttle

test('cropSpectrum maps a DC-centred frame and keeps the peak of each output bin', () => {
	// 1024 bins over 1.024 MHz: 1 kHz per bin, index 512 is the centre.
	const data = new Float32Array(1024).fill(-90);
	data[532] = -10; // centre + 20 kHz
	data[600] = 0; // centre + 88 kHz, outside a 100 kHz span
	const cropped = cropSpectrum(data, 100_000_000, 1_024_000, 100_000, 10);
	assert.equal(cropped.startHz, 99_950_000);
	assert.equal(cropped.stopHz, 100_050_000);
	assert.equal(cropped.bins.length, 10);
	assert.ok(cropped.bins instanceof Float32Array);
	assert.notEqual(cropped.bins.buffer, data.buffer, 'a fresh buffer, safe to transfer');
	const step = (cropped.stopHz - cropped.startHz) / cropped.bins.length;
	const peakBin = Math.floor((100_020_000 - cropped.startHz) / step);
	assert.equal(peakBin, 7);
	assert.deepEqual([...cropped.bins], Array.from({ length: 10 }, (_, k) => (k === peakBin ? -10 : -90)));
	assert.equal(data[600], 0, 'the source frame is not modified');
});

test('cropSpectrum with a span at or above the sample rate keeps the whole frame and never upsamples', () => {
	const data = Float32Array.from({ length: 256 }, (_, i) => -100 + i / 4);
	const whole = cropSpectrum(data, 433_920_000, 2_560_000, 5_000_000, 2048);
	assert.equal(whole.startHz, 433_920_000 - 1_280_000);
	assert.equal(whole.stopHz, 433_920_000 + 1_280_000);
	assert.deepEqual([...whole.bins], [...data]);
	const halved = cropSpectrum(data, 433_920_000, 2_560_000, 2_560_000, 128);
	assert.equal(halved.bins.length, 128);
	assert.equal(halved.bins[0], data[1]);
	assert.equal(halved.bins[127], data[255]);
});

test('cropSpectrum for the dashboard default: 2 MHz of a 20 MHz, 65536-point frame into 512 bins', () => {
	const data = new Float32Array(65536).fill(-80);
	data[32768 + 3276] = -5; // centre + 999.76 kHz: the last FFT bin inside the span
	data[32768 + 3277] = 0; // the first one outside it
	const cropped = cropSpectrum(data, 433_920_000, 20_000_000, 2_000_000, 512);
	const binHz = 20_000_000 / 65536;
	assert.equal(cropped.bins.length, 512);
	assert.ok(cropped.startHz <= 433_920_000 - 1_000_000 && cropped.startHz > 433_920_000 - 1_000_000 - binHz);
	assert.ok(cropped.stopHz >= 433_920_000 + 1_000_000 && cropped.stopHz < 433_920_000 + 1_000_000 + binHz);
	assert.equal(Math.max(...cropped.bins), -5);
	assert.equal(cropped.bins[511], -5);
});

test('cropSpectrum replaces bins without a finite value and rejects unusable input', () => {
	const data = Float32Array.from([-50, Number.NaN, -Infinity, Number.NaN, -40, -60, Number.NaN, -70]);
	const cropped = cropSpectrum(data, 1e8, 8000, 8000, 4);
	assert.deepEqual([...cropped.bins], [-50, SPECTRUM_FLOOR_DB, -40, -70]);
	assert.equal(cropSpectrum(new Float32Array(0), 1e8, 8000, 8000, 4), null);
	assert.equal(cropSpectrum(data, Number.NaN, 8000, 8000, 4), null);
	assert.equal(cropSpectrum(data, 1e8, 0, 8000, 4), null);
	assert.equal(cropSpectrum(data, 1e8, 8000, 0, 4), null);
	assert.equal(cropSpectrum(data, 1e8, 8000, 8000, 0), null);
});

test('the frame throttle keeps the requested average rate and does not burst after a pause', () => {
	const throttle = createFrameThrottle(10);
	let sent = 0;
	for (let frame = 0; frame < 90; frame++) {
		if (throttle.accept(frame * (1000 / 30))) sent++; // 30 FFT frames per second for 3 s
	}
	assert.equal(sent, 30);
	assert.equal(throttle.accept(10_000), true, 'the first frame after a pause passes');
	assert.equal(throttle.accept(10_033), false);
	assert.equal(throttle.accept(10_100), true);
	throttle.setFps(2);
	assert.equal(throttle.accept(10_110), true, 'a new rate starts a new schedule');
	assert.equal(throttle.accept(10_500), false);
	assert.equal(throttle.accept(10_610), true);
});

// ---------------------------------------------------------------------------
// Installation, envelope and sender checks

test('the bridge installs only under a different, same-origin parent', () => {
	const fake = receiverApp();
	const alone = createFrame();
	alone.win.parent = alone.win;
	assert.equal(installConsoleBridge(fake.app, { ...createClock(), window: alone.win, navigator: {} }), null);
	const noParent = createFrame();
	noParent.win.parent = null;
	assert.equal(installConsoleBridge(fake.app, { ...createClock(), window: noParent.win, navigator: {} }), null);
	for (const options of [{ crossOrigin: true }, { parentOrigin: 'http://127.0.0.1:9999' }]) {
		const frame = createFrame(options);
		assert.equal(installConsoleBridge(fake.app, { ...createClock(), window: frame.win, navigator: frame.navigator }), null);
		assert.equal(frame.listeners.size, 0);
		assert.deepEqual(frame.posted, []);
	}
});

test('messages from another origin or window, or outside the envelope, are ignored', async t => {
	const { frame, app, messages } = setup(t);
	const tune = { ch: BRIDGE_CHANNEL, v: BRIDGE_VERSION, type: 'console:tune', id: 'c1-a', centerHz: 433_920_000 };
	frame.dispatch(tune, { origin: 'http://127.0.0.1:9999' });
	frame.dispatch(tune, { origin: 'null' });
	frame.dispatch(tune, { source: {} });
	frame.dispatch(tune, { source: null });
	frame.dispatch({ ...tune, ch: 'sdr-console' });
	frame.dispatch({ ...tune, v: 2 });
	frame.dispatch(JSON.stringify(tune));
	await settle();
	assert.equal(app.radio.centerFreq, 100);
	assert.deepEqual(messages('receiver:result'), []);

	frame.dispatch(tune);
	await settle();
	assert.equal(app.radio.centerFreq, 433.92);
	assert.deepEqual(messages('receiver:result'), [{
		ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:result', id: 'c1-a', ok: true, code: 'OK',
		tune: { rev: 1, by: 'console', id: 'c1-a', receiverRev: 0, centerHz: 433_920_000, vfoHz: 100_000_000 },
	}]);
	for (const entry of frame.posted) assert.equal(entry.targetOrigin, ORIGIN, 'posts only to the page origin');
});

test('the bridge greets on install and on every console hello, then reports the paired radio count', async t => {
	const { frame, clock, messages } = setup(t, { app: { mockSdrEnabled: true } });
	const [hello] = messages('receiver:hello');
	assert.deepEqual(hello, { ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:hello', protocol: 1, mockAvailable: true, webusb: true });
	assert.equal(frame.posted[0].message.type, 'receiver:hello');
	assert.equal(frame.posted[1].message.type, 'receiver:status', 'status follows hello');
	assert.equal(messages('receiver:status')[0].pairedCount, null, 'unknown until WebUSB answers');
	await settle();
	clock.advance(100);
	assert.equal(messages('receiver:status').at(-1).pairedCount, 1);

	frame.send('console:hello');
	assert.equal(messages('receiver:hello').length, 2);
	assert.equal(frame.posted.at(-1).message.type, 'receiver:status', 'an immediate status answers each hello');
	const seqs = messages('receiver:status').map(status => status.seq);
	assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
	assert.equal(new Set(seqs).size, seqs.length);

	frame.usb.devices = [];
	frame.usbListeners.get('disconnect')();
	await settle();
	clock.advance(100);
	assert.equal(messages('receiver:status').at(-1).pairedCount, 0);
});

test('without WebUSB the paired count stays unknown', async t => {
	const { clock, messages } = setup(t, { frame: { webusb: false } });
	await settle();
	clock.advance(500);
	const status = messages('receiver:status').at(-1);
	assert.equal(status.webusb, false);
	assert.equal(status.pairedCount, null);
	assert.equal(messages('receiver:hello')[0].webusb, false);
});

// ---------------------------------------------------------------------------
// Status

const STATUS_KEYS = [
	'ch', 'v', 'type', 'seq', 'tMs', 'webusb', 'mockAvailable', 'pairedCount', 'connected', 'mock', 'deviceName', 'running', 'busy',
	'workspace', 'centerHz', 'sampleRateHz', 'frequencyShiftHz', 'gains', 'vfo', 'squelchOpen', 'audio', 'recording', 'error', 'notice',
	'tune', 'display', 'sampleRatesHz', 'sweep',
];

test('status reports the radio in Hz with the documented fields', async t => {
	const { frame, app, clock, flushWatchers, messages, result } = setup(t, { app: { mockSdrEnabled: true } });
	frame.send('console:start', { id: 's1', mock: true, listen: false, mode: 'nfm', centerHz: 433_920_000, vfoHz: 433_925_000 });
	await settle(20);
	assert.equal(result('s1').code, 'OK');
	app.radio.frequencyShift = -125;
	app.vfoSquelchOpen = [true];
	app.audioRecording.armed = true;
	flushWatchers();
	clock.advance(100);
	const status = messages('receiver:status').at(-1);
	assert.deepEqual(Object.keys(status).sort(), [...STATUS_KEYS].sort());
	// Arming a recording is sent at once, after the 20 ms gap since the previous status.
	assert.equal(status.tMs, EPOCH_MS + STATUS_URGENT_MIN_MS);
	assert.deepEqual({ ...status, seq: 0, tMs: 0, ch: '', v: 0, type: '', notice: null }, {
		ch: '', v: 0, type: '', seq: 0, tMs: 0,
		webusb: true, mockAvailable: true, pairedCount: 1,
		connected: true, mock: true, deviceName: 'Mock SDR', running: true, busy: 'none', workspace: 'listener',
		centerHz: 433_920_000, sampleRateHz: 20_000_000, frequencyShiftHz: -125_000_000,
		gains: { lnaDb: 40, vgaDb: 20, amp: false },
		vfo: { index: 0, enabled: false, mode: 'nfm', frequencyHz: 433_925_000, bandwidthHz: 12_500, squelchEnabled: false, squelchDb: -100, volume: 50 },
		squelchOpen: true, audio: 'none', recording: true, error: null, notice: null,
		tune: { rev: 1, by: 'console', id: 's1', receiverRev: 0 },
		display: { auto: true, minDb: -70, maxDb: 0 },
		sampleRatesHz: DEVICE_RATES,
		// The scan range in displayed Hz: the Receiver's 100–1000 MHz plus the -125 MHz shift.
		sweep: {
			phase: 'idle', source: 'native', startHz: -25_000_000, stopHz: 875_000_000, fftSize: 8192, resolutionHz: 20_000_000 / 8192,
			lnaDb: 40, vgaDb: 20, amp: false, displayMinDb: -60, displayMaxDb: 0, view: 'average',
		},
	});
	assert.equal(status.notice, 'Connected to Mock SDR', 'the visible snackbar text, through tm()');
	app.snackbar.show = false;
	flushWatchers();
	clock.advance(100);
	assert.equal(messages('receiver:status').at(-1).notice, null);
});

test('status maps lost radio, stopped stream and missing WebUSB to codes', async t => {
	const { app, clock, flushWatchers, messages } = setup(t);
	const latestError = () => {
		flushWatchers();
		clock.advance(100);
		return messages('receiver:status').at(-1).error;
	};
	app.sweep.error = 'Radio disconnected (USB unplugged or lost). RX and scanning stopped. Reconnect the radio to continue.';
	assert.deepEqual(latestError(), { code: 'USB_LOST' });
	app.connected = true;
	assert.equal(latestError(), null, 'a reconnected radio is no longer lost');
	app.sweep.error = 'The radio stopped sending samples (stall). RX stopped. Check the USB cable, then press Resume or reconnect the radio.';
	assert.deepEqual(latestError(), { code: 'RX_ERROR' });
	app.running = true;
	assert.equal(latestError(), null);
	app.sweep.error = 'This browser has no WebUSB, so it cannot connect a RadioSpectrum. Open the console in Chrome or Edge (desktop or Android).';
	assert.deepEqual(latestError(), { code: 'NO_WEBUSB' });
	app.sweep.error = 'Sweep error: something else';
	assert.equal(latestError(), null);
	app.sweep.active = true;
	flushWatchers();
	clock.advance(100);
	assert.equal(messages('receiver:status').at(-1).busy, 'sweep');
	app.sweep.active = false;
	app.sweep.listening = true;
	flushWatchers();
	clock.advance(100);
	assert.equal(messages('receiver:status').at(-1).busy, 'scan-listen');
});

test('status changes are coalesced to one message per 100 ms and repeat every 2 s once subscribed', async t => {
	const { frame, app, clock, flushWatchers, messages } = setup(t);
	await settle();
	clock.advance(100);
	const before = messages('receiver:status').length;
	for (const mhz of [101, 102, 103, 104, 105]) {
		app.radio.centerFreq = mhz;
		flushWatchers();
		clock.advance(10);
	}
	assert.equal(messages('receiver:status').length, before, 'nothing before the window ends');
	clock.advance(50);
	assert.equal(messages('receiver:status').length, before + 1);
	assert.equal(messages('receiver:status').at(-1).centerHz, 105_000_000);
	clock.advance(5000);
	assert.equal(messages('receiver:status').length, before + 1, 'no heartbeat without a subscription');

	frame.send('console:subscribe', { id: 'sub-1', spectrum: false });
	clock.advance(100);
	const subscribed = messages('receiver:status').length;
	clock.advance(2000);
	assert.equal(messages('receiver:status').length, subscribed + 1);
	clock.advance(4000);
	assert.equal(messages('receiver:status').length, subscribed + 3);
});

// ---------------------------------------------------------------------------
// Spectrum messages

test('spectrum frames flow only while subscribed and running, cropped, throttled and transferred', async t => {
	const { frame, app, bridge, clock, messages } = setup(t);
	app.radio.centerFreq = 433.92;
	const data = new Float32Array(65536).fill(-80);
	data[32768] = -3;
	const feed = (count, everyMs) => {
		for (let i = 0; i < count; i++) {
			bridge.spectrum(data);
			clock.advance(everyMs);
		}
	};
	app.running = true;
	feed(10, 33);
	assert.deepEqual(messages('receiver:spectrum'), [], 'no subscription yet');

	frame.send('console:subscribe', { id: 'sub-2', spectrum: true, fps: 5, bins: 256, spanHz: 2_000_000 });
	app.running = false;
	feed(10, 33);
	assert.deepEqual(messages('receiver:spectrum'), [], 'RX stopped');

	app.running = true;
	feed(30, 1000 / 30); // one second of FFT frames
	const frames = messages('receiver:spectrum');
	assert.equal(frames.length, 5);
	const first = frames[0];
	assert.equal(first.centerHz, 433_920_000);
	assert.equal(first.sampleRateHz, 20_000_000);
	assert.equal(first.fftSize, 65536);
	assert.equal(first.binCount, 256);
	assert.ok(first.bins instanceof Float32Array && first.bins.length === 256);
	assert.ok(first.startHz < first.centerHz && first.stopHz > first.centerHz);
	assert.equal(Math.max(...first.bins), -3);
	assert.deepEqual(frames.map(message => message.seq), [1, 2, 3, 4, 5]);
	const spectrumPosts = frame.posted.filter(entry => entry.message.type === 'receiver:spectrum');
	for (const entry of spectrumPosts) {
		assert.equal(entry.transfer.length, 1);
		assert.equal(entry.transfer[0].byteLength, 0, 'the copy was transferred, not cloned');
	}
	assert.equal(data.length, 65536, 'the Listener keeps its frame');

	frame.send('console:subscribe', { id: 'sub-3', spectrum: false });
	feed(30, 33);
	assert.equal(messages('receiver:spectrum').length, 5, 'spectrum:false stops frames');
});

// ---------------------------------------------------------------------------
// Commands

test('tune sets centre and VFO directly, never through the conflict dialog', async t => {
	const { frame, app, log, result } = setup(t);
	app.vfos.push(makeDefaultVfo(150));
	app.running = true;
	frame.send('console:tune', { id: 't1', centerHz: 433_920_000, vfoHz: 434_000_000 });
	assert.equal(result('t1').code, 'OK');
	assert.equal(app.radio.centerFreq, 433.92);
	assert.equal(app.vfos[0].freq, 434);
	assert.equal(app.vfos[0].displayFreq, '434.000000');
	assert.equal(app.vfoConflictDialog.show, false);
	assert.deepEqual(log.filter(entry => entry[0] === 'vfoParams').map(entry => entry.slice(1, 3)), [[0, 434], [1, 150]], 'every VFO is refreshed');

	frame.send('console:tune', { id: 't2', centerHz: 433_920_000, vfoHz: 444_000_000 });
	assert.equal(result('t2').code, 'OUT_OF_RANGE', 'more than half the sample rate away');
	frame.send('console:tune', { id: 't3', centerHz: 500_000 });
	assert.equal(result('t3').code, 'OUT_OF_RANGE');
	frame.send('console:tune', { id: 't4', centerHz: 6_000_000_001 });
	assert.equal(result('t4').code, 'OUT_OF_RANGE');
	assert.equal(app.radio.centerFreq, 433.92);
	assert.equal(app.vfos[0].freq, 434);

	app.sweep.listening = true;
	frame.send('console:tune', { id: 't5', centerHz: 100_000_000 });
	assert.equal(result('t5').code, 'SWEEP_BUSY');
	assert.equal(app.radio.centerFreq, 433.92);
	assert.equal(app.vfoConflictDialog.show, false);
});

test('tune while stopped is kept for the next start', async t => {
	const { frame, app, log, result } = setup(t, { app: { mockSdrEnabled: true } });
	frame.send('console:tune', { id: 't6', centerHz: 145_500_000 });
	assert.equal(result('t6').code, 'OK');
	assert.equal(app.vfos[0].freq, 100, 'the VFO keeps its frequency without vfoHz');
	frame.send('console:start', { id: 's2', mock: true, listen: false });
	await settle(20);
	assert.equal(result('s2').code, 'OK');
	assert.deepEqual(log.find(entry => entry[0] === 'startRx'), ['startRx', 145.5, 20_000_000]);
});

test('vfo applies the mode defaults on a mode change only and re-centres an out-of-band frequency', async t => {
	const { frame, app, result } = setup(t);
	app.radio.centerFreq = 433.92;
	app.vfos[0] = { ...makeDefaultVfo(433.92), mode: 'wfm', bandwidth: 150_000, squelchEnabled: true, squelchLevel: -40 };
	frame.send('console:vfo', { id: 'v1', mode: 'am' });
	assert.equal(result('v1').code, 'OK');
	assert.equal(app.vfos[0].mode, 'am');
	assert.equal(app.vfos[0].bandwidth, MODE_DEFAULTS.am.bandwidth);
	assert.equal(app.vfos[0].squelchEnabled, false);

	app.vfos[0].bandwidth = 7000;
	frame.send('console:vfo', { id: 'v2', mode: 'am' });
	assert.equal(app.vfos[0].bandwidth, 7000, 'the same mode keeps the operator bandwidth');

	frame.send('console:vfo', { id: 'v3', frequencyHz: 433_930_000, volume: 80 });
	assert.equal(result('v3').code, 'OK');
	assert.equal(app.radio.centerFreq, 433.92, 'in band: the centre stays');
	assert.equal(app.vfos[0].freq, 433.93);
	assert.equal(app.vfos[0].volume, 80);

	frame.send('console:vfo', { id: 'v4', frequencyHz: 868_000_000 });
	assert.equal(result('v4').code, 'OK');
	assert.equal(app.radio.centerFreq, 868, 'out of band: re-centred on the VFO');
	assert.equal(app.vfos[0].freq, 868);
	assert.equal(app.vfoConflictDialog.show, false);

	frame.send('console:vfo', { id: 'v5', volume: 101 });
	assert.equal(result('v5').code, 'OUT_OF_RANGE');
	frame.send('console:vfo', { id: 'v6', frequencyHz: 7_000_000_000 });
	assert.equal(result('v6').code, 'OUT_OF_RANGE');
	frame.send('console:vfo', { id: 'v7', mode: 'raw' });
	assert.equal(app.vfos[0].bandwidth, app.radio.sampleRate, 'raw uses the full sample rate');
	app.sweep.listening = true;
	frame.send('console:vfo', { id: 'v8', mode: 'nfm' });
	assert.equal(result('v8').code, 'SWEEP_BUSY', 'a scan listen owns the VFO');
	assert.equal(app.vfos[0].mode, 'raw');
});

test('listen needs a running receiver and reports blocked audio', async t => {
	const { frame, app, clock, result, audioPolicy } = setup(t, { app: { audioAllowed: false } });
	frame.send('console:listen', { id: 'l1', enabled: true });
	await settle();
	assert.equal(result('l1').code, 'RX_NOT_RUNNING');
	assert.equal(app.vfos[0].enabled, false);

	app.running = true;
	frame.send('console:listen', { id: 'l2', enabled: true });
	await settle();
	assert.equal(result('l2'), undefined, 'waits for resume()');
	clock.advance(AUDIO_RESUME_WAIT_MS);
	await settle();
	assert.equal(result('l2').code, 'AUDIO_BLOCKED');
	assert.equal(result('l2').ok, false);
	assert.equal(app.vfos[0].enabled, true, 'the VFO is unmuted; a second click can start audio');

	audioPolicy.allowed = true;
	frame.send('console:listen', { id: 'l3', enabled: true });
	await settle();
	assert.equal(result('l3').code, 'OK');
	assert.equal(app.audioCtx.state, 'running');

	frame.send('console:listen', { id: 'l4', enabled: false });
	await settle();
	assert.equal(result('l4').code, 'OK');
	assert.equal(app.vfos[0].enabled, false);
	clock.advance(100); // the status debounce
	assert.equal(clock.pending(), 0, 'the resume wait timer is cleared');
});

test('a start whose audio cannot resume still reports the running receiver as AUDIO_BLOCKED', async t => {
	const { frame, app, result } = setup(t, { app: { mockSdrEnabled: true } });
	app._initAudioCtx = function () {
		if (!this.audioCtx) this.audioCtx = { state: 'suspended', resume() { throw new Error('InvalidStateError'); }, async close() {} };
	};
	frame.send('console:start', { id: 'a1', mock: true, listen: true });
	await settle(20);
	assert.equal(result('a1').code, 'AUDIO_BLOCKED');
	assert.equal(app.running, true);
	assert.equal(app.vfos[0].enabled, true);
});

test('stop ends RX, is OK when already stopped and never ends a scan', async t => {
	const { frame, app, log, result } = setup(t, { app: { mockSdrEnabled: true } });
	frame.send('console:stop', { id: 'x1' });
	await settle();
	assert.equal(result('x1').code, 'OK');
	frame.send('console:start', { id: 's3', mock: true, listen: false });
	await settle(20);
	assert.equal(app.running, true);
	frame.send('console:stop', { id: 'x2' });
	await settle(20);
	assert.equal(result('x2').code, 'OK');
	assert.equal(app.running, false);
	assert.ok(log.includes('stopRx'));

	app.running = true;
	app.sweep.listening = true;
	frame.send('console:stop', { id: 'x3' });
	await settle();
	assert.equal(result('x3').code, 'SWEEP_BUSY');
	assert.equal(app.running, true);
	app.running = false;
});

test('start with the Mock SDR applies mode and frequencies, stays muted and opens the Listener', async t => {
	const { frame, app, log, result, bridge } = setup(t, { app: { mockSdrEnabled: true } });
	frame.send('console:start', { id: 's4', mock: true, listen: false, mode: 'nfm', centerHz: 433_920_000, vfoHz: 433_925_000 });
	assert.equal(bridge.initialVfoEnabled(), false, 'muted while this start runs');
	await settle(20);
	assert.deepEqual(result('s4'), {
		ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:result', id: 's4', ok: true, code: 'OK',
		tune: { rev: 1, by: 'console', id: 's4', receiverRev: 0, centerHz: 433_920_000, vfoHz: 433_925_000 },
	});
	assert.deepEqual(log.filter(entry => Array.isArray(entry) && (entry[0] === 'open' || entry[0] === 'startRx')), [['open', 'mock'], ['startRx', 433.92, 20_000_000]]);
	assert.equal(app.connected && app.mockDevice && app.running, true);
	assert.equal(app.vfos[0].mode, 'nfm');
	assert.equal(app.vfos[0].bandwidth, 12_500);
	assert.equal(app.vfos[0].freq, 433.925);
	assert.equal(app.vfos[0].enabled, false, 'VFO 1 stays muted without listen');
	assert.equal(app.activeWorkspace, 'listener');
	assert.equal(bridge.initialVfoEnabled(), true, 'back to the Receiver page default');
});

test('start refuses the Mock SDR when the frame does not offer it', async t => {
	const { frame, app, log, result } = setup(t);
	frame.send('console:start', { id: 's5', mock: true, listen: true });
	await settle(20);
	assert.equal(result('s5').code, 'MOCK_UNAVAILABLE');
	assert.equal(app.connected, false);
	assert.equal(log.filter(entry => entry[0] === 'open').length, 0);
});

test('start connects the one paired HackRF and listens when asked', async t => {
	const { frame, app, log, result } = setup(t);
	frame.send('console:start', { id: 's6', mock: false, listen: true, mode: 'wfm' });
	await settle(20);
	assert.equal(result('s6').code, 'OK');
	assert.deepEqual(log.filter(entry => entry[0] === 'open'), [['open', 'usb']]);
	assert.equal(app.running, true);
	assert.equal(app.vfos[0].enabled, true);
	assert.equal(app.audioCtx.state, 'running');
	assert.equal(app.devicePicker.show, false);
});

test('start reports what the operator has to do instead of opening an invisible picker', async t => {
	await t.test('no WebUSB', async st => {
		const { frame, result } = setup(st, { frame: { webusb: false } });
		frame.send('console:start', { id: 'n1', mock: false, listen: false });
		await settle(20);
		assert.equal(result('n1').code, 'NO_WEBUSB');
	});
	await t.test('nothing paired and no user activation', async st => {
		const { frame, log, result } = setup(st, { frame: { usbDevices: [] } });
		frame.send('console:start', { id: 'n2', mock: false, listen: false });
		await settle(20);
		assert.equal(result('n2').code, 'NEEDS_PAIRING');
		assert.ok(!log.includes('pairNewDevice'));
	});
	await t.test('nothing paired, chooser cancelled', async st => {
		const { frame, log, result } = setup(st, { frame: { usbDevices: [], activation: true } });
		frame.send('console:start', { id: 'n3', mock: false, listen: false });
		await settle(20);
		assert.ok(log.includes('pairNewDevice'), 'the click activation allows the browser chooser');
		assert.equal(result('n3').code, 'NEEDS_PAIRING');
	});
	await t.test('two paired radios', async st => {
		const { frame, app, log, result } = setup(st, { frame: { usbDevices: [new FakeUsbDevice('a'), new FakeUsbDevice('b')] } });
		frame.send('console:start', { id: 'n4', mock: false, listen: false });
		await settle(20);
		assert.equal(result('n4').code, 'NEEDS_DEVICE_CHOICE');
		assert.equal(app.devicePicker.show, false);
		assert.equal(log.filter(entry => entry[0] === 'open').length, 0);
	});
	await t.test('open fails', async st => {
		const { frame, app, result } = setup(st, { app: { openOk: false } });
		frame.send('console:start', { id: 'n5', mock: false, listen: false });
		await settle(20);
		assert.deepEqual({ code: result('n5').code, message: result('n5').message, ok: result('n5').ok }, { code: 'CONNECT_FAILED', message: 'Failed to open device.', ok: false });
		assert.equal(app.connected, false);
	});
	await t.test('a wide scan owns the radio', async st => {
		const { frame, app, log, result } = setup(st, { app: { mockSdrEnabled: true } });
		app.sweep.starting = true;
		frame.send('console:start', { id: 'n6', mock: true, listen: false, centerHz: 433_920_000 });
		await settle(20);
		assert.equal(result('n6').code, 'SWEEP_BUSY');
		assert.equal(app.radio.centerFreq, 100, 'nothing applied');
		assert.equal(log.filter(entry => entry[0] === 'open').length, 0);
	});
	await t.test('an out-of-band VFO', async st => {
		const { frame, app, result } = setup(st, { app: { mockSdrEnabled: true } });
		frame.send('console:start', { id: 'n7', mock: true, listen: false, centerHz: 433_920_000, vfoHz: 450_000_000 });
		await settle(20);
		assert.equal(result('n7').code, 'OUT_OF_RANGE');
		assert.equal(app.connected, false);
	});
});

test('start waits for an auto-connect in flight instead of opening the radio twice, and keeps VFO 1 muted', async t => {
	const { frame, app, log, result, bridge } = setup(t);
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	const autoConnect = (async () => {
		await gate;
		await app.connectToDevice(new FakeUsbDevice());
	})();
	bridge.trackConnect(autoConnect);
	frame.send('console:start', { id: 's7', mock: false, listen: false });
	await settle(20);
	assert.equal(result('s7'), undefined, 'still waiting for the auto-connect');
	release();
	await autoConnect;
	await settle(20);
	assert.equal(result('s7').code, 'OK');
	assert.equal(log.filter(entry => entry[0] === 'open').length, 1);
	assert.equal(app.running, true);
	assert.equal(app.vfos[0].enabled, false, 'the auto-connected RX started muted');
});

test('start mutes a receiver that an earlier auto-connect left audible', async t => {
	const { frame, app, log, result } = setup(t);
	await app.connectToDevice(new FakeUsbDevice());
	assert.equal(app.vfos[0].enabled, true, 'the Receiver page default unmutes VFO 1');
	frame.send('console:start', { id: 's8', mock: false, listen: false });
	await settle(20);
	assert.equal(result('s8').code, 'OK');
	assert.equal(app.vfos[0].enabled, false);
	assert.equal(log.filter(entry => entry[0] === 'open').length, 1);
});

test('start, stop and listen run in order; tune does not wait', async t => {
	const { frame, app, messages } = setup(t, { app: { mockSdrEnabled: true } });
	frame.send('console:start', { id: 'q1', mock: true, listen: false });
	frame.send('console:listen', { id: 'q2', enabled: true });
	frame.send('console:tune', { id: 'q3', centerHz: 145_000_000 });
	frame.send('console:stop', { id: 'q4' });
	await settle(40);
	assert.deepEqual(messages('receiver:result').map(message => [message.id, message.code]),
		[['q3', 'OK'], ['q1', 'OK'], ['q2', 'OK'], ['q4', 'OK']]);
	assert.equal(app.running, false);
});

test('a wide scan keeps tune and vfo to the stopped Listener and refuses start, stop and listen', async t => {
	const { frame, app, log, result } = setup(t, { app: { mockSdrEnabled: true } });
	app.sweep.active = true; // the scan stopped RX before it started
	frame.send('console:tune', { id: 'w1', centerHz: 433_920_000, vfoHz: 433_925_000 });
	assert.equal(result('w1').code, 'OK');
	assert.equal(app.radio.centerFreq, 433.92);
	assert.equal(app.vfos[0].freq, 433.925);
	assert.deepEqual(result('w1').tune, { rev: 1, by: 'console', id: 'w1', receiverRev: 0, centerHz: 433_920_000, vfoHz: 433_925_000 });
	frame.send('console:vfo', { id: 'w2', mode: 'am', frequencyHz: 868_000_000 });
	assert.equal(result('w2').code, 'OK');
	assert.equal(app.radio.centerFreq, 868, 're-centred in the Listener settings');
	assert.equal(app.vfos[0].mode, 'am');
	assert.equal(result('w2').tune.by, 'console');
	assert.deepEqual(log.filter(entry => Array.isArray(entry) && (entry[0] === 'vfoParams' || entry[0] === 'setFrequency')), [], 'no backend call during the scan');
	for (const [type, payload] of [
		['console:start', { id: 'w3', mock: true, listen: false, centerHz: 145_000_000 }],
		['console:stop', { id: 'w4' }],
		['console:listen', { id: 'w5', enabled: true }],
	]) {
		frame.send(type, payload);
		await settle(20);
		assert.equal(result(payload.id).code, 'SWEEP_BUSY', type);
	}
	assert.equal(app.connected, false);
	assert.equal(app.radio.centerFreq, 868, 'a refused start applies nothing');

	// A scan start that has not stopped RX yet refuses a tune.
	app.running = true;
	frame.send('console:tune', { id: 'w6', centerHz: 145_000_000 });
	assert.equal(result('w6').code, 'SWEEP_BUSY');
	assert.equal(result('w6').tune.rev, 2, 'a refused tune reports the tuning it left in place');
	app.running = false;

	// A scan listen refuses every radio command.
	app.sweep.active = false;
	app.sweep.listening = true;
	frame.send('console:tune', { id: 'w7', centerHz: 145_000_000 });
	frame.send('console:vfo', { id: 'w8', frequencyHz: 868_010_000 });
	assert.equal(result('w7').code, 'SWEEP_BUSY');
	assert.equal(result('w8').code, 'SWEEP_BUSY');
	assert.equal(app.vfos[0].freq, 868);
});

// ---------------------------------------------------------------------------
// Tune attribution and status timing

test('every console write of the centre or the VFO is stamped with its command', async t => {
	const { frame, app, clock, flushWatchers, messages, result } = setup(t, { app: { mockSdrEnabled: true } });
	const latestTune = () => {
		flushWatchers();
		clock.advance(100);
		return messages('receiver:status').at(-1).tune;
	};
	const writes = [
		['console:tune', { id: 'p1', centerHz: 433_920_000 }],
		['console:tune', { id: 'p2', centerHz: 433_920_000, vfoHz: 433_930_000 }],
		['console:vfo', { id: 'p3', frequencyHz: 433_940_000 }],
		['console:vfo', { id: 'p4', frequencyHz: 868_000_000 }],
		['console:start', { id: 'p5', mock: true, listen: false, centerHz: 145_500_000, vfoHz: 145_510_000 }],
		['console:start', { id: 'p6', mock: true, listen: false, vfoHz: 145_520_000 }],
		['console:vfo', { id: 'p7', mode: 'am', frequencyHz: 145_530_000 }],
	];
	for (const [index, [type, payload]] of writes.entries()) {
		frame.send(type, payload);
		await settle(20);
		const rev = index + 1;
		assert.equal(result(payload.id).code, 'OK', payload.id);
		assert.equal(result(payload.id).tune.rev, rev, `${payload.id}: one rev per command`);
		assert.deepEqual(latestTune(), { rev, by: 'console', id: payload.id, receiverRev: 0 }, payload.id);
	}
	assert.equal(app.radio.centerFreq, 145.5);
	assert.equal(app.vfos[0].freq, 145.53);
	assert.equal(app.running, true);
});

test('a Receiver-page change is stamped receiver; unchanged tuning keeps its rev', async t => {
	const { frame, app, clock, flushWatchers, messages, result } = setup(t);
	const latest = () => {
		flushWatchers();
		clock.advance(100);
		return messages('receiver:status').at(-1);
	};
	assert.deepEqual(messages('receiver:status')[0].tune, { rev: 0, by: 'receiver', id: null, receiverRev: 0 }, 'the tuning at install is the baseline');
	frame.send('console:tune', { id: 't1', centerHz: 433_920_000, vfoHz: 433_925_000 });
	assert.deepEqual(result('t1').tune, { rev: 1, by: 'console', id: 't1', receiverRev: 0, centerHz: 433_920_000, vfoHz: 433_925_000 });
	assert.deepEqual(latest().tune, { rev: 1, by: 'console', id: 't1', receiverRev: 0 });

	app.radio.centerFreq = 150;
	const typed = latest();
	assert.equal(typed.centerHz, 150_000_000);
	assert.deepEqual(typed.tune, { rev: 2, by: 'receiver', id: null, receiverRev: 2 });
	app.vfos[0].freq = 150.01;
	assert.deepEqual(latest().tune, { rev: 3, by: 'receiver', id: null, receiverRev: 3 });
	app.vfos.push(makeDefaultVfo(151));
	app.activeVfoIndex = 1;
	const switched = latest();
	assert.deepEqual(switched.tune, { rev: 4, by: 'receiver', id: null, receiverRev: 4 }, 'another active VFO is a retune');
	assert.equal(switched.vfo.frequencyHz, 151_000_000);

	frame.send('console:vfo', { id: 'm1', mode: 'usb' });
	assert.equal(result('m1').tune.rev, 4, 'a mode change is not a retune');
	frame.send('console:tune', { id: 'same', centerHz: 150_000_000 });
	assert.deepEqual(result('same').tune, { rev: 4, by: 'receiver', id: null, receiverRev: 4, centerHz: 150_000_000, vfoHz: 151_000_000 }, 'the same values change nothing');
	frame.send('console:tune', { id: 'far', centerHz: 7_000_000_000 });
	assert.equal(result('far').code, 'OUT_OF_RANGE');
	assert.equal(result('far').tune.rev, 4);
	assert.deepEqual(latest().tune, { rev: 4, by: 'receiver', id: null, receiverRev: 4 });
});

test('a Receiver edit the watcher has not reported yet keeps its stamp when a console tune follows', async t => {
	const { frame, app, result } = setup(t);
	app.radio.centerFreq = 150; // typed on the Receiver page; Vue has not run the watcher yet
	frame.send('console:tune', { id: 'c1', centerHz: 433_920_000 });
	assert.deepEqual(result('c1').tune, { rev: 2, by: 'console', id: 'c1', receiverRev: 1, centerHz: 433_920_000, vfoHz: 100_000_000 });
});

test('a start stamps its tuning even when the radio does not connect', async t => {
	const { frame, app, result } = setup(t);
	frame.send('console:start', { id: 'f1', mock: true, listen: false, mode: 'am', centerHz: 145_500_000 });
	await settle(20);
	assert.equal(result('f1').code, 'MOCK_UNAVAILABLE');
	assert.deepEqual(result('f1').tune, { rev: 1, by: 'console', id: 'f1', receiverRev: 0, centerHz: 145_500_000, vfoHz: 100_000_000 });
	assert.equal(app.radio.centerFreq, 145.5, 'the next start uses it');
});

test('running, connected, busy, error and recording changes are sent at once, at most every 20 ms', async t => {
	const { app, clock, flushWatchers, messages } = setup(t);
	await settle();
	clock.advance(200);
	const count = () => messages('receiver:status').length;
	const before = count();
	app.running = true;
	flushWatchers();
	assert.equal(count(), before + 1, 'not held for the 100 ms window');
	assert.equal(messages('receiver:status').at(-1).running, true);
	app.sweep.active = true;
	flushWatchers();
	assert.equal(count(), before + 1, 'at most one urgent status per 20 ms');
	clock.advance(STATUS_URGENT_MIN_MS);
	assert.equal(count(), before + 2);
	assert.equal(messages('receiver:status').at(-1).busy, 'sweep');

	// A typed frequency still waits for the window, unless an urgent change comes with it.
	clock.advance(50);
	app.radio.centerFreq = 101;
	flushWatchers();
	assert.equal(count(), before + 2);
	clock.advance(STATUS_DEBOUNCE_MS);
	assert.equal(count(), before + 3);
	clock.advance(30);
	app.radio.centerFreq = 102;
	flushWatchers();
	app.audioRecording.armed = true;
	flushWatchers();
	assert.equal(count(), before + 4);
	const last = messages('receiver:status').at(-1);
	assert.equal(last.centerHz, 102_000_000);
	assert.equal(last.recording, true);
	clock.advance(500);
	assert.equal(count(), before + 4, 'the pending window was covered by the urgent status');
	for (const key of ['connected', 'error']) {
		const sent = count();
		if (key === 'connected') app.connected = true;
		else {
			app.running = false;
			app.sweep.error = 'The radio stopped sending samples (stall). RX stopped.';
		}
		flushWatchers();
		assert.equal(count(), sent + 1, key);
		clock.advance(STATUS_URGENT_MIN_MS);
	}
	assert.deepEqual(messages('receiver:status').at(-1).error, { code: 'RX_ERROR' });
});

test('a malformed command gets INVALID_COMMAND; hello and subscribe never fail', async t => {
	const { frame, result } = setup(t);
	frame.send('console:tune', { id: 'bad-1', centerHz: 'loud' });
	assert.deepEqual(result('bad-1'), { ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:result', id: 'bad-1', ok: false, code: 'INVALID_COMMAND' });
	frame.send('console:subscribe', { id: 'sub-4', spectrum: true, bins: 1e9 });
	assert.equal(result('sub-4').code, 'OK');
});

test('display sets the Dengar dB scale, also during a scan, and the status reports it', async t => {
	const { frame, app, clock, flushWatchers, messages, result } = setup(t);
	frame.send('console:display', { id: 'd1', auto: false, minDb: -90, maxDb: -20 });
	assert.deepEqual(result('d1'), { ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:result', id: 'd1', ok: true, code: 'OK' });
	assert.deepEqual(app.display, { minDB: -90, maxDB: -20, auto: false });
	flushWatchers();
	clock.advance(STATUS_DEBOUNCE_MS);
	assert.deepEqual(messages('receiver:status').at(-1).display, { auto: false, minDb: -90, maxDb: -20 });

	// Auto without limits keeps the manual range for the next Manual.
	frame.send('console:display', { id: 'd2', auto: true });
	assert.equal(result('d2').code, 'OK');
	assert.deepEqual(app.display, { minDB: -90, maxDB: -20, auto: true });

	for (const busy of ['active', 'listening']) {
		app.sweep[busy] = true;
		frame.send('console:display', { id: `d-${busy}`, auto: false, minDb: -100, maxDb: -40 });
		assert.equal(result(`d-${busy}`).code, 'OK', `a display change is not a radio command (${busy})`);
		app.sweep[busy] = false;
	}
	assert.deepEqual(app.display, { minDB: -100, maxDB: -40, auto: false });

	frame.send('console:display', { id: 'd3', auto: false, minDb: -90 });
	assert.equal(result('d3').code, 'INVALID_COMMAND');
	assert.deepEqual(app.display, { minDB: -100, maxDB: -40, auto: false });
});

test('status reports a damaged or missing display range as the Listener default', async t => {
	const { app, clock, flushWatchers, messages } = setup(t);
	app.display = { minDB: 'loud', maxDB: 0 };
	flushWatchers();
	clock.advance(STATUS_DEBOUNCE_MS);
	assert.deepEqual(messages('receiver:status').at(-1).display, { auto: true, minDb: -70, maxDb: 0 });
	app.display = null;
	flushWatchers();
	clock.advance(STATUS_DEBOUNCE_MS);
	assert.deepEqual(messages('receiver:status').at(-1).display, { auto: true, minDb: -70, maxDb: 0 });
});

test('initialVfoEnabled keeps the Receiver page default outside a console start', async t => {
	const { frame, app, bridge, result } = setup(t, { app: { mockSdrEnabled: true } });
	assert.equal(bridge.initialVfoEnabled(), true);
	frame.send('console:start', { id: 'i1', mock: true, listen: true });
	assert.equal(bridge.initialVfoEnabled(), true, 'a listening start unmutes');
	await settle(20);
	assert.equal(result('i1').code, 'OK');
	assert.equal(app.vfos[0].enabled, true);
	frame.send('console:stop', { id: 'i2' });
	await settle(20);
	frame.send('console:start', { id: 'i3', mock: true, listen: false });
	assert.equal(bridge.initialVfoEnabled(), false);
	await settle(20);
	assert.equal(app.vfos[0].enabled, false);
	assert.equal(bridge.initialVfoEnabled(), true);
});

test('dispose removes every listener and timer', async t => {
	const { frame, clock, bridge, messages } = setup(t);
	frame.send('console:subscribe', { id: 'sub-5', spectrum: true });
	await settle();
	clock.advance(100);
	assert.ok(clock.pending() > 0);
	bridge.dispose();
	assert.equal(clock.pending(), 0);
	assert.equal(frame.listeners.size, 0);
	assert.equal(frame.usbListeners.size, 0);
	const count = frame.posted.length;
	frame.send('console:hello');
	frame.send('console:tune', { id: 'late', centerHz: 145_000_000 });
	bridge.spectrum(new Float32Array(1024));
	clock.advance(5000);
	assert.equal(frame.posted.length, count);
	assert.equal(messages('receiver:result').some(message => message.id === 'late'), false);
});

// ---------------------------------------------------------------------------
// Gains and sample rate (console:gains, console:radio)

/** Neither command may open a dialog in the hidden frame; a confirm() there would be invisible. */
function forbidDialogs(t) {
	const saved = { confirm: globalThis.confirm, alert: globalThis.alert, prompt: globalThis.prompt };
	for (const name of Object.keys(saved)) {
		globalThis[name] = () => { throw new Error(`${name}() in the hidden Receiver frame`); };
	}
	t.after(() => Object.assign(globalThis, saved));
}

/** A running Mock RX started by the console, with the FFT frames the Listener would draw. */
async function runningMock(t, options = {}) {
	const context = setup(t, { app: { mockSdrEnabled: true, ...options } });
	forbidDialogs(t);
	context.frame.send('console:start', { id: 'rx', mock: true, listen: false, centerHz: 100_000_000, vfoHz: 100_000_000 });
	await settle(20);
	assert.equal(context.result('rx').code, 'OK');
	const frameData = new Float32Array(1024).fill(-80);
	const drawFrame = () => context.bridge.spectrum(frameData);
	return { ...context, drawFrame };
}

test('gains set the Listener gains its watcher applies, before and after the radio connects', async t => {
	const { frame, app, clock, flushWatchers, messages, result, log } = setup(t, { app: { mockSdrEnabled: true } });
	forbidDialogs(t);
	frame.send('console:gains', { id: 'g1', lnaDb: 24, vgaDb: 30, amp: true });
	assert.deepEqual(result('g1'), { ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:result', id: 'g1', ok: true, code: 'OK' });
	assert.deepEqual(app.gains, { LNA: 24, VGA: 30, 'Amp (14dB)': 1 }, 'the RadioSpectrum names before a device is connected');
	flushWatchers();
	clock.advance(STATUS_DEBOUNCE_MS);
	assert.deepEqual(messages('receiver:status').at(-1).gains, { lnaDb: 24, vgaDb: 30, amp: true });
	assert.deepEqual(messages('receiver:status').at(-1).sampleRatesHz, [], 'no device list before a device connects');

	frame.send('console:start', { id: 'g2', mock: true, listen: false });
	await settle(20);
	assert.equal(result('g2').code, 'OK');
	assert.deepEqual(app.gains, { LNA: 24, VGA: 30, 'Amp (14dB)': 1 }, 'valid values survive the connect');
	frame.send('console:gains', { id: 'g3', amp: false });
	assert.equal(result('g3').code, 'OK');
	assert.equal(app.gains['Amp (14dB)'], 0);
	assert.deepEqual(log.filter(entry => entry[0] === 'setGains'), [], 'the bridge leaves the backend to the Receiver\'s gains watcher');

	for (const [id, payload] of [['g4', { lnaDb: 20 }], ['g5', { vgaDb: 63 }], ['g6', { lnaDb: 48 }], ['g7', { lnaDb: 32, vgaDb: 7 }]]) {
		frame.send('console:gains', { id, ...payload });
		assert.equal(result(id).code, 'OUT_OF_RANGE', JSON.stringify(payload));
	}
	assert.deepEqual(app.gains, { LNA: 24, VGA: 30, 'Amp (14dB)': 0 }, 'a refused command writes nothing, also its valid part');
	frame.send('console:gains', { id: 'g8', lnaDb: '24' });
	assert.equal(result('g8').code, 'INVALID_COMMAND');
});

test('gains use the connected device\'s own controls', async t => {
	const { frame, app, result } = setup(t, { app: { mockSdrEnabled: true, ampName: 'Amp' } });
	frame.send('console:start', { id: 'm1', mock: true, listen: false });
	await settle(20);
	frame.send('console:gains', { id: 'm2', amp: true, vgaDb: 62 });
	assert.equal(result('m2').code, 'OK');
	assert.equal(app.gains.Amp, 1, 'the Mock SDR names its amp Amp');
	assert.equal(app.gains.VGA, 62);
	assert.equal('Amp (14dB)' in app.gains, false);
	app.deviceCapabilities = { ...app.deviceCapabilities, gainControls: app.deviceCapabilities.gainControls.filter(control => control.name !== 'Amp') };
	frame.send('console:gains', { id: 'm3', amp: false });
	assert.equal(result('m3').code, 'OUT_OF_RANGE', 'a device without an amp');
});

test('a gain changed on the Receiver page reaches the console within the status window', async t => {
	const { app, clock, flushWatchers, messages } = setup(t);
	await settle();
	clock.advance(STATUS_DEBOUNCE_MS);
	const before = messages('receiver:status').length;
	app.gains = { LNA: 16, VGA: 40, 'Amp (14dB)': 1 };
	flushWatchers();
	clock.advance(STATUS_DEBOUNCE_MS);
	assert.equal(messages('receiver:status').length, before + 1);
	assert.deepEqual(messages('receiver:status').at(-1).gains, { lnaDb: 16, vgaDb: 40, amp: true });
});

test('gains follow the SWEEP_BUSY rule and refuse a remote session', async t => {
	const { frame, app, log, result } = setup(t);
	app.sweep.active = true; // the scan stopped RX before it started
	frame.send('console:gains', { id: 'b1', lnaDb: 8 });
	assert.equal(result('b1').code, 'OK', 'a wide scan keeps them for the next RX start');
	assert.equal(app.gains.LNA, 8);
	assert.deepEqual(log.filter(entry => entry[0] === 'setGains'), [], 'no backend call during the scan');
	app.running = true;
	frame.send('console:gains', { id: 'b2', lnaDb: 16 });
	assert.equal(result('b2').code, 'SWEEP_BUSY', 'a scan start that has not stopped RX yet');
	app.running = false;
	app.sweep.active = false;
	app.sweep.listening = true;
	frame.send('console:gains', { id: 'b3', lnaDb: 16 });
	assert.equal(result('b3').code, 'SWEEP_BUSY', 'a scan listen');
	app.sweep.listening = false;
	app.remoteMode = 'client';
	frame.send('console:gains', { id: 'b4', lnaDb: 16 });
	assert.equal(result('b4').code, 'NOT_READY');
	assert.equal(app.gains.LNA, 8);
});

test('radio sets the sample rate of a stopped Listener at once', async t => {
	const { frame, app, clock, flushWatchers, messages, result, log } = setup(t);
	forbidDialogs(t);
	frame.send('console:radio', { id: 'r1', sampleRateHz: 8_000_000 });
	await settle();
	assert.equal(result('r1').code, 'OK');
	assert.equal(app.radio.sampleRate, 8_000_000);
	assert.equal(log.filter(entry => entry === 'stopRx').length, 0, 'nothing to restart');
	assert.deepEqual(result('r1').tune, { rev: 0, by: 'receiver', id: null, receiverRev: 0, centerHz: 100_000_000, vfoHz: 100_000_000 });
	flushWatchers();
	clock.advance(STATUS_DEBOUNCE_MS);
	assert.equal(messages('receiver:status').at(-1).sampleRateHz, 8_000_000);
	frame.send('console:radio', { id: 'r2', sampleRateHz: 8_000_000 });
	await settle();
	assert.equal(result('r2').code, 'OK', 'the same rate changes nothing');
});

test('radio restarts a running RX and answers after the restart has drawn a frame', async t => {
	const { frame, app, clock, log, result, drawFrame } = await runningMock(t);
	assert.equal(app.vfos[0].enabled, false);
	frame.send('console:radio', { id: 'r3', sampleRateHz: 10_000_000 });
	await settle(20);
	assert.deepEqual(log.filter(entry => entry === 'stopRx' || entry[0] === 'startRx').slice(-2), ['stopRx', ['startRx', 100, 10_000_000]], 'the Receiver\'s watcher restarted RX');
	assert.equal(app.running, true);
	clock.advance(RADIO_POLL_MS * 4);
	await settle();
	assert.equal(result('r3'), undefined, 'waits for the first frame of the new stream');
	drawFrame();
	clock.advance(RADIO_POLL_MS);
	await settle();
	assert.equal(result('r3').code, 'OK');
	assert.equal(app.radio.sampleRate, 10_000_000);
	assert.equal(app.vfoConflictDialog.show, false);
	assert.equal(app.devicePicker.show, false);
});

test('radio does not count frames drawn during the restart', async t => {
	const { frame, app, clock, result, drawFrame } = await runningMock(t);
	let release;
	const stopping = new Promise(resolve => { release = resolve; });
	const stopRx = app.backend.stopRx;
	app.backend.stopRx = async () => { await stopping; return stopRx(); };
	frame.send('console:radio', { id: 'r4', sampleRateHz: 16_000_000 });
	await settle(20);
	assert.equal(app._rxRestarting, true);
	drawFrame(); // the old stream, still running while RX stops
	clock.advance(RADIO_POLL_MS);
	await settle();
	release();
	await settle(20);
	clock.advance(RADIO_POLL_MS);
	await settle();
	assert.equal(result('r4'), undefined, 'a frame from before the restart does not count');
	drawFrame();
	clock.advance(RADIO_POLL_MS);
	await settle();
	assert.equal(result('r4').code, 'OK');
});

test('radio re-centres an active VFO the new rate leaves out of band, stamped as the console\'s', async t => {
	const { frame, app, clock, flushWatchers, messages, result, drawFrame } = await runningMock(t);
	frame.send('console:vfo', { id: 'r5', mode: 'raw', frequencyHz: 108_000_000 }); // 8 MHz off the centre: inside 20 MSPS
	assert.equal(result('r5').code, 'OK');
	assert.equal(app.radio.centerFreq, 100);
	frame.send('console:radio', { id: 'r6', sampleRateHz: 10_000_000 });
	await settle(20);
	drawFrame();
	clock.advance(RADIO_POLL_MS);
	await settle();
	assert.equal(result('r6').code, 'OK');
	assert.equal(app.radio.centerFreq, 108, 're-centred on the VFO');
	assert.equal(app.vfos[0].bandwidth, 10_000_000, 'a raw VFO takes the new rate as bandwidth');
	assert.deepEqual(result('r6').tune, { rev: 2, by: 'console', id: 'r6', receiverRev: 0, centerHz: 108_000_000, vfoHz: 108_000_000 });
	flushWatchers();
	clock.advance(STATUS_DEBOUNCE_MS);
	assert.deepEqual(messages('receiver:status').at(-1).tune, { rev: 2, by: 'console', id: 'r6', receiverRev: 0 }, 'follow-node stays on in the console');

	frame.send('console:radio', { id: 'r7', sampleRateHz: 20_000_000 });
	await settle(20);
	drawFrame();
	clock.advance(RADIO_POLL_MS);
	await settle();
	assert.equal(result('r7').code, 'OK');
	assert.equal(result('r7').tune.rev, 2, 'a VFO still in band keeps the centre');
});

test('radio refuses a rate the device does not offer, any scan and a remote session', async t => {
	const { frame, app, result } = setup(t, { app: { mockSdrEnabled: true, sampleRates: [2_000_000, 10_000_000] } });
	forbidDialogs(t);
	const refused = async (id, payload, code, message) => {
		frame.send('console:radio', { id, ...payload });
		await settle(20);
		assert.equal(result(id).code, code, message);
	};
	await refused('n1', { sampleRateHz: 3_000_000 }, 'OUT_OF_RANGE', 'not a RadioSpectrum rate');
	frame.send('console:start', { id: 'n2', mock: true, listen: false });
	await settle(20);
	await refused('n3', { sampleRateHz: 20_000_000 }, 'OUT_OF_RANGE', 'not in the connected device\'s list');
	for (const busy of ['active', 'starting', 'stopping', 'listening', 'listenStarting']) {
		app.sweep[busy] = true;
		await refused(`n-${busy}`, { sampleRateHz: 2_000_000 }, 'SWEEP_BUSY', busy);
		app.sweep[busy] = false;
	}
	app.remoteMode = 'host';
	await refused('n4', { sampleRateHz: 2_000_000 }, 'NOT_READY', 'a remote session');
	assert.equal(app.radio.sampleRate, 20_000_000, 'every refusal left the rate alone');
});

test('radio needs the console\'s confirmation while a recording is armed, and the recording continues', async t => {
	const { frame, app, clock, log, result, drawFrame } = await runningMock(t);
	app.audioRecording.armed = true;
	frame.send('console:radio', { id: 'c1', sampleRateHz: 4_000_000 });
	await settle(20);
	assert.equal(result('c1').code, 'RECORDING_ACTIVE');
	assert.equal(app.radio.sampleRate, 20_000_000, 'nothing changed');
	assert.equal(log.includes('resumeRecording'), false);
	frame.send('console:radio', { id: 'c2', sampleRateHz: 4_000_000, confirmRecording: true });
	await settle(20);
	drawFrame();
	clock.advance(RADIO_POLL_MS);
	await settle();
	assert.equal(result('c2').code, 'OK');
	assert.equal(app.radio.sampleRate, 4_000_000);
	assert.ok(log.includes('resumeRecording'), 'the Receiver resumes the recording in a new segment');
});

test('radio reports AUDIO_BLOCKED when audio that played before the restart cannot resume', async t => {
	const { frame, app, clock, result, drawFrame, audioPolicy } = await runningMock(t);
	frame.send('console:listen', { id: 'a1', enabled: true });
	await settle(20);
	assert.equal(result('a1').code, 'OK');
	assert.equal(app.audioCtx.state, 'running');
	audioPolicy.allowed = false; // the click's activation is gone by the time RX is back
	frame.send('console:radio', { id: 'a2', sampleRateHz: 8_000_000 });
	await settle(20);
	drawFrame();
	clock.advance(RADIO_POLL_MS);
	await settle();
	assert.equal(result('a2'), undefined, 'tries to resume the new AudioContext first');
	clock.advance(AUDIO_RESUME_WAIT_MS);
	await settle();
	assert.equal(result('a2').code, 'AUDIO_BLOCKED');
	assert.equal(app.running, true);
	assert.equal(app.vfos[0].enabled, true, 'still listening; a Dengar click resumes the audio');

	audioPolicy.allowed = true;
	frame.send('console:listen', { id: 'a3-listen', enabled: true });
	await settle(20);
	assert.equal(result('a3-listen').code, 'OK', 'the next Dengar click resumes it');
	frame.send('console:radio', { id: 'a3', sampleRateHz: 16_000_000 });
	await settle(20);
	drawFrame();
	clock.advance(RADIO_POLL_MS);
	await settle();
	assert.equal(result('a3').code, 'OK');
	assert.equal(app.audioCtx.state, 'running');
});

test('radio checks the audio of a listening VFO only once the restarted stream has created its AudioContext', async t => {
	const { frame, app, clock, result, drawFrame } = await runningMock(t);
	frame.send('console:listen', { id: 'w1', enabled: true });
	await settle(20);
	assert.equal(result('w1').code, 'OK');
	// startStream sets running, then waits for the stream before it sets up the VFOs and the audio.
	let release;
	const held = new Promise(resolve => { release = resolve; });
	const startRxStream = app.backend.startRxStream;
	app.backend.startRxStream = async (...args) => { await held; return startRxStream(...args); };
	frame.send('console:radio', { id: 'w2', sampleRateHz: 8_000_000 });
	await settle(20);
	assert.equal(app.running, true);
	assert.equal(app._rxRestarting, false);
	assert.equal(app.audioCtx, null, 'the stop closed it and the start has not created the new one');
	drawFrame(); // the new stream draws before startRxStream has resolved
	clock.advance(RADIO_POLL_MS * 2);
	await settle();
	assert.equal(result('w2'), undefined, 'no AUDIO_BLOCKED for a context that does not exist yet');
	release();
	await settle(20);
	clock.advance(RADIO_POLL_MS);
	await settle();
	assert.equal(result('w2').code, 'OK');
	assert.equal(app.audioCtx.state, 'running');
	assert.equal(app.vfos[0].enabled, true);
});

test('radio reports a restart that does not bring RX back, and a slow first frame', async t => {
	await t.test('the stream fails to start', async st => {
		const { frame, app, clock, failures, result } = await runningMock(st);
		failures.startRx = true;
		frame.send('console:radio', { id: 'f1', sampleRateHz: 2_000_000 });
		await settle(30);
		clock.advance(RADIO_POLL_MS);
		await settle();
		assert.deepEqual({ code: result('f1').code, message: result('f1').message }, { code: 'CONNECT_FAILED', message: 'Error starting stream.' });
		assert.equal(app.running, false);
	});
	await t.test('no frame within the wait', async st => {
		const { frame, app, clock, result } = await runningMock(st);
		frame.send('console:radio', { id: 'f2', sampleRateHz: 2_000_000 });
		await settle(20);
		for (let waited = 0; waited < RADIO_RESTART_WAIT_MS && !result('f2'); waited += RADIO_POLL_MS) {
			clock.advance(RADIO_POLL_MS);
			await settle(2);
		}
		assert.equal(result('f2').code, 'OK', 'RX runs at the new rate');
		assert.equal(app.running, true);
	});
});

test('radio waits behind a start and blocks the next stop until it answers', async t => {
	const { frame, app, clock, messages, result, bridge } = setup(t, { app: { mockSdrEnabled: true } });
	frame.send('console:start', { id: 'o1', mock: true, listen: false, centerHz: 145_000_000, vfoHz: 145_000_000 });
	frame.send('console:radio', { id: 'o2', sampleRateHz: 5_000_000 });
	frame.send('console:stop', { id: 'o3' });
	await settle(30);
	assert.deepEqual(messages('receiver:result').map(message => message.id), ['o1']);
	bridge.spectrum(new Float32Array(1024));
	clock.advance(RADIO_POLL_MS);
	await settle(30);
	assert.deepEqual(messages('receiver:result').map(message => [message.id, message.code]), [['o1', 'OK'], ['o2', 'OK'], ['o3', 'OK']]);
	assert.equal(app.radio.sampleRate, 5_000_000);
	assert.equal(app.running, false);
	assert.deepEqual([result('o2').tune.by, result('o2').tune.id], ['console', 'o1'], 'the start\'s tuning; the VFO stayed in band');
});

// ---------------------------------------------------------------------------
// Wide scan (console:sweep-*, receiver:sweep, status.sweep)

test('scan constants are the Receiver scan limits', () => {
	assert.deepEqual([...SWEEP_FFT_SIZES], [4096, 8192]);
	assert.deepEqual([...SWEEP_VIEWS], ['current', 'average', 'max']);
	assert.deepEqual([...SWEEP_SOURCES], ['native', 'manual', 'simulated']);
	assert.deepEqual([...SWEEP_PHASES], ['idle', 'starting', 'active', 'stopping']);
	assert.deepEqual({ ...SWEEP_SPAN_LIMITS }, { minSpanHz: 1_000_000, sampleRateHz: SWEEP_SAMPLE_RATE_HZ, maxBins: SWEEP_MAX_BINS });
	assert.equal(sweepMaxSpanHz(8192), 1_220_703_125);
	assert.equal(sweepMaxSpanHz(4096), 2_441_406_250);
});

test('inSweepRange accepts exactly the ranges the Receiver can scan', () => {
	const config = (startHz, endHz, fftSize) => ({
		startHz, endHz, fftSize, minSnrDb: 8, averageAlpha: 0.35, lnaGain: 40, vgaGain: 20, ampEnabled: false, iqCorrection: true,
	});
	const scans = (startHz, endHz, fftSize) => {
		try {
			validateSweepConfig(config(startHz, endHz, fftSize));
			return true;
		} catch {
			return false;
		}
	};
	for (const [start, stop, fft] of [
		[100e6, 1000e6, 8192], [1e6, 2e6, 8192], [1e6, 1_220_000_000, 8192], [1e6, 1_230_000_000, 8192], [1e6, 1_230_000_000, 4096],
		[7_249_000_000, 7_250_000_000, 8192], [7_249_000_000, 7_251_000_000, 8192], [500_000, 2e6, 4096], [2e9, 4.5e9, 4096],
	]) {
		assert.equal(inSweepRange(start, stop, fft), scans(start, stop, fft), `${start}-${stop} @${fft}`);
	}
	assert.equal(inSweepRange(100e6, 100.5e6, 8192), false, 'narrower than 1 MHz');
	assert.equal(inSweepRange(200e6, 100e6, 8192), false);
	assert.equal(inSweepRange(100e6, 1000e6, 2048), false);
	assert.equal(inSweepRange(Number.NaN, 1000e6, 8192), false);
	// Displayed Hz: a -125 MHz upconverter shift moves the device range up by 125 MHz.
	assert.equal(inSweepRange(-24e6, 100e6, 8192, -125_000_000), true);
	assert.equal(inSweepRange(-125e6, 100e6, 8192, -125_000_000), false, 'device 0 Hz');
});

test('decimateMaxHold keeps the peak of each bin in a new array and floors non-finite bins', () => {
	const values = new Float32Array([-90, -10, -80, -70, Number.NaN, Number.NaN, -60, -50]);
	const out = decimateMaxHold(values, 4);
	assert.deepEqual([...out], [-10, -70, SPECTRUM_FLOOR_DB, -50]);
	assert.notEqual(out.buffer, values.buffer);
	assert.deepEqual([...decimateMaxHold(values, 64)], [...values].map(value => (Number.isFinite(value) ? value : SPECTRUM_FLOOR_DB)), 'never upsampled');
});

test('parseConsoleMessage reads the scan commands', () => {
	const envelope = (type, payload) => ({ ch: BRIDGE_CHANNEL, v: BRIDGE_VERSION, type, id: 'c3-s', ...payload });
	const invalid = { type: 'invalid', id: 'c3-s' };
	assert.deepEqual(parseConsoleMessage(envelope('console:sweep-start', {})), { type: 'console:sweep-start', id: 'c3-s', mock: false });
	assert.deepEqual(parseConsoleMessage(envelope('console:sweep-start', { mock: true, confirmRecording: true })),
		{ type: 'console:sweep-start', id: 'c3-s', mock: true, confirmRecording: true });
	assert.deepEqual(parseConsoleMessage(envelope('console:sweep-start', { mock: true, confirmRecording: false })), { type: 'console:sweep-start', id: 'c3-s', mock: true });
	assert.deepEqual(parseConsoleMessage(envelope('console:sweep-start', { mock: 1 })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:sweep-start', { confirmRecording: 'yes' })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:sweep-stop', {})), { type: 'console:sweep-stop', id: 'c3-s', resumeRx: false });
	assert.deepEqual(parseConsoleMessage(envelope('console:sweep-stop', { resumeRx: true })), { type: 'console:sweep-stop', id: 'c3-s', resumeRx: true });
	assert.deepEqual(parseConsoleMessage(envelope('console:sweep-stop', { resumeRx: 'no' })), invalid);
	assert.deepEqual(parseConsoleMessage(envelope('console:sweep-config', { startHz: 400e6 + 0.4, fftSize: 4096, lnaDb: 24, amp: true, extra: 1 })),
		{ type: 'console:sweep-config', id: 'c3-s', startHz: 400_000_000, fftSize: 4096, lnaDb: 24, amp: true });
	for (const payload of [{}, { startHz: '4e8' }, { stopHz: Infinity }, { fftSize: 2048 }, { lnaDb: null }, { vgaDb: Number.NaN }, { amp: 'on' }]) {
		assert.deepEqual(parseConsoleMessage(envelope('console:sweep-config', payload)), invalid, JSON.stringify(payload));
	}
	assert.deepEqual(parseConsoleMessage(envelope('console:sweep-display', { minDb: -100, maxDb: -20 })), { type: 'console:sweep-display', id: 'c3-s', minDb: -100, maxDb: -20 });
	assert.deepEqual(parseConsoleMessage(envelope('console:sweep-display', { minDb: -300, maxDb: 300 })), { type: 'console:sweep-display', id: 'c3-s', minDb: -160, maxDb: 60 });
	assert.deepEqual(parseConsoleMessage(envelope('console:sweep-display', { minDb: -100 })), invalid);
});

/** A wide-scan frame as the worker sends it: 2048 bins with a peak near each end. */
function scanFrame(startHz = 100e6, endHz = 1000e6, count = 2048) {
	const current = new Float32Array(count).fill(-110);
	const average = new Float32Array(count).fill(-100);
	const maxHold = new Float32Array(count).fill(-90);
	average[10] = -20;
	current[count - 5] = -30;
	maxHold[count / 2] = -10;
	return { startHz, endHz, resolutionHz: 20_000_000 / 8192, sweepCount: 3, current, average, maxHold };
}

test('scan frames flow only while subscribed and scanning, in displayed Hz, throttled, decimated and transferred', async t => {
	const { frame, app, bridge, clock, messages } = setup(t);
	const data = scanFrame();
	const feed = (count, everyMs) => {
		for (let i = 0; i < count; i++) {
			bridge.sweepFrame(data);
			clock.advance(everyMs);
		}
	};
	app.sweep.active = true;
	feed(5, 100);
	assert.deepEqual(messages('receiver:sweep'), [], 'no subscription yet');
	frame.send('console:subscribe', { id: 'sub-s', spectrum: true, fps: 4, bins: 512 });
	app.sweep.active = false;
	feed(5, 100);
	assert.deepEqual(messages('receiver:sweep'), [], 'no scan running');
	app.sweep.active = true;
	app.radio.frequencyShift = -125;
	feed(20, 50); // one second of frames
	const frames = messages('receiver:sweep');
	assert.equal(frames.length, 4);
	const first = frames[0];
	assert.equal(first.startHz, -25_000_000);
	assert.equal(first.stopHz, 875_000_000);
	assert.equal(first.binCount, 512);
	assert.equal(first.view, 'average');
	assert.equal(first.sweepCount, 3);
	assert.equal(first.resolutionHz, 20_000_000 / 8192);
	assert.ok(first.bins instanceof Float32Array && first.bins.length === 512);
	assert.equal(first.bins[2], -20, 'max-hold of four scan bins');
	assert.equal(Math.max(...first.bins), -20, 'the average trace');
	const posts = frame.posted.filter(entry => entry.message.type === 'receiver:sweep');
	for (const entry of posts) assert.equal(entry.transfer[0].byteLength, 0, 'the copy was transferred');
	assert.equal(data.average.length, 2048, 'the Receiver keeps its frame');

	app.sweep.view = 'max';
	clock.advance(1000);
	bridge.sweepFrame(data);
	assert.equal(messages('receiver:sweep').at(-1).view, 'max');
	assert.equal(Math.max(...messages('receiver:sweep').at(-1).bins), -10);
	app.sweep.view = 'current';
	clock.advance(1000);
	bridge.sweepFrame(data);
	assert.equal(Math.max(...messages('receiver:sweep').at(-1).bins), -30);

	// receiver:spectrum and receiver:sweep share one sequence.
	app.running = true;
	clock.advance(1000);
	bridge.spectrum(new Float32Array(1024).fill(-80));
	const sequence = frame.posted.map(entry => entry.message).filter(message => message.type === 'receiver:sweep' || message.type === 'receiver:spectrum').map(message => message.seq);
	assert.deepEqual(sequence, sequence.map((_value, index) => index + 1));
	app.running = false;

	app.sweep.view = 'average';
	for (const bad of [null, { ...data, average: new Float32Array(0) }, { ...data, endHz: data.startHz }, { ...data, startHz: Number.NaN }]) {
		const before = messages('receiver:sweep').length;
		clock.advance(1000);
		bridge.sweepFrame(bad);
		assert.equal(messages('receiver:sweep').length, before);
	}
	frame.send('console:subscribe', { id: 'sub-s2', spectrum: false });
	clock.advance(1000);
	bridge.sweepFrame(data);
	assert.equal(messages('receiver:sweep').length, 6, 'spectrum:false stops scan frames');
});

test('status reports the scan phase at once and its settings in displayed Hz', async t => {
	const { app, clock, flushWatchers, messages } = setup(t);
	const latest = () => {
		flushWatchers();
		clock.advance(100);
		return messages('receiver:status').at(-1).sweep;
	};
	assert.deepEqual(latest(), {
		phase: 'idle', source: 'simulated', startHz: 100_000_000, stopHz: 1_000_000_000, fftSize: 8192, resolutionHz: 20_000_000 / 8192,
		lnaDb: 40, vgaDb: 20, amp: false, displayMinDb: -60, displayMaxDb: 0, view: 'average',
	});
	app.sweep.starting = true;
	flushWatchers();
	clock.advance(STATUS_URGENT_MIN_MS);
	assert.equal(messages('receiver:status').at(-1).sweep.phase, 'starting', 'a phase change is urgent');
	app.sweep.active = true;
	app.sweep.starting = false;
	flushWatchers();
	clock.advance(STATUS_URGENT_MIN_MS);
	assert.equal(messages('receiver:status').at(-1).sweep.phase, 'active');
	app.sweep.active = false;
	app.sweep.stopping = true;
	assert.equal(latest().phase, 'stopping');
	app.sweep.stopping = false;
	Object.assign(app.sweep, { fftSize: 4096, lnaGain: 16, vgaGain: 30, ampEnabled: true, displayMinDb: -500, displayMaxDb: 7, view: 'bogus', source: 'native' });
	assert.deepEqual(latest(), {
		phase: 'idle', source: 'native', startHz: 100_000_000, stopHz: 1_000_000_000, fftSize: 4096, resolutionHz: 20_000_000 / 4096,
		lnaDb: 16, vgaDb: 30, amp: true, displayMinDb: -160, displayMaxDb: 7, view: 'average',
	});
	// A progress update alone sends nothing.
	const count = messages('receiver:status').length;
	app.sweep.progress = { sweepCount: 9 };
	flushWatchers();
	clock.advance(500);
	assert.equal(messages('receiver:status').length, count);
});

test('sweep-start with the Mock runs the simulated scan without connecting and shows it in the Spektrum workspace', async t => {
	const { frame, app, log, result } = setup(t, { app: { mockSdrEnabled: true } });
	forbidDialogs(t);
	app.activeWorkspace = 'listener';
	frame.send('console:sweep-start', { id: 'ss1', mock: true });
	await settle(20);
	assert.equal(result('ss1').code, 'OK');
	assert.equal(app.sweep.active, true);
	assert.equal(app.sweep.source, 'simulated');
	assert.equal(app.connected, false, 'the simulated scan needs no radio');
	assert.equal(app.activeWorkspace, 'spectrum');
	assert.ok(log.includes('initSweepCanvas'));
	assert.equal(app.sweep.returnToRx, false);
	frame.send('console:sweep-start', { id: 'ss2', mock: true });
	await settle(20);
	assert.equal(result('ss2').code, 'OK', 'a second start while scanning is a no-op');
	assert.equal(log.filter(entry => Array.isArray(entry) && entry[0] === 'startSweep').length, 1);
});

test('sweep-start refuses the Mock when the frame does not offer it, and a scan listen', async t => {
	const { frame, app, result } = setup(t);
	frame.send('console:sweep-start', { id: 'sm1', mock: true });
	await settle(20);
	assert.equal(result('sm1').code, 'MOCK_UNAVAILABLE');
	app.sweep.listening = true;
	frame.send('console:sweep-start', { id: 'sm2', mock: true });
	await settle(20);
	assert.equal(result('sm2').code, 'SWEEP_BUSY');
	assert.equal(app.sweep.active, false);
});

test('sweep-start connects the one paired RadioSpectrum, keeps VFO 1 muted and scans with its hardware sweep', async t => {
	const { frame, app, log, result } = setup(t);
	forbidDialogs(t);
	frame.send('console:sweep-start', { id: 'sh1', mock: false });
	await settle(30);
	assert.equal(result('sh1').code, 'OK');
	assert.ok(log.some(entry => Array.isArray(entry) && entry[0] === 'open' && entry[1] === 'usb'));
	assert.equal(app.connected, true);
	assert.equal(app.sweep.source, 'native');
	assert.equal(app.sweep.active, true);
	assert.equal(app.running, false, 'the scan paused the RX the connect started');
	assert.equal(app.vfos[0].enabled, false, 'that RX start was muted');
	assert.equal(app.sweep.returnToRx, false, 'RX did not run before the command');
	assert.equal(log.includes('pairNewDevice'), false);
});

test('sweep-start reports pairing and device choice instead of opening a picker', async t => {
	await t.test('none paired, no activation', async st => {
		const { frame, log, result } = setup(st, { frame: { usbDevices: [] } });
		frame.send('console:sweep-start', { id: 'sp1', mock: false });
		await settle(20);
		assert.equal(result('sp1').code, 'NEEDS_PAIRING');
		assert.equal(log.includes('pairNewDevice'), false);
	});
	await t.test('two paired', async st => {
		const { frame, result } = setup(st, { frame: { usbDevices: [new FakeUsbDevice('a'), new FakeUsbDevice('b')] } });
		frame.send('console:sweep-start', { id: 'sp2', mock: false });
		await settle(20);
		assert.equal(result('sp2').code, 'NEEDS_DEVICE_CHOICE');
	});
	await t.test('no WebUSB', async st => {
		const { frame, result } = setup(st, { frame: { webusb: false } });
		frame.send('console:sweep-start', { id: 'sp3', mock: false });
		await settle(20);
		assert.equal(result('sp3').code, 'NO_WEBUSB');
	});
});

test('sweep-start reports a radio that cannot scan and a scan that fails to start', async t => {
	await t.test('unsupported', async st => {
		const { frame, app, result } = setup(st, { app: { sweepSupport: false } });
		frame.send('console:sweep-start', { id: 'su1', mock: false });
		await settle(30);
		assert.equal(result('su1').code, 'SWEEP_UNSUPPORTED');
		assert.equal(app.sweep.active, false);
	});
	await t.test('failed', async st => {
		const { frame, app, failures, result } = setup(st, { app: { mockSdrEnabled: true } });
		failures.sweep = 'Sweep range must be increasing and within 1–7250 MHz';
		frame.send('console:sweep-start', { id: 'sf1', mock: true });
		await settle(20);
		assert.equal(result('sf1').code, 'SWEEP_FAILED');
		assert.equal(result('sf1').message, 'Sweep error: Sweep range must be increasing and within 1–7250 MHz');
		assert.equal(app.sweep.active, false);
		// The same failure again is still a failure, with the same text.
		failures.sweep = 'Sweep range must be increasing and within 1–7250 MHz';
		frame.send('console:sweep-start', { id: 'sf2', mock: true });
		await settle(20);
		assert.equal(result('sf2').code, 'SWEEP_FAILED');
		assert.equal(result('sf2').message, 'Sweep error: Sweep range must be increasing and within 1–7250 MHz');
	});
	await t.test('refused by the Receiver with only a notice', async st => {
		const { frame, app, result } = setup(st, { app: { mockSdrEnabled: true } });
		// startSweep's own guards (backend still initializing, remote mode) return before it marks the start.
		app.startSweep = async function () { this.showMsg('Receiver backend is still initializing. Wait a moment, then try again.'); };
		frame.send('console:sweep-start', { id: 'sr1', mock: true });
		await settle(20);
		assert.equal(result('sr1').code, 'SWEEP_FAILED');
		assert.equal(result('sr1').message, 'Receiver backend is still initializing. Wait a moment, then try again.');
		frame.send('console:sweep-start', { id: 'sr2', mock: true });
		await settle(20);
		assert.equal(result('sr2').code, 'SWEEP_FAILED');
		assert.equal(result('sr2').message, 'Receiver backend is still initializing. Wait a moment, then try again.');
	});
	await t.test('stopped on the way is no failure', async st => {
		const { frame, app, result } = setup(st, { app: { mockSdrEnabled: true } });
		// A Receiver-page stop while the scan starts: startSweep began, then ends without a scan or an error.
		app.startSweep = async function () {
			this.sweep.starting = true;
			this.sweep.error = '';
			await Promise.resolve();
			this.sweep.starting = false;
		};
		frame.send('console:sweep-start', { id: 'ss1', mock: true });
		await settle(20);
		assert.equal(result('ss1').code, 'OK');
	});
});

test('sweep-start over a running RX needs the console\'s confirmation for an armed recording and resumes that RX after a Receiver-page stop', async t => {
	const { frame, app, result } = await runningMock(t);
	app.audioRecording.armed = true;
	frame.send('console:sweep-start', { id: 'sr1', mock: true });
	await settle(20);
	assert.equal(result('sr1').code, 'RECORDING_ACTIVE');
	assert.equal(app.running, true, 'nothing stopped');
	frame.send('console:sweep-start', { id: 'sr2', mock: true, confirmRecording: true });
	await settle(30);
	assert.equal(result('sr2').code, 'OK');
	assert.equal(app.sweep.active, true);
	assert.equal(app.running, false);
	assert.equal(app.audioRecording.armed, false, 'the scan ended the recording');
	assert.equal(app.sweep.returnToRx, true);
	// The Receiver page's Stop scan resumes the RX the operator had running.
	await app.stopSweep();
	assert.equal(app.running, true);
});

test('sweep-stop ends the scan without resuming RX unless asked; a following start runs RX', async t => {
	const { frame, app, result, messages } = await runningMock(t);
	frame.send('console:sweep-start', { id: 'st1', mock: true });
	await settle(30);
	assert.equal(app.sweep.active, true);
	frame.send('console:sweep-stop', { id: 'st2', resumeRx: false });
	// Dengar in Spektrum mode: stop the scan, then start RX listening, in one click.
	frame.send('console:start', { id: 'st3', mock: true, listen: true, mode: 'am' });
	await settle(40);
	assert.equal(result('st2').code, 'OK');
	assert.equal(result('st3').code, 'OK');
	assert.equal(app.sweep.active, false);
	assert.equal(app.running, true);
	assert.equal(app.vfos[0].enabled, true);
	assert.equal(app.activeWorkspace, 'listener');
	const order = messages('receiver:result').map(message => message.id);
	assert.ok(order.indexOf('st2') < order.indexOf('st3'), 'the stop answers before the start runs');

	frame.send('console:sweep-stop', { id: 'st4', resumeRx: false });
	await settle(20);
	assert.equal(result('st4').code, 'OK', 'nothing to stop');

	frame.send('console:sweep-start', { id: 'st5', mock: true });
	await settle(30);
	frame.send('console:sweep-stop', { id: 'st6', resumeRx: true });
	await settle(30);
	assert.equal(result('st6').code, 'OK');
	assert.equal(app.running, true, 'resumeRx starts the RX that ran before the scan');

	app.sweep.listening = true;
	frame.send('console:sweep-stop', { id: 'st7', resumeRx: false });
	await settle(20);
	assert.equal(result('st7').code, 'SWEEP_BUSY');
	app.sweep.listening = false;
});

test('sweep-stop waits for a scan start or a stop already under way', async t => {
	const { frame, app, clock, result } = setup(t);
	app.sweep.starting = true;
	frame.send('console:sweep-stop', { id: 'sw1', resumeRx: false });
	await settle(20);
	assert.equal(result('sw1'), undefined, 'waits while the start is on its way');
	clock.advance(RADIO_POLL_MS);
	await settle(10);
	assert.equal(result('sw1'), undefined);
	app.sweep.starting = false;
	clock.advance(RADIO_POLL_MS);
	await settle(10);
	assert.equal(result('sw1').code, 'OK');

	app.sweep.stopping = true;
	frame.send('console:sweep-stop', { id: 'sw2', resumeRx: false });
	await settle(20);
	clock.advance(SWEEP_STOP_WAIT_MS);
	await settle(40);
	for (let i = 0; i < 10 && !result('sw2'); i++) {
		clock.advance(RADIO_POLL_MS);
		await settle(10);
	}
	assert.equal(result('sw2').code, 'SWEEP_FAILED', 'a stop that never ends');
	app.sweep.stopping = false;
});

test('sweep-config sets the scan settings while no scan runs, in displayed Hz, and checks every value first', async t => {
	const { frame, app, result } = setup(t);
	app.radio.frequencyShift = -125;
	frame.send('console:sweep-config', { id: 'sc1', startHz: 300_000_000, stopHz: 500_000_000, fftSize: 4096, lnaDb: 24, vgaDb: 30, amp: true });
	assert.equal(result('sc1').code, 'OK');
	assert.equal(app.sweep.startMHz, 425, 'device MHz: the shift removed');
	assert.equal(app.sweep.endMHz, 625);
	assert.deepEqual([app.sweep.fftSize, app.sweep.lnaGain, app.sweep.vgaGain, app.sweep.ampEnabled], [4096, 24, 30, true]);
	const before = JSON.stringify(app.sweep);
	for (const [id, payload] of [
		['sc2', { startHz: 7_200_000_000 - 125_000_000, stopHz: 7_260_000_000 - 125_000_000 }],
		['sc3', { stopHz: 300_500_000 }],
		['sc4', { startHz: -124_500_000 }],
		['sc5', { startHz: -100_000_000, stopHz: 2_600_000_000 }],
		['sc6', { lnaDb: 20, amp: false }],
		['sc7', { vgaDb: 63 }],
	]) {
		frame.send('console:sweep-config', { id, ...payload });
		assert.equal(result(id).code, 'OUT_OF_RANGE', JSON.stringify(payload));
	}
	assert.equal(JSON.stringify(app.sweep), before, 'a refused command writes nothing');
	// 2.44 kHz bins allow at most 1.22 GHz: the current 200 MHz range fits, a 2 GHz one does not.
	frame.send('console:sweep-config', { id: 'sc8', startHz: 100_000_000, stopHz: 2_100_000_000 });
	assert.equal(result('sc8').code, 'OK');
	frame.send('console:sweep-config', { id: 'sc9', fftSize: 8192 });
	assert.equal(result('sc9').code, 'OUT_OF_RANGE');
	assert.equal(app.sweep.fftSize, 4096);
	frame.send('console:sweep-config', { id: 'sc10', fftSize: 'x' });
	assert.equal(result('sc10').code, 'INVALID_COMMAND');
});

test('sweep-config is refused while a scan starts, runs or stops and while a sweep-start waits', async t => {
	const { frame, app, result } = setup(t, { app: { mockSdrEnabled: true } });
	for (const flag of ['starting', 'active', 'stopping', 'listening']) {
		app.sweep[flag] = true;
		frame.send('console:sweep-config', { id: `sb-${flag}`, lnaDb: 8 });
		assert.equal(result(`sb-${flag}`).code, 'SWEEP_BUSY', flag);
		app.sweep[flag] = false;
	}
	assert.equal(app.sweep.lnaGain, 40);
	// Held behind a start in the queue, the sweep-start has not run yet.
	frame.send('console:start', { id: 'sb1', mock: true, listen: false });
	frame.send('console:sweep-start', { id: 'sb2', mock: true });
	frame.send('console:sweep-config', { id: 'sb3', lnaDb: 8 });
	assert.equal(result('sb3').code, 'SWEEP_BUSY');
	await settle(40);
	assert.equal(result('sb2').code, 'OK');
	frame.send('console:sweep-stop', { id: 'sb4', resumeRx: false });
	await settle(30);
	frame.send('console:sweep-config', { id: 'sb5', lnaDb: 8 });
	assert.equal(result('sb5').code, 'OK');
	assert.equal(app.sweep.lnaGain, 8);
});

test('sweep-display sets the Graph min./max. in every state and redraws', async t => {
	const { frame, app, log, clock, flushWatchers, messages, result } = setup(t);
	app.sweep.active = true;
	frame.send('console:sweep-display', { id: 'sd1', minDb: -110, maxDb: -30 });
	assert.equal(result('sd1').code, 'OK');
	assert.deepEqual([app.sweep.displayMinDb, app.sweep.displayMaxDb], [-110, -30]);
	assert.ok(log.includes('drawSweepSpectrum'));
	flushWatchers();
	clock.advance(100);
	assert.deepEqual([messages('receiver:status').at(-1).sweep.displayMinDb, messages('receiver:status').at(-1).sweep.displayMaxDb], [-110, -30]);
	app.sweep.active = false;
	app.sweep.listening = true;
	frame.send('console:sweep-display', { id: 'sd2', minDb: -40, maxDb: -45 });
	assert.equal(result('sd2').code, 'OK');
	assert.deepEqual([app.sweep.displayMinDb, app.sweep.displayMaxDb], [-40, -35], 'kept 5 dB apart, the minimum first');
});

test('a tune in Spektrum mode during a dock scan only sets the next RX, stamped as the console\'s', async t => {
	const { frame, app, log, clock, flushWatchers, messages, result } = setup(t, { app: { mockSdrEnabled: true } });
	frame.send('console:sweep-start', { id: 'sk1', mock: true });
	await settle(20);
	assert.equal(app.sweep.active, true);
	frame.send('console:tune', { id: 'sk2', centerHz: 433_920_000, vfoHz: 433_920_000 });
	assert.equal(result('sk2').code, 'OK');
	assert.equal(app.radio.centerFreq, 433.92);
	assert.deepEqual(log.filter(entry => Array.isArray(entry) && (entry[0] === 'vfoParams' || entry[0] === 'setFrequency')), []);
	flushWatchers();
	clock.advance(100);
	assert.deepEqual(messages('receiver:status').at(-1).tune, { rev: 1, by: 'console', id: 'sk2', receiverRev: 0 });
	assert.equal(app.sweep.active, true, 'the scan keeps running');
});
