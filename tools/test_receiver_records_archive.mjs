// The Records archive's pure view logic and its console client: local day bounds and
// the calendar grid across DST and zone changes, cached formatters, timeline geometry,
// the selection model, filter serialisation, the answer parsers, and the constants
// shared with tools/receiver_archive.py. Run with:
//   node --test tools/test_receiver_records_archive.mjs
// Needs Node 22.13+ (TypeScript is loaded through receiver_overlay_hooks.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

register('./receiver_overlay_hooks.mjs', import.meta.url);

const appDir = new URL('./browsdr_receiver_overlay/src/client/app/', import.meta.url);
const format = await import(new URL('records-archive-format.ts', appDir).href);
const api = await import(new URL('records-archive-api.ts', appDir).href);
const { ReceiverRequestError } = await import(new URL('receiver-records-api.ts', appDir).href);
const { translateReceiver, translateReceiverMessage } = await import(new URL('i18n.ts', appDir).href);

const HOUR = 3_600_000;

/** Runs `body` with the process in a time zone; Node drops its zone cache when TZ is assigned. */
function inZone(zone, body) {
	const previous = process.env.TZ;
	process.env.TZ = zone;
	try {
		return body();
	} finally {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	}
}

function steps(bounds) {
	return bounds.slice(1).map((value, index) => (value - bounds[index]) / HOUR);
}

/** The local clock of an instant, independent of any locale. */
const clock = ms => format.timeFieldValue(ms);

// ── Days and the calendar ───────────────────────────────────────────────────

test('day bounds are the browser\'s local midnights, 23 h and 25 h on DST days', () => {
	inZone('Europe/Berlin', () => {
		const autumn = format.localDayBounds('2026-10-25');
		assert.equal((autumn.endMs - autumn.startMs) / HOUR, 25);
		const spring = format.localDayBounds('2026-03-29');
		assert.equal((spring.endMs - spring.startMs) / HOUR, 23);
		assert.equal(format.localDayBounds('2026-10-20').startMs, new Date(2026, 9, 20).getTime());
		const october = format.calendarBounds('2026-10');
		assert.equal(october.length, 43);
		assert.ok(steps(october).includes(25));
		assert.ok(steps(format.calendarBounds('2026-03')).includes(23));
		for (const bounds of [october, format.calendarBounds('2026-03')]) {
			assert.ok(steps(bounds).every(step => step >= 1 && step <= 50));
		}
	});
});

test('30-minute DST zones give 23.5 h and 24.5 h days', () => {
	inZone('Australia/Lord_Howe', () => {
		const april = steps(format.calendarBounds('2026-04'));
		const october = steps(format.calendarBounds('2026-10'));
		assert.ok(april.includes(24.5), `April steps ${april}`);
		assert.ok(october.includes(23.5), `October steps ${october}`);
		const day = format.localDayBounds('2026-04-05');
		assert.equal(format.timelineWidth(day.startMs, day.endMs), 1470);
		const short = format.localDayBounds('2026-10-04');
		assert.equal(format.timelineWidth(short.startMs, short.endMs), 1410);
	});
});

test('a local day removed by a zone change has no cell interval and no bounds step', () => {
	inZone('Pacific/Apia', () => {
		const grid = format.calendarGrid('2011-12');
		assert.equal(grid.cells.length, 42);
		// 2011-12-30 did not happen in Samoa: its midnight is that of the 31st, so the
		// bounds keep one value for both and stay strictly increasing.
		assert.equal(grid.bounds.length, 42);
		const bounds = steps(grid.bounds);
		assert.ok(bounds.every(step => step >= 1 && step <= 50), `steps ${bounds}`);
		const skipped = grid.cells.find(cell => cell.key === '2011-12-30');
		assert.equal(skipped.interval, -1);
		assert.equal(format.dayExists('2011-12-30'), false);
		const before = grid.cells.find(cell => cell.key === '2011-12-29');
		const after = grid.cells.find(cell => cell.key === '2011-12-31');
		assert.equal(grid.bounds[after.interval] - grid.bounds[before.interval], 24 * HOUR, 'one real day passes from the 29th to the 31st');
		assert.equal(format.shiftExistingDay('2011-12-29', 1), '2011-12-31');
		assert.equal(format.shiftExistingDay('2011-12-31', -1), '2011-12-29');
	});
});

test('the 42-cell grid starts on Sunday and flags the shown month', () => {
	inZone('UTC', () => {
		const grid = format.calendarGrid('2026-10');
		assert.equal(grid.cells[0].key, '2026-09-27');
		assert.equal(new Date(grid.cells[0].startMs).getDay(), 0);
		assert.equal(grid.cells[41].key, '2026-11-07');
		assert.deepEqual(grid.cells.filter(cell => cell.inMonth).map(cell => cell.day), Array.from({ length: 31 }, (_, index) => index + 1));
		assert.ok(grid.cells.every((cell, index) => cell.interval === index));
		assert.equal(format.addMonths('2026-12', 1), '2027-01');
		assert.equal(format.addMonths('2026-01', -1), '2025-12');
		assert.equal(format.addDays('2024-02-28', 1), '2024-02-29');
		assert.equal(format.daySpan('2026-10-01', '2026-10-31'), 31);
		assert.equal(format.parseDateKey('2026-02-30'), null);
	});
});

