import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ImageProcessor } from '@hostmark/core/ports';
import { createWasmImageProcessor, type WasmLoader } from '@hostmark/image';

/** Where `build.mjs` copies the codecs: next to the bundle, in `wasm/`. */
const compile = async (file: string) =>
  WebAssembly.compile(await readFile(fileURLToPath(new URL(`./wasm/${file}`, import.meta.url))));

/** Lambda can compile from bytes (unlike Workers) but has no node_modules, so the files travel with the bundle. */
export const lambdaLoader: WasmLoader = {
  jpegDecoder: () => compile('mozjpeg_dec.wasm'),
  pngDecoder: () => compile('squoosh_png_bg.wasm'),
  webpDecoder: () => compile('webp_dec.wasm'),
  webpEncoder: (simd) => compile(simd ? 'webp_enc_simd.wasm' : 'webp_enc.wasm'),
  resize: () => compile('squoosh_resize_bg.wasm'),
};

let processor: ImageProcessor | undefined;

/**
 * One per execution environment: compiled modules are kept between invocations. The pixel limit stays D31's 50 MP.
 * `loader` is for tests, which run from source and read the codecs from node_modules.
 */
export function getImageProcessor(loader: WasmLoader = lambdaLoader): ImageProcessor {
  processor ??= createWasmImageProcessor(loader);
  return processor;
}
