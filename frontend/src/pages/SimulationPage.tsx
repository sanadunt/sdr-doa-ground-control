import { useMemo, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { SimulationSettings } from '../lib/simulation';
import { simulationHalfPowerWidth, simulationSnapshot, validateSimulation } from '../lib/simulation';
import { halfPowerWidth } from '../lib/doaGeometry';
import { geographicBearingForBin } from '../lib/polar';
import { useI18n } from '../lib/i18n';
import type { MessageKey } from '../lib/i18n';
import { Icon } from '../components/ui';
import { Card, EmptyState, FormField, KeyValueGrid, Page, PageGrid, PageHeader, StatusChip, Switch, Tag } from '../components/page';

type ScenarioKey = 'angle' | 'width' | 'latitude' | 'longitude';
type Draft = Record<ScenarioKey, string>;

/** Ranges as validateSimulation checks them (the bearing accepts anything below 360). */
const SCENARIO_FIELDS: ReadonlyArray<{ key: ScenarioKey; label: MessageKey; min: number; max: number; step: string; placeholder: string }> = [
  { key: 'angle', label: 'sim.angle', min: 0, max: 359, step: '1', placeholder: '0–359' },
  { key: 'width', label: 'sim.width', min: 5, max: 60, step: '1', placeholder: '5–60' },
  { key: 'latitude', label: 'sim.latitude', min: -90, max: 90, step: 'any', placeholder: '−90…90' },
  { key: 'longitude', label: 'sim.longitude', min: -180, max: 180, step: 'any', placeholder: '−180…180' },
];

/** Six decimals (about 0.1 m) without trailing zeros. */
function coordinateText(value: number): string {
  return String(Number(value.toFixed(6)));
}

function draftFrom(settings: SimulationSettings): Draft {
  return { angle: String(settings.angle), width: String(settings.width), latitude: coordinateText(settings.latitude), longitude: coordinateText(settings.longitude) };
}

function parseDraft(draft: Draft): SimulationSettings {
  const number = (text: string) => (text.trim() === '' ? Number.NaN : Number(text));
  return { latitude: number(draft.latitude), longitude: number(draft.longitude), angle: number(draft.angle), width: number(draft.width) };
}

function fieldValid(key: ScenarioKey, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (key === 'angle') return value >= 0 && value < 360;
  if (key === 'width') return value >= 5 && value <= 60;
  if (key === 'latitude') return Math.abs(value) <= 90;
  return Math.abs(value) <= 180;
}

function sameSettings(left: SimulationSettings, right: SimulationSettings): boolean {
  return left.angle === right.angle && left.width === right.width
    && Number(left.latitude.toFixed(6)) === Number(right.latitude.toFixed(6))
    && Number(left.longitude.toFixed(6)) === Number(right.longitude.toFixed(6));
}

const SIZE = 240;
const CENTER = SIZE / 2;
const RADIUS = 92;
/** The synthetic vector spans −50 to −5 dB; the floor maps to the centre, the peak to the outer ring. */
const DB_FLOOR = -50;
const DB_SPAN = 45;

function point(bearing: number, radius: number): [number, number] {
  const radians = (bearing * Math.PI) / 180;
  return [CENTER + radius * Math.sin(radians), CENTER - radius * Math.cos(radians)];
}

function fixed(value: number): string {
  return value.toFixed(1);
}

/**
 * Compass view (north up, clockwise) of the lobe the scenario would draw, built
 * from the same synthetic vector and bin-to-bearing rule as the Dashboard, so
 * the page needs no Plotly.
 */
function LobePreview({ settings, label }: { settings: SimulationSettings; label: string }): ReactElement {
  const { t } = useI18n();
  const shape = useMemo(() => {
    const values = simulationSnapshot(settings).doa_candidates?.csv.angular_power_db ?? [];
    const lobe = values.map((value, bin) => {
      const [x, y] = point(geographicBearingForBin(bin, 0), (RADIUS * Math.max(0, value - DB_FLOOR)) / DB_SPAN);
      return `${bin === 0 ? 'M' : 'L'}${fixed(x)} ${fixed(y)}`;
    }).join(' ');
    const width = halfPowerWidth(values);
    const edges = width ? [width.startDeg, width.endDeg].map((bin) => geographicBearingForBin(bin, 0)) : [];
    return { lobe: `${lobe} Z`, edges };
  }, [settings]);
  const [tipX, tipY] = point(settings.angle, RADIUS);
  const cardinals: Array<[MessageKey, number]> = [['map.cardinalN', 0], ['map.cardinalE', 90], ['map.cardinalS', 180], ['map.cardinalW', 270]];
  return (
    <svg className="ms-preview" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={label}>
      {[0.25, 0.5, 0.75, 1].map((ring) => <circle key={ring} className={ring === 1 ? 'ms-preview-rim' : 'ms-preview-ring'} cx={CENTER} cy={CENTER} r={RADIUS * ring} />)}
      {[0, 30, 60, 90, 120, 150].map((bearing) => {
        const [x1, y1] = point(bearing, RADIUS);
        const [x2, y2] = point(bearing + 180, RADIUS);
        return <line key={bearing} className="ms-preview-spoke" x1={fixed(x1)} y1={fixed(y1)} x2={fixed(x2)} y2={fixed(y2)} />;
      })}
      {cardinals.map(([key, bearing]) => {
        const [x, y] = point(bearing, RADIUS + 13);
        return <text key={key} className="ms-preview-cardinal" x={fixed(x)} y={fixed(y)}>{t(key)}</text>;
      })}
      <path className="ms-preview-lobe" d={shape.lobe} />
      {shape.edges.map((bearing, index) => {
        const [x, y] = point(bearing, RADIUS);
        return <line key={index} className="ms-preview-edge" x1={CENTER} y1={CENTER} x2={fixed(x)} y2={fixed(y)} />;
      })}
      <line className="ms-preview-bearing" x1={CENTER} y1={CENTER} x2={fixed(tipX)} y2={fixed(tipY)} />
      <circle className="ms-preview-tip" cx={fixed(tipX)} cy={fixed(tipY)} r={3.5} />
      <circle className="ms-preview-centre" cx={CENTER} cy={CENTER} r={3} />
    </svg>
  );
}

export function SimulationPage({ enabled, automatic, settings, onEnabled, onAutomatic, onSettings, onRandomize, onOverview }: {
  enabled: boolean; automatic: boolean; settings: SimulationSettings;
  onEnabled: (value: boolean) => void; onAutomatic: (value: boolean) => void;
  onSettings: (value: SimulationSettings) => void; onRandomize: () => void; onOverview: () => void;
}): ReactElement {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(settings));
  const [message, setMessage] = useState<MessageKey | null>(null);
  const parsed = useMemo(() => parseDraft(draft), [draft]);
  const draftValid = validateSimulation(parsed);
  // The field is a Gaussian σ; show the -3 dB width it gives, as the map legend reports it.
  const activeHalfPower = simulationHalfPowerWidth(settings);
  const draftHalfPower = draftValid ? simulationHalfPowerWidth(parsed) : null;
  const pending = draftValid && !sameSettings(parsed, settings);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draftValid) { setMessage('sim.invalid'); return; }
    onSettings(parsed); onAutomatic(false); setMessage('sim.applied');
  };

  return (
    <Page className="ms-page">
      <PageHeader
        title={t('route.simulation')}
        chips={<>
          <StatusChip label={t('status.sim')} code={enabled ? t('sim.on') : t('sim.off')} tone={enabled ? 'warn' : 'neutral'} />
          {enabled ? <Tag tone="warn">SIMULATION</Tag> : null}
          {enabled && automatic ? <Tag tone="warn">AUTO</Tag> : null}
        </>}
        actions={<button type="button" className="ov-button" onClick={onOverview}><Icon name="overview" />{t('sim.viewDashboard')}</button>}
      />
      <PageGrid className="ms-sim-grid">
        <Card span={4} title={t('sim.controlTitle')}>
          <div className="ms-switches">
            <Switch checked={enabled} onChange={onEnabled} label={t('sim.enable')} />
            <Switch checked={automatic} disabled={!enabled} onChange={onAutomatic} label={t('sim.auto')} />
          </div>
          <button type="button" className="ov-button" disabled={!enabled} onClick={onRandomize}><Icon name="reset" />{t('sim.randomize')}</button>
          <KeyValueGrid
            columns={1}
            label={t('sim.controlTitle')}
            items={[
              { id: 'bearing', label: t('sim.angle'), value: `${settings.angle}°`, tone: 'signal' },
              { id: 'sigma', label: t('sim.width'), value: `${settings.width}°` },
              { id: 'half-power', label: t('sim.halfPower'), value: activeHalfPower === null ? '—' : `${activeHalfPower}°` },
              { id: 'position', label: t('sim.position'), value: `${settings.latitude.toFixed(6)}, ${settings.longitude.toFixed(6)}` },
            ]}
          />
        </Card>
        <Card span={4} title={t('sim.scenarioTitle')} chip={pending ? <Tag tone="warn">DRAFT</Tag> : null}>
          <form className="ms-sim-form" noValidate onSubmit={submit}>
            <div className="ms-sim-fields">
              {SCENARIO_FIELDS.map((field) => (
                <FormField
                  key={field.key}
                  label={t(field.label)}
                  unit="°"
                  error={fieldValid(field.key, parsed[field.key]) ? undefined : t('sim.rangeError', { min: field.min, max: field.max })}
                >
                  <input
                    type="number"
                    required
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    placeholder={field.placeholder}
                    value={draft[field.key]}
                    onChange={(event) => { setDraft({ ...draft, [field.key]: event.target.value }); setMessage(null); }}
                  />
                </FormField>
              ))}
            </div>
            <div className="ms-form-actions">
              <button className="ov-button is-primary" type="submit">{t('sim.apply')}</button>
              <span role="status" className={message === 'sim.invalid' ? 'ms-form-status pg-text-bad' : 'ms-form-status pg-text-good'}>{message ? t(message) : ''}</span>
            </div>
          </form>
        </Card>
        <Card
          span={4}
          className="ms-sim-preview"
          title={t('sim.previewTitle')}
          chip={draftHalfPower !== null ? <Tag>{`−3 dB ${draftHalfPower}°`}</Tag> : null}
          actions={draftValid ? <span className="pg-card-meta">{`${parsed.angle}° · σ ${parsed.width}°`}</span> : null}
        >
          {draftValid
            ? <LobePreview settings={parsed} label={t('sim.previewTitle')} />
            : <EmptyState label="" code="INVALID" tone="bad" />}
        </Card>
      </PageGrid>
    </Page>
  );
}
