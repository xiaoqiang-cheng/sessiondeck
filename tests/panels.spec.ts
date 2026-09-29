import { test } from './fixtures';
import { expect, type APIRequestContext, type Locator } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppState, Session } from '../shared/types';

async function mutate<T>(request: APIRequestContext, path: string, body: unknown = {}, method = 'POST'): Promise<T> {
  const { csrfToken } = await (await request.get('/api/config')).json();
  const response = await request.fetch(`/api${path}`, { method, data: body, headers: { 'X-SessionDeck-Token': csrfToken, Origin: 'http://127.0.0.1:4337' } });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<T>;
}
async function command(pane: Locator, text: string) {
  const input = pane.locator('textarea.xterm-helper-textarea');
  await input.focus();
  await input.pressSequentially(text);
  await input.press('Enter');
}

test('bottom terminal runs real shell commands, isolates split shells and survives hide/reload', async ({ page, request }) => {
  const initial = await (await request.get('/api/shells')).json() as { id: string }[];
  const existing = new Set(initial.map(item => item.id));
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '打开终端', exact: true }).click();
    const dock = page.getByRole('region', { name: '底部终端面板' });
    await expect(dock).toBeVisible();
    await expect(dock.locator('.terminal-connection.connected')).toHaveCount(1);
    await command(dock, `SD_TEST_VALUE=first; printf 'SHELL_RESULT:%s\\n' "$((6 * 7))"`);
    await expect(dock.locator('.xterm-accessibility-tree')).toContainText('SHELL_RESULT:42');
    await dock.getByRole('button', { name: '终端分屏', exact: true }).click();
    await expect(dock.locator('.terminal-dock-pane')).toHaveCount(2);
    await expect(dock.locator('.terminal-connection.connected')).toHaveCount(2);
    await command(dock.locator('.terminal-dock-pane').first(), `printf 'SECOND_VALUE:%s\\n' "\${SD_TEST_VALUE:-empty}"`);
    await expect(dock.locator('.terminal-dock-pane').first().locator('.xterm-accessibility-tree')).toContainText('SECOND_VALUE:empty');
    await dock.getByRole('button', { name: '关闭终端分屏', exact: true }).click();
    await dock.getByRole('button', { name: '隐藏终端面板', exact: true }).click();
    await expect(dock).not.toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '打开终端', exact: true }).click();
    await expect(dock.locator('.terminal-dock-tab')).toHaveCount(2);
    await dock.getByRole('tab').first().click();
    await expect(dock.locator('.terminal-connection.connected')).toHaveCount(1);
    await command(dock, `printf 'RESTORED:%s\\n' "$SD_TEST_VALUE"`);
    await expect(dock.locator('.xterm-accessibility-tree')).toContainText('RESTORED:first');
    await command(dock, 'sleep 30');
    await dock.locator('textarea.xterm-helper-textarea').press('Control+c');
    await command(dock, `printf 'INTERRUPTED:%s\\n' "$((2 + 3))"`);
    await expect(dock.locator('.xterm-accessibility-tree')).toContainText('INTERRUPTED:5');
    await page.screenshot({ path: 'artifacts/shell-terminal.png' });
    await dock.locator('.terminal-dock-tab-close').first().click();
    await expect(dock.locator('.terminal-dock-tab')).toHaveCount(1);
    await expect.poll(async () => ((await (await request.get('/api/shells')).json()) as { id: string }[]).filter(item => !existing.has(item.id)).length).toBe(1);
  } finally {
    const shells = await (await request.get('/api/shells')).json() as { id: string }[];
    for (const shell of shells.filter(item => !existing.has(item.id))) await mutate(request, `/shells/${shell.id}`, undefined, 'DELETE');
  }
});

