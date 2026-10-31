import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { WasmLoader } from './loader';

const require = createRequire(import.meta.url);

const compile = async (pkg: string, file: string): Promise<WebAssembly.Module> => {
  const root = dirname(require.resolve(`${pkg}/package.json`));
  return WebAssembly.compile(await readFile(join(root, file)));
};

/** Reads the `.wasm` files from the installed @jsquash packages. */
export const nodeLoader: WasmLoader = {
  jpegDecoder: () => compile('@jsquash/jpeg', 'codec/dec/mozjpeg_dec.wasm'),
  pngDecoder: () => compile('@jsquash/png', 'codec/pkg/squoosh_png_bg.wasm'),
  webpDecoder: () => compile('@jsquash/webp', 'codec/dec/webp_dec.wasm'),
  webpEncoder: (simd) =>
    compile('@jsquash/webp', simd ? 'codec/enc/webp_enc_simd.wasm' : 'codec/enc/webp_enc.wasm'),
  resize: () => compile('@jsquash/resize', 'lib/resize/pkg/squoosh_resize_bg.wasm'),
};
