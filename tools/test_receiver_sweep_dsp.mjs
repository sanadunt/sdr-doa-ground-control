// Receiver wide-scan detection, grouping and level-scale checks. Run with:
//   node --test tools/test_receiver_sweep_dsp.mjs
// Needs the vendor/BrowSDR submodule (pinned FFT wasm) and Node 22.13+.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';

register('./receiver_overlay_hooks.mjs', import.meta.url);

const wasm = await import('../vendor/BrowSDR/hackrf-web/pkg/hackrf_web.js');
wasm.initSync({ module: readFileSync(new URL('../vendor/BrowSDR/hackrf-web/pkg/hackrf_web_bg.wasm', import.meta.url)) });
const overlay = new URL('./browsdr_receiver_overlay/src/client/', import.meta.url);
const { SweepAccumulator } = await import(new URL('worker/sweep-processing.ts', overlay).href);
const { SWEEP_MAX_CANDIDATES, SWEEP_SAMPLE_RATE_HZ } = await import(new URL('worker/sweep-types.ts', overlay).href);
const { processSpectrumFft } = await import(new URL('worker/iq-spectrum.ts', overlay).href);
const { ManualSweepEngine } = await import(new URL('worker/sweep-engine.ts', overlay).href);
const { groupAdjacentCandidates, reselectCandidateBand } = await import(new URL('app/candidate-bands.ts', overlay).href);
const waterfall = await import(new URL('app/sweep-waterfall.ts', overlay).href);
const { parseSweepSession, serializeSweepSession } = await import(new URL('app/sweep-session.ts', overlay).href);

const USABLE_HALF_HZ = 7_500_000;
const TUNE_STEP_HZ = 10_000_000;

function config(overrides = {}) {
	return {
		startHz: 100e6, endHz: 120e6, fftSize: 8192, minSnrDb: 8, averageAlpha: 0.35,
		lnaGain: 40, vgaGain: 20, ampEnabled: false, iqCorrection: true, ...overrides,
	};
}

function random(seed) {
	let state = seed >>> 0;
	const unit = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return (state + 0.5) / 0x1_0000_0000;
	};
	return { unit, gauss: () => Math.sqrt(-2 * Math.log(unit())) * Math.cos(2 * Math.PI * unit()) };
}

function hann(size) {
	const window = new Float32Array(size);
	for (let i = 0; i < size; i++) window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
	return window;
}

function inverseFft(re, im) {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let length = 2; length <= n; length <<= 1) {
		const angle = 2 * Math.PI / length;
		for (let start = 0; start < n; start += length) {
			for (let k = 0; k < length / 2; k++) {
				const wr = Math.cos(angle * k);
				const wi = Math.sin(angle * k);
				const a = start + k;
				const b = a + length / 2;
				const vr = re[b] * wr - im[b] * wi;
				const vi = re[b] * wi + im[b] * wr;
				re[b] = re[a] - vr;
				im[b] = im[a] - vi;
				re[a] += vr;
				im[a] += vi;
			}
		}
	}
}

