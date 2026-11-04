import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { DroneVideoHealth } from '../../api';
import { normalizeDroneVideoHealth } from '../../api';
import { I18nContext, translate } from '../../lib/i18n';
import type { Lang, MessageKey, Translate } from '../../lib/i18n';
import { normalizeDrone } from '../../lib/droneLink';
import type { TelemetrySnapshot } from '../../types';
import { DroneLinkCard, DroneVideoCard } from '../DroneHealthCards';
import { DroneSettingsCard, droneHostValid, normalizeDroneSettings } from '../DroneSettingsCard';
import { DronePanel, droneChip, droneRows, droneVideoText } from './DronePanel';
import { droneCompareRows } from './NodeCard';

const t = (lang: Lang): Translate => (key: MessageKey, vars?: Record<string, string | number>) => translate(lang, key, vars);

function render(element: ReactElement, lang: Lang = 'en'): string {
  return renderToStaticMarkup(<I18nContext.Provider value={{ lang, setLang: () => undefined, t: t(lang) }}>{element}</I18nContext.Provider>);
}

const aged = { age_ms: 300, stale: false };
const BLOCK = {
  enabled: true, state: 'LIVE', connection: 'connected', host: '192.168.1.162', port: 1883,
  discovery: { mode: 'auto', scanning: false, candidates: [] },
  position: { ...aged, lat: -6.9321, lon: 107.6612, alt_msl_m: 742.3, alt_rel_m: 25.4, speed_ms: 3.1, heading_deg: 87 },
  gps: { ...aged, fix: 6, fix_label: 'RTK_FIXED', rtk: 'FIXED', satellites: 22, hdop: 0.6 },
  attitude: { ...aged, roll_deg: 8.2, pitch_deg: -4.1, yaw_deg: 87.3 },
  battery: { ...aged, voltage_v: 6.1, current_a: 4.2, remaining_pct: null },
  status: { ...aged, armed: true, custom_mode: 4, system_status: 4 },
  hud: { ...aged, groundspeed_ms: 3.1, climb_ms: 0.2, throttle_pct: 52 },
  statustext: { severity: 6, text: 'EKF3 IMU0 is using GPS', age_ms: 5000 },
  link: { ...aged, fc_online: true, camera_online: true, frames_per_s: 41.5, version: '0.1.0', uptime_s: 10 },
  heading: { deg: 87.3, source: 'attitude', age_ms: 300 },
  heading_at_doa: null, array_heading_offset_deg: 0, video_enabled: true, received: 9, invalid: 0, last_invalid: null,
};
const OK: DroneVideoHealth = normalizeDroneVideoHealth({ state: 'OK', camera_ready: true, video_ready: true, readers: 2, tracks: ['H264'] });

