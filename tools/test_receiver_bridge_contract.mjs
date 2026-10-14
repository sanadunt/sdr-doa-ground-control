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
	'SUBSCRIBE_LIMITS',
	'TUNE_LIMITS',
	'VOLUME_LIMITS',
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
