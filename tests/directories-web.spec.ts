import { expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppState } from '../shared/types';
import { test } from './fixtures';

test('create and Fork accept copied directory links containing spaces and Chinese characters', async ({ page, request }) => {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-browser-links-'));
  const project = join(root, '项目 工作区 #1');
  const forkDirectory = join(root, '另一个 分支目录');
  try {
    await mkdir(project); await mkdir(forkDirectory);
    await page.goto('/');
    await page.getByRole('button', { name: '新建联系人', exact: true }).click();
    const create = page.getByRole('dialog', { name: '新建会话联系人', exact: true });
    await create.getByLabel('联系人名称').fill('目录链接创建验收');
    await create.getByRole('button', { name: /Codex/ }).click();
    await create.getByLabel('工作目录', { exact: true }).fill(pathToFileURL(project).href);
    await create.getByRole('button', { name: '创建联系人', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '目录链接创建验收 的私聊', exact: true })).toBeVisible();
    const afterCreate = await (await request.get('/api/state')).json() as AppState;
    expect(afterCreate.sessions.find(session => session.title === '目录链接创建验收')?.cwd).toBe(project);
    await page.getByRole('button', { name: '关闭会话', exact: true }).click();
    await page.getByRole('button', { name: 'SessionDeck · 开发笔记 的更多操作', exact: true }).click();
    await page.getByRole('button', { name: 'Fork 会话', exact: true }).click();
    const fork = page.getByRole('dialog', { name: 'Fork 会话', exact: true });
    await fork.getByLabel('联系人名称').fill('目录链接 Fork 验收');
    await fork.getByLabel('新的工作目录', { exact: true }).fill(pathToFileURL(forkDirectory).href);
    await fork.getByRole('button', { name: '创建 Fork', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '目录链接 Fork 验收 的私聊', exact: true })).toBeVisible();
    const afterFork = await (await request.get('/api/state')).json() as AppState;
    expect(afterFork.sessions.find(session => session.title === '目录链接 Fork 验收')?.cwd).toBe(forkDirectory);
    expect(afterFork.sessions.find(session => session.title === 'SessionDeck · 开发笔记')?.cwd).not.toBe(forkDirectory);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('directory explorer navigates real folders, reveals hidden names, selects paths and restores its parent dialog', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-browser-explorer-'));
  const project = join(root, '中文 项目');
  try {
    await mkdir(join(project, 'src'), { recursive: true });
    await mkdir(join(project, '.配置'));
    await writeFile(join(project, 'README.txt'), 'Only directories are shown.');
    await page.goto('/');
    await page.getByRole('button', { name: '新建联系人', exact: true }).click();
    const create = page.getByRole('dialog', { name: '新建会话联系人', exact: true });
    await create.getByLabel('联系人名称').fill('浏览目录时保留的名称');
    await create.getByLabel('工作目录', { exact: true }).fill(pathToFileURL(root).href);
    const browse = create.getByRole('button', { name: '浏览工作目录', exact: true });
    await browse.click();
    const picker = page.getByRole('dialog', { name: '选择工作目录', exact: true });
    await expect(picker.locator('.directory-current code')).toHaveText(root);
    await expect(page.locator('.modal[aria-label="新建会话联系人"]')).toHaveAttribute('inert', '');
    await picker.getByRole('button', { name: '中文 项目', exact: true }).click();
    await expect(picker.locator('.directory-current code')).toHaveText(project);
    await expect(picker.getByRole('button', { name: '.配置', exact: true })).toHaveCount(0);
    await expect(picker.getByRole('button', { name: 'README.txt', exact: true })).toHaveCount(0);
    await picker.getByRole('checkbox', { name: '显示隐藏目录', exact: true }).check();
    await expect(picker.getByRole('button', { name: '.配置', exact: true })).toBeVisible();
    await picker.getByLabel('筛选文件夹', { exact: true }).fill('src');
    await expect(picker.getByRole('button', { name: '.配置', exact: true })).toHaveCount(0);
    await picker.getByRole('button', { name: 'src', exact: true }).click();
    await expect(picker.locator('.directory-current code')).toHaveText(join(project, 'src'));
    await picker.getByRole('button', { name: '上一级', exact: true }).click();
    await expect(picker.locator('.directory-current code')).toHaveText(project);
    await picker.getByRole('button', { name: '选择此目录', exact: true }).click();
    await expect(picker).not.toBeVisible();
    await expect(create.getByLabel('工作目录', { exact: true })).toHaveValue(project);
    await expect(create.getByLabel('联系人名称')).toHaveValue('浏览目录时保留的名称');
    await expect(browse).toBeFocused();

    await browse.click();
    await expect(picker.getByLabel('目录路径', { exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(picker).not.toBeVisible();
    await expect(create).toBeVisible();
    await expect(browse).toBeFocused();

    await browse.click();
    await expect(picker.locator('.directory-current code')).toHaveText(project);
    await picker.getByLabel('目录路径', { exact: true }).fill(join(root, '不存在'));
    await picker.getByLabel('目录路径', { exact: true }).press('Enter');
    await expect(picker.getByRole('alert')).toContainText('目录不存在');
    await expect(create).toHaveAttribute('inert', ''); // The parent stays suspended while recovery is possible.
    await picker.getByLabel('目录路径', { exact: true }).fill(pathToFileURL(join(project, 'src')).href);
    await picker.getByRole('button', { name: '选择此目录', exact: true }).click();
    await expect(picker).not.toBeVisible();
    await expect(create.getByLabel('工作目录', { exact: true })).toHaveValue(join(project, 'src'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('card directory copy keeps the card closed with modern clipboard and the HTTP LAN fallback', async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json() as AppState;
  const source = state.sessions.find(session => session.title === 'SessionDeck · 开发笔记')!;
  await page.goto('/');
  const copy = page.getByRole('button', { name: `复制 ${source.title} 的工作目录`, exact: true });
  for (const mode of ['modern', 'unavailable', 'denied'] as const) {
    await page.evaluate(mode => {
      const state = window as unknown as { copiedDirectory: string | null; copyMethod: string | null };
      state.copiedDirectory = null; state.copyMethod = null;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'unavailable' ? undefined : { writeText: async (value: string) => {
        if (mode === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
        state.copiedDirectory = value; state.copyMethod = 'modern';
      } } });
      document.execCommand = command => {
        if (command !== 'copy') return false;
        const field = document.activeElement;
        if (!(field instanceof HTMLTextAreaElement)) return false;
        state.copiedDirectory = field.value.slice(field.selectionStart, field.selectionEnd); state.copyMethod = 'fallback';
        return true;
      };
    }, mode);
    await copy.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { copiedDirectory: string | null }).copiedDirectory)).toBe(source.cwd);
    expect(await page.evaluate(() => (window as unknown as { copyMethod: string | null }).copyMethod)).toBe(mode === 'modern' ? 'modern' : 'fallback');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: '已复制工作目录' })).toBeVisible();
    await expect(copy).toBeFocused();
    expect(await page.locator('textarea').count()).toBe(0);
  }
});

