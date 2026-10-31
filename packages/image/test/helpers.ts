import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import jpegEncode, { init as initJpegEnc } from '@jsquash/jpeg/encode.js';
import pngEncode, { init as initPngEnc } from '@jsquash/png/encode.js';
import webpDecode, { init as initWebpDec } from '@jsquash/webp/decode.js';
import webpEncode, { init as initWebpEnc } from '@jsquash/webp/encode.js';
import { createWasmImageProcessor } from '../src/index';
import { nodeLoader } from '../src/node';

export const processor = createWasmImageProcessor(nodeLoader);

export interface Rgba {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

type Init = (m: WebAssembly.Module) => Promise<unknown>;
let ready: Promise<unknown> | undefined;
// The test codecs are separate module instances from the ones inside the processor.
export function setupCodecs(): Promise<unknown> {
  ready ??= (async () => {
    await (initPngEnc as unknown as Init)(await nodeLoader.pngDecoder());
    await (initWebpDec as unknown as Init)(await nodeLoader.webpDecoder());
    await (initWebpEnc as unknown as Init)(
      await nodeLoader.webpEncoder(
        WebAssembly.validate(
          new Uint8Array([
            0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
            253, 98, 11,
          ]),
        ),
      ),
    );
    const jpegRoot = dirname(createRequire(import.meta.url).resolve('@jsquash/jpeg/package.json'));
    const jpegEnc = await WebAssembly.compile(await readFile(join(jpegRoot, 'codec/enc/mozjpeg_enc.wasm')));
    await (initJpegEnc as unknown as Init)(jpegEnc);
  })();
  return ready;
}

export const RED = [255, 0, 0, 255] as const;
export const GREEN = [0, 255, 0, 255] as const;
export const BLUE = [0, 0, 255, 255] as const;
export const YELLOW = [255, 255, 0, 255] as const;
export const WHITE = [255, 255, 255, 255] as const;
export const BLACK = [0, 0, 0, 255] as const;

/** Labels of the six blocks of the 2 columns x 3 rows fixture, row major. */
export const LABELS = 'ABCDEF';
export const BLOCK_COLORS: Record<string, readonly number[]> = {
  A: RED,
  B: GREEN,
  C: BLUE,
  D: YELLOW,
  E: WHITE,
  F: BLACK,
};

/** A 2x3 grid of 8x8 blocks (16x24 px): A B / C D / E F. */
export function blocksImage(): Rgba {
  const width = 16;
  const height = 24;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const label = LABELS[Math.floor(y / 8) * 2 + Math.floor(x / 8)] as string;
      data.set(BLOCK_COLORS[label] as number[], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

export function solid(width: number, height: number, rgba: readonly number[]): Rgba {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { data, width, height };
}

export async function toPng(img: Rgba): Promise<Uint8Array> {
  await setupCodecs();
  return new Uint8Array(await pngEncode(img as unknown as ImageData));
}
export async function toJpeg(img: Rgba, quality = 95): Promise<Uint8Array> {
  await setupCodecs();
  return new Uint8Array(await jpegEncode(img as unknown as ImageData, { quality }));
}
export async function toWebp(
  img: Rgba,
  options: Record<string, number> = { lossless: 1 },
): Promise<Uint8Array> {
  await setupCodecs();
  return new Uint8Array(await webpEncode(img as unknown as ImageData, options));
}
export async function fromWebp(bytes: Uint8Array): Promise<Rgba> {
  await setupCodecs();
  const r = await webpDecode(bytes as unknown as ArrayBuffer);
  return { data: r.data as Uint8ClampedArray, width: r.width, height: r.height };
}

/** Labels of the blocks in an image of 8x8 blocks, by nearest colour at each block centre. */
export function readBlocks(img: Rgba): string[][] {
  const rows: string[][] = [];
  for (let by = 0; by < img.height / 8; by++) {
    const row: string[] = [];
    for (let bx = 0; bx < img.width / 8; bx++) {
      const i = ((by * 8 + 4) * img.width + bx * 8 + 4) * 4;
      let best = '';
      let bestDist = Infinity;
      for (const [label, c] of Object.entries(BLOCK_COLORS)) {
        const d = [0, 1, 2].reduce((s, k) => s + ((img.data[i + k] as number) - (c[k] as number)) ** 2, 0);
        if (d < bestDist) [best, bestDist] = [label, d];
      }
      row.push(best);
    }
    rows.push(row);
  }
  return rows;
}

/** Little endian TIFF block with a single orientation entry. */
export function tiff(orientation: number): Uint8Array {
  return Uint8Array.from([
    0x49,
    0x49,
    0x2a,
    0,
    8,
    0,
    0,
    0, // header, IFD0 at 8
    1,
    0, // one entry
    0x12,
    0x01,
    3,
    0,
    1,
    0,
    0,
    0,
    orientation,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const be32 = (n: number): Uint8Array =>
  Uint8Array.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const le32 = (n: number): Uint8Array =>
  Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24]);
const ascii = (s: string): Uint8Array => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

/** Inserts an APP1 Exif segment right after SOI. `payload` replaces the TIFF block when given. */
export function withJpegExif(jpeg: Uint8Array, orientation: number, payload?: Uint8Array): Uint8Array {
  const body = concat(ascii('Exif\0\0'), payload ?? tiff(orientation));
  const len = body.length + 2;
  return concat(
    jpeg.subarray(0, 2),
    Uint8Array.from([0xff, 0xe1, len >> 8, len & 255]),
    body,
    jpeg.subarray(2),
  );
}

/** Inserts an eXIf chunk after IHDR. */
export function withPngExif(png: Uint8Array, orientation: number): Uint8Array {
  const data = tiff(orientation);
  const type = ascii('eXIf');
  const chunk = concat(be32(data.length), type, data, be32(crc32(concat(type, data))));
  return concat(png.subarray(0, 33), chunk, png.subarray(33));
}

/** Wraps a simple WebP into an extended one with an EXIF chunk. */
export function withWebpExif(
  webp: Uint8Array,
  width: number,
  height: number,
  orientation: number,
): Uint8Array {
  const exif = tiff(orientation);
  const pad = (b: Uint8Array) => (b.length % 2 ? concat(b, Uint8Array.of(0)) : b);
  const vp8x = concat(
    ascii('VP8X'),
    le32(10),
    Uint8Array.of(0x08, 0, 0, 0),
    Uint8Array.of((width - 1) & 255, ((width - 1) >> 8) & 255, (width - 1) >> 16),
    Uint8Array.of((height - 1) & 255, ((height - 1) >> 8) & 255, (height - 1) >> 16),
  );
  const image = webp.subarray(12); // chunks of the simple file
  const tail = concat(vp8x, pad(image), ascii('EXIF'), le32(exif.length), pad(exif));
  return concat(ascii('RIFF'), le32(tail.length + 4), ascii('WEBP'), tail);
}

export function hasAscii(bytes: Uint8Array, text: string): boolean {
  const needle = ascii(text);
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
