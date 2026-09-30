import { mutationHeaders, test } from './fixtures';
import { expect, type Page } from '@playwright/test';
import type { AppState, Session } from '../shared/types';
import type { CodexChatAnswer, CodexChatPatch, CodexChatSnapshot, CodexChatSubmission } from '../shared/chat';

type Source = EventTarget & { url: string; closed: boolean };
async function emit(page: Page, url: string, type: string, data?: unknown) {
  await page.evaluate(({ url, type, data }) => {
    const sources = (window as unknown as { codexSources: Source[] }).codexSources;
    for (const source of sources.filter(source => source.url === url && !source.closed)) source.dispatchEvent(data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) }));
  }, { url, type, data });
}

async function fixture(page: Page) {
  const seed = await (await page.request.get('/api/state')).json() as AppState;
  expect(seed.demo).toBe(true);
  const headers = await mutationHeaders(page.request);
  const created = await page.request.post('/api/sessions', { data: { backend: 'codex', title: 'Codex 图形界面回归', cwd: seed.defaultCwd }, headers });
  expect(created.ok()).toBe(true);
  const contact = await created.json() as Session;
  const state: AppState = { ...seed, demo: false, sessions: [contact], groups: [], activities: [], revision: (seed.revision ?? 0) + 20,
    backends: seed.backends.map(backend => backend.id === 'codex' ? { ...backend, installed: true, capabilities: { ...backend.capabilities, nativeControl: true, graphicalChat: true } } : backend) };
  const current: { snapshot: CodexChatSnapshot } = { snapshot: { instanceId: 'chat-test-instance', nativeSessionId: null, revision: 1, connected: false, activeTurnId: null, items: [], requests: [], truncated: false } };
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const submissions = new Map<string, CodexChatSubmission>();
  let reads = 0;
  await page.addInitScript(() => {
    const target = window as unknown as { codexSources: Source[] };
    target.codexSources = [];
    class FakeSource extends EventTarget {
      url: string;
      closed = false;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(url: string | URL) {
        super(); this.url = String(url); target.codexSources.push(this);
        this.addEventListener('open', event => this.onopen?.(event));
        this.addEventListener('error', event => this.onerror?.(event));
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      close() { this.closed = true; }
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: FakeSource });
  });
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route(`**/api/sessions/${contact.id}/chat`, route => { reads++; return route.fulfill({ json: current.snapshot }); });
  await page.route(`**/api/sessions/${contact.id}/start`, async route => {
    requests.push({ path: 'start', body: route.request().postDataJSON() });
    Object.assign(contact, { running: true, nativeSessionId: 'exact-native-thread', interactionMode: 'chat' });
    current.snapshot = { ...current.snapshot, connected: true, nativeSessionId: contact.nativeSessionId, revision: current.snapshot.revision + 1 };
    state.revision = (state.revision ?? 0) + 1;
    await emit(page, '/api/events', 'state', state);
    await emit(page, `/api/sessions/${contact.id}/chat/events`, 'state', current.snapshot);
    await route.fulfill({ json: contact });
  });
  await page.route(`**/api/sessions/${contact.id}/chat/messages`, async route => {
    const body = route.request().postDataJSON() as { text: string; requestId: string };
    requests.push({ path: 'messages', body });
    const accepted: CodexChatSubmission = { requestId: body.requestId, status: 'accepted', turnId: 'turn-1' };
    submissions.set(body.requestId, accepted);
    current.snapshot = { ...current.snapshot, revision: current.snapshot.revision + 1, activeTurnId: 'turn-1', items: [
      ...current.snapshot.items, { id: 'user-1', turnId: 'turn-1', type: 'user', text: body.text, status: 'completed' },
      { id: 'answer-1', turnId: 'turn-1', type: 'assistant', text: '正在检查', status: 'inProgress' },
    ] };
    await route.fulfill({ json: accepted });
    await emit(page, `/api/sessions/${contact.id}/chat/events`, 'state', current.snapshot);
  });
  await page.route(`**/api/sessions/${contact.id}/chat/submissions/*`, route => {
    const id = route.request().url().split('/').at(-1)!;
    return route.fulfill(submissions.has(id) ? { json: submissions.get(id) } : { status: 404, json: { error: '本次发送记录不存在' } });
  });
  await page.route(`**/api/sessions/${contact.id}/chat/requests/*`, async route => {
    requests.push({ path: 'answer', body: route.request().postDataJSON() as CodexChatAnswer & Record<string, unknown> });
    current.snapshot = { ...current.snapshot, revision: current.snapshot.revision + 1, requests: [] };
    await route.fulfill({ json: { ok: true } });
    await emit(page, `/api/sessions/${contact.id}/chat/events`, 'state', current.snapshot);
  });
  await page.route(`**/api/sessions/${contact.id}/chat/interrupt`, async route => {
    requests.push({ path: 'interrupt', body: route.request().postDataJSON() });
    current.snapshot = { ...current.snapshot, revision: current.snapshot.revision + 1, activeTurnId: null, requests: [], items: current.snapshot.items.map(item => ({ ...item, status: 'completed' })) };
    await route.fulfill({ json: { ok: true } });
    await emit(page, `/api/sessions/${contact.id}/chat/events`, 'state', current.snapshot);
  });
  return {
    contact, state, current, requests, submissions, reads: () => reads,
    open: async () => { await page.goto(`/#/contacts?session=${contact.id}`); await expect(page.getByRole('region', { name: 'Codex 图形会话' })).toBeVisible(); await expect(page.getByLabel('给 Codex 发送消息')).toBeVisible(); },
    patch: async (values: Partial<CodexChatSnapshot>) => {
      const previous = current.snapshot;
      current.snapshot = { ...previous, ...values, revision: previous.revision + 1 };
      const patch: CodexChatPatch = { ...current.snapshot, baseRevision: previous.revision, items: values.items ?? [], order: current.snapshot.items.map(item => item.id) };
      await emit(page, `/api/sessions/${contact.id}/chat/events`, 'patch', patch);
    },
  };
}

