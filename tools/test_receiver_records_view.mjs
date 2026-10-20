// Records (Rekaman) view contracts in the overlay: the ReceiverArchive component and its
// template, no dialogs or navigation, downloads as same-origin <a download> links, the
// root wiring in index.html, translated scan sources, and the Records archive CSS.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const overlay = new URL('./browsdr_receiver_overlay/src/client/', import.meta.url);
const appDir = new URL('app/', overlay);
const read = name => readFileSync(new URL(name, overlay), 'utf8');
const html = read('index.html');
const records = read('app/records.ts');
const api = read('app/receiver-records-api.ts');
const component = read('app/records-archive.ts');
const archiveFiles = readdirSync(appDir).filter(name => name.startsWith('records-archive') && name.endsWith('.ts'));
const archiveSources = archiveFiles.map(name => readFileSync(new URL(name, appDir), 'utf8')).join('\n');
const { RECORDS_ARCHIVE_TEMPLATE: template } = await import(
	`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(read('app/records-archive-template.ts'), { mode: 'transform' })).toString('base64')}`
);
const { translateReceiver } = await import(
	`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(read('app/i18n.ts'), { mode: 'transform' })).toString('base64')}`
);
const recordsSection = html.slice(html.indexOf('<section id="records-workspace"'), html.indexOf('</section>', html.indexOf('<section id="records-workspace"')));

test('the archive files are the ones the spec names', () => {
	assert.deepEqual(archiveFiles.sort(), ['records-archive-api.ts', 'records-archive-format.ts', 'records-archive-template.ts', 'records-archive.ts']);
	for (const name of ['records-archive-api.ts', 'records-archive-format.ts']) {
		const source = readFileSync(new URL(name, appDir), 'utf8');
		assert.doesNotMatch(source, /from 'vue'/, `${name} must load without Vue`);
	}
});

test('one shared player that loads metadata, so the saved Duration shows before playback', () => {
	const players = [...template.matchAll(/<audio\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)].map(match => match[0]);
	assert.equal(players.length, 1);
	assert.match(players[0], /\bpreload="metadata"/);
	assert.match(players[0], /\bcontrols\b/);
	assert.doesNotMatch(recordsSection, /<audio\b/);
});

