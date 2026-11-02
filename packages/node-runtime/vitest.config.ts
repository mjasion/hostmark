import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'node-runtime', include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
