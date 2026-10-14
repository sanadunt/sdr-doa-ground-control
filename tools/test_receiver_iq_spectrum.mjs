import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FFT, initSync } from '../vendor/BrowSDR/hackrf-web/pkg/hackrf_web.js';

initSync({ module: readFileSync(new URL('../vendor/BrowSDR/hackrf-web/pkg/hackrf_web_bg.wasm', import.meta.url)) });

test('spectrum starts with the pinned FFT and removes DC without erasing an off-center signal', async () => {
  const { processSpectrumFft } = await import('./browsdr_receiver_overlay/src/client/worker/iq-spectrum.ts');
  const size = 64;
  const window = new Float32Array(size).fill(1);
  const raw = new Int8Array(size * 2);
  for (let i = 0; i < size; i++) {
    raw[2 * i] = 20 + (i % 2 ? -40 : 40);
    raw[2 * i + 1] = -12;
  }

  const uncorrected = new Float32Array(size);
  const corrected = new Float32Array(size);
  const uncorrectedFft = new FFT(size, window);
  const correctedFft = new FFT(size, window);
  try {
    processSpectrumFft(uncorrectedFft, raw.slice(), uncorrected, false);
    processSpectrumFft(correctedFft, raw.slice(), corrected, true);
    assert.ok(uncorrected[size / 2] > -50, 'uncorrected DC bin should be visible');
    assert.ok(corrected[size / 2] < uncorrected[size / 2] - 35, 'DC correction should suppress the center spur');
    assert.ok(Math.abs(corrected[0] - uncorrected[0]) < 0.1, 'off-center signal power must be preserved');
  } finally {
    uncorrectedFft.free();
    correctedFft.free();
  }
});

test('DC correction removes a fractional offset instead of rounding it to whole LSBs (AUD-64)', async () => {
	const { processSpectrumFft } = await import('./browsdr_receiver_overlay/src/client/worker/iq-spectrum.ts');
	const size = 8192;
	const window = new Float32Array(size);
	for (let i = 0; i < size; i++) window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
	let state = 12345;
	const unit = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return (state + 0.5) / 0x1_0000_0000;
	};
	const gauss = () => Math.sqrt(-2 * Math.log(unit())) * Math.cos(2 * Math.PI * unit());
	const frames = 16;
	const averagePower = correctDc => {
		const fft = new FFT(size, window);
		const output = new Float32Array(size);
		const power = new Float64Array(size);
		try {
			for (let frame = 0; frame < frames; frame++) {
				const raw = new Int8Array(size * 2);
				for (let i = 0; i < size; i++) {
					raw[2 * i] = Math.max(-128, Math.min(127, Math.round(3 * gauss() + 0.45)));
					raw[2 * i + 1] = Math.max(-128, Math.min(127, Math.round(3 * gauss() - 0.4)));
				}
				processSpectrumFft(fft, raw, output, correctDc);
				for (let i = 0; i < size; i++) power[i] += 10 ** (output[i] / 10) / frames;
			}
		} finally {
			fft.free();
		}
		const db = Array.from(power, value => 10 * Math.log10(value));
		const median = db.slice().sort((a, b) => a - b)[size >> 1];
		return { centre: db[size / 2] - median, median };
	};
	const uncorrected = averagePower(false);
	const corrected = averagePower(true);
	assert.ok(uncorrected.centre > 15, `uncorrected DC spike ${uncorrected.centre.toFixed(1)} dB`);
	// Rounding the mean to whole LSBs left about +21 dB here.
	assert.ok(corrected.centre < 3, `corrected DC bin ${corrected.centre.toFixed(1)} dB above the noise median`);
	assert.ok(corrected.median - uncorrected.median < 0.3, 'the noise floor is essentially unchanged');
});
