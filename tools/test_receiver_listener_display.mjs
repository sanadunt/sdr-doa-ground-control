// The Dengar (Listener) dB scale of the embedded Receiver: the automatic range,
// typed limits, restored settings, and what the Listener draws with. Run with:
//   node --test tools/test_receiver_listener_display.mjs
// Needs the vendor/BrowSDR submodule and Node 22.13+.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./receiver_overlay_hooks.mjs', import.meta.url);

const appDir = new URL('./browsdr_receiver_overlay/src/client/app/', import.meta.url);
const {
	LISTENER_DB_DEFAULT, LISTENER_ENGINE_STEP_DB, autoListenerRange, keepListenerRange, listenerDisplayMethods, normalizeListenerDisplay,
} = await import(new URL('listener-display.ts', appDir).href);
const { settingsMethods } = await import(new URL('settings.ts', appDir).href);
const { createAppData } = await import(new URL('state.ts', appDir).href);

test('the Listener starts in Auto with the upstream manual range', () => {
	assert.deepEqual({ ...LISTENER_DB_DEFAULT }, { minDb: -70, maxDb: 0 });
	// createAppData reads the page language from the document.
	const hadDocument = 'document' in globalThis;
	if (!hadDocument) globalThis.document = { documentElement: { lang: 'en' } };
	try {
		assert.deepEqual(createAppData().display, { minDB: -70, maxDB: 0, auto: true });
	} finally {
		if (!hadDocument) delete globalThis.document;
	}
});

test('the automatic range is the noise floor − 5 dB to the peak + 5 dB, at least 20 dB tall', () => {
	const data = new Float32Array(1000).fill(-80);
	data[500] = -30;
	assert.deepEqual(autoListenerRange(data, 0, data.length, null), { min: -85, max: -25 });
	// A flat spectrum still gets 20 dB.
	assert.deepEqual(autoListenerRange(new Float32Array(100).fill(-60), 0, 100, null), { min: -70, max: -50 });
	// Bins that are not finite are skipped; nothing finite keeps the previous range.
	const holes = Float32Array.from([-80, Number.NaN, -Infinity, -80, -40]);
	assert.deepEqual(autoListenerRange(holes, 0, holes.length, null), { min: -85, max: -35 });
	assert.deepEqual(autoListenerRange(new Float32Array(4).fill(Number.NaN), 0, 4, { min: -1, max: 1 }), { min: -1, max: 1 });
	assert.equal(autoListenerRange(new Float32Array(0), 0, 0, null), null);
});

test('the automatic range follows the zoomed part and moves smoothly', () => {
	const data = new Float32Array(1000).fill(-90);
	data[100] = 0; // outside the zoomed half
	data[700] = -40;
	assert.deepEqual(autoListenerRange(data, 500, 500, null), { min: -95, max: -35 });
	const next = autoListenerRange(data, 500, 500, { min: -75, max: -15 }, 0.2);
	assert.ok(Math.abs(next.min - -79) < 1e-9 && Math.abs(next.max - -19) < 1e-9, JSON.stringify(next));
	// Out-of-range windows are clipped to the data.
	assert.deepEqual(autoListenerRange(data, 900, 5000, null), { min: -100, max: -80 });
});

test('a typed limit moves, the other stays where it can, inside −160..60 and 5 dB apart', () => {
	assert.deepEqual(keepListenerRange(-90, -20, 'min'), { minDb: -90, maxDb: -20 });
	assert.deepEqual(keepListenerRange(-10, -20, 'min'), { minDb: -25, maxDb: -20 }, 'the edited minimum gives way');
	assert.deepEqual(keepListenerRange(-90, -95, 'max'), { minDb: -90, maxDb: -85 }, 'the edited maximum gives way');
	assert.deepEqual(keepListenerRange(-500, 500, 'min'), { minDb: -160, maxDb: 60 });
	assert.deepEqual(keepListenerRange(-500, 500, 'max'), { minDb: -160, maxDb: 60 });
	assert.deepEqual(keepListenerRange(Number.NaN, 'x', 'min'), { minDb: -70, maxDb: 0 });
	assert.deepEqual(keepListenerRange(-90.04, -20, 'min'), { minDb: -90, maxDb: -20 }, '0.1 dB steps');
});

