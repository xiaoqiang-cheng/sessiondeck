import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testPortValue = process.env.SESSIONDECK_TEST_PORT?.trim() || '4337';
const testPort = Number(testPortValue);
if (!/^\d+$/.test(testPortValue) || !Number.isInteger(testPort) || testPort < 1024 || testPort > 65535 || testPort === 4317) {
  throw new Error('SESSIONDECK_TEST_PORT 必须是 1024–65535 的端口号，且不能使用 SessionDeck 默认端口 4317');
}
const baseURL = `http://127.0.0.1:${testPort}`;
const testRoot = mkdtempSync(join(tmpdir(), 'sessiondeck-web-'));
const clientDir = join(testRoot, 'client');
const dataDir = join(testRoot, 'data');

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: { baseURL, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: 'artifacts/playwright',
  webServer: {
    // Build into a throwaway client directory so a browser run cannot empty or
    // replace assets served by a developer's already-running SessionDeck.
    command: 'npm run build && npm start',
    url: `${baseURL}/api/state`,
    env: {
      SESSIONDECK_DEMO: '1',
      HOST: '127.0.0.1',
      SESSIONDECK_HOST: '127.0.0.1',
      PORT: String(testPort),
      SESSIONDECK_PORT: String(testPort),
      SESSIONDECK_DATA_DIR: dataDir,
      SESSIONDECK_CLIENT_DIR: clientDir,
      // The authenticated remote listener, reached directly instead of through a tunnel.
      SESSIONDECK_REMOTE_PORT: String(testPort + 1),
    },
    reuseExistingServer: false,
  },
});
