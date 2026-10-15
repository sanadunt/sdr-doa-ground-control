import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Card,
  DataTable,
  EmptyState,
  FileButton,
  FormField,
  FormGrid,
  KeyValueGrid,
  Notice,
  Page,
  PageGrid,
  PageHeader,
  PageReadAgeContext,
  PageStack,
  Segmented,
  StatRow,
  StatTile,
  StatusChip,
  Switch,
  Tag,
  Toolbar,
} from './index';

const html = renderToStaticMarkup;

describe('page layout', () => {
  it('wraps a page in the page root, grid and stacks with span classes', () => {
    const markup = html(
      <Page className="probe-page">
        <PageGrid>
          <PageStack span={6}><Card title="Node">a</Card><Card title="Data Out" span={6}>b</Card></PageStack>
          <Card title="Gate" span={5}>c</Card>
          <Card title="All">d</Card>
        </PageGrid>
      </Page>,
    );
    expect(markup).toMatch(/^<div class="page pg probe-page"><div class="pg-grid"><div class="pg-stack pg-span-6">/);
    expect(markup).toContain('<section class="pg-card pg-span-5"');
    expect(markup).toContain('<section class="pg-card pg-span-12"');
    expect(html(<Toolbar label="Zoom"><button type="button">+</button></Toolbar>)).toBe('<div class="pg-toolbar" role="group" aria-label="Zoom"><button type="button">+</button></div>');
  });
});

describe('PageHeader', () => {
  it('renders the route-focus H1, chips and actions', () => {
    const markup = html(<PageHeader title="Kesehatan Sistem" readAge="Dibaca 2 dtk lalu" chips={<StatusChip code="VALID" />} actions={<button className="ov-button" type="button">Muat ulang</button>} />);
    expect(markup).toBe(
      '<header class="pg-bar"><div class="pg-bar-heading"><h1 class="pg-bar-title" data-route-focus="true" tabindex="-1">Kesehatan Sistem</h1><span class="pg-bar-read">Dibaca 2 dtk lalu</span></div>'
      + '<div class="pg-bar-chips"><span class="ov-chip tone-good">VALID</span></div><span class="pg-bar-spacer" aria-hidden="true"></span>'
      + '<div class="pg-bar-actions"><button class="ov-button" type="button">Muat ulang</button></div></header>',
    );
  });

  it('takes the read age from the shell and marks a header with nothing but the title as bare', () => {
    const markup = html(<PageReadAgeContext.Provider value="Read 3 s ago"><PageHeader title="Simulation" /></PageReadAgeContext.Provider>);
    expect(markup).toContain('<header class="pg-bar is-bare">');
    expect(markup).toContain('<span class="pg-bar-read">Read 3 s ago</span>');
    expect(html(<PageHeader title="Simulation" />)).not.toContain('pg-bar-read');
    expect(html(<PageHeader title="Configuration"><nav>index</nav></PageHeader>)).toContain('<div class="pg-bar-row"><nav>index</nav></div>');
  });
});

describe('Card', () => {
  it('has one title in a 44 px head, an optional chip and actions, and a body', () => {
    const markup = html(<Card title="Data Out" chip={<StatusChip code="AVAILABLE" />} actions={<span>124 ms</span>} span={6}>body</Card>);
    const id = /aria-labelledby="([^"]+)"/.exec(markup)?.[1];
    expect(id).toBeTruthy();
    expect(markup).toContain(`<h2 id="${id}">Data Out</h2><span class="ov-chip tone-good">AVAILABLE</span><span class="pg-card-spacer" aria-hidden="true"></span><div class="pg-card-actions"><span>124 ms</span></div>`);
    expect(markup).toContain('<div class="pg-card-body">body</div>');
    expect(markup).not.toMatch(/eyebrow/);
  });

  it('drops the head without a title and the padding when flush', () => {
    const markup = html(<Card flush id="stats"><StatRow><StatTile label="DAQ" value="PASS" tone="good" /></StatRow></Card>);
    expect(markup).toMatch(/^<section id="stats" class="pg-card pg-span-12"><div class="pg-card-body is-flush">/);
    expect(markup).not.toContain('pg-card-head');
    expect(markup).not.toContain('aria-labelledby');
  });
});

