// Receiver scan archive upload banner (AUD-139): a failed trace or candidate upload
// shows an error in Records, and the next successful upload of the same kind clears it.
// Run with: node --test tools/test_receiver_archive_uploads.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('./browsdr_receiver_overlay/src/client/app/archive-upload-banner.ts', import.meta.url), 'utf8');
const { ArchiveUploadBanner } = await import(
	`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64')}`
);

test('a successful upload clears the banner its failed kind set', () => {
	const banner = new ArchiveUploadBanner();
	let shown = banner.failed('trace', 'Could not archive sweep trace 4 (1 not saved in this scan): HTTP 503');
	shown = banner.failed('trace', 'Could not archive sweep trace 5 (2 not saved in this scan): HTTP 503');
	assert.equal(shown, 'Could not archive sweep trace 5 (2 not saved in this scan): HTTP 503');
	assert.equal(banner.succeeded('trace', shown), '');
});

test('success of another kind or an unrelated banner is left alone', () => {
	const banner = new ArchiveUploadBanner();
	const candidates = banner.failed('candidates', 'Could not persist sweep candidates: HTTP 500');
	assert.equal(banner.succeeded('trace', candidates), candidates);
	assert.equal(banner.succeeded('candidates', 'Could not load candidate history: timeout'), 'Could not load candidate history: timeout');
	assert.equal(banner.succeeded('candidates', ''), '');
});

test('a banner the operator dismissed stays dismissed and is not restored', () => {
	const banner = new ArchiveUploadBanner();
	banner.failed('trace', 'Could not archive sweep trace 9 (1 not saved in this scan): offline');
	assert.equal(banner.succeeded('trace', ''), '');
	assert.equal(banner.succeeded('trace', 'later error'), 'later error');
});

const recordsApiSource = readFileSync(new URL('./browsdr_receiver_overlay/src/client/app/receiver-records-api.ts', import.meta.url), 'utf8');
const { receiverRecordsApi } = await import(
	`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(recordsApiSource, { mode: 'transform' })).toString('base64')}`
);
globalThis.window ??= globalThis;

const SWEEP_CONFIG = {
	startHz: 100e6, endHz: 120e6, fftSize: 8192, minSnrDb: 8, averageAlpha: 0.35,
	lnaGain: 40, vgaGain: 20, ampEnabled: false, iqCorrection: true,
};

function scanInfo(config) {
	return {
		id: 'scan-1', created_at: '2026-10-12T10:00:00Z', completed_at: null, source: 'simulated', status: 'complete',
		archive: true, start_hz: config.startHz, end_hz: config.endHz, config,
		candidate_count: 0, trace_count: 2, trace_upload_failures: 0,
	};
}

async function withFetch(respond, run) {
	const previous = globalThis.fetch;
	const requests = [];
	globalThis.fetch = async (url, init) => {
		requests.push({ url, init });
		return new Response(JSON.stringify(respond(url, init)), { status: 200, headers: { 'Content-Type': 'application/json' } });
	};
	try {
		return { result: await run(), requests };
	} finally {
		globalThis.fetch = previous;
	}
}

test('a new archived scan records its trace format and reads it back', async () => {
	const { requests } = await withFetch(
		() => ({ id: 'scan-1', created_at: '2026-10-12T10:00:00Z', archive: true }),
		() => receiverRecordsApi.createScan({ source: 'simulated', config: SWEEP_CONFIG, archive: true, traceFormat: 1 }),
	);
	const body = JSON.parse(requests[0].init.body);
	assert.deepEqual(Object.keys(body).sort(), ['archive', 'config', 'source']);
	assert.equal(body.config.traceFormat, 1);
	assert.equal(body.config.startHz, SWEEP_CONFIG.startHz);

	const { result } = await withFetch(() => scanInfo(body.config), () => receiverRecordsApi.getScan('scan-1'));
	assert.equal(result.traceFormat, 1);
	assert.equal('traceFormat' in result.config, false, 'the sweep config handed to the worker stays unchanged');
});

test('scans archived before the format was recorded read as unknown format', async () => {
	const { result } = await withFetch(() => scanInfo(SWEEP_CONFIG), () => receiverRecordsApi.getScan('scan-1'));
	assert.equal(result.traceFormat, null);
	await assert.rejects(
		withFetch(() => scanInfo({ ...SWEEP_CONFIG, traceFormat: 'wide' }), () => receiverRecordsApi.getScan('scan-1')),
		/traceFormat/,
	);
});