test('date formatters are cached per locale and options', () => {
	const Original = Intl.DateTimeFormat;
	let created = 0;
	Intl.DateTimeFormat = new Proxy(Original, {
		construct(target, args) {
			created++;
			return Reflect.construct(target, args);
		},
	});
	try {
		format.clearFormatterCache();
		const cells = format.calendarGrid('2026-10').cells;
		for (let round = 0; round < 2; round++) {
			for (const cell of cells) format.formatDateKeyLabel(cell.key, undefined, format.CELL_DATE_FORMAT);
		}
		assert.ok(created <= 3, `${created} formatters for 84 English labels`);
		const english = created;
		for (const cell of cells) format.formatDateKeyLabel(cell.key, 'id-ID', format.CELL_DATE_FORMAT);
		for (const cell of cells) format.formatTime(cell.startMs, 'id-ID');
		assert.equal(created - english, 2, 'one formatter per locale and options');
	} finally {
		Intl.DateTimeFormat = Original;
		format.clearFormatterCache();
	}
});

test('durations, sizes, frequencies and scan resolution', () => {
	assert.equal(format.formatDuration(0), '0:00:00');
	assert.equal(format.formatDuration(59.6), '0:01:00');
	assert.equal(format.formatDuration(3725), '1:02:05');
	assert.equal(format.formatDuration(null), '—');
	assert.equal(format.formatBytes(0), '0 B');
	assert.equal(format.formatBytes(1023), '1023 B');
	assert.equal(format.formatBytes(1536), '1.5 KiB');
	assert.equal(format.formatBytes(5 * 1024 * 1024), '5.0 MiB');
	assert.equal(format.formatBytes(4.25 * 1024 ** 3), '4.3 GiB');
	assert.equal(format.formatAudioMHz(145_500_000), '145.500000 MHz');
	assert.equal(format.formatScanRange(100e6, 1000e6), '100.000–1000.000 MHz');
	assert.equal(format.formatScanRange(null, 1e6), '—');
	assert.equal(format.formatScanResolution(4096), '4.88 kHz');
	assert.equal(format.formatScanResolution(8192), '2.44 kHz');
	assert.equal(format.formatBandwidth(12_500), '12.5 kHz');
	assert.equal(format.formatBandwidth(200_000), '200 kHz');
});

// ── Timeline ────────────────────────────────────────────────────────────────

test('timeline geometry: minutes as viewBox units, a minimum bar width, clipped intervals', () => {
	inZone('UTC', () => {
		const day = format.localDayBounds('2026-10-20');
		assert.equal(format.timelineWidth(day.startMs, day.endMs), 1440);
		assert.equal(format.timelineX(day.startMs + 90 * 60_000, day.startMs, day.endMs), 90);
		assert.equal(format.timelineX(day.startMs - HOUR, day.startMs, day.endMs), 0);
		const [short, long, late] = format.timelineBars([
			[day.startMs + HOUR, day.startMs + HOUR + 1000],
			[day.startMs - HOUR, day.startMs + 2 * HOUR],
			[day.endMs - 1000, day.endMs + HOUR],
		], day.startMs, day.endMs);
		assert.equal(short.width, 4, 'at least a 360th of the day');
		assert.deepEqual(long, { x: 0, width: 120 });
		assert.ok(late.x + late.width <= 1440);
		assert.equal(format.timelineHourLines(day.startMs, day.endMs).length, 23);
	});
});

test('hour labels follow the local clock: a 25 h day repeats an hour, a 23 h day skips one', () => {
	inZone('Europe/Berlin', () => {
		const normal = format.localDayBounds('2026-10-20');
		assert.deepEqual(format.timelineTicks(normal.startMs, normal.endMs, clock).map(tick => tick.label),
			['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00']);
		const autumn = format.localDayBounds('2026-10-25');
		const long = format.timelineTicks(autumn.startMs, autumn.endMs, clock);
		assert.deepEqual(long.map(tick => tick.label), ['00:00', '02:00', '05:00', '08:00', '11:00', '14:00', '17:00', '20:00', '23:00']);
		assert.equal(format.timelineWidth(autumn.startMs, autumn.endMs), 1500);
		const spring = format.localDayBounds('2026-03-29');
		const short = format.timelineTicks(spring.startMs, spring.endMs, clock).map(tick => tick.label);
		assert.ok(!short.includes('03:00') && short.includes('04:00'), short.join(' '));
		assert.equal(format.timelineWidth(spring.startMs, spring.endMs), 1380);
		// Every other label is left out at 760 px and below (one every 6 h).
		assert.deepEqual(long.map(tick => tick.minor), [false, true, false, true, false, true, false, true, false]);
	});
});

