import { defineConfig } from '@playwright/test';

// Runs against the compose stack (adapters/local), which must already be up. See adapters/local/README.md.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:58080',
    trace: 'retain-on-failure',
  },
});
