// Partial Plotly bundle with only the scatterpolar trace the polar panel uses.
// Evaluating the full distribution blocked the main thread for over a second
// on Overview; this bundle is about a quarter of its size.
import Plotly from 'plotly.js/lib/core';
import scatterpolar from 'plotly.js/lib/scatterpolar';

Plotly.register([scatterpolar]);

export type PlotlyApi = typeof Plotly;
export default Plotly;
