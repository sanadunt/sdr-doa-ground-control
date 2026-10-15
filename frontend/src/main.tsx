import { Component, StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initialLang, translate } from './lib/i18n';
import './styles.css';
import './console-design.css';
import './polar-layout.css';
import './overview-dashboard.css';
// MapLibre's stylesheet loads with the entry, not with the lazy map chunk:
// Vite preloads a chunk's CSS only once, so a sheet that failed during a
// console restart never loaded and a retried import drew markers unstyled.
// It comes last so its rules keep precedence over equally specific console
// rules, the order the map was built and checked with.
import 'maplibre-gl/dist/maplibre-gl.css';

/** Last-resort boundary: an uncaught render error shows a reload prompt instead of an empty page. */
class RootErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const lang = initialLang();
    return (
      <main className="app-crash" role="alert">
        <h1>{translate(lang, 'app.crashTitle')}</h1>
        <p>{translate(lang, 'app.crashDetail')}</p>
        <button className="primary-button" type="button" onClick={() => window.location.reload()}>{translate(lang, 'app.crashReload')}</button>
      </main>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