describe('StatTile', () => {
  it('shows label, toned value, unit and a short sub value', () => {
    expect(html(<StatTile label="SNR" value="10.0" unit="dB" tone="good" sub="CSV" title="cause" />)).toBe(
      '<div class="pg-stat tone-good" title="cause"><span class="pg-stat-label">SNR</span><strong class="pg-stat-value">10.0<small class="pg-stat-unit">dB</small></strong><span class="pg-stat-sub">CSV</span></div>',
    );
    expect(html(<StatTile label="MQTT" value="OFF" />)).toBe('<div class="pg-stat"><span class="pg-stat-label">MQTT</span><strong class="pg-stat-value">OFF</strong></div>');
    expect(html(<StatRow label="Summary"><span /></StatRow>)).toBe('<div class="pg-stats" role="group" aria-label="Summary"><span></span></div>');
  });
});

describe('KeyValueGrid', () => {
  it('renders label/value rows with mono values, tones and tooltips, skipping empty items', () => {
    const markup = html(<KeyValueGrid columns={3} labels="mono" items={[{ label: 'center_freq', value: '415.788 MHz' }, null, false, { label: 'DAQ', value: 'FAIL', tone: 'bad', title: 'frame_sync' }, { label: 'Host', value: 'doasdr.local', mono: false }]} />);
    expect(markup).toBe(
      '<dl class="pg-kv pg-kv-3 has-mono-labels">'
      + '<div class="pg-kv-row"><dt>center_freq</dt><dd class="is-mono">415.788 MHz</dd></div>'
      + '<div class="pg-kv-row" title="frame_sync"><dt>DAQ</dt><dd class="is-mono is-bad">FAIL</dd></div>'
      + '<div class="pg-kv-row"><dt>Host</dt><dd>doasdr.local</dd></div></dl>',
    );
  });
});

describe('StatusChip and Tag', () => {
  it('derive the tone from the state code and keep codes untranslated', () => {
    expect(html(<StatusChip code="PASS" />)).toBe('<span class="ov-chip tone-good">PASS</span>');
    expect(html(<StatusChip code="STALLED" />)).toBe('<span class="ov-chip tone-bad">STALLED</span>');
    expect(html(<StatusChip code="ADJACENT_FRAMES" />)).toBe('<span class="ov-chip tone-warn">ADJACENT_FRAMES</span>');
    expect(html(<StatusChip code="BLOCKED" tone="warn" title="GROUND_CLOCK_UNVERIFIED" />)).toBe('<span class="ov-chip tone-warn" title="GROUND_CLOCK_UNVERIFIED">BLOCKED</span>');
  });

  it('put a micro-label before the pill for the page bar', () => {
    expect(html(<StatusChip label="HTTP" code="AVAILABLE" title="4/4" />)).toBe('<span class="pg-chip" title="4/4"><span class="pg-chip-label">HTTP</span><span class="ov-chip tone-good">AVAILABLE</span></span>');
    expect(html(<Tag>SYNTHETIC</Tag>)).toBe('<span class="ov-tag tone-neutral">SYNTHETIC</span>');
    expect(html(<Tag tone="signal">MANUAL</Tag>)).toBe('<span class="ov-tag tone-signal">MANUAL</span>');
  });
});

