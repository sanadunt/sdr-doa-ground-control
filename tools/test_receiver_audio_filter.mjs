// The voice filter (frontend/src/lib/radioAudioFilter.ts) in a real browser: Chrome headless over
// CDP renders it with OfflineAudioContext, as radio-translate-papua's tests/listener_e2e.mjs does.
// A loopback server serves the filter module (TypeScript stripped), the vendored noise suppressor and
// a page with the console's own CSP, so the check also shows that CSP lets the worklets compile WASM.
//
// Checks: Standard lowers 2 s of broadband noise (amplitude 0.06) by at least 15 dB against Off,
// with GTCRN in the chain; Off -> Standard -> Off -> Standard in one render plays one path (no doubled
// signal); the delay the filter adds, measured by cross-correlation, stays under FILTER_LATENCY_MS
// (frontend/src/lib/receiverMirrorAudio.ts) plus a margin. Skipped with a note when no Chrome is found
// (set CHROME to its path).
//   node --test tools/test_receiver_audio_filter.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { register } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendorDir = join(root, 'frontend/src/vendor/web-noise-suppressor');
const filterSource = join(root, 'frontend/src/lib/radioAudioFilter.ts');
const mirrorAudioSource = readFileSync(join(root, 'frontend/src/lib/receiverMirrorAudio.ts'), 'utf8');
const FILTER_LATENCY_MS = Number(/export const FILTER_LATENCY_MS = (\d+);/.exec(mirrorAudioSource)?.[1]);
// The console's CSP for its own pages (tools/ground_console.py _send_frontend).
const CONSOLE_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function findChrome() {
	const candidates = [
		process.env.CHROME,
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Chromium.app/Contents/MacOS/Chromium',
		'google-chrome',
		'google-chrome-stable',
		'chromium',
		'chromium-browser',
	].filter(Boolean);
	for (const candidate of candidates) {
		if (candidate.includes('/')) {
			if (existsSync(candidate)) return candidate;
		} else if (spawnSync('which', [candidate], { encoding: 'utf8' }).status === 0) {
			return candidate;
		}
	}
	return null;
}

const MIME = { '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.html': 'text/html; charset=utf-8' };

