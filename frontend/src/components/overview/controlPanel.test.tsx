import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { normalizeCapabilities, normalizeConfigReported } from '../../api';
import type { ConfigReported } from '../../api';
import { I18nContext, translate } from '../../lib/i18n';
import type { Lang } from '../../lib/i18n';
import { CONFIG_PATCH_FIELDS, commandResultView, draftFromReported, parseDraft } from '../../lib/configPatch';
import type { DraftValues } from '../../lib/configPatch';
import { currentConfigValues, dataOutConfigValues, verifyConfigPatch } from '../../lib/configVerify';
import type { VerifyInput } from '../../lib/configVerify';
import type { TelemetrySnapshot } from '../../types';
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

describe('Kontrol read-back from the RDF-SDR', () => {
  const changes = { center_frequency_hz: 433_920_000, vfo_frequency_hz: 433_925_000, vfo_squelch_db: -70 };
  const applied = {
    view: commandResultView({ state: 'acked', ack: { status: 'applied', configRev: 43, errorCode: null, currentConfigRev: null, changedFields: Object.keys(changes) }, pubackReason: null }, 3, 42, 60),
    error: null,
    commandId: 'gc-0123',
    restarted: false,
  };
  const node: TelemetrySnapshot = { settings: { available: true, fields: { center_freq: 433.92, vfo_freq_0: 433_900_000 } } };
  const check = (overrides: Partial<VerifyInput> = {}) => verifyConfigPatch({
    changes, issuedAtMs: 1_000, finalAtMs: 0, nowMs: 1_000, reported: REPORTED, snapshot: node, snapshotFresh: true, ...overrides,
  });

  it('lists each sent field with its Data Out and MQTT values and a status code', () => {
    const markup = view({ stage: 'done', done: applied, verification: check(), onRecheck: () => undefined });
    expect(markup).toContain('aria-label="Cek RDF-SDR"');
    expect(markup).toContain('role="status">Memeriksa RDF-SDR · 1/3</span>');
    expect(markup).toMatch(/Frekuensi tengah<\/span><span class="ov-tag tone-good">CONFIRMED<\/span>/);
    expect(markup).toMatch(/Frekuensi VFO<\/span><span class="ov-tag tone-info">PENDING<\/span>/);
    expect(markup).toMatch(/Squelch VFO<\/span><span class="ov-tag tone-neutral">NOT REPORTED<\/span>/);
    expect(markup).toContain('<dt>Dikirim</dt><dd class="ov-mono">433.925 MHz</dd>');
    expect(markup).toContain('<dt>Data Out</dt><dd class="ov-mono">433.900 MHz</dd>');
    // This config_reported has no receipt time after the command, so it is not evidence.
    expect(markup).toContain('<dt>MQTT</dt><dd class="ov-mono">—</dd>');
    expect(markup).toMatch(/<button class="ov-button" type="button"><svg[\s\S]*?<span>Cek ulang<\/span><\/button>/);
  });

  it('reads the verdict once the window has ended', () => {
    const after = view({ stage: 'done', done: applied, verification: check({ nowMs: 90_000 }) });
    expect(after).toContain('Sebagian berubah · 1/3');
    expect(after).toContain('>UNCHANGED</span>');
    const confirmed = check({ changes: { center_frequency_hz: 433_920_000 } });
    expect(view({ stage: 'done', done: applied, verification: confirmed })).toContain('RDF-SDR berubah · 1/1');
    expect(view({ stage: 'done', done: applied, verification: confirmed }, 'en')).toContain('RDF-SDR changed · 1/1');
    const unchanged = check({ changes: { vfo_frequency_hz: 433_925_000 }, nowMs: 90_000 });
    expect(view({ stage: 'done', done: applied, verification: unchanged })).toContain('Belum berubah · 0/1');
  });

  it('shows the read-back after a rejection, and nothing without one', () => {
    const rejected = { ...applied, view: commandResultView({ state: 'acked', ack: { status: 'rejected', configRev: null, errorCode: 'REMOTE_CONTROL_DISABLED', currentConfigRev: null, changedFields: [] }, pubackReason: null }, 3, 42, 60) };
    expect(view({ stage: 'done', done: rejected, verification: check({ nowMs: 90_000 }) })).toContain('Sebagian berubah · 1/3');
    expect(view({ stage: 'done', done: applied })).not.toContain('ov-verify');
  });

  it('fills the values MQTT does not report from Data Out', () => {
    const dataOut = dataOutConfigValues({ settings: { available: true, fields: { center_freq: 415.7882, vfo_freq_0: 433_925_000, vfo_bw_0: 12_500, vfo_squelch_0: -80 } } }, true);
    const values = currentConfigValues(REPORTED.values, dataOut);
    const ranges = CAPABILITIES.configPatch?.ranges ?? null;
    const markup = view({ evaluation: parseDraft(CONFIG_PATCH_FIELDS, draftFromReported(values), values, ranges) });
    // MQTT still wins for the centre frequency.
    expect(markup).toContain('value="416.588"');
    expect(markup).toContain('value="433.925"');
    expect(markup).toContain('value="12.5"');
    expect(markup).toContain('value="-80"');
    expect(markup).not.toContain('tidak dilaporkan');
    const edited = parseDraft(CONFIG_PATCH_FIELDS, { ...draftFromReported(values), vfo_frequency_hz: '433.95' }, values, ranges);
    expect(reviewRows(t, edited.fields)).toEqual([{ key: 'vfo_frequency_hz', label: 'Frekuensi VFO', from: '433.925 MHz', to: '433.950 MHz' }]);
  });
});
