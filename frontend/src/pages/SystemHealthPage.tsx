import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { RdfNodeMqttSnapshot, RdfNodeMqttTopic, SystemHealthSnapshot, Tone } from '../types';
import { RDF_NODE_MQTT_TOPICS } from '../types';
import {
  connectionTone,
  diagnosticObservationStatusAt,
  formatRelativeAge,
  isDiagnosticTopic,
  observationDisplayPayload,
  observationIsUnverified,
  observationStatusAt,
  statusTone,
} from '../lib/rdfNodeMqttPresentation';

import { systemHealthMqttReadings } from '../lib/systemHealthMqtt';
import type { SystemHealthMqttReading } from '../lib/systemHealthMqtt';
import {
  appendSystemHealthMqttHistory,
  MAX_SYSTEM_HEALTH_HISTORY_ENTRIES,
  parseSystemHealthHistoryRecords,
  parseSystemHealthMqttHistory,
  SYSTEM_HEALTH_HISTORY_STORAGE_KEY,
  SYSTEM_HEALTH_MQTT_HISTORY_STORAGE_KEY,
  systemHealthHistoryToCsv,
} from '../lib/systemHealthHistory';
import type { SystemHealthHistoryRecord, SystemHealthMqttHistoryValues } from '../lib/systemHealthHistory';
import { toneFor } from '../lib/telemetry';
import { Panel, StatusBadge } from '../components/ui';


function subsystemTone(state: string): Tone {
  switch (state) {
    case 'PRESENT':
    case 'UP':
    case 'REACHABLE':
      return 'good';
    case 'NO_REPLY':
    case 'NOT_PROBED':
    case 'AMBIGUOUS':
    case 'UNKNOWN':
    case 'CHECKING':
      return 'warn';
    case 'NOT_FOUND':
    case 'DOWN':
      return 'bad';
    default:
      return toneFor(state);
  }
}

type SignalGlyph = 'check' | 'warning' | 'cross' | 'question' | 'clock' | 'inactive' | 'neutral';

function glyphForState(label: string, tone: Tone): SignalGlyph {
  switch (label.toUpperCase()) {
    case 'UNKNOWN':
    case 'UNVERIFIED':
    case 'N/A':
      return 'question';
    case 'CHECKING':
    case 'WAITING':
      return 'clock';
    case 'NOT_PROBED':
    case 'OFF':
    case 'NOT CONFIGURED':
      return 'inactive';
    default:
      return tone === 'good' ? 'check' : tone === 'bad' ? 'cross' : tone === 'warn' ? 'warning' : 'neutral';
  }
}

function SignalMark({ glyph }: { glyph: SignalGlyph }): JSX.Element {
  let shape: JSX.Element;
  switch (glyph) {
    case 'check':
      shape = <path d="m3.2 8.1 3.1 3.1 6.5-6.5" />;
      break;
    case 'cross':
      shape = <path d="m4 4 8 8m0-8-8 8" />;
      break;
    case 'warning':
      shape = (
        <>
          <path d="M8 1.7 14.3 13H1.7L8 1.7Z" />
          <path d="M8 5.2v3.1m0 2h.01" />
        </>
      );
      break;
    case 'question':
      shape = (
        <>
          <circle cx="8" cy="8" r="6.1" />
          <path d="M6.4 6.3a1.7 1.7 0 1 1 2.8 1.3c-.7.5-1.2.8-1.2 1.9m0 2h.01" />
        </>
      );
      break;
    case 'clock':
      shape = (
        <>
          <circle cx="8" cy="8" r="6.1" />
          <path d="M8 4.4v3.8l2.3 1.4" />
        </>
      );
      break;
    case 'inactive':
      shape = <path d="M4.4 8h7.2" />;
      break;
    default:
      shape = <circle cx="8" cy="8" r="2.2" />;
  }
  return (
    <span className="health-signal__mark">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {shape}
      </svg>
    </span>
  );
}

function HealthSignal({ label, tone }: { label: string; tone: Tone }): JSX.Element {
  return (
    <span className="health-signal" data-tone={tone}>
      <SignalMark glyph={glyphForState(label, tone)} />
      <span className="health-signal__label">{label}</span>
    </span>
  );
}

type HealthRow = {
  indicator: string;
  value: string;
  tone?: Tone;
  detail?: string;
};

