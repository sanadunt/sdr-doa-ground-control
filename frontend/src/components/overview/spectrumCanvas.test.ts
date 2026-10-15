import { describe, expect, it } from 'vitest';
import { WATERFALL_ROWS } from '../../lib/spectrumView';
import { paintWaterfall } from './SpectrumCanvas';
import type { Waterfall } from './SpectrumCanvas';

/** A two-bin history with a fake backing canvas that records each paint. */
function history(rows: number[][]): { state: Waterfall; painted: number[] } {
  const bins = 2;
  const data = new Float32Array(bins * WATERFALL_ROWS);
  rows.forEach((row, index) => data.set(row, index * bins));
  const painted: number[] = [];
  const image = { data: new Uint8ClampedArray(bins * WATERFALL_ROWS * 4), width: bins, height: WATERFALL_ROWS } as unknown as ImageData;
  const buffer = { getContext: () => ({ putImageData: () => { painted.push(1); } }) } as unknown as HTMLCanvasElement;
  return { state: { bins, head: rows.length % WATERFALL_ROWS, filled: rows.length, rows: data, image, buffer }, painted };
}

const pixel = (state: Waterfall, row: number, bin: number) => Array.from(state.image?.data.slice((row * state.bins + bin) * 4, (row * state.bins + bin) * 4 + 4) ?? []);

describe('waterfall history', () => {
  it('keeps powers in dB, so a new range recolours every row at once, newest on top', () => {
    const { state, painted } = history([[-80, -55], [-65, -20]]);
    paintWaterfall(state, { min: -100, max: -20 });
    const newest = pixel(state, 0, 1);
    const older = pixel(state, 1, 0);
    expect(newest[3]).toBe(255);
    expect(older[3]).toBe(255);
    // Row 2 and below are empty.
    expect(pixel(state, 2, 0)[3]).toBe(0);
    const before = [pixel(state, 0, 0), pixel(state, 1, 1)];
    // A narrower range moves the colour of the old row too.
    paintWaterfall(state, { min: -70, max: -50 });
    expect(pixel(state, 1, 1)).not.toEqual(before[1]);
    expect(pixel(state, 0, 0)).not.toEqual(before[0]);
    expect(painted).toHaveLength(2);
  });

  it('paints nothing without a backing canvas', () => {
    const { state, painted } = history([[-50, -50]]);
    paintWaterfall({ ...state, buffer: null }, { min: -100, max: 0 });
    expect(painted).toHaveLength(0);
  });
});
