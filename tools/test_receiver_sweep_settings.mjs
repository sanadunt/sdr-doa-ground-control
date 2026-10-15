// The Receiver's saved wide-scan settings (ReceiverSweepSettings, overlay settings.ts): the
// Graph min./max., which the console's Spektrum dock shares, survives a reload; a damaged
// range and older saves without it leave the default. Run with:
//   node --test tools/test_receiver_sweep_settings.mjs
// Needs the vendor/BrowSDR submodule.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./receiver_overlay_hooks.mjs', import.meta.url);

const { restoreSweepSettings, serializeSweepSettings } = await import(new URL('./browsdr_receiver_overlay/src/client/app/settings.ts', import.meta.url).href);

/** The Receiver's scan defaults (state.ts). */
function defaults() {
	return {
		startMHz: 100, endMHz: 1000, fftSize: 8192, lnaGain: 40, vgaGain: 20, ampEnabled: false, minSnrDb: 8, averageAlpha: 0.35,
		minimumPeakDb: -160, sortBy: 'snr', displayMinDb: -60, displayMaxDb: 0, active: false,
	};
}

test('the Graph min./max. is saved and restored with the scan settings', () => {
	const sweep = { ...defaults(), startMHz: 430, endMHz: 440, fftSize: 4096, displayMinDb: -110, displayMaxDb: 20 };
	const saved = serializeSweepSettings(sweep);
	assert.deepEqual(JSON.parse(saved), {
		startMHz: 430, endMHz: 440, fftSize: 4096, lnaGain: 40, vgaGain: 20, ampEnabled: false, minSnrDb: 8, averageAlpha: 0.35,
		minimumPeakDb: -160, sortBy: 'snr', displayMinDb: -110, displayMaxDb: 20,
	});
	const restored = defaults();
	restoreSweepSettings(restored, saved);
	assert.deepEqual([restored.startMHz, restored.endMHz, restored.fftSize, restored.displayMinDb, restored.displayMaxDb], [430, 440, 4096, -110, 20]);
});

test('a damaged graph range or an older save without one keeps the default', () => {
	for (const range of [
		{ displayMinDb: -200, displayMaxDb: 0 },
		{ displayMinDb: -60, displayMaxDb: 61 },
		{ displayMinDb: -40, displayMaxDb: -38 },
		{ displayMinDb: '-90', displayMaxDb: 0 },
		{ displayMinDb: -90 },
		{},
	]) {
		const sweep = defaults();
		restoreSweepSettings(sweep, JSON.stringify({ startMHz: 200, endMHz: 300, ...range }));
		assert.deepEqual([sweep.displayMinDb, sweep.displayMaxDb], [-60, 0], JSON.stringify(range));
		assert.deepEqual([sweep.startMHz, sweep.endMHz], [200, 300], 'the rest still applies');
	}
	const sweep = defaults();
	restoreSweepSettings(sweep, '{not json');
	assert.deepEqual(sweep, defaults());
});
