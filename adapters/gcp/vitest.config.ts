import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'adapter-gcp', include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 60_000 },
});
