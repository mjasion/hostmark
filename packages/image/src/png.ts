// PNG decoder over the wasm-bindgen build in @jsquash/png, with its own state per instance.
//
// Source: the JavaScript glue of @jsquash/png 3.1.1 (https://github.com/jamsinclair/jSquash), Apache-2.0,
// Copyright 2023 jamsinclair. The licence text is in ../LICENSE-APACHE-2.0.
// Modified by the hostmark authors: the glue is rewritten as a factory (`createPngDecoder`) that keeps the
// instance, memory views and heap in the closure instead of module-level variables, and only the imports needed
// by `decode` are implemented. The compiled wasm module itself is used unchanged.
//
// Why: the glue shipped by jSquash keeps its instance in a module-level variable and refuses to initialise twice.
// The Rust decoder panics through `unwrap_throw` on a corrupt or truncated file without unwinding, so it
// leaks the output buffer (width x height x 4 bytes, up to 200 MB at the pixel limit) on every such file and
// the instance can never be replaced. Here each `createPngDecoder` call builds a fresh instance, so the
// processor can drop one that has failed. The module also imports a few functions for `decode_rgba16`, which must
// exist for instantiation.
//
// The import names of the wasm module carry hashes that belong to this exact build. When @jsquash/png is bumped
// (it is pinned), instantiation fails with a link error: update this file with it.

/** The decoder rejected the bytes; the instance itself is not at fault. */
export class PngInputError extends Error {}

export interface PngPixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

interface PngExports {
  memory: WebAssembly.Memory;
  decode(ptr: number, len: number): number;
  __wbindgen_malloc(size: number, align: number): number;
  __wbindgen_free(ptr: number, size: number, align: number): void;
}

export async function createPngDecoder(module: WebAssembly.Module): Promise<(png: Uint8Array) => PngPixels> {
  let exports!: PngExports;
  // Handles the module keeps for JS values. wasm-bindgen reserves the first 132 slots for constants.
  const heap = new Map<number, unknown>();
  let next = 132;
  const put = (value: unknown): number => {
    heap.set(next, value);
    return next++;
  };
  const text = new TextDecoder();

  const imports = {
    wbg: {
      __wbindgen_memory: () => put(exports.memory),
      __wbg_buffer_a448f833075b71ba: (h: number) => put((heap.get(h) as WebAssembly.Memory).buffer),
      __wbg_newwithbyteoffsetandlength_099217381c451830: (h: number, offset: number, length: number) =>
        put(new Uint16Array(heap.get(h) as ArrayBuffer, offset >>> 0, length >>> 0)),
      __wbindgen_object_drop_ref: (h: number) => {
        heap.delete(h);
      },
      __wbg_newwithownedu8clampedarrayandsh_91db5987993a08fb: (
        ptr: number,
        len: number,
        width: number,
        height: number,
      ) => {
        const data = new Uint8ClampedArray(exports.memory.buffer, ptr >>> 0, len).slice();
        exports.__wbindgen_free(ptr, len, 1);
        return put({ data, width: width >>> 0, height: height >>> 0 });
      },
      __wbindgen_throw: (ptr: number, len: number) => {
        throw new PngInputError(text.decode(new Uint8Array(exports.memory.buffer, ptr >>> 0, len)));
      },
    },
  };

  const instance = await WebAssembly.instantiate(module, imports);
  exports = instance.exports as unknown as PngExports;

  return (png) => {
    const ptr = exports.__wbindgen_malloc(png.length, 1) >>> 0;
    new Uint8Array(exports.memory.buffer).set(png, ptr);
    const handle = exports.decode(ptr, png.length);
    const pixels = heap.get(handle) as PngPixels;
    heap.delete(handle);
    return pixels;
  };
}