test('Codex GUI sends to the native thread, streams safe Markdown and handles tools, approval, questions and interruption', async ({ page }) => {
  const app = await fixture(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.open();
  await expect(page.getByText('在这里继续你的工作', { exact: true })).toBeVisible();
  expect(app.requests).toEqual([]);
  const input = page.getByLabel('给 Codex 发送消息');
  await input.fill('检查登录流程，并解释修改。');
  await input.press('Enter');
  await expect(page.locator('.codex-user')).toContainText('检查登录流程，并解释修改。');
  await expect(input).toHaveValue('');
  expect(app.requests.filter(item => item.path === 'start')).toEqual([{ path: 'start', body: { mode: 'chat' } }]);
  expect(app.requests.filter(item => item.path === 'messages')).toHaveLength(1);
  const markdown = '# 修复方案\n\n**已确认**登录入口。\n\n- [x] 检查焦点\n- [ ] 添加测试\n\n| 项目 | 状态 |\n| --- | --- |\n| 键盘 | 正常 |\n\n```js\nconst safe = true;\n```\n\n[官方文档](https://developers.openai.com/codex/) [危险链接](javascript:alert(1))\n\n<img src="https://invalid.example/tracker" onerror="alert(1)">';
  await app.patch({ items: [app.current.snapshot.items[0], { id: 'answer-1', turnId: 'turn-1', type: 'assistant', text: markdown, status: 'inProgress' }, { id: 'command-1', type: 'command', title: '检查 git diff', text: 'git diff --stat', output: '2 files changed', status: 'completed' }], requests: [{ id: 'approval-1', kind: 'approval', title: '允许修改登录组件？', details: 'src/login.tsx', options: [{ id: 'opaque-allow', label: '允许这次操作' }, { id: 'opaque-deny', label: '拒绝' }] }] });
  await expect(page.locator('.codex-chat-toolbar')).toContainText('需要你回复');
  await expect(page.locator('.codex-request pre')).toHaveText('src/login.tsx');
  await expect(page.getByRole('heading', { name: '修复方案', exact: true })).toBeVisible();
  await expect(page.locator('.codex-assistant table')).toBeVisible();
  await expect(page.locator('.codex-assistant .hljs-keyword').first()).toHaveText('const');
  await expect(page.locator('.codex-assistant img')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '危险链接' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '官方文档' })).toHaveAttribute('rel', 'noreferrer noopener');
  await page.locator('.codex-tool summary').click();
  await expect(page.locator('.codex-tool-output')).toHaveText('2 files changed');
  await page.getByRole('button', { name: '允许这次操作', exact: true }).click();
  await expect.poll(() => app.requests.filter(item => item.path === 'answer').map(item => item.body)).toEqual([{ decision: 'opaque-allow' }]);
  await app.patch({ requests: [{ id: 'question-1', kind: 'question', title: '选择验证方式', questions: [{ id: 'scope', header: '验证范围', question: '先检查哪一部分？', options: [{ label: '键盘操作', description: '优先覆盖可访问性' }, { label: '页面布局', description: '检查移动设备' }] }] }] });
  await page.getByRole('radio', { name: /键盘操作/ }).check();
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect.poll(() => app.requests.filter(item => item.path === 'answer').at(-1)?.body).toEqual({ answers: { scope: ['键盘操作'] } });
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(page.getByRole('button', { name: /^(?:停止生成|正在停止…)$/ })).toHaveCount(0);
  expect(app.requests.filter(item => item.path === 'interrupt')).toHaveLength(1);
  expect(app.contact.running).toBe(true);
  await page.screenshot({ path: 'artifacts/codex-graphical-chat.png', animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('uncertain submissions survive reload, keep edited drafts and are checked without another send', async ({ page }) => {
  const app = await fixture(page);
  let submitted = '';
  await page.route(`**/api/sessions/${app.contact.id}/chat/messages`, async route => {
    const body = route.request().postDataJSON() as { text: string; requestId: string };
    app.requests.push({ path: 'messages', body }); submitted = body.requestId;
    await route.abort('connectionreset');
  });
  await app.open();
  await page.getByLabel('给 Codex 发送消息').fill('这条消息只提交一次');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('发送结果待确认', { exact: true })).toBeVisible();
  expect(submitted).toMatch(/^[a-f0-9-]{36}$/);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await page.getByLabel('给 Codex 发送消息').fill('保留正在编辑的下一条草稿');
  await page.reload();
  await expect(page.getByLabel('给 Codex 发送消息')).toHaveValue('保留正在编辑的下一条草稿');
  await expect(page.getByText('发送结果待确认', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查询发送结果', exact: true }).click();
  await expect(page.locator('.codex-pending')).toContainText('服务可能已重启');
  await expect(page.getByRole('button', { name: '已核对未发送，恢复草稿', exact: true })).toBeVisible();
  app.submissions.set(submitted, { requestId: submitted, status: 'accepted', turnId: 'native-existing-turn' });
  await page.getByRole('button', { name: '查询发送结果', exact: true }).click();
  await expect(page.getByText('发送结果待确认', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('给 Codex 发送消息')).toHaveValue('保留正在编辑的下一条草稿');
  expect(app.requests.filter(item => item.path === 'messages')).toHaveLength(1);
  expect(app.requests.filter(item => item.path === 'start')).toHaveLength(1);
});

test('Codex drafts keep IME Enter and newlines, while disconnects disable sending', async ({ page }) => {
  const app = await fixture(page);
  await app.open();
  const input = page.getByLabel('给 Codex 发送消息');
  await input.fill('中文输入候选');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
  expect(app.requests).toEqual([]);
  await input.press('End'); await input.press('Shift+Enter'); await input.pressSequentially('second line');
  await expect(input).toHaveValue('中文输入候选\nsecond line');
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await page.getByRole('button', { name: `进入 ${app.contact.title} 的会话`, exact: true }).click();
  await expect(input).toHaveValue('中文输入候选\nsecond line');
  await emit(page, `/api/sessions/${app.contact.id}/chat/events`, 'error');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await expect(page.locator('.codex-chat-banner')).toContainText('草稿已保留');
  expect(app.requests).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(input).toBeVisible();
  await page.screenshot({ path: 'artifacts/codex-graphical-mobile.png', animations: 'disabled' });
});

test('Codex patch gaps reload history and server replacement may reset revisions without losing reading position', async ({ page }) => {
  const app = await fixture(page);
  app.current.snapshot = { ...app.current.snapshot, revision: 100, items: Array.from({ length: 45 }, (_, index) => ({ id: `message-${index}`, type: 'assistant' as const, text: `第 ${index} 条消息\n\n保留旧对话的阅读位置。\n\n第三段说明。`, status: 'completed' as const })) };
  await app.open();
  await expect(page.locator('.codex-message')).toHaveCount(45);
  const scroller = page.getByLabel('Codex 消息记录', { exact: true });
  await scroller.evaluate(element => { element.scrollTop = 240; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await expect(page.getByRole('button', { name: '回到最新消息', exact: true })).toBeVisible();
  const before = await scroller.evaluate(element => element.scrollTop);
  await app.patch({ items: [...app.current.snapshot.items, { id: 'message-new', type: 'assistant', text: '新的回复不会打断阅读。', status: 'completed' }] });
  await expect(page.locator('.codex-message')).toHaveCount(46);
  expect(Math.abs(await scroller.evaluate(element => element.scrollTop) - before)).toBeLessThan(2);
  const reads = app.reads();
  app.current.snapshot = { ...app.current.snapshot, revision: 105, notice: '已补齐遗漏的事件' };
  await emit(page, `/api/sessions/${app.contact.id}/chat/events`, 'patch', { ...app.current.snapshot, baseRevision: 104, items: [], order: app.current.snapshot.items.map(item => item.id) });
  await expect.poll(() => app.reads()).toBeGreaterThan(reads);
  await expect(page.locator('.codex-chat-notice')).toHaveText('已补齐遗漏的事件');
  app.current.snapshot = { ...app.current.snapshot, instanceId: 'replacement-server', revision: 1, notice: '服务重启后的精确会话', items: [{ id: 'restored', type: 'assistant', text: '已恢复正确的原生历史', status: 'completed' }] };
  await emit(page, `/api/sessions/${app.contact.id}/chat/events`, 'state', app.current.snapshot);
  await expect(page.locator('.codex-assistant')).toContainText('已恢复正确的原生历史');
  await expect(page.locator('.codex-message')).toHaveCount(1);
  expect(app.requests).toEqual([]);
});

test('LAN browsers without randomUUID can send, and explicit native rejections preserve editable drafts', async ({ page }) => {
  const app = await fixture(page);
  await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined }));
  const ids: string[] = [];
  await page.route(`**/api/sessions/${app.contact.id}/chat/messages`, async route => {
    const body = route.request().postDataJSON() as { text: string; requestId: string };
    ids.push(body.requestId);
    await route.fulfill(ids.length === 1 ? { status: 409, json: { error: '请先处理当前原生审批', code: 'CHAT_REJECTED' } } : { json: { requestId: body.requestId, status: 'accepted', turnId: 'accepted-after-correction' } });
  });
  await app.open();
  await page.getByLabel('给 Codex 发送消息').fill('保留被拒绝的任务草稿');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.codex-chat-error')).toContainText('请先处理当前原生审批');
  await expect(page.getByLabel('给 Codex 发送消息')).toHaveValue('保留被拒绝的任务草稿');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  await expect(page.getByText('发送结果待确认', { exact: true })).toHaveCount(0);
  await page.getByLabel('给 Codex 发送消息').fill('修改后由用户重新提交');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByLabel('给 Codex 发送消息')).toHaveValue('');
  expect(ids).toHaveLength(2);
  for (const id of ids) expect(id).toMatch(/^[a-f0-9]{32}$/);
  expect(ids[0]).not.toBe(ids[1]);
});

test('a late accepted response after reopening clears only its submitted draft snapshot', async ({ page }) => {
  const app = await fixture(page);
  let release!: () => void;
  let submitted = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/sessions/${app.contact.id}/chat/messages`, async route => {
    const body = route.request().postDataJSON() as { text: string; requestId: string };
    submitted = true; app.requests.push({ path: 'messages', body });
    await pending;
    await route.fulfill({ json: { requestId: body.requestId, status: 'accepted', turnId: 'late-accepted' } });
  });
  await app.open();
  await page.getByLabel('给 Codex 发送消息').fill('已经提交的原始任务');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => submitted).toBe(true);
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await page.getByRole('button', { name: `进入 ${app.contact.title} 的会话`, exact: true }).click();
  await expect(page.getByText('发送结果待确认', { exact: true })).toBeVisible();
  await page.getByLabel('给 Codex 发送消息').fill('重新打开后写下的新草稿');
  release();
  await expect(page.getByText('发送结果待确认', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('给 Codex 发送消息')).toHaveValue('重新打开后写下的新草稿');
  await page.reload();
  await expect(page.getByLabel('给 Codex 发送消息')).toHaveValue('重新打开后写下的新草稿');
  expect(app.requests.filter(item => item.path === 'messages')).toHaveLength(1);
});

test('sending from an existing terminal session selects native chat delivery without starting on view', async ({ page }) => {
  const app = await fixture(page);
  Object.assign(app.contact, { running: true, nativeSessionId: 'exact-native-thread', interactionMode: 'terminal' });
  app.current.snapshot = { ...app.current.snapshot, nativeSessionId: app.contact.nativeSessionId, connected: true };
  await app.open();
  expect(app.requests).toEqual([]);
  await page.getByLabel('给 Codex 发送消息').fill('在这个已有的原生会话中继续');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.codex-user')).toContainText('在这个已有的原生会话中继续');
  expect(app.requests.map(item => item.path)).toEqual(['start', 'messages']);
  expect(app.requests[0].body).toEqual({ mode: 'chat' });
  expect(app.contact.nativeSessionId).toBe('exact-native-thread');
  expect(app.contact.interactionMode).toBe('chat');
});
