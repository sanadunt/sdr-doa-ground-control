// Receiver scan stop paths: Stop does not wait for a trace upload backlog when the
// console is unreachable, an unplugged radio always ends the scan, and keyboard tab
// navigation asks before opening Spectrum ends a VFO recording. Run with:
//   node --test tools/test_receiver_sweep_stop.mjs
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

globalThis.window ??= globalThis;
const { sweepMethods } = await import(new URL('./browsdr_receiver_overlay/src/client/app/sweep.ts', import.meta.url).href);
const { connectionMethods } = await import(new URL('./browsdr_receiver_overlay/src/client/app/connection.ts', import.meta.url).href);
const { audioRecordingMethods } = await import(new URL('./browsdr_receiver_overlay/src/client/app/audio-recording.ts', import.meta.url).href);

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Routes /api/receiver requests; `trace` decides each trace upload. */
function installFetch({ trace }) {
	const previous = globalThis.fetch;
	const calls = { traces: [], finish: [] };
	globalThis.fetch = async (url, init = {}) => {
		const path = String(url);
		if (path.endsWith('/api/receiver/scans') && init.method === 'POST') {
			return jsonResponse({ id: 'scan-1', created_at: '2026-10-13T00:00:00Z', archive: true });
		}
		if (path.includes('/trace?sweep=')) {
			calls.traces.push(Number(new URL(path, 'http://127.0.0.1').searchParams.get('sweep')));
			return trace(calls.traces.length);
		}
		if (path.endsWith('/finish')) {
			calls.finish.push(JSON.parse(init.body));
			return jsonResponse({});
		}
		if (path.includes('/candidates')) return jsonResponse({ items: [], total: 0, offset: 0, limit: 100 });
		throw new TypeError(`unexpected request ${path}`);
	};
	return { calls, restore: () => { globalThis.fetch = previous; } };
}

function frame(sweepCount) {
	const values = new Float32Array(64).fill(-80);
	return { startHz: 100e6, endHz: 120e6, resolutionHz: 20e6 / 64, sweepCount, current: values, average: values, maxHold: values };
}

function scanApp({ backendStop = async () => {} } = {}) {
	const log = [];
	let spectrum = null;
	const app = {
		...sweepMethods,
		...connectionMethods,
		connected: true,
		running: false,
		mockDevice: false,
		remoteMode: 'none',
		activeWorkspace: 'spectrum',
		deviceCapabilities: { supportsNativeSweep: false, supportsManualSweep: true },
		info: { boardName: 'HackRF One' },
		radio: { iqCorrection: true },
		audioRecording: { armed: false, starting: false, notice: '', error: '' },
		records: { settingsLoaded: true, autoSpectrumRecording: true, error: '', markers: [], markedOnly: false, selectedMarkerSetId: '' },
		sweep: {
			active: false, starting: false, stopping: false, stopPhase: '', listening: false, listenStarting: false,
			returnToRx: false, source: 'manual', scanId: null, archive: false, error: '',
			startMHz: 100, endMHz: 120, fftSize: 8192, minSnrDb: 8, averageAlpha: 0.35, lnaGain: 40, vgaGain: 20, ampEnabled: false,
			visualization: 'spectrum', minimumPeakDb: -160, sortBy: 'snr', candidatePage: 0, candidatePageSize: 100,
			candidates: [], selectedCandidate: null, progress: {},
		},
		_usbDevice: { vendorId: 0x1d50, productId: 0x6089, serialNumber: 'a06063c8' },
		_rxFailureHandling: null,
		backend: {
			async startSweep(_source, _config, onSpectrum) { spectrum = onSpectrum; },
			async stopSweep() { log.push('backend.stopSweep'); await backendStop(); },
			clearSweep() {},
			async close() { log.push('close'); },
		},
		drawSweepSpectrum() {},
		resetSweepViewport() {},
		async refreshSweepCandidates() {},
		async startStream() { log.push('startStream'); },
		async togglePlay() { this.running = false; },
		showMsg(message) { log.push(['msg', message]); },
	};
	return { app, log, emit: sweepCount => spectrum(frame(sweepCount)) };
}

