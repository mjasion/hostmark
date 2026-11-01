import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**'],
    setupFiles: ['test/setup.ts'],
  },
});
