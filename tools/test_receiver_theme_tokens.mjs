// The embedded Receiver cannot read the console's CSS variables, so
// receiver-embedded-theme.css repeats the console colours under BrowSDR's
// variable names. These tests fail when the two copies drift apart.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const consoleCss = readFileSync(new URL('../frontend/src/console-design.css', import.meta.url), 'utf8');
const receiverCss = readFileSync(new URL('../frontend/src/receiver-embedded-theme.css', import.meta.url), 'utf8');
const overlayCss = readFileSync(new URL('./browsdr_receiver_overlay/src/client/style.css', import.meta.url), 'utf8');

/** Custom properties of the first rule whose selector list is exactly `selector`. */
function tokens(css, selector) {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s*,\s*/g, '\\s*,\\s*');
	const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
	assert.ok(match, `no ${selector} rule`);
	const values = new Map();
	for (const declaration of match[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
		values.set(declaration[1], declaration[2].trim().replace(/\s+/g, ' ').toLowerCase());
	}
	return values;
}

// Receiver variable -> console variable, the same in both themes.
const SHARED = {
	'--bg-dark': '--bg',
	'--bg-panel': '--surface',
	'--bg-header': '--surface-2',
	'--bg-lighter': '--surface-2',
	'--btn-bg': '--surface-2',
	'--btn-hover': '--surface-3',
	'--border': '--line-soft',
	'--border-strong': '--line',
	'--text-main': '--text',
	'--text-soft': '--muted',
	'--text-muted': '--subtle',
	'--accent': '--accent',
	'--primary-color': '--accent',
	'--accent-soft': '--accent-soft',
	'--on-accent': '--on-accent',
	'--ok': '--green',
	'--warn': '--amber',
	'--bad': '--red',
	'--info': '--blue',
	'--signal': '--signal',
};

const THEMES = [
	{
		name: 'dark',
		console: tokens(consoleCss, ':root'),
		receiver: tokens(receiverCss, ":root, :root[data-theme='dark']"),
		// Fields sit on the page background in the dark theme (page-kit --pg-field-bg).
		extra: { '--field-bg': '--bg', '--mono': '--mono' },
	},
	{
		name: 'light',
		console: tokens(consoleCss, ":root[data-theme='light']"),
		receiver: tokens(receiverCss, ":root[data-theme='light']"),
		// White fields inside white cards in the light theme.
		extra: { '--field-bg': '--surface' },
	},
];

for (const theme of THEMES) {
	test(`Receiver ${theme.name} tokens match console-design.css`, () => {
		for (const [receiverName, consoleName] of Object.entries({ ...SHARED, ...theme.extra })) {
			const expected = theme.console.get(consoleName);
			assert.ok(expected, `console-design.css ${theme.name} theme has no ${consoleName}`);
			assert.equal(theme.receiver.get(receiverName), expected, `${receiverName} must equal console ${consoleName} (${theme.name})`);
		}
	});
}

test('every token the Receiver skin reads is defined in both themes', () => {
	const used = new Set([...overlayCss.matchAll(/var\((--[\w-]+)/g)].map(match => match[1]));
	const [dark, light] = THEMES.map(theme => theme.receiver);
	// Set inline by the template, or (--text-dim) only in the GitHub-link rule the builder removes.
	const inline = /^--(?:sq-color|chip-color|act-color|marker-connector-height|text-dim)$/;
	const missing = [...used].filter(name => !dark.has(name) && !inline.test(name));
	assert.deepEqual(missing, [], 'tokens read by style.css but not defined by receiver-embedded-theme.css');
	const darkOnly = [...dark.keys()].filter(name => !light.has(name) && !['--mono', '--sans'].includes(name));
	assert.deepEqual(darkOnly, [], 'colour tokens without a light value');
});

test('the dashboard marker colour is the Receiver marker colour in both themes', () => {
	const renderer = readFileSync(new URL('./browsdr_receiver_overlay/src/client/app/sweep-marker-renderer.ts', import.meta.url), 'utf8');
	const builder = readFileSync(new URL('./build_browsdr_receiver.py', import.meta.url), 'utf8');
	const dark = renderer.match(/context\.strokeStyle = '(#[0-9a-f]{6})';/i)?.[1];
	const light = builder.match(/context\.strokeStyle = lightTheme \? '(#[0-9a-f]{6})' : '#ff75a0';/i)?.[1];
	assert.equal(dark, '#ff75a0');
	assert.equal(light, '#a23557');
	assert.equal(THEMES[0].console.get('--marker'), dark);
	assert.equal(THEMES[1].console.get('--marker'), light);
});
