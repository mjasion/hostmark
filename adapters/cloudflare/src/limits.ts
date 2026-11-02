/**
 * Decoded pixel ceiling of the image processor on Workers (D31 is 50 MP elsewhere). Workers gives an isolate 128 MB
 * for the whole JavaScript heap and the WebAssembly memory together. `pnpm measure:pixels` (see the README) measures
 * the WebAssembly memory the codecs hold in workerd: about 23 bytes per pixel, 13 MB at 0.25 MP, 42 MB at 1.5 MP,
 * 51 MB at 1.9 MP, then a step to 106 MB at 2 MP and 340 MB at 12 MP. Local workerd does not enforce the 128 MB, so
 * the limit is derived from those numbers and not proven in production (D103): 1.5 MP keeps the wasm memory under
 * 45 MB and leaves room for the JavaScript heap and the uncollected garbage of a warm isolate.
 */
export const WORKERS_MAX_PIXELS = 1_500_000;
