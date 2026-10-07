import { useState } from 'react';
import type { ReactElement } from 'react';
import type {
  RdfNodeMqttDiagnosticAngularFrame,
  RdfNodeMqttDiagnosticDoa,
  RdfNodeMqttObservation,
  RdfNodeMqttSnapshot,
  RdfNodeMqttTopic,
  RdfNodeMqttTopicStatus,
} from '../types';
import { RDF_NODE_MQTT_TOPICS } from '../types';
import {
  angularIsCurrent,
  connectionTone,
  daqState,
  diagnosticObservationAgeLabels,
  diagnosticObservationStatusAt,
  doaIsCurrent,
  formatObservationAge,
  formatAngularMetadata,
  formatValue,
  formatTopicDetails,
  isAngularFrame,
  isDiagnosticTopic,
  observationPayload,
  statusTone,
  observationStatusAt,
} from '../lib/rdfNodeMqttPresentation';
import { Panel, StatusBadge } from './ui';

type RdfNodeMqttPanelProps = {
  snapshot: RdfNodeMqttSnapshot | null;
  error: string | null;
  onRefresh: () => Promise<void>;
};

function DiagnosticSampleDisclosure({ values }: { values: number[] }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>360 diagnostic samples</summary>
      {expanded ? <pre className="rdf-node-samples">{JSON.stringify(values)}</pre> : null}
    </details>
  );
}

function renderDiagnosticAges(observation: RdfNodeMqttObservation, nowMs: number): ReactElement {
  const ages = diagnosticObservationAgeLabels(observation, nowMs);
  return (
    <div className="rdf-node-diagnostic-ages">
      <span>Receive age: {ages.receive}</span>
      <span>Source age: {ages.source}</span>
    </div>
  );
}

