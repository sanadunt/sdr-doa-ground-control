import type { MessageKey } from './i18n';

// Same limits as tools/ground_console.py (MAX_LOGO_BYTES, MAX_LOGO_DIMENSION,
// MAX_LOGO_PIXELS, PNG_BIT_DEPTHS). The server decodes the image data; this
// check covers the container so a file the server would reject is never
// staged as if it were accepted.
export const MAX_LOGO_BYTES = 256 * 1024;
export const MAX_LOGO_DIMENSION = 4096;
export const MAX_LOGO_PIXELS = 4_194_304;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_BIT_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

export type PngLogoError = 'size' | 'signature' | 'structure' | 'checksum' | 'criticalChunk' | 'dimensions' | 'format' | 'palette';

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function isLetter(byte: number): boolean {
  return (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
}

/** Validate a PNG logo the way the console server does, short of inflating IDAT. */
export function validatePngLogo(bytes: Uint8Array): PngLogoError | null {
  if (!bytes.length || bytes.length > MAX_LOGO_BYTES) return 'size';
  if (bytes.length < 33 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) return 'signature';
  let index = 8;
  let header: Uint8Array | null = null;
  let sawIdat = false;
  let idatClosed = false;
  let sawIend = false;
  let paletteEntries = 0;
  while (index < bytes.length) {
    if (index + 12 > bytes.length) return 'structure';
    const length = uint32(bytes, index);
    const type = bytes.subarray(index + 4, index + 8);
    if (!type.every(isLetter)) return 'structure';
    const dataStart = index + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (length > MAX_LOGO_BYTES || crcEnd > bytes.length) return 'structure';
    if (crc32(bytes, index + 4, dataEnd) !== uint32(bytes, dataEnd)) return 'checksum';
    const name = String.fromCharCode(...type);
    if (name === 'IHDR') {
      if (header || index !== 8 || length !== 13) return 'structure';
      header = bytes.subarray(dataStart, dataEnd);
    } else if (!header) {
      return 'structure';
    } else if (name === 'IDAT') {
      if (idatClosed) return 'structure';
      sawIdat = true;
    } else if (name === 'IEND') {
      if (!sawIdat || length !== 0) return 'structure';
      sawIend = true;
      index = crcEnd;
      break;
    } else if (name === 'PLTE') {
      if (paletteEntries || sawIdat) return 'palette';
      if (length === 0 || length % 3 !== 0 || length > 768) return 'palette';
      paletteEntries = length / 3;
    } else {
      if (sawIdat) idatClosed = true;
      if (type[0] >= 65 && type[0] <= 90) return 'criticalChunk';
    }
    index = crcEnd;
  }
  if (!header || !sawIdat || !sawIend || index !== bytes.length) return 'structure';
  const width = uint32(header, 0);
  const height = uint32(header, 4);
  if (width <= 0 || height <= 0 || width > MAX_LOGO_DIMENSION || height > MAX_LOGO_DIMENSION || width * height > MAX_LOGO_PIXELS) return 'dimensions';
  const [bitDepth, colorType, compression, filter, interlace] = [header[8], header[9], header[10], header[11], header[12]];
  if (!PNG_BIT_DEPTHS[colorType]?.includes(bitDepth)) return 'format';
  if (compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) return 'format';
  if (colorType === 3 && (!paletteEntries || paletteEntries > 2 ** bitDepth)) return 'palette';
  if ((colorType === 0 || colorType === 4) && paletteEntries) return 'palette';
  return null;
}

const ERROR_KEYS: Record<PngLogoError, MessageKey> = {
  size: 'config.logoTooLarge',
  signature: 'config.logoNotPng',
  structure: 'config.logoDamaged',
  checksum: 'config.logoDamaged',
  criticalChunk: 'config.logoUnsupportedChunk',
  dimensions: 'config.logoDimensions',
  format: 'config.logoFormat',
  palette: 'config.logoPalette',
};

export function pngLogoErrorKey(error: PngLogoError): MessageKey {
  return ERROR_KEYS[error];
}

/** data: URL for bytes that already passed validatePngLogo. */
export function pngDataUrl(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}
