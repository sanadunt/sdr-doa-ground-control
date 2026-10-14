import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { normalizeCapabilities, normalizeConfigReported } from '../../api';
import type { ConfigReported } from '../../api';
import { I18nContext, translate } from '../../lib/i18n';
import type { Lang } from '../../lib/i18n';
import { CONFIG_PATCH_FIELDS, commandResultView, draftFromReported, parseDraft } from '../../lib/configPatch';
import type { DraftValues } from '../../lib/configPatch';
import { ControlPanel, ControlPanelView, reviewRows } from './ControlPanel';
import type { ControlPanelViewProps } from './ControlPanel';

const CAPABILITIES = normalizeCapabilities({
  admin_enabled: true,
  admin_default_password: true,
  config_patch: { enabled: true, requires_admin: true, topic: 'sdr/v1/uav-01/cmd/config/patch', qos: 1, ttl_ms: 60000, ranges: { center_frequency_hz: [24000000, 1800000000] } },
});

const REPORTED: ConfigReported = normalizeConfigReported({
  available: true,
  broker: { host: '10.90.0.1', port: 9001, transport: 'websockets', connection: 'connected' },
  base_config_rev: 42,
  base_config_rev_source: 'config_reported',
  reported: { config_rev: 42, received_at_ms: 0, age_ms: 1200, retained: true, synthetic: false, source: 'v1' },
  values: { center_frequency_hz: 416588000, gain_db: 15.5, vfo_frequency_hz: null, vfo_bandwidth_hz: null, vfo_squelch_db: null },
});

const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('id', key, vars);

function evaluate(draft: DraftValues = {}, reported: ConfigReported | null = REPORTED) {
  const values = reported?.values ?? {};
  return parseDraft(CONFIG_PATCH_FIELDS, { ...(reported ? draftFromReported(reported.values) : {}), ...draft }, values, CAPABILITIES.configPatch?.ranges ?? null);
}

function view(props: Partial<ControlPanelViewProps> = {}, lang: Lang = 'id'): string {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: noop, t: (key, vars) => translate(lang, key, vars) }}>
      <ControlPanelView
        capabilities={CAPABILITIES}
        admin="unlocked"
        adminNotice={null}
        reported={REPORTED}
        reportedError={null}
        evaluation={evaluate()}
        stage="edit"
        review={null}
        sending={null}
        done={null}
        editError={null}
        onClose={noop}
        onLock={noop}
        onUnlocked={noop}
        onDraftChange={noop}
        onReview={noop}
        onReset={noop}
        onSend={noop}
        onBack={noop}
        onDone={noop}
        onReload={noop}
        {...props}
      />
    </I18nContext.Provider>,
  );
}

describe('Kontrol locked', () => {
  it('starts locked while the admin session is checked', () => {
    const markup = renderToStaticMarkup(
      <I18nContext.Provider value={{ lang: 'id', setLang: () => undefined, t: (key, vars) => translate('id', key, vars) }}>
        <ControlPanel capabilities={CAPABILITIES} controlDraftRequest={null} onClose={() => undefined} />
      </I18nContext.Provider>,
    );
    expect(markup).toContain('id="panel-control"');
    expect(markup).toContain('>LOCKED</span>');
    expect(markup).toMatch(/<div class="ov-control-body"><p class="ov-control-note" role="status">Memeriksa sesi admin…<\/p><\/div>/);
    expect(markup).not.toContain('type="password"');
  });

  it('asks for the admin password and warns about the default one', () => {
    const markup = view({ admin: 'locked' });
    expect(markup).toContain('>LOCKED</span>');
    expect(markup).toContain('Kata sandi admin');
    expect(markup).toContain('type="password"');
    expect(markup).toMatch(/type="password"[^>]*autoComplete="current-password"/);
    expect(markup).toContain('<p class="ov-control-warn" role="note">Kata sandi admin bawaan dipakai. Atur SDR_DOA_ADMIN_PASSWORD.</p>');
    // The password itself never appears in the page.
    expect(markup).not.toContain('123456');
    expect(markup).not.toContain('Kirim ke RDF-SDR');
  });

  it('disables the form when admin login is off', () => {
    const capabilities = { ...CAPABILITIES, adminEnabled: false, adminDefaultPassword: false };
    const markup = view({ admin: 'locked', capabilities });
    expect(markup).toContain('Login admin nonaktif: SDR_DOA_ADMIN_PASSWORD kosong.');
    expect(markup).toMatch(/<input id="[^"]*" type="password"[^>]*disabled=""/);
    expect(markup).toMatch(/<button class="ov-button is-primary" type="submit" disabled="">Buka kunci<\/button>/);
  });

  it('shows why the session ended', () => {
    expect(view({ admin: 'locked', adminNotice: { key: 'control.error.ADMIN_REQUIRED' } })).toContain('Sesi admin sudah berakhir. Buka kunci lagi.');
  });
});

