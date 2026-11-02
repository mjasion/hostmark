import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'adapter-vps', include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
