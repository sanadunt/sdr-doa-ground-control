import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getOperationStatus, normalizeConfigCommandStatus, normalizeConfigReported, sendNodeOperation } from '../api';
import type { ConfigCommandStatus, ConfigReported } from '../api';
import { NodeOperationsView } from '../components/overview/NodeOperations';
import type { NodeOperationsViewProps } from '../components/overview/NodeOperations';
import { commandFailure } from './configPatch';
import { I18nContext, translate } from './i18n';
import type { Lang } from './i18n';
import {
  OPS_CLOSED, availableActions, canConfirm, executeRequest, firstRequest, operationResultView, opsStep, redundantAction,
} from './nodeOperations';
import type { OpsStep } from './nodeOperations';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<{ status: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const NODE = {
  sid: '0a1b2c3d', cfg: 42, health_fresh: true, health_age_ms: 900, remote_commands: true, remote_config_patch: true,
  remote_processing: true, remote_restart: true, remote_reboot: true, remote_shutdown: false, run: 'RUNNING',
};

function reported(node: Record<string, unknown> | null = NODE, connection = 'connected'): ConfigReported {
  return normalizeConfigReported({
    available: true, now_ms: 100_000, broker: { host: '127.0.0.1', port: 1883, transport: 'tcp', connection },
    node, base_rev: 42, settings: null, values: {}, value_sources: {}, value_received_at_ms: {}, pending_command_id: null,
    settings_request: null,
  });
}

const PREPARE_ID = 'gc-000000000000000000000aaa';

function status(overrides: Record<string, unknown> = {}): ConfigCommandStatus {
  const value = normalizeConfigCommandStatus({
    command_id: PREPARE_ID, op: 'system.reboot.prepare', topic: 'sdr/v2/uav-01/cmd/system/reboot/prepare', state: 'acked',
    now_ms: 50_000, issued_ms: 40_000, expires_ms: 70_000, base_rev: 42, changes: {}, puback_reason: 0, monitor_restarted: false,
    ack: { status: 'APPLIED', final: true, error: null, reason: null, revision: 42, proof: null, persisted: null, valid_seconds: 30, t: 1, received_at_ms: 49_000 },
    sid: '0a1b2c3d', desired: null, prepare_id: null, prepare_valid_until_ms: 71_000,
    ...overrides,
  });
  if (!value) throw new Error('bad status');
  return value;
}

function view(props: Partial<NodeOperationsViewProps> = {}, lang: Lang = 'id'): string {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ lang, setLang: noop, t: (key, vars) => translate(lang, key, vars) }}>
      <NodeOperationsView reported={reported()} step={OPS_CLOSED} onOpen={noop} onDrone={noop} onConfirm={noop} onCancel={noop} {...props} />
    </I18nContext.Provider>,
  );
}

describe('the operations a node takes', () => {
  it('shows only what the capabilities allow, in order', () => {
    const node = reported().node;
    expect(availableActions(node)).toEqual(['start', 'stop', 'restart', 'reboot']);
    expect(availableActions(reported({ ...NODE, remote_processing: false, remote_reboot: null }).node)).toEqual(['restart']);
    expect(availableActions(null)).toEqual([]);
    // Capabilities not received yet (null) grant nothing.
    expect(availableActions(reported({ sid: '0a1b2c3d', cfg: 1, health_fresh: true }).node)).toEqual([]);
  });

  it('asks the server for the operation, desired state or prepare, never a challenge', () => {
    expect(firstRequest('start')).toEqual({ op: 'processing.set', desired: 'RUNNING' });
    expect(firstRequest('stop')).toEqual({ op: 'processing.set', desired: 'STOPPED' });
    expect(firstRequest('restart')).toEqual({ op: 'service.restart' });
    expect(firstRequest('reboot')).toEqual({ op: 'system.reboot.prepare' });
    expect(executeRequest('shutdown', PREPARE_ID)).toEqual({ op: 'system.shutdown.execute', prepareId: PREPARE_ID });
  });

  it('does not offer a start that is already running or a stop that is stopped', () => {
    expect(redundantAction('start', 'RUNNING')).toBe(true);
    expect(redundantAction('start', 'STOPPED')).toBe(false);
    expect(redundantAction('stop', 'STOPPING')).toBe(true);
    expect(redundantAction('stop', null)).toBe(false);
    expect(redundantAction('restart', 'STOPPED')).toBe(false);
  });
});

