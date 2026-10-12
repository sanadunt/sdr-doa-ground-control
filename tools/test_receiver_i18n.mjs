// Every Receiver chrome string passed to t() has an Indonesian translation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('./browsdr_receiver_overlay/src/client/app/i18n.ts', import.meta.url), 'utf8');
const { RECEIVER_INDONESIAN, translateReceiver, receiverLanguage } = await import(
	`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64')}`
);

function translatedLiterals(text) {
	const keys = new Set();
	for (const call of text.matchAll(/\bt\(((?:[^()]|\([^()]*\))*)\)/g)) {
		for (const literal of call[1].matchAll(/(===\s*)?\\?'((?:[^'\\]|\\.)*?)\\?'/g)) {
			if (!literal[1]) keys.add(literal[2]);
		}
	}
	return keys;
}

test('template and builder strings passed to t() have Indonesian text', () => {
	const html = readFileSync(new URL('./browsdr_receiver_overlay/src/client/index.html', import.meta.url), 'utf8');
	const builder = readFileSync(new URL('./build_browsdr_receiver.py', import.meta.url), 'utf8');
	const keys = new Set([...translatedLiterals(html), ...translatedLiterals(builder)]);
	assert.ok(keys.size > 100, `expected the Receiver chrome to be translated, found ${keys.size} strings`);
	const missing = [...keys].filter(key => !(key in RECEIVER_INDONESIAN));
	assert.deepEqual(missing, []);
});

test('English is the fallback and only id switches language', () => {
	assert.equal(translateReceiver('id', 'Start scan'), 'Mulai pindai');
	assert.equal(translateReceiver('en', 'Start scan'), 'Start scan');
	assert.equal(translateReceiver('id', 'Untranslated upstream label'), 'Untranslated upstream label');
	assert.equal(receiverLanguage('id'), 'id');
	assert.equal(receiverLanguage('fr'), 'en');
	assert.equal(receiverLanguage(undefined), 'en');
});