test('workspace sidebar renders markdown and real git diff without blocking the session header', async ({ page, request }) => {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-panels-'));
  const git = (args: string[]) => promisify(execFile)('git', args, { cwd: root });
  try {
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'README.md'), '# Sidebar preview\n\n**Rendered text**\n');
    await writeFile(join(root, 'docs', 'note.md'), '# Note\n');
    await git(['init', '-q']); await git(['add', '.']);
    await git(['-c', 'user.name=Panel test', '-c', 'user.email=panel@example.invalid', 'commit', '-qm', 'Initial']);
    await writeFile(join(root, 'README.md'), '# Sidebar preview\n\n**Updated content**\n');
    const session = await mutate<Session>(request, '/sessions', { backend: 'codex', title: '文件侧栏验收', cwd: root });
    await page.goto('/');
    await page.getByRole('button', { name: `进入 ${session.title} 的会话`, exact: true }).click();
    const drawer = page.getByRole('dialog', { name: `${session.title} 的私聊` });
    await drawer.getByRole('button', { name: '资源管理器', exact: true }).click();
    const explorer = page.getByRole('complementary', { name: '资源管理器' });
    await explorer.getByRole('button', { name: /README\.md/ }).click();
    await expect(explorer.locator('.workspace-preview .chat-markdown h1')).toHaveText('Sidebar preview');
    await explorer.getByRole('button', { name: 'Git diff', exact: true }).click();
    await explorer.getByRole('button', { name: /README\.md/ }).click();
    await expect(explorer.locator('.workspace-diff')).toContainText('+**Updated content**');
    await page.screenshot({ path: 'artifacts/workspace-sidebar.png' });
    await drawer.getByRole('button', { name: '关闭会话', exact: true }).click();
    await expect(drawer).not.toBeVisible();
    await expect(page.getByLabel('资源管理器工作区', { exact: true })).toHaveValue(session.id);
    await page.getByRole('button', { name: '关闭资源管理器', exact: true }).click();
    await page.getByRole('button', { name: '打开资源管理器', exact: true }).click();
    await expect(explorer).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/workspace-mobile.png' });
    await expect(page.getByRole('button', { name: '关闭资源管理器', exact: true })).toBeInViewport();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('opening a shell from a contact uses its directory and is immediately interactive', async ({ page, request }) => {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-shell-cwd-'));
  const initial = await (await request.get('/api/shells')).json() as { id: string }[];
  const existing = new Set(initial.map(item => item.id));
  try {
    const session = await mutate<Session>(request, '/sessions', { backend: 'codex', title: '独立 Shell 验收', cwd: root });
    await page.goto('/');
    await page.getByRole('button', { name: '打开终端', exact: true }).click();
    await expect(page.locator('.terminal-connection.connected')).toHaveCount(1);
    await page.getByRole('button', { name: '隐藏终端面板', exact: true }).click();
    await page.getByRole('button', { name: `进入 ${session.title} 的会话`, exact: true }).click();
    await page.getByRole('button', { name: '终端面板', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    const dock = page.getByRole('region', { name: '底部终端面板' });
    await expect(dock.locator('.terminal-connection.connected')).toHaveCount(1);
    await expect(dock.locator('.terminal-dock-tab')).toHaveCount(2);
    await command(dock, 'pwd');
    await expect(dock.locator('.xterm-accessibility-tree')).toContainText(root);
    await command(dock, 'exit');
    await expect(dock).toContainText('已退出');
  } finally {
    const shells = await (await request.get('/api/shells')).json() as { id: string }[];
    for (const shell of shells.filter(item => !existing.has(item.id))) await mutate(request, `/shells/${shell.id}`, undefined, 'DELETE');
    await rm(root, { recursive: true, force: true });
  }
});


test('notification sounds work without system notification permission and respect mute', async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json() as AppState;
  const session = state.sessions.find(item => !item.archived)!;
  await page.addInitScript(() => {
    const target = window as unknown as { panelSource: EventTarget; tones: number; resumes: number };
    target.tones = 0; target.resumes = 0;
    class AudioStub {
      state = 'suspended'; currentTime = 0; destination = {};
      resume() { this.state = 'running'; target.resumes++; return Promise.resolve(); }
      close() { return Promise.resolve(); }
      createOscillator() { const parameter = { setValueAtTime() {}, exponentialRampToValueAtTime() {} }; return { frequency: parameter, connect() {}, disconnect() {}, start() { target.tones++; }, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    }
    class StateSource extends EventTarget {
      onopen: (() => void) | null = null;
      constructor() { super(); target.panelSource = this; queueMicrotask(() => this.onopen?.()); }
      close() {}
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: AudioStub });
    Object.defineProperty(window, 'Notification', { configurable: true, value: undefined });
    Object.defineProperty(window, 'EventSource', { configurable: true, value: StateSource });
  });
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '关闭提示音', exact: true })).toBeVisible();
  await page.getByLabel('搜索联系人', { exact: true }).click();
  session.status = 'waiting_input'; session.unread++;
  const publish = () => page.evaluate(snapshot => (window as unknown as { panelSource: EventTarget }).panelSource.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(snapshot) })), state);
  await publish(); await publish();
  await expect.poll(() => page.evaluate(() => (window as unknown as { tones: number }).tones)).toBe(1);
  await page.getByRole('button', { name: '关闭提示音', exact: true }).click();
  session.unread++;
  await publish();
  expect(await page.evaluate(() => (window as unknown as { tones: number }).tones)).toBe(1);
  await page.reload();
  await expect(page.getByRole('button', { name: '开启提示音', exact: true })).toBeVisible();
});

