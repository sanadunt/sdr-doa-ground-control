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
import { DronePanel, droneChip, droneLinkStatus, droneRows, droneVideoStatus, droneVideoText } from './DronePanel';
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

  it('always shows the link rows and every value row, "—" until the drone sends it', () => {
    const empty = { ...BLOCK, connection: 'searching', state: 'NO_DATA', host: null, position: null, gps: null, attitude: null, battery: null, status: null, hud: null, link: null, heading: null, statustext: null };
    const markup = render(<DronePanel initialView={normalizeDrone(empty)} initialHealth={normalizeDroneVideoHealth({ state: 'DOWN' })} />);
    expect(markup).toContain('>Telemetry<');
    expect(markup).toContain('Not connected · searching the LAN for the remote…');
    expect(markup).toContain('>Drone camera<');
    expect(markup).toContain('Not connected · service not running');
    for (const label of ['Status', 'GPS', 'Altitude', 'Speed', 'Heading', 'Roll / pitch', 'Battery', 'Remote']) expect(markup).toContain(`<dt>${label}</dt>`);
    expect(markup.match(/class="is-empty">—</g)).toHaveLength(8);
    const id = render(<DronePanel initialView={normalizeDrone(empty)} initialHealth={normalizeDroneVideoHealth({ state: 'DOWN' })} />, 'id');
    expect(id).toContain('>Telemetri<');
    expect(id).toContain('Tidak terhubung · mencari remote di LAN…');
    expect(id).toContain('Tidak terhubung · service tidak jalan');
    expect(render(<DronePanel initialView={null} initialHealth={OK} />, 'id')).toContain('Memeriksa…');
  });

  it('link row: off, searching, connecting, not connected, connected live, stale, no data', () => {
    const en = t('en');
    const id = t('id');
    expect(droneLinkStatus(null, en)).toEqual({ value: 'Checking…', tone: 'is-empty' });
    expect(droneLinkStatus(normalizeDrone({ ...BLOCK, enabled: false, state: 'DISABLED', connection: 'disabled' }), en)).toEqual({ value: 'Off (Configuration)', tone: 'is-empty' });
    expect(droneLinkStatus(normalizeDrone({ ...BLOCK, connection: 'searching' }), en).tone).toBe('is-warn');
    expect(droneLinkStatus(normalizeDrone({ ...BLOCK, connection: 'connecting' }), en)).toEqual({ value: 'Connecting to 192.168.1.162…', tone: 'is-warn' });
    expect(droneLinkStatus(normalizeDrone({ ...BLOCK, connection: 'disconnected' }), en)).toEqual({ value: 'Not connected · 192.168.1.162 · trying again', tone: 'is-bad' });
    expect(droneLinkStatus(normalizeDrone(BLOCK), en)).toEqual({ value: 'Connected · 192.168.1.162', tone: 'is-good' });
    expect(droneLinkStatus(normalizeDrone({ ...BLOCK, state: 'STALE' }), id)).toEqual({ value: 'Terhubung · 192.168.1.162 · data usang', tone: 'is-warn' });
    expect(droneLinkStatus(normalizeDrone({ ...BLOCK, state: 'NO_DATA' }), id)).toEqual({ value: 'Terhubung · 192.168.1.162 · belum ada data', tone: 'is-warn' });
  });

  it('video row: from the service health and the player', () => {
    const en = t('en');
    const id = t('id');
    expect(droneVideoStatus(null, 'idle', null, en)).toEqual({ value: 'Checking…', tone: 'is-empty' });
    expect(droneVideoStatus(OK, 'playing', null, en)).toEqual({ value: 'Connected · live', tone: 'is-good' });
    expect(droneVideoStatus(OK, 'connecting', null, en)).toEqual({ value: 'Connecting…', tone: 'is-warn' });
    expect(droneVideoStatus(OK, 'error', null, en)).toEqual({ value: 'Not connected · trying again', tone: 'is-warn' });
    expect(droneVideoStatus(OK, 'error', 'DRONE_VIDEO_NO_STREAM', en).value).toBe('Not connected · no camera picture');
    expect(droneVideoStatus(normalizeDroneVideoHealth({ state: 'NO_CAMERA' }), 'idle', null, id).value).toBe('Tidak terhubung · tidak ada gambar kamera');
    expect(droneVideoStatus(normalizeDroneVideoHealth({ state: 'NO_ENCODER' }), 'idle', null, en)).toEqual({ value: 'Not connected · encoder not running', tone: 'is-bad' });
    expect(droneVideoStatus(normalizeDroneVideoHealth({ state: 'DOWN' }), 'idle', null, en).tone).toBe('is-bad');
    expect(droneVideoStatus(normalizeDroneVideoHealth({ state: 'DISABLED', reason: 'NOT_CONFIGURED' }), 'idle', null, en).value).toBe('No video service on this console');
    expect(droneVideoStatus(normalizeDroneVideoHealth({ state: 'DISABLED', reason: 'TURNED_OFF' }), 'idle', null, id).value).toBe('Mati (Konfigurasi)');
  });

  it('chips and rows', () => {
    expect(droneChip(null)).toEqual({ code: 'OFF', tone: 'neutral' });
    expect(droneChip(normalizeDrone({ ...BLOCK, connection: 'disconnected' }))).toEqual({ code: 'OFFLINE', tone: 'bad' });
    expect(droneChip(normalizeDrone({ ...BLOCK, state: 'STALE' }))).toEqual({ code: 'STALE', tone: 'warn' });
    const stale = droneRows(normalizeDrone({ ...BLOCK, gps: { ...BLOCK.gps, stale: true } }), t('en'));
    expect(stale.find((row) => row.key === 'gps')?.tone).toBe('is-stale');
    expect(droneRows(null, t('en')).map((row) => row.key)).toEqual(['status', 'gps', 'alt', 'speed', 'heading', 'attitude', 'battery', 'link']);
    expect(droneRows(normalizeDrone(BLOCK), t('en')).every((row) => row.tone !== 'is-empty')).toBe(true);
  });

  it('video notices follow the service state', () => {
    const en = t('en');
    expect(droneVideoText(null, 'idle', null, en)).toBe('Checking the video service…');
    expect(droneVideoText(normalizeDroneVideoHealth({ state: 'DOWN' }), 'idle', null, en)).toBe('Video service is not running on the groundstation.');
    expect(droneVideoText(normalizeDroneVideoHealth({ state: 'DISABLED', reason: 'NOT_CONFIGURED' }), 'idle', null, en)).toBe('This console has no video service.');
    expect(droneVideoText(OK, 'error', 'DRONE_VIDEO_NO_STREAM', en)).toBe('No picture from the drone camera.');
    expect(droneVideoText(OK, 'playing', null, en)).toBeNull();
    // On demand and nobody watching: standby, and the player still starts (its offer starts the pull).
    const standby = normalizeDroneVideoHealth({ state: 'STANDBY', on_demand: true });
    expect(standby.state).toBe('STANDBY');
    expect(droneVideoText(standby, 'idle', null, en)).toBe('Standby: the camera is pulled only while the video plays.');
    expect(droneVideoText(standby, 'connecting', null, en)).toBe('Connecting video…');
    expect(droneVideoStatus(standby, 'idle', null, en)).toEqual({ value: 'Standby · the camera is pulled when the video plays', tone: 'is-empty' });
    expect(droneVideoStatus(standby, 'connecting', null, en).value).toBe('Connecting…');
    expect(droneVideoStatus(standby, 'error', 'DRONE_VIDEO_NO_STREAM', en).value).toContain('no camera picture');
    // No remote found yet: the panel says so and does not start its player.
    const unknown = normalizeDroneVideoHealth({ state: 'NO_CAMERA', reason: 'CAMERA_UNKNOWN', on_demand: true });
    expect(droneVideoText(unknown, 'idle', null, en)).toBe('The drone remote is not found yet; the video waits for it.');
    expect(droneVideoStatus(unknown, 'idle', null, en)).toEqual({ value: 'Not connected · drone remote not found yet', tone: 'is-warn' });
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