function telemetryRow(indicator: string, reading: SystemHealthMqttReading): HealthRow {
  return {
    indicator,
    value: reading.value,
    tone: reading.tone,
    detail: reading.detail,
  };
}
function HealthCheckList({ rows }: { rows: HealthRow[] }): JSX.Element {
  return (
    <ul className="system-health-checks">
      {rows.map((row) => (
        <li className="system-health-check" key={row.indicator}>
          <span className="system-health-check__label">{row.indicator}</span>
          <span className="system-health-check__value">
            {row.tone
              ? <HealthSignal label={row.value} tone={row.tone} />
              : <span className="system-health-number">{row.value}</span>}
          </span>
          <p className="system-health-check__detail">{row.detail ?? 'Not provided.'}</p>
        </li>
      ))}
    </ul>
  );
}

function DiagnosticObservation({
  title,
  freshness,
  rows,
}: {
  title: string;
  freshness: SystemHealthMqttReading;
  rows: HealthRow[];
}): JSX.Element {
  return (
    <section className="system-health-diagnostic-observation">
      <h5>
        <span>{title}</span>
        <HealthSignal label={freshness.value} tone={freshness.tone ?? 'neutral'} />
      </h5>
      <HealthCheckList rows={rows} />
    </section>
  );
}

function diagnosticRow(indicator: string, value: string, detail: string, tone: Tone = 'neutral'): HealthRow {
  return { indicator, value, tone, detail };
}

