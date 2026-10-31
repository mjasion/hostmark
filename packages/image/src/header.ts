import { InvalidImageError } from '@hostmark/core/ports';

export type ImageFormat = 'jpeg' | 'png' | 'webp';

export interface Header {
  format: ImageFormat;
  width: number;
  height: number;
}

const ascii = (b: Uint8Array, at: number, text: string): boolean => {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

const u16be = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u32be = (b: Uint8Array, at: number): number =>
  (b[at] ?? 0) * 0x1000000 + (((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0));
const u24le = (b: Uint8Array, at: number): number =>
  (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
const u32le = (b: Uint8Array, at: number): number => u24le(b, at) + (b[at + 3] ?? 0) * 0x1000000;

/** Format from magic bytes only; the declared content type is never trusted. */
export function detectFormat(b: Uint8Array): ImageFormat | undefined {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 'PNG\r\n') && b[6] === 0x1a && b[7] === 0x0a)
    return 'png';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'webp';
  return undefined;
}

// Markers that carry a frame header (SOF0..SOF15 except DHT, JPG and DAC).
const isSof = (m: number): boolean => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

// Walks the segments the way libjpeg does, so the frame header read here is the one the decoder will use.
function jpegSize(b: Uint8Array): { width: number; height: number; components: number } | undefined {
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = b[p + 1] ?? 0;
    if (marker === 0xff) {
      p++; // fill byte
      continue;
    }
    // libjpeg skips FF 00 outside entropy data as stuffing. Reading a length after it instead would let a
    // crafted file hide the real frame header behind a decoy one (D31).
    if (marker === 0x00) {
      p += 2;
      continue;
    }
    if (marker === 0xd9) return undefined; // end of image before any frame header
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2; // markers without a payload
      continue;
    }
    if (isSof(marker)) {
      if (p + 9 > b.length) return undefined;
      return { height: u16be(b, p + 5), width: u16be(b, p + 7), components: b[p + 9] ?? 0 };
    }
    if (marker === 0xda) return undefined; // start of scan before any frame header
    p += 2 + u16be(b, p + 2);
  }
  return undefined;
}

function pngSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 24 || !ascii(b, 12, 'IHDR')) return undefined;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function webpSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 30) return undefined;
  const d = 20; // first chunk payload
  if (ascii(b, 12, 'VP8X')) return { width: u24le(b, d + 4) + 1, height: u24le(b, d + 7) + 1 };
  if (ascii(b, 12, 'VP8L')) {
    if (b[d] !== 0x2f) return undefined;
    const bits = u32le(b, d + 1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, 'VP8 ')) {
    if (b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) return undefined;
    return {
      width: ((b[d + 6] ?? 0) | ((b[d + 7] ?? 0) << 8)) & 0x3fff,
      height: ((b[d + 8] ?? 0) | ((b[d + 9] ?? 0) << 8)) & 0x3fff,
    };
  }
  return undefined;
}

/** Reads format and dimensions from the header without decoding anything. */
export function readHeader(b: Uint8Array): Header {
  const format = detectFormat(b);
  if (!format) throw new InvalidImageError('Not a JPEG, PNG or WebP image');
  const size = format === 'jpeg' ? jpegSize(b) : format === 'png' ? pngSize(b) : webpSize(b);
  // CMYK and YCCK are not converted, and trying leaves the decoder in a bad state (D78).
  if (size && 'components' in size && size.components !== 1 && size.components !== 3)
    throw new InvalidImageError(`Unsupported JPEG with ${size.components} color components`);
  if (!size || size.width < 1 || size.height < 1) throw new InvalidImageError(`Unreadable ${format} header`);
  return { format, width: size.width, height: size.height };
}
