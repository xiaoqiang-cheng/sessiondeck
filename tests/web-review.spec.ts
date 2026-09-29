import { test } from './fixtures';
import { expect, type APIRequestContext } from '@playwright/test';
import type { AppState, Delivery, Group, GroupMessage } from '../shared/types';

async function createGroup(request: APIRequestContext, baseURL: string, title: string) {
  const { csrfToken } = await (await request.get('/api/config')).json();
  const response = await request.post('/api/groups', { data: { title, goal: '' }, headers: { 'X-SessionDeck-Token': csrfToken, Origin: new URL(baseURL).origin } });
  expect(response.ok()).toBeTruthy();
  return await response.json() as Group;
}

test('a message completed after navigation clears its submitted draft and preserves a newer edit', async ({ page, request, baseURL }) => {
  const first = await createGroup(request, baseURL!, '异步发布草稿甲');
  const second = await createGroup(request, baseURL!, '异步发布草稿乙');
  let release!: () => void;
  let held = new Promise<void>(resolve => { release = resolve; });
  let intercepted = 0;
  await page.route(`**/api/groups/${first.id}/messages`, async route => { intercepted++; await held; await route.continue(); });
  await page.goto(`/#/groups/${first.id}`);
  const navigate = (title: string) => page.getByRole('navigation', { name: '协作群组', exact: true }).getByRole('button', { name: new RegExp(title) }).click();
  await page.getByLabel('群组消息').fill('第一条发布成功后应清掉原草稿');
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect.poll(() => intercepted).toBe(1);
  await navigate(second.title);
  release();
  await expect(page.getByRole('status').filter({ hasText: '已分享到群组' })).toBeVisible();
  await navigate(first.title);
  await expect(page.getByRole('article').getByText('第一条发布成功后应清掉原草稿', { exact: true })).toBeVisible();
  await expect(page.getByLabel('群组消息')).toHaveValue('');

  held = new Promise<void>(resolve => { release = resolve; });
  await page.getByLabel('群组消息').fill('第二条也会成功发布');
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect.poll(() => intercepted).toBe(2);
  await navigate(second.title);
  await navigate(first.title);
  await page.getByLabel('群组消息').fill('等待响应期间写下的下一条草稿');
  release();
  await expect(page.getByRole('article').getByText('第二条也会成功发布', { exact: true })).toBeVisible();
  await expect(page.getByLabel('群组消息')).toHaveValue('等待响应期间写下的下一条草稿');
  await page.reload();
  await expect(page.getByLabel('群组消息')).toHaveValue('等待响应期间写下的下一条草稿');
});

test('a failed Fork retains editable fields for retry, and a dismissed menu dialog restores keyboard focus', async ({ page }) => {
  await page.goto('/');
  const source = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'SessionDeck · 开发笔记', exact: true }) });
  const menu = source.getByRole('button', { name: 'SessionDeck · 开发笔记 的更多操作', exact: true });
  await menu.click();
  await page.getByRole('button', { name: '改名', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('联系人名称')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await menu.click();
  await page.getByRole('button', { name: 'Fork 会话', exact: true }).click();
  const fork = page.getByRole('dialog', { name: 'Fork 会话', exact: true });
  await fork.getByLabel('联系人名称').fill('Fork 失败后重试');
  const cwd = await fork.getByLabel('新的工作目录', { exact: true }).inputValue();
  await page.route('**/api/sessions/*/fork', route => route.fulfill({ status: 503, json: { error: '原生 Fork 暂时失败，请重试' } }));
  await fork.getByRole('button', { name: '创建 Fork', exact: true }).click();
  await expect(fork.getByRole('alert')).toHaveText('原生 Fork 暂时失败，请重试');
  await expect(fork.getByLabel('联系人名称')).toHaveValue('Fork 失败后重试');
  await expect(fork.getByLabel('新的工作目录', { exact: true })).toHaveValue(cwd);
  await page.unroute('**/api/sessions/*/fork');
  await fork.getByRole('button', { name: '创建 Fork', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Fork 失败后重试 的私聊' })).toBeVisible();
});

test('confirming a Chinese composition does not submit a group message, while the normal shortcut still publishes', async ({ page, request, baseURL }) => {
  const group = await createGroup(request, baseURL!, '中文输入快捷键验收');
  let submissions = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`/api/groups/${group.id}/messages`)) submissions++; });
  await page.goto(`/#/groups/${group.id}`);
  const composer = page.getByLabel('群组消息');
  await composer.fill('这段中文还在选择输入候选');
  await composer.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(submissions).toBe(0);
  await expect(composer).toHaveValue('这段中文还在选择输入候选');
  await composer.press('Control+Enter');
  await expect(page.getByRole('article').getByText('这段中文还在选择输入候选', { exact: true })).toBeVisible();
  await expect(composer).toHaveValue('');
  expect(submissions).toBe(1);
});

