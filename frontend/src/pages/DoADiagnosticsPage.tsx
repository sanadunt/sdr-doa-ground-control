import type { JSX } from 'react';
import type { Candidate, TelemetrySnapshot } from '../types';
import { candidate, formatNumber, nativeViewsReady, safeJson } from '../lib/telemetry';
import { gateReasonLabel, useI18n } from '../lib/i18n';
import type { Lang, Translate } from '../lib/i18n';
import { rankGateReasons } from '../lib/doaStatus';
import {
  candidateIssue,
  collectionView,
  consistencyView,
  csvRowsView,
  errorKindKey,
  evidenceExpired,
  formatAgeText,
  formatDuration,
  gateCheckKey,
  humanizeKey,
  isSecretSettingKey,
  nodeProgressView,
  peakConsistency,
  resourceRow,
  signalQualityView,
  stateTone,
} from '../lib/healthView';
import { CollectorError, KeyValue, Panel, StatusBadge } from '../components/ui';
import { Page, PageHeader, StatusChip } from '../components/page';

// The collector already allowlists these fields; the cap only bounds an
// unexpected response.
const MAX_CONFIG_FIELDS = 64;

function checkLabel(key: string, t: Translate): string {
  const messageKey = gateCheckKey(key);
  return messageKey ? t(messageKey) : humanizeKey(key);
}

function operatorEvents(snapshot: TelemetrySnapshot | null, lang: Lang, t: Translate): Array<{ label: string; detail: string }> {
  if (!snapshot) return [{ label: 'SNAPSHOT', detail: t('diag.event.awaiting') }];
  const gate = snapshot.publication_gate ?? {};
  const consistency = consistencyView(snapshot.native_consistency);
  const progress = nodeProgressView(snapshot);
  const collection = collectionView(snapshot);
  const events = [
    { label: 'SNAPSHOT', detail: t('diag.event.snapshot', { state: String(snapshot.overall_state ?? 'UNKNOWN') }) },
    { label: 'DOA VIEWS', detail: t('diag.event.views', { relation: consistency.relation }) },
    { label: 'DELIVERY', detail: t('diag.event.delivery', { state: String(gate.state ?? 'BLOCKED').toUpperCase() }) },
  ];
  if (progress && progress.state !== 'UNTRACKED') events.push({ label: 'NODE', detail: t('diag.event.node', { state: progress.state }) });
  if (collection?.deadlineExceeded) events.push({ label: 'COLLECTION', detail: t('diag.event.deadline') });
  else if (collection?.statusTransportFailed) events.push({ label: 'COLLECTION', detail: t('health.collection.statusTransport') });
  const reasons = rankGateReasons(gate.reasons);
  events.push(...reasons.slice(0, 4).map((reason) => ({ label: 'GATE', detail: gateReasonLabel(lang, reason) })));
  if (reasons.length > 4) events.push({ label: 'GATE', detail: t('diag.event.moreReasons', { count: reasons.length - 4 }) });
  return events;
}

