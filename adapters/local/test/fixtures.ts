import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import jpegEncode, { init as initJpegEncoder } from '@jsquash/jpeg/encode.js';

type Init = (module: WebAssembly.Module) => Promise<unknown>;

let ready: Promise<unknown> | undefined;
function setup(): Promise<unknown> {
  ready ??= (async () => {
    const root = dirname(createRequire(import.meta.url).resolve('@jsquash/jpeg/package.json'));
    const wasm = await WebAssembly.compile(await readFile(join(root, 'codec/enc/mozjpeg_enc.wasm')));
    await (initJpegEncoder as unknown as Init)(wasm);
  })();
  return ready;
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

/** Little endian TIFF block with a single Orientation entry. */
const tiff = (orientation: number): Uint8Array =>
  Uint8Array.from([
    0x49,
    0x49,
    0x2a,
    0,
    8,
    0,
    0,
    0,
    1,
    0,
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

/** A JPEG with a smooth colour gradient (it compresses well), optionally tagged with EXIF orientation. */
export async function makeJpeg(width: number, height: number, orientation?: number): Promise<Uint8Array> {
  await setup();
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set([(x * 255) / width, (y * 255) / height, 128, 255], (y * width + x) * 4);
    }
  }
  const jpeg = new Uint8Array(
    await jpegEncode({ data, width, height } as unknown as ImageData, { quality: 80 }),
  );
  if (orientation === undefined) return jpeg;
  const body = concat(
    Uint8Array.from([...'Exif'].map((c) => c.charCodeAt(0)).concat([0, 0])),
    tiff(orientation),
  );
  const len = body.length + 2;
  return concat(
    jpeg.subarray(0, 2),
    Uint8Array.from([0xff, 0xe1, len >> 8, len & 255]),
    body,
    jpeg.subarray(2),
  );
}
