// The Receiver's spectrum markers on the Dengar (Listener) trace: shifted to
// displayed Hz, drawn only inside the span the Listener shows, and drawn again
// on a stopped Listener when the list changes (tools.test_build_browsdr_receiver
// checks the canvas.ts anchor that calls drawListenerMarkers). Run with:
//   node --test tools/test_receiver_listener_markers.mjs
// Needs the vendor/BrowSDR submodule and Node 22.13+.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./receiver_overlay_hooks.mjs', import.meta.url);

const appDir = new URL('./browsdr_receiver_overlay/src/client/app/', import.meta.url);
const { listenerMarkers, listenerMarkerMethods } = await import(new URL('listener-markers.ts', appDir).href);

/** A 2D context that records the marker lines and labels it is asked to draw. */
function recordingContext() {
	const lines = [];
	const labels = [];
	const labelRows = [];
	let x = null;
	const context = {
		font: '', textBaseline: '', strokeStyle: '', fillStyle: '', lineWidth: 1,
		save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, stroke() {},
		moveTo(atX) { x = atX; },
		lineTo() { lines.push({ x, color: context.strokeStyle }); },
		measureText(text) { return { width: text.length * 6 }; },
		fillRect() {},
		fillText(text, _x, y) { labels.push(text); labelRows.push(y); },
	};
	return { context, lines, labels, labelRows };
}

function listenerApp({ centerMhz = 100, sampleRate = 2_000_000, shiftMhz = 0, markers = [] } = {}) {
	const app = {
		...listenerMarkerMethods,
		radio: { centerFreq: centerMhz, sampleRate, frequencyShift: shiftMhz },
		view: { zoomScale: 1, zoomOffset: 0 },
		records: { markers },
		vfos: [{}],
		running: false,
		drawn: 0,
		_zoomRepaint: false,
		drawSpectrum() { this.drawn++; assert.equal(this._zoomRepaint, true, 'a repaint, not a new waterfall row'); },
	};
	// The Receiver's computed span (computed.ts minFreq/maxFreq).
	Object.defineProperty(app, 'minFreq', { get() { return this.radio.centerFreq - this.radio.sampleRate / 2e6 + (this.radio.sampleRate / 1e6) * this.view.zoomOffset; } });
	Object.defineProperty(app, 'maxFreq', { get() { return this.radio.centerFreq - this.radio.sampleRate / 2e6 + (this.radio.sampleRate / 1e6) * (this.view.zoomOffset + 1 / this.view.zoomScale); } });
	return app;
}

test('markers move to displayed Hz with the Freq Shift and keep the Receiver list order', () => {
	const stored = [
		{ id: 'a', frequencyHz: 139_200_000, powerDb: -40, label: 'HF' },
		{ id: 'b', frequencyHz: 100_100_000, powerDb: null, label: '' },
		null,
	];
	assert.deepEqual(listenerMarkers(stored, -125), [
		{ id: 'a', frequencyHz: 14_200_000, powerDb: -40, label: 'HF' },
		{ id: 'b', frequencyHz: -24_900_000, powerDb: null, label: '' },
		{ id: '', frequencyHz: Number.NaN, powerDb: null, label: '' },
	]);
	assert.deepEqual(listenerMarkers(stored.slice(0, 1), 'x'), [{ id: 'a', frequencyHz: 139_200_000, powerDb: -40, label: 'HF' }], 'an unusable shift counts as none');
	assert.deepEqual(listenerMarkers(null, 0), []);
});

test('only the markers inside the visible span are drawn, labelled like the Spektrum canvas', () => {
	const app = listenerApp({ markers: [
		{ id: 'in', frequencyHz: 100_500_000, powerDb: null, label: 'Repeater' },
		{ id: 'edge', frequencyHz: 99_000_000, powerDb: null, label: '' },
		{ id: 'out', frequencyHz: 102_000_000, powerDb: null, label: 'Far' },
	] });
	app.refreshListenerMarkers();
	const { context, lines, labels, labelRows } = recordingContext();
	app.drawListenerMarkers(context, 800, 200);
	assert.deepEqual(lines.map(line => Math.round(line.x)), [600, 0], '100.5 MHz at 3/4 of a 99–101 MHz span, 99 MHz at its left edge');
	assert.deepEqual(labels, ['Repeater 100.500 MHz', 'M2 99.000 MHz']);
	// Under the VFO label, alternating left to right: 99 MHz is first, 100.5 MHz second.
	assert.deepEqual(labelRows, [34, 18]);
	assert.equal(lines[0].color, '#ff75a0', 'the Receiver marker colour (the builder adds the light theme one)');

	// Zoomed to the upper half: the 99 MHz marker leaves the span.
	app.view.zoomScale = 2;
	app.view.zoomOffset = 0.5;
	const zoomed = recordingContext();
	app.drawListenerMarkers(zoomed.context, 800, 200);
	assert.deepEqual(zoomed.labels, ['Repeater 100.500 MHz']);
	assert.equal(Math.round(zoomed.lines[0].x), 400);
});

test('with an upconverter the markers are drawn at their displayed frequency', () => {
	const app = listenerApp({ centerMhz: 14.2, shiftMhz: -125, markers: [{ id: 'hf', frequencyHz: 139_250_000, powerDb: null, label: 'FT8' }] });
	app.refreshListenerMarkers();
	const { context, lines, labels } = recordingContext();
	app.drawListenerMarkers(context, 1000, 200);
	assert.deepEqual(labels, ['FT8 14.250 MHz']);
	assert.equal(Math.round(lines[0].x), 525);
});

test('a changed list redraws a stopped Listener once; a running one waits for its next frame', () => {
	const app = listenerApp({ markers: [] });
	app.refreshListenerMarkers();
	assert.equal(app.drawn, 0, 'nothing drawn before a frame');
	app._lastSpectrumData = new Float32Array(16);
	app._fftCtx = {};
	app.records.markers = [{ id: 'a', frequencyHz: 100e6, powerDb: null, label: 'A' }];
	app.refreshListenerMarkers();
	assert.equal(app.drawn, 1);
	assert.equal(app._zoomRepaint, false);
	app.running = true;
	app.refreshListenerMarkers();
	assert.equal(app.drawn, 1);
	assert.equal(app._listenerMarkers.length, 1);
	const { context, lines } = recordingContext();
	app.drawListenerMarkers(context, 0, 200);
	assert.equal(lines.length, 0, 'a canvas without size draws nothing');
});
