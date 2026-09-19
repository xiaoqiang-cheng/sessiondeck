import { test } from './fixtures';
import { expect, type APIRequestContext } from '@playwright/test';
import type { Group } from '../shared/types';

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
  const cwd = await fork.getByLabel('新的工作目录').inputValue();
  await page.route('**/api/sessions/*/fork', route => route.fulfill({ status: 503, json: { error: '原生 Fork 暂时失败，请重试' } }));
  await fork.getByRole('button', { name: '创建 Fork', exact: true }).click();
  await expect(fork.getByRole('alert')).toHaveText('原生 Fork 暂时失败，请重试');
  await expect(fork.getByLabel('联系人名称')).toHaveValue('Fork 失败后重试');
  await expect(fork.getByLabel('新的工作目录')).toHaveValue(cwd);
  await page.unroute('**/api/sessions/*/fork');
  await fork.getByRole('button', { name: '创建 Fork', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Fork 失败后重试 的私聊' })).toBeVisible();
});