test('restored display settings: Auto unless saved off, a damaged range falls back to the default', () => {
	const old = { minDB: -90, maxDB: -20 };
	normalizeListenerDisplay(old);
	assert.deepEqual(old, { minDB: -90, maxDB: -20, auto: true }, 'saves from before the dB scale');
	const manual = { minDB: -100, maxDB: -30, auto: false };
	normalizeListenerDisplay(manual);
	assert.deepEqual(manual, { minDB: -100, maxDB: -30, auto: false });
	const damaged = { minDB: 'x', maxDB: 900, auto: 'no' };
	normalizeListenerDisplay(damaged);
	assert.deepEqual(damaged, { minDB: -70, maxDB: 0, auto: true });
});

function fakeListener(display = { minDB: -70, maxDB: 0, auto: true }) {
	const calls = [];
	const app = {
		...listenerDisplayMethods,
		display,
		view: { zoomScale: 1, zoomOffset: 0 },
		_waterfallEngine: { setRange(min, max) { calls.push(['setRange', min, max]); } },
		_fftCtx: {},
		_lastSpectrumData: null,
		drawSpectrum(data) { calls.push(['draw', data.length, this._zoomRepaint, this.listenerDbRange()]); },
	};
	return { app, calls };
}

test('Auto draws with the manual range until a frame arrives, then with the automatic one', () => {
	const { app, calls } = fakeListener();
	assert.deepEqual(app.listenerDbRange(), { min: -70, max: 0 });
	const frame = new Float32Array(1000).fill(-80);
	frame[10] = -30;
	app.updateListenerAutoRange(frame);
	const first = app.listenerDbRange();
	// From the manual range, a fifth of the way to the frame's −85..−25.
	assert.ok(Math.abs(first.min - (-70 + (-85 + 70) * 0.2)) < 1e-9, JSON.stringify(first));
	assert.ok(Math.abs(first.max - (0 + (-25 - 0) * 0.2)) < 1e-9, JSON.stringify(first));
	assert.deepEqual(calls.at(-1), ['setRange', first.min, first.max], 'the waterfall follows');

	// At most every 100 ms.
	app.updateListenerAutoRange(frame);
	assert.deepEqual(app.listenerDbRange(), first);
	app._listenerAutoAt = undefined;
	app.updateListenerAutoRange(frame);
	assert.notDeepEqual(app.listenerDbRange(), first);

	// Manual ignores frames and draws display.minDB..maxDB.
	app.display.auto = false;
	app.display.minDB = -90;
	app.display.maxDB = -20;
	app._listenerAutoAt = undefined;
	app.updateListenerAutoRange(new Float32Array(10).fill(0));
	assert.deepEqual(app.listenerDbRange(), { min: -90, max: -20 });
});

test('the waterfall colour table is rebuilt only for a real change', () => {
	const { app, calls } = fakeListener({ minDB: -90, maxDB: -20, auto: false });
	app.syncListenerEngineRange(true);
	assert.deepEqual(calls, [['setRange', -90, -20]]);
	app.syncListenerEngineRange(false);
	assert.equal(calls.length, 1, 'same range');
	app.display.minDB = -90 + LISTENER_ENGINE_STEP_DB / 2;
	app.syncListenerEngineRange(false);
	assert.equal(calls.length, 1, 'less than a step');
	app.display.minDB = -90 + LISTENER_ENGINE_STEP_DB;
	app.syncListenerEngineRange(false);
	assert.equal(calls.length, 2);
	app._waterfallEngine = null;
	app.syncListenerEngineRange(true);
	assert.equal(calls.length, 2, 'no engine before the first RX start');
});

