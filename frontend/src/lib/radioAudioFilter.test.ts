import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTER_SETTINGS,
  FILTER_PRESETS,
  FilterInsert,
  RadioAudioFilter,
  filterBypassed,
  filterState,
  presetSettings,
  readFilterSettings,
  serializeFilterSettings,
  validFilterSettings,
  withControls,
} from './radioAudioFilter';
import type { FilterAssets, FilterSettings } from './radioAudioFilter';

// --- A Web Audio stand-in that records the graph ------------------------------------------------

class FakeParam {
  value = 0;
  setValueAtTime(value: number) { this.value = value; }
  setTargetAtTime(value: number) { this.value = value; }
}

class FakeNode {
  outputs: FakeNode[] = [];
  constructor(readonly context: FakeContext, readonly kind: string) { context.nodes.push(this); }
  connect(node: FakeNode) { this.outputs.push(node); return node; }
  disconnect() { this.outputs = []; }
}

class FakeBiquad extends FakeNode {
  type = '';
  frequency = new FakeParam();
  Q = new FakeParam();
  gain = new FakeParam();
}

class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeContext {
  nodes: FakeNode[] = [];
  currentTime = 0;
  added: string[] = [];
  destination: FakeNode;
  audioWorklet: { addModule(url: string): Promise<void> } | undefined;
  constructor(readonly sampleRate = 48000, worklets = true) {
    this.destination = new FakeNode(this, 'destination');
    this.audioWorklet = worklets ? { addModule: async (url: string) => { this.added.push(url); } } : undefined;
  }
  createGain() { return new FakeGain(this, 'gain'); }
  createBiquadFilter() { return new FakeBiquad(this, 'biquad'); }
  createDynamicsCompressor() { return new FakeCompressor(this, 'compressor'); }
}

class FakeWorklet extends FakeNode {
  destroyed = false;
  destroy() { this.destroyed = true; }
}

