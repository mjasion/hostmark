import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'adapter-cloudflare',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/build.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