describe('drone panel', () => {
  it('shows the flight telemetry and the video box', () => {
    const markup = render(<DronePanel initialView={normalizeDrone(BLOCK)} initialHealth={OK} onClose={() => undefined} />);
    expect(markup).toContain('id="panel-drone"');
    expect(markup).toContain('>LIVE<');
    expect(markup).toContain('RTK FIXED · 22 sat · HDOP 0.6');
    expect(markup).toContain('ARMED · mode 4');
    expect(markup).toContain('rel 25.4 m · MSL 742 m');
    expect(markup).toContain('6.10 V · 4.2 A');
    expect(markup).toContain('FC online · 192.168.1.162');
    expect(markup).toContain('<video');
    expect(markup).toContain('muted=""');
    expect(markup).toContain('Connecting video…');
    expect(markup).toContain('EKF3 IMU0 is using GPS');
    expect(markup).toContain('aria-label="Close the drone panel"');
  });

  it('names why there is no data, in both languages', () => {
    expect(render(<DronePanel initialView={normalizeDrone({ ...BLOCK, connection: 'searching', state: 'NO_DATA', position: null, gps: null, attitude: null, battery: null, status: null, hud: null, link: null, heading: null, statustext: null })} initialHealth={OK} />))
      .toContain('Searching the LAN for the drone remote…');
    expect(render(<DronePanel initialView={null} initialHealth={OK} />, 'id')).toContain('Link drone mati.');
  });

  it('chips and rows', () => {
    expect(droneChip(null)).toEqual({ code: 'OFF', tone: 'neutral' });
    expect(droneChip(normalizeDrone({ ...BLOCK, connection: 'disconnected' }))).toEqual({ code: 'OFFLINE', tone: 'bad' });
    expect(droneChip(normalizeDrone({ ...BLOCK, state: 'STALE' }))).toEqual({ code: 'STALE', tone: 'warn' });
    const stale = droneRows(normalizeDrone({ ...BLOCK, gps: { ...BLOCK.gps, stale: true } }), t('en'));
    expect(stale.find((row) => row.key === 'gps')?.tone).toBe('is-stale');
  });

  it('video notices follow the service state', () => {
    const en = t('en');
    expect(droneVideoText(null, 'idle', null, en)).toBe('Checking the video service…');
    expect(droneVideoText(normalizeDroneVideoHealth({ state: 'DOWN' }), 'idle', null, en)).toBe('Video service is not running on the groundstation.');
    expect(droneVideoText(normalizeDroneVideoHealth({ state: 'DISABLED', reason: 'NOT_CONFIGURED' }), 'idle', null, en)).toBe('This console has no video service.');
    expect(droneVideoText(OK, 'error', 'DRONE_VIDEO_NO_STREAM', en)).toBe('No picture from the drone camera.');
    expect(droneVideoText(OK, 'playing', null, en)).toBeNull();
    expect(normalizeDroneVideoHealth({ state: 'WHAT' }).state).toBe('DOWN');
  });
});

describe('drone beside the RDF-SDR', () => {
  it('compares the two GPS and headings', () => {
    const answer = {
      drone: { ...BLOCK, heading: { deg: 90, source: 'attitude', age_ms: 1 } },
      source: { kind: 'mqtt' },
      status: { available: true },
      nav: { compass_state: 'OK', heading_deg: 70, gps_state: 'FIX', fix: 3, latitude: -6.9321, longitude: 107.6622 },
    } as unknown as TelemetrySnapshot;
    const rows = droneCompareRows(answer, true, t('en'));
    expect(rows[0][1]).toMatch(/apart$/);
    expect(rows[0][2]).toBe('is-warn');
    expect(rows[1][1]).toBe('90.0° · 70.0° · Δ +20.0°');
    expect(rows[1][2]).toBe('is-warn');
    expect(droneCompareRows(answer, false, t('en'))).toEqual([]);
  });
});

describe('drone settings and health', () => {
  it('settings card', () => {
    const settings = normalizeDroneSettings({ enabled: true, host: 'auto', port: 1883, array_heading_offset_deg: 0, video_enabled: true, last_host: '192.168.1.162' });
    const markup = render(<DroneSettingsCard initial={settings} initialView={normalizeDrone(BLOCK)} />);
    expect(markup).toContain('id="drone-settings"');
    expect(markup).toContain('Find on LAN');
    expect(markup).toContain('192.168.1.162:1883');
    expect(markup).toContain('type="submit"');
    expect(render(<DroneSettingsCard readOnly initial={settings} initialView={normalizeDrone(BLOCK)} />)).not.toContain('type="submit"');
    expect(droneHostValid('auto')).toBe(true);
    expect(droneHostValid('192.168.1.162')).toBe(true);
    expect(droneHostValid('fe80::1')).toBe(true);
    expect(droneHostValid('remote.local')).toBe(false);
    expect(normalizeDroneSettings({ port: 0, array_heading_offset_deg: 400 })).toMatchObject({ port: 1883, array_heading_offset_deg: 0, host: 'auto' });
  });

  it('health cards', () => {
    const link = render(<DroneLinkCard snapshot={{ drone: BLOCK } as unknown as TelemetrySnapshot} />, 'id');
    expect(link).toContain('Telemetri drone');
    expect(link).toContain('v0.1.0');
    expect(render(<DroneLinkCard snapshot={{} as TelemetrySnapshot} />)).toBe('');
    const video = render(<DroneVideoCard initial={normalizeDroneVideoHealth({ state: 'NO_CAMERA', camera_ready: false })} />);
    expect(video).toContain('NO_CAMERA');
    expect(video).toContain('No picture from the drone camera.');
  });
});
