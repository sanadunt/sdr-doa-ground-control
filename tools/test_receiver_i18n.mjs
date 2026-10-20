// Every Receiver chrome string passed to t(), and every operator message, has an Indonesian translation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const source = readFileSync(new URL('./browsdr_receiver_overlay/src/client/app/i18n.ts', import.meta.url), 'utf8');
const { RECEIVER_INDONESIAN, RECEIVER_INDONESIAN_PATTERNS, i18nMethods, radioDisplayText, translateReceiver, translateReceiverMessage, receiverLanguage, receiverDateLocale } = await import(
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

test('template, builder and script strings passed to t() have Indonesian text', () => {
	const html = readFileSync(new URL('./browsdr_receiver_overlay/src/client/index.html', import.meta.url), 'utf8');
	const builder = readFileSync(new URL('./build_browsdr_receiver.py', import.meta.url), 'utf8');
	const appDir = new URL('./browsdr_receiver_overlay/src/client/app/', import.meta.url);
	const scripts = readdirSync(appDir).filter(name => name.endsWith('.ts') && name !== 'i18n.ts')
		.map(name => readFileSync(new URL(name, appDir), 'utf8')).join('\n');
	const keys = new Set([...translatedLiterals(html), ...translatedLiterals(builder), ...translatedLiterals(scripts)]);
	assert.ok(keys.size > 100, `expected the Receiver chrome to be translated, found ${keys.size} strings`);
	const missing = [...keys].filter(key => !(key in RECEIVER_INDONESIAN));
	assert.deepEqual(missing, []);
});

test('no key appears twice in RECEIVER_INDONESIAN', () => {
	// The overlay build runs vite without tsc, so a repeated key would silently override the first.
	const block = source.slice(source.indexOf('export const RECEIVER_INDONESIAN:'), source.indexOf('export const RECEIVER_INDONESIAN_PATTERNS'));
	const keys = [...block.matchAll(/^\t'((?:[^'\\]|\\.)*)':/gm)].map(match => match[1]);
	assert.ok(keys.length > 400, `expected the dictionary keys, found ${keys.length}`);
	assert.equal(keys.length, Object.keys(RECEIVER_INDONESIAN).length, 'every entry is a single-quoted key on its own line');
	assert.deepEqual(keys.filter((key, index) => keys.indexOf(key) !== index), []);
});

test('the radio is shown as RadioSpectrum, never by its upstream brand', () => {
	assert.equal(radioDisplayText('HackRF One'), 'RadioSpectrum One');
	assert.equal(radioDisplayText('Mock SDR (Signal Gen)'), 'Mock SDR (Signal Gen)');
	for (const [english, indonesian] of Object.entries(RECEIVER_INDONESIAN)) {
		assert.doesNotMatch(english, /HackRF/, english);
		assert.doesNotMatch(indonesian, /HackRF/, indonesian);
	}
	for (const [pattern, template] of RECEIVER_INDONESIAN_PATTERNS) {
		assert.doesNotMatch(pattern.source, /HackRF/, pattern.source);
		assert.doesNotMatch(template, /HackRF/, template);
	}
	// Error detail from the upstream driver is passed through, with the brand replaced.
	assert.equal(
		i18nMethods.tm.call({ uiLanguage: 'id' }, 'Sweep stopped: HackRF could not finish stopping RX: timeout'),
		'Sweep berhenti: RadioSpectrum could not finish stopping RX: timeout',
	);
	assert.equal(
		i18nMethods.tm.call({ uiLanguage: 'en' }, 'Error stopping sweep: HackRF could not finish stopping RX: timeout'),
		'Error stopping sweep: RadioSpectrum could not finish stopping RX: timeout',
	);
});

test('English is the fallback and only id switches language', () => {
	assert.equal(translateReceiver('id', 'Start scan'), 'Mulai pindai');
	assert.equal(translateReceiver('en', 'Start scan'), 'Start scan');
	assert.equal(translateReceiver('id', 'Untranslated upstream label'), 'Untranslated upstream label');
	assert.equal(receiverLanguage('id'), 'id');
	assert.equal(receiverLanguage('fr'), 'en');
	assert.equal(receiverLanguage(undefined), 'en');
});

