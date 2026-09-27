import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'browser-extension', 'src-tauri', 'src/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/test/**',
        'src/lib/i18n/**',
      ],
      thresholds: {
        // Global floor guards against wholesale regressions. UI-heavy layers
        // (dialogs/pages/components) are exercised by Playwright e2e specs
        // (see playwright.config.ts) rather than unit tests, so the meaningful
        // gates are the per-directory thresholds below.
        lines: 15,
        functions: 15,
        branches: 8,
        statements: 15,
        // Pure-logic layers are unit-tested; keep them enforced at healthy levels.
        'src/utils/**': { lines: 70, functions: 60, branches: 60, statements: 70 },
        'src/store/**': { lines: 50, functions: 60, branches: 25, statements: 50 },
        'src/api/**': { lines: 25, functions: 20, branches: 10, statements: 25 },
        'src/hooks/**': { lines: 25, functions: 30, branches: 0, statements: 25 },
      },
    },
  },
});
