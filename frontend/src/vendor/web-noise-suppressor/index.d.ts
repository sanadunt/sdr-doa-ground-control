// Declarations for the parts of @sapphi-red/web-noise-suppressor@0.4.1 (index.js) the console uses.
export declare class GtcrnWorkletNode extends AudioWorkletNode {
  constructor(context: BaseAudioContext, options: { maxChannels: number; wasmBinary: ArrayBuffer });
  destroy(): void;
}
export declare class SpeexWorkletNode extends AudioWorkletNode {
  constructor(context: BaseAudioContext, options: { maxChannels: number; wasmBinary: ArrayBuffer });
  destroy(): void;
}
export declare class NoiseGateWorkletNode extends AudioWorkletNode {
  constructor(context: BaseAudioContext, options: { openThreshold: number; closeThreshold?: number; holdMs: number; maxChannels: number });
}
export declare function loadGtcrn(options: { url: string }, init?: RequestInit): Promise<ArrayBuffer>;
export declare function loadSpeex(options: { url: string }, init?: RequestInit): Promise<ArrayBuffer>;