describe('Kontrol unlocked', () => {
  it('shows the topic, broker and base revision with the five fields', () => {
    const markup = view();
    expect(markup).toContain('>ADMIN</span>');
    expect(markup).toContain('aria-label="Kunci lagi"');
    expect(markup).toContain('sdr/v1/uav-01/cmd/config/patch');
    expect(markup).toContain('Broker <span class="ov-mono">10.90.0.1:9001</span> · <span class="ov-mono">CONNECTED</span> · rev dasar <span class="ov-mono">42</span>');
    for (const label of ['Frekuensi tengah', 'Gain', 'Frekuensi VFO', 'Bandwidth VFO', 'Squelch VFO']) expect(markup).toContain(`>${label}</label>`);
    expect(markup).toContain('value="416.588"');
    expect(markup).toContain('tidak dilaporkan');
    // A field that is reported and unchanged has no line under it; the range shows only with an error.
    expect(markup).not.toContain('24 s/d 1800 MHz');
    expect(markup).toMatch(/<input id="ov-control-center_frequency_hz" type="text" inputMode="decimal" autoComplete="off" spellCheck="false" value="416.588"\/><span>MHz<\/span><\/div><\/div>/);
    // Nothing changed yet, so review is disabled.
    expect(markup).toMatch(/<button class="ov-button is-primary is-wide" type="button" disabled="">Tinjau perubahan<\/button>/);
  });

  it('marks a changed field and an invalid one', () => {
    const markup = view({ evaluation: evaluate({ center_frequency_hz: '433.92', gain_db: '99' }) });
    expect(markup).toContain('Diubah dari 416.588 MHz');
    expect(markup).toContain('Di luar −100 s/d 60 dB');
    expect(markup).toMatch(/<button class="ov-button is-primary is-wide" type="button" disabled="">/);
    const valid = view({ evaluation: evaluate({ center_frequency_hz: '433.92' }) });
    expect(valid).toMatch(/<button class="ov-button is-primary is-wide" type="button">Tinjau perubahan<\/button>/);
  });

  it('reports an unavailable MQTT publish path', () => {
    const reported = normalizeConfigReported({ available: false, code: 'MQTT_DEPENDENCY_MISSING', broker: { connection: 'error' } });
    expect(view({ reported, evaluation: evaluate({}, reported) })).toContain('paho-mqtt belum terpasang di host console');
  });

  it('flags a synthetic config_reported', () => {
    const reported = normalizeConfigReported({ ...REPORTED, broker: { host: 'h', port: 1, connection: 'connected' }, reported: { config_rev: 8, age_ms: 0, synthetic: true }, values: {} });
    expect(view({ reported })).toContain('>SYNTHETIC</span>');
  });
});

