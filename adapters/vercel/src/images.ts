import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ImageProcessor } from '@hostmark/core/ports';
import { createWasmImageProcessor, type WasmLoader } from '@hostmark/image';

/** Where `scripts/build.ts` copies the codecs: next to the bundles, in `dist/wasm/` (shipped by `includeFiles`). */
const compile = async (file: string) =>
  WebAssembly.compile(await readFile(fileURLToPath(new URL(`./wasm/${file}`, import.meta.url))));

/** The bundled functions have no `node_modules` of their own, so the codecs travel with the bundle (as on AWS). */
export const bundleLoader: WasmLoader = {
  jpegDecoder: () => compile('mozjpeg_dec.wasm'),
  pngDecoder: () => compile('squoosh_png_bg.wasm'),
  webpDecoder: () => compile('webp_dec.wasm'),
  webpEncoder: (simd) => compile(simd ? 'webp_enc_simd.wasm' : 'webp_enc.wasm'),
  resize: () => compile('squoosh_resize_bg.wasm'),
};

let processor: ImageProcessor | undefined;

/**
 * One per function instance. `loader` is for tests, which run from source and read the codecs from node_modules.
 * Whether the plan's memory fits a 50 MP image (D31) is not measured.
 */
export function getImageProcessor(loader: WasmLoader = bundleLoader): ImageProcessor {
  processor ??= createWasmImageProcessor(loader);
  return processor;
}
