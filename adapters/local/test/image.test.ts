import { describeImageProcessorContract } from '@hostmark/core/test/contract';
import { createWasmImageProcessor } from '@hostmark/image';
import { nodeLoader } from '@hostmark/image/node';
import { makeJpeg } from './fixtures';

// Needs no services, so it always runs: it proves the Node loader finds the .wasm files from this package.
describeImageProcessorContract('wasm + node loader', async () => ({
  processor: createWasmImageProcessor(nodeLoader),
  fixtures: {
    large: await makeJpeg(2400, 1800),
    small: await makeJpeg(64, 48),
    withMetadata: await makeJpeg(800, 600, 6),
    rotated: { body: await makeJpeg(800, 600, 6), width: 800, height: 600, orientation: 6 },
  },
}));