// WASM binaries are cached per page by URL, so a failing load gets a URL of its own.
function fakeAssets(options: { fail?: boolean } = {}) {
  const loads: string[] = [];
  const pending: Array<() => void> = [];
  let open = false;
  // Loads wait until release(); after it they finish at once.
  const gate = () => (open ? Promise.resolve() : new Promise<void>((resolve) => { pending.push(resolve); }));
  const lib = {
    loadGtcrn: async ({ url }: { url: string }) => { loads.push(url); await gate(); if (options.fail) throw new Error('fetch failed'); return new ArrayBuffer(8); },
    loadSpeex: async ({ url }: { url: string }) => { loads.push(url); await gate(); return new ArrayBuffer(8); },
    GtcrnWorkletNode: class extends FakeWorklet { constructor(context: FakeContext) { super(context, 'gtcrn'); } },
    SpeexWorkletNode: class extends FakeWorklet { constructor(context: FakeContext) { super(context, 'speex'); } },
    NoiseGateWorkletNode: class extends FakeWorklet { constructor(context: FakeContext) { super(context, 'gate'); } },
  };
  const assets = { lib, urls: { gtcrnWasm: options.fail ? '/failing-g.wasm' : '/g.wasm', speexWasm: '/s.wasm', gtcrnWorklet: '/g.js', speexWorklet: '/s.js', gateWorklet: '/n.js' } } as unknown as FilterAssets;
  return { loader: async () => assets, loads, release: () => { open = true; while (pending.length) pending.shift()?.(); } };
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

/** The node kinds from `from` to the destination along the first output of each node. */
function path(from: FakeNode): string[] {
  const kinds: string[] = [];
  let node: FakeNode | undefined = from;
  const seen = new Set<FakeNode>();
  while (node && !seen.has(node)) {
    seen.add(node);
    kinds.push(node.kind);
    node = node.outputs[0];
  }
  return kinds;
}

// --- Settings -----------------------------------------------------------------------------------

describe('voice filter settings', () => {
  it('has the reference presets with Standard as the default', () => {
    expect(FILTER_PRESETS).toEqual({
      off: { bandpass: false, lowHz: 300, highHz: 3000, denoise: 'off', clarity: false, agc: false, gate: false, boostDb: 0 },
      light: { bandpass: true, lowHz: 300, highHz: 3400, denoise: 'off', clarity: true, agc: true, gate: false, boostDb: 6 },
      standard: { bandpass: true, lowHz: 300, highHz: 3000, denoise: 'gtcrn', clarity: true, agc: true, gate: false, boostDb: 6 },
      strong: { bandpass: true, lowHz: 350, highHz: 2800, denoise: 'gtcrn', clarity: true, agc: true, gate: true, boostDb: 9 },
    });
    expect(DEFAULT_FILTER_SETTINGS).toEqual({ preset: 'standard', ...FILTER_PRESETS.standard });
    expect(filterBypassed(presetSettings('off'))).toBe(true);
    expect(filterBypassed(presetSettings('light'))).toBe(false);
  });

  it('makes any changed control custom, kept inside the limits', () => {
    const next = withControls(presetSettings('standard'), { gate: true, boostDb: 40 });
    expect(next).toEqual({ ...presetSettings('standard'), preset: 'custom', gate: true, boostDb: 18 });
    expect(withControls(presetSettings('off'), { boostDb: 3.6 }).boostDb).toBe(4);
    // A custom setting with every part off still runs through the limiter: only Off is a bypass.
    expect(filterBypassed(withControls(presetSettings('off'), {}))).toBe(false);
  });

  it('reads stored settings strictly and falls back to Standard', () => {
    const custom: FilterSettings = { ...presetSettings('strong'), preset: 'custom', lowHz: 250 };
    expect(readFilterSettings(serializeFilterSettings(custom))).toEqual(custom);
    // A named preset is exactly its values.
    expect(validFilterSettings({ ...presetSettings('light'), boostDb: 12 })).toEqual(presetSettings('light'));
    for (const bad of [null, '', 'not json', '[]', '{}', JSON.stringify({ ...custom, preset: 'loud' }), JSON.stringify({ ...custom, denoise: 'rnnoise' }),
      JSON.stringify({ ...custom, lowHz: 3000, highHz: 2000 }), JSON.stringify({ ...custom, boostDb: Number.MAX_VALUE }), JSON.stringify({ ...custom, agc: 1 })]) {
      expect(readFilterSettings(bad), String(bad)).toEqual(DEFAULT_FILTER_SETTINGS);
    }
  });

  it('names the state the panel shows', () => {
    expect(filterState(presetSettings('off'), null)).toBe('off');
    expect(filterState(presetSettings('standard'), { denoise: 'loading', gate: 'off', error: null })).toBe('loading');
    expect(filterState(presetSettings('standard'), { denoise: 'on', gate: 'off', error: null })).toBe('ai');
    expect(filterState(presetSettings('standard'), { denoise: 'error', gate: 'off', error: { code: 'SAMPLE_RATE', detail: '44100' } })).toBe('error');
    expect(filterState(presetSettings('light'), { denoise: 'off', gate: 'off', error: null })).toBe('on');
    expect(filterState(presetSettings('strong'), { denoise: 'on', gate: 'loading', error: null })).toBe('ai');
  });
});

// --- The chain ----------------------------------------------------------------------------------

describe('RadioAudioFilter chain', () => {
  it('joins the reference order, leaving the noise suppressor out until it has loaded', async () => {
    const context = new FakeContext();
    const assets = fakeAssets();
    const filter = new RadioAudioFilter(context as unknown as BaseAudioContext, presetSettings('standard'), assets.loader);
    expect(filter.chainLabels).toEqual(['input', 'highpass', 'highpass', 'lowpass', 'lowpass', 'clarity', 'agc', 'boost', 'limiter', 'output']);
    expect(filter.status.denoise).toBe('loading');
    assets.release();
    await flush();
    expect(filter.chainLabels).toEqual(['input', 'highpass', 'highpass', 'lowpass', 'lowpass', 'gtcrn', 'clarity', 'agc', 'boost', 'limiter', 'output']);
    expect(filter.status).toEqual({ denoise: 'on', gate: 'off', error: null });
    expect(context.added).toEqual(['/g.js']);
    expect(path(filter.input as unknown as FakeNode)).toEqual(['gain', 'biquad', 'biquad', 'biquad', 'biquad', 'gtcrn', 'biquad', 'compressor', 'gain', 'compressor', 'gain']);
  });

  it('sets the reference values', () => {
    const context = new FakeContext();
    const filter = new RadioAudioFilter(context as unknown as BaseAudioContext, presetSettings('strong'), fakeAssets().loader);
    const biquads = context.nodes.filter((node): node is FakeBiquad => node instanceof FakeBiquad);
    expect(biquads.map((node) => [node.type, node.frequency.value, node.Q.value])).toEqual([
      ['highpass', 350, 0.707], ['highpass', 350, 0.707], ['lowpass', 2800, 0.707], ['lowpass', 2800, 0.707], ['peaking', 2000, 0.9],
    ]);
    expect(biquads[4].gain.value).toBe(5);
    const [agc, limiter] = context.nodes.filter((node): node is FakeCompressor => node instanceof FakeCompressor);
    expect([agc.threshold.value, agc.knee.value, agc.ratio.value, agc.attack.value, agc.release.value]).toEqual([-40, 12, 6, 0.005, 0.3]);
    expect([limiter.threshold.value, limiter.knee.value, limiter.ratio.value, limiter.attack.value, limiter.release.value]).toEqual([-2, 0, 20, 0.001, 0.1]);
    filter.apply({ highHz: 8000 });
    expect(biquads[2].frequency.value).toBe(8000);
    filter.setVolume(0.5);
    expect((filter.output as unknown as FakeGain).gain.value).toBe(0.5);
  });

  it('caps the low-pass below the context\'s Nyquist frequency', () => {
    const context = new FakeContext(16000);
    new RadioAudioFilter(context as unknown as BaseAudioContext, { ...presetSettings('light'), highHz: 8000 }, fakeAssets().loader);
    const lowpass = context.nodes.filter((node): node is FakeBiquad => node instanceof FakeBiquad && node.type === 'lowpass');
    expect(lowpass.map((node) => node.frequency.value)).toEqual([7900, 7900]);
  });

  it('says the AI needs 48 kHz instead of skipping it, and names a failed load', async () => {
    const at44 = new RadioAudioFilter(new FakeContext(44100) as unknown as BaseAudioContext, presetSettings('standard'), fakeAssets().loader);
    expect(at44.status).toEqual({ denoise: 'error', gate: 'off', error: { code: 'SAMPLE_RATE', detail: '44100' } });
    expect(filterState(at44.settings, at44.status)).toBe('error');

    const failing = fakeAssets({ fail: true });
    const filter = new RadioAudioFilter(new FakeContext() as unknown as BaseAudioContext, presetSettings('standard'), failing.loader);
    failing.release();
    await flush();
    expect(filter.status.denoise).toBe('error');
    expect(filter.status.error).toEqual({ code: 'DENOISE_LOAD', detail: 'fetch failed' });
    expect(filter.chainLabels).not.toContain('gtcrn');

    const noWorklet = new RadioAudioFilter(new FakeContext(48000, false) as unknown as BaseAudioContext, presetSettings('strong'), fakeAssets().loader);
    expect(noWorklet.status.error?.code).toBe('WORKLET_UNSUPPORTED');
  });

  it('adds the gate when it has loaded, and adds each worklet module once per context', async () => {
    const context = new FakeContext();
    const assets = fakeAssets();
    const first = new RadioAudioFilter(context as unknown as BaseAudioContext, presetSettings('strong'), assets.loader);
    assets.release();
    await flush();
    assets.release();
    await flush();
    expect(first.chainLabels).toEqual(['input', 'highpass', 'highpass', 'lowpass', 'lowpass', 'gtcrn', 'clarity', 'gate', 'agc', 'boost', 'limiter', 'output']);
    first.destroy();
    const second = new RadioAudioFilter(context as unknown as BaseAudioContext, presetSettings('strong'), assets.loader);
    assets.release();
    await flush();
    expect(second.chainLabels).toContain('gtcrn');
    expect(context.added.sort()).toEqual(['/g.js', '/n.js']);
  });
});

describe('FilterInsert', () => {
  it('Off joins the source to the speaker directly; a preset puts one filter between; back and forth leaves one path', async () => {
    const context = new FakeContext();
    const source = context.createGain();
    const assets = fakeAssets();
    const insert = new FilterInsert(source as unknown as AudioNode, context.destination as unknown as AudioNode, presetSettings('off'), assets.loader);
    expect(source.outputs).toEqual([context.destination]);
    expect(insert.current).toBeNull();
    expect(insert.state()).toBe('off');

    insert.apply(presetSettings('standard'));
    const filter = insert.current as RadioAudioFilter;
    expect(source.outputs).toEqual([filter.input]);
    expect((filter.output as unknown as FakeNode).outputs).toEqual([context.destination]);
    expect(insert.state()).toBe('loading');
    assets.release();
    await flush();
    expect(insert.state()).toBe('ai');

    insert.apply(presetSettings('light'));
    expect(insert.current).toBe(filter);
    insert.apply(presetSettings('off'));
    expect(source.outputs).toEqual([context.destination]);
    expect((filter.output as unknown as FakeNode).outputs).toEqual([]);
    insert.apply(presetSettings('strong'));
    expect(source.outputs).toHaveLength(1);
    expect(source.outputs[0]).toBe((insert.current as RadioAudioFilter).input);

    insert.destroy();
    expect(source.outputs).toEqual([]);
  });

  it('frees a noise suppressor that loads after its filter was destroyed', async () => {
    const context = new FakeContext();
    const assets = fakeAssets();
    const filter = new RadioAudioFilter(context as unknown as BaseAudioContext, presetSettings('standard'), assets.loader);
    filter.destroy();
    assets.release();
    await flush();
    const worklets = context.nodes.filter((node): node is FakeWorklet => node instanceof FakeWorklet);
    expect(worklets).toHaveLength(1);
    expect(worklets[0].destroyed).toBe(true);
  });
});
