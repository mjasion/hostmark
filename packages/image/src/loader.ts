type Compiled = WebAssembly.Module | Promise<WebAssembly.Module>;

/**
 * Supplies compiled WebAssembly modules for the jSquash codecs. Platforms differ in how modules are obtained
 * (Workers forbids compiling from bytes at runtime and hands out precompiled modules for static `.wasm`
 * imports), so the processor never loads bytes itself. Each method is called at most once per codec, when the
 * codec is first needed.
 *
 * A Cloudflare Workers loader maps to these package files, imported statically as `*.wasm`:
 *   jpegDecoder  @jsquash/jpeg/codec/dec/mozjpeg_dec.wasm
 *   pngDecoder   @jsquash/png/codec/pkg/squoosh_png_bg.wasm
 *   webpDecoder  @jsquash/webp/codec/dec/webp_dec.wasm
 *   webpEncoder  @jsquash/webp/codec/enc/webp_enc_simd.wasm when `simd` is true, else webp_enc.wasm
 *   resize       @jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm
 * The SIMD and non-SIMD encoders are different binaries and the module handed back must match `simd`.
 */
export interface WasmLoader {
  jpegDecoder(): Compiled;
  pngDecoder(): Compiled;
  webpDecoder(): Compiled;
  webpEncoder(simd: boolean): Compiled;
  resize(): Compiled;
}