test('click and drag on the strip: the local hour, 5 min steps from the day start', () => {
	inZone('Asia/Kolkata', () => {
		const day = format.localDayBounds('2026-10-20');
		const hour = format.hourContaining(day.startMs + 10 * HOUR + 17 * 60_000, day.startMs, day.endMs);
		assert.equal(clock(hour.startMs), '10:00');
		assert.equal(hour.endMs - hour.startMs, HOUR);
		assert.equal(new Date(hour.startMs).getUTCMinutes(), 30, '+05:30: a local hour starts at :30 UTC');
		const range = format.dragRange(day.startMs + 9 * HOUR + 7 * 60_000, day.startMs + 8 * HOUR + 2 * 60_000, day.startMs, day.endMs);
		assert.deepEqual([clock(range.startMs), clock(range.endMs)], ['08:00', '09:05']);
		const tiny = format.dragRange(day.startMs + HOUR, day.startMs + HOUR + 1000, day.startMs, day.endMs);
		assert.equal(tiny.endMs - tiny.startMs, 5 * 60_000);
		const last = format.hourContaining(day.endMs + HOUR, day.startMs, day.endMs);
		assert.equal(last.endMs, day.endMs);
	});
});

test('keyboard on the strip moves a 1 h window and changes its end by 15 min', () => {
	inZone('UTC', () => {
		const day = format.localDayBounds('2026-10-20');
		const first = format.moveWindow(null, 1, day.startMs, day.endMs);
		assert.deepEqual(first, { startMs: day.startMs, endMs: day.startMs + HOUR });
		const second = format.moveWindow(first, 1, day.startMs, day.endMs);
		assert.equal(second.startMs, day.startMs + HOUR);
		assert.deepEqual(format.moveWindow(first, -1, day.startMs, day.endMs), first, 'stays inside the day');
		const longer = format.resizeWindow(second, 1, day.startMs, day.endMs);
		assert.equal(longer.endMs - second.endMs, 15 * 60_000);
		assert.deepEqual(format.lastHour(day.startMs, day.endMs), { startMs: day.endMs - HOUR, endMs: day.endMs });
		assert.deepEqual(format.rangeTimeFields(format.lastHour(day.startMs, day.endMs), day.endMs), { from: '23:00', to: '' });
	});
});

test('timeline From/To fields: an empty To is the day end and To must follow From', () => {
	inZone('UTC', () => {
		const day = format.localDayBounds('2026-10-20');
		assert.deepEqual(format.timeFieldsRange('2026-10-20', '', ''), { range: null, invalid: '' });
		assert.deepEqual(format.timeFieldsRange('2026-10-20', '10:00', '').range, { startMs: day.startMs + 10 * HOUR, endMs: day.endMs });
		assert.equal(format.timeFieldsRange('2026-10-20', '10:00', '09:00').invalid, 'to');
		assert.equal(format.timeFieldsRange('2026-10-20', '25:00', '').invalid, 'from');
	});
});

// ── Selection ───────────────────────────────────────────────────────────────

function row(id, overrides = {}) {
	return { kind: 'audio', id, estimatedBytes: 1000, downloadable: true, deletable: true, ...overrides };
}

