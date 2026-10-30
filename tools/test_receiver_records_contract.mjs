// Contract between the Receiver's Records helpers and the copies the LAN view's
// read-only Records tab uses: frontend/src/lib/recordsArchiveFormat.ts against
// tools/browsdr_receiver_overlay/src/client/app/records-archive-format.ts, and
// frontend/src/lib/recordsArchiveApi.ts against records-archive-api.ts. Every name the
// console copies must exist on the Receiver side and answer the same samples, so the
// tablet asks for and shows what the groundstation does. Run with:
//   node --test tools/test_receiver_records_contract.mjs
// Needs Node 22.13+ (TypeScript is loaded through receiver_overlay_hooks.mjs).
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./receiver_overlay_hooks.mjs', import.meta.url);

const appDir = new URL('./browsdr_receiver_overlay/src/client/app/', import.meta.url);
const receiverFormat = await import(new URL('records-archive-format.ts', appDir).href);
const receiverApi = await import(new URL('records-archive-api.ts', appDir).href);
const receiverRecords = await import(new URL('receiver-records-api.ts', appDir).href);
const consoleFormat = await import(new URL('../frontend/src/lib/recordsArchiveFormat.ts', import.meta.url).href);
const consoleApi = await import(new URL('../frontend/src/lib/recordsArchiveApi.ts', import.meta.url).href);

