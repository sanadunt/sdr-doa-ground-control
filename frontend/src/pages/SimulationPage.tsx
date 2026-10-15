import { useState } from 'react';
import type { SimulationSettings } from '../lib/simulation';
import { simulationHalfPowerWidth, validateSimulation } from '../lib/simulation';
import { useI18n } from '../lib/i18n';
import type { MessageKey } from '../lib/i18n';
import { Panel, StatusBadge } from '../components/ui';
import { Page, PageHeader, StatusChip, Tag } from '../components/page';

const SCENARIO_FIELDS: ReadonlyArray<{ key: 'latitude' | 'longitude' | 'angle' | 'width'; label: MessageKey; min: number; max: number; step: string }> = [
  { key: 'latitude', label: 'sim.latitude', min: -90, max: 90, step: 'any' },
  { key: 'longitude', label: 'sim.longitude', min: -180, max: 180, step: 'any' },
  { key: 'angle', label: 'sim.angle', min: 0, max: 359, step: '1' },
  { key: 'width', label: 'sim.width', min: 5, max: 60, step: '1' },
];

export function SimulationPage({ enabled, automatic, settings, onEnabled, onAutomatic, onSettings, onRandomize, onOverview }: {
  enabled: boolean; automatic: boolean; settings: SimulationSettings;
  onEnabled: (value: boolean) => void; onAutomatic: (value: boolean) => void;
  onSettings: (value: SimulationSettings) => void; onRandomize: () => void; onOverview: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState({ latitude: String(settings.latitude), longitude: String(settings.longitude), angle: String(settings.angle), width: String(settings.width) });
  const [message, setMessage] = useState<MessageKey | null>(null);
  // The field is a Gaussian σ; show the -3 dB width it gives, as the map legend reports it.
  const activeHalfPower = simulationHalfPowerWidth(settings);
  const draftSigma = draft.width.trim() === '' ? Number.NaN : Number(draft.width);
  const draftHalfPower = simulationHalfPowerWidth({ ...settings, width: draftSigma });
  return <Page>
    <PageHeader
      title={t('route.simulation')}
      chips={<>
        <StatusChip label={t('status.sim')} code={enabled ? 'ON' : 'OFF'} tone={enabled ? 'warn' : 'neutral'} />
        {enabled ? <Tag tone="warn">SIMULATION</Tag> : null}
      </>}
    />
    <Panel title={t('sim.controlTitle')} eyebrow={t('sim.controlEyebrow')} action={<StatusBadge label={enabled ? t('sim.on') : t('sim.off')} tone={enabled ? 'warn' : 'neutral'} />}>
      <div className="simulation-controls">
        <label className="simulation-toggle"><input type="checkbox" checked={enabled} onChange={event => onEnabled(event.target.checked)} /> {t('sim.enable')}</label>
        <p>{t('sim.enableNote')}</p>
        <div className="form-actions compact">
          <button type="button" className="secondary-button" disabled={!enabled} onClick={onRandomize}>{t('sim.randomize')}</button>
          <button type="button" className="primary-button" onClick={onOverview}>{t('sim.viewDashboard')}</button>
        </div>
        <label className="simulation-toggle"><input type="checkbox" checked={automatic} disabled={!enabled} onChange={event => onAutomatic(event.target.checked)} /> {t('sim.auto')}</label>
        <p className="simulation-active">{t('sim.active', { angle: settings.angle, width: settings.width, halfPower: activeHalfPower ?? '—', lat: settings.latitude.toFixed(6), lon: settings.longitude.toFixed(6) })}</p>
      </div>
    </Panel>
    <Panel title={t('sim.scenarioTitle')} eyebrow={t('sim.scenarioEyebrow')}>
      <form className="simulation-controls" onSubmit={event => {
        event.preventDefault();
        const next = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.trim() === '' ? NaN : Number(value)])) as unknown as SimulationSettings;
        if (!validateSimulation(next)) { setMessage('sim.invalid'); return; }
        onSettings(next); onAutomatic(false); setMessage('sim.applied');
      }}>
        <div className="form-grid">
          {SCENARIO_FIELDS.map(field => <label className="form-field" key={field.key}><span>{t(field.label)}</span><input required type="number" min={field.min} max={field.max} step={field.step} value={draft[field.key]} onChange={event => setDraft({ ...draft, [field.key]: event.target.value })} />{field.key === 'width' ? <small>{t('sim.widthHelp')}{draftHalfPower !== null ? ` ${t('sim.widthHalfPower', { width: draftHalfPower })}` : ''}</small> : null}</label>)}
        </div>
        <p>{t('sim.shapeNote')}</p>
        <button className="primary-button" type="submit">{t('sim.apply')}</button>
        <p role="status">{message ? t(message) : ''}</p>
      </form>
    </Panel>
  </Page>;
}
