import { InvalidImageError } from '@hostmark/core/ports';
import { describe, expect, it } from 'vitest';
import {
  blocksImage,
  fromWebp,
  hasAscii,
  processor,
  readBlocks,
  solid,
  tiff,
  toJpeg,
  toPng,
  toWebp,
  withJpegExif,
  withPngExif,
  withWebpExif,
} from './helpers';

const SIZES = [128, 512, 1600];

// Source is A B / C D / E F; the expected grids follow the EXIF definition of each orientation.
const EXPECTED: Record<number, string[][]> = {
  1: [
    ['A', 'B'],
    ['C', 'D'],
    ['E', 'F'],
  ],
  2: [
    ['B', 'A'],
    ['D', 'C'],
    ['F', 'E'],
  ],
  3: [
    ['F', 'E'],
    ['D', 'C'],
    ['B', 'A'],
  ],
  4: [
    ['E', 'F'],
    ['C', 'D'],
    ['A', 'B'],
  ],
  5: [
    ['A', 'C', 'E'],
    ['B', 'D', 'F'],
  ],
  6: [
    ['E', 'C', 'A'],
    ['F', 'D', 'B'],
  ],
  7: [
    ['F', 'D', 'B'],
    ['E', 'C', 'A'],
  ],
  8: [
    ['B', 'D', 'F'],
    ['A', 'C', 'E'],
  ],
};

describe('formats', () => {
  it('processes PNG, JPEG and WebP and returns three WebP variants', async () => {
    const img = solid(300, 200, [10, 200, 90, 255]);
    for (const input of [await toPng(img), await toJpeg(img), await toWebp(img)]) {
      const r = await processor.process(input, SIZES);
      expect(processor.impl).toBe('wasm');
      expect([r.width, r.height]).toEqual([300, 200]);
      expect(r.variants.map((v) => v.size)).toEqual(SIZES);
      for (const v of r.variants) {
        expect(v.bytes).toBe(v.body.byteLength);
        expect(String.fromCharCode(...v.body.subarray(0, 4))).toBe('RIFF');
        expect(String.fromCharCode(...v.body.subarray(8, 12))).toBe('WEBP');
      }
    }
  });

  it('downscales keeping aspect ratio, longer side = size', async () => {
    const r = await processor.process(await toPng(solid(3000, 1000, [1, 2, 3, 255])), SIZES);
    const dims = await Promise.all(r.variants.map(async (v) => fromWebp(v.body)));
    expect(dims.map((d) => [d.width, d.height])).toEqual([
      [128, 43],
      [512, 171],
      [1600, 533],
    ]);
  });

  it('never upscales but still returns every variant', async () => {
    const r = await processor.process(await toPng(solid(100, 60, [5, 5, 5, 255])), SIZES);
    expect(r.variants).toHaveLength(3);
    for (const v of r.variants.slice(1)) {
      const d = await fromWebp(v.body);
      expect([d.width, d.height]).toEqual([100, 60]);
    }
    const small = await fromWebp((r.variants[0] as { body: Uint8Array }).body);
    expect([small.width, small.height]).toEqual([100, 60]);
  });

  it('keeps the smallest dimension at least 1', async () => {
    const r = await processor.process(await toPng(solid(2000, 2, [9, 9, 9, 255])), [128]);
    const d = await fromWebp((r.variants[0] as { body: Uint8Array }).body);
    expect([d.width, d.height]).toEqual([128, 1]);
  });

  it('returns one variant per requested size, in request order, including duplicates', async () => {
    const r = await processor.process(await toPng(solid(400, 400, [9, 9, 9, 255])), [512, 128, 128]);
    expect(r.variants.map((v) => v.size)).toEqual([512, 128, 128]);
  });

  it('detects format from magic bytes, not from anything declared', async () => {
    // A PNG with a JPEG-looking file name or content type makes no difference: only bytes are given.
    const r = await processor.process(await toPng(solid(20, 20, [1, 1, 1, 255])), [128]);
    expect(r.width).toBe(20);
  });

  it('preserves alpha', async () => {
    const img = solid(64, 64, [255, 0, 0, 128]);
    for (const input of [await toPng(img), await toWebp(img)]) {
      const r = await processor.process(input, [128]);
      const d = await fromWebp((r.variants[0] as { body: Uint8Array }).body);
      expect(Math.abs((d.data[3] as number) - 128)).toBeLessThanOrEqual(2);
    }
  });
});

