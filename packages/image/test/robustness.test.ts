import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { InvalidImageError } from '@hostmark/core/ports';
import { describe, expect, it } from 'vitest';
import { readHeader } from '../src/header';
import { createWasmImageProcessor, type WasmLoader } from '../src/index';
import { nodeLoader } from '../src/node';
import { processor, solid, toJpeg, toPng } from './helpers';

const SIZES = [128];
const GREEN = [10, 200, 30, 255] as const;

const indexOfMarker = (b: Uint8Array, marker: number): number => {
  for (let i = 2; i < b.length - 1; i++) if (b[i] === 0xff && b[i + 1] === marker) return i;
  throw new Error(`no marker ${marker.toString(16)}`);
};

/** Frame header and entropy data cut away: libjpeg reports an error and exits. */
const jpegWithoutScan = (jpeg: Uint8Array): Uint8Array => jpeg.slice(0, indexOfMarker(jpeg, 0xda));
const jpegWithBrokenHuffmanTable = (jpeg: Uint8Array): Uint8Array => {
  const out = jpeg.slice();
  const dht = indexOfMarker(jpeg, 0xc4);
  out[dht + 6] = 0xff;
  out[dht + 7] = 0xff;
  return out;
};
const withComponents = (jpeg: Uint8Array, components: number): Uint8Array => {
  const out = jpeg.slice();
  out[indexOfMarker(jpeg, 0xc0 + (jpeg.includes(0xc2) ? 2 : 0)) + 9] = components;
  return out;
};

