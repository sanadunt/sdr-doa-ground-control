import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError, normalizeCapabilities, normalizeConfigCommandStatus, normalizeConfigReported } from '../../api';
import type { ConfigReported } from '../../api';
import { I18nContext, translate } from '../../lib/i18n';
import type { Lang } from '../../lib/i18n';
import { CONFIG_PATCH_FIELDS, commandResultView, draftFromReported, draftWithCenter, parseDraft } from '../../lib/configPatch';
import type { CommandStatusLike, DraftValues } from '../../lib/configPatch';
import { currentConfigValues, dataOutConfigValues, verifyConfigPatch } from '../../lib/configVerify';
import type { VerifyInput } from '../../lib/configVerify';
import type { TelemetrySnapshot } from '../../types';
import { ControlPanel, ControlPanelView, controlFailure, controlValueSource, reviewRows } from './ControlPanel';
import type { ControlPanelViewProps } from './ControlPanel';

const CAPABILITIES = normalizeCapabilities({
  admin_enabled: true,
  admin_default_password: true,
  config_patch: {
    enabled: true,
    requires_admin: true,
    topic: 'sdr/v2/uav-01/cmd/config/patch',
    get_topic: 'sdr/v2/uav-01/cmd/config/get',
    ack_topic: 'sdr/v2/uav-01/ack/config',
    settings_topic: 'sdr/v2/uav-01/settings/reported',
    qos: 1,
    ttl_ms: 15000,
    ranges: { center_frequency_hz: [24000000, 1766000000] },
  },
});

const NODE = { sid: '0a1b2c3d', cfg: 42, health_fresh: true, health_age_ms: 900, remote_commands: true, remote_config_patch: true };
const SETTINGS_AT = 99_000;

function reportedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available: true,
    now_ms: 100_000,
    broker: { host: '10.90.0.1', port: 9001, transport: 'websockets', connection: 'connected' },
    node: NODE,
    base_rev: 42,
    settings: { id: 'gc-get-1', rev: 42, received_at_ms: SETTINGS_AT, age_ms: 1200, matches_state_cfg: true },
    values: { center_frequency_hz: 416_588_000, gain_db: 15.7, vfo0_frequency_hz: 416_588_000, vfo0_bandwidth_hz: null, vfo0_squelch_db: null },
    value_sources: { center_frequency_hz: 'settings_reported', gain_db: 'settings_reported', vfo0_frequency_hz: 'settings_reported' },
    value_received_at_ms: { center_frequency_hz: SETTINGS_AT, gain_db: SETTINGS_AT, vfo0_frequency_hz: SETTINGS_AT },
    pending_command_id: null,
    settings_request: { command_id: 'gc-get-1', op: 'config.get', state: 'reported', issued_ms: 98_000, expires_ms: 113_000, changes: {} },
    ...overrides,
  };
}

