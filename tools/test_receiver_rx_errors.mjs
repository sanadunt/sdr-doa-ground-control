// Receiver RX transfer failures (AUD-56): the builder-patched HackRF loop reports
// failed bulk transfers, and the main thread stops RX and tells a lost radio apart
// from one that is still attached. Run with:
//   node --test tools/test_receiver_rx_errors.mjs
// Needs the vendor/BrowSDR submodule, python3 for the builder patch, and Node 22.13+.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { register, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

register('./receiver_overlay_hooks.mjs', import.meta.url);
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
	if (specifier === 'comlink') {
		return { url: 'data:text/javascript,export const proxy = value => value; export const transfer = value => value; export function wrap() { return {}; }', shortCircuit: true };
	}
	return nextResolve(specifier, context);
}`)}`);

const toolsDir = fileURLToPath(new URL('./', import.meta.url));
const vendorClient = fileURLToPath(new URL('../vendor/BrowSDR/src/client/', import.meta.url));

function patchedHackRfSource() {
	const work = mkdtempSync(join(tmpdir(), 'receiver-rx-errors-'));
	try {
		mkdirSync(join(work, 'src/client'), { recursive: true });
		copyFileSync(join(vendorClient, 'hackrf.ts'), join(work, 'src/client/hackrf.ts'));
		copyFileSync(join(vendorClient, 'sdr-device.ts'), join(work, 'src/client/sdr-device.ts'));
		execFileSync(process.env.PYTHON || 'python3', ['-c', [
			'import sys',
			'from pathlib import Path',
			`sys.path.insert(0, ${JSON.stringify(toolsDir)})`,
			'import build_browsdr_receiver as builder',
			'builder._patch_rx_transfer_errors(Path(sys.argv[1]))',
		].join('\n'), work], { stdio: 'inherit' });
		return {
			hackrf: readFileSync(join(work, 'src/client/hackrf.ts'), 'utf8'),
			sdrDevice: readFileSync(join(work, 'src/client/sdr-device.ts'), 'utf8'),
		};
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

const patched = patchedHackRfSource();
const { HackRF } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(patched.hackrf, { mode: 'transform' })).toString('base64')}`);
const { connectionMethods } = await import(new URL('./browsdr_receiver_overlay/src/client/app/connection.ts', import.meta.url).href);

const quietConsole = { error: console.error };
function silenceConsoleErrors() {
	console.error = () => {};
	return () => { console.error = quietConsole.error; };
}

class FakeUsbDevice {
	constructor() {
		this.vendorId = 0x1d50;
		this.productId = 0x6089;
		this.serialNumber = '0000000000000000a06063c8234e6c5f';
		this.pending = [];
		this.transfers = 0;
	}
	async controlTransferOut() { return { status: 'ok' }; }
	transferIn() {
		this.transfers++;
		return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
	}
	deliver(count = 1) {
		for (const transfer of this.pending.splice(0, count)) {
			transfer.resolve({ status: 'ok', data: new DataView(new ArrayBuffer(16)) });
		}
	}
	failAll(error) {
		for (const transfer of this.pending.splice(0)) transfer.reject(error);
	}
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('the patched HackRF RX loop reports failed transfers', async () => {
	assert.match(patched.sdrDevice, /startRx\(callback: \(data: ArrayBufferView\) => void, onError\?: \(error: unknown\) => void\)/);
	const restore = silenceConsoleErrors();
	try {
		const radio = new HackRF();
		const device = new FakeUsbDevice();
		radio.device = device;
		const errors = [];
		let chunks = 0;
		await radio.startRx(() => { chunks++; }, error => errors.push(error));
		await settle();
		device.deliver(8);
		await settle();
		assert.equal(chunks, 8);
		assert.deepEqual(errors, []);

		device.failAll(new Error('A transfer error has occurred.'));
		await settle();
		assert.equal(errors.length, 8, 'each of the 8 parallel transfers reports its failure');
		assert.equal(errors[0].message, 'A transfer error has occurred.');
	} finally {
		restore();
	}
});

test('the patched HackRF RX loop reports a transfer that ends with a bad status', async () => {
	const restore = silenceConsoleErrors();
	try {
		const radio = new HackRF();
		const device = new FakeUsbDevice();
		radio.device = device;
		const errors = [];
		await radio.startRx(() => {}, error => errors.push(error));
		await settle();
		device.pending.shift().resolve({ status: 'stall', data: undefined });
		await settle();
		assert.equal(errors.length, 1);
		assert.equal(errors[0].message, 'USB transfer status stall');
	} finally {
		restore();
	}
});

test('transfers cancelled by a requested stop are not reported', async () => {
	const restore = silenceConsoleErrors();
	try {
		const radio = new HackRF();
		const device = new FakeUsbDevice();
		radio.device = device;
		const errors = [];
		await radio.startRx(() => {}, error => errors.push(error));
		await settle();
		const stopping = radio.stopRx();
		device.failAll(new Error('The transfer was cancelled.'));
		await stopping;
		await settle();
		assert.deepEqual(errors, []);
	} finally {
		restore();
	}
});

function setUsbDevices(devices) {
	Object.defineProperty(globalThis.navigator, 'usb', {
		configurable: true,
		value: { getDevices: async () => devices },
	});
}

function receiverApp(device) {
	const log = [];
	const app = {
		...connectionMethods,
		connected: true,
		running: true,
		mockDevice: false,
		remoteMode: 'none',
		_usbDevice: device,
		_rxStreamId: 0,
		_rxRestarting: false,
		_statsTimer: null,
		_mediaAudioEl: null,
		audioCtx: null,
		dspStats: {},
		deviceCapabilities: { sampleRates: [] },
		info: { boardName: 'HackRF One' },
		audioRecording: { armed: true, starting: false, notice: '', error: '' },
		sweep: { active: false, starting: false, error: '' },
		backend: {
			async stopRx() { log.push('stopRx'); },
			async close() { log.push('close'); },
		},
		async disarmVfoAudioRecording() {
			log.push('disarm');
			this.audioRecording.armed = false;
		},
		async stopSweep() { log.push('stopSweep'); },
		showMsg(message) { log.push(['msg', message]); },
	};
	return { app, log };
}

test('a transfer error with the radio still attached stops RX and keeps the connection', async () => {
	const device = new FakeUsbDevice();
	setUsbDevices([device]);
	const { app, log } = receiverApp(device);
	app._rxStreamId = 3;
	await app.handleRxStreamError(3, 'USB transfer status babble');
	assert.equal(app.running, false);
	assert.equal(app.connected, true);
	assert.equal(app._usbDevice, device);
	assert.ok(log.includes('stopRx') && log.includes('disarm'));
	assert.ok(!log.includes('close'));
	assert.match(app.sweep.error, /^The radio stopped sending samples \(USB transfer status babble\)\. RX stopped; the recording was saved up to this point\./);
	assert.equal(app.audioRecording.notice, app.sweep.error);
	assert.deepEqual(log.at(-1), ['msg', app.sweep.error]);
});

test('a transfer error after an unplug closes the radio even without the USB disconnect event', async () => {
	const device = new FakeUsbDevice();
	setUsbDevices([]);
	const { app, log } = receiverApp(device);
	app._rxStreamId = 1;
	await app.handleRxStreamError(1, 'A transfer error has occurred.');
	assert.equal(app.running, false);
	assert.equal(app.connected, false);
	assert.equal(app._usbDevice, null);
	assert.ok(log.includes('close'));
	assert.match(app.sweep.error, /^Radio disconnected \(USB unplugged or lost\)\. RX and scanning stopped; the recording was saved up to this point\./);
	assert.equal(app.audioRecording.notice, app.sweep.error);
});

test('errors from an old or stopped stream are ignored', async () => {
	const device = new FakeUsbDevice();
	setUsbDevices([]);
	const { app, log } = receiverApp(device);
	app._rxStreamId = 5;
	assert.equal(app.handleRxStreamError(4, 'stale'), undefined);
	app.running = false;
	assert.equal(app.handleRxStreamError(5, 'after stop'), undefined);
	assert.deepEqual(log, []);
	assert.equal(app.connected, true);
});

test('the USB disconnect event during RX error handling does not double-stop or override the message', async () => {
	const device = new FakeUsbDevice();
	setUsbDevices([]);
	const { app, log } = receiverApp(device);
	app._rxStreamId = 2;
	const handling = app.handleRxStreamError(2, 'A transfer error has occurred.');
	assert.equal(app.handleRxStreamError(2, 'second transfer'), undefined, 'later transfers of the same stream are ignored');
	const disconnect = app.handleUsbDeviceLost(device);
	await Promise.all([handling, disconnect]);
	assert.equal(log.filter(entry => entry === 'stopRx').length, 1);
	assert.equal(log.filter(entry => entry === 'close').length, 1);
	assert.equal(log.filter(entry => Array.isArray(entry) && entry[0] === 'msg' && entry[1].startsWith('Radio disconnected')).length, 1);
	assert.equal(app.connected, false);
});

test('stopping RX invalidates the stream id so its cancelled transfers are not failures', async () => {
	const device = new FakeUsbDevice();
	setUsbDevices([device]);
	const { app, log } = receiverApp(device);
	app._rxStreamId = 7;
	await app.togglePlay();
	assert.equal(app.running, false);
	assert.equal(app._rxStreamId, 8);
	app.running = true;
	assert.equal(app.handleRxStreamError(7, 'cancelled'), undefined);
	assert.ok(!log.some(entry => Array.isArray(entry) && entry[1].startsWith('The radio stopped')));
});
