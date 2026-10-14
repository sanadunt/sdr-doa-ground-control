import { describe, expect, it } from 'vitest';
import { crc32, MAX_LOGO_BYTES, pngDataUrl, validatePngLogo } from './pngLogo';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function chunk(type: string, data: number[] = []): number[] {
  const body = new Uint8Array([...ascii(type), ...data]);
  return [...u32(data.length), ...body, ...u32(crc32(body))];
}

function ihdr(width: number, height: number, bitDepth: number, colorType: number, interlace = 0): number[] {
  return chunk('IHDR', [...u32(width), ...u32(height), bitDepth, colorType, 0, 0, interlace]);
}

// The client does not inflate IDAT (the server does), so any bytes stand in for image data.
const IDAT = chunk('IDAT', [0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]);
const IEND = chunk('IEND');

function png(...chunks: number[][]): Uint8Array {
  return new Uint8Array([...SIGNATURE, ...chunks.flat()]);
}

describe('PNG logo validation matches the server rules (AUD-80)', () => {
  it('uses the standard CRC-32', () => {
    expect(crc32(new Uint8Array(ascii('IEND')))).toBe(0xae426082);
  });

  it('accepts RGB/RGBA, 16-bit, interlaced, grayscale and palette PNGs', () => {
    expect(validatePngLogo(png(ihdr(2, 2, 8, 6), IDAT, IEND))).toBeNull();
    expect(validatePngLogo(png(ihdr(2, 2, 16, 2), IDAT, IEND))).toBeNull();
    expect(validatePngLogo(png(ihdr(2, 2, 8, 6, 1), IDAT, IEND))).toBeNull();
    expect(validatePngLogo(png(ihdr(2, 2, 1, 0), IDAT, IEND))).toBeNull();
    expect(validatePngLogo(png(ihdr(2, 2, 4, 3), chunk('PLTE', [0, 0, 0, 255, 255, 255]), IDAT, IEND))).toBeNull();
    // RGB with a suggested palette and ancillary chunks.
    expect(validatePngLogo(png(ihdr(2, 2, 8, 2), chunk('PLTE', [1, 2, 3]), chunk('tEXt', ascii('a\u0000b')), IDAT, IEND))).toBeNull();
  });

  it('rejects palette problems the way the server does', () => {
    expect(validatePngLogo(png(ihdr(2, 2, 8, 3), IDAT, IEND))).toBe('palette');
    expect(validatePngLogo(png(ihdr(2, 2, 8, 0), chunk('PLTE', [1, 2, 3]), IDAT, IEND))).toBe('palette');
    expect(validatePngLogo(png(ihdr(2, 2, 1, 3), chunk('PLTE', [1, 2, 3, 4, 5, 6, 7, 8, 9]), IDAT, IEND))).toBe('palette');
    expect(validatePngLogo(png(ihdr(2, 2, 8, 2), IDAT, chunk('PLTE', [1, 2, 3]), IEND))).toBe('palette');
  });

  it('rejects invalid format fields, sizes and structure', () => {
    expect(validatePngLogo(png(ihdr(2, 2, 16, 3), chunk('PLTE', [1, 2, 3]), IDAT, IEND))).toBe('format');
    expect(validatePngLogo(png(ihdr(2, 2, 8, 6, 2), IDAT, IEND))).toBe('format');
    expect(validatePngLogo(png(ihdr(4097, 1, 8, 6), IDAT, IEND))).toBe('dimensions');
    expect(validatePngLogo(png(ihdr(2049, 2049, 8, 6), IDAT, IEND))).toBe('dimensions');
    expect(validatePngLogo(png(ihdr(2, 2, 8, 6), chunk('cHRM', [1]), chunk('ABCD', [1]), IDAT, IEND))).toBe('criticalChunk');
    expect(validatePngLogo(png(ihdr(2, 2, 8, 6), IDAT, chunk('tEXt', [1]), IDAT, IEND))).toBe('structure');
    expect(validatePngLogo(png(ihdr(2, 2, 8, 6), IDAT, IEND, [0]))).toBe('structure');
    expect(validatePngLogo(png(ihdr(2, 2, 8, 6), IDAT))).toBe('structure');
    expect(validatePngLogo(new Uint8Array([0xff, 0xd8, 0xff, ...new Array(40).fill(0)]))).toBe('signature');
    expect(validatePngLogo(new Uint8Array(MAX_LOGO_BYTES + 1))).toBe('size');
    const corrupted = png(ihdr(2, 2, 8, 6), IDAT, IEND);
    corrupted[20] ^= 0xff;
    expect(validatePngLogo(corrupted)).toBe('checksum');
  });

  it('builds a PNG data URL the API normalizer accepts', () => {
    const bytes = png(ihdr(1, 1, 8, 6), IDAT, IEND);
    const url = pngDataUrl(bytes);
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    expect(Uint8Array.from(atob(url.slice(22)), (char) => char.charCodeAt(0))).toEqual(bytes);
  });
});