const ZONES = ['UTC', 'Asia/Jakarta', 'Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'Pacific/Apia'];
const DAY_KEYS = ['2025-03-09', '2025-03-10', '2025-03-30', '2025-10-26', '2025-11-02', '2011-12-29', '2011-12-30', '2024-02-29', '0099-01-01'];
const MONTH_KEYS = ['2025-03', '2025-10', '2011-12', '2024-02', '2026-10'];

/** Runs `body` in a time zone; both sides' cached formatters keep the zone they were made in, so they go too. */
function inZone(zone, body) {
	const previous = process.env.TZ;
	process.env.TZ = zone;
	receiverFormat.clearFormatterCache();
	consoleFormat.clearFormatterCache();
	try {
		return body();
	} finally {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	}
}

/** The result of a call, or the error class and message it threw. */
function outcome(fn, ...args) {
	try {
		return { value: fn(...args) };
	} catch (error) {
		return { error: `${error?.name}: ${error?.message}` };
	}
}

function sameOn(name, samples, map = (value) => value) {
	assert.ok(name in consoleFormat || name in consoleApi, `console copy lacks ${name}`);
	const consoleFn = consoleFormat[name] ?? consoleApi[name];
	const receiverFn = receiverFormat[name] ?? receiverApi[name] ?? receiverRecords[name];
	assert.equal(typeof receiverFn, 'function', `the Receiver has no ${name}`);
	for (const args of samples) {
		const mine = outcome(consoleFn, ...args);
		const theirs = outcome(receiverFn, ...args);
		assert.deepEqual(
			mine.error ? mine : { value: map(mine.value) },
			theirs.error ? theirs : { value: map(theirs.value) },
			`${name}(${JSON.stringify(args)})`,
		);
	}
}

const FORMAT_CONSTANTS = [
	'SEARCH_MAX_LENGTH', 'HOUR_MS', 'MINUTE_MS', 'ARCHIVE_STATUSES', 'TIME_FORMAT', 'HOUR_FORMAT', 'SHORT_DATE_FORMAT',
	'DAY_MONTH_FORMAT', 'LONG_DATE_FORMAT', 'MONTH_FORMAT',
];

for (const name of FORMAT_CONSTANTS) {
	test(`${name} is the Receiver's`, () => {
		assert.ok(name in consoleFormat, `console copy lacks ${name}`);
		assert.deepEqual(consoleFormat[name], receiverFormat[name]);
	});
}

test('the API roots are the Receiver\'s', () => {
	assert.equal(consoleApi.RECEIVER_API_ROOT, receiverApi.RECEIVER_API_ROOT);
	assert.equal(consoleApi.ARCHIVE_API_ROOT, receiverApi.ARCHIVE_API_ROOT);
});

test('the error codes are the Receiver\'s ARCHIVE_ERROR_TEXT codes', () => {
	assert.deepEqual([...consoleFormat.ARCHIVE_ERROR_CODES], Object.keys(receiverFormat.ARCHIVE_ERROR_TEXT));
});

test('every exported function of the copies exists on the Receiver side', () => {
	const own = new Set(['recordsTimeQuery', 'createRecordsClient', 'isAbortError']);
	for (const [name, value] of [...Object.entries(consoleFormat), ...Object.entries(consoleApi)]) {
		if (typeof value !== 'function' || own.has(name) || name === 'RecordsRequestError') continue;
		const receiverFn = receiverFormat[name] ?? receiverApi[name] ?? receiverRecords[name];
		assert.equal(typeof receiverFn, 'function', `${name} is not a Receiver helper`);
		assert.equal(value.length, receiverFn.length, `${name} takes another number of parameters`);
	}
});

test('status codes', () => {
	sameOn('statusCode', ['complete', 'stopped', 'partial', 'interrupted', 'failed', 'recording', 'running', 'deleting', ''].map((status) => [status]));
});

test('calendar dates in every zone', () => {
	for (const zone of ZONES) {
		inZone(zone, () => {
			sameOn('dayNumber', [[1970, 1, 1], [2025, 3, 10], [2000, 2, 29], [1, 1, 1], [-1, 12, 31]]);
			sameOn('dateFromDayNumber', [[0], [20157], [-719162], [2932896]].map(([days]) => [days]));
			sameOn('formatDateKey', [[{ year: 2025, month: 3, day: 9 }], [{ year: 99, month: 1, day: 1 }]]);
			sameOn('parseDateKey', [...DAY_KEYS, '2025-02-29', '2025-13-01', '2025-3-1', ''].map((key) => [key]));
			sameOn('dateKeyDayNumber', [...DAY_KEYS, 'bad'].map((key) => [key]));
			sameOn('addDays', DAY_KEYS.flatMap((key) => [[key, 1], [key, -1], [key, 40]]));
			sameOn('localDateKey', [[0], [1_741_608_000_000], [1_325_239_200_000], [1_743_296_400_000]]);
			sameOn('monthKeyOf', DAY_KEYS.map((key) => [key]));
			sameOn('addMonths', MONTH_KEYS.flatMap((key) => [[key, 1], [key, -1], [key, -13], [key, 25]]));
			sameOn('localMidnight', DAY_KEYS.map((key) => [key]));
			sameOn('localTimeOn', DAY_KEYS.flatMap((key) => [[key, 0, 0], [key, 2, 30], [key, 23, 59]]));
			sameOn('localDayBounds', DAY_KEYS.map((key) => [key]));
			sameOn('dayExists', DAY_KEYS.map((key) => [key]));
			sameOn('shiftExistingDay', DAY_KEYS.flatMap((key) => [[key, 1], [key, -1]]));
			sameOn('calendarGrid', MONTH_KEYS.map((key) => [key]));
		});
	}
});

test('formatting', () => {
	for (const zone of ['UTC', 'Asia/Jakarta', 'America/New_York']) {
		inZone(zone, () => {
			for (const locale of ['en', 'id', undefined]) {
				const instants = [0, 1_741_608_000_000, 1_743_296_400_000];
				sameOn('formatTime', instants.map((ms) => [ms, locale]));
				sameOn('formatHour', instants.map((ms) => [ms, locale]));
				sameOn('formatShortDate', instants.map((ms) => [ms, locale]));
				sameOn('formatDateKeyLabel', DAY_KEYS.map((key) => [key, locale]));
				sameOn('formatMonthLabel', MONTH_KEYS.map((key) => [key, locale]));
				sameOn('dateKeyNoon', DAY_KEYS.map((key) => [key]));
			}
		});
	}
	sameOn('formatDuration', [[null], [0], [59.6], [3600], [86_399], [-1], [Number.NaN]].map(([value]) => [value]));
	sameOn('formatBytes', [[null], [0], [1023], [1024], [1_048_576], [5e9], [5e12], [-1]].map(([value]) => [value]));
	sameOn('formatAudioMHz', [[null], [144_000_000], [98_100_000.5]]);
	sameOn('formatScanRange', [[null, 1], [100e6, null], [100e6, 200e6], [24e6, 1766e6]]);
	sameOn('formatScanResolution', [[null], [4096], [8192], [0], [-5]]);
	sameOn('formatBandwidth', [[null], [12_500], [200_000], [2_400_000], [Number.NaN]]);
});

test('timeline geometry', () => {
	for (const zone of ['UTC', 'Europe/Berlin', 'Asia/Kolkata']) {
		inZone(zone, () => {
			for (const key of ['2025-03-10', '2025-03-30', '2025-10-26']) {
				const { startMs, endMs } = receiverFormat.localDayBounds(key);
				sameOn('timelineWidth', [[startMs, endMs], [startMs, startMs]]);
				sameOn('timelineX', [[startMs - 1, startMs, endMs], [startMs + 90 * 60_000, startMs, endMs], [endMs + 1, startMs, endMs]]);
				sameOn('timelineBars', [[[[startMs, startMs + 1], [startMs + 3_600_000, startMs + 7_200_000], [endMs - 10, endMs + 99], [endMs + 5, endMs + 9]], startMs, endMs]]);
				sameOn('timelineHourLines', [[startMs, endMs]]);
				sameOn('timelineTicks', [[startMs, endMs, (ms) => String(ms)]]);
				sameOn('hourContaining', [[startMs, startMs, endMs], [startMs + 5_000_000, startMs, endMs], [endMs + 1, startMs, endMs]]);
			}
		});
	}
});

test('filters and queries', () => {
	const filters = [
		receiverFormat.emptyFilters(),
		{ ...receiverFormat.emptyFilters(), type: 'scan', status: 'complete', minMHz: '100', maxMHz: '200.5', q: '  tower  ' },
		{ ...receiverFormat.emptyFilters(), type: 'all', vfo: '1', mode: 'NFM', bandwidth: '12500', minMHz: '300', maxMHz: '100' },
		{ ...receiverFormat.emptyFilters(), minMHz: 'abc', maxMHz: '-1', q: 'x'.repeat(80) },
	];
	assert.deepEqual(consoleFormat.emptyFilters(), receiverFormat.emptyFilters());
	sameOn('parseMHzField', ['', ' 144.5 ', 'abc', '-1', '1e7', '0'].map((value) => [value]));
	sameOn('frequencyFieldErrors', filters.map((value) => [value]));
	sameOn('effectiveType', filters.map((value) => [value]));
	sameOn('filterFields', filters.map((value) => [value]));
	const times = [{ kind: 'all' }, { kind: 'range', fromMs: 1000, toMs: 2000 }, { kind: 'windows', windows: [[1, 2], [5, 9]] }];
	const pagings = [{ sort: 'start', order: 'desc', offset: 0, limit: 50 }, { sort: 'frequency', order: 'asc', offset: 100, limit: 50 }];
	const asText = (params) => params.toString();
	sameOn('itemsQuery', filters.flatMap((value) => times.flatMap((time) => pagings.map((paging) => [value, time, paging]))), asText);
	sameOn('timelineQuery', filters.map((value) => [value, { startMs: 1000, endMs: 86_401_000 }]), asText);
});

test('the tablet\'s Day and All dates query is the Receiver\'s archiveTimeSpec', () => {
	for (const zone of ['UTC', 'Europe/Berlin', 'Pacific/Apia']) {
		inZone(zone, () => {
			for (const key of [...DAY_KEYS, 'not-a-date']) {
				for (const mode of ['day', 'all']) {
					const day = receiverFormat.parseDateKey(key) ? receiverFormat.localDayBounds(key) : null;
					for (const range of [null, day ? { startMs: day.startMs + 3_600_000, endMs: day.startMs + 7_200_000 } : null]) {
						const theirs = receiverFormat.archiveTimeSpec(mode, key, key, range, receiverFormat.emptyFilters()).query;
						assert.deepEqual(consoleFormat.recordsTimeQuery(mode, key, range), theirs, `${zone} ${mode} ${key}`);
					}
				}
			}
		});
	}
});

test('paging and the trace plot', () => {
	sameOn('pageCount', [[0, 50], [50, 50], [51, 50], [1000, 50]]);
	sameOn('pageRangeLabel', [[0, 50, 0], [0, 50, 50], [2, 50, 7]]);
	sameOn('defaultSortOrder', ['start', 'end', 'duration', 'frequency', 'size', 'type', 'status'].map((key) => [key]));
	sameOn('tracePlot', [
		[[], []],
		[[-80, -70, -60], [-90, -85, -80]],
		[[-50, Number.NaN, -50], [-52, -51, -50]],
		[[-100], [-100]],
	]);
});

const ITEM = {
	kind: 'audio', id: '0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8', session_id: 's1', start: '2025-03-10T12:00:00+00:00', end: null,
	start_ms: 1_741_608_000_000, end_ms: null, duration_s: 3, bytes: 10_240, estimated_bytes: 11_264, status: 'complete', error: '',
	playable: true, previewable: false, downloadable: true, deletable: true, vfo_index: 0, frequency_hz: 144e6, mode: 'nfm',
	bandwidth_hz: 12_500, codec: 'audio/webm;codecs=opus', source: null, start_hz: null, end_hz: null, fft_size: null,
	trace_count: null, candidate_count: null, trace_upload_failures: null,
};

test('answer parsers accept and refuse the same answers', () => {
	const facets = {
		vfo_indices: [0, 1], modes: ['nfm'], bandwidths_hz: [12_500], sources: ['native'], statuses: ['complete'],
		min_frequency_hz: 100e6, max_frequency_hz: 200e6, totals: { audio: 1, scan: 2, bytes: 3 }, first_ms: 1, last_ms: 2,
		free_bytes: null, now_ms: 3,
	};
	sameOn('parseArchiveFacets', [[facets], [{ ...facets, modes: [''] }], [{ ...facets, totals: null }], [null]]);
	const calendar = { days: [{ audio: 1, scan: 0 }, { audio: 0, scan: 2 }], first_ms: null, last_ms: null, now_ms: 5, truncated: false };
	sameOn('parseArchiveCalendar', [[calendar], [calendar, 2], [calendar, 3], [{ ...calendar, days: [{ audio: -1, scan: 0 }] }]]);
	const timeline = { from_ms: 0, to_ms: 10, now_ms: 11, audio: [[1, 2]], scan: [], counts: { audio: 1, scan: 0 }, truncated: true };
	sameOn('parseArchiveTimeline', [[timeline], [{ ...timeline, audio: [[3, 2]] }], [{ ...timeline, scan: [[1]] }]]);
	sameOn('parseArchiveItem', [[ITEM], [{ ...ITEM, kind: 'video' }], [{ ...ITEM, bytes: -1 }], [{ ...ITEM, status: '' }]]);
	const items = { items: [ITEM], total: 1, totals: { audio: 1, scan: 0, bytes: 10_240, estimated_bytes: 11_264 }, offset: 0, limit: 50, now_ms: 9 };
	sameOn('parseArchiveItems', [[items], [{ ...items, total: 1.5 }], [{ ...items, totals: {} }]]);
	const preview = {
		id: 'p', start_hz: 1, end_hz: 2, bins: 2, trace_format: 1, trace_count: 3, traces_used: 3, traces_skipped: 0,
		max_db: [-50, -40], mean_db: [-60, -55],
		candidates: Array.from({ length: 12 }, (_, index) => ({ frequency_hz: index, peak_db: -40, snr_db: 10, bandwidth_hz: null })),
	};
	sameOn('parseArchiveScanPreview', [[preview], [{ ...preview, mean_db: [-60] }], [{ ...preview, max_db: [Number.NaN, 1] }]]);
});

test('URL builders', () => {
	const id = ITEM.id;
	sameOn('zoneQuery', [['Asia/Jakarta', 420], ['UTC', 0], ['America/New_York', -300]]);
	sameOn('audioPlaybackUrl', [[id], ['a/b']]);
	sameOn('audioDownloadUrl', [[id, 'Asia/Jakarta', 420]]);
	sameOn('scanDownloadUrl', [[id, 'UTC', 0]]);
	sameOn('downloadUrl', [['audio', id, 'UTC', 0], ['scan', id, 'Asia/Jakarta', 420]]);
	sameOn('browserTimeZone', [[]]);
	sameOn('browserUtcOffsetMinutes', [[]]);
});