describe('DataTable', () => {
  const columns = [
    { key: 'path', label: 'Resource', code: true },
    { key: 'ms', label: 'ms', numeric: true, width: '80px' },
    { key: 'state', label: 'HTTP', render: (row: { state: string }) => <StatusChip code={row.state} /> },
  ];
  const rows = [{ path: '/status.json', ms: 12, state: 'AVAILABLE' }, { path: '/doa.xml', ms: 1234, state: 'FAIL' }];

  it('renders a sticky-header table with numeric and code cells and stacking labels', () => {
    const markup = html(<DataTable columns={columns} rows={rows} rowKey={(row) => row.path} label="Data Out" maxHeight="320px" />);
    expect(markup).toMatch(/^<div class="pg-table-wrap" style="--pg-table-max:320px" role="region" aria-label="Data Out" tabindex="0"><table class="pg-table is-stack">/);
    expect(markup).toContain('<th scope="col" class="is-num" style="width:80px">ms</th>');
    expect(markup).toContain('<td data-label="Resource" class="is-code">/status.json</td><td data-label="ms" class="is-num">12</td><td data-label="HTTP"><span class="ov-chip tone-good">AVAILABLE</span></td>');
    expect(markup).toContain('<th scope="col">Resource</th>');
    expect(markup).toContain('<span class="ov-chip tone-bad">FAIL</span>');
  });

  it('can stay a plain table and replaces an empty table with one line', () => {
    expect(html(<DataTable columns={columns} rows={rows} stack={false} />)).toContain('<table class="pg-table">');
    expect(html(<DataTable columns={columns} rows={[]} empty="Belum ada pesan v2" />)).toBe('<div class="pg-empty" role="status"><span class="ov-chip tone-neutral">NO DATA</span><span>Belum ada pesan v2</span></div>');
    expect(html(<DataTable columns={columns} rows={[]} />)).toContain('<tbody></tbody>');
  });
});

describe('form primitives', () => {
  it('put the unit inside the field and show an error only when there is one', () => {
    const plain = html(<FormField label="Gain" unit="dB" size="xs"><input type="number" defaultValue="15" /></FormField>);
    expect(plain).toBe('<label class="pg-field is-xs"><span class="pg-field-label">Gain</span><span class="pg-control"><input type="number" value="15"/><span class="pg-unit">dB</span></span></label>');
    const failed = html(<FormField label="Port" error="1–65535" mono><input type="text" aria-describedby="hint" /></FormField>);
    const errorId = /<span class="pg-field-error" id="([^"]+)" role="alert">1–65535<\/span>/.exec(failed)?.[1];
    expect(errorId).toBeTruthy();
    expect(failed).toContain(`<span class="pg-control is-mono is-error"><input type="text" aria-describedby="hint ${errorId}" aria-invalid="true"/></span>`);
    expect(html(<FormGrid><span /></FormGrid>)).toBe('<div class="pg-form"><span></span></div>');
    expect(html(<FormGrid row><span /></FormGrid>)).toBe('<div class="pg-form-row"><span></span></div>');
  });

  it('replace the native file input text with a button and the file name', () => {
    const markup = html(<FileButton label="Pilih PNG" accept="image/png" placeholder="—" onChange={() => undefined} />);
    expect(markup).toBe('<span class="pg-file"><button class="ov-button" type="button">Pilih PNG</button><span class="pg-file-name">—</span><input class="pg-file-input" type="file" accept="image/png" tabindex="-1" aria-hidden="true"/></span>');
    expect(html(<FileButton label="Choose PNG" fileName="logo.png" disabled onChange={() => undefined} />)).toContain('<button class="ov-button" type="button" disabled="">Choose PNG</button><span class="pg-file-name">logo.png</span>');
  });

  it('render a segmented switch with aria-pressed buttons', () => {
    const markup = html(<Segmented label="Sumber GPS" value="MANUAL" onChange={() => undefined} options={[{ value: 'DATA_OUT', label: 'DATA_OUT' }, { value: 'MANUAL', label: 'MANUAL' }, { value: 'FALLBACK', label: 'FALLBACK', disabled: true }]} />);
    expect(markup).toBe(
      '<div class="ov-seg pg-seg" role="group" aria-label="Sumber GPS">'
      + '<button type="button" aria-pressed="false">DATA_OUT</button><button type="button" aria-pressed="true">MANUAL</button><button type="button" aria-pressed="false" disabled="">FALLBACK</button></div>',
    );
  });

  it('render an on/off switch with the switch role', () => {
    expect(html(<Switch checked label="Simulasi di Dashboard" onChange={() => undefined} />)).toBe(
      '<button type="button" role="switch" aria-checked="true" class="pg-switch"><span class="pg-switch-track" aria-hidden="true"><span class="pg-switch-thumb"></span></span><span class="pg-switch-label">Simulasi di Dashboard</span></button>',
    );
    expect(html(<Switch checked={false} disabled label="Acak" onChange={() => undefined} />)).toContain('aria-checked="false" class="pg-switch" disabled=""');
  });
});