test('a changed dB scale redraws the last trace and Auto starts again from the manual range', () => {
	const { app, calls } = fakeListener();
	app._lastSpectrumData = new Float32Array(8).fill(-60);
	app._listenerAppliedAuto = true;
	app.updateListenerAutoRange(app._lastSpectrumData);
	app.setListenerDbAuto(false);
	assert.equal(app.display.auto, false);
	// Manual starts from the range drawn (rounded), not from the old manual one.
	const seeded = { minDB: app.display.minDB, maxDB: app.display.maxDB };
	assert.ok(Number.isInteger(seeded.minDB) && Number.isInteger(seeded.maxDB), JSON.stringify(seeded));
	assert.notDeepEqual(seeded, { minDB: -70, maxDB: 0 });
	app.applyListenerDisplay();
	assert.deepEqual(calls.at(-1), ['draw', 8, true, { min: seeded.minDB, max: seeded.maxDB }], 'a repaint, not a new waterfall row');
	assert.deepEqual(calls.at(-2), ['setRange', seeded.minDB, seeded.maxDB]);
	assert.equal(app._zoomRepaint, false);

	app.display.minDB = -100;
	app.display.maxDB = -40;
	app.setListenerDbAuto(true);
	app.applyListenerDisplay();
	assert.deepEqual(app.listenerDbRange(), { min: -100, max: -40 }, 'until the next frame');
	assert.deepEqual(calls.at(-1), ['draw', 8, true, { min: -100, max: -40 }]);
});

test('Manual without a drawn automatic range keeps the manual range', () => {
	const { app } = fakeListener({ minDB: -95, maxDB: -15, auto: true });
	app.setListenerDbAuto(false);
	assert.deepEqual(app.display, { minDB: -95, maxDB: -15, auto: false });
	app.setListenerDbAuto(false);
	assert.deepEqual(app.display, { minDB: -95, maxDB: -15, auto: false }, 'Manual again changes nothing');
});

test('typed limits are committed on change and clamped in the field', () => {
	const { app } = fakeListener({ minDB: -90, maxDB: -20, auto: false });
	const field = (value) => ({ target: { valueAsNumber: value, value: String(value) } });
	const event = field(-10);
	app.commitListenerDbRange('min', event);
	assert.deepEqual(app.display, { minDB: -25, maxDB: -20, auto: false });
	assert.equal(event.target.value, '-25', 'the field shows the clamped value');
	app.commitListenerDbRange('max', field(80));
	assert.deepEqual(app.display, { minDB: -25, maxDB: 60, auto: false });
	app.commitListenerDbRange('max', field(Number.NaN));
	assert.deepEqual(app.display, { minDB: -25, maxDB: 60, auto: false }, 'an emptied field keeps its value');
});

test('loadSetting restores the dB scale with the other Receiver settings', () => {
	const saved = new Map();
	const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
	try {
		const app = () => ({
			...settingsMethods,
			radio: { centerFreq: 100, frequencyShift: 0, sampleRate: 20_000_000, fftSize: 65536, iqCorrection: true },
			display: { minDB: -70, maxDB: 0, auto: true },
			gains: {}, locks: {}, vfos: [], view: {}, collapsedPanels: {}, recentRemoteIds: [],
			formatFreq: mhz => String(mhz),
		});
		const manual = app();
		manual.display = { minDB: -90, maxDB: -20, auto: false };
		manual.saveSetting();
		assert.deepEqual(JSON.parse(saved.get('SDRSetting')).display, { minDB: -90, maxDB: -20, auto: false });
		const restored = app();
		restored.loadSetting();
		assert.deepEqual(restored.display, { minDB: -90, maxDB: -20, auto: false });

		saved.set('SDRSetting', JSON.stringify({ display: { minDB: -80, maxDB: -10 } }));
		const older = app();
		older.loadSetting();
		assert.deepEqual(older.display, { minDB: -80, maxDB: -10, auto: true }, 'a save from before the dB scale');

		saved.set('SDRSetting', JSON.stringify({ display: { minDB: 'x', maxDB: null, auto: false } }));
		const damaged = app();
		damaged.loadSetting();
		assert.deepEqual(damaged.display, { minDB: -70, maxDB: 0, auto: false });
	} finally {
		if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
		else delete globalThis.localStorage;
	}
});
