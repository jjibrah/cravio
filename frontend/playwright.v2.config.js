// Read-only v2 checks against already-running v2 servers (no webServer: this never starts or seeds anything).
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: /v2-.*\.spec\.js$/,
  timeout: 45000,
  expect: { timeout: 10000 },
  workers: 1,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], baseURL: process.env.V2_BASE_URL || 'http://localhost:5174', trace: 'off' },
});
