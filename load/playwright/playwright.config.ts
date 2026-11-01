import { defineConfig } from '@playwright/test';

// Browser scenarios S10 and S13. The target comes from BASE_URL only; run.mjs starts this inside the Playwright image.
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30 * 60_000,
  reporter: [['list']],
  outputDir: '/tmp/hostmark-load-pw',
  use: {
    baseURL: (process.env.BASE_URL ?? 'http://127.0.0.1:58080').replace(/\/+$/, ''),
    headless: true,
  },
});