/** A JPEG whose real frame header claims `width` x `height`, behind an `FF 00` that skips it by length. */
function hiddenFrame(jpeg: Uint8Array, width: number, height: number): Uint8Array {
  const real = jpeg.slice();
  let p = 2;
  for (;;) {
    const marker = real[p + 1] ?? 0;
    if (real[p] === 0xff && (marker === 0xc0 || marker === 0xc2)) break;
    p += 2 + (((real[p + 2] ?? 0) << 8) | (real[p + 3] ?? 0));
    if (p >= real.length) throw new Error('no frame header');
  }
  real[p + 5] = height >> 8;
  real[p + 6] = height & 255;
  real[p + 7] = width >> 8;
  real[p + 8] = width & 255;
  const rest = real.subarray(2);
  const decoy = Uint8Array.from([0xff, 0xc0, 0, 17, 8, 0, 1, 0, 1, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const skip = rest.length + 2;
  const out = new Uint8Array(2 + 4 + rest.length + decoy.length);
  out.set([0xff, 0xd8, 0xff, 0x00, skip >> 8, skip & 255]);
  out.set(rest, 6);
  out.set(decoy, 6 + rest.length);
  return out;
}

/** Loader that counts how often a codec is requested, to prove that nothing was decoded. */
function countingLoader(): { loader: WasmLoader; calls: string[] } {
  const calls: string[] = [];
  const spy =
    <T extends unknown[]>(name: string, fn: (...args: T) => ReturnType<WasmLoader['resize']>) =>
    (...args: T) => {
      calls.push(name);
      return fn(...args);
    };
  return {
    calls,
    loader: {
      jpegDecoder: spy('jpegDecoder', nodeLoader.jpegDecoder),
      pngDecoder: spy('pngDecoder', nodeLoader.pngDecoder),
      webpDecoder: spy('webpDecoder', nodeLoader.webpDecoder),
      webpEncoder: spy('webpEncoder', nodeLoader.webpEncoder),
      resize: spy('resize', nodeLoader.resize),
    },
  };
}

// Dropped wasm instances are garbage that V8 collects late (hundreds of MB), so measure after a collection.
setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;
const rssMb = (): number => {
  collect();
  return process.memoryUsage().rss / 1e6;
};

describe('a failed decode does not damage the next one (B1)', () => {
  it('survives hundreds of corrupt JPEGs and truncated PNGs', async () => {
    const jpeg = await toJpeg(solid(300, 200, GREEN), 90);
    const png = await toPng(solid(1500, 1000, GREEN));
    const goodPng = await toPng(solid(300, 200, GREEN));
    const brokenJpegs = [jpegWithoutScan(jpeg), jpegWithBrokenHuffmanTable(jpeg)];
    const truncatedPng = png.slice(0, png.length >> 1);
    const before = rssMb();

    // Plain catch: vitest's `expect().rejects` keeps the failed calls alive and would distort the measurement.
    for (let i = 0; i < 300; i++) {
      const bad = brokenJpegs[i % brokenJpegs.length] as Uint8Array;
      await processor.process(bad, SIZES).catch(() => undefined);
      await processor.process(truncatedPng, SIZES).catch(() => undefined);
      if (i % 25 === 24) {
        // Fails with "Aborted()" or "memory access out of bounds" once the codec is damaged.
        expect((await processor.process(jpeg, SIZES)).width).toBe(300);
        expect((await processor.process(goodPng, SIZES)).width).toBe(300);
      }
    }

    // Each truncated 1500x1000 PNG used to leak 6 MB of wasm memory for good.
    expect(rssMb() - before).toBeLessThan(300);
  }, 120_000);

  it('does not break calls running at the same time as a failure', async () => {
    const jpeg = await toJpeg(solid(300, 200, GREEN), 90);
    const png = await toPng(solid(300, 200, GREEN));
    const bad = jpegWithoutScan(jpeg);
    const badPng = png.slice(0, png.length >> 1);

    for (let round = 0; round < 40; round++) {
      const results = await Promise.allSettled([
        processor.process(jpeg, SIZES),
        processor.process(bad, SIZES),
        processor.process(png, SIZES),
        processor.process(badPng, SIZES),
        processor.process(jpeg, SIZES),
        processor.process(bad, SIZES),
        processor.process(png, SIZES),
        processor.process(badPng, SIZES),
      ]);
      expect(results.map((r) => r.status)).toEqual([
        'fulfilled',
        'rejected',
        'fulfilled',
        'rejected',
        'fulfilled',
        'rejected',
        'fulfilled',
        'rejected',
      ]);
    }
  }, 60_000);

  it('reports undecodable bytes as invalid input, not as a crash', async () => {
    const jpeg = await toJpeg(solid(300, 200, GREEN), 90);
    const png = await toPng(solid(300, 200, GREEN));
    await expect(processor.process(jpegWithoutScan(jpeg), SIZES)).rejects.toBeInstanceOf(InvalidImageError);
    await expect(processor.process(png.slice(0, png.length >> 1), SIZES)).rejects.toBeInstanceOf(
      InvalidImageError,
    );
  });
});

describe('codec failures that are not the input are not permanent (B1, M2)', () => {
  it('a missing wasm file is a plain error, and the next call recovers', async () => {
    const jpeg = await toJpeg(solid(300, 200, GREEN), 90);
    let broken = true;
    const flaky: WasmLoader = {
      ...nodeLoader,
      jpegDecoder: () =>
        broken ? Promise.reject(new Error('ENOENT mozjpeg_dec.wasm')) : nodeLoader.jpegDecoder(),
    };
    const p = createWasmImageProcessor(flaky);
    const error = await p.process(jpeg, SIZES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(InvalidImageError);
    broken = false;
    expect((await p.process(jpeg, SIZES)).width).toBe(300);
  });

  it('a failing resize loader is a plain error', async () => {
    const jpeg = await toJpeg(solid(300, 200, GREEN), 90);
    const p = createWasmImageProcessor({
      ...nodeLoader,
      resize: () => Promise.reject(new Error('ENOENT resize.wasm')),
    });
    const error = await p.process(jpeg, SIZES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(InvalidImageError);
  });

  it('a module that does not fit the codec is a plain error', async () => {
    const jpeg = await toJpeg(solid(300, 200, GREEN), 90);
    const empty = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const p = createWasmImageProcessor({ ...nodeLoader, jpegDecoder: () => empty });
    const error = await p.process(jpeg, SIZES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(InvalidImageError);
  });
});

describe('the size limit holds before any decoding (M1)', () => {
  it('refuses a frame header hidden behind FF 00', async () => {
    const jpeg = await toJpeg(solid(300, 200, GREEN), 90);
    const crafted = hiddenFrame(jpeg, 20_000, 20_000);
    const { loader, calls } = countingLoader();
    const p = createWasmImageProcessor(loader);
    const error = await p.process(crafted, SIZES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidImageError);
    expect((error as Error).message).toMatch(/megapixel limit/);
    expect(calls).toEqual([]);
    expect(readHeader(crafted)).toMatchObject({ width: 20_000, height: 20_000 });
  });

  it('refuses a file where the end of image comes before any frame header', async () => {
    const jpeg = await toJpeg(solid(300, 200, GREEN), 90);
    const early = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, ...jpeg.subarray(2)]);
    expect(() => readHeader(early)).toThrow(InvalidImageError);
  });

  it('still reads the frame header past fill bytes, restart markers and large segments', async () => {
    const jpeg = await toJpeg(solid(300, 200, GREEN), 90);
    // SOI, fill bytes, a COM segment full of marker-like bytes, then the real file.
    const comment = Uint8Array.from([0xff, 0xfe, 0, 8, 0xff, 0xc0, 0xff, 0x00, 0xff, 0xff]);
    const padded = Uint8Array.from([0xff, 0xd8, 0xff, 0xff, 0xff, ...comment, ...jpeg.subarray(2)]);
    expect(readHeader(padded)).toMatchObject({ format: 'jpeg', width: 300, height: 200 });
  });
});

describe('a JPEG cut off inside its scan is accepted (D77)', () => {
  it('decodes what libjpeg can recover and refuses a cut before the scan', async () => {
    const jpeg = await toJpeg(solid(300, 200, GREEN), 90);
    const cut = jpeg.slice(0, Math.floor(jpeg.length * 0.6));
    expect(await processor.process(cut, SIZES)).toMatchObject({ width: 300, height: 200 });
    await expect(processor.process(jpegWithoutScan(jpeg), SIZES)).rejects.toBeInstanceOf(InvalidImageError);
  });
});

describe('JPEGs the decoder cannot convert are refused up front (D78)', () => {
  it('rejects 4-component frames without touching a codec', async () => {
    const jpeg = await toJpeg(solid(300, 200, GREEN), 90);
    const cmyk = withComponents(jpeg, 4);
    const { loader, calls } = countingLoader();
    const p = createWasmImageProcessor(loader);
    await expect(p.process(cmyk, SIZES)).rejects.toBeInstanceOf(InvalidImageError);
    expect(calls).toEqual([]);
  });

  it('accepts gray and color frames', async () => {
    const jpeg = await toJpeg(solid(300, 200, GREEN), 90);
    expect(readHeader(withComponents(jpeg, 1)).width).toBe(300);
    expect(readHeader(jpeg).width).toBe(300);
  });
});
