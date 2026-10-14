import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1, reporter: 'list', timeout: 30000,
  use: { baseURL: process.env.JPOP_TEST_BASE_URL ?? 'http://127.0.0.1:4321', browserName: 'chromium',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
    viewport: { width: 1440, height: 1100 }, trace: 'retain-on-failure' },
  webServer: process.env.JPOP_TEST_BASE_URL ? undefined : { command: 'node scripts/serve-preview.mjs', url: 'http://127.0.0.1:4321', reuseExistingServer: false, timeout: 20000 },
});