test('the selection model: page select, all results, caps and rows that cannot be picked', () => {
	const page = [row('a'), row('b'), row('rec', { downloadable: false, deletable: false }), row('s', { kind: 'scan', estimatedBytes: 9000 })];
	let selection = format.emptySelection();
	assert.equal(format.pageSelectionState(selection, page), 'none');
	selection = format.toggleRowSelection(selection, page[2], page);
	assert.equal(selection.ids.size, 0, 'a recording segment cannot be selected');
	selection = format.togglePageSelection(selection, page);
	assert.equal(format.pageSelectionState(selection, page), 'all');
	assert.deepEqual([...selection.ids.keys()], ['audio:a', 'audio:b', 'scan:s']);
	let summary = format.selectionSummary(selection);
	assert.deepEqual([summary.count, summary.estimatedBytes, summary.canDownload, summary.canDelete], [3, 11000, true, true]);
	selection = format.toggleRowSelection(selection, page[0], page);
	assert.equal(format.pageSelectionState(selection, page), 'some');
	assert.deepEqual(format.selectionItems(selection, 'delete'), [{ kind: 'audio', id: 'b' }, { kind: 'scan', id: 's' }]);
	selection = format.togglePageSelection(selection, page);
	assert.equal(format.pageSelectionState(selection, page), 'all');
	selection = format.togglePageSelection(selection, page);
	assert.equal(selection.ids.size, 0);

	// All results: the filter's total and estimate; unticking a row keeps this page.
	selection = format.selectAllResults(1500, 10 * 1024 ** 2);
	assert.ok(format.isRowSelected(selection, page[3]));
	summary = format.selectionSummary(selection);
	assert.deepEqual([summary.tooLarge, summary.canDownload, summary.tooMany, summary.canDelete], [true, false, false, true]);
	assert.deepEqual(format.selectionSummary(format.selectAllResults(2001, 0)).tooMany, true);
	assert.equal(format.selectionSummary(format.selectAllResults(900, 5 * 1024 ** 3)).tooLarge, true, 'the 4 GiB estimate');
	assert.equal(format.selectionSummary(format.selectAllResults(1000, format.EXPORT_MAX_BYTES)).canDownload, true);
	const kept = format.toggleRowSelection(selection, page[0], page);
	assert.equal(kept.mode, 'ids');
	assert.deepEqual([...kept.ids.keys()], ['audio:b', 'scan:s']);
	assert.equal(format.togglePageSelection(selection, page).ids.size, 0, 'the page box clears all results');

	// Estimate-based cap from explicit ids.
	const big = format.togglePageSelection(format.emptySelection(), [row('x', { estimatedBytes: format.EXPORT_MAX_BYTES + 1 })]);
	assert.equal(format.selectionSummary(big).tooLarge, true);
	// Only downloadable items count toward the export; only deletable ones toward delete.
	const mixed = format.togglePageSelection(format.emptySelection(), [row('f', { downloadable: false })]);
	assert.deepEqual([format.selectionSummary(mixed).canDownload, format.selectionSummary(mixed).canDelete], [false, true]);
	assert.equal(format.rowSelectable({ downloadable: false, deletable: false }), false);
});

// ── Filters ─────────────────────────────────────────────────────────────────

test('filters serialise without empty fields, in Hz, and VFO/mode/bandwidth leave scans out', () => {
	const filters = { ...format.emptyFilters(), minMHz: '145.5', maxMHz: ' ', status: 'complete', q: '  433  ' };
	assert.deepEqual(format.filterFields(filters), { status: 'complete', min_frequency_hz: 145_500_000, q: '433' });
	assert.deepEqual(format.filterFields({ ...format.emptyFilters(), vfo: '1', mode: 'NFM', bandwidth: '12500' }),
		{ type: 'audio', vfo_index: 1, mode: 'nfm', bandwidth_hz: 12500 });
	assert.deepEqual(format.filterFields({ ...format.emptyFilters(), type: 'scan', vfo: '1', mode: 'nfm' }), { type: 'scan' });
	assert.deepEqual(format.filterFields({ ...format.emptyFilters(), minMHz: '500', maxMHz: '100' }), {}, 'min above max is left out');
	assert.deepEqual(format.frequencyFieldErrors({ ...format.emptyFilters(), minMHz: '500', maxMHz: '100' }), { min: true, max: true });
	assert.equal(format.parseMHzField('-1'), null);
	assert.equal(format.parseMHzField('abc'), null);
	assert.equal(format.parseMHzField(''), undefined);
	assert.equal(format.activeFilterCount({ ...format.emptyFilters(), type: 'scan', vfo: '1', q: 'x' }, 'day'), 2);

	const params = format.itemsQuery(filters, { kind: 'range', fromMs: 10, toMs: 20 }, { sort: 'size', order: 'asc', offset: 100, limit: 50 });
	assert.equal(params.toString(), 'from_ms=10&to_ms=20&status=complete&min_frequency_hz=145500000&q=433&sort=size&order=asc&offset=100&limit=50');
	const all = format.itemsQuery(format.emptyFilters(), { kind: 'all' }, { sort: 'start', order: 'desc', offset: 0, limit: 50 });
	assert.equal(all.toString(), 'sort=start&order=desc&offset=0&limit=50');
	assert.deepEqual(format.filterBody(filters, { kind: 'windows', windows: [[1, 2], [3, 4]] }),
		{ status: 'complete', min_frequency_hz: 145_500_000, q: '433', windows: [[1, 2], [3, 4]] });
	const timeline = format.timelineQuery({ ...format.emptyFilters(), type: 'audio' }, { startMs: 0, endMs: 86_400_000 });
	assert.equal(timeline.toString(), 'from_ms=0&to_ms=86400000&type=audio');
});

