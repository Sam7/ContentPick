import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  cacheDir: process.env.CONTEXTPICK_VITE_CACHE_DIR || undefined,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/target/**', '**/.tools/**', '**/src-tauri/**', '**/crates/**'] },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
    exclude: ['tests/e2e/**', 'tests/native/**/*.spec.ts', 'node_modules/**', 'dist/**'],
  },
});
