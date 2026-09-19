import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: { baseURL: 'http://127.0.0.1:4337', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: 'artifacts/playwright',
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:4337/api/state',
    env: { SESSIONDECK_DEMO: '1', PORT: '4337', SESSIONDECK_PORT: '4337', SESSIONDECK_DATA_DIR: mkdtempSync(join(tmpdir(), 'sessiondeck-web-')) },
    reuseExistingServer: false,
  },
});