test('the time part: Day (or its selection), Range windows per day with a midnight wrap, All dates', () => {
	inZone('Europe/Berlin', () => {
		const empty = format.emptyFilters();
		const day = format.localDayBounds('2026-10-20');
		assert.deepEqual(format.archiveTimeSpec('day', '2026-10-20', '2026-10-20', null, empty).query, { kind: 'range', fromMs: day.startMs, toMs: day.endMs });
		const picked = { startMs: day.startMs + HOUR, endMs: day.startMs + 2 * HOUR };
		assert.deepEqual(format.archiveTimeSpec('day', '2026-10-20', '2026-10-20', picked, empty).query, { kind: 'range', fromMs: picked.startMs, toMs: picked.endMs });
		const range = format.archiveTimeSpec('range', '2026-10-01', '2026-10-31', null, empty);
		assert.deepEqual(range, { query: { kind: 'range', fromMs: new Date(2026, 9, 1).getTime(), toMs: new Date(2026, 10, 1).getTime() }, timeOfDay: 'off' });

		const night = format.archiveTimeSpec('range', '2026-10-24', '2026-10-26', null, { ...empty, timeFrom: '22:00', timeTo: '04:00' });
		assert.equal(night.timeOfDay, 'on');
		assert.equal(night.query.windows.length, 3);
		// One window per day, To before From wrapping into the next day; the night into
		// 25 October gains the hour the clocks go back.
		assert.deepEqual(night.query.windows.map(([start, end]) => (end - start) / HOUR), [7, 6, 6]);
		assert.deepEqual(night.query.windows.map(([start, end]) => [clock(start), clock(end)]), [['22:00', '04:00'], ['22:00', '04:00'], ['22:00', '04:00']]);
		const windows = night.query.windows;
		assert.ok(windows.every((window, index) => index === 0 || window[0] >= windows[index - 1][1]), 'increasing and non-overlapping');
		const params = format.itemsQuery(empty, night.query, { sort: 'start', order: 'desc', offset: 0, limit: 50 });
		assert.match(params.get('windows'), /^\d+-\d+,\d+-\d+,\d+-\d+$/);
		assert.equal(params.get('from_ms'), null);

		const afternoon = format.archiveTimeSpec('range', '2026-10-20', '2026-10-21', null, { ...empty, timeFrom: '13:00' });
		assert.deepEqual(afternoon.query.windows.map(([start, end]) => [clock(start), clock(end)]), [['13:00', '00:00'], ['13:00', '00:00']]);
		const tooMany = format.archiveTimeSpec('range', '2026-01-01', '2026-03-05', null, { ...empty, timeFrom: '08:00', timeTo: '09:00' });
		assert.equal(tooMany.timeOfDay, 'too-many');
		assert.equal(tooMany.query.kind, 'range', 'above 62 days the fields are left out');
		assert.equal(format.archiveTimeSpec('range', '2026-01-01', '2026-03-03', null, { ...empty, timeFrom: '08:00' }).query.windows.length, 62);
		assert.equal(format.archiveTimeSpec('range', '2026-10-20', '2026-10-20', null, { ...empty, timeFrom: '08:00', timeTo: '08:00' }).timeOfDay, 'invalid');
		assert.deepEqual(format.archiveTimeSpec('all', '2026-10-20', '2026-10-20', null, { ...empty, timeFrom: '08:00' }), { query: { kind: 'all' }, timeOfDay: 'disabled' });
	});
});

test('table rows: labels prepared once, status codes, download links only when downloadable', () => {
	inZone('UTC', () => {
		const day = format.localDayBounds('2026-10-20');
		const context = {
			t: text => translateReceiver('id', text),
			tm: text => translateReceiverMessage('id', text),
			sourceLabel: source => `src:${source}`,
			locale: 'en-GB',
			mode: 'day',
			dayStartMs: day.startMs,
			dayEndMs: day.endMs,
			downloadUrl: (kind, id) => `/dl/${kind}/${id}`,
		};
		const base = {
			id: 'a1', session_id: null, start: '', end: null, start_ms: day.startMs - 10 * 60_000, end_ms: day.startMs + 5 * 60_000,
			duration_s: 900, bytes: 2048, estimated_bytes: 3072, status: 'complete', error: '', playable: true, previewable: true,
			downloadable: true, deletable: true, vfo_index: 0, frequency_hz: 145_500_000, mode: 'nfm', bandwidth_hz: 12_500, codec: 'audio/webm',
			source: null, start_hz: null, end_hz: null, fft_size: null, trace_count: null, candidate_count: null, trace_upload_failures: null,
		};
		const audio = format.buildArchiveRow({ ...base, kind: 'audio' }, context);
		assert.equal(audio.typeLabel, 'VFO 1');
		assert.equal(audio.startDate, '19 Oct', 'a start on the day before shows its date');
		assert.equal(audio.startTime, '23:50:00');
		assert.equal(audio.endDate, '');
		assert.equal(audio.frequencyLabel, '145.500000 MHz');
		assert.equal(audio.modeLabel, 'NFM · 12.5 kHz');
		assert.equal(audio.durationLabel, '0:15:00');
		assert.equal(audio.sizeLabel, '2.0 KiB');
		assert.equal(audio.statusCode, 'COMPLETE');
		assert.equal(audio.downloadUrl, '/dl/audio/a1');
		assert.ok(Object.isFrozen(audio));
		const recording = format.buildArchiveRow({ ...base, kind: 'audio', status: 'recording', end_ms: null, downloadable: false, deletable: false, playable: false }, context);
		assert.deepEqual([recording.statusCode, recording.downloadUrl, recording.selectable, recording.phoneEnd, recording.live], ['REC', '', false, '', true]);
		const scan = format.buildArchiveRow({ ...base, kind: 'scan', status: 'running', source: 'simulated', start_hz: 100e6, end_hz: 200e6, fft_size: 4096, trace_upload_failures: 3, error: 'Receiver storage error.' }, context);
		assert.deepEqual([scan.typeLabel, scan.sourceLabel, scan.simulated, scan.statusCode, scan.modeLabel], ['Pindai', 'src:simulated', true, 'SCANNING', '4.88 kHz']);
		assert.equal(scan.notSavedLabel, '3 tidak tersimpan');
		assert.equal(scan.sizeLabel, '—', 'a running scan is counted when it finishes, so it shows no size yet');
		assert.equal(format.buildArchiveRow({ ...base, kind: 'scan', bytes: 0, start_hz: 1e8, end_hz: 2e8 }, context).sizeLabel, '0 B');
		assert.equal(scan.statusTitle, 'Galat penyimpanan Receiver.');
		const ranged = format.buildArchiveRow({ ...base, kind: 'audio', start_ms: day.startMs + HOUR }, { ...context, mode: 'range' });
		assert.equal(ranged.startDate, '20 Oct 2026', 'Range and All dates always show the date');
		assert.equal(format.statusCode('interrupted'), 'INTERRUPTED');
	});
});

