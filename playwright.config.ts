import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const systemChromium = process.platform === 'linux' && existsSync('/usr/bin/chromium')
  ? '/usr/bin/chromium'
  : undefined;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1600, height: 1000 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || systemChromium,
      args: process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
    },
  },
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
