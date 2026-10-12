import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/native',
  outputDir: process.env.CONTEXTPICK_PLAYWRIGHT_OUTPUT_DIR ?? 'test-results',
  testMatch: '**/*.spec.ts',
  testIgnore: ['**/*.scale.spec.ts', '**/installed-smoke.spec.ts'],
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: { trace: 'retain-on-failure' },
  // Installed-package tests exercise the embedded frontend; only debug builds need Vite.
  webServer: process.env.CONTEXTPICK_NATIVE_EXECUTABLE?.trim() ? undefined : {
    command: 'corepack pnpm dev:web --host 127.0.0.1 --port 1420 --strictPort',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