describe('empty state and notice', () => {
  it('show one line, and a notice only with its tone and role', () => {
    expect(html(<EmptyState label="No v2 messages yet" code={null} />)).toBe('<div class="pg-empty" role="status"><span>No v2 messages yet</span></div>');
    expect(html(<Notice title="STALE EVIDENCE">Data is old.</Notice>)).toBe('<div class="pg-notice tone-warn" role="status"><strong class="pg-notice-title">STALE EVIDENCE</strong><span class="pg-notice-text">Data is old.</span></div>');
    expect(html(<Notice tone="bad" action={<button type="button">Retry</button>}>Read failed</Notice>)).toBe('<div class="pg-notice tone-bad" role="alert"><span class="pg-notice-text">Read failed</span><span class="pg-notice-action"><button type="button">Retry</button></span></div>');
  });
});

/** Vitest blanks every CSS import, so the stylesheets are read from disk. */
function readSource(path: string): string {
  type Fs = { readFileSync(file: URL, encoding: 'utf8'): string };
  const { process } = globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } };
  return process.getBuiltinModule('node:fs').readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('page kit stylesheet', () => {
  const css = readSource('../../page-kit.css');

  it('loads after the dashboard styles', () => {
    const main = readSource('../../main.tsx');
    expect(main.indexOf("import './page-kit.css';")).toBeGreaterThan(main.indexOf("import './overview-dashboard.css';"));
    expect(main.indexOf("import './page-kit.css';")).toBeLessThan(main.indexOf("import 'maplibre-gl/dist/maplibre-gl.css';"));
  });

  it('uses the console tokens only, no literal colours', () => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(withoutComments).not.toMatch(/rgba?\(/);
    expect(css).toMatch(/:root\[data-theme='light'\] \{ --pg-field-bg: var\(--surface\); \}/);
  });

  it('keeps every control at 44 px', () => {
    expect(css).toMatch(/--pg-head-h: 44px;/);
    expect(css).toMatch(/\.pg-control \{[^}]*height: 44px;/);
    expect(css).toMatch(/\.pg-switch \{[^}]*min-height: 44px;/);
  });

  it('collapses the grid at 1279 and 1023 px and stacks tables and the page bar at 600 px', () => {
    const at1279 = css.slice(css.indexOf('@media (max-width: 1279px) {'));
    expect(at1279).toMatch(/^@media \(max-width: 1279px\) \{\s*\.pg-span-3, \.pg-span-4 \{ grid-column: span 6; \}\s*\.pg-span-5, \.pg-span-7, \.pg-span-8 \{ grid-column: 1 \/ -1; \}/);
    expect(css).toMatch(/@media \(max-width: 1023px\) \{\s*\.pg-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    const phone = css.slice(css.lastIndexOf('@media (max-width: 600px) {'));
    expect(phone).toMatch(/\.pg \{ padding: var\(--pg-gap\) 16px 24px; \}/);
    expect(phone).toMatch(/\.console-shell:not\(\.is-overview\):not\(\.is-receiver\) \.topbar-title \{ display: none; \}/);
    expect(css).toMatch(/\.pg-table\.is-stack td::before \{[^}]*content: attr\(data-label\);/);
  });

  it('hides the page H1 above 600 px, where the top bar names the page', () => {
    expect(css).toMatch(/@media \(min-width: 601px\) \{[^@]*\.pg-bar-heading \{ position: absolute;[^}]*clip-path: inset\(50%\);/);
    expect(css).not.toMatch(/\.pg-bar-title[^{]*\{[^}]*text-decoration/);
    expect(css).toMatch(/\.pg-bar-title:focus, \.pg-bar-title:focus-visible \{ outline: none; \}/);
  });

  it('turns transitions off for reduced motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.pg-switch-track, \.pg-switch-thumb \{ transition: none; \}/);
  });
});
