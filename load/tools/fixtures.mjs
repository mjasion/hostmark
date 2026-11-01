// Generates the upload fixtures into load/fixtures (gitignored, about 12 MB). Each file has a 16 byte "slot": a JPEG
// comment segment or a PNG tEXt chunk. A scenario overwrites the slot with a unique token before every upload, so no
// two uploads share a SHA-256 and the worker's per-user deduplication (D54) never replaces the work being measured.
// JPEG encoding uses @jsquash/jpeg from the workspace install (`pnpm install` at the repository root first).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'fixtures');
export const SLOT_BYTES = 16;

/** Deterministic noise, so a regenerated fixture is the same file. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

async function jpegEncoder() {
  const require = createRequire(join(here, '..', '..', 'adapters', 'local', 'package.json'));
  const root = dirname(require.resolve('@jsquash/jpeg/package.json'));
  const mod = await import(require.resolve('@jsquash/jpeg/encode.js'));
  await mod.init(await WebAssembly.compile(readFileSync(join(root, 'codec/enc/mozjpeg_enc.wasm'))));
  return mod.default;
}

/** Inserts `FF FE 00 12 <16 bytes>` after SOI and an optional APP0, and returns the file and the slot offset. */
function withJpegSlot(jpeg) {
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4] << 8) | jpeg[5]);
  const segment = Uint8Array.from([0xff, 0xfe, 0x00, SLOT_BYTES + 2, ...new Uint8Array(SLOT_BYTES)]);
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, at), 0);
  out.set(segment, at);
  out.set(jpeg.subarray(at), at + segment.length);
  return { bytes: out, slotOffset: at + 4 };
}

async function makeJpeg(encode, width, height, noise, quality) {
  const rand = rng(width * 31 + height);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 255) / width + (rand() - 0.5) * noise;
      data[i + 1] = (y * 255) / height + (rand() - 0.5) * noise;
      data[i + 2] = 128 + 60 * Math.sin((x + y) / 90) + (rand() - 0.5) * noise;
      data[i + 3] = 255;
    }
  }
  return new Uint8Array(await encode({ data, width, height }, { quality }));
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const chunk = (type, body) => {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(Buffer.from(type, 'latin1'), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
};

/** Assembles a PNG from raw scanlines; the tEXt chunk holds the unique slot (its CRC covers type and body). */
function pngFile(width, height, depth, raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([depth, 2, 0, 0, 0], 8);
  const text = chunk('tEXt', Buffer.concat([Buffer.from('hm\0'), Buffer.alloc(SLOT_BYTES)]));
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    text,
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  return { bytes: Buffer.concat(parts), slotOffset: 8 + 25 + 8 + 3 };
}

/** Random RGB noise does not compress, so the file size is the pixel count times three. */
function makePng(side) {
  const rand = rng(side);
  const row = side * 3 + 1;
  const raw = Buffer.alloc(row * side);
  for (let y = 0; y < side; y++) for (let i = 1; i < row; i++) raw[y * row + i] = (rand() * 256) | 0;
  return pngFile(side, side, 8, raw);
}

/**
 * Colored blocks of 64 x 64 pixels, 8 or 16 bits per channel: runs of equal bytes keep the file well under the 10 MiB
 * upload limit while the decoded image stays at about 49 MP.
 */
function makeBlockPng(width, height, depth) {
  const bytesPerSample = depth / 8;
  const row = width * 3 * bytesPerSample + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    let at = y * row + 1;
    for (let x = 0; x < width; x++) {
      const bx = x >> 6;
      const by = y >> 6;
      const samples = [(bx * 37) & 255, (by * 59) & 255, ((bx + by) * 23) & 255];
      for (const v of samples) {
        if (bytesPerSample === 2) {
          raw.writeUInt16BE(v * 257, at);
          at += 2;
        } else raw[at++] = v;
      }
    }
  }
  return pngFile(width, height, depth, raw);
}

/** Appends an `hmSL` chunk with the slot to a WebP file (RIFF size updated); decoders skip unknown chunks. */
function withWebpSlot(webp) {
  const chunkBytes = Buffer.concat([
    Buffer.from('hmSL', 'latin1'),
    Buffer.from([SLOT_BYTES, 0, 0, 0]),
    Buffer.alloc(SLOT_BYTES),
  ]);
  const out = Buffer.concat([webp, chunkBytes]);
  out.writeUInt32LE(out.length - 8, 4);
  return { bytes: out, slotOffset: webp.length + 8 };
}

async function webpEncoder() {
  const require = createRequire(join(here, '..', '..', 'adapters', 'local', 'package.json'));
  const root = dirname(require.resolve('@jsquash/webp/package.json'));
  const mod = await import(require.resolve('@jsquash/webp/encode.js'));
  await mod.init(await WebAssembly.compile(readFileSync(join(root, 'codec/enc/webp_enc.wasm'))));
  return mod.default;
}

async function makeWebp(encode, width, height) {
  const rand = rng(width * 17 + height);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 255) / width + (rand() - 0.5) * 8;
      data[i + 1] = (y * 255) / height + (rand() - 0.5) * 8;
      data[i + 2] = 128 + 60 * Math.sin((x + y) / 90);
      data[i + 3] = 255;
    }
  }
  return Buffer.from(await encode({ data, width, height }, { quality: 60 }));
}

export async function main() {
  mkdirSync(outDir, { recursive: true });
  const encode = await jpegEncoder();
  const manifest = {};
  const save = (name, kind, file, extra = {}) => {
    writeFileSync(join(outDir, name), file.bytes);
    manifest[name] = {
      kind,
      bytes: file.bytes.length,
      slotOffset: file.slotOffset,
      slotBytes: SLOT_BYTES,
      ...extra,
    };
    console.log(`${name}: ${file.bytes.length} bytes`);
  };

  save('jpeg-tiny.jpg', 'jpeg', withJpegSlot(await makeJpeg(encode, 64, 48, 20, 80)));

  // About 1 MB at 12 MP: the "1 MB JPEG" of S4 and S5. Pick the quality closest to 1 MB.
  let best;
  for (const quality of [55, 65, 75]) {
    const jpeg = withJpegSlot(await makeJpeg(encode, 4000, 3000, 40, quality));
    if (!best || Math.abs(jpeg.bytes.length - 1_000_000) < Math.abs(best.bytes.length - 1_000_000))
      best = jpeg;
    if (jpeg.bytes.length >= 1_000_000) break;
  }
  save('jpeg-1mb.jpg', 'jpeg', best, { width: 4000, height: 3000 });

  save('png-10mb.png', 'png', makePng(1826), { width: 1826, height: 1826 });

  // The pixel limit of the worker is 50 MP (D31, D79): 7071 x 7071 is just below it and compresses to a small file.
  save('jpeg-50mp.jpg', 'jpeg', withJpegSlot(await makeJpeg(encode, 7071, 7071, 6, 80)), {
    width: 7071,
    height: 7071,
  });

  // The other maximum-size inputs of D79 (about 49 MP each): a 16-bit PNG, a tall PNG and a WebP.
  save('png16-49mp.png', 'png', makeBlockPng(7000, 7000, 16), { width: 7000, height: 7000, depth: 16 });
  save('png-tall-49mp.png', 'png', makeBlockPng(1000, 49000, 8), { width: 1000, height: 49000, depth: 8 });
  save('webp-49mp.webp', 'webp', withWebpSlot(await makeWebp(await webpEncoder(), 7000, 7000)), {
    width: 7000,
    height: 7000,
  });

  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
