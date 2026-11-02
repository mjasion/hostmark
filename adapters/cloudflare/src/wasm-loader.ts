import type { WasmLoader } from '@hostmark/image';
// Static imports: wrangler (and Miniflare) hand out a precompiled WebAssembly.Module for a `.wasm` import. Workers
// forbids compiling from bytes at runtime, so this is the only way to get the codecs in.
import jpegDec from '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm';
// @ts-expect-error The package ships a .wasm.d.ts with named exports only; the bundler hands out the module as default.
import pngDec from '@jsquash/png/codec/pkg/squoosh_png_bg.wasm';
// @ts-expect-error Same as above.
import resizeWasm from '@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm';
import webpDec from '@jsquash/webp/codec/dec/webp_dec.wasm';
import webpEnc from '@jsquash/webp/codec/enc/webp_enc.wasm';
import webpEncSimd from '@jsquash/webp/codec/enc/webp_enc_simd.wasm';

export const workersLoader: WasmLoader = {
  jpegDecoder: () => jpegDec,
  pngDecoder: () => pngDec,
  webpDecoder: () => webpDec,
  webpEncoder: (simd) => (simd ? webpEncSimd : webpEnc),
  resize: () => resizeWasm,
};
