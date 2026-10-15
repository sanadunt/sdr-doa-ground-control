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
