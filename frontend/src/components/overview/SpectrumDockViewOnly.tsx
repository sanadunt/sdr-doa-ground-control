import type { JSX } from 'react';
import { useI18n } from '../../lib/i18n';

/**
 * The spectrum dock in the LAN view. The Receiver frame is never mounted
 * there: it would try to claim the HackRF through this browser's WebUSB,
 * and the radio is on the groundstation's USB.
 */
export function SpectrumDockViewOnly(): JSX.Element {
  const { t } = useI18n();
  return (
    <section id="panel-spectrum" className="ov-spectrum is-view-only" aria-labelledby="ov-spectrum-title">
      <div className="ov-dock-head ov-spec-head">
        <h2 id="ov-spectrum-title">{t('spectrum.title')}</h2>
        <span className="ov-spec-source">{t('spectrum.sourceHackrf')}</span>
      </div>
      <div className="ov-spec-main">
        <div className="ov-spec-body">
          <div className="ov-spec-overlay" role="status">{t('lanView.receiverOnGroundstation')}</div>
        </div>
      </div>
    </section>
  );
}
