import { defineConfig } from '@playwright/test';

// Runs against ?mock=1 only, in the installed Chrome, so no browser download is needed.
export default defineConfig({
  testDir: 'tests',
  testMatch: 'smoke.spec.mjs',
  timeout: 30000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:4173',
    channel: 'chrome',
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    command: 'npm start',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
  },
});