/** IQ capture (8-bit) at `centerHz`: receiver noise, CW tones and band-limited noise signals. */
function capture(rng, size, centerHz, signals, sigma) {
	const re = new Float64Array(size);
	const im = new Float64Array(size);
	for (let i = 0; i < size; i++) {
		re[i] = sigma * rng.gauss();
		im[i] = sigma * rng.gauss();
	}
	for (const signal of signals) {
		const offsetHz = signal.hz - centerHz;
		if (signal.bandwidthHz) {
			const bandRe = new Float64Array(size);
			const bandIm = new Float64Array(size);
			let bins = 0;
			for (let k = 0; k < size; k++) {
				const frequencyHz = (k < size / 2 ? k : k - size) * SWEEP_SAMPLE_RATE_HZ / size;
				if (Math.abs(frequencyHz - offsetHz) > signal.bandwidthHz / 2) continue;
				bandRe[k] = rng.gauss();
				bandIm[k] = rng.gauss();
				bins++;
			}
			if (!bins) continue;
			inverseFft(bandRe, bandIm);
			const scale = signal.amplitude / Math.sqrt(bins);
			for (let i = 0; i < size; i++) {
				re[i] += bandRe[i] * scale;
				im[i] += bandIm[i] * scale;
			}
		} else if (Math.abs(offsetHz) < SWEEP_SAMPLE_RATE_HZ / 2) {
			for (let i = 0; i < size; i++) {
				const phase = 2 * Math.PI * offsetHz * i / SWEEP_SAMPLE_RATE_HZ;
				re[i] += signal.amplitude * Math.cos(phase);
				im[i] += signal.amplitude * Math.sin(phase);
			}
		}
	}
	const iq = new Int8Array(size * 2);
	for (let i = 0; i < size; i++) {
		iq[2 * i] = Math.max(-128, Math.min(127, Math.round(re[i])));
		iq[2 * i + 1] = Math.max(-128, Math.min(127, Math.round(im[i])));
	}
	return iq;
}

/** Manual-sweep tuning plan and FFT path of ManualSweepEngine, driven synchronously. */
function manualSweeps(sweepConfig, sweeps, signals = [], { sigma = 3, seed = 1 } = {}) {
	const rng = random(seed);
	const accumulator = new SweepAccumulator(sweepConfig);
	const size = sweepConfig.fftSize;
	const fft = new wasm.FFT(size, hann(size));
	fft.set_smoothing_speed(1);
	const output = new Float32Array(size);
	try {
		for (let sweep = 0; sweep < sweeps; sweep++) {
			accumulator.beginSweep();
			for (let centerHz = sweepConfig.startHz + USABLE_HALF_HZ; centerHz - USABLE_HALF_HZ < sweepConfig.endHz; centerHz += TUNE_STEP_HZ) {
				const present = signals.filter(signal => !signal.every || sweep % signal.every === 0);
				processSpectrumFft(fft, capture(rng, size, centerHz, present, sigma), output, sweepConfig.iqCorrection);
				accumulator.addManualFft(centerHz, output);
				if (centerHz + USABLE_HALF_HZ >= sweepConfig.endHz) break;
			}
			accumulator.finishSweep();
		}
	} finally {
		fft.free();
	}
	return accumulator;
}

test('receiver noise alone no longer floods the candidate history (AUD-16)', () => {
	const sweepConfig = config({ startHz: 100e6, endHz: 1000e6 });
	const accumulator = manualSweeps(sweepConfig, 12, [], { seed: 7 });
	const candidates = accumulator.getCandidates();
	// Before the fix this run produced about 29,000 candidates after the first sweep.
	assert.ok(candidates.length <= 25, `noise produced ${candidates.length} candidates`);
	const json = serializeSweepSession({
		source: 'manual',
		config: sweepConfig,
		frame: accumulator.createFrame(),
		candidates,
		display: {
			view: 'average', minimumPeakDb: -160, displayMinDb: -60, displayMaxDb: 0,
			viewportStartHz: sweepConfig.startHz, viewportEndHz: sweepConfig.endHz,
			sortBy: 'snr', visualization: 'spectrum', selectedCandidatePeakHz: null,
		},
		waterfall: { rowCount: 0, latestSweepCount: 0, data: [] },
	});
	assert.ok(json.length < 8 * 1024 * 1024, 'Save JSON stays under the 8 MiB import limit');
});

