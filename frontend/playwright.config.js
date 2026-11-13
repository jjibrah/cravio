import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 45000,
  expect: { timeout: 10000 },
  workers: 1,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:5173', trace: 'off' },
  webServer: {
    command: 'npm run dev',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
});
