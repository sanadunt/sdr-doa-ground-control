/**
 * The noise suppressor's files, loaded only when the voice filter needs them (radioAudioFilter.ts).
 * `?url&no-inline` makes Vite emit each file under assets/ and never inline it as a data: URL,
 * which the console's CSP (script-src 'self') would refuse for a worklet module.
 */
import gtcrnWasm from '../vendor/web-noise-suppressor/gtcrn.wasm?url&no-inline';
import speexWasm from '../vendor/web-noise-suppressor/speex.wasm?url&no-inline';
import gtcrnWorklet from '../vendor/web-noise-suppressor/gtcrn/workletProcessor.js?url&no-inline';
import speexWorklet from '../vendor/web-noise-suppressor/speex/workletProcessor.js?url&no-inline';
import gateWorklet from '../vendor/web-noise-suppressor/noiseGate/workletProcessor.js?url&no-inline';
import type { FilterAssets } from './radioAudioFilter';

export async function filterAssets(): Promise<FilterAssets> {
  const lib = await import('../vendor/web-noise-suppressor/index.js');
  return { lib, urls: { gtcrnWasm, speexWasm, gtcrnWorklet, speexWorklet, gateWorklet } };
}