describe('opsStep', () => {
  it('confirms a single operation and follows its status to the end', () => {
    let step: OpsStep = opsStep(OPS_CLOSED, { type: 'open', action: 'stop' });
    expect(step).toEqual({ stage: 'confirm', action: 'stop', droneChecked: false });
    expect(canConfirm(step)).toBe(true);
    step = opsStep(step, { type: 'post' });
    expect(step).toMatchObject({ stage: 'sending', phase: 'single', commandId: null });
    step = opsStep(step, { type: 'posted', commandId: 'gc-1' });
    // Another command's status changes nothing.
    expect(opsStep(step, { type: 'status', status: status({ command_id: 'gc-2', state: 'delivered' }), localNowMs: 0 })).toBe(step);
    step = opsStep(step, { type: 'status', status: status({ command_id: 'gc-1', op: 'processing.set', state: 'acknowledged' }), localNowMs: 0 });
    expect(step).toMatchObject({ stage: 'sending', status: { state: 'acknowledged' } });
    // Cancel does nothing while a command is on its way.
    expect(opsStep(step, { type: 'cancel' })).toBe(step);
    step = opsStep(step, { type: 'status', status: status({ command_id: 'gc-1', op: 'processing.set' }), localNowMs: 0 });
    expect(step).toMatchObject({ stage: 'done', action: 'stop' });
    expect(opsStep(step, { type: 'cancel' })).toEqual(OPS_CLOSED);
  });

  it('needs the drone check, then a second confirmation within the challenge', () => {
    let step: OpsStep = opsStep(OPS_CLOSED, { type: 'open', action: 'reboot' });
    expect(canConfirm(step)).toBe(false);
    expect(opsStep(step, { type: 'post' })).toBe(step);
    step = opsStep(step, { type: 'drone', checked: true });
    expect(canConfirm(step)).toBe(true);
    step = opsStep(step, { type: 'post' });
    expect(step).toMatchObject({ stage: 'sending', phase: 'prepare' });
    step = opsStep(step, { type: 'posted', commandId: PREPARE_ID });
    // 21 s of the challenge are left by the server's clock; counted on the local one.
    step = opsStep(step, { type: 'status', status: status(), localNowMs: 1_000 });
    expect(step).toEqual({ stage: 'ready', action: 'reboot', prepareId: PREPARE_ID, validUntilMs: 22_000 });
    expect(canConfirm(step)).toBe(true);
    const executing = opsStep(step, { type: 'post' });
    expect(executing).toMatchObject({ stage: 'sending', phase: 'execute', commandId: null });
    // Running out, or Cancel, sends nothing.
    expect(opsStep(step, { type: 'expired' })).toMatchObject({ stage: 'done', expired: true });
    expect(opsStep(step, { type: 'cancel' })).toEqual(OPS_CLOSED);
  });

  it('ends a prepare without a usable challenge, or one the RDF-SDR refused', () => {
    const sending: OpsStep = { stage: 'sending', action: 'reboot', phase: 'prepare', commandId: PREPARE_ID, status: null };
    expect(opsStep(sending, { type: 'status', status: status({ prepare_valid_until_ms: null }), localNowMs: 0 }))
      .toMatchObject({ stage: 'done', expired: true });
    const refused = status({ ack: { status: 'REJECTED', final: true, error: 'BUSY', reason: null, revision: 42, t: 1, received_at_ms: 2 }, prepare_valid_until_ms: null });
    expect(opsStep(sending, { type: 'status', status: refused, localNowMs: 0 })).toMatchObject({ stage: 'done', status: { ack: { error: 'BUSY' } } });
    const failure = commandFailure(new ApiError('busy', 409, 'COMMAND_IN_FLIGHT'));
    expect(opsStep(sending, { type: 'failed', failure })).toMatchObject({ stage: 'done', failure: { code: 'COMMAND_IN_FLIGHT' } });
  });
});