const REPORTED: ConfigReported = normalizeConfigReported(reportedBody());

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
        valueSource="settings"
        onReadSettings={noop}
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
    expect(markup).not.toContain('Baca settings');
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
  it('shows the topic, broker, node session, settings report and the five fields', () => {
    const markup = view();
    expect(markup).toContain('>ADMIN</span>');
    expect(markup).toContain('aria-label="Kunci lagi"');
    expect(markup).toContain('sdr/v2/uav-01/cmd/config/patch');
    expect(markup).not.toContain('sdr/v1');
    expect(markup).toContain('Broker <span class="ov-mono">10.90.0.1:9001</span> · <span class="ov-mono">CONNECTED</span> · rev dasar <span class="ov-mono">42</span>');
    expect(markup).toContain('RDF-SDR <span class="ov-mono">0a1b2c3d</span> · health <span class="ov-mono">FRESH</span>');
    expect(markup).toContain('settings/reported rev <span class="ov-mono">42</span> · <span class="ov-mono">1.2 dtk</span> lalu');
    expect(markup).toMatch(/<button class="ov-button" type="button">Baca settings<\/button>/);
    expect(markup).toContain('Nilai: settings/reported');
    for (const label of ['Frekuensi tengah', 'Gain', 'Frekuensi VFO', 'Bandwidth VFO', 'Squelch VFO']) expect(markup).toContain(`>${label}</label>`);
    expect(markup).toContain('value="416.588"');
    expect(markup).toContain('tidak dilaporkan');
    // A field that is reported and unchanged has no line under it; the range shows only with an error.
    expect(markup).not.toContain('24 s/d 1766 MHz');
    expect(markup).toMatch(/<input id="ov-control-center_frequency_hz" type="text" inputMode="decimal" autoComplete="off" spellCheck="false" value="416.588"\/><span>MHz<\/span><\/div><\/div>/);
    // Gain is a select of the RDF-SDR gain table.
    expect(markup).toMatch(/<select id="ov-control-gain_db">[\s\S]*<option value="15.7" selected="">15.7 dB<\/option>[\s\S]*<option value="49.6">49.6 dB<\/option><\/select>/);
    // Nothing changed yet, so review is disabled.
    expect(markup).toMatch(/<button class="ov-button is-primary is-wide" type="button" disabled="">Tinjau perubahan<\/button>/);
  });

  it('names where the values come from', () => {
    expect(view({ valueSource: 'data-out' })).toContain('Nilai: Data Out (cadangan)');
    expect(view({ valueSource: 'none' })).toContain('Nilai: tidak dilaporkan');
    expect(view({ valueSource: 'data-out' }, 'en')).toContain('Values: Data Out (fallback)');
    const dataOut = dataOutConfigValues({ settings: { available: true, fields: { center_freq: 433.92 } } }, true);
    const empty = { center_frequency_hz: null, gain_db: null, vfo0_frequency_hz: null, vfo0_bandwidth_hz: null, vfo0_squelch_db: null };
    expect(controlValueSource(REPORTED, empty)).toBe('settings');
    const unreported = normalizeConfigReported(reportedBody({ settings: null, values: {}, value_sources: {}, value_received_at_ms: {} }));
    expect(controlValueSource(unreported, dataOut)).toBe('data-out');
    expect(controlValueSource(unreported, empty)).toBe('none');
    expect(controlValueSource(null, empty)).toBe('none');
  });

  it('shows a settings report of an older revision and no report at all', () => {
    const old = normalizeConfigReported(reportedBody({ base_rev: 43, node: { ...NODE, cfg: 43 }, settings: { id: 'gc-get-1', rev: 42, received_at_ms: SETTINGS_AT, age_ms: 30_000, matches_state_cfg: false }, values: {}, value_sources: {}, value_received_at_ms: {} }));
    expect(view({ reported: old, evaluation: evaluate({}, old) })).toContain('settings/reported rev <span class="ov-mono">42</span> · rev node <span class="ov-mono">43</span>');
    const none = normalizeConfigReported(reportedBody({ settings: null, settings_request: null }));
    expect(view({ reported: none })).toContain('Belum ada settings/reported');
  });

  it('reports the settings request: reading, TLS required, no answer', () => {
    const reading = normalizeConfigReported(reportedBody({ settings_request: { command_id: 'gc-get-2', op: 'config.get', state: 'delivered', changes: {} } }));
    const readingMarkup = view({ reported: reading });
    expect(readingMarkup).toContain('<p class="ov-control-note" role="status">Membaca settings dari RDF-SDR…</p>');
    expect(readingMarkup).toMatch(/<button class="ov-button" type="button" disabled="">Baca settings<\/button>/);
    const tls = normalizeConfigReported(reportedBody({
      settings: null,
      settings_request: {
        command_id: 'gc-get-3', op: 'config.get', state: 'acked', changes: {},
        ack: { status: 'REJECTED', final: true, error: 'TLS_REQUIRED_FOR_SETTINGS_REPORT', reason: null, revision: null },
      },
    }));
    const tlsMarkup = view({ reported: tls, valueSource: 'data-out' }, 'en');
    expect(tlsMarkup).toContain('<p class="ov-control-warn" role="status"><span class="ov-mono">TLS_REQUIRED_FOR_SETTINGS_REPORT</span> · RDF-SDR sends its settings only over a TLS connection to the broker. Until the broker has TLS, the values come from Data Out (fallback).</p>');
    expect(tlsMarkup).toContain('Values: Data Out (fallback)');
    const noAck = normalizeConfigReported(reportedBody({ settings_request: { command_id: 'gc-get-4', op: 'config.get', state: 'no_ack', changes: {} } }));
    expect(view({ reported: noAck })).toContain('<span class="ov-mono">NO ACK</span> · RDF-SDR tidak menjawab permintaan settings.');
    const noReport = normalizeConfigReported(reportedBody({ settings_request: { command_id: 'gc-get-5', op: 'config.get', state: 'no_report', changes: {} } }));
    expect(view({ reported: noReport })).toContain('<span class="ov-mono">NO REPORT</span>');
    const refused = view({ settingsError: { code: 'CONFIG_GET_TOO_SOON', message: { key: 'control.error.CONFIG_GET_TOO_SOON' } } });
    expect(refused).toContain('<p class="ov-control-error" role="alert"><span class="ov-mono">CONFIG_GET_TOO_SOON</span> · RDF-SDR menjawab satu permintaan settings per detik. Coba lagi.</p>');
  });

  it('cannot read settings without a connected broker or a node session', () => {
    const disconnected = normalizeConfigReported(reportedBody({ broker: { host: '10.90.0.1', port: 9001, connection: 'connecting' } }));
    expect(view({ reported: disconnected })).toMatch(/disabled="">Baca settings<\/button>/);
    const noNode = normalizeConfigReported(reportedBody({ node: null }));
    const markup = view({ reported: noNode });
    expect(markup).toMatch(/disabled="">Baca settings<\/button>/);
    expect(markup).toContain('Belum ada state RDF-SDR lewat MQTT');
    // Without a node there is no base revision.
    expect(markup).toContain('rev dasar <span class="ov-mono">tidak diketahui</span>');
  });

  it('marks a changed field, takes VFO0 along with the centre and refuses values the edge refuses', () => {
    const centreOnly = view({ evaluation: evaluate({ center_frequency_hz: '433.92' }) });
    expect(centreOnly).toContain('Harus sama dengan frekuensi tengah saat tengah diubah');
    expect(centreOnly).toMatch(/<button class="ov-button is-primary is-wide" type="button" disabled="">/);
    const draft = draftWithCenter({}, '433.92', REPORTED.values);
    const together = view({ evaluation: evaluate(draft) });
    expect(together).toContain('Diubah dari 416.588 MHz');
    expect(together).toMatch(/<button class="ov-button is-primary is-wide" type="button">Tinjau perubahan<\/button>/);
    // An unchanged VFO0 that equals the new centre is sent along.
    const reportedVfo = normalizeConfigReported(reportedBody({ values: { center_frequency_hz: 416_588_000, gain_db: 15.7, vfo0_frequency_hz: 433_920_000 } }));
    expect(view({ evaluation: evaluate({ center_frequency_hz: '433.92' }, reportedVfo) })).toContain('Dikirim bersama frekuensi tengah');
    expect(view({ evaluation: evaluate({ vfo0_squelch_db: '99' }) })).toContain('Di luar −200 s/d 50 dB');
    expect(view({ evaluation: evaluate({ gain_db: '20' }) })).toContain('Bukan nilai dari tabel gain RDF-SDR');
    expect(view({ evaluation: evaluate({ center_frequency_hz: '1800', vfo0_frequency_hz: '1800' }) })).toContain('Di luar 24 s/d 1766 MHz');
  });

  it('reports an unavailable MQTT publish path', () => {
    const reported = normalizeConfigReported({ available: false, code: 'MQTT_DEPENDENCY_MISSING', broker: { connection: 'error' } });
    const markup = view({ reported, evaluation: evaluate({}, reported) });
    expect(markup).toContain('paho-mqtt belum terpasang di host console');
    expect(markup).toMatch(/disabled="">Baca settings<\/button>/);
  });

  it('warns when the node reports no settings target', () => {
    const reported = normalizeConfigReported(reportedBody({ node: { ...NODE, remote_config_patch: false } }));
    expect(view({ reported })).toContain('remote_config_patch false');
  });
});

