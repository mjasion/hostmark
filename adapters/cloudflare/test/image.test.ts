import { InvalidImageError } from '@hostmark/core/ports';
import { describeImageProcessorContract } from '@hostmark/core/test/contract';
import type { Miniflare } from 'miniflare';
import { afterAll, describe, expect, it } from 'vitest';
import { WORKERS_MAX_PIXELS } from '../src/limits';
import { makeJpeg } from './fixtures/jpeg';
import { remoteProcessor } from './fixtures/remote-processor';
import { builtWorker, newMiniflare } from './miniflare';

let mf: Miniflare | undefined;
afterAll(async () => {
  await mf?.dispose();
});

// The real bundle with its static wasm imports, decoding inside workerd. The contract images are larger than the
// Workers limit (D103), so this run lifts it; the next block checks that the default holds.
describeImageProcessorContract('wasm + static imports on workerd', async () => {
  mf = newMiniflare([builtWorker('image-service', { name: 'image' })]);
  await mf.ready;
  return {
    processor: remoteProcessor(mf, 50_000_000),
    fixtures: {
      large: await makeJpeg(2400, 1800),
      small: await makeJpeg(64, 48),
      withMetadata: await makeJpeg(800, 600, 6),
      rotated: { body: await makeJpeg(800, 600, 6), width: 800, height: 600, orientation: 6 },
    },
  };
});

describe('the Workers pixel limit (D103)', () => {
  it('refuses an image above WORKERS_MAX_PIXELS by its header, and accepts one below it', async () => {
    const local = newMiniflare([builtWorker('image-service', { name: 'image' })]);
    try {
      await local.ready;
      const processor = remoteProcessor(local);
      const side = Math.ceil(Math.sqrt(WORKERS_MAX_PIXELS)) + 10;
      await expect(processor.process(await makeJpeg(side, side), [128])).rejects.toBeInstanceOf(
        InvalidImageError,
      );
      const ok = await processor.process(await makeJpeg(1000, 1000), [128]);
      expect(ok.width).toBe(1000);
    } finally {
      await local.dispose();
    }
  });
});