test('directory explorer fits a 390px viewport with long folder names and paths', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-browser-mobile-'));
  const project = join(root, '这是一个包含空格的 工作目录 用来检查小屏幕下完整路径换行');
  try {
    await mkdir(project);
    await mkdir(join(project, '很长的子目录名字 用来检查目录资源管理器不发生横向溢出'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: '新建联系人', exact: true }).click();
    const create = page.getByRole('dialog', { name: '新建会话联系人', exact: true });
    await create.getByLabel('工作目录', { exact: true }).fill(project);
    await create.getByRole('button', { name: '浏览工作目录', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '选择工作目录', exact: true });
    await expect(picker.locator('.directory-current code')).toHaveText(project);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await picker.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const bounds = await picker.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await expect(picker.getByRole('button', { name: '选择此目录', exact: true })).toBeVisible();
    await page.screenshot({ path: 'artifacts/directory-picker-mobile.png', animations: 'disabled' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('contact cards expose and search the latest prompt without overflowing narrow layouts', async ({ page, request }) => {
  const seed = await (await request.get('/api/state')).json() as AppState;
  const latestPrompt = `请检查只有输入内容才包含的关键词「目录验收索引」并保留上下文。${'这是较长的一段用户输入，用来确认卡片节选保留完整提示并正常换行。'.repeat(12)}`;
  const contact = { ...seed.sessions.find(session => session.title === 'SessionDeck · 开发笔记')!, lastUserInput: latestPrompt, lastUserInputAt: new Date().toISOString() };
  const state = { ...seed, sessions: seed.sessions.map(session => session.id === contact.id ? contact : session) };
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: `retry: 60000\nevent: state\ndata: ${JSON.stringify(state)}\n\n` }));
  await page.goto('/');
  await page.getByLabel('搜索联系人', { exact: true }).fill('目录验收索引');
  await expect(page.locator('.session-card')).toHaveCount(1);
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: contact.title, exact: true }) });
  await expect(card.locator('.card-prompt p')).toHaveText(latestPrompt);
  await expect(card.locator('.card-prompt p')).toHaveAttribute('title', latestPrompt);
  await expect(card.getByText('最近输入', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/card-latest-input-mobile.png', animations: 'disabled' });
});

test('a delayed directory response preserves a newer pasted path until the user selects it', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-browser-directory-race-'));
  const project = join(root, '响应期间粘贴的新目录');
  let release = () => {};
  try {
    await mkdir(project);
    let requests = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/directories/list', async route => {
      if (++requests === 1) await held;
      await route.continue();
    });
    await page.goto('/');
    await page.getByRole('button', { name: '新建联系人', exact: true }).click();
    const create = page.getByRole('dialog', { name: '新建会话联系人', exact: true });
    await create.getByLabel('工作目录', { exact: true }).fill(root);
    await create.getByRole('button', { name: '浏览工作目录', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '选择工作目录', exact: true });
    await expect.poll(() => requests).toBe(1);
    await picker.getByLabel('目录路径', { exact: true }).fill(pathToFileURL(project).href);
    release();
    await expect(picker.locator('.directory-current code')).toHaveText(root);
    await expect(picker.getByLabel('目录路径', { exact: true })).toHaveValue(pathToFileURL(project).href);
    await picker.getByRole('button', { name: '选择此目录', exact: true }).click();
    await expect(picker).not.toBeVisible();
    await expect(create.getByLabel('工作目录', { exact: true })).toHaveValue(project);
  } finally { release(); await rm(root, { recursive: true, force: true }); }
});
