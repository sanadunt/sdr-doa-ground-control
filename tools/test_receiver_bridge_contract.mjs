// Contract between the two copies of the Receiver bridge protocol: the console
// side (frontend/src/lib/receiverBridgeProtocol.ts) and the frame side
// (tools/browsdr_receiver_overlay/src/client/app/console-bridge-protocol.ts).
// Each side keeps its own constants; this test fails when they drift. Run with:
//   node --test tools/test_receiver_bridge_contract.mjs
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./receiver_overlay_hooks.mjs', import.meta.url);

const consoleSide = await import(new URL('../frontend/src/lib/receiverBridgeProtocol.ts', import.meta.url).href);
const frameSide = await import(new URL('./browsdr_receiver_overlay/src/client/app/console-bridge-protocol.ts', import.meta.url).href);

const SHARED = [
	'BRIDGE_CHANNEL',
	'BRIDGE_VERSION',
	'FRAME_MESSAGE_TYPES',
	'CONSOLE_MESSAGE_TYPES',
	'LISTEN_MODES',
	'RESULT_CODES',
	'STATUS_ERROR_CODES',
	'BUSY_STATES',
	'WORKSPACES',
	'AUDIO_STATES',
	'TUNE_SOURCES',
	'SUBSCRIBE_LIMITS',
	'TUNE_LIMITS',
	'SWEEP_LIMITS',
	'VOLUME_LIMITS',
	'DISPLAY_DB_LIMITS',
	'SAMPLE_RATES_HZ',
	'GAIN_LIMITS',
	'SPECTRUM_FLOOR_DB',
	'SWEEP_FFT_SIZES',
	'SWEEP_VIEWS',
	'SWEEP_SOURCES',
	'SWEEP_PHASES',
	'SWEEP_SPAN_LIMITS',
];

for (const name of SHARED) {
	test(`${name} is identical on both sides`, () => {
		assert.ok(name in consoleSide, `console side does not export ${name}`);
		assert.ok(name in frameSide, `frame side does not export ${name}`);
		assert.deepEqual(consoleSide[name], frameSide[name]);
	});
}

test('command id pattern accepts and rejects the same ids', () => {
	const samples = ['c1-abc', 'A_b-9', 'x'.repeat(64), '', 'x'.repeat(65), 'bad id', 'semi;colon', 'ünï'];
	for (const id of samples) {
		assert.equal(consoleSide.COMMAND_ID_PATTERN.test(id), frameSide.COMMAND_ID_PATTERN.test(id), id);
	}
});

test('a tune stamp the frame sends is one the console accepts', () => {
	const stamps = [
		{ rev: 0, by: 'receiver', id: null, receiverRev: 0 },
		{ rev: 9, by: 'console', id: 'c7-abc', receiverRev: 4 },
	];
	for (const stamp of stamps) {
		assert.ok(frameSide.TUNE_SOURCES.includes(stamp.by));
		assert.deepEqual(consoleSide.normalizeTuneStamp(stamp), stamp, JSON.stringify(stamp));
	}
});

test('subscription clamping agrees', () => {
	const inputs = [
		{},
		{ spectrum: true, bins: 1, fps: 0, spanHz: 1 },
		{ spectrum: true, bins: 100000, fps: 99, spanHz: 1e12 },
		{ spectrum: false, bins: 512, fps: 10, spanHz: 2_000_000 },
		{ spectrum: 'yes', bins: Number.NaN, fps: Infinity, spanHz: -5 },
	];
	for (const input of inputs) {
		assert.deepEqual(consoleSide.clampSubscription(input), frameSide.clampSubscription(input), JSON.stringify(input));
	}
});