describe('Kontrol review and send', () => {
  const evaluation = evaluate(draftWithCenter({}, '433.92', REPORTED.values));
  const review = { changes: evaluation.changes, rev: 42, rows: reviewRows(t, evaluation.fields) };

  it('lists from and to with the edge keys, QoS, expiry and base revision', () => {
    expect(evaluation.changes).toEqual({ center_frequency_hz: 433_920_000, vfo0_frequency_hz: 433_920_000 });
    const markup = view({ stage: 'review', review, evaluation });
    expect(markup).toContain('2 perubahan akan dikirim');
    expect(markup).toContain('Frekuensi tengah <span class="ov-mono ov-control-key">center_frequency_hz</span>');
    expect(markup).toContain('Frekuensi VFO <span class="ov-mono ov-control-key">vfo0_frequency_hz</span>');
    expect(markup).toContain('416.588 MHz → <b>433.920 MHz</b>');
    expect(markup).toContain('QoS 1 · kedaluwarsa 15 dtk · rev dasar 42');
    expect(markup).not.toContain('--enable-config');
    expect(markup).toMatch(/<button class="ov-button is-send is-wide" type="button"><svg[\s\S]*?<span>Kirim ke RDF-SDR<\/span><\/button>/);
    expect(markup).toContain('>Kembali</button>');
  });

  it('blocks the send without a connected monitor, a node, a base revision or fresh health', () => {
    const disconnected = normalizeConfigReported(reportedBody({ broker: { host: '10.90.0.1', port: 9001, connection: 'connecting' } }));
    expect(view({ stage: 'review', review, evaluation, reported: disconnected })).toMatch(/Kirim butuh monitor MQTT yang terhubung[\s\S]*is-send is-wide" type="button" disabled=""/);
    const noNode = normalizeConfigReported(reportedBody({ node: null }));
    expect(view({ stage: 'review', review, evaluation, reported: noNode })).toContain('Kirim butuh state RDF-SDR lewat MQTT.');
    expect(view({ stage: 'review', review: { ...review, rev: null }, evaluation })).toContain('Kirim butuh revisi konfigurasi (state.cfg) RDF-SDR.');
    const stale = normalizeConfigReported(reportedBody({ node: { ...NODE, health_fresh: false, health_age_ms: 20_000 } }));
    const staleMarkup = view({ stage: 'review', review, evaluation, reported: stale });
    expect(staleMarkup).toContain('Kirim butuh telemetry/health yang segar dari RDF-SDR.');
    expect(staleMarkup).toMatch(/is-send is-wide" type="button" disabled=""/);
    const noPublish = { ...CAPABILITIES, configPatch: CAPABILITIES.configPatch ? { ...CAPABILITIES.configPatch, enabled: false } : null };
    const blocked = view({ stage: 'review', review, evaluation, capabilities: noPublish });
    expect(blocked).toContain('Patch konfigurasi tidak tersedia: monitor MQTT mati atau paho-mqtt belum terpasang.');
    expect(blocked).toMatch(/is-send is-wide" type="button" disabled=""/);
  });

  it('shows the command id and the edge progress while waiting for the result', () => {
    expect(view({ stage: 'sending', sending: { commandId: null, count: 2, baseRev: 42, status: null } })).toContain('Mengirim ke console…');
    const markup = view({ stage: 'sending', sending: { commandId: 'gc-0123', count: 2, baseRev: 42, status: null } });
    expect(markup).toContain('Terkirim ke broker. Menunggu <span class="ov-mono">sdr/v2/uav-01/ack/config</span> untuk <span class="ov-mono">gc-0123</span>…');
    const accepted = normalizeConfigCommandStatus({ command_id: 'gc-0123', op: 'config.patch', state: 'acknowledged', changes: {}, ack: { status: 'ACCEPTED', final: false } });
    expect(view({ stage: 'sending', sending: { commandId: 'gc-0123', count: 2, baseRev: 42, status: accepted } })).toContain('<span class="ov-mono ov-control-state">ACCEPTED</span>');
    const delivered = normalizeConfigCommandStatus({ command_id: 'gc-0123', op: 'config.patch', state: 'delivered', changes: {} });
    expect(view({ stage: 'sending', sending: { commandId: 'gc-0123', count: 2, baseRev: 42, status: delivered } })).toContain('<span class="ov-mono ov-control-state">delivered</span>');
  });
});

describe('Kontrol results', () => {
  const done = (state: string, ack: CommandStatusLike['ack'], pubackReason: number | null = null) => ({
    view: commandResultView({ state, ack, pubackReason }, 2, 42, 15),
    error: null,
    commandId: 'gc-0123',
    restarted: false,
  });
  const ack = (status: string, error: string | null = null, reason: string | null = null) => ({ status, error, reason, revision: status === 'APPLIED' || status === 'PERSISTED_UNVERIFIED' ? 43 : null });

  it('reports APPLIED as the only success', () => {
    const markup = view({ stage: 'done', done: done('acked', ack('APPLIED')) });
    expect(markup).toContain('ov-control-result tone-ok');
    expect(markup).toContain('ACK · APPLIED');
    expect(markup).toContain('RDF-SDR menerapkan 2 perubahan dan melihatnya berlaku. Config rev sekarang 43.');
    expect(markup).toContain('>Selesai</button>');
    expect(markup).not.toContain('Baca ulang nilai');
  });

  it('keeps PERSISTED_UNVERIFIED, OUTCOME_UNKNOWN and a missing final ACK apart from success and failure', () => {
    const persisted = view({ stage: 'done', done: done('acked', ack('PERSISTED_UNVERIFIED', null, 'NATIVE_RUNTIME_EVIDENCE_INCOMPLETE')) });
    expect(persisted).toContain('ov-control-result tone-info');
    expect(persisted).toContain('ACK · PERSISTED_UNVERIFIED · NATIVE_RUNTIME_EVIDENCE_INCOMPLETE');
    expect(persisted).toContain('Tersimpan di settings.json (rev 43)');
    expect(persisted).toContain('>Baca ulang nilai</button>');
    const unknown = view({ stage: 'done', done: done('acked', ack('OUTCOME_UNKNOWN', 'HELPER_TIMEOUT')) });
    expect(unknown).toContain('ov-control-result tone-info');
    expect(unknown).toContain('ACK · OUTCOME_UNKNOWN · HELPER_TIMEOUT');
    expect(unknown).toContain('Jangan kirim ulang; baca settings dulu.');
    const noFinal = view({ stage: 'done', done: done('no_final_ack', { status: 'ACCEPTED', error: null, reason: null, revision: null }) });
    expect(noFinal).toContain('ov-control-result tone-info');
    expect(noFinal).toContain('Tidak ada ACK akhir');
    expect(noFinal).toContain('RDF-SDR menjawab ACCEPTED tetapi tidak mengirim hasil.');
  });

  it('reports a stale base revision with what to do', () => {
    const conflict = view({ stage: 'done', done: done('acked', ack('REJECTED', 'CONFIG_REVISION_CONFLICT')) });
    expect(conflict).toContain('ov-control-result tone-warn');
    expect(conflict).toContain('Ditolak · REJECTED · CONFIG_REVISION_CONFLICT');
    expect(conflict).toContain('Settings di RDF-SDR berubah setelah rev dasar 42 dibaca. Tidak ada yang diubah. Baca ulang nilai, tinjau, lalu kirim.');
    expect(conflict).toContain('>Baca ulang nilai</button>');
    const external = view({ stage: 'done', done: done('acked', ack('CONFLICT', 'EXTERNAL_WRITER_CONFLICT')) }, 'en');
    expect(external).toContain('Rejected · CONFLICT · EXTERNAL_WRITER_CONFLICT');
    expect(external).toContain('settings.json changed on RDF-SDR during the write');
  });

  it('shows the edge error code of a refusal, an expiry, a cancel and a failure', () => {
    const tls = view({ stage: 'done', done: done('acked', ack('REJECTED', 'BUSY')) });
    expect(tls).toContain('Ditolak · REJECTED · BUSY');
    expect(tls).toContain('rdf-ground.service');
    const unknownCode = view({ stage: 'done', done: done('acked', ack('REJECTED', 'SOMETHING_NEW')) });
    expect(unknownCode).toContain('Ditolak · REJECTED · SOMETHING_NEW');
    expect(unknownCode).toContain('RDF-SDR menolak perubahan. Tidak ada yang diubah.');
    const expired = view({ stage: 'done', done: done('acked', ack('EXPIRED', 'EXPIRED_OR_INVALID_DEADLINE')) });
    expect(expired).toContain('ACK · EXPIRED · EXPIRED_OR_INVALID_DEADLINE');
    expect(expired).toContain('Perintah kedaluwarsa sebelum RDF-SDR menerapkannya.');
    expect(view({ stage: 'done', done: done('acked', ack('CANCELLED')) })).toContain('Perintah dibatalkan di RDF-SDR.');
    const failed = view({ stage: 'done', done: done('acked', ack('FAILED', 'GAIN_NOT_IN_APPROVED_TABLE')) });
    expect(failed).toContain('ov-control-result tone-err');
    expect(failed).toContain('ACK · FAILED · GAIN_NOT_IN_APPROVED_TABLE');
    expect(failed).toContain('RDF-SDR hanya menerima nilai dari tabel gain-nya.');
  });

  it('reports no ACK and a refused publish', () => {
    const noAck = view({ stage: 'done', done: done('no_ack', null) });
    expect(noAck).toContain('Belum ada ACK');
    expect(noAck).toContain('Tidak ada ack/config sebelum perintah kedaluwarsa (15 dtk).');
    expect(view({ stage: 'done', done: done('publish_failed', null, 135) })).toContain('PUBACK 135');
  });

  it('reports a refused request by its code', () => {
    const markup = view({ stage: 'done', done: { view: null, error: { code: 'COMMAND_IN_FLIGHT', message: { key: 'control.error.COMMAND_IN_FLIGHT' } }, commandId: 'gc-9', restarted: false } }, 'en');
    expect(markup).toContain('Not sent · COMMAND_IN_FLIGHT');
    expect(markup).toContain('Another config patch is still waiting for its result.');
    expect(markup).toContain('gc-9');
    const failure = controlFailure(new ApiError('nope', 409, 'NODE_NOT_FRESH'));
    expect(failure).toEqual({ code: 'NODE_NOT_FRESH', message: { key: 'control.error.NODE_NOT_FRESH' } });
    expect(controlFailure(new ApiError('odd', 400, 'NEW_CODE')).message).toEqual({ key: 'control.error.unknown', vars: { error: 'odd' } });
  });

  it('shows a stale revision and a stale node in the form', () => {
    expect(view({ editError: { code: 'CONFIG_REVISION_STALE', message: { key: 'control.error.CONFIG_REVISION_STALE' } } })).toContain('Revisi konfigurasi RDF-SDR berubah sejak ditinjau.');
    expect(view({ editError: { code: 'NODE_NOT_FRESH', message: { key: 'control.error.NODE_NOT_FRESH' } } })).toContain('RDF-SDR tidak mengirim telemetry/health yang segar.');
  });
});

describe('Kontrol read-back from the RDF-SDR', () => {
  const changes = { center_frequency_hz: 433_920_000, vfo0_frequency_hz: 433_920_000, vfo0_squelch_db: -70 };
  const applied = {
    view: commandResultView({ state: 'acked', ack: { status: 'APPLIED', error: null, reason: null, revision: 43 }, pubackReason: null }, 3, 42, 15),
    error: null,
    commandId: 'gc-0123',
    restarted: false,
  };
  const node: TelemetrySnapshot = { settings: { available: true, fields: { center_freq: 433.92, vfo_freq_0: 433_900_000 } } };
  const check = (overrides: Partial<VerifyInput> = {}) => verifyConfigPatch({
    changes, issuedAtMs: SETTINGS_AT + 1_000, finalAtMs: 0, nowMs: 1_000, reported: REPORTED, snapshot: node, snapshotFresh: true, ...overrides,
  });

  it('lists each sent field with its settings/reported and Data Out values and a status code', () => {
    const markup = view({ stage: 'done', done: applied, verification: check(), onRecheck: () => undefined });
    expect(markup).toContain('aria-label="Cek RDF-SDR"');
    expect(markup).toContain('role="status">Memeriksa RDF-SDR · 1/3</span>');
    expect(markup).toMatch(/Frekuensi tengah<\/span><span class="ov-tag tone-good">CONFIRMED<\/span>/);
    expect(markup).toMatch(/Frekuensi VFO<\/span><span class="ov-tag tone-info">PENDING<\/span>/);
    expect(markup).toMatch(/Squelch VFO<\/span><span class="ov-tag tone-neutral">NOT REPORTED<\/span>/);
    expect(markup).toContain('<dt>Dikirim</dt><dd class="ov-mono">433.920 MHz</dd>');
    expect(markup).toContain('<dt>Data Out</dt><dd class="ov-mono">433.900 MHz</dd>');
    // This settings report arrived before the command, so it is not evidence.
    expect(markup).toContain('<dt>MQTT</dt><dd class="ov-mono">—</dd>');
    expect(markup).toMatch(/<button class="ov-button" type="button"><svg[\s\S]*?<span>Cek ulang<\/span><\/button>/);
  });

  it('takes a settings report received after the command first', () => {
    const after = normalizeConfigReported(reportedBody({
      values: { center_frequency_hz: 433_920_000, gain_db: 15.7, vfo0_frequency_hz: 433_920_000, vfo0_squelch_db: -70 },
      value_received_at_ms: { center_frequency_hz: SETTINGS_AT + 5_000, gain_db: SETTINGS_AT + 5_000, vfo0_frequency_hz: SETTINGS_AT + 5_000, vfo0_squelch_db: SETTINGS_AT + 5_000 },
    }));
    const verification = check({ reported: after });
    expect(verification.fields.every((field) => field.basis === 'mqtt' && field.status === 'confirmed')).toBe(true);
    const markup = view({ stage: 'done', done: applied, verification });
    expect(markup).toContain('RDF-SDR berubah · 3/3');
    expect(markup).toContain('<dt>MQTT</dt><dd class="ov-mono">433.920 MHz</dd>');
  });

  it('reads the verdict once the window has ended', () => {
    const after = view({ stage: 'done', done: applied, verification: check({ nowMs: 90_000 }) });
    expect(after).toContain('Sebagian berubah · 1/3');
    expect(after).toContain('>UNCHANGED</span>');
    const confirmed = check({ changes: { center_frequency_hz: 433_920_000 } });
    expect(view({ stage: 'done', done: applied, verification: confirmed })).toContain('RDF-SDR berubah · 1/1');
    expect(view({ stage: 'done', done: applied, verification: confirmed }, 'en')).toContain('RDF-SDR changed · 1/1');
    const unchanged = check({ changes: { vfo0_frequency_hz: 433_925_000 }, nowMs: 90_000 });
    expect(view({ stage: 'done', done: applied, verification: unchanged })).toContain('Belum berubah · 0/1');
  });

  it('shows the read-back after a rejection, and nothing without one', () => {
    const rejected = { ...applied, view: commandResultView({ state: 'acked', ack: { status: 'REJECTED', error: 'REMOTE_COMMANDS_DISABLED', reason: null, revision: null }, pubackReason: null }, 3, 42, 15) };
    expect(view({ stage: 'done', done: rejected, verification: check({ nowMs: 90_000 }) })).toContain('Sebagian berubah · 1/3');
    expect(view({ stage: 'done', done: applied })).not.toContain('ov-verify');
  });

  it('fills the values settings/reported does not carry from Data Out', () => {
    const dataOut = dataOutConfigValues({ settings: { available: true, fields: { center_freq: 415.7882, vfo_freq_0: 433_925_000, vfo_bw_0: 12_500, vfo_squelch_0: -80 } } }, true);
    const values = currentConfigValues(REPORTED.values, dataOut);
    const ranges = CAPABILITIES.configPatch?.ranges ?? null;
    const markup = view({ evaluation: parseDraft(CONFIG_PATCH_FIELDS, draftFromReported(values), values, ranges) });
    // settings/reported still wins for the centre and VFO frequency.
    expect(markup).toContain('value="416.588"');
    expect(markup).not.toContain('value="433.925"');
    expect(markup).toContain('value="12.5"');
    expect(markup).toContain('value="-80"');
    expect(markup).not.toContain('tidak dilaporkan');
    const edited = parseDraft(CONFIG_PATCH_FIELDS, { ...draftFromReported(values), vfo0_bandwidth_hz: '25' }, values, ranges);
    expect(reviewRows(t, edited.fields)).toEqual([{ key: 'vfo0_bandwidth_hz', label: 'Bandwidth VFO', from: '12.5 kHz', to: '25.0 kHz' }]);
  });
});
