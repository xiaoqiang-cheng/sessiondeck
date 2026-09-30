import { mutationHeaders, test } from './fixtures';
import { expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('contacts, native terminal, fork and directed group collaboration work in the browser', async ({ page }) => {
  const errors: string[] = [];
  const terminalOutput: string[] = [];
  page.on('websocket', socket => { if (socket.url().includes('/api/terminal/')) socket.on('framereceived', ({ payload }) => { const message = JSON.parse(String(payload)); if (message.type === 'data') terminalOutput.push(message.data); }); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '会话联系人', exact: true })).toBeVisible();
  await expect(page.getByText('演示模式 · 示例数据')).toBeVisible();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/contacts.png', fullPage: true });

  await page.getByRole('button', { name: '新建联系人', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建会话联系人' });
  await create.getByLabel('联系人名称').fill('浏览器验收联系人');
  await create.getByRole('button', { name: /Codex/ }).click();
  await create.getByRole('button', { name: '创建联系人', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '浏览器验收联系人 的私聊' })).toBeVisible();
  // Opening a contact starts its native session without a second click.
  await expect(page.getByRole('button', { name: '停止进程', exact: true })).toBeVisible();
  await expect(page.locator('.terminal-connection')).toHaveText('已连接');
  await page.locator('.xterm-helper-textarea').pressSequentially('private correction');
  await page.locator('.xterm-helper-textarea').press('Enter');
  await expect.poll(() => terminalOutput.join('')).toContain('private correction');
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();

  await page.getByRole('button', { name: '浏览器验收联系人 的更多操作' }).click();
  await page.getByRole('button', { name: '改名', exact: true }).click();
  await page.getByRole('dialog').getByLabel('联系人名称').fill('浏览器验收 · 已改名');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: '浏览器验收 · 已改名', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '创建群组', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('群组名称').fill('浏览器协作验收');
  await page.getByRole('dialog').getByLabel('共同目标').fill('验证联系人 Fork、单独纠正与结果共享。');
  await page.getByRole('dialog').getByRole('button', { name: '创建群组', exact: true }).click();
  await page.getByRole('button', { name: '添加成员', exact: true }).first().click();
  await page.getByRole('button', { name: '从已有联系人 Fork', exact: true }).click();
  await page.getByLabel('来源联系人').selectOption({ label: 'SessionDeck · 开发笔记 · Codex' });
  await page.getByRole('dialog').getByLabel('联系人名称').fill('群组实现成员');
  await page.getByRole('button', { name: 'Fork 入群', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '群组实现成员 的私聊' })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止进程', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await page.getByRole('button', { name: '分配任务', exact: true }).click();
  await page.locator('.recipient-picker').getByRole('button', { name: /群组实现成员/ }).click();
  await page.getByLabel('群组消息').fill('请验证卡片改名，保留原始联系人。');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByText('请验证卡片改名，保留原始联系人。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '填入会话', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '群组实现成员 的私聊' })).toBeVisible();
  await page.locator('.xterm-helper-textarea').press('Enter');
  await page.getByRole('button', { name: '分享结果到群组', exact: true }).click();
  await page.getByRole('dialog').getByLabel('分享内容').fill('已确认：原始联系人保留，群内成员可独立纠正。');
  await page.getByRole('button', { name: '分享到群组', exact: true }).click();
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await expect(page.getByText('已确认：原始联系人保留，群内成员可独立纠正。', { exact: true })).toBeVisible();
  await expect(page.getByText('已填入 · 在私聊按回车发送')).toBeVisible();
  await page.screenshot({ path: 'artifacts/group.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('mobile layout keeps contacts and navigation usable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '会话联系人', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
});

async function createTestGroup(page: import('@playwright/test').Page, title: string) {
  const headers = await mutationHeaders(page.request);
  const response = await page.request.post('/api/groups', { data: { title, goal: '浏览器交互回归' }, headers });
  expect(response.ok()).toBeTruthy();
  return await response.json() as { id: string; title: string };
}

async function openGroup(page: import('@playwright/test').Page, title: string) {
  await page.getByRole('navigation', { name: '协作群组', exact: true }).getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByLabel('群组消息')).toBeVisible();
}

test('keyboard navigation keeps modal focus, leaves the workbench interactive, and preserves native terminal Escape', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '会话联系人', exact: true })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByLabel('搜索联系人', { exact: true })).toBeFocused();
  const createButton = page.getByRole('button', { name: '新建联系人', exact: true });
  await createButton.click();
  const create = page.getByRole('dialog', { name: '新建会话联系人' });
  await expect(create.getByLabel('联系人名称')).toBeFocused();
  await create.getByRole('button', { name: '创建联系人', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(create.getByRole('button', { name: '关闭', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(create).not.toBeVisible();
  await expect(createButton).toBeFocused();

  const card = page.getByRole('button', { name: '进入 SessionDeck · 开发笔记 的会话', exact: true });
  await card.click();
  const drawer = page.getByRole('dialog', { name: 'SessionDeck · 开发笔记 的私聊' });
  await expect(drawer).toBeVisible();
  // The session replaces the card grid in the workbench (other sessions are
  // tabs); it is not a modal, so navigation and the terminal dock stay usable.
  await expect(page.locator('main')).not.toHaveAttribute('inert');
  await expect(page.locator('main')).toBeHidden();
  await expect(drawer).toHaveAttribute('aria-modal', 'false');
  await expect(drawer.getByRole('tab', { name: /SessionDeck · 开发笔记/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByLabel('原生会话终端输入').focus();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: '改名', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '给联系人改个名字' });
  await expect(drawer).toHaveAttribute('inert', '');
  await expect(rename.getByLabel('联系人名称')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(rename).not.toBeVisible();
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: '关闭会话', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(card).toBeFocused();
});

test('group drafts survive navigation and reload, and failed sends preserve the text', async ({ page }) => {
  const first = await createTestGroup(page, '草稿回归甲');
  await createTestGroup(page, '草稿回归乙');
  await page.goto('/');
  await openGroup(page, '草稿回归甲');
  await page.getByLabel('群组消息').fill('这段草稿需要在导航与刷新后保留。');
  await openGroup(page, '草稿回归乙');
  await expect(page.getByLabel('群组消息')).toHaveValue('');
  await page.getByLabel('群组消息').fill('另一个群组的独立草稿。');
  await openGroup(page, '草稿回归甲');
  await expect(page.getByLabel('群组消息')).toHaveValue('这段草稿需要在导航与刷新后保留。');
  await page.reload();
  await openGroup(page, '草稿回归甲');
  await expect(page.getByLabel('群组消息')).toHaveValue('这段草稿需要在导航与刷新后保留。');

  await page.route(`**/api/groups/${first.id}/messages`, route => route.fulfill({ status: 503, contentType: 'text/plain', body: 'temporary failure' }));
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('本地服务暂时无法处理请求 (503)');
  await expect(page.getByLabel('群组消息')).toHaveValue('这段草稿需要在导航与刷新后保留。');
  await page.unroute(`**/api/groups/${first.id}/messages`);
  await page.getByLabel('群组消息').press('Control+Enter');
  await expect(page.getByText('这段草稿需要在导航与刷新后保留。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('群组消息')).toHaveValue('');
  await openGroup(page, '草稿回归乙');
  await expect(page.getByLabel('群组消息')).toHaveValue('另一个群组的独立草稿。');
  await openGroup(page, '草稿回归甲');
  await expect(page.getByLabel('群组消息')).toHaveValue('');
});

test('group history failures have their own retry without losing the workspace', async ({ page }) => {
  const group = await createTestGroup(page, '加载恢复回归');
  await page.route(`**/api/groups/${group.id}`, route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '临时读取失败' }) }));
  await page.goto('/');
  await page.getByRole('navigation', { name: '协作群组', exact: true }).getByRole('button', { name: /加载恢复回归/ }).click();
  await expect(page.getByRole('alert')).toContainText('群组动态加载失败：临时读取失败');
  await expect(page.getByRole('heading', { name: '加载恢复回归' })).toBeVisible();
  await page.unroute(`**/api/groups/${group.id}`);
  await page.getByRole('button', { name: '重试群组动态', exact: true }).click();
  await expect(page.getByLabel('群组消息')).toBeVisible();
  await expect(page.getByRole('alert')).not.toBeVisible();
});

test('mobile navigation and the dialog stay usable at narrow widths', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/');
  await page.getByRole('navigation', { name: '工作空间导航' }).getByRole('button', { name: '正在运行', exact: true }).click();
  await expect(page.getByRole('heading', { name: '正在运行', exact: true })).toBeVisible();
  await expect(page.getByText('目前没有正在执行的任务')).toBeVisible();
  await page.getByRole('button', { name: '新建联系人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建会话联系人' });
  await expect(dialog.getByLabel('联系人名称')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '协作群组', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test('session bookmarks reload the same private context and browser history restores routes without starting a process', async ({ page }) => {
  const startRequests: string[] = [];
  page.on('request', request => { if (/\/api\/sessions\/[^/]+\/start$/.test(request.url())) startRequests.push(request.url()); });
  await page.goto('/');
  await expect(page).toHaveURL(/#\/contacts$/);
  await page.getByRole('button', { name: '进入 SessionDeck · 开发笔记 的会话', exact: true }).click();
  const bookmark = page.url();
  expect(bookmark).toMatch(/#\/contacts\?session=[\w-]+$/);
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'SessionDeck · 开发笔记 的私聊' })).toBeVisible();
  await expect(page).toHaveURL(bookmark);
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await expect(page).toHaveURL(/#\/contacts$/);
  await page.goBack();
  await expect(page.getByRole('dialog', { name: 'SessionDeck · 开发笔记 的私聊' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page).toHaveURL(/#\/contacts$/);
  await page.goForward();
  await expect(page.getByRole('dialog', { name: 'SessionDeck · 开发笔记 的私聊' })).toBeVisible();
  // The demo contact is already running, so even the card click has nothing
  // to start; reloads and history never launch an agent.
  expect(startRequests).toEqual([]);
});

test('group bookmarks preserve members and unknown route IDs recover without trapping the workspace', async ({ page }) => {
  await page.goto('/');
  await openGroup(page, '登录体验优化');
  await page.getByRole('button', { name: '进入 梳理登录流程 的会话', exact: true }).click();
  const bookmark = page.url();
  expect(bookmark).toMatch(/#\/groups\/[\w-]+\?session=[\w-]+$/);
  await page.reload();
  await expect(page.getByRole('dialog', { name: '梳理登录流程 的私聊' })).toBeVisible();
  await page.getByRole('navigation', { name: '会话关系' }).getByRole('button', { name: '登录体验优化', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page).toHaveURL(/#\/groups\/[\w-]+$/);
  await expect(page.getByRole('heading', { name: '登录体验优化' })).toBeVisible();

  await page.goto('/#/groups/missing-group?session=missing-session');
  await expect(page).toHaveURL(/#\/contacts$/);
  await expect(page.getByText('链接中的联系人已不存在，已返回会话列表')).toBeVisible();
  await expect(page.getByRole('button', { name: '新建联系人', exact: true })).toBeEnabled();
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
  await page.goto('/#/groups/%E0%A4%A?session=%20');
  await expect(page).toHaveURL(/#\/contacts$/);
  await expect(page.getByRole('heading', { name: '会话联系人', exact: true })).toBeVisible();
});

test('session info copies native identity and workspace path, with links back to the fork source', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('button', { name: '进入 SessionDeck · 开发笔记 的会话', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'SessionDeck · 开发笔记 的私聊' });
  await drawer.getByRole('button', { name: '复制工作目录', exact: true }).click();
  const state = await (await page.request.get('/api/state')).json();
  const source = state.sessions.find((session: { title: string }) => session.title === 'SessionDeck · 开发笔记');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(source.cwd);
  await drawer.locator('summary').filter({ hasText: '会话信息' }).click();
  await drawer.getByRole('button', { name: '复制原生会话标识', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(source.nativeSessionId);
  await drawer.getByRole('button', { name: '复制会话链接', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
  await page.screenshot({ path: 'artifacts/session-info.png', fullPage: true });
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();

  const headers = await mutationHeaders(page.request);
  const fork = await (await page.request.post(`/api/sessions/${source.id}/fork`, { data: { title: '来源链接回归' }, headers })).json();
  await page.goto(`/#/contacts?session=${fork.id}`);
  await expect(page.getByRole('dialog', { name: '来源链接回归 的私聊' })).toBeVisible();
  await page.getByRole('navigation', { name: '会话关系' }).getByRole('button', { name: '来源：SessionDeck · 开发笔记', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'SessionDeck · 开发笔记 的私聊' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`session=${source.id}$`));
});

test('activity timeline filters events and opens the related session through a restorable route', async ({ page }) => {
  const headers = await mutationHeaders(page.request);
  const state = await (await page.request.get('/api/state')).json();
  const response = await page.request.post('/api/sessions', { data: { title: '活动入口回归', backend: 'codex', cwd: state.defaultCwd }, headers });
  expect(response.ok()).toBeTruthy();
  await page.goto('/#/activity');
  await expect(page.getByRole('heading', { name: '最近活动', exact: true })).toBeVisible();
  await page.getByLabel('搜索活动').fill('活动入口回归');
  await expect(page.getByText('创建了 活动入口回归', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/activity.png', fullPage: true });
  await page.getByRole('button', { name: '活动入口回归', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '活动入口回归 的私聊' })).toBeVisible();
  await expect(page).toHaveURL(/#\/activity\?session=[\w-]+$/);
  await page.reload();
  await expect(page.getByRole('dialog', { name: '活动入口回归 的私聊' })).toBeVisible();
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await expect(page.getByRole('heading', { name: '最近活动', exact: true })).toBeVisible();
  await page.getByLabel('搜索活动').fill('没有这个活动 xyz');
  await expect(page.getByRole('heading', { name: '没有匹配的活动' })).toBeVisible();
});

async function mockWorkspace(page: import('@playwright/test').Page, change: (state: import('../shared/types').AppState) => void) {
  const state = await (await page.request.get('/api/state')).json() as import('../shared/types').AppState;
  change(state);
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: `retry: 60000\nevent: state\ndata: ${JSON.stringify(state)}\n\n` }));
  return state;
}

test('contact sorting and filters persist across reload with separate filters for each view', async ({ page }) => {
  await mockWorkspace(page, state => {
    const source = state.sessions[0];
    state.sessions = [
      { ...source, id: 'sort-pinned', title: 'Z 排序置顶', backend: 'codex', groupId: null, pinned: true, archived: false, status: 'idle', createdAt: '2026-01-01T00:00:00Z', lastActivity: '2026-01-01T00:00:00Z' },
      { ...source, id: 'sort-a', title: 'A 排序联系人', backend: 'codex', groupId: null, pinned: false, archived: false, status: 'idle', createdAt: '2026-01-02T00:00:00Z', lastActivity: '2026-01-04T00:00:00Z' },
      { ...source, id: 'sort-b', title: 'B 排序联系人', backend: 'codex', groupId: null, pinned: false, archived: false, status: 'idle', createdAt: '2026-01-03T00:00:00Z', lastActivity: '2026-01-02T00:00:00Z' },
      { ...source, id: 'sort-other', title: '其他后端', backend: 'claude', groupId: null, pinned: false, archived: false, status: 'idle' },
    ];
  });
  await page.goto('/');
  await page.getByLabel('搜索联系人', { exact: true }).fill('排序');
  await page.getByRole('button', { name: '筛选与排序', exact: true }).click();
  await page.locator('.backend-tabs').getByRole('button', { name: 'Codex', exact: true }).click();
  await page.getByLabel('按状态筛选').selectOption('idle');
  await page.getByLabel('联系人排序').selectOption('name');
  await expect(page.locator('.session-card h3')).toHaveText(['Z 排序置顶', 'A 排序联系人', 'B 排序联系人']);
  await page.getByLabel('联系人排序').selectOption('created');
  await expect(page.locator('.session-card h3')).toHaveText(['Z 排序置顶', 'B 排序联系人', 'A 排序联系人']);
  await page.reload();
  await page.getByRole('button', { name: '筛选与排序', exact: true }).click();
  await expect(page.getByLabel('联系人排序')).toHaveValue('created');
  await expect(page.getByLabel('搜索联系人', { exact: true })).toHaveValue('排序');
  await expect(page.getByLabel('按状态筛选')).toHaveValue('idle');
  await expect(page.locator('.backend-tabs').getByRole('button', { name: 'Codex', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await page.getByRole('navigation', { name: '工作空间导航' }).getByRole('button', { name: '需要你处理', exact: true }).click();
  await expect(page.getByLabel('搜索联系人', { exact: true })).toHaveValue('');
  await page.getByRole('navigation', { name: '工作空间导航' }).getByRole('button', { name: /会话联系人/ }).click();
  await expect(page.getByLabel('搜索联系人', { exact: true })).toHaveValue('排序');
  await page.getByLabel('搜索联系人', { exact: true }).fill('查无结果 xyz');
  await expect(page.getByText('没有找到匹配的联系人')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(page.locator('.session-card')).toHaveCount(4);
  await page.reload();
  await expect(page.getByLabel('搜索联系人', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '筛选与排序', exact: true }).click();
  await expect(page.getByLabel('按状态筛选')).toHaveValue('all');
});

test('keyboard help is discoverable and workspace shortcuts do not steal typing focus', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '使用说明与快捷键', exact: true }).click();
  const help = page.getByRole('dialog', { name: '使用说明与快捷键' });
  await expect(help.getByText('如何理解状态', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('main').click({ position: { x: 5, y: 400 } });
  await page.keyboard.press('?');
  await expect(help).toBeVisible();
  await help.getByRole('button', { name: '知道了', exact: true }).click();
  const search = page.getByLabel('搜索联系人', { exact: true });
  await search.focus();
  await page.keyboard.press('?');
  await expect(help).not.toBeVisible();
  await expect(search).toHaveValue('?');
  await search.fill('');
  await openGroup(page, '登录体验优化');
  const composer = page.getByLabel('群组消息');
  await composer.fill('正在编辑群组内容');
  await composer.press('Control+k');
  await expect(composer).toBeFocused();
  await composer.press('?');
  await expect(help).not.toBeVisible();
  await expect(composer).toBeFocused();
});

test('first contact guidance offers import and backend setup when no tools are installed', async ({ page }) => {
  await mockWorkspace(page, state => {
    state.sessions = []; state.groups = []; state.activities = [];
    state.backends = state.backends.map(backend => ({ ...backend, installed: false, version: null }));
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '还没有联系人' })).toBeVisible();
  await expect(page.getByText(/尚未检测到本机 Agent/)).toBeVisible();
  await page.getByRole('button', { name: '导入已有会话', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '导入已有会话' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '查看后端安装情况', exact: true }).click();
  await expect(page.getByRole('heading', { name: '连接与能力', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建 Claude 联系人', exact: true })).toBeDisabled();
});

test('many cards and long names, paths and group titles remain within desktop and mobile viewports', async ({ page }) => {
  const longTitle = '联系人' + 'very-long-continuous-name-'.repeat(4);
  const longGroup = '跨后端协作群组' + '持续迭代与验证'.repeat(15);
  const state = await mockWorkspace(page, state => {
    const source = state.sessions[0];
    state.sessions = Array.from({ length: 72 }, (_, index) => ({ ...source, id: `layout-${index}`, title: `${index} ${longTitle}`, groupId: null, archived: false, pinned: index === 0, cwd: `/workspace/${'long-directory-segment'.repeat(30)}`, statusDetail: '正在处理' + 'long-unbroken-status'.repeat(20) }));
    state.groups = [{ ...state.groups[0], id: 'long-group', title: longGroup, goal: 'group-goal-without-spaces'.repeat(40) }];
  });
  await page.route('**/api/groups/long-group', route => route.fulfill({ json: { group: state.groups[0], messages: [], deliveries: [] } }));
  await page.goto('/');
  await expect(page.locator('.session-card')).toHaveCount(72);
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    expect(await page.locator('.session-card h3').first().evaluate(element => element.clientHeight < 60)).toBeTruthy();
  }
  await page.screenshot({ path: 'artifacts/long-contacts-mobile.png', animations: 'disabled' });
  await page.getByRole('navigation', { name: '协作群组', exact: true }).getByRole('button', { name: new RegExp(longGroup) }).click();
  await expect(page.getByLabel('群组消息')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test('unrelated session updates do not reload group history, while group revisions and reconnection do', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        (window as unknown as { testEventSource: EventSource }).testEventSource = this;
      }
    };
  });
  const group = await createTestGroup(page, '动态刷新回归');
  let historyRequests = 0;
  await page.route(url => url.pathname === `/api/groups/${group.id}`, async route => { historyRequests++; await route.continue(); });
  await page.goto('/');
  await openGroup(page, '动态刷新回归');
  const initial = historyRequests;
  const state = await (await page.request.get('/api/state')).json() as import('../shared/types').AppState;
  for (let index = 0; index < 4; index++) {
    state.sessions[0].statusDetail = `与群组无关的会话输出 ${index}`;
    await page.evaluate(data => {
      (window as unknown as { testEventSource: EventSource }).testEventSource.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(data) }));
    }, state);
  }
  await page.getByLabel('群组消息').fill('让无关事件完成渲染');
  expect(historyRequests).toBe(initial);
  const target = state.groups.find(item => item.id === group.id)!;
  target.updatedAt = new Date(Date.parse(target.updatedAt) + 1000).toISOString();
  await page.evaluate(data => {
    (window as unknown as { testEventSource: EventSource }).testEventSource.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(data) }));
  }, state);
  await expect.poll(() => historyRequests).toBe(initial + 1);
  await page.evaluate(() => (window as unknown as { testEventSource: EventSource }).testEventSource.dispatchEvent(new Event('open')));
  await expect.poll(() => historyRequests).toBeGreaterThan(initial + 1);
  await expect(page.getByLabel('群组消息')).toHaveValue('让无关事件完成渲染');
});

test('group messages become editable directed tasks with persistent source and explicit draft replacement', async ({ page }) => {
  const group = await createTestGroup(page, '群组转交回归');
  const headers = await mutationHeaders(page.request);
  const state = await (await page.request.get('/api/state')).json();
  const memberResponse = await page.request.post('/api/sessions', { data: { title: '转交来源成员', backend: 'codex', cwd: state.defaultCwd, groupId: group.id }, headers });
  expect(memberResponse.ok()).toBeTruthy();
  const member = await memberResponse.json();
  const sourceResponse = await page.request.post(`/api/groups/${group.id}/messages`, { data: { text: '原始成员结果：先验证边界条件。', kind: 'result', senderId: member.id }, headers });
  expect(sourceResponse.ok()).toBeTruthy();
  const source = await sourceResponse.json();
  let automaticDeliveryRequests = 0;
  page.on('request', request => { if (/\/api\/(?:deliveries\/[^/]+\/send|sessions\/[^/]+\/start)$/.test(request.url())) automaticDeliveryRequests++; });
  await page.goto(`/#/groups/${group.id}`);
  const original = page.locator(`#group-message-${source.id}`);
  await expect(original).toContainText('原始成员结果：先验证边界条件。');
  const composer = page.getByLabel('群组消息');
  await composer.fill('必须保留的已有草稿');
  await original.getByRole('button', { name: '转交为任务', exact: true }).click();
  const replacement = page.getByRole('dialog', { name: '替换当前群组草稿？' });
  await expect(replacement.getByText('必须保留的已有草稿', { exact: true })).toBeVisible();
  await replacement.getByRole('button', { name: '保留当前草稿', exact: true }).click();
  await expect(composer).toHaveValue('必须保留的已有草稿');
  await original.getByRole('button', { name: '转交为任务', exact: true }).click();
  await replacement.getByRole('button', { name: '替换为转交任务', exact: true }).click();
  await expect(composer).toHaveValue(source.text);
  await expect(page.locator('.composer-source')).toContainText('转交来源成员');
  await composer.fill(`${source.text}\n请补充失败重试测试。`);
  await page.locator('.recipient-picker').getByRole('button', { name: /转交来源成员/ }).click();
  await page.reload();
  await expect(composer).toHaveValue(`${source.text}\n请补充失败重试测试。`);
  await expect(page.locator('.composer-source')).toContainText('转交来源成员');
  await expect(page.locator('.recipient-picker').getByRole('button', { name: /转交来源成员/ })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.composer-source').getByRole('button', { name: /查看原消息/ }).click();
  await expect(original).toBeFocused();
  await page.getByRole('button', { name: '解除转交来源', exact: true }).click();
  await expect(page.locator('.composer-source')).not.toBeVisible();
  await expect(composer).toHaveValue(`${source.text}\n请补充失败重试测试。`);
  await original.getByRole('button', { name: '转交为任务', exact: true }).click();
  await replacement.getByRole('button', { name: '替换为转交任务', exact: true }).click();
  await page.locator('.recipient-picker').getByRole('button', { name: /转交来源成员/ }).click();
  await composer.fill(`${source.text}\n请由你完成第二轮验证。`);
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  const task = page.locator('.group-message.kind-task').filter({ hasText: '第二轮验证' });
  await expect(task).toBeVisible();
  await expect(task.locator('.message-source-link')).toContainText('转交来源成员');
  await task.locator('.message-source-link').click();
  await expect(original).toBeFocused();
  const detail = await (await page.request.get(`/api/groups/${group.id}`)).json() as import('../shared/types').GroupDetail;
  expect(detail.messages).toHaveLength(2);
  expect(detail.messages[1].sourceMessageId).toBe(source.id);
  expect(detail.deliveries).toHaveLength(1);
  expect(detail.deliveries[0].status).toBe('pending');
  expect(automaticDeliveryRequests).toBe(0);
  await expect(composer).toHaveValue('');
  await expect(page.locator('.composer-source')).not.toBeVisible();
  await page.screenshot({ path: 'artifacts/group-handoff.png', fullPage: true, animations: 'disabled' });
});

test('execution filters distinguish an attached idle process from an active task, and unread filters retain reminders', async ({ page }) => {
  await mockWorkspace(page, state => {
    const seed = state.sessions[0];
    state.sessions = [
      { ...seed, id: 'idle-connected', title: '已连接但空闲', groupId: null, archived: false, pinned: false, running: true, status: 'idle', unread: 0 },
      { ...seed, id: 'active-task', title: '真正执行任务', groupId: null, archived: false, pinned: false, running: true, status: 'running', unread: 0 },
      { ...seed, id: 'unread-contact', title: '保留未读提醒', groupId: null, archived: false, pinned: false, running: false, status: 'idle', unread: 2 },
    ];
  });
  await page.goto('/#/running');
  await expect(page.locator('.session-card h3')).toHaveText(['真正执行任务']);
  await page.getByRole('navigation', { name: '工作空间导航' }).getByRole('button', { name: /会话联系人/ }).click();
  await page.getByRole('button', { name: '筛选与排序', exact: true }).click();
  await page.getByLabel('按状态筛选').selectOption('unread');
  await expect(page.locator('.session-card h3')).toHaveText(['保留未读提醒']);
  await page.reload();
  await page.getByRole('button', { name: '筛选与排序', exact: true }).click();
  await expect(page.getByLabel('按状态筛选')).toHaveValue('unread');
  await expect(page.locator('.session-card h3')).toHaveText(['保留未读提醒']);
});

test('card actions are reachable with keyboard and menu direction keys open a rename dialog', async ({ page }) => {
  await page.goto('/');
  const card = page.getByRole('button', { name: '进入 SessionDeck · 开发笔记 的会话', exact: true });
  await card.focus();
  expect(await card.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'SessionDeck · 开发笔记 的私聊' });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(':focus')).toHaveCount(1);
  await drawer.getByRole('button', { name: '关闭会话', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(card).toBeFocused();
  const menu = page.getByRole('button', { name: 'SessionDeck · 开发笔记 的更多操作', exact: true });
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '改名', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: '取消置顶', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '给联系人改个名字' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('new group members inherit the group directory, while recent paths require an explicit choice and preserve edits', async ({ page }) => {
  const state = await mockWorkspace(page, snapshot => {
    const seed = snapshot.sessions[0];
    snapshot.defaultCwd = '/default/workspace';
    snapshot.groups = [{ ...snapshot.groups[0], id: 'directory-group', title: '目录继承验收' }];
    snapshot.sessions = Array.from({ length: 8 }, (_, index) => ({ ...seed,
      id: `directory-${index}`, title: `目录成员 ${index}`, archived: false, running: false,
      cwd: index === 0 ? '/projects/group-old' : index === 1 ? '/projects/group-current' : `/projects/project-${Math.min(index, 6)}`,
      groupId: index < 2 ? 'directory-group' : null, lastActivity: `2026-09-20T10:0${index}:00.000Z`,
    }));
  });
  await page.route('**/api/groups/directory-group', route => route.fulfill({ json: { group: state.groups[0], messages: [], deliveries: [] } }));
  await page.goto('/#/groups/directory-group');
  await page.getByRole('button', { name: '添加成员', exact: true }).first().click();
  const member = page.getByRole('dialog', { name: '添加群组成员' });
  await expect(member.getByLabel('工作目录', { exact: true })).toHaveValue('/projects/group-current');
  await member.getByLabel('工作目录', { exact: true }).fill('/projects/user-edited');
  await member.getByRole('button', { name: /Codex/ }).click();
  await expect(member.getByLabel('工作目录', { exact: true })).toHaveValue('/projects/user-edited');
  await member.getByRole('button', { name: '从已有联系人 Fork', exact: true }).click();
  await member.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(member.getByLabel('工作目录', { exact: true })).toHaveValue('/projects/user-edited');
  await member.getByRole('button', { name: '取消', exact: true }).click();

  await page.getByRole('navigation', { name: '工作空间导航' }).getByRole('button', { name: /会话联系人/ }).click();
  await page.getByRole('button', { name: '新建联系人', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建会话联系人' });
  await expect(create.getByLabel('工作目录', { exact: true })).toHaveValue('/default/workspace');
  await create.getByText('最近使用的目录', { exact: true }).click();
  await expect(create.locator('.recent-directories button')).toHaveCount(5);
  await expect(create.locator('.recent-directories button')).toHaveText(['/projects/project-6', '/projects/project-5', '/projects/project-4', '/projects/project-3', '/projects/project-2']);
  await create.getByRole('button', { name: '/projects/project-5', exact: true }).click();
  await expect(create.getByLabel('工作目录', { exact: true })).toHaveValue('/projects/project-5');
  await create.getByLabel('工作目录', { exact: true }).fill('/projects/private-edit');
  await create.getByRole('button', { name: /DeepSeek/ }).click();
  await expect(create.getByLabel('工作目录', { exact: true })).toHaveValue('/projects/private-edit');
  await page.screenshot({ path: 'artifacts/recent-directories.png', fullPage: true });

  state.sessions = [];
  await page.reload();
  await page.getByRole('button', { name: '新建联系人', exact: true }).first().click();
  await expect(page.getByRole('dialog').getByLabel('工作目录', { exact: true })).toHaveValue('/default/workspace');
  await expect(page.locator('.recent-directories')).not.toBeVisible();
});
