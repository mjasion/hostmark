// Dependency free EXIF orientation reader. Anything malformed yields 1 (no rotation) instead of an error.

import type { ImageFormat } from './header';

const u16 = (b: Uint8Array, at: number, le: boolean): number =>
  le ? (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) : ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u32 = (b: Uint8Array, at: number, le: boolean): number =>
  le
    ? u16(b, at, true) + u16(b, at + 2, true) * 0x10000
    : u16(b, at, false) * 0x10000 + u16(b, at + 2, false);
const tag = (b: Uint8Array, at: number, text: string): boolean =>
  at + text.length <= b.length && [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

/** Orientation from a TIFF block (starts at the byte order mark). */
function tiffOrientation(b: Uint8Array, start: number, end: number): number {
  const le = b[start] === 0x49 && b[start + 1] === 0x49;
  if (!le && !(b[start] === 0x4d && b[start + 1] === 0x4d)) return 1;
  if (u16(b, start + 2, le) !== 42) return 1;
  const ifd = start + u32(b, start + 4, le);
  if (ifd < start || ifd + 2 > end) return 1;
  const count = u16(b, ifd, le);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (u16(b, entry, le) !== 0x0112) continue;
    // SHORT, count 1: the value sits in the first two bytes of the value field.
    if (u16(b, entry + 2, le) !== 3 || u32(b, entry + 4, le) !== 1) return 1;
    const value = u16(b, entry + 8, le);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

function jpeg(b: Uint8Array): number {
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return 1;
    const marker = b[p + 1] ?? 0;
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return 1; // EXIF precedes the scan
    const len = u16(b, p + 2, false);
    if (marker === 0xe1 && tag(b, p + 4, 'Exif\0\0')) {
      return tiffOrientation(b, p + 10, Math.min(p + 2 + len, b.length));
    }
    p += 2 + len;
  }
  return 1;
}

function png(b: Uint8Array): number {
  let p = 8;
  while (p + 12 <= b.length) {
    const len = u32(b, p, false);
    if (tag(b, p + 4, 'eXIf')) return tiffOrientation(b, p + 8, Math.min(p + 8 + len, b.length));
    if (tag(b, p + 4, 'IDAT')) return 1; // eXIf must precede the image data in practice; stop early
    p += 12 + len;
  }
  return 1;
}

function webp(b: Uint8Array): number {
  let p = 12;
  while (p + 8 <= b.length) {
    const len = u32(b, p + 4, true);
    if (tag(b, p, 'EXIF')) {
      const start = tag(b, p + 8, 'Exif\0\0') ? p + 14 : p + 8;
      return tiffOrientation(b, start, Math.min(p + 8 + len, b.length));
    }
    p += 8 + len + (len & 1);
  }
  return 1;
}

/** EXIF orientation 1..8; 1 when absent or malformed. */
export function readOrientation(b: Uint8Array, format: ImageFormat): number {
  try {
    return format === 'jpeg' ? jpeg(b) : format === 'png' ? png(b) : webp(b);
  } catch {
    return 1;
  }
}