test('candidate history is capped and evictions are reported (AUD-16)', () => {
	const sweepConfig = config({ startHz: 100e6, endHz: 140e6, fftSize: 4096 });
	const accumulator = new SweepAccumulator(sweepConfig);
	const spacingBins = 7;
	let removed = [];
	for (let sweep = 0; sweep < 2; sweep++) {
		accumulator.beginSweep();
		for (let index = 0; index < accumulator.binCount; index++) {
			const frequencyHz = sweepConfig.startHz + (index + 0.5) * accumulator.resolutionHz;
			const shifted = (index + sweep * 3) % spacingBins === 0;
			accumulator.addSample(frequencyHz, shifted ? -30 : -90);
		}
		accumulator.finishSweep();
		accumulator.getChangedCandidates();
		removed = removed.concat(accumulator.takeRemovedCandidateIds());
	}
	assert.equal(accumulator.candidateCount, SWEEP_MAX_CANDIDATES);
	assert.ok(removed.length > 0, 'evicted candidate ids are reported');
	const kept = new Set(accumulator.getCandidates().map(candidate => candidate.id));
	assert.ok(removed.every(id => !kept.has(id)));
});

test('a steady carrier keeps one identity with all hits and a narrow band (AUD-62, AUD-128)', () => {
	const toneHz = 112.3e6;
	const sweeps = 40;
	const accumulator = manualSweeps(config(), sweeps, [{ hz: toneHz, amplitude: 25 }], { seed: 3 });
	const near = accumulator.getCandidates().filter(candidate => Math.abs(candidate.peakFrequencyHz - toneHz) < 300e3);
	assert.equal(near.length, 1, `expected one candidate near the carrier, got ${near.length}`);
	const [carrier] = near;
	assert.equal(carrier.hits, sweeps);
	assert.ok(carrier.bandwidthHz < 40e3, `bandwidth ${carrier.bandwidthHz}`);
	const resolutionHz = accumulator.resolutionHz;
	// The old report was the accumulator bin centre: half a bin (1.2 kHz) high.
	assert.ok(Math.abs(carrier.peakFrequencyHz - toneHz) < 0.2 * resolutionHz, `peak ${carrier.peakFrequencyHz}`);
	assert.ok(Math.abs(carrier.meanPeakFrequencyHz - toneHz) < 0.2 * resolutionHz, `mean peak ${carrier.meanPeakFrequencyHz}`);
});

test('peak frequency is interpolated between bins instead of the bin centre (AUD-128)', () => {
	for (const offsetBins of [0.1, 0.3, -0.25]) {
		const sweepConfig = config();
		const resolutionHz = SWEEP_SAMPLE_RATE_HZ / sweepConfig.fftSize;
		const toneHz = 108e6 + (1234 + offsetBins) * resolutionHz;
		const accumulator = manualSweeps(sweepConfig, 1, [{ hz: toneHz, amplitude: 20 }], { seed: 11 });
		const [candidate] = accumulator.getCandidates().filter(item => Math.abs(item.peakFrequencyHz - toneHz) < 50e3);
		assert.ok(candidate, `carrier at ${toneHz} detected`);
		assert.ok(Math.abs(candidate.peakFrequencyHz - toneHz) < 0.12 * resolutionHz,
			`offset ${offsetBins}: error ${(candidate.peakFrequencyHz - toneHz).toFixed(1)} Hz`);
	}
});