describe('operationResultView', () => {
  const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars);

  it('reads the successes in the operator\'s words', () => {
    const started = operationResultView('start', status({ op: 'processing.set', ack: { status: 'APPLIED', final: true, proof: 'NEW_FRESH_DAQ_AND_UNIT_ACTIVE', desired: 'RUNNING' } }));
    expect([started.tone, t(started.title.key)]).toEqual(['ok', 'Processing running']);
    const scheduled = operationResultView('reboot', status({
      op: 'system.reboot.execute', ack: { status: 'REBOOT_SCHEDULED', final: false, delay_seconds: 5 },
    }));
    expect([scheduled.tone, t(scheduled.body.key, scheduled.body.vars)])
      .toEqual(['ok', 'RDF-SDR reboots in 5 s and comes back as a new session; telemetry pauses meanwhile.']);
    expect(scheduled.reload).toBe(false);
  });

  it('keeps unknown, refused and unanswered commands apart from success', () => {
    const timeout = operationResultView('restart', status({ op: 'service.restart', ack: { status: 'OUTCOME_UNKNOWN', final: true, reason: 'LIFECYCLE_VERIFICATION_TIMEOUT' } }));
    expect([timeout.tone, timeout.body.key]).toEqual(['info', 'ops.result.lifecycleTimeout']);
    const refused = operationResultView('reboot', status({
      op: 'system.reboot.execute', ack: { status: 'REJECTED', final: true, error: 'REBOOT_CHALLENGE_INVALID', message: 'Challenge reboot salah' },
    }));
    expect([refused.tone, refused.body.key, refused.message ?? null]).toEqual(['warn', 'control.edge.CHALLENGE_INVALID', null]);
    const quiet = operationResultView('stop', status({ op: 'processing.set', state: 'no_ack', ack: null }));
    expect([quiet.tone, t(quiet.body.key, quiet.body.vars)]).toEqual(['err', expect.stringContaining('ack/operation')]);
    const unapproved = operationResultView('start', status({ op: 'processing.set', ack: { status: 'FAILED', final: true, error: 'LIFECYCLE_NOT_APPROVED' } }));
    expect([unapproved.tone, unapproved.body.key, unapproved.reload]).toEqual(['err', 'control.edge.LIFECYCLE_NOT_APPROVED', false]);
  });
});

describe('the operation API', () => {
  it('posts the op, desired or prepare id with confirm, and reads the accepted command', async () => {
    const calls = fakeFetch([
      { status: 202, body: { ok: true, command_id: 'gc-1', op: 'processing.set', state: 'published', topic: 'sdr/v2/uav-01/cmd/processing/set', qos: 1, base_rev: 42, issued_ms: 1, expires_ms: 30_001, ttl_ms: 30_000, changes: {}, desired: 'STOPPED' } },
      { status: 202, body: { ok: true, command_id: 'gc-2', op: 'system.reboot.execute', state: 'published' } },
      { status: 202, body: { ok: true, command_id: 'gc-3', op: 'service.restart', state: 'published' } },
    ]);
    const accepted = await sendNodeOperation({ op: 'processing.set', desired: 'STOPPED' });
    expect([accepted.commandId, accepted.op]).toEqual(['gc-1', 'processing.set']);
    await sendNodeOperation({ op: 'system.reboot.execute', prepareId: PREPARE_ID });
    await sendNodeOperation({ op: 'service.restart' });
    expect(calls.map((call) => [call.url, call.init.method, call.init.credentials])).toEqual([
      ['/api/mqtt/operation', 'POST', 'same-origin'], ['/api/mqtt/operation', 'POST', 'same-origin'], ['/api/mqtt/operation', 'POST', 'same-origin'],
    ]);
    expect(calls.map((call) => JSON.parse(String(call.init.body)))).toEqual([
      { op: 'processing.set', confirm: true, desired: 'STOPPED' },
      { op: 'system.reboot.execute', confirm: true, prepare_id: PREPARE_ID },
      { op: 'service.restart', confirm: true },
    ]);
  });

  it('keeps the code of a refusal and reads an operation status', async () => {
    fakeFetch([
      { status: 409, body: { ok: false, code: 'PREPARE_EXPIRED', error: 'expired' } },
      { status: 200, body: { command_id: PREPARE_ID, op: 'system.reboot.prepare', state: 'acked', now_ms: 5, prepare_valid_until_ms: 20, sid: '0a1b2c3d', ack: { status: 'APPLIED', final: true } } },
    ]);
    await expect(sendNodeOperation({ op: 'system.reboot.execute', prepareId: PREPARE_ID })).rejects.toMatchObject({ code: 'PREPARE_EXPIRED' });
    const read = await getOperationStatus(PREPARE_ID);
    expect([read?.op, read?.prepareValidUntilMs, read?.sid, read?.final]).toEqual(['system.reboot.prepare', 20, '0a1b2c3d', true]);
  });

  it('reads the node flags and the engine state from config-reported', () => {
    const node = reported().node;
    expect([node?.remoteProcessing, node?.remoteRestart, node?.remoteReboot, node?.remoteShutdown, node?.run])
      .toEqual([true, true, true, false, 'RUNNING']);
  });
});

