/**
 * Voice filter for the radio audio the operator hears (docs/superpowers/specs/2026-11-10-radio-audio-filter-design.md).
 *
 * A Web Audio chain, in this order:
 *   input -> high-pass x2 -> low-pass x2 -> AI noise suppressor -> clarity -> noise gate
 *         -> AGC (compressor) -> boost -> limiter -> volume -> output
 *
 * Copied from radio-translate-papua v1.4.1 (static/radio-audio-filter.js) with the same chain,
 * values and presets. The noise suppressor (GTCRN or Speex) and the gate are AudioWorklets with
 * WASM from src/vendor/web-noise-suppressor; GTCRN and Speex need a 48 kHz AudioContext, and on
 * any other rate the status says so instead of skipping them. A node that has not loaded yet is
 * left out and the chain is joined again once it is ready, so the audio keeps playing meanwhile.
 *
 * Only for what is heard: recordings, Whisper and the audio the Receiver mirror sends to tablets
 * never pass through it. The Receiver frame uses this same file (tools/build_browsdr_receiver.py
 * copies it, with radioAudioFilterAssets.ts and the vendor folder).
 */

export type DenoiseKind = 'off' | 'gtcrn' | 'speex';
export const DENOISE_KINDS: readonly DenoiseKind[] = ['off', 'gtcrn', 'speex'];
export const FILTER_PRESET_NAMES = ['off', 'light', 'standard', 'strong'] as const;
export type NamedPreset = typeof FILTER_PRESET_NAMES[number];
export type FilterPreset = NamedPreset | 'custom';

export interface FilterControls {
  bandpass: boolean;
  lowHz: number;
  highHz: number;
  denoise: DenoiseKind;
  clarity: boolean;
  agc: boolean;
  gate: boolean;
  boostDb: number;
}

export interface FilterSettings extends FilterControls {
  preset: FilterPreset;
}

export const FILTER_PRESETS: Readonly<Record<NamedPreset, Readonly<FilterControls>>> = {
  off: { bandpass: false, lowHz: 300, highHz: 3000, denoise: 'off', clarity: false, agc: false, gate: false, boostDb: 0 },
  light: { bandpass: true, lowHz: 300, highHz: 3400, denoise: 'off', clarity: true, agc: true, gate: false, boostDb: 6 },
  standard: { bandpass: true, lowHz: 300, highHz: 3000, denoise: 'gtcrn', clarity: true, agc: true, gate: false, boostDb: 6 },
  strong: { bandpass: true, lowHz: 350, highHz: 2800, denoise: 'gtcrn', clarity: true, agc: true, gate: true, boostDb: 9 },
};

/** Bounds of the custom controls; a stored or received value outside them is refused. */
export const FILTER_LIMITS = {
  lowHz: { min: 50, max: 1000 },
  highHz: { min: 1500, max: 8000 },
  boostDb: { min: 0, max: 18, step: 1 },
} as const;

/** The default is Standard, as the owner's specification says. */
export const DEFAULT_FILTER_SETTINGS: Readonly<FilterSettings> = { preset: 'standard', ...FILTER_PRESETS.standard };

export function presetSettings(name: NamedPreset): FilterSettings {
  return { preset: name, ...FILTER_PRESETS[name] };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** One control changed by the operator: the preset becomes 'custom'. */
export function withControls(settings: FilterSettings, patch: Partial<FilterControls>): FilterSettings {
  const next: FilterSettings = { ...settings, ...patch, preset: 'custom' };
  next.lowHz = Math.round(clampNumber(next.lowHz, FILTER_LIMITS.lowHz.min, FILTER_LIMITS.lowHz.max));
  next.highHz = Math.round(clampNumber(next.highHz, FILTER_LIMITS.highHz.min, FILTER_LIMITS.highHz.max));
  next.boostDb = Math.round(clampNumber(next.boostDb, FILTER_LIMITS.boostDb.min, FILTER_LIMITS.boostDb.max));
  return next;
}

/** Off is a true bypass: the player's own path to the speaker, the filter left out. */
export function filterBypassed(settings: FilterSettings): boolean {
  return settings.preset === 'off';
}

function inRange(value: unknown, limits: { min: number; max: number }): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= limits.min && value <= limits.max;
}