test('display range clamping agrees, and the console takes the range the frame reports', () => {
	const pairs = [
		[-90, -20], [-90.04, -19.96], [-200, 100], [-20, -90], [-40, -38], [70, 80], [-160, -155], [55, 60],
		[Number.NaN, 0], [-70, Infinity], ['-70', 0], [null, 0], [-70, undefined],
	];
	for (const [min, max] of pairs) {
		assert.deepEqual(consoleSide.clampDisplayRange(min, max), frameSide.clampDisplayRange(min, max), `${min}, ${max}`);
	}
	const sent = frameSide.clampDisplayRange(-97.3, -12.7);
	const status = consoleSide.normalizeReceiverStatus({ seq: 1, display: { auto: false, ...sent } });
	assert.deepEqual(status.display, { auto: false, minDb: -97.3, maxDb: -12.7 });
});

test('a console:display the console sends is one the frame accepts unchanged', () => {
	for (const command of [
		{ type: 'console:display', auto: true },
		{ type: 'console:display', auto: false, minDb: -90, maxDb: -20 },
		{ type: 'console:display', auto: false, minDb: -300, maxDb: -299 },
	]) {
		const wire = consoleSide.commandMessage('c9-d', command);
		const parsed = frameSide.parseConsoleMessage(wire);
		const { ch: _ch, v: _v, ...payload } = wire;
		assert.deepEqual(parsed, payload, JSON.stringify(command));
	}
});

test('a gain the console snaps is one the frame accepts, and every step of the console list too', () => {
	for (const kind of ['lna', 'vga']) {
		for (const value of [Number.NaN, -5, 0, 3, 7, 9, 20, 39, 41, 61, 63, 1e9]) {
			const snapped = consoleSide.snapGain(kind, value);
			if (!Number.isFinite(value)) {
				assert.equal(snapped, null);
				continue;
			}
			assert.ok(frameSide.onGainStep(snapped, frameSide.GAIN_LIMITS[kind]), `${kind} ${value} -> ${snapped}`);
		}
		const steps = consoleSide.gainSteps(kind);
		assert.equal(steps[0], frameSide.GAIN_LIMITS[kind].min);
		assert.equal(steps.at(-1), frameSide.GAIN_LIMITS[kind].max);
		for (const step of steps) assert.ok(frameSide.onGainStep(step, frameSide.GAIN_LIMITS[kind]), `${kind} ${step}`);
	}
});

test('console:gains and console:radio the console sends are commands the frame accepts unchanged', () => {
	for (const command of [
		{ type: 'console:gains', lnaDb: 24 },
		{ type: 'console:gains', lnaDb: 23, vgaDb: 31, amp: true },
		{ type: 'console:gains', amp: false },
		{ type: 'console:radio', sampleRateHz: 10_000_000 },
		{ type: 'console:radio', sampleRateHz: 8_000_000, confirmRecording: true },
		{ type: 'console:radio', sampleRateHz: 8_000_000, confirmRecording: false },
	]) {
		const wire = consoleSide.commandMessage('c9-g', command);
		const parsed = frameSide.parseConsoleMessage(wire);
		const { ch: _ch, v: _v, ...payload } = wire;
		assert.deepEqual(parsed, payload, JSON.stringify(command));
		assert.notEqual(parsed.type, 'invalid', JSON.stringify(command));
	}
});

test('the sample rates a status lists reach the console as sent', () => {
	const rates = [...frameSide.SAMPLE_RATES_HZ];
	const status = consoleSide.normalizeReceiverStatus({ seq: 1, sampleRatesHz: rates });
	assert.deepEqual(status.sampleRatesHz, rates);
	assert.ok(consoleSide.LONG_COMMAND_TYPES.has('console:radio'), 'a restart has the start timeout');
	assert.ok(frameSide.RESULT_CODES.indexOf('RECORDING_ACTIVE') < frameSide.RESULT_CODES.indexOf('TIMEOUT'));
});