test('Stop does not wait for a trace backlog while the console refuses connections', async () => {
	const fetches = installFetch({ trace: () => Promise.reject(new TypeError('Failed to fetch')) });
	try {
		const { app, emit } = scanApp();
		await app.startSweep();
		assert.equal(app.sweep.active, true);
		assert.equal(app.sweep.scanId, 'scan-1');
		for (let sweep = 1; sweep <= 40; sweep++) emit(sweep);

		const started = performance.now();
		assert.equal(await app.stopSweep(false), true);
		const elapsed = performance.now() - started;

		assert.ok(elapsed < 400, `Stop took ${elapsed.toFixed(0)} ms`);
		assert.ok(fetches.calls.traces.length <= 10, `${fetches.calls.traces.length} trace uploads were attempted`);
		assert.equal(app.sweep.stopping, false);
		assert.deepEqual(fetches.calls.finish, [{ status: 'stopped', trace_upload_failures: 40 }]);
		assert.match(app.records.error, /^Could not archive sweep trace \d+ \(40 not saved in this scan\): Failed to fetch$/);
	} finally {
		fetches.restore();
	}
});

test('a healthy console still gets every trace before the scan is finished', async () => {
	const fetches = installFetch({ trace: () => Promise.resolve(jsonResponse({})) });
	try {
		const { app, emit } = scanApp();
		await app.startSweep();
		for (let sweep = 1; sweep <= 5; sweep++) emit(sweep);
		assert.equal(await app.stopSweep(false), true);
		assert.deepEqual(fetches.calls.traces, [1, 2, 3, 4, 5]);
		assert.deepEqual(fetches.calls.finish, [{ status: 'stopped', trace_upload_failures: 0 }]);
	} finally {
		fetches.restore();
	}
});

test('a trace that fails while nothing newer waits is retried', async () => {
	const fetches = installFetch({ trace: attempt => Promise.resolve(attempt === 1 ? jsonResponse({ error: 'busy' }, 503) : jsonResponse({})) });
	try {
		const { app, emit, log } = scanApp();
		await app.startSweep();
		emit(1);
		await new Promise(resolve => setTimeout(resolve, 700));
		assert.deepEqual(fetches.calls.traces, [1, 1]);
		assert.equal(app.records.error, '');
		assert.ok(!log.some(entry => Array.isArray(entry) && entry[1].startsWith('Scan archive is saving again')));
		assert.equal(await app.stopSweep(false), true);
		assert.deepEqual(fetches.calls.finish, [{ status: 'stopped', trace_upload_failures: 0 }]);
	} finally {
		fetches.restore();
	}
});

test('an unplug during a scan ends it even though the HackRF cannot confirm the RF stop', async () => {
	const fetches = installFetch({ trace: () => Promise.resolve(jsonResponse({})) });
	try {
		const { app, log } = scanApp({ backendStop: async () => { throw new Error('HackRF could not finish stopping RX'); } });
		await app.startSweep();
		app.sweep.returnToRx = true;
		await app.handleUsbDeviceLost(app._usbDevice);
		assert.equal(app.sweep.active, false);
		assert.equal(app.sweep.stopping, false);
		assert.equal(app.sweep.returnToRx, false);
		assert.equal(app.connected, false);
		assert.deepEqual(fetches.calls.finish, [{ status: 'failed', trace_upload_failures: 0 }]);
		assert.ok(!log.some(entry => Array.isArray(entry) && entry[1].startsWith('Error stopping sweep')));
		assert.ok(!log.includes('startStream'));
		assert.match(app.sweep.error, /^Radio disconnected \(USB unplugged or lost\)\. RX and scanning stopped\./);
	} finally {
		fetches.restore();
	}
});

