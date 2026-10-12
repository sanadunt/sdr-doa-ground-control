import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const PLOTLY_MAP_CSS_STUB = '\0plotly-maplibre-css-stub';

// plotly.js registers MapLibre's stylesheet for its map traces with a static
// require, so bundling only the polar trace would still emit a second copy of
// maplibre-gl.css. The map loads its own copy; Plotly's is replaced by nothing.
function skipPlotlyMapCss(): Plugin {
  return {
    name: 'skip-plotly-maplibre-css',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'maplibre-gl/dist/maplibre-gl.css' && importer && /[\\/]node_modules[\\/]plotly\.js[\\/]/.test(importer)) {
        return PLOTLY_MAP_CSS_STUB;
      }
      return null;
    },
    load(id) {
      return id === PLOTLY_MAP_CSS_STUB ? 'export {};' : null;
    },
  };
}

export default defineConfig({
  plugins: [skipPlotlyMapCss(), react()],
  // MapLibre starts its worker as an ES module worker.
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      output: {
        // React changes far less often than the console code, so keep it in a
        // separately cached chunk.
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react-vendor';
          return undefined;
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
  },
  preview: {
    host: '127.0.0.1',
  },
});
