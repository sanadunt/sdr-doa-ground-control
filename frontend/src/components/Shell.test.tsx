import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConsoleShell } from './Shell';
import type { TelemetrySnapshot } from '../types';

describe('Receiver navigation', () => {
  it('exposes the active Receiver page as the seventh keyboard route', () => {
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
    expect(activeItem).toContain('aria-keyshortcuts="7"');
    expect(activeItem).toContain('Receiver');
  });
});

function strip(props: Partial<Parameters<typeof ConsoleShell>[0]> = {}): Record<string, { value: string; tone: string }> {
  const markup = renderToStaticMarkup(
    <ConsoleShell
      route="overview"
      onNavigate={() => undefined}
      branding={{ app_name: 'Ground Console', logo_data_url: '' }}
      snapshot={null}
      localSnapshotFresh={false}
      loading={false}
      readError={null}
      lastReadAgeMs={null}
      simulationEnabled={false}
      onRefresh={() => undefined}
      {...props}
    >
      <span>workspace</span>
    </ConsoleShell>,
  );
  const items: Record<string, { value: string; tone: string }> = {};
  for (const match of markup.matchAll(/<span class="telemetry-item tone-(\w+)"[^>]*><span class="telemetry-key">([^<]+)<\/span><span class="telemetry-value"><i aria-hidden="true"><\/i>([^<]*)<\/span>/g)) {
    items[match[2]] = { tone: match[1], value: match[3] };
  }
  return items;
}

const healthyView = {
  available: true,
  canonical_angle_deg: 211,
  freshness: { fresh: true, age_ms: 200, max_age_ms: 5000 },
  angular_power_db: Array.from({ length: 360 }, () => 0),
};

function liveSnapshot(overrides: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return {
    status: { available: true, daq_health: 'PASS' },
    doa_candidates: { csv: { ...healthyView }, xml: { ...healthyView } },
    native_consistency: { comparable: true, conflict: false },
    publication_gate: { state: 'BLOCKED', checks: {}, reasons: ['GROUND_CLOCK_UNVERIFIED'] },
    ...overrides,
  } as TelemetrySnapshot;
}

describe('runtime status strip', () => {
  it('shows a healthy fresh read as available and current', () => {
    const items = strip({ snapshot: liveSnapshot(), localSnapshotFresh: true, lastReadAgeMs: 300 });
    expect(items.Data).toEqual({ value: 'AVAILABLE', tone: 'good' });
    expect(items.DoA).toEqual({ value: 'AVAILABLE', tone: 'good' });
    expect(items.Snapshot).toEqual({ value: 'CURRENT', tone: 'good' });
  });

  it('reports an unreachable status.json as UNAVAILABLE, not STALE, right after the read', () => {
    const items = strip({ snapshot: liveSnapshot({ status: { available: false } }), localSnapshotFresh: false, lastReadAgeMs: 100 });
    expect(items.Data.value).toBe('UNAVAILABLE');
    expect(items.DoA.value).toBe('UNAVAILABLE');
    expect(items.Snapshot).toEqual({ value: 'CURRENT', tone: 'good' });
  });

  it('never shows the DoA chip as AVAILABLE when the DAQ is not synchronized', () => {
    const items = strip({ snapshot: liveSnapshot({ status: { available: true, daq_health: 'FAIL' } }), localSnapshotFresh: true, lastReadAgeMs: 100 });
    expect(items.Data.value).toBe('DEGRADED');
    expect(items.DoA).toEqual({ value: 'DEGRADED', tone: 'warn' });
  });

  it('names malformed and incomplete records instead of calling them stale', () => {
    const malformed = liveSnapshot({ doa_candidates: { csv: { available: false }, xml: { available: false } } });
    expect(strip({ snapshot: malformed, localSnapshotFresh: true, lastReadAgeMs: 100 }).Data.value).toBe('INVALID');
    const missingXml = liveSnapshot({ doa_candidates: { csv: { ...healthyView }, xml: { available: false } } });
    expect(strip({ snapshot: missingXml, localSnapshotFresh: true, lastReadAgeMs: 100 }).Data).toEqual({ value: 'INCOMPLETE', tone: 'warn' });
  });

  it('shows a stalled node as STALE in both chips', () => {
    const stalled = liveSnapshot({ node_progress: { state: 'STALLED', stalled: true } });
    const items = strip({ snapshot: stalled, localSnapshotFresh: false, lastReadAgeMs: 100 });
    expect(items.Data.value).toBe('STALE');
    expect(items.DoA.value).toBe('STALE');
  });

  it('ages the snapshot chip and keeps a failed read visible as ERROR', () => {
    expect(strip({ snapshot: liveSnapshot(), localSnapshotFresh: false, lastReadAgeMs: 6000 }).Snapshot.value).toBe('STALE');
    const failed = strip({ snapshot: liveSnapshot(), localSnapshotFresh: false, lastReadAgeMs: 100, readError: 'request timed out after 10000 ms' });
    expect(failed.Data.value).toBe('ERROR');
    expect(failed.Snapshot.value).toBe('ERROR');
    expect(strip({ loading: true }).Snapshot.value).toBe('LOADING');
  });

  it('shows a failed MQTT state read as ERROR', () => {
    expect(strip({ mqttConnection: 'connected' }).MQTT).toEqual({ value: 'CONNECTED', tone: 'good' });
    expect(strip({ mqttConnection: 'connected', mqttError: 'request failed (500)' }).MQTT).toEqual({ value: 'ERROR', tone: 'warn' });
  });

  it('keeps the refresh button enabled while a read is in flight', () => {
    const markup = renderToStaticMarkup(
      <ConsoleShell route="overview" onNavigate={() => undefined} branding={{ app_name: 'G', logo_data_url: '' }} snapshot={null} localSnapshotFresh={false} loading readError={null} lastReadAgeMs={null} simulationEnabled={false} onRefresh={() => undefined}>
        <span />
      </ConsoleShell>,
    );
    const button = markup.match(/<button[^>]*refresh-button[^>]*>/)?.[0] ?? '';
    expect(button).toContain('aria-busy="true"');
    expect(button).not.toContain('disabled');
  });
});