test('the scan preview trace is drawn from the Max and Average series', () => {
	const plot = format.tracePlot([-40, -30, -60], [-50, -45, -70]);
	assert.deepEqual([plot.topDb, plot.bottomDb], [-30, -70]);
	assert.equal(plot.maxPoints, '0,25.00 1,0.00 2,75.00');
	assert.equal(plot.meanPoints.split(' ').length, 3);
	assert.equal(format.tracePlot([], []), null);
});

// ── Client ──────────────────────────────────────────────────────────────────

const item = {
	kind: 'audio', id: 'c0ffee00-0000-4000-8000-000000000001', session_id: null, start: '2026-10-20T01:00:00.000Z', end: null,
	start_ms: 1, end_ms: null, duration_s: null, bytes: 0, estimated_bytes: 1024, status: 'recording', error: '',
	playable: false, previewable: false, downloadable: false, deletable: false, vfo_index: 0, frequency_hz: 1e8, mode: 'nfm',
	bandwidth_hz: 12500, codec: 'audio/webm', source: null, start_hz: null, end_hz: null, fft_size: null, trace_count: null,
	candidate_count: null, trace_upload_failures: null,
};

test('answer parsers accept the contract and refuse wrong types or missing fields', () => {
	const facets = {
		vfo_indices: [0, 1], modes: ['nfm'], bandwidths_hz: [12500], sources: ['native'], statuses: ['complete'],
		min_frequency_hz: 1e8, max_frequency_hz: null, totals: { audio: 2, scan: 1, bytes: 10 }, first_ms: 1, last_ms: null, free_bytes: null, now_ms: 5,
	};
	assert.deepEqual(api.parseArchiveFacets(facets).totals, { audio: 2, scan: 1, bytes: 10 });
	assert.throws(() => api.parseArchiveFacets({ ...facets, modes: 'nfm' }), TypeError);
	assert.throws(() => api.parseArchiveFacets({ ...facets, totals: undefined }), TypeError);

	const calendar = { days: [{ audio: 1, scan: 0 }, { audio: 0, scan: 2 }], first_ms: null, last_ms: null, now_ms: 3, truncated: false };
	assert.equal(api.parseArchiveCalendar(calendar, 2).days.length, 2);
	assert.throws(() => api.parseArchiveCalendar(calendar, 42), TypeError);
	assert.throws(() => api.parseArchiveCalendar({ ...calendar, truncated: 'no' }), TypeError);

	const timeline = { from_ms: 0, to_ms: 10, now_ms: 5, audio: [[0, 2]], scan: [], counts: { audio: 1, scan: 0 }, truncated: false };
	assert.deepEqual(api.parseArchiveTimeline(timeline).audio, [[0, 2]]);
	assert.throws(() => api.parseArchiveTimeline({ ...timeline, audio: [[3, 1]] }), TypeError);
	assert.throws(() => api.parseArchiveTimeline({ ...timeline, scan: [[1]] }), TypeError);

	const page = { items: [item], total: 1, totals: { audio: 1, scan: 0, bytes: 0, estimated_bytes: 1024 }, offset: 0, limit: 50, now_ms: 9 };
	const parsed = api.parseArchiveItems(page);
	assert.equal(parsed.items[0].status, 'recording');
	assert.ok(Object.isFrozen(parsed.items[0]));
	assert.throws(() => api.parseArchiveItems({ ...page, items: [{ ...item, kind: 'video' }] }), TypeError);
	assert.throws(() => api.parseArchiveItems({ ...page, items: [{ ...item, downloadable: 1 }] }), TypeError);
	assert.throws(() => api.parseArchiveItems({ ...page, total: -1 }), TypeError);
	const { error: _error, ...withoutError } = item;
	assert.throws(() => api.parseArchiveItem(withoutError), TypeError);

	const preview = { id: 's', start_hz: 1, end_hz: 2, bins: 512, trace_format: 1, trace_count: 3, traces_used: 3, traces_skipped: 0, max_db: [1, 2], mean_db: [0, 1], candidates: [{ frequency_hz: 1, peak_db: null, snr_db: 3, bandwidth_hz: null }] };
	assert.equal(api.parseArchiveScanPreview(preview).candidates[0].peak_db, null);
	assert.throws(() => api.parseArchiveScanPreview({ ...preview, mean_db: [1] }), TypeError);
	assert.equal(api.parseArchiveScanPreview({ ...preview, max_db: [], mean_db: [], trace_format: 2 }).max_db.length, 0);

	const token = 'A'.repeat(31) + '_';
	const prepared = { export_id: token, url: `/api/receiver/archive/exports/${token}`, filename: 'receiver-records_x.zip', count: { audio: 1, scan: 2 }, missing: 0, estimated_bytes: 5, expires_in_s: 120 };
	assert.equal(api.parseArchiveExport(prepared).url, prepared.url);
	assert.throws(() => api.parseArchiveExport({ ...prepared, url: `https://example.invalid/${token}` }), TypeError);
	assert.throws(() => api.parseArchiveExport({ ...prepared, export_id: 'short', url: '/api/receiver/archive/exports/short' }), TypeError);

	const deleted = { deleted: { audio: 1, scan: 1 }, deleted_scan_ids: ['s1'], sessions: 1, bytes: 9, skipped: [{ kind: 'scan', id: 's2', code: 'ARCHIVE_ITEM_ACTIVE', error: 'Stop the recording or scan before deleting it.' }], skipped_count: 1 };
	assert.deepEqual(api.parseArchiveDelete(deleted).deleted_scan_ids, ['s1']);
	assert.throws(() => api.parseArchiveDelete({ ...deleted, deleted_scan_ids: [1] }), TypeError);

	assert.equal(api.parseRetentionPreview({ days: 7, cutoff_ms: 1, audio: 2, sessions: 1, scans: 0, bytes: 3 }).audio, 2);
	assert.throws(() => api.parseRetentionPreview({ days: 7, cutoff_ms: 1, audio: 2, sessions: 1, scans: 0 }), TypeError);

	const settings = { auto_spectrum_recording: true, retention_days: null, retention_options: [1, 3, 7, 14, 30, 60, 90], retention_last_run_ms: null, retention_last_removed: null, retention_running: false };
	assert.equal(api.parseArchiveSettings(settings).retention_result, undefined);
	const removed = { audio: 1, sessions: 0, scans: 2, bytes: 10, failed: 0, more: true };
	assert.equal(api.parseArchiveSettings({ ...settings, retention_days: 7, retention_result: removed }).retention_result.more, true);
	assert.throws(() => api.parseArchiveSettings({ ...settings, retention_days: 'x' }), TypeError);
	assert.throws(() => api.parseArchiveSettings({ ...settings, retention_running: undefined }), TypeError);
});

