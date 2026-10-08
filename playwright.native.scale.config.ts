import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/native',
  testMatch: '**/*.scale.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 900_000,
  expect: { timeout: 30_000 },
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'corepack pnpm dev:web --host 127.0.0.1 --port 1420 --strictPort',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
