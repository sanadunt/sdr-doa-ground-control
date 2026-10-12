// plotly.js ships no declarations for its per-trace CommonJS entry points.
declare module 'plotly.js/lib/core' {
  import Plotly from 'plotly.js';
  export default Plotly;
}

declare module 'plotly.js/lib/scatterpolar' {
  import type { PlotlyModule } from 'plotly.js';
  const scatterpolar: PlotlyModule;
  export default scatterpolar;
}
