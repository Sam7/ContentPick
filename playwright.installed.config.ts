import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/native',
  testMatch: '**/installed-smoke.spec.ts',
  outputDir: process.env.CONTEXTPICK_PLAYWRIGHT_OUTPUT_DIR ?? 'test-results',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: { trace: 'retain-on-failure' },
});