test('a thousand-message group opens recent history, reveals older sources, and preserves drafts and reading position', async ({ page, request }) => {
  const seed = await (await request.get('/api/state')).json() as AppState;
  const group = { ...seed.groups[0], id: 'history-window', title: '千条历史验收' };
  const members = Array.from({ length: 150 }, (_, index) => ({ ...seed.sessions[0], id: `history-member-${index}`, title: `历史成员 ${index}`, groupId: group.id, archived: false, running: false }));
  const state = { ...seed, groups: [group], sessions: members };
  const messages: GroupMessage[] = Array.from({ length: 1000 }, (_, index) => ({
    id: `history-${index}`, groupId: group.id, kind: 'task', text: `历史任务 ${index}：核对实现、记录结果并继续协作。`,
    senderId: null, senderName: '你', recipientIds: [members[index % members.length].id],
    sourceMessageId: index === 999 ? 'history-3' : null, createdAt: group.createdAt, sequence: index + 1, revision: Date.parse(group.updatedAt),
  }));
  const deliveries: Delivery[] = messages.map(message => ({ id: `delivery-${message.id}`, messageId: message.id, sessionId: message.recipientIds[0], text: message.text, status: 'staged', createdAt: group.createdAt, sentAt: group.createdAt }));
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: `retry: 60000\nevent: state\ndata: ${JSON.stringify(state)}\n\n` }));
  const requests: string[] = [];
  await page.route(url => url.pathname === `/api/groups/${group.id}`, route => {
    requests.push(route.request().url());
    const url = new URL(route.request().url());
    const before = Number(url.searchParams.get('before') ?? 1001);
    const matching = url.searchParams.has('since') ? [] : messages.filter(message => message.sequence! < before);
    const page = matching.slice(-200);
    return route.fulfill({ json: { group, messages: page, deliveries: deliveries.filter(delivery => page.some(message => message.id === delivery.messageId)), page: { total: 1000, before: matching.length > 200 ? page[0].sequence : null }, revision: group.updatedAt } });
  });
  await page.route(`**/api/groups/${group.id}/messages/history-3`, route => route.fulfill({ json: messages[3] }));
  await page.goto(`/#/groups/${group.id}`);
  await expect(page.locator('.group-message')).toHaveCount(200);
  await expect(page.locator('.session-card')).toHaveCount(150);
  await expect(page.locator('.history-range')).toContainText('显示第 801–1000 条，共 1000 条');
  await expect(page.locator('#group-message-history-0')).toHaveCount(0);
  const composer = page.getByLabel('群组消息');
  await composer.fill('展开旧消息时保留这段草稿');
  const anchorTop = () => page.locator('#group-message-history-800').evaluate(element => element.getBoundingClientRect().top - element.closest('.message-list')!.getBoundingClientRect().top);
  const before = await anchorTop();
  await page.getByRole('button', { name: '显示更早 200 条', exact: true }).click();
  await expect(page.locator('.group-message')).toHaveCount(400);
  await expect.poll(async () => Math.abs(await anchorTop() - before)).toBeLessThan(3);
  await expect(composer).toHaveValue('展开旧消息时保留这段草稿');

  await page.locator('#group-message-history-999').getByRole('button', { name: /查看原消息/ }).click();
  const preview = page.getByRole('dialog', { name: '来源消息' });
  await expect(preview).toContainText('历史任务 3：');
  await expect(page.locator('.group-message')).toHaveCount(400);
  await preview.getByRole('button', { name: '关闭', exact: true }).click();
  for (const count of [600, 800, 1000]) {
    await page.getByRole('button', { name: '显示更早 200 条', exact: true }).click();
    await expect(page.locator('.group-message')).toHaveCount(count);
  }
  await expect(page.locator('.group-message')).toHaveCount(1000);
  await expect(page.locator('#group-message-history-0')).toContainText('历史任务 0');
  await expect(composer).toHaveValue('展开旧消息时保留这段草稿');
  expect(requests.some(url => url.includes('before='))).toBe(true);
  await page.reload();
  await expect(page.locator('.group-message')).toHaveCount(200);
  await expect(composer).toHaveValue('展开旧消息时保留这段草稿');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.history-range').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/group-history-mobile.png', animations: 'disabled' });
});