function dateForTimestamp(value: number | undefined): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function MqttTopicPayloads({ snapshot }: { snapshot: RdfNodeMqttSnapshot | null }): JSX.Element {
  const nowMs = Date.now();
  const connection = snapshot?.enabled ? snapshot.connection : snapshot ? 'disabled' : null;
  const latestReceivedAt = snapshot?.last_received_at_ms ?? null;
  const latestReceivedDate = dateForTimestamp(latestReceivedAt ?? undefined);

  return (
    <Panel className="system-health-mqtt-payloads" title="MQTT topic payloads">
      <div className="system-health-mqtt-payloads__connection">
        <span>Broker connection</span>
        <StatusBadge label={connection?.toUpperCase() ?? 'NO SNAPSHOT'} tone={connectionTone(connection)} />
        <span>Latest MQTT update</span>
        {latestReceivedDate
          ? <time dateTime={latestReceivedDate.toISOString()}>{latestReceivedDate.toLocaleString()}</time>
          : <span>Not received</span>}
        <span className="system-health-mqtt-payloads__age">{formatRelativeAge(latestReceivedAt, nowMs)}</span>
      </div>
      {snapshot?.last_error ? (
        <p className="system-health-mqtt-payloads__error">Subscription error: {snapshot.last_error}</p>
      ) : null}
      {!snapshot ? <p className="system-health-mqtt-payloads__empty">Waiting for an RDF Node MQTT snapshot.</p> : null}
      <p className="system-health-mqtt-payloads__note">
        Payload inspection is display-only. Receive timestamps show when this console observed a message; they do not verify its source or contents.
      </p>
      <ul className="system-health-mqtt-payloads__list">
        {RDF_NODE_MQTT_TOPICS.map((topic: RdfNodeMqttTopic) => {
          const observation = snapshot?.topics[topic];
          const status = !observation
            ? 'UNAVAILABLE'
            : isDiagnosticTopic(topic)
              ? diagnosticObservationStatusAt(topic, observation, snapshot, nowMs)
              : observationStatusAt(topic, observation, nowMs);
          const payload = observationDisplayPayload(observation);
          const candidate = observation?.status === 'INVALID' && payload !== null;
          const unverified = observationIsUnverified(observation);
          const receivedAt = observation?.received_at_ms ?? null;
          const receivedDate = dateForTimestamp(receivedAt ?? undefined);

          return (
            <li key={topic}>
              <details className="system-health-mqtt-topic">
                <summary>
                  <span className="system-health-mqtt-topic__name">{topic}</span>
                  <StatusBadge label={status} tone={statusTone(status)} />
                  {unverified ? <StatusBadge label="UNVERIFIED" tone="warn" /> : null}
                  <span className="system-health-mqtt-topic__age">{formatRelativeAge(receivedAt, nowMs)}</span>
                </summary>
                <div className="system-health-mqtt-topic__content">
                  <dl className="system-health-mqtt-topic__metadata">
                    <div>
                      <dt>Received</dt>
                      <dd>
                        {receivedDate
                          ? <><time dateTime={receivedDate.toISOString()}>{receivedDate.toLocaleString()}</time> · {formatRelativeAge(receivedAt, nowMs)}</>
                          : 'Not received'}
                      </dd>
                    </div>
                    <div><dt>QoS</dt><dd>{observation?.qos ?? 'N/A'}</dd></div>
                    <div><dt>Retained</dt><dd>{observation?.retained === null || observation?.retained === undefined ? 'N/A' : String(observation.retained)}</dd></div>
                    <div><dt>Error</dt><dd>{observation?.error ?? 'None'}</dd></div>
                  </dl>
                  <p className="system-health-mqtt-topic__disclaimer">
                    {candidate
                      ? 'Invalid candidate; display-only and not promoted to canonical telemetry.'
                      : observation?.status === 'INVALID'
                        ? 'Invalid message; no structured candidate payload is available.'
                        : unverified
                          ? 'UNVERIFIED payload; receipt time is not proof of authenticity.'
                          : 'Observed payload; canonical readings and readiness remain governed by validated telemetry.'}
                  </p>
                  {payload
                    ? <pre className="system-health-mqtt-topic__payload">{JSON.stringify(payload, null, 2)}</pre>
                    : <p className="system-health-mqtt-topic__empty">
                      {observation?.status === 'INVALID'
                        ? 'No structured candidate payload is available for this invalid message.'
                        : observation?.error ?? 'No payload received.'}
                    </p>}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

export function SystemHealthPage({
  rdfNodeMqtt,
  rdfNodeMqttError,
  systemHealth,
  systemHealthError,
}: {
  rdfNodeMqtt: RdfNodeMqttSnapshot | null;
  rdfNodeMqttError: string | null;
  systemHealth: SystemHealthSnapshot | null;
  systemHealthError: string | null;
}): JSX.Element {
  const [history, setHistory] = useState<SystemHealthHistoryRecord[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const lastLoggedCheckedAt = useRef<number | null>(null);

  const currentRdfNodeMqtt = rdfNodeMqttError ? null : rdfNodeMqtt;
  const readings = systemHealthMqttReadings(currentRdfNodeMqtt);
  const connection = currentRdfNodeMqtt?.connection ?? (rdfNodeMqttError ? 'error' : null);
  const connectionValue = connection?.toUpperCase() ?? 'UNKNOWN';
  const mqttDetail = currentRdfNodeMqtt
    ? currentRdfNodeMqtt.enabled
      ? 'Ground-side subscriber connection; topic freshness is shown separately.'
      : 'The MQTT monitor is disabled.'
    : rdfNodeMqttError
      ? 'The RDF Node MQTT snapshot request failed.'
      : 'Waiting for an RDF Node MQTT snapshot.';

  const currentSystemHealth = systemHealthError ? null : systemHealth;
  const usbState = currentSystemHealth?.usb_telemetry ?? (systemHealthError ? 'UNKNOWN' : 'CHECKING');
  const pppState = currentSystemHealth?.ppp_interface ?? (systemHealthError ? 'UNKNOWN' : 'CHECKING');
  const peerState = currentSystemHealth?.raspberry_peer ?? (systemHealthError ? 'UNKNOWN' : 'CHECKING');
  const peerDetail = systemHealthError
    ? 'Local health data unavailable.'
    : peerState === 'REACHABLE'
      ? 'ICMP response received from 10.90.0.2 over ppp0.'
      : peerState === 'NO_REPLY'
        ? 'No ICMP response; not proof the Raspberry is offline.'
        : peerState === 'NOT_PROBED'
          ? 'Not probed because ppp0 is down.'
          : peerState === 'UNKNOWN'
            ? 'Reachability check unavailable or local interface state unknown.'
            : 'ICMP reachability check pending.';

  const telemetryRows = [
    telemetryRow('Edge health stream', readings.healthStream),
    telemetryRow('DAQ / acquisition', readings.daq),
    telemetryRow('Dropped frames', readings.droppedFrames),
    telemetryRow('Edge clock', readings.edgeClock),
    telemetryRow('Sync flags', readings.sync),
    telemetryRow('DoA estimate', readings.doa),
    telemetryRow('GPS status', readings.gps),
    telemetryRow('CSV source', readings.csv),
    telemetryRow('XML source', readings.xml),
    telemetryRow('DAQ frame index', readings.frameIndex),
  ];
  const edgeHealthRows = [
    telemetryRow('Run state', readings.edgeHealth.run),
    telemetryRow('Edge source age', readings.edgeHealth.sourceAge),
    telemetryRow('Edge temperature', readings.edgeHealth.temperature),
  ];
  const edgeHealthDetailRows = [
    telemetryRow('Edge USB', readings.edgeHealthDetail.usb),
    telemetryRow('Frame sync', readings.edgeHealthDetail.sync.frame),
    telemetryRow('Sample-delay sync', readings.edgeHealthDetail.sync.sampleDelay),
    telemetryRow('IQ sync', readings.edgeHealthDetail.sync.iq),
    telemetryRow('CPU', readings.edgeHealthDetail.cpu),
    telemetryRow('Memory', readings.edgeHealthDetail.memory),
    telemetryRow('Free disk', readings.edgeHealthDetail.freeDisk),
    telemetryRow('Throttled', readings.edgeHealthDetail.throttled),
    telemetryRow('Undervoltage', readings.edgeHealthDetail.underVoltage),
    telemetryRow('TX', readings.edgeHealthDetail.tx),
    telemetryRow('RX', readings.edgeHealthDetail.rx),
    telemetryRow('Acquisition drops', readings.edgeHealthDetail.acquisitionDrops),
    telemetryRow('Parse errors', readings.edgeHealthDetail.parseErrors),
  ];
  const diagnosticDoaRows = [
    diagnosticRow('Trust', readings.diagnosticDoa.trust, 'Diagnostic DoA trust remains UNVERIFIED and is not readiness evidence.', 'warn'),
    diagnosticRow('Receive age', readings.diagnosticDoa.receiveAge, 'Time since the Ground Console received this diagnostic observation.'),
    diagnosticRow('Source age', readings.diagnosticDoa.sourceAge, 'Age from the diagnostic source timestamp; not a freshness guarantee.'),
    diagnosticRow('Raw DoA', readings.diagnosticDoa.rawDoa, 'Raw diagnostic angle; not substituted for canonical DoA.'),
    diagnosticRow('Frequency', readings.diagnosticDoa.frequency, 'Reported diagnostic frequency.'),
    diagnosticRow(
      'Validation reasons',
      readings.diagnosticDoa.reasons.length > 0 ? readings.diagnosticDoa.reasons.join(' · ') : 'NOT REPORTED',
      'Ground Console validation reasons for this unverified candidate.',
    ),
  ];
  const diagnosticAngularRows = [
    diagnosticRow('Trust', readings.diagnosticAngular.trust, 'Diagnostic Angular trust remains UNVERIFIED and is not readiness evidence.', 'warn'),
    diagnosticRow('Receive age', readings.diagnosticAngular.receiveAge, 'Time since the Ground Console received this diagnostic observation.'),
    diagnosticRow('Source age', readings.diagnosticAngular.sourceAge, 'Age from the diagnostic source timestamp; not a freshness guarantee.'),
    diagnosticRow('Raw DoA', readings.diagnosticAngular.rawDoa, 'Raw diagnostic angle; not substituted for canonical DoA.'),
    diagnosticRow('Frequency', readings.diagnosticAngular.frequency, 'Reported diagnostic frequency.'),
    diagnosticRow('flags', readings.diagnosticAngular.flags, 'Diagnostic Angular flags; bit meanings remain unverified.'),
    diagnosticRow(
      'Validation reasons',
      readings.diagnosticAngular.reasons.length > 0 ? readings.diagnosticAngular.reasons.join(' · ') : 'NOT REPORTED',
      'Ground Console validation reasons for this unverified candidate.',
    ),
  ];
  const localRows: HealthRow[] = [
    {
      indicator: 'Local USB telemetry',
      value: usbState,
      tone: subsystemTone(usbState),
      detail: 'Ground Console host only · VID:PID 1a86:7523.',
    },
    {
      indicator: 'PPP interface',
      value: pppState,
      tone: subsystemTone(pppState),
      detail: 'Ground Console local ppp0.',
    },
    {
      indicator: 'Raspberry peer',
      value: peerState,
      tone: subsystemTone(peerState),
      detail: peerDetail,
    },
    {
      indicator: 'MQTT v2 connection',
      value: connectionValue,
      tone: connectionTone(connection),
      detail: mqttDetail,
    },
  ];
  const historyValues: SystemHealthMqttHistoryValues = {
    edge_health: readings.healthStream.value,
    daq: readings.daq.value,
    dropped_frames: readings.droppedFrames.value,
    edge_clock: readings.edgeClock.value,
    sync: readings.sync.value,
    doa: readings.doa.value,
    gps: readings.gps.value,
    csv: readings.csv.value,
    xml: readings.xml.value,
    frame_index: readings.frameIndex.value,
    usb: usbState,
    ppp: pppState,
    peer: peerState,
    mqtt: connectionValue,
  };
  const historyValuesKey = JSON.stringify(historyValues);

  useEffect(() => {
    try {
      const storage = window.localStorage;
      setHistory(parseSystemHealthHistoryRecords(
        storage.getItem(SYSTEM_HEALTH_HISTORY_STORAGE_KEY),
        storage.getItem(SYSTEM_HEALTH_MQTT_HISTORY_STORAGE_KEY),
      ));
    } catch {
      setHistoryError('Saved history could not be read. Clear both saved-history formats before saving new checks.');
    } finally {
      setHistoryLoaded(true);
    }
  }, []);

  useEffect(() => {
    const checkedAt = currentSystemHealth?.checked_at_ms;
    if (!historyLoaded || historyError || checkedAt === undefined || lastLoggedCheckedAt.current === checkedAt) return;
    if (!Number.isSafeInteger(checkedAt) || checkedAt < 0 || dateForTimestamp(checkedAt) === null) {
      setHistoryError('The latest System Health timestamp is invalid; this check was not saved.');
      return;
    }

    lastLoggedCheckedAt.current = checkedAt;
    try {
      const storage = window.localStorage;
      const saved = parseSystemHealthMqttHistory(storage.getItem(SYSTEM_HEALTH_MQTT_HISTORY_STORAGE_KEY));
      const alreadySaved = saved.some((entry) => entry.checked_at_ms === checkedAt);
      const next = appendSystemHealthMqttHistory(saved, {
        source: 'mqtt-v2',
        captured_at_ms: Date.now(),
        checked_at_ms: checkedAt,
        values: historyValues,
      });
      if (!alreadySaved) {
        storage.setItem(SYSTEM_HEALTH_MQTT_HISTORY_STORAGE_KEY, JSON.stringify(next));
      }
      setHistory(parseSystemHealthHistoryRecords(
        storage.getItem(SYSTEM_HEALTH_HISTORY_STORAGE_KEY),
        JSON.stringify(next),
      ));
    } catch {
      setHistoryError('Browser storage could not save this history. Check local storage availability.');
    }
  }, [historyLoaded, historyError, currentSystemHealth?.checked_at_ms, historyValuesKey]);

  const latestSaved = history[history.length - 1];
  const currentCheckDate = dateForTimestamp(currentSystemHealth?.checked_at_ms);
  const lastCheckDate = currentCheckDate ?? dateForTimestamp(latestSaved?.checked_at_ms);

  function exportHistory(): void {
    if (history.length === 0) return;
    const blob = new Blob([`\ufeff${systemHealthHistoryToCsv(history)}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'system-health-history.csv';
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  function clearHistory(): void {
    if (!window.confirm('Clear all locally saved System Health checks from this browser?')) return;
    lastLoggedCheckedAt.current = currentSystemHealth?.checked_at_ms ?? latestSaved?.checked_at_ms ?? null;
    try {
      const storage = window.localStorage;
      storage.removeItem(SYSTEM_HEALTH_HISTORY_STORAGE_KEY);
      storage.removeItem(SYSTEM_HEALTH_MQTT_HISTORY_STORAGE_KEY);
      setHistory([]);
      setHistoryError(null);
    } catch {
      setHistoryError('Browser storage could not clear the saved history.');
    }
  }

  return (
    <div className="page system-health-page">
      <h1 className="system-health-heading">System health</h1>
      {rdfNodeMqttError ? (
        <div className="dry-run-notice" role="alert">
          RDF Node MQTT telemetry check failed: {rdfNodeMqttError}
        </div>
      ) : null}
      {systemHealthError ? (
        <div className="dry-run-notice" role="alert">
          Local System Health check failed: {systemHealthError}
        </div>
      ) : null}
      <p className="system-health-last-check">
        <span>Last checked</span>
        {lastCheckDate
          ? <time dateTime={lastCheckDate.toISOString()}>{lastCheckDate.toLocaleString()}</time>
          : <span>{historyLoaded ? 'No successful check recorded yet' : 'Loading saved check time…'}</span>}
        <span className="system-health-last-check__source">
          {currentCheckDate ? 'System Health probe' : latestSaved ? 'Last saved successful probe' : ''}
        </span>
      </p>
      <Panel className="system-health-status-panel" title="Current status">
        <div className="system-health-board">
          <section className="system-health-group" aria-labelledby="system-health-edge-heading">
            <h3 id="system-health-edge-heading">Edge telemetry &amp; processing</h3>
            <HealthCheckList rows={telemetryRows} />
            <h4>Edge health</h4>
            <HealthCheckList rows={edgeHealthRows} />
            <h4>Edge health detail</h4>
            <HealthCheckList rows={edgeHealthDetailRows} />
            <h4>Diagnostic observations</h4>
            <DiagnosticObservation
              title="Diagnostic DoA"
              freshness={readings.diagnosticDoa.freshness}
              rows={diagnosticDoaRows}
            />
            <DiagnosticObservation
              title="Diagnostic Angular"
              freshness={readings.diagnosticAngular.freshness}
              rows={diagnosticAngularRows}
            />
          </section>
          <section className="system-health-group" aria-labelledby="system-health-local-heading">
            <h3 id="system-health-local-heading">Ground Console host &amp; connections</h3>
            <HealthCheckList rows={localRows} />
          </section>
        </div>
      </Panel>

      <MqttTopicPayloads snapshot={currentRdfNodeMqtt} />
      <details className="system-health-history">
        <summary>
          <span>Saved check history</span>
          <span className="system-health-history__count">
            {history.length} saved locally · MQTT v2 limit {MAX_SYSTEM_HEALTH_HISTORY_ENTRIES}
          </span>
        </summary>
        <div className="system-health-history__content">
          <p>
            Saved records contain rendered MQTT v2 status values and local host checks, not raw topic payloads. Existing HTTP-derived rows remain labeled Legacy Data Out.
          </p>
          {historyError ? <p className="system-health-history__error" role="alert">{historyError}</p> : null}
          {history.length === 0 ? (
            <p>No successful System Health checks saved yet.</p>
          ) : (
            <div className="table-wrap system-health-history-table-wrap" role="region" aria-label="Recent System Health history" tabIndex={0}>
              <table aria-label="Recent System Health history">
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col">Captured</th>
                    <th scope="col">Local probe checked</th>
                    <th scope="col">Telemetry summary</th>
                    <th scope="col">Data Out (legacy)</th>
                    <th scope="col">DAQ</th>
                    <th scope="col">Sync</th>
                    <th scope="col">Local links</th>
                    <th scope="col">MQTT state</th>
                  </tr>
                </thead>
                <tbody>
                  {history.slice(-20).reverse().map((entry) => (
                    <tr key={`${entry.source}-${entry.checked_at_ms}`}>
                      <td>{entry.source === 'mqtt-v2' ? 'MQTT v2' : 'Legacy Data Out'}</td>
                      <td><time dateTime={new Date(entry.captured_at_ms).toISOString()}>{new Date(entry.captured_at_ms).toLocaleString()}</time></td>
                      <td><time dateTime={new Date(entry.checked_at_ms).toISOString()}>{new Date(entry.checked_at_ms).toLocaleString()}</time></td>
                      <td>{entry.source === 'mqtt-v2' ? entry.values.edge_health : entry.values.overall}</td>
                      <td>{entry.source === 'mqtt-v2' ? '—' : entry.values.data_out}</td>
                      <td>{entry.values.daq}</td>
                      <td>{entry.values.sync}</td>
                      <td>USB {entry.values.usb} · PPP {entry.values.ppp} · peer {entry.values.peer}</td>
                      <td>{entry.values.mqtt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="system-health-history__actions">
            <button type="button" onClick={exportHistory} disabled={history.length === 0}>Export CSV</button>
            <button type="button" onClick={clearHistory} disabled={history.length === 0 && historyError === null}>Clear history</button>
          </div>
        </div>
      </details>
    </div>
  );
}