test('separate carriers stay separate rows; touching bands share one (AUD-17)', () => {
	const tones = [[121.0e6, 30], [121.0625e6, 12], [125.0e6, 25], [128.0e6, 8]];
	const accumulator = manualSweeps(config({ startHz: 100e6, endHz: 140e6 }), 10,
		tones.map(([hz, amplitude]) => ({ hz, amplitude })), { seed: 5 });
	const rows = groupAdjacentCandidates(accumulator.getCandidates());
	for (const [hz] of tones) {
		const row = rows.find(item => hz >= item.peakRangeStartHz - 5e3 && hz <= item.peakRangeEndHz + 5e3);
		assert.ok(row, `signal ${hz} has a row`);
		assert.ok(Math.abs(row.peakFrequencyHz - hz) < 5e3, `signal ${hz} is its own row, got ${row.peakFrequencyHz}`);
	}

	const candidate = (id, startHz, endHz, peakFrequencyHz, peakDb) => ({
		id, startHz, endHz, centerHz: (startHz + endHz) / 2, bandwidthHz: endHz - startHz, peakFrequencyHz,
		meanPeakFrequencyHz: peakFrequencyHz, minPeakFrequencyHz: peakFrequencyHz, maxPeakFrequencyHz: peakFrequencyHz,
		peakDb, noiseFloorDb: -90, snrDb: peakDb + 90, firstSeen: 1, lastSeen: 1, hits: 1,
	});
	// Peaks 40 kHz apart in a chain used to merge transitively; bands that do not touch stay apart.
	const chain = [0, 1, 2, 3].map(index => candidate(index + 1, 100e6 + index * 40e3 - 5e3, 100e6 + index * 40e3 + 5e3, 100e6 + index * 40e3, -50));
	assert.equal(groupAdjacentCandidates(chain).length, 4);
	const touching = [
		candidate(5, 200e6, 200.010e6, 200.005e6, -60),
		candidate(3, 200.010e6, 200.030e6, 200.020e6, -40),
		candidate(9, 200.025e6, 200.040e6, 200.030e6, -40),
	];
	const [band] = groupAdjacentCandidates(touching);
	assert.equal(groupAdjacentCandidates(touching).length, 1);
	assert.equal(band.id, 3);
	assert.equal(band.peakFrequencyHz, 200.020e6, 'strongest member, lower peak frequency on ties');
	assert.equal(band.peakRangeStartHz, 200.005e6);
	assert.equal(band.peakRangeEndHz, 200.030e6);
});

test('a selected peak group stays selected across updates (AUD-130)', () => {
	const row = (id, start, end) => ({ id, peakFrequencyHz: start, peakRangeStartHz: start, peakRangeEndHz: end });
	const selected = row(4, 101e6, 101.02e6);
	assert.equal(reselectCandidateBand(selected, [row(2, 99e6, 99e6), row(4, 101e6, 101.03e6)]).peakRangeEndHz, 101.03e6);
	assert.equal(reselectCandidateBand(selected, [row(1, 100.99e6, 101.01e6)]).id, 1, 'group id may change when a lower id joins');
	assert.equal(reselectCandidateBand(selected, [row(7, 105e6, 105e6)]), null);
});

test('wideband signals are detected across their whole band (AUD-63)', () => {
	const simulated = config({ startHz: 100e6, endHz: 1000e6 });
	const accumulator = new SweepAccumulator(simulated);
	const spanHz = simulated.endHz - simulated.startHz;
	const centreHz = simulated.startHz + spanHz * 0.44;
	const widthHz = spanHz * 0.009;
	let state = 0x6d2b79f5;
	for (let sweep = 0; sweep < 3; sweep++) {
		accumulator.beginSweep();
		for (let index = 0; index < accumulator.binCount; index++) {
			const frequencyHz = simulated.startHz + (index + 0.5) * accumulator.resolutionHz;
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			let powerDb = -94 + (state / 0x1_0000_0000) * 6;
			const distance = Math.abs(frequencyHz - centreHz);
			if (distance < widthHz / 2) powerDb = Math.max(powerDb, -53 - 12 * distance / (widthHz / 2));
			accumulator.addSample(frequencyHz, powerDb);
		}
		accumulator.finishSweep();
	}
	const simulatedHits = accumulator.getCandidates().filter(candidate => candidate.endHz > centreHz - widthHz / 2 && candidate.startHz < centreHz + widthHz / 2);
	assert.equal(simulatedHits.length, 1, 'the simulator wideband example is one candidate');
	assert.ok(simulatedHits[0].bandwidthHz > 0.9 * widthHz, `bandwidth ${simulatedHits[0].bandwidthHz}`);

	const hardware = config({ startHz: 470e6, endHz: 530e6 });
	const captured = manualSweeps(hardware, 6, [{ hz: 496e6, bandwidthHz: 8e6, amplitude: 20 }], { seed: 9 });
	const rows = groupAdjacentCandidates(captured.getCandidates());
	const covering = rows.filter(row => row.endHz > 492e6 && row.startHz < 500e6);
	assert.equal(covering.length, 1, 'an 8 MHz noise-like signal is one peak group');
	const widest = captured.getCandidates().reduce((best, item) => (item.bandwidthHz > best.bandwidthHz ? item : best));
	assert.ok(widest.startHz <= 492.1e6 && widest.endHz >= 499.9e6, `band ${widest.startHz}-${widest.endHz}`);
});