function renderDiagnosticPayload(
  topic: Extract<RdfNodeMqttTopic, 'telemetry/diagnostic/doa' | 'telemetry/diagnostic/angular'>,
  observation: RdfNodeMqttObservation,
  status: RdfNodeMqttTopicStatus,
): ReactElement {
  const payload = observationPayload(observation);
  if (!payload) return <span>{observation.error ?? 'No diagnostic candidate.'}</span>;

  const statusDetails = (
    <>
      <div><dt>Freshness</dt><dd><StatusBadge label={status} tone={statusTone(status)} /></dd></div>
      <div><dt>Trust</dt><dd><StatusBadge label="UNVERIFIED" tone="warn" /></dd></div>
    </>
  );

  if (topic === 'telemetry/diagnostic/doa') {
    const frame = payload as unknown as RdfNodeMqttDiagnosticDoa;
    const reasons = Array.isArray(frame.validation_reasons) ? frame.validation_reasons : [];
    return (
      <dl className="rdf-node-fields rdf-node-diagnostic">
        {statusDetails}
        <div><dt>Raw DoA</dt><dd>{formatValue(frame.raw_doa_deg) ?? 'N/A'}°</dd></div>
        <div><dt>Frequency</dt><dd>{formatValue(frame.frequency_mhz) ?? 'N/A'} MHz</dd></div>
        <div><dt>Edge-supplied reasons</dt><dd>{reasons.join(', ') || 'None supplied'}</dd></div>
      </dl>
    );
  }

  const frame = payload as unknown as RdfNodeMqttDiagnosticAngularFrame;
  if (!Array.isArray(frame.values) || frame.values.length !== 360) {
    return <span>No complete diagnostic Angular frame.</span>;
  }
  const metadata: Array<[string, string]> = [
    ['encoding', frame.encoding],
    ['sid', frame.sid.toString(16).padStart(8, '0')],
    ['q', String(frame.q)],
    ['source timestamp', `${frame.source_timestamp_ms} ms`],
    ['frequency', `${frame.frequency_hz} Hz`],
    ['revision', formatValue(frame.revision) ?? 'N/A'],
    ['vfo', String(frame.vfo)],
    ['convention', String(frame.convention)],
    ['raw DoA', `${formatValue(frame.raw_doa_deg) ?? 'N/A'}°`],
    ['confidence', `${formatValue(frame.confidence_native_db) ?? 'N/A'} dB`],
    ['flags', String(frame.flags)],
  ];
  const reasons = Array.isArray(frame.validation_reasons) ? frame.validation_reasons : [];
  return (
    <div className="rdf-node-diagnostic-angular">
      <dl className="rdf-node-fields">
        {statusDetails}
        {metadata.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        <div><dt>Ground-derived reasons</dt><dd>{reasons.join(', ') || 'None supplied'}</dd></div>
      </dl>
      <DiagnosticSampleDisclosure values={frame.values} />
    </div>
  );
}

function renderTopicPayload(
  topic: RdfNodeMqttTopic,
  observation: RdfNodeMqttObservation,
  health: RdfNodeMqttObservation | undefined,
  status: RdfNodeMqttTopicStatus,
  nowMs: number,
): ReactElement {
  if (status === 'INVALID') {
    if (!observation.candidate_payload) {
      return <span>{observation.error ?? 'Invalid message; no structured candidate payload is available.'}</span>;
    }
    return (
      <div className="rdf-node-candidate">
        <div className="rdf-node-candidate__status">
          <StatusBadge label="UNVERIFIED" tone="warn" />
          {observation.error ? <span>{observation.error}</span> : null}
        </div>
        <p>Invalid candidate; display-only and not promoted to canonical telemetry.</p>
        <details>
          <summary>Candidate payload</summary>
          <pre className="rdf-node-candidate-payload">{JSON.stringify(observation.candidate_payload, null, 2)}</pre>
        </details>
      </div>
    );
  }
  if (isDiagnosticTopic(topic)) {
    return renderDiagnosticPayload(topic, observation, status);
  }
  if (topic === 'telemetry/angular') {
    if (!isAngularFrame(observation.payload)) {
      return <span>No complete Angular frame.</span>;
    }
    const frame = observation.payload;
    const current = angularIsCurrent(observation, health, nowMs);
    const details = formatAngularMetadata(frame);
    return (
      <div className="rdf-node-angular">
        <StatusBadge label={current ? 'CURRENT FRAME' : 'NOT CURRENT'} tone={current ? 'good' : 'warn'} />
        <dl className="rdf-node-fields">
          {details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        <details>
          <summary>360 samples{current ? '' : ' · not current'}</summary>
          <pre className="rdf-node-samples">{JSON.stringify(frame.values)}</pre>
        </details>
      </div>
    );
  }

  const entries = formatTopicDetails(topic, observation.payload);
  if (entries.length === 0) return <span>{observation.error ?? 'No payload.'}</span>;
  return (
    <dl className="rdf-node-fields">
      {entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}



export function RdfNodeMqttPanel({ snapshot, error, onRefresh }: RdfNodeMqttPanelProps): ReactElement {
  const health = snapshot?.topics['telemetry/health'];
  const doa = snapshot?.topics['telemetry/doa'];
  const healthPayload = observationPayload(health);
  const doaPayload = observationPayload(doa);
  const availabilityPayload = observationPayload(snapshot?.topics.availability);
  const availability = snapshot?.topics.availability;
  const nowMs = Date.now();
  const daq = daqState(health, nowMs);
  const doaCurrent = doaIsCurrent(doa, health, nowMs);
  const connection = snapshot?.enabled ? snapshot.connection : snapshot ? 'disabled' : null;
  const connectionLabel = connection?.toUpperCase() ?? 'NO SNAPSHOT';
  const refresh = (): void => {
    void onRefresh().catch(() => undefined);
  };

  return (
    <Panel
      className="rdf-node-mqtt-panel"
      title="RDF Node MQTT v2"
      action={<button className="secondary-button" type="button" onClick={refresh}>Refresh v2 snapshot</button>}
    >
      <div className="rdf-node-transport">
        <span aria-live="polite"><StatusBadge label={connectionLabel} tone={connectionTone(connection)} /></span>
        <span>Node {snapshot?.node_id ?? 'N/A'}</span>
        {snapshot ? <span>{snapshot.received} received · {snapshot.valid} valid · {snapshot.invalid} invalid</span> : null}
        {snapshot?.last_error ? <span role="status">Subscription error: {snapshot.last_error}</span> : null}
      </div>
      {error ? <p className="rdf-node-error" role="alert">RDF Node snapshot request failed.</p> : null}
      {!snapshot && !error ? <p className="rdf-node-empty">Waiting for the first RDF Node snapshot.</p> : null}
      {snapshot && !snapshot.enabled ? <p className="rdf-node-empty">RDF Node MQTT is disabled in local console configuration.</p> : null}
      <p className="rdf-node-separation">Diagnostic telemetry remains UNVERIFIED and never contributes to canonical live telemetry or publication readiness. Availability is not DAQ health. MQTT state does not change HTTP Data Out or publication readiness. ACK statuses are Edge-reported observations; Ground sends no command or receipt.</p>

      <div className="rdf-node-readouts">
        <section aria-label="DAQ health observation">
          <h3>DAQ health</h3>
          <StatusBadge label={daq.label} tone={daq.tone} />
          <dl className="rdf-node-fields">
            <div><dt>Run</dt><dd>{formatValue(healthPayload?.run) ?? 'N/A'}</dd></div>
            <div><dt>Clock</dt><dd>{formatValue(healthPayload?.clk) ?? 'N/A'}</dd></div>
            <div><dt>Health sequence</dt><dd>{formatValue(healthPayload?.q) ?? 'N/A'}</dd></div>
          </dl>
        </section>
        <section aria-label="DoA observation">
          <h3>DoA</h3>
          <StatusBadge label={doaCurrent ? 'CURRENT DOA' : 'NOT CURRENT'} tone={doaCurrent ? 'good' : 'neutral'} />
          {doaCurrent ? (
            <dl className="rdf-node-fields">
              <div><dt>Native angle</dt><dd>{formatValue(doaPayload?.a)}°</dd></div>
              <div><dt>Frequency</dt><dd>{formatValue(doaPayload?.f)} Hz</dd></div>
              <div><dt>Confidence · native dB</dt><dd>{formatValue(doaPayload?.c)}</dd></div>
              <div><dt>Power · native</dt><dd>{formatValue(doaPayload?.p)}</dd></div>
            </dl>
          ) : <p className="rdf-node-empty">DoA not current.</p>}
        </section>
        <p className="rdf-node-availability">
          Control availability: {availabilityPayload?.online === true ? 'ONLINE' : availabilityPayload?.online === false ? 'OFFLINE' : 'UNKNOWN'} ({availability?.status ?? 'UNAVAILABLE'})
        </p>
      </div>

      <div className="table-wrap rdf-node-table-wrap" role="region" aria-label="RDF Node v2 topic observations" tabIndex={0}>
        <table className="rdf-node-table">
          <thead><tr><th scope="col">Topic</th><th scope="col">Status</th><th scope="col">Age</th><th scope="col">Count</th><th scope="col">Latest observed fields</th></tr></thead>
          <tbody>
            {RDF_NODE_MQTT_TOPICS.map((topic) => {
              const observation = snapshot?.topics[topic];
              const status = !observation
                ? 'UNAVAILABLE'
                : isDiagnosticTopic(topic)
                  ? diagnosticObservationStatusAt(topic, observation, snapshot, nowMs)
                  : observationStatusAt(topic, observation, nowMs);
              return (
                <tr key={topic}>
                  <th scope="row">{topic}</th>
                  <td><StatusBadge label={status} tone={statusTone(status)} /></td>
                  <td>
                    {observation && isDiagnosticTopic(topic)
                      ? renderDiagnosticAges(observation, nowMs)
                      : formatObservationAge(topic, observation, nowMs)}
                  </td>
                  <td>{snapshot?.topic_counts[topic] ?? 0}</td>
                  <td className="rdf-node-payload">
                    {observation ? renderTopicPayload(topic, observation, health, status, nowMs) : <span>No payload.</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
