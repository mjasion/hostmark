import { expect, it } from 'vitest';
import { processor, solid, toJpeg } from './helpers';

it('processes a 12 MP JPEG', async () => {
  const w = 4000;
  const h = 3000;
  const img = solid(w, h, [0, 0, 0, 255]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img.data[i] = (x * 255) / w;
      img.data[i + 1] = (y * 255) / h;
      img.data[i + 2] = (x ^ y) & 255;
    }
  }
  const jpeg = await toJpeg(img, 85);
  // First call includes lazy codec initialisation.
  const t0 = performance.now();
  const r = await processor.process(jpeg, [128, 512, 1600]);
  const cold = performance.now() - t0;
  const t1 = performance.now();
  await processor.process(jpeg, [128, 512, 1600]);
  const warm = performance.now() - t1;
  console.log(
    `12MP JPEG (${(jpeg.length / 1e6).toFixed(1)} MB): cold ${cold.toFixed(0)} ms, warm ${warm.toFixed(0)} ms`,
  );
  expect([r.width, r.height]).toEqual([w, h]);
}, 120_000);
