import type { JSX } from 'react';
import type { OverviewPanelKey, OverviewPanels } from '../../lib/overviewPanels';
import { useI18n } from '../../lib/i18n';
import type { MessageKey } from '../../lib/i18n';
import { Icon } from '../ui';
import type { IconName } from '../ui';

const TOGGLES: ReadonlyArray<{ key: OverviewPanelKey; icon: IconName; label: MessageKey; controls: string }> = [
  { key: 'layers', icon: 'layers', label: 'shell.panelLayers', controls: 'panel-layers' },
  { key: 'polar', icon: 'polar-dock', label: 'shell.panelPolar', controls: 'panel-polar' },
  { key: 'spectrum', icon: 'spectrum', label: 'shell.panelSpectrum', controls: 'panel-spectrum' },
  { key: 'control', icon: 'sliders', label: 'shell.panelControl', controls: 'panel-control' },
];

/** Top-bar switches for the Overview dashboard panels. */
export function OverviewPanelToggles({ panels, onChange }: { panels: OverviewPanels; onChange: (next: OverviewPanels) => void }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="ov-panel-toggles" role="group" aria-label={t('shell.panels')}>
      {TOGGLES.map(({ key, icon, label, controls }) => {
        const open = panels[key];
        const text = t(label);
        return (
          <button
            key={key}
            type="button"
            aria-pressed={open}
            // Points at the panel only while it is rendered.
            aria-controls={open ? controls : undefined}
            aria-label={text}
            title={text}
            onClick={() => onChange({ ...panels, [key]: !open })}
          >
            <Icon name={icon} />
            <span className="ov-toggle-label">{text}</span>
          </button>
        );
      })}
    </div>
  );
}