function NativeRecord({ name, item, snapshot }: { name: 'csv' | 'xml'; item: Candidate; snapshot: TelemetrySnapshot | null }): JSX.Element {
  const { t } = useI18n();
  const issue = candidateIssue(item);
  const resource = resourceRow(snapshot, name === 'csv' ? '/DOA_value.html' : '/doa.xml');
  const httpValue = resource.ok === true
    ? resource.httpStatus === null ? 'OK' : `HTTP ${resource.httpStatus}`
    : resource.ok === false ? t(errorKindKey(resource.errorKind)) : 'N/A';
  const httpDetail = resource.ok === false
    ? resource.error ? <CollectorError error={resource.error} /> : t('health.res.noDetail')
    : resource.elapsedMs === null ? t('diag.httpDetail') : formatDuration(t, resource.elapsedMs);
  const state = item.available !== true ? 'MISSING' : issue.quarantined ? 'INVALID' : 'PRESENT';
  const rows = name === 'csv' ? csvRowsView(item) : null;
  const peak = name === 'csv' ? peakConsistency(item) : null;
  const quality = name === 'xml' ? signalQualityView(snapshot) : null;
  const xmlOverdrive = typeof item.adc_overdrive_active === 'boolean' ? (item.adc_overdrive_active ? 'OVERDRIVE' : 'PASS') : 'N/A';
  return (
    <article className="native-record">
      <div className="native-record-head"><strong>{name.toUpperCase()}</strong><StatusBadge label={state} tone={stateTone(state)} /></div>
      {issue.error ? <p className="native-record-error status-text-bad" role="note"><strong>{t('diag.recordError')}</strong> <CollectorError error={issue.error} /></p> : null}
      {issue.quarantined ? <p className="native-record-error status-text-bad" role="note"><strong>NATIVE_ANGLE_INVALID</strong> {issue.quarantined}</p> : null}
      <div className="native-record-grid">
        <KeyValue label={t('diag.rawAngle')} value={typeof item.doa_raw_deg === 'number' ? `${formatNumber(item.doa_raw_deg)}°` : 'N/A'} detail={String(item.angle_convention ?? t('diag.native'))} />
        <KeyValue label={t('diag.canonical')} value={typeof item.canonical_angle_deg === 'number' ? `${formatNumber(item.canonical_angle_deg)}°` : 'N/A'} detail={t('diag.collectorConversion')} />
        <KeyValue label={t('diag.ageAtRead')} value={item.available === true ? formatAgeText(t, item.freshness) : 'N/A'} detail={item.freshness?.fresh === true ? t('diag.fresh') : t('diag.notFresh')} />
        <KeyValue label={t('diag.units')} value={item.native_metrics_state ?? 'N/A'} detail={t('diag.unitsContractMapping', { state: item.contract_mapping_state ?? 'N/A' })} />
        <KeyValue label={t('diag.http')} value={httpValue} detail={httpDetail} tone={resource.ok === false ? 'bad' : undefined} />
        {rows ? (
          <KeyValue
            label={t('diag.csvRows')}
            value={rows.total === null ? 'N/A' : t('diag.csvRowsValue', { index: rows.index === null ? '—' : rows.index + 1, total: rows.total })}
            detail={rows.selection === 'matched_xml_frequency' ? t('diag.csvRowsMatched') : rows.selection === 'single_row' ? t('diag.csvRowsSingle') : t('diag.csvRowsUnknown')}
          />
        ) : null}
        {peak ? (
          <KeyValue
            label={t('diag.peakVsTheta')}
            value={peak.distanceDeg === null ? 'N/A' : `${formatNumber(peak.distanceDeg)}°`}
            detail={peak.consistent === false ? t('diag.peakMismatch', { tolerance: formatNumber(peak.toleranceDeg) }) : peak.consistent === true ? t('diag.peakConsistent', { tolerance: formatNumber(peak.toleranceDeg) }) : t('diag.peakUnknown')}
            tone={peak.consistent === false ? 'bad' : undefined}
          />
        ) : null}
        {name === 'xml' ? <KeyValue label={t('health.row.snr')} value={quality?.snrDb === null || !quality ? 'N/A' : `${formatNumber(quality.snrDb)} dB`} detail={t('health.row.snrDetail')} /> : null}
        {name === 'xml' ? <KeyValue label={t('health.row.adc')} value={xmlOverdrive} detail={typeof item.adc_overdrive_channel_mask === 'number' ? t('health.adc.mask', { mask: `0b${item.adc_overdrive_channel_mask.toString(2)}` }) : t('diag.xmlOverdriveDetail')} tone={xmlOverdrive === 'OVERDRIVE' ? 'bad' : undefined} /> : null}
      </div>
      {rows && rows.additional.length ? (
        <div className="table-wrap vfo-rows" tabIndex={0} role="region" aria-label={t('diag.vfoRowsTitle')}>
          <table>
            <caption>{t('diag.vfoRowsTitle')}</caption>
            <thead><tr><th scope="col">{t('diag.vfoRow')}</th><th scope="col">{t('diag.vfoFrequency')}</th><th scope="col">{t('diag.rawAngle')}</th><th scope="col">{t('diag.canonical')}</th><th scope="col">PAPR</th><th scope="col">{t('diag.vfoPower')}</th></tr></thead>
            <tbody>
              {rows.additional.map((row, index) => (
                <tr key={`${row.rowIndex ?? 'row'}-${index}`}>
                  <td>{row.rowIndex === null ? '—' : row.rowIndex + 1}</td>
                  <td>{row.frequencyHz === null ? 'N/A' : `${formatNumber(row.frequencyHz / 1e6, 4)} MHz`}</td>
                  <td>{row.rawDeg === null ? 'N/A' : `${formatNumber(row.rawDeg)}°`}</td>
                  <td>{row.canonicalDeg === null ? 'N/A' : `${formatNumber(row.canonicalDeg)}°`}</td>
                  <td>{formatNumber(row.confidenceRaw, 2)}</td>
                  <td>{formatNumber(row.powerRaw)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </article>
  );
}

export function DoADiagnosticsPage({ snapshot, localSnapshotFresh }: { snapshot: TelemetrySnapshot | null; localSnapshotFresh: boolean }): JSX.Element {
  const gate = snapshot?.publication_gate;
  const checks = gate?.checks ?? {};
  const reasons = rankGateReasons(gate?.reasons);
  const csv = candidate(snapshot, 'csv');
  const xml = candidate(snapshot, 'xml');
  const consistency = consistencyView(snapshot?.native_consistency);
  const fields = Object.entries(snapshot?.settings?.fields ?? {}).filter(([key]) => !isSecretSettingKey(key));
  const shownFields = fields.slice(0, MAX_CONFIG_FIELDS);
  const settingsError = typeof snapshot?.settings?.error === 'string' ? snapshot.settings.error : null;
  const { lang, t } = useI18n();
  const events = operatorEvents(snapshot, lang, t);
  const gateState = String(gate?.state ?? 'BLOCKED').toUpperCase();
  return (
    <Page>
      <PageHeader
        title={t('route.doa-diagnostics')}
        chips={<>
          <StatusChip label={t('status.delivery')} code={gateState} tone={gateState === 'READY' ? 'good' : 'warn'} />
          <StatusChip label="CSV↔XML" code={consistency.relation} />
          {consistency.frameRelation ? <StatusChip label={t('page.chip.frame')} code={consistency.frameRelation} /> : null}
        </>}
      />
      {evidenceExpired(snapshot, localSnapshotFresh) ? <div className="dry-run-notice stale-evidence-banner" role="status"><strong>{t('common.staleEvidence')}</strong> {t('diag.stale')}</div> : null}
      <div className="diagnostics-top-grid">
        <Panel className="gate-panel" eyebrow={t('diag.gateEyebrow')} title={t('diag.gateTitle')} action={<StatusBadge label={String(gate?.state ?? 'BLOCKED').toUpperCase()} tone={gate?.state === 'READY' ? 'good' : 'warn'} />}>
          <div className="gate-ledger">
            {Object.entries(checks).map(([key, value]) => <div className="gate-row" key={key}><span className={value === true ? 'gate-pass' : value === false ? 'gate-fail' : 'gate-neutral'} aria-hidden="true">{value === true ? '✓' : value === false ? '×' : '·'}</span><strong>{checkLabel(key, t)}</strong><span>{value === true ? 'PASS' : value === false ? 'BLOCKED' : t('diag.notConfigured')}</span></div>)}
            {!Object.keys(checks).length ? <div className="empty-inline">{t('diag.noGate')}</div> : null}
          </div>
          <div className="reason-list"><div className="panel-eyebrow">{t('diag.reasons')}</div>{reasons.length ? reasons.map((reason) => <div className="reason-row" key={reason}><span>!</span><span>{gateReasonLabel(lang, reason)} <code className="reason-code">{reason}</code></span></div>) : <div className="empty-inline">{t('diag.noReasons')}</div>}</div>
        </Panel>
        <Panel className="ledger-panel" eyebrow={t('diag.ledgerEyebrow')} title={t('diag.ledgerTitle')}>
          <div className="native-records">
            <NativeRecord name="csv" item={csv} snapshot={snapshot} />
            <NativeRecord name="xml" item={xml} snapshot={snapshot} />
          </div>
          <div className="consistency-readout">
            <span>{t('diag.relation')}</span>
            <strong className={`status-text-${stateTone(consistency.relation)}`}>{consistency.relation}</strong>
            {consistency.frameRelation ? <small>{consistency.frameRelation}{consistency.angleChecked === false ? ` · ${t('diag.angleNotChecked')}` : ''}</small> : null}
            <small>{t('diag.timestampDelta', { delta: consistency.timestampDeltaMs === null ? 'N/A' : formatDuration(t, consistency.timestampDeltaMs) })}</small>
            <small>{t('diag.distance', { deg: formatNumber(consistency.distanceDeg), tolerance: formatNumber(consistency.toleranceDeg) })}</small>
          </div>
        </Panel>
      </div>
      <div className="diagnostics-bottom-grid">
        <Panel className="operator-panel" eyebrow={t('diag.logEyebrow')} title={t('diag.logTitle')}>
          <ol className="operator-log">{events.map((event, index) => <li key={`${event.label}-${index}`}><span className="log-index">{String(index + 1).padStart(2, '0')}</span><div><strong>{event.label}</strong><span>{event.detail}</span></div></li>)}</ol>
        </Panel>
        <Panel className="effective-config-panel" eyebrow={t('diag.configEyebrow')} title={t('diag.configTitle')}>
          <div className="config-readout">
            <KeyValue label={t('diag.authority')} value={snapshot?.authority?.selected ?? 'NONE'} detail={t('diag.authorityDetail')} />
            <KeyValue label={t('diag.angleReadiness')} value={snapshot?.authority?.canonical_angle_ready === true ? 'READY' : t('diag.notConfigured')} detail={t('diag.angleDetail')} />
            <KeyValue label={t('diag.nativeViews')} value={nativeViewsReady(snapshot) && localSnapshotFresh ? 'FRESH / COMPARABLE' : 'NOT READY'} detail={t('diag.nativeDetail')} />
            <KeyValue label={t('diag.settingsSource')} value={snapshot?.settings?.available === true ? 'REDACTED FIELDS' : 'UNAVAILABLE'} detail={settingsError ? <CollectorError error={settingsError} /> : t('diag.settingsDetail')} tone={snapshot && snapshot.settings?.available !== true ? 'warn' : undefined} />
            {shownFields.map(([key, value]) => <KeyValue key={key} label={key.replace(/_/g, ' ')} value={typeof value === 'boolean' ? (value ? 'ON' : 'OFF') : String(value)} />)}
            {fields.length > shownFields.length ? <div className="empty-inline">{t('diag.moreFields', { count: fields.length - shownFields.length })}</div> : null}
          </div>
          <pre className="diagnostic-note">{safeJson({ local_snapshot_fresh: localSnapshotFresh, raw_settings_omitted: snapshot?.settings?.raw_fields_omitted ?? true })}</pre>
        </Panel>
      </div>
    </Page>
  );
}
