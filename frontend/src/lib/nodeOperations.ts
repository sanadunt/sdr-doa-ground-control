/**
 * Kontrol's operations on the RDF-SDR (owner's decision of 2026-11-04): start
 * or stop the RDF processing (processing.set), restart the RDF service
 * (service.restart), and reboot or shut down the Raspberry in the edge's two
 * steps (system.reboot.prepare then .execute, the same for shutdown). The
 * server builds the envelopes and holds a prepare's one-time challenge; the
 * browser names only the operation, `desired`, or the prepare's command id.
 *
 * Each button shows only while the node's capabilities allow it
 * (remote_processing, remote_restart, remote_reboot, remote_shutdown). A click
 * opens a confirm box (Cancel first with the focus, Escape cancels); a reboot
 * or shutdown also needs the drone check ticked, then a second confirmation
 * once the RDF-SDR answered the prepare, within its challenge's lifetime.
 * Nothing is sent again on its own.
 */
import type { ConfigCommandStatus, ConfigNodeView, NodeOperationRequest } from '../api';
import { commandResultView } from './configPatch';
import type { CommandFailure, CommandResultView } from './configPatch';

export const NODE_ACTIONS = ['start', 'stop', 'restart', 'reboot', 'shutdown'] as const;
export type NodeAction = typeof NODE_ACTIONS[number];
/** The two actions that take the Raspberry down: two steps and the drone check. */
export type HostAction = 'reboot' | 'shutdown';

type Capability = 'remoteProcessing' | 'remoteRestart' | 'remoteReboot' | 'remoteShutdown';

interface ActionSpec {
  request: NodeOperationRequest;
  capability: Capability;
}

const SPECS: Readonly<Record<NodeAction, ActionSpec>> = {
  start: { request: { op: 'processing.set', desired: 'RUNNING' }, capability: 'remoteProcessing' },
  stop: { request: { op: 'processing.set', desired: 'STOPPED' }, capability: 'remoteProcessing' },
  restart: { request: { op: 'service.restart' }, capability: 'remoteRestart' },
  reboot: { request: { op: 'system.reboot.prepare' }, capability: 'remoteReboot' },
  shutdown: { request: { op: 'system.shutdown.prepare' }, capability: 'remoteShutdown' },
};

const EXECUTE_OPS = { reboot: 'system.reboot.execute', shutdown: 'system.shutdown.execute' } as const;

/** The edge's ACK window for a command (30 s, the console's TTL). */
const OPERATION_TTL_S = 30;

export function isHostAction(action: NodeAction): action is HostAction {
  return action === 'reboot' || action === 'shutdown';
}

/** The request the first click sends: the operation, or a reboot's or shutdown's prepare. */
export function firstRequest(action: NodeAction): NodeOperationRequest {
  return { ...SPECS[action].request };
}

export function executeRequest(action: HostAction, prepareId: string): NodeOperationRequest {
  return { op: EXECUTE_OPS[action], prepareId };
}

/** The actions the node's capabilities allow, in Kontrol's order. */
export function availableActions(node: ConfigNodeView | null): NodeAction[] {
  if (!node) return [];
  return NODE_ACTIONS.filter((action) => node[SPECS[action].capability] === true);
}

/** Start while the engine already runs (or starts), Stop while it is stopped (or stopping), say nothing new. */
export function redundantAction(action: NodeAction, run: string | null): boolean {
  if (action === 'start') return run === 'RUNNING' || run === 'STARTING';
  if (action === 'stop') return run === 'STOPPED' || run === 'STOPPING';
  return false;
}

export type OpsStep =
  | { stage: 'closed' }
  /** The confirm box; a host action needs `droneChecked` before it sends. */
  | { stage: 'confirm'; action: NodeAction; droneChecked: boolean }
  /** Posted (commandId null until the console answered) and waiting for the final state. */
  | { stage: 'sending'; action: NodeAction; phase: 'single' | 'prepare' | 'execute'; commandId: string | null; status: ConfigCommandStatus | null }
  /** A prepare the RDF-SDR answered APPLIED: the second confirmation, until `validUntilMs` on the local clock. */
  | { stage: 'ready'; action: HostAction; prepareId: string; validUntilMs: number }
  | { stage: 'done'; action: NodeAction; status: ConfigCommandStatus | null; failure: CommandFailure | null; expired?: boolean };

export const OPS_CLOSED: OpsStep = { stage: 'closed' };

export type OpsEvent =
  | { type: 'open'; action: NodeAction }
  | { type: 'drone'; checked: boolean }
  | { type: 'cancel' }
  | { type: 'post' }
  | { type: 'posted'; commandId: string }
  | { type: 'status'; status: ConfigCommandStatus; localNowMs: number }
  | { type: 'failed'; failure: CommandFailure }
  | { type: 'expired' };

