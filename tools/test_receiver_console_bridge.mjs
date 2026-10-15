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
const { installConsoleBridge, AUDIO_RESUME_WAIT_MS } = await import(new URL('console-bridge.ts', appDir).href);
const { connectionMethods } = await import(new URL('connection.ts', appDir).href);
const { vfoMethods } = await import(new URL('vfo.ts', appDir).href);
const { makeDefaultVfo, MODE_DEFAULTS } = await import(new URL('../vendor/BrowSDR/src/client/app/constants.ts', import.meta.url).href);

const {
	BRIDGE_CHANNEL, BRIDGE_VERSION, FRAME_MESSAGE_TYPES, CONSOLE_MESSAGE_TYPES, LISTEN_MODES, RESULT_CODES,
	STATUS_ERROR_CODES, SUBSCRIBE_LIMITS, SPECTRUM_FLOOR_DB, clampSubscription, cropSpectrum, createFrameThrottle,
	parseConsoleMessage,
} = protocol;

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

function receiverApp({ audioAllowed = true, openOk = true, mockSdrEnabled = false } = {}) {
	const log = [];
	const watchers = [];
	const audioPolicy = { allowed: audioAllowed };
	const backend = {
		async open(target) { log.push(['open', target === 'mock' ? 'mock' : 'usb']); return openOk; },
		async info() { return { name: log.some(entry => entry[0] === 'open' && entry[1] === 'mock') ? 'Mock SDR (Signal Gen)' : 'HackRF One' }; },
		async getDeviceCapabilities() {
			return {
				gainControls: [
					{ name: 'LNA', min: 0, max: 40, step: 8, default: 40 },
					{ name: 'VGA', min: 0, max: 62, step: 2, default: 20 },
					{ name: 'Amp (14dB)', min: 0, max: 1, step: 1, default: 0 },
				],
				sampleRates: [20_000_000],
				supportsNativeSweep: true,
			};
		},
		async startRxStream(options) { log.push(['startRx', options.centerFreq]); },
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
		gains: {},
		deviceCapabilities: null,
		info: { boardName: '' },
		vfos: [makeDefaultVfo(100)],
		activeVfoIndex: 0,
		vfoSquelchOpen: [],
		snackbar: { show: false, message: '' },
		sweep: { active: false, starting: false, stopping: false, listening: false, listenStarting: false, error: '', source: 'simulated', hasResults: false },
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
		async stopSweep() { log.push('stopSweep'); },
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
	return { app, log, watchers, flushWatchers, audioPolicy };
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
	assert.deepEqual([...FRAME_MESSAGE_TYPES], ['receiver:hello', 'receiver:status', 'receiver:spectrum', 'receiver:result']);
	assert.deepEqual([...CONSOLE_MESSAGE_TYPES], [
		'console:hello', 'console:subscribe', 'console:start', 'console:stop', 'console:tune', 'console:vfo', 'console:listen',
	]);
	assert.deepEqual([...LISTEN_MODES], ['nfm', 'wfm', 'am', 'usb', 'lsb', 'dsb', 'cw', 'raw']);
	assert.deepEqual([...LISTEN_MODES].sort(), Object.keys(MODE_DEFAULTS).sort(), 'every Receiver mode, nothing else');
	assert.deepEqual([...RESULT_CODES], [
		'OK', 'NOT_READY', 'INVALID_COMMAND', 'NO_WEBUSB', 'NEEDS_PAIRING', 'NEEDS_DEVICE_CHOICE', 'MOCK_UNAVAILABLE',
		'CONNECT_FAILED', 'SWEEP_BUSY', 'RX_NOT_RUNNING', 'OUT_OF_RANGE', 'AUDIO_BLOCKED', 'TIMEOUT',
	]);
	assert.deepEqual([...STATUS_ERROR_CODES], ['USB_LOST', 'RX_ERROR', 'NO_WEBUSB']);
	assert.deepEqual({ ...SUBSCRIBE_LIMITS }, {
		binsMin: 64, binsMax: 2048, binsDefault: 512, fpsMin: 1, fpsMax: 15, fpsDefault: 10, spanMinHz: 100000, spanDefaultHz: 2000000,
	});
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

	assert.deepEqual(parseConsoleMessage(envelope('console:tune', { centerHz: 433_920_000.4, vfoHz: 434_000_000 })),
		{ type: 'console:tune', id: 'c2-x', centerHz: 433_920_000, vfoHz: 434_000_000 });
	assert.deepEqual(parseConsoleMessage(envelope('console:start', { mock: true, listen: false, mode: 'am', centerHz: 1e8 })),
		{ type: 'console:start', id: 'c2-x', mock: true, listen: false, mode: 'am', centerHz: 100_000_000 });
	assert.deepEqual(parseConsoleMessage(envelope('console:start', {})), { type: 'console:start', id: 'c2-x', mock: false, listen: false });
	assert.deepEqual(parseConsoleMessage(envelope('console:vfo', { mode: 'usb', volume: 30 })), { type: 'console:vfo', id: 'c2-x', mode: 'usb', volume: 30 });
	assert.deepEqual(parseConsoleMessage(envelope('console:stop', { extra: 1 })), { type: 'console:stop', id: 'c2-x' });
	assert.deepEqual(parseConsoleMessage(envelope('console:subscribe', { spectrum: true, bins: 9999, fps: 0, spanHz: 10 })),
		{ type: 'console:subscribe', id: 'c2-x', spectrum: true, bins: 2048, fps: 1, spanHz: 100_000 });
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
	assert.deepEqual(messages('receiver:result'), [{ ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:result', id: 'c1-a', ok: true, code: 'OK' }]);
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
	assert.equal(status.tMs, clock.now());
	assert.deepEqual({ ...status, seq: 0, tMs: 0, ch: '', v: 0, type: '', notice: null }, {
		ch: '', v: 0, type: '', seq: 0, tMs: 0,
		webusb: true, mockAvailable: true, pairedCount: 1,
		connected: true, mock: true, deviceName: 'Mock SDR', running: true, busy: 'none', workspace: 'listener',
		centerHz: 433_920_000, sampleRateHz: 20_000_000, frequencyShiftHz: -125_000_000,
		gains: { lnaDb: 40, vgaDb: 20, amp: false },
		vfo: { index: 0, enabled: false, mode: 'nfm', frequencyHz: 433_925_000, bandwidthHz: 12_500, squelchEnabled: false, squelchDb: -100, volume: 50 },
		squelchOpen: true, audio: 'none', recording: true, error: null, notice: null,
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
	assert.deepEqual(log.find(entry => entry[0] === 'startRx'), ['startRx', 145.5]);
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
	app.sweep.active = true;
	frame.send('console:vfo', { id: 'v8', mode: 'nfm' });
	assert.equal(result('v8').code, 'SWEEP_BUSY');
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
	assert.deepEqual(result('s4'), { ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:result', id: 's4', ok: true, code: 'OK' });
	assert.deepEqual(log.filter(entry => Array.isArray(entry) && (entry[0] === 'open' || entry[0] === 'startRx')), [['open', 'mock'], ['startRx', 433.92]]);
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

test('a malformed command gets INVALID_COMMAND; hello and subscribe never fail', async t => {
	const { frame, result } = setup(t);
	frame.send('console:tune', { id: 'bad-1', centerHz: 'loud' });
	assert.deepEqual(result('bad-1'), { ch: BRIDGE_CHANNEL, v: 1, type: 'receiver:result', id: 'bad-1', ok: false, code: 'INVALID_COMMAND' });
	frame.send('console:subscribe', { id: 'sub-4', spectrum: true, bins: 1e9 });
	assert.equal(result('sub-4').code, 'OK');
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