test('an error answer carries its status, code and details', async () => {
	const realFetch = globalThis.fetch;
	globalThis.window ??= globalThis;
	globalThis.fetch = async (url, init) => {
		assert.equal(init.credentials, 'same-origin');
		return new Response(JSON.stringify({ ok: false, code: 'ARCHIVE_SELECTION_CHANGED', error: 'The results changed. Check the selection and try again.', count: 7 }), { status: 409 });
	};
	try {
		await assert.rejects(api.archiveApi.deleteItems({ filter: {}, expected_count: 6 }), error => {
			assert.ok(error instanceof ReceiverRequestError);
			assert.deepEqual([error.status, error.code, error.details.count], [409, 'ARCHIVE_SELECTION_CHANGED', 7]);
			assert.equal(error.message, 'The results changed. Check the selection and try again.');
			return true;
		});
		const legacy = new ReceiverRequestError('x', 500);
		assert.equal(legacy.code, '');
		// An outer AbortSignal cancels the request.
		globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
			init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
		});
		const controller = new AbortController();
		const pending = api.archiveApi.facets(controller.signal);
		controller.abort();
		await assert.rejects(pending, error => error.name === 'AbortError');
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('download URLs encode the id and carry the browser zone; export links stay on the console', () => {
	assert.equal(api.audioDownloadUrl('a/b c', 'Asia/Jakarta', 420), '/api/receiver/archive/audio/a%2Fb%20c/download?time_zone=Asia%2FJakarta&utc_offset_minutes=420');
	assert.equal(api.scanDownloadUrl('s1', 'UTC', 0), '/api/receiver/archive/scans/s1/download?time_zone=UTC&utc_offset_minutes=0');
	assert.equal(api.downloadUrl('scan', 's1', 'UTC', -300), '/api/receiver/archive/scans/s1/download?time_zone=UTC&utc_offset_minutes=-300');
	assert.equal(api.audioPlaybackUrl('a1'), '/api/receiver/audio-segments/a1/audio');
	const token = 'b'.repeat(32);
	assert.equal(api.exportDownloadUrl(`/api/receiver/archive/exports/${token}`), `/api/receiver/archive/exports/${token}`);
	assert.throws(() => api.exportDownloadUrl('//evil.example/api/receiver/archive/exports/x'), TypeError);
	assert.throws(() => api.exportDownloadUrl(`/api/receiver/archive/exports/${token}/../../x`), TypeError);
	assert.ok(api.EXPORT_URL_PREFIX.startsWith(api.ARCHIVE_API_ROOT));
});

// ── Contract with tools/receiver_archive.py ─────────────────────────────────

const archiveModule = new URL('./receiver_archive.py', import.meta.url);

test('error codes, retention options and size estimates match the console', { skip: !existsSync(archiveModule) && 'tools/receiver_archive.py is not in this checkout' }, () => {
	const output = execFileSync(process.env.PYTHON || 'python3', ['-c', [
		'import json, sys',
		`sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL('./', import.meta.url)))})`,
		'import receiver_archive as archive',
		'print(json.dumps({',
		'  "codes": list(archive.ARCHIVE_ERROR_CODES),',
		'  "messages": getattr(archive, "ARCHIVE_ERROR_MESSAGES", None),',
		'  "retention": list(archive.RETENTION_DAY_OPTIONS),',
		'  "estimate": {name: getattr(archive, name) for name in dir(archive) if name.startswith("ESTIMATE_")},',
		'  "export": [archive.EXPORT_MAX_ITEMS, archive.EXPORT_MAX_BYTES, archive.DELETE_MAX_ITEMS],',
		'}))',
	].join('\n')], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
	const server = JSON.parse(output);
	assert.deepEqual(Object.keys(format.ARCHIVE_ERROR_TEXT).sort(), [...server.codes].sort());
	for (const code of server.codes) {
		const text = format.ARCHIVE_ERROR_TEXT[code];
		assert.notEqual(translateReceiverMessage('id', text), text, `${code} has no Indonesian text`);
	}
	if (server.messages) assert.deepEqual(format.ARCHIVE_ERROR_TEXT, server.messages);
	assert.deepEqual([...format.RETENTION_DAY_OPTIONS], server.retention);
	for (const days of server.retention) {
		const key = format.RETENTION_LABEL_KEYS[days];
		assert.ok(key, `no label for ${days} days`);
		assert.notEqual(translateReceiver('id', key), key, `${key} has no Indonesian text`);
	}
	const client = Object.fromEntries(Object.entries(format).filter(([name]) => name.startsWith('ESTIMATE_')));
	assert.deepEqual(client, server.estimate);
	assert.deepEqual([format.EXPORT_MAX_ITEMS, format.EXPORT_MAX_BYTES, format.DELETE_MAX_ITEMS], server.export);
});

test('every error text and retention label has Indonesian text', () => {
	for (const [code, text] of Object.entries(format.ARCHIVE_ERROR_TEXT)) {
		assert.notEqual(translateReceiverMessage('id', text), text, code);
	}
	for (const key of Object.values(format.RETENTION_LABEL_KEYS)) assert.notEqual(translateReceiver('id', key), key);
	assert.equal(translateReceiverMessage('id', 'Could not load Records: Check the filter values.'), 'Rekaman tidak bisa dimuat: Periksa nilai filter.');
});

test('Records refreshes when shown again after another console page, and a tab switch refreshes only through active', async () => {
	globalThis.window ??= globalThis;
	const { ReceiverArchive } = await import(new URL('records-archive.ts', appDir).href);
	const calls = [];
	const vm = {
		_shown: true, _hiddenWhileActive: false, _started: true, active: true, confirm: null,
		refreshAll() { calls.push('refresh'); },
		scheduleLiveRefresh() { calls.push('live'); },
		pauseAudio() { calls.push('pause'); },
		cancelConfirm() {},
		clearTimer() {},
	};
	const shown = ReceiverArchive.methods.onShownChange;
	// The console route changed: the frame hid while Records was the open tab.
	shown.call(vm, false);
	shown.call(vm, true);
	assert.deepEqual(calls, ['pause', 'refresh']);
	calls.length = 0;
	// A Receiver tab switch: active was already false when it hid, and the active watcher refreshes.
	vm.active = false;
	shown.call(vm, false);
	vm.active = true;
	shown.call(vm, true);
	assert.deepEqual(calls, ['pause', 'live']);
});
