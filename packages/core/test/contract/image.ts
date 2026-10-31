import { describe, expect, it } from 'vitest';
import { InvalidImageError } from '../../src/errors';
import type { ImageProcessor } from '../../src/ports';

export interface ImageContractHarness {
  processor: ImageProcessor;
  fixtures: {
    /** Decodable and larger than 1600 px on the longer side. */
    large: Uint8Array;
    /** Decodable and smaller than 128 px on the longer side. */
    small: Uint8Array;
    /** Optional: carries metadata (EXIF) that must not reach the variants. */
    withMetadata?: Uint8Array;
    /** Optional: stored with an EXIF orientation that swaps the axes (5..8); `width` x `height` are the stored pixels. */
    rotated?: { body: Uint8Array; width: number; height: number; orientation: number };
  };
}

const u32 = (b: Uint8Array, o: number) =>
  (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

/** Dimensions of a WebP file (lossy, lossless and extended layouts), or null if it is not WebP. */
export function webpDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const kind = ascii(b, 12, 4);
  if (kind === 'VP8 ')
    return {
      width: ((b[26] ?? 0) | ((b[27] ?? 0) << 8)) & 0x3fff,
      height: ((b[28] ?? 0) | ((b[29] ?? 0) << 8)) & 0x3fff,
    };
  if (kind === 'VP8L') {
    const bits = u32(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') {
    const w = (b[24] ?? 0) | ((b[25] ?? 0) << 8) | ((b[26] ?? 0) << 16);
    const h = (b[27] ?? 0) | ((b[28] ?? 0) << 8) | ((b[29] ?? 0) << 16);
    return { width: w + 1, height: h + 1 };
  }
  return null;
}

const hasChunk = (b: Uint8Array, name: string) => {
  const text = new TextDecoder('latin1').decode(b);
  return text.includes(name);
};

/** Behaviour every ImageProcessor must show, independent of the implementation. */
export function describeImageProcessorContract(
  name: string,
  factory: () => Promise<ImageContractHarness>,
): void {
  describe(`ImageProcessor contract: ${name}`, () => {
    const SIZES = [128, 512, 1600];

    it('returns the original dimensions and one WebP variant per requested size, in order', async () => {
      const h = await factory();
      const out = await h.processor.process(h.fixtures.large, SIZES);
      expect(out.width).toBeGreaterThan(1600 / 2);
      expect(out.variants.map((v) => v.size)).toEqual(SIZES);
      for (const v of out.variants) {
        expect(v.bytes).toBe(v.body.byteLength);
        expect(v.bytes).toBeGreaterThan(0);
        expect(webpDimensions(v.body)).not.toBeNull();
      }
    });

    it('scales the longer side down to the size and keeps the aspect ratio', async () => {
      const h = await factory();
      const out = await h.processor.process(h.fixtures.large, SIZES);
      const ratio = out.width / out.height;
      for (const v of out.variants) {
        const dims = webpDimensions(v.body);
        const longer = Math.max(dims?.width ?? 0, dims?.height ?? 0);
        expect(longer).toBeLessThanOrEqual(v.size);
        if (Math.max(out.width, out.height) >= v.size)
          expect(Math.abs(longer - v.size)).toBeLessThanOrEqual(1);
        expect(Math.abs((dims?.width ?? 0) / (dims?.height ?? 1) - ratio)).toBeLessThan(
          0.05 * Math.max(1, ratio),
        );
      }
    });

    it('never upscales, but still produces every variant', async () => {
      const h = await factory();
      const out = await h.processor.process(h.fixtures.small, SIZES);
      expect(out.variants).toHaveLength(3);
      for (const v of out.variants) {
        const dims = webpDimensions(v.body);
        expect(dims?.width).toBe(out.width);
        expect(dims?.height).toBe(out.height);
      }
    });

    it('is deterministic enough to deduplicate on: same input, same dimensions', async () => {
      const h = await factory();
      const a = await h.processor.process(h.fixtures.large, SIZES);
      const b = await h.processor.process(h.fixtures.large, SIZES);
      expect([a.width, a.height]).toEqual([b.width, b.height]);
    });

    it('strips metadata from variants', async (ctx) => {
      const h = await factory();
      if (!h.fixtures.withMetadata) return ctx.skip();
      const out = await h.processor.process(h.fixtures.withMetadata, SIZES);
      for (const v of out.variants) {
        expect(hasChunk(v.body, 'EXIF')).toBe(false);
        expect(hasChunk(v.body, 'XMP ')).toBe(false);
      }
    });

    it('applies the EXIF orientation: upright dimensions, no orientation left in the variants', async (ctx) => {
      const h = await factory();
      const rotated = h.fixtures.rotated;
      if (!rotated) return ctx.skip();
      const swaps = rotated.orientation >= 5;
      const out = await h.processor.process(rotated.body, SIZES);
      expect(out.width).toBe(swaps ? rotated.height : rotated.width);
      expect(out.height).toBe(swaps ? rotated.width : rotated.height);
      for (const v of out.variants) {
        const dims = webpDimensions(v.body);
        // Portrait stays portrait, landscape stays landscape: compare the orientation of the aspect ratio.
        expect(Math.sign((dims?.width ?? 0) - (dims?.height ?? 0))).toBe(Math.sign(out.width - out.height));
        expect(hasChunk(v.body, 'EXIF')).toBe(false);
      }
    });

    it('throws InvalidImageError for undecodable input', async () => {
      const h = await factory();
      await expect(
        h.processor.process(new TextEncoder().encode('definitely not an image'), SIZES),
      ).rejects.toBeInstanceOf(InvalidImageError);
      await expect(h.processor.process(new Uint8Array(0), SIZES)).rejects.toBeInstanceOf(InvalidImageError);
    });
  });
}
