import type { ImageProcessor } from '@hostmark/core/ports';
import { createWasmImageProcessor } from '@hostmark/image';
import { WORKERS_MAX_PIXELS } from './limits';
import { workersLoader } from './wasm-loader';

let processor: ImageProcessor | undefined;

/** One per isolate: compiled modules are kept and the codecs hold no request state. */
export function getImageProcessor(): ImageProcessor {
  processor ??= createWasmImageProcessor(workersLoader, { maxPixels: WORKERS_MAX_PIXELS });
  return processor;
}