function startServer() {
	const page = '<!doctype html><meta charset="utf-8"><title>filter</title><script type="module" src="/page.js"></script>';
	const pageScript = `import * as filterModule from '/radioAudioFilter.js';\nwindow.filterModule = filterModule;\nwindow.filterAssets = async () => ({ lib: await import('/vendor/index.js'), urls: { gtcrnWasm: '/vendor/gtcrn.wasm', speexWasm: '/vendor/speex.wasm', gtcrnWorklet: '/vendor/gtcrn/workletProcessor.js', speexWorklet: '/vendor/speex/workletProcessor.js', gateWorklet: '/vendor/noiseGate/workletProcessor.js' } });\nwindow.ready = true;\n`;
	const filterJs = stripTypeScriptTypes(readFileSync(filterSource, 'utf8'), { mode: 'transform' });
	const server = createServer((request, response) => {
		const path = new URL(request.url, 'http://127.0.0.1').pathname;
		let body = null;
		let type = MIME['.js'];
		if (path === '/') { body = page; type = MIME['.html']; }
		else if (path === '/page.js') body = pageScript;
		else if (path === '/radioAudioFilter.js') body = filterJs;
		else if (path.startsWith('/vendor/') && !path.includes('..')) {
			const file = join(vendorDir, path.slice('/vendor/'.length));
			if (existsSync(file) && MIME[extname(file)]) { body = readFileSync(file); type = MIME[extname(file)]; }
		}
		if (body === null) { response.writeHead(404); response.end(); return; }
		response.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': CONSOLE_CSP, 'Cache-Control': 'no-store' });
		response.end(body);
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openPage(debugPort, url) {
	const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
	let nextId = 1;
	const waiting = new Map();
	const consoleLines = [];
	socket.onmessage = (event) => {
		const message = JSON.parse(event.data);
		if (message.id && waiting.has(message.id)) {
			waiting.get(message.id)(message);
			waiting.delete(message.id);
		} else if (message.method === 'Runtime.consoleAPICalled' || message.method === 'Runtime.exceptionThrown') {
			consoleLines.push(JSON.stringify(message.params).slice(0, 300));
		}
	};
	const send = (method, params = {}) => new Promise((resolve) => {
		const id = nextId++;
		waiting.set(id, resolve);
		socket.send(JSON.stringify({ id, method, params }));
	});
	await send('Runtime.enable');
	const evaluate = async (expression) => {
		const answer = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
		if (answer.result?.exceptionDetails) throw new Error(`${answer.result.exceptionDetails.text} ${JSON.stringify(answer.result.exceptionDetails.exception?.description ?? '')}\n${consoleLines.join('\n')}`);
		return answer.result?.result?.value;
	};
	return { evaluate, close: () => socket.close(), consoleLines };
}

// Runs in the page: the three measurements.
const MEASURE = `(async () => {
	const { RadioAudioFilter, FilterInsert, presetSettings } = window.filterModule;
	const sr = 48000;
	let seed = 7;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
	async function render(input, settings, wire) {
		const n = input.length;
		const ctx = new OfflineAudioContext(1, n, sr);
		const filter = new RadioAudioFilter(ctx, settings, window.filterAssets);
		for (let t = 0; t < 200 && settings.denoise !== 'off' && filter.status.denoise !== 'on' && filter.status.denoise !== 'error'; t++) await new Promise((r) => setTimeout(r, 25));
		const buffer = ctx.createBuffer(1, n, sr);
		buffer.copyToChannel(input, 0);
		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(filter.input);
		filter.output.connect(ctx.destination);
		source.start();
		const out = (await ctx.startRendering()).getChannelData(0);
		return { out, chain: filter.chainLabels.join('>'), status: filter.status };
	}
	const db = (samples, from, to) => { let sum = 0; for (let i = from; i < to; i++) sum += samples[i] * samples[i]; return 10 * Math.log10(sum / (to - from) + 1e-24); };

	// 1. Broadband noise, 2 s at 0.06: Standard against Off, skipping the first half second.
	const n = 2 * sr;
	const noise = new Float32Array(n).map(() => rnd() * 0.06);
	const off = await render(noise, presetSettings('off'));
	const standard = await render(noise, presetSettings('standard'));
	const reductionDb = db(off.out, sr / 2, n) - db(standard.out, sr / 2, n);

	// 2. Delay: a voice-band signal (tones 400-2600 Hz under a 4 Hz envelope), cross-correlated.
	const m = 3 * sr;
	const voice = new Float32Array(m);
	for (let i = 0; i < m; i++) {
		const t = i / sr;
		const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
		voice[i] = 0.2 * env * (Math.sin(2 * Math.PI * 400 * t) + 0.7 * Math.sin(2 * Math.PI * 1100 * t + 1) + 0.5 * Math.sin(2 * Math.PI * 2600 * t + 2)) / 2.2;
	}
	function lagMs(out) {
		let best = -Infinity, bestLag = 0;
		const from = sr, to = 2.5 * sr;
		for (let lag = 0; lag <= 0.2 * sr; lag += 8) {
			let sum = 0;
			for (let i = from; i < to; i += 4) sum += voice[i] * out[i + lag];
			if (sum > best) { best = sum; bestLag = lag; }
		}
		for (let lag = Math.max(0, bestLag - 8); lag <= bestLag + 8; lag++) {
			let sum = 0;
			for (let i = from; i < to; i += 4) sum += voice[i] * out[i + lag];
			if (sum > best) { best = sum; bestLag = lag; }
		}
		return bestLag / sr * 1000;
	}
	const voiceStandard = (await render(voice, presetSettings('standard'))).out;
	const delayStandardMs = lagMs(voiceStandard);
	const voiceDb = db(voice, sr, 2.5 * sr);
	const voiceStandardDb = db(voiceStandard, sr, 2.5 * sr);
	const delayLightMs = lagMs((await render(voice, presetSettings('light'))).out);

	// 3. Off -> Standard -> Off -> Standard, 2 s each, in one render: never two paths to the speaker. A
	// voice-like signal, since a speech model takes a steady tone for noise; GTCRN settles in about a
	// second after it is switched on, so each segment is measured over its second half.
	const k = 8 * sr;
	const tone = new Float32Array(k);
	for (let i = 0; i < k; i++) tone[i] = voice[i % m];
	const ctx = new OfflineAudioContext(1, k, sr);
	const gain = ctx.createGain();
	const insert = new FilterInsert(gain, ctx.destination, presetSettings('off'), window.filterAssets);
	const buffer = ctx.createBuffer(1, k, sr);
	buffer.copyToChannel(tone, 0);
	const src = ctx.createBufferSource();
	src.buffer = buffer;
	src.connect(gain);
	src.start();
	const plan = [[2, 'standard'], [4, 'off'], [6, 'standard']];
	const toggles = [];
	for (const [at, name] of plan) {
		ctx.suspend(at).then(async () => {
			insert.apply(presetSettings(name));
			for (let t = 0; t < 200 && name !== 'off' && insert.state() !== 'ai' && insert.state() !== 'error'; t++) await new Promise((r) => setTimeout(r, 25));
			toggles.push(name + ':' + insert.state() + ':' + (insert.current ? insert.current.chainLabels.join('>') : 'direct'));
			ctx.resume();
		});
	}
	const toggled = (await ctx.startRendering()).getChannelData(0);
	const segmentDb = [0, 1, 2, 3].map((s) => db(toggled, (2 * s + 1) * sr, (2 * s + 2) * sr));
	return {
		reductionDb, standardChain: standard.chain, standardStatus: standard.status,
		delayStandardMs, delayLightMs, voiceDb, voiceStandardDb,
		inputToneDb: db(tone, sr, 2 * sr), segmentDb, toggles,
	};
})()`;

test('voice filter in Chrome: Standard lowers broadband noise, one path when toggled, small delay', async (t) => {
	const chrome = findChrome();
	if (!chrome) {
		t.skip('no Chrome or Chromium found (set CHROME to its path)');
		return;
	}
	const server = await startServer();
	const port = server.address().port;
	const profile = mkdtempSync(join(tmpdir(), 'audio-filter-chrome-'));
	const debugPort = 9300 + Math.floor(Math.random() * 500);
	const browser = spawn(chrome, [
		'--headless=new', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
		`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
		// CI runners may refuse Chrome's sandbox (user namespaces); the page is this test's own.
		...(process.env.CI ? ['--no-sandbox'] : []),
		'about:blank',
	], { stdio: ['ignore', 'ignore', 'pipe'] });
	let stderr = '';
	browser.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
	try {
		let up = false;
		for (let i = 0; i < 100 && !up; i++) {
			try { up = (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok; } catch { await sleep(100); }
		}
		assert.ok(up, `Chrome headless did not answer over CDP\n${stderr}`);
		const page = await openPage(debugPort, `http://127.0.0.1:${port}/`);
		let ready = false;
		for (let i = 0; i < 100 && !ready; i++) {
			ready = await page.evaluate('window.ready === true').catch(() => false);
			if (!ready) await sleep(100);
		}
		assert.ok(ready, `the test page did not load\n${page.consoleLines.join('\n')}`);
		const result = await page.evaluate(MEASURE);
		page.close();
		t.diagnostic(`Standard lowers the noise by ${result.reductionDb.toFixed(1)} dB (chain ${result.standardChain})`);
		t.diagnostic(`delay: Standard ${result.delayStandardMs.toFixed(1)} ms, Light ${result.delayLightMs.toFixed(1)} ms`);
		t.diagnostic(`toggles: ${result.toggles.join(' | ')}`);
		t.diagnostic(`voice-band signal ${result.voiceDb.toFixed(1)} dB in, ${result.voiceStandardDb.toFixed(1)} dB out of Standard`);
		t.diagnostic(`toggled signal ${result.inputToneDb.toFixed(1)} dB; per 2 s off/standard/off/standard: ${result.segmentDb.map((v) => v.toFixed(1)).join(', ')} dB`);

		assert.equal(result.standardStatus.denoise, 'on', JSON.stringify(result.standardStatus));
		assert.match(result.standardChain, /gtcrn/);
		assert.ok(result.reductionDb >= 15, `Standard lowered the noise by only ${result.reductionDb} dB`);
		assert.ok(Number.isFinite(FILTER_LATENCY_MS));
		assert.ok(result.delayStandardMs <= FILTER_LATENCY_MS + 10, `Standard adds ${result.delayStandardMs} ms, FILTER_LATENCY_MS is ${FILTER_LATENCY_MS}`);
		// Off is the source joined directly: the tone at its own level, never doubled (+6 dB).
		for (const index of [0, 2]) assert.ok(Math.abs(result.segmentDb[index] - result.inputToneDb) < 0.5, `off segment ${index}: ${result.segmentDb[index]} dB`);
		// The voice-band signal comes through Standard (GTCRN keeps it; AGC and boost raise it).
		assert.ok(result.voiceStandardDb > result.voiceDb - 6, `Standard took the voice-band signal from ${result.voiceDb} to ${result.voiceStandardDb} dB`);
		// Filtered: it plays, below 0 dBFS (the limiter), and once.
		for (const index of [1, 3]) assert.ok(result.segmentDb[index] > result.inputToneDb - 6 && result.segmentDb[index] < 0, `standard segment ${index}: ${result.segmentDb[index]} dB`);
	} finally {
		browser.kill();
		server.close();
		await sleep(200);
		rmSync(profile, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// The Receiver frame's side (overlay audio-filter.ts), without a browser.

register('./receiver_overlay_hooks.mjs', import.meta.url);
const appDir = new URL('./browsdr_receiver_overlay/src/client/app/', import.meta.url);

class Node {
	constructor(context, kind) { this.context = context; this.kind = kind; this.outputs = []; }
	connect(node) { this.outputs.push(node); return node; }
	disconnect() { this.outputs = []; }
}
class Param { value = 0; setValueAtTime(v) { this.value = v; } setTargetAtTime(v) { this.value = v; } }
function fakeContext() {
	const context = {
		sampleRate: 48000,
		currentTime: 0,
		state: 'running',
		audioWorklet: { addModule: () => new Promise(() => undefined) },
		createGain() { return Object.assign(new Node(context, 'gain'), { gain: new Param() }); },
		createBiquadFilter() { return Object.assign(new Node(context, 'biquad'), { type: '', frequency: new Param(), Q: new Param(), gain: new Param() }); },
		createDynamicsCompressor() { return Object.assign(new Node(context, 'compressor'), { threshold: new Param(), knee: new Param(), ratio: new Param(), attack: new Param(), release: new Param() }); },
	};
	context.destination = new Node(context, 'destination');
	return context;
}

test('the frame puts the voice filter between the Receiver gain and the speaker; Off is the old path', async () => {
	const { audioFilterMethods, restoreAudioFilter } = await import(new URL('audio-filter.ts', appDir).href);
	const { presetSettings, DEFAULT_FILTER_SETTINGS } = await import(new URL('../frontend/src/lib/radioAudioFilter.ts', import.meta.url).href);
	const context = fakeContext();
	const app = {
		...audioFilterMethods,
		t: (text) => text,
		audioCtx: context,
		gainNode: context.createGain(),
		audioFilter: { ...DEFAULT_FILTER_SETTINGS },
		audioFilterState: 'on',
		audioFilterError: null,
	};
	app.attachAudioFilter();
	const filter = app._audioFilterInsert.current;
	assert.deepEqual(app.gainNode.outputs, [filter.input]);
	assert.deepEqual(filter.output.outputs, [context.destination]);
	assert.equal(app.audioFilterState, 'loading');

	app.setAudioFilterPreset('off');
	app.applyAudioFilter();
	assert.deepEqual(app.gainNode.outputs, [context.destination], 'Off joins the gain to the speaker, as before');
	assert.equal(app.audioFilterState, 'off');
	app.setAudioFilterControl({ agc: false });
	app.applyAudioFilter();
	assert.equal(app.audioFilter.preset, 'custom');
	assert.equal(app.gainNode.outputs.length, 1, 'one path to the speaker');
	assert.notEqual(app.gainNode.outputs[0], context.destination);

	// A new AudioContext (a reconnect) gets a new filter with the same settings; the old one is freed.
	app.detachAudioFilter();
	assert.equal(app._audioFilterInsert, null);
	assert.deepEqual(restoreAudioFilter({ broken: true }), DEFAULT_FILTER_SETTINGS);
	assert.deepEqual(restoreAudioFilter(presetSettings('strong')), presetSettings('strong'));
	app.audioFilterError = { code: 'SAMPLE_RATE', detail: '44100' };
	app.audioFilterState = 'error';
	assert.equal(app.audioFilterStateLabel(), 'AI failed');
	assert.equal(app.audioFilterErrorText(), 'The AI noise suppressor needs 48 kHz audio (the browser uses 44100 Hz).');
});

test('only the speaker path is filtered: the mirror, the recorder and Whisper keep the worker\'s audio', () => {
	const connection = readFileSync(new URL('connection.ts', appDir), 'utf8');
	// The worker's mix goes to playAudio() (speaker) and, unchanged, to the console bridge (the mirror's tablets).
	assert.match(connection, /this\.playAudio\(audioSamples\);[\s\S]{0,200}this\._consoleBridge\?\.audio\(audioSamples\);/);
	// Per-VFO audio feeds Whisper and the recorder on their own callback.
	assert.match(connection, /this\._feedWhisperVfo\(vfoIndex, freq, samples\);\s*this\.recordVfoAudio\(vfoIndex, freq, samples\);/);
	// The builder swaps exactly the gain's connection to the speaker for the filter.
	const helpers = readFileSync(new URL('../vendor/BrowSDR/src/client/app/ui-helpers.ts', import.meta.url), 'utf8');
	assert.equal(helpers.split('\t\t\tthis.gainNode.connect(this.audioCtx.destination);\n').length - 1, 1);
	const builder = readFileSync(new URL('build_browsdr_receiver.py', import.meta.url), 'utf8');
	assert.match(builder, /this\.attachAudioFilter\(\);/);
	const vendorAudio = readFileSync(new URL('../vendor/BrowSDR/src/client/app/audio.ts', import.meta.url), 'utf8');
	assert.match(vendorAudio, /src\.connect\(this\.gainNode\);/, 'playAudio schedules into the gain the filter follows');
});