/** Strict: every field present and valid, else null. */
export function validFilterSettings(raw: unknown): FilterSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const preset = value.preset;
  if (preset !== 'custom' && !(FILTER_PRESET_NAMES as readonly unknown[]).includes(preset)) return null;
  for (const key of ['bandpass', 'clarity', 'agc', 'gate'] as const) {
    if (typeof value[key] !== 'boolean') return null;
  }
  if (!(DENOISE_KINDS as readonly unknown[]).includes(value.denoise)) return null;
  if (!inRange(value.lowHz, FILTER_LIMITS.lowHz) || !inRange(value.highHz, FILTER_LIMITS.highHz) || !inRange(value.boostDb, FILTER_LIMITS.boostDb)) return null;
  if ((value.lowHz as number) >= (value.highHz as number)) return null;
  const settings: FilterSettings = {
    preset: preset as FilterPreset,
    bandpass: value.bandpass as boolean,
    lowHz: value.lowHz as number,
    highHz: value.highHz as number,
    denoise: value.denoise as DenoiseKind,
    clarity: value.clarity as boolean,
    agc: value.agc as boolean,
    gate: value.gate as boolean,
    boostDb: value.boostDb as number,
  };
  // A named preset is exactly its values; anything else is custom.
  if (settings.preset !== 'custom') return presetSettings(settings.preset);
  return settings;
}

/** A stored value (localStorage): anything unreadable or invalid is the default. */
export function readFilterSettings(raw: string | null | undefined): FilterSettings {
  if (!raw) return { ...DEFAULT_FILTER_SETTINGS };
  try {
    return validFilterSettings(JSON.parse(raw)) ?? { ...DEFAULT_FILTER_SETTINGS };
  } catch {
    return { ...DEFAULT_FILTER_SETTINGS };
  }
}

export function serializeFilterSettings(settings: FilterSettings): string {
  return JSON.stringify({
    preset: settings.preset,
    bandpass: settings.bandpass,
    lowHz: settings.lowHz,
    highHz: settings.highHz,
    denoise: settings.denoise,
    clarity: settings.clarity,
    agc: settings.agc,
    gate: settings.gate,
    boostDb: settings.boostDb,
  });
}

export function sameFilterSettings(a: FilterSettings, b: FilterSettings): boolean {
  return serializeFilterSettings(a) === serializeFilterSettings(b);
}

export type FilterErrorCode = 'SAMPLE_RATE' | 'DENOISE_LOAD' | 'GATE_LOAD' | 'WORKLET_UNSUPPORTED';
export const FILTER_ERROR_CODES: readonly FilterErrorCode[] = ['SAMPLE_RATE', 'DENOISE_LOAD', 'GATE_LOAD', 'WORKLET_UNSUPPORTED'];

export interface FilterError {
  code: FilterErrorCode;
  /** The context's sample rate (SAMPLE_RATE) or the browser's message. */
  detail: string;
}

export interface FilterStatus {
  denoise: 'off' | 'loading' | 'on' | 'error';
  gate: 'off' | 'loading' | 'on' | 'error';
  error: FilterError | null;
}

/** What the panel title shows: off, loading AI, AI active, AI failed (or another load failure), active. */
export type FilterState = 'off' | 'loading' | 'ai' | 'error' | 'on';
export const FILTER_STATES: readonly FilterState[] = ['off', 'loading', 'ai', 'error', 'on'];

export function filterState(settings: FilterSettings, status: FilterStatus | null): FilterState {
  if (filterBypassed(settings)) return 'off';
  if (status?.error || status?.denoise === 'error' || status?.gate === 'error') return 'error';
  if (settings.denoise !== 'off') {
    if (status?.denoise === 'on') return 'ai';
    return 'loading';
  }
  if (settings.gate && status?.gate !== 'on') return 'loading';
  return 'on';
}

// ---------------------------------------------------------------------------------------------
// The Web Audio chain.

/** The vendor library and the URLs of its WASM and worklet files (radioAudioFilterAssets.ts). */
export interface FilterAssets {
  lib: typeof import('../vendor/web-noise-suppressor/index.js');
  urls: {
    gtcrnWasm: string;
    speexWasm: string;
    gtcrnWorklet: string;
    speexWorklet: string;
    gateWorklet: string;
  };
}

