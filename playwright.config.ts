import { defineConfig, devices } from '@playwright/test';

// Test-only token accepted exclusively by a daemon started with --integration.
// It is intentionally not used by desktop or production daemon processes.
const integrationApiToken = 'nova-e2e-integration-token-2026';

export default defineConfig({
  testDir: './src/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'html',
  use: {
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'NOVA_DAEMON_PORT=3199 cargo run --locked --manifest-path src-tauri/Cargo.toml -- --integration',
      env: { ...process.env, NOVA_INTEGRATION_API_TOKEN: integrationApiToken },
      url: 'http://127.0.0.1:3199/api/health',
      reuseExistingServer: !process.env.CI,
      // A clean release-tag runner compiles the Rust/Tauri daemon before the
      // health endpoint exists; its first build routinely exceeds two minutes.
      timeout: 600000,
    },
    {
      command: 'pnpm run dev',
      env: { ...process.env, VITE_NOVA_API_TOKEN: integrationApiToken },
      url: 'http://127.0.0.1:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
  ],
});