test('a slow shell creation follows the latest contact directory and reconnect preserves typing focus', async ({ page, request }) => {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-shell-race-'));
  const initial = await (await request.get('/api/shells')).json() as { id: string }[];
  const existing = new Set(initial.map(item => item.id));
  let releaseFirst = () => {};
  const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
  let firstSpawned = false;
  try {
    const secondCwd = join(root, 'second'); await mkdir(secondCwd);
    const first = await mutate<Session>(request, '/sessions', { backend: 'codex', title: '迟到 Shell 来源', cwd: root });
    const second = await mutate<Session>(request, '/sessions', { backend: 'codex', title: '最新 Shell 工作区', cwd: secondCwd });
    await page.addInitScript(() => {
      const Native = window.WebSocket;
      const sockets: WebSocket[] = [];
      Object.assign(window, { panelSockets: sockets });
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (String(url).includes('/api/shells/')) sockets.push(this);
        }
      };
    });
    await page.route('**/api/shells', async route => {
      if (route.request().method() !== 'POST' || route.request().postDataJSON()?.sessionId !== first.id) return route.continue();
      const response = await route.fetch(); firstSpawned = true;
      await firstResponse;
      await route.fulfill({ response });
    });
    await page.goto('/');
    await page.getByRole('button', { name: `进入 ${first.title} 的会话`, exact: true }).click();
    await page.getByRole('button', { name: '终端面板', exact: true }).click();
    await expect.poll(() => firstSpawned).toBe(true);
    await page.getByRole('button', { name: `进入 ${second.title} 的会话`, exact: true }).click();
    await page.getByRole('button', { name: '终端面板', exact: true }).click();
    releaseFirst();
    const dock = page.getByRole('region', { name: '底部终端面板' });
    await expect(dock.locator('.terminal-dock-pane-heading')).toHaveText(secondCwd);
    await expect(dock.locator('.terminal-connection.connected')).toHaveCount(1);
    await command(dock, `printf 'CWD_RESULT:%s\\n' "$PWD"`);
    await expect(dock.locator('.xterm-accessibility-tree')).toContainText(`CWD_RESULT:${secondCwd}`);
    const search = page.getByLabel('搜索联系人', { exact: true });
    await search.fill('正在编辑');
    const count = await page.evaluate(() => {
      const sockets = (window as unknown as { panelSockets: WebSocket[] }).panelSockets;
      for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close(4001, 'reconnect test');
      return sockets.length;
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { panelSockets: WebSocket[] }).panelSockets.length)).toBeGreaterThan(count);
    await expect(dock.locator('.terminal-connection.connected')).toHaveCount(1);
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('正在编辑');
  } finally {
    releaseFirst();
    const shells = await (await request.get('/api/shells')).json() as { id: string }[];
    for (const shell of shells.filter(item => !existing.has(item.id))) await mutate(request, `/shells/${shell.id}`, undefined, 'DELETE');
    await rm(root, { recursive: true, force: true });
  }
});