describe('EXIF orientation', () => {
  for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const expected = EXPECTED[o] as string[][];
    const w = (expected[0] as string[]).length * 8;
    const h = expected.length * 8;

    it(`orientation ${o} in JPEG`, async () => {
      const input = withJpegExif(await toJpeg(blocksImage()), o);
      const r = await processor.process(input, [128, 512]);
      expect([r.width, r.height]).toEqual([w, h]);
      for (const v of r.variants) expect(readBlocks(await fromWebp(v.body))).toEqual(expected);
    });

    it(`orientation ${o} in PNG`, async () => {
      const input = withPngExif(await toPng(blocksImage()), o);
      const r = await processor.process(input, [128]);
      expect([r.width, r.height]).toEqual([w, h]);
      expect(readBlocks(await fromWebp((r.variants[0] as { body: Uint8Array }).body))).toEqual(expected);
    });

    it(`orientation ${o} in WebP`, async () => {
      const input = withWebpExif(await toWebp(blocksImage()), 16, 24, o);
      const r = await processor.process(input, [128]);
      expect([r.width, r.height]).toEqual([w, h]);
      expect(readBlocks(await fromWebp((r.variants[0] as { body: Uint8Array }).body))).toEqual(expected);
    });
  }

  it('orients when the image is also downscaled', async () => {
    // 160x240 version of the blocks image: 80 px blocks, scaled to 16x24 -> blocks of 8 again.
    const big = solid(160, 240, [0, 0, 0, 255]);
    const small = blocksImage();
    for (let y = 0; y < 240; y++) {
      for (let x = 0; x < 160; x++) {
        const s = (Math.floor(y / 10) * 16 + Math.floor(x / 10)) * 4;
        big.data.set(small.data.subarray(s, s + 4), (y * 160 + x) * 4);
      }
    }
    const r = await processor.process(withJpegExif(await toJpeg(big), 6), [24]);
    const d = await fromWebp((r.variants[0] as { body: Uint8Array }).body);
    expect([r.width, r.height]).toEqual([240, 160]);
    expect([d.width, d.height]).toEqual([24, 16]);
    expect(readBlocks(d)).toEqual(EXPECTED[6]);
  });

  it('ignores malformed EXIF instead of failing', async () => {
    const jpeg = await toJpeg(blocksImage());
    const garbage = [
      Uint8Array.of(1, 2, 3),
      Uint8Array.of(0x49, 0x49, 0x2a, 0, 0xff, 0xff, 0xff, 0x7f), // IFD offset out of range
      Uint8Array.of(0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0xff, 0xff, 0, 0), // absurd entry count
      tiff(99), // orientation out of range
    ];
    for (const g of garbage) {
      const r = await processor.process(withJpegExif(jpeg, 1, g), [128]);
      expect(readBlocks(await fromWebp((r.variants[0] as { body: Uint8Array }).body))).toEqual(EXPECTED[1]);
    }
  });

  it('outputs carry no metadata', async () => {
    const input = withJpegExif(await toJpeg(blocksImage()), 6);
    expect(hasAscii(input, 'Exif')).toBe(true);
    const r = await processor.process(input, SIZES);
    for (const v of r.variants) {
      expect(hasAscii(v.body, 'EXIF')).toBe(false);
      expect(hasAscii(v.body, 'XMP ')).toBe(false);
      expect(hasAscii(v.body, 'ICCP')).toBe(false);
      expect(hasAscii(v.body, 'Exif')).toBe(false);
    }
  });
});

describe('invalid input', () => {
  const rejects = async (input: Uint8Array) => {
    await expect(processor.process(input, SIZES)).rejects.toBeInstanceOf(InvalidImageError);
  };

  it('rejects non-image bytes and empty input', async () => {
    await rejects(new TextEncoder().encode('hello, this is not an image'));
    await rejects(new Uint8Array(0));
    await rejects(Uint8Array.of(0xff));
  });

  it('rejects unsupported image formats', async () => {
    await rejects(new TextEncoder().encode('GIF89a\x01\x00\x01\x00\x00\x00\x00;'));
    await rejects(
      Uint8Array.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    );
  });

  it('rejects truncated images of every format', async () => {
    const img = blocksImage();
    for (const full of [await toPng(img), await toJpeg(img), await toWebp(img)]) {
      await rejects(full.subarray(0, Math.floor(full.length / 2)));
      await rejects(full.subarray(0, 10));
    }
  });

  it('rejects corrupted image data', async () => {
    const png = await toPng(solid(64, 64, [200, 100, 50, 255]));
    const bad = png.slice();
    for (let i = 60; i < bad.length - 20; i++) bad[i] = (bad[i] as number) ^ 0xa5;
    await rejects(bad);
    const jpeg = (await toJpeg(solid(64, 64, [200, 100, 50, 255]))).slice(0, 700);
    await rejects(jpeg.subarray(0, 120));
  });
});

describe('decompression bomb guard', () => {
  const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const pngHeader = (w: number, h: number) =>
    Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0,
      0,
      0,
      13,
      0x49,
      0x48,
      0x44,
      0x52,
      ...be32(w),
      ...be32(h),
      8,
      6,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);

  it('rejects a PNG header claiming 30000x30000 before decoding, quickly', async () => {
    const started = performance.now();
    await expect(processor.process(pngHeader(30000, 30000), SIZES)).rejects.toBeInstanceOf(InvalidImageError);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('rejects oversized JPEG and WebP headers', async () => {
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x75, 0x30, 0x75, 0x30, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    ]);
    await expect(processor.process(jpeg, SIZES)).rejects.toBeInstanceOf(InvalidImageError);
    // VP8X canvas of 30000x30000
    const w = 29999;
    const webp = Uint8Array.from([
      ...'RIFF'.split('').map((c) => c.charCodeAt(0)),
      30,
      0,
      0,
      0,
      ...'WEBPVP8X'.split('').map((c) => c.charCodeAt(0)),
      10,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      w & 255,
      w >> 8,
      0,
      w & 255,
      w >> 8,
      0,
      0,
      0,
    ]);
    await expect(processor.process(webp, SIZES)).rejects.toBeInstanceOf(InvalidImageError);
  });
});
