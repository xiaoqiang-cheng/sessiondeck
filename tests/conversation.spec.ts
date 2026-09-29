import { test } from './fixtures';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { AppState, ConversationTranscript, Group, Session } from '../shared/types';

async function mutate<T>(request: APIRequestContext, path: string, body: unknown = {}): Promise<T> {
  const { csrfToken } = await (await request.get('/api/config')).json();
  const response = await request.post(`/api${path}`, {
    data: body, headers: { 'X-SessionDeck-Token': csrfToken, Origin: 'http://127.0.0.1:4337' },
  });
  expect(response.ok(), `${path} must succeed in the local demo fixture`).toBe(true);
  return await response.json() as T;
}

async function createSession(request: APIRequestContext, title: string, groupId?: string) {
  const state = await (await request.get('/api/state')).json() as AppState;
  expect(state.demo).toBe(true);
  return mutate<Session>(request, '/sessions', { backend: 'codex', title, cwd: state.defaultCwd, groupId });
}

async function openConversation(page: Page, session: Session) {
  await page.goto(`/#/contacts?session=${session.id}`);
  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  await expect(page.getByRole('region', { name: '原生对话记录', exact: true })).toBeVisible();
}

test('conversation history is read-only, recovers from failed refresh and switches back to the same native terminal', async ({ page }) => {
  const session = await createSession(page.request, '真实历史界面回归');
  const history: ConversationTranscript = { messages: [
    { id: 'user-1', role: 'user', text: '请检查 workspace 中的登录流程。', createdAt: '2026-09-29T01:01:00Z' },
    { id: 'assistant-1', role: 'assistant', text: '已确认以下代码：\n```ts\nconst text = "<img src=x onerror=alert(1)>";\n```', createdAt: '2026-09-29T01:02:00Z' },
  ], truncated: true };
  let fail = false;
  const mutations: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && /\/(?:start|stop|input)$/.test(request.url())) mutations.push(request.url()); });
  await page.route(`**/api/sessions/${session.id}/conversation`, route => route.fulfill({
    status: fail ? 503 : 200, json: fail ? { error: '原生历史暂时无法读取' } : history,
  }));
  await openConversation(page, session);
  await expect(page.locator('.conversation-text').first()).toHaveText(history.messages[0].text);
  await expect(page.locator('.conversation-text').last()).toHaveText(history.messages[1].text);
  await expect(page.locator('.conversation-pane img')).toHaveCount(0);
  await expect(page.locator('.conversation-pane')).toContainText('完整上下文请在原生终端中查看');
  await expect(page.locator('.conversation-pane textarea')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/conversation-desktop.png' });
  fail = true;
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await expect(page.locator('.conversation-error')).toContainText('原生历史暂时无法读取');
  await expect(page.locator('.conversation-text').first()).toHaveText(history.messages[0].text);
  fail = false;
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await expect(page.locator('.conversation-error')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: '对话记录', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.conversation-text')).toHaveCount(2);
  await page.getByRole('button', { name: '进入原生终端', exact: true }).click();
  await expect(page.getByRole('dialog', { name: `${session.title} 的私聊` })).toBeVisible();
  await expect(page.locator('.terminal-connection')).toHaveText('已连接');
  await expect(page.getByRole('button', { name: '原生终端', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(mutations).toEqual([]);
});

test('conversation refresh follows the bottom but preserves older reading positions and selected text', async ({ page }) => {
  const session = await createSession(page.request, '对话滚动锚点回归');
  const history: ConversationTranscript = { messages: Array.from({ length: 60 }, (_, index) => ({
    id: `message-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const,
    text: `第 ${index + 1} 条原生消息\n用于确认读取旧对话时不会被拉到底部。\nfunction run() { return ${index}; }`,
  })), truncated: false };
  let reads = 0;
  await page.route(`**/api/sessions/${session.id}/conversation`, route => { reads++; return route.fulfill({ json: history }); });
  await openConversation(page, session);
  const scroller = page.getByLabel('会话消息', { exact: true });
  await expect(page.locator('.conversation-message')).toHaveCount(60);
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
  history.messages.push({ id: 'message-60', role: 'assistant', text: '底部追随的新回复' });
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await expect(page.locator('.conversation-message')).toHaveCount(61);
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);

  await scroller.evaluate(element => { element.scrollTop = 300; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await expect(page.getByRole('button', { name: '回到最新消息', exact: true })).toBeVisible();
  const before = await scroller.evaluate(element => element.scrollTop);
  history.messages.push({ id: 'message-61', role: 'assistant', text: '不打断旧消息阅读的新回复' });
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await expect(page.locator('.conversation-message')).toHaveCount(62);
  expect(Math.abs(await scroller.evaluate(element => element.scrollTop) - before)).toBeLessThan(2);

  const selected = await page.locator('.conversation-text').nth(1).evaluate(element => {
    const selection = window.getSelection()!;
    const range = document.createRange(); range.selectNodeContents(element);
    selection.removeAllRanges(); selection.addRange(range); return selection.toString();
  });
  const beforeRead = reads;
  await page.getByRole('button', { name: '刷新记录', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
  await expect.poll(() => reads).toBeGreaterThan(beforeRead);
  await expect(page.getByRole('button', { name: '刷新记录', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected);
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
});

test('late history responses stay with their own session and mobile records do not overflow', async ({ page }) => {
  const first = await createSession(page.request, '延迟对话一');
  const second = await createSession(page.request, '延迟对话二');
  let release!: () => void;
  let received = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/sessions/${first.id}/conversation`, async route => {
    received = true; await pending;
    await route.fulfill({ json: { messages: [{ id: 'old-user', role: 'user', text: '第一个会话的迟到记录' }], truncated: false } });
  });
  await page.route(`**/api/sessions/${second.id}/conversation`, route => route.fulfill({ json: {
    messages: [{ id: 'new-user', role: 'user', text: `第二个会话的记录\n${'very-long-path/'.repeat(30)}` }], truncated: false,
  } }));
  await openConversation(page, first);
  await expect.poll(() => received).toBe(true);
  await page.evaluate(id => { location.hash = `#/contacts?session=${id}`; }, second.id);
  await expect(page.getByRole('dialog', { name: `${second.title} 的私聊` })).toBeVisible();
  await expect(page.locator('.conversation-text')).toContainText('第二个会话的记录');
  const response = page.waitForResponse(`**/api/sessions/${first.id}/conversation`);
  release(); await response;
  await expect(page.locator('.conversation-text')).toContainText('第二个会话的记录');
  await expect(page.getByText('第一个会话的迟到记录', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.conversation-text')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator('.conversation-scroller').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/conversation-mobile.png' });
});

test('stopping during a delayed history read still fetches the final reply after polling stops', async ({ page }) => {
  const session = await createSession(page.request, '停止时刷新对话回归');
  await mutate(page.request, `/sessions/${session.id}/start`);
  let release!: () => void;
  let delayed = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const initial: ConversationTranscript = { messages: [{ id: 'question', role: 'user', text: '请保存最终结果' }], truncated: false };
  let latest = initial;
  await page.route(`**/api/sessions/${session.id}/conversation`, async route => {
    const snapshot = structuredClone(latest);
    if (!delayed) { delayed = true; await pending; }
    await route.fulfill({ json: snapshot });
  });
  await openConversation(page, session);
  await expect.poll(() => delayed).toBe(true);
  await page.getByRole('button', { name: '停止进程', exact: true }).click();
  await expect(page.getByRole('button', { name: /^(?:恢复|启动)原生会话$/ })).toBeVisible();
  latest = { ...initial, messages: [...initial.messages, { id: 'final', role: 'assistant', text: '退出前保存的最终回复' }] };
  release();
  await expect(page.locator('.conversation-text').last()).toHaveText('退出前保存的最终回复');
  await expect(page.locator('.conversation-text')).toHaveCount(2);
  const state = await (await page.request.get('/api/state')).json() as AppState;
  expect(state.sessions.find(item => item.id === session.id)?.running).toBe(false);
});

test('staging a group task overrides the read-only preference and opens the existing native input', async ({ page }) => {
  const group = await mutate<Group>(page.request, '/groups', { title: '对话模式任务投递回归', goal: '任务必须展示到可确认发送的原生输入区' });
  const session = await createSession(page.request, '对话偏好投递成员', group.id);
  const started = await mutate<Session>(page.request, `/sessions/${session.id}/start`);
  const prompt = 'conversation-stage-keeps-native-enter-confirmation';
  await mutate(page.request, `/groups/${group.id}/messages`, { kind: 'task', text: prompt, recipientIds: [session.id] });
  const frames: string[] = [];
  const launches: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/start')) launches.push(request.url()); });
  page.on('websocket', socket => {
    if (!socket.url().includes(`/api/terminal/${session.id}`)) return;
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload)) as { type: string; data?: string };
      if (message.type === 'data' && message.data) frames.push(message.data);
    });
  });
  await page.goto(`/#/groups/${group.id}?session=${session.id}`);
  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  await expect(page.getByRole('region', { name: '原生对话记录', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('sessiondeck.private-view.codex'))).toBe('conversation');
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await page.getByRole('button', { name: '填入会话', exact: true }).click();
  await expect(page.getByRole('dialog', { name: `${session.title} 的私聊` })).toBeVisible();
  await expect(page.getByRole('button', { name: '原生终端', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.terminal-connection')).toHaveText('已连接');
  await expect.poll(() => frames.join('')).toContain(prompt);
  expect(frames.join('')).not.toMatch(/已收到演示输入：[^\r\n]*conversation-stage-keeps-native-enter-confirmation/);

  // A user may browse history again before confirming a staged task. Its
  // explicit delivery entry must still return to native input, without restart.
  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await page.locator('.delivery-state').getByRole('button', { name: '进入', exact: true }).click();
  await expect(page.getByRole('button', { name: '原生终端', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.terminal-connection')).toHaveText('已连接');
  await page.getByLabel('原生会话终端输入').press('Enter');
  await expect.poll(() => frames.join('')).toMatch(/已收到演示输入：[^\r\n]*conversation-stage-keeps-native-enter-confirmation/);
  const state = await (await page.request.get('/api/state')).json() as AppState;
  expect(state.sessions.find(item => item.id === session.id)?.nativeSessionId).toBe(started.nativeSessionId);
  expect(launches).toEqual([]);
});
