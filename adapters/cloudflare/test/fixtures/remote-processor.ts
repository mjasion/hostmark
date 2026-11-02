import { type ImageProcessor, InvalidImageError } from '@hostmark/core/ports';
import type { Miniflare } from 'miniflare';

/** The ImageProcessor of this adapter as the Worker `image-service` runs it, reached over HTTP. */
export function remoteProcessor(mf: Miniflare, maxPixels?: number): ImageProcessor {
  return {
    impl: 'wasm',
    async process(input, sizes) {
      const query = new URLSearchParams({ sizes: sizes.join(',') });
      if (maxPixels) query.set('maxPixels', String(maxPixels));
      const res = await mf.dispatchFetch(`http://image/process?${query}`, { method: 'POST', body: input });
      const json = (await res.json()) as {
        width: number;
        height: number;
        variants: { size: number; bytes: number; body: string }[];
        invalid?: string;
        error?: string;
      };
      if (res.status === 422) throw new InvalidImageError(json.invalid);
      if (!res.ok) throw new Error(json.error ?? `image-service answered ${res.status}`);
      return {
        width: json.width,
        height: json.height,
        variants: json.variants.map((v) => ({
          size: v.size,
          bytes: v.bytes,
          body: new Uint8Array(Buffer.from(v.body, 'base64')),
        })),
      };
    },
  };
}