test('the template formats nothing per render and row cells read prepared fields only', () => {
	assert.doesNotMatch(template, /toLocale(?:String|DateString|TimeString)/);
	assert.doesNotMatch(template, /new Date\(/);
	const start = template.indexOf('<template v-for="row in rowsView"');
	const end = template.indexOf('</template>', template.lastIndexOf('</tr>', template.indexOf('</tbody>')));
	assert.ok(start > 0 && end > start, 'row loop not found');
	const rowBlock = template.slice(start, end);
	// Loop aliases declared inside the row block (preview details, candidates).
	const aliases = ['row', ...[...rowBlock.matchAll(/v-for="(\w+) in row\./g)].map(match => match[1])];
	const fieldPattern = new RegExp(`^(?:${aliases.join('|')})(?:\\.\\w+)+$`);
	const interpolations = [...rowBlock.matchAll(/\{\{\s*([\s\S]*?)\s*\}\}/g)].map(match => match[1]);
	assert.ok(interpolations.length > 20, `expected the row cells, found ${interpolations.length}`);
	for (const expression of interpolations) {
		const literal = /^t\('[^']*'\)$/.test(expression) || /^t\(row\.\w+ \? '[^']*' : '[^']*'\)$/.test(expression)
			|| /^t\(busy\.\w+ \? '[^']*' : '[^']*'\)$/.test(expression);
		assert.ok(fieldPattern.test(expression) || literal, `row interpolation ${expression}`);
	}
	// Every t() argument is a literal or a ternary of literals, so the i18n test sees each key.
	for (const call of template.matchAll(/\bt\(([^()]*)\)/g)) {
		const argument = call[1].trim();
		assert.match(argument, /^(?:'[^']*'|[\w.]+ === '[^']*' \? '[^']*' : (?:[\w.]+ === '[^']*' \? '[^']*' : )*'[^']*'|[\w.]+ \? '[^']*' : '[^']*')$/, `t(${argument})`);
	}
});

test('no dialogs, no navigation and no archive data in Blob URLs', () => {
	for (const source of [archiveSources, recordsSection]) {
		assert.doesNotMatch(source, /\b(?:confirm|alert|prompt)\(/);
		assert.doesNotMatch(source, /\bBlob\b|createObjectURL|window\.open|location\s*(?:\.\w+\s*)?=|location\.(?:assign|replace)\(/);
	}
	// The Spectrum marker panel keeps its confirm() for saving over a set and deleting one.
	assert.match(records, /window\.confirm\(this\.tm\(`A marker set named/);
	assert.match(records, /window\.confirm\(this\.tm\('Delete this saved marker set\?/);
	for (const name of ['loadReceiverRecords', 'deleteReceiverRecord', 'deleteAudioSegment', 'audioRecordUrl', 'openReceiverRecord']) {
		assert.doesNotMatch(records, new RegExp(`\\b${name}\\(this`), `${name} must be gone from records.ts`);
	}
	for (const name of ['listRecords', 'listAudioRecords', 'getAudioRecordFacets', 'deleteRecord', 'deleteAudioSegment', 'audioUrl']) {
		assert.doesNotMatch(api, new RegExp(`\\n\\t(?:async )?${name}\\(`), `${name} must be gone from receiver-records-api.ts`);
	}
});

test('every download control is a same-origin <a download> from the URL builders, without target', () => {
	const links = [...template.matchAll(/<a\b[^>]*>/g)].map(match => match[0]);
	assert.ok(links.length >= 2);
	for (const link of links) {
		assert.match(link, /\s:?download(?:=|\s|>)/, link);
		assert.doesNotMatch(link, /\btarget=/, link);
		assert.match(link, /:href="(?:row\.downloadUrl|readyExport\.url)"/, link);
	}
	// Row links come from records-archive-api.ts, the ZIP link from exportDownloadUrl().
	assert.match(component, /downloadUrl: \(kind: 'audio' \| 'scan', id: string\) => downloadUrl\(kind, id, timeZone, offset\)/);
	assert.match(component, /const url = exportDownloadUrl\(prepared\.url\);/);
	assert.match(component, /link\.download = prepared\.filename;/);
});

test('index.html mounts <receiver-archive> once with primitive bindings', () => {
	const tags = [...recordsSection.matchAll(/<receiver-archive\b([^>]*)><\/receiver-archive>/g)];
	assert.equal(tags.length, 1, 'kebab-case tag with an explicit closing tag');
	const bindings = Object.fromEntries([...tags[0][1].matchAll(/([:@][\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
	assert.deepEqual(Object.keys(bindings).sort(), [
		':active', ':auto-archive', ':language', ':loaded-scan-id', ':recording', ':rx-running', ':scan-busy',
		'@deleted', '@open-scan', '@update-auto-archive',
	]);
	assert.equal(bindings[':active'], "activeWorkspace === 'records'");
	assert.equal(bindings[':language'], 'uiLanguage');
	assert.equal(bindings[':auto-archive'], 'records.autoSpectrumRecording');
	assert.equal(bindings['@open-scan'], 'openArchivedSweep');
	assert.equal(bindings['@deleted'], 'onArchiveDeleted');
	assert.equal(bindings['@update-auto-archive'], 'setAutoSpectrumRecording');
	for (const [name, value] of Object.entries(bindings)) {
		if (name.startsWith(':')) assert.doesNotMatch(value, /^(?:records|sweep|audioRecording|vfos|radio)$/, `${name} passes a whole object`);
	}
	assert.match(html, /<section id="records-workspace" class="receiver-records-workspace" v-show="activeWorkspace === 'records'"/);
	assert.doesNotMatch(html.match(/<section id="records-workspace"[^>]*>/)[0], /v-if/);
	const main = read('app/main.ts');
	assert.ok(main.indexOf("app.component('receiver-archive', ReceiverArchive);") < main.indexOf("receiverApp = app.mount('#app');"), 'registered before mount');
	assert.match(records, /onArchiveDeleted\(this: AppInstance, scanIds: string\[\]\)/);
	assert.match(records, /setAutoSpectrumRecording\(this: AppInstance, enabled: boolean\)/);
});

test('every stored scan source is shown through a translated label', () => {
	const accepted = api.match(/if \(!\[([^\]]+)\]\.includes\(source\)\) throw new TypeError\('scan source is invalid\.'\);/);
	assert.ok(accepted, 'scan source allowlist not found in receiver-records-api.ts');
	const sources = [...accepted[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
	assert.deepEqual(sources.sort(), ['manual', 'native', 'receiver', 'simulated']);
	const method = component.match(/scanSourceLabel\(this: Vm, source: string\): string \{([\s\S]*?)\n\t\t\},/);
	assert.ok(method, 'scanSourceLabel not found in records-archive.ts');
	const labels = new Map([...method[1].matchAll(/case '([^']+)':\s*return this\.t\('([^']+)'\);/g)].map(match => [match[1], match[2]]));
	assert.deepEqual([...labels.keys()].sort(), sources);
	assert.equal(translateReceiver('id', labels.get('simulated')), 'Simulasi (puncak sintetis)');
	for (const [source, label] of labels) assert.notEqual(label, source, `${source} must not be shown as its stored code`);
	assert.doesNotMatch(template, /\{\{\s*row\.item\.source\s*\}\}/);
});

/** CSS rules of a stylesheet part as [selector list, declarations, inside an at-rule]. */
function rules(css) {
	const found = [];
	const pattern = /([^{}]+)\{([^{}]*)\}/g;
	for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(pattern)) {
		const selector = match[1].trim();
		if (selector.startsWith('@')) continue;
		found.push([selector.replace(/^@[^{]*\{\s*/, ''), Object.fromEntries([...match[2].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(entry => [entry[1], entry[2].trim()]))]);
	}
	return found;
}

test('the Records archive CSS: tokens only, 44 px targets, breakpoints, no inner scroll', () => {
	const style = read('style.css');
	const start = style.indexOf('/* ── Records archive');
	assert.ok(start > 0, 'Records archive section not found');
	const section = style.slice(start);
	assert.doesNotMatch(section.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(/i, 'colours come from tokens');
	for (const query of ['@media (max-width: 1279px)', '@media (max-width: 760px)', '@media (max-width: 600px)', '@media (prefers-reduced-motion: reduce)']) {
		assert.ok(section.includes(query), query);
	}
	const sectionRules = rules(section);
	const declarations = selector => {
		const merged = {};
		for (const [list, body] of sectionRules) {
			if (list.split(',').map(entry => entry.trim()).includes(selector)) Object.assign(merged, body);
		}
		return merged;
	};
	for (const selector of ['.archive-day', '.archive-segmented button', '.archive-sort', '.archive-check', '.archive-check-cell', '.archive-dismiss', '.archive-icon-btn', '.records-archive select', ".records-archive input[type='search']"]) {
		assert.equal(declarations(selector)['min-height'], '44px', `${selector} is a 44 px target`);
	}
	assert.equal(declarations('.archive-week')['grid-template-columns'], 'repeat(7, 44px)');
	assert.equal(declarations('.archive-week').gap, '3px');
	assert.equal(declarations('.archive-timeline')['touch-action'], 'pan-y');
	assert.equal(declarations('.archive-table th').position, 'sticky');
	// Stuck at the scrollport edge: the negative of the workspace's 12 px top padding,
	// so no rows show through above the header.
	assert.equal(declarations('.archive-table th').top, '-12px');
	// The workspace's own rule outside any media query (the 10 px one at 700 px and
	// below applies to the phone cards, which hide the header row).
	const workspace = /\/\* Records workspace\. \*\/\n\.receiver-records-workspace \{([^}]*)\}/.exec(style);
	assert.ok(workspace, 'the Records workspace rule');
	assert.match(workspace[1], /\bpadding: 12px;/, 'the sticky header offset follows this padding');
	// The phone cards hide the header row for sight only; its full-width row must not
	// widen the frame's scrollable area (a sideways pan at 390 px).
	assert.equal(declarations('.archive-table thead').contain, 'paint');
	for (const selector of ['.archive-tl-hour', '.archive-tl-selection', '.archive-tl-now', '.archive-trace-max']) {
		assert.equal(declarations(selector)['vector-effect'], 'non-scaling-stroke', selector);
	}
	for (const [selector, body] of sectionRules) {
		assert.ok(!('overflow' in body) && !('overflow-x' in body) && !('overflow-y' in body), `${selector} sets overflow`);
	}
	// Kept: the Listener REC button, the marker panel's empty text, banners and builder anchors.
	for (const kept of ['.audio-record-button.recording {', '.top-audio-record-button .audio-record-icon', '.records-empty', '.records-error',
		'.listener-workspace-header,\n.records-header {', '.listener-workspace-header h2,\n.records-header h2 {',
		'.listener-workspace-header p,\n.records-header p,\n.records-settings p,\n.marker-settings-heading p {',
		'\t.listener-workspace-header,\n\t.records-header,\n\t.marker-settings-heading {', '\t.listener-workspace-header,\n\t.records-header {']) {
		assert.ok(style.includes(kept), `${JSON.stringify(kept)} must stay`);
	}
	for (const removed of ['.records-kind', '.records-table', '.audio-calendar', '.audio-date-picker', '.record-actions', '.records-pagination', '.records-audio-', '.audio-record-segment', '.record-status']) {
		assert.ok(!style.includes(removed), `${removed} must be gone`);
	}
});
