import type { JSX } from 'react';
import type { TelemetrySnapshot } from '../types';
import { candidate, consistencyRelation, formatAge, formatNumber, nativeViewsReady, safeJson } from '../lib/telemetry';
import { gateReasonLabel, useI18n } from '../lib/i18n';
import type { Lang, Translate } from '../lib/i18n';
import { KeyValue, Panel, SectionHeading, StatusBadge } from '../components/ui';

function checkLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (value) => value.toUpperCase());
}

function operatorEvents(snapshot: TelemetrySnapshot | null, lang: Lang, t: Translate): Array<{ label: string; detail: string }> {
  if (!snapshot) return [{ label: 'SNAPSHOT', detail: t('diag.event.awaiting') }];
  const gate = snapshot.publication_gate ?? {};
  return [
    { label: 'SNAPSHOT', detail: t('diag.event.snapshot', { state: snapshot.overall_state ?? 'UNKNOWN' }) },
    { label: 'DOA VIEWS', detail: t('diag.event.views', { relation: consistencyRelation(snapshot.native_consistency) }) },
    { label: 'DELIVERY', detail: t('diag.event.delivery', { state: String(gate.state ?? 'BLOCKED').toUpperCase() }) },
    ...(gate.reasons ?? []).slice(0, 4).map((reason) => ({ label: 'GATE', detail: gateReasonLabel(lang, reason) })),
  ];
}

export function DoADiagnosticsPage({ snapshot, localSnapshotFresh }: { snapshot: TelemetrySnapshot | null; localSnapshotFresh: boolean }): JSX.Element {
  const gate = snapshot?.publication_gate;
  const checks = gate?.checks ?? {};
  const reasons = gate?.reasons ?? [];
  const csv = candidate(snapshot, 'csv');
  const xml = candidate(snapshot, 'xml');
  const fields = snapshot?.settings?.fields ?? {};
  const { lang, t } = useI18n();
  const events = operatorEvents(snapshot, lang, t);
  return (
    <div className="page">
      <SectionHeading eyebrow={t('diag.eyebrow')} title={t('diag.title')} detail={t('diag.detail')} />
      {snapshot && !localSnapshotFresh ? <div className="dry-run-notice stale-evidence-banner" role="status"><strong>{t('common.staleEvidence')}</strong> {t('diag.stale')}</div> : null}
      <div className="diagnostics-top-grid">
        <Panel className="gate-panel" eyebrow={t('diag.gateEyebrow')} title={t('diag.gateTitle')} action={<StatusBadge label={String(gate?.state ?? 'BLOCKED').toUpperCase()} tone={gate?.state === 'READY' ? 'good' : 'warn'} />}>
          <div className="gate-ledger">
            {Object.entries(checks).map(([key, value]) => <div className="gate-row" key={key}><span className={value === true ? 'gate-pass' : value === false ? 'gate-fail' : 'gate-neutral'} aria-hidden="true">{value === true ? '✓' : value === false ? '×' : '·'}</span><strong>{checkLabel(key)}</strong><span>{value === true ? 'PASS' : value === false ? 'BLOCKED' : t('diag.notConfigured')}</span></div>)}
            {!Object.keys(checks).length ? <div className="empty-inline">{t('diag.noGate')}</div> : null}
          </div>
          <div className="reason-list"><div className="panel-eyebrow">{t('diag.reasons')}</div>{reasons.length ? reasons.map((reason) => <div className="reason-row" key={reason}><span>!</span><span>{gateReasonLabel(lang, reason)}</span></div>) : <div className="empty-inline">{t('diag.noReasons')}</div>}</div>
        </Panel>
        <Panel className="ledger-panel" eyebrow={t('diag.ledgerEyebrow')} title={t('diag.ledgerTitle')}>
          <div className="native-records">
            {(['csv', 'xml'] as const).map((name) => {
              const item = name === 'csv' ? csv : xml;
              return <article className="native-record" key={name}><div className="native-record-head"><strong>{name.toUpperCase()}</strong><StatusBadge label={item.available === true ? 'PRESENT' : 'MISSING'} tone={item.available === true ? 'good' : 'warn'} /></div><div className="native-record-grid"><KeyValue label={t('diag.rawAngle')} value={item.doa_raw_deg === undefined ? 'N/A' : `${formatNumber(item.doa_raw_deg)}°`} detail={String(item.angle_convention ?? t('diag.native'))} /><KeyValue label={t('diag.canonical')} value={item.canonical_angle_deg === undefined ? 'N/A' : `${formatNumber(item.canonical_angle_deg)}°`} detail={t('diag.collectorConversion')} /><KeyValue label={t('diag.ageAtRead')} value={formatAge(item.freshness)} detail={item.freshness?.fresh === true ? t('diag.fresh') : t('diag.notFresh')} /><KeyValue label={t('diag.units')} value={item.native_metrics_state ?? 'N/A'} detail={item.contract_mapping_state ?? 'N/A'} /></div></article>;
            })}
          </div>
          <div className="consistency-readout"><span>{t('diag.relation')}</span><strong>{consistencyRelation(snapshot?.native_consistency)}</strong><small>{t('diag.distance', { deg: formatNumber(snapshot?.native_consistency?.circular_distance_deg) })}</small></div>
        </Panel>
      </div>
      <div className="diagnostics-bottom-grid">
        <Panel className="operator-panel" eyebrow={t('diag.logEyebrow')} title={t('diag.logTitle')}>
          <ol className="operator-log">{events.map((event, index) => <li key={`${event.label}-${index}`}><span className="log-index">{String(index + 1).padStart(2, '0')}</span><div><strong>{event.label}</strong><span>{event.detail}</span></div></li>)}</ol>
        </Panel>
        <Panel className="effective-config-panel" eyebrow={t('diag.configEyebrow')} title={t('diag.configTitle')}>
          <div className="config-readout"><KeyValue label={t('diag.authority')} value={snapshot?.authority?.selected ?? 'NONE'} detail={t('diag.authorityDetail')} /><KeyValue label={t('diag.angleReadiness')} value={snapshot?.authority?.canonical_angle_ready === true ? 'READY' : t('diag.notConfigured')} detail={t('diag.angleDetail')} /><KeyValue label={t('diag.nativeViews')} value={nativeViewsReady(snapshot) && localSnapshotFresh ? 'FRESH / COMPARABLE' : 'NOT READY'} detail={t('diag.nativeDetail')} /><KeyValue label={t('diag.settingsSource')} value={snapshot?.settings?.redacted === true ? 'REDACTED FIELDS' : 'UNAVAILABLE'} detail={t('diag.settingsDetail')} />{Object.entries(fields).filter(([key]) => !/(pass|secret|token|key|credential)/i.test(key)).slice(0, 12).map(([key, value]) => <KeyValue key={key} label={key.replace(/_/g, ' ')} value={typeof value === 'boolean' ? (value ? 'ON' : 'OFF') : String(value)} />)}</div>
          <pre className="diagnostic-note">{safeJson({ local_snapshot_fresh: localSnapshotFresh, raw_settings_omitted: snapshot?.settings?.raw_fields_omitted ?? true })}</pre>
        </Panel>
      </div>
    </div>
  );
}
