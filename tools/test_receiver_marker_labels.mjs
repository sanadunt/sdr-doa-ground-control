// Marker labels on the Receiver's Spektrum canvas (sweep-canvas.ts) and the shared label
// placement (sweep-marker-renderer.ts, also used by the Dengar trace): labels never
// overlap, a label whose place is taken moves to the next free row, one with no free
// row is left out, and every marker keeps its line. Run with:
//   node --test tools/test_receiver_marker_labels.mjs
// Needs the vendor/BrowSDR submodule and Node 22.13+.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./receiver_overlay_hooks.mjs', import.meta.url);

const appDir = new URL('./browsdr_receiver_overlay/src/client/app/', import.meta.url);
const { placeMarkerLabels, MARKER_LABEL_MAX_ROWS } = await import(new URL('sweep-marker-renderer.ts', appDir).href);
const { drawSweepCanvas } = await import(new URL('sweep-canvas.ts', appDir).href);

const LABEL_FILL = 'rgba(55, 23, 37, 0.9)';
const MARKER_STROKE = '#ff75a0';

/** A 2D context that keeps the marker lines and the label boxes drawn on it. */
function recordingContext() {
	const markerLines = [];
	const labelBoxes = [];
	const labels = [];
	let x = null;
	const context = {
		font: '', textBaseline: '', textAlign: '', strokeStyle: '', fillStyle: '', lineWidth: 1,
		setTransform() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, stroke() {},
		setLineDash() {}, strokeRect() {},
		moveTo(atX) { x = atX; },
		lineTo() { if (context.strokeStyle === MARKER_STROKE) markerLines.push(x); },
		measureText(text) { return { width: text.length * 6 }; },
		fillRect(atX, atY, width, height) { if (context.fillStyle === LABEL_FILL) labelBoxes.push({ x: atX, y: atY, width, height }); },
		fillText(text) { if (context.fillStyle === '#ffd3e0') labels.push(text); },
	};
	return { context, markerLines, labelBoxes, labels };
}

function assertNoOverlap(boxes) {
	for (let a = 0; a < boxes.length; a++) {
		for (let b = a + 1; b < boxes.length; b++) {
			const apart = boxes[a].x + boxes[a].width <= boxes[b].x || boxes[b].x + boxes[b].width <= boxes[a].x
				|| boxes[a].y + boxes[a].height <= boxes[b].y || boxes[b].y + boxes[b].height <= boxes[a].y;
			assert.ok(apart, `labels ${JSON.stringify(boxes[a])} and ${JSON.stringify(boxes[b])} overlap`);
		}
	}
}

function spectrumCanvas(width = 1000, height = 300) {
	const recorder = recordingContext();
	const canvas = { width: 0, height: 0, getBoundingClientRect: () => ({ width, height }), getContext: () => recorder.context };
	return { canvas, ...recorder };
}

globalThis.window ??= { devicePixelRatio: 1 };

function drawSpectrum(markers, options = {}) {
	const target = spectrumCanvas();
	drawSweepCanvas(target.canvas, null, {
		view: 'current', startHz: 414_000_000, endHz: 417_000_000, selectedCandidate: null,
		hoverFrequencyHz: null, minDb: -100, maxDb: 0, markers, ...options,
	});
	return target;
}

test('a label keeps its place when free, else takes the next row, the other way only at a bound, else is left out', () => {
	const box = (x, y) => ({ x, width: 100, y });
	// Upwards (the Spektrum canvas): the second label moves up a row, the third two rows.
	assert.deepEqual(placeMarkerLabels([box(10, 100), box(20, 100), box(30, 100)], 0, 200, -1), [100, 84, 68]);
	// Downwards (the Dengar trace), in left-to-right order whatever the list order is.
	assert.deepEqual(placeMarkerLabels([box(30, 20), box(10, 20), box(20, 20)], 20, 200, 1), [52, 20, 36]);
	// Against the top the rows go the other way.
	assert.deepEqual(placeMarkerLabels([box(10, 0), box(20, 0), box(30, 0)], 0, 200, -1), [0, 16, 32]);
	// Near the top: up while there is room, then down.
	assert.deepEqual(placeMarkerLabels([box(10, 20), box(20, 20), box(30, 20), box(40, 20)], 0, 200, -1), [20, 4, 36, 52]);
	// Labels that do not reach each other stay on their own row.
	assert.deepEqual(placeMarkerLabels([box(0, 50), box(104, 50), box(300, 50)], 0, 200, -1), [50, 50, 50]);
	// A crowded spot has MAX_ROWS places; the other labels are left out.
	const crowd = Array.from({ length: MARKER_LABEL_MAX_ROWS + 3 }, (_, index) => box(index, 100));
	const tops = placeMarkerLabels(crowd, 0, 300, -1);
	assert.deepEqual(tops.slice(0, MARKER_LABEL_MAX_ROWS), [100, 84, 68, 52]);
	assert.deepEqual(tops.slice(MARKER_LABEL_MAX_ROWS), [null, null, null]);
	assert.deepEqual(placeMarkerLabels([{ x: Number.NaN, width: 10, y: 0 }], 0, 100, 1), [null]);
});

test('clustered markers on the Spektrum canvas get labels that do not overlap, and every line', () => {
	// The QA case: five markers within 40 kHz at about -60 dB, and spread ones elsewhere.
	const markers = [-700e3, -400e3, -20e3, -10e3, 0, 10e3, 20e3, 30e3, 300e3, 310e3, 650e3].map((offset, index) => ({
		id: `m${index}`, frequencyHz: 415_788_200 + offset, powerDb: -60 + (index % 3), label: index === 1 ? 'Repeater' : '',
	}));
	const { markerLines, labelBoxes, labels } = drawSpectrum(markers);
	assert.equal(markerLines.length, markers.length, 'every marker keeps its line');
	assertNoOverlap(labelBoxes);
	assert.ok(labels.includes('Repeater 415.388 MHz'));
	assert.ok(labels.includes('M1 415.088 MHz') && labels.includes('M11 416.438 MHz'), 'markers far from the cluster keep their labels');
	assert.ok(labels.length >= 9, `most labels still fit (${labels.length})`);
	// Labels move up from just above the marker's power, away from the trace.
	const yAt60 = 14 + (0 - -60) / 100 * (300 - 14 - 28) - 16;
	assert.ok(labelBoxes.every(box => box.y <= yAt60 + 2), 'no label moved down over the trace');
});

test('markers without a power stack down from the top of the Spektrum plot', () => {
	const markers = Array.from({ length: 3 }, (_, index) => ({ id: `n${index}`, frequencyHz: 415_000_000 + index * 1000, powerDb: null, label: '' }));
	const { labelBoxes, markerLines } = drawSpectrum(markers);
	assert.equal(markerLines.length, 3);
	assert.deepEqual(labelBoxes.map(box => box.y), [14, 30, 46]);
	assertNoOverlap(labelBoxes);
});
