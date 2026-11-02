import { type ImageProcessor, InvalidImageError } from '@hostmark/core/ports';
import { createWasmImageProcessor } from '@hostmark/image';
import { WORKERS_MAX_PIXELS } from '../../src/limits';
import { workersLoader } from '../../src/wasm-loader';

// The image processor of the adapter behind HTTP, so that Node tests can drive it inside workerd.
//   POST /process?sizes=128,512,1600[&maxPixels=n]   body: the image
// Answers JSON; an undecodable image is a 422 like the domain error.
const processors = new Map<number, ImageProcessor>();

// Measuring aid for scripts/measure-pixels.mjs: every WebAssembly memory the codecs create, however they instantiate.
// Wasm memory only grows, so its size after a call is the high-water mark the isolate keeps for good.
const memories = new Set<WebAssembly.Memory>();
const track = (instance: WebAssembly.Instance | undefined) => {
  if (!instance?.exports) return;
  for (const value of Object.values(instance.exports))
    if (value instanceof WebAssembly.Memory) memories.add(value);
};
const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (...args: unknown[]) => Promise<unknown>;
const wasm = WebAssembly as unknown as Record<string, unknown>;
wasm.instantiate = async (...args: unknown[]) => {
  const result = await instantiate(...args);
  track(((result as { instance?: WebAssembly.Instance }).instance ?? result) as WebAssembly.Instance);
  return result;
};

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sizes = (url.searchParams.get('sizes') ?? '128').split(',').map(Number);
    const maxPixels = Number(url.searchParams.get('maxPixels') ?? WORKERS_MAX_PIXELS);
    let processor = processors.get(maxPixels);
    if (!processor) {
      processor = createWasmImageProcessor(workersLoader, { maxPixels });
      processors.set(maxPixels, processor);
    }
    const input = new Uint8Array(await request.arrayBuffer());
    try {
      const out = await processor.process(input, sizes);
      return Response.json({
        wasmMemoryBytes: [...memories].map((m) => m.buffer.byteLength),
        width: out.width,
        height: out.height,
        variants: out.variants.map((v) => ({
          size: v.size,
          bytes: v.bytes,
          body: Buffer.from(v.body).toString('base64'),
        })),
      });
    } catch (e) {
      if (e instanceof InvalidImageError) return Response.json({ invalid: e.message }, { status: 422 });
      return Response.json({ error: String(e) }, { status: 500 });
    }
  },
} satisfies ExportedHandler;
