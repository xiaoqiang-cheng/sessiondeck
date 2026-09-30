import { test as demoTest } from './fixtures';
import { expect, test as baseTest } from '@playwright/test';
import type { AppState, Session } from '../shared/types';
import { Buffer } from 'node:buffer';

async function openDemoCodex(page: import('@playwright/test').Page, title = 'SessionDeck · 开发笔记') {
  await page.goto('/');
  await page.getByRole('button', { name: `进入 ${title} 的会话`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: `${title} 的私聊` })).toBeVisible();
  await expect(page.getByRole('button', { name: '原生终端', exact: true })).toHaveAttribute('aria-pressed', 'true');
}

demoTest('demo terminal keeps ordinary text paste available to the native terminal', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openDemoCodex(page);
  await page.getByRole('button', { name: /^(?:启动|恢复)原生会话$/ }).click();
  await expect(page.locator('.terminal-connection')).toHaveText('已连接');
  const pasteWasNotCancelled = await page.locator('.terminal-pane').evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'ordinary paste survives image handling');
    let reachedBubble = false;
    element.addEventListener('paste', event => { reachedBubble = !event.defaultPrevented; }, { once: true });
    const dispatched = element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    return dispatched && reachedBubble;
  });
  expect(pasteWasNotCancelled).toBe(true);
  await expect(page.getByRole('button', { name: '选择图片并填入原生输入' })).toHaveCount(0);
  await expect(page.locator('.terminal-image-input')).toHaveCount(0);
});

demoTest('demo Codex contacts never expose the native image bridge', async ({ page }) => {
  await openDemoCodex(page);
  await expect(page.getByRole('button', { name: '选择图片并填入原生输入' })).toHaveCount(0);
  await expect(page.locator('.terminal-image-input')).toHaveCount(0);
});

baseTest('real Codex native terminals expose image upload with the active PTY generation', async ({ page }) => {
  const seed = await (await page.request.get('/api/state')).json() as AppState;
  const source = seed.sessions.find(session => session.backend === 'codex');
  expect(source).toBeTruthy();
  const contact: Session = {
    ...(source as Session), id: 'codex-image-browser-test', title: 'Codex 图片桥接回归',
    running: true, status: 'idle', statusSource: 'process', statusDetail: '可继续',
    interactionMode: 'terminal', nativeSessionId: 'native-image-test', forkPending: false,
  };
  const state: AppState = {
    ...seed, demo: false, sessions: [contact], groups: [], activities: [],
    backends: seed.backends.map(backend => backend.id === 'codex'
      ? { ...backend, installed: true, capabilities: { ...backend.capabilities, terminal: true, nativeControl: true, graphicalChat: false } }
      : backend),
  };
  const upload: { headers: Record<string, string>; body: Buffer | null } = { headers: {}, body: null };
  await page.addInitScript(() => {
    const target = window as unknown as { terminalSockets: unknown[] };
    target.terminalSockets = [];
    class FakeSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = FakeSocket.OPEN;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      constructor(url: string | URL) {
        super(); this.url = String(url); target.terminalSockets.push(this);
        queueMicrotask(() => {
          this.onopen?.(new Event('open'));
          this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'ready', terminalId: 'test-generation' }) }));
        });
      }
      send(_data: string) {}
      close() { this.readyState = FakeSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: FakeSocket });
    class FakeSource extends EventTarget {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); }
      close() {}
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: FakeSource });
  });
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route('**/api/config', route => route.fulfill({ json: { csrfToken: 'browser-image-token' } }));
  await page.route(`**/api/sessions/${contact.id}/read`, route => route.fulfill({ json: contact }));
  await page.route(`**/api/sessions/${contact.id}/terminal/image`, async route => {
    upload.headers = route.request().headers();
    upload.body = route.request().postDataBuffer();
    await route.fulfill({ json: { staged: true } });
  });
  await page.goto(`/#/contacts?session=${contact.id}`);
  await expect(page.getByRole('dialog', { name: `${contact.title} 的私聊` })).toBeVisible();
  await expect(page.locator('.terminal-connection')).toHaveText('已连接');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  await page.locator('.terminal-image-input').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: image });
  await expect(page.locator('.terminal-image-status')).toContainText('图片已填入原生输入');
  expect(upload.headers['content-type']).toBe('image/png');
  expect(upload.headers['x-sessiondeck-terminal']).toBe('test-generation');
  expect(upload.headers['x-sessiondeck-token']).toBe('browser-image-token');
  expect(upload.body).toEqual(image);
});
