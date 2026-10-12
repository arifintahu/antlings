import { defineConfig } from '@playwright/test';

const PORT = 3199;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 8000 },
  workers: 1, // tests share one server and one set of credentials
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    channel: 'chrome', // the installed Chrome; avoids a browser download
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @antlings/server exec tsx src/e2e/server.ts',
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_PORT: String(PORT), E2E_STATIC: '../web/dist' },
  },
});
