// Node tests for the Receiver's per-VFO audio recorder (overlay app/vfo-audio-recorder.ts).
// The module has no imports, so it is type-stripped and loaded directly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('./browsdr_receiver_overlay/src/client/app/vfo-audio-recorder.ts', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64')}`;
const { VfoAudioRecorder } = await import(moduleUrl);

const MiB = 1024 * 1024;

function fakeContext() {
	return {
		currentTime: 0,
		createBuffer: (channels, length) => {
			const data = new Float32Array(length);
			return { duration: length / 48_000, getChannelData: () => data };
		},
		createBufferSource: () => ({ connect() {}, disconnect() {}, start() {}, stop() {}, onended: null, buffer: null }),
		createMediaStreamDestination: () => { throw new Error('not used with injected media'); },
	};
}

class FakeRecorder {
	constructor() {
		this.state = 'inactive';
		this.ondataavailable = null;
		this.onstop = null;
		this.onerror = null;
	}
	start() { this.state = 'recording'; }
	stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
	emit(bytes = 10) { this.ondataavailable?.({ data: { size: bytes } }); }
}

function harness({ append } = {}) {
	const calls = [];
	const recorders = [];
	let sessions = 0;
	let segments = 0;
	const api = {
		async createSession() { calls.push(['createSession']); return `session-${++sessions}`; },
		async createSegment(sessionId, metadata) {
			calls.push(['createSegment', sessionId, metadata.vfo_index]);
			if (harness.closedSessions.has(sessionId)) throw new Error('audio session is finished');
			return `segment-${++segments}`;
		},
		async appendChunk(segmentId, chunk) {
			calls.push(['appendChunk', segmentId]);
			return append ? append(segmentId, chunk) : { sessionBytes: 10, segmentBytes: 10, maxSessionBytes: 1024 * MiB, maxSegmentBytes: 256 * MiB };
		},
		async finishSegment(segmentId, metadata) { calls.push(['finishSegment', segmentId, metadata.status, metadata.error ?? '']); },
		async finishSession(sessionId, options) { calls.push(['finishSession', sessionId, options ?? {}]); },
	};
	const media = {
		createDestination: () => ({ stream: { getTracks: () => [] }, disconnect() {} }),
		createRecorder: () => { const recorder = new FakeRecorder(); recorders.push(recorder); return recorder; },
		now: () => Date.now(),
		sleep: async () => undefined,
	};
	const statuses = [];
	const recorder = new VfoAudioRecorder(fakeContext(), api, status => statuses.push(status), media);
	return { recorder, calls, recorders, statuses };
}
harness.closedSessions = new Set();

const samples = new Float32Array(480);
const metadata = { mode: 'nfm', bandwidthHz: 12_500 };

async function settle() {
	for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
}

test('a lost chunk keeps the saved part of the segment and starts a new segment', async () => {
	let failing = false;
	const { recorder, calls, recorders, statuses } = harness({
		append: () => {
			if (failing) throw new Error('network down');
			return { sessionBytes: 10, segmentBytes: 10, maxSessionBytes: 1024 * MiB, maxSegmentBytes: 256 * MiB };
		},
	});
	await recorder.arm();
	await recorder.ingest(0, 145e6, samples, metadata);
	recorders[0].emit();
	await settle();
	failing = true;
	recorders[0].emit();
	await settle();
	recorders[0].emit();
	await settle();
	const appendsToFirst = calls.filter(call => call[0] === 'appendChunk' && call[1] === 'segment-1').length;
	assert.equal(appendsToFirst, 1 + 4, 'one good chunk, then the failed chunk with three retries; later chunks are dropped');
	assert.deepEqual(calls.find(call => call[0] === 'finishSegment'), ['finishSegment', 'segment-1', 'failed', 'network down']);
	assert.ok(statuses.some(status => status.state === 'error' && /saved up to the last uploaded chunk/.test(status.message)));
	failing = false;
	await recorder.ingest(0, 145e6, samples, metadata);
	assert.ok(calls.some(call => call[0] === 'createSegment' && call[2] === 0 && calls.indexOf(call) > calls.findIndex(c => c[0] === 'finishSegment')));
	await recorder.disarm();
	assert.ok(calls.some(call => call[0] === 'finishSegment' && call[1] === 'segment-2' && call[2] === 'complete'));
});

test('a segment near the console size limit rolls over to a new file', async () => {
	const { recorder, calls, recorders, statuses } = harness({
		append: () => ({ sessionBytes: 300 * MiB, segmentBytes: 250 * MiB, maxSessionBytes: 1024 * MiB, maxSegmentBytes: 256 * MiB }),
	});
	await recorder.arm();
	await recorder.ingest(1, 145e6, samples, metadata);
	recorders[0].emit();
	await settle();
	assert.deepEqual(calls.find(call => call[0] === 'finishSegment'), ['finishSegment', 'segment-1', 'complete', '']);
	assert.ok(statuses.some(status => status.state === 'notice' && /size limit/.test(status.message)));
	await recorder.ingest(1, 145e6, samples, metadata);
	assert.equal(calls.filter(call => call[0] === 'createSegment').length, 2);
	assert.ok(recorder.isArmed);
	await recorder.disarm();
});

test('a session near its limit continues in a new session', async () => {
	const { recorder, calls, recorders } = harness({
		append: () => ({ sessionBytes: 1000 * MiB, segmentBytes: 10, maxSessionBytes: 1024 * MiB, maxSegmentBytes: 256 * MiB }),
	});
	await recorder.arm();
	await recorder.ingest(0, 145e6, samples, metadata);
	recorders[0].emit();
	await settle();
	assert.ok(calls.some(call => call[0] === 'finishSession' && call[1] === 'session-1'));
	assert.equal(recorder.sessionId, 'session-2');
	await recorder.ingest(0, 145e6, samples, metadata);
	assert.ok(calls.some(call => call[0] === 'createSegment' && call[1] === 'session-2'));
	await recorder.disarm();
});

test('a session closed by the console is replaced instead of stopping the recording', async () => {
	const { recorder, calls, statuses } = harness();
	await recorder.arm();
	harness.closedSessions.add('session-1');
	try {
		await recorder.ingest(0, 145e6, samples, metadata);
	} finally {
		harness.closedSessions.delete('session-1');
	}
	assert.equal(recorder.sessionId, 'session-2');
	assert.ok(calls.some(call => call[0] === 'createSegment' && call[1] === 'session-2'));
	assert.ok(statuses.some(status => status.state === 'notice'));
	await recorder.disarm();
});

test('page unload asks the console to keep open segments in one keepalive request', async () => {
	const { recorder, calls } = harness();
	await recorder.arm();
	await recorder.ingest(0, 145e6, samples, metadata);
	recorder.finalizeForUnload();
	assert.deepEqual(calls.at(-1), ['finishSession', 'session-1', { finalizeOpenSegments: true, keepalive: true }]);
	assert.equal(recorder.isArmed, false);
	assert.equal(recorder.sessionId, null);
});

test('an upload failure does not turn a successful stop into an error', async () => {
	let failing = true;
	const { recorder, recorders } = harness({
		append: () => { if (failing) throw new Error('timeout'); },
	});
	await recorder.arm();
	await recorder.ingest(0, 145e6, samples, metadata);
	recorders[0].emit();
	await settle();
	failing = false;
	await assert.doesNotReject(recorder.disarm());
});