test('candidates in the last partial bin stay inside the sweep and sessions reopen (AUD-131)', () => {
	const sweepConfig = config({ startHz: 144e6, endHz: 146e6 });
	const accumulator = new SweepAccumulator(sweepConfig);
	accumulator.beginSweep();
	for (let index = 0; index < accumulator.binCount; index++) {
		accumulator.addSample(sweepConfig.startHz + (index + 0.5) * accumulator.resolutionHz, -90 + (index % 3));
	}
	accumulator.addSample(sweepConfig.endHz - 100, -40);
	accumulator.finishSweep();
	const candidates = accumulator.getCandidates();
	assert.ok(candidates.length >= 1);
	for (const candidate of candidates) {
		for (const field of ['startHz', 'endHz', 'centerHz', 'peakFrequencyHz', 'meanPeakFrequencyHz', 'minPeakFrequencyHz', 'maxPeakFrequencyHz']) {
			assert.ok(candidate[field] >= sweepConfig.startHz && candidate[field] <= sweepConfig.endHz, `${field} ${candidate[field]}`);
		}
	}
	const snapshot = {
		source: 'manual', config: sweepConfig, frame: accumulator.createFrame(), candidates,
		display: {
			view: 'average', minimumPeakDb: -80, displayMinDb: -60, displayMaxDb: 0,
			viewportStartHz: sweepConfig.startHz, viewportEndHz: sweepConfig.endHz,
			sortBy: 'snr', visualization: 'spectrum', selectedCandidatePeakHz: null,
		},
		waterfall: { rowCount: 0, latestSweepCount: 0, data: [] },
	};
	assert.equal(parseSweepSession(serializeSweepSession(snapshot)).candidates.length, candidates.length);

	// Files saved by older builds carry the nominal centre of the partial bin past endHz.
	const file = JSON.parse(serializeSweepSession(snapshot));
	const legacy = file.candidates[file.candidates.length - 1];
	const pastEndHz = sweepConfig.endHz + 0.4 * accumulator.resolutionHz;
	Object.assign(legacy, { endHz: pastEndHz, peakFrequencyHz: pastEndHz, meanPeakFrequencyHz: pastEndHz, maxPeakFrequencyHz: pastEndHz, minPeakFrequencyHz: pastEndHz });
	const reopened = parseSweepSession(JSON.stringify(file));
	assert.ok(reopened.candidates.every(candidate => candidate.peakFrequencyHz <= sweepConfig.endHz && candidate.endHz <= sweepConfig.endHz));
});

