import { useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { Candidate, TelemetrySnapshot } from '../types';
import { candidate, formatNumber, nativeViewsReady } from '../lib/telemetry';
import { gateReasonLabel, useI18n } from '../lib/i18n';
import type { Translate } from '../lib/i18n';
import { actionableGateReasons, rankGateReasons } from '../lib/doaStatus';
import {
  candidateIssue,
  consistencyView,
  csvRowsView,
  errorKindKey,
  evidenceExpired,
  formatAgeText,
  formatDuration,
  gateCheckKey,
  gateCheckRows,
  humanizeKey,
  collectorErrorText,
  isSecretSettingKey,
  peakConsistency,
  resourceRow,
  settingValueText,
  signalQualityView,
  stateTone,
} from '../lib/healthView';
import type { ConsistencyView, CsvRowsView, GateCheckRow } from '../lib/healthView';
import { CollectorError } from '../components/ui';
import { Card, DataTable, EmptyState, KeyValueGrid, Notice, Page, PageGrid, PageHeader, PageStack, StatusChip, Tag } from '../components/page';
import type { DataColumn, KeyValueItem, PageTone } from '../components/page';

// The collector already allowlists these fields; the cap only bounds an
// unexpected response.
const MAX_CONFIG_FIELDS = 64;

function checkLabel(key: string, t: Translate): string {
  const messageKey = gateCheckKey(key);
  return messageKey ? t(messageKey) : humanizeKey(key);
}

function degrees(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${formatNumber(value)}°` : 'N/A';
}

function GateCard({ snapshot }: { snapshot: TelemetrySnapshot | null }): JSX.Element {
  const { lang, t } = useI18n();
  const [showPass, setShowPass] = useState(false);
  const gate = snapshot?.publication_gate;
  const gateState = String(gate?.state ?? 'BLOCKED').toUpperCase();
  const rows = gateCheckRows(gate?.checks);
  const passing = rows.filter((row) => row.state === 'PASS');
  const shown = showPass ? rows : rows.filter((row) => row.state !== 'PASS');
  const reasons = rankGateReasons(gate?.reasons);
  const actionable = new Set(actionableGateReasons(reasons));
  return (
    <Card
      title={t('diag.gateTitle')}
      chip={<StatusChip code={gateState} tone={gateState === 'READY' ? 'good' : 'warn'} />}
      actions={passing.length ? (
        <button className="ov-button" type="button" aria-pressed={showPass} onClick={() => setShowPass((value) => !value)}>
          {showPass ? t('diag.hidePass') : t('diag.showPass', { count: passing.length })}
        </button>
      ) : null}
      flush
    >
      {rows.length ? (
        <ul className="hd-checks" aria-label={t('diag.gateTitle')}>
          {shown.map((row: GateCheckRow) => (
            <li key={row.key} className="hd-check">
              <span className="hd-check-label" title={row.key}>{checkLabel(row.key, t)}</span>
              <StatusChip code={row.state} tone={row.tone} />
            </li>
          ))}
        </ul>
      ) : <EmptyState label={t('diag.noGate')} code={snapshot ? 'N/A' : 'WAITING'} />}
      {reasons.length ? (
        <div className="hd-reasons">
          <span className="pg-micro">{t('diag.reasons')}</span>
          <ul aria-label={t('diag.reasons')}>
            {reasons.map((reason) => (
              <li key={reason} className={actionable.has(reason) ? 'is-actionable' : undefined}>
                <span className="hd-reason-text">{gateReasonLabel(lang, reason)}</span>
                <Tag tone={actionable.has(reason) ? 'bad' : 'neutral'}>{reason}</Tag>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

type RecordSide = { state: string; item: Candidate; issue: ReturnType<typeof candidateIssue> };

interface FieldRow {
  id: string;
  label: string;
  csv: ReactNode;
  xml: ReactNode;
  /** Shown as the row's tooltip, e.g. the angle convention. */
  title?: string;
  className?: string;
}

function recordSide(item: Candidate): RecordSide {
  const issue = candidateIssue(item);
  return { state: item.available !== true ? 'MISSING' : issue.quarantined ? 'INVALID' : 'PRESENT', item, issue };
}

function HttpCell({ snapshot, path }: { snapshot: TelemetrySnapshot | null; path: '/DOA_value.html' | '/doa.xml' }): JSX.Element {
  const { t } = useI18n();
  const resource = resourceRow(snapshot, path);
  if (resource.ok === true) {
    return (
      <span className="hd-cell-inline">
        <StatusChip code={resource.httpStatus === null ? 'OK' : `HTTP ${resource.httpStatus}`} tone="good" />
        {resource.elapsedMs !== null ? <span>{formatDuration(t, resource.elapsedMs)}</span> : null}
      </span>
    );
  }
  if (resource.ok === false) {
    // The record's own error row names the cause; the chip carries it as a tooltip.
    const cause = resource.error ? collectorErrorText(t, resource.error).text : undefined;
    return <StatusChip code={t(errorKindKey(resource.errorKind))} tone={resource.errorKind === 'skipped' ? 'warn' : 'bad'} title={cause} />;
  }
  return <span>N/A</span>;
}

function rowsValue(rows: CsvRowsView): string {
  if (rows.total === null) return 'N/A';
  return `${rows.index === null ? '—' : rows.index + 1} / ${rows.total}`;
}

function RelationStrip({ consistency }: { consistency: ConsistencyView }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="hd-relation" role="group" aria-label={t('diag.relation')}>
      {consistency.frameRelation ? (
        <span className="pg-chip"><span className="pg-chip-label">{t('page.chip.frame')}</span><StatusChip code={consistency.frameRelation} /></span>
      ) : null}
      <span className="hd-relation-value"><span className="hd-delta">Δt</span><span className="pg-value">{consistency.timestampDeltaMs === null ? 'N/A' : formatDuration(t, consistency.timestampDeltaMs)}</span></span>
      <span className="hd-relation-value" title={t('diag.distance', { deg: formatNumber(consistency.distanceDeg), tolerance: formatNumber(consistency.toleranceDeg) })}>
        <span className="hd-delta">Δθ</span>
        <span className="pg-value">{degrees(consistency.distanceDeg)} / {degrees(consistency.toleranceDeg)}</span>
      </span>
    </div>
  );
}

function NativeRecordsCard({ snapshot }: { snapshot: TelemetrySnapshot | null }): JSX.Element {
  const { t } = useI18n();
  const csv = recordSide(candidate(snapshot, 'csv'));
  const xml = recordSide(candidate(snapshot, 'xml'));
  const consistency = consistencyView(snapshot?.native_consistency);
  const rows = csvRowsView(csv.item);
  const peak = peakConsistency(csv.item);
  const quality = signalQualityView(snapshot);
  const xmlOverdrive = typeof xml.item.adc_overdrive_active === 'boolean' ? (xml.item.adc_overdrive_active ? 'OVERDRIVE' : 'PASS') : 'N/A';
  const xmlMask = typeof xml.item.adc_overdrive_channel_mask === 'number' ? `0b${xml.item.adc_overdrive_channel_mask.toString(2)}` : null;
  const age = (side: RecordSide): ReactNode => side.item.available === true
    ? <span className={side.item.freshness?.fresh === true ? undefined : 'pg-text-warn'}>{formatAgeText(t, side.item.freshness)}</span>
    : 'N/A';
  const convention = (side: RecordSide): string | undefined => typeof side.item.angle_convention === 'string' ? side.item.angle_convention : undefined;
  const fields: FieldRow[] = [
    { id: 'state', label: t('diag.row.state'), csv: <StatusChip code={csv.state} />, xml: <StatusChip code={xml.state} /> },
    {
      id: 'raw',
      label: t('diag.rawAngle'),
      csv: <span title={convention(csv)}>{degrees(csv.item.doa_raw_deg)}</span>,
      xml: <span title={convention(xml)}>{degrees(xml.item.doa_raw_deg)}</span>,
    },
    { id: 'canonical', label: t('diag.canonical'), csv: degrees(csv.item.canonical_angle_deg), xml: degrees(xml.item.canonical_angle_deg) },
    { id: 'age', label: t('diag.ageAtRead'), csv: age(csv), xml: age(xml) },
    { id: 'http', label: t('diag.http'), csv: <HttpCell snapshot={snapshot} path="/DOA_value.html" />, xml: <HttpCell snapshot={snapshot} path="/doa.xml" /> },
    { id: 'units', label: t('diag.units'), csv: csv.item.native_metrics_state ?? 'N/A', xml: xml.item.native_metrics_state ?? 'N/A' },
    { id: 'contract', label: t('diag.contract'), csv: csv.item.contract_mapping_state ?? 'N/A', xml: xml.item.contract_mapping_state ?? 'N/A' },
    {
      id: 'rows',
      label: t('diag.csvRows'),
      csv: <span title={rows.selection === 'matched_xml_frequency' ? t('diag.csvRowsMatched') : rows.selection === 'single_row' ? t('diag.csvRowsSingle') : undefined}>{rowsValue(rows)}</span>,
      xml: '—',
    },
    {
      id: 'peak',
      label: t('diag.peakVsTheta'),
      csv: (
        <span
          className={peak.consistent === false ? 'pg-text-bad' : undefined}
          title={peak.toleranceDeg === null ? undefined : t(peak.consistent === false ? 'diag.peakMismatch' : 'diag.peakConsistent', { tolerance: formatNumber(peak.toleranceDeg) })}
        >
          {peak.distanceDeg === null ? 'N/A' : `${formatNumber(peak.distanceDeg)}°`}
        </span>
      ),
      xml: '—',
    },
    { id: 'snr', label: 'SNR', csv: '—', xml: quality?.snrDb === null || !quality ? 'N/A' : `${formatNumber(quality.snrDb)} dB` },
    {
      id: 'adc',
      label: 'ADC overdrive',
      csv: '—',
      xml: <span className="hd-cell-inline"><StatusChip code={xmlOverdrive} tone={xmlOverdrive === 'OVERDRIVE' ? 'bad' : xmlOverdrive === 'PASS' ? 'good' : 'neutral'} />{xmlMask ? <span>{xmlMask}</span> : null}</span>,
    },
  ];
  const errorCell = (side: RecordSide): ReactNode => side.issue.error ? <span className="hd-error-text pg-text-bad"><CollectorError error={side.issue.error} /></span> : '—';
  if (csv.issue.error || xml.issue.error) fields.push({ id: 'error', label: t('diag.recordError'), csv: errorCell(csv), xml: errorCell(xml), className: 'is-error' });
  if (csv.issue.quarantined || xml.issue.quarantined) {
    fields.push({
      id: 'quarantine',
      label: 'NATIVE_ANGLE_INVALID',
      csv: csv.issue.quarantined ? <span className="hd-error-text pg-text-bad">{csv.issue.quarantined}</span> : '—',
      xml: xml.issue.quarantined ? <span className="hd-error-text pg-text-bad">{xml.issue.quarantined}</span> : '—',
      className: 'is-error',
    });
  }
  const columns: Array<DataColumn<FieldRow>> = [
    { key: 'field', label: t('diag.field'), render: (row) => <span title={row.title}>{row.label}</span>, className: 'hd-field-cell' },
    { key: 'csv', label: 'CSV', numeric: true, render: (row) => row.csv },
    { key: 'xml', label: 'XML', numeric: true, render: (row) => row.xml },
  ];
  const vfoColumns: Array<DataColumn<CsvRowsView['additional'][number]>> = [
    { key: 'row', label: t('diag.vfoRow'), numeric: true, render: (row) => row.rowIndex === null ? '—' : row.rowIndex + 1 },
    { key: 'frequency', label: t('diag.vfoFrequency'), numeric: true, render: (row) => row.frequencyHz === null ? 'N/A' : `${formatNumber(row.frequencyHz / 1e6, 4)} MHz` },
    { key: 'raw', label: t('diag.rawAngle'), numeric: true, render: (row) => row.rawDeg === null ? 'N/A' : `${formatNumber(row.rawDeg)}°` },
    { key: 'canonical', label: t('diag.canonical'), numeric: true, render: (row) => row.canonicalDeg === null ? 'N/A' : `${formatNumber(row.canonicalDeg)}°` },
    { key: 'papr', label: 'PAPR', numeric: true, render: (row) => formatNumber(row.confidenceRaw, 2) },
    { key: 'power', label: t('diag.vfoPower'), numeric: true, render: (row) => formatNumber(row.powerRaw) },
  ];
  return (
    <Card
      title={t('diag.ledgerTitle')}
      chip={<StatusChip code={consistency.relation} tone={stateTone(consistency.relation)} title={consistency.angleChecked === false ? t('diag.angleNotChecked') : undefined} />}
      span={7}
      flush
    >
      <DataTable columns={columns} rows={fields} rowKey={(row) => row.id} rowClassName={(row) => row.className} label={t('diag.ledgerTitle')} stack={false} className="hd-ledger" />
      <RelationStrip consistency={consistency} />
      {rows.additional.length ? (
        <div className="hd-vfo">
          <span className="pg-micro hd-vfo-title">{t('diag.vfoRowsTitle')}</span>
          <DataTable columns={vfoColumns} rows={rows.additional} rowKey={(row, index) => `${row.rowIndex ?? 'row'}-${index}`} label={t('diag.vfoRowsTitle')} />
        </div>
      ) : null}
    </Card>
  );
}

function decisionTone(value: string): PageTone {
  if (value === 'READY' || value === 'FRESH / COMPARABLE' || value === 'REDACTED FIELDS') return 'good';
  if (value === 'UNAVAILABLE' || value === 'NOT READY') return 'warn';
  return 'neutral';
}

function CollectorCard({ snapshot, localSnapshotFresh }: { snapshot: TelemetrySnapshot | null; localSnapshotFresh: boolean }): JSX.Element {
  const { t } = useI18n();
  const source = !snapshot ? 'WAITING' : snapshot.settings?.available === true ? 'REDACTED FIELDS' : 'UNAVAILABLE';
  const authority = String(snapshot?.authority?.selected ?? 'NONE').toUpperCase().slice(0, 32);
  const angle = snapshot?.authority?.canonical_angle_ready === true ? 'READY' : 'NOT CONFIGURED';
  const views = nativeViewsReady(snapshot) && localSnapshotFresh ? 'FRESH / COMPARABLE' : 'NOT READY';
  const rawOmitted = snapshot?.settings?.raw_fields_omitted ?? true;
  const chip = (code: string): ReactNode => <StatusChip code={code} tone={decisionTone(code)} />;
  const items: KeyValueItem[] = [
    { id: 'authority', label: t('diag.authority'), value: chip(authority) },
    { id: 'angle', label: t('diag.angleReadiness'), value: chip(angle) },
    { id: 'views', label: t('diag.nativeViews'), value: chip(views) },
    { id: 'source', label: t('diag.settingsSource'), value: chip(source) },
    { id: 'fresh', label: <code>local_snapshot_fresh</code>, value: localSnapshotFresh ? 'true' : 'false' },
    { id: 'omitted', label: <code>raw_settings_omitted</code>, value: rawOmitted === false ? 'false' : 'true' },
  ];
  return (
    <Card title="Collector">
      <KeyValueGrid items={items} label="Collector" className="hd-collector" />
    </Card>
  );
}

function EffectiveConfigCard({ snapshot }: { snapshot: TelemetrySnapshot | null }): JSX.Element {
  const { t } = useI18n();
  const fields = Object.entries(snapshot?.settings?.fields ?? {}).filter(([key]) => !isSecretSettingKey(key));
  const shownFields = fields.slice(0, MAX_CONFIG_FIELDS);
  const settingsError = typeof snapshot?.settings?.error === 'string' ? snapshot.settings.error : null;
  const available = snapshot?.settings?.available === true;
  const settings: KeyValueItem[] = shownFields.map(([key, value]) => ({ id: key, label: key, value: settingValueText(key, value) }));
  return (
    <Card title={t('diag.configTitle')} chip={snapshot && !available ? <StatusChip code="UNAVAILABLE" tone="warn" /> : null} span={12}>
      {settingsError ? <Notice tone="warn" title="settings.json"><CollectorError error={settingsError} /></Notice> : null}
      {settings.length
        ? <KeyValueGrid items={settings} columns={3} labels="mono" label={t('diag.configTitle')} />
        : <EmptyState label={t('diag.noSettings')} code={snapshot ? 'N/A' : 'WAITING'} />}
      {fields.length > shownFields.length ? <span className="pg-sub">{t('diag.moreFields', { count: fields.length - shownFields.length })}</span> : null}
    </Card>
  );
}

export function DoADiagnosticsPage({ snapshot, localSnapshotFresh }: { snapshot: TelemetrySnapshot | null; localSnapshotFresh: boolean }): JSX.Element {
  const { t } = useI18n();
  const gateState = String(snapshot?.publication_gate?.state ?? 'BLOCKED').toUpperCase();
  const consistency = consistencyView(snapshot?.native_consistency);
  const csv = candidate(snapshot, 'csv');
  const xml = candidate(snapshot, 'xml');
  // θ₀ as the Dashboard reads it: the CSV view carries the vector.
  const theta = typeof csv.canonical_angle_deg === 'number' ? csv.canonical_angle_deg : typeof xml.canonical_angle_deg === 'number' ? xml.canonical_angle_deg : null;
  return (
    <Page className="hd-page">
      <PageHeader
        title={t('route.doa-diagnostics')}
        chips={<>
          <StatusChip label={t('status.delivery')} code={gateState} tone={gateState === 'READY' ? 'good' : 'warn'} />
          <span className="pg-chip"><span className="pg-chip-label">θ₀</span><Tag tone={theta === null ? 'neutral' : 'signal'}>{degrees(theta)}</Tag></span>
          <StatusChip label="CSV↔XML" code={consistency.relation} tone={stateTone(consistency.relation)} />
          {consistency.frameRelation ? <StatusChip label={t('page.chip.frame')} code={consistency.frameRelation} /> : null}
        </>}
      />
      {evidenceExpired(snapshot, localSnapshotFresh) ? <Notice tone="warn" title={t('common.staleEvidence')}>{t('diag.stale')}</Notice> : null}
      <PageGrid>
        <PageStack span={5}>
          <GateCard snapshot={snapshot} />
          <CollectorCard snapshot={snapshot} localSnapshotFresh={localSnapshotFresh} />
        </PageStack>
        <NativeRecordsCard snapshot={snapshot} />
        <EffectiveConfigCard snapshot={snapshot} />
      </PageGrid>
    </Page>
  );
}