/** Whether the confirm box may send now. */
export function canConfirm(step: OpsStep): boolean {
  if (step.stage === 'ready') return true;
  return step.stage === 'confirm' && (!isHostAction(step.action) || step.droneChecked);
}

/** The next step; a stale event (a status of another command, a click while sending) changes nothing. */
export function opsStep(step: OpsStep, event: OpsEvent): OpsStep {
  switch (event.type) {
    case 'open':
      return step.stage === 'closed' || step.stage === 'done' ? { stage: 'confirm', action: event.action, droneChecked: false } : step;
    case 'drone':
      return step.stage === 'confirm' ? { ...step, droneChecked: event.checked } : step;
    case 'cancel':
      // Nothing is withdrawn once sent; a ready prepare simply runs out on the RDF-SDR.
      return step.stage === 'confirm' || step.stage === 'ready' || step.stage === 'done' ? OPS_CLOSED : step;
    case 'post':
      if (step.stage === 'confirm' && canConfirm(step)) {
        return { stage: 'sending', action: step.action, phase: isHostAction(step.action) ? 'prepare' : 'single', commandId: null, status: null };
      }
      if (step.stage === 'ready') return { stage: 'sending', action: step.action, phase: 'execute', commandId: null, status: null };
      return step;
    case 'posted':
      return step.stage === 'sending' && step.commandId === null ? { ...step, commandId: event.commandId } : step;
    case 'status': {
      if (step.stage !== 'sending' || event.status.commandId !== step.commandId) return step;
      const status = event.status;
      if (!status.final) return { ...step, status };
      if (step.phase === 'prepare' && isHostAction(step.action) && status.state === 'acked' && status.ack?.status === 'APPLIED') {
        // The server's clock says how long the challenge lasts; count it down on this one. Without one
        // (it ran out on the way, or the console's monitor was replaced) the prepare cannot be used.
        const left = status.prepareValidUntilMs !== null && status.nowMs !== null ? status.prepareValidUntilMs - status.nowMs : 0;
        if (left > 0) return { stage: 'ready', action: step.action, prepareId: status.commandId, validUntilMs: event.localNowMs + left };
        return { stage: 'done', action: step.action, status: null, failure: null, expired: true };
      }
      return { stage: 'done', action: step.action, status, failure: null };
    }
    case 'failed':
      return step.stage === 'sending' ? { stage: 'done', action: step.action, status: step.status, failure: event.failure } : step;
    case 'expired':
      return step.stage === 'ready' ? { stage: 'done', action: step.action, status: null, failure: null, expired: true } : step;
    default:
      return step;
  }
}

const SUCCESS_KEYS = {
  start: { title: 'ops.result.startedTitle', body: 'ops.result.started' },
  stop: { title: 'ops.result.stoppedTitle', body: 'ops.result.stopped' },
  restart: { title: 'ops.result.restartedTitle', body: 'ops.result.restarted' },
} as const;

/**
 * How a final operation reads. APPLIED of a lifecycle operation and a
 * scheduled reboot or shutdown are the successes; every other answer reads as
 * a config patch's would (refusals, timeouts, the edge's own sentence).
 */
export function operationResultView(action: NodeAction, status: ConfigCommandStatus): CommandResultView {
  const ack = status.ack;
  const code = ack ? [ack.status, ack.error ?? ack.reason].filter(Boolean).join(' · ') : null;
  if (status.state === 'acked' && ack?.status === 'APPLIED' && !isHostAction(action)) {
    const keys = SUCCESS_KEYS[action];
    return { tone: 'ok', title: { key: keys.title }, body: { key: keys.body }, code, reload: false };
  }
  if (status.state === 'acked' && (ack?.status === 'REBOOT_SCHEDULED' || ack?.status === 'SHUTDOWN_SCHEDULED')) {
    const reboot = ack.status === 'REBOOT_SCHEDULED';
    return {
      tone: 'ok',
      title: { key: reboot ? 'ops.result.rebootTitle' : 'ops.result.shutdownTitle' },
      body: { key: reboot ? 'ops.result.reboot' : 'ops.result.shutdown', vars: { delay: ack.delaySeconds ?? 5 } },
      code,
      reload: false,
    };
  }
  if (ack?.status === 'OUTCOME_UNKNOWN' && ack.reason === 'LIFECYCLE_VERIFICATION_TIMEOUT') {
    return { tone: 'info', title: { key: 'control.result.title.unknown' }, body: { key: 'ops.result.lifecycleTimeout' }, code, reload: false };
  }
  if (status.state === 'no_ack' || (!ack && status.state !== 'publish_failed' && status.state !== 'no_final_ack')) {
    return { tone: 'err', title: { key: 'control.result.noAckTitle' }, body: { key: 'ops.result.noAck', vars: { ttl: OPERATION_TTL_S } }, code: 'NO ACK', reload: false };
  }
  // Values on the node did not change: never offer a settings reload for an operation.
  return { ...commandResultView(status, 0, null, OPERATION_TTL_S), reload: false };
}