export type FilterAssetLoader = () => Promise<FilterAssets>;

let defaultAssets: Promise<FilterAssets> | null = null;
const defaultAssetLoader: FilterAssetLoader = () => {
  if (!defaultAssets) {
    defaultAssets = import('./radioAudioFilterAssets').then((module) => module.filterAssets());
    defaultAssets.catch(() => { defaultAssets = null; });
  }
  return defaultAssets;
};

/** Each worklet module is added once per AudioContext (a second addModule would register its processor again). */
const addedModules = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();
function addWorkletModule(context: BaseAudioContext, url: string): Promise<void> {
  let modules = addedModules.get(context);
  if (!modules) {
    modules = new Map();
    addedModules.set(context, modules);
  }
  let added = modules.get(url);
  if (!added) {
    added = context.audioWorklet.addModule(url);
    added.catch(() => modules?.delete(url));
    modules.set(url, added);
  }
  return added;
}

/** The WASM binaries are fetched once per page; each worklet node gets a copy. */
const wasmBinaries = new Map<string, Promise<ArrayBuffer>>();
function wasmBinary(url: string, load: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
  let binary = wasmBinaries.get(url);
  if (!binary) {
    binary = load();
    binary.catch(() => wasmBinaries.delete(url));
    wasmBinaries.set(url, binary);
  }
  return binary;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

const dbToGain = (db: number): number => 10 ** (db / 20);

type Destroyable = AudioNode & { destroy?: () => void };
type Slot = Destroyable | 'loading';

/** The labels of the chain's stages in order, for tests and diagnostics. */
export type ChainLabel = 'input' | 'highpass' | 'lowpass' | 'gtcrn' | 'speex' | 'clarity' | 'gate' | 'agc' | 'boost' | 'limiter' | 'output';

export class RadioAudioFilter {
  readonly context: BaseAudioContext;
  readonly input: GainNode;
  readonly output: GainNode;
  settings: FilterSettings;
  status: FilterStatus = { denoise: 'off', gate: 'off', error: null };
  chainLabels: ChainLabel[] = [];
  onStatus: ((status: FilterStatus) => void) | null = null;

  private readonly highpass: BiquadFilterNode[];
  private readonly lowpass: BiquadFilterNode[];
  private readonly presence: BiquadFilterNode;
  private readonly compressor: DynamicsCompressorNode;
  private readonly boost: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly denoisers: Partial<Record<Exclude<DenoiseKind, 'off'>, Slot>> = {};
  private gateNode: Slot | null = null;
  private destroyed = false;
  private readonly loadAssets: FilterAssetLoader;

  constructor(context: BaseAudioContext, settings: Partial<FilterSettings> = {}, loadAssets: FilterAssetLoader = defaultAssetLoader) {
    this.context = context;
    this.loadAssets = loadAssets;
    this.input = context.createGain();
    this.output = context.createGain();
    const biquad = (type: BiquadFilterType): BiquadFilterNode => {
      const node = context.createBiquadFilter();
      node.type = type;
      node.Q.value = 0.707;
      return node;
    };
    this.highpass = [biquad('highpass'), biquad('highpass')];
    this.lowpass = [biquad('lowpass'), biquad('lowpass')];
    this.presence = context.createBiquadFilter();
    this.presence.type = 'peaking';
    this.presence.frequency.value = 2000;
    this.presence.Q.value = 0.9;
    this.presence.gain.value = 5;
    this.compressor = context.createDynamicsCompressor();
    this.compressor.threshold.value = -40;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 6;
    this.compressor.attack.value = 0.005;
    this.compressor.release.value = 0.3;
    this.boost = context.createGain();
    this.limiter = context.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.1;
    this.settings = { ...DEFAULT_FILTER_SETTINGS, ...settings };
    this.apply({});
  }

  setVolume(volume: number): void {
    this.output.gain.setTargetAtTime(Math.max(0, volume), this.context.currentTime, 0.02);
  }

  /** Apply settings (some or all); the noise suppressor and the gate load in the background when needed. */
  apply(settings: Partial<FilterSettings>): void {
    if (this.destroyed) return;
    this.settings = { ...this.settings, ...settings };
    const s = this.settings;
    const now = this.context.currentTime;
    this.highpass.forEach((node) => node.frequency.setValueAtTime(s.lowHz, now));
    this.lowpass.forEach((node) => node.frequency.setValueAtTime(Math.min(s.highHz, this.context.sampleRate / 2 - 100), now));
    this.boost.gain.setTargetAtTime(dbToGain(s.agc ? s.boostDb : 0), now, 0.05);
    this.rebuild();
    if (s.denoise !== 'off' && !this.denoisers[s.denoise]) void this.loadDenoiser(s.denoise);
    if (s.gate && !this.gateNode) void this.loadGate();
  }

  /** Disconnect every node and free the worklets; the filter cannot be used again. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const node of this.allNodes()) {
      try { node.disconnect(); } catch { /* not connected */ }
    }
    try { this.output.disconnect(); } catch { /* not connected */ }
    for (const slot of [...Object.values(this.denoisers), this.gateNode]) {
      if (slot && slot !== 'loading') slot.destroy?.();
    }
    this.onStatus = null;
  }

  private setStatus(patch: Partial<FilterStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.status);
  }

  private async loadDenoiser(kind: Exclude<DenoiseKind, 'off'>): Promise<void> {
    if (this.denoisers[kind]) return;
    if (this.context.sampleRate !== 48000) {
      this.setStatus({ denoise: 'error', error: { code: 'SAMPLE_RATE', detail: String(this.context.sampleRate) } });
      return;
    }
    if (!this.context.audioWorklet) {
      this.setStatus({ denoise: 'error', error: { code: 'WORKLET_UNSUPPORTED', detail: '' } });
      return;
    }
    this.denoisers[kind] = 'loading';
    this.setStatus({ denoise: 'loading', error: null });
    try {
      const assets = await this.loadAssets();
      const wasmUrl = kind === 'gtcrn' ? assets.urls.gtcrnWasm : assets.urls.speexWasm;
      const workletUrl = kind === 'gtcrn' ? assets.urls.gtcrnWorklet : assets.urls.speexWorklet;
      const load = kind === 'gtcrn' ? assets.lib.loadGtcrn : assets.lib.loadSpeex;
      const [binary] = await Promise.all([
        wasmBinary(wasmUrl, () => load({ url: wasmUrl })),
        addWorkletModule(this.context, workletUrl),
      ]);
      const NodeClass = kind === 'gtcrn' ? assets.lib.GtcrnWorkletNode : assets.lib.SpeexWorkletNode;
      const node = new NodeClass(this.context, { maxChannels: 1, wasmBinary: binary.slice(0) });
      if (this.destroyed) {
        node.destroy();
        return;
      }
      this.denoisers[kind] = node;
      this.rebuild();
    } catch (err) {
      delete this.denoisers[kind];
      if (this.destroyed) return;
      this.setStatus({ denoise: 'error', error: { code: 'DENOISE_LOAD', detail: errorText(err) } });
    }
  }

  private async loadGate(): Promise<void> {
    if (this.gateNode) return;
    if (!this.context.audioWorklet) {
      this.setStatus({ gate: 'error', error: { code: 'WORKLET_UNSUPPORTED', detail: '' } });
      return;
    }
    this.gateNode = 'loading';
    this.setStatus({ gate: 'loading' });
    try {
      const assets = await this.loadAssets();
      await addWorkletModule(this.context, assets.urls.gateWorklet);
      const node = new assets.lib.NoiseGateWorkletNode(this.context, { openThreshold: -50, closeThreshold: -58, holdMs: 300, maxChannels: 1 });
      if (this.destroyed) return;
      this.gateNode = node;
      this.rebuild();
    } catch (err) {
      this.gateNode = null;
      if (this.destroyed) return;
      this.setStatus({ gate: 'error', error: { code: 'GATE_LOAD', detail: errorText(err) } });
    }
  }

  private allNodes(): AudioNode[] {
    const ready = (slot: Slot | null | undefined): slot is Destroyable => Boolean(slot) && slot !== 'loading';
    return [
      this.input, ...this.highpass, ...this.lowpass, this.presence, this.compressor, this.boost, this.limiter,
      ...Object.values(this.denoisers).filter(ready),
      ...(ready(this.gateNode) ? [this.gateNode] : []),
    ];
  }

  /** Join the chain for the settings again; nodes not ready yet are left out. */
  private rebuild(): void {
    if (this.destroyed) return;
    const s = this.settings;
    const ready = (slot: Slot | null | undefined): slot is Destroyable => Boolean(slot) && slot !== 'loading';
    const denoiser = s.denoise !== 'off' ? this.denoisers[s.denoise] : undefined;
    const chain: Array<[AudioNode, ChainLabel]> = [[this.input, 'input']];
    if (s.bandpass) {
      chain.push([this.highpass[0], 'highpass'], [this.highpass[1], 'highpass'], [this.lowpass[0], 'lowpass'], [this.lowpass[1], 'lowpass']);
    }
    if (ready(denoiser)) chain.push([denoiser, s.denoise as 'gtcrn' | 'speex']);
    if (s.clarity) chain.push([this.presence, 'clarity']);
    if (s.gate && ready(this.gateNode)) chain.push([this.gateNode, 'gate']);
    if (s.agc) chain.push([this.compressor, 'agc'], [this.boost, 'boost']);
    chain.push([this.limiter, 'limiter'], [this.output, 'output']);

    for (const node of this.allNodes()) {
      try { node.disconnect(); } catch { /* not connected yet */ }
    }
    for (let i = 0; i < chain.length - 1; i++) chain[i][0].connect(chain[i + 1][0]);
    this.chainLabels = chain.map(([, label]) => label);

    const denoise: FilterStatus['denoise'] = s.denoise === 'off'
      ? 'off'
      : ready(denoiser) ? 'on' : this.status.denoise === 'error' ? 'error' : 'loading';
    const gate: FilterStatus['gate'] = !s.gate
      ? 'off'
      : ready(this.gateNode) ? 'on' : this.status.gate === 'error' ? 'error' : 'loading';
    const error = (denoise === 'error' || gate === 'error') ? this.status.error : null;
    this.setStatus({ denoise, gate, error });
  }
}

