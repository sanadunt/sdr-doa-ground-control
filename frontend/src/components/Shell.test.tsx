import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConsoleShell } from './Shell';

describe('Monobs navigation', () => {
  it('exposes the active Monobs page as the second keyboard route, right below Dashboard', () => {
    const markup = renderToStaticMarkup(
      <ConsoleShell
        route="receiver"
        onNavigate={() => undefined}
        branding={{ app_name: 'Ground Console', logo_data_url: '' }}
        snapshot={null}
        localSnapshotFresh={false}
        loading={false}
        readError={null}
        lastReadAgeMs={null}
        simulationEnabled={false}
        onRefresh={() => undefined}
      >
        <span>Receiver workspace</span>
      </ConsoleShell>,
    );
    const activeItem = markup.match(/<button[^>]*class="nav-item nav-active"[^>]*>[\s\S]*?<\/button>/)?.[0];

    expect(activeItem).toContain('aria-current="page"');
    expect(activeItem).toContain('aria-keyshortcuts="2"');
    expect(activeItem).toContain('Monobs');
    const labels = [...markup.matchAll(/<button[^>]*class="nav-item[^"]*"[^>]*aria-keyshortcuts="(\d)"/g)].map((match) => match[1]);
    expect(labels.slice(0, 2)).toEqual(['1', '2']);
    expect(markup.indexOf('Dashboard')).toBeLessThan(markup.indexOf('Monobs'));
  });
});
