import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'adapter-aws', include: ['test/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
});
