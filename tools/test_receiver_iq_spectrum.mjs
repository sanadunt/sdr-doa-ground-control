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
