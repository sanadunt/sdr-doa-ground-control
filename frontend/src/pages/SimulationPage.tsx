import { useState } from 'react';
import type { SimulationSettings } from '../lib/simulation';
import { validateSimulation } from '../lib/simulation';
import { useI18n } from '../lib/i18n';
import type { MessageKey } from '../lib/i18n';
import { Panel, SectionHeading, StatusBadge } from '../components/ui';

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
  const [draft, setDraft] = useState({ latitude: settings.latitude.toFixed(6), longitude: settings.longitude.toFixed(6), angle: String(settings.angle), width: String(settings.width) });
  const [message, setMessage] = useState<MessageKey | null>(null);
  return <div className="page">
    <SectionHeading eyebrow={t('sim.eyebrow')} title={t('sim.title')} detail={t('sim.detail')} />
    <div className="simulation-grid">
      <Panel title={t('sim.controlTitle')} eyebrow={t('sim.controlEyebrow')} action={<StatusBadge label={enabled ? t('sim.on') : t('sim.off')} tone={enabled ? 'warn' : 'neutral'} />}>
        <div className="simulation-controls">
          <label className="simulation-toggle"><input type="checkbox" checked={enabled} onChange={event => onEnabled(event.target.checked)} /> {t('sim.enable')}</label>
          <p>{t('sim.enableNote')}</p>
          <div className="form-actions compact">
            <button type="button" className="secondary-button" disabled={!enabled} onClick={onRandomize}>{t('sim.randomize')}</button>
            <button type="button" className="primary-button" onClick={onOverview}>{t('sim.viewOverview')}</button>
          </div>
          <label className="simulation-toggle"><input type="checkbox" checked={automatic} disabled={!enabled} onChange={event => onAutomatic(event.target.checked)} /> {t('sim.auto')}</label>
          <p className="simulation-active">{t('sim.active', { angle: settings.angle, width: settings.width, lat: settings.latitude.toFixed(6), lon: settings.longitude.toFixed(6) })}</p>
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
            {SCENARIO_FIELDS.map(field => <label className="form-field" key={field.key}><span>{t(field.label)}</span><input required type="number" min={field.min} max={field.max} step={field.step} value={draft[field.key]} onChange={event => setDraft({ ...draft, [field.key]: event.target.value })} /></label>)}
          </div>
          <p>{t('sim.shapeNote')}</p>
          <button className="primary-button" type="submit">{t('sim.apply')}</button>
          <p role="status">{message ? t(message) : ''}</p>
        </form>
      </Panel>
    </div>
  </div>;
}