describe('Kontrol review and send', () => {
  const evaluation = evaluate({ center_frequency_hz: '433.92', vfo_frequency_hz: '433.925' });
  const review = { changes: evaluation.changes, rev: 42, rows: reviewRows(t, evaluation.fields) };

  it('lists from and to, QoS, expiry and base revision', () => {
    const markup = view({ stage: 'review', review, evaluation });
    expect(markup).toContain('2 perubahan akan dikirim');
    expect(markup).toContain('Frekuensi tengah <span class="ov-mono ov-control-key">center_frequency_hz</span>');
    expect(markup).toContain('416.588 MHz → <b>433.920 MHz</b>');
    expect(markup).toContain('tidak dilaporkan → <b>433.925 MHz</b>');
    expect(markup).toContain('QoS 1 · kedaluwarsa 60 dtk · rev dasar 42');
    expect(markup).not.toContain('--enable-config');
    expect(markup).toMatch(/<button class="ov-button is-send is-wide" type="button"><svg[\s\S]*?<span>Kirim ke RDF-SDR<\/span><\/button>/);
    expect(markup).toContain('>Kembali</button>');
  });

  it('blocks the send without a connected monitor or a base revision', () => {
    const disconnected = normalizeConfigReported({ ...REPORTED, broker: { host: '10.90.0.1', port: 9001, connection: 'connecting' }, values: {} });
    expect(view({ stage: 'review', review, evaluation, reported: disconnected })).toMatch(/Kirim butuh monitor MQTT yang terhubung[\s\S]*is-send is-wide" type="button" disabled=""/);
    expect(view({ stage: 'review', review: { ...review, rev: null }, evaluation })).toContain('Kirim butuh revisi konfigurasi yang dilaporkan lewat MQTT.');
    const noPublish = { ...CAPABILITIES, configPatch: CAPABILITIES.configPatch ? { ...CAPABILITIES.configPatch, enabled: false } : null };
    const blocked = view({ stage: 'review', review, evaluation, capabilities: noPublish });
    expect(blocked).toContain('Patch konfigurasi tidak tersedia: monitor MQTT mati atau paho-mqtt belum terpasang.');
    expect(blocked).toMatch(/is-send is-wide" type="button" disabled=""/);
  });

  it('shows the command id while waiting for the ACK', () => {
    expect(view({ stage: 'sending', sending: { commandId: null, count: 2, baseRev: 42, status: null } })).toContain('Mengirim ke console…');
    const markup = view({ stage: 'sending', sending: { commandId: 'gc-0123', count: 2, baseRev: 42, status: null } });
    expect(markup).toContain('Terkirim ke broker. Menunggu <span class="ov-mono">sdr/v1/uav-01/ack/config</span> untuk <span class="ov-mono">gc-0123</span>…');
  });
});

describe('Kontrol results', () => {
  const done = (state: string, ack: Parameters<typeof commandResultView>[0]['ack'], pubackReason: number | null = null) => ({
    view: commandResultView({ state, ack, pubackReason }, 2, 42, 60),
    error: null,
    commandId: 'gc-0123',
    restarted: false,
  });
  const ack = (status: string, errorCode: string | null = null) => ({ status, configRev: status === 'applied' ? 43 : null, errorCode, currentConfigRev: null, changedFields: status === 'applied' ? ['center_frequency_hz', 'vfo_frequency_hz'] : [] });

  it('reports applied', () => {
    const markup = view({ stage: 'done', done: done('acked', ack('applied')) });
    expect(markup).toContain('ov-control-result tone-ok');
    expect(markup).toContain('ACK · applied');
    expect(markup).toContain('RDF-SDR menerapkan 2 perubahan ke settings.json. Config rev sekarang 43.');
    expect(markup).toContain('>Selesai</button>');
    expect(markup).not.toContain('Muat ulang nilai');
  });

  it('reports a remote control that is off, a conflict and no ACK', () => {
    expect(view({ stage: 'done', done: done('acked', ack('rejected', 'REMOTE_CONTROL_DISABLED')) })).toContain('Ditolak · REMOTE_CONTROL_DISABLED');
    const conflict = view({ stage: 'done', done: done('acked', ack('conflict', 'CONFIG_REVISION_CONFLICT')) });
    expect(conflict).toContain('Rev dasar 42 sudah usang.');
    expect(conflict).toContain('>Muat ulang nilai</button>');
    const noAck = view({ stage: 'done', done: done('no_ack', null) });
    expect(noAck).toContain('Belum ada ACK');
    expect(noAck).toContain('Tidak ada ack/config sebelum perintah kedaluwarsa (60 dtk).');
    expect(view({ stage: 'done', done: done('publish_failed', null, 135) })).toContain('PUBACK 135');
  });

  it('reports a refused request by its code', () => {
    const markup = view({ stage: 'done', done: { view: null, error: { code: 'COMMAND_IN_FLIGHT', message: { key: 'control.error.COMMAND_IN_FLIGHT' } }, commandId: 'gc-9', restarted: false } }, 'en');
    expect(markup).toContain('Not sent · COMMAND_IN_FLIGHT');
    expect(markup).toContain('Another config patch is still waiting for its result.');
    expect(markup).toContain('gc-9');
  });

  it('shows a stale revision in the form', () => {
    const markup = view({ editError: { code: 'CONFIG_REVISION_STALE', message: { key: 'control.error.CONFIG_REVISION_STALE' } } });
    expect(markup).toContain('Konfigurasi yang dilaporkan berubah sejak ditinjau.');
  });
});
