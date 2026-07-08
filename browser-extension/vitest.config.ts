import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['src/tests/setup-indexeddb.ts'],
    include: ['src/tests/{unit,contract,integration}/**/*.test.ts'],
    exclude: ['src/tests/e2e/**', 'node_modules/**'],
    pool: 'threads',
    fileParallelism: true,
    maxWorkers: 4,
  },
});
