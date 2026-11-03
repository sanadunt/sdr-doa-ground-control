import type { JSX } from 'react';
import type { OverviewPanelKey, OverviewPanels } from '../../lib/overviewPanels';
import { useI18n } from '../../lib/i18n';
import type { MessageKey } from '../../lib/i18n';
import { Icon } from '../ui';
import type { IconName } from '../ui';

type ToggleKey = OverviewPanelKey | 'node';

const TOGGLES: ReadonlyArray<{ key: OverviewPanelKey; icon: IconName; label: MessageKey; controls: string }> = [
  { key: 'layers', icon: 'layers', label: 'shell.panelLayers', controls: 'panel-layers' },
  { key: 'polar', icon: 'polar-dock', label: 'shell.panelPolar', controls: 'panel-polar' },
  { key: 'spectrum', icon: 'spectrum', label: 'shell.panelSpectrum', controls: 'panel-spectrum' },
  { key: 'drone', icon: 'drone', label: 'shell.panelDrone', controls: 'panel-drone' },
  { key: 'control', icon: 'sliders', label: 'shell.panelControl', controls: 'panel-control' },
];

// The compact touch layout: no Polar (the DoA is on the map), and the node card opens from its own toggle.
const COMPACT_TOGGLES: ReadonlyArray<{ key: ToggleKey; icon: IconName; label: MessageKey; controls: string }> = [
  { key: 'layers', icon: 'layers', label: 'shell.panelLayers', controls: 'panel-layers' },
  { key: 'spectrum', icon: 'spectrum', label: 'shell.panelSpectrum', controls: 'panel-spectrum' },
  { key: 'node', icon: 'antenna', label: 'shell.panelNode', controls: 'panel-node' },
  { key: 'drone', icon: 'drone', label: 'shell.panelDrone', controls: 'panel-drone' },
  { key: 'control', icon: 'sliders', label: 'shell.panelControl', controls: 'panel-control' },
];

/**
 * Top-bar switches for the Overview dashboard panels; the LAN view has no Kontrol switch.
 * In the compact layout they are icons only, Polar is left out and an RDF-SDR switch opens
 * the node card over the map for this visit (`nodeOpen`, never saved).
 */
export function OverviewPanelToggles({ panels, onChange, viewOnly = false, compact = false, nodeOpen = false, onNodeOpenChange }: {
  panels: OverviewPanels;
  onChange: (next: OverviewPanels) => void;
  viewOnly?: boolean;
  compact?: boolean;
  nodeOpen?: boolean;
  onNodeOpenChange?: (open: boolean) => void;
}): JSX.Element {
  const { t } = useI18n();
  const toggles = compact ? COMPACT_TOGGLES : TOGGLES;
  return (
    <div className={compact ? 'ov-panel-toggles is-compact' : 'ov-panel-toggles'} role="group" aria-label={t('shell.panels')}>
      {toggles.filter(({ key }) => !(viewOnly && key === 'control')).map(({ key, icon, label, controls }) => {
        const open = key === 'node' ? nodeOpen : panels[key];
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
            onClick={() => (key === 'node' ? onNodeOpenChange?.(!open) : onChange({ ...panels, [key]: !open }))}
          >
            <Icon name={icon} />
            <span className="ov-toggle-label">{text}</span>
          </button>
        );
      })}
    </div>
  );
}
