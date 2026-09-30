import { mutationHeaders, test } from './fixtures';
import { expect } from '@playwright/test';
import type { AppState } from '../shared/types';

const remoteOrigin = (baseURL: string) => { const url = new URL(baseURL); url.port = String(Number(url.port) + 1); return url.origin; };

test('remote owner logs in, shares a session read-only, and revocation closes the colleague view', async ({ page, browser, baseURL, request }) => {
  const remote = remoteOrigin(baseURL!);
  const state = await (await request.get('/api/state')).json() as AppState;
  const target = state.sessions.find(item => item.title === 'SessionDeck · 开发笔记')!;

  // Set the owner password on the owner's own machine.
  await page.goto('/#/backends');
  const security = page.getByRole('region', { name: '远程访问与安全' });
  const password = 'browser owner password';
  await expect(security).toBeVisible();
  if (await security.getByRole('button', { name: '设置密码', exact: true }).count()) {
    await security.getByLabel('新密码').fill(password);
    await security.getByLabel('确认密码').fill(password);
    await security.getByRole('button', { name: '设置密码', exact: true }).click();
    await expect(security.getByRole('button', { name: '更换密码', exact: true })).toBeVisible();
  }

  // The remote address needs that password; nothing leaks before login.
  const ownerRemote = await browser.newContext();
  const remotePage = await ownerRemote.newPage();
  expect((await remotePage.request.get(`${remote}/api/state`)).status()).toBe(401);
  await remotePage.goto(`${remote}/`);
  await remotePage.getByLabel('所有者密码').fill('not the password');
  await remotePage.getByRole('button', { name: '登录', exact: true }).click();
  await expect(remotePage.getByRole('alert')).toContainText('密码不正确');
  await remotePage.getByLabel('所有者密码').fill(password);
  await remotePage.getByRole('button', { name: '登录', exact: true }).click();
  await expect(remotePage.getByRole('heading', { name: '会话联系人', exact: true })).toBeVisible();
  await remotePage.goto(`${remote}/#/backends`);
  await expect(remotePage.getByRole('region', { name: '远程访问与安全' })).toContainText('只能在运行 SessionDeck 的电脑上修改');

  // Share from the card menu on the local workbench.
  await page.goto('/');
  await page.getByRole('button', { name: `${target.title} 的更多操作`, exact: true }).click();
  await page.getByRole('button', { name: '分享会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分享会话' });
  await dialog.getByRole('button', { name: '只读', exact: true }).click();
  await dialog.getByRole('button', { name: '生成并复制链接', exact: true }).click();
  const link = await dialog.locator('.share-created code').textContent();
  expect(link).toMatch(new RegExp(`^${remote}/#/share/[\\w-]+$`));

  const colleagueContext = await browser.newContext();
  const colleague = await colleagueContext.newPage();
  await colleague.goto(link!);
  await colleague.getByLabel('你的名字').fill('测试同事');
  await colleague.getByRole('button', { name: '进入会话', exact: true }).click();
  await expect(colleague.getByRole('heading', { name: target.title, exact: true })).toBeVisible();
  await expect(colleague.locator('.share-role')).toHaveText('只读 · 测试同事');
  await expect(colleague).toHaveURL(`${remote}/#/`);
  await expect(colleague.getByRole('button', { name: /启动|恢复|停止/ })).toHaveCount(0);
  await expect(colleague.getByRole('navigation', { name: '工作空间导航' })).toHaveCount(0);
  await expect(colleague.locator('.terminal-readonly')).toHaveText('只读查看');
  await colleague.getByRole('button', { name: '打开资源管理器', exact: true }).click();
  await expect(colleague.getByRole('complementary', { name: '资源管理器' })).toBeVisible();
  const scoped = await (await colleague.request.get(`${remote}/api/state`)).json() as AppState;
  expect(scoped.sessions.map(item => item.id)).toEqual([target.id]);
  await colleague.screenshot({ path: 'artifacts/share-readonly.png' });
  await colleague.reload();
  await expect(colleague.getByRole('heading', { name: target.title, exact: true })).toBeVisible();

  // The owner sees who opened the link, then revokes it.
  await expect(dialog.locator('.share-list')).toContainText('测试同事', { timeout: 1000 }).catch(async () => {
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('button', { name: `${target.title} 的更多操作`, exact: true }).click();
    await page.getByRole('button', { name: '分享会话', exact: true }).click();
  });
  const reopened = page.getByRole('dialog', { name: '分享会话' });
  await expect(reopened.locator('.share-list')).toContainText('测试同事');
  await reopened.getByRole('button', { name: '撤销', exact: true }).first().click();
  await expect(colleague.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  expect((await colleague.request.get(`${remote}/api/state`)).status()).toBe(401);

  // Clean up: revoke any remaining shares for this session.
  const headers = await mutationHeaders(request);
  for (const share of await (await request.get(`/api/sessions/${target.id}/shares`)).json() as { id: string }[]) await request.delete(`/api/shares/${share.id}`, { headers, data: {} });
  await ownerRemote.close(); await colleagueContext.close();
});
