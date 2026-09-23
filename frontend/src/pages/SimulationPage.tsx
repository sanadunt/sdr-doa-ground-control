import { useState } from 'react';
import type { SimulationSettings } from '../lib/simulation';
import { validateSimulation } from '../lib/simulation';
import { Panel, SectionHeading, StatusBadge } from '../components/ui';

export function SimulationPage({ enabled, automatic, settings, onEnabled, onAutomatic, onSettings, onRandomize, onOverview }: {
  enabled: boolean; automatic: boolean; settings: SimulationSettings;
  onEnabled: (value: boolean) => void; onAutomatic: (value: boolean) => void;
  onSettings: (value: SimulationSettings) => void; onRandomize: () => void; onOverview: () => void;
}) {
  const [draft, setDraft] = useState({ latitude: String(settings.latitude), longitude: String(settings.longitude), angle: String(settings.angle), width: String(settings.width) });
  const [message, setMessage] = useState('');
  return <div className="page">
    <SectionHeading eyebrow="Local renderer / Synthetic data" title="Simulasi" detail="Uji map dan grafik polar tanpa SDR. Hanya Overview menggunakan sumber simulasi; halaman health, diagnostics, dan MQTT tetap menampilkan sumber nyata." />
    <Panel title="Sumber grafik" eyebrow="Simulation control" action={<StatusBadge label={enabled ? 'SIMULATION ON' : 'OFF'} tone="warn" />}>
      <div className="simulation-controls">
        <label className="simulation-toggle"><input type="checkbox" checked={enabled} onChange={event => onEnabled(event.target.checked)} /> Aktifkan simulasi di Overview</label>
        <p>Data dibuat di browser. Tidak ada publish MQTT, perubahan perangkat, atau klaim GPS live. Mode kembali OFF setelah reload.</p>
        <div className="form-actions compact">
          <button type="button" className="secondary-button" disabled={!enabled} onClick={onRandomize}>Randomize sudut & bentuk DoA</button>
          <button type="button" className="primary-button" onClick={onOverview}>Lihat grafik di Overview</button>
        </div>
        <label className="simulation-toggle"><input type="checkbox" checked={automatic} disabled={!enabled} onChange={event => onAutomatic(event.target.checked)} /> Randomize sudut & lebar lobe setiap 1 detik</label>
        <p>Sudut aktif: <strong>{settings.angle}°</strong> · lebar lobe {settings.width}° · posisi {settings.latitude}, {settings.longitude}</p>
      </div>
    </Panel>
    <Panel title="Lokasi dan bentuk sinyal" eyebrow="Synthetic scenario">
      <form className="simulation-controls" onSubmit={event => {
        event.preventDefault();
        const next = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.trim() === '' ? NaN : Number(value)])) as unknown as SimulationSettings;
        if (!validateSimulation(next)) { setMessage('Koordinat, sudut, atau lebar lobe tidak valid. Periksa rentang input.'); return; }
        onSettings(next); onAutomatic(false); setMessage('Skenario diterapkan. Randomize otomatis dihentikan.');
      }}>
        <div className="form-grid">
          {([{ key: 'latitude', label: 'Latitude', min: -90, max: 90, step: 'any' }, { key: 'longitude', label: 'Longitude', min: -180, max: 180, step: 'any' }, { key: 'angle', label: 'DoA (0–359°)', min: 0, max: 359, step: '1' }, { key: 'width', label: 'Lebar lobe (5–60°)', min: 5, max: 60, step: '1' }] as const).map(field => <label className="form-field" key={field.key}><span>{field.label}</span><input required type="number" min={field.min} max={field.max} step={field.step} value={draft[field.key]} onChange={event => setDraft({ ...draft, [field.key]: event.target.value })} /></label>)}
        </div>
        <p>Kurva Gaussian sintetis 360 bin, −50 sampai −5 dB. Sudut 0° di atas, bertambah searah jarum jam; bukan model akurasi RF atau estimasi target.</p>
        <button className="primary-button" type="submit">Terapkan skenario</button>
        <p role="status">{message}</p>
      </form>
    </Panel>
  </div>;
}