test('manual sweeps measure every tuning centre on alternate passes (AUD-127)', async () => {
	const sweepConfig = config({ startHz: 100e6, endHz: 130e6, fftSize: 4096 });
	const toneHz = sweepConfig.startHz + USABLE_HALF_HZ;
	const rng = random(21);
	const tunes = [];
	let frequencyHz = 0;
	let receiving = null;
	const device = {
		nativeSweepSupported: false,
		async stopRx() { receiving = null; },
		async setAntennaEnable() {},
		async setSampleRate() {},
		async setBandwidth() {},
		async setGain() {},
		async setFrequency(hz) { frequencyHz = hz; tunes.push(hz); },
		async startRx(callback) {
			const token = {};
			receiving = token;
			for (let transfer = 0; transfer < 2; transfer++) {
				await new Promise(resolve => setImmediate(resolve));
				if (receiving !== token) return;
				callback(capture(rng, sweepConfig.fftSize, frequencyHz, [{ hz: toneHz, amplitude: 20 }], 3));
			}
		},
	};
	let candidates = [];
	let sweeps = 0;
	const engine = new ManualSweepEngine(device, {
		onSpectrum: frame => { sweeps = frame.sweepCount; },
		onProgress: () => {},
		onCandidates: changed => { candidates = candidates.filter(item => !changed.some(next => next.id === item.id)).concat(changed); },
		onError: error => { throw new Error(error); },
	});
	await engine.start(sweepConfig);
	for (let attempt = 0; attempt < 400 && sweeps < 4; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
	await engine.stop();
	assert.ok(sweeps >= 4, `completed ${sweeps} sweeps`);
	assert.equal(tunes[0], sweepConfig.startHz + USABLE_HALF_HZ);
	assert.ok(tunes.includes(sweepConfig.startHz + USABLE_HALF_HZ - TUNE_STEP_HZ / 2), 'odd passes shift the grid by half a step');
	const carrier = candidates.find(candidate => Math.abs(candidate.peakFrequencyHz - toneHz) < 10e3);
	assert.ok(carrier, 'a carrier exactly at a tuning centre is detected');
});

test('waterfall rows and archived traces keep levels above 0 dB (AUD-65)', () => {
	const levels = new Float32Array(2048).fill(-70);
	levels[1000] = 17;
	levels[1001] = 33;
	const row = waterfall.encodeWaterfallRow(levels);
	assert.ok(Math.abs(waterfall.decodeSweepLevel(row[1000]) - 17) < 0.5);
	assert.ok(Math.abs(waterfall.decodeSweepLevel(row[1001]) - 33) < 0.5);
	assert.notEqual(row[1000], row[1001], 'strong signals no longer share one saturated colour');

	const trace = waterfall.encodeArchivedTrace(levels);
	assert.equal(trace.length, 2048);
	assert.equal(trace[0], waterfall.ARCHIVED_TRACE_FORMAT_TAG);
	const decoded = waterfall.decodeArchivedTrace(trace);
	assert.ok(Math.abs(decoded[1000] - 17) < 0.5 && Math.abs(decoded[1001] - 33) < 0.5);
	assert.ok(Math.abs(decoded[0] + 70) < 0.5);

	// A trace archived before the wider scale: 255 meant 0 dB, every byte >= 64.
	const legacy = new Uint8Array(2048).fill(Math.round(90 * 255 / 160));
	legacy[5] = 255;
	const legacyLevels = waterfall.decodeArchivedTrace(legacy);
	assert.ok(Math.abs(legacyLevels[0] + 70) < 0.5);
	assert.equal(legacyLevels[5], 0);
});

test('session waterfall levels saved with the old 0 dB ceiling are converted on open (AUD-65)', () => {
	const sweepConfig = config();
	const accumulator = new SweepAccumulator(sweepConfig);
	const frame = accumulator.createFrame();
	const display = {
		view: 'average', minimumPeakDb: -80, displayMinDb: -60, displayMaxDb: 0,
		viewportStartHz: sweepConfig.startHz, viewportEndHz: sweepConfig.endHz,
		sortBy: 'snr', visualization: 'spectrum', selectedCandidatePeakHz: null,
	};
	const legacyLevel = Math.round(90 * 255 / 160);
	const file = JSON.parse(serializeSweepSession({
		source: 'manual', config: sweepConfig, frame, candidates: [], display,
		waterfall: { rowCount: 1, latestSweepCount: 0, data: new Array(2048).fill(legacyLevel) },
	}));
	file.frame.sweepCount = 1;
	file.waterfall.latestSweepCount = 1;
	delete file.waterfall.minDb;
	delete file.waterfall.maxDb;
	const reopened = parseSweepSession(JSON.stringify(file));
	assert.ok(Math.abs(waterfall.decodeSweepLevel(reopened.waterfall.data[0]) + 70) < 0.6);
	assert.equal(reopened.waterfall.maxDb, waterfall.SWEEP_WATERFALL_MAX_DB);
});
