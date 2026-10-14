import { Component } from 'react';
import type { ContextType, ReactNode } from 'react';
import { I18nContext } from '../lib/i18n';

/**
 * Contains a failed lazy chunk (or a render error) to one region, so the shell
 * and a running Receiver frame stay up. A failed React.lazy import is cached,
 * so the only way forward is a reload, which the operator starts.
 */
export class LoadErrorBoundary extends Component<{ children: ReactNode; variant?: 'route' | 'map' }, { failed: boolean }> {
  static contextType = I18nContext;
  declare context: ContextType<typeof I18nContext>;
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { t } = this.context;
    const reload = <button className="primary-button" type="button" onClick={() => window.location.reload()}>{t('app.crashReload')}</button>;
    if (this.props.variant === 'map') {
      return (
        <section className="panel map-panel map-panel-loading" role="alert">
          <div className="map-frame"><span className="map-loading-label">{t('app.mapLoadFailed')}</span>{reload}</div>
        </section>
      );
    }
    return (
      <div className="app-crash" role="alert">
        <h1 tabIndex={-1}>{t('app.loadFailedTitle')}</h1>
        <p>{t('app.loadFailedDetail')}</p>
        {reload}
      </div>
    );
  }
}