describe('NodeOperationsView', () => {
  it('renders nothing for a node that takes no operation', () => {
    expect(view({ reported: reported({ ...NODE, remote_processing: false, remote_restart: false, remote_reboot: false }) })).toBe('');
  });

  it('lists the allowed buttons with the engine state', () => {
    const markup = view({}, 'en');
    expect(markup).toContain('RDF-SDR operations');
    expect(markup).toContain('<span class="ov-mono">RUNNING</span>');
    expect(markup).toMatch(/disabled=""[^>]*><svg[^]*?<span>Start processing<\/span>/u);
    expect(markup).toContain('<span>Stop processing</span>');
    expect(markup).toContain('<span>Restart RDF service</span>');
    expect(markup).toContain('<span>Reboot RDF-SDR</span>');
    expect(markup).not.toContain('Shut down RDF-SDR');
  });

  it('blocks every button without a connected monitor or fresh health, and while a patch waits', () => {
    expect(view({ reported: reported(NODE, 'disconnected') }, 'en')).toContain('Send needs a connected MQTT monitor.');
    expect(view({ reported: reported({ ...NODE, health_fresh: false }) }, 'en')).toContain('Send needs fresh telemetry/health from RDF-SDR.');
    expect(view({ busy: true }, 'en')).toContain('Wait until the config patch has its result.');
  });

  it('asks a reboot with Cancel first, the drone check and a disabled confirm', () => {
    const markup = view({ step: { stage: 'confirm', action: 'reboot', droneChecked: false } });
    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain('Reboot RDF-SDR?');
    expect(markup).toContain('RDF-SDR mungkin sedang terbang di drone.');
    expect(markup).toContain('type="checkbox"');
    expect(markup.indexOf('>Batal</button>')).toBeLessThan(markup.indexOf('Siapkan reboot'));
    expect(markup).toMatch(/<button class="ov-button is-wide is-danger" type="button" disabled="">/u);
    const checked = view({ step: { stage: 'confirm', action: 'reboot', droneChecked: true } });
    expect(checked).not.toMatch(/<button class="ov-button is-wide is-danger" type="button" disabled="">/u);
  });

  it('shows the countdown of a prepared reboot and the scheduled result', () => {
    const ready = view({ step: { stage: 'ready', action: 'reboot', prepareId: PREPARE_ID, validUntilMs: 1 }, secondsLeft: 17 }, 'en');
    expect(ready).toContain('Confirm within 17 s');
    expect(ready).toContain('<span>Reboot now</span>');
    const done = view({ step: { stage: 'done', action: 'reboot', failure: null, status: status({
      op: 'system.reboot.execute', ack: { status: 'REBOOT_SCHEDULED', final: false, delay_seconds: 5 },
    }) } }, 'en');
    expect(done).toContain('Reboot scheduled');
    expect(done).toContain('>Close</button>');
    expect(view({ step: { stage: 'done', action: 'shutdown', status: null, failure: null, expired: true } }, 'en'))
      .toContain('The preparation ran out before it was confirmed, so nothing was run.');
  });
});