test('scan range checks and span limits agree', () => {
	for (const fft of [4096, 8192, 2048, Number.NaN]) {
		assert.equal(consoleSide.sweepMaxSpanHz(fft), frameSide.sweepMaxSpanHz(fft), String(fft));
	}
	const ranges = [
		[100e6, 1000e6, 8192, 0], [1e6, 2e6, 8192, 0], [1e6, 1_230_000_000, 8192, 0], [1e6, 1_230_000_000, 4096, 0],
		[7_249_000_000, 7_250_000_000, 8192, 0], [7_249_000_000, 7_251_000_000, 8192, 0], [100e6, 100.5e6, 8192, 0],
		[200e6, 100e6, 8192, 0], [-24e6, 100e6, 8192, -125e6], [-125e6, 100e6, 8192, -125e6], [100e6, 1000e6, 2048, 0],
		[Number.NaN, 1e9, 8192, 0], ['1e8', 1e9, 8192, 0], [100e6, 1000e6, '8192', 0],
	];
	for (const [start, stop, fft, shift] of ranges) {
		assert.equal(consoleSide.inSweepRange(start, stop, fft, shift), frameSide.inSweepRange(start, stop, fft, shift), `${start}-${stop} @${fft} ${shift}`);
	}
});

test('scan commands the console sends are commands the frame accepts unchanged', () => {
	for (const command of [
		{ type: 'console:sweep-start', mock: true },
		{ type: 'console:sweep-start', mock: false, confirmRecording: true },
		{ type: 'console:sweep-start', mock: true, confirmRecording: false },
		{ type: 'console:sweep-stop', resumeRx: false },
		{ type: 'console:sweep-stop', resumeRx: true },
		{ type: 'console:sweep-config', startHz: 400_000_000.4, stopHz: 500_000_000 },
		{ type: 'console:sweep-config', fftSize: 4096, lnaDb: 23, vgaDb: 31, amp: false },
		{ type: 'console:sweep-display', minDb: -100, maxDb: -20 },
		{ type: 'console:sweep-display', minDb: -300, maxDb: -299 },
	]) {
		const wire = consoleSide.commandMessage('c9-s', command);
		const parsed = frameSide.parseConsoleMessage(wire);
		const { ch: _ch, v: _v, ...payload } = wire;
		assert.deepEqual(parsed, payload, JSON.stringify(command));
		assert.notEqual(parsed.type, 'invalid', JSON.stringify(command));
	}
	for (const type of ['console:sweep-start', 'console:sweep-stop']) assert.ok(consoleSide.LONG_COMMAND_TYPES.has(type), `${type} has the start timeout`);
	assert.ok(frameSide.RESULT_CODES.indexOf('SWEEP_FAILED') < frameSide.RESULT_CODES.indexOf('TIMEOUT'));
	assert.ok(frameSide.RESULT_CODES.indexOf('SWEEP_UNSUPPORTED') < frameSide.RESULT_CODES.indexOf('TIMEOUT'));
});

test('the scan state and a scan frame the frame sends reach the console as sent', () => {
	const sweep = {
		phase: 'active', source: 'native', startHz: 100_000_000, stopHz: 1_000_000_000, fftSize: 8192, resolutionHz: 20_000_000 / 8192,
		lnaDb: 32, vgaDb: 24, amp: true, displayMinDb: -110.5, displayMaxDb: -20, view: 'max',
	};
	for (const phase of frameSide.SWEEP_PHASES) {
		const status = consoleSide.normalizeReceiverStatus({ seq: 1, sweep: { ...sweep, phase } });
		assert.deepEqual(status.sweep, { ...sweep, phase }, phase);
	}
	const bins = frameSide.decimateMaxHold(new Float32Array(2048).fill(-90), 512);
	const frame = consoleSide.normalizeSweepFrame({
		seq: 4, tMs: 1, startHz: 100_000_000, stopHz: 1_000_000_000, resolutionHz: 2441.40625, sweepCount: 7, view: 'current', binCount: bins.length, bins,
	});
	assert.equal(frame.source, 'sweep');
	assert.equal(frame.binCount, 512);
	assert.deepEqual([frame.startHz, frame.stopHz, frame.resolutionHz, frame.sweepCount, frame.view], [100_000_000, 1_000_000_000, 2441.40625, 7, 'current']);
	assert.notEqual(frame.bins, bins, 'a copy');
});
