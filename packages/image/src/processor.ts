import { type ImageProcessor, InvalidImageError } from '@hostmark/core/ports';
import { readOrientation } from './exif';
import { type Header, readHeader } from './header';
import type { WasmLoader } from './loader';
import { applyOrientation, type Pixels, swapsAxes } from './orient';
import { createPngDecoder, PngInputError } from './png';

/** Decoded size cap. Decoded RGBA is 4 bytes per pixel, so 50 MP is about 200 MB; see D31. */
export const MAX_PIXELS = 50_000_000;

export interface WasmImageProcessorOptions {
  maxPixels?: number;
  /** WebP quality 0..100. */
  quality?: number;
}

// Same probe wasm-feature-detect uses; @jsquash/webp picks its encoder binary with it.
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98,
  11,
]);

// Declared by hand: the jSquash typings do not describe the module argument of `init`.
type ModuleInit = (module: WebAssembly.Module) => Promise<unknown>;

const once = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => {
    p ??= fn().catch((e) => {
      p = undefined; // allow a retry after a transient failure
      throw e;
    });
    return p;
  };
};

interface Codec<T> {
  /**
   * Runs `use` with the codec, one call at a time. When `use` throws, the instance is dropped and the next
   * call builds a fresh one: libjpeg's error exit and the PNG decoder's panic leave the instance with leaked
   * memory and corrupted state, until it traps on every later image (B1). Calls are serialized so a call
   * that is already waiting never meets the instance that has just failed.
   */
  run<R>(use: (codec: T) => R | Promise<R>): Promise<R>;
}

function codec<T>(load: () => Promise<T>): Codec<T> {
  let ready: Promise<T> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(use) {
      const result = tail.then(async () => {
        ready ??= load();
        let instance: T;
        try {
          instance = await ready;
        } catch (e) {
          ready = undefined; // the loader failed: nothing is wrong with the input
          throw e;
        }
        try {
          return await use(instance);
        } catch (e) {
          ready = undefined;
          throw e;
        }
      });
      tail = result.catch(() => {});
      return result;
    },
  };
}

/**
 * The codec rejected these bytes: libjpeg's error exit (`ExitStatus`), the PNG decoder's `unwrap_throw`, or the
 * `null` result jSquash turns into "Decoding error". Everything else (a trap, `Aborted()`, a loader or
 * instantiation failure) says nothing about the file, so it must stay retriable.
 */
function isInputError(e: unknown): boolean {
  if (e instanceof PngInputError) return true;
  if (typeof e !== 'object' || e === null) return false;
  return (e as { name?: unknown }).name === 'ExitStatus' || (e as Error).message === 'Decoding error';
}

export function createWasmImageProcessor(
  loader: WasmLoader,
  options: WasmImageProcessorOptions = {},
): ImageProcessor {
  const maxPixels = options.maxPixels ?? MAX_PIXELS;
  const quality = options.quality ?? 80;

  // Compiled modules are kept across instances: a fresh instance costs no new compilation.
  const jpegModule = once(async () => loader.jpegDecoder());
  const pngModule = once(async () => loader.pngDecoder());
  const webpDecoderModule = once(async () => loader.webpDecoder());
  const webpEncoderModule = once(async () => loader.webpEncoder(WebAssembly.validate(SIMD_PROBE)));
  const resizeModule = once(async () => loader.resize());

  const jpeg = codec(async () => {
    const m = await import('@jsquash/jpeg/decode.js');
    await (m.init as unknown as ModuleInit)(await jpegModule());
    return m.default;
  });
  const png = codec(async () => createPngDecoder(await pngModule()));
  const webpDecode = codec(async () => {
    const m = await import('@jsquash/webp/decode.js');
    await (m.init as unknown as ModuleInit)(await webpDecoderModule());
    return m.default;
  });
  const webpEncode = codec(async () => {
    const m = await import('@jsquash/webp/encode.js');
    await (m.init as unknown as ModuleInit)(await webpEncoderModule());
    return m.default;
  });
  // jSquash initialises the resizer once per process and ignores a second call, so a dropped instance is
  // not replaced here. Resizing valid pixel data does not fail the way decoding hostile bytes does.
  const resizer = codec(async () => {
    const m = await import('@jsquash/resize');
    await m.initResize((await resizeModule()) as never);
    return m.default;
  });

  async function decode(input: Uint8Array, header: Header): Promise<Pixels> {
    // jSquash typings say ArrayBuffer; the codecs accept any byte view.
    const bytes = input as unknown as ArrayBuffer;
    try {
      const image =
        header.format === 'jpeg'
          ? await jpeg.run((decodeJpeg) => decodeJpeg(bytes))
          : header.format === 'png'
            ? await png.run((decodePng) => decodePng(input))
            : await webpDecode.run((decodeWebp) => decodeWebp(bytes));
      return { data: image.data as Uint8ClampedArray, width: image.width, height: image.height };
    } catch (e) {
      if (isInputError(e)) throw new InvalidImageError(`Cannot decode ${header.format} image`, { cause: e });
      throw e;
    }
  }

  // Lands on the same dimensions regardless of orientation: the longer side is min(size, longest).
  function targetSize(width: number, height: number, size: number): { width: number; height: number } {
    const longest = Math.max(width, height);
    if (size >= longest) return { width, height };
    const scale = size / longest;
    return {
      width: width >= height ? size : Math.max(1, Math.round(width * scale)),
      height: height > width ? size : Math.max(1, Math.round(height * scale)),
    };
  }

  return {
    impl: 'wasm',
    async process(input, sizes) {
      const header = readHeader(input);
      if (header.width * header.height > maxPixels) {
        throw new InvalidImageError(
          `Image is ${header.width}x${header.height}, above the ${maxPixels / 1_000_000} megapixel limit`,
        );
      }
      const orientation = readOrientation(input, header.format);
      let source = await decode(input, header);
      if (source.width * source.height > maxPixels)
        throw new InvalidImageError('Image exceeds the pixel limit');

      // Resizing before rotating gives the same pixels as the reverse order but rotates the small result,
      // which saves a full-size copy. Targets are computed in the upright frame and mapped back for the resize.
      const swap = swapsAxes(orientation);
      const uprightW = swap ? source.height : source.width;
      const uprightH = swap ? source.width : source.height;

      const wanted = [...new Set(sizes)].sort((a, b) => b - a);
      const encoded = new Map<number, Uint8Array>();
      for (const size of wanted) {
        const t = targetSize(uprightW, uprightH, size);
        const dw = swap ? t.height : t.width;
        const dh = swap ? t.width : t.height;
        let pixels = source;
        if (dw !== source.width || dh !== source.height) {
          // Chain from the previous (larger) result; it is the new source for the smaller sizes.
          const out = await resizer.run((resize) =>
            resize(pixels as unknown as ImageData, {
              width: dw,
              height: dh,
              method: 'catrom',
              premultiply: true,
              linearRGB: false,
            }),
          );
          pixels = { data: out.data as Uint8ClampedArray, width: out.width, height: out.height };
          source = pixels;
        }
        const upright = applyOrientation(pixels, orientation);
        const body = new Uint8Array(
          await webpEncode.run((encode) => encode(upright as unknown as ImageData, { quality })),
        );
        encoded.set(size, body);
      }

      return {
        width: uprightW,
        height: uprightH,
        variants: sizes.map((size) => {
          const body = encoded.get(size) as Uint8Array;
          return { size, body, bytes: body.byteLength };
        }),
      };
    },
  };
}
