import type { ImageProcessor } from '@hostmark/core/ports';
import { createWasmImageProcessor } from '@hostmark/image';
import { nodeLoader } from '@hostmark/image/node';

let processor: ImageProcessor | undefined;

/**
 * Reads the codecs from `node_modules` at run time, so `vercel.json` must ship them with `includeFiles`. Whether the
 * build traces them by itself, and whether the plan's memory fits a 50 MP image (D31), is not settled by the docs.
 */
export function getImageProcessor(): ImageProcessor {
  processor ??= createWasmImageProcessor(nodeLoader);
  return processor;
}
