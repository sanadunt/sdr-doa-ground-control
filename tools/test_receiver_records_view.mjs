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