test('an unplug while a stop is already under way waits for it and does not leave the scan active', async () => {
	const fetches = installFetch({ trace: () => Promise.resolve(jsonResponse({})) });
	try {
		let failStop;
		const { app, log } = scanApp({ backendStop: () => new Promise((_, reject) => { failStop = reject; }) });
		await app.startSweep();
		app.sweep.returnToRx = true;
		const userStop = app.stopSweep(true);
		await settle();
		assert.equal(app.sweep.stopping, true);
		const lost = app.handleUsbDeviceLost(app._usbDevice);
		await settle();
		failStop(new Error('HackRF could not finish stopping RX'));
		assert.equal(await userStop, true);
		await lost;
		assert.equal(app.sweep.active, false);
		assert.equal(log.filter(entry => entry === 'backend.stopSweep').length, 1);
		assert.deepEqual(fetches.calls.finish, [{ status: 'failed', trace_upload_failures: 0 }]);
		assert.ok(!log.includes('startStream'), 'the Receiver is not restarted on a lost radio');
		assert.ok(!log.some(entry => Array.isArray(entry) && entry[1].startsWith('Error stopping sweep')));
	} finally {
		fetches.restore();
	}
});

test('an RF stop failure without a radio loss still keeps the scan running', async () => {
	const fetches = installFetch({ trace: () => Promise.resolve(jsonResponse({})) });
	try {
		const { app, log } = scanApp({ backendStop: async () => { throw new Error('busy'); } });
		await app.startSweep();
		assert.equal(await app.stopSweep(false), false);
		assert.equal(app.sweep.active, true);
		assert.deepEqual(fetches.calls.finish, []);
		assert.ok(log.some(entry => Array.isArray(entry) && entry[1] === 'Error stopping sweep: busy'));
	} finally {
		fetches.restore();
	}
});

function workspaceApp(confirmAnswer) {
	const log = [];
	const app = {
		...sweepMethods,
		...audioRecordingMethods,
		activeWorkspace: 'listener',
		running: true,
		audioRecording: { armed: true, starting: false },
		sweep: { active: false, starting: false, stopping: false, listening: false, listenStarting: false, returnToRx: false },
		tm: text => text,
		async togglePlay() { log.push('togglePlay'); this.running = false; },
		async $nextTick() {},
		initSweepCanvas() {},
	};
	globalThis.confirm = message => { log.push(['confirm', message]); return confirmAnswer; };
	return { app, log };
}

function arrowKey(key) {
	return { key, preventDefault() {}, currentTarget: { querySelector: () => ({ focus() {} }) } };
}

test('arrow keys to Spectrum ask before ending a VFO recording', async () => {
	const declined = workspaceApp(false);
	declined.app.onWorkspaceTabsKeydown(arrowKey('ArrowUp'));
	await settle();
	assert.equal(declined.log[0][0], 'confirm');
	assert.ok(!declined.log.includes('togglePlay'));
	assert.equal(declined.app.activeWorkspace, 'listener');

	const accepted = workspaceApp(true);
	accepted.app.onWorkspaceTabsKeydown(arrowKey('Home'));
	await settle();
	assert.equal(accepted.log[0][0], 'confirm');
	assert.ok(accepted.log.includes('togglePlay'));
	assert.equal(accepted.app.activeWorkspace, 'spectrum');
});

test('returning to Spectrum without a Listen session asks before ending a VFO recording', async () => {
	const { app, log } = workspaceApp(false);
	await app.returnToSpectrum();
	assert.equal(log[0][0], 'confirm');
	assert.ok(!log.includes('togglePlay'));
	assert.equal(app.activeWorkspace, 'listener');
});

test('arrow keys away from Spectrum do not ask', async () => {
	const { app, log } = workspaceApp(false);
	app.activeWorkspace = 'spectrum';
	// The Records component loads its own data once it is active; the root loads nothing.
	app.loadReceiverRecords = async () => { log.push('records'); };
	app.onWorkspaceTabsKeydown(arrowKey('End'));
	await settle();
	assert.deepEqual(log, []);
	assert.equal(app.activeWorkspace, 'records');
});
