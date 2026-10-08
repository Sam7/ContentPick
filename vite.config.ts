import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/target/**', '**/.tools/**', '**/src-tauri/**', '**/crates/**'] },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
    exclude: ['tests/e2e/**', 'tests/native/**', 'node_modules/**', 'dist/**'],
  },
});