test('literal operator messages in the overlay sources have Indonesian text', () => {
	const dir = new URL('./browsdr_receiver_overlay/src/client/app/', import.meta.url);
	const messageLine = /showMsg\(|\.notice = |\.error = |setRecordingError\(|window\.confirm\(|\btm\(/;
	const messages = [];
	for (const file of readdirSync(dir).filter(name => name.endsWith('.ts') && name !== 'i18n.ts')) {
		for (const line of readFileSync(new URL(file, dir), 'utf8').split('\n')) {
			if (!messageLine.test(line)) continue;
			for (const literal of line.matchAll(/'((?:[^'\\]|\\.){6,})'/g)) {
				if (/^[A-Z]/.test(literal[1]) && / /.test(literal[1].trim())) messages.push(literal[1]);
			}
		}
	}
	assert.ok(messages.length > 40, `expected operator messages in the overlay, found ${messages.length}`);
	const missing = messages.filter(message => translateReceiverMessage('id', message) === message);
	assert.deepEqual(missing, []);
});

test('audio segment errors written by the console have Indonesian text', () => {
	const output = execFileSync(process.env.PYTHON || 'python3', ['-c', [
		'import json, sys',
		`sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL('./', import.meta.url)))})`,
		'import receiver_record_store as store',
		'print(json.dumps(list(store.AUDIO_SEGMENT_ERROR_MESSAGES)))',
	].join('\n')], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
	const messages = JSON.parse(output).map(message => message.replace('{}', '[Errno 13] Permission denied'));
	assert.ok(messages.length >= 6, `expected the console's segment errors, found ${messages.length}`);
	const missing = messages.filter(message => translateReceiverMessage('id', message) === message);
	assert.deepEqual(missing, []);
	assert.equal(
		translateReceiverMessage('id', 'Recording was interrupted and its audio could not be recovered: [Errno 13] Permission denied'),
		'Perekaman terputus dan audionya tidak bisa dipulihkan: [Errno 13] Permission denied',
	);
});

test('run-time messages are translated, including known errors inside them', () => {
	const cases = [
		['The radio stopped sending samples (USB transfer status stall). RX stopped. Check the USB cable, then press Resume or reconnect the radio.',
			'Radio berhenti mengirim sampel (USB transfer status stall). RX berhenti. Periksa kabel USB, lalu tekan Lanjutkan atau sambungkan ulang radio.'],
		['Loaded "Airport": 1 VFO loaded.', '"Airport" dimuat: 1 VFO dimuat.'],
		['Loaded "Airport": 3 VFOs loaded.', '"Airport" dimuat: 3 VFO dimuat.'],
		['Includes 2 of 3 VFOs (VFO 3 outside bandwidth)', 'Mencakup 2 dari 3 VFO (VFO 3 di luar bandwidth)'],
		['Only VFO 2 in bandwidth', 'Hanya VFO 2 dalam bandwidth'],
		['Could not start audio recording: Audio recording requires an available AudioContext.',
			'Rekaman audio tidak bisa dimulai: Rekaman audio membutuhkan AudioContext yang tersedia.'],
		['Could not export candidate history: Candidate history stopped at row 200 of 450.',
			'Riwayat kandidat tidak bisa diekspor: Riwayat kandidat berhenti pada baris 200 dari 450.'],
		['Scan archive is saving again; 1 sweep trace of this scan was not saved.',
			'Arsip pindai menyimpan lagi; 1 trace sweep dari pindai ini tidak tersimpan.'],
		['VFO audio recording stopped because the sample rate or FFT size changed. Saved audio is in Records.',
			'Rekaman audio VFO berhenti karena sample rate atau ukuran FFT berubah. Audio yang tersimpan ada di Rekaman.'],
		['3 records deleted.', '3 rekaman dihapus.'],
		['1 record was not deleted.', '1 rekaman tidak dihapus.'],
		['Retention removed 34 records (1.2 GiB).', 'Retensi menghapus 34 rekaman (1.2 GiB).'],
		['2 not removed', '2 tidak terhapus'],
		['Could not prepare the ZIP: The selection is too large for one ZIP.', 'ZIP tidak bisa disiapkan: Pilihan terlalu besar untuk satu ZIP.'],
		['Could not delete records: Stop the recording or scan before deleting it.', 'Rekaman tidak bisa dihapus: Hentikan rekaman atau pindai sebelum menghapusnya.'],
	];
	for (const [english, indonesian] of cases) {
		assert.equal(translateReceiverMessage('id', english), indonesian);
		assert.equal(translateReceiverMessage('en', english), english);
	}
	assert.equal(translateReceiverMessage('id', 'Could not save sweep session: HTTP 507'), 'Sesi sweep tidak bisa disimpan: HTTP 507');
	assert.equal(translateReceiverMessage('id', 'Unknown upstream failure'), 'Unknown upstream failure');
	assert.equal(translateReceiverMessage('id', ''), '');
});

test('bookmark categories and calendar days have Indonesian text; status codes stay English', () => {
	const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	assert.deepEqual(weekdays.filter(key => !(key in RECEIVER_INDONESIAN)), []);
	for (const code of ['SIMULATION', 'SCANNING', 'STOPPED', 'COMPLETE', 'PARTIAL', 'INTERRUPTED', 'FAILED', 'MOCK', 'REC', 'stopped', 'complete']) {
		assert.equal(translateReceiver('id', code), code);
	}
	assert.equal(receiverDateLocale('id'), 'id-ID');
	assert.equal(receiverDateLocale('en'), undefined);
	const constants = new URL('../vendor/BrowSDR/src/client/app/constants.ts', import.meta.url);
	if (!existsSync(constants)) return;
	const block = readFileSync(constants, 'utf8').match(/BOOKMARK_CATEGORIES[^=]*=\s*\[([\s\S]*?)\];/);
	assert.ok(block, 'BOOKMARK_CATEGORIES not found in the BrowSDR source');
	const labels = [...block[1].matchAll(/label:\s*'([^']+)'/g)].map(match => match[1]);
	assert.ok(labels.length > 5);
	assert.deepEqual(labels.filter(label => !(label in RECEIVER_INDONESIAN)), []);
});
