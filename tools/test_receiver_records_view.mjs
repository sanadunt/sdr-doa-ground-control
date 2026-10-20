// Records view contracts in the overlay template: audio players show the saved length, and scan sources are translated.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const overlay = new URL('./browsdr_receiver_overlay/src/client/', import.meta.url);
const html = readFileSync(new URL('index.html', overlay), 'utf8');
const records = readFileSync(new URL('app/records.ts', overlay), 'utf8');
const api = readFileSync(new URL('app/receiver-records-api.ts', overlay), 'utf8');
const i18nSource = readFileSync(new URL('app/i18n.ts', overlay), 'utf8');
const { translateReceiver } = await import(
	`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(i18nSource, { mode: 'transform' })).toString('base64')}`
);

test('Records audio players load metadata so the saved Duration shows before playback', () => {
	// The console writes a WebM Duration when a segment closes; with preload="none" the
	// player never reads it and shows 0:00 / 0:00 until the operator presses play.
	const players = [...html.matchAll(/<audio\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)].map(match => match[0]);
	assert.ok(players.length >= 1, 'expected the Records audio player in the template');
	for (const player of players) {
		assert.match(player, /\bpreload="metadata"/);
		assert.match(player, /\bcontrols\b/);
	}
});

test('every stored scan source is shown through a translated label', () => {
	assert.doesNotMatch(html, /\{\{\s*record\.source\s*\}\}/);
	assert.match(html, /\{\{\s*scanSourceLabel\(record\.source\)\s*\}\}/);
	const accepted = api.match(/if \(!\[([^\]]+)\]\.includes\(source\)\) throw new TypeError\('scan source is invalid\.'\);/);
	assert.ok(accepted, 'scan source allowlist not found in receiver-records-api.ts');
	const sources = [...accepted[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
	assert.deepEqual(sources.sort(), ['manual', 'native', 'receiver', 'simulated']);
	const method = records.match(/scanSourceLabel\(this: AppInstance[^)]*\): string \{([\s\S]*?)\n\t\},/);
	assert.ok(method, 'scanSourceLabel not found in records.ts');
	const labels = new Map([...method[1].matchAll(/case '([^']+)':\s*return this\.t\('([^']+)'\);/g)].map(match => [match[1], match[2]]));
	assert.deepEqual([...labels.keys()].sort(), sources);
	assert.equal(translateReceiver('id', labels.get('simulated')), 'Simulasi (puncak sintetis)');
	for (const [source, label] of labels) {
		assert.notEqual(label, source, `${source} must not be shown as its stored code`);
	}
});

/** The declarations of the last rule in `css` whose selector list is exactly `selector`. */
function lastRule(css, selector) {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s*,\s*/g, '\\s*,\\s*');
	const matches = [...css.matchAll(new RegExp(`(?:^|\\n)\\t*${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
	assert.ok(matches.length, `no ${selector} rule`);
	return Object.fromEntries([...matches.at(-1)[1].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
}

test('Records cells and filter labels line up with the console skin', () => {
	const style = readFileSync(new URL('style.css', overlay), 'utf8');
	// Phone cards show each cell's column label on the left; the VFO audio cells have theirs too.
	const audioTable = html.match(/<table class="records-table records-audio-table">([\s\S]*?)<\/table>/)?.[1];
	assert.ok(audioTable, 'VFO audio table not found');
	const audioCells = [...audioTable.matchAll(/^\t*<td\b[^>]*>/gm)].map(match => match[0]);
	assert.equal(audioCells.length, 3);
	assert.match(audioCells[0], /:data-label="t\('Started'\)"/);
	assert.match(audioCells[1], /:data-label="t\('Audio segments'\)"/);
	assert.doesNotMatch(audioCells[2], /data-label/, 'the Delete session cell is a full-width button');
	// On a phone the segments take the card width under that label, left-aligned.
	const phone = style.slice(style.lastIndexOf('@media (max-width: 600px)'));
	assert.equal(lastRule(phone, '.records-audio-table .records-audio-segments, .records-audio-table td > .records-empty')['flex'], '1 0 100%');
	// A session's start, its first segment and Delete session share the top line.
	assert.equal(lastRule(style, '.records-audio-table td')['vertical-align'], 'top');
	assert.match(lastRule(style, '.records-audio-table td:first-child time').font, /var\(--mono\)/);
	// Filter labels: one 16 px line 4 px above the field, also for the date field's own label.
	const labels = lastRule(style, '.records-audio-filters label, .records-audio-filters .audio-filter-fieldset legend, .records-audio-filters .audio-date-picker summary');
	assert.equal(labels['line-height'], '16px');
	assert.equal(lastRule(style, '.records-audio-filters .audio-filter-fieldset label, .records-audio-filters .audio-filter-select').gap, '4px');
	assert.equal(lastRule(style, '.records-audio-filters .audio-filter-fieldset legend')['margin-bottom'], '4px');
	assert.equal(lastRule(style, '.audio-date-picker > summary')['margin-top'], '20px');
	// The date label is positioned from inside the field's 1 px border.
	assert.equal(lastRule(style, '.audio-date-picker > summary > span').bottom, 'calc(100% + 5px)');
	assert.equal(lastRule(style, '.audio-date-picker > summary strong')['font-weight'], '400', 'the date value reads like the select values');
});