/**
 * One switchable filter between a player's last node and the speaker: Off joins `source` to
 * `destination` directly (the path as it was), any other preset puts a RadioAudioFilter between
 * them. Changing the preset rejoins the path, so there is only ever one path to the speaker.
 */
export class FilterInsert {
  private filter: RadioAudioFilter | null = null;
  private settings: FilterSettings;
  private status: FilterStatus = { denoise: 'off', gate: 'off', error: null };
  onStatus: ((state: FilterState, status: FilterStatus) => void) | null = null;

  constructor(
    private readonly source: AudioNode,
    private readonly destination: AudioNode,
    settings: FilterSettings,
    private readonly loadAssets?: FilterAssetLoader,
  ) {
    this.settings = settings;
    this.join();
  }

  get current(): RadioAudioFilter | null {
    return this.filter;
  }

  state(): FilterState {
    return filterState(this.settings, this.filter ? this.status : null);
  }

  apply(settings: FilterSettings): void {
    const wasBypassed = filterBypassed(this.settings);
    this.settings = settings;
    if (wasBypassed !== filterBypassed(settings)) {
      this.join();
    } else if (this.filter) {
      this.filter.apply(settings);
    }
    this.emit();
  }

  destroy(): void {
    try { this.source.disconnect(); } catch { /* not connected */ }
    this.filter?.destroy();
    this.filter = null;
    this.onStatus = null;
  }

  private emit(): void {
    this.onStatus?.(this.state(), this.status);
  }

  private join(): void {
    try { this.source.disconnect(); } catch { /* not connected */ }
    if (filterBypassed(this.settings)) {
      this.filter?.destroy();
      this.filter = null;
      this.status = { denoise: 'off', gate: 'off', error: null };
      this.source.connect(this.destination);
      return;
    }
    const filter = new RadioAudioFilter(this.source.context, this.settings, this.loadAssets);
    this.filter = filter;
    this.status = filter.status;
    filter.onStatus = (status) => {
      if (this.filter !== filter) return;
      this.status = status;
      this.emit();
    };
    filter.output.connect(this.destination);
    this.source.connect(filter.input);
  }
}
